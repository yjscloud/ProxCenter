"""跨资源全局搜索：给 Ctrl+K 命令面板供数。

为什么要一个统一的搜索接口
--------------------------
面板有 30 多个页面，虚拟机、节点、存储、用户分属四套列表接口；要在它们之间
跳转，得先想清楚「这台机器在哪个页面上」。命令面板把「找东西」这件事收敛成
一个输入框 —— 但前提是有一个接口能一次把四类资源都搜出来，否则前端要发 4 个
请求、还要自己合并排序。

每个资源组都按**对应列表页的可见范围**过滤
------------------------------------------
虚拟机走 ``routers.vms.collect_vms``（同一个归属隔离），节点 / 存储 / 用户各自
检查自己那一个权限，没权限的组直接不返回。搜索是最容易被忽略的越权入口 ——
列表页做了隔离、搜索接口忘了做，等于把入口又开了一遍。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from .. import security, store
from ..pve import ProxmoxError, all_connection_clients, get_client
from . import vms as vms_router

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

# 每组最多回几条：命令面板是「快速跳转」，不是列表页
DEFAULT_LIMIT = 5
MAX_LIMIT = 20

# 各组需要的权限。没有的组直接不出现（而不是返回空组）——
# 界面上少一个分组，比多一个「无权限」的分组干净
GROUP_PERMISSIONS = {
    "vm": "vm.view",
    "node": "node.view",
    "storage": "storage.view",
    "user": "users.view",
}

GROUP_LABELS = {
    "vm": "虚拟机 / 容器",
    "node": "节点",
    "storage": "存储",
    "user": "用户",
}


def _human_bytes(value: Any) -> str:
    """字节 → 可读容量。只用于搜索结果里的一行摘要，格式不必与前端完全一致。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if number < 1024 or unit == "TB":
            return f"{number:.0f} {unit}" if unit == "B" else f"{number:.1f} {unit}"
        number /= 1024
    return f"{number:.1f} TB"


def _matches(query: str, *fields: Any) -> bool:
    """大小写不敏感的子串匹配。空字段直接跳过。"""
    for field in fields:
        if field is None:
            continue
        if query in str(field).lower():
            return True
    return False


def _item(
    key: str, title: str, subtitle: str, link: str, badge: str = ""
) -> Dict[str, Any]:
    return {
        "key": key,
        "title": title,
        "subtitle": subtitle,
        "link": link,
        "badge": badge,
    }


async def _search_vms(
    user: Dict[str, Any], query: str, limit: int
) -> tuple[List[Dict[str, Any]], int]:
    guests = await vms_router.collect_vms(user=user, guest_type="all")
    found: List[Dict[str, Any]] = []
    for vm in guests:
        if not _matches(query, vm.get("name"), vm.get("vmid"), vm.get("node"), vm.get("tags")):
            continue
        is_lxc = str(vm.get("type")) == "lxc"
        node = str(vm.get("node") or "")
        vmid = vm.get("vmid")
        # 容器与虚拟机是两套详情页，跳错就是 404
        link = f"/{'lxc' if is_lxc else 'vms'}/{node}/{vmid}"
        badge = "模板" if vm.get("template") else ("容器" if is_lxc else "虚拟机")
        found.append(
            _item(
                key=f"vm:{vm.get('connection_id') or '-'}:{node}:{vmid}",
                title=str(vm.get("name") or f"{'CT' if is_lxc else 'VM'} {vmid}"),
                subtitle=f"{node} · VMID {vmid} · {vm.get('status') or '-'}",
                link=link,
                badge=badge,
            )
        )
    return found[:limit], len(found)


