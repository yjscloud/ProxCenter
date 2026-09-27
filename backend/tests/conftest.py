"""面板测试用的 MySQL 测试库准备与清理。

面板只使用 MySQL，用例不能指向业务库，因此这里统一准备一个**独立的测试库**：

* 库名默认取 ``<DB_NAME>_test``，可用环境变量 ``TEST_DB_NAME`` 覆盖；
* 连接参数复用 ``backend/.env`` 里的 ``DB_*``（测试库与业务库同实例）；
* 账号没有建库权限时，要求测试库已由 DBA 建好，否则直接 skip（不会碰业务库）；
* 每个用例开始前 drop 掉面板的全部表，应用启动时会按建表语句重建。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pymysql
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")
# 后端拒绝用 admin123 之类弱口令创建管理员（见 store.init_db），
# 测试建号也要走强口令；用例里的登录口令统一从 settings 取。
os.environ.setdefault("ADMIN_PASSWORD", "Unit-Test-Admin-Pa55w0rd!")
# 生产 .env 多半开着 FORCE_HTTPS，而 TestClient 的请求来自 testclient（非回环）
# 且 scheme 是 http —— 不关掉的话会被中间件整体 308，用例全挂。强制跳转自身的
# 逻辑由 tests/test_security_config.py 直接驱动中间件覆盖。
os.environ["FORCE_HTTPS"] = "0"
# 二次确认（step-up）会拦下删虚拟机、建账号等写操作：端到端用例只验证业务
# 逻辑，默认关掉；它本身的实现由 tests/test_hardening.py::TestStepUp 专门覆盖。
os.environ["STEP_UP_REQUIRED"] = "0"

from app import database  # noqa: E402
from app.config import settings  # noqa: E402

# 用例直接 POST 登录，不逐张解验证码（验证码自身的用例会临时打开）
settings.login_captcha = False

# 各模块的建表语句覆盖的表
#
# rate_limits / refresh_tokens 也必须清：它们保存登录失败计数与服务端会话，
# 留着的话上一个用例的锁定与会话会串到下一个用例（表现为「第一次登录就 429」）。
TABLES = (
    "users",
    "roles",
    "audit_log",
    "settings",
    "resource_owner",
    "password_reset",
    "alert_history",
    "alert_active",
    "cert_deploy_log",
    "rate_limits",
    "refresh_tokens",
    # SSH 安全的「已知 IP」与登录历史也必须清：留着的话上一个用例登录过的 IP
    # 在下一个用例里变成「已知」，陌生 IP 告警就再也测不出来。
    "ssh_login",
    "ssh_known_ip",
    # 受管主机：不清的话上一条用例加的主机会出现在下一条用例的 fleet 汇总里。
    "ssh_hosts",
    # 主机登录审计的导入游标：不清的话上一条用例已经把游标推后了，
    # 下一条用例就会「一条都导不进来」。
    "host_audit_cursor",
    # 受保护备份登记：不清的话上一条用例登记的备份会出现在下一条用例的清单里，
    # 「删除受保护备份被拦截」这类用例就会误判。
    "protected_backups",
    # 监控历史：不清的话上一条用例插的采样点会被下一条用例的历史查询读到，
    # 「空库查历史应为空」「按归属过滤」这类断言就会误判。
    "metrics_history",
    # 站内通知：不清的话上一条用例产生的未读消息会让下一条用例的未读数断言偏大。
    "notifications",
    # 个人 API Token：不清的话上一条用例签发的令牌会出现在下一条用例的列表里，
    # 更糟的是「配额已满」「吊销后 active 归零」这类断言会跟着误判。
    "api_tokens",
    # 用户界面偏好：不清的话上一条用例存的仪表盘布局会出现在下一条用例里，
    # 「新用户默认没有任何偏好」这类断言就会误判。
    "user_prefs",
)


def connect(database_name: str | None = None):
    """连到测试实例（``database_name`` 为空时不指定库，用于建库）。"""
    return pymysql.connect(
        host=settings.db_host,
        port=int(settings.db_port),
        user=settings.db_user,
        password=settings.db_password,
        database=database_name,
        charset="utf8mb4",
        autocommit=True,
    )


def test_database_name() -> str:
    return os.environ.get("TEST_DB_NAME", "").strip() or f"{settings.db_name}_test"


def drop_all_tables() -> None:
    """清空测试库：删掉面板的所有表，让下一个用例从零开始。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            for table in TABLES:
                cursor.execute(f"DROP TABLE IF EXISTS `{table}`")
    finally:
        conn.close()
    # 限流/锁定在进程内还有一层「已知被锁」缓存，清库时一并丢掉，
    # 否则上一个用例的锁定会跟着缓存活到下一个用例。
    from app import throttle

    throttle.clear_cache()


def delete_setting_sync(key: str) -> None:
    """同步删除一条 settings（测试里模拟「配置被别的进程改掉」用）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM settings WHERE `key` = %s", (key,))
    finally:
        conn.close()


@pytest.fixture(scope="session", autouse=True)
def mysql_test_db():
    """把面板指向测试库；连不上 MySQL 时跳过所有用例。"""
    if not settings.db_name:
        pytest.skip("未配置 MySQL（DB_NAME 为空），跳过需要数据库的用例")

    try:
        conn = connect()
    except pymysql.MySQLError as exc:  # pragma: no cover - 环境问题
        pytest.skip(f"连不上 MySQL {settings.db_host}:{settings.db_port}：{exc}")

    target = test_database_name()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                f"CREATE DATABASE IF NOT EXISTS `{target}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    except pymysql.MySQLError:
        # 没有建库权限：测试库必须已经存在，下面会验证
        pass
    finally:
        conn.close()

    try:
        probe = connect(target)
        probe.close()
    except pymysql.MySQLError as exc:  # pragma: no cover - 环境问题
        pytest.skip(
            f"测试库 {target} 不可用（需要建库权限，或先手工创建）：{exc}"
        )

    settings.db_name = target
    database._mysql_pool = None
    yield target


@pytest.fixture()
def clean_mysql_db(mysql_test_db):
    """空库：删掉所有表，交给应用启动时重建。"""
    drop_all_tables()
    database._mysql_pool = None
    yield
    database._mysql_pool = None
