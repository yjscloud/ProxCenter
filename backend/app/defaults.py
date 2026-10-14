"""面板级默认值：新建 / 克隆虚拟机时自动套用。

两项：

* **默认 DNS**。它存在的实际原因是模板机大多走 DHCP，客户机的 NetworkManager
  常常只留下路由器 RA 下发的 DNS；一旦那些 DNS 不可达（局域网 "假 IPv6" 很常见），
  虚拟机就会完全解析不了域名，表现为"连不上外网"。配置一个 IPv4 默认 DNS 后，
  面板创建 / 克隆出来的机器都会写上它。
* **默认克隆方式**（链接 / 完整）。链接克隆秒级完成、不额外占空间，但磁盘依赖
  模板；完整克隆复制一份独立磁盘，慢一些、多占一份空间。集群里模板多、机器多
  的时候，管理员往往希望全站统一按其中一种来 —— 这里定「默认」，各创建入口仍
  可单独改（前端把它作为初值预选，不锁死）。

约定：显式填写优先 → 其次面板默认 → 都没有则不干预（DNS 保持继承 DHCP / RA，
克隆方式按链接克隆）。
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


def _empty_defaults() -> Dict[str, Any]:
    """未配置时的取值：DNS 不干预、克隆方式为链接克隆（PVE 侧的默认行为）。"""
    return {"dns": "", "full_clone": False}


async def get_vm_defaults() -> Dict[str, Any]:
    """读取虚拟机创建默认值；未配置或配置损坏时返回默认值。"""
    raw = await store.get_setting(VM_DEFAULTS_KEY)
    if not raw:
        return _empty_defaults()
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("vm_defaults 配置损坏，已忽略：%r", raw)
        return _empty_defaults()
    if not isinstance(data, dict):
        return _empty_defaults()
    return {
        "dns": normalize_dns(data.get("dns")),
        "full_clone": bool(data.get("full_clone")),
    }


async def set_vm_defaults(
    dns: Optional[str], full_clone: Optional[bool] = None
) -> Dict[str, Any]:
    payload = {"dns": normalize_dns(dns), "full_clone": bool(full_clone)}
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
