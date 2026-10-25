"""把 frp → haproxy 入口的**真实来源 IP** 关联回 SSH 登录审计。

背景
----
面板（以及同网段的其它主机）的 22 端口经 frp 暴露到公网时，frpc 是从入口机
（如 172.16.149.3）**回连**目标 sshd 的，所以 sshd / ``lastb`` 里只能看到入口机
的地址 —— 21 万条爆破记录全来自同一个内网 IP，既分不清攻击者，也不敢按它封禁
（一封就把整条 frp 通道封死）。

真实地址并没有丢：入口机上用 haproxy 的 ``accept-proxy`` 接住 frpc 发来的
PROXY protocol 头，把它写进了自己的日志（``frontend ssh_in``）。

这里读回那份日志，按时间把 ``host.ssh_failed`` 的来源地址替换成真实 IP：

1. 一次拉最近几小时的连接记录，解析成 ``[(时间戳, 真实 IP)]`` 并缓存；
2. 每条失败记录在 ±:data:`MATCH_WINDOW` 秒内找**最近**的一条连接
   （SSH 允许在同一连接里连试多个用户名，所以一条连接对应多条失败是正常的）；
3. 匹配不上就返回 ``None``，调用方保留原地址并标记 ``forwarded`` —— 宁可显示
   入口机地址，也不要随便编一个攻击者。

只对**面板本机**（``host_id == "local"``）生效：haproxy 的那条通道只转到本机
22，其它主机的 22 走的是各自的 frp 端口，套用同一份日志会张冠李戴。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from typing import List, Optional, Set, Tuple

from . import config, sshremote

logger = logging.getLogger(__name__)

#: haproxy 默认日志：``188.166.188.240:45560 [25/Oct/2026:11:48:40.954] ssh_in ssh_panel/panel ...``
_LINE = re.compile(
    r"^(?P<ip>[0-9a-fA-F:.]{2,45}):\d+ "
    r"\[(?P<ts>\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2})(?:\.\d+)?\] "
    r"ssh_in "
)

#: 日志缓存时间（秒）—— 一次导入会问几千次，不能每次都连 SSH
CACHE_TTL = 30.0
#: 连接日志与失败记录的容差（秒）
MATCH_WINDOW = 3.0
#: 每次回溯多久的日志（秒）
LOOKBACK = 6 * 3600
#: 单次最多读多少行
MAX_LINES = 20000

_cache_at = 0.0
_cache_items: List[Tuple[float, str]] = []
_lock = asyncio.Lock()


def _setting(name: str) -> str:
    return str(getattr(config.settings, name, "") or "").strip()


def proxies() -> Set[str]:
    raw = _setting("ssh_forward_proxies").replace(";", ",")
    return {item.strip() for item in raw.split(",") if item.strip()}


def enabled() -> bool:
    """配置齐全才启用；否则完全不影响原有行为。"""
    return bool(_setting("ssh_forward_log_host")) and bool(proxies())


async def _fetch() -> List[Tuple[float, str]]:
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

    items: List[Tuple[float, str]] = []
    for line in output.splitlines():
        match = _LINE.match(line.strip())
        if not match:
            continue
        try:
            ts = datetime.strptime(match.group("ts"), "%d/%b/%Y:%H:%M:%S").timestamp()
        except ValueError:
            continue
        items.append((ts, match.group("ip")))
    items.sort()
    return items


async def _load() -> List[Tuple[float, str]]:
    global _cache_at, _cache_items
    async with _lock:
        if _cache_items and time.time() - _cache_at < CACHE_TTL:
            return _cache_items
        items = await _fetch()
        if items:
            _cache_at = time.time()
            _cache_items = items
        return _cache_items


async def resolve(ts: float, forwarded: str) -> Optional[str]:
    """给一条「来源是转发机」的失败记录找真实 IP。

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
    best_index = -1
    best_gap = MATCH_WINDOW + 1.0
    for index, (item_ts, _ip) in enumerate(items):
        gap = abs(item_ts - ts)
        if gap < best_gap:
            best_gap = gap
            best_index = index
            if gap == 0:
                break
    if best_index < 0:
        return None

    return items[best_index][1]
