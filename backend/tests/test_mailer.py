"""邮件模块的单元测试。

这些用例**不需要 MySQL、也不需要真实 SMTP**：只验证纯逻辑（收件人归一、
是否算配好、脱敏、报文构造、模板内容），投递本身用 monkeypatch 换掉，
所以整个文件连数据库都不会碰。
"""
from __future__ import annotations

import asyncio
import os
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
