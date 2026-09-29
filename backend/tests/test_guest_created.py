"""创建时间的解析、面板记录与缓存。

覆盖四件最容易出错的事：

* ``meta`` 是 PVE 的「属性字符串」，里面既有版本号（``creation-qemu=9.2.0``）
  也有时间戳（``ctime=...``）—— 只认后者，且必须落在合理区间里；
* **面板记录优先于 PVE 的 meta**：PVE 克隆 / 恢复会整体复制 config，``meta.ctime``
  跟着模板走（实测克隆出来的机器显示的是模板时间），面板自己那份才是准确的；
* 缓存要能区分「这台机器确实没有 meta」与「这次没问到」：前者按 15 分钟过期、
  后者按 5 分钟过期，但两种都**不能每轮轮询都重复去问 PVE**；
* 缓存键必须带连接与节点 —— 实测本机两台 PVE 上各有一个 ``vmid=100``，
  少一段就会把别人家的创建时间显示到这台机器上；而且 VMID 会被回收，
  「本轮已经不存在的键」必须清掉，否则重建的同号机器会显示上一台的时间。

用例全部不碰数据库与真实 PVE（``_FakeClient`` 顶替、记录表与审计回填打桩），
因此不依赖 MySQL。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

# 从 backend/ 目录直接跑 pytest 时也能 import app
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import guest_created  # noqa: E402

CTIME = 1789814562  # 2026-09-19 18:42:42，实测本机 PVE 里的一个真实取值


class _FakeClient:
    """只回答 config 的假客户端，并记录被问过哪些路径。"""

    def __init__(
        self,
        configs: Optional[Dict[int, Dict[str, Any]]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self.configs = configs or {}
        self.error = error
        self.asked: List[str] = []

    async def _answer(self, node: str, vmid: int, path: str) -> Dict[str, Any]:
        self.asked.append(path)
        if self.error is not None:
            raise self.error
        if vmid not in self.configs:
            # 真实 PVE 对不存在的 vmid 会返回错误，ProxmoxClient 抛出 ProxmoxError
            raise RuntimeError(f"no such guest: {vmid}")
        return self.configs[vmid]

    async def qemu_config(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self._answer(node, vmid, f"/nodes/{node}/qemu/{vmid}/config")

    async def lxc_config(self, node: str, vmid: int) -> Dict[str, Any]:
        return await self._answer(node, vmid, f"/nodes/{node}/lxc/{vmid}/config")


def _item(vmid: int, guest_type: str = "qemu", conn: str = "c1", node: str = "pve") -> Dict[str, Any]:
    return {
        "connection_id": conn,
        "node": node,
        "vmid": vmid,
        "type": guest_type,
        "created": guest_created.cached(conn, node, vmid, guest_type),
    }


@pytest.fixture(autouse=True)
def clean_cache(monkeypatch):
    """模块级缓存跨用例共享，前后都清干净，避免互相串味。

    同时把「碰面板库」的两条路打桩：单元测试不依赖 MySQL，也不该去连 PVE
    列节点（审计回填要判断节点名是否唯一）。需要验证记录优先的用例自己覆盖
    ``_records_for``，见 :class:`TestPanelRecord`。
    """
    guest_created.clear()

    async def _no_records(_conn_id: str = "") -> Dict[str, int]:
        return {}

    async def _no_backfill(*_a: Any, **_kw: Any) -> Optional[int]:
        return None

    async def _no_drop(*_a: Any, **_kw: Any) -> None:
        return None

    class _NoDatabase:
        """任何数据库访问都直接失败：单元测试不该连 MySQL（连连接池都不建）。"""

        async def __aenter__(self) -> Any:
            raise RuntimeError("单元测试不接数据库")

        async def __aexit__(self, *_exc: Any) -> bool:
            return False

    monkeypatch.setattr(guest_created.database, "connect", lambda: _NoDatabase())
    monkeypatch.setattr(guest_created, "_records_for", _no_records)
    monkeypatch.setattr(guest_created, "_backfill_from_audit", _no_backfill)
    monkeypatch.setattr(guest_created, "_drop_stale_records", _no_drop)
    yield
    guest_created.clear()


class TestParseCreated:
    def test_reads_ctime_from_qemu_meta(self) -> None:
        assert guest_created.parse_created(
            {"meta": f"creation-qemu=9.2.0,ctime={CTIME}"}
        ) == CTIME

    def test_reads_ctime_from_lxc_meta(self) -> None:
        assert guest_created.parse_created(
            {"meta": "creation-lxc=6.0.0,ctime=1761466208"}
        ) == 1761466208

    def test_ctime_need_not_be_first(self) -> None:
        assert guest_created.parse_created(
            {"meta": f"creation-qemu=9.2.0,ctime={CTIME},foo=bar"}
        ) == CTIME

    def test_version_only_is_not_a_time(self) -> None:
        """``creation-qemu=9.2.0`` 是版本号，拿它当时间会得到一串没意义的数字。"""
        assert guest_created.parse_created({"meta": "creation-qemu=9.2.0"}) is None

    def test_rejects_non_numeric_ctime(self) -> None:
        assert guest_created.parse_created({"meta": "ctime=abc"}) is None
        assert guest_created.parse_created({"meta": "ctime="}) is None

    def test_rejects_implausible_timestamps(self) -> None:
        """2000 年前与「明天之后」都当脏数据，免得界面出现「创建于 2087 年」。"""
        assert guest_created.parse_created({"meta": "ctime=123"}) is None
        assert guest_created.parse_created({"meta": "ctime=99999999999"}) is None

    def test_handles_missing_meta(self) -> None:
        assert guest_created.parse_created({}) is None
        assert guest_created.parse_created({"meta": ""}) is None
        assert guest_created.parse_created(None) is None
        # 老机器的 config 里连 meta 这个键都没有（实测 15 台里 9 台如此）
        assert guest_created.parse_created({"cores": 2, "memory": 512}) is None


class TestCacheKey:
    def test_distinguishes_connection(self) -> None:
        """两台 PVE 上各有一个 vmid=100，键里不带连接就会串号。"""
        assert guest_created.cache_key("default", "pve", 100, "qemu") != guest_created.cache_key(
            "5265db08", "pve9", 100, "qemu"
        )

    def test_distinguishes_node_and_type(self) -> None:
        assert guest_created.cache_key("c", "n1", 100, "qemu") != guest_created.cache_key(
            "c", "n2", 100, "qemu"
        )
        assert guest_created.cache_key("c", "n", 100, "qemu") != guest_created.cache_key(
            "c", "n", 100, "lxc"
        )


class TestFill:
    def test_fills_value_then_serves_from_cache(self) -> None:
        client = _FakeClient({100: {"meta": f"creation-qemu=9.2.0,ctime={CTIME}"}})
        items = [_item(100)]

        asyncio.run(guest_created.fill(client, items))
        assert items[0]["created"] == CTIME
        assert len(client.asked) == 1

        # 第二轮：一个字都不用再问 PVE（列表每 10 秒轮询一次，这是关键）
        items2 = [_item(100)]
        asyncio.run(guest_created.fill(client, items2))
        assert items2[0]["created"] == CTIME
        assert len(client.asked) == 1

    def test_confirmed_missing_is_not_asked_every_round(self) -> None:
        """确认没有 meta 的机器按 MISS_TTL 缓存，不能每轮都去问一遍。"""
        client = _FakeClient({100: {"cores": 2}})
        asyncio.run(guest_created.fill(client, [_item(100)]))
        assert len(client.asked) == 1

        asyncio.run(guest_created.fill(client, [_item(100)]))
        assert len(client.asked) == 1, "确认没有的条目不应重复请求"

    def test_expired_miss_is_asked_again(self) -> None:
        """过期之后要重新问：config 之后可能被补上 meta（迁移 / 手工改过）。"""
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        key = guest_created.cache_key("c1", "pve", 100, "qemu")
        guest_created._cache[key] = (time.time() - 1, None)

        items = [_item(100)]
        asyncio.run(guest_created.fill(client, items))
        assert items[0]["created"] == CTIME
        assert len(client.asked) == 1

    def test_failure_is_cached_with_short_ttl(self) -> None:
        """PVE 抖一下不该让日期消失 6 小时，也不该让每轮轮询反复去戳它。"""
        client = _FakeClient(error=RuntimeError("502 bad gateway"))
        asyncio.run(guest_created.fill(client, [_item(100)], budget=8))
        assert len(client.asked) == 1

        asyncio.run(guest_created.fill(client, [_item(100)], budget=8))
        assert len(client.asked) == 1, "失败也要缓存，否则每轮轮询都会重试"

        key = guest_created.cache_key("c1", "pve", 100, "qemu")
        expires_at, value = guest_created._cache[key]
        assert value is None
        # 失败条目的过期时间明显早于「确认没有」的 MISS_TTL
        assert expires_at - time.time() <= guest_created.ERROR_TTL_SECONDS + 1
        assert expires_at - time.time() < guest_created.MISS_TTL_SECONDS

    def test_never_raises_on_unexpected_error(self) -> None:
        client = _FakeClient(error=KeyError("不是 ProxmoxError 也要兜住"))
        items = [_item(100)]
        asyncio.run(guest_created.fill(client, items))  # 不应抛出
        assert items[0]["created"] is None

    def test_budget_caps_requests_per_round(self) -> None:
        """冷启动时不能把几百台机器的一次请求全压在一条响应里。"""
        client = _FakeClient({})
        items = [_item(100 + i) for i in range(10)]

        asyncio.run(guest_created.fill(client, items, budget=3))
        assert len(client.asked) == 3

        # 下一轮取的是**没问过**的那几台，而不是重复问前三台
        asyncio.run(guest_created.fill(client, items, budget=3))
        assert len(client.asked) == 6

        asyncio.run(guest_created.fill(client, items, budget=3))
        asyncio.run(guest_created.fill(client, items, budget=3))
        assert len(client.asked) == 10

        # 全部问过之后再轮询：一台都不问
        asyncio.run(guest_created.fill(client, items, budget=3))
        assert len(client.asked) == 10

    def test_duplicate_items_asked_once(self) -> None:
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        items = [_item(100), _item(100), _item(100)]
        asyncio.run(guest_created.fill(client, items))
        assert len(client.asked) == 1
        assert all(i["created"] == CTIME for i in items)

    def test_dispatches_lxc_to_lxc_endpoint(self) -> None:
        client = _FakeClient({110: {"meta": f"creation-lxc=6.0.0,ctime={CTIME}"}})
        items = [_item(110, guest_type="lxc")]
        asyncio.run(guest_created.fill(client, items))
        assert client.asked == ["/nodes/pve/lxc/110/config"]
        assert items[0]["created"] == CTIME

    def test_no_request_when_cache_is_warm(self) -> None:
        """命中缓存时连一次 PVE 请求都不该发（fill 与 cached 都是）。"""
        guest_created._cache[guest_created.cache_key("c1", "pve", 100, "qemu")] = (
            float("inf"),
            CTIME,
        )
        client = _FakeClient({})
        items = [_item(100)]
        assert items[0]["created"] == CTIME  # cached() 直接给值
        asyncio.run(guest_created.fill(client, items))
        assert client.asked == []

    def test_empty_items_is_a_noop(self) -> None:
        client = _FakeClient({})
        asyncio.run(guest_created.fill(client, []))
        assert client.asked == []

    def test_value_is_written_to_every_duplicate(self) -> None:
        """同一台机器在同一次列表里出现多次（理论上可能）时不能只写第一行。"""
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        items = [_item(100), _item(100)]
        asyncio.run(guest_created.fill(client, items))
        assert [i["created"] for i in items] == [CTIME, CTIME]

    def test_same_vmid_on_different_nodes_is_fetched_separately(self) -> None:
        """缓存键带节点：不同节点上的同 VMID 是两台不同的机器，不能共用一次取数。"""
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        items = [_item(100, node="n1"), _item(100, node="n2")]
        asyncio.run(guest_created.fill(client, items))
        assert client.asked == [
            "/nodes/n1/qemu/100/config",
            "/nodes/n2/qemu/100/config",
        ]

    def test_cached_does_not_fetch(self) -> None:
        assert guest_created.cached("c1", "pve", 4242, "qemu") is None
        assert guest_created._cache == {}


class TestClear:
    def test_clear_drops_everything(self) -> None:
        guest_created._cache[guest_created.cache_key("c1", "pve", 100, "qemu")] = (
            float("inf"),
            CTIME,
        )
        guest_created.clear()
        assert guest_created.cached("c1", "pve", 100, "qemu") is None


class TestPanelRecord:
    """面板记录优先于 PVE 的 ``meta`` —— 克隆 / 恢复出来的机器靠它才对。"""

    def test_record_beats_inherited_meta(self, monkeypatch) -> None:
        """克隆场景：PVE 的 meta 是模板的时间，面板记录才是实际创建时间。

        实测 pve9 上克隆出来的 104：``meta`` 完全等于模板的（连
        ``creation-qemu=9.2.0`` 都是模板的版本号），而克隆实际发生在几天后。
        """
        template_ctime = 1789814562  # 2026-09-19 18:42:42（模板的时间）
        clone_ctime = template_ctime + 9 * 86400 + 4321  # 克隆实际发生的时刻

        async def records(_conn_id: str = "") -> Dict[str, int]:
            return {guest_created.cache_key("c1", "pve", 104, "qemu"): clone_ctime}

        monkeypatch.setattr(guest_created, "_records_for", records)
        client = _FakeClient(
            {104: {"meta": f"creation-qemu=9.2.0,ctime={template_ctime}"}}
        )
        items = [_item(104)]
        asyncio.run(guest_created.fill(client, items))
        assert items[0]["created"] == clone_ctime
        assert client.asked == [], "有面板记录就不该再去读 config"

    def test_record_seeds_cache_and_forget_clears(self) -> None:
        """record() 顺手写缓存（不必等 PVE 写出 meta），forget() 立刻失效。

        这里刻意不接数据库：落库失败也要保证这一个进程立刻能显示正确日期，
        所以缓存写在落库之前。
        """
        asyncio.run(
            guest_created.record("c1", "pve", 200, "qemu", when=CTIME, source="create")
        )
        assert guest_created.cached("c1", "pve", 200, "qemu") == CTIME

        guest_created.forget("c1", "pve", 200, "qemu")
        assert guest_created.cached("c1", "pve", 200, "qemu") is None

    def test_resolve_prefers_record_then_meta(self, monkeypatch) -> None:
        """详情页：面板记录优先；没有记录才用 config 里的 meta。"""
        key = guest_created.cache_key("c1", "pve", 104, "qemu")

        async def records(_conn_id: str = "") -> Dict[str, int]:
            return {key: CTIME + 100}

        monkeypatch.setattr(guest_created, "_records_for", records)
        config = {"meta": f"ctime={CTIME}"}
        assert asyncio.run(
            guest_created.resolve("c1", "pve", 104, "qemu", config)
        ) == CTIME + 100

        async def none(_conn_id: str = "") -> Dict[str, int]:
            return {}

        monkeypatch.setattr(guest_created, "_records_for", none)
        assert asyncio.run(
            guest_created.resolve("c1", "pve", 105, "qemu", config)
        ) == CTIME
        assert asyncio.run(
            guest_created.resolve("c1", "pve", 106, "qemu", {"cores": 2})
        ) is None


class TestBackfillGuard:
    """审计回填的两条硬性前提 —— 缺一条就该保持「—」而不是编一个日期。"""

    def test_skips_when_there_is_no_meta(self) -> None:
        """没有 meta 时不回填。

        实测踩到过：pve9/101 今天新建的**容器**被回填成了昨天那台**虚拟机**的
        建机时间 —— 审计 target 只有「节点/VMID」，VMID 复用时分不清是哪一台。
        没有 meta 就没有任何证据说明那条审计属于当前这台机器。
        """
        assert asyncio.run(
            guest_created._backfill_from_audit("c1", "pve", 101, "lxc", None)
        ) is None
        # 也不标记「问过了」：等 PVE 补上 meta（克隆场景）之后还能再纠正一次
        assert guest_created.cache_key("c1", "pve", 101, "lxc") not in guest_created._backfilled

    def test_requires_a_unique_node_name(self, monkeypatch) -> None:
        """同名节点分不清属于哪台 PVE，宁可不填（填错日期比空着更糟）。"""

        async def counts() -> Dict[str, int]:
            return {"pve": 2}

        monkeypatch.setattr(guest_created, "_node_names_are_unique", counts)
        assert asyncio.run(
            guest_created._backfill_from_audit("c1", "pve", 104, "qemu", CTIME)
        ) is None


class TestEviction:
    """VMID 会被回收：本轮列表里已经不存在的机器，旧值不能留。"""

    def test_stale_value_is_dropped(self) -> None:
        stale_key = guest_created.cache_key("c1", "pve", 999, "qemu")
        guest_created._cache[stale_key] = (time.time() + 3600, CTIME)
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        asyncio.run(guest_created.fill(client, [_item(100)]))
        assert stale_key not in guest_created._cache

    def test_other_scopes_are_untouched(self) -> None:
        """只查 qemu 的一轮不该动容器的缓存；别的节点、别的连接也不动。"""
        keep = [
            guest_created.cache_key("c1", "pve", 999, "lxc"),
            guest_created.cache_key("c1", "other", 999, "qemu"),
            guest_created.cache_key("c2", "pve", 999, "qemu"),
        ]
        for key in keep:
            guest_created._cache[key] = (time.time() + 3600, CTIME)
        client = _FakeClient({100: {"meta": f"ctime={CTIME}"}})
        asyncio.run(guest_created.fill(client, [_item(100)]))
        for key in keep:
            assert key in guest_created._cache, f"{key} 不该被清掉"

    def test_miss_ttl_is_short(self) -> None:
        """「确认没有 meta」的缓存必须短：建机瞬间 PVE 可能还没写好 meta，
        长缓存会让这台机器长期显示「—」（实测踩到过）。"""
        assert guest_created.MISS_TTL_SECONDS <= 30 * 60
        assert guest_created.MISS_TTL_SECONDS > guest_created.ERROR_TTL_SECONDS
