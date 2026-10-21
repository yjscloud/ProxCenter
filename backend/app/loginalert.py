"""新来源 IP 登录告警。

威胁模型
--------
面板能管理整个 PVE 集群，凭据泄露的后果不是「多看了几台机器」，而是攻击者
可以直接开控制台、重置虚拟机密码、删机。审计日志事后能查到，但**发现**往往
滞后；这里在「第一次从某 IP 成功登录」时立刻提醒管理员。

为什么记 IP 而不是记「设备」
----------------------------
设备指纹可以伪造、浏览器也会升级 UA；来源 IP 是现成且稳定的信号。为了不
被 IPv6 隐私地址（同一设备每隔几小时换一个后缀）刷屏，IPv6 按 /64 归一 ——
同一个宽带下换地址不会重复报警，换网络才会。

只报「首次」
------------
去重表是 ``login_ips``（见 :mod:`app.store`），主键 (username, ip)，
``INSERT IGNORE`` 的 rowcount 就是答案。同一账号 + 同一来源只告警一次；
之后即使密码泄露也不会反复打扰，因为这时告警已经没有新信息。

通知怎么送
----------
* 站内消息：给每个管理员留一条（不依赖 SMTP，一定送得到）；
* 邮件：SMTP 已配置时同时发给管理员（``mailer.send_to_admins``）；
* 审计：写一条 ``auth.new_ip``，事后可按来源 IP / 账号回查。

投递放在后台任务里：登录响应不能被 SMTP 超时拖住，告警失败也绝不能影响
登录本身（见 :func:`note_login` 的异常边界）。
"""
from __future__ import annotations

import asyncio
import html as html_lib
import logging
import time
from ipaddress import ip_address, ip_network
from typing import Any, Dict, List, Optional, Set

from . import accesscontrol, i18n, mailer, notifications, panel_url, security, store
from .config import settings

logger = logging.getLogger(__name__)

#: 后台投递任务的强引用：asyncio 只持弱引用，任务可能被 GC 提前回收。
_BACKGROUND: Set[asyncio.Task] = set()

#: 登录方式 → (中文, English)
_METHODS = {
    "password": ("密码", "password"),
    "trusted_device": ("密码 + 信任设备（跳过动态码）", "password + trusted device (TOTP skipped)"),
    "2fa": ("密码 + 动态码", "password + TOTP code"),
    "recovery_code": ("密码 + 恢复码", "password + recovery code"),
}


def alert_key(ip: str) -> str:
    """告警去重键：IPv4 原样，IPv6 取 /64 网段。"""
    text = accesscontrol.normalize_ip(ip)
    if not text:
        return ""
    try:
        addr = ip_address(text)
    except ValueError:
        return text[:64]
    if addr.version == 6:
        return str(ip_network(f"{addr}/64", strict=False))[:64]
    return text


def _method_label(method: str) -> str:
    zh, en = _METHODS.get(method, (method, method))
    return i18n.pick(zh, en)


def _is_admin(user: Dict[str, Any]) -> bool:
    """管理员 = 内置 admin 角色，或自定义角色 / 覆盖里带 ``*`` 的人。"""
    if str(user.get("role") or "") == "admin":
        return True
    try:
        return "*" in security.effective_permissions(user)
    except Exception:  # noqa: BLE001 - 权限解析异常不该阻断告警
        return False


