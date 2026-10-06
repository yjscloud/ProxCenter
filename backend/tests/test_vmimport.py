"""虚拟机导入（VMware 互操作）里最容易出错的几处。

都不需要真 PVE：喂字符串与假 client 断言即可。覆盖的是三个实测踩过的坑 ——

* VMware 导出的 OVF 是**一组**文件（``.ovf`` 描述 + ``-disk1.vmdk`` 数据）。
  只传了 .ovf 时 PVE 会 die 成一句英文原文，面板必须把它翻成「另一个文件也得传」，
  否则用户会去重传那个其实好好的 .ovf，或者干脆改用裸盘导入（参数全靠猜）。
* OVF 里的固件类型 PVE 是解析得出来的（``vmw:Config firmware=efi`` → ``bios=ovmf``）。
  面板早先把这一项固定成「用户自己猜」且默认 seabios，UEFI 装出来的系统于是被当成
  传统 BIOS 启动。
* UEFI 的 OVF 会点名要一块 EFI 变量盘（``disks.efidisk0``），以前被悄悄跳过。
* SCSI 控制器型号 PVE **给不出来**（它只把控制器解析成总线，从不读
  ``rasd:ResourceSubType``），面板却一律填 virtio-scsi-single —— 对 VMware 搬来的
  客户机那是最不可能有驱动的那个，表现是「内核起来了却找不到根盘」。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import vmtransfer  # noqa: E402


# ------------------------------------------------------------------ 测试道具
#: PVE 的 import-metadata 原始返回（UEFI 机器，PVE 9 实测的形状：disks 的值是
#: ``{size, volid}``，UEFI 时多一条 ``efidisk0 => 1`` 占位，create-args 里带 bios=ovmf）
def pve_meta() -> Dict[str, Any]:
    return {
        "source": "import/openEuler24.ovf",
        "type": "vm",
        "create-args": {"bios": "ovmf", "memory": 4096, "cores": 4, "name": "openEuler24"},
        "disks": {
            "scsi0": {"volid": "local:import/openEuler24-disk1.vmdk", "size": 1564749312},
            "efidisk0": 1,
        },
        "net": {},
        "warnings": [{"type": "efi-state-lost", "key": "bios", "value": "ovmf"}],
    }


def uefi_meta() -> Dict[str, Any]:
    """面板整理过的形状（create_args），喂给 build_import_config。"""
    meta = pve_meta()
    meta["create_args"] = meta.pop("create-args")
    return meta


def bare_meta() -> Dict[str, Any]:
    """裸磁盘镜像：没有描述文件，磁盘与源卷就是同一个东西。"""
    return {
        "source": "local:import/openEuler24-disk1.vmdk",
        "type": "bare-disk",
        "create_args": {},
        "disks": {"scsi0": {"volid": "local:import/openEuler24-disk1.vmdk", "size": 0}},
        "net": {},
        "warnings": [],
        "bare": True,
    }


class FakeClient:
    """只实现导入链路用到的方法。"""

    def __init__(
        self,
        metadata: Optional[Dict[str, Any]] = None,
        import_files: Optional[List[str]] = None,
        fail: str = "",
        storages: Optional[List[Dict[str, Any]]] = None,
        cluster_storage: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.metadata = metadata if metadata is not None else pve_meta()
        self.import_files = list(import_files or [])
        self.fail = fail
        self.storages_data = list(storages or [])
        self.cluster_storage = list(cluster_storage or [])
        self.gets: List[str] = []

    async def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        self.gets.append(path)
        if self.fail:
            raise RuntimeError(self.fail)
        if path == "/storage":
            return self.cluster_storage
        return self.metadata

    async def storages(self, node: Optional[str] = None) -> List[Dict[str, Any]]:
        return self.storages_data

    async def storage_content(
        self, node: str, storage: str, content: Optional[str] = None, vmid: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        return [{"volid": f"{storage}:import/{name}"} for name in self.import_files]


# -------------------------------------------------------------- 缺文件识别
class TestMissingOvfDisks:
    def test_disk_beside_the_ovf_is_reported(self) -> None:
        meta = {"disks": {"scsi0": {"volid": "local:import/openEuler24-disk1.vmdk"}}}
        missing = vmtransfer.missing_ovf_disks(meta, "import/openEuler24.ovf", set())
        assert missing == ["openEuler24-disk1.vmdk"]

    def test_disk_already_uploaded_is_not_reported(self) -> None:
        meta = {"disks": {"scsi0": {"volid": "local:import/openEuler24-disk1.vmdk"}}}
        assert (
            vmtransfer.missing_ovf_disks(
                meta, "import/openEuler24.ovf", {"openEuler24-disk1.vmdk"}
            )
            == []
        )

    def test_ova_internal_disk_is_not_checked(self) -> None:
        """OVA 里的盘在归档内（多一段目录），不在文件系统上 —— 不能当成缺失。"""
        meta = {"disks": {"scsi0": {"volid": "local:import/openEuler24.ova/disk-0.vmdk"}}}
        assert vmtransfer.missing_ovf_disks(meta, "import/openEuler24.ova", set()) == []

    def test_efidisk_placeholder_is_not_a_disk(self) -> None:
        meta = {
            "disks": {
                "scsi0": {"volid": "local:import/openEuler24-disk1.vmdk"},
                "efidisk0": 1,
            }
        }
        assert vmtransfer.missing_ovf_disks(
            meta, "import/openEuler24.ovf", {"openEuler24-disk1.vmdk"}
        ) == []

    def test_string_disk_form_is_understood(self) -> None:
        """早期文档里的磁盘值是字符串，不是 {volid} 对象。"""
        meta = {"disks": {"scsi0": "local:import/d1.vmdk"}}
        assert vmtransfer.missing_ovf_disks(meta, "import/x.ovf", set()) == ["d1.vmdk"]

    def test_message_names_the_file_and_the_fix(self) -> None:
        text = vmtransfer.missing_files_text(["openEuler24-disk1.vmdk"])
        assert "openEuler24-disk1.vmdk" in text
        assert ".vmdk" in text and ".ovf" in text


# -------------------------------------------------------------- 报错翻译
class TestImportErrorText:
    def test_missing_sibling_disk_is_explained(self) -> None:
        """PVE 的原话（``PVE::GuestImport::OVF`` 里的 die）。"""
        raw = (
            "error parsing openEuler24-disk1.vmdk, file seems not to exist at "
            "/var/lib/vz/import/openEuler24-disk1.vmdk"
        )
        text = vmtransfer._import_error_text(raw)
        assert "openEuler24-disk1.vmdk" in text
        # 关键：不能翻成「导入文件不存在，请重新上传」—— 那会让人去重传 .ovf
        assert "重新上传" not in text

    def test_generic_volume_missing_keeps_old_message(self) -> None:
        text = vmtransfer._import_error_text("volume 'local:import/x.ova' does not exist")
        assert "重新上传" in text

    def test_unknown_error_is_passed_through(self) -> None:
        assert "boom" in vmtransfer._import_error_text("boom")

    def test_ovf_parser_die_is_explained(self) -> None:
        text = vmtransfer._import_error_text(
            "OVF parser terminated unexpectedly trying to parse /var/lib/vz/import/x.ovf"
        )
        assert "解析" in text


# -------------------------------------------------------------- 元数据接口
class TestImportMetadata:
    def test_ovf_without_its_vmdk_is_rejected(self) -> None:
        client = FakeClient(import_files=["openEuler24.ovf"])
        with pytest.raises(vmtransfer.TransferError) as excinfo:
            asyncio.run(
                vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
            )
        assert "openEuler24-disk1.vmdk" in str(excinfo.value)

    def test_ovf_with_all_files_is_accepted(self) -> None:
        client = FakeClient(
            import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"],
        )
        meta = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert meta["bare"] is False
        assert meta["create_args"]["bios"] == "ovmf"

    def test_ova_internal_disk_needs_no_sibling(self) -> None:
        client = FakeClient(
            metadata={
                "source": "import/x.ova",
                "create-args": {},
                "disks": {"scsi0": {"volid": "local:import/x.ova/disk-0.vmdk"}},
            },
        )
        meta = asyncio.run(vmtransfer.import_metadata(client, "pve1", "local", "import/x.ova"))
        assert meta["disks"]["scsi0"]["volid"].endswith("disk-0.vmdk")

    def test_bare_disk_does_not_ask_pve(self) -> None:
        """裸磁盘镜像 PVE 解析不了，走面板合成的等价描述 —— 不该去调 import-metadata。"""
        client = FakeClient(import_files=["openEuler24-disk1.vmdk"])
        meta = asyncio.run(
            vmtransfer.import_metadata(
                client, "pve1", "local", "import/openEuler24-disk1.vmdk"
            )
        )
        assert meta["bare"] is True
        assert client.gets == []

    def test_missing_firmware_declaration_is_flagged(self) -> None:
        """PVE 只认 VMware 私有的 vmw:Config firmware：别的工具生成的 OVF 里没有它，
        于是「跟随 OVF」落到传统 BIOS —— 源机是 UEFI 时机器就停在
        「Booting from Hard Disk...」。这条提示让人知道该改哪一格。"""
        meta = pve_meta()
        meta["create-args"].pop("bios")
        client = FakeClient(
            metadata=meta, import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"]
        )
        parsed = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert any(item.get("type") == "firmware-not-declared" for item in parsed["warnings"])

    def test_declared_firmware_is_not_flagged(self) -> None:
        client = FakeClient(import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"])
        parsed = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert not any(
            item.get("type") == "firmware-not-declared" for item in parsed["warnings"]
        )

    def test_bare_disk_has_no_firmware_warning(self) -> None:
        """裸盘走的是另一条路（面板自己给提示），不该混进 OVF 的告警。"""
        client = FakeClient(import_files=["openEuler24-disk1.vmdk"])
        meta = asyncio.run(
            vmtransfer.import_metadata(
                client, "pve1", "local", "import/openEuler24-disk1.vmdk"
            )
        )
        assert meta["warnings"] == []

    def test_scsi_under_uefi_is_flagged(self) -> None:
        """UEFI + SCSI 盘：面板只能给 virtio-scsi，得先把「客户机可能没这驱动」说清。"""
        client = FakeClient(import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"])
        meta = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert any(item.get("type") == "scsi-under-ovmf" for item in meta["warnings"])

    def test_scsi_under_bios_is_not_flagged(self) -> None:
        """BIOS 下用 lsi 就够了（VMware 的盘几乎都是 LSI Logic），不用多吓一句。"""
        data = pve_meta()
        data["create-args"].pop("bios", None)
        client = FakeClient(
            metadata=data, import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"]
        )
        meta = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert not any(item.get("type") == "scsi-under-ovmf" for item in meta["warnings"])

    def test_pve_die_is_translated(self) -> None:
        client = FakeClient(
            fail="error parsing openEuler24-disk1.vmdk, file seems not to exist at /var/lib/vz/import/openEuler24-disk1.vmdk"
        )
        with pytest.raises(vmtransfer.TransferError) as excinfo:
            asyncio.run(
                vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
            )
        assert "openEuler24-disk1.vmdk" in str(excinfo.value)

    def test_unreadable_content_list_does_not_block(self) -> None:
        """列 import 目录失败（权限 / 抖动）不能把能导的也拦下 —— 交给 PVE 自己判。"""
        client = FakeClient(import_files=["openEuler24.ovf", "openEuler24-disk1.vmdk"])

        async def boom(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("storage not online")

        client.storage_content = boom  # type: ignore[method-assign]
        meta = asyncio.run(
            vmtransfer.import_metadata(client, "pve1", "local", "import/openEuler24.ovf")
        )
        assert meta["bare"] is False


# -------------------------------------------------------------- 上传文件名
class TestUploadName:
    """上传扩展名的规则是 PVE 定的（$UPLOAD_IMPORT_EXT_RE_1 = ova|qcow2|raw|vmdk）。

    以前面板自己的白名单里带着 .ovf，于是用户「按提示把 .ovf 也传上去」时，
    在 PVE 那边收到的是 ``filename: invalid filename or wrong extension`` ——
    必须在传之前就拦住并说清楚该怎么做。
    """

    def test_ovf_is_rejected_with_where_to_put_it(self) -> None:
        with pytest.raises(vmtransfer.TransferError) as excinfo:
            vmtransfer.check_upload_name("openEuler24.ovf", "/var/lib/vz/import/")
        text = str(excinfo.value)
        assert "/var/lib/vz/import/" in text  # 指出放到哪儿
        assert "scp" in text
        assert ".ova" in text  # 给出一条真能走通的路

    def test_ovf_message_without_a_known_directory(self) -> None:
        with pytest.raises(vmtransfer.TransferError) as excinfo:
            vmtransfer.check_upload_name("openEuler24.ovf")
        assert "import 目录" in str(excinfo.value)

    def test_companion_files_are_rejected_as_unneeded(self) -> None:
        for name in ("openEuler24.mf", "openEuler24-file1.nvram"):
            with pytest.raises(vmtransfer.TransferError) as excinfo:
                vmtransfer.check_upload_name(name)
            assert "不需要上传" in str(excinfo.value)

    def test_formats_pve_does_not_take(self) -> None:
        for name in ("disk.img", "disk.vhd", "disk.vhdx", "disk.qcow2.xz"):
            with pytest.raises(vmtransfer.TransferError):
                vmtransfer.check_upload_name(name)

    def test_allowed_extensions_pass_unchanged(self) -> None:
        for name in ("x.ova", "x.qcow2", "x.raw", "x.vmdk"):
            assert vmtransfer.check_upload_name(name) == name

    def test_characters_pve_accepts_but_the_panel_used_to_reject(self) -> None:
        """PVE 的安全字符类含等号；面板以前不收，等于无谓地挡人。"""
        assert vmtransfer.check_upload_name("db=1_backup-2026.vmdk") == "db=1_backup-2026.vmdk"

    def test_characters_pve_rejects(self) -> None:
        for name in ("openEuler24 disk1.vmdk", "虚拟机.vmdk", ".hidden.vmdk", "-x.vmdk"):
            with pytest.raises(vmtransfer.TransferError):
                vmtransfer.check_upload_name(name)

    def test_pve_extension_error_is_translated(self) -> None:
        raw = "filename: invalid filename or wrong extension"
        text = vmtransfer.upload_error_text(raw, "/var/lib/vz/import/")
        assert "OVA" in text and "QCOW2" in text
        assert raw in text  # 原文保留，方便对照 PVE 版本差异

    def test_unrelated_upload_error_passes_through(self) -> None:
        assert vmtransfer.upload_error_text("storage is not online") == "storage is not online"


# -------------------------------------------------------------- 存储与目录
class TestImportableStorages:
    def test_dir_storage_carries_its_host_path(self) -> None:
        client = FakeClient(
            storages=[
                {"storage": "local", "type": "dir", "content": "import,images", "active": 1},
                {"storage": "local-lvm", "type": "lvmthin", "content": "images", "active": 1},
            ],
            cluster_storage=[
                {"storage": "local", "type": "dir", "path": "/var/lib/vz/"},
            ],
        )
        items = asyncio.run(vmtransfer.importable_storages(client, "pve1"))
        # 只有支持 import 的存储会出现；块存储被跳过
        assert [item["storage"] for item in items] == ["local"]
        assert items[0]["path"] == "/var/lib/vz"  # 末尾斜杠去掉，UI 自己拼 /import/

    def test_missing_path_is_empty_not_an_error(self) -> None:
        client = FakeClient(
            storages=[{"storage": "nfs1", "type": "nfs", "content": "import", "active": 1}],
        )
        items = asyncio.run(vmtransfer.importable_storages(client, "pve1"))
        assert items[0]["path"] == ""


# -------------------------------------------------------------- 建机参数
class TestBuildImportConfig:
    def test_auto_firmware_follows_the_ovf(self) -> None:
        config = vmtransfer.build_import_config(uefi_meta(), "local-lvm", "vmbr0")
        assert config["bios"] == "ovmf"
        # PVE 点名要的 EFI 变量盘不能再被丢掉（UEFI 变量与启动项要有地方存）
        assert str(config["efidisk0"]).startswith("local-lvm:")
        assert "efitype=4m" in str(config["efidisk0"])
        # 刻意不开安全启动：搬过来的系统多半没有微软签名的引导器
        assert "pre-enrolled-keys=0" in str(config["efidisk0"])

    def test_auto_firmware_without_ovf_description_stays_bios(self) -> None:
        config = vmtransfer.build_import_config(bare_meta(), "local-lvm", "vmbr0")
        assert "bios" not in config
        assert "efidisk0" not in config

    def test_explicit_bios_overrides_the_ovf(self) -> None:
        config = vmtransfer.build_import_config(
            uefi_meta(), "local-lvm", "vmbr0", firmware="seabios"
        )
        assert "bios" not in config
        # 固件不是 OVMF 时不该硬塞 EFI 盘
        assert "efidisk0" not in config

    def test_explicit_uefi_on_a_bios_ovf(self) -> None:
        meta = uefi_meta()
        meta["create_args"] = {"memory": 2048}
        meta["disks"].pop("efidisk0")
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0", firmware="ovmf")
        assert config["bios"] == "ovmf"
        assert "efidisk0" not in config  # OVF 没要，就不擅自加

    def test_unknown_firmware_is_rejected(self) -> None:
        with pytest.raises(vmtransfer.TransferError):
            vmtransfer.build_import_config(uefi_meta(), "local-lvm", "vmbr0", firmware="coreboot")

    def test_disks_are_attached_with_import_from(self) -> None:
        """主链路：磁盘写成 ``<目标存储>:0,import-from=<源卷>,format=…``。

        盘位默认落在 IDE 上（源文件声明的是 SCSI，见 resolve_bus）—— 这里要测的是
        ``import-from`` 那一段拼对了，盘位跟着默认走即可。
        """
        config = vmtransfer.build_import_config(uefi_meta(), "local-lvm", "vmbr0")
        assert (
            config["ide0"]
            == "local-lvm:0,import-from=local:import/openEuler24-disk1.vmdk,format=qcow2"
        )
        assert config["boot"] == "order=ide0"
        # create_args 里可能夹着 OVF 的 machine 之类，但 EFI 占位不能跑到配置里去
        assert "efidisk0" in config and config["efidisk0"] != 1


class TestSourceBus:
    """总线默认沿用源文件里写的控制器。

    装系统时用的是什么，客户机 initramfs 里就只有那个驱动 —— 换成 virtio 之后
    内核起来了却看不到盘，停在等根盘。所以「跟随 OVF」必须是默认。
    """

    def test_reads_prefix_from_disk_keys(self) -> None:
        assert vmtransfer.source_bus({"ide": {"volid": "x"}}) == "ide"
        assert vmtransfer.source_bus({"sata0": {"volid": "x"}}) == "sata"
        assert vmtransfer.source_bus({"scsi1": {"volid": "x"}}) == "scsi"
        assert vmtransfer.source_bus({"nvme0": {"volid": "x"}}) == "nvme"

    def test_ignores_the_efidisk_placeholder(self) -> None:
        assert vmtransfer.source_bus({"efidisk0": 1}) == ""

    def test_empty_meta_has_no_bus(self) -> None:
        assert vmtransfer.source_bus({}) == ""

    def _meta_with(self, disks: Dict[str, Any]) -> Dict[str, Any]:
        meta = uefi_meta()
        meta["disks"] = {**disks, "efidisk0": 1}
        return meta

    def test_ide_source_stays_on_ide(self) -> None:
        meta = self._meta_with({"ide": {"volid": "local:import/openEuler24-disk1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0")
        assert config["ide0"] == (
            "local-lvm:0,import-from=local:import/openEuler24-disk1.vmdk,format=qcow2"
        )
        assert config["boot"] == "order=ide0"
        # IDE 只存在于 i440fx；OVF 里带了 machine 也得摘掉
        assert "machine" not in config

    def test_sata_source_gets_q35(self) -> None:
        meta = self._meta_with({"sata0": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0")
        assert config["sata0"].startswith("local-lvm:0,import-from=")
        assert config["machine"] == "q35"

    def test_scsi_source_defaults_to_ide(self) -> None:
        """VMware 的 OVA/OVF 声明 SCSI 时默认走 IDE。

        PVE 只解析得出总线、给不出控制器型号（LSI Logic 还是 PVSCSI），面板只能退到
        virtio-scsi —— 而搬过来的客户机 initramfs 里几乎没有这个驱动，表现是「内核
        起来了却找不到根盘」（实测：同一块盘挂回 IDE 立刻能起）。
        """
        config = vmtransfer.build_import_config(uefi_meta(), "local-lvm", "vmbr0")
        assert config["boot"] == "order=ide0"
        assert config["ide0"].startswith("local-lvm:0,import-from=")
        # IDE 只存在于 i440fx 上：OVF 里带了 machine 也得摘掉
        assert "machine" not in config

    def test_explicit_scsi_still_wins(self) -> None:
        """显式选 SCSI 时照旧 —— 否则用 LSI / PVSCSI 迁移的人没法用这个向导。"""
        config = vmtransfer.build_import_config(
            uefi_meta(), "local-lvm", "vmbr0", bus="scsi"
        )
        assert config["boot"] == "order=scsi0"

    def test_bare_disk_keeps_the_scsi_default(self) -> None:
        """裸磁盘镜像没有源文件线索（多半是 KVM 那边的 qcow2），virtio 才是常态。"""
        config = vmtransfer.build_import_config(bare_meta(), "local-lvm", "vmbr0")
        assert config["boot"] == "order=scsi0"

    def test_unsupported_nvme_source_falls_back_to_scsi(self) -> None:
        """PVE 不支持 NVMe 控制器（会给 nvme-unsupported 告警），回落成面板默认。"""
        meta = self._meta_with({"nvme0": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0")
        assert config["scsi0"].startswith("local-lvm:0,import-from=")

    def test_explicit_bus_still_wins(self) -> None:
        meta = self._meta_with({"ide": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(
            meta, "local-lvm", "vmbr0", bus="sata"
        )
        assert config["sata0"].startswith("local-lvm:0,import-from=")
        assert config["machine"] == "q35"

    def test_ide_is_an_allowed_bus(self) -> None:
        meta = self._meta_with({"ide": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0", bus="ide")
        assert config["boot"] == "order=ide0"


class TestScsihw:
    """SCSI 控制器型号：PVE 只给得出总线，型号得面板自己按固件挑最可能的。

    这里的用例都**显式**传 ``bus="scsi"``：自动默认已经把「源文件声明 SCSI」的盘改到
    IDE 上了（见 TestResolveBus），控制器型号只在这条显式路径上才有意义。

    实测踩过的那条路：VMware 导出的 OVA（盘在 SCSI 控制器上、固件 UEFI）被面板一律
    建成 virtio-scsi-single —— 客户机 initramfs 里根本没有 virtio 驱动，于是「内核
    起来了却找不到盘」，停在 dracut 的等根盘上（同一个盘挂回 IDE 就起来了）。
    """

    def _meta(self, disks: Dict[str, Any], bios: str = "") -> Dict[str, Any]:
        meta = uefi_meta()
        meta["disks"] = {**disks, "efidisk0": 1}
        if bios:
            meta["create_args"]["bios"] = bios
        else:
            meta["create_args"].pop("bios", None)
        return meta

    def test_bios_scsi_source_gets_lsi(self) -> None:
        """BIOS 下用 lsi：VMware 的 SCSI 盘几乎都是 LSI Logic，PVE 建机默认也是它。"""
        meta = self._meta({"scsi0": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0", bus="scsi")
        assert config["scsihw"] == "lsi"
        assert "bios" not in config

    def test_uefi_scsi_source_avoids_lsi(self) -> None:
        """UEFI 下 lsi 引导不了（PVE 会发 ovmf-with-lsi-unsupported），只能退到 virtio。"""
        meta = self._meta({"scsi0": {"volid": "local:import/d1.vmdk"}}, bios="ovmf")
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0", bus="scsi")
        assert config["bios"] == "ovmf"
        assert config["scsihw"] == "virtio-scsi-single"

    def test_explicit_controller_wins(self) -> None:
        meta = self._meta({"scsi0": {"volid": "local:import/d1.vmdk"}}, bios="ovmf")
        config = vmtransfer.build_import_config(
            meta, "local-lvm", "vmbr0", bus="scsi", scsihw="pvscsi"
        )
        assert config["scsihw"] == "pvscsi"

    def test_unknown_controller_is_rejected(self) -> None:
        meta = self._meta({"scsi0": {"volid": "local:import/d1.vmdk"}})
        with pytest.raises(vmtransfer.TransferError):
            vmtransfer.build_import_config(
                meta, "local-lvm", "vmbr0", bus="scsi", scsihw="mpt3sas"
            )

    def test_ide_source_keeps_the_panel_default(self) -> None:
        """盘不在 SCSI 上时这个控制器与它无关，别跟着乱动。"""
        meta = self._meta({"ide": {"volid": "local:import/d1.vmdk"}})
        config = vmtransfer.build_import_config(meta, "local-lvm", "vmbr0")
        assert config["scsihw"] == "virtio-scsi-single"

    def test_bare_disk_keeps_the_panel_default(self) -> None:
        """裸盘没有源文件线索（多半是 KVM 那边的 qcow2），virtio 才是对的。"""
        config = vmtransfer.build_import_config(bare_meta(), "local-lvm", "vmbr0")
        assert config["scsihw"] == "virtio-scsi-single"


class TestResolveBus:
    """``auto`` 总线的解析规则。

    前端向导显示的默认值走同一套规则（见 VmImportWizard 的 inspect）：两边不一致时
    界面会写着「跟随 OVF」而实际建成 IDE，那种不一致正是让人不敢相信这个向导的原因。
    """

    def test_explicit_value_is_returned_as_is(self) -> None:
        assert vmtransfer.resolve_bus("virtio", {"scsi0": 1}, False) == "virtio"
        # 非法值原样返回，交给调用方报错：这里静默改成默认值，用户就永远改不对了
        assert vmtransfer.resolve_bus("usb", {"scsi0": 1}, False) == "usb"

    def test_appliance_scsi_becomes_ide(self) -> None:
        """VMware 的 OVA/OVF：声明了 SCSI 却给不出型号，virtio-scsi 几乎必然没驱动。"""
        assert vmtransfer.resolve_bus("", {"scsi0": {"volid": "x"}}, False) == "ide"
        assert vmtransfer.resolve_bus("auto", {"scsi1": {"volid": "x"}}, False) == "ide"

    def test_declared_ide_or_sata_is_kept(self) -> None:
        """源文件写明 IDE / SATA 时照它来：那种客户机里有 ata_piix / ahci。"""
        assert vmtransfer.resolve_bus("auto", {"ide": {"volid": "x"}}, False) == "ide"
        assert vmtransfer.resolve_bus("auto", {"sata0": {"volid": "x"}}, False) == "sata"

    def test_bare_disk_has_no_source_hint(self) -> None:
        assert vmtransfer.resolve_bus("auto", {"scsi0": {"volid": "x"}}, True) == "scsi"

    def test_unsupported_nvme_falls_back_to_scsi(self) -> None:
        assert vmtransfer.resolve_bus("auto", {"nvme0": {"volid": "x"}}, False) == "scsi"
