"""镜像「扩展名 vs 真实容器格式」的判定。

起因是一个真机故障：从
``https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img``
建出来的模板克隆后开不了机，控制台是 SeaBIOS 的
``Boot failed: not a bootable disk``。

那个文件其实是 qcow2（magic ``QFI\\xfb``，3.5 GiB 虚拟 / 248 MiB 实际），
而 PVE 的 ``file_size_info`` 只对 ``.qcow2/.qed/.raw/.vmdk/.vdi/.vpc`` 跑
``qemu-img info``，``.img`` 一律当裸盘整块复制 —— 系统盘第一扇区于是没有
``55 aa`` 引导签名。SeaBIOS 只看这一个签名，所以故障表现为「盘读得到、
但不是可引导盘」，而 PVE 侧每一步任务都是成功的。

两个判定点：上传时按 magic 认容器格式（面板唯一拿得到字节的地方），
以及存量文件按扩展名给风险提示（字节拿不到，只能提示）。
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

import pytest
from fastapi import HTTPException

from app import vmconfig  # noqa: E402
from app.routers import storages as storages_router  # noqa: E402


class _FakeUpload:
    """只需要 ``file`` 这个可 seek 的流（真实类型是 UploadFile.file）。"""

    def __init__(self, head: bytes, pad: bytes = b"\x00" * 1024) -> None:
        self.filename = "x"
        self.file = io.BytesIO(head + pad)


class TestProbeImageFormat:
    def test_qcow2_magic_is_recognised(self) -> None:
        assert storages_router._probe_image_format(_FakeUpload(b"QFI\xfb\x00\x00\x00\x03")) == "qcow2"

    def test_vmdk_magic_is_recognised(self) -> None:
        assert storages_router._probe_image_format(_FakeUpload(b"KDMV")) == "vmdk"

    def test_raw_or_iso_is_not_recognised(self) -> None:
        # 裸盘与 ISO9660 都没有容器 magic：照旧上传，PVE 按裸盘处理是对的
        assert storages_router._probe_image_format(_FakeUpload(b"\x00" * 16)) == ""
        assert storages_router._probe_image_format(_FakeUpload(b"\x00CD001")) == ""

    def test_stream_is_rewound_after_probing(self) -> None:
        """探测不能吃掉字节：指针还原不了就会少传几个字节，PVE 拿到坏文件。"""
        upload = _FakeUpload(b"QFI\xfb", pad=b"")
        storages_router._probe_image_format(upload)
        assert upload.file.tell() == 0
        assert upload.file.read() == b"QFI\xfb"


class TestImageFormatMayBeMisread:
    def test_pve_does_not_parse_the_img_extension(self) -> None:
        assert vmconfig.image_format_may_be_misread(
            "local:iso/ubuntu-24.04-minimal-cloudimg-amd64.img"
        )

    def test_parsed_extensions_are_fine(self) -> None:
        for volid in (
            "local:iso/ubuntu-24.04.qcow2",
            "local:iso/debian-12.raw",
            "local:import/win.vmdk",
            "local:import/disk.vpc",
        ):
            assert vmconfig.image_format_may_be_misread(volid) is False

    def test_empty_volid_is_not_flagged(self) -> None:
        assert vmconfig.image_format_may_be_misread("") is False
        assert vmconfig.image_format_may_be_misread(None) is False


class TestDownloadFilename:
    """``/storages/download-url`` 按内容类型校正文件名。

    ``import`` 下 ``.img`` 改成 ``.qcow2`` 是这条链路上最关键的一步：PVE 只对
    白名单后缀跑 ``qemu-img info``，``.img`` 会被当裸盘整块复制。改后缀对真 raw
    的镜像无害（PVE 解析内容后会识别成 raw），对 qcow2 则是救命的。
    """

    def test_img_in_import_becomes_qcow2(self) -> None:
        assert (
            storages_router._download_filename(
                "/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img",
                "",
                "import",
            )
            == "ubuntu-24.04-minimal-cloudimg-amd64.qcow2"
        )

    def test_qcow2_and_raw_pass_through(self) -> None:
        for name in ("ubuntu.qcow2", "debian.raw", "win.vmdk", "app.ova"):
            assert storages_router._download_filename("/x/" + name, "", "import") == name

    def test_compressed_payload_is_rejected(self) -> None:
        with pytest.raises(HTTPException) as exc:
            storages_router._download_filename("/x/noble.img.gz", "", "import")
        assert exc.value.status_code == 400
        assert "压缩" in str(exc.value.detail)

    def test_disk_image_is_refused_in_iso_content(self) -> None:
        """iso 目录里的磁盘镜像正是那个坑，必须挡在下载之前。"""
        with pytest.raises(HTTPException) as exc:
            storages_router._download_filename("/x/ubuntu.img", "", "iso")
        assert exc.value.status_code == 400

    def test_iso_passes_for_iso_content(self) -> None:
        assert storages_router._download_filename("/x/debian-12-netinst.iso", "", "iso") == "debian-12-netinst.iso"

    def test_explicit_filename_wins(self) -> None:
        assert (
            storages_router._download_filename("/x/whatever.bin", "ubuntu.qcow2", "import")
            == "ubuntu.qcow2"
        )

    def test_missing_name_is_rejected(self) -> None:
        with pytest.raises(HTTPException) as exc:
            storages_router._download_filename("/", "", "import")
        assert exc.value.status_code == 400
