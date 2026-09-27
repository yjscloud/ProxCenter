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

from .. import security, store
from ..schemas import RoleIn

router = APIRouter(prefix="/api", tags=["roles"])


@router.get("/permissions/catalog")
async def permission_catalog(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[Dict[str, Any]]:
    """按域分组的权限清单，供勾选界面渲染。"""
    return security.PERMISSION_CATALOG


@router.get("/roles")
async def list_roles(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> List[Dict[str, Any]]:
    roles = await store.list_roles()
    for item in roles:
        item["user_count"] = await store.count_users_with_role(str(item["id"]))
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

    saved = await store.save_role(
        role_id,
        name,
        payload.description or "",
        payload.permissions,
        builtin=False,
    )
    await security.load_roles()
    await security.audit(
        request, user, "role.create", target=f"role/{role_id}",
        detail={"permissions": sorted(set(payload.permissions))},
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

    saved = await store.save_role(
        role_id,
        (payload.name or "").strip() or str(existing["name"]),
        payload.description or str(existing.get("description") or ""),
        payload.permissions,
        builtin=bool(existing.get("builtin")),
    )
    await security.load_roles()
    await security.audit(
        request, user, "role.update", target=f"role/{role_id}",
        detail={"permissions": sorted(set(payload.permissions))},
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
