"""Aggregated dashboard data.

The dashboard needs fleet-wide totals in one round trip. Fetching them here
(rather than making the browser run a dozen requests) keeps the UI fast and
lets us degrade gracefully when a node is offline.

两个接口都套了一层很短的进程内缓存（见 :mod:`app.pvecache`）：仪表盘是定时轮询的
页面，多个标签页 / 多个人同时看时，同一批数据在几秒内重复打 PVE 纯属浪费。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import metrics, ownership, pvecache, security, store
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    client_for_connection,
    get_client,
    parallel,
    requested_connection,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["dashboard"])


def _scope_pairs() -> List[Tuple[Dict[str, Any], Any]]:
    """本次请求要统计的连接。

    顶栏「集群作用域」聚焦某套集群时**只统计那一条** —— 榜单与容量预测都属于
    「资源」口径，应当和列表页看的是同一套（聚焦 A 集群却在榜单上看到 B 集群的
    机器，点进去还会跳到别的集群）。作用域为「全部集群」时才是全机队合并。

    作用域指向的连接已被删除时，``client_for_connection`` 会抛出与其它接口
    一致的 404，前端的选择器收到连接列表后也会自动回到「全部集群」。
    """
    scoped = requested_connection()
    if scoped:
        profile = next(
            (c for c in store.get_connections() if str(c.get("id")) == scoped), None
        )
        return [(profile or {}, client_for_connection(scoped))]
    pairs = all_connection_clients()
    return pairs or [({}, get_client())]

#: 只读集群数据的缓存时长（秒）。短到几乎不影响观感，又能把「同一时刻的重复拉取」
#: 合并成一次 PVE 请求。
DASHBOARD_TTL = 10.0


@router.get("/dashboard/summary")
async def dashboard_summary(
    # 手机数与榜单合在一起：仪表盘每 tick 原本要发 /vms、/lxc、/dashboard/top
    # 三条（普通用户还要再多一条），三份数据却来自同一批 cluster/resources。
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.view", "ct.view")
    ),
) -> Dict[str, Any]:
    """仪表盘首屏所需的**客户机口径**汇总：台数 + 资源占用 + 榜单。

    * 台数与占用：一次 ``collect_vms`` 算完，返回的是聚合计数值而不是整份列表
      —— 500 台机器时列表有 0.5–1.5 MB，仪表盘只用到几个计数；
    * 榜单：与 ``/dashboard/top`` 同一套排序（CPU 占用 / 内存占用率），
      但复用这次已经取到的列表，不再单独打一遍 ``cluster_resources``；
    * 权限：只看 ``vm.view`` / ``ct.view`` 里**实际持有**的那一类。此前前端
      用 ``/vms`` 取虚拟机、``/lxc`` 取容器，后端各有一道守卫；这里保持同一口径，
      只有 ``ct.view`` 的账号不会因为走了汇总接口就多看到虚拟机。
    """
    can_vm = security.has_user_permission(user, "vm.view")
    can_ct = security.has_user_permission(user, "ct.view")
    if can_vm and can_ct:
        guest_type = "all"
    elif can_vm:
        guest_type = "qemu"
    else:
        guest_type = "lxc"

    owner = security.visible_owner(user)
    viewer = str(user.get("username") or "") if owner is not None else "-"
    # 与 /dashboard/top 同一套分档：用户 + 连接作用域
    key = (
        f"dashboard:summary:{guest_type}:{requested_connection() or '-'}:"
        f"{owner or '-'}:{viewer}"
    )

    async def _build() -> Dict[str, Any]:
        # 局部 import：routers 之间互相引用会绕成环（vms 也依赖 pve/ownership）
        from .vms import collect_vms

        guests = await collect_vms(user=user, guest_type=guest_type, lightweight=True)
        real = [g for g in guests if not g.get("template")]
        qemu = [g for g in real if (g.get("type") or "qemu") == "qemu"]
        cts = [g for g in real if g.get("type") == "lxc"]

        def running(rows: List[Dict[str, Any]]) -> int:
            return sum(1 for g in rows if g.get("status") == "running")

        def stopped(rows: List[Dict[str, Any]]) -> int:
            return sum(1 for g in rows if g.get("status") == "stopped")

        vm_running = running(qemu)
        vm_stopped = stopped(qemu)

        total_cores = sum(int(g.get("maxcpu") or 0) for g in real)
        # PVE 的 cpu 是 0..1 的占用比例（相对该机器自己的 vCPU 数）——
        # 换算成「已用物理核数」要与 /dashboard/top 的口径一致
        used_cores = sum(
            float(g.get("cpu") or 0) * int(g.get("maxcpu") or 0) for g in real
        )

        running_qemu = [g for g in qemu if g.get("status") == "running"]

        def entry(g: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "node": g.get("node"),
                "vmid": g.get("vmid"),
                "name": g.get("name"),
                "cpu": g.get("cpu") or 0,
                "maxcpu": g.get("maxcpu") or 1,
                "mem": g.get("mem") or 0,
                "maxmem": g.get("maxmem") or 1,
                "uptime": g.get("uptime"),
                "connection_id": g.get("connection_id") or "",
            }

        by_cpu = sorted(
            running_qemu,
            key=lambda g: g.get("cpu") or 0,
            reverse=True,
        )[:8]
        by_mem = sorted(
            running_qemu,
            key=lambda g: (g.get("mem") or 0) / max(g.get("maxmem") or 1, 1),
            reverse=True,
        )[:8]

        return {
            "as_of": int(time.time()),
            "guests": {
                "total": len(real),
                "running": running(real),
                "stopped": sum(1 for g in real if g.get("status") == "stopped"),
                "vms": len(qemu),
                "cts": len(cts),
                "vm_running": vm_running,
                "ct_running": running(cts),
                "vm_stopped": vm_stopped,
                # 「其余状态」（paused / suspended / unknown）：资源分布卡按
                # 运行 / 停止 / 其他三档画环，别把暂停的机器并进「已停止」
                "vm_other": len(qemu) - vm_running - vm_stopped,
                "used_cores": round(used_cores, 3),
                "total_cores": total_cores,
                "used_mem": sum(int(g.get("mem") or 0) for g in real),
                "total_mem": sum(int(g.get("maxmem") or 0) for g in real),
                "used_disk": sum(int(g.get("disk") or 0) for g in real),
                "total_disk": sum(int(g.get("maxdisk") or 0) for g in real),
            },
            "top": {
                "by_cpu": [entry(g) for g in by_cpu],
                "by_memory": [entry(g) for g in by_mem],
                "total_running": len(running_qemu),
            },
        }

    return await pvecache.cached(key, DASHBOARD_TTL, _build)

#: 容量预测的缓存时长（秒）。它优先读本地历史（便宜），但历史不足时会逐节点拉
#: PVE 的 rrddata，那一步很重，缓存价值更高。
CAPACITY_TTL = 30.0


@router.get("/dashboard/top")
async def dashboard_top(
    limit: int = 5,
    # 榜单同样是跨类型的（虚拟机 + 容器），任一类查看权限即可
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.view", "ct.view")
    ),
) -> Dict[str, Any]:
    """The busiest VMs by CPU and memory, for the dashboard leaderboards.

    统计范围见 :func:`_scope_pairs`：顶栏作用域聚焦某套集群时只统计它，
    「全部集群」时合并全部连接。早先它只读兜底那一台（``get_client()``），
    多套 PVE 的部署里另外几套上跑满 CPU 的机器永远上不了榜。

    条目里带回 ``connection_id``：归属过滤要按各连接自己的 ref 前缀查，
    前端也要靠它把榜单条目链到正确的详情页。
    """
    # 用户隔离：普通用户只看自己名下的机器（与 /vms 列表同一套归属口径）。
    # 这个接口原先直接返回集群全量 —— 普通用户在仪表盘上就能读到别人机器的
    # 名字与占用，顺着 node/vmid 还能摸到详情接口。管理员是超管视角（owner 为 None）。
    owner = security.visible_owner(user)

    async def _build() -> Dict[str, Any]:
        pairs = _scope_pairs()
        results = await asyncio.gather(
            *(client.cluster_resources("vm") for _profile, client in pairs),
            return_exceptions=True,
        )

        running: List[Tuple[str, Dict[str, Any]]] = []
        failure: Optional[ProxmoxError] = None
        for (profile, _client), result in zip(pairs, results):
            if isinstance(result, BaseException):
                if isinstance(result, ProxmoxError):
                    # 某一台连不上只跳过它，不影响其它主机的榜单
                    failure = failure or result
                    continue
                # 非 PVE 异常（配置缺失、鉴权失败之类）保持向上冒泡，
                # 不要伪装成「榜单就是空的」
                raise result
            cid = str(profile.get("id") or "")
            for row in result or []:
                if row.get("type") == "qemu" and row.get("status") == "running":
                    running.append((cid, row))

        # 一台都没读到、且确有失败：把 PVE 的错误原样上报，
        # 否则界面会显示「暂无数据」，把「连不上」说成「没有忙碌的机器」
        if not running and failure is not None:
            raise HTTPException(
                status_code=failure.status_code if failure.status_code < 600 else 500,
                detail=failure.message,
            )

        if owner is not None:
            owners = await ownership.owners_map_for(ownership.KIND_VM)
            running = [
                (cid, row)
                for cid, row in running
                if ownership.vm_owner_from(owners, row.get("node"), row.get("vmid"), cid)
                == owner
            ]

        def entry(connection_id: str, vm: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "node": vm.get("node"),
                "vmid": vm.get("vmid"),
                "name": vm.get("name") or f"VM {vm.get('vmid')}",
                "cpu": vm.get("cpu") or 0,
                "maxcpu": vm.get("maxcpu") or 1,
                "mem": vm.get("mem") or 0,
                "maxmem": vm.get("maxmem") or 1,
                "uptime": vm.get("uptime"),
                "connection_id": connection_id,
            }

        by_cpu = sorted(running, key=lambda item: item[1].get("cpu") or 0, reverse=True)
        by_mem = sorted(
            running,
            key=lambda item: (item[1].get("mem") or 0)
            / max(item[1].get("maxmem") or 1, 1),
            reverse=True,
        )

        return {
            "by_cpu": [entry(cid, vm) for cid, vm in by_cpu[:limit]],
            "by_memory": [entry(cid, vm) for cid, vm in by_mem[:limit]],
            "total_running": len(running),
        }

    # 缓存按**用户** + **连接作用域**分档：
    #   * 用户 —— 这个进程内缓存原先只按连接分 key，管理员那份（不过滤）与普通用户
    #     那份（过滤后）会互相命中，谁先请求下一个人就读到对方的数据，隔离等于白做；
    #   * 连接作用域 —— 作用域变了统计范围就变了，不分开会把上一个作用域的结果
    #     直接喂给下一个（切回「全部集群」却还看到单集群的榜单）。
    key = f"dashboard:top:{limit}:{requested_connection() or '-'}:{owner or '-'}"
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

        # 这条回落通道是「历史点还不够」时才走的 —— 也就是刚部署、或刚清了历史。
        # 那时它同时是**首次打开仪表盘**的必经之路：原来按「连接 → 节点 → rrddata」
        # 三层串行，20 个节点就是 20 次往返排成一队。现在连接并发、rrd 采样并发，
        # 整块压到 1~2 个 RTT。
        pairs = list(_scope_pairs())
        node_lists = await parallel(
            (client.nodes() for _profile, client in pairs), limit=max(len(pairs), 1)
        )
        work: List[Tuple[Any, Dict[str, Any]]] = []  # (client, node)
        for (_profile, client), nodes in zip(pairs, node_lists):
            if isinstance(nodes, BaseException):
                # 某一台 PVE 连不上只跳过它，不影响其它主机
                continue
            for n in nodes or []:
                if n.get("node"):
                    work.append((client, n))

        rrd_list = await parallel(
            (client.node_rrddata(n.get("node"), timeframe) for client, n in work),
            limit=8,
        )
        for (_client, n), rrd in zip(work, rrd_list):
            name = n.get("node")
            if isinstance(rrd, BaseException):
                # 取不到历史时，至少把节点静态容量计入分母
                capacity += n.get("maxdisk") or 0
                continue
            rrd = rrd or []
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

    # 统计范围见 _scope_pairs（作用域聚焦时只算那一套），所以 key 必须带上它 ——
    # 否则切作用域会直接命中上一个范围的结果
    scope_key = requested_connection() or "-"
    return await pvecache.cached(
        f"dashboard:capacity:{timeframe}:{scope_key}", CAPACITY_TTL, _build
    )
