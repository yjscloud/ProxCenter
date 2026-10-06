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

import time
from typing import Any, Dict, List, Optional, Tuple


from . import database

# 资源类别
KIND_VM = "vm"
KIND_SNAPSHOT = "snapshot"
KIND_FRP_RULE = "frp_rule"
KIND_ALERT_RULE = "alert_rule"
# 受管主机（ssh_hosts 的一行）。ref 就是主机 id —— 主机本身没有连接/节点那层
# 复合主键，用它自己的 id 就够了。
KIND_SSH_HOST = "ssh_host"
#: 已上传到存储 import 目录里的导入文件。导入文件是**共享目录里的普通文件**，
#: 不像虚拟机那样天然带 vmid；不记归属就是「谁都能看见、谁都能删」。
KIND_IMPORT = "import"


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


async def find_refs_by_vm(node: str, vmid: Any, kind: str = KIND_VM) -> List[Tuple[str, str]]:
    """按「节点 + VMID」反查归属记录，返回 ``[(connection_id, username)]``。

    ref 形如 ``<connection>:<node>:<vmid>``；节点名与连接 id 都不含 ``:``，
    所以从右侧按后缀匹配即可安全还原。表很小，直接在内存里筛选，避免给
    LIKE 通配符做转义。
    """
    suffix = f":{node}:{vmid}"
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref, username FROM resource_owner WHERE kind = ?", (kind,)
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


async def list_owned(kind: str, username: str) -> List[str]:
    """某个用户名下的全部 ref。"""
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT ref FROM resource_owner WHERE kind = ? AND username = ?",
            (kind, username),
        )
        return [row[0] for row in await cursor.fetchall()]


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
