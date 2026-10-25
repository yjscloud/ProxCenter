"""维护模式：面板对外暂停服务，只留管理员入口。

开关存在 ``settings`` 表（键 ``panel.maintenance``），值是一小段 JSON：

    {"enabled": true, "message": "今晚 22:00-23:00 升级存储，期间只允许管理员登录"}

为什么不是一个布尔值：维护公告得由管理员自己写 ——「为什么进不来、大概什么时候
好」比一个光秃秃的「维护中」有用得多；而它与开关同生共死，放一条记录里最省事。

每次请求都查一次库不划算，所以带 5 秒进程内缓存；保存时立刻失效 —— 关掉开关
之后不该还要等一个 TTL 才生效（那会让管理员以为没关掉）。

这里只负责「状态 + 错误怎么报」，**谁该被拦**由调用方判断（security / auth）：
本模块不导入 security，避免两边互相 import。
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional

from fastapi import HTTPException

from . import i18n, store

#: settings 表里的键名
KEY = "panel.maintenance"

#: 状态缓存时长（秒）。多个请求同时进来时只查一次库。
CACHE_TTL = 5.0

#: 公告长度上限：够写清「为什么 + 大概多久」，又不至于把登录页撑成一篇公告
MAX_MESSAGE = 500

_cache: Optional[Dict[str, Any]] = None
_cache_at = 0.0


def _default_message() -> str:
    return i18n.pick(
        "面板正在维护，暂时只允许管理员登录，请稍后再试。",
        "The panel is under maintenance. Only administrators can sign in right now.",
    )


def _normalise(raw: Any) -> Dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    return {
        "enabled": bool(data.get("enabled")),
        "message": str(data.get("message") or "").strip()[:MAX_MESSAGE],
    }


async def state(force: bool = False) -> Dict[str, Any]:
    """当前维护状态。``force=True`` 跳过缓存（保存后立刻复核时用）。"""
    global _cache, _cache_at
    now = time.time()
    if not force and _cache is not None and now - _cache_at < CACHE_TTL:
        return dict(_cache)
    raw = await store.get_setting(KEY)
    try:
        parsed = json.loads(raw) if raw else {}
    except ValueError:
        # 手工改坏的 JSON 不该把面板卡在维护态：当成「没配」处理
        parsed = {}
    _cache = _normalise(parsed)
    _cache_at = now
    return dict(_cache)


async def enabled() -> bool:
    return bool((await state())["enabled"])


async def save(payload: Dict[str, Any]) -> Dict[str, Any]:
    global _cache, _cache_at
    data = _normalise(payload)
    await store.set_setting(KEY, json.dumps(data, ensure_ascii=False))
    # 直接回填：下一个请求（往往是同一次保存后的刷新）不必再查库
    _cache = data
    _cache_at = time.time()
    return dict(data)


def reset_cache() -> None:
    """丢掉缓存。测试与「刚保存完要立刻生效」的场景用。"""
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0


def notice_message(data: Dict[str, Any]) -> str:
    """对外展示的公告：管理员写了就用他的，没写用内置文案。"""
    return str(data.get("message") or "").strip() or _default_message()


def error(data: Dict[str, Any]) -> HTTPException:
    """维护期间的统一拒绝。

    503 而不是 403：这是「暂时不可用」，不是「你没权限」。状态码之外还带
    ``X-Error-Code: maintenance``，前端据此分辨「该跳维护页」还是「该跳登录页」。
    """
    return HTTPException(
        status_code=503,
        detail=notice_message(data),
        headers={"X-Error-Code": "maintenance"},
    )
