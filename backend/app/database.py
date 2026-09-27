"""统一数据库访问层（MySQL）。

面板的数据访问集中在 store / alerting / ownership / certs 四个模块，它们统一通过
本模块取连接，各自只写一种 SQL 方言：

* **占位符**：业务代码统一写 ``?``，这里翻成 PyMySQL / aiomysql 的 ``%s``；
* **连接**：aiomysql 连接池，进程退出时用 :func:`close_pool` 释放；
* **行对象**：统一返回 :class:`Row`，``row["列名"]`` / ``row[0]`` / ``row.get()`` /
  ``dict(row)`` 都支持；
* **零星方言差异**：upsert、取列信息、同步读 settings 这类由本模块的辅助函数屏蔽。

业务模块的用法：

    async with database.connect() as db:
        cur = await db.execute("SELECT ... WHERE a = ?", (1,))
        row = await cur.fetchone()
        await db.commit()
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Iterable, List, Optional, Sequence, Set, Tuple

import aiomysql
import pymysql

from .config import settings

logger = logging.getLogger(__name__)

# settings 表里的 `key` 是 MySQL 保留字，统一加反引号
SETTINGS_TABLE = "settings"

_mysql_pool: Any = None


# --------------------------------------------------------------------- 占位符
def translate(sql: str, has_params: bool = False) -> str:
    """把业务 SQL 里的 ``?`` 占位符翻成 MySQL 的 ``%s``。

    只做两件事，且都避开字符串/标识符字面量：

    * ``?`` → ``%s``；
    * 带参数时把 ``%`` 转义成 ``%%`` —— PyMySQL 会对整条语句做格式化，LIKE 里的
      通配符不转义就会被当成格式符。
    """
    if "?" not in sql and not (has_params and "%" in sql):
        return sql

    out: List[str] = []
    quote: Optional[str] = None
    i = 0
    length = len(sql)
    while i < length:
        ch = sql[i]
        if quote:
            # 处理 SQL 里的 '' 转义：跳过成对引号
            if ch == quote:
                if i + 1 < length and sql[i + 1] == quote:
                    out.append(ch * 2)
                    i += 2
                    continue
                quote = None
            out.append(ch)
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "?":
            out.append("%s")
            i += 1
            continue
        if ch == "%" and has_params:
            out.append("%%")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def upsert_sql(
    table: str,
    columns: Sequence[str],
    conflict: Sequence[str],
    updates: Optional[Sequence[str]] = None,
) -> str:
    """生成 upsert 语句（MySQL ``ON DUPLICATE KEY UPDATE``）。

    标识符统一加反引号：``settings.key`` 是 MySQL 保留字，不加反引号直接语法错误。
    """
    cols = list(columns)
    touched = list(updates) if updates is not None else [c for c in cols if c not in conflict]
    col_list = ", ".join(f"`{c}`" for c in cols)
    marks = ", ".join("?" for _ in cols)
    sets = ", ".join(f"`{c}`=VALUES(`{c}`)" for c in touched)
    return (
        f"INSERT INTO {table} ({col_list}) VALUES ({marks}) "
        f"ON DUPLICATE KEY UPDATE {sets}"
    )


# --------------------------------------------------------------------- 行对象
class Row:
    """只读行对象：同时支持列名与下标访问。"""

    __slots__ = ("_keys", "_values")

    def __init__(self, keys: Sequence[str], values: Sequence[Any]) -> None:
        self._keys = list(keys)
        self._values = list(values)

    def keys(self) -> List[str]:
        return list(self._keys)

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, (int, slice)):
            return self._values[key]
        try:
            return self._values[self._keys.index(key)]
        except ValueError as exc:
            raise KeyError(key) from exc

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self[key]
        except (KeyError, IndexError):
            return default

    def __iter__(self):
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __contains__(self, key: object) -> bool:
        return key in self._keys

    def __repr__(self) -> str:
        return f"Row({dict(zip(self._keys, self._values))!r})"


class _Cursor:
    """游标包装：把驱动返回的原始行包装成 :class:`Row`。"""

    def __init__(self, raw: Any) -> None:
        self._raw = raw

    @property
    def lastrowid(self) -> Optional[int]:
        return getattr(self._raw, "lastrowid", None)

    @property
    def rowcount(self) -> int:
        value = getattr(self._raw, "rowcount", -1)
        return -1 if value is None else int(value)

    def _wrap(self, raw_row: Any) -> Row:
        description = getattr(self._raw, "description", None) or []
        keys = [str(col[0]) for col in description]
        if isinstance(raw_row, dict):  # 万一驱动配了 DictCursor
            keys = keys or list(raw_row.keys())
            return Row(keys, [raw_row.get(k) for k in keys])
        return Row(keys, list(raw_row))

    async def fetchone(self) -> Optional[Row]:
        row = await self._raw.fetchone()
        return None if row is None else self._wrap(row)

    async def fetchall(self) -> List[Row]:
        rows = await self._raw.fetchall()
        return [self._wrap(r) for r in (rows or [])]

    async def close(self) -> None:
        result = self._raw.close()
        if hasattr(result, "__await__"):
            await result


class _Connection:
    """业务侧看到的连接：execute / executescript / commit / close。

    连接来自 aiomysql 连接池，``close()`` 只负责收掉本连接上开过的游标，
    真正的借还由 :func:`connect` 处理。
    """

    def __init__(self, raw: Any) -> None:
        self._raw = raw
        # aiomysql 的游标需要显式关闭，借还连接时统一收尾
        self._cursors: List[Any] = []

    async def _execute_raw(self, statement: str, params: Optional[Tuple[Any, ...]]) -> Any:
        cursor = await self._raw.cursor()
        self._cursors.append(cursor)
        if params is None:
            await cursor.execute(statement)
        else:
            await cursor.execute(statement, params)
        return cursor

    async def execute(self, sql: str, parameters: Optional[Iterable[Any]] = None) -> _Cursor:
        params = None if parameters is None else tuple(parameters)
        statement = translate(sql, has_params=params is not None)
        return _Cursor(await self._execute_raw(statement, params))

    async def executescript(self, script: str) -> None:
        """执行多语句脚本（建表用）。MySQL 没有 executescript，按分号拆开逐条执行。"""
        for statement in split_statements(script):
            await self._execute_raw(statement, None)

    async def commit(self) -> None:
        await self._raw.commit()

    async def rollback(self) -> None:
        await self._raw.rollback()

    async def close(self) -> None:
        for cursor in self._cursors:
            try:
                await cursor.close()
            except Exception:  # noqa: BLE001 - 游标关闭失败不应影响主流程
                logger.debug("关闭游标失败", exc_info=True)
        self._cursors = []

    async def __aenter__(self) -> "_Connection":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


def split_statements(script: str) -> List[str]:
    """按分号拆分 SQL 脚本，跳过字符串字面量里的分号。"""
    statements: List[str] = []
    buffer: List[str] = []
    quote: Optional[str] = None
    i = 0
    length = len(script)
    while i < length:
        ch = script[i]
        if quote:
            buffer.append(ch)
            if ch == quote:
                if i + 1 < length and script[i + 1] == quote:
                    buffer.append(script[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            buffer.append(ch)
            i += 1
            continue
        if ch == ";":
            text = "".join(buffer).strip()
            if text:
                statements.append(text)
            buffer = []
            i += 1
            continue
        buffer.append(ch)
        i += 1
    tail = "".join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements


# --------------------------------------------------------------------- 连接池
async def _get_mysql_pool() -> Any:
    global _mysql_pool
    if _mysql_pool is None:
        if not settings.db_name:
            raise RuntimeError("数据库未配置：DB_NAME 为空")
        _mysql_pool = await aiomysql.create_pool(
            host=settings.db_host,
            port=int(settings.db_port),
            user=settings.db_user,
            password=settings.db_password,
            db=settings.db_name,
            charset="utf8mb4",
            autocommit=False,
            maxsize=max(2, int(settings.db_pool_size)),
        )
        logger.info("MySQL 连接池已建立：%s", describe())
    return _mysql_pool


async def close_pool() -> None:
    """进程退出时释放连接池（在 FastAPI lifespan 里调用）。"""
    global _mysql_pool
    if _mysql_pool is not None:
        _mysql_pool.close()
        await _mysql_pool.wait_closed()
        _mysql_pool = None


@asynccontextmanager
async def connect() -> AsyncIterator[_Connection]:
    """从连接池借一条连接，用完归还。"""
    pool = await _get_mysql_pool()
    raw = await pool.acquire()
    conn = _Connection(raw)
    try:
        yield conn
    except BaseException:
        try:
            await conn.rollback()
        except Exception:  # noqa: BLE001 - 回滚失败不掩盖原异常
            logger.debug("MySQL 回滚失败", exc_info=True)
        raise
    finally:
        await conn.close()
        # 关键：连接归还池前必须结束事务。autocommit=False 下，只读查询
        # （如 store.get_setting）会开启 REPEATABLE READ 事务但不提交；若直接
        # 归还，残留旧快照会被下一个借用者复用，导致刚写入的数据读不回
        # （表现为规则创建成功但列表读回旧值/404、配置未随规则更新）。
        # 对已提交的写路径，回滚是 no-op，仅清理残留的只读事务。
        try:
            await raw.rollback()
        except Exception:  # noqa: BLE001
            logger.debug("MySQL 归还前回滚失败", exc_info=True)
        pool.release(raw)


# ----------------------------------------------------------------- 方言辅助
async def table_columns(conn: _Connection, table: str) -> Set[str]:
    """表已有的列名集合（用于旧库补列的兼容判断）。"""
    cursor = await conn.execute(
        "SELECT COLUMN_NAME FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = ?",
        (table,),
    )
    rows = await cursor.fetchall()
    return {str(row["COLUMN_NAME"]) for row in rows}


def read_setting_sync(key: str) -> Optional[str]:
    """同步读取一个 setting。

    ``pve._load_connection`` 在同步代码路径上取连接配置，而 aiomysql 是纯异步的，
    只能另开一条同步连接（pymysql）来读。
    """
    conn = pymysql.connect(
        host=settings.db_host,
        port=int(settings.db_port),
        user=settings.db_user,
        password=settings.db_password,
        database=settings.db_name,
        charset="utf8mb4",
        connect_timeout=5,
        read_timeout=5,
        write_timeout=5,
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                f"SELECT `value` FROM {SETTINGS_TABLE} WHERE `key` = %s", (key,)
            )
            row = cursor.fetchone()
    finally:
        conn.close()
    return None if not row else row[0]


def describe() -> str:
    """给日志用的一句话描述当前数据库。"""
    return f"MySQL {settings.db_host}:{settings.db_port}/{settings.db_name}"
