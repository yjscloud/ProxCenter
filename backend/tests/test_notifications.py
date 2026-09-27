"""站内通知中心与全局搜索：未读口径、归属隔离、链接推算与分组权限。

通知的模块层用 ``asyncio.run`` 直接驱动（跑完关连接池，与 test_webhook 同套路）；
接口层走 ``api`` fixture，历史行用同步 pymysql 直插。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, notifications  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

DAY = 86_400


# --------------------------------------------------------------- 异步跑法
async def _shutdown_pool(coro):
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


def _exec(sql: str, params: Optional[tuple] = None) -> List[Any]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return cursor.fetchall()
    finally:
        conn.close()


async def _create_notifications_table() -> None:
    """只建通知表：用例不需要整套面板表结构（见 test_webhook 里的同款说明）。"""
    async with database.connect() as db:
        await db.executescript(notifications.SCHEMA)
        await db.commit()


@pytest.fixture()
def notif_db(clean_mysql_db):
    _run(_create_notifications_table())
    yield


def _insert(owner: str, title: str, *, created: Optional[int] = None, read_at: int = 0) -> None:
    _exec(
        "INSERT INTO notifications (username, kind, level, title, body, link, created, read_at)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            owner,
            "alert",
            "danger",
            title,
            "",
            "/alerts",
            int(created if created is not None else time.time()),
            read_at,
        ),
    )


# ------------------------------------------------------------------ 纯函数
class TestMessageBuilding:
    def test_node_alert_links_to_the_node_page(self) -> None:
        assert (
            notifications.link_for_alert({"target_type": "node", "node": "pve1"})
            == "/nodes/pve1"
        )

    def test_guest_alert_respects_qemu_and_lxc(self) -> None:
        """虚拟机与容器是两套详情页，跳错就是 404。"""
        assert (
            notifications.link_for_alert(
                {"target_type": "vm", "node": "pve1", "vmid": 100, "guest_type": "qemu"}
            )
            == "/vms/pve1/100"
        )
        assert (
            notifications.link_for_alert(
                {"target_type": "vm", "node": "pve1", "vmid": 200, "guest_type": "lxc"}
            )
            == "/lxc/pve1/200"
        )

    def test_unknown_target_falls_back_to_alerts_page(self) -> None:
        """拿不准就跳告警页：跳到一个可能 404 的资源比跳到有上下文的地方更糟。"""
        assert notifications.link_for_alert({"target_type": "vm", "node": "pve1"}) == "/alerts"
        assert notifications.link_for_alert({}) == "/alerts"

    def test_alarm_message_mentions_undelivered_channels(self) -> None:
        """外部通道没发出去时必须写出来 —— 用户可能正是因为收不到才来看铃铛。"""
        message = notifications.alert_message(
            {
                "target": "pve1",
                "kind": "alarm",
                "result": "failed",
                "detail": "飞书：未配置",
                "metric": "cpu",
                "value": 95,
                "threshold": 90,
                "node": "pve1",
            }
        )
        assert message["level"] == "danger"
        assert message["kind"] == "alert"
        assert "外部通道未送达：飞书：未配置" in message["body"]
        assert "节点：pve1" in message["body"]

    def test_recovery_message_is_success_and_skips_threshold(self) -> None:
        message = notifications.alert_message(
            {"target": "web", "kind": "recovery", "result": "sent", "metric": "cpu"}
        )
        assert message["level"] == "success"
        assert message["kind"] == "recovery"
        assert message["title"] == "已恢复：web"


# --------------------------------------------------------------- 读写与隔离
class TestStorage:
    def test_push_then_count_and_list(self, notif_db) -> None:
        _run(notifications.push("alice", title="告警：pve1", body="CPU 95%"))
        _run(notifications.push("alice", title="已恢复：web"))

        assert _run(notifications.unread_count("alice")) == 2
        items = _run(notifications.list_for("alice"))
        # 倒序：最新的在前
        assert [i["title"] for i in items] == ["已恢复：web", "告警：pve1"]
        assert all(i["read"] is False for i in items)

    def test_push_without_owner_is_dropped(self, notif_db) -> None:
        """无主消息永远不会有人看到，写进去只会白占空间。"""
        _run(notifications.push("", title="没有归属"))
        assert _exec("SELECT COUNT(*) FROM notifications")[0][0] == 0

    def test_unread_count_is_per_user(self, notif_db) -> None:
        _run(notifications.push("alice", title="a"))
        _run(notifications.push("bob", title="b"))
        assert _run(notifications.unread_count("alice")) == 1
        assert _run(notifications.unread_count("bob")) == 1
        assert _run(notifications.unread_count("carol")) == 0

    def test_mark_read_by_ids(self, notif_db) -> None:
        _run(notifications.push("alice", title="一"))
        _run(notifications.push("alice", title="二"))
        items = _run(notifications.list_for("alice"))
        target = items[0]["id"]

        marked = _run(notifications.mark_read("alice", ids=[target]))

        assert marked == 1
        assert _run(notifications.unread_count("alice")) == 1
        by_id = {i["id"]: i for i in _run(notifications.list_for("alice"))}
        assert by_id[target]["read"] is True

    def test_mark_read_all(self, notif_db) -> None:
        for title in ("一", "二", "三"):
            _run(notifications.push("alice", title=title))
        marked = _run(notifications.mark_read("alice", all_items=True))
        assert marked == 3
        assert _run(notifications.unread_count("alice")) == 0

    def test_marking_is_idempotent(self, notif_db) -> None:
        """重复点「全部已读」不该反复刷新时间戳。"""
        _run(notifications.push("alice", title="一"))
        assert _run(notifications.mark_read("alice", all_items=True)) == 1
        assert _run(notifications.mark_read("alice", all_items=True)) == 0

    def test_cannot_mark_someone_elses_message(self, notif_db) -> None:
        """用户名条件必须拼进 SQL，否则改一个 id 就能动别人的消息。"""
        _run(notifications.push("bob", title="bob 的告警"))
        victim = _run(notifications.list_for("bob"))[0]["id"]

        marked = _run(notifications.mark_read("alice", ids=[victim]))

        assert marked == 0
        assert _run(notifications.unread_count("bob")) == 1

    def test_unread_only_filter(self, notif_db) -> None:
        _insert("alice", "已读的", read_at=int(time.time()))
        _insert("alice", "未读的")
        items = _run(notifications.list_for("alice", unread_only=True))
        assert [i["title"] for i in items] == ["未读的"]

    def test_purge_removes_only_expired(self, notif_db) -> None:
        now = int(time.time())
        _insert("alice", "旧的", created=now - 100 * DAY)
        _insert("alice", "新的", created=now)

        deleted = _run(notifications.purge_old(now=now))

        assert deleted == 1
        assert [r[0] for r in _exec("SELECT title FROM notifications")] == ["新的"]


# ------------------------------------------------------------------- 接口
class TestNotificationApi:
    def test_requires_auth(self, api) -> None:
        assert api.get("/api/notifications").status_code == 401
        assert api.get("/api/notifications/unread").status_code == 401

    def test_list_returns_items_and_unread(self, api) -> None:
        headers = auth_headers(api)
        # 用同步 pymysql 直插：TestClient 的事件循环已经持有 aiomysql 连接池，
        # 这里再 asyncio.run 一个协程去借同一个池会撞「Future attached to a
        # different loop」，而且 _shutdown_pool 会把应用正在用的池关掉。
        _insert("admin", "告警：pve1")

        body = api.get("/api/notifications", headers=headers).json()

        assert body["unread"] == 1
        assert [i["title"] for i in body["items"]] == ["告警：pve1"]
        assert body["items"][0]["read"] is False

    def test_unread_endpoint_is_light(self, api) -> None:
        headers = auth_headers(api)
        _insert("admin", "x")
        assert api.get("/api/notifications/unread", headers=headers).json() == {"unread": 1}

    def test_mark_read_returns_new_count(self, api) -> None:
        headers = auth_headers(api)
        _insert("admin", "x")
        _insert("admin", "y")

        body = api.post("/api/notifications/read", json={"all": True}, headers=headers).json()

        assert body["marked"] == 2
        assert body["unread"] == 0
        assert api.get("/api/notifications", headers=headers).json()["items"]
        assert (
            api.get("/api/notifications", headers=headers).json()["unread"] == 0
        )

    def test_users_cannot_see_each_others_messages(self, api) -> None:
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users",
                json={
                    "username": "nviewer",
                    "password": "Unit-Test-Pa55word",
                    "role": "viewer",
                },
                headers=admin,
            ).status_code
            == 200
        )
        viewer = api.post(
            "/api/auth/login",
            json={"username": "nviewer", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        viewer_headers = {"Authorization": f"Bearer {viewer}"}

        _insert("admin", "管理员的告警")
        _insert("nviewer", "我的告警")

        mine = api.get("/api/notifications", headers=viewer_headers).json()
        assert [i["title"] for i in mine["items"]] == ["我的告警"]

        theirs = api.get("/api/notifications", headers=admin).json()
        assert [i["title"] for i in theirs["items"]] == ["管理员的告警"]


class TestGlobalSearch:
    def test_requires_auth(self, api) -> None:
        assert api.get("/api/search?q=pve").status_code == 401

    def test_empty_query_returns_nothing(self, api) -> None:
        body = api.get("/api/search?q=", headers=auth_headers(api)).json()
        assert body["groups"] == []
        assert body["total"] == 0

    def test_finds_nodes_and_flags_them(self, api) -> None:
        body = api.get("/api/search?q=pve1", headers=auth_headers(api)).json()

        group = next((g for g in body["groups"] if g["key"] == "node"), None)
        assert group is not None, body
        assert group["label"] == "节点"
        assert any("pve1" in item["title"] for item in group["items"])
        assert all(item["link"].startswith("/nodes/") for item in group["items"])

    def test_groups_never_exceed_the_limit(self, api) -> None:
        body = api.get("/api/search?q=pve&limit=1", headers=auth_headers(api)).json()
        for group in body["groups"]:
            assert len(group["items"]) <= 1

    def test_viewer_does_not_get_the_user_group(self, api) -> None:
        """搜索是最容易被漏掉的越权入口：列表页做了隔离、搜索忘了做就白做。

        viewer 角色有 vm/node/storage 的查看权限，但没有 users.view。
        """
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={
                "username": "sviewer",
                "password": "Unit-Test-Pa55word",
                "role": "viewer",
            },
            headers=admin,
        )
        viewer = api.post(
            "/api/auth/login",
            json={"username": "sviewer", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        viewer_headers = {"Authorization": f"Bearer {viewer}"}

        # 关键词取一个所有用户名都含的片段，确保不是「没匹配上」而是「没权限」
        mine = api.get("/api/search?q=viewer", headers=viewer_headers).json()
        assert not any(g["key"] == "user" for g in mine["groups"])

        theirs = api.get("/api/search?q=viewer", headers=admin).json()
        assert any(g["key"] == "user" for g in theirs["groups"])

    def test_vm_group_is_isolated_to_the_owner(self, api) -> None:
        """虚拟机结果走的是列表页那套归属隔离，不是自己另写一份过滤。"""
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={
                "username": "gviewer2",
                "password": "Unit-Test-Pa55word",
                "role": "operator",
            },
            headers=admin,
        )
        operator = api.post(
            "/api/auth/login",
            json={"username": "gviewer2", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        ops_headers = {"Authorization": f"Bearer {operator}"}

        # 不指派任何机器：严格隔离下普通用户搜不到任何 guest
        mine = api.get("/api/search?q=pve", headers=ops_headers).json()
        assert not any(g["key"] == "vm" for g in mine["groups"])

        # 管理员能看到
        theirs = api.get("/api/search?q=pve", headers=admin).json()
        assert any(g["key"] == "vm" for g in theirs["groups"])
