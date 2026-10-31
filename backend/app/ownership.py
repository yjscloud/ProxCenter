"""资源归属：把面板里的资源绑定到创建者，实现用户之间的数据隔离。

为什么需要单独一张表
--------------------
面板现有的权限模型只有「角色 → 权限字符串」的静态映射，没有任何资源级粒度；
而虚拟机只存在于 Proxmox 侧、面板不落库，穿透规则/告警规则此前也都是全局单份。
要做到「test 创建的虚拟机只有他自己能看见」，必须自己记录归属。

隔离规则
--------
* 管理员（role == admin）是超管视角，始终能看到并管理全部资源。
* 普通用户只能看到/操作自己名下的资源；**没有归属记录的存量资源对普通用户不可见**
  （严格隔离）。

单点真相与「变更入口」
----------------------
本模块是 owner 的**唯一事实源**：业务行（快照标记、备份 notes、规则条目）里
另存的用户名都只是历史/展示，不参与鉴权判定。

归属的变更（指派 / 收回 / 账号删除）一律走 :func:`transfer_guest` /
:func:`transfer_host` / :func:`forget_user`，因为它们还要顺带做完三件容易漏的事：

1. 清掉这台机器名下**快照的归属标记**（快照跟着机器走，不跟着人走）；
2. 作废按用户分档的读缓存与额度读数（否则 10–60 秒内新旧主人看到的都是旧账）；
3. 返回变更前的归属，供审计记录 ``previous``。

逐个路由自己 upsert 一行，就是这些不一致的来源 —— 新增入口请复用上面的函数。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


from . import database

logger = logging.getLogger(__name__)

# 资源类别
#: 虚拟机（qemu）的归属。历史上容器也记在这里，现已拆到 :data:`KIND_CT`；
#: 升级时 :func:`migrate_guest_kinds` 会把存量记录改过来。
KIND_VM = "vm"
#: 容器（lxc）的归属。与 :data:`KIND_VM` 分开记录，权限也各自独立（``vm.*`` /
#: ``ct.*``）。ref 的拼法与虚拟机完全一致（``<连接>:<节点>:<vmid>``）—— VMID 在
#: 集群内唯一，同一条 ref 不可能既是虚拟机又是容器。
KIND_CT = "ct"
KIND_SNAPSHOT = "snapshot"
# 受管主机（ssh_hosts 的一行）。ref 就是主机 id —— 主机本身没有连接/节点那层
# 复合主键，用它自己的 id 就够了。
KIND_SSH_HOST = "ssh_host"
#: 已上传到存储 import 目录里的导入文件。导入文件是**共享目录里的普通文件**，
#: 不像虚拟机那样天然带 vmid；不记归属就是「谁都能看见、谁都能删」。
KIND_IMPORT = "import"

#: 两类客户机（虚拟机 / 容器）的归属类别，顺序固定便于复用。
GUEST_KINDS: Tuple[str, ...] = (KIND_VM, KIND_CT)


def kind_for_type(guest_type: Any) -> str:
    """把 PVE 的客户机类型（``qemu`` / ``lxc``）换算成归属类别。

    认不出来的一律当虚拟机：这个参数来自 URL / 列表数据，一个拼错的值不该
    让归属校验整体报错（与 :func:`quota.normalise_kind` 同一取舍）。
    """
    return KIND_CT if str(guest_type or "").strip().lower() == "lxc" else KIND_VM



# 复合主键与索引涉及 TEXT 列，必须是定长 VARCHAR
SCHEMA = """
CREATE TABLE IF NOT EXISTS resource_owner (
    kind     VARCHAR(32)  NOT NULL,
    ref      VARCHAR(191) NOT NULL,
    username VARCHAR(64)  NOT NULL,
    created  BIGINT       NOT NULL,
    PRIMARY KEY (kind, ref),
    KEY idx_owner_user (kind, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def import_ref(connection_id: str, storage: str, volume: str) -> str:
    """导入文件的归属标识。

    ``volume`` 是**相对卷名**（``import/xx.ova``，与 :func:`import_metadata` 收的
    同一个值），所以 ref 里带 ``/`` 是正常的；列宽 191 足够。
    """
    return f"{connection_id or '-'}:{storage}:{volume}"


def vm_ref(connection_id: str, node: str, vmid: Any) -> str:
    """虚拟机的归属标识。

    带上连接 id：多台 PVE 合并展示时，不同主机上可能存在同名节点 + 相同 VMID，
    只用 node/vmid 会把两台机器的同名虚拟机混为一谈。
    """
    return f"{connection_id or '-'}:{node}:{vmid}"


def snapshot_ref(connection_id: str, node: str, vmid: Any, name: str) -> str:
    """快照的归属标识：在所属虚拟机 ref 后追加 ``/快照名``。"""
    return f"{vm_ref(connection_id, node, vmid)}/{name}"


async def set_owner(kind: str, ref: str, username: str) -> None:
    """记录归属（重复记录时覆盖）。"""
    if not ref or not username:
        return
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "resource_owner",
                ["kind", "ref", "username", "created"],
                ["kind", "ref"],
                ["username"],
            ),
            (kind, ref, username, int(time.time())),
        )
        await db.commit()


