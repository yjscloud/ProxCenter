"""「机器归谁，告警就找谁」——告警收件人跟机器归属走，不跟配规则的人走。

为什么这条线要单独钉
--------------------
原来的口径是「谁配的规则，告警发给谁」。它有一个很难发现的失效方式：管理员给
「全部虚拟机」配一条规则（他看得见所有机器），于是所有人机器的告警都堆进管理员
一个人的通道；反过来，机器换了主人而规则没人改，告警还会继续发给前任主人 ——
告警页里全是「别人的机器」，真正该处理的人什么都收不到。

这里钉住四件事：
1. 有归属的机器：收件人 = 归属者（历史与站内消息也记在他名下）；
2. 没有归属 / 归属账号已被删除：回落给配规则的人，不能让告警谁都不收到；
3. 受管主机同理（端口巡检、远程 SSH），本机没有归属，仍是兜底接收人；
4. 升级交接：记在旧收件人名下的活动告警要改挂到新 key，否则同一台机器会同时
   收到一条新告警和一条「已恢复」。

模块层用 ``asyncio.run`` + ``db`` 夹具（只建表、不起 app），与 test_alert_notify
同一套写法：TestClient 的全局连接池绑在它自己的事件循环上，不能混用。
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app import alerting, database, notifications, ownership, security, store  # noqa: E402

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
    """只建表、不启动 app：用户 / 归属 / 告警三张表都要在。"""
    _run(store.init_db())
    # 内置角色由 app 启动时补齐（security.load_roles）；这里不起 app，得自己补，
    # 否则 store.create_user 会以「角色 operator 不存在」拒绝建号。
    _run(security.load_roles())
    _run(ownership.init_table())
    _run(alerting.init_table())
    _run(notifications.init_table())
    yield


# ---------------------------------------------------------------- 归属解析
async def _make_user(username: str) -> None:
    if await store.get_user(username) is None:
        await store.create_user(username, PASSWORD, "operator", "")


def _ref(conn: str, node: str, vmid: int) -> str:
    return ownership.vm_ref(conn, node, vmid)


def test_guest_alert_goes_to_the_machine_owner(db) -> None:
    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")
        res = {"type": "qemu", "node": "pve", "vmid": 100, "name": "vm-a"}

        book = alerting.RecipientBook()
        assert await book.guest_recipient("admin", res) == "alice"

    _run(main())


def test_container_ownership_is_honoured_too(db) -> None:
    """容器与虚拟机是两套归属记录（kind 不同），路由要一起认。"""

    async def main() -> None:
        await _make_user("bob")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_CT, _ref(conn, "pve", 200), "bob")
        res = {"type": "lxc", "node": "pve", "vmid": 200, "name": "ct-a"}

        assert await alerting.RecipientBook().guest_recipient("admin", res) == "bob"

    _run(main())


def test_unowned_machine_falls_back_to_the_rule_owner(db) -> None:
    """面板之外建的机器没有归属记录：宁可发给配规则的人，也不能谁都不发。"""

    async def main() -> None:
        await _make_user("alice")
        res = {"type": "qemu", "node": "pve", "vmid": 900, "name": "orphan"}
        assert await alerting.RecipientBook().guest_recipient("admin", res) == "admin"

    _run(main())


def test_deleted_owner_falls_back_instead_of_going_nowhere(db) -> None:
    """归属记录指向一个已删除的账号：发给他等于把告警丢进黑洞。"""

    async def main() -> None:
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 101), "ghost")
        res = {"type": "qemu", "node": "pve", "vmid": 101, "name": "vm-b"}
        assert await alerting.RecipientBook().guest_recipient("admin", res) == "admin"

    _run(main())


def test_node_has_no_owner(db) -> None:
    """宿主机是集群基础设施，不属于任何用户，仍按规则归属投递。"""

    async def main() -> None:
        res = {"type": "node", "node": "pve", "status": "online"}
        assert await alerting.RecipientBook().guest_recipient("admin", res) == "admin"

    _run(main())


def test_host_alert_goes_to_the_host_owner(db) -> None:
    async def main() -> None:
        await _make_user("carol")
        await ownership.set_owner(ownership.KIND_SSH_HOST, "host-1", "carol")
        book = alerting.RecipientBook()

        assert await book.host_recipient("admin", "host-1") == "carol"
        # 面板本机没有归属，也不是任何用户的机器
        assert await book.host_recipient("admin", "local") == "admin"
        # 主机没有归属记录
        assert await book.host_recipient("admin", "host-unknown") == "admin"

    _run(main())


def test_the_book_reads_the_ownership_table_once(db) -> None:
    """一轮巡检里同一批机器只查一次库（规则 × 机器的量级会被反复命中）。"""

    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")
        book = alerting.RecipientBook()

        calls = {"n": 0}
        original = ownership.guest_owners_map

        async def counting() -> Dict[str, str]:
            calls["n"] += 1
            return await original()

        ownership.guest_owners_map = counting  # type: ignore[assignment]
        try:
            for vmid in (100, 100, 100):
                res = {"type": "qemu", "node": "pve", "vmid": vmid, "name": "vm-a"}
                assert await book.guest_recipient("admin", res) == "alice"
        finally:
            ownership.guest_owners_map = original  # type: ignore[assignment]

        assert calls["n"] == 1

    _run(main())


# ---------------------------------------------------------------- 升级交接
def test_active_row_is_rehomed_to_the_new_recipient(db) -> None:
    """旧行（记在配规则的人名下）接到新 key 上，冷却与邮件计数一并带过去。

    不接的话：新 key 在库里查不到 → 这台机器同时产生一条新告警和一条「已恢复」，
    而且「已恢复」的时间戳更新，看起来像告警刚响就自己好了。
    """

    async def main() -> None:
        old_key = alerting.alarm_key("admin", "r1", "vm-a")
        await alerting.mark_active(
            old_key,
            {
                "username": "admin",
                "rule_id": "r1",
                "target_type": "vm",
                "target": "vm-a",
                "ts": 1_700_000_000,
                "notify_source": alerting.SOURCE_RESOURCE,
            },
        )
        await alerting.mark_mail_sent(old_key, 1_700_000_100, 2)
        active = await alerting.load_active()

        moved = await alerting.adopt_active(active, "admin", "alice", "r1", "vm-a")

        assert moved["username"] == "alice"
        assert moved["ts"] == 1_700_000_000
        new_key = alerting.alarm_key("alice", "r1", "vm-a")
        rows = await alerting.load_active()
        assert old_key not in rows
        assert rows[new_key]["username"] == "alice"
        assert int(rows[new_key]["mail_count"]) == 2
        assert int(rows[new_key]["mail_ts"]) == 1_700_000_100

        # 再调一次是空操作（幂等）：老 key 已经不在了
        assert await alerting.adopt_active(rows, "admin", "alice", "r1", "vm-a") == {}

    _run(main())


# ---------------------------------------------------------------- 端到端
class _FakeConn:
    configured = True
    host = "10.0.0.1"


class _FakeClient:
    """只实现告警评估用到的那几处。"""

    def __init__(self, resources: List[Dict[str, Any]]) -> None:
        self.conn = _FakeConn()
        self._resources = resources

    async def cluster_resources(self) -> List[Dict[str, Any]]:
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


def _vm(vmid: int, name: str, cpu: float = 0.95) -> Dict[str, Any]:
    return {
        "type": "qemu",
        "node": "pve",
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


def _wire_evaluate(monkeypatch, resources: List[Dict[str, Any]], rules, sent: List[str]) -> None:
    """把 PVE 读数与投递换成桩，只观察「发给了谁」。"""
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


async def _as_list(rules):
    return rules


def test_evaluate_delivers_to_each_machine_owner(db, monkeypatch) -> None:
    """一条管理员配的「全部虚拟机」规则：告警按每台机器的归属分开投递。"""

    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")

    _run(main())

    sent: List[str] = []
    resources = [_vm(100, "vm-a"), _vm(102, "vm-orphan")]
    _wire_evaluate(monkeypatch, resources, [_rule()], sent)

    _run(alerting.evaluate())

    # 属于 alice 的机器发给 alice；没有归属的那台回落到配规则的管理员
    assert sorted(sent) == ["admin", "alice"]

    rows = _run(alerting.history(50))
    by_target = {row["target"]: row["username"] for row in rows}
    assert by_target == {"vm-a": "alice", "vm-orphan": "admin"}

    # 站内消息同样记在收件人名下，否则铃铛响了却查不到是谁的事
    assert _run(notifications.unread_count("alice")) == 1
    assert _run(notifications.unread_count("admin")) == 1


def test_recovery_goes_back_to_the_same_recipient(db, monkeypatch) -> None:
    """恢复通知原路返回：同一条链路的收尾，不按规则归属另发一份。"""

    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")

    _run(main())

    sent: List[str] = []
    _wire_evaluate(monkeypatch, [_vm(100, "vm-a")], [_rule()], sent)
    _run(alerting.evaluate())
    assert sent == ["alice"]

    # 机器回落：连续 N 轮正常才确认恢复（见 RECOVERY_CONFIRM_CYCLES）
    sent.clear()
    resources = [_vm(100, "vm-a", cpu=0.10)]
    _wire_evaluate(monkeypatch, resources, [_rule()], sent)
    for _ in range(alerting.RECOVERY_CONFIRM_CYCLES):
        _run(alerting.evaluate())

    assert sent == ["alice"]
    assert _run(alerting.load_active()) == {}
    kinds = [(row["kind"], row["username"]) for row in _run(alerting.history(50))]
    assert ("recovery", "alice") in kinds


def test_second_round_reuses_the_machine_owner_state(db, monkeypatch) -> None:
    """同一台机器持续告警：第二轮走冷却、不写第二条历史（收件人口径没变）。"""

    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")

    _run(main())

    sent: List[str] = []
    _wire_evaluate(monkeypatch, [_vm(100, "vm-a")], [_rule()], sent)
    _run(alerting.evaluate())
    _run(alerting.evaluate())

    assert sent == ["alice"], "冷却期内不该再发"
    rows = _run(alerting.history(50))
    assert len(rows) == 1
    assert rows[0]["username"] == "alice"
    active = _run(alerting.load_active())
    assert [row["username"] for row in active.values()] == ["alice"]


def test_legacy_state_does_not_fire_a_second_alert(db, monkeypatch) -> None:
    """升级瞬间：旧行在「配规则的人」名下，机器仍在告警 —— 只接管，不重复告警。"""

    async def main() -> None:
        await _make_user("alice")
        conn = str(store.get_active_connection_id() or "")
        await ownership.set_owner(ownership.KIND_VM, _ref(conn, "pve", 100), "alice")
        now = int(time.time())
        old_key = alerting.alarm_key("admin", "r1", "vm-a")
        await alerting.mark_active(
            old_key,
            {
                "username": "admin",
                "rule_id": "r1",
                "rule_name": "CPU 高负载",
                "target_type": "vm",
                "target": "vm-a",
                "metric": "cpu",
                "value": 95.0,
                "threshold": 80.0,
                "node": "pve",
                "vmid": 100,
                "ts": now,
                "notify_source": alerting.SOURCE_RESOURCE,
            },
        )
        # 邮件提醒已经发满（否则「第一封一定发」会让这一轮再补一封，
        # 那属于邮件通道自己的节奏，与这里验证的「不重复告警」无关）
        await alerting.mark_mail_sent(old_key, now, 3)

    _run(main())

    sent: List[str] = []
    _wire_evaluate(monkeypatch, [_vm(100, "vm-a")], [_rule()], sent)
    _run(alerting.evaluate())

    assert sent == [], "冷却还没到点，不该因为换了 key 就再响一次"
    rows = _run(alerting.load_active())
    assert alerting.alarm_key("admin", "r1", "vm-a") not in rows
    # 新 key 的对象身份是「连接 + 节点 + VMID」（见 alerting.alarm_subject）
    moved = rows[alerting.alarm_key("alice", "r1", "-:pve:100")]
    assert moved["username"] == "alice"
