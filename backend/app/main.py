"""FastAPI application entrypoint."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR, settings
from .pve import (
    ProxmoxError,
    get_client,
    reset_request_connection,
    reset_request_scope,
    set_request_connection,
    set_request_scope,
)
from .routers import (
    ai as ai_router,
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
    # 统一处置（预览 → 二次确认 → 执行）；动作实现在 app.remediation
    remediation as remediation_router,
    roles,
    # 后台作业状态与配置（/api/scheduler/*）；调度实现在 app.scheduler
    scheduler as scheduler_router,
    ssh,
    storages,
    tasks,
    templates,
    # 个人 API Token 管理（/api/tokens/*）。实现与鉴权在 app.apitokens
    tokens as tokens_router,
    # 面板自身的更新（检查新版本 / 一键更新）：与 app.update 模块同名，取别名
    update as update_router,
    users,
    vm_meta,
    # 虚拟机导入 / 导出：OVF/OVA 导入与 VMDK/QCOW2/RAW/OVA 导出
    vmtransfer as vmtransfer_router,
    # 虚拟机重装系统：用 Cloud-Init 模板重建系统盘
    reinstall as reinstall_router,
    vms,
)
from . import aichat
from . import aiaudit
# 远程终端：进程退出时要主动断开挂着的 SSH 交互会话（见 lifespan）
from . import aiterm
from . import alert_rootcause
from . import alerting
from . import accesscontrol
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
from . import trusteddevices
from . import update
# 账号有效期：到期前邮件提醒、到期关机并冻结（见 app/userexpiry.py）
from . import userexpiry
# 面板版本的唯一来源（package.json 与 CHANGELOG 跟着它走）
from . import __version__
# 与 routers.hostaudit 同名，取个别名避免混淆
from . import hostaudit as host_audit
from . import i18n
from .routers import frp as frp_router
from . import backupguard
from . import buildinfo
from . import portguard
from . import quotaalert
from . import quorumguard
# 资源额度：按所有者分配的核数 / 内存 / 磁盘 / 快照额度（见 app/quota.py 下半部分）
from . import quota
from . import database
from . import guest_created
# 巡检快照：把「端口与进程」「安全基线」的结果落库，读接口只读快照
from . import inspection
# 客户机 IP 落库缓存（虚拟机列表的 IP 列不再在请求内等 Guest Agent）
from . import guestip
# 巡检类阻塞调用的专用线程池，避免占满事件循环的默认 executor
from . import taskpool
from .store import get_connections, init_db, purge_expired_tokens

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("ProxCenter")

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    # AI 排查助手：谁在什么时候让 AI 在哪台机器上跑了什么命令，必须可追溯
    await aiaudit.init_table()
    # AI 会话：把「一次性排查」升级成可追问的对话（对话线程 + 消息）
    await aichat.init_table()
    await alerting.init_table()
    await cert_manager.init_table()
    await ownership.init_table()
    # 用户级资源额度表（roles.quota 列由上面的 init_db 负责补）
    await quota.init_table()
    # 受管主机表：本次升级给它加了「来源虚拟机」三列（node / vmid / conn_id）。
    # 迁移必须在这里跑完，不能等第一次打开「SSH 安全」页才做 —— 删除虚拟机的
    # 清理逻辑（sshremote.purge_vm_hosts）可能先于那次访问被触发，届时找不到列。
    await sshremote.init_table()
    # 受保护备份登记表（防删 / 防篡改核对）
    await backupguard.init_table()
    # 面板发起的建机 / 克隆 / 恢复记录（创建时间字段的准确来源，见 app.guest_created）
    await guest_created.init_table()
    # 归属表的一次性迁移：把升级前记在 KIND_VM 下的容器归属改到 KIND_CT
    # （虚拟机 / 容器权限与归属拆分）。要用到上面的 guest_created_record 判断
    # 哪些机器是容器，所以必须排在建表之后；纯读面板库，PVE 连不上也能跑。
    await ownership.migrate_guest_kinds()
    await password_reset.init_table()
    # 监控历史表：「监控历史采样」作业到点后开始往里写点
    await metrics_history.init_table()
    # 巡检快照表：端口 / 基线的结果落库，读接口不再现场 SSH（见 app.inspection）
    await inspection.init_table()
    # 客户机 IP 落库缓存：虚拟机列表读它，不再在请求内逐台问 Guest Agent
    await guestip.init_table()
    # 站内通知表：告警发生时由 alerting.record 往里写未读消息
    await notifications.init_table()
    # 个人 API Token 表（脚本 / 外部系统用的长期凭据，见 app.apitokens）
    await apitokens.init_table()
    # 信任设备表（登录两步验证的「7 天内免二次校验」，见 app.trusteddevices）
    await trusteddevices.init_table()
    # 每用户的界面偏好（仪表盘布局等，见 app.prefs）
    await prefs.init_table()
    # 清掉过期的令牌黑名单条目与早已过期的会话记录（纯残留清理，失败不影响启动）
    try:
        await purge_expired_tokens()
        await trusteddevices.purge_expired()
        await throttle.cleanup()
    except Exception:  # noqa: BLE001
        logger.exception("清理过期令牌/限流数据失败，忽略")
    # 角色定义可选择：把内置角色补齐进库并把全部角色读入内存缓存
    await security.load_roles()
    # 老版本只用 frp_config 一个 key 存整份配置；新版拆成 server + rules，
    # 启动时一次性迁移，避免第一个 GET 接口看到空数据。
    await frp.migrate_legacy()
    logger.info("数据库就绪：%s", database.describe())
    # 前端产物与后端是不是同一个版本。不一致时界面可能少功能或行为不对，而它此前
    # 在界面上毫无迹象（代码已是新版、服务照跑、页面照开）。见 app.buildinfo。
    buildinfo.log_at_startup()
    logger.info("Panel listening on %s:%s", settings.host, settings.port)
    # 公网暴露是这套面板最需要被看见的前提：白名单没配就把这件事写进日志，
    # 配了就打印生效网段，避免「以为配了、其实拼错被忽略」。
    if accesscontrol.has_invalid_entries():
        logger.warning("PANEL_ALLOW_CIDRS 含非法条目，见上一条解析告警")
    if accesscontrol.configured():
        logger.info(accesscontrol.startup_hint())
    else:
        logger.warning(accesscontrol.startup_hint())
    # FORWARDED_ALLOW_IPS=* 下，任何客户端都能自称任意来源 IP：白名单会被
    # 绕过，限流与审计里的 IP 也不可信。这不是「可选优化」，是信任边界。
    if (settings.forwarded_allow_ips or "").strip() == "*":
        logger.warning(
            "FORWARDED_ALLOW_IPS=*：面板信任任意对端传来的 X-Forwarded-For，"
            "来源 IP 可被伪造（白名单 / 登录锁定 / 审计 IP 都会失真）。"
            "请改成反向代理的实际地址。"
        )
    # 关掉证书校验的连接 = 面板到 PVE 的通道可被内网中间人劫持（审计项 FD-07）。
    # 自签证书请改用「证书钉扎」（连接配置里的 ca_cert），而不是整条链路不校验。
    try:
        insecure = [
            str(c.get("name") or c.get("id") or c.get("host") or "?")
            for c in get_connections()
            if not bool(c.get("verify_ssl", settings.pve_verify_ssl))
        ]
    except Exception:  # noqa: BLE001 - 读不到配置不该拦住启动
        insecure = []
    if insecure:
        logger.warning(
            "以下 PVE 连接未校验证书（通道可被中间人劫持，API Token 可能被截获）：%s"
            "。自签证书请填「证书 PEM」做钉扎，或把 PVE 证书换成受信任 CA 签发。",
            "、".join(insecure),
        )

    # 文档端点：默认不挂载；打开时也要让人知道「它不是匿名的」
    if settings.api_docs_enabled:
        logger.warning(
            "API_DOCS_ENABLED=true：/api/docs、/api/redoc、/api/openapi.json 已挂载，"
            "访问需管理员登录。仅建议在内网/调试环境打开。"
        )
    else:
        logger.info("接口文档端点已关闭（/api/docs、/api/redoc、/api/openapi.json 均 404）")

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

    # 停止路径**逐步打点**：这几步里任何一步卡住，systemd 都会在 TimeoutStopSec
    # （15 秒）到点后直接 SIGKILL —— 进程被硬杀，数据库连接池与远端 SSH 都来不及
    # 收口，而且日志里只会留下一句「stop-sigterm timed out」，看不出卡在哪。
    # 打点之后，最后一条日志指向的就是卡住的那一步。
    logger.info("正在停止：后台调度器")
    await scheduler.stop()
    # 打开的远程终端各挂着一条 SSH 连接：进程退出前主动收口，
    # 让远端把登录会话干净地关掉，而不是留一堆半死的连接。
    logger.info("正在停止：远程终端")
    await aiterm.close_all()
    logger.info("正在停止：HTTP 客户端")
    await client.aclose()
    logger.info("正在停止：池化 SSH 连接")
    sshremote.close_pool()
    logger.info("正在停止：巡检线程池")
    taskpool.shutdown()
    logger.info("正在停止：数据库连接池")
    await database.close_pool()
    logger.info("Shutdown complete")


app = FastAPI(
    title="ProxCenter API",
    description=(
        "Web management panel for Proxmox VE 8.x / 9.x. "
        "Provides VM lifecycle, template building, networking, "
        "monitoring, backup and console access."
    ),
    version=__version__,
    lifespan=lifespan,
    # 三个文档端点一律不交给 FastAPI 自动挂载：它的内置路由没有鉴权，匿名
    # 就能拿到完整 OpenAPI（= 全量攻击地图）。需要时由下面的 _mount_api_docs
    # 注册**加过管理员鉴权**的等价路由（见 API_DOCS_ENABLED）。
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
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
    """把 ``X-PVE-Connection`` / ``X-PVE-Scope`` 请求头绑定到本次请求。

    面板可以配置多台 Proxmox，绝大多数请求作用于「当前连接」；但创建虚拟机的
    向导允许临时指定另一台主机。该请求头让 :func:`get_client` 在本次请求内返回
    对应主机的客户端，从而所有读写接口都无需额外参数即可支持多主机。

    两个头强度不同（见 :mod:`app.pve` 的说明）：
      * ``X-PVE-Connection`` 是**硬指定** —— 调用点知道机器在哪条连接上；
      * ``X-PVE-Scope`` 是**软作用域** —— 顶栏「集群作用域」，会让读数据的接口
        只读那一套，但按节点 / VMID 能定位到别处时允许被覆盖。

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
        scope_id = ""
        accept_language = ""
        for key, value in scope.get("headers") or []:
            if key == b"x-pve-connection":
                conn_id = value.decode("latin-1").strip()
            elif key == b"x-pve-scope":
                scope_id = value.decode("latin-1").strip()
            elif key == b"accept-language":
                # 界面语言（见 i18n.py）：权限目录、内置角色名、FAQ 与错误消息按它返回
                accept_language = value.decode("latin-1").strip()

        i18n.set_language(accept_language)
        token = set_request_connection(conn_id)
        scope_token = set_request_scope(scope_id)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_request_scope(scope_token)
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


