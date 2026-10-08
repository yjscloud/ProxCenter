"""多机 SSH 安全：用 SSH 凭据去远程主机上读日志、管 fail2ban。

面板本机看的是自己（见 :mod:`app.sshguard`），其它宿主机靠这里：存 SSH 凭据、
连上去执行**固定几条命令**，把输出交给 sshguard 的解析器，得到与本机一致的
结构，再统一展示与告警。

三条底线：

1. **只跑我们拼好的命令**：IP、jail 名这类外部输入先过白名单正则，命令里
   不会出现用户可控的原文，也不用 `shell=True`。
2. **主机指纹要验**：第一次连接时记住指纹（需管理员显式确认），之后指纹变了
   一律拒绝 —— 中间人比暴力破解更隐蔽。
3. **口令与私钥加密落库**，接口只回 `secret_set`，明文永不回传前端。

paramiko 是阻塞库，所有调用都用 ``asyncio.to_thread`` 丢到线程里跑，
不堵住事件循环。
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

import paramiko

from . import alerting, crypto, database, i18n, localhost, sshguard, store

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ssh_hosts (
    id          VARCHAR(64) NOT NULL,
    name        VARCHAR(128) NOT NULL,
    host        VARCHAR(128) NOT NULL,
    port        INT DEFAULT 22,
    username    VARCHAR(64) NOT NULL DEFAULT 'root',
    auth_type   VARCHAR(16) DEFAULT 'key',
    secret      TEXT,
    use_sudo    TINYINT DEFAULT 0,
    log_source  VARCHAR(16) DEFAULT 'auto',
    enabled     TINYINT DEFAULT 1,
    known_host  VARCHAR(128) DEFAULT '',
    updated     BIGINT,
    updated_by  VARCHAR(64) DEFAULT '',
    origin      VARCHAR(16) NOT NULL DEFAULT 'manual',
    -- 「面板下发」时记下来源虚拟机：机器被删时靠它把四套安全数据一起清掉
    -- （见 purge_vm_hosts / reconcile_panel_hosts）。手工添加的主机留空。
    node        VARCHAR(64) NOT NULL DEFAULT '',
    vmid        INT DEFAULT NULL,
    conn_id     VARCHAR(64) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY idx_ssh_hosts_host (host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

#: 用户手工添加（唯一的老路径）
ORIGIN_MANUAL = "manual"
#: 面板下发虚拟机时自动登记 —— 这类主机：
#:   * 凭据用的是面板统一的密钥对（见 :mod:`app.panelkey`）；
#:   * 首次连接**自动信任**指纹（是我们自己刚建的机器，没有中间人的机会）；
#:   * 界面上标注来源，避免用户把它当成自己加的那台。
ORIGIN_PANEL = "panel"

#: 「勾了接入安全管控、但地址要等机器自己报」的机器的待登记队列（settings 里的 JSON）。
#: DHCP 下发的机器属于这一类：地址要等 Guest Agent 应答才知道。
PENDING_KEY = "managed_host_pending"
#: 队列项的保鲜期：超期就丢（机器被删了，或者镜像里没有 agent、永远报不出地址）
PENDING_TTL = 24 * 3600
#: 队列长度上限：防脏数据无限膨胀
PENDING_MAX = 200

# 远程命令的超时：日志可能很大，但也不该拖死面板
DEFAULT_TIMEOUT = 20
LOG_TIMEOUT = 30

# 日志读取：优先 journalctl（systemd 通用），拿不到再 tail 日志文件
READ_LOG_CMD = (
    "journalctl -u ssh -u sshd --since @{since} -o short-iso --no-pager -n 20000"
    " || tail -n 20000 /var/log/secure 2>/dev/null || tail -n 20000 /var/log/auth.log 2>/dev/null"
)


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        # 旧库补列。origin 标记这台主机的来源，DEFAULT 'manual' 让存量主机都算
        # 「用户手工添加」—— 这也正是事实：面板此前没有自动登记这条路径。
        columns = await database.table_columns(db, "ssh_hosts")
        if "origin" not in columns:
            await db.execute(
                "ALTER TABLE ssh_hosts ADD COLUMN origin VARCHAR(16)"
                " NOT NULL DEFAULT 'manual'"
            )
        # 来源虚拟机（连接 + VMID）：存量行留空 —— 它们对应的机器早就建完了，
        # 面板无从回填，而留空只会让这台主机**不会**被自动清理（保守方向）。
        if "node" not in columns:
            await db.execute(
                "ALTER TABLE ssh_hosts ADD COLUMN node VARCHAR(64) NOT NULL DEFAULT ''"
            )
        if "vmid" not in columns:
            await db.execute("ALTER TABLE ssh_hosts ADD COLUMN vmid INT DEFAULT NULL")
        if "conn_id" not in columns:
            await db.execute(
                "ALTER TABLE ssh_hosts ADD COLUMN conn_id VARCHAR(64) NOT NULL DEFAULT ''"
            )
        await db.commit()


# ------------------------------------------------------------------ 主机 CRUD

def _as_vmid(value: Any) -> Optional[int]:
    """把库里的 vmid 归一成 int；空值 / 脏值一律当「没有」。"""
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def public_host(row: Dict[str, Any]) -> Dict[str, Any]:
    """对外只暴露「是否设置了凭据」，私钥 / 口令永不回传。"""
    secret = str(row.get("secret") or "")
    return {
        "id": str(row.get("id") or ""),
        "name": str(row.get("name") or ""),
        "host": str(row.get("host") or ""),
        "port": int(row.get("port") or 22),
        "username": str(row.get("username") or ""),
        "auth_type": "password" if str(row.get("auth_type")) == "password" else "key",
        "use_sudo": bool(row.get("use_sudo")),
        "log_source": str(row.get("log_source") or "auto"),
        "enabled": bool(row.get("enabled", True)),
        "known_host": str(row.get("known_host") or ""),
        "origin": str(row.get("origin") or ORIGIN_MANUAL),
        # 来源虚拟机：界面可以据此显示「pve/100」，虚拟机被删时也是靠它定位
        "node": str(row.get("node") or ""),
        "vmid": _as_vmid(row.get("vmid")),
        "conn_id": str(row.get("conn_id") or ""),
        "secret_set": bool(secret),
        "updated": int(row.get("updated") or 0),
        "updated_by": str(row.get("updated_by") or ""),
    }


def normalise_host(raw: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = raw or {}
    current = base or {}
    host = str(item.get("host") or current.get("host") or "").strip()
    if not host:
        raise ValueError("主机地址不能为空")
    if not re.match(r"^[A-Za-z0-9._-]{1,128}$", host):
        raise ValueError("主机地址不合法（只允许域名、IP、点、横线、下划线）")
    try:
        port = int(item.get("port") or current.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    auth_type = str(item.get("auth_type") or current.get("auth_type") or "key").strip().lower()
    if auth_type not in ("key", "password"):
        auth_type = "key"
    log_source = str(item.get("log_source") or current.get("log_source") or "auto").strip().lower()
    if log_source not in ("auto", "journalctl", "secure", "auth.log"):
        log_source = "auto"
    secret = item.get("secret")
    # secret 留空表示沿用旧值
    stored = str(current.get("secret") or "")
    if secret in (None, "", "__UNCHANGED__"):
        new_secret = stored
    else:
        new_secret = crypto.encrypt(str(secret))

    # 「这台受管主机对应集群里的哪台虚拟机」。
    #
    # 面板下发的机器，这个关联由面板自己维护（见 routers/vms._register_managed），
    # **接口传什么都不采纳** —— 否则一次编辑就能把「虚拟机被删时自动清理这台主机
    # 及其安全数据」的关联摘掉，留下一台永远不会被清理的僵尸记录。
    # 手工添加的主机则相反：接口层可以填，认机器就不用再靠地址猜。
    is_panel = (
        str(item.get("origin") or current.get("origin") or ORIGIN_MANUAL) == ORIGIN_PANEL
    )
    if is_panel:
        # 新建时库里还没有这条记录（current 为空），关联只在 item 里；
        # 已存在则以库里的为准 —— 这正是「接口改不动」的意思。
        src = current if current.get("id") else item
        guest_ref = {
            "node": str(src.get("node") or "").strip()[:64],
            "vmid": _as_vmid(src.get("vmid")),
            "conn_id": str(src.get("conn_id") or "").strip()[:64],
        }
    else:
        # **键在不在**决定是「解绑」还是「不传」：vmid 传 null、node 传空串都算
        # 显式解绑；字段压根没传（老前端、内部调用）才保持原值。
        # 用 `or` 兜底是分不清这两种情况的 —— 那会让「解绑」永远解不掉。
        guest_ref = {
            "node": str(
                item["node"] if "node" in item else current.get("node") or ""
            ).strip()[:64],
            "vmid": _as_vmid(item["vmid"] if "vmid" in item else current.get("vmid")),
            "conn_id": str(
                item["conn_id"] if "conn_id" in item else current.get("conn_id") or ""
            ).strip()[:64],
        }

    return {
        "id": str(item.get("id") or current.get("id") or ("h" + uuid.uuid4().hex[:10])),
        "name": str(item.get("name") or current.get("name") or host).strip()[:128],
        "host": host,
        "port": max(1, min(65535, port)),
        "username": str(item.get("username") or current.get("username") or "root").strip()[:64],
        "auth_type": auth_type,
        "secret": new_secret,
        "use_sudo": 1 if bool(item.get("use_sudo", current.get("use_sudo", False))) else 0,
        "log_source": log_source,
        "enabled": 1 if bool(item.get("enabled", current.get("enabled", True))) else 0,
        "known_host": str(item.get("known_host") or current.get("known_host") or "").strip()[:128],
        # origin 只有「面板自己下发」这条代码路径会传（见 routers/vms._register_managed）。
        # 接口层传不进来：SshHostIn 里没有这个字段，pydantic 默认忽略多余键 —— 也就
        # 是说用户无法自封「面板下发」来绕过首次指纹确认。
        "origin": (
            ORIGIN_PANEL
            if str(item.get("origin") or current.get("origin") or ORIGIN_MANUAL)
            == ORIGIN_PANEL
            else ORIGIN_MANUAL
        ),
        # 来源虚拟机：面板下发的机器由面板维护（接口改不动，见上面的 guest_ref），
        # 手工添加的机器由用户在表单里选。编辑时留空即保持原值。
        **guest_ref,
        "updated": int(time.time()),
        "updated_by": str(item.get("updated_by") or current.get("updated_by") or "").strip()[:64],
    }


async def list_hosts(include_disabled: bool = True) -> List[Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT * FROM ssh_hosts" + ("" if include_disabled else " WHERE enabled = 1")
            + " ORDER BY name"
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_host(host_id: str) -> Optional[Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM ssh_hosts WHERE id = ?", (host_id,))
        row = await cursor.fetchone()
    return dict(row) if row else None


async def find_by_address(address: str) -> Optional[Dict[str, Any]]:
    for row in await list_hosts():
        if row.get("host") == address:
            return row
    return None


async def _invalidate_report_cache() -> None:
    """受管主机集合变了 → 「端口与进程 / 安全基线」的全平台总览缓存作废。

    那两页的总览是**现场巡检**的结果，带 2 分钟 TTL（见 :mod:`app.reportcache`）。
    缓存的 key 只有「功能名 + 可见主机集合 + 语言」，**不含主机数量** —— 新登记
    或刚接入一台机器时 key 完全没变，于是它会命中那份「还不含这台机器」的旧报告，
    最长 2 分钟不出现在总览里，看起来正像「面板下发的虚拟机没被纳管」。
    清缓存失败不该影响登记本身，所以这里只记日志。
    """
    try:
        from . import reportcache

        reportcache.clear()
    except Exception:  # noqa: BLE001
        logger.debug("清理巡检报告缓存失败", exc_info=True)


async def save_host(raw: Dict[str, Any], username: str = "") -> Dict[str, Any]:
    await init_table()
    current = await get_host(str(raw.get("id") or "")) if raw.get("id") else None
    item = normalise_host({**raw, "updated_by": username}, current)
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "ssh_hosts",
                list(item.keys()),
                ["id"],
                [key for key in item.keys() if key != "id"],
            ),
            tuple(item.values()),
        )
        await db.commit()

    # 归属只在**新建**时写入：编辑一台别人的主机不该把归属改成编辑者
    # （归属改由管理员的「指派」接口负责）。
    if current is None and username:
        from . import ownership

        await ownership.set_owner(
            ownership.KIND_SSH_HOST, str(item.get("id") or ""), username
        )
    # 新建 / 编辑（含「刚接入、指纹已采纳」）之后，总览缓存里的机器清单已经过时
    await _invalidate_report_cache()
    return item


async def delete_host(host_id: str) -> int:
    from . import ownership

    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("DELETE FROM ssh_hosts WHERE id = ?", (host_id,))
        removed = cursor.rowcount or 0
        await db.commit()
    # 归属记录一并清掉：留着会让「同一个 id 又被创建出来」时继承到旧归属
    if removed:
        await ownership.delete_owner(ownership.KIND_SSH_HOST, host_id)
    return removed


# ------------------------------------------ 移除主机：连带清掉四套安全数据
#
# 一台受管主机（``host_id``）同时是四套安全数据的宿主：
#   * SSH 安全     —— ``ssh_hosts`` 本身（主机的定义就在这张表里）；
#   * 登录审计     —— ``host_audit_cursor`` 的导入进度游标；
#   * 端口与进程   —— ``port_guard_dispositions`` 里按 host_id 分键的人工处置；
#   * 安全基线     —— 与端口共用 :mod:`app.reportcache` 的巡检报告缓存。
# 主机一没（手工移除，或它的虚拟机被删掉），这些数据就都失去了意义：
# 留着只会让界面上还挂着一台连不上的机器，每轮巡检白拨一条 SSH。


async def _drop_host_data(row: Dict[str, Any]) -> None:
    """清掉一台受管主机在四套安全数据里留下的全部痕迹。

    每步都单独兜异常：清理是「删机器」的附带动作，不该因为它失败而让主机
    留在库里（那样用户再删一次还是删不掉）。
    """
    # 函数内导入：hostaudit / portguard 都依赖本模块（见各自模块说明），
    # 顶层导入会成环；reportcache 也只被用到这一次。
    from . import hostaudit, portguard, reportcache

    host_id = str(row.get("id") or "")
    name = str(row.get("name") or row.get("host") or "")
    if host_id:
        try:
            await hostaudit.forget_host(host_id)
        except Exception:  # noqa: BLE001 - 清理失败不该影响移除动作
            logger.warning("清理主机 %s 的登录审计游标失败", host_id, exc_info=True)
        try:
            await portguard.forget_host(host_id)
        except Exception:  # noqa: BLE001
            logger.warning("清理主机 %s 的端口处置记录失败", host_id, exc_info=True)
    if name:
        # 还挂着的活动告警要清掉：机器没了，巡检再也不会跑到它，那些告警
        # 永远等不到「恢复」那一轮，会一直留在告警页的「当前告警」里。
        try:
            await alerting.forget_host(
                name, (alerting.SOURCE_SSHREMOTE, alerting.SOURCE_PORTGUARD)
            )
        except Exception:  # noqa: BLE001
            logger.warning("清理主机 %s 的活动告警失败", name, exc_info=True)
    # 报告缓存的 key 是「功能名 + 可见主机集合 + 语言」，没法按主机精确剔除；
    # 整体清空最省事 —— 代价只是下一次打开总览时多跑一轮巡检（TTL 只有 2 分钟）。
    reportcache.clear()


async def purge_host(host_id: str) -> int:
    """移除一台受管主机（含四套安全数据），返回删掉的行数。

    「SSH 安全」页里的删除按钮与「虚拟机被删除」两条路径都走这里：
    主机从哪来不重要，既然不再受管，就不该在任何一页上留下痕迹。
    """
    row = await get_host(host_id)
    if row is None:
        return 0
    removed = await delete_host(host_id)
    if removed:
        await _drop_host_data(row)
        logger.info(
            "受管主机 %s 已移除，安全数据（SSH / 审计 / 端口 / 基线）一并清理",
            row.get("name") or host_id,
        )
    return removed


def _is_vm_host(row: Dict[str, Any], vmid: int, conn_id: str = "") -> bool:
    """这一行是不是「面板为某台虚拟机登记」的主机（且是那一台）。

    只认 ``origin=panel``：手工添加的主机与虚拟机的生命周期无关，即便凑巧
    写了同一个 VMID 也不该被面板的删除动作牵连。

    匹配**只看连接 + VMID，不看节点名**：PVE 的 VMID 在集群内唯一，而节点名
    会在迁移之后变得过时 —— 按 ``node`` 匹配的话，机器一迁移，它上面登记的
    受管主机就会被当成「虚拟机已不存在」误删。
    """
    if not is_panel_managed(row):
        return False
    if _as_vmid(row.get("vmid")) != int(vmid):
        return False
    stored = str(row.get("conn_id") or "")
    asked = str(conn_id or "")
    # 两边都有连接 id 时以它为准；任一侧为空（老路径 / 未指定连接）就不比。
    return not (stored and asked) or stored == asked


async def purge_vm_hosts(vmid: int, conn_id: str = "") -> List[str]:
    """虚拟机被删除后，清掉面板登记在它上面的受管主机，返回已清理的 host_id。

    由 ``DELETE /api/vms/{node}/{vmid}`` 调用（见 ``routers/vms.delete_vm``）。
    VMID 在面板之外被删掉的情况走 :func:`reconcile_panel_hosts` 兜底。
    """
    hosts = [row for row in await list_hosts() if _is_vm_host(row, vmid, conn_id)]
    removed: List[str] = []
    for row in hosts:
        host_id = str(row.get("id") or "")
        if host_id and await purge_host(host_id):
            removed.append(host_id)
    return removed


# ------------------------------------------------ 面板下发主机的自动登记
#
# 「接入安全管控」勾上之后要登记一台受管主机，凭据用的是面板统一密钥对。
# 两类机器的登记时机不同：
#   * **静态 IP**：创建时地址就定了，立刻登记（指纹留空，等巡检连上后采纳）；
#   * **DHCP**：创建那一刻地址并不存在（cloud-init 里只有 ip=dhcp），只能等机器
#     起来后由 Guest Agent 自报 —— 见 :func:`remember_pending_registration`。


def _pending_key(conn_id: str, node: str, vmid: Any) -> str:
    return f"{conn_id or ''}|{node or ''}|{vmid}"


async def remember_pending_registration(item: Dict[str, Any]) -> None:
    """记下「等地址才登记」的机器（DHCP 下发的那类）。

    为什么要落库而不是只靠内存里的后台任务：地址要等机器起来（通常 1-3 分钟，
    最长给到 10 分钟），而面板在这期间可能重启（部署 / 升级）—— 只放内存的话
    那台机器就永远不会被登记。周期作业 ``host_sync`` 拿这份队列兜底，见
    :func:`process_pending_registrations`。

    ``item`` 需要带上 ``conn_id`` / ``node`` / ``vmid`` / ``name`` /
    ``ssh_username`` / ``owner``，就是登记时要用的那几项。
    """
    data = await _load_pending()
    key = _pending_key(
        str(item.get("conn_id") or ""), str(item.get("node") or ""), item.get("vmid")
    )
    data[key] = {**item, "since": int(time.time())}
    if len(data) > PENDING_MAX:
        # 丢最旧的：这是一份「还没来得及登记」的短名单，不该无限膨胀
        for stale in sorted(data, key=lambda k: data[k].get("since") or 0)[
            : len(data) - PENDING_MAX
        ]:
            data.pop(stale, None)
    try:
        await store.set_setting(PENDING_KEY, json.dumps(data, ensure_ascii=False))
    except Exception:  # noqa: BLE001 - 记不进去只影响「重启后能否续上」
        logger.warning(
            "记录待登记受管主机失败（%s/%s）", item.get("node"), item.get("vmid"),
            exc_info=True,
        )


async def forget_pending_registration(conn_id: str, node: str, vmid: Any) -> None:
    """把一台机器移出待登记队列（已经登记好了）。"""
    key = _pending_key(conn_id, node, vmid)
    data = await _load_pending()
    if key not in data:
        return
    data.pop(key, None)
    try:
        await store.set_setting(PENDING_KEY, json.dumps(data, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        logger.warning("清理待登记项失败（%s/%s）", node, vmid, exc_info=True)


async def _load_pending() -> Dict[str, Dict[str, Any]]:
    """读待登记队列；顺手丢掉超期的（那台机器多半早已删除或永远报不出地址）。"""
    try:
        raw = await store.get_setting(PENDING_KEY)
        data = json.loads(raw) if raw else {}
    except Exception:  # noqa: BLE001 - 读不到就当队列是空的
        logger.warning("读取待登记受管主机队列失败", exc_info=True)
        return {}
    if not isinstance(data, dict):
        return {}
    now = time.time()
    return {
        str(key): value
        for key, value in data.items()
        if isinstance(value, dict) and now - float(value.get("since") or 0) <= PENDING_TTL
    }


async def register_managed_host(
    *,
    name: str,
    host: str,
    ssh_username: str = "",
    conn_id: str = "",
    node: str = "",
    vmid: Any = None,
    owner: str = "",
) -> Optional[Dict[str, Any]]:
    """登记一台「面板下发」的受管主机（凭据 = 面板统一密钥对）。

    写入 ``ssh_hosts``（归属由 :func:`save_host` 在新建时一并记下），并就近重试
    采纳指纹（见 :func:`adopt_new_host`）—— 机器这时刚起来，指纹还没确认。

    静态 IP 的机器创建时就调这里；DHCP 的要等它自报地址，由
    :func:`process_pending_registrations` 或创建时起的后台任务调进来。
    """
    from . import panelkey

    if not host:
        return None
    row = await save_host(
        {
            "name": name,
            "host": host,
            "port": 22,
            "username": ssh_username or "root",
            "auth_type": "key",
            "secret": await panelkey.private_key(),
            # 读 /var/log/auth.log 与 last/lastb 基本都要提权；云镜像的默认用户
            # 有免密 sudo，所以这里默认开。
            "use_sudo": True,
            "origin": ORIGIN_PANEL,
            # 来源虚拟机：机器被删时靠它把四套安全数据一起清掉
            "node": node,
            "vmid": _as_vmid(vmid),
            "conn_id": conn_id,
            "updated_by": owner,
        },
        owner,
    )
    if row:
        # 机器可能刚起来，指纹还没采纳：就近重试一轮（用独立任务，不阻塞调用方）
        asyncio.create_task(adopt_new_host(str(row.get("id") or "")))
    return row


async def process_pending_registrations() -> Dict[str, Any]:
    """给「等地址」的机器再试一轮（周期作业 ``host_sync`` 调用）。

    正常路径是创建时起的后台轮询（见 ``routers/vms._await_managed_registration``）；
    这里兜底两种它管不到的情况：**面板在那十分钟里重启过**、或机器起得特别慢。
    拿到地址就登记，拿不到就一直留着，直到保鲜期结束被丢掉 —— 镜像里没有
    qemu-guest-agent 的机器属于后者（PVE 侧无从得知它的地址）。
    """
    from . import guestip
    from .pve import client_for_connection

    data = await _load_pending()
    if not data:
        return {"checked": 0, "registered": 0, "pending": 0}

    registered: List[str] = []
    kept: Dict[str, Any] = {}
    for key, item in data.items():
        node = str(item.get("node") or "")
        vmid = _as_vmid(item.get("vmid"))
        conn_id = str(item.get("conn_id") or "")
        if not node or vmid is None:
            continue  # 脏数据：丢掉
        try:
            client = client_for_connection(conn_id)
            # 按「运行中」去问：Guest Agent 是唯一能给出 DHCP 地址的地方，
            # 机器还没起来时它会失败，那就留到下一轮
            ip = await guestip.resolve(
                client, {"node": node, "vmid": vmid, "type": "qemu", "status": "running"}
            )
        except Exception as exc:  # noqa: BLE001 - 拿不到就留到下一轮
            logger.info("待登记主机 %s/%s 暂不可用：%s", node, vmid, exc)
            kept[key] = item
            continue
        if not ip:
            kept[key] = item
            continue
        try:
            row = await register_managed_host(
                name=str(item.get("name") or f"{node}/{vmid}"),
                host=ip,
                ssh_username=str(item.get("ssh_username") or "root"),
                conn_id=conn_id,
                node=node,
                vmid=vmid,
                owner=str(item.get("owner") or ""),
            )
        except Exception:  # noqa: BLE001 - 登记失败留到下一轮再试
            logger.warning("登记待纳管主机 %s/%s 失败", node, vmid, exc_info=True)
            kept[key] = item
            continue
        if row:
            registered.append(str(row.get("id") or ""))
            logger.info(
                "DHCP 机器 %s/%s 已自报地址 %s，登记为受管主机", node, vmid, ip
            )

    if kept != data:
        try:
            await store.set_setting(PENDING_KEY, json.dumps(kept, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            logger.warning("回写待登记队列失败", exc_info=True)
    return {"checked": len(data), "registered": len(registered), "pending": len(kept)}


async def reconcile_panel_hosts() -> Dict[str, Any]:
    """核对「面板下发」的受管主机与 PVE 上的虚拟机是否一致，清掉多余的（周期作业）。

    为什么非要它：虚拟机可能在 PVE 界面 / API 上被直接删掉，这时
    :func:`purge_vm_hosts` 根本没机会执行 —— 没有这一步，那台机器会永远留在
    四套安全数据里，每轮巡检都往一个不存在的地址拨 SSH。

    两条保守原则，避免一次网络抖动变成批量误删：

    * 某条 PVE 连接的虚拟机清单读不到（PVE 挂了 / 网络不通）时，**它名下的
      主机本轮一律不动**；
    * 主机没记连接 id（老数据）时不猜，跳过。

    清单取自 ``cluster_resources('vm')`` —— 与「虚拟机」列表页同一份数据。
    """
    from .pve import all_connection_clients
    from .store import get_connections

    # 先处理「等地址」的待登记机器（DHCP 下发的那类）。放在这里而不是函数末尾：
    # 「一台受管主机都还没有」正是这个场景的常态，而函数在中途就会提前返回。
    try:
        pending = await process_pending_registrations()
    except Exception:  # noqa: BLE001 - 兜底失败不该影响本轮核对
        logger.warning("处理待登记受管主机失败", exc_info=True)
        pending = {"checked": 0, "registered": 0, "pending": 0}

    hosts = [
        row
        for row in await list_hosts()
        if is_panel_managed(row) and _as_vmid(row.get("vmid")) is not None
    ]
    if not hosts:
        return {"checked": 0, "removed": 0, "hosts": [], "pending": pending}

    known_conns = {str(item.get("id") or "") for item in get_connections()}
    if not known_conns:
        # 一条 PVE 连接都没有：无从核对，什么都不动
        return {"checked": 0, "removed": 0, "hosts": [], "pending": pending}

    inventory: Dict[str, set] = {}
    for profile, client in all_connection_clients():
        cid = str(profile.get("id") or "")
        try:
            resources = await client.cluster_resources("vm")
        except Exception as exc:  # noqa: BLE001 - 单条连接读不到清单，跳过它的主机
            logger.info(
                "读取 PVE 连接 %s 的虚拟机清单失败，本轮跳过其受管主机：%s", cid, exc
            )
            continue
        # 只留 vmid：见 _is_vm_host 里「为什么不比节点名」的说明
        inventory[cid] = {
            int(vm["vmid"]) for vm in (resources or []) if vm.get("vmid") is not None
        }

    removed: List[str] = []
    for row in hosts:
        cid = str(row.get("conn_id") or "")
        if not cid:
            continue  # 不知道属于哪条连接，没有证据
        if cid not in known_conns:
            reason = "所属 PVE 连接已被删除"
        elif cid in inventory:
            if _as_vmid(row.get("vmid")) in inventory[cid]:
                continue
            reason = "虚拟机已不存在"
        else:
            continue  # 本轮没拿到这条连接的清单，不删
        host_id = str(row.get("id") or "")
        if host_id and await purge_host(host_id):
            removed.append(host_id)
            logger.info(
                "受管主机 %s 已自动移除（%s）", row.get("name") or host_id, reason
            )
    return {
        "checked": len(hosts),
        "removed": len(removed),
        "hosts": removed,
        "pending": pending,
    }


def decrypt_secret(row: Dict[str, Any]) -> str:
    raw = str(row.get("secret") or "")
    if not raw:
        return ""
    if crypto.is_encrypted(raw):
        return crypto.decrypt(raw)
    return raw  # 历史明文（不应出现）


# ------------------------------------------------------------------ SSH 连接

class FingerprintMismatch(RuntimeError):
    """主机指纹与库里记录的不一致 —— 可能是中间人。"""

    def __init__(self, message: str, expected: str = "", actual: str = "") -> None:
        super().__init__(message)
        # 结构化带上两个指纹：自检接口要把「记录值 / 实际值」原样交给界面，
        # 让用户对着这两串字自己判断，而不是去解析异常消息里的文本
        #（消息随时可能改措辞或被翻译，解析它等于把界面绑死在文案上）。
        self.expected = expected
        self.actual = actual


class _CapturePolicy(paramiko.MissingHostKeyPolicy):
    """记录对端指纹：库里有就比对，没有就先记下来让调用方决定。"""

    def __init__(self, expected: str = "") -> None:
        self.expected = expected
        self.seen = ""

    def missing_host_key(self, client, hostname, key) -> None:  # noqa: ANN001
        fingerprint = _fingerprint(key)
        self.seen = fingerprint
        if self.expected and self.expected != fingerprint:
            raise FingerprintMismatch(
                i18n.t(
                    "ssh.fingerprintMismatch",
                    expected=self.expected,
                    actual=fingerprint,
                ),
                expected=self.expected,
                actual=fingerprint,
            )


def _fingerprint(key: Any) -> str:
    import base64
    import hashlib

    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def _load_key(text: str) -> Any:
    """逐个尝试常见密钥类型。

    用 ``getattr`` 取类：paramiko 各版本的类名并不一致（5.x 已经没有 DSSKey），
    直接写 ``paramiko.DSSKey`` 会在构造候选列表时就抛 AttributeError。
    """
    loaders = [
        cls
        for cls in (
            getattr(paramiko, name, None)
            for name in ("Ed25519Key", "RSAKey", "ECDSAKey", "DSSKey")
        )
        if cls is not None
    ]
    for loader in loaders:
        try:
            return loader.from_private_key(io.StringIO(text))
        except Exception:  # noqa: BLE001 - 逐个尝试各种密钥类型
            continue
    raise ValueError("私钥格式无法识别（支持 Ed25519 / RSA / ECDSA；PEM 或 OpenSSH 格式）")


def server_key_fingerprint(client: paramiko.SSHClient) -> str:
    """直接问已建立的连接要对端主机密钥指纹。

    **不能只依赖 ``_CapturePolicy`` 的回调**：paramiko 只在「密钥不在已知列表里」
    时才回调它。只要目标主机出现在面板本机的 ``~/.ssh/known_hosts`` 中，回调就不会
    触发、``policy.seen`` 是空串，于是「确认并信任」会返回成功却什么也没记下来
    （指纹字段留空、界面上的「未确认」永远消不掉）。所以指纹一律以 transport 为准。
    """
    try:
        transport = client.get_transport()
        key = transport.get_remote_server_key() if transport is not None else None
    except Exception:  # noqa: BLE001 - 取不到指纹不该让连接本身失败
        return ""
    return _fingerprint(key) if key is not None else ""


def is_panel_managed(row: Dict[str, Any]) -> bool:
    """这台主机是不是「面板下发虚拟机时自动登记」的（见 ``ORIGIN_PANEL``）。

    这类主机的首次信任由面板自己完成，不需要用户在界面上点确认 —— 面板刚刚
    才把公钥写进那台机器的 cloud-init，没有第三方插手的窗口。手工添加的主机
    不享受这个待遇：面板无法证明那把主机密钥是它自己部署的。
    """
    return str(row.get("origin") or ORIGIN_MANUAL) == ORIGIN_PANEL


def _probe_fingerprint(row: Dict[str, Any]) -> str:
    """连一次只为拿指纹（阻塞，调用方负责 to_thread）。"""
    client, fingerprint = _connect({**row, "known_host": ""}, trust_first=True)
    try:
        return fingerprint
    finally:
        client.close()


async def adopt_panel_hosts() -> int:
    """给「面板下发」的主机补上首见指纹，返回本次补了几台。

    为什么非要有这一步：:func:`_connect` 对面板下发的主机放行「首次连接免确认」，
    但**指纹不记下来就等于每次连接都重新 TOFU** —— 对端日后换了主机密钥也发现
    不了。这里在周期任务里补记，把那个窗口收窄成「首启到第一次巡检」。

    机器刚建好还没起来、或 cloud-init 还没落盘公钥时连不上，都是**正常**的：
    记一条 info 等下一轮，不算错误。
    """
    try:
        rows = await list_hosts(include_disabled=False)
    except Exception:  # noqa: BLE001 - 读不到主机列表不该让后台任务炸掉
        logger.exception("读取受管主机失败，跳过面板主机指纹采纳")
        return 0
    adopted = 0
    for row in rows:
        if not is_panel_managed(row) or str(row.get("known_host") or ""):
            continue
        try:
            fingerprint = await asyncio.to_thread(_probe_fingerprint, dict(row))
        except Exception as exc:  # noqa: BLE001 - 没起来 / 不可达都很正常
            logger.info("面板下发主机 %s 暂不可达，稍后再试：%s", row.get("host"), exc)
            continue
        if not fingerprint:
            continue
        await save_host({**row, "known_host": fingerprint}, row.get("updated_by") or "")
        adopted += 1
        logger.info("已采纳面板下发主机 %s 的指纹 %s", row.get("host"), fingerprint)
    return adopted


async def adopt_new_host(host_id: str, tries: int = 15, delay: float = 20.0) -> None:
    """为**刚下发**的机器就近重试采纳指纹（后台任务，不阻塞创建请求）。

    VM 起来、cloud-init 把公钥落盘都不是瞬时的，所以按固定间隔重试一段时间，
    成功即停。为什么要专门做这件事：只靠周期巡检（``evaluate_fleet`` →
    ``adopt_panel_hosts``）的话，用户勾完「接入安全管控」建完机器，界面上会先
    显示「未确认」，得等下一轮巡检才消失 —— 给人「还要我去点一下」的错觉。
    这里把常见情况（机器几分钟内起来）提前到「建完基本就已就绪」。

    一直连不上也不算错：周期巡检仍会兜底。
    """
    for _ in range(max(1, tries)):
        try:
            rows = await list_hosts(include_disabled=False)
            row = next((r for r in rows if str(r.get("id")) == host_id), None)
            if row is None:
                return  # 机器已被删，不用再试
            if str(row.get("known_host") or ""):
                return  # 已经采纳过了
            fingerprint = await asyncio.to_thread(_probe_fingerprint, dict(row))
            if fingerprint:
                await save_host(
                    {**row, "known_host": fingerprint}, row.get("updated_by") or ""
                )
                logger.info(
                    "面板下发主机 %s 已自动接入（指纹 %s）", row.get("host"), fingerprint
                )
                return
        except Exception as exc:  # noqa: BLE001 - 机器没起来 / 不可达都很正常
            logger.debug("面板下发主机 %s 尚未就绪：%s", host_id, exc)
        await asyncio.sleep(delay)


def _connect(row: Dict[str, Any], trust_first: bool = False) -> Tuple[paramiko.SSHClient, str]:
    """建立 SSH 连接（阻塞，调用方负责 to_thread）。

    刻意**不**调用 ``load_system_host_keys()``：面板只信自己库里的那份指纹（TOFU）。
    引入系统 known_hosts 会有两个副作用 —— 命中条目时绕过策略回调（指纹取不到，
    见 :func:`server_key_fingerprint`），以及密钥轮换后由 paramiko 直接抛
    ``BadHostKeyException``，让界面上的「重新信任」失灵。信任来源必须唯一。
    """
    client = paramiko.SSHClient()
    policy = _CapturePolicy(str(row.get("known_host") or ""))
    client.set_missing_host_key_policy(policy)
    kwargs: Dict[str, Any] = {
        "hostname": str(row.get("host") or ""),
        "port": int(row.get("port") or 22),
        "username": str(row.get("username") or "root"),
        "timeout": DEFAULT_TIMEOUT,
        "banner_timeout": DEFAULT_TIMEOUT,
        "auth_timeout": DEFAULT_TIMEOUT,
        "allow_agent": False,
        "look_for_keys": False,
    }
    secret = decrypt_secret(row)
    if str(row.get("auth_type")) == "password":
        kwargs["password"] = secret
        if not secret:
            raise ValueError("该主机使用口令登录，但没保存口令")
    elif secret:
        kwargs["pkey"] = _load_key(secret)
    try:
        client.connect(**kwargs)
    except FingerprintMismatch:
        client.close()
        raise
    except Exception as exc:  # noqa: BLE001
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"SSH 连接失败：{exc}") from exc
    fingerprint = (
        server_key_fingerprint(client)
        or policy.seen
        or str(row.get("known_host") or "")
    )
    if not row.get("known_host") and not trust_first and not is_panel_managed(row):
        # 第一次连接：没有指纹记录且未授权信任 → 断开，把指纹交给调用方确认
        client.close()
        raise RuntimeError(
            "首次连接该主机，需要先确认指纹 " + fingerprint
            + "（在主机管理里点「确认并信任」）"
        )
    return client, fingerprint


def _sudo_prefix(row: Dict[str, Any]) -> str:
    return "sudo -n " if row.get("use_sudo") else ""


def run_command_sync(
    row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT
) -> Tuple[bool, str]:
    """在远程主机上跑一条命令（阻塞版本）。返回 (成功?, 输出)。"""
    client, _ = _connect(row)
    try:
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    text = (out or "") + (err or "")
    return code == 0, text


async def run_command(row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT) -> Tuple[bool, str]:
    return await asyncio.to_thread(run_command_sync, row, command, timeout)


async def open_command(
    row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT
) -> Tuple[paramiko.SSHClient, Any, Any]:
    """打开一条远程命令，返回 ``(client, stdout, stderr)`` 供调用方边读边转发。

    与 :func:`run_command` 的区别是**不把输出读进内存**：备份归档动辄几个 GB，
    整份读进来会把面板内存吃光。三条约定：

    * 读取请用 ``await asyncio.to_thread(stdout.read, chunk)`` —— paramiko 的读取
      是阻塞的，直接在事件循环里调用会卡住所有请求；
    * 命令的退出码要在读完 stdout 之后用 ``stdout.channel.recv_exit_status()`` 取，
      失败信息在 ``stderr``；
    * 调用方必须在 ``finally`` 里 ``client.close()``，否则连接会一直挂着。
    """
    client, _ = await asyncio.to_thread(_connect, row)
    try:
        _stdin, stdout, stderr = await asyncio.to_thread(
            client.exec_command, command, timeout=timeout
        )
    except Exception:  # noqa: BLE001 - 打开失败也要把连接关掉
        client.close()
        raise
    return client, stdout, stderr


async def write_file_sync(row: Dict[str, Any], path: str, content: str) -> Tuple[bool, str]:
    """写远程文件：先用 SFTP，失败再退回 sudo tee（口令 / 非 root 场景）。"""
    client, _ = _connect(row)
    try:
        try:
            sftp = client.open_sftp()
            with sftp.open(path, "w") as handle:
                handle.write(content)
            sftp.close()
            return True, ""
        except Exception as exc:  # noqa: BLE001 - 权限不足等情况
            fallback_error = str(exc)
    finally:
        client.close()
    # 退回：把内容交给远程的 tee（内容由面板生成，不含用户输入）
    command = f"{_sudo_prefix(row)}tee {path} > /dev/null"
    client, _ = _connect(row)
    try:
        _, stdout, stderr = client.exec_command(command, timeout=DEFAULT_TIMEOUT)
        stdout.channel.send(content.encode("utf-8"))
        stdout.channel.shutdown_write()
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    if code != 0:
        return False, f"SFTP 写入失败（{fallback_error}），tee 也失败：{err.strip()}"
    return True, ""


async def write_file(row: Dict[str, Any], path: str, content: str) -> Tuple[bool, str]:
    return await asyncio.to_thread(write_file_sync, row, path, content)


async def test_host(row: Dict[str, Any], trust_first: bool = False) -> Dict[str, Any]:
    """连通性自检：能连上吗、是谁、有没有 fail2ban、日志源是什么。"""
    try:
        client, fingerprint = await asyncio.to_thread(_connect, row, trust_first)
    except FingerprintMismatch as exc:
        # 指纹不一致要单独成一类结果：界面据此把「重新信任」按钮亮出来
        #（普通连接失败可没什么可信任的）。两个指纹一并返回，用户要的就是
        # 拿它们跟自己的记录比对。
        return {
            "ok": False,
            "detail": str(exc),
            "fingerprint": exc.actual,
            "mismatch": True,
            "expected": exc.expected,
            "actual": exc.actual,
        }
    except Exception as exc:  # noqa: BLE001 - 各种网络/认证错误都要给成人话
        return {"ok": False, "detail": str(exc), "fingerprint": ""}
    try:
        commands = {
            "hostname": "hostname",
            "user": "whoami",
            "fail2ban": f"{_sudo_prefix(row)}fail2ban-client --version",
            "journal": "command -v journalctl",
            "secure": "test -r /var/log/secure && echo readable",
            "authlog": "test -r /var/log/auth.log && echo readable",
        }
        result: Dict[str, Any] = {"ok": True, "detail": "", "fingerprint": fingerprint}
        for key, command in commands.items():
            ok, out = await run_command(row, command, timeout=10)
            result[key] = out.strip() if ok else ""
        result["sudo_works"] = bool(result["user"]) and str(result["user"]).strip() != ""
        return result
    finally:
        client.close()


async def trust_fingerprint(row: Dict[str, Any], force: bool = False) -> Dict[str, Any]:
    """显式确认并记住指纹。

    ``force=False``：首次信任 —— 库里还没有指纹（或本来就与实际一致）时用。
    ``force=True``：**重新信任** —— 实际指纹与库里记录的不一致时，管理员排查
    （确认是重装系统 / 轮换过 SSH 主机密钥，而不是中间人）后用实际指纹覆盖记录。

    为什么非要一个显式开关、不让它「不一致就自己覆盖」：主机密钥变了正是中间人
    攻击的特征。默认拒绝、由人来按这个确认，这个确认才有分量。
    """
    previous = str(row.get("known_host") or "")
    # 重新信任时必须先把旧指纹摘掉再连：_CapturePolicy 拿它做比对，留着就会
    # 当场再抛一次 FingerprintMismatch —— 按钮点了等于没点。
    target = {**row, "known_host": ""} if force else row
    try:
        client, fingerprint = await asyncio.to_thread(_connect, target, True)
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "detail": str(exc),
            "fingerprint": "",
            "previous": previous,
        }
    client.close()
    if not fingerprint:
        # 宁可报错也不能「成功但没记下」：那会让界面上的「未确认」永远消不掉，
        # 用户点多少次都像没反应。
        return {
            "ok": False,
            "fingerprint": "",
            "previous": previous,
            "detail": i18n.tr(
                "没能从这台主机取到 SSH 指纹：请确认地址、端口与 SSH 服务正常后重试"
            ),
        }
    if previous == fingerprint:
        return {
            "ok": True,
            "fingerprint": fingerprint,
            "previous": previous,
            "changed": False,
            "detail": i18n.tr("主机指纹与记录一致，无需更新"),
        }
    await save_host({**row, "known_host": fingerprint}, row.get("updated_by") or "")
    return {
        "ok": True,
        "fingerprint": fingerprint,
        "previous": previous,
        "changed": bool(previous),
        "detail": i18n.tr("已更新主机指纹") if previous else i18n.tr("已记录主机指纹"),
    }


# ------------------------------------------------------------- 远程日志与统计

def log_command(row: Dict[str, Any], since_ts: float) -> str:
    source = str(row.get("log_source") or "auto")
    prefix = _sudo_prefix(row)
    if source == "secure":
        return f"{prefix}tail -n 20000 /var/log/secure 2>/dev/null"
    if source == "auth.log":
        return f"{prefix}tail -n 20000 /var/log/auth.log 2>/dev/null"
    if source == "journalctl":
        return f"{prefix}journalctl -u ssh -u sshd --since @{int(since_ts)} -o short-iso --no-pager -n 20000"
    return prefix + READ_LOG_CMD.format(since=int(since_ts))


async def remote_report(row: Dict[str, Any], hours: int = 24) -> Dict[str, Any]:
    """在远程主机上取日志并聚合，结构与本机 collect() 一致。"""
    since_ts = time.time() - max(1, min(168, hours)) * 3600
    try:
        ok, output = await run_command(row, log_command(row, since_ts), timeout=LOG_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - 连接/认证/超时都按「这台读不到」处理，不能让整页 500
        ok, output = False, str(exc)
    report: Dict[str, Any] = {
        "host_id": row.get("id"),
        "host": row.get("host"),
        "name": row.get("name"),
        "ok": ok,
        "error": "" if ok else output.strip()[:300],
        "source": {
            "kind": "ssh",
            "path": str(row.get("host") or ""),
            "label": f"ssh://{row.get('username')}@{row.get('host')}",
            "available": ok,
            "host": str(row.get("name") or row.get("host") or ""),
            "detail": "远程执行" if ok else output.strip()[:200],
        },
        "summary": {"failures": 0, "distinct_ips": 0, "distinct_users": 0, "logins": 0},
        "top_ips": [],
        "top_users": [],
        "logins": [],
        "since": int(since_ts),
        "generated_at": int(time.time()),
    }
    if not ok:
        return report
    events = sshguard.parse_lines(output.splitlines())
    policy = await sshguard.load_policy()
    aggregated = sshguard.aggregate(
        events, since_ts, sshguard.split_ips(policy.get("ignore_ips", ""))
    )
    report.update(aggregated)
    report["source"] = {
        "kind": "ssh",
        "path": str(row.get("host") or ""),
        "label": f"ssh://{row.get('username')}@{row.get('host')}",
        "available": True,
        "host": str(row.get("name") or row.get("host") or ""),
        "detail": "",
    }
    return report


# ----------------------------------------------------------------- fail2ban

def _fail2ban_cmd(row: Dict[str, Any], args: str) -> str:
    return f"{_sudo_prefix(row)}fail2ban-client {args}"


async def remote_fail2ban_status(row: Dict[str, Any]) -> Dict[str, Any]:
    ok, output = await run_command(row, _fail2ban_cmd(row, "status"))
    policy = await sshguard.load_policy()
    base: Dict[str, Any] = {
        "installed": ok,
        "running": ok,
        "jails": [],
        "details": [],
        "preferred": policy.get("jail") or "",
        "host": str(row.get("name") or row.get("host") or ""),
        "binary": "",
        "checked": [],
        "hint": ""
        if ok
        else i18n.t("ssh.remoteF2bFail", output=output.strip()[:200]),
    }
    if not ok:
        return base
    match = re.search(r"Jail list:\s*(.*)", output)
    jails = [name.strip() for name in (match.group(1).split(",") if match else []) if name.strip()]
    base["jails"] = jails
    preferred = base["preferred"] if base["preferred"] in jails else ""
    if not preferred:
        ssh_jails = [name for name in jails if "ssh" in name.lower()]
        preferred = ssh_jails[0] if ssh_jails else (jails[0] if jails else "")
    base["preferred"] = preferred
    details: List[Dict[str, Any]] = []
    for name in jails:
        if not sshguard.JAIL_NAME_RE.match(name):
            continue
        jail_ok, jail_out = await run_command(row, _fail2ban_cmd(row, f"status {name}"))
        if not jail_ok:
            continue
        parsed = sshguard.parse_jail_status(jail_out)
        parsed["jail"] = parsed.get("jail") or name
        details.append(parsed)
    base["details"] = details
    return base


async def remote_fail2ban_action(
    row: Dict[str, Any], action: str, jail: str = "", ip: str = ""
) -> Dict[str, Any]:
    """对某个 jail 做封禁 / 解封，或整体 reload（reload 不需要 jail）。"""
    if action not in ("ban", "unban", "reload"):
        raise ValueError("不支持的操作：" + action)
    if action == "reload":
        ok, out = await run_command(row, _fail2ban_cmd(row, "reload"))
        if not ok:
            raise RuntimeError(out.strip()[:200])
        return {"ok": True, "detail": out.strip()[:200]}
    if not sshguard.JAIL_NAME_RE.match(jail or ""):
        raise ValueError("jail 名称不合法")
    if not sshguard.IP_RE.match(ip or ""):
        raise ValueError("IP 地址不合法")
    ok, out = await run_command(
        row, _fail2ban_cmd(row, f"set {jail} {'banip' if action == 'ban' else 'unbanip'} {ip}")
    )
    if not ok:
        raise RuntimeError(out.strip()[:200])
    return {"ok": True, "detail": out.strip()[:200]}


async def remote_write_jail(
    row: Dict[str, Any], jail: str, maxretry: int, findtime: int, bantime: int
) -> Dict[str, Any]:
    policy = await sshguard.load_policy()
    content = sshguard.render_jail_config(
        jail, maxretry, findtime, bantime, policy.get("ignore_ips", "")
    )
    path = sshguard.jail_file_path(jail)
    ok, detail = await write_file(row, path, content)
    if not ok:
        raise RuntimeError(detail)
    reload_ok, out = await run_command(row, _fail2ban_cmd(row, "reload"))
    if not reload_ok:
        raise RuntimeError("配置已写入，但 reload 失败：" + out.strip()[:200])
    return {"ok": True, "path": path, "config": content, "detail": out.strip()[:200]}


# --------------------------------------------------------------- 多机聚合

async def fleet_reports(
    hours: Optional[int] = None,
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """并发拉取启用主机的报告（远程 + 本机）。

    ``host_ids`` 为 ``None`` = 不限（后台告警任务用全量）；给了集合就只拉集合
    里的主机，且**只有集合里含 "local" 时才带本机** —— 与
    :mod:`app.baseline` / :mod:`app.portguard` 的同名参数保持同一套语义，
    普通用户因此拿不到面板本机那一份。
    """
    policy = await sshguard.load_policy()
    window = hours or int(policy["window_hours"])
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    hosts = [
        row
        for row in await list_hosts(include_disabled=False)
        if row.get("enabled") and (wanted is None or str(row.get("id")) in wanted)
    ]
    include_local = (wanted is None or "local" in wanted) and await localhost.enabled()
    reports: List[Dict[str, Any]] = []

    if hosts:
        results = await asyncio.gather(
            *[remote_report(row, window) for row in hosts], return_exceptions=True
        )
        for row, result in zip(hosts, results):
            if isinstance(result, Exception):
                reports.append(
                    {
                        "host_id": row.get("id"),
                        "host": row.get("host"),
                        "name": row.get("name"),
                        "ok": False,
                        "error": str(result)[:200],
                        "source": {
                            "kind": "ssh",
                            "label": f"ssh://{row.get('username')}@{row.get('host')}",
                            "available": False,
                            "host": str(row.get("name") or ""),
                            "detail": str(result)[:200],
                        },
                        "summary": {
                            "failures": 0,
                            "distinct_ips": 0,
                            "distinct_users": 0,
                            "logins": 0,
                        },
                        "top_ips": [],
                        "top_users": [],
                        "logins": [],
                    }
                )
            else:
                reports.append(result)

    if not include_local:
        return reports

    local = await sshguard.collect(window)
    local["host_id"] = "local"
    local["name"] = local["source"].get("host") or "本机（面板）"
    local["host"] = local["source"].get("host") or "localhost"
    local["ok"] = bool(local["source"].get("available"))
    local["error"] = (
        ""
        if local["ok"]
        else str(local["source"].get("detail") or i18n.t("ssh.noLocalLog"))
    )
    reports.append(local)
    return reports


async def fleet_overview(
    hours: Optional[int] = None,
    host_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """多机概览：每台主机的统计 + fail2ban 状态。"""
    reports = await fleet_reports(hours, host_ids)
    hosts_payload: List[Dict[str, Any]] = []
    for report in reports:
        fail2ban: Dict[str, Any] = {"installed": False, "running": False, "jails": [], "details": [], "preferred": "", "hint": ""}
        row = None
        if report.get("host_id") != "local":
            row = await get_host(str(report.get("host_id") or ""))
        if row is not None and report.get("ok"):
            fail2ban = await remote_fail2ban_status(row)
        elif report.get("host_id") == "local":
            fail2ban = await sshguard.fail2ban_status()
        hosts_payload.append(
            {
                "id": report.get("host_id"),
                "name": report.get("name"),
                "host": report.get("host"),
                "ok": bool(report.get("ok")),
                "error": report.get("error") or "",
                "source": report.get("source"),
                "summary": report.get("summary"),
                "top_ips": (report.get("top_ips") or [])[:20],
                "fail2ban": fail2ban,
            }
        )
    totals = {
        "hosts": len(hosts_payload),
        "reachable": sum(1 for item in hosts_payload if item["ok"]),
        "failures": sum(int(item["summary"]["failures"]) for item in hosts_payload),
        "distinct_ips": sum(int(item["summary"]["distinct_ips"]) for item in hosts_payload),
        "logins": sum(int(item["summary"]["logins"]) for item in hosts_payload),
        "banned": sum(
            sum(int(jail.get("currently_banned") or 0) for jail in item["fail2ban"].get("details") or [])
            for item in hosts_payload
        ),
    }
    return {"hosts": hosts_payload, "totals": totals, "generated_at": int(time.time())}


# --------------------------------------------------------------- 多机告警

async def evaluate_fleet() -> List[Dict[str, Any]]:
    """按主机维度检查远程主机的 SSH 异常并告警。"""
    # 先给「面板下发」的主机补上首见指纹。这一步与 SSH 告警策略的开关无关：
    # 用户关掉告警也不该让新建的机器一直停在「未确认」。
    try:
        await adopt_panel_hosts()
    except Exception:  # noqa: BLE001 - 采纳失败不该拖垮整轮巡检
        logger.exception("采纳面板下发主机指纹失败")
    policy = await sshguard.load_policy()
    if not policy.get("enabled"):
        return []
    await sshguard.init_table()
    target_owner = policy.get("notify_user") or await store.first_admin_username() or ""
    # 按收件人的语言渲染（巡检是后台跑的，没有请求上下文，见 alerting.resolve_language）
    i18n.pin_language(await alerting.resolve_language(target_owner))
    feishu = await alerting.load_feishu(target_owner)
    email_cfg = await alerting.load_alert_email(target_owner)
    cooldown = int(policy["cooldown_minutes"]) * 60
    threshold = int(policy["max_failures"])
    now = time.time()
    fired: List[Dict[str, Any]] = []

    active = {
        key: row
        for key, row in (await alerting.load_active()).items()
        if str(row.get("target_type")) == "ssh"
    }
    still: set = set()

    for report in await fleet_reports():
        if not report.get("ok"):
            continue
        if report.get("host_id") == "local":
            continue  # 本机由 sshguard.evaluate() 负责，避免重复告警
        label = str(report.get("name") or report.get("host") or "")
        for row in report.get("top_ips") or []:
            if row["count"] < threshold:
                continue
            ip = row["ip"]
            key = alerting.alarm_key(target_owner, "ssh-fail", f"{label}:{ip}")
            still.add(key)
            # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
            prev = active.get(key) or {}
            last = float(prev.get("ts") or 0)
            if now - last < cooldown:
                continue
            card = alerting.build_card(
                "critical" if row["count"] >= threshold * 2 else "warning",
                i18n.tr("🛡 ProxCenter SSH 爆破告警"),
                i18n.pick(
                    f"{label}：{ip} 失败 {row['count']} 次",
                    f"{label}: {ip} failed {row['count']} times",
                ),
                [
                    (i18n.tr("主机"), label),
                    (i18n.tr("来源 IP"), ip),
                    (
                        i18n.tr("失败次数"),
                        f"**{row['count']}**"
                        + i18n.pick("（阈值 ", " (threshold ")
                        + str(threshold)
                        + i18n.pick("）", ")"),
                    ),
                    (
                        i18n.tr("统计窗口"),
                        i18n.pick(
                            f"最近 {policy['window_hours']} 小时",
                            f"Last {policy['window_hours']} hour(s)",
                        ),
                    ),
                    (
                        i18n.tr("尝试的用户名"),
                        i18n.pick("、", ", ").join(row["users"][:8]) or "-",
                    ),
                    (i18n.tr("发生时间"), alerting._now_text(now)),
                ],
                i18n.tr("可在「SSH 安全」页对该主机一键封禁，或用 fail2ban 自动封禁。"),
            )
            text = i18n.pick(
                f"SSH 爆破告警（{label}）：{ip} 在 {policy['window_hours']} 小时内失败"
                f" {row['count']} 次（阈值 {threshold}）\n"
                f"尝试的用户名：{'、'.join(row['users'][:8])}",
                f"SSH brute-force alert ({label}): {ip} failed {row['count']} times "
                f"within {policy['window_hours']} hour(s) (threshold {threshold})\n"
                f"Attempted usernames: {', '.join(row['users'][:8])}",
            )
            ok, detail = await alerting.dispatch(
                target_owner,
                feishu,
                email_cfg,
                i18n.pick(
                    f"SSH 爆破告警 {label}/{ip}",
                    f"SSH brute-force alert {label}/{ip}",
                ),
                text,
                card,
                source=alerting.SOURCE_SSHREMOTE,
            )
            state = {
                "username": target_owner,
                "rule_id": "ssh-fail",
                "rule_name": i18n.tr("SSH 登录失败次数"),
                "target_type": "ssh",
                "target": f"{label}:{ip}",
                "metric": "ssh_fail",
                "value": row["count"],
                "threshold": threshold,
                "node": label,
                "ip": ip,
                "vmid": None,
                "ts": int(now),
                "notify_source": alerting.SOURCE_SSHREMOTE,
            }
            await alerting.mark_active(key, state)
            active[key] = dict(state, alarm_key=key)
            entry = {
                **state,
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "alarm",
            }
            await alerting.record(
                entry, source=alerting.SOURCE_SSHREMOTE, repeat=bool(prev)
            )
            entry["text"] = text
            fired.append(entry)

    # 恢复：本轮不再超阈值的
    for key, row in list(active.items()):
        if row.get("rule_id") != "ssh-fail" or key in still:
            continue
        if ":" not in str(row.get("target") or ""):
            continue  # 本机告警由 sshguard 处理
        if not await alerting.recovery_confirmed(key, row):
            continue  # 本轮只是回落到阈值以下，还没到「连续 N 轮正常」的恢复门槛
        card = alerting.build_recovery_card(row, None, at=now)
        text = i18n.pick(
            f"{row.get('target')} 的 SSH 登录失败次数已回落到阈值以下，告警解除",
            f"Failed SSH sign-ins for {row.get('target')} dropped below the "
            "threshold; the alert is cleared",
        )
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            i18n.tr("恢复通知：") + str(row.get("target")),
            text,
            card,
            source=alerting.SOURCE_SSHREMOTE,
        )
        await alerting.record(
            {
                "username": target_owner,
                "rule_id": row.get("rule_id"),
                "rule_name": row.get("rule_name"),
                "target_type": "ssh",
                "target": row.get("target"),
                "metric": "ssh_fail",
                "value": float(row.get("value") or 0),
                "threshold": row.get("threshold"),
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "recovery",
            },
            source=alerting.SOURCE_SSHREMOTE,
        )
        await alerting.clear_active(key)
        fired.append({"kind": "recovery", "target": row.get("target"), "text": text})
    return fired
