"""虚拟机 / 容器的创建时间（PVE 写进 config 的 ``meta``）。

PVE 的列表接口 ``/cluster/resources`` 里**没有**创建时间，config 里也没有独立的
``ctime`` 键（实测 PVE 8.4 / 9.2：config 键只有 agent / boot / cores / ... /
smbios1 / vmgenid 这些）。唯一的来源是 PVE 8 起在建机时写进 ``meta`` 的那串：

    meta: creation-qemu=9.2.0,ctime=1789814562

两条边界必须先讲清楚，否则这个字段会被当成审计时间用：

1. **克隆 / 恢复出来的机器会继承来源机器的 ``meta``** —— PVE 是整体复制 config，
   不是重写一份。实测本机三台机器（102 / 115 / 116）的 ``meta.ctime`` 是同一个
   秒（2026-09-19 18:42:42），而它们的 ``qmrestore`` 任务分别发生在三天后；
   反过来，两台 ``qmcreate`` 建的机器（106 / 107）的 ctime 与建机任务**精确到
   秒一致** —— 可见 ctime 是「创建那一刻」，但会被 clone / restore 带走。
   所以界面上按「创建时间」展示，但不能当审计依据，表头因此带了一句说明。
2. **PVE 8 之前建的机器没有 ``meta``**（实测本机 15 台 guest 里 9 台没有，
   容器一台都没有），这时只能给 ``None``，界面显示「—」。

第 2 条刻意**不去用任务日志凑**：``/cluster/tasks`` 只返回最近两天的窗口，
逐台查 ``/nodes/{node}/tasks?vmid=`` 又贵（每台一次请求）又可能早被日志轮转，
而且凑出来的「最早建机任务」极可能是一次 restore —— 一个错的日期比一个空值更糟。

取数要每台一次 config 请求，所以这里带一层进程内缓存。列表每 10 秒轮询一次，
缓存起来之后这个字段就是白送的：

* **取到值的条目永久有效** —— 创建时间不会变；
* **确认没有（``meta`` 缺失）的条目按 :data:`MISS_TTL_SECONDS` 过期** —— 之后
  可能被补上（从旧版 PVE 迁移过来、或用户手工改过 config），同时避免每轮轮询
  都去问一遍；
* **请求失败的条目按 :data:`ERROR_TTL_SECONDS` 过期** —— PVE 抖一下不该让这个
  日期消失 6 小时，也不该让每 10 秒一次的列表去反复戳一台已经不舒服的 PVE。

多 worker 部署时每个 worker 各持一份：代价是每个 worker 各请求一轮，收益是列表
请求本身不再为此变慢。和 :mod:`app.reportcache` 同一个取舍，理由也一样。
"""
from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .pve import ProxmoxClient, parallel

# 「确认没有 meta」与「这次没问到」的缓存时长（秒），理由见模块说明。
MISS_TTL_SECONDS = 6 * 3600.0
ERROR_TTL_SECONDS = 300.0

# 单次列表请求最多为多少台机器去读 config（每台一次请求）。超出的留到下一轮
# 轮询，列表 10 秒一次，很快就补齐 —— 冷启动时不能为了一个附加字段把几百台
# 机器的一次请求全压在一条响应里。
FETCH_BUDGET = 64

# ctime 的合理区间：2000-01-01 之前只能是解析出了别的数字；未来时间除了几天的
# 时钟偏差以外也当脏数据，免得界面出现「创建于 2087 年」。
MIN_TIMESTAMP = 946_684_800
_FUTURE_SLACK = 86_400

# key -> (过期时刻, 值)。值 None 表示「问过了，没有」。
_cache: Dict[str, Tuple[float, Optional[int]]] = {}


def cache_key(
    conn_id: Any, node: Any, vmid: Any, guest_type: Any
) -> str:
    """缓存键：连接 + 节点 + VMID + 类型。

    四段都不能省：多台 PVE 上可以有同名节点、同 VMID 的机器（实测本机
    pve-master 与 pve9 各有一个 vmid=100），少一段就会把别人家的创建时间
    显示到这台机器上。类型也要带 —— VMID 空间虽然共用，但读取的端点不同
    （``/qemu/`` 与 ``/lxc/``）。
    """
    return f"{conn_id or ''}|{node or ''}|{vmid or ''}|{guest_type or ''}"


