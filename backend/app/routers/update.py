"""面板更新：检查新版本、查看升级方式、一键更新。

鉴权刻意收紧到「设置管理」权限，并且**两次**动作要二次确认（step-up）：

* 改「发布仓库」等于改**面板会去哪里取代码**；
* 一键更新会把那份代码装上服务器、重启面板 —— 这是「能执行远程代码」级别的能力，
  枚可能从共享电脑、日志或 XSS 里捡到的 token 不足以放行（见
  :func:`app.security.check_step_up` 的说明）。

两者都会写审计：谁在什么时候把面板换到了哪个版本，是事后追溯的第一手材料。

普通用户看不到这组接口 —— 更新是管理员的动作，给所有人多一个需要理解的按钮没有意义。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import i18n, security, update

router = APIRouter(prefix="/api/update", tags=["update"])


class UpdateSettingsIn(BaseModel):
    """更新设置。字段都可选：只提交改过的那一项。"""

    auto_check: Optional[bool] = None
    #: 发布仓库（``owner/name``）。换掉它是敏感动作 —— 见本模块说明。
    repo: Optional[str] = None
    #: 用户选择「跳过这个版本」；空串 = 取消跳过
    skipped_version: Optional[str] = None


class UpdateApplyIn(BaseModel):
    """一键更新。``tag`` 留空 = 用最近一次检查到的版本。"""

    tag: Optional[str] = None
    #: 工作区有未提交改动时是否仍然更新（默认不允许：更新会覆盖那些改动）
    allow_dirty: bool = False


@router.get("/status")
async def get_status(
    _user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """当前版本 / 最新版本 / 能否一键更新 / 该形态下的手工命令。"""
    return await update.status()


@router.post("/check")
async def check_now(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """立刻查一次（按钮点出来的）。失败不报错，原因在 ``error`` 字段里。"""
    result = await update.check(force=True)
    await security.audit_read(request, user, "update.check", target=result.get("latest") or "")
    return result


@router.put("/settings")
async def save_settings(
    payload: UpdateSettingsIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """改自动检查 / 跳过版本 / 发布仓库。"""
    changed: Dict[str, Any] = {}
    if payload.repo is not None:
        repo = str(payload.repo).strip()
        if repo != await update.get_repo():
            # 换仓库 = 换「面板去哪里取代码」：必须确认是本人操作
            security.check_step_up(request, user)
            await update.set_repo(repo)
            changed["repo"] = repo
    if payload.auto_check is not None:
        await update.set_auto_check(bool(payload.auto_check))
        changed["auto_check"] = bool(payload.auto_check)
    if payload.skipped_version is not None:
        await update.set_skipped(payload.skipped_version)
        changed["skipped_version"] = str(payload.skipped_version).strip()
    if changed:
        await security.audit(
            request,
            user,
            "update.settings",
            target="panel_update",
            detail=", ".join(f"{key}={value}" for key, value in changed.items()),
        )
    return await update.status()


@router.post("/apply")
async def apply_now(
    payload: UpdateApplyIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    # 这里会换掉面板自己的代码并重启服务：必须二次确认身份
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """一键更新：写脚本 → 脱离当前进程执行 git + deploy.sh。

    接口立刻返回（更新要跑几分钟，且过程中面板会重启），进度看 ``log`` 指向的文件，
    状态变化看 :func:`get_status` 的 ``applying`` / ``last_update``。
    """
    try:
        result = await update.apply_update(payload.tag or "", allow_dirty=payload.allow_dirty)
    except update.UpdateError as exc:
        raise HTTPException(status_code=400, detail=i18n.pick(str(exc), str(exc))) from exc
    await security.audit(
        request,
        user,
        "update.apply",
        target=str(result.get("tag") or ""),
        detail=f"from={result.get('current')} log={result.get('log')}",
    )
    return result
