"""IP 地址池：面板维护一批可分配的静态 IP，供创建 / 克隆虚拟机时选用。

不依赖 SDN/DHCP —— 池只是「一段可用网段 + 范围」，用于给采用 cloud-init
的虚拟机分配一个空闲静态地址；已占用地址通过扫描各 VM 的静态配置得出。
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
from typing import Any, Dict, List, Set

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import security, store
from ..pve import ProxmoxError, all_connection_clients, get_client, parallel
from ..schemas import IpPool

router = APIRouter(prefix="/api", tags=["ip-pools"])

POOLS_KEY = "ip_pools"
# 单个池最多返回的空闲地址数，避免超大网段拖垮前端。
MAX_FREE = 512

#: 归属用户名单里的这一项表示「全部用户」：任何登录用户都能看到并使用这个池。
#:
#: 用显式的 ``"*"`` 而不是「名单为空」—— 空名单那一档是**公共池（仅管理员）**，
#: 两者必须能区分开，否则升级之后老数据里那些管理员自用的池会对所有用户可见。
ALL_USERS = "*"


def _clean_owners(raw: Any) -> List[str]:
    """规范化归属用户名单：去空白、去空项、去重，并把 ``"*"`` 收敛成它自己。

    容错比"严格"重要：这一串是用户手选出来的名字，且保存走的是「整份池覆盖写」，
    读的时候一旦因为一个多余空格匹配不上，用户侧看到的就是"池不见了"。
    """
    if isinstance(raw, str):
        # 单个用户名（或空串）也当作名单：旧数据就是这种形状
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for name in raw:
        text = str(name or "").strip()
        if text and text not in out:
            out.append(text)
    # 勾了「全部用户」就不再需要具体名单：名单在这里没有额外信息，留着反而让人
    # 以为以后还要逐个维护
    return [ALL_USERS] if ALL_USERS in out else out


def _owners_of(pool: Dict[str, Any]) -> List[str]:
    """读出池的归属用户名单。

    老数据只有单值 ``owner``（用户名或空串），在这里包成名单 —— 全链路上只有这
    一处需要认识旧字段，其余代码一律只看 ``owners``。

    ``owners`` 为空名单时同样回落到 ``owner``：保存路径是 ``owners or owner``
    （见 :func:`save_ip_pools`），读的时候也照这个优先级来，否则一行同时带着
    ``owners: []`` 和 ``owner: "alice"`` 的数据会被读成公共池 —— 归属在管理员
    毫不知情的情况下被撤销。新代码写下的行不会出现这种组合（保存时会把 ``owner``
    丢掉），所以这条回落只会帮到迁移到一半 / 手工改过的数据。
    """
    owners = pool.get("owners")
    if isinstance(owners, list) and owners:
        return _clean_owners(owners)
    return _clean_owners(pool.get("owner"))


def _visible_to(pool: Dict[str, Any], username: str) -> bool:
    """普通用户能不能看到这个池：名单里有他本人，或者名单是「全部用户」。

    空名单（公共池）对普通用户不可见 —— 与单归属时代一致。
    """
    owners = _owners_of(pool)
    return ALL_USERS in owners or username in owners


def _legacy_pool_id(pool: Dict[str, Any]) -> str:
    """给没有 ``id`` 的老数据生成一个稳定 id。

    保存改成「按 id 合并」之后，没有 id 的行必须能认出「还是同一个池」。按内容
    生成而不是按下标：池的顺序会变（页面上可增删），下标一变就会被当成两个池，
    合并时旧的那个会被当成「没提交」而非「已更新」。
    """
    raw = "|".join(
        str(pool.get(k) or "") for k in ("bridge", "subnet", "start", "end", "vlan")
    )
    return "pool-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


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
    out: List[Dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        # 老数据没有 id：读的时候就补上（不落盘，下次保存时自然带回去）
        if not str(row.get("id") or "").strip():
            row = {**row, "id": _legacy_pool_id(row)}
        out.append(row)
    return out


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
    """返回可见的池，附带各自的空闲地址列表与全量已占用地址。

    普通用户只拿得到**分给自己**的池（名单里有他本人，或名单是「全部用户」）：
    池是「给谁取地址」的资源，把别人的池列进候选，选中就是往不属于自己的网段里
    塞地址。管理员不受限，公共池（名单为空）也只有管理员看得到。
    """
    pools = await _load()
    scope = security.visible_owner(user)
    if scope is not None:
        pools = [p for p in pools if _visible_to(p, scope)]
    used = await _collect_used()
    out: List[Dict[str, Any]] = []
    for pool in pools:
        free = _pool_free(pool, used)
        # 统一按 owners 出参：单值时代的 owner 只在这里兼容读取，不再往外发 ——
        # 两套字段并存的话，迟早有人读到过时的那一份
        item = {
            **pool,
            "owners": _owners_of(pool),
            "free": free,
            "free_count": len(free),
        }
        item.pop("owner", None)
        out.append(item)
    return {"pools": out, "used": sorted(used.keys())}


def _merge_for_scope(
    submitted: List[Dict[str, Any]], existing: List[Dict[str, Any]], scope: str
) -> List[Dict[str, Any]]:
    """普通用户的保存：按 id 合并，只允许改「分配给自己的」那几行。

    * 提交的行必须已存在且原本就分给自己（新增一律拒绝 —— 池是管理员分配的资源）；
    * ``owners`` 必须与旧值完全一致（能用，不能转赠）；
    * 没提交的池：自己可见的视为删除，**看不见的原样保留** —— 否则一次保存就会把
      别人的池整片覆盖掉。

    管理员不走这里（整表覆盖，行为与改造前一致）。
    """
    by_id = {str(p.get("id") or ""): p for p in existing}
    visible = {pid for pid, p in by_id.items() if _visible_to(p, scope)}
    seen: Set[str] = set()
    merged: List[Dict[str, Any]] = []
    for item in submitted:
        pid = str(item.get("id") or "")
        old = by_id.get(pid)
        if old is None:
            raise HTTPException(
                status_code=403, detail="只能修改分配给自己的地址池，不能新建"
            )
        if pid not in visible:
            raise HTTPException(status_code=403, detail="该地址池不属于当前用户")
        if _owners_of(old) != item["owners"]:
            raise HTTPException(status_code=403, detail="不能修改地址池的归属用户")
        seen.add(pid)
        merged.append(item)
    merged.extend(
        p for pid, p in by_id.items() if pid not in seen and pid not in visible
    )
    return merged


@router.put("/ip-pools")
async def save_ip_pools(
    payload: List[IpPool],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("network.manage")),
) -> Dict[str, Any]:
    """保存地址池。管理员整表覆盖；其他人只能改「分配给自己的」那几行。

    为什么非管理员不能整表覆盖：这个接口以前是无条件 ``set_setting``，任何拿到
    ``network.manage`` 的人都能改别人的 ``owners``（或填 ``["*"]``）、还能靠
    「提交里不含它」把别人的池删掉 —— 一条完整的横向提权链。现在按 id 合并：

    * 提交的行必须已存在、且原本就分给自己（新增一律拒绝，池是管理员分配的资源）；
    * ``owners`` 必须与旧值完全一致（能用，不能转赠）；
    * 没提交的池：自己可见的视为删除，**看不见的原样保留** —— 否则普通用户一保存
      就会把别人的池整片覆盖掉。

    管理员路径保持整表覆盖，行为与以前完全一致。
    """
    submitted: List[Dict[str, Any]] = []
    for pool in payload:
        item = pool.model_dump()
        # 归属用户按用户名存，顺手去掉界面可能带进来的空白与重复项，免得出现
        # 「test01 」这种看不见的差异把匹配搞丢。
        # ``or item.get("owner")`` 是给还没刷新的旧页面兜底：旧页面只发单值 owner，
        # 忽略它就等于把池改回公共池（普通用户那边这些池会直接消失）。
        item["owners"] = _clean_owners(item.get("owners") or item.get("owner"))
        item.pop("owner", None)
        if not str(item.get("id") or "").strip():
            item["id"] = _legacy_pool_id(item)
        submitted.append(item)

    scope = security.visible_owner(user)
    if scope is None:
        data = submitted
    else:
        data = _merge_for_scope(submitted, await _load(), scope)

    await store.set_setting(POOLS_KEY, json.dumps(data, ensure_ascii=False))
    await security.audit(
        request, user, "ip_pools.save", target="ip_pools",
        detail={"count": len(data), "scope": scope or "*"},
    )
    return {"pools": data}