async def delete_owner(kind: str, ref: str) -> None:
    async with database.connect() as db:
        await db.execute(
            "DELETE FROM resource_owner WHERE kind = ? AND ref = ?", (kind, ref)
        )
        await db.commit()


async def all_refs() -> List[Tuple[str, str, str]]:
    """整张归属表的 ``(kind, ref, username)``。

    给对账作业用。不按类别分批拿是刻意的：对账要比对的是「这本账 vs PVE 实际
    清单」，分几次拿中间可能被写操作插进来，而对账**会删记录** —— 拿一份自相
    矛盾的快照去删，比晚一轮更糟。
    """
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT kind, ref, username FROM resource_owner"
        )
        return [
            (str(kind), str(ref or ""), str(username or ""))
            for kind, ref, username in await cursor.fetchall()
        ]


async def forget_refs(pairs: Sequence[Tuple[str, str]]) -> int:
    """按 ``(kind, ref)`` 批量删归属记录，返回删除条数。

    与 :func:`forget_guest` 的分工：那个是「删一台机器」的精确清理（走删除接口），
    这个是「对账时按清单批量清」。两者都不做归属的重新指派 —— 机器还在但没人
    认领是**事实**，该由管理员决定给谁，不该由作业猜。
    """
    doomed = [(str(kind), str(ref)) for kind, ref in pairs if ref]
    if not doomed:
        return 0
    # 一条 ``(kind, ref) IN ((?, ?), …)`` 删完，按 500 条分片（MySQL 的占位符
    # 上限与 SQL 文本长度都要留余量）。原来是一对一 DELETE，几百条就是几百轮往返。
    async with database.connect() as db:
        for start in range(0, len(doomed), 500):
            chunk = doomed[start : start + 500]
            marks = ", ".join("(?, ?)" for _ in chunk)
            await db.execute(
                f"DELETE FROM resource_owner WHERE (kind, ref) IN ({marks})",
                [value for pair in chunk for value in pair],
            )
        await db.commit()
    return len(doomed)


