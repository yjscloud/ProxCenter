"""Panel authentication (JWT sessions) and role-based access control."""
from __future__ import annotations

import json
import logging
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
from . import apitokens, i18n, store, trusteddevices

logger = logging.getLogger(__name__)

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
# 「信任设备」cookie：登录时勾了「7 天内免二次校验」才下发。路径限定在
# /api/auth —— 它只对登录两个端点有意义，别的请求带上它没有用处。
TRUSTED_COOKIE = "panel_trusted"
TRUSTED_COOKIE_PATH = "/api/auth"
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
        # 迁移：范围同上（只能迁自己名下的机器）。原先与 vm.config 合并，
        # 结果是矩阵上写着「迁移仅管理员」、实际有 config 就能迁。
        "vm.migrate",
        # 删除自己的虚拟机：范围由归属守卫保证（routers/vms.py 的
        # require_vm_access 只放行本人名下的机器），因此这里可以安全放开
        "vm.delete",
        # 容器与虚拟机是两套权限（后端 routers/lxc.py 用 ct.*）。这里逐项对齐
        # 上面的虚拟机权限：普通用户对「自己名下的容器」拥有同样的一组能力，
        # 归属范围由 routers/lxc.py 的 require_ct_access 单独把关。
        "ct.view",
        "ct.power",
        "ct.console",
        "ct.snapshot",
        "ct.backup",
        "ct.create",
        "ct.clone",
        "ct.config",
        "ct.migrate",
        "ct.delete",
        "template.view",
        "template.clone",
        "storage.view",
        "network.view",
        # 防火墙：普通用户可以管自己名下虚拟机的规则；集群级（影响所有主机）
        # 留给了 firewall.cluster，默认只有管理员有。
        # ct.firewall.* 是容器侧的同一件事（routers/firewall.py 会按目标类型
        # 选用 vm 还是 ct 的权限点）。
        "firewall.view",
        "firewall.manage",
        "ct.firewall.view",
        "ct.firewall.manage",
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
        # （隔离是 qemu 专有动作，容器不参与，所以没有 ct.isolate。）
        "vm.isolate",
        # 注意：ssh.view / baseline.view / ports.view **不**在普通角色里。
        # 这三项读的是「面板本机 + SSH 受管主机」的主机级数据（登录爆破记录、
        # 基线评分、监听端口清单），而 ssh_hosts 表里没有「这台主机归谁」这个
        # 维度 —— 发给普通用户等于把宿主机信息全公开。要让用户自管主机，
        # 得先给受管主机加归属字段（见 docs / 讨论记录）。
    ],
    "viewer": [
        "vm.view",
        "ct.view",
        "template.view",
        "storage.view",
        "network.view",
        "firewall.view",
        "ct.firewall.view",
        "node.view",
        "task.view",
        "frp.view",
        "alert.view",
        "cert.view",
        # ssh.view / baseline.view / ports.view 是主机级数据，默认仅管理员，
        # 理由见 operator 段；普通用户需要时可由管理员在自定义角色里单独授予。
    ],
}

# 区域管理员：普通用户的全部能力，外加「本区域内所有机器」的可见与操作权
# （含把区域内的机器指派给具体用户）。范围来自 users.regions（连接上的区域
# 标签），不新增一套权限点 —— 权限点描述「能做什么」，区域描述「对谁生效」，
# 混在一起会出现「勾了权限却看不到东西」的困惑。
ROLE_PERMISSIONS["region_admin"] = [
    *ROLE_PERMISSIONS["operator"],
    "vm.assign",
    "ct.assign",
]

ROLE_DESCRIPTIONS: Dict[str, str] = {
    "admin": "超级管理员：可见并管理全部资源（不受用户隔离限制），可管理用户、连接配置与宿主机网络。",
    "region_admin": "区域管理员：管理指派区域内（可多个）的全部虚拟机与容器，可指派区域内机器的归属；"
    "不能管理用户、全局连接配置或其它区域。",
    "operator": "普通用户：可创建、开关机、控制台、快照、备份、克隆，并删除「自己创建」的"
    "虚拟机与容器；只能看到自己名下的机器，不能管理用户、连接配置或宿主机网络。",
    "viewer": "只读用户：仅可查看自己名下的资源、监控与任务，不能执行任何变更操作。",
}


