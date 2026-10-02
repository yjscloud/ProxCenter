"""端口 / 进程异常检测（全平台服务器：本机 + SSH 受管主机）。

与 :mod:`app.baseline` 同一套架构：**采集**与**判定**分开，本机与远程共用判定。

* ``local_snapshot()`` / ``remote_snapshot()`` —— 采集监听端口、已建立连接、进程表、
  可执行文件路径、防火墙状态等原始数据；
* ``assess(snapshot, policy)`` —— **纯函数**，产出「对外开放端口」与「可疑进程」；
* ``async def evaluate()`` —— 上报告警（照 :mod:`app.sshguard` 的写法复用告警的
  去重 / 冷却 / 飞书邮件 / 恢复通知，完全绕开规则表）。

## 两个必须说清楚的边界

1. **这是启发式，不是杀毒引擎。** 每条命中都会列出「命中了哪几条规则」，供人判断；
   面板**不会**据此自动杀进程。误报与漏报都不可避免，请把它当线索。
2. **「对外开放」只代表监听在非回环地址。** 是否真的能从外部访问，还取决于防火墙
   与上游网络。所以报告里会把同一次采集到的防火墙状态一并给出，由人判断
   —— 而不是替用户下「已被公网暴露」的结论。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import alerting, baseline, i18n, store
from .formatters import short_hostname

logger = logging.getLogger(__name__)

# 复用 baseline 的分节约定与探测工具：本机/远程两端同一套解析，少一份重复实现
SECTION_RE = baseline.SECTION_RE
_section = baseline._section
_read_text = baseline._read_text
_run = baseline._run
_which = baseline._which
_elevated = baseline._elevated
parse_probe_sections = baseline.parse_probe_sections
PROBE_TIMEOUT = baseline.PROBE_TIMEOUT

POLICY_KEY = "port_guard_policy"

# 人工处置记录：同一条发现确认过 / 忽略过 / 加白过之后，不该每次巡检都重新冒出来
DISPOSITION_KEY = "port_guard_dispositions"

# 三种处置的语义（决定书面上要说得清，别让「忽略」悄悄变成永久放行）：
#   ack       确认：人看过了、知晓，不再计入待处理与告警，但列表里仍可见、可撤销
#   ignore    忽略：在一段时间内不再提示，到期自动回到待处理
#   whitelist 加白：永久放行，会把规则写进策略（预期端口 / 进程白名单）
DISPOSITIONS = ("ack", "ignore", "whitelist")

# 「忽略」的默认时效：7 天。到期重新冒头，避免被人一按就永久消失
DEFAULT_IGNORE_DAYS = 7
MAX_IGNORE_DAYS = 365

# 每条处置留一句说明（谁认定的、为什么）
MAX_NOTE = 200
# 处置记录条数上限：这是一个「人工认定过的例外清单」，不该无限膨胀
MAX_DISPOSITIONS = 500

# 默认策略：开箱即用，但把「哪些端口是预期的」交给用户维护
DEFAULT_POLICY: Dict[str, Any] = {
    "enabled": True,
    "alert_open_ports": True,
    "alert_suspicious": True,
    "cooldown_minutes": 60,
    # 通知接收人（留空 = 第一个管理员）
    "notify_user": "",
    # 预期对外开放的端口：可写 "22"、"0.0.0.0:80"、"*:443"
    "expected_ports": ["22"],
    # 进程白名单（正则，匹配命令行即忽略）：用来压掉自己环境里的误报
    "process_whitelist": [],
}

# 常见「不该对公网开放」的服务端口：命中即抬高严重级别
SENSITIVE_PORTS: Dict[int, str] = {
    21: "FTP", 23: "Telnet", 25: "SMTP", 69: "TFTP", 111: "rpcbind",
    135: "MS RPC", 137: "NetBIOS", 138: "NetBIOS", 139: "NetBIOS", 445: "SMB",
    512: "rsh", 513: "rlogin", 514: "rsh/rexec",
    1433: "MSSQL", 1521: "Oracle", 2049: "NFS",
    2375: "Docker API（未加密）", 2376: "Docker API",
    3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC", 5901: "VNC",
    6379: "Redis", 6443: "Kubernetes API", 9200: "Elasticsearch", 9300: "Elasticsearch",
    10250: "Kubelet", 11211: "Memcached", 2181: "ZooKeeper", 27017: "MongoDB",
    27018: "MongoDB", 5601: "Kibana", 8888: "Jupyter", 873: "rsync",
}

# 明文 / 无认证的老协议：开放即高危
LEGACY_PORTS = frozenset({21, 23, 69, 111, 512, 513, 514, 2049})

# 命令行启发式：命中即产出一条信号（严重级别 + 给用户看的解释）
SUSPICIOUS_PATTERNS: Tuple[Tuple[str, str, str, str], ...] = (
    (
        "rebound_dev_tcp",
        r"/dev/(tcp|udp)/",
        "high",
        "命令行里出现 /dev/tcp：Bash 自带的网络重定向，是反弹 shell 的典型写法",
    ),
    (
        "rebound_nc_exec",
        r"\b(nc|ncat|netcat)\b[^\n]*(\s-e\s|\s--exec\b)",
        "high",
        "netcat 带 -e/--exec：把 shell 挂到网络连接上",
    ),
    (
        # 只在 shell 名之后紧跟自己的参数时才认（``bash -i``、``sh -ci``）；
        # 写成 ``sh -c "curl -i"`` 那种会被排除，否则误报太多。
        # 单凭 -i 证据不足，定为中危；配合「shell 持有对外连接」才升为高危。
        "rebound_shell_i",
        r"\b(bash|sh|zsh|dash|ksh|ash)\s+-[a-z]*i[a-z]*(\s|$)",
        "medium",
        "交互式 shell 进程：正常服务不会这么起，常见于反弹 shell",
    ),
    (
        "rebound_socat_exec",
        r"\bsocat\b[^\n]*\b(exec|system):",
        "high",
        "socat 把命令执行接到网络连接上",
    ),
    (
        "rebound_python",
        r"\bpython[0-9.]*\b[^\n]*\s-c\s[^\n]*\b(socket|dup2|pty\.spawn)\b",
        "high",
        "Python 单行脚本里出现 socket/dup2：反弹 shell 的经典实现",
    ),
    (
        "rebound_perl",
        r"\bperl\b[^\n]*\s-e\s[^\n]*\b(Socket|exec|system)\b",
        "high",
        "Perl 单行脚本里出现 Socket/exec",
    ),
    (
        "rebound_ruby",
        r"\bruby\b[^\n]*\s-rsocket\b",
        "high",
        "Ruby 单行脚本加载 socket",
    ),
    (
        "rebound_php",
        r"\bphp\b[^\n]*\s-r\s[^\n]*\b(fsockopen|proc_open|shell_exec|popen)\b",
        "high",
        "PHP 单行脚本里出现 fsockopen / 命令执行",
    ),
    (
        "rebound_openssl_pipe",
        r"openssl\s+s_client[^\n]*\|\s*(sh|bash)\b",
        "high",
        "openssl s_client 管道给 shell：加密的反弹 shell",
    ),
    (
        "rebound_fifo",
        r"\bmkfifo\b[^\n]*\bnc\b",
        "high",
        "mkfifo + nc 组合：命名管道反弹 shell",
    ),
    (
        "known_malware",
        r"\b(xmrig|lolminer|kdevtmpfsi|kinsing|kthreaddi|teamtnt|watchdogs|masscan|zmap)\b",
        "high",
        "命中已知挖矿 / 蠕虫 / 扫描器进程名",
    ),
    (
        "netcat_listen",
        r"\b(nc|ncat|netcat)\b[^\n]*\s-l",
        "medium",
        "netcat 处于监听模式：可能是后门监听",
    ),
    (
        "shell_c_remote",
        r"\b(bash|sh)\b[^\n]*\s-c\s[^\n]*(curl|wget)[^\n]*\|\s*(bash|sh)\b",
        "high",
        "curl/wget 管道给 shell：远程代码执行的常见手法",
    ),
)

SHELL_NAMES = frozenset({"bash", "sh", "dash", "zsh", "ksh", "ash", "busybox"})

# 「Web 服务派生 shell」只认真 Web 服务器。
# 刻意**不**包含 python / node / java / gunicorn 这类应用运行时：面板自己就是
# Python 起的，它调用外部命令（ss、sysctl、ps…）时父进程正是 python/gunicorn，
# 放进去会把面板自己的行为全报成可疑进程（实测一次误报 7 条）。
WEB_SERVER_NAMES = (
    "nginx", "apache2", "httpd", "php-fpm", "tomcat", "uwsgi", "caddy",
    "lighttpd", "iis",
)
# 可执行文件落在这些目录：临时/内存盘，正常服务不该从这儿跑
TMP_PREFIXES = ("/tmp/", "/dev/shm/", "/var/tmp/", "/run/shm/", "/run/user/")
# 常见后门 / C2 端口：连到这些端口的已建立连接值得看一眼
C2_PORTS = frozenset({4444, 4443, 1337, 31337, 5555, 9999, 1234, 6666, 6667, 8880, 1080})
# 内部 SSH / RDP 会话不算异常
BENIGN_REMOTE_PORTS = frozenset({22, 3389, 5985, 5986})

# 单机可疑进程最多列 50 条，避免被异常主机刷爆响应
MAX_SUSPICIOUS = 50


# --------------------------------------------------------------------- 解析

SS_RE = re.compile(
    r"^(?P<proto>tcp6?|udp6?)\s+(?P<state>[A-Z-]+)\s+\d+\s+\d+\s+"
    r"(?P<local>\S+)\s+(?P<peer>\S+)(?:\s+(?P<proc>users:\(\(.*\)\)))?\s*$"
)
NETSTAT_RE = re.compile(
    r"^(?P<proto>tcp6?|udp6?)\s+\d+\s+\d+\s+(?P<local>\S+)\s+(?P<peer>\S+)\s+"
    r"(?P<state>[A-Z-]+)\s*(?P<proc>\d+/\S+)?\s*$"
)
SS_PROC_RE = re.compile(r'\("(?P<name>[^"]+)",pid=(?P<pid>\d+)')
EXE_RE = re.compile(r"/proc/(?P<pid>\d+)/exe\s+->\s+(?P<target>.+?)\s*$")


def split_addr(value: str) -> Tuple[str, int]:
    """``"0.0.0.0:22"`` / ``"[::]:22"`` → ``("0.0.0.0", 22)``。"""
    text = (value or "").strip()
    if text.startswith("["):
        host, _, port = text.rpartition("]:")
        if port.isdigit():
            return host.lstrip("[") or "::", int(port)
    host, _, port = text.rpartition(":")
    if port.isdigit():
        return host or "0.0.0.0", int(port)
    return text, 0


def address_scope(address: str) -> str:
    """监听地址的暴露范围：loopback / all / specific。"""
    host = (address or "").strip().strip("[]")
    if not host:
        return "all"
    if host in ("*", "0.0.0.0", "::"):
        return "all"
    if host == "localhost" or host.startswith("127.") or host == "::1":
        return "loopback"
    # fe80:: 链路本地：只在同一链路内可达，不算对外
    if host.lower().startswith("fe80:"):
        return "loopback"
    return "specific"


def _proc_of(raw: Optional[str]) -> Tuple[str, Optional[int]]:
    """从 ``users:(("sshd",pid=1,fd=3))`` 或 ``1096/sshd`` 里取 (进程名, pid)。"""
    if not raw:
        return "", None
    match = SS_PROC_RE.search(raw)
    if match:
        return match.group("name"), int(match.group("pid"))
    if "/" in raw:
        pid_text, _, name = raw.partition("/")
        if pid_text.strip().isdigit():
            return name.strip(), int(pid_text)
    return "", None


def parse_listeners(text: str) -> List[Dict[str, Any]]:
    """解析 ``ss -tulpn``（首选）或 ``netstat -tulpn`` 的输出。"""
    entries: List[Dict[str, Any]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        # 只认以 tcp/udp 开头的行：ss 与 netstat 的数据行都长这样，
        # 表头（State / Proto / Active …）和分隔行因此自然被跳过
        if not line.startswith(("tcp", "udp")):
            continue
        match = SS_RE.match(line) or NETSTAT_RE.match(line)
        if not match:
            continue
        address, port = split_addr(match.group("local"))
        if not port:
            continue
        name, pid = _proc_of(match.group("proc"))
        entries.append(
            {
                "proto": match.group("proto")[:3],
                "state": match.group("state"),
                "address": address,
                "port": port,
                "scope": address_scope(address),
                "process": name,
                "pid": pid,
            }
        )
    return entries


def parse_connections(text: str) -> List[Dict[str, Any]]:
    """解析 ``ss -tnp`` 的已建立连接（供进程上下文用）。"""
    entries: List[Dict[str, Any]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line.startswith(("tcp", "udp")):
            continue
        match = SS_RE.match(line) or NETSTAT_RE.match(line)
        if not match or match.group("state") != "ESTAB":
            continue
        local_addr, local_port = split_addr(match.group("local"))
        peer_addr, peer_port = split_addr(match.group("peer"))
        name, pid = _proc_of(match.group("proc"))
        entries.append(
            {
                "pid": pid,
                "process": name,
                "local_address": local_addr,
                "local_port": local_port,
                "peer_address": peer_addr,
                "peer_port": peer_port,
                "peer_scope": address_scope(peer_addr),
            }
        )
    return entries


def parse_processes(text: str) -> List[Dict[str, Any]]:
    """解析 ``ps -eo pid=,ppid=,user=,etime=,comm=,args=``。

    ``args`` 放在最后且用 ``maxsplit`` 收尾，所以带空格的命令行不会被切碎。
    """
    entries: List[Dict[str, Any]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 5 or not parts[0].isdigit():
            continue
        pid, ppid, user, etime = parts[0], parts[1], parts[2], parts[3]
        comm = parts[4]
        args = parts[5] if len(parts) > 5 else comm
        entries.append(
            {
                "pid": int(pid),
                "ppid": int(ppid) if ppid.isdigit() else 0,
                "user": user,
                "etime": etime,
                "name": comm,
                "args": args,
            }
        )
    return entries


def parse_exe_links(text: str) -> Dict[int, Dict[str, Any]]:
    """解析 ``ls -l /proc/*/exe``：拿到真实可执行文件路径与「已删除」标记。"""
    result: Dict[int, Dict[str, Any]] = {}
    for raw in (text or "").splitlines():
        match = EXE_RE.search(raw)
        if not match:
            continue
        target = match.group("target").strip()
        deleted = target.endswith("(deleted)")
        if deleted:
            target = target[: -len("(deleted)")].strip()
        result[int(match.group("pid"))] = {"exe": target, "deleted": deleted}
    return result


# --------------------------------------------------------------------- 策略

def normalise_policy(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """把任意输入收敛成合法策略（坏值回落默认，不让脏数据把检测搞崩）。"""
    data = dict(DEFAULT_POLICY)
    if not isinstance(raw, dict):
        return data
    for key in ("enabled", "alert_open_ports", "alert_suspicious"):
        if key in raw:
            data[key] = bool(raw[key])
    try:
        minutes = int(raw.get("cooldown_minutes", data["cooldown_minutes"]))
    except (TypeError, ValueError):
        minutes = data["cooldown_minutes"]
    data["cooldown_minutes"] = max(1, min(1440, minutes))
    data["notify_user"] = str(raw.get("notify_user") or "")[:64]
    expected = raw.get("expected_ports")
    if isinstance(expected, list):
        data["expected_ports"] = [str(item).strip() for item in expected if str(item).strip()][:200]
    whitelist = raw.get("process_whitelist")
    if isinstance(whitelist, list):
        cleaned: List[str] = []
        for item in whitelist:
            text = str(item).strip()
            if not text:
                continue
            try:  # 非法正则直接丢掉，避免后面每次检测都炸
                re.compile(text)
            except re.error:
                continue
            cleaned.append(text)
        data["process_whitelist"] = cleaned[:100]
    return data


async def load_policy() -> Dict[str, Any]:
    try:
        raw = await store.get_setting(POLICY_KEY)
    except Exception:  # noqa: BLE001 - 读策略失败就用默认值，别让页面打不开
        logger.exception("读取端口巡检策略失败")
        return dict(DEFAULT_POLICY)
    if not raw:
        return dict(DEFAULT_POLICY)
    import json

    try:
        return normalise_policy(json.loads(raw))
    except (TypeError, ValueError):
        return dict(DEFAULT_POLICY)


async def save_policy(raw: Dict[str, Any]) -> Dict[str, Any]:
    import json

    policy = normalise_policy(raw)
    await store.set_setting(POLICY_KEY, json.dumps(policy, ensure_ascii=False))
    return policy


# ------------------------------------------------------------- 人工处置

def port_fingerprint(item: Dict[str, Any]) -> str:
    """一条「非预期开放端口」的指纹：就看端口号。

    地址不进指纹：同一个服务换绑地址（``0.0.0.0`` ↔ 具体网卡 IP）仍是同一件事，
    按端口忽略才符合「这个端口我认了」的直觉。
    """
    return "port:{}".format(int(item.get("port") or 0))


def process_fingerprint(proc: Dict[str, Any], signals: List[Dict[str, Any]]) -> str:
    """一条「可疑进程」的指纹：程序名 + 可执行文件 + 命中的规则。

    PID 每次启动都变，不能拿来当标识 —— 否则忽略一次、重启后又冒出来。
    """
    codes = ",".join(sorted(str(item.get("code") or "") for item in signals))
    return "proc:{}|{}|{}".format(
        str(proc.get("name") or ""), str(proc.get("exe") or ""), codes
    )


def _whitelist_pattern(detail: Dict[str, Any]) -> str:
    """把一条发现转成「进程白名单」可用的正则。

    命令行里出现的多半是程序名（``bash -i``），不是完整路径，所以优先用
    程序名做词边界匹配；没有名字时退回可执行文件名的基名。
    """
    name = str(detail.get("name") or "").strip()
    if not name:
        exe = str(detail.get("exe") or "").strip()
        name = os.path.basename(exe) if exe else ""
    if not name:
        return ""
    return r"\b" + re.escape(name) + r"\b"


async def load_dispositions() -> Dict[str, Dict[str, Any]]:
    """全部主机的处置记录：``{host_id: {fingerprint: 决定书}}``。

    一次读全表：巡检是「一台主机一次」或「全平台并发」，按 host_id 取即可，
    不必每条主机各读一次。过期的「忽略」在这里就被丢掉 —— 到期应该重新
    出现在待处理里，而不是靠定时任务去清理。
    """
    import json

    try:
        raw = await store.get_setting(DISPOSITION_KEY)
        data = json.loads(raw) if raw else {}
    except Exception:  # noqa: BLE001 - 读不出来就当没有处置，不影响巡检
        logger.exception("读取端口处置记录失败")
        return {}
    if not isinstance(data, dict):
        return {}

    now = int(time.time())
    result: Dict[str, Dict[str, Any]] = {}
    for host_id, scoped in data.items():
        if not isinstance(scoped, dict):
            continue
        kept: Dict[str, Any] = {}
        for key, item in scoped.items():
            if not isinstance(item, dict):
                continue
            expires = item.get("expires_at")
            if isinstance(expires, (int, float)) and expires and expires <= now:
                continue
            kept[str(key)] = item
        if kept:
            result[str(host_id)] = kept
    return result


async def apply_disposition(
    host_id: str,
    key: str,
    action: str,
    actor: str = "",
    note: str = "",
    ttl_days: Optional[int] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """记下一条处置；``whitelist`` 会顺带把规则写进策略。

    返回更新后的策略，便于接口直接回给前端（省一次再读）。
    """
    import json

    if action not in DISPOSITIONS:
        raise ValueError(f"不支持的处置方式：{action}")

    policy = await load_policy()
    if action == "whitelist":
        detail = detail or {}
        if key.startswith("port:"):
            port = key.split(":", 1)[1]
            expected = list(policy.get("expected_ports") or [])
            if port not in expected:
                expected.append(port)
            policy["expected_ports"] = expected[:200]
        else:
            pattern = _whitelist_pattern(detail)
            if not pattern:
                raise ValueError("这条发现没有可用于加白的程序名")
            rules = list(policy.get("process_whitelist") or [])
            if pattern not in rules:
                rules.append(pattern)
            policy["process_whitelist"] = rules[:100]
        await save_policy(policy)

    now = int(time.time())
    expires_at = None
    if action == "ignore":
        days = DEFAULT_IGNORE_DAYS if ttl_days is None else int(ttl_days)
        days = max(1, min(MAX_IGNORE_DAYS, days))
        expires_at = now + days * 86400

    record: Dict[str, Any] = {
        "action": action,
        "actor": str(actor or "")[:64],
        "ts": now,
        "expires_at": expires_at,
        "note": str(note or "")[:MAX_NOTE],
        # 存一份快照：处置列表要给「当时忽略的是什么」一个说得清的名字
        "label": str((detail or {}).get("label") or "")[:120],
        "kind": "port" if key.startswith("port:") else "process",
    }

    data = await load_dispositions()
    scoped = dict(data.get(host_id) or {})
    scoped[str(key)] = record
    # 超出上限时丢最旧的：这是一个人工认定的例外清单，不该无限膨胀
    if len(scoped) > MAX_DISPOSITIONS:
        for stale in sorted(scoped, key=lambda k: scoped[k].get("ts") or 0)[
            : len(scoped) - MAX_DISPOSITIONS
        ]:
            scoped.pop(stale, None)
    data[str(host_id)] = scoped

    await store.set_setting(
        DISPOSITION_KEY, json.dumps(data, ensure_ascii=False)
    )
    return {"record": record, "policy": policy}


async def clear_disposition(host_id: str, key: str) -> bool:
    """撤销一条处置（下一轮巡检它就会重新出现在待处理里）。"""
    import json

    data = await load_dispositions()
    scoped = dict(data.get(host_id) or {})
    existed = str(key) in scoped
    if not existed:
        return False
    scoped.pop(str(key), None)
    if scoped:
        data[str(host_id)] = scoped
    else:
        data.pop(str(host_id), None)
    await store.set_setting(DISPOSITION_KEY, json.dumps(data, ensure_ascii=False))
    return True


def port_is_expected(port: int, address: str, expected: Iterable[str]) -> bool:
    """期望端口既支持只写端口号，也支持 ``addr:port`` / ``*:port``。"""
    for item in expected:
        rule = str(item).strip()
        if not rule:
            continue
        if rule.isdigit() and int(rule) == port:
            return True
        host, _, rule_port = rule.rpartition(":")
        if rule_port.isdigit() and int(rule_port) == port:
            host = host.strip()
            if host in ("*", "", address):
                return True
    return False


# --------------------------------------------------------------------- 采集

def port_probe_command(sudo: str = "") -> str:
    """一条只读单行命令，把端口/进程检测所需的原始数据分节打印回来。

    与 baseline 的探测命令同理：合并成一条是为了把 N 次 SSH 往返压成 1 次。
    ``fw-*`` 分节的名字刻意与 baseline 保持一致，这样防火墙判定可以直接复用。
    """
    s = sudo
    steps = [
        _section("uid"), "id -u 2>/dev/null",
        _section("hostname"), "hostname 2>/dev/null",
        _section("kernel"), "uname -r 2>/dev/null",
        _section("os-release"), "cat /etc/os-release 2>/dev/null",
        # 监听端口：ss 优先，老系统退回 netstat（两者解析器都实现了）
        _section("ss-listen"),
        f"{{ {s}ss -tulpnH 2>/dev/null || {s}netstat -tulpn 2>/dev/null; }}",
        _section("ss-conn"), f"{s}ss -tnpH 2>/dev/null",
        # 进程表：args 放最后，带空格的命令行不会被切碎
        _section("ps"), "ps -eo pid=,ppid=,user=,etime=,comm=,args= 2>/dev/null",
        # /proc/*/exe：真实可执行文件路径 + 「(deleted)」标记（需要 root）
        _section("exe"), "ls -l /proc/[0-9]*/exe 2>/dev/null",
        _section("fw-units"),
        "systemctl is-active firewalld ufw nftables pve-firewall 2>/dev/null",
        _section("fw-ufw"),
        f"command -v ufw >/dev/null 2>&1 && {s}ufw status 2>/dev/null",
        _section("fw-cmd"),
        "command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null",
        _section("end"),
    ]
    return "; ".join(steps)


