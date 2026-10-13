"""角色与权限目录。

角色 = 一组权限的命名预设，admin 可以自定义；创建用户时先选角色当模板，
再按需勾选调整该用户的具体权限。

约定：
* 内置角色 ``admin`` 不可修改、不可删除（避免把自己锁死）。
* 仍然有用户在使用的角色不可删除。
* 任何角色变更后调用 ``security.load_roles()`` 刷新进程内缓存。
"""
from __future__ import annotations

import secrets
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import i18n, quota, security, store
from ..schemas import QuotaIn, RoleIn

router = APIRouter(prefix="/api", tags=["roles"])


@router.get("/permissions/catalog")
async def permission_catalog(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[Dict[str, Any]]:
    """按域分组的权限清单，供勾选界面渲染（label / desc 按请求语言返回）。"""
    return i18n.localize_permission_catalog(security.PERMISSION_CATALOG)


@router.get("/roles")
async def list_roles(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[Dict[str, Any]]:
    roles = await store.list_roles()
    for item in roles:
        item["user_count"] = await store.count_users_with_role(str(item["id"]))
        # 内置角色名按请求语言返回；自定义角色名是用户输入的原文，
        # 译表里查不到就原样透传（见 i18n.tr）
        item["name"] = i18n.tr(item.get("name"))
        item["description"] = i18n.tr(item.get("description"))
    return roles


@router.post("/roles")
async def create_role(
    payload: RoleIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写角色名称")

    role_id = (payload.id or "").strip() or f"role_{secrets.token_hex(4)}"
    if await store.get_role(role_id):
        raise HTTPException(status_code=409, detail="角色标识已存在")

    # 权限键必须落在目录里：拼错一个以前是静默失效（勾了不生效、谁都不报错），
    # 而 "*" 等于凭空造出第二个超管（见 security.validate_permissions）
    permissions = security.validate_permissions(payload.permissions)

    saved = await store.save_role(
        role_id,
        name,
        payload.description or "",
        permissions,
        builtin=False,
    )
    await security.load_roles()
    await security.audit(
        request, user, "role.create", target=f"role/{role_id}",
        detail={"permissions": permissions},
    )
    saved["user_count"] = 0
    return saved


@router.put("/roles/{role_id}")
async def update_role(
    role_id: str,
    payload: RoleIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    existing = await store.get_role(role_id)
    if not existing:
        raise HTTPException(status_code=404, detail="角色不存在")
    if role_id == "admin":
        raise HTTPException(
            status_code=400, detail="内置的「超级管理员」角色不可修改"
        )

    # 同创建：权限键必须在目录里
    permissions = security.validate_permissions(payload.permissions)

    saved = await store.save_role(
        role_id,
        (payload.name or "").strip() or str(existing["name"]),
        payload.description or str(existing.get("description") or ""),
        permissions,
        builtin=bool(existing.get("builtin")),
    )
    await security.load_roles()
    await security.audit(
        request, user, "role.update", target=f"role/{role_id}",
        detail={"permissions": permissions},
    )
    saved["user_count"] = await store.count_users_with_role(role_id)
    return saved


@router.delete("/roles/{role_id}")
async def delete_role(
    role_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    existing = await store.get_role(role_id)
    if not existing:
        raise HTTPException(status_code=404, detail="角色不存在")
    if existing.get("builtin"):
        raise HTTPException(status_code=400, detail="内置角色不可删除")

    in_use = await store.count_users_with_role(role_id)
    if in_use > 0:
        raise HTTPException(
            status_code=400, detail=f"仍有 {in_use} 个用户在使用该角色，请先改派"
        )

    await store.delete_role(role_id)
    await security.load_roles()
    await security.audit(request, user, "role.delete", target=f"role/{role_id}")
    return {"deleted": role_id}


# --------------------------------------------------------- 资源额度（角色默认）
async def _role_quota_report(role_id: str) -> Dict[str, Any]:
    row = await quota.get_role_limits(role_id)
    return {
        "role": role_id,
        "quota": row["quota"],
        "configured": row["configured"],
        # 有多少人的额度会从这份默认里来 —— 界面据此提醒「改这里会影响到谁」
        "user_count": await store.count_users_with_role(role_id),
        "bypass": role_id == "admin",
    }


@router.get("/roles/{role_id}/quota")
async def get_role_quota(
    role_id: str,
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> Dict[str, Any]:
    """角色默认资源额度。没单独配过额度的用户，就按这份走。"""
    if not await store.get_role(role_id):
        raise HTTPException(status_code=404, detail="角色不存在")
    return await _role_quota_report(role_id)


@router.put("/roles/{role_id}/quota")
async def put_role_quota(
    role_id: str,
    payload: QuotaIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("users.manage")),
) -> Dict[str, Any]:
    """设置 / 清除角色默认额度。

    ``quota`` 传 ``null`` = 该角色没有默认额度（用户级也没配时不限制）。
    超管角色不收：``admin`` 本来就不受额度约束，给它配一份只会造成
    「配了会生效」的错觉 —— 与「内置超管角色不可修改」同一条理由。
    """
    if not await store.get_role(role_id):
        raise HTTPException(status_code=404, detail="角色不存在")
    if role_id == "admin":
        raise HTTPException(
            status_code=400, detail="内置的「超级管理员」不受额度限制，无需设置"
        )

    before = await quota.get_role_limits(role_id)
    limits = payload.quota.model_dump() if payload.quota is not None else None
    saved = await quota.set_role_limits(role_id, limits)
    await security.audit(
        request,
        user,
        "quota.role.set",
        target=f"role/{role_id}",
        detail={
            "before": before["quota"] if before["configured"] else "未配置",
            "after": saved["quota"] if saved["configured"] else "未配置",
        },
    )
    return await _role_quota_report(role_id)
