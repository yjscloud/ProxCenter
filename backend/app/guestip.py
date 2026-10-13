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
import time
from typing import Any, Dict, List, Optional, Tuple

from . import database

logger = logging.getLogger(__name__)

#: Guest Agent / 容器网卡接口的等待上限（秒）。
#:
#: 原先定的是 2 秒，实测偏保守：**能应答的机器全在 217ms 内回来**，剩下的是永远
#: 不回话的（guest 里没装 / 没跑 agent，PVE 会一直等它）。但列表是并发发的，
#: 整张列表的响应时间等于「最慢的那一台」—— 这个值就是列表的耗时代价，所以收紧
#: 到 1.2 秒（仍是实测峰值的 5 倍余量）。
AGENT_TIMEOUT_SECONDS = 1.2

# 进程内缓存，见下面「缓存」一节的说明。
HIT_TTL_SECONDS = 60.0
MISS_TTL_SECONDS = 120.0

#: 默认连接的占位标识（空连接 id 归一成它）。取值与 metrics / ownership 一致 ——
#: 少了它，默认连接下的列表项会因「connection_id 为空」而用不上缓存与落库结果。
DEFAULT_CONNECTION = "-"

#: 落库表里「没有地址」的那条记录能保鲜多久（秒）。
#:
#: 空值**必须**落库：不落的话，每台没装 Agent 的机器都会在每次列表刷新时被问一遍、
#: 每台都拖满超时，列表又变回改造前的样子。但空值**不能无限期有效** —— 客户机装好
#: Agent、或者 DHCP 续到地址之后，那条空记录会让它永远翻不了身：列表读到空记录就
#: 不再现场解析，而唯一会写这条记录的恰恰是「现场解析」，于是再也不会解析（死锁）。
#: 现在按时间给它一个保鲜期：过期就当没缓存，重新问一次。
#: 取与内存缓存 MISS_TTL_SECONDS 同一个值，理由相同（都是「没地址」的重试间隔）。
EMPTY_TTL_SECONDS = MISS_TTL_SECONDS

#: 落库表里「有地址」的那条记录能保鲜多久（秒）。
#:
#: 不能像空值那么短：有地址的行是绝大多数，每台每次列表都去问一遍 PVE 会把列表拖回
#: 改造前。但**也不能永久有效** —— DHCP 的地址会变（续约、客户机重启），表里的值
#: 一旦写进去就再也不刷新的话，列表会一直挂着那个旧地址。15 分钟是个折中：地址最多
#: 15 分钟纠正过来，稳态下每台 15 分钟只问一次。
VALUE_TTL_SECONDS = 15 * 60.0

#: ``连接|节点|VMID|类型`` → (过期时刻, 地址)。空串表示「问过了，没有」。
_cache: Dict[str, Tuple[float, str]] = {}

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


def _agent_interfaces(payload: Any) -> List[Dict[str, Any]]:
    """从 Guest Agent 的返回里取出网卡数组。

    PVE 的结果外面套了一层 ``{"result": [...]}``（``pve.qemu_agent_network`` 现在
    已经把这层拆掉了）。这里再认一次，是给「谁又把原始响应直接递进来」留个兜底 ——
    不认的话，遍历一个 dict 只会拿到它的键名，然后被下面的 ``isinstance(item, dict)``
    全部跳过、**静默返回空**：列表页的 IP 列就这么对 DHCP 机器空了很久，而详情页
    走的是另一个函数（``formatters.normalize_agent_interfaces``，它会拆 result），
    所以看起来一切正常。
    """
    if isinstance(payload, dict):
        result = payload.get("result")
        return result if isinstance(result, list) else []
    return payload if isinstance(payload, list) else []


def pick_agent_ip(interfaces: Any) -> str:
    """从 Guest Agent 的网卡列表里挑一个可用的业务地址（优先 IPv4）。

    既接受已解包的数组，也接受 PVE 原样返回的 ``{"result": [...]}``。
    """
    candidates: List[str] = []
    for item in _agent_interfaces(interfaces):
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