def _local_listeners() -> str:
    """监听端口：``ss`` 优先，老系统退回 ``netstat``（两个解析器都实现了）。"""
    if _which("ss"):
        ok, output = _run(["ss", "-tulpnH"], timeout=10)
        if ok and output.strip():
            return output
    if _which("netstat"):
        _ok, output = _run(["netstat", "-tulpn"], timeout=10)
        return output
    return ""


def _local_exe_links() -> Dict[int, Dict[str, Any]]:
    """本机 /proc/*/exe → 真实可执行文件路径与「已删除」标记。"""
    links: Dict[int, Dict[str, Any]] = {}
    try:
        entries = [name for name in os.listdir("/proc") if name.isdigit()]
    except OSError:  # pragma: no cover - 非 /proc 环境
        return links
    for name in entries:
        try:
            target = os.readlink(f"/proc/{name}/exe")
        except OSError:
            continue
        deleted = target.endswith(" (deleted)")
        if deleted:
            target = target[: -len(" (deleted)")]
        links[int(name)] = {"exe": target, "deleted": deleted}
    return links


def local_snapshot() -> Dict[str, Any]:
    """本机快照。与 :func:`remote_snapshot` 结构一致，喂给同一个 ``assess()``。"""
    elevated = _elevated()
    _ok_conn, connections = _run(["ss", "-tnpH"], timeout=10) if _which("ss") else (False, "")
    _ok_ps, processes = _run(
        ["ps", "-eo", "pid=,ppid=,user=,etime=,comm=,args="], timeout=10
    )
    return {
        "elevated": elevated,
        "listeners": parse_listeners(_local_listeners()),
        "connections": parse_connections(connections),
        "processes": parse_processes(processes),
        "exe": _local_exe_links(),
        "firewall": baseline.parse_firewall_probe(
            {
                "fw-units": _unit_states(),
                "fw-ufw": _text_of(["ufw", "status"]),
                "fw-cmd": _text_of(["firewall-cmd", "--state"]),
            },
            elevated,
        ),
        "hostname": short_hostname(),
        "kernel": os.uname().release if hasattr(os, "uname") else "",
        "os_release": _read_text("/etc/os-release") or "",
    }


