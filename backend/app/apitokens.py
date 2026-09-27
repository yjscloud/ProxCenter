"""面板侧个人 API Token：给脚本 / 外部系统用的长期凭据。

为什么需要它
------------
面板此前只有一种凭据：登录会话（JWT + ``refresh_tokens`` 里的 ``sid``）。它是
面向浏览器设计的 —— access token 分钟级过期、靠 refresh 轮换、撤销要连着
cookie 与 CSRF 一起走。拿它去对接外部系统（监控采集、CI 下发机器、Ansible）
很别扭：脚本得替人保管账号口令，还要定期重新登录一次。

于是给每个用户一份**可自助管理**的长期令牌：明文只在创建那一刻返回一次，
库里只留 SHA-256 摘要。

与登录会话的关系
----------------
令牌**不是**绕过权限的后门：它绑在某个用户上，每次请求都重新查该用户的角色 /
权限覆盖 / 审批状态 / 启用状态（与 :func:`security.get_current_user` 同一套
判定），所以管理员禁用账号或调整角色，令牌立刻跟着变 —— 不需要额外同步。

唯一的刻意差异是**敏感操作**：令牌拒绝所有 ``require_step_up`` 的接口（删机、
改连接凭据、SMTP 口令……）。二次确认的设计前提是「有个人坐在键盘前输口令」，
而长期令牌恰恰是无人在场的 —— 一枚泄漏的令牌若能直接删机器，就等于把
「不可逆操作必须有人确认」这条防线整个绕过去了。这类操作仍然只能从浏览器
会话里做（见 :func:`security.check_step_up`）。

库表说明
--------
* 只存 ``token_hash``（SHA-256）：令牌本身是高熵随机串（256 位），不需要
  bcrypt 那种抗暴力破解的慢哈希 —— 用慢哈希会让**每个** API 请求都白付几十
  毫秒。摘要即查找键，一次索引点查，被拖库也反推不出可用凭据。
* ``prefix`` 只是给人看的（形如 ``zp_a1b2c3d4``），用于在列表里认人；凭它
  无法通过校验（校验比的是完整哈希）。
* ``revoked`` 用软删除而非物理删除：留下「哪枚令牌被吊销过」的痕迹，配合审计
  日志才回答得了「这枚令牌现在到底还有没有效」。
* ``expires_at = 0`` 表示**永不**过期 —— 由创建者显式选择，界面上会给出提示。
* ``last_used`` 做写入节流（:data:`LAST_USED_THROTTLE`）：否则每次脚本调用都
  多一次 UPDATE，采集类高频对接会白白压着数据库。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from typing import Any, Dict, List, Optional, Tuple

from . import database

logger = logging.getLogger(__name__)

# 凭据前缀。刻意避开 JWT（永远是 eyJ 开头），get_current_user 才能一眼分流；
# 顺带让人在日志或脚本配置里看到 zp_xxx 就知道这是面板令牌，不是 PVE 的令牌。
PREFIX = "zp_"

# 256 位随机：即使令牌泄漏，也没有爆破空间。
_SECRET_BYTES = 32

# 展示用前缀长度（PREFIX + 8 位）。够认人，又远不够反推。
_PREFIX_SHOWN = len(PREFIX) + 8

NAME_MAX = 128

# last_used 写入节流（秒）：同一枚令牌在这个窗口内重复调用只更新一次。
LAST_USED_THROTTLE = 60.0

# 默认有效期（天）。0 = 永不 过期。界面上会把它作为默认选项。
DEFAULT_TTL_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_tokens (
    id         BIGINT       NOT NULL AUTO_INCREMENT,
    username   VARCHAR(64)  NOT NULL,
    name       VARCHAR(128) NOT NULL DEFAULT '',
    -- 明文只回一次，库里只留 SHA-256；同时充当查找键
    token_hash CHAR(64)     NOT NULL,
    -- 展示用前缀，形如 zp_a1b2c3d4，仅用于在列表里认出是哪一枚
    prefix     VARCHAR(24)  NOT NULL DEFAULT '',
    created    DOUBLE       NOT NULL,
    -- 0 = 永不过期（由创建者显式选择）
    expires_at DOUBLE       NOT NULL DEFAULT 0,
    last_used  DOUBLE       NOT NULL DEFAULT 0,
    last_ip    VARCHAR(64)  NOT NULL DEFAULT '',
    revoked    TINYINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uk_api_tokens_hash (token_hash),
    KEY idx_api_tokens_user (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# --------------------------------------------------------------------- 生成
def _hash(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def looks_like_token(value: str) -> bool:
    """判断一枚凭据是不是面板 API Token（而不是 JWT）。

    只看前缀、不查库：:func:`security.get_current_user` 要在**解密 JWT 之前**
    做这个分流，否则每枚令牌都会被当成坏 JWT 抛一次异常。
    """
    return bool(value) and value.startswith(PREFIX)


def generate() -> Tuple[str, str, str]:
    """生成一枚新令牌，返回 ``(明文, 摘要, 展示前缀)``。"""
    plain = PREFIX + secrets.token_urlsafe(_SECRET_BYTES)
    return plain, _hash(plain), plain[:_PREFIX_SHOWN]


def public(row: Dict[str, Any]) -> Dict[str, Any]:
    """给前端的视图：抹掉摘要，补一个「是否已过期」的现算字段。"""
    item = dict(row)
    item.pop("token_hash", None)
    expires_at = float(item.get("expires_at") or 0)
    item["expires_at"] = expires_at
    item["expired"] = bool(expires_at and expires_at <= time.time())
    item["revoked"] = bool(item.get("revoked"))
    return item


# --------------------------------------------------------------------- 写入
async def create(
    username: str,
    name: str = "",
    ttl_days: Optional[int] = None,
    ip: str = "",
) -> Dict[str, Any]:
    """创建一枚令牌，返回**含明文**的记录（此后明文只在库里以摘要形式存在）。

    ``ttl_days`` 为 ``None`` / ``0`` / 负数表示永不过期。
    """
    plain, token_hash, prefix = generate()
    created = time.time()
    expires_at = 0.0
    if ttl_days is not None and int(ttl_days) > 0:
        expires_at = created + int(ttl_days) * 86_400.0

    async with database.connect() as db:
        cursor = await db.execute(
            "INSERT INTO api_tokens"
            " (username, name, token_hash, prefix, created, expires_at, last_used,"
            "  last_ip, revoked)"
            " VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)",
            (
                username,
                (name or "")[:NAME_MAX],
                token_hash,
                prefix,
                created,
                expires_at,
                (ip or "")[:64],
            ),
        )
        token_id = int(cursor.lastrowid or 0)
        await db.commit()

    row = {
        "id": token_id,
        "username": username,
        "name": (name or "")[:NAME_MAX],
        "prefix": prefix,
        "created": created,
        "expires_at": expires_at,
        "last_used": 0.0,
        "last_ip": (ip or "")[:64],
        "revoked": 0,
    }
    out = public(row)
    # 唯一一次回传明文的机会，前端必须当场让用户复制走。
    out["token"] = plain
    return out


async def _touch(token_id: int, ip: str) -> None:
    async with database.connect() as db:
        await db.execute(
            "UPDATE api_tokens SET last_used = ?, last_ip = ? WHERE id = ?",
            (time.time(), (ip or "")[:64], token_id),
        )
        await db.commit()


async def revoke(token_id: int, username: Optional[str] = None) -> bool:
    """吊销一枚令牌。

    ``username`` 非空时同时作为归属条件（防越权吊销别人的令牌）；管理员传
    ``None`` 表示不限归属。已经吊销过的返回 False，让调用方能如实回一句
    「本来就已失效」，而不是假装成功。
    """
    conditions = ["id = ?", "revoked = 0"]
    params: List[Any] = [int(token_id)]
    if username:
        conditions.append("username = ?")
        params.append(username)

    async with database.connect() as db:
        cursor = await db.execute(
            f"UPDATE api_tokens SET revoked = 1 WHERE {' AND '.join(conditions)}",
            tuple(params),
        )
        await db.commit()
        return int(cursor.rowcount or 0) > 0


async def revoke_all(username: str) -> int:
    """吊销某人的全部令牌（改密码 / 删号 / 管理员踢下线时调用）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "UPDATE api_tokens SET revoked = 1 WHERE username = ? AND revoked = 0",
            (username,),
        )
        await db.commit()
        return int(cursor.rowcount or 0)


