"""账号有效期判定的单元测试（``app/userexpiry.py``）。

只测纯函数：提醒档位、过期判定、归属 ref 解析。真正的「关机 + 冻结」要连
PVE 与数据库，属于集成测试，不在这里搭环境。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import security, userexpiry  # noqa: E402

DAY = 86_400


def test_reminder_stage_uses_the_tightest_threshold() -> None:
    now = 1_700_000_000
    assert userexpiry.reminder_stage(now + 10 * DAY, now) == 0
    assert userexpiry.reminder_stage(now + 7 * DAY, now) == 7
    # 6.9 天：已经进入「7 天以内」，但还没到 3 天档
    assert userexpiry.reminder_stage(now + int(6.9 * DAY), now) == 7
    assert userexpiry.reminder_stage(now + 3 * DAY, now) == 3
    assert userexpiry.reminder_stage(now + int(2.5 * DAY), now) == 3
    assert userexpiry.reminder_stage(now + DAY, now) == 1
    assert userexpiry.reminder_stage(now + 60, now) == 1


def test_reminder_stage_none_for_no_expiry_and_expired() -> None:
    now = 1_700_000_000
    assert userexpiry.reminder_stage(0, now) == 0
    assert userexpiry.reminder_stage(now - 1, now) == 0


def test_account_expires_at_tolerates_bad_values() -> None:
    assert userexpiry.account_expires_at({}) == 0
    assert userexpiry.account_expires_at({"expires_at": None}) == 0
    assert userexpiry.account_expires_at({"expires_at": "not-a-number"}) == 0
    assert userexpiry.account_expires_at({"expires_at": -5}) == 0
    assert userexpiry.account_expires_at({"expires_at": 123.5}) == 123.5


def test_is_account_expired() -> None:
    now = time.time()
    assert security.is_account_expired({}, now) is False
    assert security.is_account_expired({"expires_at": 0}, now) is False
    assert security.is_account_expired({"expires_at": now + 60}, now) is False
    assert security.is_account_expired({"expires_at": now - 1}, now) is True


def test_split_ref() -> None:
    assert userexpiry._split_ref("conn1:pve1:101") == ("conn1", "pve1", 101)
    # 旧记录没有连接 id（用 "-" 占位）
    assert userexpiry._split_ref("-:pve1:101") == ("-", "pve1", 101)
    assert userexpiry._split_ref("pve1:101") is None
    assert userexpiry._split_ref("conn1:pve1:not-a-number") is None
    assert userexpiry._split_ref("") is None
