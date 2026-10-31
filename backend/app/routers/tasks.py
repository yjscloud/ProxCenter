"""Proxmox task queue endpoints."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from .. import guestguard, i18n, security, store
from ..formatters import normalize_task
from ..pve import ProxmoxError, get_client, node_from_upid
from ..task_scope import build_scope
from ..vm_scope import bind_task_connection

logger = logging.getLogger(__name__)

# 注意：这里的定位依赖只加在 HTTP 任务接口上，不能用路由级依赖 ——
# 本路由还挂着 /ws/tasks（用 query token 自行鉴权），路由级依赖会要求
# Authorization 头，直接把 WebSocket 握手拒掉。
router = APIRouter(prefix="/api", tags=["tasks"])


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


# 任务归属判定集中在 ``app.task_scope``：单连接 HTTP、多连接合并 HTTP 与
# WebSocket 推送三条出口共用同一套规则，避免只收紧其中一条（安全审计 M-1）。


@router.get("/tasks")
async def list_tasks(
    node: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    running_only: bool = False,
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        tasks = await client.tasks(node=node, limit=limit)
    except ProxmoxError as exc:
        _raise(exc)

    output = [normalize_task(t) for t in (tasks or [])]
    if running_only:
        output = [t for t in output if t["running"]]

    scope = await build_scope(user)
    if scope is not None:
        output = scope.filter(output, guestguard.call_connection())
    return output


async def _require_task_guest(user: Dict[str, Any], upid: str) -> None:
    """对象级鉴权：UPID 指向的客户机必须是自己的。

    与列表同源隔离，用 404 而不是 403 —— UPID 里就写着 vmid，403 等于确认
    「这个号确实有任务在跑」，可以拿号段扫出全平台在用的机器。
    """
    scope = await build_scope(user)
    if scope is None:
        return
    if not scope.allows(guestguard.call_connection(), upid):
        raise HTTPException(status_code=404, detail="任务不存在")


@router.get("/tasks/{upid}", dependencies=[Depends(bind_task_connection)])
async def get_task(
    upid: str,
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> Dict[str, Any]:
    """Task status plus its log.

    ``node`` is optional: the node is encoded in the UPID itself, so callers
    do not have to track it separately.
    """
    client = get_client()
    resolved = node or node_from_upid(upid)
    if not resolved:
        raise HTTPException(
            status_code=400,
            detail=i18n.tr("无法从 UPID 解析节点，请显式提供 node 参数"),
        )

    # 与列表同源隔离：拿到别人的 UPID 也读不到任务详情与执行日志（M-1）
    await _require_task_guest(user, upid)

    try:
        status = await client.task_status(upid, resolved)
    except ProxmoxError as exc:
        _raise(exc)

    log_lines: List[Dict[str, Any]] = []
    try:
        log_lines = await client.task_log(upid, resolved, limit=1000)
    except ProxmoxError:
        # A brand-new task may not have a log yet; that is not an error.
        pass

    return {
        "upid": upid,
        "node": resolved,
        "status": status.get("status"),
        "exitstatus": status.get("exitstatus"),
        "type": status.get("type"),
        "user": status.get("user"),
        "pid": status.get("pid"),
        "pstart": status.get("pstart"),
        "log": log_lines,
    }


@router.get("/tasks/{upid}/log", dependencies=[Depends(bind_task_connection)])
async def get_task_log(
    upid: str,
    node: Optional[str] = None,
    start: int = 0,
    limit: int = Query(default=500, ge=1, le=5000),
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> List[Dict[str, Any]]:
    # 这条以前既没有归属过滤、也没有绑定连接：任意 UPID 就能读到别人备份/迁移
    # 任务的完整日志（里面带着卷路径、目标节点、命令行）。
    await _require_task_guest(user, upid)
    client = get_client()
    resolved = node or node_from_upid(upid)
    try:
        return await client.task_log(upid, resolved, start=start, limit=limit)
    except ProxmoxError as exc:
        _raise(exc)


@router.delete("/tasks/{upid}", dependencies=[Depends(bind_task_connection)])
async def delete_task(
    upid: str,
    request: Request,
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("task.manage")),
) -> Dict[str, Any]:
    client = get_client()
    resolved = node or node_from_upid(upid)
    if not resolved:
        raise HTTPException(status_code=400, detail=i18n.tr("无法从 UPID 解析节点"))

    # 对象级：删任务记录同样要确认这台机器是自己的
    await _require_task_guest(user, upid)
    try:
        await client.delete(f"/nodes/{resolved}/tasks/{upid}")
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(request, user, "task.delete", target=upid)
    return {"deleted": True, "upid": upid}


@router.post("/tasks/{upid}/stop", dependencies=[Depends(bind_task_connection)])
async def stop_task(
    upid: str,
    request: Request,
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("task.manage")),
) -> Dict[str, Any]:
    client = get_client()
    resolved = node or node_from_upid(upid)
    # 中止别人的任务 = 把别人正在跑的备份/迁移掐断，同样要按对象判
    await _require_task_guest(user, upid)
    try:
        await client.delete(f"/nodes/{resolved}/tasks/{upid}")
    except ProxmoxError as exc:
        _raise(exc)

    await security.audit(request, user, "task.stop", target=upid)
    return {"stopped": True, "upid": upid}


# ---------------------------------------------------------------- websocket
async def _reject(websocket: WebSocket, code: int, reason: str) -> None:
    """拒绝一次 WS 握手，并把**原因**记进日志。

    uvicorn 对「accept 之前关闭」一律记成 ``403``，于是 4401（凭据无效）、
    4403（来源校验失败）和 1011 在访问日志里长得一模一样。缺了这条日志，
    排查「WS 为什么连不上」只能靠猜 —— 那 4200 条 403 就是这么来的：看起来像
    服务端坏了，实际是客户端拿不出有效凭据、还在原地重连。

    只在握手被拒时打点（每秒最多几次），连接正常时不会有任何输出。
    """
    logger.info(
        "WS 握手被拒 %s：code=%s 原因=%s Origin=%s",
        websocket.url.path,
        code,
        reason,
        websocket.headers.get("origin") or "-",
    )
    await websocket.close(code=code, reason=reason)


@router.websocket("/ws/tasks")
async def tasks_websocket(
    websocket: WebSocket,
    token: str = Query(default=""),
    interval: float = Query(default=3.0, ge=1.0, le=30.0),
    limit: int = Query(default=40, ge=1, le=200),
) -> None:
    """Push a live view of recent (and running) tasks to the UI.

    Polls Proxmox on the server side and pushes only when something changed,
    so the browser does not have to poll the task list itself.
    """
    if not security.ws_origin_allowed(websocket):
        await _reject(websocket, 4403, i18n.tr("来源校验失败"))
        return
    try:
        # 浏览器不带查询参数（令牌在 HttpOnly cookie 里），脚本仍可 ?token=
        payload = security.decode_token(security.ws_token(websocket, token))
        # 建连前再确认会话没过期/没被撤销：登出或踢下线后，旧连接不该还能建起来
        await security.ensure_session_active(payload)
    except HTTPException as exc:
        await _reject(websocket, 4401, str(exc.detail))
        return

    role = payload.get("role", "viewer")
    if not security.has_permission(role, "task.view"):
        await _reject(websocket, 4403, i18n.tr("权限不足"))
        return

    client = get_client()
    if not client.conn.configured:
        await _reject(websocket, 1011, i18n.tr("Proxmox 连接未配置"))
        return

    await websocket.accept()

    # 推送流同样要按归属过滤，否则 HTTP 收紧了、WebSocket 还是全量（M-1）
    ws_user: Dict[str, Any] = {
        "username": payload.get("username") or payload.get("sub"),
        "role": role,
    }
    if role == "region_admin":
        # 区域管理员的可见范围在 users.regions 里，JWT 载荷没带，按用户名补一次
        try:
            row = await store.get_user(str(ws_user.get("username") or ""))
        except Exception:  # noqa: BLE001 - 读不到就按无区域处理（一律不可见）
            row = None
        if row:
            ws_user = row
    scope = await build_scope(ws_user)

    # 订阅共享采集：上游只抓一次，归属过滤按本连接的 scope 在 hub 里各做各的。
    # 仍然只推「有变化」的帧（逐帧比较由 hub 按订阅者记录）。
    queue = _task_hub.subscribe(scope, limit)
    try:
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - client went away
        return
    finally:
        # 订阅者都走光后，hub 的采集循环会自行退出（while self._subscribers）
        _task_hub.unsubscribe(queue)


#: 指标广播的采集节奏（秒）。与前端约定的 5 秒一致；订阅者各自的 ``interval``
#: 只影响它自己的读取节奏，不再决定采集频率 —— 采集是全局一份。
METRICS_TICK = 5.0


class _MetricsHub:
    """节点指标：**一条采集循环**，多个 WebSocket 连接共享结果。

    原先每个连接各跑一个 ``while True: client.nodes() → send_json``：开 3 个
    标签页就是 3 路独立轮询、3 份 PVE 请求，而且各自漂移，PVE 那边看到的是
    「同一个面板在同时猛刷」。现在全局一条循环，每 tick 把同一份快照投递给
    所有订阅者。

    每个订阅者一个容量 2 的队列：消费不过来就丢最旧的帧 —— 指标只关心最新值，
    堆积只会让页面上的读数越来越旧。
    """

    def __init__(self) -> None:
        self._subscribers: set = set()
        self._task: Optional[asyncio.Task] = None
        self._last_signature = ""

    def subscribe(self) -> "asyncio.Queue[Dict[str, Any]]":
        queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=2)
        self._subscribers.add(queue)
        self._ensure_task()
        return queue

    def unsubscribe(self, queue: "asyncio.Queue[Dict[str, Any]]") -> None:
        self._subscribers.discard(queue)

    def _ensure_task(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - 非事件循环环境（脚本 / 单测直接调）
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        try:
            while self._subscribers:
                payload = await self._sample()
                self._publish(payload)
                await asyncio.sleep(METRICS_TICK)
        finally:
            self._task = None
            self._last_signature = ""

    @staticmethod
    async def _sample() -> Dict[str, Any]:
        client = get_client()
        try:
            nodes = await client.nodes() or []
        except ProxmoxError as exc:
            return {"type": "error", "message": exc.message}
        return {
            "type": "metrics",
            "ts": int(time.time()),
            "nodes": [
                {
                    "node": n.get("node"),
                    "status": n.get("status"),
                    "cpu": n.get("cpu"),
                    "maxcpu": n.get("maxcpu"),
                    "mem": n.get("mem"),
                    "maxmem": n.get("maxmem"),
                    "loadavg": n.get("loadavg"),
                    "uptime": n.get("uptime"),
                }
                for n in nodes
                if isinstance(n, dict)
            ],
        }

    def _publish(self, payload: Dict[str, Any]) -> None:
        # 指标帧做变更判定：集群空转时（读数不变）不必每秒推一遍相同内容
        if payload.get("type") == "metrics":
            signature = repr(
                [
                    (
                        item.get("node"),
                        item.get("status"),
                        item.get("cpu"),
                        item.get("mem"),
                        item.get("uptime"),
                    )
                    for item in payload.get("nodes") or []
                ]
            )
            if signature == self._last_signature:
                return
            self._last_signature = signature

        for queue in list(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:  # pragma: no cover - 竞态，忽略
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:  # pragma: no cover
                pass


#: 进程级单例（多 worker 部署时每个 worker 各一条，互不共享）
_metrics_hub = _MetricsHub()


#: 任务推送的采集节奏（秒）与单次上游抓取条数。
#:
#: 上游一次抓 ``TASKS_HUB_LIMIT`` 条，各订阅者再按自己的 ``limit`` 截断 ——
#: 上游取「所有订阅者里最大的需求」，只要一次请求就够所有人用。
TASKS_TICK = 3.0
TASKS_HUB_LIMIT = 200


class _TaskHub:
    """任务推送：一条采集循环，按订阅者各自的归属范围过滤后再分发。

    ``/ws/tasks`` 原先每个连接自己 ``client.tasks(limit=…)`` —— 多开几个页面
    就是几路独立的重复抓取。合成单例后上游只抓一次，代价是要为每个订阅者
    保留它自己的 ``scope``：归属过滤**不能**在共享层做，否则一个用户的范围
    会套到别人头上。
    """

    def __init__(self) -> None:
        self._subscribers: Dict[Any, Dict[str, Any]] = {}
        self._task: Optional[asyncio.Task] = None

    def subscribe(self, scope: Any, limit: int) -> "asyncio.Queue[Dict[str, Any]]":
        queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=2)
        self._subscribers[queue] = {"scope": scope, "limit": limit, "signature": ""}
        self._ensure_task()
        return queue

    def unsubscribe(self, queue: Any) -> None:
        self._subscribers.pop(queue, None)

    def _ensure_task(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        try:
            while self._subscribers:
                await self._tick()
                await asyncio.sleep(TASKS_TICK)
        finally:
            self._task = None

    async def _tick(self) -> None:
        client = get_client()
        try:
            tasks = await client.tasks(limit=TASKS_HUB_LIMIT)
            normalized = [normalize_task(t) for t in (tasks or [])]
        except ProxmoxError as exc:
            self._broadcast({"type": "error", "message": exc.message})
            return
        except Exception:  # noqa: BLE001 - 采集失败不该让循环退出
            logger.warning("任务推送采集失败", exc_info=True)
            return

        connection = guestguard.call_connection()
        for queue, state in list(self._subscribers.items()):
            rows = normalized
            scope = state.get("scope")
            if scope is not None:
                # 每个订阅者**各自**过滤：共享层过滤会把一个人的可见范围套给别人
                rows = scope.filter(rows, connection)
            limit = state.get("limit") or TASKS_HUB_LIMIT
            rows = rows[:limit]

            signature = "|".join(
                f"{t['upid']}:{t['status']}:{t.get('exitstatus') or ''}"
                for t in rows
            )
            if signature == state.get("signature"):
                continue
            state["signature"] = signature
            self._offer(
                queue,
                {
                    "type": "tasks",
                    "tasks": rows,
                    "running": sum(1 for t in rows if t["running"]),
                },
            )

    def _broadcast(self, payload: Dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            self._offer(queue, payload)

    @staticmethod
    def _offer(queue: Any, payload: Dict[str, Any]) -> None:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover
                pass
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:  # pragma: no cover
            pass


_task_hub = _TaskHub()


@router.websocket("/ws/metrics")
async def metrics_websocket(
    websocket: WebSocket,
    token: str = Query(default=""),
    interval: float = Query(default=5.0, ge=2.0, le=30.0),
) -> None:
    """Push live node metrics so the UI does not have to poll each page.

    监控页各自 5 秒轮询一次 rrddata / status，浏览器开着几个页面就是几路
    独立的轮询。集中到这里轮询一次、广播给所有连接，天然去重。

    采集由模块级 :class:`_MetricsHub` 单例负责（一条循环、多路投递）；
    ``interval`` 参数仅为兼容旧前端保留，不再影响采集频率。
    """
    if not security.ws_origin_allowed(websocket):
        await _reject(websocket, 4403, i18n.tr("来源校验失败"))
        return
    try:
        payload = security.decode_token(security.ws_token(websocket, token))
        await security.ensure_session_active(payload)
    except HTTPException as exc:
        await _reject(websocket, 4401, str(exc.detail))
        return

    role = payload.get("role", "viewer")
    if not security.has_permission(role, "node.view"):
        await _reject(websocket, 4403, i18n.tr("权限不足"))
        return

    client = get_client()
    if not client.conn.configured:
        await _reject(websocket, 1011, i18n.tr("Proxmox 连接未配置"))
        return

    await websocket.accept()
    # 订阅广播中心：一条采集循环打 PVE，所有标签页各收一份。原先每个连接
    # 自己轮询，开 5 个标签页就是 5 路独立的 /nodes 请求，PVE 那边看到的是
    # 「同一个面板在猛刷」。
    queue = _metrics_hub.subscribe()
    try:
        while True:
            payload = await queue.get()
            await websocket.send_json(payload)
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - client went away
        return
    finally:
        _metrics_hub.unsubscribe(queue)
