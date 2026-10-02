"""Panel authentication (JWT sessions) and role-based access control."""
from __future__ import annotations

import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import jwt
from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer

from .config import settings
from . import apitokens, i18n, store

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# 三种凭据都放在 HttpOnly Cookie 里：XSS 读不到（localStorage 是明文可读的），
# 改密码 / 踢下线也能立刻作废。Authorization 头仍然支持，供脚本与 API 客户端用。
#
#   panel_access   访问令牌，Path=/api（SPA 本体与静态资源不需要它）
#   panel_refresh  刷新令牌，Path=/api/auth
#   panel_csrf     CSRF 双提交令牌，**故意不加 HttpOnly** —— 前端 JS 必须能读到它，
#                  再把值回填到 X-CSRF-Token 请求头。攻击者站点读不到这枚 cookie，
#                  因此伪造不出这个头（SameSite=Lax 是第一道，这是第二道）。
ACCESS_COOKIE = "panel_access"
ACCESS_COOKIE_PATH = "/api"
REFRESH_COOKIE = "panel_refresh"
REFRESH_COOKIE_PATH = "/api/auth"
CSRF_COOKIE = "panel_csrf"
CSRF_COOKIE_PATH = "/"
CSRF_HEADER = "x-csrf-token"

# 角色要求两步验证但用户还没绑定（TOTP_REQUIRED_ROLES）时，只放行这些接口，
# 否则用户会被卡在「必须开 2FA」和「开不了 2FA」之间。
TOTP_SETUP_ALLOWED_PATHS = frozenset(
    {
        "/api/auth/2fa",
        "/api/auth/2fa/setup",
        "/api/auth/2fa/enable",
        "/api/auth/me",
        "/api/auth/my-permissions",
        "/api/auth/logout",
        "/api/auth/refresh",
    }
)

# --------------------------------------------------------------------- roles
# Fine-grained permissions granted to each panel role.
ROLE_PERMISSIONS: Dict[str, List[str]] = {
    "admin": ["*"],
    "operator": [
        "vm.view",
        "vm.power",
        "vm.console",
        "vm.snapshot",
        "vm.backup",
        "vm.create",
        "vm.clone",
        "vm.config",
        # 删除自己的虚拟机：范围由归属守卫保证（routers/vms.py 的
        # require_vm_access 只放行本人名下的机器），因此这里可以安全放开
        "vm.delete",
        "template.view",
        "template.clone",
        "storage.view",
        "network.view",
        # 防火墙：普通用户可以管自己名下虚拟机的规则；集群级（影响所有主机）
        # 留给了 firewall.cluster，默认只有管理员有
        "firewall.view",
        "firewall.manage",
        "node.view",
        "task.view",
        "frp.view",
        "frp.manage",
        "alert.view",
        "alert.manage",
        "cert.view",
        "cert.manage",
        # 应急隔离：operator 本来就能删除 / 关机自己名下的机器，却唯独不能
        # 隔离它 —— 真遇到疑似被入侵时反而无从下手。这里补上。
        "vm.isolate",
        # 注意：ssh.view / baseline.view / ports.view **不**在普通角色里。
        # 这三项读的是「面板本机 + SSH 受管主机」的主机级数据（登录爆破记录、
        # 基线评分、监听端口清单），而 ssh_hosts 表里没有「这台主机归谁」这个
        # 维度 —— 发给普通用户等于把宿主机信息全公开。要让用户自管主机，
        # 得先给受管主机加归属字段（见 docs / 讨论记录）。
    ],
    "viewer": [
        "vm.view",
        "template.view",
        "storage.view",
        "network.view",
        "firewall.view",
        "node.view",
        "task.view",
        "frp.view",
        "alert.view",
        "cert.view",
        # ssh.view / baseline.view / ports.view 是主机级数据，默认仅管理员，
        # 理由见 operator 段；普通用户需要时可由管理员在自定义角色里单独授予。
    ],
}

ROLE_DESCRIPTIONS: Dict[str, str] = {
    "admin": "超级管理员：可见并管理全部资源（不受用户隔离限制），可管理用户、连接配置与宿主机网络。",
    "operator": "普通用户：可创建、开关机、控制台、快照、备份、克隆，并删除「自己创建」的虚拟机；"
    "只能看到自己名下的虚拟机，不能管理用户、连接配置或宿主机网络。",
    "viewer": "只读用户：仅可查看自己名下的资源、监控与任务，不能执行任何变更操作。",
}


