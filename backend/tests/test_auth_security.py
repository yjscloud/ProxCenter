"""鉴权加固回归：登录失败锁定、refresh/真登出、两步验证、全局限流。

这四个特性都依赖 MySQL（计数、会话都在库里），所以直接用
``test_api_routes`` 的 ``api`` fixture：它给一个连着 mock Proxmox 的
TestClient + 一个每用例重建的空库。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pyotp
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import security  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import ADMIN, api, auth_headers  # noqa: E402,F401

WRONG = "definitely-not-the-password"


def _throttle_row(bucket: str):
    """直接读限流表：断言「有没有被锁、计了多少次」。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT hits, blocked_until FROM rate_limits WHERE bucket = %s",
                (bucket,),
            )
            return cursor.fetchone()
    finally:
        conn.close()


def _session_revoked(jti: str) -> bool:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT revoked FROM refresh_tokens WHERE jti = %s", (jti,)
            )
            row = cursor.fetchone()
            return bool(row and row[0])
    finally:
        conn.close()


def _login(client, password: str = ""):
    """登录请求。

    TestClient 会保存 Set-Cookie：一旦这个客户端已经登录过，后面的写请求就
    按「Cookie 认证」处理，必须带 CSRF 头（浏览器里由前端拦截器自动回填）。
    """
    csrf = client.cookies.get("panel_csrf", "")
    headers = {"X-CSRF-Token": csrf} if csrf else {}
    return client.post(
        "/api/auth/login",
        json={"username": ADMIN["username"], "password": password or ADMIN["password"]},
        headers=headers,
    )


def _bearer(token: str):
    return {"Authorization": f"Bearer {token}"}


def _csrf(client) -> Dict[str, str]:
    """Cookie 认证下的写请求必须带 CSRF 头（浏览器里由前端拦截器自动回填）。"""
    value = client.cookies.get("panel_csrf", "")
    return {"X-CSRF-Token": value} if value else {}


def _token(client) -> str:
    resp = _login(client)
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


# --------------------------------------------------------------- 登录失败锁定
class TestLoginLockout:
    def test_locks_account_after_max_failures(self, api) -> None:
        for _ in range(settings.login_max_failures):
            assert _login(api, WRONG).status_code == 401

        # 第 N 次失败就把账号锁进库里（不是只在内存里记着）
        row = _throttle_row(f"login:user:{ADMIN['username']}")
        assert row is not None, "失败计数没有落库"
        assert row[0] >= settings.login_max_failures
        assert row[1] > time.time(), "达到上限后没有写入锁定截止时间"

        # 锁定期内：口令正确也进不来（连 bcrypt 都不跑）
        locked = _login(api)
        assert locked.status_code == 429
        assert locked.headers.get("retry-after")

    def test_successful_login_clears_failures(self, api) -> None:
        for _ in range(settings.login_max_failures - 2):
            assert _login(api, WRONG).status_code == 401
        assert _login(api).status_code == 200
        # 计数已清零：再来几次错误仍然进得来
        for _ in range(settings.login_max_failures - 1):
            assert _login(api, WRONG).status_code == 401
        assert _login(api).status_code == 200

    def test_captcha_failure_does_not_count(self, api, monkeypatch) -> None:
        """验证码错不算口令失败：否则一张错图就能把别人的账号锁死。"""
        monkeypatch.setattr(settings, "login_captcha", True)
        for _ in range(settings.login_max_failures + 2):
            resp = api.post(
                "/api/auth/login",
                json={
                    "username": ADMIN["username"],
                    "password": ADMIN["password"],
                    "captcha_id": "nope",
                    "captcha_code": "0000",
                },
            )
            assert resp.status_code == 400

        # 计数压根没涨：连计数行都不该存在
        assert _throttle_row(f"login:user:{ADMIN['username']}") is None
        # 关掉验证码后正常登录仍然通过
        monkeypatch.setattr(settings, "login_captcha", False)
        assert _login(api).status_code == 200