def _unit_states() -> str:
    if not _which("systemctl"):
        return ""
    _ok, output = _run(["systemctl", "is-active", *baseline.FW_UNITS], timeout=6)
    return output.strip()


def _text_of(command: List[str]) -> str:
    if not _which(command[0]):
        return ""
    _ok, output = _run(command, timeout=8)
    return output.strip()


def remote_snapshot(row: Dict[str, Any], output: str) -> Dict[str, Any]:
    """远程分节输出 → 与本机同构的快照。"""
    sections = parse_probe_sections(output)
    uid = (sections.get("uid") or "").strip()
    # 能看到别人进程的可执行文件路径，就说明有 root / sudo
    exe = parse_exe_links(sections.get("exe") or "")
    elevated = uid == "0" or bool(exe)
    return {
        "elevated": elevated,
        "listeners": parse_listeners(sections.get("ss-listen") or ""),
        "connections": parse_connections(sections.get("ss-conn") or ""),
        "processes": parse_processes(sections.get("ps") or ""),
        "exe": exe,
        "firewall": baseline.parse_firewall_probe(sections, elevated),
        "hostname": (sections.get("hostname") or "").strip(),
        "kernel": (sections.get("kernel") or "").strip(),
        "os_release": sections.get("os-release") or "",
    }


