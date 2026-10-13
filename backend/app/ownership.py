"""资源归属：把面板里的资源绑定到创建者，实现用户之间的数据隔离。

为什么需要单独一张表
--------------------
面板现有的权限模型只有「角色 → 权限字符串」的静态映射，没有任何资源级粒度；
而虚拟机只存在于 Proxmox 侧、面板不落库，穿透规则/告警规则此前也都是全局单份。
要做到「test 创建的虚拟机只有他自己能看见」，必须自己记录归属。

隔离规则
--------
* 管理员（role == admin）是超管视角，始终能看到并管理全部资源。
* 普通用户只能看到/操作自己名下的资源；**没有归属记录的存量资源对普通用户不可见**
  （严格隔离）。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple


from . import database

logger = logging.getLogger(__name__)

# 资源类别
#: 虚拟机（qemu）的归属。历史上容器也记在这里，现已拆到 :data:`KIND_CT`；
#: 升级时 :func:`migrate_guest_kinds` 会把存量记录改过来。
KIND_VM = "vm"
#: 容器（lxc）的归属。与 :data:`KIND_VM` 分开记录，权限也各自独立（``vm.*`` /
#: ``ct.*``）。ref 的拼法与虚拟机完全一致（``<连接>:<节点>:<vmid>``）—— VMID 在
#: 集群内唯一，同一条 ref 不可能既是虚拟机又是容器。
KIND_CT = "ct"
KIND_SNAPSHOT = "snapshot"
KIND_FRP_RULE = "frp_rule"
KIND_ALERT_RULE = "alert_rule"
# 受管主机（ssh_hosts 的一行）。ref 就是主机 id —— 主机本身没有连接/节点那层
# 复合主键，用它自己的 id 就够了。
KIND_SSH_HOST = "ssh_host"
#: 已上传到存储 import 目录里的导入文件。导入文件是**共享目录里的普通文件**，
#: 不像虚拟机那样天然带 vmid；不记归属就是「谁都能看见、谁都能删」。
KIND_IMPORT = "import"

#: 两类客户机（虚拟机 / 容器）的归属类别，顺序固定便于复用。
GUEST_KINDS: Tuple[str, ...] = (KIND_VM, KIND_CT)


def kind_for_type(guest_type: Any) -> str:
    """把 PVE 的客户机类型（``qemu`` / ``lxc``）换算成归属类别。

    认不出来的一律当虚拟机：这个参数来自 URL / 列表数据，一个拼错的值不该
    让归属校验整体报错（与 :func:`quota.normalise_kind` 同一取舍）。
    """
    return KIND_CT if str(guest_type or "").strip().lower() == "lxc" else KIND_VM



# 复合主键与索引涉及 TEXT 列，必须是定长 VARCHAR
SCHEMA = """
CREATE TABLE IF NOT EXISTS resource_owner (
    kind     VARCHAR(32)  NOT NULL,
    ref      VARCHAR(191) NOT NULL,
    username VARCHAR(64)  NOT NULL,
    created  BIGINT       NOT NULL,
    PRIMARY KEY (kind, ref),
    KEY idx_owner_user (kind, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


def import_ref(connection_id: str, storage: str, volume: str) -> str:
    """导入文件的归属标识。

    ``volume`` 是**相对卷名**（``import/xx.ova``，与 :func:`import_metadata` 收的
    同一个值），所以 ref 里带 ``/`` 是正常的；列宽 191 足够。
    """
    return f"{connection_id or '-'}:{storage}:{volume}"


def vm_ref(connection_id: str, node: str, vmid: Any) -> str:
    """虚拟机的归属标识。

    带上连接 id：多台 PVE 合并展示时，不同主机上可能存在同名节点 + 相同 VMID，
    只用 node/vmid 会把两台机器的同名虚拟机混为一谈。
    """
    return f"{connection_id or '-'}:{node}:{vmid}"


def snapshot_ref(connection_id: str, node: str, vmid: Any, name: str) -> str:
    """快照的归属标识：在所属虚拟机 ref 后追加 ``/快照名``。"""
    return f"{vm_ref(connection_id, node, vmid)}/{name}"


async def set_owner(kind: str, ref: str, username: str) -> None:
    """记录归属（重复记录时覆盖）。"""
    if not ref or not username:
        return
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "resource_owner",
                ["kind", "ref", "username", "created"],
                ["kind", "ref"],
                ["username"],
            ),
            (kind, ref, username, int(time.time())),
        )
        await db.commit()


