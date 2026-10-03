"""FastAPI application entrypoint."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR, settings
from .pve import (
    ProxmoxError,
    get_client,
    reset_request_connection,
    set_request_connection,
)
from .routers import (
    alerts,
    audit,
    auth,
    backups,
    baseline,
    certs,
    cluster,
    config,
    console,
    # 数据导出：/api/export/{audit,tasks,vms,alerts} 流式吐 CSV
    export as export_router,
    feishu,
    firewall,
    frp,
    health,
    hostaudit,
    ip_pools,
    isolation,
    dashboard,
    lxc,
    # 监控历史查询（/api/metrics/*）；采样与落库在 app.metrics
    metrics as metrics_router,
    network,
    node_notes,
    # 站内通知（顶部铃铛）与跨资源全局搜索（Ctrl+K）。
    # 通知这里必须取别名：下面还有一句 `from . import notifications`（模块），
    # 同名会把路由模块覆盖掉。
    notifications as notifications_router,
    search,
    # 与 app.portguard（巡检实现）同名，取别名避免混淆
    portguard as ports_router,
    # 每用户的界面偏好（仪表盘布局等）
    prefs as prefs_router,
    roles,
    # 后台作业状态与配置（/api/scheduler/*）；调度实现在 app.scheduler
    scheduler as scheduler_router,
    ssh,
    storages,
    tasks,
    templates,
    # 个人 API Token 管理（/api/tokens/*）。实现与鉴权在 app.apitokens
    tokens as tokens_router,
    users,
    vm_meta,
    vms,
)
from . import alerting
from . import apitokens
from . import certs as cert_manager
from . import frp
from . import metrics as metrics_history
from . import notifications
from . import ownership
from . import password_reset
from . import prefs
from . import scheduler
from . import security
from . import site
from . import sshguard
from . import sshremote
from . import throttle
# 与 routers.hostaudit 同名，取个别名避免混淆
from . import hostaudit as host_audit
from . import i18n
from .routers import frp as frp_router
from . import backupguard
from . import portguard
from . import database
from . import guest_created
from .store import init_db, purge_expired_tokens

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("ProxCenter")

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    await alerting.init_table()
    await cert_manager.init_table()
    await ownership.init_table()
    # 受保护备份登记表（防删 / 防篡改核对）
    await backupguard.init_table()
    # 面板发起的建机 / 克隆 / 恢复记录（创建时间字段的准确来源，见 app.guest_created）
    await guest_created.init_table()
    await password_reset.init_table()
    # 监控历史表：「监控历史采样」作业到点后开始往里写点
    await metrics_history.init_table()
    # 站内通知表：告警发生时由 alerting.record 往里写未读消息
    await notifications.init_table()
    # 个人 API Token 表（脚本 / 外部系统用的长期凭据，见 app.apitokens）
    await apitokens.init_table()
    # 每用户的界面偏好（仪表盘布局等，见 app.prefs）
    await prefs.init_table()
    # 清掉过期的令牌黑名单条目与早已过期的会话记录（纯残留清理，失败不影响启动）
    try:
        await purge_expired_tokens()
        await throttle.cleanup()
    except Exception:  # noqa: BLE001
        logger.exception("清理过期令牌/限流数据失败，忽略")
    # 角色定义可选择：把内置角色补齐进库并把全部角色读入内存缓存
    await security.load_roles()
    # 老版本只用 frp_config 一个 key 存整份配置；新版拆成 server + rules，
    # 启动时一次性迁移，避免第一个 GET 接口看到空数据。
    await frp.migrate_legacy()
    logger.info("数据库就绪：%s", database.describe())
    logger.info("Panel listening on %s:%s", settings.host, settings.port)

    client = get_client()
    if client.conn.configured:
        try:
            version = await client.version()
            logger.info(
                "Connected to Proxmox VE %s at %s",
                version.get("version"),
                client.conn.base_url,
            )
        except ProxmoxError as exc:
            logger.warning("Proxmox not reachable at startup: %s", exc.message)
        except Exception:
            # An unreachable host, a TLS handshake failure, an intercepting
            # proxy — none of these may stop the panel from booting. The
            # operator has to be able to reach the UI to fix the settings,
            # so degradation must never be fatal.
            logger.exception(
                "Unexpected error while probing Proxmox at startup; "
                "continuing with the panel online"
            )
    else:
        logger.warning(
            "Proxmox connection not configured. "
            "Log in as %s and open Settings to configure it.",
            settings.admin_username,
        )

    # 后台作业统一交给调度器（见 app.scheduler）。顺序不能反：先把落库的
    # 间隔 / 启停配置恢复出来，run_forever 才会按恢复后的间隔算唤醒时刻。
    await scheduler.load_state()
    scheduler.start()
    yield

    await scheduler.stop()
    await client.aclose()
    await database.close_pool()
    logger.info("Shutdown complete")


app = FastAPI(
    title="ProxCenter API",
    description=(
        "Web management panel for Proxmox VE 8.x / 9.x. "
        "Provides VM lifecycle, template building, networking, "
        "monitoring, backup and console access."
    ),
    version="0.1.3",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ------------------------------------------------------------------- 限流
# 匿名/敏感入口单独一条更紧的线：登录、注册、找回密码、刷新令牌、2FA 都在这儿。
RATE_LIMIT_AUTH_PATHS = frozenset(
    {
        "/api/auth/login",
        "/api/auth/login/2fa",
        "/api/auth/register",
        "/api/auth/forgot-password",
        "/api/auth/reset-password",
        "/api/auth/reset-password/check",
        "/api/auth/refresh",
    }
)


class RateLimitMiddleware:
    """按来源 IP 的请求限流，计数落 MySQL（重启不清零、多进程共享）。

    * 只拦 ``/api/`` 请求 —— SPA 的 js/css 不走这道闸，否则加载一次页面就能把
      配额打满；
    * 健康检查例外，运维脚本不该被自己限速；
    * 来源 IP 只信「可信反代的 X-Forwarded-For」（见 security.client_ip_from_scope），
      否则客户端自己塞一个假 IP 就绕过了。

    写成原生 ASGI 的理由与 PveConnectionScopeMiddleware 相同：不进
    BaseHTTPMiddleware 的任务切换，拒绝路径也尽量短。
    """

    EXEMPT_PATHS = frozenset({"/api/health"})

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or not settings.rate_limit_enabled:
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""
        if not path.startswith("/api/") or path in self.EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        ip = security.client_ip_from_scope(scope) or "unknown"
        if path in RATE_LIMIT_AUTH_PATHS:
            bucket = f"api-auth:ip:{ip}"
            limit = max(1, int(settings.rate_limit_auth_per_minute))
        else:
            bucket = f"api:ip:{ip}"
            limit = max(1, int(settings.rate_limit_per_minute))

        allowed, retry_after = await throttle.allow(bucket, limit, 60)
        if not allowed:
            await self._reject(send, retry_after)
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send: Any, retry_after: int) -> None:
        body = json.dumps({"detail": "请求过于频繁，请稍后再试"}, ensure_ascii=False)
        payload = body.encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(payload)).encode()),
                    (b"retry-after", str(max(1, retry_after)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})


# 先注册限流、再注册 CORS：后注册的在外层，于是 CORS 包住限流 —— 429 响应也
# 会带上 CORS 头，跨域调试时前端能看到「请求过于频繁」而不是一个空的网络错误。
app.add_middleware(RateLimitMiddleware)


def _scope_cookies(scope: Any) -> Dict[str, str]:
    """从 ASGI scope 里解析 Cookie（只取名字和值，不关心属性）。"""
    cookies: Dict[str, str] = {}
    for name, value in scope.get("headers") or []:
        if name == b"cookie":
            for part in value.decode("latin-1").split(";"):
                key, sep, val = part.strip().partition("=")
                if sep:
                    cookies[key] = val
    return cookies


class CsrfMiddleware:
    """Cookie 认证下的 CSRF 防护（双提交令牌）。

    凭据都进 Cookie 之后，跨站请求会自动带上它们 —— 这正是 CSRF 的成因。
    ``SameSite=Lax`` 挡掉了绝大多数跨站表单/请求，但对「同站不同源」（另一台被
    拿下的子域）无能为力，所以补第二道：

    * 登录时下发一枚**非 HttpOnly** 的 ``panel_csrf``（前端 JS 要能读到）；
    * 所有改状态的方法（POST/PUT/PATCH/DELETE）必须带 ``X-CSRF-Token`` 且与
      Cookie 里的值一致 —— 别的站点读不到这枚 Cookie，也就伪造不出这个头。

    只对「靠 Cookie 认证的请求」生效：

    * 显式带 ``Authorization`` 的脚本客户端没有环境凭据（ambient credential），
      本来就不存在 CSRF，放行；
    * 没有 access cookie 的请求（登录、刷新、公开接口）也不需要校验。
    """

    SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        if (scope.get("method") or "GET").upper() in self.SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        headers = scope.get("headers") or []
        if any(name == b"authorization" for name, _ in headers):
            # 显式令牌：这条请求的身份来自请求头本身，不是浏览器自动带上的
            await self.app(scope, receive, send)
            return

        cookies = _scope_cookies(scope)
        if security.ACCESS_COOKIE not in cookies:
            await self.app(scope, receive, send)
            return

        sent = ""
        for name, value in scope.get("headers") or []:
            if name == security.CSRF_HEADER.encode():
                sent = value.decode("latin-1").strip()
                break

        expected = cookies.get(security.CSRF_COOKIE, "")
        if expected and sent and secrets.compare_digest(expected, sent):
            await self.app(scope, receive, send)
            return

        await self._reject(send)

    @staticmethod
    async def _reject(send: Any) -> None:
        body = json.dumps(
            {"detail": "请求缺少 CSRF 校验信息，请刷新页面后重试"},
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


# 注册顺序：CSRF 在限流之后、CORS 之前 —— CORS 会包住两者，403/429 都带 CORS 头。
app.add_middleware(CsrfMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PveConnectionScopeMiddleware:
    """把 ``X-PVE-Connection`` 请求头绑定到本次请求。

    面板可以配置多台 Proxmox，绝大多数请求作用于「当前连接」；但创建虚拟机的
    向导允许临时指定另一台主机。该请求头让 :func:`get_client` 在本次请求内返回
    对应主机的客户端，从而所有读写接口都无需额外参数即可支持多主机。

    刻意写成原生 ASGI 中间件而不是 ``BaseHTTPMiddleware``：选择结果存放在
    contextvar 中，原生 ASGI 能让下游应用运行在同一个任务里，取值才可靠。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        conn_id = ""
        accept_language = ""
        for key, value in scope.get("headers") or []:
            if key == b"x-pve-connection":
                conn_id = value.decode("latin-1").strip()
            elif key == b"accept-language":
                # 界面语言（见 i18n.py）：权限目录、内置角色名、FAQ 与错误消息按它返回
                accept_language = value.decode("latin-1").strip()

        i18n.set_language(accept_language)
        token = set_request_connection(conn_id)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_request_connection(token)


