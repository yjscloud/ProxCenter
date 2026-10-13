"""Aggregated dashboard data.

The dashboard needs cluster-wide totals in one round trip. Fetching them here
(rather than making the browser run a dozen requests) keeps the UI fast and
lets us degrade gracefully when a node is offline.

三个接口都套了一层很短的进程内缓存（见 :mod:`app.pvecache`）：仪表盘是定时轮询的
页面，多个标签页 / 多个人同时看时，同一批数据在几秒内重复打 PVE 纯属浪费。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import __version__, metrics, ownership, pvecache, security, store
from ..formatters import normalize_storage, pve_flag
from ..pve import ProxmoxError, all_connection_clients, get_client, requested_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["dashboard"])

#: 只读集群数据的缓存时长（秒）。短到几乎不影响观感，又能把「同一时刻的重复拉取」
#: 合并成一次 PVE 请求。
DASHBOARD_TTL = 10.0

#: 容量预测的缓存时长（秒）。它优先读本地历史（便宜），但历史不足时会逐节点拉
#: PVE 的 rrddata，那一步很重，缓存价值更高。
CAPACITY_TTL = 30.0


def _connection_scope() -> str:
    """当前请求选中的 PVE 连接标识（多连接部署下必须进缓存 key）。"""
    return requested_connection() or "-"


def _owner_connection() -> str:
    """归属判定用的连接 id（与 ``routers/vms.py`` 的 ``_op_connection`` 同一口径）。

    归属 ref 形如 ``<连接>:<节点>:<vmid>``，这里必须给出**真实**的连接 id ——
    不能用 :func:`_connection_scope` 里的 ``"-"`` 占位，那个是缓存 key 用的。
    """
    return requested_connection() or str(store.get_active_connection_id() or "")


@router.get("/dashboard/summary")
async def dashboard_summary(
    # 总览页同时统计虚拟机与容器，也是登录后的默认落地页：任一类查看权限即可
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.view", "ct.view")
    ),
) -> Dict[str, Any]:
    """集群总览。节点数据直接取自 ``cluster/resources`` —— 它本来就带 node 行，
    不必再单独调一次 ``/nodes``（这正是这个接口「聚合」的意义）。
    """

    async def _build() -> Dict[str, Any]:
        client = get_client()

        try:
            resources, version = await asyncio.gather(
                client.cluster_resources(),
                client.version(),
            )
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=exc.status_code if exc.status_code < 600 else 500,
                detail=exc.message,
            ) from exc

        resources = resources or []
        # 节点行本来就在 /cluster/resources 里（无 type 过滤时它返回 node / qemu /
        # lxc / storage 全部），所以正常情况下不必再单独调一次 /nodes。
        nodes = [item for item in resources if item.get("type") == "node"]
        if not nodes:
            # 兼容：少数 PVE 版本的 cluster/resources 不带 node 行 —— 这时回落单独
            # 查一次，保证「集群节点」卡片在任何版本都有数据。
            try:
                nodes = await client.nodes() or []
            except ProxmoxError:
                nodes = []

        vms = [r for r in resources if r.get("type") == "qemu"]
        containers = [r for r in resources if r.get("type") == "lxc"]
        storages = [r for r in resources if r.get("type") == "storage"]

        running = [v for v in vms if v.get("status") == "running"]
        stopped = [v for v in vms if v.get("status") == "stopped"]
        templates = [v for v in vms if pve_flag(v.get("template", 0)) == 1]

        # Aggregate node capacity and current usage.
        total_cpu = sum(n.get("maxcpu") or 0 for n in nodes)
        used_cpu = sum((n.get("cpu") or 0) * (n.get("maxcpu") or 0) for n in nodes)
        total_mem = sum(n.get("maxmem") or 0 for n in nodes)
        used_mem = sum(n.get("mem") or 0 for n in nodes)
        total_disk = sum(n.get("maxdisk") or 0 for n in nodes)
        used_disk = sum(n.get("disk") or 0 for n in nodes)

        # Storage is reported per node, so dedupe shared storages by name.
        storage_map: Dict[str, Dict[str, Any]] = {}
        for item in storages:
            name = item.get("storage")
            if not name:
                continue
            normalized = normalize_storage(item, item.get("node"))
            existing = storage_map.get(name)
            if existing is None:
                storage_map[name] = normalized
            elif normalized.get("total") and not existing.get("total"):
                storage_map[name] = normalized

        storage_total = sum(s.get("total") or 0 for s in storage_map.values())
        storage_used = sum(s.get("used") or 0 for s in storage_map.values())

        # Recent tasks — reuse the fan-out helper, but never fail the dashboard
        # because one node is unreachable.
        recent_tasks: List[Dict[str, Any]] = []
        try:
            from ..formatters import normalize_task

            tasks = await client.tasks(limit=10)
            recent_tasks = [normalize_task(t) for t in tasks]
        except ProxmoxError:
            recent_tasks = []

        return {
            "version": {
                "pve": version.get("version"),
                "release": version.get("release"),
                "panel": __version__,
            },
            "vms": {
                "total": len(vms),
                "running": len(running),
                "stopped": len(stopped),
                "templates": len(templates),
                "other": len(vms) - len(running) - len(stopped),
            },
            "containers": {"total": len(containers)},
            "nodes": {
                "total": len(nodes),
                "online": sum(1 for n in nodes if n.get("status") == "online"),
                "offline": sum(1 for n in nodes if n.get("status") != "online"),
                "cpu_total": total_cpu,
                "cpu_used": round(used_cpu, 2),
                "cpu_usage": round(used_cpu / total_cpu, 4) if total_cpu else 0,
                "mem_total": total_mem,
                "mem_used": used_mem,
                "mem_usage": round(used_mem / total_mem, 4) if total_mem else 0,
                "disk_total": total_disk,
                "disk_used": used_disk,
                "disk_usage": round(used_disk / total_disk, 4) if total_disk else 0,
                "detail": [
                    {
                        "node": n.get("node"),
                        "status": n.get("status"),
                        "cpu": n.get("cpu"),
                        "maxcpu": n.get("maxcpu"),
                        "mem": n.get("mem"),
                        "maxmem": n.get("maxmem"),
                        "disk": n.get("disk"),
                        "maxdisk": n.get("maxdisk"),
                        "uptime": n.get("uptime"),
                    }
                    for n in nodes
                ],
            },
            "storage": {
                "total": storage_total,
                "used": storage_used,
                "avail": max(storage_total - storage_used, 0),
                "usage": round(storage_used / storage_total, 4) if storage_total else 0,
                "count": len(storage_map),
            },
            "recent_tasks": recent_tasks,
        }

    return await pvecache.cached(
        f"dashboard:summary:{_connection_scope()}", DASHBOARD_TTL, _build
    )


@router.get("/dashboard/top")
async def dashboard_top(
    limit: int = 5,
    # 榜单同样是跨类型的（虚拟机 + 容器），任一类查看权限即可
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.view", "ct.view")
    ),
) -> Dict[str, Any]:
    """The busiest VMs by CPU and memory, for the dashboard leaderboards."""

    # 用户隔离：普通用户只看自己名下的机器（与 /vms 列表同一套归属口径）。
    # 这个接口原先直接返回集群全量 —— 普通用户在仪表盘上就能读到别人机器的
    # 名字与占用，顺着 node/vmid 还能摸到详情接口。管理员是超管视角（scope 为 None）。
    scope = security.visible_owner(user)

    async def _build() -> Dict[str, Any]:
        client = get_client()
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=exc.status_code if exc.status_code < 600 else 500,
                detail=exc.message,
            ) from exc

        running = [
            r for r in (resources or [])
            if r.get("type") == "qemu" and r.get("status") == "running"
        ]

        if scope is not None:
            owners = await ownership.owners_map_for(ownership.KIND_VM)
            conn = _owner_connection()
            running = [
                r
                for r in running
                if ownership.vm_owner_from(owners, r.get("node"), r.get("vmid"), conn)
                == scope
            ]

        def entry(vm: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "node": vm.get("node"),
                "vmid": vm.get("vmid"),
                "name": vm.get("name") or f"VM {vm.get('vmid')}",
                "cpu": vm.get("cpu") or 0,
                "maxcpu": vm.get("maxcpu") or 1,
                "mem": vm.get("mem") or 0,
                "maxmem": vm.get("maxmem") or 1,
                "uptime": vm.get("uptime"),
            }

        by_cpu = sorted(running, key=lambda v: v.get("cpu") or 0, reverse=True)
        by_mem = sorted(
            running,
            key=lambda v: (v.get("mem") or 0) / max(v.get("maxmem") or 1, 1),
            reverse=True,
        )

        return {
            "by_cpu": [entry(v) for v in by_cpu[:limit]],
            "by_memory": [entry(v) for v in by_mem[:limit]],
            "total_running": len(running),
        }

    # 缓存必须按**用户**分档：这个进程内缓存原先只按连接分 key，管理员那份
    # （不过滤）与普通用户那份（过滤后）会互相命中 —— 谁先请求，下一个人就读到
    # 对方的数据，隔离等于白做。
    key = f"dashboard:top:{limit}:{_connection_scope()}:{scope or '-'}"
    return await pvecache.cached(key, DASHBOARD_TTL, _build)


# 时间窗 → 回溯天数。本地历史保留期默认 30 天，year 自然只能给出保留期内的点 ——
# 对「按当前增速还有多少天写满」这个判断来说没有影响（越近的斜率越有代表性）。
CAPACITY_WINDOW_DAYS = {"week": 7, "month": 30, "year": 365}


def _predict(
    points: List[Tuple[int, float]],
    capacity: float,
    source: str,
) -> Dict[str, Any]:
    """最小二乘线性外推：x = 距最早点的天数，y = 集群已用字节。

    ``source`` 标明数据来自面板自己的历史（``history``）还是当场拉的 PVE
    rrddata（``pve``），便于排查「为什么这次的曲线起点不一样」。
    """
    if len(points) < 2 or capacity <= 0:
        return {
            "total_bytes": capacity,
            "history": [],
            "current_used": points[-1][1] if points else 0.0,
            "daily_rate_bytes": None,
            "days_to_full": None,
            "method": "linear",
            "source": source,
        }

    t0 = points[0][0]
    xs = [(t - t0) / 86_400.0 for t, _ in points]
    ys = [y for _, y in points]
    n = len(xs)
    sx = sum(xs)
    sy = sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    slope = (n * sxy - sx * sy) / denom if denom != 0 else 0.0

    current_used = ys[-1]
    days_to_full = None
    if slope > 0 and current_used < capacity:
        days_to_full = (capacity - current_used) / slope

    return {
        "total_bytes": capacity,
        "history": [{"time": t, "used": y} for t, y in points],
        "current_used": current_used,
        "daily_rate_bytes": slope,
        "days_to_full": days_to_full,
        "method": "linear",
        "source": source,
    }


@router.get("/dashboard/capacity")
async def dashboard_capacity(
    timeframe: str = Query(default="month", pattern="^(week|month|year)$"),
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """容量趋势与满容预测。

    优先读面板自己落库的监控历史（``metrics_history``，见 :mod:`app.metrics`）：
    把每个时刻各节点根分区已用量求和，拼成集群已用量的时间线，再用最小二乘做
    线性外推，估算按当前增速还有多少天写满。

    历史点还不够（刚部署、或保留期内的覆盖不足）时**回落到 PVE 的 rrddata 现算**，
    保证这个卡片在任何阶段都有数据。PVE 各版本 rrddata 字段不一致：8.x 给的是
    rootused / roottotal（根分区），老版本则是 disk / maxdisk。这里优先取
    rootused，缺失时回落 disk。容量取每个节点根分区总量（roottotal，没有则回落
    maxdisk）之和——根分区正是 /var/lib/vz、备份、ISO、日志落盘的地方，写满就会
    让服务直接异常。
    """

    async def _build() -> Dict[str, Any]:
        start_ts = int(time.time()) - CAPACITY_WINDOW_DAYS.get(timeframe, 30) * 86_400

        try:
            local = await metrics.capacity_series(start_ts)
        except Exception:  # noqa: BLE001 - 历史表不可读时不能拖垮容量卡片
            logger.exception("读取本地监控历史失败，回落到 PVE rrddata")
            local = {"points": [], "total": 0.0}

        if len(local["points"]) >= 2 and local["total"] > 0:
            return _predict(local["points"], local["total"], "history")

        series: Dict[int, float] = {}  # time -> 集群已用字节（跨节点求和）
        capacity = 0.0  # 当前集群根分区总容量（字节）

        for _profile, client in all_connection_clients():
            try:
                nodes = await client.nodes() or []
            except ProxmoxError:
                # 某一台 PVE 连不上只跳过它，不影响其它主机
                continue
            for n in nodes:
                name = n.get("node")
                if not name:
                    continue
                try:
                    rrd = await client.node_rrddata(name, timeframe) or []
                except ProxmoxError:
                    # 取不到历史时，至少把节点静态容量计入分母
                    capacity += n.get("maxdisk") or 0
                    continue
                if not rrd:
                    capacity += n.get("maxdisk") or 0
                    continue
                # 容量以该节点最后一条采样里的根分区总量为准（最稳定）
                last = rrd[-1]
                node_total = (
                    last.get("roottotal")
                    or last.get("maxdisk")
                    or n.get("maxdisk")
                    or 0
                )
                capacity += node_total
                for point in rrd:
                    t = point.get("time")
                    raw = point.get("rootused")
                    if raw is None:
                        raw = point.get("disk")
                    if isinstance(t, (int, float)) and isinstance(raw, (int, float)):
                        series[t] = series.get(t, 0.0) + raw

        # 最小二乘与空预测的判定都收在 _predict 里：历史通道与 PVE 回落通道
        # 用同一套算法，两条路径给出的天数口径才一致。
        return _predict(sorted(series.items()), capacity, "pve")

    # 这个接口遍历**所有**连接（不是当前请求那一台），所以 key 不带连接作用域
    return await pvecache.cached(f"dashboard:capacity:{timeframe}", CAPACITY_TTL, _build)
