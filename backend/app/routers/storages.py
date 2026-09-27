"""Storage and storage-content endpoints."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from .. import security
from ..pve import (
    ProxmoxClient,
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    requested_connection,
    set_request_connection,
)
from ..formatters import normalize_storage, pve_flag
from .backups import assert_backup_access

logger = logging.getLogger(__name__)

# node -> (命中时间, 连接 id)。只缓存成功结果。
# 存储页会按 15 秒轮询，缓存可避免把 /nodes 反复打到每台 PVE 上。
_node_owner_cache: Dict[str, Tuple[float, str]] = {}
_NODE_OWNER_TTL = 60.0


async def _owner_of_node(node: str) -> str:
    """节点名 → 拥有该节点的连接 id；无法确定时返回空串（沿用当前连接）。

    节点名在每台 PVE 上是**本地的**。多主机场景下前端只按节点名筛选（它并不知道
    该名字属于哪台主机），若请求落到「当前连接」，而该连接上没有这个节点，PVE 会
    把这个名字当主机名去解析并报 ``hostname lookup 'x' failed`` —— 用户在存储页
    看到的就是「无法加载存储列表」。

    先问当前连接：绝大多数节点都在当前主机上，命中即可跳过对其余主机的探测。
    """
    cached = _node_owner_cache.get(node)
    if cached and time.time() - cached[0] < _NODE_OWNER_TTL:
        return cached[1]

    from ..store import get_active_connection_id

    try:
        nodes = await get_client().nodes() or []
    except ProxmoxError:
        nodes = []
    if any(n.get("node") == node for n in nodes):
        cid = str(get_active_connection_id() or "")
        _node_owner_cache[node] = (time.time(), cid)
        return cid

    for profile, client in all_connection_clients():
        try:
            nodes = await client.nodes() or []
        except ProxmoxError:
            continue
        if any(n.get("node") == node for n in nodes):
            cid = str(profile.get("id") or "")
            _node_owner_cache[node] = (time.time(), cid)
            return cid

    return ""


async def bind_node_connection(node: Optional[str] = None) -> None:
    """路由级依赖：只给了节点名时，把请求绑定到拥有该节点的 PVE。

    与 :func:`app.vm_scope.bind_vm_connection` 同一套路 —— FastAPI 会把同名的
    查询参数 ``node`` 注入进来；显式带了 ``X-PVE-Connection`` 时一律不干预。
    """
    if not node or requested_connection():
        return
    conn_id = await _owner_of_node(node)
    if conn_id:
        set_request_connection(conn_id)


router = APIRouter(
    prefix="/api",
    tags=["storages"],
    # 存储相关的接口都按「节点」寻址，统一在这里完成连接绑定
    dependencies=[Depends(bind_node_connection)],
)


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


async def _storages_of_all_nodes(client: Any) -> List[Dict[str, Any]]:
    """汇总每个节点的存储状态。

    不能直接用 PVE 的 ``/storage``：那个端点返回的是存储「定义」（名称、类型、
    内容类型等），**没有 total / used / avail**。前端拿到的容量字段全是 undefined，
    「存储使用率」因此恒为 0。改成逐节点取 ``/nodes/{node}/storage`` 再拼起来，
    才是带容量数据的真实状态。单个节点不可达时跳过，不影响其余节点。
    """
    nodes = await client.nodes() or []
    names = [n.get("node") for n in nodes if n.get("node")]
    if not names:
        return []

    results = await asyncio.gather(
        *(client.storages(name) for name in names),
        return_exceptions=True,
    )

    merged: List[Dict[str, Any]] = []
    for name, items in zip(names, results):
        if isinstance(items, BaseException):
            logger.warning("读取节点 %s 的存储失败：%s", name, items)
            continue
        merged.extend(items or [])
    return merged


async def _storages_of_all_connections() -> List[Dict[str, Any]]:
    """汇总所有已保存 PVE 上的存储。

    与 ``/nodes`` 的语义保持一致：不指定 ``X-PVE-Connection`` 时覆盖全部主机，
    某一台连不上只跳过它自己。每条存储都标注来源连接 —— 两台主机上的同名存储
    是各自独立的两份容量，去重与展示都必须能区分开。
    """
    pairs = all_connection_clients()
    if not pairs:
        # 还没有任何连接配置，退回当前客户端，保留原有的报错行为
        return await _storages_of_all_nodes(get_client())

    async def collect(
        profile: Dict[str, Any], client: ProxmoxClient
    ) -> List[Dict[str, Any]]:
        try:
            items = await _storages_of_all_nodes(client)
        except ProxmoxError as exc:
            logger.warning(
                "读取 %s 的存储失败：%s", connection_label(profile), exc.message
            )
            return []
        cid = str(profile.get("id") or "")
        label = connection_label(profile)
        return [{**s, "connection_id": cid, "connection_name": label} for s in items]

    groups = await asyncio.gather(*(collect(p, c) for p, c in pairs))
    return [s for group in groups for s in group]


@router.get("/storages")
async def list_storages(
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("storage.view")),
) -> List[Dict[str, Any]]:
    """存储列表。多 PVE 下的寻址规则与 ``/nodes`` 保持一致：

    * 只给 ``node`` —— ``bind_node_connection`` 已先把请求绑到该节点所在的 PVE；
    * 带了 ``X-PVE-Connection`` —— 只查该主机；
    * 都不给 —— 聚合全部主机的全部节点。

    不带 ``node`` 时绝不能直接查 ``/storage``：那个端点返回的是存储「定义」，
    没有 total / used / avail，前端容量会全是 undefined。
    """
    storages: List[Dict[str, Any]] = []
    try:
        if node or requested_connection():
            client = get_client()
            storages = (
                await client.storages(node)
                if node
                else await _storages_of_all_nodes(client)
            )
        else:
            storages = await _storages_of_all_connections()
    except ProxmoxError as exc:
        _raise(exc)

    # 单主机查询路径拿不到来源标识（只有聚合路径才会打标），而前端要靠它
    # 区分两台主机上的同名存储，这里统一补上本次实际使用的连接。
    from ..store import get_active_connection_id

    fallback = requested_connection() or str(get_active_connection_id() or "")
    return [
        normalize_storage(
            {**s, "connection_id": s.get("connection_id") or fallback}, node
        )
        for s in (storages or [])
    ]


@router.get("/storages/content")
async def storage_content(
    node: str,
    storage: str,
    content: Optional[str] = Query(
        default=None, description="images | iso | backup | snippets | vztmpl"
    ),
    vmid: Optional[int] = None,
    user: Dict[str, Any] = Depends(security.require_permission("storage.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        items = await client.storage_content(node, storage, content=content, vmid=vmid)
    except ProxmoxError as exc:
        _raise(exc)

    output: List[Dict[str, Any]] = []
    for item in items or []:
        volid = item.get("volid", "")
        output.append(
            {
                "volid": volid,
                "format": item.get("format", ""),
                "size": item.get("size"),
                "ctime": item.get("ctime"),
                "vmid": item.get("vmid"),
                "name": _display_name(volid),
                "content": item.get("content", content or ""),
                "used": item.get("used"),
                "protected": pve_flag(item.get("protected", 0)) == 1,
                "notes": item.get("notes", ""),
            }
        )
    output.sort(key=lambda i: i.get("ctime") or 0, reverse=True)
    return output


def _display_name(volid: str) -> str:
    """``local:iso/ubuntu-24.04.iso`` -> ``ubuntu-24.04.iso``."""
    if "/" in volid:
        return volid.rsplit("/", 1)[-1]
    if ":" in volid:
        return volid.rsplit(":", 1)[-1]
    return volid


@router.delete("/storages/content")
async def delete_storage_content(
    request: Request,
    node: str = Query(...),
    storage: str = Query(...),
    volid: str = Query(...),
    user: Dict[str, Any] = Depends(security.require_permission("storage.manage")),
) -> Dict[str, Any]:
    """Delete a volume (ISO, backup, disk image, snippet).

    Parameters are query strings rather than a JSON body because some proxies
    strip request bodies from DELETE requests.
    """
    # 备份归档也走这个通用删除入口（备份页前端即如此），先做备份级用户隔离
    await assert_backup_access(
        user, node, storage, volid, strict_missing=False
    )
    client = get_client()
    try:
        await client.delete(
            f"/nodes/{node}/storage/{storage}/content/{volid}"
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "storage.delete", target=f"{node}/{storage}/{volid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(
        request, user, "storage.delete", target=f"{node}/{storage}/{volid}"
    )
    # PVE performs this synchronously and returns null.
    return {"task": None, "deleted": volid}


@router.post("/storages/upload")
async def upload_to_storage(
    request: Request,
    node: str = Form(...),
    storage: str = Form(...),
    content: str = Form("iso"),
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(security.require_permission("storage.manage")),
) -> Dict[str, Any]:
    """Upload an ISO or image into a PVE storage.

    Streams the upload straight through to Proxmox so large ISOs never need to
    be buffered in memory.
    """
    client = get_client()
    http = await client._http()

    filename = file.filename or "upload.bin"
    endpoint = f"{client.conn.api_url}/nodes/{node}/storage/{storage}/upload"

    # Stream the incoming file body to PVE as multipart form-data.
    try:
        files = {"filename": (filename, file.file, "application/octet-stream")}
        data = {"content": content}
        resp = await http.post(
            endpoint,
            data=data,
            files=files,
            headers=client._auth_headers(),
            timeout=httpx_timeout_long(),
        )
    except Exception as exc:  # noqa: BLE001
        await security.audit(
            request, user, "storage.upload", target=f"{node}/{storage}/{filename}",
            result="failed", detail=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"上传失败：{exc}") from exc

    if resp.status_code >= 400:
        from ..pve import _extract_error

        message = _extract_error(resp)
        await security.audit(
            request, user, "storage.upload", target=f"{node}/{storage}/{filename}",
            result="failed", detail=message,
        )
        # Proxmox 的 401/403 表示上游凭据问题，不能透传给前端当会话失效
        code = 502 if resp.status_code in (401, 403) else resp.status_code
        raise HTTPException(status_code=code, detail=message)

    await security.audit(
        request, user, "storage.upload", target=f"{node}/{storage}/{filename}"
    )

    payload = resp.json().get("data")
    return {"task": payload if isinstance(payload, str) else "", "filename": filename}


def httpx_timeout_long() -> Any:
    """Long timeout for large uploads (ISOs can be several GB)."""
    import httpx

    return httpx.Timeout(1800.0, connect=20.0)


@router.get("/storages/iso")
async def list_isos(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("storage.view")),
) -> List[Dict[str, Any]]:
    """All ISO and disk-image volumes on a node, for the create wizard."""
    client = get_client()
    try:
        storages = await client.storages(node)
    except ProxmoxError as exc:
        _raise(exc)

    results: List[Dict[str, Any]] = []
    for storage in storages or []:
        name = storage.get("storage")
        contents = (storage.get("content") or "").split(",")
        if not name:
            continue
        for wanted in ("iso", "vztmpl"):
            if wanted not in contents:
                continue
            try:
                items = await client.storage_content(node, name, content=wanted)
            except ProxmoxError:
                continue
            for item in items or []:
                volid = item.get("volid", "")
                results.append(
                    {
                        "volid": volid,
                        "storage": name,
                        "name": _display_name(volid),
                        "size": item.get("size"),
                        "content": wanted,
                        "format": item.get("format", ""),
                        "is_cloud_image": volid.lower().endswith((".img", ".qcow2")),
                    }
                )
    return results
