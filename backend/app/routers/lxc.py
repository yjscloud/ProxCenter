"""LXC container lifecycle endpoints.

与 :mod:`app.routers.vms` 平行的一套接口，覆盖容器的全生命周期。

为什么不直接复用 ``/api/vms/{node}/{vmid}``：

* 两者的配置键几乎不重叠（rootfs / mpN / netN 的语义都不一样），
  塞进一套「按类型分支」的读写逻辑会让每个接口都背上两个分支；
* 电源、快照、迁移、控制台这些**同名操作在 PVE 上是不同的端点**
  （``/nodes/{n}/lxc/{id}/...`` 而不是 ``/qemu/...``）。

但**归属**与**权限**是共用的：容器同样用 ``ownership.KIND_VM`` 记归属、用
``vm.*`` 权限校验，这样「用户管理 → 指派归属」「审计日志」「配额」三处
不需要为容器单独开一条路子。
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import (
    defaults,
    guest_created,
    guestip,
    guestnotify,
    guestpasswd,
    ownership,
    quota,
    security,
    store,
    vmconfig,
)
from ..formatters import pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    parallel,
    requested_connection,
)
from ..schemas import (
    GuestPasswordRequest,
    LxcAddMount,
    LxcAddNetwork,
    LxcCloneRequest,
    LxcConfigUpdate,
    LxcCreateRequest,
    LxcMigrateRequest,
    LxcMoveRequest,
    LxcResizeRequest,
    PowerRequest,
    SnapshotCreate,
)
from ..vm_scope import bind_vm_connection
from .vms import (
    _filter_snapshots,
    _op_connection,
    _raise,
    _require_snapshot_access,
    require_vm_access,
)

# 容器允许增删的硬件键：网卡（netN）与挂载点（mpN）。
# 同样是**白名单** —— 删除接口直接改 PVE 配置项，放开会让一个误传的
# key（memory / rootfs / unprivileged …）把容器改坏。
CT_HARDWARE_KEY_PREFIXES = ("net", "mp")


def _has_digit_suffix(key: str, prefix: str) -> bool:
    return key.startswith(prefix) and key[len(prefix):].isdigit()


def _is_ct_hardware_key(key: str) -> bool:
    return any(_has_digit_suffix(key, p) for p in CT_HARDWARE_KEY_PREFIXES)


router = APIRouter(
    prefix="/api",
    tags=["lxc"],
    # 与 vms 同一顺序：先绑定连接，再做归属校验
    dependencies=[Depends(bind_vm_connection), Depends(require_vm_access)],
)


# =============================================================== read paths
async def _resolve_ct_ip(client: Any, ct: Dict[str, Any]) -> str:
    """容器 IP：配置里的静态地址优先，DHCP 的去问运行中的容器。

    实现在 :mod:`app.guestip`（容器与虚拟机的列表共用一份；DHCP 容器要读
    ``/lxc/{vmid}/interfaces`` 才拿得到地址，那部分以前只在虚拟机侧有）。
    """
    return await guestip.resolve(client, ct)


@router.get("/lxc")
async def list_containers(
    node: Optional[str] = None,
    with_ip: bool = Query(False),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    """所有容器。与 ``GET /vms`` 的口径保持一致（多连接聚合 + 归属过滤）。"""
    if requested_connection():
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

        containers = [r for r in (resources or []) if r.get("type") == "lxc"]
        if node:
            containers = [c for c in containers if c.get("node") == node]

        cid = str(profile.get("id") or "") if profile else str(requested_connection() or "")
        label = connection_label(profile) if profile else ""
        items: List[Dict[str, Any]] = [
            {
                "id": ct.get("id"),
                "node": ct.get("node"),
                "vmid": ct.get("vmid"),
                "name": ct.get("name") or f"CT {ct.get('vmid')}",
                "status": ct.get("status", "unknown"),
                "template": pve_flag(ct.get("template", 0)) == 1,
                "cpu": ct.get("cpu"),
                "maxcpu": ct.get("maxcpu"),
                "mem": ct.get("mem"),
                "maxmem": ct.get("maxmem"),
                "disk": ct.get("disk"),
                "maxdisk": ct.get("maxdisk"),
                "uptime": ct.get("uptime"),
                # PVE 记录的创建时间（config 的 meta.ctime）；同 /vms，见
                # app/guest_created.py 里关于「克隆继承」的说明。
                "created": guest_created.cached(cid, ct.get("node"), ct.get("vmid"), "lxc"),
                "tags": ct.get("tags") or ct.get("tag") or "",
                "pool": ct.get("pool"),
                "lock": ct.get("lock"),
                "netin": ct.get("netin"),
                "netout": ct.get("netout"),
                "diskread": ct.get("diskread"),
                "diskwrite": ct.get("diskwrite"),
                # 前端靠它区分「该调到 /vms 还是 /lxc」
                "type": "lxc",
                "connection_id": cid,
                "connection_name": label,
            }
            for ct in containers
        ]

        if with_ip and items:
            resolved = await parallel(
                (_resolve_ct_ip(client, ct) for ct in items), limit=12
            )
            for item, ip in zip(items, resolved):
                item["ip"] = ip if isinstance(ip, str) else ""

        # 创建时间：同 /vms，缓存未命中时逐台读一次 config。
        if items:
            await guest_created.fill(client, items)

        result.extend(items)

    if not result and failure is not None:
        _raise(failure)

    owner = security.visible_owner(user)
    if owner is not None:
        owners = await ownership.owners_map(ownership.KIND_VM)
        result = [
            c
            for c in result
            if owners.get(
                ownership.vm_ref(
                    str(c.get("connection_id") or ""),
                    str(c.get("node") or ""),
                    c.get("vmid"),
                )
            )
            == owner
        ]

    result.sort(key=lambda c: (c.get("node") or "", c.get("vmid") or 0))
    return result


@router.get("/lxc/templates")
async def list_container_templates(
    node: str = Query(..., description="节点名"),
    user: Dict[str, Any] = Depends(security.require_permission("vm.create")),
) -> List[Dict[str, Any]]:
    """节点上可用的容器模板（``vztmpl``），供创建向导选择。

    扫描该节点所有**内容类型含 vztmpl** 的存储；单个存储读失败只跳过它。
    """
    client = get_client()
    try:
        storages = await client.storages(node)
    except ProxmoxError as exc:
        _raise(exc)

    output: List[Dict[str, Any]] = []
    for storage in storages or []:
        name = storage.get("storage")
        if not name:
            continue
        contents = (storage.get("content") or "").split(",")
        if "vztmpl" not in contents:
            continue
        try:
            items = await client.storage_content(node, name, content="vztmpl")
        except ProxmoxError:
            continue
        for item in items or []:
            volid = item.get("volid", "")
            output.append(
                {
                    "volid": volid,
                    "storage": name,
                    "name": volid.split("/")[-1] if "/" in volid else volid,
                    "size": item.get("size"),
                    "ctime": item.get("ctime"),
                }
            )

    output.sort(key=lambda i: (i.get("name") or ""))
    return output


@router.get("/lxc/{node}/{vmid}")
async def get_container(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, Any]:
    client = get_client()

    try:
        config, status = await asyncio.gather(
            client.lxc_config(node, vmid),
            client.lxc_status(node, vmid),
        )
    except ProxmoxError as exc:
        _raise(exc)

    config = config or {}
    status = status or {}

    rootfs = vmconfig.parse_lxc_rootfs(config)
    mounts = vmconfig.parse_lxc_mounts(config)
    networks = vmconfig.parse_lxc_networks(config)

    return {
        "node": node,
        "vmid": vmid,
        "name": config.get("hostname") or status.get("name") or f"CT {vmid}",
        "hostname": config.get("hostname", ""),
        "type": "lxc",
        "template": pve_flag(config.get("template", 0)) == 1,
        "status": status.get("status", "unknown"),
        "uptime": status.get("uptime"),
        # 创建时间：详情本来就已经把 config 取在手里了，这里是零成本
        "created": await guest_created.resolve(
            _op_connection(), node, vmid, "lxc", config
        ),
        "cpu": status.get("cpu"),
        "cpus": config.get("cores"),
        "maxcpu": config.get("cores"),
        "mem": status.get("mem"),
        "maxmem": status.get("maxmem") or config.get("memory"),
        # 与 QEMU 相反：容器的 status.disk / maxdisk 是**真实**用量，可以直接用
        "disk": status.get("disk"),
        "maxdisk": status.get("maxdisk"),
        "swap": status.get("swap"),
        "maxswap": status.get("maxswap") or config.get("swap"),
        "netin": status.get("netin"),
        "netout": status.get("netout"),
        "diskread": status.get("diskread"),
        "diskwrite": status.get("diskwrite"),
        "lock": status.get("lock"),
        "config": config,
        "rootfs": rootfs,
        "mounts": mounts,
        "networks": networks,
        "unprivileged": pve_flag(config.get("unprivileged", 0)) == 1,
        "features": config.get("features", ""),
        "ostemplate": config.get("ostemplate", ""),
        "tags": config.get("tags", ""),
        "description": config.get("description", ""),
        "nameserver": config.get("nameserver", ""),
        "searchdomain": config.get("searchdomain", ""),
        "ssh_keys_set": bool(config.get("ssh-public-keys")),
    }


@router.get("/lxc/{node}/{vmid}/pending")
async def get_container_pending(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.lxc_pending(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/lxc/{node}/{vmid}/rrddata")
async def get_container_rrddata(
    node: str,
    vmid: int,
    timeframe: str = Query(default="hour", pattern="^(hour|day|week|month|year)$"),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.lxc_vm_rrddata(node, vmid, timeframe)
    except ProxmoxError as exc:
        _raise(exc)


# ============================================================== create path
@router.get("/lxc/quota")
async def get_lxc_quota(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """容器下发额度的读数（配额 / 已用 / 可下发 / 我还能不能建）。

    与虚拟机的 ``/vms/quota`` 是**两份独立额度**：容器堆满不会占用虚拟机额度。
    """
    return await quota.usage(user, "lxc")


@router.post("/lxc")
async def create_container(
    payload: LxcCreateRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.create")),
) -> Dict[str, Any]:
    client = get_client()

    # 容器走自己的额度（与虚拟机额度分开记账）
    await quota.enforce_for_create(user, request, "lxc")

    # 与虚拟机同口径：没单独填 DNS 就套面板默认 DNS，免得容器起来后
    # 只拿到路由器 RA 下发的「假 IPv6」DNS，域名全解析不了。
    if payload.setup:
        payload.setup.nameserver = await defaults.effective_dns(
            payload.setup.nameserver
        )

    vmid = payload.vmid
    if not vmid:
        try:
            vmid = await client.nextid()
        except ProxmoxError as exc:
            _raise(exc)

    config = vmconfig.build_lxc_config(payload, vmid=vmid)

    try:
        result = await client.lxc_create(payload.node, config)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.create", target=f"{payload.node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    upid = result if isinstance(result, str) else (result or {}).get("task", "")

    # 口令 / 公钥是敏感值，审计里只记「有没有设」
    await security.audit(
        request, user, "ct.create", target=f"{payload.node}/{vmid}",
        detail={
            "hostname": payload.hostname,
            "ostemplate": payload.ostemplate,
            "rootfs": f"{payload.storage}:{payload.rootfs}",
            "cores": payload.cores,
            "memory": payload.memory,
            "unprivileged": payload.unprivileged,
            "password_set": bool(payload.setup and payload.setup.password),
            "ssh_keys_set": bool(payload.setup and payload.setup.ssh_keys),
        },
    )

    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(_op_connection(), payload.node, vmid),
        str(user.get("username") or ""),
    )

    # 创建时间：面板自己记一份（PVE 的 meta.ctime 建机瞬间可能还没写好，
    # 见 app/guest_created.py）
    await guest_created.record(
        _op_connection(),
        payload.node,
        vmid,
        "lxc",
        source="create",
        username=str(user.get("username") or ""),
    )

    # 下发通知：容器没有 cloud-init，root 口令只在这次创建时存在 ——
    # 这条消息（以及它触发的邮件）往往就是用户拿到它的唯一机会。
    await guestnotify.notify_deployed(
        user,
        guestnotify.from_lxc_request(
            payload,
            node=payload.node,
            vmid=vmid,
            origin=str(payload.ostemplate or ""),
        ),
    )

    return {
        "task": upid,
        "vmid": vmid,
        "node": payload.node,
        "type": "lxc",
    }


# ============================================================== power paths
@router.post("/lxc/{node}/{vmid}/status/{action}")
async def container_power(
    node: str,
    vmid: int,
    action: str,
    request: Request,
    payload: Optional[PowerRequest] = None,
    user: Dict[str, Any] = Depends(security.require_permission("vm.power")),
) -> Dict[str, Any]:
    # 容器支持与虚拟机同一组动作；没有 qemu 的「hibernate」
    allowed = {"start", "stop", "shutdown", "reboot", "suspend", "resume"}
    if action not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的操作：{action}。可用操作：{', '.join(sorted(allowed))}",
        )

    payload = payload or PowerRequest()
    client = get_client()

    try:
        result = await client.lxc_power(
            node, vmid, action, timeout=payload.timeout, force_stop=payload.force_stop
        )
    except ProxmoxError as exc:
        if exc.status_code == 500 and action in ("stop", "shutdown"):
            detail = exc.message.lower()
            if "not running" in detail or "is not running" in detail:
                return {"task": None, "note": "容器未在运行"}
        await security.audit(
            request, user, f"ct.{action}", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(request, user, f"ct.{action}", target=f"{node}/{vmid}")
    return {"task": task}


@router.delete("/lxc/{node}/{vmid}")
async def delete_container(
    node: str,
    vmid: int,
    request: Request,
    purge: bool = True,
    force: bool = False,
    user: Dict[str, Any] = Depends(security.require_permission("vm.delete")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()

    # 与虚拟机同一口径：运行中先拒绝，除非显式 force
    try:
        status = await client.lxc_status(node, vmid)
        if status.get("status") == "running" and not force:
            raise HTTPException(
                status_code=409,
                detail=f"容器 {vmid} 正在运行，请先关机后再删除",
            )
    except ProxmoxError:
        pass  # 探测失败就让删除请求自己决定

    try:
        result = await client.lxc_destroy(node, vmid, purge=purge, force=force)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.delete", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(request, user, "ct.delete", target=f"{node}/{vmid}")
    # 连同创建时间记录一起删：VMID 回收后旧记录会贴到新建的同号容器上
    await guest_created.drop_record(_op_connection(), node, vmid, "lxc")
    return {"task": task}


# ======================================================= ownership (admin)
@router.get("/lxc/{node}/{vmid}/owner")
async def get_container_owner(
    node: str,
    vmid: int,
    connection_id: Optional[str] = Query(default=None),
    user: Dict[str, Any] = Depends(security.require_permission("vm.assign")),
) -> Dict[str, Any]:
    ref = ownership.vm_ref(connection_id or _op_connection(), node, vmid)
    return {
        "node": node,
        "vmid": vmid,
        "owner": await ownership.get_owner(ownership.KIND_VM, ref),
    }


@router.put("/lxc/{node}/{vmid}/owner")
async def set_container_owner(
    node: str,
    vmid: int,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.assign")),
) -> Dict[str, Any]:
    """把容器指派给某个用户；``username`` 为空表示清除归属。"""
    username = str(payload.get("username") or "").strip()
    if username:
        target = await store.get_user(username)
        if not target:
            raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    conn_id = payload.get("connection_id") or _op_connection()
    ref = ownership.vm_ref(conn_id, node, vmid)
    if username:
        await ownership.set_owner(ownership.KIND_VM, ref, username)
    else:
        await ownership.delete_owner(ownership.KIND_VM, ref)

    await security.audit(
        request, user, "vm.assign" if username else "vm.unassign",
        target=f"{node}/{vmid}",
        detail={"username": username or None, "type": "lxc"},
    )
    return {"node": node, "vmid": vmid, "owner": username or None}


# =========================================================== config / edits
@router.put("/lxc/{node}/{vmid}/config")
async def update_container_config(
    node: str,
    vmid: int,
    payload: LxcConfigUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    data = payload.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="没有需要更新的配置项")

    try:
        result = await client.lxc_set_config(node, vmid, data)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.config.update", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "ct.config.update", target=f"{node}/{vmid}", detail=data
    )
    return {"task": task}


@router.post("/lxc/{node}/{vmid}/config")
async def set_container_config_post(
    node: str,
    vmid: int,
    payload: LxcConfigUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """Alias for clients that send the raw config as a POST body."""
    return await update_container_config(node, vmid, payload, request, user)


# ------------------------------------------------------- 硬件增删（网卡 / 挂载点）
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
    try:
        result = await client.lxc_set_config(node, vmid, data)
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


@router.post("/lxc/{node}/{vmid}/hardware/network")
async def add_container_network(
    node: str,
    vmid: int,
    payload: LxcAddNetwork,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        config = await client.lxc_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if payload.interface:
        key = payload.interface
        if not _has_digit_suffix(key, "net"):
            raise HTTPException(status_code=400, detail=f"{key} 不是合法的网卡键名")
        if key in config:
            raise HTTPException(status_code=409, detail=f"槽位 {key} 已被占用")
    else:
        try:
            key = vmconfig.next_free_key("net", config, 32)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    index = int(key[3:]) if key[3:].isdigit() else 0
    spec = LxcAddNetwork(**payload.model_dump(exclude_none=True))
    if not spec.name:
        # 容器内的接口名必须唯一，按槽位号顺序分配 eth0 / eth1 …
        spec.name = f"eth{index}"
    value = vmconfig.format_lxc_network_spec(spec, index=index)
    return await _set_hardware(
        client, request, user, node, vmid, "ct.network.add", key, {key: value}
    )


@router.post("/lxc/{node}/{vmid}/hardware/mount")
async def add_container_mount(
    node: str,
    vmid: int,
    payload: LxcAddMount,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """给容器加一个挂载点（``mpN``）。

    挂载点**不能**删掉 rootfs，所以只挑 mpN 的空位；键名与容器内路径都由
    调用方给（路径是业务语义，猜不出来）。
    """
    client = get_client()
    try:
        config = await client.lxc_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if not (payload.mp or "").strip():
        raise HTTPException(status_code=400, detail="请填写容器内的挂载路径")

    if payload.interface:
        key = payload.interface
        if not _has_digit_suffix(key, "mp"):
            raise HTTPException(status_code=400, detail=f"{key} 不是合法的挂载点键名")
        if key in config:
            raise HTTPException(status_code=409, detail=f"槽位 {key} 已被占用")
    else:
        try:
            key = vmconfig.next_free_key("mp", config, 256)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    value = vmconfig.format_lxc_mount_spec(payload)
    return await _set_hardware(
        client, request, user, node, vmid, "ct.mount.add", key, {key: value}
    )


@router.delete("/lxc/{node}/{vmid}/hardware/{key}")
async def remove_container_hardware(
    node: str,
    vmid: int,
    key: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """卸掉一张网卡或一个挂载点。

    与虚拟机同样**只删配置项，不动卷数据**：挂载点的卷会变成无人引用的孤立卷
    留在原存储池，需要回收就上「存储」页删。
    """
    if not _is_ct_hardware_key(key):
        raise HTTPException(
            status_code=400,
            detail=f"{key} 不是可删除的硬件配置项（容器的网卡是 netN、挂载点是 mpN）",
        )

    client = get_client()
    try:
        config = await client.lxc_config(node, vmid) or {}
    except ProxmoxError as exc:
        _raise(exc)

    if key not in config:
        raise HTTPException(status_code=404, detail=f"该容器没有 {key} 这一项")

    try:
        result = await client.lxc_set_config(node, vmid, {"delete": key})
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.hardware.remove", target=f"{node}/{vmid}",
            result="failed", detail=f"{key}: {exc.message}",
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "ct.hardware.remove", target=f"{node}/{vmid}",
        detail={"key": key, "value": config.get(key)},
    )
    return {"task": task, "key": key}


# ---- 重置客户机内用户口令 ----
# 容器没有 Guest Agent，PVE 的 API 也没有「在容器里执行命令」的端点，
# 所以这里只有一条通道：借「SSH → 受管主机」的凭据在宿主机上执行
# pct exec <vmid> -- chpasswd（详见 app.guestpasswd 的模块说明）。
@router.get("/lxc/{node}/{vmid}/password-methods")
async def container_password_methods(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """这个容器现在能不能改口令、走哪条路。"""
    client = get_client()
    try:
        return await guestpasswd.inspect(guestpasswd.CT_KIND, client, node, vmid)
    except ProxmoxError as exc:
        _raise(exc)


@router.post("/lxc/{node}/{vmid}/password")
async def reset_container_password(
    node: str,
    vmid: int,
    payload: GuestPasswordRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """重置容器内某个用户的口令。"""
    client = get_client()
    target = f"{node}/{vmid}/{payload.username}"
    try:
        result = await guestpasswd.reset(
            guestpasswd.CT_KIND,
            client,
            node,
            vmid,
            username=payload.username,
            password=payload.password,
            method=payload.method,
        )
    except HTTPException as exc:
        await security.audit(
            request, user, "ct.password.reset", target=target,
            result="failed", detail=str(exc.detail)[:300],
        )
        raise
    await security.audit(
        request, user, "ct.password.reset", target=target,
        detail={
            "method": result.get("method"),
            "restarted": result.get("restarted"),
        },
    )
    return result


@router.post("/lxc/{node}/{vmid}/resize")
async def resize_container_disk(
    node: str,
    vmid: int,
    payload: LxcResizeRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    """扩容 rootfs / mpN。容器只支持**增**容，缩小会被 PVE 拒绝。"""
    client = get_client()
    try:
        result = await client.lxc_resize(node, vmid, payload.disk, payload.size)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.disk.resize", target=f"{node}/{vmid}/{payload.disk}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "ct.disk.resize", target=f"{node}/{vmid}/{payload.disk}",
        detail={"size": payload.size},
    )
    return {"task": task}


@router.post("/lxc/{node}/{vmid}/move")
async def move_container_volume(
    node: str,
    vmid: int,
    payload: LxcMoveRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.lxc_move_volume(
            node, vmid, payload.volume, payload.storage, payload.delete_source
        )
    except ProxmoxError as exc:
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "ct.volume.move", target=f"{node}/{vmid}/{payload.volume}",
        detail={"storage": payload.storage},
    )
    return {"task": task}


@router.post("/lxc/{node}/{vmid}/migrate")
async def migrate_container(
    node: str,
    vmid: int,
    payload: LxcMigrateRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.lxc_migrate(
            node, vmid, payload.target_node, payload.online, payload.restart
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.migrate", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "ct.migrate", target=f"{node}/{vmid}",
        detail={"target": payload.target_node, "online": payload.online},
    )
    return {"task": task}


@router.post("/lxc/{node}/{vmid}/clone")
async def clone_container(
    node: str,
    vmid: int,
    payload: LxcCloneRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.clone")),
) -> Dict[str, Any]:
    client = get_client()

    # 克隆会实实在在多出一台机器，配额必须跟着算（算在容器额度上）
    await quota.enforce_for_create(user, request, "lxc")

    try:
        result = await client.lxc_clone(
            node,
            vmid,
            newid=payload.newid,
            hostname=payload.hostname,
            target_storage=payload.target_storage,
            target_node=payload.target_node,
            description=payload.description,
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "ct.clone", target=f"{node}/{vmid} -> {payload.newid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")

    # 等克隆落盘完成再改配置，否则覆盖会被之后的任务冲掉
    if isinstance(task, str) and task.startswith("UPID:"):
        try:
            await client.wait_for_task(task, timeout=600)
        except ProxmoxError:
            pass

    target_node = payload.target_node or node
    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(_op_connection(), target_node, payload.newid),
        str(user.get("username") or ""),
    )
    await security.audit(
        request, user, "ct.clone", target=f"{node}/{vmid} -> {payload.newid}",
        detail={"hostname": payload.hostname},
    )
    # 创建时间：克隆会继承来源容器的 meta，必须记面板这一份
    await guest_created.record(
        _op_connection(),
        target_node,
        payload.newid,
        "lxc",
        source="clone",
        username=str(user.get("username") or ""),
    )
    return {"task": task, "vmid": payload.newid, "node": target_node}


@router.post("/lxc/{node}/{vmid}/template")
async def convert_container_to_template(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("template.manage")),
) -> Dict[str, Any]:
    """把容器转成模板 —— 与 :func:`app.routers.vms.convert_to_template` 对等。

    PVE 的容器能转模板（``pct template``，见 pct(1)），只是这条端点没出现在
    API 索引里，面板此前据此判定「容器不能转模板」并隐藏了入口 —— 那是错的，
    实测 8.4 / 9.2 上这条端点都在。转换要求容器处于关机状态。
    """
    client = get_client()

    try:
        status = await client.lxc_status(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)

    if status.get("status") == "running":
        raise HTTPException(status_code=409, detail="转换为模板前必须先关闭容器")

    try:
        result = await client.lxc_to_template(node, vmid)
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
@router.get("/lxc/{node}/{vmid}/snapshot")
async def list_container_snapshots(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        snaps = await client.lxc_snapshots(node, vmid)
    except ProxmoxError as exc:
        _raise(exc)
    # 与虚拟机共用快照归属逻辑：创建者标记优先，缺失时按机器归属回落
    return await _filter_snapshots(user, node, vmid, snaps)


@router.post("/lxc/{node}/{vmid}/snapshot")
async def create_container_snapshot(
    node: str,
    vmid: int,
    payload: SnapshotCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        result = await client.lxc_snapshot_create(
            node, vmid, payload.name, payload.description
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
        request, user, "snapshot.create", target=f"{node}/{vmid}/{payload.name}",
        detail={"type": "lxc"},
    )
    return {"task": task}


@router.post("/lxc/{node}/{vmid}/snapshot/{name}/rollback")
async def rollback_container_snapshot(
    node: str,
    vmid: int,
    name: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    await _require_snapshot_access(user, node, vmid, name)
    client = get_client()
    try:
        result = await client.lxc_snapshot_rollback(node, vmid, name)
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


@router.delete("/lxc/{node}/{vmid}/snapshot/{name}")
async def delete_container_snapshot(
    node: str,
    vmid: int,
    name: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.snapshot")),
) -> Dict[str, Any]:
    await _require_snapshot_access(user, node, vmid, name)
    client = get_client()
    try:
        result = await client.lxc_snapshot_delete(node, vmid, name)
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
