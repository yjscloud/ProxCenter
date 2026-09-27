"""邮件发送。

面板只有一台 SMTP 服务器，配置是**全局的**（存在 settings 表里，只有管理员能改），
跟「按用户隔离」的告警通道不是一回事：告警的**收件人**按用户各自配置，
但发信用的服务器是同一个。

用标准库 ``smtplib`` 而不是引入新依赖 —— 项目一直刻意保持依赖精简，
而 ``smtplib`` 是阻塞的，所以统一用 ``asyncio.to_thread`` 丢到线程里，
不阻塞事件循环。

约定与项目其它模块保持一致：

* 密码落库前用 :func:`crypto.encrypt` 加密，**永不回传前端**，只回 ``password_set``；
  保存时留空表示沿用旧值，要清空得显式传 ``password_clear``。
* 发送函数返回 ``(ok, 中文详情)``，任何异常都吞掉转成失败信息，不往外抛。
"""
from __future__ import annotations

import asyncio
import json
import logging
import smtplib
import socket
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from typing import Any, Dict, List, Optional, Tuple

from . import crypto, store

logger = logging.getLogger(__name__)

MAIL_KEY = "mail_settings"

# 落库前加密的字段
SENSITIVE_KEYS = ("password",)

# TLS 方式：starttls（587，最常见）/ ssl（465）/ none（内网明文）
TLS_MODES = ("starttls", "ssl", "none")

DEFAULT_MAIL: Dict[str, Any] = {
    "enabled": True,
    "host": "",
    "port": 587,
    "tls": "starttls",
    "username": "",
    "password": "",
    "sender": "",
    "sender_name": "ProxCenter",
    # 自签证书的校内邮件服务器很常见，默认严格校验，需要时关掉
    "verify_ssl": True,
    # 注册 / 审批类通知的收件人。留空则发给所有启用了账号且填了邮箱的管理员。
    "admin_recipients": "",
}

SEND_TIMEOUT = 10


class MailConfigError(ValueError):
    """配置不合法。调用方转成 400。"""


def _clean_text(value: Any, limit: int = 255) -> str:
    return str(value or "").strip()[:limit]


def _clean_recipients(value: Any) -> str:
    """把逗号 / 分号 / 换行分隔的收件人串归一成英文逗号分隔。"""
    raw = str(value or "")
    parts = [p.strip() for p in raw.replace(";", ",").replace("\n", ",").split(",")]
    return ",".join(p for p in parts if p)[:1000]


def recipients_of(value: Any) -> List[str]:
    """把「收件人」统一成列表。

    既接受``"a@b.com, c@d.com"`` 这种串，也接受已经是列表的情况 ——
    内部调用方常常手上直接拿着 list，不做兼容的话 ``str(list)`` 会被当成
    一个（畸形的）地址塞进 To 头，收件人静默丢失。
    """
    if isinstance(value, (list, tuple, set)):
        value = ",".join(str(item) for item in value)
    return [p for p in _clean_recipients(value).split(",") if p]


def is_configured(cfg: Optional[Dict[str, Any]] = None) -> bool:
    """配到「能发信」的程度了吗（不实际连接）。"""
    cfg = cfg or {}
    return bool(cfg.get("enabled")) and bool(cfg.get("host")) and bool(
        cfg.get("sender") or cfg.get("username")
    )


# ------------------------------------------------------------------ 读写配置
async def load_mail() -> Dict[str, Any]:
    cfg = dict(DEFAULT_MAIL)
    raw = await store.get_setting(MAIL_KEY)
    if raw:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            cfg.update(parsed)

    cfg["enabled"] = bool(cfg.get("enabled", True))
    cfg["verify_ssl"] = bool(cfg.get("verify_ssl", True))
    cfg["host"] = _clean_text(cfg.get("host"))
    cfg["username"] = _clean_text(cfg.get("username"))
    cfg["sender"] = _clean_text(cfg.get("sender"))
    cfg["sender_name"] = _clean_text(cfg.get("sender_name"), 64)
    cfg["admin_recipients"] = _clean_recipients(cfg.get("admin_recipients"))
    cfg["tls"] = str(cfg.get("tls") or "starttls").lower()
    if cfg["tls"] not in TLS_MODES:
        cfg["tls"] = "starttls"
    try:
        cfg["port"] = int(cfg.get("port") or 587)
    except (TypeError, ValueError):
        cfg["port"] = 587
    if not 1 <= cfg["port"] <= 65535:
        cfg["port"] = 587

    # 密码：解不开就当没配过（换了 secret_key 会这样）
    stored_password = str(cfg.get("password") or "")
    if stored_password:
        if crypto.is_encrypted(stored_password):
            try:
                cfg["password"] = crypto.decrypt(stored_password)
            except Exception:  # noqa: BLE001 - 密钥换了就当作未配置
                logger.warning("邮件密码解密失败，已按未配置处理")
                cfg["password"] = ""
        # 兼容历史明文：下次保存会自动加密
    return cfg


