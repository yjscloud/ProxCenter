"""配置加密：新密文可解，改名前落库的旧密文也要能解。

项目改名为 pvecenter 时 KDF 上下文跟着改了。如果解密只认新
标识，升级后所有已保存的 PVE Token / SSH 私钥 / SMTP 口令 / TOTP 种子都会
变成「未配置」—— 用户看到的是连接全部失效，而不是一次可理解的版本变更。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import crypto  # noqa: E402

LEGACY_INFO = base64.b64decode("cHJveGNlbnRlci9jb25maWctZW5jcnlwdGlvbi92MQ==")


def _seal_with(info: bytes, plain: str) -> str:
    """按指定 KDF 上下文手工加密，模拟改名前的历史密文。"""
    enc_key, mac_key = crypto._derive_keys(info)
    nonce = os.urandom(crypto._NONCE_LEN)
    body = crypto._xor(plain.encode("utf-8"), enc_key, nonce)
    tag = hmac.new(mac_key, nonce + body, hashlib.sha256).digest()[: crypto._TAG_LEN]
    token = base64.urlsafe_b64encode(nonce + tag + body).decode("ascii")
    return crypto.PREFIX + token


def test_new_ciphertext_roundtrip() -> None:
    token = crypto.encrypt("new-secret")
    assert crypto.is_encrypted(token)
    assert crypto.decrypt(token) == "new-secret"


def test_legacy_ciphertext_still_decrypts() -> None:
    """改名前保存的凭据不能因为 KDF 标识变了就全部失效。"""
    token = _seal_with(LEGACY_INFO, "legacy-ssh-key")
    assert crypto.decrypt(token) == "legacy-ssh-key"


def test_unknown_kdf_context_is_rejected() -> None:
    token = _seal_with(b"some-other-project/v1", "should-not-leak")
    assert crypto.decrypt(token) == ""


def test_tampered_ciphertext_returns_empty() -> None:
    token = crypto.encrypt("tamper-me")
    tampered = token[:-2] + ("AA" if token[-2:] != "AA" else "BB")
    assert crypto.decrypt(tampered) == ""


def test_plaintext_history_still_passes_through() -> None:
    assert crypto.decrypt("plain-old-value") == "plain-old-value"
