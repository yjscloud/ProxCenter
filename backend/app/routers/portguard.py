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

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import baseline, hostscope, portguard, reportcache, security
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

    if refresh:
        payload = await portguard.fleet_overview(allowed)
        reportcache.store(key, payload)
        cached = False
    elif stale:
        # 只用 peek_stale：peek() 碰到过期条目会**顺手删掉**，写成
        # ``peek(key) or peek_stale(key)`` 反而会在过期那一刻退化成同步等一轮
        payload = reportcache.peek_stale(key, reportcache.STALE_MAX_AGE)
        if payload is None:
            payload, cached = await reportcache.get_or_scan(
                key, lambda: portguard.fleet_overview(allowed)
            )
        else:
            cached = True
            reportcache.refresh_later(key, lambda: portguard.fleet_overview(allowed))
    else:
        payload, cached = await reportcache.get_or_scan(
            key, lambda: portguard.fleet_overview(allowed)
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
    # 判定口径变了：缓存里的报告已经不对，下一次必须真巡检
    reportcache.clear()
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
    try:
        if refresh:
            payload = await portguard.collect_host(host_id)
            reportcache.store(key, payload)
        else:
            payload, _cached = await reportcache.get_or_scan(
                key, lambda: portguard.collect_host(host_id)
            )
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

    # 处置会改「待处理」的口径（加白还会写进策略），缓存里的报告不再准确
    reportcache.clear()
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
    # 撤销后这条发现重新计入待处理，缓存里的报告不再准确
    reportcache.clear()
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
