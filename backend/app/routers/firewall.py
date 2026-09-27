"""PVE 原生防火墙的图形化管理。

面板不自己维护一套规则，而是直接封装 Proxmox 的防火墙接口：

* 三个作用域 —— 集群（``/cluster/firewall``）、节点（``/nodes/{node}/firewall``）、
  虚拟机 / 容器（``/nodes/{node}/{qemu|lxc}/{vmid}/firewall``）；
* 集群级共享对象 —— 安全组（groups）、IP 集合（ipset）、别名与宏；
* 面板侧扩展 —— 「规则模板」存在面板自己的库里，可一次下发到多台虚拟机
  （PVE 本身没有模板概念，只能一台台改）。

危险操作（集群级规则 / 默认策略、批量下发）都要二次确认，见 ``require_step_up``。
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError

from .. import security, store
from ..pve import ProxmoxError, get_client
from ..schemas import (
    FirewallApplyIn,
    FirewallGroupIn,
    FirewallIpsetEntryIn,
    FirewallIpsetIn,
    FirewallOptionsIn,
    FirewallRuleIn,
    FirewallTemplateIn,
)
from .vms import require_vm_access

router = APIRouter(prefix="/api", tags=["firewall"])

# 规则模板存在 settings KV 里（与其他面板侧配置一致）
TEMPLATES_KEY = "firewall_templates"
TEMPLATE_LIMIT = 100

# 作用域 → 允许写的选项字段（PVE 三类作用域支持的字段并不相同）
_OPTION_FIELDS: Dict[str, Tuple[str, ...]] = {
    "cluster": ("enable", "policy_in", "policy_out", "log_level_in", "log_level_out", "ebtables"),
    "node": ("enable", "policy_in", "policy_out", "log_level_in", "log_level_out", "ebtables"),
    "vm": (
        "enable",
        "policy_in",
        "policy_out",
        "log_level_in",
        "log_level_out",
        "dhcp",
        "ipfilter",
        "macfilter",
        "ndp",
        "radv",
    ),
}
# 布尔型选项：提交时转成 PVE 的 0/1
_OPTION_BOOLS = ("enable", "ebtables", "dhcp", "ipfilter", "macfilter", "ndp", "radv")

# VM 类型（qemu/lxc）短缓存：防火墙路径按类型区分，而这个信息来自集群资源列表
_VM_KIND_TTL = 30.0
_vm_kind_cache: Dict[str, Tuple[float, str]] = {}


def _raise(exc: ProxmoxError) -> None:
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


def _as_bool(value: Any, default: bool = False) -> bool:
    """PVE 到处用 0/1 字符串，统一转成布尔。"""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    try:
        return int(value) != 0
    except (TypeError, ValueError):
        return bool(value)


async def _vm_kind(node: str, vmid: int) -> str:
    """这台机器是虚拟机（qemu）还是容器（lxc）。"""
    cache_key = f"{node}/{vmid}"
    now = time.time()
    hit = _vm_kind_cache.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    kind = "qemu"
    try:
        resources = await get_client().cluster_resources("vm")
    except ProxmoxError:
        resources = []
    for item in resources or []:
        try:
            same = int(item.get("vmid") or 0) == int(vmid)
        except (TypeError, ValueError):
            same = False
        if same:
            kind = "lxc" if str(item.get("type") or "") == "lxc" else "qemu"
            break
    _vm_kind_cache[cache_key] = (now + _VM_KIND_TTL, kind)
    return kind


async def _scope_base(
    scope: str, node: str = "", vmid: Optional[int] = None, vtype: str = ""
) -> str:
    """把作用域解析成 PVE 的防火墙基路径。"""
    if scope == "cluster":
        return "/cluster/firewall"
    if scope == "node":
        if not node:
            raise HTTPException(status_code=400, detail="节点级防火墙需要 node 参数")
        return f"/nodes/{node}/firewall"
    if scope == "vm":
        if not node or vmid is None:
            raise HTTPException(status_code=400, detail="虚拟机防火墙需要 node 与 vmid")
        kind = (vtype or "").strip().lower()
        if kind not in ("qemu", "lxc"):
            kind = await _vm_kind(node, vmid)
        return f"/nodes/{node}/{kind}/{vmid}/firewall"
    raise HTTPException(status_code=400, detail=f"未知作用域：{scope}")


def _require_scope_permission(user: Dict[str, Any], scope: str) -> None:
    """集群级规则影响所有节点，单独用 firewall.cluster 把住。"""
    if scope == "cluster" and not security.has_user_permission(user, "firewall.cluster"):
        raise HTTPException(
            status_code=403,
            detail="集群级防火墙需要 firewall.cluster 权限（默认仅管理员）",
        )


def _norm_rule(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把 PVE 的规则归一化成前端能直接渲染的形状。"""
    return {
        "pos": int(raw.get("pos") or 0),
        "type": str(raw.get("type") or "in"),
        "action": str(raw.get("action") or "ACCEPT"),
        "enable": _as_bool(raw.get("enable"), True),
        "proto": str(raw.get("proto") or ""),
        "dport": str(raw.get("dport") or ""),
        "sport": str(raw.get("sport") or ""),
        "source": str(raw.get("source") or ""),
        "dest": str(raw.get("dest") or ""),
        "macro": str(raw.get("macro") or ""),
        "iface": str(raw.get("iface") or ""),
        "log": str(raw.get("log") or "nolog"),
        "comment": str(raw.get("comment") or ""),
        "group": str(raw.get("group") or ""),
        "digest": str(raw.get("digest") or ""),
    }


