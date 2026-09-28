"""SSH 登录安全：日志采集、fail2ban 管控、异常登录告警。

面板跑在哪台机器上，看到的就是哪台机器的 SSH 安全状况（读的是本机
``/var/log/secure`` / ``/var/log/auth.log``，或退回 ``journalctl``）—— 这也是
唯一不需要额外凭据就能拿到真实数据的方式。PVE 集群里其他宿主机的 SSH 日志
面板读不到，别假装能读。

三件事：

1. **采集**：把三种日志源的格式（RHEL 的 secure、Debian 的 auth.log、
   systemd journal 的 short-iso）统一解析成事件流，再聚合出「失败来源排行」
   与「成功登录记录」。同一个连接会同时产生 ``pam_unix ... authentication
   failure`` 与 ``Failed password`` 两行，按 sshd 的 PID 去重，避免次数翻倍。
2. **fail2ban**：状态 / 封禁列表 / 一键封禁解封 / 自定义策略（写 jail 文件并
   reload）。没装 fail2ban 时给出明确的安装指引，而不是静默失败。
3. **告警**：复用 :mod:`app.alerting` 的通道（飞书 / 邮件）与冷却机制。
   两类事件：某 IP 在窗口内失败次数超阈值（可恢复）、陌生 IP 登录成功。
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import alerting, database, store
from .formatters import short_hostname

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------- 配置

POLICY_KEY = "ssh_policy"

# 候选日志文件，按顺序取第一个能读到的（RHEL 系是 secure，Debian 系是 auth.log）
LOG_CANDIDATES = ("/var/log/secure", "/var/log/auth.log")

# 每次最多读日志末尾多少字节：secure 被打爆时会很大，全读没必要
TAIL_BYTES = 8 * 1024 * 1024

# 保留多少条成功登录记录（失败次数不落库，从日志实时统计）
LOGIN_KEEP = 5000

DEFAULT_POLICY: Dict[str, Any] = {
    "enabled": True,
    # 统计窗口（小时）
    "window_hours": 24,
    # 同一 IP 在窗口内失败达到这个次数就告警
    "max_failures": 20,
    # 陌生 IP 登录成功是否告警
    "alert_unknown_ip": True,
    # 同一对象多久内不重复提醒（分钟）
    "cooldown_minutes": 60,
    # 告警发给谁（留空 = 第一个管理员）
    "notify_user": "",
    # fail2ban 里要操作的 jail
    "jail": "",
    # 不参与统计的 IP（逗号分隔，例如跳板机、监控探针）
    "ignore_ips": "",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS ssh_login (
    id       BIGINT NOT NULL AUTO_INCREMENT,
    ts       BIGINT,
    username VARCHAR(64),
    ip       VARCHAR(64),
    method   VARCHAR(32),
    new_ip   TINYINT DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ssh_login_ts (ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ssh_known_ip (
    ip         VARCHAR(64) NOT NULL,
    first_seen BIGINT,
    last_seen  BIGINT,
    hits       INT DEFAULT 0,
    note       VARCHAR(128) DEFAULT '',
    PRIMARY KEY (ip),
    KEY idx_ssh_known_seen (last_seen DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# ----------------------------------------------------------------- 时间解析

ISO_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"
)
SYSLOG_RE = re.compile(
    r"^(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+(?P<time>\d{2}:\d{2}:\d{2})"
)
PID_RE = re.compile(r"sshd\[(?P<pid>\d+)\]")

_MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


def parse_timestamp(line: str, now: Optional[float] = None) -> Optional[float]:
    """从日志行首解析时间戳，兼容 ISO 与经典 syslog 两种写法。

    经典 syslog 没有年份，按「不能是未来」推断：解析出来的时间若比现在晚一天
    以上，就认为是去年那一条（跨年时的日志尾巴）。
    """
    reference = now if now is not None else time.time()

    match = ISO_RE.match(line)
    if match:
        raw = match.group("ts").replace(" ", "T", 1)
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        # 形如 +0800 的时区要补上冒号，fromisoformat 才认
        if re.search(r"[+-]\d{4}$", raw):
            raw = raw[:-2] + ":" + raw[-2:]
        try:
            return datetime.fromisoformat(raw).timestamp()
        except ValueError:
            return None

    match = SYSLOG_RE.match(line)
    if match:
        month = _MONTHS.get(match.group("mon"))
        if not month:
            return None
        try:
            hour, minute, second = (
                int(part) for part in match.group("time").split(":")
            )
        except ValueError:
            return None
        base = datetime.fromtimestamp(reference)
        candidate = base.replace(
            month=month,
            day=int(match.group("day")),
            hour=hour,
            minute=minute,
            second=second,
            microsecond=0,
        )
        if candidate.timestamp() - reference > 86400:
            candidate = candidate.replace(year=candidate.year - 1)
        return candidate.timestamp()
    return None


# ----------------------------------------------------------------- 事件解析

# 只有「真的认证失败」才计数。刻意不含 "Connection closed/reset"（正常探测也会
# 出现，fail2ban 默认过滤器同样不算）与 "Did not receive identification string"
# （健康检查、端口扫描都会触发）—— 那两类会把计数灌水，最后变成狼来了。
_PATTERNS: Tuple[Tuple[str, re.Pattern], ...] = (
    (
        "failed",
        re.compile(
            r"Failed (?:password|publickey|none) for (?:invalid user )?"
            r"(?P<user>\S+) from (?P<ip>\S+) port (?P<port>\d+)"
        ),
    ),
    (
        # IP 用字符类而不是 \S+?：惰性匹配会在 "from 5.6.7.8 port 44" 上只吃掉 "5"
        "failed",
        re.compile(
            r"Invalid user (?P<user>\S+) from (?P<ip>[0-9a-fA-F:.]+)"
            r"(?: port (?P<port>\d+))?"
        ),
    ),
    (
        "failed",
        re.compile(
            r"authentication failure;.*?rhost=(?P<ip>\S*)\s+user=(?P<user>\S+)"
        ),
    ),
    (
        "failed",
        re.compile(
            r"maximum authentication attempts exceeded for (?:invalid user )?"
            r"(?P<user>\S+) from (?P<ip>\S+) port (?P<port>\d+)"
        ),
    ),
    (
        "accepted",
        re.compile(
            r"Accepted (?P<method>\w+) for (?:invalid user )?(?P<user>\S+)"
            r" from (?P<ip>\S+) port (?P<port>\d+)"
        ),
    ),
)


def parse_line(line: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """把一行日志解析成事件；不是认证事件（或没有 IP）时返回 None。"""
    text = line.strip()
    if not text:
        return None
    ts = parse_timestamp(text, now)
    if ts is None:
        return None

    for kind, pattern in _PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        groups = match.groupdict()
        ip = (groups.get("ip") or "").strip()
        if not ip:
            # pam 那行在 rhost= 为空时拿不到来源地址，无从统计
            return None
        pid_match = PID_RE.search(text)
        return {
            "ts": ts,
            "kind": kind,
            "user": (groups.get("user") or "").strip(),
            "ip": ip,
            "port": groups.get("port") or "",
            "method": groups.get("method") or "",
            "pid": pid_match.group("pid") if pid_match else "",
            "raw": text,
        }
    return None


def parse_lines(lines: Iterable[str], now: Optional[float] = None) -> List[Dict[str, Any]]:
    """解析多行并去掉「同一连接产生两行」的重复。

    一次失败连接会同时写出 ``pam_unix(sshd:auth): authentication failure`` 与
    ``Failed password`` —— 两行同一个 sshd PID。按 (kind, pid) 去重，次数才是
    真实尝试次数（没有 PID 的行原样保留，宁可多算也不错算）。
    """
    events: List[Dict[str, Any]] = []
    seen_pids: set = set()
    for line in lines:
        event = parse_line(line, now)
        if not event:
            continue
        pid = event.get("pid")
        if pid:
            mark = (event["kind"], pid)
            if mark in seen_pids:
                continue
            seen_pids.add(mark)
        events.append(event)
    events.sort(key=lambda item: item["ts"])
    return events


# ----------------------------------------------------------------- 日志读取

def log_source() -> Dict[str, Any]:
    """当前可用的日志来源：优先文件，其次 journalctl，都没有就明确说没有。

    返回值里带上主机名：这些数据是**面板所在主机**的，页面上要说清楚，
    免得让人以为看到的是集群里所有机器。
    """
    host = short_hostname()
    for path in LOG_CANDIDATES:
        if os.path.exists(path):
            readable = os.access(path, os.R_OK)
            return {
                "kind": "file",
                "path": path,
                "label": os.path.basename(path),
                "available": readable,
                "host": host,
                "detail": "" if readable else "日志文件存在但当前用户读不到（需要 root）",
            }
    if shutil.which("journalctl"):
        return {
            "kind": "journalctl",
            "path": "",
            "label": "journalctl (sshd)",
            "available": True,
            "host": host,
            "detail": "未找到 auth.log / secure，改用 journald",
        }
    return {
        "kind": "none",
        "path": "",
        "label": "无",
        "available": False,
        "host": host,
        "detail": f"{host} 上既没有 /var/log/secure、/var/log/auth.log，也没有 journalctl",
    }


def read_lines(source: Dict[str, Any], since_ts: float, timeout: float = 20.0) -> List[str]:
    """按来源读日志。文件只读尾部若干字节，journal 按时间过滤。"""
    if source.get("kind") == "file" and source.get("path"):
        return _tail_lines(source["path"], since_ts)
    if source.get("kind") == "journalctl":
        return _journal_lines(since_ts, timeout)
    return []


def _tail_lines(path: str, since_ts: float) -> List[str]:
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    with open(path, "rb") as handle:
        if size > TAIL_BYTES:
            handle.seek(size - TAIL_BYTES)
            handle.readline()  # 丢掉被切断的半行
        raw = handle.read()
    lines = raw.decode("utf-8", "replace").splitlines()
    # 只保留窗口内的（日志尾部可能仍有余量，精确判断交给时间戳）
    out: List[str] = []
    for line in lines:
        ts = parse_timestamp(line)
        if ts is None or ts >= since_ts:
            out.append(line)
    return out


def _journal_lines(since_ts: float, timeout: float) -> List[str]:
    """跑 journalctl。参数用列表传递，绝不拼 shell（日志内容不可信）。"""
    binary = shutil.which("journalctl")
    if not binary:
        return []
    cmd = [
        binary,
        "-u", "ssh",
        "-u", "sshd",
        "--since", "@" + str(int(since_ts)),
        "-o", "short-iso",
        "--no-pager",
        "-n", "20000",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("读取 journalctl 失败：%s", exc)
        return []
    if proc.returncode not in (0, 1):  # 1 = 没有匹配记录
        logger.warning("journalctl 返回 %s：%s", proc.returncode, proc.stderr[:200])
    return proc.stdout.splitlines()


# ----------------------------------------------------------------- 统计聚合

def split_ips(raw: str) -> List[str]:
    return [item.strip() for item in re.split(r"[,\s]+", raw or "") if item.strip()]


def aggregate(
    events: List[Dict[str, Any]],
    since_ts: float,
    ignore_ips: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """把事件流聚合成面板要展示的结构。"""
    ignored = set(ignore_ips or [])
    failures: Dict[str, Dict[str, Any]] = {}
    login_events: List[Dict[str, Any]] = []
    users: Dict[str, int] = {}
    total_failures = 0

    for event in events:
        ip = event["ip"]
        if ip in ignored:
            continue
        if event["kind"] == "accepted":
            login_events.append(
                {
                    "ts": int(event["ts"]),
                    "username": event["user"],
                    "ip": ip,
                    "method": event["method"],
                }
            )
            continue
        total_failures += 1
        users[event["user"]] = users.get(event["user"], 0) + 1
        row = failures.get(ip)
        if row is None:
            row = {
                "ip": ip,
                "count": 0,
                "users": [],
                "first_ts": int(event["ts"]),
                "last_ts": int(event["ts"]),
            }
            failures[ip] = row
        row["count"] += 1
        row["first_ts"] = min(row["first_ts"], int(event["ts"]))
        row["last_ts"] = max(row["last_ts"], int(event["ts"]))
        if event["user"] and event["user"] not in row["users"]:
            row["users"].append(event["user"])

    top_ips = sorted(failures.values(), key=lambda r: (-r["count"], r["ip"]))
    return {
        "since": int(since_ts),
        "generated_at": int(time.time()),
        "summary": {
            "failures": total_failures,
            "distinct_ips": len(failures),
            "distinct_users": len(users),
            "logins": len(login_events),
        },
        "top_ips": top_ips,
        "top_users": [
            {"user": name, "count": count}
            for name, count in sorted(users.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
            if name
        ],
        "logins": login_events[-100:][::-1],
    }


async def collect(hours: int = 24) -> Dict[str, Any]:
    """读日志 + 聚合，返回一份可直接给前端的报告（不含告警判断）。"""
    source = log_source()
    since_ts = time.time() - max(1, min(168, hours)) * 3600
    if not source.get("available"):
        return {
            "source": source,
            "summary": {"failures": 0, "distinct_ips": 0, "distinct_users": 0, "logins": 0},
            "top_ips": [],
            "top_users": [],
            "logins": [],
            "since": int(since_ts),
            "generated_at": int(time.time()),
        }
    policy = await load_policy()
    lines = read_lines(source, since_ts)
    events = parse_lines(lines)
    report = aggregate(events, since_ts, split_ips(policy.get("ignore_ips", "")))
    report["source"] = source
    report["scanned_lines"] = len(lines)
    return report


# ------------------------------------------------------- 登录记录与「陌生 IP」

async def known_ips() -> Dict[str, Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM ssh_known_ip")
        rows = await cursor.fetchall()
    return {str(r["ip"]): dict(r) for r in rows}


def mark_new_logins(
    logins: List[Dict[str, Any]], known: Dict[str, Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """给每条登录记录标注它是不是来自「第一次见到」的 IP（不改库）。"""
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for item in logins:
        ip = str(item.get("ip") or "")
        fresh = bool(ip) and ip not in known and ip not in seen
        seen.add(ip)
        out.append({**item, "new_ip": fresh})
    return out


async def remember(logins: List[Dict[str, Any]]) -> None:
    """把成功登录写进历史，并把这些 IP 记入已知集合。"""
    if not logins:
        return
    await init_table()
    now = int(time.time())
    async with database.connect() as db:
        for item in logins:
            await db.execute(
                "INSERT INTO ssh_login (ts, username, ip, method, new_ip)"
                " VALUES (?,?,?,?,?)",
                (
                    int(item.get("ts") or now),
                    str(item.get("username") or "")[:64],
                    str(item.get("ip") or "")[:64],
                    str(item.get("method") or "")[:32],
                    1 if item.get("new_ip") else 0,
                ),
            )
            await db.execute(
                database.upsert_sql(
                    "ssh_known_ip",
                    ["ip", "first_seen", "last_seen", "hits", "note"],
                    ["ip"],
                    ["last_seen", "hits"],
                ),
                (str(item.get("ip") or ""), int(item.get("ts") or now), now, 1, ""),
            )
        await db.commit()
        # 只留最近 N 条，SSH 登录记录不值得无限增长
        await db.execute(
            "DELETE FROM ssh_login WHERE id NOT IN"
            " (SELECT id FROM (SELECT id FROM ssh_login ORDER BY ts DESC LIMIT ?) t)",
            (LOGIN_KEEP,),
        )
        await db.commit()


async def login_history(limit: int = 100) -> List[Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT * FROM ssh_login ORDER BY ts DESC LIMIT ?",
            (max(1, min(1000, limit)),),
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def trust_ip(ip: str, note: str = "") -> None:
    """把一个 IP 标记为已知（用来消掉「陌生 IP」告警）。"""
    await init_table()
    now = int(time.time())
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "ssh_known_ip",
                ["ip", "first_seen", "last_seen", "hits", "note"],
                ["ip"],
                ["note"],
            ),
            (ip, now, now, 0, note[:128]),
        )
        await db.commit()


async def forget_ip(ip: str) -> int:
    """取消「已知 IP」标记：下次它再登录又会被当成陌生 IP。"""
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("DELETE FROM ssh_known_ip WHERE ip = ?", (ip,))
        removed = cursor.rowcount or 0
        await db.commit()
    return removed


# ------------------------------------------------------------------- 策略

class PolicyError(ValueError):
    """策略参数不合法。"""


def _int_in(name: str, value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if number < low or number > high:
        raise PolicyError(f"{name} 需要在 {low} - {high} 之间")
    return number


def normalise_policy(raw: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    current = dict(base or DEFAULT_POLICY)
    item = raw or {}
    policy = {
        "enabled": bool(item.get("enabled", current.get("enabled", True))),
        "window_hours": _int_in(
            "统计窗口", item.get("window_hours", current.get("window_hours")), 1, 168, 24
        ),
        "max_failures": _int_in(
            "失败阈值",
            item.get("max_failures", current.get("max_failures")),
            1,
            10000,
            20,
        ),
        "alert_unknown_ip": bool(
            item.get("alert_unknown_ip", current.get("alert_unknown_ip", True))
        ),
        "cooldown_minutes": _int_in(
            "冷却时间",
            item.get("cooldown_minutes", current.get("cooldown_minutes")),
            1,
            1440,
            60,
        ),
        "notify_user": str(item.get("notify_user", current.get("notify_user", ""))).strip()[:64],
        "jail": str(item.get("jail", current.get("jail", ""))).strip()[:64],
        "ignore_ips": ",".join(
            split_ips(str(item.get("ignore_ips", current.get("ignore_ips", ""))))
        )[:512],
    }
    return policy


async def load_policy() -> Dict[str, Any]:
    raw = await store.get_setting(POLICY_KEY)
    if not raw:
        return dict(DEFAULT_POLICY)
    try:
        import json

        parsed = json.loads(raw)
    except ValueError:
        return dict(DEFAULT_POLICY)
    if not isinstance(parsed, dict):
        return dict(DEFAULT_POLICY)
    try:
        return normalise_policy(parsed)
    except PolicyError:
        logger.warning("ssh_policy 里有不合法的值，已回退默认策略")
        return dict(DEFAULT_POLICY)


async def save_policy(raw: Dict[str, Any]) -> Dict[str, Any]:
    import json

    current = await load_policy()
    policy = normalise_policy(raw, current)
    await store.set_setting(POLICY_KEY, json.dumps(policy, ensure_ascii=False))
    return policy


async def notify_owner() -> str:
    """告警发给谁：策略里指定了就用它，否则第一个管理员。"""
    policy = await load_policy()
    return policy.get("notify_user") or await store.first_admin_username() or ""


# --------------------------------------------------------------- fail2ban

JAIL_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
IP_RE = re.compile(r"^[0-9a-fA-F:.]{3,45}$")
JAIL_FILE_DIR = "/etc/fail2ban/jail.d"


# fail2ban-client 常见安装位置。系统服务（systemd）的 PATH 可能比自己登录时窄，
# 而且有的系统把 client 装在 /usr/sbin 或自定义前缀下 —— 只靠 shutil.which()
# 会误报「没装」，所以先扩着找一遍。
FAIL2BAN_CANDIDATES = (
    "/usr/bin/fail2ban-client",
    "/usr/sbin/fail2ban-client",
    "/usr/local/bin/fail2ban-client",
    "/usr/local/sbin/fail2ban-client",
    "/sbin/fail2ban-client",
    "/bin/fail2ban-client",
    "/opt/fail2ban/bin/fail2ban-client",
)
FAIL2BAN_SEARCH_PATH = (
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/fail2ban/bin"
)


def fail2ban_binary() -> str:
    """找到 fail2ban-client 的绝对路径；找不到返回空串。"""
    found = shutil.which("fail2ban-client") or shutil.which(
        "fail2ban-client", path=FAIL2BAN_SEARCH_PATH
    )
    if found:
        return found
    for path in FAIL2BAN_CANDIDATES:
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path
    return ""


def fail2ban_available() -> bool:
    return bool(fail2ban_binary())


def _client(args: List[str], timeout: float = 15.0) -> Tuple[bool, str]:
    """跑 fail2ban-client。参数列表传递，绝不拼 shell。"""
    binary = fail2ban_binary()
    if not binary:
        return False, "未安装 fail2ban"
    try:
        proc = subprocess.run(
            [binary, *args], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"执行 fail2ban-client 失败：{exc}"
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        return False, output.strip()[:400] or f"fail2ban-client 返回 {proc.returncode}"
    return True, output


def parse_jail_status(text: str) -> Dict[str, Any]:
    """解析 ``fail2ban-client status <jail>`` 的输出。"""
    data: Dict[str, Any] = {
        "jail": "",
        "filter": "",
        "currently_failed": 0,
        "total_failed": 0,
        "currently_banned": 0,
        "total_banned": 0,
        "banned_ips": [],
        "log_files": [],
    }
    lines = [line.rstrip() for line in (text or "").splitlines()]
    collecting_ips = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if ":" in stripped:
            key, _, value = stripped.partition(":")
            # fail2ban 的输出带树形符号（`|  |- Currently failed:`）：把所有装饰
            # 字符与空白压成一个下划线，再比对键名 —— 直接 strip 会被中间的
            # 空格卡住，只剩半个键名。
            key = re.sub(r"[|`\-\s]+", " ", key).strip().lower().replace(" ", "_")
            value = value.strip()
            collecting_ips = key == "banned_ip_list"
            if key in ("currently_failed", "total_failed", "currently_banned", "total_banned"):
                try:
                    data[key] = int(value)
                except ValueError:
                    data[key] = 0
                continue
            if key == "filter":
                data["filter"] = value
                continue
            if key == "file_list":
                data["log_files"] = [item for item in value.split(",") if item.strip()]
                continue
            if key in ("jail", "status_for_the_jail"):
                data["jail"] = value.split()[0] if value else ""
                continue
            if collecting_ips:
                # "Banned IP list: 1.2.3.4 5.6.7.8"
                data["banned_ips"].extend(value.split())
            continue
        if collecting_ips:
            # IP 列表换行续写的情况
            data["banned_ips"].extend(stripped.split())
    data["banned_ips"] = [ip for ip in data["banned_ips"] if ip]
    return data


async def fail2ban_status() -> Dict[str, Any]:
    """fail2ban 总览：装了没、有哪些 jail、各自封了谁。"""
    policy = await load_policy()
    binary = fail2ban_binary()
    if not binary:
        return {
            "installed": False,
            "running": False,
            "jails": [],
            "details": [],
            "preferred": policy.get("jail") or "",
            "host": short_hostname(),
            "binary": "",
            "checked": list(FAIL2BAN_CANDIDATES),
            "hint": "面板在 " + short_hostname() + "（本机）上没找到 fail2ban-client："
            "查过 PATH 与 " + "、".join(FAIL2BAN_CANDIDATES) + "。"
            "注意面板只看得到**自己所在主机**的 fail2ban —— 装在别的机器（比如 PVE 节点）上，"
            "这里不会显示。本机安装：Debian/Ubuntu 用 apt install fail2ban；"
            "RHEL/CentOS 用 yum install epel-release && yum install fail2ban；"
            "装好后确认 [sshd] jail 是启用的（RHEL 默认关闭）并 systemctl enable --now fail2ban。",
        }
    ok, output = _client(["status"])
    if not ok:
        lowered = output.lower()
        running = not ("connection refused" in lowered or "no such file" in lowered)
        return {
            "installed": True,
            "running": running,
            "jails": [],
            "details": [],
            "preferred": policy.get("jail") or "",
            "host": short_hostname(),
            "binary": binary,
            "checked": [],
            "hint": "fail2ban 已安装（" + binary + "）但服务没在跑：systemctl enable --now fail2ban。"
            + ("（" + output.strip()[:200] + "）" if output.strip() else ""),
        }
    match = re.search(r"Jail list:\s*(.*)", output)
    jails = [name.strip() for name in (match.group(1).split(",") if match else []) if name.strip()]

    preferred = policy.get("jail") or ""
    if preferred not in jails:
        ssh_jails = [name for name in jails if "ssh" in name.lower()]
        preferred = ssh_jails[0] if ssh_jails else (jails[0] if jails else "")

    details: List[Dict[str, Any]] = []
    for name in jails:
        if not JAIL_NAME_RE.match(name):
            continue
        jail_ok, jail_out = _client(["status", name])
        if not jail_ok:
            continue
        parsed = parse_jail_status(jail_out)
        parsed["jail"] = parsed.get("jail") or name
        # fail2ban 的 jail 自己带的配置（enabled / maxretry / bantime）读出来给前端参考
        config_path = os.path.join("/etc/fail2ban/jail.d", "panel-" + name + ".local")
        parsed["managed_config"] = config_path if os.path.exists(config_path) else ""
        details.append(parsed)
    return {
        "installed": True,
        "running": True,
        "jails": jails,
        "details": details,
        "preferred": preferred,
        "host": short_hostname(),
        "binary": binary,
        "checked": [],
        "hint": "" if jails else
        "fail2ban 在跑，但一个 jail 都没启用：在 /etc/fail2ban/jail.local 里加上"
        " [sshd]\\nenabled = true\\n然后 systemctl reload fail2ban（RHEL 的 sshd jail 默认是关的）。",
    }


async def fail2ban_action(action: str, jail: str, ip: str = "") -> Dict[str, Any]:
    """封禁 / 解封 / 重载。``action`` 只允许白名单里的几种。"""
    if action not in ("ban", "unban", "reload"):
        raise ValueError("不支持的操作：" + action)
    if action == "reload":
        ok, output = _client(["reload"])
        if not ok:
            raise RuntimeError(output)
        return {"ok": True, "detail": output.strip()[:200]}
    if not JAIL_NAME_RE.match(jail or ""):
        raise ValueError("jail 名称不合法")
    if not IP_RE.match(ip or ""):
        raise ValueError("IP 地址不合法")
    ok, output = _client(["set", jail, "banip" if action == "ban" else "unbanip", ip])
    if not ok:
        raise RuntimeError(output)
    return {"ok": True, "detail": output.strip()[:200]}


def parse_jail_config(text: str) -> Dict[str, str]:
    """解析 jail.local 里的键值（只取 [sshd] 这类段落的简单 k = v）。"""
    values: Dict[str, str] = {}
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("["):
            continue
        if "=" in stripped:
            key, _, value = stripped.partition("=")
            values[key.strip().lower()] = value.strip()
    return values


def render_jail_config(
    jail: str, maxretry: int, findtime: int, bantime: int, ignore_ips: str = ""
) -> str:
    """生成 jail.d 里的片段。写在我们自己命名的文件里，不动别人的配置。"""
    lines = [
        "# 由 ProxCenter 生成：在这里手改会被面板下一次保存覆盖。",
        "# 单独成文件是为了不碰 /etc/fail2ban/jail.local 里的其它配置。",
        "[" + jail + "]",
        "enabled = true",
        "maxretry = " + str(maxretry),
        "findtime = " + str(findtime),
        "bantime = " + str(bantime),
    ]
    ignore = split_ips(ignore_ips)
    if ignore:
        lines.append("ignoreip = 127.0.0.1/8 ::1 " + " ".join(ignore))
    lines.append("")
    return "\n".join(lines)


def jail_file_path(jail: str) -> str:
    return os.path.join(JAIL_FILE_DIR, "panel-" + jail + ".local")


async def write_jail(
    jail: str, maxretry: int, findtime: int, bantime: int, reload_now: bool = True
) -> Dict[str, Any]:
    """写面板托管的 jail 片段并重载 fail2ban。"""
    if not JAIL_NAME_RE.match(jail or ""):
        raise ValueError("jail 名称不合法")
    if not fail2ban_available():
        raise RuntimeError("未安装 fail2ban，无法写入封禁策略")
    policy = await load_policy()
    config = render_jail_config(
        jail, maxretry, findtime, bantime, policy.get("ignore_ips", "")
    )
    path = jail_file_path(jail)
    try:
        os.makedirs(JAIL_FILE_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(config)
    except OSError as exc:
        raise RuntimeError(f"写入 {path} 失败：{exc}") from exc
    detail = ""
    if reload_now:
        ok, output = _client(["reload"])
        if not ok:
            raise RuntimeError("配置已写入，但 reload 失败：" + output.strip()[:200])
        detail = output.strip()[:200]
    return {"ok": True, "path": path, "config": config, "detail": detail}


# ------------------------------------------------------------------- 告警

def build_fail_card(
    ip: str, count: int, threshold: int, hours: int, users: List[str], at: float
) -> Dict[str, Any]:
    return alerting.build_card(
        "critical" if count >= threshold * 2 else "warning",
        "🛡 ProxCenter SSH 爆破告警",
        f"{ip} 在 {hours} 小时内失败 {count} 次",
        [
            ("来源 IP", ip),
            ("失败次数", f"**{count}**（阈值 {threshold}）"),
            ("统计窗口", f"最近 {hours} 小时"),
            ("尝试的用户名", "、".join(users[:8]) or "-"),
            ("发生时间", alerting._now_text(at)),
        ],
        "连续失败通常意味着暴力破解。可在「SSH 安全」页一键封禁该 IP，"
        "或用 fail2ban 自动封禁。",
    )


def build_login_card(
    ip: str, user: str, method: str, at: float, known_hint: str
) -> Dict[str, Any]:
    return alerting.build_card(
        "warning",
        "🔑 ProxCenter 陌生 IP 登录成功",
        f"{user} 从新地址登录",
        [
            ("登录用户", user or "-"),
            ("来源 IP", ip),
            ("认证方式", method or "-"),
            ("登录时间", alerting._now_text(at)),
            ("IP 是否见过", known_hint or "第一次出现"),
        ],
        "如果不是你本人的操作，请立刻在「用户管理」里踢掉该账号的会话并改密码。",
    )


async def evaluate(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """检查 SSH 异常并推送告警；``owner=None`` 表示发给策略指定的接收人。

    ``owner`` 参数只为对齐 :func:`app.alerting.evaluate` 的调用方式：SSH 日志是
    主机级的，没有「按用户隔离」的概念，传进来的用户名会被忽略（通知对象由
    策略里的 notify_user 决定）。
    """
    policy = await load_policy()
    if not policy.get("enabled"):
        return []

    await init_table()
    report = await collect(policy["window_hours"])
    logins = mark_new_logins(report["logins"], await known_ips())

    target_owner = policy.get("notify_user") or await store.first_admin_username() or ""
    feishu = await alerting.load_feishu(target_owner)
    email_cfg = await alerting.load_alert_email(target_owner)
    cooldown = int(policy["cooldown_minutes"]) * 60
    now = time.time()
    threshold = int(policy["max_failures"])
    fired: List[Dict[str, Any]] = []

    active = await alerting.load_active()
    active = {
        key: row
        for key, row in active.items()
        if str(row.get("target_type")) == "ssh"
    }
    still_alarming: set = set()

    # ---- 1. 失败次数超阈值的 IP ----
    for row in report["top_ips"]:
        ip = row["ip"]
        if row["count"] < threshold:
            continue
        key = alerting.alarm_key(target_owner, "ssh-fail", ip)
        still_alarming.add(key)
        # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
        prev = active.get(key) or {}
        last = float(prev.get("ts") or 0)
        if now - last < cooldown:
            continue
        card = build_fail_card(
            ip, row["count"], threshold, policy["window_hours"], row["users"], now
        )
        text = (
            f"SSH 爆破告警：{ip} 在 {policy['window_hours']} 小时内失败 {row['count']} 次"
            f"（阈值 {threshold}）\n尝试的用户名：{'、'.join(row['users'][:8])}"
        )
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            "SSH 爆破告警：" + ip,
            text,
            card,
            source=alerting.SOURCE_SSHGUARD,
        )
        state = {
            "username": target_owner,
            "rule_id": "ssh-fail",
            "rule_name": "SSH 登录失败次数",
            "target_type": "ssh",
            "target": ip,
            "metric": "ssh_fail",
            "value": row["count"],
            "threshold": threshold,
            "node": "",
            "ip": ip,
            "vmid": None,
            "ts": int(now),
            "notify_source": alerting.SOURCE_SSHGUARD,
        }
        await alerting.mark_active(key, state)
        active[key] = dict(state, alarm_key=key)
        entry = {**state, "result": "sent" if ok else "failed", "detail": detail, "kind": "alarm"}
        await alerting.record(entry, source=alerting.SOURCE_SSHGUARD)
        entry["text"] = text
        fired.append(entry)

    # ---- 2. 陌生 IP 登录成功 ----
    if policy.get("alert_unknown_ip"):
        for item in logins:
            if not item.get("new_ip"):
                continue
            ip = item["ip"]
            key = alerting.alarm_key(target_owner, "ssh-login", ip)
            last = float((active.get(key) or {}).get("ts") or 0)
            if now - last < cooldown:
                continue
            user = str(item.get("username") or "")
            card = build_login_card(ip, user, str(item.get("method") or ""), item["ts"], "")
            text = (
                f"陌生 IP 登录成功：{user} 从 {ip} 登录（{item.get('method') or '-'}）"
                f"\n时间：{alerting._now_text(item['ts'])}"
            )
            ok, detail = await alerting.dispatch(
                target_owner,
                feishu,
                email_cfg,
                "陌生 IP 登录：" + ip,
                text,
                card,
                source=alerting.SOURCE_SSHGUARD,
            )
            state = {
                "username": target_owner,
                "rule_id": "ssh-login",
                "rule_name": "陌生 IP 登录",
                "target_type": "ssh",
                "target": ip,
                "metric": "ssh_login",
                "value": 1.0,
                "threshold": 0.0,
                "node": "",
                "ip": ip,
                "vmid": None,
                "ts": int(now),
                "notify_source": alerting.SOURCE_SSHGUARD,
            }
            # 这是一次性事件：只用 active 记录做冷却，冷却过后自动清掉（不算「正在告警」）
            await alerting.mark_active(key, state)
            active[key] = dict(state, alarm_key=key)
            entry = {**state, "result": "sent" if ok else "failed", "detail": detail, "kind": "alarm"}
            await alerting.record(entry, source=alerting.SOURCE_SSHGUARD)
            entry["text"] = text
            fired.append(entry)

    # ---- 3. 恢复：失败次数回落到阈值以下 ----
    for key, row in list(active.items()):
        if row.get("rule_id") != "ssh-fail":
            continue
        if key in still_alarming:
            continue
        if not await alerting.recovery_confirmed(key, row):
            continue  # 本轮只是回落到阈值以下，还没到「连续 N 轮正常」的恢复门槛
        card = alerting.build_recovery_card(row, None, at=now)
        text = f"{row.get('target')} 的 SSH 登录失败次数已回落到阈值以下，告警解除"
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            "恢复通知：" + str(row.get("target")),
            text,
            card,
            source=alerting.SOURCE_SSHGUARD,
        )
        await alerting.record(
            {
                "username": row.get("username") or target_owner,
                "rule_id": row.get("rule_id"),
                "rule_name": row.get("rule_name"),
                "target_type": "ssh",
                "target": row.get("target"),
                "metric": "ssh_fail",
                "value": float(row.get("value") or 0),
                "threshold": row.get("threshold"),
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "recovery",
            },
            source=alerting.SOURCE_SSHGUARD,
        )
        await alerting.clear_active(key)
        fired.append({"kind": "recovery", "target": row.get("target"), "text": text})

    # ---- 4. 冷却过期的「陌生 IP」记录清掉，别让它在页面上一直挂着 ----
    for key, row in list(active.items()):
        if row.get("rule_id") != "ssh-login":
            continue
        if now - float(row.get("ts") or 0) >= cooldown:
            await alerting.clear_active(key)

    # ---- 5. 落库：登录历史 + 已知 IP（放在最后，避免刚登录就被当成「已知」）----
    await remember(logins)
    return fired


def overview_payload(report: Dict[str, Any]) -> Dict[str, Any]:
    """给前端的概览裁剪：失败排行只留前 50 条。"""
    payload = dict(report)
    payload["top_ips"] = (report.get("top_ips") or [])[:50]
    return payload
