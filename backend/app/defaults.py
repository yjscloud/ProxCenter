"""面板级默认值：新建 / 克隆虚拟机时自动套用。

目前只有一项「默认 DNS」。它存在的实际原因是模板机大多走 DHCP，客户机的
NetworkManager 常常只留下路由器 RA 下发的 DNS；一旦那些 DNS 不可达（局域网
"假 IPv6" 很常见），虚拟机就会完全解析不了域名，表现为"连不上外网"。
配置一个 IPv4 默认 DNS 后，面板创建 / 克隆出来的机器都会写上它。

约定：显式填写优先 → 其次面板默认 → 都没有则不干预（保持继承 DHCP / RA）。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from . import store

logger = logging.getLogger(__name__)

VM_DEFAULTS_KEY = "vm_defaults"


def normalize_dns(value: Any) -> str:
    """归一成 PVE 接受的空格分隔形式（逗号 / 分号 / 换行都当作分隔符）。"""
    text = str(value or "")
    for sep in (",", ";", "\t"):
        text = text.replace(sep, " ")
    return " ".join(text.split())


async def get_vm_defaults() -> Dict[str, str]:
    """读取虚拟机创建默认值；未配置或配置损坏时返回空值。"""
    raw = await store.get_setting(VM_DEFAULTS_KEY)
    if not raw:
        return {"dns": ""}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("vm_defaults 配置损坏，已忽略：%r", raw)
        return {"dns": ""}
    if not isinstance(data, dict):
        return {"dns": ""}
    return {"dns": normalize_dns(data.get("dns"))}


async def set_vm_defaults(dns: Optional[str]) -> Dict[str, str]:
    payload = {"dns": normalize_dns(dns)}
    await store.set_setting(VM_DEFAULTS_KEY, json.dumps(payload, ensure_ascii=False))
    return payload


async def default_dns() -> str:
    """面板默认 DNS；未配置时返回空串（表示不干预）。"""
    return (await get_vm_defaults())["dns"]


async def effective_dns(explicit: Optional[str]) -> Optional[str]:
    """显式指定优先，否则回落到面板默认 DNS；都没有则返回 None。"""
    value = normalize_dns(explicit)
    if value:
        return value
    return await default_dns() or None
