"""巡检快照落库：把「端口与进程」「安全基线」的现场巡检结果持久化。

## 为什么要有这个模块

这两页的「全平台总览」原本不是读一份现成数据，而是**进入页面时现场巡检**：
对每台主机新建一条 SSH、跑一条合并的探测命令（单条最坏 45 秒超时）。进程内
只有一层 2 分钟 TTL 缓存（见 :mod:`app.reportcache`），于是：

* 面板重启后缓存全空，第一次打开必等一整轮 SSH；
* 主机不可达时，一轮会被拖到超时上限。

本模块把巡检结果按**每主机一行**落到 MySQL，读接口只读快照，现场巡检交给
后台作业（``inspection_warm``，注册在 :mod:`app.main`）。于是「打开页面」与
「发起 SSH」彻底解耦：读接口永远秒回，重启也不丢。

## 粒度为什么是「每主机」而不是「每可见主机集合」

一次预热服务所有用户：读的时候按可见 ``host_ids`` 过滤、再重算 totals，
表行数只有 主机数 × 语言数，而不是「每个用户一份」。

## 语言

报告里的检查项名称 / 结论 / 加固建议都是**采集时按当前语言渲染好的字符串**
（见 :func:`app.baseline._check`）。所以快照按 ``lang`` 分行：预热只落默认
语言，英文界面读不到时由调用方回落真扫（等价于改造前的行为，不会更差）。

## 写路径

* 后台预热：:func:`warm_once`；
* 读接口的真扫：:func:`scan_fleet`（扫完顺手落库）；
* 策略 / 处置 / 加固变更：:func:`purge_snapshots`（由 ``reportcache.clear``
  调用，让下一次读重新真扫，与改造前的同步语义一致）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Tuple

from . import database, i18n
from .config import settings

logger = logging.getLogger(__name__)

#: 支持快照的功能命名空间：与 reportcache.scope_key 的功能名一一对应。
NAMESPACES = ("ports", "baseline")

#: 需要**独立预热作业**的命名空间。端口不在其中 —— 它的落库由既有的「端口与进程
#: 巡检」作业（``portguard.evaluate``）顺带完成，避免同一批主机每轮扫两遍 SSH。
WARM_NAMESPACES = ("baseline",)

#: 兜底语言（预热默认只落它）。
FALLBACK_LANG = "zh-CN"

#: 快照保留期：超过这个年龄的行在保留清理里删掉，防止主机 / 语言变更留下残行。
RETENTION_SECONDS = 7 * 86_400
_PURGE_BATCH = 500

SCHEMA = """
CREATE TABLE IF NOT EXISTS inspection_host_report (
    namespace   VARCHAR(32)  NOT NULL,
    host_id     VARCHAR(64)  NOT NULL,
    lang        VARCHAR(8)   NOT NULL DEFAULT 'zh-CN',
    ok          TINYINT      NOT NULL DEFAULT 0,
    error       VARCHAR(500) NOT NULL DEFAULT '',
    checked_at  BIGINT       NOT NULL DEFAULT 0,
    duration_ms INT          NOT NULL DEFAULT 0,
    payload     MEDIUMTEXT   NOT NULL,
    updated_at  BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, host_id, lang),
    KEY idx_inspection_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inspection_lease (
    lease_key  VARCHAR(64) NOT NULL,
    owner      VARCHAR(96) NOT NULL DEFAULT '',
    expires_at BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (lease_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inspection_history (
    namespace   VARCHAR(32) NOT NULL,
    host_id     VARCHAR(64) NOT NULL,
    lang        VARCHAR(8)  NOT NULL DEFAULT 'zh-CN',
    ts          BIGINT      NOT NULL DEFAULT 0,
    ok          TINYINT     NOT NULL DEFAULT 0,
    score       INT         NOT NULL DEFAULT 0,
    fail_count  INT         NOT NULL DEFAULT 0,
    warn_count  INT         NOT NULL DEFAULT 0,
    issue_count INT         NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, host_id, lang, ts),
    KEY idx_inspection_history_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

_COLUMNS = (
    "namespace",
    "host_id",
    "lang",
    "ok",
    "error",
    "checked_at",
    "duration_ms",
    "payload",
    "updated_at",
)
_CONFLICT = ("namespace", "host_id", "lang")

#: 趋势表的时间桶（秒）。巡检每 5 分钟一轮，按小时归并对「看趋势」足够，
#: 还能把行数压到「主机数 × 24 × 语言数 / 天」。
HISTORY_BUCKET = 3600
#: 趋势保留期：比快照（7 天）长得多 —— 趋势要能看出「这几周有没有变好」。
HISTORY_RETENTION_SECONDS = 90 * 86_400

_HISTORY_COLUMNS = (
    "namespace",
    "host_id",
    "lang",
    "ts",
    "ok",
    "score",
    "fail_count",
    "warn_count",
    "issue_count",
)
_HISTORY_CONFLICT = ("namespace", "host_id", "lang", "ts")


def _history_metrics(namespace: str, report: Dict[str, Any]) -> Dict[str, int]:
    """从一份报告里抽出趋势要用的几个数字。

    两个功能的「不合格 / 待改进」口径不同：
    * 安全基线：``fail`` / ``warn`` 直接来自 summary；
    * 端口巡检：把「可疑进程」当不合格、「非预期开放端口」当待改进
      （前者更严重，与界面上的排序口径一致）。
    """
    summary = report.get("summary") or {}
    if namespace == "baseline":
        fail = int(summary.get("fail") or 0)
        warn = int(summary.get("warn") or 0)
    else:
        fail = int(summary.get("suspicious") or 0)
        warn = int(summary.get("unexpected") or 0)
    return {
        "ok": int(bool(report.get("ok"))),
        "score": int(report.get("score") or 0),
        "fail_count": fail,
        "warn_count": warn,
        "issue_count": fail + warn,
    }


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# --------------------------------------------------------------------- 写入
def _dump(report: Dict[str, Any]) -> str:
    # default=str：报告里若混入 datetime / 异常对象，宁可转成字符串也别让整条落库失败
    return json.dumps(report, ensure_ascii=False, default=str)


async def persist_reports(
    namespace: str,
    reports: Iterable[Dict[str, Any]],
    *,
    lang: Optional[str] = None,
    duration_ms: int = 0,
) -> int:
    """把一批**完整**报告按主机 upsert 进快照表，返回落库行数。"""
    if not settings.inspection_snapshot_enabled:
        return 0
    rows = [
        report
        for report in reports
        if isinstance(report, dict) and str(report.get("host_id") or "")
    ]
    if not rows:
        return 0

    resolved_lang = (lang or i18n.current_language()) or FALLBACK_LANG
    now = int(time.time())
    bucket = now // HISTORY_BUCKET * HISTORY_BUCKET
    try:
        snapshot_sql = database.upsert_sql("inspection_host_report", _COLUMNS, _CONFLICT)
        history_sql = database.upsert_sql(
            "inspection_history", _HISTORY_COLUMNS, _HISTORY_CONFLICT
        )
        async with database.connect() as db:
            for report in rows:
                host_id = str(report.get("host_id") or "")
                await db.execute(
                    snapshot_sql,
                    (
                        namespace,
                        host_id,
                        resolved_lang,
                        int(bool(report.get("ok"))),
                        str(report.get("error") or "")[:500],
                        int(report.get("checked_at") or now),
                        int(duration_ms),
                        _dump(report),
                        now,
                    ),
                )
                # 同时记一条趋势桶：同一小时内重复巡检只覆盖那一行
                metrics = _history_metrics(namespace, report)
                await db.execute(
                    history_sql,
                    (
                        namespace,
                        host_id,
                        resolved_lang,
                        bucket,
                        metrics["ok"],
                        metrics["score"],
                        metrics["fail_count"],
                        metrics["warn_count"],
                        metrics["issue_count"],
                    ),
                )
            await db.commit()
    except Exception:  # noqa: BLE001 - 落库失败不能让真扫结果白跑（退化为改造前）
        logger.warning("巡检快照落库失败：%s（本轮跳过）", namespace, exc_info=True)
        return 0
    return len(rows)


# --------------------------------------------------------------------- 读取
async def load_reports(
    namespace: str,
    host_ids: Optional[Iterable[str]] = None,
    *,
    lang: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """读某功能 + 某语言的快照，按可见 ``host_ids`` 过滤（``None`` = 不限）。

    返回**完整**报告列表；一条都没有时返回空列表（调用方据此决定是否真扫）。
    """
    if not settings.inspection_snapshot_enabled:
        return []
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    if wanted is not None and not wanted:
        return []

    resolved_lang = (lang or i18n.current_language()) or FALLBACK_LANG
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT host_id, payload FROM inspection_host_report "
                "WHERE namespace = ? AND lang = ?",
                (namespace, resolved_lang),
            )
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001 - 表没建好 / 库抖动时退化为真扫，别让接口 500
        logger.warning("读取巡检快照失败：%s（回落到真扫）", namespace, exc_info=True)
        return []

    reports: List[Dict[str, Any]] = []
    for row in rows:
        host_id = str(row["host_id"])
        if wanted is not None and host_id not in wanted:
            continue
        try:
            report = json.loads(row["payload"])
        except (TypeError, ValueError):
            logger.warning("巡检快照 JSON 解析失败：%s/%s", namespace, host_id)
            continue
        if isinstance(report, dict):
            reports.append(report)
    return reports


async def load_host_report(
    namespace: str, host_id: str, *, lang: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """读单台主机的完整快照报告；没有返回 ``None``。"""
    reports = await load_reports(namespace, [host_id], lang=lang)
    for report in reports:
        if str(report.get("host_id") or "") == str(host_id):
            return report
    return None


# --------------------------------------------------------------------- 趋势
async def history(
    namespace: str,
    *,
    host_id: Optional[str] = None,
    host_ids: Optional[Iterable[str]] = None,
    days: int = 30,
    lang: Optional[str] = None,
) -> Dict[str, Any]:
    """读趋势序列。

    * 给了 ``host_id``：返回这台机器每个时间桶的指标（评分 / 不合格 / 待改进…）；
    * 没给：返回**全平台逐桶聚合**（主机数 / 可达数 / 不合格合计 / 待改进合计 /
      平均分），用于「整体有没有变好」的趋势图。

    ``host_ids`` 是**可见主机集合**（``None`` = 不限，管理员）：普通用户的
    「全平台」只能是自己名下那几台 —— 少了它，趋势图会把别人的主机也算进去。
    """
    resolved_lang = (lang or i18n.current_language()) or FALLBACK_LANG
    window = max(1, int(days))
    since = int(time.time()) - window * 86_400

    where = ["namespace = ?", "lang = ?", "ts >= ?"]
    params: List[Any] = [namespace, resolved_lang, since]

    if host_id:
        where.append("host_id = ?")
        params.append(str(host_id))
        aggregate = False
    else:
        aggregate = True
        if host_ids is not None:
            visible = sorted({str(item) for item in host_ids})
            if not visible:
                return {
                    "namespace": namespace,
                    "host_id": "",
                    "bucket": HISTORY_BUCKET,
                    "days": window,
                    "points": [],
                }
            where.append("host_id IN (" + ", ".join("?" for _ in visible) + ")")
            params.extend(visible)

    where_sql = " AND ".join(where)
    if aggregate:
        sql = (
            "SELECT ts, COUNT(*) AS hosts, SUM(ok) AS reachable, "
            "       SUM(fail_count) AS fails, SUM(warn_count) AS warns, "
            "       AVG(score) AS avg_score "
            f"FROM inspection_history WHERE {where_sql} "
            "GROUP BY ts ORDER BY ts"
        )
    else:
        sql = (
            "SELECT ts, ok, score, fail_count, warn_count, issue_count "
            f"FROM inspection_history WHERE {where_sql} ORDER BY ts"
        )

    try:
        async with database.connect() as db:
            cursor = await db.execute(sql, tuple(params))
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001 - 趋势读不到不该让页面报错，返回空序列即可
        logger.warning("读取巡检趋势失败：%s", namespace, exc_info=True)
        rows = []

    points: List[Dict[str, Any]] = []
    for row in rows:
        if host_id:
            points.append(
                {
                    "ts": int(row["ts"]),
                    "ok": bool(row["ok"]),
                    "score": int(row["score"] or 0),
                    "fail": int(row["fail_count"] or 0),
                    "warn": int(row["warn_count"] or 0),
                    "issues": int(row["issue_count"] or 0),
                }
            )
        else:
            points.append(
                {
                    "ts": int(row["ts"]),
                    "hosts": int(row["hosts"] or 0),
                    "reachable": int(row["reachable"] or 0),
                    "fail": int(row["fails"] or 0),
                    "warn": int(row["warns"] or 0),
                    "score": int(round(float(row["avg_score"] or 0))),
                }
            )

    return {
        "namespace": namespace,
        "host_id": host_id or "",
        "bucket": HISTORY_BUCKET,
        "days": window,
        "points": points,
    }


# --------------------------------------------------------------------- 清理
async def purge_snapshots(namespace: Optional[str] = None) -> int:
    """清空快照（``namespace`` 为空则全清）。

    策略 / 处置 / 加固变更后调用：判定口径已经变了，旧快照不该再被读出来。
    """
    try:
        async with database.connect() as db:
            if namespace:
                cursor = await db.execute(
                    "DELETE FROM inspection_host_report WHERE namespace = ?", (namespace,)
                )
            else:
                cursor = await db.execute("DELETE FROM inspection_host_report")
            affected = cursor.rowcount
            await db.commit()
    except Exception:  # noqa: BLE001 - 清快照失败不该阻断变更操作本身
        logger.warning("清空巡检快照失败：%s", namespace or "全部", exc_info=True)
        return 0
    return max(affected, 0)


async def purge_old(now: Optional[float] = None) -> int:
    """清理超期的快照行与趋势桶（分批删，避免长事务持锁）。"""
    stamp = now if now is not None else time.time()
    cutoff = int(stamp - RETENTION_SECONDS)
    history_cutoff = int(stamp - HISTORY_RETENTION_SECONDS)
    deleted = 0
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "DELETE FROM inspection_host_report WHERE updated_at < ? LIMIT ?",
                (cutoff, _PURGE_BATCH),
            )
            deleted += max(cursor.rowcount, 0)
            # 趋势表没有 updated_at，按采集时间（ts）算保留期
            cursor = await db.execute(
                "DELETE FROM inspection_history WHERE ts < ? LIMIT ?",
                (history_cutoff, _PURGE_BATCH),
            )
            deleted += max(cursor.rowcount, 0)
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("清理超期巡检快照失败", exc_info=True)
        return deleted
    return deleted


# --------------------------------------------------------------------- 租约
def _owner_id() -> str:
    """当前进程的巡检标识（主机名 + PID）。"""
    return f"{socket.gethostname()[:48]}:{os.getpid()}"


async def acquire_lease(lease_key: str, ttl: Optional[int] = None) -> bool:
    """抢占巡检租约；抢不到返回 ``False``（说明别的进程正在跑）。

    多 worker / 多实例部署时，每个进程的调度器都会到点触发预热 —— 没有租约的话
    同一批主机每轮被扫 N 遍（每台都要拨一条 SSH）。这里用一张表保证「同一时刻
    只有一个进程真扫」；扫描结束由 :func:`release_lease` 主动让出，所以刷新频率
    仍是调度间隔，不会被租约拖慢。

    单进程部署下它不改变任何行为：只有自己会抢，且 ``owner`` 命中时直接放行。
    """
    if not settings.inspection_snapshot_enabled:
        return True

    owner = _owner_id()
    now = int(time.time())
    expires = now + int(ttl or settings.inspection_lease_seconds)
    try:
        async with database.connect() as db:
            # 先保证行存在（幂等），再带条件更新抢占；两条语句都不需要额外事务锁
            await db.execute(
                "INSERT INTO inspection_lease (lease_key, owner, expires_at) "
                "VALUES (?, '', 0) ON DUPLICATE KEY UPDATE lease_key = lease_key",
                (lease_key,),
            )
            cursor = await db.execute(
                "UPDATE inspection_lease SET owner = ?, expires_at = ? "
                "WHERE lease_key = ? AND expires_at < ?",
                (owner, expires, lease_key, now),
            )
            await db.commit()
            if cursor.rowcount > 0:
                return True
            # 没抢到：若持有者就是自己（单进程连续两轮、上一轮还没到点），放行
            cursor = await db.execute(
                "SELECT owner FROM inspection_lease WHERE lease_key = ?", (lease_key,)
            )
            row = await cursor.fetchone()
            return bool(row) and str(row["owner"] or "") == owner
    except Exception:  # noqa: BLE001 - 租约表不可用时按单进程处理，宁可多扫也别漏
        logger.warning("巡检租约不可用（按单进程继续）：%s", lease_key, exc_info=True)
        return True


async def release_lease(lease_key: str) -> None:
    """让出租约（扫描结束时调用）。失败只记日志 —— 租约到期后自然失效。"""
    try:
        async with database.connect() as db:
            await db.execute(
                "UPDATE inspection_lease SET expires_at = 0 "
                "WHERE lease_key = ? AND owner = ?",
                (lease_key, _owner_id()),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("释放巡检租约失败：%s", lease_key, exc_info=True)


# --------------------------------------------------------------- 聚合与真扫
def _fleet_module(namespace: str) -> Any:
    """把命名空间映射到对应功能模块（延迟 import，避免启动期循环依赖）。"""
    if namespace == "ports":
        from . import portguard as module
    elif namespace == "baseline":
        from . import baseline as module
    else:
        raise ValueError(f"未知快照命名空间：{namespace}")
    return module


def aggregate_reports(namespace: str, reports: List[Dict[str, Any]]) -> Dict[str, Any]:
    """把完整报告列表收成总览 payload（与真扫共用同一聚合，口径一致）。"""
    return _fleet_module(namespace).fleet_from_reports(reports)


async def scan_fleet(namespace: str, host_ids: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    """现场巡检一轮、落库、返回总览 payload。读接口的真扫入口。"""
    module = _fleet_module(namespace)
    started = time.time()
    reports = await module.fleet_reports(host_ids)
    await persist_reports(
        namespace, reports, duration_ms=int((time.time() - started) * 1000)
    )
    return module.fleet_from_reports(reports)


async def stream_fleet(
    namespace: str, host_ids: Optional[Iterable[str]] = None
) -> AsyncIterator[Dict[str, Any]]:
    """流式巡检：逐台产出事件，边扫边推（SSE 用）。

    事件形状（前端按 ``type`` 分派）：

    * ``{"type": "start", "total": N, "namespace": ...}`` —— 本轮有几台；
    * ``{"type": "host", "host": <compact 摘要>, "done": i, "total": N}`` ——
      一台跑完就推一条（顺序是**完成顺序**，前端按 host_id 归并即可）；
    * ``{"type": "done", "hosts": [...], "totals": {...}, "generated_at": ts}``
      —— 整轮结束，``hosts`` 已排序、``totals`` 已聚合。

    跑完仍会把结果按主机落库（与批量真扫同一张快照表），所以下一次打开页面
    照例读快照，不必再等一轮 SSH。

    单台失败不会中断整轮：收成占位报告继续推（与批量路径的降级口径一致）。
    """
    module = _fleet_module(namespace)
    plan = await module.fleet_plan(host_ids)
    total = len(plan)
    started = time.time()

    yield {"type": "start", "namespace": namespace, "total": total}
    if total == 0:
        payload = module.fleet_from_reports([])
        yield {
            "type": "done",
            "namespace": namespace,
            "hosts": payload["hosts"],
            "totals": payload["totals"],
            "generated_at": payload["generated_at"],
        }
        return

    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
    limit = max(1, int(getattr(module, "PROBE_CONCURRENCY", 8)))
    semaphore = asyncio.Semaphore(limit)

    async def run_one(row: Optional[Dict[str, Any]], factory: Any) -> None:
        async with semaphore:
            try:
                report = await factory()
            except Exception as exc:  # noqa: BLE001 - 失败也要收成报告推给前端
                logger.warning(
                    "流式巡检单台失败（%s）：%s",
                    (row or {}).get("id") or "local",
                    exc,
                )
                report = module.fleet_error_report(row, exc)
            await queue.put(report)

    tasks = [
        asyncio.create_task(run_one(row, factory)) for row, factory in plan
    ]
    reports: List[Dict[str, Any]] = []
    done = 0
    try:
        for _ in range(total):
            report = await queue.get()
            reports.append(report)
            done += 1
            yield {
                "type": "host",
                "done": done,
                "total": total,
                "host": module.compact_report(report),
            }
    finally:
        # 客户端断开（SSE 提前关闭）时把还没跑完的目标收掉，别留一堆跑着的协程
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    await persist_reports(
        namespace, reports, duration_ms=int((time.time() - started) * 1000)
    )
    payload = module.fleet_from_reports(reports)
    yield {
        "type": "done",
        "namespace": namespace,
        "hosts": payload["hosts"],
        "totals": payload["totals"],
        "generated_at": payload["generated_at"],
    }


# --------------------------------------------------------------------- 后台作业
async def warm_once() -> Dict[str, Any]:
    """后台预热：全量体检安全基线，按配置语言落库。

    只跑 ``WARM_NAMESPACES``（当前是 ``baseline``）；端口的落库由既有的
    「端口与进程巡检」作业顺带完成，这里不重复扫。

    多 worker 部署下由 :func:`acquire_lease` 保证同一轮只有一个进程真扫。
    """
    if not settings.inspection_snapshot_enabled:
        return {"stored": 0, "scanned": 0}
    if not await acquire_lease("inspection_warm"):
        return {"stored": 0, "scanned": 0, "skipped": "lease"}

    stored = 0
    scanned = 0
    try:
        for lang in settings.inspection_warm_lang_list:
            # pin 而非 use_language：整段循环都按这个语言渲染，退出时任务上下文销毁
            i18n.pin_language(lang)
            for namespace in WARM_NAMESPACES:
                try:
                    module = _fleet_module(namespace)
                    started = time.time()
                    reports = await module.fleet_reports(None)
                    stored += await persist_reports(
                        namespace,
                        reports,
                        lang=i18n.current_language(),
                        duration_ms=int((time.time() - started) * 1000),
                    )
                    scanned += len(reports)
                except Exception:  # noqa: BLE001 - 一个功能失败不该拖垮另一个
                    logger.exception("预热巡检快照失败：%s", namespace)
    finally:
        await release_lease("inspection_warm")
    return {"stored": stored, "scanned": scanned}


def _connection_targets() -> List[Any]:
    """预热要遍历的 PVE 连接：与收集列表接口同一口径（默认连接空 profile）。"""
    from .pve import all_connection_clients, get_client

    targets = list(all_connection_clients())
    if targets:
        return targets
    client = get_client()
    if not getattr(client.conn, "configured", False):
        return []
    return [(None, client)]


async def warm_guest_ip() -> Dict[str, Any]:
    """后台预热：解析各运行中客户机的 IP 并落库（虚拟机列表读表，不再等 Agent）。

    多 worker 部署下同样由租约保证同一轮只有一个进程真扫。
    """
    if not settings.inspection_snapshot_enabled:
        return {"resolved": 0}
    if not await acquire_lease("guest_ip_warm"):
        return {"resolved": 0, "skipped": "lease"}

    from . import guestip

    resolved = 0
    try:
        for profile, client in _connection_targets():
            cid = str((profile or {}).get("id") or "")
            try:
                resources = await client.cluster_resources("vm") or []
            except Exception:  # noqa: BLE001 - 单台 PVE 连不上就跳过
                logger.warning("客户机 IP 预热跳过连接 %s", cid or "default", exc_info=True)
                continue
            items: List[Dict[str, Any]] = []
            for resource in resources:
                if not isinstance(resource, dict):
                    continue
                if str(resource.get("type") or "") not in ("qemu", "lxc"):
                    continue
                # 只有运行中的客户机才可能自报地址（非运行中直接看配置，不预热）
                if str(resource.get("status") or "") != "running":
                    continue
                items.append(
                    {
                        "connection_id": cid,
                        "node": resource.get("node"),
                        "vmid": resource.get("vmid"),
                        "type": resource.get("type"),
                        "status": resource.get("status"),
                    }
                )
            if items:
                await guestip.resolve_batch(client, items)
                resolved += len(items)
    finally:
        await release_lease("guest_ip_warm")
    return {"resolved": resolved}
