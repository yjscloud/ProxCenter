"""安全基线：解析 / 判定 / 远程探测 / 加固逻辑与接口回归。

分三层：

* **纯函数层** —— 解析（``login.defs``、sshd 配置、远程分节输出）、评分、判定，
  全部喂手写文本，结果与跑测试的机器无关；
* **加固层** —— 用 monkeypatch 把 ``_require_root`` / ``_run`` / 文件读写换成桩，
  验证最关键的安全约束：写前备份、校验不过自动回滚、以及「别把登录关死」的守卫；
* **接口层** —— 复用 ``test_api_routes`` 的 ``api`` fixture，覆盖鉴权、主机维度的
  加固分发与审计留痕。
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

from app import baseline, sshremote  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

STRONG = "Unit-Test-Pa55word"


def _audit_actions() -> List[str]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT action FROM audit_log")
            return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def _mk_check(
    status: str,
    severity: str = "high",
    *,
    fixable: bool = False,
    auto: bool = True,
    key: str = "k",
    category: str = "ssh",
) -> Dict[str, Any]:
    return {
        "key": key,
        "category": category,
        "label": "示例检查",
        "status": status,
        "severity": severity,
        "value": "v",
        "expected": "e",
        "detail": "",
        "hint": "",
        "fixable": fixable,
        "auto": auto,
    }


def _raw_report(
    host_id: str, checks: List[Dict[str, Any]], ok: bool = True, error: str = ""
) -> Dict[str, Any]:
    """造一份「像真实报告」的 dict（评分走真实的 _score）。

    ``ok=False`` 时按 ``baseline._remote_error_report`` 的形状给占位值 ——
    体检失败的机器没有分数，不该被算成 100 分。
    """
    score, grade, label = baseline._score(checks)
    if not ok:
        score, grade, label = 0, "", "未体检"
    return {
        "host_id": host_id,
        "local": host_id == "local",
        "name": host_id,
        "host": host_id,
        "ok": ok,
        "error": error,
        "elevated": True,
        "privilege": "root",
        "score": score,
        "grade": grade,
        "grade_label": label,
        "os": {},
        "summary": {
            "total": len(checks),
            "pass": sum(1 for c in checks if c["status"] == "pass"),
            "warn": sum(1 for c in checks if c["status"] == "warn"),
            "fail": sum(1 for c in checks if c["status"] == "fail"),
            "unknown": sum(1 for c in checks if c["status"] == "unknown"),
            "fixable": 0,
            "auto_fixable": sum(1 for c in checks if c["status"] != "pass"),
        },
        "categories": [],
        "checks": checks,
    }


# ----------------------------------------------------------- login.defs 解析
class TestLoginDefs:
    def test_parse_ignores_comments(self) -> None:
        values = baseline.parse_login_defs(
            "# 注释\nPASS_MAX_DAYS\t90\nENCRYPT_METHOD SHA512\n\n"
        )
        assert values["PASS_MAX_DAYS"] == "90"
        assert values["ENCRYPT_METHOD"] == "SHA512"

    def test_merge_replaces_in_place(self) -> None:
        text = "# 注释\nPASS_MAX_DAYS\t99999\nPASS_MIN_LEN   5\n"
        out = baseline.merge_login_defs(text, {"PASS_MAX_DAYS": "90"})
        assert "PASS_MAX_DAYS\t90" in out
        assert "# 注释" in out
        assert out.count("PASS_MAX_DAYS") == 1
        assert "PASS_MIN_LEN   5" in out  # 没改的键原样保留

    def test_merge_appends_missing_key(self) -> None:
        out = baseline.merge_login_defs("PASS_MAX_DAYS 90\n", {"PASS_WARN_AGE": "7"})
        assert out.rstrip().endswith("PASS_WARN_AGE\t7")

    def test_merge_handles_empty_file(self) -> None:
        assert baseline.merge_login_defs("", {"PASS_MIN_LEN": "8"}) == "PASS_MIN_LEN\t8\n"


# --------------------------------------------------------------- sshd 解析
class TestSshdParsing:
    def test_first_value_wins(self) -> None:
        settings_map = baseline._parse_sshd_lines(
            [
                "# 注释",
                "PermitRootLogin yes",
                "PermitRootLogin no",
                "MaxAuthTries=4",
                "  X11Forwarding   no",
            ]
        )
        assert settings_map["permitrootlogin"] == "yes"  # sshd 取第一次出现的值
        assert settings_map["maxauthtries"] == "4"
        assert settings_map["x11forwarding"] == "no"

    def test_parse_effective_output_keeps_values_with_spaces(self) -> None:
        text = (
            "permitrootlogin prohibit-password\n"
            "maxauthtries 4\n"
            "ciphers aes128-ctr,aes192-ctr\n"
        )
        settings_map = baseline.parse_sshd_effective(text)
        assert settings_map["permitrootlogin"] == "prohibit-password"
        assert settings_map["ciphers"] == "aes128-ctr,aes192-ctr"

    def test_include_expansion(self, tmp_path) -> None:
        conf_d = tmp_path / "sshd_config.d"
        conf_d.mkdir()
        (conf_d / "10-hard.conf").write_text("PermitRootLogin no\n", encoding="utf-8")
        main = tmp_path / "sshd_config"
        main.write_text(
            "PasswordAuthentication yes\nInclude sshd_config.d/*.conf\n",
            encoding="utf-8",
        )
        settings_map = baseline._parse_sshd_lines(baseline._iter_sshd_lines(str(main)))
        assert settings_map["permitrootlogin"] == "no"
        assert settings_map["passwordauthentication"] == "yes"

    def test_render_dropin_uses_canonical_case(self) -> None:
        text = baseline.render_sshd_dropin(
            {"permitrootlogin": "prohibit-password", "maxauthtries": "4"}
        )
        assert "PermitRootLogin prohibit-password" in text
        assert "MaxAuthTries 4" in text

    def test_ssh_value_alias_equivalence(self) -> None:
        # sshd 会把 without-password 归一成 prohibit-password，不能因此误判未生效
        assert baseline._ssh_value_equal("without-password", "prohibit-password")
        assert baseline._ssh_value_equal("NO", "no")
        assert not baseline._ssh_value_equal("yes", "no")


# ----------------------------------------------------------------- 账号安全
class TestAccounts:
    PASSWD = (
        "root:x:0:0:root:/root:/bin/bash\n"
        "ops:x:1000:1000::/home/ops:/bin/bash\n"
        "sync:x:4:65534::/var/sync:/usr/sbin/nologin\n"
    )

    def test_empty_password_only_counts_loginable(self) -> None:
        shadow = (
            "root:$6$abc:19000:0:99999:7:::\n"
            "ops::19000:0:99999:7:::\n"
            "sync::19000:0:99999:7:::\n"
            "locked:!$6$def:19000:0:99999:7:::\n"
        )
        assert baseline.empty_password_users(shadow, self.PASSWD) == ["ops"]

    def test_unreadable_shadow_returns_nothing(self) -> None:
        assert baseline.empty_password_users(None, self.PASSWD) == []

    def test_uid0_detection(self) -> None:
        assert baseline.uid0_users(self.PASSWD) == []
        assert baseline.uid0_users(
            self.PASSWD + "backdoor:x:0:0::/root:/bin/bash\n"
        ) == ["backdoor"]


# ----------------------------------------------------------------- 内核参数
class TestKernel:
    VALUES = {
        "kernel.randomize_va_space": "2",
        "net.ipv4.tcp_syncookies": "1",
        "net.ipv4.conf.all.rp_filter": "1",
        "net.ipv4.conf.all.accept_redirects": "1",  # 不合格
        "net.ipv4.conf.all.accept_source_route": "0",
        "kernel.dmesg_restrict": "1",
        "kernel.kptr_restrict": "1",
    }

    def test_flags_noncompliant_and_fixable(self) -> None:
        by_key = {c["key"]: c for c in baseline._check_kernel(self.VALUES)}
        assert by_key["sysctl_accept_redirects"]["status"] == "warn"
        assert by_key["sysctl_accept_redirects"]["fixable"] is True
        assert by_key["sysctl_tcp_syncookies"]["status"] == "pass"
        assert by_key["sysctl_tcp_syncookies"]["fixable"] is False

    def test_missing_value_is_unknown(self) -> None:
        by_key = {c["key"]: c for c in baseline._check_kernel({})}
        assert all(c["status"] == "unknown" for c in by_key.values())

    def test_render_sysctl_file(self) -> None:
        text = baseline.render_sysctl_file({"net.ipv4.tcp_syncookies": "1"})
        assert "net.ipv4.tcp_syncookies = 1" in text


# --------------------------------------------------------------------- 评分
class TestScoring:
    def test_all_pass_is_100(self) -> None:
        checks = [_mk_check("pass", "high"), _mk_check("pass", "medium")]
        assert baseline._score(checks) == (100, "A", "优秀")

    def test_all_fail_is_zero(self) -> None:
        checks = [_mk_check("fail", "high"), _mk_check("fail", "low")]
        assert baseline._score(checks)[0] == 0
        assert baseline._score(checks)[1] == "D"

    def test_warn_counts_half(self) -> None:
        checks = [_mk_check("pass", "high"), _mk_check("warn", "high")]
        score, grade, _ = baseline._score(checks)
        assert score == 75
        assert grade == "B"

    def test_unknown_excluded_from_denominator(self) -> None:
        checks = [_mk_check("pass", "high"), _mk_check("unknown", "high")]
        assert baseline._score(checks)[0] == 100


# ------------------------------------------------- 判定：一份快照跑完整套检查
class TestEvaluate:
    """本机与远程共用 ``evaluate()``：这里用手写快照把判定逻辑钉死。"""

    SNAPSHOT: Dict[str, Any] = {
        "elevated": True,
        "privilege": "root",
        "ssh": {
            "effective": {
                "permitrootlogin": "yes",
                "passwordauthentication": "yes",
                "permitemptypasswords": "no",
                "maxauthtries": "4",
                "x11forwarding": "no",
            },
            "files": None,
            "source": "sshd -T（生效配置）",
        },
        "login_defs": "PASS_MAX_DAYS\t99999\nPASS_MIN_LEN\t8\n",
        "pam": "password requisite pam_pwquality.so\n auth required pam_faillock.so\n",
        "firewall": {"active": False, "manager": "", "detail": "未检测到"},
        "ntp": {"synced": True, "service": "chrony", "detail": "active"},
        "shadow": "root:$6$x:1:0:99999:7:::\n",
        "passwd": "root:x:0:0::/root:/bin/bash\n",
        "sysctl": {
            "kernel.randomize_va_space": "2",
            "net.ipv4.tcp_syncookies": "1",
            "net.ipv4.conf.all.rp_filter": "1",
            "net.ipv4.conf.all.accept_redirects": "0",
            "net.ipv4.conf.all.accept_source_route": "0",
            "kernel.dmesg_restrict": "1",
            "kernel.kptr_restrict": "2",
        },
        "hostname": "web1",
        "kernel": "6.6.0-test",
        "os_release": 'NAME="TestOS"\nPRETTY_NAME="TestOS 1"\n',
    }

    def test_report_composition(self) -> None:
        report = baseline.evaluate(self.SNAPSHOT)
        by_key = {c["key"]: c for c in report["checks"]}

        assert by_key["ssh_root_login"]["status"] == "fail"  # PermitRootLogin yes
        assert by_key["ssh_password_auth"]["status"] == "warn"
        assert by_key["pwd_max_days"]["status"] == "fail"  # 99999
        assert by_key["pwd_min_len"]["status"] == "pass"  # 8
        assert by_key["firewall_active"]["status"] == "fail"
        assert by_key["accounts_empty_password"]["status"] == "pass"
        assert by_key["sysctl_dmesg_restrict"]["status"] == "pass"

        assert report["elevated"] is True
        assert report["privilege"] == "root"
        # 不合格的三项：SSH 允许 root 直登、口令永不过期、没有活动防火墙
        assert report["summary"]["fail"] == 3
        assert 0 <= report["score"] <= 100
        # 分类按固定顺序，且每类只装自己的检查项
        assert [c["key"] for c in report["categories"]] == [
            "ssh",
            "password",
            "firewall",
            "ntp",
            "accounts",
            "kernel",
        ]

    def test_not_elevated_downgrades_firewall_to_unknown(self) -> None:
        snapshot = {**self.SNAPSHOT, "elevated": False, "privilege": "none"}
        by_key = {c["key"]: c for c in baseline.evaluate(snapshot)["checks"]}
        assert by_key["firewall_active"]["status"] == "unknown"

    def test_os_info_is_parsed_from_snapshot(self) -> None:
        info = baseline.os_info(self.SNAPSHOT)
        assert info["distribution"] == "TestOS 1"
        assert info["kernel"] == "6.6.0-test"
        assert info["hostname"] == "web1"

    def test_auto_fixable_excludes_manual_only_items(self) -> None:
        report = baseline.evaluate(self.SNAPSHOT)
        assert report["summary"]["fixable"] > report["summary"]["auto_fixable"]
        ssh_password = next(
            c for c in report["checks"] if c["key"] == "ssh_password_auth"
        )
        assert ssh_password["fixable"] is True
        assert ssh_password["auto"] is False

    def test_real_collect_smoke(self) -> None:
        """真跑一遍本机体检（只读），保证在任意主机上都不会抛异常。"""
        report = baseline._collect_sync()
        assert report["checks"], "至少应产出若干检查项"
        assert report["host_id"] == "local"
        assert report["ok"] is True
        assert 0 <= report["score"] <= 100
        assert all(
            c["status"] in ("pass", "warn", "fail", "unknown") for c in report["checks"]
        )


# ------------------------------------------- 主机记录：采集要全量、出接口要脱敏
class TestHostRowShaping:
    """锁一个真实踩过的坑。

    ``managed_hosts()`` 一度被写成「顺手做一层展示用映射」，只留 id/name/host，
    把 ``secret`` / ``auth_type`` / ``use_sudo`` 全丢了 —— 而采集流程正是拿它的
    返回值去连主机，于是 paramiko 报 ``No authentication methods available``，
    远程主机永远巡检失败（界面表现：怎么点都停在「未巡检」）。

    所以这里双向钉死：采集路径必须拿到凭据，出接口的 ``targets()`` 必须一个
    凭据字段都不带。
    """

    FULL_ROW = {
        "id": "h1",
        "name": "web1",
        "host": "10.0.0.9",
        "port": 22,
        "username": "root",
        "auth_type": "password",
        "secret": "enc:v1:abcdef",
        "use_sudo": 1,
        "log_source": "auto",
        "enabled": 1,
        "known_host": "SHA256:xxx",
        "updated": 0,
        "updated_by": "",
    }

    def _stub_hosts(self, monkeypatch) -> None:
        async def _fake(include_disabled: bool = True) -> List[Dict[str, Any]]:
            return [dict(self.FULL_ROW)]

        monkeypatch.setattr(sshremote, "list_hosts", _fake)

    def test_managed_hosts_keeps_credentials(self, monkeypatch) -> None:
        self._stub_hosts(monkeypatch)
        rows = asyncio.run(baseline.managed_hosts())
        assert len(rows) == 1
        # 采集要靠这些字段才连得上主机
        assert rows[0]["secret"] == "enc:v1:abcdef"
        assert rows[0]["auth_type"] == "password"
        assert rows[0]["use_sudo"] == 1

    def test_host_card_strips_every_credential(self) -> None:
        card = baseline.host_card(self.FULL_ROW)
        for leaked in ("secret", "auth_type", "use_sudo", "known_host", "username"):
            assert leaked not in card
        assert card["id"] == "h1"
        assert card["address"] == "10.0.0.9"

    def test_targets_never_leaks_credentials(self, monkeypatch) -> None:
        self._stub_hosts(monkeypatch)
        hosts = asyncio.run(baseline.targets())
        assert hosts[0]["id"] == "local"
        assert hosts[1]["id"] == "h1"
        for host in hosts:
            assert "secret" not in host
            assert "auth_type" not in host
            assert "use_sudo" not in host

    def test_remote_reports_never_leak_credentials(self, monkeypatch) -> None:
        """报告也是出接口的东西，别顺手把整行 spread 进去。"""

        async def _fake_run(row: Dict[str, Any], command: str, timeout: float = 30.0):
            return True, "##baseline:uid##\n1000\n##baseline:end##\n"

        self._stub_hosts(monkeypatch)
        monkeypatch.setattr(sshremote, "run_command", _fake_run)
        rows = asyncio.run(baseline.managed_hosts())
        report = asyncio.run(baseline.collect_remote(rows[0]))
        assert "secret" not in report
        assert report["ok"] is True
        assert report["summary"]["total"] > 0


# --------------------------------------------------------- 远程采集与解析
class TestRemoteProbe:
    def test_parse_probe_sections(self) -> None:
        output = (
            "##baseline:uid##\n0\n"
            "##baseline:hostname##\nweb1\n"
            "##baseline:end##\n"
        )
        sections = baseline.parse_probe_sections(output)
        assert sections["uid"] == "0"
        assert sections["hostname"] == "web1"

    def test_probe_command_covers_every_section(self) -> None:
        command = baseline.probe_command("")
        for name in (
            "uid", "sshd-t", "login-defs", "pam", "shadow", "passwd", "sysctl",
            "fw-units", "fw-ufw", "fw-cmd", "fw-nft", "fw-ipt", "ntp-td",
            "ntp-units", "hostname", "kernel", "os-release", "end",
        ):
            assert f"##baseline:{name}##" in command

    def test_probe_command_applies_sudo_prefix(self) -> None:
        assert "sudo -n sshd -T" in baseline.probe_command("sudo -n ")
        assert "sudo" not in baseline.probe_command("")

    def test_sysctl_probe_maps_paths_back_to_names(self) -> None:
        paths = baseline.sysctl_paths()
        text = "\n".join(f"{path}={index}" for index, path in enumerate(paths))
        values = baseline._parse_sysctl_probe(text)
        assert len(values) == len(paths)
        assert all(value is not None for value in values.values())

    def test_sysctl_probe_tolerates_missing_values(self) -> None:
        values = baseline._parse_sysctl_probe("垃圾数据")
        assert all(value is None for value in values.values())

    def test_firewall_probe_prefers_active_unit(self) -> None:
        sections = {"fw-units": "inactive\nactive\ninactive\ninactive"}
        status = baseline.parse_firewall_probe(sections, True)
        assert status["active"] is True
        assert status["manager"] == "ufw"

    def test_firewall_probe_ufw_status_wins_over_units(self) -> None:
        sections = {"fw-units": "inactive\ninactive\ninactive\ninactive",
                    "fw-ufw": "Status: active"}
        assert baseline.parse_firewall_probe(sections, True)["manager"] == "ufw"

    def test_firewall_probe_iptables_default_accept_is_inactive(self) -> None:
        sections = {"fw-ipt": "-P INPUT ACCEPT\n-P FORWARD ACCEPT"}
        status = baseline.parse_firewall_probe(sections, True)
        assert status["active"] is False
        assert status["manager"] == "iptables"

    def test_firewall_probe_iptables_policy_drop_is_active(self) -> None:
        sections = {"fw-ipt": "-P INPUT DROP\n-A INPUT -p tcp --dport 22 -j ACCEPT"}
        assert baseline.parse_firewall_probe(sections, True)["active"] is True

    def test_firewall_probe_priv_only_sources_need_privilege(self) -> None:
        sections = {"fw-nft": "table inet filter {}"}
        assert baseline.parse_firewall_probe(sections, False)["active"] is False
        assert baseline.parse_firewall_probe(sections, True)["active"] is True

    def test_ntp_probe(self) -> None:
        assert baseline._parse_ntp_probe({"ntp-td": "yes"})["synced"] is True
        assert baseline._parse_ntp_probe({"ntp-td": "no"})["synced"] is False
        units = "inactive\ninactive\nactive\ninactive\ninactive"
        assert baseline._parse_ntp_probe({"ntp-units": units})["service"] == (
            "systemd-timesyncd"
        )
        assert baseline._parse_ntp_probe({})["synced"] is False

    def test_remote_snapshot_detects_root(self) -> None:
        output = "\n".join(
            ["##baseline:uid##", "0", "##baseline:shadow##", "root:$6$x:1:0:99999:7:::", "##baseline:end##"]
        )
        snapshot = baseline.remote_snapshot({"use_sudo": False}, output)
        assert snapshot["privilege"] == "root"
        assert snapshot["elevated"] is True

    def test_remote_snapshot_detects_sudo_by_readable_shadow(self) -> None:
        output = "\n".join(
            ["##baseline:uid##", "1000", "##baseline:shadow##", "root:$6$x:1:0:99999:7:::"]
        )
        snapshot = baseline.remote_snapshot({"use_sudo": True}, output)
        assert snapshot["privilege"] == "sudo"
        assert snapshot["elevated"] is True

    def test_remote_snapshot_without_privilege(self) -> None:
        output = "##baseline:uid##\n1000\n##baseline:shadow##\n"
        snapshot = baseline.remote_snapshot({"use_sudo": False}, output)
        assert snapshot["privilege"] == "none"
        assert snapshot["elevated"] is False

    def test_remote_snapshot_parses_ssh_from_probe(self) -> None:
        output = "\n".join(
            [
                "##baseline:sshd-t##", "permitrootlogin no", "maxauthtries 4",
                "##baseline:end##",
            ]
        )
        snapshot = baseline.remote_snapshot({"use_sudo": True}, output)
        assert snapshot["ssh"]["effective"]["permitrootlogin"] == "no"
        assert "sshd -T" in snapshot["ssh"]["source"]


# ------------------------------------------------------- 「别把登录关死」守卫
class TestRemoteSshGuard:
    def test_password_auth_blocks_disabling_password_login(self) -> None:
        row = {"auth_type": "password", "username": "ops"}
        with pytest.raises(baseline.FixError) as exc:
            asyncio.run(baseline._remote_sshd_guard(row, "ssh_password_auth"))
        assert "密钥" in str(exc.value)

    def test_root_password_blocks_disabling_root_login(self) -> None:
        row = {"auth_type": "password", "username": "root"}
        with pytest.raises(baseline.FixError) as exc:
            asyncio.run(baseline._remote_sshd_guard(row, "ssh_root_login"))
        assert "root" in str(exc.value)

    def test_non_root_password_can_disable_root_login(self) -> None:
        row = {"auth_type": "password", "username": "ops"}
        asyncio.run(baseline._remote_sshd_guard(row, "ssh_root_login"))  # 不抛

    def test_key_auth_is_never_blocked(self) -> None:
        row = {"auth_type": "key", "username": "root"}
        asyncio.run(baseline._remote_sshd_guard(row, "ssh_root_login"))
        asyncio.run(baseline._remote_sshd_guard(row, "ssh_password_auth"))


# ------------------------------------------------------------- 总览与排序
class TestFleet:
    def test_compact_report_puts_worst_issues_first(self) -> None:
        checks = [
            _mk_check("warn", "low", key="low-warn"),
            _mk_check("fail", "high", key="high-fail"),
            _mk_check("warn", "high", key="high-warn"),
            _mk_check("pass", "high", key="ok"),
        ]
        compact = baseline.compact_report(_raw_report("web1", checks))
        assert [i["key"] for i in compact["issues"]] == [
            "high-fail",
            "high-warn",
            "low-warn",
        ]
        assert compact["summary"]["fail"] == 1

    def test_overview_sorts_by_attention(self, monkeypatch) -> None:
        reports = [
            _raw_report("healthy", [_mk_check("pass", "high")]),
            _raw_report("broken", [_mk_check("fail", "high")]),
            _raw_report("unreachable", [], ok=False, error="连不上"),
            _raw_report("warned", [_mk_check("warn", "medium")]),
        ]

        async def _fake(host_ids=None):
            return reports

        monkeypatch.setattr(baseline, "fleet_reports", _fake)
        data = asyncio.run(baseline.fleet_overview())

        assert [h["host_id"] for h in data["hosts"]] == [
            "broken",       # 有不合格：最需要处理
            "unreachable",  # 不可达：连接要修
            "warned",
            "healthy",
        ]
        assert data["totals"]["hosts"] == 4
        assert data["totals"]["reachable"] == 3
        assert data["totals"]["unreachable"] == 1
        assert data["totals"]["fail"] == 1
        assert data["totals"]["warn"] == 1

    def test_unreachable_host_keeps_error_and_zero_score(self) -> None:
        compact = baseline.compact_report(
            _raw_report("web9", [], ok=False, error="SSH 连接失败")
        )
        assert compact["ok"] is False
        assert compact["error"] == "SSH 连接失败"
        assert compact["grade_label"] == "未体检"


# ------------------------------------------------------------------- 加固
class TestFixes:
    def test_registry_covers_sysctl_and_ssh(self) -> None:
        keys = set(baseline.fixable_keys())
        for required in (
            "ssh_root_login",
            "ssh_password_auth",
            "pwd_max_days",
            "time_sync",
            "accounts_empty_password",
            "sysctl_tcp_syncookies",
        ):
            assert required in keys

    def test_apply_sysctl_writes_and_verifies(self, tmp_path, monkeypatch) -> None:
        target = tmp_path / "99-panel-baseline.conf"
        monkeypatch.setattr(baseline, "SYSCTL_FILE", str(target))
        monkeypatch.setattr(baseline, "_require_root", lambda action: None)
        monkeypatch.setattr(
            baseline, "_which", lambda name: "/sbin/sysctl" if name == "sysctl" else ""
        )
        monkeypatch.setattr(baseline, "_run", lambda cmd, timeout=8: (True, "applied"))
        monkeypatch.setattr(baseline, "read_sysctl", lambda name: "1")

        result = baseline.apply_sysctl({"net.ipv4.tcp_syncookies": "1"})

        assert result["ok"] is True
        assert "net.ipv4.tcp_syncookies = 1" in target.read_text(encoding="utf-8")

    def test_apply_sysctl_detects_no_effect(self, tmp_path, monkeypatch) -> None:
        target = tmp_path / "99-panel-baseline.conf"
        monkeypatch.setattr(baseline, "SYSCTL_FILE", str(target))
        monkeypatch.setattr(baseline, "_require_root", lambda action: None)
        monkeypatch.setattr(baseline, "_which", lambda name: "")
        monkeypatch.setattr(baseline, "read_sysctl", lambda name: "0")  # 未生效

        with pytest.raises(baseline.FixError):
            baseline.apply_sysctl({"net.ipv4.tcp_syncookies": "1"})

    def test_sshd_fix_happy_path(self, tmp_path, monkeypatch) -> None:
        target = tmp_path / "99-panel-baseline.conf"
        monkeypatch.setattr(baseline, "SSHD_DROPIN", str(target))
        monkeypatch.setattr(baseline, "_require_root", lambda action: None)
        monkeypatch.setattr(baseline, "_sshd_binary", lambda: "/usr/sbin/sshd")
        monkeypatch.setattr(baseline, "_run", lambda cmd, timeout=8: (True, ""))
        monkeypatch.setattr(
            baseline,
            "sshd_settings",
            lambda: ({"permitrootlogin": "prohibit-password"}, "stub"),
        )
        monkeypatch.setattr(baseline, "_reload_ssh", lambda: "systemctl reload sshd")

        result = baseline.apply_sshd_settings({"PermitRootLogin": "prohibit-password"})

        assert result["ok"] is True
        assert "PermitRootLogin prohibit-password" in target.read_text(encoding="utf-8")

    def test_sshd_fix_rolls_back_on_bad_syntax(self, tmp_path, monkeypatch) -> None:
        target = tmp_path / "99-panel-baseline.conf"
        monkeypatch.setattr(baseline, "SSHD_DROPIN", str(target))
        monkeypatch.setattr(baseline, "_require_root", lambda action: None)
        monkeypatch.setattr(baseline, "_sshd_binary", lambda: "/usr/sbin/sshd")
        monkeypatch.setattr(
            baseline, "_run", lambda cmd, timeout=8: (False, "Bad configuration option")
        )

        with pytest.raises(baseline.FixError) as exc:
            baseline.apply_sshd_settings({"PermitRootLogin": "prohibit-password"})

        assert "回滚" in str(exc.value)
        assert not target.exists()  # 回滚后不留半成品

    def test_sshd_fix_rolls_back_when_include_missing(self, tmp_path, monkeypatch) -> None:
        target = tmp_path / "99-panel-baseline.conf"
        monkeypatch.setattr(baseline, "SSHD_DROPIN", str(target))
        monkeypatch.setattr(baseline, "_require_root", lambda action: None)
        monkeypatch.setattr(baseline, "_sshd_binary", lambda: "/usr/sbin/sshd")
        monkeypatch.setattr(baseline, "_run", lambda cmd, timeout=8: (True, ""))
        # sshd -T 读回时没有我们写的键 → drop-in 未被主配置 Include
        monkeypatch.setattr(baseline, "sshd_settings", lambda: ({}, "stub"))

        with pytest.raises(baseline.FixError) as exc:
            baseline.apply_sshd_settings({"PermitRootLogin": "prohibit-password"})

        assert "Include" in str(exc.value)
        assert not target.exists()

    def test_apply_fix_rejects_unknown_key(self) -> None:
        with pytest.raises(baseline.FixError):
            asyncio.run(baseline.apply_fix("not-a-real-check"))

    def test_apply_fixes_reports_per_item(self, monkeypatch) -> None:
        async def _apply(key: str, host_id: str = "local") -> Dict[str, Any]:
            if key == "bad":
                raise baseline.FixError("boom")
            return {"ok": True, "detail": "ok-" + key}

        monkeypatch.setattr(baseline, "apply_fix", _apply)

        result = asyncio.run(baseline.apply_fixes(["good", "bad"]))

        assert result["fixed"] == 1
        assert result["failed"] == 1
        by_key = {item["key"]: item for item in result["applied"]}
        assert by_key["good"]["ok"] is True
        assert by_key["bad"]["ok"] is False
        assert "boom" in by_key["bad"]["error"]


# ------------------------------------------------------------------- 接口
def _stub_report(host_id: str = "local") -> Dict[str, Any]:
    check = _mk_check("pass", "high", key="firewall_active", category="firewall")
    report = _raw_report(host_id, [check])
    report["checked_at"] = 1_790_000_000
    report["os"] = {"system": "Linux", "distribution": "TestOS", "kernel": "6.6.0"}
    return report


class TestApi:
    def test_report_requires_auth(self, api) -> None:
        assert api.get("/api/baseline/report").status_code == 401

    def test_report_ok_and_audited(self, api, monkeypatch) -> None:
        async def _fake() -> Dict[str, Any]:
            return _stub_report()

        monkeypatch.setattr(baseline, "collect", _fake)
        resp = api.get("/api/baseline/report", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["host_id"] == "local"
        assert "baseline.read" in _audit_actions()

    def test_targets_lists_local_host(self, api) -> None:
        resp = api.get("/api/baseline/targets", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        hosts = resp.json()["hosts"]
        assert hosts and hosts[0]["id"] == "local"
        assert hosts[0]["local"] is True

    def test_host_detail_for_local(self, api, monkeypatch) -> None:
        async def _fake(host_id: str) -> Dict[str, Any]:
            return _stub_report(host_id)

        monkeypatch.setattr(baseline, "collect_host", _fake)
        resp = api.get("/api/baseline/hosts/local", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["host_id"] == "local"

    def test_unknown_host_is_404(self, api) -> None:
        resp = api.get("/api/baseline/hosts/no-such-host", headers=auth_headers(api))
        assert resp.status_code == 404

    def test_fleet_overview_is_audited(self, api, monkeypatch) -> None:
        async def _fake(host_ids=None) -> Dict[str, Any]:
            return {
                "hosts": [],
                "totals": {
                    "hosts": 1, "reachable": 1, "unreachable": 0,
                    "fail": 0, "warn": 0, "fixable": 0,
                    "avg_score": 90, "worst_score": 90, "healthy": 1,
                },
                "generated_at": 1_790_000_000,
            }

        monkeypatch.setattr(baseline, "fleet_overview", _fake)
        resp = api.get("/api/baseline/fleet", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["totals"]["hosts"] == 1
        assert "baseline.fleet_read" in _audit_actions()

    def test_fix_passes_host_id(self, api, monkeypatch) -> None:
        seen: Dict[str, Any] = {}

        async def _fake(key: str, host_id: str = "local") -> Dict[str, Any]:
            seen["key"] = key
            seen["host_id"] = host_id
            return {"ok": True, "detail": "stub", "path": "/tmp/x"}

        monkeypatch.setattr(baseline, "apply_fix", _fake)
        resp = api.post(
            "/api/baseline/fix",
            headers=auth_headers(api),
            json={"key": "time_sync", "host_id": "remote-1"},
        )
        assert resp.status_code == 200, resp.text
        assert seen == {"key": "time_sync", "host_id": "remote-1"}
        assert resp.json()["host_id"] == "remote-1"
        assert "baseline.fix" in _audit_actions()

    def test_fix_error_maps_to_400(self, api, monkeypatch) -> None:
        async def _boom(key: str, host_id: str = "local") -> Dict[str, Any]:
            raise baseline.FixError("需要 root 权限")

        monkeypatch.setattr(baseline, "apply_fix", _boom)
        resp = api.post(
            "/api/baseline/fix",
            headers=auth_headers(api),
            json={"key": "time_sync"},
        )
        assert resp.status_code == 400
        assert "root" in resp.json()["detail"]

    def test_fix_all_empty_keys_means_auto(self, api, monkeypatch) -> None:
        called: Dict[str, Any] = {}

        async def _fake(keys=None, host_id: str = "local") -> Dict[str, Any]:
            called["keys"] = keys
            called["host_id"] = host_id
            return {"applied": [], "fixed": 0, "failed": 0}

        monkeypatch.setattr(baseline, "apply_fixes", _fake)
        resp = api.post(
            "/api/baseline/fix-all",
            headers=auth_headers(api),
            json={"host_id": "remote-1"},
        )
        assert resp.status_code == 200, resp.text
        assert called == {"keys": None, "host_id": "remote-1"}
        assert "baseline.fix_all" in _audit_actions()

    def test_viewer_can_view_but_not_fix(self, api, monkeypatch) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            headers=admin,
            json={"username": "baviewer", "password": STRONG, "role": "viewer"},
        )
        login = api.post(
            "/api/auth/login", json={"username": "baviewer", "password": STRONG}
        )
        assert login.status_code == 200, login.text
        viewer = {"Authorization": f"Bearer {login.json()['access_token']}"}

        async def _fake() -> Dict[str, Any]:
            return _stub_report()

        monkeypatch.setattr(baseline, "collect", _fake)
        report_resp = api.get("/api/baseline/report", headers=viewer)
        assert report_resp.status_code == 200, report_resp.text
        assert (
            api.post(
                "/api/baseline/fix", headers=viewer, json={"key": "time_sync"}
            ).status_code
            == 403
        )