# 权限目录：供「创建用户 / 自定义角色」的勾选界面使用（按域分组 + 中文说明）。
# 这里必须与 ROLE_PERMISSIONS 及各处 require_permission() 用到的字符串完全一致，
# 否则界面上勾了却不生效 —— 现在由 tests/test_permission_catalog.py 兜底，漏了会红。
#
# 命名约定：``<域>.<动作>``，动作优先复用已有的 view / manage / create / delete。
# 三段式（``ct.firewall.manage``、``ai.terminal``）是**有意**的：同一项能力在虚拟机
# 与容器下各有一套（首段是客户机类型），或者尾段本身是个子域。加权限点时先看同域里
# 已有的键怎么拼，别自造同义词 —— "edit" 与 "manage" 混用会让勾选界面看起来像两件事。
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
            {"key": "vm.config", "label": "修改配置", "desc": "改 CPU / 内存 / 磁盘 / 网卡等配置"},
            {
                "key": "vm.migrate",
                "label": "迁移",
                "desc": "在节点之间迁移虚拟机（在线或离线）。原先与「修改配置」共用 vm.config，"
                "矩阵上写着仅管理员、实际有 config 就能迁 —— 现在单独成点。",
            },
            {"key": "vm.snapshot", "label": "快照", "desc": "创建 / 回滚 / 删除快照"},
            {"key": "vm.backup", "label": "备份", "desc": "备份与恢复"},
            {"key": "vm.clone", "label": "克隆", "desc": "从模板或虚拟机克隆"},
            {
                "key": "vm.reinstall",
                "label": "重装系统",
                "desc": "用 Cloud-Init 模板重建虚拟机的系统盘（替换并删除原系统盘）",
            },
            {
                "key": "vm.isolate",
                "label": "应急隔离",
                "desc": "一键隔离可疑虚拟机（取证快照 + 断网 + 关机）与解除隔离",
            },
        ],
    },
    {
        # 容器（LXC）与虚拟机在 PVE 上是两套端点，权限也各自独立。
        # 这一组与上面的「虚拟机」组逐项对应；差异只在容器没有的能力
        # （重装系统、应急隔离是 qemu 专有，故不列出）。
        "key": "ct",
        "label": "容器",
        "permissions": [
            {"key": "ct.view", "label": "查看", "desc": "查看自己名下的容器"},
            {"key": "ct.create", "label": "创建", "desc": "新建容器"},
            {"key": "ct.delete", "label": "删除", "desc": "删除自己创建的容器"},
            {"key": "ct.assign", "label": "指派归属", "desc": "把容器指派给指定用户（含存量无主机）"},
            {"key": "ct.power", "label": "电源操作", "desc": "开机 / 关机 / 重启 / 挂起"},
            {"key": "ct.console", "label": "控制台", "desc": "打开容器控制台（VNC / 终端）"},
            {"key": "ct.config", "label": "修改配置", "desc": "改 CPU / 内存 / 磁盘 / 网卡 / 挂载点等配置"},
            {
                "key": "ct.migrate",
                "label": "迁移",
                "desc": "在节点之间迁移容器（在线或离线）。与 vm.migrate 对应，原先共用 ct.config。",
            },
            {"key": "ct.snapshot", "label": "快照", "desc": "创建 / 回滚 / 删除容器快照"},
            {"key": "ct.backup", "label": "备份", "desc": "查看与恢复容器备份（备份页跨类型共用）"},
            {"key": "ct.clone", "label": "克隆", "desc": "从容器或模板克隆"},
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
            {
                "key": "ct.firewall.view",
                "label": "容器查看",
                "desc": "查看自己名下容器的防火墙规则与选项（集群 / 节点级沿用上面的「查看」）",
            },
            {
                "key": "ct.firewall.manage",
                "label": "容器管理",
                "desc": "改自己名下容器的防火墙规则与选项",
            },
        ],
    },
    {
        "key": "node",
        "label": "节点",
        "permissions": [
            {"key": "node.view", "label": "查看", "desc": "查看节点状态与监控"},
            {
                "key": "node.scope",
                "label": "可见性",
                "desc": "设置节点对哪些用户 / 角色可见（特殊项目节点可对普通用户隐藏）",
            },
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
        "key": "ai",
        "label": "AI 排查助手",
        "permissions": [
            {
                "key": "ai.exec",
                "label": "上机执行",
                "desc": "允许 AI 在目标主机上执行命令：只读诊断命令（白名单限制）可直接执行，"
                "改动系统的命令需你逐条批准。全程记入审计。默认仅管理员",
            },
            {
                "key": "ai.terminal",
                "label": "远程终端",
                "desc": "在受管主机上打开可交互的 SSH 终端，直接在浏览器里操作。"
                "这等于把该主机的登录凭据交给使用者，默认仅管理员",
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
            {
                "key": "users.manage",
                "label": "管理",
                "desc": "增删改用户、角色与其资源额度（不含面板配置）",
            },
        ],
    },
    {
        "key": "settings",
        "label": "系统设置",
        "permissions": [
            {
                "key": "settings.manage",
                "label": "管理",
                "desc": "面板自身的配置：Proxmox 连接、邮件与通知、飞书机器人、AI、告警推送等",
            },
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
    "region_admin": "区域管理员",
    "operator": "普通用户",
    "viewer": "只读用户",
}

# 角色权限的进程内缓存。
# 角色定义放在数据库（roles 表，admin 可自定义），但权限校验散落在同步依赖里，
# 所以这里保留一份缓存；任何角色变更后调用 load_roles() 刷新即可。
_role_cache: Dict[str, List[str]] = {k: list(v) for k, v in ROLE_PERMISSIONS.items()}

# 内置角色的增量升级，按轮次列：``(一次性标记, {角色: 新增权限})``。
#
# 为什么要补：升级前 operator / viewer 只勾了 vm.*；拆分后容器接口改用 ct.*、迁移
# 从 vm.config 独立成 vm.migrate，若不补一次，现网里早就存在的 operator 角色会对
# 容器页与迁移整片 403（角色行已落库，load_roles() 只在「角色还不存在」时写库）。
#
# 一轮一个标记：升级是一次性的，而部署可能已经跑过上一轮 —— 共用一个标记会让后加
# 的这一轮被直接跳过（旧角色补不上新权限）；只做增量合并（∪ 到现有权限上）而不是
# 整体重写，是为了不抹掉管理员在内置角色上手工裁掉的权限
# （见 :func:`_merge_builtin_additions`）。
_BUILTIN_ROLE_ROUNDS: List[Tuple[str, Dict[str, List[str]]]] = [
    (
        # 第一轮：容器权限拆分（ct.* 从 vm.* 里分出来）
        "roles_builtin_ct_split",
        {
            "operator": [
                "ct.view",
                "ct.power",
                "ct.console",
                "ct.snapshot",
                "ct.backup",
                "ct.create",
                "ct.clone",
                "ct.config",
                "ct.delete",
                "ct.firewall.view",
                "ct.firewall.manage",
            ],
            "viewer": ["ct.view", "ct.firewall.view"],
        },
    ),
    (
        # 第二轮：迁移从「修改配置」里分出来（vm.migrate / ct.migrate）
        "roles_builtin_migrate_split",
        {"operator": ["vm.migrate", "ct.migrate"]},
    ),
]


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

    await _upgrade_builtin_roles()

    roles = await store.list_roles()
    _role_cache.clear()
    for item in roles:
        _role_cache[str(item["id"])] = list(item.get("permissions") or [])
    return dict(_role_cache)


async def _upgrade_builtin_roles() -> None:
    """把 :data:`_BUILTIN_ROLE_ROUNDS` 里各轮的新增权限并进已存在的内置角色。"""
    for flag, additions in _BUILTIN_ROLE_ROUNDS:
        await _merge_builtin_additions(flag, additions)


async def _merge_builtin_additions(
    flag: str, additions: Dict[str, List[str]]
) -> None:
    """某一轮的增量合并：只加不减，跑过就记标记（存 settings KV）。

    **只做增量**：管理员可能在内置角色上手工裁过权限（例如把 operator 的删除收
    回去），整体重写成 ROLE_PERMISSIONS 会把它悄悄还原；这里只把「这一轮新加的
    那几个权限」并进去。
    """
    try:
        if await store.get_setting(flag):
            return
    except Exception:  # noqa: BLE001 - 读标记失败：宁可多合并一次也不漏补
        pass

    for role_id, perms in additions.items():
        role = await store.get_role(role_id)
        if not role:
            continue
        current = list(role.get("permissions") or [])
        if "*" in current:
            continue  # 超管无需逐项补
        merged = sorted(set(current) | set(perms))
        if merged == sorted(set(current)):
            continue
        await store.save_role(
            role_id,
            str(role.get("name") or BUILTIN_ROLE_NAMES.get(role_id, role_id)),
            str(role.get("description") or ROLE_DESCRIPTIONS.get(role_id, "")),
            merged,
            builtin=True,
        )
    try:
        await store.set_setting(flag, "1")
    except Exception:  # noqa: BLE001
        logger.warning("写入内置角色升级标记失败，下次启动会重跑", exc_info=True)


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


def permission_keys() -> set:
    """权限目录里全部合法的键（``*`` 不在其中，见 :func:`validate_permissions`）。"""
    return {
        str(item.get("key") or "")
        for group in PERMISSION_CATALOG
        for item in group.get("permissions", [])
    }


def validate_permissions(perms: Optional[List[str]]) -> Optional[List[str]]:
    """校验并规范化管理员提交的一组权限键；有未知项就报 400。

    ``None`` 原样返回 —— 它的语义是「不设用户级覆盖，跟随角色」，与 ``[]``
    （显式不给任何权限）是两件事，不能在规范化里被抹平。

    为什么必须挡：这些字符串是前后端**唯一的约定**，而两边对错误的处理都是静默
    失败 —— 拼错一个（``vm.powers``）表现为「勾了不生效」，谁都不报错，非常难查。

    ``*`` 同样在这里被拒。后端把 ``*`` 当「全部权限」（见 :func:`_has`），而
    内置超管角色的 ``["*"]`` 是**写死在常量表里**、由 :func:`load_roles` 直接入库的，
    不经过这条路径；一旦让它从 ``POST /roles`` 或用户级覆盖进来，就等于凭空造了
    第二个超管 —— 而且那个角色在前端还看不到菜单（前端只认 ``role == 'admin'``）。
    """
    if perms is None:
        return None
    submitted = {str(item) for item in perms}
    unknown = sorted(submitted - permission_keys())
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"未知的权限项：{'、'.join(unknown)}",
        )
    return sorted(submitted)


def is_admin(user: Dict[str, Any]) -> bool:
    """超管视角：admin 可见并管理全部资源（用户隔离对其不生效）。"""
    return str((user or {}).get("role") or "") == "admin"


def visible_owner(user: Dict[str, Any]) -> Optional[str]:
    """返回「只能看自己」时的用户名；管理员返回 None 表示不限制。"""
    return None if is_admin(user) else str((user or {}).get("username") or "")


# ------------------------------------------------------- 区域 / 节点可见范围
def is_region_admin(user: Dict[str, Any]) -> bool:
    """区域管理员：可见并管理**指派区域内全部机器**（不是只有自己名下）。"""
    return str((user or {}).get("role") or "") == "region_admin"


def user_regions(user: Dict[str, Any]) -> List[str]:
    """该用户被指派的区域名（来自连接的 region 标签）。空 = 一个区域都没指派。

    库里的 :func:`store._user_row` 已解析成列表；这里再兼容一次 JSON 字符串与
    逗号分隔文本 —— API Token / 旧数据 / 单元测试都可能只给原文，判空失效会让
    区域管理员在整个面板里「看不见任何东西」。
    """
    raw = (user or {}).get("regions")
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            parsed = [item for item in text.replace(";", ",").split(",")]
        raw = parsed if isinstance(parsed, list) else [parsed]
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item or "").strip()]


