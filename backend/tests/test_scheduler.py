"""后台作业调度器与用户界面偏好：注册、配置热改、执行记账、接口回归。

被测的关键控制：

* 间隔被夹在合法区间内，且「与代码默认值不同」才落库 —— 否则把默认值调大
  之后，从没手动改过的部署会被一条陈旧记录钉死在旧值上；
* 单个作业抛异常必须只影响它自己，并把错误记进该作业的状态（而不是吞进日志）；
* 上一次没跑完就到点时跳过而不是堆叠；
* 偏好按用户隔离，结构非法的布局被挡住，未知键 404。

异步部分用 ``asyncio.run`` 直接驱动调度器模块；接口层用 ``api`` fixture。
用 ``api`` 还有一个附带好处：它的 lifespan 会调 ``scheduler.load_state()``，
而 conftest 每个用例都清库 —— 于是每个用例都从「全部默认值」开始，
用例之间不会因为改过间隔而互相污染。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, prefs, scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

VIEWER_PASSWORD = "Unit-Test-Pa55word"


async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池。

    aiomysql 的池绑在创建它的事件循环上：每个用例 ``asyncio.run`` 都会新建一个
    循环，不显式关掉的话，上一个池里的连接会在新循环上被 GC，刷出一大片
    「Event loop is closed」的 unraisable 警告（与 test_metrics / test_apitokens
    同一套路）。
    """
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    """只建表、**不启动 app**，供模块级用例使用。

    为什么模块级用例不能借用 ``api`` fixture：TestClient 跑在自己的事件循环里，
    而配套的全局连接池就绑在那个循环上。模块级用例再用 ``asyncio.run`` 新建一个
    循环去碰同一个池，两个循环会互相踩（表现为满屏「Event loop is closed」，
    以及偶发的「attached to a different loop」）。这里干脆不启动 app，
    表用 ``store.init_db`` 建，池由每个 ``_run`` 自己开自己关，互不干扰。
    """
    # 导入 app.main 会触发作业注册（注册写在模块级），但不会启动任何后台任务
    import app.main  # noqa: F401
    from app import store

    _run(store.init_db())
    # 恢复默认间隔并算好「下次唤醒时刻」。少了这一步 next_mono 全是 0，
    # _dispatch 会把所有作业都当成已到点，一次性全派发出去。
    _run(scheduler.load_state())
    yield