async def forget_guest(connection_id: str, node: str, vmid: Any) -> int:
    """删掉一台机器的全部归属记录（客户机本体 + 它名下的快照），返回删除条数。

    机器都没了，这些记录再没有任何价值，却会**错伤别人**：用量是「归属表 ∩ PVE
    实时清单」的交集（见 :func:`quota.summarise_usage`），而 PVE 分配 VMID 用的是
    「最小的空闲号」—— 删掉 100 之后再建一台，新机器多半还是 100。旧记录一旦撞上
    这个号，那台**新**机器就被算到旧用户名下，于是「我把机器删了，额度却没还回来」。

    三个前缀都要认，缺一个就会漏：
      * ``<连接>:<节点>:<vmid>`` —— 现在的写法；
      * ``-:<节点>:<vmid>`` —— 单连接时代的存量记录（见 :func:`quota._legacy_refs`）；
      * 上面两者加 ``/快照名`` —— 快照归属是挂在客户机 ref 后面的。

    两类 kind 一起清（``vm`` / ``ct``）而不只清对应的那一个：容器在升级前记在
    ``vm`` 下（见 :func:`migrate_guest_kinds`），只按类型清会留下存量垃圾。
    """
    prefixes = (vm_ref(connection_id, node, vmid), vm_ref("", node, vmid))
    async with database.connect() as db:
        cursor = await db.execute("SELECT kind, ref FROM resource_owner")
        rows = await cursor.fetchall()
        doomed = [
            (str(kind), str(ref or ""))
            for kind, ref in rows
            if any(
                str(ref or "") == prefix or str(ref or "").startswith(f"{prefix}/")
                for prefix in prefixes
            )
        ]
        for kind, ref in doomed:
            await db.execute(
                "DELETE FROM resource_owner WHERE kind = ? AND ref = ?", (kind, ref)
            )
        await db.commit()
    return len(doomed)


#: 归属变更后要一并作废的读缓存前缀。这些 key 里都带着「谁」这一维
#: （owner / viewer / username），换了主人之后旧条目会把结果算到旧账上；它们的
#: TTL 是 10–60 秒，不主动作废就是「机器已经给别人了，统计里还挂在我名下」。
#: 不用 ``invalidate()`` 全清：只清这几档，避免把全站 PVE 只读缓存打成冷启动。
CACHE_PREFIXES: Tuple[str, ...] = (
    "dashboard:",
    "snapshots:",
    "backups:",
    "search:",
    "audit:actions:",
)


#: 归属代际号在 ``settings`` 里的键。多 worker 部署下靠它让别的进程的读缓存作废。
GENERATION_KEY = "ownership_generation"
#: 代际号的进程内缓存时长：每个 worker 最多每 5 秒问一次库。
GENERATION_TTL = 5.0
_generation_cache: Optional[Tuple[float, int]] = None


async def generation() -> int:
    """当前归属代际号（多进程共享），在本进程缓存 :data:`GENERATION_TTL` 秒。

    用途见 :func:`app.pvecache.set_epoch_provider`：``pvecache`` 是**进程内**缓存，
    改归属时写入方只能清掉自己那份；代际号一变，所有 worker 的旧条目一起失效。

    读不到库时沿用上一次的值（首次为 0）：它只影响缓存新鲜度，不该让读接口报错，
    也不该因为一次抖动把缓存打成「永不过期」（那样反而更脏）。
    """
    global _generation_cache
    now = time.time()
    if _generation_cache is not None and now - _generation_cache[0] < GENERATION_TTL:
        return _generation_cache[1]
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT value FROM settings WHERE `key` = ?", (GENERATION_KEY,)
            )
            row = await cursor.fetchone()
        text = str(row[0]).strip() if row else ""
        value = int(text) if text.isdigit() else 0
    except Exception:  # noqa: BLE001 - 见 docstring
        return _generation_cache[1] if _generation_cache else 0
    _generation_cache = (now, value)
    return value


