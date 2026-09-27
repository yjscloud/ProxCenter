"""个人 API Token 管理接口：创建 / 列表 / 吊销。

归属规则
--------
每个用户只能看到并操作**自己的**令牌：归属条件由 :mod:`app.apitokens` 里的
各函数自己拼进 SQL（``username`` 参数），接口不接受调用方传入目标用户名 ——
否则「改一个 id 就能吊销别人的令牌」这种越权是迟早的事。

为什么管理类操作强制浏览器会话
------------------------------
创建令牌 = 签发一份新的长期凭据。如果拿令牌本身就能创建令牌，那么一枚泄漏的
令牌即使被发现并吊销，攻击者用它在之前派生出来的那枚还能继续存活，吊销就永远
追不上。所以令牌管理只走浏览器会话（能完成二次确认的那条链）。吊销不需要二次
确认：那是**收窄**权限的操作，应急时不该有任何摩擦。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import apitokens, security
from ..config import settings

router = APIRouter(prefix="/api/tokens", tags=["tokens"])


class TokenCreateIn(BaseModel):
    """创建参数。``ttl_days`` 为 0 表示永不过期（界面会明确提示）。"""

    name: str = Field(default="", max_length=apitokens.NAME_MAX)
    ttl_days: Optional[int] = Field(
        default=apitokens.DEFAULT_TTL_DAYS, ge=0, le=3650
    )


def require_session(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """令牌管理只接受浏览器会话，不接受 API Token（见模块说明）。"""
    if security.is_api_token_request(request):
        raise HTTPException(
            status_code=403,
            detail="API Token 不能管理凭据，请从浏览器登录后操作",
        )
    return user


@router.get("")
async def list_tokens(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前用户的令牌列表。

    带上 ``enabled`` / ``max`` / ``active`` 一起返回：个人中心要同时渲染列表、
    配额进度和「功能是否被管理员关掉」，分几个接口会让这几处互相打架。已吊销 /
    已过期的条目照样返回（界面置灰），用户才看得到「我之前那枚怎么了」。
    """
    items = await apitokens.list_for(str(user.get("username") or ""))
    active = sum(
        1 for item in items if not item["revoked"] and not item["expired"]
    )
    return {
        "items": items,
        "enabled": bool(settings.api_token_enabled),
        "max": max(int(settings.api_token_max_per_user), 1),
        "active": active,
        "default_ttl_days": apitokens.DEFAULT_TTL_DAYS,
    }


@router.post("", status_code=201)
async def create_token(
    payload: TokenCreateIn,
    request: Request,
    user: Dict[str, Any] = Depends(require_session),
    # 签发长期凭据 = 「以该用户的名义永久通行」，与写入 PVE Token、改 SMTP
    # 口令同级，按项目既有惯例要求二次确认。
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """创建一枚令牌。**响应里的 ``token`` 是明文唯一一次出现的地方。**

    之后库里只剩 SHA-256 摘要，谁都无法再把它取出来 —— 忘了就只能吊销重发。
    """
    if not settings.api_token_enabled:
        raise HTTPException(
            status_code=403, detail="面板已停用 API Token（API_TOKEN_ENABLED=false）"
        )

    name = (payload.name or "").strip()
    if not name:
        # 名字不是装饰：列表里一排「未命名令牌」时，泄漏应急根本挑不出该吊销哪枚。
        raise HTTPException(status_code=400, detail="请给令牌起个名字，便于日后辨认")

    limit = max(int(settings.api_token_max_per_user), 1)
    if await apitokens.count_active(user["username"]) >= limit:
        raise HTTPException(
            status_code=400,
            detail=f"最多同时持有 {limit} 枚有效令牌，请先吊销不再使用的",
        )

    created = await apitokens.create(
        user["username"],
        name=name,
        ttl_days=payload.ttl_days,
        ip=security.client_ip(request),
    )
    await security.audit(
        request,
        user,
        "token.create",
        target=f"token/{created['id']}",
        detail={
            "name": name,
            "expires_at": created["expires_at"],
            # 前缀可以入审计：它不足以还原出完整令牌，但足以对上「是哪一枚」
            "prefix": created["prefix"],
        },
    )
    return created


@router.delete("/{token_id}")
async def revoke_token(
    token_id: int,
    request: Request,
    user: Dict[str, Any] = Depends(require_session),
) -> Dict[str, Any]:
    """吊销一枚令牌（软删除，保留记录以便事后追溯）。"""
    if not await apitokens.revoke(token_id, username=user["username"]):
        # 「不存在」「不是自己的」「早就吊销过了」统一回同一句话：区分开就等于
        # 提供了一个「拿 id 探测这枚令牌属于谁」的接口。
        raise HTTPException(status_code=404, detail="令牌不存在或已经失效")

    await security.audit(
        request, user, "token.revoke", target=f"token/{token_id}"
    )
    return {
        "ok": True,
        "revoked": token_id,
        "active": await apitokens.count_active(user["username"]),
    }