def _viewer_headers(api, username: str = "schedviewer") -> Dict[str, str]:
    admin = auth_headers(api)
    api.post(
        "/api/users",
        json={"username": username, "password": VIEWER_PASSWORD, "role": "viewer"},
        headers=admin,
    )
    resp = api.post(
        "/api/auth/login", json={"username": username, "password": VIEWER_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _register_probe(job_id: str, *, fail: bool = False, delay: float = 0.0) -> Dict[str, Any]:
    """注册一个探针作业，返回一个可以读调用次数的字典。

    用它而不是拿真作业做实验：真作业会去 SSH 各主机、调 PVE，测试里既慢又脆。
    """
    log: Dict[str, Any] = {"calls": 0}

    async def run() -> Any:
        log["calls"] += 1
        if delay:
            await asyncio.sleep(delay)
        if fail:
            raise RuntimeError("探针故障")
        return ["a", "b"]

    scheduler.register(
        scheduler.Job(
            id=job_id,
            name=f"探针 {job_id}",
            group="测试",
            description="仅测试用",
            run=run,
            default_interval=60,
        )
    )
    return log


# ============================================================== 注册表
class TestRegistry:
    def test_production_jobs_are_registered(self, db) -> None:
        ids = {job["id"] for job in scheduler.snapshot()}
        # 改造前那四个循环覆盖的作业一个都不能少
        for expected in (
            "alerts",
            "ssh_guard",
            "ssh_fleet",
            "ports",
            "backup_guard",
            "host_audit",
            "metrics_sample",
            "certs",
            "metrics_purge",
            "notifications_purge",
        ):
            assert expected in ids, f"缺少作业 {expected}"

    def test_duplicate_id_is_rejected(self, db) -> None:
        _register_probe("dup_probe")
        with pytest.raises(ValueError):
            _register_probe("dup_probe")

    def test_snapshot_shape(self, db) -> None:
        job = next(job for job in scheduler.snapshot() if job["id"] == "alerts")
        assert job["interval"] == job["default_interval"] == 60
        assert job["enabled"] is True
        assert job["modified"] is False
        assert job["last_status"] == "never"
        assert job["min_interval"] == scheduler.MIN_INTERVAL
        assert job["next_in"] >= 0
        assert job["next_at"] > 0

    def test_effective_interval_falls_back_when_unknown(self, db) -> None:
        # 未注册的 id：用调用方给的兜底值，而不是抛异常或返回 0
        assert scheduler.effective_interval("no_such_job", 42) == 42

    def test_metrics_align_uses_scheduler_interval(self, db) -> None:
        """采样间隔改了之后，时间戳对齐粒度必须跟着变。

        否则同一周期内的重复采样不再命中同一行，历史里会插出重复点。
        """
        from app import metrics

        _run(scheduler.configure("metrics_sample", interval=300))
        try:
            # 300 秒对齐：299 落在 0，300 落在 300
            assert metrics.align_ts(299) == 0
            assert metrics.align_ts(300) == 300
            assert metrics.align_ts(599) == 300
        finally:
            _run(scheduler.reset("metrics_sample"))


# ============================================================== 配置热改
class TestConfigure:
    def test_configure_clamps_and_persists(self, db) -> None:
        updated = _run(scheduler.configure("alerts", interval=1))
        # 下限夹取：不允许把巡检调成每秒一次
        assert updated["interval"] == scheduler.MIN_INTERVAL
        assert updated["modified"] is True

        # 落库了：直接读 settings 表验证
        raw = _run(_read_state())
        assert "alerts" in raw
        assert raw["alerts"]["interval"] == scheduler.MIN_INTERVAL

    def test_configure_above_max_is_clamped(self, db) -> None:
        updated = _run(scheduler.configure("certs", interval=99_999_999))
        assert updated["interval"] == scheduler.MAX_INTERVAL

    def test_disable_is_persisted_and_reset_restores(self, db) -> None:
        disabled = _run(scheduler.configure("ssh_guard", enabled=False))
        assert disabled["enabled"] is False
        assert disabled["modified"] is True

        restored = _run(scheduler.reset("ssh_guard"))
        assert restored["enabled"] is True
        assert restored["interval"] == 60
        assert restored["modified"] is False

    def test_defaults_are_not_persisted(self, db) -> None:
        """只存与默认值的差异：没改过的作业不该出现在配置记录里。"""
        _run(scheduler.configure("alerts", interval=120))
        _run(scheduler.reset("alerts"))
        assert _run(_read_state()) == {}

    def test_load_state_restores_saved_values(self, db) -> None:
        _run(scheduler.configure("host_audit", interval=900))
        # 模拟重启：清掉内存态再重新加载
        _run(scheduler.reset("host_audit"))
        assert _run(scheduler.configure("host_audit", interval=900))["interval"] == 900

        # 直接改内存值，再 load_state 应当把它拉回落库的值
        state = scheduler._RUNTIME["host_audit"]
        state.interval = 60
        _run(scheduler.load_state())
        assert state.interval == 900

    def test_load_state_tolerates_broken_config(self, db) -> None:
        async def save_garbage() -> None:
            from app import store

            await store.set_setting(scheduler.STATE_KEY, "{ this is not json")

        _run(save_garbage())
        _run(scheduler.load_state())
        job = next(job for job in scheduler.snapshot() if job["id"] == "alerts")
        # 读不出来就回落默认值，而不是让启动失败
        assert job["interval"] == job["default_interval"]
        assert job["enabled"] is True


async def _read_state() -> Dict[str, Any]:
    import json

    from app import store

    raw = await store.get_setting(scheduler.STATE_KEY, "")
    return json.loads(raw) if raw else {}


# ============================================================== 执行记账
class TestExecution:
    def test_trigger_records_success(self, db) -> None:
        log = _register_probe("probe_ok")
        result = _run(scheduler.trigger("probe_ok"))

        assert log["calls"] == 1
        assert result["last_status"] == "ok"
        assert result["runs"] == 1
        assert result["failures"] == 0
        assert result["last_manual"] is True
        assert result["last_duration_ms"] >= 0
        assert result["last_end"] > 0
        # summarize 缺省时：列表按「N 项」
        assert result["last_summary"] == "2 项"

    def test_trigger_records_failure_without_raising(self, db) -> None:
        _register_probe("probe_fail", fail=True)
        result = _run(scheduler.trigger("probe_fail"))

        # 作业失败不该把异常抛回给调用方 —— 界面的「立即执行」要能拿到错误详情
        assert result["last_status"] == "error"
        assert "探针故障" in result["last_error"]
        assert result["failures"] == 1
        assert result["runs"] == 1

    def test_one_failing_job_does_not_stop_others(self, db) -> None:
        _register_probe("probe_fail2", fail=True)
        log = _register_probe("probe_ok2")

        _run(scheduler.trigger("probe_fail2"))
        _run(scheduler.trigger("probe_ok2"))
        assert log["calls"] == 1

    def test_trigger_unknown_job_raises(self, db) -> None:
        with pytest.raises(KeyError):
            _run(scheduler.trigger("definitely_not_registered"))

    def test_custom_summarizer_is_used(self, db) -> None:
        log: Dict[str, Any] = {}

        async def run() -> int:
            log["calls"] = log.get("calls", 0) + 1
            return 7

        scheduler.register(
            scheduler.Job(
                id="probe_summary",
                name="探针 summary",
                group="测试",
                description="仅测试用",
                run=run,
                default_interval=60,
                summarize=lambda value: f"写了 {value} 行",
            )
        )
        assert _run(scheduler.trigger("probe_summary"))["last_summary"] == "写了 7 行"

    def test_next_run_advances_after_execution(self, db) -> None:
        _register_probe("probe_next")
        _run(scheduler.configure("probe_next", interval=600))
        before = next(j for j in scheduler.snapshot() if j["id"] == "probe_next")["next_in"]

        _run(scheduler.trigger("probe_next"))
        after = next(j for j in scheduler.snapshot() if j["id"] == "probe_next")["next_in"]
        # 跑完立刻重算，等于「刚刚执行 + 一个间隔」
        assert after > 500

    def test_overlap_is_skipped_and_counted(self, db) -> None:
        """上一次没跑完就到点：跳过并计数，而不是并发跑出两份。"""
        _register_probe("probe_slow", delay=0.6)
        state = scheduler._RUNTIME["probe_slow"]
        state.running = True  # 模拟「正在跑」
        state.next_mono = 0  # 已经到点

        _run(scheduler._dispatch())
        assert state.skipped == 1
        assert state.running is True  # 没有被重复派发

        state.running = False

    def test_disabled_job_is_not_dispatched(self, db) -> None:
        log = _register_probe("probe_off")
        _run(scheduler.configure("probe_off", enabled=False))
        state = scheduler._RUNTIME["probe_off"]
        state.next_mono = 0

        _run(scheduler._dispatch())
        assert log["calls"] == 0


# ============================================================== 调度接口
class TestSchedulerApi:
    def test_requires_settings_permission(self, api) -> None:
        viewer = _viewer_headers(api, "schedviewer1")
        assert api.get("/api/scheduler", headers=viewer).status_code == 403
        assert (
            api.put("/api/scheduler/alerts", json={"interval": 120}, headers=viewer).status_code
            == 403
        )

    def test_overview_reports_counts(self, api) -> None:
        body = api.get("/api/scheduler", headers=auth_headers(api)).json()
        assert body["total"] == len(body["jobs"])
        assert body["enabled"] == body["total"]
        assert body["running"] == 0
        assert body["failing"] == 0

    def test_put_updates_interval(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put("/api/scheduler/ports", json={"interval": 900}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["interval"] == 900

        listed = api.get("/api/scheduler", headers=headers).json()["jobs"]
        assert next(j for j in listed if j["id"] == "ports")["interval"] == 900

    def test_put_unknown_job_is_404(self, api) -> None:
        resp = api.put(
            "/api/scheduler/nope", json={"interval": 120}, headers=auth_headers(api)
        )
        assert resp.status_code == 404

    def test_put_without_fields_is_400(self, api) -> None:
        resp = api.put("/api/scheduler/alerts", json={}, headers=auth_headers(api))
        assert resp.status_code == 400

    def test_run_now_returns_result(self, api) -> None:
        headers = auth_headers(api)
        _register_probe("probe_api_run")
        resp = api.post("/api/scheduler/probe_api_run/run", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["last_status"] == "ok"

    def test_run_now_unknown_is_404(self, api) -> None:
        resp = api.post("/api/scheduler/nope/run", headers=auth_headers(api))
        assert resp.status_code == 404

    def test_reset_restores_default(self, api) -> None:
        headers = auth_headers(api)
        api.put("/api/scheduler/alerts", json={"interval": 600}, headers=headers)
        resp = api.post("/api/scheduler/alerts/reset", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["interval"] == 60
        assert resp.json()["modified"] is False


# ============================================================== 界面偏好
class TestPrefs:
    def test_unknown_key_is_404(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/prefs", headers=headers).status_code == 200
        assert (
            api.put("/api/prefs/nope", json={"value": {}}, headers=headers).status_code == 404
        )
        assert api.delete("/api/prefs/nope", headers=headers).status_code == 404

    def test_roundtrip_layout(self, api) -> None:
        headers = auth_headers(api)
        layout = {"order": ["tasks", "kpi"], "hidden": ["tasks"]}

        saved = api.put(
            f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}",
            json={"value": layout},
            headers=headers,
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["value"] == layout

        listed = api.get("/api/prefs", headers=headers).json()
        assert listed["prefs"][prefs.PREF_DASHBOARD_LAYOUT] == layout
        assert prefs.PREF_DASHBOARD_LAYOUT in listed["keys"]

    def test_layout_is_deduped(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put(
            f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}",
            json={"value": {"order": ["kpi", "kpi", "top"], "hidden": ["top", "top"]}},
            headers=headers,
        )
        assert resp.json()["value"] == {"order": ["kpi", "top"], "hidden": ["top"]}

    def test_malformed_layout_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        url = f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}"
        for bad in (
            ["kpi"],  # 不是对象
            {"order": "kpi"},  # order 不是数组
            {"order": [1, 2]},  # 元素不是字符串
            {"order": ["kpi"], "hidden": {"a": 1}},  # hidden 不是数组
        ):
            resp = api.put(url, json={"value": bad}, headers=headers)
            assert resp.status_code == 400, f"{bad} 应当被拒绝"

    def test_too_many_widgets_is_rejected(self, api) -> None:
        from app.routers import prefs as prefs_router

        headers = auth_headers(api)
        big = [f"w{i}" for i in range(prefs_router.MAX_WIDGETS + 1)]
        resp = api.put(
            f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}",
            json={"value": {"order": big, "hidden": []}},
            headers=headers,
        )
        assert resp.status_code == 400

    def test_delete_clears_the_pref(self, api) -> None:
        headers = auth_headers(api)
        url = f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}"
        api.put(url, json={"value": {"order": ["kpi"], "hidden": []}}, headers=headers)

        resp = api.delete(url, headers=headers)
        assert resp.status_code == 200, resp.text
        # 删掉记录而不是写一份默认值：将来默认布局改了，用户会跟着一起变
        assert resp.json()["removed"] is True
        assert api.get("/api/prefs", headers=headers).json()["prefs"] == {}

        # 再删一次：如实回 False，而不是假装成功
        assert api.delete(url, headers=headers).json()["removed"] is False

    def test_prefs_are_isolated_per_user(self, api) -> None:
        admin = auth_headers(api)
        viewer = _viewer_headers(api, "prefviewer")
        url = f"/api/prefs/{prefs.PREF_DASHBOARD_LAYOUT}"

        api.put(url, json={"value": {"order": ["kpi"], "hidden": []}}, headers=admin)
        # 另一个用户看不到，也覆盖不了别人的那份
        assert api.get("/api/prefs", headers=viewer).json()["prefs"] == {}
        api.put(url, json={"value": {"order": ["top"], "hidden": []}}, headers=viewer)
        assert api.get("/api/prefs", headers=admin).json()["prefs"][
            prefs.PREF_DASHBOARD_LAYOUT
        ] == {"order": ["kpi"], "hidden": []}

    def test_requires_auth(self, api) -> None:
        assert api.get("/api/prefs").status_code == 401