app.add_middleware(PveConnectionScopeMiddleware)


class HttpsEnforcementMiddleware:
    """``FORCE_HTTPS=1`` 时强制面板只走 HTTPS（TLS 在前面的 Nginx/Caddy 终结）。

    * 明文请求 → ``308`` 到 ``https://<Host>``，跳转目标会去掉本面板监听端口 ——
      后端自己不提供 TLS，必须跳到反代的 443；
    * HTTPS 请求 → 回响应加 HSTS（``max-age=31536000``），浏览器一年内只走 https。

    是否 https 只信 uvicorn 改写过的 ``scope["scheme"]``：``X-Forwarded-Proto``
    仅对 ``FORWARDED_ALLOW_IPS`` 内的对端生效，公网请求自称「我是 https」无效。
    唯一放行的是**本机回环且不带转发头**的请求（健康检查、运维脚本）—— 否则
    ``curl 127.0.0.1:8080`` 只会拿到 308。WebSocket 同样拦：VNC 控制台的
    连接串里带 JWT，明文跑等于把登录态摊在链路上。
    """

    LOOPBACK = {"127.0.0.1", "::1", "localhost"}
    HSTS = b"max-age=31536000"

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket") or not settings.force_https:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        peer = (scope.get("client") or ("", 0))[0]
        loopback_direct = peer in self.LOOPBACK and b"x-forwarded-proto" not in headers

        if self._is_https(scope):
            if scope_type == "http":
                send = self._with_hsts(send)
            await self.app(scope, receive, send)
            return

        if loopback_direct:
            await self.app(scope, receive, send)
            return

        location = self._redirect_target(scope, headers)
        if scope_type == "websocket":
            # 握手阶段无法 308（浏览器不会跟随），按策略违规关闭，让前端
            # 明确失败而不是把 JWT 明文发出去。
            logger.warning(
                "HTTPS 策略拦截 WebSocket：path=%s scheme=%s peer=%s"
                " x-forwarded-proto=%s",
                scope.get("path") or "-",
                scope.get("scheme"),
                peer,
                (headers.get(b"x-forwarded-proto") or b"-").decode("latin-1"),
            )
            await send({"type": "websocket.close", "code": 1008, "reason": "HTTPS required"})
            return

        await send(
            {
                "type": "http.response.start",
                "status": 308,
                "headers": [
                    (b"location", location.encode("latin-1")),
                    (b"content-length", b"0"),
                ],
            }
        )

    @staticmethod
    def _is_https(scope: Any) -> bool:
        """这次请求是否确实走加密链路。

        ``https`` 和 ``wss`` **两个 scheme 都要认**：加密的 WebSocket 在 ASGI 里的
        scheme 是 ``wss``，不是 ``https``。只认 https 的后果是**所有**浏览器
        WebSocket（实时指标、任务流、VNC 控制台）挂在反代后面时被判成明文、握手
        一律以 1008 关掉，uvicorn 记成 403 —— 而它们其实都走在 TLS 上。

        这里刻意不再自己去解析 ``X-Forwarded-Proto``：uvicorn 的 ProxyHeaders
        中间件已经按 ``FORWARDED_ALLOW_IPS`` 验过信任链并把结论写进 scheme 了。
        重复判断反而会出错 —— 那个中间件同时把 ``scope["client"]`` 改成了真实
        客户端 IP，于是「对端是不是可信反代」在这里永远为假。
        """
        return scope.get("scheme") in ("https", "wss")

    @staticmethod
    def _redirect_target(scope: Any, headers: Dict[bytes, bytes]) -> str:
        host = (headers.get(b"host") or b"").decode("latin-1")
        for port in (f":{settings.port}", ":80"):
            if port and host.endswith(port):
                host = host[: -len(port)]
                break
        if not host:
            server = scope.get("server") or ("localhost", settings.port)
            host = str(server[0])
        location = f"https://{host}{scope.get('path') or '/'}"
        query = scope.get("query_string") or b""
        if query:
            location += "?" + query.decode("latin-1")
        return location

    @staticmethod
    def _with_hsts(send: Any) -> Any:
        async def send_with_hsts(message: Dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                current = list(message.get("headers") or [])
                if not any(
                    name.lower() == b"strict-transport-security" for name, _ in current
                ):
                    current.append((b"strict-transport-security", HttpsEnforcementMiddleware.HSTS))
                    message = {**message, "headers": current}
            await send(message)

        return send_with_hsts


# 放在最后 = 最外层：先决定走不走 HTTPS，再进 CORS / 连接作用域 / 路由。
app.add_middleware(HttpsEnforcementMiddleware)


@app.exception_handler(ProxmoxError)
async def proxmox_error_handler(request: Request, exc: ProxmoxError) -> JSONResponse:
    """Translate Proxmox failures into a consistent JSON shape."""
    status = exc.status_code if 400 <= exc.status_code < 600 else 500
    return JSONResponse(status_code=status, content=exc.to_dict())


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"服务器内部错误：{exc}"},
    )


