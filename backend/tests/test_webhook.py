"""通用 Webhook 通道：模板渲染与转义、签名、加密存储与接口契约。

投递部分起一个真的本地 HTTP 服务来接请求 —— 只断言「函数返回 True」证明不了
请求体是合法 JSON、签名头算得对；这两件事恰恰是接入方最容易被坑的地方。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import alerting, crypto, database  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401


# --------------------------------------------------------------- 异步跑法
async def _shutdown_pool(coro):
    """跑完关连接池：池绑在 asyncio.run 新建的循环上（与 test_store_secrets 同）。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


async def _create_settings_table() -> None:
    """只建 ``settings`` 表 —— 通用 Webhook 的配置就存在这一个键值表里。

    刻意不调 ``store.init_db()``：那会连带跑管理员引导与旧库补列，而它是为
    应用启动路径设计的；从测试自己的事件循环里驱动它既慢又容易踩到
    「表已存在/列重复」这类与用例无关的坑。
    """
    async with database.connect() as db:
        await db.executescript(
            "CREATE TABLE IF NOT EXISTS settings ("
            "`key` VARCHAR(128) NOT NULL,"
            "value TEXT NOT NULL,"
            "PRIMARY KEY (`key`)"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"
        )
        await db.commit()


@pytest.fixture()
def webhook_db(clean_mysql_db):
    _run(_create_settings_table())
    yield


def _raw_setting(key: str) -> str:
    # 必须带上库名：不指定 database 时 pymysql 会以「No database selected」报错
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT `value` FROM settings WHERE `key` = %s", (key,))
            row = cursor.fetchone()
            return "" if row is None else str(row[0])
    finally:
        conn.close()


# ----------------------------------------------------------- 本地接收端
class WebhookReceiver:
    """只记录请求体的本地 HTTP 服务，用来验证面板真正发出的报文。"""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:  # silence
                pass

            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8")
                receiver.requests.append(
                    {
                        "path": self.path,
                        "body": body,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                    }
                )
                payload = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/hook"

    def __enter__(self) -> "WebhookReceiver":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


# ------------------------------------------------------------- 模板与签名
class TestTemplate:
    def test_placeholders_are_substituted(self) -> None:
        body = alerting.render_webhook_body(
            '{"t":"{{title}}","n":"{{node}}"}', {"title": "CPU 过高", "node": "pve1"}
        )
        assert json.loads(body) == {"t": "CPU 过高", "n": "pve1"}

    def test_values_are_escaped_as_json_strings(self) -> None:
        """对象名/详情里带引号或反斜杠是常态，不转义会把整段 JSON 拆坏。"""
        body = alerting.render_webhook_body(
            '{"t":"{{title}}"}', {"title": 'web-01" 重启'}
        )
        assert json.loads(body) == {"t": 'web-01" 重启'}

        # 反斜杠必须转成 \\ 才不会让 JSON 解析失败
        body = alerting.render_webhook_body(
            '{"p":"{{target}}"}', {"target": r"C:\data\x"}
        )
        assert json.loads(body) == {"p": r"C:\data\x"}

    def test_missing_placeholder_becomes_empty(self) -> None:
        assert json.loads(alerting.render_webhook_body('{"a":"{{nope}}"}', {})) == {
            "a": ""
        }

    def test_whitespace_inside_braces_is_tolerated(self) -> None:
        assert json.loads(
            alerting.render_webhook_body('{"a":"{{ title }}"}', {"title": "x"})
        ) == {"a": "x"}

    def test_empty_template_falls_back_to_default(self) -> None:
        body = alerting.render_webhook_body("", {"title": "t", "level": "alarm"})
        assert json.loads(body)["title"] == "t"

    def test_every_preset_is_valid_json(self) -> None:
        """预设模板写坏了却要等真出告警才发现，代价太高。"""
        for key, preset in alerting.WEBHOOK_PRESETS.items():
            alerting._validate_template(preset["template"])
            assert preset["label"], key

    def test_broken_template_is_rejected(self) -> None:
        with pytest.raises(alerting.WebhookConfigError):
            alerting._validate_template('{"a": }')


