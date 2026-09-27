"""安全基线回归：弱配置拒绝启动、HTTPS 强制、出站证书校验默认值。

覆盖三件事（对应线上修复）：

1. **弱 SECRET_KEY 拒绝启动**：占位值 / 过短的密钥在 ``Settings`` 校验期就抛
   ``ValidationError``，``run.py`` 拿到后人话提示并退出 —— 拿到仓库就能伪造
   登录态、解出库里密文的钥匙不能再留在源码里；
2. **弱 ADMIN_PASSWORD 拒绝建号 / 存量告警**：首次建号用弱口令直接
   ``RuntimeError``（唯一一次写死机会），已建好的账号用弱口令则启动日志
   醒目提醒（不硬拦，避免把线上后台一起拦掉）；
3. **FORCE_HTTPS 中间件**：明文 308、HTTPS 加 HSTS、回环豁免、WebSocket
   拦截，以及出站 ``PVE_VERIFY_SSL`` 的代码默认值与 env 覆盖。
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from pydantic import ValidationError

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, store  # noqa: E402
from app.config import (  # noqa: E402
    MIN_SECRET_KEY_LEN,
    WEAK_SECRET_KEYS,
    Settings,
    is_weak_admin_password,
    settings,
)
from app.main import HttpsEnforcementMiddleware  # noqa: E402
from app.pve import connection_from_profile  # noqa: E402
from app.schemas import ConnectionConfigIn, ConnectionTestIn  # noqa: E402
from conftest import connect  # noqa: E402

STRONG_KEY = "unit-test-secret-key-0123456789-abcdefghijklmnop"  # >= 32 位


async def _shutdown_pool(coro):
    """跑完关连接池：池绑在 asyncio.run 的循环上，不关会在 GC 时炸。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


# ---------------------------------------------------------- SECRET_KEY 拒绝启动
class TestRejectWeakSecretKey:
    @pytest.mark.parametrize("weak", sorted(WEAK_SECRET_KEYS))
    def test_placeholder_rejected(self, weak: str) -> None:
        with pytest.raises(ValidationError) as excinfo:
            Settings(_env_file=None, secret_key=weak)
        assert "拒绝启动" in str(excinfo.value)

    @pytest.mark.parametrize("key", ["", "   "])
    def test_empty_rejected(self, key: str) -> None:
        with pytest.raises(ValidationError):
            Settings(_env_file=None, secret_key=key)

    def test_too_short_rejected(self) -> None:
        short = "a" * (MIN_SECRET_KEY_LEN - 1)
        with pytest.raises(ValidationError) as excinfo:
            Settings(_env_file=None, secret_key=short)
        assert str(MIN_SECRET_KEY_LEN) in str(excinfo.value)

    def test_strong_key_accepted(self) -> None:
        cfg = Settings(_env_file=None, secret_key=STRONG_KEY)
        assert cfg.secret_key == STRONG_KEY


# ---------------------------------------------------------- 弱口令判定 / 建号拦截
class TestWeakAdminPassword:
    @pytest.mark.parametrize(
        "value",
        [
            "admin123",
            "ADMIN123",
            " admin ",
            "password",
            "123456",
            "root",
            "",  # .env.example 里的 ADMIN_PASSWORD 就是留空的
            "   ",
            "短口令",  # 长度不足
            None,
            123,
        ],
    )
    def test_weak_values(self, value: Any) -> None:
        assert is_weak_admin_password(value) is True

    def test_strong_value(self) -> None:
        assert is_weak_admin_password("Unit-Test-Admin-Pa55w0rd!") is False

    def test_bootstrap_rejects_weak_password(self, clean_mysql_db) -> None:
        """库里没有管理员时，弱口令建号必须直接失败（拒绝启动）。"""
        old = settings.admin_password
        settings.admin_password = "admin123"
        try:
            with pytest.raises(RuntimeError, match="弱口令"):
                _run(store.init_db())
        finally:
            settings.admin_password = old

    def test_warns_when_stored_password_is_weak(self, clean_mysql_db, caplog) -> None:
        """存量账号口令仍是 admin123：只告警不拦截，但日志必须有它。"""
        _run(store.init_db())  # conftest 注入的强口令建号
        raw = connect(settings.db_name)
        try:
            with raw.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET password_hash = %s WHERE role = 'admin'",
                    (store.pwd_context.hash("admin123"),),
                )
        finally:
            raw.close()

        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="app.store"):
            _run(store._warn_weak_admin_password())
        assert any(
            "弱默认值" in record.getMessage() for record in caplog.records
        ), "存量弱口令没有触发告警"

    def test_no_warning_for_strong_password(self, clean_mysql_db, caplog) -> None:
        _run(store.init_db())
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="app.store"):
            _run(store._warn_weak_admin_password())
        assert not any(
            "弱默认值" in record.getMessage() for record in caplog.records
        )