# --------------------------------------------------------------- 判定（纯函数）

def _signals_for_process(
    proc: Dict[str, Any],
    exe_info: Dict[str, Any],
    owned_connections: List[Dict[str, Any]],
    parent: Optional[Dict[str, Any]],
) -> List[Dict[str, str]]:
    """给单个进程算出命中的信号。每条都带可读解释，便于人工判断。"""
    signals: List[Dict[str, str]] = []
    args = str(proc.get("args") or "")
    name = str(proc.get("name") or "")
    name_lower = name.lower()

    for code, pattern, severity, label in SUSPICIOUS_PATTERNS:
        if re.search(pattern, args, re.IGNORECASE):
            signals.append(
                {"code": code, "severity": severity, "label": i18n.tr(label)}
            )

    exe_path = str(exe_info.get("exe") or "")
    has_external = any(
        conn["peer_scope"] != "loopback" for conn in owned_connections
    )
    if exe_info.get("deleted"):
        signals.append(
            {
                "code": "deleted_exe",
                "severity": "high" if has_external else "medium",
                "label": i18n.pick(
                    f"可执行文件已被删除（{exe_path or '未知'}）：常见于「跑起来就删掉自己」的恶意程序",
                    f"Its executable was deleted ({exe_path or 'unknown'}): typical of "
                    "malware that removes itself once running",
                ),
            }
        )
    if exe_path and exe_path.startswith(TMP_PREFIXES):
        signals.append(
            {
                "code": "tmp_exe",
                "severity": "high" if has_external else "medium",
                "label": i18n.pick(
                    f"可执行文件位于临时目录（{exe_path}）：正常服务不该从 /tmp、/dev/shm 里启动",
                    f"Its executable lives in a temp directory ({exe_path}): no "
                    "legitimate service starts from /tmp or /dev/shm",
                ),
            }
        )

    # shell 持有对外连接：正常登录会话的连接本地端口是 22（服务端），排除掉
    if name_lower in SHELL_NAMES:
        for conn in owned_connections:
            if conn["peer_scope"] == "loopback":
                continue
            if conn["local_port"] in BENIGN_REMOTE_PORTS:
                continue
            signals.append(
                {
                    "code": "shell_with_external_conn",
                    "severity": "high",
                    "label": i18n.pick(
                        f"shell 进程持有对外连接 {conn['local_address']}:{conn['local_port']}"
                        f" → {conn['peer_address']}:{conn['peer_port']}：典型的反弹 shell",
                        f"A shell holds an outbound connection "
                        f"{conn['local_address']}:{conn['local_port']} → "
                        f"{conn['peer_address']}:{conn['peer_port']}: a classic "
                        "reverse shell",
                    ),
                }
            )
            break

    if parent is not None:
        parent_name = str(parent.get("name") or "").lower()
        if name_lower in SHELL_NAMES and any(
            parent_name.startswith(item) for item in WEB_SERVER_NAMES
        ):
            signals.append(
                {
                    "code": "web_child_shell",
                    "severity": "high",
                    "label": i18n.pick(
                        f"父进程是 Web 服务（{parent.get('name')}）：Web 漏洞利用后落 shell 的特征",
                        f"Its parent is a web service ({parent.get('name')}): the "
                        "signature of a shell dropped by exploiting a web flaw",
                    ),
                }
            )

    for conn in owned_connections:
        if conn["peer_scope"] != "loopback" and conn["peer_port"] in C2_PORTS:
            signals.append(
                {
                    "code": "c2_port",
                    "severity": "medium",
                    "label": i18n.pick(
                        f"连接到常见后门/远控端口 {conn['peer_port']}（对端 {conn['peer_address']}）",
                        f"Connected to common backdoor / C2 port {conn['peer_port']} "
                        f"(peer {conn['peer_address']})",
                    ),
                }
            )
            break

    return signals


