"""站内通知接口：顶部铃铛的列表、未读数与已读标记。

每个用户只能看到并操作自己的消息 —— 归属条件是接口自己拼进 SQL 的（见
:mod:`app.notifications` 里各函数），不依赖调用方传入，避免出现「改一个 id
就能读别人的消息」这种越权。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .. import notifications, security

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class MarkReadRequest(BaseModel):
    """标记已读。``ids`` 为空且 ``all=true`` 时清空全部未读。"""

    ids: List[int] = Field(default_factory=list)
    all: bool = False


def _own(user: Dict[str, Any]) -> str:
    return str(user.get("username") or "")


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
