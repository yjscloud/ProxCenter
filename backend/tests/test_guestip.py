"""客户机 IP 解析：Guest Agent / 容器网卡接口 / 静态配置这三条来源。

这一列最容易出的错是「DHCP 下发的机器永远拿不到地址」—— 容器原先只读配置里的
静态 ``ip=``，DHCP 时必然是空；虚拟机侧则只在装了 Guest Agent 时才可能有值。
这里把两条来源、优先级与各种降级都钉住：不连真机、不碰数据库。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import guestip  # noqa: E402


def run(coro):
    """项目没装 pytest-asyncio，这里显式跑一次事件循环。"""
    return asyncio.run(coro)


class FakeClient:
    """只实现 guestip 会碰的四个读接口，并记录依次调用了哪些。

    ``None`` 表示「这个接口取不到数据」（Guest Agent 未装、容器没起来），
    用来验证降级路径；``boom`` 则让它一律报错。
    """

    def __init__(
        self,
        *,
        ct_config: Optional[Dict[str, Any]] = None,
        vm_config: Optional[Dict[str, Any]] = None,
        agent: Optional[List[Dict[str, Any]]] = None,
        ct_ifaces: Optional[List[Dict[str, Any]]] = None,
        boom: bool = False,
    ) -> None:
        self.calls: List[str] = []
        self.ct_config = ct_config or {}
        self.vm_config = vm_config or {}
        self.agent = agent
        self.ct_ifaces = ct_ifaces
        self.boom = boom

    def _record(self, name: str) -> None:
        self.calls.append(name)
        if self.boom:
            raise RuntimeError("PVE 故障")

    async def lxc_config(self, node: str, vmid: int) -> Dict[str, Any]:
        self._record("lxc_config")
        return self.ct_config

    async def qemu_config(self, node: str, vmid: int) -> Dict[str, Any]:
        self._record("qemu_config")
        return self.vm_config

    async def qemu_agent_network(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        self._record("qemu_agent_network")
        if self.agent is None:
            raise RuntimeError("agent 未装")
        return self.agent

    async def lxc_interfaces(self, node: str, vmid: int) -> List[Dict[str, Any]]:
        self._record("lxc_interfaces")
        if self.ct_ifaces is None:
            raise RuntimeError("容器没起来")
        return self.ct_ifaces


def ct(**kwargs: Any) -> Dict[str, Any]:
    row = {"node": "pve", "vmid": 110, "type": "lxc", "status": "running"}
    row.update(kwargs)
    return row


def vm(**kwargs: Any) -> Dict[str, Any]:
    row = {"node": "pve", "vmid": 103, "type": "qemu", "status": "running"}
    row.update(kwargs)
    return row


# ----------------------------------------------------------------- 纯解析
class TestStaticConfig:
    def test_dhcp_has_no_static_address(self) -> None:
        assert guestip.static_ip_from_config({"ipconfig0": "ip=dhcp"}) == ""
        assert guestip.static_ip_from_config({"net0": "name=eth0,bridge=vmbr0,ip=dhcp"}) == ""

    def test_manual_auto_none_are_not_addresses(self) -> None:
        for value in ("manual", "auto", "none"):
            assert guestip.static_ip_from_config({"net0": f"ip={value}"}) == ""

    def test_static_address_loses_its_prefix(self) -> None:
        assert (
            guestip.static_ip_from_config({"ipconfig0": "ip=172.16.149.55/24,gw=172.16.149.1"})
            == "172.16.149.55"
        )

    def test_container_net_key_is_read_too(self) -> None:
        assert guestip.static_ip_from_config({"net0": "name=eth0,ip=10.0.0.9/16"}) == "10.0.0.9"

    def test_ip6_auto_is_not_mistaken_for_ip(self) -> None:
        assert guestip.static_ip_from_config({"net0": "name=eth0,ip6=auto"}) == ""

    def test_higher_net_index_is_also_scanned(self) -> None:
        """只用过 net0/net1 的时代漏掉了 net3 这种 —— 现在按编号全扫。"""
        assert guestip.static_ip_from_config({"net3": "name=eth3,ip=10.1.1.5/24"}) == "10.1.1.5"


class TestPickAddresses:
    def test_container_prefers_ipv4_and_skips_loopback(self) -> None:
        interfaces = [
            {"name": "lo", "inet": "127.0.0.1/8"},
            {"name": "eth0", "inet6": "fe80::1/64"},
            {"name": "eth0", "inet": "172.16.149.20/24", "inet6": "fd00::5/64"},
        ]
        assert guestip.pick_container_ip(interfaces) == "172.16.149.20"

    def test_container_falls_back_to_ipv6_when_that_is_all_there_is(self) -> None:
        assert guestip.pick_container_ip([{"name": "eth0", "inet6": "fd00::9/64"}]) == "fd00::9"

    def test_container_tolerates_missing_fields(self) -> None:
        assert guestip.pick_container_ip([{"name": "eth0"}, {}]) == ""

    def test_agent_skips_loopback_and_link_local(self) -> None:
        interfaces = [
            {
                "name": "lo",
                "ip-addresses": [{"ip-address": "127.0.0.1", "ip-address-type": "ipv4"}],
            },
            {
                "name": "eth0",
                "ip-addresses": [
                    {"ip-address": "169.254.1.1", "ip-address-type": "ipv4"},
                    {"ip-address": "10.0.0.7", "ip-address-type": "ipv4"},
                ],
            },
        ]
        assert guestip.pick_agent_ip(interfaces) == "10.0.0.7"


# ----------------------------------------------------------------- 编排
class TestResolveContainer:
    def test_static_container_costs_one_request(self) -> None:
        client = FakeClient(ct_config={"net0": "name=eth0,bridge=vmbr0,ip=10.0.0.5/24"})
        assert run(guestip.resolve(client, ct())) == "10.0.0.5"
        # 静态地址在配置里就定了，不该再去问容器网卡
        assert client.calls == ["lxc_config"]

    def test_dhcp_container_asks_the_container_itself(self) -> None:
        """DHCP 下发的容器：配置里只有 ip=dhcp，地址只能从网卡接口读。"""
        client = FakeClient(
            ct_config={"net0": "name=eth0,bridge=vmbr0,ip=dhcp"},
            ct_ifaces=[{"name": "eth0", "hwaddr": "aa:bb:cc:dd:ee:ff", "inet": "172.16.149.88/24"}],
        )
        assert run(guestip.resolve(client, ct())) == "172.16.149.88"
        assert client.calls == ["lxc_config", "lxc_interfaces"]

    def test_stopped_container_is_not_asked(self) -> None:
        """已停止的容器 PVE 读不到网卡，别白问一次（也避免把错误日志刷满）。"""
        client = FakeClient(ct_config={"net0": "ip=dhcp"})
        assert run(guestip.resolve(client, ct(status="stopped"))) == ""
        assert client.calls == ["lxc_config"]

    def test_container_interface_error_degrades_to_empty(self) -> None:
        client = FakeClient(ct_config={"net0": "ip=dhcp"})  # ct_ifaces=None → 报错
        assert run(guestip.resolve(client, ct())) == ""

    def test_pve_failure_never_raises(self) -> None:
        assert run(guestip.resolve(FakeClient(boom=True), ct())) == ""
        assert run(guestip.resolve(FakeClient(boom=True), vm())) == ""

    def test_multiple_container_nics_take_the_first_usable(self) -> None:
        client = FakeClient(
            ct_config={"net0": "ip=dhcp", "net1": "ip=dhcp"},
            ct_ifaces=[
                {"name": "lo", "inet": "127.0.0.1/8"},
                {"name": "eth0", "inet": "10.2.0.10/24"},
                {"name": "eth1", "inet": "10.3.0.10/24"},
            ],
        )
        assert run(guestip.resolve(client, ct())) == "10.2.0.10"


class TestResolveVm:
    def test_agent_wins_over_static_config(self) -> None:
        client = FakeClient(
            vm_config={"ipconfig0": "ip=10.0.0.5/24"},
            agent=[
                {
                    "name": "eth0",
                    "ip-addresses": [{"ip-address": "10.0.0.77", "ip-address-type": "ipv4"}],
                }
            ],
        )
        assert run(guestip.resolve(client, vm())) == "10.0.0.77"
        # agent 答了就不必再读配置
        assert client.calls == ["qemu_agent_network"]

    def test_without_agent_falls_back_to_static_config(self) -> None:
        client = FakeClient(vm_config={"ipconfig0": "ip=10.0.0.5/24"})  # agent=None → 报错
        assert run(guestip.resolve(client, vm())) == "10.0.0.5"
        assert client.calls == ["qemu_agent_network", "qemu_config"]

    def test_dhcp_vm_without_agent_has_no_address(self) -> None:
        """没有 Guest Agent 的 DHCP 虚拟机，PVE 侧没有第二条读取途径。"""
        client = FakeClient(vm_config={"ipconfig0": "ip=dhcp"})
        assert run(guestip.resolve(client, vm())) == ""

    def test_stopped_vm_never_touches_the_agent(self) -> None:
        client = FakeClient(vm_config={"ipconfig0": "ip=10.0.0.6/24"})
        assert run(guestip.resolve(client, vm(status="stopped"))) == "10.0.0.6"
        assert client.calls == ["qemu_config"]

    def test_missing_node_or_vmid_is_a_noop(self) -> None:
        client = FakeClient()
        assert run(guestip.resolve(client, {"type": "lxc"})) == ""
        assert run(guestip.resolve(client, {"node": "pve", "vmid": None})) == ""
        assert client.calls == []


class TestResolveVmIpForAlerts:
    """告警 / 登录审计那条路只拿着 node+vmid，走的是另一个入口。"""

    def test_returns_agent_address_first(self) -> None:
        client = FakeClient(
            agent=[
                {
                    "name": "eth0",
                    "ip-addresses": [{"ip-address": "10.9.9.9", "ip-address-type": "ipv4"}],
                }
            ]
        )
        assert run(guestip.resolve_vm_ip(client, "pve", 103)) == "10.9.9.9"

    def test_falls_back_to_static_address(self) -> None:
        client = FakeClient(vm_config={"ipconfig0": "ip=10.0.0.8/24"})
        assert run(guestip.resolve_vm_ip(client, "pve", 103)) == "10.0.0.8"

    def test_empty_input_stays_empty(self) -> None:
        client = FakeClient()
        assert run(guestip.resolve_vm_ip(client, "", 0)) == ""
        assert client.calls == []
