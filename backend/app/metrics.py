"""监控历史落库：节点与虚拟机的资源指标按周期采样进 MySQL。

为什么要自己存一份
------------------
PVE 的 ``rrddata`` 只能实时透传：**谁查谁取、取完即用**，面板这边不留任何痕迹。
带来的直接后果是：

* 查不了任意历史区间 —— 只能挑 PVE 预置的 hour/day/week/month/year；
* 出不了周报 / 月报 —— 每次都要重新把全集群的 rrddata 拉一遍再现场聚合；
* 容量预测只能「现算」—— 每次请求都重新拉历史 + 重新做最小二乘；
* 面板重启、PVE 主机重装或迁移后，面板能看见的历史就断档了。

因此把同一批指标按固定周期采样落一张 ``metrics_history`` 表：采样循环在
:mod:`app.main` 里跑（:func:`sample_once`），查询接口在
:mod:`app.routers.metrics`（:func:`query`），容量预测优先读这里
（:func:`capacity_series`），读不到再回落到 PVE 的 rrddata。

与 ``/ws/metrics`` 的分工
------------------------
``/ws/metrics`` 负责**实时**（5s 推一帧，进程内广播，不落库）；本模块负责
**历史**（60s 采一点，落库、可查区间）。两者共用同一份 PVE 数据源，因此
实时曲线和历史曲线的口径天然一致，前端拼起来不会有台阶。

表结构说明
----------
* ``scope`` 区分 ``node`` / ``guest`` —— 两类对象的指标字段基本一致，拆两张表
  只会让查询分支翻倍；单表 + 作用域过滤更省事。
* ``vmid`` 在节点行上固定为 0（而不是 NULL）：NULL 不参与 UNIQUE 键判重，
  用它做去重键会让节点行每分钟无限重复。
* ``connection_id`` 存的是**归属口径**的连接标识（空 = ``-``，见
  :func:`ownership.vm_ref`）：多台 PVE 合并展示时，不同主机上可能出现同名节点
  + 相同 VMID，必须带连接才分得清；顺带让「按归属于过滤」能和
  ``resource_owner`` 表里的 ref 直接对得上。
* UNIQUE ``(scope, connection_id, node, vmid, ts)`` + ``ON DUPLICATE KEY UPDATE``
  让采样可重入：同一分钟内重复跑只更新那一行，不会插出重复点。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import database, scheduler
from .config import settings
from .pve import ProxmoxError, all_connection_clients, get_client

logger = logging.getLogger(__name__)

# 采样作业在调度器里的 id（注册在 main.py）。align_ts 用它反查生效间隔。
METRICS_JOB_ID = "metrics_sample"

SCOPE_NODE = "node"
SCOPE_GUEST = "guest"
SCOPES = (SCOPE_NODE, SCOPE_GUEST)

# PVE 里「这台机器是活的」对应的状态值，作用域不同：节点是 online，虚拟机是 running
UP_STATUS = {SCOPE_NODE: "online", SCOPE_GUEST: "running"}

# 默认连接的占位标识，取值与 ownership.vm_ref 保持一致（空连接 id → "-"）
DEFAULT_CONNECTION = "-"

# 采样行的列顺序。建表语句、批量 INSERT、取行都按它走，改一处即可。
_COLUMNS: Tuple[str, ...] = (
    "ts",
    "scope",
    "connection_id",
    "node",
    "vmid",
    "guest_type",
    "name",
    "status",
    "cpu",
    "maxcpu",
    "mem",
    "maxmem",
    "disk",
    "maxdisk",
    "uptime",
    "netin",
    "netout",
    "diskread",
    "diskwrite",
)

# 冲突键：同一次采样内 (作用域, 连接, 节点, VMID, 时间) 唯一
_CONFLICT: Tuple[str, ...] = (
    "scope",
    "connection_id",
    "node",
    "vmid",
    "ts",
)

# 一次 INSERT 塞多少行。指标行很窄，100 行一条语句能显著减少往返，
# 又不会把 max_allowed_packet 顶到。
_BATCH = 100

# 保留清理每批删多少行、单轮最多删几批。
# 不加 LIMIT 的 DELETE 会长时间持锁；分批删则每批之间让出连接，对线上更友好。
_PURGE_BATCH = 5_000
_PURGE_MAX_BATCHES = 200

# 查询结果行数上限（分组后的桶数 × 对象数）。命中说明降采样不够狠，
# 由调用方按 step 参数收窄，同时用它置 truncated 标记。
_QUERY_ROW_LIMIT = 50_000

# 降采样档位：区间越长，桶越大。分钟级只在几小时内才有意义。
_STEP_STEPS: Tuple[Tuple[int, int], ...] = (
    (6 * 3600, 60),
    (2 * 86_400, 300),
    (7 * 86_400, 900),
    (30 * 86_400, 3600),
)
_MAX_STEP = 86_400
_MIN_STEP = 60

# 单次查询最多返回多少条序列（对象数），防止「一次拉全集群两个月」把响应撑爆
DEFAULT_MAX_SERIES = 50

SCHEMA = """
CREATE TABLE IF NOT EXISTS metrics_history (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    ts            BIGINT       NOT NULL,
    scope         VARCHAR(8)   NOT NULL,
    connection_id VARCHAR(64)  NOT NULL DEFAULT '-',
    node          VARCHAR(64)  NOT NULL DEFAULT '',
    -- 节点行固定写 0：NULL 不参与 UNIQUE 判重，会让节点行每次采样都插一条新行
    vmid          INT          NOT NULL DEFAULT 0,
    guest_type    VARCHAR(8)   NOT NULL DEFAULT '',
    name          VARCHAR(128) NOT NULL DEFAULT '',
    status        VARCHAR(32)  NOT NULL DEFAULT '',
    cpu           DOUBLE       NULL,
    maxcpu        INT          NULL,
    mem           BIGINT       NULL,
    maxmem        BIGINT       NULL,
    disk          BIGINT       NULL,
    maxdisk       BIGINT       NULL,
    uptime        BIGINT       NULL,
    netin         BIGINT       NULL,
    netout        BIGINT       NULL,
    diskread      BIGINT       NULL,
    diskwrite     BIGINT       NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_metrics_point (scope, connection_id, node, vmid, ts),
    KEY idx_metrics_ts (ts),
    KEY idx_metrics_scope_ts (scope, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# --------------------------------------------------------------------- 工具
def _num(value: Any) -> Optional[float]:
    """PVE 的数字字段可能是 None / 字符串 / 布尔，统一成 float 或 None。

    归一化放在写入侧：查历史时直接 AVG/SUM，不必在 SQL 里到处写 CAST，
    也不会因为某个字段是字符串而让整条聚合查询报错。
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _int(value: Any) -> Optional[int]:
    number = _num(value)
    return None if number is None else int(number)


def align_ts(value: float) -> int:
    """把时间对齐到采样周期，让同一周期内的重复采样命中同一行。

    周期取**调度器当前生效的间隔**而不是 settings 里的静态值：管理员在「后台
    作业」页把「监控历史采样」的间隔改掉之后，采样时刻与对齐粒度必须一起变 ——
    否则 60 秒的静态对齐配上 5 分钟的采样节奏，每个点都落在不同的对齐槽里，
    去重键失效，重复跑到同一周期会插出多行。
    """
    step = scheduler.effective_interval(
        METRICS_JOB_ID, int(settings.metrics_sample_interval)
    )
    return int(value // step * step)


def pick_step(span_seconds: int, requested: Optional[int] = None) -> int:
    """按区间长度选降采样步长（秒）。显式传入的 step 优先，但会夹到合法区间。"""
    if requested is not None and requested > 0:
        return max(_MIN_STEP, min(int(requested), _MAX_STEP))
    for limit, step in _STEP_STEPS:
        if span_seconds <= limit:
            return step
    return 3600


# ------------------------------------------------------------------ 采样写入
def _sampling_targets() -> List[Tuple[Optional[Dict[str, Any]], Any]]:
    """本次采样要遍历的 PVE 连接。

    没有保存任何连接时回落到进程内的默认连接（与 ``routers/lxc.py`` 的列表
    接口同一策略）；默认连接也没配的时候返回空表，采样直接跳过 —— 否则每分钟
    都会发一次必然失败的请求，日志被刷满。
    """
    targets: List[Tuple[Optional[Dict[str, Any]], Any]] = list(all_connection_clients())
    if targets:
        return targets

    client = get_client()
    if not getattr(client.conn, "configured", False):
        return []
    return [(None, client)]


def _node_point(connection_id: str, item: Dict[str, Any], ts: int) -> Dict[str, Any]:
    node = str(item.get("node") or "")
    return {
        "ts": ts,
        "scope": SCOPE_NODE,
        "connection_id": connection_id,
        "node": node,
        "vmid": 0,
        "guest_type": "",
        "name": node,
        "status": str(item.get("status") or ""),
        "cpu": _num(item.get("cpu")),
        "maxcpu": _int(item.get("maxcpu")),
        "mem": _int(item.get("mem")),
        "maxmem": _int(item.get("maxmem")),
        "disk": _int(item.get("disk")),
        "maxdisk": _int(item.get("maxdisk")),
        "uptime": _int(item.get("uptime")),
        "netin": _int(item.get("netin")),
        "netout": _int(item.get("netout")),
        "diskread": None,
        "diskwrite": None,
    }


def _guest_point(connection_id: str, item: Dict[str, Any], ts: int) -> Dict[str, Any]:
    return {
        "ts": ts,
        "scope": SCOPE_GUEST,
        "connection_id": connection_id,
        "node": str(item.get("node") or ""),
        "vmid": _int(item.get("vmid")) or 0,
        "guest_type": str(item.get("type") or ""),
        "name": str(item.get("name") or ""),
        "status": str(item.get("status") or ""),
        "cpu": _num(item.get("cpu")),
        "maxcpu": _int(item.get("maxcpu")),
        "mem": _int(item.get("mem")),
        "maxmem": _int(item.get("maxmem")),
        "disk": _int(item.get("disk")),
        "maxdisk": _int(item.get("maxdisk")),
        "uptime": _int(item.get("uptime")),
        "netin": _int(item.get("netin")),
        "netout": _int(item.get("netout")),
        "diskread": _int(item.get("diskread")),
        "diskwrite": _int(item.get("diskwrite")),
    }


def _insert_sql(batch: int) -> str:
    """多行 upsert 语句：同一次采样的所有点一条语句写完。"""
    columns = ", ".join(f"`{c}`" for c in _COLUMNS)
    placeholder = ", ".join("?" for _ in _COLUMNS)
    values = ", ".join(f"({placeholder})" for _ in range(batch))
    updates = ", ".join(
        f"`{c}`=VALUES(`{c}`)" for c in _COLUMNS if c not in _CONFLICT
    )
    return (
        f"INSERT INTO metrics_history ({columns}) VALUES {values} "
        f"ON DUPLICATE KEY UPDATE {updates}"
    )


async def _write(points: Sequence[Dict[str, Any]]) -> int:
    async with database.connect() as db:
        for start in range(0, len(points), _BATCH):
            chunk = points[start : start + _BATCH]
            params: List[Any] = []
            for point in chunk:
                params.extend(point.get(column) for column in _COLUMNS)
            await db.execute(_insert_sql(len(chunk)), tuple(params))
        await db.commit()
    return len(points)


async def sample_once(now: Optional[float] = None) -> int:
    """采样一轮：每个 PVE 连接取一次集群资源，节点与虚拟机各落一行。

    ``cluster_resources`` 一次就返回节点 / qemu / lxc 三类资源，所以每台 PVE
    每分钟只发一个请求 —— 比逐节点、逐虚拟机去问要省得多。

    单台 PVE 连不上只跳过它（并发多个集群时不能因为一台挂了就整体断采），
    返回本次写入的采样点数。
    """
    if not settings.metrics_history_enabled:
        return 0

    ts = align_ts(now if now is not None else time.time())
    points: List[Dict[str, Any]] = []

    for profile, client in _sampling_targets():
        cid = str((profile or {}).get("id") or "") or DEFAULT_CONNECTION
        label = "默认连接" if cid == DEFAULT_CONNECTION else cid
        try:
            resources = await client.cluster_resources() or []
        except ProxmoxError as exc:
            logger.warning("监控采样跳过连接 %s：%s", label, exc.message)
            continue
        except Exception:  # noqa: BLE001 - 采样失败不该影响其它连接
            logger.exception("监控采样读取 PVE 资源失败（连接 %s）", label)
            continue

        for item in resources:
            if not isinstance(item, dict):
                continue
            rtype = str(item.get("type") or "")
            if rtype == SCOPE_NODE:
                points.append(_node_point(cid, item, ts))
            elif rtype in ("qemu", "lxc"):
                points.append(_guest_point(cid, item, ts))

    if not points:
        return 0
    return await _write(points)


# ------------------------------------------------------------------ 保留策略
async def purge_old(now: Optional[float] = None) -> int:
    """清理超出保留期的历史行，返回删除行数。

    ``metrics_retention_days <= 0`` 表示永久保留，直接返回 0（留给「我自己归档」
    的部署形态）。
    """
    days = int(settings.metrics_retention_days)
    if not settings.metrics_history_enabled or days <= 0:
        return 0

    cutoff = int((now if now is not None else time.time()) - days * 86_400)
    deleted = 0

    async with database.connect() as db:
        for _ in range(_PURGE_MAX_BATCHES):
            cursor = await db.execute(
                "DELETE FROM metrics_history WHERE ts < ? LIMIT ?",
                (cutoff, _PURGE_BATCH),
            )
            affected = cursor.rowcount
            await db.commit()
            if affected <= 0:
                break
            deleted += affected
            # 没删满一批说明已经清干净了，不必再多跑一轮空查询
            if affected < _PURGE_BATCH:
                break

    if deleted:
        logger.info(
            "清理过期监控历史 %d 行（保留 %d 天）", deleted, days
        )
    return deleted


# --------------------------------------------------------------------- 查询
def _series_key(node: str, vmid: int) -> Tuple[str, int]:
    return (node, vmid)


async def query(
    *,
    scope: str,
    start: int,
    end: int,
    step: int,
    node: Optional[str] = None,
    vmid: Optional[int] = None,
    owned_refs: Optional[Sequence[str]] = None,
    max_series: int = DEFAULT_MAX_SERIES,
) -> Dict[str, Any]:
    """按区间查历史，返回按对象分组的降采样序列。

    降采样在 SQL 里做（``FLOOR(ts / step) * step`` 分桶）：30 天 × 几十台机器
    的原始点是几十万行，直接吐给前端既慢又没意义。速率类字段取 ``AVG``，
    容量类字段取 ``MAX`` —— 后者是「上限」，平均会把峰值抹平。

    ``owned_refs`` 为 ``None`` 表示不做归属过滤（管理员）；空列表表示该用户
    名下没有任何虚拟机，直接返回空（严格隔离：没有归属记录的资源不可见）。
    """
    if scope not in SCOPES:
        raise ValueError(f"未知作用域：{scope}")

    where = ["scope = ?", "ts >= ?", "ts <= ?"]
    params: List[Any] = [scope, start, end]

    if node:
        where.append("node = ?")
        params.append(node)
    if vmid is not None:
        where.append("vmid = ?")
        params.append(int(vmid))
    if owned_refs is not None:
        refs = [str(ref) for ref in owned_refs if ref]
        if not refs:
            return {
                "scope": scope,
                "step": step,
                "from": start,
                "to": end,
                "series": [],
                "truncated": False,
            }
        marks = ", ".join("?" for _ in refs)
        # 与 resource_owner.ref 同一拼法：<连接或 "-">:<节点>:<VMID>
        where.append(f"CONCAT(connection_id, ':', node, ':', vmid) IN ({marks})")
        params.extend(refs)

    sql = (
        # name / guest_type 用 MAX() 包起来而不是进 GROUP BY：一旦窗口内改过名，
        # 按 name 分组会让同一个桶裂成两行、序列里出现重复的时间点。
        "SELECT node, vmid,"
        "       MAX(name) AS name, MAX(guest_type) AS guest_type,"
        "       FLOOR(ts / ?) * ? AS bucket,"
        "       AVG(cpu) AS cpu, MAX(maxcpu) AS maxcpu,"
        "       AVG(mem) AS mem, MAX(maxmem) AS maxmem,"
        "       AVG(disk) AS disk, MAX(maxdisk) AS maxdisk,"
        "       AVG(netin) AS netin, AVG(netout) AS netout,"
        "       AVG(diskread) AS diskread, AVG(diskwrite) AS diskwrite,"
        "       AVG(uptime) AS uptime,"
        "       AVG(CASE WHEN status = ? THEN 1 ELSE 0 END) AS up_ratio,"
        "       COUNT(*) AS samples "
        "FROM metrics_history WHERE " + " AND ".join(where) + " "
        "GROUP BY node, vmid, bucket "
        "ORDER BY node, vmid, bucket "
        "LIMIT ?"
    )
    query_params: List[Any] = [step, step, UP_STATUS[scope]]
    # WHERE 的参数在 SELECT 参数之后（占位符按出现顺序绑定）
    query_params.extend(params)
    query_params.append(_QUERY_ROW_LIMIT + 1)

    async with database.connect() as db:
        cursor = await db.execute(sql, tuple(query_params))
        rows = await cursor.fetchall()

    truncated = len(rows) > _QUERY_ROW_LIMIT
    if truncated:
        rows = rows[:_QUERY_ROW_LIMIT]

    series: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for row in rows:
        node_name = str(row["node"] or "")
        row_vmid = int(row["vmid"] or 0)
        entry = series.get(_series_key(node_name, row_vmid))
        if entry is None:
            entry = {
                "node": node_name,
                "vmid": row_vmid if scope == SCOPE_GUEST else None,
                "name": str(row["name"] or ""),
                "guest_type": str(row["guest_type"] or "") or None,
                "points": [],
            }
            series[_series_key(node_name, row_vmid)] = entry
        entry["points"].append(
            {
                "ts": int(row["bucket"]),
                "cpu": _num(row["cpu"]),
                "maxcpu": _int(row["maxcpu"]),
                "mem": _num(row["mem"]),
                "maxmem": _int(row["maxmem"]),
                "disk": _num(row["disk"]),
                "maxdisk": _int(row["maxdisk"]),
                "netin": _num(row["netin"]),
                "netout": _num(row["netout"]),
                "diskread": _num(row["diskread"]),
                "diskwrite": _num(row["diskwrite"]),
                "uptime": _num(row["uptime"]),
                "up_ratio": round(_num(row["up_ratio"]) or 0.0, 4),
                "samples": int(row["samples"] or 0),
            }
        )

    ordered = sorted(
        series.values(),
        key=lambda s: (s["node"], s["vmid"] if s["vmid"] is not None else 0),
    )
    truncated = truncated or len(ordered) > max_series

    return {
        "scope": scope,
        "step": step,
        "from": start,
        "to": end,
        "series": ordered[:max_series],
        "truncated": truncated,
    }


async def coverage() -> Dict[str, Any]:
    """历史覆盖情况：最早/最晚采样时间。用于界面提示「历史从什么时候开始」。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT MIN(ts) AS earliest, MAX(ts) AS latest FROM metrics_history"
        )
        row = await cursor.fetchone()

    earliest = _int(row["earliest"]) if row else None
    latest = _int(row["latest"]) if row else None
    return {
        "enabled": bool(settings.metrics_history_enabled),
        "interval": int(settings.metrics_sample_interval),
        "retention_days": int(settings.metrics_retention_days),
        "earliest": earliest,
        "latest": latest,
    }


# ---------------------------------------------------------------- 容量预测用
async def capacity_series(start: int, step: int = 3600) -> Dict[str, Any]:
    """集群根分区已用量的历史时间线（容量预测用）。

    每个采样时刻先把各节点的 ``disk`` 求和得到「集群已用量」，再按 ``step``
    分桶取平均 —— 不能直接对整段区间求 SUM，那会把同一时刻的多行累加多次。

    返回 ``{"points": [(ts, used_bytes)], "total": 容量上限}``；
    ``points`` 不足两个点时由调用方回落到 PVE 的 rrddata。
    """
    sql = (
        "SELECT bucket, AVG(used) AS used, MAX(total) AS total FROM ("
        "  SELECT FLOOR(ts / ?) * ? AS bucket, ts,"
        "         SUM(disk) AS used, SUM(maxdisk) AS total"
        "  FROM metrics_history WHERE scope = ? AND ts >= ?"
        "  GROUP BY ts"
        ") AS per_ts GROUP BY bucket ORDER BY bucket"
    )
    async with database.connect() as db:
        cursor = await db.execute(
            sql, (step, step, SCOPE_NODE, int(start))
        )
        rows = await cursor.fetchall()

    points: List[Tuple[int, float]] = []
    total = 0.0
    for row in rows:
        total = max(total, _num(row["total"]) or 0.0)
        points.append((int(row["bucket"]), _num(row["used"]) or 0.0))
    return {"points": points, "total": total}
