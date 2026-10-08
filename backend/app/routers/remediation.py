"""统一处置接口：动作目录 / 预览（dry-run）/ 执行。

与平台其它写接口同一套规矩：**唯一写入口**都要过二次确认（``check_step_up``）并
逐条审计；预览只读、不产生副作用，因此不需要二次确认，但仍要求对应的查看权限。

状态码约定：未知动作 404、权限不足 403、参数或底层业务失败 400；
``hostscope`` 抛出的 403 / 409 原样透出（否则「本机没导入」会被降级成 400）。
"""
from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import remediation, security

router = APIRouter(prefix="/api/remediation", tags=["remediation"])


@router.get("/actions")
async def list_actions(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前用户能执行哪些处置动作（按执行权限过滤）。"""
    return {"actions": remediation.catalog(user)}


@router.post("/preview")
async def preview(
    payload: Dict[str, Any],
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """执行前预览：将做什么、影响什么、可不可逆（不落地）。"""
    try:
        return await remediation.preview(
            user, str(payload.get("action") or ""), payload.get("params")
        )
    except HTTPException:
        raise
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"未知处置动作：{exc}") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - 底层模块的业务错误统一转 400
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/apply")
async def apply(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """执行一个处置动作。二次确认在最前面 —— 这里全是写操作。"""
    security.check_step_up(request, user)
    action_id = str(payload.get("action") or "")
    try:
        result = await remediation.apply(user, action_id, payload.get("params"))
    except HTTPException:
        raise
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"未知处置动作：{exc}") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - 参数与底层业务失败都回 400
        await security.audit(
            request,
            user,
            "remediation.apply",
            target=action_id,
            result="failed",
            detail=str(exc)[:500],
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "remediation.apply",
        target=action_id,
        result="success" if result.get("ok") else "failed",
        detail=json.dumps(result.get("detail"), ensure_ascii=False, default=str)[:500],
    )
    return result
