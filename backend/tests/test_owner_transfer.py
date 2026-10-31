"""归属变更（指派 / 收回 / 删号）的连带动作。

指派过去只改 ``resource_owner`` 里的一行，于是留下三处「安全信息不同步」：

* 快照归属标记还固化在前任名下（读取侧是「标记优先」，那批快照就仍算前任的）；
* 按人分档的读缓存（仪表盘 / 快照汇总 / 备份统计 / 额度）还是旧账，TTL 10–60 秒；
* 审计里只有「改成了谁」，没有「原来是谁」——覆盖式 upsert 之后再也查不到。

本文件盯的就是这三件事，以及删号时把归属账一并清掉。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ownership, pvecache, quota  # noqa: E402

CONN, NODE, VMID = "conn-1", "pve1", 100


async def _with_pool(coro):
    """跑完协程顺手关掉连接池（它绑在 ``asyncio.run`` 新建的循环上）。"""
    from app import database

    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_with_pool(coro))


@pytest.fixture()
def owner_db(clean_mysql_db):
    _run(ownership.init_table())
    yield


def _guest_ref() -> str:
    return ownership.vm_ref(CONN, NODE, VMID)


class TestTransferGuest:
    def test_snapshot_markers_follow_the_machine(self, owner_db) -> None:
        ref = _guest_ref()
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{ref}/snap1", "alice"))
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{ref}/snap2", "alice"))
        # 别人的快照标记不能被顺手清掉
        other = ownership.vm_ref(CONN, NODE, 200)
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{other}/snap1", "carol"))

        result = _run(ownership.transfer_guest(ownership.KIND_VM, ref, "bob"))

        assert result["previous"] == "alice"
        assert result["owner"] == "bob"
        assert result["snapshots_removed"] == 2
        assert _snapshot_refs() == {f"{other}/snap1"}
        assert _run(ownership.get_owner(ownership.KIND_VM, ref)) == "bob"

    def test_legacy_dash_prefixed_markers_are_removed_too(self, owner_db) -> None:
        """单连接时代的记录前缀是 ``-``：只认完整 ref 会漏掉这批标记。"""
        legacy_guest = ownership.vm_ref("", NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, legacy_guest, "alice"))
        _run(
            ownership.set_owner(
                ownership.KIND_SNAPSHOT, f"{legacy_guest}/snap1", "alice"
            )
        )

        _run(ownership.transfer_guest(ownership.KIND_VM, _guest_ref(), "bob"))

        assert _snapshot_refs() == set()

    def test_container_legacy_kind_vm_row_is_dropped(self, owner_db) -> None:
        """升级前容器的归属记在 KIND_VM 下：只动 KIND_CT 会留下一条幽灵记录。"""
        ref = _guest_ref()
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))

        result = _run(ownership.transfer_guest(ownership.KIND_CT, ref, "bob"))

        assert result["previous"] == "alice"
        assert _run(ownership.get_owner(ownership.KIND_VM, ref)) is None
        assert _run(ownership.get_owner(ownership.KIND_CT, ref)) == "bob"

    def test_unassign_clears_snapshot_markers(self, owner_db) -> None:
        ref = _guest_ref()
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{ref}/snap1", "alice"))

        result = _run(ownership.transfer_guest(ownership.KIND_VM, ref, ""))

        assert result["owner"] == ""
        assert _run(ownership.get_owner(ownership.KIND_VM, ref)) is None
        assert _snapshot_refs() == set()

    def test_scoped_caches_are_dropped(self, owner_db, monkeypatch) -> None:
        """不准主动作废的话，改派后 10–60 秒里新旧主人看到的都是旧账。"""
        calls: list = []
        monkeypatch.setattr(quota, "invalidate", lambda: calls.append("quota"))
        key = "dashboard:summary:qemu:conn-1:alice:alice"
        asyncio.run(pvecache.cached(key, 60, _const(1)))
        assert pvecache.peek(key) == 1

        _run(ownership.transfer_guest(ownership.KIND_VM, _guest_ref(), "bob"))

        assert pvecache.peek(key) is None
        assert calls == ["quota"]


class TestTransferHost:
    def test_previous_owner_is_reported(self, owner_db) -> None:
        _run(ownership.set_owner(ownership.KIND_SSH_HOST, "host-1", "alice"))

        result = _run(ownership.transfer_host("host-1", "bob"))

        assert result == {"previous": "alice", "owner": "bob"}
        assert _run(ownership.get_owner(ownership.KIND_SSH_HOST, "host-1")) == "bob"

    def test_first_assignment_has_no_previous(self, owner_db) -> None:
        assert _run(ownership.transfer_host("host-2", "bob"))["previous"] == ""


class TestForgetUser:
    def test_removes_only_that_users_rows(self, owner_db) -> None:
        ref = _guest_ref()
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{ref}/snap1", "alice"))
        _run(ownership.set_owner(ownership.KIND_SSH_HOST, "host-1", "alice"))
        _run(ownership.set_owner(ownership.KIND_VM, ownership.vm_ref(CONN, NODE, 200), "bob"))

        removed = _run(ownership.forget_user("alice"))

        assert removed == 3
        assert _run(ownership.get_owner(ownership.KIND_VM, ref)) is None
        assert _run(ownership.get_owner(ownership.KIND_VM, ownership.vm_ref(CONN, NODE, 200))) == "bob"

    def test_empty_username_is_a_noop(self, owner_db) -> None:
        assert _run(ownership.forget_user("")) == 0


# --------------------------------------------------------------------- 小工具
def _const(value):
    async def factory():
        return value

    return factory


def _snapshot_refs() -> set:
    async def read() -> set:
        from app import database

        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT ref FROM resource_owner WHERE kind = ?",
                (ownership.KIND_SNAPSHOT,),
            )
            return {str(row[0]) for row in await cursor.fetchall()}

    return _run(read())
