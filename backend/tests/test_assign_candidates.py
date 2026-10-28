"""指派归属的两个前提：角色真的有这项权限、选人清单对非管理面角色可用。

背景：区域管理员有 ``vm.assign`` / ``ct.assign`` 却没有 ``users.view``。
前端拿 ``isAdmin`` 判入口 → 菜单项直接不出现；就算出现了，选人框打
``GET /users`` 也是 403（看起来像「下拉里没有任何人」）。两处都会让这个
角色「能管的机器一堆，却一台也指派不出去」。
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

import pytest

from app import security
from app.routers import users as users_router


def test_region_admin_ships_both_assign_keys():
    """区域管理员的角色模板必须自带 vm.assign / ct.assign。

    这条一旦退化，界面上的入口会跟着消失（``hasPermission`` 读的就是这份），
    而报障会描述成「缺少指派选项」而不是「角色少了权限」。
    """
    perms = set(security.ROLE_PERMISSIONS["region_admin"])
    assert {"vm.assign", "ct.assign"} <= perms
    # 普通角色不该有：归属改派是管理动作（见 security.PERMISSION_ROLES）
    for role in ("operator", "viewer"):
        assert "vm.assign" not in security.ROLE_PERMISSIONS[role], role
        assert "ct.assign" not in security.ROLE_PERMISSIONS[role], role


def _patch_users(monkeypatch: pytest.MonkeyPatch, rows: List[Dict[str, Any]]) -> None:
    async def _list_users(status: Optional[str] = None) -> List[Dict[str, Any]]:
        return rows

    monkeypatch.setattr(users_router.store, "list_users", _list_users)


def test_assignable_lists_only_usable_accounts(monkeypatch: pytest.MonkeyPatch) -> None:
    """只列能登录的账号，且只回用户名 / 角色 id。"""
    _patch_users(
        monkeypatch,
        [
            {"username": "alice", "role": "operator", "enabled": True,
             "status": "active", "email": "alice@example.com"},
            {"username": "bob", "role": "operator", "enabled": False, "status": "active"},
            {"username": "carol", "role": "viewer", "enabled": True, "status": "pending"},
        ],
    )

    rows = asyncio.run(users_router.list_assignable_users(user={"role": "region_admin"}))

    assert [row["username"] for row in rows] == ["alice"]
    # 邮箱 / 状态 / 区域这些一个都不能带出来：区域管理员只管机器，
    # 开通整个账号目录是另一码事（要 users.view）
    assert set(rows[0]) == {"username", "role"}
