"""SSH 登录安全接口：日志统计、fail2ban 管控、异常登录策略。

本机部分读的是**面板所在主机**的 SSH 日志（见 :mod:`app.sshguard`）：这是唯一
不需要额外凭据就能拿到真实数据的来源，集群里其它宿主机的 SSH 日志面板读不到。
但**本机默认不在管控范围内**，要用户显式导入（见 :mod:`app.localhost`）——
读宿主机日志、改 sshd 与 fail2ban 策略都需要相当高的权限，不该默认打开。
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import hostscope, localhost, panelkey, security, sshguard, sshremote, store
from ..formatters import short_hostname
from ..schemas import (
    SshHostIn,
    SshHostOwnerIn,
    SshJailPolicyIn,
    SshKnownIpIn,
    SshPolicyIn,
    SshTargetIn,
)

router = APIRouter(prefix="/api/ssh", tags=["ssh"])

SSH_VIEW = security.require_permission("ssh.view")
SSH_MANAGE = security.require_permission("ssh.manage")


async def _report(hours: int, limit: int = 50) -> Dict[str, Any]:
    report = await sshguard.collect(hours)
    payload = sshguard.overview_payload(report)
    payload["top_ips"] = payload.get("top_ips", [])[: max(1, min(200, limit))]
    return payload


# ------------------------------------------------------------------ 受管主机
@router.get("/hosts")
async def list_hosts(
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> List[Dict[str, Any]]:
    """受管主机列表（凭据只回是否设置，不回内容）。

    管理员看全部；普通用户只看得到自己添加的那几台。
    """
    rows = await hostscope.visible_host_rows(user)
    owners = await hostscope.host_owners()
    return [
        {**sshremote.public_host(row), "owner": owners.get(str(row.get("id") or ""), "")}
        for row in rows
    ]


@router.post("/hosts")
async def create_host(
    payload: SshHostIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """新增一台受管主机（口令 / 私钥加密落库，需要二次确认）。"""
    try:
        row = await sshremote.save_host(payload.model_dump(), str(user.get("username") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "ssh.host_create",
        row["host"],
        "success",
        f"{row['username']}@{row['host']}:{row['port']}（{row['auth_type']}）",
    )
    return {"host": sshremote.public_host(row)}


@router.put("/hosts/{host_id}", dependencies=[Depends(hostscope.require_host_access)])
async def update_host(
    host_id: str,
    payload: SshHostIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    try:
        row = await sshremote.save_host(
            {**payload.model_dump(), "id": host_id}, str(user.get("username") or "")
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(request, user, "ssh.host_update", row["host"], "success", "")
    return {"host": sshremote.public_host(row)}


@router.delete("/hosts/{host_id}", dependencies=[Depends(hostscope.require_host_access)])
async def remove_host(
    host_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    # 走 purge_host 而不是 delete_host：这台主机在「登录审计 / 端口与进程 /
    # 安全基线」里的数据（导入游标、人工处置、报告缓存与活动告警）一并清掉，
    # 否则挪到别页还能看到一台已经不存在的机器。
    removed = await sshremote.purge_host(host_id)
    await security.audit(request, user, "ssh.host_delete", host_id, "success", f"移除 {removed} 台")
    return {"ok": True, "removed": removed}


@router.put("/hosts/{host_id}/owner")
async def assign_host_owner(
    host_id: str,
    payload: SshHostOwnerIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """把一台受管主机指派给某个用户（用户名留空 = 收回，之后仅管理员可见）。

    存量主机（本次改动之前添加的）没有归属记录，对普通用户一律不可见；
    管理员用这个接口把主机交还给真正维护它的人。
    """
    # 非管理员只能给自己已有的主机改归属：否则拿着别人的主机 id 就能把它
    # 划到自己名下（ssh.manage 若被下放给普通角色，这里就是提权口子）
    await hostscope.assert_host_access(user, host_id)
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    owner = str(payload.username or "").strip()
    await hostscope.set_host_owner(host_id, owner)
    await security.audit(
        request,
        user,
        "ssh.host_owner",
        row["host"],
        "success",
        f"归属 → {owner or '（收回，仅管理员可见）'}",
    )
    return {"ok": True, "host_id": host_id, "owner": owner}


@router.post("/hosts/{host_id}/test", dependencies=[Depends(hostscope.require_host_access)])
async def test_host(
    host_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """连通性自检：能不能连上、是谁、有没有 fail2ban、日志源是什么。"""
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    result = await sshremote.test_host(row)
    await security.audit(
        request,
        user,
        "ssh.host_test",
        row["host"],
        "success" if result.get("ok") else "failed",
        str(result.get("detail") or "")[:200],
    )
    return {"host": sshremote.public_host(row), "result": result}


@router.post("/hosts/{host_id}/trust", dependencies=[Depends(hostscope.require_host_access)])
async def trust_host(
    host_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """确认并记住该主机的 SSH 指纹（首次连接后必须做一次）。"""
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    result = await sshremote.trust_fingerprint(row)
    await security.audit(
        request,
        user,
        "ssh.host_trust",
        row["host"],
        "success" if result.get("ok") else "failed",
        str(result.get("fingerprint") or result.get("detail") or "")[:200],
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("detail") or "确认指纹失败")
    return {"host": sshremote.public_host(await sshremote.get_host(host_id) or row), **result}


# ------------------------------------------------------------ 多机（fleet）
@router.get("/fleet")
async def fleet_overview(
    hours: int = Query(default=0, ge=0, le=168),
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """本机 + 受管主机的汇总（远程并发拉取，失败的主机会单独标注原因）。

    管理员看全部；普通用户只看自己那几台（本机不在其中）。
    """
    return await sshremote.fleet_overview(
        hours or None, await hostscope.allowed_host_ids(user)
    )


@router.get("/fleet/{host_id}/failures", dependencies=[Depends(hostscope.require_host_access)])
async def fleet_failures(
    host_id: str,
    hours: int = Query(default=24, ge=1, le=168),
    min_count: int = Query(default=1, ge=1, le=100000),
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    if host_id == "local":
        report = await sshguard.collect(hours)
        rows = [row for row in report["top_ips"] if row["count"] >= min_count]
        return {
            "source": report["source"],
            "summary": report["summary"],
            "top_users": report["top_users"],
            "failures": rows,
        }
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    report = await sshremote.remote_report(row, hours)
    if not report.get("ok"):
        raise HTTPException(
            status_code=502,
            detail="无法从该主机读取日志：" + (report.get("error") or "未知原因"),
        )
    return {
        "source": report["source"],
        "summary": report["summary"],
        "top_users": report["top_users"],
        "failures": [item for item in report["top_ips"] if item["count"] >= min_count],
    }


@router.post("/fleet/{host_id}/fail2ban/ban", dependencies=[Depends(hostscope.require_host_access)])
async def fleet_ban(
    host_id: str,
    payload: SshTargetIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    result = await _remote_action(host_id, "ban", payload.jail, payload.ip)
    await security.audit(
        request, user, "ssh.remote_ban", payload.ip, "success", f"{host_id}/{payload.jail}"
    )
    return result


@router.post("/fleet/{host_id}/fail2ban/unban", dependencies=[Depends(hostscope.require_host_access)])
async def fleet_unban(
    host_id: str,
    payload: SshTargetIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    result = await _remote_action(host_id, "unban", payload.jail, payload.ip)
    await security.audit(
        request, user, "ssh.remote_unban", payload.ip, "success", f"{host_id}/{payload.jail}"
    )
    return result


@router.put("/fleet/{host_id}/fail2ban/jail", dependencies=[Depends(hostscope.require_host_access)])
async def fleet_write_jail(
    host_id: str,
    payload: SshJailPolicyIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    if host_id == "local":
        return await write_jail_policy(payload, request, user, _step_up)
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    try:
        result = await sshremote.remote_write_jail(
            row, payload.jail, payload.maxretry, payload.findtime, payload.bantime
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "ssh.remote_jail_write",
        row["host"],
        "success",
        f"{payload.jail} maxretry={payload.maxretry} bantime={payload.bantime}",
    )
    return result


async def _remote_action(host_id: str, action: str, jail: str, ip: str) -> Dict[str, Any]:
    if host_id == "local":
        try:
            return await sshguard.fail2ban_action(action, jail, ip)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    try:
        return await sshremote.remote_fail2ban_action(row, action, jail, ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ------------------------------------------------------------ 面板 SSH 密钥对
# 「面板下发」虚拟机会用它把公钥写进 cloud-init，之后面板自己 SSH 进去做安全
# 采集（见 :mod:`app.panelkey`）。私钥加密落库、永不回传，所以这里只有两个接口：
# 看公钥、轮换密钥。

@router.get("/panel-key")
async def panel_key_state(
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """当前面板公钥，以及有多少台主机靠它接入。

    特意**不**顺手生成：密钥只在真正要用的那一刻（下发一台勾了「接入安全管控」
    的机器）才产生 —— 一个从没用过这功能的部署不该平白多出一把钥匙。
    """
    hostscope.assert_admin(user)
    state = await panelkey.state()
    try:
        rows = await sshremote.list_hosts(include_disabled=True)
    except Exception:  # noqa: BLE001 - 统计不到不影响看公钥
        logger.exception("统计面板下发主机失败")
        rows = []
    return {
        **state,
        "in_use": sum(1 for row in rows if sshremote.is_panel_managed(row)),
        "host_total": len(rows),
    }


@router.post("/panel-key/rotate", dependencies=[Depends(hostscope.require_admin)])
async def rotate_panel_key(
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """轮换面板密钥对（需要二次确认）。

    ⚠️ **旧公钥立即失效** —— 已经用旧公钥接入过的机器，面板再也连不上去，必须
    重新下发或手工把新公钥追加进对应账号的 ``authorized_keys``。所以把受影响
    的主机数一并回给前端，让用户在点之前就看到代价。
    """
    hostscope.assert_admin(user)
    try:
        rows = await sshremote.list_hosts(include_disabled=True)
        affected = sum(1 for row in rows if sshremote.is_panel_managed(row))
    except Exception:  # noqa: BLE001
        logger.exception("统计面板下发主机失败")
        affected = 0
    state = await panelkey.rotate(str(user.get("username") or ""))
    await security.audit(
        request,
        user,
        "ssh.panel_key_rotate",
        "panel-key",
        "success",
        f"轮换面板 SSH 密钥对，受影响主机 {affected} 台",
    )
    return {"ok": True, "key": {**state, "in_use": affected}, "affected": affected}


# ------------------------------------------------------ 面板本机（导入 / 移出）
# 本机默认**不在**管控范围内，要用户显式导入：它意味着面板进程去读宿主机的
# /var/log 与 /proc、改 sshd 配置与 fail2ban 策略，权限相当大；而且容器化部署
# 下根本读不到宿主机，默认开着只会给出一堆「取不到数据」的假象。
# 导入不涉及任何凭据 —— 本机不走 SSH，直接读文件。

@router.get("/local")
async def local_host_state(
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """面板本机的管控状态。

    特意**不要求已导入**（组件用 ``require_admin`` 而非 ``require_local_admin``）——
    否则未导入时前端连「该不该显示导入按钮」都问不出来。
    """
    hostscope.assert_admin(user)
    hostname = short_hostname()
    return {
        "id": hostscope.LOCAL_HOST_ID,
        "name": f"{hostname}（面板本机）",
        "hostname": hostname,
        **(await localhost.state()),
    }


@router.post("/local", dependencies=[Depends(hostscope.require_admin)])
async def import_local_host(
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """把面板本机纳入安全管控（幂等，需要二次确认）。"""
    state = await localhost.enable(by=str(user.get("username") or ""))
    await security.audit(
        request,
        user,
        "ssh.local_import",
        short_hostname(),
        "success",
        "面板本机纳入安全管控",
    )
    return {"ok": True, "local": {"id": hostscope.LOCAL_HOST_ID, **state}}


@router.delete("/local", dependencies=[Depends(hostscope.require_admin)])
async def remove_local_host(
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """把面板本机移出安全管控（幂等）。

    **不删除任何已有数据** —— 已入库的登录审计事件留着，只是不再采集本机。
    """
    state = await localhost.disable()
    await security.audit(
        request,
        user,
        "ssh.local_remove",
        short_hostname(),
        "success",
        "面板本机移出安全管控",
    )
    return {"ok": True, "local": {"id": hostscope.LOCAL_HOST_ID, **state}}


@router.get("/overview", dependencies=[Depends(hostscope.require_local_admin)])
async def overview(
    hours: int = Query(default=0, ge=0, le=168),
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """概览：日志源、失败统计、fail2ban 状态与当前策略。"""
    policy = await sshguard.load_policy()
    window = hours or int(policy["window_hours"])
    report = await _report(window)
    known = await sshguard.known_ips()
    fail2ban = await sshguard.fail2ban_status()
    return {
        "policy": policy,
        "report": report,
        "fail2ban": fail2ban,
        "known_ips": len(known),
        "window_hours": window,
        "notify_user": policy.get("notify_user") or await store.first_admin_username() or "",
    }


@router.get("/failures", dependencies=[Depends(hostscope.require_local_admin)])
async def failures(
    hours: int = Query(default=24, ge=1, le=168),
    min_count: int = Query(default=1, ge=1, le=100000),
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """失败来源明细（按次数倒序），min_count 用来只看重点。"""
    report = await _report(hours, limit=200)
    rows = [row for row in report["top_ips"] if row["count"] >= min_count]
    return {
        "source": report["source"],
        "since": report["since"],
        "generated_at": report["generated_at"],
        "summary": report["summary"],
        "top_users": report["top_users"],
        "failures": rows,
    }


@router.get("/logins", dependencies=[Depends(hostscope.require_local_admin)])
async def logins(
    limit: int = Query(default=100, ge=1, le=1000),
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    """成功登录记录（面板每次检查时落库），new_ip=1 表示当时是陌生地址。"""
    rows = await sshguard.login_history(limit)
    known = await sshguard.known_ips()
    return {
        "logins": rows,
        "known_ips": len(known),
    }


@router.get("/known-ips", dependencies=[Depends(hostscope.require_local_admin)])
async def list_known_ips(
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> List[Dict[str, Any]]:
    known = await sshguard.known_ips()
    return sorted(known.values(), key=lambda row: -int(row.get("last_seen") or 0))


@router.post("/known-ips", dependencies=[Depends(hostscope.require_local_admin)])
async def trust_ip(
    payload: SshKnownIpIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """把一个 IP 标记为已知：之后它登录成功不再触发「陌生 IP」告警。"""
    if not sshguard.IP_RE.match(payload.ip):
        raise HTTPException(status_code=400, detail="IP 地址不合法")
    await sshguard.trust_ip(payload.ip, payload.note)
    await security.audit(
        request, user, "ssh.trust_ip", payload.ip, "success", payload.note or ""
    )
    return {"ok": True, "ip": payload.ip}


@router.delete("/known-ips/{ip}", dependencies=[Depends(hostscope.require_local_admin)])
async def forget_ip(
    ip: str,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """取消已知标记（下次它再登录会被重新当成陌生 IP）。"""
    if not sshguard.IP_RE.match(ip):
        raise HTTPException(status_code=400, detail="IP 地址不合法")
    removed = await sshguard.forget_ip(ip)
    await security.audit(
        request, user, "ssh.forget_ip", ip, "success", f"移除 {removed} 条"
    )
    return {"ok": True, "removed": removed}


@router.get("/fail2ban", dependencies=[Depends(hostscope.require_local_admin)])
async def fail2ban_status(
    user: Dict[str, Any] = Depends(SSH_VIEW),
) -> Dict[str, Any]:
    return await sshguard.fail2ban_status()


@router.post("/fail2ban/ban", dependencies=[Depends(hostscope.require_local_admin)])
async def fail2ban_ban(
    payload: SshTargetIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """手动封禁一个 IP。"""
    try:
        result = await sshguard.fail2ban_action("ban", payload.jail, payload.ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request, user, "ssh.ban", payload.ip, "success", "jail=" + payload.jail
    )
    return {**result, "jail": payload.jail, "ip": payload.ip}


@router.post("/fail2ban/unban", dependencies=[Depends(hostscope.require_local_admin)])
async def fail2ban_unban(
    payload: SshTargetIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """解封一个 IP。"""
    try:
        result = await sshguard.fail2ban_action("unban", payload.jail, payload.ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request, user, "ssh.unban", payload.ip, "success", "jail=" + payload.jail
    )
    return {**result, "jail": payload.jail, "ip": payload.ip}


@router.put("/policy")
async def update_policy(
    payload: SshPolicyIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """保存异常登录策略（阈值 / 窗口 / 冷却 / 接收人 / 忽略名单）。"""
    try:
        policy = await sshguard.save_policy(payload.model_dump())
    except sshguard.PolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "ssh.policy",
        "ssh",
        "success",
        f"阈值 {policy['max_failures']} 次 / {policy['window_hours']} 小时",
    )
    return {"policy": policy}


@router.put("/fail2ban/jail", dependencies=[Depends(hostscope.require_local_admin)])
async def write_jail_policy(
    payload: SshJailPolicyIn,
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """写入面板托管的 fail2ban jail 片段（/etc/fail2ban/jail.d/panel-<jail>.local）并重载。"""
    try:
        result = await sshguard.write_jail(
            payload.jail, payload.maxretry, payload.findtime, payload.bantime
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 顺便把 jail 名记进策略，下次打开页面直接选中
    policy = await sshguard.load_policy()
    await sshguard.save_policy({**policy, "jail": payload.jail})
    await security.audit(
        request,
        user,
        "ssh.jail_write",
        payload.jail,
        "success",
        f"maxretry={payload.maxretry} findtime={payload.findtime} bantime={payload.bantime}",
    )
    return result


@router.post("/check", dependencies=[Depends(hostscope.require_local_admin)])
async def check_now(
    request: Request,
    user: Dict[str, Any] = Depends(SSH_MANAGE),
) -> Dict[str, Any]:
    """立即检测一次并推送告警（平时由后台循环按同样逻辑执行）。"""
    fired = await sshguard.evaluate()
    await security.audit(
        request, user, "ssh.check", "ssh", "success", f"命中 {len(fired)} 条"
    )
    return {"fired": fired, "count": len(fired)}