def region_in_scope(user: Dict[str, Any], region: Any) -> bool:
    """该区域是否落在用户的可见范围内。

    普通用户不受区域限制（他们的范围由「自己名下」+ 节点授权决定）。区域管理
    员只在本区域内放行；**未分区（region 为空）的连接不归任何区域管理员** ——
    否则「忘了填区域」的连接会变成一个谁都能管的缺口。
    """
    if not is_region_admin(user):
        return True
    text = str(region or "").strip()
    if not text:
        return False
    return text in user_regions(user)


def ensure_region_allowed(user: Dict[str, Any], connection_id: str) -> None:
    """写操作入口用：区域管理员越区时直接拒绝。"""
    if not region_in_scope(user, store.connection_region(connection_id)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该连接不在你负责的区域内",
        )


async def node_visibility(user: Dict[str, Any]) -> Callable[[str, str], bool]:
    """返回 ``(connection_id, node) -> 是否可见`` 的判定函数。

    管理员与区域管理员不做节点级限制（区域外的连接在连接/节点清单里已被挡掉）；
    其余人按 ``node_scope`` 解析：用户行 > 角色行 > 默认行 > 无行（可见）。

    读库失败时**放行**：升级前的行为就是「所有节点可见」，一次读库异常不该把
    所有人的建机入口关掉；真正的授权仍由写操作时的 :func:`ensure_node_allowed`
    兜住。
    """
    if is_admin(user) or is_region_admin(user):
        return lambda _connection_id, _node: True

    try:
        rows = await store.list_node_scope()
    except Exception:  # noqa: BLE001 - 读不到授权表时保持升级前的行为
        logger.warning("读取节点可见性配置失败，按全部可见处理", exc_info=True)
        return lambda _connection_id, _node: True

    username = str((user or {}).get("username") or "")
    role = str((user or {}).get("role") or "")
    user_map: Dict[Tuple[str, str], bool] = {}
    role_map: Dict[Tuple[str, str], bool] = {}
    default_map: Dict[Tuple[str, str], bool] = {}
    for row in rows:
        kind = str(row.get("subject_type") or "")
        subject = str(row.get("subject") or "")
        key = (str(row.get("connection_id") or ""), str(row.get("node") or ""))
        allowed = bool(row.get("allowed"))
        if kind == "user" and subject == username:
            user_map[key] = allowed
        elif kind == "role" and subject == role:
            role_map[key] = allowed
        elif kind == "*" and subject == "*":
            default_map[key] = allowed

    def allowed(connection_id: str, node: str) -> bool:
        key = (str(connection_id or ""), str(node or ""))
        if key in user_map:
            return user_map[key]
        if key in role_map:
            return role_map[key]
        if key in default_map:
            return default_map[key]
        return True

    return allowed


