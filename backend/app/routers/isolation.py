"""应急响应接口：虚拟机一键隔离与解除。

路径挂在 ``/api/vms/{node}/{vmid}/quarantine`` 下，与 vms 路由共用同一套归属
校验（``require_vm_access``）：普通用户只能处置自己名下的机器。

* ``GET  …/quarantine`` —— 当前隔离状态（断了几张网卡、是否保护、有哪些取证快照），
  读权限用 ``vm.view``，让被隔离机器的所有者能看到发生了什么；
* ``POST …/quarantine`` —— 一键隔离（取证快照 → 断网 → 关机 → 加保护），
  需要 ``vm.isolate`` 并且走二次确认；
* ``POST …/quarantine/release`` —— 解除隔离（恢复网卡 → 解除保护 → 可选开机）。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import isolation, security
from ..pve import ProxmoxError
from ..schemas import QuarantineIn, QuarantineReleaseIn
from .vms import require_vm_access

router = APIRouter(prefix="/api/vms", tags=["isolation"])

ISOLATE = security.require_permission("vm.isolate")
VIEW = security.require_permission("vm.view")


@router.get("/{node}/{vmid}/quarantine", dependencies=[Depends(require_vm_access)])
async def quarantine_status(
    node: str,
    vmid: int,
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """这台虚拟机当前的隔离状态。"""
    try:
        payload = await isolation.status(node, vmid)
    except ProxmoxError as exc:
        raise HTTPException(status_code=502, detail=f"读取虚拟机状态失败：{exc}") from exc
    await security.audit_read(
        request,
        user,
        "vm.quarantine.read",
        target=f"{node}/{vmid}",
        detail=(
            f"隔离中={payload['isolated']}，已断网卡 {len(payload['cut_interfaces'])} 张，"
            f"取证快照 {len(payload['evidence_snapshots'])} 个"
        ),
    )
    return payload


@router.post("/{node}/{vmid}/quarantine", dependencies=[Depends(require_vm_access)])
async def quarantine_vm(
    node: str,
    vmid: int,
    payload: QuarantineIn,
    request: Request,
    user: Dict[str, Any] = Depends(ISOLATE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """一键隔离（先取证快照，再断网 / 关机）。逐步骤回报成败。"""
    try:
        result = await isolation.quarantine(
            node,
            vmid,
            take_snapshot=payload.snapshot,
            cut_network=payload.cut_network,
            power_action=payload.power_action,
            protect=payload.protect,
            note=payload.note,
            actor=str(user.get("username") or ""),
        )
    except (RuntimeError, ProxmoxError) as exc:
        await security.audit(
            request, user, "vm.quarantine", target=f"{node}/{vmid}",
            result="failed", detail=str(exc)[:500],
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "vm.quarantine",
        target=f"{node}/{vmid}",
        result="success" if result["ok"] else "failed",
        detail=(result["summary"] + ("；备注：" + payload.note if payload.note else ""))[:500],
    )
    return result


@router.post(
    "/{node}/{vmid}/quarantine/release", dependencies=[Depends(require_vm_access)]
)
async def release_vm(
    node: str,
    vmid: int,
    payload: QuarantineReleaseIn,
    request: Request,
    user: Dict[str, Any] = Depends(ISOLATE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """解除隔离：恢复网卡 → 解除保护 →（可选）开机。"""
    try:
        result = await isolation.release(
            node,
            vmid,
            restore_network=payload.restore_network,
            unprotect=payload.unprotect,
            power_on=payload.power_on,
            note=payload.note,
        )
    except (RuntimeError, ProxmoxError) as exc:
        await security.audit(
            request, user, "vm.quarantine.release", target=f"{node}/{vmid}",
            result="failed", detail=str(exc)[:500],
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "vm.quarantine.release",
        target=f"{node}/{vmid}",
        result="success" if result["ok"] else "failed",
        detail=result["summary"][:500],
    )
    return result