# ------------------------------------------------------------------ routers
app.include_router(auth.router)
app.include_router(config.router)
app.include_router(dashboard.router)
# 监控历史：/api/metrics/history 与 /api/metrics/coverage（实时那条走 /ws/metrics）
app.include_router(metrics_router.router)
# 个人 API Token：/api/tokens（列表 / 创建 / 吊销）
app.include_router(tokens_router.router)
# 后台作业：/api/scheduler（状态 / 改间隔 / 立即执行 / 恢复默认）
app.include_router(scheduler_router.router)
# 每用户界面偏好：/api/prefs（仪表盘布局等）
app.include_router(prefs_router.router)
app.include_router(cluster.router)
app.include_router(vms.router)
# 容器与虚拟机是两套 PVE 端点，走自己的路由；归属与权限仍与 vms 共用
app.include_router(lxc.router)
app.include_router(templates.router)
app.include_router(storages.router)
app.include_router(network.router)
app.include_router(node_notes.router)
# 虚拟机/容器的手动 IP（面板侧补充信息，只用于展示，不回写 PVE）
app.include_router(vm_meta.router)
app.include_router(backups.router)
app.include_router(tasks.router)
app.include_router(console.router)
app.include_router(frp_router.router)
app.include_router(ip_pools.router)
app.include_router(firewall.router)
app.include_router(ssh.router)
app.include_router(baseline.router)
app.include_router(ports_router.router)
# 应急隔离挂在 /api/vms/{node}/{vmid}/quarantine，与 vms 共用归属校验
app.include_router(isolation.router)
app.include_router(hostaudit.router)
app.include_router(users.router)
app.include_router(roles.router)
app.include_router(audit.router)
app.include_router(alerts.router)
app.include_router(certs.router)
app.include_router(feishu.router)
app.include_router(health.router)
# 数据导出（审计日志 / 任务 / 资产清单 / 告警历史）
app.include_router(export_router.router)
# 站内通知（铃铛未读数 / 已读）与跨资源全局搜索
app.include_router(notifications_router.router)
app.include_router(search.router)


