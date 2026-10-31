"""内网穿透（frp）接口。

按职责拆成「服务端（admin only）」+「规则（按用户归属）」+「进程控制（admin）」：
- 服务端：frps 地址 / token / 启停 / 安装 —— 属于基础设施，普通用户不应改动。
- 规则：每个人把自己的服务通过 frpc 暴露出去 —— 按 username 归属，admin 可看全部。
  这里的 ``username`` 是**规则的创建人**，不是目标机器的归属：规则是用户自己的
  对象（不是从某台客户机派生出来的），所以它不会随客户机改派而改主人。目标的
  合法性在写入时按**当时**的归属校验（见 :mod:`app.frpguard`），并把目标机器记进
  ``guest_ref``；之后每次读取都按**当前**归属复核，机器改派或收回就让规则失效
  （``stale``，不删、不再渲染，见 :func:`app.frp.annotate_rules`）。
  升级前建的规则没有 ``guest_ref``，用 ``POST /rules/relink`` 补齐。
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

from .. import frp, frpguard, security, store
from ..schemas import (
    FrpGrantIn,
    FrpPanelSubnetIn,
    FrpPortRangeIn,
    FrpRuleIn,
    FrpRuleUpdateIn,
)

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


def _public_server(
    server: Dict[str, Any], *, include_addr: bool = True
) -> Dict[str, Any]:
    """对前端只暴露地址 / 端口 / token 是否设置 —— token 不回显。

    ``include_addr=False``（普通用户）时把 **frps 连接地址**抹成空串：那是
    frpc 连服务端用的，与用户自己的规则无关（V2-04）。但 ``public_addr``
    （用户访问穿透服务时该连的地址）必须下发 —— 否则建完规则根本不知道
    从哪儿访问，这个功能等于没用。
    """
    return {
        "server_addr": server.get("server_addr", "") if include_addr else "",
        "server_port": server.get("server_port", 7000),
        "public_addr": str(server.get("public_addr") or ""),
        "token_set": bool(server.get("token")),
    }


def _public_host(server: Dict[str, Any]) -> str:
    """用户实际访问穿透服务时用的地址。

    管理员单独填了「对外访问地址」就用它（frps 在 NAT 后面、或走域名时常见）；
    没填则回落到 frps 地址。空串 = 管理员还没配，界面要据此给出提示。
    """
    return str(server.get("public_addr") or server.get("server_addr") or "").strip()


def _public_rule(rule: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": rule.get("id"),
        "username": rule.get("username", ""),
        "name": rule.get("name", ""),
        "type": rule.get("type", "tcp"),
        "local_ip": rule.get("local_ip", "127.0.0.1"),
        "local_port": rule.get("local_port", 80),
        "remote_port": rule.get("remote_port", 10000),
        # 关联到哪台机器 + 是否因改派而失效（见 frp.annotate_rules）。
        # 失效只是「不参与 frpc 渲染」，规则本身还在，作者能看到原因。
        "guest_ref": rule.get("guest_ref", ""),
        "stale": bool(rule.get("stale")),
        "stale_reason": rule.get("stale_reason", ""),
        # 目标机器现在归谁（空串 = 无主）：界面按语言自行组织原因文案
        "stale_owner": rule.get("stale_owner", ""),
    }


def _scope_rules(
    rules: List[Dict[str, Any]], username: Optional[str]
) -> List[Dict[str, Any]]:
    """按可见范围挑选原始规则：``username`` 为 None（admin）时不过滤。"""
    if username is None:
        return list(rules)
    return [r for r in rules if r.get("username") == username]


async def _visible_rules(
    rules: List[Dict[str, Any]], username: Optional[str]
) -> List[Dict[str, Any]]:
    """按当前用户过滤规则：admin 见全部，普通用户只看到自己 username 的。

    过滤后再标注失效状态：普通用户因此能看到「我的这条为什么不通」，管理员
    也能一眼看出哪些规则因为机器改派而不再生效。
    """
    scoped = _scope_rules(rules, username)
    return [_public_rule(r) for r in await frp.annotate_rules(scoped)]


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
    """服务端配置（脱敏）。

    服务端地址只对管理员可见：普通用户建规则填的是**自己的**内网 IP 与公网
    端口，frps 地址对他来说没有用途，却能用来判断这套面板穿透到了哪台机器。
    ``token_set`` 仍然下发（前端要据此显示「已设置 token」），明文从不下发。
    """
    server = await _load_server()
    return _public_server(server, include_addr=_is_admin(user))


@router.put("/server")
async def save_server(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """保存服务端配置（admin only）。"""
    current = await _load_server()
    raw_public = str(payload.get("public_addr") or "").strip()
    cleaned = frp.normalise_server(payload)
    if raw_public and not cleaned.get("public_addr"):
        raise HTTPException(
            status_code=400,
            detail="对外访问地址格式不对：只填域名或 IP，不要带路径、空格或逗号",
        )
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
    return {**frp.status(cfg), "auto_restart": await frp.auto_restart_enabled()}


@router.post("/server/stop")
async def stop_frpc(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """停止 frpc。

    手动停止**同时关掉「自动拉起」**：否则看护会在一分钟内又把它拉起来 ——
    用户明明点了停止却停不掉，比没有看护更让人困惑。要恢复就再把开关打开。
    """
    frp.stop()
    await frp.set_auto_restart(False)
    await security.audit(
        request, user, "frp.server.stop", "frp/server", "success",
        "停止 frpc，并关闭自动拉起",
    )
    cfg = await frp.effective()
    return {**frp.status(cfg), "auto_restart": False}


@router.post("/server/auto-restart")
async def set_auto_restart(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """开关「frpc 停止后自动拉起」。

    开启后由调度器的 frp_watchdog 作业看护；而开启这一下如果 frpc 当前没在跑，
    就**立刻**拉一次 —— 用户按了开关却要等一分钟才看到效果，不像话。
    """
    enabled = str(payload.get("enabled", False)).strip().lower() in (
        "1", "true", "yes", "on",
    )
    await frp.set_auto_restart(enabled)

    started = False
    error = ""
    if enabled and not frp.is_running():
        cfg = await frp.effective()
        try:
            # start() 里有一段探活等待，放进线程，别堵住事件循环
            await asyncio.to_thread(frp.start, cfg)
            started = True
        except frp.FrpError as exc:
            error = str(exc)

    await security.audit(
        request, user, "frp.server.auto_restart", "frp/server",
        "failed" if error else "success",
        f"{'开启' if enabled else '关闭'}自动拉起"
        + (f"；立即启动失败：{error}" if error else ("；已立即启动" if started else "")),
    )
    cfg = await frp.effective()
    return {
        **frp.status(cfg),
        "auto_restart": enabled,
        "started": started,
        "start_error": error,
    }


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

    ``public_host`` 是规则的**公网访问地址**（``public_host:remote_port``）：
    建完规则却不知道从哪儿访问，等于没建 —— 这个字段对 frp.view 用户必须给。
    """
    rules = await _load_rules()
    server = await _load_server()
    username = _visible_username(user)
    return {
        "rules": await _visible_rules(rules, username),
        "own_username": str(user.get("username") or ""),
        "is_admin": _is_admin(user),
        "public_host": _public_host(server),
    }


