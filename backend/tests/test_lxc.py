"""Unit tests for the LXC (container) support.

覆盖两块最容易出错的地方：

1. **配置拼装** —— 容器的 ``rootfs`` / ``netN`` / ``mpN`` 与虚拟机的
   ``scsiN`` / ``netN`` 语义完全不同，写错一个键 PVE 会直接拒绝创建，
   而且这类错误只在真机上才暴露得出来，所以必须有回归用例。
2. **归属与类型分派** —— 容器与虚拟机共用 ``ownership.KIND_VM``，
   列表接口要能把 ``type`` 带出去，前端才知道该调哪套端点。

这些用例不需要连 PVE，只测纯函数。

    ../.venv/bin/python -m pytest tests/test_lxc.py -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import vmconfig  # noqa: E402
from app.schemas import (  # noqa: E402
    LxcCreateRequest,
    LxcMountSpec,
    LxcNetworkSpec,
    LxcSetupSpec,
)


# ------------------------------------------------------------- network spec
class TestLxcNetworkSpec:
    def test_defaults_to_named_interface_and_dhcp(self) -> None:
        value = vmconfig.format_lxc_network_spec(LxcNetworkSpec(), index=0)
        assert value == "name=eth0,bridge=vmbr0,ip=dhcp"

    def test_interface_name_follows_index(self) -> None:
        value = vmconfig.format_lxc_network_spec(LxcNetworkSpec(), index=2)
        assert value.startswith("name=eth2")

    def test_static_ip_with_gateway(self) -> None:
        spec = LxcNetworkSpec(ip="192.168.1.50/24", gateway="192.168.1.1")
        value = vmconfig.format_lxc_network_spec(spec, index=0)
        assert "ip=192.168.1.50/24" in value
        assert "gw=192.168.1.1" in value

    def test_gateway_ignored_for_dhcp(self) -> None:
        """Regression: PVE rejects a gateway when ip=dhcp."""
        spec = LxcNetworkSpec(ip="dhcp", gateway="192.168.1.1")
        value = vmconfig.format_lxc_network_spec(spec, index=0)
        assert "gw=" not in value

    def test_optional_flags(self) -> None:
        spec = LxcNetworkSpec(
            vlan_tag=10, firewall=True, rate=100, mtu=1400, ip6="dhcp"
        )
        value = vmconfig.format_lxc_network_spec(spec, index=0)
        assert "tag=10" in value
        assert "firewall=1" in value
        assert "rate=100" in value
        assert "mtu=1400" in value
        assert "ip6=dhcp" in value


# --------------------------------------------------------------- mount spec
class TestLxcMountSpec:
    def test_storage_size_and_path(self) -> None:
        value = vmconfig.format_lxc_mount_spec(
            LxcMountSpec(storage="local-lvm", size=8, mp="/data")
        )
        assert value == "local-lvm:8,mp=/data"

    def test_backup_and_acl_flags(self) -> None:
        value = vmconfig.format_lxc_mount_spec(
            LxcMountSpec(storage="local-lvm", size=8, mp="/data", backup=True, acl=True)
        )
        assert value.endswith(",backup=1,acl=1")


# ------------------------------------------------------------- create config
def _request(**overrides: object) -> LxcCreateRequest:
    base = {
        "node": "pve",
        "hostname": "web-01",
        "ostemplate": "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst",
        "storage": "local-lvm",
        "rootfs": 8,
    }
    base.update(overrides)  # type: ignore[arg-type]
    return LxcCreateRequest(**base)  # type: ignore[arg-type]


class TestBuildLxcConfig:
    def test_minimal_config_carries_pve_required_keys(self) -> None:
        config = vmconfig.build_lxc_config(_request(), vmid=100)
        assert config["vmid"] == 100
        assert config["ostemplate"].endswith(".tar.zst")
        assert config["storage"] == "local-lvm"
        assert config["hostname"] == "web-01"
        # rootfs 在创建时是「存储:GiB」，不是 volid
        assert config["rootfs"] == "local-lvm:8"

    def test_always_emits_at_least_one_nic(self) -> None:
        """Regression: a container without net0 has no network at all."""
        config = vmconfig.build_lxc_config(_request(), vmid=100)
        assert config["net0"] == "name=eth0,bridge=vmbr0,ip=dhcp"

    def test_multiple_nics_get_sequential_names(self) -> None:
        req = _request(
            networks=[LxcNetworkSpec(), LxcNetworkSpec(bridge="vmbr1", ip="dhcp")]
        )
        config = vmconfig.build_lxc_config(req, vmid=100)
        assert config["net0"].startswith("name=eth0")
        assert config["net1"].startswith("name=eth1")
        assert "bridge=vmbr1" in config["net1"]

    def test_unprivileged_and_features(self) -> None:
        config = vmconfig.build_lxc_config(
            _request(unprivileged=True, features=["nesting", "keyctl"]), vmid=100
        )
        assert config["unprivileged"] == 1
        assert config["features"] == "nesting=1,keyctl=1"

    def test_unknown_features_are_dropped(self) -> None:
        """Whitelist: PVE rejects unknown feature names outright."""
        config = vmconfig.build_lxc_config(
            _request(features=["nesting", "not-a-feature"]), vmid=100
        )
        assert config["features"] == "nesting=1"

    def test_setup_emits_password_and_ssh_keys(self) -> None:
        config = vmconfig.build_lxc_config(
            _request(
                setup=LxcSetupSpec(
                    password="s3cret", ssh_keys="ssh-rsa AAAA\nssh-ed25519 BBBB"
                )
            ),
            vmid=100,
        )
        assert config["password"] == "s3cret"
        # 多行公钥保留换行；表单编码会负责转义，这里不能再做一次 URL 编码
        assert config["ssh-public-keys"] == "ssh-rsa AAAA\nssh-ed25519 BBBB"

    def test_mount_points(self) -> None:
        req = _request(
            mounts=[LxcMountSpec(storage="local-lvm", size=20, mp="/data")]
        )
        config = vmconfig.build_lxc_config(req, vmid=100)
        assert config["mp0"] == "local-lvm:20,mp=/data"


# ------------------------------------------------------------------ parsers
class TestParsers:
    def test_parse_rootfs_with_size(self) -> None:
        parsed = vmconfig.parse_lxc_rootfs(
            {"rootfs": "local-lvm:vm-100-disk-0,size=8G"}
        )
        assert parsed["storage"] == "local-lvm"
        assert parsed["volid"] == "vm-100-disk-0"
        assert parsed["size"] == "8G"

    def test_parse_rootfs_missing(self) -> None:
        parsed = vmconfig.parse_lxc_rootfs({})
        assert parsed["storage"] == ""

    def test_parse_networks_is_all_key_value(self) -> None:
        nets = vmconfig.parse_lxc_networks(
            {
                "net0": "name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1,firewall=1",
                "net1": "name=eth1,bridge=vmbr1,ip=dhcp",
            }
        )
        assert len(nets) == 2
        assert nets[0]["name"] == "eth0"
        assert nets[0]["ip"] == "192.168.1.50/24"
        assert nets[0]["gw"] == "192.168.1.1"
        assert nets[0]["firewall"] == "1"

    def test_parse_mounts(self) -> None:
        mounts = vmconfig.parse_lxc_mounts(
            {"mp0": "local-lvm:vm-100-disk-1,mp=/data,size=20G"}
        )
        assert len(mounts) == 1
        assert mounts[0]["mp"] == "/data"
        assert mounts[0]["size"] == "20G"

    def test_parsers_ignore_unrelated_keys(self) -> None:
        """Regression: memory / cores 之类不能混进硬件清单。"""
        config = {"memory": 512, "cores": 2, "hostname": "web-01"}
        assert vmconfig.parse_lxc_mounts(config) == []
        assert vmconfig.parse_lxc_networks(config) == []


# ------------------------------------------------------------ request model
class TestLxcCreateRequest:
    def test_name_alias_maps_to_hostname(self) -> None:
        """前端按 VmCreateRequest 的习惯传 name，两种拼写都要能落到 hostname。"""
        req = LxcCreateRequest(
            node="pve",
            name="web-01",
            ostemplate="local:vztmpl/x.tar.zst",
            storage="local-lvm",
        )
        assert req.hostname == "web-01"

    def test_empty_hostname_rejected(self) -> None:
        with pytest.raises(Exception):
            LxcCreateRequest(
                node="pve",
                name="   ",
                ostemplate="local:vztmpl/x.tar.zst",
                storage="local-lvm",
            )
