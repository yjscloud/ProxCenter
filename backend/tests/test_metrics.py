"""监控历史落库：采样、降采样查询、保留清理与查询接口回归。

分两层驱动：

* **纯函数 / 模块层**（采样、查询、清理）用 ``asyncio.run`` 直接调，跑完关掉
  连接池 —— aiomysql 的池绑在创建它的事件循环上，不关会在下个用例里炸
  「Event loop is closed」（与 test_store_secrets 同一套路）；
* **接口层**用 ``api`` fixture 的 TestClient，历史行用同步 pymysql 直插，
  不跨事件循环碰异步池。

被测的关键控制：单台 PVE 连不上不能断采、同一周期重复采样不产生重复点、
超期行必须被清掉、非管理员查 guest 历史只能看到自己名下的机器。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, metrics  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

# 一个整分钟的采样时刻：align_ts 对它应当是恒等变换，断言里好读
NOW = 1_700_000_040
DAY = 86_400


# ------------------------------------------------------------------ 测试工具
async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池：池绑在 asyncio.run 新建的循环上。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


def _exec(sql: str, params: Optional[tuple] = None) -> List[Any]:
    """同步执行一条 SQL（conftest 的 connect 是 autocommit）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return cursor.fetchall()
    finally:
        conn.close()


def _insert_point(
    *,
    ts: int,
    scope: str,
    connection_id: str = "-",
    node: str = "pve1",
    vmid: int = 0,
    guest_type: str = "",
    name: str = "",
    status: str = "",
    cpu: float = 0.0,
    maxcpu: int = 1,
    mem: int = 0,
    maxmem: int = 0,
    disk: int = 0,
    maxdisk: int = 0,
    uptime: int = 0,
) -> None:
    _exec(
        "INSERT INTO metrics_history"
        " (ts, scope, connection_id, node, vmid, guest_type, name, status,"
        "  cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            ts,
            scope,
            connection_id,
            node,
            vmid,
            guest_type,
            name,
            status,
            cpu,
            maxcpu,
            mem,
            maxmem,
            disk,
            maxdisk,
            uptime,
        ),
    )


