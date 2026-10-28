"""任务归属判定（``app.task_scope``）：三条任务出口共用的那套规则。

为什么单独测这个模块：``/api/tasks``、``/api/cluster/tasks`` 与 ``/ws/tasks`` 都以它
为准，判定写错一处就是三个入口一起漏。这里是纯函数级的用例，不需要数据库。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import task_scope  # noqa: E402
from app.task_scope import TaskScope, task_guest  # noqa: E402


def _upid(node: str, vmid: object, kind: str = "qm") -> str:
    """拼一条客户机级 UPID：``qmstart`` / ``vzstart`` 带 vmid。"""
    return f"UPID:{node}:000A1B2C:0:1700000000:{kind}start:{vmid}:root@pam:"


def test_task_guest_only_for_guest_tasks() -> None:
    assert task_guest(_upid("pve", 105)) == ("pve", "105")
    assert task_guest(_upid("pve", 200, "vz")) == ("pve", "200")
    # 节点级任务没有归属可判，一律不外发
    assert task_guest("UPID:pve:001:0:1700000000:aptupdate::root@pam:") is None
    assert task_guest("UPID:pve:001:0:1700000000:cephcreateosd:1:root@pam:") is None
    assert task_guest("garbage") is None


def test_owner_sees_only_his_guest() -> None:
    scope = TaskScope(owned={"c1": {("pve", "105")}})
    assert scope.allows("c1", _upid("pve", 105))
    assert not scope.allows("c1", _upid("pve", 106))
    # 另一条连接上的同名节点 + 同 vmid 不能借道（多 PVE 合并展示时的经典串台）
    assert not scope.allows("c2", _upid("pve", 105))


def test_legacy_ref_matches_any_connection() -> None:
    """升级前记录的 ref 前缀是 ``-``，无法判断连接，按通配处理。"""
    scope = TaskScope(owned={}, legacy={("pve", "105")})
    assert scope.allows("c1", _upid("pve", 105))
    assert scope.allows("c2", _upid("pve", 105))
    assert not scope.allows("c1", _upid("pve", 106))


def test_missing_connection_falls_back_to_any() -> None:
    """调用方没给连接（单连接部署）时按「任一连接名下」判定。"""
    scope = TaskScope(owned={"c1": {("pve", "105")}})
    assert scope.allows("", _upid("pve", 105))
    assert not scope.allows("", _upid("pve", 106))


def test_non_guest_task_hidden() -> None:
    scope = TaskScope(owned={"c1": {("pve", "105")}})
    assert not scope.allows("c1", "UPID:pve:001:0:1:aptupdate::root@pam:")


def test_region_admin_scope(monkeypatch) -> None:
    monkeypatch.setattr(
        task_scope.store,
        "connection_region",
        lambda cid: {"c1": "east", "c2": "west", "": ""}.get(str(cid), ""),
    )
    scope = TaskScope(regions=["east"])
    assert scope.allows("c1", _upid("pve", 105))
    assert not scope.allows("c2", _upid("pve", 105))
    # 未分区的连接不归任何区域管理员
    assert not scope.allows("", _upid("pve", 105))


def test_filter_uses_item_connection_id() -> None:
    """合并列表里的连接来自 ``_flatten_scoped`` 打的 ``connection_id``。"""
    scope = TaskScope(owned={"c1": {("pve", "105")}})
    items = [
        {"upid": _upid("pve", 105), "connection_id": "c1"},
        {"upid": _upid("pve", 105), "connection_id": "c2"},
        {"upid": _upid("pve", 106), "connection_id": "c1"},
    ]
    kept = scope.filter(items)
    assert [t["connection_id"] for t in kept] == ["c1"]


def test_admin_scope_is_unrestricted() -> None:
    assert asyncio.run(task_scope.build_scope({"role": "admin", "username": "root"})) is None


def test_region_admin_scope_from_user_row() -> None:
    scope = asyncio.run(
        task_scope.build_scope(
            {"role": "region_admin", "username": "ra", "regions": ["east"]}
        )
    )
    assert scope is not None
    assert scope.regions == ["east"]
