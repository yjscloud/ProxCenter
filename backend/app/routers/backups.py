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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .. import backupguard, guest_created, ownership, security, sshremote, store
from ..formatters import pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
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

@router.get("/backups/stats")
async def backup_stats(
    days: int = Query(default=7, ge=1, le=90),
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> Dict[str, Any]:
    """最近 N 天的备份任务成败统计，跨所有已保存的 PVE。

    备份任务（vzdump）挂在节点任务列表里，成败与否在列表条目自带的
    ``status`` 字段上就有（"OK" / 其他），不需要逐个任务再查一次状态。

    覆盖范围刻意做成了多主机：哪个节点跑了备份不该由用户记住，
    逐条连接遍历一遍才能保证统计是全量的。
    """
    cutoff = int(time.time()) - days * 86400
    ok_count = 0
    failed = 0
    running = 0
    failures: List[Dict[str, Any]] = []

    pairs = all_connection_clients() or [({}, get_client())]
    for profile, client in pairs:
        cid = str((profile or {}).get("id") or "")
        label = connection_label(profile) if profile else ""
        try:
            nodes = await client.nodes()
        except ProxmoxError:
            continue
        for node_info in nodes or []:
            node = (node_info or {}).get("node")
            if not node:
                continue
            try:
                tasks = await client.get(
                    f"/nodes/{node}/tasks", params={"limit": 300}
                )
            except ProxmoxError:
                continue
            for task in tasks or []:
                if not isinstance(task, dict) or task.get("type") != "vzdump":
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
    }

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


def _vmid_from_volid(volid: str) -> Optional[int]:
    match = _VOLID_VMID_RE.search(volid or "")
    return int(match.group(1)) if match else None


def _connection_scope() -> str:
    """本次操作作用在哪条连接上（与 vms 路由的 ``_op_connection`` 一致）。"""
    return requested_connection() or str(store.get_active_connection_id() or "")


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
    * 归属判定：notes 里的创建者标记优先；无标记（旧版本创建的存量备份）时
      回落到归档 vmid 所属虚拟机的归属者。
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
    owner: Optional[str] = marker
    if not owner:
        vmid = (item or {}).get("vmid") or _vmid_from_volid(volid)
        if vmid is not None:
            vm_owners = await ownership.owners_map(ownership.KIND_VM)
            owner = ownership.vm_owner_from(vm_owners, node, vmid, _connection_scope())

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
    vm_owners = await ownership.owners_map(ownership.KIND_VM)
    connection_id = _connection_scope()
    return scope, [
        r for r in records if _protected_record_owner(r, vm_owners, connection_id) == scope
    ]


async def assert_protected_access(user: Dict[str, Any], record: Dict[str, Any]) -> None:
    """解除保护等变更操作的归属校验：看不见的就不该动得了。"""
    scope = security.visible_owner(user)
    if scope is None:
        return
    vm_owners = await ownership.owners_map(ownership.KIND_VM)
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


@router.get("/backups")
async def list_backups(
    node: Optional[str] = None,
    storage: Optional[str] = None,
    vmid: Optional[int] = None,
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> List[Dict[str, Any]]:
    """List backup archives across the cluster (or one node/storage/VM)."""
    client = get_client()
    scope = security.visible_owner(user)
    # 无创建者标记的存量备份按虚拟机归属回落，一次取全量归属表
    vm_owners = await ownership.owners_map(ownership.KIND_VM)

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
        try:
            storages = await client.storages()
            all_nodes = await client.nodes()
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

    output: List[Dict[str, Any]] = []
    seen_volid: set[str] = set()
    for target_node, target_storage in targets:
        if not target_node or not target_storage:
            continue
        try:
            items = await client.storage_content(
                target_node, target_storage, content="backup", vmid=vmid
            )
        except ProxmoxError:
            continue
        for item in items or []:
            volid = item.get("volid", "")
            if not volid or volid in seen_volid:
                # 共享存储在多个节点返回同一归档，只报一次
                continue
            seen_volid.add(volid)
            notes = item.get("notes", "")
            owner = _owner_of(notes)
            # 用户隔离：创建者标记优先；无标记（旧版本创建）按虚拟机归属回落
            owner = (
                owner
                if owner
                else ownership.vm_owner_from(
                    vm_owners, target_node, item.get("vmid"), _connection_scope()
                )
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
    return output


def _backup_name(volid: str) -> str:
    return volid.rsplit("/", 1)[-1] if "/" in volid else volid


@router.post("/backups")
async def create_backup(
    payload: BackupCreate,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> Dict[str, Any]:
    client = get_client()

    if not payload.all and payload.vmid is None:
        raise HTTPException(
            status_code=400, detail="请指定要备份的虚拟机，或启用“备份全部”"
        )

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
    return {"task": task}


@router.post("/backups/restore")
async def restore_backup(
    payload: BackupRestore,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> Dict[str, Any]:
    storage = payload.storage or payload.volid.split(":", 1)[0]
    await assert_backup_access(user, payload.node, storage, payload.volid)
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
    return {"task": task}


@router.delete("/backups")
async def delete_backup(
    request: Request,
    node: str = Query(...),
    storage: str = Query(...),
    volid: str = Query(...),
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        jobs = await client.backup_jobs()
    except ProxmoxError as exc:
        _raise(exc)

    scope = security.visible_owner(user)
    # 创建者标记优先；无标记（旧版本创建的存量计划）按计划里 vmid 所属虚拟机回落
    vm_owners = await ownership.owners_map(ownership.KIND_VM)
    output: List[Dict[str, Any]] = []
    for job in jobs or []:
        comment = job.get("comment", "")
        owner = _owner_of(comment) or ownership.vm_owner_from(
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
    """计划级隔离：创建者标记优先；无标记（旧版本创建）时按计划里 vmid 所属
    虚拟机归属回落，两者都不是则拒绝。"""
    scope = security.visible_owner(user)
    if scope is None:
        return
    owner = _owner_of(str((job or {}).get("comment") or ""))
    if not owner and job:
        vm_owners = await ownership.owners_map(ownership.KIND_VM)
        owner = ownership.vm_owner_from(
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
) -> Dict[str, Any]:
    client = get_client()
    original_job = await _find_job(job_id)
    if original_job is not None:
        await _require_job_access(user, job_id, original_job)
    data = payload.model_dump(exclude_none=True)

    # PVE uses these parameter names verbatim.
    if "notes" in data:
        data["notes-template"] = data.pop("notes")
    if "enabled" in data:
        data["enabled"] = 1 if data["enabled"] else 0
    if "all" in data:
        data["all"] = 1 if data["all"] else 0
    # comment 若被一并提交，剥离旧标记后重新写回原创建者，防止改着改着换了归属
    if "comment" in data and original_job is not None:
        original = str(original_job.get("comment") or "")
        owner = _owner_of(original)
        if not owner:
            # 存量计划无创建者标记：靠虚拟机归属确认是本人的，顺手固化成标记
            vm_owners = await ownership.owners_map(ownership.KIND_VM)
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.backup")),
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
