"""控制台文件中转（``app/console_files.py``）的单元测试。

重点盯三件事：
* 文件名只做展示，不能带路径 / 控制字符（它会进 shell 命令与响应头）；
* token 是路径的一部分，非法 token 必须直接拒绝（防路径穿越）；
* 过期文件会被清掉，并且下载接口拿不到它。

跑法（与其它后端测试一致）：

    ../.venv/bin/python -m pytest tests/test_console_files.py -v
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.datastructures import UploadFile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import console_files  # noqa: E402


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把中转目录指到临时目录，别碰真实的 backend/data。"""
    monkeypatch.setattr(console_files, "STORE_DIR", tmp_path / "console-files")
    return tmp_path / "console-files"


def _upload(content: bytes, name: str) -> Any:
    return UploadFile(file=io.BytesIO(content), filename=name)


# ----------------------------------------------------------------- 文件名


def test_clean_filename_drops_windows_and_posix_paths() -> None:
    assert console_files.clean_filename(r"C:\fakepath\nginx.conf") == "nginx.conf"
    assert console_files.clean_filename("../../etc/passwd") == "passwd"
    assert console_files.clean_filename("a\x00b\nc.txt") == "abc.txt"


def test_clean_filename_falls_back_for_empty_names() -> None:
    assert console_files.clean_filename("") == "download.bin"
    assert console_files.clean_filename(None) == "download.bin"
    assert console_files.clean_filename("..") == "download.bin"


def test_clean_filename_keeps_leading_dots() -> None:
    # 上传 .env / .bashrc 很常见，去掉开头的点等于把文件名改错
    assert console_files.clean_filename(".env") == ".env"


def test_clean_filename_keeps_unicode_and_caps_length() -> None:
    assert console_files.clean_filename("配置 备份.tar.gz") == "配置 备份.tar.gz"
    long = "a" * 400 + ".txt"
    assert len(console_files.clean_filename(long)) <= console_files._NAME_MAX


# ----------------------------------------------------------------- 保存 / 读取


def test_save_writes_file_and_metadata(store: Path) -> None:
    async def run() -> None:
        meta = await console_files.save(_upload(b"hello", "run.sh"), "alice")
        assert meta["size"] == 5
        assert meta["name"] == "run.sh"
        assert meta["uploader"] == "alice"
        path, loaded = await console_files.load(meta["token"])
        assert path.read_bytes() == b"hello"
        assert loaded["name"] == "run.sh"
        assert console_files.file_path(meta["token"]).exists()

    asyncio.run(run())


def test_invalid_token_is_rejected(store: Path) -> None:
    console_files.STORE_DIR.mkdir(parents=True, exist_ok=True)
    assert asyncio.run(console_files.load("../../etc/passwd")) is None
    assert asyncio.run(console_files.load("0" * 31)) is None
    assert asyncio.run(console_files.revoke("not-a-token")) is False


def test_expired_file_is_removed(store: Path) -> None:
    async def run() -> None:
        meta = await console_files.save(_upload(b"x", "old.txt"), "alice")
        token = meta["token"]
        # 直接把过期时间改到过去，模拟 24 小时之后
        meta_path = console_files._meta_path(token)
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        data["expires_at"] = 0
        meta_path.write_text(json.dumps(data), encoding="utf-8")

        assert await console_files.load(token) is None
        assert not meta_path.exists()
        assert not console_files.file_path(token).exists()

    asyncio.run(run())


def test_revoke_removes_file(store: Path) -> None:
    async def run() -> None:
        meta = await console_files.save(_upload(b"x", "a.txt"), "alice")
        token = meta["token"]
        assert await console_files.revoke(token) is True
        assert await console_files.load(token) is None
        assert await console_files.revoke(token) is False

    asyncio.run(run())


def test_purge_expired_leaves_fresh_files_alone(store: Path) -> None:
    async def run() -> None:
        meta = await console_files.save(_upload(b"x", "fresh.txt"), "alice")
        assert console_files.purge_expired() == 0
        assert await console_files.load(meta["token"]) is not None

    asyncio.run(run())