async def _announce_change() -> None:
    """把代际号 +1（写库），让**其它进程**的读缓存下次访问时作废。"""
    global _generation_cache
    try:
        async with database.connect() as db:
            await db.execute(
                "INSERT INTO settings (`key`, value) VALUES (?, '1') "
                "ON DUPLICATE KEY UPDATE value = CAST(value AS UNSIGNED) + 1",
                (GENERATION_KEY,),
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 失败只影响多进程的新鲜度
        logger.warning(
            "归属代际号自增失败：其它进程的读缓存只能按 TTL 自然过期", exc_info=True
        )
    # 本进程下次读取必定回源，免得自己还拿着旧值
    _generation_cache = None


async def invalidate_caches() -> None:
    """作废随「归属人」分档的读缓存（本进程 + 其它 worker），含额度读数。

    ``quota`` 顶层 ``import`` 了本模块，这里延迟导入避开循环依赖。
    """
    from . import pvecache, quota  # noqa: PLC0415 - 见上

    for prefix in CACHE_PREFIXES:
        pvecache.invalidate(prefix)
    quota.invalidate()
    await _announce_change()


def guest_ref_prefixes(ref: str) -> Tuple[str, ...]:
    """一台客户机在归属表里可能出现的全部 ref 前缀。

    * ``<连接>:<节点>:<vmid>`` —— 现在的写法；
    * ``-:<节点>:<vmid>`` —— 单连接时代的存量写法（见 :func:`forget_guest`）。

    快照行是挂在这些前缀后面的 ``/快照名``，所以前缀必须两种都认，否则改派后
    旧标记会留在表里继续把快照算到前任名下。
    """
    guest = str(ref or "").split("/", 1)[0]
    if not guest:
        return ()
    prefixes = [guest]
    parts = guest.rsplit(":", 2)
    if len(parts) == 3 and parts[0] not in ("", "-"):
        prefixes.append(f"-:{parts[1]}:{parts[2]}")
    return tuple(dict.fromkeys(prefixes))


async def forget_snapshots(ref: str) -> int:
    """删掉一台客户机名下**快照的归属标记**，返回删除条数。

    为什么改派时要删：快照是机器的从属物，读取侧也是「标记优先、没有标记就回落
    到机器的归属」（见 :func:`vm_owner_from`）。标记一旦固化在旧主人名下，机器
    改派后那批快照就仍然算前任的 —— 前任看得见、新主人看不见，是典型的
    「安全信息不同步」。删掉标记，等于把判定统一成「快照跟着机器走」。

    只删快照行，不动机器本体那一行。
    """
    prefixes = guest_ref_prefixes(ref)
    if not prefixes:
        return 0
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref FROM resource_owner WHERE kind = ?", (KIND_SNAPSHOT,)
        )
        rows = await cursor.fetchall()
    doomed = [
        (KIND_SNAPSHOT, str(row[0]))
        for row in rows
        if any(str(row[0] or "").startswith(f"{prefix}/") for prefix in prefixes)
    ]
    return await forget_refs(doomed)


async def _retarget_active_alerts(ref: str, username: str) -> int:
    """把这台客户机还挂着的活动告警改挂到新收件人名下，返回搬动条数。

    只记日志、不往外抛：告警状态没搬过去只是「通知稍晚一点到」，让整次指派失败
    则是「归属根本没改成」—— 后者严重得多。
    """
    parts = str(ref or "").split("/", 1)[0].rsplit(":", 2)
    if len(parts) != 3:
        return 0
    connection_id = "" if parts[0] in ("", "-") else parts[0]
    try:
        from . import alerting  # noqa: PLC0415 - alerting 也 import 本模块

        return await alerting.retarget_guest(
            connection_id, parts[1], parts[2], str(username or "")
        )
    except Exception:  # noqa: BLE001
        logger.warning("改派时迁移活动告警失败：%s", ref, exc_info=True)
        return 0


async def _suspend_frp_rules(ref: str, username: str, *, restart: bool = True) -> int:
    """这台机器改派后失效的穿透规则条数，并让 frpc 重新加载（断掉那几条隧道）。

    穿透规则的目标合法性只在写入时校验过一次（见 ``app.frpguard``），机器改派
    之后那条隧道就成了「前主人仍能访问的通道」。这里不删规则、不改归属 ——
    规则仍是前主人的配置 —— 只是让渲染时把它排除掉（``frp.annotate_rules``）。

    失败只记日志：归属已经改完，那是更重要的事实；重启用下次手工操作也能补上，
    但「隧道多开一会儿」得让人在日志里看得见。
    """
    try:
        from . import frp  # noqa: PLC0415 - frp 顶层 import 本模块
    except Exception:  # noqa: BLE001
        logger.debug("穿透模块不可用，跳过隧道复核", exc_info=True)
        return 0
    try:
        count = await frp.suspend_count_for_guest(ref, username)
        # 批量指派时由调用方在最末尾统一重启一次：逐台重启会把 frpc 反复拉起，
        # 每台 1.5 秒，200 台就是一串「隧道全断」的空窗。
        if count and restart:
            error = await frp.restart_if_running()
            if error:
                logger.warning(
                    "改派后重启 frpc 失败（%s 条穿透规则已失效）：%s", count, error
                )
        return count
    except Exception:  # noqa: BLE001
        logger.warning("改派时复核穿透规则失败：%s", ref, exc_info=True)
        return 0


