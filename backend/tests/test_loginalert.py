"""新 IP 登录告警的去重键（``app/loginalert.py``）。

IPv6 隐私地址会频繁轮换，按 /64 归一是为了「换地址不报、换网络才报」。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import loginalert  # noqa: E402


def test_alert_key_keeps_ipv4() -> None:
    assert loginalert.alert_key("203.0.113.9") == "203.0.113.9"


def test_alert_key_folds_ipv4_mapped() -> None:
    assert loginalert.alert_key("::ffff:203.0.113.9") == "203.0.113.9"


def test_alert_key_groups_ipv6_by_64() -> None:
    first = loginalert.alert_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    second = loginalert.alert_key("2001:db8:1:2:1111:2222:3333:4444")
    other = loginalert.alert_key("2001:db8:1:3::1")
    assert first == second == "2001:db8:1:2::/64"
    assert other != first


def test_alert_key_empty_for_garbage() -> None:
    assert loginalert.alert_key("") == ""
    assert loginalert.alert_key("not-an-ip") == ""
