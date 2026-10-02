"""Panel user management."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import i18n, mailer, panel_url, prefs, security, store
from ..schemas import ApprovalRequest, UserCreate, UserUpdate


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
    """角色目录（含 admin 自建的角色），用于用户界面的下拉与权限预勾选。"""
    roles = await store.list_roles()
    return [
        {
            # 同时给出 id 与 role：前端新的角色模型用 id，旧代码用 role
            "id": item["id"],
            "role": item["id"],
            # 内置角色的名称与说明按请求语言返回（与 /api/roles 保持一致，
            # 否则这里会原样吐出库里存的中文，英文界面下角色卡片仍是中文）。
            # 自定义角色是用户自己起的名字，译表查不到就原样透传（见 i18n.tr）。
            "name": i18n.tr(item.get("name") or item["id"]),
            "description": i18n.tr(item.get("description") or ""),
            "permissions": item.get("permissions") or [],
            "builtin": bool(item.get("builtin")),
        }
        for item in roles
    ]


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

    created = await store.create_user(
        payload.username,
        payload.password,
        role_id,
        payload.email,
        permissions=payload.permissions,
    )

    await security.audit(
        request, user, "user.create", target=payload.username,
        detail={
            "role": role_id,
            "permissions": payload.permissions,
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

    if payload.role is not None and not await store.get_role(payload.role):
        raise HTTPException(status_code=400, detail=f"角色 {payload.role} 不存在")

    if payload.status is not None and payload.status not in store.USER_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"未知的账号状态：{payload.status}",
        )

    updated = await store.update_user(
        username,
        role=payload.role,
        email=payload.email,
        enabled=payload.enabled,
        password=payload.password,
        permissions=payload.permissions,
        permissions_provided=payload.set_permissions,
        status=payload.status,
    )

    detail: Dict[str, Any] = {
        "role": payload.role,
        "enabled": payload.enabled,
        "status": payload.status,
        "password_changed": bool(payload.password),
        "permissions": payload.permissions if payload.set_permissions else None,
    }

    # 动到「还能不能继续用这个凭据」的字段时，把对方的所有凭据一并作废：
    # 管理员改了密码 / 角色 / 状态，却让旧 token 继续用满 12 小时等于没改；
    # API Token 更要一起吊销 —— 它可能永不过期，漏掉它「禁用账号」就形同虚设。
    if (
        payload.password
        or payload.enabled is False
        or payload.role is not None
        or payload.status is not None
    ):
        revoked = await security.revoke_user_credentials(username)
        detail["sessions_revoked"] = revoked["sessions"]
        detail["api_tokens_revoked"] = revoked["api_tokens"]

    await security.audit(request, user, "user.update", target=username, detail=detail)
    return updated


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

    updated = await store.update_user(
        username,
        role=role_id,
        status=store.STATUS_ACTIVE,
        permissions=payload.permissions,
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
            "permissions": payload.permissions if payload.set_permissions else None,
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
