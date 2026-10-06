"""虚拟机导入 / 导出的 HTTP 接口。

导入（VMware → PVE）：
    GET  /api/vms/import/sources        已上传到 import 内容的文件
    POST /api/vms/import/upload         上传 OVA / OVF / VMDK / QCOW2
    POST /api/vms/import/inspect        读 OVF/OVA 元数据（PVE 解析）
    POST /api/vms/import                按元数据建机（import-from）

导出（PVE → VMDK / QCOW2 / RAW / OVA）：
    POST   /api/vms/{node}/{vmid}/export        启动导出作业
    GET    /api/vms/exports                      作业列表
    GET    /api/vms/exports/{job_id}             作业状态
    GET    /api/vms/exports/{job_id}/download    下载产物（直链，走 Cookie）
    DELETE /api/vms/exports/{job_id}             删除产物
"""
from __future__ import annotations

import asyncio
import logging
import re
import zipfile
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from .. import ownership, security, sshremote, store, vmtransfer
from ..pve import (
    ProxmoxError,
    get_client,
    requested_connection,
    set_request_connection,
)
from ..schemas import VmExportRequest, VmImportRequest
from ..vm_scope import bind_node_connection, resolve_node_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vms", tags=["vmtransfer"])

VM_VIEW = security.require_permission("vm.view")
VM_CREATE = security.require_permission("vm.create")
VM_BACKUP = security.require_permission("vm.backup")

# 允许上传的导入文件由 vmtransfer.check_upload_name 判定（与 PVE 的
# $UPLOAD_IMPORT_EXT_RE_1 对齐：ova/qcow2/raw/vmdk，**不含 .ovf**）。这些规则以前写在
# 这里的两条正则里，收进了 vmtransfer —— 那里能一起被单测盯住，也能顺手把
# 「散开的 OVF 该放到哪个目录」讲清楚。


def _raise(exc: ProxmoxError) -> None:
    code = exc.status_code if 400 <= exc.status_code < 600 else 500
    raise HTTPException(status_code=code, detail=exc.message)


def _transfer_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ProxmoxError):
        return HTTPException(
            status_code=exc.status_code if 400 <= exc.status_code < 600 else 500,
            detail=exc.message,
        )
    return HTTPException(status_code=400, detail=str(exc))


# ------------------------------------------------------------------- 导入

def _op_connection() -> str:
    """本次操作作用在哪条连接上。

    与 :func:`ownership.vm_ref` / :func:`ownership.import_ref` 的前缀口径必须一致，
    否则写进去的归属查不出来（等于没隔离）。
    """
    return requested_connection() or str(store.get_active_connection_id() or "")


