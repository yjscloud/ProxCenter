"""「这次请求该读哪一条连接」的解析规则。

这组用例不连 PVE、不连数据库 —— 只验规则本身。它错了的后果很隐蔽：请求会静默
打到**另一套集群**上（电源操作打到同名节点上的同名机器、任务轮询永远转圈），
而报错来自很远的地方，很难顺藤摸瓜。

两个层次：

1. 请求级两级强度
   * 硬指定 ``X-PVE-Connection`` —— 调用点明确知道机器在哪条连接上，谁都别改；
   * 软作用域 ``X-PVE-Scope`` —— 顶栏「集群作用域」，只决定列表类接口读哪一套，
     按节点 / VMID 能定位到别处时允许被覆盖。
2. ``store.get_active_connection_id()`` —— 未指定任何作用域时的兜底连接指针，
   必须是**真实存在**的连接。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import store, vm_scope  # noqa: E402
from app.pve import (  # noqa: E402
    ProxmoxError,
    bound_connection,
    requested_connection,
    set_request_connection,
    set_request_scope,
)
from starlette.requests import Request  # noqa: E402


def _request(query: str = "") -> Request:
    """最小可用的 Request：只需要 query_params，别的字段这里用不到。"""
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/vms/pve1/100/owner",
            "query_string": query.encode(),
            "headers": [],
        }
    )


class TestRequestConnectionScope:
    """两级强度：读数据按硬的或软的，按节点 / VMID 自动定位只看硬的。

    若把软作用域也当成硬指定，``vm_scope.bind_*`` 会以为自己被显式指定过而放弃
    纠正 —— 作用域是 A 时点开 B 上的机器，请求会打到 A（同名机器上执行电源操作），
    任务轮询则永远转圈。
    """

    def teardown_method(self) -> None:
        # ContextVar 是全局的且会跨用例留存：每个用例跑完必须清干净
        set_request_connection("")
        set_request_scope("")

    def test_scope_alone_is_not_a_hard_binding(self) -> None:
        set_request_scope("conn-b")
        assert requested_connection() == "conn-b"
        assert bound_connection() == ""

    def test_hard_connection_wins_over_scope(self) -> None:
        set_request_scope("conn-b")
        set_request_connection("conn-a")
        assert requested_connection() == "conn-a"
        assert bound_connection() == "conn-a"

    def test_clearing_scope_means_no_connection_at_all(self) -> None:
        set_request_scope("conn-b")
        set_request_scope("")
        assert requested_connection() == ""
        assert bound_connection() == ""


class TestActiveConnectionPointer:
    """兜底连接指针必须给出真实存在的连接 id。

    调用点常拿它拼归属 ref（``<连接>:<节点>:<vmid>``）与缓存 key：一个已删除的 id
    会让归属记录整片对不上（普通用户的列表直接变空），而「按 id 取」与「按连接取」
    给出不同答案更难排查。
    """

    @staticmethod
    def _fake_settings(monkeypatch: pytest.MonkeyPatch, values: Dict[str, str]) -> None:
        """把「读设置」换成内存字典，绕开数据库。"""
        monkeypatch.setattr(store, "_read_setting_raw", lambda key: values.get(key, ""))

    def test_valid_pointer_is_used_as_is(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._fake_settings(
            monkeypatch,
            {
                store.CONNECTIONS_KEY: '[{"id": "a"}, {"id": "b"}]',
                store.ACTIVE_ID_KEY: "b",
            },
        )
        assert store.get_active_connection_id() == "b"

    def test_missing_pointer_falls_back_to_first(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """老库没写过 ACTIVE_ID_KEY：真正生效的是第一条，就报第一条。"""
        self._fake_settings(
            monkeypatch, {store.CONNECTIONS_KEY: '[{"id": "a"}, {"id": "b"}]'}
        )
        assert store.get_active_connection_id() == "a"

    def test_deleted_pointer_falls_back_to_first(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._fake_settings(
            monkeypatch,
            {
                store.CONNECTIONS_KEY: '[{"id": "a"}, {"id": "b"}]',
                store.ACTIVE_ID_KEY: "gone",
            },
        )
        assert store.get_active_connection_id() == "a"

    def test_no_connections_returns_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._fake_settings(monkeypatch, {store.CONNECTIONS_KEY: "[]"})
        assert store.connection_ids() == []
        assert store.get_active_connection_id() == ""

    def test_legacy_single_connection_is_recognised(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """升级兼容：还没有多连接列表时，旧的单份配置就是唯一那条连接。"""
        self._fake_settings(
            monkeypatch, {store.CONNECTION_KEY: '{"host": "pve.example"}'}
        )
        assert store.connection_ids() == ["default"]
        assert store.get_active_connection_id() == "default"


class TestBindingOverridesSoftScope:
    """按节点 / VMID 定位到的连接必须能**覆盖**顶栏的软作用域。

    这一环出错的表现很隐蔽：作用域是 A 时打开 B 上的机器，请求会落到 A（电源操作
    打到 A 上的同名机器、快照列错、任务轮询永远转圈），而报错来自很远的地方。
    所以这里逐条钉住三个 bind 入口：软作用域下必须去推断，硬指定下必须原地不动。
    """

    _UPID = "UPID:pve1:0000A1B2:00C3D4E5:65F00001:qmstart:100:root@pam:"

    def teardown_method(self) -> None:
        set_request_connection("")
        set_request_scope("")

    def test_vm_binding_overrides_soft_scope(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _resolve(node: str, vmid: Any, owner: Optional[str]) -> str:
            return "conn-b"

        monkeypatch.setattr(vm_scope, "resolve_vm_connection", _resolve)

        async def _scenario() -> tuple:
            set_request_scope("conn-a")
            await vm_scope.bind_vm_connection(node="pve1", vmid=100, user={})
            return bound_connection(), requested_connection()

        # 断言必须在同一协程里读：asyncio.run 会复制上下文，协程里 set 的值
        # 不会回写到外层（这正是后端为什么能在同一请求内安全地覆盖连接）
        assert asyncio.run(_scenario()) == ("conn-b", "conn-b")

    def test_node_binding_overrides_soft_scope(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _resolve(node: str) -> str:
            return "conn-b"

        monkeypatch.setattr(vm_scope, "resolve_node_connection", _resolve)

        async def _scenario() -> str:
            set_request_scope("conn-a")
            await vm_scope.bind_node_connection("pve1")
            return bound_connection()

        assert asyncio.run(_scenario()) == "conn-b"

    def test_task_binding_overrides_soft_scope(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def _resolve(upid: str, node: str, owner: Optional[str]) -> str:
            return "conn-b"

        monkeypatch.setattr(vm_scope, "resolve_task_connection", _resolve)

        async def _scenario() -> str:
            set_request_scope("conn-a")
            await vm_scope.bind_task_connection(upid=self._UPID, node="pve1", user={})
            return bound_connection()

        assert asyncio.run(_scenario()) == "conn-b"

    def test_hard_connection_is_left_untouched(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """硬指定（创建向导选了目标主机、详情页带了 ?connection=）时不许被改写。"""

        async def _never(node: str, vmid: Any, owner: Optional[str]) -> str:
            raise AssertionError("硬指定了连接，不该再去推断")

        monkeypatch.setattr(vm_scope, "resolve_vm_connection", _never)

        async def _scenario() -> str:
            set_request_connection("conn-a")
            await vm_scope.bind_vm_connection(node="pve1", vmid=100, user={})
            return bound_connection()

        assert asyncio.run(_scenario()) == "conn-a"

    def test_query_connection_hint_skips_inference(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``?connection_id=`` 与硬指定同义：调用方已知机器在哪，别再推断。

        归属读写接口就是这样发请求的。以前这里会忽略查询参数、照样按节点 /
        VMID 推断 —— 而存量机器没有归属记录，推断必然落到「逐台 PVE 探测」，
        批量指派时每台都要把所有连接串行问一遍，是明显卡顿的来源。
        """

        async def _never(node: str, vmid: Any, owner: Optional[str]) -> str:
            raise AssertionError("请求已经带了 connection_id，不该再去推断")

        monkeypatch.setattr(vm_scope, "resolve_vm_connection", _never)

        async def _scenario() -> str:
            set_request_scope("conn-a")
            await vm_scope.bind_vm_connection(
                node="pve1", vmid=100, user={}, request=_request("connection_id=conn-b")
            )
            return bound_connection()

        assert asyncio.run(_scenario()) == "conn-b"

    def test_blank_connection_hint_falls_back_to_inference(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """空的 ``?connection_id=`` 不算指定（与 ``X-PVE-Connection`` 的空串同义）。"""

        async def _resolve(node: str, vmid: Any, owner: Optional[str]) -> str:
            return "conn-b"

        monkeypatch.setattr(vm_scope, "resolve_vm_connection", _resolve)

        async def _scenario() -> str:
            await vm_scope.bind_vm_connection(
                node="pve1", vmid=100, user={}, request=_request("connection_id=")
            )
            return bound_connection()

        assert asyncio.run(_scenario()) == "conn-b"

    def test_unresolvable_connection_keeps_the_scope(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """推断不出来时保持原样：作用域退化成「就读它」，由 get_client 兜底。"""

        async def _resolve(node: str, vmid: Any, owner: Optional[str]) -> str:
            return ""

        monkeypatch.setattr(vm_scope, "resolve_vm_connection", _resolve)

        async def _scenario() -> tuple:
            set_request_scope("conn-a")
            await vm_scope.bind_vm_connection(node="pve1", vmid=100, user={})
            return bound_connection(), requested_connection()

        assert asyncio.run(_scenario()) == ("", "conn-a")


class _ProbeClient:
    """假的 PVE 客户端：``answer`` 决定「有这台机器 / 没有 / 连不上」。

    三种应答的语义差别正是探测缓存的判据 —— ProxmoxError 表示 PVE 应答过
    （问过了，没有），其它异常表示根本没问成（网络问题），后者不能拿来当结论。
    """

    def __init__(self, answer: Any, calls: List[str], delay: float = 0.0) -> None:
        self._answer = answer
        self._calls = calls
        self._delay = delay

    async def get(self, path: str) -> Any:
        self._calls.append(path)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._answer == "down":
            raise RuntimeError("connection refused")
        if self._answer:
            return {"status": "running"}
        raise ProxmoxError("不存在", status_code=404, pve_status=404)


class TestProbeCaching:
    """逐台 PVE 探测的缓存与去重。

    存量机器没有归属记录，探测是「定位连接」的唯一手段；它要发几轮串行 HTTPS 请求。
    所以这里有两条硬要求：

    * 探过的结论要记住 —— 命中与「确实没有」都一样，否则批量指派 / 详情页的每个
      请求都要把全部连接重问一遍；
    * 同一台机器的并发请求只探一轮 —— 详情页挂载时十几个请求同时到，各探各的会把
      延迟叠加成 N 倍。

    但「全都连不上」不能记成「没有」：那会把 PVE 抖动放大成十几秒的全面 404。
    """

    def teardown_method(self) -> None:
        # 缓存与锁是模块级的：跨用例留存会让「这次探了几轮」的断言失去意义，
        # 锁还会绑在上一个（已关闭的）事件循环上。
        vm_scope._probe_cache.clear()
        vm_scope._probe_locks.clear()

    @staticmethod
    def _fake_clients(
        monkeypatch: pytest.MonkeyPatch, *answers: Any, delay: float = 0.0
    ) -> List[str]:
        calls: List[str] = []
        profiles = [
            ({"id": f"conn-{chr(ord('a') + i)}"}, _ProbeClient(answer, calls, delay))
            for i, answer in enumerate(answers)
        ]
        monkeypatch.setattr(vm_scope, "all_connection_clients", lambda: profiles)
        return calls

    def test_hit_is_cached_and_skips_the_second_round(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = self._fake_clients(monkeypatch, False, True)

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == "conn-b"
        probed = len(calls)
        assert probed == 2  # conn-a 回 404，conn-b 命中

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == "conn-b"
        assert len(calls) == probed, "命中的结论没有再走一遍探测"

    def test_miss_is_cached_but_for_a_shorter_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = self._fake_clients(monkeypatch, False, False)

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        audited = len(calls)
        assert audited == 4  # 两条连接 × qemu / lxc

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        assert len(calls) == audited, "「确实没有」也要缓存，否则批量指派退化成平方级"

        # 机器可能是刚建的：过期时间比命中短，但仍然会过期
        vm_scope._probe_cache[("pve1", 100)] = (
            time.time() - vm_scope._PROBE_MISS_TTL - 1,
            "",
        )
        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        assert len(calls) == audited + 4, "过期的空结论要重新探"

    def test_unreachable_connections_are_not_recorded_as_a_miss(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = self._fake_clients(monkeypatch, "down", "down")

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        assert vm_scope._probe_cache == {}, "一台都没应答，不能缓存「没有」"

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        assert len(calls) == 8, "下次请求要重新探（PVE 恢复后应当立刻能定位到）"

    def test_one_unanswered_connection_still_proves_a_miss(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """只要有一条连接应答过 404，就足以断定「这台机器不在这里」。"""

        self._fake_clients(monkeypatch, "down", False)

        assert asyncio.run(vm_scope._probe_connection("pve1", 100)) == ""
        assert vm_scope._probe_cache.get(("pve1", 100), ("", "x"))[1] == ""

    def test_concurrent_requests_share_one_probe(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = self._fake_clients(monkeypatch, True, delay=0.02)

        async def _scenario() -> List[str]:
            return await asyncio.gather(
                *(vm_scope._probe_connection("pve1", 100) for _ in range(6))
            )

        assert asyncio.run(_scenario()) == ["conn-a"] * 6
        assert len(calls) == 1, f"6 个并发请求探了 {len(calls)} 轮"
