"""性能基线的可回归断言（P0 埋点 + 缓存 + 轻量列表）。

这一组用例不测业务语义，只钉住三件**会被悄悄改回去**的事：

1. `X-PVE-Calls` / `X-DB-Queries` 两个响应头真实反映本次请求的调用数 ——
   没有它们，后面所有「优化了多少倍」都只能是估算；
2. 聚合接口的缓存**确实生效**：同一请求连打两次，第二次的上游调用必须是 0；
3. 轻量列表（`?summary=1`）与仪表盘汇总只返回聚合结果，不再整份搬运客户机列表。

写死 0 的断言是有意的：缓存命中就不该再碰 PVE。若某个接口以后又把缓存去掉，
这里会以「第二次仍有调用」的形式红掉，而不是靠某个人记得。
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import main, pvecache

from test_api_routes import api, auth_headers  # noqa: E402,F401  fixture 复用


# ------------------------------------------------------------------ 埋点本身
def test_metrics_headers_on_anonymous_health() -> None:
    """匿名 /api/health 不查库也不打 PVE：两个头必须是 0，但必须存在。

    这一条同时守住「中间件顺序」：计数中间件若被挤到 PveConnectionScope 里面，
    某些拒绝路径（限流、IP 白名单）就不会带回这两个头。
    """
    client = TestClient(main.app)
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["x-pve-calls"] == "0"
    assert response.headers["x-db-queries"] == "0"


def test_metrics_headers_are_per_request() -> None:
    """计数不跨请求累加：第二个请求必须从 0 重新开始。"""
    client = TestClient(main.app)
    first = client.get("/api/health")
    second = client.get("/api/health")

    assert first.headers["x-pve-calls"] == second.headers["x-pve-calls"] == "0"
    assert first.headers["x-db-queries"] == second.headers["x-db-queries"] == "0"


def test_authenticated_request_counts_db_queries(api) -> None:
    """登录后的请求至少要打几条 SQL（鉴权 + 限流）—— 证明计数真的在跑。"""
    admin = auth_headers(api)
    response = api.get("/api/vms", headers=admin)

    assert response.status_code == 200
    assert int(response.headers["x-db-queries"]) > 0


# --------------------------------------------------------------- 聚合接口缓存
class TestAggregationCache:
    """第二次请求的 `X-PVE-Calls` 必须为 0（命中缓存）。"""

    def test_backups_stats_is_cached(self, api) -> None:
        admin = auth_headers(api)

        first = api.get("/api/backups/stats", headers=admin)
        assert first.status_code == 200
        assert int(first.headers["x-pve-calls"]) > 0

        second = api.get("/api/backups/stats", headers=admin)
        assert second.status_code == 200
        assert second.headers["x-pve-calls"] == "0"
        # 缓存命中时 as_of 不变：前端据此显示「数据截至 x 秒前」
        assert second.json()["as_of"] == first.json()["as_of"]

        # ?fresh=1 是显式旁路：必须真的再去问一次 PVE
        third = api.get("/api/backups/stats?fresh=1", headers=admin)
        assert int(third.headers["x-pve-calls"]) > 0

    def test_vztmpl_is_cached(self, api) -> None:
        admin = auth_headers(api)

        first = api.get("/api/templates/vztmpl", headers=admin)
        assert first.status_code == 200
        assert int(first.headers["x-pve-calls"]) > 0

        second = api.get("/api/templates/vztmpl", headers=admin)
        assert second.headers["x-pve-calls"] == "0"

    def test_snapshots_is_cached(self, api) -> None:
        admin = auth_headers(api)

        first = api.get("/api/snapshots", headers=admin)
        assert first.status_code == 200
        assert int(first.headers["x-pve-calls"]) > 0

        second = api.get("/api/snapshots", headers=admin)
        assert second.headers["x-pve-calls"] == "0"


# --------------------------------------------------------------- 轻量列表形态
class TestLightweightPayloads:
    def test_vms_summary_only_returns_compact_fields(self, api) -> None:
        admin = auth_headers(api)

        full = api.get("/api/vms?type=all", headers=admin).json()
        compact = api.get("/api/vms?type=all&summary=1", headers=admin).json()

        assert compact, "夹具里至少有一台客户机"
        full_fields = set(full[0])
        compact_fields = set(compact[0])
        # 只裁剪、不多加：轻量字段是全量字段的子集，避免两套口径各说各话
        assert compact_fields < full_fields
        assert {"node", "vmid", "status", "maxmem"} <= compact_fields
        # tags / 网络吞吐 / 创建时间这类逐台补充项不再出现在轻量列表里
        assert "created" not in compact_fields
        assert "netin" not in compact_fields

    def test_dashboard_summary_shape(self, api) -> None:
        admin = auth_headers(api)

        body = api.get("/api/dashboard/summary", headers=admin).json()

        guests = body["guests"]
        assert guests["vms"] >= 1
        # 模板不计入台数（与列表页「排除模板」的口径一致）
        assert guests["total"] == guests["vms"] + guests["cts"]
        assert guests["vm_running"] + guests["vm_stopped"] + guests["vm_other"] == (
            guests["vms"]
        )
        assert set(body["top"]) == {"by_cpu", "by_memory", "total_running"}
        assert isinstance(body["as_of"], int)

    def test_dashboard_summary_is_cached(self, api) -> None:
        admin = auth_headers(api)

        api.get("/api/dashboard/summary", headers=admin)
        second = api.get("/api/dashboard/summary", headers=admin)

        assert second.headers["x-pve-calls"] == "0"


# ------------------------------------------------------------------ 缓存基础设施
class TestPvecacheBounds:
    """缓存必须有界：按用户 / 查询词分档的动态 key 不能把进程内存吃光。"""

    def test_entries_are_capped(self, monkeypatch) -> None:
        pvecache.invalidate()
        monkeypatch.setattr(pvecache, "MAX_ENTRIES", 4)

        async def _fill() -> None:
            for i in range(20):
                await pvecache.cached(f"perf:test:{i}", 60, lambda i=i: _value(i))

        asyncio.run(_fill())
        assert len(pvecache._cached) <= 4
        # 被淘汰的 key 对应的锁也要一起清掉，否则锁表自己会泄漏
        assert set(pvecache._locks) <= set(pvecache._cached)

    def test_fresh_bypasses_but_refreshes(self) -> None:
        pvecache.invalidate()
        calls: list[int] = []

        async def factory() -> int:
            calls.append(1)
            return len(calls)

        async def _run() -> tuple[int, int, int]:
            first = await pvecache.cached("perf:fresh", 60, factory)
            cached = await pvecache.cached("perf:fresh", 60, factory)
            forced = await pvecache.cached("perf:fresh", 60, factory, fresh=True)
            return first, cached, forced

        first, cached, forced = asyncio.run(_run())
        assert first == cached == 1  # 第二次命中缓存，工厂没有再跑
        assert forced == 2  # 旁路重算
        # 重算结果会被写回：紧跟其后的普通请求又能命中
        assert asyncio.run(pvecache.cached("perf:fresh", 60, factory)) == 2
        assert len(calls) == 2


async def _value(index: int) -> int:
    return index


@pytest.fixture(autouse=True)
def _clear_cache():
    """本文件里直接操作进程缓存的用例互不影响。"""
    pvecache.invalidate()
    yield
    pvecache.invalidate()


# ----------------------------------------------------------- 指标 WS 单例采集
def test_metrics_hub_samples_once_for_many_subscribers(monkeypatch) -> None:
    """N 个订阅者只触发 1 路采集：这是「多开标签页 = 1 份 PVE 请求」的断言。"""
    from app.routers import tasks as tasks_router

    calls: list[int] = []

    class FakeClient:
        async def nodes(self):
            calls.append(1)
            return [
                {"node": "pve1", "status": "online", "cpu": 0.1, "mem": 1, "maxmem": 2}
            ]

    monkeypatch.setattr(tasks_router, "get_client", lambda: FakeClient())
    monkeypatch.setattr(tasks_router, "METRICS_TICK", 0.05)

    async def _run():
        hub = tasks_router._MetricsHub()
        first_queue = hub.subscribe()
        second_queue = hub.subscribe()
        first = await asyncio.wait_for(first_queue.get(), 2)
        second = await asyncio.wait_for(second_queue.get(), 2)
        sampled = len(calls)
        hub.unsubscribe(first_queue)
        hub.unsubscribe(second_queue)
        await asyncio.sleep(0.12)  # 订阅者清空后循环自行退出
        return first, second, sampled

    first, second, sampled = asyncio.run(_run())
    assert first["type"] == "metrics"
    assert first["nodes"][0]["node"] == "pve1"
    assert first == second  # 同一份快照投递给所有人
    assert sampled == 1  # 两个订阅者共用一次采集


def test_task_hub_filters_per_subscriber(monkeypatch) -> None:
    """任务推送：上游只抓一次，但每个订阅者拿到的必须是**自己**那份。"""
    from app.routers import tasks as tasks_router

    polls: list[int] = []

    class FakeClient:
        async def tasks(self, limit: int = 40):
            polls.append(limit)
            return [{"upid": "UPID:pve1:0:0:0:qmstart:100:root@pam:", "status": "running"}]

    class ScopeAll:
        def filter(self, rows, _conn):
            return rows

    class ScopeNone:
        def filter(self, rows, _conn):
            return []

    monkeypatch.setattr(tasks_router, "get_client", lambda: FakeClient())
    monkeypatch.setattr(tasks_router, "normalize_task", lambda t: {**t, "running": True})
    monkeypatch.setattr(tasks_router, "TASKS_TICK", 0.05)

    async def _run():
        hub = tasks_router._TaskHub()
        allowed_queue = hub.subscribe(ScopeAll(), 40)
        empty_queue = hub.subscribe(ScopeNone(), 40)
        frame = await asyncio.wait_for(allowed_queue.get(), 2)
        polls_for_first_frame = len(polls)
        empty_delivered = not empty_queue.empty()
        hub.unsubscribe(allowed_queue)
        hub.unsubscribe(empty_queue)
        await asyncio.sleep(0.12)
        return frame, empty_delivered, polls_for_first_frame

    frame, empty_delivered, poll_count = asyncio.run(_run())
    assert frame["type"] == "tasks"
    assert len(frame["tasks"]) == 1
    assert empty_delivered is False  # 越权用户拿不到任何一行
    assert poll_count == 1  # 两个订阅者共用一次上游抓取


# ------------------------------------------------------- 列表 limit / 总数头
class TestListLimit:
    """``limit`` 只在显式传入时生效，总数永远通过 ``X-Total-Count`` 给出。"""

    def test_vms_limit_truncates_and_reports_total(self, api) -> None:
        admin = auth_headers(api)

        full = api.get("/api/vms?type=all", headers=admin)
        assert full.status_code == 200
        total = len(full.json())
        assert total >= 1
        # 不传 limit 时行为与以前完全一致：返回全部
        assert full.headers["x-total-count"] == str(total)

        limited = api.get("/api/vms?type=all&limit=1", headers=admin)
        assert limited.status_code == 200
        assert len(limited.json()) == min(1, total)
        # 关键：截断了，但总数没变 —— 前端据此显示「已加载 1 / 共 N」
        assert limited.headers["x-total-count"] == str(total)

    def test_snapshots_limit_does_not_poison_cache(self, api) -> None:
        """``limit`` 作用在响应上，不能把截断后的结果写进缓存。"""
        admin = auth_headers(api)

        first = api.get("/api/snapshots?limit=1", headers=admin)
        assert first.status_code == 200
        total = first.headers["x-total-count"]

        # 缓存里应仍是全量：再来一次不带 limit 的请求，条数应与总数一致
        second = api.get("/api/snapshots", headers=admin)
        assert second.status_code == 200
        assert second.headers["x-total-count"] == total
        assert len(second.json()) == int(total)
