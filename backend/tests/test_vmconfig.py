"""Unit tests for the PVE config builders and connection handling.

These cover the pieces most likely to break against a real cluster: the
key=value string assembly, UPID parsing, and permission checks. Run with:

    ../.venv/bin/python -m pytest tests/ -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make `app` importable when pytest is invoked from the backend/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import formatters, security, vmconfig  # noqa: E402
from app.pve import PveConnection, node_from_upid  # noqa: E402
from app.schemas import (  # noqa: E402
    CloudInitSpec,
    DiskSpec,
    EfiDiskSpec,
    IpConfig,
    NetworkSpec,
    NumaNodeSpec,
    TpmSpec,
    VmCreateRequest,
)


# --------------------------------------------------------------- connection
class TestPveConnection:
    def test_base_url_adds_scheme_and_port(self) -> None:
        conn = PveConnection(host="192.168.1.10", port=8006)
        assert conn.base_url == "https://192.168.1.10:8006"
        assert conn.api_url == "https://192.168.1.10:8006/api2/json"

    def test_base_url_respects_explicit_scheme(self) -> None:
        conn = PveConnection(host="https://pve.example.com", port=8006)
        assert conn.base_url == "https://pve.example.com:8006"

    def test_base_url_does_not_duplicate_existing_port(self) -> None:
        """Regression: host with an embedded port must not get a second one."""
        conn = PveConnection(host="http://127.0.0.1:13760", port=8006)
        assert conn.base_url == "http://127.0.0.1:13760"

        conn = PveConnection(host="https://pve.example.com:8443", port=8006)
        assert conn.base_url == "https://pve.example.com:8443"

    def test_base_url_strips_trailing_slash(self) -> None:
        conn = PveConnection(host="https://pve.example.com/", port=8006)
        assert conn.base_url == "https://pve.example.com:8006"

    def test_base_url_empty_host(self) -> None:
        assert PveConnection(host="", port=8006).base_url == ""

    def test_configured_requires_all_three_fields(self) -> None:
        assert not PveConnection(host="h").configured
        assert not PveConnection(host="h", token_id="t").configured
        assert PveConnection(host="h", token_id="t", token_secret="s").configured


class TestUpidParsing:
    def test_extracts_node_from_real_upid(self) -> None:
        upid = "UPID:pve1:0000A1B2:00C3D4E5:65F00000:qmstart:100:root@pam:"
        assert node_from_upid(upid) == "pve1"

    def test_returns_empty_for_garbage(self) -> None:
        assert node_from_upid("not-a-upid") == ""
        assert node_from_upid("") == ""


# ------------------------------------------------------------------ vmconfig
class TestDiskFormatting:
    def test_plain_disk(self) -> None:
        spec = DiskSpec(storage="local-lvm", size=32, interface="scsi0")
        assert vmconfig.format_disk_spec(spec) == "local-lvm:32"

    def test_disk_with_flags(self) -> None:
        spec = DiskSpec(
            storage="ceph-pool", size=100, interface="scsi1", discard=True, ssd=True
        )
        value = vmconfig.format_disk_spec(spec)
        assert value.startswith("ceph-pool:100")
        assert "discard=on" in value
        assert "ssd=1" in value

    def test_block_storage_forces_raw(self) -> None:
        # qcow2 is impossible on LVM/ZFS, so it must be coerced.
        assert vmconfig.normalize_disk_format("qcow2", "lvmthin") == "raw"
        assert vmconfig.normalize_disk_format("qcow2", "zfspool") == "raw"

    def test_dir_storage_keeps_qcow2(self) -> None:
        assert vmconfig.normalize_disk_format("qcow2", "dir") == "qcow2"


class TestNetworkFormatting:
    def test_minimal_network(self) -> None:
        spec = NetworkSpec(bridge="vmbr0", model="virtio")
        assert vmconfig.format_network_spec(spec) == "virtio,bridge=vmbr0"

    def test_network_with_vlan_and_firewall(self) -> None:
        spec = NetworkSpec(
            bridge="vmbr1", model="e1000", vlan_tag=42, firewall=True
        )
        value = vmconfig.format_network_spec(spec)
        assert value == "e1000,bridge=vmbr1,tag=42,firewall=1"

    def test_rejects_malformed_mac(self) -> None:
        spec = NetworkSpec(bridge="vmbr0", macaddr="not-a-mac")
        assert "macaddr" not in vmconfig.format_network_spec(spec)

    def test_accepts_valid_mac(self) -> None:
        spec = NetworkSpec(bridge="vmbr0", macaddr="aa:bb:cc:dd:ee:ff")
        assert "macaddr=AA:BB:CC:DD:EE:FF" in vmconfig.format_network_spec(spec)

    def test_unknown_model_falls_back_to_virtio(self) -> None:
        spec = NetworkSpec(bridge="vmbr0", model="bogus")
        assert vmconfig.format_network_spec(spec).startswith("virtio")


class TestCloudInit:
    def test_ssh_keys_are_url_encoded(self) -> None:
        # PVE requires the value to be URL-encoded; raw newlines would break it.
        raw = "ssh-ed25519 AAAAC3Nz user@host\nssh-rsa BBBB user2@host"
        encoded = vmconfig._encode_ssh_keys(raw)
        assert "\n" not in encoded
        assert "%0A" in encoded

    def test_dhcp_ipconfig(self) -> None:
        ci = CloudInitSpec(enabled=True, ip_configs=[IpConfig(ip="dhcp")])
        assert vmconfig.format_ipconfig(ci, 0) == "ip=dhcp"

    def test_static_ip_with_gateway(self) -> None:
        ci = CloudInitSpec(
            enabled=True,
            ip_configs=[IpConfig(ip="10.0.0.50/24", gateway="10.0.0.1")],
        )
        assert vmconfig.format_ipconfig(ci, 0) == "ip=10.0.0.50/24,gw=10.0.0.1"

    def test_missing_index_defaults_to_dhcp(self) -> None:
        ci = CloudInitSpec(enabled=True, ip_configs=[])
        assert vmconfig.format_ipconfig(ci, 3) == "ip=dhcp"

    def test_full_cloudinit_config(self) -> None:
        ci = CloudInitSpec(
            enabled=True,
            user="ubuntu",
            password="secret",
            ip_configs=[IpConfig(ip="dhcp"), IpConfig(ip="dhcp")],
            nameserver="1.1.1.1",
        )
        config = vmconfig.build_cloudinit_config(ci, network_count=2)
        assert config["ciuser"] == "ubuntu"
        assert config["cipassword"] == "secret"
        assert config["nameserver"] == "1.1.1.1"
        assert config["ipconfig0"] == "ip=dhcp"
        assert config["ipconfig1"] == "ip=dhcp"


class TestBuildVmConfig:
    def _request(self, **overrides: object) -> VmCreateRequest:
        base = {
            "node": "pve1",
            "name": "web-01",
            "memory": 4096,
            "cores": 4,
            "disks": [DiskSpec(storage="local-lvm", size=32, interface="scsi0")],
            "networks": [NetworkSpec(bridge="vmbr0")],
        }
        base.update(overrides)
        return VmCreateRequest(**base)  # type: ignore[arg-type]

    def test_basic_fields(self) -> None:
        config = vmconfig.build_vm_config(self._request(), vmid=101)
        assert config["vmid"] == 101
        assert config["name"] == "web-01"
        assert config["memory"] == 4096
        assert config["cores"] == 4
        assert config["scsi0"] == "local-lvm:32"
        assert config["net0"] == "virtio,bridge=vmbr0"
        assert config["boot"] == "order=scsi0"

    def test_agent_and_onboot_flags_are_ints(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(agent=True, start_on_boot=True), vmid=101
        )
        # PVE expects 1/0, not true/false.
        assert config["agent"] == 1
        assert config["onboot"] == 1

    def test_multiple_disks_and_nics_are_indexed(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                disks=[
                    DiskSpec(storage="local-lvm", size=32, interface="scsi0"),
                    DiskSpec(storage="local-lvm", size=64, interface="scsi1"),
                ],
                networks=[
                    NetworkSpec(bridge="vmbr0"),
                    NetworkSpec(bridge="vmbr1", vlan_tag=10),
                ],
            ),
            vmid=101,
        )
        assert config["scsi0"] == "local-lvm:32"
        assert config["scsi1"] == "local-lvm:64"
        assert config["net0"] == "virtio,bridge=vmbr0"
        assert "tag=10" in config["net1"]

    def test_iso_gets_a_free_ide_slot(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(iso="local:iso/ubuntu.iso"), vmid=101
        )
        assert config["ide0"] == "local:iso/ubuntu.iso,media=cdrom"

    def test_cloudinit_adds_drive_and_serial(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                cloudinit=CloudInitSpec(
                    enabled=True, user="ubuntu", ip_configs=[IpConfig(ip="dhcp")]
                )
            ),
            vmid=101,
        )
        # With no ISO mounted, the cloud-init drive takes ide0.
        assert config["ide0"] == "cloudinit"
        assert config["serial0"] == "socket"
        assert config["vga"] == "serial0"
        assert config["ciuser"] == "ubuntu"

    def test_disk_gets_format_segment_only_on_dir_storage(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                disks=[
                    DiskSpec(
                        storage="local", size=8, interface="scsi0", format="qcow2"
                    )
                ]
            ),
            vmid=101,
            storage_types={"local": "dir", "local-lvm": "lvmthin"},
        )
        assert config["scsi0"] == "local:8,format=qcow2"

    def test_import_disk_mode_skips_disk_allocation(self) -> None:
        # The template pipeline imports the disk separately, so no scsi0 here.
        config = vmconfig.build_vm_config(
            self._request(
                disks=[DiskSpec(storage="local-lvm", size=32, interface="scsi0")]
            ),
            vmid=101,
            import_disk=True,
        )
        assert "scsi0" not in config
        assert config["boot"] == "order=scsi0"

    def test_invalid_ostype_is_normalized(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(ostype="windows-11"), vmid=101
        )
        assert config["ostype"] == "l26"

    def test_valid_ostype_is_preserved(self) -> None:
        config = vmconfig.build_vm_config(self._request(ostype="win11"), vmid=101)
        assert config["ostype"] == "win11"


class TestAdvancedHardware:
    """NUMA 绑定与 EFI/TPM（Win11 必需）：拼接规则与固件校准。"""

    def _request(self, **overrides: object) -> VmCreateRequest:
        base = {
            "node": "pve1",
            "name": "db-01",
            "memory": 4096,
            "cores": 4,
            "disks": [DiskSpec(storage="local-lvm", size=32, interface="scsi0")],
        }
        base.update(overrides)
        return VmCreateRequest(**base)  # type: ignore[arg-type]

    # ------------------------------------------------------------------ NUMA
    def test_numa_flag_alone_only_switches_it_on(self) -> None:
        config = vmconfig.build_vm_config(self._request(numa=True), vmid=101)
        assert config["numa"] == 1
        assert "numa0" not in config
        assert "affinity" not in config

    def test_numa_nodes_are_indexed_and_share_memory(self) -> None:
        """不给 memory 时按节点数均分总内存 —— PVE 要求 numaN 必须有 memory。"""
        config = vmconfig.build_vm_config(
            self._request(
                numa=True,
                numa_nodes=[
                    NumaNodeSpec(cpus="0-3", hostnodes="0", policy="bind"),
                    NumaNodeSpec(cpus="4-7", memory=1024),
                ],
            ),
            vmid=101,
        )
        assert config["numa0"] == "cpus=0-3,memory=2048,hostnodes=0,policy=bind"
        # 显式给了 memory 就用它，不再均分
        assert config["numa1"] == "cpus=4-7,memory=1024"

    def test_numa_nodes_imply_the_switch(self) -> None:
        """只给节点定义忘了开 numa 的话，PVE 会把 numaN 全部忽略。"""
        config = vmconfig.build_vm_config(
            self._request(numa=False, numa_nodes=[NumaNodeSpec(cpus="0-1")]),
            vmid=101,
        )
        assert config["numa"] == 1

    def test_numa_node_without_valid_cpus_is_dropped(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                numa=True,
                numa_nodes=[NumaNodeSpec(cpus="abc"), NumaNodeSpec(cpus="8-11")],
            ),
            vmid=101,
        )
        # 非法的那条被丢掉，剩下的仍然按「第 0 个节点」编号
        assert "numa0" not in config
        assert config["numa1"].startswith("cpus=8-11,")

    def test_numa_policy_needs_hostnodes(self) -> None:
        """policy 只在绑定了物理 NUMA 节点时才有意义，单独给会被 PVE 拒绝。"""
        config = vmconfig.build_vm_config(
            self._request(
                numa_nodes=[NumaNodeSpec(cpus="0-3", policy="interleave")],
            ),
            vmid=101,
        )
        assert config["numa0"] == "cpus=0-3,memory=4096"
        assert "policy" not in config["numa0"]

    def test_affinity_is_normalized_and_invalid_dropped(self) -> None:
        good = vmconfig.build_vm_config(self._request(affinity=" 0-3,8 "), vmid=101)
        assert good["affinity"] == "0-3,8"

        bad = vmconfig.build_vm_config(self._request(affinity="all"), vmid=101)
        assert "affinity" not in bad

    # ------------------------------------------------------------- EFI / TPM
    def test_efidisk_forces_ovmf_and_q35(self) -> None:
        """EFI 盘配 SeaBIOS/i440fx 会建出一台起不来的机器，必须一起校准。"""
        config = vmconfig.build_vm_config(
            self._request(efi_disk=EfiDiskSpec(storage="local-lvm")),
            vmid=101,
        )
        assert config["bios"] == "ovmf"
        assert config["machine"] == "q35"
        assert config["efidisk0"] == "local-lvm:1,efitype=4m,pre-enrolled-keys=1"

    def test_tpmstate_forces_ovmf_and_q35(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(tpm=TpmSpec(storage="local-lvm")), vmid=101
        )
        assert config["bios"] == "ovmf"
        assert config["machine"] == "q35"
        assert config["tpmstate0"] == "local-lvm:4,version=v2.0"

    def test_explicit_q35_is_kept(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                machine="q35", efi_disk=EfiDiskSpec(storage="local-lvm")
            ),
            vmid=101,
        )
        assert config["machine"] == "q35"

    def test_pre_enrolled_keys_only_on_4m_disks(self) -> None:
        """2m 格式不支持这个参数，带上 PVE 会直接报错。"""
        config = vmconfig.build_vm_config(
            self._request(
                efi_disk=EfiDiskSpec(storage="local-lvm", efitype="2m")
            ),
            vmid=101,
        )
        assert config["efidisk0"] == "local-lvm:1,efitype=2m"

    def test_invalid_efi_type_and_tpm_version_fall_back(self) -> None:
        config = vmconfig.build_vm_config(
            self._request(
                efi_disk=EfiDiskSpec(storage="local", efitype="banana"),
                tpm=TpmSpec(storage="local", version="v9.9"),
            ),
            vmid=101,
        )
        assert "efitype=4m" in config["efidisk0"]
        assert config["tpmstate0"].endswith("version=v2.0")

    def test_firmware_untouched_without_efi_request(self) -> None:
        """没要求 EFI 就不要乱改用户的 BIOS 选择。"""
        config = vmconfig.build_vm_config(self._request(), vmid=101)
        assert config["bios"] == "seabios"
        assert config["machine"] == "pc"
        assert "efidisk0" not in config
        assert "tpmstate0" not in config

    def test_advanced_hardware_survives_import_disk_mode(self) -> None:
        """模板流水线跳过分盘分配，但固件与 TPM 该照样下发。"""
        config = vmconfig.build_vm_config(
            self._request(
                numa=True,
                efi_disk=EfiDiskSpec(storage="local-lvm"),
                tpm=TpmSpec(storage="local-lvm"),
            ),
            vmid=101,
            import_disk=True,
        )
        assert "scsi0" not in config
        assert config["numa"] == 1
        assert config["efidisk0"].startswith("local-lvm:1")
        assert config["tpmstate0"].startswith("local-lvm:4")

    # ------------------------------------------------------------------- 克隆
    def test_numa_config_is_reusable_for_clone_overrides(self) -> None:
        """克隆路径复用同一个拼装函数：纯配置项，按实例重新绑定。"""
        req = self._request(numa=True, affinity="0-7")
        assert vmconfig.build_numa_config(req) == {"numa": 1, "affinity": "0-7"}

    def test_numa_config_is_empty_when_not_requested(self) -> None:
        assert vmconfig.build_numa_config(self._request()) == {}


class TestRequestAliases:
    """The frontend uses camelCase in places; both spellings must work."""

    def test_template_mode_accepts_camel_case(self) -> None:
        req = VmCreateRequest(
            node="pve1", name="tpl", templateMode=True  # type: ignore[call-arg]
        )
        assert req.template_mode is True

    def test_source_image_aliases_cloud_image(self) -> None:
        req = VmCreateRequest(
            node="pve1", name="tpl", source_image="local:iso/x.img"  # type: ignore[call-arg]
        )
        assert req.cloud_image == "local:iso/x.img"

    def test_scsi_hw_aliases_scsihw(self) -> None:
        req = VmCreateRequest(
            node="pve1", name="vm", scsi_hw="lsi"  # type: ignore[call-arg]
        )
        assert req.scsihw == "lsi"

    def test_snake_case_still_works(self) -> None:
        req = VmCreateRequest(
            node="pve1", name="tpl", template_mode=True, cloud_image="local:iso/y.img"
        )
        assert req.template_mode is True
        assert req.cloud_image == "local:iso/y.img"

    def test_empty_name_is_rejected(self) -> None:
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            VmCreateRequest(node="pve1", name="   ")


# --------------------------------------------------------------- parse config
class TestParseConfig:
    def test_parses_disks(self) -> None:
        config = {
            "scsi0": "local-lvm:vm-100-disk-0,size=32G",
            "scsi1": "local-lvm:vm-100-disk-1,discard=on,size=64G",
            "net0": "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
        }
        disks = vmconfig.parse_config_disks(config)
        assert len(disks) == 2
        assert disks[0]["interface"] == "scsi0"
        assert disks[0]["size"] == "32G"
        assert disks[1]["discard"] == "on"

    def test_skips_cdrom_and_cloudinit(self) -> None:
        config = {
            "ide0": "local:iso/x.iso,media=cdrom",
            "ide2": "cloudinit",
            "scsi0": "local-lvm:vm-100-disk-0,size=8G",
        }
        disks = vmconfig.parse_config_disks(config)
        assert len(disks) == 1
        assert disks[0]["interface"] == "scsi0"

    def test_parses_networks(self) -> None:
        config = {"net0": "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10"}
        nets = vmconfig.parse_config_networks(config)
        assert len(nets) == 1
        assert nets[0]["bridge"] == "vmbr0"
        assert nets[0]["tag"] == "10"
        assert nets[0]["model"] == "virtio"


class TestSizeConversion:
    @pytest.mark.parametrize(
        "value,expected",
        [("32G", 32.0), ("512M", 0.5), ("1T", 1024.0), ("8", 8.0)],
    )
    def test_disk_size_to_gb(self, value: str, expected: float) -> None:
        assert vmconfig.disk_size_to_gb(value) == expected

    def test_invalid_size_returns_none(self) -> None:
        assert vmconfig.disk_size_to_gb("") is None
        assert vmconfig.disk_size_to_gb("abc") is None


# ------------------------------------------------------------- PVE flags
class TestPveFlag:
    """PVE 的「布尔」字段解析。

    回归用例：``agent`` 除了 ``1`` 还有 ``enabled=1,fstrim_cloned_disks=1``
    这种 k=v 写法，裸 ``int()`` 会 ValueError，把整个虚拟机详情接口打成 500。
    """

    @pytest.mark.parametrize(
        "value,expected",
        [
            ("enabled=1", 1),
            ("enabled=0", 0),
            ("enabled=1,fstrim_cloned_disks=1", 1),
            ("fstrim_cloned_disks=1,enabled=1", 1),
            # 只有 fstrim、没有 enabled：不认识的写法按默认值处理
            ("fstrim_cloned_disks=1", 0),
            (1, 1),
            (0, 0),
            ("1", 1),
            ("0", 0),
            (" 1 ", 1),
            (True, 1),
            (False, 0),
            ("on", 1),
            ("off", 0),
            ("true", 1),
            ("false", 0),
            # 非 0/1 的数值与无法识别的文本都不算「开启」
            (2, 0),
            ("2", 0),
            ("garbage", 0),
            (None, 0),
            ("", 0),
        ],
    )
    def test_parses_all_pve_shapes(self, value: object, expected: int) -> None:
        assert formatters.pve_flag(value) == expected

    def test_default_is_used_for_unknown_values(self) -> None:
        assert formatters.pve_flag(None, 1) == 1
        assert formatters.pve_flag("", 1) == 1
        assert formatters.pve_flag("garbage", 1) == 1


class TestNormalizeAgentInterfaces:
    """Guest Agent 网卡信息的整形：PVE 是 ``{"result": [...]}`` + 连字符命名。"""

    PVE_PAYLOAD = {
        "result": [
            {
                "name": "lo",
                "hardware-address": "00:00:00:00:00:00",
                "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "127.0.0.1", "prefix": 8},
                    {"ip-address-type": "ipv6", "ip-address": "::1", "prefix": 128},
                ],
            },
            {
                "name": "eth0",
                "hardware-address": "bc:24:11:18:3d:77",
                "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "172.16.149.73", "prefix": 24}
                ],
            },
        ]
    }

    def test_flattens_result_wrapper_and_hyphenated_keys(self) -> None:
        out = formatters.normalize_agent_interfaces(self.PVE_PAYLOAD)
        assert [i["name"] for i in out] == ["lo", "eth0"]
        assert out[0]["hardware_address"] == "00:00:00:00:00:00"
        assert out[0]["ip_addresses"] == [
            {"ip_address": "127.0.0.1", "prefix": 8, "ip_address_type": "ipv4"},
            {"ip_address": "::1", "prefix": 128, "ip_address_type": "ipv6"},
        ]
        assert out[1]["ip_addresses"][0]["ip_address"] == "172.16.149.73"

    @pytest.mark.parametrize("payload", [None, {}, [], "", 0, {"result": None}])
    def test_degenerate_payloads_yield_empty_list(self, payload: object) -> None:
        assert formatters.normalize_agent_interfaces(payload) == []

    def test_tolerates_missing_fields_and_junk_entries(self) -> None:
        out = formatters.normalize_agent_interfaces(
            {"result": [{"name": "eth1"}, None, {"name": "eth2", "ip-addresses": [None]}]}
        )
        assert out == [
            {"name": "eth1", "hardware_address": "", "ip_addresses": []},
            {"name": "eth2", "hardware_address": "", "ip_addresses": []},
        ]


# --------------------------------------------------- 新增硬件（槽位 / 配置值）
class TestNextFreeKey:
    """新增磁盘 / 网卡时的槽位分配。"""

    def test_returns_first_free_slot(self) -> None:
        config = {"scsi0": "x", "scsi2": "y", "net0": "z"}
        assert vmconfig.next_free_key("scsi", config, 31) == "scsi1"
        assert vmconfig.next_free_key("net", config, 32) == "net1"

    def test_starts_at_zero_when_empty(self) -> None:
        assert vmconfig.next_free_key("scsi", {}, 31) == "scsi0"

    def test_reuses_gap_instead_of_counting(self) -> None:
        """删掉 scsi0 后再新增要补回 scsi0，不能按数量推算成 scsi2 撞上已有的键。"""
        config = {"scsi1": "a", "scsi2": "b"}
        assert vmconfig.next_free_key("scsi", config, 31) == "scsi0"

    def test_ignores_non_numeric_and_other_prefixes(self) -> None:
        # scsihw 是 SCSI 控制器型号，不是磁盘；netin/netout 也不是网卡键
        config = {"scsihw": "virtio-scsi-pci", "netin": 1, "scsiz": "x"}
        assert vmconfig.next_free_key("scsi", config, 31) == "scsi0"

    def test_raises_when_all_slots_taken(self) -> None:
        config = {f"scsi{i}": "x" for i in range(3)}
        with pytest.raises(ValueError):
            vmconfig.next_free_key("scsi", config, 3)


class TestFormatDiskConfig:
    """磁盘配置值：与创建虚拟机的拼装走同一份逻辑。"""

    def test_dir_storage_keeps_explicit_format(self) -> None:
        spec = DiskSpec(storage="local", size=20, format="qcow2")
        assert vmconfig.format_disk_config(spec, "dir") == "local:20,format=qcow2"

    def test_block_storage_forces_raw_and_drops_format(self) -> None:
        spec = DiskSpec(storage="local-lvm", size=20, format="qcow2")
        assert vmconfig.format_disk_config(spec, "lvmthin") == "local-lvm:20"

    def test_unknown_storage_type_omits_format(self) -> None:
        spec = DiskSpec(storage="whatever", size=8, format="qcow2")
        assert vmconfig.format_disk_config(spec, "") == "whatever:8"

    def test_extra_flags_are_appended(self) -> None:
        spec = DiskSpec(
            storage="local", size=20, format="raw", discard=True, ssd=True
        )
        assert (
            vmconfig.format_disk_config(spec, "dir")
            == "local:20,discard=on,ssd=1,format=raw"
        )


# -------------------------------------------- Guest Agent 输出解码 / df 解析
class TestDecodeAgentOutput:
    """``exec-status.out-data`` 的编码兼容。

    回归用例：PVE 的文档说它是 base64，**实测 8.4 返回的是明文**。
    早先按 base64 硬解，客户机里明明执行成功却抛
    ``Invalid base64-encoded string``（证书下发链路就是这样一直是坏的）。
    """

    def test_plain_text_passes_through(self) -> None:
        text = (
            "Filesystem     1-blocks      Used Available Capacity Mounted on\n"
            "/dev/sda1      520785920 149880832 370905088      29% /boot\n"
        )
        assert formatters.decode_agent_output(text) == text

    def test_base64_is_decoded(self) -> None:
        import base64

        encoded = base64.b64encode("hello".encode("utf-8")).decode("ascii")
        assert formatters.decode_agent_output(encoded) == "hello"

    def test_short_plain_text_is_not_mistaken_for_base64(self) -> None:
        # "abcd" 长度是 4 的倍数、字符集也像 base64，但解出来不是合法 UTF-8
        assert formatters.decode_agent_output("abcd") == "abcd"
        assert formatters.decode_agent_output("test") == "test"

    def test_bytes_input(self) -> None:
        assert formatters.decode_agent_output(b"plain output") == "plain output"

    @pytest.mark.parametrize("value", [None, "", b""])
    def test_empty_values(self, value: object) -> None:
        assert formatters.decode_agent_output(value) == ""


class TestParseDfOutput:
    """``df -P -B1`` 的解析。样本是 VM 108（CentOS 7）的真实输出。"""

    REAL_OUTPUT = (
        "Filesystem                  1-blocks       Used    Available Capacity Mounted on\n"
        "devtmpfs                  1974394880          0   1974394880       0% /dev\n"
        "tmpfs                     1986646016          0   1986646016       0% /dev/shm\n"
        "tmpfs                     1986646016    8839168   1977806848       1% /run\n"
        "tmpfs                     1986646016          0   1986646016       0% /sys/fs/cgroup\n"
        "/dev/mapper/centos-root 106269499392 1464020992 104805478400       2% /\n"
        "/dev/sda1                  520785920  149880832    370905088      29% /boot\n"
        "/dev/sda2                  524001280      16384    523984896       1% /boot/efi\n"
    )

    def test_filters_pseudo_filesystems(self) -> None:
        rows = formatters.parse_df_output(self.REAL_OUTPUT)
        # tmpfs / devtmpfs 不是磁盘，混进来会把「磁盘用量」讲错
        assert [r["mountpoint"] for r in rows] == ["/", "/boot", "/boot/efi"]
        assert all("tmpfs" not in r["filesystem"] for r in rows)

    def test_reads_byte_columns(self) -> None:
        root = formatters.parse_df_output(self.REAL_OUTPUT)[0]
        assert root["filesystem"] == "/dev/mapper/centos-root"
        assert root["total_bytes"] == 106269499392
        assert root["used_bytes"] == 1464020992
        assert root["available_bytes"] == 104805478400
        assert root["percent"] == 1.4

    def test_mountpoint_with_spaces_is_kept_whole(self) -> None:
        # 挂载点可能含空格，只切前 5 段才不会被切碎
        rows = formatters.parse_df_output(
            "Filesystem 1-blocks Used Available Capacity Mounted on\n"
            "/dev/sdb1 1000 100 900 10% /mnt/my data\n"
        )
        assert rows[0]["mountpoint"] == "/mnt/my data"

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "Filesystem 1-blocks Used Available Capacity Mounted on\n",
            "not a df output at all",
            "Filesystem 1-blocks Used Available Capacity Mounted on\n"
            "tmpfs 100 1 99 1% /run\n",
        ],
    )
    def test_degenerate_inputs_yield_empty_list(self, text: str) -> None:
        assert formatters.parse_df_output(text) == []


# --------------------------------------------------------------- permissions
class TestPermissions:
    def test_admin_wildcard_grants_everything(self) -> None:
        assert security.has_permission("admin", "anything.at.all")
        assert security.has_permission("admin", "vm.delete")

    def test_operator_can_power_and_delete_own(self) -> None:
        assert security.has_permission("operator", "vm.power")
        assert security.has_permission("operator", "vm.console")
        # 可以删除，但范围由归属守卫限定在自己名下（routers/vms.py）
        assert security.has_permission("operator", "vm.delete")
        assert not security.has_permission("operator", "users.manage")

    def test_viewer_is_read_only(self) -> None:
        assert security.has_permission("viewer", "vm.view")
        assert not security.has_permission("viewer", "vm.power")
        assert not security.has_permission("viewer", "vm.console")
        assert not security.has_permission("viewer", "vm.delete")

    def test_unknown_role_falls_back_to_viewer(self) -> None:
        assert security.role_permissions("nonexistent") == security.role_permissions(
            "viewer"
        )


class TestTokens:
    def test_roundtrip(self) -> None:
        token = security.create_access_token("alice", "operator")
        payload = security.decode_token(token)
        assert payload["sub"] == "alice"
        assert payload["role"] == "operator"

    def test_tampered_token_is_rejected(self) -> None:
        from fastapi import HTTPException

        token = security.create_access_token("alice", "viewer")
        with pytest.raises(HTTPException) as exc:
            security.decode_token(token + "tampered")
        assert exc.value.status_code == 401


class TestPasswordHashing:
    def test_verify_correct_password(self) -> None:
        hashed = security.hash_password("s3cret-password")
        assert security.verify_password("s3cret-password", hashed)

    def test_reject_wrong_password(self) -> None:
        hashed = security.hash_password("s3cret-password")
        assert not security.verify_password("wrong-password", hashed)
