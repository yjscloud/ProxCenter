"""把 frp → haproxy 入口的**真实来源 IP** 关联回 SSH 登录审计。

背景
----
面板（以及同网段的其它主机）的 22 端口经 frp 暴露到公网时，frpc 是从入口机
（如 172.16.149.3）**回连**目标 sshd 的，所以 sshd / ``lastb`` 里只能看到入口机
的地址 —— 21 万条爆破记录全来自同一个内网 IP，既分不清攻击者，也不敢按它封禁
（一封就把整条 frp 通道封死）。

真实地址并没有丢：入口机上用 haproxy 的 ``accept-proxy`` 接住 frpc 发来的
PROXY protocol 头，把它写进了自己的日志（``frontend ssh_in``）::

    188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel 1/0/24906 1813 -- ...

这里读回那份日志，按时间把审计记录的来源地址替换成真实 IP。两个关键事实（在
入口机上实测过）：

* ``[...]`` 里的时间戳是**会话建立**的时刻，不是写日志的时刻 —— haproxy 要到
  连接关闭才写这一行，但时间戳取的是 accept 的时间；
* ``1/0/24906`` 是 ``Tq/Tw/Tc``（毫秒），``Tc`` 就是整条连接的存活时长。

两种记录的证据强度不同，配对规则也不同：

失败（``host.ssh_failed``）
    失败记录的时间是**那次认证失败**的时刻，比连接建立晚几秒到几十秒（线上实测
    5~20 秒：同一条连接会连试多个用户名，每次之间还有延迟）。所以判据是「这条
    连接在失败发生时还开着」：``连接开始 ≤ 失败时间``、``连接结束 ≥ 失败时间``，
    在满足的连接里取**最晚建立**的那条。SSH 允许在同一个 TCP 连接里连试多个
    用户名，所以一条连接对应多条失败记录是正常的，**不做「一条只能用一次」的消费**。

成功（``host.ssh_login``）
    登录时间是**认证通过**之后，可能比连接建立晚几十秒（用户要输密码），爆破期
    「最近的一条连接」几乎必然配到别人的连接上。所以只认更强的证据：连接必须
    早于登录、且不早于 :data:`LOGIN_GRACE` 秒，同时 ``连接时刻 + Tt`` 要落在该
    会话的**结束时刻**附近 —— 爆破连接只活十几秒，对不上几分钟的登录会话。

    代价：**会话还在进行时配不出来**（haproxy 此时还没有这条连接的日志行）。
    那时返回 ``None``，调用方把这条登录挂起来等会话结束再补写，而不是先写入口机
    地址（写进审计就改不了了）。

匹配不上就返回 ``None``，调用方保留原地址 —— 宁可显示入口机地址，也不要随便编
一个攻击者。

每台被转发的机器在入口机上各有一条 frontend（``ssh_in`` 给面板本机、``ssh_in_8``
给 172.16.149.8 …），日志第二列就是 frontend 名。所以「这条连接属于哪台机器」
是日志自己带着的，不用猜。这个对应关系**自动发现**：读入口机的 haproxy 配置，
按 ``frontend -> backend -> server <地址>:22`` 与各主机在面板里登记的地址对上；
转发机地址同样自动取入口机自己的地址。不同部署的网段、frontend 命名、主机数量
都不需要额外配置（``SSH_FORWARD_ROUTES`` 等只是读不到配置时的显式兜底）。
对不上的主机保持原地址 —— 宁可显示入口机地址，也不要张冠李戴。
"""
from __future__ import annotations

import asyncio
import logging
import re
import socket
import time
from datetime import datetime
from typing import Any, Dict, List, NamedTuple, Optional, Set, Tuple

from . import config, sshremote

logger = logging.getLogger(__name__)

