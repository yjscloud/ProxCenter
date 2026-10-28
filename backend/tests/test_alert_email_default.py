"""告警邮件的默认值：填了账号邮箱就该收到，不该要用户先去开一个开关。

``DEFAULT_ALERT_EMAIL.enabled`` 曾经是 ``False``，于是「从没打开过告警页那个
开关」的用户（几乎所有人）**永远收不到告警邮件** —— 而面板里唯一能看出这件事
的地方是告警页里的一枚徽章。使用者看到的现象就是「监控告警不发邮件，可我的
邮箱明明是好的」。

告警本来就不是订阅制：账号邮箱是账号的必备字段之一，填了它就意味着收得到。
默认打开之后，只有**显式保存过** ``enabled=false`` 的用户才会被静默 —— 那是
他自己的选择，这里也一并钉住，别让默认值反过来覆盖它。

两点实现上的讲究：
* 每个用例只跑一次 ``asyncio.run``，跑完丢掉连接池 —— 池子是进程级单例，
  loop 一关，池里的连接就变成「已关闭 loop 上的协程」（见 ``_run``）；
* 用户先删后建：``mysql_test_db`` 是会话级 fixture，同一批名字会被上一次运行
  留下来，直接 create 会撞唯一索引。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import alerting, database, security, store  # noqa: E402

PASSWORD = "Unit-Test-Pa55word"


def _run(main) -> None:
    """跑一次用例，跑完把连接池丢掉，让下一轮重建（同 conftest 的 clean_mysql_db）。"""
    try:
        asyncio.run(main())
    finally:
        database._mysql_pool = None


async def _setup(username: str, email: str) -> None:
    """建表 + 清掉同名残留，再按给定邮箱建档。"""
    await store.init_db()
    # 内置角色由 app 启动时补齐（security.load_roles）；这里不起 app，得自己补，
    # 否则 create_user 会以「角色 viewer 不存在」拒绝建号（取决于上一个用例
    # 有没有恰好留下 roles 表，属于纯粹的用例顺序依赖）。
    await security.load_roles()
    async with database.connect() as db:
        await db.execute("DELETE FROM users WHERE username = ?", (username,))
        await db.commit()
    await store.create_user(username, PASSWORD, "viewer", email)


def test_account_email_is_the_default_recipient(mysql_test_db) -> None:
    async def main() -> None:
        await _setup("mail-default", "mail-default@example.com")
        cfg = await alerting.load_alert_email("mail-default")
        assert cfg["enabled"] is True
        # 收件人留空 -> 退回账号邮箱
        assert await alerting.resolve_email_recipients("mail-default") == [
            "mail-default@example.com"
        ]

    _run(main)


def test_no_email_means_nothing_to_send_to(mysql_test_db) -> None:
    """没邮箱的用户不会被凭空投递（默认开着也不会误发）。"""

    async def main() -> None:
        await _setup("mail-noaddr", "")
        assert await alerting.resolve_email_recipients("mail-noaddr") == []

    _run(main)


def test_explicit_disable_still_wins(mysql_test_db) -> None:
    """存心不想收的人保存一次就够，默认值不能反过来覆盖它。"""

    async def main() -> None:
        await _setup("mail-off", "mail-off@example.com")
        await alerting.save_alert_email({"enabled": False}, "mail-off")
        cfg = await alerting.load_alert_email("mail-off")
        assert cfg["enabled"] is False
        assert await alerting.resolve_email_recipients("mail-off") == []

    _run(main)


def test_explicit_recipients_override_account_email(mysql_test_db) -> None:
    async def main() -> None:
        await _setup("mail-alt", "mail-alt@example.com")
        await alerting.save_alert_email(
            {"enabled": True, "recipients": "alerts@example.com"}, "mail-alt"
        )
        assert await alerting.resolve_email_recipients("mail-alt") == [
            "alerts@example.com"
        ]

    _run(main)
