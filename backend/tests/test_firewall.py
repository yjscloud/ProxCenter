"""防火墙回归：三级规则读写、选项、安全组、IP 集合、规则模板批量下发与权限。

用 ``test_api_routes`` 的 ``api`` fixture（真实 FastAPI + mock Proxmox + 空测试库），
所以既验证面板侧的校验 / 权限 / 审计，也验证发给 Proxmox 的请求形状。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Dict

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app.config import settings  # noqa: E402
from test_api_routes import ADMIN, api, auth_headers, csrf_headers  # noqa: E402,F401


def _login(api, username: str, password: str) -> Dict[str, str]:
    resp = api.post(
        "/api/auth/login",
        json={"username": username, "password": password},
        headers=csrf_headers(api),
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _make_user(api, username: str, role: str) -> Dict[str, str]:
    """建一个指定角色的账号并返回它的请求头。"""
    admin = auth_headers(api)
    created = api.post(
        "/api/users",
        json={"username": username, "password": "Unit-Test-Pa55word", "role": role},
        headers=admin,
    )
    assert created.status_code == 200, created.text
    return _login(api, username, "Unit-Test-Pa55word")


# ------------------------------------------------------------------ 规则
class TestRules:
    def test_cluster_rules_crud(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/firewall/cluster/rules", headers=headers).json() == []

        created = api.post(
            "/api/firewall/cluster/rules",
            headers=headers,
            json={
                "type": "in",
                "action": "ACCEPT",
                "proto": "tcp",
                "dport": "22",
                "comment": "SSH",
            },
        )
        assert created.status_code == 200, created.text

        rows = api.get("/api/firewall/cluster/rules", headers=headers).json()
        assert [(r["pos"], r["proto"], r["dport"], r["enable"]) for r in rows] == [
            (0, "tcp", "22", True)
        ]

        updated = api.put(
            "/api/firewall/cluster/rules/0",
            headers=headers,
            json={
                "type": "in",
                "action": "DROP",
                "proto": "tcp",
                "dport": "2222",
                "enable": False,
            },
        )
        assert updated.status_code == 200, updated.text
        row = api.get("/api/firewall/cluster/rules", headers=headers).json()[0]
        assert row["action"] == "DROP"
        assert row["enable"] is False
        assert row["dport"] == "2222"

        assert api.delete("/api/firewall/cluster/rules/0", headers=headers).status_code == 200
        assert api.get("/api/firewall/cluster/rules", headers=headers).json() == []

    def test_order_can_be_changed(self, api) -> None:
        headers = auth_headers(api)
        for port in ("22", "443"):
            assert (
                api.post(
                    "/api/firewall/cluster/rules",
                    headers=headers,
                    json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": port},
                ).status_code
                == 200
            )

        moved = api.post("/api/firewall/cluster/rules/0/move?to=1", headers=headers)
        assert moved.status_code == 200, moved.text
        ports = [
            r["dport"] for r in api.get("/api/firewall/cluster/rules", headers=headers).json()
        ]
        assert ports == ["443", "22"]

    def test_vm_rules_scope(self, api) -> None:
        headers = auth_headers(api)
        created = api.post(
            "/api/firewall/vm/rules?node=pve1&vmid=100",
            headers=headers,
            json={"type": "out", "action": "REJECT", "proto": "udp", "dport": "53"},
        )
        assert created.status_code == 200, created.text

        rows = api.get("/api/firewall/vm/rules?node=pve1&vmid=100", headers=headers).json()
        assert [(r["type"], r["action"], r["proto"]) for r in rows] == [("out", "REJECT", "udp")]
        # 作用域互相隔离：集群级看不到这台机器的规则
        assert api.get("/api/firewall/cluster/rules", headers=headers).json() == []

    def test_node_scope_needs_node_name(self, api) -> None:
        headers = auth_headers(api)
        assert api.get("/api/firewall/node/rules", headers=headers).status_code == 400

    @pytest.mark.parametrize(
        "payload",
        [
            {"type": "sideways", "action": "ACCEPT"},
            {"type": "in", "action": "ALLOW"},
            {"type": "in", "action": "ACCEPT", "proto": "smtp"},
            {"type": "in", "action": "ACCEPT", "dport": "80;rm -rf /"},
            {"type": "in", "action": "ACCEPT", "dport": "8000:notaport"},
            {"type": "group", "action": "ACCEPT"},  # 引用安全组却没给组名
        ],
    )
    def test_invalid_rules_are_rejected(self, api, payload) -> None:
        """明显写错的规则要在入口挡住，而不是写进集群再排查。"""
        headers = auth_headers(api)
        resp = api.post("/api/firewall/cluster/rules", headers=headers, json=payload)
        assert resp.status_code == 422, resp.text

    def test_port_range_and_list_are_accepted(self, api) -> None:
        headers = auth_headers(api)
        ok = api.post(
            "/api/firewall/cluster/rules",
            headers=headers,
            json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "80,443,8000:8100"},
        )
        assert ok.status_code == 200, ok.text


# ---------------------------------------------------------------- 选项
class TestOptions:
    def test_defaults_and_update(self, api) -> None:
        headers = auth_headers(api)
        current = api.get("/api/firewall/cluster/options", headers=headers).json()
        assert current["policy_in"] == "DROP"

        resp = api.put(
            "/api/firewall/cluster/options",
            headers=headers,
            json={"enable": True, "policy_in": "ACCEPT", "log_level_in": "info"},
        )
        assert resp.status_code == 200, resp.text
        after = api.get("/api/firewall/cluster/options", headers=headers).json()
        assert after["enable"] is True
        assert after["policy_in"] == "ACCEPT"
        assert after["log_level_in"] == "info"

    def test_vm_options_have_vm_only_fields(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put(
            "/api/firewall/vm/options?node=pve1&vmid=100",
            headers=headers,
            json={"enable": True, "ipfilter": True, "macfilter": True},
        )
        assert resp.status_code == 200, resp.text
        after = api.get("/api/firewall/vm/options?node=pve1&vmid=100", headers=headers).json()
        assert after["enable"] is True and after["ipfilter"] is True

    def test_bad_policy_is_rejected(self, api) -> None:
        headers = auth_headers(api)
        resp = api.put(
            "/api/firewall/cluster/options", headers=headers, json={"policy_in": "ALLOW"}
        )
        assert resp.status_code == 422


# -------------------------------------------------------------- 安全组
class TestSecurityGroups:
    def test_group_lifecycle(self, api) -> None:
        headers = auth_headers(api)
        created = api.post(
            "/api/firewall/groups", headers=headers, json={"group": "web", "comment": "Web 前段"}
        )
        assert created.status_code == 200, created.text

        listed = api.get("/api/firewall/groups", headers=headers).json()
        assert [g["group"] for g in listed] == ["web"]

        rule = api.post(
            "/api/firewall/groups/web/rules",
            headers=headers,
            json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "443"},
        )
        assert rule.status_code == 200, rule.text
        rules = api.get("/api/firewall/groups/web/rules", headers=headers).json()
        assert [(r["proto"], r["dport"]) for r in rules] == [("tcp", "443")]

        assert api.delete("/api/firewall/groups/web/rules/0", headers=headers).status_code == 200
        assert api.delete("/api/firewall/groups/web", headers=headers).status_code == 200
        assert api.get("/api/firewall/groups", headers=headers).json() == []

    def test_group_name_is_validated(self, api) -> None:
        headers = auth_headers(api)
        bad = api.post("/api/firewall/groups", headers=headers, json={"group": "1 bad name"})
        assert bad.status_code == 422

    def test_refs_lists_groups_and_macros(self, api) -> None:
        headers = auth_headers(api)
        api.post("/api/firewall/groups", headers=headers, json={"group": "db"})
        refs = api.get("/api/firewall/refs", headers=headers).json()
        assert refs["groups"] == ["db"]
        assert "SSH" in refs["macros"]


# -------------------------------------------------------------- IP 集合
class TestIpsets:
    def test_ipset_entries(self, api) -> None:
        headers = auth_headers(api)
        created = api.post(
            "/api/firewall/ipsets", headers=headers, json={"name": "office", "comment": "办公网"}
        )
        assert created.status_code == 200, created.text

        entry = api.post(
            "/api/firewall/ipsets/office/entries",
            headers=headers,
            json={"cidr": "10.8.0.0/16", "comment": "总部"},
        )
        assert entry.status_code == 200, entry.text

        sets = api.get("/api/firewall/ipsets", headers=headers).json()
        assert sets[0]["name"] == "office"
        assert [e["cidr"] for e in sets[0]["entries"]] == ["10.8.0.0/16"]

        deleted = api.delete(
            "/api/firewall/ipsets/office/entries/10.8.0.0%2F16", headers=headers
        )
        assert deleted.status_code == 200, deleted.text
        assert api.get("/api/firewall/ipsets", headers=headers).json()[0]["entries"] == []


# ------------------------------------------------------------ 规则模板
class TestTemplates:
    TEMPLATE = {
        "name": "Web 服务器基线",
        "description": "只放行 22/80/443",
        "enable": True,
        "policy_in": "DROP",
        "rules": [
            {"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "22"},
            {"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "80,443"},
        ],
    }

    def _create(self, api, headers) -> str:
        resp = api.post("/api/firewall/templates", headers=headers, json=self.TEMPLATE)
        assert resp.status_code == 200, resp.text
        return resp.json()["template"]["id"]

    def test_create_list_delete(self, api) -> None:
        headers = auth_headers(api)
        tpl_id = self._create(api, headers)

        listed = api.get("/api/firewall/templates", headers=headers).json()
        assert [t["id"] for t in listed] == [tpl_id]
        assert len(listed[0]["rules"]) == 2

        assert api.delete(f"/api/firewall/templates/{tpl_id}", headers=headers).status_code == 200
        assert api.get("/api/firewall/templates", headers=headers).json() == []

    def test_apply_to_multiple_vms(self, api) -> None:
        headers = auth_headers(api)
        tpl_id = self._create(api, headers)

        resp = api.post(
            f"/api/firewall/templates/{tpl_id}/apply",
            headers=headers,
            json={
                "targets": [
                    {"node": "pve1", "vmid": 100},
                    {"node": "pve1", "vmid": 101},
                ],
                "replace": True,
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["applied"] == 2 and body["failed"] == 0
        assert all(item["added"] == 2 for item in body["results"])
        # mock 里的网卡没有 firewall=1：应当给出「规则不会生效」的提示
        assert "网卡未启用防火墙" in body["results"][0]["warning"]

        # 两台机器各自的规则都被写进去了，且开关按模板打开
        for vmid in (100, 101):
            rows = api.get(
                f"/api/firewall/vm/rules?node=pve1&vmid={vmid}", headers=headers
            ).json()
            assert [r["dport"] for r in rows] == ["22", "80,443"]
            options = api.get(
                f"/api/firewall/vm/options?node=pve1&vmid={vmid}", headers=headers
            ).json()
            assert options["enable"] is True
            assert options["policy_in"] == "DROP"

    def test_apply_replace_clears_existing_rules(self, api) -> None:
        headers = auth_headers(api)
        api.post(
            "/api/firewall/vm/rules?node=pve1&vmid=100",
            headers=headers,
            json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "8080"},
        )
        tpl_id = self._create(api, headers)

        resp = api.post(
            f"/api/firewall/templates/{tpl_id}/apply",
            headers=headers,
            json={"targets": [{"node": "pve1", "vmid": 100}], "replace": True},
        )
        assert resp.json()["results"][0]["removed"] == 1
        rows = api.get("/api/firewall/vm/rules?node=pve1&vmid=100", headers=headers).json()
        assert [r["dport"] for r in rows] == ["22", "80,443"]

    def test_apply_without_replace_keeps_existing(self, api) -> None:
        headers = auth_headers(api)
        api.post(
            "/api/firewall/vm/rules?node=pve1&vmid=100",
            headers=headers,
            json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "8080"},
        )
        tpl_id = self._create(api, headers)

        resp = api.post(
            f"/api/firewall/templates/{tpl_id}/apply",
            headers=headers,
            json={"targets": [{"node": "pve1", "vmid": 100}], "replace": False},
        )
        assert resp.json()["results"][0]["removed"] == 0
        rows = api.get("/api/firewall/vm/rules?node=pve1&vmid=100", headers=headers).json()
        assert [r["dport"] for r in rows] == ["8080", "22", "80,443"]

    def test_apply_unknown_template_is_404(self, api) -> None:
        headers = auth_headers(api)
        resp = api.post(
            "/api/firewall/templates/nope/apply",
            headers=headers,
            json={"targets": [{"node": "pve1", "vmid": 100}]},
        )
        assert resp.status_code == 404

    def test_apply_needs_at_least_one_target(self, api) -> None:
        headers = auth_headers(api)
        tpl_id = self._create(api, headers)
        resp = api.post(
            f"/api/firewall/templates/{tpl_id}/apply", headers=headers, json={"targets": []}
        )
        assert resp.status_code == 422

    def test_audit_records_the_rollout(self, api) -> None:
        headers = auth_headers(api)
        tpl_id = self._create(api, headers)
        api.post(
            f"/api/firewall/templates/{tpl_id}/apply",
            headers=headers,
            json={"targets": [{"node": "pve1", "vmid": 100}]},
        )
        rows = api.get(
            "/api/audit?action=firewall.template.apply&limit=5", headers=headers
        ).json()["items"]
        assert rows and rows[0]["target"] == tpl_id
        assert "applied" in rows[0]["detail"]


# ------------------------------------------------------------ 权限
class TestPermissions:
    def test_viewer_can_read_but_not_write(self, api) -> None:
        viewer = _make_user(api, "fwviewer", "viewer")
        assert api.get("/api/firewall/cluster/rules", headers=viewer).status_code == 200
        denied = api.post(
            "/api/firewall/cluster/rules",
            headers=viewer,
            json={"type": "in", "action": "ACCEPT"},
        )
        assert denied.status_code == 403

    def test_operator_manages_vm_but_not_cluster(self, api) -> None:
        operator = _make_user(api, "fwoperator", "operator")
        # 节点级规则：属于 firewall.manage，放行
        allowed = api.post(
            "/api/firewall/node/rules?node=pve1",
            headers=operator,
            json={"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "22"},
        )
        assert allowed.status_code == 200, allowed.text
        # 集群级要 firewall.cluster
        denied = api.post(
            "/api/firewall/cluster/rules",
            headers=operator,
            json={"type": "in", "action": "ACCEPT"},
        )
        assert denied.status_code == 403
        assert "firewall.cluster" in denied.json()["detail"]