#: haproxy 默认日志：``188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel 1/0/24906 1813 --``
#: 第二个字段是 frontend 名（每台被转发的机器一个），第三个是 ``backend/server``，
#: 中间那组 ``Tq/Tw/Tc`` 是纯 TCP 的三个计时器（毫秒），``Tc`` 就是整条连接的存活时长。
_LINE = re.compile(
    r"^(?P<ip>[0-9a-fA-F:.]{2,45}):\d+ "
    r"\[(?P<ts>\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2})(?:\.\d+)?\] "
    r"(?P<fe>\S+) \S+ "
    r"\d+/\d+/(?P<tc>\d+) "
)

#: 日志缓存时间（秒）—— 一次导入会问几千次，不能每次都连 SSH
CACHE_TTL = 30.0
#: 拉取失败（或日志为空）时的退避时间：入口机连不上时，不能把几千条失败记录
#: 每条都变成一次 SSH 尝试 —— 那比不解析还糟
FAIL_TTL = 60.0
#: 失败记录：从连接建立到这一次认证失败最多能隔多久（秒）。
#: 实测线上：bot 的连接能活 15~30 秒，同一条连接里连试多个用户名，每条失败记录
#: 比连接建立晚 5~20 秒 —— 所以不能用「±3 秒」这种窄窗口去配。
FAIL_GRACE = 180.0
#: 成功登录：连接建立到认证通过最多能隔多久（sshd 的 LoginGraceTime 默认 120s）
LOGIN_GRACE = 150.0
#: 成功登录：``连接时刻 + Tt`` 与会话结束时刻的容差（两台机器的时钟差 + 收尾延迟）
END_TOLERANCE = 10.0
#: 成功登录：允许连接时间比登录时间略晚（两台机器的时钟差；只留很小的余量，
#: 因为连接必然建立于认证通过之前，晚太多就不是这条会话了）
CLOCK_SKEW = 2.0
#: 每次回溯多久的日志（秒）
LOOKBACK = 6 * 3600
#: 单次最多读多少行
MAX_LINES = 20000

_cache_at = 0.0
_cache_items: List["Conn"] = []
_lock = asyncio.Lock()


class Conn(NamedTuple):
    """入口机日志里的一条 SSH 连接。"""

    start: float  #: 连接建立时刻（haproxy 记的时间戳）
    ttl: float  #: 连接存活秒数（会话关闭后才有意义）
    ip: str  #: PROXY protocol 里带的真实来源地址
    fe: str = "ssh_in"  #: 是哪条 frontend 记下的（对应哪台被转发的机器）


def _setting(name: str) -> str:
    return str(getattr(config.settings, name, "") or "").strip()


def proxies() -> Set[str]:
    """显式配置的「入口机地址」；留空 = 自动发现（见 :func:`proxies_set`）。"""
    raw = _setting("ssh_forward_proxies").replace(";", ",")
    return {item.strip() for item in raw.split(",") if item.strip()}


def routes() -> Dict[str, Set[str]]:
    """显式配置的「主机 -> frontend」；留空 = 自动发现（见 :func:`frontends_for`）。

    格式 ``local=ssh_in,hbe088f0e75=ssh_in_8``（一机多条 frontend 用 ``+``）。
    正常情况下不需要它：面板会去读入口机的 haproxy 配置自己算出来。
    """
    raw = _setting("ssh_forward_routes").replace(";", ",")
    out: Dict[str, Set[str]] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        host, _, names = item.partition("=")
        fronts = {name.strip() for name in names.split("+") if name.strip()}
        if host.strip() and fronts:
            out[host.strip()] = fronts
    return out


def enabled() -> bool:
    """配了入口日志主机就启用；映射与转发机地址都会自动发现。

    没配 = 完全关闭，行为与以前一致。
    """
    return bool(_setting("ssh_forward_log_host"))


# ---------------------------------------------------------------- 自动发现
#
# 「哪台机器的连接落在哪条 frontend 上」不该让用户手填：入口机的 haproxy 配置里
# 本来就写着 ``frontend X -> backend Y -> server Z <地址>:22``，而每条被转发的机器
# 在面板里也有自己的地址（``ssh_hosts.host``）。两边按「后端地址:端口」对上即可，
# 用户换网段、加机器、改 frontend 名字都不用动配置。
#
# 只认 ``bind ... accept-proxy`` 的 frontend —— 只有它能从 PROXY protocol 里拿到
# 真实来源地址，其它 frontend 的日志里是连接发起方（入口机自己），拿来配对会张冠
# 李戴。

