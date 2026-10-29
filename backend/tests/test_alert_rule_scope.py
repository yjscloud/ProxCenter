"""多条规则 / 新账号的规则必须「各自独立生效」。

这里钉住三个曾经被踩坏的边界：

1. **规则 id 必须唯一**。保存规则时同 id 的条目会被合并成一条（``_dedupe_by_id``），
   而新规则的 id 曾经是 ``int(time.time() * 1000)`` —— 同一个请求里循环生成的
   多条规则几乎必然落在同一毫秒，于是「给三台虚拟机各配一条规则」落库后只剩一条，
   最终只触发一个告警。
2. **告警身份必须是集群内唯一的对象**，不能用虚拟机名（Proxmox 允许同名）。用名字
   时两台 ``web`` 会共用一个 alarm_key，后一台被当成前一台的「重复轮次」跳过。
3. **普通用户配的规则是「自己的」**：``*`` 只覆盖自己名下的机器，告警发给自己。
   按「机器归属」投递是**管理员 / 区域管理员**的口径；照搬到普通用户身上，新建账号
   配完规则后告警全进了别人（机器归属者）的通道，他自己的告警页永远是空的。

模块层用 ``asyncio.run`` + ``db`` 夹具（只建表、不起 app），写法与
test_alert_owner_routing 一致。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app import (  # noqa: E402
    alerting,
    database,
    notifications,
    ownership,
    security,
    store,
)
from app.routers import alerts as alerts_router  # noqa: E402

PASSWORD = "Unit-Test-Pa55word"


async def _shutdown_pool(coro):
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    _run(store.init_db())
    _run(security.load_roles())
    _run(ownership.init_table())
    _run(alerting.init_table())
    _run(notifications.init_table())
    yield


def _make_user(username: str, role: str = "operator") -> None:
    async def main() -> None:
        if await store.get_user(username) is None:
            await store.create_user(username, PASSWORD, role, f"{username}@example.com")

    _run(main())


def _own(username: str, vmid: int, node: str = "pve") -> None:
    conn = str(store.get_active_connection_id() or "")

    async def main() -> None:
        await ownership.set_owner(
            ownership.KIND_VM, ownership.vm_ref(conn, node, vmid), username
        )

    _run(main())


# ---------------------------------------------------------------- 规则落库
def test_rules_saved_without_ids_are_all_kept(db) -> None:
    """一次提交里多条没有 id 的规则：必须是三条，不能塌成一条。"""
    payload = [
        {"name": f"vm-{vmid}", "target_type": "vm", "target": str(vmid), "metric": "cpu"}
        for vmid in (101, 102, 103)
    ]
    saved = _run(alerting.save_rules_for(payload, "admin"))

    assert len(saved) == 3
    assert len({rule["id"] for rule in saved}) == 3
    assert [rule["target"] for rule in saved] == ["101", "102", "103"]
    assert len(_run(alerting.load_rules())) == 3


def test_same_id_but_different_rules_are_not_merged(db) -> None:
    """老客户端复用同一个 id 时，那仍是两条规则（目标不同），要各自保留。"""
    payload = [
        {"id": "legacy", "target_type": "vm", "target": "101", "metric": "cpu"},
        {"id": "legacy", "target_type": "vm", "target": "102", "metric": "cpu"},
    ]
    saved = _run(alerting.save_rules_for(payload, "admin"))

    assert [rule["target"] for rule in saved] == ["101", "102"]
    assert len({rule["id"] for rule in saved}) == 2


def test_my_rule_never_overwrites_another_users_rule_with_the_same_id(db) -> None:
    """两个人碰巧用了同一个规则 id：谁保存都不该把对方的规则吞掉。"""
    _make_user("bob")
    _run(alerting.save_rules_for([{"id": "same", "target": "101"}], "bob"))

    saved = _run(
        alerting.save_rules_for([{"id": "same", "target": "201", "username": "admin"}], "admin")
    )
    by_owner = {rule["username"]: rule for rule in saved}

    assert set(by_owner) == {"admin", "bob"}
    assert by_owner["bob"]["target"] == "101"
    assert by_owner["admin"]["target"] == "201"
    assert by_owner["bob"]["id"] != by_owner["admin"]["id"]


# ---------------------------------------------------------------- 触发
class _FakeConn:
    configured = True
    host = "10.0.0.1"


class _FakeClient:
    def __init__(self, resources: List[Dict[str, Any]]) -> None:
        self.conn = _FakeConn()
        self._resources = resources
        #: 这条连接被巡检读了几次（用来验证「只读规则指向的连接」）
        self.calls = 0

    async def cluster_resources(self) -> List[Dict[str, Any]]:
        self.calls += 1
        return list(self._resources)


def _rule(**over: Any) -> Dict[str, Any]:
    rule = {
        "id": "r1",
        "username": "admin",
        "name": "CPU 高负载",
        "target_type": "vm",
        "target": "*",
        "metric": "cpu",
        "threshold": 80,
        "enabled": True,
    }
    rule.update(over)
    return rule


def _vm(vmid: int, name: str, node: str = "pve", cpu: float = 0.95) -> Dict[str, Any]:
    return {
        "type": "qemu",
        "node": node,
        "vmid": vmid,
        "name": name,
        "status": "running",
        "cpu": cpu,
        "maxcpu": 4,
        "mem": 1,
        "maxmem": 2,
        "disk": 0,
        "maxdisk": 100,
    }


async def _as_list(rules):
    return rules


def _wire_evaluate(monkeypatch, resources, rules, sent: List[str]) -> None:
    monkeypatch.setattr(alerting, "get_client", lambda: _FakeClient(resources))
    monkeypatch.setattr(alerting, "load_rules", lambda: _as_list(rules))

    async def fake_dispatch(owner, feishu, email_cfg, title, text, card,
                            webhook=None, context=None, source=""):
        sent.append(owner)
        return True, "已发送"

    async def fake_ip(client, node, vmid):
        return ""

    monkeypatch.setattr(alerting, "dispatch", fake_dispatch)
    monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)


def _wire_multi(
    monkeypatch,
    sources: Dict[str, List[Dict[str, Any]]],
    rules: List[Dict[str, Any]],
    sent: List[str],
    default_cid: str = "a",
    patch_rules: bool = True,
) -> None:
    """把巡检钉在「多套 PVE 连接」上：每条连接给一份资源清单。

    ``default_cid`` 是「兜底读取」的那条连接（升级前的巡检只读它），旧口径的
    目标（裸 VMID）只在这条连接上解释 —— 见 alerting.target_matches。
    """
    monkeypatch.setattr(
        alerting,
        "all_connection_clients",
        lambda: [({"id": cid}, _FakeClient(res)) for cid, res in sources.items()],
    )
    monkeypatch.setattr(alerting, "requested_connection", lambda: "")
    monkeypatch.setattr(alerting, "_default_connection_id", lambda: default_cid)
    if patch_rules:
        monkeypatch.setattr(alerting, "load_rules", lambda: _as_list(rules))

    async def fake_dispatch(owner, feishu, email_cfg, title, text, card,
                            webhook=None, context=None, source=""):
        sent.append(owner)
        return True, "已发送"

    async def fake_ip(client, node, vmid):
        return ""

    monkeypatch.setattr(alerting, "dispatch", fake_dispatch)
    monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)


def test_two_rules_for_two_vms_fire_two_alerts(db, monkeypatch) -> None:
    sent: List[str] = []
    resources = [_vm(101, "vm-a"), _vm(102, "vm-b")]
    rules = [_rule(id="r1", target="101"), _rule(id="r2", target="102")]
    _wire_evaluate(monkeypatch, resources, rules, sent)

    fired = _run(alerting.evaluate())

    assert len(fired) == 2
    assert sorted(row["target"] for row in fired) == ["vm-a", "vm-b"]
    assert len(_run(alerting.load_active())) == 2


def test_same_named_vms_do_not_share_one_alarm(db, monkeypatch) -> None:
    """两台同名虚拟机（不同节点 / VMID）：一条 ``*`` 规则要报两条。"""
    sent: List[str] = []
    resources = [_vm(101, "web", node="pve1"), _vm(102, "web", node="pve2")]
    _wire_evaluate(monkeypatch, resources, [_rule()], sent)

    fired = _run(alerting.evaluate())

    assert len(fired) == 2
    assert len(sent) == 2
    active = _run(alerting.load_active())
    # 对象身份 = 「连接 + 节点 + VMID」（测试库没有连接记录，前缀是 "-"）
    assert sorted(active) == [
        alerting.alarm_key("admin", "r1", "-:pve1:101"),
        alerting.alarm_key("admin", "r1", "-:pve2:102"),
    ]


# ---------------------------------------------------------------- 新账号
def test_new_account_rule_only_covers_its_own_machines(db, monkeypatch) -> None:
    """新账号的 ``*`` 规则：只覆盖自己名下的机器，告警也只发给他自己。"""
    _make_user("bob")
    _own("bob", 101)
    _own("admin", 102)

    sent: List[str] = []
    resources = [_vm(101, "bob-vm"), _vm(102, "admin-vm")]
    _wire_evaluate(monkeypatch, resources, [_rule(id="b1", username="bob")], sent)

    fired = _run(alerting.evaluate())

    assert [row["target"] for row in fired] == ["bob-vm"]
    assert sent == ["bob"]
    # 历史与站内消息都记在他名下：告警页与铃铛要看得见，否则用户看到的就是
    # 「规则配了、什么也没有」
    rows = _run(alerting.history(50, "bob"))
    assert [row["target"] for row in rows] == ["bob-vm"]
    assert _run(notifications.unread_count("bob")) == 1
    assert _run(alerting.history(50, "admin")) == []


def test_new_account_rule_fires_without_ownership_record(db, monkeypatch) -> None:
    """明确指定 VMID 的规则照常生效：没有归属记录也不该被静默丢弃。"""
    _make_user("bob")

    sent: List[str] = []
    resources = [_vm(101, "vm-a")]
    _wire_evaluate(
        monkeypatch, resources, [_rule(id="b1", username="bob", target="101")], sent
    )

    fired = _run(alerting.evaluate())

    assert [row["username"] for row in fired] == ["bob"]
    assert sent == ["bob"]


def test_admin_rule_still_follows_machine_ownership(db, monkeypatch) -> None:
    """管理员规则的既有口径不变：按机器归属分别投递。"""
    _make_user("alice")
    _own("alice", 101)

    sent: List[str] = []
    resources = [_vm(101, "vm-a"), _vm(102, "vm-orphan")]
    _wire_evaluate(monkeypatch, resources, [_rule()], sent)

    _run(alerting.evaluate())

    assert sorted(sent) == ["admin", "alice"]


# ---------------------------------------------------------------- 界面口径
def test_new_account_without_manage_permission_is_told_so(db) -> None:
    """新建账号的默认角色是 viewer：告警页要明确回一个「只能看」的标志。

    前端据此把规则编辑器置为只读。以前前端不看权限、直接允许编辑，保存时才 403 ——
    规则行还留在页面上，用户以为配好了，实际一条都没落库。
    """
    _make_user("viewer-bot", role="viewer")
    _make_user("operator-bot", role="operator")

    async def main() -> Dict[str, Any]:
        return {
            "viewer": await alerts_router.get_alerts(
                user=await store.get_user("viewer-bot")
            ),
            "operator": await alerts_router.get_alerts(
                user=await store.get_user("operator-bot")
            ),
            "admin": await alerts_router.get_alerts(
                user={"username": "admin", "role": "admin", "permissions": None}
            ),
        }

    data = _run(main())

    assert data["viewer"]["can_manage"] is False
    assert data["viewer"]["is_admin"] is False
    assert data["operator"]["can_manage"] is True
    assert data["admin"]["can_manage"] is True


# ---------------------------------------------------------------- 多套 PVE
#
# VMID 与节点名都只在**集群内**唯一。面板同时接多套 PVE 时，「只存 VMID」的
# 规则目标和「节点 + VMID」的告警身份都会撞车：规则配的是 A 集群上的机器，
# 巡检却命中 B 集群上同号的那台（推送内容全是它的），另一台反倒永远不响。
def test_vm_target_ref_only_fires_the_machine_on_its_own_connection(db, monkeypatch) -> None:
    """规则目标带连接：两套集群都有 103 时，只报自己那台。"""
    sent: List[str] = []
    sources = {"a": [_vm(103, "proxCenter-17")], "b": [_vm(103, "test111")]}
    rules = [_rule(id="r1", name="CPU告警1", target="b:pve:103")]
    _wire_multi(monkeypatch, sources, rules, sent)

    fired = _run(alerting.evaluate())

    assert [row["target"] for row in fired] == ["test111"]
    rows = _run(alerting.history(50))
    assert [(row["rule_name"], row["target"]) for row in rows] == [
        ("CPU告警1", "test111")
    ]


def test_same_vmid_on_two_connections_do_not_share_one_alarm(db, monkeypatch) -> None:
    """同一 VMID 分布在两套集群：两条独立告警，不会互相压制冷却。"""
    sent: List[str] = []
    sources = {"a": [_vm(100, "vm-a")], "b": [_vm(100, "vm-b")]}
    _wire_multi(monkeypatch, sources, [_rule()], sent)

    fired = _run(alerting.evaluate())

    assert sorted(row["target"] for row in fired) == ["vm-a", "vm-b"]
    assert sorted(_run(alerting.load_active())) == [
        alerting.alarm_key("admin", "r1", "a:pve:100"),
        alerting.alarm_key("admin", "r1", "b:pve:100"),
    ]


def test_legacy_vmid_target_is_upgraded_to_the_owners_machine(db, monkeypatch) -> None:
    """旧口径「裸 VMID」跨集群有歧义时，归一到规则主人自己那台。"""
    _make_user("bob")

    async def seed() -> None:
        await ownership.set_owner(
            ownership.KIND_VM, ownership.vm_ref("b", "pve", 103), "bob"
        )

    _run(seed())
    # 规则真的落库（不走 load_rules 桩）：要验证归一后的目标写回去了
    _run(
        alerting.save_rules_for(
            [
                {
                    "id": "r1",
                    "name": "CPU告警1",
                    "target_type": "vm",
                    "target": "103",
                    "metric": "cpu",
                    "threshold": 80,
                }
            ],
            "bob",
        )
    )

    sent: List[str] = []
    sources = {"a": [_vm(103, "proxCenter-17")], "b": [_vm(103, "test111")]}
    _wire_multi(monkeypatch, sources, [], sent, patch_rules=False)

    fired = _run(alerting.evaluate())

    assert [row["target"] for row in fired] == ["test111"]
    assert sent == ["bob"]
    saved = _run(alerting.load_rules())
    assert [rule["target"] for rule in saved] == ["b:pve:103"]


def test_alert_recipient_follows_the_machines_own_connection(db, monkeypatch) -> None:
    """归属按机器自己那条连接查：同号机器属于不同的人，各发各的。"""
    _make_user("alice")

    async def seed() -> None:
        await ownership.set_owner(
            ownership.KIND_VM, ownership.vm_ref("b", "pve", 100), "alice"
        )

    _run(seed())

    sent: List[str] = []
    sources = {"a": [_vm(100, "vm-a")], "b": [_vm(100, "vm-b")]}
    _wire_multi(monkeypatch, sources, [_rule()], sent)

    _run(alerting.evaluate())

    assert sorted(sent) == ["admin", "alice"]
    rows = _run(alerting.history(50))
    assert {row["target"]: row["username"] for row in rows} == {
        "vm-a": "admin",
        "vm-b": "alice",
    }


def test_only_the_connections_named_by_rules_are_read(db, monkeypatch) -> None:
    """规则目标都是 ref 时，没被指到的连接不读 —— 多连接巡检不做无用功。"""
    sent: List[str] = []
    sources = {"a": [_vm(100, "vm-a")], "b": [_vm(200, "vm-b")], "c": [_vm(300, "vm-c")]}
    clients = {cid: _FakeClient(res) for cid, res in sources.items()}
    monkeypatch.setattr(
        alerting,
        "all_connection_clients",
        lambda: [({"id": cid}, client) for cid, client in clients.items()],
    )
    monkeypatch.setattr(alerting, "requested_connection", lambda: "")
    monkeypatch.setattr(
        alerting, "load_rules", lambda: _as_list([_rule(target="b:pve:200")])
    )

    async def fake_dispatch(owner, feishu, email_cfg, title, text, card,
                            webhook=None, context=None, source=""):
        sent.append(owner)
        return True, "已发送"

    async def fake_ip(client, node, vmid):
        return ""

    monkeypatch.setattr(alerting, "dispatch", fake_dispatch)
    monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)

    _run(alerting.evaluate())

    assert [row for row in sent] == ["admin"]
    assert {cid: client.calls for cid, client in clients.items()} == {
        "a": 0,
        "b": 1,
        "c": 0,
    }


def test_star_rules_still_read_every_connection(db, monkeypatch) -> None:
    """``*`` 规则覆盖所有机器：每条连接都要读，不能按「目标」省掉。"""
    sent: List[str] = []
    sources = {"a": [_vm(100, "vm-a")], "b": [_vm(200, "vm-b")]}
    clients = {cid: _FakeClient(res) for cid, res in sources.items()}
    monkeypatch.setattr(
        alerting,
        "all_connection_clients",
        lambda: [({"id": cid}, client) for cid, client in clients.items()],
    )
    monkeypatch.setattr(alerting, "requested_connection", lambda: "")
    monkeypatch.setattr(alerting, "load_rules", lambda: _as_list([_rule()]))

    async def fake_dispatch(owner, feishu, email_cfg, title, text, card,
                            webhook=None, context=None, source=""):
        sent.append(owner)
        return True, "已发送"

    async def fake_ip(client, node, vmid):
        return ""

    monkeypatch.setattr(alerting, "dispatch", fake_dispatch)
    monkeypatch.setattr(alerting, "resolve_vm_ip", fake_ip)

    _run(alerting.evaluate())

    assert {cid: client.calls for cid, client in clients.items()} == {"a": 1, "b": 1}


def test_new_account_cannot_pull_alerts_from_someone_elses_machine(db, monkeypatch) -> None:
    """普通用户手写一个别人的 ref：既不触发，也不把别人的告警拉进自己的页面。"""
    _make_user("bob")

    async def seed() -> None:
        await ownership.set_owner(
            ownership.KIND_VM, ownership.vm_ref("a", "pve", 101), "alice"
        )

    _run(seed())

    sent: List[str] = []
    sources = {"a": [_vm(101, "alice-vm")]}
    rules = [_rule(id="b1", username="bob", target="a:pve:101")]
    _wire_multi(monkeypatch, sources, rules, sent)

    _run(alerting.evaluate())

    assert sent == []
    assert _run(alerting.history(50)) == []