# 权限目录：供「创建用户 / 自定义角色」的勾选界面使用（按域分组 + 中文说明）。
# 这里必须与 ROLE_PERMISSIONS 及各处 require_permission() 用到的字符串完全一致，
# 否则界面上勾了却不生效。
PERMISSION_CATALOG: List[Dict[str, Any]] = [
    {
        "key": "vm",
        "label": "虚拟机",
        "permissions": [
            {"key": "vm.view", "label": "查看", "desc": "查看自己名下的虚拟机"},
            {"key": "vm.create", "label": "创建", "desc": "新建虚拟机"},
            {"key": "vm.delete", "label": "删除", "desc": "删除自己创建的虚拟机"},
            {"key": "vm.assign", "label": "指派归属", "desc": "把虚拟机指派给指定用户（含存量无主机）"},
            {"key": "vm.power", "label": "电源操作", "desc": "开机 / 关机 / 重启 / 挂起"},
            {"key": "vm.console", "label": "控制台", "desc": "打开 VNC 控制台"},
            {"key": "vm.config", "label": "修改配置", "desc": "改 CPU / 内存 / 磁盘 / 网卡 / 迁移"},
            {"key": "vm.snapshot", "label": "快照", "desc": "创建 / 回滚 / 删除快照"},
            {"key": "vm.backup", "label": "备份", "desc": "备份与恢复"},
            {"key": "vm.clone", "label": "克隆", "desc": "从模板或虚拟机克隆"},
            {
                "key": "vm.isolate",
                "label": "应急隔离",
                "desc": "一键隔离可疑虚拟机（取证快照 + 断网 + 关机）与解除隔离",
            },
        ],
    },
    {
        "key": "template",
        "label": "模板",
        "permissions": [
            {"key": "template.view", "label": "查看", "desc": "查看模板列表"},
            {"key": "template.clone", "label": "克隆模板", "desc": "用模板创建虚拟机"},
            {"key": "template.manage", "label": "管理模板", "desc": "制作 / 删除 / 导入模板"},
        ],
    },
    {
        "key": "storage",
        "label": "存储",
        "permissions": [
            {"key": "storage.view", "label": "查看", "desc": "查看存储池与内容"},
            {"key": "storage.manage", "label": "管理", "desc": "上传 ISO / 删除卷"},
        ],
    },
    {
        "key": "network",
        "label": "网络",
        "permissions": [
            {"key": "network.view", "label": "查看", "desc": "查看宿主机网络与虚拟机网卡"},
            {"key": "network.manage", "label": "管理", "desc": "改宿主机网桥 / 网卡"},
        ],
    },
    {
        "key": "firewall",
        "label": "防火墙",
        "permissions": [
            {"key": "firewall.view", "label": "查看", "desc": "查看集群 / 节点 / 虚拟机的防火墙规则、安全组与选项"},
            {"key": "firewall.manage", "label": "管理", "desc": "改自己名下虚拟机的规则、安全组规则与 IP 集合条目、下发模板"},
            {"key": "firewall.cluster", "label": "集群级", "desc": "改集群级规则与默认策略、建删安全组 / IP 集合（影响所有主机）"},
        ],
    },
    {
        "key": "node",
        "label": "节点",
        "permissions": [
            {"key": "node.view", "label": "查看", "desc": "查看节点状态与监控"},
        ],
    },
    {
        "key": "task",
        "label": "任务",
        "permissions": [
            {"key": "task.view", "label": "查看", "desc": "查看任务队列与日志"},
            {"key": "task.manage", "label": "管理", "desc": "取消 / 清理任务"},
        ],
    },
    {
        "key": "frp",
        "label": "内网穿透",
        "permissions": [
            {"key": "frp.view", "label": "查看", "desc": "查看穿透配置与日志"},
            {"key": "frp.manage", "label": "管理规则", "desc": "新增 / 修改自己的穿透规则"},
        ],
    },
    {
        "key": "alert",
        "label": "监控告警",
        "permissions": [
            {"key": "alert.view", "label": "查看", "desc": "查看自己的告警规则与历史"},
            {"key": "alert.manage", "label": "管理", "desc": "配置自己的规则与通知"},
        ],
    },
    {
        "key": "cert",
        "label": "证书",
        "permissions": [
            {"key": "cert.view", "label": "查看", "desc": "查看自己的证书与续期状态"},
            {"key": "cert.manage", "label": "管理", "desc": "申请 / 部署 / 续期自己的证书"},
        ],
    },
    {
        "key": "ssh",
        "label": "SSH 安全",
        "permissions": [
            {
                "key": "ssh.view",
                "label": "查看",
                "desc": "查看 SSH 登录失败统计与 fail2ban。默认仅管理员：面板本机与别人的受管主机都不对普通用户开放，授予后只看到自己添加的主机",
            },
            {"key": "ssh.manage", "label": "管理", "desc": "封禁 / 解封 IP、调整封禁与异常登录告警策略"},
        ],
    },
    {
        "key": "baseline",
        "label": "安全基线",
        "permissions": [
            {
                "key": "baseline.view",
                "label": "查看",
                "desc": "查看基线体检报告与评分。默认仅管理员：授予后普通用户只看到自己添加的主机，面板本机不开放",
            },
            {
                "key": "baseline.manage",
                "label": "加固",
                "desc": "一键修复 SSH / 内核参数 / 口令策略等基线项（改动面板所在主机）",
            },
        ],
    },
    {
        "key": "ports",
        "label": "端口与进程",
        "permissions": [
            {
                "key": "ports.view",
                "label": "查看",
                "desc": "查看监听端口与可疑进程清单。默认仅管理员：授予后普通用户只看到自己添加的主机，面板本机不开放",
            },
            {
                "key": "ports.manage",
                "label": "巡检",
                "desc": "配置巡检策略（预期端口 / 进程白名单）与立即巡检推送告警",
            },
        ],
    },
    {
        # 注：飞书机器人是全局单例，页面与接口都仅管理员可用，故不列入权限目录
        "key": "users",
        "label": "用户与角色",
        "permissions": [
            {"key": "users.view", "label": "查看", "desc": "查看用户与角色"},
            {"key": "users.manage", "label": "管理", "desc": "增删改用户与角色"},
        ],
    },
    {
        "key": "settings",
        "label": "系统设置",
        "permissions": [
            {"key": "settings.manage", "label": "管理", "desc": "Proxmox 连接配置、节点备注等"},
        ],
    },
    {
        "key": "audit",
        "label": "审计日志",
        "permissions": [
            {"key": "audit.view", "label": "查看", "desc": "查看操作审计日志"},
        ],
    },
]