@app.get("/api/version", tags=["meta"])
async def version() -> Dict[str, Any]:
    info = await site.get_site_info()
    return {"name": info["name"], "version": "0.1.3", "api": "v1"}


# ------------------------------------------------------------ front-end UI
# 生产部署：后端直接托管前端构建产物 dist/。前端与 API 同源，既不需要
# 额外的静态服务器 / Nginx，也避免了反向代理 WebSocket 的配置——VNC
# 控制台因此可以开箱即用。
DIST_DIR = BASE_DIR.parent / "dist"

if (DIST_DIR / "index.html").is_file():
    if (DIST_DIR / "assets").is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=DIST_DIR / "assets"),
            name="assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        """返回 dist/ 中的静态文件，未命中的路径回退到 index.html。"""
        if full_path.startswith("api/"):
            # 未知的 API 路径保持 404 语义，不要伪装成前端页面。
            raise HTTPException(status_code=404, detail="Not Found")

        candidate = (DIST_DIR / full_path).resolve()
        if full_path and candidate.is_file() and DIST_DIR in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")

else:

    @app.get("/", include_in_schema=False)
    async def root() -> Dict[str, str]:
        return {
            "name": "ProxCenter API",
            "docs": "/api/docs",
            "health": "/api/health",
            "hint": "未找到 dist/，执行 npm run build 后本服务将直接托管前端界面。",
        }

# ============================================================== 后台作业注册
# 改造前这里是四个各自独立的 `while True` 循环 + 一堆「每 N 个 tick 跑一次」
# 的倍数常量：间隔改不了，运行状态也看不见（循环体里 `logger.exception` 吞掉
# 异常之后，界面上完全看不出某个巡检是不是早就挂了）。
#
# 现在统一交给 app.scheduler：一份作业表，每项有自己的间隔与运行状态，
# 间隔落库、改完下一个周期生效。下面这些常量只作**默认值** —— 它们的取值与
# 改造前各循环的实际周期一一对应，所以本次升级后的调度行为不变。

# 资源告警：一分钟一次，要在故障扩散之前发现
ALERT_INTERVAL = 60
# 端口/进程巡检：要跑 ss/ps + 遍历 /proc，还要逐台 SSH，比资源告警重得多，
# 5 分钟一次足够（改造前写作「每 5 个 tick」）
PORTS_INTERVAL = 5 * ALERT_INTERVAL
# 受保护备份核对：要走 PVE 逐个存储拉内容，与端口巡检同频足够
BACKUP_CHECK_INTERVAL = PORTS_INTERVAL
# 主机登录审计：登录历史变化慢，5 分钟汇入一次足够
HOST_AUDIT_INTERVAL = 300
# 证书续期检查：免费证书只有 90 天，6 小时查一次足够；首次延迟 2 分钟，
# 让启动流程先跑完再去发外部网络请求
CERT_INTERVAL = 6 * 3600
CERT_FIRST_DELAY = 120
# 监控历史采样周期。它同时决定采样点的时间戳对齐粒度（见 metrics.align_ts），
# 所以那个函数会回头问调度器要当前生效值，两边一起变才不会出现重复点。
METRICS_INTERVAL = max(int(settings.metrics_sample_interval), 1)
# 各类保留清理：存量变化极慢，一小时一次足够
PURGE_INTERVAL = 3600
# API Token 的过期行清理：一天一次
TOKEN_PURGE_INTERVAL = 86_400
# 内网穿透看护：一分钟看一次。frpc 断掉意味着所有穿透一起断，等太久没意义；
# 一次检查只是读一个 pid 文件，代价可以忽略（拉起失败另有退避，见 app/frp.py）
FRP_WATCHDOG_INTERVAL = 60
# 首次延迟 20 秒：启动时要先跑配置迁移与数据库初始化，别抢在前面
FRP_WATCHDOG_FIRST_DELAY = 20


def _job(
    job_id: str,
    name: str,
    group: str,
    description: str,
    run: Callable[[], Awaitable[Any]],
    interval: int,
    *,
    summarize: Optional[Callable[[Any], str]] = None,
    first_delay: Optional[int] = None,
) -> scheduler.Job:
    return scheduler.Job(
        id=job_id,
        name=name,
        group=group,
        description=description,
        run=run,
        default_interval=interval,
        summarize=summarize,
        first_delay=first_delay,
    )


def _count(label: str) -> Callable[[Any], str]:
    """把「返回一串触发项」的作业收成一句人能读的摘要（空 = 无变化）。"""

    def render(result: Any) -> str:
        try:
            size = len(result or [])
        except TypeError:
            return ""
        return f"{label} {size} 项" if size else "无变化"

    return render


def _import_summary(result: Any) -> str:
    """主机登录审计返回的是 {imported, skipped, ...}，只挑导入条数报出来。"""
    if not isinstance(result, dict):
        return ""
    imported = int(result.get("imported") or 0)
    return f"导入 {imported} 条" if imported else "无新增"


def _sample_summary(result: Any) -> str:
    try:
        written = int(result or 0)
    except (TypeError, ValueError):
        return ""
    return f"落库 {written} 个点" if written else "本轮无数据"


def _frp_summary(result: Any) -> str:
    """内网穿透看护只回一个动作，翻成一句人话。"""
    if not isinstance(result, dict):
        return ""
    action = str(result.get("action") or "")
    if action == "restarted":
        return "检测到 frpc 已停止，已自动拉起"
    if action == "backoff":
        return f"退避中（已连续失败 {int(result.get('failures') or 0)} 次）"
    if action == "skipped":
        return "未开启自动拉起"
    if action == "running":
        return "frpc 运行中"
    return ""


def _purge_summary(result: Any) -> str:
    try:
        removed = int(result or 0)
    except (TypeError, ValueError):
        return ""
    return f"清理 {removed} 行" if removed else "无需清理"


def _cert_summary(result: Any) -> str:
    if not isinstance(result, dict):
        return _count("处理")(result)
    renewed = len(result.get("renewed") or [])
    failed = len(result.get("failed") or [])
    if failed:
        return f"续期 {renewed} 张、失败 {failed} 张"
    return f"续期 {renewed} 张" if renewed else "无需续期"


# 注册顺序 = 界面上的展示顺序，按「发现问题的先后」排：先告警与安全，
# 再监控与证书，最后是清理这类纯维护作业。
scheduler.register(
    _job(
        "alerts",
        "资源告警巡检",
        "安全巡检",
        "按阈值评估节点与虚拟机的 CPU / 内存 / 存储，命中规则即告警",
        alerting.evaluate,
        ALERT_INTERVAL,
        summarize=_count("命中"),
    )
)
scheduler.register(
    _job(
        "ssh_guard",
        "SSH 登录安全",
        "安全巡检",
        "检查本机的失败登录、爆破与异常来源，命中即告警",
        sshguard.evaluate,
        ALERT_INTERVAL,
        summarize=_count("命中"),
    )
)
scheduler.register(
    _job(
        "ssh_fleet",
        "受管主机 SSH 巡检",
        "安全巡检",
        "遍历已登记的受管主机，检查其 SSH 登录异常与策略偏移",
        sshremote.evaluate_fleet,
        ALERT_INTERVAL,
        summarize=_count("命中"),
    )
)
scheduler.register(
    _job(
        "ports",
        "端口与进程巡检",
        "安全巡检",
        "扫描监听端口与关键进程，发现新增对外暴露的服务",
        portguard.evaluate,
        PORTS_INTERVAL,
        summarize=_count("命中"),
    )
)
scheduler.register(
    _job(
        "backup_guard",
        "备份完整性核对",
        "安全巡检",
        "核对受保护备份是否仍然存在且未被篡改（防删 / 防篡改）",
        backupguard.evaluate,
        BACKUP_CHECK_INTERVAL,
        summarize=_count("命中"),
    )
)
scheduler.register(
    _job(
        "host_audit",
        "主机登录审计导入",
        "安全巡检",
        "把各主机的 SSH 登录 / sudo 事件增量汇入面板审计日志",
        host_audit.import_events,
        HOST_AUDIT_INTERVAL,
        summarize=_import_summary,
    )
)
scheduler.register(
    _job(
        "metrics_sample",
        "监控历史采样",
        "监控与证书",
        "把节点与虚拟机的资源指标按周期采样进 metrics_history（实时那条走 WebSocket）",
        metrics_history.sample_once,
        METRICS_INTERVAL,
        summarize=_sample_summary,
    )
)
scheduler.register(
    _job(
        "certs",
        "证书状态同步与续期",
        "监控与证书",
        "同步网站证书状态并自动续期（免费证书只有 90 天）",
        cert_manager.renew_tick,
        CERT_INTERVAL,
        summarize=_cert_summary,
        first_delay=CERT_FIRST_DELAY,
    )
)
scheduler.register(
    _job(
        "frp_watchdog",
        "内网穿透看护",
        "服务看护",
        "frpc 进程不在时自动拉起（仅在「自动拉起」开启时生效）",
        frp.watchdog,
        FRP_WATCHDOG_INTERVAL,
        summarize=_frp_summary,
        first_delay=FRP_WATCHDOG_FIRST_DELAY,
    )
)
scheduler.register(
    _job(
        "metrics_purge",
        "监控历史保留清理",
        "数据清理",
        "按 METRICS_RETENTION_DAYS 清理超期的指标采样行",
        metrics_history.purge_old,
        PURGE_INTERVAL,
        summarize=_purge_summary,
    )
)
scheduler.register(
    _job(
        "notifications_purge",
        "站内通知保留清理",
        "数据清理",
        "清理已读且超期的站内消息",
        notifications.purge_old,
        PURGE_INTERVAL,
        summarize=_purge_summary,
    )
)
scheduler.register(
    _job(
        "tokens_purge",
        "API Token 残留清理",
        "数据清理",
        "清理过期 / 已吊销超过 30 天的 API Token 记录",
        apitokens.purge_expired,
        TOKEN_PURGE_INTERVAL,
        summarize=_purge_summary,
    )
)

