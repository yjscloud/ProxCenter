"""证书续期流水线。

覆盖两层，都不碰腾讯云、不碰数据库：

1. **引擎**：顺序执行、跳过、失败短路（后面不再跑）、异常原样交还调用方。
2. **续期决策**：待签发 / 已签发 / 申请失败 / 未到期 / 未开自动续期 / 无证书，
   六种输入分别该跑哪几步、该不该产生副作用（部署、申请、写库）。

``sync_site_cert`` / ``apply_certificate`` / ``deploy_site`` / ``record_log`` /
``update_site`` 全部换成假实现，所以用例只验证「编排」而非「对接」。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import acme, certnotify, certs  # noqa: E402
from app.certpipeline import (  # noqa: E402
    STEP_FAILED,
    STEP_OK,
    STEP_SKIPPED,
    Context,
    Pipeline,
    Step,
)
from app.tencent_ssl import STATUS_FAILED, STATUS_ISSUED, STATUS_PENDING  # noqa: E402
from app.tencent_ssl import TencentCloudError  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ 引擎行为
def test_pipeline_runs_in_order_and_stops_on_error() -> None:
    seen: List[str] = []

    async def first(ctx: Context) -> None:
        seen.append("first")

    async def boom(ctx: Context) -> None:
        seen.append("boom")
        raise RuntimeError("炸了")

    async def never(ctx: Context) -> None:
        seen.append("never")

    pipe = Pipeline(
        "demo",
        [Step("first", first), Step("boom", boom), Step("never", never)],
    )
    run = _run(pipe.run(Context(site={})))

    assert seen == ["first", "boom"]  # 短路：失败之后的步骤不再执行
    assert [s.status for s in run.steps] == [STEP_OK, STEP_FAILED]
    assert run.status == STEP_FAILED and run.failed
    assert isinstance(run.exc, RuntimeError)  # 原始异常留给调用方分流
    assert run.error.startswith("boom:")


def test_pipeline_skips_without_cost() -> None:
    async def ok(ctx: Context) -> str:
        return "done"

    pipe = Pipeline(
        "demo",
        [
            Step("always", ok, detail=lambda ctx, value: value),
            Step("never", ok, when=lambda ctx: False),
        ],
    )
    run = _run(pipe.run(Context(site={})))

    assert [s.status for s in run.steps] == [STEP_OK, STEP_SKIPPED]
    assert run.steps[1].ms == 0
    assert run.steps[0].detail == "done"
    assert run.status == STEP_OK


def test_pipeline_marks_run_without_actions() -> None:
    async def ok(ctx: Context) -> None:
        return None

    run = _run(Pipeline("demo", [Step("only", ok, when=lambda ctx: False)]).run(Context(site={})))
    assert run.ran is False  # 全跳过 = 这次什么也没做
    assert run.status == STEP_OK


# ------------------------------------------------------------- 续期分支编排
class _FakeProvider:
    """厂商客户端的替身：只记录清理动作，其余方法由各用例单独打桩。"""

    configured = True

    def __init__(self) -> None:
        self.deleted: List[str] = []

    async def remove(self, cert_id: str) -> None:
        self.deleted.append(cert_id)


class _UnconfiguredProvider:
    configured = False


def _site(**kw: Any) -> Dict[str, Any]:
    site = dict(certs.DEFAULT_SITE)
    site.update(
        {
            "id": "site-1",
            "name": "测试站点",
            "domain": "a.example.com",
            "username": "admin",
            "deploy_dir": "/tmp/certs",
        }
    )
    site.update(kw)
    return site


def _patch_io(monkeypatch, calls: List[str]) -> None:
    """把流水线里所有会碰外部/库的动作替换成打点。"""

    async def fake_sync(site: Dict[str, Any], provider: Any = None) -> None:
        calls.append("sync")

    async def fake_update(site: Dict[str, Any]) -> None:
        calls.append("update")

    async def fake_log(site: Dict[str, Any], action: str, result: str, detail: str) -> None:
        calls.append(f"log:{action}:{result}")

    async def fake_apply(site: Dict[str, Any], cfg: Any, *, renew: bool = False) -> Dict[str, Any]:
        calls.append(f"apply:renew={renew}")
        return {"cert_id": "new"}

    async def fake_deploy(site: Dict[str, Any], cfg: Any, action: str = "deploy") -> Dict[str, Any]:
        calls.append(f"deploy:{action}")
        return {"ok": True, "detail": "已部署"}

    async def fake_cfg_for(site: Dict[str, Any]) -> Dict[str, Any]:
        calls.append("cfg")
        return {"renew_before_days": 15}

    async def fake_notify(owner, site, event, title, detail="", **kw):
        calls.append(f"notify:{event}")
        return True

    monkeypatch.setattr(certs, "sync_site_cert", fake_sync)
    monkeypatch.setattr(certs, "update_site", fake_update)
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "apply_certificate", fake_apply)
    monkeypatch.setattr(certs, "deploy_site", fake_deploy)
    client = _FakeProvider()
    monkeypatch.setattr(certs, "provider_cfg_for", fake_cfg_for)
    monkeypatch.setattr(certs, "build_provider", lambda kind, cfg: client)
    monkeypatch.setattr(certnotify, "notify", fake_notify)
    return client


def _renew(site: Dict[str, Any]):
    return _run(certs.renew_site(site))


def test_renew_without_cert_touches_nothing(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site()  # 既没有 cert_id 也没有 pending

    run = _renew(site)

    assert calls == []  # 不查腾讯云，也不写库（保持旧行为）
    assert run.ran is False
    assert all(step["status"] == STEP_SKIPPED for step in site["last_run"])


def test_renew_waiting_for_issue_only_syncs(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(pending_cert_id="c-pending", cert_status=STATUS_PENDING[0])

    run = _renew(site)

    assert calls == ["cfg", "sync", "update"]
    assert run.value is None  # 签发中：只落库，不返回动作
    steps = {s["step"]: s["status"] for s in site["last_run"]}
    assert steps["decide"] == STEP_OK
    assert steps["issue"] == STEP_SKIPPED


def test_renew_issued_cert_deploys(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(pending_cert_id="c-ready", cert_status=STATUS_ISSUED)

    run = _renew(site)

    assert "deploy:renew" in calls
    assert "log:renew:success" in calls
    assert run.value == {"site": "测试站点", "action": "deploy", "detail": "已部署"}


def test_renew_failed_request_drops_pending(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(pending_cert_id="c-bad", cert_status=STATUS_FAILED[0])

    run = _renew(site)

    assert site["pending_cert_id"] == ""  # 不再反复查一张失败的证书
    assert "申请失败" in site["last_error"]
    assert "log:renew:failed" in calls
    assert run.value["action"] == "renew"


def test_renew_due_submits_request(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(cert_id="c-old", expire_at=int(time.time()) + 3 * 86400, auto_renew=True)

    run = _renew(site)

    assert "apply:renew=True" in calls
    assert run.value["action"] == "renew"
    assert "已提交续期申请" in run.value["detail"]


def test_renew_due_without_auto_renew_only_notices(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(cert_id="c-old", expire_at=int(time.time()) + 3 * 86400, auto_renew=False)

    run = _renew(site)

    assert not any(c.startswith("apply") for c in calls)
    assert "未开启自动续期" in site["last_error"]
    assert run.value["action"] == "notice"


def test_renew_not_due_does_not_issue(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(cert_id="c-old", expire_at=int(time.time()) + 60 * 86400)

    run = _renew(site)

    assert calls == ["cfg", "sync", "update"]
    assert run.value is None


def test_renew_without_credentials_skips_remote_calls(monkeypatch) -> None:
    """站点归属者没配腾讯云密钥：只落一条「未配置」，不去打接口。

    回归点：旧实现整轮共用一个 ``load_tencent()`` 客户端，管理员与普通用户
    都取不到自己那份密钥，导致定时续期对所有人都不生效。
    """
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    monkeypatch.setattr(certs, "build_provider", lambda kind, cfg: _UnconfiguredProvider())
    site = _site(cert_id="c-old")

    run = _renew(site)

    assert calls == ["cfg", "update"]
    assert run.ran is True  # prepare 跑过了，只是后面都跳过
    steps = {s["step"]: s["status"] for s in site["last_run"]}
    assert steps["prepare"] == STEP_OK
    assert steps["sync"] == STEP_SKIPPED
    assert steps["issue"] == STEP_SKIPPED


def test_renew_tick_records_tencent_error_and_continues(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(cert_id="c-old")

    async def boom_sync(site: Dict[str, Any], provider: Any = None) -> None:
        raise TencentCloudError("接口超时")

    async def fake_load_sites() -> List[Dict[str, Any]]:
        return [site]

    monkeypatch.setattr(certs, "sync_site_cert", boom_sync)
    monkeypatch.setattr(certs, "load_sites", fake_load_sites)

    results = _run(certs.renew_tick())

    assert results == []  # 一个站点失败不影响整轮
    assert site["last_error"] == "接口超时"
    assert site["last_run_status"] == STEP_FAILED
    assert "log:sync:failed" in calls


def test_guard_holds_during_backoff(monkeypatch) -> None:
    """退避窗口内连配置都不取，避免 5 分钟一轮的重试作业打爆 CA 接口。"""
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(
        cert_id="c-old",
        expire_at=int(time.time()) + 3 * 86400,
        next_attempt_at=int(time.time()) + 600,
    )

    run = _renew(site)

    assert calls == []
    assert run.ran is True  # guard 跑过，只是把后面全拦住了
    steps = {s["step"]: s["status"] for s in site["last_run"]}
    assert steps["guard"] == STEP_OK
    assert steps["prepare"] == STEP_SKIPPED


def test_failed_renewal_schedules_backoff(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)
    site = _site(pending_cert_id="c-bad", cert_status=STATUS_FAILED[0])
    before = time.time()

    _renew(site)

    assert site["attempt_count"] == 1
    assert before + 590 <= site["next_attempt_at"] <= before + 610  # 第一档 10 分钟
    assert "notify:renew_failed" in calls


def test_deploy_deletes_old_cert_after_success(monkeypatch) -> None:
    calls: List[str] = []
    client = _patch_io(monkeypatch, calls)
    site = _site(
        cert_id="c-old",
        pending_cert_id="c-new",
        cert_status=STATUS_ISSUED,
        auto_delete_old=True,
    )

    _renew(site)

    assert client.deleted == ["c-old"]
    assert site["attempt_count"] == 0
    assert site["next_attempt_at"] == 0
    assert "log:cleanup:success" in calls
    assert "notify:renewed" in calls


def test_deploy_failure_alerts(monkeypatch) -> None:
    calls: List[str] = []
    _patch_io(monkeypatch, calls)

    async def bad_deploy(site: Dict[str, Any], cfg: Any, action: str = "deploy"):
        calls.append("deploy")
        return {"ok": False, "detail": "nginx: [emerg] bad config"}

    monkeypatch.setattr(certs, "deploy_site", bad_deploy)
    site = _site(pending_cert_id="c-new", cert_status=STATUS_ISSUED)

    _renew(site)

    assert "notify:deploy_failed" in calls


def test_preflight_rejects_bad_reload_command(monkeypatch) -> None:
    """命令里有 shell 分隔符时，写盘前就应拒绝，而不是写完再让 reload 失败。"""
    site = _site(deploy_dir="/tmp/pvecenter-preflight", reload_command="nginx -s reload; rm -rf /")

    with pytest.raises(certs.CertError):
        _run(
            certs._push_local(
                site, {"fullchain": "cert", "private_key": "key", "chain_file": "src"}
            )
        )


# ------------------------------------------------------------------ 补跑作业
def test_retry_tick_only_picks_due_sites(monkeypatch) -> None:
    """只挑「退避到点」的启用站点，且每轮最多 3 个。"""
    now = int(time.time())
    sites = [
        _site(id="due-1", next_attempt_at=now - 60),
        _site(id="never", next_attempt_at=0),  # 从没失败过：不补跑
        _site(id="later", next_attempt_at=now + 600),  # 窗口内：等主作业
        _site(id="disabled", next_attempt_at=now - 60, enabled=False),
        _site(id="due-2", next_attempt_at=now - 60),
        _site(id="due-3", next_attempt_at=now - 60),
        _site(id="due-4", next_attempt_at=now - 60),  # 超出本轮配额
    ]
    picked: List[str] = []

    async def fake_load() -> List[Dict[str, Any]]:
        return sites

    async def fake_run(batch: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        picked.extend(str(s["id"]) for s in batch)
        return [{"site": s["id"]} for s in batch]

    monkeypatch.setattr(certs, "load_sites", fake_load)
    monkeypatch.setattr(certs, "_run_sites", fake_run)

    result = _run(certs.retry_tick())

    assert picked == ["due-1", "due-2", "due-3"]
    assert len(result) == 3


def test_retry_tick_yields_to_running_pipeline(monkeypatch) -> None:
    """主作业在跑时补跑直接让路，避免两份站点快照互相覆盖。"""

    class _Busy:
        def locked(self) -> bool:
            return True

    async def fake_run(batch: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        raise AssertionError("持锁期间不该执行流水线")

    monkeypatch.setattr(certs, "_TICK_LOCK", _Busy())
    monkeypatch.setattr(certs, "_run_sites", fake_run)

    assert _run(certs.retry_tick()) == []


# ------------------------------------------------------------------ ACME 渠道
class _FakeAcmeClient:
    """只实现 issue 的假客户端：验证「签发结果如何落到站点上」。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.account_key = type("K", (), {"pem": "ACCOUNT-KEY-PEM"})()

    async def __aenter__(self) -> "_FakeAcmeClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def issue(self, domains, solver, key_type=None):
        assert solver.kind in ("dns-01", "http-01")
        return acme.IssuedCert(
            fullchain="-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
            private_key="-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
            expire_at=1_999_999_999,
            domains=list(domains),
        )


