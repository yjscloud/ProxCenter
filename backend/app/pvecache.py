"""PVE 只读数据的进程内短 TTL 缓存。

仪表盘 / 连接状态这类接口会被前端定时轮询，而它们每次都实时打 PVE
（``cluster/resources``、``nodes`` …）。同一批数据在一两秒内被多个标签页、多个人
重复拉取纯属浪费 —— 这里加一层很薄的 TTL 缓存削峰。

四条边界：

1. **key 由调用方给全**：连接作用域（``X-PVE-Connection``）等必须进 key，否则多台
   PVE 的数据会串号。凡结果随用户变的接口，用户 / 归属范围也必须进 key。
2. **TTL 只有几秒到几十秒**：它解决的是「同一时刻重复拉」，不是「拿旧数据糊弄人」。
   比这更需要新鲜度的接口（任务列表、控制台）不该走这里。
3. **并发去重**：同一 key 上并发时只允许一次真实请求，其余等锁后复用结果 ——
   否则「同时打开两个标签」等于把请求数翻倍。
4. **有界**：条目数上限 :data:`MAX_ENTRIES`，写入时顺手清掉过期项。这条是后来补
   的 —— 早先只有「同 key 覆盖」和 ``invalidate()`` 两种清理方式，一旦有按用户 /
   搜索词分档的动态 key（``/api/search``、按 owner 分档的列表），进程内存就只增
   不减。

缓存的生命周期与进程绑定：多 worker 部署时各持一份，命中率按 worker 摊薄，但
「N 次请求 → 1 次 PVE 调用」的收益仍然成立（与 :mod:`app.reportcache` 同一取舍）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

#: 条目上限。按「每个条目最多几百 KB」估，512 条足够覆盖几十个接口的并发轮询，
#: 同时给「按用户/查询词分档」的 key 留了余量而不至于把内存吃光。
MAX_ENTRIES = 512

#: key -> (写入时间, 写入时的 TTL, 值, 写入时的归属代际号)。
#: TTL 一并存下来，过期清理才有依据；代际号让「别的进程改了归属」也能让本条失效。
_cached: Dict[str, Tuple[float, float, Any, int]] = {}
#: key -> 正在计算时用的锁
_locks: Dict[str, asyncio.Lock] = {}

#: 归属代际号的来源（见 :func:`set_epoch_provider`）。``None`` = 不启用。
_epoch_provider: Optional[Callable[[], Awaitable[int]]] = None
#: 最近一次取到的代际号。``peek`` / ``age`` 是同步函数，只能拿它比对。
_last_epoch = 0


def set_epoch_provider(provider: Optional[Callable[[], Awaitable[int]]]) -> None:
    """注册「归属代际号」来源（启动时接上 :func:`app.ownership.generation`）。

    为什么需要：本缓存是**进程内**的。归属改派之后，写入方只能清掉自己进程里的
    条目；多 worker 部署下别的进程仍留着旧账，直到 TTL 到期 —— 表现出来就是
    「同一台机器，两个人看到的归属不一样」。代际号一变，所有进程的旧条目一起作废。

    取不到（没注册 / 读库失败）时按 0 处理，行为与从前完全一致。注销时把已记住的
    代际号一起归零 —— 否则拿它比对旧条目会得出「全部过期」的假象。
    """
    global _epoch_provider, _last_epoch
    _epoch_provider = provider
    if provider is None:
        _last_epoch = 0


async def _current_epoch() -> int:
    """当前归属代际号；取不到就沿用上一次的值（不能让读接口因它失败）。"""
    global _last_epoch
    if _epoch_provider is None:
        _last_epoch = 0
        return 0
    try:
        _last_epoch = int(await _epoch_provider())
    except Exception:  # noqa: BLE001 - 见 docstring
        return _last_epoch
    return _last_epoch


def _fresh(
    entry: Optional[Tuple[float, float, Any, int]], ttl: float, now: float, epoch: int
) -> bool:
    if entry is None:
        return False
    return now - entry[0] < ttl and entry[3] == epoch


def _store(key: str, ttl: float, value: Any, now: float, epoch: int) -> None:
    _cached[key] = (now, ttl, value, epoch)
    if len(_cached) <= MAX_ENTRIES:
        return
    # 先按各自 TTL 清过期项，仍然超限就淘汰最老的（近似 LRU 的写入时间序）。
    for stale in [
        k for k, (ts, item_ttl, _v, _epoch) in _cached.items() if now - ts >= item_ttl
    ]:
        _cached.pop(stale, None)
    if len(_cached) > MAX_ENTRIES:
        ordered = sorted(_cached.items(), key=lambda kv: kv[1][0])
        for stale, _entry in ordered[: len(_cached) - MAX_ENTRIES]:
            _cached.pop(stale, None)
    # 顺手清掉没有对应条目的锁，否则动态 key 会让 _locks 单独泄漏
    for stale in [k for k in _locks if k not in _cached]:
        _locks.pop(stale, None)


async def cached(
    key: str,
    ttl: float,
    factory: Callable[[], Awaitable[Any]],
    *,
    fresh: bool = False,
) -> Any:
    """取缓存值；过期或没有时调用 ``factory`` 并记下结果。

    ``factory`` 应当返回**最终响应体**（而不是原始的 PVE 数据结构）—— 缓存的是
    对象引用，把可变原始数据丢进来会被下游改动污染。

    ``fresh=True`` 表示调用方显式要求「绕过缓存重算」（对应路由上的
    ``?fresh=1``）：仍然会刷新缓存，这样紧跟其后的普通请求又能命中。
    """
    now = time.time()
    epoch = await _current_epoch()
    if not fresh:
        entry = _cached.get(key)
        if _fresh(entry, ttl, now, epoch):
            return entry[2]  # type: ignore[index]

    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()

    async with lock:
        if not fresh:
            now = time.time()
            entry = _cached.get(key)
            if _fresh(entry, ttl, now, epoch):
                return entry[2]  # type: ignore[index]
        value = await factory()
        _store(key, ttl, value, time.time(), epoch)
        return value


def peek(key: str, ttl: Optional[float] = None) -> Optional[Any]:
    """取缓存值（不触发计算）；``ttl`` 给了就顺带判过期。

    归属代际号变过的条目视为不存在：``peek`` 是同步函数，只能拿最近一次读到的
    代际号比对（见 :func:`set_epoch_provider`）。
    """
    hit = _cached.get(key)
    if hit is None or hit[3] != _last_epoch:
        return None
    if ttl is not None and time.time() - hit[0] >= ttl:
        return None
    return hit[2]


def age(key: str) -> Optional[float]:
    """条目已存在多少秒（没有则 ``None``）。给「数据截至 xx 秒前」用。

    代际号变过的条目同样返回 ``None``：它的内容已经不能算「现在的数据」。
    """
    hit = _cached.get(key)
    if hit is None or hit[3] != _last_epoch:
        return None
    return time.time() - hit[0]


def invalidate(prefix: str = "") -> None:
    """作废缓存：``prefix`` 为空清全部，否则只清以它开头的 key。"""
    if not prefix:
        _cached.clear()
        _locks.clear()
        return
    for key in [item for item in _cached if item.startswith(prefix)]:
        _cached.pop(key, None)
        _locks.pop(key, None)