async def purge_expired(now: Optional[float] = None) -> int:
    """清掉早已过期且已吊销的行。保留仍未过期的（用户可能还想看到它）。

    过期超过 30 天、或吊销超过 30 天的记录才删 —— 列表页要能回答「我上个月
    删掉的那枚令牌去哪了」，太快清理反而像是凭空消失。
    """
    cutoff = float(now if now is not None else time.time()) - 30 * 86_400.0
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM api_tokens"
            " WHERE (expires_at > 0 AND expires_at < ?) OR (revoked = 1 AND created < ?)",
            (cutoff, cutoff),
        )
        await db.commit()
        return int(cursor.rowcount or 0)


# --------------------------------------------------------------------- 读取
async def list_for(username: str) -> List[Dict[str, Any]]:
    """列出某人的令牌（含已吊销 / 已过期的，交给前端置灰展示）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT id, username, name, prefix, created, expires_at, last_used,"
            "       last_ip, revoked"
            " FROM api_tokens WHERE username = ? ORDER BY created DESC LIMIT 100",
            (username,),
        )
        rows = await cursor.fetchall()
    return [public(dict(r)) for r in rows]


async def count_active(username: str) -> int:
    """某人当前**仍然可用**的令牌数（用于配额与界面提示）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM api_tokens"
            " WHERE username = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)",
            (username, time.time()),
        )
        (count,) = await cursor.fetchone()
    return int(count or 0)


async def authenticate(plain: str, ip: str = "") -> Optional[Dict[str, Any]]:
    """校验一枚令牌；有效则返回对应行（含 ``username``），否则返回 ``None``。

    调用方必须再走一遍用户状态判定（启用 / 审批 / 角色），本函数只回答
    「这枚令牌是不是真的、有没有过期、有没有被吊销」。
    """
    if not looks_like_token(plain):
        return None

    digest = _hash(plain)
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0",
            (digest,),
        )
        row = await cursor.fetchone()

    if not row:
        return None
    stored = str(row["token_hash"] or "")

    # 摘要即查找键，理论上命中的行必然相等；这里再比一次是纵深防御 ——
    # 万一将来改成模糊匹配或加了缓存，比较这一步不会跟着一起退化。
    if not hmac.compare_digest(stored, digest):
        return None

    expires_at = float(row["expires_at"] or 0)
    if expires_at and expires_at <= time.time():
        return None

    out = dict(row)
    # 节流：窗口内重复调用不写库。last_used 只用于展示，精度不重要。
    if time.time() - float(out.get("last_used") or 0) > LAST_USED_THROTTLE:
        try:
            await _touch(int(out["id"]), ip)
        except Exception:  # noqa: BLE001 - 打点失败不能连累鉴权
            logger.exception("更新 API Token 最后使用时间失败")
    return out