async def ensure_node_allowed(
    user: Dict[str, Any], connection_id: str, node: str
) -> None:
    """写操作入口用：节点对该用户不可见时拒绝。

    **必须放在服务端**：前端下拉隐藏只是体验，构造一个请求体带上节点名就能
    绕过 —— 在加上这道校验之前，创建接口对 ``payload.node`` 没有任何归属检查。
    """
    visible = await node_visibility(user)
    if not visible(connection_id, node):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"节点 {node} 未对你开放，请联系管理员",
        )


def scoped_username(user: Dict[str, Any], requested: Any = None) -> Optional[str]:
    """把「要看谁的记录」收敛成一个安全取值（``None`` = 不限制）。

    管理员可以看全部，也可以按用户名筛；其他人**只能看自己** —— 被授予
    ``audit.view`` 的普通用户也一样。显式索要别人的记录直接 403，而不是悄悄
    换成自己：默默替换会让界面上的「按用户筛选」看起来生效了，实际返回的却是
    自己的数据，排查问题时更容易跑偏。

    用户名解析不出来（理论上不该出现）时同样拒绝：若返回空串，查询层会把
    ``username = ''`` 当成「没加这个条件」，等于放开全量 —— 这里宁可 403。
    """
    scope = visible_owner(user)
    if scope is None:
        text = str(requested or "").strip()
        return text or None

    if not scope:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无法确定当前用户身份，拒绝读取记录",
        )

    wanted = str(requested or "").strip()
    if wanted and wanted != scope:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="只能查看自己的记录",
        )
    return scope


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