async def transfer_guest(
    kind: str,
    ref: str,
    username: str,
    *,
    notify: bool = True,
    restart: bool = True,
) -> Dict[str, Any]:
    """指派 / 收回一台客户机（虚拟机或容器），返回变更详情。

    这是**客户机归属变更的唯一入口**，路由层不要再自己调
    :func:`set_owner` / :func:`delete_owner` —— 那些只会改一行，改完之后
    快照标记与读缓存都还停在旧账上。

    返回 ``previous``（给审计留痕，也是事后唯一能回答「改派前是谁」的东西）与
    连带处理的条数（快照标记 / 活动告警 / 穿透规则）。

    ``notify`` / ``restart`` 只给**批量指派**用：一批 200 台如果每台都作废一遍缓存
    并把 frpc 重启一次，代价是 200 次全量失效扫描 + 200 个 1.5 秒的隧道空窗。
    批量调用方传 ``False``，最后自己调一次 :func:`invalidate_caches` 与
    ``frp.restart_if_running`` —— 语义不变，只是把两件「全局」的事挪到末尾做一次。
    """
    previous = await get_owner_for(kind, ref)
    if username:
        await set_owner(kind, ref, username)
    else:
        await delete_owner(kind, ref)
    if kind == KIND_CT:
        # 升级前容器的归属记在 KIND_VM 下：只动 KIND_CT 会留下一条「幽灵」旧记录
        # （重新指派后旧归属人仍能看到这台容器）。容器与虚拟机的 ref 形状相同、
        # VMID 唯一，两类不可能同键，所以这一删不会误伤虚拟机。
        await delete_owner(KIND_VM, ref)
    snapshots = await forget_snapshots(ref)
    # 这台机器还挂着的活动告警要跟着换收件人：告警状态是以「收件人」为主键存的
    # （见 alerting.alarm_key），不搬的话前任会一直挂着一条「正在告警」，
    # 而新主人要等下一轮巡检重新点火才看得见。
    alerts = await _retarget_active_alerts(ref, str(username or ""))
    # 穿透规则：目标机器换主人后，前主人那条隧道必须停（见 _suspend_frp_rules）
    frp_suspended = await _suspend_frp_rules(ref, str(username or ""), restart=restart)
    if notify:
        await invalidate_caches()
    return {
        "previous": previous or "",
        "owner": str(username or ""),
        "snapshots_removed": int(snapshots),
        "active_alerts_moved": int(alerts),
        "frp_rules_suspended": int(frp_suspended),
    }


async def transfer_host(host_id: str, username: str) -> Dict[str, Any]:
    """指派 / 收回一台受管主机，返回变更详情（``{"previous", "owner"}``）。

    与 :func:`transfer_guest` 同一套理由：受管主机是「SSH 安全 / 登录审计 /
    安全基线 / 端口与进程」四套安全数据的归属维度，换主人之后这几处的可见范围
    都是读时现算的，所以只要改了归属并作废缓存，它们就会一起跟过去 ——
    不需要、也不允许搬迁主机维度下的历史记录（那些是审计事实）。
    """
    previous = await get_owner(KIND_SSH_HOST, host_id)
    if username:
        await set_owner(KIND_SSH_HOST, host_id, username)
    else:
        await delete_owner(KIND_SSH_HOST, host_id)
    await invalidate_caches()
    return {"previous": previous or "", "owner": str(username or "")}


