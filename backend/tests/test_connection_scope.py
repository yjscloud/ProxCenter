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
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import store, vm_scope  # noqa: E402
from app.pve import (  # noqa: E402
    bound_connection,
    requested_connection,
    set_request_connection,
    set_request_scope,
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
