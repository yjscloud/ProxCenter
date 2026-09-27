"""配置项对称加密（仅依赖 Python 标准库）。

面板里有些配置一旦泄露就等于把控制权交出去，最典型的是飞书机器人的
Webhook 地址（拿到即可向群里推送任意消息）和签名密钥。本模块提供一套
轻量的认证加密，用于在落库前把这类配置变成密文：

* 以 ``settings.secret_key`` 为根密钥，用 HMAC-SHA256 分别派生出加密密钥
  与认证密钥（KDF）；
* 随机 16 字节 nonce，用 HMAC-SHA256 作 PRF 生成密钥流做异或（流式加密）；
* 采用 encrypt-then-MAC，用认证密钥对 ``nonce || 密文`` 计算 16 字节标签，
  解密时用 :func:`hmac.compare_digest` 校验，防止篡改。

密文格式为 ``enc:v1:<urlsafe-base64(nonce || tag || body)>``。带版本前缀是
为了将来平滑升级算法；:func:`decrypt` 对不带前缀的内容原样返回，因此历史
明文配置依然可用（调用方可在读取时顺手迁移为密文）。

不引入 ``cryptography``/``Fernet`` 的原因：后端依赖保持精简，而这套实现对
"加密一段 Webhook 字符串"的场景已经足够。注意根密钥来自 ``secret_key``，
**更换 secret_key 会导致既有密文无法解密**，此时配置会退化成"未配置"，
需要重新填写。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os

from .config import settings

PREFIX = "enc:v1:"
_KDF_INFO = b"proxcenter/config-encryption/v1"
_NONCE_LEN = 16
_TAG_LEN = 16


def _derive_keys() -> tuple:
    """从面板 ``secret_key`` 派生 (加密密钥, 认证密钥)。"""
    master = (settings.secret_key or "").encode("utf-8")
    enc_key = hmac.new(master, _KDF_INFO + b"|enc", hashlib.sha256).digest()
    mac_key = hmac.new(master, _KDF_INFO + b"|mac", hashlib.sha256).digest()
    return enc_key, mac_key


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(
            hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        )
        counter += 1
    return bytes(out[:length])


def _xor(data: bytes, key: bytes, nonce: bytes) -> bytes:
    stream = _keystream(key, nonce, len(data))
    return bytes(a ^ b for a, b in zip(data, stream))


def is_encrypted(value: str) -> bool:
    """判断字符串是否为本模块产出的密文。"""
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt(plain: str) -> str:
    """加密字符串；空串原样返回（避免给"未配置"也套一层密文）。"""
    if not plain:
        return ""
    if is_encrypted(plain):
        return plain
    enc_key, mac_key = _derive_keys()
    nonce = os.urandom(_NONCE_LEN)
    body = _xor(plain.encode("utf-8"), enc_key, nonce)
    tag = hmac.new(mac_key, nonce + body, hashlib.sha256).digest()[:_TAG_LEN]
    token = base64.urlsafe_b64encode(nonce + tag + body).decode("ascii")
    return PREFIX + token


def decrypt(value: str) -> str:
    """解密 :func:`encrypt` 的结果。

    非密文（历史明文）原样返回；密文损坏、被篡改或根密钥已更换时返回空串，
    由调用方按"未配置"处理。
    """
    if not value:
        return ""
    if not is_encrypted(value):
        return value
    try:
        raw = base64.urlsafe_b64decode(value[len(PREFIX):].encode("ascii"))
    except (ValueError, TypeError):
        return ""
    if len(raw) <= _NONCE_LEN + _TAG_LEN:
        return ""
    nonce = raw[:_NONCE_LEN]
    tag = raw[_NONCE_LEN:_NONCE_LEN + _TAG_LEN]
    body = raw[_NONCE_LEN + _TAG_LEN:]
    enc_key, mac_key = _derive_keys()
    expected = hmac.new(mac_key, nonce + body, hashlib.sha256).digest()[:_TAG_LEN]
    if not hmac.compare_digest(tag, expected):
        return ""
    return _xor(body, enc_key, nonce).decode("utf-8", "replace")


def mask(value: str, head: int = 4, tail: int = 4) -> str:
    """打码展示：保留首尾各若干字符，中间用 ``*`` 代替。"""
    if not value:
        return ""
    if len(value) <= head + tail:
        return "*" * 8
    return value[:head] + "*" * 6 + value[-tail:]
