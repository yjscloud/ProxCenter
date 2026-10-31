"""归属变更的后续对齐：删号残留、活动告警、备份标记。

这三处是「资源换了主人，别的地方还按旧账走」的其余出口：

* 归属表里指向已删账号的记录（删号写点失败 / 历史脏数据）；
* ``alert_active`` 以收件人为主键，改派后旧行再也不会被评估命中；
* 备份 / 备份计划把 ``[owner:x]`` 当权限依据（PVE notes 不会被改派流程碰）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import alerting, frp, ownership, quota, security, store  # noqa: E402

CONN, NODE, VMID = "c1", "pve1", 100


async def _with_pool(coro):
    from app import database

    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_with_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    _run(ownership.init_table())
    _run(store.init_db())
    _run(alerting.init_table())
    # 内置角色（admin / operator / viewer）由 load_roles 补齐，create_user 会校验角色存在
    _run(security.load_roles())
    yield


class TestPruneDeletedOwners:
    def test_removes_rows_of_accounts_that_are_gone(self, db) -> None:
        gone = ownership.vm_ref(CONN, NODE, 100)
        kept = ownership.vm_ref(CONN, NODE, 101)
        _run(ownership.set_owner(ownership.KIND_VM, gone, "ghost"))
        _run(ownership.set_owner(ownership.KIND_VM, kept, "admin"))
        _run(ownership.set_owner(ownership.KIND_SNAPSHOT, f"{gone}/snap1", "ghost"))

        result = _run(quota.prune_deleted_owners())

        assert result["removed"] == 2
        assert result["refused"] == ""
        assert _run(ownership.get_owner(ownership.KIND_VM, gone)) is None
        assert _run(ownership.get_owner(ownership.KIND_VM, kept)) == "admin"

    def test_unreadable_user_table_skips_the_round(self, db, monkeypatch) -> None:
        """读不到账号表时整轮跳过：拿空清单去删等于把全站归属清空。"""
        ref = ownership.vm_ref(CONN, NODE, 100)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "ghost"))

        async def boom():
            raise RuntimeError("账号表读不到")

        monkeypatch.setattr(store, "list_users", boom)

        result = _run(quota.prune_deleted_owners())

        assert result["removed"] == 0
        assert result["refused"]
        assert _run(ownership.get_owner(ownership.KIND_VM, ref)) == "ghost"


class TestActiveAlertsFollowOwner:
    def _fire(self, owner: str = "alice") -> str:
        label = ownership.vm_ref(CONN, NODE, VMID)
        key = alerting.alarm_key(owner, "rule-1", label)
        _run(
            alerting.mark_active(
                key,
                {
                    "username": owner,
                    "rule_id": "rule-1",
                    "rule_name": "CPU 高",
                    "target_type": "vm",
                    "target": label,
                    "metric": "cpu",
                    "value": 97.0,
                    "threshold": 90.0,
                    "node": NODE,
                    "vmid": str(VMID),
                    "connection_id": CONN,
                    "ts": 1,
                    "notify_source": "resource",
                },
            )
        )
        return key

    def test_transfer_moves_the_active_row(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        self._fire("alice")

        result = _run(ownership.transfer_guest(ownership.KIND_VM, ref, "bob"))

        assert result["active_alerts_moved"] == 1
        rows = _run(alerting.visible_active())
        assert [row["username"] for row in rows] == ["bob"]

    def test_other_machines_are_untouched(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        lines = f"{CONN}:{NODE}:999"
        other_key = alerting.alarm_key("alice", "rule-1", lines)
        _run(
            alerting.mark_active(
                other_key,
                {
                    "username": "alice",
                    "rule_id": "rule-1",
                    "target_type": "vm",
                    "target": lines,
                    "node": NODE,
                    "vmid": "999",
                    "connection_id": CONN,
                },
            )
        )

        assert _run(ownership.transfer_guest(ownership.KIND_VM, ref, "bob"))[
            "active_alerts_moved"
        ] == 0
        rows = _run(alerting.visible_active())
        assert [row["username"] for row in rows] == ["alice"]

    def test_unassign_moves_the_row_to_no_owner(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        self._fire("alice")

        _run(ownership.transfer_guest(ownership.KIND_VM, ref, ""))

        # 无主的行只剩管理员看得到（owner=None 不过滤）
        assert [row["username"] for row in _run(alerting.visible_active())] == [""]
        assert _run(alerting.visible_active("alice")) == []


class TestDeletedUserDerivedData:
    def test_alert_rules_become_ownerless(self, db) -> None:
        _run(
            alerting.save_rules(
                [
                    {"id": "r1", "username": "ghost", "name": "CPU", "metric": "cpu",
                     "target": "*", "target_type": "vm", "op": ">", "value": 90},
                    {"id": "r2", "username": "admin", "name": "MEM", "metric": "mem",
                     "target": "*", "target_type": "vm", "op": ">", "value": 90},
                ]
            )
        )

        assert _run(alerting.detach_owner("ghost")) == 1

        rules = {rule["id"]: rule for rule in _run(alerting.load_rules())}
        assert rules["r1"]["username"] == ""
        assert rules["r2"]["username"] == "admin"

    def test_frp_rules_are_removed(self, db) -> None:
        _run(
            frp.save_rules(
                [
                    {"username": "ghost", "name": "web", "local_ip": "10.0.0.5",
                     "local_port": 80, "remote_port": 40001},
                    {"username": "admin", "name": "db", "local_ip": "10.0.0.6",
                     "local_port": 5432, "remote_port": 40002},
                ]
            )
        )

        assert _run(frp.drop_rules_of("ghost")) == 1

        assert [rule["username"] for rule in _run(frp.load_rules())] == ["admin"]


class TestFrpRulesFollowTheMachine:
    """穿透规则的目标合法性只在写入时校验过一次 —— 改派之后必须复核。

    做法：规则落库时记下它指向的客户机（``guest_ref``），之后只读本地归属表
    就能判断这条隧道该不该继续生效，不必再问 PVE。
    """

    def _rule(self, username: str, guest_ref: str, remote_port: int = 40001) -> dict:
        return {
            "username": username,
            "name": f"web-{remote_port}",
            "local_ip": "10.0.0.5",
            "local_port": 80,
            "remote_port": remote_port,
            "guest_ref": guest_ref,
        }

    def test_matching_owner_is_not_stale(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(frp.save_rules([self._rule("alice", ref)]))

        rules = _run(frp.annotate_rules(_run(frp.load_rules())))

        assert rules[0]["stale"] is False
        assert rules[0]["stale_reason"] == ""

    def test_transfer_suspends_the_tunnel(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(frp.save_rules([self._rule("alice", ref)]))

        result = _run(ownership.transfer_guest(ownership.KIND_VM, ref, "bob"))

        assert result["frp_rules_suspended"] == 1
        rules = _run(frp.annotate_rules(_run(frp.load_rules())))
        assert rules[0]["stale"] is True
        assert "bob" in rules[0]["stale_reason"]
        # 规则本身保留（不删、不改归属），只是不再参与渲染
        assert rules[0]["username"] == "alice"

    def test_stale_rules_are_not_rendered(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(frp.save_rules([self._rule("alice", ref, 40001)]))
        _run(frp.save_rules(_run(frp.load_rules()) + [self._rule("carol", "", 40002)]))
        _run(ownership.transfer_guest(ownership.KIND_VM, ref, "bob"))

        cfg = _run(frp.effective())

        # 失效的那条不渲染；未关联 guest_ref 的规则照旧（存量规则不能因升级断掉）
        assert [p["remote_port"] for p in cfg["proxies"]] == [40002]

    def test_unowned_machine_also_suspends(self, db) -> None:
        ref = ownership.vm_ref(CONN, NODE, VMID)
        _run(ownership.set_owner(ownership.KIND_VM, ref, "alice"))
        _run(frp.save_rules([self._rule("alice", ref)]))

        _run(ownership.transfer_guest(ownership.KIND_VM, ref, ""))

        rules = _run(frp.annotate_rules(_run(frp.load_rules())))
        assert rules[0]["stale"] is True
        assert "无归属" in rules[0]["stale_reason"]


class TestRelinkLegacyRules:
    """存量规则补关联：补上之后才会被改派复核覆盖。"""

    def test_links_rules_to_owned_guests(self, db, monkeypatch) -> None:
        from app import frpguard

        ref = ownership.vm_ref(CONN, NODE, VMID)

        async def targets(username, *, include_connection=False):
            if username != "alice":
                return []
            return [
                {
                    "ip": "10.0.0.5",
                    "name": "web",
                    "vmid": VMID,
                    "node": NODE,
                    "type": "qemu",
                    "connection_id": CONN,
                }
            ]

        monkeypatch.setattr(frpguard, "own_guest_targets", targets)
        _run(
            frp.save_rules(
                [
                    # 存量规则：没有 guest_ref，但地址是自己名下的机器
                    {"username": "alice", "name": "web", "local_ip": "10.0.0.5",
                     "local_port": 80, "remote_port": 40001},
                    # 地址对不上任何一台 → 保持未关联并列出来
                    {"username": "alice", "name": "db", "local_ip": "10.0.0.9",
                     "local_port": 5432, "remote_port": 40002},
                    # 已有 guest_ref：不该被覆盖
                    {"username": "alice", "name": "fixed", "local_ip": "10.0.0.5",
                     "local_port": 8080, "remote_port": 40003,
                     "guest_ref": ownership.vm_ref(CONN, NODE, 777)},
                ]
            )
        )

        result = _run(frp.relink_guests())

        assert result["checked"] == 2  # 已有 guest_ref 的那条不参与
        assert result["linked"] == 1
        assert [item["name"] for item in result["unlinked"]] == ["db"]

        rules = {rule["name"]: rule for rule in _run(frp.load_rules())}
        assert rules["web"]["guest_ref"] == ref
        assert rules["db"]["guest_ref"] == ""
        assert rules["fixed"]["guest_ref"] == ownership.vm_ref(CONN, NODE, 777)

    def test_without_pending_rules_it_is_a_noop(self, db) -> None:
        assert _run(frp.relink_guests()) == {"checked": 0, "linked": 0, "unlinked": []}


class TestAlertRecipientReachability:
    """归属指向的账号「存在但不可用」（停用 / 未审批 / 已过期）时也收不到告警。"""

    def _make_user(self, username: str, **fields) -> None:
        _run(
            store.create_user(
                username, "Unit-Test-Pa55word", role="viewer", email=f"{username}@example.com"
            )
        )
        if fields:
            _run(store.update_user(username, **fields))

    def test_disabled_account_falls_back_to_rule_owner(self, db) -> None:
        self._make_user("alice", enabled=0)

        assert _run(alerting.RecipientBook().recipient("admin", "alice")) == "admin"

    def test_expired_account_falls_back_to_rule_owner(self, db) -> None:
        self._make_user("bob", expires_at=1.0)

        assert _run(alerting.RecipientBook().recipient("admin", "bob")) == "admin"

    def test_active_account_keeps_the_alarm(self, db) -> None:
        self._make_user("carol")

        assert _run(alerting.RecipientBook().recipient("admin", "carol")) == "carol"


class TestGenerationAcrossWorkers:
    """多 worker：改派要能让**别的进程**的读缓存一起失效。"""

    def test_epoch_bump_drops_other_workers_entries(self, db) -> None:
        from app import pvecache

        calls: list = []

        async def factory():
            calls.append(1)
            return len(calls)

        async def scenario():
            first = await pvecache.cached("dashboard:summary:x", 60, factory)
            again = await pvecache.cached("dashboard:summary:x", 60, factory)
            # 模拟「另一个 worker 改了归属」：只推进代际号，本地不做清空
            await ownership._announce_change()
            after = await pvecache.cached("dashboard:summary:x", 60, factory)
            return first, again, after

        pvecache.set_epoch_provider(ownership.generation)
        try:
            first, again, after = _run(scenario())
        finally:
            pvecache.set_epoch_provider(None)

        assert first == again == 1  # 同进程命中缓存
        assert after == 2  # 代际号变了 → 重算


class TestBackupOwnerDrift:
    """对账：只比对标记与当前归属，不写 PVE。"""

    def _row(self, volid: str, marker: str, vmid: int, node: str = NODE) -> dict:
        notes = f"[owner:{marker}] 手动备注" if marker else "手动备注"
        return {"volid": volid, "node": node, "vmid": vmid, "storage": "local", "notes": notes}

    def test_classifies_the_three_kinds_of_drift(self) -> None:
        from app.routers.backups import _owner_drift_rows

        owners = {ownership.vm_ref(CONN, NODE, VMID): "bob"}
        items = [
            # 标记 alice，机器现在归 bob → reassigned
            self._row("local:a-100", "alice", VMID),
            # 标记 alice，机器没有归属 → machine-unowned
            self._row("local:a-101", "alice", 101),
            # 机器归 bob，归档没有标记 → unmarked
            self._row("local:a-102", "", VMID),
            # 标记与归属一致 → 不算差异
            self._row("local:a-103", "bob", VMID),
            # 两样都没有 → 也不算差异
            self._row("local:a-104", "", 104),
        ]

        rows = _owner_drift_rows(items, owners, CONN)

        assert [(row["volid"], row["reason"]) for row in rows] == [
            ("local:a-101", "machine-unowned"),
            ("local:a-100", "reassigned"),
            ("local:a-102", "unmarked"),
        ]
        # 对账是只读的：函数不返回也不改写任何 notes
        assert items[0]["notes"] == "[owner:alice] 手动备注"

    def test_unrelated_owner_is_not_drift(self) -> None:
        from app.routers.backups import _owner_drift_rows

        owners = {ownership.vm_ref(CONN, NODE, VMID): "bob"}
        assert _owner_drift_rows([self._row("local:a-100", "bob", VMID)], owners, CONN) == []


class TestBulkAssignWiring:
    """批量指派复用 bulk 编排：权限按类型走，参数带 username / reason。"""

    def test_action_permissions(self) -> None:
        from app import bulk

        assert bulk.ACTION_PERMISSION["assign"] == "vm.assign"
        assert bulk.ACTION_PERMISSION_CT["assign"] == "ct.assign"
        assert "assign" in bulk.ACTION_LABELS

    def test_params_accept_username_and_reason(self) -> None:
        from app.schemas import BulkParams

        params = BulkParams(username=" bob ", reason=" OPS-1 ")
        assert params.username == " bob "  # 去空格在编排层做，schema 只负责类型
        assert params.reason == " OPS-1 "

    def test_empty_target_is_rejected(self) -> None:
        """空用户名在归属语义里是「收回」：批量不清归属，服务端自己拦住。

        界面上的提交按钮已按「必须选人」禁用，但接口是公开的（脚本 / 第三方），
        没有这道校验时一次调用就能抹掉整批机器的归属。
        """
        from app import bulk
        from app.schemas import BulkParams

        assert bulk.assign_target_error(BulkParams(username="")) != ""
        assert bulk.assign_target_error(BulkParams(username="   ")) != ""
        assert bulk.assign_target_error(BulkParams(username=None)) != ""
        assert bulk.assign_target_error(BulkParams(username=" bob ")) == ""


class TestBackupOwner:
    def test_machine_owner_wins_over_the_marker(self) -> None:
        from app.routers.backups import _effective_owner

        owners = {ownership.vm_ref(CONN, NODE, VMID): "bob"}
        assert _effective_owner("alice", owners, NODE, VMID, CONN) == "bob"

    def test_marker_is_the_fallback_when_the_machine_is_gone(self) -> None:
        from app.routers.backups import _effective_owner

        owners = {ownership.vm_ref(CONN, NODE, VMID): "bob"}
        assert _effective_owner("alice", owners, NODE, 999, CONN) == "alice"
        assert _effective_owner(None, owners, NODE, 999, CONN) is None