class FakeClient:
    """只实现采样真正会用的那一个方法。"""

    def __init__(
        self,
        resources: Optional[List[Dict[str, Any]]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self._resources = resources or []
        self._error = error

    async def cluster_resources(self, rtype: Optional[str] = None) -> List[Dict[str, Any]]:
        if self._error is not None:
            raise self._error
        return self._resources


# `cluster_resources` 的真实返回：节点、虚拟机、容器各一条，外加一条存储
# （存储不属于本模块关心的对象，应当被忽略）
RESOURCES: List[Dict[str, Any]] = [
    {
        "type": "node",
        "node": "pve1",
        "status": "online",
        "cpu": 0.25,
        "maxcpu": 8,
        "mem": 4_000,
        "maxmem": 16_000,
        "disk": 1_000,
        "maxdisk": 10_000,
        "uptime": 5_000,
        "netin": 111,
        "netout": 222,
    },
    {
        "type": "qemu",
        "node": "pve1",
        "vmid": 100,
        "name": "web",
        "status": "running",
        "cpu": 0.5,
        "maxcpu": 2,
        "mem": 1_024,
        "maxmem": 2_048,
        "disk": 0,
        "maxdisk": 20_480,
        "uptime": 600,
        "netin": 10,
        "netout": 20,
        "diskread": 30,
        "diskwrite": 40,
    },
    {
        "type": "lxc",
        "node": "pve1",
        "vmid": 200,
        "name": "ct",
        "status": "running",
        "cpu": 0.1,
        "maxcpu": 1,
        "mem": 256,
        "maxmem": 512,
        "disk": 300,
        "maxdisk": 8_192,
        "uptime": 900,
    },
    {"type": "storage", "node": "pve1", "storage": "local", "disk": 1, "maxdisk": 2},
]


@pytest.fixture()
def history_db(clean_mysql_db):
    """只建监控历史表：不启动完整应用，直接调模块的 init_table。"""
    _run(metrics.init_table())
    yield


def _stub_targets(monkeypatch, *clients) -> None:
    """把采样目标换成假的 PVE 连接，避免测试真的去连集群。"""
    targets = [(None if i == 0 else {"id": f"c{i}"}, client) for i, client in enumerate(clients)]
    monkeypatch.setattr(metrics, "_sampling_targets", lambda: targets)


# -------------------------------------------------------------------- 纯函数
class TestPureHelpers:
    def test_align_ts_snaps_to_sample_interval(self) -> None:
        # 默认采样周期 60s：整分钟不变，分钟中间落到该分钟的起点
        assert metrics.align_ts(NOW) == NOW
        assert metrics.align_ts(NOW + 37) == NOW

    def test_pick_step_grows_with_span(self) -> None:
        assert metrics.pick_step(3600) == 60  # 1 小时：分钟级
        assert metrics.pick_step(24 * 3600) == 300
        assert metrics.pick_step(3 * DAY) == 900
        assert metrics.pick_step(20 * DAY) == 3600
        assert metrics.pick_step(365 * DAY) == 3600

    def test_pick_step_honours_request_and_clamps(self) -> None:
        assert metrics.pick_step(30 * DAY, 120) == 120
        # 超出合法区间要夹回来，不能让调用方把库拖死
        assert metrics.pick_step(30 * DAY, 1) == 60
        assert metrics.pick_step(30 * DAY, 10**9) == 86_400


# ---------------------------------------------------------------------- 采样
class TestSampling:
    def test_writes_node_and_guest_points(self, history_db, monkeypatch) -> None:
        _stub_targets(monkeypatch, FakeClient(RESOURCES))

        written = _run(metrics.sample_once(now=NOW))
        # 节点 1 条 + 虚拟机 2 条；storage 那条要被忽略
        assert written == 3

        rows = _exec(
            "SELECT scope, node, vmid, guest_type, cpu, maxdisk, status"
            " FROM metrics_history ORDER BY scope, vmid"
        )
        by_key = {(r[0], r[2]): r for r in rows}

        node_row = by_key[("node", 0)]
        # 节点行 vmid 固定写 0：NULL 不参与 UNIQUE 判重，会让节点行每次采样再插一条
        assert node_row[1] == "pve1"
        assert node_row[4] == pytest.approx(0.25)
        assert node_row[6] == "online"

        vm_row = by_key[("guest", 100)]
        assert vm_row[3] == "qemu"
        assert vm_row[5] == 20_480
        assert by_key[("guest", 200)][3] == "lxc"

    def test_same_period_is_idempotent(self, history_db, monkeypatch) -> None:
        """同一分钟内重复跑（容器重启、多进程同时跑）不该插出重复点。"""
        _stub_targets(monkeypatch, FakeClient(RESOURCES))

        _run(metrics.sample_once(now=NOW))
        _run(metrics.sample_once(now=NOW + 5))  # 同一分钟

        (count,) = _exec("SELECT COUNT(*) FROM metrics_history")[0]
        assert count == 3

    def test_next_period_appends_a_new_point(self, history_db, monkeypatch) -> None:
        _stub_targets(monkeypatch, FakeClient(RESOURCES))
        _run(metrics.sample_once(now=NOW))
        _run(metrics.sample_once(now=NOW + 60))
        (count,) = _exec("SELECT COUNT(*) FROM metrics_history")[0]
        assert count == 6

    def test_unreachable_connection_does_not_break_sampling(
        self, history_db, monkeypatch
    ) -> None:
        """一台 PVE 连不上只跳过它：另一台的数据必须照常落库。"""
        _stub_targets(
            monkeypatch,
            FakeClient(error=metrics.ProxmoxError("连接超时")),
            FakeClient(RESOURCES),
        )

        written = _run(metrics.sample_once(now=NOW))
        assert written == 3
        assert _exec("SELECT COUNT(*) FROM metrics_history")[0][0] == 3

    def test_sample_is_a_noop_when_disabled(self, history_db, monkeypatch) -> None:
        monkeypatch.setattr(settings, "metrics_history_enabled", False)
        _stub_targets(monkeypatch, FakeClient(RESOURCES))

        assert _run(metrics.sample_once(now=NOW)) == 0
        assert _exec("SELECT COUNT(*) FROM metrics_history")[0][0] == 0


# ------------------------------------------------------------------ 保留清理
class TestRetention:
    def test_purge_removes_only_expired_rows(self, history_db) -> None:
        old = NOW - 40 * DAY
        _insert_point(ts=old, scope="node", node="pve1")
        _insert_point(ts=NOW, scope="node", node="pve1")

        deleted = _run(metrics.purge_old(now=NOW))

        assert deleted == 1
        remaining = _exec("SELECT ts FROM metrics_history")
        assert [r[0] for r in remaining] == [NOW]

    def test_zero_retention_means_keep_forever(self, history_db, monkeypatch) -> None:
        monkeypatch.setattr(settings, "metrics_retention_days", 0)
        _insert_point(ts=NOW - 400 * DAY, scope="node", node="pve1")

        assert _run(metrics.purge_old(now=NOW)) == 0
        assert _exec("SELECT COUNT(*) FROM metrics_history")[0][0] == 1


# ---------------------------------------------------------------------- 查询
class TestQuery:
    def test_downsample_averages_rates_and_keeps_capacity_max(self, history_db) -> None:
        """速率类取平均、容量类取上限：平均会把容量峰值抹平，不能用 AVG。"""
        bucket = NOW // 3600 * 3600
        _insert_point(
            ts=bucket, scope="node", node="pve1",
            cpu=0.2, maxmem=100, status="online",
        )
        _insert_point(
            ts=bucket + 60, scope="node", node="pve1",
            cpu=0.4, maxmem=200, status="online",
        )

        result = _run(
            metrics.query(scope="node", start=bucket, end=bucket + 3600, step=3600)
        )

        assert len(result["series"]) == 1
        series = result["series"][0]
        assert series["vmid"] is None  # 节点行没有 VMID
        points = series["points"]
        assert len(points) == 1  # 两个点落在同一个桶里
        assert points[0]["cpu"] == pytest.approx(0.3)
        assert points[0]["maxmem"] == 200
        assert points[0]["up_ratio"] == 1.0
        assert points[0]["samples"] == 2

    def test_up_ratio_counts_only_up_status(self, history_db) -> None:
        bucket = NOW // 3600 * 3600
        _insert_point(ts=bucket, scope="guest", vmid=100, guest_type="qemu", status="running")
        _insert_point(ts=bucket + 60, scope="guest", vmid=100, guest_type="qemu", status="stopped")

        result = _run(
            metrics.query(scope="guest", start=bucket, end=bucket + 3600, step=3600)
        )

        point = result["series"][0]["points"][0]
        assert point["up_ratio"] == pytest.approx(0.5)

    def test_series_are_split_per_guest(self, history_db) -> None:
        _insert_point(ts=NOW, scope="guest", vmid=100, name="web", guest_type="qemu")
        _insert_point(ts=NOW, scope="guest", vmid=200, name="ct", guest_type="lxc")

        result = _run(metrics.query(scope="guest", start=NOW, end=NOW + 60, step=60))

        assert [s["vmid"] for s in result["series"]] == [100, 200]
        assert result["series"][0]["guest_type"] == "qemu"

    def test_scopes_never_mix(self, history_db) -> None:
        _insert_point(ts=NOW, scope="node", node="pve1")
        _insert_point(ts=NOW, scope="guest", vmid=100)

        nodes = _run(metrics.query(scope="node", start=NOW, end=NOW + 60, step=60))
        guests = _run(metrics.query(scope="guest", start=NOW, end=NOW + 60, step=60))

        assert len(nodes["series"]) == 1
        assert len(guests["series"]) == 1

    def test_empty_owned_refs_returns_nothing(self, history_db) -> None:
        """严格隔离：名下没有任何虚拟机时，历史里也不该出现别人的机器。"""
        _insert_point(ts=NOW, scope="guest", vmid=100)

        result = _run(
            metrics.query(
                scope="guest", start=NOW, end=NOW + 60, step=60, owned_refs=[]
            )
        )

        assert result["series"] == []

    def test_owned_refs_filter_by_connection_node_vmid(self, history_db) -> None:
        """归属过滤要带连接一起比对：不同 PVE 上同名节点 + 相同 VMID 是两台机器。"""
        _insert_point(ts=NOW, scope="guest", vmid=100, node="pve1", connection_id="-")
        _insert_point(ts=NOW, scope="guest", vmid=100, node="pve1", connection_id="other")
        _insert_point(ts=NOW, scope="guest", vmid=101, node="pve1", connection_id="-")

        result = _run(
            metrics.query(
                scope="guest",
                start=NOW,
                end=NOW + 60,
                step=60,
                owned_refs=["-:pve1:100"],
            )
        )

        assert len(result["series"]) == 1
        assert result["series"][0]["vmid"] == 100

    def test_unknown_scope_is_rejected(self, history_db) -> None:
        with pytest.raises(ValueError):
            _run(metrics.query(scope="storage", start=NOW, end=NOW + 60, step=60))


# -------------------------------------------------------------- 容量预测数据源
class TestCapacitySeries:
    def test_sums_nodes_then_averages_buckets(self, history_db) -> None:
        """同一时刻必须先跨节点求和，再按桶平均 —— 直接 SUM 整段会重复累加。"""
        _insert_point(ts=NOW, scope="node", node="pve1", disk=100, maxdisk=1000)
        _insert_point(ts=NOW, scope="node", node="pve2", disk=300, maxdisk=2000)
        _insert_point(ts=NOW + 3600, scope="node", node="pve1", disk=200, maxdisk=1000)
        _insert_point(ts=NOW + 3600, scope="node", node="pve2", disk=400, maxdisk=2000)

        series = _run(metrics.capacity_series(NOW, step=3600))

        assert [point[1] for point in series["points"]] == pytest.approx([400.0, 600.0])
        # 容量上限取各时刻总和的最大值
        assert series["total"] == pytest.approx(3000.0)


# ------------------------------------------------------------------ HTTP 接口
class TestMetricsApi:
    def test_history_requires_auth(self, api) -> None:
        assert api.get("/api/metrics/history").status_code == 401

    def test_admin_reads_node_history(self, api) -> None:
        headers = auth_headers(api)
        _insert_point(ts=NOW, scope="node", node="pve1", cpu=0.5, maxcpu=4, status="online")

        resp = api.get(
            f"/api/metrics/history?scope=node&start={NOW - 60}&end={NOW + 60}",
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["scope"] == "node"
        assert body["step"] == 60
        series = body["series"]
        assert len(series) == 1
        assert series[0]["node"] == "pve1"
        assert series[0]["points"][0]["cpu"] == pytest.approx(0.5)

    def test_empty_history_is_not_an_error(self, api) -> None:
        headers = auth_headers(api)
        resp = api.get("/api/metrics/history?scope=node", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["series"] == []

    def test_start_after_end_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        resp = api.get(
            f"/api/metrics/history?start={NOW + 600}&end={NOW}", headers=headers
        )
        assert resp.status_code == 400

    def test_guest_scope_only_returns_own_vms(self, api) -> None:
        """归属隔离：列表里看不见的机器，历史里也不能查得到。"""
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users",
                json={
                    "username": "mops1",
                    "password": "Unit-Test-Pa55word",
                    "role": "operator",
                },
                headers=admin,
            ).status_code
            == 200
        )
        operator = api.post(
            "/api/auth/login",
            json={"username": "mops1", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        ops_headers = {"Authorization": f"Bearer {operator}"}

        # pve1/100 指派给 mops1，101 不指派（严格隔离下普通用户看不到）
        assert (
            api.put(
                "/api/vms/pve1/100/owner",
                json={"username": "mops1"},
                headers=admin,
            ).status_code
            == 200
        )

        _insert_point(ts=NOW, scope="guest", node="pve1", vmid=100, name="mine", guest_type="qemu")
        _insert_point(ts=NOW, scope="guest", node="pve1", vmid=101, name="other", guest_type="qemu")

        # 必须显式给窗口：默认窗口是「近 6 小时」，而采样点的时间戳是固定的历史时刻
        window = f"scope=guest&start={NOW - 60}&end={NOW + 60}"
        mine = api.get(f"/api/metrics/history?{window}", headers=ops_headers)
        assert mine.status_code == 200, mine.text
        assert [s["vmid"] for s in mine.json()["series"]] == [100]

        everything = api.get(f"/api/metrics/history?{window}", headers=admin)
        assert [s["vmid"] for s in everything.json()["series"]] == [100, 101]

    def test_coverage_reports_config_and_window(self, api) -> None:
        headers = auth_headers(api)
        _insert_point(ts=NOW, scope="node", node="pve1")

        body = api.get("/api/metrics/coverage", headers=headers).json()

        assert body["enabled"] is True
        assert body["interval"] == settings.metrics_sample_interval
        assert body["retention_days"] == settings.metrics_retention_days
        assert body["earliest"] == NOW
        assert body["latest"] == NOW
