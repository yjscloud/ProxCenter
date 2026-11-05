"""Storage and storage-content endpoints."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile

from .. import guestguard, ownership, pvecache, security, store, vmconfig
from ..pve import (
    ProxmoxClient,
    ProxmoxError,
    all_connection_clients,
    bound_connection,
    connection_label,
    get_client,
    requested_connection,
    set_request_connection,
)
from ..formatters import normalize_storage, pve_flag
from ..schemas import StorageDownloadUrl
from ..vm_scope import resolve_node_connection
from .backups import assert_backup_access

logger = logging.getLogger(__name__)

#: PVE 拒绝上传文件时的扩展名话术。它只会说「扩展名不对」：没有中文，也不说
#: 这个内容类型接受哪些格式 —— 用户在浏览器里等了几十分钟的几 GB ISO，
#: 最后收到一句 ``filename: wrong file extension``，只能靠猜。
_UPLOAD_EXT_ERR = ("wrong extension", "invalid filename")

#: 磁盘镜像容器的 magic（文件前 4 字节）。扩展名不可信，这是唯一可靠的依据。
#:
#: Ubuntu 官方的 ``*-cloudimg-amd64.img`` 就是一只 qcow2 套着 ``.img`` 外壳
#: （3.5 GiB 虚拟 / 248 MiB 实际）。而 PVE 的 ``file_size_info`` 只对
#: ``.qcow2/.qed/.raw/.vmdk/.vdi/.vpc`` 这几种扩展名跑 ``qemu-img info``，
#: 其余（``.img`` 或自定义后缀）一律 ``stat`` 当裸盘 —— 于是 qcow2 容器会被
#: **整块当成 raw 复制**成系统盘，第一扇区是 ``QFI\xfb`` 而不是 ``55 aa``，
#: 开机就停在 ``Boot failed: not a bootable disk``。
#:
#: 上传是面板唯一拿得到文件字节的时刻，格式在这里判，别留给 PVE 按名字猜。
_IMAGE_MAGIC: Dict[bytes, str] = {
    b"QFI\xfb": "qcow2",
    b"KDMV": "vmdk",
}

#: PVE 会去 ``qemu-img info`` 的扩展名。不在这张表里的名字，PVE 不解析容器，
#: 直接按裸盘处理。判断只有一份，见 ``vmconfig.PVE_IMAGE_EXT``。
_PVE_RECOGNISED_EXT = vmconfig.PVE_IMAGE_EXT

#: 各内容类型常见的文件扩展名。仅用于出错时提示，真正的裁决者是 PVE ——
#: 所以这里宁含糊不过窄：写窄了会挡住用户，写宽了顶多少一句提示。
_UPLOAD_EXT_HINT: Dict[str, str] = {
    "iso": "ISO 安装镜像（.iso）或磁盘镜像（.img）",
    # .qcow2 / .raw / .vmdk 只有 import 目录收 —— iso 目录会以扩展名为由拒掉，
    # cloud 镜像与模板盘得传到这里才能被「从镜像建模板」选到。
    "import": "磁盘镜像（.qcow2 / .raw / .vmdk / .ova）",
    "vztmpl": "容器模板（.tar.gz / .tar.xz / .tar.zst / .tgz）",
    "backup": "备份文件（.vma / .vma.gz / .vma.lzo / .tar 系列）",
    "snippets": "片段文件（.yaml / .sh 等文本）",
}


def _probe_image_format(file: UploadFile) -> str:
    """读前 4 字节判断磁盘镜像的容器格式，认不出返回空串。

    只认 ``qcow2`` / ``vmdk`` 两种：ISO 安装盘、容器模板、备份归档都不是
    这两种 magic，返回空串即「照旧上传」。读不到（流不可 seek）也返回空串 ——
    宁可漏判，不能因为探测把一次正常上传拦下来。
    """
    try:
        file.file.seek(0)
        head = file.file.read(4)
    except Exception:  # noqa: BLE001 - 探测失败不阻断上传
        head = b""
    finally:
        # 无论成败都要把指针放回开头：探测动了读位置却没还原，后面就会
        # 少传几个字节，PVE 拿到一个坏文件还报「成功」。
        try:
            file.file.seek(0)
        except Exception:  # noqa: BLE001
            return ""
    for magic, fmt in _IMAGE_MAGIC.items():
        if head.startswith(magic):
            return fmt
    return ""


def _image_container_error(filename: str, fmt: str) -> str:
    """扩展名与容器格式对不上时给用户的话：说清后果，给出两条能走通的路。"""
    return (
        f"{filename} 实际是 {fmt} 磁盘镜像，扩展名却不在 PVE 会解析的那几种之内"
        f"（{'/'.join(_PVE_RECOGNISED_EXT)}）。对这种文件 PVE 不解析容器，直接按裸盘"
        "整块复制 —— 系统盘第一扇区就不是引导扇区，建出来的模板开机只会停在 "
        "“Boot failed: not a bootable disk”。\n"
        "两条可行做法：\n"
        f"① 上传到内容类型含 import 的存储，文件名以 {fmt} 结尾"
        "（面板会替你改好后缀，PVE 也能正确识别）；\n"
        f"② 先在宿主机上转成裸盘再上传：qemu-img convert -O raw {filename} 目标文件名.img。"
    )


def _upload_error_text(raw: str, content: str) -> str:
    """把 PVE 的上传拒绝话术翻成「该传什么」。"""
    lowered = str(raw).lower()
    if not any(needle in lowered for needle in _UPLOAD_EXT_ERR):
        return raw
    hint = _UPLOAD_EXT_HINT.get(content)
    detail = f"「{content}」通常放{hint}。" if hint else ""
    return (
        f"PVE 拒绝了这次上传：文件扩展名与所选内容类型不匹配。{detail}"
        f"（PVE 原文：{raw}）"
    )


async def bind_node_connection(node: Optional[str] = None) -> None:
    """路由级依赖：只给了节点名时，把请求绑定到拥有该节点的 PVE。

    与 :func:`app.vm_scope.bind_vm_connection` 同一套路 —— FastAPI 会把同名的
    查询参数 ``node`` 注入进来；**硬指定**了 ``X-PVE-Connection`` 时一律不干预
    （顶栏的软作用域不算，见 :func:`app.pve.bound_connection`）。
    推断本身复用 :func:`app.vm_scope.resolve_node_connection`（备份下载也要用）。
    """
    if not node or bound_connection():
        return
    conn_id = await resolve_node_connection(node)
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


#: 存储内容列表的缓存时长（秒）。
#:
#: ``/nodes/{node}/storage/{storage}/content`` 是 PVE 里最慢的只读接口之一：
#: 目录型 / NFS / CIFS 存储每次都要真的扫一遍目录，冷缓存下几秒很常见。
#: 而这一页的用法是「点开一个存储看一眼、再点开另一个」——不缓存的话，每次点击
#: 都要重新扫一遍。20 秒足够覆盖「来回翻看几个存储」这一段，又短到不会让
#: 「刚上传的文件」长时间看不到（上传 / 删除成功后会主动作废缓存）。
_CONTENT_TTL = 20.0


#: 归属于某台客户机的内容类型：普通用户只能看自己名下机器的那几条。
#: ISO / vztmpl / snippets 是共享基础设施，不参与归属过滤（否则连安装镜像都选不到）。
_GUEST_CONTENT_TYPES = ("images", "rootdir", "backup", "import")


async def _scope_storage_content(
    items: List[Dict[str, Any]],
    user: Dict[str, Any],
    node: str,
    storage: str,
) -> List[Dict[str, Any]]:
    """按归属裁剪存储内容清单。

    **必须在 ``pvecache`` 之外调用**：缓存 key 里没有用户，把过滤写进被缓存的
    lambda 会把 A 的可见集合缓存给 B（跨用户数据污染，比原来的泄露更糟）。

    判定分三类：
    * 导入文件（``import/`` 或 ``content=import``）：按 ``KIND_IMPORT`` 的 ref 判定；
    * 带 ``vmid`` 的卷（磁盘、备份归档）：按该客户机的归属判定，无归属记录的存量
      对普通用户不可见（与 ``/vms`` 同一套严格隔离）；
    * 其余（ISO、容器模板、片段）：共享资源，保持可见。
    """
    scope = security.visible_owner(user)
    if scope is None:
        return items

    connection_id = guestguard.call_connection()
    if security.is_region_admin(user):
        region = store.connection_region(connection_id)
        return items if security.region_in_scope(user, region) else []

    owners = await ownership.guest_owners_map()
    import_owners: Optional[Dict[str, str]] = None
    out: List[Dict[str, Any]] = []
    for item in items or []:
        volid = str(item.get("volid") or "")
        ctype = str(item.get("content") or "")
        volume = volid.split(":", 1)[-1] if ":" in volid else volid

        if ctype == "import" or volume.startswith("import/"):
            if import_owners is None:
                import_owners = await ownership.owners_map(ownership.KIND_IMPORT)
            ref = ownership.import_ref(connection_id, storage, volume)
            if import_owners.get(ref) == scope:
                out.append(item)
            continue

        vmid = item.get("vmid")
        if ctype not in _GUEST_CONTENT_TYPES and vmid is None:
            out.append(item)
            continue
        if vmid is None:
            # 明确是客户机内容却拿不到 vmid：无法判定归属，严格隔离
            continue
        if ownership.vm_owner_from(owners, node, vmid, connection_id) == scope:
            out.append(item)
    return out


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
    # 连接作用域必须进 key：两台 PVE 上完全可能有同名节点 + 同名存储
    cache_key = (
        f"storage-content:{requested_connection() or ''}"
        f":{node}:{storage}:{content or ''}:{vmid or ''}"
    )
    try:
        items = await pvecache.cached(
            cache_key,
            _CONTENT_TTL,
            lambda: client.storage_content(node, storage, content=content, vmid=vmid),
        )
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
    # 归属裁剪放在缓存之后：缓存里是全量，按用户过滤只在出口做（见函数说明）
    output = await _scope_storage_content(output, user, node, storage)
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
    # 删掉的卷得立刻从列表里消失，不能等 TTL 到期
    pvecache.invalidate("storage-content:")
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

    # 先按字节认清容器格式，再看名字对不对得上。
    #
    # 名字与内容不一致时不能放行：PVE 会按裸盘复制 qcow2 容器，建出来的模板
    # 开机就是「not a bootable disk」，而 PVE 那边整条任务都是成功的 ——
    # 故障会一路拖到开机那一刻才暴露（见 _IMAGE_MAGIC）。
    renamed_to = ""
    if content in ("iso", "import"):
        probed = _probe_image_format(file)
        if probed and not filename.lower().endswith(_PVE_RECOGNISED_EXT):
            if content != "import":
                # iso 目录不收 .qcow2 / .vmdk（PVE 会以扩展名为由拒掉），
                # 改名上传照样失败 —— 只能当场说清楚该怎么处理。
                await security.audit(
                    request, user, "storage.upload",
                    target=f"{node}/{storage}/{filename}",
                    result="failed", detail=f"image container mismatch: {probed}",
                )
                raise HTTPException(
                    status_code=400, detail=_image_container_error(filename, probed)
                )
            # import 目录收 .qcow2/.vmdk：把后缀换对，PVE 就会去 qemu-img info，
            # 虚拟容量与容器格式都对，import-from 才能把盘建对。
            stem = filename.rsplit(".", 1)[0] if "." in filename else filename
            filename = f"{stem}.{probed}"
            renamed_to = filename

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

        raw = _extract_error(resp)
        # 审计留原文（对照 PVE 版本差异要用），给用户的换成「该传什么」
        await security.audit(
            request, user, "storage.upload", target=f"{node}/{storage}/{filename}",
            result="failed", detail=raw,
        )
        # Proxmox 的 401/403 表示上游凭据问题，不能透传给前端当会话失效
        code = 502 if resp.status_code in (401, 403) else resp.status_code
        raise HTTPException(
            status_code=code, detail=_upload_error_text(raw, content)
        )

    await security.audit(
        request, user, "storage.upload", target=f"{node}/{storage}/{filename}"
    )

    # 新文件要能被下一次列表刷新看到，不能等 TTL 到期
    pvecache.invalidate("storage-content:")
    # 容器模板列表缓存 60 秒：刚上传的 vztmpl 必须立刻出现在新建容器向导里
    if content == "vztmpl":
        pvecache.invalidate("templates:vztmpl")
    # 镜像（iso / import）列表缓存 30 秒：新传的 ISO 得马上能被选中
    if content in ("iso", "import"):
        pvecache.invalidate("templates:images")

    payload = resp.json().get("data")
    return {
        "task": payload if isinstance(payload, str) else "",
        "filename": filename,
        # 非空表示文件名被改过：前端据此提示「已按内容识别为 qcow2，存成 xxx.qcow2」，
        # 免得用户在列表里找不到自己刚传的那个名字。
        "renamed_to": renamed_to,
    }


#: 压缩包后缀。PVE 的 download-url 不会解压，存进去就是一个没人能用的文件，
#: 等用户在建模板时才发现「镜像无效」比当场拒绝难查得多。
_COMPRESSED_SUFFIX = (".gz", ".xz", ".bz2", ".zip", ".zst", ".7z", ".tar")

#: ``iso`` 内容收的文件：安装盘。磁盘镜像一律走 import —— 放进 iso 目录时
#: PVE 不会解析容器（典型：Ubuntu 官方的 ``.img`` 其实是 qcow2）。
_ISO_IMAGE_SUFFIX = (".iso", ".dmg")

#: ``import`` 内容收的文件。``.img`` 不在这里：它会被 PVE 当裸盘整块复制，
#: 进来之前先改成 ``.qcow2``（见 _download_filename）。
_IMPORT_IMAGE_SUFFIX = vmconfig.PVE_IMAGE_EXT + (".ova",)

#: PVE 对存储文件名的安全字符集（``$SAFE_CHAR_CLASS_RE``）。对不上会在传完之后
#: 才报 ``invalid filename``，所以先自己拦。
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


def _download_filename(url_path: str, wanted: str, content: str) -> str:
    """按内容类型校正下载后的文件名，返回最终名字。

    ``import`` 下的 ``.img`` 改成 ``.qcow2``：PVE 只对白名单后缀跑
    ``qemu-img info``，``.img`` 会被按裸盘整块复制 —— 如果那其实是一只 qcow2
    （Ubuntu 官方镜像就是这样），系统盘第一扇区就没有引导签名，模板开机停在
    ``Boot failed: not a bootable disk``。改成 ``.qcow2`` 后 PVE 会去解析内容，
    真 raw 的镜像也会被正确识别成 raw，两种情形都安全。
    """
    name = (wanted or "").strip() or unquote(url_path.rsplit("/", 1)[-1])
    if not name:
        raise HTTPException(
            status_code=400,
            detail="无法从链接推断文件名，请显式填写 filename（例如 ubuntu-24.04.qcow2）",
        )
    lowered = name.lower()

    if lowered.endswith(_COMPRESSED_SUFFIX):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name} 是压缩包，PVE 的下载任务不会解压，存进去也用不了。"
                "请换未压缩的镜像链接（.qcow2 / .raw / .iso），"
                "或在宿主机上 gunzip 之后再导入。"
            ),
        )

    if content == "import":
        if lowered.endswith(".img"):
            return f"{name[: -len('.img')]}.qcow2"
        if not lowered.endswith(_IMPORT_IMAGE_SUFFIX):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{name} 不能放进 import 目录：那里收磁盘镜像"
                    f"（{'/'.join(_IMPORT_IMAGE_SUFFIX)}）。"
                    "ISO 安装盘请选内容类型为 iso 的存储。"
                ),
            )
        return name

    if not lowered.endswith(_ISO_IMAGE_SUFFIX):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name} 不能放进 iso 目录：那里只收安装盘（{'/'.join(_ISO_IMAGE_SUFFIX)}）。"
                "磁盘镜像（.qcow2 / .raw / .img）请下载到内容类型含 import 的存储 —— "
                "iso 目录里的磁盘镜像 PVE 不解析容器，会被当裸盘整块复制，建出来的模板开不了机。"
            ),
        )
    return name


@router.post("/storages/download-url")
async def download_image_from_url(
    payload: StorageDownloadUrl,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("storage.manage")),
) -> Dict[str, Any]:
    """让 **PVE** 直接把镜像从 URL 下载进存储，返回任务 UPID。

    这件事不该由面板代理字节来做：几百 MB 到几十 GB 的镜像走面板进程既占内存、
    又容易在反向代理那层超时；PVE 的 ``download-url`` 是原生任务，进度、限速、
    失败重试都由它管，面板只负责校验参数并等 UPID。

    校验的三件事都在「开始下载之前」做完，避免让用户等半小时才失败：
    链接协议、目标存储的内容类型、以及**文件名**（决定 PVE 会不会去解析容器）。

    边界：请求是 **PVE 节点**发出的，所以面板所在网段 / 节点内网的地址它也够得着
    （内网镜像站正是常见用法），不额外做地址黑白名单。能调用它的是持
    ``storage.manage`` 的账号 —— 与「往这台存储上传任意文件」等价。
    """
    parts = urlsplit(str(payload.url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(
            status_code=400, detail="下载链接只支持 http / https，且必须带主机名"
        )

    content = payload.content if payload.content in ("iso", "import") else ""
    if not content:
        raise HTTPException(
            status_code=400,
            detail="content 只能是 import（磁盘镜像）或 iso（安装盘）",
        )

    original = (payload.filename or "").strip() or unquote(
        parts.path.rsplit("/", 1)[-1]
    )
    name = _download_filename(parts.path, payload.filename or "", content)
    if not _SAFE_FILENAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                f"文件名 {name} 含 PVE 不接受的字符：只能用字母、数字与 . _ + - ，"
                "且要以字母或数字开头（中文、空格会让 PVE 存进去之后列不出来）。"
            ),
        )

    client = get_client()
    try:
        storages = await client.storages(payload.node)
    except ProxmoxError as exc:
        _raise(exc)

    entry = next(
        (s for s in storages or [] if str(s.get("storage") or "") == payload.storage),
        None,
    )
    if entry is None:
        raise HTTPException(
            status_code=404,
            detail=f"节点 {payload.node} 上没有名为 {payload.storage} 的存储",
        )
    supported = {
        part.strip() for part in str(entry.get("content") or "").split(",")
    }
    if content not in supported:
        raise HTTPException(
            status_code=400,
            detail=(
                f"存储 {payload.storage} 的内容类型是「{entry.get('content') or '未设置'}」，"
                f"收不了 {content}。换个存储，或在 PVE 里给它加上这个内容类型。"
            ),
        )
    if pve_flag(entry.get("active", 1)) != 1:
        raise HTTPException(
            status_code=400,
            detail=f"存储 {payload.storage} 当前不可用（未挂载或节点离线）",
        )

    # 审计里不写整条链接：对象存储的预签名 URL 本身就带凭据，落库等于扩散
    safe_url = f"{parts.scheme}://{parts.netloc}{parts.path}"
    try:
        upid = await client.storage_download_url(
            payload.node,
            payload.storage,
            url=str(payload.url).strip(),
            content=content,
            filename=name,
            checksum=payload.checksum,
            checksum_algorithm=payload.checksum_algorithm,
            verify_certificates=payload.verify_certificates,
        )
    except ProxmoxError as exc:
        await security.audit(
            request, user, "storage.download",
            target=f"{payload.node}/{payload.storage}/{name}",
            result="failed", detail=f"{safe_url} → {exc.message}",
        )
        _raise(exc)

    await security.audit(
        request, user, "storage.download",
        target=f"{payload.node}/{payload.storage}/{name}",
        detail={"url": safe_url, "content": content},
    )

    return {
        "task": upid if isinstance(upid, str) else "",
        # 下载完成后就是这一卷：前端据此直接选中它，不必等列表刷新
        "volid": f"{payload.storage}:{content}/{name}",
        "filename": name,
        # 非空表示后缀被校正过（典型：.img → .qcow2）
        "renamed_to": name if name != original else "",
    }


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
