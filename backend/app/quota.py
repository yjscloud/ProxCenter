"""额度（quota）—— 两层，最终放行取两层里最严的那个。

**第一层：全局容量护栏**（本文件上半部分，配置键 ``vm_quota`` / ``lxc_quota``）

一份全局的**台数**上限，不区分用户：它回答的是「整个集群最多还能存在多少台机器」。
按 guest 类型各记一份，两份额度互相独立：

* ``vm``  —— 虚拟机额度（沿用旧键，升级后读数不变）
* ``lxc`` —— 容器额度

为什么要拆：原先只有一份总额度，且**把容器也数进去**。于是「想限制虚拟机
台数」会连带把容器一起锁死 —— 管理员填了 20，用户建了 20 个容器后连虚拟机
都建不出来，而界面上没人说得清这 20 是被谁吃掉的。拆开之后每一类各自记账，
列表页也就能各自显示「我这类还能建几台」。

它同时是运维的**一键关闸**：填 0 即立刻禁止所有普通用户下发。

**第二层：资源额度（resource pool）**（本文件下半部分，见 :data:`LIMIT_GROUPS`）

按**所有者**（username）分配的额度，维度从「台数」扩到核数 / 内存 / 磁盘 / 快照，
并支持「单台封顶」。取值分三层，整份覆盖：

    用户级额度  ──覆盖──▶  角色默认额度  ──兜底──▶  不限制

两层的关系是**叠加**而不是替代：全局那一层是集群护栏，这一层是分配。

其余的取舍沿用原实现：

* **未设置 = 不限制**。存量部署装上这个功能不该突然被锁死，管理员显式填数才生效。
* **管理员不受限**。配额是给「下发」行为兜底的；真到上限时把管理员一起锁住，
  只会让谁都动不了手（清理、扩容都需要管理员）。
* **计数口径含模板**。模板在 PVE 里同样是一台机器，占 VMID 与存储；
  算进去才不会出现「账面上没超、实际堆了一堆」。
* **计数失败时拒绝并如实上报**（**仅第二层**）。这一点与第一层的旧行为（放行 +
  提示）**不同**，是有意分开的：额度既然按用户分配，就允许把它当作**硬边界**
  用（多租户场景），统计不准时放行等于把边界开在最不该开的地方。代价是 PVE
  抖动会暂时挡住下发，提示里会写清原因。第一层维持原样，因为它只是集群护栏，
  且它锁住的是**所有人**（含正常运维），放行更稳妥。
  两边唯一的共同例外是 ``0``：无论如何都拦。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, Request

from . import database, ownership, pvecache, security, store
from .pve import (
    ProxmoxError,
    all_connection_clients,
    client_for_connection,
    get_client,
    parallel,
    requested_connection,
)
from .vmconfig import disk_size_to_gb

logger = logging.getLogger(__name__)

# 两类 guest：虚拟机与容器，各有一份额度与计数口径
GUEST_KINDS: Tuple[str, ...] = ("vm", "lxc")
QUOTA_KEYS: Dict[str, str] = {"vm": "vm_quota", "lxc": "lxc_quota"}
KIND_LABEL: Dict[str, str] = {"vm": "虚拟机", "lxc": "容器"}
# cluster/resources 里对应的 type（两者都算「一台机器」，但这里分账统计）
RESOURCE_TYPES: Dict[str, Tuple[str, ...]] = {"vm": ("qemu",), "lxc": ("lxc",)}


def normalise_kind(kind: Optional[str]) -> str:
    """把外部传入的 kind 收进已知取值；不认识的一律当虚拟机。

    宁可当成虚拟机（旧行为）也不要抛 400：这个参数是从 URL 上来的，
    一个拼错的 kind 不该让配额读数整体报错。
    """
    text = str(kind or "").strip().lower()
    return text if text in QUOTA_KEYS else "vm"


def _key(kind: str) -> str:
    return QUOTA_KEYS[normalise_kind(kind)]


def label(kind: str) -> str:
    return KIND_LABEL[normalise_kind(kind)]


async def get_quota(kind: str = "vm") -> Optional[int]:
    """该类 guest 的总配额；``None`` 表示不限制。"""
    raw = await store.get_setting(_key(kind))
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError):
        # 配置坏了就当没配：绝不让一个坏值把创建流程卡死
        logger.warning("%s 配置损坏，已按「不限制」处理：%r", _key(kind), raw)
        return None
    return value if value >= 0 else 0


async def set_quota(kind: str, value: Optional[int]) -> Optional[int]:
    """设置该类配额；传 ``None`` 表示「不限制」（删掉这条配置）。"""
    if value is None:
        await store.delete_setting(_key(kind))
        return None
    if value < 0:
        raise ValueError("配额不能为负数")
    await store.set_setting(_key(kind), str(int(value)))
    return int(value)


async def count_guests(kind: str = "vm") -> Tuple[int, Optional[str]]:
    """统计现有该类 guest 的总数。返回 ``(台数, 错误信息)``。

    口径与 ``GET /vms?type=all`` 一致（都用 ``cluster/resources``），
    这样用户看到的台数和配额算的台数不会打架。模板一并计入 ——
    它在 PVE 里同样占一个 VMID 与一份存储。
    """
    wanted = RESOURCE_TYPES[normalise_kind(kind)]
    targets = list(all_connection_clients()) or [(None, get_client())]
    total = 0
    error: Optional[str] = None

    for _profile, client in targets:
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            # 单条连接失败只记下来继续算其余的，总数会偏小但不会整个报错
            error = error or str(exc.message)
            continue
        total += sum(
            1 for item in (resources or []) if item.get("type") in wanted
        )

    return total, error


async def usage(user: Dict[str, Any], kind: str = "vm") -> Dict[str, Any]:
    """给前端的读数：配额 / 已用 / 可下发 / 当前用户能不能建。"""
    name = normalise_kind(kind)
    quota = await get_quota(name)
    used, error = await count_guests(name)
    return {
        "kind": name,
        "label": label(name),
        "quota": quota,
        "used": used,
        # None = 不限制；否则下限截到 0，避免出现负数
        "remaining": None if quota is None else max(0, quota - used),
        "limited": quota is not None,
        "can_create": _can_create(security.is_admin(user), quota, used),
        "count_error": error,
    }


def _can_create(is_admin: bool, quota: Optional[int], used: int) -> bool:
    if is_admin:
        return True
    if quota is None:
        return True
    return quota - used > 0


async def enforce_for_create(
    user: Dict[str, Any], request: Request, kind: str = "vm"
) -> None:
    """创建该类 guest 前调用；普通用户超限时抛 403。

    只在「确实要新增一台」的入口调用（``POST /vms`` / ``POST /lxc`` 与单台克隆）。
    """
    name = normalise_kind(kind)
    if security.is_admin(user):
        return

    quota = await get_quota(name)
    if quota is None:
        return

    used, _ = await count_guests(name)
    if quota - used > 0:
        return

    noun = label(name)
    await security.audit(
        request,
        user,
        f"{'lxc' if name == 'lxc' else 'vm'}.create",
        result="denied",
        detail={"reason": "quota", "kind": name, "quota": quota, "used": used},
    )
    if quota <= 0:
        raise HTTPException(
            status_code=403, detail=f"管理员当前没有开放{noun}下发额度"
        )
    raise HTTPException(
        status_code=403,
        detail=f"可下发{noun}数量已用尽（上限 {quota} 台，当前 {used} 台），请联系管理员",
    )


# ==========================================================================
# 资源额度（resource pool）：按所有者分配的多维度额度
#
# 语义（改动前请先读一遍）：
#
# 1. **三层、整份覆盖**：用户级 → 角色默认 → 不限制。注意是「整份覆盖」而不是
#    逐字段合并 —— 用户级一旦配置，就整份生效，其中没填的字段表示「这一项不
#    限制」。否则「给某个用户解除角色设的核数上限」根本没法表达：逐字段继承时
#    ``null`` 只能解释成「继续继承」，用户只能填一个大得离谱的数字来绕过。
# 2. **配置存在 ≠ 字段有值**：整份配置存在 = 该用户不走继承；字段 ``null`` =
#    这一项不限制；``0`` = 明确禁止。只有「清除配置」才是回到继承上一层。
# 3. 本节只管**数据与读数**：存储、解析、分层取值、名下用量统计。拦截（把这些
#    数字变成 403）在后续步骤里接，接缝是 :func:`resource_report` 与
#    :func:`effective_limits`。
# ==========================================================================

#: 一类 guest 的额度字段。前四个是「名下总量」（累加），后三个是「单台封顶」。
_GUEST_LIMIT_FIELDS: Tuple[str, ...] = (
    "count",
    "cores",
    "memory_mb",
    "disk_gb",
    "max_cores",
    "max_memory_mb",
    "max_disk_gb",
)

#: 额度分组 → 字段清单。分组名与 :class:`app.schemas.QuotaLimitsIn` 一一对应。
LIMIT_GROUPS: Dict[str, Tuple[str, ...]] = {
    "vm": _GUEST_LIMIT_FIELDS,
    "ct": _GUEST_LIMIT_FIELDS,
    "snapshot": ("count", "per_guest"),
}

#: 额度分组 → 上半部分（也是 PVE）用的 guest 类型。
#: 上半部分沿用历史叫法 ``lxc``，归属 / 权限那一侧叫 ``ct``，换算只此一处 ——
#: 别在调用点各自硬编码，否则迟早有人把 ``ct`` 传进 :func:`get_quota`。
GROUP_GUEST_KIND: Dict[str, str] = {"vm": "vm", "ct": "lxc"}

#: 额度来源：给前端解释「这个数字是哪一层给的」
SOURCE_USER = "user"
SOURCE_ROLE = "role"
SOURCE_NONE = "none"

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_quota (
    username   VARCHAR(64) NOT NULL,
    quota      TEXT        NOT NULL,
    updated    BIGINT      NOT NULL,
    updated_by VARCHAR(64) NOT NULL DEFAULT '',
    PRIMARY KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    """建用户级额度表。

    ``roles.quota`` 列**不**在这里补：roles 是面板核心表，补列统一收在
    :func:`app.store.init_db`（它先于本函数执行）。
    """
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def empty_limits() -> Dict[str, Dict[str, Optional[int]]]:
    """一份「全都不限制」的额度（每个字段都是 ``None``）。"""
    return {
        group: {field: None for field in fields} for group, fields in LIMIT_GROUPS.items()
    }


def normalise_limits(raw: Any) -> Dict[str, Dict[str, Optional[int]]]:
    """把任意输入收成规范的额度结构。

    取舍与 :func:`get_quota` 一致：**坏值当没配**，不抛错 —— 这份数据可能来自
    库里被手工改过的 JSON，一个坏字段不该让整个额度体系报错。负数按 0 处理
    （0 = 明确禁止，比负数更有意义）。
    """
    out = empty_limits()
    if not isinstance(raw, dict):
        return out
    for group, fields in LIMIT_GROUPS.items():
        section = raw.get(group)
        if not isinstance(section, dict):
            continue
        for field in fields:
            value = section.get(field)
            if value is None or value == "":
                continue
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            out[group][field] = max(0, number)
    return out


def _decode_limits(text: Any) -> Dict[str, Dict[str, Optional[int]]]:
    try:
        raw = json.loads(text or "{}")
    except (TypeError, ValueError):
        logger.warning("额度配置损坏，已按「全都不限制」处理：%r", text)
        raw = {}
    return normalise_limits(raw)


def _configured_limits(raw: Any) -> Optional[Dict[str, Dict[str, Optional[int]]]]:
    """把库里的一格额度解析成额度；``NULL`` / 空串 = **没有这份配置**。

    与「存了一份空 JSON（``{}``）」的区别是整套三层取值的地基：前者表示本层不
    生效、继续往下继承，后者表示本层生效且就是不限制。这两者要是混了，
    「清除配置」和「显式不限制」就再也分不开了。
    """
    if raw is None or raw == "":
        return None
    return _decode_limits(raw)


def _limits_result(
    raw: Any = None,
    updated: Any = None,
    updated_by: Any = "",
) -> Dict[str, Any]:
    """额度行 → 统一返回结构。``raw`` 为 NULL / 空 = 这一层没配过。"""
    parsed = _configured_limits(raw)
    if parsed is None:
        return {"configured": False, "quota": None, "updated": None, "updated_by": ""}
    return {
        "configured": True,
        "quota": parsed,
        "updated": float(updated or 0) if updated is not None else None,
        "updated_by": str(updated_by or ""),
    }


async def get_user_limits(username: str) -> Dict[str, Any]:
    """读某个用户的用户级额度。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT quota, updated, updated_by FROM user_quota WHERE username = ?",
            (username,),
        )
        row = await cursor.fetchone()
    if row is None:
        return _limits_result()
    return _limits_result(row["quota"], row["updated"], row["updated_by"])


