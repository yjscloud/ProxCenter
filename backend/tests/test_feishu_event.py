"""飞书事件回调的入口校验（BUG-011）。

回调是匿名入口，必须自己把住四件事：

* 空 / 结构不完整的请求体不能静默 200；
* 配置了 Encrypt Key 就必须带签名 + 新鲜时间戳；
* 配置了 Verification Token 就必须带且一致；
* 同一 event_id 只处理一次（飞书超时会重试）。
"""
from __future__ import annotations

import hashlib
import time

from app import feishu_bot  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401


def _event(event_id: str) -> dict:
    return {
        "schema": "2.0",
        "header": {"event_id": event_id, "event_type": "im.message.receive_v1"},
        "event": {},
    }


def test_empty_event_body_is_rejected(api) -> None:
    response = api.post("/api/feishu/event", json={})
    assert response.status_code == 400
    assert response.json()["detail"]


def test_url_verification_requires_a_challenge(api) -> None:
    assert (
        api.post("/api/feishu/event", json={"type": "url_verification"}).status_code
        == 400
    )
    ok = api.post(
        "/api/feishu/event",
        json={"type": "url_verification", "challenge": "abc123"},
    )
    assert ok.status_code == 200
    assert ok.json() == {"challenge": "abc123"}


def test_event_requires_header_and_event(api) -> None:
    response = api.post("/api/feishu/event", json={"event": {}})
    assert response.status_code == 400


def test_duplicate_event_is_acknowledged_but_not_reprocessed(api) -> None:
    payload = _event("evt-duplicate-1")
    first = api.post("/api/feishu/event", json=payload)
    assert first.status_code == 200
    assert first.json()["msg"] == "机器人未启用"

    again = api.post("/api/feishu/event", json=payload)
    assert again.status_code == 200
    assert again.json()["msg"] == "duplicate"


def test_signature_is_required_when_encrypt_key_is_configured() -> None:
    cfg = {"encrypt_key": "unit-test-encrypt-key"}
    body = b'{"hello":"world"}'

    ok, reason = feishu_bot.verify_signature({}, body, cfg)
    assert ok is False
    assert "签名" in reason

    timestamp = str(int(time.time()))
    nonce = "n-1"
    signature = hashlib.sha256(
        (timestamp + nonce + cfg["encrypt_key"]).encode() + body
    ).hexdigest()
    good = {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signature,
    }
    assert feishu_bot.verify_signature(good, body, cfg) == (True, "")

    stale = dict(good, **{"x-lark-request-timestamp": str(int(time.time()) - 3600)})
    ok, reason = feishu_bot.verify_signature(stale, body, cfg)
    assert ok is False
    assert "过期" in reason


def test_verification_token_cannot_be_omitted() -> None:
    cfg = {"verification_token": "expected-token"}
    assert feishu_bot.check_token({}, cfg)[0] is False
    assert (
        feishu_bot.check_token(
            {"header": {"token": "expected-token"}},
            cfg,
        )[0]
        is True
    )