class TestSignature:
    def test_signature_is_deterministic_and_keyed(self) -> None:
        body = '{"a":1}'
        first = alerting.webhook_signature("s3cr3t", 1_700_000_000, body)
        assert first == alerting.webhook_signature("s3cr3t", 1_700_000_000, body)
        assert first != alerting.webhook_signature("other", 1_700_000_000, body)
        # 时间戳也签进去：否则抓到一次请求就能原样重放
        assert first != alerting.webhook_signature("s3cr3t", 1_700_000_001, body)
        assert len(first) == 64  # sha256 hex


# --------------------------------------------------------------- 配置读写
class TestWebhookConfig:
    def test_url_and_secret_are_encrypted_at_rest(self, webhook_db) -> None:
        _run(
            alerting.save_webhook(
                {
                    "webhook": "https://example.com/hook",
                    "secret": "s3cr3t",
                    "enabled": True,
                }
            )
        )

        stored = _raw_setting(alerting.webhook_key(""))
        assert "s3cr3t" not in stored
        assert crypto.is_encrypted(json.loads(stored)["secret"])

        cfg = _run(alerting.load_webhook(""))
        assert cfg["webhook"] == "https://example.com/hook"
        assert cfg["secret"] == "s3cr3t"
        assert cfg["enabled"] is True

    def test_disabled_by_default(self, webhook_db) -> None:
        """默认关：填了地址还要显式打开，免得试配置时就把告警泼到生产群里。"""
        cfg = _run(alerting.load_webhook(""))
        assert cfg["enabled"] is False

    def test_blank_value_keeps_existing(self, webhook_db) -> None:
        _run(alerting.save_webhook({"webhook": "https://example.com/hook", "secret": "k"}))
        # 前端只回传打码后的状态：留空表示不修改
        cfg = _run(alerting.save_webhook({"enabled": True}))
        assert cfg["webhook"] == "https://example.com/hook"
        assert cfg["secret"] == "k"
        assert cfg["enabled"] is True

    def test_clear_flags_remove_values(self, webhook_db) -> None:
        _run(alerting.save_webhook({"webhook": "https://example.com/hook", "secret": "k"}))
        cfg = _run(
            alerting.save_webhook({"webhook_clear": True, "secret_clear": True})
        )
        assert cfg["webhook"] == ""
        assert cfg["secret"] == ""

    def test_invalid_url_is_rejected(self, webhook_db) -> None:
        with pytest.raises(alerting.WebhookConfigError):
            _run(alerting.save_webhook({"webhook": "not-a-url"}))

    def test_bad_headers_are_rejected(self, webhook_db) -> None:
        with pytest.raises(alerting.WebhookConfigError):
            _run(
                alerting.save_webhook(
                    {"webhook": "https://example.com/hook", "headers": "[1,2]"}
                )
            )

    def test_cooldown_has_a_floor(self, webhook_db) -> None:
        cfg = _run(alerting.save_webhook({"cooldown": 1}))
        assert cfg["cooldown"] == 60


# ----------------------------------------------------------------- 投递
class TestDelivery:
    def test_posts_rendered_body_with_signature_headers(self, webhook_db) -> None:
        with WebhookReceiver() as receiver:
            _run(
                alerting.save_webhook(
                    {
                        "webhook": receiver.url,
                        "secret": "s3cr3t",
                        "enabled": True,
                        "template": '{"t":"{{title}}","v":"{{value}}"}',
                    }
                )
            )
            ok, detail = _run(
                alerting.send_webhook(
                    "CPU 过高", "正文", {"title": 'web-01"', "value": "91.5"}
                )
            )

        assert ok, detail
        assert len(receiver.requests) == 1
        sent = receiver.requests[0]
        assert sent["path"] == "/hook"
        # 请求体是合法 JSON，且引号被正确转义
        assert json.loads(sent["body"]) == {"t": 'web-01"', "v": "91.5"}

        ts = int(sent["headers"]["x-panel-timestamp"])
        assert sent["headers"]["x-panel-signature"] == "sha256=" + alerting.webhook_signature(
            "s3cr3t", ts, sent["body"]
        )

    def test_no_signature_headers_without_secret(self, webhook_db) -> None:
        with WebhookReceiver() as receiver:
            _run(
                alerting.save_webhook(
                    {"webhook": receiver.url, "enabled": True, "template": '{"a":1}'}
                )
            )
            ok, _detail = _run(alerting.send_webhook("t", "x", {}))

        assert ok
        assert "x-panel-signature" not in receiver.requests[0]["headers"]

    def test_custom_headers_are_sent(self, webhook_db) -> None:
        with WebhookReceiver() as receiver:
            _run(
                alerting.save_webhook(
                    {
                        "webhook": receiver.url,
                        "enabled": True,
                        "template": '{"a":1}',
                        "headers": '{"X-Token":"abc"}',
                    }
                )
            )
            ok, _detail = _run(alerting.send_webhook("t", "x", {}))

        assert ok
        assert receiver.requests[0]["headers"]["x-token"] == "abc"

    def test_disabled_channel_sends_nothing(self, webhook_db) -> None:
        with WebhookReceiver() as receiver:
            _run(alerting.save_webhook({"webhook": receiver.url, "enabled": False}))
            ok, detail = _run(alerting.send_webhook("t", "x", {}))

        assert ok is False
        assert "未启用" in detail
        assert receiver.requests == []

    def test_unreachable_endpoint_reports_failure(self, webhook_db) -> None:
        # 127.0.0.1:1 上不会有人监听
        _run(alerting.save_webhook({"webhook": "http://127.0.0.1:1/hook", "enabled": True}))
        ok, detail = _run(alerting.send_webhook("t", "x", {}))
        assert ok is False
        assert "发送失败" in detail


