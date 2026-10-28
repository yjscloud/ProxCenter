"""授权链：被委派者不能授予自己没有的权限，也不能自我提权。

漏洞形态（修复前）：``POST/PUT /api/users`` 只校验「授予的东西合法」（角色存在、
权限键在目录里、``*`` 被拒），从不校验「这个人能不能授予它」。于是任何拿到
``users.manage`` 的账号都能：

* ``PUT /api/users/{自己} {"role": "admin"}`` —— 一步变成超管；
* ``POST /api/users {"role": "admin"}`` —— 建一个小号；
* ``PUT /api/users/admin {"password": ...}`` —— 直接接管超管账号；
* ``PUT /api/roles/{某个角色}`` 加上自己没有的权限 —— 借角色间接提权。

下面按这四条路径逐个钉死，同时保留「管理员照常授权」与「能管比自己弱的账号」。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: E402,F401

from app import security  # noqa: E402

PASSWORD = "Unit-Test-Pa55word"


# ------------------------------------------------------------ 纯函数：可授予集合

def test_own_permissions_expands_wildcard() -> None:
    """``*`` 必须展开成整个目录，否则会得出「超管一个权限都没有」的反向结论。"""
    actor = {"role": "x", "permissions_override": ["*"]}
    assert security.own_permissions(actor) == security.permission_keys()


def test_own_permissions_ignores_unknown_keys() -> None:
    """目录外的历史键不生效，也就不该被转授。"""
    actor = {"role": "x", "permissions_override": ["users.manage", "legacy.whatever"]}
    assert security.own_permissions(actor) == {"users.manage"}


def test_cannot_grant_permission_not_owned() -> None:
    actor = {"username": "helpdesk", "role": "x", "permissions_override": ["users.manage"]}
    security.ensure_can_grant_permissions(actor, ["users.manage"])  # 不抛

    with pytest.raises(HTTPException) as exc:
        security.ensure_can_grant_permissions(
            actor, ["users.manage", "settings.manage"]
        )
    assert exc.value.status_code == 403
    # 报错要指到具体权限点：目录里的 label 有重名（两个「管理」），只给中文名分不清
    assert "settings.manage" in str(exc.value.detail)


def test_wildcard_actor_can_grant_anything() -> None:
    actor = {"role": "x", "permissions_override": ["*"]}
    security.ensure_can_grant_permissions(actor, sorted(security.permission_keys()))


def test_empty_permissions_are_always_fine() -> None:
    security.ensure_can_grant_permissions({"role": "viewer"}, None)
    security.ensure_can_grant_permissions({"role": "viewer"}, [])


# ------------------------------------------------------------ 接口：四条提权路径

def _delegate(api, name: str = "helpdesk") -> dict:
    """只握 vm.view + users.view + users.manage 的被委派用户管理员。"""
    return user_with_permissions(
        api, ["vm.view", "users.view", "users.manage"], name
    )


def _weak_user(api, admin: dict, name: str = "weak") -> None:
    """一个比被委派者权限更低的普通账号（只有 vm.view）。"""
    resp = api.post(
        "/api/users",
        headers=admin,
        json={
            "username": name,
            "password": PASSWORD,
            "role": "viewer",
            "permissions": ["vm.view"],
        },
    )
    assert resp.status_code in (200, 201), resp.text


def test_delegate_cannot_promote_self_to_admin(api) -> None:
    admin = auth_headers(api)
    helpdesk = _delegate(api)

    resp = api.put("/api/users/helpdesk", headers=helpdesk, json={"role": "admin"})
    assert resp.status_code == 403, resp.text
    assert api.get("/api/users/helpdesk", headers=admin).json()["role"] == "helpdesk-readonly"


def test_delegate_cannot_grant_self_extra_permissions(api) -> None:
    helpdesk = _delegate(api)

    resp = api.put(
        "/api/users/helpdesk",
        headers=helpdesk,
        json={
            "permissions": ["vm.view", "users.view", "users.manage", "settings.manage"],
            "set_permissions": True,
        },
    )
    assert resp.status_code == 403, resp.text


def test_delegate_cannot_create_admin(api) -> None:
    helpdesk = _delegate(api)

    resp = api.post(
        "/api/users",
        headers=helpdesk,
        json={"username": "sneaky", "password": PASSWORD, "role": "admin"},
    )
    assert resp.status_code == 403, resp.text


def test_delegate_cannot_reset_admin_password(api) -> None:
    """不改权限也能接管：重置超管密码是一条等价路径。"""
    helpdesk = _delegate(api)

    resp = api.put(
        "/api/users/admin", headers=helpdesk, json={"password": "Hijack-Pa55word"}
    )
    assert resp.status_code == 403, resp.text


def test_delegate_cannot_assign_overprivileged_role(api) -> None:
    admin = auth_headers(api)
    helpdesk = _delegate(api)
    _weak_user(api, admin)

    created = api.post(
        "/api/roles",
        headers=admin,
        json={
            "id": "settings-only",
            "name": "settings-only",
            "permissions": ["settings.manage"],
        },
    )
    assert created.status_code in (200, 201), created.text

    resp = api.put("/api/users/weak", headers=helpdesk, json={"role": "settings-only"})
    assert resp.status_code == 403, resp.text


def test_delegate_cannot_create_role_with_excess_permissions(api) -> None:
    helpdesk = _delegate(api)

    resp = api.post(
        "/api/roles",
        headers=helpdesk,
        json={"id": "mine", "name": "mine", "permissions": ["settings.manage"]},
    )
    assert resp.status_code == 403, resp.text


def test_delegate_cannot_edit_role_beyond_own_permissions(api) -> None:
    helpdesk = _delegate(api)

    resp = api.put(
        "/api/roles/helpdesk-readonly",
        headers=helpdesk,
        json={
            "id": "helpdesk-readonly",
            "name": "helpdesk-readonly",
            "permissions": [
                "vm.view",
                "users.view",
                "users.manage",
                "settings.manage",
            ],
        },
    )
    assert resp.status_code == 403, resp.text


def test_delegate_can_still_manage_weaker_account(api) -> None:
    """收紧不等于把人锁死：比自己弱的账号照常能管。"""
    admin = auth_headers(api)
    helpdesk = _delegate(api)
    _weak_user(api, admin)

    resp = api.put(
        "/api/users/weak", headers=helpdesk, json={"password": "Other-Pa55word"}
    )
    assert resp.status_code == 200, resp.text


def test_delegate_cannot_delete_stronger_account(api) -> None:
    helpdesk = _delegate(api)
    resp = api.delete("/api/users/admin", headers=helpdesk)
    assert resp.status_code == 403, resp.text


def test_admin_can_still_grant_admin(api) -> None:
    admin = auth_headers(api)
    resp = api.post(
        "/api/users",
        headers=admin,
        json={"username": "second-admin", "password": PASSWORD, "role": "admin"},
    )
    assert resp.status_code in (200, 201), resp.text


def test_admin_can_edit_own_profile_without_privilege_change(api) -> None:
    """原样提交表单（值没变）不该被自我提权拦截误伤。"""
    admin = auth_headers(api)
    resp = api.put(
        "/api/users/admin",
        headers=admin,
        json={"email": "admin@example.com", "role": "admin", "enabled": True},
    )
    assert resp.status_code == 200, resp.text
