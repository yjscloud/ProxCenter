"""End-to-end router tests: HTTP request -> router -> Proxmox -> response.

These drive the real FastAPI app against the mock Proxmox server, so they
verify the full stack in-process: routing, RBAC, config building, PVE call
shape, and response shaping. This is the layer where contract drift shows up.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

import pytest
from fastapi.testclient import TestClient

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import pve as pve_module  # noqa: E402
from app import store  # noqa: E402
from app.pve import PveConnection, ProxmoxError  # noqa: E402

from conftest import connect, delete_setting_sync  # noqa: E402
from app.config import settings  # noqa: E402
from test_pve_client import (  # noqa: E402
    SNAPSHOT_STORE,
    TOKEN_ID,
    TOKEN_SECRET,
    MockPveServer,
)

# 口令跟 conftest 注入的 ADMIN_PASSWORD（settings）走：弱口令会被建号逻辑拒绝
ADMIN = {"username": "admin", "password": settings.admin_password}


def _attach_csrf(client: TestClient) -> TestClient:
    """让测试客户端像浏览器一样给写请求自动带上 CSRF 头。

    前端是 axios 拦截器读 ``panel_csrf`` Cookie 回填 ``X-CSRF-Token``；
    测试里如果手动补，就会漏掉几十处「登录后再发写请求」的调用点。这里在
    fixture 上统一做掉，语义与浏览器一致（想测「缺 CSRF 会怎样」的用例
    直接调 ``client.request(...)`` 绕开这里）。
    """
    for method in ("post", "put", "patch", "delete"):
        original = getattr(client, method)

        def wrapper(*args, _original=original, **kwargs):
            headers = dict(kwargs.pop("headers", None) or {})
            if "X-CSRF-Token" not in headers:
                value = client.cookies.get("panel_csrf", "")
                if value:
                    headers["X-CSRF-Token"] = value
            return _original(*args, headers=headers, **kwargs)

        setattr(client, method, wrapper)
    return client


@pytest.fixture()
def api(clean_mysql_db):
    """A TestClient wired to a mock Proxmox, with an empty MySQL test database.

    ``clean_mysql_db`` 保证每个用例都从空库开始；建表由应用启动时的 lifespan
    完成（面板只在 MySQL 上跑，测试库见 ``tests/conftest.py``）。
    """
    with MockPveServer() as server:
        # Rebuild the global client against the mock, bypassing stored config.
        conn = PveConnection(
            host=f"http://127.0.0.1:{server.port}",
            port=server.port,
            token_id=TOKEN_ID,
            token_secret=TOKEN_SECRET,
            verify_ssl=False,
        )
        pve_module._client = pve_module.ProxmoxClient(conn)

        from app.main import app

        with TestClient(app) as client:
            yield _attach_csrf(client)

    pve_module._client = None


def csrf_headers(client: TestClient) -> Dict[str, str]:
    """Cookie 认证下的写请求需要 CSRF 头（浏览器里由前端拦截器自动回填）。

    TestClient 会保留 Set-Cookie，所以同一个客户端第二次登录 / 刷新时就变成
    「Cookie 认证」了，必须带上这枚令牌。
    """
    value = client.cookies.get("panel_csrf", "")
    return {"X-CSRF-Token": value} if value else {}


def auth_headers(client: TestClient) -> Dict[str, str]:
    resp = client.post("/api/auth/login", json=ADMIN, headers=csrf_headers(client))
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# --------------------------------------------------------------- auth basics
class TestAuthFlow:
    def test_login_returns_token_and_user(self, api) -> None:
        resp = api.post("/api/auth/login", json=ADMIN)
        assert resp.status_code == 200
        body = resp.json()
        assert body["token_type"] == "bearer"
        assert body["user"]["username"] == "admin"
        assert "*" in body["user"]["permissions"]

    def test_wrong_password_is_401(self, api) -> None:
        resp = api.post(
            "/api/auth/login", json={"username": "admin", "password": "nope"}
        )
        assert resp.status_code == 401

    def test_protected_route_requires_token(self, api) -> None:
        assert api.get("/api/vms").status_code == 401

    def test_garbage_token_is_401(self, api) -> None:
        resp = api.get(
            "/api/vms", headers={"Authorization": "Bearer not-a-real-token"}
        )
        assert resp.status_code == 401

    def test_health_is_public_and_reports_pve(self, api) -> None:
        resp = api.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        # The mock reports a PVE version, proving the connection works.
        assert body["pve_connected"] is True
        assert body["pve_version"] == "8.2.4"


# ------------------------------------------------------- 登录图形验证码
class TestLoginCaptcha:
    """验证码默认强制；conftest 全局关掉，这里临时打开验证强制与放行两条路。"""

    def test_disabled_endpoint_says_not_required(self, api) -> None:
        assert api.get("/api/auth/captcha").json() == {
            "required": False,
            "mode": "off",
        }

    def test_enforced_when_enabled(self, api) -> None:
        from app import captcha as captcha_mod
        from app.config import settings

        # 先拿管理员 token：开启验证码后 auth_headers 的裸登录会被拦
        admin = auth_headers(api)
        settings.login_captcha = True
        try:
            # 没带验证码 → 拦在密码校验之前
            resp = api.post("/api/auth/login", json=ADMIN, headers=csrf_headers(api))
            assert resp.status_code == 400
            assert "验证码" in resp.json()["detail"]

            # 正常取一张图
            ch = api.get("/api/auth/captcha").json()
            assert ch["required"] is True
            assert ch["image"].startswith("data:image/png;base64,")

            # 填错 → 400
            wrong = api.post(
                "/api/auth/login",
                json={**ADMIN, "captcha_id": ch["id"], "captcha_code": "!!!!"},
                headers=csrf_headers(api),
            )
            assert wrong.status_code == 400

            # 一次性：同一个 id 再用（即使填「对」）也已被消耗
            reused = api.post(
                "/api/auth/login",
                json={**ADMIN, "captcha_id": ch["id"], "captcha_code": "ABCD"},
                headers=csrf_headers(api),
            )
            assert reused.status_code == 400

            # 填对 → 登录成功（白盒读内存答案，不依赖 OCR）
            fresh = api.get("/api/auth/captcha").json()
            answer = captcha_mod._pending[fresh["id"]][0]
            ok = api.post(
                "/api/auth/login",
                json={
                    **ADMIN,
                    "captcha_id": fresh["id"],
                    "captcha_code": answer,
                },
                headers=csrf_headers(api),
            )
            assert ok.status_code == 200, ok.text
            assert ok.json()["user"]["username"] == "admin"

            # 验证码失败要留痕，审计里查得到
            rows = api.get(
                "/api/audit?action=auth.login&result=failed",
                headers=admin,
            ).json()
            assert any("验证码" in r["detail"] for r in rows["items"])
        finally:
            settings.login_captcha = False


# ------------------------------------------- 登录验证方式（关闭 / 图形 / 滑块）
class TestLoginCaptchaMode:
    """三档验证方式与滑块拼图。

    设置存 settings KV 表（用例之间会被清空），滑块的目标位置只留在进程内存里，
    所以校验走白盒读法 —— 与上面图形验证码读 ``_pending`` 是同一个路子。
    """

    @staticmethod
    def _set_mode(api, mode: str) -> None:
        resp = api.put(
            "/api/config/login-captcha",
            json={"mode": mode},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["mode"] == mode

    def test_default_follows_env_flag(self, api) -> None:
        """KV 里没记录时回落到 LOGIN_CAPTCHA；conftest 把它关了 → off。

        这条守的是「升级不改变既有行为」：已经有部署把验证码关掉了，
        不能因为新增了一个默认值就把验证码悄悄打开。
        """
        assert api.get("/api/auth/captcha").json() == {"required": False, "mode": "off"}

    def test_rejects_unknown_mode(self, api) -> None:
        resp = api.put(
            "/api/config/login-captcha",
            json={"mode": "sms"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 400

    def test_viewer_cannot_change_mode(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={
                "username": "captchaviewer",
                "password": "Unit-Test-Pa55word",
                "role": "viewer",
            },
            headers=admin,
        )
        login = api.post(
            "/api/auth/login",
            json={"username": "captchaviewer", "password": "Unit-Test-Pa55word"},
            headers=csrf_headers(api),
        )
        viewer = {"Authorization": f"Bearer {login.json()['access_token']}"}

        assert (
            api.put(
                "/api/config/login-captcha", json={"mode": "off"}, headers=viewer
            ).status_code
            == 403
        )

    def test_switch_to_image_mode(self, api) -> None:
        self._set_mode(api, "image")
        ch = api.get("/api/auth/captcha").json()
        assert ch["required"] is True
        assert ch["mode"] == "image"
        assert ch["image"].startswith("data:image/png;base64,")

        # 不带验证码 → 拦在密码校验之前
        resp = api.post("/api/auth/login", json=ADMIN, headers=csrf_headers(api))
        assert resp.status_code == 400
        assert "验证码" in resp.json()["detail"]

    def test_slider_mode_checks_position(self, api) -> None:
        from app import captcha as captcha_mod

        self._set_mode(api, "slider")
        ch = api.get("/api/auth/captcha").json()
        assert ch["required"] is True
        assert ch["mode"] == "slider"
        assert ch["background"].startswith("data:image/png;base64,")
        assert ch["piece"].startswith("data:image/png;base64,")
        # 拼图块必须完整落在画布内，否则前端拖到位也盖不住缺口
        assert 0 <= ch["piece_y"] <= ch["height"] - ch["piece_size"]
        # 目标位置不返回给前端 —— 它只留在服务端内存里
        assert "x" not in ch and "target" not in ch

        target = captcha_mod._sliders[ch["id"]][0]

        # 位置差得远 → 400，且提示与图形码区分开，前端才知道该标红滑块
        bad = api.post(
            "/api/auth/login",
            json={**ADMIN, "captcha_id": ch["id"], "captcha_x": target + 40},
            headers=csrf_headers(api),
        )
        assert bad.status_code == 400
        assert "滑块" in bad.json()["detail"]

        # 换一道题、拖到位 → 正常登录
        fresh = api.get("/api/auth/captcha").json()
        answer = captcha_mod._sliders[fresh["id"]][0]
        ok = api.post(
            "/api/auth/login",
            json={**ADMIN, "captcha_id": fresh["id"], "captcha_x": answer},
            headers=csrf_headers(api),
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["user"]["username"] == "admin"

        # 一次性：同一个 id 再提交必然失败
        reused = api.post(
            "/api/auth/login",
            json={**ADMIN, "captcha_id": fresh["id"], "captcha_x": answer},
            headers=csrf_headers(api),
        )
        assert reused.status_code == 400

    def test_slider_target_never_sits_at_origin(self) -> None:
        """目标位置恒大于 0。

        前端把 ``x = 0`` 当作「还没拖过」用来做本地校验，两者不能撞上 ——
        撞上就会出现「什么都没做却被判定已验证」。
        """
        from app import captcha as captcha_mod

        for _ in range(20):
            ch = captcha_mod.issue_slider()
            assert captcha_mod._sliders[ch["id"]][0] > 0


# -------------------------------------------------------------- read routes
class TestReadRoutes:
    def test_list_vms_shapes_data(self, api) -> None:
        resp = api.get("/api/vms", headers=auth_headers(api))
        assert resp.status_code == 200
        vms = resp.json()
        assert len(vms) == 2
        running = next(v for v in vms if v["vmid"] == 100)
        assert running["name"] == "web-01"
        assert running["status"] == "running"
        assert running["template"] is False
        # The template flag must survive the int -> bool conversion.
        template = next(v for v in vms if v["vmid"] == 9000)
        assert template["template"] is True

    def test_get_vm_parses_disks_and_nics(self, api) -> None:
        resp = api.get("/api/vms/pve1/100", headers=auth_headers(api))
        assert resp.status_code == 200
        vm = resp.json()
        assert vm["name"] == "web-01"
        assert vm["status"] == "running"
        assert len(vm["disks"]) == 1
        assert vm["disks"][0]["storage"] == "local-lvm"
        assert len(vm["networks"]) == 1
        assert vm["networks"][0]["bridge"] == "vmbr0"
        # The cloud-init drive must not be reported as a disk.
        assert all("cloudinit" not in str(d) for d in vm["disks"])

    def test_get_vm_tolerates_kv_agent_config(self, api) -> None:
        """PVE 允许 ``agent: enabled=1,fstrim_cloned_disks=1``。

        回归用例：早先这里直接 ``int(config["agent"])``，遇到 k=v 写法抛
        ValueError，整个虚拟机详情接口 500（前端只看到「服务器内部错误」）。
        """
        import test_pve_client as mock_mod

        key = ("GET", "/api2/json/nodes/pve1/qemu/100/config")
        original = mock_mod.ROUTES.get(key)
        mock_mod.ROUTES[key] = lambda: {
            **mock_mod.VM_CONFIG,
            "agent": "enabled=1,fstrim_cloned_disks=1",
        }
        try:
            resp = api.get("/api/vms/pve1/100", headers=auth_headers(api))
            assert resp.status_code == 200, resp.text
            assert resp.json()["agent"]["enabled"] is True
        finally:
            if original is not None:
                mock_mod.ROUTES[key] = original
            else:
                mock_mod.ROUTES.pop(key, None)

    def test_get_vm_exposes_agent_fields_at_top_level(self, api) -> None:
        """Guest Agent 的状态必须放在顶层，且三个字段语义分明。

        回归用例：前端读的是 ``agent_enabled`` / ``agent_available`` /
        ``agent_interfaces``，后端早先把它们塞进嵌套的 ``agent`` 里，
        于是 ``vm.agent_available`` 恒为 undefined —— 客户机里 Agent 明明
        跑得好好的，页面也一直显示「Guest Agent 不可用」。
        """
        import test_pve_client as mock_mod

        key = ("GET", "/api2/json/nodes/pve1/qemu/100/agent/network-get-interfaces")
        original = mock_mod.ROUTES.get(key)
        mock_mod.ROUTES[key] = lambda: {
            "result": [
                {
                    "name": "lo",
                    "hardware-address": "00:00:00:00:00:00",
                    "ip-addresses": [
                        {"ip-address-type": "ipv4", "ip-address": "127.0.0.1", "prefix": 8}
                    ],
                },
                {
                    "name": "eth0",
                    "hardware-address": "bc:24:11:18:3d:77",
                    "ip-addresses": [
                        {"ip-address-type": "ipv4", "ip-address": "172.16.149.73", "prefix": 24}
                    ],
                },
            ]
        }
        try:
            resp = api.get("/api/vms/pve1/100", headers=auth_headers(api))
            assert resp.status_code == 200, resp.text
            vm = resp.json()

            # 配置里开了（mock 的 agent 为 1），且真的问到 Agent 了
            assert vm["agent_enabled"] is True
            assert vm["agent_available"] is True

            # PVE 的 {"result": [...]} 与连字符命名必须已被拍平
            assert [i["name"] for i in vm["agent_interfaces"]] == ["lo", "eth0"]
            eth0 = next(i for i in vm["agent_interfaces"] if i["name"] == "eth0")
            assert eth0["hardware_address"] == "bc:24:11:18:3d:77"
            assert eth0["ip_addresses"] == [
                {
                    "ip_address": "172.16.149.73",
                    "prefix": 24,
                    "ip_address_type": "ipv4",
                }
            ]
        finally:
            if original is not None:
                mock_mod.ROUTES[key] = original
            else:
                mock_mod.ROUTES.pop(key, None)

    def test_nodes_listing(self, api) -> None:
        resp = api.get("/api/nodes", headers=auth_headers(api))
        assert resp.status_code == 200
        nodes = resp.json()
        assert nodes[0]["node"] == "pve1"
        assert nodes[0]["status"] == "online"

    def test_storage_listing_is_normalised(self, api) -> None:
        resp = api.get("/api/storages?node=pve1", headers=auth_headers(api))
        assert resp.status_code == 200
        storages = resp.json()
        assert len(storages) == 2
        lvm = next(s for s in storages if s["storage"] == "local-lvm")
        # total/used/avail and a computed usage ratio must all be present.
        assert lvm["total"] == 500 * 1024**3
        assert lvm["used"] == 100 * 1024**3
        assert 0 < lvm["usage"] < 1

    def test_nextid_returns_int(self, api) -> None:
        resp = api.get("/api/cluster/nextid", headers=auth_headers(api))
        assert resp.json() == {"vmid": 105}

    def test_templates_listing_filters_templates(self, api) -> None:
        resp = api.get("/api/templates", headers=auth_headers(api))
        assert resp.status_code == 200
        templates = resp.json()
        assert len(templates) == 1
        assert templates[0]["vmid"] == 9000
        assert templates[0]["template"] is True

    def test_dashboard_summary_aggregates(self, api) -> None:
        resp = api.get("/api/dashboard/summary", headers=auth_headers(api))
        assert resp.status_code == 200
        body = resp.json()
        assert body["vms"]["total"] == 2
        assert body["vms"]["running"] == 1
        assert body["vms"]["templates"] == 1
        assert body["nodes"]["total"] == 1
        assert body["nodes"]["online"] == 1
        assert body["version"]["pve"] == "8.2.4"

    def test_task_listing(self, api) -> None:
        resp = api.get("/api/tasks", headers=auth_headers(api))
        assert resp.status_code == 200
        tasks = resp.json()
        assert len(tasks) == 1
        assert tasks[0]["type"] == "qmstart"
        assert tasks[0]["exitstatus"] == "OK"

    def test_snapshot_aggregation_does_not_crash(self, api) -> None:
        """Global snapshot view fans out per VM; unroutable ones must not 500."""
        resp = api.get("/api/snapshots", headers=auth_headers(api))
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)


# ------------------------------------------------------- privilege diagnostics
class TestDiagnostics:
    """The self-check must explain token-permission problems, not just fail."""

    def test_reports_healthy_token(self, api, monkeypatch) -> None:
        import test_pve_client as fixtures

        monkeypatch.setattr(
            fixtures,
            "PERMISSIONS",
            {"/": ["Sys.Audit", "VM.Audit", "Datastore.Audit"]},
        )
        resp = api.get("/api/config/diagnostics", headers=auth_headers(api))
        assert resp.status_code == 200
        body = resp.json()

        assert body["reachable"] is True
        assert body["pve_version"] == "8.2.4"
        # Usable: the only caution is the optional console account.
        assert body["ok"] is True
        assert body["status"] == "warn"
        assert body["remediation"] == []

        by_key = {c["key"]: c for c in body["checks"]}
        assert by_key["version"]["status"] == "ok"
        assert by_key["nodes"]["status"] == "ok"
        assert by_key["node_metrics"]["status"] == "ok"
        assert by_key["storage"]["status"] == "ok"
        # No console credentials configured in the fixture -> advisory only.
        assert by_key["console"]["status"] == "warn"

    def test_detects_privilege_separated_token(self, api, monkeypatch) -> None:
        """An empty /access/permissions is the signature of a token with no ACL.

        This is the failure that otherwise looks like an empty cluster: PVE
        returns 200 with empty lists rather than an error.
        """
        import test_pve_client as fixtures

        monkeypatch.setattr(fixtures, "PERMISSIONS", {})
        resp = api.get("/api/config/diagnostics", headers=auth_headers(api))
        assert resp.status_code == 200
        body = resp.json()

        assert body["ok"] is False
        assert body["status"] == "fail"
        assert body["effective_privileges"] == []

        by_key = {c["key"]: c for c in body["checks"]}
        assert by_key["privileges"]["status"] == "fail"
        assert "特权分离" in by_key["privileges"]["hint"]
        # The node/storage counts are meaningless here, so they must be
        # reported as "not determined" rather than as a healthy zero.
        assert by_key["storage"]["status"] == "warn"
        assert by_key["vms"]["status"] == "warn"

        # Remediation must be an actionable command, not advice in the abstract.
        joined = "\n".join(body["remediation"])
        assert "pveum acl modify" in joined
        assert body["token_id"] in joined

    def test_unreachable_cluster_is_reported(
        self, clean_mysql_db, monkeypatch
    ) -> None:
        """Diagnostics must degrade to a clear message, never a 500."""
        conn = PveConnection(
            host="https://192.0.2.10",
            port=8006,
            token_id="probe@pve!panel",
            token_secret="00000000-0000-0000-0000-000000000000",
            verify_ssl=False,
        )
        pve_module._client = pve_module.ProxmoxClient(conn)

        async def unreachable(self):
            raise ProxmoxError("Cannot reach Proxmox at https://192.0.2.10:8006")

        monkeypatch.setattr(pve_module.ProxmoxClient, "version", unreachable)
        try:
            from app.main import app

            with TestClient(app) as client:
                token = auth_headers(client)
                resp = client.get("/api/config/diagnostics", headers=token)
                assert resp.status_code == 200
                body = resp.json()
                assert body["reachable"] is False
                assert body["status"] == "fail"
                assert any("8006" in r for r in body["remediation"])
        finally:
            pve_module._client = None


# ------------------------------------------------------------- write routes
class TestWriteRoutes:
    def test_start_vm_returns_upid(self, api) -> None:
        resp = api.post("/api/vms/pve1/100/status/start", headers=auth_headers(api))
        assert resp.status_code == 200
        assert resp.json()["task"].startswith("UPID:pve1:")

    def test_power_action_whitelist(self, api) -> None:
        resp = api.post(
            "/api/vms/pve1/100/status/launch", headers=auth_headers(api)
        )
        assert resp.status_code == 400
        assert "不支持的操作" in resp.json()["detail"]

    def test_create_vm_returns_vmid_and_task(self, api) -> None:
        payload = {
            "node": "pve1",
            "name": "new-vm",
            "memory": 2048,
            "cores": 2,
            "disks": [
                {"storage": "local-lvm", "size": 20, "interface": "scsi0"}
            ],
            "networks": [{"bridge": "vmbr0", "model": "virtio"}],
        }
        resp = api.post("/api/vms", json=payload, headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["vmid"] == 105
        assert body["node"] == "pve1"
        assert body["task"].startswith("UPID:pve1:")

    def test_create_vm_validates_name(self, api) -> None:
        resp = api.post(
            "/api/vms",
            json={"node": "pve1", "name": "   "},
            headers=auth_headers(api),
        )
        assert resp.status_code == 422

    def test_create_vm_accepts_frontend_camel_case_aliases(self, api) -> None:
        """The frontend sends templateMode/source_image; both must be accepted."""
        payload = {
            "node": "pve1",
            "name": "tpl-from-alias",
            "templateMode": False,
            "scsi_hw": "virtio-scsi-single",
        }
        resp = api.post("/api/vms", json=payload, headers=auth_headers(api))
        assert resp.status_code == 200, resp.text

    def test_create_vm_sends_numa_and_efi_to_proxmox(self, api) -> None:
        """高级硬件要真的落进 PVE 的创建请求体，而不是只被面板 schema 收下。"""
        import test_pve_client as mock_mod

        mock_mod.REQUESTS.clear()
        payload = {
            "node": "pve1",
            "name": "win11-vm",
            "memory": 8192,
            "cores": 4,
            "sockets": 2,
            "numa": True,
            "numa_nodes": [{"cpus": "0-3", "hostnodes": "0", "policy": "bind"}],
            "affinity": "0-7",
            "efi_disk": {"storage": "local-lvm"},
            "tpm": {"storage": "local-lvm"},
            "disks": [{"storage": "local-lvm", "size": 64, "interface": "scsi0"}],
        }
        resp = api.post("/api/vms", json=payload, headers=auth_headers(api))
        assert resp.status_code == 200, resp.text

        body = next(
            b
            for m, p, b, _ in mock_mod.REQUESTS
            if m == "POST" and p == "/api2/json/nodes/pve1/qemu"
        )
        # EFI/TPM 要求 OVMF + q35：三个值必须一起到 PVE，否则机器起不来
        assert body["bios"] == "ovmf"
        assert body["machine"] == "q35"
        assert body["numa"] == 1
        assert body["numa0"] == "cpus=0-3,memory=8192,hostnodes=0,policy=bind"
        assert body["affinity"] == "0-7"
        assert body["efidisk0"] == "local-lvm:1,efitype=4m,pre-enrolled-keys=1"
        assert body["tpmstate0"] == "local-lvm:4,version=v2.0"

    def test_config_update_passes_advanced_hardware_through(self, api) -> None:
        """改配路径把 numa / TPM 这类复合值原样透传给 PVE。"""
        import test_pve_client as mock_mod

        mock_mod.REQUESTS.clear()
        resp = api.put(
            "/api/vms/pve1/100/config",
            json={
                "numa": 1,
                "numa0": "cpus=0-3,memory=4096,hostnodes=0",
                "affinity": "0-7",
                "tpmstate0": "local-lvm:4,version=v2.0",
            },
            headers=auth_headers(api),
        )
        # mock 没有 config 路由 -> 501，说明请求确实发到了 PVE
        assert resp.status_code in (200, 501)

        body = next(
            b
            for m, p, b, _ in mock_mod.REQUESTS
            if m == "POST" and p == "/api2/json/nodes/pve1/qemu/100/config"
        )
        assert body["numa0"] == "cpus=0-3,memory=4096,hostnodes=0"
        assert body["affinity"] == "0-7"
        assert body["tpmstate0"] == "local-lvm:4,version=v2.0"

    def test_convert_to_template_blocked_while_running(self, api) -> None:
        # VM 100 is running in the mock; PVE requires it stopped.
        resp = api.post("/api/vms/pve1/100/template", headers=auth_headers(api))
        assert resp.status_code == 409
        assert "关闭" in resp.json()["detail"]

    def test_convert_to_template_allowed_when_stopped(self, api) -> None:
        """The status probe gates this: a stopped VM converts without a 409."""
        # The mock reports status from a shared route; patch it to "stopped"
        # so this exercises the happy path rather than the guard.
        import test_pve_client as mock_mod

        original = mock_mod.ROUTES.get(
            ("GET", "/api2/json/nodes/pve1/qemu/100/status/current")
        )
        mock_mod.ROUTES[
            ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current")
        ] = lambda: {"status": "stopped", "vmid": 9000}
        try:
            resp = api.post(
                "/api/vms/pve1/9000/template", headers=auth_headers(api)
            )
            assert resp.status_code == 200
            assert resp.json()["task"].startswith("UPID:pve1:")
        finally:
            mock_mod.ROUTES.pop(
                ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current"), None
            )
            if original:
                mock_mod.ROUTES[
                    ("GET", "/api2/json/nodes/pve1/qemu/100/status/current")
                ] = original

    def test_delete_stopped_vm_reaches_proxmox(self, api) -> None:
        """A stopped VM must pass the running-check and hit the PVE delete."""
        import test_pve_client as mock_mod

        mock_mod.ROUTES[
            ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current")
        ] = lambda: {"status": "stopped", "vmid": 9000}
        try:
            resp = api.delete(
                "/api/vms/pve1/9000?purge=true", headers=auth_headers(api)
            )
            # The mock defines no DELETE route, so PVE itself rejects it —
            # which proves the request got past the panel's guard.
            assert resp.status_code == 501
        finally:
            mock_mod.ROUTES.pop(
                ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current"), None
            )

    def test_delete_running_vm_is_refused(self, api) -> None:
        """A running VM must not be destroyed by accident."""
        resp = api.delete("/api/vms/pve1/100", headers=auth_headers(api))
        assert resp.status_code == 409
        assert "正在运行" in resp.json()["detail"]

    def test_delete_vm_purge_param(self, api) -> None:
        """purge is forwarded as a query parameter (not a body)."""
        import test_pve_client as mock_mod

        mock_mod.ROUTES[
            ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current")
        ] = lambda: {"status": "stopped", "vmid": 9000}
        try:
            resp = api.delete(
                "/api/vms/pve1/9000?purge=false", headers=auth_headers(api)
            )
            assert resp.status_code == 501
        finally:
            mock_mod.ROUTES.pop(
                ("GET", "/api2/json/nodes/pve1/qemu/9000/status/current"), None
            )

    def test_clone_vm(self, api) -> None:
        resp = api.post(
            "/api/vms/pve1/9000/clone",
            json={"newid": 110, "name": "cloned", "full": True},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200
        assert resp.json()["vmid"] == 110

    def test_config_update_strips_none_values(self, api) -> None:
        """Sending null for a field must not clear it on the Proxmox side."""
        resp = api.put(
            "/api/vms/pve1/100/config",
            json={"memory": 8192, "cores": None},
            headers=auth_headers(api),
        )
        # The mock has no PUT config route -> 501, proving the call was made.
        assert resp.status_code in (200, 501)

    def test_config_update_rejects_empty_body(self, api) -> None:
        resp = api.put(
            "/api/vms/pve1/100/config", json={}, headers=auth_headers(api)
        )
        assert resp.status_code == 400


# ------------------------------------------------------- 硬件增删（磁盘 / 网卡）
class TestHardwareAddRemove:
    """硬件页的新增 / 移除。

    mock 里 VM 100 的配置带 scsi0 与 net0，所以「下一个空闲槽位」应当是
    scsi1 / net1；这组用例同时校验真正发给 PVE 的请求体。
    """

    CONFIG_PATH = "/api2/json/nodes/pve1/qemu/100/config"
    UPID = "UPID:pve1:0000A1B5:00C3D4E8:65F00004:qmconfig:100:root@pam:"

    @pytest.fixture()
    def config_post(self):
        """给 mock 补一条 POST config 路由，并把请求记录下标重置好。"""
        import test_pve_client as mock_mod

        key = ("POST", self.CONFIG_PATH)
        original = mock_mod.ROUTES.get(key)
        mock_mod.ROUTES[key] = lambda: self.UPID
        before = len(mock_mod.REQUESTS)
        try:
            yield lambda: [
                body
                for method, path, body, _ in mock_mod.REQUESTS[before:]
                if method == "POST" and path == self.CONFIG_PATH
            ]
        finally:
            if original is not None:
                mock_mod.ROUTES[key] = original
            else:
                mock_mod.ROUTES.pop(key, None)

    def test_add_disk_picks_free_slot_and_keeps_qcow2_on_dir(
        self, api, config_post
    ) -> None:
        resp = api.post(
            "/api/vms/pve1/100/hardware/disk",
            json={"storage": "local", "size": 20, "format": "qcow2"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # scsi0 已被占用，应当落到 scsi1
        assert body["key"] == "scsi1"
        # local 是 dir 存储，qcow2 需要显式写进 format=
        assert body["value"] == "local:20,format=qcow2"
        assert config_post()[-1] == {"scsi1": "local:20,format=qcow2"}

    def test_add_disk_forces_raw_on_block_storage(self, api, config_post) -> None:
        resp = api.post(
            "/api/vms/pve1/100/hardware/disk",
            json={"storage": "local-lvm", "size": 8, "format": "qcow2"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        # lvmthin 只支持 raw，且不能带 format= 段
        assert resp.json()["value"] == "local-lvm:8"
        assert config_post()[-1] == {"scsi1": "local-lvm:8"}

    def test_add_disk_rejects_occupied_slot(self, api, config_post) -> None:
        resp = api.post(
            "/api/vms/pve1/100/hardware/disk",
            json={"storage": "local", "size": 20, "interface": "scsi0"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 409
        assert config_post() == []

    def test_add_disk_rejects_bad_slot_name(self, api, config_post) -> None:
        resp = api.post(
            "/api/vms/pve1/100/hardware/disk",
            json={"storage": "local", "size": 20, "interface": "memory"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 400
        assert config_post() == []

    def test_add_network_picks_free_slot(self, api, config_post) -> None:
        resp = api.post(
            "/api/vms/pve1/100/hardware/network",
            json={"bridge": "vmbr0", "model": "virtio", "vlan_tag": 30},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["key"] == "net1"  # net0 已被占用
        assert body["value"] == "virtio,bridge=vmbr0,tag=30"
        assert config_post()[-1] == {"net1": "virtio,bridge=vmbr0,tag=30"}

    def test_remove_hardware_sends_pve_delete(self, api, config_post) -> None:
        resp = api.delete(
            "/api/vms/pve1/100/hardware/scsi0", headers=auth_headers(api)
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["key"] == "scsi0"
        # PVE 用 delete=<键名> 表达「删掉这个配置项」
        assert config_post()[-1] == {"delete": "scsi0"}

    def test_remove_hardware_refuses_non_device_keys(self, api, config_post) -> None:
        """白名单之外（memory / boot …）一律拒绝，避免误删配置把机器改坏。"""
        for key in ("memory", "boot", "agent", "scsi"):
            resp = api.delete(
                f"/api/vms/pve1/100/hardware/{key}", headers=auth_headers(api)
            )
            assert resp.status_code == 400, key
        assert config_post() == []

    def test_remove_hardware_404_when_absent(self, api, config_post) -> None:
        resp = api.delete(
            "/api/vms/pve1/100/hardware/scsi5", headers=auth_headers(api)
        )
        assert resp.status_code == 404
        assert config_post() == []

    def test_viewer_cannot_add_or_remove_hardware(self, api, config_post) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "hwviewer", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=admin,
        )
        login = api.post(
            "/api/auth/login",
            json={"username": "hwviewer", "password": "Unit-Test-Pa55word"},
        )
        assert login.status_code == 200
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        assert (
            api.post(
                "/api/vms/pve1/100/hardware/network",
                json={"bridge": "vmbr0"},
                headers=headers,
            ).status_code
            == 403
        )
        assert (
            api.delete("/api/vms/pve1/100/hardware/scsi0", headers=headers).status_code
            == 403
        )
        assert config_post() == []


# ------------------------------------------- 客户机磁盘用量（Guest Agent）
class TestGuestDiskUsage:
    """``POST /vms/{node}/{vmid}/disk-usage``：经 Guest Agent 在客户机内执行 df。

    PVE 对 QEMU 虚拟机不提供已用量（``status.disk`` 恒为 0），老版本
    qemu-guest-agent 的 ``get-fsinfo`` 也不带容量字段，所以这条路径是拿到
    「客户机内真实磁盘用量」的唯一办法。
    """

    EXEC_PATH = "/api2/json/nodes/pve1/qemu/100/agent/exec"
    STATUS_PATH = "/api2/json/nodes/pve1/qemu/100/agent/exec-status"

    DF_OUTPUT = (
        "Filesystem                  1-blocks       Used    Available Capacity Mounted on\n"
        "devtmpfs                  1974394880          0   1974394880       0% /dev\n"
        "tmpfs                     1986646016    8839168   1977806848       1% /run\n"
        "/dev/mapper/centos-root 106269499392 1464020992 104805478400       2% /\n"
        "/dev/sda1                  520785920  149880832    370905088      29% /boot\n"
    )

    @pytest.fixture()
    def agent_exec(self):
        """让 mock 支持 Guest Agent 执行命令，并记录下真实发出的请求。"""
        import test_pve_client as mock_mod

        exec_key = ("POST", self.EXEC_PATH)
        status_key = ("GET", self.STATUS_PATH)
        originals = {k: mock_mod.ROUTES.get(k) for k in (exec_key, status_key)}
        state: dict = {"out": self.DF_OUTPUT, "err": "", "exitcode": 0}
        before = len(mock_mod.REQUESTS)

        mock_mod.ROUTES[exec_key] = lambda: {"pid": 4242}
        mock_mod.ROUTES[status_key] = lambda: {
            "exited": 1,
            "exitcode": state["exitcode"],
            "out-data": state["out"],
            "err-data": state["err"],
        }
        state["requests"] = lambda: list(mock_mod.REQUESTS[before:])
        try:
            yield state
        finally:
            for key, original in originals.items():
                if original is not None:
                    mock_mod.ROUTES[key] = original
                else:
                    mock_mod.ROUTES.pop(key, None)

    def test_parses_filesystems_and_drops_pseudo_fs(self, api, agent_exec) -> None:
        resp = api.post("/api/vms/pve1/100/disk-usage", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        filesystems = resp.json()["filesystems"]
        assert [f["mountpoint"] for f in filesystems] == ["/", "/boot"]
        assert filesystems[0]["total_bytes"] == 106269499392
        assert filesystems[0]["percent"] == 1.4
        # tmpfs 不是磁盘，不能混进用量里
        assert all("tmpfs" not in f["filesystem"] for f in filesystems)

    def test_sends_a_valid_pve_exec_request(self, api, agent_exec) -> None:
        """回归用例：两个曾经写错的调用形态。

        1. ``capture-output`` 不在 PVE 8.4 的 schema 里，带上它请求会被直接拒掉
           （``property is not defined in schema``）。
        2. ``agent/exec-status`` 是 **GET** 接口，用 POST 会 ``not implemented``。

        两者都会让「在客户机内执行命令」这条路彻底走不通。
        """
        api.post("/api/vms/pve1/100/disk-usage", headers=auth_headers(api))
        requests = agent_exec["requests"]()

        exec_calls = [body for m, p, body, _ in requests if p == self.EXEC_PATH]
        assert exec_calls[-1]["command"] == ["/bin/df", "-P", "-B1"]
        assert "capture-output" not in exec_calls[-1]

        status_methods = {m for m, p, _, _ in requests if p == self.STATUS_PATH}
        assert status_methods == {"GET"}

    def test_plain_text_output_is_accepted(self, api, agent_exec) -> None:
        # PVE 8.4 实测返回明文（不是文档里写的 base64），必须照样能解析
        agent_exec["out"] = self.DF_OUTPUT
        resp = api.post("/api/vms/pve1/100/disk-usage", headers=auth_headers(api))
        assert resp.status_code == 200
        assert resp.json()["filesystems"]

    def test_command_failure_is_reported(self, api, agent_exec) -> None:
        agent_exec["exitcode"] = 127
        agent_exec["err"] = "sh: /bin/df: No such file or directory"
        resp = api.post("/api/vms/pve1/100/disk-usage", headers=auth_headers(api))
        assert resp.status_code == 502
        assert "df" in resp.json()["detail"]

    def test_agent_call_failure_is_reported(self, api) -> None:
        """mock 里没有 agent/exec 路由 → 501 → 应翻成明确的 502 中文提示。"""
        resp = api.post("/api/vms/pve1/100/disk-usage", headers=auth_headers(api))
        assert resp.status_code in (501, 502)
        if resp.status_code == 502:
            assert "Guest Agent" in resp.json()["detail"]

    def test_rejects_when_agent_not_enabled(self, api) -> None:
        import test_pve_client as mock_mod

        key = ("GET", "/api2/json/nodes/pve1/qemu/100/config")
        original = mock_mod.ROUTES.get(key)
        mock_mod.ROUTES[key] = lambda: {**mock_mod.VM_CONFIG, "agent": 0}
        try:
            resp = api.post(
                "/api/vms/pve1/100/disk-usage", headers=auth_headers(api)
            )
            assert resp.status_code == 400
            assert "Guest Agent" in resp.json()["detail"]
        finally:
            if original is not None:
                mock_mod.ROUTES[key] = original
            else:
                mock_mod.ROUTES.pop(key, None)

    def test_viewer_of_other_vm_is_blocked(self, api) -> None:
        """归属隔离：普通用户不能拿别人的虚拟机当命令通道。"""
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "duviewer", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=admin,
        )
        token = api.post(
            "/api/auth/login", json={"username": "duviewer", "password": "Unit-Test-Pa55word"}
        ).json()["access_token"]
        resp = api.post(
            "/api/vms/pve1/100/disk-usage",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403


# --------------------------------------------------------- 虚拟机下发总配额
class TestVmQuota:
    """可下发虚拟机数量：**全局**容量上限，不是按用户分配的。

    mock 的 cluster/resources 里有两台 qemu（100 与模板 9000），所以 used == 2。
    """

    PAYLOAD = {
        "node": "pve1",
        "name": "quota-vm",
        "memory": 1024,
        "cores": 1,
        "disks": [{"storage": "local-lvm", "size": 20, "interface": "scsi0"}],
        "networks": [{"bridge": "vmbr0", "model": "virtio"}],
    }

    def _operator(self, api, username: str = "op1") -> Dict[str, str]:
        admin = auth_headers(api)
        resp = api.post(
            "/api/users",
            json={"username": username, "password": "Unit-Test-Pa55word", "role": "operator"},
            headers=admin,
        )
        assert resp.status_code == 200, resp.text
        login = api.post(
            "/api/auth/login",
            json={"username": username, "password": "Unit-Test-Pa55word"},
        )
        assert login.status_code == 200, login.text
        return {"Authorization": f"Bearer {login.json()['access_token']}"}

    def _set_quota(self, api, value: Any) -> Dict[str, Any]:
        resp = api.put(
            "/api/config/vm-quota", json={"quota": value}, headers=auth_headers(api)
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_unset_quota_never_blocks(self, api) -> None:
        """存量部署装上这个功能不该突然被锁死：只有显式设了数才生效。"""
        operator = self._operator(api)
        resp = api.post("/api/vms", json=self.PAYLOAD, headers=operator)
        assert resp.status_code == 200, resp.text

    def test_zero_quota_blocks_operator(self, api) -> None:
        self._set_quota(api, 0)
        operator = self._operator(api)
        resp = api.post("/api/vms", json=self.PAYLOAD, headers=operator)
        assert resp.status_code == 403
        assert "额度" in resp.json()["detail"]

    def test_exhausted_quota_blocks_operator(self, api) -> None:
        self._set_quota(api, 2)  # 已有 2 台，额度刚好用完
        operator = self._operator(api)
        resp = api.post("/api/vms", json=self.PAYLOAD, headers=operator)
        assert resp.status_code == 403
        assert "已用尽" in resp.json()["detail"]

    def test_quota_with_room_allows_operator(self, api) -> None:
        self._set_quota(api, 3)
        operator = self._operator(api)
        resp = api.post("/api/vms", json=self.PAYLOAD, headers=operator)
        assert resp.status_code == 200, resp.text

    def test_admin_is_not_limited(self, api) -> None:
        """管理员不受限：满了之后还得有人能清理 / 扩容。"""
        self._set_quota(api, 0)
        resp = api.post("/api/vms", json=self.PAYLOAD, headers=auth_headers(api))
        assert resp.status_code == 200, resp.text

    def test_clone_is_blocked_too(self, api) -> None:
        """只在 POST /vms 拦的话，拿已有机器反复克隆就能绕过上限。"""
        self._set_quota(api, 0)
        operator = self._operator(api, "op2")
        # 归属守卫先放行，配额错误才能浮出来
        resp = api.put(
            "/api/vms/pve1/100/owner",
            json={"username": "op2"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        resp = api.post(
            "/api/vms/pve1/100/clone",
            json={"newid": 106, "name": "c1", "full": True},
            headers=operator,
        )
        assert resp.status_code == 403
        assert "额度" in resp.json()["detail"]

    def test_usage_counts_templates_as_well(self, api) -> None:
        """模板在 PVE 里同样是一台虚拟机，必须计入已用。"""
        self._set_quota(api, 5)
        data = api.get("/api/vms/quota", headers=auth_headers(api)).json()
        assert data["quota"] == 5
        assert data["used"] == 2  # VM 100 + 模板 9000
        assert data["remaining"] == 3
        assert data["limited"] is True

    def test_usage_reports_unlimited_when_unset(self, api) -> None:
        data = api.get("/api/vms/quota", headers=auth_headers(api)).json()
        assert data["quota"] is None
        assert data["remaining"] is None
        assert data["limited"] is False
        assert data["can_create"] is True

    def test_operator_sees_cannot_create_at_zero(self, api) -> None:
        """前端靠 can_create 提前禁用「创建」按钮。"""
        self._set_quota(api, 0)
        operator = self._operator(api, "op3")
        data = api.get("/api/vms/quota", headers=operator).json()
        assert data["can_create"] is False
        assert data["remaining"] == 0


# ------------------------------------------------------------------- RBAC
class TestRbac:
    def _make_user(self, api, username: str, role: str) -> Dict[str, str]:
        admin = auth_headers(api)
        resp = api.post(
            "/api/users",
            json={"username": username, "password": "Unit-Test-Pa55word", "role": role},
            headers=admin,
        )
        assert resp.status_code == 200, resp.text
        login = api.post(
            "/api/auth/login",
            json={"username": username, "password": "Unit-Test-Pa55word"},
        )
        assert login.status_code == 200, login.text
        return {"Authorization": f"Bearer {login.json()['access_token']}"}

    def test_viewer_cannot_start_a_vm(self, api) -> None:
        viewer = self._make_user(api, "v1", "viewer")
        # 严格隔离下先指派归属，归属守卫放行后权限错误才能浮出来
        api.put(
            "/api/vms/pve1/100/owner",
            json={"username": "v1"},
            headers=auth_headers(api),
        )
        resp = api.post("/api/vms/pve1/100/status/start", headers=viewer)
        assert resp.status_code == 403
        assert "vm.power" in resp.json()["detail"]

    def test_viewer_can_read(self, api) -> None:
        viewer = self._make_user(api, "v2", "viewer")
        assert api.get("/api/vms", headers=viewer).status_code == 200

    def test_viewer_cannot_list_users(self, api) -> None:
        viewer = self._make_user(api, "v3", "viewer")
        assert api.get("/api/users", headers=viewer).status_code == 403

    def test_operator_power_scoped_to_own_vms(self, api) -> None:
        ops = self._make_user(api, "o1", "operator")
        # 指派到自己名下才可见、可操作
        api.put(
            "/api/vms/pve1/100/owner",
            json={"username": "o1"},
            headers=auth_headers(api),
        )
        assert (
            api.post("/api/vms/pve1/100/status/start", headers=ops).status_code
            == 200
        )
        # 名下之外的虚拟机（无归属的模板 9000）被归属守卫拦下
        assert api.delete("/api/vms/pve1/9000", headers=ops).status_code == 403

    def test_operator_cannot_manage_users(self, api) -> None:
        ops = self._make_user(api, "o2", "operator")
        resp = api.post(
            "/api/users",
            json={"username": "x", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=ops,
        )
        assert resp.status_code == 403

    def test_operator_cannot_change_connection_config(self, api) -> None:
        ops = self._make_user(api, "o3", "operator")
        resp = api.put(
            "/api/config/connection",
            json={"host": "evil.example.com", "port": 8006},
            headers=ops,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_open_console(self, api) -> None:
        viewer = self._make_user(api, "v4", "viewer")
        resp = api.post("/api/vms/pve1/100/console/vncproxy", headers=viewer)
        assert resp.status_code == 403


# ------------------------------------------------------- console websocket
class TestConsoleWebSocket:
    """WS 握手不得被路由级 OAuth2 依赖炸掉（回归：TypeError → 握手 500）。

    浏览器 WebSocket 无法携带 Authorization 头，鉴权走 ``?token=`` 查询参数。
    曾因 router 级 dependencies 挂着 bind_vm_connection → OAuth2PasswordBearer，
    握手在 ASGI 层抛 TypeError 直接 500，前端表现即「与 VNC 代理的连接意外中断」。
    鉴权通过后端点先 accept（101），随后 mock 上游不提供 WS 会以 1011 关闭——
    这两个阶段都走通，才说明握手路径上没有任何 HTTP 专属依赖。
    """

    @staticmethod
    def _handshake(api, path: str) -> int | None:
        token = auth_headers(api)["Authorization"].split(" ", 1)[1]
        with api.websocket_connect(
            f"{path}?port=5900&vncticket=test&token={token}"
        ) as ws:
            message = ws.receive()
        assert message["type"] in ("websocket.close", "websocket.disconnect"), message
        return message.get("code")

    def test_vnc_ws_handshake_survives(self, api) -> None:
        assert self._handshake(api, "/api/vms/pve1/100/console/vncws") in (None, 1000, 1011)

    def test_xterm_ws_handshake_survives(self, api) -> None:
        assert self._handshake(api, "/api/vms/pve1/100/console/xtermws") in (None, 1000, 1011)


# ------------------------------------------------------- user lifecycle
class TestUserLifecycle:
    def test_roles_endpoint_precedes_username_route(self, api) -> None:
        """/users/roles must not be swallowed by /users/{username}."""
        resp = api.get("/api/users/roles", headers=auth_headers(api))
        assert resp.status_code == 200
        roles = resp.json()
        assert {r["role"] for r in roles} == {"admin", "operator", "viewer"}

    def test_create_update_delete_user(self, api) -> None:
        admin = auth_headers(api)

        created = api.post(
            "/api/users",
            json={
                "username": "temp",
                "password": "Unit-Test-Pa55word",
                "role": "viewer",
                "email": "t@example.com",
            },
            headers=admin,
        )
        assert created.status_code == 200

        updated = api.put(
            "/api/users/temp", json={"role": "operator"}, headers=admin
        )
        assert updated.status_code == 200
        assert updated.json()["role"] == "operator"

        deleted = api.delete("/api/users/temp", headers=admin)
        assert deleted.status_code == 200
        assert api.get("/api/users/temp", headers=admin).status_code == 404

    def test_admin_can_reset_another_users_password(self, api) -> None:
        """管理员重置他人密码：旧密码立刻失效，新密码能登录。

        这条链路（用户管理 → 钥匙图标 → 弹窗）以前没有任何用例覆盖，
        只测过改角色；一旦 update_user 的 password 分支写坏，界面上会
        显示「已重置」但用户实际登不进去。
        """
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "resetme", "password": "oldpass123", "role": "viewer"},
            headers=admin,
        )
        assert (
            api.post(
                "/api/auth/login",
                json={"username": "resetme", "password": "oldpass123"},
            ).status_code
            == 200
        )

        resp = api.put(
            "/api/users/resetme", json={"password": "Unit-Test-NewPa55"}, headers=admin
        )
        assert resp.status_code == 200, resp.text

        # 旧密码必须失效，否则等于没重置
        assert (
            api.post(
                "/api/auth/login",
                json={"username": "resetme", "password": "oldpass123"},
            ).status_code
            == 401
        )
        assert (
            api.post(
                "/api/auth/login",
                json={"username": "resetme", "password": "Unit-Test-NewPa55"},
            ).status_code
            == 200
        )

    def test_operator_cannot_reset_passwords(self, api) -> None:
        """改别人密码属于 users.manage，普通用户没有这个权限。"""
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "opwd", "password": "Unit-Test-Pa55word", "role": "operator"},
            headers=admin,
        )
        api.post(
            "/api/users",
            json={"username": "victim", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=admin,
        )
        login = api.post(
            "/api/auth/login", json={"username": "opwd", "password": "Unit-Test-Pa55word"}
        )
        operator = {"Authorization": f"Bearer {login.json()['access_token']}"}
        resp = api.put("/api/users/victim", json={"password": "hacked123"}, headers=operator)
        assert resp.status_code == 403

    def test_duplicate_username_rejected(self, api) -> None:
        admin = auth_headers(api)
        body = {"username": "dup", "password": "Unit-Test-Pa55word", "role": "viewer"}
        assert api.post("/api/users", json=body, headers=admin).status_code == 200
        assert api.post("/api/users", json=body, headers=admin).status_code == 409

    def test_cannot_delete_self(self, api) -> None:
        admin = auth_headers(api)
        resp = api.delete("/api/users/admin", headers=admin)
        assert resp.status_code == 409

    def test_cannot_demote_last_admin(self, api) -> None:
        admin = auth_headers(api)
        resp = api.put(
            "/api/users/admin", json={"role": "viewer"}, headers=admin
        )
        assert resp.status_code == 409

    def test_weak_password_rejected(self, api) -> None:
        resp = api.post(
            "/api/users",
            json={"username": "weak", "password": "123", "role": "viewer"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 422


# ---------------------------------------------- 自助重置密码（忘记密码）
class TestSelfServicePasswordReset:
    """登录页「忘记密码」→ 邮件一次性链接 → 设新密码。

    公开接口，安全属性比功能本身更要紧：
    不能用来枚举账号、令牌一次性和过期、改完旧链接作废。
    """

    def _mail(self, api, monkeypatch) -> tuple:
        """拦下真实发信，只记录邮件内容。"""
        from app import mailer

        sent: List[Dict[str, Any]] = []

        async def fake_send_mail(to, subject, body, *, html=None, cfg=None):
            sent.append({"to": to, "subject": subject, "body": body, "html": html})
            return True, "已发送"

        monkeypatch.setattr(mailer, "send_mail", fake_send_mail)
        return sent

    def _make(self, api, username: str, email: str, role: str = "viewer") -> None:
        resp = api.post(
            "/api/users",
            json={"username": username, "password": "oldpass123", "role": role, "email": email},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text

    def test_full_flow_resets_password(self, api, monkeypatch) -> None:
        sent = self._mail(api, monkeypatch)
        self._make(api, "forgot", "f@example.com")

        resp = api.post("/api/auth/forgot-password", json={"username": "forgot"})
        assert resp.status_code == 200, resp.text

        # 邮件里必须带一条可用链接
        assert len(sent) == 1
        body = sent[0]["body"]
        assert "/reset-password?token=" in body
        token = body.split("/reset-password?token=", 1)[1].split()[0]

        # 链接有效
        check = api.post("/api/auth/reset-password/check", json={"token": token})
        assert check.json() == {"valid": True, "username": "forgot"}

        # 设置新密码
        resp = api.post(
            "/api/auth/reset-password", json={"token": token, "password": "Unit-Test-NewPa55"}
        )
        assert resp.status_code == 200, resp.text

        # 新密码能登录、旧密码不行
        assert (
            api.post(
                "/api/auth/login", json={"username": "forgot", "password": "Unit-Test-NewPa55"}
            ).status_code
            == 200
        )
        assert (
            api.post(
                "/api/auth/login", json={"username": "forgot", "password": "oldpass123"}
            ).status_code
            == 401
        )

    def test_token_is_single_use(self, api, monkeypatch) -> None:
        sent = self._mail(api, monkeypatch)
        self._make(api, "once", "o@example.com")
        api.post("/api/auth/forgot-password", json={"username": "once"})
        token = sent[0]["body"].split("/reset-password?token=", 1)[1].split()[0]

        assert (
            api.post(
                "/api/auth/reset-password",
                json={"token": token, "password": "Unit-Test-NewPa55"},
            ).status_code
            == 200
        )
        # 同一条链接第二次就失效了
        again = api.post(
            "/api/auth/reset-password", json={"token": token, "password": "another789"}
        )
        assert again.status_code == 400
        assert "无效或已过期" in again.json()["detail"]

    def test_unknown_username_returns_the_same_answer(self, api, monkeypatch) -> None:
        """账号不存在时的响应必须和存在时一模一样 —— 否则就是账号枚举机。"""
        sent = self._mail(api, monkeypatch)
        self._make(api, "exists", "e@example.com")

        ok = api.post("/api/auth/forgot-password", json={"username": "exists"})
        missing = api.post("/api/auth/forgot-password", json={"username": "nobody"})

        assert ok.status_code == missing.status_code == 200
        assert ok.json() == missing.json()
        # 而且确实没给不存在的账号发信
        assert len(sent) == 1

    def test_account_without_email_is_silently_skipped(self, api, monkeypatch) -> None:
        sent = self._mail(api, monkeypatch)
        self._make(api, "nomail", "")
        resp = api.post("/api/auth/forgot-password", json={"username": "nomail"})
        assert resp.status_code == 200
        assert sent == []  # 没邮箱就发不出去，但不对外说

    def test_pending_account_cannot_reset(self, api, monkeypatch) -> None:
        """待审批的账号本来就不能登录，不该能自助重置。"""
        sent = self._mail(api, monkeypatch)
        self._make(api, "pending1", "p@example.com")
        api.put("/api/users/pending1", json={"status": "pending"}, headers=auth_headers(api))

        resp = api.post("/api/auth/forgot-password", json={"username": "pending1"})
        assert resp.status_code == 200
        assert sent == []

    def test_expired_token_is_rejected(self, api, monkeypatch) -> None:
        import time as time_module

        import pymysql

        sent = self._mail(api, monkeypatch)
        self._make(api, "expire", "x@example.com")
        api.post("/api/auth/forgot-password", json={"username": "expire"})
        token = sent[0]["body"].split("/reset-password?token=", 1)[1].split()[0]

        # 有效期是签发时写进库里的，改 TOKEN_TTL 常量不会影响已发出的令牌，
        # 所以直接把这条记录拨到过去，模拟「隔了很久才点开链接」。
        # 这里必须用同步 pymysql：aiomysql 的全局连接池绑在 TestClient 的
        # 事件循环上，asyncio.run() 新开循环去借池会炸「Future attached to
        # a different loop」（database.read_setting_sync 是同款先例）。
        conn = pymysql.connect(
            host=settings.db_host,
            port=int(settings.db_port),
            user=settings.db_user,
            password=settings.db_password,
            database=settings.db_name,
            charset="utf8mb4",
            connect_timeout=5,
        )
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE password_reset SET expires = %s",
                    (time_module.time() - 1,),
                )
            conn.commit()
        finally:
            conn.close()

        assert (
            api.post("/api/auth/reset-password/check", json={"token": token}).json()[
                "valid"
            ]
            is False
        )
        resp = api.post(
            "/api/auth/reset-password", json={"token": token, "password": "Unit-Test-NewPa55"}
        )
        assert resp.status_code == 400
        assert "无效或已过期" in resp.json()["detail"]

    def test_weak_new_password_is_rejected(self, api, monkeypatch) -> None:
        sent = self._mail(api, monkeypatch)
        self._make(api, "weak", "w@example.com")
        api.post("/api/auth/forgot-password", json={"username": "weak"})
        token = sent[0]["body"].split("/reset-password?token=", 1)[1].split()[0]

        resp = api.post(
            "/api/auth/reset-password", json={"token": token, "password": "nodigits"}
        )
        assert resp.status_code == 400

    def test_reset_purges_other_tokens_for_the_same_user(self, api, monkeypatch) -> None:
        """改完密码，邮箱里可能还有几条旧链接，必须一起作废。"""
        sent = self._mail(api, monkeypatch)
        self._make(api, "twice", "t@example.com")
        api.post("/api/auth/forgot-password", json={"username": "twice"})
        api.post("/api/auth/forgot-password", json={"username": "twice"})
        assert len(sent) == 2
        first = sent[0]["body"].split("/reset-password?token=", 1)[1].split()[0]
        second = sent[1]["body"].split("/reset-password?token=", 1)[1].split()[0]

        assert (
            api.post(
                "/api/auth/reset-password",
                json={"token": second, "password": "Unit-Test-NewPa55"},
            ).status_code
            == 200
        )
        # 先发的那条（还没用过）也必须失效
        assert (
            api.post(
                "/api/auth/reset-password/check", json={"token": first}
            ).json()["valid"]
            is False
        )


# ---------------------------------------------- 自助注册 + 管理员审批
class TestRegistrationApproval:
    """注册 → 审批 → 登录 的完整链路。

    注册是公开接口，建出来的账号状态必须是 pending，审批通过前一律登不进来。
    """

    @staticmethod
    def _register(
        api, username: str, password: str = "Unit-Test-Pa55word", email: str = "user@example.com"
    ):
        # 邮箱现在是必填项，默认给一个合法地址；测「缺邮箱」的用例自己传空串
        return api.post(
            "/api/auth/register",
            json={"username": username, "password": password, "email": email},
        )

    @staticmethod
    def _login(api, username: str, password: str = "Unit-Test-Pa55word"):
        return api.post(
            "/api/auth/login", json={"username": username, "password": password}
        )

    def test_register_is_public_and_creates_pending_account(self, api) -> None:
        resp = self._register(api, "newbie", email="newbie@example.com")
        assert resp.status_code == 201, resp.text
        assert resp.json()["status"] == "pending"

        # 待审批期间不能登录
        login = self._login(api, "newbie")
        assert login.status_code == 403
        assert "审批" in login.json()["detail"]

        # 账号确实进了审批队列
        admin = auth_headers(api)
        pending = api.get("/api/users?status=pending", headers=admin)
        assert pending.status_code == 200
        assert [u["username"] for u in pending.json()] == ["newbie"]
        assert pending.json()[0]["status"] == "pending"

    def test_register_rejects_duplicate_and_weak_input(self, api) -> None:
        assert self._register(api, "dup2").status_code == 201
        # 重复注册（无论什么状态）都算被占用
        assert self._register(api, "dup2").status_code == 409
        # 管理员建的同名账号同样挡住
        assert self._register(api, "admin").status_code == 409
        # 密码强度：schema 要求至少 8 位
        assert self._register(api, "short", password="123").status_code == 422
        # 8 位但纯数字，被 _password_weak_reason 挡下
        assert self._register(api, "digits", password="12345678").status_code == 400

    def test_approve_grants_role_and_permissions(self, api) -> None:
        assert self._register(api, "op1").status_code == 201
        admin = auth_headers(api)

        approved = api.post(
            "/api/users/op1/approve",
            json={"role": "operator"},
            headers=admin,
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "active"
        assert approved.json()["role"] == "operator"

        # 审批通过后就能登录，且角色已生效
        login = self._login(api, "op1")
        assert login.status_code == 200, login.text
        assert login.json()["user"]["role"] == "operator"

    def test_approve_with_custom_permissions_overrides_role(self, api) -> None:
        assert self._register(api, "limited").status_code == 201
        admin = auth_headers(api)

        approved = api.post(
            "/api/users/limited/approve",
            json={
                "role": "viewer",
                "permissions": ["vm.view"],
                "set_permissions": True,
            },
            headers=admin,
        )
        assert approved.status_code == 200, approved.text

        token = self._login(api, "limited")
        assert token.status_code == 200
        headers = {"Authorization": f"Bearer {token.json()['access_token']}"}

        # 只有 vm.view：虚拟机列表可读
        assert api.get("/api/vms", headers=headers).status_code == 200
        # 但用户管理被拦下（角色本来的 users.view 已被覆盖掉）
        assert api.get("/api/users", headers=headers).status_code == 403

    def test_reject_keeps_account_but_blocks_login(self, api) -> None:
        assert self._register(api, "spammer").status_code == 201
        admin = auth_headers(api)

        rejected = api.post(
            "/api/users/spammer/reject",
            json={"reason": "不认识这个人"},
            headers=admin,
        )
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["status"] == "rejected"

        login = self._login(api, "spammer")
        assert login.status_code == 403
        assert "未通过" in login.json()["detail"]

        # 用户名仍被占住，不能被别人重新注册
        assert self._register(api, "spammer").status_code == 409

    def test_pending_user_cannot_be_approved_twice(self, api) -> None:
        assert self._register(api, "twice").status_code == 201
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users/twice/approve", json={"role": "viewer"}, headers=admin
            ).status_code
            == 200
        )
        again = api.post(
            "/api/users/twice/approve", json={"role": "viewer"}, headers=admin
        )
        assert again.status_code == 409

    def test_revoking_approval_invalidates_existing_token(self, api) -> None:
        """把账号打回 pending，已经发出去的 token 必须立刻失效。"""
        assert self._register(api, "revoke").status_code == 201
        admin = auth_headers(api)
        api.post("/api/users/revoke/approve", json={"role": "viewer"}, headers=admin)

        token = self._login(api, "revoke")
        assert token.status_code == 200
        headers = {"Authorization": f"Bearer {token.json()['access_token']}"}
        assert api.get("/api/vms", headers=headers).status_code == 200

        api.put("/api/users/revoke", json={"status": "pending"}, headers=admin)

        blocked = api.get("/api/vms", headers=headers)
        # 打回 pending 会顺带把会话版本 +1（连同 refresh 会话一起撤销），所以这枚
        # 旧 token 已经不被承认：返回 401，前端据此清会话回登录页，重新登录时才会
        # 看到「等待审批」的提示。
        # （在会话版本机制之前，这里靠「状态非 active」返回 403 + 审批文案。）
        assert blocked.status_code == 401
        assert "登录状态" in blocked.json()["detail"]
        # 重新登录时给的是「待审批」的明确原因
        again = api.post(
            "/api/auth/login",
            json={"username": "revoke", "password": "Unit-Test-Pa55word"},
        )
        assert again.status_code in (401, 403)
        assert "审批" in again.json()["detail"]

    def test_non_admin_cannot_approve(self, api) -> None:
        assert self._register(api, "victim").status_code == 201
        admin = auth_headers(api)

        # 造一个普通用户（管理员直接建，状态就是 active）
        api.post(
            "/api/users",
            json={"username": "plain", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=admin,
        )
        viewer = self._login(api, "plain")
        assert viewer.status_code == 200
        vheaders = {"Authorization": f"Bearer {viewer.json()['access_token']}"}

        assert (
            api.post(
                "/api/users/victim/approve", json={"role": "admin"}, headers=vheaders
            ).status_code
            == 403
        )
        assert api.post("/api/users/victim/reject", json={}, headers=vheaders).status_code == 403

    def test_register_is_rate_limited_per_ip(self, api) -> None:
        for i in range(5):
            assert self._register(api, f"bulk{i}").status_code == 201
        assert self._register(api, "bulk5").status_code == 429

    def test_register_audit_trail(self, api) -> None:
        assert self._register(api, "audited").status_code == 201
        admin = auth_headers(api)
        api.post("/api/users/audited/approve", json={"role": "viewer"}, headers=admin)

        rows = api.get("/api/audit?action=auth.register", headers=admin).json()
        assert rows["total"] >= 1
        assert rows["items"][0]["target"] == "audited"

        approvals = api.get("/api/audit?action=user.approve", headers=admin).json()
        assert approvals["total"] >= 1
        assert approvals["items"][0]["target"] == "audited"


# ------------------------------------------------------- 邮件通知（SMTP）
class TestMailNotifications:
    """邮件配置接口 + 注册/审批触发的发信。

    发信本身不碰真实 SMTP：把 ``mailer._deliver`` 换掉，直接检查构造出来的
    邮件报文，这样既验证了「真的发了」，也不依赖任何外部服务。
    """

    @pytest.fixture()
    def outbox(self, monkeypatch):
        """拦下投递动作，收集实际发出去的邮件。"""
        from app import mailer as mailer_mod

        sent: list = []
        monkeypatch.setattr(
            mailer_mod, "_deliver", lambda cfg, message: sent.append(message)
        )
        return sent

    # ---- 配置接口 ----
    def test_requires_login(self, api) -> None:
        assert api.get("/api/config/mail").status_code == 401
        assert api.put("/api/config/mail", json={}).status_code == 401

    def test_only_admin_can_change_settings(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "mailviewer", "password": "Unit-Test-Pa55word", "role": "viewer"},
            headers=admin,
        )
        token = api.post(
            "/api/auth/login", json={"username": "mailviewer", "password": "Unit-Test-Pa55word"}
        ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        # 读只要登录；写要 settings.manage
        assert api.get("/api/config/mail", headers=headers).status_code == 200
        assert api.put("/api/config/mail", json={"host": "x"}, headers=headers).status_code == 403
        assert api.post("/api/config/mail/test", json={}, headers=headers).status_code == 403

    def test_password_is_write_only(self, api) -> None:
        admin = auth_headers(api)
        saved = api.put(
            "/api/config/mail",
            json={
                "enabled": True,
                "host": "smtp.example.com",
                "port": 465,
                "tls": "ssl",
                "username": "panel",
                "password": "s3cret",
                "sender": "noreply@example.com",
                "verify_ssl": False,
                "admin_recipients": "ops@example.com; boss@example.com",
            },
            headers=admin,
        )
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert "password" not in body  # 明文永不回传
        assert body["password_set"] is True
        assert body["configured"] is True
        # 收件人分隔符被归一
        assert body["admin_recipients"] == "ops@example.com,boss@example.com"

        # 再次读取同样拿不到密码
        again = api.get("/api/config/mail", headers=admin).json()
        assert "password" not in again and again["password_set"] is True

    def test_blank_password_keeps_the_old_one_until_cleared(self, api) -> None:
        admin = auth_headers(api)
        api.put(
            "/api/config/mail",
            json={"host": "smtp.example.com", "sender": "a@b.com", "password": "s3cret"},
            headers=admin,
        )

        # 留空 = 沿用
        api.put("/api/config/mail", json={"host": "smtp2.example.com"}, headers=admin)
        kept = api.get("/api/config/mail", headers=admin).json()
        assert kept["password_set"] is True
        assert kept["host"] == "smtp2.example.com"

        # 显式清除
        api.put("/api/config/mail", json={"password_clear": True}, headers=admin)
        assert api.get("/api/config/mail", headers=admin).json()["password_set"] is False

    def test_enabling_without_host_is_rejected(self, api) -> None:
        resp = api.put(
            "/api/config/mail", json={"enabled": True}, headers=auth_headers(api)
        )
        assert resp.status_code == 400
        assert "SMTP" in resp.json()["detail"]

    def test_bad_tls_mode_is_rejected(self, api) -> None:
        resp = api.put(
            "/api/config/mail",
            json={"host": "smtp.example.com", "tls": "plain"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 400
        assert "加密方式" in resp.json()["detail"]

    def test_test_send_reports_failure_instead_of_pretending(self, api) -> None:
        # 没配 SMTP，点测试应当明确报错而不是假装成功
        resp = api.post(
            "/api/config/mail/test", json={"to": "a@b.com"}, headers=auth_headers(api)
        )
        assert resp.status_code == 400
        assert "SMTP" in resp.json()["detail"]

    # ---- 注册 / 审批触发 ----
    def test_registration_requires_email(self, api) -> None:
        # schema 层：字段缺失直接 422
        assert (
            api.post(
                "/api/auth/register",
                json={"username": "noemail", "password": "Unit-Test-Pa55word"},
            ).status_code
            == 422
        )
        # 空串能过 schema，由接口层挡下
        resp = api.post(
            "/api/auth/register",
            json={"username": "noemail", "password": "Unit-Test-Pa55word", "email": ""},
        )
        assert resp.status_code == 400
        assert "邮箱" in resp.json()["detail"]

    def test_registration_notifies_admins(self, api, outbox) -> None:
        admin = auth_headers(api)
        # 管理员收件人留空时回退到「填了邮箱的管理员」
        api.put("/api/auth/me", json={"email": "boss@example.com"}, headers=admin)
        api.put(
            "/api/config/mail",
            json={
                "enabled": True,
                "host": "smtp.example.com",
                "sender": "noreply@example.com",
            },
            headers=admin,
        )

        resp = api.post(
            "/api/auth/register",
            json={
                "username": "mailreg",
                "password": "Unit-Test-Pa55word",
                "email": "newbie@example.com",
            },
        )
        assert resp.status_code == 201, resp.text
        assert len(outbox) == 1
        message = outbox[0]
        assert "boss@example.com" in str(message["To"])
        assert "mailreg" in message["Subject"]
        body = message.get_body(preferencelist=("plain",)).get_content()
        assert "mailreg" in body and "newbie@example.com" in body

    def test_registration_skips_mail_when_unconfigured(self, api, outbox) -> None:
        """邮件不是关键路径：没配 SMTP 也必须能注册成功，只把原因记进审计。"""
        resp = api.post(
            "/api/auth/register",
            json={
                "username": "noready",
                "password": "Unit-Test-Pa55word",
                "email": "n@example.com",
            },
        )
        assert resp.status_code == 201
        assert outbox == []

        rows = api.get(
            "/api/audit?action=auth.register", headers=auth_headers(api)
        ).json()
        assert "邮件通知未配置" in str(rows["items"][0]["detail"])

    def test_approval_notifies_the_registered_user(self, api, outbox) -> None:
        admin = auth_headers(api)
        api.put(
            "/api/config/mail",
            json={
                "enabled": True,
                "host": "smtp.example.com",
                "sender": "noreply@example.com",
            },
            headers=admin,
        )
        api.post(
            "/api/auth/register",
            json={
                "username": "approveme",
                "password": "Unit-Test-Pa55word",
                "email": "approveme@example.com",
            },
        )
        outbox.clear()  # 只关心审批这一封

        approved = api.post(
            "/api/users/approveme/approve", json={"role": "operator"}, headers=admin
        )
        assert approved.status_code == 200, approved.text
        assert len(outbox) == 1

        message = outbox[0]
        assert "approveme@example.com" in str(message["To"])
        body = message.get_body(preferencelist=("plain",)).get_content()
        assert "approveme" in body
        # 审批时定的角色要写进通知里（角色名以库里的定义为准，不写死文案）
        role_name = next(
            r["name"]
            for r in api.get("/api/users/roles", headers=admin).json()
            if r["id"] == "operator"
        )
        assert role_name in body

    def test_rejection_notifies_the_registered_user(self, api, outbox) -> None:
        admin = auth_headers(api)
        api.put(
            "/api/config/mail",
            json={
                "enabled": True,
                "host": "smtp.example.com",
                "sender": "noreply@example.com",
            },
            headers=admin,
        )
        api.post(
            "/api/auth/register",
            json={
                "username": "rejectme",
                "password": "Unit-Test-Pa55word",
                "email": "rejectme@example.com",
            },
        )
        outbox.clear()

        rejected = api.post(
            "/api/users/rejectme/reject",
            json={"reason": "非本单位人员"},
            headers=admin,
        )
        assert rejected.status_code == 200, rejected.text
        assert len(outbox) == 1
        body = outbox[0].get_body(preferencelist=("plain",)).get_content()
        assert "非本单位人员" in body

    # ---- 告警邮件通道（按用户） ----
    def test_alert_email_config_roundtrip(self, api) -> None:
        admin = auth_headers(api)
        overview = api.get("/api/alerts", headers=admin).json()
        assert overview["email"] == {"enabled": False, "recipients": ""}
        assert overview["mail_ready"] is False

        saved = api.put(
            "/api/alerts/email",
            json={"enabled": True, "recipients": "ops@example.com, me@example.com"},
            headers=admin,
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["email"]["recipients"] == "ops@example.com,me@example.com"

        # 普通用户改的是自己那一份，不影响管理员
        api.post(
            "/api/users",
            json={"username": "mailuser", "password": "Unit-Test-Pa55word", "role": "operator"},
            headers=admin,
        )
        token = api.post(
            "/api/auth/login", json={"username": "mailuser", "password": "Unit-Test-Pa55word"}
        ).json()["access_token"]
        theirs = api.get(
            "/api/alerts", headers={"Authorization": f"Bearer {token}"}
        ).json()
        assert theirs["email"]["enabled"] is False

        mine = api.get("/api/alerts", headers=admin).json()
        assert mine["email"]["enabled"] is True

    def test_alert_email_rejects_bad_address(self, api) -> None:
        resp = api.put(
            "/api/alerts/email",
            json={"enabled": True, "recipients": "not-an-email"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 400
        assert "收件地址" in resp.json()["detail"]

    def test_mail_ready_flag_reflects_global_smtp(self, api) -> None:
        admin = auth_headers(api)
        assert api.get("/api/alerts", headers=admin).json()["mail_ready"] is False
        api.put(
            "/api/config/mail",
            json={"enabled": True, "host": "smtp.example.com", "sender": "a@b.com"},
            headers=admin,
        )
        assert api.get("/api/alerts", headers=admin).json()["mail_ready"] is True


# ------------------------------------------------------------------ audit
class TestAuditTrail:
    def test_login_is_recorded(self, api) -> None:
        admin = auth_headers(api)
        resp = api.get("/api/audit?action=auth.login", headers=admin)
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] >= 1
        assert body["items"][0]["action"] == "auth.login"

    def test_failed_login_is_recorded(self, api) -> None:
        api.post(
            "/api/auth/login", json={"username": "admin", "password": "wrong"}
        )
        admin = auth_headers(api)
        resp = api.get("/api/audit?result=failed", headers=admin)
        assert resp.status_code == 200
        assert resp.json()["total"] >= 1

    def test_write_actions_are_recorded_with_target(self, api) -> None:
        admin = auth_headers(api)
        api.post("/api/vms/pve1/100/status/start", headers=admin)

        resp = api.get("/api/audit?action=vm.start", headers=admin)
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert items, "vm start should be audited"
        assert items[0]["target"] == "pve1/100"
        assert items[0]["username"] == "admin"


# --------------------------------------------------------------- config
class TestConnectionConfig:
    def test_secret_is_never_returned(self, api) -> None:
        resp = api.get("/api/config/connection", headers=auth_headers(api))
        assert resp.status_code == 200
        body = resp.json()
        # Only a boolean flag, never the secret itself.
        assert "token_secret" not in body
        assert "token_secret_set" in body
        assert "console_password" not in body

    def test_saving_keeps_existing_secret_when_omitted(self, api) -> None:
        admin = auth_headers(api)
        api.put(
            "/api/config/connection",
            json={
                "host": "pve.example.com",
                "port": 8006,
                "token_id": "a@pve!t",
                "token_secret": "super-secret-value",
                "verify_ssl": False,
                "node_default": "pve1",
            },
            headers=admin,
        )
        # Now update without sending the secret — it must survive.
        api.put(
            "/api/config/connection",
            json={
                "host": "pve2.example.com",
                "port": 8006,
                "token_id": "a@pve!t",
                "verify_ssl": False,
                "node_default": "pve1",
            },
            headers=admin,
        )
        cfg = store.get_connection_config()
        assert cfg["host"] == "pve2.example.com"
        assert cfg["token_secret"] == "super-secret-value"

    def test_secrets_are_encrypted_in_the_database(self, api) -> None:
        """PVE 密钥落库必须是密文。

        ``token_secret`` 等同于「以面板身份操作整个 Proxmox 集群」的权限，
        ``console_password`` 能直接登进虚拟机控制台 —— settings 表被拖走、
        备份泄露或被 SQL 注入读到时，明文就是最高危的那一档。加密与
        SMTP/飞书/腾讯云密钥走同一套 crypto，读取侧解密，业务层无感。
        """
        admin = auth_headers(api)
        resp = api.put(
            "/api/config/connection",
            json={
                "host": "pve.example.com",
                "port": 8006,
                "token_id": "a@pve!t",
                "token_secret": "plain-token-secret",
                "console_user": "root@pam",
                "console_password": "plain-console-password",
                "verify_ssl": False,
                "node_default": "pve1",
            },
            headers=admin,
        )
        assert resp.status_code == 200

        # 直接读库（绕过 store 的解密），看落盘的到底是什么
        conn = connect(settings.db_name)
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT `value` FROM settings WHERE `key` = %s",
                    ("pve_connections",),
                )
                row = cursor.fetchone()
        finally:
            conn.close()
        assert row, "连接配置应该已经落库"
        raw = row[0]
        assert "plain-token-secret" not in raw
        assert "plain-console-password" not in raw
        assert "enc:v1:" in raw

        # 读取侧解密，后端拿到的仍然是明文（签名、控制台登录照常工作）
        cfg = store.get_connection_config()
        assert cfg["token_secret"] == "plain-token-secret"
        assert cfg["console_password"] == "plain-console-password"

    def test_health_reports_unconfigured_clearly(self, api) -> None:
        # Empty the stored config and point the client at an empty connection.
        _clear_connection_config()
        pve_module._client = pve_module.ProxmoxClient(PveConnection())

        resp = api.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["pve_connected"] is False
        assert "未配置" in body["error"]

    def test_pve_backed_routes_require_configuration(self, api) -> None:
        _clear_connection_config()
        pve_module._client = pve_module.ProxmoxClient(PveConnection())

        resp = api.get("/api/vms", headers=auth_headers(api))
        # 428 Precondition Required tells the UI to open Settings.
        assert resp.status_code == 428


def _clear_connection_config() -> None:
    """Synchronously wipe the stored connection so the client looks unconfigured."""
    delete_setting_sync("pve_connection")


# ---------------------------------------------------------- startup resilience
class TestStartupResilience:
    """A broken Proxmox must never stop the panel from starting.

    The startup probe is a convenience log line, not a precondition. If a bad
    host, a TLS failure or an intercepting proxy aborted startup, the operator
    would have no UI in which to fix the connection settings.
    """

    def _boot_with_probe_error(self, monkeypatch, exc):
        # "Configured" so the probe actually runs, pointed at a dead address.
        conn = PveConnection(
            host="https://192.0.2.10",  # TEST-NET-1, guaranteed unroutable
            port=8006,
            token_id="probe@pve!panel",
            token_secret="00000000-0000-0000-0000-000000000000",
            verify_ssl=False,
        )
        pve_module._client = pve_module.ProxmoxClient(conn)

        async def exploding_version(self):
            raise exc

        monkeypatch.setattr(
            pve_module.ProxmoxClient, "version", exploding_version
        )
        try:
            from app.main import app

            with TestClient(app) as client:
                # Startup completed and the API is serving.
                assert client.get("/api/version").status_code == 200
                assert client.get("/api/health").status_code == 200
        finally:
            pve_module._client = None

    def test_survives_proxy_error_during_probe(
        self, clean_mysql_db, monkeypatch
    ) -> None:
        """Regression: an httpx.ProxyError used to abort app startup."""
        self._boot_with_probe_error(monkeypatch, httpx.ProxyError("502 Bad Gateway"))

    def test_survives_tls_error_during_probe(
        self, clean_mysql_db, monkeypatch
    ) -> None:
        self._boot_with_probe_error(
            monkeypatch, httpx.ConnectError("SSL: CERTIFICATE_VERIFY_FAILED")
        )

    def test_survives_arbitrary_probe_exception(
        self, clean_mysql_db, monkeypatch
    ) -> None:
        """Even a bug in the probe itself must not be fatal."""
        self._boot_with_probe_error(monkeypatch, ValueError("unexpected probe bug"))


class TestClientReloadsOnConfigChange:
    """The resolved client must follow the stored config, not a stale copy.

    The panel persists connection settings in MySQL but caches the resolved
    client in memory. With more than one worker (or two instances sharing a
    database) a change made through one process is invisible to the others
    unless the cache notices the revision change.
    """

    def test_get_client_picks_up_external_config_change(self, monkeypatch) -> None:
        # Process A loads the original config.
        monkeypatch.setattr(
            store, "get_connection_config",
            lambda: {"host": "10.0.0.1", "port": 8006,
                     "token_id": "a@pve!t", "token_secret": "s"},
        )
        pve_module._config_revision = ""
        pve_module._revision_checked_at = 0.0
        pve_module._client = None
        first = pve_module.get_client()
        assert first.conn.host == "10.0.0.1"

        # Process B writes a new config to the shared database …
        monkeypatch.setattr(
            store, "get_connection_config",
            lambda: {"host": "10.0.0.2", "port": 8006,
                     "token_id": "a@pve!t", "token_secret": "s"},
        )
        # … and once the TTL lapses, process A must notice it.
        pve_module._revision_checked_at = 0.0
        second = pve_module.get_client()

        assert second is not first
        assert second.conn.host == "10.0.0.2"

        pve_module._client = None
        pve_module._config_revision = ""
        pve_module._revision_checked_at = 0.0

    def test_unchanged_config_reuses_the_same_client(self, monkeypatch) -> None:
        """The TTL check must not churn clients when nothing changed."""
        monkeypatch.setattr(
            store, "get_connection_config",
            lambda: {"host": "10.0.0.1", "port": 8006,
                     "token_id": "a@pve!t", "token_secret": "s"},
        )
        pve_module._client = None
        pve_module._config_revision = ""
        pve_module._revision_checked_at = 0.0

        first = pve_module.get_client()
        pve_module._revision_checked_at = 0.0  # force a re-read
        assert pve_module.get_client() is first

        pve_module._client = None
        pve_module._config_revision = ""
        pve_module._revision_checked_at = 0.0


# ------------------------------------------- 监控与集成的用户隔离（告警 / 证书）
class TestMonitoringIsolation:
    """监控与集成按用户隔离。

    规则、站点、历史、日志都归属到使用它的用户；密钥类配置（飞书 Webhook、腾讯云
    SecretKey）各存各的。管理员能看见全部，但不能替别人修改。
    """

    PASSWORD = "bob123456"

    def _new_user(self, api: TestClient, username: str) -> Dict[str, str]:
        """建一个普通用户并登录，返回它的请求头。"""
        resp = api.post(
            "/api/users",
            json={"username": username, "password": self.PASSWORD, "role": "operator"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        login = api.post(
            "/api/auth/login", json={"username": username, "password": self.PASSWORD}
        )
        assert login.status_code == 200, login.text
        return {"Authorization": "Bearer " + login.json()["access_token"]}

    @staticmethod
    def _rule(rule_id: str, name: str, **extra: Any) -> Dict[str, Any]:
        # 阈值 10% 低于模拟数据里的 25%，一测就能命中
        rule: Dict[str, Any] = {
            "id": rule_id,
            "name": name,
            "target_type": "vm",
            "target": "*",
            "metric": "cpu",
            "threshold": 10,
            "enabled": True,
        }
        rule.update(extra)
        return rule

    # ---- 告警规则 ----
    def test_alert_rules_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")

        saved = api.put(
            "/api/alerts/rules", json=[self._rule("a1", "管理员规则")], headers=admin
        )
        assert saved.status_code == 200, saved.text
        assert [(r["id"], r["username"]) for r in saved.json()["rules"]] == [("a1", "admin")]

        # 普通用户看不到管理员的规则
        mine = api.get("/api/alerts", headers=bob).json()
        assert mine["rules"] == []
        assert mine["own_username"] == "bob"
        assert mine["is_admin"] is False

        api.put("/api/alerts/rules", json=[self._rule("b1", "bob 规则")], headers=bob)

        # 管理员看得到两条，归属分明
        seen = api.get("/api/alerts", headers=admin).json()
        assert sorted((r["id"], r["username"]) for r in seen["rules"]) == [
            ("a1", "admin"),
            ("b1", "bob"),
        ]
        assert seen["is_admin"] is True
        # 普通用户仍然只看得到自己那条
        bob_rules = api.get("/api/alerts", headers=bob).json()["rules"]
        assert [(r["id"], r["username"]) for r in bob_rules] == [("b1", "bob")]

    def test_saving_rules_keeps_other_users_rules(self, api) -> None:
        """保存只覆盖自己的规则：不会顺手冲掉别人的。"""
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        api.put("/api/alerts/rules", json=[self._rule("b1", "bob 规则")], headers=bob)

        api.put("/api/alerts/rules", json=[self._rule("a1", "管理员规则")], headers=admin)
        rules = api.get("/api/alerts", headers=admin).json()["rules"]
        assert sorted(r["id"] for r in rules) == ["a1", "b1"]

        # 把别人的规则塞进请求体也改不动（一律以库里为准）
        api.put(
            "/api/alerts/rules",
            json=[
                self._rule("a1", "管理员规则"),
                self._rule("b1", "被篡改", username="bob"),
            ],
            headers=admin,
        )
        bobs = [
            r for r in api.get("/api/alerts", headers=admin).json()["rules"] if r["id"] == "b1"
        ]
        assert bobs[0]["name"] == "bob 规则"
        assert bobs[0]["username"] == "bob"

    # ---- 通知通道与历史 ----
    def test_alert_channel_is_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        resp = api.put(
            "/api/alerts/feishu",
            json={
                "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456",
                "enabled": True,
                "cooldown": 300,
            },
            headers=bob,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["webhook_set"] is True
        # 各发各的：管理员那份仍然是未配置
        assert api.get("/api/alerts", headers=bob).json()["webhook_set"] is True
        assert api.get("/api/alerts", headers=admin).json()["webhook_set"] is False

    def test_alert_history_is_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        api.put("/api/alerts/rules", json=[self._rule("b1", "bob 规则")], headers=bob)
        api.put("/api/alerts/rules", json=[self._rule("a1", "管理员规则")], headers=admin)

        # 普通用户手动检测只跑自己的规则
        checked = api.post("/api/alerts/check", headers=bob)
        assert checked.status_code == 200, checked.text
        assert checked.json()["count"] >= 1

        bob_history = api.get("/api/alerts", headers=bob).json()["history"]
        assert bob_history
        assert {r["username"] for r in bob_history} == {"bob"}

        # 管理员检测跑全部规则，两边各自留下自己的历史
        assert api.post("/api/alerts/check", headers=admin).status_code == 200
        admin_history = api.get("/api/alerts", headers=admin).json()["history"]
        assert {r["username"] for r in admin_history} == {"admin", "bob"}
        assert {r["username"] for r in api.get("/api/alerts", headers=bob).json()["history"]} == {
            "bob"
        }

        # 清空历史只清自己的：bob 清完自己的，管理员那份不受影响
        assert api.delete("/api/alerts/history", headers=bob).json()["removed"] >= 1
        assert api.get("/api/alerts", headers=bob).json()["history"] == []
        remaining = api.get("/api/alerts", headers=admin).json()["history"]
        assert remaining
        assert {r["username"] for r in remaining} == {"admin"}

    # ---- 证书站点 / 密钥 / 日志 ----
    @staticmethod
    def _site_payload(name: str, domain: str) -> Dict[str, Any]:
        return {
            "name": name,
            "domain": domain,
            "deploy_method": "local",
            "deploy_dir": "/tmp/certs",
        }

    def test_cert_sites_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")

        created = api.post(
            "/api/certs/sites",
            json=self._site_payload("bob 站点", "bob.example.com"),
            headers=bob,
        )
        assert created.status_code == 200, created.text
        site = created.json()["site"]
        assert site["username"] == "bob"

        # 管理员看得见全部，普通用户只看得到自己的
        admin_sites = api.get("/api/certs", headers=admin).json()["sites"]
        assert [(s["id"], s["username"]) for s in admin_sites] == [(site["id"], "bob")]
        assert api.get("/api/certs", headers=admin).json()["own_username"] == "admin"
        bob_sites = api.get("/api/certs", headers=bob).json()["sites"]
        assert [s["id"] for s in bob_sites] == [site["id"]]

        # 归属不能由请求体指定
        forged = api.post(
            "/api/certs/sites",
            json={**self._site_payload("伪造", "forged.example.com"), "username": "admin"},
            headers=bob,
        )
        assert forged.json()["site"]["username"] == "bob"

        # 管理员不能替别人改 / 删，本人可以
        assert (
            api.put(
                f"/api/certs/sites/{site['id']}",
                json=self._site_payload("改名", "bob.example.com"),
                headers=admin,
            ).status_code
            == 404
        )
        assert api.delete(f"/api/certs/sites/{site['id']}", headers=admin).status_code == 404
        assert (
            api.put(
                f"/api/certs/sites/{site['id']}",
                json=self._site_payload("bob 新名字", "bob.example.com"),
                headers=bob,
            ).status_code
            == 200
        )

    def test_cert_secret_and_logs_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")

        saved = api.put(
            "/api/certs/tencent",
            json={"secret_id": "AKIDbob", "secret_key": "sk-bob"},
            headers=bob,
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["secret_set"] is True

        # 密钥各存各的：管理员那份仍是空
        admin_view = api.get("/api/certs", headers=admin).json()
        assert admin_view["secret_set"] is False
        assert admin_view["tencent"]["secret_id"] == ""
        bob_view = api.get("/api/certs", headers=bob).json()
        assert bob_view["tencent"]["secret_id"] == "AKIDbob"
        assert bob_view["tencent"]["secret_key"] == ""  # 只回传是否已配置

        # 没绑证书就部署：失败日志落在操作者名下，也只有他自己看得到
        site = api.post(
            "/api/certs/sites",
            json=self._site_payload("bob 站点", "bob.example.com"),
            headers=bob,
        ).json()["site"]
        assert api.post(f"/api/certs/sites/{site['id']}/deploy", headers=bob).status_code == 400

        bob_logs = api.get("/api/certs", headers=bob).json()["logs"]
        assert bob_logs and {row["username"] for row in bob_logs} == {"bob"}
        admin_logs = api.get("/api/certs", headers=admin).json()["logs"]
        assert any(row["username"] == "bob" for row in admin_logs)

    # ---- 飞书机器人页面仅管理员 ----
    def test_feishu_bot_config_is_admin_only(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        assert api.get("/api/feishu/config", headers=admin).status_code == 200
        assert api.get("/api/feishu/config", headers=bob).status_code == 403
        assert api.put("/api/feishu/config", json={}, headers=bob).status_code == 403


# ------------------------------------------------- 个人中心（自助改信息 / 改密码）
class TestSelfServiceProfile:
    """普通用户不依赖任何管理权限，就能维护自己的邮箱与密码。

    关键约束：自助接口只认 token 里的身份，请求体里的角色/启用状态等
    提权字段必须被忽略。
    """

    PASSWORD = "bob123456"

    def _operator(self, api: TestClient, username: str = "bob") -> Dict[str, str]:
        resp = api.post(
            "/api/users",
            json={"username": username, "password": self.PASSWORD, "role": "operator"},
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        login = api.post(
            "/api/auth/login", json={"username": username, "password": self.PASSWORD}
        )
        assert login.status_code == 200, login.text
        return {"Authorization": "Bearer " + login.json()["access_token"]}

    # ---- 读取自己的资料与权限 ----
    def test_operator_reads_own_profile_and_permissions(self, api) -> None:
        bob = self._operator(api)

        me = api.get("/api/auth/me", headers=bob)
        assert me.status_code == 200
        assert me.json()["username"] == "bob"
        assert me.json()["role"] == "operator"

        resp = api.get("/api/auth/my-permissions", headers=bob)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["role"] == "operator"
        assert body["is_admin"] is False
        assert "users.manage" not in body["permissions"]

        # 只返回自己拥有的权限，且带上了中文标签
        flat = [item for group in body["groups"] for item in group["permissions"]]
        assert flat, "普通用户也应能看到自己的权限清单"
        assert {item["key"] for item in flat} <= set(body["permissions"])
        assert any(item["label"] == "查看" for item in flat)

        # 管理员的权限目录接口对普通用户仍然关闭
        assert api.get("/api/permissions/catalog", headers=bob).status_code == 403

    # ---- 改邮箱：只能改自己，且不能顺手提权 ----
    def test_update_email_ignores_privilege_fields(self, api) -> None:
        admin = auth_headers(api)
        bob = self._operator(api)

        resp = api.put(
            "/api/auth/me",
            json={"email": "bob@example.com", "role": "admin", "enabled": False},
            headers=bob,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] == "bob@example.com"
        assert resp.json()["role"] == "operator"
        assert resp.json()["enabled"] is True

        stored = api.get("/api/users/bob", headers=admin).json()
        assert stored["email"] == "bob@example.com"
        assert stored["role"] == "operator"
        assert stored["enabled"] is True

    def test_update_email_rejects_bad_format(self, api) -> None:
        bob = self._operator(api)
        resp = api.put("/api/auth/me", json={"email": "not-an-email"}, headers=bob)
        assert resp.status_code == 400
        assert "邮箱" in resp.json()["detail"]

    # ---- 改密码：必须提供当前密码 ----
    def test_change_password_requires_current_password(self, api) -> None:
        bob = self._operator(api)
        resp = api.post(
            "/api/auth/password",
            json={"current_password": "wrong-one", "new_password": "newpass123"},
            headers=bob,
        )
        assert resp.status_code == 400
        assert "当前密码" in resp.json()["detail"]

        # 密码没被改动
        assert (
            api.post(
                "/api/auth/login",
                json={"username": "bob", "password": self.PASSWORD},
            ).status_code
            == 200
        )

    def test_change_password_rejects_weak_and_unchanged(self, api) -> None:
        bob = self._operator(api)

        weak = api.post(
            "/api/auth/password",
            json={"current_password": self.PASSWORD, "new_password": "abcdefgh"},
            headers=bob,
        )
        assert weak.status_code == 400
        assert "数字" in weak.json()["detail"]

        same = api.post(
            "/api/auth/password",
            json={"current_password": self.PASSWORD, "new_password": self.PASSWORD},
            headers=bob,
        )
        assert same.status_code == 400
        assert "不能与当前密码相同" in same.json()["detail"]

    def test_change_password_takes_effect(self, api) -> None:
        bob = self._operator(api)
        new_password = "Unit-Test-NewPa55"

        resp = api.post(
            "/api/auth/password",
            json={"current_password": self.PASSWORD, "new_password": new_password},
            headers=bob,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["ok"] is True

        assert (
            api.post(
                "/api/auth/login",
                json={"username": "bob", "password": new_password},
            ).status_code
            == 200
        )
        assert (
            api.post(
                "/api/auth/login",
                json={"username": "bob", "password": self.PASSWORD},
            ).status_code
            == 401
        )


# ---------------------------------------------- snapshot & backup isolation
class TestSnapshotBackupIsolation:
    """快照与备份按用户隔离：管理员看全部，普通用户只看自己创建的。

    快照走 resource_owner 表（volid 创建时未知、归档走 PVE notes 标记；
    备份计划走 comment 标记），无归属记录的存量资源对普通用户不可见。
    """

    PASSWORD = "bob123456"

    def _new_user(self, api: TestClient, username: str) -> Dict[str, str]:
        resp = api.post(
            "/api/users",
            json={
                "username": username,
                "password": self.PASSWORD,
                "role": "operator",
            },
            headers=auth_headers(api),
        )
        assert resp.status_code == 200, resp.text
        login = api.post(
            "/api/auth/login",
            json={"username": username, "password": self.PASSWORD},
        )
        assert login.status_code == 200, login.text
        return {"Authorization": "Bearer " + login.json()["access_token"]}

    def test_owner_marker_helpers(self) -> None:
        from app.routers.backups import _mark_owner, _owner_of, _strip_owner

        marked = _mark_owner("夜间备份", "alice")
        assert _owner_of(marked) == "alice"
        assert _strip_owner(marked) == "夜间备份"
        assert _owner_of("no marker") is None
        # 已带标记则不重复打标，也不允许换归属
        assert _mark_owner(marked, "bob") == marked

    def test_snapshots_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")

        # 存量虚拟机先指派给 bob，归属守卫才放行他的快照操作
        assigned = api.put(
            "/api/vms/pve1/100/owner", json={"username": "bob"}, headers=admin
        )
        assert assigned.status_code == 200, assigned.text

        created = api.post(
            "/api/vms/pve1/100/snapshot",
            json={"name": "bob-snap", "description": "bob 建的"},
            headers=bob,
        )
        assert created.status_code == 200, created.text
        created = api.post(
            "/api/vms/pve1/100/snapshot", json={"name": "admin-snap"}, headers=admin
        )
        assert created.status_code == 200, created.text

        # bob 只看得到自己的快照（current 指针对所有可见）
        mine = api.get("/api/vms/pve1/100/snapshot", headers=bob).json()
        assert {s["name"] for s in mine} == {"current", "bob-snap"}
        assert next(s for s in mine if s["name"] == "bob-snap")["owner"] == "bob"

        # 管理员看全部，创建者分明
        seen = api.get("/api/vms/pve1/100/snapshot", headers=admin).json()
        owners = {s["name"]: s.get("owner") for s in seen}
        assert owners["bob-snap"] == "bob"
        assert owners["admin-snap"] == "admin"

        # 聚合接口 /api/snapshots 同样隔离
        agg_bob = {
            s["name"]
            for s in api.get("/api/snapshots", headers=bob).json()
            if s.get("vmid") == 100
        }
        assert agg_bob == {"bob-snap"}
        agg_admin = {
            s["name"]
            for s in api.get("/api/snapshots", headers=admin).json()
            if s.get("vmid") == 100
        }
        assert agg_admin == {"bob-snap", "admin-snap"}

        # bob 不能回滚 / 删除别人的快照；自己的可以删
        assert (
            api.post(
                "/api/vms/pve1/100/snapshot/admin-snap/rollback", headers=bob
            ).status_code
            == 403
        )
        assert (
            api.delete(
                "/api/vms/pve1/100/snapshot/admin-snap", headers=bob
            ).status_code
            == 403
        )
        assert (
            api.delete(
                "/api/vms/pve1/100/snapshot/bob-snap", headers=bob
            ).status_code
            == 200
        )

    def test_legacy_snapshot_backup_visible_to_vm_owner(self, api) -> None:
        """存量（无创建者标记）的快照/备份按虚拟机归属回落可见，标记仍优先。

        复现旧版本代码创建的资源：PVE 上有快照、notes 里没有 ``[owner:]``
        标记，``resource_owner`` 只登记了虚拟机的归属（而非快照/备份创建者）。
        修复前这类条目对普通用户永远不可见。
        """
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        # 机器归 bob（9000 只写归属表，对应 legacy 归档文件名里的 vmid）
        for vmid in (100, 9000):
            resp = api.put(
                f"/api/vms/pve1/{vmid}/owner",
                json={"username": "bob"},
                headers=admin,
            )
            assert resp.status_code == 200, resp.text

        # 注入一条“旧代码创建”的快照：mock PVE 上有，归属表里没有记录
        SNAPSHOT_STORE.setdefault(("pve1", "100"), []).append(
            {
                "name": "legacy-snap",
                "description": "",
                "snaptime": 1750000000,
                "parent": "",
                "vmstate": 0,
            }
        )

        # 快照：bob 自己机器上的存量快照可见（修复前列表为空）
        resp = api.get("/api/vms/pve1/100/snapshot", headers=bob)
        assert resp.status_code == 200
        seen = {s["name"]: s.get("owner") for s in resp.json()}
        assert "legacy-snap" in seen
        assert seen["legacy-snap"] == "bob"
        # 集群聚合视图同样可见
        resp = api.get("/api/snapshots", headers=bob)
        agg = [
            s
            for s in resp.json()
            if s.get("vmid") == 100 and s.get("name") == "legacy-snap"
        ]
        assert len(agg) == 1
        # bob 能操作（删除）自己机器上的存量快照
        resp = api.delete("/api/vms/pve1/100/snapshot/legacy-snap", headers=bob)
        assert resp.status_code == 200

        # 备份：notes 无标记的 legacy 归档（vmid 9000 归 bob）对 bob 可见
        resp = api.get(
            "/api/backups",
            params={"node": "pve1"},
            headers=bob,
        )
        assert resp.status_code == 200
        legacy_volid = "local:vzdump-qemu-9000-2026_09_10-02_00_00.vma.zst"
        admin_volid = "local:vzdump-qemu-100-2026_09_20-02_00_00.vma.zst"
        archives = {b["volid"]: b for b in resp.json()}
        assert legacy_volid in archives
        assert archives[legacy_volid]["owner"] == "bob"
        # 创建者标记优先：admin 创建的归档即便机器归 bob 也不可见、动不了
        assert admin_volid not in archives
        resp = api.delete(
            "/api/backups",
            params={"node": "pve1", "storage": "local", "volid": admin_volid},
            headers=bob,
        )
        assert resp.status_code == 403
        # 存量归档（机器归属确认）放行：归属校验在 403 处拦截，
        # 走到 PVE 调用即为通过（mock 未实现该 DELETE，返回 501 属预期）
        resp = api.delete(
            "/api/backups",
            params={"node": "pve1", "storage": "local", "volid": legacy_volid},
            headers=bob,
        )
        assert resp.status_code != 403, resp.text

    def test_backup_archives_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")
        admin_volid = "local:vzdump-qemu-100-2026_09_20-02_00_00.vma.zst"
        legacy_volid = "local:vzdump-qemu-9000-2026_09_10-02_00_00.vma.zst"
        bob_volid = "local:vzdump-qemu-101-2026_09_21-03_00_00.vma.zst"

        seen = {
            b["volid"]: b
            for b in api.get("/api/backups", params={"node": "pve1"}, headers=admin).json()
        }
        assert seen[admin_volid]["owner"] == "admin"
        # 存量无标记的备份：管理员可见
        assert legacy_volid in seen

        # bob 只看得到自己创建的；标记不外泄到展示字段
        mine = api.get("/api/backups", params={"node": "pve1"}, headers=bob).json()
        assert [b["volid"] for b in mine] == [bob_volid]
        assert mine[0]["owner"] == "bob"
        assert "[owner:" not in (mine[0].get("notes") or "")

        # 集群级列表（页面默认，不带 node/storage 筛选）也必须返回备份：
        # /storage 是集群配置、没有 node 字段，早前版本在这里恒返回空
        seen_all = {b["volid"] for b in api.get("/api/backups", headers=admin).json()}
        assert {admin_volid, legacy_volid, bob_volid} <= seen_all
        mine_all = api.get("/api/backups", headers=bob).json()
        assert [b["volid"] for b in mine_all] == [bob_volid]

        # bob 不能恢复 / 删除管理员的归档（严格隔离：存量无标记的同样不可见）
        resp = api.post(
            "/api/backups/restore",
            json={"node": "pve1", "volid": admin_volid, "vmid": 100},
            headers=bob,
        )
        assert resp.status_code == 403
        resp = api.delete(
            "/api/backups",
            params={"node": "pve1", "storage": "local", "volid": admin_volid},
            headers=bob,
        )
        assert resp.status_code == 403
        resp = api.delete(
            "/api/backups",
            params={"node": "pve1", "storage": "local", "volid": legacy_volid},
            headers=bob,
        )
        assert resp.status_code == 403

    def test_backup_jobs_are_per_user(self, api) -> None:
        admin = auth_headers(api)
        bob = self._new_user(api, "bob")

        created = api.post(
            "/api/backups/jobs",
            json={"schedule": "03:00", "storage": "local", "vmid": "100"},
            headers=bob,
        )
        assert created.status_code == 200, created.text
        bob_job = created.json()["job_id"]
        created = api.post(
            "/api/backups/jobs",
            json={"schedule": "04:00", "storage": "local", "vmid": "9000"},
            headers=admin,
        )
        assert created.status_code == 200, created.text
        admin_job = created.json()["job_id"]

        mine = api.get("/api/backups/jobs", headers=bob).json()
        assert [j["id"] for j in mine] == [bob_job]
        assert mine[0]["owner"] == "bob"
        seen = api.get("/api/backups/jobs", headers=admin).json()
        assert {j["id"] for j in seen} == {bob_job, admin_job}

        # bob 改不了、删不了管理员的计划
        resp = api.put(
            f"/api/backups/jobs/{admin_job}",
            json={"schedule": "05:00", "storage": "local"},
            headers=bob,
        )
        assert resp.status_code == 403
        assert (
            api.delete(f"/api/backups/jobs/{admin_job}", headers=bob).status_code
            == 403
        )

        # 自己的可以改；改完归属仍在自己名下
        resp = api.put(
            f"/api/backups/jobs/{bob_job}",
            json={"schedule": "06:00", "storage": "local"},
            headers=bob,
        )
        assert resp.status_code == 200, resp.text
        mine = api.get("/api/backups/jobs", headers=bob).json()
        assert [j["owner"] for j in mine] == ["bob"]
        assert mine[0]["schedule"] == "06:00"


# --------------------------------------------------------------- alert rules
def _write_alert_rules_sync(rules) -> None:
    """直接写 settings，模拟升级前遗留的规则（没有 username 归属）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM settings WHERE `key` = 'alert_rules'")
            cursor.execute(
                "INSERT INTO settings (`key`, `value`) VALUES ('alert_rules', %s)",
                (json.dumps(rules, ensure_ascii=False),),
            )
    finally:
        conn.close()


