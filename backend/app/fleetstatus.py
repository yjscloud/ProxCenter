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

import logging
from typing import Any, Dict

from .formatters import pve_flag
from .pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    parallel,
)

logger = logging.getLogger(__name__)


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
