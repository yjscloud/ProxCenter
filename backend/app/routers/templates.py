"""Template management: build from cloud images, convert VMs, clone out.

The cloud-image pipeline is the interesting part. Creating a usable template
from an ``.img`` requires several ordered Proxmox operations, and each must
complete before the next begins:

1. ``POST /nodes/{node}/qemu``            create an empty shell VM
2. ``POST .../qemu/{vmid}/importdisk``    import the cloud image as a volume
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

from .. import defaults, ownership, security, store, vmconfig
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


@router.get("/templates/images")
async def list_cloud_images(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("template.view")),
) -> List[Dict[str, Any]]:
    """Cloud images (.img/.qcow2) available on a node's storages.

    Proxmox stores cloud images under the ``iso`` content type, so we scan
    that and filter by extension.
    """
    client = get_client()
    try:
        storages = await client.storages(node)
    except ProxmoxError as exc:
        _raise(exc)

    images: List[Dict[str, Any]] = []
    for storage in storages or []:
        name = storage.get("storage")
        contents = (storage.get("content") or "").split(",")
        if not name or "iso" not in contents:
            continue
        try:
            items = await client.storage_content(node, name, content="iso")
        except ProxmoxError:
            continue
        for item in items or []:
            volid = item.get("volid", "")
            lowered = volid.lower()
            if not lowered.endswith((".img", ".qcow2", ".raw")):
                continue
            images.append(
                {
                    "volid": volid,
                    "storage": name,
                    "name": volid.rsplit("/", 1)[-1],
                    "size": item.get("size"),
                    "format": item.get("format", ""),
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
    create_config: Dict[str, Any] = {
        "vmid": vmid,
        "name": payload.name,
        "memory": payload.memory,
        "cores": payload.cores,
        "cpu": vmconfig.normalize_cpu_type(payload.cpu_type),
        "ostype": vmconfig.normalize_ostype(payload.ostype),
        "scsihw": vmconfig.normalize_scsihw(payload.scsihw),
        "bios": payload.bios if payload.bios in ("seabios", "ovmf") else "seabios",
        "machine": payload.machine or "pc",
        "net0": f"{vmconfig.normalize_net_model(payload.net_model)},bridge={payload.bridge}",
        "agent": 1,
        "serial0": "socket",
        "vga": "serial0",
        "onboot": 1 if payload.start_on_boot else 0,
        "description": payload.description or "由 ProxCenter 从 cloud 镜像构建的模板",
        "tags": payload.tags,
        # The disk arrives via importdisk; no scsi0 yet.
    }

    try:
        upid = await _await(client, await client.qemu_create(payload.node, create_config))
        record("创建虚拟机", True, f"VMID {vmid}")
    except ProxmoxError as exc:
        await security.audit(
            request, user, "template.build", target=f"{payload.node}/{vmid}",
            result="failed", detail=f"create: {exc.message}",
        )
        raise HTTPException(
            status_code=exc.status_code if exc.status_code < 600 else 500,
            detail=f"步骤 1/5 创建虚拟机失败：{exc.message}",
        ) from exc

    # --- 2. import the cloud image ------------------------------------
    try:
        upid = await _await(
            client,
            await client.qemu_importdisk(payload.node, vmid, payload.image, payload.storage),
            timeout=900,
        )
        record("导入镜像", True, payload.image)
    except ProxmoxError as exc:
        await _cleanup_failed_build(client, payload.node, vmid)
        await security.audit(
            request, user, "template.build", target=f"{payload.node}/{vmid}",
            result="failed", detail=f"importdisk: {exc.message}",
        )
        raise HTTPException(
            status_code=500,
            detail=(
                f"步骤 2/5 导入镜像失败：{exc.message}。"
                "请确认镜像存放在该节点的 ISO 存储中，且存储类型支持导入（dir/NFS/CIFS）。"
                "已回滚并删除临时虚拟机。"
            ),
        ) from exc

    # --- 3. locate the imported volume --------------------------------
    volid = await _find_imported_volume(client, payload.node, payload.storage, vmid)
    if not volid:
        await _cleanup_failed_build(client, payload.node, vmid)
        raise HTTPException(
            status_code=500,
            detail="步骤 3/5 失败：未能定位导入后的磁盘卷，已回滚临时虚拟机。",
        )

    # --- 4. attach the disk, boot order, cloud-init drive -------------
    attach: Dict[str, Any] = {
        "scsi0": f"{volid},discard=on",
        "boot": "order=scsi0",
        "ide2": "cloudinit",
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
        record("配置磁盘与 cloud-init", True, volid)
    except ProxmoxError as exc:
        await _cleanup_failed_build(client, payload.node, vmid)
        raise HTTPException(
            status_code=500,
            detail=f"步骤 4/5 配置磁盘失败：{exc.message}。已回滚临时虚拟机。",
        ) from exc

    # --- 5. grow the disk if requested --------------------------------
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

    # --- 6. freeze as a template --------------------------------------
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
            detail=f"步骤 6/6 转换为模板失败：{exc.message}（虚拟机 {vmid} 已保留，可手动处理）",
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


async def _find_imported_volume(
    client: Any, node: str, storage: str, vmid: int
) -> str:
    """Find the volume importdisk created for this VM.

    PVE names it itself (``vm-{vmid}-disk-N``) so we look it up rather than
    guessing, with a conventional fallback.
    """
    try:
        content = await client.storage_content(node, storage, content="images")
    except ProxmoxError:
        content = []

    for item in content or []:
        if item.get("vmid") == vmid and item.get("volid"):
            return str(item["volid"])

    return f"{storage}:vm-{vmid}-disk-0"


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