# --------------------------------------------------------------- 会话有效期
#
# 有效期有两个来源：
#   · 环境变量（ACCESS_TOKEN_EXPIRE_MINUTES / REFRESH_TOKEN_EXPIRE_DAYS）——
#     部署时的默认值；
#   · 管理员在「设置 → 会话」里改的值 —— 存 settings 表（KV），优先级更高。
#
# 为什么在进程里再缓存一份：签发令牌、写 cookie 都是同步函数，没法在那里
# await 一次查库。缓存在启动时加载，写入路径主动刷新，改完立刻生效、不用重启。
_SESSION_KEY_ACCESS = "session_access_minutes"
_SESSION_KEY_REFRESH = "session_refresh_days"

# 允许的取值范围：access 下限 5 分钟（太短会把人反复踢出去），
# refresh 上限 365 天（再长就等于永不过期）。
SESSION_ACCESS_MIN = 5
SESSION_ACCESS_MAX = 60 * 24 * 30
SESSION_REFRESH_MIN = 1
SESSION_REFRESH_MAX = 365

_session_policy: Tuple[int, int] = (
    int(settings.access_token_expire_minutes),
    int(settings.refresh_token_expire_days),
)


def session_access_minutes() -> int:
    """当前生效的访问令牌有效期（分钟）。"""
    return _session_policy[0]


