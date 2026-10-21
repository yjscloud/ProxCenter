"""用户账号有效期：到期前邮件提醒 + 到期冻结（关机 + 踢下线）。

为什么单独一个作业
------------------
「有效期」这件事有两个动作、两种节奏：

* **到期前 7 / 3 / 1 天各发一封邮件** —— 一天一次就够，但必须只发一次；
* **到期那一刻把账号名下正在跑的虚拟机 / 容器关掉，并冻结账号** —— 要尽快，
  而且只能做一次（不能每轮都去发关机请求）。

放进资源告警不合适（对象不是机器、判据也不是使用率），所以照
:mod:`app.quotaalert` 的做法自建一个后台作业，状态记在 users 表的三列里
（见 :mod:`app.store` 的 ``expires_at`` / ``expiry_notice`` / ``expiry_frozen``），
天然幂等，也不怕面板重启。

「冻结」不是 disable
--------------------
到期后**不改** ``enabled``，只是让 :func:`app.security._user_view` 与登录接口
按时间拒绝：管理员把有效期改到将来，用户立刻可以继续用，不必再手动启用一次。
冻结时顺手把会话 / API Token / 信任设备全部撤销，旧凭据不能继续用满 12 小时。

哪些账号会被处理
----------------
只处理 ``status = active`` 且 ``enabled = 1`` 的账号。待审批 / 已拒绝 / 被管理员
停用的账号本来就已经进不来，再去发提醒或关机只会制造噪音；管理员重新启用后，
下一轮作业会接着按有效期处理。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from . import i18n, mailer, ownership, panel_url, prefs, pve, security, store

logger = logging.getLogger(__name__)

#: 提前提醒的档位（天）。顺序无所谓，判定时按从小到大取「已经进入的最紧一档」。
REMIND_DAYS: Tuple[int, ...] = (7, 3, 1)

#: 关机等待时间（秒）。超过后 PVE 会按 forceStop 处理 —— 到期冻结是强制语义，
#: 客户机不理 ACPI 也不能让它一直跑着。
SHUTDOWN_TIMEOUT = 90


# --------------------------------------------------------------------- 判定
def account_expires_at(user: Dict[str, Any]) -> float:
    """账号有效期的 Unix 时间戳；0 = 永不过期（脏值同样按 0 处理）。"""
    try:
        return max(float(user.get("expires_at") or 0), 0.0)
    except (TypeError, ValueError):
        return 0.0


def reminder_stage(expires_at: float, now: Optional[float] = None) -> int:
    """按剩余时间取提醒档位：剩余 <=1 天 → 1，<=3 天 → 3，<=7 天 → 7。

    已过期 / 没设有效期返回 0（过期由 :func:`evaluate` 走冻结分支）。
    """
    if expires_at <= 0:
        return 0
    remaining = expires_at - (time.time() if now is None else now)
    if remaining <= 0:
        return 0
    for days in sorted(REMIND_DAYS):
        if remaining <= days * 86_400:
            return days
    return 0


# ------------------------------------------------------------------- 主入口
async def evaluate() -> Dict[str, Any]:
    """调度器作业：逐人检查有效期，该提醒的提醒、该冻结的冻结。"""
    now = time.time()
    notified = 0
    skipped = 0
    frozen = 0
    failures: List[str] = []

    for user in await store.list_users():
        if str(user.get("status") or store.STATUS_ACTIVE) != store.STATUS_ACTIVE:
            continue
        if not user.get("enabled", True):
            continue
        expires = account_expires_at(user)
        if expires <= 0:
            continue
        username = str(user.get("username") or "")
        if not username:
            continue

        if expires <= now:
            if float(user.get("expiry_frozen") or 0) > 0:
                continue
            try:
                outcome = await freeze_user(username)
            except Exception as exc:  # noqa: BLE001 - 单人失败不该拦住其它人
                logger.exception("冻结到期账号 %s 失败", username)
                failures.append(f"{username}: {exc}")
                continue
            if outcome is not None:
                frozen += 1
                if outcome.get("failures"):
                    failures.append(f"{username}: {'；'.join(outcome['failures'])}")
            continue

        stage = reminder_stage(expires, now)
        if stage <= 0:
            # 管理员把有效期延长到了 7 天以外：清掉旧档位，下次接近时重新提醒
            if int(user.get("expiry_notice") or 0) > 0:
                await store.set_expiry_notice(username, 0)
            continue

        sent = int(user.get("expiry_notice") or 0)
        # sent 记录的是「已经发到哪一档」（7 / 3 / 1，数字越小越接近到期）。
        # 只有还没发过、或进入更紧的一档时才发第二封。
        if sent and sent <= stage:
            continue

        ok = await _send_reminder(user, stage, expires)
        # 无论发没发出去都记档位：没邮箱 / 没配 SMTP 是「刻意跳过」，每 5 分钟
        # 重试一次只会刷日志；收件人后来补了邮箱，下一档（3 天 / 1 天）仍会收到。
        await store.set_expiry_notice(username, stage)
        if ok:
            notified += 1
        else:
            skipped += 1

    summary: Dict[str, Any] = {
        "notified": notified,
        "frozen": frozen,
        "skipped": skipped,
    }
    if failures:
        summary["errors"] = failures
    return summary


# ----------------------------------------------------------------- 到期冻结
async def freeze_user(username: str) -> Optional[Dict[str, Any]]:
    """冻结一个已到期账号：关掉名下客户机、撤销所有凭据、落审计。

    进入前重新读一次库并复核有效期 —— 管理员可能刚好在这一轮里把期限延长了，
    拿着上一秒的快照去关机是不可接受的。返回 ``None`` 表示「已不再需要冻结」。
    """
    user = await store.get_user(username)
    if not user or not security.is_account_expired(user):
        return None
    if float(user.get("expiry_frozen") or 0) > 0:
        return None

    shutdown = await shutdown_owned_guests(username)
    revoked = await security.revoke_user_credentials(username)
    await store.set_expiry_frozen(username, time.time())

    detail = {
        "expires_at": account_expires_at(user),
        "stopped": shutdown.get("stopped") or [],
        "failures": shutdown.get("failures") or [],
        "sessions_revoked": revoked.get("sessions", 0),
        "api_tokens_revoked": revoked.get("api_tokens", 0),
    }
    await store.add_audit(
        username="system",
        action="user.expire",
        target=username,
        result="success" if not shutdown.get("failures") else "partial",
        detail=detail,
    )
    logger.warning(
        "账号 %s 已到期：关闭 %d 台客户机（失败 %d），撤销 %d 个会话",
        username,
        len(shutdown.get("stopped") or []),
        len(shutdown.get("failures") or []),
        revoked.get("sessions", 0),
    )
    return {"stopped": shutdown.get("stopped") or [], "failures": shutdown.get("failures") or []}


# ------------------------------------------------------------- 关闭名下机器
def _split_ref(ref: str) -> Optional[Tuple[str, str, int]]:
    """把归属表里的 ``<连接>:<节点>:<vmid>`` 拆开；格式不对返回 ``None``。

    连接 id 与节点名都不含 ``:``（见 app.ownership 的说明），所以从右侧拆两刀
    是安全的 —— 旧记录 ``"-"`` 也能得到空连接 id。
    """
    parts = str(ref or "").rsplit(":", 2)
    if len(parts) != 3:
        return None
    connection_id, node, raw_vmid = parts
    try:
        vmid = int(raw_vmid)
    except (TypeError, ValueError):
        return None
    if not node:
        return None
    return connection_id, node, vmid


async def shutdown_owned_guests(username: str) -> Dict[str, List[str]]:
    """关闭该账号名下的虚拟机与容器（只关运行中的）。

    返回 ``{"stopped": [...], "failures": [...]}``。逐台查 status 再关机，而不是
    直接发 shutdown：PVE 对已停止的机器会回错误，把它记成「关机失败」会掩盖
    真正的问题。连接 / 节点找不到的跳过 —— 归属表里可能留着已删除连接的记录，
    那不是这个账号的错。
    """
    stopped: List[str] = []
    failures: List[str] = []

    pairs = pve.all_connection_clients()
    clients = {str((profile or {}).get("id") or ""): client for profile, client in pairs}
    ordered = [client for _, client in pairs]

    if not ordered:
        # 没有保存任何连接：退回到当前/默认连接；连配置都没有就无事可做
        try:
            ordered = [pve.get_client()]
        except Exception:  # noqa: BLE001 - 没配 PVE 不该让账号冻结失败
            return {"stopped": stopped, "failures": failures}

    for kind in ownership.GUEST_KINDS:
        for ref in await ownership.list_owned(kind, username):
            parsed = _split_ref(ref)
            if parsed is None:
                continue
            connection_id, node, vmid = parsed
            if connection_id and connection_id not in clients:
                # 连接已被删除：这台机器现在面板够不着，跳过（不制造失败噪音）
                continue
            targets = [clients[connection_id]] if connection_id in clients else ordered
            label = f"{node}/{vmid}"
            for client in targets:
                try:
                    status = await (
                        client.qemu_status(node, vmid)
                        if kind == ownership.KIND_VM
                        else client.lxc_status(node, vmid)
                    )
                except pve.ProxmoxError:
                    continue
                if str((status or {}).get("status") or "") != "running":
                    break
                try:
                    await (
                        client.qemu_power(
                            node, vmid, "shutdown",
                            timeout=SHUTDOWN_TIMEOUT, force_stop=True,
                        )
                        if kind == ownership.KIND_VM
                        else client.lxc_power(
                            node, vmid, "shutdown",
                            timeout=SHUTDOWN_TIMEOUT, force_stop=True,
                        )
                    )
                    stopped.append(label)
                except pve.ProxmoxError as exc:
                    failures.append(f"{label}: {exc.message}")
                break

    return {"stopped": stopped, "failures": failures}


# ------------------------------------------------------------------- 提醒信
async def _send_reminder(
    user: Dict[str, Any], days_left: int, expires_at: float
) -> bool:
    """发一封到期提醒。没有邮箱 / 未配置 SMTP / 发信失败都返回 ``False``。"""
    to = str(user.get("email") or "").strip()
    if not to:
        return False

    cfg = await mailer.load_mail()
    if not mailer.is_configured(cfg):
        return False

    username = str(user.get("username") or "")
    lang = await prefs.get(username, prefs.PREF_LANGUAGE, i18n.DEFAULT_LANG)
    expires_text = time.strftime("%Y-%m-%d %H:%M", time.localtime(expires_at))
    url = await panel_url.resolve()

    with i18n.use_language(lang):
        subject, text, html = mailer.account_expiry_mail(
            username, days_left, expires_text, url
        )
    ok, detail = await mailer.send_mail(to, subject, text, html=html, cfg=cfg)
    if not ok:
        logger.warning("给 %s 发送到期提醒失败：%s", username, detail)
    return ok
