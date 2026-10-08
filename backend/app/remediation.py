"""统一处置框架：把分散的写操作收敛到一套「预览 → 确认 → 执行 → 审计」的接口上。

为什么要单独建一层
------------------
平台的写操作此前分散在各页面：安全基线页有「一键加固」、应急响应页有「一键隔离」、
SSH 安全页有「封禁 / 解封」。它们各自都做了二次确认与审计，唯一缺的是**执行前的
dry-run** —— 用户点「加固」时并不知道究竟会改哪几项，AI 排查助手给出结论后从
「建议」到「执行」之间也少了一步「看清将要发生什么」。

三个刻意的约束
--------------
1. **动作必须显式登记**：没有 ``run_command`` 这类通用入口，模型或前端只能
   「选动作 + 填参数」，参数按动作声明逐个校验；
2. **预览与执行分离**：预览只读平台已有数据（体检报告、隔离状态、fail2ban 状态），
   绝不产生副作用；执行走路由层的二次确认（``security.check_step_up``）；
3. **这里不重复实现处置**：每个动作都调用既有模块（:mod:`baseline` /
   :mod:`isolation` / :mod:`sshguard`），沿用它们自己的校验与回滚，避免两套行为。

风险分级：``reversible``（可回滚或可反向操作）与 ``irreversible``（会断网、关机等）。
两者都要求二次确认，分级只用于界面提示与后续审计口径。
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Tuple

from . import baseline, hostscope, i18n, isolation, ownership, reportcache, security, sshguard, store, vm_scope

logger = logging.getLogger(__name__)

# 很轻的参数校验：动作参数都是「名字 / 数字 / IP」，不需要 aitools 那套白名单
_NAME_RE = re.compile(r"^[A-Za-z0-9_.@\-]{1,64}$")
_NUM_RE = re.compile(r"^[1-9][0-9]{0,8}$")
_IP_RE = re.compile(r"^[0-9A-Fa-f:.]{1,45}$")

_Label = Tuple[str, str]


# ------------------------------------------------------------------ 归属校验
def _op_connection() -> str:
    """本次操作作用在哪条 PVE 连接上（与 vms 路由同一套解析）。"""
    return vm_scope.requested_connection() or str(store.get_active_connection_id() or "")


async def _assert_vm_access(user: Dict[str, Any], node: str, vmid: int) -> None:
    """虚拟机归属校验：管理员放行，普通用户只能处置自己名下的机器。"""
    owner = security.visible_owner(user)
    if owner is None:
        return
    ref = ownership.vm_ref(_op_connection(), node, vmid)
    if await ownership.get_owner(ownership.KIND_VM, ref) != owner:
        raise PermissionError(f"虚拟机 {node}/{vmid} 不属于当前用户，无权处置")


async def _assert_access(user: Dict[str, Any], action: Dict[str, Any], params: Dict[str, Any]) -> None:
    kind = action.get("target_kind")
    if kind == "host":
        await hostscope.assert_host_access(user, str(params.get("host_id") or "local"))
    elif kind == "vm":
        await _assert_vm_access(user, str(params.get("node") or ""), int(params["vmid"]))
    elif kind == "local":
        await hostscope.assert_local_access(user)


# ------------------------------------------------------------------ 参数校验
def validate(action: Dict[str, Any], raw: Any) -> Dict[str, Any]:
    """按动作声明的参数规则校验入参；缺必填、格式不对都抛 ``ValueError``。"""
    source = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {}
    for key, rule in (action.get("params") or {}).items():
        if rule.get("kind") == "list":
            items = [str(item).strip() for item in (source.get(key) or []) if str(item).strip()]
            for item in items:
                if not _NAME_RE.match(item):
                    raise ValueError(i18n.pick(f"参数 {key} 含不合法项", f"Invalid item in {key}"))
            out[key] = items
            continue

        value = str(source.get(key) or "").strip() or str(rule.get("default") or "").strip()
        if not value:
            if rule.get("required"):
                raise ValueError(i18n.pick(f"缺少参数 {key}", f"Missing required argument: {key}"))
            continue
        pattern = rule.get("pattern")
        if pattern == "num":
            if not _NUM_RE.match(value):
                raise ValueError(i18n.pick(f"参数 {key} 必须是正整数", f"{key} must be a positive integer"))
            out[key] = int(value)
        elif pattern == "ip":
            if not _IP_RE.match(value):
                raise ValueError(i18n.pick("IP 不合法", "Invalid IP address"))
            out[key] = value
        else:
            if not _NAME_RE.match(value):
                raise ValueError(i18n.pick(f"参数 {key} 不合法", f"Invalid {key}"))
            out[key] = value
    return out


# ------------------------------------------------------------------ 预览（dry-run）
async def _preview_baseline(params: Dict[str, Any]) -> Dict[str, Any]:
    host_id = str(params.get("host_id") or "local")
    # 指定了 keys 就只预览这几项（「处置这条建议」）；留空则列全部可自动修复项
    wanted = {str(item) for item in (params.get("keys") or [])}
    report = await baseline.collect_host(host_id)
    items = [
        item
        for item in (report.get("checks") or [])
        if item.get("fixable")
        and item.get("auto")
        and item.get("status") in ("warn", "fail")
        and (not wanted or str(item.get("key")) in wanted)
    ]
    return {
        "summary": i18n.pick(
            f"将加固 {len(items)} 项（仅可自动修复项）",
            f"{len(items)} item(s) will be hardened (auto-fixable only)",
        ),
        "steps": [
            i18n.pick("修复：", "Fix: ") + str(item.get("label") or item.get("key"))
            for item in items
        ],
        "note": i18n.pick(
            "只写面板自己命名的文件，改完校验，失败自动回滚；"
            "关闭 SSH 口令认证这类可能把人锁在门外的项不在此列。",
            "Only panel-owned files are written; changes are verified and rolled back on failure. "
            "Items that could lock you out (e.g. disabling SSH password auth) are excluded.",
        ),
    }


async def _preview_quarantine(params: Dict[str, Any]) -> Dict[str, Any]:
    node = str(params["node"])
    vmid = int(params["vmid"])
    state = await isolation.status(node, vmid)
    return {
        "summary": i18n.pick("将执行一键隔离", "One-click quarantine will run"),
        "steps": [
            i18n.pick("创建取证快照（崩溃一致性，不含内存镜像）", "Create a forensic snapshot (crash-consistent, no memory image)"),
            i18n.pick("切断全部虚拟网卡（link_down）", "Cut all virtual NICs (link_down)"),
            i18n.pick("优雅关机（超时后强制停止）", "Graceful shutdown (forced stop after timeout)"),
            i18n.pick("开启虚拟机保护（禁止误删）", "Enable VM protection (blocks accidental deletion)"),
        ],
        "current": {
            "isolated": state.get("isolated"),
            "cut_interfaces": len(state.get("cut_interfaces") or []),
            "evidence_snapshots": len(state.get("evidence_snapshots") or []),
        },
        "note": i18n.pick(
            "顺序刻意如此：先取证，再断网，最后关机 —— 反过来现场就没了。"
            "PCI 直通 / SR-IOV 网卡不受 link_down 控制。",
            "The order matters: evidence first, then network, then power — reversing it destroys the scene. "
            "PCI passthrough / SR-IOV NICs are unaffected by link_down.",
        ),
    }


async def _preview_release(params: Dict[str, Any]) -> Dict[str, Any]:
    node = str(params["node"])
    vmid = int(params["vmid"])
    state = await isolation.status(node, vmid)
    return {
        "summary": i18n.pick("将解除隔离", "Quarantine will be released"),
        "steps": [
            i18n.pick("恢复被切断的虚拟网卡", "Restore cut virtual NICs"),
            i18n.pick("解除虚拟机保护", "Remove VM protection"),
        ],
        "current": {
            "isolated": state.get("isolated"),
            "cut_interfaces": len(state.get("cut_interfaces") or []),
        },
        "note": i18n.pick(
            "解除后不会自动开机（避免在未确认安全前重新暴露）。",
            "The VM is not powered on automatically (avoids re-exposing it before you confirm it is clean).",
        ),
    }


def _preview_ban(params: Dict[str, Any], *, unban: bool = False) -> Dict[str, Any]:
    ip = str(params["ip"])
    jail = str(params.get("jail") or "sshd")
    verb = i18n.pick("解封", "unban") if unban else i18n.pick("封禁", "ban")
    return {
        "summary": i18n.pick(f"将对 {ip} 执行{verb}", f"Will {verb} {ip}"),
        "steps": [
            i18n.pick(
                f"fail2ban-client set {jail} {'unbanip' if unban else 'banip'} {ip}",
                f"fail2ban-client set {jail} {'unbanip' if unban else 'banip'} {ip}",
            )
        ],
        "note": i18n.pick(
            "作用于面板所在主机的 fail2ban；"
            + ("解封后该 IP 可再次尝试连接。" if unban else "封禁可随时反解，误封不会造成永久影响。"),
            "Applies to the fail2ban on the panel host; "
            + ("after unbanning, the IP may connect again." if unban else "a ban can be reversed at any time, so a mistaken ban is not permanent."),
        ),
    }


# ------------------------------------------------------------------ 执行
async def _apply_baseline(params: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    host_id = str(params.get("host_id") or "local")
    keys = params.get("keys") or None
    result = await baseline.apply_fixes(keys, host_id)
    if result.get("fixed"):
        reportcache.clear()
    return {"ok": not result.get("failed"), "detail": result}


async def _apply_quarantine(params: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    result = await isolation.quarantine(
        str(params["node"]),
        int(params["vmid"]),
        take_snapshot=True,
        cut_network=True,
        power_action="shutdown",
        protect=True,
        note=str(params.get("note") or ""),
        actor=str(user.get("username") or ""),
    )
    return {"ok": bool(result.get("ok")), "detail": result}


async def _apply_release(params: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    result = await isolation.release(
        str(params["node"]),
        int(params["vmid"]),
        restore_network=True,
        unprotect=True,
        power_on=False,
        note=str(params.get("note") or ""),
    )
    return {"ok": bool(result.get("ok")), "detail": result}


async def _apply_ban(params: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    result = await sshguard.fail2ban_action("ban", str(params.get("jail") or "sshd"), str(params["ip"]))
    return {"ok": bool(result.get("ok", True)), "detail": result}


async def _apply_unban(params: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    result = await sshguard.fail2ban_action("unban", str(params.get("jail") or "sshd"), str(params["ip"]))
    return {"ok": bool(result.get("ok", True)), "detail": result}


# ------------------------------------------------------------------ 动作目录
ACTIONS: Dict[str, Dict[str, Any]] = {
    "baseline_hardening": {
        "id": "baseline_hardening",
        "label": ("安全基线加固", "Security baseline hardening"),
        "description": (
            "对一台主机执行安全基线一键加固（仅可自动修复项，改完校验、失败回滚）",
            "Apply security baseline hardening to a host (auto-fixable items only; verified and rolled back)",
        ),
        "target_kind": "host",
        "risk": "reversible",
        "permission": "baseline.manage",
        "view_permission": "baseline.view",
        "params": {
            "host_id": {"pattern": "name", "required": True},
            "keys": {"kind": "list", "required": False},
        },
        "preview": _preview_baseline,
        "apply": _apply_baseline,
    },
    "quarantine_vm": {
        "id": "quarantine_vm",
        "label": ("隔离虚拟机", "Quarantine VM"),
        "description": (
            "对一台虚拟机执行一键隔离：取证快照 → 断网 → 关机 → 加保护",
            "Quarantine a VM: forensic snapshot → cut network → power off → protect",
        ),
        "target_kind": "vm",
        "risk": "irreversible",
        "permission": "vm.isolate",
        "view_permission": "vm.view",
        "params": {
            "node": {"pattern": "name", "required": True},
            "vmid": {"pattern": "num", "required": True},
        },
        "preview": _preview_quarantine,
        "apply": _apply_quarantine,
    },
    "release_vm": {
        "id": "release_vm",
        "label": ("解除隔离", "Release quarantine"),
        "description": (
            "解除一台虚拟机的隔离：恢复网卡 → 解除保护（不自动开机）",
            "Release a quarantined VM: restore NICs → remove protection (no auto power-on)",
        ),
        "target_kind": "vm",
        "risk": "reversible",
        "permission": "vm.isolate",
        "view_permission": "vm.view",
        "params": {
            "node": {"pattern": "name", "required": True},
            "vmid": {"pattern": "num", "required": True},
        },
        "preview": _preview_release,
        "apply": _apply_release,
    },
    "ban_ip": {
        "id": "ban_ip",
        "label": ("封禁 IP", "Ban IP"),
        "description": (
            "用面板所在主机的 fail2ban 封禁一个 IP（可随时解封）",
            "Ban an IP via the fail2ban on the panel host (reversible at any time)",
        ),
        "target_kind": "local",
        "risk": "reversible",
        "permission": "ssh.manage",
        "view_permission": "ssh.view",
        "params": {
            "ip": {"pattern": "ip", "required": True},
            "jail": {"pattern": "name", "required": False},
        },
        "preview": lambda params: _preview_ban(params, unban=False),
        "apply": _apply_ban,
    },
    "unban_ip": {
        "id": "unban_ip",
        "label": ("解封 IP", "Unban IP"),
        "description": (
            "解除面板所在主机 fail2ban 对某个 IP 的封禁",
            "Unban an IP from the fail2ban on the panel host",
        ),
        "target_kind": "local",
        "risk": "reversible",
        "permission": "ssh.manage",
        "view_permission": "ssh.view",
        "params": {
            "ip": {"pattern": "ip", "required": True},
            "jail": {"pattern": "name", "required": False},
        },
        "preview": lambda params: _preview_ban(params, unban=True),
        "apply": _apply_unban,
    },
}


def catalog(user: Dict[str, Any]) -> List[Dict[str, Any]]:
    """当前用户可执行的动作清单（按执行权限过滤，已本地化）。"""
    out: List[Dict[str, Any]] = []
    for action in ACTIONS.values():
        if not security.has_user_permission(user, action["permission"]):
            continue
        zh, en = action["label"]
        dzh, den = action["description"]
        out.append(
            {
                "id": action["id"],
                "label": i18n.pick(zh, en),
                "description": i18n.pick(dzh, den),
                "target_kind": action["target_kind"],
                "risk": action["risk"],
                "permission": action["permission"],
                "params": sorted((action.get("params") or {}).keys()),
            }
        )
    return out


def get(action_id: str) -> Dict[str, Any]:
    action = ACTIONS.get(str(action_id or ""))
    if action is None:
        raise KeyError(action_id)
    return action


def _permission_error(action: Dict[str, Any], view: bool) -> str:
    perm = action["view_permission"] if view else action["permission"]
    return i18n.pick(f"权限不足：需要 {perm}", f"Permission denied: {perm} is required")


async def preview(user: Dict[str, Any], action_id: str, raw_params: Any) -> Dict[str, Any]:
    """生成执行预览（只读，不产生副作用）。"""
    action = get(action_id)
    if not security.has_user_permission(user, action["view_permission"]):
        raise PermissionError(_permission_error(action, True))
    params = validate(action, raw_params)
    await _assert_access(user, action, params)
    detail = await action["preview"](params)
    return {
        "action": action["id"],
        "label": i18n.pick(*action["label"]),
        "risk": action["risk"],
        "params": params,
        **detail,
    }


async def apply(user: Dict[str, Any], action_id: str, raw_params: Any) -> Dict[str, Any]:
    """执行动作（二次确认由路由层负责）。"""
    action = get(action_id)
    if not security.has_user_permission(user, action["permission"]):
        raise PermissionError(_permission_error(action, False))
    params = validate(action, raw_params)
    await _assert_access(user, action, params)
    result = await action["apply"](params, user)
    return {"action": action["id"], "risk": action["risk"], "params": params, **result}