# ------------------------------------------------------------ refresh / 登出
class TestSessionsAndLogout:
    def test_login_sets_refresh_cookie(self, api) -> None:
        resp = _login(api)
        cookie = resp.cookies.get(security.REFRESH_COOKIE)
        assert cookie, "登录没有下发 refresh cookie"
        payload = security.decode_token(cookie, expected_typ="refresh")
        assert payload["sub"] == ADMIN["username"]

    def test_refresh_rotates_session(self, api) -> None:
        cookie = _login(api).cookies.get(security.REFRESH_COOKIE)
        old_jti = security.decode_token(cookie, expected_typ="refresh")["jti"]

        rotated = api.post("/api/auth/refresh", headers=_csrf(api))
        assert rotated.status_code == 200
        assert rotated.json()["access_token"]
        new_cookie = rotated.cookies.get(security.REFRESH_COOKIE)
        assert new_cookie and new_cookie != cookie

        # 旧会话在服务端已被撤销：旧 refresh token 不再可用（防重放）
        assert _session_revoked(old_jti)

    def test_refresh_rejects_access_token_as_cookie(self, api) -> None:
        """access token 塞进 cookie 也没用：typ 不匹配直接 401。"""
        token = _token(api)
        resp = api.post(
            "/api/auth/refresh",
            cookies={security.REFRESH_COOKIE: token},
            headers=_csrf(api),
        )
        assert resp.status_code == 401

    def test_logout_kills_token_immediately(self, api) -> None:
        token = _token(api)
        assert api.get("/api/auth/me", headers=_bearer(token)).status_code == 200

        assert api.post("/api/auth/logout", headers=_bearer(token)).status_code == 200
        # 不等 token 自然过期：下一个请求就被拒
        assert api.get("/api/auth/me", headers=_bearer(token)).status_code == 401

    def test_logout_all_invalidates_every_device(self, api) -> None:
        first = _token(api)
        second = _token(api)

        resp = api.post("/api/auth/logout-all", headers=_bearer(second))
        assert resp.status_code == 200
        for token in (first, second):
            assert api.get("/api/auth/me", headers=_bearer(token)).status_code == 401

    def test_session_list_and_revoke_single_device(self, api) -> None:
        first = _token(api)
        second = _token(api)
        first_sid = security.decode_token(first, expected_typ="access")["sid"]

        data = api.get("/api/auth/sessions", headers=_bearer(second)).json()["sessions"]
        assert len(data) == 2
        assert sum(1 for s in data if s["current"]) == 1

        target = next(s for s in data if s["id"] == first_sid)
        assert target["current"] is False
        assert (
            api.delete(f"/api/auth/sessions/{first_sid}", headers=_bearer(second)).status_code
            == 200
        )
        # 被踢的设备：access token 也立刻失效；自己这台不受影响
        assert api.get("/api/auth/me", headers=_bearer(first)).status_code == 401
        assert api.get("/api/auth/me", headers=_bearer(second)).status_code == 200

    def test_change_password_kicks_other_devices(self, api) -> None:
        other = _token(api)  # 另一台设备
        assert api.get("/api/auth/me", headers=_bearer(other)).status_code == 200

        current = _token(api)
        resp = api.post(
            "/api/auth/password",
            headers=_bearer(current),
            json={
                "current_password": ADMIN["password"],
                "new_password": "Brand-New-Pa55w0rd!",
            },
        )
        assert resp.status_code == 200, resp.text
        # 改完密码：旧设备下线，本次请求换到的新令牌仍然可用
        assert api.get("/api/auth/me", headers=_bearer(other)).status_code == 401
        fresh = resp.json()["access_token"]
        assert api.get("/api/auth/me", headers=_bearer(fresh)).status_code == 200
        assert resp.json()["other_sessions_revoked"] >= 1