async def set_user_limits(
    username: str, limits: Optional[Dict[str, Any]], actor: str = ""
) -> Dict[str, Any]:
    """写 / 清除某个用户的额度。

    ``limits=None`` = 删掉这份配置，该用户回到继承角色默认 —— 这与「写一份字段
    全空的额度」**不同**：后者是「显式不限制」，会盖掉角色默认。
    """
    if limits is None:
        async with database.connect() as db:
            await db.execute("DELETE FROM user_quota WHERE username = ?", (username,))
            await db.commit()
        return await get_user_limits(username)

    payload = json.dumps(normalise_limits(limits), ensure_ascii=False)
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "user_quota",
                ["username", "quota", "updated", "updated_by"],
                ["username"],
                ["quota", "updated", "updated_by"],
            ),
            (username, payload, int(time.time()), str(actor or "")),
        )
        await db.commit()
    return await get_user_limits(username)


async def get_role_limits(role_id: Optional[str]) -> Dict[str, Any]:
    """读角色默认额度。角色不存在 / 该角色没配过 → ``configured=False``。"""
    if not role_id:
        return _limits_result(False)
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT quota FROM roles WHERE id = ?", (str(role_id),)
        )
        row = await cursor.fetchone()
    if row is None:
        return _limits_result()
    return _limits_result(row["quota"])


