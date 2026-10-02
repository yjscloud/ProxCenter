"""监控历史查询接口。

与 ``/ws/metrics`` 组成「实时 + 历史」两条通道：

* ``/ws/metrics``（见 :mod:`app.routers.tasks`）——**实时**：进程内广播，5s 一帧，
  不落库，供页面上的即时曲线；
* 本模块 ``/api/metrics/history`` ——**历史**：读落库的 ``metrics_history``，
  支持任意区间与降采样，供区间回看、周月报与容量趋势。

两条通道的数据源是同一份 PVE ``cluster_resources``，口径一致，拼起来不会有台阶。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import i18n, metrics, ownership, security

router = APIRouter(prefix="/api", tags=["metrics"])

# 历史接口一次最多回溯多少小时：保留期 30 天，给到 90 天是留出「改大了保留期
# 也能查」的余量，超出的区间由降采样兜住，不会因此变慢。
MAX_HOURS = 24 * 90


@router.get("/metrics/history")
async def read_metrics_history(
    scope: str = Query(default=metrics.SCOPE_NODE, pattern="^(node|guest)$"),
    node: Optional[str] = Query(default=None, description="只看某个节点"),
    vmid: Optional[int] = Query(default=None, ge=1, description="只看某台虚拟机/容器"),
    hours: int = Query(default=6, ge=1, le=MAX_HOURS),
    start: Optional[int] = Query(default=None, ge=0, description="起始 Unix 秒，优先于 hours"),
    end: Optional[int] = Query(default=None, ge=0, description="结束 Unix 秒，默认现在"),
    step: Optional[int] = Query(
        default=None, ge=60, le=86_400, description="降采样步长（秒），默认按区间自动选"
    ),
    max_series: int = Query(default=metrics.DEFAULT_MAX_SERIES, ge=1, le=200),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """按区间查历史指标。

    作用域与权限一一对应：``node`` 要 ``node.view``，``guest`` 要 ``vm.view``。
    非管理员在 ``guest`` 作用域下只会拿到自己名下的机器 —— 历史数据和实时列表
    走同一套归属隔离，否则「列表里看不见、历史里查得到」就成了绕过隔离的后门。
    """
    required = "node.view" if scope == metrics.SCOPE_NODE else "vm.view"
    if not security.has_user_permission(user, required):
        raise HTTPException(
            status_code=403,
            detail=i18n.t(
                "error.permission_denied_role",
                permission=required,
                role=user.get("role"),
            ),
        )

    now = int(time.time())
    end_ts = int(end) if end else now
    start_ts = int(start) if start else end_ts - hours * 3600
    if start_ts >= end_ts:
        raise HTTPException(
            status_code=400, detail=i18n.tr("起始时间必须早于结束时间")
        )

    owned_refs: Optional[List[str]] = None
    if scope == metrics.SCOPE_GUEST:
        owner = security.visible_owner(user)
        if owner is not None:
            owned_refs = await ownership.list_owned(ownership.KIND_VM, owner)

    result = await metrics.query(
        scope=scope,
        start=start_ts,
        end=end_ts,
        step=metrics.pick_step(end_ts - start_ts, step),
        node=node,
        vmid=vmid,
        owned_refs=owned_refs,
        max_series=max_series,
    )
    result["node"] = node
    result["vmid"] = vmid
    return result


@router.get("/metrics/coverage")
async def read_metrics_coverage(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """历史覆盖情况：保留期、采样周期与最早/最晚采样时间。

    界面用它区分「没有数据」和「这段时间确实很闲」—— 两者在曲线上都是空白。
    """
    return await metrics.coverage()