async def save_mail(raw: Dict[str, Any]) -> Dict[str, Any]:
    """保存邮件配置。密码留空 = 沿用旧值，``password_clear`` 才清空。"""
    current = await load_mail()
    next_cfg = dict(current)

    next_cfg["enabled"] = bool(raw.get("enabled", current["enabled"]))
    next_cfg["verify_ssl"] = bool(
        raw.get("verify_ssl", current["verify_ssl"])
    )
    for key in ("host", "username", "sender", "sender_name"):
        if key in raw:
            next_cfg[key] = _clean_text(raw.get(key))

    if "tls" in raw:
        mode = str(raw.get("tls") or "").lower()
        if mode not in TLS_MODES:
            raise MailConfigError(f"不支持的加密方式：{raw.get('tls')}")
        next_cfg["tls"] = mode

    if "port" in raw and raw.get("port") not in (None, ""):
        try:
            port = int(raw.get("port"))
        except (TypeError, ValueError) as exc:
            raise MailConfigError("端口必须是数字") from exc
        if not 1 <= port <= 65535:
            raise MailConfigError("端口需在 1 - 65535 之间")
        next_cfg["port"] = port

    if "admin_recipients" in raw:
        next_cfg["admin_recipients"] = _clean_recipients(raw.get("admin_recipients"))

    # 密码：留空沿用、显式 clear 才清掉
    if raw.get("password_clear"):
        next_cfg["password"] = ""
    else:
        given = str(raw.get("password") or "")
        if given:
            next_cfg["password"] = given

    if next_cfg["enabled"] and not next_cfg["host"]:
        raise MailConfigError("启用邮件通知前需要先填写 SMTP 服务器地址")
    if next_cfg["enabled"] and not (next_cfg["sender"] or next_cfg["username"]):
        raise MailConfigError("需要填写发件人地址（或 SMTP 账号，用它作为发件人）")

    stored = dict(next_cfg)
    stored["password"] = crypto.encrypt(str(next_cfg.get("password") or ""))
    await store.set_setting(MAIL_KEY, json.dumps(stored, ensure_ascii=False))
    return await load_mail()


def public_mail(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """给前端的视图：**不含密码明文**，只说明有没有配。"""
    safe = {k: v for k, v in cfg.items() if k not in SENSITIVE_KEYS}
    safe["password_set"] = bool(cfg.get("password"))
    safe["configured"] = is_configured(cfg)
    return safe


# ---------------------------------------------------------------------- 发送
def _build_message(
    cfg: Dict[str, Any],
    sender: str,
    recipients: List[str],
    subject: str,
    body: str,
    html: Optional[str] = None,
) -> EmailMessage:
    message = EmailMessage()
    name = cfg.get("sender_name") or ""
    message["From"] = formataddr((name, sender)) if name else sender
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=True)
    message.set_content(body)
    if html:
        message.add_alternative(html, subtype="html")
    return message


def _ssl_context(verify: bool) -> ssl.SSLContext:
    if verify:
        return ssl.create_default_context()
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _deliver(cfg: Dict[str, Any], message: EmailMessage) -> None:
    """阻塞式投递，由 to_thread 调用。"""
    host = cfg["host"]
    port = int(cfg.get("port") or 587)
    mode = cfg.get("tls") or "starttls"
    context = _ssl_context(bool(cfg.get("verify_ssl", True)))

    if mode == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            host, port, timeout=SEND_TIMEOUT, context=context
        )
    else:
        server = smtplib.SMTP(host, port, timeout=SEND_TIMEOUT)

    try:
        if mode == "starttls":
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
        username = cfg.get("username") or ""
        if username:
            server.login(username, cfg.get("password") or "")
        server.send_message(message)
    finally:
        try:
            server.quit()
        except (smtplib.SMTPException, OSError):
            pass


