"""审计日志的用户隔离。

被修的问题：``/api/audit`` 只校验 ``audit.view``，拿到这个权限的任何人都能翻
全表，还能用 ``?username=`` 看别人的操作；导出接口同样如此 —— 把一个读权限
按人开放出去，等于把「谁在什么时候动了哪台机器」交给了他。

现在可见范围在服务端收口（:func:`app.security.scoped_username`）：

* 管理员（``role == 'admin'``）看全部，也可以按用户名筛；
* 其他用户只能看自己，显式索取别人的记录直接 403；
* ``/api/audit/actions`` 与 ``/api/export/audit`` 与列表同一口径。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import (  # noqa: E402,F401
    api,
    auth_headers,
    user_with_permissions,
)

TS = 1_700_000_000.0


def _insert_audit(
    *,
    ts: float = TS,
    username: str = "admin",
    action: str = "vm.start",
    target: str = "pve1/100",
    result: str = "success",
    detail: str = "",
    ip: str = "10.0.0.1",
) -> None:
    """同步 pymysql 直插历史行（与 test_export 同一套路，避免跨事件循环）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO audit_log"
                " (timestamp, username, action, target, result, detail, ip)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (ts, username, action, target, result, detail, ip),
            )
    finally:
        conn.close()


class TestAuditScope:
    def test_admin_sees_everyone(self, api) -> None:
        _insert_audit(username="alice", action="vm.start")
        _insert_audit(username="bob", action="vm.stop")
        headers = auth_headers(api)

        body = api.get("/api/audit", headers=headers).json()

        assert body["scope"] == "all"
        assert {"alice", "bob"} <= {item["username"] for item in body["items"]}

    def test_non_admin_only_sees_own_records(self, api) -> None:
        _insert_audit(username="alice", action="vm.start")
        _insert_audit(username="bob", action="vm.stop")
        headers = user_with_permissions(api, ["audit.view"], "alice")

        body = api.get("/api/audit", headers=headers).json()

        assert body["scope"] == "own"
        assert body["items"], body
        # 全是自己的；别人的动作一条都不该出现
        assert {item["username"] for item in body["items"]} == {"alice"}
        actions = {item["action"] for item in body["items"]}
        assert "vm.start" in actions
        assert "vm.stop" not in actions

    def test_non_admin_cannot_ask_for_someone_else(self, api) -> None:
        _insert_audit(username="bob", action="vm.stop")
        headers = user_with_permissions(api, ["audit.view"], "alice")

        resp = api.get("/api/audit?username=bob", headers=headers)

        assert resp.status_code == 403, resp.text
        assert "自己" in resp.json()["detail"]

    def test_own_username_filter_still_works(self, api) -> None:
        _insert_audit(username="alice", action="vm.start")
        _insert_audit(username="bob", action="vm.stop")
        headers = user_with_permissions(api, ["audit.view"], "alice")

        resp = api.get("/api/audit?username=alice", headers=headers)

        assert resp.status_code == 200, resp.text
        assert {item["username"] for item in resp.json()["items"]} == {"alice"}

    def test_actions_endpoint_is_scoped(self, api) -> None:
        _insert_audit(username="alice", action="vm.start")
        _insert_audit(username="bob", action="vm.stop")
        headers = user_with_permissions(api, ["audit.view"], "alice")

        body = api.get("/api/audit/actions", headers=headers).json()

        assert body["users"] == ["alice"]
        assert "vm.start" in body["actions"]
        assert "vm.stop" not in body["actions"]

    def test_export_is_scoped_and_cannot_be_bypassed(self, api) -> None:
        _insert_audit(username="alice", action="vm.start")
        _insert_audit(username="bob", action="vm.stop")
        headers = user_with_permissions(api, ["audit.view"], "alice")

        resp = api.get("/api/export/audit", headers=headers)

        assert resp.status_code == 200, resp.text
        assert "alice,vm.start,pve1/100,success" in resp.text
        assert "vm.stop" not in resp.text
        assert ",bob," not in resp.text

        # 明确索取别人的记录：403，不能靠导出绕过
        denied = api.get("/api/export/audit?username=bob", headers=headers)
        assert denied.status_code == 403
