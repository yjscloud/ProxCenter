"""按用户保存的界面偏好（每用户一份 JSON）。

为什么要落服务端
----------------
仪表盘的布局、卡片显隐这类偏好如果只放浏览器 localStorage，换个浏览器、换台
机器、清一次缓存就全没了。面板的用户体系本来就是服务端的，偏好跟着账号走才
符合预期。

与 ``settings`` 表的区别
------------------------
``settings`` 是**全局**键值（PVE 连接、站点信息、邮件配置……），键名是功能名。
这里是**每用户**键值，主键是 ``(username, key)``。两者语义不同（一个是「面板
怎么配」，一个是「这个人怎么看界面」），混在一张表里迟早会出现「谁的偏好被
别人覆盖了」这类问题。

键名为什么要白名单
------------------
不是为了防攻击（值有大小上限，且只能读写自己的），而是为了让「这张表里可能
出现什么」是可枚举的：将来要做偏好导出、清理或迁移时，白名单是那份清单。
新增一个偏好 = 在 :data:`ALLOWED_KEYS` 里加一项，顺带逼着思考它的结构。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from . import database

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_prefs (
    username VARCHAR(64) NOT NULL,
    `key`    VARCHAR(64) NOT NULL,
    value    TEXT        NOT NULL,
    updated  DOUBLE      NOT NULL,
    PRIMARY KEY (username, `key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# 允许保存的偏好键。
PREF_DASHBOARD_LAYOUT = "dashboard_layout"
# 界面语言：浏览器里那份 localStorage 决定「这台设备立刻显示哪种语言」，
# 服务端这份决定「发给这个人的通知邮件用哪种语言」。两者刻意各存一份 ——
# 同一账号在公司电脑看英文、在家看中文是合理的。
PREF_LANGUAGE = "language"
ALLOWED_KEYS = frozenset({PREF_DASHBOARD_LAYOUT, PREF_LANGUAGE})

# 单个偏好的体积上限。布局就是个 widget id 数组，几 KB 顶天；留 64 KB 是给
# 未来的偏好（比如保存的筛选条件组合）留余量，同时挡住把这张表当文件存的用法。
MAX_VALUE_BYTES = 64 * 1024


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def is_allowed(key: str) -> bool:
    return key in ALLOWED_KEYS


def _decode(raw: Any, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        # 存坏了就当没存过：一个坏掉的偏好不该让整个仪表盘打不开
        logger.warning("用户偏好解析失败，按未设置处理")
        return default


async def get(username: str, key: str, default: Any = None) -> Any:
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT value FROM user_prefs WHERE username = ? AND `key` = ?",
            (username, key),
        )
        row = await cursor.fetchone()
    if not row:
        return default
    return _decode(row[0], default)


async def all_for(username: str) -> Dict[str, Any]:
    """该用户的全部偏好。没设置过的键不会出现在结果里（由调用方决定默认值）。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT `key`, value FROM user_prefs WHERE username = ?",
            (username,),
        )
        rows = await cursor.fetchall()
    out: Dict[str, Any] = {}
    for row in rows:
        key = str(row[0])
        if not is_allowed(key):
            # 白名单缩小时留下的老数据：不回传，也不主动删（回滚版本还能用）
            continue
        out[key] = _decode(row[1], None)
    return out


async def set(  # noqa: A001 - 与项目里其它模块的 set_setting 风格一致
    username: str, key: str, value: Any
) -> Any:
    """保存一条偏好（覆盖写）。返回存进去的值。"""
    payload = json.dumps(value, ensure_ascii=False)
    if len(payload.encode("utf-8")) > MAX_VALUE_BYTES:
        raise ValueError(f"偏好内容过大（上限 {MAX_VALUE_BYTES // 1024} KB）")

    async with database.connect() as db:
        await db.execute(
            "INSERT INTO user_prefs (username, `key`, value, updated)"
            " VALUES (?, ?, ?, ?)"
            " ON DUPLICATE KEY UPDATE value = VALUES(value), updated = VALUES(updated)",
            (username, key, payload, time.time()),
        )
        await db.commit()
    return value


async def delete(username: str, key: str) -> bool:
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM user_prefs WHERE username = ? AND `key` = ?",
            (username, key),
        )
        await db.commit()
        return int(cursor.rowcount or 0) > 0