# ------------------------------------------------------------------------------- 缓存
#
# 为什么需要：解析一台机器的地址要问 PVE（虚拟机的 Guest Agent / 容器的网卡接口），
# 每台一两次请求，但**代价差得很远** —— agent 正常应答是几毫秒到两百毫秒，而 guest
# 里没跑 agent、PVE 一直等它回话的那台会一直拖到超时上限。实测 12 台虚拟机里 11 台
# 在 217ms 内返回，唯独一台每次都拖满两秒；列表是并发发的（``parallel``），于是
# **一台慢机把整张列表钉死在 2 秒上**，用户每次刷新虚拟机列表都要等这么久。
#
# 所以加一层进程内缓存（与 :mod:`app.guest_created` 同一套取舍：多 worker 各持一份，
# 代价是每个 worker 各请求一轮，收益是列表本身不再为此变慢）：
#
# * **有值**的条目按 :data:`HIT_TTL_SECONDS`（60 秒）过期。刻意短命：地址是会变的
#   （DHCP 续租、换网卡、改静态下发），不能像创建时间那样缓存一整天；
# * **没值**的条目按 :data:`MISS_TTL_SECONDS`（120 秒）过期 —— 这才是上面那台慢机
#   的解药：问过一次之后两分钟内不再问它。代价是它万一把 agent 跑起来了，最晚两
#   分钟后才会显示地址（在那之前本来也一直显示「—」）；
# * 取不到（异常）与「确实没有」按同一条处理：对调用方来说都是「这台现在没有地址」。
#
# 缓存键带**连接**：多台 PVE 上可以有同名节点、同 VMID 的机器，少一段就会把别人家
# 的地址显示到这台机器上（与 :func:`guest_created.cache_key` 同一条理由）。


def _conn(conn_id: Any) -> str:
    """连接标识归一：空 / 缺省一律视作「默认连接」（见 DEFAULT_CONNECTION）。"""
    return str(conn_id) if conn_id else DEFAULT_CONNECTION


