"""SSH 登录安全：日志解析、fail2ban 解析、接口与告警回归。

解析部分是纯函数，直接喂真实日志行的样子（RHEL 的 secure 用 ISO 时间戳、
Debian 的 auth.log 用经典 syslog 时间戳），保证换发行版不会解析不出来。
接口部分用 ``test_api_routes`` 的 ``api`` fixture（带库 + mock PVE），日志来源
统一指向临时文件，所以用例结果与跑测试的机器无关。
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import sshguard  # noqa: E402
from test_api_routes import ADMIN, api, auth_headers  # noqa: E402,F401

FIXED_NOW = 1_790_000_000.0  # 固定参照点：纯解析用例用它，不依赖当前时间
# 接口用例必须用「刚刚」的时间戳：面板只统计窗口内的行，写历史时间会被过滤掉
NOW = time.time()


def iso(ts: float, host: str = "kvm-web") -> str:
    """带本机真实时区偏移的 ISO 时间戳（别写死 +08:00，测试机可能不是东八区）。"""
    return f"{datetime.fromtimestamp(ts).astimezone().isoformat()} {host}"


def line_iso(ts: float, message: str, pid: int = 1000) -> str:
    return f"{iso(ts)} sshd[{pid}]: {message}"


@pytest.fixture()
def log_file(tmp_path, monkeypatch):
    """把日志来源指到一个临时文件，避免依赖跑测试的机器。"""

    path = tmp_path / "secure"
    path.write_text("", encoding="utf-8")

    def write(lines: List[str]) -> None:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    monkeypatch.setattr(sshguard, "LOG_CANDIDATES", (str(path),))
    return write


# --------------------------------------------------------------- 时间戳解析
class TestTimestamp:
    def test_iso_with_offset(self) -> None:
        ts = sshguard.parse_timestamp("2026-09-25T07:24:42.504199+08:00 kvm-web sshd[1]: x")
        assert ts is not None
        assert 1_790_000_000 < ts < 1_800_000_000

    def test_iso_zulu(self) -> None:
        assert sshguard.parse_timestamp("2026-09-25T07:24:42Z host sshd[1]: x") is not None

    def test_classic_syslog_uses_reference_year(self) -> None:
        ts = sshguard.parse_timestamp("Sep 25 07:24:42 host sshd[1]: x", now=FIXED_NOW)
        assert ts is not None
        import time as _time

        assert _time.localtime(ts).tm_mday == 25

    def test_syslog_far_future_rolls_back_a_year(self) -> None:
        """日志尾巴跨年时（12 月的记录、现在是 1 月）不能算成未来。"""
        import time as _time

        january = _time.mktime((2026, 1, 5, 10, 0, 0, 0, 0, -1))
        ts = sshguard.parse_timestamp("Dec 31 23:59:00 host sshd[1]: x", now=january)
        assert ts is not None
        assert _time.localtime(ts).tm_year == 2025

    def test_garbage(self) -> None:
        assert sshguard.parse_timestamp("完全不是日志") is None


# ----------------------------------------------------------------- 事件解析
class TestParseLine:
    def test_failed_password(self) -> None:
        event = sshguard.parse_line(
            line_iso(FIXED_NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 7)
        )
        assert event and event["kind"] == "failed"
        assert event["user"] == "root" and event["ip"] == "1.2.3.4"
        assert event["pid"] == "7"

    def test_failed_password_invalid_user(self) -> None:
        event = sshguard.parse_line(
            line_iso(FIXED_NOW, "Failed password for invalid user admin from 5.6.7.8 port 44 ssh2")
        )
        assert event and event["user"] == "admin"

    def test_invalid_user_line(self) -> None:
        event = sshguard.parse_line(
            line_iso(FIXED_NOW, "Invalid user test from 5.6.7.8 port 44")
        )
        assert event and event["kind"] == "failed" and event["ip"] == "5.6.7.8"

    def test_pam_failure(self) -> None:
        event = sshguard.parse_line(
            line_iso(
                FIXED_NOW,
                "pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0"
                " tty=ssh ruser= rhost=9.9.9.9  user=root",
                11,
            )
        )
        assert event and event["ip"] == "9.9.9.9" and event["user"] == "root"

    def test_pam_without_rhost_is_ignored(self) -> None:
        assert (
            sshguard.parse_line(
                line_iso(FIXED_NOW, "pam_unix(sshd:auth): authentication failure; ruser= rhost=  user=x")
            )
            is None
        )

    def test_accepted_password(self) -> None:
        event = sshguard.parse_line(
            line_iso(FIXED_NOW, "Accepted password for root from 10.0.0.9 port 51 ssh2")
        )
        assert event and event["kind"] == "accepted" and event["method"] == "password"

    def test_accepted_publickey(self) -> None:
        event = sshguard.parse_line(
            line_iso(FIXED_NOW, "Accepted publickey for deploy from 10.0.0.9 port 51 ssh2")
        )
        assert event and event["method"] == "publickey"

    @pytest.mark.parametrize(
        "message",
        [
            "Connection closed by 1.2.3.4 port 5000 [preauth]",
            "Connection reset by authenticating user root 1.2.3.4 port 5000 [preauth]",
            "Did not receive identification string from 1.2.3.4 port 5000",
            "Received disconnect from 1.2.3.4 port 5000:11: Bye Bye [preauth]",
        ],
    )
    def test_noise_is_not_counted(self, message: str) -> None:
        """健康检查、端口扫描都会产生这些行，算成失败会让告警变狼来了。"""
        assert sshguard.parse_line(line_iso(FIXED_NOW, message)) is None


class TestParseLines:
    def test_same_connection_counts_once(self) -> None:
        """一次失败尝试会写两行（pam + Failed password），同一个 PID 只算一次。"""
        events = sshguard.parse_lines(
            [
                line_iso(FIXED_NOW, "pam_unix(sshd:auth): authentication failure; ruser= rhost=1.2.3.4  user=root", 42),
                line_iso(FIXED_NOW + 1, "Failed password for root from 1.2.3.4 port 22 ssh2", 42),
            ]
        )
        assert len([e for e in events if e["kind"] == "failed"]) == 1

    def test_two_attempts_count_twice(self) -> None:
        events = sshguard.parse_lines(
            [
                line_iso(FIXED_NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 42),
                line_iso(FIXED_NOW + 5, "Failed password for root from 1.2.3.4 port 23 ssh2", 43),
            ]
        )
        assert len(events) == 2

    def test_debian_auth_log_style(self) -> None:
        import time as _time

        stamp = _time.strftime("%b %e %H:%M:%S", _time.localtime(FIXED_NOW))
        events = sshguard.parse_lines(
            [f"{stamp} host sshd[7]: Failed password for root from 1.2.3.4 port 22 ssh2"],
            now=FIXED_NOW,
        )
        assert len(events) == 1 and events[0]["ip"] == "1.2.3.4"


class TestAggregate:
    def _events(self) -> List[Dict[str, Any]]:
        return sshguard.parse_lines(
            [
                line_iso(FIXED_NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 1),
                line_iso(FIXED_NOW + 1, "Failed password for admin from 1.2.3.4 port 23 ssh2", 2),
                line_iso(FIXED_NOW + 2, "Failed password for root from 5.6.7.8 port 24 ssh2", 3),
                line_iso(FIXED_NOW + 3, "Accepted password for root from 10.0.0.9 port 25 ssh2", 4),
            ]
        )

    def test_counts_and_order(self) -> None:
        report = sshguard.aggregate(self._events(), FIXED_NOW - 3600)
        assert report["summary"]["failures"] == 3
        assert report["summary"]["distinct_ips"] == 2
        assert report["summary"]["logins"] == 1
        assert [row["ip"] for row in report["top_ips"]] == ["1.2.3.4", "5.6.7.8"]
        assert report["top_ips"][0]["count"] == 2
        assert set(report["top_ips"][0]["users"]) == {"root", "admin"}
        assert report["top_users"][0]["user"] == "root"

    def test_ignore_ips_are_filtered(self) -> None:
        report = sshguard.aggregate(self._events(), FIXED_NOW - 3600, ["1.2.3.4"])
        assert report["summary"]["failures"] == 1
        assert [row["ip"] for row in report["top_ips"]] == ["5.6.7.8"]
        # 被忽略的 IP 连登录记录也不算
        assert report["summary"]["logins"] == 1

    def test_new_ip_flag(self) -> None:
        logins = sshguard.aggregate(self._events(), FIXED_NOW - 3600)["logins"]
        fresh = sshguard.mark_new_logins(logins, {})
        assert fresh[0]["new_ip"] is True
        known = sshguard.mark_new_logins(logins, {"10.0.0.9": {"ip": "10.0.0.9"}})
        assert known[0]["new_ip"] is False

    def test_repeated_new_ip_counts_once(self) -> None:
        logins = [
            {"ts": int(FIXED_NOW), "username": "a", "ip": "1.1.1.1", "method": "password"},
            {"ts": int(FIXED_NOW), "username": "b", "ip": "1.1.1.1", "method": "password"},
        ]
        marked = sshguard.mark_new_logins(logins, {})
        assert [item["new_ip"] for item in marked] == [True, False]


# ---------------------------------------------------------------- fail2ban
JAIL_STATUS_OUTPUT = """Status for the jail: sshd
|- Filter
|  |- Currently failed:\t3
|  |- Total failed:\t128
|  `- File list:\t/var/log/secure
`- Actions
   |- Currently banned:\t2
   |- Total banned:\t17
   `- Banned IP list:\t1.2.3.4 5.6.7.8
"""


class TestFail2banParsing:
    def test_jail_status(self) -> None:
        parsed = sshguard.parse_jail_status(JAIL_STATUS_OUTPUT)
        assert parsed["currently_failed"] == 3
        assert parsed["total_failed"] == 128
        assert parsed["currently_banned"] == 2
        assert parsed["total_banned"] == 17
        assert parsed["banned_ips"] == ["1.2.3.4", "5.6.7.8"]
        assert parsed["log_files"] == ["/var/log/secure"]

    def test_empty_jail(self) -> None:
        parsed = sshguard.parse_jail_status(
            "Status for the jail: sshd\n|- Currently banned:\t0\n`- Banned IP list:\t\n"
        )
        assert parsed["banned_ips"] == []

    def test_render_jail_config(self) -> None:
        text = sshguard.render_jail_config("sshd", 5, 600, 3600, "10.0.0.1, 10.0.0.2")
        assert "[sshd]" in text
        assert "maxretry = 5" in text
        assert "findtime = 600" in text
        assert "bantime = 3600" in text
        assert "ignoreip = 127.0.0.1/8 ::1 10.0.0.1 10.0.0.2" in text

    def test_parse_jail_config(self) -> None:
        parsed = sshguard.parse_jail_config(
            "[sshd]\n# 注释\nenabled = true\nmaxretry = 3\nbantime=600\n"
        )
        assert parsed == {"enabled": "true", "maxretry": "3", "bantime": "600"}

    def test_binary_lookup_covers_common_paths(self, tmp_path, monkeypatch) -> None:
        """装在 /usr/sbin 这类目录、或服务 PATH 较窄时，不能误报「没装」。"""
        monkeypatch.setattr(sshguard.shutil, "which", lambda *a, **k: None)
        monkeypatch.setattr(sshguard, "FAIL2BAN_CANDIDATES", ("/nope/fail2ban-client",))
        assert sshguard.fail2ban_binary() == ""
        assert sshguard.fail2ban_available() is False

        fake = tmp_path / "fail2ban-client"
        fake.write_text("#!/bin/sh\n", encoding="utf-8")
        fake.chmod(0o755)
        monkeypatch.setattr(sshguard, "FAIL2BAN_CANDIDATES", ("/nope/a", str(fake)))
        assert sshguard.fail2ban_binary() == str(fake)
        assert sshguard.fail2ban_available() is True

    def test_absent_status_names_the_host(self, api, monkeypatch) -> None:
        """未安装时要说清在哪台机器上找的、查了哪些路径。"""
        monkeypatch.setattr(sshguard, "fail2ban_binary", lambda: "")
        body = api.get("/api/ssh/fail2ban", headers=auth_headers(api)).json()
        assert body["installed"] is False
        assert body["host"]
        assert body["checked"]
        assert body["host"] in body["hint"]
        assert "只看得到" in body["hint"]

    def test_jail_name_validation(self) -> None:
        assert sshguard.JAIL_NAME_RE.match("sshd")
        assert sshguard.JAIL_NAME_RE.match("sshd-panel.1")
        assert not sshguard.JAIL_NAME_RE.match("sshd;rm -rf /")
        assert not sshguard.JAIL_NAME_RE.match("bad/name")

    def test_ip_validation(self) -> None:
        assert sshguard.IP_RE.match("1.2.3.4")
        assert sshguard.IP_RE.match("2001:db8::1")
        assert not sshguard.IP_RE.match("1.2.3.4; whoami")


