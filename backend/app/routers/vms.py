"""Virtual machine lifecycle endpoints."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import bulk, defaults, guest_created, ownership, quota, security, store, vmconfig
from ..formatters import (
    decode_agent_output,
    normalize_agent_interfaces,
    parse_df_output,
    pve_flag,
)
from ..vm_scope import bind_vm_connection
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    explain_clone_error,
    get_client,
    node_from_upid,
    parallel,
    requested_connection,
)
# 复用告警模块里「Guest Agent → 静态配置」的 IP 解析逻辑
from ..alerting import _pick_ip, _static_ip_from_config
from ..schemas import (
    BulkRequest,
    CloneRequest,
    IpConfigRequest,
    MigrateRequest,
    MoveDiskRequest,
    PowerRequest,
    ResizeRequest,
    SnapshotCreate,
    VmAddDisk,
    VmAddNetwork,
    VmConfigUpdate,
    VmCreateRequest,
    VmOwnerIn,
)

# 硬件页允许增删的配置键前缀。**刻意用白名单**：删除接口直接删 PVE 配置项，
# 放开成「任意键」的话，一个误传的 key（memory / boot / agent …）就能把机器改坏。
DISK_KEY_PREFIXES = ("scsi", "virtio", "sata")
HARDWARE_KEY_PREFIXES = DISK_KEY_PREFIXES + ("ide", "net")


def _has_digit_suffix(key: str, prefix: str) -> bool:
    return key.startswith(prefix) and key[len(prefix) :].isdigit()


def _is_hardware_key(key: str) -> bool:
    """磁盘 / 网卡 / 光驱这类「带编号的设备键」。"""
    return any(_has_digit_suffix(key, p) for p in HARDWARE_KEY_PREFIXES)


def _is_disk_key(key: str) -> bool:
    return any(_has_digit_suffix(key, p) for p in DISK_KEY_PREFIXES)


def _op_connection() -> str:
    """本次操作作用在哪条连接上（与 get_client() 的解析保持一致）。"""
    return requested_connection() or str(store.get_active_connection_id() or "")


async def require_vm_access(
    user: Dict[str, Any] = Depends(security.get_current_user),
    node: Optional[str] = None,
    vmid: Optional[int] = None,
) -> None:
    """按归属校验单台虚拟机的访问权限；列表接口自行过滤。

    挂在 vms 路由上作为路由级依赖：FastAPI 会把路径里的 ``{node}/{vmid}`` 注入
    进来，因此单台虚拟机的全部操作（详情、电源、改配、删除、快照、克隆…）都被
    统一覆盖；没有这两个路径参数的接口取到 None，直接放行。

    管理员是超管视角，不受限制；普通用户只允许操作自己名下的虚拟机，没有归属
    记录的存量虚拟机同样拒绝（严格隔离）。
    """
    if not node or vmid is None:
        return
    owner = security.visible_owner(user)
    if owner is None:
        return
    ref = ownership.vm_ref(_op_connection(), node, vmid)
    if await ownership.get_owner(ownership.KIND_VM, ref) != owner:
        raise HTTPException(
            status_code=403,
            detail=f"虚拟机 {node}/{vmid} 不属于当前用户，无权访问",
        )


router = APIRouter(
    prefix="/api",
    tags=["vms"],
    # 顺序有意义：先把请求绑定到该虚拟机所在的 PVE 连接，再做归属校验
    # （校验用的 ref 前缀就是连接 id，绑错了普通用户会被误判 403）
    dependencies=[Depends(bind_vm_connection), Depends(require_vm_access)],
)


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


async def _storage_type_map(node: str) -> Dict[str, str]:
    """Map storage name -> PVE type, used to normalise disk formats."""
    client = get_client()
    try:
        storages = await client.storages(node)
    except ProxmoxError:
        return {}
    return {s.get("storage", ""): s.get("type", "") for s in storages if s.get("storage")}


# =============================================================== read paths
async def _resolve_vm_ip(client: Any, vm: Dict[str, Any]) -> str:
    """列表用：尽力解析 IP。运行中先问 Guest Agent（短超时），否则退回静态配置。"""
    node = vm.get("node")
    vmid = vm.get("vmid")
    status = vm.get("status")
    if not node or not vmid:
        return ""
    if status == "running":
        try:
            interfaces = await asyncio.wait_for(
                client.qemu_agent_network(node, int(vmid)), timeout=2.0
            )
            ip = _pick_ip(interfaces or [])
            if ip:
                return ip
        except Exception:  # noqa: BLE001 - agent 未装/无响应都不影响列表
            pass
    try:
        cfg = await asyncio.wait_for(
            client.qemu_config(node, int(vmid)), timeout=2.0
        )
    except Exception:  # noqa: BLE001
        return ""
    return _static_ip_from_config(cfg or {})


async def _resolve_ct_ip(client: Any, ct: Dict[str, Any]) -> str:
    """容器没有 Guest Agent，IP 只能读网卡配置里的静态地址。

    ``ip=dhcp`` 拿不到地址不是错误，返回空串即可 —— 列表里就显示为空。
    """
    node = ct.get("node")
    vmid = ct.get("vmid")
    if not node or vmid is None:
        return ""
    try:
        cfg = await asyncio.wait_for(
            client.lxc_config(node, int(vmid)), timeout=2.0
        )
    except Exception:  # noqa: BLE001
        return ""
    for key in sorted(k for k in (cfg or {}) if str(k).startswith("net")):
        raw = (cfg or {}).get(key)
        if not isinstance(raw, str):
            continue
        for segment in raw.split(","):
            segment = segment.strip()
            if segment.startswith("ip="):
                value = segment[3:].strip()
                if value and value not in ("dhcp", "manual"):
                    return value.split("/")[0]
    return ""


async def _resolve_guest_ip(client: Any, guest: Dict[str, Any]) -> str:
    """按类型分派 IP 解析：虚拟机问 Guest Agent，容器读网卡配置。"""
    if guest.get("type") == "lxc":
        return await _resolve_ct_ip(client, guest)
    return await _resolve_vm_ip(client, guest)


async def collect_vms(
    *,
    user: Dict[str, Any],
    node: Optional[str] = None,
    with_ip: bool = False,
    guest_type: str = "qemu",
) -> List[Dict[str, Any]]:
    """汇总（可跨多条连接）的 guest 清单，并按归属过滤。

    ``/vms`` 列表与 ``/api/export/vms`` 共用这一份实现：导出必须和界面看到的
    是同一批机器 —— 两边各写一份过滤逻辑，迟早会出现「列表里只有 3 台、
    导出里 30 台」这种越权。

    ``with_ip=true`` 会逐台解析主 IP（虚拟机先问 Guest Agent、退回静态
    cloud-init 地址；容器读 ``netN`` 里的静态地址），代价是每台两次 PVE 请求，
    所以默认关闭。
    """
    # 未显式指定 X-PVE-Connection 时，合并所有已保存 PVE 的虚拟机；单台失败
    # 只跳过它自己，不让整个列表报错。
    if requested_connection():
        # 指定了连接也要带上它的 profile：每条机器都会回填 connection_id，
        # 而「按归属过滤」正是靠 connection_id 拼 ref 的 —— 留空会让普通用户在
        # 单连接请求里看不到自己的机器（跨主机的 ref 对不上）。
        cid = requested_connection()
        profile = next(
            (c for c in store.get_connections() if str(c.get("id")) == cid),
            None,
        )
        targets: List[Any] = [(profile, get_client())]
    else:
        targets = list(all_connection_clients()) or [(None, get_client())]

    result: List[Dict[str, Any]] = []
    failure: Optional[ProxmoxError] = None

    for profile, client in targets:
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            failure = failure or exc
            continue

        wanted = ("qemu", "lxc") if guest_type == "all" else (guest_type,)
        vms = [r for r in (resources or []) if r.get("type") in wanted]
        if node:
            vms = [v for v in vms if v.get("node") == node]

        # profile 缺失时退回「本次请求指定的连接 id」，保证 connection_id 与
        # 记录归属时用的 ref 前缀一致
        cid = str(profile.get("id") or "") if profile else str(requested_connection() or "")
        label = connection_label(profile) if profile else ""
        items: List[Dict[str, Any]] = [
            {
                "id": vm.get("id"),
                "node": vm.get("node"),
                "vmid": vm.get("vmid"),
                # 前端靠它决定跳 /vms/:id 还是 /lxc/:id、调哪套接口
                "type": vm.get("type") or "qemu",
                "name": vm.get("name")
                or (f"CT {vm.get('vmid')}" if vm.get("type") == "lxc" else f"VM {vm.get('vmid')}"),
                "status": vm.get("status", "unknown"),
                "template": pve_flag(vm.get("template", 0)) == 1,
                "cpu": vm.get("cpu"),
                "maxcpu": vm.get("maxcpu"),
                "mem": vm.get("mem"),
                "maxmem": vm.get("maxmem"),
                "disk": vm.get("disk"),
                "maxdisk": vm.get("maxdisk"),
                "uptime": vm.get("uptime"),
                # PVE 记录的创建时间（config 的 meta.ctime）。列表接口本身不带
                # 这个值，命中缓存时这里直接填好，否则由下面的 fill() 补；
                # 克隆 / 恢复出来的机器会继承来源机器的时间，见 app/guest_created.py。
                "created": guest_created.cached(
                    cid, vm.get("node"), vm.get("vmid"), vm.get("type") or "qemu"
                ),
                "tags": vm.get("tags") or vm.get("tag") or "",
                "pool": vm.get("pool"),
                "lock": vm.get("lock"),
                "netin": vm.get("netin"),
                "netout": vm.get("netout"),
                "diskread": vm.get("diskread"),
                "diskwrite": vm.get("diskwrite"),
                "connection_id": cid,
                "connection_name": label,
            }
            for vm in vms
        ]

        if with_ip and items:
            # 并发解析，限制并发数避免拖垮 PVE；失败不影响列表返回。
            resolved = await parallel(
                (_resolve_guest_ip(client, vm) for vm in items), limit=12
            )
            for item, ip in zip(items, resolved):
                item["ip"] = ip if isinstance(ip, str) else ""

        # 创建时间：缓存里没有的逐台读一次 config（每台一次请求 + 进程内缓存，
        # 一轮有预算上限），取不到就留空 —— 它不比 IP 重要，不值得拖慢列表。
        if items:
            await guest_created.fill(client, items)

        result.extend(items)

    if not result and failure is not None:
        _raise(failure)

    # 用户隔离：普通用户只保留自己创建的虚拟机。
    # 没有归属记录的存量虚拟机同样不返回（严格隔离），管理员不受限制。
    owner = security.visible_owner(user)
    if owner is not None:
        owners = await ownership.owners_map(ownership.KIND_VM)
        result = [
            v
            for v in result
            if owners.get(
                ownership.vm_ref(
                    str(v.get("connection_id") or ""),
                    str(v.get("node") or ""),
                    v.get("vmid"),
                )
            )
            == owner
        ]

    result.sort(key=lambda v: (v.get("node") or "", v.get("vmid") or 0))
    return result


@router.get("/vms")
async def list_vms(
    node: Optional[str] = None,
    with_ip: bool = Query(False),
    # qemu（默认，保持既有行为）| lxc | all
    # ``all`` 给「虚拟机」列表页用：容器和虚拟机混排展示，靠返回里的
    # ``type`` 字段区分该调哪套接口。存量调用方不带这个参数，不受影响。
    guest_type: str = Query(default="qemu", alias="type", pattern="^(qemu|lxc|all)$"),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    """All VMs (and, with ``type=all``, containers), enriched where cheap.

    过滤与归属隔离都在 :func:`collect_vms` 里，导出接口共用同一份实现。
    """
    return await collect_vms(
        user=user, node=node, with_ip=with_ip, guest_type=guest_type
    )


@router.get("/vms/{node}/{vmid}")
async def get_vm(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, Any]:
    client = get_client()

    try:
        config, status = await asyncio.gather(
            client.qemu_config(node, vmid),
            client.qemu_status(node, vmid),
        )
    except ProxmoxError as exc:
        _raise(exc)

    config = config or {}
    status = status or {}

    # Enrich disk sizes from storage content, which the config alone lacks.
    disks = vmconfig.parse_config_disks(config)
    await _fill_disk_sizes(node, vmid, disks)

    networks = vmconfig.parse_config_networks(config)

    # The guest agent is optional; probe it but never fail the whole request.
    # agent 有两种合法写法：`1` 和 `enabled=1,fstrim_cloned_disks=1`（后者直接
    # int() 会 ValueError，整个详情接口 500），统一走 pve_flag 解析。
    agent_info: Optional[List[Dict[str, Any]]] = None
    agent_error: Optional[str] = None
    agent_enabled = pve_flag(config.get("agent", 0)) == 1
    if agent_enabled and status.get("status") == "running":
        try:
            agent_info = await asyncio.wait_for(
                client.qemu_agent_network(node, vmid), timeout=6.0
            )
        except (ProxmoxError, asyncio.TimeoutError) as exc:
            agent_error = getattr(exc, "message", None) or "guest agent 无响应"
    agent_interfaces = normalize_agent_interfaces(agent_info)

    return {
        "node": node,
        "vmid": vmid,
        "name": config.get("name") or status.get("name") or f"VM {vmid}",
        "template": pve_flag(config.get("template", 0)) == 1,
        "status": status.get("status", "unknown"),
        "uptime": status.get("uptime"),
        # 创建时间：详情本来就已经把 config 取在手里了，这里是零成本
        "created": await guest_created.resolve(
            _op_connection(), node, vmid, "qemu", config
        ),
        "cpu": status.get("cpu"),
        "cpus": status.get("cpus"),
        "mem": status.get("mem"),
        "maxmem": status.get("maxmem"),
        "disk": status.get("disk"),
        "maxdisk": status.get("maxdisk"),
        "netin": status.get("netin"),
        "netout": status.get("netout"),
        "diskread": status.get("diskread"),
        "diskwrite": status.get("diskwrite"),
        "qmpstatus": status.get("qmpstatus"),
        "lock": status.get("lock"),
        "pid": status.get("pid"),
        "config": config,
        "disks": disks,
        "networks": networks,
        "tags": config.get("tags", ""),
        "description": config.get("description", ""),
        # 前端读的是顶层的 agent_enabled / agent_available / agent_interfaces
        # （见 src/api/types.ts 的 VmDetail）。三者语义不同，别混用：
        #   agent_enabled    —— 配置里开没开（agent: 1 / enabled=1）
        #   agent_available  —— 真的问过 Guest Agent 且它回话了
        #   agent_interfaces —— 客户机内网卡，已拍平成前端的命名
        # 嵌套的 agent 块保留给已有调用方，字段与上面保持一致。
        "agent_enabled": agent_enabled,
        "agent_available": agent_info is not None,
        "agent_interfaces": agent_interfaces,
        "agent": {
            "enabled": agent_enabled,
            "available": agent_info is not None,
            "error": agent_error,
            "interfaces": agent_interfaces,
        },
        "cloudinit": {
            "user": config.get("ciuser"),
            "nameserver": config.get("nameserver"),
            "sshkeys_set": bool(config.get("sshkeys")),
            "ipconfig": {
                k: v for k, v in config.items() if k.startswith("ipconfig")
            },
        },
    }


async def _fill_disk_sizes(node: str, vmid: int, disks: List[Dict[str, Any]]) -> None:
    """Populate ``size`` (e.g. ``32G``) on disks parsed from the config.

    The size lives in the storage content listing, not the VM config, so we
    look it up per storage and match by volume id.
    """
    client = get_client()
    storages = {d.get("storage") for d in disks if d.get("storage")}
    if not storages:
        return

    size_map: Dict[str, str] = {}
    for storage in storages:
        try:
            content = await client.storage_content(node, storage or "", content="images")
        except ProxmoxError:
            continue
        for item in content or []:
            if item.get("vmid") == vmid and item.get("volid"):
                size_map[item["volid"]] = item.get("size")

    for disk in disks:
        raw_size = size_map.get(disk.get("volid", ""))
        if raw_size:
            gb = vmconfig.disk_size_to_gb(_format_bytes_to_size(raw_size))
            disk["size"] = f"{gb:g}G" if gb else ""
            disk["size_bytes"] = raw_size


def _format_bytes_to_size(value: Any) -> str:
    """Convert a byte count into a PVE-style size string (``32G``)."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ""
    for unit, factor in (("T", 1024**4), ("G", 1024**3), ("M", 1024**2), ("K", 1024)):
        if num >= factor:
            return f"{num / factor:.2f}{unit}"
    return f"{num:.0f}"


