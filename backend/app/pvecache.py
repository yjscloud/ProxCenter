"""PVE 只读数据的进程内短 TTL 缓存。

仪表盘 / 连接状态这类接口会被前端定时轮询，而它们每次都实时打 PVE
（``cluster/resources``、``nodes`` …）。同一批数据在一两秒内被多个标签页、多个人
重复拉取纯属浪费 —— 这里加一层很薄的 TTL 缓存削峰。

三条边界：

1. **key 由调用方给全**：连接作用域（``X-PVE-Connection``）等必须进 key，否则多台
   PVE 的数据会串号。
2. **TTL 只有几秒到几十秒**：它解决的是「同一时刻重复拉」，不是「拿旧数据糊弄人」。
   比这更需要新鲜度的接口（任务列表、控制台）不该走这里。
3. **并发去重**：同一 key 上并发时只允许一次真实请求，其余等锁后复用结果 ——
   否则「同时打开两个标签」等于把请求数翻倍。

缓存的生命周期与进程绑定：多 worker 部署时各持一份，命中率按 worker 摊薄，但
「N 次请求 → 1 次 PVE 调用」的收益仍然成立（与 :mod:`app.reportcache` 同一取舍）。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

#: key -> (写入时间, 值)
_cached: Dict[str, Tuple[float, Any]] = {}
#: key -> 正在计算时用的锁
_locks: Dict[str, asyncio.Lock] = {}


async def cached(
    key: str,
    ttl: float,
    factory: Callable[[], Awaitable[Any]],
) -> Any:
    """取缓存值；过期或没有时调用 ``factory`` 并记下结果。

    ``factory`` 应当返回**最终响应体**（而不是原始的 PVE 数据结构）—— 缓存的是
    对象引用，把可变原始数据丢进来会被下游改动污染。
    """
    hit = _cached.get(key)
    if hit is not None and time.time() - hit[0] < ttl:
        return hit[1]

    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()

    async with lock:
        hit = _cached.get(key)
        if hit is not None and time.time() - hit[0] < ttl:
            return hit[1]
        value = await factory()
        _cached[key] = (time.time(), value)
        return value


def peek(key: str, ttl: Optional[float] = None) -> Optional[Any]:
    """取缓存值（不触发计算）；``ttl`` 给了就顺带判过期。"""
    hit = _cached.get(key)
    if hit is None:
        return None
    if ttl is not None and time.time() - hit[0] >= ttl:
        return None
    return hit[1]


def invalidate(prefix: str = "") -> None:
    """作废缓存：``prefix`` 为空清全部，否则只清以它开头的 key。"""
    if not prefix:
        _cached.clear()
        return
    for key in [item for item in _cached if item.startswith(prefix)]:
        _cached.pop(key, None)
