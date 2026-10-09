"""虚拟机 / 容器的创建时间。

## 两个来源，按可信度排序

1. **面板自己的记录**（表 ``guest_created_record``）：面板发起的新建 / 克隆 /
   恢复 / 导入，成功那一刻记一条。这是唯一**准确**的来源。
2. **PVE 写在 config 里的 ``meta``**：``creation-qemu=9.2.0,ctime=1789814562``。
   ``/cluster/resources`` 里没有创建时间，config 里也没有独立的 ``ctime`` 键
   （实测 PVE 8.4 / 9.2 的全部 config 键），``meta`` 是 PVE 侧唯一的记录。

## 为什么必须优先看面板记录

**PVE 的克隆 / 恢复是整体复制 config，``meta`` 也跟着过去了**：

* 实测 pve9 上克隆出来的 104，``meta`` 完全等于模板的（``creation-qemu=9.2.0``
  加上同一个 ``ctime`` = 2026-09-19 18:42:42），而克隆实际发生在 09-29 09:55；
* 反过来，``qmcreate`` 建的 106 / 107 的 ctime 与建机任务**精确到秒一致** ——
  可见 ctime 本身确实是「创建那一刻」，只是会被 clone / restore 带走。

所以对 PVE 上的存量机器（面板之外建的、或面板早期版本建的），``meta.ctime`` 只能
当参考值，界面上注明「克隆、恢复出来的机器会继承来源机器的时间」。面板自己发起的
操作另有审计记录（``vm.create`` / ``vm.clone`` / ``backup.restore`` …），存量机器靠
:func:`_backfill_from_audit` 补一次 —— 那是唯一能把「继承来的时间」纠正回「实际
创建时间」的办法。

## 为什么不拿 PVE 任务日志去凑

``/cluster/tasks`` 只返回最近两天的窗口；逐台查 ``/nodes/{node}/tasks?vmid=`` 又贵
（每台一次请求）又可能早被日志轮转，凑出来的「最早建机任务」极可能是一次 restore。
面板自己的审计日志没有这些限制（本地面板库、全量保留）。

## 缓存

取数要每台一次 config 请求，所以带一层进程内缓存：

* **有值**的条目按 :data:`HIT_TTL_SECONDS`（一天）过期 —— 创建时间不会变，但这个
  上限是兜底：同 VMID 被删了再建一次（在面板之外操作）时，旧值不能永久贴在新机器上；
* **确认没有**（PVE 侧没写 ``meta``）的条目按 :data:`MISS_TTL_SECONDS` 过期 ——
  这个值刻意只有 15 分钟：建机瞬间 PVE 可能还没写好 ``meta``，先读到一次就会让这台
  机器「长期没有创建时间」（实测踩到过）；而真正没有 ``meta`` 的存量机器（PVE 7 及
  更早建的），每 15 分钟重问一次也只是每台每小时 4 次请求；
* **请求失败**的条目按 :data:`ERROR_TTL_SECONDS` 过期。

缓存键是 ``连接|节点|VMID|类型``，而 **VMID 会被回收**，所以 :func:`fill` 每轮还会
把「本轮列表里已经不存在的键」清掉。清理只在**本轮实际出现过的** ``连接|节点|类型``
范围内进行，避免「一次只查 qemu 的请求把容器的缓存也抹掉」。

多 worker 部署时每个 worker 各持一份：代价是每个 worker 各请求一轮，收益是列表
请求本身不再为此变慢。和 :mod:`app.reportcache` 同一个取舍，理由也一样。
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import database
from .pve import ProxmoxClient, all_connection_clients, parallel

logger = logging.getLogger(__name__)

# 缓存时长（秒），理由见模块说明。
HIT_TTL_SECONDS = 24 * 3600.0
MISS_TTL_SECONDS = 15 * 60.0
ERROR_TTL_SECONDS = 300.0

# 单次列表请求最多为多少台机器去读 config（每台一次请求）。超出的留到下一轮
# 轮询，列表 10 秒一次，很快就补齐 —— 冷启动时不能为了一个附加字段把几百台
# 机器的一次请求全压在一条响应里。
FETCH_BUDGET = 64

# ctime 的合理区间：2000-01-01 之前只能是解析出了别的数字；未来时间除了几天的
# 时钟偏差以外也当脏数据，免得界面出现「创建于 2087 年」。
MIN_TIMESTAMP = 946_684_800
_FUTURE_SLACK = 86_400

# 面板记录表：面板发起过的建机操作，一台机器一行。
SCHEMA = """
CREATE TABLE IF NOT EXISTS guest_created_record (
    conn_id     VARCHAR(64)  NOT NULL DEFAULT '',
    node        VARCHAR(128) NOT NULL DEFAULT '',
    vmid        INT          NOT NULL DEFAULT 0,
    guest_type  VARCHAR(16)  NOT NULL DEFAULT '',
    created     BIGINT       NOT NULL DEFAULT 0,
    source      VARCHAR(16)  NOT NULL DEFAULT '',
    username    VARCHAR(64)  NOT NULL DEFAULT '',
    recorded_at DOUBLE       NOT NULL DEFAULT 0,
    PRIMARY KEY (conn_id, node, vmid, guest_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# 只有**克隆**需要回填纠正：普通新建（create / import）PVE 会写一份新的 meta，
# 本来就是准的；恢复（backup.restore）的审计 target 是卷标识而不是节点/VMID，
# 按 target 匹配不到（那条留给 record() 覆盖将来发起的恢复）。
#
# 刻意不把 vm.create / ct.create 放进来的另一个原因：VMID 会被回收，审计里
# 「同节点同 VMID」的建机记录可能是**上一台**机器的（实测 pve9/101 今天新建的
# 容器被回填成了昨天那台虚拟机的建机时间）。
_AUDIT_ACTIONS = ("vm.clone", "ct.clone")

#: 会留下「来源 -> 目标」的审计动作：克隆，以及**重装**。
#:
#: 重装虽然在 PVE 那边不叫克隆，但它换掉的是整块系统盘 —— 换了模板，这台机器的
#: 来源就变了，概览里的「来源模板」必须跟着变，否则用户会拿着一行过期的信息去
#: 判断「删掉这个模板会不会把机器弄坏」。
#:
#: 与 _AUDIT_ACTIONS 刻意分开：重装不是「建机」，它的时间不能拿去回填创建时间。
_SOURCE_ACTIONS = ("vm.clone", "ct.clone", "vm.reinstall")

# 回填出来的时间必须**比继承来的 meta 晚**这么久，才算「这台的 meta 是继承的」。
# 用同一秒创建时不该被误判（克隆的 meta 来自几天前甚至几个月前的模板）。
_BACKFILL_MIN_GAP = 60

# key -> (过期时刻, 值)。值 None 表示「问过了，没有」。
_cache: Dict[str, Tuple[float, Optional[int]]] = {}

# 已经向审计日志回填过的键（每个 worker 每台机器只查一次；查到就落库，查不到
# 就记住进程内不再重复查）。回填的日期一旦落库，后续轮询直接命中表。
_backfilled: set = set()

# 节点名是不是全局唯一（回填的前提）：(检查时刻, 节点名 -> 出现在几条连接上)
_node_name_counts: Tuple[float, Dict[str, int]] = (0.0, {})
_NODE_NAME_TTL = 300.0


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)


def cache_key(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> str:
    """缓存键：连接 + 节点 + VMID + 类型。

    四段都不能省：多台 PVE 上可以有同名节点、同 VMID 的机器（实测本机
    pve-master 与 pve9 各有一个 vmid=100），少一段就会把别人家的创建时间
    显示到这台机器上。类型也要带 —— VMID 空间虽然共用，但读取的端点不同
    （``/qemu/`` 与 ``/lxc/``）。
    """
    return f"{conn_id or ''}|{node or ''}|{vmid or ''}|{guest_type or ''}"


def parse_created(config: Optional[Dict[str, Any]]) -> Optional[int]:
    """从 guest config 里取出创建时间（秒级 Unix 时间戳），取不到返回 ``None``。

    ``meta`` 是 PVE 的「属性字符串」：``creation-qemu=9.2.0,ctime=1789814562``
    （容器是 ``creation-lxc=...``）。只认 ``ctime`` 这个键 —— ``creation-qemu``
    是版本号不是时间，把它当时间解析会得到一串没意义的数字。

    注意：克隆 / 恢复出来的机器会继承来源机器的这个值，见模块说明。
    """
    meta = (config or {}).get("meta")
    if not meta:
        return None
    for part in str(meta).split(","):
        name, _, value = part.partition("=")
        if name.strip() != "ctime":
            continue
        value = value.strip()
        if not value.isdigit():
            return None
        stamp = int(value)
        now = int(time.time())
        if stamp < MIN_TIMESTAMP or stamp > now + _FUTURE_SLACK:
            return None
        return stamp
    return None


def _entry(key: str) -> Optional[Tuple[float, Optional[int]]]:
    """取缓存条目，过期的顺手清掉（避免只增不减）。"""
    hit = _cache.get(key)
    if hit is None:
        return None
    if time.time() >= hit[0]:
        _cache.pop(key, None)
        return None
    return hit


def cached(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> Optional[int]:
    """缓存里现有的值；没有/已过期都返回 ``None``，且**不会**去请求 PVE。

    列表接口用它直接填初值 —— 命中时连一次 PVE 请求都不用发。
    """
    hit = _entry(cache_key(conn_id, node, vmid, guest_type))
    return hit[1] if hit else None


def clear() -> None:
    """清空进程内缓存（测试与「连接被改动」时用）。表里的记录不动。"""
    _cache.clear()
    _backfilled.clear()


def forget(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> None:
    """忘掉一台机器：缓存条目立即失效（同步）。

    数据库那一行由调用方 :func:`drop_record` 删 —— 删除接口是异步的，
    别把两件事混在一起，免得忘了其中一件。
    """
    _cache.pop(cache_key(conn_id, node, vmid, guest_type), None)
    _backfilled.discard(cache_key(conn_id, node, vmid, guest_type))


# ------------------------------------------------------------------ 面板记录表
async def record(
    conn_id: Any,
    node: Any,
    vmid: Any,
    guest_type: Any,
    *,
    when: Optional[float] = None,
    source: str = "create",
    username: str = "",
) -> Optional[int]:
    """记一条「这台机器是什么时候、以什么方式建出来的」。

    ``source``：``create`` / ``clone`` / ``restore`` / ``import`` / ``audit``。
    落库失败只记日志：它是列表的附加字段，不该让建机本身失败。
    """
    if not node or vmid is None:
        return None
    stamp = int(when if when is not None else time.time())
    key = cache_key(conn_id, node, vmid, guest_type)

    # 先写进程内缓存：面板刚建的机器，下一次列表轮询就能显示，不必等 PVE 写好
    # meta（那正是「新建的机器一直没有创建时间」的成因之一）。落库失败也不影响
    # 这一个 —— 日期本身是对的，落库只是为后续进程留档。
    _cache[key] = (time.time() + HIT_TTL_SECONDS, stamp)
    _backfilled.add(key)

    try:
        async with database.connect() as db:
            await db.execute(
                "REPLACE INTO guest_created_record "
                "(conn_id, node, vmid, guest_type, created, source, username, recorded_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(conn_id or ""),
                    str(node),
                    int(vmid),
                    str(guest_type or "qemu"),
                    stamp,
                    str(source or ""),
                    str(username or ""),
                    time.time(),
                ),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("记录创建时间失败（%s/%s）", node, vmid, exc_info=True)
    return stamp


async def drop_record(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> None:
    """删掉面板记录（机器被删除时调）。"""
    forget(conn_id, node, vmid, guest_type)
    try:
        async with database.connect() as db:
            await db.execute(
                "DELETE FROM guest_created_record "
                "WHERE conn_id = ? AND node = ? AND vmid = ? AND guest_type = ?",
                (str(conn_id or ""), str(node), int(vmid), str(guest_type or "qemu")),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("删除创建时间记录失败（%s/%s）", node, vmid, exc_info=True)


async def _records_for(conn_id: str) -> Dict[str, int]:
    """整条连接的记录，一次查出来（表很小，按连接取完更省事）。"""
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT node, vmid, guest_type, created FROM guest_created_record "
                "WHERE conn_id = ?",
                (str(conn_id or ""),),
            )
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001 - 读不到就退化成「没有面板记录」
        logger.debug("读取创建时间记录失败（conn=%s）", conn_id, exc_info=True)
        return {}
    return {
        cache_key(conn_id, row[0], row[1], row[2]): int(row[3])
        for row in rows or []
        if row and row[3]
    }


async def _drop_stale_records(conn_id: str, node: str, guest_type: str, vmids: List[int]) -> None:
    """清掉「本轮列表里已经不存在的机器」的记录。

    VMID 会被回收：机器在面板之外删掉又建一台同号的，旧记录会把上一台的时间
    贴到新机器上。只在本轮实际出现过、且 vmids 非空的 ``连接|节点|类型`` 范围内清。
    """
    if not node or not guest_type or not vmids:
        return
    placeholders = ", ".join("?" for _ in vmids)
    try:
        async with database.connect() as db:
            await db.execute(
                "DELETE FROM guest_created_record WHERE conn_id = ? AND node = ? "
                f"AND guest_type = ? AND vmid NOT IN ({placeholders})",
                (str(conn_id or ""), str(node), str(guest_type), *[int(v) for v in vmids]),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("清理创建时间记录失败（%s/%s）", node, guest_type, exc_info=True)


# ------------------------------------------------------------------ 审计日志回填
async def _node_names_are_unique() -> Dict[str, int]:
    """节点名 → 出现在几条连接上（5 分钟缓存）。

    回填审计记录的前提：审计表的 ``target`` 是 ``节点/VMID``，**不含连接**，
    多台 PVE 上有同名节点时无法判断那条记录属于哪一台 —— 那时宁可不填。
    """
    global _node_name_counts
    checked_at, counts = _node_name_counts
    if counts and time.time() - checked_at < _NODE_NAME_TTL:
        return counts

    result: Dict[str, int] = {}
    for _profile, client in all_connection_clients():
        try:
            nodes = await client.nodes() or []
        except Exception:  # noqa: BLE001 - 探测不到就当作不可判定
            return {}
        for item in nodes:
            name = str(item.get("node") or "")
            if name:
                result[name] = result.get(name, 0) + 1
    _node_name_counts = (time.time(), result)
    return result


async def _backfill_from_audit(
    conn_id: Any, node: Any, vmid: Any, guest_type: Any, meta: Optional[int]
) -> Optional[int]:
    """用面板自己的审计日志纠正「克隆继承来的 meta」。

    面板发起的克隆会留审计（``vm.clone`` / ``ct.clone``，target 形如
    ``pve9/100 -> pve9/104``）—— 那是把继承来的 ``meta.ctime`` 纠正回**实际
    克隆时刻**的唯一依据。取**最近**的一条：同一 VMID 被删了又建时，当前这台
    对应最后一次克隆。

    两条硬性前提，缺一不填：

    * ``meta`` 必须存在，且回填时间要比它晚 :data:`_BACKFILL_MIN_GAP` 以上 ——
      只有「meta 明显早于这次克隆」才说明 meta 是继承来的。没有 meta 时不填：
      那种情况下审计里同 VMID 的记录完全可能是**上一台**机器的（实测踩到过：
      今天新建的容器被回填成昨天那台虚拟机的建机时间），一个凭空捏造的日期
      比「—」更糟；
    * 节点名全局唯一（审计 target 不含连接，同名节点分不清哪台 PVE）。

    每个 worker 每台机器只尝试一次。
    """
    key = cache_key(conn_id, node, vmid, guest_type)
    if key in _backfilled or not node or vmid is None or not meta:
        return None
    _backfilled.add(key)

    counts = await _node_names_are_unique()
    if counts.get(str(node), 0) != 1:
        return None

    actions = ", ".join("?" for _ in _AUDIT_ACTIONS)
    try:
        async with database.connect() as db:
            # target_guest 是 target 的生成列（取 `a -> b` 的最后一段，见 store.py）：
            # 建机记录 `pve9/100` 与克隆记录 `pve9/100 -> pve9/104` 都能命中。
            # 原先写成 `target = ? OR target LIKE '%-> …'`，两条都用不上索引，
            # 每台机器一次全表扫描 —— 而它在虚拟机列表的首屏路径上。
            cursor = await db.execute(
                f"SELECT timestamp FROM audit_log WHERE action IN ({actions}) "
                "AND target_guest = ? ORDER BY timestamp DESC LIMIT 1",
                (*_AUDIT_ACTIONS, f"{node}/{vmid}"),
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001 - 回填失败就退化成 meta 值
        logger.debug("审计日志回填创建时间失败（%s/%s）", node, vmid, exc_info=True)
        return None

    if not row or not row[0]:
        return None
    stamp = int(row[0])
    now = int(time.time())
    if stamp < MIN_TIMESTAMP or stamp > now + _FUTURE_SLACK:
        return None
    if stamp <= int(meta) + _BACKFILL_MIN_GAP:
        # 与 meta 同一时间量级：这台机器就是那时候建的，meta 本来就是准的
        return None
    return await record(conn_id, node, vmid, guest_type, when=stamp, source="backfill")


# ------------------------------------------------------------------ 克隆来源
#: 磁盘键（与 vmconfig / reinstall 里同一套命名）
_DISK_KEY_RE = re.compile(r"^(scsi|virtio|sata|ide)\d+$")
#: 链接克隆的盘名：``local:102/base-102-disk-0.qcow2``
_BASE_VOLID_RE = re.compile(r"(?:^|/)base-(\d+)-disk-")


def base_template_vmid(value: Any) -> int:
    """从磁盘卷名里反推链接克隆的来源模板 VMID，取不到返回 0。

    链接克隆的盘名长这样：``local:102/base-102-disk-0.qcow2`` —— 中间那个 102
    就是模板 VMID。整盘克隆没有 ``base-`` 前缀（那是一块复制出来的独立盘），所以
    这条只能覆盖链接克隆；面板的「快速部署」与「重装」默认都走链接克隆，覆盖到的
    正是最常见的那批机器。
    """
    match = _BASE_VOLID_RE.search(str(value or ""))
    return int(match.group(1)) if match else 0


def config_source(config: Dict[str, Any], node: Any) -> Dict[str, Any]:
    """从机器配置里反推克隆来源（只认链接克隆的 base 卷）。

    返回 ``{"node", "vmid"}``；认不出来返回空 dict。
    """
    for key, value in (config or {}).items():
        if not _DISK_KEY_RE.match(str(key)):
            continue
        vmid = base_template_vmid(value)
        if vmid:
            return {"node": str(node or ""), "vmid": vmid}
    return {}


async def source_of(
    conn_id: Any, node: Any, vmid: Any, guest_type: Any
) -> Dict[str, Any]:
    """这台机器是从哪个模板克隆来的：``{"node", "vmid"}``；取不到返回空 dict。

    数据来自面板自己的审计日志 —— 会写下 ``源节点/VMID -> 目标节点/VMID`` 的动作
    有克隆（``vm.clone`` / ``ct.clone``）与**重装**（``vm.reinstall``：换模板就等于
    换来源）。PVE 那边问不出来：克隆只是把 config 整体复制一份，来源信息根本不会
    被保留。

    取**最近**的一条：同一台机器可能最初克隆自某个模板、后来又重装成另一个模板，
    当前这块系统盘来自最后那一次。

    与创建时间回填同一条前提：节点名必须全局唯一（审计的 target 里没有连接信息，
    多台 PVE 上的同名节点分不清是哪一台）。拿不准时**宁可空着**也不猜 ——
    用户看到「来源：ubuntu-2204」是会去信它的，然后据此决定删不删那个模板。
    """
    if not node or vmid is None:
        return {}
    counts = await _node_names_are_unique()
    if counts.get(str(node), 0) != 1:
        return {}

    actions = ", ".join("?" for _ in _SOURCE_ACTIONS)
    try:
        async with database.connect() as db:
            # 只看成功的：失败的那次重装没动过系统盘，来源仍然是上一个模板
            cursor = await db.execute(
                f"SELECT target FROM audit_log WHERE action IN ({actions}) "
                "AND result = 'success' AND target LIKE ? "
                "ORDER BY timestamp DESC LIMIT 1",
                (*_SOURCE_ACTIONS, f"%-> {node}/{vmid}"),
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001 - 查不到就当「没有来源」，不影响详情页
        logger.debug("查询克隆来源失败（%s/%s）", node, vmid, exc_info=True)
        return {}

    if not row or not row[0]:
        return {}
    origin = str(row[0]).split("->", 1)[0].strip()
    src_node, _, src_vmid = origin.rpartition("/")
    if not src_vmid.isdigit():
        return {}
    return {"node": src_node or str(node), "vmid": int(src_vmid)}


# ------------------------------------------------------------------ 取数
async def resolve(
    conn_id: Any,
    node: Any,
    vmid: Any,
    guest_type: Any,
    config: Optional[Dict[str, Any]],
) -> Optional[int]:
    """单台机器（详情页）：面板记录优先，其次 config 里的 ``meta.ctime``。

    详情接口本来就把 config 拿在手里，所以这里只多查一次记录表；命中进程内
    缓存时连这一次查询都省掉。
    """
    key = cache_key(conn_id, node, vmid, guest_type)
    hit = _entry(key)
    if hit is not None and hit[1] is not None:
        return hit[1]
    records = await _records_for(str(conn_id or ""))
    value = records.get(key)
    if value:
        _cache[key] = (time.time() + HIT_TTL_SECONDS, value)
        return value

    meta = parse_created(config)
    # 与列表口径一致：克隆出来的机器，meta 是模板带过来的，用审计记录纠正
    corrected = await _backfill_from_audit(
        conn_id, node, vmid, guest_type, meta
    )
    if corrected:
        return corrected
    if meta:
        _cache[key] = (time.time() + HIT_TTL_SECONDS, meta)
    return meta


async def _fetch(
    client: ProxmoxClient, group: List[Dict[str, Any]], key: str
) -> None:
    """为同一台机器读一次 config，结果写进缓存并写回 ``group`` 里的每个条目。

    ``group`` 里的条目按缓存键分组，node / vmid / type 必然相同（键就是它们拼
    出来的），所以只取第一个问 PVE、但值要写到**每一个**上 —— 同一次列表里
    同一台机器出现多次时，只给第一个赋值会让其余几行空着。
    """
    head = group[0]
    node, vmid, guest_type = head.get("node"), head.get("vmid"), head.get("type")
    try:
        if guest_type == "lxc":
            config = await client.lxc_config(node, vmid)
        else:
            config = await client.qemu_config(node, vmid)
    except Exception:  # noqa: BLE001 - 附加字段取不到，不该让整个列表请求失败
        _cache[key] = (time.time() + ERROR_TTL_SECONDS, None)
        return

    value = parse_created(config)
    if value is None:
        _cache[key] = (time.time() + MISS_TTL_SECONDS, None)
        return
    _cache[key] = (time.time() + HIT_TTL_SECONDS, value)
    for item in group:
        item["created"] = value


async def fill(
    client: ProxmoxClient,
    items: Iterable[Dict[str, Any]],
    *,
    budget: int = FETCH_BUDGET,
    limit: int = 8,
) -> None:
    """就地为 ``items`` 补 ``created`` 字段（取不到的保持 ``None``）。

    顺序：面板记录 → 审计回填 → 进程内缓存 → 读 config 的 ``meta``。
    一轮最多 ``budget`` 台机器去读 config（按机器去重后再数）。任何失败都只是
    「这一轮没有值」，绝不抛出 —— 它是列表的附加字段，不是列表的前提。
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for item in items:
        key = cache_key(
            item.get("connection_id"),
            item.get("node"),
            item.get("vmid"),
            item.get("type"),
        )
        groups.setdefault(key, []).append(item)

    if not groups:
        return

    conn_id = str(groups[next(iter(groups))][0].get("connection_id") or "")
    records = await _records_for(conn_id)

    pending: List[Tuple[str, List[Dict[str, Any]]]] = []
    without_record: List[Tuple[str, List[Dict[str, Any]]]] = []
    for key, group in groups.items():
        value = records.get(key)
        if value:
            for item in group:
                item["created"] = value
            continue
        if key not in records:
            without_record.append((key, group))
        hit = _entry(key)
        if hit is None:
            pending.append((key, group))
        elif hit[1] is not None:
            for item in group:
                item["created"] = hit[1]

    if pending:
        await parallel(
            (_fetch(client, group, key) for key, group in pending[:budget]), limit=limit
        )

    # 克隆出来的机器：PVE 的 meta 是模板带过来的，用面板的审计记录纠正成实际克隆
    # 时刻。必须放在读完 config 之后 —— 判断依据是「审计时间明显晚于 meta」，
    # 而 meta 只有读进来才知道（见 _backfill_from_audit）。
    #
    # 并发跑：一台一次审计查询（那条 SQL 带 OR + 前置通配的 LIKE，用不上索引），
    # 串行时一台几十毫秒、机器一多就是首屏看得见的等待 —— 而这批查询彼此无关。
    # 每台每 worker 只查一次的去重在 _backfill_from_audit 里（_backfilled 集合），
    # 所以并发不会把同一个 key 查两遍。
    heads = [group for _key, group in without_record if group and group[0].get("created")]
    if heads:
        values = await parallel(
            (
                _backfill_from_audit(
                    group[0].get("connection_id"),
                    group[0].get("node"),
                    group[0].get("vmid"),
                    group[0].get("type"),
                    group[0].get("created"),
                )
                for group in heads
            ),
            limit=limit,
        )
        for group, value in zip(heads, values):
            if value:
                for item in group:
                    item["created"] = value

    for conn, node, guest_type, alive in _sweep(groups, records):
        await _drop_stale_records(conn, node, guest_type, alive)


def _scope_of(key: str) -> Optional[Tuple[str, str, str]]:
    """把缓存键拆成 ``(连接, 节点, 类型)`` —— 清理时的作用范围。

    键固定是 ``连接|节点|VMID|类型`` 四段（节点名与连接 id 都不含 ``|``），
    拆不出来的一律不碰。
    """
    parts = key.split("|")
    if len(parts) != 4:
        return None
    return (parts[0], parts[1], parts[3])


def _sweep(
    groups: Dict[str, List[Dict[str, Any]]], records: Dict[str, int]
) -> List[Tuple[str, str, str, List[int]]]:
    """清掉「本轮列表里已经不存在的机器」的缓存值，返回需要清记录行的范围。

    VMID 会被回收：删掉一台再建一台同号的，旧值（或旧记录行）会贴到新机器上，
    比「显示 —」更难发现。清理范围限定在本轮**实际出现过**的
    ``连接|节点|类型`` 内 —— 一次只查 qemu 的请求不该把容器的缓存抹掉，
    某个连接/类型这一轮一台机器都没有时也不动它。

    返回值为 ``(连接, 节点, 类型, 还活着的 VMID 列表)``，交给调用方清表里的
    陈旧行；正常情况下这个列表是空的，不产生写库。
    """
    alive: Dict[Tuple[str, str, str], set] = {}
    for key, group in groups.items():
        scope = _scope_of(key)
        if scope is None:
            continue
        alive.setdefault(scope, set()).add(str(group[0].get("vmid")))

    stale_scopes: Dict[Tuple[str, str, str], set] = {}
    for key in list(_cache) + list(records):
        scope = _scope_of(key)
        if scope is None or scope not in alive:
            continue
        vmid = key.split("|")[2]
        if vmid and vmid not in alive[scope]:
            _cache.pop(key, None)
            records.pop(key, None)
            stale_scopes.setdefault(scope, set()).add(vmid)

    out: List[Tuple[str, str, str, List[int]]] = []
    for (conn, node, guest_type), _gone in stale_scopes.items():
        vmids = sorted(int(v) for v in alive[(conn, node, guest_type)] if str(v).isdigit())
        if vmids:
            out.append((conn, node, guest_type, vmids))
    return out
