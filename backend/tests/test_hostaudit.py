"""主机登录审计：last / lastb / sudo 解析、增量汇入面板审计、接口回归。

解析用例用的是**真实命令的输出格式**（wtmp 的排版几十年没变过，但各种边界
很多：still logged in、有结束时间和时长、reboot 行、lastb 的 ssh:notty）。
汇入用桩替换采集函数，验证「只导增量、不重复写」。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import hostaudit, store  # noqa: E402
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: E402,F401

SUCCESS_LINE = (
    "root     pts/6        172.16.149.5     Fri Sep 25 07:24:58 2026   still logged in"
)
RANGE_LINE = (
    "root     pts/0        172.16.149.3     Thu Sep 24 08:42:47 2026 - Thu Sep 24 09:20:23 2026  (00:37)"
)
REBOOT_LINE = (
    "reboot   system boot  6.6.119-52.7.tl4.x86_64 Thu Sep 24 18:41:18 2026   still running"
)
FAILED_LINE = (
    "root     ssh:notty    172.16.149.5     Fri Sep 25 07:24:42 2026 - Fri Sep 25 07:24:42 2026  (00:00)"
)


class TestParseLast:
    def test_still_logged_in(self) -> None:
        row = hostaudit.parse_last_line(SUCCESS_LINE)
        assert row and row["user"] == "root"
        assert row["tty"] == "pts/6"
        assert row["ip"] == "172.16.149.5"
        assert row["start"] is not None
        assert row["end"] is None
        assert row["state"] == "still logged in"

    def test_range_with_duration(self) -> None:
        row = hostaudit.parse_last_line(RANGE_LINE)
        assert row and row["ip"] == "172.16.149.3"
        assert row["start"] and row["end"] and row["end"] > row["start"]
        assert row["duration"] == "00:37"
        assert row["state"] == ""

    def test_reboot_row_is_not_a_login(self) -> None:
        row = hostaudit.parse_last_line(REBOOT_LINE)
        assert row and row["kind"] == "reboot"
        assert row["ip"] == ""
        assert row["kernel"].startswith("6.6.119")
        assert row["state"] == "still running"

    def test_failed_login_from_lastb(self) -> None:
        row = hostaudit.parse_last_line(FAILED_LINE)
        assert row and row["tty"] == "ssh:notty"
        assert row["ip"] == "172.16.149.5"

    @pytest.mark.parametrize(
        "line",
        [
            "wtmp begins Sat Sep 19 18:52:49 2026",
            "btmp begins Fri Sep 19 18:52:49 2026",
            "",
            "   ",
        ],
    )
    def test_header_and_blank_ignored(self, line: str) -> None:
        assert hostaudit.parse_last_line(line) is None

    def test_output_sorted_newest_first_and_tagged(self) -> None:
        rows = hostaudit.parse_last_output(
            "\n".join([SUCCESS_LINE, RANGE_LINE, FAILED_LINE, "wtmp begins Sat Sep 19 18:52:49 2026"]),
            kind="failed",
        )
        assert len(rows) == 3
        assert all(row["success"] is False for row in rows)
        starts = [row["start"] or 0 for row in rows]
        assert starts == sorted(starts, reverse=True)

    def test_success_output_keeps_reboot_but_flags_it(self) -> None:
        rows = hostaudit.parse_last_output("\n".join([REBOOT_LINE, SUCCESS_LINE]))
        assert [row["kind"] for row in rows] == ["login", "reboot"]
        assert rows[1]["kernel"].startswith("6.6.119")


class TestParseSudo:
    def test_command_line(self) -> None:
        line = (
            "2026-09-25T09:00:00+08:00 host sudo:  ops : TTY=pts/1 ; PWD=/home/ops ;"
            " USER=root ; COMMAND=/bin/systemctl restart nginx"
        )
        events = hostaudit.parse_auth_events([line])
        assert len(events) == 1
        event = events[0]
        assert event["kind"] == "sudo" and event["success"] is True
        assert event["user"] == "ops"
        assert event["target"] == "root"
        assert event["tty"] == "pts/1"
        assert event["command"] == "/bin/systemctl restart nginx"
        assert event["ts"] is not None

    def test_session_opened(self) -> None:
        line = (
            "2026-09-25T09:01:00+08:00 host sudo: pam_unix(sudo:session):"
            " session opened for user root by ops(uid=1000)"
        )
        events = hostaudit.parse_auth_events([line])
        assert events and events[0]["target"] == "root"
        assert events[0]["user"] == "ops"

    def test_authentication_failure(self) -> None:
        line = (
            "2026-09-25T09:02:00+08:00 host sudo: pam_unix(sudo:auth):"
            " authentication failure; logname= uid=1000 euid=0 tty=/dev/pts/1"
            " ruser=ops rhost=  user=ops"
        )
        events = hostaudit.parse_auth_events([line])
        assert events and events[0]["success"] is False
        assert events[0]["user"] == "ops"

    def test_su_is_recorded(self) -> None:
        line = (
            "2026-09-25T09:03:00+08:00 host su: pam_unix(su-l:session):"
            " session opened for user postgres by root(uid=0)"
        )
        events = hostaudit.parse_auth_events([line])
        assert events and events[0]["kind"] == "su"
        assert events[0]["target"] == "postgres"

    def test_irrelevant_lines_ignored(self) -> None:
        events = hostaudit.parse_auth_events(
            [
                "2026-09-25T09:04:00+08:00 host sshd[1]: Accepted password for root from 1.2.3.4 port 22 ssh2",
                "2026-09-25T09:04:01+08:00 host CRON[2]: pam_unix(cron:session): session opened for user root",
            ]
        )
        assert events == []


class TestHostAuditApi:
    def _stub(self, monkeypatch, logins=("success",), sudo=None) -> None:
        # 时间戳必须是「现在附近」：汇入只回溯 IMPORT_LOOKBACK_DAYS（7 天），
        # 写死一个过去的常量会让用例在某天突然变成「一条都没导进来」—— 踩过一次。
        now = time.time()

        async def fake_logins(host_id: str, kind: str = "success", limit: int = 500):
            entries = [
                {
                    "kind": "login",
                    "user": "root",
                    "tty": "pts/0",
                    "ip": "172.16.149.3" if kind == "success" else "9.9.9.9",
                    "start": now - 600,
                    "end": None,
                    "duration": "",
                    "state": "still logged in",
                    "success": kind == "success",
                }
            ]
            return {"host_id": host_id, "name": "pve-1", "ok": True, "error": "", "entries": entries}

        async def fake_sudo(host_id: str, hours: int = 24):
            return {
                "host_id": host_id,
                "name": "pve-1",
                "ok": True,
                "error": "",
                "entries": [
                    {
                        "kind": "sudo",
                        "success": True,
                        "ts": now - 300,
                        "user": "ops",
                        "target": "root",
                        "tty": "pts/1",
                        "command": "/bin/systemctl restart nginx",
                    }
                ],
            }

        monkeypatch.setattr(hostaudit, "collect_logins", fake_logins)
        monkeypatch.setattr(hostaudit, "collect_sudo", fake_sudo)

    def test_hosts_always_include_local(self, api) -> None:
        data = api.get("/api/host-audit/hosts", headers=auth_headers(api)).json()
        assert any(item["id"] == "local" for item in data)

    def test_logins_endpoint(self, api, monkeypatch) -> None:
        self._stub(monkeypatch)
        data = api.get("/api/host-audit/logins?host_id=local", headers=auth_headers(api)).json()
        assert data["ok"] is True
        assert data["entries"][0]["ip"] == "172.16.149.3"

    def test_unknown_host_is_404(self, api) -> None:
        """不存在的主机要 404（这条不装桩，走真实的主机查找）。"""
        assert (
            api.get("/api/host-audit/logins?host_id=nope", headers=auth_headers(api)).status_code
            == 404
        )
        assert (
            api.get("/api/host-audit/sudo?host_id=nope", headers=auth_headers(api)).status_code
            == 404
        )

    def test_sudo_endpoint(self, api, monkeypatch) -> None:
        self._stub(monkeypatch)
        data = api.get("/api/host-audit/sudo?host_id=local", headers=auth_headers(api)).json()
        assert data["entries"][0]["command"] == "/bin/systemctl restart nginx"

    def test_import_writes_audit_once(self, api, monkeypatch) -> None:
        """汇入是增量的：第二次跑不会再写一遍（游标拦住）。"""
        self._stub(monkeypatch)
        headers = auth_headers(api)
        first = api.post("/api/host-audit/import?host_id=local", headers=headers).json()
        assert first["imported"] >= 2, first  # 1 条登录 + 1 条 sudo（成功/失败各一次采集）

        rows = await_rows(api, "host.sudo")
        assert len(rows) == 1
        assert "nginx" in rows[0]["detail"]

        second = api.post("/api/host-audit/import?host_id=local", headers=headers).json()
        assert second["imported"] == 0
        assert len(await_rows(api, "host.sudo")) == 1

        cursors = api.get("/api/host-audit/cursors", headers=headers).json()
        local = next(item for item in cursors if item["host_id"] == "local")
        assert local["last_ts"] > 0

    def test_non_admin_cannot_read_panel_host_audit(self, api, monkeypatch) -> None:
        """登录审计默认取的是面板本机，普通用户拿不到。

        与 SSH 概览同理（``hostscope`` 的本地数据恒为管理员专属）：默认不带
        ``host_id`` 就是本机，即便被授予 ``ssh.view`` 也是 403。导入同理。
        """
        viewer = user_with_permissions(api, ["ssh.view"], "auditview")
        assert api.get("/api/host-audit/logins", headers=viewer).status_code == 403
        assert api.post("/api/host-audit/import", headers=viewer).status_code == 403

    def test_vm_view_matches_source_ip(self, api, monkeypatch) -> None:
        """VM 视角：按虚拟机 IP 匹配「它登录过哪些主机」。"""
        self._stub(monkeypatch)

        async def fake_ip(client, node, vmid):
            return "172.16.149.3"

        from app import alerting

        monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)
        headers = auth_headers(api)
        # VM 视角读的是**已汇入面板审计**的记录，不是实时采集：先把这台主机的
        # 日志导进来，否则这条用例永远拿到 0 条
        imp = api.post("/api/host-audit/import?host_id=local", headers=headers)
        assert imp.status_code == 200, imp.text
        data = api.get("/api/host-audit/vm/pve1/100", headers=headers).json()
        assert data["ip"] == "172.16.149.3"
        assert len(data["entries"]) == 1
        # 命中记录的主机标签取自 host_rows()，不是采集桩里写死的名字
        assert data["entries"][0]["host_id"] == "local"
        assert data["entries"][0]["ip"] == "172.16.149.3"


def await_rows(api, action: str) -> List[Dict[str, Any]]:
    """同步读审计日志：FastAPI 的 TestClient 已经是同步封装，这里直接 GET。"""
    resp = api.get(f"/api/audit?action={action}&limit=50")
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]