BUILTIN_ROLE_NAMES = {
    "admin": "超级管理员",
    "operator": "普通用户",
    "viewer": "只读用户",
}

# 角色权限的进程内缓存。
# 角色定义放在数据库（roles 表，admin 可自定义），但权限校验散落在同步依赖里，
# 所以这里保留一份缓存；任何角色变更后调用 load_roles() 刷新即可。
_role_cache: Dict[str, List[str]] = {k: list(v) for k, v in ROLE_PERMISSIONS.items()}


async def load_roles() -> Dict[str, List[str]]:
    """把内置角色补齐进库，并把全部角色读入缓存（启动时与角色变更后调用）。"""
    existing = {r["id"] for r in await store.list_roles()}
    for role_id, perms in ROLE_PERMISSIONS.items():
        if role_id not in existing:
            await store.save_role(
                role_id,
                BUILTIN_ROLE_NAMES.get(role_id, role_id),
                ROLE_DESCRIPTIONS.get(role_id, ""),
                list(perms),
                builtin=True,
            )

    roles = await store.list_roles()
    _role_cache.clear()
    for item in roles:
        _role_cache[str(item["id"])] = list(item.get("permissions") or [])
    return dict(_role_cache)


def role_permissions(role: str) -> List[str]:
    if role in _role_cache:
        return _role_cache[role]
    return _role_cache.get("viewer", [])


def _has(perms: List[str], permission: str) -> bool:
    return "*" in perms or permission in perms


def has_permission(role: str, permission: str) -> bool:
    return _has(role_permissions(role), permission)


def effective_permissions(user: Dict[str, Any]) -> List[str]:
    """用户的实际权限：有用户级覆盖就完全按它来，否则继承角色。"""
    override = (user or {}).get("permissions_override")
    if override is not None:
        return list(override)
    return role_permissions(str((user or {}).get("role") or "viewer"))


def has_user_permission(user: Dict[str, Any], permission: str) -> bool:
    return _has(effective_permissions(user), permission)


def is_admin(user: Dict[str, Any]) -> bool:
    """超管视角：admin 可见并管理全部资源（用户隔离对其不生效）。"""
    return str((user or {}).get("role") or "") == "admin"