# 各端口惯用的加密方式。两者对不上时 TCP 能连上，但双方都在等对方先开口，
# 最后表现为「读问候语超时」—— 这是「连得上却发不出邮件」最常见的原因。
_TLS_BY_PORT = {465: "ssl", 587: "starttls", 25: "none"}
_TLS_LABEL = {"ssl": "SSL / TLS", "starttls": "STARTTLS", "none": "不加密"}


def _smtp_text(exc: smtplib.SMTPResponseException) -> str:
    """拼出 ``535 Authentication failed`` 这样的可读串（smtp_error 是 bytes）。"""
    code = getattr(exc, "smtp_code", "") or ""
    raw = getattr(exc, "smtp_error", "") or ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return f"{code} {str(raw).strip()}".strip()


def describe_error(exc: BaseException, cfg: Dict[str, Any]) -> str:
    """把底层网络 / 协议异常翻成能照着排查的中文。

    异常原文几乎都不可行动：``Connection unexpectedly closed: timed out`` 看不出
    是端口选错了、还是出网被拦；``[Errno 111] Connection refused`` 也看不出该改
    什么。这里按最可能的原因补上具体建议。

    实测这个坑很值得写清楚：163 邮箱的 587 端口从某些机房就是「TCP 连得上、
    但一直不回问候语」，换成 465 + SSL 立刻正常，光看原始报错完全推不出来。
    """
    host = _clean_text(cfg.get("host")) or "SMTP 服务器"
    try:
        port = int(cfg.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    mode = str(cfg.get("tls") or "starttls")
    text = str(exc)
    addr = f"{host}:{port}" if port else host

    if isinstance(exc, socket.gaierror):
        return f"无法解析服务器地址「{host}」，请检查主机名是否拼错。"

    # smtplib 会把建连失败包成 "connect:<原因>"，与「连上了但服务器不说话」区分开
    if "connect:" in text:
        reason = text.split("connect:", 1)[1].strip()
        return (
            f"无法连接到 {addr}：{reason}。"
            "请确认地址与端口是否正确，以及该端口是否被机房防火墙放行。"
        )

    if isinstance(exc, TimeoutError) or "timed out" in text:
        parts = [
            f"{addr} 超时：TCP 能建立，但服务器 {SEND_TIMEOUT} 秒内没有返回"
            " SMTP 问候语。"
        ]
        wanted = _TLS_BY_PORT.get(port)
        if wanted and wanted != mode:
            parts.append(
                f"端口与加密方式很可能不匹配：{port} 端口要用"
                f"「{_TLS_LABEL[wanted]}」，当前选的是「{_TLS_LABEL.get(mode, mode)}」。"
            )
        else:
            parts.append(
                "端口与加密方式本身没问题，那么大概率是这台服务器到该端口的出网"
                "流量被防火墙或运营商拦截。部分邮箱（如 163）还会单独停用 587 提交"
                "端口，可以换 465 + SSL 再试。"
            )
        return "".join(parts)

    if isinstance(exc, smtplib.SMTPConnectError):
        return (
            f"{addr} 建立连接失败（{_smtp_text(exc)}）。"
            "请确认地址与端口是否正确，以及该端口是否被防火墙放行。"
        )

    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return (
            f"{addr} 拒绝登录（{_smtp_text(exc)}）。"
            "网易 / QQ 这类邮箱必须用「客户端授权码」而不是登录密码，"
            "并且要先在邮箱设置里开启 SMTP 服务。"
        )

    if isinstance(exc, smtplib.SMTPResponseException):
        hint = (
            "当前没有填 SMTP 账号，而公共邮箱必须认证后才能发信。"
            if not _clean_text(cfg.get("username"))
            else "请核对账号、授权码与发件人地址是否属于同一个邮箱。"
        )
        return f"{addr} 被服务器拒绝（{_smtp_text(exc)}）。{hint}"

    if isinstance(exc, ConnectionRefusedError) or "Connection refused" in text:
        return f"{addr} 拒绝连接：端口可能不对，或者服务没有在监听。"

    if isinstance(exc, ssl.SSLError):
        return (
            f"{addr} 的 TLS 握手失败（{text}）。"
            "若服务器用自签证书，可以关掉「校验服务器 SSL 证书」。"
        )

    return f"发送失败：{text}"


async def send_mail(
    to: Any,
    subject: str,
    body: str,
    *,
    html: Optional[str] = None,
    cfg: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str]:
    """发一封邮件。返回 ``(成功与否, 中文详情)``，绝不抛异常。"""
    recipients = recipients_of(to)
    if not recipients:
        return False, "没有收件人"

    cfg = cfg or await load_mail()
    if not cfg.get("enabled"):
        return False, "邮件通知未启用"
    if not cfg.get("host"):
        return False, "未配置 SMTP 服务器"
    sender = cfg.get("sender") or cfg.get("username") or ""
    if not sender:
        return False, "未配置发件人地址"

    try:
        message = _build_message(cfg, sender, recipients, subject, body, html)
    except Exception as exc:  # noqa: BLE001
        return False, f"构造邮件失败：{exc}"

    try:
        await asyncio.to_thread(_deliver, cfg, message)
    except (smtplib.SMTPException, OSError, ssl.SSLError, ValueError) as exc:
        logger.warning("邮件发送失败：%s", exc)
        return False, describe_error(exc, cfg)

    return True, f"已发送给 {len(recipients)} 个收件人"


async def admin_recipients() -> List[str]:
    """注册 / 审批类通知的收件人。

    优先用邮件设置里显式填的管理员收件地址；没填就退回到「所有启用了账号
    且填了邮箱的管理员」—— 后者不需要额外配置，但要求管理员在个人中心
    填过邮箱。
    """
    cfg = await load_mail()
    explicit = recipients_of(cfg.get("admin_recipients"))
    if explicit:
        return explicit

    found: List[str] = []
    for item in await store.list_users():
        if item.get("role") != "admin" or not item.get("enabled"):
            continue
        email = str(item.get("email") or "").strip()
        if email and email not in found:
            found.append(email)
    return found


async def send_to_admins(subject: str, body: str, *, html: Optional[str] = None) -> Tuple[bool, str]:
    targets = await admin_recipients()
    if not targets:
        return False, "没有可用的管理员收件地址（可在「邮件通知」里指定，或让管理员填写邮箱）"
    return await send_mail(targets, subject, body, html=html)


# ------------------------------------------------------------------ 邮件模板

# 邮件 HTML 的统一外壳。走的是「单列 + 纯内联样式」，因为手机上的邮件客户端
# （Gmail App / QQ 邮箱 / iOS 邮件 / Outlook）对 <style>、媒体查询、表格布局
# 的支持参差不齐，唯一横竖都成立的适配方式就是「不写死宽度 + 允许换行」。
_HTML_FONT_STACK = (
    "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif"
)
# 正文 15px：手机邮件客户端几乎都不对正文做自动放大，14px 偏小、16px 又会让
# 桌面端显得突兀，15px 是两边都不别扭的取值。
_HTML_BASE_STYLE = (
    "width:100%;max-width:600px;margin:0 auto;"
    f"font-family:{_HTML_FONT_STACK};font-size:15px;line-height:1.7;"
    "color:#1f2329;overflow-wrap:anywhere;-webkit-text-size-adjust:100%"
)


def wrap_html(title: str, lines: List[str], footer: str = "") -> str:
    """把若干行纯文本包成 HTML 正文。

    「手机友好」落在三个地方，都是不需要媒体查询就能生效的：

    * ``width:100%;max-width:600px`` —— 宽屏上不拉成一条长带，手机上正好铺满，
      两端同一份代码；
    * ``overflow-wrap:anywhere`` —— 告警正文里常出现很长的 IP / 存储路径 /
      URL，不加这条会顶出横向滚动条；
    * 空行渲染成占位段落 —— 原来的 ``<p></p>`` 高度会塌成 0，模板里用来分段的
      空字符串等于白写。
    """
    body = "".join(
        f"<p style='margin:6px 0'>{line}</p>"
        if line.strip()
        else "<p style='margin:6px 0'>&nbsp;</p>"
        for line in lines
    )
    tail = (
        "<p style='margin:18px 0 0;color:#8a8f99;font-size:12px;"
        f"overflow-wrap:anywhere'>{footer}</p>"
        if footer
        else ""
    )
    return (
        f"<div style='{_HTML_BASE_STYLE}'>"
        f"<h2 style='margin:0 0 12px;font-size:18px;line-height:1.4'>{title}</h2>"
        f"{body}{tail}</div>"
    )


def registration_mail(
    username: str, email: str, ip: str, panel_url: str
) -> Tuple[str, str, str]:
    """注册后通知管理员。"""
    subject = f"[待审批] 新用户注册申请：{username}"
    lines = [
        f"用户名：{username}",
        f"邮箱：{email or '（未填写）'}",
        f"来源 IP：{ip or '未知'}",
        f"提交时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "请登录面板「用户管理 → 待审批注册申请」进行审批。",
        panel_url,
    ]
    return subject, "\n".join(lines), wrap_html(
        "有新的注册申请待审批", lines[:-1], panel_url
    )


def approval_mail(
    username: str, role_label: str, panel_url: str
) -> Tuple[str, str, str]:
    """审批通过后通知注册用户。"""
    subject = "[已通过] 你的面板账号已开通"
    lines = [
        f"账号 {username} 的注册申请已通过审批。",
        f"分配角色：{role_label}",
        "",
        "现在可以用注册时设置的密码登录面板。",
        panel_url,
    ]
    return subject, "\n".join(lines), wrap_html(
        "账号已开通", lines[:-1], panel_url
    )


def rejection_mail(username: str, reason: str, panel_url: str) -> Tuple[str, str, str]:
    """审批拒绝后通知注册用户。"""
    subject = "[未通过] 你的面板账号申请未通过"
    lines = [
        f"账号 {username} 的注册申请未通过审批。",
    ]
    if reason:
        lines.append(f"说明：{reason}")
    lines += ["", "如有疑问请联系管理员。", panel_url]
    return subject, "\n".join(lines), wrap_html(
        "注册申请未通过", lines[:-1], panel_url
    )


def password_reset_mail(username: str, reset_url: str) -> Tuple[str, str, str]:
    """自助重置密码：把一次性链接发到账号邮箱。

    正文刻意不出现用户名以外的信息，并明确写清「不是本人操作就忽略」——
    密码重置邮件本身就是社工钓鱼的重灾区，收件人需要一眼判断是否是自己触发的。
    """
    subject = "[密码重置] 你的面板账号重置链接"
    lines = [
        f"账号 {username} 收到了一次密码重置请求。",
        "",
        "请在 30 分钟内打开下面的链接设置新密码（链接只能用一次）：",
        reset_url,
        "",
        "如果不是你本人操作，忽略这封邮件即可 —— 密码不会被改动。",
    ]
    html = (
        f"<div style='{_HTML_BASE_STYLE}'>"
        "<h2 style='margin:0 0 12px;font-size:18px;line-height:1.4'>"
        "重置你的面板密码</h2>"
        f"<p style='margin:6px 0'>账号 <b>{username}</b> 收到了一次密码重置请求。</p>"
        "<p style='margin:6px 0'>请在 30 分钟内点击下面的按钮设置新密码"
        "（链接只能用一次）：</p>"
        # 纯文字链接在手机上只有十几像素高的点击区，很容易点不中；
        # 改成有底色的块级按钮，高度约 45px，拇指够得着。
        f"<p style='margin:18px 0'><a href='{reset_url}'"
        " style='display:inline-block;padding:12px 22px;background:#2563eb;"
        "color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;"
        "border-radius:8px'>设置新密码</a></p>"
        # 按钮点不开时（被客户端拦掉、或在预览里点不了）还有一个可复制的
        # 地址，所以这行不是冗余 —— 重置链接是这条邮件的全部价值所在。
        "<p style='margin:0;color:#8a8f99;font-size:12px'>"
        "按钮打不开时，把下面的地址复制到浏览器：</p>"
        "<p style='margin:4px 0 0;color:#8a8f99;font-size:12px;"
        f"overflow-wrap:anywhere'>{reset_url}</p>"
        "<p style='margin:18px 0 0;color:#8a8f99;font-size:12px'>"
        "如果不是你本人操作，忽略这封邮件即可，密码不会被改动。</p>"
        "</div>"
    )
    return subject, "\n".join(lines), html


def alert_mail(title: str, items: List[str]) -> Tuple[str, str, str]:
    """告警 / 恢复通知。没有 URL 可用，正文里不放链接。"""
    text = "\n".join(items)
    return title, f"{title}\n\n{text}", wrap_html(title, items)