async def delete_owner(kind: str, ref: str) -> None:
    async with database.connect() as db:
        await db.execute(
            "DELETE FROM resource_owner WHERE kind = ? AND ref = ?", (kind, ref)
        )
        await db.commit()


async def get_owner(kind: str, ref: str) -> Optional[str]:
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT username FROM resource_owner WHERE kind = ? AND ref = ?",
            (kind, ref),
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def find_refs_by_vm(
    node: str, vmid: Any, kind: Optional[str] = None
) -> List[Tuple[str, str]]:
    """按「节点 + VMID」反查归属记录，返回 ``[(connection_id, username)]``。

    ref 形如 ``<connection>:<node>:<vmid>``；节点名与连接 id 都不含 ``:``，
    所以从右侧按后缀匹配即可安全还原。表很小，直接在内存里筛选，避免给
    LIKE 通配符做转义。

    ``kind`` 留空表示**两类客户机都查** —— 连接绑定（:mod:`app.vm_scope`）只知道
    节点与 VMID、拿不到类型，必须两边都看才定位得到容器的连接。
    """
    suffix = f":{node}:{vmid}"
    kinds: Tuple[str, ...] = (kind,) if kind else GUEST_KINDS
    async with database.connect() as db:
        placeholders = ", ".join("?" for _ in kinds)
        cursor = await db.execute(
            f"SELECT ref, username FROM resource_owner WHERE kind IN ({placeholders})",
            tuple(kinds),
        )
        rows = await cursor.fetchall()

    found: List[Tuple[str, str]] = []
    for ref, username in rows:
        text = str(ref or "")
        if not text.endswith(suffix):
            continue
        # 连接 id 为空时创建记录的机器，前缀会是 "-"（表示当时用的是当前连接）
        found.append((text[: -len(suffix)] or "-", str(username or "")))
    return found


async def owners_map(kind: str) -> Dict[str, str]:
    """一次取出某个类别的全部归属，避免列表接口逐条查库。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref, username FROM resource_owner WHERE kind = ?", (kind,)
        )
        return {row[0]: row[1] for row in await cursor.fetchall()}


async def owners_map_for(kind: str) -> Dict[str, str]:
    """取某类客户机的全部归属。

    容器的归属在升级前记在 :data:`KIND_VM` 下（旧版本不区分类型）。这里把这类
    存量记录并进来，保证升级瞬间、:func:`migrate_guest_kinds` 跑完之前容器也不会
    「凭空消失」。ref 带 VMID、集群内唯一，两类之间不可能同键，所以合并是安全的。
    """
    owners = await owners_map(kind)
    if kind != KIND_CT:
        return owners
    legacy = await owners_map(KIND_VM)
    legacy.update(owners)  # 新记录（KIND_CT）优先
    return legacy


async def guest_owners_map() -> Dict[str, str]:
    """两类客户机（虚拟机 + 容器）的**合并**归属表。

    用于「记录本身不带类型」的跨类型回落判定：备份归档（vzdump 里既有 qemu 也有
    lxc）、全局快照汇总等。ref 里带 VMID、集群内唯一，合并不会串台。
    """
    owners = await owners_map(KIND_VM)
    owners.update(await owners_map(KIND_CT))
    return owners


async def get_owner_for(kind: str, ref: str) -> Optional[str]:
    """:func:`get_owner` 的客户机版本：容器会回看升级前的 ``KIND_VM`` 记录。"""
    owner = await get_owner(kind, ref)
    if owner is None and kind == KIND_CT:
        owner = await get_owner(KIND_VM, ref)
    return owner


async def list_owned(kind: str, username: str) -> List[str]:
    """某个用户名下的全部 ref。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref FROM resource_owner WHERE kind = ? AND username = ?",
            (kind, username),
        )
        return [row[0] for row in await cursor.fetchall()]


async def list_owned_guests(username: str) -> List[str]:
    """某个用户名下的全部客户机 ref（虚拟机 + 容器）。

    用于「跨类型」的读数（历史指标、AI 排查的授权范围）：这些地方拿到的是一个
    ``<连接>:<节点>:<vmid>`` 列表，两类混在一起无妨（VMID 唯一）。
    """
    refs = await list_owned(KIND_VM, username)
    refs.extend(await list_owned(KIND_CT, username))
    return refs