#: 自动发现的缓存时间（秒）：haproxy 配置与入口机地址都很少变
DISCOVER_TTL = 300.0
#: 入口机上 haproxy 配置文件的位置（可用 SSH_FORWARD_HAPROXY_CFG 覆盖）
DEFAULT_HAPROXY_CFG = "/etc/haproxy/haproxy.cfg"

_FE = re.compile(r"^frontend\s+(\S+)")
_BE = re.compile(r"^backend\s+(\S+)")
_DEFAULT_BE = re.compile(r"^\s+default_backend\s+(\S+)")
_USE_BE = re.compile(r"^\s+use_backend\s+(\S+)")
_BIND = re.compile(r"^\s+bind\s+(\S+)(.*)$")
_SERVER = re.compile(r"^\s+server\s+(\S+)\s+(\S+)")

_discover_at = 0.0
_discover_map: Dict[Tuple[str, int], Set[str]] = {}
_proxies_at = 0.0
_discovered_proxies: Set[str] = set()
_discover_lock = asyncio.Lock()


def _split_addr(text: str) -> Optional[Tuple[str, int]]:
    """``172.16.149.8:22`` / ``[::1]:22`` → ``(地址, 端口)``；解析不出返回 None。"""
    value = text.strip()
    if value.startswith("["):
        host, _, rest = value.partition("]")
        host = host[1:]
        _, _, port = rest.partition(":")
    else:
        host, sep, port = value.rpartition(":")
        if not sep:
            return None
    if not host or not port.isdigit():
        return None
    return host, int(port)


def parse_haproxy(text: str) -> Dict[Tuple[str, int], Set[str]]:
    """从 haproxy 配置推出「后端地址:端口 -> frontend 名」。

    只收静态 ``default_backend`` 的 frontend；用 ``use_backend`` 做条件分流的
    配不出唯一后端，跳过（那种部署请用 ``SSH_FORWARD_ROUTES`` 显式指定）。
    """
    frontends: Dict[str, Dict[str, Any]] = {}
    backends: Dict[str, List[Tuple[str, int]]] = {}
    section, name = "", ""
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        match = _FE.match(line)
        if match:
            section, name = "frontend", match.group(1)
            frontends[name] = {"backend": "", "proxy": False, "dynamic": False}
            continue
        match = _BE.match(line)
        if match:
            section, name = "backend", match.group(1)
            backends[name] = []
            continue
        if section == "frontend":
            meta = frontends.get(name)
            if meta is None:
                continue
            match = _BIND.match(line)
            if match and "accept-proxy" in match.group(2):
                meta["proxy"] = True
                continue
            if _USE_BE.match(line):
                meta["dynamic"] = True
                continue
            match = _DEFAULT_BE.match(line)
            if match:
                meta["backend"] = match.group(1)
            continue
        if section == "backend":
            match = _SERVER.match(line)
            if match:
                addr = _split_addr(match.group(2))
                if addr:
                    backends[name].append(addr)

    out: Dict[Tuple[str, int], Set[str]] = {}
    for fe_name, meta in frontends.items():
        if not meta["proxy"] or meta["dynamic"] or not meta["backend"]:
            continue
        for addr in backends.get(meta["backend"], []):
            out.setdefault(addr, set()).add(fe_name)
    return out


async def _entry_host() -> Optional[Dict[str, Any]]:
    host_id = _setting("ssh_forward_log_host")
    return await sshremote.get_host(host_id) if host_id else None


