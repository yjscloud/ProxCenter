"""端口 / 进程异常检测接口（全平台服务器）。

* ``GET  /api/ports/hosts``            —— 可巡检的主机清单
* ``GET  /api/ports/overview``         —— 全平台总览（并发巡检，只回摘要）
* ``GET  /api/ports/hosts/{host_id}``  —— 单机详情（端口表 + 可疑进程）
* ``GET  /api/ports/policy``           —— 巡检策略（预期端口、进程白名单）
* ``PUT  /api/ports/policy``           —— 保存策略
* ``GET  /api/ports/dispositions``     —— 某台主机的人工处置记录（确认 / 忽略 / 加白）
* ``POST /api/ports/dispositions``     —— 对一条发现做处置
* ``DELETE /api/ports/dispositions``   —— 撤销处置
* ``POST /api/ports/check``            —— 立即巡检并推送告警

巡检本身是只读的（``ports.view``）；策略与「立即检测」会触发通知，要
``ports.manage``。所有读与写都进审计日志。
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import baseline, hostscope, inspection, portguard, reportcache, security
from ..schemas import PortDispositionIn, PortPolicyIn

router = APIRouter(prefix="/api/ports", tags=["ports"])

VIEW = security.require_permission("ports.view")
MANAGE = security.require_permission("ports.manage")


@router.get("/hosts")
async def hosts(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """可巡检的主机清单（本机 + 启用的受管主机）。不触发巡检。

    管理员含本机；普通用户只列自己添加的受管主机（不含本机）。
    """
    return {"hosts": await baseline.targets(await hostscope.allowed_host_ids(user))}


@router.get("/overview")
async def overview(
    request: Request,
    refresh: bool = False,
    stale: bool = False,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """全平台总览：并发巡检可见主机，每台只回摘要（最需要看的排最前）。

    一轮巡检要 SSH 到每台主机（单条最坏 45 秒超时），所以结果进一层按可见
    主机集合分键的短 TTL 缓存：同一时刻的重复打开（来回切页面、开两个标签、
    几个人同时看）只跑一轮。``refresh=1`` 绕过缓存 —— 页面上的「重新巡检」
    走的就是这条路。缓存理由与边界见 :mod:`app.reportcache`。

    ``stale=1``：有旧值就先返回、真扫放到后台。这一屏是每台主机一行摘要，
    为它干等一轮不值得；旧值的年龄上限见 :data:`reportcache.STALE_MAX_AGE`，
    超出就老实等一轮（与安全基线页同一条通路）。
    """
    allowed = await hostscope.allowed_host_ids(user)
    key = reportcache.scope_key("ports", allowed)

    def _scan() -> Any:
        # 真扫 + 落库 + 聚合：读接口与后台刷新共用同一条入口（见 app.inspection）
        return inspection.scan_fleet("ports", allowed)

    if refresh:
        payload = await _scan()
        reportcache.store(key, payload)
        cached = False
    elif stale:
        # 只用 peek_stale：peek() 碰到过期条目会**顺手删掉**，写成
        # ``peek(key) or peek_stale(key)`` 反而会在过期那一刻退化成同步等一轮
        payload = reportcache.peek_stale(key, reportcache.STALE_MAX_AGE)
        if payload is None:
            # 内存没有 → 读落库快照（后台预热的成果）；一条都没有才真扫
            payload, cached = await reportcache.get_snapshot_or_scan(
                key, "ports", allowed, _scan
            )
        else:
            cached = True
            reportcache.refresh_later(key, _scan)
    else:
        payload, cached = await reportcache.get_snapshot_or_scan(
            key, "ports", allowed, _scan
        )

    totals = payload["totals"]
    await security.audit_read(
        request,
        user,
        "ports.overview_read",
        target="fleet",
        detail=(
            f"{totals['hosts']} 台主机，可疑进程 {totals['suspicious']} 个，"
            f"非预期开放端口 {totals['unexpected']} 个"
            + ("（缓存结果）" if cached else "")
        ),
    )
    return payload


@router.post("/overview/stream")
async def overview_stream(
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> StreamingResponse:
    """流式巡检（SSE）：每台一完成就推一条事件，页面边到边渲染。

    与 ``GET /overview`` 的关系同安全基线：跑完照样落库，所以下次打开读快照。
    """
    allowed = await hostscope.allowed_host_ids(user)
    await security.audit_read(
        request, user, "ports.overview_read", target="fleet", detail="流式巡检"
    )

    async def gen() -> AsyncIterator[str]:
        async for event in inspection.stream_fleet("ports", allowed):
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # 面板前面有 nginx：不关缓冲的话事件会被攒着一起发，流式就没意义了
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history")
async def history(
    host_id: str = "",
    days: int = 30,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """巡检趋势（按小时桶）。

    ``host_id`` 留空 = 全平台趋势；普通用户只统计自己可见的主机。
    """
    allowed = await hostscope.allowed_host_ids(user)
    if host_id and allowed is not None and str(host_id) not in allowed:
        raise HTTPException(status_code=404, detail="主机不存在或无权访问")
    return await inspection.history(
        "ports",
        host_id=host_id or None,
        host_ids=allowed,
        days=max(1, min(int(days), 365)),
    )


@router.get("/policy")
async def get_policy(
    _user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    return {"policy": await portguard.load_policy()}


@router.put("/policy")
async def put_policy(
    payload: PortPolicyIn,
    request: Request,
    user: Dict[str, Any] = Depends(MANAGE),
) -> Dict[str, Any]:
    """保存巡检策略。预期端口与进程白名单是压掉误报的主要手段。"""
    policy = await portguard.save_policy(payload.model_dump())
    # 判定口径变了：缓存与落库快照里的报告已经不对，下一次必须真巡检
    await reportcache.clear()
    await security.audit(
        request,
        user,
        "ports.policy_update",
        target="ports",
        detail=(
            f"预期端口 {len(policy['expected_ports'])} 条，"
            f"进程白名单 {len(policy['process_whitelist'])} 条"
        ),
    )
    return {"policy": policy}


@router.get("/hosts/{host_id}", dependencies=[Depends(hostscope.require_host_access)])
async def host_detail(
    host_id: str,
    request: Request,
    refresh: bool = False,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """单台主机的巡检详情（``host_id`` 为 ``local`` 或受管主机 id）。

    同样走一层短 TTL 缓存：一次详情要 SSH 到那台机器跑一趟探测（最坏 45 秒），
    而「几台主机来回看」正是这里的常见用法。理由与安全基线的单机报告一致
    （见 ``routers/baseline._host_report``）：刻意不接 stale 通路 —— 用户已经
    点进来看了，端一份过时的端口/进程清单出来比多等几秒更糟。

    ``refresh=1`` 绕过缓存强制重巡检 —— 页面上的「巡检」按钮走这条。
    """
    key = reportcache.scope_key("ports:host", [host_id])

    async def _collect() -> Dict[str, Any]:
        # 单机真扫 + 落库：与总览共用同一张快照表，下次直接读快照
        report = await portguard.collect_host(host_id)
        await inspection.persist_reports("ports", [report])
        return report

    try:
        if refresh:
            payload = await _collect()
            reportcache.store(key, payload)
        else:
            payload = reportcache.peek(key)
            if payload is None:
                # 内存没有 → 读这台机器的落库快照；没有才真扫（首次 / 刚清过）
                snapshot = await inspection.load_host_report("ports", host_id)
                if snapshot is not None:
                    payload = snapshot
                    reportcache.refresh_later(key, _collect)
                else:
                    payload = await _collect()
                    reportcache.store(key, payload)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    summary = payload.get("summary") or {}
    await security.audit_read(
        request,
        user,
        "ports.read",
        target=str(payload.get("host") or host_id),
        detail=(
            f"监听 {summary.get('listeners', 0)} 个，"
            f"非预期开放 {summary.get('unexpected', 0)} 个，"
            f"可疑进程 {summary.get('suspicious', 0)} 个"
        ),
    )
    return payload


@router.get("/dispositions")
async def list_dispositions(
    host_id: str = "local",
    _user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """某台主机的人工处置记录（已确认 / 已忽略 / 已加白）。

    页面用它把「处置过的条目」列出来并允许撤销 —— 处置不是删除，人得能反悔。
    """
    scoped = (await portguard.load_dispositions()).get(host_id) or {}
    return {
        "host_id": host_id,
        "items": [
            {"fingerprint": key, **value} for key, value in sorted(scoped.items())
        ],
    }


@router.post("/dispositions")
async def add_disposition(
    payload: PortDispositionIn,
    request: Request,
    user: Dict[str, Any] = Depends(MANAGE),
) -> Dict[str, Any]:
    """对一条发现做处置：确认 / 忽略 / 加白。

    三种处置的区别（页面上也要这么写清楚）：
      * 确认：已知晓，不再计入待处理与告警，列表里仍可见、可撤销；
      * 忽略：一段时间内不再提示，到期自动回到待处理；
      * 加白：永久放行，规则会写进巡检策略（预期端口 / 进程白名单）。
    """
    try:
        result = await portguard.apply_disposition(
            host_id=payload.host_id or "local",
            key=payload.fingerprint,
            action=payload.action,
            actor=str(user.get("username") or ""),
            note=payload.note,
            ttl_days=payload.ttl_days,
            detail=payload.detail,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 处置会改「待处理」的口径（加白还会写进策略），缓存与快照里的报告不再准确
    await reportcache.clear()
    label = {
        "ack": "已确认",
        "ignore": "已忽略",
        "whitelist": "已加白",
    }.get(result["record"]["action"], result["record"]["action"])
    await security.audit(
        request,
        user,
        "ports.disposition",
        target=f"{payload.host_id}:{payload.fingerprint}",
        detail=f"{label}"
        + (f"：{payload.note}" if payload.note else "")
        + (
            f"（{payload.ttl_days} 天后重新提示）"
            if result["record"]["action"] == "ignore" and payload.ttl_days
            else ""
        ),
    )
    return result


@router.delete("/dispositions")
async def remove_disposition(
    request: Request,
    host_id: str = "local",
    fingerprint: str = "",
    user: Dict[str, Any] = Depends(MANAGE),
) -> Dict[str, Any]:
    """撤销一条处置：下一轮巡检它就会重新出现在待处理里。"""
    if not fingerprint:
        raise HTTPException(status_code=400, detail="缺少 fingerprint")
    removed = await portguard.clear_disposition(host_id, fingerprint)
    if not removed:
        raise HTTPException(status_code=404, detail="这条处置不存在或已过期")
    # 撤销后这条发现重新计入待处理，缓存与快照里的报告不再准确
    await reportcache.clear()
    await security.audit(
        request,
        user,
        "ports.disposition_clear",
        target=f"{host_id}:{fingerprint}",
        detail="撤销处置，重新纳入巡检",
    )
    return {"deleted": True}


@router.post("/check")
async def check_now(
    request: Request,
    user: Dict[str, Any] = Depends(MANAGE),
) -> Dict[str, Any]:
    """立即巡检并推送告警（等价于定时任务跑一次，用于验证通知是否通）。"""
    fired = await portguard.evaluate()
    await security.audit(
        request,
        user,
        "ports.check",
        target="ports",
        detail=f"本次触发 {len(fired)} 条告警/恢复通知",
    )
    return {"fired": len(fired), "items": fired[:20]}
