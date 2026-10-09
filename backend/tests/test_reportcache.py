"""巡检报告的缓存：命中、并发去重、以及「先看旧值 + 后台重扫」。

全平台体检不是读一份现成数据，而是**现场 SSH 每台主机**（几秒到几十秒），
首页工作台的待办却只想要一句「有没有不合格项」。所以缓存除了 TTL 命中之外，
还要能「拿旧值先应答、真扫放到后台」。这里验证的正是这几条边界：

* 命中缓存时不重扫；并发只跑一轮（不该让每台主机各开两条 SSH）；
* 过期后 :func:`get_or_scan` 会真扫，而 :func:`peek_stale` 仍给出旧值；
* :func:`refresh_later` 后台把值刷新成新的；**缓存还新鲜时它不该真扫** ——
  否则每次打开首页都排一轮后台巡检，等于没缓存。

用例不依赖 MySQL 与真实 SSH：``produce`` 是假函数。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import reportcache  # noqa: E402


@pytest.fixture(autouse=True)
def clean():
    reportcache.clear()
    yield
    reportcache.clear()


class _Counter:
    """记录真扫了几次的假巡检。"""

    def __init__(self, delay: float = 0.01) -> None:
        self.calls: List[int] = []
        self.delay = delay
        self.value = 0

    async def produce(self) -> Dict[str, Any]:
        self.calls.append(1)
        await asyncio.sleep(self.delay)
        self.value += 1
        return {"value": self.value, "generated_at": int(time.time())}


class TestGetOrScan:
    def test_cache_hit_does_not_rescan(self) -> None:
        counter = _Counter()
        key = reportcache.scope_key("baseline", None)
        payload, cached = asyncio.run(
            reportcache.get_or_scan(key, counter.produce)
        )
        assert cached is False
        assert len(counter.calls) == 1

        payload2, cached2 = asyncio.run(
            reportcache.get_or_scan(key, counter.produce)
        )
        assert cached2 is True
        assert len(counter.calls) == 1, "命中缓存就不该再扫一轮"
        assert payload2 == payload

    def test_concurrent_calls_scan_once(self) -> None:
        """两个人同时打开这一页：每台主机只该开一条 SSH。"""
        counter = _Counter(delay=0.05)
        key = reportcache.scope_key("baseline", {"h1"})

        async def main() -> None:
            await asyncio.gather(
                *(reportcache.get_or_scan(key, counter.produce) for _ in range(5))
            )

        asyncio.run(main())
        assert len(counter.calls) == 1

    def test_expired_entry_is_scanned_again(self) -> None:
        counter = _Counter()
        key = reportcache.scope_key("baseline", None)
        asyncio.run(reportcache.get_or_scan(key, counter.produce))
        # 把这条记录改成「很久以前写的」，模拟 TTL 已过
        stored_at, payload = reportcache._cache[key]
        reportcache._cache[key] = (stored_at - reportcache.TTL_SECONDS * 2, payload)

        _, cached = asyncio.run(reportcache.get_or_scan(key, counter.produce))
        assert cached is False
        assert len(counter.calls) == 2

    def test_scope_separates_namespace_and_hosts(self) -> None:
        """功能名与可见主机集合都进 key：串号会越权或 KeyError。"""
        assert reportcache.scope_key("baseline", None) != reportcache.scope_key(
            "ports", None
        )
        # None（不限）与空集合（一台都不可见）必须分开
        assert reportcache.scope_key("baseline", None) != reportcache.scope_key(
            "baseline", set()
        )


class TestStalePath:
    def test_peek_ignores_expired_but_peek_stale_does_not(self) -> None:
        counter = _Counter()
        key = reportcache.scope_key("baseline", None)
        payload, _ = asyncio.run(reportcache.get_or_scan(key, counter.produce))

        stored_at, value = reportcache._cache[key]
        reportcache._cache[key] = (stored_at - reportcache.TTL_SECONDS * 2, value)

        # 先取旧值再断言 peek：peek() 遇到过期条目会把它删掉（peek_stale 不会），
        # 顺序反了就会拿到 None —— 端点里 peek() or peek_stale() 正是这么踩的坑
        assert reportcache.peek_stale(key) == payload
        assert reportcache.peek(key) is None, "过期的不能当新鲜数据发出去"

    def test_peek_stale_respects_max_age(self) -> None:
        """报告页也走 stale 通路，但旧值有年龄上限。

        没有上限的话，进程起来后第一次巡检的结果会一直被当作现状端出来 —— 首页
        的待办只关心「有没有不合格项」，过时一点无所谓；报告页那一屏是要照着做
        处置的。超过上限时返回 None，调用方于是老实等一轮。
        """
        counter = _Counter()
        key = reportcache.scope_key("baseline", {"h1"})
        asyncio.run(reportcache.get_or_scan(key, counter.produce))
        stored_at, value = reportcache._cache[key]

        # 过了 TTL、但还在上限内：给
        reportcache._cache[key] = (stored_at - reportcache.TTL_SECONDS * 2, value)
        assert reportcache.peek_stale(key, reportcache.STALE_MAX_AGE) == value

        # 越过上限：不给，让调用方等一轮
        reportcache._cache[key] = (stored_at - reportcache.STALE_MAX_AGE - 60, value)
        assert reportcache.peek_stale(key, reportcache.STALE_MAX_AGE) is None
        # 不传上限（首页那条通路）时行为不变：仍然给
        assert reportcache.peek_stale(key) == value

    def test_refresh_later_updates_the_value(self) -> None:
        """先用旧值应答之后，后台那一轮要给下一次请求留下新结果。"""
        counter = _Counter(delay=0.01)
        key = reportcache.scope_key("baseline", None)
        old, _ = asyncio.run(reportcache.get_or_scan(key, counter.produce))

        stored_at, value = reportcache._cache[key]
        reportcache._cache[key] = (stored_at - reportcache.TTL_SECONDS * 2, value)
        assert reportcache.peek_stale(key) == old, "旧值要能先拿来应答"

        async def main() -> None:
            reportcache.refresh_later(key, counter.produce)
            # 等后台任务跑完（假巡检只有 10ms）。用 .get：重扫会先把过期条目删掉
            # 再写新的，中间那一瞬 _cache 里没有这个 key。
            for _ in range(50):
                await asyncio.sleep(0.01)
                hit = reportcache._cache.get(key)
                if hit and hit[1] != old:
                    return

        asyncio.run(main())
        assert reportcache._cache[key][1] != old, "后台重扫应当更新缓存"
        assert len(counter.calls) == 2

    def test_refresh_later_does_not_scan_when_cache_is_fresh(self) -> None:
        """缓存还新鲜时后台不该真扫 —— 否则每次打开首页都排一轮巡检。"""
        counter = _Counter(delay=0.01)
        key = reportcache.scope_key("baseline", None)
        asyncio.run(reportcache.get_or_scan(key, counter.produce))
        assert len(counter.calls) == 1

        async def main() -> None:
            reportcache.refresh_later(key, counter.produce)
            await asyncio.sleep(0.05)

        asyncio.run(main())
        assert len(counter.calls) == 1

    def test_refresh_later_swallows_errors(self) -> None:
        """后台任务炸了不能冒到事件循环里（首页只是少一条待办）。"""

        async def boom() -> Dict[str, Any]:
            raise RuntimeError("SSH 全挂了")

        key = reportcache.scope_key("baseline", None)
        reportcache.store(key, {"value": 0})

        async def main() -> None:
            reportcache.refresh_later(key, boom)
            await asyncio.sleep(0.05)

        asyncio.run(main())
        # 旧值还在，没被这次失败抹掉
        assert reportcache.peek_stale(key) == {"value": 0}
