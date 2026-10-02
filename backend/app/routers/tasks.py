"""Proxmox task queue endpoints."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from .. import i18n, security

logger = logging.getLogger(__name__)
from ..formatters import normalize_task
from ..pve import ProxmoxError, get_client, node_from_upid
from ..vm_scope import bind_task_connection

# 注意：这里的定位依赖只加在 HTTP 任务接口上，不能用路由级依赖 ——
# 本路由还挂着 /ws/tasks（用 query token 自行鉴权），路由级依赖会要求
# Authorization 头，直接把 WebSocket 握手拒掉。
router = APIRouter(prefix="/api", tags=["tasks"])


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


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
    return output


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


@router.get("/tasks/{upid}/log")
async def get_task_log(
    upid: str,
    node: Optional[str] = None,
    start: int = 0,
    limit: int = Query(default=500, ge=1, le=5000),
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
) -> List[Dict[str, Any]]:
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

    last_signature = ""
    try:
        while True:
            try:
                tasks = await client.tasks(limit=limit)
                normalized = [normalize_task(t) for t in (tasks or [])]
            except ProxmoxError as exc:
                await websocket.send_json(
                    {"type": "error", "message": exc.message}
                )
                await asyncio.sleep(interval)
                continue

            # Only transmit when the state actually changed.
            signature = "|".join(
                f"{t['upid']}:{t['status']}:{t.get('exitstatus') or ''}"
                for t in normalized
            )
            if signature != last_signature:
                last_signature = signature
                await websocket.send_json(
                    {
                        "type": "tasks",
                        "tasks": normalized,
                        "running": sum(1 for t in normalized if t["running"]),
                    }
                )

            await asyncio.sleep(interval)
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - client went away
        return


@router.websocket("/ws/metrics")
async def metrics_websocket(
    websocket: WebSocket,
    token: str = Query(default=""),
    interval: float = Query(default=5.0, ge=2.0, le=30.0),
) -> None:
    """Push live node metrics so the UI does not have to poll each page.

    监控页各自 5 秒轮询一次 rrddata / status，浏览器开着几个页面就是几路
    独立的轮询。集中到这里轮询一次、广播给所有连接，天然去重。
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
    try:
        while True:
            try:
                nodes = await client.nodes() or []
                await websocket.send_json(
                    {
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
                )
            except ProxmoxError as exc:
                await websocket.send_json({"type": "error", "message": exc.message})
            await asyncio.sleep(interval)
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - client went away
        return
