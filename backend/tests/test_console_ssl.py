"""控制台代理的 TLS 策略（回归：`build_ssl_context` 漏导入导致 VNC 全挂）。

线上症状：点开控制台 -> 上游 wss 建不起来 -> 前端提示「与 VNC 代理的连接意外中断」，
日志里是 ``console proxy upstream failed ... name 'build_ssl_context' is not defined``。
纯语法/导入错误，跑一次这个用例就能拦住。
"""
from __future__ import annotations

import ssl

from app.routers import console


def test_ssl_context_without_ca_returns_unverified_when_disabled() -> None:
    ctx = console._ssl_context("wss://pve:8006/api2/json", False)
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.check_hostname is False
    assert ctx.verify_mode == ssl.CERT_NONE


def test_ssl_context_with_ca_pins_the_certificate() -> None:
    """配了 ca_cert 就走钉扎：只认那张证书，主机名不参与校验。"""
    # 只为验证「函数能跑到 build_ssl_context」：cadata 用一段占位 PEM 会抛
    # ssl.SSLError，说明确实进了钉扎分支，而不是 NameError。
    try:
        console._ssl_context("wss://pve:8006/api2/json", True, "not-a-pem")
    except ssl.SSLError:
        pass
    else:  # pragma: no cover - 占位 PEM 不该被接受
        raise AssertionError("占位 PEM 应当被 OpenSSL 拒绝")


def test_ssl_context_is_none_for_plain_ws() -> None:
    assert console._ssl_context("ws://pve:8006/api2/json", True) is None
