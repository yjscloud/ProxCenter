"""按「节点 + VMID」把请求绑定到虚拟机所在的 PVE 连接。

面板支持保存多台 Proxmox，但前端很多页面（虚拟机详情、电源操作、快照、控制台…）
只知道节点名与 VMID，请求里并没有 ``X-PVE-Connection``。若任由它落到「当前连接」：

* 轻则查不到机器（节点名在另一台主机上不存在）；
* 重则两台 PVE 有同名节点时，操作到另一台主机上的同名虚拟机；
* 普通用户还会因为归属 ref 拼不出对应连接，被判「不属于当前用户」403。

因此对 ``/vms/{node}/{vmid}/...`` 这类单机请求，在没有显式指定连接时按顺序推断：

1. 归属表里匹配 ``*:{node}:{vmid}`` 的记录 —— 面板创建的机器都有，零成本，
   而且优先取本人名下的那条，避免同名节点 + 相同 VMID 串台；
2. 逐台连接探测 ``/nodes/{node}/qemu/{vmid}/status/current`` —— 覆盖管理员视角
   与在 PVE 上直接创建的机器，命中结果缓存 :data:`_PROBE_TTL` 秒，避免详情页的
   多个并发请求重复探测。

推断不出来就保持原样（当前连接），让错误信息仍然可读。

同一套机制也覆盖 PVE 任务：``/tasks/{upid}`` 只给一个 UPID，按 UPID 里的节点与
VMID（或直接按 UPID 探测）定位主机，见 :func:`bind_task_connection`。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional, Tuple

from fastapi import Depends, Request

from . import ownership, security
from .pve import (
    ProxmoxError,
    all_connection_clients,
    bound_connection,
    node_from_upid,
    set_request_connection,
    vm_id_from_upid,
)

logger = logging.getLogger(__name__)

_NODE_OWNER_TTL = 60.0
# node -> (命中时间, 连接 id)；只缓存成功结果
_node_owner_cache: Dict[str, Tuple[float, str]] = {}

_PROBE_TTL = 60.0
# 「没探到」也要缓存：批量指派 / 连续打开多台无归属机器的详情时，命中不了任何
# 连接是**常态**（存量机器没有归属记录），不缓存就等于每台都把所有 PVE 再问一遍，
# 而且探测是串行的 HTTPS 请求，机器一多就是肉眼可见的卡顿。TTL 比命中短得多：
# 机器可能是刚建的、探测那一刻恰好不可达。
_PROBE_MISS_TTL = 15.0
_TASK_TTL = 300.0
# (node, vmid) -> (命中时间, 连接 id)；id 为空串表示「探过了，没找到」
_probe_cache: Dict[Tuple[str, int], Tuple[float, str]] = {}
# (node, vmid) -> 该键的在途探测锁：页面同时发十几个请求时只让第一个去探测，
# 其余等它出结果（否则并发请求会各自把全部连接问一遍，把延迟叠加成 N 倍）
_probe_locks: Dict[Tuple[str, int], asyncio.Lock] = {}
# upid -> (命中时间, 连接 id)；任务归属不会变，可以缓存久一点
_task_cache: Dict[str, Tuple[float, str]] = {}


def _normalize(conn_id: str) -> str:
    """归属表里记录的 "-" 表示「当时用的是当前连接」，这里还原为空串。"""
    return "" if conn_id in ("", "-") else conn_id


def _probe_cached(key: Tuple[str, int]) -> Optional[str]:
    """读探测缓存；命中返回连接 id（空串 = 已知探不到），未命中返回 None。"""
    cached = _probe_cache.get(key)
    if not cached:
        return None
    ttl = _PROBE_TTL if cached[1] else _PROBE_MISS_TTL
    if time.time() - cached[0] < ttl:
        return cached[1]
    return None


async def _probe_connection(node: str, vmid: int) -> str:
    key = (node, vmid)
    hit = _probe_cached(key)
    if hit is not None:
        return hit

    # 同一台机器的并发请求只探测一次：单飞失败时其余请求照旧各自重试，
    # 不会把一次 PVE 抖动放大成「全都失败」。
    lock = _probe_locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _probe_cached(key)
        if hit is not None:
            return hit

        # 先按虚拟机探，再按容器探：VMID 在集群内唯一，两条路径不会同时命中，
        # 但少了 lxc 这一轮，在 PVE 上直接建的容器会一直定位不到连接
        # （表现为详情 404、电源操作打到另一台主机的同名机器上）。
        answered = False
        for family in ("qemu", "lxc"):
            for profile, client in all_connection_clients():
                try:
                    await client.get(f"/nodes/{node}/{family}/{vmid}/status/current")
                except ProxmoxError:
                    # PVE 应答了（404 / 无权限 / 节点不存在）——算「问过了，没有」
                    answered = True
                    continue
                except Exception:  # noqa: BLE001 - 单台异常不影响其它连接的探测
                    logger.debug("探测 %s/%s 归属连接失败", node, vmid, exc_info=True)
                    continue
                conn_id = str(profile.get("id") or "")
                _probe_cache[key] = (time.time(), conn_id)
                return conn_id

        # 一台都没命中：记下来，别让同一批指派 / 同一页的后续请求再问一遍。
        # 只有「至少一台 PVE 应答过」才记 —— 全都连不上（网络抖动、PVE 重启）
        # 时缓存空结果，会把接下来十几秒的正常请求也判成「定位不到」。
        if answered:
            _probe_cache[key] = (time.time(), "")
        return ""


async def resolve_vm_connection(node: str, vmid: Any, owner: Optional[str]) -> str:
    """推断虚拟机所在连接的 id；无法确定时返回空串（表示沿用当前连接）。"""
    # 归属表记的是「创建时的那条连接」。那条连接被删掉之后，这些记录就变成
    # 指向一个不存在的 id —— 照它绑定，每个单机接口都会回
    # 「目标 PVE 连接不存在或已被删除」，表现是详情页整页打不开（电源、快照、
    # 改配全都连带失效）。所以只在**当前还存在**的连接里找，指向已消失连接的
    # 记录自然查不出来，落到下面的探测，由探测重新定位到真正托管它的那台 PVE。
    #
    # 查询用「候选 ref 点查」而不是把整张归属表捞回来再在内存里 endswith 过滤：
    # 后者是每次单机请求都把全表（随机器数线性增长）读进进程，批量指派时是
    # O(机器数²)；点查走 (kind, ref) 主键，只有几条记录。
    known = _known_connection_ids()
    refs = await ownership.find_refs_by_vm(node, vmid, connection_ids=known)
    if refs:
        # 同名的机器可能同时存在于多条连接上（各自有归属记录），本人名下的那条
        # 优先，其次才是「只有一条记录」这种能确定的情况。
        if owner:
            for conn_id, username in refs:
                if username == owner:
                    return _normalize(conn_id)
        if len(refs) == 1:
            return _normalize(refs[0][0])
    return await _probe_connection(node, vmid)


def _known_connection_ids() -> set:
    """当前还存在的连接 id（外加空串：归属表里的 "-" 表示「当时用的是当前连接」）。"""
    from .store import get_connections

    ids = {""}
    try:
        for conn in get_connections():
            ids.add(str(conn.get("id") or ""))
    except Exception:  # noqa: BLE001 - 存储异常时退化为「只认空串」，仍会去探测
        return {""}
    return ids


async def bind_node_connection(node: str) -> None:
    """请求没显式指定连接时，按节点名把这次请求绑到正确的那条 PVE 连接上。

    多连接部署里前端常常只发来节点名（详情页、存储页、备份下载链接…）：
    请求落到「当前连接」而那台机器上没有这个节点时，PVE 会把这个名字当主机名
    去解析，回一句 ``hostname lookup 'x' failed`` —— 看起来像 PVE 的 DNS 坏了，
    实际是请求打错了机器。这里就地纠正，调用方不必自己判断。

    只看**硬指定**（``X-PVE-Connection``）：顶栏的集群作用域是「我默认在看哪一套」，
    不该拦住这次纠正 —— 否则作用域是 A 时点开 B 的节点，请求会打到 A 上。
    """
    from . import pve

    if pve.bound_connection():
        return
    try:
        cid = await resolve_node_connection(node)
    except Exception:  # noqa: BLE001 - 定位不了就沿用当前连接，让上层报真实错误
        return
    if cid:
        pve.set_request_connection(cid)


async def resolve_node_connection(node: str) -> str:
    """节点名 → 拥有该节点的连接 id；无法确定时返回空串（沿用当前连接）。

    节点名在每台 PVE 上都是**本地的**。多主机场景下前端常常只拿得到节点名
    （存储页、备份下载链接…），请求落到「当前连接」而该连接上没有这个节点时，
    PVE 会把这个名字当主机名去解析并报 ``hostname lookup 'x' failed``。

    先问当前连接：绝大多数节点都在当前主机上，命中即可跳过对其余主机的探测。
    结果缓存 :data:`_NODE_OWNER_TTL` 秒，避免一次页面加载把每台主机问一遍。
    """
    cached = _node_owner_cache.get(node)
    if cached and time.time() - cached[0] < _NODE_OWNER_TTL:
        return cached[1]

    from .pve import get_client
    from .store import get_active_connection_id

    try:
        nodes = await get_client().nodes() or []
    except ProxmoxError:
        nodes = []
    if any(n.get("node") == node for n in nodes):
        cid = str(get_active_connection_id() or "")
        _node_owner_cache[node] = (time.time(), cid)
        return cid

    for profile, client in all_connection_clients():
        try:
            nodes = await client.nodes() or []
        except ProxmoxError:
            continue
        if any(n.get("node") == node for n in nodes):
            cid = str(profile.get("id") or "")
            _node_owner_cache[node] = (time.time(), cid)
            return cid

    return ""


async def bind_vm_connection(
    node: Optional[str] = None,
    vmid: Optional[int] = None,
    user: Dict[str, Any] = Depends(security.get_current_user),
    request: Request = None,
) -> None:
    """路由级依赖：请求未显式指定连接时，自动绑定到该虚拟机所在的 PVE。

    FastAPI 会把路径里的 ``{node}/{vmid}`` 注入进来（与 ``require_vm_access``
    同一套路）；没有这两个参数的接口取到 None，直接放行。

    只看**硬指定**：顶栏集群作用域不该拦住这次纠正（见 :func:`bind_node_connection`）。

    ``?connection_id=`` 与 ``X-PVE-Connection`` 头同义 —— 调用方已经把「这台机器
    在哪条连接上」写进请求了（归属读写接口就是这样），此时再按节点 / VMID 去
    推断纯属浪费：推断要么查一遍归属表，要么逐台 PVE 探测，批量指派时每台都要
    付这份代价。``request`` 有默认值是为了让直接调用（单测）不必构造 Request。
    """
    if not node or vmid is None or bound_connection():
        return
    hinted = ""
    if request is not None:
        hinted = str(request.query_params.get("connection_id") or "").strip()
    if hinted:
        set_request_connection(hinted)
        return
    conn_id = await resolve_vm_connection(node, vmid, security.visible_owner(user))
    if conn_id:
        set_request_connection(conn_id)


async def _probe_task_connection(node: str, upid: str) -> str:
    """任务只存在于执行它的那台 PVE，因此按 UPID 探测最准（成功结果缓存 5 分钟）。"""
    cached = _task_cache.get(upid)
    if cached and time.time() - cached[0] < _TASK_TTL:
        return cached[1]

    for profile, client in all_connection_clients():
        try:
            await client.get(f"/nodes/{node}/tasks/{upid}/status")
        except ProxmoxError:
            continue
        except Exception:  # noqa: BLE001 - 单台异常不影响其它连接的探测
            logger.debug("探测任务 %s 归属连接失败", upid, exc_info=True)
            continue
        conn_id = str(profile.get("id") or "")
        _task_cache[upid] = (time.time(), conn_id)
        return conn_id
    return ""


async def resolve_task_connection(upid: str, node: str, owner: Optional[str]) -> str:
    """定位某个 PVE 任务属于哪台连接。

    虚拟机任务（``qm*``）的 ``<id>`` 就是 VMID，先走归属表（零成本）并带上
    归属隔离；其余任务（``vzdump`` / ``aptupdate`` / ``startall``…）直接按
    UPID 探测。
    """
    vmid = vm_id_from_upid(upid)
    if vmid is not None:
        conn_id = await resolve_vm_connection(node, vmid, owner)
        if conn_id:
            return conn_id
    return await _probe_task_connection(node, upid)


async def bind_task_connection(
    upid: Optional[str] = None,
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> None:
    """路由级依赖：把任务类请求绑定到任务所在的 PVE。

    ``/tasks/{upid}`` 只给一个 UPID。不定位的话轮询会落到「当前连接」，而那台
    PVE 上根本没有这个任务，前端只能一直转圈到超时（表现为「关机中 / 删除中」
    永远不结束）。``/tasks`` 列表没有 upid，保持当前连接不动。

    只看**硬指定**：否则顶栏作用域为 A 时，在 B 上发起的任务会被当成「已指定」，
    永远不会被纠正到 B —— 正是上面那句「一直转圈」。
    """
    if bound_connection() or not upid:
        return
    target_node = node_from_upid(upid) or (node or "")
    if not target_node:
        return
    conn_id = await resolve_task_connection(
        upid, target_node, security.visible_owner(user)
    )
    if conn_id:
        set_request_connection(conn_id)