def _rule_payload(rule: FirewallRuleIn, position: Optional[int] = None) -> Dict[str, Any]:
    """面板模型 → PVE 的扁平参数。空值不下发（PVE 用「不带该字段」表示任意）。"""
    data: Dict[str, Any] = {
        "type": rule.type,
        "action": rule.action,
        "enable": 1 if rule.enable else 0,
        "log": rule.log or "nolog",
    }
    for key in (
        "proto",
        "dport",
        "sport",
        "source",
        "dest",
        "macro",
        "iface",
        "comment",
        "group",
    ):
        value = getattr(rule, key)
        if value:
            data[key] = value
    if position is not None:
        data["pos"] = position
    return data


def _options_payload(scope: str, options: FirewallOptionsIn) -> Dict[str, Any]:
    allowed = _OPTION_FIELDS.get(scope, ())
    data: Dict[str, Any] = {}
    for field in allowed:
        value = getattr(options, field, None)
        if value is None:
            continue
        if field in _OPTION_BOOLS:
            data[field] = 1 if value else 0
        else:
            data[field] = value
    if not data:
        raise HTTPException(status_code=400, detail="没有需要修改的选项")
    return data


def _norm_options(raw: Dict[str, Any], scope: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for field in _OPTION_FIELDS.get(scope, ()):
        if field not in (raw or {}):
            continue
        value = raw.get(field)
        out[field] = _as_bool(value) if field in _OPTION_BOOLS else str(value or "")
    return out


async def _firewall_warning(kind: str, node: str, vmid: int) -> str:
    """网卡没开 ``firewall=1`` 时规则其实不生效 —— 提前告诉用户，别让他以为配好了。"""
    client = get_client()
    try:
        if kind == "qemu":
            cfg = await client.qemu_config(node, vmid)
        else:
            cfg = await client.get(f"/nodes/{node}/lxc/{vmid}/config")
    except ProxmoxError:
        return ""
    nics = [v for k, v in (cfg or {}).items() if re.match(r"^net\d+$", str(k))]
    if nics and all("firewall=1" not in str(v) for v in nics):
        return "该虚拟机的网卡未启用防火墙（net*.firewall=1），规则不会生效"
    return ""


# --------------------------------------------------------------- 规则
@router.get("/firewall/{scope}/rules")
async def list_rules(
    scope: str,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
    _access: None = Depends(require_vm_access),
) -> List[Dict[str, Any]]:
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    try:
        rows = await client.get(f"{base}/rules")
    except ProxmoxError as exc:
        _raise(exc)
    return [_norm_rule(r) for r in (rows or [])]


@router.post("/firewall/{scope}/rules")
async def create_rule(
    scope: str,
    payload: FirewallRuleIn,
    request: Request,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _access: None = Depends(require_vm_access),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    _require_scope_permission(user, scope)
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    data = _rule_payload(payload, payload.pos)
    try:
        await client.post(f"{base}/rules", data=data)
    except ProxmoxError as exc:
        await security.audit(
            request,
            user,
            "firewall.rule.create",
            target=_target(scope, node, vmid),
            result="failed",
            detail=exc.message,
        )
        _raise(exc)
    await security.audit(
        request, user, "firewall.rule.create", target=_target(scope, node, vmid), detail=data
    )
    return {"ok": True, "rule": data}


@router.put("/firewall/{scope}/rules/{pos}")
async def update_rule(
    scope: str,
    pos: int,
    payload: FirewallRuleIn,
    request: Request,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _access: None = Depends(require_vm_access),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    _require_scope_permission(user, scope)
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    data = _rule_payload(payload)
    try:
        await client.put(f"{base}/rules/{pos}", data=data)
    except ProxmoxError as exc:
        await security.audit(
            request,
            user,
            "firewall.rule.update",
            target=_target(scope, node, vmid, pos),
            result="failed",
            detail=exc.message,
        )
        _raise(exc)
    await security.audit(
        request,
        user,
        "firewall.rule.update",
        target=_target(scope, node, vmid, pos),
        detail=data,
    )
    return {"ok": True, "rule": data}


@router.delete("/firewall/{scope}/rules/{pos}")
async def delete_rule(
    scope: str,
    pos: int,
    request: Request,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _access: None = Depends(require_vm_access),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    _require_scope_permission(user, scope)
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    try:
        await client.delete(f"{base}/rules/{pos}")
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "firewall.rule.delete", target=_target(scope, node, vmid, pos)
    )
    return {"ok": True, "deleted": pos}


@router.post("/firewall/{scope}/rules/{pos}/move")
async def move_rule(
    scope: str,
    pos: int,
    request: Request,
    to: int = Query(..., ge=0, description="目标位置（0 为最先匹配）"),
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _access: None = Depends(require_vm_access),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """调整规则顺序。防火墙是「先匹配先生效」，顺序就是优先级。"""
    _require_scope_permission(user, scope)
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    try:
        await client.put(f"{base}/rules/{pos}", data={"move": to})
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request,
        user,
        "firewall.rule.move",
        target=_target(scope, node, vmid, pos),
        detail={"to": to},
    )
    return {"ok": True, "from": pos, "to": to}


def _target(scope: str, node: str, vmid: Optional[int], pos: Optional[int] = None) -> str:
    if scope == "cluster":
        base = "cluster"
    elif scope == "node":
        base = f"node:{node}"
    else:
        base = f"vm:{node}/{vmid}"
    return f"{base}#{pos}" if pos is not None else base


# --------------------------------------------------------------- 选项
@router.get("/firewall/{scope}/options")
async def get_options(
    scope: str,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
    _access: None = Depends(require_vm_access),
) -> Dict[str, Any]:
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    try:
        raw = await client.get(f"{base}/options")
    except ProxmoxError as exc:
        _raise(exc)
    return _norm_options(raw or {}, scope)


@router.put("/firewall/{scope}/options")
async def update_options(
    scope: str,
    payload: FirewallOptionsIn,
    request: Request,
    node: str = Query(default=""),
    vmid: Optional[int] = Query(default=None),
    vtype: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _access: None = Depends(require_vm_access),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    _require_scope_permission(user, scope)
    client = get_client()
    base = await _scope_base(scope, node, vmid, vtype)
    data = _options_payload(scope, payload)
    try:
        await client.put(f"{base}/options", data=data)
    except ProxmoxError as exc:
        await security.audit(
            request,
            user,
            "firewall.options.update",
            target=_target(scope, node, vmid),
            result="failed",
            detail=exc.message,
        )
        _raise(exc)
    await security.audit(
        request, user, "firewall.options.update", target=_target(scope, node, vmid), detail=data
    )
    return {"ok": True, "options": data}


# --------------------------------------------------------------- 引用对象
@router.get("/firewall/refs")
async def list_refs(
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
) -> Dict[str, Any]:
    """规则编辑器用到的宏 / 别名 / IP 集合 / 安全组清单。

    安全组、IP 集合、别名都从各自的专用接口拿（形状稳定）；宏只能问
    ``/cluster/firewall/refs`` —— 而它返回什么形状随 PVE 版本变（有的版本给
    ``{macros: [...]}`` 字典，有的给 ``[{type, name}]`` 数组，实测 8.4 在没有任何
    自定义别名时直接给空数组），所以两种都兼容，拿不到就留空：
    编辑器里宏是「可手填 + 下拉建议」，不会因为拿不到清单就没法用。
    """
    client = get_client()

    async def names(path: str, key: str) -> List[str]:
        try:
            rows = await client.get(path)
        except ProxmoxError:
            return []
        out: List[str] = []
        for row in rows or []:
            if isinstance(row, dict) and row.get(key):
                out.append(str(row[key]))
        return out

    groups = await names("/cluster/firewall/groups", "group")
    ipsets = await names("/cluster/firewall/ipset", "name")
    aliases = await names("/cluster/firewall/aliases", "name")

    macros: List[str] = []
    try:
        raw = await client.get("/cluster/firewall/refs")
    except ProxmoxError:
        # 权限不足或老版本：不该拖垮整个页面
        raw = None
    if isinstance(raw, dict):
        macros = [str(m) for m in (raw.get("macros") or [])]
        aliases = aliases or [str(a) for a in (raw.get("aliases") or [])]
        ipsets = ipsets or [str(i) for i in (raw.get("ipsets") or [])]
        groups = groups or [str(g) for g in (raw.get("groups") or [])]
    elif isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type") or "").lower()
            name = str(item.get("name") or item.get("ref") or "")
            if not name:
                continue
            if kind.startswith("macro"):
                macros.append(name)
            elif kind.startswith("alias"):
                aliases.append(name)
            elif kind.startswith("ipset"):
                ipsets.append(name)
            elif kind.startswith("group"):
                groups.append(name)

    return {
        "macros": sorted(set(macros)),
        "aliases": sorted(set(aliases)),
        "ipsets": sorted(set(ipsets)),
        "groups": sorted(set(groups)),
    }


# --------------------------------------------------------------- 安全组
@router.get("/firewall/groups")
async def list_groups(
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        rows = await client.get("/cluster/firewall/groups")
    except ProxmoxError as exc:
        _raise(exc)
    return [
        {
            "group": str(r.get("group") or ""),
            "comment": str(r.get("comment") or ""),
            "digest": str(r.get("digest") or ""),
        }
        for r in (rows or [])
    ]


@router.post("/firewall/groups")
async def create_group(
    payload: FirewallGroupIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.cluster")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    data = {"group": payload.group}
    if payload.comment:
        data["comment"] = payload.comment
    try:
        await client.post("/cluster/firewall/groups", data=data)
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "firewall.group.create", target=payload.group, detail=data
    )
    return {"ok": True, "group": payload.group}


@router.delete("/firewall/groups/{group}")
async def delete_group(
    group: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.cluster")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    try:
        await client.delete(f"/cluster/firewall/groups/{group}")
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(request, user, "firewall.group.delete", target=group)
    return {"ok": True, "deleted": group}


@router.get("/firewall/groups/{group}/rules")
async def list_group_rules(
    group: str,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
) -> List[Dict[str, Any]]:
    client = get_client()
    try:
        rows = await client.get(f"/cluster/firewall/groups/{group}")
    except ProxmoxError as exc:
        _raise(exc)
    return [_norm_rule(r) for r in (rows or [])]


@router.post("/firewall/groups/{group}/rules")
async def create_group_rule(
    group: str,
    payload: FirewallRuleIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    data = _rule_payload(payload, payload.pos)
    try:
        await client.post(f"/cluster/firewall/groups/{group}", data=data)
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "firewall.group.rule.create", target=f"{group}#{payload.pos}", detail=data
    )
    return {"ok": True, "rule": data}


@router.put("/firewall/groups/{group}/rules/{pos}")
async def update_group_rule(
    group: str,
    pos: int,
    payload: FirewallRuleIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    data = _rule_payload(payload)
    try:
        await client.put(f"/cluster/firewall/groups/{group}/{pos}", data=data)
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "firewall.group.rule.update", target=f"{group}#{pos}", detail=data
    )
    return {"ok": True, "rule": data}


@router.delete("/firewall/groups/{group}/rules/{pos}")
async def delete_group_rule(
    group: str,
    pos: int,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    try:
        await client.delete(f"/cluster/firewall/groups/{group}/{pos}")
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(request, user, "firewall.group.rule.delete", target=f"{group}#{pos}")
    return {"ok": True, "deleted": pos}


# --------------------------------------------------------------- IP 集合
@router.get("/firewall/ipsets")
async def list_ipsets(
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
) -> List[Dict[str, Any]]:
    """IP 集合及其条目。条目按集合逐个拉取（PVE 没有一次性接口）。"""
    client = get_client()
    try:
        rows = await client.get("/cluster/firewall/ipset")
    except ProxmoxError as exc:
        _raise(exc)

    out: List[Dict[str, Any]] = []
    for row in rows or []:
        name = str(row.get("name") or "")
        entries: List[Dict[str, Any]] = []
        if name:
            try:
                raw = await client.get(f"/cluster/firewall/ipset/{name}")
                entries = [
                    {
                        "cidr": str(e.get("cidr") or ""),
                        "comment": str(e.get("comment") or ""),
                        "nomatch": _as_bool(e.get("nomatch")),
                    }
                    for e in (raw or [])
                ]
            except ProxmoxError:
                entries = []
        out.append(
            {
                "name": name,
                "comment": str(row.get("comment") or ""),
                "digest": str(row.get("digest") or ""),
                "entries": entries,
            }
        )
    return out


@router.post("/firewall/ipsets")
async def create_ipset(
    payload: FirewallIpsetIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.cluster")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    data = {"name": payload.name}
    if payload.comment:
        data["comment"] = payload.comment
    try:
        await client.post("/cluster/firewall/ipset", data=data)
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(request, user, "firewall.ipset.create", target=payload.name, detail=data)
    return {"ok": True, "name": payload.name}


@router.delete("/firewall/ipsets/{name}")
async def delete_ipset(
    name: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.cluster")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    try:
        await client.delete(f"/cluster/firewall/ipset/{name}")
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(request, user, "firewall.ipset.delete", target=name)
    return {"ok": True, "deleted": name}


@router.post("/firewall/ipsets/{name}/entries")
async def create_ipset_entry(
    name: str,
    payload: FirewallIpsetEntryIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    data: Dict[str, Any] = {"cidr": payload.cidr}
    if payload.comment:
        data["comment"] = payload.comment
    if payload.nomatch:
        data["nomatch"] = 1
    try:
        await client.post(f"/cluster/firewall/ipset/{name}", data=data)
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(
        request, user, "firewall.ipset.entry.create", target=f"{name}#{payload.cidr}", detail=data
    )
    return {"ok": True, "entry": data}


@router.delete("/firewall/ipsets/{name}/entries/{cidr:path}")
async def delete_ipset_entry(
    name: str,
    cidr: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    client = get_client()
    try:
        await client.delete(f"/cluster/firewall/ipset/{name}/{cidr}")
    except ProxmoxError as exc:
        _raise(exc)
    await security.audit(request, user, "firewall.ipset.entry.delete", target=f"{name}#{cidr}")
    return {"ok": True, "deleted": cidr}


# --------------------------------------------------------------- 规则模板
async def _load_templates() -> List[Dict[str, Any]]:
    raw = await store.get_setting(TEMPLATES_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


async def _save_templates(items: List[Dict[str, Any]]) -> None:
    await store.set_setting(TEMPLATES_KEY, json.dumps(items, ensure_ascii=False))


@router.get("/firewall/templates")
async def list_templates(
    user: Dict[str, Any] = Depends(security.require_permission("firewall.view")),
) -> List[Dict[str, Any]]:
    return await _load_templates()


@router.post("/firewall/templates")
async def save_template(
    payload: FirewallTemplateIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
) -> Dict[str, Any]:
    """新建或更新（带 id 即更新）一个规则模板。"""
    templates = await _load_templates()
    tpl_id = payload.id.strip() or uuid.uuid4().hex[:12]
    item = {
        "id": tpl_id,
        "name": payload.name,
        "description": payload.description,
        "enable": payload.enable,
        "policy_in": payload.policy_in or "",
        "policy_out": payload.policy_out or "",
        "rules": [rule.model_dump(exclude_none=True) for rule in payload.rules],
        "updated": int(time.time()),
        "updated_by": user.get("username", ""),
    }

    replaced = False
    for index, existing in enumerate(templates):
        if str(existing.get("id")) == tpl_id:
            templates[index] = item
            replaced = True
            break
    if not replaced:
        if len(templates) >= TEMPLATE_LIMIT:
            raise HTTPException(status_code=400, detail=f"模板最多 {TEMPLATE_LIMIT} 个")
        templates.append(item)

    await _save_templates(templates)
    await security.audit(
        request,
        user,
        "firewall.template.save",
        target=tpl_id,
        detail={"name": item["name"], "rules": len(item["rules"])},
    )
    return {"ok": True, "template": item}


@router.delete("/firewall/templates/{tpl_id}")
async def delete_template(
    tpl_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
) -> Dict[str, Any]:
    templates = await _load_templates()
    kept = [t for t in templates if str(t.get("id")) != tpl_id]
    if len(kept) == len(templates):
        raise HTTPException(status_code=404, detail="模板不存在")
    await _save_templates(kept)
    await security.audit(request, user, "firewall.template.delete", target=tpl_id)
    return {"ok": True, "deleted": tpl_id}


@router.post("/firewall/templates/{tpl_id}/apply")
async def apply_template(
    tpl_id: str,
    payload: FirewallApplyIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("firewall.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """把模板规则下发到多台虚拟机。

    默认覆盖式：先清空目标机自己的规则再写入模板规则（安全组引用不在清空范围内，
    因为它不是这台机器的规则）。逐台执行并逐台回报，一台失败不影响其它台。
    """
    templates = await _load_templates()
    template = next((t for t in templates if str(t.get("id")) == tpl_id), None)
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")

    # 模板里的规则在保存时已校验过，这里再解一遍兜住手工改库的情况
    try:
        rules = [FirewallRuleIn(**rule) for rule in (template.get("rules") or [])]
    except (ValidationError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"模板规则不合法：{exc}") from exc

    client = get_client()
    results: List[Dict[str, Any]] = []
    for target in payload.targets:
        item: Dict[str, Any] = {
            "node": target.node,
            "vmid": target.vmid,
            "ok": False,
            "removed": 0,
            "added": 0,
            "warning": "",
            "error": "",
        }
        try:
            # 普通用户只能操作自己名下的虚拟机
            await require_vm_access(user=user, node=target.node, vmid=target.vmid)
            kind = (target.type or "").strip().lower()
            if kind not in ("qemu", "lxc"):
                kind = await _vm_kind(target.node, target.vmid)
            base = f"/nodes/{target.node}/{kind}/{target.vmid}/firewall"

            if payload.replace:
                existing = await client.get(f"{base}/rules") or []
                for row in sorted(
                    existing, key=lambda r: int(r.get("pos") or 0), reverse=True
                ):
                    await client.delete(f"{base}/rules/{int(row.get('pos') or 0)}")
                    item["removed"] += 1

            for position, rule in enumerate(rules):
                # 覆盖式：清空后按模板顺序重建（显式给位置）；
                # 追加式：不带 pos，交给 PVE 依次落到末尾 —— 否则顺序会反。
                insert_at = position if payload.replace else None
                await client.post(f"{base}/rules", data=_rule_payload(rule, insert_at))
                item["added"] += 1

            options: Dict[str, Any] = {}
            if template.get("enable"):
                options["enable"] = 1
            if template.get("policy_in"):
                options["policy_in"] = template["policy_in"]
            if template.get("policy_out"):
                options["policy_out"] = template["policy_out"]
            if options:
                await client.put(f"{base}/options", data=options)

            item["warning"] = await _firewall_warning(kind, target.node, target.vmid)
            item["ok"] = True
        except HTTPException as exc:
            item["error"] = str(exc.detail)
        except ProxmoxError as exc:
            item["error"] = exc.message

        results.append(item)

    applied = sum(1 for r in results if r["ok"])
    await security.audit(
        request,
        user,
        "firewall.template.apply",
        target=tpl_id,
        result="success" if applied == len(results) else "failed",
        detail={
            "template": template.get("name", ""),
            "replace": payload.replace,
            "applied": applied,
            "failed": len(results) - applied,
            "results": results,
        },
    )
    return {"applied": applied, "failed": len(results) - applied, "results": results}