@router.get("/policy")
async def get_policy(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_VIEW)),
) -> Dict[str, Any]:
    """规则策略快照：端口区间 / 关键端口黑名单 / 目标白名单。

    端口区间取管理员在页面上设定的值（见 :func:`set_port_range`），没设置过
    时跟随环境配置，默认 40000–50000。

    前端用它做即时校验与提示（"你能选哪些目标"、"哪些端口已被占"）。普通用户
    还会拿到「自己名下虚机 / 容器的地址清单」（``targets``，含名字 / VMID）——
    这正是他们被允许指向的全部目标，创建规则时做成下拉即可，不必对着报错猜。

    目标列表读 PVE 失败时不让整页报错：``own_ips_error`` 说明原因，
    ``targets`` / ``own_ips`` 为空即可（写入时仍然会 fail-closed）。

    ``granted`` 是管理员在「用户授权」里单独放行给这个人的 IP / 网段 —— 与
    ``targets`` 一样可以直接作为下拉选项 / 手动输入的依据。
    """
    rules = await _load_rules()
    is_admin = _is_admin(user)
    username = str(user.get("username") or "")
    data: Dict[str, Any] = await frpguard.policy()
    targets: List[Dict[str, Any]] = []
    own_ips_error = ""
    if not is_admin:
        try:
            targets = await frpguard.own_guest_targets(username)
        except Exception as exc:  # noqa: BLE001 - 只影响提示，不影响写入判定
            own_ips_error = str(exc)
    grants = {} if is_admin else await frp.load_grants()
    data.update(
        {
            "restricted": not is_admin,
            "granted": grants.get(username, []),
            "public_host": _public_host(await _load_server()),
            "targets": targets,
            "own_ips": [item["ip"] for item in targets],
            "own_ips_error": own_ips_error,
            "used_remote_ports": frpguard.used_remote_ports(rules),
            "default_remote_port": frpguard.first_free_port(
                rules, (data["remote_port_min"], data["remote_port_max"])
            ),
        }
    )
    return data


