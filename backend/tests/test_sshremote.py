"""多机 SSH 安全：主机 CRUD、远程命令构造、回传解析与多机聚合。

不连真机器：把 ``sshremote.run_command`` 换成桩，直接验证「发的是什么命令、
回来的东西怎么解析」。真 SSH 只差一个 paramiko 连接，逻辑都被这里覆盖。
"""
from __future__ import annotations

import asyncio
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

from app import sshguard, sshremote  # noqa: E402
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