@router.get("/import/sources")
async def import_sources(
    node: str = Query(...),
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """可导入的文件 + 可以作为导入源的存储（向导第一步用）。

    **普通用户只看得到自己上传的文件。** 存储的 import 目录是所有用户共用的一个
    目录，不做隔离的话 A 用户能看见（并且一旦能删就能删掉）B 用户上传的镜像。
    管理员不受限制；没有归属记录的存量文件也只有管理员能看见。
    """
    await bind_node_connection(node)
    client = get_client()
    try:
        storages = await vmtransfer.importable_storages(client, node)
        sources = await vmtransfer.import_sources(client, node)
    except vmtransfer.TransferError as exc:
        raise _transfer_error(exc) from exc
    except ProxmoxError as exc:
        _raise(exc)

    owner = security.visible_owner(user)
    if owner is not None:
        try:
            owners = await ownership.owners_map(ownership.KIND_IMPORT)
        except Exception:  # noqa: BLE001 - 读不到归属时宁可看不到，也不放开
            owners = {}
        conn = _op_connection()
        sources = [
            item
            for item in sources
            if owners.get(
                ownership.import_ref(conn, str(item.get("storage") or ""), str(item.get("volume") or ""))
            )
            == owner
        ]
    return {"storages": storages, "sources": sources}


@router.delete("/import/source")
async def delete_import_source(
    request: Request,
    node: str = Query(...),
    storage: str = Query(...),
    volume: str = Query(...),
    user: Dict[str, Any] = Depends(VM_CREATE),
) -> Dict[str, Any]:
    """删掉一个已上传的导入文件。

    参数走 query 而不是 JSON body：有些代理会剥掉 DELETE 的请求体（与
    storages.delete_storage_content 同一个理由）。

    归属检查回 404 而不是 403 —— 403 等于告诉对方「确实有这么一个文件」，而
    import 目录里可能有别人的镜像。
    """
    await bind_node_connection(node)
    ref = ownership.import_ref(_op_connection(), storage, volume)
    recorded = ""
    try:
        recorded = await ownership.get_owner(ownership.KIND_IMPORT, ref)
    except Exception:  # noqa: BLE001 - 读不到就当没有归属，只放行管理员
        recorded = ""
    username = str(user.get("username") or "")
    if not security.is_admin(user) and recorded != username:
        raise HTTPException(status_code=404, detail="导入文件不存在，可能已被删除")

    client = get_client()
    try:
        # volume 形如 import/xx.ova，里面的斜杠必须编码 —— 否则 PVE 会把
        # import 当成卷名的一部分，后面那截路径直接 404。
        await client.delete(
            f"/nodes/{node}/storage/{storage}/content/{quote(volume, safe='')}"
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.import_delete",
            target=f"{node}/{storage}/{volume}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    try:
        await ownership.delete_owner(ownership.KIND_IMPORT, ref)
    except Exception:  # noqa: BLE001 - 文件已删，归属残留只是下次又看不见它
        logger.warning("导入文件归属清理失败：%s", ref)
    await security.audit(
        request, user, "vm.import_delete", target=f"{node}/{storage}/{volume}"
    )
    return {"ok": True}


@router.post("/import/upload")
async def upload_import_file(
    request: Request,
    node: str = Form(...),
    storage: str = Form(...),
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(VM_CREATE),
) -> Dict[str, Any]:
    """把导入文件流式转发到 PVE 存储的 import 内容里。

    与 ISO 上传同一条通道（不缓冲进内存），只是 content 换成 import ——
    大 OVA 动辄几十 GB，中间不能在面板里落盘。
    """
    await bind_node_connection(node)
    client = get_client()
    filename = str(file.filename or "").strip()
    # 目录型存储的宿主路径（best effort）：OVF 只能靠 scp 放进 import 目录，
    # 把那个目录直接写进提示里，用户照着做就行。
    import_dir = ""
    try:
        base = await vmtransfer.dir_storage_path(client, storage)
        if base:
            import_dir = f"{base}/import/"
    except Exception:  # noqa: BLE001 - 拿不到路径只是少一句提示
        import_dir = ""
    try:
        filename = vmtransfer.check_upload_name(filename, import_dir)
    except vmtransfer.TransferError as exc:
        raise _transfer_error(exc) from exc

    http = await client._http()
    endpoint = f"{client.conn.api_url}/nodes/{node}/storage/{storage}/upload"
    try:
        resp = await http.post(
            endpoint,
            data={"content": "import"},
            files={"filename": (filename, file.file, "application/octet-stream")},
            headers=client._auth_headers(),
            timeout=httpx.Timeout(7200.0, connect=20.0),
        )
    except Exception as exc:  # noqa: BLE001
        await security.audit(
            request, user, "vm.import_upload", target=f"{node}/{storage}/{filename}",
            result="failed", detail=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"上传失败：{exc}") from exc

    if resp.status_code >= 400:
        from ..pve import _extract_error

        message = vmtransfer.upload_error_text(_extract_error(resp), import_dir)
        await security.audit(
            request, user, "vm.import_upload", target=f"{node}/{storage}/{filename}",
            result="failed", detail=message,
        )
        code = 502 if resp.status_code in (401, 403) else resp.status_code
        raise HTTPException(status_code=code, detail=message)

    # 记归属。存储的 import 目录是所有用户共用的一处，不记的话：普通用户在
    # sources 列表里看不到自己刚上传的文件（下一步的过滤会滤掉它），别人也照样
    # 看得见、删得掉。归属记不上不该让上传失败 —— 文件确实已经在 PVE 上了。
    try:
        await ownership.set_owner(
            ownership.KIND_IMPORT,
            ownership.import_ref(_op_connection(), storage, f"import/{filename}"),
            str(user.get("username") or ""),
        )
    except Exception:  # noqa: BLE001
        logger.warning("导入文件归属写入失败：%s/%s", storage, filename)
    await security.audit(
        request, user, "vm.import_upload", target=f"{node}/{storage}/{filename}"
    )
    return {"volume": f"import/{filename}", "name": filename, "storage": storage}


@router.post("/import/inspect")
async def inspect_import(
    payload: VmImportRequest,
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """读导入文件的元数据（内存 / 核数 / 磁盘清单 / 警告）。"""
    await bind_node_connection(payload.node)
    client = get_client()
    try:
        return await vmtransfer.import_metadata(
            client, payload.node, payload.storage, payload.volume
        )
    except vmtransfer.TransferError as exc:
        raise _transfer_error(exc) from exc
    except ProxmoxError as exc:
        _raise(exc)


@router.post("/import")
async def create_imported_vm(
    payload: VmImportRequest,
    request: Request,
    user: Dict[str, Any] = Depends(VM_CREATE),
) -> Dict[str, Any]:
    """按 OVF/OVA 的元数据建一台新虚拟机（磁盘用 import-from 拉进来）。"""
    await bind_node_connection(payload.node)
    client = get_client()
    try:
        meta = await vmtransfer.import_metadata(
            client, payload.node, payload.storage, payload.volume
        )
        vmid = payload.vmid
        if not vmid:
            vmid = int(await client.nextid())
        config = vmtransfer.build_import_config(
            meta,
            target_storage=payload.target_storage,
            bridge=payload.bridge,
            bus=payload.bus,
            scsihw=payload.scsihw,
            disk_format=payload.disk_format,
            firmware=payload.firmware,
            cpu=payload.cpu,
            memory=payload.memory,
            cores=payload.cores,
            net_model=payload.net_model,
            ip_mode=payload.ip_mode,
            ip=payload.ip,
            gateway=payload.gateway,
            dns=payload.dns,
            ci_user=payload.ci_user,
            ci_password=payload.ci_password,
            ssh_keys=payload.ssh_keys,
        )
        config["vmid"] = vmid
        config["name"] = payload.name or (meta.get("create_args") or {}).get("name") or f"import-{vmid}"
        if payload.ostype:
            config["ostype"] = payload.ostype
        upid = await client.qemu_create(payload.node, config)
    except vmtransfer.TransferError as exc:
        await security.audit(
            request, user, "vm.import", target=f"{payload.node}/{payload.volume}",
            result="failed", detail=str(exc),
        )
        raise _transfer_error(exc) from exc
    except ProxmoxError as exc:
        await security.audit(
            request, user, "vm.import", target=f"{payload.node}/{payload.volume}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    if payload.start:
        _schedule_autostart(payload.node, vmid, upid, _op_connection())

    await security.audit(
        request, user, "vm.import", target=f"{payload.node}/{vmid}",
        detail=f"{payload.volume} → VMID {vmid}",
    )

    # 记录归属。漏了这一步的后果不是「多看到一台」，而是**刚导入完的机器在列表里
    # 查无此机**：普通用户的列表是严格隔离（collect_vms 里按 resource_owner 等值
    # 匹配），没有归属记录就等于不存在 —— 而用户明明看到导入成功了，只会觉得导入丢了。
    # 其它每条创建路径都写了：vms.create_vm、vms.clone_vm、templates.clone、
    # lxc 的新建与克隆，这里是唯一漏掉的一条。
    #
    # 连接 id 必须与列表侧拼 ref 时用的**完全一致**（vm_ref 的前缀对不上等于没写），
    # 所以用与 vms._op_connection 相同的解析：先看本次请求指定的连接，再退到当前
    # 活跃的那条。
    await ownership.set_owner(
        ownership.KIND_VM,
        ownership.vm_ref(
            requested_connection() or str(store.get_active_connection_id() or ""),
            payload.node,
            vmid,
        ),
        str(user.get("username") or ""),
    )
    return {
        "task": upid,
        "vmid": vmid,
        "node": payload.node,
        "warnings": meta.get("warnings") or [],
        "disks": meta.get("disks") or {},
    }


# ------------------------------------------------------------------- 导出

@router.post("/{node}/{vmid}/export")
async def start_export(
    node: str,
    vmid: int,
    payload: VmExportRequest,
    request: Request,
    user: Dict[str, Any] = Depends(VM_BACKUP),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """启动导出作业。

    只允许**关机**的虚拟机：导出是逐块读磁盘，跑着的机器拿不到一致的数据。
    产物落在所选 dir 存储的 dump 目录下，随后由前端轮询 + 流式下载取走。
    """
    await bind_node_connection(node)
    client = get_client()
    try:
        vm = await client.get(f"/nodes/{node}/qemu/{vmid}/config")
    except ProxmoxError as exc:
        _raise(exc)
    name = str((vm or {}).get("name") or f"vm-{vmid}")
    if payload.name and payload.name.strip():
        name = payload.name.strip()
    try:
        # 名称会变成产物文件名、OVA 里 .ovf 的引用、.vmx 里的 displayName，
        # 以及下载时的压缩包名 —— 统一在这里校验干净。
        # 默认名出自 PVE，也一并过一遍。
        name = vmtransfer.check_export_name(name)
    except vmtransfer.TransferError as exc:
        raise _transfer_error(exc) from exc
    try:
        job = await vmtransfer.start_export(
            client,
            node=node,
            vmid=vmid,
            name=name,
            fmt=payload.format,
            storage=payload.storage,
            owner=str(user.get("username") or ""),
            connection=requested_connection() or store.get_active_connection_id() or "",
        )
    except vmtransfer.TransferError as exc:
        await security.audit(
            request, user, "vm.export", target=f"{node}/{vmid}", result="failed",
            detail=str(exc),
        )
        raise _transfer_error(exc) from exc
    await security.audit(
        request, user, "vm.export", target=f"{node}/{vmid}",
        detail=f"{payload.format} → {payload.storage}",
    )
    return {"job": job.public()}


def _schedule_autostart(
    node: str, vmid: int, upid: str, connection: str
) -> None:
    """建机任务（连同 ``import-from`` 搬盘）跑完后自动开机。

    为什么必须放后端，而不是让前端在任务结束后调电源接口：

    * ``useTaskRunner.run()`` 交出来的是 **TaskInfo**（只有 upid，没有 vmid），
      前端根本拿不到刚建的那台机器的 ID —— 上一版就是这么写的，结果启动请求
      一次都没发出去。
    * 就算拿得到，用户在导入期间刷新或关掉页面，这个「等任务结束再开机」的接力
      也就丢了。放在后端由 asyncio 任务守着，与页面无关。
    * **连接 id 必须在这里就抓住**：后台任务不在请求上下文里，
      ``requested_connection()`` 那时已经失效。
    """
    asyncio.create_task(  # noqa: RUF006 - fire and forget，等它自己跑完
        _autostart_when_ready(node, vmid, upid, connection)
    )


async def _autostart_when_ready(
    node: str, vmid: int, upid: str, connection: str
) -> None:
    from .. import pve

    client = pve.client_for_connection(connection)
    try:
        await client.wait_for_task(upid, node=node, timeout=7200.0)
    except Exception:  # noqa: BLE001 - 任务没成功结束就别去开机了
        logger.warning("导入任务未成功结束，跳过自动开机：%s/%s", node, vmid, exc_info=True)
        return
    try:
        await client.qemu_power(node, vmid, "start")
        logger.info("导入完成，已自动开机：%s/%s", node, vmid)
    except Exception:  # noqa: BLE001 - 机器已经建好了，只是没开起来
        logger.warning("导入完成但自动开机失败：%s/%s", node, vmid, exc_info=True)


#: PVE 导入大磁盘时逐行输出的进度，例如
#: ``transferred 6.0 GiB of 100.0 GiB (6.00%)``
_IMPORT_PROGRESS_RE = re.compile(
    r"transferred\s+([\d.]+)\s*([KMGT]?i?B)\s+of\s+([\d.]+)\s*([KMGT]?i?B)"
    r"\s*\(([\d.]+)%\)"
)


@router.get("/import/progress")
async def import_progress(
    upid: str = Query(...),
    node: str = Query(...),
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """从 PVE 的任务日志里解析导入进度。

    为什么不用 task 接口自带的 progress：对 qmcreate 它一直是 None（实测），而导入
    几十 GB 的磁盘动辄要好几分钟 —— 界面上只能干等，用户完全分不清「在跑」和
    「卡死」。任务日志里那行 ``transferred X of Y (Z%)`` 才是真正可读的进度。

    注意这个百分比是按**磁盘标称容量**算的分母，所以稀疏盘会一路"虚低"到最后，
    随后瞬间跳到结束 —— 这是 PVE 的算法，不是我们能改的。
    """
    await bind_node_connection(node)
    client = get_client()
    try:
        lines = await client.task_log(upid, node=node, limit=400)
    except ProxmoxError as exc:
        raise _transfer_error(exc) from exc
    percent = 0.0
    transferred = ""
    total = ""
    for item in reversed(lines or []):
        text = str(item.get("t") or item.get("text") or "")
        match = _IMPORT_PROGRESS_RE.search(text)
        if match:
            percent = float(match.group(5))
            transferred = f"{match.group(1)} {match.group(2)}"
            total = f"{match.group(3)} {match.group(4)}"
            break
    return {
        "percent": percent,
        "transferred": transferred,
        "total": total,
        "lines": len(lines or []),
    }


def _ensure_visible(job: Any, user: Dict[str, Any]) -> None:
    """产物属于别人时，一律当作「不存在」。

    这里回 404 而不是 403：403 等于承认「确实有这么一份导出」，而这台机器上放着
    的可能是别人的整套系统镜像。管理员不受限；扫描出来的孤儿产物没有归属信息，
    也放行 —— 它本来就是一块没人认领、该被清掉的磁盘。
    """
    owner = str(getattr(job, "owner", "") or "")
    if not owner or security.is_admin(user):
        return
    if owner != str(user.get("username") or ""):
        raise HTTPException(status_code=404, detail="导出产物不存在，可能已被删除")


def _public_scan_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """把扫描出来的产物整理成与 job.public() 同形的结构（去掉内部字段）。"""
    return {
        "id": item.get("id"),
        "node": item.get("node"),
        "vmid": item.get("vmid"),
        "name": item.get("name"),
        "format": item.get("format"),
        "storage": item.get("storage"),
        "status": item.get("status"),
        "stage": item.get("stage"),
        "progress": item.get("progress"),
        "detail": item.get("detail"),
        "files": item.get("files") or [],
        "created": item.get("created") or 0,
        "finished": item.get("finished") or 0,
        # 面板重启前留下的产物：没有身份文件，所以不知道属于哪台机器
        "orphan": bool(item.get("_orphan")),
    }


@router.get("/exports")
async def list_exports(
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """导出列表：内存里正在跑/刚跑完的作业，加上宿主机上仍然存在的产物。

    两边都要看：只看内存会漏掉面板重启前留下的镜像（用户既看不到也删不掉），
    只看磁盘则会漏掉正在转换的那个。合并时以内存为准，磁盘上只补内存里没有的。
    """
    is_admin = security.is_admin(user)
    username = str(user.get("username") or "")
    jobs = [
        job.public()
        for job in vmtransfer.list_jobs()
        if is_admin or job.owner == username
    ]
    seen = {str(item.get("id")) for item in jobs}
    try:
        for item in await vmtransfer.scan_exports():
            if str(item.get("id")) in seen:
                continue
            # 身份文件里记着是谁导的，所以普通用户也能看到自己重启前导的那份；
            # 完全查不到归属的孤儿产物只给管理员看
            owner = str(item.get("_owner") or "")
            if not is_admin and owner != username:
                continue
            jobs.append(_public_scan_item(item))
    except Exception:  # noqa: BLE001 - 扫描失败不该让列表整体报错
        logger.warning("扫描导出产物失败", exc_info=True)
    jobs.sort(key=lambda item: int(item.get("created") or 0), reverse=True)
    return {"jobs": jobs}


@router.get("/exports/{job_id}")
async def get_export(
    job_id: str,
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    job = await vmtransfer.find_export(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出产物不存在，可能已被删除")
    _ensure_visible(job, user)
    return {"job": job.public()}


@router.get("/exports/{job_id}/download")
async def download_export(
    job_id: str,
    request: Request,
    file: str = Query(..., description="产物文件名（作业里的 files[].name）"),
    user: Dict[str, Any] = Depends(VM_BACKUP),
) -> StreamingResponse:
    """流式下载导出产物。

    浏览器直接开链接下载（``window.open``），发不出 ``X-PVE-Connection`` 头，
    所以连接 id 由作业自己记着 —— 这也是作业里存 ``connection`` 的原因。
    """
    job = await vmtransfer.find_export(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出产物不存在，可能已被删除")
    _ensure_visible(job, user)
    if job.status != "done":
        raise HTTPException(status_code=409, detail="导出还没完成，请稍候")
    names = {str(item.get("name")) for item in job.files}
    if file not in names:
        raise HTTPException(status_code=400, detail="产物文件名不合法")

    if job.connection and job.connection != str(store.get_active_connection_id() or ""):
        set_request_connection(job.connection)
    elif not requested_connection():
        conn_id = await resolve_node_connection(job.node)
        if conn_id:
            set_request_connection(conn_id)
    client = get_client()
    row, message = await vmtransfer.resolve_ssh_host(client)
    if not row:
        raise HTTPException(status_code=409, detail=message)

    remote = f"{job.dir}/{file}"
    size = await vmtransfer.file_size(row, remote)
    if size <= 0:
        raise HTTPException(status_code=404, detail=f"宿主机上读不到产物：{remote}")

    range_header = request.headers.get("range") or ""
    start, end, status_code = 0, size - 1, 200
    if range_header.startswith("bytes=") and "," not in range_header:
        spec = range_header[len("bytes=") :].strip()
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

    length = end - start + 1 if status_code == 206 else size
    quoted = vmtransfer._quote(remote)
    if status_code == 206:
        command = (
            f"dd if={quoted} iflag=skip_bytes,count_bytes "
            f"skip={start} count={length} status=none"
        )
    else:
        command = f"cat -- {quoted}"

    async def body() -> AsyncIterator[bytes]:
        ssh_client = None
        try:
            ssh_client, stdout, _stderr = await sshremote.open_command(
                row, command, timeout=120
            )
            while True:
                chunk = await asyncio.to_thread(stdout.read, 512 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            if ssh_client is not None:
                ssh_client.close()

    await security.audit(
        request, user, "vm.export_download", target=f"{job.node}/{job.vmid}",
        detail=file,
    )
    headers = {
        "Content-Disposition": f'attachment; filename="{file}"',
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        body(),
        status_code=status_code,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/exports/{job_id}/archive")
async def download_export_archive(
    job_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(VM_BACKUP),
) -> StreamingResponse:
    """把一次导出的全部产物打成一个压缩包流式回吐。

    为什么要它：VMDK 这条路一次会产出好几个文件（每块盘一个 .vmdk，再加一份
    .vmx），逐个点下载、再自己凑到同一个目录里，恰恰是最容易出错的一步 ——
    漏下一个、或者放错了目录，VMware 就直接打不开。

    压缩包**在宿主机上边打边传，不落盘**：几十 GB 的镜像先在临时目录复制一份，
    磁盘就先满了。
    """
    job = await vmtransfer.find_export(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出产物不存在，可能已被删除")
    _ensure_visible(job, user)
    if job.status != "done":
        raise HTTPException(status_code=409, detail="导出还没完成，请稍候")
    names = [str(item.get("name")) for item in job.files]
    if not names:
        raise HTTPException(status_code=409, detail="这次导出没有可下载的产物")
    sizes = {str(item.get("name")): int(item.get("size") or 0) for item in job.files}

    # 与单个文件下载同理：浏览器直链发不出 X-PVE-Connection 头
    if job.connection and job.connection != str(store.get_active_connection_id() or ""):
        set_request_connection(job.connection)
    elif not requested_connection():
        conn_id = await resolve_node_connection(job.node)
        if conn_id:
            set_request_connection(conn_id)
    client = get_client()
    row, message = await vmtransfer.resolve_ssh_host(client)
    if not row:
        raise HTTPException(status_code=409, detail=message)

    archive = f"{job.name}.zip"

    async def body() -> AsyncIterator[bytes]:
        """逐个文件从宿主机读出、实时写进 zip 一并回吐。

        刻意**不依赖宿主机上的 zip 命令**：PVE 上装没装它说不准（实测常见环境就是
        没装），而这个包是给 Windows 用户解压用的，退回 tar 等于把麻烦丢回给用户。
        边读边打包，宿主机上也不留临时文件 —— 几十 GB 的镜像先复制一份，磁盘就先满了。

        压缩用 ZIP_STORED：vmdk / qcow2 本身已经压过一遍，再 DEFLATE 只是白烧 CPU。
        这里要的是「一个文件装下全部」，不是体积。
        """
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        class _Sink:
            '''zipfile 只要求 write()；数据顺手推进队列交给响应流。'''

            def write(self, data: bytes) -> int:
                queue.put_nowait(bytes(data))
                return len(data)

            def flush(self) -> None:
                return None

        class _Counting:
            '''不可 seek 的输出流：zipfile 会用 data descriptor 收尾。'''

            def __init__(self, sink: Any) -> None:
                self._sink = sink
                self._offset = 0

            def write(self, data: bytes) -> int:
                written = self._sink.write(data)
                self._offset += written
                return written

            # zipfile 收尾时会调 flush；代理层漏掉它，整个下载会在最后一步炸掉。
            # （这种错 py_compile 与类型检查都看不出来，只能靠真跑一遍。）
            def flush(self) -> None:
                self._sink.flush()

            def tell(self) -> int:
                return self._offset

            def seekable(self) -> bool:
                return False

        async def produce() -> None:
            try:
                with zipfile.ZipFile(
                    _Counting(_Sink()), "w", zipfile.ZIP_STORED
                ) as bundle:
                    for name in names:
                        # 单个条目 ≥2GB（zip 的 32 位上限）必须**提前**声明 ZIP64。
                        # 我们写的是一个不可 seek 的输出流，zipfile 没法在收尾时回填
                        # 真实大小，只能在开头声明 —— 不声明，它就会在这个条目写完的
                        # 一刻抛「File size too large, try using force_zip64」，
                        # 表现就是「下载快完时失败」：几十 GB 的磁盘镜像必然踩到。
                        # 大小未知（stat 没拿到）时也按 ZIP64 走，宁可多几个字节。
                        known = sizes.get(name, 0)
                        force64 = known <= 0 or known >= zipfile.ZIP64_LIMIT
                        with bundle.open(name, "w", force_zip64=force64) as entry:
                            ssh_client, stdout, _stderr = await sshremote.open_command(
                                row,
                                f"cat -- {vmtransfer._quote(f'{job.dir}/{name}')}",
                                timeout=7200,
                            )
                            try:
                                while True:
                                    chunk = await asyncio.to_thread(
                                        stdout.read, 512 * 1024
                                    )
                                    if not chunk:
                                        break
                                    entry.write(chunk)
                                    # 背压：下载端读得慢时，别把几十 GB 全堆进内存
                                    while queue.qsize() >= 8:
                                        await asyncio.sleep(0.05)
                            finally:
                                ssh_client.close()
            except Exception:  # noqa: BLE001 - 断了就让客户端看到失败，别当传完了
                logger.warning("打包下载失败（id=%s）", job.id, exc_info=True)
                raise
            finally:
                queue.put_nowait(done)

        task = asyncio.create_task(produce())
        try:
            while True:
                chunk = await queue.get()
                if chunk is done:
                    break
                yield chunk
            await task
        finally:
            if not task.done():
                task.cancel()

    await security.audit(
        request,
        user,
        "vm.export_download",
        target=f"{job.node}/{job.vmid}",
        detail=f"archive({len(names)} files)",
    )
    # 名字里可能有中文与空格：ASCII 那份给老客户端兜底，filename* 才是真名。
    # 打包后的大小事先不知道，所以不设 Content-Length，也就没法支持断点续传。
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", archive) or "export.zip"
    return StreamingResponse(
        body(),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(archive, safe='')}"
            ),
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
        },
    )


@router.delete("/exports/{job_id}")
async def delete_export(
    job_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(VM_BACKUP),
) -> Dict[str, Any]:
    """删除宿主机上的导出产物（作业记录一并移除）。

    产物不认内存、只认磁盘：面板重启后作业表是空的，但那块几十 GB 的镜像还在，
    用户必须删得掉它。find_export 会把这类产物从宿主机上认回来。
    """
    job = await vmtransfer.find_export(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出产物不存在，可能已被删除")
    _ensure_visible(job, user)
    try:
        await vmtransfer.cleanup_job(job)
    except vmtransfer.TransferError as exc:
        raise _transfer_error(exc) from exc
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "vm.export_delete", target=f"{job.node}/{job.vmid}", detail=job_id
    )
    return {"ok": True}