async def note_login(
    user: Dict[str, Any],
    request: Any,
    ip: str,
    method: str = "password",
) -> None:
    """登录成功后调用：记录来源 IP，首次出现时异步通知管理员。

    任何异常都在这里吞掉并记日志 —— 告警是旁路功能，不能把登录变成失败。
    """
    if not settings.login_ip_alert:
        return
    username = str(user.get("username") or "")
    key = alert_key(ip)
    if not username or not key:
        return

    try:
        first = await store.remember_login_ip(username, key)
    except Exception:  # noqa: BLE001
        logger.warning("记录登录来源失败：user=%s ip=%s", username, ip, exc_info=True)
        return
    if not first:
        return

    detail = {
        "ip": ip,
        "method": method,
        "role": user.get("role") or "",
        "user_agent": str(request.headers.get("user-agent") or "")[:200] if request else "",
        "first_seen": int(time.time()),
    }
    try:
        await store.add_audit(
            username=username,
            action="auth.new_ip",
            target=username,
            result="success",
            detail=detail,
            ip=ip,
        )
    except Exception:  # noqa: BLE001
        logger.warning("写入新 IP 登录审计失败：user=%s", username, exc_info=True)

    url = ""
    try:
        url = await panel_url.resolve(request)
    except Exception:  # noqa: BLE001 - 拿不到面板地址不影响站内消息
        url = ""

    task = asyncio.create_task(
        _notify_admins(username, ip, method, detail, url)
    )
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def _notify_admins(
    username: str,
    ip: str,
    method: str,
    detail: Dict[str, Any],
    url: str,
) -> None:
    try:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        method_label = _method_label(method)
        ua = str(detail.get("user_agent") or "") or "—"
        role = str(detail.get("role") or "") or "—"

        title = i18n.pick(
            f"[安全] 账号 {username} 从新 IP 登录",
            f"[Security] Account {username} signed in from a new IP",
        )
        lines = [
            i18n.pick(f"账号：{username}（角色 {role}）", f"Account: {username} (role {role})"),
            i18n.pick(f"来源 IP：{ip}", f"Source IP: {ip}"),
            i18n.pick(f"登录方式：{method_label}", f"Method: {method_label}"),
            i18n.pick(f"时间：{when}", f"Time: {when}"),
            i18n.pick(f"设备：{ua}", f"User agent: {ua}"),
            "",
            i18n.pick(
                "这是该账号第一次从这个 IP 登录。如非本人操作，请立即重置密码，"
                "并在「个人中心 → 退出所有设备」撤销会话与信任设备。",
                "This is the first sign-in from this IP for this account. If it was not "
                "you, reset the password now and revoke sessions and trusted devices "
                "under Profile → Sign out everywhere.",
            ),
        ]
        body = "\n".join(lines)
        if url:
            body += f"\n{url}"

        # 站内消息：每个管理员一条，不依赖 SMTP
        try:
            admins: List[Dict[str, Any]] = [
                row
                for row in await store.list_users()
                if row.get("enabled", True)
                and str(row.get("status") or store.STATUS_ACTIVE) == store.STATUS_ACTIVE
                and _is_admin(row)
            ]
        except Exception:  # noqa: BLE001
            admins = []
            logger.warning("读取管理员列表失败，跳过站内登录告警", exc_info=True)

        for admin in admins:
            try:
                await notifications.push(
                    str(admin.get("username") or ""),
                    title=title,
                    body=body,
                    link="/audit",
                    kind="security",
                    level="warning",
                )
            except Exception:  # noqa: BLE001 - 单个管理员失败不影响其它人
                logger.warning("推送登录告警站内消息失败", exc_info=True)

        # 邮件：未配置 SMTP / 没有管理员邮箱时 send_to_admins 自己会返回失败
        subject = i18n.pick(
            f"[ProxCenter] 新 IP 登录：{username} @ {ip}",
            f"[ProxCenter] New IP sign-in: {username} @ {ip}",
        )
        escaped = [html_lib.escape(line) for line in lines]
        html_body = mailer.wrap_html(
            i18n.pick("新 IP 登录告警", "New IP sign-in alert"),
            escaped,
            html_lib.escape(url) if url else "",
        )
        ok, info = await mailer.send_to_admins(subject, body, html=html_body)
        if not ok:
            logger.info("登录 IP 告警邮件未发送：%s", info)
    except Exception:  # noqa: BLE001 - 后台任务不能把异常抛给事件循环
        logger.exception("投递新 IP 登录告警失败：user=%s ip=%s", username, ip)
