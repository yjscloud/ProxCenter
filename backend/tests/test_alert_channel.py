"""告警历史的「发送渠道」字段。

为什么单开一个文件
------------------
渠道列的价值全在**准确**：它回答「这条告警是从哪个渠道发出的」。一旦记录端与
投递端的判定条件各写一遍，就会出现「历史写着邮件、实际根本没发」这种最难查的
状态 —— 用户拿着历史去问「邮件为什么没收到」，而历史本身就在撒谎。

所以这里钉四件事：

1. ``channel_ids`` 与 ``dispatch`` 用的是同一套条件（判定函数是同一份代码）；
2. ``record`` 落库时做归一（固定顺序、去重、丢掉界面解释不了的 id）；
3. 站内消息由 ``record`` 自己补 —— 有收件人的告警一定会在铃铛里出现，
   这是站内信渠道的**事实来源**，不能指望调用方记得传；
4. 升级前的旧行没有渠道信息，留空串，不按 detail 文本反推。

写法与 test_alert_notify 一致：模块层 ``asyncio.run`` + ``db``，接口层用 ``api``
夹具，两层不混用（TestClient 的连接池绑在它自己的事件循环上）。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import alerting, database, notifications, ownership, store  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401


async def _shutdown_pool(coro):
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    _run(store.init_db())
    # 归属表要建：告警收件人按「机器归谁」解析（RecipientBook），缺表会刷一堆
    # 警告，虽然不致命，但会盖住真正的失败
    _run(ownership.init_table())
    _run(alerting.init_table())
    _run(notifications.init_table())
    yield


def _exec(sql: str, params: tuple = ()) -> List[Any]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as c:
            c.execute(sql, params)
            return c.fetchall()
    finally:
        conn.close()


def _channels() -> List[str]:
    """按写入顺序取出历史行的渠道列（字符串，不是列表）。"""
    return [str(row[0] or "") for row in _exec("SELECT channel FROM alert_history ORDER BY id")]


def _entry(**over: Any) -> Dict[str, Any]:
    entry = {
        "username": "alice",
        "rule_id": "cpu",
        "rule_name": "CPU 高负载",
        "target_type": "vm",
        "target": "vm-a",
        "metric": "cpu",
        "value": 95.0,
        "threshold": 80.0,
        "result": "sent",
        "detail": "飞书：已发送；邮件：已发送",
        "kind": "alarm",
        "ts": 1_700_000_000,
    }
    entry.update(over)
    return entry


class _Recorder:
    """把三个外部通道与站内推送换成计数器。"""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: Dict[str, int] = {"feishu": 0, "email": 0, "webhook": 0, "inbox": 0}

        async def feishu(card, owner=""):
            self.calls["feishu"] += 1
            return True, "已发送"

        async def email(owner, title, text):
            self.calls["email"] += 1
            return True, "已发送"

        async def webhook(title, text, context, owner, cfg=None):
            self.calls["webhook"] += 1
            return True, "已发送"

        async def inbox(entry, created=None):
            self.calls["inbox"] += 1

        monkeypatch.setattr(alerting, "send_feishu", feishu)
        monkeypatch.setattr(alerting, "send_alert_email", email)
        monkeypatch.setattr(alerting, "send_webhook", webhook)
        monkeypatch.setattr(alerting.notifications, "push_alert", inbox)


# ============================================================ 归一与判定
class TestChannelText:
    def test_unknown_ids_are_dropped(self) -> None:
        """界面解释不了的 id 不落库（历史里塞一个没人认识的渠道比空着更糟）。"""
        assert alerting.channel_text(["email", "sms", "carrier-pigeon"]) == "email"

    def test_order_is_canonical_not_call_order(self) -> None:
        """顺序固定：告警与恢复两条记录的写法一致，肉眼比对不用管顺序。"""
        assert alerting.channel_text(["inbox", "webhook", "email"]) == "email,webhook,inbox"

    def test_duplicates_collapse(self) -> None:
        assert alerting.channel_text(["email", "email", ""]) == "email"

    def test_accepts_the_stored_string(self) -> None:
        """升级 / 回填时要能把库里的字符串再传进来。"""
        assert alerting.channel_text("email,inbox") == "email,inbox"

    def test_empty_values(self) -> None:
        assert alerting.channel_text(None) == ""
        assert alerting.channel_text([]) == ""


class TestChannelIds:
    def test_only_enabled_channels_count(self) -> None:
        assert alerting.channel_ids(
            {"enabled": True}, {"enabled": False}, {"enabled": True}
        ) == ["feishu", "webhook"]

    def test_no_webhook_config_means_no_webhook(self) -> None:
        assert alerting.channel_ids({"enabled": False}, {"enabled": True}) == ["email"]

    def test_everything_off(self) -> None:
        assert alerting.channel_ids({}, {}, None) == []

    def test_matches_what_dispatch_actually_sends(self, db, monkeypatch) -> None:
        """判定函数与投递共用一份条件：关掉的渠道既不发、也不进渠道列。"""
        rec = _Recorder(monkeypatch)
        feishu = {"enabled": True}
        email_cfg = {"enabled": False}
        hook = {"enabled": True, "webhook": "https://example.invalid/hook"}

        ok, _ = _run(
            alerting.dispatch("alice", feishu, email_cfg, "t", "b", {}, webhook=hook)
        )

        assert ok is True
        assert rec.calls == {"feishu": 1, "email": 0, "webhook": 1, "inbox": 0}
        assert alerting.channel_ids(feishu, email_cfg, hook) == ["feishu", "webhook"]


# ============================================================ 落库
class TestRecordChannel:
    def test_channels_and_inbox_are_stored(self, db) -> None:
        _run(
            alerting.record(
                _entry(),
                source=alerting.SOURCE_RESOURCE,
                channels=[alerting.CHANNEL_EMAIL, alerting.CHANNEL_FEISHU],
            )
        )
        # 顺序按 CHANNEL_IDS 归一；inbox 由 record 自己补上
        assert _channels() == ["feishu,email,inbox"]

    def test_inbox_is_added_even_without_external_channels(self, db) -> None:
        """三个外部通道全关也一样有站内信 —— 铃铛里确实会多一条。"""
        _run(alerting.record(_entry(detail="告警通知已停用，仅记录")))
        assert _channels() == ["inbox"]

    def test_no_recipient_means_no_inbox(self, db) -> None:
        """没有收件人的记录不会写站内消息，渠道里也就不能出现站内信。"""
        _run(alerting.record(_entry(username=""), channels=["email"]))
        assert _channels() == ["email"]

    def test_failed_delivery_still_records_the_attempt(self, db) -> None:
        """投放失败的渠道也要记：用户最需要知道的就是「它试过邮件、失败了」。"""
        _run(
            alerting.record(
                _entry(result="failed", detail="邮件：发送失败：Connection unexpectedly closed"),
                channels=["email"],
            )
        )
        rows = _run(alerting.history(10))
        assert rows[0]["channel"] == "email,inbox"
        assert rows[0]["result"] == "failed"

    def test_history_returns_the_column(self, db) -> None:
        _run(alerting.record(_entry(), channels=["feishu"]))
        row = _run(alerting.history(10))[0]
        assert row["channel"] == "feishu,inbox"


# ============================================================ 端到端
def test_evaluate_records_the_channels_it_dispatched(db, monkeypatch) -> None:
    """资源告警：历史里的渠道要与这一轮实际投递的通道一致。"""

    async def fake_dispatch(owner, feishu, email_cfg, title, text, card,
                            webhook=None, context=None, source=""):
        return True, "已发送"

    class _Client:
        class conn:  # noqa: N801 - 只要有个对象给日志用
            configured = True
            host = "10.0.0.1"

        async def cluster_resources(self) -> List[Dict[str, Any]]:
            return [
                {
                    "type": "qemu",
                    "node": "pve",
                    "vmid": 100,
                    "name": "vm-a",
                    "status": "running",
                    "cpu": 0.95,
                    "maxcpu": 4,
                    "mem": 1,
                    "maxmem": 2,
                    "disk": 0,
                    "maxdisk": 100,
                }
            ]

    async def fake_ip(client, node, vmid):
        return ""

    async def fake_rules():
        return [
            {
                "id": "r1",
                "username": "alice",
                "name": "CPU 高负载",
                "target_type": "vm",
                "target": "*",
                "metric": "cpu",
                "threshold": 80,
                "enabled": True,
            }
        ]

    async def setup() -> None:
        # 通用 Webhook 默认是关的（填了地址还要显式打开），这里打开它，
        # 让「四个渠道都在」这一种最全的情况被覆盖到
        await alerting.save_webhook(
            {"enabled": True, "webhook": "https://example.invalid/hook"}, owner="alice"
        )

    _run(setup())

    monkeypatch.setattr(alerting, "get_client", lambda: _Client())
    monkeypatch.setattr(alerting, "load_rules", fake_rules)
    monkeypatch.setattr(alerting, "dispatch", fake_dispatch)
    monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)

    _run(alerting.evaluate())

    row = _run(alerting.history(10))[0]
    assert row["username"] == "alice"
    # 飞书 + 邮件默认开、Webhook 上面打开了 → 加上 record 自己补的站内信
    assert row["channel"] == "feishu,email,webhook,inbox"


# ============================================================ 接口与导出
def test_api_exposes_the_channel(api) -> None:
    headers = auth_headers(api)
    _exec(
        "INSERT INTO alert_history (username, rule_id, rule_name, target_type, target,"
        " metric, value, threshold, result, detail, channel, kind, is_repeat, ts)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            "admin",
            "cpu",
            "CPU 高负载",
            "vm",
            "vm-a",
            "cpu",
            95.0,
            80.0,
            "sent",
            "邮件：已发送",
            "email,inbox",
            "alarm",
            0,
            1_700_000_000,
        ),
    )
    body = api.get("/api/alerts", headers=headers).json()
    assert body["history"][0]["channel"] == "email,inbox"

    csv = api.get("/api/export/alerts", headers=headers)
    assert csv.status_code == 200, csv.text
    text = csv.content.decode("utf-8-sig")
    assert "发送渠道" in text
    assert "邮件、站内信" in text
