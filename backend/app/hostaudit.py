"""主机登录审计：``last`` / ``lastb`` / auth.log 里的登录与提权记录。

两层东西，别混为一谈：

1. **原始登录记录**：``last``（成功）/ ``lastb``（失败）是 wtmp / btmp 里现成的
   历史，比翻 auth.log 更全（换日志、日志被清都还在），解析出来直接展示。
2. **汇入面板审计**：把「主机级」事件（SSH 登录成功/失败、sudo 提权）按增量
   游标写进 ``audit_log``，于是它们和面板自己的操作一起出现在审计日志里 ——
   事后追责时，「谁在什么时候从哪台机器登进来、又 sudo 干了什么」是一张表。

主机范围 = 面板本机 + 受管远程主机（复用 :mod:`app.sshremote` 的 SSH 通道）；
每台主机一个游标，保证重复导入不会把审计表写爆。
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import alerting, database, sshguard, sshremote, store

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS host_audit_cursor (
    host_id  VARCHAR(64) NOT NULL,
    last_ts  DOUBLE,
    updated  BIGINT,
    detail   TEXT,
    PRIMARY KEY (host_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# 每次最多往面板审计里写多少条（防止首次导入把表灌满）
IMPORT_BATCH = 200
# 保留游标多少天前的记录不再导入（首次部署只导最近的）
IMPORT_LOOKBACK_DAYS = 7

# last 的默认条数
LAST_LIMIT = 500

# ------------------------------------------------------------------ 解析

# 形如：root   pts/6   172.16.149.5    Fri Sep 25 07:24:58 2026   still logged in
#      root   pts/0   10.0.0.1       Thu Sep 24 08:42:47 2026 - Thu Sep 24 09:20:23 2026  (00:37)
_DATE_RE = re.compile(
    r"(?P<date>[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})"
)
_DURATION_RE = re.compile(r"\((?P<dur>[^)]*)\)\s*$")
_STATES = (
    "still logged in",
    "still running",
    "gone - no logout",
    "down",
    "crash",
)

_MONTHS = {name: idx for idx, name in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)
}


def parse_when(text: str) -> Optional[float]:
    """解析 ``Fri Sep 25 07:24:58 2026`` 这种本地时间字符串。"""
    if not text:
        return None
    raw = text.strip()
    try:
        return time.mktime(time.strptime(raw, "%a %b %d %H:%M:%S %Y"))
    except (ValueError, OverflowError):
        return None


def parse_last_line(line: str) -> Optional[Dict[str, Any]]:
    """解析 ``last`` 的一行；不是登录记录（表头、wtmp begins）时返回 None。"""
    raw = line.rstrip()
    if not raw.strip():
        return None
    if raw.startswith("wtmp begins") or raw.startswith("btmp begins"):
        return None

    # 开机记录：reboot   system boot  <内核版本> <时间> still running
    # （tty 与来源是两段，所以要在切分之前单独识别）
    if "system boot" in raw:
        return _parse_reboot(raw)

    parts = raw.split(None, 3)
    if len(parts) < 4:
        # 形如 "reboot   system boot  ..."（没有来源地址）也尽量解析
        parts = raw.split(None, 2)
        if len(parts) < 3:
            return None
        user, tty, rest = parts[0], parts[1], parts[2]
        source = ""
    else:
        user, tty, source, rest = parts

    if tty == "system boot":
        # 开机记录：内核版本占位在 rest 前面
        match = _DURATION_RE.search(rest)
        duration = match.group("dur") if match else ""
        rest = _DURATION_RE.sub("", rest)
        dates = _DATE_RE.findall(rest)
        start = parse_when(dates[0]) if dates else None
        return {
            "kind": "reboot",
            "user": "reboot",
            "tty": "system boot",
            "ip": "",
            "kernel": rest.replace(dates[0], "").strip() if dates else rest.strip(),
            "start": start,
            "end": None,
            "duration": duration,
            "state": "still running" if "still running" in raw else "",
            "raw": raw,
        }

    duration = ""
    match = _DURATION_RE.search(rest)
    if match:
        duration = match.group("dur")
        rest = _DURATION_RE.sub("", rest)

    state = ""
    for candidate in _STATES:
        if candidate in rest:
            state = candidate
            rest = rest.replace(candidate, " ")
            break

    start: Optional[float] = None
    end: Optional[float] = None
    if " - " in rest:
        left, _, right = rest.partition(" - ")
        start = parse_when(left)
        end = parse_when(right)
    else:
        dates = _DATE_RE.findall(rest)
        if dates:
            start = parse_when(dates[0])

    # 来源地址：ssh:notty 这类终端也带 IP；内核/空地址不算来源
    ip = source if _looks_like_ip(source) else ""
    return {
        "kind": "login",
        "user": user,
        "tty": tty,
        "ip": ip,
        "kernel": "",
        "start": start,
        "end": end,
        "duration": duration,
        "state": state,
        "raw": raw,
    }


def _parse_reboot(raw: str) -> Dict[str, Any]:
    rest = raw.split("system boot", 1)[1]
    match = _DURATION_RE.search(rest)
    duration = match.group("dur") if match else ""
    rest = _DURATION_RE.sub("", rest)
    state = ""
    for candidate in _STATES:
        if candidate in rest:
            state = candidate
            rest = rest.replace(candidate, " ")
            break
    dates = _DATE_RE.findall(rest)
    start = parse_when(dates[0]) if dates else None
    kernel = rest[: rest.find(dates[0])].strip() if dates else rest.strip()
    return {
        "kind": "reboot",
        "user": "reboot",
        "tty": "system boot",
        "ip": "",
        "kernel": kernel,
        "start": start,
        "end": None,
        "duration": duration,
        "state": state,
        "raw": raw,
    }


def _looks_like_ip(value: str) -> bool:
    if not value:
        return False
    return bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", value) or ":" in value)


def parse_last_output(text: str, kind: str = "success") -> List[Dict[str, Any]]:
    """解析 ``last``（成功）/ ``lastb``（失败）的完整输出。"""
    rows: List[Dict[str, Any]] = []
    for line in (text or "").splitlines():
        parsed = parse_last_line(line)
        if not parsed:
            continue
        if kind == "failed":
            parsed["kind"] = "failed"
            parsed["success"] = False
        else:
            parsed["success"] = parsed["kind"] != "failed"
        rows.append(parsed)
    rows.sort(key=lambda row: row.get("start") or 0, reverse=True)
    return rows


# ---------------------------------------------------------------- sudo 解析

_SUDO_RE = re.compile(
    r"sudo:\s+(?P<user>\S+)\s+:\s+TTY=(?P<tty>[^;]*?)\s*;\s*PWD=(?P<pwd>[^;]*?)\s*;"
    r"\s*USER=(?P<target>[^;]*?)\s*;\s*(?:TSID=(?P<tsid>[^;]*?)\s*;\s*)?COMMAND=(?P<cmd>.*)$"
)
_SUDO_FAIL_RE = re.compile(
    r"sudo:\s+pam_unix\(sudo(?::[a-z]+)?\):\s*authentication failure;.*?user=(?P<user>\S+)"
)
# 提权人常写成 "ops(uid=1000)"，所以要吃掉后面的 uid=
_BY_RE = r"(?: by (?P<user>[^\s(]+)(?:\(uid=\d+\))?)?"
_SUDO_SESSION_RE = re.compile(
    r"sudo:\s+pam_unix\(sudo(?::[a-z]+)?\):\s*session opened for user (?P<target>\S+)"
    + _BY_RE
)
# su 的形态更杂：pam_unix(su:session) / (su-l:session) / (su:auth)
_SU_RE = re.compile(
    r"su:\s+pam_unix\(su[a-z-]*(?::[a-z]+)?\):\s*session opened for user (?P<target>\S+)"
    + _BY_RE
)


def parse_auth_events(lines: List[str]) -> List[Dict[str, Any]]:
    """从 auth.log / secure 里挑出 sudo / su 提权事件。"""
    events: List[Dict[str, Any]] = []
    for line in lines or []:
        text = line.strip()
        if "sudo:" not in text and "su:" not in text:
            continue
        ts = sshguard.parse_timestamp(text)
        match = _SUDO_RE.search(text)
        if match:
            data = match.groupdict()
            events.append(
                {
                    "kind": "sudo",
                    "success": True,
                    "ts": ts,
                    "user": (data.get("user") or "").strip(),
                    "target": (data.get("target") or "").strip(),
                    "tty": (data.get("tty") or "").strip(),
                    "command": (data.get("cmd") or "").strip(),
                    "raw": text,
                }
            )
            continue
        match = _SUDO_SESSION_RE.search(text)
        if match:
            data = match.groupdict()
            events.append(
                {
                    "kind": "sudo",
                    "success": True,
                    "ts": ts,
                    "user": (data.get("user") or "").strip(),
                    "target": (data.get("target") or "").strip(),
                    "tty": "",
                    "command": "session opened",
                    "raw": text,
                }
            )
            continue
        match = _SUDO_FAIL_RE.search(text)
        if match:
            events.append(
                {
                    "kind": "sudo",
                    "success": False,
                    "ts": ts,
                    "user": (match.group("user") or "").strip(),
                    "target": "",
                    "tty": "",
                    "command": "authentication failure",
                    "raw": text,
                }
            )
            continue
        match = _SU_RE.search(text)
        if match:
            data = match.groupdict()
            events.append(
                {
                    "kind": "su",
                    "success": True,
                    "ts": ts,
                    "user": (data.get("user") or "").strip(),
                    "target": (data.get("target") or "").strip(),
                    "tty": "",
                    "command": "su",
                    "raw": text,
                }
            )
    events.sort(key=lambda item: item.get("ts") or 0, reverse=True)
    return events


# ------------------------------------------------------------------ 采集

def _local_run(command: str, timeout: float = 20.0) -> Tuple[bool, str]:
    try:
        proc = subprocess.run(
            command.split(), capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    return proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")


async def local_last(kind: str = "success", limit: int = LAST_LIMIT) -> Tuple[bool, str]:
    binary = "lastb" if kind == "failed" else "last"
    if not shutil.which(binary):
        return False, f"本机没有 {binary} 命令"
    return await _to_thread(lambda: _local_run(f"{binary} -n {limit} -F -w"))


async def _to_thread(func) -> Tuple[bool, str]:
    import asyncio

    return await asyncio.to_thread(func)


async def local_sudo_events(hours: int = 24) -> List[Dict[str, Any]]:
    """本机 auth.log / secure 里的 sudo、su 事件。"""
    source = sshguard.log_source()
    if not source.get("available"):
        return []
    since = time.time() - max(1, hours) * 3600
    lines = await _to_thread(lambda: sshguard.read_lines(source, since))
    return parse_auth_events(lines)


async def remote_last(row: Dict[str, Any], kind: str = "success", limit: int = LAST_LIMIT) -> Tuple[bool, str]:
    binary = "lastb" if kind == "failed" else "last"
    prefix = sshremote._sudo_prefix(row)
    command = f"{prefix}{binary} -n {limit} -F -w"
    return await sshremote.run_command(row, command, timeout=20)


async def remote_sudo_events(row: Dict[str, Any], hours: int = 24) -> List[Dict[str, Any]]:
    since = time.time() - max(1, hours) * 3600
    command = sshremote.log_command(row, since)
    # 远程一次拿回全部日志行，再在本地筛 sudo —— 少一条命令，也少一处出错点
    ok, output = await sshremote.run_command(row, command, timeout=sshremote.LOG_TIMEOUT)
    if not ok:
        return []
    return parse_auth_events(output.splitlines())


async def host_rows(
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """可审计的主机：受管远程主机 + 本机（本机永远在最后）。

    ``host_ids=None`` = 不限（后台汇入任务用全量）；给了集合则只列集合里的
    受管主机，且只有集合含 ``"local"`` 时才带本机。
    """
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    rows: List[Dict[str, Any]] = []
    for row in await sshremote.list_hosts(include_disabled=False):
        if not row.get("enabled"):
            continue
        if wanted is not None and str(row.get("id")) not in wanted:
            continue
        rows.append(row)
    if wanted is None or "local" in wanted:
        rows.append({"id": "local", "name": "本机（面板）", "host": "localhost"})
    return rows


async def collect_logins(
    host_id: str, kind: str = "success", limit: int = LAST_LIMIT
) -> Dict[str, Any]:
    """某台主机的登录历史（原始记录，不写库）。"""
    if host_id == "local":
        ok, output = await local_last(kind, limit)
        name = "本机（面板）"
    else:
        row = await sshremote.get_host(host_id)
        if not row:
            return {"host_id": host_id, "ok": False, "error": "主机不存在", "entries": []}
        ok, output = await remote_last(row, kind, limit)
        name = str(row.get("name") or row.get("host") or host_id)
    if not ok:
        return {
            "host_id": host_id,
            "name": name,
            "ok": False,
            "error": output.strip()[:300],
            "entries": [],
        }
    entries = parse_last_output(output, kind)
    return {
        "host_id": host_id,
        "name": name,
        "ok": True,
        "error": "",
        "entries": entries[: max(1, min(1000, limit))],
        "generated_at": int(time.time()),
    }


async def collect_sudo(host_id: str, hours: int = 24) -> Dict[str, Any]:
    if host_id == "local":
        events = await local_sudo_events(hours)
        name = "本机（面板）"
    else:
        row = await sshremote.get_host(host_id)
        if not row:
            return {"host_id": host_id, "ok": False, "error": "主机不存在", "entries": []}
        events = await remote_sudo_events(row, hours)
        name = str(row.get("name") or row.get("host") or host_id)
    return {
        "host_id": host_id,
        "name": name,
        "ok": True,
        "error": "",
        "entries": events,
        "generated_at": int(time.time()),
    }


# ------------------------------------------------------- 汇入面板审计日志

async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def get_cursor(host_id: str) -> float:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT last_ts FROM host_audit_cursor WHERE host_id = ?", (host_id,)
        )
        row = await cursor.fetchone()
    return float(row["last_ts"] or 0) if row else 0.0


async def set_cursor(host_id: str, last_ts: float, detail: str = "") -> None:
    await init_table()
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "host_audit_cursor",
                ["host_id", "last_ts", "updated", "detail"],
                ["host_id"],
                ["last_ts", "updated", "detail"],
            ),
            (host_id, float(last_ts), int(time.time()), detail[:500]),
        )
        await db.commit()


async def _panel_user(os_user: str) -> str:
    """尽量把系统账号对应到面板账号；对不上就保留系统用户名。

    审计日志按面板用户名过滤，所以能对上就用面板名（否则会出现一个「不存在
    的用户」），对不上时保留原名并让 detail 里写清楚。
    """
    if not os_user:
        return ""
    record = await store.get_user(os_user)
    return str(record.get("username") or os_user) if record else os_user


async def import_events(
    host_id: Optional[str] = None,
    host_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """把主机级事件增量写入面板审计日志。

    每台主机一个游标（已导入的最大时间戳），所以重复调用不会重复写。
    """
    await init_table()
    rows = [
        row
        for row in await host_rows(host_ids)
        if host_id is None or row.get("id") == host_id
    ]
    flooding = await _alarming_ips()
    summary: Dict[str, Any] = {
        "hosts": len(rows),
        "imported": 0,
        "skipped": 0,
        "skipped_flood": 0,
        "details": [],
    }
    for row in rows:
        hid = str(row.get("id"))
        name = str(row.get("name") or row.get("host") or hid)
        cursor = await get_cursor(hid)
        # 首次导入只回溯最近几天，避免把几年的历史一下灌进审计表
        floor = cursor or (time.time() - IMPORT_LOOKBACK_DAYS * 86400)

        written = 0
        newest = cursor
        try:
            for kind, action in (("success", "host.ssh_login"), ("failed", "host.ssh_failed")):
                report = await collect_logins(hid, kind=kind, limit=LAST_LIMIT)
                if not report.get("ok"):
                    continue
                for entry in report.get("entries") or []:
                    ts = float(entry.get("start") or 0)
                    if ts <= floor or entry.get("kind") == "reboot":
                        continue
                    if (
                        action == "host.ssh_failed"
                        and str(entry.get("ip") or "") in flooding
                    ):
                        # 正在被爆破的 IP：别逐条写审计 —— 那条信息已经在 SSH 爆破
                        # 告警里（带失败次数），逐条写只会把审计表灌满。
                        newest = max(newest, ts)
                        summary["skipped_flood"] += 1
                        continue
                    await store.add_audit(
                        username=await _panel_user(str(entry.get("user") or "")),
                        action=action,
                        target=f"{entry.get('user') or '-'}@{name}",
                        result="success" if entry.get("success") else "failed",
                        detail=json.dumps(
                            {
                                "host": name,
                                "os_user": entry.get("user"),
                                "tty": entry.get("tty"),
                                "duration": entry.get("duration"),
                                "state": entry.get("state"),
                                "end": entry.get("end"),
                            },
                            ensure_ascii=False,
                        ),
                        ip=str(entry.get("ip") or ""),
                    )
                    written += 1
                    newest = max(newest, ts)
                    if written >= IMPORT_BATCH:
                        break

            sudo = await collect_sudo(hid, hours=IMPORT_LOOKBACK_DAYS * 24)
            for event in sudo.get("entries") or []:
                ts = float(event.get("ts") or 0)
                if ts <= floor:
                    continue
                await store.add_audit(
                    username=await _panel_user(str(event.get("user") or "")),
                    action="host.sudo",
                    target=f"{event.get('user') or '-'}@{name}"
                    + (f" → {event['target']}" if event.get("target") else ""),
                    result="success" if event.get("success") else "failed",
                    detail=json.dumps(
                        {
                            "host": name,
                            "os_user": event.get("user"),
                            "target_user": event.get("target"),
                            "tty": event.get("tty"),
                            "command": (event.get("command") or "")[:500],
                        },
                        ensure_ascii=False,
                    ),
                    ip="",
                )
                written += 1
                newest = max(newest, ts)
                if written >= IMPORT_BATCH * 2:
                    break
        except Exception as exc:  # noqa: BLE001 - 一台主机失败不能拖垮整体
            logger.warning("导入 %s 的登录审计失败：%s", name, exc)
            summary["details"].append({"host": name, "ok": False, "error": str(exc)[:200]})
            continue

        if written:
            await set_cursor(hid, newest, detail=f"imported {written}")
        summary["imported"] += written
        summary["details"].append({"host": name, "ok": True, "imported": written})
    return summary


async def _alarming_ips() -> set:
    """正在触发 SSH 爆破告警的 IP（这些来源的逐条失败不再写审计）。"""
    try:
        active = await alerting.load_active()
    except Exception:  # noqa: BLE001 - 告警表不可用时按「没有告警」处理
        return set()
    ips: set = set()
    for row in (active or {}).values():
        if str(row.get("rule_id")) == "ssh-fail" and row.get("ip"):
            ips.add(str(row["ip"]))
    return ips


async def cursor_status(
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """每台主机的导入进度（前端用来显示「已汇入到什么时候」）。"""
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM host_audit_cursor")
        rows = await cursor.fetchall()
    known = {str(r["host_id"]): dict(r) for r in rows}
    out: List[Dict[str, Any]] = []
    for row in await host_rows(host_ids):
        hid = str(row.get("id"))
        item = known.get(hid, {})
        out.append(
            {
                "host_id": hid,
                "name": str(row.get("name") or row.get("host") or hid),
                "last_ts": float(item.get("last_ts") or 0),
                "updated": int(item.get("updated") or 0),
            }
        )
    return out
