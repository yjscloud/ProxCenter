"""store 层 PVE 凭据的落库加密。

这组用例直连 MySQL，验证三件事：

1. 写进去的是密文（``settings`` 表被拖走也拿不到可用凭据）；
2. 读出来的是明文（业务层无感，签名 / 控制台登录照常工作）；
3. 启动时把升级前明文落库的存量数据补成密文，且迁移幂等。

``token_secret`` 等同于以面板身份操作整个 Proxmox 集群的权限，``console_password``
能直接登进虚拟机控制台 —— 这两个字段明文落库是最高危的泄露面。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, store  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402

PLAIN_SECRET = "0f9e8d7c-plain-pve-token-secret"
PLAIN_CONSOLE = "plain-console-password"


async def _shutdown_pool(coro):
    """跑完用例就关掉连接池：它绑在 asyncio.run 的循环上，循环一关残留的
    连接任务会在 GC 时炸「Event loop is closed」，还会污染下一个用例的池。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


def _raw_setting(key: str) -> str:
    """同步读一条 settings 原文，绕过 store 的解密。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT `value` FROM settings WHERE `key` = %s", (key,))
            row = cursor.fetchone()
    finally:
        conn.close()
    return "" if not row else row[0]


def _assert_ciphertext(raw: str, *plaintexts: str) -> None:
    for plain in plaintexts:
        assert plain not in raw, f"明文 {plain} 泄露到了 settings 表"
    assert "enc:v1:" in raw, "密钥字段没有被加密"


class TestConnectionSecretsAtRest:
    def test_saved_connections_are_stored_encrypted(self, clean_mysql_db) -> None:
        profile: Dict[str, Any] = {
            "id": "c1",
            "name": "pve1",
            "host": "10.0.0.2",
            "port": 8006,
            "token_id": "a@pve!t",
            "token_secret": PLAIN_SECRET,
            "console_user": "root@pam",
            "console_password": PLAIN_CONSOLE,
        }

        async def roundtrip() -> None:
            await store.init_db()
            await store.save_connections([profile])

        _run(roundtrip())

        _assert_ciphertext(_raw_setting(store.CONNECTIONS_KEY), PLAIN_SECRET, PLAIN_CONSOLE)
        # 非密钥字段照常明文存（host/token_id 需要被检索与展示）
        assert "10.0.0.2" in _raw_setting(store.CONNECTIONS_KEY)

        # 读取侧解密：业务层拿到的始终是明文
        conns = store.get_connections()
        assert conns[0]["token_secret"] == PLAIN_SECRET
        assert conns[0]["console_password"] == PLAIN_CONSOLE

    def test_read_rewrite_cycle_stays_encrypted(self, clean_mysql_db) -> None:
        """「读出再写回」（保存连接的常规路径）反复几轮也必须一直是密文。"""

        async def cycle() -> None:
            await store.init_db()
            await store.save_connections(
                [{"id": "c1", "host": "10.0.0.5", "token_id": "a@pve!t",
                  "token_secret": PLAIN_SECRET, "console_password": PLAIN_CONSOLE}]
            )
            for _ in range(3):
                await store.save_connections(store.get_connections())

        _run(cycle())
        _assert_ciphertext(_raw_setting(store.CONNECTIONS_KEY), PLAIN_SECRET, PLAIN_CONSOLE)
        conns = store.get_connections()
        assert conns[0]["token_secret"] == PLAIN_SECRET
        assert conns[0]["console_password"] == PLAIN_CONSOLE

    def test_startup_encrypts_legacy_plaintext(self, clean_mysql_db) -> None:
        """升级前明文落库的存量数据，要在启动（init_db）时补成密文。"""
        legacy_list = json.dumps(
            [{"id": "c1", "host": "10.0.0.3", "token_id": "a@pve!t",
              "token_secret": PLAIN_SECRET, "console_password": PLAIN_CONSOLE}],
            ensure_ascii=False,
        )
        legacy_single = json.dumps(
            {"host": "10.0.0.4", "token_id": "a@pve!t",
             "token_secret": PLAIN_SECRET, "console_password": PLAIN_CONSOLE},
            ensure_ascii=False,
        )

        async def boot() -> None:
            await store.init_db()                     # 首次启动：建表
            await store.set_setting(store.CONNECTIONS_KEY, legacy_list)
            await store.set_setting(store.CONNECTION_KEY, legacy_single)
            await store.init_db()                     # 再次启动：迁移存量明文
            migrated = await store.get_setting(store.CONNECTIONS_KEY)
            _assert_ciphertext(migrated or "", PLAIN_SECRET, PLAIN_CONSOLE)
            await store.init_db()                     # 第三次：已全是密文，不该重写
            assert await store.get_setting(store.CONNECTIONS_KEY) == migrated

        _run(boot())

        _assert_ciphertext(_raw_setting(store.CONNECTION_KEY), PLAIN_SECRET, PLAIN_CONSOLE)

        # 迁移之后照常读得到明文，旧的单连接配置也被一并照顾到
        conns: List[Dict[str, Any]] = store.get_connections()
        assert conns[0]["token_secret"] == PLAIN_SECRET
        assert conns[0]["console_password"] == PLAIN_CONSOLE
        legacy = json.loads(_raw_setting(store.CONNECTION_KEY))
        assert store._decrypt_secrets(legacy)["token_secret"] == PLAIN_SECRET

    def test_broken_ciphertext_degrades_to_unconfigured(self, clean_mysql_db) -> None:
        """密文被改坏 / 换了 secret_key 时按「未配置」处理，而不是把连接打挂。"""
        async def seed() -> None:
            await store.init_db()
            await store.save_connections(
                [{"id": "c1", "host": "10.0.0.6", "token_id": "a@pve!t",
                  "token_secret": PLAIN_SECRET}]
            )

        _run(seed())
        tampered = json.dumps([{"id": "c1", "host": "10.0.0.6",
                                "token_id": "a@pve!t",
                                "token_secret": "enc:v1:AAAA-tampered"}])
        conn = connect(settings.db_name)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE settings SET `value` = %s WHERE `key` = %s",
                    (tampered, store.CONNECTIONS_KEY),
                )
        finally:
            conn.close()

        conns = store.get_connections()
        assert conns[0]["host"] == "10.0.0.6"
        assert conns[0]["token_secret"] == ""   # 解不开 = 未配置，需重新填写
        assert store.public_connection_config(conns[0])["configured"] is False