# ---------------------------------------------------------- FORCE_HTTPS 中间件
def _http_scope(
    *,
    scheme: str = "http",
    peer: str = "203.0.113.5",
    host: str = "panel.example.com",
    path: str = "/api/health",
    query: bytes = b"",
    scope_type: str = "http",
    extra_headers: Optional[List[tuple]] = None,
) -> Dict[str, Any]:
    headers = [(b"host", host.encode("latin-1"))]
    headers.extend(extra_headers or [])
    return {
        "type": scope_type,
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": scheme,
        "path": path,
        "raw_path": path.encode("latin-1"),
        "query_string": query,
        "headers": headers,
        "client": (peer, 40000),
        "server": ("panel.example.com", settings.port),
    }


async def _downstream(scope, receive, send) -> None:
    if scope["type"] == "websocket":
        await send({"type": "websocket.accept"})
        return
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-length", b"0")],
        }
    )
    await send({"type": "http.response.body", "body": b""})


def _call_middleware(scope: Dict[str, Any]) -> List[Dict[str, Any]]:
    sent: List[Dict[str, Any]] = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request"}

    asyncio.run(HttpsEnforcementMiddleware(_downstream)(scope, receive, send))
    return sent


@pytest.fixture()
def https_on(monkeypatch):
    monkeypatch.setattr(settings, "force_https", True)


class TestHttpsEnforcement:
    def test_disabled_passes_through(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "force_https", False)
        sent = _call_middleware(_http_scope(scheme="http", peer="203.0.113.5"))
        assert sent[0]["status"] == 200

    def test_plain_http_redirects_to_https(self, https_on) -> None:
        sent = _call_middleware(
            _http_scope(path="/vms", query=b"id=100", host="panel.example.com")
        )
        assert sent[0]["status"] == 308
        headers = dict(sent[0]["headers"])
        assert headers[b"location"] == b"https://panel.example.com/vms?id=100"

    def test_redirect_strips_panel_and_default_ports(self, https_on) -> None:
        # 后端自己不提供 TLS，跳转必须落到反代的 443
        for host in (f"panel.example.com:{settings.port}", "panel.example.com:80"):
            sent = _call_middleware(_http_scope(host=host))
            assert dict(sent[0]["headers"])[b"location"] == (
                b"https://panel.example.com/api/health"
            ), host

    def test_forged_forwarded_proto_does_not_bypass(self, https_on) -> None:
        """公网请求自称「我是 https」无效：只看 uvicorn 改写后的 scheme。"""
        sent = _call_middleware(
            _http_scope(extra_headers=[(b"x-forwarded-proto", b"https")])
        )
        assert sent[0]["status"] == 308

    def test_https_gets_hsts(self, https_on) -> None:
        sent = _call_middleware(_http_scope(scheme="https"))
        assert sent[0]["status"] == 200
        headers = dict(sent[0]["headers"])
        assert headers[b"strict-transport-security"] == b"max-age=31536000"

    def test_loopback_health_check_exempt(self, https_on) -> None:
        for peer in ("127.0.0.1", "::1"):
            sent = _call_middleware(_http_scope(peer=peer))
            assert sent[0]["status"] == 200, peer

    def test_loopback_with_forwarded_header_still_redirected(self, https_on) -> None:
        """带转发头的回环请求按反代链路处理（uvicorn 已改写 scheme）。"""
        sent = _call_middleware(
            _http_scope(
                peer="127.0.0.1", extra_headers=[(b"x-forwarded-proto", b"http")]
            )
        )
        assert sent[0]["status"] == 308

    def test_websocket_rejected_in_plaintext(self, https_on) -> None:
        sent = _call_middleware(_http_scope(scope_type="websocket", path="/ws"))
        assert sent == [
            {"type": "websocket.close", "code": 1008, "reason": "HTTPS required"}
        ]

    def test_websocket_loopback_exempt(self, https_on) -> None:
        sent = _call_middleware(_http_scope(scope_type="websocket", peer="127.0.0.1"))
        assert sent[0]["type"] == "websocket.accept"

    def test_lifespan_scope_untouched(self, https_on) -> None:
        """lifespan 等非 http/websocket scope 直接透传，不拦不改。"""
        sent = _call_middleware({"type": "lifespan", "asgi": {"version": "3.0"}})
        assert sent, "lifespan scope 被中间件吞掉了"
        assert sent[0]["type"] not in ("websocket.close",)