def _patch_acme(monkeypatch, calls: List[str]) -> None:
    async def fake_load_acme(owner: str = "") -> Dict[str, Any]:
        return {
            "email": "ops@example.com",
            "directory": acme.DIRECTORY_STAGING,
            "encrypt_algo": "RSA",
            "account_key": "",
            "dns_provider": "cloudflare",
            "dns_wait": 0,
            "cloudflare": {"api_token": "token"},
        }

    async def fake_save_acme(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
        calls.append("save_acme")
        return raw

    async def fake_update(site: Dict[str, Any]) -> None:
        calls.append("update")

    async def fake_log(site: Dict[str, Any], action: str, result: str, detail: str) -> None:
        calls.append(f"log:{action}:{result}")

    monkeypatch.setattr(certs, "load_acme", fake_load_acme)
    monkeypatch.setattr(certs, "save_acme", fake_save_acme)
    monkeypatch.setattr(certs, "update_site", fake_update)
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs.acme_mod, "AcmeClient", _FakeAcmeClient)


def test_acme_issue_stores_cert_and_waits_for_deploy(monkeypatch) -> None:
    """ACME 同步签发：证书落库、留 pending_cert_id 给部署步骤。"""
    calls: List[str] = []
    _patch_acme(monkeypatch, calls)
    site = _site(ca="acme", domain="*.example.com", acme_challenge="dns")

    result = _run(certs.apply_certificate(site))

    assert result["cert_id"].startswith("acme-")
    assert site["pending_cert_id"] == result["cert_id"]
    assert site["cert_status"] == STATUS_ISSUED
    assert site["expire_at"] == 1_999_999_999
    assert "BEGIN CERTIFICATE" in site["acme_pem"]
    assert "PRIVATE KEY" in site["acme_key"]
    assert "save_acme" in calls  # 首次签发把账号密钥存下来
    assert "log:apply:pending" in calls


