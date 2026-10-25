"""Panel user management."""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import i18n, mailer, panel_url, prefs, quota, security, store
from ..schemas import ApprovalRequest, QuotaIn, UserCreate, UserUpdate


async def _notify_decision(
    record: Dict[str, Any],
    decision: str,
    role_label: str,
    reason: str,
    request: Request,
) -> str:
    """把审批结果邮件通知注册用户，返回一句可写进审计的说明。

    与注册通知同理：邮件不在关键路径上，没邮箱 / 没配置 / 发失败都只记录原因，
    不影响「审批已经生效」这件事。
    """
    to = str(record.get("email") or "").strip()
    if not to:
        return "该账号没有邮箱，已跳过"
    cfg = await mailer.load_mail()
    if not mailer.is_configured(cfg):
        return "邮件通知未配置，已跳过"

    # 对外链接优先用「面板全局地址」；未配置才回落到本次请求的 Host
    url = await panel_url.resolve(request)

    # 审批通知按**收件人**的语言渲染：收件人就是被审批的那个用户，
    # 其语言存在 user_prefs 里，与管理员当前界面语言无关。
    recipient = str(record.get("username") or "")
    lang = await prefs.get(recipient, prefs.PREF_LANGUAGE, i18n.DEFAULT_LANG)
    with i18n.use_language(lang):
        if decision == "approve":
            subject, text, html = mailer.approval_mail(recipient, role_label, url)
        else:
            subject, text, html = mailer.rejection_mail(recipient, reason, url)

    ok, detail = await mailer.send_mail(to, subject, text, html=html)
    return detail if ok else f"通知用户失败：{detail}"

router = APIRouter(prefix="/api", tags=["users"])


