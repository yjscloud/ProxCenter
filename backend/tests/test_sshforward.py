"""SSH 真实来源解析（frp → haproxy → 审计）。

不需要数据库与 SSH：把「拉日志」那一步替换成固定样本，只验证解析与配对规则。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import config, sshforward  # noqa: E402

SAMPLE = (
    "188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel 1/0/5659 1813 -- 6/6/5/5/0 0/0"
)


def _fake_load(items):
    """把「读入口机日志」换成固定样本，其余逻辑走真实实现。"""

    async def loader():
        return items

    return loader


def test_line_parser_takes_real_ip() -> None:
    match = sshforward._LINE.match(SAMPLE)
    assert match is not None
    assert match.group("ip") == "188.166.188.240"
    assert match.group("ts") == "25/Oct/2026:11:48:40"
    # Tq/Tw/Tc 里的 Tc 就是连接存活毫秒数，成功登录的配对要用它
    assert match.group("tc") == "5659"
    # 第二列是 frontend 名：一条 frontend 对应一台被转发的机器
    assert match.group("fe") == "ssh_in"


def test_explicit_routes_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """显式配置（特殊部署的兜底）优先于自动发现。"""
    monkeypatch.setattr(
        config.settings,
        "ssh_forward_routes",
        "local=ssh_in,hbe0=ssh_in_8+ssh_in_8b",
        raising=False,
    )
    # 没配置的机器不能顺手去连真实入口机：这里只验证显式配置
    monkeypatch.setattr(config.settings, "ssh_forward_log_host", "", raising=False)
    assert asyncio.run(sshforward.frontends_for("local")) == {"ssh_in"}
    assert asyncio.run(sshforward.frontends_for("hbe0")) == {"ssh_in_8", "ssh_in_8b"}
    assert asyncio.run(sshforward.frontends_for("nope")) == set()


def test_explicit_route_only_affects_that_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """给某一台写了例外，别的机器仍然自动发现（不能一配就全退回不还原）。"""
    monkeypatch.setattr(
        config.settings, "ssh_forward_routes", "special=ssh_in_x", raising=False
    )

    async def fake_discover():
        return {("172.16.149.8", 22): {"ssh_in_8"}}

    monkeypatch.setattr(sshforward, "_discover", fake_discover)

    assert asyncio.run(sshforward.frontends_for("special")) == {"ssh_in_x"}
    assert asyncio.run(sshforward.frontends_for("wb8", "172.16.149.8")) == {"ssh_in_8"}
    assert asyncio.run(sshforward.frontends_for("unknown", "10.0.0.9")) == set()


def test_hostname_matches_ip_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """主机在面板里登记成域名、haproxy 里写的是 IP，也要能对上。"""
    monkeypatch.setattr(config.settings, "ssh_forward_routes", "", raising=False)
    monkeypatch.setattr(sshforward, "_dns_at", {})

    async def fake_discover():
        return {("127.0.0.1", 22): {"ssh_in_local"}}

    monkeypatch.setattr(sshforward, "_discover", fake_discover)

    assert asyncio.run(sshforward.frontends_for("h1", "localhost")) == {"ssh_in_local"}
    # 端口不一致的不认：那条 frontend 转的是别的服务
    assert asyncio.run(sshforward.frontends_for("h1", "localhost", 2222)) == set()


def test_auto_discovery_matches_local_nic(monkeypatch: pytest.MonkeyPatch) -> None:
    """自动发现：面板本机有多块网卡，哪一个对上 haproxy 的后端地址就算哪一条。"""
    monkeypatch.setattr(config.settings, "ssh_forward_routes", "", raising=False)
    monkeypatch.setattr(sshforward, "_local_ips", lambda: {"172.16.149.17"})

    async def fake_discover():
        return {("172.16.149.17", 22): {"ssh_in"}, ("172.16.149.8", 22): {"ssh_in_8"}}

    async def fake_host():
        return {"host": "172.16.149.3"}

    monkeypatch.setattr(sshforward, "_discover", fake_discover)
    monkeypatch.setattr(sshforward, "_entry_host", fake_host)

    assert asyncio.run(sshforward.frontends_for("local")) == {"ssh_in"}
    # 别的机器按它自己的地址查，不能借用本机的 frontend
    assert asyncio.run(sshforward.frontends_for("hbe0")) == set()
    assert asyncio.run(sshforward.frontends_for("hbe0", "172.16.149.8")) == {"ssh_in_8"}


def test_auto_discovery_uses_source_address(monkeypatch: pytest.MonkeyPatch) -> None:
    """主机名解析不出地址时，用「到入口机的源地址」去对 —— 那也是本机的地址。"""
    monkeypatch.setattr(config.settings, "ssh_forward_routes", "", raising=False)
    monkeypatch.setattr(sshforward, "_local_ips", lambda: set())

    async def fake_discover():
        return {("172.16.149.17", 22): {"ssh_in"}}

    async def fake_host():
        return {"host": "172.16.149.3"}

    async def fake_self(peer):
        return "172.16.149.17"

    monkeypatch.setattr(sshforward, "_discover", fake_discover)
    monkeypatch.setattr(sshforward, "_entry_host", fake_host)
    monkeypatch.setattr(sshforward, "_self_addr", fake_self)

    assert asyncio.run(sshforward.frontends_for("local")) == {"ssh_in"}


def test_auto_discovery_unknown_host_returns_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """对不上任何 frontend 就返回空集：宁可显示入口机地址，也不要张冠李戴。"""
    monkeypatch.setattr(config.settings, "ssh_forward_routes", "", raising=False)
    monkeypatch.setattr(sshforward, "_local_ips", lambda: {"10.0.0.5"})

    async def fake_discover():
        return {("172.16.149.8", 22): {"ssh_in_8"}}

    async def fake_host():
        return {"host": "172.16.149.3"}

    async def fake_self(peer):
        return "10.0.0.5"

    monkeypatch.setattr(sshforward, "_discover", fake_discover)
    monkeypatch.setattr(sshforward, "_entry_host", fake_host)
    monkeypatch.setattr(sshforward, "_self_addr", fake_self)

    assert asyncio.run(sshforward.frontends_for("local")) == set()
    assert asyncio.run(sshforward.frontends_for("hbe0", "172.16.149.99")) == set()


def test_old_deployment_falls_back_to_ssh_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """读不到 haproxy 配置时，老部署只有一条 ssh_in 通到面板本机。"""
    monkeypatch.setattr(config.settings, "ssh_forward_routes", "", raising=False)
    monkeypatch.setattr(sshforward, "_local_ips", lambda: set())

    async def empty_discover():
        return {}

    async def fake_host():
        return {"host": "172.16.149.3"}

    async def fake_self(peer):
        return ""

    monkeypatch.setattr(sshforward, "_discover", empty_discover)
    monkeypatch.setattr(sshforward, "_entry_host", fake_host)
    monkeypatch.setattr(sshforward, "_self_addr", fake_self)

    assert asyncio.run(sshforward.frontends_for("local")) == {"ssh_in"}
    # 但只给本机兜底：别的机器没配置就不还原
    assert asyncio.run(sshforward.frontends_for("hbe0")) == set()


CONFIG_SAMPLE = """
global
    log stdout format raw local0