def session_refresh_days() -> int:
    """当前生效的刷新令牌 / 会话有效期（天）。"""
    return _session_policy[1]


async def refresh_session_policy() -> Tuple[int, int]:
    """从 settings 表重新加载有效期；缺省回落到环境变量。

    非法值（非数字、越界）当作没设置 —— 宁可回到默认，也不要让一条脏数据
    把所有人锁在门外。
    """
    global _session_policy
    access = int(settings.access_token_expire_minutes)
    refresh = int(settings.refresh_token_expire_days)
    try:
        raw_access = await store.get_setting(_SESSION_KEY_ACCESS)
        if raw_access:
            value = int(str(raw_access).strip())
            if SESSION_ACCESS_MIN <= value <= SESSION_ACCESS_MAX:
                access = value
        raw_refresh = await store.get_setting(_SESSION_KEY_REFRESH)
        if raw_refresh:
            value = int(str(raw_refresh).strip())
            if SESSION_REFRESH_MIN <= value <= SESSION_REFRESH_MAX:
                refresh = value
    except Exception:  # noqa: BLE001 — 读不到就用默认值，不能因此启动失败
        logger.warning("读取会话有效期设置失败，回落到环境变量", exc_info=True)
    _session_policy = (access, refresh)
    return _session_policy


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
        + timedelta(minutes=session_access_minutes()),
    )


def create_refresh_token(username: str, token_version: int = 0) -> Tuple[str, str, float]:
    """刷新令牌。

    返回 ``(token, jti, expires_at)``：jti 要写进 refresh_tokens 表，
    expires_at 用于黑名单/会话列表的过期清理。
    """
    expires_at = (
        datetime.now(timezone.utc)
        + timedelta(days=session_refresh_days())
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
        max_age=session_refresh_days() * 86400,
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
        max_age=session_access_minutes() * 60,
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
        max_age=session_refresh_days() * 86400,
        path=CSRF_COOKIE_PATH,
        # 故意不加 HttpOnly：前端需要读出来放进请求头（攻击者站点读不到）
        httponly=False,
        secure=settings.secure_cookie,
        samesite="lax",
    )
    return token