@router.put("/policy/panel-subnet")
async def set_panel_subnet_block(
    payload: FrpPanelSubnetIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """开关「阻止把穿透目标指向面板后端所在网段」（admin only）。

    关掉它等于允许普通用户把服务穿透到面板 / PVE 管理网 —— 攻击面立刻变大，
    所以和规则写入一样要求二次确认。面板自身地址在任何状态下都仍然拒绝，
    这里的开关只影响「同网段的其它地址」。
    """
    enabled = bool(payload.enabled)
    await frpguard.set_block_panel_subnet(enabled)
    await security.audit(
        request,
        user,
        "frp.policy.panel_subnet",
        "frp/policy",
        "success",
        f"block_panel_subnet={enabled}",
    )
    return {"block_panel_subnet": enabled}


@router.put("/policy/port-range")
async def set_port_range(
    payload: FrpPortRangeIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """设定用户可用的公网端口区间（admin only）。

    原先区间写死在 40000–50000：frps 前面有 NAT / 云安全组时，管理员往往只能
    映射很窄的一段端口，写死的区间等于让规则「建得出来但连不上」。现在区间
    由管理员按实际可用范围设定，普通用户建规则时只能填这一段。

    关键端口黑名单与区间无关、始终生效（把区间放宽到 1–65535 也不会放出 22 /
    80 / 443 / 8006）。已有规则不会因为区间收窄而失效 —— 只是下次修改时必须
    改到新区间内，响应里的 ``out_of_range_ports`` 把这类端口列出来提醒管理员。
    """
    try:
        low, high = await frpguard.set_remote_port_range(
            payload.remote_port_min, payload.remote_port_max
        )
    except frpguard.PolicyError as exc:
        await security.audit(
            request, user, "frp.policy.port_range", "frp/policy", "denied",
            f"remote_port={payload.remote_port_min}-{payload.remote_port_max}：{exc.message}",
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    out_of_range: List[int] = []
    for rule in await _load_rules():
        try:
            port = int(rule.get("remote_port") or 0)
        except (TypeError, ValueError):
            continue
        if port and not (low <= port <= high) and port not in out_of_range:
            out_of_range.append(port)
    out_of_range.sort()
    await security.audit(
        request, user, "frp.policy.port_range", "frp/policy", "success",
        f"remote_port={low}-{high}"
        + (f"；已有规则端口不在区间内：{out_of_range}" if out_of_range else ""),
    )
    return {
        "remote_port_min": low,
        "remote_port_max": high,
        "out_of_range_ports": out_of_range,
    }


@router.post("/rules")
async def create_rule(
    payload: FrpRuleIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_MANAGE_RULE)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """新建一条规则。

    username 自动归属到当前用户，admin 可通过 ``username`` 字段代为创建
    （典型场景：批量初始化 / 把旧无主规则挪到对应用户下）。

    三道防线见 :mod:`app.frpguard`：目标白名单（只能指向自己名下的虚机，
    或管理员放行的网段）、公网端口区间 + 关键端口黑名单、端口冲突检查。
    二次确认（step-up）与防火墙保持一致 —— 这条规则一落库就会被 frpc 生效。
    """
    rules = await _load_rules()
    target_user = str(user.get("username") or "")
    if _is_admin(user) and payload.username:
        target_user = str(payload.username or "")
    if not target_user:
        raise HTTPException(status_code=400, detail="无法确定规则归属用户")

    grants = await frp.load_grants()
    port_range = await frpguard.remote_port_range()
    try:
        local_ip = await frpguard.check_target(
            payload.local_ip,
            username=target_user,
            is_admin=_is_admin(user),
            granted=grants.get(target_user, []),
        )
        remote_port = frpguard.check_remote_port(
            payload.remote_port, rules, port_range=port_range
        )
    except frpguard.PolicyError as exc:
        await security.audit(
            request, user, "frp.rule.create", "frp/rule", "denied",
            f"username={target_user} name={payload.name} "
            f"local_ip={payload.local_ip} remote_port={payload.remote_port}：{exc.message}",
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    rule = frp.normalise_rule(
        {
            "name": payload.name,
            "type": payload.type,
            "local_ip": local_ip,
            "local_port": payload.local_port,
            "remote_port": remote_port,
            "username": target_user,
            # 记下这条隧道指向哪台机器：改派之后要靠它判断该不该继续生效
            "guest_ref": await frpguard.guest_ref_for_ip(target_user, local_ip),
        },
        username=target_user,
    )
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


@router.post("/rules/relink")
async def relink_rules(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """给存量规则补上「指向哪台机器」（仅管理员）。

    补上之后这些规则才会被改派复核覆盖：目标机器换主人时自动失效，而不是继续把
    前主人的隧道留在公网上。反查要用 PVE 侧的客户机地址，解析不到的规则保持
    「未关联」并逐条返回，界面提示用户把目标改成自己名下的地址。

    只补空字段，不覆盖已有值、不改归属、不重启 frpc —— 补的是「关联」，不是
    「生效状态」；失效与否仍然每次读取时按归属现算。
    """
    result = await frp.relink_guests()
    await security.audit(
        request, user, "frp.rule.relink", "frp/rules", "success",
        f"checked={result['checked']} linked={result['linked']}",
    )
    return result


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    payload: FrpRuleUpdateIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_MANAGE_RULE)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """修改规则（全字段必填，走与新建完全相同的校验）。"""
    rules = await _load_rules()
    idx = next((i for i, r in enumerate(rules) if r.get("id") == rule_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="规则不存在")
    target = rules[idx]
    # 权限：owner 或 admin
    is_owner = target.get("username") == str(user.get("username") or "")
    if not (is_owner or _is_admin(user)):
        raise HTTPException(status_code=403, detail="只能修改自己的规则")

    # 目标是否允许按**规则归属者**判定：管理员替别人改规则时也不该把一条
    # 指向某人无权访问的机器的规则塞给他（管理员自身仍走 bypass）。
    owner = str(target.get("username") or "")
    grants = await frp.load_grants()
    port_range = await frpguard.remote_port_range()
    try:
        local_ip = await frpguard.check_target(
            payload.local_ip,
            username=owner,
            is_admin=_is_admin(user),
            granted=grants.get(owner, []),
        )
        remote_port = frpguard.check_remote_port(
            payload.remote_port, rules, exclude_id=rule_id, port_range=port_range
        )
    except frpguard.PolicyError as exc:
        await security.audit(
            request, user, "frp.rule.update", f"frp/rule/{rule_id}", "denied",
            f"name={payload.name} local_ip={payload.local_ip} "
            f"remote_port={payload.remote_port}：{exc.message}",
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    new_rule = frp.normalise_rule(
        {
            **target,
            "id": rule_id,
            "username": target.get("username", ""),
            "name": payload.name,
            "local_ip": local_ip,
            "local_port": payload.local_port,
            "remote_port": remote_port,
            # 目标地址换了就重新关联（改到别台机器上时 ref 必须跟着变）
            "guest_ref": await frpguard.guest_ref_for_ip(owner, local_ip),
        },
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
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
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
# 用户授权 —— 管理员给某个普通用户额外放行可穿透的目标（IP / 网段）
#
# 为什么需要它：目标白名单只认「自己名下的虚机 / 容器 IP」，而有些机器拿不到
# IP（没装 Guest Agent、没开机、也没配静态地址），用户就完全没法把自己的服务
# 暴露出去。管理员在这里按人放行一两个具体地址，比在全球配置里开一整个网段
# 精确得多。授权同样受端口策略、面板自身地址与二次确认约束。
# ===========================================================================
def _grant_item(username: str, value: str) -> Dict[str, str]:
    return {
        "username": username,
        "value": value,
        "kind": "cidr" if "/" in value else "ip",
    }


@router.get("/grants")
async def list_grants(
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
) -> Dict[str, Any]:
    """全部用户授权（仅管理员），附带可选用户列表供界面下拉。"""
    grants = await frp.load_grants()
    items = [
        _grant_item(username, value)
        for username, values in sorted(grants.items())
        for value in values
    ]
    users = sorted(
        str(item.get("username") or "")
        for item in await store.list_users()
        if str(item.get("username") or "")
    )
    return {"items": items, "users": users}


@router.post("/grants")
async def add_grant(
    payload: FrpGrantIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """给某个用户放行一个目标 IP / 网段。"""
    target_user = str(payload.username or "").strip()
    if not target_user:
        raise HTTPException(status_code=400, detail="请选择要授权的用户")
    if not await store.get_user(target_user):
        raise HTTPException(status_code=404, detail=f"用户 {target_user} 不存在")

    try:
        value = frpguard.parse_grant(payload.value)
    except frpguard.PolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    grants = await frp.load_grants()
    entries = list(grants.get(target_user, []))
    if value not in entries:
        entries.append(value)
        grants[target_user] = entries
        await frp.save_grants(grants)
    await security.audit(
        request, user, "frp.grant.add", f"frp/grant/{target_user}",
        "success", f"value={value}",
    )
    return {"username": target_user, "entries": entries}


@router.delete("/grants")
async def delete_grant(
    username: str,
    value: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission(_PERM_ADMIN)),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """撤销某个用户的一条授权（已存在的规则不会被自动删除）。"""
    target_user = str(username or "").strip()
    wanted = str(value or "").strip()
    grants = await frp.load_grants()
    entries = [item for item in grants.get(target_user, []) if item != wanted]
    if entries:
        grants[target_user] = entries
    else:
        grants.pop(target_user, None)
    await frp.save_grants(grants)
    await security.audit(
        request, user, "frp.grant.remove", f"frp/grant/{target_user}",
        "success", f"value={wanted}",
    )
    return {"username": target_user, "entries": entries}


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
    # 先标注再合并：失效规则的隧道不该出现在「我现在实际暴露了什么」里
    scoped = await frp.annotate_rules(_scope_rules(rules, username))
    cfg = frp.effective_config(server, scoped)
    safe = dict(cfg)
    safe["token"] = ""
    if not _is_admin(user):
        # 与 /server 同一口径：地址不下发给普通用户（proxies 才是他们要看的）
        safe["server_addr"] = ""
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
    """进程级状态：是否在跑 / frpc 是否可用 /（仅管理员）连接的服务端。

    刻意不下发 ``binary``（安装路径是实现细节），``server_addr`` 也只给管理员
    —— 普通用户需要的是「在不在跑、有几条规则」，不是 frps 连到哪台机器。
    ``proxy_count`` 只统计当前用户可见的规则，不暴露全局规则数量。
    """
    await frp.migrate_legacy()
    server = await _load_server()
    rules = await _load_rules()
    scoped = await frp.annotate_rules(_scope_rules(rules, _visible_username(user)))
    cfg = frp.effective_config(server, scoped)
    return {
        **frp.status(cfg, include_server=_is_admin(user)),
        "auto_restart": await frp.auto_restart_enabled(),
    }


@router.get("/logs")
async def get_logs(
    # 进程日志**只给管理员**：frpc 的日志里有连接 frps 的地址、失败重试的真实
    # 原因、每条代理的起停顺序，等于把整套隧道的运行内情摊开。普通用户需要的是
    # 「我这条隧道通不通」，那由 /effective + /rules 回答；日志不在其中。
    # 原先这道门是 frp.view + 按规则名过滤行 —— 过滤是黑名单（认名字），
    # 换个代理名或换一套日志格式就会漏，不如直接不给。
    user: Dict[str, Any] = Depends(security.require_admin()),
) -> Dict[str, Any]:
    rules = await _load_rules()
    return {"logs": _visible_logs(frp.read_logs(200), rules, None)}


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
    scoped = await frp.annotate_rules(_scope_rules(rules, username))
    cfg = frp.effective_config(server, scoped)
    safe = dict(cfg)
    safe["token"] = ""
    is_admin = _is_admin(user)
    if not is_admin:
        # 兼容端点与 /server、/effective 同一口径：普通用户拿不到 frps 地址
        safe["server_addr"] = ""
    return {
        "config": safe,
        "token_set": bool(server.get("token")),
        # 旧前端会从这个合并视图里读日志；非管理员一律给空数组，语义与
        # /api/frp/logs（仅 admin）保持一致 —— 不能因为走兼容端点就绕过限制。
        "logs": _visible_logs(frp.read_logs(150), rules, username) if is_admin else [],
        **frp.status(cfg, include_server=is_admin),
    }


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------
async def _restart_if_running() -> None:
    """frpc 在跑时改完规则立即重启（实现见 :func:`app.frp.restart_if_running`）。

    放在 frp 模块里是为了让「归属变更」也能复用同一段逻辑：改派会让某些规则
    失效，不重启的话那条隧道会一直跑到下一次手工重启为止。
    """
    await frp.restart_if_running()