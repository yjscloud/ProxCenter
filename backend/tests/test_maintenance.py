"""维护模式：开关能存住、只挡普通用户。

这个开关最怕两件事，用例就盯着这两件：
1. **管理员也被挡住** —— 那就没人能把它关掉，整站永久停摆；
2. **关掉后不生效** —— 缓存没失效的话，管理员会以为按钮坏了，反复点。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Dict

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import maintenance  # noqa: E402
from app.config import settings  # noqa: E402

ADMIN = {"username": "admin", "password": settings.admin_password}
USER = {"username": "maint-user", "password": "Unit-Test-Pa55word"}


def _csrf(client: TestClient) -> Dict[str, str]:
    value = client.cookies.get("panel_csrf", "")
    return {"X-CSRF-Token": value} if value else {}


@pytest.fixture()
def api(clean_mysql_db):
    from app.main import app

    with TestClient(app) as client:
        yield client
    # 缓存是进程级的：不清掉会污染后面的用例（以及同一次跑里的其它文件）
    maintenance.reset_cache()


def _login_admin(api: TestClient) -> Dict[str, str]:
    resp = api.post("/api/auth/login", json=ADMIN, headers=_csrf(api))
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _create_user(api: TestClient, admin: Dict[str, str]) -> None:
    resp = api.post(
        "/api/users",
        headers={**admin, **_csrf(api)},
        json={**USER, "role": "viewer"},
    )
    assert resp.status_code in (200, 201), resp.text


def _toggle(api: TestClient, admin: Dict[str, str], enabled: bool, message: str = "") -> None:
    resp = api.put(
        "/api/panel/maintenance",
        headers={**admin, **_csrf(api)},
        json={"enabled": enabled, "message": message},
    )
    assert resp.status_code == 200, resp.text


def test_defaults_to_off(api: TestClient) -> None:
    """默认关闭；公告留空表示「用内置文案」，接口不回填默认值。"""
    body = api.get("/api/panel/maintenance").json()
    assert body == {"enabled": False, "message": ""}


def test_admin_toggles_and_public_reads_it(api: TestClient) -> None:
    admin = _login_admin(api)
    _toggle(api, admin, True, "今晚 22:00-23:00 升级存储")

    # 公开接口（未登录）：登录页就靠它决定要不要提示
    body = api.get("/api/panel/maintenance").json()
    assert body["enabled"] is True
    assert body["message"] == "今晚 22:00-23:00 升级存储"


def test_only_admin_can_toggle(api: TestClient) -> None:
    admin = _login_admin(api)
    _create_user(api, admin)
    login = api.post("/api/auth/login", json=USER, headers=_csrf(api))
    assert login.status_code == 200, login.text
    user = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = api.put(
        "/api/panel/maintenance",
        headers={**user, **_csrf(api)},
        json={"enabled": True, "message": ""},
    )
    assert resp.status_code == 403, resp.text


def test_plain_user_cannot_sign_in(api: TestClient) -> None:
    admin = _login_admin(api)
    _create_user(api, admin)
    _toggle(api, admin, True)

    resp = api.post("/api/auth/login", json=USER, headers=_csrf(api))
    assert resp.status_code == 503, resp.text
    assert resp.headers.get("x-error-code") == "maintenance"
    # detail 就是给用户看的公告，不能只剩一个状态码
    assert resp.json()["detail"].strip()


def test_admin_can_still_sign_in(api: TestClient) -> None:
    """维护期间管理员照常 —— 否则开关一开就再也没人能关掉。"""
    admin = _login_admin(api)
    _toggle(api, admin, True)

    resp = api.post("/api/auth/login", json=ADMIN, headers=_csrf(api))
    assert resp.status_code == 200, resp.text

    me = api.get("/api/auth/me", headers=admin)
    assert me.status_code == 200, me.text


def test_signed_in_user_is_pushed_out(api: TestClient) -> None:
    """维护开启前就登录的普通用户，下一个请求起就被挡（不必等会话过期）。"""
    admin = _login_admin(api)
    _create_user(api, admin)
    login = api.post("/api/auth/login", json=USER, headers=_csrf(api))
    assert login.status_code == 200, login.text
    user = {"Authorization": f"Bearer {login.json()['access_token']}"}

    assert api.get("/api/auth/me", headers=user).status_code == 200

    _toggle(api, admin, True)
    blocked = api.get("/api/auth/me", headers=user)
    assert blocked.status_code == 503
    assert blocked.headers.get("x-error-code") == "maintenance"


def test_register_is_closed(api: TestClient) -> None:
    """自助注册也属于对外服务，维护期间一并停掉。"""
    admin = _login_admin(api)
    _toggle(api, admin, True)

    resp = api.post(
        "/api/auth/register",
        json={**USER, "email": "u@example.com"},
        headers=_csrf(api),
    )
    assert resp.status_code == 503, resp.text


def test_switch_off_takes_effect_immediately(api: TestClient) -> None:
    """关掉之后立刻恢复，不用等缓存 TTL —— 否则管理员会以为没关上。"""
    admin = _login_admin(api)
    _create_user(api, admin)
    _toggle(api, admin, True)
    _toggle(api, admin, False)

    login = api.post("/api/auth/login", json=USER, headers=_csrf(api))
    assert login.status_code == 200, login.text


def test_cache_is_not_shared_with_database(api: TestClient) -> None:
    """状态是读库来的：进程内缓存被清后仍然对得上（缓存只是加速，不是事实来源）。"""
    admin = _login_admin(api)
    _toggle(api, admin, True)

    maintenance.reset_cache()
    assert api.get("/api/panel/maintenance").json()["enabled"] is True