# ------------------------------------------------------------ 两步验证（TOTP）
class TestTwoFactor:
    def _enable(self, client, token: str):
        setup = client.post("/api/auth/2fa/setup", headers=_bearer(token))
        assert setup.status_code == 200, setup.text
        body = setup.json()
        assert body["qr_png"].startswith("data:image/png;base64,")
        assert body["otpauth_url"].startswith("otpauth://totp/")

        code = pyotp.TOTP(body["secret"]).now()
        enabled = client.post(
            "/api/auth/2fa/enable", headers=_bearer(token), json={"code": code}
        )
        assert enabled.status_code == 200, enabled.text
        return body["secret"], enabled.json()["recovery_codes"]

    def test_login_requires_second_step(self, api) -> None:
        secret, _ = self._enable(api, _token(api))

        step1 = _login(api)
        body = step1.json()
        assert body["mfa_required"] is True
        assert body["access_token"] == ""
        assert body["user"] is None

        step2 = api.post(
            "/api/auth/login/2fa",
            headers=_csrf(api),
            json={
                "mfa_token": body["mfa_token"],
                "code": pyotp.TOTP(secret).now(),
            },
        )
        assert step2.status_code == 200, step2.text
        assert step2.json()["access_token"]
        assert step2.json()["user"]["username"] == ADMIN["username"]

    def test_wrong_code_locks_like_password(self, api) -> None:
        """动态码也是 6 位数字，同样会被爆破：错的次数一样要计数、一样会锁。"""
        self._enable(api, _token(api))
        for _ in range(settings.login_max_failures):
            body = _login(api).json()
            resp = api.post(
                "/api/auth/login/2fa",
                headers=_csrf(api),
                json={"mfa_token": body["mfa_token"], "code": "000000"},
            )
            assert resp.status_code == 401
        # 锁定生效：动态码正确也进不去
        body = _login(api)
        assert body.status_code == 429

    def test_recovery_code_is_single_use(self, api) -> None:
        _, codes = self._enable(api, _token(api))
        recovery = codes[0]

        first = api.post(
            "/api/auth/login/2fa",
            headers=_csrf(api),
            json={"mfa_token": _login(api).json()["mfa_token"], "code": recovery},
        )
        assert first.status_code == 200, first.text

        second = api.post(
            "/api/auth/login/2fa",
            headers=_csrf(api),
            json={"mfa_token": _login(api).json()["mfa_token"], "code": recovery},
        )
        assert second.status_code == 401

    def test_disable_needs_password_and_code(self, api) -> None:
        token = _token(api)
        secret, _ = self._enable(api, token)

        bad = api.post(
            "/api/auth/2fa/disable",
            headers=_bearer(token),
            json={"password": WRONG, "code": pyotp.TOTP(secret).now()},
        )
        assert bad.status_code == 400

        ok = api.post(
            "/api/auth/2fa/disable",
            headers=_bearer(token),
            json={"password": ADMIN["password"], "code": pyotp.TOTP(secret).now()},
        )
        assert ok.status_code == 200
        assert api.get("/api/auth/2fa", headers=_bearer(token)).json()["enabled"] is False

    def test_required_role_is_blocked_until_enabled(self, api, monkeypatch) -> None:
        monkeypatch.setattr(settings, "totp_required_roles", "admin")
        token = _token(api)

        status = api.get("/api/auth/2fa", headers=_bearer(token)).json()
        assert status["required"] is True and status["enabled"] is False
        # 2FA 之外的接口一律拦住
        blocked = api.get("/api/users", headers=_bearer(token))
        assert blocked.status_code == 403
        assert "两步验证" in blocked.json()["detail"]

        self._enable(api, token)
        assert api.get("/api/users", headers=_bearer(token)).status_code == 200

    def test_required_role_cannot_disable(self, api, monkeypatch) -> None:
        token = _token(api)
        secret, _ = self._enable(api, token)
        monkeypatch.setattr(settings, "totp_required_roles", "admin")
        resp = api.post(
            "/api/auth/2fa/disable",
            headers=_bearer(token),
            json={"password": ADMIN["password"], "code": pyotp.TOTP(secret).now()},
        )
        assert resp.status_code == 403


def _enable_2fa(client):
    """给管理员开启两步验证，返回 ``(secret, recovery_codes)``。

    复用 :class:`TestTwoFactor` 里那套 setup → enable 的调用，避免两处各写一遍、
    日后改接口时漏掉一处。
    """
    return TestTwoFactor()._enable(client, _token(client))


