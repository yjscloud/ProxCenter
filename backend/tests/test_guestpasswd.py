"""Unit tests for resetting a user password inside a guest (VM / container).

这个功能有三条通道，**每一条都有一处「不写对就静默失效」的地方**，真机上很难
复现，所以在这里锁死：

* cloud-init 那条：改完 ``cipassword`` 必须再**重新生成 config drive**，否则
  cloud-init 不会重跑（instance-id 没变），表现是「密码改了但登不进去」；
* Guest Agent 那条：老 agent 不认 ``guest-set-user-password`` 时要能退回
  ``chpasswd``，而且口令必须走 base64 的 stdin —— 拼接写法遇到带引号 / 反斜杠的
  口令就会把命令拼坏；
* 宿主机 SSH 那条：``sudo`` 只能加在 ``pct`` 上（写成 ``sudo printf … | pct exec``
  的话 sudo 只管到管道左边），报错还得翻译成人话。

这些都是纯逻辑，不需要 PVE、也不需要 SSH：

    ../.venv/bin/python -m pytest tests/test_guestpasswd.py -v
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from fastapi import HTTPException  # noqa: E402

from app import guestpasswd  # noqa: E402
from app.pve import ProxmoxError  # noqa: E402


def run(coro):
    """同步跑协程 —— 与 test_bulk / test_sshremote 同一套路。"""
    return asyncio.run(coro)


GOOD_PASSWORD = "Zx9Qw2Ef"


def ci_drive_config(**extra) -> dict:
    """带 cloud-init 盘的最小虚拟机配置（键名与 PVE 一致）。"""
    return {
        "name": "demo",
        "ide2": "local:100/vm-100-cloudinit.qcow2,media=cdrom",
        **extra,
    }


# ------------------------------------------------------------------- helpers
class FakeVmClient:
    """记录调用的假 PVE 客户端；只实现本模块用到的那几个方法。"""

    def __init__(
        self,
        *,
        status: str = "running",
        config: dict | None = None,
        agent_alive: bool = True,
        set_password_error: ProxmoxError | None = None,
        regen_error: ProxmoxError | None = None,
        exec_output: tuple[int, str] = (0, ""),
    ) -> None:
        self.status = status
        self.config = ci_drive_config() if config is None else config
        self.agent_alive = agent_alive
        self.set_password_error = set_password_error
        self.regen_error = regen_error
        self.exec_output = exec_output
        self.calls: list = []

    # ---- 读
    async def qemu_config(self, node: str, vmid: int) -> dict:
        self.calls.append(("config", node, vmid))
        return dict(self.config)

    async def qemu_status(self, node: str, vmid: int) -> dict:
        return {"status": self.status}

    async def qemu_agent_ping(self, node: str, vmid: int) -> dict:
        self.calls.append(("ping", vmid))
        if not self.agent_alive:
            raise ProxmoxError("no agent", 500)
        return {}

    # ---- 写
    async def qemu_agent_set_password(
        self, node: str, vmid: int, username: str, password: str
    ):
        self.calls.append(("set-password", username, password))
        if self.set_password_error:
            raise self.set_password_error
        return {}

    async def qemu_agent_exec(self, node: str, vmid: int, argv: list):
        self.calls.append(("agent-exec", argv))
        return {"pid": 4242}

    async def qemu_agent_exec_status(self, node: str, vmid: int, pid):
        code, out = self.exec_output
        return {"exited": 1, "exitcode": code, "out-data": out, "err-data": out}

    async def qemu_set_config(self, node: str, vmid: int, config: dict):
        self.calls.append(("set-config", config))
        return None

    async def qemu_cloudinit_regen(self, node: str, vmid: int):
        self.calls.append(("cloudinit-regen",))
        if self.regen_error:
            raise self.regen_error
        return None

    async def qemu_power(self, node: str, vmid: int, action: str):
        self.calls.append(("power", action))
        return "UPID:pve:0001:power"

    # ---- 断言辅助
    def called(self, name: str) -> list:
        return [c for c in self.calls if c[0] == name]


class FakeCtClient:
    """假容器客户端。"""

    def __init__(self, *, status: str = "running") -> None:
        self.status = status
        self.calls: list = []

    async def lxc_config(self, node: str, vmid: int) -> dict:
        return {"hostname": "demo"}

    async def lxc_status(self, node: str, vmid: int) -> dict:
        return {"status": self.status}


def patch_ssh(monkeypatch, *, host: dict | None, runner=None) -> dict:
    """把「找受管主机」与「跑远程命令」都换掉，返回记录用的容器。"""
    captured: dict = {"commands": []}

    async def fake_host(node):
        return host

    async def fake_run(row, command, timeout=0):
        captured["commands"].append(command)
        if runner is not None:
            return runner(command)
        return True, ""

    monkeypatch.setattr(guestpasswd, "_ssh_host", fake_host)
    monkeypatch.setattr(guestpasswd.sshremote, "run_command", fake_run)
    return captured


MANAGED_HOST = {
    "name": "pve",
    "host": "172.16.149.3",
    "username": "root",
    "enabled": 1,
    "use_sudo": 0,
}


# =============================================================== 用户名规则
class TestUsername:
    @pytest.mark.parametrize("name", ["root", "ubuntu", "Administrator", "www-data", "a_1"])
    def test_accepts_common_names(self, name: str) -> None:
        assert guestpasswd.username_error(name) == ""

    @pytest.mark.parametrize("name", ["", "  ", "1root", "bad name", "root;ls", "a" * 40, "root:x"])
    def test_rejects_unsafe_names(self, name: str) -> None:
        # 用户名会进到「客户机内执行命令」与 chpasswd 的输入里，必须严格
        assert guestpasswd.username_error(name) != ""


class TestCloudinitDrive:
    def test_detects_drive(self) -> None:
        assert guestpasswd._has_cloudinit_drive(ci_drive_config()) is True

    def test_absent(self) -> None:
        assert guestpasswd._has_cloudinit_drive({"ide0": "local:iso/x.iso"}) is False
        assert guestpasswd._has_cloudinit_drive({}) is False


# =================================================================== 能力探测
class TestInspectVm:
    def test_running_with_agent(self) -> None:
        info = run(guestpasswd.inspect(guestpasswd.VM_KIND, FakeVmClient(), "pve", 100))
        assert info["recommended"] == guestpasswd.AGENT
        assert info["username"] == "root"
        assert {m["id"]: m["available"] for m in info["methods"]} == {
            guestpasswd.AGENT: True,
            guestpasswd.CLOUDINIT: True,
        }

    def test_stopped_prefers_cloudinit(self) -> None:
        client = FakeVmClient(status="stopped")
        info = run(guestpasswd.inspect(guestpasswd.VM_KIND, client, "pve", 100))
        assert info["recommended"] == guestpasswd.CLOUDINIT
        agent = next(m for m in info["methods"] if m["id"] == guestpasswd.AGENT)
        assert agent["available"] is False
        assert "没在运行" in agent["reason"]
        # 关机时不去 ping：客户机都不在，问了也只是白等
        assert client.called("ping") == []

    def test_stopped_without_cloudinit_drive_has_no_way(self) -> None:
        client = FakeVmClient(status="stopped", config={"ide0": "local:iso/x.iso"})
        info = run(guestpasswd.inspect(guestpasswd.VM_KIND, client, "pve", 108))
        assert info["recommended"] == ""
        assert all(m["available"] is False for m in info["methods"])
        ci = next(m for m in info["methods"] if m["id"] == guestpasswd.CLOUDINIT)
        assert "cloud-init 盘" in ci["reason"]


class TestInspectContainer:
    def test_without_managed_host(self, monkeypatch) -> None:
        patch_ssh(monkeypatch, host=None)
        info = run(guestpasswd.inspect(guestpasswd.CT_KIND, FakeCtClient(), "pve", 110))
        assert info["recommended"] == ""
        method = info["methods"][0]
        assert method["available"] is False
        assert "受管主机" in method["reason"]

    def test_stopped_container(self, monkeypatch) -> None:
        patch_ssh(monkeypatch, host=MANAGED_HOST)
        info = run(
            guestpasswd.inspect(guestpasswd.CT_KIND, FakeCtClient(status="stopped"), "pve", 110)
        )
        method = info["methods"][0]
        assert method["available"] is False
        assert "没在运行" in method["reason"]

    def test_running_with_managed_host(self, monkeypatch) -> None:
        patch_ssh(monkeypatch, host=MANAGED_HOST)
        info = run(guestpasswd.inspect(guestpasswd.CT_KIND, FakeCtClient(), "pve", 110))
        assert info["recommended"] == guestpasswd.SSH
        method = info["methods"][0]
        assert method["available"] is True
        # 说明里要写清「用哪台机器、做什么」，否则用户不知道权限从哪来
        assert "root@172.16.149.3" in method["description"]
        assert "pct exec 110" in method["description"]
        assert info["ssh_host"]["host"] == "172.16.149.3"


# ===================================================================== 校验
class TestValidation:
    def test_weak_password_rejected(self) -> None:
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, FakeVmClient(), "pve", 100,
                    username="root", password="short1",
                )
            )
        assert exc.value.status_code == 400
        assert "8 位" in exc.value.detail

    def test_bad_username_rejected_before_any_pve_call(self) -> None:
        client = FakeVmClient()
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, client, "pve", 100,
                    username="root; rm -rf /", password=GOOD_PASSWORD,
                )
            )
        assert exc.value.status_code == 400
        assert client.calls == []

    def test_no_available_method_is_conflict(self) -> None:
        client = FakeVmClient(status="stopped", config={})
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, client, "pve", 108,
                    username="root", password=GOOD_PASSWORD,
                )
            )
        assert exc.value.status_code == 409
        # 不可用时必须把「缺什么」说清楚
        assert "cloud-init 盘" in exc.value.detail
        assert "没在运行" in exc.value.detail

    def test_explicitly_requested_method_must_be_available(self) -> None:
        client = FakeVmClient(status="stopped")
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, client, "pve", 100,
                    username="root", password=GOOD_PASSWORD,
                    method=guestpasswd.AGENT,
                )
            )
        assert exc.value.status_code == 409
        assert "没在运行" in exc.value.detail


# ================================================================ Agent 通道
class TestAgentReset:
    def test_direct_success(self) -> None:
        client = FakeVmClient()
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="root", password=GOOD_PASSWORD,
            )
        )
        assert result["method"] == guestpasswd.AGENT
        assert result["restarted"] is False
        assert client.called("set-password")[0][1:] == ("root", GOOD_PASSWORD)
        # 成功的路径不该再去客户机里跑命令
        assert client.called("agent-exec") == []

    def test_falls_back_to_chpasswd_for_old_agent(self) -> None:
        """老 agent 不认 guest-set-user-password：退回客户机内的 chpasswd。"""
        client = FakeVmClient(
            set_password_error=ProxmoxError("child process has failed to set user password", 500)
        )
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="root", password=GOOD_PASSWORD,
            )
        )
        assert result["method"] == guestpasswd.AGENT
        assert "chpasswd" in result["detail"]
        argv = client.called("agent-exec")[0][1]
        assert argv[0] == "/bin/sh"
        # 口令必须经 base64 送进去：拼接写法遇到引号 / 反斜杠就废了
        payload = argv[2].split("printf %s ", 1)[1].split(" | ", 1)[0]
        assert base64.b64decode(payload).decode() == f"root:{GOOD_PASSWORD}\n"
        assert "chpasswd" in argv[2]

    def test_keeps_original_error_when_agent_is_dead(self) -> None:
        """agent 没起来时不要再试 chpasswd：两条错互相矛盾，用户反而看不懂。

        直接调这一层 —— 走 ``reset`` 的话，agent 不可用会被探测挡在前面、
        自动改走 cloud-init，测不到这里的兜底逻辑。
        """
        client = FakeVmClient(
            agent_alive=False,
            set_password_error=ProxmoxError("No QEMU guest agent configured", 500),
        )
        with pytest.raises(HTTPException) as exc:
            run(guestpasswd._reset_via_agent(client, "pve", 100, "root", GOOD_PASSWORD))
        assert "No QEMU guest agent configured" in exc.value.detail
        assert client.called("agent-exec") == []

    def test_unavailable_agent_falls_through_to_cloudinit(self) -> None:
        """agent 没起来、机器有 cloud-init 盘：不该硬走 agent，而是改走 cloud-init。"""
        client = FakeVmClient(agent_alive=False)
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="root", password=GOOD_PASSWORD,
            )
        )
        assert result["method"] == guestpasswd.CLOUDINIT
        assert client.called("set-password") == []
        assert client.called("cloudinit-regen")

    def test_chpasswd_failure_reports_guest_output(self) -> None:
        client = FakeVmClient(
            set_password_error=ProxmoxError("agent refused", 500),
            exec_output=(1, "chpasswd: line 1: user 'nobody' does not exist"),
        )
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, client, "pve", 100,
                    username="nobody", password=GOOD_PASSWORD,
                )
            )
        assert exc.value.status_code == 502
        assert "does not exist" in exc.value.detail


# ============================================================ cloud-init 通道
class TestCloudinitReset:
    def test_running_vm_is_regenerated_then_rebooted(self) -> None:
        client = FakeVmClient()
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="ubuntu", password=GOOD_PASSWORD,
                method=guestpasswd.CLOUDINIT,
            )
        )
        config = client.called("set-config")[0][1]
        assert config == {"cipassword": GOOD_PASSWORD, "ciuser": "ubuntu"}
        # 少了这一步，cloud-init 不会重跑，重启也不会改口令
        assert client.called("cloudinit-regen")
        assert client.called("power")[0][1:] == ("reboot",)
        assert result["restarted"] is True
        assert result["task"] == "UPID:pve:0001:power"

    def test_stopped_vm_applies_on_next_start(self) -> None:
        client = FakeVmClient(status="stopped")
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="root", password=GOOD_PASSWORD,
            )
        )
        assert result["method"] == guestpasswd.CLOUDINIT
        assert result["restarted"] is False
        assert result["task"] == ""
        assert client.called("power") == []
        assert "下次开机" in result["detail"]

    def test_regen_failure_surfaces_as_error(self) -> None:
        client = FakeVmClient(regen_error=ProxmoxError("regenerate failed", 500))
        with pytest.raises(HTTPException) as exc:
            run(
                guestpasswd.reset(
                    guestpasswd.VM_KIND, client, "pve", 100,
                    username="root", password=GOOD_PASSWORD,
                    method=guestpasswd.CLOUDINIT,
                )
            )
        assert "写入 cloud-init 失败" in exc.value.detail
        assert client.called("power") == []


# ================================================================ SSH 通道
class TestSshReset:
    def test_without_managed_host_is_conflict(self, monkeypatch) -> None:
        patch_ssh(monkeypatch, host=None)
        with pytest.raises(HTTPException) as exc:
            run(guestpasswd._reset_via_ssh("pve", 110, "root", GOOD_PASSWORD))
        assert exc.value.status_code == 409
        assert "受管主机" in exc.value.detail

    def test_command_shape_and_payload(self, monkeypatch) -> None:
        captured = patch_ssh(monkeypatch, host=MANAGED_HOST)
        detail = run(guestpasswd._reset_via_ssh("pve", 110, "root", GOOD_PASSWORD))
        command = captured["commands"][0]
        assert f"pct exec 110 -- chpasswd" in command
        assert command.startswith("printf %s ")
        assert "| base64 -d |" in command
        payload = command.split("printf %s ", 1)[1].split(" | ", 1)[0]
        assert base64.b64decode(payload).decode() == f"root:{GOOD_PASSWORD}\n"
        # 没勾 sudo 就不该出现 sudo
        assert "sudo" not in command
        assert "172.16.149.3" in detail

    def test_sudo_applies_to_pct_not_to_printf(self, monkeypatch) -> None:
        """``sudo printf … | pct exec`` 是错的：sudo 只管到管道左边。"""
        captured = patch_ssh(monkeypatch, host={**MANAGED_HOST, "use_sudo": 1})
        run(guestpasswd._reset_via_ssh("pve", 110, "root", GOOD_PASSWORD))
        command = captured["commands"][0]
        assert "| sudo -n pct exec 110 -- chpasswd" in command
        assert not command.startswith("sudo")

    def test_tricky_password_survives_encoding(self, monkeypatch) -> None:
        """口令里的引号 / 反斜杠 / $ 不该破坏命令（这是 base64 通道存在的理由）。"""
        captured = patch_ssh(monkeypatch, host=MANAGED_HOST)
        tricky = 'p@ss "quoted" \\ back\\slash $dollar'
        run(guestpasswd._reset_via_ssh("pve", 110, "root", tricky))
        command = captured["commands"][0]
        payload = command.split("printf %s ", 1)[1].split(" | ", 1)[0]
        assert base64.b64decode(payload).decode() == f"root:{tricky}\n"
        assert '"' not in payload

    @pytest.mark.parametrize(
        "output,expect",
        [
            ("pct: command not found", "不是 PVE 节点"),
            ("Configuration file 'nodes/pve/lxc/110.conf' does not exist", "找不到容器 110"),
            ("sudo: a password is required", "权限不足"),
            ("chpasswd: line 1: user 'nobody' does not exist", "容器内改口令失败"),
            ("something else entirely", "宿主机执行失败"),
        ],
    )
    def test_failure_messages_are_actionable(
        self, monkeypatch, output: str, expect: str
    ) -> None:
        patch_ssh(monkeypatch, host=MANAGED_HOST, runner=lambda _cmd: (False, output))
        with pytest.raises(HTTPException) as exc:
            run(guestpasswd._reset_via_ssh("pve", 110, "root", GOOD_PASSWORD))
        assert exc.value.status_code == 502
        assert expect in exc.value.detail

    def test_connection_error_is_reported(self, monkeypatch) -> None:
        def boom(_cmd):
            raise RuntimeError("Authentication failed")

        patch_ssh(monkeypatch, host=MANAGED_HOST, runner=boom)
        with pytest.raises(HTTPException) as exc:
            run(guestpasswd._reset_via_ssh("pve", 110, "root", GOOD_PASSWORD))
        assert "连接宿主机 172.16.149.3 失败" in exc.value.detail
        assert "Authentication failed" in exc.value.detail


# ===================================================================== 结果
class TestResultShape:
    def test_result_never_carries_the_password(self) -> None:
        client = FakeVmClient()
        result = run(
            guestpasswd.reset(
                guestpasswd.VM_KIND, client, "pve", 100,
                username="root", password=GOOD_PASSWORD,
            )
        )
        assert GOOD_PASSWORD not in str(result)
        assert set(result) == {"ok", "method", "username", "detail", "restarted", "task"}