def visible_owner(user: Dict[str, Any]) -> Optional[str]:
    """返回「只能看自己」时的用户名；管理员返回 None 表示不限制。"""
    return None if is_admin(user) else str((user or {}).get("username") or "")


# ------------------------------------------------------------------ passwords
def hash_password(password: str) -> str:
    return store.pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return store.verify_password(plain, hashed)


# --------------------------------------------------------------------- tokens
# 三种令牌，用 ``typ`` 区分，互相不能顶替：
#   access  短凭据，请求头里带；带 jti（可单独拉黑）与 ver（整用户失效）
#   refresh 长凭据，只放 HttpOnly cookie；一个 jti = 一台设备（= 一个服务端会话）
#   mfa     登录第一步通过后的临时凭据，只够走完一次两步验证
def _encode(payload: Dict[str, Any], expire: datetime, jti: str = "") -> str:
    body = {
        **payload,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": jti or uuid.uuid4().hex,
    }
    return jwt.encode(body, settings.secret_key, algorithm=settings.algorithm)


def create_access_token(
    username: str, role: str, token_version: int = 0, session_id: str = ""
) -> str:
    """访问令牌。

    两个失效开关，粒度不同：

    * ``ver`` → users.token_version：改密码 / 踢下线 / 退出所有设备，整用户生效；
    * ``sid`` → refresh_tokens.jti：这一台设备的会话，撤销会话即失效（登出、
      会话列表里踢掉某台设备）。有了它，「登出立刻生效」不需要再单独维护一张
      token 黑名单表 —— 会话本身就是黑名单。
    """
    return _encode(
        {
            "sub": username,
            "role": role,
            "ver": int(token_version),
            "sid": session_id,
            "typ": "access",
        },
        datetime.now(timezone.utc)
        + timedelta(minutes=settings.access_token_expire_minutes),
    )


def create_refresh_token(username: str, token_version: int = 0) -> Tuple[str, str, float]:
    """刷新令牌。

    返回 ``(token, jti, expires_at)``：jti 要写进 refresh_tokens 表，
    expires_at 用于黑名单/会话列表的过期清理。
    """
    expires_at = (
        datetime.now(timezone.utc)
        + timedelta(days=settings.refresh_token_expire_days)
    ).timestamp()
    jti = uuid.uuid4().hex
    token = _encode(
        {"sub": username, "ver": int(token_version), "typ": "refresh"},
        datetime.fromtimestamp(expires_at, tz=timezone.utc),
        jti=jti,
    )
    return token, jti, expires_at


def create_mfa_token(username: str, token_version: int = 0) -> str:
    """登录第一步通过、等第二步验证码时用的临时凭据。"""
    return _encode(
        {"sub": username, "ver": int(token_version), "typ": "mfa"},
        datetime.now(timezone.utc)
        + timedelta(minutes=settings.mfa_token_expire_minutes),
    )


