"""一证多目标、托管证书、站点监控与模板。

这些能力都在「不碰外部服务」的边界上：多目标只是把同一份 bundle 分发给几个
通道，托管证书是纯解析，监控探测用 mock 的 httpx 替身，模板只读写 settings。
"""
from __future__ import annotations

import asyncio
import datetime
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import certpipeline, certs  # noqa: E402
from app.pve import ProxmoxError  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _payload(**kw: Any) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "name": "站点",
        "domain": "example.com",
        "deploy_method": "local",
        "deploy_dir": "/etc/nginx/ssl",
    }
    data.update(kw)
    return data


# ------------------------------------------------------------------ 目标模型
def test_legacy_site_becomes_one_target() -> None:
    site = certs.normalise_site(_payload())
    targets = certs.site_targets(site)
    assert len(targets) == 1
    assert targets[0]["method"] == "local"
    assert targets[0]["deploy_dir"] == "/etc/nginx/ssl"


def test_multi_targets_are_kept_and_summarised_on_site() -> None:
    site = certs.normalise_site(
        _payload(
            targets=[
                {"id": "a", "name": "本机", "method": "local", "deploy_dir": "/etc/nginx/ssl"},
                {"id": "b", "name": "备份", "method": "local", "deploy_dir": "/opt/backup"},
            ]
        )
    )
    assert [t["id"] for t in site["targets"]] == ["a", "b"]
    # 站点级字段跟随第一个目标，列表页/旧接口继续可用
    assert site["deploy_dir"] == "/etc/nginx/ssl"


def test_target_view_merges_site_and_target() -> None:
    site = certs.normalise_site(
        _payload(
            targets=[
                {"id": "a", "method": "local", "deploy_dir": "/a"},
                {"id": "b", "method": "local", "deploy_dir": "/b", "cert_filename": "cert.pem"},
            ]
        )
    )
    view = certs._target_view(site, site["targets"][1])
    assert view["deploy_dir"] == "/b"
    assert view["cert_filename"] == "cert.pem"
    assert view["domain"] == "example.com"


def test_ssh_target_requires_credentials() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(
            _payload(targets=[{"method": "ssh", "deploy_dir": "/etc/ssl"}])
        )


def test_lxc_target_requires_node_ssh() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(
            _payload(
                targets=[
                    {"method": "lxc", "deploy_dir": "/etc/ssl", "agent_node": "pve", "agent_vmid": "101"}
                ]
            )
        )


def test_lxc_target_accepts_node_credentials() -> None:
    site = certs.normalise_site(
        _payload(
            targets=[
                {
                    "method": "lxc",
                    "deploy_dir": "/etc/ssl",
                    "agent_node": "pve",
                    "agent_vmid": "101",
                    "ssh_host": "10.0.0.1",
                    "ssh_user": "root",
                    "ssh_password": "secret",
                }
            ]
        )
    )
    assert site["targets"][0]["method"] == "lxc"


def test_pve_target_requires_node() -> None:
    with pytest.raises(certs.CertError):
        certs.normalise_site(_payload(targets=[{"method": "pve"}]))
    with pytest.raises(certs.CertError):
        certs.normalise_site(_payload(targets=[{"method": "pve", "agent_node": "bad/name"}]))


def test_pve_target_uses_fixed_dir_and_no_reload() -> None:
    """PVE 证书由 API 落盘，目录与重载命令都不该沿用其它通道的取值。"""
    site = certs.normalise_site(
        _payload(
            targets=[
                {
                    "method": "pve",
                    "agent_node": "pve1",
                    "agent_vmid": "101",
                    "deploy_dir": "/etc/nginx/ssl",
                    "reload_command": "nginx -s reload",
                }
            ]
        )
    )
    target = site["targets"][0]
    assert target["deploy_dir"] == certs.PVE_CERT_DIR
    assert target["reload_command"] == ""
    assert target["agent_vmid"] == ""


