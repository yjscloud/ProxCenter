"""Template management: build from cloud images, convert VMs, clone out.

The cloud-image pipeline is the interesting part. Creating a usable template
from an ``.img`` requires several ordered Proxmox operations, and each must
complete before the next begins:

1. ``POST /nodes/{node}/qemu``            create an empty shell VM
2. ``POST .../qemu``（带 import-from=）  the cloud image becomes the system disk
   —— 早先这里写的是 ``POST .../qemu/{vmid}/importdisk``，但该端点在 PVE 9.2
   已被移除（实测 501），现已改为在创建 VM 的配置里直接指定 import-from
3. ``POST .../qemu/{vmid}/config``        attach the volume as scsi0, set boot
4. ``POST .../qemu/{vmid}/resize``        grow the disk to the requested size
5. ``POST .../qemu/{vmid}/config``        attach the cloud-init drive + serial
6. ``POST .../qemu/{vmid}/template``      freeze it as a template

We wait on each returned UPID before proceeding, because issuing step N+1 too
early is the single most common cause of a half-built template.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import defaults, ownership, quota, security, store, vmconfig
from ..formatters import pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    explain_clone_error,
    get_client,
    requested_connection,
    set_request_connection,
)
from ..vm_scope import resolve_vm_connection
from ..schemas import (
    TemplateClone,
    TemplateFromImage,
    TemplateFromVm,
)

router = APIRouter(prefix="/api", tags=["templates"])

#: 能当 cloud-init 镜像用的扩展名。
#:
#: ``.iso`` 是安装盘、``.ova`` 是整包（描述文件加多块盘），都不是「一块磁盘
#: 镜像」，不能直接当模板的系统盘来源。
CLOUD_IMAGE_EXT = (".img", ".qcow2", ".raw")

#: cloud-init 镜像可能落在哪几种存储内容里。
#:
#: 两处都扫不是冗余：PVE 把存储内容按类型隔开，同一批扩展名在两边待遇不同 ——
#:   · ``import`` 目录：PVE 明确接受 ova / qcow2 / raw / vmdk，上传与列举
#:     都正常（「导入虚拟机」用的就是它）；
#:   · ``iso`` 目录：只认 PVE 认定的 ISO 那几种，``.qcow2`` 放进去既传不上去、
#:     也列不出来。
#: 早先这里只扫 iso，于是界面一边提示「未找到 .img / .qcow2 镜像，请先上传」，
#: 一边只认得 .img —— 手里是 .qcow2 的用户两头都撞墙：存储页上传被拒，
#: 这里又永远看不到。现在 import 目录一并扫，.qcow2 / .raw 有了正经落点。
CLOUD_IMAGE_CONTENTS = ("import", "iso")


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


async def _bind_source_connection(user: Dict[str, Any], node: str, vmid: Any) -> None:
    """未显式指定连接时，按源虚拟机/模板所在位置定位主机。

    这类接口的路径里没有 node/vmid，挂不上路由级依赖，只能手工解析。不解析的话
    克隆请求会被发到「当前连接」上：PVE 拿到别的节点名只会回一句
    ``hostname lookup 'xxx' failed``，很难看出其实是选错了主机。
    """
    if requested_connection() or not node or vmid is None:
        return
    conn_id = await resolve_vm_connection(node, vmid, security.visible_owner(user))
    if conn_id:
        set_request_connection(conn_id)


def _op_connection() -> str:
    """本次请求作用的连接 id（记录虚拟机归属时用）。"""
    return requested_connection() or str(store.get_active_connection_id() or "")


async def _await(client: Any, result: Any, timeout: float = 600.0) -> str:
    """Wait for a PVE task to finish; return the UPID.

    A failure here is intentionally surfaced: a broken pipeline step would
    otherwise produce a silently unusable template.
    """
    upid = result if isinstance(result, str) else (result or {}).get("task", "")
    if isinstance(upid, str) and upid.startswith("UPID:"):
        status = await client.wait_for_task(upid, timeout=timeout)
        exit_status = status.get("exitstatus")
        if exit_status and exit_status != "OK":
            raise ProxmoxError(
                f"任务执行失败（{exit_status}），详见任务日志 {upid}",
                status_code=500,
            )
    return upid if isinstance(upid, str) else ""


# ------------------------------------------------------------------ listing
@router.get("/templates")
async def list_templates(
    guest_type: Optional[str] = Query(
        default=None, pattern="^(qemu|lxc)$",
        description="只列某一类模板：qemu（虚拟机）或 lxc（容器）；不传则两类都返回",
    ),
    user: Dict[str, Any] = Depends(security.require_permission("template.view")),
) -> List[Dict[str, Any]]:
    """Cluster-wide templates (VMs and containers), aggregated across every saved PVE host.

    面板支持保存多台 PVE。未显式指定 ``X-PVE-Connection`` 时合并所有连接
    （与 ``/api/vms`` 行为一致），单台 PVE 读取失败只跳过它自己，不让整个
    列表报错；指定了连接就只返回那一台。

    每项都带 ``connection_id`` / ``connection_name``：不同 PVE 上可能有
    相同的节点名与 VMID（例如两边都有 100），前端必须靠它区分归属。
    ``guest_type`` 用来按类型收窄：**虚拟机克隆只该看到虚拟机模板**（容器模板
    克隆出来的是容器，放进虚拟机的克隆源里选了必然失败），模板页则两类都要。
    """
    requested = requested_connection()
    if requested:
        # 指定了连接：只查那一台，但仍要带上它的名称/ID，前端据此区分归属
        profile = next(
            (p for p in store.get_connections() if str(p.get("id") or "") == requested),
            None,
        )
        targets: List[Any] = [(profile, get_client())]
    else:
        targets = list(all_connection_clients()) or [(None, get_client())]

    output: List[Dict[str, Any]] = []
    failure: Optional[ProxmoxError] = None

    for profile, client in targets:
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            failure = failure or exc
            continue

        # profile 缺失时退回本次请求指定的连接 id，与记录归属用的 ref 前缀保持一致
        cid = str(profile.get("id") or "") if profile else str(requested_connection() or "")
        label = connection_label(profile) if profile else ""
        for vm in resources or []:
            # 模板有两种：虚拟机模板（qemu）与容器模板（lxc）。PVE 的
            # /cluster/resources 对两者都给 ``template=1``，但这里原本只放行
            # qemu —— 实测本机 110 / 111 两台容器都是模板，界面上却看不到。
            kind = vm.get("type")
            if kind not in ("qemu", "lxc"):
                continue
            if guest_type and kind != guest_type:
                continue
            if pve_flag(vm.get("template", 0)) != 1:
                continue
            output.append(
                {
                    "node": vm.get("node"),
                    "vmid": vm.get("vmid"),
                    "name": vm.get("name") or f"Template {vm.get('vmid')}",
                    "status": vm.get("status", "stopped"),
                    "template": True,
                    # 前端据此区分克隆 / 删除该走哪套接口（qemu 与 lxc 的参数不同）。
                    # 必须是这台机器自己的类型 kind，不是上面那个查询参数 ——
                    # 写成 guest_type 的话，不传参数时整份列表的类型都会是 None。
                    "guest_type": kind,
                    "maxcpu": vm.get("maxcpu"),
                    "maxmem": vm.get("maxmem"),
                    "maxdisk": vm.get("maxdisk"),
                    "disk": vm.get("disk"),
                    "tags": vm.get("tags") or "",
                    "uptime": vm.get("uptime"),
                    "pool": vm.get("pool"),
                    "connection_id": cid,
                    "connection_name": label,
                }
            )

    if not output and failure is not None:
        _raise(failure)

    output.sort(key=lambda t: (str(t.get("connection_name") or ""), t.get("vmid") or 0))
    return output


@router.get("/templates/vztmpl")
async def list_ct_system_templates(
    user: Dict[str, Any] = Depends(security.require_permission("template.view")),
) -> List[Dict[str, Any]]:
    """所有节点上可用的**容器系统模板**（``vztmpl``），跨连接聚合。

    必须和 ``/templates`` 分清 —— PVE 里「模板」这个词指两种完全不同的东西，
    混在一起就正是模板页「容器模板」显示 0 的原因：

    * ``/templates``        —— **被转成模板的机器**（``pct template`` / ``template=1``）。
      有 VMID、能开机、能克隆，是「一台预配好的机器」。
    * ``/templates/vztmpl`` —— **存储里的系统模板文件**（``*.tar.zst``）。
      没有 VMID，只是一个文件，用来**新建**容器时选操作系统。

    两者在界面上都该叫「容器模板」，但一个用来克隆、一个用来新建。页面此前只统计
    前者，于是「我明明有 2 个容器模板」看到的是 0 —— 那 2 个是文件，不是机器。

    单台连接读失败只跳过它自己（与 ``/templates`` 一致）；单个存储读失败同样跳过，
    因为一个存储上的模板读不到不该让整页空掉。

    **同一个卷只出一条**。共享存储（CephFS / NFS 这类）从每个节点看都是同一份内容，
    逐个节点列出来就是同一个模板重复 N 遍、只有节点名不同（cephfs 上的 centos-9
    因此在界面上出现了 3 次）。节点本地存储则相反：``local`` 上同名的两个文件是
    **两份不同的文件**，必须都保留 —— 所以「卷的标识里要不要带节点」取决于这个
    存储是不是共享的，这也是这里必须读 ``shared`` 字段的原因。
    """
    targets: List[Any] = list(all_connection_clients()) or [(None, get_client())]
    output: List[Dict[str, Any]] = []
    #: 已经列过的卷。键的形状随存储是否共享而变，见下面 shared 那段注释。
    seen: set = set()
    #: 已经成功扫过的共享存储 ``(连接, 存储名)`` —— 别的节点上不必再扫一遍
    scanned_shared: set = set()

    for profile, client in targets:
        # 与 /templates 同一套取值：profile 缺失时退回本次请求指定的连接 id
        cid = str(profile.get("id") or "") if profile else str(requested_connection() or "")
        label = connection_label(profile) if profile else ""
        try:
            nodes = await client.nodes()
        except ProxmoxError:
            continue

        for entry in nodes or []:
            node = str(entry.get("node") or "")
            if not node:
                continue
            try:
                storages = await client.storages(node)
            except ProxmoxError:
                continue

            for storage in storages or []:
                name = str(storage.get("storage") or "")
                # 只扫**内容类型含 vztmpl** 的存储：别的存储上不可能有容器模板，
                # 逐个去问一次纯属浪费（一个节点上通常只有一两个这样的池）
                if not name or "vztmpl" not in str(storage.get("content") or "").split(","):
                    continue
                shared = pve_flag(storage.get("shared", 0)) == 1
                if shared and (cid, name) in scanned_shared:
                    continue
                try:
                    items = await client.storage_content(node, name, content="vztmpl")
                except ProxmoxError:
                    # 读失败不登记「已扫过」：换个节点还有机会读到，
                    # 登记了就会把这池模板整个漏掉
                    continue
                if shared:
                    scanned_shared.add((cid, name))
                for item in items or []:
                    volid = str(item.get("volid") or "")
                    # 共享存储：同一个 volid 从哪个节点看都是同一份，按 volid 去重
                    # 本地存储：volid 相同也只是「同名」，是两份文件，键里带上节点
                    key = (cid, volid) if shared else (cid, node, volid)
                    if key in seen:
                        continue
                    seen.add(key)
                    output.append(
                        {
                            "node": node,
                            "storage": name,
                            "volid": volid,
                            "name": volid.split("/")[-1] if "/" in volid else volid,
                            "size": item.get("size"),
                            "ctime": item.get("ctime"),
                            # 共享存储上的模板在集群任何节点都能用，界面据此
                            # 显示「共享」而不是其中一个节点名（见前端卡片）
                            "shared": shared,
                            "connection_id": cid,
                            "connection_name": label,
                        }
                    )

    output.sort(
        key=lambda i: (str(i.get("connection_name") or ""), str(i.get("name") or ""))
    )
    return output


@router.get("/templates/images")
async def list_cloud_images(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("template.view")),
) -> List[Dict[str, Any]]:
    """Cloud images (.img/.qcow2/.raw) available on a node's storages.

    Scans both the ``import`` and the ``iso`` content of each storage, because
    the same extension is treated differently in each: ``import`` is where
    Proxmox actually accepts disk images, while ``iso`` only lists what
    Proxmox counts as an ISO.
    """
    client = get_client()
    try:
        storages = await client.storages(node)
    except ProxmoxError as exc:
        _raise(exc)

    images: List[Dict[str, Any]] = []
    for storage in storages or []:
        name = storage.get("storage")
        if not name:
            continue
        supported = {
            part.strip() for part in str(storage.get("content") or "").split(",")
        }
        for content in CLOUD_IMAGE_CONTENTS:
            if content not in supported:
                continue
            try:
                items = await client.storage_content(node, name, content=content)
            except ProxmoxError:
                # 单个存储读不到（未挂载 / 权限不足）就跳过它：让整份列表变空
                # 会显示成「未找到镜像」，比直接报错更难查。
                continue
            for item in items or []:
                volid = str(item.get("volid") or "")
                if not volid.lower().endswith(CLOUD_IMAGE_EXT):
                    continue
                images.append(
                    {
                        "volid": volid,
                        "storage": name,
                        "name": volid.rsplit("/", 1)[-1],
                        "size": item.get("size"),
                        "format": item.get("format", ""),
                        # 标出来源目录：import 与 iso 是两回事，出了问题能一眼
                        # 看出该去哪个目录找这个文件。
                        "content": content,
                    }
                )
    return images


# ------------------------------------------------------ pipeline: from image
@router.post("/templates/from-image")
async def build_template_from_image(
    payload: TemplateFromImage,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("template.manage")),
) -> Dict[str, Any]:
    """Build a cloud-init template from a cloud image, step by step."""
    # 建模板也是一台新机器（模板同样计入用量），走同一套额度校验。
    # ``disk_size`` 可能为空 —— 那样磁盘由镜像自身决定，这一项就不查。
    await quota.enforce_create(
        user,
        request,
        "vm",
        spec={
            "cores": payload.cores,
            "memory_mb": payload.memory,
            "disk_gb": payload.disk_size,
        },
    )
    client = get_client()

    # --- reserve a VMID ------------------------------------------------
    vmid = payload.vmid
    if not vmid:
        try:
            vmid = await client.nextid()
        except ProxmoxError as exc:
            _raise(exc)

    steps: List[Dict[str, Any]] = []

    def record(name: str, ok: bool, detail: str = "") -> None:
        steps.append({"step": name, "ok": ok, "detail": detail})

    # --- 1. create the shell VM ---------------------------------------
    # 固件与机型要配套算一遍：OVMF 在 i440fx 上不可用（那样建出来的模板直接引导
    # 失败），而默认机型**不写进配置** —— PVE 8 的 API 认 pc、PVE 9 只认 i440fx，
    # 写死哪个都会在另一个版本上被驳回；模板的值还会被每个克隆体继承下去。
    bios, machine = vmconfig.resolve_firmware(
        payload.bios, payload.machine, needs_efi=payload.bios == "ovmf"
    )
    create_config: Dict[str, Any] = {
        "vmid": vmid,
        "name": payload.name,
        "memory": payload.memory,
        "cores": payload.cores,
        # 模板上的气球最低保留量会被每一个克隆继承：不设（或不填）就等于
        # 「整份内存不回收」，克隆出来的机器也就没有可回收的余量。
        **({"balloon": payload.balloon} if payload.balloon is not None else {}),
        "cpu": vmconfig.normalize_cpu_type(payload.cpu_type),
        "ostype": vmconfig.normalize_ostype(payload.ostype),
        "scsihw": vmconfig.normalize_scsihw(payload.scsihw),
        "bios": bios,
        "net0": f"{vmconfig.normalize_net_model(payload.net_model)},bridge={payload.bridge}",
        "agent": 1,
        # 只挂串口，不改 vga：vga=serial0 会让虚拟机失去图形控制台，VNC（面板的
        # 控制台）里就只剩客户机往 ttyS0 写的内容 —— 镜像 cmdline 没有
        # console=ttyS0 时 GRUB 之后就全黑。保留默认图形控制台才能拿到 tty1 登录提示。
        "serial0": "socket",
        "onboot": 1 if payload.start_on_boot else 0,
        "description": payload.description or "由 ProxCenter 从 cloud 镜像构建的模板",
        "tags": payload.tags,
        # 磁盘由 PVE 在**配置阶段**直接从 cloud 镜像导入（import-from），
        # 不再走「先建壳机 → qm importdisk」—— 那个端点已被 PVE 9.2 移除
        # （实测 501），继续用它这条流水线会在第二步直接失败。
        "scsi0": f"{payload.storage}:0,import-from={payload.image},discard=on",
    }
    # 只在显式要 q35 时才写机型（默认机型由 PVE 自己决定，见上面的说明）
    if machine:
        create_config["machine"] = machine

    try:
        # 创建这一步现在包含「把云镜像搬成系统盘」，几十 GB 的镜像可能跑十几分钟，
        # 等待窗口按 30 分钟给（_await 默认 10 分钟会在中途放弃）
        upid = await _await(
            client,
            await client.qemu_create(payload.node, create_config),
            timeout=1800,
        )
        record("创建虚拟机并导入镜像", True, f"VMID {vmid} ← {payload.image}")
    except ProxmoxError as exc:
        await security.audit(
            request, user, "template.build", target=f"{payload.node}/{vmid}",
            result="failed", detail=f"create: {exc.message}",
        )
        raise HTTPException(
            status_code=exc.status_code if exc.status_code < 600 else 500,
            detail=f"步骤 1/4 创建虚拟机失败：{exc.message}",
        ) from exc

    # --- 2. attach boot order + cloud-init ----------------------------
    # 系统盘已经在创建时由 import-from 建好，这里只补启动顺序与 cloud-init
    attach: Dict[str, Any] = {
        "boot": "order=scsi0",
        # cloud-init 盘要带存储前缀（``<存储>:cloudinit``）：它是一块小 qcow2，
        # 只写 ``cloudinit`` 会被 PVE 判为非法卷 ID 而拒绝。落在系统盘同一个存储上。
        "ide2": f"{payload.storage}:cloudinit",
        "ciuser": payload.ci_user or "ubuntu",
        "ipconfig0": "ip=dhcp",
    }
    if payload.ci_password:
        attach["cipassword"] = payload.ci_password
    if payload.ssh_keys:
        attach["sshkeys"] = vmconfig._encode_ssh_keys(payload.ssh_keys)
    # 未单独填写时套用面板默认 DNS，避免新模板的虚拟机只剩 RA 下发的 DNS
    dns = await defaults.effective_dns(payload.nameserver)
    if dns:
        attach["nameserver"] = dns

    try:
        await _await(client, await client.qemu_set_config(payload.node, vmid, attach))
        record("配置 cloud-init", True, payload.image)
    except ProxmoxError as exc:
        await _cleanup_failed_build(client, payload.node, vmid)
        raise HTTPException(
            status_code=500,
            detail=f"步骤 2/4 配置 cloud-init 失败：{exc.message}。已回滚临时虚拟机。",
        ) from exc

    # --- 3. grow the disk if requested --------------------------------
    if payload.disk_size:
        try:
            await _await(
                client,
                await client.qemu_resize(
                    payload.node, vmid, "scsi0", f"{payload.disk_size}G"
                ),
            )
            record("扩容磁盘", True, f"{payload.disk_size}G")
        except ProxmoxError as exc:
            # Resizing can legitimately fail when the image is already larger;
            # that is not fatal for the template.
            record("扩容磁盘", False, exc.message)

    # --- 4. freeze as a template --------------------------------------
    try:
        await _await(client, await client.qemu_to_template(payload.node, vmid))
        record("转换为模板", True)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "template.build", target=f"{payload.node}/{vmid}",
            result="failed", detail=f"template: {exc.message}",
        )
        raise HTTPException(
            status_code=500,
            detail=f"步骤 4/4 转换为模板失败：{exc.message}（虚拟机 {vmid} 已保留，可手动处理）",
        ) from exc

    await security.audit(
        request, user, "template.build", target=f"{payload.node}/{vmid}",
        detail={"image": payload.image, "name": payload.name},
    )

    return {
        "vmid": vmid,
        "node": payload.node,
        "name": payload.name,
        "success": True,
        "steps": steps,
    }


async def _cleanup_failed_build(client: Any, node: str, vmid: int) -> None:
    """Destroy a half-built VM so a failed build leaves nothing behind."""
    try:
        result = await client.qemu_destroy(node, vmid, purge=True)
        upid = result if isinstance(result, str) else (result or {}).get("task", "")
        if isinstance(upid, str) and upid.startswith("UPID:"):
            await client.wait_for_task(upid, timeout=120)
    except Exception:  # noqa: BLE001 - best effort
        pass


# --------------------------------------------------------- convert existing
@router.post("/templates/from-vm")
async def convert_vm_to_template(
    payload: TemplateFromVm,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("template.manage")),
) -> Dict[str, Any]:
    """Convert an existing VM into a template, optionally shutting it down."""
    await _bind_source_connection(user, payload.node, payload.vmid)
    client = get_client()

    try:
        status = await client.qemu_status(payload.node, payload.vmid)
    except ProxmoxError as exc:
        _raise(exc)

    steps: List[Dict[str, Any]] = []

    if status.get("status") == "running":
        if not payload.shutdown:
            raise HTTPException(
                status_code=409,
                detail="虚拟机正在运行，请先关机或启用自动关机选项",
            )
        try:
            upid = await _await(
                client,
                await client.qemu_power(
                    payload.node, payload.vmid, "shutdown",
                    timeout=payload.shutdown_timeout,
                ),
                timeout=payload.shutdown_timeout + 30,
            )
            steps.append({"step": "关闭虚拟机", "ok": True, "detail": upid})
        except ProxmoxError as exc:
            # Fall back to a hard stop so the conversion can proceed.
            try:
                await _await(
                    client,
                    await client.qemu_power(payload.node, payload.vmid, "stop"),
                )
                steps.append(
                    {"step": "关闭虚拟机", "ok": True, "detail": "优雅关机超时，已强制停止"}
                )
            except ProxmoxError as stop_exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"无法关闭虚拟机：{stop_exc.message}",
                ) from stop_exc

    try:
        upid = await _await(client, await client.qemu_to_template(payload.node, payload.vmid))
        steps.append({"step": "转换为模板", "ok": True, "detail": upid})
    except ProxmoxError as exc:
        await security.audit(
            request, user, "template.convert", target=f"{payload.node}/{payload.vmid}",
            result="failed", detail=exc.message,
        )
        raise HTTPException(status_code=500, detail=f"转换失败：{exc.message}") from exc

    await security.audit(
        request, user, "template.convert", target=f"{payload.node}/{payload.vmid}"
    )

    return {
        "vmid": payload.vmid,
        "node": payload.node,
        "success": True,
        "steps": steps,
        "task": upid,
    }


# ------------------------------------------------------------------ cloning
@router.post("/templates/clone")
async def clone_template(
    payload: TemplateClone,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("template.clone")),
) -> Dict[str, Any]:
    """Deploy a new VM from a template with cloud-init personalisation."""
    await _bind_source_connection(user, payload.source_node, payload.source_vmid)
    # 从模板部署同样是「新增一台虚拟机」，额度必须跟着算。
    # 规格照抄模板，模板本身在读数里（模板计入用量，这里取的是它的分配值）。
    await quota.enforce_create(
        user,
        request,
        "vm",
        spec={"cores": payload.cores, "memory_mb": payload.memory},
        source=(payload.source_node, payload.source_vmid),
    )
    client = get_client()

    newid = payload.newid
    if not newid:
        try:
            newid = await client.nextid()
        except ProxmoxError as exc:
            _raise(exc)

    target_node = payload.target_node or payload.source_node

    try:
        upid = await _await(
            client,
            await client.qemu_clone(
                payload.source_node,
                payload.source_vmid,
                newid=newid,
                name=payload.name,
                full=payload.full,
                target_storage=payload.storage,
                target_node=payload.target_node,
                description=payload.description,
            ),
            timeout=1800,
        )
    except ProxmoxError as exc:
        # VMID 冲突要单独说明（每台 PVE 的 VMID 独立），其余情况才提链接克隆
        exc.message = explain_clone_error(exc.message, payload.full)
        await security.audit(
            request, user, "template.clone",
            target=f"{payload.source_node}/{payload.source_vmid} -> {newid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    # Apply per-instance settings after the clone has settled.
    overrides: Dict[str, Any] = {}
    if payload.memory:
        overrides["memory"] = payload.memory
    if payload.cores:
        overrides["cores"] = payload.cores
    # 内存气球：模板自带的值（或 PVE 默认的「整份内存」）不该绑死克隆体。
    # 只跳过 None —— 0 是有效值（显式关掉气球驱动）。
    if payload.balloon is not None:
        overrides["balloon"] = payload.balloon
    # 机型：模板带的是**默认机型的旧写法**（面板早期写成 pc）时删掉它 —— 模板上的
    # 值会被每一个克隆体继承，而 PVE 8 与 PVE 9 对默认机型的叫法不同（pc /
    # i440fx），留着它新机器就带着一个目标 PVE 不认的机型。模板自带 q35（Win11
    # 模板）时不动。判断与其它克隆入口共用，见 vmconfig.clone_machine_overrides。
    try:
        source_config = await client.qemu_config(target_node, newid) or {}
    except ProxmoxError:
        source_config = {}
    overrides.update(vmconfig.clone_machine_overrides(source_config))
    overrides.update(
        vmconfig.build_cloudinit_for_clone(
            ci_user=payload.ci_user,
            ci_password=payload.ci_password,
            ssh_keys=payload.ssh_keys,
            ip_config=payload.ip_config,
            # 未单独填写时套用面板默认 DNS：模板机走 DHCP，客户机很容易只剩
            # 路由器 RA 下发的 DNS，一旦不可达就彻底解析不了域名。
            nameserver=await defaults.effective_dns(payload.nameserver),
        )
    )

    if overrides:
        try:
            await client.qemu_set_config(target_node, newid, overrides)
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=207,
                detail=(
                    f"虚拟机 {newid} 已从模板克隆，但应用 cloud-init 配置失败：{exc.message}"
                ),
            ) from exc

    start_task = ""
    if payload.start:
        try:
            result = await client.qemu_power(target_node, newid, "start")
            start_task = result if isinstance(result, str) else (result or {}).get("task", "")
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=207,
                detail=f"虚拟机 {newid} 已创建，但开机失败：{exc.message}",
            ) from exc

    await security.audit(
        request, user, "template.clone",
        target=f"{payload.source_node}/{payload.source_vmid} -> {target_node}/{newid}",
        detail={"name": payload.name},
    )

    # 记录归属：虚拟机列表对普通用户按归属过滤，漏记会让「自己刚建好的机器」
    # 在列表里查无此机。
    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(_op_connection(), target_node, newid),
        str(user.get("username") or ""),
    )

    return {
        "vmid": newid,
        "node": target_node,
        "task": upid,
        "start_task": start_task,
        "name": payload.name,
        "success": True,
    }
