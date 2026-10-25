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

只对**面板本机**（``host_id == "local"``）生效：haproxy 的那条通道只转到本机
22，其它主机的 22 走的是各自的 frp 端口，套用同一份日志会张冠李戴。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import List, NamedTuple, Optional, Set

from . import config, sshremote

logger = logging.getLogger(__name__)

#: haproxy 默认日志：``188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel 1/0/24906 1813 --``
#: 中间那组 ``Tq/Tw/Tc`` 是纯 TCP 的三个计时器（毫秒），``Tc`` 就是整条连接的存活时长。
_LINE = re.compile(
    r"^(?P<ip>[0-9a-fA-F:.]{2,45}):\d+ "
    r"\[(?P<ts>\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2})(?:\.\d+)?\] "
    r"ssh_in \S+ "
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


def _setting(name: str) -> str:
    return str(getattr(config.settings, name, "") or "").strip()


def proxies() -> Set[str]:
    raw = _setting("ssh_forward_proxies").replace(";", ",")
    return {item.strip() for item in raw.split(",") if item.strip()}


def enabled() -> bool:
    """配置齐全才启用；否则完全不影响原有行为。"""
    return bool(_setting("ssh_forward_log_host")) and bool(proxies())


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
        items.append(Conn(start=start, ttl=int(match.group("tc")) / 1000.0,
                          ip=match.group("ip")))
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


async def resolve(ts: float, forwarded: str) -> Optional[str]:
    """给一条「认证失败」记录找真实 IP。

    :param ts: 失败记录的时间戳（秒）
    :param forwarded: 日志里看到的来源地址（入口机）
    :return: 真实 IP；未启用 / 找不到 / 该地址不是转发机时返回 ``None``
    """
    if not forwarded or forwarded not in proxies():
        return None

    items = await _load()
    if not items:
        return None

    # 不按「一条连接只能用一次」消费：SSH 在 MaxAuthTries 之前可以在同一个 TCP
    # 连接里连续试多个用户名，一次连接对应多条失败记录是正常的，复用同一 IP 才对。
    best: Optional[Conn] = None
    for conn in items:
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
    ts: float, end: Optional[float], forwarded: str
) -> Optional[str]:
    """给一条「登录成功」记录找真实 IP。

    与 :func:`resolve` 的区别是证据更硬、条件更严：光靠「时间最近」在爆破期间
    几乎必然配到别人的连接，所以还要求连接的生命周期与该登录会话对得上。

    :param ts: 登录开始时刻（wtmp 里的 start）
    :param end: 会话结束时刻；``None`` = 还没结束（此时必然返回 ``None``）
    :param forwarded: 日志里看到的来源地址（入口机）
    :return: 真实 IP；未启用 / 会话未结束 / 找不到时返回 ``None``
    """
    if end is None or end <= ts:
        return None
    if not forwarded or forwarded not in proxies():
        return None

    items = await _load()
    if not items:
        return None

    best: Optional[Conn] = None
    for conn in items:
        if conn.start > ts + CLOCK_SKEW:
            continue  # 连接晚于登录：不可能是这次会话
        if ts - conn.start > LOGIN_GRACE:
            continue  # 连接建立太久之前，认证早就超时了
        if abs(conn.start + conn.ttl - end) > END_TOLERANCE:
            continue  # 连接不在这条会话的结束时刻收尾：是别人的（多半是爆破）
        if best is None or conn.start > best.start:
            best = conn  # 同一窗口里取最晚建立的那条
    return best.ip if best else None
