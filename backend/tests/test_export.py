"""数据导出：CSV 编码安全、筛选条件透传、归属隔离与「导出本身入审计」。

编码部分（BOM / 引号 / 公式注入）是纯函数，喂字符串断言即可；
接口部分走 ``api`` fixture，历史行用同步 pymysql 直插 —— 与 test_metrics
同一套路，避免跨事件循环碰 aiomysql 的连接池。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import exporting  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

TS = 1_700_000_040.0


# ------------------------------------------------------------------ 直插工具
def _exec(sql: str, params: Optional[tuple] = None) -> List[Any]:
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return cursor.fetchall()
    finally:
        conn.close()


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
    _exec(
        "INSERT INTO audit_log (timestamp, username, action, target, result, detail, ip)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (ts, username, action, target, result, detail, ip),
    )


def _insert_alert(
    *,
    ts: int = int(TS),
    username: str = "",
    rule_name: str = "CPU 过高",
    metric: str = "cpu",
    target: str = "pve1",
    kind: str = "alarm",
) -> None:
    _exec(
        "INSERT INTO alert_history"
        " (username, rule_id, rule_name, target_type, target, metric, value, threshold,"
        "  result, detail, kind, ts)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            username,
            "r1",
            rule_name,
            "node",
            target,
            metric,
            91.5,
            90.0,
            "fired",
            "CPU 91.5% 超过阈值 90%",
            kind,
            ts,
        ),
    )


def _audit_actions() -> List[str]:
    return [row[0] for row in _exec("SELECT action FROM audit_log")]


# -------------------------------------------------------------------- 编码
class TestCsvEncoding:
    def test_bom_is_prepended_to_every_export(self) -> None:
        """没有 BOM，Excel 会把中文按 GBK 解，整表乱码。"""
        assert exporting.BOM == "\ufeff"

    def test_formula_prefixes_are_neutralised(self) -> None:
        """用户可填的名称/标签会被 Excel 当公式执行，必须转成纯文本。"""
        for payload in ("=1+1", "+1", "-1", "@SUM(A1)", "\tx"):
            assert exporting.safe_cell(payload).startswith("'"), payload

    def test_plain_text_is_untouched(self) -> None:
        assert exporting.safe_cell("web-01") == "web-01"
        assert exporting.safe_cell(42) == "42"
        assert exporting.safe_cell(None) == ""

    def test_newlines_are_flattened(self) -> None:
        """换行会把 Excel 里的一行拆成两行。"""
        assert exporting.safe_cell("第一行\n第二行") == "第一行 第二行"
        assert exporting.safe_cell("a\r\nb") == "a b"

    def test_fields_are_quoted_and_escaped(self) -> None:
        assert exporting.encode_row(["a,b", 'say "hi"', "plain"]) == (
            '"a,b","say ""hi""",plain\r\n'
        )

    def test_disposition_uses_explicit_ascii_fallback(self) -> None:
        value = exporting.content_disposition("审计日志.csv", "audit-log.csv")
        assert 'filename="audit-log.csv"' in value
        assert "filename*=UTF-8''%E5%AE%A1%E8%AE%A1%E6%97%A5%E5%BF%97.csv" in value