# ------------------------------------------------------------- 派发聚合
class TestDispatch:
    def test_webhook_alone_counts_as_a_channel(self, webhook_db) -> None:
        """只开通用 Webhook 也算「有通道」，不能退回「告警通知已停用」。"""
        with WebhookReceiver() as receiver:
            _run(
                alerting.save_webhook(
                    {"webhook": receiver.url, "enabled": True, "template": '{"a":1}'}
                )
            )
            hook = _run(alerting.load_webhook(""))
            ok, detail = _run(
                alerting.dispatch(
                    "",
                    {"enabled": False},
                    {"enabled": False},
                    "标题",
                    "正文",
                    {},
                    webhook=hook,
                    context={"title": "标题"},
                )
            )

        assert ok, detail
        assert "Webhook：" in detail
        assert len(receiver.requests) == 1

    def test_all_channels_off_keeps_the_old_message(self, webhook_db) -> None:
        ok, detail = _run(
            alerting.dispatch(
                "",
                {"enabled": False},
                {"enabled": False},
                "标题",
                "正文",
                {},
                webhook={"enabled": False},
            )
        )
        assert ok is False
        assert detail == "告警通知已停用，仅记录"


# ------------------------------------------------------------------- 接口
class TestWebhookApi:
    def test_overview_exposes_presets_and_placeholders(self, api) -> None:
        body = api.get("/api/alerts", headers=auth_headers(api)).json()

        assert body["hook"]["enabled"] is False
        assert body["hook_set"] is False
        assert set(body["hook_presets"]) == {"wecom", "dingtalk", "slack", "generic"}
        assert "title" in body["hook_placeholders"]

    def test_save_never_returns_the_plaintext(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put(
            "/api/alerts/webhook",
            json={
                "webhook": "https://example.com/hook",
                "secret": "s3cr3t",
                "enabled": True,
            },
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        assert "s3cr3t" not in resp.text
        assert "example.com/hook" not in resp.text
        assert resp.json()["hook_set"] is True
        assert resp.json()["hook_secret_set"] is True

        overview = api.get("/api/alerts", headers=headers).json()
        assert overview["hook_set"] is True
        assert overview["hook"]["enabled"] is True
        # 地址只以打码形式回传
        assert "example.com" in overview["hook_masked"]

    def test_invalid_template_is_400(self, api) -> None:
        resp = api.put(
            "/api/alerts/webhook",
            json={"webhook": "https://example.com/hook", "template": '{"a": }'},
            headers=auth_headers(api),
        )
        assert resp.status_code == 400

    def test_viewer_cannot_save(self, api) -> None:
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users",
                json={
                    "username": "wviewer",
                    "password": "Unit-Test-Pa55word",
                    "role": "viewer",
                },
                headers=admin,
            ).status_code
            == 200
        )
        viewer = api.post(
            "/api/auth/login",
            json={"username": "wviewer", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]

        resp = api.put(
            "/api/alerts/webhook",
            json={"webhook": "https://example.com/hook"},
            headers={"Authorization": f"Bearer {viewer}"},
        )
        assert resp.status_code == 403