def test_acme_issue_does_not_touch_tencent(monkeypatch) -> None:
    calls: List[str] = []
    _patch_acme(monkeypatch, calls)
    site = _site(ca="acme", domain="example.com")

    async def boom_cfg(site: Dict[str, Any]) -> Any:
        raise AssertionError("ACME 渠道不该读取云厂商配置")

    def boom(kind: str, cfg: Any) -> Any:
        raise AssertionError("ACME 渠道不该创建云厂商客户端")

    monkeypatch.setattr(certs, "provider_cfg_for", boom_cfg)
    monkeypatch.setattr(certs, "build_provider", boom)

    _run(certs.apply_certificate(site))


def test_deploy_acme_site_uses_cached_cert(monkeypatch) -> None:
    """部署 ACME 站点直接用站点上的证书，不去 CA 下载。"""
    calls: List[str] = []

    async def fake_push(site: Dict[str, Any], bundle: Dict[str, Any]):
        calls.append(bundle["chain_file"])
        return "已写入", ""

    async def fake_log(site: Dict[str, Any], action: str, result: str, detail: str) -> None:
        calls.append(f"log:{action}:{result}")

    async def fake_update(site: Dict[str, Any]) -> None:
        calls.append("update")

    async def boom_cfg(site: Dict[str, Any]) -> Any:
        raise AssertionError("ACME 证书不需要读取厂商配置")

    def boom(kind: str, cfg: Any) -> Any:
        raise AssertionError("ACME 证书不需要下载")

    monkeypatch.setattr(certs, "_push_local", fake_push)
    monkeypatch.setattr(certs, "record_log", fake_log)
    monkeypatch.setattr(certs, "update_site", fake_update)
    monkeypatch.setattr(certs, "provider_cfg_for", boom_cfg)
    monkeypatch.setattr(certs, "build_provider", boom)

    site = _site(
        ca="acme",
        pending_cert_id="acme-1",
        acme_pem="-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----",
        acme_key="-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
    )
    outcome = _run(certs.deploy_site(site))

    assert outcome["ok"] is True
    assert calls[0] == "ACME"
    assert site["cert_id"] == "acme-1"
    assert site["pending_cert_id"] == ""
    assert "log:deploy:success" in calls


def test_run_keeps_step_timing_for_log_view() -> None:
    """每一步都留相对耗时（at），页面才能把逐步结果排成一份带时间轴的日志。"""

    async def ok(ctx: Context) -> str:
        return "done"

    async def boom(ctx: Context) -> None:
        raise RuntimeError("x" * 700)

    pipe = Pipeline(
        "t",
        [
            Step("a", ok, detail=lambda ctx, value: value),
            Step("b", ok, when=lambda ctx: False),
        ],
    )
    steps = _run(pipe.run(Context(site={}))).as_list()

    assert [s["step"] for s in steps] == ["a", "b"]
    assert steps[0]["status"] == STEP_OK
    assert steps[1]["status"] == STEP_SKIPPED
    for step in steps:
        assert isinstance(step.get("at"), int)
    assert steps[1]["at"] >= steps[0]["at"]  # 偏移单调，日志不会倒着走

    # 失败步骤的说明按 DETAIL_LIMIT 截断：够看清原因，又不会把站点 JSON 撑大
    failed = _run(Pipeline("t", [Step("boom", boom)]).run(Context(site={}))).as_list()
    assert failed[0]["status"] == STEP_FAILED
    assert len(failed[0]["detail"]) == 600
