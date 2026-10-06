"""站内通知接口：顶部铃铛的列表、未读数与已读标记。

每个用户只能看到并操作自己的消息 —— 归属条件是接口自己拼进 SQL 的（见
:mod:`app.notifications` 里各函数），不依赖调用方传入，避免出现「改一个 id
就能读别人的消息」这种越权。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import notifications, security

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class MarkReadRequest(BaseModel):
    """标记已读。``ids`` 为空且 ``all=true`` 时清空全部未读。"""

    ids: List[int] = Field(default_factory=list)
    all: bool = False


def _own(user: Dict[str, Any]) -> str:
    """当前登录者的用户名 —— 消息归属的**唯一**来源。

    前端不传、也不允许传用户名：一旦「操作谁的消息」成了请求参数，越权就只是改
    一个字段的事。取不到用户名时直接 403（fail closed），而不是退化成查一个空
    字符串 —— 后者能不能挡住越权，取决于表里恰好没有空归属的行。
    """
    owner = str(user.get("username") or "").strip()
    if not owner:
        raise HTTPException(
            status_code=403, detail="当前账号没有用户名，无法访问消息中心"
        )
    return owner


@router.get("")
async def list_notifications(
    limit: int = Query(default=notifications.DEFAULT_LIMIT, ge=1, le=notifications.MAX_LIMIT),
    unread_only: bool = Query(default=False),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前用户的消息列表 + 未读数。

    未读数每次一起返回：铃铛的角标和列表是同一屏的两处展示，分两个接口会让它们
    在请求间隙里对不上（角标显示 3、列表里只有 1 条未读）。
    """
    items = await notifications.list_for(
        _own(user), limit=limit, unread_only=unread_only
    )
    return {
        "items": items,
        "unread": await notifications.unread_count(_own(user)),
    }


@router.get("/unread")
async def unread(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, int]:
    """只取未读数。

    铃铛要定期轮询（默认 30 秒），每次都把整页消息拉回来纯属浪费 —— 单独留一个
    极轻的接口，命中 ``(username, read_at)`` 索引。
    """
    return {"unread": await notifications.unread_count(_own(user))}


@router.delete("")
async def clear_notifications(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """一键清空自己的消息中心，返回删掉的条数。

    这是**不可撤销**的，所以进审计：事后有人问「我那条带口令的下发通知怎么没了」，
    至少查得到是本人清的、什么时候清的 —— 条数进审计，消息正文不进。
    """
    owner = _own(user)
    removed = await notifications.clear(owner)
    await security.audit(
        request,
        user,
        "notifications.clear",
        target=owner,
        detail=f"清空站内消息 {removed} 条",
    )
    return {"removed": removed, "unread": 0}


@router.post("/read")
async def mark_read(
    payload: MarkReadRequest,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """把选中的消息（或全部）标记为已读，返回最新的未读数。"""
    marked = await notifications.mark_read(
        _own(user), ids=payload.ids, all_items=payload.all
    )
    return {
        "marked": marked,
        "unread": await notifications.unread_count(_own(user)),
    }