def _key(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> str:
    """缓存键：连接 + 节点 + VMID + 类型。四段都不能省，理由见上。"""
    return f"{_conn(conn_id)}|{node or ''}|{vmid or ''}|{guest_type or ''}"


def cache_key(guest: Dict[str, Any]) -> str:
    """:func:`_key` 的列表项版本（键的形状必须与 :func:`forget` 一致）。"""
    return _key(
        guest.get("connection_id"),
        guest.get("node"),
        guest.get("vmid"),
        guest.get("type"),
    )


def cached(guest: Dict[str, Any]) -> Optional[str]:
    """缓存里现有的地址；没有或已过期都返回 ``None``，且**不会**去请求 PVE。"""
    key = cache_key(guest)
    hit = _cache.get(key)
    if hit is None:
        return None
    if time.time() >= hit[0]:
        _cache.pop(key, None)
        return None
    return hit[1]


async def forget(conn_id: Any, node: Any, vmid: Any, guest_type: Any) -> None:
    """忘掉一台机器（机器被删除 / 重建时调），下次老老实实重新解析。

    参数与 :func:`guest_created.drop_record` 对齐：删除机器那两处是并排调用的，
    形状一样读起来才知道它们在做同一件事。

    内存缓存与**落库表**一起清：只清内存的话，VMID 被回收、建出同号新机器时，
    旧地址会从落库表里读出来贴到新机器上（与「旧创建时间贴到新机器」同一类问题）。
    """
    _cache.pop(_key(conn_id, node, vmid, guest_type), None)
    row_key = _row_key(conn_id, node, vmid)
    if row_key is None:
        return
    try:
        async with database.connect() as db:
            await db.execute(
                "DELETE FROM guest_ip WHERE connection_id = ? AND node = ? AND vmid = ?",
                row_key,
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 清缓存失败不该阻断删除本身
        logger.debug("清理 guest_ip 落库行失败", exc_info=True)


def clear() -> None:
    """清空进程内缓存（测试与「PVE 连接被改动」时用）。"""
    _cache.clear()


# ------------------------------------------------------------------- 落库
# 进程内缓存只能活到进程重启为止，而且每台机器都要现场问一次 PVE。这里再加一层
# 落库缓存：由后台作业（见 app.inspection.warm_guest_ip）周期性刷新，列表接口
# 优先读它 —— 于是「打开虚拟机列表」不再为一台没装 Agent 的机器等满超时。
_SCHEMA = """
CREATE TABLE IF NOT EXISTS guest_ip (
    connection_id VARCHAR(64) NOT NULL DEFAULT '',
    node          VARCHAR(64) NOT NULL DEFAULT '',
    vmid          INT         NOT NULL DEFAULT 0,
    ip            VARCHAR(64) NOT NULL DEFAULT '',
    resolved_at   BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, node, vmid),
    KEY idx_guest_ip_resolved (resolved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

_IP_COLUMNS = ("connection_id", "node", "vmid", "ip", "resolved_at")
_IP_CONFLICT = ("connection_id", "node", "vmid")


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(_SCHEMA)
        await db.commit()


def _remember(key: str, ip: str) -> None:
    """写进程内缓存：有值与没值用不同时长（理由见上面的「缓存」一节）。"""
    _cache[key] = (time.time() + (HIT_TTL_SECONDS if ip else MISS_TTL_SECONDS), ip)


def _row_key(conn_id: Any, node: Any, vmid: Any) -> Optional[Tuple[str, str, int]]:
    """落库表的主键（连接 + 节点 + VMID）；节点 / VMID 缺失时返回 ``None``。

    连接标识为空时归一成 ``DEFAULT_CONNECTION``（不是「不确定」）—— 列表项在
    默认连接下就是这个形态，归一后它们才能命中落库结果。
    """
    if node in (None, "") or vmid in (None, ""):
        return None
    try:
        number = int(vmid)
    except (TypeError, ValueError):
        return None
    return (_conn(conn_id), str(node), number)


async def _load_one(guest: Dict[str, Any]) -> Optional[Tuple[str, int]]:
    """查一台机器的落库地址：``None`` = 表里没有；否则 ``(地址, 落库时刻)``。

    地址可能是空串（当时解析不到）。能不能用由 :func:`_fresh` 判断 —— 空记录
    过期后要走现场解析。
    """
    row_key = _row_key(
        guest.get("connection_id"), guest.get("node"), guest.get("vmid")
    )
    if row_key is None:
        return None
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT ip, resolved_at FROM guest_ip "
                "WHERE connection_id = ? AND node = ? AND vmid = ?",
                row_key,
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001 - 缓存读不到不该让列表接口报错
        logger.debug("读取 guest_ip 缓存失败", exc_info=True)
        return None
    if row is None:
        return None
    return (str(row["ip"] or ""), int(row["resolved_at"] or 0))


def _fresh(ip: str, resolved_at: int) -> bool:
    """这条落库记录现在还算不算数。

    有地址的按 ``VALUE_TTL_SECONDS`` 算，没地址的按 ``EMPTY_TTL_SECONDS`` 算；
    过期就当没命中、重新现场解析一次。两个时长各自的理由见那两处说明。
    """
    ttl = VALUE_TTL_SECONDS if ip else EMPTY_TTL_SECONDS
    return (time.time() - resolved_at) < ttl


async def _load_many(
    items: List[Dict[str, Any]],
) -> Dict[Tuple[str, str, int], Tuple[str, int]]:
    """批量查落库地址：``{行键: (地址, 落库时刻)}``，供列表接口一次取回。"""
    groups: Dict[str, List[Tuple[str, int]]] = {}
    for item in items:
        row_key = _row_key(
            item.get("connection_id"), item.get("node"), item.get("vmid")
        )
        if row_key is None:
            continue
        groups.setdefault(row_key[0], []).append((row_key[1], row_key[2]))
    if not groups:
        return {}

    out: Dict[Tuple[str, str, int], Tuple[str, int]] = {}
    try:
        async with database.connect() as db:
            for conn_id, pairs in groups.items():
                vmids = sorted({vmid for _node, vmid in pairs})
                marks = ", ".join("?" for _ in vmids)
                cursor = await db.execute(
                    "SELECT node, vmid, ip, resolved_at FROM guest_ip "
                    f"WHERE connection_id = ? AND vmid IN ({marks})",
                    (conn_id, *vmids),
                )
                rows = await cursor.fetchall()
                for row in rows:
                    out[(conn_id, str(row["node"]), int(row["vmid"]))] = (
                        str(row["ip"] or ""),
                        int(row["resolved_at"] or 0),
                    )
    except Exception:  # noqa: BLE001
        logger.debug("批量读取 guest_ip 缓存失败", exc_info=True)
        return {}
    return out


async def _store_one(guest: Dict[str, Any], ip: str) -> None:
    row_key = _row_key(
        guest.get("connection_id"), guest.get("node"), guest.get("vmid")
    )
    if row_key is None:
        return
    try:
        sql = database.upsert_sql("guest_ip", _IP_COLUMNS, _IP_CONFLICT)
        async with database.connect() as db:
            await db.execute(sql, (*row_key, str(ip or "")[:64], int(time.time())))
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("写入 guest_ip 缓存失败", exc_info=True)


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


async def resolve(
    client: Any, guest: Dict[str, Any], *, timeout: float = AGENT_TIMEOUT_SECONDS
) -> str:
    """列表用：尽力解析一台客户机的 IP（虚拟机与容器都走这里）。

    ``guest`` 就是列表项（或 PVE 的 cluster resources 行）：至少要有 ``node`` /
    ``vmid``，并带上 ``type``（``lxc`` 或其它）与 ``status``。

    带进程内缓存（见上面「缓存」一节）：列表每刷新一次都会把每台机器重新问一遍，
    而其中总有一两台会一直拖到超时 —— 缓存让这种机器两分钟内只问一次。
    """
    if not guest.get("node") or guest.get("vmid") is None:
        return ""

    # 只在**带连接 id** 时走缓存。列表项都带（``collect_vms`` / ``list_containers``
    # 在解析前就填好了 connection_id）；而「手上只有 node/vmid」的一次性调用刻意
    # 排除在外，有两个理由：
    #
    # * 那些场景本来就是**反复重试**等地址的（见 vms.py 的
    #   ``_await_managed_registration``：每 20 秒问一次，等 DHCP 机器自报地址），
    #   缓存会把重试变成「两分钟才试一次」；
    # * 没有连接就分不清两台 PVE 上同名节点、同 VMID 的机器，可能把别人家的地址
    #   显示到这台机器上。
    key = cache_key(guest) if guest.get("connection_id") else ""
    if key:
        hit = _cache.get(key)
        if hit is not None and time.time() < hit[0]:
            return hit[1]
        if hit is not None:
            _cache.pop(key, None)
        # 内存没有 → 查落库表（后台预热的成果）：命中就直接用，免得为一个
        # 还没装 Agent 的机器等满超时。空记录过了保鲜期就当没命中，照常去现场问
        # 一次 —— 否则「当时没地址」会被永久锁死（见 EMPTY_TTL_SECONDS）。
        stored = await _load_one(guest)
        if stored is not None and _fresh(*stored):
            _remember(key, stored[0])
            return stored[0]

    ip = await _resolve_uncached(client, guest, timeout=timeout)
    if key:
        # 有值与没值用不同时长：地址会变，有值也只是一分钟；而「没有」要压住那台
        # 拖满超时的机器，否则每次列表刷新都要陪它等一遍。
        _remember(key, ip)
        await _store_one(guest, ip)
    return ip


async def resolve_batch(
    client: Any, items: List[Dict[str, Any]], *, limit: int = 12
) -> List[str]:
    """列表用：批量解析一批客户机的地址。

    顺序：进程内缓存 → 落库表 → 现场解析（并写回两级缓存）。稳态下全部命中
    前两级，列表不再为「一台没装 Agent 的机器」等满超时 —— 这正是改造前
    列表最慢的那个点。
    """
    results: Dict[int, str] = {}
    pending: List[int] = []
    # 先把空连接 id 归一成默认连接标识：内存缓存、落库表、resolve 三处口径必须一致，
    # 否则默认连接下的列表会既读不到缓存也写不进缓存。
    guests = [
        {**item, "connection_id": _conn(item.get("connection_id"))} for item in items
    ]
    table = await _load_many(guests)

    for index, guest in enumerate(guests):
        key = cache_key(guest)
        hit = _cache.get(key)
        if hit is not None and time.time() < hit[0]:
            results[index] = hit[1]
            continue
        row_key = _row_key(
            guest.get("connection_id"), guest.get("node"), guest.get("vmid")
        )
        if row_key is not None and row_key in table:
            ip, resolved_at = table[row_key]
            # 空记录过了保鲜期就重新解析：DHCP 的机器刚建出来时 Agent 还没起来，
            # 那一轮会记下空值；没有这条判断，它以后永远显示不出地址。
            if _fresh(ip, resolved_at):
                _remember(key, ip)
                results[index] = ip
                continue
        pending.append(index)

    if pending:
        # 延迟 import：pve 会连带一串模块，放在这里避免启动期循环依赖
        from .pve import parallel

        resolved = await parallel(
            (resolve(client, guests[index]) for index in pending), limit=limit
        )
        for index, ip in zip(pending, resolved):
            results[index] = ip if isinstance(ip, str) else ""

    return [results.get(index, "") for index in range(len(items))]


async def _resolve_uncached(
    client: Any, guest: Dict[str, Any], *, timeout: float
) -> str:
    """真正去问 PVE 的那部分（顺序与降级规则见模块说明）。"""
    node = guest.get("node")
    vmid = guest.get("vmid")
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