def vm_owner_from(
    vm_owners: Dict[str, str],
    node: Any,
    vmid: Any,
    connection_id: str = "",
) -> Optional[str]:
    """从 :func:`owners_map` 结果里按「节点 + VMID」查虚拟机归属。

    用途：快照/备份在旧版本代码里创建时没有写创建者标记，读取时先查标记、
    查不到再回落到「这台机器是谁的」，让这类存量资源在归属者名下可见。

    ref 形如 ``<连接>:<节点>:<vmid>``，连接 id 可能是记录时的 ``"-"``（当时
    未指定连接），因此不做精确键匹配，按 ``:节点:vmid`` 后缀匹配（与
    :func:`find_refs_by_vm` 同一套路）。``node`` 为空时退化为按「连接 + vmid」
    匹配——同一台 PVE 内 vmid 唯一，但必须锁定连接，防止跨主机同 vmid 串台。

    命中多条且归属人不同时无法判定（多台主机同名节点 + 相同 vmid），返回
    ``None`` 交给严格判定拒绝。
    """
    if vmid is None or not str(vmid):
        return None
    cid = connection_id or "-"
    usernames: List[str] = []
    for ref, username in vm_owners.items():
        text = str(ref)
        if node:
            if not text.endswith(f":{node}:{vmid}"):
                continue
        else:
            if not text.endswith(f":{vmid}") or text.rsplit(":", 2)[0] != cid:
                continue
        usernames.append(str(username or ""))
    if not usernames:
        return None
    unique = {u for u in usernames if u}
    if len(unique) > 1:
        return None
    return usernames[0]


# ------------------------------------------------------------------ 存量迁移
#: 一次性迁移的标记（存 settings KV）。跑完置 1，之后不再重复扫表。
SPLIT_FLAG = "ownership_guest_kind_split"


async def migrate_guest_kinds() -> int:
    """把升级前记在 :data:`KIND_VM` 下的**容器**归属搬到 :data:`KIND_CT`。

    判断「是不是容器」**不依赖 PVE**：面板自己的 ``guest_created_record`` 表里存着
    每台面板发起创建的机器的 ``guest_type``（``qemu`` / ``lxc``），升级前由
    ``routers/lxc.py`` 正常写入。所以这个迁移纯读面板库，PVE 连不上也照样能跑。

    只搬「确实有容器建机记录」的那些 ref；其余保持原样 —— 面板之外建的机器本来
    就没有归属记录（严格隔离），搬不动也无所谓。返回搬动的条数。

    跑完在 settings 里记一个标记，避免每次启动都扫表；标记写失败时下次启动重跑，
    重复搬不会有副作用（:func:`set_owner` 是 upsert）。
    """
    from . import store  # 延迟导入：store 与 ownership 都在启动期被加载，避免环

    try:
        if await store.get_setting(SPLIT_FLAG):
            return 0
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT conn_id, node, vmid FROM guest_created_record "
                "WHERE guest_type = 'lxc'"
            )
            rows = await cursor.fetchall()
    except Exception:  # noqa: BLE001 - 迁移失败不该拖住启动，下次再来
        logger.warning("容器归属迁移：读取建机记录失败，跳过", exc_info=True)
        return 0

    moved = 0
    for conn_id, node, vmid in rows or []:
        if not node or vmid is None:
            continue
        ref = vm_ref(str(conn_id or ""), str(node), vmid)
        if await get_owner(KIND_CT, ref) is not None:
            continue  # 已经是新记录（或迁移过），不动
        owner = await get_owner(KIND_VM, ref)
        if owner is None:
            continue
        await set_owner(KIND_CT, ref, owner)
        await delete_owner(KIND_VM, ref)
        moved += 1

    try:
        await store.set_setting(SPLIT_FLAG, "1")
    except Exception:  # noqa: BLE001
        logger.warning("容器归属迁移：写入标记失败，下次启动会重跑", exc_info=True)
    if moved:
        logger.info("容器归属迁移完成：%d 条记录已改记到 %s", moved, KIND_CT)
    return moved
