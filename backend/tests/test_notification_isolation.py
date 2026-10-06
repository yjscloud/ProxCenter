"""消息中心的用户隔离：谁都只能读、标记、清空**自己的**消息。

为什么单独盯这件事：站内消息里会出现下发的机器口令、地址与账号，串号不是
「看到一条无关的通知」，而是直接泄露凭据。隔离靠的是 SQL 里那句
``WHERE username = ?``（归属只来自 ``app/notifications.py`` 的 ``_owner``），
所以这里逐条盯住每个入口 —— 读列表、数未读、标记已读、清空，任何一个漏带
条件都会在这几个用例里露出来。

重点在「别人的 id 不能当自己的用」：``mark_read`` 与 ``clear`` 收的都是不可信
输入 —— 前者漏带 username 只是把别人的消息标成已读，后者漏带就是清空别人的
消息中心。同一个模式，两种后果，所以两条路径都单独有一个用例。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, notifications  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api  # noqa: E402,F401


async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池（它绑在 asyncio.run 新建的循环上）。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    """只建表、不启动 app：这些用例打的是数据层，不需要整台服务。"""
    _run(notifications.init_table())
    yield


def _sql(sql: str, params: tuple = ()) -> List[Any]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchall()
    finally:
        conn.close()


def _rows() -> List[Any]:
    """库里的全部消息（顺序固定，便于断言「谁的一条都没少」）。"""
    return _sql("SELECT username, title, read_at FROM notifications ORDER BY id")


def _seed() -> None:
    """alice 与 bob 各两条：任何一次越权都会在下面的断言里对上号。"""
    for owner in ("alice", "bob"):
        for index in (1, 2):
            _run(
                notifications.push(
                    owner, title=f"{owner}-{index}", body=f"{owner} 的第 {index} 条"
                )
            )


def _ids(owner: str) -> List[int]:
    return [int(item["id"]) for item in _run(notifications.list_for(owner))]


def test_each_owner_only_sees_their_own(db):
    _seed()
    assert [i["title"] for i in _run(notifications.list_for("alice"))] == [
        "alice-2",
        "alice-1",
    ]
    assert [i["title"] for i in _run(notifications.list_for("bob"))] == [
        "bob-2",
        "bob-1",
    ]
    assert _run(notifications.unread_count("alice")) == 2
    assert _run(notifications.unread_count("bob")) == 2


def test_mark_read_ignores_ids_owned_by_someone_else(db):
    _seed()
    bob_ids = _ids("bob")

    # alice 拿着 bob 的 id 去标记已读：一条都不该命中，bob 的未读也不该变
    assert _run(notifications.mark_read("alice", ids=bob_ids)) == 0
    assert _run(notifications.unread_count("bob")) == 2
    assert _run(notifications.unread_count("alice")) == 2

    # 换成自己的 id 才生效
    assert _run(notifications.mark_read("alice", ids=_ids("alice"))) == 2
    assert _run(notifications.unread_count("alice")) == 0


def test_clear_only_removes_own_messages(db):
    _seed()
    assert _run(notifications.clear("alice")) == 2

    assert _run(notifications.list_for("alice")) == []
    # bob 的两条一条都不能少
    assert len(_run(notifications.list_for("bob"))) == 2
    assert _run(notifications.unread_count("bob")) == 2
    assert sorted(row[0] for row in _rows()) == ["bob", "bob"]


def test_empty_owner_touches_nothing(db):
    """空归属是 fail closed：不发 SQL、不改任何行，而不是「碰巧匹配不到」。"""
    _seed()

    assert _run(notifications.list_for("")) == []
    assert _run(notifications.unread_count("")) == 0
    assert _run(notifications.mark_read("", all_items=True)) == 0
    assert _run(notifications.mark_read("   ", all_items=True)) == 0
    assert _run(notifications.clear("")) == 0
    assert _run(notifications.clear("   ")) == 0

    rows = _rows()
    assert len(rows) == 4, "一条都不该被删"
    assert all(row[2] == 0 for row in rows), "也不该有任何一条被标成已读"


def test_api_requires_login(api):
    """消息接口不认匿名请求：读列表、清空都一样。"""
    assert api.get("/api/notifications").status_code in (401, 403)
    assert api.delete("/api/notifications").status_code in (401, 403)