async def _discover() -> Dict[Tuple[str, int], Set[str]]:
    """读入口机的 haproxy 配置，算出「后端地址 -> frontend」。失败返回上次结果。"""
    global _discover_at, _discover_map, _discovered_proxies
    async with _discover_lock:
        now = time.time()
        if now - _discover_at < DISCOVER_TTL:
            return _discover_map
        _discover_at = now
        row = await _entry_host()
        if not row:
            logger.warning("SSH 入口日志主机不存在，跳过真实来源解析")
            return _discover_map

        path = _setting("ssh_forward_haproxy_cfg") or DEFAULT_HAPROXY_CFG
        ok, output = await sshremote.run_command(
            row, f"cat {path}", timeout=sshremote.LOG_TIMEOUT
        )
        if not ok or not output.strip():
            logger.warning(
                "读不到入口机 %s 的 haproxy 配置（%s）：真实来源解析暂不可用",
                row.get("host") or row.get("id"),
                (output or "")[:160],
            )
            return _discover_map

        _discover_map = parse_haproxy(output)
        logger.info(
            "入口机 haproxy 里发现 %d 条 SSH 转发：%s",
            len(_discover_map),
            sorted(f"{addr}:{port}={sorted(fe)}" for (addr, port), fe in _discover_map.items()),
        )

        # 入口机自己的地址就是「转发机地址」：frpc 从它出站回连各台 sshd，sshd 看到
        # 的就是它。多网卡时全都收进来（哪个网卡出站取决于路由，宁可多认几个）。
        ips = {str(row.get("host") or "").strip()}
        ok_addr, out_addr = await sshremote.run_command(
            row, "hostname -I", timeout=sshremote.LOG_TIMEOUT
        )
        if ok_addr:
            ips |= set(out_addr.split())
        ips.discard("")
        _discovered_proxies = ips
        return _discover_map


async def proxies_set() -> Set[str]:
    """「入口机地址」集合：显式配置优先，否则自动发现。"""
    explicit = proxies()
    if explicit:
        return explicit
    await _discover()
    return set(_discovered_proxies)


