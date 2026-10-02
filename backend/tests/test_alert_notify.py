"""告警推送来源开关：读写的健壮性、dispatch / record 的门禁、接口权限。

这个开关的失效方式都很隐蔽 —— 要么「该发的没发」（用户以为告警坏了），要么
「说不发还在发」（用户以为已经静默了）。所以用例重点盯三件事：

* **默认全开**：升级后不能突然少收到本该收到的告警；
* **未知来源放行**：调用点把来源名写错时宁可多推一条，也不要整类告警静默；
* **静默要真的安静**：来源被停推后，命中的告警整条丢弃（不落库、不留站内
  消息），告警历史与工作台待办里都不该再出现它们 —— 数字降不下去，用户只会
  以为这个开关没生效；
* **别把真送达的抹掉**：唯一的例外是已经成功投递的记录，那种时间差不该被丢弃。

模块层用 ``asyncio.run`` + ``db`` 夹具（只建表、不起 app），接口层用 ``api``
夹具的 TestClient。两层不混用：TestClient 的全局连接池绑在它自己的事件循环上，
模块层再新建循环去碰同一个池会互相踩。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import alerting, database, notifications  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

ADMIN_PASSWORD = settings.admin_password
VIEWER_PASSWORD = "Unit-Test-Pa55word"
SOURCE = "portguard"


async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池（它绑在 asyncio.run 新建的循环上）。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


async def _collect(agen) -> List[Any]:
    """把异步生成器收成列表。必须在同一个事件循环里消费，
    所以要和 _run 一起用（``_collect(gen())`` 交给 _run 跑）。"""
    return [item async for item in agen]


@pytest.fixture()
def db(clean_mysql_db):
    """只建表、不启动 app。告警历史 / 活跃状态表在 alerting.init_table() 里。"""
    from app import store

    _run(store.init_db())
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


def _history_count() -> int:
    return int(_exec("SELECT COUNT(*) FROM alert_history")[0][0])


def _notification_count() -> int:
    return int(_exec("SELECT COUNT(*) FROM notifications")[0][0])


def _last_history() -> Dict[str, Any]:
    rows = _exec(
        "SELECT result, detail FROM alert_history ORDER BY id DESC LIMIT 1"
    )
    assert rows, "应当写入了一条告警历史"
    return {"result": rows[0][0], "detail": rows[0][1]}


def _entry(**over: Any) -> Dict[str, Any]:
    entry = {
        "username": "admin",
        "rule_id": "ssh-fail",
        "rule_name": "SSH 登录失败次数",
        "target_type": "ssh",
        "target": "1.2.3.4",
        "metric": "ssh_fail",
        "value": 12.0,
        "threshold": 10.0,
        "result": "sent",
        "detail": "飞书：已发送",
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


def _all_channels_on() -> Dict[str, Any]:
    return {
        "feishu": {"enabled": True},
        "email": {"enabled": True},
        "webhook": {"enabled": True, "webhook": "https://example.invalid/hook"},
    }


# ============================================================ 注册表与读写
class TestNotifySourcesConfig:
    def test_registry_is_stable(self, db) -> None:
        ids = [item["id"] for item in alerting.NOTIFY_SOURCES]
        assert ids == ["resource", "portguard", "sshguard", "sshremote", "backupguard"]
        assert alerting.NOTIFY_SOURCE_IDS == tuple(ids)
        # 审计日志要把 id 翻成人话，标签不能缺
        assert all(alerting.NOTIFY_LABELS[i] for i in ids)

    def test_every_source_has_a_call_site_constant(self, db) -> None:
        """每个来源都要有对应常量，否则调用点只能手写字符串 —— 拼错就永远静默。"""
        for name in (
            "SOURCE_RESOURCE",
            "SOURCE_PORTGUARD",
            "SOURCE_SSHGUARD",
            "SOURCE_SSHREMOTE",
            "SOURCE_BACKUPGUARD",
        ):
            assert getattr(alerting, name) in alerting.NOTIFY_SOURCE_IDS

    def test_defaults_are_all_on(self, db) -> None:
        cfg = _run(alerting.load_notify_sources())
        assert cfg == alerting.default_notify_sources()
        assert all(cfg.values())
        # 没配过时必须全开：升级后不能突然少收到告警
        assert all(_run(alerting.push_enabled(s)) for s in alerting.NOTIFY_SOURCE_IDS)

    def test_save_and_reload_roundtrip(self, db) -> None:
        saved = _run(alerting.save_notify_sources({SOURCE: False}))
        assert saved[SOURCE] is False
        assert saved["resource"] is True  # 没传的保持原值

        assert _run(alerting.load_notify_sources())[SOURCE] is False
        assert _run(alerting.push_enabled(SOURCE)) is False

    def test_save_ignores_unknown_keys(self, db) -> None:
        """只认注册表里的来源：不能凭空写进一个谁也不认识的键。"""
        saved = _run(alerting.save_notify_sources({"not_a_source": False}))
        assert "not_a_source" not in saved
        assert set(saved) == set(alerting.NOTIFY_SOURCE_IDS)

    def test_malformed_config_falls_back_to_all_on(self, db) -> None:
        async def corrupt() -> None:
            from app import store

            await store.set_setting(alerting.NOTIFY_SOURCES_KEY, "{ not json")

        _run(corrupt())
        assert _run(alerting.load_notify_sources()) == alerting.default_notify_sources()

    def test_partial_config_keeps_other_defaults(self, db) -> None:
        async def partial() -> None:
            from app import store

            await store.set_setting(
                alerting.NOTIFY_SOURCES_KEY, json.dumps({SOURCE: False})
            )

        _run(partial())
        cfg = _run(alerting.load_notify_sources())
        assert cfg[SOURCE] is False
        assert cfg["resource"] is True


# ============================================================ 门禁
class TestPushGate:
    def test_unknown_source_fails_open(self, db) -> None:
        """来源名拼错时放行：宁可多推一条，也不要让整类告警静默。"""
        assert _run(alerting.push_enabled("")) is True
        assert _run(alerting.push_enabled("typo-source")) is True
        assert _run(alerting.push_enabled("resource")) is True

    def test_dispatch_skips_every_channel_when_muted(
        self, db, monkeypatch
    ) -> None:
        rec = _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({SOURCE: False}))
        cfg = _all_channels_on()

        ok, detail = _run(
            alerting.dispatch(
                "admin",
                cfg["feishu"],
                cfg["email"],
                "标题",
                "正文",
                {"card": True},
                webhook=cfg["webhook"],
                source=SOURCE,
            )
        )
        assert ok is False
        assert detail == alerting.MUTED_DETAIL
        assert rec.calls == {"feishu": 0, "email": 0, "webhook": 0, "inbox": 0}

    def test_dispatch_still_sends_when_enabled(self, db, monkeypatch) -> None:
        rec = _Recorder(monkeypatch)
        cfg = _all_channels_on()
        ok, _ = _run(
            alerting.dispatch(
                "admin",
                cfg["feishu"],
                cfg["email"],
                "标题",
                "正文",
                {"card": True},
                webhook=cfg["webhook"],
                source=SOURCE,
            )
        )
        assert ok is True
        assert rec.calls["feishu"] == 1
        assert rec.calls["email"] == 1
        assert rec.calls["webhook"] == 1

    def test_source_is_scoped(self, db, monkeypatch) -> None:
        """关掉端口巡检不能连带把 SSH 告警也停了。"""
        rec = _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({SOURCE: False}))
        cfg = _all_channels_on()

        _run(
            alerting.dispatch(
                "admin", cfg["feishu"], cfg["email"], "t", "b", {}, source=SOURCE
            )
        )
        assert rec.calls["feishu"] == 0

        _run(
            alerting.dispatch(
                "admin",
                cfg["feishu"],
                cfg["email"],
                "t",
                "b",
                {},
                source="sshguard",
            )
        )
        assert rec.calls["feishu"] == 1

    def test_record_muted_drops_the_whole_entry(self, db, monkeypatch) -> None:
        """停推是「这一类告警我不要了」：整条丢弃，不写历史也不留站内消息。

        早先的语义是「只留历史、不发站内」，但那样首页工作台的「N 条异常待处理」
        一分不少 —— 关掉开关却什么都没变，开关等于没关。所以改成整条丢弃
        （见 ``alerting.record`` 的注释）。站内投递换成了计数器，所以「发没发」
        看 rec.calls，别看库里的行数。
        """
        rec = _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({SOURCE: False}))
        before = _history_count()

        # 用一条「没发出去」的记录：result='sent' 是唯一例外（那条已经投递出去了，
        # 说明开关是在投递之后才关的），不该被静默规则抹掉
        _run(alerting.record(_entry(result="failed"), source=SOURCE))

        # 历史也一并丢掉：不写历史才叫静默，留记录那叫失明
        assert _history_count() == before
        assert rec.calls["inbox"] == 0

    def test_record_enabled_writes_both(self, db, monkeypatch) -> None:
        rec = _Recorder(monkeypatch)
        before = _history_count()

        _run(alerting.record(_entry(), source=SOURCE))

        assert _history_count() == before + 1
        assert rec.calls["inbox"] == 1

    def test_record_without_source_always_pushes(self, db, monkeypatch) -> None:
        """不带来源的调用（第三方模块自建的事件）保持原行为，不受开关影响。"""
        rec = _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({s: False for s in alerting.NOTIFY_SOURCE_IDS}))
        before = _history_count()

        _run(alerting.record(_entry()))

        assert rec.calls["inbox"] == 1
        assert _history_count() == before + 1

    def test_muted_record_is_discarded(self, db, monkeypatch) -> None:
        """停推的告警整条丢弃：不落库、不留站内消息。

        旧版本的做法是「历史照写、只标 muted」，代价是告警历史里堆着一批用户
        明确说过不要的记录，首页工作台的「N 条异常告警待处理」也长期降不下来 ——
        静默开关的意义正是让这个数字归零，留一份痕反而把它顶住了。
        """
        rec = _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({SOURCE: False}))
        cfg = _all_channels_on()
        before = _history_count()

        # 走完整链路：dispatch 判定停推 → 调用点拿到 failed → record 应当直接丢弃
        ok, detail = _run(
            alerting.dispatch(
                "admin", cfg["feishu"], cfg["email"], "t", "b", {}, source=SOURCE
            )
        )
        assert ok is False and detail == alerting.MUTED_DETAIL

        _run(alerting.record(_entry(result="failed", detail=detail), source=SOURCE))

        assert _history_count() == before, "停推的记录不该落库"
        assert _notification_count() == 0, "停推的记录不该留站内消息"
        assert rec.calls == {"feishu": 0, "email": 0, "webhook": 0, "inbox": 0}

    def test_real_failure_is_not_swallowed(self, db, monkeypatch) -> None:
        """来源没关时，真失败照写、老实标 failed —— 丢弃只针对被停推的来源。"""
        _Recorder(monkeypatch)
        # 三个通道全关：dispatch 会返回「告警通知已停用，仅记录」
        _run(
            alerting.record(
                _entry(result="failed", detail="告警通知已停用，仅记录"),
                source=SOURCE,
            )
        )
        row = _last_history()
        assert row["result"] == "failed"
        assert row["detail"] == "告警通知已停用，仅记录"

    def test_already_sent_is_kept(self, db, monkeypatch) -> None:
        """已经送达的记录照旧落库，不因「此刻开关是关的」被一起丢掉。

        丢弃的条件是「来源被停推 **且** 确实没送达」。少了后半句，一个把 source
        传给 record 却没传给 dispatch 的调用点，会把真发出去的告警一并抹掉；
        开关在投递之后才被关掉的时间差也不该有这种后果。
        """
        _Recorder(monkeypatch)
        _run(alerting.save_notify_sources({SOURCE: False}))

        _run(alerting.record(_entry(result="sent"), source=SOURCE))
        assert _last_history()["result"] == "sent"

    def test_history_hides_legacy_muted_rows(self, db) -> None:
        """旧版本留下的 muted 记录不再对外输出。

        新版本不会产生这种行，但升级前的库里可能已经有了。读取端把它们滤掉，
        告警页的历史列表与首页工作台的待处理条数就同时干净了 —— 过滤写在
        history() 这一处，两个消费方不必各滤一遍，也不会有人漏滤。
        """
        _run(alerting.record(_entry(), source=SOURCE))
        # 直接插一条旧版本会写的记录（新代码已经没有这条写路径了）
        _exec(
            "INSERT INTO alert_history (username, rule_id, rule_name, target_type,"
            " target, metric, value, threshold, result, detail, kind, ts)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                "admin",
                "ssh-fail",
                "旧版本记录",
                "ssh",
                "1.2.3.4",
                "ssh_fail",
                12.0,
                10.0,
                alerting.RESULT_MUTED,
                alerting.MUTED_DETAIL,
                "alarm",
                1,
            ),
        )
        assert _history_count() == 2, "库里确实有两条"

        rows = _run(alerting.history(50))
        assert [r["result"] for r in rows] == ["sent"]

        exported = _run(_collect(alerting.stream_history()))
        assert [r["result"] for r in exported] == ["sent"], "导出同样不该带上静默记录"

    def test_record_writes_a_real_inbox_row(self, db) -> None:
        """不打桩跑一遍：确认 record 确实往站内通知表里落了行。

        上面几个用例把 push_alert 换成了计数器，验证的是「有没有调」；这条验证
        「调了之后真的写进去了」—— 否则接线断了（比如参数名对不上）也测不出来。
        """
        _run(alerting.record(_entry(), source=SOURCE))
        assert _notification_count() == 1

    def test_unmuting_restores_delivery(self, db, monkeypatch) -> None:
        rec = _Recorder(monkeypatch)
        cfg = _all_channels_on()
        _run(alerting.save_notify_sources({SOURCE: False}))

        async def pump() -> bool:
            ok, _ = await alerting.dispatch(
                "admin", cfg["feishu"], cfg["email"], "t", "b", {}, source=SOURCE
            )
            return ok

        assert _run(pump()) is False
        _run(alerting.save_notify_sources({SOURCE: True}))
        assert _run(pump()) is True
        assert rec.calls["feishu"] == 1


# ============================================================ 收敛
class TestConvergence:
    """告警收敛：一个「事件」在历史里占一条，而不是每个巡检周期一条。"""

    def test_repeat_rounds_do_not_write_history(self, db, monkeypatch) -> None:
        """持续告警期间的重复轮次：只提醒、不落库。

        这是「一个 node 的 CPU 规则在 27 小时里刷出 40 条历史」的直接对策：
        首轮落一条，之后冷却到点又触发的那几次都不再写历史，也不再建站内消息
        （外部提醒由调用方的 dispatch 照常发，那才是冷却管的事）。
        """
        rec = _Recorder(monkeypatch)
        before = _history_count()

        _run(alerting.record(_entry(), source=SOURCE))
        _run(alerting.record(_entry(), source=SOURCE, repeat=True))
        _run(alerting.record(_entry(), source=SOURCE, repeat=True))

        assert _history_count() == before + 1, "只有首轮该落库"
        assert rec.calls["inbox"] == 1, "重复轮次不该再建站内消息"

    def test_recovery_is_never_treated_as_repeat(self, db) -> None:
        """恢复通知是事件的终点，不是重复轮次：调用方即使传了 repeat 也照写。"""
        before = _history_count()
        _run(alerting.record(_entry(kind="recovery"), source=SOURCE, repeat=True))
        assert _history_count() == before + 1

    def test_recovery_needs_consecutive_quiet_cycles(self, db) -> None:
        """回落要连续 N 轮正常才认定恢复，且再次告警时计数归零。"""
        key = alerting.alarm_key("admin", "ssh-fail", "1.2.3.4")
        state = {
            "username": "admin",
            "rule_id": "ssh-fail",
            "target": "1.2.3.4",
            "ts": 1_700_000_000,
        }

        _run(alerting.mark_active(key, state))
        confirmed = [
            _run(alerting.recovery_confirmed(key, _run(alerting.load_active())[key]))
            for _ in range(alerting.RECOVERY_CONFIRM_CYCLES)
        ]
        assert confirmed == [False] * (alerting.RECOVERY_CONFIRM_CYCLES - 1) + [True]

        # 又告警了：mark_active 顺手把计数复位，恢复判定重新开始数
        _run(alerting.mark_active(key, state))
        assert int(_run(alerting.load_active())[key]["quiet_cycles"]) == 0

    def test_visible_active_skips_muted_sources(self, db) -> None:
        """「正在告警」清单要排除已静默的来源，否则待办里全是这类告警。"""
        key = alerting.alarm_key("admin", "port-open", "host-a")
        _run(
            alerting.mark_active(
                key,
                {
                    "username": "admin",
                    "rule_id": "port-open",
                    "target": "host-a",
                    "ts": 1_700_000_000,
                    "notify_source": SOURCE,
                },
            )
        )
        assert [r["alarm_key"] for r in _run(alerting.visible_active())] == [key]
        # 别人的告警：按归属过滤（普通用户看不到他人的）
        assert _run(alerting.visible_active("someone-else")) == []

        _run(alerting.save_notify_sources({SOURCE: False}))
        assert _run(alerting.visible_active()) == []

        # 来源缺失（升级前写下的旧行）照常展示：宁可多显示一条，也别把真告警藏起来
        legacy = alerting.alarm_key("admin", "port-susp", "host-b")
        _run(
            alerting.mark_active(
                legacy,
                {
                    "username": "admin",
                    "rule_id": "port-susp",
                    "target": "host-b",
                    "ts": 1_700_000_001,
                },
            )
        )
        assert [r["alarm_key"] for r in _run(alerting.visible_active())] == [legacy]


# ============================================================ 接口
class TestNotifySourcesApi:
    def test_overview_exposes_registry_and_state(self, api) -> None:
        body = api.get("/api/alerts", headers=auth_headers(api)).json()
        assert [s["id"] for s in body["notify_sources"]] == list(
            alerting.NOTIFY_SOURCE_IDS
        )
        assert body["notify_enabled"] == alerting.default_notify_sources()
        # 首页待办看的是 active（尚未恢复的），不是 history 的条数
        assert body["active"] == []

    def test_put_requires_admin(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "alertviewer", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "alertviewer", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        # 全局静默开关不能落到普通用户手里：否则等于给了「先把告警捂掉再干活」
        resp = api.put(
            "/api/alerts/notify-sources", json={SOURCE: False}, headers=viewer
        )
        assert resp.status_code == 403

    def test_put_toggles_and_persists(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put(
            "/api/alerts/notify-sources", json={SOURCE: False}, headers=headers
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["notify_enabled"][SOURCE] is False

        listed = api.get("/api/alerts", headers=headers).json()
        assert listed["notify_enabled"][SOURCE] is False
        assert listed["notify_enabled"]["resource"] is True

    def test_put_is_written_to_audit_log(self, api) -> None:
        headers = auth_headers(api)
        api.put("/api/alerts/notify-sources", json={SOURCE: False}, headers=headers)

        rows = _exec(
            "SELECT action, detail FROM audit_log WHERE action = %s ORDER BY id DESC LIMIT 1",
            ("alert.notify_sources",),
        )
        assert rows, "改全局开关必须留痕"
        action, detail = rows[0]
        assert action == "alert.notify_sources"
        # 审计里要写人话，否则「关掉了 portguard」没人看得懂
        assert alerting.NOTIFY_LABELS[SOURCE] in detail

    def test_put_empty_body_is_a_noop(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put("/api/alerts/notify-sources", json={}, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["notify_enabled"] == alerting.default_notify_sources()