class TestPolicyValidation:
    def test_defaults(self) -> None:
        policy = sshguard.normalise_policy({})
        assert policy["max_failures"] == 20
        assert policy["window_hours"] == 24
        assert policy["enabled"] is True

    def test_rejects_out_of_range(self) -> None:
        with pytest.raises(sshguard.PolicyError):
            sshguard.normalise_policy({"window_hours": 9999})
        with pytest.raises(sshguard.PolicyError):
            sshguard.normalise_policy({"max_failures": 0})

    def test_ignore_ips_normalised(self) -> None:
        policy = sshguard.normalise_policy({"ignore_ips": " 10.0.0.1 , 10.0.0.2 10.0.0.3 "})
        assert policy["ignore_ips"] == "10.0.0.1,10.0.0.2,10.0.0.3"


# ------------------------------------------------------------------- 接口
class TestSshApi:
    def test_overview_reads_local_log(self, api, log_file) -> None:
        log_file(
            [
                line_iso(NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 1),
                line_iso(NOW + 1, "Failed password for root from 1.2.3.4 port 23 ssh2", 2),
                line_iso(NOW + 2, "Accepted password for root from 10.0.0.9 port 24 ssh2", 3),
            ]
        )
        resp = api.get("/api/ssh/overview", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["report"]["source"]["available"] is True
        assert body["report"]["summary"]["failures"] == 2
        assert body["report"]["summary"]["logins"] == 1
        assert body["report"]["top_ips"][0]["ip"] == "1.2.3.4"
        assert body["policy"]["max_failures"] == 20

    def test_overview_without_log_source_is_explicit(self, api, monkeypatch) -> None:
        """没有可用日志时要说清楚，而不是假装「一切正常」。"""
        monkeypatch.setattr(
            sshguard,
            "LOG_CANDIDATES",
            ("/definitely/not/here",),
        )
        # **kwargs：fail2ban_binary 会带 path= 再查一次
        monkeypatch.setattr(sshguard.shutil, "which", lambda name, **kwargs: None)
        body = api.get("/api/ssh/overview", headers=auth_headers(api)).json()
        assert body["report"]["source"]["available"] is False
        assert "journalctl" in body["report"]["source"]["detail"]

    def test_policy_roundtrip_and_validation(self, api) -> None:
        headers = auth_headers(api)
        saved = api.put(
            "/api/ssh/policy",
            headers=headers,
            json={"max_failures": 3, "window_hours": 6, "ignore_ips": "10.1.1.1"},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["policy"]["max_failures"] == 3

        # 越界值在入参模型那一层就被拦掉（422 带字段信息），业务层的
        # PolicyError 只兜住直接改配置文件的场景（见 TestPolicyValidation）
        bad = api.put("/api/ssh/policy", headers=headers, json={"window_hours": 500})
        assert bad.status_code == 422

        again = api.get("/api/ssh/overview", headers=headers).json()
        assert again["policy"]["window_hours"] == 6
        assert again["policy"]["ignore_ips"] == "10.1.1.1"

    def test_fail2ban_absent_gives_hint(self, api, monkeypatch) -> None:
        monkeypatch.setattr(sshguard, "fail2ban_binary", lambda: "")
        body = api.get("/api/ssh/fail2ban", headers=auth_headers(api)).json()
        assert body["installed"] is False
        assert "apt install fail2ban" in body["hint"]

    def test_ban_and_unban_call_fail2ban(self, api, monkeypatch) -> None:
        calls: List[List[str]] = []
        monkeypatch.setattr(sshguard, "fail2ban_available", lambda: True)
        monkeypatch.setattr(
            sshguard, "_client", lambda args, timeout=15.0: (calls.append(args), (True, "ok"))[1]
        )
        headers = auth_headers(api)
        banned = api.post(
            "/api/ssh/fail2ban/ban", headers=headers, json={"jail": "sshd", "ip": "1.2.3.4"}
        )
        assert banned.status_code == 200, banned.text
        assert calls[-1] == ["set", "sshd", "banip", "1.2.3.4"]

        unbanned = api.post(
            "/api/ssh/fail2ban/unban", headers=headers, json={"jail": "sshd", "ip": "1.2.3.4"}
        )
        assert unbanned.status_code == 200
        assert calls[-1] == ["set", "sshd", "unbanip", "1.2.3.4"]

        # jail 名的字符白名单由业务层校验（长度够，但含 shell 元字符）
        bad = api.post(
            "/api/ssh/fail2ban/ban", headers=headers, json={"jail": "sshd;rm -rf /", "ip": "1.2.3.4"}
        )
        assert bad.status_code == 400
        assert "jail" in bad.json()["detail"]

    def test_known_ips_roundtrip(self, api, log_file) -> None:
        headers = auth_headers(api)
        log_file(
            [line_iso(NOW, "Accepted password for root from 10.0.0.9 port 22 ssh2", 1)]
        )
        # 先跑一次检查：这次 10.0.0.9 是陌生地址
        check = api.post("/api/ssh/check", headers=headers)
        assert check.status_code == 200, check.text
        assert any(
            item.get("metric") == "ssh_login" for item in check.json()["fired"]
        ), check.text

        logins = api.get("/api/ssh/logins", headers=headers).json()["logins"]
        assert logins and logins[0]["new_ip"] == 1

        # 标记为已知之后再登录：不再报「陌生 IP」
        assert api.post(
            "/api/ssh/known-ips", headers=headers, json={"ip": "10.0.0.9", "note": "跳板机"}
        ).status_code == 200
        assert api.delete("/api/ssh/known-ips/10.0.0.9", headers=headers).status_code == 200

    def test_viewer_can_read_but_not_manage(self, api, monkeypatch) -> None:
        """SSH 封禁会影响整台主机：普通角色只能看。"""
        from test_api_routes import ADMIN

        admin = auth_headers(api)
        api.post(
            "/api/users",
            headers=admin,
            json={"username": "sshviewer", "password": "Unit-Test-Pa55word", "role": "viewer"},
        )
        login = api.post(
            "/api/auth/login",
            json={"username": "sshviewer", "password": "Unit-Test-Pa55word"},
        )
        assert login.status_code == 200, login.text
        viewer = {"Authorization": f"Bearer {login.json()['access_token']}"}

        assert api.get("/api/ssh/overview", headers=viewer).status_code == 200
        assert api.put(
            "/api/ssh/policy", headers=viewer, json={"max_failures": 1}
        ).status_code == 403
        assert api.post(
            "/api/ssh/fail2ban/ban", headers=viewer, json={"jail": "sshd", "ip": "1.2.3.4"}
        ).status_code == 403

    def test_check_fires_threshold_alert_and_recovers(self, api, log_file) -> None:
        headers = auth_headers(api)
        api.put("/api/ssh/policy", headers=headers, json={"max_failures": 2, "window_hours": 24})

        log_file(
            [
                line_iso(NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 1),
                line_iso(NOW + 1, "Failed password for admin from 1.2.3.4 port 23 ssh2", 2),
            ]
        )
        first = api.post("/api/ssh/check", headers=headers).json()
        assert any(item.get("metric") == "ssh_fail" for item in first["fired"])

        # 冷却期内不重复提醒
        second = api.post("/api/ssh/check", headers=headers).json()
        assert not any(item.get("metric") == "ssh_fail" for item in second["fired"])

        # 攻击停了：下一次检查发恢复通知
        log_file([line_iso(NOW, "Accepted password for root from 10.0.0.9 port 22 ssh2", 9)])
        third = api.post("/api/ssh/check", headers=headers).json()
        assert any(item.get("kind") == "recovery" for item in third["fired"])

    def test_alert_when_disabled_does_nothing(self, api, log_file) -> None:
        headers = auth_headers(api)
        api.put(
            "/api/ssh/policy",
            headers=headers,
            json={"enabled": False, "max_failures": 1},
        )
        log_file([line_iso(NOW, "Failed password for root from 1.2.3.4 port 22 ssh2", 1)])
        assert api.post("/api/ssh/check", headers=headers).json()["count"] == 0