@router.get("/vms/{node}/{vmid}/pending")
async def get_vm_pending(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.qemu_pending(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/vms/{node}/{vmid}/rrddata")
async def get_vm_rrddata(
    node: str,
    vmid: int,
    timeframe: str = Query(default="hour", pattern="^(hour|day|week|month|year)$"),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.qemu_vm_rrddata(node, vmid, timeframe)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/vms/{node}/{vmid}/agent/network")
async def get_agent_network(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.qemu_agent_network(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)


# ---- 在客户机内执行命令（Guest Agent）----
# 轮询节奏：最多约 12 秒。df 这类命令是毫秒级的，给足冗余只为应对卡住的客户机。
_AGENT_POLL_INTERVAL = 0.25
_AGENT_POLL_ATTEMPTS = 48

# df 可能的安装路径。绝大多数发行版 /bin 已是 /usr/bin 的软链，两条都试一遍最稳。
_DF_PROGRAMS = ("/bin/df", "/usr/bin/df")


async def _agent_run(client: Any, node: str, vmid: int, argv: List[str]) -> str:
    """在客户机内执行命令并取回 stdout。

    这条链路跨了「面板 → PVE → 客户机」三层，所以每一层失败都给明确的中文
    提示，否则用户只会看到一句笼统的错误，不知道该去查哪儿。
    """
    try:
        result = await client.qemu_agent_exec(node, vmid, argv)
    except ProxmoxError as exc:
        raise HTTPException(
            status_code=502,
            detail="Guest Agent 调用失败：" + str(exc.message)
            + "（请确认客户机内已安装并运行 qemu-guest-agent）",
        ) from exc

    pid = (result or {}).get("pid")
    if not pid:
        raise HTTPException(status_code=502, detail="Guest Agent 未返回执行句柄")

    for _ in range(_AGENT_POLL_ATTEMPTS):
        try:
            status = await client.qemu_agent_exec_status(node, vmid, pid)
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=502,
                detail="读取客户机命令输出失败：" + str(exc.message),
            ) from exc

        if status.get("exited"):
            code = int(status.get("exitcode") or 0)
            out = decode_agent_output(status.get("out-data"))
            err = decode_agent_output(status.get("err-data"))
            if code != 0:
                raise HTTPException(
                    status_code=502,
                    detail="客户机内命令执行失败（" + " ".join(argv) + "）："
                    + ((err or out).strip()[-200:] or "退出码 " + str(code)),
                )
            return out
        await asyncio.sleep(_AGENT_POLL_INTERVAL)

    raise HTTPException(status_code=504, detail="客户机内命令执行超时")


@router.post("/vms/{node}/{vmid}/disk-usage")
async def get_vm_disk_usage(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, Any]:
    """读取**客户机内**各文件系统的真实用量。

    为什么非得进客户机里跑 ``df``：

    * PVE 对 QEMU 虚拟机的 ``status.disk`` / rrddata 的 ``disk`` **恒为 0**
      （那是容器的字段），``maxdisk`` 只是磁盘的分配总量，
      所以 ``disk / maxdisk`` 永远算出 0%。
    * Guest Agent 的 ``guest-get-fsinfo`` 本可以给出 ``total-bytes`` /
      ``used-bytes``，但那是较新版本（QEMU GA ≥ 5.2）才有的**可选**字段 ——
      实测这台 CentOS 7 自带 2.12，返回里连字段名都没有。

    所以这是当前唯一能拿到客户机真实磁盘用量的途径。用 POST 而不是 GET：
    它会在客户机里真起一个进程，语义上不是「读一份缓存」。
    注意只支持有 POSIX 工具的客户机（Windows 客户机没有 df，会明确报错）。
    """
    client = get_client()
    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if pve_flag(config.get("agent", 0)) != 1:
        raise HTTPException(
            status_code=400,
            detail="该虚拟机未启用 Guest Agent，无法读取客户机磁盘用量",
        )

    output = ""
    last_error: Optional[HTTPException] = None
    for program in _DF_PROGRAMS:
        try:
            # -P：POSIX 单行格式；-B1：以字节为单位，免得再猜块大小
            output = await _agent_run(client, node, vmid, [program, "-P", "-B1"])
            break
        except HTTPException as exc:
            last_error = exc
    else:
        raise last_error or HTTPException(
            status_code=502, detail="无法在客户机内执行 df"
        )

    filesystems = parse_df_output(output)
    await security.audit(
        request, user, "vm.disk_usage", target=f"{node}/{vmid}",
        detail={"filesystems": len(filesystems)},
    )
    return {
        "filesystems": filesystems,
        # 解析不出内容时把原始输出带回去，方便排查少见的 df 实现
        "raw": "" if filesystems else output.strip()[:500],
    }


# ============================================================== create path
@router.get("/vms/quota")
async def get_vm_quota(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前的下发配额读数（配额 / 已用 / 可下发 / 我还能不能建）。

    任何登录用户都能读：创建向导要靠它在提交前就把「还能建几台」摆在明面上，
    而不是等提交后被 403 打回来。
    """
    return await quota.usage(user, "vm")


@router.post("/vms")
async def create_vm(
    payload: VmCreateRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.create")),
) -> Dict[str, Any]:
    """Create a VM, either blank, from a cloud image, or as a clone."""
    client = get_client()

    # --- 虚拟机额度：可下发为 0（或已用达到上限）时普通用户不能再建 ---
    # 放在最前面，别等做完 DNS / VMID / 存储探测才告诉人家不行。
    await quota.enforce_for_create(user, request, "vm")

    # --- 未单独指定 DNS 时套用面板默认 DNS -------------------------------
    # 模板机多为 DHCP，客户机的 NetworkManager 常被路由器 RA 下发的 DNS 带跑；
    # 局域网是"假 IPv6"时那组 DNS 不可达，虚拟机就会完全解析不了域名。
    # 只在本次确实要用 cloud-init 时注入，避免给不用 cloud-init 的机器写无用键。
    if payload.cloudinit and payload.cloudinit.enabled:
        payload.cloudinit.nameserver = await defaults.effective_dns(
            payload.cloudinit.nameserver
        )

    # --- resolve VMID -------------------------------------------------
    vmid = payload.vmid
    if not vmid:
        try:
            vmid = await client.nextid()
        except ProxmoxError as exc:
            _raise(exc)

    # --- clone path ---------------------------------------------------
    if payload.clone_from:
        return await _create_from_clone(payload, vmid, request, user)

    # --- build config -------------------------------------------------
    storage_types = await _storage_type_map(payload.node)
    import_disk = bool(payload.cloud_image)
    try:
        config = vmconfig.build_vm_config(
            payload, vmid=vmid, storage_types=storage_types, import_disk=import_disk
        )
    except ValueError as exc:
        # 参数本身就不合法（如启动顺序写成旧版的 cdn）：当场说清楚，
        # 别等 PVE 回一句看不懂的格式错误。
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await client.qemu_create(payload.node, config)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.create", target=f"{payload.node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    upid = result if isinstance(result, str) else (result or {}).get("task", "")

    await security.audit(
        request, user, "vm.create", target=f"{payload.node}/{vmid}",
        detail=", ".join(f"{k}={v}" for k, v in config.items()),
    )

    # 创建时间：面板自己记一份。PVE 的 meta.ctime 在建机瞬间可能还没写好（列表
    # 轮询先读到就会显示「没有创建时间」），克隆 / 恢复时又会被继承 —— 见
    # app/guest_created.py。这里记的是准确的建机时刻。
    await guest_created.record(
        _op_connection(),
        payload.node,
        vmid,
        "qemu",
        source="import" if import_disk else "create",
        username=str(user.get("username") or ""),
    )

    # --- post-create steps that must finish before the VM is usable ----
    post_steps: List[str] = []
    if import_disk:
        try:
            await _import_cloud_image(
                client, payload, vmid, upid, post_steps
            )
        except ProxmoxError as exc:
            # The VM exists but is not yet bootable; report clearly.
            raise HTTPException(
                status_code=207,
                detail=(
                    f"虚拟机 {vmid} 已创建，但导入 cloud 镜像失败：{exc.message}。"
                    "请检查镜像路径与存储类型。"
                ),
            ) from exc

    if payload.template_mode:
        try:
            if payload.disks and not import_disk:
                pass  # nothing extra
            tpl_upid = await client.qemu_to_template(payload.node, vmid)
            post_steps.append(str(tpl_upid))
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=207,
                detail=f"虚拟机 {vmid} 已创建，但转换为模板失败：{exc.message}",
            ) from exc

    # 记录归属：普通用户只能看到自己创建的虚拟机
    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(_op_connection(), payload.node, vmid),
        str(user.get("username") or ""),
    )

    return {
        "task": upid,
        "vmid": vmid,
        "node": payload.node,
        "post_steps": post_steps,
        "template": payload.template_mode,
    }


async def _create_from_clone(
    payload: VmCreateRequest,
    vmid: int,
    request: Request,
    user: Dict[str, Any],
) -> Dict[str, Any]:
    """Clone a template, then apply per-instance overrides."""
    client = get_client()
    clone = payload.clone_from
    assert clone is not None

    try:
        result = await client.qemu_clone(
            clone.node,
            clone.vmid,
            newid=vmid,
            name=payload.name,
            full=clone.full,
            target_storage=clone.target_storage,
            target_node=clone.target_node,
        )
    except ProxmoxError as exc:
        exc.message = explain_clone_error(exc.message, clone.full)
        await security.audit(
            request, user, "vm.clone", target=f"{clone.node}/{clone.vmid} -> {vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    upid = result if isinstance(result, str) else (result or {}).get("task", "")
    target_node = clone.target_node or clone.node

    # A full clone can take a while; overrides applied too early are lost.
    if isinstance(upid, str) and upid.startswith("UPID:"):
        try:
            await client.wait_for_task(upid, timeout=600)
        except ProxmoxError:
            # Non-fatal: the clone may still be finishing. Report the task so
            # the UI can keep tracking it.
            pass

    overrides: Dict[str, Any] = {}
    if payload.memory:
        overrides["memory"] = payload.memory
    if payload.cores:
        overrides["cores"] = payload.cores
    if payload.tags:
        overrides["tags"] = payload.tags
    if payload.description:
        overrides["description"] = payload.description
    # NUMA 绑定与 CPU 亲和性是纯配置项，克隆出来的实例落在哪台宿主机上并不确定，
    # 必须能按实例重新指定。efidisk0 / tpmstate0 不在这里下发：它们会在目标存储上
    # 真的开卷，而 Win11 模板本身就该自带这两件套，克隆时已随模板继承。
    overrides.update(vmconfig.build_numa_config(payload))
    if payload.cloudinit and payload.cloudinit.enabled:
        overrides.update(
            vmconfig.build_cloudinit_config(
                payload.cloudinit, network_count=max(len(payload.networks), 1)
            )
        )
    else:
        # 未启用 cloud-init 覆盖时仍写入默认 DNS：模板自带 cloud-init 盘，
        # 只写 nameserver 不会动到模板既有的 IP 配置；不写则克隆机会只剩
        # 路由器 RA 下发的 DNS，局域网"假 IPv6"时直接解析全挂。
        dns = await defaults.effective_dns(None)
        if dns:
            overrides["nameserver"] = dns

    if overrides:
        try:
            await client.qemu_set_config(target_node, vmid, overrides)
        except ProxmoxError as exc:
            await security.audit(
                request, user, "vm.clone", target=f"{target_node}/{vmid}",
                result="partial", detail=f"克隆成功但应用配置失败: {exc.message}",
            )
            raise HTTPException(
                status_code=207,
                detail=f"虚拟机 {vmid} 已克隆，但应用自定义配置失败：{exc.message}",
            ) from exc

    # 克隆完成、覆盖配置已应用后按需自动开机（best-effort，失败不影响克隆结果）。
    started = False
    if clone.start:
        try:
            await client.qemu_power(target_node, vmid, "start")
            started = True
        except ProxmoxError:
            started = False

    await security.audit(
        request, user, "vm.clone",
        target=f"{clone.node}/{clone.vmid} -> {target_node}/{vmid}",
        detail={**overrides, "started": started},
    )

    # 创建时间：**必须记面板这一份** —— PVE 克隆是整体复制模板的 config，
    # meta.ctime 也带过来了（实测克隆出来的机器显示的是模板的时间）。
    await guest_created.record(
        _op_connection(),
        target_node,
        vmid,
        "qemu",
        source="clone",
        username=str(user.get("username") or ""),
    )

    # 记录归属：克隆出来的虚拟机同样归创建者所有
    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(_op_connection(), target_node, vmid),
        str(user.get("username") or ""),
    )

    return {
        "task": upid,
        "vmid": vmid,
        "node": target_node,
        "cloned_from": clone.vmid,
        "started": started,
        "post_steps": [],
        "template": False,
    }


async def _import_cloud_image(
    client: Any,
    payload: VmCreateRequest,
    vmid: int,
    upid: str,
    post_steps: List[str],
) -> None:
    """Import a cloud image as scsi0 and wire up the boot order.

    Order matters: wait for VM creation, import, attach the imported disk,
    then set the boot disk. Skipping the wait causes PVE to reject the import
    because the VM has not finished being created.
    """
    node = payload.node
    if isinstance(upid, str) and upid.startswith("UPID:"):
        await client.wait_for_task(upid, timeout=300)

    # 1. importdisk — PVE names the resulting volume itself
    await client.qemu_importdisk(node, vmid, payload.cloud_image or "", payload.disks[0].storage if payload.disks else "local-lvm")

    # 2. locate the imported volume by listing the target storage
    storage = payload.disks[0].storage if payload.disks else "local-lvm"
    try:
        content = await client.storage_content(node, storage, content="images")
    except ProxmoxError:
        content = []

    volid = ""
    for item in content or []:
        if item.get("vmid") == vmid and item.get("volid"):
            volid = item["volid"]
            break

    if not volid:
        # Fall back to PVE's conventional naming scheme.
        volid = f"{storage}:vm-{vmid}-disk-0"

    attach: Dict[str, Any] = {"scsi0": f"{volid},discard=on"}
    if payload.disks:
        attach["scsihw"] = vmconfig.normalize_scsihw(payload.scsihw)

    result = await client.qemu_set_config(node, vmid, attach)
    if isinstance(result, str):
        post_steps.append(result)

    # 3. boot from the imported disk + cloud-init prerequisites
    # 只写 order=：``c=scsi0`` 这种子键不在 PVE 的 boot 格式里（PVE 9 的格式是
    # [[legacy=]<[acdn]{1,4}>][,order=...]），留着会让 PVE 9 直接拒绝整个请求。
    boot: Dict[str, Any] = {"boot": "order=scsi0"}
    if payload.cloudinit and payload.cloudinit.enabled:
        boot.update(
            {
                "serial0": "socket",
                "vga": "serial0",
                "agent": 1,
                # Cloud-init needs its own drive.
                "ide2": "cloudinit",
            }
        )
    result = await client.qemu_set_config(node, vmid, boot)
    if isinstance(result, str):
        post_steps.append(result)

    # 4. optionally grow the imported disk to the requested size
    if payload.cloudinit and payload.disks and payload.disks[0].size:
        try:
            await client.qemu_resize(node, vmid, "scsi0", f"{payload.disks[0].size}G")
        except ProxmoxError:
            # resizing is best-effort; the disk may already be larger
            pass


# ============================================================== power paths
@router.post("/vms/{node}/{vmid}/status/{action}")
async def vm_power(
    node: str,
    vmid: int,
    action: str,
    request: Request,
    payload: Optional[PowerRequest] = None,
    user: Dict[str, Any] = Depends(security.require_permission("vm.power")),
) -> Dict[str, Any]:
    allowed = {"start", "stop", "shutdown", "reboot", "suspend", "resume"}
    if action not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的操作：{action}。可用操作：{', '.join(sorted(allowed))}",
        )

    payload = payload or PowerRequest()
    client = get_client()

    try:
        result = await client.qemu_power(
            node, vmid, action, timeout=payload.timeout, force_stop=payload.force_stop
        )
    except ProxmoxError as exc:
        # Shutting down an already-stopped VM is a no-op, not an error.
        if exc.status_code == 500 and action in ("stop", "shutdown"):
            detail = exc.message.lower()
            if "not running" in detail or "is not running" in detail:
                return {"task": None, "note": "虚拟机未在运行"}
        await security.audit(
            request, user, f"vm.{action}", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, f"vm.{action}", target=f"{node}/{vmid}"
    )
    return {"task": task}


@router.delete("/vms/{node}/{vmid}")
async def delete_vm(
    node: str,
    vmid: int,
    request: Request,
    purge: bool = True,
    user: Dict[str, Any] = Depends(security.require_permission("vm.delete")),
    # 删除不可逆：先让调用方重输密码（+ 动态码）确认身份
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()

    # Refuse to destroy a running VM — PVE would error anyway, but a clear
    # message is friendlier than the raw failure.
    try:
        status = await client.qemu_status(node, vmid)
        if status.get("status") == "running":
            raise HTTPException(
                status_code=409,
                detail=f"虚拟机 {vmid} 正在运行，请先关机后再删除",
            )
    except ProxmoxError:
        pass  # if the status probe fails, let the delete attempt decide

    try:
        result = await client.qemu_destroy(node, vmid, purge=purge)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.delete", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(request, user, "vm.delete", target=f"{node}/{vmid}")
    # 连同创建时间记录一起删掉：VMID 会被回收，旧记录贴到重建的同号机器上
    # 比「显示 —」更难发现。
    await guest_created.drop_record(_op_connection(), node, vmid, "qemu")
    return {"task": task}


# ======================================================= ownership (admin)
@router.get("/vms/{node}/{vmid}/owner")
async def get_vm_owner(
    node: str,
    vmid: int,
    connection_id: Optional[str] = Query(default=None),
    user: Dict[str, Any] = Depends(security.require_permission("vm.assign")),
) -> Dict[str, Any]:
    """查看某台虚拟机的归属（None 表示无归属，普通用户不可见）。"""
    ref = ownership.vm_ref(connection_id or _op_connection(), node, vmid)
    return {
        "node": node,
        "vmid": vmid,
        "owner": await ownership.get_owner(ownership.KIND_VM, ref),
    }


@router.put("/vms/{node}/{vmid}/owner")
async def set_vm_owner(
    node: str,
    vmid: int,
    payload: VmOwnerIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.assign")),
) -> Dict[str, Any]:
    """把虚拟机指派给某个用户；username 为空表示清除归属。

    用途：存量虚拟机在创建时没有记录归属，严格隔离下普通用户看不到它们，
    管理员可以用这个操作把某台机器交给某个用户。
    """
    username = (payload.username or "").strip()
    if username:
        target = await store.get_user(username)
        if not target:
            raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    ref = ownership.vm_ref(payload.connection_id or _op_connection(), node, vmid)
    if username:
        await ownership.set_owner(ownership.KIND_VM, ref, username)
    else:
        await ownership.delete_owner(ownership.KIND_VM, ref)

    await security.audit(
        request, user, "vm.assign" if username else "vm.unassign",
        target=f"{node}/{vmid}",
        detail={"username": username or None},
    )
    return {"node": node, "vmid": vmid, "owner": username or None}


# =========================================================== config / edits
@router.put("/vms/{node}/{vmid}/config")
async def update_vm_config(
    node: str,
    vmid: int,
    payload: VmConfigUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    # ``extra: allow`` lets the frontend send arbitrary PVE keys (net0, scsi1,
    # cpuunits, ...) without the schema having to enumerate them all.
    data = payload.model_dump(exclude_none=True)

    if not data:
        raise HTTPException(status_code=400, detail="没有需要更新的配置项")

    # 启动顺序同样要归一：界面上可以直接改 config 的 boot，用户照着旧习惯写
    # ``scsi0`` 时，PVE 9 会把它当 legacy 值而拒绝整个更新。
    # 空串是「清掉这一项、回到 PVE 默认」，不能拦，原样放行。
    if data.get("boot"):
        try:
            data["boot"] = vmconfig.normalize_boot_order(str(data["boot"]))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await client.qemu_set_config(node, vmid, data)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.config.update", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.config.update", target=f"{node}/{vmid}", detail=data
    )
    return {"task": task}


@router.post("/vms/{node}/{vmid}/config")
async def set_vm_config_post(
    node: str,
    vmid: int,
    payload: VmConfigUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """Alias for clients that send the raw config as a POST body."""
    return await update_vm_config(node, vmid, payload, request, user)


# ------------------------------------------------------- 硬件增删
async def _set_hardware(
    client: Any,
    request: Request,
    user: Dict[str, Any],
    node: str,
    vmid: int,
    action: str,
    key: str,
    data: Dict[str, Any],
) -> Dict[str, Any]:
    """下发一次硬件配置改动并记审计（新增磁盘 / 网卡共用）。"""
    try:
        result = await client.qemu_set_config(node, vmid, data)
    except ProxmoxError as exc:
        await security.audit(
            request, user, action, target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, action, target=f"{node}/{vmid}", detail=data
    )
    return {"task": task, "key": key, "value": data.get(key)}


@router.post("/vms/{node}/{vmid}/hardware/disk")
async def add_vm_disk(
    node: str,
    vmid: int,
    payload: VmAddDisk,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """给已有虚拟机挂一块新磁盘。

    槽位默认取第一个空闲的 ``scsiN``；按存储类型补 ``format=``，
    与创建虚拟机走同一份拼装逻辑（``vmconfig.format_disk_config``）。
    """
    client = get_client()
    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if payload.interface:
        key = payload.interface
        if not _is_disk_key(key):
            raise HTTPException(status_code=400, detail=f"{key} 不是合法的磁盘键名")
        if key in config:
            raise HTTPException(status_code=409, detail=f"槽位 {key} 已被占用")
    else:
        try:
            key = vmconfig.next_free_key("scsi", config, 31)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    storage_type = (await _storage_type_map(node)).get(payload.storage, "")
    value = vmconfig.format_disk_config(payload, storage_type)
    return await _set_hardware(
        client, request, user, node, vmid, "vm.disk.add", key, {key: value}
    )


@router.post("/vms/{node}/{vmid}/hardware/network")
async def add_vm_network(
    node: str,
    vmid: int,
    payload: VmAddNetwork,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """给已有虚拟机加一张网卡，键名默认取第一个空闲的 ``netN``。"""
    client = get_client()
    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if payload.interface:
        key = payload.interface
        if not _has_digit_suffix(key, "net"):
            raise HTTPException(status_code=400, detail=f"{key} 不是合法的网卡键名")
        if key in config:
            raise HTTPException(status_code=409, detail=f"{key} 已被占用")
    else:
        try:
            key = vmconfig.next_free_key("net", config, 32)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    value = vmconfig.format_network_spec(payload)
    return await _set_hardware(
        client, request, user, node, vmid, "vm.network.add", key, {key: value}
    )


@router.delete("/vms/{node}/{vmid}/hardware/{key}")
async def remove_vm_hardware(
    node: str,
    vmid: int,
    key: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """卸掉一件硬件（磁盘 / 网卡 / 光驱）。

    **只删 PVE 配置项，不动卷数据**：磁盘卷会变成无人引用的孤立卷留在原存储池，
    需要回收就上「存储」页删。没有顺手删数据有两个原因 ——
    一是不可恢复，二是删卷属于 ``storage.manage`` 权限，
    不该被 ``vm.config`` 顺带带过去。

    PVE 用 ``delete=<键名>`` 表示删除配置项（逗号分隔可删多个）。
    """
    if not _is_hardware_key(key):
        raise HTTPException(status_code=400, detail=f"{key} 不是可删除的硬件配置项")

    client = get_client()
    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if key not in config:
        raise HTTPException(status_code=404, detail=f"该虚拟机没有 {key} 这一项")

    try:
        result = await client.qemu_set_config(node, vmid, {"delete": key})
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.hardware.remove", target=f"{node}/{vmid}",
            result="failed", detail=f"{key}: {exc.message}",
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.hardware.remove", target=f"{node}/{vmid}",
        detail={"key": key, "value": config.get(key)},
    )
    return {"task": task, "key": key}


@router.post("/vms/{node}/{vmid}/ipconfig")
async def set_ipconfig(
    node: str,
    vmid: int,
    payload: IpConfigRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """Update cloud-init networking and credentials on an existing VM."""
    client = get_client()
    data = payload.model_dump(exclude_none=True)

    if "sshkeys" in data and data["sshkeys"]:
        data["sshkeys"] = vmconfig._encode_ssh_keys(data["sshkeys"])
        await security.audit(
            request, user, "vm.ipconfig", target=f"{node}/{vmid}",
            detail={**{k: v for k, v in data.items() if k != "sshkeys"}, "sshkeys": "***"},
        )
    else:
        await security.audit(
            request, user, "vm.ipconfig", target=f"{node}/{vmid}", detail=data
        )

    if not data:
        raise HTTPException(status_code=400, detail="没有需要更新的网络配置")

    try:
        result = await client.qemu_set_config(node, vmid, data)
    except ProxmoxError as exc:
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    return {"task": task}


@router.post("/vms/{node}/{vmid}/resize")
async def resize_disk(
    node: str,
    vmid: int,
    payload: ResizeRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.qemu_resize(node, vmid, payload.disk, payload.size)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.disk.resize", target=f"{node}/{vmid}/{payload.disk}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.disk.resize", target=f"{node}/{vmid}/{payload.disk}",
        detail={"size": payload.size},
    )
    return {"task": task}


@router.post("/vms/{node}/{vmid}/move")
async def move_disk(
    node: str,
    vmid: int,
    payload: MoveDiskRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.qemu_move_disk(
            node, vmid, payload.disk, payload.storage, payload.delete_source
        )
    except ProxmoxError as exc:
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.disk.move", target=f"{node}/{vmid}/{payload.disk}",
        detail={"storage": payload.storage},
    )
    return {"task": task}


@router.post("/vms/{node}/{vmid}/migrate")
async def migrate_vm(
    node: str,
    vmid: int,
    payload: MigrateRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.qemu_migrate(
            node, vmid, payload.target_node, payload.online
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.migrate", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.migrate", target=f"{node}/{vmid}",
        detail={"target": payload.target_node, "online": payload.online},
    )
    return {"task": task}


@router.post("/vms/{node}/{vmid}/clone")
async def clone_vm(
    node: str,
    vmid: int,
    payload: CloneRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.clone")),
) -> Dict[str, Any]:
    client = get_client()

    # 克隆同样会实实在在多出一台虚拟机，配额必须跟着算 ——
    # 只在 POST /vms 拦的话，拿一台已有机器反复克隆就能绕过上限。
    await quota.enforce_for_create(user, request, "vm")

    try:
        result = await client.qemu_clone(
            node,
            vmid,
            newid=payload.newid,
            name=payload.name,
            full=payload.full,
            target_storage=payload.target_storage,
            target_node=payload.target_node,
            description=payload.description,
        )
    except ProxmoxError as exc:
        exc.message = explain_clone_error(exc.message, payload.full)
        await security.audit(
            request, user, "vm.clone", target=f"{node}/{vmid} -> {payload.newid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "vm.clone", target=f"{node}/{vmid} -> {payload.newid}",
        detail={"name": payload.name, "full": payload.full},
    )
    return {"task": task, "vmid": payload.newid}


@router.post("/vms/{node}/{vmid}/template")
async def convert_to_template(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("template.manage")),
) -> Dict[str, Any]:
    """Convert a VM into a template. PVE requires the VM to be stopped."""
    client = get_client()

    try:
        status = await client.qemu_status(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)

    if status.get("status") == "running":
        raise HTTPException(
            status_code=409,
            detail="转换为模板前必须先关闭虚拟机",
        )

    try:
        result = await client.qemu_to_template(node, vmid)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "template.convert", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(request, user, "template.convert", target=f"{node}/{vmid}")
    return {"task": task}


# ================================================================ snapshots
async def _require_snapshot_access(
    user: Dict[str, Any], node: str, vmid: int, name: str
) -> None:
    """快照级隔离：普通用户只能操作「自己创建的」或「自己名下机器上（旧版本
    创建、无归属记录）的」快照；既非创建者也非归属机器的拒绝。"""
    scope = security.visible_owner(user)
    if scope is None:
        return
    ref = ownership.snapshot_ref(_op_connection(), node, vmid, name)
    owner = await ownership.get_owner(ownership.KIND_SNAPSHOT, ref)
    if owner is None:
        # 旧版本创建的快照没有归属记录：回落到虚拟机归属判定
        vm_owners = await ownership.owners_map(ownership.KIND_VM)
        owner = ownership.vm_owner_from(vm_owners, node, vmid, _op_connection())
    if owner != scope:
        raise HTTPException(
            status_code=403,
            detail=f"快照 {node}/{vmid}/{name} 不属于当前用户，无权访问",
        )


async def _filter_snapshots(
    user: Dict[str, Any], node: str, vmid: int, snaps: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """给快照列表附加创建者；普通用户保留「自己创建的」+「自己名下机器上
    的存量快照（创建者标记缺失时按虚拟机归属回落）」，``current`` 指针除外。"""
    owners = await ownership.owners_map(ownership.KIND_SNAPSHOT)
    vm_owners = await ownership.owners_map(ownership.KIND_VM)
    scope = security.visible_owner(user)
    vm_owner = ownership.vm_owner_from(vm_owners, node, vmid, _op_connection())
    output: List[Dict[str, Any]] = []
    for snap in snaps or []:
        name = str(snap.get("name") or "")
        # 创建者标记优先；无标记（旧版本创建）时才按虚拟机归属回落
        owner = owners.get(
            ownership.snapshot_ref(_op_connection(), node, vmid, name)
        ) or vm_owner
        if scope is not None and name != "current" and owner != scope:
            continue
        item = dict(snap)
        item["owner"] = owner
        output.append(item)
    return output


@router.get("/vms/{node}/{vmid}/snapshot")
async def list_snapshots(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        snaps = await client.qemu_snapshots(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)
    return await _filter_snapshots(user, node, vmid, snaps)


@router.post("/vms/{node}/{vmid}/snapshot")
async def create_snapshot(
    node: str,
    vmid: int,
    payload: SnapshotCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.qemu_snapshot_create(
            node, vmid, payload.name, payload.description, payload.vmstate
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "snapshot.create", target=f"{node}/{vmid}/{payload.name}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await ownership.set_owner(
        ownership.KIND_SNAPSHOT,
        ownership.snapshot_ref(_op_connection(), node, vmid, payload.name),
        str(user.get("username") or ""),
    )
    await security.audit(
        request, user, "snapshot.create", target=f"{node}/{vmid}/{payload.name}"
    )
    return {"task": task}


@router.post("/vms/{node}/{vmid}/snapshot/{name}/rollback")
async def rollback_snapshot(
    node: str,
    vmid: int,
    name: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    await _require_snapshot_access(user, node, vmid, name)
    client = get_client()
    try:
        result = await client.qemu_snapshot_rollback(node, vmid, name)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "snapshot.rollback", target=f"{node}/{vmid}/{name}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "snapshot.rollback", target=f"{node}/{vmid}/{name}"
    )
    return {"task": task}


@router.delete("/vms/{node}/{vmid}/snapshot/{name}")
async def delete_snapshot(
    node: str,
    vmid: int,
    name: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    await _require_snapshot_access(user, node, vmid, name)
    client = get_client()
    try:
        result = await client.qemu_snapshot_delete(node, vmid, name)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "snapshot.delete", target=f"{node}/{vmid}/{name}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await ownership.delete_owner(
        ownership.KIND_SNAPSHOT,
        ownership.snapshot_ref(_op_connection(), node, vmid, name),
    )
    await security.audit(
        request, user, "snapshot.delete", target=f"{node}/{vmid}/{name}"
    )
    return {"task": task}


# ============================================================== bulk
@router.post("/vms/bulk")
async def bulk_vm_action(
    payload: BulkRequest,
    request: Request,
    # 这里只做「已登录且能看虚拟机」的基线校验；具体动作（电源 / 删除 / 迁移…）
    # 各自的权限在 bulk.run_bulk 里按 action 判定 —— 一个端点承载多种动作，
    # 没法写成单个 require_permission。
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, Any]:
    """对一批虚拟机 / 容器执行同一个操作，逐台回报结果。

    与单机接口不同，这里**不因单台失败而整批报错**：HTTP 200 表示请求合法，
    成败看 ``results[]`` 里每一项的 ``ok``。前端据此渲染
    「成功 N 台，失败 M 台」的逐台清单（与防火墙模板下发同一套回报形状）。
    """
    return await bulk.run_bulk(request, user, payload)


# ============================================================== scan
@router.get("/snapshots")
async def all_snapshots(
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    """Every snapshot across the cluster, for the global snapshot page."""
    client = get_client()
    try:
        resources = await client.cluster_resources("vm")
    except ProxmoxError as exc:
        _raise(exc)

    # 容器同样有快照（只是没有 vmstate），一并汇总进来
    vms = [r for r in (resources or []) if r.get("type") in ("qemu", "lxc")]

    def _snapshots_of(vm: Dict[str, Any]) -> Any:
        node, vmid = vm["node"], vm["vmid"]
        if vm.get("type") == "lxc":
            return client.lxc_snapshots(node, vmid)
        return client.qemu_snapshots(node, vmid)

    coros = [
        _snapshots_of(vm)
        for vm in vms
        if vm.get("node") and vm.get("vmid")
    ]
    results = await parallel(coros, limit=6)

    # 快照级用户隔离：创建者标记优先；无标记（旧版本创建）时按虚拟机归属回落
    scope = security.visible_owner(user)
    snap_owners = await ownership.owners_map(ownership.KIND_SNAPSHOT)
    vm_owners = await ownership.owners_map(ownership.KIND_VM)

    output: List[Dict[str, Any]] = []
    for vm, snaps in zip(vms, results):
        if isinstance(snaps, Exception):
            continue
        vm_node = str(vm.get("node") or "")
        vm_owner = ownership.vm_owner_from(
            vm_owners, vm_node, vm.get("vmid"), _op_connection()
        )
        for snap in snaps or []:
            name = snap.get("name")
            if not name or name == "current":
                continue
            owner = snap_owners.get(
                ownership.snapshot_ref(_op_connection(), vm_node, vm.get("vmid"), name)
            ) or vm_owner
            if scope is not None and owner != scope:
                continue
            output.append(
                {
                    "node": vm.get("node"),
                    "vmid": vm.get("vmid"),
                    "vm_name": vm.get("name") or f"VM {vm.get('vmid')}",
                    # 前端据此跳到虚拟机页还是容器页
                    "vm_type": vm.get("type") or "qemu",
                    "vm_status": vm.get("status"),
                    "name": name,
                    "description": snap.get("description", ""),
                    "snaptime": snap.get("snaptime"),
                    "parent": snap.get("parent"),
                    "vmstate": pve_flag(snap.get("vmstate", 0)) == 1,
                    "owner": owner,
                }
            )

    output.sort(key=lambda s: s.get("snaptime") or 0, reverse=True)
    return output
