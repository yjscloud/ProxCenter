"""安全基线检查与加固接口（全平台：本机 + SSH 受管主机）。

* ``GET  /api/baseline/targets``      —— 可体检的主机清单（选择器用，不触发体检）
* ``GET  /api/baseline/fleet``        —— 全平台总览（并发体检，只回摘要）
* ``GET  /api/baseline/hosts/{id}``   —— 单台主机详情
* ``GET  /api/baseline/report``       —— 本机详情（向后兼容的快捷方式）
* ``POST /api/baseline/fix``          —— 单台主机的单项加固
* ``POST /api/baseline/fix-all``      —— 单台主机的批量加固

体检是只读的，但要 ``baseline.view``；加固改的是**服务器本身的**安全配置，
因此要 ``baseline.manage`` 并走二次确认（step-up），全部读写都进审计日志。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import baseline, hostscope, reportcache, security
from ..schemas import BaselineFixAllIn, BaselineFixIn

router = APIRouter(prefix="/api/baseline", tags=["baseline"])

VIEW = security.require_permission("baseline.view")
MANAGE = security.require_permission("baseline.manage")


@router.get("/targets")
async def targets(
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """可体检的主机清单（本机 + 启用的受管主机）。不触发任何体检。

    管理员含本机；普通用户只列自己添加的受管主机（不含本机）。
    """
    return {"hosts": await baseline.targets(await hostscope.allowed_host_ids(user))}


@router.get("/fleet")
async def fleet(
    request: Request,
    refresh: bool = False,
    stale: bool = False,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """全平台总览：并发体检可见主机，每台只回摘要（最需要处理的排最前）。

    一轮体检要 SSH 到每台主机（单条最坏 45 秒超时），所以结果进一层按可见
    主机集合分键的短 TTL 缓存：同一时刻的重复打开只跑一轮。``refresh=1``
    绕过缓存 —— 页面上的「重新体检」走的就是这条路。缓存理由与边界见
    :mod:`app.reportcache`。

    ``stale=1``：有旧值就先返回、真扫放到后台，别让人为一份概览干等一轮。
    首页工作台只用得上「有没有不合格项」一句；报告页这一屏也是同样的取舍 ——
    它展示的是每台主机的一行摘要，不是要据此动手改配置。上限是
    :data:`reportcache.STALE_MAX_AGE`（15 分钟）：更旧的旧值不端出来，老实等一轮。
    """
    allowed = await hostscope.allowed_host_ids(user)
    key = reportcache.scope_key("baseline", allowed)

    if refresh:
        payload = await baseline.fleet_overview(allowed)
        reportcache.store(key, payload)
        cached = False
    elif stale:
        # 只用 peek_stale：peek() 遇到过期条目会**顺手删掉**，写成
        # ``peek(key) or peek_stale(key)`` 的话，过期的那一刻反而什么都拿不到、
        # 退化成同步等一轮 —— 正是这条通路要避免的。
        payload = reportcache.peek_stale(key, reportcache.STALE_MAX_AGE)
        if payload is None:
            # 一条都没有（进程刚起来）：只能老实等一轮，待办区届时会补上
            payload, cached = await reportcache.get_or_scan(
                key, lambda: baseline.fleet_overview(allowed)
            )
        else:
            cached = True
            reportcache.refresh_later(key, lambda: baseline.fleet_overview(allowed))
    else:
        payload, cached = await reportcache.get_or_scan(
            key, lambda: baseline.fleet_overview(allowed)
        )

    totals = payload["totals"]
    await security.audit_read(
        request,
        user,
        "baseline.fleet_read",
        target="fleet",
        detail=(
            f"{totals['hosts']} 台主机（可达 {totals['reachable']}），"
            f"不合格 {totals['fail']} 项"
            + ("（缓存结果）" if cached else "")
        ),
    )
    return payload


async def _host_report(
    host_id: str,
    request: Request,
    user: Dict[str, Any],
    refresh: bool = False,
) -> Dict[str, Any]:
    """单台主机的完整体检报告（带一层短 TTL 缓存）。

    单机报告也要现场 SSH（最坏 45 秒），而「在几台主机之间来回看」正是这一页的
    常见用法 —— 每次点回去都重跑一条 SSH 纯属浪费。这里放进与总览同一层缓存：
    TTL 内直接命中，过期了才真扫一轮。

    刻意**不走 stale 通路**：总览用旧值换响应速度是划算的（它是一屏摘要），
    而单机详情是用户已经点进来要看的报告，端一份过时的基线结论出来，比多等
    几秒更糟。

    ``refresh`` 是给页面上的「扫描」按钮用的：它必须真跑一遍，缓存这一层对它
    是透明的 —— 不绕过的话按钮转一圈，拿回来的还是 TTL 内那份旧报告。
    """
    key = reportcache.scope_key("baseline:host", [host_id])
    try:
        if refresh:
            payload = await baseline.collect_host(host_id)
            reportcache.store(key, payload)
        else:
            payload, _cached = await reportcache.get_or_scan(
                key, lambda: baseline.collect_host(host_id)
            )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await security.audit_read(
        request,
        user,
        "baseline.read",
        target=str(payload.get("host") or host_id),
        detail=f"评分 {payload.get('score')}（{payload.get('grade') or '未体检'}）",
    )
    return payload


@router.get("/hosts/{host_id}", dependencies=[Depends(hostscope.require_host_access)])
async def host_report(
    host_id: str,
    request: Request,
    refresh: bool = False,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """单台主机的完整体检报告（``host_id`` 为 ``local`` 或受管主机 id）。

    ``refresh=1`` 绕过报告缓存强制重扫 —— 页面上的「扫描」按钮走这条。
    """
    return await _host_report(host_id, request, user, refresh)


@router.get("/report", dependencies=[Depends(hostscope.require_local_admin)])
async def report(
    request: Request,
    refresh: bool = False,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """本机（面板所在主机）的完整体检报告。"""
    return await _host_report("local", request, user, refresh)


@router.post("/fix")
async def fix(
    payload: BaselineFixIn,
    request: Request,
    user: Dict[str, Any] = Depends(MANAGE),
    # 改的是服务器的 SSH / 内核 / 口令策略：即便 token 还在有效期内也要二次确认
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """单项加固（写面板托管文件并校验生效，失败自动回滚）。"""
    host_id = payload.host_id or "local"
    # host_id 在请求体里（不是路径/查询参数），路由依赖取不到，只能在这里校验
    await hostscope.assert_host_access(user, host_id)
    try:
        result = await baseline.apply_fix(payload.key, host_id)
    except baseline.FixError as exc:
        await security.audit(
            request,
            user,
            "baseline.fix",
            target=f"{host_id}/{payload.key}",
            result="failed",
            detail=str(exc)[:500],
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 这台机器的配置变了，缓存里的体检报告已经过时（旧分数会一直挂到 TTL 到期）
    reportcache.clear()
    await security.audit(
        request,
        user,
        "baseline.fix",
        target=f"{host_id}/{payload.key}",
        result="success",
        detail=str(result.get("detail") or "")[:500],
    )
    return {"key": payload.key, "host_id": host_id, **result}


@router.post("/fix-all")
async def fix_all(
    payload: BaselineFixAllIn,
    request: Request,
    user: Dict[str, Any] = Depends(MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """批量加固。``keys`` 为空时自动挑出「不合格 / 待改进且可修复」的项。

    逐项执行、逐项回报：某一项失败（权限不足、远端不可达）不影响其它项。
    """
    host_id = payload.host_id or "local"
    await hostscope.assert_host_access(user, host_id)
    keys = [key for key in (payload.keys or []) if key] or None
    result = await baseline.apply_fixes(keys, host_id)
    # 改成功了几项就足以让缓存里的报告过时（哪怕有失败项，成功的那几项也算数）
    if result["fixed"]:
        reportcache.clear()
    await security.audit(
        request,
        user,
        "baseline.fix_all",
        target=host_id,
        result="success" if not result["failed"] else "failed",
        detail=f"成功 {result['fixed']} 项，失败 {result['failed']} 项",
    )
    return {"host_id": host_id, **result}
