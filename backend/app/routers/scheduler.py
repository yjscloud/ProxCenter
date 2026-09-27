"""后台作业状态与配置接口（前端「后台任务」页）。

为什么需要一个接口
------------------
改造前后台巡检是四个裸 ``while True`` 循环，异常被 ``logger.exception`` 吞掉之后
界面上完全看不出来「这个巡检是不是从上周就挂了」。这里把每个作业的运行状态
（上次执行时间、耗时、成败、错误信息、下次执行时间、累计失败次数）暴露出来，
并允许改间隔 / 启停 / 立即执行一次。

权限
----
全部要求 ``settings.manage``：这些作业会去 SSH 各处主机、调 PVE、发通知，
它们的错误信息里可能带主机名与路径，属于运维内部视图，不该给普通用户看。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import scheduler, security

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])


class JobPatch(BaseModel):
    """改间隔 / 启停。两个字段都可选，只改传进来的那个。

    ``interval`` 不设上限校验：越界交给调度器按 MIN/MAX 夹取，这样接口层的
    错误信息与「配置被恢复到合法值」的最终结果一致，不会出现两处各说一套。
    """

    interval: Optional[int] = Field(default=None, ge=1)
    enabled: Optional[bool] = None


@router.get("")
async def list_jobs(
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """全部后台作业及其运行状态。

    顺带给出汇总（总数 / 正在跑 / 处于失败态 / 疑似停摆），页头一行提示就能
    回答「后台是不是健康的」，不必逐个作业看过去。
    """
    jobs: List[Dict[str, Any]] = scheduler.snapshot()
    return {
        "jobs": jobs,
        "tick": scheduler.TICK,
        "total": len(jobs),
        "enabled": sum(1 for job in jobs if job["enabled"]),
        "running": sum(1 for job in jobs if job["running"]),
        # 最近一次执行以失败收场 —— 这是最该被看见的状态
        "failing": sum(1 for job in jobs if job["last_status"] == "error"),
        # 一次都没跑起来过（不是「刚启动」就是真的没跑起来，界面自己判断时间）
        "never_run": sum(1 for job in jobs if job["last_status"] == "never"),
    }


@router.put("/{job_id}")
async def configure_job(
    job_id: str,
    payload: JobPatch,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """改间隔 / 启停。改完立刻重算下次唤醒时刻，不必等旧间隔到期。"""
    if not scheduler.is_registered(job_id):
        raise HTTPException(status_code=404, detail=f"作业 {job_id} 不存在")
    if payload.interval is None and payload.enabled is None:
        raise HTTPException(status_code=400, detail="没有需要修改的字段")

    before = next(
        (job for job in scheduler.snapshot() if job["id"] == job_id), {}
    )
    updated = await scheduler.configure(
        job_id, interval=payload.interval, enabled=payload.enabled
    )
    await security.audit(
        request,
        user,
        "scheduler.configure",
        target=f"job/{job_id}",
        detail={
            "interval_before": before.get("interval"),
            "interval_after": updated["interval"],
            "enabled_before": before.get("enabled"),
            "enabled_after": updated["enabled"],
        },
    )
    return updated


@router.post("/{job_id}/run")
async def run_job_now(
    job_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """立即执行一次，**同步等待结果**。

    同步而不是丢进队列：这个按钮的用途就是「改完配置点一下，看它到底报什么错」，
    异步返回一个「已触发」等于把错误藏回日志里。作业本身都是秒级到十几秒级的
    巡检，等一下是可以接受的。
    """
    if not scheduler.is_registered(job_id):
        raise HTTPException(status_code=404, detail=f"作业 {job_id} 不存在")

    try:
        result = await scheduler.trigger(job_id)
    except RuntimeError as exc:
        # 正在跑：直接告诉调用方，而不是排队等它跑完再跑一遍
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "scheduler.run",
        target=f"job/{job_id}",
        result="success" if result["last_status"] == "ok" else "failed",
        detail={
            "duration_ms": result["last_duration_ms"],
            "summary": result["last_summary"],
        },
    )
    return result


@router.post("/{job_id}/reset")
async def reset_job(
    job_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """恢复该作业的代码默认间隔与启用状态。"""
    if not scheduler.is_registered(job_id):
        raise HTTPException(status_code=404, detail=f"作业 {job_id} 不存在")

    updated = await scheduler.reset(job_id)
    await security.audit(
        request, user, "scheduler.reset", target=f"job/{job_id}"
    )
    return updated
