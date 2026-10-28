"""Console proxying: VNC (noVNC) and serial terminal (xterm.js).

Why a proxy at all?
-------------------
Proxmox's ``vncwebsocket`` endpoint authenticates with the ``PVEAuthCookie``
cookie, not the ``Authorization`` header, and browser WebSocket clients cannot
set custom headers. It also requires the caller to share a cookie domain with
the PVE host. Proxying through our own backend sidesteps both problems: the
browser connects to us over the same origin, and we attach the upstream
credentials server-side. It also means PVE's web UI never has to be exposed.

The flow for VNC:
1. Browser  -> ``POST /api/vms/{node}/{vmid}/console/vncproxy``
2. Backend  -> creates a PVE VNC session (ticket, port, password)
3. Browser  -> ``ws://.../console/vncws?port=..&vncticket=..``
4. Backend  -> opens the upstream PVE websocket and pumps bytes both ways
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import ssl as ssl_module
from typing import Any, Dict, Optional
from urllib.parse import quote

import websockets
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse

from .. import console_files, guestguard, i18n, ownership, panel_url, security, store
from ..pve import (
    ProxmoxError,
    ProxmoxClient,
    build_ssl_context,
    error_code_headers,
    get_client,
    set_request_connection,
)
from ..vm_scope import bind_vm_connection, resolve_vm_connection

def _require_console_account() -> None:
    """PVE websocket 端点只认 PVEAuthCookie，API Token 一律 401。

    没配置控制台账号时在这里就挡住，返回可操作的 428 提示；
    否则前端只能拿到 WS 关闭后的「与 VNC 代理的连接意外中断」。
    """
    conn = get_client().conn
    if not (conn.console_user and conn.console_password):
        raise HTTPException(
            status_code=428,
            detail=i18n.tr(
                "未配置控制台账号，无法打开控制台：PVE 的 VNC WebSocket 不接受 "
                "API Token。请在「设置 → 连接配置」中填写 Proxmox 控制台账号与密码"
                "（例如 root@pam）。"
            ),
            # 同为 428，但这里缺的是「控制台账号」而不是「连接」：带上错误码，
            # 前端才不会把它当成「面板还没配置」而显示「去添加连接」的引导。
            headers={"X-Error-Code": "console_credentials_missing"},
        )


router = APIRouter(
    prefix="/api",
    tags=["console"],
    # 注意：bind_vm_connection 只能挂在下面两个 HTTP 端点上，不能挂路由级——
    # 它依赖链末端是 OAuth2PasswordBearer（HTTP Bearer 头），WebSocket 路由
    # 解析它会抛 TypeError，握手直接 500，前端表现为「与 VNC 代理的连接意外中断」。
    # WS 的连接定位由 _proxy_console 内部的 resolve_vm_connection 负责。
)
logger = logging.getLogger(__name__)


def _ws_headers_kw(headers: Dict[str, str]) -> Dict[str, Any]:
    """自定义请求头在不同 websockets 版本里参数名不同。

    新版叫 ``additional_headers``，旧版（本项目锁定 13.1 的 legacy connect）
    只认 ``extra_headers``。写死任一个都会在另一个版本上抛 TypeError，
    这里按实际签名选择。
    """
    params = inspect.signature(websockets.connect).parameters
    key = "additional_headers" if "additional_headers" in params else "extra_headers"
    return {key: headers}


def _ssl_context(url: str, verify: bool, ca_cert: str = "") -> Any:
    """为上游 wss 构造 SSLContext。

    直接传 True/False 会让 asyncio 在 wss 上「启用验证」或「完全不加密」，
    而 PVE 普遍使用自签证书。这里与 :mod:`app.pve` 用同一套策略：配了
    证书（``ca_cert``）就钉扎它，否则按 ``verify`` 走默认信任库 / 不校验。
    """
    if not url.startswith("wss"):
        return None
    if (ca_cert or "").strip():
        return build_ssl_context(True, ca_cert)
    ctx = ssl_module.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl_module.CERT_NONE
    return ctx


def _raise(exc: ProxmoxError) -> None:
    """把 PVE 错误转成 HTTP 响应。

    上游的 401/403 代表 **PVE 拒绝了控制台凭据**（账号密码错或权限不足），
    绝不能原样透传：浏览器端一旦收到 401 就认为是面板会话过期，会清掉 token
    并跳登录页，反而掩盖了真实原因。这里统一改写为 428（前置条件未满足）。
    """
    status = exc.status_code if exc.status_code < 600 else 500
    if status in (401, 403):
        raise HTTPException(
            status_code=428,
            detail=i18n.tr("PVE 控制台凭据无效或权限不足：") + exc.message,
            headers={"X-Error-Code": "console_credentials_missing"},
        )
    raise HTTPException(
        status_code=status, detail=exc.message, headers=error_code_headers(exc)
    )


@router.post(
    "/vms/{node}/{vmid}/console/vncproxy",
    # 多台 PVE 时按节点/VMID 定位主机；不定位会连到「当前连接」上的同名虚拟机
    dependencies=[Depends(bind_vm_connection)],
)
async def create_vnc_session(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.console")),
) -> Dict[str, Any]:
    """Create a Proxmox VNC session and hand the browser what it needs."""
    # 对象级鉴权：有控制台权限 ≠ 有资格连**这一台**。放在处理函数里而不是路由
    # 依赖上，是为了让「没权限」先报 403、「不是你的」才报 404（顺序反过来会
    # 让 viewer 也收到 404，跟接口约定不一致）。此时 bind_vm_connection 已经跑过，
    # 归属 ref 用的连接与下面 get_client() 拿到的是同一条。
    await guestguard.require_guest_object(user, node, vmid, ownership.KIND_VM)
    _require_console_account()
    client = get_client()
    try:
        data = await client.vncproxy(node, vmid)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "console.vnc", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "console.vnc", target=f"{node}/{vmid}")

    return {
        "ticket": data.get("ticket"),
        "port": data.get("port"),
        "cert": data.get("cert"),
        "password": data.get("password"),
        "node": node,
        "vmid": vmid,
        # Tell the frontend where to connect; it builds the ws URL from this.
        "websocket_path": f"/api/vms/{node}/{vmid}/console/vncws",
    }


@router.post(
    "/vms/{node}/{vmid}/console/xtermproxy",
    dependencies=[Depends(bind_vm_connection)],
)
async def create_xterm_session(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.console")),
) -> Dict[str, Any]:
    """Create a serial console session for xterm.js."""
    # 对象级鉴权（见 create_vnc_session 的说明）
    await guestguard.require_guest_object(user, node, vmid, ownership.KIND_VM)
    _require_console_account()
    client = get_client()
    try:
        data = await client.xtermproxy(node, vmid)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "console.xterm", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "console.xterm", target=f"{node}/{vmid}")

    return {
        "ticket": data.get("ticket"),
        "port": data.get("port"),
        "user": data.get("user"),
        "node": node,
        "vmid": vmid,
        "websocket_path": f"/api/vms/{node}/{vmid}/console/xtermws",
    }


# ------------------------------------------------------------ LXC（容器）
# 容器的控制台与虚拟机是**不同的 PVE 端点**（/lxc/{vmid}/termproxy 而不是
# /qemu/{vmid}/termproxy），但代理链路完全一致，所以复用同一份代码，
# 只把 guest 标记传下去 —— 它决定上游 WebSocket 路径里的 qemu / lxc。
@router.post(
    "/lxc/{node}/{vmid}/console/vncproxy",
    dependencies=[Depends(bind_vm_connection)],
)
async def create_lxc_vnc_session(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("ct.console")),
) -> Dict[str, Any]:
    """Create a VNC session for a container.

    容器的「VNC」实际是 PVE 用 vncterm 把容器 tty 渲染成的画面（实测
    ServerInit 是 744x400 的终端），noVNC 能直接显示，不需要另做一个
    xterm 终端。
    """
    # 对象级鉴权（见 create_vnc_session 的说明），容器用 KIND_CT
    await guestguard.require_guest_object(user, node, vmid, ownership.KIND_CT)
    _require_console_account()
    client = get_client()
    try:
        data = await client.lxc_vncproxy(node, vmid)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "console.vnc", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "console.vnc", target=f"{node}/{vmid}")
    return {
        "ticket": data.get("ticket"),
        "port": data.get("port"),
        "cert": data.get("cert"),
        # 容器的 VNC 口令**就是 ticket 本身**。
        #
        # PVE 的 lxc vncproxy 不接受 password / generate-password 参数（多点一个
        # 字段会被 schema 整条打回，见 pve.lxc_vncproxy），它把 ticket 直接交给
        # vncterm 当 VNC 口令（`vncterm -d <password>`），所以响应体里**没有**
        # password 字段 —— 客户端本来就从 URL 拿到了 ticket，无需再回传一次。
        #
        # 实测：该会话只提供 VncAuth(2) 一种安全类型，用 ticket 做口令能通过认证；
        # 不给口令时 noVNC 会停在 credentialsrequired（界面上就是「VNC 连接需要
        # 凭据但后端未返回」）。这里把它补成 password，前端不必知道这个细节。
        "password": data.get("password") or data.get("ticket"),
        "node": node,
        "vmid": vmid,
        "websocket_path": f"/api/lxc/{node}/{vmid}/console/vncws",
    }


@router.post(
    "/lxc/{node}/{vmid}/console/xtermproxy",
    dependencies=[Depends(bind_vm_connection)],
)
async def create_lxc_xterm_session(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("ct.console")),
) -> Dict[str, Any]:
    """Create a terminal session for a container (the normal case)."""
    # 对象级鉴权（见 create_vnc_session 的说明）
    await guestguard.require_guest_object(user, node, vmid, ownership.KIND_CT)
    _require_console_account()
    client = get_client()
    try:
        data = await client.lxc_termproxy(node, vmid)
    except ProxmoxError as exc:
        await security.audit(
            request, user, "console.xterm", target=f"{node}/{vmid}",
            result="failed", detail=exc.message,
        )
        _raise(exc)

    await security.audit(request, user, "console.xterm", target=f"{node}/{vmid}")
    return {
        "ticket": data.get("ticket"),
        "port": data.get("port"),
        "user": data.get("user"),
        "node": node,
        "vmid": vmid,
        "websocket_path": f"/api/lxc/{node}/{vmid}/console/xtermws",
    }


# ------------------------------------------------------------ 控制台文件中转
# 为什么是「中转」而不是「直接写进客户机」：见 app/console_files.py 顶部说明。
# 下载接口刻意**不要求登录** —— 去拉文件的是客户机，它没有面板凭据；
# token（128 bit 随机）本身就是能力凭据，且有有效期。


def _limit_label() -> str:
    mib = console_files.MAX_BYTES / (1024 * 1024)
    if mib < 1024:
        return f"{mib:.0f} MiB"
    return f"{mib / 1024:.0f} GiB"


@router.post("/console/files")
async def upload_console_file(
    request: Request,
    file: UploadFile = File(...),
    guest_type: str = Form("qemu"),
    node: str = Form(""),
    vmid: Optional[int] = Form(None),
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.console", "ct.console")
    ),
) -> Dict[str, Any]:
    """接收浏览器上传的文件，返回一枚限时下载地址与可直接粘贴的命令素材。"""
    kind = "lxc" if guest_type == "lxc" else "qemu"
    needed = "ct.console" if kind == "lxc" else "vm.console"
    if not security.has_user_permission(user, needed):
        raise HTTPException(
            status_code=403,
            detail=i18n.t("error.permission_denied", permission=needed),
        )

    target = f"{node}/{vmid}" if node and vmid else str(file.filename or "")
    try:
        meta = await console_files.save(
            file, str(user.get("username") or ""), target
        )
    except console_files.FileTooLarge:
        detail = i18n.t("console.fileTooLarge", limit=_limit_label())
        await security.audit(
            request, user, "console.file_upload", target=target,
            result="failed", detail=detail,
        )
        raise HTTPException(status_code=413, detail=detail) from None
    except OSError as exc:
        detail = i18n.t("console.fileUploadFailed", error=str(exc))
        await security.audit(
            request, user, "console.file_upload", target=target,
            result="failed", detail=detail,
        )
        raise HTTPException(status_code=500, detail=detail) from exc

    base = (await panel_url.resolve(request)).rstrip("/")
    if not base:
        base = str(request.base_url).rstrip("/")
    path = f"/api/console/files/{meta['token']}/{quote(str(meta['name']))}"

    await security.audit(
        request, user, "console.file_upload", target=target,
        detail={"name": meta["name"], "size": meta["size"]},
    )

    return {
        "token": meta["token"],
        "name": meta["name"],
        "size": meta["size"],
        "expires_at": meta["expires_at"],
        "path": path,
        "url": f"{base}{path}",
        "max_bytes": console_files.MAX_BYTES,
    }


async def _console_file_response(token: str) -> FileResponse:
    found = await console_files.load(token)
    if found is None:
        raise HTTPException(status_code=404, detail=i18n.t("console.fileMissing"))
    path, meta = found
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=str(meta.get("name") or "download.bin"),
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/console/files/{token}")
async def download_console_file(token: str) -> FileResponse:
    """客户机拉取中转文件（凭 token，不需要登录）。"""
    return await _console_file_response(token)


@router.get("/console/files/{token}/{filename:path}")
async def download_console_file_named(token: str, filename: str = "") -> FileResponse:
    """同一条下载，多带一段文件名。

    文件名只是让 URL 与命令行看起来更像回事（``curl -O`` 也能直接用），
    真正的裁决者仍是 token；路径段不参与拼盘上路径。
    """
    return await _console_file_response(token)


@router.delete("/console/files/{token}")
async def revoke_console_file(
    token: str,
    request: Request,
    user: Dict[str, Any] = Depends(
        security.require_any_permission("vm.console", "ct.console")
    ),
) -> Dict[str, Any]:
    """作废下载链接（上传者发现地址贴错地方时用）。

    只能作废自己上传的那条：token 是能力凭据，但作废是面板内的写操作，此前任何
    持 console 权限的人只要拿到链接就能掐断别人的中转。不存在 / 不是本人的一律
    404 —— 403 等于承认这枚 token 有效。
    """
    ok = await console_files.revoke(token, security.visible_owner(user))
    if not ok:
        raise HTTPException(status_code=404, detail=i18n.t("console.fileMissing"))
    await security.audit(request, user, "console.file_revoke", target=token)
    return {"ok": True}


# --------------------------------------------------------------- websockets
async def _authenticate_ws(token: str) -> Dict[str, Any]:
    """Validate the panel JWT supplied as a query parameter.

    WebSocket clients in browsers cannot set an Authorization header, so the
    token travels as ``?token=``. It is short-lived, and the connection is
    authenticated before any upstream traffic is proxied.

    除了签名与有效期，还会确认服务端会话仍在：登出/被踢下线之后，旧 token
    不该还能打开控制台。
    """
    if not token:
        raise PermissionError(i18n.t("error.no_credentials"))
    try:
        payload = security.decode_token(token)
        await security.ensure_session_active(payload)
    except HTTPException as exc:
        raise PermissionError(exc.detail) from exc

    username = payload.get("sub")
    role = payload.get("role", "viewer")
    if not username:
        raise PermissionError(i18n.tr("无效的认证凭据"))
    return {"username": username, "role": role}


@router.websocket("/vms/{node}/{vmid}/console/vncws")
async def vnc_websocket(
    websocket: WebSocket,
    node: str,
    vmid: int,
    port: int = Query(...),
    vncticket: str = Query(..., alias="vncticket"),
    token: str = Query(default=""),
) -> None:
    await _proxy_console(websocket, node, vmid, port, vncticket, token, kind="vnc")


@router.websocket("/vms/{node}/{vmid}/console/xtermws")
async def xterm_websocket(
    websocket: WebSocket,
    node: str,
    vmid: int,
    port: int = Query(...),
    vncticket: str = Query(...),
    token: str = Query(default=""),
) -> None:
    await _proxy_console(websocket, node, vmid, port, vncticket, token, kind="xterm")


@router.websocket("/lxc/{node}/{vmid}/console/vncws")
async def lxc_vnc_websocket(
    websocket: WebSocket,
    node: str,
    vmid: int,
    port: int = Query(...),
    vncticket: str = Query(..., alias="vncticket"),
    token: str = Query(default=""),
) -> None:
    await _proxy_console(
        websocket, node, vmid, port, vncticket, token, kind="vnc", guest="lxc"
    )


@router.websocket("/lxc/{node}/{vmid}/console/xtermws")
async def lxc_xterm_websocket(
    websocket: WebSocket,
    node: str,
    vmid: int,
    port: int = Query(...),
    vncticket: str = Query(...),
    token: str = Query(default=""),
) -> None:
    await _proxy_console(
        websocket, node, vmid, port, vncticket, token, kind="xterm", guest="lxc"
    )


async def _reject(websocket: WebSocket, code: int, reason: str) -> None:
    """拒绝一次控制台握手，并把**原因**记进日志。

    uvicorn 对「accept 之前关闭」一律记成 403，4401（凭据无效）与 4403（来源
    校验失败）在访问日志里长得一模一样。控制台这条链路还要多绕一层 nginx，
    光看 403 根本分不清是面板拒的还是反代没把 Cookie / Origin 透传过来。
    """
    logger.info(
        "控制台握手被拒 %s：code=%s 原因=%s Origin=%s Host=%s 有Cookie=%s",
        websocket.url.path,
        code,
        reason,
        websocket.headers.get("origin") or "-",
        websocket.headers.get("host") or "-",
        bool(websocket.cookies.get(security.ACCESS_COOKIE)),
    )
    await websocket.close(code=code, reason=reason)


async def _proxy_console(
    websocket: WebSocket,
    node: str,
    vmid: int,
    port: int,
    vncticket: str,
    token: str,
    kind: str,
    guest: str = "qemu",
) -> None:
    """Bidirectional byte pump between the browser and Proxmox."""
    # --- 1. authenticate the panel user -------------------------------
    if not security.ws_origin_allowed(websocket):
        await _reject(websocket, 4403, i18n.tr("来源校验失败"))
        return
    try:
        # 浏览器不带查询参数（令牌在 HttpOnly cookie 里），脚本仍可 ?token=
        identity = await _authenticate_ws(security.ws_token(websocket, token))
    except PermissionError as exc:
        await _reject(websocket, 4401, str(exc))
        return

    # 权限要按**账号**算，不能只看 JWT 里的 role：用户级覆盖
    # （permissions_override）可能已经把控制台收走了，而角色模板上仍然"有"。
    # 顺带复核账号状态 —— 已停用 / 待审批的账号即便 token 还没过期，也不该
    # 还能开一路控制台进去。
    account = await store.get_user(identity["username"])
    if not account:
        await _reject(websocket, 4401, i18n.tr("账号不存在"))
        return
    if str(account.get("status") or store.STATUS_ACTIVE) != store.STATUS_ACTIVE:
        await _reject(websocket, 4401, i18n.tr("账号不可用"))
        return

    # 容器的控制台是独立权限（ct.console），与虚拟机（vm.console）分开
    permission = "ct.console" if guest == "lxc" else "vm.console"
    if not security.has_user_permission(account, permission):
        await _reject(websocket, 4403, i18n.tr("权限不足：需要控制台访问权限"))
        return

    # WebSocket 走不到 HTTP 中间件，这里按节点/VMID 自行定位主机，
    # 否则控制台会连到「当前连接」上恰好同名的另一台虚拟机。
    conn_id = await resolve_vm_connection(node, vmid, security.visible_owner(account))
    if conn_id:
        set_request_connection(conn_id)

    # 对象级鉴权：有控制台权限 ≠ 有资格连**这一台**。此前这条链路上完全没有
    # 这层判断 —— 拿到任意 vmid 就能连别人的机器（HTTP 侧建会话、WS 侧转发）。
    # 用刚解析出的连接构造归属 ref，与 HTTP 端点同一口径。
    try:
        await guestguard.require_guest_object(
            account,
            node,
            vmid,
            ownership.KIND_CT if guest == "lxc" else ownership.KIND_VM,
            connection=conn_id,
        )
    except HTTPException:
        await _reject(
            websocket,
            guestguard.WS_NOT_FOUND_CODE,
            i18n.tr(guestguard.NOT_FOUND_DETAIL),
        )
        return

    client = get_client()
    if not client.conn.configured:
        await websocket.close(
            code=1011, reason=i18n.tr("Proxmox 连接未配置")
        )
        return

    # --- 2. build the upstream URL and headers -------------------------
    # guest 决定走 /qemu/{vmid}/ 还是 /lxc/{vmid}/ 的上游端点
    upstream_url = client.console_ws_url(node, vmid, kind, port, vncticket, guest=guest)
    headers, _ = await _console_credentials(client)

    await websocket.accept()

    upstream = None
    try:
        upstream = await websockets.connect(
            upstream_url,
            **_ws_headers_kw(headers),
            open_timeout=15,
            close_timeout=5,
            max_size=None,
            ssl=_ssl_context(
                upstream_url,
                bool(client.conn.verify_ssl),
                getattr(client.conn, "ca_cert", ""),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "console proxy upstream failed (node=%s vmid=%s kind=%s): %s",
            node, vmid, kind, exc,
        )
        await store.add_audit(
            username=identity["username"],
            action=f"console.{kind}",
            target=f"{node}/{vmid}",
            result="failed",
            detail=f"上游连接失败: {exc}",
        )
        await websocket.close(
            code=1011,
            reason=i18n.tr("无法连接到 Proxmox 控制台：") + str(exc),
        )
        return

    await store.add_audit(
        username=identity["username"],
        action=f"console.{kind}",
        target=f"{node}/{vmid}",
        result="success",
    )

    # --- 3. pump bytes in both directions ------------------------------
    async def browser_to_pve() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text") is not None:
                await upstream.send(message["text"])

    async def pve_to_browser() -> None:
        async for message in upstream:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)

    tasks = [
        asyncio.create_task(browser_to_pve()),
        asyncio.create_task(pve_to_browser()),
    ]

    try:
        done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        # Surface a real error if one side failed unexpectedly.
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - connection teardown, nothing to report
        pass
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


async def _console_credentials(client: ProxmoxClient) -> tuple:
    """Obtain the PVEAuthCookie header needed for the upstream websocket.

    One self-signed-certificate quirk to be aware of: ``websockets`` needs
    ``ssl=False`` (not ``None``) to skip verification when the PVE host uses a
    self-signed cert, which is the common case.
    """
    try:
        return await client.console_ws_headers()
    except ProxmoxError:
        # Fall back to the token; the websocket will likely be rejected but
        # this keeps the error path observable rather than raising here.
        return {"Authorization": f"PVEAPIToken={client.conn.token_id}={client.conn.token_secret}"}, {}
