"""基于 MySQL 的计数与限流。

面板只有 MySQL 这一个共享存储（不额外引入 Redis），所以「登录失败锁定」与
「全局限流」共用一张 ``rate_limits`` 表：

* ``bucket``         计数桶，形如 ``login:user:alice`` / ``api-auth:ip:1.2.3.4``
* ``window_start``   当前固定窗口的起点（unix 秒）
* ``count``          窗口内计数
* ``blocked_until``  锁定截止时间，0 表示未锁定

计数用**一条 UPSERT** 完成（MySQL 的 ``ON DUPLICATE KEY UPDATE`` 是原子的），
因此多进程/重启都不会把计数写丢——这是原来进程内 dict 限速做不到的。

故障策略：**数据库不可用时放行**。面板本来就离不开 MySQL（登录要先查 users），
DB 挂了的话认证查询自己会失败；这里再拒一次只会把一次故障放大成「所有人都
进不来」。真正的安全边界是用户查询与口令校验，不在这层。
"""
from __future__ import annotations

import logging
import time
from typing import Dict, Tuple

from . import database
from .config import settings

logger = logging.getLogger(__name__)

# 已锁定的桶缓存：挡住「明知被锁还反复来」的请求，省掉一次数据库往返。
# 只是加速手段，判断依据始终以数据库为准（多进程也一致）。
_blocked_cache: Dict[str, float] = {}
_BLOCKED_CACHE_TTL = 30.0


def _now() -> float:
    return time.time()


# ------------------------------------------------------------------ 基础原语
async def hit(bucket: str, window_seconds: int) -> Tuple[int, int]:
    """在当前窗口里给 ``bucket`` 记一次数。

    返回 ``(窗口内计数, 距离窗口重置的秒数)``。这里不加判断：是「超过上限就
    拒绝」（限流）还是「达到上限就锁定」（登录爆破），由调用方决定。
    """
    now = _now()
    start = now - window_seconds
    try:
        async with database.connect() as db:
            await db.execute(
                "INSERT INTO rate_limits (bucket, window_start, hits, blocked_until)"
                " VALUES (?, ?, 1, 0)"
                " ON DUPLICATE KEY UPDATE"
                "   hits = IF(window_start <= ?, 1, hits + 1),"
                "   window_start = IF(window_start <= ?, ?, window_start)",
                (bucket, now, start, start, now),
            )
            cursor = await db.execute(
                "SELECT hits, window_start FROM rate_limits WHERE bucket = ?",
                (bucket,),
            )
            row = await cursor.fetchone()
            await db.commit()
    except Exception as exc:  # noqa: BLE001 - 数据库故障时放行，见模块说明
        logger.warning("限流计数不可用（放行）：%s", exc)
        return 0, 0

    if not row:
        return 0, 0
    count = int(row["hits"] or 0)
    window_start = float(row["window_start"] or now)
    retry_after = max(1, int(window_start + window_seconds - now))
    return count, retry_after


async def blocked_for(bucket: str) -> int:
    """还有多少秒处于锁定状态；0 表示没锁。"""
    cached = _blocked_cache.get(bucket, 0.0)
    now = _now()
    if cached > now:
        return int(cached - now)

    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT blocked_until FROM rate_limits WHERE bucket = ?", (bucket,)
            )
            row = await cursor.fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.warning("锁定状态不可读（按未锁定处理）：%s", exc)
        return 0

    if not row:
        return 0
    until = float(row["blocked_until"] or 0)
    if until <= now:
        return 0
    _blocked_cache[bucket] = until
    return int(until - now)


async def block(bucket: str, seconds: int) -> None:
    """把 ``bucket`` 锁定若干秒（多次锁定取最晚的一次）。"""
    until = _now() + seconds
    _blocked_cache[bucket] = until
    try:
        async with database.connect() as db:
            await db.execute(
                "INSERT INTO rate_limits (bucket, window_start, hits, blocked_until)"
                " VALUES (?, ?, 0, ?)"
                " ON DUPLICATE KEY UPDATE blocked_until = GREATEST(blocked_until, ?)",
                (bucket, _now(), until, until),
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入锁定失败（本进程内仍生效）：%s", exc)


async def reset(bucket: str) -> None:
    """清掉一个桶（登录成功后清失败计数用）。"""
    _blocked_cache.pop(bucket, None)
    try:
        async with database.connect() as db:
            await db.execute("DELETE FROM rate_limits WHERE bucket = ?", (bucket,))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("清除计数失败：%s", exc)


async def allow(bucket: str, limit: int, window_seconds: int = 60) -> Tuple[bool, int]:
    """限流判断：被锁 → 直接拒；否则计数，窗口内超过 ``limit`` 即拒。

    返回 ``(是否放行, Retry-After 秒数)``。
    """
    locked = await blocked_for(bucket)
    if locked:
        return False, locked
    count, retry_after = await hit(bucket, window_seconds)
    return count <= limit, retry_after


async def cleanup(days: int = 7) -> None:
    """清掉长期不用的桶，避免这张表被扫描流量撑大。"""
    cutoff = _now() - days * 86400
    try:
        async with database.connect() as db:
            await db.execute(
                "DELETE FROM rate_limits WHERE blocked_until < ? AND window_start < ?",
                (cutoff, cutoff),
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("清理限流表失败：%s", exc)


# --------------------------------------------------------------- 登录失败锁定
def user_bucket(username: str) -> str:
    return f"login:user:{username.strip().lower()}"


def ip_bucket(ip: str) -> str:
    return f"login:ip:{ip or 'unknown'}"


async def login_locked(username: str, ip: str) -> int:
    """账号或其来源 IP 处于锁定期时返回剩余秒数（取两者较大值）。"""
    locked = 0
    for bucket in (user_bucket(username), ip_bucket(ip)):
        locked = max(locked, await blocked_for(bucket))
    return locked


async def login_failed(username: str, ip: str) -> int:
    """记一次登录失败；达到上限则锁定并返回锁定时长（秒，0 = 未锁）。

    账号维度和 IP 维度同时计数：前者挡「盯着一个账号猛试」，后者挡
    「换着用户名撒网」（同一 IP 打到上限一样会被锁）。
    """
    limit = max(1, int(settings.login_max_failures))
    window = max(60, int(settings.login_lockout_minutes) * 60)
    lock_seconds = window

    just_locked = 0
    for bucket in (user_bucket(username), ip_bucket(ip)):
        count, _ = await hit(bucket, window)
        # 第 limit 次失败就上锁：调用方的「第 N 次」与运维的直觉一致，
        # 也让锁定期内的下一次尝试直接吃 429。
        if count >= limit:
            await block(bucket, lock_seconds)
            just_locked = lock_seconds
    return just_locked


async def clear_login_failures(username: str, ip: str) -> None:
    """登录成功：清掉该账号与该 IP 的失败计数。"""
    for bucket in (user_bucket(username), ip_bucket(ip)):
        await reset(bucket)


def clear_cache() -> None:
    """丢弃进程内的锁定缓存。

    缓存只是「少查一次库」的加速手段，但它比数据库活得久：直接删掉/清空
    rate_limits 表（例如测试清库、运维手工解锁）之后，缓存里的锁定还在，
    会让人以为没生效。所以清库的一方要顺手调一下这里。
    """
    _blocked_cache.clear()
