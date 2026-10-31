"""Backup and restore endpoints.

用户隔离
--------
备份归档的 volid 由 vzdump 任务异步生成，创建接口拿不到，没法像快照那样查
``resource_owner`` 表；因此把创建者写进归档的 ``notes``（vzdump 的
``notes-template``），读取时解析 ``[owner:用户名]`` 标记。
备份计划同理：创建时往 ``comment`` 写标记。管理员（visible_owner 返回 None）
不受限制；普通用户只看得到、动得了自己创建的备份。

旧版本代码创建的存量备份/计划没有创建者标记：创建者标记优先，标记缺失时
回落到「归档/计划里 vmid 所属虚拟机的归属者」，让存量资源在机器归属者名下
可见、可操作；既无标记也查不到虚拟机归属的，依旧仅管理员可见。

「备份防护」的四个接口口径也在这里对齐：归档归属优先（看 vmid 属于谁的机器），
拿不到时回落到登记人（``created_by``）。**看得见才动得了** —— 列表 / 解除 /
核对用的是同一套判定，不会出现「列表里看不见、却能凭 volid 解开保护」。
"""
from __future__ import annotations

import asyncio
import logging
import re
import shlex
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from .. import (
    backupguard,
    guest_created,
    guestguard,
    ownership,
    pvecache,
    quota,
    security,
    sshremote,
    store,
)
from ..formatters import paginate_rows, pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    parallel,
    requested_connection,
    set_request_connection,
)
from ..vm_scope import resolve_node_connection
from ..schemas import (
    BackupCreate,
    BackupJobCreate,
    BackupJobCreate as JobCreate,
    BackupProtectIn,
    BackupRestore,
)

router = APIRouter(prefix="/api", tags=["backups"])

logger = logging.getLogger(__name__)


# ================================================================ 备份统计
# 备份失败的杀伤力在于「事前不知道」：备份页只有归档列表，没人盯着任务
# 的成败 —— 等真正要恢复时才发现最近一次备份是空的。

#: 备份统计的缓存时长（秒）。vzdump 是分钟级事件，30 秒的新鲜度对本页面够用；
#: 换来的是「重复打开备份页 / 多人同时看」时 X-PVE-Calls 直接归零。
BACKUP_STATS_TTL = 30.0


