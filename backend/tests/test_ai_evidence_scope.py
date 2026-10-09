"""AI 排查的证据采集：平台级数据必须按归属 / 权限过滤。

进排查的门槛只是 ``baseline.view``，而告警、备份、SSH 登录分析都是**平台级**
数据 —— 告警页与备份页平时按归属过滤，SSH 安全页另有 ``ssh.view`` 门槛。采集
时若沿用「管理员视角」全量取，普通用户就能从提示词里读到别人的告警与备份、
以及面板本机的爆破来源 IP。

这里把三个来源的口径钉死：进排查的一定是「这个人该看到的那一份」。

不依赖 MySQL：``baseline`` / ``alerting`` / ``backupguard`` / ``sshguard`` 全部打桩。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import ai, aitools  # noqa: E402


@pytest.fixture()
def stub_sources(monkeypatch):
    """把五个证据来源换成可观测的桩，返回记录调用参数的 ``seen``。"""
    seen: Dict[str, Any] = {"ssh_calls": 0}

    async def fake_baseline(host_id: str) -> Dict[str, Any]:
        return {"checks": [], "score": 0}

    async def fake_active(owner: Optional[str] = None) -> List[Dict[str, Any]]:
        seen["active_owner"] = owner
        return []

    async def fake_history(limit: int = 0, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        seen["history_owner"] = owner
        return []

    async def fake_backups() -> List[Dict[str, Any]]:
        return [
            {"volid": "alice-1", "state": "verify_failed", "state_detail": "x", "node": "n1", "created_by": "alice"},
            {"volid": "bob-1", "state": "verify_failed", "state_detail": "y", "node": "n1", "created_by": "bob"},
        ]

    async def fake_ssh(hours: int = 24) -> Dict[str, Any]:
        seen["ssh_calls"] += 1
        return {"summary": {}, "top_ips": [], "top_users": [], "logins": []}

    async def fake_changes(hours: int = 24, **kwargs: Any) -> Dict[str, Any]:
        return {}

    monkeypatch.setattr(ai.baseline, "collect_host", fake_baseline)
    monkeypatch.setattr(ai.alerting, "visible_active", fake_active)
    monkeypatch.setattr(ai.alerting, "history", fake_history)
    monkeypatch.setattr(ai.backupguard, "list_records", fake_backups)
    monkeypatch.setattr(ai.sshguard, "collect", fake_ssh)
    monkeypatch.setattr(ai.aitools, "recent_changes", fake_changes)
    return seen


class TestCollectEvidenceScope:
    def test_non_admin_only_gets_own_alerts_and_backups(self, stub_sources) -> None:
        """普通用户：告警按自己过滤；备份只留自己登记的。"""
        evidence = asyncio.run(
            ai.collect_evidence(
                "h1", username="alice", is_admin=False, perms=["baseline.view"]
            )
        )
        assert stub_sources["active_owner"] == "alice"
        assert stub_sources["history_owner"] == "alice"
        assert [row["volid"] for row in evidence["backups"]["abnormal"]] == ["alice-1"]

    def test_admin_is_unrestricted(self, stub_sources) -> None:
        """管理员：owner=None 表示不限，两条备份都在。"""
        evidence = asyncio.run(
            ai.collect_evidence(
                "h1", username="admin", is_admin=True, perms=["baseline.view", "ssh.view"]
            )
        )
        assert stub_sources["active_owner"] is None
        assert stub_sources["history_owner"] is None
        assert len(evidence["backups"]["abnormal"]) == 2

    @pytest.mark.parametrize(
        "perms, expected",
        [
            (None, 0),
            ([], 0),
            (["baseline.view"], 0),
            (["baseline.view", "ssh.view"], 1),
        ],
    )
    def test_ssh_evidence_requires_ssh_permission(
        self, stub_sources, perms, expected: int
    ) -> None:
        """SSH 登录分析是面板本机的全局数据，只有 ``ssh.view`` 才采集。"""
        evidence = asyncio.run(
            ai.collect_evidence("h1", username="alice", is_admin=False, perms=perms)
        )
        assert stub_sources["ssh_calls"] == expected
        assert ("ssh" in evidence) is bool(expected)

    def test_unknown_perms_are_treated_as_no_access(self, stub_sources) -> None:
        """``perms=None`` 是「调用方没声明」，按最小权限处理而不是放开。"""
        asyncio.run(ai.collect_evidence("h1", username="alice", is_admin=False, perms=None))
        assert stub_sources["ssh_calls"] == 0


class TestInternalTools:
    def test_internal_ssh_denied_without_permission(self, monkeypatch) -> None:
        calls: List[int] = []

        async def fake_collect(hours: int = 24) -> Dict[str, Any]:
            calls.append(hours)
            return {"summary": {}, "top_ips": [], "top_users": []}

        monkeypatch.setattr(ai.sshguard, "collect", fake_collect)
        got = asyncio.run(aitools._internal_ssh(perms=[]))
        assert "error" in got and calls == []
        got = asyncio.run(aitools._internal_ssh(perms=["ssh.view"]))
        assert "error" not in got and calls == [24]

    def test_internal_alerts_uses_owner(self, monkeypatch) -> None:
        seen: Dict[str, Any] = {}

        async def fake_history(limit: int = 0, owner: Optional[str] = None):
            seen["owner"] = owner
            return []

        monkeypatch.setattr(ai.alerting, "history", fake_history)
        asyncio.run(aitools._internal_alerts("alice"))
        assert seen["owner"] == "alice"
        asyncio.run(aitools._internal_alerts(None))
        assert seen["owner"] is None

    def test_run_internal_tool_forwards_scope(self, monkeypatch) -> None:
        """分派层要把归属与权限一并透传下去，否则工具自己判断不了。"""
        seen: Dict[str, Any] = {}

        async def fake_history(limit: int = 0, owner: Optional[str] = None):
            seen["owner"] = owner
            return []

        monkeypatch.setattr(ai.alerting, "history", fake_history)
        asyncio.run(
            aitools.run_internal_tool(
                "get_alert_history", {}, username="alice", is_admin=False, perms=[]
            )
        )
        assert seen["owner"] == "alice"
