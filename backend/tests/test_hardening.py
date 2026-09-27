"""加固回归（第二轮）：Cookie 凭据 + CSRF、密码强度统一、审计读写、二次确认。

对应四点修复：

8. access token 从 localStorage 搬进 HttpOnly Cookie，并加 CSRF 双提交校验；
9. 管理员建号的密码强度与注册 / 自助改密统一（8 位 + 字母数字 + 非常见弱口令）；
10. 敏感数据的**读取**也进审计（连接凭据、邮件配置、审计日志本身）；
11. 危险操作（删虚拟机、改连接凭据、增删账号）要求二次确认身份。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import security  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import ADMIN, api, auth_headers  # noqa: E402,F401

WRONG = "definitely-not-the-password"
STRONG = "Str0ng-Passw0rd-For-Tests"


def _login(client):
    return client.post(
        "/api/auth/login",
        json={"username": ADMIN["username"], "password": ADMIN["password"]},
    )


def _audit_actions() -> list[str]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT action FROM audit_log")
            return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


# ------------------------------------------------------- Cookie 凭据 + CSRF
class TestCookieCredentials:
    def test_login_sets_httponly_cookies(self, api) -> None:
        resp = _login(api)
        raw = " | ".join(resp.headers.get_list("set-cookie"))
        # access / refresh / csrf 三枚 cookie 一起下发
        assert "panel_access=" in raw
        assert "panel_refresh=" in raw
        assert "panel_csrf=" in raw
        assert "HttpOnly" in raw
        assert "samesite=lax" in raw.lower()
        # access 限定在 /api，SPA 本体与静态资源不会带着它到处跑
        assert "Path=/api" in raw
        # CSRF 那枚必须能被前端 JS 读到（否则前端回填不了请求头）
        csrf_cookie = next(
            c for c in resp.headers.get_list("set-cookie") if c.startswith("panel_csrf=")
        )
        assert "HttpOnly" not in csrf_cookie

    def test_cookie_alone_authenticates(self, api) -> None:
        _login(api)
        # 不带 Authorization，只靠 cookie jar
        assert api.get("/api/auth/me").status_code == 200

    def test_logout_revokes_session_even_without_refresh_cookie(self, api) -> None:
        """登出必须撤销"当前这次登录"。

        回归用例：曾经只看 refresh cookie 找会话，于是「只带 access cookie 的
        客户端」（或 refresh cookie 被清掉的浏览器）登出后，那枚 access token
        还能继续用满 12 小时。
        """
        _login(api)
        access = api.cookies.get(security.ACCESS_COOKIE)
        assert access

        resp = api.post(
            "/api/auth/logout",
            cookies={security.ACCESS_COOKIE: access},  # 故意不带 refresh cookie
            headers={"X-CSRF-Token": api.cookies.get("panel_csrf", "")},
        )
        assert resp.status_code == 200
        assert api.get("/api/auth/me", cookies={security.ACCESS_COOKIE: access}).status_code == 401

    def test_logout_clears_all_cookies(self, api) -> None:
        _login(api)
        resp = api.post(
            "/api/auth/logout",
            headers={"X-CSRF-Token": api.cookies.get("panel_csrf", "")},
        )
        assert resp.status_code == 200
        raw = " | ".join(resp.headers.get_list("set-cookie")).lower()
        assert "panel_access=" in raw and "panel_csrf=" in raw
        assert "max-age=0" in raw  # 三个 cookie 都被要求立即失效
        assert api.get("/api/auth/me").status_code == 401


class TestCsrf:
    def test_cookie_post_without_token_is_rejected(self, api) -> None:
        """拿着 cookie 却拿不出 CSRF 令牌 —— 这是跨站伪造的典型特征。

        ``api`` fixture 给 post/put/... 自动补了 CSRF 头（等价前端拦截器），
        这里用 ``request`` 绕开它，模拟「跨站页面拿不到 Cookie」的情形。
        """
        _login(api)
        resp = api.request("POST", "/api/auth/logout")
        assert resp.status_code == 403
        assert "CSRF" in resp.json()["detail"]

    def test_cookie_post_with_token_passes(self, api) -> None:
        _login(api)
        resp = api.post(
            "/api/auth/logout",
            headers={"X-CSRF-Token": api.cookies.get("panel_csrf", "")},
        )
        assert resp.status_code == 200

    def test_tampered_token_is_rejected(self, api) -> None:
        _login(api)
        resp = api.post("/api/auth/logout", headers={"X-CSRF-Token": "not-the-real-one"})
        assert resp.status_code == 403

    def test_bearer_client_is_exempt(self, api) -> None:
        """显式 Authorization 的脚本客户端没有环境凭据，不该被 CSRF 拦。"""
        token = _login(api).json()["access_token"]
        resp = api.request(
            "POST",
            "/api/auth/logout",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

    def test_safe_methods_are_exempt(self, api) -> None:
        _login(api)
        assert api.get("/api/config/connection").status_code == 200


# ------------------------------------------------------------- 密码强度统一
class TestPasswordPolicy:
    def _elevated(self, api):
        headers = auth_headers(api)
        resp = api.post(
            "/api/auth/step-up",
            headers=headers,
            json={"password": ADMIN["password"]},
        )
        assert resp.status_code == 200, resp.text
        return headers

    def test_rules(self) -> None:
        assert security.password_policy_error("abc123") != ""  # 太短
        assert security.password_policy_error("abcdefgh") != ""  # 没数字
        assert security.password_policy_error("12345678") != ""  # 没字母
        assert security.password_policy_error("password123") != ""  # 常见弱口令
        assert security.password_policy_error(STRONG) == ""

    def test_admin_create_rejects_short_password(self, api) -> None:
        headers = self._elevated(api)
        resp = api.post(
            "/api/users",
            headers=headers,
            json={"username": "shorty", "password": "abc123", "role": "viewer"},
        )
        assert resp.status_code == 422  # schema 层就挡住 6 位这种旧下限

    def test_admin_create_rejects_common_weak_password(self, api) -> None:
        headers = self._elevated(api)
        resp = api.post(
            "/api/users",
            headers=headers,
            json={"username": "weakling", "password": "password123", "role": "viewer"},
        )
        assert resp.status_code == 400
        assert "常见" in resp.json()["detail"]

    def test_admin_create_accepts_strong_password(self, api) -> None:
        headers = self._elevated(api)
        resp = api.post(
            "/api/users",
            headers=headers,
            json={"username": "okuser", "password": STRONG, "role": "viewer"},
        )
        assert resp.status_code == 200, resp.text

    def test_register_rejects_short_password(self, api) -> None:
        resp = api.post(
            "/api/auth/register",
            json={"username": "newbie", "password": "abc123", "email": "a@b.com"},
        )
        assert resp.status_code == 422


# ------------------------------------------------------------ 敏感读取审计
class TestAuditReads:
    def test_connection_config_read_is_audited(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/config/connection", headers=headers).status_code == 200
        assert "config.connection.read" in _audit_actions()

    def test_connections_list_read_is_audited(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/connections", headers=headers).status_code == 200
        assert "config.connections.read" in _audit_actions()

    def test_audit_log_read_is_audited(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/audit", headers=headers).status_code == 200
        assert "audit.read" in _audit_actions()


# --------------------------------------------------------- 敏感操作二次确认
class TestStepUp:
    """conftest 默认关掉二次确认（免得拦住其它业务用例），这里按需打开。"""

    @pytest.fixture(autouse=True)
    def _step_up_on(self, monkeypatch):
        monkeypatch.setattr(settings, "step_up_required", True)

    def test_dangerous_operation_requires_step_up(self, api) -> None:
        resp = api.post(
            "/api/users",
            headers=auth_headers(api),
            json={"username": "blocked", "password": STRONG, "role": "viewer"},
        )
        assert resp.status_code == 403
        assert resp.headers.get("x-step-up") == "required"
        assert "二次确认" in resp.json()["detail"]

    def test_wrong_password_does_not_elevate(self, api) -> None:
        headers = auth_headers(api)
        resp = api.post(
            "/api/auth/step-up", headers=headers, json={"password": WRONG}
        )
        assert resp.status_code == 400
        # 仍然做不了敏感操作
        assert (
            api.post(
                "/api/users",
                headers=headers,
                json={"username": "still-blocked", "password": STRONG, "role": "viewer"},
            ).status_code
            == 403
        )

    def test_step_up_unlocks_dangerous_operation(self, api) -> None:
        headers = auth_headers(api)
        assert (
            api.post(
                "/api/auth/step-up",
                headers=headers,
                json={"password": ADMIN["password"]},
            ).status_code
            == 200
        )
        resp = api.post(
            "/api/users",
            headers=headers,
            json={"username": "allowed", "password": STRONG, "role": "viewer"},
        )
        assert resp.status_code == 200, resp.text
        assert "auth.step_up" in _audit_actions()

    def test_connection_write_requires_step_up(self, api) -> None:
        resp = api.put(
            "/api/config/connection",
            headers=auth_headers(api),
            json={"host": "10.0.0.9", "port": 8006, "token_id": "a@pve!t"},
        )
        assert resp.status_code == 403
        assert resp.headers.get("x-step-up") == "required"

    def test_vm_delete_requires_step_up(self, api) -> None:
        headers = auth_headers(api)
        # 先随便挑一台存在的虚拟机（mock PVE 里有）
        vms = api.get("/api/vms", headers=headers).json()
        assert vms, "mock 环境里没有虚拟机"
        node = vms[0]["node"]
        vmid = vms[0]["vmid"]
        resp = api.delete(f"/api/vms/{node}/{vmid}", headers=headers)
        assert resp.status_code == 403
        assert resp.headers.get("x-step-up") == "required"

    def test_step_up_can_be_disabled(self, api, monkeypatch) -> None:
        monkeypatch.setattr(settings, "step_up_required", False)
        resp = api.post(
            "/api/users",
            headers=auth_headers(api),
            json={"username": "no-step-up", "password": STRONG, "role": "viewer"},
        )
        assert resp.status_code == 200, resp.text


# --------------------------------------------------------------- WS 鉴权
class TestWebsocketHelpers:
    class _FakeWs:
        def __init__(self, cookies=None, headers=None):
            self.cookies = cookies or {}
            self.headers = headers or {}

    def test_ws_token_prefers_query_then_cookie(self) -> None:
        ws = self._FakeWs(cookies={security.ACCESS_COOKIE: "cookie-token"})
        assert security.ws_token(ws, "query-token") == "query-token"
        assert security.ws_token(ws, "") == "cookie-token"
        assert security.ws_token(self._FakeWs(), "") == ""

    def test_ws_origin_must_match_host(self) -> None:
        same = self._FakeWs(
            headers={"origin": "https://panel.example.com", "host": "panel.example.com"}
        )
        cross = self._FakeWs(
            headers={"origin": "https://evil.example", "host": "panel.example.com"}
        )
        script = self._FakeWs(headers={})
        assert security.ws_origin_allowed(same) is True
        assert security.ws_origin_allowed(cross) is False
        # 非浏览器客户端不带 Origin：放行（它也不带 cookie）
        assert security.ws_origin_allowed(script) is True

    def test_ws_without_credentials_is_closed(self, api) -> None:
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with api.websocket_connect("/api/ws/tasks") as ws:
                ws.receive_json()