@router.get("/backups/stats")
async def backup_stats(
    days: int = Query(default=7, ge=1, le=90),
    fresh: bool = Query(False, description="绕过 30 秒统计缓存，立刻重新向 PVE 取数"),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    """最近 N 天的备份任务成败统计，跨所有已保存的 PVE。

    备份任务（vzdump）挂在节点任务列表里，成败与否在列表条目自带的
    ``status`` 字段上就有（"OK" / 其他），不需要逐个任务再查一次状态。

    覆盖范围刻意做成了多主机：哪个节点跑了备份不该由用户记住，
    逐条连接遍历一遍才能保证统计是全量的。

    性能：**连接与节点两层并发** + 30 秒缓存。此前是双层 ``for`` 里 ``await``，
    4 连接 × 3 节点 = 12 次串行 HTTP（墙钟时间是各次 RTT 之和）；现在一轮并发
    取完，重复打开备份页直接命中缓存。缓存带来的「刚备份完看不到」由响应里的
    ``as_of`` 说明数据时间，需要立刻刷新时带 ``?fresh=1``。
    """
    scope = security.visible_owner(user)
    region_admin = security.is_region_admin(user)
    # 缓存按「窗口 + 可见范围」分档：管理员共享一份；普通用户各一份 —— 归属过滤
    # 后的结果不同，混用等于把别人的 vmid 发给下一个人。
    viewer = str(user.get("username") or "") if scope is not None else "-"
    key = f"backups:stats:{days}:{scope or '-'}:{viewer}"

    async def _collect() -> Dict[str, Any]:
        computed_at = int(time.time())
        cutoff = computed_at - days * 86400
        ok_count = 0
        failed = 0
        running = 0
        failures: List[Dict[str, Any]] = []

        # 归属裁剪：vzdump 任务的 ``id`` 就是 vmid，按「这台机器归谁」判定。
        # 此前统计与失败明细都是全平台口径，普通用户能读到别人机器的 vmid、节点名与
        # 发起备份的 PVE 身份。规则与客户机列表同源：管理员不限制、区域管理员按连接
        # 区域、其余人只看自己名下（无归属记录的存量机器不算）。
        owners = (
            await ownership.guest_owners_map()
            if scope is not None and not region_admin
            else {}
        )
        region_of: Dict[str, str] = {}

        def _visible(connection_id: str, node: str, vmid: Any) -> bool:
            if scope is None:
                return True
            if region_admin:
                if connection_id not in region_of:
                    region_of[connection_id] = store.connection_region(connection_id)
                return security.region_in_scope(user, region_of[connection_id])
            return (
                ownership.vm_owner_from(owners, node, vmid, connection_id) == scope
            )

        # 每节点的任务条数按窗口推算。原先写死 300：一周窗口下每个节点 100 条
        # 已经远超实际（每天几十次备份的集群极少），拉多了只是白解析。
        task_limit = max(100, min(300, days * 40))
        pairs = all_connection_clients() or [({}, get_client())]

        # 第一层并发：各连接的节点清单（串行时总耗时是各连接 RTT 的和）
        node_lists = await parallel(
            [client.nodes() for _profile, client in pairs],
            limit=max(1, len(pairs)),
        )
        targets: List[Tuple[str, str, Any, str]] = []
        for (profile, client), nodes in zip(pairs, node_lists):
            # 某条连接连不上只跳过它自己（与改动前一致的失败语义）
            if isinstance(nodes, BaseException):
                continue
            cid = str((profile or {}).get("id") or "")
            label = connection_label(profile) if profile else ""
            for node_info in nodes or []:
                node = (node_info or {}).get("node")
                if not node:
                    continue
                targets.append((cid, label, client, str(node)))

        # 第二层并发：节点任务列表。上限 8 —— 每条都是一次真实 HTTP，压太满会把
        # 「慢」换成 PVE 侧的 429 / 超时。
        task_results = await parallel(
            [
                client.get(f"/nodes/{node}/tasks", params={"limit": task_limit})
                for _cid, _label, client, node in targets
            ],
            limit=8,
        )

        for (cid, label, _client, node), tasks in zip(targets, task_results):
            if isinstance(tasks, BaseException):
                continue
            for task in tasks or []:
                if not isinstance(task, dict) or task.get("type") != "vzdump":
                    continue
                if not _visible(cid, node, task.get("id")):
                    continue
                start = int(task.get("starttime") or 0)
                if start < cutoff:
                    continue
                status = str(task.get("status") or "").upper()
                if not task.get("endtime") or not status:
                    running += 1
                    continue
                if status == "OK":
                    ok_count += 1
                else:
                    failed += 1
                    failures.append(
                        {
                            "node": node,
                            "vmid": task.get("id"),
                            "upid": task.get("upid"),
                            "user": task.get("user") or "",
                            "starttime": start,
                            "endtime": int(task.get("endtime") or 0),
                            "status": status,
                            "connection_id": cid,
                            "connection_name": label,
                        }
                    )

        total = ok_count + failed
        return {
            "days": days,
            "total": total,
            "ok": ok_count,
            "failed": failed,
            "running": running,
            # None 表示统计窗口里一次备份都没有 —— 与 0% 有本质区别
            "success_rate": round(ok_count / total * 100, 1) if total else None,
            "failures": sorted(failures, key=lambda f: f["endtime"], reverse=True)[:20],
            # 这份统计算出来的时刻：命中缓存时它会比「现在」早若干秒，
            # 前端据此显示「数据截至 xx 秒前」，避免「刚备份完却看不到」的误解。
            "as_of": computed_at,
        }

    return await pvecache.cached(key, BACKUP_STATS_TTL, _collect, fresh=fresh)

# 归属标记，形如 ``[owner:alice]``；写进 PVE 的 notes / comment 字段
_OWNER_RE = re.compile(r"\[owner:([^\[\]\s]+)\]")
# 从 vzdump 归档文件名解析 vmid：``vzdump-qemu-110-...`` / ``vzdump-lxc-110-...``
_VOLID_VMID_RE = re.compile(r"vzdump-(?:qemu|lxc)-(\d+)")


def _mark_owner(text: Optional[str], username: str) -> str:
    """在备注末尾追加创建者标记（已带标记则原样返回）。"""
    base = (text or "").strip()
    if not username or _OWNER_RE.search(base):
        return base
    return f"{base} [owner:{username}]".strip()


def _strip_owner(text: Optional[str]) -> str:
    """去掉归属标记，只留用户自己填的备注。"""
    return _OWNER_RE.sub("", text or "").strip()


def _owner_of(text: Optional[str]) -> Optional[str]:
    match = _OWNER_RE.search(text or "")
    return match.group(1) if match else None


def _effective_owner(
    marker: Optional[str],
    vm_owners: Dict[str, str],
    node: Any,
    vmid: Any,
    connection_id: str,
) -> Optional[str]:
    """备份 / 备份计划的**生效归属**：机器归属优先，创建者标记只作回落。

    为什么把优先级反过来：``[owner:x]`` 是**创建那一刻**抄下来的名字，机器改派
    之后它不会跟着变（PVE 的 notes 也不会被改派流程碰）。以它为准，就是「备份
    仍归前任、前任仍能下载别人机器的新备份」。

    真正回答「这是谁的机器」的是归属表，所以先查它；机器已删除、或本来就无主时，
    才回落到标记 —— 那时标记是唯一的线索，而创建者确实是最相关的人。
    """
    owner = ownership.vm_owner_from(vm_owners, node, vmid, connection_id)
    return owner or marker


def _vmid_from_volid(volid: str) -> Optional[int]:
    match = _VOLID_VMID_RE.search(volid or "")
    return int(match.group(1)) if match else None


def _connection_scope() -> str:
    """本次操作作用在哪条连接上（与 vms 路由的 ``_op_connection`` 一致）。"""
    return requested_connection() or str(store.get_active_connection_id() or "")


async def _require_backup_targets(
    user: Dict[str, Any],
    node: Optional[str],
    vmids: Any,
    all_guests: bool,
) -> None:
    """备份的**对象级**校验：备份谁，就必须是谁的。

    为什么这条以前最危险：创建备份时会把发起人写进归档的 notes 标记，而
    ``assert_backup_access`` 正是按这个标记放行的。也就是说，只要能让 PVE 给你
    备份别人的机器（``vmid=别人的号`` 或 ``all=1``），产物就会被认成你的，
    随后 ``/backups/download`` 把你整盘取走 —— 一条完整的越权外带链。

    规则：
    * ``all=1``（整集群）只给管理员；
    * 指定的 vmid 必须属于自己（没有归属记录的存量机器按「无主」放行，与
      严格隔离的列表口径不同：这里拿不到记录就无法判定，按无主处理只影响
      旧机器，不会放开任何**已登记**的租户机器）。
    * 节点未知（计划任务可以不写 node）时按「任一连接名下」判定。
    """
    if all_guests:
        if not security.is_admin(user):
            raise HTTPException(
                status_code=403,
                detail="只有管理员可以备份全部客户机",
            )
        return

    owner = security.visible_owner(user)
    if owner is None:
        return

    ids: List[int] = []
    for raw in str(vmids if vmids is not None else "").replace(";", ",").split(","):
        text = raw.strip()
        if text.isdigit():
            ids.append(int(text))
    if not ids:
        return

    node_text = str(node or "").strip()
    if node_text:
        for vmid in ids:
            for kind in ownership.GUEST_KINDS:
                await guestguard.require_guest_object_if_owned(user, node_text, vmid, kind)
        return

    # 计划任务可以不带 node：此时按「这个 vmid 在**任何**连接上登记给了谁」判定，
    # 避免 node 为空就把整段降级成放行。与有 node 的分支同一口径：**完全没有记录**
    # 的存量机器按无主处理（放行），有记录但不是自己的才拒绝。
    try:
        owners = await ownership.guest_owners_map()
    except Exception:  # noqa: BLE001 - 读不到归属时按无主处理，只放行管理员
        owners = {}
    known = {ref.rsplit(":", 1)[-1] for ref in owners}
    mine = {
        ref.rsplit(":", 1)[-1]
        for ref, recorded in owners.items()
        if recorded == owner
    }
    intruding = [vmid for vmid in ids if str(vmid) in known and str(vmid) not in mine]
    if intruding:
        raise HTTPException(
            status_code=404,
            detail=f"虚拟机不存在：{intruding[0]}",
        )


async def _archive_at(
    node: str, storage: str, volid: str
) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """在存储内容里找这个卷，返回 ``(是否找到, 条目)``。"""
    client = get_client()
    try:
        items = await client.storage_content(node, storage)
    except ProxmoxError:
        return False, None
    for item in items or []:
        if item.get("volid") == volid:
            return True, item
    return False, None


async def assert_backup_access(
    user: Dict[str, Any],
    node: str,
    storage: str,
    volid: str,
    *,
    strict_missing: bool = True,
) -> None:
    """变更前校验备份归属；供 backups / storages 两个路由共用。

    * 管理员直接放行。
    * 归属判定：归档 vmid 所属虚拟机的**当前**归属者优先（改派后备份跟着机器走），
      机器已删除 / 无主时才回落到 notes 里的创建者标记（见 :func:`_effective_owner`）。
    * ``strict_missing=True``（备份专用接口）：找不到卷且无法确认归属 = 拒绝；
      卷名里的 vmid 能解析出、且该虚拟机归属本人时放行。
    * ``strict_missing=False``（通用存储卷删除）：只有能确认是备份归档时才校验，
      ISO/磁盘等其它内容不受备份隔离影响。
    """
    scope = security.visible_owner(user)
    if scope is None:
        return
    found, item = await _archive_at(node, storage, volid)
    is_backup = bool(item) and (
        str(item.get("type") or "") == "backup" or "vzdump" in volid
    )

    marker = _owner_of(str((item or {}).get("notes") or ""))
    vmid = (item or {}).get("vmid") or _vmid_from_volid(volid)
    owner: Optional[str] = marker
    if vmid is not None:
        vm_owners = await ownership.guest_owners_map()
        owner = _effective_owner(marker, vm_owners, node, vmid, _connection_scope())

    if not found:
        if strict_missing and owner != scope:
            raise HTTPException(
                status_code=403,
                detail="无法确认该备份的归属，普通用户只能操作自己创建的备份",
            )
        return
    if not is_backup and not strict_missing:
        return
    if owner != scope:
        raise HTTPException(
            status_code=403,
            detail="该备份不属于当前用户，无权操作",
        )


def _protected_record_owner(
    record: Dict[str, Any],
    vm_owners: Dict[str, str],
    connection_id: str,
) -> Optional[str]:
    """一条受保护备份归谁。

    优先看归档 vmid 所属**虚拟机**的归属者 —— 这才是「谁的机器」的真相：
    管理员代用户登记时，``created_by`` 写的是管理员，而备份属于用户。
    拿不到 vmid / 查不到虚拟机归属时，才回落到登记人。
    """
    vmid = record.get("vmid") or _vmid_from_volid(str(record.get("volid") or ""))
    if vmid is not None and str(vmid) != "":
        owner = ownership.vm_owner_from(
            vm_owners, record.get("node") or "", vmid, connection_id
        )
        if owner:
            return owner
    return str(record.get("created_by") or "") or None


async def _visible_protected(
    user: Dict[str, Any],
) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """受保护备份的可见范围：返回 ``(scope, records)``。

    ``scope is None`` = 管理员，records 为全量；普通用户只看得到自己机器上的
    或自己登记的那几条。列表、解除保护、核对都走这一个入口，口径才不会漂。
    """
    records = await backupguard.list_records()
    scope = security.visible_owner(user)
    if scope is None:
        return None, records
    vm_owners = await ownership.guest_owners_map()
    connection_id = _connection_scope()
    return scope, [
        r for r in records if _protected_record_owner(r, vm_owners, connection_id) == scope
    ]


async def assert_protected_access(user: Dict[str, Any], record: Dict[str, Any]) -> None:
    """解除保护等变更操作的归属校验：看不见的就不该动得了。"""
    scope = security.visible_owner(user)
    if scope is None:
        return
    vm_owners = await ownership.guest_owners_map()
    if _protected_record_owner(record, vm_owners, _connection_scope()) != scope:
        raise HTTPException(
            status_code=403,
            detail="该受保护备份不属于当前用户，无权解除其保护",
        )


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


def _archive_size(item: Dict[str, Any]) -> Optional[int]:
    value = item.get("size")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


#: 备份归档目录的缓存时长（秒）。与 ``/api/storages/content`` 取同一口径：
#: 归档只在备份结束时新增，20 秒足够削掉「多人/多标签同时刷备份页」的重复扫描。
BACKUP_CONTENT_TTL = 20.0


def _forget_backup_cache() -> None:
    """作废备份相关的只读缓存（归档目录 + 统计）。

    备份链路上的变更（新建 / 恢复 / 删除）必须显式调用：归档目录缓存 20 秒、
    统计缓存 30 秒，光靠 TTL 过期会让「刚发起的备份」在页面上消失一会儿 ——
    用户的第一反应是「没成功」，而不是「等 20 秒」。
    """
    pvecache.invalidate("backups:content")
    pvecache.invalidate("backups:stats")


@router.get("/backups")
async def list_backups(
    response: Response,
    node: Optional[str] = None,
    storage: Optional[str] = None,
    vmid: Optional[int] = None,
    limit: Optional[int] = Query(
        None, ge=1, description="只返回前 N 条（默认全量）；总数见 X-Total-Count"
    ),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> List[Dict[str, Any]]:
    """List backup archives across the cluster (or one node/storage/VM)."""
    client = get_client()
    scope = security.visible_owner(user)
    # 无创建者标记的存量备份按虚拟机归属回落，一次取全量归属表
    vm_owners = await ownership.guest_owners_map()

    if node and storage:
        targets = [(node, storage)]
    elif node:
        # 节点视图：/nodes/{node}/storage 的条目由 pve.py 补上 node 字段
        try:
            storages = await client.storages(node)
        except ProxmoxError as exc:
            _raise(exc)
        targets = [
            (node, s.get("storage", ""))
            for s in (storages or [])
            if "backup" in (s.get("content") or "")
        ]
        if storage:
            targets = [t for t in targets if t[1] == storage]
    else:
        # 集群视图（页面默认，不带任何筛选）：/storage 是集群级配置、
        # 条目没有 node 字段，必须结合 /nodes 展开成 (节点, 备份存储) 组合，
        # 否则 target_node 恒为空、整个列表永远返回空。
        # 两次调用互不依赖，并发取（串行时是两份 RTT 相加）。
        try:
            storages, all_nodes = await asyncio.gather(
                client.storages(), client.nodes()
            )
        except ProxmoxError as exc:
            _raise(exc)
        backup_storages = [
            s.get("storage", "")
            for s in (storages or [])
            if "backup" in (s.get("content") or "")
        ]
        if storage:
            backup_storages = [s for s in backup_storages if s == storage]
        targets = [
            (n.get("node", ""), st)
            for n in (all_nodes or [])
            for st in backup_storages
        ]

    # 存储内容列表是 PVE 里最慢的只读接口之一（目录型 / NFS / CIFS 每次都要真的
    # 扫一遍目录），因此这里做两件事：
    #   1. 并发（上限 6 —— 目录扫描属重 IO，压太满会把「慢」换成 429 / 超时）；
    #   2. 按 (连接, 节点, 存储, vmid) 缓存 20 秒，与 /storages/content 同一口径。
    # 缓存只存 PVE 的原始条目；归属过滤仍按当前用户现算，缓存不会成为越权通道。
    cid = _connection_scope()

    async def _content(target_node: str, target_storage: str) -> Any:
        async def _load() -> Any:
            return await client.storage_content(
                target_node, target_storage, content="backup", vmid=vmid
            )

        key = (
            f"backups:content:{cid or '-'}:{target_node}:{target_storage}:"
            f"{vmid if vmid is not None else '-'}"
        )
        try:
            return await pvecache.cached(key, BACKUP_CONTENT_TTL, _load)
        except ProxmoxError:
            # 单个存储读不到（未挂载 / 权限不足）只跳过它自己；失败不登记缓存
            return None

    wanted = [
        (target_node, target_storage)
        for target_node, target_storage in targets
        if target_node and target_storage
    ]
    results = await parallel([_content(n, s) for n, s in wanted], limit=6)

    output: List[Dict[str, Any]] = []
    seen_volid: set[str] = set()
    for (target_node, target_storage), items in zip(wanted, results):
        if isinstance(items, BaseException):
            # 非 PVE 异常（配置缺失、鉴权失败之类）保持原来的向上冒泡行为
            raise items
        if items is None:
            continue
        for item in items or []:
            volid = item.get("volid", "")
            if not volid or volid in seen_volid:
                # 共享存储在多个节点返回同一归档，只报一次
                continue
            seen_volid.add(volid)
            notes = item.get("notes", "")
            # 用户隔离：按机器**当前**归属判定，创建者标记只在机器无主时回落
            owner = _effective_owner(
                _owner_of(notes),
                vm_owners,
                target_node,
                item.get("vmid"),
                _connection_scope(),
            )
            if scope is not None and owner != scope:
                continue
            output.append(
                {
                    "volid": volid,
                    "node": target_node,
                    "storage": target_storage,
                    "vmid": item.get("vmid"),
                    "size": _archive_size(item),
                    "ctime": item.get("ctime"),
                    "format": item.get("format", ""),
                    "notes": _strip_owner(notes),
                    "protected": pve_flag(item.get("protected", 0)) == 1,
                    "name": _backup_name(volid),
                    "owner": owner,
                }
            )

    output.sort(key=lambda b: b.get("ctime") or 0, reverse=True)
    return paginate_rows(output, response, limit)


def _backup_name(volid: str) -> str:
    return volid.rsplit("/", 1)[-1] if "/" in volid else volid


# --------------------------------------------------------------- 归属对账
#: 对账结果里的差异类型（界面按它组织文案，别把这些字符串当展示文本用）
DRIFT_REASSIGNED = "reassigned"      # 标记写的 A，机器现在归 B
DRIFT_MACHINE_GONE = "machine-unowned"  # 机器已无归属（删了 / 收回了），标记还挂着 A
DRIFT_UNMARKED = "unmarked"          # 机器归 B，归档却没有创建者标记（旧版本创建的）


async def _scan_all_archives() -> List[Dict[str, Any]]:
    """扫全集群的备份归档，返回**原始条目**（附 node / storage）。

    与 :func:`list_backups` 的区别：那里按 node / storage 分支、还要按当前用户裁剪；
    对账是管理员的全量只读视图，只关心「标记是什么、机器现在归谁」。两处都走
    ``storage_content`` 的同一份 20 秒缓存，不会把 PVE 扫两遍。
    """
    client = get_client()
    try:
        storages, all_nodes = await asyncio.gather(client.storages(), client.nodes())
    except ProxmoxError as exc:
        _raise(exc)

    backup_storages = [
        s.get("storage", "")
        for s in (storages or [])
        if "backup" in (s.get("content") or "")
    ]
    targets = [
        (str(n.get("node") or ""), st)
        for n in (all_nodes or [])
        for st in backup_storages
        if n.get("node") and st
    ]
    cid = _connection_scope()

    async def _content(target_node: str, target_storage: str) -> Any:
        async def _load() -> Any:
            return await client.storage_content(
                target_node, target_storage, content="backup"
            )

        key = f"backups:content:{cid or '-'}:{target_node}:{target_storage}:-"
        try:
            return await pvecache.cached(key, BACKUP_CONTENT_TTL, _load)
        except ProxmoxError:
            # 单个存储读不到只跳过它自己（未挂载 / 权限不足）
            return None

    results = await parallel([_content(n, s) for n, s in targets], limit=6)
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for (target_node, target_storage), items in zip(targets, results):
        if isinstance(items, BaseException):
            continue
        for item in items or []:
            volid = item.get("volid", "")
            if not volid or volid in seen:
                continue  # 共享存储在多个节点返回同一归档，只算一次
            seen.add(volid)
            out.append({**item, "node": target_node, "storage": target_storage})
    return out


def _owner_drift_rows(
    items: List[Dict[str, Any]],
    vm_owners: Dict[str, str],
    connection_id: str,
) -> List[Dict[str, Any]]:
    """比对归档里的创建者标记与机器**当前**归属，返回差异（纯函数，不碰 PVE）。

    只读：这里不写 notes、不改归属。存量笔记是历史事实，要不要改由人决定 ——
    一次自动改写覆盖掉的是唯一还能回答「这台机器以前归谁」的线索。

    判定口径与读取侧一致（见 :func:`_effective_owner`）：机器有归属就以它为准，
    标记只在机器无主时才是唯一依据。所以「两者不一致」本身就是需要人看一眼的信号。
    """
    rows: List[Dict[str, Any]] = []
    for item in items or []:
        volid = str(item.get("volid") or "")
        if not volid:
            continue
        node = str(item.get("node") or "")
        vmid = item.get("vmid")
        # 归一成字符串再比：_owner_of 没有标记时返回 None，而「没有归属」是空串，
        # None != "" 会把「两边都没有」误判成一条差异。
        marker = _owner_of(str(item.get("notes") or "")) or ""
        current = ownership.vm_owner_from(vm_owners, node, vmid, connection_id)
        if marker == (current or ""):
            continue
        if marker and not current:
            reason = DRIFT_MACHINE_GONE
        elif marker:
            reason = DRIFT_REASSIGNED
        else:
            reason = DRIFT_UNMARKED
        rows.append(
            {
                "volid": volid,
                "node": node,
                "storage": str(item.get("storage") or ""),
                "vmid": vmid,
                "ctime": item.get("ctime"),
                "marker": marker,
                "owner": current or "",
                "reason": reason,
            }
        )
    rows.sort(key=lambda r: (r["reason"], -(r.get("ctime") or 0)))
    return rows


@router.get("/backups/owner-drift")
async def backup_owner_drift(
    request: Request,
    limit: int = Query(200, ge=1, le=1000, description="最多返回多少条差异"),
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """备份标记与当前归属的差异清单（**只读**，仅管理员）。

    为什么需要它：`[owner:x]` 的语义在「机器归属优先」之后已经降级成回落依据，
    但 PVE 的 notes 里那串字不会被改派流程碰 —— 存量归档里必然有一批与现状不一致。
    这份清单把它们列出来交给人处理，**不回写**任何内容。

    返回 ``{checked, total, truncated, drift[]}``；每条带 ``reason``：
    ``reassigned``（标记 A、机器现在归 B）/ ``machine-unowned``（机器已无归属）/
    ``unmarked``（机器有归属但归档没有标记）。
    """
    items = await _scan_all_archives()
    vm_owners = await ownership.guest_owners_map()
    rows = _owner_drift_rows(items, vm_owners, _connection_scope())
    await security.audit(
        request, user, "backup.owner_drift", "backups",
        detail={"checked": len(items), "drift": len(rows)},
    )
    return {
        "checked": len(items),
        "total": len(rows),
        "truncated": len(rows) > limit,
        "drift": rows[:limit],
    }


@router.post("/backups")
async def create_backup(
    payload: BackupCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    client = get_client()

    if not payload.all and payload.vmid is None:
        raise HTTPException(
            status_code=400, detail="请指定要备份的虚拟机，或启用“备份全部”"
        )

    # 对象级：备份谁就得是谁的（整集群备份只给管理员）。缺了这一层，产物会因为
    # notes 里被写成「我是创建者」而变成可下载的别人的整机镜像。
    await _require_backup_targets(user, payload.node, payload.vmid, payload.all)

    # 在 notes 里写入创建者标记，供列表过滤与恢复/删除校验使用
    notes = _mark_owner(payload.notes, str(user.get("username") or ""))
    try:
        result = await client.backup_create(
            payload.node,
            payload.vmid,
            payload.storage,
            mode=payload.mode,
            compress=payload.compress,
            notes=notes or None,
            all_guests=payload.all,
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "backup.create",
            target=f"{payload.node}/{payload.vmid or 'all'}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "backup.create", target=f"{payload.node}/{payload.vmid or 'all'}",
        detail={"storage": payload.storage, "mode": payload.mode},
    )
    _forget_backup_cache()
    return {"task": task}


@router.post("/backups/restore")
async def restore_backup(
    payload: BackupRestore,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    storage = payload.storage or payload.volid.split(":", 1)[0]
    await assert_backup_access(user, payload.node, storage, payload.volid)
    # 归档归属校验只说明「这个备份是你能读的」，不代表「你可以往这个 vmid 里恢复」：
    # force 默认开着，指向别人的机器就是把人家系统盘覆盖掉。
    for _kind in ownership.GUEST_KINDS:
        await guestguard.require_guest_object_if_owned(
            user, payload.node, payload.vmid, _kind
        )
    # 恢复备份同样是「多出一台机器」。归档里的核数 / 内存 / 磁盘在开工前读不出来
    # （PVE 的备份索引不给客户机配置），所以这一维只能把住**台数**；核数 / 内存 /
    # 磁盘会在机器出现后的下一次统计里如实反映（读数会显示超额），但拦不住这一次。
    # 归档名里的 vzdump-lxc 决定它算容器还是虚拟机额度。
    await quota.enforce_create(
        user, request, "ct" if "vzdump-lxc" in payload.volid else "vm"
    )
    client = get_client()
    try:
        result = await client.backup_restore(
            payload.node,
            payload.volid,
            payload.vmid,
            storage=payload.storage,
            force=payload.force,
            start=payload.start,
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "backup.restore", target=payload.volid,
            result="failed", detail=exc.message,
        )
        _raise(exc)

    task = result if isinstance(result, str) else (result or {}).get("task", "")
    await security.audit(
        request, user, "backup.restore", target=payload.volid,
        detail={"vmid": payload.vmid},
    )
    # 创建时间：恢复出来的机器同样继承归档里来源机器的 meta.ctime（PVE 整体复制
    # config），所以面板自己记一份 —— 归档名里的 vzdump-qemu / vzdump-lxc 决定类型。
    await guest_created.record(
        _active_connection(),
        payload.node,
        payload.vmid,
        "lxc" if "vzdump-lxc" in payload.volid else "qemu",
        source="restore",
        username=str(user.get("username") or ""),
    )
    _forget_backup_cache()
    return {"task": task}


@router.delete("/backups")
async def delete_backup(
    request: Request,
    node: str = Query(...),
    storage: str = Query(...),
    volid: str = Query(...),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
    # 备份删掉就没了（不像虚拟机还有快照兜底）：要求二次确认身份
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    await assert_backup_access(user, node, storage, volid)
    # 受保护备份禁止在此删除：勒索软件常见手法就是「先删备份再加密」，所以即便
    # 拿到了管理员会话，也必须先在「备份防护」里解除保护（两次明确操作）。
    if await backupguard.is_protected(volid):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{volid} 是受保护备份，面板拒绝删除。若确实要删，请先在"
                "「备份防护」里把它从受保护清单移除（并解除 PVE 保护旗标）后重试。"
            ),
        )
    client = get_client()
    try:
        await client.delete(f"/nodes/{node}/storage/{storage}/content/{volid}")
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(request, user, "backup.delete", target=volid)
    _forget_backup_cache()
    return {"deleted": volid}


# ------------------------------------------------------------------ 下载归档
#
# 为什么绕道 SSH：**PVE 的 API 没有「下载整卷」这个能力**。实测：
#
#   * ``file-restore/download`` 只支持 PBS —— 对 dir 存储直接回
#     ``{"errors":{"storage":"Only PBS storages supported for file-restore."}}``；
#   * ``GET /nodes/{node}/storage/{st}/content/{volid}`` 返回的是 JSON 元数据
#     （``{"data":{"size":…,"protected":…}}``），不是文件内容；
#   * 也没有 ``?download=1`` 之类的开关（会被 schema 拒绝）。
#
# 于是目录型（dir）存储上的 vzdump 只能在宿主机上读 —— 复用面板已有的 SSH 通道
# （主机管理里那份凭据）。宿主路径从 PVE 的 ``/storage`` 定义里取：只有数据中心
# 级的这个接口返回 ``path``（``/nodes/{node}/storage`` 与 storage status 都不返回），
# 所以自定义 path 的存储也能正确拼出 ``<path>/dump/<归档名>``。

# 归档名白名单：PVE 生成的是 ``vzdump-qemu-115-2026_09_22-21_52_29.vma.zst`` 这类。
# 严格限定字符集是防注入的第一道闸 —— 这个值最终会拼进远程命令，配合
# shlex.quote 做第二道；``..``、``/``、空格、分号一律进不来。
_ARCHIVE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


async def _dir_storage_path(client: Any, storage: str) -> str:
    """目录型（dir）存储的宿主路径；不是 dir 或读不到时返回空串。"""
    try:
        items = await client.get("/storage")
    except ProxmoxError:
        return ""
    for item in items or []:
        if str(item.get("storage")) != storage:
            continue
        if str(item.get("type")) != "dir":
            return ""
        return str(item.get("path") or "").rstrip("/")
    return ""


@router.get("/backups/download")
async def download_backup(
    request: Request,
    node: str = Query(...),
    storage: str = Query(...),
    volid: str = Query(...),
    connection: Optional[str] = Query(
        None, description="目标 PVE 连接 id（浏览器直接开链接，带不了请求头）"
    ),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> StreamingResponse:
    """把归档文件流给浏览器下载。

    与其它接口不同，这个链接是**浏览器直接打开**的（``window.open``），发不出
    ``X-PVE-Connection`` 头，所以连接按顺序推断：查询参数 → 节点归属 → 当前连接。
    前端知道连接时传 ``connection``；只拿得到节点名（虚拟机详情页）时靠节点归属。
    """
    active = str(store.get_active_connection_id() or "")
    if connection and connection != active:
        set_request_connection(connection)
    elif not requested_connection():
        conn_id = await resolve_node_connection(node)
        if conn_id and conn_id != active:
            set_request_connection(conn_id)

    client = get_client()

    # 下载等于把整台机器的镜像交出去，与删除 / 恢复同一个权限与归属口径
    await assert_backup_access(user, node, storage, volid)

    name = volid.rsplit("/", 1)[-1]
    if not volid.startswith(f"{storage}:") or not _ARCHIVE_NAME_RE.match(name):
        # 归档名会被拼进远程命令，不合法的一律拒绝并留痕（试探 volid 是常见手法）
        await security.audit(
            request, user, "backup.download", target=volid, result="failed",
            detail="归档标识不合法",
        )
        raise HTTPException(status_code=400, detail=f"归档标识不合法：{volid}")

    host_path = await _dir_storage_path(client, storage)
    if not host_path:
        raise HTTPException(
            status_code=400,
            detail=(
                f"存储 {storage} 不是目录型（dir）存储，面板无法直接下载它的归档。"
                "PVE 的 API 不提供整卷下载（file-restore 仅支持 PBS），"
                "这份备份请改用 PBS / PVE 自带的方式取。"
            ),
        )
    remote = f"{host_path}/dump/{name}"

    row = await sshremote.find_by_address(str(client.conn.host))
    if not row:
        raise HTTPException(
            status_code=409,
            detail=(
                f"这台 PVE（{client.conn.host}）还没配置 SSH 凭据，读不到宿主机上的归档。"
                "下载走的是面板已有的 SSH 通道：请到「主机管理」添加该地址的主机"
                "（地址写法要与 PVE 连接里的一致），再回来点下载。"
            ),
        )

    # 先 stat：归档被清理过时给一句清楚的话，而不是让浏览器收一个空文件
    ok, out = await sshremote.run_command(
        row, f"stat -c %s -- {shlex.quote(remote)}", timeout=20
    )
    if not ok:
        await security.audit(
            request, user, "backup.download", target=volid, result="failed",
            detail=f"宿主机上读不到 {remote}",
        )
        raise HTTPException(
            status_code=404,
            detail=f"宿主机上读不到 {remote}：{out.strip()[:200]}",
        )
    try:
        size = int(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        size = 0

    # 支持单段 Range（断点续传 / 只取一段）。浏览器下载用不到，但网络中断后
    # 重试能从断点继续，也方便排查「下到一半的包是不是对的」。
    quoted = shlex.quote(remote)
    start, end, status_code = 0, max(size - 1, 0), 200
    spec = ""
    range_header = request.headers.get("range") or ""
    if size > 0 and range_header.startswith("bytes=") and "," not in range_header:
        spec = range_header[len("bytes="):].strip()
        first, _, last = spec.partition("-")
        try:
            if first:
                start = int(first)
                end = int(last) if last else size - 1
            else:
                start = max(size - int(last), 0)
            if start > end or start >= size:
                raise ValueError("range out of bounds")
            status_code = 206
        except ValueError:
            raise HTTPException(
                status_code=416,
                detail="请求的字节范围超出文件大小",
                headers={"Content-Range": f"bytes */{size}"},
            )

    length = size - start if size > 0 else 0
    if status_code == 206:
        length = end - start + 1
        command = (
            f"dd if={quoted} iflag=skip_bytes,count_bytes "
            f"skip={start} count={length} status=none"
        )
    else:
        command = f"cat -- {quoted}"

    async def body() -> AsyncIterator[bytes]:
        """边读 SSH 边吐给浏览器；中途断开也要把 SSH 连接关掉。"""
        ssh_client = None
        try:
            ssh_client, stdout, stderr = await sshremote.open_command(
                row, command, timeout=60
            )
            while True:
                chunk = await asyncio.to_thread(stdout.read, 512 * 1024)
                if not chunk:
                    break
                yield chunk
            code = await asyncio.to_thread(stdout.channel.recv_exit_status)
            if code != 0:
                err = await asyncio.to_thread(stderr.read)
                logger.warning(
                    "下载归档 %s 时远程命令退出码 %s：%s",
                    remote,
                    code,
                    err.decode("utf-8", "replace")[:300],
                )
        finally:
            if ssh_client is not None:
                ssh_client.close()

    await security.audit(request, user, "backup.download", target=volid)

    headers = {
        "Content-Disposition": f'attachment; filename="{name}"',
        # 边读边发，别让中间层攒完再吐
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-store",
    }
    if size > 0:
        headers["Accept-Ranges"] = "bytes"
        # 0 表示「远程读不到长度」，这时不给 Content-Length，让浏览器按流处理
        if length > 0:
            headers["Content-Length"] = str(length)
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        body(),
        status_code=status_code,
        media_type="application/octet-stream",
        headers=headers,
    )


# ------------------------------------------------------------- 备份防护（防删）
@router.get("/backups/protected")
async def list_protected_backups(
    request: Request,
    verify: bool = Query(False, description="是否顺带与 PVE 实际内容核对一次"),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    """受保护备份清单（可选现场核对，核对结果会刷新每条的状态）。

    管理员看全量；普通用户只看到自己那部分（归档所属虚拟机归自己，或这条
    保护记录是自己登记的）。
    """
    if verify:
        # 核对是全局的幂等维护动作（后台 backup_guard 定时任务本来也在跑），
        # 只读 PVE 存储内容、不涉及跨用户数据，因此不必按用户拆分
        await backupguard.reconcile()
    _, records = await _visible_protected(user)
    await security.audit_read(
        request, user, "backup.protected_read",
        target="protected", detail=f"{len(records)} 个受保护备份",
    )
    return {
        "items": records,
        "note": (
            "面板层禁止删除受保护备份，并定期核对是否被删除 / 改动。"
            "真正的不可变（WORM）需要 PBS immutability 或 S3 Object Lock 等存储侧能力，"
            "面板无法单方面保证。"
        ),
    }


@router.post("/backups/protected")
async def protect_backup(
    payload: BackupProtectIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """把备份登记为受保护，并尽力给 PVE 卷打上 protected 旗标。"""
    await assert_backup_access(user, payload.node, payload.storage, payload.volid)
    result = await backupguard.protect(
        payload.node,
        payload.storage,
        payload.volid,
        vmid=payload.vmid,
        note=payload.note,
        username=str(user.get("username") or ""),
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("detail") or "登记失败")
    await security.audit(
        request, user, "backup.protect", target=payload.volid,
        detail=result.get("detail", "")[:500],
    )
    return result


@router.delete("/backups/protected")
async def unprotect_backup(
    request: Request,
    volid: str = Query(...),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
    # 解除保护意味着备份重新可删：同样要二次确认
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    # 原先只凭一个 volid 就能解除任意备份的防删保护 —— 这是整套备份防护的
    # 总开关，必须先确认这条记录属于当前用户
    record = await backupguard.get_record(volid)
    if not record:
        raise HTTPException(status_code=404, detail="该备份不在受保护清单里")
    await assert_protected_access(user, record)

    result = await backupguard.unprotect(volid)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("detail") or "不存在")
    await security.audit(request, user, "backup.unprotect", target=volid)
    return result


@router.post("/backups/protected/verify")
async def verify_protected_backups(
    request: Request,
    push: bool = Query(True, description="发现异常时是否推送告警"),
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    """立即核对一遍受保护备份（发现丢失 / 被改动会推告警）。

    管理员：全量核对 + 全量告警。
    普通用户：核对动作照跑（幂等维护），但**只回报自己那部分**，也不触发告警
    —— 全量告警是后台 backup_guard 定时任务的职责，不该由某个人点一下按钮
    就给所有人发通知。
    """
    scope = security.visible_owner(user)
    result = await backupguard.reconcile()

    if scope is not None:
        _, mine = await _visible_protected(user)
        items = [
            {
                "volid": str(r.get("volid") or ""),
                "state": str(r.get("state") or "unknown"),
                "detail": str(r.get("state_detail") or ""),
            }
            for r in mine
        ]
        states = [item["state"] for item in items]
        scoped = {
            "checked": len(items),
            "ok": states.count("ok"),
            "missing": states.count("missing"),
            "changed": states.count("changed"),
            "unknown": states.count("unknown"),
        }
        await security.audit(
            request, user, "backup.protected_verify", target="protected",
            result="success" if not (scoped["missing"] or scoped["changed"]) else "failed",
            detail=(
                f"核对自己登记的 {scoped['checked']} 个：丢失 {scoped['missing']}，"
                f"被改动 {scoped['changed']}，无法确认 {scoped['unknown']}"
            ),
        )
        return {**scoped, "items": items, "fired": 0, "scoped": True}

    fired: List[Dict[str, Any]] = []
    if push:
        fired = await backupguard.evaluate()
    await security.audit(
        request, user, "backup.protected_verify", target="protected",
        result="success" if not (result["missing"] or result["changed"]) else "failed",
        detail=(
            f"核对 {result['checked']} 个：异常 {result['missing']}，"
            f"被改动 {result['changed']}，无法确认 {result['unknown']}"
        ),
    )
    return {**result, "fired": len(fired)}


# ------------------------------------------------------------- backup jobs
@router.get("/backups/jobs")
async def list_backup_jobs(
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        jobs = await client.backup_jobs()
    except ProxmoxError as exc:
        _raise(exc)

    scope = security.visible_owner(user)
    # 计划里 vmid 所属机器的**当前**归属优先；机器已删除 / 无主时回落到创建者标记
    vm_owners = await ownership.guest_owners_map()
    output: List[Dict[str, Any]] = []
    for job in jobs or []:
        comment = job.get("comment", "")
        owner = _effective_owner(
            _owner_of(comment),
            vm_owners,
            str(job.get("node") or ""),
            job.get("vmid"),
            _connection_scope(),
        )
        # 用户隔离：普通用户只保留生效归属为自己的计划
        if scope is not None and owner != scope:
            continue
        output.append(
            {
                "id": job.get("id"),
                "job_id": job.get("id"),
                "type": job.get("type", "vzdump"),
                "schedule": job.get("schedule", ""),
                "storage": job.get("storage", ""),
                "mode": job.get("mode", "snapshot"),
                "compress": job.get("compress", ""),
                "node": job.get("node", ""),
                "vmid": job.get("vmid", ""),
                "all": pve_flag(job.get("all", 0)) == 1,
                "enabled": pve_flag(job.get("enabled", 1), 1) == 1,
                "comment": _strip_owner(comment),
                "notes_template": job.get("notes-template", ""),
                "prune_backups": job.get("prune-backups", ""),
                "next_run": job.get("next-run"),
                "mailnotification": job.get("mailnotification", ""),
                "owner": owner,
                "raw": job,
            }
        )
    return output


@router.post("/backups/jobs")
async def create_backup_job(
    payload: BackupJobCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    client = get_client()

    data: Dict[str, Any] = {
        "schedule": payload.schedule,
        "storage": payload.storage,
        "mode": payload.mode,
        "compress": payload.compress,
        "enabled": 1 if payload.enabled else 0,
    }
    if payload.node:
        data["node"] = payload.node
    if payload.all:
        data["all"] = 1
    elif payload.vmid:
        data["vmid"] = payload.vmid
    else:
        raise HTTPException(
            status_code=400, detail="请指定备份的虚拟机列表，或启用“备份全部”"
        )

    # 计划任务同样要按对象校验：它会在后台替你把列表里的机器全备一遍，产物
    # 仍带你的创建者标记（= 可下载）。
    await _require_backup_targets(user, payload.node, payload.vmid, payload.all)

    if payload.notes:
        data["notes-template"] = payload.notes
    # comment 里写创建者标记，列表据此做用户隔离
    comment = _mark_owner(payload.comment, str(user.get("username") or ""))
    if comment:
        data["comment"] = comment
    if payload.mailnotification:
        data["mailnotification"] = payload.mailnotification
    if payload.prune_backups:
        data["prune-backups"] = payload.prune_backups

    try:
        result = await client.backup_job_create(data)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "backup.job.create", target=payload.storage,
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(
        request, user, "backup.job.create", target=str(result or payload.storage),
        detail=data,
    )
    return {"job_id": result, "created": True}


async def _find_job(job_id: str) -> Optional[Dict[str, Any]]:
    """按 id 查 vzdump 计划，拿 comment/vmid/node 做归属判定（找不到返回
    None，交由 PVE 报错）。"""
    client = get_client()
    try:
        jobs = await client.backup_jobs()
    except ProxmoxError:
        return None
    for job in jobs or []:
        if str(job.get("id")) == str(job_id):
            return dict(job)
    return None


async def _require_job_access(
    user: Dict[str, Any], job_id: str, job: Optional[Dict[str, Any]]
) -> None:
    """计划级隔离：计划里 vmid 所属机器的**当前**归属者优先，机器已删除 / 无主时
    回落到 comment 里的创建者标记，两者都不是则拒绝。"""
    scope = security.visible_owner(user)
    if scope is None:
        return
    owner = _owner_of(str((job or {}).get("comment") or ""))
    if job:
        vm_owners = await ownership.guest_owners_map()
        owner = _effective_owner(
            owner,
            vm_owners,
            str(job.get("node") or ""),
            job.get("vmid"),
            _connection_scope(),
        )
    if owner != scope:
        raise HTTPException(
            status_code=403,
            detail=f"备份计划 {job_id} 不属于当前用户，无权操作",
        )


@router.put("/backups/jobs/{job_id}")
async def update_backup_job(
    job_id: str,
    payload: BackupJobCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    client = get_client()
    original_job = await _find_job(job_id)
    if original_job is not None:
        await _require_job_access(user, job_id, original_job)
    # 计划本身是你的，不代表可以把**要备份的机器**改成别人的：comment 里的创建者
    # 标记不会跟着变，产物仍会被认成你的。所以改目标时也要按对象校验一次。
    await _require_backup_targets(
        user,
        payload.node or str((original_job or {}).get("node") or "") or None,
        payload.vmid,
        payload.all,
    )
    data = payload.model_dump(exclude_none=True)

    # PVE uses these parameter names verbatim.
    if "notes" in data:
        data["notes-template"] = data.pop("notes")
    if "enabled" in data:
        data["enabled"] = 1 if data["enabled"] else 0
    if "all" in data:
        data["all"] = 1 if data["all"] else 0
    # comment 若被一并提交，剥离旧标记后原样写回：标记是**创建者线索**（机器删掉
    # 之后唯一的回落依据），不该因为谁编辑了一次计划就被换成编辑者。
    if "comment" in data and original_job is not None:
        original = str(original_job.get("comment") or "")
        owner = _owner_of(original)
        if not owner:
            # 存量计划无创建者标记：靠虚拟机当前归属确认是本人的，顺手固化成标记
            vm_owners = await ownership.guest_owners_map()
            owner = ownership.vm_owner_from(
                vm_owners,
                str(original_job.get("node") or ""),
                original_job.get("vmid"),
                _connection_scope(),
            )
        data["comment"] = (
            _mark_owner(_strip_owner(data["comment"]), owner or "")
            if owner
            else _strip_owner(data["comment"])
        )
        if not data["comment"]:
            data.pop("comment")

    try:
        await client.backup_job_update(job_id, data)
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(
        request, user, "backup.job.update", target=job_id, detail=data
    )
    return {"job_id": job_id, "updated": True}


@router.delete("/backups/jobs/{job_id}")
async def delete_backup_job(
    job_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_any_permission("vm.backup", "ct.backup")),
) -> Dict[str, Any]:
    job = await _find_job(job_id)
    if job is not None:
        await _require_job_access(user, job_id, job)
    client = get_client()
    try:
        await client.backup_job_delete(job_id)
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(request, user, "backup.job.delete", target=job_id)
    return {"job_id": job_id, "deleted": True}