# ------------------------------------------------------- 信任设备（7 天免第二步）
class TestTrustedDevice:
    """登录时勾了「信任设备」之后的免二次校验行为。

    这一组是**安全回归**：信任设备等于把第二因子在一台浏览器上关掉 7 天，
    所以每个「不该被信任」的边界都要有断言 —— 别人的 cookie、换过密码、
    关了又开 2FA、管理员关掉面板开关。
    """

    def _trust(self, client, secret: str):
        """走完两步验证并勾上「信任设备」，返回第二步响应。"""
        step1 = _login(client).json()
        assert step1["mfa_required"] is True
        return client.post(
            "/api/auth/login/2fa",
            headers=_csrf(client),
            json={
                "mfa_token": step1["mfa_token"],
                "code": pyotp.TOTP(secret).now(),
                "trust_device": True,
            },
        )

    def test_trusted_device_skips_the_second_step(self, api) -> None:
        secret, _ = _enable_2fa(api)

        step2 = self._trust(api, secret)
        assert step2.status_code == 200, step2.text
        assert api.cookies.get("panel_trusted")

        # 关键断言：再登录一次，**没有 mfa_required**，直接拿到会话
        again = _login(api)
        body = again.json()
        assert body["mfa_required"] is not True
        assert body["access_token"]
        assert api.get("/api/auth/me", headers=_bearer(body["access_token"])).status_code == 200

    def test_without_the_checkbox_the_request_is_still_challenged(self, api) -> None:
        """不勾就不该签信任 —— 默认收紧，勾选是用户主动的让步。"""
        secret, _ = _enable_2fa(api)
        step1 = _login(api).json()
        api.post(
            "/api/auth/login/2fa",
            headers=_csrf(api),
            json={"mfa_token": step1["mfa_token"], "code": pyotp.TOTP(secret).now()},
        )
        assert not api.cookies.get("panel_trusted")
        assert _login(api).json()["mfa_required"] is True

    def test_password_is_still_required(self, api) -> None:
        """信任设备跳过的是第二因子，不是密码 —— 拿错口令照样进不去。"""
        secret, _ = _enable_2fa(api)
        assert self._trust(api, secret).status_code == 200

        assert _login(api, WRONG).status_code == 401

    def test_change_password_forgets_trusted_devices(self, api) -> None:
        """改密码必须把信任设备一起清掉，否则「改密码赶人」赶不走这台。

        归属绑定（别人的 cookie 不能替别人跳过）由
        ``test_trusteddevices.py::test_is_trusted_requires_the_same_username``
        在模块层直接覆盖 —— 那条 SQL 条件就是这条防线的全部，不必绕一大圈
        在接口层再造一个开了 2FA 的账号来验。
        """
        secret, _ = _enable_2fa(api)
        assert self._trust(api, secret).status_code == 200
        assert _count_trusted() == 1

        token = _token(api)
        changed = api.post(
            "/api/auth/password",
            headers=_bearer(token),
            json={
                "current_password": ADMIN["password"],
                "new_password": "Brand-New-Pa55w0rd!",
                # 开了 2FA 的账号改密码还要带一次动态码
                # （见 schemas.PasswordChange 的说明）
                "totp_code": pyotp.TOTP(secret).now(),
            },
        )
        assert changed.status_code == 200, changed.text
        # 服务端记录没了。cookie 还在浏览器里，但它已经对不上任何一行 ——
        # 这正是「信任判定只看服务端」的意义：客户端留着一枚失效口令也没用。
        assert _count_trusted() == 0

        relogin = _login(api, "Brand-New-Pa55w0rd!")
        assert relogin.json()["mfa_required"] is True

    def test_disabling_2fa_forgets_trusted_devices(self, api) -> None:
        """关了 2FA 也要清：留着的话「关了再开」旧信任会立刻复活成绕过通道。"""
        token = _token(api)
        secret, _ = TestTwoFactor()._enable(api, token)
        assert self._trust(api, secret).status_code == 200
        assert _count_trusted() == 1

        disabled = api.post(
            "/api/auth/2fa/disable",
            headers=_bearer(token),
            json={"password": ADMIN["password"], "code": pyotp.TOTP(secret).now()},
        )
        assert disabled.status_code == 200, disabled.text
        assert _count_trusted() == 0

    def test_switch_off_hides_and_refuses_the_feature(self, api, monkeypatch) -> None:
        """面板开关关掉后：第一步不再提示可用，第二步即使硬传也签不出来。"""
        secret, _ = _enable_2fa(api)
        monkeypatch.setattr(settings, "totp_trust_enabled", False)

        step1 = _login(api).json()
        assert step1["mfa_required"] is True
        assert step1["trust_device_available"] is False

        resp = api.post(
            "/api/auth/login/2fa",
            headers=_csrf(api),
            json={
                "mfa_token": step1["mfa_token"],
                "code": pyotp.TOTP(secret).now(),
                "trust_device": True,
            },
        )
        assert resp.status_code == 200, resp.text
        assert _count_trusted() == 0

    def test_expired_device_is_challenged_again(self, api) -> None:
        """过了 7 天就该重新校验 —— 后端只认 expires_at，不认 cookie 还在不在。"""
        secret, _ = _enable_2fa(api)
        assert self._trust(api, secret).status_code == 200

        _exec("UPDATE trusted_devices SET expires_at = %s", (time.time() - 1,))
        assert _login(api).json()["mfa_required"] is True


def _count_trusted() -> int:
    row = _exec("SELECT COUNT(*) FROM trusted_devices")
    return int(row[0][0])


def _exec(sql: str, params: tuple | None = None):
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            if cursor.description:
                return cursor.fetchall()
            conn.commit()
            return []
    finally:
        conn.close()


# ------------------------------------------------------------------- 限流
class TestRateLimit:
    def test_auth_endpoint_throttled(self, api, monkeypatch) -> None:
        monkeypatch.setattr(settings, "rate_limit_auth_per_minute", 3)
        codes = [_login(api, WRONG).status_code for _ in range(4)]
        assert codes[:3] == [401, 401, 401]
        assert codes[3] == 429

    def test_health_check_is_exempt(self, api, monkeypatch) -> None:
        monkeypatch.setattr(settings, "rate_limit_per_minute", 1)
        for _ in range(5):
            assert api.get("/api/health").status_code == 200
