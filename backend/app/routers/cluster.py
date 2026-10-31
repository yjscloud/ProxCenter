"""Cluster-wide and per-node read endpoints."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import fleetstatus, guestguard, ownership, pvecache, security, store
from ..formatters import pve_flag
from ..nodeaccess import require_node_visible
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    parallel,
    requested_connection,
)
from ..task_scope import build_scope

router = APIRouter(prefix="/api", tags=["cluster"])

#: 「探测已保存连接可达性」的缓存时长（秒）。这个接口逐台真实发请求，而首页会
#: 定时轮询它 —— 多开标签 / 多人同时看时，同一轮探测被重复触发纯属浪费。
CONNECTIONS_STATUS_TTL = 30.0


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


@router.get("/cluster/status")
async def cluster_status(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """**单套**集群的状态：版本、仲裁、节点清单。

    「单套」是字面意思 —— PVE 的 ``/cluster/status`` 只能读一台。它跟随顶栏的
    集群作用域（``X-PVE-Scope``），作用域为「全部集群」时读兜底连接。

    多 PVE 的部署里，需要**全机队**读数的地方不要用它：

    * 全部连接的版本 / 仲裁 / 可达性 → ``/cluster/fleet-status``
      （顶栏「控制台状态」、设置页系统信息、仪表盘的集群态势都用它）；
    * 全部连接的节点清单 → ``/nodes``（未指定作用域时跨连接合并）。

    保留它是因为「就这一套集群的详细状态」仍是合法需求（脚本、单集群部署），
    前端只剩设置页在 fleet 读取失败时拿它当兜底。
    """
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


#: 资源清单里属于「基础设施」的条目：它们不是谁的机器，可见性由各自的权限点
#: （``node.view`` / ``storage.view``）决定，不参与用户归属过滤。
_INFRA_RESOURCE_TYPES = ("node", "storage", "sdn")

#: 客户机条目。PVE 用 ``qemu`` / ``lxc``，个别版本对虚拟机给 ``vm``。
_GUEST_RESOURCE_TYPES = ("qemu", "lxc", "vm")


async def _scope_resources(
    items: List[Dict[str, Any]], user: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """按归属裁剪 ``/cluster/resources``。

    这份清单此前是原样透传的：只有 ``vm.view`` / ``ct.view`` 的普通用户能读到全集群
    的机器名与 VMID，与 ``GET /api/vms`` 的隔离承诺相悖。裁剪规则与客户机列表同源：

    * 管理员：不限制；
    * 区域管理员：本区域连接全放行，区域外只留基础设施条目；
    * 其余角色：客户机条目必须是自己名下的（严格隔离，无归属记录的存量机器不发）；
    * 基础设施条目（节点 / 存储 / SDN）：不裁剪 —— 它们本来就由各自的权限点管控，
      一刀切会让「存储页看得到、资源接口看不到」。
    * 模板（``template=1``）：保留 —— 模板库是共享资源，与 ``/templates`` 一致。
    """
    scope = security.visible_owner(user)
    if scope is None:
        return items

    connection_id = guestguard.call_connection()
    if security.is_region_admin(user):
        if security.region_in_scope(user, store.connection_region(connection_id)):
            return items
        return [
            i for i in items if str(i.get("type") or "") in _INFRA_RESOURCE_TYPES
        ]

    owners = await ownership.guest_owners_map()
    out: List[Dict[str, Any]] = []
    for item in items or []:
        kind = str(item.get("type") or "")
        if kind in _INFRA_RESOURCE_TYPES:
            out.append(item)
            continue
        if kind not in _GUEST_RESOURCE_TYPES:
            continue  # 认不出的类型宁可不发
        if str(item.get("template") or "0") in ("1", "True", "true"):
            out.append(item)
            continue
        ref = ownership.vm_ref(
            connection_id, str(item.get("node") or ""), item.get("vmid")
        )
        if owners.get(ref) == scope:
            out.append(item)
    return out


@router.get("/cluster/resources")
async def cluster_resources(
    type: Optional[str] = Query(default=None, description="vm | node | storage | sdn"),
    # 跨类型的资源清单（虚拟机与容器都走这里），任一类查看权限即可
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.view", "ct.view")
    ),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        items = await client.cluster_resources(type) or []
    except ProxmoxError as exc:
        _raise(exc)
    return await _scope_resources(items, user)


@router.get("/cluster/nextid")
async def next_id(
    # 取下一个 VMID：只有**能建机器**的人才需要它（创建向导）。
    # 原来只要 vm.view / ct.view 就能读 —— 那等于让只读用户拿到了
    # 「下一个会被分配出去的 ID」，属于免费的集群增量情报（安全审计 L-1）。
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.create", "ct.create")
    ),
) -> Dict[str, int]:
    client = get_client()
    try:
        return {"vmid": await client.nextid()}
    except ProxmoxError as exc:
        _raise(exc)


def _flatten_scoped(
    results: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    """把「每条连接一批数据」摊平成一条列表，并标注来源连接。

    标注是必要的：任务 / 池子只存在于某一条连接上，多套 PVE 里节点名还可能重复
    （两台都叫 ``pve``），不给来源的话界面上分不清这一行是谁的。
    """
    merged: List[Dict[str, Any]] = []
    for profile, items in results:
        cid = str(profile.get("id") or "")
        label = connection_label(profile)
        for item in items:
            merged.append({**item, "connection_id": cid, "connection_name": label})
    return merged


async def _fan_out(
    pairs: List[Tuple[Dict[str, Any], Any]], call: Any
) -> List[Tuple[Dict[str, Any], List[Dict[str, Any]]]]:
    """对每条已保存连接并发执行 ``call``，单条失败只跳过它自己。"""

    async def one(
        profile: Dict[str, Any], client: Any
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        try:
            return profile, await call(client)
        except ProxmoxError:
            # 某一台连不上只跳过它，别让整页报错（与 /nodes 的失败语义一致）
            return profile, []

    return list(await asyncio.gather(*(one(p, c) for p, c in pairs)))


@router.get("/cluster/tasks")
async def cluster_tasks(
    node: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> List[Dict[str, Any]]:
    """最近任务，跨全部连接。

    未指定 ``X-PVE-Connection``（顶栏作用域为「全部集群」）时**合并每一条连接**：
    任务只存在于执行它的那台 PVE 上，只读兜底那一台的话，另外几套集群的任务
    永远不会出现在列表里（与 ``/nodes``、``/vms`` 的「同级合并」同一套口径）。
    指定了作用域时只查那一条 —— 这也是列表页里「只看这套集群」的落点。
    """
    # 归属过滤与 ``GET /api/tasks``、``/ws/tasks`` 共用 ``app.task_scope``：
    # 此前这个入口是原样透传，普通用户能读到全平台 UPID（节点名 + VMID +
    # 发起者身份 + 起止时间）。
    scope = await build_scope(user)
    pairs = all_connection_clients()
    if requested_connection() or not pairs:
        try:
            items = await get_client().tasks(node=node, limit=limit) or []
        except ProxmoxError as exc:
            _raise(exc)
        if scope is not None:
            items = scope.filter(items, guestguard.call_connection())
        return items

    # client.tasks 内部已按 starttime 倒序并各自截断，这里合并后再排一次、
    # 再截断一次，得到的才是「全体连接里最近的 limit 条」
    merged = _flatten_scoped(
        await _fan_out(pairs, lambda c: c.tasks(node=node, limit=limit))
    )
    if scope is not None:
        # 每条任务自带 connection_id（_flatten_scoped 打的标），用它判定才不会
        # 把 B 连接上同 node + 同 vmid 的任务误认成 A 连接里自己的机器
        merged = scope.filter(merged)
    merged.sort(key=lambda t: t.get("starttime") or 0, reverse=True)
    return merged[:limit]


@router.get("/cluster/pools")
async def cluster_pools(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    """资源池列表。作用域口径与 :func:`cluster_tasks` 相同。"""
    pairs = all_connection_clients()
    if requested_connection() or not pairs:
        try:
            return await get_client().pools()
        except ProxmoxError as exc:
            _raise(exc)

    return _flatten_scoped(await _fan_out(pairs, lambda c: c.pools()))


# ------------------------------------------------------------------ nodes
@router.get("/nodes")
async def list_nodes(
    # 这份清单同时服务两类人：看节点状态的人（node.view），以及**要建机器、
    # 必须先挑一台宿主机**的人（vm.create / ct.create）。后者若没有 node.view，
    # 创建虚拟机 / 容器的向导里节点下拉就是空的，机器直接建不出来 —— 而「建机器」
    # 本来就要求看得见有哪些宿主机，这与节点监控是两件事。
    # 放宽的只是只读的节点概况（cpu/mem/disk/uptime 等），写操作仍在各自接口按
    # node.* 判一次。
    user: Dict[str, Any] = Depends(
        security.require_any_permission("node.view", "vm.create", "ct.create")
    ),
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
        # 区域管理员越区索取节点：明确拒绝，而不是返回空列表（空列表看起来像
        # 「这台 PVE 挂了」，排查方向会跑偏）
        security.ensure_region_allowed(user, cid)
        targets: List[Tuple[Optional[Dict[str, Any]], Any]] = [(profile, get_client())]
    else:
        # 区域管理员只向本区域的连接取节点；普通用户的收窄发生在节点级
        targets = [
            (profile, client)
            for profile, client in (all_connection_clients() or [(None, get_client())])
            if security.region_in_scope(user, str((profile or {}).get("region") or ""))
        ]
        if not targets:
            return []

    # 节点级可见性：一次读全表，循环里只做内存判断（见 security.node_visibility）
    node_visible = await security.node_visibility(user)

    result: List[Dict[str, Any]] = []
    failure: Optional[ProxmoxError] = None
    # SSL 指纹是连接凭据的一部分，只给管理员（安全审计 L-1）。它对 operator
    # 侧的任何一个界面都不参与展示，却是「指纹有没有被换过 / 是不是同一个
    # 集群」的现成侦察素材。容量与 uptime 保留 —— operator 需要据此判断
    # 自己机器所在宿主机是否吃紧，属于「只看自己机器」的必要上下文。
    is_admin = security.visible_owner(user) is None

    # 每条连接一次 nodes()，并发拉：串行时 C 条连接就是 C 个 RTT，而节点列表在
    # 建机向导、总览、下拉框里都要用，是最常见的首屏请求之一。
    nodes_list = await parallel(
        (client.nodes() for _profile, client in targets),
        limit=max(len(targets), 1),
    )
    # 连接元数据一次取全：原来在循环里为拼 connection_name 逐条扫一遍连接列表
    profiles_by_id = {str(c.get("id") or ""): c for c in _store.get_connections()}

    for (profile, _client), nodes in zip(targets, nodes_list):
        if isinstance(nodes, BaseException):
            if isinstance(nodes, ProxmoxError):
                failure = failure or nodes
            continue
        nodes = nodes or []

        cid = str(profile.get("id") or "") if profile else str(active_id or "")
        label = connection_label(profile) if profile else connection_label(
            profiles_by_id.get(cid, {})
        )
        # 节点级可见性：被限制的节点（特殊项目专用机）对普通用户整条消失，
        # 建机向导的下拉来自这里，所以「看不到」同时等于「选不到」。
        nodes = [n for n in nodes if node_visible(cid, str(n.get("node") or ""))]
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
                **(
                    {"ssl_fingerprint": n.get("ssl_fingerprint")} if is_admin else {}
                ),
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
    """所有 PVE 连接的合计状态：给「控制台状态」「设置 → 系统信息」以及仪表盘的
    集群态势卡用。

    为什么需要它：面板把多条 PVE 连接当作**同级**（见 connections 的说明），
    而 ``/api/health`` 与 ``/api/cluster/status`` 只能读其中一套 —— 4 套连接里
    在全局位置显示「1 个节点」，会让人以为面板只连了一台机器。

    探测本身搬到了 :func:`app.fleetstatus.collect`：集群仲裁巡检（告警）要用同一
    份口径，两边各写一遍迟早会分叉成「页面红着、告警不响」。
    """
    # 地址只给管理员：这个接口有 node.view 就能访问，而它会把每条连接的主机
    # 列出来 —— 连接配置属于管理信息，与 /connections 同一口径。
    # 走带缓存的入口（30 秒）：/health 也用同一个 key，顶栏两条入口不会各探测一遍。
    can_manage = security.has_user_permission(user, "settings.manage")
    result = await fleetstatus.panel_fleet(can_manage)
    if result is None:
        # 探测整体超时 / 失败（单条连接失败不会走到这里，那种情况 collect 会
        # 正常返回 ok=false 的条目）。宁可回 503，也不回一份看起来「一台都
        # 没连上」的假数据 —— 前端对 503 显示「未知」，对空列表会显示红色故障。
        raise HTTPException(status_code=503, detail="机队状态暂时不可用（探测超时）")
    return result


@router.get("/connections/status")
async def connections_status(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> List[Dict[str, Any]]:
    """逐条探测已保存 PVE 的可达性。

    「多台同时在线」下，列表里少了哪台主机需要能解释清楚，这个接口就是给
    顶部提示条用的：哪台通、哪台不通、不通的原因。

    带一层短 TTL 缓存（见 :data:`CONNECTIONS_STATUS_TTL`）：它逐台真实发请求，
    而首页会定时轮询 —— 多开标签时同一轮探测被重复触发纯属浪费。
    """
    # 这个接口会拿库里的 API Token 逐台真实发请求 —— 等于「用凭据打了哪些主机」，
    # 事后追溯时属于必看的一条。
    await security.audit_read(request, user, "config.connections_status.read")

    # 这个接口只要求登录，而它会逐台回报「哪台通、哪台不通」—— 地址与端口
    # 属于连接配置（管理信息），只给管理员，与 /connections 同一口径。
    can_manage = security.has_user_permission(user, "settings.manage")

    async def _build() -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for profile, client in all_connection_clients():
            item: Dict[str, Any] = {
                "id": str(profile.get("id") or ""),
                "name": connection_label(profile),
                **(
                    {"host": profile.get("host"), "port": profile.get("port")}
                    if can_manage
                    else {}
                ),
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

    return await pvecache.cached(
        "cluster:connections:status", CONNECTIONS_STATUS_TTL, _build
    )


@router.get("/nodes/{node}/status")
async def node_status(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
    _visible: None = Depends(require_node_visible),
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
    _visible: None = Depends(require_node_visible),
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
    _visible: None = Depends(require_node_visible),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        return await client.node_network(node)
    except ProxmoxError as exc:
        _raise(exc)
