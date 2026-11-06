"""ACME 客户端与 DNS 服务商适配层。

这一层不碰网络：签名、CSR、挑战值、记录名这些「算错就签不出证书」的纯逻辑
全部单独验一遍；真正的 ACME 交互只能靠集成环境跑（staging 目录 + 真实域名）。
"""
from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import acme, certs, dnsproviders  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ 域名
def test_normalise_domains_puts_wildcard_first() -> None:
    assert acme.normalise_domains(["b.example.com", "*.a.example.com", "A.example.com"]) == [
        "*.a.example.com",
        "a.example.com",
        "b.example.com",
    ]


def test_site_domains_merges_main_and_san() -> None:
    site = dict(certs.DEFAULT_SITE)
    site.update({"domain": "example.com", "domains": ["www.example.com", "example.com"]})
    assert certs.site_domains(site) == ["example.com", "www.example.com"]


def test_normalise_domain_accepts_wildcard() -> None:
    assert certs.normalise_domain("*.Example.COM") == "*.example.com"
    assert certs.normalise_domain("https://example.com/path") == "example.com"


def test_domain_length_ignores_wildcard_prefix() -> None:
    long_label = "a" * 60
    name = "*." + long_label + ".com"
    assert certs.normalise_domain(name) == name


# ------------------------------------------------------------------ 签名与 CSR
def _verify_jws_signature(key: acme.AccountKey, data: bytes, signature_b64: str) -> None:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    raw = base64.urlsafe_b64decode(signature_b64 + "=" * (-len(signature_b64) % 4))
    public = key.key.public_key()
    if isinstance(key.key, rsa.RSAPrivateKey):
        public.verify(raw, data, padding.PKCS1v15(), hashes.SHA256())
        return
    # ES256 的 r||s 是定长 32+32，转回 DER 才能交给 cryptography 验证
    r = int.from_bytes(raw[:32], "big")
    s = int.from_bytes(raw[32:], "big")
    public.verify(encode_dss_signature(r, s), data, ec.ECDSA(hashes.SHA256()))


@pytest.mark.parametrize("algorithm", [acme.KEY_RSA, acme.KEY_ECC])
def test_account_key_signs_verifiable_jws(algorithm: str) -> None:
    key = acme.AccountKey(acme.new_private_key(algorithm))
    data = b"protected.payload"
    _verify_jws_signature(key, data, key.sign(data))
    assert key.alg == ("RS256" if algorithm == acme.KEY_RSA else "ES256")


def test_account_key_thumbprint_is_stable() -> None:
    key = acme.AccountKey.load("")
    again = acme.AccountKey.load(key.pem)
    assert key.thumbprint == again.thumbprint
    assert key.thumbprint and "=" not in key.thumbprint


def test_thumbprint_matches_rfc7638_example() -> None:
    """RFC 7638 §3.1 的示例：JWK 指纹必须与规范给出的值一致。"""
    jwk = {
        "e": "AQAB",
        "kty": "RSA",
        "n": (
            "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt"
            "VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6"
            "4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD"
            "W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9"
            "1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH"
            "aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
        ),
    }
    assert acme.b64(hashlib.sha256(acme._canonical(jwk).encode()).digest()) == (
        "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
    )


def test_build_csr_contains_all_san_names() -> None:
    from cryptography import x509

    domains = ["example.com", "*.example.com", "www.example.com"]
    der = acme.build_csr(domains, acme.new_private_key(acme.KEY_RSA))
    csr = x509.load_der_x509_csr(der)
    san = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert sorted(san.get_values_for_type(x509.DNSName)) == sorted(domains)
    assert csr.is_signature_valid


def test_cert_expire_at_reads_leaf_not_after() -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.x509.oid import NameOID

    key = acme.new_private_key(acme.KEY_ECC)
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "example.com")]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "example.com")]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=90))
        .sign(key, hashes.SHA256())
    )
    pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")

    assert abs(acme.cert_expire_at(pem) - int((now + datetime.timedelta(days=90)).timestamp())) <= 2
    assert acme.cert_expire_at("not a certificate") == 0


def test_split_chain_returns_each_certificate() -> None:
    one = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n"
    assert len(acme.split_chain(one + one)) == 2
    assert acme.split_chain("garbage") == []


# ------------------------------------------------------------------ 挑战
class _FakeProvider:
    name = "fake"

    def __init__(self) -> None:
        self.created: List[Tuple[str, str]] = []
        self.deleted: List[Tuple[str, str]] = []

    async def create_txt(self, name: str, value: str) -> str:
        self.created.append((name, value))
        return "rec-" + str(len(self.created))

    async def delete_txt(self, name: str, record_id: str) -> None:
        self.deleted.append((name, record_id))


def test_dns01_solver_uses_acme_challenge_name_for_wildcard() -> None:
    provider = _FakeProvider()
    solver = acme.Dns01Solver(provider)

    _run(solver.present("*.example.com", "tok", "txt-value"))
    _run(solver.cleanup_all())

    assert provider.created == [("_acme-challenge.example.com", "txt-value")]
    assert provider.deleted == [("_acme-challenge.example.com", "rec-1")]


