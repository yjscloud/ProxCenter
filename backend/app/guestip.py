"""客户机 IP 的解析 —— 列表页「IP 地址」那一列的取值来源。

两条来源，顺序即优先级（都拿不到就返回空串，列表里显示「—」）：

1. **客户机内自报**：虚拟机的 Guest Agent（``qemu agent network-get-interfaces``）、
   容器的 PVE 接口（``/nodes/{node}/lxc/{vmid}/interfaces``）。读到的是**实际生效**
   的地址 —— DHCP 拿到的租约也在这里，这也是拿到 DHCP 地址的**唯一**途径；
2. **配置里的静态地址**：cloud-init 的 ``ipconfigN`` 与容器的 ``netN``。只有静态
   下发才有值，``ip=dhcp`` / ``manual`` 一律没有。

为什么要单独一个模块：原先虚拟机与容器各写了一份解析（``routers/vms.py`` /
``routers/lxc.py``），容器那份**少了第 1 条**（当时的理由是「容器没有 Guest Agent」），
于是 DHCP 下发的容器在列表里永远是空的；而虚拟机那份只认 Guest Agent 的结构，
对容器接口返回的 ``inet`` 形状也用不上。收在一处之后两边行为一致，以后要补
来源也只改这里。

两条硬约束：

* 只有**运行中**的客户机才可能自报地址（agent 不会应答；PVE 对已停止的容器也
  读不到网卡），所以非运行中直接看配置；
* 每台最多两次 PVE 请求、各有超时（默认 2 秒），失败一律降级成「拿不到」，
  绝不让整个列表接口跟着报错 —— IP 只是列表里的一列，不值当为它牺牲整页。
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

#: cloud-init ``ipconfigN`` / 容器 ``netN`` 里的 ``ip=`` 取值
IPCONFIG_RE = re.compile(r"(?:^|,)\s*ip=([^,]+)")

#: 回环与链路本地地址不该出现在列表里：它们不是「这台机器」的地址
_NOISE_PREFIXES = ("127.", "169.254.")
_NOISE_VALUES = ("::1",)


def _usable(value: str) -> bool:
    """这个地址能不能当作「业务地址」展示。"""
    if not value:
        return False
    if value.startswith(_NOISE_PREFIXES):
        return False
    if value in _NOISE_VALUES or value.lower().startswith("fe80"):
        return False
    return True


def _prefer_ipv4(candidates: List[str]) -> str:
    for value in candidates:
        if ":" not in value:
            return value
    return candidates[0] if candidates else ""


def pick_agent_ip(interfaces: List[Dict[str, Any]]) -> str:
    """从 Guest Agent 的网卡列表里挑一个可用的业务地址（优先 IPv4）。"""
    candidates: List[str] = []
    for item in interfaces or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "") == "lo":
            continue
        for addr in item.get("ip-addresses") or []:
            if not isinstance(addr, dict):
                continue
            value = str(addr.get("ip-address") or "").strip()
            if _usable(value):
                candidates.append(value)
    return _prefer_ipv4(candidates)


def pick_container_ip(interfaces: List[Dict[str, Any]]) -> str:
    """从 PVE 的容器网卡列表里挑一个地址。

    ``/nodes/{node}/lxc/{vmid}/interfaces`` 的结构与 Guest Agent 那份不同：
    一条网卡一个 dict，地址在 ``inet`` / ``inet6`` 里且**带掩码**
    （``172.16.149.50/24``），所以不能复用 agent 的解析。
    """
    candidates: List[str] = []
    for item in interfaces or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "") == "lo":
            continue
        for field in ("inet", "inet6"):
            # 同一字段偶尔会挤进多个地址（空格分隔），取第一个就够
            raw = str(item.get(field) or "").strip().split(" ")[0]
            value = raw.split("/")[0].strip()
            if _usable(value):
                candidates.append(value)
    return _prefer_ipv4(candidates)


def static_ip_from_config(cfg: Dict[str, Any]) -> str:
    """从配置里取静态 IP（``dhcp`` / ``manual`` 一律返回空串）。

    虚拟机看 cloud-init 的 ``ipconfigN``（桥接网卡 ``netN`` 里没有 IP），
    容器看 ``netN`` —— 两边的键名正好都是「前缀 + 编号」，所以一并扫掉。
    """
    keys = [k for k in (cfg or {}) if re.match(r"^(ipconfig|net)\d+$", str(k))]
    for key in sorted(keys):
        raw = str((cfg or {}).get(key) or "")
        if not raw:
            continue
        match = IPCONFIG_RE.search(raw)
        if not match:
            continue
        value = match.group(1).split("/")[0].strip()
        if not value or value.lower() in ("dhcp", "auto", "manual", "none"):
            continue
        return value
    return ""


async def _fetch_config(
    client: Any, node: str, vmid: Any, is_ct: bool, timeout: float
) -> Dict[str, Any]:
    try:
        data = await asyncio.wait_for(
            client.lxc_config(node, int(vmid))
            if is_ct
            else client.qemu_config(node, int(vmid)),
            timeout=timeout,
        )
    except Exception:  # noqa: BLE001 - 单台取不到就当「没有配置」
        return {}
    return data or {}


async def _agent_ip(client: Any, node: str, vmid: Any, timeout: float) -> str:
    try:
        interfaces = await asyncio.wait_for(
            client.qemu_agent_network(node, int(vmid)), timeout=timeout
        )
    except Exception:  # noqa: BLE001 - agent 未装 / 未响应都很常见
        return ""
    return pick_agent_ip(interfaces or [])


async def _container_iface_ip(client: Any, node: str, vmid: Any, timeout: float) -> str:
    try:
        interfaces = await asyncio.wait_for(
            client.lxc_interfaces(node, int(vmid)), timeout=timeout
        )
    except Exception:  # noqa: BLE001 - 容器没起来时 PVE 会直接报错
        return ""
    return pick_container_ip(interfaces or [])


async def resolve(client: Any, guest: Dict[str, Any], *, timeout: float = 2.0) -> str:
    """列表用：尽力解析一台客户机的 IP（虚拟机与容器都走这里）。

    ``guest`` 就是列表项（或 PVE 的 cluster resources 行）：至少要有 ``node`` /
    ``vmid``，并带上 ``type``（``lxc`` 或其它）与 ``status``。
    """
    node = guest.get("node")
    vmid = guest.get("vmid")
    if not node or vmid is None:
        return ""
    is_ct = str(guest.get("type") or "") == "lxc"
    running = str(guest.get("status") or "") == "running"

    if is_ct:
        # 静态地址就写在网卡配置里，一次请求就能定；只有拿不到、又处于运行中时，
        # 才去问容器要实际地址 —— DHCP 下发的地址只存在于那里
        ip = static_ip_from_config(await _fetch_config(client, node, vmid, True, timeout))
        if ip or not running:
            return ip
        return await _container_iface_ip(client, node, vmid, timeout)

    if running:
        # 虚拟机的真实地址优先：配置里写的可能与客户机内实际生效的不一致
        # （改过网卡、DHCP 续约），agent 自报的更可信
        ip = await _agent_ip(client, node, vmid, timeout)
        if ip:
            return ip
    return static_ip_from_config(await _fetch_config(client, node, vmid, False, timeout))


async def resolve_vm_ip(
    client: Any, node: str, vmid: Any, *, timeout: float = 5.0
) -> str:
    """只解析虚拟机：先问 Guest Agent，再退回配置里的静态地址。

    给「手上只有 node/vmid、没有列表项」的调用方用（登录审计、VM 告警）——
    与 :func:`resolve` 的虚拟机分支同一套顺序，只是不判断运行状态（那边本来就
    只对运行中的机器取数）。
    """
    if not node or not vmid:
        return ""
    ip = await _agent_ip(client, node, vmid, timeout)
    if ip:
        return ip
    return static_ip_from_config(await _fetch_config(client, node, vmid, False, timeout))