def test_pve_site_level_payload_is_accepted() -> None:
    """旧客户端只提交站点级 deploy_method 时也要能合成 pve 目标。"""
    site = certs.normalise_site(
        _payload(deploy_method="pve", agent_node="pve1", deploy_dir="")
    )
    target = site["targets"][0]
    assert target["method"] == "pve"
    assert target["deploy_dir"] == certs.PVE_CERT_DIR


def test_deploy_pve_uploads_through_api(monkeypatch) -> None:
    calls: List[Any] = []

    class _Conn:
        configured = True

    class _Client:
        conn = _Conn()

        async def upload_node_certificate(
            self, node, certificates, key, force=True, restart=True
        ) -> str:
            calls.append((node, certificates, key, force, restart))
            return "UPID:pve1:0000A1B9:00C3D4EC:65F00008:pvecert:100:root@pam:"

    async def fake_log(*args: Any, **kwargs: Any) -> None:
        return None

    async def fake_update(site) -> None:
        return None

    monkeypatch.setattr(certs, "get_client", lambda: _Client())
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)

    site = _deployable_site(targets=[{"id": "p", "method": "pve", "agent_node": "pve1"}])
    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is True
    assert calls and calls[0][0] == "pve1"
    # force/restart 是 certd 实现里最关键的两个参数：缺 force 会静默保留旧证书
    assert calls[0][3] is True and calls[0][4] is True
    assert site["deploy_method"] == "pve"
    assert site["deploy_dir"] == certs.PVE_CERT_DIR


def test_pve_deploy_maps_proxmox_error_to_target_failure(monkeypatch) -> None:
    """节点不存在 / 权限不足应记为该目标失败，而不是让请求 500。"""

    class _Conn:
        configured = True

    class _Client:
        conn = _Conn()

        async def upload_node_certificate(self, *args: Any, **kwargs: Any) -> str:
            raise ProxmoxError("node 'nope' does not exist", status_code=500)

    async def fake_log(*args: Any, **kwargs: Any) -> None:
        return None

    async def fake_update(site) -> None:
        return None

    monkeypatch.setattr(certs, "get_client", lambda: _Client())
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)

    site = _deployable_site(targets=[{"id": "p", "method": "pve", "agent_node": "nope"}])
    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is False
    assert outcome["targets"][0]["written"] is False
    assert "nope" in site["last_error"]


def test_target_secrets_are_encrypted_on_write() -> None:
    site = certs.normalise_site(
        _payload(
            targets=[
                {
                    "id": "a",
                    "method": "ssh",
                    "deploy_dir": "/etc/ssl",
                    "ssh_host": "10.0.0.2",
                    "ssh_user": "root",
                    "ssh_password": "p@ss",
                }
            ]
        )
    )
    stored: List[Dict[str, Any]] = []

    async def fake_set(key: str, value: str) -> None:
        stored.append(json.loads(value)[0])

    monkeypatch = None  # 显式说明：这里不依赖 fixture
    original = certs.store.set_setting
    certs.store.set_setting = fake_set  # type: ignore[assignment]
    try:
        _run(certs.save_sites([site]))
    finally:
        certs.store.set_setting = original  # type: ignore[assignment]

    sealed = stored[0]["targets"][0]
    assert sealed["ssh_password"] and sealed["ssh_password"] != "p@ss"
    assert certs.crypto.is_encrypted(sealed["ssh_password"])


# ------------------------------------------------------------------ 多目标部署
def _patch_deploy(monkeypatch, results: Dict[str, Any], calls: List[str]):
    async def fake_push(view: Dict[str, Any], bundle: Dict[str, Any]) -> Any:
        target = str(view.get("deploy_dir"))
        calls.append(target)
        outcome = results.get(target)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome or ("已写入", "")

    async def fake_log(site, action, result, detail) -> None:
        calls.append(f"log:{result}")

    async def fake_update(site) -> None:
        calls.append("update")

    monkeypatch.setattr(certs, "_push_target", fake_push)
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)


