"""自助重置密码（忘记密码）的令牌管理。

流程
----
1. 用户在登录页点「忘记密码」，填**用户名**提交。
2. 面板给该账号绑定的邮箱发一封带一次性链接的邮件。
3. 用户点链接 → 校验令牌 → 设置新密码 → 令牌作废。

刻意的设计取舍
--------------
* **令牌只存哈希**。库里落的是 ``sha256(token)``，即使库被读走也换不来一条
  可用的重置链接 —— 令牌等价于密码，不能明文存。
* **一次性 + 30 分钟过期**。用过即删；改密成功后把该用户剩余令牌一并清掉，
  免得邮箱里还留着几条能用的旧链接。
* **账号不存在同样返回成功**（由调用方决定话术）。这是个**公开**接口，
  如果它对「用户名不存在」给出不同响应，就等于提供了一台账号枚举机。
* **待审批 / 已拒绝的账号不给重置** —— 它们本来就不该登录。
* **按 IP 限速**：和注册一样，避免被拿去刷邮件（SMTP 配额有限，且会连累
  注册审批通知一起发不出去）。
"""
from __future__ import annotations

import hashlib
import secrets
import time
from typing import Optional

from . import database, store

# 链接有效期：30 分钟。太长等于在邮箱里长期留一把钥匙，太短用户来不及点。
TOKEN_TTL = 30 * 60

# 任何一次改密都会把该用户所有令牌清掉，所以这里只需要一个「同一账号同时存在几条」
# 的上限，防止反复请求把表撑大。
MAX_ACTIVE_PER_USER = 5

SCHEMA = """
CREATE TABLE IF NOT EXISTS password_reset (
    token_hash VARCHAR(64)  NOT NULL,
    username   VARCHAR(64)  NOT NULL,
    created    DOUBLE       NOT NULL,
    expires    DOUBLE       NOT NULL,
    PRIMARY KEY (token_hash),
    KEY idx_reset_user (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def hash_token(token: str) -> str:
    """令牌 → 库里存的哈希。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _cleanup(bucket: dict) -> None:
    if len(bucket) > 512:
        for key in [k for k, v in bucket.items() if not v]:
            bucket.pop(key, None)


# ------------------------------------------------------------------ 签发
async def issue(username: str) -> Optional[tuple]:
    """为该账号签发一条重置令牌，返回 ``(原始令牌, 收件邮箱)``。

    邮箱一并返回，是因为发信时**收件人必须是邮箱而不是用户名**——
    把 ``test04`` 这种用户名当地址投给 SMTP，只会换来 501 Bad address syntax。

    拿不到令牌（账号不存在 / 未激活 / 没填邮箱 / 令牌太多）时返回 ``None``，
    调用方一律按「已发送」回应，不区分原因。
    """
    account = await store.get_user(username)
    if not account:
        return None
    if account.get("status", store.STATUS_ACTIVE) != store.STATUS_ACTIVE:
        return None
    if not account.get("enabled", True):
        return None
    if not str(account.get("email") or "").strip():
        # 没邮箱就没法送达，只能走管理员重置
        return None

    now = time.time()
    async with database.connect() as db:
        # 先清掉过期的，顺手限制同一账号的令牌数量
        await db.execute("DELETE FROM password_reset WHERE expires <= ?", (now,))
        cursor = await db.execute(
            "SELECT COUNT(*) FROM password_reset WHERE username = ?",
            (account["username"],),
        )
        row = await cursor.fetchone()
        if row and int(row[0]) >= MAX_ACTIVE_PER_USER:
            await db.commit()
            return None

        token = secrets.token_urlsafe(32)
        await db.execute(
            "INSERT INTO password_reset (token_hash, username, created, expires)"
            " VALUES (?, ?, ?, ?)",
            (hash_token(token), account["username"], now, now + TOKEN_TTL),
        )
        await db.commit()
    return token, str(account.get("email") or "").strip()


# ------------------------------------------------------------------ 校验
async def peek(token: str) -> Optional[str]:
    """令牌有效则返回用户名，**不作废**（用于打开页面时先确认链接没失效）。"""
    if not token:
        return None
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT username, expires FROM password_reset WHERE token_hash = ?",
            (hash_token(token),),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    username, expires = str(row[0]), float(row[1] or 0)
    if expires <= time.time():
        return None
    return username


async def redeem(token: str) -> Optional[str]:
    """校验并作废令牌，返回用户名。用过即删，一条链接只能用一次。"""
    username = await peek(token)
    if not username:
        return None
    async with database.connect() as db:
        await db.execute(
            "DELETE FROM password_reset WHERE token_hash = ?", (hash_token(token),)
        )
        await db.commit()
    return username


async def purge_user(username: str) -> None:
    """清掉该账号所有令牌：密码已经改了，旧链接不该还能用。"""
    async with database.connect() as db:
        await db.execute("DELETE FROM password_reset WHERE username = ?", (username,))
        await db.commit()