# NOTE: this route must be declared before ``/users/{username}`` or FastAPI
# would match "roles" as a username.
@router.get("/users/roles")
async def list_roles(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> List[Dict[str, Any]]:
    """角色目录（含 admin 自建的角色），用于用户界面的下拉与权限预勾选。

    **权限矩阵只给能管用户的人**（``users.view``，即 /api/roles 的门槛）。
    普通登录用户拿角色名与说明就够了；完整的权限清单是管理面的信息，交出去
    等于把「这个面板有哪些能力、谁能做什么」整套摊开（V2-04）。
    """
    can_see_permissions = security.has_user_permission(user, "users.view")
    roles = await store.list_roles()
    items: List[Dict[str, Any]] = []
    for item in roles:
        # 同时给出 id 与 role：前端新的角色模型用 id，旧代码用 role
        entry: Dict[str, Any] = {
            "id": item["id"],
            "role": item["id"],
            # 内置角色的名称与说明按请求语言返回（与 /api/roles 保持一致，
            # 否则这里会原样吐出库里存的中文，英文界面下角色卡片仍是中文）。
            # 自定义角色是用户自己起的名字，译表查不到就原样透传（见 i18n.tr）。
            "name": i18n.tr(item.get("name") or item["id"]),
            "description": i18n.tr(item.get("description") or ""),
            "builtin": bool(item.get("builtin")),
        }
        if can_see_permissions:
            entry["permissions"] = item.get("permissions") or []
        items.append(entry)
    return items


@router.get("/users/regions")
async def list_regions(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[str]:
    """可指派的区域名（来自各 PVE 连接上的 region 标签）。

    区域不是独立实体，界面上「可管理区域」的多选项就是这份清单。未填区域的
    连接不会出现在这里 —— 没有区域名的连接不归任何区域管理员管（见
    :func:`security.region_in_scope`）。
    """
    return store.connection_regions()


@router.get("/users")
async def list_users(
    status: Optional[str] = Query(
        default=None,
        pattern="^(active|pending|rejected)$",
        description="按审批状态过滤；不传则返回全部",
    ),
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[Dict[str, Any]]:
    return await store.list_users(status=status)


@router.get("/users/{username}")
async def get_user(
    username: str,
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> Dict[str, Any]:
    found = await store.get_user(username)
    if not found:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")
    return {
        "id": found["id"],
        "username": found["username"],
        "role": found["role"],
        "email": found["email"] or "",
        "enabled": bool(found["enabled"]),
        "created": found["created"],
        "status": found.get("status", store.STATUS_ACTIVE),
        # None = 继承角色权限；有值 = 用户级覆盖（界面据此预填勾选）
        "permissions_override": found.get("permissions_override"),
        "permissions": security.effective_permissions(found),
        # 账号有效期：0 = 永不过期；expiry_frozen 非 0 = 已到期冻结（已关机）
        "expires_at": found.get("expires_at", 0),
        "expiry_frozen": found.get("expiry_frozen", 0),
        # 区域管理员可管理的区域（空 = 不按区域限制）
        "regions": found.get("regions") or [],
    }


@router.post("/users")
async def create_user(
    payload: UserCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    if await store.get_user(payload.username):
        raise HTTPException(
            status_code=409, detail=f"用户名 {payload.username} 已存在"
        )

    # 建号 = 造一份新的登录凭据：口令强度与注册 / 自助改密保持一致
    security.validate_password_strength(payload.password, field="密码")

    role_id = (payload.role or "viewer").strip()
    if not await store.get_role(role_id):
        raise HTTPException(status_code=400, detail=f"角色 {role_id} 不存在")

    # None = 跟随角色权限；给了列表 = 用户级覆盖。两种都先过目录白名单 ——
    # 这条路径同样是权限的写入口，拼错的键会静默失效、"*" 会凭空造超管
    permissions = security.validate_permissions(payload.permissions)

    created = await store.create_user(
        payload.username,
        payload.password,
        role_id,
        payload.email,
        permissions=permissions,
        expires_at=payload.expires_at,
        regions=payload.regions,
    )

    await security.audit(
        request, user, "user.create", target=payload.username,
        detail={
            "role": role_id,
            "permissions": permissions,
            "expires_at": payload.expires_at or 0,
            "regions": list(created.get("regions") or []),
        },
    )
    return created


@router.put("/users/{username}")
async def update_user(
    username: str,
    payload: UserUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    # 管理员重置他人密码同样要过硬强度这一关（schema 已限长度，这里管内容）
    if payload.password:
        security.validate_password_strength(payload.password, field="密码")

    # Guard against locking everyone out of the panel.
    if existing["role"] == "admin" and (
        payload.role is not None and payload.role != "admin"
        or payload.enabled is False
    ):
        if await store.count_admins() <= 1:
            raise HTTPException(
                status_code=409,
                detail="不能降级或禁用最后一个管理员账号",
            )

    # 给最后一个管理员设有效期，等价于「到点自动把唯一的超管锁在门外」——
    # 与上面那条防呆同源，直接拒绝。
    if (
        payload.expires_at
        and payload.expires_at > 0
        and existing["role"] == "admin"
        and await store.count_admins() <= 1
    ):
        raise HTTPException(
            status_code=409,
            detail="不能给最后一个管理员账号设置有效期",
        )

    if payload.role is not None and not await store.get_role(payload.role):
        raise HTTPException(status_code=400, detail=f"角色 {payload.role} 不存在")

    if payload.status is not None and payload.status not in store.USER_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"未知的账号状态：{payload.status}",
        )

    # 只有真的要设覆盖时才校验 —— 关闭覆盖时 payload.permissions 没有意义，
    # store 也按 permissions_provided 决定写不写
    permissions = (
        security.validate_permissions(payload.permissions)
        if payload.set_permissions
        else None
    )

    updated = await store.update_user(
        username,
        role=payload.role,
        email=payload.email,
        enabled=payload.enabled,
        password=payload.password,
        permissions=permissions,
        permissions_provided=payload.set_permissions,
        status=payload.status,
        expires_at=payload.expires_at,
        regions=payload.regions,
        regions_provided=payload.set_regions,
    )

    detail: Dict[str, Any] = {
        "role": payload.role,
        "enabled": payload.enabled,
        "status": payload.status,
        "password_changed": bool(payload.password),
        "permissions": permissions,
        "expires_at": payload.expires_at,
        "regions": payload.regions if payload.set_regions else None,
    }

    # 动到「还能不能继续用这个凭据」的字段时，把对方的所有凭据一并作废：
    # 管理员改了密码 / 角色 / 状态，却让旧 token 继续用满 12 小时等于没改；
    # API Token 更要一起吊销 —— 它可能永不过期，漏掉它「禁用账号」就形同虚设。
    if (
        payload.password
        or payload.enabled is False
        or payload.role is not None
        or payload.status is not None
        # 把有效期设成已经过去的时间 = 立即冻结：旧 token 不能再用满 12 小时
        or (
            payload.expires_at is not None
            and 0 < payload.expires_at <= time.time()
        )
    ):
        revoked = await security.revoke_user_credentials(username)
        detail["sessions_revoked"] = revoked["sessions"]
        detail["api_tokens_revoked"] = revoked["api_tokens"]

    await security.audit(request, user, "user.update", target=username, detail=detail)
    return updated


# --------------------------------------------------------- 资源额度（用户级）
async def _quota_report(existing: Dict[str, Any]) -> Dict[str, Any]:
    """额度读数的统一形状：用户级配置 + 角色默认 + 最终生效值 + 名下用量。

    ``bypass`` 表示这个人根本不受额度约束（超管，或带 ``*`` 的自定义角色）——
    界面据此把整块置灰，免得管理员配完了以为会生效。

    ``usage`` 是顺手带上的：管理员要知道「他名下已经用了多少」才配得准。读数
    拿不到时给 ``None`` 而不是让整个请求失败 —— 「看额度」不该被一次 PVE 抖动
    挡在门外（真正下发时的额度校验仍然是 fail-closed）。
    """
    username = str(existing["username"])
    role = str(existing.get("role") or "")
    user_row = await quota.get_user_limits(username)
    role_row = await quota.get_role_limits(role)
    effective, source = quota.resolve_limits(user_row["quota"], role_row["quota"])

    usage: Optional[Dict[str, Any]] = None
    try:
        # 复用用户侧那份读数（/api/quota/me 的同一份）：三组用量的口径、以及
        # 「没配快照额度就不去逐台枚举」的取舍都只在一处维护
        report = await quota.resource_report(existing)
        groups = report.get("groups") or {}
        usage = {
            "vm": (groups.get("vm") or {}).get("usage"),
            "ct": (groups.get("ct") or {}).get("usage"),
            "snapshot": (groups.get("snapshot") or {}).get("usage"),
            "error": (groups.get("vm") or {}).get("error") or "",
        }
    except Exception:  # noqa: BLE001 - 读数拿不到不该让「看额度」失败
        pass

    return {
        "username": username,
        "role": role,
        "quota": user_row["quota"],
        "configured": user_row["configured"],
        "updated": user_row["updated"],
        "updated_by": user_row["updated_by"],
        "role_quota": role_row["quota"],
        "role_configured": role_row["configured"],
        "effective": effective,
        "source": source,
        "bypass": "*" in security.effective_permissions(existing),
        "usage": usage,
    }


@router.get("/users/{username}/quota")
async def get_user_quota(
    username: str,
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> Dict[str, Any]:
    """某个用户的资源额度（只读配置，不含用量）。

    ``users.view`` 就够：能看用户列表的人本来就看得到角色与权限覆盖，
    额度并不额外泄露什么。真正的用量读数是用户自己的 ``/api/quota/me``。
    """
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")
    return await _quota_report(existing)


@router.put("/users/{username}/quota")
async def put_user_quota(
    username: str,
    payload: QuotaIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    """设置 / 清除某个用户的资源额度。

    ``quota`` 传 ``null`` = 清除这份配置（回到继承角色默认）；传一份则整份覆盖，
    其中没填的字段表示「这一项不限制」。

    与改密码 / 改角色不同，这里**不要求二次确认**：它不动凭据，也不改变这个人
    能做什么操作，只改他能占多少资源 —— 与全局额度那条路径（``settings.manage``）
    的强度保持一致。
    """
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    before = await quota.get_user_limits(username)
    limits = payload.quota.model_dump() if payload.quota is not None else None
    saved = await quota.set_user_limits(
        username, limits, actor=str(user.get("username") or "")
    )
    await security.audit(
        request,
        user,
        "quota.user.set",
        target=username,
        detail={
            "before": before["quota"] if before["configured"] else "继承角色默认",
            "after": saved["quota"] if saved["configured"] else "继承角色默认",
        },
    )
    return await _quota_report(existing)


@router.post("/users/{username}/revoke-sessions")
async def revoke_user_sessions(
    username: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """把某个账号从所有设备上踢下线。

    会话版本 +1：所有已经发出去的 access token 立刻失效（不用等过期），
    同时撤销它的 refresh 会话 —— 否则对方刷新一下又回来了。
    """
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    revoked = await security.revoke_user_credentials(username)
    await security.audit(
        request,
        user,
        "user.revoke_sessions",
        target=username,
        detail={
            "sessions_revoked": revoked["sessions"],
            "api_tokens_revoked": revoked["api_tokens"],
        },
    )
    return {
        "ok": True,
        "sessions_revoked": revoked["sessions"],
        "api_tokens_revoked": revoked["api_tokens"],
        "token_version": revoked["token_version"],
    }


@router.post("/users/{username}/approve")
async def approve_user(
    username: str,
    payload: ApprovalRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
    # 审批 = 放行一个新账号登录面板，属于账号生命周期操作
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """审批通过一条注册申请，并当场把角色与权限定下来。

    角色/权限一起在这里给定，省掉「先通过、再编辑」两次操作。
    """
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")
    if existing.get("status", store.STATUS_ACTIVE) == store.STATUS_ACTIVE:
        raise HTTPException(status_code=409, detail=f"用户 {username} 已是正常状态")

    role_id = (payload.role or "viewer").strip()
    if not await store.get_role(role_id):
        raise HTTPException(status_code=400, detail=f"角色 {role_id} 不存在")

    permissions = (
        security.validate_permissions(payload.permissions)
        if payload.set_permissions
        else None
    )

    updated = await store.update_user(
        username,
        role=role_id,
        status=store.STATUS_ACTIVE,
        permissions=permissions,
        permissions_provided=payload.set_permissions,
    )

    role = await store.get_role(role_id) or {}
    mail_note = await _notify_decision(
        updated, "approve", role.get("name") or role_id, "", request
    )

    await security.audit(
        request, user, "user.approve", target=username,
        detail={
            "role": role_id,
            "permissions": permissions,
            "mail": mail_note,
        },
    )
    return updated


@router.post("/users/{username}/reject")
async def reject_user(
    username: str,
    payload: ApprovalRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    """拒绝一条注册申请。

    账号保留在库里（状态 rejected）而不是直接删掉：这样用户名不会被别人
    重新抢注，管理员事后也能看出「这个人申请过、被拒了」。
    """
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")
    if existing.get("status", store.STATUS_ACTIVE) == store.STATUS_REJECTED:
        raise HTTPException(status_code=409, detail=f"用户 {username} 已被拒绝过")

    updated = await store.update_user(username, status=store.STATUS_REJECTED)

    reason = (payload.reason or "").strip()
    mail_note = await _notify_decision(updated, "reject", "", reason, request)

    await security.audit(
        request, user, "user.reject", target=username,
        detail={"reason": reason, "mail": mail_note},
    )
    return updated


@router.delete("/users/{username}")
async def delete_user(
    username: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    existing = await store.get_user(username)
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 {username} 不存在")

    if existing["username"] == user["username"]:
        raise HTTPException(status_code=409, detail="不能删除当前登录的账号")

    if existing["role"] == "admin" and await store.count_admins() <= 1:
        raise HTTPException(status_code=409, detail="不能删除最后一个管理员账号")

    await store.delete_user(username)
    await security.audit(request, user, "user.delete", target=username)
    return {"deleted": True, "username": username}
