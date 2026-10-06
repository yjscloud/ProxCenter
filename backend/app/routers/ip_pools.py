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
from ..pve import ProxmoxError, all_connection_clients, get_client, parallel
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


def _config_ips(cfg: Dict[str, Any]) -> List[str]:
    """从一份 VM / 容器配置里取出所有静态 IP。

    虚拟机看 cloud-init 的 ``ipconfigN``，容器看 ``netN`` 的 ``ip=`` —— 两者是同一套
    ``key=a,b;ip=<地址>`` 语法，所以一个函数就够。``ip=dhcp`` 这类不是具体地址，
    直接跳过（拿不到地址就没法把它从池里剔掉，见 :func:`_collect_used` 的说明）。
    """
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


async def _collect_used() -> Dict[str, str]:
    """扫描**所有虚拟机与容器**的静态 IP，返回 ``{ip: 资源标识}``。

    判定依据是**配置**而不是运行状态：运行中、关机、待机、刚创建还没起来的机器，
    配置里的地址都照样算数 —— 只有它被删除、或者那个 IP 被改掉了，这个地址才会
    重新回到池子里。这就是「回收了才能被重新分配」。

    四个容易漏的地方：

    * **只扫当前连接**：地址池是**全局**的（存在 settings 里，不按 PVE 分），所以占用
      判定必须遍历**每一条**已保存的连接。曾经这里用的是 ``get_client()`` —— 只看
      当前那一条，于是另一台 PVE 上的机器占着的地址会被当成空闲再分配出去一次。
      面板是「多台 PVE 合并展示」的，池却只有一个，不对齐就会重复分配。
    * **容器**：LXC 的静态 IP 写在 ``netN`` 的 ``ip=`` 里，语法与 VM 的 ipconfigN
      相同。只扫 qemu 的话，容器占着的地址会被当成空闲再分配一次 —— 而两个设备
      拿到同一个 IP 的后果是互相抢网络。
    * **模板**：模板在 ``cluster_resources`` 里也是 ``type=qemu``，而且通常带着
      cloud-init 配置。不排除的话，一个池里会被模板的配置占掉一批地址；模板往往
      长期存在，那批地址等于永久废了。
    * **回收站**：PVE 回收站里的机器不在 cluster resources 中，它配置的地址因此会
      回到池子里。这符合直觉 —— 那台机器已经不在用了。

    还有一类**扫不到**：IP 是在系统内部手工配的（面板完全不知道），或者走 DHCP
    的（配置里只有 ``ip=dhcp``，没有具体地址）。这类机器占着的地址无法从 PVE
    侧得知，只能靠约定：需要固定地址的机器在面板里配静态 IP，才会进这个集合。
    """
    used: Dict[str, str] = {}
    for profile, client in all_connection_clients():
        label = str(profile.get("name") or profile.get("id") or "")
        try:
            resources = await client.cluster_resources("vm")
        except Exception:  # noqa: BLE001 - 一条连接读不到不影响其它主机
            continue

        targets: List[Any] = []
        for item in resources or []:
            kind = str(item.get("type") or "")
            if kind not in ("qemu", "lxc"):
                continue
            # 模板不占用地址：它是用来克隆的源，不是在网络里跑的一台机器
            if int(item.get("template") or 0) == 1:
                continue
            node = item.get("node")
            vmid = item.get("vmid")
            if not node or not vmid:
                continue
            targets.append((kind, str(node), int(vmid)))

        async def one(target: Any, _client: Any = client) -> List[str]:
            kind, node, vmid = target
            fetch = _client.qemu_config if kind == "qemu" else _client.lxc_config
            try:
                cfg = await asyncio.wait_for(fetch(node, vmid), timeout=3.0)
            except Exception:  # noqa: BLE001 - 单台读不到不影响整体
                return []
            return _config_ips(cfg)

        results = await parallel((one(t) for t in targets), limit=12)
        for res in results:
            if not isinstance(res, list):
                continue
            for ip in res:
                # 值记的是「谁占的」。同一个地址被多台机器占用时把来源都留下来 ——
                # 那是**已经发生的冲突**，值得让人知道，而不是被 setdefault 悄悄吞掉。
                if ip in used:
                    used[ip] = f"{used[ip]},{label}"
                else:
                    used[ip] = label
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
