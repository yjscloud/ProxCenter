"""面板级设置的接口。

目前只有维护模式。语义是「对外暂停服务」：

* 普通用户**登不进来**（登录 / 两步验证 / 续期一并拒绝）；
* 已登录的普通用户每个接口都会拿到 503 + ``X-Error-Code: maintenance``；
* 管理员完全不受影响 —— 维护期间正是要有人能进去把它关掉。

查询接口不要求登录：登录页得先知道「现在是不是维护中、公告写了什么」，否则只会
给出一个「用户名或密码错误」的误导提示。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import maintenance, security

router = APIRouter(prefix="/api/panel", tags=["panel"])


class MaintenanceIn(BaseModel):
    """维护模式开关 + 公告正文（留空 = 用内置文案）。"""

    enabled: bool = False
    message: str = Field(default="", max_length=maintenance.MAX_MESSAGE)


@router.get("/maintenance")
async def get_maintenance() -> Dict[str, Any]:
    """公开：登录页 / 维护公告页读这里。"""
    data = await maintenance.state()
    return {
        "enabled": bool(data["enabled"]),
        # 回**原始**公告（可能是空串）：设置页要在同一个框里编辑它，回填默认文案
        # 等于把某一种语言的默认值固化成用户内容。展示方自己用内置文案兜底。
        "message": data["message"],
    }


@router.put("/maintenance")
async def save_maintenance(
    payload: MaintenanceIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_admin()),
) -> Dict[str, Any]:
    """管理员开关维护模式。

    面板级配置归 ``settings.manage`` 那条线，这里明确只给超级管理员：让「维护
    模式」成为区域管理员也能按的开关，等于给了他们一键停服的能力。
    """
    data = await maintenance.save(payload.model_dump())
    await security.audit(
        request,
        user,
        "panel.maintenance",
        "settings",
        "success",
        "维护模式：" + ("开启" if data["enabled"] else "关闭"),
    )
    return {"enabled": data["enabled"], "message": data["message"]}
