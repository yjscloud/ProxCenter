"""全平台巡检报告的内存缓存（「端口与进程」「安全基线」共用）。

这两页的「全平台总览」不是读一份现成数据，而是**现场巡检**：对每台主机新建
一条 SSH、跑一条合并的探测命令（单条最坏 45 秒超时），一轮下来几秒到几十秒。
而这一页会被反复打开 —— 同一个人来回切页面、几个人同时看、按 F5 刷新、
开两个标签 —— 每次都重跑整轮纯属浪费，于是这里放一层很薄的 TTL 缓存。

三条边界：

1. **key = 功能名 + 可见主机集合**，不是全局，也不是只有一个维度：

   * 功能名（``"ports"`` / ``"baseline"``）分开两份 —— 两个功能共用这一个模块
     的缓存，键里不带功能名就会串号：端口的总览落进基线的键里，基线取
     ``totals['fail']`` 直接 KeyError。
   * 可见主机集合：管理员（``None`` = 不限）与每个普通用户各自一个 key，不会
     把别人那几台主机的报告发出去。空集合（一个都不可见）与 ``None`` 必须
     分开 —— 前者是「什么都没有」，后者是「全部」。
2. **TTL 只有 2 分钟**，比前端的 staleTime（5 分钟）短：前端超过 5 分钟再来问，
   这里基本已经过期、会真扫一轮。缓存要解决的是「同一时刻别重复扫」，
   而不是「拿旧数据糊弄人」；报告本身的采集时间由 ``generated_at`` 如实回给前端。
3. **写操作要清缓存**：改巡检策略、处置 / 撤销、加固之后判定口径已经变了，
   再发旧报告就是自相矛盾。调用方在这些地方显式 :func:`clear`。

多 worker 部署时每个 worker 各持一份，命中率按 worker 摊薄，但「N 次打开 →
1 次巡检」的收益仍然成立。真要做跨进程共享得落到数据库或 Redis，对一块自建
面板不值当 —— 巡检本身也不适合被缓存太久。
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Dict, FrozenSet, Iterable, Optional, Tuple

# 缓存有效期（秒）。比前端 staleTime 短，理由见模块说明第 2 条。
TTL_SECONDS = 120.0

# key -> (写入时间, 报告)；key -> 正在巡检时用的锁
_cache: Dict[Any, Tuple[float, Any]] = {}
_locks: Dict[Any, asyncio.Lock] = {}


def scope_key(
    namespace: str,
    host_ids: Optional[Iterable[str]],
) -> Tuple[str, Optional[FrozenSet[str]]]:
    """把「哪个功能 + 可见主机集合」归一成可哈希的缓存 key。

    两点都不能省：

    * ``namespace``（``"ports"`` / ``"baseline"``）—— 两个功能共用这一份缓存，
      键里不带功能名就会互相串号：端口的总览落进基线的键里，基线取
      ``totals['fail']`` 直接 KeyError，反过来则是把端口数据当体检结果显示出来。
    * ``None``（管理员不限）与空集合（一个都不可见）必须区分：混起来就是越权。
    """
    if host_ids is None:
        return (namespace, None)
    return (namespace, frozenset(str(item) for item in host_ids))


ScopeKey = Tuple[str, Optional[FrozenSet[str]]]


def peek(key: ScopeKey) -> Optional[Any]:
    """取未过期的缓存；没有（或已过期）返回 ``None``。"""
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < TTL_SECONDS:
        return hit[1]
    if hit:
        # 过期条目顺手清掉，别让它一直占着内存
        _cache.pop(key, None)
    return None


def store(key: ScopeKey, payload: Any) -> None:
    """记下一轮巡检的结果。"""
    _cache[key] = (time.time(), payload)


async def get_or_scan(
    key: ScopeKey,
    produce: Callable[[], Awaitable[Any]],
) -> Tuple[Any, bool]:
    """命中缓存就直接返回 ``(报告, True)``；否则真扫一轮再返回 ``(报告, False)``。

    同一 key 上并发时只允许一轮巡检：后来的请求等这把锁，拿到锁后先再瞄一眼
    缓存（等锁期间先到的那位可能已经扫完了）。两个人同时打开这一页，不该让
    每台主机各开两条 SSH。
    """
    hit = peek(key)
    if hit is not None:
        return hit, True

    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()

    async with lock:
        hit = peek(key)
        if hit is not None:
            return hit, True
        payload = await produce()
        store(key, payload)
        return payload, False


def clear() -> None:
    """清空缓存：策略 / 处置 / 加固变了之后，旧报告的判定口径已经不对了。"""
    _cache.clear()
    _locks.clear()
