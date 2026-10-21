"""面板准入白名单的单元测试（``app/accesscontrol.py``）。

重点：
* 未配置时完全放行（升级兼容）；
* 配置后只放行名单内来源，回环例外；
* 写错的 CIDR 不会悄悄放开访问（失败关闭）；
* IPv4-mapped IPv6 能正确归类。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import accesscontrol  # noqa: E402
from app.config import settings  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    """每个用例后清掉解析缓存，避免配置串串味。"""
    yield
    accesscontrol._networks.cache_clear()


def test_disabled_allowlist_allows_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "panel_allow_cidrs", "")
    assert accesscontrol.configured() is False
    assert accesscontrol.is_allowed("198.51.100.7") is True
    assert accesscontrol.is_allowed("") is True


def test_allowlist_allows_configured_networks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings, "panel_allow_cidrs", "203.0.113.0/24, 10.0.0.5/24"
    )
    accesscontrol._networks.cache_clear()
    assert accesscontrol.configured() is True
    assert accesscontrol.is_allowed("203.0.113.9") is True
    # strict=False：10.0.0.5/24 按 10.0.0.0/24 处理
    assert accesscontrol.is_allowed("10.0.0.200") is True
    assert accesscontrol.is_allowed("198.51.100.1") is False


def test_allowlist_always_allows_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "panel_allow_cidrs", "203.0.113.0/24")
    accesscontrol._networks.cache_clear()
    # 反代 / 健康检查从回环来，一刀切会把它们一起挡掉
    assert accesscontrol.is_allowed("127.0.0.1") is True
    assert accesscontrol.is_allowed("127.0.0.2") is True
    assert accesscontrol.is_allowed("::1") is True


def test_ipv4_mapped_ipv6_is_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "panel_allow_cidrs", "203.0.113.0/24")
    accesscontrol._networks.cache_clear()
    assert accesscontrol.is_allowed("::ffff:203.0.113.9") is True
    assert accesscontrol.is_allowed("::ffff:198.51.100.9") is False


def test_invalid_entries_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings, "panel_allow_cidrs", "not-an-ip, 192.168.1.0/24"
    )
    accesscontrol._networks.cache_clear()
    assert accesscontrol.has_invalid_entries() is True
    # 合法项仍生效
    assert accesscontrol.is_allowed("192.168.1.8") is True
    # 非法项不会退化成「允许所有人」
    assert accesscontrol.is_allowed("8.8.8.8") is False


def test_normalize_ip_rejects_garbage() -> None:
    assert accesscontrol.normalize_ip("") == ""
    assert accesscontrol.normalize_ip("not-an-ip") == ""
    assert accesscontrol.normalize_ip("[::1]") == "::1"
