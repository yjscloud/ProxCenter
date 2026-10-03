"""面板自己的 SSH 密钥对（一把钥匙管所有「面板下发」的虚拟机）。

**为什么需要它。** 面板可以从 cloud 镜像一键下发虚拟机；下发时就能把一把公钥
写进 cloud-init 的 ``sshkeys``，之后面板自己 SSH 进去做安全采集（SSH 登录安全 /
安全基线 / 端口与进程 / 登录审计）。不用这招的话，每台机器都得用户手工登记一次，
「自动接入」就无从谈起。

**为什么是一把而不是每台一把。** 轮换只有一处（重发一次公钥即可），实现也简单。
代价是爆炸半径大：这把私钥能登录**所有**由面板下发的机器。因此：

* 私钥用 ``crypto`` 加密后才落库（与受管主机的凭据同一套机制）；
* 私钥**永不回传前端**，对外只给公钥与是否已生成；
* 提供 :func:`rotate` 一键轮换，轮换后旧公钥立即失效（需要重新下发或手工替换）。

**没有它的老部署怎么办。** ``ensure()`` 是惰性的：只有真正要用（下发勾选了
「接入安全管控」）时才生成，不碰任何现有部署。

密钥类型选 **Ed25519**：``sshremote._load_key`` 首选的就是 ``Ed25519Key``，
且接受 OpenSSH 格式；云镜像（Ubuntu / Debian / Rocky / AlmaLinux）全都支持。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import crypto, store

logger = logging.getLogger(__name__)

#: settings 表里的键名
SETTING_KEY = "panel_ssh_key"

_UNSET: Dict[str, Any] = {"present": False, "public": "", "created": 0, "by": ""}


def _generate() -> Dict[str, str]:
    """生成一对 Ed25519 密钥（OpenSSH 格式，paramiko 直接可用）。"""
    key = Ed25519PrivateKey.generate()
    private_text = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_text = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.OpenSSH,
            format=serialization.PublicFormat.OpenSSH,
        )
        .decode()
    )
    return {"private": private_text, "public": public_text}


def _public_line(public_text: str) -> str:
    """给 ``authorized_keys`` / cloud-init ``sshkeys`` 用的单行公钥。

    cloud-init 的 ``sshkeys`` 要的是**整行**（``ssh-ed25519 AAAA...``），
    而 OpenSSH 的 ``public_bytes`` 恰好就是这一行（不带注释）。
    """
    return str(public_text or "").strip()


async def _raw() -> Optional[Dict[str, Any]]:
    try:
        text = await store.get_setting(SETTING_KEY)
    except Exception:  # noqa: BLE001 - 数据库抖动时按「没有密钥」处理
        logger.exception("读取面板密钥失败")
        return None
    if not text:
        return None
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        logger.warning("settings.panel_ssh_key 不是合法 JSON，按未生成处理")
        return None
    return data if isinstance(data, dict) else None


async def state() -> Dict[str, Any]:
    """对外状态：**只回公钥**，私钥一个字节都不出去。"""
    data = await _raw()
    if not data or not data.get("public"):
        return dict(_UNSET)
    try:
        created = int(data.get("created") or 0)
    except (TypeError, ValueError):
        created = 0
    return {
        "present": True,
        "public": _public_line(data.get("public")),
        "created": created,
        "by": str(data.get("by") or ""),
    }


async def ensure(by: str = "") -> Dict[str, Any]:
    """取密钥对；没有就生成一份。惰性 —— 不调用就不会有任何副作用。"""
    data = await _raw()
    if not data or not data.get("private") or not data.get("public"):
        pair = _generate()
        record = {**pair, "created": int(time.time()), "by": str(by or "")[:64]}
        await store.set_setting(SETTING_KEY, json.dumps(record, ensure_ascii=False))
        logger.info("已生成面板 SSH 密钥对（操作者：%s）", record["by"] or "未知")
        data = record
    return data


async def public_key(by: str = "") -> str:
    """公钥单行（缺失时自动生成）。"""
    return _public_line((await ensure(by)).get("public"))


async def with_public_key(existing: Optional[str]) -> str:
    """把面板公钥**追加**到已有的 ``sshkeys`` 文本里（去重，保持多行格式）。

    用户自己填的公钥必须保留 —— 那是他登录用的；面板这把只是多一条授权。
    cloud-init 的 ``sshkeys`` 是「一行一把钥匙」，所以按行去重。
    """
    key = await public_key()
    lines = [ln.strip() for ln in str(existing or "").splitlines() if ln.strip()]
    if key and key not in lines:
        lines.append(key)
    return "\n".join(lines)


async def private_key() -> str:
    """**解密后的**私钥，只给 SSH 连接层用。"""
    data = await _raw()
    if not data or not data.get("private"):
        raise RuntimeError("面板尚未生成 SSH 密钥对")
    try:
        return crypto.decrypt(str(data["private"]))
    except Exception as exc:  # noqa: BLE001
        # 多半是 SECRET_KEY 换过了 —— 密文解不开，只能重新生成
        raise RuntimeError(
            "面板 SSH 私钥解密失败（SECRET_KEY 变更过？）；请轮换密钥后重新下发"
        ) from exc


async def rotate(by: str = "") -> Dict[str, Any]:
    """轮换密钥对。

    ⚠️ **旧公钥立即失效** —— 已经用旧公钥接入过的机器，面板再也连不上去，
    必须重新下发（或手工把新公钥追加进对应账号的 ``authorized_keys``）。
    之所以做成显式操作而不是自动覆盖，就是为了逼调用方把这个代价摆到用户面前。
    """
    pair = _generate()
    record = {**pair, "created": int(time.time()), "by": str(by or "")[:64]}
    await store.set_setting(SETTING_KEY, json.dumps(record, ensure_ascii=False))
    logger.warning("面板 SSH 密钥对已轮换（操作者：%s）", record["by"] or "未知")
    return record