def _deployable_site(**kw: Any) -> Dict[str, Any]:
    kw.setdefault(
        "targets",
        [
            {"id": "a", "name": "A", "method": "local", "deploy_dir": "/a"},
            {"id": "b", "name": "B", "method": "local", "deploy_dir": "/b"},
        ],
    )
    site = certs.normalise_site(_payload(ca="upload", **kw))
    site.update(
        {
            "cert_id": "upload-1",
            "acme_pem": "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
            "acme_key": "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
        }
    )
    return site


def test_deploy_writes_every_target(monkeypatch) -> None:
    calls: List[str] = []
    _patch_deploy(monkeypatch, {}, calls)
    site = _deployable_site()

    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is True
    assert calls[:2] == ["/a", "/b"]
    assert site["pending_cert_id"] == ""
    assert site["cert_id"] == "upload-1"


def test_one_target_failing_keeps_pending(monkeypatch) -> None:
    calls: List[str] = []
    _patch_deploy(monkeypatch, {"/b": certs.CertError("写入失败")}, calls)
    site = _deployable_site()
    site["pending_cert_id"] = "upload-1"  # 续期场景：待部署的证书 ID

    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is False
    assert "/a" in calls and "/b" in calls  # 一个失败不影响另一个
    assert site["pending_cert_id"] == "upload-1"  # 保留待重试
    assert "B" in site["last_error"] or "写入失败" in site["last_error"]
    statuses = {item["id"]: item["ok"] for item in outcome["targets"]}
    assert statuses == {"a": True, "b": False}


def test_reload_failure_marks_written_not_rolled_back(monkeypatch) -> None:
    calls: List[str] = []
    _patch_deploy(
        monkeypatch,
        {"/a": certs.ReloadError("nginx: bad config")},
        calls,
    )
    site = _deployable_site(targets=[{"id": "a", "method": "local", "deploy_dir": "/a"}])

    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is False
    assert outcome["targets"][0]["written"] is True


# ------------------------------------------------------------------ 托管证书
def _make_pair(domains: List[str], days: int = 90) -> tuple:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.datetime.now(datetime.timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domains[0])]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domains[0])]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=days))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(d) for d in domains]), critical=False
        )
    )
    cert = builder.sign(key, hashes.SHA256())
    return (
        cert.public_bytes(serialization.Encoding.PEM).decode("ascii"),
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ).decode("ascii"),
    )


def test_import_certificate_accepts_matching_pair() -> None:
    pem, key = _make_pair(["example.com", "www.example.com"])
    meta = certs.parse_uploaded_certificate(pem, key)
    assert meta["domains"] == ["example.com", "www.example.com"]
    assert meta["expire_at"] > 0


def test_import_certificate_rejects_mismatched_key() -> None:
    pem, _ = _make_pair(["example.com"])
    _, other_key = _make_pair(["example.com"])
    with pytest.raises(certs.CertError):
        certs.parse_uploaded_certificate(pem, other_key)


def test_import_certificate_rejects_bad_pem() -> None:
    with pytest.raises(certs.CertError):
        certs.parse_uploaded_certificate("not a cert", "not a key")


def test_wildcard_certificate_covers_one_level() -> None:
    assert certs._cert_covers(["*.example.com"], "a.example.com")
    assert not certs._cert_covers(["*.example.com"], "a.b.example.com")
    assert certs._cert_covers(["example.com"], "example.com")


def test_import_certificate_rejects_missing_domain(monkeypatch) -> None:
    pem, key = _make_pair(["other.com"])
    site = certs.normalise_site(_payload(domain="example.com", ca="upload"))

    async def fake_log(*args, **kwargs) -> None:
        return None

    async def fake_update(site) -> None:
        return None

    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)

    with pytest.raises(certs.CertError):
        _run(certs.import_certificate(site, pem, key))


def test_import_certificate_stores_and_marks_issued(monkeypatch) -> None:
    pem, key = _make_pair(["example.com"])
    site = certs.normalise_site(_payload(domain="example.com", ca="upload"))
    calls: List[str] = []

    async def fake_log(site, action, result, detail) -> None:
        calls.append(f"{action}:{result}")

    async def fake_update(site) -> None:
        calls.append("update")

    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)

    result = _run(certs.import_certificate(site, pem, key))

    assert result["cert_id"].startswith("upload-")
    assert site["ca"] == "upload"
    assert site["expire_at"] > 0
    assert "import:success" in calls