def parse_created(config: Optional[Dict[str, Any]]) -> Optional[int]:
    """从 guest config 里取出创建时间（秒级 Unix 时间戳），取不到返回 ``None``。

    ``meta`` 是 PVE 的「属性字符串」：``creation-qemu=9.2.0,ctime=1789814562``
    （容器是 ``creation-lxc=...``）。只认 ``ctime`` 这个键 —— ``creation-qemu``
    是版本号不是时间，把它当时间解析会得到一串没意义的数字。
    """
    meta = (config or {}).get("meta")
    if not meta:
        return None
    for part in str(meta).split(","):
        name, _, value = part.partition("=")
        if name.strip() != "ctime":
            continue
        value = value.strip()
        if not value.isdigit():
            return None
        stamp = int(value)
        now = int(time.time())
        if stamp < MIN_TIMESTAMP or stamp > now + _FUTURE_SLACK:
            return None
        return stamp
    return None


def _entry(key: str) -> Optional[Tuple[float, Optional[int]]]:
    """取缓存条目，过期的顺手清掉（避免只增不减）。"""
    hit = _cache.get(key)
    if hit is None:
        return None
    if time.time() >= hit[0]:
        _cache.pop(key, None)
        return None
    return hit


def cached(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> Optional[int]:
    """缓存里现有的值；没有/已过期都返回 ``None``，且**不会**去请求 PVE。

    列表接口用它直接填初值 —— 命中时连一次 PVE 请求都不用发。
    """
    hit = _entry(cache_key(conn_id, node, vmid, guest_type))
    return hit[1] if hit else None


def clear() -> None:
    """清空缓存（测试与「连接被改动」时用）。"""
    _cache.clear()


async def _fetch(
    client: ProxmoxClient, group: List[Dict[str, Any]], key: str
) -> None:
    """为同一台机器读一次 config，结果写进缓存并写回 ``group`` 里的每个条目。

    ``group`` 里的条目按缓存键分组，node / vmid / type 必然相同（键就是它们拼
    出来的），所以只取第一个问 PVE、但值要写到**每一个**上 —— 同一次列表里
    同一台机器出现多次时，只给第一个赋值会让其余几行空着。
    """
    head = group[0]
    node, vmid, guest_type = head.get("node"), head.get("vmid"), head.get("type")
    try:
        if guest_type == "lxc":
            config = await client.lxc_config(node, vmid)
        else:
            config = await client.qemu_config(node, vmid)
    except Exception:  # noqa: BLE001 - 附加字段取不到，不该让整个列表请求失败
        _cache[key] = (time.time() + ERROR_TTL_SECONDS, None)
        return

    value = parse_created(config)
    if value is None:
        _cache[key] = (time.time() + MISS_TTL_SECONDS, None)
        return
    _cache[key] = (float("inf"), value)
    for item in group:
        item["created"] = value


async def fill(
    client: ProxmoxClient,
    items: Iterable[Dict[str, Any]],
    *,
    budget: int = FETCH_BUDGET,
    limit: int = 8,
) -> None:
    """就地为 ``items`` 补 ``created`` 字段（取不到的保持 ``None``）。

    只处理缓存里没有的条目，且一轮最多 ``budget`` 台（按机器去重后再数）。
    任何失败都只是「这一轮没有值」，绝不抛出 —— 它是列表的附加字段，
    不是列表的前提。
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for item in items:
        key = cache_key(
            item.get("connection_id"),
            item.get("node"),
            item.get("vmid"),
            item.get("type"),
        )
        groups.setdefault(key, []).append(item)

    pending: List[Tuple[str, List[Dict[str, Any]]]] = []
    for key, group in groups.items():
        hit = _entry(key)
        if hit is None:
            pending.append((key, group))
            continue
        # 命中值：整组都写上；「确认没有」的老条目：不重复问
        if hit[1] is not None:
            for item in group:
                item["created"] = hit[1]

    if not pending:
        return
    await parallel(
        (_fetch(client, group, key) for key, group in pending[:budget]), limit=limit
    )