# -------------------------------------------------------------------- 接口
class TestExportApi:
    def test_requires_auth(self, api) -> None:
        for path in ("audit", "tasks", "vms", "alerts"):
            assert api.get(f"/api/export/{path}").status_code == 401

    def test_audit_export_streams_csv_with_bom_and_header(self, api) -> None:
        headers = auth_headers(api)
        _insert_audit(action="vm.start", username="alice")

        resp = api.get("/api/export/audit", headers=headers)

        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/csv")
        assert 'filename="audit-log-' in resp.headers["content-disposition"]
        assert resp.headers["cache-control"] == "no-store"

        text = resp.text
        assert text.startswith("\ufeff")  # BOM
        first_line = text.lstrip("\ufeff").split("\r\n")[0]
        assert first_line.endswith("用户,动作,目标,结果,来源 IP,详情")
        assert "alice,vm.start,pve1/100,success" in text

    def test_audit_export_honours_result_filter(self, api) -> None:
        headers = auth_headers(api)
        _insert_audit(action="vm.start", result="success")
        _insert_audit(action="vm.delete", result="failed")

        resp = api.get("/api/export/audit?result=failed", headers=headers)

        assert resp.status_code == 200, resp.text
        assert "vm.delete" in resp.text
        assert "vm.start" not in resp.text

    def test_audit_export_honours_time_window(self, api) -> None:
        """「最近 N 小时」这个筛选项以前对列表接口是空转的，导出必须真的生效。"""
        headers = auth_headers(api)
        _insert_audit(ts=TS, action="old.event")
        _insert_audit(ts=TS + 3600, action="new.event")

        resp = api.get(
            f"/api/export/audit?start={TS + 1800}&end={TS + 7200}", headers=headers
        )

        assert "new.event" in resp.text
        assert "old.event" not in resp.text

    def test_audit_export_honours_search(self, api) -> None:
        headers = auth_headers(api)
        _insert_audit(action="vm.start", detail="重置了 web 服务器")
        _insert_audit(action="vm.stop", detail="与关键词无关")

        resp = api.get("/api/export/audit?search=web", headers=headers)

        assert "vm.start" in resp.text
        assert "vm.stop" not in resp.text

    def test_export_is_itself_audited(self, api) -> None:
        """导出等于把一批敏感数据带走，必须留痕。"""
        headers = auth_headers(api)
        _insert_audit(action="vm.start")

        assert api.get("/api/export/audit", headers=headers).status_code == 200

        actions = _audit_actions()
        assert "audit.export" in actions

    def test_audit_list_accepts_the_ui_result_values(self, api) -> None:
        """界面筛选项发的是 failed/denied，后端以前只放行 failed/partial，
        一选「失败」就 422 —— 这里锁住这个契约。"""
        headers = auth_headers(api)
        for value in ("success", "failed", "denied", "partial", "accepted"):
            resp = api.get(f"/api/audit?result={value}", headers=headers)
            assert resp.status_code == 200, (value, resp.text)

    def test_tasks_export_returns_csv(self, api) -> None:
        resp = api.get("/api/export/tasks", headers=auth_headers(api))

        assert resp.status_code == 200, resp.text
        assert resp.text.startswith("\ufeff")
        assert "任务类型" in resp.text
        assert "UPID" in resp.text

    def test_alerts_export_is_scoped_to_owner(self, api) -> None:
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users",
                json={
                    "username": "aops1",
                    "password": "Unit-Test-Pa55word",
                    "role": "operator",
                },
                headers=admin,
            ).status_code
            == 200
        )
        operator = api.post(
            "/api/auth/login",
            json={"username": "aops1", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        ops_headers = {"Authorization": f"Bearer {operator}"}

        _insert_alert(username="aops1", rule_name="我的规则")
        _insert_alert(username="someoneelse", rule_name="别人的规则")

        mine = api.get("/api/export/alerts", headers=ops_headers)
        assert mine.status_code == 200, mine.text
        assert "我的规则" in mine.text
        assert "别人的规则" not in mine.text

        everything = api.get("/api/export/alerts", headers=admin)
        assert "别人的规则" in everything.text

    def test_vms_export_isolates_other_users(self, api) -> None:
        """导出走的是列表那套归属过滤：列表里看不到的机器，导出里也不能出现。"""
        admin = auth_headers(api)
        assert (
            api.post(
                "/api/users",
                json={
                    "username": "vops1",
                    "password": "Unit-Test-Pa55word",
                    "role": "operator",
                },
                headers=admin,
            ).status_code
            == 200
        )
        operator = api.post(
            "/api/auth/login",
            json={"username": "vops1", "password": "Unit-Test-Pa55word"},
        ).json()["access_token"]
        ops_headers = {"Authorization": f"Bearer {operator}"}

        # mock 里的 pve1/100 指派给 vops1，其余机器对他不可见（严格隔离）
        assert (
            api.put(
                "/api/vms/pve1/100/owner",
                json={"username": "vops1"},
                headers=admin,
            ).status_code
            == 200
        )

        mine = api.get("/api/export/vms?type=all", headers=ops_headers)
        assert mine.status_code == 200, mine.text
        assert "归属人" in mine.text
        # 表头之外只剩自己那一行
        data_rows = [
            line
            for line in mine.text.lstrip("\ufeff").split("\r\n")
            if line and not line.startswith("连接,")
        ]
        assert len(data_rows) == 1
        assert ",100," in data_rows[0]

        everything = api.get("/api/export/vms?type=all", headers=admin)
        assert len(
            [
                line
                for line in everything.text.lstrip("\ufeff").split("\r\n")
                if line and not line.startswith("连接,")
            ]
        ) > 1

    def test_vms_export_rejects_unknown_type(self, api) -> None:
        resp = api.get("/api/export/vms?type=storage", headers=auth_headers(api))
        assert resp.status_code == 422
