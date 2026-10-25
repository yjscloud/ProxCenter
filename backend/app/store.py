"""Local persistence for panel users, audit log, and connection settings.

四张表：``users`` / ``roles`` / ``audit_log`` / ``settings``。数据库是 MySQL
（见 :mod:`app.database`），建表语句就写在本模块里。

Password hashing is delegated to ``passlib`` (bcrypt).
"""
from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from passlib.context import CryptContext

from . import crypto, database
from .config import (
    DATA_DIR,
    WEAK_ADMIN_PASSWORDS,
    is_weak_admin_password,
    settings,
)

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Connection-config keys that are safe to return to the frontend.
PUBLIC_CONN_KEYS = {
    "host",
    "port",
    "verify_ssl",
    "node_default",
    "region",
    "configured",
}

# 账号状态（users.status）。自助注册的账号先进 pending，管理员审批后才变 active。
# 与 enabled 分工不同：enabled 是管理员事后「停用」某人，status 管的是「有没有进过门」。
STATUS_ACTIVE = "active"
STATUS_PENDING = "pending"
STATUS_REJECTED = "rejected"
USER_STATUSES = (STATUS_ACTIVE, STATUS_PENDING, STATUS_REJECTED)

# 建表语句。主键 / 索引 / UNIQUE 涉及的列必须定长 VARCHAR（TEXT 做键要指定前缀
# 长度），需要默认值的列也用 VARCHAR —— MySQL 的 TEXT 不能带 DEFAULT。
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(32)  NOT NULL DEFAULT 'viewer',
    email         VARCHAR(255) DEFAULT '',
    enabled       TINYINT      NOT NULL DEFAULT 1,
    created       DOUBLE       NOT NULL,
    -- 注册审批状态，见 USER_STATUSES；存量账号一律 active
    status        VARCHAR(16)  NOT NULL DEFAULT 'active',
    -- 账号有效期（Unix 秒）。0 = 永不过期。
    expires_at    DOUBLE       NOT NULL DEFAULT 0,
    -- 已发送到的提醒档位（7 / 3 / 1 天，0 = 还没发过），见 app.userexpiry
    expiry_notice INT          NOT NULL DEFAULT 0,
    -- 到期冻结时间（Unix 秒）。非 0 = 已经关过机并踢下线，不再重复处理
    expiry_frozen DOUBLE       NOT NULL DEFAULT 0,
    -- 区域管理员可管理的区域名（JSON 数组，来自连接的 region 标签）。
    -- NULL / 空 = 不按区域限制；对 admin 无意义（admin 本来就是全平台视角）。
    regions       TEXT,
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 自定义角色：角色 = 一组权限的命名预设，admin 可增删改。
-- 内置角色沿用 admin/operator/viewer 三个 id，存量用户数据无需迁移。
CREATE TABLE IF NOT EXISTS roles (
    id          VARCHAR(64)  NOT NULL,
    name        VARCHAR(128) NOT NULL,
    description VARCHAR(255) DEFAULT '',
    permissions TEXT         NOT NULL,
    builtin     TINYINT      NOT NULL DEFAULT 0,
    created     DOUBLE       NOT NULL,
    -- 角色默认资源额度（JSON，字段见 app.quota 的 LIMIT_GROUPS）。
    -- TEXT 不能带 DEFAULT，所以允许 NULL：NULL = 这个角色没配默认额度，
    -- 用户级额度也没配时就是「不限制」。
    quota       TEXT,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
    id        BIGINT       NOT NULL AUTO_INCREMENT,
    timestamp DOUBLE       NOT NULL,
    username  VARCHAR(64)  NOT NULL,
    action    VARCHAR(64)  NOT NULL,
    target    VARCHAR(255) DEFAULT '',
    result    VARCHAR(32)  NOT NULL DEFAULT 'success',
    detail    TEXT,
    ip        VARCHAR(64)  DEFAULT '',
    -- target 归一化后的「目标机器」：取 `a -> b` 里的最后一段。
    -- 建机记录的 target 就是 `节点/VMID`，克隆 / 重装是 `来源 -> 节点/VMID`，
    -- 两种形态在这里统一。（另有一种只写到 VMID 的克隆记录，如 `... -> 104`：
    -- 它本来就不含节点名，归一化后同样对不上 —— 与改动前那条 LIKE 的行为一致。）
    -- TRIM 是为了消掉尾随空格带来的差异：原来 `target LIKE '%-> 节点/VMID'`
    -- 末尾没有锚定，`'… -> pve9/104 '` 也能命中，而 `SUBSTRING_INDEX` 会把它
    -- 原样带出来。
    -- 生成列由 MySQL 自己算，写入路径一行都不用改；建索引是为了让创建时间回填
    -- 能按机器直查 —— 原来那条 `target = ? OR target LIKE '%-> ?'` 用不上任何
    -- 索引，每台机器一次全表扫描，而它跑在虚拟机列表的首屏路径上。
    target_guest VARCHAR(255)
        GENERATED ALWAYS AS (SUBSTRING_INDEX(TRIM(target), ' -> ', -1)) VIRTUAL,
    PRIMARY KEY (id),
    KEY idx_audit_ts (timestamp DESC),
    KEY idx_audit_user (username),
    KEY idx_audit_action (action),
    KEY idx_audit_guest_time (target_guest, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
    `key` VARCHAR(128) NOT NULL,
    value TEXT         NOT NULL,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 计数/锁定：登录失败次数与全局限流共用（见 throttle.py）。
-- 落 MySQL 而不是进程内 dict：重启不清零、多进程也共享同一份计数。
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket        VARCHAR(191) NOT NULL,
    window_start  DOUBLE       NOT NULL DEFAULT 0,
    hits          INT          NOT NULL DEFAULT 0,
    blocked_until DOUBLE       NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket),
    KEY idx_rate_blocked (blocked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 服务端会话：每次登录取一个 refresh token，一行 = 一台设备。
-- access token 里带的是这里的 jti（sid），所以撤销一行 = 这台设备立刻下线：
-- 它同时充当了「会话列表」和「令牌黑名单」，不必再维护第二张表。
-- 成功登录过的来源 IP：用于「新 IP 登录」告警去重（见 app/loginalert.py）。
-- IPv6 按 /64 归一后再入库，避免隐私地址轮换导致每次登录都报警。
-- 主键用 (username, ip)，登录时 INSERT IGNORE 的 rowcount 就是「是否首次」。
CREATE TABLE IF NOT EXISTS login_ips (
    username   VARCHAR(64) NOT NULL,
    ip         VARCHAR(64) NOT NULL,
    first_seen DOUBLE      NOT NULL,
    last_seen  DOUBLE      NOT NULL,
    hits       INT         NOT NULL DEFAULT 1,
    PRIMARY KEY (username, ip),
    KEY idx_login_ips_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti            VARCHAR(64)  NOT NULL,
    username       VARCHAR(64)  NOT NULL,
    created        DOUBLE       NOT NULL,
    expires_at     DOUBLE       NOT NULL,
    ip             VARCHAR(64)  DEFAULT '',
    user_agent     VARCHAR(255) DEFAULT '',
    revoked        TINYINT      NOT NULL DEFAULT 0,
    -- 该会话最后一次「敏感操作二次确认」的到期时间（见 security.require_step_up）
    elevated_until DOUBLE       NOT NULL DEFAULT 0,
    PRIMARY KEY (jti),
    KEY idx_refresh_user (username),
    KEY idx_refresh_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 节点可见性（按连接 + 节点授权）。
--
-- 默认语义：**没有行 = 可见**，保持升级前的行为不变；管理员始终可见全部。
-- 想把某个节点藏起来（特殊项目专用机），写入一行 subject_type='*' /
-- subject='*' / allowed=0 —— 该节点从此对普通用户默认隐藏，再给需要的人
-- 写 subject_type='user' 或 'role' 的 allowed=1 行放开。
--
-- 取值优先级：user 行 > role 行 > 默认行（'*'/'*'）> 无行（可见）。
-- 用一张表而不是「受限节点表 + 白名单表」，是因为判定要按这个顺序短路，
-- 两张表反而要在代码里手工拼优先级，容易两处不一致。
CREATE TABLE IF NOT EXISTS node_scope (
    connection_id VARCHAR(64) NOT NULL DEFAULT '',
    node          VARCHAR(64) NOT NULL,
    subject_type  VARCHAR(8)  NOT NULL,
    subject       VARCHAR(64) NOT NULL,
    allowed       TINYINT     NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, node, subject_type, subject),
    KEY idx_node_scope_subject (subject_type, subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_db() -> None:
    """Create tables and bootstrap the initial admin account."""
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        # 旧库补列。每一列都必须能通过 DEFAULT 补齐，存量账号才不需要数据迁移：
        # permissions  用户级权限覆盖（空 = 继承角色权限）
        # status       注册审批状态，DEFAULT 'active' 让存量账号直接可用
        # token_version 会话版本号：+1 即让该用户所有已发出的 token 立刻失效
        # totp_*       两步验证（密钥用 crypto 加密后落库）
        columns = await database.table_columns(db, "users")
        for column, ddl in (
            ("permissions", "ALTER TABLE users ADD COLUMN permissions TEXT"),
            (
                "status",
                "ALTER TABLE users ADD COLUMN status VARCHAR(16) NOT NULL"
                " DEFAULT 'active'",
            ),
            (
                "token_version",
                "ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0",
            ),
            (
                "totp_secret",
                "ALTER TABLE users ADD COLUMN totp_secret VARCHAR(255) NOT NULL"
                " DEFAULT ''",
            ),
            (
                "totp_enabled",
                "ALTER TABLE users ADD COLUMN totp_enabled TINYINT NOT NULL DEFAULT 0",
            ),
            ("totp_recovery", "ALTER TABLE users ADD COLUMN totp_recovery TEXT"),
            # 账号有效期：expires_at 到期后由后台作业关机并冻结（见 app.userexpiry）；
            # 后两列是作业的幂等标记，避免重复发信 / 重复关机。
            (
                "expires_at",
                "ALTER TABLE users ADD COLUMN expires_at DOUBLE NOT NULL DEFAULT 0",
            ),
            (
                "expiry_notice",
                "ALTER TABLE users ADD COLUMN expiry_notice INT NOT NULL DEFAULT 0",
            ),
            (
                "expiry_frozen",
                "ALTER TABLE users ADD COLUMN expiry_frozen DOUBLE NOT NULL DEFAULT 0",
            ),
            # 区域管理员可管理的区域（JSON 数组）。NULL = 不按区域限制，存量账号
            # 无需迁移；这一列只对 role='region_admin' 的账号有实际作用。
            ("regions", "ALTER TABLE users ADD COLUMN regions TEXT"),
        ):
            if column not in columns:
                await db.execute(ddl)
        await db.commit()

        # 角色表补列：quota = 角色默认资源额度（JSON，见 app.quota）。
        # NULL = 未配置；用户级额度也没配时按「不限制」处理，存量角色无需迁移。
        role_columns = await database.table_columns(db, "roles")
        if "quota" not in role_columns:
            await db.execute("ALTER TABLE roles ADD COLUMN quota TEXT")
            await db.commit()

        # 审计表补列：target_guest = target 里的「那台机器」（取 `a -> b` 的最后
        # 一段）。创建时间回填要按 node/vmid 查克隆记录，而 target 有两种形态
        # （`pve9/100` 与 `pve9/100 -> pve9/104`），原先的 OR + 前置通配 LIKE
        # 用不上索引、每台机器一次全表扫描 —— 它跑在虚拟机列表的首屏路径上。
        # 用 VIRTUAL 而不是 STORED：加虚拟列是 INPLACE 的，不必重建整张表
        # （审计表动辄几十万行），代价只是读取那几列时现算一次。
        audit_columns = await database.table_columns(db, "audit_log")
        if "target_guest" not in audit_columns:
            try:
                await db.execute(
                    "ALTER TABLE audit_log ADD COLUMN target_guest VARCHAR(255)"
                    " GENERATED ALWAYS AS (SUBSTRING_INDEX(TRIM(target), ' -> ', -1))"
                    " VIRTUAL,"
                    " ADD KEY idx_audit_guest_time (target_guest, timestamp)"
                )
                await db.commit()
            except Exception:  # noqa: BLE001 - 迁移尽力而为，失败不影响主流程
                # 这条 DDL 带了生成列与索引，比单纯补一列更容易受 MySQL 版本 /
                # 权限影响。失败也不该让面板起不来：回填那条查询自己会退化成
                # 「查不到」（见 guest_created._backfill_from_audit 的 except），
                # 少的是「克隆机器的创建时间纠正」，不是功能。
                logger.warning(
                    "给 audit_log 补 target_guest 失败：创建时间回填会退化成查不到",
                    exc_info=True,
                )

        # 会话表补列：elevated_until = 该会话最后一次「二次确认」的到期时间
        # （敏感操作前要重输密码 / 动态码，见 security.require_step_up）。
        session_columns = await database.table_columns(db, "refresh_tokens")
        if "elevated_until" not in session_columns:
            await db.execute(
                "ALTER TABLE refresh_tokens ADD COLUMN elevated_until DOUBLE"
                " NOT NULL DEFAULT 0"
            )
            await db.commit()

        cursor = await db.execute("SELECT COUNT(*) FROM users")
        (count,) = await cursor.fetchone()
        if count == 0:
            # 只有这一次机会把口令写死进库里，之后再也改不到 —— 弱默认值在这里
            # 直接拒绝启动，逼运维先在 .env 配好（后面还有弱口令告警，但那要等
            # 数据库已经带着 admin123 跑起来了，等于没守住）。
            if is_weak_admin_password(settings.admin_password):
                message = (
                    "首次启动需要用 ADMIN_PASSWORD 创建管理员，但它仍是默认弱口令"
                    "（admin123 之类）或为空，已拒绝启动。请在 backend/.env 设置一个"
                    "至少 12 位的新口令后重启："
                    "python -c \"import secrets; print(secrets.token_urlsafe(16))\""
                )
                logger.error(message)
                raise RuntimeError(message)
            await db.execute(
                "INSERT INTO users (username, password_hash, role, email, enabled, created)"
                " VALUES (?, ?, 'admin', '', 1, ?)",
                (
                    settings.admin_username,
                    pwd_context.hash(settings.admin_password),
                    time.time(),
                ),
            )
            await db.commit()

    # 建表之后再补：把升级前明文落库的 PVE 密钥改成密文（见函数说明）
    await _encrypt_stored_connection_secrets()
    # 已有账号仍在用弱默认口令的话大声提醒（只告警：把线上后台直接下线并不更安全）
    await _warn_weak_admin_password()


async def _warn_weak_admin_password() -> None:
    """管理员密码仍是 ``admin123`` 之类弱默认值时，启动日志里给出醒目警告。

    走到这说明库里已经建好管理员了，硬拦会把线上后台一起拦掉；但必须有人
    在日志里看到它 —— 公网可达的面板 + 弱口令等于把 PVE 一并交出去。
    """
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT username, password_hash FROM users"
                " WHERE role = 'admin' ORDER BY id LIMIT 1"
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001 - 只是告警，绝不影响启动
        return
    if not row:
        return
    password_hash = str(row["password_hash"] or "")
    if not password_hash.startswith("$2"):  # 非 bcrypt（外部登录等）无从校验
        return
    for candidate in sorted(WEAK_ADMIN_PASSWORDS):
        try:
            if pwd_context.verify(candidate, password_hash):
                logger.warning(
                    "管理员 %s 的登录口令仍是弱默认值（%s 一类）。面板已在公网 8080/443 "
                    "可访问，请登录后立刻在「设置」里改掉口令，并把 backend/.env 的 "
                    "ADMIN_PASSWORD 换成随机值（它只影响全新安装时的首次建号）。",
                    row["username"],
                    candidate,
                )
                return
        except (TypeError, ValueError):
            return


def _row_to_user(row: database.Row) -> Dict[str, Any]:
    # 用户级权限覆盖：有值表示「完全按它来」，为空表示继承角色的权限。
    try:
        raw = row["permissions"]
    except (KeyError, IndexError):
        raw = None
    override: Optional[List[str]] = None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                override = [str(p) for p in parsed]
        except (ValueError, TypeError):
            override = None

    # status 是后补的列：万一拿到的是补列之前的行（或列缺失），按 active 兜底，
    # 不能让一个状态字段把整个用户列表打挂。
    try:
        status = row["status"] or STATUS_ACTIVE
    except (KeyError, IndexError):
        status = STATUS_ACTIVE
    if status not in USER_STATUSES:
        status = STATUS_ACTIVE

    # token_version 同样是后补的列，缺失时按 0 兜底（= 不校验版本，与旧库一致）。
    try:
        token_version = int(row["token_version"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        token_version = 0

    # totp_enabled 只在列表/详情里给「有没有开」这个事实；密钥本身不外泄。
    try:
        totp_enabled = bool(row["totp_enabled"])
    except (KeyError, IndexError):
        totp_enabled = False

    # 有效期三列同样是后补的：缺失时按「永不过期 / 没提醒过 / 没冻结」兜底。
    try:
        expires_at = float(row["expires_at"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        expires_at = 0.0
    try:
        expiry_notice = int(row["expiry_notice"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        expiry_notice = 0
    try:
        expiry_frozen = float(row["expiry_frozen"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        expiry_frozen = 0.0

    # 可管理区域（区域管理员用）：后补的列，缺失 / 非法 JSON 一律按「不限」兜底。
    try:
        raw_regions = row["regions"]
    except (KeyError, IndexError):
        raw_regions = None
    regions: List[str] = []
    if raw_regions:
        try:
            parsed_regions = json.loads(raw_regions)
            if isinstance(parsed_regions, list):
                regions = [str(r) for r in parsed_regions if str(r).strip()]
        except (ValueError, TypeError):
            regions = []

    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "email": row["email"] or "",
        "enabled": bool(row["enabled"]),
        "created": row["created"],
        "status": status,
        "permissions_override": override,
        "token_version": token_version,
        "totp_enabled": totp_enabled,
        "expires_at": expires_at,
        "expiry_notice": expiry_notice,
        "expiry_frozen": expiry_frozen,
        "regions": regions,
    }


# --------------------------------------------------------------------- roles
async def list_roles() -> List[Dict[str, Any]]:
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM roles ORDER BY builtin DESC, id")
        return [_row_to_role(row) for row in await cursor.fetchall()]


async def get_role(role_id: str) -> Optional[Dict[str, Any]]:
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM roles WHERE id = ?", (role_id,))
        row = await cursor.fetchone()
        return _row_to_role(row) if row else None


async def save_role(
    role_id: str,
    name: str,
    description: str,
    permissions: List[str],
    builtin: bool = False,
) -> Dict[str, Any]:
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "roles",
                ["id", "name", "description", "permissions", "builtin", "created"],
                ["id"],
                ["name", "description", "permissions"],
            ),
            (
                role_id,
                name,
                description,
                json.dumps(sorted(set(permissions))),
                1 if builtin else 0,
                time.time(),
            ),
        )
        await db.commit()
    found = await get_role(role_id)
    return found or {}


async def delete_role(role_id: str) -> bool:
    async with database.connect() as db:
        cursor = await db.execute("DELETE FROM roles WHERE id = ?", (role_id,))
        await db.commit()
        return cursor.rowcount > 0


async def count_users_with_role(role_id: str) -> int:
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM users WHERE role = ?", (role_id,)
        )
        (count,) = await cursor.fetchone()
        return int(count)


def _row_to_role(row: database.Row) -> Dict[str, Any]:
    try:
        perms = json.loads(row["permissions"] or "[]")
    except (ValueError, TypeError):
        perms = []
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "permissions": perms if isinstance(perms, list) else [],
        "builtin": bool(row["builtin"]),
    }


# --------------------------------------------------------------------- users
def _clean_regions(regions: Optional[List[str]]) -> List[str]:
    """区域名清洗：去空白、去重、保序。

    区域是连接上的自由文本标签，前后空格不一样就会「看起来配了、实际不匹配」，
    所以在这里统一收口 —— 写入与判定用的是同一个函数。
    """
    out: List[str] = []
    for item in regions or []:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text)
    return out


async def get_user(username: str) -> Optional[Dict[str, Any]]:
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = await cursor.fetchone()
        if not row:
            return None
        # 保留原始字段（login 需要 password_hash），同时补上规范化后的字段，
        # 其中 permissions_override 决定了该用户是否用自己的权限而非角色的。
        out = dict(row)
        out.update(_row_to_user(row))
        return out


async def list_users(status: Optional[str] = None) -> List[Dict[str, Any]]:
    """列出用户；``status`` 给定时只返回该审批状态的账号（审批队列用）。"""
    query = "SELECT * FROM users"
    params: tuple = ()
    if status:
        query += " WHERE status = ?"
        params = (status,)
    query += " ORDER BY id"
    async with database.connect() as db:
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        return [_row_to_user(r) for r in rows]


async def create_user(
    username: str,
    password: str,
    role: str = "viewer",
    email: str = "",
    permissions: Optional[List[str]] = None,
    status: str = STATUS_ACTIVE,
    expires_at: float = 0.0,
    regions: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """新建用户。

    ``permissions`` 为 None 表示继承角色权限；给定列表（含空列表）表示
    该用户的权限以这份列表为准，不再跟随角色变化。
    ``status`` 默认 active（管理员直接建号）；自助注册传 pending，
    等管理员审批后才允许登录。
    ``expires_at`` 是账号有效期（Unix 秒，0 = 永不过期），见 app.userexpiry。
    """
    if status not in USER_STATUSES:
        status = STATUS_ACTIVE
    expires = max(float(expires_at or 0), 0.0)
    clean_regions = _clean_regions(regions)
    async with database.connect() as db:
        cursor = await db.execute(
            "INSERT INTO users (username, password_hash, role, email, enabled,"
            " created, permissions, status, expires_at, regions)"
            " VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
            (
                username,
                pwd_context.hash(password),
                role,
                email,
                time.time(),
                json.dumps(sorted(set(permissions))) if permissions is not None else None,
                status,
                expires,
                json.dumps(clean_regions) if clean_regions else None,
            ),
        )
        await db.commit()
        new_id = cursor.lastrowid
    return {
        "id": new_id,
        "username": username,
        "role": role,
        "email": email,
        "enabled": True,
        "created": time.time(),
        "status": status,
        "permissions_override": permissions,
        "expires_at": expires,
        "expiry_notice": 0,
        "expiry_frozen": 0.0,
        "regions": clean_regions,
    }


async def update_user(
    username: str,
    *,
    role: Optional[str] = None,
    email: Optional[str] = None,
    enabled: Optional[bool] = None,
    password: Optional[str] = None,
    permissions: Optional[List[str]] = None,
    permissions_provided: bool = False,
    status: Optional[str] = None,
    expires_at: Optional[float] = None,
    regions: Optional[List[str]] = None,
    regions_provided: bool = False,
) -> Optional[Dict[str, Any]]:
    fields: List[str] = []
    values: List[Any] = []

    if expires_at is not None:
        # 有效期变了就把两个作业标记一起归零：新期限该重新走「提醒 / 冻结」，
        # 否则延长有效期后用户会一直停在已冻结状态、也收不到新一轮提醒。
        # 值没变时一个字都不写 —— 管理员只是改了个邮箱，不该重置提醒档位。
        current = await get_user(username)
        previous = float((current or {}).get("expires_at") or 0)
        expires = max(float(expires_at), 0.0)
        if current is not None and expires != previous:
            fields.extend(["expires_at = ?", "expiry_notice = 0", "expiry_frozen = 0"])
            values.append(expires)

    if status is not None:
        if status not in USER_STATUSES:
            raise ValueError(f"未知的账号状态：{status}")
        fields.append("status = ?")
        values.append(status)
    if permissions_provided:
        # None 表示清除覆盖、重新继承角色权限
        fields.append("permissions = ?")
        values.append(
            json.dumps(sorted(set(permissions))) if permissions is not None else None
        )
    if role is not None:
        fields.append("role = ?")
        values.append(role)
    if email is not None:
        fields.append("email = ?")
        values.append(email)
    if enabled is not None:
        fields.append("enabled = ?")
        values.append(1 if enabled else 0)
    if password:
        fields.append("password_hash = ?")
        values.append(pwd_context.hash(password))
    if regions_provided:
        # 空列表表示清空（= 恢复成「不按区域限制」）
        clean = _clean_regions(regions)
        fields.append("regions = ?")
        values.append(json.dumps(clean) if clean else None)

    if not fields:
        return await get_user(username)

    values.append(username)
    async with database.connect() as db:
        await db.execute(f"UPDATE users SET {', '.join(fields)} WHERE username = ?", values)
        await db.commit()
    return await get_user(username)


async def remember_login_ip(username: str, ip: str) -> bool:
    """记录一次成功登录的来源 IP，返回**是否首次**出现。

    去重靠主键 + ``INSERT IGNORE``：并发登录时只有一行能插入成功，也就只有
    一个请求会触发告警；其余请求走 UPDATE 刷新 last_seen。不用先 SELECT 再
    INSERT，省一次往返，也没有「查完再插」的竞态。
    """
    if not username or not ip:
        return False
    now = time.time()
    async with database.connect() as db:
        cursor = await db.execute(
            "INSERT IGNORE INTO login_ips (username, ip, first_seen, last_seen, hits)"
            " VALUES (?, ?, ?, ?, 1)",
            (username, ip, now, now),
        )
        first = cursor.rowcount > 0
        if not first:
            await db.execute(
                "UPDATE login_ips SET last_seen = ?, hits = hits + 1"
                " WHERE username = ? AND ip = ?",
                (now, username, ip),
            )
        await db.commit()
    return first


async def set_expiry_notice(username: str, stage: int) -> None:
    """记下「已经提醒到哪一档」（7 / 3 / 1 天），避免同一档重复发信。"""
    async with database.connect() as db:
        await db.execute(
            "UPDATE users SET expiry_notice = ? WHERE username = ?",
            (int(stage), username),
        )
        await db.commit()


async def set_expiry_frozen(username: str, when: float) -> None:
    """标记账号已到期冻结（关机 + 踢下线只做一次）。"""
    async with database.connect() as db:
        await db.execute(
            "UPDATE users SET expiry_frozen = ? WHERE username = ?",
            (float(when), username),
        )
        await db.commit()


async def delete_user(username: str) -> bool:
    async with database.connect() as db:
        cursor = await db.execute("DELETE FROM users WHERE username = ?", (username,))
        await db.commit()
        return cursor.rowcount > 0


async def count_admins() -> int:
    """还能真正登录的管理员数量（防呆判断用）。

    待审批 / 已拒绝的账号即使角色写着 admin 也进不了门，不能算进来，
    否则「最后一名管理员」的判断会被一个还没审批的账号撑住。
    """
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM users WHERE role = 'admin' AND enabled = 1"
            " AND status = ?",
            (STATUS_ACTIVE,),
        )
        (count,) = await cursor.fetchone()
        return int(count)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        return False


# --------------------------------------------------- 会话（refresh token）
async def register_refresh_token(
    jti: str,
    username: str,
    expires_at: float,
    ip: str = "",
    user_agent: str = "",
) -> None:
    """登记一个新会话（登录时调用）。一行 = 一台设备。"""
    async with database.connect() as db:
        await db.execute(
            "INSERT INTO refresh_tokens"
            " (jti, username, created, expires_at, ip, user_agent, revoked)"
            " VALUES (?, ?, ?, ?, ?, ?, 0)",
            (
                jti,
                username,
                time.time(),
                float(expires_at),
                (ip or "")[:64],
                (user_agent or "")[:255],
            ),
        )
        await db.commit()


async def get_refresh_token(jti: str) -> Optional[Dict[str, Any]]:
    """取一个会话；不存在 / 已撤销 / 已过期都返回 None。"""
    if not jti:
        return None
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT * FROM refresh_tokens WHERE jti = ?", (jti,)
        )
        row = await cursor.fetchone()
    if not row:
        return None
    out = dict(row)
    if out.get("revoked") or float(out.get("expires_at") or 0) <= time.time():
        return None
    return out


async def revoke_refresh_token(jti: str) -> bool:
    """撤销单个会话（单设备登出 / 刷新令牌轮换）。"""
    if not jti:
        return False
    async with database.connect() as db:
        cursor = await db.execute(
            "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?", (jti,)
        )
        await db.commit()
        return cursor.rowcount > 0


async def revoke_user_refresh_tokens(username: str) -> int:
    """撤销某人的全部会话（改密码 / 管理员踢下线 / 退出所有设备）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "UPDATE refresh_tokens SET revoked = 1 WHERE username = ? AND revoked = 0",
            (username,),
        )
        await db.commit()
        return int(cursor.rowcount or 0)


async def list_refresh_tokens(username: str) -> List[Dict[str, Any]]:
    """列出某人仍然有效的会话（个人中心「登录设备」）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT jti, created, expires_at, ip, user_agent FROM refresh_tokens"
            " WHERE username = ? AND revoked = 0 AND expires_at > ?"
            " ORDER BY created DESC LIMIT 50",
            (username, time.time()),
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def bump_token_version(username: str) -> int:
    """会话版本号 +1：该用户所有**已发出**的 access token 立刻失效。

    比黑名单省事的地方在于不用逐个登记 jti —— 一个 UPDATE 就完成「踢下线」，
    代价是只能整用户维度操作（单设备登出走 jti 黑名单，见 revoked_tokens）。
    """
    async with database.connect() as db:
        await db.execute(
            "UPDATE users SET token_version = token_version + 1 WHERE username = ?",
            (username,),
        )
        cursor = await db.execute(
            "SELECT token_version FROM users WHERE username = ?", (username,)
        )
        row = await cursor.fetchone()
        await db.commit()
    return int(row["token_version"]) if row else 0


async def mark_session_elevated(jti: str, seconds: int) -> float:
    """把会话标记为「刚刚二次确认过」，返回到期时间戳。

    敏感操作（删虚拟机、改连接凭据）前的重验证写在这里，窗口只有几分钟：
    即便 token 是从别处捡来的，攻击者没有密码 / 动态码也过不了这一关。
    """
    until = time.time() + max(0, int(seconds))
    async with database.connect() as db:
        await db.execute(
            "UPDATE refresh_tokens SET elevated_until = ? WHERE jti = ?",
            (until, jti),
        )
        await db.commit()
    return until


async def is_session_active(jti: str) -> bool:
    """这个会话是否仍然有效（未撤销、未过期）。

    认证依赖每次请求都会问一次：它是「登出 / 踢设备」立刻生效的依据。
    好在只是 refresh_tokens 的主键点查，索引一跳。
    """
    if not jti:
        return False
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT 1 FROM refresh_tokens WHERE jti = ? AND revoked = 0 AND expires_at > ?",
            (jti, time.time()),
        )
        row = await cursor.fetchone()
    return bool(row)


async def purge_expired_tokens() -> None:
    """清掉早已过期的会话记录。

    纯残留清理，失败也不影响启动，所以调用方不必处理异常。
    """
    async with database.connect() as db:
        await db.execute(
            "DELETE FROM refresh_tokens WHERE expires_at < ?",
            (time.time() - 30 * 86400,),
        )
        await db.commit()


# ------------------------------------------------------- 两步验证（TOTP）
async def set_totp(
    username: str,
    *,
    secret: Optional[str] = None,
    enabled: Optional[bool] = None,
    recovery: Optional[str] = None,
) -> None:
    """更新两步验证状态；``secret`` 传进来时应已是密文（见 crypto.encrypt）。"""
    fields: List[str] = []
    values: List[Any] = []
    if secret is not None:
        fields.append("totp_secret = ?")
        values.append(secret)
    if enabled is not None:
        fields.append("totp_enabled = ?")
        values.append(1 if enabled else 0)
    if recovery is not None:
        fields.append("totp_recovery = ?")
        values.append(recovery)
    if not fields:
        return
    values.append(username)
    async with database.connect() as db:
        await db.execute(f"UPDATE users SET {', '.join(fields)} WHERE username = ?", values)
        await db.commit()


# ----------------------------------------------------------------- audit log
async def add_audit(
    username: str,
    action: str,
    target: str = "",
    result: str = "success",
    detail: str = "",
    ip: str = "",
) -> None:
    if isinstance(detail, (dict, list)):
        detail = json.dumps(detail, ensure_ascii=False)
    async with database.connect() as db:
        await db.execute(
            "INSERT INTO audit_log (timestamp, username, action, target, result, detail, ip)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (time.time(), username, action, target, result, str(detail)[:4000], ip),
        )
        await db.commit()


def audit_filters(
    *,
    username: Optional[str] = None,
    action: Optional[str] = None,
    result: Optional[str] = None,
    start: Optional[float] = None,
    end: Optional[float] = None,
    search: Optional[str] = None,
) -> Tuple[List[str], List[Any]]:
    """构造审计日志的 WHERE 片段。

    列表页与导出处共用同一份：两边筛出来的必须是同一批记录，否则「界面上按
    「最近 24 小时」筛完导出却是全量」这种事就会在合规场景里出洋相。
    """
    where: List[str] = []
    params: List[Any] = []

    if username:
        where.append("username = ?")
        params.append(username)
    if action:
        where.append("action LIKE ?")
        params.append(f"%{action}%")
    if result:
        where.append("result = ?")
        params.append(result)
    if start is not None:
        where.append("timestamp >= ?")
        params.append(float(start))
    if end is not None:
        where.append("timestamp <= ?")
        params.append(float(end))
    if search:
        like = f"%{search}%"
        where.append(
            "(action LIKE ? OR target LIKE ? OR detail LIKE ?"
            " OR username LIKE ? OR ip LIKE ?)"
        )
        params.extend([like] * 5)
    return where, params


async def list_audit(
    limit: int = 100,
    offset: int = 0,
    username: Optional[str] = None,
    action: Optional[str] = None,
    result: Optional[str] = None,
    start: Optional[float] = None,
    end: Optional[float] = None,
    search: Optional[str] = None,
) -> Dict[str, Any]:
    where, params = audit_filters(
        username=username,
        action=action,
        result=result,
        start=start,
        end=end,
        search=search,
    )
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    async with database.connect() as db:
        cursor = await db.execute(
            f"SELECT COUNT(*) FROM audit_log {clause}", params
        )
        (total,) = await cursor.fetchone()

        cursor = await db.execute(
            f"SELECT * FROM audit_log {clause} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        )
        rows = await cursor.fetchall()

    return {
        "items": [dict(r) for r in rows],
        "total": int(total),
    }


async def stream_audit(
    *,
    batch: int = 2_000,
    username: Optional[str] = None,
    action: Optional[str] = None,
    result: Optional[str] = None,
    start: Optional[float] = None,
    end: Optional[float] = None,
    search: Optional[str] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """按键集分页流式读取审计日志（导出用），按时间倒序。

    ``id`` 是自增主键，与写入顺序一致，因此 ``ORDER BY id DESC`` 等价于按时间
    倒序，但可以配合 ``WHERE id < ?`` 做键集分页 —— 用 ``OFFSET`` 翻到第 20 万
    行时，MySQL 要先扫过前面全部记录，越翻越慢。

    每批单独借还一次连接：导出可能跑很久，整段占着池里的一条连接会在并发导出
    时把池耗光。
    """
    where, params = audit_filters(
        username=username,
        action=action,
        result=result,
        start=start,
        end=end,
        search=search,
    )
    # 从「最大的 id」开始，第一次迭代不带额外条件
    last_id = 2**63 - 1
    batch = max(1, int(batch))

    while True:
        clause = " AND ".join([*where, "id < ?"])
        async with database.connect() as db:
            cursor = await db.execute(
                f"SELECT * FROM audit_log WHERE {clause} ORDER BY id DESC LIMIT ?",
                [*params, last_id, batch],
            )
            rows = await cursor.fetchall()

        if not rows:
            return
        for row in rows:
            item = dict(row)
            last_id = int(item["id"])
            yield item
        if len(rows) < batch:
            return


# --------------------------------------------------------------- settings KV
async def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    # `key` / `value` 是 MySQL 关键字，靠反引号避免冲突
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT `value` FROM settings WHERE `key` = ?", (key,)
        )
        row = await cursor.fetchone()
        return row[0] if row else default


async def set_setting(key: str, value: str) -> None:
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql("settings", ["key", "value"], ["key"], ["value"]),
            (key, value),
        )
        await db.commit()


async def delete_setting(key: str) -> None:
    async with database.connect() as db:
        await db.execute("DELETE FROM settings WHERE `key` = ?", (key,))
        await db.commit()


CONNECTION_KEY = "pve_connection"        # 旧版单连接配置（保留用于迁移）
CONNECTIONS_KEY = "pve_connections"      # 多连接配置列表
ACTIVE_ID_KEY = "pve_active_id"          # 当前生效的连接 id

# 连接配置里的密钥字段。拿到 token_secret 就等于能以面板身份调 Proxmox API，
# console_password 能登进虚拟机控制台，明文躺在 settings 表里等于把 PVE 交出去。
# 加解密统一收口在本模块的读写边界（SMTP / 飞书 / 腾讯云 / SSH 是同一套 crypto），
# 业务层拿到的始终是明文，不需要知道自己存的是密文。
SECRET_CONN_FIELDS = ("token_secret", "console_password")


def _encrypt_secrets(conn: Dict[str, Any]) -> Dict[str, Any]:
    """返回密钥字段已加密的副本；空值与已加密值原样保留。"""
    out = dict(conn)
    for key in SECRET_CONN_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = crypto.encrypt(value)
    return out


def _decrypt_secrets(conn: Dict[str, Any]) -> Dict[str, Any]:
    """返回密钥字段已解密的副本。

    ``crypto.decrypt`` 对不带密文前缀的历史明文原样返回，所以升级前存的
    凭据照样能用（真正的明文改写见 :func:`_encrypt_stored_connection_secrets`）。
    """
    out = dict(conn)
    for key in SECRET_CONN_FIELDS:
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = crypto.decrypt(value)
    return out


def _encrypt_stored_json(raw: str) -> Optional[str]:
    """把一段落库的连接 JSON 里的明文密钥换成密文，返回改写后的 JSON。

    只有确实发生改写才返回内容，否则返回 ``None`` —— 调用方据此决定要不要
    写回，避免每次启动都重写一行（加密是随机 nonce，重写会让内容每次都变）。
    """
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None

    changed = False
    if isinstance(data, list):
        items = [_encrypt_secrets(d) if isinstance(d, dict) else d for d in data]
        changed = items != data
        data = items
    elif isinstance(data, dict):
        encrypted = _encrypt_secrets(data)
        changed = encrypted != data
        data = encrypted
    if not changed:
        return None
    return json.dumps(data, ensure_ascii=False)


async def _encrypt_stored_connection_secrets() -> None:
    """启动时把库里既有的明文 PVE 密钥改写成密文（执行一次）。

    加密只发生在写入路径，存量数据不补一次就永远明文躺在 ``settings`` 表里 ——
    这正是要修的问题。读取侧对明文/密文都兼容，所以迁移失败也只影响「是否已
    加密」，不影响连接可用性，因此这里吞掉异常、绝不挡住启动。
    """
    for key in (CONNECTIONS_KEY, CONNECTION_KEY):
        try:
            raw = await get_setting(key)
            updated = _encrypt_stored_json(raw) if raw else None
            if updated:
                await set_setting(key, updated)
                logger.info("已把 %s 里的明文 PVE 密钥改为密文存储", key)
        except Exception:  # noqa: BLE001 - 迁移尽力而为，失败不影响主流程
            logger.warning("迁移 %s 的 PVE 密钥失败", key, exc_info=True)


def _read_setting_raw(key: str) -> str:
    """Synchronous single-key read.

    Called from :func:`app.pve._load_connection`, which runs inside request
    handling where an extra event loop hop would be awkward. 具体连接方式交给
    :func:`app.database.read_setting_sync`（pymysql 同步连接），
    这里只负责把「读不到」统一成空串。
    """
    try:
        value = database.read_setting_sync(key)
    except Exception:  # noqa: BLE001 - 配置读不出来时退回默认值，不要影响请求
        logging.getLogger(__name__).warning("读取设置 %s 失败", key, exc_info=True)
        return ""
    return value or ""


def _read_json_dict(key: str) -> Dict[str, Any]:
    raw = _read_setting_raw(key)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def get_connections() -> List[Dict[str, Any]]:
    """所有已保存的 PVE 连接（含明文密钥，仅后端内部使用）。

    升级兼容：若还没有多连接列表、但存在旧的单份配置，则把它迁移成一个
    名为「默认连接」的 profile，避免用户需要重新填写。
    """
    raw = _read_setting_raw(CONNECTIONS_KEY)
    conns: List[Dict[str, Any]] = []
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = []
        if isinstance(data, list):
            conns = [_decrypt_secrets(d) for d in data if isinstance(d, dict)]
    if conns:
        return conns

    legacy = _decrypt_secrets(_read_json_dict(CONNECTION_KEY))
    if legacy.get("host"):
        return [{"id": "default", "name": legacy.get("host") or "默认连接", **legacy}]
    return []


def connection_region(connection_id: str) -> str:
    """该连接所属的区域名（连接 profile 上的 ``region`` 标签）。

    区域就是连接上的自由文本标签（多个连接可共用同一个区域名），不另建实体
    —— 这样升级不需要迁移任何连接配置。找不到连接时返回空串（视为「未分区」）。
    """
    if not connection_id:
        return ""
    for conn in get_connections():
        if str(conn.get("id") or "") == str(connection_id):
            return str(conn.get("region") or "").strip()
    return ""


def connection_regions() -> List[str]:
    """已配置的区域名（去重、排序），供用户管理页的「可管理区域」多选使用。"""
    seen: List[str] = []
    for conn in get_connections():
        region = str(conn.get("region") or "").strip()
        if region and region not in seen:
            seen.append(region)
    return sorted(seen)


def connection_ids() -> List[str]:
    """已保存连接的 id 列表（**不解密密钥**）。

    只用来判断「某个连接 id 还在不在」（兜底指针是否失效、作用域是否有效）。
    整份 profile 的解密不必出现在这种判断里 —— 它在每请求路径上会被调到若干次。
    """
    ids: List[str] = []
    raw = _read_setting_raw(CONNECTIONS_KEY)
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = []
        if isinstance(data, list):
            ids = [str(d.get("id") or "") for d in data if isinstance(d, dict)]
    if ids:
        return ids
    # 升级兼容：还没有多连接列表时，旧的单份配置就是唯一那条连接（见 get_connections）
    if _read_json_dict(CONNECTION_KEY).get("host"):
        return ["default"]
    return []


def get_active_connection_id() -> str:
    """「兜底读取」连接的 id，**保证是当前真实存在的连接**。

    存的 id 缺失或已指向被删掉的连接时，返回第一条连接的 id —— 与
    :func:`get_active_connection` 的兜底保持同一个答案。

    为什么必须自洽：调用点常拿这个 id 去拼归属 ref（``<连接>:<节点>:<vmid>``）或
    缓存 key。给出一个已删除的 id，归属记录会整片对不上（普通用户看到的列表直接
    变空），而两条路径给出不同答案更难排查。没有任何连接时返回空串。
    """
    ids = connection_ids()
    if not ids:
        return ""
    stored = _read_setting_raw(ACTIVE_ID_KEY)
    if stored and stored in ids:
        return stored
    return ids[0]


def get_active_connection() -> Dict[str, Any]:
    conns = get_connections()
    if not conns:
        return {}
    active_id = get_active_connection_id()
    for c in conns:
        if str(c.get("id")) == active_id:
            return c
    return conns[0]


def get_connection_config() -> Dict[str, Any]:
    """「兜底连接」的配置。

    ``pve.get_client`` 在请求既没带 ``X-PVE-Connection``、也无法按 node / vmid
    推断出连接时用它 —— 也就是「一次只能读一台」的那批接口（健康探活、
    集群版本 / 仲裁）。它不是「主集群」：多条连接一律同级，列表类接口默认
    遍历全部连接合并返回。
    """
    return dict(get_active_connection())


async def save_connections(connections: List[Dict[str, Any]]) -> None:
    """持久化连接列表；密钥字段落库前统一加密（读取侧见 :func:`get_connections`）。"""
    stored = [
        _encrypt_secrets(c) if isinstance(c, dict) else c for c in connections
    ]
    await set_setting(CONNECTIONS_KEY, json.dumps(stored, ensure_ascii=False))


async def set_active_connection(conn_id: str) -> None:
    await set_setting(ACTIVE_ID_KEY, conn_id)


async def save_connection_config(config: Dict[str, Any]) -> None:
    """更新「当前连接」的配置（兼容旧的单连接写入接口）。

    密钥字段留空 / ``__UNCHANGED__`` 表示保留原值。
    """
    conns = get_connections()
    cfg = {k: v for k, v in config.items() if v is not None}

    if not conns:
        profile = {"id": "default", "name": cfg.get("host") or "默认连接", **cfg}
        await save_connections([profile])
        await set_active_connection(str(profile["id"]))
        return

    active_id = str(get_active_connection().get("id") or conns[0].get("id"))
    updated: List[Dict[str, Any]] = []
    for c in conns:
        if str(c.get("id")) != active_id:
            updated.append(c)
            continue
        merged = {**c, **cfg}
        for secret_key in ("token_secret", "console_password"):
            value = config.get(secret_key)
            if value in (None, "", "__UNCHANGED__") and c.get(secret_key):
                merged[secret_key] = c[secret_key]
        if not merged.get("name"):
            merged["name"] = merged.get("host") or "默认连接"
        updated.append(merged)

    await save_connections(updated)


def public_connection_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Redact secrets so the frontend can render the settings form safely."""
    cfg = config if config is not None else get_connection_config()
    return {
        "id": str(cfg.get("id", "")),
        "name": str(cfg.get("name", "")),
        # 区域 / 机房：只用于界面分组（多机房时按区域 → 连接 → 节点展开）。
        # 老连接没有这个字段 → 空串 = 未分区。
        "region": str(cfg.get("region", "")),
        "host": cfg.get("host", ""),
        "port": int(cfg.get("port") or 8006),
        "token_id": cfg.get("token_id", ""),
        "token_secret_set": bool(cfg.get("token_secret")),
        "console_user": cfg.get("console_user", ""),
        "console_password_set": bool(cfg.get("console_password")),
        # 老连接没存过这个字段时，按环境配置的默认策略走（生产默认校验证书）
        "verify_ssl": bool(cfg.get("verify_ssl", settings.pve_verify_ssl)),
        # 钉扎用的证书 PEM（公开材料，不需要加密）
        "ca_cert": str(cfg.get("ca_cert") or ""),
        "node_default": cfg.get("node_default", ""),
        "configured": bool(
            cfg.get("host") and cfg.get("token_id") and cfg.get("token_secret")
        ),
    }


def public_connection_brief(config: Dict[str, Any]) -> Dict[str, Any]:
    """连接的**精简视图**：只有标识、名称与区域。

    普通用户也需要连接列表 —— 节点列表按「区域 → 连接 → 节点」分组、创建向导要
    选目标 PVE、地址池要按连接限定适用范围 —— 但这些只需要「认得出是哪台」，不
    需要它的地址、令牌或控制台凭据。

    连接配置描述的是「面板能碰哪些集群、拿什么凭据碰」，属于管理信息，不该跟着
    ``node.view`` 之类的权限扩散出去（裁剪点见 routers/config.list_connections）。
    """
    return {
        "id": str(config.get("id", "")),
        "name": str(config.get("name", "")),
        "region": str(config.get("region", "")),
        "configured": bool(
            config.get("host") and config.get("token_id") and config.get("token_secret")
        ),
    }


def new_secret() -> str:
    return secrets.token_urlsafe(32)


async def first_admin_username() -> str:
    """库里第一个管理员的用户名。

    监控与集成的配置按用户归属，没有归属的记录（升级前留下的全局配置）算作
    管理员的；取不到管理员时退回配置里的初始管理员账号。
    """
    try:
        users = await list_users()
    except Exception:  # noqa: BLE001 - 迁移尽力而为，失败不影响主流程
        users = []
    for user in users:
        if str(user.get("role") or "") == "admin":
            return str(user.get("username") or "")
    return str(settings.admin_username or "")


# --------------------------------------------------------------- node scope
async def list_node_scope() -> List[Dict[str, Any]]:
    """节点可见性授权全表（判定侧一次读全，避免逐节点查库）。

    表很小（只登记「受限节点」与它们的例外），一次全读比按节点查 N 次划算。
    """
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT connection_id, node, subject_type, subject, allowed"
            " FROM node_scope"
        )
        return [dict(row) for row in await cursor.fetchall()]


async def save_node_scope(
    connection_id: str,
    node: str,
    subject_type: str,
    subject: str,
    allowed: bool,
) -> None:
    """写入/覆盖一条节点授权（按主键 upsert）。"""
    async with database.connect() as db:
        await db.execute(
            "INSERT INTO node_scope"
            " (connection_id, node, subject_type, subject, allowed)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)",
            (
                str(connection_id or ""),
                str(node or ""),
                str(subject_type or ""),
                str(subject or ""),
                1 if allowed else 0,
            ),
        )
        await db.commit()


async def delete_node_scope(
    connection_id: str,
    node: str,
    subject_type: str = "",
    subject: str = "",
) -> int:
    """删除节点授权。不传 subject_type/subject 时清空该节点的全部例外。

    返回删除行数：界面据此区分「删掉了一条」与「本来就没有」。
    """
    where = ["connection_id = ?", "node = ?"]
    params: List[Any] = [str(connection_id or ""), str(node or "")]
    if subject_type and subject:
        where.extend(["subject_type = ?", "subject = ?"])
        params.extend([subject_type, subject])
    async with database.connect() as db:
        cursor = await db.execute(
            f"DELETE FROM node_scope WHERE {' AND '.join(where)}", params
        )
        await db.commit()
        return int(cursor.rowcount or 0)


# ------------------------------------------------------------------- cleanup
def ensure_data_dir() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR
