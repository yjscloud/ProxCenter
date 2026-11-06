"""签发厂商抽象层：状态归一、证书取回、清单聚合与多站点绑定。

这些用例都不碰外部网络：厂商客户端只被喂它自己那份响应结构，验证的是
「各家差异 → 统一结构」这层翻译是否正确。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import certproviders, certs  # noqa: E402
from app.certproviders import aliyun, huawei, tencent as tencent_provider  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ 注册表
def test_registry_covers_mainstream_cas() -> None:
    kinds = certproviders.kinds()
    assert kinds == ["tencent", "aliyun", "huawei"]
    schema = {item["kind"]: item for item in certproviders.schema()}
    assert set(schema) == set(kinds)
    # 每家的凭据字段都要标出哪些是密文，前端据此决定要不要回显
    assert "secret_key" in schema["tencent"]["secret_fields"]
    assert "access_key_secret" in schema["aliyun"]["secret_fields"]
    assert schema["huawei"]["defaults"]["region"] == "cn-north-4"

    # 添加向导要靠这些元数据渲染「选类型 → 填字段」：必填、说明、控制台地址
    for item in schema.values():
        assert item["tagline_key"].endswith("Tagline"), item["kind"]
        assert item["help_url"].startswith("https://"), item["kind"]
        required = [field["key"] for field in item["fields"] if field.get("required")]
        assert len(required) >= 2, item["kind"]
        assert "renew_before_days" not in required


def test_unknown_provider_is_rejected() -> None:
    with pytest.raises(certproviders.ProviderError):
        certproviders.build_provider("cloudflare", {})


# ------------------------------------------------------------------ 腾讯云
def test_tencent_maps_integer_status() -> None:
    info = tencent_provider.TencentProvider._info(
        {
            "CertificateId": "abc",
            "Domain": "example.com",
            "Status": 1,
            "CertEndTime": "2027-01-01 00:00:00",
        }
    )
    assert info.cert_id == "abc"
    assert info.status == certproviders.STATUS_ISSUED
    assert info.expire_at > 0


# ------------------------------------------------------------------ 阿里云
def test_aliyun_maps_state_and_downloads_pem(monkeypatch) -> None:
    pem = "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----"
    key = "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----"
    provider = aliyun.AliyunProvider(
        {"access_key_id": "ak", "access_key_secret": "sk"}
    )

    async def fake_call(action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        assert action == "DescribeCertificateState"
        return {"Status": "certificate", "Domain": "example.com", "Certificate": pem, "PrivateKey": key}

    monkeypatch.setattr(provider, "_call", fake_call)

    info = _run(provider.describe("c-1"))
    assert info is not None
    assert info.status == certproviders.STATUS_ISSUED
    assert info.domains == ["example.com"]

    bundle = _run(provider.download("c-1"))
    assert "BEGIN CERTIFICATE" in bundle["fullchain"]
    assert "PRIVATE KEY" in bundle["private_key"]


def test_aliyun_rejects_wildcard() -> None:
    provider = aliyun.AliyunProvider({"access_key_id": "ak", "access_key_secret": "sk"})
    with pytest.raises(certproviders.ProviderError):
        _run(provider.apply(["*.example.com"]))


# ------------------------------------------------------------------ 华为云
def test_huawei_export_builds_bundle(monkeypatch) -> None:
    provider = huawei.HuaweiProvider(
        {"access_key_id": "ak", "access_key_secret": "sk", "region": "cn-north-4"}
    )

    async def fake_call(method: str, path: str, params=None, body=None):
        assert method == "POST" and path.endswith("/export")
        return {
            "certificate": "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
            "private_key": "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
        }

    monkeypatch.setattr(provider, "_call", fake_call)
    bundle = _run(provider.download("h-1"))
    assert bundle["chain_file"] == "huawei"
    assert "BEGIN CERTIFICATE" in bundle["fullchain"]


def test_huawei_status_mapping() -> None:
    info = huawei.HuaweiProvider._info(
        {"domain_name": ["a.example.com"], "status": "ISSUED", "expire_time": "2027-02-01 00:00:00"},
        "h-1",
    )
    assert info.status == certproviders.STATUS_ISSUED
    assert info.domains == ["a.example.com"]
    assert info.expire_at > 0


# ------------------------------------------------------------------ 配置收口
def test_provider_config_validation() -> None:
    """配置按 schema 收口：密文留空沿用旧值、选项越界拒绝、数字夹到区间内。"""
    current = {
        "access_key_id": "",
        "access_key_secret": "",
        "validate_type": "DNS_AUTO",
        "renew_before_days": 15,
    }
    cfg = certs._normalise_provider_cfg(
        "aliyun",
        {"access_key_id": "ak", "access_key_secret": "sk", "renew_before_days": 999},
        current,
    )
    assert cfg["access_key_id"] == "ak"
    assert cfg["renew_before_days"] == 60  # schema 上限

    with pytest.raises(certs.CertError):
        certs._normalise_provider_cfg("aliyun", {"validate_type": "NOPE"}, current)

    kept = certs._normalise_provider_cfg(
        "huawei", {"region": "cn-east-3"}, {"access_key_secret": "old", "region": "cn-north-4"}
    )
    assert kept["access_key_secret"] == "old"  # 留空 = 不改
    assert kept["region"] == "cn-east-3"


def test_site_accepts_registered_provider_and_rejects_others() -> None:
    base = {
        "name": "站点",
        "domain": "example.com",
        "deploy_method": "local",
        "deploy_dir": "/etc/nginx/ssl",
    }
    for kind in ("tencent", "aliyun", "huawei"):
        assert certs.normalise_site({**base, "ca": kind})["ca"] == kind
    with pytest.raises(certs.CertError):
        certs.normalise_site({**base, "ca": "cloudflare"})


# ------------------------------------------------------------------ ACME 也是「签发渠道」
def test_acme_schema_uses_conditional_dns_fields() -> None:
    """ACME 和厂商共用同一套字段 schema：DNS 凭据靠 show_if 跟着选择出现。"""
    fields = certs.acme_fields()
    keys = [field["key"] for field in fields]
    assert keys[:5] == ["email", "directory", "encrypt_algo", "dns_provider", "dns_wait"]

    dnspod = next(field for field in fields if field["key"] == "dnspod_secret_id")
    assert dnspod["show_if"] == {"key": "dns_provider", "in": ["dnspod"]}
    assert dnspod["required"] is True
    assert dnspod.get("secret") is not True  # ID 不是密文，密钥才是

    secret = next(field for field in fields if field["key"] == "dnspod_secret_key")
    assert secret["secret"] is True and secret["type"] == "password"

    # 目录与 DNS 服务商都要有词条 key，前端才能按语言渲染
    directories = next(field for field in fields if field["key"] == "directory")
    assert all(option["label_key"] for option in directories["options"])
    providers = next(field for field in fields if field["key"] == "dns_provider")
    assert {option["value"] for option in providers["options"]} >= {"dnspod", "cloudflare"}


def test_acme_channel_view_masks_secrets_and_reports_status() -> None:
    cfg = {
        "email": "ops@example.com",
        "directory": "https://acme-v02.api.letsencrypt.org/directory",
        "encrypt_algo": "ECC",
        "dns_provider": "dnspod",
        "dns_wait": 45,
        "dnspod": {"secret_id": "id123", "secret_key": "shhh"},
        "aliyun": {"access_key_id": "", "access_key_secret": ""},
        "huawei": {"access_key_id": "", "access_key_secret": ""},
        "cloudflare": {"api_token": ""},
    }
    view = certs.acme_channel_view(cfg)

    assert view["kind"] == "acme"
    assert view["configured"] is True
    assert view["test_disabled"] is True
    assert view["identity_key"] == "email"
    assert view["values"]["email"] == "ops@example.com"
    assert view["values"]["dnspod_secret_id"] == "id123"
    assert view["secret_set"]["dnspod_secret_key"] is True
    assert view["secret_set"]["cloudflare_api_token"] is False

    blank = certs.acme_channel_view({"email": "", "directory": "x"})
    assert blank["configured"] is False


def test_acme_payload_flattens_back_to_nested_config() -> None:
    """弹窗提交的是扁平字段，落库前要还原成 save_acme 认识的嵌套结构。"""
    payload = certs.acme_payload(
        {
            "email": "ops@example.com",
            "directory": "https://acme-v02.api.letsencrypt.org/directory",
            "encrypt_algo": "RSA",
            "dns_provider": "cloudflare",
            "dns_wait": 30,
            "cloudflare_api_token": "tok",
            "dnspod_secret_id": "leftover",
        }
    )
    assert payload["email"] == "ops@example.com"
    assert payload["cloudflare"] == {"api_token": "tok"}
    assert payload["dnspod"] == {"secret_id": "leftover"}


# ------------------------------------------------------------------ 清单 / 绑定
def _site(site_id: str, domain: str, **kw: Any) -> Dict[str, Any]:
    site = dict(certs.DEFAULT_SITE)
    site.update(
        {
            "id": site_id,
            "name": "站点 " + site_id,
            "domain": domain,
            "username": "admin",
            "ca": "tencent",
            "deploy_dir": "/tmp/certs",
        }
    )
    site.update(kw)
    return site


def test_inventory_groups_one_cert_across_sites(monkeypatch) -> None:
    now = int(time.time())
    sites = [
        _site("s1", "a.example.com", cert_id="c-1", expire_at=now + 30 * 86400, cert_status=1),
        _site("s2", "b.example.com", cert_id="c-1", expire_at=now + 20 * 86400, cert_status=1),
        _site("s3", "c.example.com", ca="aliyun", cert_id="c-2", expire_at=now + 5 * 86400),
    ]

    async def fake_load() -> List[Dict[str, Any]]:
        return sites

    monkeypatch.setattr(certs, "load_sites", fake_load)

    items = _run(certs.inventory(None))
    assert len(items) == 2
    first = next(item for item in items if item["cert_id"] == "c-1")
    assert first["site_count"] == 2
    assert {site["id"] for site in first["sites"]} == {"s1", "s2"}
    # 同一张证书被多个站点使用时取最早到期的那天
    assert first["expire_at"] == now + 20 * 86400
    assert items[0]["cert_id"] == "c-2"  # 快到期排前面


def test_bind_to_sites_skips_uncovered_domain(monkeypatch) -> None:
    sites = [
        _site("s1", "a.example.com"),
        _site("s2", "other.com"),
    ]
    logged: List[str] = []

    class _FakeProvider:
        configured = True

        async def describe(self, cert_id: str) -> certproviders.CertInfo:
            return certproviders.CertInfo(
                cert_id=cert_id,
                domains=["*.example.com"],
                status=certproviders.STATUS_ISSUED,
                expire_at=int(time.time()) + 60 * 86400,
            )

    async def fake_load() -> List[Dict[str, Any]]:
        return sites

    async def fake_cfg(kind: str, owner: str = "") -> Dict[str, Any]:
        return {}

    async def fake_log(site, action, result, detail) -> None:
        logged.append(f"{site['id']}:{action}:{result}")

    async def fake_update(site) -> None:
        return None

    monkeypatch.setattr(certs, "load_sites", fake_load)
    monkeypatch.setattr(certs, "load_provider", fake_cfg)
    monkeypatch.setattr(certs, "build_provider", lambda kind, cfg: _FakeProvider())
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)

    result = _run(certs.bind_to_sites("tencent", "c-1", ["s1", "s2"], owner="admin"))

    assert result["bound"] == 1
    assert [site["id"] for site in result["sites"]] == ["s1"]
    assert result["skipped"][0]["id"] == "s2"
    assert logged == ["s1:bind:success"]
    assert sites[0]["cert_id"] == "c-1"
    assert sites[0]["ca"] == "tencent"
