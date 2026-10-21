"""FD-07 / FD-11 的边界回归（不连数据库）。

* 未显式传 ``verify_ssl`` 的连接不能静默变成「不校验」；
* ``ca_cert`` 优先于开关：填了就是钉扎（只认那张证书、不校验主机名）；
* API Token 有效期上限 365 天，且 ``0``（永不过期）必须被拒。
"""
from __future__ import annotations

import datetime
import ssl

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pydantic import ValidationError

from app.config import settings
from app.pve import PveConnection, build_ssl_context
from app.routers.tokens import TokenCreateIn


def _self_signed_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pve.local")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2026, 1, 1))
        .not_valid_after(datetime.datetime(2030, 1, 1))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def test_connection_defaults_to_settings_not_hardcoded_false() -> None:
    """忘传参数时跟随环境配置，而不是写死 False。

    测试环境把 ``PVE_VERIFY_SSL`` 关掉了（conftest），所以这里不能断言 True；
    要断言的是「签名里没有硬编码的 False」+「跟随 settings」。
    """
    import inspect

    default = inspect.signature(PveConnection.__init__).parameters[
        "verify_ssl"
    ].default
    assert default is None, "忘了传 verify_ssl 的调用方会静默关掉校验"

    conn = PveConnection()
    assert conn.verify_ssl is settings.pve_verify_ssl
    assert conn.ca_cert == ""
    # 显式传值仍然生效
    assert PveConnection(verify_ssl=True).verify_ssl is True


def test_build_ssl_context_modes() -> None:
    assert build_ssl_context(True) is True
    assert build_ssl_context(False) is False

    pinned = build_ssl_context(True, _self_signed_pem())
    assert isinstance(pinned, ssl.SSLContext)
    # 钉扎的对象是证书本身：PVE 用 IP 访问时 CN/SAN 对不上，主机名不参与校验
    assert pinned.check_hostname is False
    assert pinned.verify_mode == ssl.CERT_REQUIRED


def test_ca_cert_wins_over_disabled_switch() -> None:
    """即使 verify_ssl=False，填了 ca_cert 也按钉扎走（不会悄悄不校验）。"""
    assert isinstance(build_ssl_context(False, _self_signed_pem()), ssl.SSLContext)


def test_garbage_pem_is_rejected() -> None:
    with pytest.raises(ssl.SSLError):
        build_ssl_context(
            True, "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----"
        )


def test_token_ttl_is_capped_and_never_expiry_is_rejected() -> None:
    assert TokenCreateIn().ttl_days == 90
    assert TokenCreateIn(ttl_days=365).ttl_days == 365
    for bad in (0, -1, 366, 3650):
        with pytest.raises(ValidationError):
            TokenCreateIn(ttl_days=bad)
