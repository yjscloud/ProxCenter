"""邮件模块的单元测试。

这些用例**不需要 MySQL、也不需要真实 SMTP**：只验证纯逻辑（收件人归一、
是否算配好、脱敏、报文构造、模板内容、会话复用），投递本身用 monkeypatch
换掉，所以整个文件连数据库都不会碰。
"""
from __future__ import annotations

import asyncio
import os
import smtplib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import mailer  # noqa: E402


def run(coro):
    return asyncio.run(coro)


READY_CFG = {
    "enabled": True,
    "host": "smtp.example.com",
    "port": 587,
    "tls": "starttls",
    "username": "panel",
    "password": "secret",
    "sender": "noreply@example.com",
    "sender_name": "ProxCenter",
    "verify_ssl": True,
    "admin_recipients": "",
}


# ---------------------------------------------------------------- 纯函数
class TestRecipients:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("a@b.com", ["a@b.com"]),
            ("a@b.com, c@d.com", ["a@b.com", "c@d.com"]),
            ("a@b.com;c@d.com", ["a@b.com", "c@d.com"]),
            ("a@b.com\nc@d.com", ["a@b.com", "c@d.com"]),
            ("  a@b.com ,, ", ["a@b.com"]),
            ("", []),
            (None, []),
            # 内部调用方常常直接拿着 list，不能被 str() 成畸形地址
            (["a@b.com", "c@d.com"], ["a@b.com", "c@d.com"]),
            ((), []),
        ],
    )
    def test_normalises_separators(self, raw: object, expected: list) -> None:
        assert mailer.recipients_of(raw) == expected


class TestIsConfigured:
    def test_ready(self) -> None:
        assert mailer.is_configured(READY_CFG)

    @pytest.mark.parametrize(
        "patch",
        [
            {"enabled": False},
            {"host": ""},
            {"sender": "", "username": ""},
        ],
    )
    def test_missing_piece_means_not_ready(self, patch: dict) -> None:
        cfg = {**READY_CFG, **patch}
        assert not mailer.is_configured(cfg)

    def test_username_can_stand_in_for_sender(self) -> None:
        cfg = {**READY_CFG, "sender": ""}
        assert mailer.is_configured(cfg)


class TestPublicView:
    def test_password_never_leaves_the_backend(self) -> None:
        safe = mailer.public_mail(READY_CFG)
        assert "password" not in safe
        assert safe["password_set"] is True
        assert safe["configured"] is True

    def test_password_set_flag_tracks_reality(self) -> None:
        safe = mailer.public_mail({**READY_CFG, "password": ""})
        assert safe["password_set"] is False


# ------------------------------------------------------------ 失败原因解释
class TestDescribeError:
    """底层异常 → 可照着排查的中文。

    回归背景：线上「发送测试邮件」一直失败，界面只显示
    ``发送失败：Connection unexpectedly closed: timed out`` ——
    既看不出是端口选错了还是被墙了。实测原因是 163 的 587 端口从该机房
    「TCP 连得上但一直不回问候语」，换 465 + SSL 立刻正常。
    这组用例把「连不上 / 连上了但不说话 / 认证被拒」这三类彻底分开。
    """

    BASE = {"host": "smtp.163.com", "port": 587, "tls": "starttls", "username": ""}

    def test_greeting_timeout_mentions_outbound_blocking(self) -> None:
        msg = mailer.describe_error(TimeoutError("timed out"), dict(self.BASE))
        assert "smtp.163.com:587" in msg
        # 587 + STARTTLS 是正确配对，所以不该往「配置写错」上引
        assert "不匹配" not in msg
        assert "出网" in msg and "465" in msg

    def test_greeting_timeout_flags_port_tls_mismatch(self) -> None:
        cfg = {**self.BASE, "port": 465, "tls": "starttls"}
        msg = mailer.describe_error(TimeoutError("timed out"), cfg)
        assert "不匹配" in msg
        assert "SSL" in msg

    def test_connect_failure_is_distinguished_from_silent_server(self) -> None:
        # smtplib 用 "connect:" 前缀包装建连失败，不能和「连上了但不说话」混为一谈
        msg = mailer.describe_error(OSError(110, "connect:timed out"), dict(self.BASE))
        assert "无法连接" in msg
        assert "问候语" not in msg

    def test_dns_failure(self) -> None:
        import socket

        msg = mailer.describe_error(
            socket.gaierror(-2, "Name or service not known"), dict(self.BASE)
        )
        assert "无法解析" in msg

    def test_auth_failure_points_at_authorization_code(self) -> None:
        import smtplib

        msg = mailer.describe_error(
            smtplib.SMTPAuthenticationError(535, b"Authentication failed"),
            dict(self.BASE),
        )
        assert "授权码" in msg

    def test_rejection_without_username_explains_auth_required(self) -> None:
        import smtplib

        msg = mailer.describe_error(
            smtplib.SMTPResponseException(
                553, b"Mail from must equal authorized user"
            ),
            dict(self.BASE),
        )
        assert "553" in msg
        assert "没有填 SMTP 账号" in msg

    def test_connection_refused(self) -> None:
        msg = mailer.describe_error(
            ConnectionRefusedError(111, "Connection refused"), dict(self.BASE)
        )
        assert "拒绝连接" in msg

    def test_unknown_error_falls_back_to_raw_text(self) -> None:
        msg = mailer.describe_error(ValueError("something odd"), dict(self.BASE))
        assert msg == "发送失败：something odd"


