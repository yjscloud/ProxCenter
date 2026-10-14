"""额度预警巡检（:mod:`app.quotaalert`）。

重点是**判定口径**与**冷却 / 恢复**：跑得再对，重复轰炸或把「已经满了」报成
还宽裕，都是这类预警最典型的失败方式。
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import alerting, quotaalert  # noqa: E402


def _row(
    username: str = "alice",
    *,
    limits: Optional[Dict[str, Any]] = None,
    usage: Optional[Dict[str, Any]] = None,
    remaining: Optional[Dict[str, Any]] = None,
    bypass: bool = False,
) -> Dict[str, Any]:
    return {
        "username": username,
        "role": "user",
        "source": "user",
        "limits": limits if limits is not None else {"vm": {}, "ct": {}},
        "usage": usage if usage is not None else {"vm": {}, "ct": {}},
        "remaining": remaining if remaining is not None else {"vm": {}, "ct": {}},
        "bypass": bypass,
    }


def _vm(limit: Any, used: Any, left: Any) -> Dict[str, Any]:
    return {"vm": {"memory_mb": limit}, "ct": {}}, {"vm": {"memory_mb": used}, "ct": {}}, {
        "vm": {"memory_mb": left},
        "ct": {},
    }


class TestTightest:
    """挑「最紧的那一项」。"""

    def test_picks_the_tightest_field(self) -> None:
        limits = {"vm": {"cores": 100, "memory_mb": 100}, "ct": {}}
        usage = {"vm": {"cores": 10, "memory_mb": 95}, "ct": {}}
        remaining = {"vm": {"cores": 90, "memory_mb": 5}, "ct": {}}
        item = quotaalert.tightest(_row(limits=limits, usage=usage, remaining=remaining))
        assert item is not None
        assert item["field"] == "memory_mb"
        assert item["ratio"] == 5.0

    def test_picks_the_tightest_group(self) -> None:
        """虚拟机还宽裕、容器快满了时要报容器那一组。"""
        item = quotaalert.tightest(
            _row(
                limits={"vm": {"count": 10}, "ct": {"count": 2}},
                usage={"vm": {"count": 1}, "ct": {"count": 2}},
                remaining={"vm": {"count": 9}, "ct": {"count": 0}},
            )
        )
        assert item is not None and item["group"] == "ct"
        assert item["ratio"] == 0.0

    def test_detects_over_quota(self) -> None:
        limits, usage, remaining = _vm(10, 14, -4)
        item = quotaalert.tightest(_row(limits=limits, usage=usage, remaining=remaining))
        assert item is not None and item["over"] is True
        assert item["left"] == -4.0

    def test_unlimited_field_is_skipped(self) -> None:
        """上限为 None = 不限，不能当成「上限 0」去比。"""
        item = quotaalert.tightest(_row(limits={"vm": {"count": None}}, usage={"vm": {"count": 99}}))
        assert item is None

    def test_zero_limit_is_skipped(self) -> None:
        """0 与 None 一样都当「不限」：0 很可能是「没配」存出来的值。"""
        item = quotaalert.tightest(_row(limits={"vm": {"count": 0}}, usage={"vm": {"count": 99}}))
        assert item is None

    def test_per_guest_caps_are_not_compared(self) -> None:
        """单台封顶超了会在下发时就被拒，不是「快满了」，不该走这条预警。"""
        item = quotaalert.tightest(
            _row(
                limits={"vm": {"max_memory_mb": 4096}},
                usage={"vm": {"max_memory_mb": 99999}},
            )
        )
        assert item is None

    def test_unreadable_usage_is_not_treated_as_zero(self) -> None:
        """用量读不到（枚举失败）必须跳过，不能当成 0。

        当成 0 会得到「还空着 100%」的假宽裕，恰好把最该提醒的那种人悄悄漏掉
        —— 这正是本条存在的理由。
        """
        item = quotaalert.tightest(
            _row(limits={"vm": {"count": 10}}, usage={"vm": {"count": None}})
        )
        assert item is None

    def test_bypass_admin_is_never_flagged(self) -> None:
        """超级管理员不受额度约束，提醒他等于报一条不该发生的告警。"""
        limits, usage, remaining = _vm(10, 99, -89)
        assert quotaalert.tightest(_row(bypass=True, limits=limits, usage=usage, remaining=remaining)) is None

    def test_no_limits_at_all(self) -> None:
        assert quotaalert.tightest(_row()) is None

    def test_ratio_is_clamped(self) -> None:
        """剩余比例夹在 0~100：负数不该显示成「剩余 -40%」。"""
        limits, usage, remaining = _vm(10, 50, 50)
        item = quotaalert.tightest(_row(limits=limits, usage=usage, remaining=remaining))
        assert item is not None and 0.0 <= item["ratio"] <= 100.0


# --------------------------------------------------------------------------- 巡检


class _Stub:
    """把巡检要碰的告警侧函数全部记下来，跑完再断言「发了什么、发给谁」。"""

    def __init__(self, active: Optional[Dict[str, Any]] = None) -> None:
        self.active: Dict[str, Any] = active or {}
        self.dispatched: List[Dict[str, Any]] = []
        self.recorded: List[Dict[str, Any]] = []
        self.marked: List[str] = []
        self.cleared: List[str] = []
        self.recover_calls: List[str] = []

    async def load_active(self) -> Dict[str, Any]:
        return dict(self.active)

    async def dispatch(self, owner, feishu, email_cfg, title, text, card, **kw):
        self.dispatched.append(
            {"owner": owner, "title": title, "text": text, "source": kw.get("source")}
        )
        return True, "sent"

    async def record(self, entry, *, source="", repeat=False):
        self.recorded.append({**entry, "source": source, "repeat": repeat})

    async def mark_active(self, key, row):
        self.marked.append(key)
        self.active[key] = dict(row, alarm_key=key)

    async def clear_active(self, key):
        self.cleared.append(key)
        self.active.pop(key, None)

    async def recovery_confirmed(self, key, row):
        self.recover_calls.append(key)
        return True

    async def load_feishu(self, owner=""):
        return {"enabled": True, "cooldown": 600}

    async def load_alert_email(self, owner=""):
        return {"enabled": False}

    async def load_webhook(self, owner=""):
        return {"enabled": False}

    async def resolve_language(self, owner):
        return "zh-CN"


def _patch(monkeypatch: pytest.MonkeyPatch, stub: _Stub, overview: Dict[str, Any]) -> None:
    async def init_table():
        return None

    async def fake_overview():
        return overview

    monkeypatch.setattr(quotaalert.quota, "init_table", init_table)
    monkeypatch.setattr(quotaalert.quota, "overview", fake_overview)
    for name in (
        "load_active",
        "dispatch",
        "record",
        "mark_active",
        "clear_active",
        "recovery_confirmed",
        "load_feishu",
        "load_alert_email",
        "load_webhook",
        "resolve_language",
    ):
        monkeypatch.setattr(quotaalert.alerting, name, getattr(stub, name))


def _run(coro):
    return asyncio.run(coro)


class TestEvaluate:
    def test_notifies_the_owner_through_their_own_channel(self, monkeypatch) -> None:
        """通知发给**本人**：额度用完的后果落在他身上，不是管理员身上。"""
        stub = _Stub()
        limits, usage, remaining = _vm(100, 95, 5)
        _patch(
            monkeypatch,
            stub,
            {"users": [_row("alice", limits=limits, usage=usage, remaining=remaining)], "error": ""},
        )
        fired = _run(quotaalert.evaluate())

        assert len(fired) == 1
        assert stub.dispatched[0]["owner"] == "alice"
        assert stub.dispatched[0]["source"] == alerting.SOURCE_QUOTA
        assert stub.marked and stub.recorded

    def test_stores_used_ratio_not_remaining(self, monkeypatch) -> None:
        """历史里存的是**已用比例**，不是剩余比例。

        告警历史的「数值」列画一根条 + 阈值标记，颜色按「越高越红」取
        （utils/format 的 usageColor）。存剩余的话，「剩余 5%」会渲染成一根
        绿色条 —— 一条正在报警的记录显示成绿色，比文案写错还误导。
        """
        stub = _Stub()
        limits, usage, remaining = _vm(100, 95, 5)
        _patch(
            monkeypatch,
            stub,
            {"users": [_row("alice", limits=limits, usage=usage, remaining=remaining)], "error": ""},
        )
        _run(quotaalert.evaluate())

        assert stub.recorded[0]["value"] == 95.0
        assert stub.recorded[0]["threshold"] == 80.0

    def test_healthy_user_is_silent(self, monkeypatch) -> None:
        stub = _Stub()
        limits, usage, remaining = _vm(100, 10, 90)
        _patch(
            monkeypatch,
            stub,
            {"users": [_row("alice", limits=limits, usage=usage, remaining=remaining)], "error": ""},
        )
        assert _run(quotaalert.evaluate()) == []
        assert stub.dispatched == [] and stub.recorded == []

    def test_second_round_within_cooldown_does_not_renotify(self, monkeypatch) -> None:
        """还在告警中就别再喊一遍 —— 额度不会自己涨回去。"""
        stub = _Stub()
        limits, usage, remaining = _vm(100, 95, 5)
        overview = {
            "users": [_row("alice", limits=limits, usage=usage, remaining=remaining)],
            "error": "",
        }
        _patch(monkeypatch, stub, overview)

        _run(quotaalert.evaluate())
        stub.dispatched.clear()
        _run(quotaalert.evaluate())

        assert stub.dispatched == []

    def test_incomplete_cluster_read_skips_the_whole_cycle(self, monkeypatch) -> None:
        """读数不全时用量偏小：宁可沉默，也不能报一条让人放心的话。"""
        stub = _Stub()
        limits, usage, remaining = _vm(100, 95, 5)
        _patch(
            monkeypatch,
            stub,
            {
                "users": [_row("alice", limits=limits, usage=usage, remaining=remaining)],
                "error": "节点 pve3 读取失败",
            },
        )
        assert _run(quotaalert.evaluate()) == []
        assert stub.dispatched == []

    def test_dropped_back_below_threshold_sends_recovery(self, monkeypatch) -> None:
        """回落要发解除通知并清状态，否则那条告警会永远挂着。"""
        limits, usage, remaining = _vm(100, 95, 5)
        key = alerting.alarm_key("alice", quotaalert.RULE_ID, "vm.memory_mb")
        stub = _Stub(active={key: {"username": "alice", "metric": "quota", "notify_source": alerting.SOURCE_QUOTA}})
        _patch(
            monkeypatch,
            stub,
            {"users": [_row("alice", limits=limits, usage=_vm(100, 10, 90)[1], remaining=_vm(100, 10, 90)[2])], "error": ""},
        )
        fired = _run(quotaalert.evaluate())

        assert [f["kind"] for f in fired] == ["recovery"]
        assert key in stub.cleared
        assert stub.recorded[0]["kind"] == "recovery"

    def test_foreign_source_active_state_is_ignored(self, monkeypatch) -> None:
        """别把「集群仲裁」之类的告警状态当成额度预警来处理。"""
        stub = _Stub(
            active={
                "admin|cluster-quorum|pve1": {
                    "username": "admin",
                    "notify_source": alerting.SOURCE_QUORUM,
                }
            }
        )
        _patch(monkeypatch, stub, {"users": [], "error": ""})
        _run(quotaalert.evaluate())
        assert stub.cleared == []