async def forget_user(username: str) -> int:
    """删掉某个用户名下的**全部**归属记录，返回删除条数。

    账号被删除时必须调：归属行指向一个不存在的账号时，各处的解析都会退化成
    「没有归属」（严格隔离下即「仅管理员可见」），但那只是碰巧——有的地方会把
    空归属当成「不限」，也有的地方（如告警投递）要专门写兜底。与其让每条读路径
    各自防御，不如在删号这个唯一的写点把账清干净。

    清掉之后资源变成**无主**，由管理员决定给谁 —— 与对账作业的取舍一致
    （「机器还在但没人认领是事实，该由人来决定」），这里不自动转给管理员。
    """
    name = str(username or "").strip()
    if not name:
        return 0
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM resource_owner WHERE username = ?", (name,)
        )
        removed = cursor.rowcount
        await db.commit()
    await invalidate_caches()
    return max(0, int(removed or 0))


async def get_owner(kind: str, ref: str) -> Optional[str]:
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT username FROM resource_owner WHERE kind = ? AND ref = ?",
            (kind, ref),
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def find_refs_by_vm(
    node: str,
    vmid: Any,
    kind: Optional[str] = None,
    connection_ids: Optional[Iterable[str]] = None,
) -> List[Tuple[str, str]]:
    """按「节点 + VMID」反查归属记录，返回 ``[(connection_id, username)]``。

    ref 形如 ``<connection>:<node>:<vmid>``；节点名与连接 id 都不含 ``:``，
    所以从右侧按后缀匹配即可安全还原。

    ``kind`` 留空表示**两类客户机都查** —— 连接绑定（:mod:`app.vm_scope`）只知道
    节点与 VMID、拿不到类型，必须两边都看才定位得到容器的连接。

    ``connection_ids`` 给定时只查这些连接对应的 ref（走 ``(kind, ref)`` 主键，
    每台机器几条记录），这是单机请求的热路径：调用方本来就知道当前存在哪些
    连接。不给时退回「整表读回来在内存里 endswith 过滤」——那条路每条记录都要
    过一遍 Python，机器上万时单次请求要搬几万行，批量指派会退化成平方级。
    """
    suffix = f":{node}:{vmid}"
    kinds: Tuple[str, ...] = (kind,) if kind else GUEST_KINDS

    if connection_ids is not None:
        # 候选 ref 与连接 id 一一对应，命中的行可以直接反推回连接 id，
        # 不必再从字符串前缀里切。"-" 是空连接的历史写法，先折成空串，
        # 否则 vm_ref 会拼出 "--:node:vmid" 这种不存在的 ref。
        wanted = {
            vm_ref("" if str(cid) in ("", "-") else str(cid), node, vmid): cid
            for cid in connection_ids
        }
        if not wanted:
            return []
        kind_slots = ", ".join("?" for _ in kinds)
        ref_slots = ", ".join("?" for _ in wanted)
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT ref, username FROM resource_owner "
                f"WHERE kind IN ({kind_slots}) AND ref IN ({ref_slots})",
                (*kinds, *wanted.keys()),
            )
            rows = await cursor.fetchall()
        return [
            (wanted[str(ref)] or "-", str(username or ""))
            for ref, username in rows
            if str(ref) in wanted
        ]

    async with database.connect() as db:
        placeholders = ", ".join("?" for _ in kinds)
        cursor = await db.execute(
            f"SELECT ref, username FROM resource_owner WHERE kind IN ({placeholders})",
            tuple(kinds),
        )
        rows = await cursor.fetchall()

    found: List[Tuple[str, str]] = []
    for ref, username in rows:
        text = str(ref or "")
        if not text.endswith(suffix):
            continue
        # 连接 id 为空时创建记录的机器，前缀会是 "-"（表示当时用的是当前连接）
        found.append((text[: -len(suffix)] or "-", str(username or "")))
    return found


