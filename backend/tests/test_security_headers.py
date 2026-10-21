"""FD-05：所有响应必须带浏览器安全头，且 CSP 不能为文档放宽整站。

用例走 /api/health（匿名、不查库），只验证「头在不在、值对不对」这一层。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import main


def test_security_headers_on_every_response() -> None:
    client = TestClient(main.app)
    response = client.get("/api/health")

    assert response.status_code == 200
    headers = response.headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in headers["permissions-policy"]
    assert headers["x-frame-options"] == "DENY"

    csp = headers["content-security-policy"]
    assert "default-src 'self'" in csp
    # 普通页面的脚本只能是同源 —— 这是 XSS 的纵深防线，别被文档需求带偏
    assert "script-src 'self';" in csp
    assert "frame-ancestors 'none'" in csp

    # 别回显服务器商标（FD-14）：uvicorn 的那条由 run.py 的 server_header=False
    # 关掉，这里确保应用层也不会冒出来一条
    assert "server" not in {name.lower() for name in headers}
    assert "x-powered-by" not in {name.lower() for name in headers}


def test_docs_csp_is_relaxed_only_for_docs_paths() -> None:
    """文档页要放行 cdn.jsdelivr.net，但整站 CSP 里不能出现它。"""
    middleware = main.SecurityHeadersMiddleware
    assert "cdn.jsdelivr.net" not in middleware.CSP
    assert "cdn.jsdelivr.net" in middleware.DOCS_CSP
    assert middleware.DOCS_PATHS == {"/api/docs", "/api/redoc"}