# ---------------------------------------------------------------- 发送
class TestSendMail:
    def test_delivers_to_every_recipient(self, monkeypatch) -> None:
        captured: dict = {}

        def fake_deliver(cfg, message):
            captured["cfg"] = cfg
            captured["message"] = message

        monkeypatch.setattr(mailer, "_deliver", fake_deliver)

        ok, detail = run(
            mailer.send_mail(
                "a@b.com, c@d.com", "主题行", "正文内容", cfg=READY_CFG
            )
        )
        assert ok, detail
        assert "2 个收件人" in detail

        message = captured["message"]
        assert message["Subject"] == "主题行"
        # 发件人带显示名
        assert "noreply@example.com" in str(message["From"])
        assert "c@d.com" in str(message["To"])
        assert "正文内容" in message.get_body(preferencelist=("plain",)).get_content()

    def test_html_alternative_is_attached(self, monkeypatch) -> None:
        captured: dict = {}
        monkeypatch.setattr(
            mailer, "_deliver", lambda cfg, msg: captured.update(message=msg)
        )
        run(
            mailer.send_mail(
                "a@b.com", "s", "plain body", html="<b>html body</b>", cfg=READY_CFG
            )
        )
        assert captured["message"].is_multipart()
        subtypes = {part.get_content_subtype() for part in captured["message"].iter_parts()}
        assert {"plain", "html"} <= subtypes

    @pytest.mark.parametrize(
        "cfg,expected",
        [
            ({**READY_CFG, "enabled": False}, "未启用"),
            ({**READY_CFG, "host": ""}, "未配置 SMTP"),
            ({**READY_CFG, "sender": "", "username": ""}, "未配置发件人"),
        ],
    )
    def test_refuses_without_a_working_config(self, cfg, expected) -> None:
        ok, detail = run(mailer.send_mail("a@b.com", "s", "b", cfg=cfg))
        assert not ok
        assert expected in detail

    def test_no_recipient_is_refused_before_touching_smtp(self) -> None:
        ok, detail = run(mailer.send_mail("", "s", "b", cfg=READY_CFG))
        assert not ok
        assert "没有收件人" in detail

    def test_transport_error_becomes_a_friendly_failure(self, monkeypatch) -> None:
        import smtplib

        def boom(cfg, message):
            raise smtplib.SMTPConnectError(421, "service not available")

        monkeypatch.setattr(mailer, "_deliver", boom)
        ok, detail = run(mailer.send_mail("a@b.com", "s", "b", cfg=READY_CFG))
        assert not ok
        # 不抛异常，且返回带服务器地址与响应码的中文说明（而不是原始异常字符串）
        assert "smtp.example.com:587" in detail
        assert "421" in detail


# ------------------------------------------------------------ 会话复用
class _FakeServer:
    """最小可用的假 SMTP：只实现 _open / _deliver 用到的那几个方法。

    记录「建了几次连、登录了几次、每封发到哪个会话上」，用来验证批量告警
    只登录一次；``fail_next_send`` 模拟服务端把复用的会话掐掉。
    """

    instances: list = []
    fail_next_send = False
    reject_next_send = False
    attempts = 0

    def __init__(self, host, port, timeout=None, context=None):
        self.host = host
        self.port = port
        self.logins = 0
        self.sent: list = []
        self.quit_called = False
        _FakeServer.instances.append(self)

    def ehlo(self) -> None:
        pass

    def starttls(self, context=None) -> None:
        pass

    def login(self, username, password) -> None:
        self.logins += 1

    def send_message(self, message) -> None:
        _FakeServer.attempts += 1
        if _FakeServer.fail_next_send:
            _FakeServer.fail_next_send = False
            raise smtplib.SMTPServerDisconnected("Connection unexpectedly closed")
        if _FakeServer.reject_next_send:
            _FakeServer.reject_next_send = False
            raise smtplib.SMTPRecipientsRefused({"a@b.com": (550, b"no such user")})
        self.sent.append(message)

    def quit(self) -> None:
        self.quit_called = True

    def close(self) -> None:
        pass