class SecurityHeadersMiddleware:
    """给所有 HTTP 响应补齐浏览器安全头（CSP / nosniff / Referrer / Permissions）。

    为什么写在应用里而不是只交给 nginx：反代配置属于部署方，漏了就整站裸奔；
    面板自己下发，裸 8080、Docker、反代三种部署口径一致。反代那边只需**不要
    重复添加同名头**（尤其是 HSTS —— 两份会让响应里出现两条同名头）。

    CSP 分两档，别为了文档把全站放宽：

    * 普通页面 / 接口：``script-src 'self'``（Vite 产物没有内联脚本，实测可跑）；
    * ``/api/docs``、``/api/redoc``：Swagger UI / ReDoc 从 cdn.jsdelivr.net 取
      资源、且页面里有内联启动脚本，只对这两条路径放宽（它们默认还不存在）。

    ``connect-src`` 收在同源 + ws/wss：控制台、实时指标、VNC 都是同源
    WebSocket；写显式 scheme 是为了兼容只认 scheme 的旧浏览器。
    """

    CSP = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )
    DOCS_PATHS = frozenset({"/api/docs", "/api/redoc"})
    DOCS_CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: https://fastapi.tiangolo.com; "
        "font-src 'self' data: https://cdn.jsdelivr.net; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )
    STATIC_HEADERS = (
        # 禁掉 MIME 嗅探：上传的 json / svg / 控制台下载文件不会被当成脚本执行
        (b"x-content-type-options", b"nosniff"),
        # 跨站跳转只带 origin：完整 URL 里可能有查询参数（例如控制台 token）
        (b"referrer-policy", b"strict-origin-when-cross-origin"),
        (
            b"permissions-policy",
            b"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
        # frame-ancestors 已能挡点击劫持，这条覆盖不支持 CSP 的老浏览器
        (b"x-frame-options", b"DENY"),
    )

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""
        csp = self.DOCS_CSP if path in self.DOCS_PATHS else self.CSP
        extra = [(b"content-security-policy", csp.encode("latin-1"))]
        extra.extend(self.STATIC_HEADERS)

        async def send_with_headers(message: Dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                # 顺手摘掉服务器商标头（审计项 FD-14）。uvicorn 自己的
                # "server: uvicorn" 是协议层加的，已在 run.py 用 server_header=False
                # 关掉；这里兜住应用/中间件可能加上的同名头，避免漏一处在响应里
                # 出现两条 server。
                current = [
                    (name, value)
                    for name, value in (message.get("headers") or [])
                    if name.lower() not in (b"server", b"x-powered-by")
                ]
                present = {name.lower() for name, _ in current}
                current.extend(
                    (name, value) for name, value in extra if name not in present
                )
                message = {**message, "headers": current}
            await send(message)

        await self.app(scope, receive, send_with_headers)


# 加在 Https 之后 = 最外层：308 跳转、403 拒绝、静态资源也都带上安全头。
app.add_middleware(SecurityHeadersMiddleware)


class PanelAccessControlMiddleware:
    """按来源 IP / CIDR 拒绝面板访问（``PANEL_ALLOW_CIDRS``）。

    这是应对「面板直接暴露公网」最有效的一道闸：来源不在白名单内时，
    连登录页、``/api/openapi.json``、VNC WebSocket 都看不到 / 连不上。

    细节：
      * 未配置白名单时完全放行（存量部署行为不变）；
      * 本机回环始终放行（反代 / 健康检查 / 容器 sidecar）；
      * ``/api/health`` 始终放行，探活不因白名单失败；
      * **WebSocket 也要拦**：只挡 HTTP 的话，VNC 控制台仍能握手；
      * 来源取 :func:`security.client_ip_from_scope`，只信可信反代的 XFF，
        客户端自己伪造的头不会换来放行。

    写成原生 ASGI：拒绝路径极短，且 WebSocket 握手也能直接 close。
    """

    EXEMPT_PATHS = frozenset({"/api/health"})
    # 被拒日志按 IP 做 60 秒去重：爆破时的日志洪水本身也是一种资源消耗
    _last_log: Dict[str, float] = {}

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if not accesscontrol.configured():
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path") or "")
        if scope_type == "http" and path in self.EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        ip = security.client_ip_from_scope(scope)
        if accesscontrol.is_allowed(ip):
            await self.app(scope, receive, send)
            return

        self._log_blocked(ip, path, scope_type)
        if scope_type == "websocket":
            await send(
                {
                    "type": "websocket.close",
                    "code": 1008,
                    "reason": "Source address not allowed",
                }
            )
            return

        body = json.dumps(
            {"detail": "Access denied: source address is not allowed"},
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    @classmethod
    def _log_blocked(cls, ip: str, path: str, scope_type: str) -> None:
        now = time.monotonic()
        last = cls._last_log.get(ip)
        if last is not None and now - last < 60:
            return
        if len(cls._last_log) > 2048:
            cls._last_log.clear()
        cls._last_log[ip] = now
        logger.warning(
            "已拒绝非白名单来源访问面板：ip=%s type=%s path=%s"
            "（如属误拦，请检查 PANEL_ALLOW_CIDRS 与 FORWARDED_ALLOW_IPS）",
            ip or "-",
            scope_type,
            path or "-",
        )


# 再包一层 = 最外层：白名单先于 HTTPS 跳转 / CORS / 限流生效。
app.add_middleware(PanelAccessControlMiddleware)


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
# 面板自身的更新：/api/update/status|check|settings|apply（仅管理员）
app.include_router(update_router.router)
# 每用户界面偏好：/api/prefs（仪表盘布局等）
app.include_router(prefs_router.router)
app.include_router(cluster.router)
# 虚拟机导入 / 导出（VMware 互操作）：OVF/OVA 导入与 VMDK/QCOW2/RAW/OVA 导出。
# **必须注册在 vms.router 之前**：vms 里有 ``GET /vms/{node}/{vmid}`` 这条两段动态
# 路由，它会把 ``/vms/import/sources``、``/vms/exports/{id}`` 这种「静态前缀 + 两段」
# 的路径先匹配走（node=import、vmid=sources），接口于是返回 422 —— 逐个路由都对、
# 但永远进不来，属于最难看出来的那一类问题。静态段优先于动态段。
app.include_router(vmtransfer_router.router)
# 重装系统（路径形如 /vms/{node}/reinstall-templates 与 /vms/{node}/{vmid}/reinstall，
# 段数与 vms 的动态路由不同形，不依赖注册顺序）
app.include_router(reinstall_router.router)
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
# AI 排查助手：只读解读巡检结果（配置仅管理员可改）
app.include_router(ai_router.router)
app.include_router(ports_router.router)
# 应急隔离挂在 /api/vms/{node}/{vmid}/quarantine，与 vms 共用归属校验
app.include_router(isolation.router)
# 统一处置：/api/remediation/actions|preview|apply（预览 + 二次确认 + 审计）
app.include_router(remediation_router.router)
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


# ---------------------------------------------------------------- 接口文档
# 默认**不提供**任何文档端点：匿名可读的 /api/openapi.json 会把 300+ 个接口、
# 每个字段的约束、连「隐藏端点」一起交出去，等于把侦察成本降到零，而面板
# 握着 PVE 的全权管理能力（审计项 FD-03）。
#
# 需要时打开 API_DOCS_ENABLED，这里注册的替代路由仍要求「已登录 + 具备
# settings.manage（管理员）」——Swagger UI 与 openapi.json 同源，浏览器会
# 自动带上登录 cookie，管理员照样能在页面上试调；匿名访问则拿不到 spec。
#
# 注册位置必须在 /api/{rest:path}（404 兜底）与 SPA 兜底**之前**，否则会被
# 它们吃掉（FastAPI 按注册顺序匹配，先注册的赢）。
def _mount_api_docs(target: Optional[FastAPI] = None) -> None:
    """挂载需要管理员鉴权的 Swagger UI / ReDoc / OpenAPI JSON。

    ``target`` 只为测试留口：用例拿一个空 app 验证「没有凭据 = 401」，
    不去碰真实路由表。
    """
    api = target or app
    admin_only = Depends(security.require_permission("settings.manage"))

    @api.get("/api/openapi.json", include_in_schema=False, dependencies=[admin_only])
    async def openapi_spec() -> JSONResponse:
        return JSONResponse(
            api.openapi(),
            # spec 里有全部接口形状，中间层/浏览器都不该留副本
            headers={"Cache-Control": "no-store"},
        )

    @api.get("/api/docs", include_in_schema=False, dependencies=[admin_only])
    async def swagger_docs() -> HTMLResponse:
        return get_swagger_ui_html(
            openapi_url="/api/openapi.json",
            title=f"{api.title} — Swagger UI",
            swagger_ui_parameters={"persistAuthorization": True},
        )

    @api.get("/api/redoc", include_in_schema=False, dependencies=[admin_only])
    async def redoc_docs() -> HTMLResponse:
        return get_redoc_html(
            openapi_url="/api/openapi.json",
            title=f"{api.title} — ReDoc",
        )


if settings.api_docs_enabled:
    _mount_api_docs()


@app.get("/api/version", tags=["meta"])
async def version(
    _user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """面板版本（需登录）。

    原来匿名可读：面板版本 + 前端构建时间等于给扫描器一个「该打哪个已知漏洞」
    的索引，也让「产物是否陈旧」变成可探测状态（审计：未鉴权接口泄露版本）。
    站名/Logo 这类品牌信息仍在公开的 ``/api/config/site`` 里，登录页照常渲染。
    """
    info = await site.get_site_info()
    return {
        "name": info["name"],
        "version": __version__,
        "api": "v1",
        # 前端构建产物的版本与一致性（见 app.buildinfo）：界面据此提示「产物陈旧」
        "frontend": buildinfo.status(),
    }


# 未知的 /api/* 路径一律回 404（**所有方法**）。
#
# 为什么非加不可：下面的 SPA 兜底是 ``GET /{full_path:path}``，它匹配**任何**路径。
# POST 到一个不存在的接口时，Starlette 于是发现「路径有匹配、方法不对」，回
# **405 Method Not Allowed** —— 前端把 detail 原样显示，用户看到「Method Not
# Allowed」，会去翻请求方法写错了没有，而真相通常是后端还跑着旧版本、这个接口
# 根本没发布。405 在这里说了假话，404 才是实话。
#
# 必须注册在**所有**真实路由之后：FastAPI 按注册顺序匹配，先注册的赢。
@app.api_route(
    "/api/{rest:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def api_not_found(rest: str) -> JSONResponse:
    # detail 要自己把话说全 —— 前端是**原样显示**它的。只说 "Not Found" 的话用户
    # 拿不到任何线索，而这里最常见的原因恰恰是「后端还跑着旧版本，这个接口根本
    # 还没发布」，那句话必须出现，否则排查方向会整个跑偏。
    return JSONResponse(
        status_code=404,
        content={
            "detail": i18n.pick(
                f"接口不存在：/api/{rest}（后端可能还在跑旧版本，重启后再试）",
                f"No such endpoint: /api/{rest} (the backend may still be running "
                "an older build — restart and retry)",
            )
        },
    )


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
        info = {
            "name": "ProxCenter API",
            "health": "/api/health",
            "hint": "未找到 dist/，执行 npm run build 后本服务将直接托管前端界面。",
        }
        # 文档默认关闭，这里也别把地址写死成「有」—— 那是给匿名探测指路
        if settings.api_docs_enabled:
            info["docs"] = "/api/docs"
        return info

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
# 集群仲裁巡检：逐套 PVE 探测（每套 2~3 个上游请求），而且要覆盖**所有**连接，
# 不能像资源告警那样只读默认那一台。失去仲裁不会自己恢复，5 分钟查一次足够 ——
# 这条规则的意义是「别让它静悄悄过去」，不是秒级发现。
QUORUM_INTERVAL = 5 * ALERT_INTERVAL

# 额度预警：要逐人向 PVE 枚举一遍用量（同一份读数也喂给用户页那两列），比读
# cluster/resources 重一些；5 分钟一次。阈值本身是「剩余 20%」这种缓慢变化的量，
# 再密也只是反复命中同一条冷却，不会更早发现问题。
QUOTA_ALERT_INTERVAL = 5 * ALERT_INTERVAL
# 首次给足延迟：启动时连接可能还没配好，白跳一轮没有代价
QUOTA_ALERT_FIRST_DELAY = 180
# 账号有效期：提醒按天算，冻结却要尽量准时 —— 5 分钟一轮，代价只是读一遍
# users 表；到期后最多晚 5 分钟关机。首次延迟 30 秒，启动迁移跑完就查一遍。
USER_EXPIRY_INTERVAL = 300
USER_EXPIRY_FIRST_DELAY = 30
# 主机登录审计：登录历史变化慢，5 分钟汇入一次足够
HOST_AUDIT_INTERVAL = 300
# 受管主机核对：虚拟机可能在 PVE 上被直接删掉（不走面板的删除接口），
# 每 5 分钟拿一次 PVE 的虚拟机清单比对，清掉这类残留（见 sshremote.reconcile_panel_hosts）
HOST_SYNC_INTERVAL = 300
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
# 面板自身的版本检查：一天一次足够（Release 不会一天变两次）。首次延迟 15 分钟 ——
# 启动时先把 PVE 连接、数据库迁移、调度器都跑稳，再谈出网。间隔与首次延迟的默认值
# 放在 app/update.py 里（那里还管着「手动检查的最小间隔」等同类常量）。
UPDATE_CHECK_INTERVAL = update.CHECK_INTERVAL
UPDATE_CHECK_FIRST_DELAY = update.FIRST_DELAY
# 内网穿透看护：一分钟看一次。frpc 断掉意味着所有穿透一起断，等太久没意义；
# 一次检查只是读一个 pid 文件，代价可以忽略（拉起失败另有退避，见 app/frp.py）
FRP_WATCHDOG_INTERVAL = 60
# 首次延迟 20 秒：启动时要先跑配置迁移与数据库初始化，别抢在前面
FRP_WATCHDOG_FIRST_DELAY = 20
# 告警根因聚合：跟着告警巡检的节奏（每分钟一轮判定）走，但这只是「检查」的频率 ——
# 真正推送由告警指纹与冷却压制，同一批告警不会反复推
ROOTCAUSE_INTERVAL = 5 * ALERT_INTERVAL
ROOTCAUSE_FIRST_DELAY = 2 * ALERT_INTERVAL
# 巡检快照预热：只跑**安全基线**（端口的落库由上面的「端口与进程巡检」作业顺带
# 完成，避免同一批主机每轮扫两遍 SSH）。间隔与端口巡检一致 —— 它决定「页面上的
# 数据最多旧多少」，而不是响应速度。
INSPECTION_WARM_INTERVAL = max(int(settings.inspection_warm_interval), 60)
# 首次延迟 30 秒：启动时先让数据库迁移、PVE 连接就绪，再去扫第一批
INSPECTION_WARM_FIRST_DELAY = 30
# 客户机 IP 预热：与 guestip 的进程内缓存时长对齐，让列表的 IP 列基本总能命中
GUEST_IP_WARM_INTERVAL = max(int(settings.guest_ip_warm_interval), 60)
GUEST_IP_WARM_FIRST_DELAY = 45
# 资源额度对账：快照读数是「逐台枚举 + 60 秒缓存」，本作业负责把缓存保鲜，并在
# 有人被调低额度后已经超出时落一条日志。间隔决定「读数最多旧多久」，15 分钟够用
# （创建快照时会主动作废缓存，不等它）。
QUOTA_RECONCILE_INTERVAL = 900
QUOTA_RECONCILE_FIRST_DELAY = 120
# 归属对账：把面板那本归属账和 PVE 的实际清单对齐（见 quota.reconcile_owners）。
# 它做的是**删除**，节奏不宜太急 —— 一条连接读失败就整轮跳过，所以偶尔漏一轮
# 没有代价；间隔决定「PVE 侧手工删掉一台之后，残留的归属最多留多久」。
OWNER_RECONCILE_INTERVAL = 1800
# 首次给足延迟：启动时连接可能还没配好 / PVE 还没就绪，读失败也只会白跳一轮
OWNER_RECONCILE_FIRST_DELAY = 300


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


def _rootcause_summary(result: Any) -> str:
    """告警根因聚合的摘要：跳过原因 / 参与聚合的归属人数 + 推送份数。"""
    if not isinstance(result, dict):
        return ""
    if result.get("skipped"):
        return str(result["skipped"])
    return (
        f"聚合 {int(result.get('owners') or 0)} 人，"
        f"推送 {int(result.get('sent') or 0)} 份"
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


def _warm_summary(result: Any) -> str:
    """巡检快照预热 / 客户机 IP 预热的摘要：落库了多少项。"""
    if not isinstance(result, dict):
        return ""
    count = int(result.get("stored") or 0) or int(result.get("resolved") or 0)
    return f"落库 {count} 项" if count else "无变化"


def _expiry_summary(result: Any) -> str:
    """账号有效期作业的摘要：提醒了几人、冻结了几人（附带失败数）。"""
    if not isinstance(result, dict):
        return ""
    notified = int(result.get("notified") or 0)
    frozen = int(result.get("frozen") or 0)
    skipped = int(result.get("skipped") or 0)
    failed = len(result.get("errors") or [])
    parts: List[str] = []
    if notified:
        parts.append(f"提醒 {notified} 人")
    if frozen:
        parts.append(f"冻结 {frozen} 人")
    if skipped:
        parts.append(f"跳过 {skipped} 人")
    if failed:
        parts.append(f"{failed} 项失败")
    return "、".join(parts) if parts else "无变化"


def _quota_summary(result: Any) -> str:
    """资源额度对账的摘要：刷了多少台、几个人已经超出额度。"""
    if not isinstance(result, dict):
        return ""
    refreshed = int(result.get("refreshed") or 0)
    over = len(result.get("over") or [])
    if not refreshed and not over:
        return "无变化"
    return f"刷新 {refreshed} 台" + (f"，{over} 人超额" if over else "")


def _owners_summary(result: Any) -> str:
    """归属对账的摘要：清了几条、还有几台没人认领。"""
    if not isinstance(result, dict):
        return ""
    refused = str(result.get("refused") or "")
    if refused:
        return f"读数不完整，已跳过（{refused}）"
    removed = int(result.get("removed") or 0)
    orphans = int(result.get("orphans") or 0)
    if not removed and not orphans:
        return "无变化"
    parts = []
    if removed:
        parts.append(f"清理 {removed} 条残留归属")
    if orphans:
        parts.append(f"{orphans} 台无人认领")
    return "，".join(parts)


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


def _host_sync_summary(result: Any) -> str:
    """受管主机核对回的是 ``{checked, removed, hosts}``，只报清掉了几台。"""
    if not isinstance(result, dict):
        return ""
    removed = int(result.get("removed") or 0)
    return f"清理 {removed} 台已删除主机" if removed else "无变化"


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
# 集群仲裁：资源告警比的是「某个对象的使用率」，而且只读默认连接那一套 ——
# 非默认集群掉仲裁在那边永远不会响，所以单独一个作业逐套 PVE 检查
# （见 app.quorumguard；探测与仪表盘集群态势卡共用 app.fleetstatus）。
scheduler.register(
    _job(
        "quorum",
        "集群仲裁巡检",
        "安全巡检",
        "逐套 PVE 检查集群仲裁，失去仲裁即告警（含非默认读取的连接）",
        quorumguard.evaluate,
        QUORUM_INTERVAL,
        summarize=_count("命中"),
    )
)

# 用户额度预警：资源告警比的是「某台机器的使用率」，额度比的是「某人名下还剩
# 多少」，判据与对象都不同，放进规则表表达不了（见 app.quotaalert 的说明）。
# 通知发给**本人** —— 额度用完的后果落在那个人身上。
scheduler.register(
    _job(
        "quota_alert",
        "用户额度预警",
        "安全巡检",
        "算出谁的额度快用完或已超出，逐人走各自的告警通道",
        quotaalert.evaluate,
        QUOTA_ALERT_INTERVAL,
        summarize=_count("命中"),
        first_delay=QUOTA_ALERT_FIRST_DELAY,
    )
)
# 账号有效期：与额度预警同属「跟人有关」的巡检，放在它后面。
scheduler.register(
    _job(
        "user_expiry",
        "账号有效期巡检",
        "安全巡检",
        "到期前 7 / 3 / 1 天邮件提醒；到期后关闭该账号名下的虚拟机与容器并冻结账号",
        userexpiry.evaluate,
        USER_EXPIRY_INTERVAL,
        summarize=_expiry_summary,
        first_delay=USER_EXPIRY_FIRST_DELAY,
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
# 安全基线快照预热：把全量体检结果落库，页面读快照而不是现场 SSH（见 app.inspection）。
# 端口那边的落库由上面那个「端口与进程巡检」作业顺带完成，两者不重复扫同一批主机。
scheduler.register(
    _job(
        "inspection_warm",
        "安全基线快照预热",
        "安全巡检",
        "全量体检安全基线并落库，让页面读快照而不是现场 SSH",
        inspection.warm_once,
        INSPECTION_WARM_INTERVAL,
        summarize=_warm_summary,
        first_delay=INSPECTION_WARM_FIRST_DELAY,
    )
)
# 客户机 IP 预热：后台把 IP 落库，虚拟机列表读表，不再在请求内逐台等 Guest Agent
scheduler.register(
    _job(
        "guest_ip_warm",
        "客户机 IP 预热",
        "安全巡检",
        "后台解析客户机 IP 并落库，虚拟机列表不再在请求内等 Guest Agent",
        inspection.warm_guest_ip,
        GUEST_IP_WARM_INTERVAL,
        summarize=_warm_summary,
        first_delay=GUEST_IP_WARM_FIRST_DELAY,
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
# 资源额度对账：读数是逐台向 PVE 枚举出来的（没有第二份账），这里定时保鲜，
# 免得 PVE 侧手工增删过快照之后面板还按旧数字判额度
scheduler.register(
    _job(
        "quota_reconcile",
        "资源额度对账",
        "安全巡检",
        "重新枚举配了额度的用户的快照数，让读数跟上 PVE 侧的手工改动",
        quota.reconcile_snapshots,
        QUOTA_RECONCILE_INTERVAL,
        summarize=_quota_summary,
        first_delay=QUOTA_RECONCILE_FIRST_DELAY,
    )
)
# 归属对账：面板那本归属账会漂（PVE 侧手工增删的机器、被调低的额度、残留的快照行）。
# 面板自己的删除路径已经逐条清过，但逐个端点补不是办法 —— 这里兜底。
scheduler.register(
    _job(
        "owner_reconcile",
        "归属记录对账",
        "数据清理",
        "比对面板的归属账与 PVE 实际清单：清掉已消失机器的残留记录，并报出无人认领的机器",
        quota.reconcile_owners,
        OWNER_RECONCILE_INTERVAL,
        summarize=_owners_summary,
        first_delay=OWNER_RECONCILE_FIRST_DELAY,
    )
)
scheduler.register(
    _job(
        "alert_rootcause",
        "告警根因聚合",
        "安全巡检",
        "多条告警疑似同源时聚合成一条根因报告并推送",
        alert_rootcause.run_once,
        ROOTCAUSE_INTERVAL,
        summarize=_rootcause_summary,
        first_delay=ROOTCAUSE_FIRST_DELAY,
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
        "host_sync",
        "受管主机核对",
        "数据清理",
        "核对「面板下发」的受管主机与 PVE 上的虚拟机是否一致，清掉已删除机器留下的安全数据",
        sshremote.reconcile_panel_hosts,
        HOST_SYNC_INTERVAL,
        summarize=_host_sync_summary,
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
        "inspection_purge",
        "巡检快照保留清理",
        "数据清理",
        "清理超过保留期的巡检快照行，避免主机 / 语言变更留下残行",
        inspection.purge_old,
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
scheduler.register(
    _job(
        "trusted_devices_purge",
        "信任设备残留清理",
        "数据清理",
        "清理已过期的信任设备记录（登录两步验证的「7 天免校验」）",
        trusteddevices.purge_expired,
        TOKEN_PURGE_INTERVAL,
        summarize=_purge_summary,
    )
)
scheduler.register(
    _job(
        "update_check",
        "面板版本检查",
        "面板维护",
        "定期查 GitHub 上有没有新版本，有就给管理员发一条站内消息"
        "（默认一天一次，可在「设置 → 面板更新」里关掉自动检查）",
        update.run_check,
        UPDATE_CHECK_INTERVAL,
        # 摘要直接复用「命中 N 项 / 无变化」那套：run_check 返回发现的新版本列表
        summarize=_count("发现新版"),
        first_delay=UPDATE_CHECK_FIRST_DELAY,
    )
)

