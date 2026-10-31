"""Audit log endpoints.

**可见范围**：管理员看全部，其余用户（哪怕被授予 ``audit.view``）只看自己的
操作记录。审计日志里带着每个人的动作、目标与来源 IP，放开全量等于把「谁在
什么时候动了哪台机器」交给所有拿到这个权限的人；而按人开放这个权限的本意
恰恰是「让用户查自己的操作」。隔离在服务端完成 —— 前端隐藏筛选框只是体验，
``?username=别人的名字`` 一样会被拒绝。
"""
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
    before_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="键集分页：传上一页最后一条的 id，忽略 offset（深翻页不再全表扫）",
    ),
    user: Dict[str, Any] = Depends(security.require_permission("audit.view")),
) -> Dict[str, Any]:
    # 用户隔离放在过滤之前：普通用户拿不到别人的记录，越权索取直接 403
    username = security.scoped_username(user, username)

    # 看审计日志本身也是敏感读取：翻日志往往是为了掩盖痕迹
    await security.audit_read(
        request,
        user,
        "audit.read",
        detail=(
            f"limit={limit} offset={offset} before_id={before_id or '-'}"
            f" username={username or '-'}"
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
        before_id=before_id,
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
        # 键集模式下不数总数（total 为 None）：省掉那趟全表 COUNT
        "total": entries["total"],
        "limit": limit,
        "offset": offset,
        "next_before_id": (
            entries["items"][-1]["id"] if entries["items"] else None
        ),
        # 前端据此提示「当前只显示自己的日志」；也方便调用方自检隔离是否生效
        "scope": "all" if security.visible_owner(user) is None else "own",
    }


@router.get("/audit/actions")
async def list_actions(
    user: Dict[str, Any] = Depends(security.require_permission("audit.view")),
) -> Dict[str, Any]:
    """动作 / 用户名清单，用于填充筛选下拉（同样按可见范围裁剪）。"""
    scope = security.visible_owner(user)
    if scope == "":
        # 解析不出用户名时不能退化成「不加 username 条件」——那等于返回全量
        return {"actions": [], "users": []}

    # DISTINCT 直查（60 秒缓存）：原来拉 1000 行审计再在 Python 里去重，
    # 行数一多就既慢又不准（超出 1000 行的动作根本不会出现在下拉里）。
    actions, users = await store.audit_facets(scope or None)
    return {"actions": actions, "users": [scope] if scope else users}