# ---------------------------------------------------------- 出站 verify_ssl 默认
class TestPveVerifySslDefault:
    def test_code_default_is_true(self, monkeypatch) -> None:
        """生产默认开启：代码里的字段默认值必须是 True。"""
        assert Settings.model_fields["pve_verify_ssl"].default is True
        monkeypatch.delenv("PVE_VERIFY_SSL", raising=False)
        cfg = Settings(_env_file=None, secret_key=STRONG_KEY)
        assert cfg.pve_verify_ssl is True

    def test_env_can_turn_it_off(self, monkeypatch) -> None:
        """PVE 自签 / 证书过期的环境可以显式关掉。"""
        monkeypatch.setenv("PVE_VERIFY_SSL", "false")
        cfg = Settings(_env_file=None, secret_key=STRONG_KEY)
        assert cfg.pve_verify_ssl is False

    @pytest.mark.parametrize("env_value", ["true", "false"])
    def test_schema_default_follows_env(self, env_value: str) -> None:
        """schema 的 verify_ssl 默认值跟环境走（在子进程里全新导入）。"""
        env = os.environ.copy()
        env["SECRET_KEY"] = STRONG_KEY
        env["PVE_VERIFY_SSL"] = env_value
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                "from app.schemas import ConnectionConfigIn, ConnectionTestIn;"
                "print(ConnectionConfigIn().verify_ssl,"
                "ConnectionTestIn(host='x').verify_ssl)",
            ],
            cwd=str(BACKEND_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        expected = "True" if env_value == "true" else "False"
        assert proc.stdout.strip() == f"{expected} {expected}"

    def test_in_process_schema_default_matches_settings(self) -> None:
        # pydantic 在类定义时绑定默认值：它必须等于当时 settings 的取值，
        # 而不是写死的 False。
        assert (
            ConnectionConfigIn.model_fields["verify_ssl"].default
            == settings.pve_verify_ssl
        )
        assert (
            ConnectionTestIn.model_fields["verify_ssl"].default
            == settings.pve_verify_ssl
        )

    def test_legacy_profile_follows_settings(self, monkeypatch) -> None:
        """老连接没存 verify_ssl 字段：按环境默认走，不是写死的 False。"""
        monkeypatch.setattr(settings, "pve_verify_ssl", True)
        assert connection_from_profile({"host": "pve.example.com"}).verify_ssl is True
        assert store.public_connection_config({})["verify_ssl"] is True
        monkeypatch.setattr(settings, "pve_verify_ssl", False)
        assert connection_from_profile({"host": "pve.example.com"}).verify_ssl is False
        # 存过值的连接永远按自己存的走
        assert (
            connection_from_profile({"host": "x", "verify_ssl": True}).verify_ssl
            is True
        )


# ---------------------------------------------------------- 配置文件不带真密钥
class TestEnvFiles:
    def _value(self, text: str, key: str) -> str:
        prefix = f"{key}="
        for line in text.splitlines():
            if line.startswith(prefix):
                return line[len(prefix):].strip()
        return ""

    def test_env_example_secret_is_placeholder(self) -> None:
        example = (BACKEND_DIR / ".env.example").read_text(encoding="utf-8")
        assert self._value(example, "SECRET_KEY") in WEAK_SECRET_KEYS
        # 示例口令留空：留着明文等于教人用弱口令
        assert self._value(example, "ADMIN_PASSWORD") == ""

    def test_real_env_not_placeholder(self) -> None:
        env_file = BACKEND_DIR / ".env"
        if not env_file.exists():
            pytest.skip("没有 backend/.env")
        real = env_file.read_text(encoding="utf-8")
        secret = self._value(real, "SECRET_KEY")
        assert secret not in WEAK_SECRET_KEYS, "生产 .env 还在用占位 SECRET_KEY"
        assert len(secret) >= MIN_SECRET_KEY_LEN
        admin = self._value(real, "ADMIN_PASSWORD")
        assert not is_weak_admin_password(admin), "生产 .env 的 ADMIN_PASSWORD 是弱口令"
