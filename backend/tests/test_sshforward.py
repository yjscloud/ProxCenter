"""SSH 真实来源解析（frp → haproxy → 审计）。

不需要数据库与 SSH：把「拉日志」那一步替换成固定样本，只验证解析与配对规则。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import config, sshforward  # noqa: E402

SAMPLE = (
    "188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel 1/0/5659 1813 -- 6/6/5/5/0 0/0"
)


def test_line_parser_takes_real_ip() -> None:
    match = sshforward._LINE.match(SAMPLE)
    assert match is not None
    assert match.group("ip") == "188.166.188.240"
    assert match.group("ts") == "25/Oct/2026:11:48:40"


def test_line_parser_ignores_other_frontends() -> None:
    line = SAMPLE.replace("ssh_in", "kvm_web")
    assert sshforward._LINE.match(line) is None


@pytest.fixture()
def configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(config.settings, "ssh_forward_log_host", "host-1", raising=False)
    monkeypatch.setattr(
        config.settings, "ssh_forward_proxies", "172.16.149.3", raising=False
    )
    # 每个用例重置缓存，避免相互污染
    monkeypatch.setattr(sshforward, "_cache_items", [])
    monkeypatch.setattr(sshforward, "_cache_at", 0.0)
    return monkeypatch


def test_disabled_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.settings, "ssh_forward_log_host", "", raising=False)
    monkeypatch.setattr(config.settings, "ssh_forward_proxies", "", raising=False)
    assert asyncio.run(sshforward.resolve(1000.0, "172.16.149.3")) is None


def test_non_proxy_address_returns_none(configured) -> None:
    """普通公网来源不需要还原，直接返回 None（不触发拉日志）。"""
    assert asyncio.run(sshforward.resolve(1000.0, "203.0.113.7")) is None


def test_nearest_connection_wins(configured) -> None:
    async def fake_load():
        return [(1000.0, "1.1.1.1"), (1001.5, "2.2.2.2"), (1005.0, "3.3.3.3")]

    configured.setattr(sshforward, "_load", fake_load)

    assert asyncio.run(sshforward.resolve(1001.0, "172.16.149.3")) == "2.2.2.2"
    # 同一个连接可能承载多次认证失败：复用同一个真实 IP 是正确行为
    assert asyncio.run(sshforward.resolve(1001.2, "172.16.149.3")) == "2.2.2.2"
    assert asyncio.run(sshforward.resolve(1005.0, "172.16.149.3")) == "3.3.3.3"


def test_outside_window_returns_none(configured) -> None:
    async def fake_load():
        return [(1000.0, "1.1.1.1")]

    configured.setattr(sshforward, "_load", fake_load)
    # 容差 3 秒：差 60 秒不应硬凑一个 IP 出来
    assert asyncio.run(sshforward.resolve(1060.0, "172.16.149.3")) is None


def test_empty_log_returns_none(configured) -> None:
    async def fake_load():
        return []

    configured.setattr(sshforward, "_load", fake_load)
    assert asyncio.run(sshforward.resolve(1000.0, "172.16.149.3")) is None
