"""主机登录审计接口：last / lastb 登录历史、sudo 提权、汇入面板审计。

读这些记录本身是敏感操作（翻登录记录往往是为了掩盖痕迹或锁定目标），所以
每次读取都会通过 :func:`app.security.audit_read` 留痕。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import alerting, hostaudit, hostscope, pve, security

from .vms import require_vm_access

router = APIRouter(prefix="/api/host-audit", tags=["host-audit"])

VIEW = security.require_permission("ssh.view")
MANAGE = security.require_permission("ssh.manage")

HOST_AUDIT_ACTIONS = {
    "host.ssh_login": "SSH 登录成功",
    "host.ssh_failed": "SSH 登录失败",
    "host.sudo": "sudo / su 提权",
}


@router.get("/hosts")
async def hosts(
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> List[Dict[str, Any]]:
    rows = await hostaudit.host_rows(await hostscope.allowed_host_ids(user))
    return [
        {
            "id": str(row.get("id")),
            "name": str(row.get("name") or row.get("host") or row.get("id")),
            "host": str(row.get("host") or ""),
            "local": str(row.get("id")) == "local",
        }
        for row in rows
    ]


@router.get("/logins", dependencies=[Depends(hostscope.require_host_access)])
async def logins(
    request: Request,
    host_id: str = Query(default="local"),
    kind: str = Query(default="success", pattern="^(success|failed)$"),
    limit: int = Query(default=200, ge=1, le=1000),
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """某台主机的登录历史（last = 成功，lastb = 失败）。"""
    report = await hostaudit.collect_logins(host_id, kind=kind, limit=limit)
    await security.audit_read(
        request,
        user,
        "host_audit.logins",
        target=report.get("name") or host_id,
        detail=f"kind={kind} limit={limit} 条数={len(report.get('entries') or [])}",
    )
    if not report.get("ok") and report.get("error") == "主机不存在":
        raise HTTPException(status_code=404, detail="主机不存在")
    return {**report, "kind": kind}


@router.get("/sudo", dependencies=[Depends(hostscope.require_host_access)])
async def sudo_events(
    request: Request,
    host_id: str = Query(default="local"),
    hours: int = Query(default=24, ge=1, le=168),
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """某台主机 auth.log / secure 里的 sudo、su 提权记录。"""
    report = await hostaudit.collect_sudo(host_id, hours=hours)
    await security.audit_read(
        request,
        user,
        "host_audit.sudo",
        target=report.get("name") or host_id,
        detail=f"hours={hours} 条数={len(report.get('entries') or [])}",
    )
    if report.get("error") == "主机不存在":
        raise HTTPException(status_code=404, detail="主机不存在")
    return report


@router.get("/cursors")
async def cursors(
    user: Dict[str, Any] = Depends(VIEW),
) -> List[Dict[str, Any]]:
    """每台主机「已汇入到什么时候」的进度（只列当前用户可见的主机）。"""
    return await hostaudit.cursor_status(await hostscope.allowed_host_ids(user))


@router.post("/import")
async def import_now(
    request: Request,
    host_id: str = Query(default=""),
    user: Dict[str, Any] = Depends(MANAGE),
) -> Dict[str, Any]:
    """手动把主机级事件汇入面板审计日志（平时后台每 5 分钟自动跑一次）。

    ``host_id`` 留空 = 汇入全部**可见**主机：管理员是全部，普通用户只是自己
    那几台 —— 手动汇入不该成为绕过隔离的旁路。
    """
    ids = await hostscope.allowed_host_ids(user)
    if host_id:
        await hostscope.assert_host_access(user, host_id)
    summary = await hostaudit.import_events(host_id or None, ids)
    await security.audit(
        request,
        user,
        "host_audit.import",
        target=host_id or "全部主机",
        result="success",
        detail=f"写入 {summary['imported']} 条",
    )
    return summary


@router.get("/vm/{node}/{vmid}", dependencies=[Depends(require_vm_access)])
async def vm_view(
    node: str,
    vmid: int,
    request: Request,
    hours: int = Query(default=24, ge=1, le=168),
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """虚拟机视角：把这台 VM 当成「来源」，找出它登录过哪些受管主机。

    这是本路由里**唯一按虚拟机取值**的接口（其余都是主机级），所以它必须和
    其它 VM 级接口一样过 ``require_vm_access``：否则任何有 ssh.view 的用户
    都能拿别人的 vmid 来查「这台机器登录过哪些主机」。

    面板读不到 VM 内部的登录记录（那要靠 VM 自己的日志），但能回答一个更
    常用的问题：**这台机器有没有拿去登录宿主机 / 别的机器** —— 横向移动的
    第一步往往就长这样。
    """
    client = pve.get_client()
    ip = ""
    try:
        ip = await alerting.resolve_vm_ip(client, node, vmid)
    except Exception:  # noqa: BLE001 - 拿不到 IP 也要返回有用的信息
        ip = ""

    entries: List[Dict[str, Any]] = []
    if ip:
        floor = time.time() - hours * 3600
        # 只在自己可见的主机里找：查的是「我这台机器登录过哪些主机」，
        # 别的用户的受管主机不该出现在结果里（本机也只有管理员可见）
        for row in await hostaudit.host_rows(await hostscope.allowed_host_ids(user)):
            host_id = str(row.get("id"))
            name = str(row.get("name") or row.get("host") or host_id)
            for kind in ("success", "failed"):
                report = await hostaudit.collect_logins(host_id, kind=kind, limit=500)
                for entry in report.get("entries") or []:
                    if entry.get("ip") != ip:
                        continue
                    start = float(entry.get("start") or 0)
                    if start and start < floor:
                        continue
                    entries.append({**entry, "host": name, "host_id": host_id, "kind": kind})

    entries.sort(key=lambda item: item.get("start") or 0, reverse=True)
    await security.audit_read(
        request,
        user,
        "host_audit.vm",
        target=f"{node}/{vmid}",
        detail=f"ip={ip or '未知'} 命中 {len(entries)} 条",
    )
    return {
        "node": node,
        "vmid": vmid,
        "ip": ip,
        "hours": hours,
        "entries": entries[:200],
        "note": ""
        if ip
        else "没解析到这台虚拟机的 IP（需要 Guest Agent 或静态 IP 配置），无法按来源匹配登录记录",
    }


@router.get("/actions")
async def actions() -> Dict[str, str]:
    """汇入面板审计时用到的动作名与中文说明（前端筛选下拉用）。"""
    return HOST_AUDIT_ACTIONS
