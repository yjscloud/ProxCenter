"""frp 穿透规则的写入防线（V2-01）。

被修的漏洞：任何 ``frp.manage`` 用户都能建一条指向**任意内网目标**的规则
（``local_ip`` 想填什么填什么），改完立即重启 frpc 生效，且增删改都不需要
二次确认 —— 面板因此成了现成的内网端口转发器。现在三道闸都在
:mod:`app.frpguard` 里，这里覆盖它们的判定边界：

* 目标：回环 / 未指定 / 链路本地 / 组播 / 保留地址、面板自身地址、别人的机器
  与未放行网段一律拒绝；自己名下的机器与管理员放行的网段放行；
* 端口：只能落在管理员设定的区间内（默认 40000–50000）、关键端口不可占用、
  不可与其它规则撞车；
* 请求体：``{}`` / 缺字段不再被默认值填成一条 ``127.0.0.1:80 -> 10000``。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import frpguard, guestip, ownership, pve  # noqa: E402
from app.config import settings  # noqa: E402
from app.schemas import FrpRuleIn, FrpRuleUpdateIn  # noqa: E402
from test_api_routes import (  # noqa: E402,F401
    api,
    auth_headers,
    user_with_permissions,
)


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch: pytest.MonkeyPatch):
    """每条用例都从「没有白名单 / 阻止面板网段」的干净配置出发。"""
    monkeypatch.setattr(settings, "frp_allow_local_cidrs", "", raising=False)
    monkeypatch.setattr(settings, "frp_block_panel_subnet", True, raising=False)
    yield


def _check_target(value, *, username="alice", is_admin=False):
    return asyncio.run(
        frpguard.check_target(value, username=username, is_admin=is_admin)
    )


# ------------------------------------------------------------------ 端口策略
def test_port_outside_range_is_rejected() -> None:
    for port in (39999, 50001, 22, 0, -1, 8080):
        with pytest.raises(frpguard.PolicyError) as err:
            frpguard.check_remote_port(port, [])
        assert err.value.status_code == 400


def test_critical_ports_are_named_explicitly() -> None:
    """区间已覆盖这些端口，但仍要有专门的一句（区间被调整时不会误放）。"""
    for port in (22, 80, 443, 7001, 8006):
        assert port in frpguard.FORBIDDEN_REMOTE_PORTS
    with pytest.raises(frpguard.PolicyError):
        frpguard.check_remote_port(22, [])


def test_port_conflict_is_rejected_but_self_is_excluded() -> None:
    rules = [
        {"id": "r1", "name": "tunnel-1", "username": "bob", "remote_port": 40001},
    ]
    with pytest.raises(frpguard.PolicyError) as err:
        frpguard.check_remote_port(40001, rules)
    assert err.value.status_code == 409
    # 改自己那条规则时，原端口不算冲突
    assert frpguard.check_remote_port(40001, rules, exclude_id="r1") == 40001
    assert frpguard.check_remote_port(40002, rules) == 40002


def test_first_free_port_skips_used_ones() -> None:
    rules = [{"remote_port": frpguard.REMOTE_PORT_MIN}]
    assert frpguard.first_free_port(rules) == frpguard.REMOTE_PORT_MIN + 1
    assert frpguard.used_remote_ports(rules) == [frpguard.REMOTE_PORT_MIN]


def test_port_range_defaults_follow_environment(monkeypatch) -> None:
    monkeypatch.setattr(settings, "frp_remote_port_min", 20000, raising=False)
    monkeypatch.setattr(settings, "frp_remote_port_max", 20100, raising=False)
    assert frpguard.default_port_range() == (20000, 20100)
    # 自定义区间同样要过黑名单
    with pytest.raises(frpguard.PolicyError):
        frpguard.check_remote_port(40000, [])
    assert frpguard.check_remote_port(20000, []) == 20000
    assert frpguard.first_free_port([]) == 20000

    # 环境配置写反了：回落内置默认值，不让所有规则写入直接 500
    monkeypatch.setattr(settings, "frp_remote_port_min", 30000, raising=False)
    monkeypatch.setattr(settings, "frp_remote_port_max", 20000, raising=False)
    assert frpguard.default_port_range() == (
        frpguard.REMOTE_PORT_MIN,
        frpguard.REMOTE_PORT_MAX,
    )


def test_port_range_validation() -> None:
    assert frpguard.normalise_port_range(40000, 50000) == (40000, 50000)
    assert frpguard.normalise_port_range("1024", "65535") == (1024, 65535)
    for bad in ((50000, 40000), (0, 100), (1, 70000), ("x", 100)):
        with pytest.raises(frpguard.PolicyError):
            frpguard.normalise_port_range(*bad)
    # 整段都是关键端口：谁也建不出规则，保存时就要拒绝
    with pytest.raises(frpguard.PolicyError):
        frpguard.normalise_port_range(22, 22)


def test_check_remote_port_accepts_explicit_range() -> None:
    assert frpguard.check_remote_port(20000, [], port_range=(20000, 20100)) == 20000
    with pytest.raises(frpguard.PolicyError):
        frpguard.check_remote_port(40000, [], port_range=(20000, 20100))


# ------------------------------------------------------------------ 目标地址
def test_invalid_addresses_are_rejected() -> None:
    for value in ("", "   ", "localhost", "10.0.0.256", "1.2.3", "http://10.0.0.1"):
        with pytest.raises(frpguard.PolicyError):
            frpguard.parse_ip(value)


def test_ipv6_brackets_are_tolerated() -> None:
    assert frpguard.parse_ip("[fd00::5]") == frpguard.parse_ip("fd00::5")


def test_loopback_and_link_local_are_rejected_for_users(monkeypatch) -> None:
    async def _none(_username: str) -> set:
        return set()

    monkeypatch.setattr(frpguard, "own_guest_ips", _none)
    for value in ("127.0.0.1", "::1", "169.254.10.10", "fe80::1", "224.0.0.1", "::ffff:10.0.0.1"):
        with pytest.raises(frpguard.PolicyError):
            _check_target(value)


def test_unspecified_address_is_rejected_even_for_admin() -> None:
    with pytest.raises(frpguard.PolicyError):
        _check_target("0.0.0.0", is_admin=True)
    with pytest.raises(frpguard.PolicyError):
        _check_target("::", is_admin=True)


def test_admin_bypasses_whitelist(monkeypatch) -> None:
    async def _none(_username: str) -> set:
        return set()

    monkeypatch.setattr(frpguard, "own_guest_ips", _none)
    assert _check_target("127.0.0.1", is_admin=True) == "127.0.0.1"
    assert _check_target("10.9.9.9", is_admin=True) == "10.9.9.9"


def test_panel_own_address_is_rejected_even_when_allowlisted(monkeypatch) -> None:
    monkeypatch.setattr(frpguard, "local_addresses", lambda: {"192.0.2.10"})
    monkeypatch.setattr(settings, "frp_allow_local_cidrs", "192.0.2.0/24")

    async def _none(_username: str) -> set:
        return set()

    monkeypatch.setattr(frpguard, "own_guest_ips", _none)
    with pytest.raises(frpguard.PolicyError) as err:
        _check_target("192.0.2.10")
    assert err.value.status_code == 403


def test_allowlisted_cidr_is_accepted(monkeypatch) -> None:
    monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
    monkeypatch.setattr(frpguard, "panel_networks", lambda: [])
    monkeypatch.setattr(settings, "frp_allow_local_cidrs", "10.20.0.0/16")

    async def _none(_username: str) -> set:
        return set()

    monkeypatch.setattr(frpguard, "own_guest_ips", _none)
    assert _check_target("10.20.7.8") == "10.20.7.8"


def test_panel_subnet_blocks_allowlisted_target(monkeypatch) -> None:
    import ipaddress

    monkeypatch.setattr(frpguard, "local_addresses", lambda: {"10.0.0.2"})
    monkeypatch.setattr(
        frpguard, "panel_networks", lambda: [ipaddress.ip_network("10.0.0.0/24")]
    )
    monkeypatch.setattr(settings, "frp_allow_local_cidrs", "10.0.0.0/24")

    async def _none(_username: str) -> set:
        return set()

    monkeypatch.setattr(frpguard, "own_guest_ips", _none)
    with pytest.raises(frpguard.PolicyError):
        _check_target("10.0.0.9")

    # 关掉这个开关后允许（面板自身地址仍然由上面的 local_addresses 拦）
    monkeypatch.setattr(settings, "frp_block_panel_subnet", False, raising=False)
    assert _check_target("10.0.0.9") == "10.0.0.9"


def test_block_panel_subnet_follows_saved_setting(monkeypatch) -> None:
    """页面上的开关落在 settings 表后，以保存值为准（优先于环境配置）。"""

    async def _saved_off(key, default=None):
        assert key == frpguard.BLOCK_PANEL_SUBNET_KEY
        return "0"

    monkeypatch.setattr(settings, "frp_block_panel_subnet", True, raising=False)
    monkeypatch.setattr(frpguard.store, "get_setting", _saved_off)
    assert asyncio.run(frpguard.block_panel_subnet_enabled()) is False

    async def _saved_on(key, default=None):
        return "1"

    monkeypatch.setattr(frpguard.store, "get_setting", _saved_on)
    assert asyncio.run(frpguard.block_panel_subnet_enabled()) is True


def test_block_panel_subnet_falls_back_to_env(monkeypatch) -> None:
    """没保存过 / 读不到（比如库暂不可用）时回落环境配置，不能挂掉校验。"""

    async def _missing(key, default=None):
        return default  # None = 没写过这个键

    monkeypatch.setattr(settings, "frp_block_panel_subnet", True, raising=False)
    monkeypatch.setattr(frpguard.store, "get_setting", _missing)
    assert asyncio.run(frpguard.block_panel_subnet_enabled()) is True

    async def _broken(key, default=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(frpguard.store, "get_setting", _broken)
    monkeypatch.setattr(settings, "frp_block_panel_subnet", False, raising=False)
    assert asyncio.run(frpguard.block_panel_subnet_enabled()) is False


def test_own_guest_ip_is_accepted(monkeypatch) -> None:
    monkeypatch.setattr(frpguard, "local_addresses", lambda: {"10.0.0.2"})
    monkeypatch.setattr(frpguard, "panel_networks", lambda: [])

    async def _own(_username: str) -> set:
        return {"10.0.0.25"}

    monkeypatch.setattr(frpguard, "own_guest_ips", _own)
    assert _check_target("10.0.0.25") == "10.0.0.25"


def test_other_peoples_machine_is_rejected(monkeypatch) -> None:
    monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
    monkeypatch.setattr(frpguard, "panel_networks", lambda: [])

    async def _own(_username: str) -> set:
        return {"10.0.0.25"}

    monkeypatch.setattr(frpguard, "own_guest_ips", _own)
    with pytest.raises(frpguard.PolicyError) as err:
        _check_target("10.0.0.26")
    assert err.value.status_code == 403


def test_own_guest_targets_carry_display_fields(monkeypatch) -> None:
    """下拉要用的那条数据：IP + 名字 + VMID + 类型，且只含自己名下的机器。"""

    async def _owned(_username: str) -> set:
        return {"c1:pve:105", "c1:pve:106"}

    class _Pve:
        async def cluster_resources(self, kind: str):
            return [
                {"type": "qemu", "node": "pve", "vmid": 105, "name": "web-01", "status": "running"},
                {"type": "lxc", "node": "pve", "vmid": 106, "name": "cache", "status": "running"},
                {"type": "qemu", "node": "pve", "vmid": 107, "name": "not-mine", "status": "running"},
            ]

    async def _resolve(_client, guest):
        return {105: "10.0.0.25", 106: "10.0.0.26"}.get(int(guest["vmid"]), "")

    monkeypatch.setattr(ownership, "list_owned_guests", _owned)
    monkeypatch.setattr(pve, "all_connection_clients", lambda: [({"id": "c1"}, _Pve())])
    monkeypatch.setattr(guestip, "resolve", _resolve)

    out = asyncio.run(frpguard.own_guest_targets("alice"))
    assert [item["ip"] for item in out] == ["10.0.0.25", "10.0.0.26"]
    assert out[0] == {
        "ip": "10.0.0.25",
        "name": "web-01",
        "vmid": 105,
        "node": "pve",
        "type": "qemu",
    }
    assert out[1]["type"] == "lxc"
    # check_target 用的投影与下拉同源
    assert asyncio.run(frpguard.own_guest_ips("alice")) == {"10.0.0.25", "10.0.0.26"}


def test_failure_to_resolve_ownership_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(frpguard, "local_addresses", lambda: set())

    async def _boom(_username: str) -> set:
        raise RuntimeError("PVE 挂了")

    monkeypatch.setattr(frpguard, "own_guest_ips", _boom)
    with pytest.raises(frpguard.PolicyError):
        _check_target("10.0.0.25")


# ------------------------------------------------------------------ 请求体
def test_empty_body_is_not_filled_with_defaults() -> None:
    """``{}`` 不再被填成 127.0.0.1:80 -> 10000：缺字段直接校验失败。"""
    with pytest.raises(ValidationError):
        FrpRuleIn.model_validate({})
    with pytest.raises(ValidationError):
        FrpRuleUpdateIn.model_validate({})
    with pytest.raises(ValidationError):
        FrpRuleIn.model_validate({"name": "tunnel-1"})


def test_rule_payload_is_strictly_validated() -> None:
    ok = FrpRuleIn(
        name="tunnel-1",
        local_ip="10.0.0.25",
        local_port=8080,
        remote_port=40000,
    )
    assert ok.type == "tcp"

    for bad in (
        {"name": "bad name", "local_ip": "10.0.0.25", "local_port": 8080, "remote_port": 40000},
        {"name": "-x", "local_ip": "10.0.0.25", "local_port": 8080, "remote_port": 40000},
        {"name": "t", "local_ip": "not-an-ip", "local_port": 8080, "remote_port": 40000},
        {"name": "t", "local_ip": "0.0.0.0", "local_port": 8080, "remote_port": 40000},
        {"name": "t", "local_ip": "10.0.0.25", "local_port": 0, "remote_port": 40000},
        {"name": "t", "local_ip": "10.0.0.25", "local_port": 8080, "remote_port": 70000},
    ):
        with pytest.raises(ValidationError):
            FrpRuleIn.model_validate(bad)


# ------------------------------------------------------------- 接口层（end-to-end）
RULE = {
    "name": "tunnel-1",
    "type": "tcp",
    "local_ip": "10.0.0.5",
    "local_port": 8080,
    "remote_port": 40000,
}


class TestFrpRuleApi:
    """真实路由验证：参数校验、白名单、端口冲突、二次确认。

    目标白名单只对普通用户生效，所以「不许指向任意内网主机」那条必须用一个
    只带 ``frp.view`` / ``frp.manage`` 的账号来打。
    """

    def test_empty_body_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        resp = api.post("/api/frp/rules", headers=headers, json={})
        assert resp.status_code == 422

    def test_update_requires_all_fields(self, api) -> None:
        headers = auth_headers(api)
        created = api.post("/api/frp/rules", headers=headers, json=RULE)
        assert created.status_code == 200, created.text
        rule_id = created.json()["id"]

        # 只传名字 → 422（不再「沿用旧值」）
        resp = api.put(f"/api/frp/rules/{rule_id}", headers=headers, json={"name": "renamed"})
        assert resp.status_code == 422

    def test_port_outside_tcp_range_is_rejected_at_the_edge(self, api) -> None:
        """超出 1–65535 由 Pydantic 直接 422。"""
        headers = auth_headers(api)
        resp = api.post(
            "/api/frp/rules", headers=headers, json={**RULE, "remote_port": 70000}
        )
        assert resp.status_code == 422

    def test_port_outside_policy_range_is_rejected(self, api) -> None:
        """8080 是合法端口但不在默认区间里：由策略层给出中文原因（400）。"""
        headers = auth_headers(api)
        resp = api.post(
            "/api/frp/rules", headers=headers, json={**RULE, "remote_port": 8080}
        )
        assert resp.status_code == 400
        assert "40000" in resp.json()["detail"]

    def test_port_conflict_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        assert api.post("/api/frp/rules", headers=headers, json=RULE).status_code == 200
        dup = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "name": "tunnel-2"},
        )
        assert dup.status_code == 409

    def test_user_cannot_target_arbitrary_internal_host(self, api, monkeypatch) -> None:
        # 固定「面板自身网段」与「本机地址」，免得断言依赖跑测试的机器
        monkeypatch.setattr(frpguard, "panel_networks", lambda: [])
        monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
        headers = user_with_permissions(
            api, ["frp.view", "frp.manage"], "frp-user"
        )
        resp = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "local_ip": "203.0.113.9"},
        )
        assert resp.status_code == 403
        assert "允许范围" in resp.json()["detail"]

    def test_user_cannot_target_loopback(self, api, monkeypatch) -> None:
        monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
        headers = user_with_permissions(
            api, ["frp.view", "frp.manage"], "frp-user2"
        )
        resp = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "local_ip": "127.0.0.1"},
        )
        assert resp.status_code == 403

    def test_rule_writes_need_step_up(self, api, monkeypatch) -> None:
        monkeypatch.setattr(settings, "step_up_required", True, raising=False)
        headers = auth_headers(api)
        created = api.post("/api/frp/rules", headers=headers, json=RULE)
        assert created.status_code == 403
        assert created.headers.get("X-Step-Up") == "required"

    def test_policy_reports_limits_and_used_ports(self, api) -> None:
        headers = auth_headers(api)
        assert api.post("/api/frp/rules", headers=headers, json=RULE).status_code == 200

        body = api.get("/api/frp/policy", headers=headers).json()
        assert body["remote_port_min"] == frpguard.REMOTE_PORT_MIN
        assert body["remote_port_max"] == frpguard.REMOTE_PORT_MAX
        assert body["restricted"] is False  # admin
        assert RULE["remote_port"] in body["used_remote_ports"]
        assert body["default_remote_port"] == frpguard.REMOTE_PORT_MIN + 1

    def test_admin_can_change_port_range(self, api) -> None:
        """区间可调：改完立刻影响新规则，老区间不再放行。"""
        headers = auth_headers(api)
        resp = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 20000, "remote_port_max": 20100},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["remote_port_min"] == 20000

        body = api.get("/api/frp/policy", headers=headers).json()
        assert (body["remote_port_min"], body["remote_port_max"]) == (20000, 20100)
        assert body["default_remote_port"] == 20000

        inside = api.post(
            "/api/frp/rules", headers=headers, json={**RULE, "remote_port": 20000}
        )
        assert inside.status_code == 200, inside.text

        outside = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "name": "tunnel-2", "remote_port": 40000},
        )
        assert outside.status_code == 400
        assert "20000" in outside.json()["detail"]

    def test_narrowing_port_range_keeps_existing_rules(self, api) -> None:
        headers = auth_headers(api)
        assert api.post("/api/frp/rules", headers=headers, json=RULE).status_code == 200

        resp = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 20000, "remote_port_max": 20100},
        )
        assert resp.status_code == 200, resp.text
        # 已有规则仍然在列表里（不会因为区间收窄被删），但要提示管理员
        assert RULE["remote_port"] in resp.json()["out_of_range_ports"]
        rules = api.get("/api/frp/rules", headers=headers).json()["rules"]
        assert [r["remote_port"] for r in rules] == [RULE["remote_port"]]

    def test_invalid_port_range_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        reversed_range = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 50000, "remote_port_max": 40000},
        )
        assert reversed_range.status_code == 400

        all_forbidden = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 22, "remote_port_max": 22},
        )
        assert all_forbidden.status_code == 400

        zero = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 0, "remote_port_max": 100},
        )
        assert zero.status_code == 422

    def test_only_admin_can_change_port_range(self, api) -> None:
        headers = user_with_permissions(api, ["frp.view", "frp.manage"], "frp-user3")
        resp = api.put(
            "/api/frp/policy/port-range",
            headers=headers,
            json={"remote_port_min": 20000, "remote_port_max": 20100},
        )
        assert resp.status_code == 403

    def test_owned_target_can_be_used_and_others_cannot(self, api, monkeypatch) -> None:
        """下拉里的那一个能建，别的地址一律 403 —— 两条路走同一份判定。"""
        target = {
            "ip": "10.0.0.25",
            "name": "web-01",
            "vmid": 105,
            "node": "pve",
            "type": "qemu",
        }

        async def _targets(_username: str):
            return [target]

        async def _ips(_username: str) -> set:
            return {target["ip"]}

        monkeypatch.setattr(frpguard, "own_guest_targets", _targets)
        monkeypatch.setattr(frpguard, "own_guest_ips", _ips)
        monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
        monkeypatch.setattr(frpguard, "panel_networks", lambda: [])

        headers = user_with_permissions(
            api, ["frp.view", "frp.manage"], "frp-owner"
        )
        policy = api.get("/api/frp/policy", headers=headers).json()
        assert policy["targets"] == [target]
        assert policy["own_ips"] == ["10.0.0.25"]

        ok = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "local_ip": "10.0.0.25"},
        )
        assert ok.status_code == 200, ok.text

        denied = api.post(
            "/api/frp/rules",
            headers=headers,
            json={**RULE, "name": "tunnel-2", "local_ip": "10.0.0.26"},
        )
        assert denied.status_code == 403

    def test_policy_is_restricted_for_ordinary_users(self, api) -> None:
        headers = user_with_permissions(
            api, ["frp.view", "frp.manage"], "frp-user3"
        )
        body = api.get("/api/frp/policy", headers=headers).json()
        assert body["restricted"] is True
        assert body["targets"] == []  # 名下没有归属机器 → 下拉无选项
        assert body["granted"] == []
        assert body["own_ips"] == []
        assert body["used_remote_ports"] == []


# ---------------------------------------------------------------- 用户授权
class TestFrpGrants:
    """管理员按人放行目标 IP：授权立即进对方的下拉，撤销后立刻失效。"""

    def _no_own_machines(self, monkeypatch) -> None:
        async def _none(_username: str):
            return []

        async def _no_ips(_username: str) -> set:
            return set()

        monkeypatch.setattr(frpguard, "own_guest_targets", _none)
        monkeypatch.setattr(frpguard, "own_guest_ips", _no_ips)
        monkeypatch.setattr(frpguard, "local_addresses", lambda: set())
        monkeypatch.setattr(frpguard, "panel_networks", lambda: [])

    def test_grant_then_revoke(self, api, monkeypatch) -> None:
        self._no_own_machines(monkeypatch)
        admin = auth_headers(api)
        user = user_with_permissions(api, ["frp.view", "frp.manage"], "alice")
        payload = {**RULE, "local_ip": "203.0.113.7"}

        # 授权前：策略里没有 granted，建规则 403
        assert api.get("/api/frp/policy", headers=user).json()["granted"] == []
        assert api.post("/api/frp/rules", headers=user, json=payload).status_code == 403

        added = api.post(
            "/api/frp/grants",
            headers=admin,
            json={"username": "alice", "value": "203.0.113.7"},
        )
        assert added.status_code == 200, added.text
        assert added.json()["entries"] == ["203.0.113.7"]

        listed = api.get("/api/frp/grants", headers=admin).json()
        assert {"username": "alice", "value": "203.0.113.7", "kind": "ip"} in listed["items"]
        assert "alice" in listed["users"]

        # 授权后：下拉拿得到，规则建得成
        assert api.get("/api/frp/policy", headers=user).json()["granted"] == [
            "203.0.113.7"
        ]
        ok = api.post("/api/frp/rules", headers=user, json=payload)
        assert ok.status_code == 200, ok.text

        # 撤销后：存量规则还在，但不能再拿这个地址建新规则
        removed = api.delete(
            "/api/frp/grants",
            headers=admin,
            params={"username": "alice", "value": "203.0.113.7"},
        )
        assert removed.status_code == 200
        assert removed.json()["entries"] == []
        again = api.post(
            "/api/frp/rules",
            headers=user,
            json={**payload, "name": "tunnel-2"},
        )
        assert again.status_code == 403

    def test_grant_accepts_a_network(self, api, monkeypatch) -> None:
        self._no_own_machines(monkeypatch)
        admin = auth_headers(api)
        user = user_with_permissions(api, ["frp.view", "frp.manage"], "bob")
        added = api.post(
            "/api/frp/grants",
            headers=admin,
            json={"username": "bob", "value": "203.0.113.0/24"},
        )
        assert added.status_code == 200, added.text
        assert added.json()["entries"] == ["203.0.113.0/24"]
        ok = api.post(
            "/api/frp/rules",
            headers=user,
            json={**RULE, "local_ip": "203.0.113.42"},
        )
        assert ok.status_code == 200, ok.text

    def test_dangerous_targets_cannot_be_granted(self, api) -> None:
        admin = auth_headers(api)
        for bad in ("127.0.0.1", "0.0.0.0", "169.254.1.1", "10.0.0.0/0", "not-an-ip"):
            resp = api.post(
                "/api/frp/grants",
                headers=admin,
                json={"username": "admin", "value": bad},
            )
            assert resp.status_code == 400, (bad, resp.text)

    def test_grants_are_admin_only(self, api) -> None:
        user = user_with_permissions(api, ["frp.view", "frp.manage"], "carol")
        assert api.get("/api/frp/grants", headers=user).status_code == 403
        assert (
            api.post(
                "/api/frp/grants",
                headers=user,
                json={"username": "carol", "value": "203.0.113.9"},
            ).status_code
            == 403
        )

    def test_grant_needs_an_existing_user(self, api) -> None:
        admin = auth_headers(api)
        resp = api.post(
            "/api/frp/grants",
            headers=admin,
            json={"username": "nobody-here", "value": "203.0.113.9"},
        )
        assert resp.status_code == 404
