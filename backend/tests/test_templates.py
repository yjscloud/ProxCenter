"""/api/templates/vztmpl 的回归：**同一个卷只能出一条**。

背景：这个端点按「节点 × 存储」枚举容器系统模板（vztmpl 文件）。共享存储
（CephFS / NFS 这类）从每个节点看都是同一份内容，不去重就会把同一个模板列 N 遍、
只有节点名不同 —— 界面上表现为「同一个 centos-9 出现了 3 次」。

反向约束同样重要，而且是这个修复最容易做坏的地方：**节点本地存储上同名的两个
文件是两份不同的文件**，不能因为 volid 相同就被合并成一个（`local` 上把同一个
发行版钉在两个节点上是很常见的做法）。这也是「卷的标识里要不要带节点」必须
取决于存储是不是共享的原因。

这些用例直接调用端点函数并注入假客户端，不需要起 app、也不需要动
``test_pve_client`` 里那份共享的 PVE mock 夹具。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app.routers import templates as templates_router  # noqa: E402


class _FakeClient:
    """只实现这个端点用到的三个读接口。"""

    def __init__(self, nodes, storages, volumes):
        self._nodes = nodes
        self._storages = storages  # {节点: [存储 dict, ...]}
        self._volumes = volumes  # {存储名: [文件名, ...]}
        #: 记下每个存储被读了几次 —— 共享存储只该读一次
        self.content_calls: list = []

    async def nodes(self):
        return [{"node": name} for name in self._nodes]

    async def storages(self, node):
        return self._storages.get(node, [])

    async def storage_content(self, node, storage, content=None):
        self.content_calls.append((node, storage))
        return [
            {"volid": f"{storage}:vztmpl/{name}", "size": 100_000_000}
            for name in self._volumes.get(storage, [])
        ]


def _storage(name, *, shared, content="vztmpl"):
    return {"storage": name, "shared": 1 if shared else 0, "content": content}


def _list(client, monkeypatch, profile=None):
    """跑一次端点，客户端换成假的（依赖注入的参数直接给 user）。"""
    monkeypatch.setattr(
        templates_router, "all_connection_clients", lambda: [(profile, client)]
    )
    return asyncio.run(templates_router.list_ct_system_templates(user={}))


def _profile(conn_id="conn-1", name="PVE 1"):
    return {"id": conn_id, "name": name}


class TestSharedStorageIsDeduplicated:
    """共享存储：同一个卷从每个节点看都是同一份，只出一条。"""

    def test_cephfs_volume_appears_once_across_three_nodes(self, monkeypatch) -> None:
        client = _FakeClient(
            nodes=["node01", "node02", "node03"],
            storages={
                node: [_storage("cephfs", shared=True)]
                for node in ("node01", "node02", "node03")
            },
            volumes={"cephfs": ["centos-9-stream-default.tar.zst"]},
        )

        rows = _list(client, monkeypatch, _profile())

        # 修复前这里是 3 条（只有 node 不同），正是界面上重复显示的那个 bug
        assert len(rows) == 1
        assert rows[0]["volid"] == "cephfs:vztmpl/centos-9-stream-default.tar.zst"
        assert rows[0]["shared"] is True
        # 共享存储扫一次就够，不必再向 PVE 问两遍
        assert client.content_calls == [("node01", "cephfs")]

    def test_local_volumes_on_different_nodes_are_both_kept(
        self, monkeypatch
    ) -> None:
        """节点本地存储：volid 相同只是同名，是两份不同的文件，都要留。"""
        client = _FakeClient(
            nodes=["node01", "node02"],
            storages={
                "node01": [_storage("local", shared=False)],
                "node02": [_storage("local", shared=False)],
            },
            volumes={"local": ["centos-9-stream-default.tar.zst"]},
        )

        rows = _list(client, monkeypatch, _profile())

        assert len(rows) == 2
        assert {r["node"] for r in rows} == {"node01", "node02"}
        assert all(r["shared"] is False for r in rows)
        # 本地存储各扫各的，不能互相顶掉
        assert client.content_calls == [("node01", "local"), ("node02", "local")]

    def test_shared_and_local_do_not_collapse_each_other(self, monkeypatch) -> None:
        """两种存储上的同名文件是两份东西（volid 前缀不同），都要留。"""
        client = _FakeClient(
            nodes=["node01", "node02"],
            storages={
                "node01": [_storage("local", shared=False), _storage("cephfs", shared=True)],
                "node02": [_storage("cephfs", shared=True)],
            },
            volumes={
                "local": ["centos-9-stream-default.tar.zst"],
                "cephfs": ["centos-9-stream-default.tar.zst"],
            },
        )

        rows = _list(client, monkeypatch, _profile())

        assert {r["volid"] for r in rows} == {
            "local:vztmpl/centos-9-stream-default.tar.zst",
            "cephfs:vztmpl/centos-9-stream-default.tar.zst",
        }

    def test_same_volid_on_two_connections_is_kept_for_both(
        self, monkeypatch
    ) -> None:
        """两台 PVE 上同名共享存储 + 同名模板：是两台集群各自的模板，都要留。"""
        shared_storages = {"node01": [_storage("cephfs", shared=True)]}
        volumes = {"cephfs": ["centos-9-stream-default.tar.zst"]}

        first = _FakeClient(["node01"], shared_storages, volumes)
        monkeypatch.setattr(
            templates_router,
            "all_connection_clients",
            lambda: [
                (_profile("conn-1", "PVE 1"), first),
                (_profile("conn-2", "PVE 2"), _FakeClient(["node01"], shared_storages, volumes)),
            ],
        )

        rows = asyncio.run(templates_router.list_ct_system_templates(user={}))

        assert len(rows) == 2
        assert {r["connection_id"] for r in rows} == {"conn-1", "conn-2"}

    def test_failed_shared_read_is_retried_on_the_next_node(self, monkeypatch) -> None:
        """某个节点上读失败不能把整个存储标记成「已扫过」—— 换个节点还有机会。"""
        from app.pve import ProxmoxError

        class _Flaky(_FakeClient):
            async def storage_content(self, node, storage, content=None):
                self.content_calls.append((node, storage))
                if node == "node01":
                    raise ProxmoxError("读不到", 500)
                return [
                    {"volid": f"{storage}:vztmpl/centos-9.tar.zst", "size": 1}
                ]

        client = _Flaky(
            nodes=["node01", "node02"],
            storages={
                "node01": [_storage("cephfs", shared=True)],
                "node02": [_storage("cephfs", shared=True)],
            },
            volumes={},
        )

        rows = _list(client, monkeypatch, _profile())

        assert len(rows) == 1
        assert rows[0]["node"] == "node02"
        assert client.content_calls == [("node01", "cephfs"), ("node02", "cephfs")]

    def test_storages_without_vztmpl_content_are_skipped(self, monkeypatch) -> None:
        """只有内容类型含 vztmpl 的存储才去问 —— 别的池上不可能有容器模板。"""
        client = _FakeClient(
            nodes=["node01"],
            storages={
                "node01": [
                    _storage("local-lvm", shared=False, content="images,rootdir"),
                    _storage("local", shared=False),
                ]
            },
            volumes={"local": ["rocky-9.tar.xz"]},
        )

        rows = _list(client, monkeypatch, _profile())

        assert [r["storage"] for r in rows] == ["local"]
        assert client.content_calls == [("node01", "local")]

    def test_nodes_without_a_name_are_skipped(self, monkeypatch) -> None:
        """节点名取不到就跳过，别拿空字符串去拼请求路径。"""
        client = _FakeClient(
            nodes=["node01"],
            storages={"node01": [_storage("local", shared=False)]},
            volumes={"local": ["rocky-9.tar.xz"]},
        )
        client._nodes = ["", "node01"]

        rows = _list(client, monkeypatch, _profile())

        assert len(rows) == 1
        assert client.content_calls == [("node01", "local")]


class TestResponseShape:
    """返回字段：前端卡片/表格/「新建容器」预选都依赖这几项。"""

    def test_item_fields(self, monkeypatch) -> None:
        client = _FakeClient(
            nodes=["node01"],
            storages={"node01": [_storage("local", shared=False)]},
            volumes={"local": ["rocky-9-default.tar.xz"]},
        )

        (row,) = _list(client, monkeypatch, _profile("conn-1", "PVE 1"))

        assert row == {
            "node": "node01",
            "storage": "local",
            "volid": "local:vztmpl/rocky-9-default.tar.xz",
            # name 是 volid 的最后一段：卡片标题、搜索都用它
            "name": "rocky-9-default.tar.xz",
            "size": 100_000_000,
            "ctime": None,
            "shared": False,
            "connection_id": "conn-1",
            "connection_name": "PVE 1",
        }

    def test_volid_without_a_slash_falls_back_to_itself(self, monkeypatch) -> None:
        """volid 形态异常时 name 兜回 volid，而不是崩在 split 上。"""

        class _Odd(_FakeClient):
            async def storage_content(self, node, storage, content=None):
                return [{"volid": "weird", "size": 1}]

        client = _Odd(
            nodes=["node01"],
            storages={"node01": [_storage("local", shared=False)]},
            volumes={},
        )

        (row,) = _list(client, monkeypatch, _profile())

        assert row["name"] == "weird"

    def test_sorted_by_connection_then_name(self, monkeypatch) -> None:
        """排序要稳定：同一条连接内按文件名，跨连接先按连接名。"""
        client = _FakeClient(
            nodes=["node01"],
            storages={"node01": [_storage("local", shared=False)]},
            volumes={"local": ["zebra.tar.zst", "alpha.tar.zst"]},
        )

        rows = _list(client, monkeypatch, _profile())

        assert [r["name"] for r in rows] == ["alpha.tar.zst", "zebra.tar.zst"]

    def test_no_connection_configured_yet(self, monkeypatch) -> None:
        """面板还没配连接：all_connection_clients 返回空，端点也不能炸。"""
        monkeypatch.setattr(templates_router, "all_connection_clients", lambda: [])
        monkeypatch.setattr(
            templates_router,
            "get_client",
            lambda: _FakeClient(
                ["node01"],
                {"node01": [_storage("local", shared=False)]},
                {"local": ["rocky-9.tar.xz"]},
            ),
        )

        rows = asyncio.run(templates_router.list_ct_system_templates(user={}))

        assert [r["name"] for r in rows] == ["rocky-9.tar.xz"]
