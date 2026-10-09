"""AI 排查助手的审计：会话与每一次工具调用。

为什么要单独落库：这是「平台代用户登录到他的服务器执行命令」，用户有权知道 AI
**到底在他机器上跑了什么**。过程不落库的话，事后无从追溯 —— 真出了分歧，两边
各执一词。

表分两张而不是一张大表：

* ``ai_sessions``   —— 一次排查一行（谁、哪台机器、哪个模型、多少 token、多久）；
* ``ai_tool_calls`` —— 一次工具调用一行（工具、参数、输出摘要、耗时、成败）。

一次排查可能调十几次工具，全塞进一行既难查也没法建索引。

留意 ``ai_tool_calls.output`` 只存**摘要**（前 2000 字符）：完整输出可能有几万
字符，而且里面常含内网信息 —— 审计要的是「执行过什么」，不是「完整转存了一遍」。
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import date, timedelta
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from . import database, hostscope

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_sessions (
    id                VARCHAR(40)  NOT NULL,
    username          VARCHAR(64)  NOT NULL DEFAULT '',
    host_id           VARCHAR(191) NOT NULL DEFAULT '',
    host_name         VARCHAR(191) NOT NULL DEFAULT '',
    mode              VARCHAR(16)  NOT NULL DEFAULT 'agent',
    conversation_id   VARCHAR(40)  NOT NULL DEFAULT '',
    status            VARCHAR(16)  NOT NULL DEFAULT 'running',
    model             VARCHAR(191) NOT NULL DEFAULT '',
    provider          VARCHAR(191) NOT NULL DEFAULT '',
    steps             INT          NOT NULL DEFAULT 0,
    tool_calls        INT          NOT NULL DEFAULT 0,
    prompt_tokens     INT          NOT NULL DEFAULT 0,
    completion_tokens INT          NOT NULL DEFAULT 0,
    total_tokens      INT          NOT NULL DEFAULT 0,
    duration_ms       INT          NOT NULL DEFAULT 0,
    error             VARCHAR(512) NOT NULL DEFAULT '',
    result            MEDIUMTEXT,
    created           BIGINT       NOT NULL DEFAULT 0,
    finished          BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ai_sessions_user (username),
    KEY idx_ai_sessions_created (created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_tool_calls (
    id         VARCHAR(40)  NOT NULL,
    session_id VARCHAR(40)  NOT NULL DEFAULT '',
    step       INT          NOT NULL DEFAULT 0,
    tool       VARCHAR(64)  NOT NULL DEFAULT '',
    args       TEXT,
    command    VARCHAR(1024) NOT NULL DEFAULT '',
    ok         TINYINT      NOT NULL DEFAULT 0,
    output     TEXT,
    elapsed_ms INT          NOT NULL DEFAULT 0,
    created    BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ai_tool_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        # 旧库补列：result 存这次排查的结论（summary + findings 的 JSON）。
        # 只存工具调用明细的话，事后回看只能看到「跑了哪些命令」，看不到
        # 「AI 当时的判断是什么」—— 恰恰是用户最想回顾的东西。
        columns = await database.table_columns(db, "ai_sessions")
        if "result" not in columns:
            await db.execute("ALTER TABLE ai_sessions ADD COLUMN result MEDIUMTEXT")
        # 会话化之后，每次「运行」要能指回它属于哪条对话线程（记录页据此归组）
        if "conversation_id" not in columns:
            await db.execute(
                "ALTER TABLE ai_sessions ADD COLUMN conversation_id VARCHAR(40)"
                " NOT NULL DEFAULT ''"
            )
        # 工具调用补列：这条调用**实际在主机上跑的完整命令**。args 只说明「选了
        # 哪个工具、填了什么参数」（unit=sshd），命令才是用户要核对的东西
        # （journalctl -u sshd -n 60 --no-pager）。存量行留空：命令没存过，
        # 事后还原不出来，编一条反而更糟。
        call_columns = await database.table_columns(db, "ai_tool_calls")
        if "command" not in call_columns:
            await db.execute(
                "ALTER TABLE ai_tool_calls ADD COLUMN command VARCHAR(1024)"
                " NOT NULL DEFAULT ''"
            )
        await db.commit()


def new_id() -> str:
    return uuid.uuid4().hex


async def open_session(
    *,
    username: str,
    host_id: str,
    host_name: str,
    provider: str,
    mode: str = "agent",
    conversation_id: str = "",
) -> str:
    """开一条运行记录（状态 running）。返回 session id。

    ``conversation_id`` 是它所属的对话线程（一次性排查为空）。
    """
    session_id = new_id()
    try:
        async with database.connect() as db:
            await db.execute(
                "INSERT INTO ai_sessions (id, username, host_id, host_name, mode,"
                " conversation_id, status, provider, created) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    session_id,
                    str(username or ""),
                    str(host_id or ""),
                    str(host_name or "")[:191],
                    str(mode or "agent"),
                    str(conversation_id or "")[:40],
                    "running",
                    str(provider or "")[:191],
                    int(time.time()),
                ),
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 审计写失败不该让排查本身挂掉
        logger.warning("AI 会话开启失败", exc_info=True)
    return session_id


async def finish_session(
    session_id: str,
    *,
    status: str,
    model: str = "",
    steps: int = 0,
    tool_calls: int = 0,
    usage: Optional[Dict[str, Any]] = None,
    duration_ms: int = 0,
    error: str = "",
    result: Optional[Dict[str, Any]] = None,
) -> None:
    usage = usage or {}
    # 结论以 JSON 落库；序列化失败（模型偶尔塞进不可序列化的东西）不该影响收尾，
    # 退化成空 —— 记录本身（状态、token）比结论更该保下来。
    result_json = ""
    if result is not None:
        try:
            result_json = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            result_json = ""
    try:
        async with database.connect() as db:
            await db.execute(
                "UPDATE ai_sessions SET status=?, model=?, steps=?, tool_calls=?,"
                " prompt_tokens=?, completion_tokens=?, total_tokens=?, duration_ms=?,"
                " error=?, result=?, finished=? WHERE id=?",
                (
                    str(status or "done"),
                    str(model or "")[:191],
                    int(steps or 0),
                    int(tool_calls or 0),
                    int(usage.get("prompt_tokens") or 0),
                    int(usage.get("completion_tokens") or 0),
                    int(usage.get("total_tokens") or 0),
                    int(duration_ms or 0),
                    str(error or "")[:500],
                    result_json,
                    int(time.time()),
                    session_id,
                ),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("AI 会话收尾失败", exc_info=True)


async def record_calls(session_id: str, calls: List[Dict[str, Any]]) -> None:
    """把一次排查里的全部工具调用落库。"""
    if not calls:
        return
    rows = []
    now = int(time.time())
    for item in calls:
        try:
            args = json.dumps(item.get("args") or {}, ensure_ascii=False)
        except (TypeError, ValueError):
            args = str(item.get("args") or "")
        rows.append(
            (
                new_id(),
                session_id,
                int(item.get("step") or 0),
                str(item.get("tool") or "")[:64],
                args[:2000],
                str(item.get("command") or "")[:1024],
                1 if item.get("ok") else 0,
                str(item.get("output") or "")[:2000],
                int(item.get("elapsed_ms") or 0),
                now,
            )
        )
    try:
        async with database.connect() as db:
            # 逐条 execute 而不是 executemany：本项目的 database 封装只有
            # execute / executescript（见 app/database.py），没有 executemany。
            # 一次排查也就十几条，够用。
            for row in rows:
                await db.execute(
                    "INSERT INTO ai_tool_calls (id, session_id, step, tool, args,"
                    " command, ok, output, elapsed_ms, created)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)",
                    row,
                )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("AI 工具调用落库失败", exc_info=True)


def _session_filters(
    username: str, host_id: str, alias: str = ""
) -> Tuple[str, List[Any]]:
    """会话过滤条件。抽出来是因为**分页列表与 CSV 导出必须用同一套条件** ——
    两边各写一份，迟早会出现「页面显示 37 条、导出文件里 41 行」这种对不上的账。

    ``alias`` 是 JOIN 查询里给 ``ai_sessions`` 起的别名（导出要带 ``s.`` 前缀）。
    """
    prefix = f"{alias}." if alias else ""
    where: List[str] = []
    params: List[Any] = []
    if username:
        where.append(f"{prefix}username=?")
        params.append(username)
    if host_id:
        where.append(f"{prefix}host_id=?")
        params.append(host_id)
    return ((" WHERE " + " AND ".join(where)) if where else ""), params


async def list_sessions(
    *,
    limit: int = 20,
    offset: int = 0,
    username: str = "",
    host_id: str = "",
) -> Dict[str, Any]:
    """排查记录分页查询，返回 ``{total, items}``。

    ``username`` 为空表示不限（管理员视角）。普通用户由路由层传自己的名字 ——
    过滤放在 SQL 里而不是取回来再筛，否则翻页的 total 会算成全部人的，
    用户会看到「共 200 条」却只能翻到 3 条。
    """
    clause, params = _session_filters(username, host_id)
    size = max(1, min(100, int(limit or 20)))
    start = max(0, int(offset or 0))
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT COUNT(*) AS n FROM ai_sessions" + clause, tuple(params)
            )
            row = await cursor.fetchone()
            total = int((dict(row).get("n") if row else 0) or 0)

            cursor = await db.execute(
                "SELECT * FROM ai_sessions"
                + clause
                + " ORDER BY created DESC LIMIT ? OFFSET ?",
                tuple(params + [size, start]),
            )
            items = [dict(item) for item in await cursor.fetchall()]
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 排查记录失败", exc_info=True)
        return {"total": 0, "items": []}
    # host_name 是那次排查运行时的快照（库里保留不动），列表里换成当前名字 ——
    # 受管主机改过名之后，记录页还显示旧名就认不出是哪台机器了。
    hostscope.apply_display_names(items, await hostscope.current_display_names())
    return {"total": total, "items": items}


# --------------------------------------------------------------- 用量统计
#
# 「这次 AI 到底花了多少 token」是使用者最关心的成本问题之一，而 token 分散在
# 每一次运行里（``ai_sessions`` 的三个 token 列）。这里把它们按窗口聚合起来，
# 供助手页的用量卡片展示。
#
# 为什么不做成定时汇总表：数据量级不大（一台面板几百到几千次运行），现场聚合
# 就够；而汇总表要处理迟到写入与补算，复杂度远高于收益。等哪天查询变慢了再说。

#: 默认回看窗口（天）。默认给短的 —— 用户看的是「最近花了多少」，
#: 想看历史总量可以去记录页按页翻。
USAGE_DEFAULT_DAYS = 7
#: 窗口上限，防止有人传个 99999 把整库扫一遍
USAGE_MAX_DAYS = 365
#: 按模型分组最多返回几条。长尾（偶发用一次的模型）没必要占位置。
USAGE_MODEL_LIMIT = 6


async def usage_stats(
    *,
    username: str = "",
    host_id: str = "",
    days: int = USAGE_DEFAULT_DAYS,
) -> Dict[str, Any]:
    """AI 用量统计：窗口内的 token 消耗、运行次数与按模型 / 按天的明细。

    归属口径**复用排查记录页那一套**（:func:`_session_filters`）：管理员不限、
    普通用户只看自己的。消耗是花在某个人头上的成本，与「记录页能翻到谁」是同一
    件事 —— 两边各写一份过滤，迟早会漂成两个口径。

    token 只累加 ``ai_sessions`` 的三个 token 列：那是每次运行收尾时落库的用量
    （上游没回传 usage 时是估算值，见 ``ai.run_tool_loop``），**不重新计算** ——
    统计口径必须和记录页看到的是同一个数。
    """
    window = max(1, min(USAGE_MAX_DAYS, int(days or USAGE_DEFAULT_DAYS)))
    clause, params = _session_filters(username, host_id)
    # 时间窗是本函数独有的（记录页按页翻，不需要）；拼在归属条件之后。
    # 窗口起点要等连上库、由 MySQL 给出（见下面那段），所以 since 先给一个纯算术的
    # 兜底值，参数也在那之后再补进 params。
    time_clause = "created >= ?"
    clause = f"{clause} AND {time_clause}" if clause else f" WHERE {time_clause}"
    since = int(time.time()) - window * 86400
    # 窗口内每一天的日期（``YYYY-MM-DD``），同样由 MySQL 给出首日后纯日期递推
    day_series: List[str] = []

    totals: Dict[str, int] = {
        "runs": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "tool_calls": 0,
        "duration_ms": 0,
    }
    by_model: List[Dict[str, Any]] = []
    daily: List[Dict[str, Any]] = []
    try:
        async with database.connect() as db:
            # 「近 N 天」按**自然日**对齐：起点取 MySQL 时区里今天的 00:00 往前推
            # N-1 天，而不是「此刻减 N*86400 秒」。两个好处：daily 恰好 N 个点，
            # 且 total == sum(daily) —— 用「此刻往回 N 天」的话首日只覆盖当天的一
            # 小段，卡片上的总数与柱子加起来对不上，而这两个数在同一个弹窗里是
            # 并排显示的。时区也一并交给 MySQL：面板与数据库不同机、时区不一致时，
            # 在 Python 里换算会把日期整体挪一天。
            cursor = await db.execute(
                "SELECT UNIX_TIMESTAMP(DATE_SUB(CURDATE(), INTERVAL ? DAY)) AS since,"
                " DATE(DATE_SUB(CURDATE(), INTERVAL ? DAY)) AS first_day",
                (window - 1, window - 1),
            )
            row = await cursor.fetchone()
            clock = dict(row) if row else {}
            try:
                since = int(clock.get("since") or 0) or since
            except (TypeError, ValueError):
                pass
            first_day = str(clock.get("first_day") or "")
            if first_day:
                # 日期序列用**纯日期算术**递推：首日字符串是 MySQL 给的，加天数
                # 不经过任何时区换算
                start = date.fromisoformat(first_day)
                day_series = [
                    (start + timedelta(days=offset)).isoformat()
                    for offset in range(window)
                ]
            params = [*params, since]

            cursor = await db.execute(
                "SELECT COUNT(*) AS runs,"
                " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
                " COALESCE(SUM(completion_tokens), 0) AS completion_tokens,"
                " COALESCE(SUM(total_tokens), 0) AS total_tokens,"
                " COALESCE(SUM(tool_calls), 0) AS tool_calls,"
                " COALESCE(SUM(duration_ms), 0) AS duration_ms"
                " FROM ai_sessions" + clause,
                tuple(params),
            )
            row = await cursor.fetchone()
            if row:
                item = dict(row)
                for key in totals:
                    totals[key] = int(item.get(key) or 0)

            cursor = await db.execute(
                "SELECT model, provider, COUNT(*) AS runs,"
                " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
                " COALESCE(SUM(completion_tokens), 0) AS completion_tokens,"
                " COALESCE(SUM(total_tokens), 0) AS total_tokens"
                " FROM ai_sessions" + clause
                + " GROUP BY model, provider"
                " ORDER BY total_tokens DESC, runs DESC LIMIT ?",
                tuple([*params, USAGE_MODEL_LIMIT]),
            )
            for raw in await cursor.fetchall():
                item = dict(raw)
                by_model.append(
                    {
                        "model": str(item.get("model") or ""),
                        "provider": str(item.get("provider") or ""),
                        "runs": int(item.get("runs") or 0),
                        "prompt_tokens": int(item.get("prompt_tokens") or 0),
                        "completion_tokens": int(item.get("completion_tokens") or 0),
                        "total_tokens": int(item.get("total_tokens") or 0),
                    }
                )

            # 按天聚合交给 MySQL：DATE(FROM_UNIXTIME(...)) 是 MySQL 方言，面板只跑
            # MySQL（见 README），换来的是不用把整窗口的行拉回进程里再分组。
            cursor = await db.execute(
                "SELECT DATE(FROM_UNIXTIME(created)) AS day,"
                " COUNT(*) AS runs,"
                " COALESCE(SUM(total_tokens), 0) AS total_tokens"
                " FROM ai_sessions" + clause
                + " GROUP BY day ORDER BY day ASC",
                tuple(params),
            )
            counted: Dict[str, Dict[str, Any]] = {}
            for raw in await cursor.fetchall():
                item = dict(raw)
                counted[str(item.get("day") or "")] = item
            # 窗口内**每一天都要出现**（缺的补 0），而不是只返回有数据的那几天：
            # 柱状图要的是等距时间轴。「这天没跑」与「这天不在窗口里」在图上必须
            # 能区分开，否则 7 天窗口只有 2 天有数据时，两根柱子会被抻宽成两块色块。
            # day_series 为空（窗口对齐查询没成功）时退回只列有数据的天。
            for day in day_series or sorted(counted):
                item = counted.get(day) or {}
                daily.append(
                    {
                        "day": day,
                        "runs": int(item.get("runs") or 0),
                        "total_tokens": int(item.get("total_tokens") or 0),
                    }
                )
    except Exception:  # noqa: BLE001 - 统计失败退化成空数据，不该让卡片整块报错
        logger.warning("读取 AI 用量统计失败", exc_info=True)

    runs = totals["runs"]
    totals["avg_tokens"] = int(totals["total_tokens"] / runs) if runs else 0
    totals["avg_duration_ms"] = int(totals["duration_ms"] / runs) if runs else 0
    return {
        "days": window,
        "since": since,
        "total": totals,
        "by_model": by_model,
        "daily": daily,
    }


# 单批取多少行。一行 = 一次工具调用，所以批量按行数而不是会话数算。
EXPORT_BATCH = 500


async def _records_page(
    *,
    username: str,
    host_id: str,
    offset: int,
    size: int,
) -> List[Dict[str, Any]]:
    clause, params = _session_filters(username, host_id, alias="s")
    sql = (
        "SELECT s.created, s.username, s.host_name, s.host_id, s.mode, s.model,"
        " s.provider, s.status, s.steps, s.tool_calls, s.prompt_tokens,"
        " s.completion_tokens, s.total_tokens, s.duration_ms, s.error,"
        " c.step AS call_step, c.tool, c.args, c.command, c.ok, c.output,"
        " c.elapsed_ms AS call_ms"
        " FROM ai_sessions s"
        " LEFT JOIN ai_tool_calls c ON c.session_id = s.id"
        + clause
        + " ORDER BY s.created DESC, c.step ASC LIMIT ? OFFSET ?"
    )
    try:
        async with database.connect() as db:
            cursor = await db.execute(sql, tuple(params + [size, offset]))
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001
        logger.warning("导出 AI 排查记录时读库失败", exc_info=True)
        return []
    records = [dict(row) for row in rows]
    # 导出的主机名与页面口径一致：用当前名字，免得导出的表与页面对不上
    hostscope.apply_display_names(records, await hostscope.current_display_names())
    return records


async def stream_records(
    *,
    username: str = "",
    host_id: str = "",
    batch: int = EXPORT_BATCH,
) -> AsyncIterator[Dict[str, Any]]:
    """把「会话 + 工具调用」摊平成「一行一次调用」的宽表，分批吐。

    用 LEFT JOIN 而不是 INNER 是刻意的：只解读、没调用任何工具的那次排查也必须
    出现在导出里。用 INNER 的话它会整行消失 —— 用户会以为那次排查没发生过，
    而恰恰是「AI 没在机器上动过手」这件事需要被记录。

    会话公共字段在每行重复出现，这是 CSV 的常态：一张能直接筛、直接透视的宽表，
    比让使用者自己去做关联有用得多。
    """
    offset = 0
    size = max(1, int(batch or EXPORT_BATCH))
    while True:
        rows = await _records_page(
            username=username, host_id=host_id, offset=offset, size=size
        )
        if not rows:
            return
        for row in rows:
            yield row
        if len(rows) < size:
            return
        offset += len(rows)


async def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT * FROM ai_sessions WHERE id=?", (str(session_id),)
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 排查记录详情失败", exc_info=True)
        return None
    if not row:
        return None
    record = dict(row)
    hostscope.apply_display_names([record], await hostscope.current_display_names())
    return record


async def latest_session_for_conversation(
    conversation_id: str,
) -> Optional[Dict[str, Any]]:
    """一条会话最近一次运行的元信息（模型 / 耗时 / token / 工具数）。

    头部那行「模型 · 耗时 · token · 工具数」来自这里 —— 它记在运行上，不在
    对话线程上。取最近一次：会话里可能跑过好几轮，用户想看的是刚发生的那次。
    """
    sql = (
        "SELECT model, provider, status, steps, tool_calls, total_tokens,"
        " duration_ms, created, finished FROM ai_sessions WHERE conversation_id=?"
    )
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                sql + " ORDER BY created DESC LIMIT 1", (str(conversation_id),)
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 会话最近运行失败", exc_info=True)
        return None
    return dict(row) if row else None


async def session_calls(session_id: str) -> List[Dict[str, Any]]:
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT * FROM ai_tool_calls WHERE session_id=? ORDER BY step, created",
                (session_id,),
            )
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [dict(row) for row in rows]
