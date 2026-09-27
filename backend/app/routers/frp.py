"""内网穿透（frp）接口。

按职责拆成「服务端（admin only）」+「规则（按用户归属）」+「进程控制（admin）」：
- 服务端：frps 地址 / token / 启停 / 安装 —— 属于基础设施，普通用户不应改动。
- 规则：每个人把自己的服务通过 frpc 暴露出去 —— 按 username 归属，admin 可看全部。
- 合并渲染：``frpc`` 实际只用一份配置文件，所以运行前要把 server + 所有人
  的规则合并后渲染成 frpc.toml。普通用户也能拉这个合并视图，确认自己
  的规则是否出现在最终生效的列表里。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import frp, security, store

router = APIRouter(prefix="/api/frp", tags=["frp"])


# ---------------------------------------------------------------------------
# 权限复用
# ---------------------------------------------------------------------------
# 服务端 / 启停 / 安装 走 settings.manage（admin 专享）；
# 规则增删改走 frp.manage（每个登录用户都能管自己的）；
# 状态、日志、合并视图走 frp.view。
_PERM_VIEW = "frp.view"
_PERM_MANAGE_RULE = "frp.manage"
_PERM_ADMIN = "settings.manage"


def _is_admin(user: Dict[str, Any]) -> bool:
    return bool(user.get("permissions") and (
        "*" in user["permissions"] or _PERM_ADMIN in user["permissions"]
    ))


def _visible_username(user: Dict[str, Any]) -> Optional[str]:
    """返回「只看自己」时的用户名；admin 返回 None 表示不限制。"""
    return None if _is_admin(user) else str(user.get("username") or "")


# ---------------------------------------------------------------------------
# 内部：读写持久化的辅助
# ---------------------------------------------------------------------------
async def _load_server() -> Dict[str, Any]:
    return await frp.load_server()


async def _load_rules() -> List[Dict[str, Any]]:
    return await frp.load_rules()


def _public_server(server: Dict[str, Any]) -> Dict[str, Any]:
    """对前端只暴露 server_addr / server_port / token 是否设置 —— token 不回显。"""
    return {
        "server_addr": server.get("server_addr", ""),
        "server_port": server.get("server_port", 7000),
        "token_set": bool(server.get("token")),
    }


def _public_rule(rule: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": rule.get("id"),
        "username": rule.get("username", ""),
        "name": rule.get("name", ""),
        "type": rule.get("type", "tcp"),
        "local_ip": rule.get("local_ip", "127.0.0.1"),
        "local_port": rule.get("local_port", 80),
        "remote_port": rule.get("remote_port", 10000),
    }


def _scope_rules(
    rules: List[Dict[str, Any]], username: Optional[str]
) -> List[Dict[str, Any]]:
    """按可见范围挑选原始规则：``username`` 为 None（admin）时不过滤。"""
    if username is None:
        return list(rules)
    return [r for r in rules if r.get("username") == username]


def _visible_rules(rules: List[Dict[str, Any]], username: Optional[str]) -> List[Dict[str, Any]]:
    """按当前用户过滤规则：admin 见全部，普通用户只看到自己 username 的。"""
    return [_public_rule(r) for r in _scope_rules(rules, username)]


def _visible_logs(
    logs: List[str], rules: List[Dict[str, Any]], username: Optional[str]
) -> List[str]:
    """日志按归属过滤。

    frpc 会把每条代理的名字写进日志，直接透传等于把别人的规则名暴露给
    所有登录用户；非 admin 只保留不涉及他人规则的行。
    """
    if username is None:
        return logs
    others = {
        str(r.get("name"))
        for r in rules
        if r.get("name") and r.get("username") != username
    }
    if not others:
        return logs
    return [line for line in logs if not any(name in line for name in others)]


# ===========================================================================
# 服务端 —— 仅 admin（settings.manage）能读写
# ===========================================================================
@router.get("/server")
async def get_server(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """服务端配置（脱敏）。所有 frp.view 用户都能看 server_addr/port，
    但只有 admin 能看到 token_set 字段对应的明文（也不下传明文）。"""
    server = await _load_server()
    return _public_server(server)


@router.put("/server")
async def save_server(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """保存服务端配置（admin only）。"""
    current = await _load_server()
    cleaned = frp.normalise_server(payload)
    # 不传 token / token_clear 视为保持原值 —— 前端从来拿不到明文
    if not cleaned.get("token"):
        if payload.get("token_clear"):
            cleaned["token"] = ""
        else:
            cleaned["token"] = current.get("token", "")
    await frp.save_server(cleaned)
    # 保存后若 frpc 在跑，立即重启使其生效
    was_running = frp.is_running()
    restart_error = ""
    if was_running:
        frp.stop()
        try:
            cfg = frp.effective_config(cleaned, await _load_rules())
            frp.start(cfg)
        except frp.FrpError as exc:
            restart_error = str(exc)
    await security.audit(
        request, user, "frp.server.update", "frp/server",
        "success" if not restart_error else "partial",
        f"更新服务端配置{'；重启失败：' + restart_error if restart_error else ''}",
    )
    return {
        **_public_server(cleaned),
        "restarted": was_running and not restart_error,
        "restart_error": restart_error,
    }


@router.post("/server/install")
async def install_frpc(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    try:
        path = await frp.install()
    except frp.FrpError as exc:
        await security.audit(request, user, "frp.server.install", "frp/server", "failed", str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(request, user, "frp.server.install", "frp/server", "success", path)
    return {"binary": path}


@router.post("/server/start")
async def start_frpc(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """用 server + 全部规则合并后的配置启动 frpc。"""
    await frp.migrate_legacy()  # 兼容期：自动把旧 frp_config 拆过来
    cfg = await frp.effective()
    try:
        frp.start(cfg)
    except frp.FrpError as exc:
        await security.audit(request, user, "frp.server.start", "frp/server", "failed", str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(request, user, "frp.server.start", "frp/server", "success", "启动 frpc")
    return frp.status(cfg)


@router.post("/server/stop")
async def stop_frpc(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    frp.stop()
    await security.audit(request, user, "frp.server.stop", "frp/server", "success", "停止 frpc")
    cfg = await frp.effective()
    return frp.status(cfg)


# ===========================================================================
# 规则 —— 普通用户只看自己、只能改自己；admin 看到全部、可改任意
# ===========================================================================
@router.get("/rules")
async def list_rules(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """列出可见的规则。

    普通用户只看自己 username 的规则，admin 看全部。
    返回 ``own_username`` 让前端能区分「自己的」与「别人的」并按需禁用删除按钮。
    """
    rules = await _load_rules()
    username = _visible_username(user)
    return {
        "rules": _visible_rules(rules, username),
        "own_username": str(user.get("username") or ""),
        "is_admin": _is_admin(user),
    }


@router.post("/rules")
async def create_rule(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_MANAGE_RULE)),
) -> Dict[str, Any]:
    """新建一条规则。

    username 自动归属到当前用户，admin 可通过 ``username`` 字段代为创建
    （典型场景：批量初始化 / 把旧无主规则挪到对应用户下）。
    """
    rules = await _load_rules()
    target_user = str(user.get("username") or "")
    if _is_admin(user) and payload.get("username"):
        target_user = str(payload.get("username") or "")
    if not target_user:
        raise HTTPException(status_code=400, detail="无法确定规则归属用户")
    rule = frp.normalise_rule({**payload, "username": target_user}, username=target_user)
    # 防重名（不同用户允许同名，相同用户内不允许）
    if any(r.get("username") == rule["username"] and r.get("name") == rule["name"] for r in rules):
        raise HTTPException(
            status_code=400,
            detail=f"用户 {rule['username']} 下已存在同名规则 {rule['name']}",
        )
    rules.append(rule)
    await frp.save_rules(rules)
    await _restart_if_running()
    await security.audit(
        request, user, "frp.rule.create", f"frp/rule/{rule['id']}",
        "success", f"username={rule['username']} name={rule['name']}",
    )
    return _public_rule(rule)


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_MANAGE_RULE)),
) -> Dict[str, Any]:
    rules = await _load_rules()
    idx = next((i for i, r in enumerate(rules) if r.get("id") == rule_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="规则不存在")
    target = rules[idx]
    # 权限：owner 或 admin
    is_owner = target.get("username") == str(user.get("username") or "")
    if not (is_owner or _is_admin(user)):
        raise HTTPException(status_code=403, detail="只能修改自己的规则")
    new_rule = frp.normalise_rule(
        {**target, **payload, "id": rule_id, "username": target.get("username")},
        username=target.get("username", ""),
    )
    # 防重名：同人下不能与其它规则同名
    if any(
        i != idx
        and r.get("username") == new_rule["username"]
        and r.get("name") == new_rule["name"]
        for i, r in enumerate(rules)
    ):
        raise HTTPException(
            status_code=400,
            detail=f"用户 {new_rule['username']} 下已存在同名规则 {new_rule['name']}",
        )
    rules[idx] = new_rule
    await frp.save_rules(rules)
    await _restart_if_running()
    await security.audit(
        request, user, "frp.rule.update", f"frp/rule/{rule_id}",
        "success", f"name={new_rule['name']}",
    )
    return _public_rule(new_rule)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_MANAGE_RULE)),
) -> Dict[str, Any]:
    rules = await _load_rules()
    target = next((r for r in rules if r.get("id") == rule_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="规则不存在")
    is_owner = target.get("username") == str(user.get("username") or "")
    if not (is_owner or _is_admin(user)):
        raise HTTPException(status_code=403, detail="只能删除自己的规则")
    rules = [r for r in rules if r.get("id") != rule_id]
    await frp.save_rules(rules)
    await _restart_if_running()
    await security.audit(
        request, user, "frp.rule.delete", f"frp/rule/{rule_id}",
        "success", f"name={target.get('name')}",
    )
    return {"deleted": rule_id}


# ===========================================================================
# 状态 / 日志 / 合并渲染 —— 所有 frp.view 用户都能用
# ===========================================================================
@router.get("/effective")
async def get_effective(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """当前生效的合并配置（服务端 + 规则），不包含 token 明文。

    非 admin 只下发自己名下的规则 —— 合并视图原本会带上所有人的代理明细
    （内网 IP / 端口 / 公网端口），等于绕过规则列表的归属过滤。
    """
    server = await _load_server()
    rules = await _load_rules()
    username = _visible_username(user)
    scoped = _scope_rules(rules, username)
    cfg = frp.effective_config(server, scoped)
    safe = dict(cfg)
    safe["token"] = ""
    return {
        "config": safe,
        "token_set": bool(server.get("token")),
        "rule_count": len(scoped),
        "scope": "all" if username is None else "own",
        # 全局条数只对 admin 有意义，不下发给普通用户
        **({"total_rule_count": len(rules)} if username is None else {}),
    }


@router.get("/status")
async def get_status(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """进程级状态：是否在跑 / frpc 二进制是否存在 / 实际连接的服务端。

    ``proxy_count`` 只统计当前用户可见的规则，不暴露全局规则数量。
    """
    await frp.migrate_legacy()
    server = await _load_server()
    rules = await _load_rules()
    cfg = frp.effective_config(server, _scope_rules(rules, _visible_username(user)))
    return frp.status(cfg)


@router.get("/logs")
async def get_logs(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    rules = await _load_rules()
    return {"logs": _visible_logs(frp.read_logs(200), rules, _visible_username(user))}


# ===========================================================================
# 兼容期：旧 /api/frp/config 仍然返回合并视图，便于前端平滑过渡
# （建议下一个大版本删除）
# ===========================================================================
@router.get("/config")
async def legacy_config(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """兼容旧前端：返回合并视图（服务端 + 进程），按当前用户可见范围过滤。"""
    await frp.migrate_legacy()
    server = await _load_server()
    rules = await _load_rules()
    username = _visible_username(user)
    cfg = frp.effective_config(server, _scope_rules(rules, username))
    safe = dict(cfg)
    safe["token"] = ""
    return {
        "config": safe,
        "token_set": bool(server.get("token")),
        "logs": _visible_logs(frp.read_logs(150), rules, username),
        **frp.status(cfg),
    }


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------
async def _restart_if_running() -> None:
    """frpc 在跑时改完规则立即重启。

    frp.start 内部含 1.5 秒的同步等待，必须放到 worker thread 跑，否则会
    阻塞 FastAPI 的 event loop，影响其它并发请求。但接口本身要同步等到重启
    完成再返回 —— 否则前端立刻 refetch /effective 看到的还是旧进程。
    """
    if not frp.is_running():
        return
    try:
        cfg = await frp.effective()
        await asyncio.to_thread(frp.start, cfg)
    except frp.FrpError:
        # 重启失败由用户后续手动 start 即可
        pass