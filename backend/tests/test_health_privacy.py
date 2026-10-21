"""FD-04：/api/health 不得向匿名用户泄露内网拓扑与版本。

此前匿名就能读到 PVE 版本、节点数与连接状态。现在的口径：

* 匿名：只有 ``{"status": "ok"}``，且**不探测 PVE**；
* 已登录：字段与以前一致（前端登录后各处仍靠它轮询 PVE 状态）。

用例不连数据库：匿名分支在鉴权层就返回 None，登录分支把 ``get_client``
换成一个「未配置」的假客户端。
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi.testclient import TestClient

from app import main
from app.routers import config


def test_anonymous_health_only_reports_status(monkeypatch: Any) -> None:
    """HTTP 层：匿名请求只拿到 status，顺带确认没有去问 PVE。"""

    def _boom() -> Any:  # pragma: no cover - 被调用即失败
        raise AssertionError("匿名健康检查不该向 PVE 发请求")

    monkeypatch.setattr(config, "get_client", _boom)

    client = TestClient(main.app)
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_authenticated_health_keeps_diagnostics(monkeypatch: Any) -> None:
    """登录后仍是原来的完整读数（这里用「未配置连接」这一支，不必真连 PVE）。"""

    class _Conn:
        configured = False

    class _Client:
        conn = _Conn()

    monkeypatch.setattr(config, "get_client", lambda: _Client())

    result = asyncio.run(config.health(user={"username": "admin"}))

    assert result["status"] == "ok"
    assert result["pve_configured"] is False
    assert "pve_version" in result
    assert "node_count" in result
    assert "version" in result
