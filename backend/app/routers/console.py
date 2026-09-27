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
from typing import Any, Dict

import websockets
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from .. import security, store
from ..pve import ProxmoxError, ProxmoxClient, get_client, set_request_connection
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
            detail=(
                "未配置控制台账号，无法打开控制台：PVE 的 VNC/串口 WebSocket 不接受 "
                "API Token。请在「设置 → 连接配置」中填写 Proxmox 控制台账号与密码"
                "（例如 root@pam）。"
            ),
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


def _ssl_context(url: str, verify: bool) -> Any:
    """为上游 wss 构造 SSLContext。

    直接传 True/False 会让 asyncio 在 wss 上「启用验证」或「完全不加密」，
    而 PVE 普遍使用自签证书，需要的是「加密但不校验证书」。
    """
    if not url.startswith("wss"):
        return None
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
            detail=f"PVE 控制台凭据无效或权限不足：{exc.message}",
        )
    raise HTTPException(status_code=status, detail=exc.message)


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
    user: Dict[str, Any] = Depends(security.require_permission("vm.console")),
) -> Dict[str, Any]:
    """Create a VNC session for a container.

    容器的「VNC」实际是 PVE 用 vncterm 把容器 tty 渲染成的画面（实测
    ServerInit 是 744x400 的终端），noVNC 能直接显示，不需要另做一个
    xterm 终端。
    """
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
    user: Dict[str, Any] = Depends(security.require_permission("vm.console")),
) -> Dict[str, Any]:
    """Create a terminal session for a container (the normal case)."""
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
        raise PermissionError("未提供认证凭据")
    try:
        payload = security.decode_token(token)
        await security.ensure_session_active(payload)
    except HTTPException as exc:
        raise PermissionError(exc.detail) from exc

    username = payload.get("sub")
    role = payload.get("role", "viewer")
    if not username:
        raise PermissionError("无效的认证凭据")
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
        await _reject(websocket, 4403, "来源校验失败")
        return
    try:
        # 浏览器不带查询参数（令牌在 HttpOnly cookie 里），脚本仍可 ?token=
        identity = await _authenticate_ws(security.ws_token(websocket, token))
    except PermissionError as exc:
        await _reject(websocket, 4401, str(exc))
        return

    permission = "vm.console"
    if not security.has_permission(identity["role"], permission):
        await _reject(websocket, 4403, "权限不足：需要控制台访问权限")
        return

    # WebSocket 走不到 HTTP 中间件，这里按节点/VMID 自行定位主机，
    # 否则控制台会连到「当前连接」上恰好同名的另一台虚拟机。
    conn_id = await resolve_vm_connection(node, vmid, security.visible_owner(identity))
    if conn_id:
        set_request_connection(conn_id)

    client = get_client()
    if not client.conn.configured:
        await websocket.close(code=1011, reason="Proxmox 连接未配置")
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
            ssl=_ssl_context(upstream_url, bool(client.conn.verify_ssl)),
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
            reason=f"无法连接到 Proxmox 控制台：{exc}",
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