def test_dns01_solver_cleanup_ignores_provider_errors() -> None:
    class _Broken(_FakeProvider):
        async def delete_txt(self, name: str, record_id: str) -> None:
            raise dnsproviders.DnsError("boom")

    solver = acme.Dns01Solver(_Broken())
    _run(solver.present("a.example.com", "tok", "v"))
    _run(solver.cleanup_all())  # 不抛


def test_http01_solver_writes_and_cleans(tmp_path: Path) -> None:
    solver = acme.Http01Solver(str(tmp_path))
    _run(solver.present("a.example.com", "token-1", "token-1.thumb"))
    target = tmp_path / ".well-known" / "acme-challenge" / "token-1"
    assert target.read_text(encoding="utf-8") == "token-1.thumb"

    _run(solver.cleanup_all())
    assert not target.exists()


def test_http01_solver_requires_webroot(tmp_path: Path) -> None:
    with pytest.raises(acme.AcmeError):
        _run(acme.Http01Solver("").present("a.example.com", "t", "v"))


def test_pick_challenge_matches_type() -> None:
    authz = {
        "challenges": [
            {"type": "http-01", "url": "u1"},
            {"type": "dns-01", "url": "u2"},
        ]
    }
    assert acme._pick_challenge(authz, "dns-01")["url"] == "u2"
    assert acme._pick_challenge(authz, "tls-alpn-01") is None


def test_issue_rejects_wildcard_with_http01() -> None:
    client = acme.AcmeClient()
    with pytest.raises(acme.AcmeError):
        _run(client.issue(["*.example.com"], acme.Http01Solver("/tmp")))


# ------------------------------------------------------------------ DNS 适配
def test_zone_candidates_walks_up_the_tree() -> None:
    assert dnsproviders.zone_candidates("_acme-challenge.a.b.com") == [
        "_acme-challenge.a.b.com",
        "a.b.com",
        "b.com",
    ]


def test_build_provider_rejects_unknown_kind() -> None:
    with pytest.raises(dnsproviders.DnsError):
        dnsproviders.build_provider("nope", {})


@pytest.mark.parametrize(
    "kind,cfg",
    [
        ("dnspod", {"secret_id": "id"}),
        ("aliyun", {"access_key_id": "id"}),
        ("huawei", {"access_key_id": "id"}),
        ("cloudflare", {}),
    ],
)
def test_build_provider_requires_credentials(kind: str, cfg: Dict[str, Any]) -> None:
    with pytest.raises(dnsproviders.DnsError):
        dnsproviders.build_provider(kind, cfg)


def test_aliyun_signature_is_deterministic() -> None:
    """同一组参数必须签出同一个串 —— 排序不稳定会直接导致 InvalidSignature。"""
    params = {"Action": "AddDomainRecord", "DomainName": "example.com", "RR": "_acme-challenge"}
    first = dnsproviders._aliyun_query(params, "secret")
    second = dnsproviders._aliyun_query(dict(reversed(list(params.items()))), "secret")
    # SignatureNonce 之类的时间字段不在这里，所以两次结果应完全一致
    assert first == second
    assert "Signature=" in first


# ------------------------------------------------------------------ 站点校验
def _payload(**kw: Any) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "name": "测试站点",
        "domain": "example.com",
        "deploy_method": "local",
        "deploy_dir": "/tmp/certs",
    }
    data.update(kw)
    return data


def test_tencent_channel_rejects_wildcard() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(_payload(domain="*.example.com"))


def test_tencent_channel_rejects_extra_domains() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(_payload(domains=["www.example.com"]))


def test_acme_channel_accepts_wildcard_with_dns() -> None:
    site = certs.normalise_site(
        _payload(domain="*.example.com", ca="acme", acme_challenge="dns")
    )
    assert site["ca"] == "acme"
    assert certs.site_domains(site) == ["*.example.com"]


def test_acme_channel_rejects_wildcard_with_http() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(
            _payload(
                domain="*.example.com",
                ca="acme",
                acme_challenge="http",
                acme_webroot="/var/www/html",
            )
        )


def test_acme_http_requires_webroot() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(_payload(ca="acme", acme_challenge="http"))


def test_acme_webroot_must_be_absolute() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(
            _payload(ca="acme", acme_challenge="http", acme_webroot="var/www")
        )


def test_extra_domains_are_deduped_against_main() -> None:
    site = certs.normalise_site(
        _payload(
            ca="acme",
            domains=["www.example.com", "example.com", "WWW.example.com", "a.example.com"],
        )
    )
    assert site["domains"] == ["www.example.com", "a.example.com"]


def test_changing_domains_clears_cached_acme_cert() -> None:
    existing = certs.normalise_site(_payload(ca="acme"))
    existing.update(
        {"acme_pem": "-----BEGIN CERTIFICATE-----\nX", "acme_key": "k", "cert_id": "acme-1"}
    )

    same = certs.normalise_site(_payload(ca="acme"), existing)
    assert same["cert_id"] == "acme-1"  # 域名没变，证书继续有效

    changed = certs.normalise_site(_payload(ca="acme", domains=["www.example.com"]), existing)
    assert changed["cert_id"] == ""
    assert changed["acme_pem"] == ""
    assert changed["acme_key"] == ""


def test_switching_channel_clears_tencent_cert_id() -> None:
    existing = certs.normalise_site(_payload())
    existing["cert_id"] = "tencent-1"

    site = certs.normalise_site(_payload(ca="acme"), existing)
    assert site["cert_id"] == ""
