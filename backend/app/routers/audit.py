"""Audit log endpoints."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, Request

from .. import security, store

router = APIRouter(prefix="/api", tags=["audit"])

# 落库的 result 取值（见 security.audit 的各个调用点）。
# 这里必须与写入侧对齐：以前只放行 success/failed/partial，而界面的筛选项发的是
# failure/denied —— 一选「失败」就直接 422，等于这两个筛选项从来没用过。
AUDIT_RESULTS = ("success", "failed", "partial", "denied", "accepted")


@router.get("/audit")
async def list_audit(
    request: Request,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    username: Optional[str] = None,
    action: Optional[str] = None,
    result: Optional[str] = Query(
        default=None, pattern="^(" + "|".join(AUDIT_RESULTS) + ")$"
    ),
    start: Optional[float] = Query(default=None, description="起始 Unix 秒"),
    end: Optional[float] = Query(default=None, description="结束 Unix 秒"),
    search: Optional[str] = Query(default=None, description="关键词（动作/目标/详情/用户/IP）"),
    user: Dict[str, Any] = Depends(security.require_permission("audit.view")),
) -> Dict[str, Any]:
    # 看审计日志本身也是敏感读取：翻日志往往是为了掩盖痕迹
    await security.audit_read(
        request,
        user,
        "audit.read",
        detail=(
            f"limit={limit} offset={offset} username={username or '-'}"
            f" start={start or '-'} end={end or '-'} search={search or '-'}"
        ),
    )
    entries = await store.list_audit(
        limit=limit,
        offset=offset,
        username=username,
        action=action,
        result=result,
        start=start,
        end=end,
        search=search,
    )

    return {
        "items": [
            {
                "id": item["id"],
                "timestamp": item["timestamp"],
                "username": item["username"],
                "action": item["action"],
                "target": item["target"] or "",
                "result": item["result"],
                "detail": item["detail"] or "",
                "ip": item["ip"] or "",
            }
            for item in entries["items"]
        ],
        "total": entries["total"],
        "limit": limit,
        "offset": offset,
    }


@router.get("/audit/actions")
async def list_actions(
    user: Dict[str, Any] = Depends(security.require_permission("audit.view")),
) -> Dict[str, Any]:
    """Distinct action names, for populating the filter dropdown."""
    entries = await store.list_audit(limit=1000)
    actions = sorted({item["action"] for item in entries["items"]})
    users = sorted({item["username"] for item in entries["items"]})
    return {"actions": actions, "users": users}
