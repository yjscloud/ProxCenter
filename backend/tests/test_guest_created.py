"""创建时间（PVE 写进 config 的 ``meta.ctime``）的解析与缓存。

覆盖三件最容易出错的事：

* ``meta`` 是 PVE 的「属性字符串」，里面既有版本号（``creation-qemu=9.2.0``）
  也有时间戳（``ctime=...``）—— 只认后者，且必须落在合理区间里；
* 缓存要能区分「这台机器确实没有 meta」与「这次没问到」：前者按 6 小时过期、
  后者按 5 分钟过期，但两种都**不能每轮轮询都重复去问 PVE**；
* 缓存键必须带连接与节点 —— 实测本机两台 PVE 上各有一个 ``vmid=100``，
  少一段就会把别人家的创建时间显示到这台机器上。

用例全部不碰数据库与真实 PVE（``_FakeClient`` 顶替），因此不依赖 MySQL。
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
def clean_cache():
    """模块级缓存跨用例共享，前后都清干净，避免互相串味。"""
    guest_created.clear()
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
        # 失败条目的过期时间明显早于「确认没有」的 6 小时
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