def assess(
    snapshot: Dict[str, Any],
    policy: Optional[Dict[str, Any]] = None,
    dispositions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """快照 → 端口与进程的判定结果。纯函数，本机与远程共用。

    ``dispositions`` 是该主机的人工处置记录（``{指纹: 决定书}``）：命中了就把
    ``disposition`` 挂到条目上。处置过的条目**仍然返回**——否则用户无从撤销，
    只是不再计入「待处理」的计数，也不再进告警。
    """
    rule = policy or DEFAULT_POLICY
    expected = rule.get("expected_ports") or []
    whitelist = rule.get("process_whitelist") or []
    elevated = bool(snapshot.get("elevated"))
    dispositions = dispositions or {}

    listeners = list(snapshot.get("listeners") or [])
    for item in listeners:
        item["exposed"] = item["scope"] in ("all", "specific")
        item["sensitive"] = item["port"] in SENSITIVE_PORTS
        item["expected"] = port_is_expected(item["port"], item["address"], expected)
        item["fingerprint"] = port_fingerprint(item)
        item["disposition"] = dispositions.get(item["fingerprint"])

    exposed = [item for item in listeners if item["exposed"]]
    unexpected = [
        item for item in exposed if not item["expected"] and not item["disposition"]
    ]

    proc_by_pid = {proc["pid"]: proc for proc in (snapshot.get("processes") or [])}
    conns_by_pid: Dict[int, List[Dict[str, Any]]] = {}
    for conn in snapshot.get("connections") or []:
        if conn.get("pid"):
            conns_by_pid.setdefault(int(conn["pid"]), []).append(conn)

    suspicious: List[Dict[str, Any]] = []
    for proc in proc_by_pid.values():
        if any(re.search(item, proc["args"]) for item in whitelist):
            continue
        exe_path = (snapshot.get("exe") or {}).get(proc["pid"], {}).get("exe", "")
        signals = _signals_for_process(
            proc,
            (snapshot.get("exe") or {}).get(proc["pid"], {}),
            conns_by_pid.get(proc["pid"], []),
            proc_by_pid.get(proc["ppid"]),
        )
        if not signals:
            continue
        severity = "high" if any(s["severity"] == "high" for s in signals) else (
            "medium" if any(s["severity"] == "medium" for s in signals) else "low"
        )
        fingerprint = process_fingerprint({**proc, "exe": exe_path}, signals)
        suspicious.append(
            {
                "pid": proc["pid"],
                "ppid": proc["ppid"],
                "user": proc["user"],
                "name": proc["name"],
                "args": proc["args"][:500],
                "etime": proc["etime"],
                "exe": exe_path,
                "severity": severity,
                "signals": signals,
                # 指纹与处置：前端靠 fingerprint 调「确认 / 忽略 / 加白」
                "fingerprint": fingerprint,
                "disposition": dispositions.get(fingerprint),
                "connections": [
                    {
                        "local": f"{c['local_address']}:{c['local_port']}",
                        "peer": f"{c['peer_address']}:{c['peer_port']}",
                    }
                    for c in conns_by_pid.get(proc["pid"], [])
                    if c["peer_scope"] != "loopback"
                ][:5],
            }
        )

    rank = {"high": 0, "medium": 1, "low": 2}
    # 处置过的排到末尾：它们还在列表里（可撤销），但不该抢「待处理」的位置
    suspicious.sort(
        key=lambda item: (
            1 if item.get("disposition") else 0,
            rank.get(item["severity"], 3),
            -item["pid"],
        )
    )
    suspicious = suspicious[:MAX_SUSPICIOUS]
    pending = [item for item in suspicious if not item.get("disposition")]

    # 对外开放且无法归因到进程的监听：说明没权限看别人的进程，不算问题，只做提示
    unattributed = [item for item in exposed if not item["process"] and elevated]

    firewall = snapshot.get("firewall") or {}
    exposed_ports = sorted({item["port"] for item in unexpected})

    return {
        "listeners": listeners,
        "exposed": exposed,
        "unexpected": unexpected,
        "suspicious": suspicious,
        "firewall": firewall,
        "summary": {
            "listeners": len(listeners),
            "exposed": len(exposed),
            "unexpected": len(unexpected),
            "unexpected_ports": exposed_ports,
            # 计数只算「待处理」：处置过的不再计入 KPI，也不再触发告警
            "suspicious": len(pending),
            "highest": pending[0]["severity"] if pending else "",
            "unattributed": len(unattributed),
            "disposed": sum(1 for item in listeners if item.get("disposition"))
            + sum(1 for item in suspicious if item.get("disposition")),
            # 没有活动防火墙时，「监听在 0.0.0.0」的风险明显更高，页面据此提示
            "firewall_active": bool(firewall.get("active")),
        },
    }


def port_severity(item: Dict[str, Any], firewall_active: bool) -> str:
    """对外开放端口的严重级别：敏感端口 + 无防火墙时最高。"""
    if item["port"] in LEGACY_PORTS:
        return "high"
    if item["port"] in SENSITIVE_PORTS:
        return "high" if not firewall_active else "medium"
    return "low" if firewall_active else "medium"


# --------------------------------------------------------------- 报告与聚合

def _empty_summary() -> Dict[str, Any]:
    return {
        "listeners": 0, "exposed": 0, "unexpected": 0, "unexpected_ports": [],
        "suspicious": 0, "highest": "", "unattributed": 0, "firewall_active": False,
        "disposed": 0,
    }


def _collect_sync(
    policy: Dict[str, Any], dispositions: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    snapshot = local_snapshot()
    hostname = short_hostname(snapshot.get("hostname")) or short_hostname() or "local"
    report = assess(snapshot, policy, dispositions)
    report.update(
        {
            "host_id": "local",
            "local": True,
            "name": hostname,
            "host": hostname,
            "address": "localhost",
            "checked_at": int(time.time()),
            "ok": True,
            "error": "",
            "elevated": bool(snapshot.get("elevated")),
            "os": baseline.os_info(snapshot),
        }
    )
    return report


async def collect(policy: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """巡检本机（只读）。"""
    rule = policy or await load_policy()
    dispositions = (await load_dispositions()).get("local") or {}
    return await asyncio.to_thread(_collect_sync, rule, dispositions)


def _remote_error_report(row: Dict[str, Any], error: str) -> Dict[str, Any]:
    return {
        "host_id": str(row.get("id") or ""),
        "local": False,
        "name": str(row.get("name") or row.get("host") or ""),
        "host": str(row.get("host") or ""),
        "address": str(row.get("host") or ""),
        "checked_at": int(time.time()),
        "ok": False,
        "error": error[:300],
        "elevated": False,
        "os": {},
        "listeners": [],
        "exposed": [],
        "unexpected": [],
        "suspicious": [],
        "firewall": {},
        "summary": _empty_summary(),
    }


async def collect_remote(
    row: Dict[str, Any],
    policy: Dict[str, Any],
    dispositions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """巡检一台受管主机。失败降级成 ok=False，不抛给调用方。"""
    remote = baseline._sshremote()
    try:
        _ok, output = await remote.run_command(
            row, port_probe_command(remote._sudo_prefix(row)), timeout=PROBE_TIMEOUT
        )
        if not parse_probe_sections(output):
            raise RuntimeError(output.strip()[:200] or "远程命令没有返回任何数据")
        snapshot = remote_snapshot(row, output)
    except Exception as exc:  # noqa: BLE001 - 单机失败不能拖垮整页
        logger.warning("远程端口巡检失败 %s：%s", row.get("host"), exc)
        return _remote_error_report(row, str(exc))

    report = assess(snapshot, policy, dispositions)
    hostname = short_hostname(snapshot.get("hostname")) or short_hostname(
        str(row.get("host") or "")
    )
    report.update(
        {
            "host_id": str(row.get("id") or ""),
            "local": False,
            "name": str(row.get("name") or hostname),
            "host": hostname,
            "address": str(row.get("host") or ""),
            "checked_at": int(time.time()),
            "ok": True,
            "error": "",
            "elevated": bool(snapshot.get("elevated")),
            "os": baseline.os_info(snapshot),
        }
    )
    return report


async def collect_host(
    host_id: str, policy: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """巡检单台主机（``local`` 或受管主机 id）。"""
    rule = policy or await load_policy()
    if host_id in ("", "local"):
        return await collect(rule)
    row = await baseline._sshremote().get_host(host_id)
    if not row:
        raise LookupError(f"受管主机 {host_id} 不存在")
    dispositions = (await load_dispositions()).get(str(row.get("id") or "")) or {}
    return await collect_remote(row, rule, dispositions)


async def fleet_reports(
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """并发巡检全部目标主机（本机 + 受管主机）。"""
    from .pve import parallel

    policy = await load_policy()
    dispositions = await load_dispositions()
    # 必须用 `is not None` 而不是真值判断：空集合表示「一台都不可见」（刚授权、
    # 还没添加主机），用真值判断会把它当成 None = 不限，普通用户于是能看到
    # 全部主机与面板本机。targets() / hostaudit 用的都是下面这种写法。
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    rows = await baseline.managed_hosts()
    if wanted is not None:
        rows = [row for row in rows if row["id"] in wanted]
    include_local = wanted is None or "local" in wanted

    results = (
        await parallel(
            [
                collect_remote(row, policy, dispositions.get(str(row["id"])) or {})
                for row in rows
            ],
            limit=8,
        )
        if rows
        else []
    )

    reports: List[Dict[str, Any]] = []
    if include_local:
        reports.append(await collect(policy))
    for row, item in zip(rows, results):
        if isinstance(item, BaseException):  # parallel 把异常原样返回
            reports.append(_remote_error_report(row, str(item)))
        else:
            reports.append(item)
    return reports


def compact_report(report: Dict[str, Any]) -> Dict[str, Any]:
    """总览用的一台主机摘要（不带完整端口表，响应体小很多）。"""
    return {
        "host_id": report.get("host_id"),
        "name": report.get("name"),
        "host": report.get("host"),
        "local": bool(report.get("local")),
        "ok": bool(report.get("ok")),
        "error": report.get("error") or "",
        "elevated": bool(report.get("elevated")),
        "os": report.get("os") or {},
        "summary": report.get("summary") or _empty_summary(),
        # 只带最要紧的几条端口，供卡片上列出
        "top_ports": [
            {
                "port": item["port"],
                "proto": item["proto"],
                "address": item["address"],
                "process": item["process"],
                "sensitive": item["sensitive"],
                "severity": port_severity(
                    item, bool((report.get("firewall") or {}).get("active"))
                ),
            }
            for item in sorted(
                report.get("unexpected") or [],
                key=lambda i: (
                    port_severity(i, bool((report.get("firewall") or {}).get("active"))),
                    i["port"],
                ),
            )[:6]
        ],
        # 处置过的（已确认 / 已忽略 / 已加白）不进「最要紧的几条」
        "top_suspicious": [
            {
                "pid": item["pid"],
                "name": item["name"],
                "user": item["user"],
                "severity": item["severity"],
                "labels": [s["label"] for s in item["signals"]][:2],
            }
            for item in [
                row
                for row in (report.get("suspicious") or [])
                if not row.get("disposition")
            ][:4]
        ],
        "firewall": {
            "active": bool((report.get("firewall") or {}).get("active")),
            "manager": (report.get("firewall") or {}).get("manager") or "",
        },
    }


def _attention_rank(host: Dict[str, Any]) -> int:
    """排序：可疑进程 → 非预期开放端口 → 不可达 → 干净。"""
    if not host.get("ok"):
        return 2
    summary = host.get("summary") or {}
    if summary.get("suspicious"):
        return 0
    if summary.get("unexpected"):
        return 1
    return 3


async def fleet_overview(
    host_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """全平台端口/进程总览，最需要看的排最前。"""
    hosts = [compact_report(report) for report in await fleet_reports(host_ids)]
    hosts.sort(key=lambda h: (_attention_rank(h), -(h.get("summary") or {}).get("suspicious", 0)))

    reachable = [h for h in hosts if h["ok"]]
    totals = {
        "hosts": len(hosts),
        "reachable": len(reachable),
        "unreachable": len(hosts) - len(reachable),
        "exposed": sum((h["summary"] or {}).get("exposed", 0) for h in reachable),
        "unexpected": sum((h["summary"] or {}).get("unexpected", 0) for h in reachable),
        "suspicious": sum((h["summary"] or {}).get("suspicious", 0) for h in reachable),
        "no_firewall": sum(
            1 for h in reachable if not (h["summary"] or {}).get("firewall_active")
        ),
    }
    return {"hosts": hosts, "totals": totals, "generated_at": int(time.time())}


# --------------------------------------------------------------- 联动告警

def _finding_text(report: Dict[str, Any], kind: str, limit: int = 6) -> str:
    firewall = report.get("firewall") or {}
    host = report.get("name") or report.get("host_id")
    if kind == "ports":
        rows = sorted(
            report.get("unexpected") or [],
            key=lambda i: (port_severity(i, bool(firewall.get("active"))), i["port"]),
        )[:limit]
        lines = [
            f"· {item['address']}:{item['port']}/{item['proto']}"
            + i18n.pick("（", " (")
            + str(item["process"] or i18n.tr("未知进程"))
            + i18n.pick("）", ")")
            + (
                i18n.pick(" — 敏感服务：", " — sensitive service: ")
                + str(SENSITIVE_PORTS[item["port"]])
                if item["port"] in SENSITIVE_PORTS
                else ""
            )
            for item in rows
        ]
        head = i18n.pick(
            f"{host} 上有 {report['summary']['unexpected']} 个非预期对外开放端口",
            f"{host} has {report['summary']['unexpected']} unexpected "
            "externally exposed port(s)",
        )
        if not firewall.get("active"):
            head += i18n.pick(
                "，**且这台主机没有活动防火墙**",
                ", **and this host has no active firewall**",
            )
        return head + "\n" + "\n".join(lines)
    # 处置过的不进告警：人已经看过了，再推一遍等于把「忽略」按钮作废
    rows = [
        item
        for item in (report.get("suspicious") or [])
        if not item.get("disposition")
    ][:limit]
    lines = [
        f"· [PID {item['pid']}] {item['name']}"
        + i18n.pick("（", " (")
        + str(item["user"])
        + i18n.pick("）", ")")
        + i18n.pick("；", "; ").join(
            i18n.tr(str(s["label"])) for s in item["signals"][:2]
        )
        for item in rows
    ]
    return (
        i18n.pick(
            f"{host} 上发现 {report['summary']['suspicious']} 个可疑进程",
            f"{host} has {report['summary']['suspicious']} suspicious process(es)",
        )
        + "\n"
        + "\n".join(lines)
    )


def _card(
    report: Dict[str, Any], kind: str, kind_name: str, kind_name_en: str, at: float
):
    """告警卡片。

    没有复用 ``alerting.build_alert_card``：那张卡片是按「百分比阈值」设计的
    （会显示「当前值 3.0%」），而这里统计的是「几个端口 / 几个进程」，套上去
    反而误导。直接用底层的 ``build_card`` 拼一张说人话的。

    ``kind_name`` 是系统内的标识（会进 ``alarm_key``，所以**不能**随语言变），
    ``kind_name_en`` 只用于给英文收件人看的文案。
    """
    summary = report["summary"]
    firewall = report.get("firewall") or {}
    host_label = report.get("name") or report.get("host_id")
    is_ports = kind == "ports"
    count = summary["unexpected"] if is_ports else summary["suspicious"]
    fields: List[Tuple[str, str]] = [
        (
            i18n.tr("主机"),
            f"{host_label}"
            + i18n.pick("（", " (")
            + str(report.get("address") or "-")
            + i18n.pick("）", ")"),
        ),
        (
            i18n.tr("系统"),
            str((report.get("os") or {}).get("distribution") or i18n.tr("未获取")),
        ),
        (
            i18n.tr("非预期开放端口") if is_ports else i18n.tr("可疑进程"),
            f"**{count}**" + i18n.pick(" 个", ""),
        ),
        (
            i18n.tr("主机防火墙"),
            str(firewall.get("manager") or i18n.tr("未检测到"))
            if firewall.get("active")
            else "**" + i18n.tr("未启用") + "**",
        ),
    ]
    # 严重程度：可疑进程一定算严重；端口只有「没有防火墙兜底」时才升级为严重
    critical = (not is_ports) or (not firewall.get("active"))
    detail = _finding_text(report, kind, limit=5)
    note = i18n.pick(
        f"触发时间 {alerting._now_text(at)} · 这是启发式判断，请登录主机人工确认",
        f"Triggered at {alerting._now_text(at)} · this is a heuristic result; "
        "sign in to the host and confirm it manually",
    ) + (
        ""
        if is_ports
        else i18n.pick(
            "；面板不会自动处置进程",
            "; the panel never handles processes automatically",
        )
    )
    return alerting.build_card(
        "critical" if critical else "warning",
        ("🔴 " if critical else "🟠 ") + i18n.tr("ProxCenter 端口/进程告警"),
        i18n.pick(f"主机{kind_name}异常", f"Host abnormal: {kind_name_en}"),
        fields + [(i18n.tr("明细"), detail)],
        note,
    )


async def evaluate(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """巡检全部主机并把异常推给用户；``owner=None`` 表示发给策略指定的接收人。

    写法照抄 :func:`app.sshguard.evaluate`：自建 rule_id、自己判冷却、复用告警的
    去重 / 飞书邮件 / 恢复通知，因此**不需要**往告警规则表里加新指标。
    ``owner`` 参数只为对齐 ``alerting.evaluate`` 的调用方式，端口是主机级的，
    没有「按用户隔离」的概念，传进来的用户名会被忽略。
    """
    policy = await load_policy()
    if not policy.get("enabled"):
        return []

    reports = await fleet_reports()
    reachable = [r for r in reports if r.get("ok")]

    target_owner = policy.get("notify_user") or await store.first_admin_username() or ""
    # 按收件人的语言渲染（巡检是后台跑的，没有请求上下文，见 alerting.resolve_language）
    i18n.pin_language(await alerting.resolve_language(target_owner))
    feishu = await alerting.load_feishu(target_owner)
    email_cfg = await alerting.load_alert_email(target_owner)
    cooldown = int(policy["cooldown_minutes"]) * 60
    now = time.time()

    active = await alerting.load_active()
    active = {
        key: row for key, row in active.items() if str(row.get("target_type")) == "host"
    }
    still_alarming: set = set()
    fired: List[Dict[str, Any]] = []

    checks = (
        ("ports", "对外开放端口", "open ports", "port-open", "port_exposure", bool(policy.get("alert_open_ports"))),
        ("susp", "可疑进程", "suspicious processes", "port-susp", "susp_process", bool(policy.get("alert_suspicious"))),
    )

    for report in reachable:
        summary = report["summary"]
        for kind, kind_name, kind_name_en, rule_id, metric, enabled in checks:
            if not enabled:
                continue
            value = summary["unexpected"] if kind == "ports" else summary["suspicious"]
            label = f"{report.get('name') or report.get('host_id')}·{kind_name}"
            key = alerting.alarm_key(target_owner, rule_id, label)
            if not value:
                continue
            still_alarming.add(key)
            # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
            prev = active.get(key) or {}
            last = float(prev.get("ts") or 0)
            if now - last < cooldown:
                continue
            host_label = report.get("name") or report.get("host_id")
            text = _finding_text(report, kind)
            ok, detail = await alerting.dispatch(
                target_owner,
                feishu,
                email_cfg,
                i18n.pick(
                    f"端口/进程异常：{host_label}（{kind_name}）",
                    f"Port/process anomaly: {host_label} ({kind_name_en})",
                ),
                text,
                _card(report, kind, kind_name, kind_name_en, now),
                source=alerting.SOURCE_PORTGUARD,
            )
            state = {
                "username": target_owner,
                "rule_id": rule_id,
                "rule_name": i18n.pick(
                    f"主机{kind_name}", f"Host · {kind_name_en}"
                ),
                "target_type": "host",
                "target": report.get("name") or report.get("host_id"),
                "metric": metric,
                "value": float(value),
                "threshold": 0.0,
                "node": "",
                "ip": report.get("address") or "",
                "vmid": None,
                "ts": int(now),
                "notify_source": alerting.SOURCE_PORTGUARD,
            }
            await alerting.mark_active(key, state)
            active[key] = dict(state, alarm_key=key)
            entry = {**state, "result": "sent" if ok else "failed", "detail": detail, "kind": "alarm"}
            await alerting.record(
                entry, source=alerting.SOURCE_PORTGUARD, repeat=bool(prev)
            )
            entry["text"] = text
            fired.append(entry)

    # 恢复：之前告警过、这次不再命中 → 发恢复通知并清掉
    for key, row in list(active.items()):
        if key in still_alarming:
            continue
        if not await alerting.recovery_confirmed(key, row):
            continue  # 本轮只是没命中，还没到「连续 N 轮正常」的恢复门槛
        card = alerting.build_recovery_card(row, None, at=now)
        text = i18n.pick(
            f"{row.get('target')} 的{row.get('rule_name')}已恢复正常，告警解除",
            f"{row.get('target')} · {row.get('rule_name')} recovered; "
            "the alert is cleared",
        )
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            i18n.tr("恢复通知：") + str(row.get("target")),
            text,
            card,
            source=alerting.SOURCE_PORTGUARD,
        )
        await alerting.record(
            {
                "username": row.get("username") or target_owner,
                "rule_id": row.get("rule_id"),
                "rule_name": row.get("rule_name"),
                "target_type": "host",
                "target": row.get("target"),
                "metric": row.get("metric"),
                "value": float(row.get("value") or 0),
                "threshold": row.get("threshold"),
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "recovery",
            },
            source=alerting.SOURCE_PORTGUARD,
        )
        await alerting.clear_active(key)
        fired.append({"kind": "recovery", "target": row.get("target"), "text": text})

    return fired