@pytest.fixture()
def fake_smtp(monkeypatch):
    mailer.reset_session()
    _FakeServer.instances = []
    _FakeServer.fail_next_send = False
    _FakeServer.reject_next_send = False
    _FakeServer.attempts = 0
    monkeypatch.setattr(smtplib, "SMTP", _FakeServer)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _FakeServer)
    yield _FakeServer
    mailer.reset_session()


class TestSessionReuse:
    """一批告警只建一次连、登一次录（这是「告警邮件一封都收不到」的修复点）。

    故障形态：一轮巡检连着发 8~10 封，每封都自己连一次 SMTP。公共邮箱对
    「同一账号短时间多次登录」有硬限制，超了就直接掐连接，
    ``send_mail`` 拿到 ``Connection unexpectedly closed``。收件人看到的
    是「邮件一封都收不到」，而飞书一切正常 —— 看起来像某个人的邮箱坏了。
    """

    def test_a_batch_logs_in_once(self, fake_smtp) -> None:
        for i in range(3):
            ok, detail = run(
                mailer.send_mail("a@b.com", f"主题 {i}", "正文", cfg=READY_CFG)
            )
            assert ok, detail

        assert len(fake_smtp.instances) == 1, "三封邮件不该建三次连接"
        assert fake_smtp.instances[0].logins == 1
        assert len(fake_smtp.instances[0].sent) == 3

    def test_disconnected_session_is_reopened_and_the_mail_resent(self, fake_smtp) -> None:
        """复用的会话被服务端掐掉时重连一次再发，而不是把这封丢掉。"""
        assert run(mailer.send_mail("a@b.com", "第一封", "正文", cfg=READY_CFG))[0]

        fake_smtp.fail_next_send = True
        ok, detail = run(mailer.send_mail("a@b.com", "第二封", "正文", cfg=READY_CFG))

        assert ok, detail
        assert len(fake_smtp.instances) == 2, "断线后应当重连"
        assert fake_smtp.instances[0].quit_called
        assert len(fake_smtp.instances[1].sent) == 1, "重连后要把这封补发出去"

    def test_a_changed_config_opens_a_new_session(self, fake_smtp) -> None:
        """换了服务器 / 账号 / 授权码必须重连，不能拿旧会话继续发。"""
        run(mailer.send_mail("a@b.com", "s", "b", cfg=READY_CFG))
        run(mailer.send_mail("a@b.com", "s", "b", cfg={**READY_CFG, "host": "smtp.other.com"}))

        assert len(fake_smtp.instances) == 2

    def test_an_idle_session_is_dropped(self, fake_smtp) -> None:
        """空闲超过 SESSION_IDLE 就丢掉：留着多半已经被服务端踢了。"""
        run(mailer.send_mail("a@b.com", "s", "b", cfg=READY_CFG))
        mailer._session.used -= mailer.SESSION_IDLE + 1

        run(mailer.send_mail("a@b.com", "s", "b", cfg=READY_CFG))
        assert len(fake_smtp.instances) == 2

    def test_a_rejected_mail_is_not_retried(self, fake_smtp) -> None:
        """收件人被拒（5xx）是业务错误：重试只会把同一封失败邮件再发一遍。"""
        fake_smtp.reject_next_send = True

        ok, detail = run(mailer.send_mail("a@b.com", "s", "b", cfg=READY_CFG))

        assert ok is False
        assert "550" in detail
        assert fake_smtp.attempts == 1, "5xx 不该触发重试"
        assert len(fake_smtp.instances) == 1, "5xx 不该触发重连"


# ---------------------------------------------------------------- 模板
class TestTemplates:
    def test_registration_mail_carries_the_essentials(self) -> None:
        subject, text, html = mailer.registration_mail(
            "zhangsan", "z@example.com", "10.0.0.9", "http://panel.local"
        )
        assert "zhangsan" in subject
        assert "待审批" in subject
        for needle in ("zhangsan", "z@example.com", "10.0.0.9", "http://panel.local"):
            assert needle in text
        assert "zhangsan" in html

    def test_approval_mail_names_the_role(self) -> None:
        subject, text, _ = mailer.approval_mail("lisi", "普通用户", "http://panel.local")
        assert "已通过" in subject
        assert "lisi" in text and "普通用户" in text

    def test_rejection_mail_optionally_includes_reason(self) -> None:
        _, without, _ = mailer.rejection_mail("wangwu", "", "http://panel.local")
        assert "说明" not in without

        _, with_reason, _ = mailer.rejection_mail(
            "wangwu", "非本单位人员", "http://panel.local"
        )
        assert "非本单位人员" in with_reason

    def test_alert_mail_joins_the_lines(self) -> None:
        subject, text, html = mailer.alert_mail(
            "CPU 使用率：web-01", ["CPU 使用率：95%", "节点：pve"]
        )
        assert subject == "CPU 使用率：web-01"
        assert "95%" in text and "节点：pve" in text
        assert "95%" in html