async def owners_map(kind: str) -> Dict[str, str]:
    """一次取出某个类别的全部归属，避免列表接口逐条查库。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref, username FROM resource_owner WHERE kind = ?", (kind,)
        )
        return {row[0]: row[1] for row in await cursor.fetchall()}


async def owners_maps(kinds: Sequence[str]) -> Dict[str, Dict[str, str]]:
    """一次取出**多个类别**的全部归属（单条 SQL，``kind -> {ref: user}``）。

    列表接口常常同时需要虚拟机、容器、快照三张归属表（例如全局快照汇总：
    快照标记优先、没有标记就回落到所属机器的归属）。逐个调 :func:`owners_map`
    就是三次独立往返，而它们读的是同一张表 —— 合并成一条 ``IN (...)`` 即可。
    """
    wanted = [str(kind) for kind in kinds if str(kind)]
    if not wanted:
        return {}
    placeholders = ", ".join("?" for _ in wanted)
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT kind, ref, username FROM resource_owner "
            f"WHERE kind IN ({placeholders})",
            tuple(wanted),
        )
        rows = await cursor.fetchall()
    merged: Dict[str, Dict[str, str]] = {kind: {} for kind in wanted}
    for row in rows:
        merged.setdefault(str(row[0]), {})[str(row[1])] = str(row[2] or "")
    return merged


async def owners_map_for(kind: str) -> Dict[str, str]:
    """取某类客户机的全部归属。

    容器的归属在升级前记在 :data:`KIND_VM` 下（旧版本不区分类型）。这里把这类
    存量记录并进来，保证升级瞬间、:func:`migrate_guest_kinds` 跑完之前容器也不会
    「凭空消失」。ref 带 VMID、集群内唯一，两类之间不可能同键，所以合并是安全的。
    """
    owners = await owners_map(kind)
    if kind != KIND_CT:
        return owners
    legacy = await owners_map(KIND_VM)
    legacy.update(owners)  # 新记录（KIND_CT）优先
    return legacy


async def guest_owners_map() -> Dict[str, str]:
    """两类客户机（虚拟机 + 容器）的**合并**归属表。

    用于「记录本身不带类型」的跨类型回落判定：备份归档（vzdump 里既有 qemu 也有
    lxc）、全局快照汇总等。ref 里带 VMID、集群内唯一，合并不会串台。
    """
    owners = await owners_map(KIND_VM)
    owners.update(await owners_map(KIND_CT))
    return owners


async def get_owner_for(kind: str, ref: str) -> Optional[str]:
    """:func:`get_owner` 的客户机版本：容器会回看升级前的 ``KIND_VM`` 记录。"""
    owner = await get_owner(kind, ref)
    if owner is None and kind == KIND_CT:
        owner = await get_owner(KIND_VM, ref)
    return owner


async def list_owned(kind: str, username: str) -> List[str]:
    """某个用户名下的全部 ref。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref FROM resource_owner WHERE kind = ? AND username = ?",
            (kind, username),
        )
        return [row[0] for row in await cursor.fetchall()]


async def list_owned_guests(username: str) -> List[str]:
    """某个用户名下的全部客户机 ref（虚拟机 + 容器）。

    用于「跨类型」的读数（历史指标、AI 排查的授权范围）：这些地方拿到的是一个
    ``<连接>:<节点>:<vmid>`` 列表，两类混在一起无妨（VMID 唯一）。
    """
    refs = await list_owned(KIND_VM, username)
    refs.extend(await list_owned(KIND_CT, username))
    return refs


