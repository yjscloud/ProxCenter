"""多机 SSH 安全：主机 CRUD、远程命令构造、回传解析与多机聚合。

不连真机器：把 ``sshremote.run_command`` 换成桩，直接验证「发的是什么命令、
回来的东西怎么解析」。真 SSH 只差一个 paramiko 连接，逻辑都被这里覆盖。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import types
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import guestip, pve, reportcache, sshguard, sshremote, store  # noqa: E402
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: E402,F401

NOW = time.time()


def run(coro):
    """项目没装 pytest-asyncio，这里显式跑一次事件循环。"""
    return asyncio.run(coro)


def line_iso(ts: float, message: str, pid: int = 1000) -> str:
    stamp = datetime.fromtimestamp(ts).astimezone().isoformat()
    return f"{stamp} pve-node sshd[{pid}]: {message}"


@pytest.fixture()
def no_db(monkeypatch):
    """这些用例不需要库：policy 直接给默认值。

    关键：TestCase 的数据库连接池绑在 TestClient 那个事件循环上，而这里用
    ``asyncio.run`` 另起一个循环，再去碰连接池就会报 "Event loop is closed"。
    """
    async def fake_policy() -> Dict[str, Any]:
        return dict(sshguard.DEFAULT_POLICY)

    monkeypatch.setattr(sshguard, "load_policy", fake_policy)


@pytest.fixture()
def stub_remote(monkeypatch):
    """把远程执行换成可控的桩：记录命令、返回预设输出。"""
    calls: List[str] = []
    outputs: Dict[str, str] = {"*": ""}

    async def fake_run(row: Dict[str, Any], command: str, timeout: float = 15.0):
        calls.append(command)
        for key, value in outputs.items():
            if key != "*" and key in command:
                return True, value
        return True, outputs["*"]

    monkeypatch.setattr(sshremote, "run_command", fake_run)
    return {"calls": calls, "outputs": outputs}


# ------------------------------------------------------------------- 主机模型
class TestHostModel:
    def test_requires_host(self) -> None:
        with pytest.raises(ValueError):
            sshremote.normalise_host({"host": ""})

    def test_rejects_shell_metacharacters(self) -> None:
        with pytest.raises(ValueError):
            sshremote.normalise_host({"host": "1.2.3.4; rm -rf /"})

    def test_port_and_enum_normalised(self) -> None:
        row = sshremote.normalise_host(
            {"host": "10.0.0.5", "port": 2222, "auth_type": "password", "log_source": "secure"}
        )
        assert row["port"] == 2222
        assert row["auth_type"] == "password"
        assert row["log_source"] == "secure"

    def test_empty_secret_keeps_old_value(self) -> None:
        first = sshremote.normalise_host({"host": "10.0.0.6", "secret": "key-a"})
        second = sshremote.normalise_host({"host": "10.0.0.6", "secret": ""}, first)
        assert second["secret"] == first["secret"]

    def test_secret_is_encrypted_at_rest(self) -> None:
        row = sshremote.normalise_host({"host": "10.0.0.7", "secret": "super-secret"})
        assert "super-secret" not in row["secret"]
        assert sshremote.decrypt_secret(row) == "super-secret"

    def test_public_view_never_leaks_secret(self) -> None:
        row = sshremote.normalise_host({"host": "10.0.0.8", "secret": "abc"})
        public = sshremote.public_host(row)
        assert "abc" not in str(public)
        assert public["secret_set"] is True


class TestCommands:
    @pytest.mark.parametrize(
        "log_source,expected",
        [
            ("auto", "journalctl -u ssh -u sshd"),
            ("journalctl", "journalctl -u ssh -u sshd"),
            ("secure", "/var/log/secure"),
            ("auth.log", "/var/log/auth.log"),
        ],
    )
    def test_log_command_per_source(self, log_source: str, expected: str) -> None:
        row = {"log_source": log_source, "use_sudo": 0}
        assert expected in sshremote.log_command(row, NOW - 3600)

    def test_sudo_prefix_when_needed(self) -> None:
        row = {"log_source": "journalctl", "use_sudo": 1}
        assert sshremote.log_command(row, NOW - 3600).startswith("sudo -n ")
        assert sshremote._fail2ban_cmd({"use_sudo": 1}, "status") == "sudo -n fail2ban-client status"
        assert sshremote._fail2ban_cmd({"use_sudo": 0}, "status") == "fail2ban-client status"


# ------------------------------------------------------------------- 远程采集
class TestRemoteReport:
    def _host(self, **kwargs: Any) -> Dict[str, Any]:
        row = sshremote.normalise_host(
            {
                "host": "10.0.0.9",
                "name": "pve-1",
                "username": "root",
                "secret": "key",
                **kwargs,
            }
        )
        return row

    def test_parses_remote_log_like_local(self, no_db) -> None:
        """远程日志与本机走同一套解析：pam + Failed password 去重、噪声不算。"""
        output = "\n".join(
            [
                line_iso(NOW - 60, "Failed password for root from 1.2.3.4 port 22 ssh2", 1),
                line_iso(NOW - 50, "Failed password for admin from 1.2.3.4 port 23 ssh2", 2),
                line_iso(NOW - 40, "Connection closed by 5.5.5.5 port 5000 [preauth]", 3),
                line_iso(NOW - 30, "Accepted password for root from 10.9.9.9 port 24 ssh2", 4),
            ]
        )

        async def fake(row, command, timeout=15.0):
            return True, output

        original = sshremote.run_command
        sshremote.run_command = fake
        try:
            report = run(sshremote.remote_report(self._host(), hours=24))
        finally:
            sshremote.run_command = original

        assert report["ok"] is True
        assert report["name"] == "pve-1"
        assert report["summary"]["failures"] == 2  # 噪声行不算
        assert report["summary"]["distinct_ips"] == 1
        assert report["summary"]["logins"] == 1
        assert report["top_ips"][0]["ip"] == "1.2.3.4"
        assert report["source"]["host"] == "pve-1"

    def test_failure_is_reported_not_swallowed(self, no_db) -> None:
        async def fake(row, command, timeout=15.0):
            return False, "Permission denied (publickey)."

        original = sshremote.run_command
        sshremote.run_command = fake
        try:
            report = run(sshremote.remote_report(self._host(), hours=24))
        finally:
            sshremote.run_command = original
        assert report["ok"] is False
        assert "Permission denied" in report["error"]
        assert report["source"]["available"] is False


class TestRemoteFail2ban:
    def test_status_parses_jails(self, no_db) -> None:
        async def fake(row, command, timeout=15.0):
            if command.endswith("status"):
                return True, "Status\n|- Jail list:\tsshd, nginx-http-auth"
            if command.endswith("status sshd"):
                return True, (
                    "Status for the jail: sshd\n|- Currently banned:\t2\n"
                    "`- Banned IP list:\t1.2.3.4 5.6.7.8\n"
                )
            return True, ""

        row = sshremote.normalise_host({"host": "10.0.0.10", "name": "pve-2"})
        original = sshremote.run_command
        sshremote.run_command = fake
        try:
            status = run(sshremote.remote_fail2ban_status(row))
        finally:
            sshremote.run_command = original
        assert status["installed"] is True
        assert status["jails"] == ["sshd", "nginx-http-auth"]
        assert status["preferred"] == "sshd"
        assert status["details"][0]["banned_ips"] == ["1.2.3.4", "5.6.7.8"]

    def test_ban_command_shape_and_validation(self) -> None:
        calls: List[str] = []

        async def fake(row, command, timeout=15.0):
            calls.append(command)
            return True, "1"

        row = sshremote.normalise_host({"host": "10.0.0.11", "use_sudo": True, "secret": "k"})
        original = sshremote.run_command
        sshremote.run_command = fake
        try:
            run(sshremote.remote_fail2ban_action(row, "ban", "sshd", "1.2.3.4"))
            run(sshremote.remote_fail2ban_action(row, "unban", "sshd", "1.2.3.4"))
            with pytest.raises(ValueError):
                run(sshremote.remote_fail2ban_action(row, "ban", "sshd;rm", "1.2.3.4"))
            with pytest.raises(ValueError):
                run(sshremote.remote_fail2ban_action(row, "ban", "sshd", "1.2.3.4; id"))
        finally:
            sshremote.run_command = original
        assert calls[0] == "sudo -n fail2ban-client set sshd banip 1.2.3.4"
        assert calls[1] == "sudo -n fail2ban-client set sshd unbanip 1.2.3.4"
        assert len(calls) == 2  # 非法输入根本没发出去

    def test_runtime_error_surfaces_output(self) -> None:
        async def fake(row, command, timeout=15.0):
            return False, "Failed to access socket path"

        row = sshremote.normalise_host({"host": "10.0.0.12"})
        original = sshremote.run_command
        sshremote.run_command = fake
        try:
            with pytest.raises(RuntimeError):
                run(sshremote.remote_fail2ban_action(row, "reload"))
        finally:
            sshremote.run_command = original


# ------------------------------------------------------------------- 接口
class TestFleetApi:
    def _create_host(self, client, headers, **overrides) -> Dict[str, Any]:
        payload = {
            "name": "pve-1",
            "host": "10.0.0.20",
            "port": 22,
            "username": "root",
            "auth_type": "key",
            "secret": "-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----",
            "use_sudo": False,
            "log_source": "auto",
            "enabled": True,
        }
        payload.update(overrides)
        resp = client.post("/api/ssh/hosts", headers=headers, json=payload)
        assert resp.status_code == 200, resp.text
        return resp.json()["host"]

    def test_host_crud_and_secret_masking(self, api) -> None:
        headers = auth_headers(api)
        host = self._create_host(api, headers)
        assert host["secret_set"] is True
        assert "secret" not in host

        listed = api.get("/api/ssh/hosts", headers=headers).json()
        assert any(item["id"] == host["id"] for item in listed)
        assert all("secret" not in item for item in listed)

        updated = api.put(
            f"/api/ssh/hosts/{host['id']}",
            headers=headers,
            json={"name": "pve-1-new", "host": host["host"], "secret": ""},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["host"]["name"] == "pve-1-new"
        # 留空 = 沿用旧凭据
        assert updated.json()["host"]["secret_set"] is True

        assert api.delete(f"/api/ssh/hosts/{host['id']}", headers=headers).status_code == 200
        assert not any(item["id"] == host["id"] for item in api.get("/api/ssh/hosts", headers=headers).json())

    def test_invalid_host_rejected(self, api) -> None:
        headers = auth_headers(api)
        bad = api.post(
            "/api/ssh/hosts",
            headers=headers,
            json={"host": "10.0.0.21; rm -rf /", "username": "root", "secret": "x"},
        )
        assert bad.status_code == 400
        assert "不合法" in bad.json()["detail"]

    def test_viewer_cannot_manage_hosts(self, api) -> None:
        # 受管主机列表属于主机级数据，默认只给管理员；用自定义角色授予「读」
        viewer = user_with_permissions(api, ["ssh.view"], "sshview2")
        assert api.get("/api/ssh/hosts", headers=viewer).status_code == 200
        assert (
            api.post(
                "/api/ssh/hosts",
                headers=viewer,
                json={"host": "10.0.0.22", "username": "root", "secret": "x"},
            ).status_code
            == 403
        )

    def test_fleet_overview_includes_local_and_remote(self, api, stub_remote) -> None:
        """汇总里有本机，也有受管主机；远程失败会单独标出来而不是整页 500。"""
        headers = auth_headers(api)
        self._create_host(api, headers, name="pve-x", host="10.0.0.23")
        stub_remote["outputs"]["journalctl"] = "\n".join(
            [
                line_iso(NOW - 30, "Failed password for root from 9.9.9.9 port 22 ssh2", 1),
                line_iso(NOW - 20, "Failed password for root from 9.9.9.9 port 23 ssh2", 2),
            ]
        )
        overview = api.get("/api/ssh/fleet", headers=headers)
        assert overview.status_code == 200, overview.text
        data = overview.json()
        ids = {item["id"] for item in data["hosts"]}
        assert "local" in ids
        assert len(ids) == 2  # 本机 + 这台
        remote = next(item for item in data["hosts"] if item["id"] != "local")
        assert remote["ok"] is True
        assert remote["summary"]["failures"] == 2
        assert remote["top_ips"][0]["ip"] == "9.9.9.9"
        assert data["totals"]["hosts"] == 2

    def test_fleet_failures_endpoint(self, api, stub_remote) -> None:
        headers = auth_headers(api)
        host = self._create_host(api, headers, name="pve-y", host="10.0.0.24")
        stub_remote["outputs"]["journalctl"] = line_iso(
            NOW - 30, "Failed password for root from 8.8.8.8 port 22 ssh2", 1
        )
        resp = api.get(f"/api/ssh/fleet/{host['id']}/failures?hours=24", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["failures"][0]["ip"] == "8.8.8.8"

        assert api.get("/api/ssh/fleet/nope/failures", headers=headers).status_code == 404

    def test_fleet_ban_uses_remote_command(self, api, stub_remote) -> None:
        headers = auth_headers(api)
        host = self._create_host(api, headers, name="pve-z", host="10.0.0.25")
        stub_remote["outputs"]["fail2ban-client status"] = "Status\n|- Jail list:\tsshd"
        resp = api.post(
            f"/api/ssh/fleet/{host['id']}/fail2ban/ban",
            headers=headers,
            json={"jail": "sshd", "ip": "1.2.3.4"},
        )
        assert resp.status_code == 200, resp.text
        assert "fail2ban-client set sshd banip 1.2.3.4" in stub_remote["calls"]


# ------------------------------------------------------------------- 指纹采集
class TestFingerprintCapture:
    """指纹必须能从连接本身取到。

    曾经的 bug：只依赖 paramiko 的 ``MissingHostKeyPolicy`` 回调取指纹。paramiko
    只在「主机密钥不在已知列表里」时才回调它 —— 目标主机只要出现在面板本机的
    ``~/.ssh/known_hosts`` 里，回调就不会触发、指纹是空串，于是「确认并信任」会
    返回成功却把空指纹存进库，界面上的「未确认」永远消不掉（表现为点了没反应）。
    """

    class _Transport:
        def __init__(self, key: Any) -> None:
            self._key = key

        def get_remote_server_key(self) -> Any:
            return self._key

    class _Client:
        def __init__(self, transport: Any) -> None:
            self._transport = transport

        def get_transport(self) -> Any:
            return self._transport

        def close(self) -> None:
            pass

    def test_fingerprint_comes_from_transport(self) -> None:
        key = types.SimpleNamespace(asbytes=lambda: b"host-key-bytes")
        fingerprint = sshremote.server_key_fingerprint(
            self._Client(self._Transport(key))
        )
        assert fingerprint.startswith("SHA256:")
        assert fingerprint == sshremote._fingerprint(key)

    def test_no_transport_returns_empty(self) -> None:
        assert sshremote.server_key_fingerprint(self._Client(None)) == ""

    def test_broken_client_does_not_raise(self) -> None:
        class _Broken:
            def get_transport(self) -> Any:
                raise RuntimeError("transport 已经关了")

        assert sshremote.server_key_fingerprint(_Broken()) == ""

    def test_trust_refuses_to_save_empty_fingerprint(self, monkeypatch) -> None:
        saved: Dict[str, Any] = {}

        def _fake_connect(row: Dict[str, Any], trust_first: bool = False) -> Any:
            return self._Client(None), ""

        async def _fake_save(raw: Dict[str, Any], username: str = "") -> Any:
            saved.update(raw)
            return raw

        monkeypatch.setattr(sshremote, "_connect", _fake_connect)
        monkeypatch.setattr(sshremote, "save_host", _fake_save)

        result = run(sshremote.trust_fingerprint({"id": "h1", "host": "10.0.0.9"}))

        assert result["ok"] is False
        assert "指纹" in result["detail"]
        # 关键：不能「报成功但什么都没写进去」
        assert saved == {}

    def test_trust_saves_the_real_fingerprint(self, monkeypatch) -> None:
        saved: Dict[str, Any] = {}

        def _fake_connect(row: Dict[str, Any], trust_first: bool = False) -> Any:
            return self._Client(None), "SHA256:abcdef"

        async def _fake_save(raw: Dict[str, Any], username: str = "") -> Any:
            saved.update(raw)
            return raw

        monkeypatch.setattr(sshremote, "_connect", _fake_connect)
        monkeypatch.setattr(sshremote, "save_host", _fake_save)

        result = run(sshremote.trust_fingerprint({"id": "h1", "host": "10.0.0.9"}))

        assert result["ok"] is True
        assert result["fingerprint"] == "SHA256:abcdef"
        assert saved["known_host"] == "SHA256:abcdef"


# --------------------------------------------- 移除主机：连带清掉四套安全数据
class TestManagedHostPurge:
    """虚拟机删除之后（或它在 PVE 上被直接删掉之后），受管主机登记的清理规则。

    用例不碰数据库：``list_hosts`` / ``purge_host`` 换成桩，验证的是「哪些行
    该被清」这个判断 —— 判错了才是真正的风险：漏清理会让界面一直挂着一台
    连不上的机器，误清理会把用户手工添加的主机也一起删掉。
    """

    def _row(self, **kwargs: Any) -> Dict[str, Any]:
        row = {
            "id": "h1",
            "name": "web1（pve/100）",
            "host": "10.0.0.1",
            "origin": sshremote.ORIGIN_PANEL,
            "node": "pve",
            "vmid": 100,
            "conn_id": "c1",
        }
        row.update(kwargs)
        return row

    @pytest.fixture()
    def purged(self, monkeypatch) -> List[str]:
        """把真正的清理换成记录：断言「清了哪几台」即可。"""
        seen: List[str] = []

        async def fake_purge(host_id: str) -> int:
            seen.append(host_id)
            return 1

        monkeypatch.setattr(sshremote, "purge_host", fake_purge)
        return seen

    def _stub_hosts(self, monkeypatch, rows: List[Dict[str, Any]]) -> None:
        async def fake_list(include_disabled: bool = True) -> List[Dict[str, Any]]:
            return rows

        monkeypatch.setattr(sshremote, "list_hosts", fake_list)

    # ---- 匹配规则
    def test_matches_by_vmid_not_by_node(self) -> None:
        assert sshremote._is_vm_host(self._row(), 100, "c1")
        # 迁移之后节点名就过时了：按节点匹配会把迁移过的机器当成「已删除」
        assert sshremote._is_vm_host(self._row(node="pve-2"), 100, "c1")

    def test_ignores_other_vmid_and_other_connection(self) -> None:
        assert not sshremote._is_vm_host(self._row(), 101, "c1")
        assert not sshremote._is_vm_host(self._row(), 100, "c2")

    def test_manual_hosts_are_never_touched(self) -> None:
        """手工添加的主机与虚拟机的生命周期无关。"""
        assert not sshremote._is_vm_host(self._row(origin="manual"), 100, "c1")

    def test_empty_connection_id_on_either_side_still_matches(self) -> None:
        """老数据 / 未指定连接时不能因为连接 id 是空串就把该清的主机漏掉。"""
        assert sshremote._is_vm_host(self._row(conn_id=""), 100, "c1")
        assert sshremote._is_vm_host(self._row(conn_id="c1"), 100, "")

    def test_edit_keeps_the_vm_link(self) -> None:
        """编辑主机（改端口）不能把来源虚拟机弄丢，否则那台机器再也清不掉。"""
        first = sshremote.normalise_host(
            {
                "host": "10.0.0.1",
                "origin": sshremote.ORIGIN_PANEL,
                "node": "pve",
                "vmid": 100,
                "conn_id": "c1",
            }
        )
        second = sshremote.normalise_host({"host": "10.0.0.1", "port": 2222}, first)
        assert (second["node"], second["vmid"], second["conn_id"]) == ("pve", 100, "c1")
        assert sshremote.public_host(second)["vmid"] == 100

    def test_vmid_is_normalised(self) -> None:
        assert sshremote.normalise_host({"host": "10.0.0.1", "vmid": ""})["vmid"] is None
        assert sshremote.normalise_host({"host": "10.0.0.1", "vmid": "100"})["vmid"] == 100

    # ---- 删机器时清理
    def test_purge_vm_hosts_only_drops_that_vm(self, monkeypatch, purged) -> None:
        self._stub_hosts(
            monkeypatch,
            [
                self._row(),
                self._row(id="h2", vmid=101),
                self._row(id="h3", origin="manual"),
                self._row(id="h4", conn_id="c2"),
            ],
        )
        assert run(sshremote.purge_vm_hosts(100, "c1")) == ["h1"]
        assert purged == ["h1"]

    # ---- 周期核对（虚拟机在 PVE 上被直接删掉）
    def test_reconcile_drops_hosts_whose_vm_is_gone(self, monkeypatch, purged) -> None:
        self._stub_hosts(monkeypatch, [self._row(), self._row(id="h2", vmid=101)])

        class FakeClient:
            async def cluster_resources(self, rtype=None):  # noqa: ANN001
                return [{"node": "pve", "vmid": 100}]  # 101 已经不存在了

        monkeypatch.setattr(
            pve, "all_connection_clients", lambda: [({"id": "c1"}, FakeClient())]
        )
        monkeypatch.setattr(store, "get_connections", lambda: [{"id": "c1"}])

        result = run(sshremote.reconcile_panel_hosts())

        assert result["removed"] == 1
        assert purged == ["h2"]

    def test_reconcile_keeps_hosts_when_inventory_unavailable(
        self, monkeypatch, purged
    ) -> None:
        """PVE 读不到清单（挂了 / 网络抖动）时一台都不能删。"""
        self._stub_hosts(monkeypatch, [self._row()])

        class BrokenClient:
            async def cluster_resources(self, rtype=None):  # noqa: ANN001
                raise RuntimeError("PVE 不可达")

        monkeypatch.setattr(
            pve, "all_connection_clients", lambda: [({"id": "c1"}, BrokenClient())]
        )
        monkeypatch.setattr(store, "get_connections", lambda: [{"id": "c1"}])

        assert run(sshremote.reconcile_panel_hosts())["removed"] == 0
        assert purged == []

    def test_reconcile_drops_hosts_of_a_deleted_connection(
        self, monkeypatch, purged
    ) -> None:
        """PVE 连接被删掉后，它名下登记的主机再也连不上，一并清掉。"""
        self._stub_hosts(monkeypatch, [self._row()])
        monkeypatch.setattr(pve, "all_connection_clients", lambda: [])
        monkeypatch.setattr(store, "get_connections", lambda: [{"id": "c2"}])

        result = run(sshremote.reconcile_panel_hosts())

        assert result["removed"] == 1
        assert purged == ["h1"]

    def test_reconcile_without_any_connection_touches_nothing(
        self, monkeypatch, purged
    ) -> None:
        self._stub_hosts(monkeypatch, [self._row()])
        monkeypatch.setattr(pve, "all_connection_clients", lambda: [])
        monkeypatch.setattr(store, "get_connections", lambda: [])

        assert run(sshremote.reconcile_panel_hosts())["removed"] == 0
        assert purged == []

    def test_reconcile_skips_hosts_without_a_connection_id(
        self, monkeypatch, purged
    ) -> None:
        """没记连接 id 的老数据不猜：宁可留着，也不要凭 VMID 猜错集群。"""
        self._stub_hosts(monkeypatch, [self._row(conn_id="")])
        monkeypatch.setattr(pve, "all_connection_clients", lambda: [])
        monkeypatch.setattr(store, "get_connections", lambda: [{"id": "c1"}])

        assert run(sshremote.reconcile_panel_hosts())["removed"] == 0
        assert purged == []


class TestPendingRegistration:
    """DHCP 下发的机器：登记要等它自己报出地址。

    创建那一刻地址并不存在（cloud-init 里只有 ``ip=dhcp``），所以先记进待登记
    队列（``sshremote.remember_pending_registration``），再由后台任务与周期作业
    ``host_sync`` 拿这份队列去解析地址。这里验证队列这一层的编排：解析到就登记
    并出队，没解析到就留着，脏数据与超期项会被丢掉。
    """

    ITEM = {
        "conn_id": "c1",
        "node": "pve",
        "vmid": 107,
        "name": "test（pve/107）",
        "ssh_username": "root",
        "owner": "admin",
    }

    @pytest.fixture()
    def settings(self, monkeypatch) -> Dict[str, str]:
        """把 settings 换成内存里的一个 dict。"""
        box: Dict[str, str] = {}

        async def get(key: str, default: Any = None) -> Any:
            return box.get(key, default)

        async def set(key: str, value: str) -> None:
            box[key] = str(value)

        monkeypatch.setattr(store, "get_setting", get)
        monkeypatch.setattr(store, "set_setting", set)
        return box

    def _stub_pve(self, monkeypatch, ip: str) -> None:
        async def fake_resolve(client: Any, guest: Dict[str, Any]) -> str:
            return ip

        monkeypatch.setattr(guestip, "resolve", fake_resolve)
        monkeypatch.setattr(pve, "client_for_connection", lambda cid: object())

    def test_registers_once_the_machine_reports_an_address(self, settings, monkeypatch) -> None:
        run(sshremote.remember_pending_registration(dict(self.ITEM)))
        assert "c1|pve|107" in run(sshremote._load_pending())

        registered: List[Dict[str, Any]] = []

        async def fake_register(**kwargs: Any) -> Dict[str, Any]:
            registered.append(kwargs)
            return {"id": "h1"}

        monkeypatch.setattr(sshremote, "register_managed_host", fake_register)
        self._stub_pve(monkeypatch, "172.16.149.20")

        result = run(sshremote.process_pending_registrations())

        assert result["registered"] == 1
        assert registered[0]["host"] == "172.16.149.20"
        assert registered[0]["name"] == "test（pve/107）"
        assert registered[0]["node"] == "pve" and registered[0]["vmid"] == 107
        # 出队：下一轮不该再登记同一台（否则每 5 分钟多一台重复主机）
        assert run(sshremote._load_pending()) == {}

    def test_keeps_waiting_while_there_is_no_address(self, settings, monkeypatch) -> None:
        """没装 Guest Agent 的镜像会在队列里待到超期，而不是被反复重试登记。"""
        run(sshremote.remember_pending_registration(dict(self.ITEM)))
        self._stub_pve(monkeypatch, "")

        result = run(sshremote.process_pending_registrations())

        assert result == {"checked": 1, "registered": 0, "pending": 1}
        assert "c1|pve|107" in run(sshremote._load_pending())

    def test_forget_removes_the_item(self, settings) -> None:
        run(sshremote.remember_pending_registration(dict(self.ITEM)))
        run(sshremote.forget_pending_registration("c1", "pve", 107))
        assert run(sshremote._load_pending()) == {}

    def test_stale_items_are_dropped(self, settings) -> None:
        """超过保鲜期就丢：那台机器多半已被删除，或永远报不出地址。"""
        settings[sshremote.PENDING_KEY] = json.dumps(
            {
                "c1|pve|107": {
                    **self.ITEM,
                    "since": int(time.time()) - sshremote.PENDING_TTL - 60,
                }
            }
        )
        assert run(sshremote._load_pending()) == {}

    def test_malformed_items_are_dropped(self, settings, monkeypatch) -> None:
        settings[sshremote.PENDING_KEY] = json.dumps({"junk": {"since": int(time.time())}})
        self._stub_pve(monkeypatch, "")
        assert run(sshremote.process_pending_registrations()) == {
            "checked": 1,
            "registered": 0,
            "pending": 0,
        }

    def test_empty_queue_is_a_noop(self) -> None:
        assert run(sshremote.process_pending_registrations()) == {
            "checked": 0,
            "registered": 0,
            "pending": 0,
        }


class TestReportCacheInvalidation:
    """受管主机集合变了，就要让「端口与进程 / 安全基线」的总览缓存作废。

    缓存的 key 只有「功能名 + 可见主机集合 + 语言」，**不含主机数量** ——
    不清的话，刚登记（或刚接入）的机器会命中那份还不含它的旧报告，最长 2 分钟
    不出现在全平台总览里，看着正像「面板下发的虚拟机没被纳管」。
    """

    def test_saving_a_host_drops_cached_reports(self) -> None:
        key = reportcache.scope_key("ports", None)
        reportcache.store(key, {"sentinel": True})
        assert reportcache.peek(key) is not None

        run(sshremote._invalidate_report_cache())

        assert reportcache.peek(key) is None
