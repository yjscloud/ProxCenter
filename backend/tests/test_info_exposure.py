"""认证后的信息过度暴露（V2-04）。

单条看都不算严重，合起来却是一套「从普通账号到控制整个集群」的测绘材料：

* ``/api/frp/status`` 把 frpc 的**安装路径**与 frps 地址一起交给任何 frp.view
  用户 —— 前者说明面板装在哪、目录怎么摆，后者说明穿透到了哪台机器；
* ``/api/ai/capabilities`` 把**命令白名单 / 参数黑名单 / 路径白名单**整套下发，
  等于给探测者一份「哪条边最好绕」的清单；
* ``/api/users/roles`` 对只要求登录，于是任何账号都能拿到完整的权限矩阵，
  一眼看清这个面板有哪些能力位、哪些角色握着它们；
* ``/api/ai/playbooks`` 把发给模型的**排查指令原文**发给浏览器，助手的检查
  顺序与要读的路径 / 命令全在明面上。

这里的用例逐条钉住「该给的给、不该给的不给」，并顺带验证权限过滤与执行侧
是同一份门槛（说明里看不到的工具，真跑也跑不起来）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ai, aiplaybooks, aitools  # noqa: E402
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: E402,F401

SERVER = {"server_addr": "frp.example.com", "server_port": 7000}


# ------------------------------------------------------------------ frp 状态
class TestFrpExposure:
    def test_status_never_reveals_the_binary(self, api) -> None:
        admin = auth_headers(api)
        body = api.get("/api/frp/status", headers=admin).json()
        assert "binary" not in body
        assert body["available"] in (True, False)
        # 管理员仍然拿得到服务端信息（排障要用）
        assert "server_addr" in body

    def test_status_hides_server_from_ordinary_users(self, api) -> None:
        admin = auth_headers(api)
        assert api.put("/api/frp/server", headers=admin, json=SERVER).status_code == 200

        user = user_with_permissions(api, ["frp.view"], "frp-viewer")
        body = api.get("/api/frp/status", headers=user).json()
        assert "binary" not in body
        assert "server_addr" not in body
        assert "server_port" not in body
        # 用户要的信息还在：在不在跑、客户端装没装、自己有几条规则
        assert body["running"] is False
        assert body["available"] in (True, False)
        assert body["proxy_count"] == 0

    def test_server_endpoint_hides_address_from_ordinary_users(self, api) -> None:
        admin = auth_headers(api)
        assert api.put("/api/frp/server", headers=admin, json=SERVER).status_code == 200
        assert api.get("/api/frp/server", headers=admin).json()["server_addr"] == (
            "frp.example.com"
        )

        user = user_with_permissions(api, ["frp.view"], "frp-viewer2")
        body = api.get("/api/frp/server", headers=user).json()
        assert body["server_addr"] == ""
        assert body["server_port"] == 7000
        assert body["token_set"] is False

    def test_effective_view_blurs_the_address_too(self, api) -> None:
        admin = auth_headers(api)
        assert api.put("/api/frp/server", headers=admin, json=SERVER).status_code == 200

        user = user_with_permissions(api, ["frp.view"], "frp-viewer3")
        body = api.get("/api/frp/effective", headers=user).json()
        assert body["config"]["server_addr"] == ""
        assert body["config"]["token"] == ""


# ------------------------------------------------------------- AI 能力说明
class TestAiCapabilities:
    def test_policy_is_not_sent_and_tools_follow_permissions(self, api) -> None:
        # 只有 baseline.view：能排查，但没有上机执行权、也读不了 SSH 登录分析
        user = user_with_permissions(api, ["baseline.view"], "ai-viewer")
        body = api.get("/api/ai/capabilities", headers=user).json()

        assert "policy" not in body
        names = {item["name"] for item in body["tools"]}
        assert "host_disk_usage" in names  # 只读诊断命令不受额外限制
        assert "host_run_command" not in names
        assert "host_propose_command" not in names
        assert "get_ssh_failures" not in names
        assert body["max_steps"] > 0

    def test_ai_exec_unlocks_write_tools_but_not_ssh(self, api) -> None:
        user = user_with_permissions(
            api, ["baseline.view", "ai.exec"], "ai-exec"
        )
        names = {
            item["name"]
            for item in api.get("/api/ai/capabilities", headers=user).json()["tools"]
        }
        assert "host_run_command" in names
        assert "host_propose_command" in names
        assert "get_ssh_failures" not in names

    def test_admin_sees_every_tool_but_still_no_policy(self, api) -> None:
        body = api.get("/api/ai/capabilities", headers=auth_headers(api)).json()
        names = {item["name"] for item in body["tools"]}
        assert {"host_run_command", "host_propose_command", "get_ssh_failures"} <= names
        assert "policy" not in body

    def test_execution_uses_the_same_gate(self) -> None:
        """说明里看不到的工具，模型点名也跑不起来（不只是藏文档）。"""
        out = asyncio.run(
            ai._dispatch_tool(
                "host_run_command",
                {"command": "id"},
                host_id="local",
                row=None,
                local=True,
                perms={"baseline.view"},
            )
        )
        assert out["ok"] is False
        assert "权限" in out["output"]

    def test_permission_helper_semantics(self) -> None:
        # 没有门槛的工具：谁都能用
        assert aitools.allowed_by_permissions(None, "host_disk_usage") is True
        # 有门槛 + 调用方没声明权限 → 最小权限
        assert aitools.allowed_by_permissions(None, "host_run_command") is False
        # "*" 是内置超管的全部权限
        assert aitools.allowed_by_permissions({"*"}, "host_run_command") is True
        assert aitools.allowed_by_permissions({"ai.exec"}, "host_run_command") is True
        assert aitools.allowed_by_permissions({"ssh.view"}, "host_run_command") is False


# ------------------------------------------------------------------ AI 预案
class TestAiPlaybooks:
    def test_api_sends_no_prompt(self, api) -> None:
        items = api.get("/api/ai/playbooks", headers=auth_headers(api)).json()["items"]
        assert items
        for item in items:
            assert "prompt" not in item
            assert item["key"] and item["title"]

    def test_prompt_still_exists_on_the_server(self) -> None:
        """前端拿不到 prompt，但后端按 key 仍然拼得出完整指令。"""
        full = aiplaybooks.get_playbook("disk")
        assert full is not None
        assert full["prompt"]
        assert "prompt" not in aiplaybooks.list_playbooks()[0]


# ------------------------------------------------------------------ 角色目录
class TestRoleCatalog:
    def test_permission_matrix_is_management_only(self, api) -> None:
        admin = auth_headers(api)
        roles = api.get("/api/users/roles", headers=admin).json()
        assert roles and all("permissions" in item for item in roles)

        user = user_with_permissions(api, ["vm.view"], "role-viewer")
        roles = api.get("/api/users/roles", headers=user).json()
        assert roles
        for item in roles:
            # 名字与说明还在（下拉 / 展示要用），权限矩阵不在
            assert item["name"]
            assert "permissions" not in item
