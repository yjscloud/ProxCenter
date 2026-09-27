"""Cluster-wide and per-node read endpoints."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import security
from ..formatters import pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    parallel,
    requested_connection,
)

router = APIRouter(prefix="/api", tags=["cluster"])


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


def _active_connection() -> Dict[str, str]:
    """默认读取的那一套 PVE（id + 展示名）。

    面板把多条 PVE 连接当**同级**，没有「主连接」这个概念；但少数接口
    （``/health``、``/cluster/status``）一次只能读一台，需要一个确定目标。
    那个目标由管理员在「设置 → 系统信息」里指定，这里把它一并返回 ——
    否则多连接部署下「这个节点数是哪一台的」没人答得上来。
    """
    try:
        from ..store import get_active_connection_id, get_connections

        cid = str(get_active_connection_id() or "")
        for profile in get_connections():
            if str(profile.get("id") or "") == cid:
                return {"id": cid, "name": connection_label(profile)}
    except Exception:  # noqa: BLE001 - 拿不到名字不影响主数据
        pass
    return {"id": "", "name": ""}


@router.get("/cluster/status")
async def cluster_status(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        raw = await client.get("/cluster/status")
        version = await client.version()
    except ProxmoxError as exc:
        _raise(exc)

    nodes = [
        {
            "name": item.get("name"),
            "type": item.get("type"),
            "online": pve_flag(item.get("online", 0)) == 1,
            "nodeid": item.get("nodeid"),
            "level": item.get("level"),
            "local": pve_flag(item.get("local", 0)) == 1,
        }
        for item in (raw or [])
        if item.get("type") == "node"
    ]
    quorate = next(
        (pve_flag(i.get("quorate", 0)) == 1 for i in (raw or []) if i.get("type") == "cluster"),
        None,
    )

    return {
        "quorate": quorate,
        "nodes": nodes,
        "version": version.get("version"),
        "release": version.get("release"),
    }


@router.get("/cluster/resources")
async def cluster_resources(
    type: Optional[str] = Query(default=None, description="vm | node | storage | sdn"),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.cluster_resources(type) or []
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/cluster/nextid")
async def next_id(
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, int]:
    client = get_client()
    try:
        return {"vmid": await client.nextid()}
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/cluster/tasks")
async def cluster_tasks(
    node: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.tasks(node=node, limit=limit)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/cluster/pools")
async def cluster_pools(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.pools()
    except ProxmoxError as exc:
        _raise(exc)


# ------------------------------------------------------------------ nodes
@router.get("/nodes")
async def list_nodes(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    """节点列表。

    未显式指定 X-PVE-Connection 时，把**所有已保存的 PVE** 的节点合并返回，
    并标注来源主机；某一台连不上只跳过它自己，不影响其它主机。

    指定 X-PVE-Connection 时只返回该连接的节点，但仍要带上 connection_id /
    connection_name —— 详情页靠这两个字段判断节点属于哪台主机，
    否则同名节点（两台 PVE 都叫 "pve"）会拿不到 nodeInfo 元数据。
    """
    from .. import store as _store

    active_id = _store.get_active_connection_id()
    if requested_connection():
        # 找到该 connection_id 对应的 profile，用于填充 cid/label
        cid = requested_connection()
        profile = next(
            (c for c in _store.get_connections() if str(c.get("id")) == cid),
            None,
        )
        targets: List[Tuple[Optional[Dict[str, Any]], Any]] = [(profile, get_client())]
    else:
        targets = list(all_connection_clients()) or [(None, get_client())]

    result: List[Dict[str, Any]] = []
    failure: Optional[ProxmoxError] = None

    for profile, client in targets:
        try:
            nodes = await client.nodes() or []
        except ProxmoxError as exc:
            failure = failure or exc
            continue

        cid = str(profile.get("id") or "") if profile else str(active_id or "")
        label = connection_label(profile) if profile else connection_label(
            next(
                (c for c in _store.get_connections() if str(c.get("id")) == cid),
                {},
            )
        )
        result.extend(
            {
                "node": n.get("node"),
                "status": n.get("status", "unknown"),
                "cpu": n.get("cpu"),
                "maxcpu": n.get("maxcpu"),
                "mem": n.get("mem"),
                "maxmem": n.get("maxmem"),
                "disk": n.get("disk"),
                "maxdisk": n.get("maxdisk"),
                "uptime": n.get("uptime"),
                "level": n.get("level", ""),
                "ssl_fingerprint": n.get("ssl_fingerprint"),
                "connection_id": cid,
                "connection_name": label,
            }
            for n in nodes
        )

    if not result and failure is not None:
        _raise(failure)
    return result


@router.get("/cluster/ha-status")
async def cluster_ha_status(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """集群仲裁（quorum）与 HA 运行状态。

    「HA 是否启用」不能只看有没有 HA 资源：一个多节点集群把 HA 服务跑起来了、
    但此刻没托管任何虚拟机，同样应该读作**已启用**而不是「未启用」。
    判据分三层：

      * 有 HA 资源（``/cluster/ha/status/resources`` 非空）→ 一定在用；
      * CRM 选出了 master 且集群不止一个节点 → HA 已启用（只是暂无托管对象）；
      * 只有一个节点 → 单机模式，没有 HA 可言。

    单节点部署也有 quorum（恒为 1），但展示它仍有意义：多节点集群里 quorate 掉了
    意味着整个集群进入只读保护，这是最高级别的异常。

    返回值里带上 ``connection_name``：面板把多套 PVE 当同级，这张卡只反映
    其中一套（读取用的默认连接），不标出来会让人以为它是全站结论。
    """
    client = get_client()
    quorum: Optional[Dict[str, Any]] = None
    ha_master = ""
    ha_resources: List[Dict[str, Any]] = []

    try:
        status_list = await client.get("/cluster/ha/status/current") or []
        for item in status_list:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type") or "")
            if kind == "quorum":
                quorum = {
                    "quorate": pve_flag(item.get("quorate") or 0) == 1,
                    "status": str(item.get("status") or "-"),
                }
            elif kind == "master":
                # CRM 选出了 master：HA 服务确实在跑，与「有没有托管资源」无关。
                # 它的 status 在空闲时是「node02 (idle, ...)」而不是 "active"，
                # 所以只看有没有这条记录，不看 status 文案。
                ha_master = str(item.get("node") or "")
        # HA 资源列表单列一次请求：没配置 HA 资源的集群这里会直接 501，
        # 不能让它把上面已经拿到的 quorum / master 一起作废。
        try:
            raw_resources = await client.get("/cluster/ha/status/resources") or []
        except ProxmoxError:
            raw_resources = []
        for item in raw_resources:
            if not isinstance(item, dict):
                continue
            ha_resources.append(
                {
                    "id": item.get("id"),
                    "state": item.get("state"),
                    "node": item.get("node"),
                    "sid": item.get("sid"),
                    "type": item.get("type"),
                }
            )
    except ProxmoxError as exc:
        _raise(exc)

    # 节点数单独问一次 /cluster/status：HA 状态列表在多节点集群里才有 lrm 条目，
    # 用它数节点会把「单机 + HA 服务在跑」误判成集群。
    node_count = 0
    try:
        raw_nodes = await client.get("/cluster/status")
        if isinstance(raw_nodes, list):
            node_count = sum(
                1
                for row in raw_nodes
                if isinstance(row, dict) and str(row.get("type") or "") == "node"
            )
    except ProxmoxError:
        pass

    ha_enabled = bool(ha_resources) or (bool(ha_master) and node_count > 1)

    return {
        "quorum": quorum or {"quorate": None, "status": "unknown"},
        "ha_enabled": ha_enabled,
        "ha_resources": ha_resources,
        "ha_master": ha_master,
        "node_count": node_count,
        "cluster_mode": "cluster" if node_count > 1 else "standalone",
        "connection_name": _active_connection()["name"],
    }


@router.get("/cluster/fleet-status")
async def cluster_fleet_status(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """所有 PVE 连接的合计状态：给「控制台状态」与「设置 → 系统信息」用。

    为什么需要它：面板把多条 PVE 连接当作**同级**（见 connections 的说明），
    而 ``/api/health`` 与 ``/api/cluster/status`` 只能读其中一套 —— 4 套连接里
    在全局位置显示「1 个节点」，会让人以为面板只连了一台机器。

    逐条并发探测，单条失败只影响它自己（与大屏的聚合口径一致）；单机连接不去
    问 HA，省一次上游请求。
    """
    pairs = all_connection_clients()

    async def probe(profile: Dict[str, Any], client: Any) -> Dict[str, Any]:
        item: Dict[str, Any] = {
            "id": str(profile.get("id") or ""),
            "name": connection_label(profile),
            "host": str(profile.get("host") or ""),
            "ok": False,
            "error": None,
            "version": "",
            "node_count": 0,
            "cluster_mode": "standalone",
            "quorate": None,
            "ha_enabled": False,
            "ha_resources": 0,
        }
        try:
            version = await client.version() or {}
            nodes = await client.nodes() or []
        except ProxmoxError as exc:
            item["error"] = exc.message
            return item

        item["ok"] = True
        item["version"] = str(version.get("version") or "")
        item["node_count"] = len(nodes)
        item["cluster_mode"] = "cluster" if len(nodes) > 1 else "standalone"
        if item["cluster_mode"] != "cluster":
            return item

        try:
            status_list = await client.get("/cluster/ha/status/current") or []
        except ProxmoxError:
            return item

        master = ""
        for row in status_list:
            if not isinstance(row, dict):
                continue
            kind = str(row.get("type") or "")
            if kind == "quorum":
                item["quorate"] = pve_flag(row.get("quorate") or 0) == 1
            elif kind == "master":
                # 空闲时 status 是「node02 (idle, ...)」而不是 "active"，只看有没有
                master = str(row.get("node") or "")

        # 资源列表单独问：没有 HA 资源的集群它直接 501，不能连累上面的判定
        try:
            resource_list = await client.get("/cluster/ha/status/resources") or []
        except ProxmoxError:
            resource_list = []
        item["ha_resources"] = len(resource_list)
        item["ha_enabled"] = bool(resource_list) or bool(master)
        return item

    items = await parallel([probe(profile, client) for profile, client in pairs])
    totals = {
        "connections": len(items),
        "online": sum(1 for i in items if i["ok"]),
        "nodes": sum(int(i["node_count"]) for i in items if i["ok"]),
        "clusters": sum(1 for i in items if i["cluster_mode"] == "cluster"),
        "standalone": sum(
            1 for i in items if i["ok"] and i["cluster_mode"] == "standalone"
        ),
        "ha_enabled": sum(1 for i in items if i["ha_enabled"]),
        "ha_resources": sum(int(i["ha_resources"]) for i in items),
        "no_quorum": sum(1 for i in items if i["quorate"] is False),
    }
    return {
        "connections": items,
        "totals": totals,
        # 只能读单台的接口（/health、/cluster/status）走这一套：
        # 带上它是为了在界面上标出「这些数字读的是哪一台」
        "default_connection": _active_connection(),
    }


@router.get("/connections/status")
async def connections_status(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> List[Dict[str, Any]]:
    """逐条探测已保存 PVE 的可达性。

    「多台同时在线」下，列表里少了哪台主机需要能解释清楚，这个接口就是给
    顶部提示条用的：哪台通、哪台不通、不通的原因。
    """
    # 这个接口会拿库里的 API Token 逐台真实发请求 —— 等于「用凭据打了哪些主机」，
    # 事后追溯时属于必看的一条。
    await security.audit_read(request, user, "config.connections_status.read")
    result: List[Dict[str, Any]] = []
    for profile, client in all_connection_clients():
        item: Dict[str, Any] = {
            "id": str(profile.get("id") or ""),
            "name": connection_label(profile),
            "host": profile.get("host"),
            "port": profile.get("port"),
            "ok": False,
            "error": None,
            "node_count": 0,
            # 令牌权限不足时 PVE 不报错，而是把 CPU/内存等字段留空，
            # 于是 /cluster/resources 也会返回空列表（模板/虚拟机「消失」）。
            # 这里用节点指标是否可读来识别这种「连得上但没权限」的状态。
            "node_metrics": False,
        }
        try:
            nodes = await client.nodes() or []
            item["ok"] = True
            item["node_count"] = len(nodes)
            item["node_metrics"] = bool(nodes) and any(
                n.get("maxmem") is not None for n in nodes
            )
        except ProxmoxError as exc:
            item["error"] = exc.message
        result.append(item)
    return result


@router.get("/nodes/{node}/status")
async def node_status(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    client = get_client()
    try:
        return await client.node_status(node)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/nodes/{node}/rrddata")
async def node_rrddata(
    node: str,
    timeframe: str = Query(default="hour", pattern="^(hour|day|week|month|year)$"),
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.node_rrddata(node, timeframe)
    except ProxmoxError as exc:
        _raise(exc)


@router.get("/nodes/{node}/network")
async def node_network(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("network.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.node_network(node)
    except ProxmoxError as exc:
        _raise(exc)