def test_upload_site_cannot_apply_for_certificate() -> None:
    """托管证书不走 CA：点「申请 / 续期」要明确拒绝，而不是误走腾讯云。"""
    site = certs.normalise_site(_payload(ca="upload"))
    with pytest.raises(certs.CertError):
        _run(certs.apply_certificate(site))


def test_upload_site_only_gets_notice_when_near_expiry() -> None:
    """托管证书无法自动续期：到期分支只能是提醒，不能是 due。"""
    site = certs.normalise_site(_payload(ca="upload"))
    site.update({"cert_id": "upload-1", "expire_at": int(time.time()) + 3 * 86400})
    ctx = certpipeline.Context(site=site)
    ctx.set("cfg", {})
    assert certs._decide(ctx) == "notice"


# ------------------------------------------------------------------ 模板
def test_template_roundtrip(monkeypatch) -> None:
    store: Dict[str, str] = {}

    async def fake_get(key: str, default: str = "") -> str:
        return store.get(key, default)

    async def fake_set(key: str, value: str) -> None:
        store[key] = value

    monkeypatch.setattr(certs.store, "get_setting", fake_get)
    monkeypatch.setattr(certs.store, "set_setting", fake_set)

    site = certs.normalise_site(_payload())
    template = _run(certs.save_template({"name": "Nginx 站点"}, "alice", site))
    assert template["name"] == "Nginx 站点"
    assert template["deploy_dir"] == "/etc/nginx/ssl"
    assert "ssh_password" not in template

    loaded = _run(certs.load_templates("alice"))
    assert len(loaded) == 1
    assert loaded[0]["id"] == template["id"]

    assert _run(certs.delete_template(template["id"], "alice")) is True
    assert _run(certs.load_templates("alice")) == []


# ------------------------------------------------------------------ 监控
def test_probe_reports_up(monkeypatch) -> None:
    from app import certmonitor

    class _Response:
        status_code = 200

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def get(self, url: str) -> _Response:
            return _Response()

    monkeypatch.setattr(certmonitor.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(certmonitor, "_cert_days_left", lambda host, port=443: 42)

    result = _run(certmonitor.probe("https://example.com"))

    assert result["status"] == "up"
    assert result["code"] == 200
    assert result["cert_days"] == 42


def test_probe_reports_down_on_exception(monkeypatch) -> None:
    from app import certmonitor

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_Client":
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def get(self, url: str) -> Any:
            raise RuntimeError("connection refused")

    monkeypatch.setattr(certmonitor.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(certmonitor, "_cert_days_left", lambda host, port=443: None)

    result = _run(certmonitor.probe("example.com"))

    assert result["status"] == "down"
    assert "connection refused" in result["error"]


def test_monitor_tick_only_checks_enabled_sites(monkeypatch) -> None:
    from app import certmonitor

    checked: List[str] = []

    async def fake_load() -> List[Dict[str, Any]]:
        return [
            dict(certs.DEFAULT_SITE, id="1", name="on", enabled=True, monitor_enabled=True, monitor_url="https://a.example.com"),
            dict(certs.DEFAULT_SITE, id="2", name="off", enabled=True, monitor_enabled=False, monitor_url="https://b.example.com"),
            dict(certs.DEFAULT_SITE, id="3", name="paused", enabled=False, monitor_enabled=True, monitor_url="https://c.example.com"),
        ]

    async def fake_check(site: Dict[str, Any]) -> Dict[str, Any]:
        checked.append(str(site.get("name")))
        return {"site": site.get("name"), "status": "up"}

    async def fake_update(site) -> None:
        return None

    monkeypatch.setattr(certs, "load_sites", fake_load)
    monkeypatch.setattr(certs, "update_site", fake_update)
    monkeypatch.setattr(certmonitor, "check_site", fake_check)

    result = _run(certmonitor.monitor_tick())

    assert checked == ["on"]
    assert result[0]["status"] == "up"
