"""两步验证（TOTP，RFC 6238）。

* 密钥用 ``crypto.encrypt`` 加密后落 ``users.totp_secret``：数据库被拖走也拿不到
  能生成验证码的种子（和 PVE Token 同等对待）；
* 恢复码一次性、用 bcrypt 存哈希：手机丢了还能进得来，但码本身不落明文；
* 校验放宽 ±``totp_window`` 步（默认前后各 30 秒），容忍手机与服务器的时钟漂移。

这里刻意不把「当前口令」缓存到内存：每次校验都重新解密密钥，代价是一次
AES 级别的运算，换来的是密钥轮换立刻生效。
"""
from __future__ import annotations

import base64
import io
import json
import logging
import secrets
from typing import Any, Dict, List, Optional, Tuple

import pyotp
import qrcode

from . import crypto, store
from .config import settings

logger = logging.getLogger(__name__)

RECOVERY_CODE_COUNT = 8


def generate_secret() -> str:
    """新的 TOTP 种子（base32）。"""
    return pyotp.random_base32()


def provisioning_uri(secret: str, username: str) -> str:
    """认证器 App 扫的 ``otpauth://`` 链接。"""
    return pyotp.TOTP(secret).provisioning_uri(
        name=username, issuer_name=settings.totp_issuer
    )


def qr_png_data_uri(uri: str) -> str:
    """把 otpauth 链接画成 PNG 并转 data URI。

    在服务端画图（而不是塞个二维码库到前端）有两个好处：前端不用加依赖，
    且**只有当前用户能拿到自己的图**，不会把种子留在第三方 CDN 上。
    """
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def verify_code(secret_ciphertext: str, code: str) -> bool:
    """校验 6 位动态码。密钥是密文，这里解出来再用。"""
    secret = crypto.decrypt(secret_ciphertext or "")
    if not secret:
        return False
    candidate = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(candidate) != 6:
        return False
    try:
        return bool(
            pyotp.TOTP(secret).verify(candidate, valid_window=settings.totp_window)
        )
    except Exception as exc:  # noqa: BLE001 - 种子损坏时按失败处理
        logger.warning("TOTP 校验异常：%s", exc)
        return False


# --------------------------------------------------------------- 恢复码
def new_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> List[str]:
    """一次性恢复码，形如 ``A1B2-C3D4``（去掉易混字符）。"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    codes = []
    for _ in range(count):
        raw = "".join(secrets.choice(alphabet) for _ in range(8))
        codes.append(f"{raw[:4]}-{raw[4:]}")
    return codes


def hash_recovery_codes(codes: List[str]) -> str:
    """恢复码只存 bcrypt 哈希，落库形式是 JSON 字符串。"""
    return json.dumps([store.pwd_context.hash(c) for c in codes])


def remaining_recovery_codes(stored: str) -> int:
    try:
        data = json.loads(stored or "[]")
    except (ValueError, TypeError):
        return 0
    return len(data) if isinstance(data, list) else 0


def _consume_recovery_code(stored: str, code: str) -> Optional[str]:
    """命中则返回**移除了这一条**的新 JSON，未命中返回 None。"""
    candidate = str(code or "").strip().upper().replace(" ", "")
    if not candidate:
        return None
    try:
        data = json.loads(stored or "[]")
    except (ValueError, TypeError):
        return None
    if not isinstance(data, list):
        return None
    for index, hashed in enumerate(data):
        try:
            if store.pwd_context.verify(candidate, str(hashed)):
                return json.dumps(data[:index] + data[index + 1 :])
        except ValueError:
            continue
    return None


async def verify_login_code(user: Dict[str, Any], code: str) -> Tuple[bool, bool]:
    """登录第二步校验：先试动态码，再试恢复码。

    返回 ``(是否通过, 是否用掉了恢复码)``。用掉恢复码会立刻写回数据库 ——
    一次性就是一次性，不能等下次登录再递减。
    """
    stored_secret = str(user.get("totp_secret") or "")
    if verify_code(stored_secret, code):
        return True, False

    updated = _consume_recovery_code(str(user.get("totp_recovery") or ""), code)
    if updated is None:
        return False, False
    await store.set_totp(str(user["username"]), recovery=updated)
    return True, True