def _read_alert_rules_sync():
    """同步读回库里的规则，验证落盘结果。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT `value` FROM settings WHERE `key` = 'alert_rules'")
            row = cursor.fetchone()
            return json.loads(row[0]) if row and row[0] else []
    finally:
        conn.close()


class TestAlertRuleSaving:
    """保存规则必须「替换 + 去重」：不能反复复制，也不能把停用改回启用。"""

    @staticmethod
    def _rule(rid: str, **overrides: Any) -> Dict[str, Any]:
        rule: Dict[str, Any] = {
            "id": rid,
            "name": "CPU 超阈值",
            "target_type": "node",
            "target": "*",
            "metric": "cpu",
            "threshold": 60,
            "enabled": True,
        }
        rule.update(overrides)
        return rule

    def test_legacy_rules_are_claimed_without_duplicating(self, api) -> None:
        """升级前的无主规则被认领后只留一份（此前每保存一次就多出一批）。"""
        headers = auth_headers(api)
        legacy = [self._rule("legacy-1"), self._rule("legacy-2")]
        _write_alert_rules_sync(legacy)

        first = api.put("/api/alerts/rules", json=legacy, headers=headers)
        assert first.status_code == 200, first.text
        rules = first.json()["rules"]
        assert len(rules) == 2
        assert all(r["username"] == "admin" for r in rules)

        # 再点一次「保存规则」：数量不能增长
        second = api.put("/api/alerts/rules", json=rules, headers=headers)
        assert len(second.json()["rules"]) == 2
        assert len(_read_alert_rules_sync()) == 2

    def test_disabled_rule_stays_disabled(self, api) -> None:
        """停用状态必须落库并保持，不能被默认值重新启用。"""
        headers = auth_headers(api)
        saved = api.put(
            "/api/alerts/rules",
            json=[self._rule("r1", enabled=False), self._rule("r2")],
            headers=headers,
        )
        assert saved.status_code == 200, saved.text
        stored = _read_alert_rules_sync()
        assert [r["enabled"] for r in stored] == [False, True]

        # 回读后原样再存一次，停用状态保持
        again = api.put("/api/alerts/rules", json=stored, headers=headers)
        assert [r["enabled"] for r in again.json()["rules"]] == [False, True]

    def test_stored_duplicates_are_collapsed(self, api) -> None:
        """历史脏数据里同 id 的两份（无主 + 有主）保存后合并成一条。"""
        headers = auth_headers(api)
        _write_alert_rules_sync(
            [
                self._rule("dup"),
                self._rule("dup", username="admin"),
            ]
        )
        resp = api.put(
            "/api/alerts/rules", json=[self._rule("dup")], headers=headers
        )
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["rules"]) == 1
        assert len(_read_alert_rules_sync()) == 1