async def set_role_limits(role_id: str, limits: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """写角色默认额度。``limits=None`` = 该角色没有默认额度。

    只更新 ``quota`` 一列：角色名 / 权限归 :func:`app.store.save_role` 管，
    它的 upsert 也不含 ``quota``，两边不会互相冲掉。
    """
    payload = (
        None if limits is None else json.dumps(normalise_limits(limits), ensure_ascii=False)
    )
    async with database.connect() as db:
        await db.execute(
            "UPDATE roles SET quota = ? WHERE id = ?", (payload, str(role_id))
        )
        await db.commit()
    return await get_role_limits(role_id)


def resolve_limits(
    user_limits: Optional[Dict[str, Any]],
    role_limits: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Dict[str, Optional[int]]], str]:
    """三层取值，返回 ``(生效额度, 来源)``，来源 ∈ ``user`` / ``role`` / ``none``。

    **整份覆盖**，不是逐字段合并 —— 理由见本节开头第 1 条。
    """
    if user_limits is not None:
        return normalise_limits(user_limits), SOURCE_USER
    if role_limits is not None:
        return normalise_limits(role_limits), SOURCE_ROLE
    return empty_limits(), SOURCE_NONE


async def effective_limits(
    username: str, role: Optional[str] = None
) -> Tuple[Dict[str, Dict[str, Optional[int]]], str]:
    """某个用户最终生效的额度与来源。

    这是资源额度这一层对外的**唯一读口** —— 用量统计与拦截都从这里取额度，
    免得每个调用点自己拼两层。它**不含**第一层的全局护栏：那是另一个维度
    （全集群台数），由调用方另行取最严。
    """
    user_row = await get_user_limits(username)
    role_row = await get_role_limits(role)
    return resolve_limits(user_row["quota"], role_row["quota"])


# ==========================================================================
# 用量统计：把「名下的机器」按额度维度累加起来
#
# 口径（与用户能看到 / 能操作的范围严格一致）：
#
# * **只数名下的**：归属表里没有记录的机器不计入（存量机器对普通用户本来就
#   不可见，见 ownership 的严格隔离）。管理员也一样按自己名下算 —— 他绕过额度，
#   读数只是参考。
# * **预分配而不是实际占用**：核数 / 内存 / 磁盘都取 PVE ``cluster/resources``
#   的 ``maxcpu`` / ``maxmem`` / ``maxdisk``（配置了多大），不是实际用了多少。
# * **含模板**：模板同样占 VMID、核数、内存与磁盘（沿用第一层的口径）。
# ==========================================================================

#: 有「名下总量」用量的字段。其余字段（``max_*``）是单台封顶，没有累加值。
TOTAL_FIELDS: Tuple[str, ...] = ("count", "cores", "memory_mb", "disk_gb")

#: PVE 的客户机类型（``qemu`` / ``lxc``）→ 额度分组（``vm`` / ``ct``）。
#: 从上面既有的两张表派生，不另写一份映射 —— 命名有三套（PVE 的 ``qemu``、
#: 上半部分的 ``vm``、归属与权限的 ``ct``），多写一处就多一个出错的地方。
_KIND_TO_GROUP: Dict[str, str] = {
    pve_type: group
    for group, legacy_kind in GROUP_GUEST_KIND.items()
    for pve_type in RESOURCE_TYPES[legacy_kind]
}

#: 分配读数的缓存时长。创建之后紧接着再创建会落在同一个 TTL 内，所以**变更类接口
#: 必须调 :func:`invalidate`**（否则连续两次创建都能过额度校验）。
STATS_TTL = 5.0
_STATS_KEY = "quota:guest-rows"


def _int_field(row: Dict[str, Any], key: str) -> int:
    """取一个整数字段；缺 / 坏值按 0（PVE 各版本对可选字段的处理不一致）。"""
    try:
        return max(0, int(row.get(key) or 0))
    except (TypeError, ValueError):
        return 0


