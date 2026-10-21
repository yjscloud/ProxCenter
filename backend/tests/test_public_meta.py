"""未鉴权的版本 / RBAC 暴露（本轮审计项）。

只做路由表层面的断言（不查库、不发请求）：

* ``/api/version``、``/api/auth/permissions`` 必须挂在 ``get_current_user`` 后面；
* ``/api/config/site`` 按设计保持公开（登录页 / 官网要渲染品牌信息），
  它只含站点名、Logo、备案号这类内容，不含版本与内部地址。
"""
from __future__ import annotations

from typing import Any

from app import main, security


def _requires_login(route: Any) -> bool:
    """路由（或其子依赖）里是否有 get_current_user。"""
    stack = list(getattr(getattr(route, "dependant", None), "dependencies", []))
    seen = set()
    while stack:
        dep = stack.pop()
        if id(dep) in seen:
            continue
        seen.add(id(dep))
        if dep.call is security.get_current_user:
            return True
        stack.extend(getattr(dep, "dependencies", []))
    return False


def _get_route(path: str) -> Any:
    """按「GET + 路径」找路由：同一路径上可能还有需要鉴权的 PUT。"""
    for route in main.app.routes:
        if getattr(route, "path", None) == path and "GET" in (
            getattr(route, "methods", set()) or set()
        ):
            return route
    raise AssertionError(f"找不到 GET {path}")


def test_version_requires_login() -> None:
    assert _requires_login(_get_route("/api/version"))


def test_permissions_require_login() -> None:
    assert _requires_login(_get_route("/api/auth/permissions"))


def test_site_info_stays_public() -> None:
    # 登录页与官网在没有会话时就要拿到站点名 / Logo，必须保持匿名可读
    assert not _requires_login(_get_route("/api/config/site"))
