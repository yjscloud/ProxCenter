"""对象级鉴权（guestguard）与各入口的接线。

背景：权限点只回答「这类操作允不允许做」，不回答「这台机器是不是你的」。
控制台、导出、重装、备份、模板转换、vm-meta、任务日志曾经都只有前者 ——
任何持有对应权限的普通用户，把 vmid 换成别人的号段就能接管/外带别人的机器。

这批用例守两件事：
1. 判定本身（管理员旁路、归属匹配/不匹配、无归属、区域管理员、导入文件、备份目标）；
2. **接线**：那些不在 vms/lxc 路由上的端点，必须真的调用了这套判定 ——
   否则以后有人重排依赖、挪动代码，能力会静默退化，而这里不会有人察觉。
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any, Dict, Optional

import pytest
from fastapi import HTTPException

from app import guestguard, ownership, security
from app.routers import backups, console, reinstall, tasks, templates, vm_meta, vmtransfer


@pytest.fixture()
def fake_world(monkeypatch: pytest.MonkeyPatch) -> Dict[str, str]:
    """把归属世界压成一张表：``"node:vmid" -> owner``（None 表示无记录）。"""
    owners: Dict[str, str] = {}

    async def _guest_owner(
        kind: str, node: str, vmid: int, connection: Optional[str] = None
    ) -> Optional[str]:
        return owners.get(f"{node}:{vmid}")

    async def _get_owner(kind: str, ref: str) -> str:
        # import 归属：ref 形如 "<conn>:<storage>:<volume>"，用后两段当键
        return owners.get(ref.rsplit(":", 2)[-2] + ":" + ref.rsplit(":", 2)[-1], "")

    async def _guest_owners_map() -> Dict[str, str]:
        return {f"conn-a:{key}": value for key, value in owners.items() if value}

    monkeypatch.setattr(guestguard, "guest_owner", _guest_owner)
    monkeypatch.setattr(guestguard.ownership, "get_owner", _get_owner)
    monkeypatch.setattr(guestguard.ownership, "guest_owners_map", _guest_owners_map)
    monkeypatch.setattr(guestguard.store, "get_active_connection_id", lambda: "conn-a")
    monkeypatch.setattr(guestguard.store, "connection_region", lambda conn: "r1")
    return owners


ALICE = {"username": "alice", "role": "operator"}
BOB = {"username": "bob", "role": "operator"}
ADMIN = {"username": "root", "role": "admin"}
REGION_ADMIN = {"username": "ra", "role": "region_admin", "regions": ["r1"]}


def _denied(user: Dict[str, Any], node: str = "pve1", vmid: int = 100, kind: str = ownership.KIND_VM) -> bool:
    try:
        asyncio.run(guestguard.require_guest_object(user, node, vmid, kind))
    except HTTPException as exc:
        assert exc.status_code == 404, exc.status_code
        # 404 文案不能带 node/vmid：否则等于换个字段继续泄露存在性
        assert "pve1" not in str(exc.detail) and "100" not in str(exc.detail)
        return True
    return False


class TestGuestObjectRequirement:
    def test_admin_bypasses(self, fake_world: Dict[str, str]) -> None:
        assert not _denied(ADMIN)

    def test_owner_matches(self, fake_world: Dict[str, str]) -> None:
        fake_world["pve1:100"] = "alice"
        assert not _denied(ALICE)

    def test_foreign_machine_is_404(self, fake_world: Dict[str, str]) -> None:
        fake_world["pve1:100"] = "bob"
        assert _denied(ALICE)

    def test_unowned_legacy_machine_is_404(self, fake_world: Dict[str, str]) -> None:
        """没有归属记录的存量机器：严格隔离，谁也不能碰（与 /vms 列表同口径）。"""
        assert _denied(ALICE)

    def test_region_admin_sees_whole_region(self, fake_world: Dict[str, str]) -> None:
        """区域内不逐台看归属：别人的机器也归他管（这是角色定义）。"""
        fake_world["pve1:100"] = "bob"
        assert not _denied(REGION_ADMIN)

    def test_region_admin_outside_region_is_404(self, fake_world: Dict[str, str]) -> None:
        assert _denied({**REGION_ADMIN, "regions": ["r2"]})
        # 一个区域都没指派 = 什么都看不到（未分区的连接也不归任何区域管理员）
        assert _denied({**REGION_ADMIN, "regions": []})


class TestSoftRequirement:
    """软判定：只在「明确属于别人」时拒绝，用于作业进行中的窗口。"""

    def test_unowned_passes(self, fake_world: Dict[str, str]) -> None:
        asyncio.run(
            guestguard.require_guest_object_if_owned(ALICE, "pve1", 100, ownership.KIND_VM)
        )

    def test_foreign_is_404(self, fake_world: Dict[str, str]) -> None:
        fake_world["pve1:100"] = "bob"
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(
                guestguard.require_guest_object_if_owned(
                    ALICE, "pve1", 100, ownership.KIND_VM
                )
            )
        assert rejected.value.status_code == 404


class TestImportObject:
    def test_own_import_passes(self, fake_world: Dict[str, str]) -> None:
        fake_world["local:import/alice.ova"] = "alice"
        asyncio.run(guestguard.require_import_object(ALICE, "local", "import/alice.ova"))

    def test_foreign_import_is_404(self, fake_world: Dict[str, str]) -> None:
        fake_world["local:import/bob.ova"] = "bob"
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(
                guestguard.require_import_object(ALICE, "local", "import/bob.ova")
            )
        assert rejected.value.status_code == 404
        assert "bob" not in str(rejected.value.detail)

    def test_admin_passes(self, fake_world: Dict[str, str]) -> None:
        asyncio.run(guestguard.require_import_object(ADMIN, "local", "import/bob.ova"))


class TestBackupTargets:
    def test_non_admin_cannot_back_up_everything(self, fake_world: Dict[str, str]) -> None:
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(backups._require_backup_targets(ALICE, "pve1", None, True))
        assert rejected.value.status_code == 403

    def test_admin_can_back_up_everything(self, fake_world: Dict[str, str]) -> None:
        asyncio.run(backups._require_backup_targets(ADMIN, "pve1", None, True))

    def test_own_machine_passes(self, fake_world: Dict[str, str]) -> None:
        fake_world["pve1:100"] = "alice"
        asyncio.run(backups._require_backup_targets(ALICE, "pve1", "100", False))

    def test_foreign_machine_is_404(self, fake_world: Dict[str, str]) -> None:
        fake_world["pve1:100"] = "bob"
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(backups._require_backup_targets(ALICE, "pve1", "100", False))
        assert rejected.value.status_code == 404

    def test_job_without_node_uses_any_connection(
        self, fake_world: Dict[str, str]
    ) -> None:
        """计划任务可以不带 node：按「任一连接上登记在我名下」判定。"""
        fake_world["pve1:100"] = "alice"
        fake_world["pve1:200"] = "bob"
        asyncio.run(backups._require_backup_targets(ALICE, None, "100", False))
        # 完全没有归属记录的存量机器按无主处理（与有 node 的分支一致）
        asyncio.run(backups._require_backup_targets(ALICE, None, "999", False))
        with pytest.raises(HTTPException):
            asyncio.run(backups._require_backup_targets(ALICE, None, "100,200", False))


# --------------------------------------------------------------- 接线检查
def _route_dep_names(path: str) -> list:
    from app.main import app

    for route in app.routes:
        if getattr(route, "path", "") == path:
            return [dep.call.__name__ for dep in route.dependant.dependencies]
    raise AssertionError(f"路由未注册：{path}")


@pytest.mark.parametrize(
    "path",
    [
        "/api/vms/{node}/{vmid}/console/vncproxy",
        "/api/vms/{node}/{vmid}/console/xtermproxy",
        "/api/lxc/{node}/{vmid}/console/vncproxy",
        "/api/lxc/{node}/{vmid}/console/xtermproxy",
    ],
)
def test_console_http_endpoints_bind_connection_first(path: str) -> None:
    """控制台 HTTP 端点仍要先绑连接：归属 ref 的前缀是连接 id。"""
    assert "bind_vm_connection" in _route_dep_names(path)


@pytest.mark.parametrize(
    "handler",
    [
        console._proxy_console,
        console.create_vnc_session,
        console.create_xterm_session,
        console.create_lxc_vnc_session,
        console.create_lxc_xterm_session,
        reinstall.reinstall_network,
        reinstall.reinstall_vm,
        vmtransfer.start_export,
        vmtransfer.inspect_import,
        vmtransfer.create_imported_vm,
        templates.convert_vm_to_template,
        templates.clone_template,
        vm_meta.save_vm_meta,
        tasks.get_task_log,
        tasks.delete_task,
        tasks.stop_task,
        backups.create_backup,
        backups.restore_backup,
        backups.create_backup_job,
        backups.update_backup_job,
    ],
)
def test_handler_calls_object_guard(handler: Any) -> None:
    """处理函数内部的对象标识（body / token / upid）必须过一遍同一套判定。

    这类端点不在 vms/lxc 路由上，挂不了路由级依赖，只能靠处理函数自己调 ——
    所以这里直接盯源码，挪掉那一行就会红。
    """
    source = inspect.getsource(handler)
    assert (
        "guestguard.require_guest_object" in source
        or "guestguard.require_import_object" in source
        or "_require_backup_targets" in source
        or "_require_task_guest" in source
    ), handler.__name__