def _to_units(total_bytes: int, unit: int) -> int:
    """字节 → MB / GB，**四舍五入**。

    刻意不用向上取整：PVE 的卷常比申请的略大（LVM 按 4MiB 对齐），向上取整会把
    「申请 32G」的机器显示成 33G，用户按额度一算就莫名其妙超了。四舍五入保证
    「申请的整数就是看到的整数」，误差不超过半个单位。
    """
    return (int(total_bytes) + unit // 2) // unit


def bytes_to_gb(total_bytes: Any) -> int:
    """字节 → GB。用用量统计同一套取整规则 —— 校验和读数必须一个尺子。"""
    try:
        value = max(0, int(total_bytes or 0))
    except (TypeError, ValueError):
        value = 0
    return _to_units(value, 1024**3)


async def _build_guest_rows() -> Tuple[List[Dict[str, Any]], str]:
    """取所有连接上「一台机器一行」的分配读数。

    返回 ``(行, 错误)``：某条连接失败时把它记下来、跳过该连接，行只含成功的那些。
    **调用方必须看错误** —— 少了半边的用量会偏小，直接放行等于把额度开在最不该
    开的地方（见模块说明里的 fail-closed）。
    """
    targets = list(all_connection_clients()) or [(None, get_client())]
    rows: List[Dict[str, Any]] = []
    error = ""

    for profile, client in targets:
        cid = str((profile or {}).get("id") or "")
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            error = error or str(exc.message)
            continue
        for item in resources or []:
            kind = str(item.get("type") or "")
            if kind not in _KIND_TO_GROUP:
                continue
            rows.append(
                {
                    "connection_id": cid,
                    "node": str(item.get("node") or ""),
                    "vmid": _int_field(item, "vmid"),
                    "type": kind,
                    "cores": _int_field(item, "maxcpu"),
                    "memory_bytes": _int_field(item, "maxmem"),
                    "disk_bytes": _int_field(item, "maxdisk"),
                }
            )
    return rows, error


async def guest_rows() -> Tuple[List[Dict[str, Any]], str]:
    """上面那份读数的短 TTL 缓存版。

    列表页、创建向导、每个创建请求都会要它，而一次拉取是「每条连接一次
    ``cluster_resources``」—— 不缓存等于把 PVE 当数据库用。
    """
    return await pvecache.cached(_STATS_KEY, STATS_TTL, _build_guest_rows)


def invalidate() -> None:
    """作废分配读数缓存。**所有会改变名下资源的接口都要调它**。

    缓存只有几秒，但「创建 → 紧接着再创建」正好落在一个 TTL 里：不主动作废的话
    两次都能通过额度校验，额度就成了摆设。
    """
    pvecache.invalidate(_STATS_KEY)


async def owned_refs_for(username: str) -> Dict[str, Any]:
    """某个用户名下的归属 ref，按额度分组给好。

    容器那组带上 ``KIND_VM`` 里的 ref：与 :func:`ownership.get_owner_for` 的回落
    规则一致 —— 否则「看得见但不计数」会让用户莫名其妙地超额。
    """
    vm_refs = set(await ownership.list_owned(ownership.KIND_VM, username))
    ct_refs = set(await ownership.list_owned(ownership.KIND_CT, username))
    return {"vm": vm_refs, "ct": ct_refs | vm_refs}


def _legacy_refs(rows: List[Dict[str, Any]]) -> Dict[Tuple[Any, Any], Optional[str]]:
    """``(节点, VMID) → 无连接前缀的 ref``（歧义时给 ``None``）。

    面板早期只有单连接，归属记录里 ref 的前缀是 ``-``，而现在读数里的行带的是真实
    连接 id —— 两者永远对不上。这类记录若按严格匹配处理，会变成「用户看得见却不
    计数」：少算额度，正是 fail-closed 下最危险的方向，所以要按 node/vmid 兜一次。

    只在 (节点, VMID) **唯一**时才认：两台 PVE 上完全可能有同名节点 + 相同 VMID，
    那正是 ref 里要带连接 id 的原因。指向已删除连接的记录不在此列 —— 那种机器用户
    本来也访问不到（访问时算出的 ref 同样对不上）。
    """
    legacy: Dict[Tuple[Any, Any], Optional[str]] = {}
    for row in rows:
        key = (row.get("node"), row.get("vmid"))
        legacy[key] = (
            None  # 歧义：同样的节点 + VMID 出现在多条连接上，不猜
            if key in legacy
            else ownership.vm_ref("", row.get("node"), row.get("vmid"))
        )
    return legacy


def owned_refs_in_rows(
    rows: List[Dict[str, Any]],
    refs: Any,
) -> set:
    """把「归属表里的 ref」映射成「读数里的 ref」。

    两种 ref 可能对不上（见 :func:`_legacy_refs`）。凡是要「按读数逐台去做点什么」
    的地方都得先过这一道 —— 统计用量的 :func:`summarise_usage` 是内联的同一套
    判定，快照枚举那条路径（逐台向 PVE 查）则直接用它挑机器。
    """
    wanted = set(refs or ())
    legacy = _legacy_refs(rows)
    owned: set = set()
    for row in rows:
        ref = ownership.vm_ref(row.get("connection_id"), row.get("node"), row.get("vmid"))
        if ref in wanted or legacy.get((row.get("node"), row.get("vmid"))) in wanted:
            owned.add(ref)
    return owned


def summarise_usage(
    rows: List[Dict[str, Any]],
    refs: Dict[str, Any],
) -> Dict[str, Dict[str, int]]:
    """按归属汇总用量，返回 ``{"vm": {...}, "ct": {...}}``。

    ``rows`` 来自 :func:`_build_guest_rows`，``refs`` 来自 :func:`owned_refs_for`，
    两者都只认 ``(连接, 节点, VMID)`` 三元组（ref 的拼法由 ownership 统一提供）。
    """
    totals: Dict[str, Dict[str, int]] = {
        group: {"count": 0, "cores": 0, "memory_bytes": 0, "disk_bytes": 0}
        for group in GROUP_GUEST_KIND
    }

    legacy_ref = _legacy_refs(rows)

    for row in rows:
        group = _KIND_TO_GROUP.get(str(row.get("type") or ""))
        if group is None:
            continue
        known = refs.get(group) or set()
        ref = ownership.vm_ref(row.get("connection_id"), row.get("node"), row.get("vmid"))
        if ref not in known:
            fallback = legacy_ref.get((row.get("node"), row.get("vmid")))
            if not fallback or fallback not in known:
                continue
        totals[group]["count"] += 1
        totals[group]["cores"] += _int_field(row, "cores")
        totals[group]["memory_bytes"] += _int_field(row, "memory_bytes")
        totals[group]["disk_bytes"] += _int_field(row, "disk_bytes")

    # 字节只用来累加，对外的单位统一成 MB / GB（与额度的单位一致）
    for total in totals.values():
        total["memory_mb"] = _to_units(total.pop("memory_bytes"), 1024**2)
        total["disk_gb"] = _to_units(total.pop("disk_bytes"), 1024**3)
    return totals


def remaining_for(
    limits_group: Optional[Dict[str, Any]],
    usage_group: Optional[Dict[str, Any]],
) -> Dict[str, Optional[int]]:
    """每组额度的「还能用多少」。

    ``None`` = 这一项没配（不限制）。**可以是负数** —— 管理员下调额度之后，已经
    建出来的机器就会超过新额度，那是事实，不该被截断成 0 藏起来。
    """
    limits_group = limits_group or {}
    usage_group = usage_group or {}
    out: Dict[str, Optional[int]] = {}
    for field in TOTAL_FIELDS:
        limit = limits_group.get(field)
        out[field] = None if limit is None else int(limit) - int(usage_group.get(field) or 0)
    return out


async def resource_report(user: Dict[str, Any]) -> Dict[str, Any]:
    """额度 + 用量读数。用户侧接口（``GET /api/quota/me``）与校验共用这一份。

    快照那组与另两组不同：它的用量要逐台向 PVE 枚举（一台一次请求），所以**只在
    真的配了快照额度时才去查** —— 没配就是不限制，用量没人看，白花 N 次请求。
    """
    username = str(user.get("username") or "")
    role = str(user.get("role") or "")
    limits, source = await effective_limits(username, role)
    rows, error = await guest_rows()
    refs = await owned_refs_for(username)
    usage = summarise_usage(rows, refs)

    groups: Dict[str, Any] = {}
    for group in GROUP_GUEST_KIND:
        groups[group] = {
            "limits": limits[group],
            "usage": usage[group],
            "remaining": remaining_for(limits[group], usage[group]),
            # 非空 = 统计不全（有连接没取到），调用方必须拒绝而不是当成 0
            "error": error,
        }

    snap_limits = limits["snapshot"]
    snap_usage: Optional[Dict[str, Any]] = None
    snap_remaining: Optional[Dict[str, Any]] = None
    snap_error = ""
    if any(value is not None for value in snap_limits.values()):
        # 归属 ref → 读数 ref（存量数据的连接前缀可能对不上，见 owned_refs_in_rows）
        wanted = owned_refs_in_rows(rows, set(refs["vm"]) | set(refs["ct"]))
        counts, snap_error = await snapshot_counts(rows, wanted)
        total = sum(int(counts.get(ref) or 0) for ref in wanted)
        snap_usage = {"count": total}
        snap_remaining = remaining_for(snap_limits, snap_usage)
    groups["snapshot"] = {
        "limits": snap_limits,
        "usage": snap_usage,
        "remaining": snap_remaining,
        "error": snap_error,
    }

    return {
        "username": username,
        "role": role,
        "source": source,
        "bypass": "*" in security.effective_permissions(user),
        "groups": groups,
    }


# ==========================================================================
# 拦截：新增一台客户机之前的预检
#
# 所有「会多出一台机器」的入口都必须调 :func:`enforce_create`，否则额度只是
# 个摆设：克隆 / 从模板部署 / 导入 / 恢复备份 / 建模板都算新增。
# ==========================================================================

#: 额度的展示名（报错文案用），与 :data:`TOTAL_FIELDS` 一一对应。
_FIELD_TEXT: Dict[str, str] = {
    "count": "数量",
    "cores": "CPU 核数",
    "memory_mb": "内存",
    "disk_gb": "磁盘容量",
}

#: 总量字段 → 对应的「单台封顶」字段。``count`` 没有单台上限。
_PER_GUEST_CAP: Dict[str, str] = {
    "cores": "max_cores",
    "memory_mb": "max_memory_mb",
    "disk_gb": "max_disk_gb",
}

#: 能靠「改已有机器」长大的维度。``count`` 不在其中 —— 一台机器变不成两台。
_GROWABLE_FIELDS: Tuple[str, ...] = ("cores", "memory_mb", "disk_gb")


def group_label(group: str) -> str:
    """额度分组的中文名（虚拟机 / 容器）。"""
    return KIND_LABEL[GROUP_GUEST_KIND[group]]


def _fmt_units(field: str, value: Any) -> str:
    """把数字写成人看的样子：内存换算成 GB，其余带单位。"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0.0
    if field == "memory_mb":
        text = f"{number / 1024:.1f}".rstrip("0").rstrip(".")
        return f"{text} GB"
    if field == "count":
        return f"{int(number)} 台"
    return f"{int(number)} {'核' if field == 'cores' else 'GB'}"


def _current_connection() -> str:
    """本次请求作用于哪条连接。

    与 ``vms._op_connection`` / 导入侧拼归属 ref 用的是同一套解析：先看请求头
    指定的那条，再退到「当前活跃」的那条 —— 不这样对齐，从读数里反查来源机器
    就会因为 ref 前缀对不上而查不到。
    """
    return requested_connection() or str(store.get_active_connection_id() or "")


def _row_for(
    rows: List[Dict[str, Any]],
    node: Any,
    vmid: Any,
    connection_id: str = "",
) -> Optional[Dict[str, Any]]:
    """按「连接 + 节点 + VMID」从读数里找一台机器。

    优先精确匹配（连接 id 必须一致 —— 两台 PVE 上完全可能有同名节点 + 相同
    VMID）；请求没带连接上下文（单连接部署的常态）时，若 (节点, VMID) 唯一就认它。
    """
    want = ownership.vm_ref(connection_id, node, vmid)
    candidates = [
        row for row in rows if row.get("node") == node and str(row.get("vmid")) == str(vmid)
    ]
    chosen = next(
        (
            row
            for row in candidates
            if ownership.vm_ref(row.get("connection_id"), node, vmid) == want
        ),
        None,
    )
    if chosen is None and len(candidates) == 1:
        chosen = candidates[0]
    return chosen


def spec_from_source(
    rows: List[Dict[str, Any]],
    node: Any,
    vmid: Any,
    connection_id: str = "",
) -> Dict[str, int]:
    """从读数里取一台**已有机器**的规格。

    克隆 / 从模板部署这类操作，请求体里根本没有规格（它就是「照抄来源机器」），
    只能从既有读数里取。取不到就返回空 —— 调用方会跳过没拿到的那几项，而不是
    当成 0 放过去。
    """
    chosen = _row_for(rows, node, vmid, connection_id)
    if chosen is None:
        return {}
    return {
        "cores": _int_field(chosen, "cores"),
        "memory_mb": _to_units(_int_field(chosen, "memory_bytes"), 1024**2),
        "disk_gb": _to_units(_int_field(chosen, "disk_bytes"), 1024**3),
    }


def _cap_message(group: str, field: str, cap: Any, value: Any) -> str:
    """单台封顶的报错：只看这一台要多少，与已用量无关。"""
    return (
        f"单台{group_label(group)}{_FIELD_TEXT[field]}超过上限："
        f"上限 {_fmt_units(field, cap)}，本次需要 {_fmt_units(field, value)}"
    )


def _total_message(group: str, field: str, total: Any, used: Any, need: Any) -> str:
    """名下总量的报错：已用 + 本次。"""
    return (
        f"{group_label(group)}{_FIELD_TEXT[field]}额度不足："
        f"上限 {_fmt_units(field, total)}，已用 {_fmt_units(field, used)}，"
        f"本次需要 {_fmt_units(field, need)}"
    )


def check_limits(
    group: str,
    limits: Optional[Dict[str, Any]],
    usage: Optional[Dict[str, Any]],
    spec: Dict[str, Any],
) -> Optional[str]:
    """校验「本次要新增的这一台」是否越界；返回人话说明，``None`` = 通过。

    ``spec`` 只放**已知**的维度：拿不到的值不检查（例如恢复备份前的磁盘大小、
    导入 OVA 时由 OVF 决定的规格）。这不是「按 0 放行」，而是「不知道就不装作
    知道」—— 当成 0 会把「不清楚」变成「肯定够」，那才是真漏。
    """
    limits = limits or {}
    usage = usage or {}

    for field in TOTAL_FIELDS:
        need = spec.get(field)
        if need is None:
            continue
        try:
            need = int(need)
        except (TypeError, ValueError):
            continue

        # ① 单台封顶：与已用量无关，只看这一台要多少
        cap_field = _PER_GUEST_CAP.get(field)
        cap = limits.get(cap_field) if cap_field else None
        if cap is not None and need > int(cap):
            return _cap_message(group, field, cap, need)

        # ② 名下总量：已用 + 本次
        total = limits.get(field)
        if total is None:
            continue
        used = int(usage.get(field) or 0)
        if used + need > int(total):
            return _total_message(group, field, total, used, need)
    return None


def check_growth(
    group: str,
    limits: Optional[Dict[str, Any]],
    usage: Optional[Dict[str, Any]],
    current: Optional[Dict[str, Any]],
    final: Optional[Dict[str, Any]],
) -> Optional[str]:
    """校验「把已有的一台机器改大」是否越界；``None`` = 通过。

    与 :func:`check_limits`（新增一台）的区别在于**口径**：

    * 只有**变大**的维度才受约束（``final > current``）。缩容永远放行 —— 它是
      在往好的方向走，拿额度去拦只会让人改不动（比如想从 50 GB 缩到 20 GB，
      却因为「20 也超过单台上限 10」被挡在门外）。
    * 单台封顶看的是**改完之后**的整机值（``final``）；
    * 名下总量只看**增量**（``final - current``）—— 已用量里本来就含这台机器，
      再按整机值算会把它算两遍，用户会莫名其妙「额度不够」。
    """
    limits = limits or {}
    usage = usage or {}
    current = current or {}
    final = final or {}

    for field in _GROWABLE_FIELDS:
        new = final.get(field)
        if new is None:
            continue
        delta = int(new) - int(current.get(field) or 0)
        if delta <= 0:
            continue

        cap_field = _PER_GUEST_CAP.get(field)
        cap = limits.get(cap_field) if cap_field else None
        if cap is not None and int(new) > int(cap):
            return _cap_message(group, field, cap, new)

        total = limits.get(field)
        if total is None:
            continue
        used = int(usage.get(field) or 0)
        if used + delta > int(total):
            return _total_message(group, field, total, used, delta)
    return None


def disk_grow_delta(size: Any, current_gb: Optional[float]) -> Optional[float]:
    """把一次扩容请求的 ``size`` 换算成「要增加多少 GB」。

    PVE 的扩容接口收两种写法：

    * 增量 ``+10G`` —— 直接就是增量，不需要知道现状；
    * 绝对值 ``80G`` —— 得先知道这块盘现在多大（``current_gb``，由调用方读一次
      客户机配置解析出来）。拿不到就返回 ``None``，让调用方**跳过**这一项，
      而不是当成 0（那等于给「不知道」发通行证）。
    """
    text = str(size or "").strip()
    if not text:
        return None
    if text.startswith("+"):
        return disk_size_to_gb(text[1:])
    target = disk_size_to_gb(text)
    if target is None or current_gb is None:
        return None
    return max(0.0, float(target) - float(current_gb))


async def enforce_create(
    user: Dict[str, Any],
    request: Optional[Request],
    group: str,
    spec: Optional[Dict[str, Any]] = None,
    source: Optional[Tuple[Any, Any]] = None,
) -> None:
    """新增一台客户机之前的额度预检。越界抛 403，统计不了抛 503。

    * ``spec``：本次请求**已知**的规格（``cores`` / ``memory_mb`` / ``disk_gb``）。
    * ``source``：``(节点, VMID)`` —— 克隆 / 从模板部署这类「照抄来源机器」的
      操作，规格从既有读数里取；请求体里给了的值优先。

    三处刻意的取舍：

    1. **fail-closed**：统计拿不全（某条 PVE 连不上）时直接拒绝，而不是拿着
       残缺的数字放行 —— 那等于把额度开在最不该开的地方。用 503 而不是 403，
       好让调用方看得出「这次不是额度不够，是查不到」。
    2. **检查前先作废读数缓存**：否则「创建 → 紧接着再创建」会拿着几秒前的旧
       读数过校验（缓存本是为列表页那些高频读准备的，这里必须新鲜）。PVE 侧
       登记新机器与用量之间仍有秒级窗口，那是 PVE 任务异步造成的已知边界。
    3. **没配任何额度就提前返回**：绝大多数部署这一组全是 ``None``，不该为了
       一次创建去打扰 PVE。
    """
    if security.is_admin(user):
        return

    username = str(user.get("username") or "")
    role = str(user.get("role") or "")
    limits, _source = await effective_limits(username, role)
    group_limits = limits[group]
    if all(value is None for value in group_limits.values()):
        return

    invalidate()
    rows, error = await guest_rows()
    action = "vm" if group == "vm" else "ct"
    if error:
        await security.audit(
            request,
            user,
            f"{action}.create",
            result="denied",
            detail={"reason": "quota_stats", "group": group, "error": error},
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"暂时统计不到资源用量（{error}），已按额度策略拒绝本次下发；"
                "请稍后重试，或联系管理员。"
            ),
        )

    # 已知的按请求体为准；请求体没给的（克隆 / 恢复）从来源机器补。
    # 显式传 ``None`` 不算「知道」，所以先滤掉再合并，免得把来源的值冲掉。
    effective: Dict[str, Any] = {}
    if source is not None:
        effective.update(
            spec_from_source(rows, source[0], source[1], _current_connection())
        )
    effective.update({k: v for k, v in (spec or {}).items() if v is not None})
    effective.setdefault("count", 1)

    refs = await owned_refs_for(username)
    usage = summarise_usage(rows, refs)[group]
    problem = check_limits(group, group_limits, usage, effective)
    if not problem:
        return

    await security.audit(
        request,
        user,
        f"{action}.create",
        result="denied",
        detail={
            "reason": "quota",
            "group": group,
            "spec": effective,
            "usage": usage,
            "limits": group_limits,
        },
    )
    raise HTTPException(status_code=403, detail=problem)


async def enforce_grow(
    user: Dict[str, Any],
    request: Optional[Request],
    group: str,
    action: str,
    node: str,
    vmid: Any,
    add: Optional[Dict[str, Any]] = None,
    after: Optional[Dict[str, Any]] = None,
) -> None:
    """把**已有的一台机器改大**之前的额度预检（扩容 / 加盘 / 改核数与内存）。

    调用方只需要交代自己这次改了哪几项，两种形态任选：

    * ``add``：本次**增加**多少（如加一块 50G 的盘 → ``{"disk_gb": 50}``）；
    * ``after``：改完**之后**这一项是多少（如把核数改成 8 → ``{"cores": 8}``）。

    没交代的维度一律以读数里这台机器**当前**的规格为准（``spec_from_source``），
    所以调用方不用自己去查「这台机器现在多大」。

    不新增机器却能把资源涨上去的入口**必须**调它，否则 Step 3 建的那些额度
    只是拦住了「进门」，进门之后照样能把盘和核数涨到任意大。
    """
    if security.is_admin(user):
        return

    username = str(user.get("username") or "")
    role = str(user.get("role") or "")
    limits, _source = await effective_limits(username, role)
    group_limits = limits[group]
    if all(value is None for value in group_limits.values()):
        return

    invalidate()
    rows, error = await guest_rows()
    if error:
        await security.audit(
            request,
            user,
            action,
            result="denied",
            detail={"reason": "quota_stats", "group": group, "error": error},
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"暂时统计不到资源用量（{error}），已按额度策略拒绝本次变更；"
                "请稍后重试，或联系管理员。"
            ),
        )

    current = spec_from_source(rows, node, vmid, _current_connection())
    final: Dict[str, Any] = dict(current)
    for field, delta in (add or {}).items():
        if delta is None:
            continue
        final[field] = int(current.get(field) or 0) + int(delta)
    for field, value in (after or {}).items():
        if value is None:
            continue
        final[field] = int(value)

    # 没变大就没什么好查的（改小 / 只改了名字标签这类）：缩容是往好的方向走
    grows = {
        field: final[field]
        for field in _GROWABLE_FIELDS
        if field in final and int(final[field]) > int(current.get(field) or 0)
    }
    if not grows:
        return

    refs = await owned_refs_for(username)
    usage = summarise_usage(rows, refs)[group]
    problem = check_growth(group, group_limits, usage, current, final)
    if not problem:
        return

    await security.audit(
        request,
        user,
        action,
        result="denied",
        detail={
            "reason": "quota_grow",
            "group": group,
            "current": current,
            "final": final,
            "add": add or {},
            "usage": usage,
            "limits": group_limits,
        },
    )
    raise HTTPException(status_code=403, detail=problem)


# ==========================================================================
# 快照维度：逐台向 PVE 枚举，不用归属表里那份记账
#
# 为什么不用 ``resource_owner`` 里 ``kind='snapshot'`` 的记录计数：那份记账只在
# **面板发起的**创建 / 删除时维护 —— PVE 侧直接建或删的快照根本不在账上，删虚拟
# 机时它的快照行还会残留（见 ownership.py 里 delete_owner 的说明）。额度是
# 「这个人能占多少」的承诺，必须跟着 PVE 的事实走；代价是每台一次 PVE 请求，
# 用短缓存与后台对账把开销摊掉。
# ==========================================================================

#: 单台机器的快照数缓存时长。比集群读数（5 秒）长：快照不像建机那样连着来，而
#: 枚举是「一台一次请求」。变更类接口会主动作废（:func:`invalidate_snapshots`），
#: 后台还有对账作业定时保鲜（:func:`reconcile_snapshots`）。
SNAPSHOT_TTL = 60.0
_SNAPSHOT_PREFIX = "quota:snapshots:"


def _snapshot_key(ref: str) -> str:
    return f"{_SNAPSHOT_PREFIX}{ref}"


def invalidate_snapshots(ref: str = "") -> None:
    """作废快照计数缓存：给了 ``ref`` 只清这一台，否则全清。"""
    pvecache.invalidate(_snapshot_key(ref) if ref else _SNAPSHOT_PREFIX)


async def _fetch_snapshot_count(client: Any, kind: str, node: Any, vmid: Any) -> int:
    """数一台机器的快照。

    PVE 的列表里第一个是代表「当前状态」的伪条目 ``current``，它不是快照 ——
    忘掉这件事就会让每台机器凭空多出一张，额度跟着虚高一格。
    """
    fetch = client.lxc_snapshots if kind == "lxc" else client.qemu_snapshots
    snaps = await fetch(node, vmid) or []
    return sum(
        1
        for snap in snaps
        if str((snap or {}).get("name") or "").strip() not in ("", "current")
    )


async def _guest_snapshot_count(
    ref: str, kind: str, connection_id: str, node: Any, vmid: Any
) -> int:
    """一台机器的快照数（带缓存）。取不到时抛出底层异常，由调用方决定怎么办。"""

    async def build() -> int:
        client = client_for_connection(connection_id)
        return await _fetch_snapshot_count(client, kind, node, vmid)

    return await pvecache.cached(_snapshot_key(ref), SNAPSHOT_TTL, build)


async def snapshot_counts(
    rows: List[Dict[str, Any]],
    refs: Optional[Any] = None,
) -> Tuple[Dict[str, int], str]:
    """逐台机器的快照数：``({ref: 数量}, 错误)``。

    ``rows`` 来自 :func:`guest_rows` —— 快照列表接口 qemu 与 lxc 是两条，而 ref
    里没有类型，得靠行里的 ``type``；``refs`` 只统计这些 ref（``None`` = 全部）。

    任何一台查不到都会记进 ``错误`` 里，**由调用方决定是否放行**：额度层是
    fail-closed，读数残缺时宁可拒绝，也不要按偏小的数字放过去。
    """
    targets = [
        row
        for row in rows
        if refs is None
        or ownership.vm_ref(row.get("connection_id"), row.get("node"), row.get("vmid"))
        in refs
    ]

    async def one(row: Dict[str, Any]) -> int:
        return await _guest_snapshot_count(
            ownership.vm_ref(row.get("connection_id"), row.get("node"), row.get("vmid")),
            str(row.get("type") or ""),
            str(row.get("connection_id") or ""),
            row.get("node"),
            row.get("vmid"),
        )

    # 逐台并发但有上限：一台一次请求，集群大了串行会慢到不能用
    results = await parallel([one(row) for row in targets], limit=6)

    counts: Dict[str, int] = {}
    error = ""
    for row, result in zip(targets, results):
        ref = ownership.vm_ref(row.get("connection_id"), row.get("node"), row.get("vmid"))
        if isinstance(result, Exception):
            error = error or str(result)
            continue
        counts[ref] = int(result)
    return counts, error


def check_snapshot_limits(
    limits: Optional[Dict[str, Any]],
    guest_count: int,
    total_count: int,
) -> Optional[str]:
    """校验「再建一张快照」是否越界；``None`` = 通过。

    两项都是**新增一张**的口径（已用 + 1），与 :func:`check_limits` 一致。
    """
    limits = limits or {}
    per_guest = limits.get("per_guest")
    if per_guest is not None and int(guest_count) + 1 > int(per_guest):
        return (
            f"单台机器的快照数已达上限：上限 {int(per_guest)} 个，"
            f"这台已有 {int(guest_count)} 个"
        )
    total = limits.get("count")
    if total is not None and int(total_count) + 1 > int(total):
        return (
            f"快照总数额度不足：上限 {int(total)} 个，已用 {int(total_count)} 个，"
            "本次需要 1 个"
        )
    return None


async def enforce_snapshot(
    user: Dict[str, Any],
    request: Optional[Request],
    action: str,
    kind: str,
    node: Any,
    vmid: Any,
) -> None:
    """新建快照之前的额度预检。越界 403，读数拿不全 503（fail-closed）。

    ``kind`` 是 PVE 的类型（``qemu`` / ``lxc``）—— 调用方本来就知道自己是哪一类
    （vms.py / lxc.py / bulk.py 各一处），比反查读数更可靠。

    与建机那套的差别：快照**不计入**核数 / 内存 / 磁盘。那三项记的是预分配容量，
    快照不改配置；它另有自己的一组额度（``snapshot``）。
    """
    if security.is_admin(user):
        return

    username = str(user.get("username") or "")
    role = str(user.get("role") or "")
    limits, _source = await effective_limits(username, role)
    snap_limits = limits["snapshot"]
    if all(value is None for value in snap_limits.values()):
        return

    connection_id = _current_connection()
    target_ref = ownership.vm_ref(connection_id, node, vmid)
    # 这台刚建过快照的话，缓存里的旧数字会让下一张也过关 —— 先作废再读
    invalidate_snapshots(target_ref)

    rows, error = await guest_rows()
    if error:
        await security.audit(
            request,
            user,
            action,
            result="denied",
            detail={"reason": "quota_stats", "group": "snapshot", "error": error},
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"暂时统计不到资源用量（{error}），已按额度策略拒绝本次操作；"
                "请稍后重试，或联系管理员。"
            ),
        )

    row = _row_for(rows, node, vmid, connection_id)
    if row is not None:
        # 读数里这台挂的是真实连接 id，与请求上下文可能不同（存量数据的情形）
        target_ref = ownership.vm_ref(row.get("connection_id"), node, vmid)
        invalidate_snapshots(target_ref)

    refs = await owned_refs_for(username)
    # 归属 ref → 读数 ref：存量数据的连接前缀可能对不上，直接用归属 ref 去筛行会
    # 把名下的机器漏掉，总数就少算了
    wanted = owned_refs_in_rows(rows, set(refs["vm"]) | set(refs["ct"])) | {target_ref}
    counts, snap_error = await snapshot_counts(rows, wanted)
    if snap_error:
        await security.audit(
            request,
            user,
            action,
            result="denied",
            detail={"reason": "quota_stats", "group": "snapshot", "error": snap_error},
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"暂时统计不到快照数量（{snap_error}），已按额度策略拒绝本次操作；"
                "请稍后重试，或联系管理员。"
            ),
        )

    # 目标这台单独保证一次：它可能刚建出来还没进读数（cluster/resources 有延迟），
    # 也可能是本次请求的连接上下文与读数里的 ref 不一致。
    try:
        counts[target_ref] = await _guest_snapshot_count(
            target_ref, kind, connection_id, node, vmid
        )
    except Exception as exc:  # noqa: BLE001 - 拿不到就不放行（fail-closed）
        await security.audit(
            request,
            user,
            action,
            result="denied",
            detail={"reason": "quota_stats", "group": "snapshot", "error": str(exc)},
        )
        raise HTTPException(
            status_code=503,
            detail=(
                f"暂时统计不到这台机器的快照数量（{exc}），已按额度策略拒绝本次操作；"
                "请稍后重试，或联系管理员。"
            ),
        ) from exc

    guest_count = int(counts.get(target_ref) or 0)
    total_count = sum(int(counts.get(ref) or 0) for ref in wanted)
    problem = check_snapshot_limits(snap_limits, guest_count, total_count)
    if not problem:
        return

    await security.audit(
        request,
        user,
        action,
        result="denied",
        detail={
            "reason": "quota_snapshot",
            "group": "snapshot",
            "guest": target_ref,
            "guest_count": guest_count,
            "total_count": total_count,
            "limits": snap_limits,
        },
    )
    raise HTTPException(status_code=403, detail=problem)


async def _users_with_snapshot_limits() -> List[Tuple[str, str]]:
    """配了快照额度的 ``(用户名, 角色)``。只有这些人需要对账。

    额度可能来自用户级配置，也可能来自角色默认 —— 两边都要看，只看用户级会漏掉
    「按角色发的额度」。
    """
    targets: List[Tuple[str, str]] = []
    for user in await store.list_users():
        username = str(user.get("username") or "")
        if not username:
            continue
        limits, _source = await effective_limits(username, str(user.get("role") or ""))
        if any(value is not None for value in limits["snapshot"].values()):
            targets.append((username, str(user.get("role") or "")))
    return targets


async def reconcile_snapshots() -> Dict[str, Any]:
    """额度对账：把「配了快照额度」的用户名下的快照计数重新枚举一遍。

    读数本身就来自 PVE 枚举（没有第二份账），所以对账做的是**保鲜**：PVE 侧被手工
    增删过快照之后，缓存里可能还留着旧数字，而额度判定正是建立在这个数字上。
    定时刷一遍把这个窗口压到对账周期内，顺带把下次创建要付的枚举开销挪到后台。

    返回 ``{"users": n, "refreshed": n, "over": [...]}``；``over`` 是被调低额度后
    已经超出的用户 —— 只落日志提示，**不去改任何东西**：账实不符是既成事实，
    该由管理员决定是放宽额度还是清理资源。
    """
    targets = await _users_with_snapshot_limits()
    if not targets:
        return {"users": 0, "refreshed": 0, "over": []}

    rows, error = await guest_rows()
    if error:
        logger.warning("额度对账：集群读数不完整（%s），本轮跳过", error)
        return {"users": len(targets), "refreshed": 0, "over": [], "error": error}

    refreshed = 0
    over: List[Dict[str, Any]] = []
    for username, role in targets:
        refs = await owned_refs_for(username)
        # 归属 ref → 读数 ref：存量数据的连接前缀可能对不上（见 owned_refs_in_rows）
        wanted = owned_refs_in_rows(rows, set(refs["vm"]) | set(refs["ct"]))
        if not wanted:
            continue
        for ref in wanted:
            invalidate_snapshots(ref)
        counts, snap_error = await snapshot_counts(rows, wanted)
        if snap_error:
            logger.warning("额度对账：%s 的快照数取不全（%s），跳过", username, snap_error)
            continue
        refreshed += len(counts)

        limits, _source = await effective_limits(username, role)
        snap_limits = limits["snapshot"]
        total = sum(int(value) for value in counts.values())
        reasons: List[str] = []
        total_limit = snap_limits.get("count")
        if total_limit is not None and total > int(total_limit):
            reasons.append(f"快照总数 {total} 超过上限 {int(total_limit)}")
        per_guest = snap_limits.get("per_guest")
        if per_guest is not None:
            hotspots = [
                ref for ref, value in counts.items() if int(value) > int(per_guest)
            ]
            if hotspots:
                reasons.append(
                    f"{len(hotspots)} 台机器的快照数超过单机上限 {int(per_guest)}"
                )
        if reasons:
            over.append({"username": username, "detail": "；".join(reasons)})
            logger.warning("额度对账：%s 已超出快照额度 —— %s", username, "；".join(reasons))

    return {"users": len(targets), "refreshed": refreshed, "over": over}
