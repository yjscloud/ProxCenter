"""信任设备：登录两步验证的「这台设备 7 天内免二次校验」。

为什么判定必须放在服务端
------------------------
如果信任状态由客户端 cookie 自己声明（例如 ``trusted=1``），那就等于把 2FA 的
开关交给了客户端 —— 谁都能写一个同名 cookie 自称可信。所以 cookie 里放的是一枚
**256 位随机口令**，真正的判定在服务端：口令的 SHA-256 摘要能在库里查到、还归属
同一个用户、且没过期，才算信任。明文只在签发那一次写进 cookie，与服务端只存摘要
（与 :mod:`app.apitokens` 同一套路）。

为什么单独一张表，而不是复用 ``refresh_tokens``
----------------------------------------------
两者的生命周期完全相反：

* 会话记录（``refresh_tokens``）随「退出登录 / 令牌轮换 / 踢下线」频繁增删，
  每 30 天还会被 ``purge_expired_tokens`` 清一轮；
* 信任设备要稳定地活满 7 天，且只在**换凭据**（改密码、开关 2FA）时整批作废。

混在一张表里，任何一次会话清理都会顺手把信任状态带走；反过来，只要不登出，
信任又可能被无限延长。分开之后，「信任」与「会话」各自只被该动它的地方动。

生命周期
--------
* 签发：``POST /api/auth/login/2fa`` 校验通过、且请求里勾了「信任设备」；
* 使用：``POST /api/auth/login`` 口令对、该用户开了 2FA、且命中未过期的信任记录
  → 跳过第二步直接签发会话（密码仍然必须正确，跳过的只是第二因子）；
* 作废：改密码 / 重置密码 / 退出所有设备 / 管理员踢下线（都走
  :func:`security.revoke_user_credentials`）、以及**开关两步验证**；
* 清理：过期行由调度作业 :func:`purge_expired` 清掉。
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time
from typing import Any, Dict, List, Optional, Tuple

from . import database

logger = logging.getLogger(__name__)

# 信任期（天）。登录页那句话里的「7 天」就是它 —— 两处要一起改。
TRUST_DAYS = 7

# 256 位随机。cookie 走的是明文，但即使被中间人读到，它能做的也只是「在这台
# 设备上少输一次动态码」，且改密码 / 关 2FA 立刻整批作废。
_SECRET_BYTES = 32

# last_used 写入节流（秒）：登录不是高频操作，这个窗口主要是防止脚本反复
# 提交密码时把每次尝试都写成一次 UPDATE。
LAST_USED_THROTTLE = 300.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS trusted_devices (
    id         BIGINT       NOT NULL AUTO_INCREMENT,
    username   VARCHAR(64)  NOT NULL,
    -- 只存 SHA-256；cookie 里的明文不回表
    token_hash CHAR(64)     NOT NULL,
    created    DOUBLE       NOT NULL,
    expires_at DOUBLE       NOT NULL,
    last_used  DOUBLE       NOT NULL DEFAULT 0,
    ip         VARCHAR(64)  NOT NULL DEFAULT '',
    user_agent VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    UNIQUE KEY uk_trusted_devices_hash (token_hash),
    KEY idx_trusted_devices_user (username),
    KEY idx_trusted_devices_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def _hash(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def generate() -> Tuple[str, str]:
    """生成一枚新口令，返回 ``(明文, 摘要)``。"""
    plain = secrets.token_urlsafe(_SECRET_BYTES)
    return plain, _hash(plain)


async def remember(
    username: str,
    ip: str = "",
    user_agent: str = "",
    days: int = TRUST_DAYS,
) -> Tuple[str, float]:
    """登记一台信任设备，返回 ``(明文口令, 到期时间)``。

    明文是唯一一次出现的地方，调用方必须立刻写进 HttpOnly cookie。

    ``days <= 0`` 时按 :data:`TRUST_DAYS` 处理：一个「立刻过期」的信任记录毫无
    意义，多半是调用方算错了参数，静默失败比落到一个 0 天的记录更好排查。
    """
    now = time.time()
    expires_at = now + (int(days) if int(days) > 0 else TRUST_DAYS) * 86_400.0
    plain, token_hash = generate()

    async with database.connect() as db:
        await db.execute(
            "INSERT INTO trusted_devices"
            " (username, token_hash, created, expires_at, last_used, ip, user_agent)"
            " VALUES (?, ?, ?, ?, 0, ?, ?)",
            (
                username,
                token_hash,
                now,
                expires_at,
                (ip or "")[:64],
                (user_agent or "")[:255],
            ),
        )
        await db.commit()
    return plain, expires_at


async def is_trusted(plain: Optional[str], username: str) -> bool:
    """这枚 cookie 是否代表 ``username`` 的一台仍被信任的设备。

    三个条件缺一不可：口令非空、摘要能查到、且归属同一个用户。
    **归属必须查** —— 否则 A 的 cookie 配上 B 的密码就能跳过 B 的第二步。
    """
    if not plain:
        return False

    now = time.time()
    token_hash = _hash(plain)
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT id, last_used FROM trusted_devices"
            " WHERE token_hash = ? AND username = ? AND expires_at > ?",
            (token_hash, username, now),
        )
        row = await cursor.fetchone()
        if not row:
            return False

        # last_used 只做节流更新：这是登录路径，不值得为每个请求多写一次库
        last_used = float(row[1] or 0)
        if now - last_used > LAST_USED_THROTTLE:
            await db.execute(
                "UPDATE trusted_devices SET last_used = ? WHERE id = ?",
                (now, int(row[0])),
            )
            await db.commit()
        return True


async def forget_all(username: str) -> int:
    """作废某人的全部信任设备（换凭据 / 开关两步验证时调用）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM trusted_devices WHERE username = ?", (username,)
        )
        await db.commit()
        return int(cursor.rowcount or 0)


async def list_for(username: str) -> List[Dict[str, Any]]:
    """列出仍有效的信任设备（不含口令，供排查与测试用）。"""
    now = time.time()
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT username, created, expires_at, last_used, ip, user_agent"
            " FROM trusted_devices WHERE username = ? AND expires_at > ?"
            " ORDER BY created DESC",
            (username, now),
        )
        rows = await cursor.fetchall()
    return [
        {
            "username": row[0],
            "created": float(row[1] or 0),
            "expires_at": float(row[2] or 0),
            "last_used": float(row[3] or 0),
            "ip": row[4],
            "user_agent": row[5],
        }
        for row in rows
    ]


async def purge_expired(now: Optional[float] = None) -> int:
    """清掉已过期的信任记录。

    与 API Token 的 30 天残留期不同，这里的行一旦过期就**没有任何保留价值**
    （它既不可用于登录，也不参与审计 —— 签发与使用都记在 audit_log 里），
    所以到期即删，不留等待窗口。
    """
    cutoff = float(now if now is not None else time.time())
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM trusted_devices WHERE expires_at <= ?", (cutoff,)
        )
        await db.commit()
        return int(cursor.rowcount or 0)