async def _search_nodes(
    query: str, limit: int
) -> tuple[List[Dict[str, Any]], int]:
    found: List[Dict[str, Any]] = []
    seen: set = set()
    for _profile, client in _targets():
        try:
            nodes = await client.nodes() or []
        except ProxmoxError:
            # 单台 PVE 连不上时其余主机的结果照常返回
            continue
        for node in nodes:
            name = str(node.get("node") or "")
            # 多台 PVE 合并时同名节点会重复出现，去重一次
            if not name or name in seen:
                continue
            if not _matches(query, name):
                continue
            seen.add(name)
            cpu = node.get("cpu")
            mem = node.get("mem")
            maxmem = node.get("maxmem")
            mem_pct = (mem / maxmem * 100) if mem and maxmem else None
            parts = [str(node.get("status") or "-")]
            if isinstance(cpu, (int, float)):
                parts.append(f"CPU {cpu * 100:.0f}%")
            if mem_pct is not None:
                parts.append(f"内存 {mem_pct:.0f}%")
            found.append(
                _item(
                    key=f"node:{name}",
                    title=name,
                    subtitle=" · ".join(parts),
                    link=f"/nodes/{name}",
                    badge="节点",
                )
            )
    return found[:limit], len(found)


async def _search_storages(
    query: str, limit: int
) -> tuple[List[Dict[str, Any]], int]:
    found: List[Dict[str, Any]] = []
    seen: set = set()
    for _profile, client in _targets():
        try:
            storages = await client.storages() or []
        except ProxmoxError:
            continue
        for storage in storages:
            name = str(storage.get("storage") or "")
            node = str(storage.get("node") or "")
            # 共享存储会在每个节点上各出现一次，按「存储名」去重
            if not name or name in seen:
                continue
            if not _matches(query, name, storage.get("type"), storage.get("content")):
                continue
            seen.add(name)
            total = storage.get("total") or 0
            used = storage.get("used") or 0
            pct = (used / total * 100) if total else None
            parts = [str(storage.get("type") or "-")]
            if pct is not None:
                parts.append(
                    f"已用 {pct:.0f}%（{_human_bytes(used)} / {_human_bytes(total)}）"
                )
            else:
                parts.append(str(storage.get("status") or "-"))
            if node:
                parts.append(node)
            found.append(
                _item(
                    key=f"storage:{name}",
                    title=name,
                    subtitle=" · ".join(parts),
                    link="/storages",
                    badge="存储",
                )
            )
    return found[:limit], len(found)


async def _search_users(
    query: str, limit: int
) -> tuple[List[Dict[str, Any]], int]:
    users = await store.list_users()
    found: List[Dict[str, Any]] = []
    for account in users:
        username = str(account.get("username") or "")
        if not _matches(query, username, account.get("email")):
            continue
        status = str(account.get("status") or "active")
        parts = [str(account.get("role") or "-")]
        if status != "active":
            parts.append("待审批" if status == "pending" else status)
        found.append(
            _item(
                key=f"user:{username}",
                title=username,
                subtitle=" · ".join(parts),
                link="/users",
                badge="用户",
            )
        )
    return found[:limit], len(found)


def _targets() -> List[Any]:
    """要遍历的 PVE 连接；一条都没配时回落到默认连接。"""
    targets = list(all_connection_clients())
    if targets:
        return targets
    client = get_client()
    if not getattr(client.conn, "configured", False):
        return []
    return [(None, client)]


@router.get("")
async def global_search(
    q: str = Query(default="", description="关键词"),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """按关键词搜虚拟机 / 节点 / 存储 / 用户，按资源类型分组返回。"""
    query = (q or "").strip().lower()
    groups: List[Dict[str, Any]] = []

    if len(query) < 1:
        return {"query": q or "", "groups": [], "total": 0}

    searchers = {
        "vm": _search_vms,
        "node": _search_nodes,
        "storage": _search_storages,
        "user": _search_users,
    }

    total = 0
    for key, searcher in searchers.items():
        if not security.has_user_permission(user, GROUP_PERMISSIONS[key]):
            continue
        try:
            if key == "vm":
                items, count = await searcher(user, query, limit)
            else:
                items, count = await searcher(query, limit)
        except Exception:  # noqa: BLE001 - 某一类查不动不该让整个面板空掉
            logger.exception("全局搜索：分组 %s 查询失败", key)
            continue
        if not items:
            continue
        total += count
        groups.append(
            {
                "key": key,
                "label": GROUP_LABELS[key],
                "count": count,
                "items": items,
            }
        )

    return {"query": q or "", "groups": groups, "total": total}
