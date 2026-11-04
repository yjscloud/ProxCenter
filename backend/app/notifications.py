"""站内通知中心：把告警等事件落一条「消息」，供顶部铃铛与未读数使用。

为什么要单独一张表
------------------
告警此前只存在于「监控告警」页面里：不发生告警的那一刻，没人会主动去翻；而
外部通道（飞书 / 邮件 / Webhook）一旦没配或发失败，这条告警就彻底没人知道了。
站内消息把「有没有新事件」变成面板自己就能回答的问题 —— 打开任意页面都能看到
铃铛上的未读数，不依赖任何外部通道是否可用。

与 ``alert_history`` 的分工
--------------------------
``alert_history`` 是**告警评估的结果清单**（含发送结果、用于复盘与统计）；
本模块是**面向人的待办**（未读 / 已读、可点进去）。两者刻意不合并：一条告警
对多个收件人只算一条历史，但对每个收件人都要各自有一条未读消息。

读已读的口径
------------
``read_at = 0`` 表示未读（而不是用一个布尔列）：既能判未读，又留了「什么时候
读的」这个信息，成本相同。

用户隔离
--------
归属按 ``username`` 列隔离，**每一个读写函数都自己带上这个条件**（见
:func:`_owner`），而不是指望调用方记得过滤。接口层从登录态取用户名传进来，
前端没有任何途径指定「操作谁的消息」—— 一旦它变成一个请求参数，越权就只剩
改一个字段的工作量。

这条线格外要紧，因为消息正文里会出现下发的机器口令、地址与账号：串号不是
「看到一条无关通知」，而是直接泄露凭据。空用户名一律当作「没有归属」处理，
读返回空、写返回 0，绝不退化成「查 username = '' 恰好查不到」这种碰巧的安全。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Sequence

from . import database, i18n, ownership

logger = logging.getLogger(__name__)

# 保留 90 天：站内消息是「待办」，不是审计凭证（审计在 audit_log 里）。
# 留太久只会让未读数越积越多，最后没人再看铃铛。
RETENTION_DAYS = 90

# 单次最多返回多少条
MAX_LIMIT = 200
DEFAULT_LIMIT = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS notifications (
    id       BIGINT       NOT NULL AUTO_INCREMENT,
    username VARCHAR(64)  NOT NULL DEFAULT '',
    -- 事件类别：alert（告警）/ recovery（恢复）。留着便于以后接别的来源
    kind     VARCHAR(32)  NOT NULL DEFAULT 'alert',
    -- 严重级别：danger / warning / info / success
    level    VARCHAR(16)  NOT NULL DEFAULT 'info',
    title    VARCHAR(255) NOT NULL DEFAULT '',
    body     TEXT,
    -- 点击后跳转的面板路径；为空表示这条消息没有可跳转的目标
    link     VARCHAR(255) NOT NULL DEFAULT '',
    created  BIGINT       NOT NULL DEFAULT 0,
    -- 0 = 未读
    read_at  BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_notifications_owner (username, id DESC),
    KEY idx_notifications_unread (username, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# --------------------------------------------------------------------- 写入
def _owner(username: Any) -> str:
    """消息归属的唯一来源：所有读写都用它，空值即「没有归属」。

    只做规范化，不做权限判断 —— 权限判断在接口层（见 routers/notifications.py
    的 ``_own``，那里取不到用户名会直接 403）。
    """
    return str(username or "").strip()


async def push(
    username: str,
    *,
    title: str,
    body: str = "",
    link: str = "",
    kind: str = "alert",
    level: str = "info",
    created: Optional[int] = None,
) -> None:
    """给某个用户留一条站内消息。

    没有归属（``username`` 为空）时直接丢弃：消息中心是按用户看未读的，
    无主消息永远不会有人看到，写进去只会白占空间。
    """
    owner = _owner(username)
    if not owner:
        return
    async with database.connect() as db:
        await db.execute(
            "INSERT INTO notifications"
            " (username, kind, level, title, body, link, created, read_at)"
            " VALUES (?,?,?,?,?,?,?,0)",
            (
                owner,
                str(kind or "alert")[:32],
                str(level or "info")[:16],
                str(title or "")[:255],
                str(body or "")[:4000],
                str(link or "")[:255],
                int(created if created is not None else time.time()),
            ),
        )
        await db.commit()


# --------------------------------------------------------------------- 读取
def _row_to_item(row: Any) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": row["kind"] or "alert",
        "level": row["level"] or "info",
        "title": row["title"] or "",
        "body": row["body"] or "",
        "link": row["link"] or "",
        "created": int(row["created"] or 0),
        "read": int(row["read_at"] or 0) > 0,
    }


async def unread_count(username: str) -> int:
    """未读数。铃铛轮询只取这个值，走 ``(username, read_at)`` 索引。"""
    owner = _owner(username)
    if not owner:
        return 0
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM notifications WHERE username = ? AND read_at = 0",
            (owner,),
        )
        row = await cursor.fetchone()
    return int(row[0]) if row else 0


async def list_for(
    username: str,
    *,
    limit: int = DEFAULT_LIMIT,
    unread_only: bool = False,
) -> List[Dict[str, Any]]:
    """按时间倒序取消息。永远只针对自己的行。"""
    owner = _owner(username)
    if not owner:
        return []
    size = max(1, min(int(limit), MAX_LIMIT))
    sql = "SELECT * FROM notifications WHERE username = ?"
    params: List[Any] = [owner]
    if unread_only:
        sql += " AND read_at = 0"
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(size)

    async with database.connect() as db:
        cursor = await db.execute(sql, params)
        rows = await cursor.fetchall()
    return [_row_to_item(row) for row in rows]


# --------------------------------------------------------------------- 已读
async def mark_read(
    username: str,
    *,
    ids: Optional[Sequence[int]] = None,
    all_items: bool = False,
) -> int:
    """把某些消息（或全部）标记为已读，返回本次影响的行数。

    ``username`` 条件永远带上：``ids`` 是**不可信输入**，只靠 id 更新的话，
    改一个数字就能把别人的消息标成已读 —— 这本身危害不大，但它说明这些 id
    被当成了受保护资源，而同一个模式放到「删除」上就是致命的。
    """
    owner = _owner(username)
    if not owner:
        return 0
    async with database.connect() as db:
        if all_items:
            cursor = await db.execute(
                "UPDATE notifications SET read_at = ? WHERE username = ? AND read_at = 0",
                (int(time.time()), owner),
            )
        else:
            wanted = [int(i) for i in (ids or [])]
            if not wanted:
                return 0
            marks = ", ".join("?" for _ in wanted)
            cursor = await db.execute(
                f"UPDATE notifications SET read_at = ?"
                f" WHERE username = ? AND read_at = 0 AND id IN ({marks})",
                [int(time.time()), owner, *wanted],
            )
        affected = cursor.rowcount
        await db.commit()
    return max(affected, 0)


# --------------------------------------------------------------------- 清空
async def clear(username: str) -> int:
    """清空某个用户的消息中心，返回删掉的条数。

    ``username`` 条件由本函数自己拼进 SQL（与其它函数一致）：让人「随手改一个
    参数就能清掉别人的消息」不是权限问题，是设计问题。
    """
    owner = _owner(username)
    if not owner:
        return 0
    async with database.connect() as db:
        cursor = await db.execute(
            "DELETE FROM notifications WHERE username = ?", (owner,)
        )
        removed = cursor.rowcount
        await db.commit()
    return max(removed, 0)


# --------------------------------------------------------------------- 保留
async def purge_old(now: Optional[float] = None) -> int:
    """清理超出保留期的消息。分批删，避免长时间持锁。"""
    cutoff = int((now if now is not None else time.time()) - RETENTION_DAYS * 86_400)
    deleted = 0
    async with database.connect() as db:
        for _ in range(20):
            cursor = await db.execute(
                "DELETE FROM notifications WHERE created < ? LIMIT ?",
                (cutoff, 5_000),
            )
            affected = cursor.rowcount
            await db.commit()
            if affected <= 0:
                break
            deleted += affected
            if affected < 5_000:
                break
    if deleted:
        logger.info("清理过期站内消息 %d 条（保留 %d 天）", deleted, RETENTION_DAYS)
    return deleted


# --------------------------------------------------------------- 告警接线
def link_for_alert(entry: Dict[str, Any]) -> str:
    """按告警条目推算「点进去该看哪里」。

    拿不准时回落到「监控告警」页：跳到一个可能 404 的资源上，比跳到一个能看见
    上下文的地方更糟。虚拟机的类型（qemu / lxc）只有在告警产生时才知道，
    旧版本的 ``alert_active`` 行里没有这个字段，那种情况也走回落。
    """
    target_type = str(entry.get("target_type") or "")
    node = str(entry.get("node") or "")
    vmid = entry.get("vmid")

    if target_type == "node" and node:
        return f"/nodes/{node}"
    if target_type == "vm" and node and vmid:
        family = "lxc" if str(entry.get("guest_type") or "") == "lxc" else "vms"
        return f"/{family}/{node}/{vmid}"
    return "/alerts"


def alert_message(entry: Dict[str, Any]) -> Dict[str, Any]:
    """把一条告警条目转成站内消息的字段。"""
    kind = str(entry.get("kind") or "alarm")
    recovered = kind == "recovery"
    target = str(entry.get("target") or "-")
    metric = str(entry.get("metric") or "")

    if recovered:
        title = i18n.pick(f"已恢复：{target}", f"Recovered: {target}")
        level = "success"
        event = "recovery"
    else:
        title = i18n.pick(f"告警：{target}", f"Alert: {target}")
        # 严重级别只表达「是告警还是恢复」；投递到没到外部渠道写在正文里，
        # 混进级别反而会让人以为「没发出去 = 不严重」
        level = "danger"
        event = "alert"

    lines: List[str] = []
    threshold = entry.get("threshold")
    value = entry.get("value")
    if not recovered and threshold:
        lines.append(
            i18n.pick(
                f"{metric} 当前 {value}，阈值 {threshold}",
                f"{metric} is {value}, threshold {threshold}",
            )
        )
    if entry.get("node"):
        lines.append(i18n.tr("节点：") + str(entry.get("node")))
    # detail 是外部通道的投递结果（"飞书：已发送；Webhook：HTTP 500"）。只有确实
    # 没送达才单独列出来 —— 用户可能正是因为收不到飞书/邮件才打开铃铛的，
    # 这里必须能一眼看出「通知压根没发出去」。
    detail = str(entry.get("detail") or "")
    if detail and str(entry.get("result") or "") != "sent":
        lines.append(i18n.tr("外部通道未送达：") + detail)

    return {
        "kind": event,
        "level": level,
        "title": title,
        "body": "\n".join(line for line in lines if line),
        "link": link_for_alert(entry),
    }


async def _guest_belongs_to(entry: Dict[str, Any], username: str) -> bool:
    """这条资源告警的虚拟机是不是 ``username`` 名下的（BUG-013 的最后一道闸）。

    归属判定在 ``alerting.evaluate`` 里已经做过一次（普通用户的规则只覆盖自己名下
    的机器），但站内消息是**唯一会出现机器名称与指标值**的落点，值得在写入口再
    核一遍：上游任何一条路径（旧规则、手工写进 settings 的规则、账号清单读失败的
    回落）算错了收件人，这里都能拦住，而不是把别人的机器名写进他的铃铛。

    三种情况放行，只有「明确属于别人」才丢弃：

    * 不是虚拟机告警（宿主机 / 备份 / 登录告警没有 guest 归属可言）；
    * 归属表里查不到（机器在面板之外创建，或已删除）：这类告警由管理员的规则
      兜底，收件人通常就是管理员，不能一刀切丢掉；
    * 归属表读失败：宁可保留告警，也不能因为一次数据库抖动把该发的告警吞掉
      （告警丢失比一条多发的消息严重得多）。
    """
    if str(entry.get("target_type") or "") != "vm":
        return True
    vmid = entry.get("vmid")
    if vmid is None or not str(vmid):
        return True
    try:
        owners = await ownership.guest_owners_map()
    except Exception:  # noqa: BLE001 - 读不到归属时按旧行为放行
        logger.warning("校验告警归属失败，按原收件人投递", exc_info=True)
        return True
    owner = ownership.vm_owner_from(
        owners,
        entry.get("node"),
        vmid,
        str(entry.get("connection_id") or ""),
    )
    return not owner or owner == username


async def push_alert(entry: Dict[str, Any], created: Optional[int] = None) -> None:
    """把一条告警 / 恢复记录投递到这条告警**收件人**的站内消息里。

    ``entry["username"]`` 由调用方决定是谁：资源告警填机器归属者（不是配规则的人，
    见 :class:`app.alerting.RecipientBook`），其余来源填各自策略里的接收人。

    资源告警在落库前再按**当前归属**复核一次（见 :func:`_guest_belongs_to`）：
    收件人不是这台机器的主人时直接丢弃并记一条 warning，避免任何上游口径偏差把
    别人的虚拟机名称 / 监控数据写进这个账号的消息中心。
    """
    username = str(entry.get("username") or "")
    if username and not await _guest_belongs_to(entry, username):
        logger.warning(
            "丢弃归属不符的告警消息：收件人=%s target=%s node=%s vmid=%s",
            username,
            entry.get("target"),
            entry.get("node"),
            entry.get("vmid"),
        )
        return
    message = alert_message(entry)
    await push(
        username,
        title=message["title"],
        body=message["body"],
        link=message["link"],
        kind=message["kind"],
        level=message["level"],
        created=created,
    )


async def purge_foreign_guest_items() -> int:
    """清掉「消息里的虚拟机已经不属于收件人」的存量站内消息，返回删除条数。

    为什么需要它：BUG-013 里那批消息是**旧版本**生成的（升级前的规则没有按机器
    归属过滤），代码修好之后它们仍会留在铃铛里 90 天 —— 普通用户照样能读到别人
    的机器名。启动时跑一遍，把「链接指向的机器明确归别人」的消息删掉；历史审计
    不受影响（``alert_history`` 是另一张表，且刻意不迁移）。

    三条边界，都是为了不误删：

    * 只看 ``/vms/<节点>/<vmid>`` 与 ``/lxc/<节点>/<vmid>`` 两种链接，其余消息
      （更新提醒、登录告警、宿主机告警）一概不碰；
    * 管理员 / 区域管理员的消息不碰 —— 他们本来就有全局视野，收到别人的告警是
      权限内的正常结果；
    * 归属查不到、或同一 (节点, VMID) 在多条连接上指向不同人时跳过（无法判定）。
    """
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT id, username, link FROM notifications"
                " WHERE link LIKE '/vms/%' OR link LIKE '/lxc/%'"
            )
            rows = await cursor.fetchall()
        if not rows:
            return 0
        owners = await ownership.guest_owners_map()
        from . import store  # noqa: PLC0415 - 只在清理路径需要账号表

        users = await store.list_users()
    except Exception:  # noqa: BLE001 - 清理失败不该影响启动 / 其它作业
        logger.warning("清理越界站内消息失败，跳过本轮", exc_info=True)
        return 0

    supervisors = {
        str(item.get("username") or "")
        for item in users or []
        if str(item.get("role") or "") in ("admin", "region_admin")
    }

    # (节点, VMID) → 这套机器在归属表里出现过的全部主人。同一对键出现在多条
    # 连接上且主人不同时无法判定（见 ownership.vm_owner_from 的同款取舍）。
    by_guest: Dict[str, set] = {}
    for ref, value in owners.items():
        parts = str(ref or "").rsplit(":", 2)
        if len(parts) != 3 or not str(value or ""):
            continue
        by_guest.setdefault(f":{parts[1]}:{parts[2]}", set()).add(str(value))

    doomed: List[int] = []
    for row in rows:
        owner = str(row["username"] or "")
        if not owner or owner in supervisors:
            continue
        parts = [part for part in str(row["link"] or "").split("/") if part]
        if len(parts) != 3 or parts[0] not in ("vms", "lxc"):
            continue
        found = by_guest.get(f":{parts[1]}:{parts[2]}") or set()
        if len(found) == 1 and owner not in found:
            doomed.append(int(row["id"]))

    removed = 0
    async with database.connect() as db:
        for start in range(0, len(doomed), 500):
            chunk = doomed[start : start + 500]
            marks = ", ".join("?" for _ in chunk)
            cursor = await db.execute(
                f"DELETE FROM notifications WHERE id IN ({marks})", chunk
            )
            removed += max(cursor.rowcount, 0)
        await db.commit()
    if removed:
        logger.info("清理归属不符的存量站内消息 %d 条", removed)
    return removed
