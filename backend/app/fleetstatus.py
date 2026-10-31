"""逐条 PVE 连接的合计状态（机队口径）。

面板把多条 PVE 连接当**同级**（没有「主连接」这个概念），所以任何「现在整体
怎么样」的读数，都得逐条探测再合起来看。

为什么单独成一个模块：这份探测有两个消费方 ——

* ``GET /api/cluster/fleet-status``（顶栏「控制台状态」、设置页、仪表盘的集群
  态势卡）；
* **集群仲裁巡检**（:mod:`app.quorumguard`）：哪套集群掉了仲裁就告警。

两边各写一遍必然走偏：告警判「失去仲裁」用的上游调用，必须与页面上显示的是
**同一份口径**，否则会出现「卡片红着、告警没响」这种最不该有的分歧。

逐条并发探测，单条失败只影响它自己；单机连接不去问 HA，省一次上游请求。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from . import pvecache
from .formatters import pve_flag
from .pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    parallel,
)

logger = logging.getLogger(__name__)

#: 单次机队探测的墙钟上限（秒）。一条连不上的 PVE 会让 httpx 卡到
#: ``HTTP_TIMEOUT``（默认 30 秒）—— 这个接口可以慢，但不能无限慢。
PANEL_FLEET_TIMEOUT = 8.0

#: 机队探测结果的缓存时长（秒）。探活是**真实请求**（每条连接 2~4 次），
#: 而顶栏与仪表盘都在按刷新间隔轮询它 —— 没有缓存时，用户把间隔调到 5 秒
#: 等于持续探测 PVE。30 秒与 ``/connections/status`` 取同一口径。
PANEL_FLEET_TTL = 30.0

#: 后台探测任务的引用。必须留住：``create_task`` 返回的对象一旦被回收，
#: 任务可能被取消（事件循环只保留弱引用）。
_probe_task: Any = None


def panel_fleet_key(can_manage: bool) -> str:
    """缓存 key。``can_manage`` 决定每条连接是否带主机地址，必须分开存。"""
    return f"panel:fleet:{'manage' if can_manage else 'view'}"


async def _probe(can_manage: bool) -> None:
    """真的跑一次探测并写缓存；失败只记日志（调用方拿到的是旧值 / None）。"""
    try:
        await asyncio.wait_for(
            pvecache.cached(
                panel_fleet_key(can_manage),
                PANEL_FLEET_TTL,
                lambda: collect(can_manage=can_manage),
            ),
            timeout=PANEL_FLEET_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logger.warning("机队状态探测超时（%.0fs）", PANEL_FLEET_TIMEOUT)
    except Exception:  # noqa: BLE001 - 探测失败不该拖垮调用方
        logger.warning("机队状态探测失败", exc_info=True)


async def panel_fleet(can_manage: bool) -> Optional[Dict[str, Any]]:
    """**阻塞**取机队状态（带缓存 + 超时）；失败返回 ``None``。

    给 ``/api/cluster/fleet-status`` 用 —— 那个端点天生就是「去探测一次」，
    可以等。``/api/health`` 不要用它，见 :func:`panel_fleet_cached`。
    """
    await _probe(can_manage)
    return pvecache.peek(panel_fleet_key(can_manage))


def panel_fleet_cached(can_manage: bool) -> Optional[Dict[str, Any]]:
    """**不阻塞**取机队状态：只读缓存，过期就在后台刷新。

    ``/api/health`` 是顶栏每 tick 都在等的请求，也是前端 ``pveReady`` 的门槛 ——
    让它去等一次 8 秒的探测，等于「一台 PVE 连不上，整站列表都不发请求」。
    所以这里只返回**当前已知值**（可能是过期几十秒的旧值，也可能还没有），
    同时把刷新丢给后台任务；缓存由 ``/cluster/fleet-status`` 与它共用，
    两边不会各探测一遍。
    """
    global _probe_task
    key = panel_fleet_key(can_manage)
    hit = pvecache.peek(key, PANEL_FLEET_TTL)
    if hit is not None:
        return hit

    if _probe_task is None or _probe_task.done():
        try:
            _probe_task = asyncio.get_running_loop().create_task(_probe(can_manage))
        except RuntimeError:  # pragma: no cover - 没有事件循环（脚本 / 测试外调用）
            _probe_task = None

    # 过期但仍有值：先给旧的，「上一轮的数字」远好过「这一块整片消失」
    return pvecache.peek(key)


def active_connection() -> Dict[str, str]:
    """默认读取的那一套 PVE（id + 展示名）。

    面板把多条 PVE 连接当同级；但少数接口（``/health``、``/cluster/status``）
    一次只能读一台，需要一个确定目标。那个目标由管理员在「设置 → 系统信息」里
    指定 —— 这里把它一并返回，否则多连接部署下「这个数字是哪一台的」没人答得
    上来。
    """
    try:
        from .store import get_active_connection_id, get_connections

        cid = str(get_active_connection_id() or "")
        for profile in get_connections():
            if str(profile.get("id") or "") == cid:
                return {"id": cid, "name": connection_label(profile)}
    except Exception:  # noqa: BLE001 - 拿不到名字不影响主数据
        pass
    return {"id": "", "name": ""}


async def probe(profile: Dict[str, Any], client: Any) -> Dict[str, Any]:
    """探测一条连接：可达性 / 版本 / 节点数 / 仲裁 / HA。

    ``can_manage`` 由调用方决定是否把主机地址带出去（调用 :func:`collect`）。
    """
    item: Dict[str, Any] = {
        "id": str(profile.get("id") or ""),
        "name": connection_label(profile),
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


async def collect(*, can_manage: bool = False) -> Dict[str, Any]:
    """探测全部已保存连接，返回 ``{connections, totals, default_connection}``。

    ``can_manage`` 为真时每条连接额外带上主机地址：这个接口有 ``node.view``
    就能访问，而它会把每条连接的主机列出来 —— 连接配置属于管理信息，与
    ``/connections`` 同一口径。
    """
    pairs = all_connection_clients()

    async def one(profile: Dict[str, Any], client: Any) -> Dict[str, Any]:
        item = await probe(profile, client)
        if can_manage:
            item["host"] = str(profile.get("host") or "")
        return item

    items = await parallel([one(profile, client) for profile, client in pairs])
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
        "default_connection": active_connection(),
    }
