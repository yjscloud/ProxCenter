"""FD-03：接口文档不能匿名可读。

审计项：``/api/openapi.json`` 无需认证就吐出全部路径、字段约束与隐藏端点，
等于给攻击者一份现成的侦察报告。用例只验证路由表这一层（不连数据库）：

* 默认不注册三个文档地址，FastAPI 内置的三个入口也必须是 ``None``；
* 打开 ``API_DOCS_ENABLED`` 后，注册的等价路由必须要求登录（匿名 = 401）。
"""
from __future__ import annotations

from typing import Set

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import main
from app.config import settings

DOCS_PATHS = ("/api/docs", "/api/redoc", "/api/openapi.json")


def _paths(app: FastAPI) -> Set[str]:
    return {str(getattr(route, "path", "")) for route in app.routes}


def test_docs_are_not_mounted_by_default() -> None:
    """默认配置下三个文档地址都不存在，且内置文档入口全部为 None。"""
    assert settings.api_docs_enabled is False
    paths = _paths(main.app)
    for path in DOCS_PATHS:
        assert path not in paths, f"{path} 不该被注册"
    # 内置入口没关掉等于白改：FastAPI 会自己挂一条无鉴权的文档路由
    assert main.app.docs_url is None
    assert main.app.redoc_url is None
    assert main.app.openapi_url is None


def test_enabled_docs_require_login() -> None:
    """打开开关后，三个地址都必须是「没有凭据就 401」。"""
    probe = FastAPI(title="ProxCenter API")
    main._mount_api_docs(probe)
    assert set(DOCS_PATHS).issubset(_paths(probe))

    client = TestClient(probe)
    for path in DOCS_PATHS:
        response = client.get(path)
        assert response.status_code == 401, f"{path} 匿名可读（{response.status_code}）"
