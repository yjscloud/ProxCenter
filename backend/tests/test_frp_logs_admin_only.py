"""frpc 运行日志仅管理员可见。

日志里带着 frps 地址、连接失败的真实原因，以及每条代理的起停顺序 —— 它描述的
是整台面板的隧道运行情况，不是「我这条隧道通不通」。原先的口子是
``frp.view`` + 按规则名做**黑名单**过滤：换个代理名、换一套日志格式，别人的
代理名就漏出来了。收紧成 admin-only 之后，这条用例把边界钉住。
"""
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: F401


def test_admin_can_read_frpc_logs(api) -> None:
    resp = api.get("/api/frp/logs", headers=auth_headers(api))
    assert resp.status_code == 200
    assert isinstance(resp.json()["logs"], list)


def test_plain_user_is_forbidden(api) -> None:
    """有 frp.view 也不行：普通用户连日志接口都进不去。"""
    viewer = user_with_permissions(api, ["frp.view"], "frp-log-viewer")
    resp = api.get("/api/frp/logs", headers=viewer)
    assert resp.status_code == 403


def test_legacy_config_hides_logs_from_plain_user(api) -> None:
    """旧前端读的是 /api/frp/config 的合并视图 —— 那条路也必须给空日志。"""
    viewer = user_with_permissions(api, ["frp.view"], "frp-log-viewer-2")
    body = api.get("/api/frp/config", headers=viewer).json()
    assert body["logs"] == []

    admin_body = api.get("/api/frp/config", headers=auth_headers(api)).json()
    assert isinstance(admin_body["logs"], list)