async def _self_addr(peer: str) -> str:
    """本机到入口机的源地址（面板在 haproxy 后端里通常就是这个地址:22）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect((peer, 22))
            return str(sock.getsockname()[0])
    except OSError:
        return ""


def _local_ips() -> Set[str]:
    """本机的 IPv4 地址（多网卡时会有多个，用来对上 haproxy 里写的后端地址）。

    先按主机名查；容器里主机名往往解析不出来（不一定写进 /etc/hosts），再退回到
    枚举网卡地址 —— 少了这一步，多网卡的面板就永远对不上 haproxy 里的后端地址。
    """
    ips: Set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(str(info[4][0]))
    except OSError:
        pass
    try:
        import fcntl
        import struct

        for _, name in socket.if_nameindex():
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                try:
                    res = fcntl.ioctl(
                        sock.fileno(), 0x8915, struct.pack("256s", name[:15].encode())
                    )
                except OSError:
                    continue
                ips.add(socket.inet_ntoa(res[20:24]))
    except (AttributeError, ImportError, OSError):
        pass
    return ips


#: 地址解析结果缓存（秒）：主机多、导入频繁时不能每次都查 DNS
DNS_TTL = 300.0
_dns_at: Dict[str, Tuple[float, Set[str]]] = {}


async def _addr_set(host: str) -> Set[str]:
    """把一个地址规范成一组 IPv4：域名解析成 IP，IP 原样保留。

    面板登记主机时允许填域名，而 haproxy 配置里多半写的是 IP —— 不解析的话，
    新加的机器只要填的是域名就永远对不上 frontend。
    """
    value = str(host or "").strip()
    if not value:
        return set()
    now = time.time()
    hit = _dns_at.get(value)
    if hit is not None and now - hit[0] < DNS_TTL:
        return set(hit[1])
    ips: Set[str] = {value}
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            value, None, family=socket.AF_INET
        )
    except (OSError, UnicodeError):
        infos = []
    for info in infos:
        ips.add(str(info[4][0]))
    ips.discard("")
    _dns_at[value] = (now, ips)
    return set(ips)


async def _fronts_at(
    mapping: Dict[Tuple[str, int], Set[str]], host: str, port: int
) -> Set[str]:
    """「地址:端口」→ frontend；地址先解析成 IP 再比，域名/IP 混着写也能对上。

    端口必须一致：端口不同的那条 frontend 转的是别的服务，拿它的日志配对会
    张冠李戴。
    """
    value = str(host or "").strip()
    if not value:
        return set()
    port = int(port or 22)
    fronts = set(mapping.get((value, port), ()))
    if fronts:
        return fronts
    want = await _addr_set(value)
    for (be_host, be_port), names in mapping.items():
        if be_port != port:
            continue
        if want & await _addr_set(be_host):
            fronts |= names
    return fronts


async def frontends_for(host_id: str, addr: str = "", port: int = 22) -> Set[str]:
    """这台主机的连接落在入口机的哪几条 frontend 上；空集 = 不做还原。

    ``SSH_FORWARD_ROUTES`` 里**显式写了这台主机**才用配置（个别特殊部署的例外），
    没写的主机照旧自动发现 —— 不会因为给某一台写了例外，其它机器就都失效。

    自动发现按「后端地址:端口」查，地址会先解析成 IP 再比。面板本机可能有多块
    网卡，所以把「到入口机的源地址」和本机所有 IPv4 都试一遍。查不到就返回空集
    —— 宁可显示入口机地址，也不要张冠李戴。
    """
    host_key = str(host_id)
    explicit = routes()
    if host_key in explicit:
        return set(explicit[host_key])

    mapping = await _discover()
    port = int(port or 22)
    host = str(addr or "").strip()
    if host:
        return await _fronts_at(mapping, host, port)

    if host_key != "local":
        return set()

    row = await _entry_host()
    candidates = _local_ips()
    candidates.add(await _self_addr(str((row or {}).get("host") or "")))
    candidates.discard("")
    for candidate in candidates:
        fronts = await _fronts_at(mapping, candidate, port)
        if fronts:
            return fronts
    if not mapping:
        # 读不到配置时的兜底：老部署就是一条 ssh_in 通到面板本机
        return {"ssh_in"}
    return set()


async def _fetch() -> List[Conn]:
    host_id = _setting("ssh_forward_log_host")
    row = await sshremote.get_host(host_id)
    if not row:
        logger.warning("SSH 入口日志主机 %s 不存在，跳过真实来源解析", host_id)
        return []
    since = int(time.time()) - LOOKBACK
    command = (
        f"journalctl -u haproxy --since @{since} -o cat --no-pager -n {MAX_LINES}"
    )
    ok, output = await sshremote.run_command(row, command, timeout=sshremote.LOG_TIMEOUT)
    if not ok:
        logger.warning("读取 SSH 入口日志失败：%s", output[:200])
        return []

    items: List[Conn] = []
    for line in output.splitlines():
        match = _LINE.match(line.strip())
        if not match:
            continue
        try:
            start = datetime.strptime(
                match.group("ts"), "%d/%b/%Y:%H:%M:%S"
            ).timestamp()
        except ValueError:
            continue
        items.append(
            Conn(
                start=start,
                ttl=int(match.group("tc")) / 1000.0,
                ip=match.group("ip"),
                fe=match.group("fe"),
            )
        )
    items.sort()
    return items


async def _load() -> List[Conn]:
    global _cache_at, _cache_items
    async with _lock:
        ttl = CACHE_TTL if _cache_items else FAIL_TTL
        if time.time() - _cache_at < ttl:
            return _cache_items
        items = await _fetch()
        # 空结果同样打时间戳：失败也要退避，否则每条记录都会重连一次入口机
        _cache_at = time.time()
        # 只接受非空结果覆盖缓存 —— 一次抖动不应该把已经拿到的记录抹掉
        if items:
            _cache_items = items
        return _cache_items


async def resolve(
    ts: float,
    forwarded: str,
    host_id: str = "local",
    fronts: Optional[Set[str]] = None,
    proxy_ips: Optional[Set[str]] = None,
    addr: str = "",
    port: int = 22,
) -> Optional[str]:
    """给一条「认证失败」记录找真实 IP。

    :param ts: 失败记录的时间戳（秒）
    :param forwarded: 日志里看到的来源地址（入口机）
    :param host_id: 这条记录属于哪台主机（决定看哪几条 frontend）
    :param fronts: 预先算好的 frontend 集合（批量处理时避免重复发现）
    :param proxy_ips: 预先算好的入口机地址集合
    :param addr: 主机地址（自动发现映射时用；空 = 面板本机）
    :param port: 主机 SSH 端口
    :return: 真实 IP；未配置 / 找不到 / 该地址不是转发机时返回 ``None``
    """
    if not enabled() or not forwarded:
        return None
    if fronts is None:
        fronts = await frontends_for(host_id, addr, port)
    if not fronts:
        return None
    ips = proxy_ips if proxy_ips is not None else await proxies_set()
    if forwarded not in ips:
        return None

    items = await _load()
    if not items:
        return None

    # 不按「一条连接只能用一次」消费：SSH 在 MaxAuthTries 之前可以在同一个 TCP
    # 连接里连续试多个用户名，一次连接对应多条失败记录是正常的，复用同一 IP 才对。
    best: Optional[Conn] = None
    for conn in items:
        if conn.fe not in fronts:
            continue  # 这条连接是打到别的机器上的
        if conn.start > ts + CLOCK_SKEW:
            continue  # 连接晚于这次失败：不是它
        if ts - conn.start > FAIL_GRACE:
            continue  # 隔了太久，认证早就超时了
        if conn.start + conn.ttl < ts - CLOCK_SKEW:
            continue  # 失败发生时它已经断开：不是它
        if best is None or conn.start > best.start:
            best = conn  # 同时有多条开着时，取最晚建立的那条
    return best.ip if best else None


async def resolve_login(
    ts: float,
    end: Optional[float],
    forwarded: str,
    host_id: str = "local",
    fronts: Optional[Set[str]] = None,
    proxy_ips: Optional[Set[str]] = None,
    addr: str = "",
    port: int = 22,
) -> Optional[str]:
    """给一条「登录成功」记录找真实 IP。

    与 :func:`resolve` 的区别是证据更硬、条件更严：光靠「时间最近」在爆破期间
    几乎必然配到别人的连接，所以还要求连接的生命周期与该登录会话对得上。

    :param ts: 登录开始时刻（wtmp 里的 start）
    :param end: 会话结束时刻；``None`` = 还没结束（此时必然返回 ``None``）
    :param forwarded: 日志里看到的来源地址（入口机）
    :param host_id: 这条记录属于哪台主机（决定看哪几条 frontend）
    :param fronts: 预先算好的 frontend 集合
    :param proxy_ips: 预先算好的入口机地址集合
    :param addr: 主机地址（自动发现映射时用；空 = 面板本机）
    :param port: 主机 SSH 端口
    :return: 真实 IP；未配置 / 会话未结束 / 找不到时返回 ``None``
    """
    if end is None or end <= ts:
        return None
    if not enabled() or not forwarded:
        return None
    if fronts is None:
        fronts = await frontends_for(host_id, addr, port)
    if not fronts:
        return None
    ips = proxy_ips if proxy_ips is not None else await proxies_set()
    if forwarded not in ips:
        return None

    items = await _load()
    if not items:
        return None

    best: Optional[Conn] = None
    for conn in items:
        if conn.fe not in fronts:
            continue  # 这条连接是打到别的机器上的
        if conn.start > ts + CLOCK_SKEW:
            continue  # 连接晚于登录：不可能是这次会话
        if ts - conn.start > LOGIN_GRACE:
            continue  # 连接建立太久之前，认证早就超时了
        if abs(conn.start + conn.ttl - end) > END_TOLERANCE:
            continue  # 连接不在这条会话的结束时刻收尾：是别人的（多半是爆破）
        if best is None or conn.start > best.start:
            best = conn  # 同一窗口里取最晚建立的那条
    return best.ip if best else None
