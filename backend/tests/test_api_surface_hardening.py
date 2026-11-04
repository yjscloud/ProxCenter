"""接口表面收敛：限流、404/401 语义、内部计数头与静态软 404。

对应 BUG-002 / BUG-003 / BUG-004 / BUG-005 / BUG-006：

* 验证码签发按 IP 限流（匿名 CPU 放大入口）；
* 未登录枚举 API 时，存在与不存在的路径都回 401；
* 已登录访问不存在的路径回**通用** 404，不泄露路径 / 版本 / 运维动作；
* ``X-PVE-Calls`` / ``X-DB-Queries`` 只在 DEBUG 下出现；
* ``/robots.txt`` 这类静态后缀不被 SPA 兜底成 200 首页。
"""
from __future__ import annotations

from test_api_routes import (  # noqa: E402,F401  fixture 复用
    api,
    auth_headers,
    user_with_permissions,
)

from app.config import settings  # noqa: E402


# --------------------------------------------------------------- BUG-002 限流
def test_captcha_is_rate_limited_per_ip(api) -> None:
    statuses = [api.get("/api/auth/captcha").status_code for _ in range(8)]

    # 默认 6 次/分钟：前 6 次正常，第 7、8 次必须被拒。
    assert statuses[:6] == [200] * 6
    assert statuses[6:] == [429, 429]
    limited = api.get("/api/auth/captcha")
    assert limited.status_code == 429
    assert limited.headers.get("Retry-After")


# ----------------------------------------------------- BUG-003 / BUG-005 404
def test_unknown_api_path_requires_login(api) -> None:
    """未登录时「存在的接口」与「不存在的接口」都回 401，无法据此枚举路由。"""
    assert api.get("/api/vms").status_code == 401
    assert api.get("/api/definitely-not-a-real-endpoint").status_code == 401


def test_unknown_api_path_is_generic_404_when_logged_in(api) -> None:
    headers = auth_headers(api)
    response = api.get("/api/definitely-not-a-real-endpoint", headers=headers)

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "not_found"
    # 不回显路径，也不提「旧版本 / 重启」这类运维动作
    assert "definitely-not-a-real-endpoint" not in response.text
    assert "旧版本" not in response.text
    assert "重启" not in response.text
    assert "older build" not in response.text


# --------------------------------------------------------- BUG-004 内部头
def test_internal_metrics_headers_hidden_by_default(api, monkeypatch) -> None:
    monkeypatch.setattr(settings, "debug", False)
    response = api.get("/api/health")
    assert "x-pve-calls" not in response.headers
    assert "x-db-queries" not in response.headers


def test_internal_metrics_headers_visible_in_debug(api, monkeypatch) -> None:
    monkeypatch.setattr(settings, "debug", True)
    response = api.get("/api/health")
    assert response.headers["x-pve-calls"] == "0"
    assert response.headers["x-db-queries"] == "0"


# ------------------------------------------------------------- BUG-006 软 404
def test_static_like_paths_are_not_spa_fallbacks(api) -> None:
    for path in (
        "/robots.txt",
        "/favicon.ico",
        "/.well-known/security.txt",
        "/.env",
    ):
        response = api.get(path)
        assert response.status_code == 404, path
        # 不能把首页 HTML 伪装成这些资源
        assert "text/html" not in response.headers.get("content-type", ""), path


# ------------------------------------------------------- BUG-008 CSP 来源
def test_csp_does_not_allow_arbitrary_websocket_hosts(api) -> None:
    csp = api.get("/api/health").headers["content-security-policy"]
    connect = next(part for part in csp.split(";") if part.strip().startswith("connect-src"))
    assert connect.strip() == "connect-src 'self'"
    assert "ws:" not in csp
    assert "wss:" not in csp


# --------------------------------------------------- BUG-009 422 不回显输入
def test_validation_error_does_not_echo_the_body(api) -> None:
    secret = "super-secret-body-value"
    response = api.post(
        "/api/auth/login",
        json={"username": "admin", "password": [secret]},
    )
    assert response.status_code == 422
    assert secret not in response.text
    assert "input" not in response.json()["detail"][0]
    assert "ctx" not in response.json()["detail"][0]


# ------------------------------------------------- BUG-010 405 + Allow
def test_wrong_method_returns_405_with_allow(api) -> None:
    response = api.post("/api/health")
    assert response.status_code == 405
    allow = response.headers.get("allow", "")
    assert "GET" in allow
    assert response.json()["code"] == "method_not_allowed"


# ------------------------------------------------- BUG-017 节点口径一致
def test_creator_without_node_view_gets_desensitised_nodes(api) -> None:
    creator = user_with_permissions(api, ["vm.create"], "node-creator")
    response = api.get("/api/nodes", headers=creator)
    assert response.status_code == 200
    nodes = response.json()
    assert nodes and nodes[0]["node"] == "pve1"
    # 选宿主机够用的字段还在
    assert nodes[0]["status"] == "online"
    # 监控读数不下发；详情接口仍是 403，两处口径一致
    for key in ("cpu", "maxcpu", "mem", "maxmem", "disk", "maxdisk", "uptime"):
        assert key not in nodes[0]
    assert api.get("/api/nodes/pve1/status", headers=creator).status_code == 403