def vm_owner_from(
    vm_owners: Dict[str, str],
    node: Any,
    vmid: Any,
    connection_id: str = "",
) -> Optional[str]:
    """从 :func:`owners_map` 结果里按「节点 + VMID」查虚拟机归属。

    用途：快照/备份在旧版本代码里创建时没有写创建者标记，读取时先查标记、
    查不到再回落到「这台机器是谁的」，让这类存量资源在归属者名下可见。

    ref 形如 ``<连接>:<节点>:<vmid>``，连接 id 可能是记录时的 ``"-"``（当时
    未指定连接），因此不做精确键匹配，按 ``:节点:vmid`` 后缀匹配（与
    :func:`find_refs_by_vm` 同一套路）。``node`` 为空时退化为按「连接 + vmid」
    匹配——同一台 PVE 内 vmid 唯一，但必须锁定连接，防止跨主机同 vmid 串台。

    命中多条且归属人不同时无法判定（多台主机同名节点 + 相同 vmid），返回
    ``None`` 交给严格判定拒绝。
    """
    if vmid is None or not str(vmid):
        return None
    cid = connection_id or "-"

    # 精确匹配优先：多套 PVE 上可能存在同名节点 + 相同 vmid（例如两套集群里
    # 都有 pve/105），而归属表按 ``<连接>:<节点>:<vmid>`` 记录，本来是能分清的。
    # 只按后缀匹配会同时命中两条、归属人不同 → 返回 None，调用方就把它当成
    # 「没有归属」—— 仪表盘榜单因此对普通用户永远是空表（/vms 列表用的是精确
    # ref，所以列表能看到机器，两边表现不一致）。
    #
    # ``-`` 前缀是旧版本记录时未指定连接的写法，与 cid 同一个意思，一并认。
    if node:
        for exact in (f"{cid}:{node}:{vmid}", f"-:{node}:{vmid}"):
            owner = vm_owners.get(exact)
            if owner is not None:
                return str(owner or "") or None

    usernames: List[str] = []
    for ref, username in vm_owners.items():
        text = str(ref)
        if node:
            if not text.endswith(f":{node}:{vmid}"):
                continue
            # 连接已知时只认同一连接（或旧版本的 “-” 前缀）的记录：否则 B 连接上
            # 的同号机器会把 A 连接的归属认领走，隔离就漏了。
            if cid != "-" and text.rsplit(":", 2)[0] not in (cid, "-"):
                continue
        else:
            if not text.endswith(f":{vmid}") or text.rsplit(":", 2)[0] != cid:
                continue
        usernames.append(str(username or ""))
    if not usernames:
        return None
    unique = {u for u in usernames if u}
    if len(unique) > 1:
        return None
    return usernames[0]


# ------------------------------------------------------------------ 存量迁移
#: 一次性迁移的标记（存 settings KV）。跑完置 1，之后不再重复扫表。
SPLIT_FLAG = "ownership_guest_kind_split"


async def migrate_guest_kinds() -> int:
    """把升级前记在 :data:`KIND_VM` 下的**容器**归属搬到 :data:`KIND_CT`。

    判断「是不是容器」**不依赖 PVE**：面板自己的 ``guest_created_record`` 表里存着
    每台面板发起创建的机器的 ``guest_type``（``qemu`` / ``lxc``），升级前由
    ``routers/lxc.py`` 正常写入。所以这个迁移纯读面板库，PVE 连不上也照样能跑。

    只搬「确实有容器建机记录」的那些 ref；其余保持原样 —— 面板之外建的机器本来
    就没有归属记录（严格隔离），搬不动也无所谓。返回搬动的条数。

    跑完在 settings 里记一个标记，避免每次启动都扫表；标记写失败时下次启动重跑，
    重复搬不会有副作用（:func:`set_owner` 是 upsert）。
    """
    from . import store  # 延迟导入：store 与 ownership 都在启动期被加载，避免环

    try:
        if await store.get_setting(SPLIT_FLAG):
            return 0
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT conn_id, node, vmid FROM guest_created_record "
                "WHERE guest_type = 'lxc'"
            )
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001 - 迁移失败不该拖住启动，下次再来
        logger.warning("容器归属迁移：读取建机记录失败，跳过", exc_info=True)
        return 0

    moved = 0
    for conn_id, node, vmid in rows or []:
        if not node or vmid is None:
            continue
        ref = vm_ref(str(conn_id or ""), str(node), vmid)
        if await get_owner(KIND_CT, ref) is not None:
            continue  # 已经是新记录（或迁移过），不动
        owner = await get_owner(KIND_VM, ref)
        if owner is None:
            continue
        await set_owner(KIND_CT, ref, owner)
        await delete_owner(KIND_VM, ref)
        moved += 1

    try:
        await store.set_setting(SPLIT_FLAG, "1")
    except Exception:  # noqa: BLE001
        logger.warning("容器归属迁移：写入标记失败，下次启动会重跑", exc_info=True)
    if moved:
        logger.info("容器归属迁移完成：%d 条记录已改记到 %s", moved, KIND_CT)
    return moved
