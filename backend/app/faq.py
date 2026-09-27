"""常见问题（FAQ）：产品官网「常见问题」区块的内容，可在「设置 → 常见问题」中增删改。

沿用 site.py 的 settings KV 模式。这里与品牌文案有一处**语义差异**：

* 从未配置过 → 回落到内置默认的几条问题，保证升级后页面表现不变；
* 存了一个空数组 → 视为「明确不要 FAQ」，官网不渲染该区块，导航入口也一并隐藏。

也就是说 KV 里「有没有这条记录」本身就是信息，删掉记录 = 恢复默认，
存空数组 = 关闭该区块。两者不能混为一谈。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from . import store

logger = logging.getLogger(__name__)

FAQ_KEY = "site_faq"

# 条数上限：官网是折叠列表，再多也翻不完，且一次全量下发
MAX_ITEMS = 30
MAX_QUESTION = 200
MAX_ANSWER = 2000

# 内置默认值：与改造前前端硬编码的 FAQ 完全一致
DEFAULT_FAQS: List[Dict[str, str]] = [
    {
        "q": "需要把 Proxmox 暴露到公网吗？",
        "a": "不需要。面板在内网通过 Proxmox API（默认 8006）访问集群，"
        "只有面板自身需要对外提供访问入口。",
    },
    {
        "q": "为什么浏览器控制台还需要额外填一个 Proxmox 账号？",
        "a": "Proxmox 不允许 API Token 调用 vncproxy / termproxy，控制台只认用户名密码"
        "换取的 ticket。该功能可选，不填不影响其它功能。",
    },
    {
        "q": "SSL 证书「自动续期」是怎么工作的？",
        "a": "以腾讯云免费 DV 证书为例：证书有效期 90 天，面板会按你设定的天数"
        "（默认到期前 15 天）自动提交续期申请，等 CA 签发成功后自动下载并重新部署到"
        "目标机器，最后执行你配置的重载命令（如 nginx -s reload）。",
    },
    {
        "q": "飞书机器人需要公网回调吗？会不会被人乱操作？",
        "a": "需要：机器人通过飞书开放平台的事件回调访问面板，回调地址必须能被飞书"
        "访问到（内网部署可用反向代理或内网穿透）。安全上做了两层限制：一是必须配置"
        "群会话或用户白名单，名单外的消息一律拒绝；二是关机、重启、回滚这类危险操作"
        "会先弹确认卡片，点确认才执行，全过程写入审计日志。",
    },
]


def _clean_text(value: Any, limit: int) -> str:
    """折叠空白并截断；返回空串表示这一项无效。"""
    return " ".join(str(value or "").split())[:limit]


def _clean_items(value: Any) -> Optional[List[Dict[str, str]]]:
    """整理 FAQ 列表。

    返回 ``None`` 表示输入不是一个列表（数据不可信，调用方应保留原值）；
    返回列表则可能为空 —— 空列表是一种有效状态，代表「关闭 FAQ 区块」。
    """
    if not isinstance(value, list):
        return None

    items: List[Dict[str, str]] = []
    for raw in value[:MAX_ITEMS]:
        if not isinstance(raw, dict):
            continue
        question = _clean_text(raw.get("q"), MAX_QUESTION)
        answer = _clean_text(raw.get("a"), MAX_ANSWER)
        # 问题和答案缺一不可：只有问题会展开出一片空白，只有答案则无法点击
        if not question or not answer:
            continue
        items.append({"q": question, "a": answer})
    return items


async def get_faqs() -> List[Dict[str, str]]:
    """读取 FAQ；从未配置过时返回内置默认值，配置为空则返回空列表。"""
    raw = await store.get_setting(FAQ_KEY)
    if not raw:
        return [dict(item) for item in DEFAULT_FAQS]

    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("site_faq 配置损坏，已回落到默认值：%r", raw)
        return [dict(item) for item in DEFAULT_FAQS]

    # 库里的数据可能是旧版本写入或被手工改过，读的时候也过一遍清洗
    items = _clean_items(parsed)
    if items is None:
        logger.warning("site_faq 不是列表，已回落到默认值：%r", parsed)
        return [dict(item) for item in DEFAULT_FAQS]
    return items


async def set_faqs(items: Any) -> List[Dict[str, str]]:
    """保存 FAQ。传空数组即关闭官网上的 FAQ 区块。"""
    cleaned = _clean_items(items) or []
    await store.set_setting(FAQ_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


async def reset_faqs() -> List[Dict[str, str]]:
    """删除配置，恢复内置默认问题。"""
    await store.delete_setting(FAQ_KEY)
    return [dict(item) for item in DEFAULT_FAQS]