def set_trusted_cookie(response: Response, token: str, max_age: int) -> None:
    """下发「信任设备」cookie（登录时勾了「7 天内免二次校验」）。

    路径刻意限定在 ``/api/auth``：这枚 cookie 只对登录两个端点有意义，
    其余接口带着它既没用、又白白多暴露一次。HttpOnly 是必须的 —— 它是
    「少输一次动态码」的凭据，前端没有任何理由读它。

    ``max_age`` 由 :func:`app.trusteddevices.remember` 的到期时间算出，
    保证 cookie 的生命周期与服务端记录**完全一致**：cookie 还在、记录已删
    （或反之）都不该出现。
    """
    response.set_cookie(
        key=TRUSTED_COOKIE,
        value=token,
        max_age=max(0, int(max_age)),
        path=TRUSTED_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


def clear_trusted_cookie(response: Response) -> None:
    response.delete_cookie(
        key=TRUSTED_COOKIE,
        path=TRUSTED_COOKIE_PATH,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
    )


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


def account_expires_at(user: Dict[str, Any]) -> float:
    """账号有效期的 Unix 时间戳；0 表示永不过期。

    这一列是后补的，缺失 / 脏值都按「永不过期」处理 —— 一个坏字段不该让
    所有账号一起登不进来。
    """
    try:
        return max(float(user.get("expires_at") or 0), 0.0)
    except (TypeError, ValueError):
        return 0.0


def is_account_expired(
    user: Dict[str, Any], now: Optional[float] = None
) -> bool:
    """账号是否已过有效期（过期 = 冻结：登录与所有接口都拒绝）。"""
    expires = account_expires_at(user)
    return bool(expires) and expires <= (time.time() if now is None else now)


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

    # 有效期：与登录接口同一句提示。放在审批 / 启用之后、2FA 之前 ——
    # 账号已经冻结时，再要求他先绑动态码只会让人以为还有救。
    if is_account_expired(user):
        raise HTTPException(
            status_code=403, detail=i18n.t("error.account_frozen")
        )

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
        # 区域管理员的可见范围必须跟着「当前用户」一起走：路由里所有区域判定
        # （连接清单、节点列表、单机访问）读的都是这份视图。之前漏了这个字段，
        # 区域管理员在 HTTP 请求里恒等于「没分配区域」，节点与机器全是空的。
        "regions": user_regions(user),
        "totp_enabled": bool(user.get("totp_enabled")),
        # 角色被要求绑定 2FA、但这个账号还没绑：前端据此把人直接带到绑定页。
        # 只在登录响应里给的话，会话还在时刷新页面就绕过了这道门 —— 用户会
        # 看到每个接口都 403（包括「测试连接」），却不知道该去做什么。
        "totp_setup_required": (
            not user.get("totp_enabled")
            and str(user.get("role") or "") in settings.totp_required_role_list
        ),
        "expires_at": account_expires_at(user),
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


def _bearer_token(request: Request, token: Optional[str]) -> str:
    """取调用方凭据：Authorization 头优先，其次 HttpOnly cookie。

    浏览器走 HttpOnly cookie（JS 读不到，XSS 偷不走）；脚本 / API 客户端仍可
    用 Authorization 头。头优先，方便同一浏览器里用不同凭据调接口做排查。
    """
    return token or request.cookies.get(ACCESS_COOKIE, "") or ""


async def _authenticate(request: Request, token: str) -> Dict[str, Any]:
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


async def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
) -> Dict[str, Any]:
    """强制登录：没有凭据 / 凭据失效一律 401。"""
    raw = _bearer_token(request, token)
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.t("error.no_credentials"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await _authenticate(request, raw)


async def get_current_user_optional(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
) -> Optional[Dict[str, Any]]:
    """可选登录：有有效凭据就返回用户，否则返回 ``None``（绝不抛 401）。

    给「匿名也能访问、但要按登录与否给不同信息量」的端点用 —— 目前只有
    ``/api/health``：未登录只答「活着」，已登录才回 PVE 版本 / 节点数这类
    内网拓扑（见 routers/config.py）。
    """
    raw = _bearer_token(request, token)
    if not raw:
        return None
    try:
        return await _authenticate(request, raw)
    except HTTPException:
        return None


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
    # WebSocket 握手也要挡住已过期的账号：HTTP 侧由 _user_view 负责，
    # 这条路径不经过它（否则过期账号还能继续看控制台）。
    if is_account_expired(user):
        raise HTTPException(status_code=403, detail=i18n.t("error.account_frozen"))
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
    """撤销某人的**全部**凭据：浏览器会话 + API Token + 信任设备，并让会话版本 +1。

    四件事必须一起做，少一件就会留下还在生效的后门：

    * ``refresh_tokens`` 置 revoked —— 浏览器再刷新不出新的 access token；
    * ``api_tokens`` 置 revoked —— 脚本手里的长期令牌立刻失效；
    * ``trusted_devices`` 整批删除 —— 否则「信任设备」会把第二步验证**绕过**
      7 天，改密码本意是把所有人赶出去，结果那台被信任的机器连密码都不用输
      就进来了，等于换密码没换成；
    * ``token_version`` +1 —— 已经发出、尚未到期的 access token 立刻作废。

    第二、三件都是「撤会话还不够」的补丁：只撤会话的话，那枚**可能永不过期**的
    API Token 还能照用、那台被信任的设备还能照进 ——「密码我已经改了」就成了
    自我安慰。规则统一为「改凭据即轮换凭据」，所以改密码会连带吊销自己已签发的
    令牌与信任设备；两者都是自助恢复的（重新签发 / 下次登录重勾），代价远小于漏掉。

    返回各项撤销的数量，让接口如实回报（而不是笼统说一句「已退出」）。
    """
    sessions = await store.revoke_user_refresh_tokens(username)
    tokens = await apitokens.revoke_all(username)
    devices = await trusteddevices.forget_all(username)
    version = await store.bump_token_version(username)
    return {
        "sessions": sessions,
        "api_tokens": tokens,
        "trusted_devices": devices,
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


def require_any_permission(*permissions: str) -> Callable[..., Any]:
    """FastAPI dependency factory：拥有其中**任意一个**权限即可放行。

    给「跨类型」的汇总接口用 —— 快照 / 备份 / 批量操作这三个页面同时覆盖虚拟机
    与容器，只认 ``vm.*`` 会让「只有容器权限」的用户连页面都打不开，只认 ``ct.*``
    则反过来。逐台操作的细分权限仍在处理函数里按目标类型各自判一次。
    """

    async def _checker(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if any(has_user_permission(user, perm) for perm in permissions):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=i18n.t(
                "error.permission_denied_role",
                permission=" / ".join(permissions),
                role=user["role"],
            ),
        )

    return _checker


def require_admin() -> Callable[..., Any]:
    """仅**超级管理员**（``role == "admin"``）。

    这里以前等价于 ``require_permission("users.manage")``，于是「用户与角色 · 管理」
    这一个勾选项顺带把飞书机器人、AI 配置、告警推送来源也给了出去（见
    routers/feishu.py、routers/ai.py、routers/alerts.py 的历史用法）—— 管理员不可能
    从「增删改用户与角色」这几个字里读出这一层。面板级配置现在归 ``settings.manage``，
    这里恢复字面意思。

    与 :func:`is_admin` 是同一个判据；用户隔离（:func:`visible_owner`）也用它。
    """
    async def _checker(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if not is_admin(user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="该操作仅超级管理员可用",
            )
        return user

    return _checker


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


def client_ip(request: Optional[Request]) -> str:
    """Best-effort client IP, honouring a reverse proxy's X-Forwarded-For.

    ``request`` 允许为 None：后台作业（导出 / 重装）跑在 HTTP 请求之外，结束时也要
    写一条审计，但那时根本没有客户端地址 —— 记空串，别让任务栽在最后一步。
    """
    if request is None:
        return ""
    return client_ip_from_scope(
        {
            "client": (request.client.host, request.client.port)
            if request.client
            else None,
            "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in request.headers.items()],
        }
    )


async def audit(
    request: Optional[Request],
    user: Dict[str, Any],
    action: str,
    target: str = "",
    result: str = "success",
    # **可以是结构化的**：dict / list 会由 :func:`app.store.add_audit` 编码成 JSON
    # 再落库，所以界面能按字段筛（例如额度那几处写的 ``{"reason": "quota"}``）。
    # 标注写 str 是不实的 —— 它会让严格的类型检查把现成的九个调用点全报一遍错。
    detail: Any = "",
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
