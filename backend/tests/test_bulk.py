"""Unit tests for the bulk (batch) guest operations.

批量接口最容易出的不是「功能不对」，而是**分派错**和**越权**：

* 容器被当成虚拟机 → 打到 ``/qemu/{vmid}`` 上，PVE 返回 500；
* 批量端点里没有路径参数，路由级归属守卫不生效 → 一不留神就绕过了用户隔离；
* 一台失败把整批拖成 500 → 前端不知道到底动了几台。

这三件事在真机上都不好复现（要么要容器、要么要多用户、要么要造失败），
所以在这里用假客户端锁死。

    ../.venv/bin/python -m pytest tests/test_bulk.py -v
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from fastapi import HTTPException  # noqa: E402

from app import bulk, ownership, security, vm_scope  # noqa: E402
from app.pve import ProxmoxError  # noqa: E402
from app.schemas import BulkParams, BulkRequest, BulkTarget  # noqa: E402


def run(coro):
    """同步跑协程 —— 与 test_mailer / test_sshremote 同一套路，不引入额外插件。"""
    return asyncio.run(coro)


# ------------------------------------------------------------------- helpers
class FakeClient:
    """记录调用的假 PVE 客户端；只实现批量用到的那几个方法。"""

    def __init__(self, kind: str = "qemu", status: str = "stopped", tags: str = "") -> None:
        self.kind = kind
        self.status = status
        self.tags = tags
        self.calls: list = []

    async def get(self, path: str, **kwargs):
        self.calls.append(("GET", path))
        # 只有自己那种 guest 的路径命中，用来支撑 _detect_type
        if f"/{self.kind}/" in path:
            return {"status": self.status, "tags": self.tags}
        raise ProxmoxError("not found", 404)

    async def qemu_status(self, node, vmid):
        self.calls.append(("qemu_status", node, vmid))
        return {"status": self.status}

    async def lxc_status(self, node, vmid):
        self.calls.append(("lxc_status", node, vmid))
        return {"status": self.status}

    async def qemu_power(self, node, vmid, action, timeout=None, force_stop=False):
        self.calls.append(("qemu_power", node, vmid, action, timeout, force_stop))
        return "UPID:pve:1:1:1::start:"

    async def lxc_power(self, node, vmid, action, timeout=None, force_stop=False):
        self.calls.append(("lxc_power", node, vmid, action, timeout, force_stop))
        return "UPID:pve:1:1:1::start:"

    async def qemu_destroy(self, node, vmid, purge=True):
        self.calls.append(("qemu_destroy", node, vmid, purge))
        return "UPID:pve:2:2:2::destroy:"

    async def lxc_destroy(self, node, vmid, purge=True, force=False):
        self.calls.append(("lxc_destroy", node, vmid, purge))
        return "UPID:pve:2:2:2::destroy:"

    async def qemu_config(self, node, vmid):
        self.calls.append(("qemu_config", node, vmid))
        return {"tags": self.tags}

    async def lxc_config(self, node, vmid):
        self.calls.append(("lxc_config", node, vmid))
        return {"tags": self.tags}

    async def qemu_set_config(self, node, vmid, config):
        self.calls.append(("qemu_set_config", node, vmid, config))
        return None

    async def lxc_set_config(self, node, vmid, config):
        self.calls.append(("lxc_set_config", node, vmid, config))
        return None

    async def qemu_migrate(self, node, vmid, target_node, online=True):
        self.calls.append(("qemu_migrate", node, vmid, target_node, online))
        return "UPID:pve:3:3:3::migrate:"

    async def lxc_migrate(self, node, vmid, target_node, online=True, restart=False):
        self.calls.append(("lxc_migrate", node, vmid, target_node, online))
        return "UPID:pve:3:3:3::migrate:"

    async def qemu_snapshot_create(self, node, vmid, name, description="", vmstate=False):
        self.calls.append(("qemu_snapshot_create", node, vmid, name, vmstate))
        return "UPID:pve:4:4:4::snapshot:"

    async def lxc_snapshot_create(self, node, vmid, name, description=""):
        self.calls.append(("lxc_snapshot_create", node, vmid, name))
        return "UPID:pve:4:4:4::snapshot:"


def _request() -> SimpleNamespace:
    return SimpleNamespace(state=SimpleNamespace(session={"elevated_until": 0}))


def _user(role: str = "admin", username: str = "alice") -> dict:
    return {"username": username, "role": role, "permissions_override": None}


@pytest.fixture(autouse=True)
def _patch(monkeypatch) -> None:
    """隔离外部依赖：不连 PVE、不连数据库、不做连接探测。"""
    monkeypatch.setattr(bulk, "_op_connection", lambda: "conn-1")
    monkeypatch.setattr(bulk, "requested_connection", lambda: "")

    async def _resolve(node, vmid, owner):
        return "conn-1"

    monkeypatch.setattr(vm_scope, "resolve_vm_connection", _resolve)

    async def _get_owner(kind, ref):
        return "alice"

    monkeypatch.setattr(ownership, "get_owner", _get_owner)

    async def _audit(*args, **kwargs):
        return None

    monkeypatch.setattr(security, "audit", _audit)
    monkeypatch.setattr(security, "check_step_up", lambda request, user: None)
    # step_up 在测试环境可能为真，这里统一关掉，单独用例再开
    monkeypatch.setattr(security.settings, "step_up_required", False)


def _install(monkeypatch, client: FakeClient) -> None:
    monkeypatch.setattr(bulk, "client_for_connection", lambda conn_id: client)


def _req(action: str, targets=None, **params) -> BulkRequest:
    return BulkRequest(
        action=action,
        targets=targets or [BulkTarget(node="pve", vmid=100, type="qemu", name="web")],
        params=BulkParams(**params),
    )


# ------------------------------------------------------------- action 校验
class TestValidateAction:
    def test_unknown_action_rejected(self) -> None:
        with pytest.raises(HTTPException) as exc:
            bulk.validate_action("teleport", BulkParams())
        assert exc.value.status_code == 400

    def test_migrate_requires_target_node(self) -> None:
        with pytest.raises(HTTPException) as exc:
            bulk.validate_action("migrate", BulkParams())
        assert "目标节点" in exc.value.detail

    def test_snapshot_requires_name(self) -> None:
        with pytest.raises(HTTPException):
            bulk.validate_action("snapshot", BulkParams())

    def test_snapshot_name_reuses_vm_rules(self) -> None:
        """Regression: 批量不能造出单机接口会拒绝的快照名。"""
        with pytest.raises(Exception):
            bulk.validate_action("snapshot", BulkParams(name="bad name!"))

    def test_tag_requires_tags(self) -> None:
        with pytest.raises(HTTPException):
            bulk.validate_action("tag", BulkParams())

    def test_tag_mode_whitelist(self) -> None:
        with pytest.raises(HTTPException):
            bulk.validate_action("tag", BulkParams(tags="x", tag_mode="merge"))


# --------------------------------------------------------------- 请求模型
class TestBulkRequest:
    def test_empty_targets_rejected(self) -> None:
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            BulkRequest(action="start", targets=[])

    def test_duplicate_targets_rejected(self) -> None:
        """Regression: 同一台被点两次会导致重复开机 / 重复删除。"""
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            BulkRequest(
                action="start",
                targets=[BulkTarget(node="pve", vmid=100), BulkTarget(node="pve", vmid=100)],
            )

    def test_params_default_to_empty(self) -> None:
        req = BulkRequest(action="start", targets=[BulkTarget(node="pve", vmid=100)])
        assert req.params.purge is True
        assert req.params.tag_mode == "replace"


# --------------------------------------------------------------- 标签合并
class TestTagMerge:
    def test_split_accepts_both_separators(self) -> None:
        assert bulk._split_tags("a;b, c") == ["a", "b", "c"]

    def test_append_keeps_existing_and_dedupes(self) -> None:
        assert bulk._merge_tags("prod;web", ["web", "db"], "append") == "prod;web;db"

    def test_replace_discards_existing(self) -> None:
        assert bulk._merge_tags("prod;web", ["db"], "replace") == "db"

    def test_empty_result_clears_tags(self) -> None:
        assert bulk._merge_tags("prod", [], "replace") == ""


# ------------------------------------------------------------- 类型分派
class TestDispatch:
    def test_container_uses_lxc_endpoint(self, monkeypatch) -> None:
        client = FakeClient(kind="lxc")
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(),
                _user(),
                "start",
                BulkTarget(node="pve", vmid=100, type="lxc"),
                BulkParams(),
            )
        )
        assert item["ok"] is True
        assert any(call[0] == "lxc_power" for call in client.calls)
        assert not any(call[0] == "qemu_power" for call in client.calls)

    def test_type_is_probed_when_absent(self, monkeypatch) -> None:
        client = FakeClient(kind="lxc")
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(), _user(), "start", BulkTarget(node="pve", vmid=100), BulkParams()
            )
        )
        assert item["type"] == "lxc"
        assert any(call[0] == "lxc_power" for call in client.calls)

    def test_unknown_vmid_reports_error_not_raise(self, monkeypatch) -> None:
        """单台失败必须变成结果里的一项，不能把整批炸掉。"""

        class Missing(FakeClient):
            async def get(self, path, **kwargs):
                raise ProxmoxError("not found", 404)

        _install(monkeypatch, Missing())
        item = run(
            bulk._run_one(
                _request(), _user(), "start", BulkTarget(node="pve", vmid=999), BulkParams()
            )
        )
        assert item["ok"] is False
        assert item["error"]


# --------------------------------------------------------------- 删除守卫
class TestDelete:
    def test_running_guest_is_refused(self, monkeypatch) -> None:
        client = FakeClient(kind="qemu", status="running")
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(),
                _user(),
                "delete",
                BulkTarget(node="pve", vmid=100, type="qemu"),
                BulkParams(),
            )
        )
        assert item["ok"] is False
        assert "正在运行" in item["error"]
        assert not any(call[0] == "qemu_destroy" for call in client.calls)

    def test_stopped_guest_is_destroyed(self, monkeypatch) -> None:
        client = FakeClient(kind="qemu", status="stopped")
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(),
                _user(),
                "delete",
                BulkTarget(node="pve", vmid=100, type="qemu"),
                BulkParams(purge=False),
            )
        )
        assert item["ok"] is True
        assert ("qemu_destroy", "pve", 100, False) in client.calls


# --------------------------------------------------------------- 归属隔离
class TestOwnership:
    def test_other_users_guest_is_denied(self, monkeypatch) -> None:
        """Regression: 批量端点没有路径参数，路由级守卫不生效，必须自己判。"""

        async def _other_owner(kind, ref):
            return "bob"

        monkeypatch.setattr(ownership, "get_owner", _other_owner)
        client = FakeClient()
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(),
                _user(role="operator"),
                "start",
                BulkTarget(node="pve", vmid=100, type="qemu"),
                BulkParams(),
            )
        )
        assert item["ok"] is False
        assert "无权" in item["error"]
        assert client.calls == []

    def test_admin_bypasses_ownership(self, monkeypatch) -> None:
        async def _no_owner(kind, ref):
            return None

        monkeypatch.setattr(ownership, "get_owner", _no_owner)
        client = FakeClient()
        _install(monkeypatch, client)
        item = run(
            bulk._run_one(
                _request(),
                _user(),
                "start",
                BulkTarget(node="pve", vmid=100, type="qemu"),
                BulkParams(),
            )
        )
        assert item["ok"] is True


# --------------------------------------------------------------- run_bulk
class TestRunBulk:
    def test_partial_failure_keeps_going(self, monkeypatch) -> None:
        """第 2 台失败，第 1、3 台照样处理完 —— 这是批量接口存在的意义。"""
        seen = []

        class Flaky(FakeClient):
            async def qemu_power(self, node, vmid, action, timeout=None, force_stop=False):
                seen.append(vmid)
                if vmid == 101:
                    raise ProxmoxError("VM is locked", 500)
                return "UPID:x"

        _install(monkeypatch, Flaky())
        result = run(
            bulk.run_bulk(
                _request(),
                _user(),
                _req(
                    "start",
                    [
                        BulkTarget(node="pve", vmid=100, type="qemu"),
                        BulkTarget(node="pve", vmid=101, type="qemu"),
                        BulkTarget(node="pve", vmid=102, type="qemu"),
                    ],
                ),
            )
        )
        assert result["total"] == 3
        assert result["ok"] == 2
        assert result["failed"] == 1
        assert sorted(seen) == [100, 101, 102]
        by_vmid = {r["vmid"]: r for r in result["results"]}
        assert by_vmid[101]["ok"] is False
        assert by_vmid[101]["error"] == "VM is locked"
        assert by_vmid[100]["ok"] is True

    def test_permission_is_checked_per_action(self, monkeypatch) -> None:
        with pytest.raises(HTTPException) as exc:
            run(bulk.run_bulk(_request(), _user(role="viewer"), _req("start")))
        assert exc.value.status_code == 403

    def test_delete_requires_step_up(self, monkeypatch) -> None:
        def _deny(request, user):
            raise HTTPException(status_code=403, detail="需要二次确认")

        monkeypatch.setattr(security, "check_step_up", _deny)
        with pytest.raises(HTTPException) as exc:
            run(bulk.run_bulk(_request(), _user(), _req("delete")))
        assert exc.value.status_code == 403

    def test_tag_applies_to_each_guest(self, monkeypatch) -> None:
        client = FakeClient(tags="prod")
        _install(monkeypatch, client)
        result = run(
            bulk.run_bulk(_request(), _user(), _req("tag", tags="web", tag_mode="append"))
        )
        assert result["ok"] == 1
        assert ("qemu_set_config", "pve", 100, {"tags": "prod;web"}) in client.calls

    def test_snapshot_skips_vmstate_for_containers(self, monkeypatch) -> None:
        client = FakeClient(kind="lxc")
        _install(monkeypatch, client)
        result = run(
            bulk.run_bulk(
                _request(),
                _user(),
                BulkRequest(
                    action="snapshot",
                    targets=[BulkTarget(node="pve", vmid=100, type="lxc")],
                    params=BulkParams(name="snap1", vmstate=True),
                ),
            )
        )
        assert result["ok"] == 1
        assert ("lxc_snapshot_create", "pve", 100, "snap1") in client.calls

    def test_migrate_uses_target_node_and_online(self, monkeypatch) -> None:
        client = FakeClient()
        _install(monkeypatch, client)
        result = run(
            bulk.run_bulk(
                _request(), _user(), _req("migrate", target_node="pve2", online=False)
            )
        )
        assert result["ok"] == 1
        assert ("qemu_migrate", "pve", 100, "pve2", False) in client.calls