def decode_token(token: str, expected_typ: str = "access") -> Dict[str, Any]:
    """解出并校验令牌；``typ`` 不匹配直接拒绝（refresh 不能当 access 用）。"""
    try:
        payload = jwt.decode(
            token, settings.secret_key, algorithms=[settings.algorithm]
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录已过期，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的认证凭据",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    # 旧版本签发的 token 没有 typ：按 access 处理，用户不必被迫重新登录。
    token_typ = str(payload.get("typ") or "access")
    if token_typ != expected_typ:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的认证凭据",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


# ------------------------------------------------------------------- cookies
def set_refresh_cookie(response: Response, token: str) -> None:
    """下发 refresh cookie：HttpOnly + SameSite=Lax（同源部署足够）。"""
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=token,
        max_age=int(settings.refresh_token_expire_days) * 86400,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def set_access_cookie(response: Response, token: str) -> None:
    """下发 access cookie：HttpOnly，路径限定 /api。"""
    response.set_cookie(
        key=ACCESS_COOKIE,
        value=token,
        max_age=int(settings.access_token_expire_minutes) * 60,
        path=ACCESS_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def clear_access_cookie(response: Response) -> None:
    response.delete_cookie(
        key=ACCESS_COOKIE,
        path=ACCESS_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def set_csrf_cookie(response: Response, value: str = "") -> str:
    """下发 CSRF 双提交令牌（非 HttpOnly，前端要读），返回实际使用的值。"""
    token = value or secrets.token_urlsafe(24)
    response.set_cookie(
        key=CSRF_COOKIE,
        value=token,
        max_age=int(settings.refresh_token_expire_days) * 86400,
        path=CSRF_COOKIE_PATH,
        # 故意不加 HttpOnly：前端需要读出来放进请求头（攻击者站点读不到）
        httponly=False,
        secure=settings.secure_cookie,
        samesite="lax",
    )
    return token


def clear_csrf_cookie(response: Response) -> None:
    response.delete_cookie(
        key=CSRF_COOKIE,
        path=CSRF_COOKIE_PATH,
        httponly=False,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def set_session_cookies(response: Response, access: str, refresh: str) -> None:
    """登录 / 刷新成功后一次性下发三种 cookie（access + refresh 轮换 + 新 CSRF）。"""
    set_access_cookie(response, access)
    set_refresh_cookie(response, refresh)
    # 每次登录都换一枚 CSRF 令牌，不给「跨站固定」留余地
    set_csrf_cookie(response)


def clear_session_cookies(response: Response) -> None:
    clear_access_cookie(response)
    clear_refresh_cookie(response)
    clear_csrf_cookie(response)


# -------------------------------------------------------------- dependencies
# ----------------------------------------------------------- 凭据类型（鉴权链）
# 同一套接口有两种调用方：浏览器（会话 JWT，分钟级过期 + 二次确认可用）与
# 脚本 / 外部系统（长期 API Token，无人值守、无法二次确认）。get_current_user
# 会把类型记在 request.state 上，供二次确认等下游依赖按类型区别对待。
AUTH_SESSION = "session"
AUTH_API_TOKEN = "api_token"


def auth_kind(request: Request) -> str:
    """本次请求用的哪种凭据。默认按会话算（旧调用点不传也安全）。"""
    return str(getattr(request.state, "auth_kind", "") or AUTH_SESSION)


def is_api_token_request(request: Request) -> bool:
    return auth_kind(request) == AUTH_API_TOKEN


def _user_view(user: Dict[str, Any], path: str) -> Dict[str, Any]:
    """把库里的用户行收成「面板用户」视图，并做统一的可用性判定。

    会话令牌与 API Token 两条链共用这一段 —— 审批状态、启用状态、强制两步
    验证必须一致生效。否则管理员禁用某个账号后，他手里那枚长期令牌还能照用，
    「禁用」对脚本而言就成了空话。

    ``path`` 用于放行强制 2FA 的例外接口（绑定 2FA 本身不能被自己挡住）。
    """
    # 审批状态：每次请求都重新查库，所以管理员把账号打回 pending / rejected
    # 会立刻让已经发出去的凭据失效，不用等它自然过期。
    status_value = user.get("status", store.STATUS_ACTIVE)
    if status_value != store.STATUS_ACTIVE:
        raise HTTPException(
            status_code=403,
            detail=(
                "账号正在等待管理员审批"
                if status_value == store.STATUS_PENDING
                else "账号未通过管理员审批"
            ),
        )
    if not user.get("enabled", True):
        raise HTTPException(status_code=403, detail="账号已被禁用")

    # 强制两步验证：TOTP_REQUIRED_ROLES 里的角色在绑定完成前只能碰 2FA 相关
    # 接口，否则「强制」就是一句空话（不绑也能正常用面板）。这条对 API Token
    # 同样生效 —— 允许令牌绕过 2FA 等于把这项策略架空。
    if (
        not user.get("totp_enabled")
        and str(user.get("role") or "") in settings.totp_required_role_list
        and path not in TOTP_SETUP_ALLOWED_PATHS
    ):
        raise HTTPException(
            status_code=403,
            detail="该角色已强制开启两步验证，请先在「个人中心 → 两步验证」完成绑定",
        )

    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "email": user.get("email", ""),
        "enabled": bool(user.get("enabled", True)),
        "status": status_value,
        # None 表示继承角色；有值表示该用户的权限以这份列表为准
        "permissions_override": user.get("permissions_override"),
        "permissions": effective_permissions(user),
        "totp_enabled": bool(user.get("totp_enabled")),
    }


async def _api_token_user(request: Request, token: str) -> Dict[str, Any]:
    """用 API Token 鉴权：校验令牌 → 取出所属用户 → 走同一套可用性判定。

    权限完全继承所属用户（角色 + permissions_override），所以令牌不会比它
    的主人更能干。
    """
    if not settings.api_token_enabled:
        raise HTTPException(
            status_code=403,
            detail="面板已停用 API Token（API_TOKEN_ENABLED=false）",
        )

    record = await apitokens.authenticate(token, ip=client_ip(request))
    if not record:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API Token 无效、已过期或已被吊销",
            headers={"WWW-Authenticate": "Bearer"},
        )

    username = str(record.get("username") or "")
    user = await store.get_user(username) if username else None
    if not user:
        raise HTTPException(
            status_code=401, detail="API Token 对应的用户不存在"
        )

    # 记下是哪枚令牌在调用：审计日志与服务端日志才回答得了「这条操作是
    # 哪个脚本用哪枚令牌干的」。会话路径不需要这个，user 里有用户名。
    request.state.api_token = record
    return _user_view(user, request.url.path)


async def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
) -> Dict[str, Any]:
    # 浏览器走 HttpOnly cookie（JS 读不到，XSS 偷不走）；脚本 / API 客户端仍可
    # 用 Authorization 头。头优先，方便同一浏览器里用不同凭据调接口做排查。
    if not token:
        token = request.cookies.get(ACCESS_COOKIE, "")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.t("error.no_credentials"),
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 两条凭据链在这里分流：``zp_`` 开头的长期令牌（脚本 / 外部系统）与 JWT
    # （浏览器登录会话）。分流必须发生在**解码 JWT 之前** —— 否则每枚 API
    # Token 都会被当成坏 JWT 抛一次异常。
    if apitokens.looks_like_token(token):
        # _api_token_user 内部会自己标记 auth_kind
        request.state.auth_kind = AUTH_API_TOKEN
        return await _api_token_user(request, token)

    request.state.auth_kind = AUTH_SESSION

    payload = decode_token(token, expected_typ="access")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="无效的认证凭据")

    user = await store.get_user(username)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")

    # 会话版本（users.token_version）：改密码、管理员踢下线、退出所有设备都会
    # +1，于是所有旧 access token 立刻作废，不必逐个登记 jti。
    if int(payload.get("ver", 0)) != int(user.get("token_version", 0)):
        raise HTTPException(
            status_code=401,
            detail="登录状态已失效，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 单设备登出 / 踢掉某台设备：撤销的是会话（sid），这也是「登出立刻生效」
    # 的实现方式 —— 不必等 access token 过期，也不需要单独的黑名单表。
    # 主键点查，一次索引；旧版本签发的 token 没有 sid，跳过即可。
    session_id = str(payload.get("sid") or "")
    if session_id:
        session = await store.get_refresh_token(session_id)
        if not session:
            raise HTTPException(
                status_code=401,
                detail="登录状态已失效，请重新登录",
                headers={"WWW-Authenticate": "Bearer"},
            )
        # 交给下游依赖用（敏感操作的二次确认要读 elevated_until）
        request.state.session = session
        request.state.session_id = session_id

    # 审批状态 / 启用状态 / 强制两步验证的统一判定收在 _user_view 里 ——
    # 与 API Token 路径共用同一份实现，两条链的可用性口径才不会各走一套。
    return _user_view(user, request.url.path)


async def ensure_session_active(payload: Dict[str, Any]) -> None:
    """校验令牌对应的会话仍然有效（会话版本一致、sid 未被撤销）。

    HTTP 侧由 :func:`get_current_user` 负责；这里是给 WebSocket 握手用的
    —— 浏览器没法在 WS 上带 Authorization 头，token 走查询参数，握手时
    也应当拒绝「已经登出/被踢下线」的令牌，否则撤销会话后旧连接照样能建。
    """
    username = str(payload.get("sub") or "")
    user = await store.get_user(username) if username else None
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    if int(payload.get("ver", 0)) != int(user.get("token_version", 0)):
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")
    session_id = str(payload.get("sid") or "")
    if session_id and not await store.is_session_active(session_id):
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")


# --------------------------------------------------------- 敏感操作二次确认
def check_step_up(request: Request, user: Dict[str, Any]) -> None:
    """命令式版本的二次确认校验。

    :func:`require_step_up` 是路由依赖，只能在「整个接口都要确认」时用。批量接口
    一个端点承载多种动作（打标签要确认、开机不要），所以把判定单独拎出来，
    由业务逻辑按 action 决定是否调用。
    """
    # API Token 一律拒绝，且**刻意不看** settings.step_up_required：二次确认的
    # 前提是「有个人坐在键盘前输口令」，而长期令牌正是为无人值守场景准备的。
    # 即便管理员全局关掉了二次确认，也不该让一枚可能被泄漏、且可能永不过期的
    # 凭据获得删机、改连接凭据这类不可逆能力。这类操作只能从浏览器会话做。
    #
    # 响应头用 unsupported 而非 required：前端的拦截器只认 required，会据此弹
    # 出「请输入登录密码」的框 —— 对脚本调用方弹出的框永远填不上，只会让人
    # 以为面板坏了。这里直接让错误信息说清楚原因。
    if is_api_token_request(request):
        raise HTTPException(
            status_code=403,
            detail=(
                "该操作需要二次确认，API Token 无法完成（令牌是无人值守凭据）。"
                "请从浏览器登录后执行。"
            ),
            headers={"X-Step-Up": "unsupported"},
        )
    if not settings.step_up_required:
        return
    session = getattr(request.state, "session", None) or {}
    if float(session.get("elevated_until") or 0) > time.time():
        return
    raise HTTPException(
        status_code=403,
        detail=(
            "该操作需要二次确认，请输入登录密码"
            + ("与两步验证动态码" if user.get("totp_enabled") else "")
        ),
        headers={"X-Step-Up": "required"},
    )


def require_step_up() -> Callable[..., Any]:
    """危险操作的依赖：要求「刚刚验证过身份」（默认 5 分钟内的二次确认）。

    删虚拟机、改连接凭据这类不可逆 / 高价值的操作，光有一枚还在有效期内的
    token 不足以放行 —— token 可能是从共享电脑、日志或 XSS 里捡来的。这里要求
    调用方先用密码（+ 动态码，若开了 2FA）走一次 ``POST /api/auth/step-up``，
    把「已确认」写在会话行上（elevated_until），窗口很短。

    未确认时返回 403 并带上 ``X-Step-Up: required``，前端据此弹出确认框、
    验证完自动重放原请求。
    """

    async def _dependency(
        request: Request,
        user: Dict[str, Any] = Depends(get_current_user),
    ) -> Dict[str, Any]:
        check_step_up(request, user)
        return user

    return _dependency


# --------------------------------------------------------------- 凭据生命周期
async def revoke_user_credentials(username: str) -> Dict[str, int]:
    """撤销某人的**全部**凭据：浏览器会话 + API Token，并让会话版本 +1。

    三件事必须一起做，少一件就会留下还在生效的后门：

    * ``refresh_tokens`` 置 revoked —— 浏览器再刷新不出新的 access token；
    * ``api_tokens`` 置 revoked —— 脚本手里的长期令牌立刻失效；
    * ``token_version`` +1 —— 已经发出、尚未到期的 access token 立刻作废。

    第二件是新增的一环：改密码 / 重置密码 / 管理员踢下线时若只撤会话，
    那枚**可能永不过期**的令牌还能照用 —— 「密码我已经改了」就成了自我安慰。
    规则统一为「改凭据即轮换凭据」，所以改密码会连带吊销自己已签发的令牌；
    令牌是自助管理的，重新签发一次即可，代价远小于漏掉一枚。

    返回各项撤销的数量，让接口如实回报（而不是笼统说一句「已退出」）。
    """
    sessions = await store.revoke_user_refresh_tokens(username)
    tokens = await apitokens.revoke_all(username)
    version = await store.bump_token_version(username)
    return {
        "sessions": sessions,
        "api_tokens": tokens,
        "token_version": version,
    }


# ------------------------------------------------------------------ passwords
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

# 一眼可猜的口令：即使长度够也不放过。管理员建号、自助注册、改密、重置
# 全部走这一份规则 —— 之前建号只要 6 位，比注册还弱，等于后门。
_COMMON_WEAK_PASSWORDS = frozenset(
    {
        "12345678",
        "123456789",
        "1234567890",
        "password",
        "password1",
        "password123",
        "passw0rd",
        "qwerty123",
        "abc12345",
        "admin123",
        "admin1234",
        "iloveyou",
        "letmein1",
        "welcome1",
        "1q2w3e4r",
        "11111111",
        "00000000",
    }
)


def password_policy_error(value: str) -> str:
    """返回不符合强度要求的原因；空串表示通过。前后端提示共用这一份措辞。"""
    password = value or ""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"密码至少 {MIN_PASSWORD_LENGTH} 位"
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"密码不能超过 {MAX_PASSWORD_LENGTH} 位"
    if not re.search(r"[A-Za-z]", password):
        return "密码需同时包含字母与数字"
    if not re.search(r"\d", password):
        return "密码需同时包含字母与数字"
    if password.strip().lower() in _COMMON_WEAK_PASSWORDS:
        return "密码过于常见，请换一个不容易猜的"
    if password.strip() != password:
        return "密码首尾不能有空白字符"
    return ""


def validate_password_strength(value: str, *, field: str = "密码") -> None:
    """不符合强度要求就抛 400（不合法就不落到库 / 不发给 Proxmox）。"""
    problem = password_policy_error(value)
    if problem:
        raise HTTPException(status_code=400, detail=problem.replace("密码", field, 1))


def ws_token(websocket: Any, query_token: str = "") -> str:
    """WebSocket 握手的令牌来源：查询参数（脚本）优先，否则用 HttpOnly cookie。

    浏览器会把同源 Cookie 一起带到 WS 握手上，所以前端不必再把令牌拼进 URL
    —— 那样会漏进 Nginx access log、浏览器历史与 Referer。
    """
    token = (query_token or "").strip()
    if token:
        return token
    try:
        return str(websocket.cookies.get(ACCESS_COOKIE, "") or "")
    except Exception:  # noqa: BLE001 - 解析不出 cookie 就当没带
        return ""


def ws_origin_allowed(websocket: Any) -> bool:
    """校验 WS 握手的 Origin 与 Host 同源。

    浏览器一定会带 Origin；跨站页面发起的 WS 握手会被这道拦住（SameSite=Lax
    虽然已经不发送 Cookie，但多一道总归更稳）。没有 Origin 的客户端
    （curl / 自研脚本）放行：它们不带环境凭据，也不是 CSRF 的攻击面。
    """
    origin = str(websocket.headers.get("origin") or "")
    if not origin:
        return True
    host = str(websocket.headers.get("host") or "")
    try:
        return urlsplit(origin).netloc == host
    except Exception:  # noqa: BLE001
        return False


def require_permission(permission: str) -> Callable[..., Any]:
    """FastAPI dependency factory enforcing a single permission."""

    async def _checker(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if not has_user_permission(user, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=i18n.t(
                    "error.permission_denied_role",
                    permission=permission,
                    role=user["role"],
                ),
            )
        return user

    return _checker


def require_admin() -> Callable[..., Any]:
    return require_permission("users.manage")


# Backwards-compatible alias used by routers that predate permissions.
require_role = require_permission


def trusted_proxies() -> set:
    """可以代表客户端填 X-Forwarded-For 的对端（FORWARDED_ALLOW_IPS + 回环）。"""
    hosts = {"127.0.0.1", "::1", "localhost"}
    hosts.update(h.strip() for h in (settings.forwarded_allow_ips or "").split(",") if h.strip())
    return hosts


def client_ip_from_scope(scope: Dict[str, Any]) -> str:
    """ASGI scope 版本的 client_ip（中间件里用，那里没有 Request 对象）。

    **只信任可信反代传来的 X-Forwarded-For**：直接暴露在公网时这个头是客户端
    自己写的，照着它限流等于把限流开关交给攻击者（每次换一个假 IP 就绕过）。
    """
    peer = ""
    client = scope.get("client")
    if client:
        peer = client[0] or ""
    if peer in trusted_proxies():
        for name, value in scope.get("headers") or []:
            if name == b"x-forwarded-for":
                first = value.decode("latin-1").split(",")[0].strip()
                if first:
                    return first
                break
    return peer


def client_ip(request: Request) -> str:
    """Best-effort client IP, honouring a reverse proxy's X-Forwarded-For."""
    return client_ip_from_scope(
        {
            "client": (request.client.host, request.client.port)
            if request.client
            else None,
            "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in request.headers.items()],
        }
    )


async def audit(
    request: Request,
    user: Dict[str, Any],
    action: str,
    target: str = "",
    result: str = "success",
    detail: str = "",
) -> None:
    await store.add_audit(
        username=user.get("username", "anonymous"),
        action=action,
        target=target,
        result=result,
        detail=detail,
        ip=client_ip(request),
    )


async def audit_read(
    request: Request,
    user: Dict[str, Any],
    action: str,
    target: str = "",
    detail: str = "",
) -> None:
    """记录对**敏感数据**的读取（连接凭据、邮件/机器人配置、审计日志本身…）。

    只记写操作的话，「谁把集群 token 抄走了」这类问题事后查不出来 —— 读取
    本身不改变系统状态，但恰恰是泄密的常见形态。这里刻意只挑敏感接口，
    给每个 GET /api/vms 都记一条只会把审计表淹掉。
    """
    await audit(request, user, action, target=target, detail=detail)
