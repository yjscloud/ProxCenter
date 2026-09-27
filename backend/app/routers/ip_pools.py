"""IP 地址池：面板维护一批可分配的静态 IP，供创建 / 克隆虚拟机时选用。

不依赖 SDN/DHCP —— 池只是「一段可用网段 + 范围」，用于给采用 cloud-init
的虚拟机分配一个空闲静态地址；已占用地址通过扫描各 VM 的静态配置得出。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Request

from .. import security, store
from ..pve import ProxmoxError, get_client, parallel
from ..schemas import IpPool

router = APIRouter(prefix="/api", tags=["ip-pools"])

POOLS_KEY = "ip_pools"
# 单个池最多返回的空闲地址数，避免超大网段拖垮前端。
MAX_FREE = 512


async def _load() -> List[Dict[str, Any]]:
    raw = await store.get_setting(POOLS_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [d for d in data if isinstance(d, dict)]


def _ip_only(value: str) -> str:
    return str(value or "").split("/")[0].strip()


async def _collect_used() -> Dict[str, str]:
    """扫描所有 VM 的 cloud-init / 网卡静态 IP，返回 {ip: vmid}。"""
    client = get_client()
    try:
        resources = await client.cluster_resources("vm")
    except ProxmoxError:
        return {}
    vms = [r for r in (resources or []) if r.get("type") == "qemu"]

    async def one(vm: Dict[str, Any]) -> List[str]:
        node = vm.get("node")
        vmid = vm.get("vmid")
        if not node or not vmid:
            return []
        try:
            cfg = await asyncio.wait_for(
                client.qemu_config(node, int(vmid)), timeout=3.0
            )
        except Exception:  # noqa: BLE001 - 单个 VM 失败不影响整体
            return []
        ips: List[str] = []
        for key, val in (cfg or {}).items():
            if not isinstance(val, str):
                continue
            if not (key.startswith("ipconfig") or key.startswith("net")):
                continue
            for seg in val.split(","):
                seg = seg.strip()
                if not seg.startswith("ip="):
                    continue
                ip = _ip_only(seg[3:])
                if not ip:
                    continue
                if ip.lower() in ("dhcp", "auto", "manual", "none"):
                    continue
                if ip.startswith("127."):
                    continue
                ips.append(ip)
        return ips

    results = await parallel((one(vm) for vm in vms), limit=12)
    used: Dict[str, str] = {}
    for res in results:
        if isinstance(res, list):
            for ip in res:
                used.setdefault(ip, "")
    return used


def _pool_free(pool: Dict[str, Any], used: Dict[str, str]) -> List[str]:
    """列出池内空闲地址（排除网络号、广播地址与网关）。"""
    subnet = str(pool.get("subnet") or "").strip()
    start = str(pool.get("start") or "").strip()
    end = str(pool.get("end") or "").strip()
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return []
    if net.version != 4:
        return []

    try:
        lo = ipaddress.ip_address(start) if start else net.network_address + 1
        hi = ipaddress.ip_address(end) if end else net.broadcast_address - 1
    except ValueError:
        return []
    if int(lo) > int(hi):
        return []

    gateway = _ip_only(str(pool.get("gateway") or ""))
    free: List[str] = []
    cur = int(lo)
    last = int(hi)
    while cur <= last and len(free) < MAX_FREE:
        addr = ipaddress.ip_address(cur)
        s = str(addr)
        if (
            addr != net.network_address
            and addr != net.broadcast_address
            and s not in used
            and s != gateway
        ):
            free.append(s)
        cur += 1
    return free


@router.get("/ip-pools")
async def get_ip_pools(
    user: Dict[str, Any] = Depends(security.require_permission("network.view")),
) -> Dict[str, Any]:
    """返回所有池，附带各自的空闲地址列表与全量已占用地址。"""
    pools = await _load()
    used = await _collect_used()
    out: List[Dict[str, Any]] = []
    for pool in pools:
        free = _pool_free(pool, used)
        out.append({**pool, "free": free, "free_count": len(free)})
    return {"pools": out, "used": sorted(used.keys())}


@router.put("/ip-pools")
async def save_ip_pools(
    payload: List[IpPool],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    data = [p.model_dump() for p in payload]
    await store.set_setting(POOLS_KEY, json.dumps(data, ensure_ascii=False))
    await security.audit(
        request, user, "ip_pools.save", target="ip_pools",
        detail={"count": len(data)},
    )
    return {"pools": data}