defaults
    mode tcp
frontend ssh_in
    bind 172.16.149.3:12222 accept-proxy
    default_backend ssh_panel
backend ssh_panel
    server panel 172.16.149.17:22

frontend ssh_in_8
    bind 127.0.0.1:12223 accept-proxy
    default_backend ssh_wb8
backend ssh_wb8
    server wb8 172.16.149.8:22

frontend web_in
    bind 172.16.149.3:8080
    default_backend web_panel
backend web_panel
    server web 172.16.149.17:8080

frontend ssh_dyn
    bind :12224 accept-proxy
    use_backend ssh_a if { dst_port 22 }
    use_backend ssh_b
"""


def test_parse_haproxy_maps_backend_address_to_frontend() -> None:
    """从配置里算出「后端地址:端口 -> frontend」，换网段/加机器都不用改配置。"""
    mapping = sshforward.parse_haproxy(CONFIG_SAMPLE)
    assert mapping[("172.16.149.17", 22)] == {"ssh_in"}
    assert mapping[("172.16.149.8", 22)] == {"ssh_in_8"}
    # 没开 accept-proxy 的 frontend 拿不到真实来源，不收
    assert ("172.16.149.17", 8080) not in mapping
    # 用 use_backend 条件分流：没有唯一后端，跳过
    assert all("ssh_dyn" not in names for names in mapping.values())


def test_resolve_ignores_other_hosts_connections(configured) -> None:
    """别的机器的连接不能被拿来给这台机器配对（张冠李戴比不解析更糟）。"""
    configured.setattr(
        config.settings, "ssh_forward_routes", "local=ssh_in,wb8=ssh_in_8", raising=False
    )
    configured.setattr(
        sshforward,
        "_load",
        _fake_load(
            [
                sshforward.Conn(1000.0, 60.0, "9.9.9.9", fe="ssh_in_8"),
                sshforward.Conn(1002.0, 60.0, "1.1.1.1", fe="ssh_in"),
            ]
        ),
    )
    assert asyncio.run(sshforward.resolve(1010.0, "172.16.149.3", "local")) == "1.1.1.1"
    assert asyncio.run(sshforward.resolve(1010.0, "172.16.149.3", "wb8")) == "9.9.9.9"


def test_fetch_parses_connection_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    """拉日志时要把存活时长一起解析出来，成功登录靠它和会话结束时刻对齐。"""

    class _Row(dict):
        pass

    async def fake_get_host(host_id):
        return _Row(id=host_id)

    async def fake_run(row, command, timeout=None):
        return True, SAMPLE

    monkeypatch.setattr(sshforward.sshremote, "get_host", fake_get_host)
    monkeypatch.setattr(sshforward.sshremote, "run_command", fake_run)

    items = asyncio.run(sshforward._fetch())
    assert items and items[0].ip == "188.166.188.240"
    assert items[0].ttl == pytest.approx(5.659)


def test_line_parser_keeps_frontend_name() -> None:
    """其它 frontend 也要认：frontend 名决定这条连接打到哪台机器。"""
    line = SAMPLE.replace("ssh_in", "ssh_in_8")
    match = sshforward._LINE.match(line)
    assert match is not None
    assert match.group("fe") == "ssh_in_8"


def test_line_parser_ignores_non_haproxy_lines() -> None:
    assert sshforward._LINE.match("Starting haproxy.service - HAProxy Load Balancer...") is None
    assert sshforward._LINE.match("[NOTICE]   (3507276) : New worker (3507278) forked") is None


@pytest.fixture()
def configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(config.settings, "ssh_forward_log_host", "host-1", raising=False)
    monkeypatch.setattr(
        config.settings, "ssh_forward_proxies", "172.16.149.3", raising=False
    )
    # 显式 routes：用例不联网、也不去读入口机的 haproxy 配置
    monkeypatch.setattr(
        config.settings, "ssh_forward_routes", "local=ssh_in", raising=False
    )
    # 每个用例重置缓存，避免相互污染
    monkeypatch.setattr(sshforward, "_cache_items", [])
    monkeypatch.setattr(sshforward, "_cache_at", 0.0)
    return monkeypatch


def test_disabled_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.settings, "ssh_forward_log_host", "", raising=False)
    monkeypatch.setattr(config.settings, "ssh_forward_proxies", "", raising=False)
    assert asyncio.run(sshforward.resolve(1000.0, "172.16.149.3")) is None


def test_non_proxy_address_returns_none(configured) -> None:
    """普通公网来源不需要还原，直接返回 None（不触发拉日志）。"""
    assert asyncio.run(sshforward.resolve(1000.0, "203.0.113.7")) is None


def test_nearest_connection_wins(configured) -> None:
    async def fake_load():
        return [
            sshforward.Conn(1000.0, 20.0, "1.1.1.1"),
            sshforward.Conn(1001.5, 20.0, "2.2.2.2"),
            sshforward.Conn(1005.0, 20.0, "3.3.3.3"),
        ]

    configured.setattr(sshforward, "_load", fake_load)

    assert asyncio.run(sshforward.resolve(1001.0, "172.16.149.3")) == "2.2.2.2"
    # 同一个连接可能承载多次认证失败：复用同一个真实 IP 是正确行为
    assert asyncio.run(sshforward.resolve(1001.2, "172.16.149.3")) == "2.2.2.2"
    assert asyncio.run(sshforward.resolve(1005.0, "172.16.149.3")) == "3.3.3.3"


def test_failure_maps_to_connection_still_open(configured) -> None:
    """线上实测：失败记录比连接建立晚 5~20 秒（同一条连接连试多个用户名）。

    判据是「这条连接在失败发生时还开着」，不是「3 秒内最近」。
    """
    configured.setattr(
        sshforward,
        "_load",
        _fake_load([sshforward.Conn(1000.0, 25.0, "5.5.5.5")]),
    )
    assert asyncio.run(sshforward.resolve(1012.0, "172.16.149.3")) == "5.5.5.5"
    # 连接已经断开：不能硬配一条已经关掉的连接
    assert asyncio.run(sshforward.resolve(1030.0, "172.16.149.3")) is None


def test_outside_window_returns_none(configured) -> None:
    async def fake_load():
        return [sshforward.Conn(1000.0, 20.0, "1.1.1.1")]

    configured.setattr(sshforward, "_load", fake_load)
    # 容差 3 秒：差 60 秒不应硬凑一个 IP 出来
    assert asyncio.run(sshforward.resolve(1060.0, "172.16.149.3")) is None


def test_empty_log_returns_none(configured) -> None:
    async def fake_load():
        return []

    configured.setattr(sshforward, "_load", fake_load)
    assert asyncio.run(sshforward.resolve(1000.0, "172.16.149.3")) is None


def test_failed_fetch_is_cached(configured) -> None:
    """入口机连不上时要退避：不能每条失败记录都去 SSH 一次。

    爆破期间失败记录有几千条，若每条都重连入口机，光是等超时就能把导入拖死。
    """
    calls = []

    async def broken_fetch():
        calls.append(1)
        return []

    configured.setattr(sshforward, "_fetch", broken_fetch)
    configured.setattr(sshforward, "_cache_items", [])
    configured.setattr(sshforward, "_cache_at", 0.0)

    for _ in range(5):
        assert asyncio.run(sshforward.resolve(1000.0, "172.16.149.3")) is None
    assert len(calls) == 1


# ------------------------------------------------------------ 成功登录的配对


def _login_load(configured, items):
    async def fake_load():
        return items

    configured.setattr(sshforward, "_load", fake_load)


def test_login_matches_connection_that_ends_with_session(configured) -> None:
    """成功登录按「连接收尾时刻 == 会话结束时刻」配对，而不是「时间最近」。"""
    _login_load(
        configured,
        [
            # 爆破连接：登录前一秒建立，但 20 秒就断了，不可能是这条会话
            sshforward.Conn(1000.0, 20.0, "6.6.6.6"),
            # 真人会话：300 秒后结束，恰好对上 wtmp 的结束时间
            sshforward.Conn(998.0, 303.0, "2.2.2.2"),
        ],
    )

    assert (
        asyncio.run(sshforward.resolve_login(1001.0, 1301.0, "172.16.149.3"))
        == "2.2.2.2"
    )


def test_login_prefers_latest_qualifying_connection(configured) -> None:
    """两条都对得上结束时刻时取最晚建立的 —— 那才是这次登录的连接。"""
    _login_load(
        configured,
        [
            sshforward.Conn(970.0, 331.0, "1.1.1.1"),
            sshforward.Conn(1000.0, 301.0, "2.2.2.2"),
        ],
    )
    assert (
        asyncio.run(sshforward.resolve_login(1001.0, 1301.0, "172.16.149.3"))
        == "2.2.2.2"
    )


def test_login_with_open_session_returns_none(configured) -> None:
    """会话还没结束：haproxy 还没写这条连接的日志行，不能猜。"""
    _login_load(configured, [sshforward.Conn(1000.0, 20.0, "6.6.6.6")])
    assert asyncio.run(sshforward.resolve_login(1001.0, None, "172.16.149.3")) is None


def test_login_ignores_session_ending_at_another_time(configured) -> None:
    _login_load(configured, [sshforward.Conn(1000.0, 20.0, "6.6.6.6")])
    assert asyncio.run(sshforward.resolve_login(1001.0, 1301.0, "172.16.149.3")) is None


def test_login_from_non_proxy_address_returns_none(configured) -> None:
    _login_load(configured, [sshforward.Conn(1000.0, 301.0, "2.2.2.2")])
    assert asyncio.run(sshforward.resolve_login(1001.0, 1301.0, "203.0.113.7")) is None
