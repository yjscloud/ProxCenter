"""信任设备（登录两步验证的「7 天内免二次校验」）：模块层行为与安全边界。

驱动方式与 ``test_apitokens`` 一致，分两层：

* **模块层**用 ``asyncio.run`` 直接调 :mod:`app.trusteddevices`，配 ``db`` 夹具
  （只建表、不启动 app）。**不能**借 ``api`` 夹具 —— TestClient 的全局连接池绑在
  它自己的事件循环上，模块层再新建一个循环去碰同一个池会互相踩。
* **接口层**（登录跳过第二步、换密码 / 关 2FA 整批作废）用 ``api`` 夹具，
  放在 ``test_auth_security.py::TestTrustedDevice`` 里。

这一组存在的意义是几条**错了就等于开后门**的性质：

* 客户端 cookie 自己说了不算，判定只认服务端那一行；
* 信任记录绑用户名 —— 别人的 cookie 不能替别人跳过第二因子；
* 过期即失效，且过期行会被清理掉；
* 换凭据（改密码 / 退出所有设备 / 开关 2FA）必须整批作废。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, trusteddevices  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401


# ------------------------------------------------------------------ 测试工具
async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池（它绑在 asyncio.run 新建的循环上）。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


def _exec(sql: str, params: Optional[tuple] = None) -> List[Any]:
    """同步执行一条 SQL（conftest 的 connect 是 autocommit）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            if cursor.description:
                return list(cursor.fetchall())
            return []
    finally:
        conn.close()


@pytest.fixture()
def db(clean_mysql_db):
    """只建 ``trusted_devices`` 这张表，不启动 app。"""
    _run(trusteddevices.init_table())
    yield


# ------------------------------------------------------------------ 签发与校验
class TestIssueAndVerify:
    def test_remember_then_verify(self, db) -> None:
        plain, expires_at = _run(
            trusteddevices.remember("admin", ip="10.0.0.1", user_agent="curl/8")
        )
        # 明文只回一次、且不落库
        assert plain and len(plain) >= 32
        stored = _exec("SELECT token_hash FROM trusted_devices")[0][0]
        assert stored != plain
        assert len(stored) == 64  # SHA-256 十六进制

        assert _run(trusteddevices.is_trusted(plain, "admin")) is True
        # 到期时间确实按 7 天算
        assert 6.9 < (expires_at - time.time()) / 86_400 < 7.1

    def test_unknown_or_empty_token_is_not_trusted(self, db) -> None:
        _run(trusteddevices.remember("admin"))
        # 从没签发过的口令、以及「浏览器没带 cookie」的两种情况都必须拒绝
        assert _run(trusteddevices.is_trusted("never-issued", "admin")) is False
        assert _run(trusteddevices.is_trusted("", "admin")) is False
        assert _run(trusteddevices.is_trusted(None, "admin")) is False

    def test_is_trusted_requires_the_same_username(self, db) -> None:
        """这条 SQL 条件就是「别人的 cookie 能不能替别人跳过第二因子」的全部防线。"""
        plain, _ = _run(trusteddevices.remember("admin"))
        assert _run(trusteddevices.is_trusted(plain, "admin")) is True
        assert _run(trusteddevices.is_trusted(plain, "someone-else")) is False

    def test_expired_record_is_rejected_without_deleting_it(self, db) -> None:
        """过期就判定为不可信；删不删是清理作业的事，两件事分开。"""
        plain, _ = _run(trusteddevices.remember("admin"))
        _exec("UPDATE trusted_devices SET expires_at = %s", (time.time() - 1,))
        assert _run(trusteddevices.is_trusted(plain, "admin")) is False
        # 判定不该顺手把行删掉（否则「为什么这台设备又要求验证了」就查不出痕迹）
        assert _exec("SELECT COUNT(*) FROM trusted_devices")[0][0] == 1

    def test_zero_days_falls_back_to_the_default(self, db) -> None:
        """``days<=0`` 是调用方算错了参数，不该静默落成一条立刻过期的记录。"""
        _, expires_at = _run(trusteddevices.remember("admin", days=0))
        assert expires_at - time.time() > 6 * 86_400


# ------------------------------------------------------------------ 作废与清理
class TestForgetAndPurge:
    def test_forget_all_only_touches_that_user(self, db) -> None:
        _run(trusteddevices.remember("admin"))
        _run(trusteddevices.remember("admin"))
        _run(trusteddevices.remember("other"))

        assert _run(trusteddevices.forget_all("admin")) == 2
        assert _exec("SELECT username FROM trusted_devices") == [("other",)]
        # 空跑一次返回 0，而不是报错
        assert _run(trusteddevices.forget_all("admin")) == 0

    def test_list_for_hides_expired_rows(self, db) -> None:
        _run(trusteddevices.remember("admin", ip="10.0.0.9"))
        _run(trusteddevices.remember("admin", ip="10.0.0.10"))
        _exec(
            "UPDATE trusted_devices SET expires_at = %s WHERE ip = %s",
            (time.time() - 1, "10.0.0.10"),
        )
        items = _run(trusteddevices.list_for("admin"))
        assert [item["ip"] for item in items] == ["10.0.0.9"]
        # 列表里不该出现任何口令字段
        assert all("token_hash" not in item for item in items)

    def test_purge_expired_removes_only_expired(self, db) -> None:
        _run(trusteddevices.remember("admin", ip="fresh"))
        _run(trusteddevices.remember("admin", ip="stale"))
        _exec(
            "UPDATE trusted_devices SET expires_at = %s WHERE ip = %s",
            (time.time() - 60, "stale"),
        )

        assert _run(trusteddevices.purge_expired()) == 1
        assert _exec("SELECT ip FROM trusted_devices") == [("fresh",)]
        # 再跑一次没有可删的
        assert _run(trusteddevices.purge_expired()) == 0
