"""多机 SSH 安全：用 SSH 凭据去远程主机上读日志、管 fail2ban。

面板本机看的是自己（见 :mod:`app.sshguard`），其它宿主机靠这里：存 SSH 凭据、
连上去执行**固定几条命令**，把输出交给 sshguard 的解析器，得到与本机一致的
结构，再统一展示与告警。

三条底线：

1. **只跑我们拼好的命令**：IP、jail 名这类外部输入先过白名单正则，命令里
   不会出现用户可控的原文，也不用 `shell=True`。
2. **主机指纹要验**：第一次连接时记住指纹（需管理员显式确认），之后指纹变了
   一律拒绝 —— 中间人比暴力破解更隐蔽。
3. **口令与私钥加密落库**，接口只回 `secret_set`，明文永不回传前端。

paramiko 是阻塞库，所有调用都用 ``asyncio.to_thread`` 丢到线程里跑，
不堵住事件循环。
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

import paramiko

from . import alerting, crypto, database, sshguard, store

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ssh_hosts (
    id          VARCHAR(64) NOT NULL,
    name        VARCHAR(128) NOT NULL,
    host        VARCHAR(128) NOT NULL,
    port        INT DEFAULT 22,
    username    VARCHAR(64) NOT NULL DEFAULT 'root',
    auth_type   VARCHAR(16) DEFAULT 'key',
    secret      TEXT,
    use_sudo    TINYINT DEFAULT 0,
    log_source  VARCHAR(16) DEFAULT 'auto',
    enabled     TINYINT DEFAULT 1,
    known_host  VARCHAR(128) DEFAULT '',
    updated     BIGINT,
    updated_by  VARCHAR(64) DEFAULT '',
    PRIMARY KEY (id),
    KEY idx_ssh_hosts_host (host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# 远程命令的超时：日志可能很大，但也不该拖死面板
DEFAULT_TIMEOUT = 20
LOG_TIMEOUT = 30

# 日志读取：优先 journalctl（systemd 通用），拿不到再 tail 日志文件
READ_LOG_CMD = (
    "journalctl -u ssh -u sshd --since @{since} -o short-iso --no-pager -n 20000"
    " || tail -n 20000 /var/log/secure 2>/dev/null || tail -n 20000 /var/log/auth.log 2>/dev/null"
)


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        await db.commit()


# ------------------------------------------------------------------ 主机 CRUD

def public_host(row: Dict[str, Any]) -> Dict[str, Any]:
    """对外只暴露「是否设置了凭据」，私钥 / 口令永不回传。"""
    secret = str(row.get("secret") or "")
    return {
        "id": str(row.get("id") or ""),
        "name": str(row.get("name") or ""),
        "host": str(row.get("host") or ""),
        "port": int(row.get("port") or 22),
        "username": str(row.get("username") or ""),
        "auth_type": "password" if str(row.get("auth_type")) == "password" else "key",
        "use_sudo": bool(row.get("use_sudo")),
        "log_source": str(row.get("log_source") or "auto"),
        "enabled": bool(row.get("enabled", True)),
        "known_host": str(row.get("known_host") or ""),
        "secret_set": bool(secret),
        "updated": int(row.get("updated") or 0),
        "updated_by": str(row.get("updated_by") or ""),
    }


def normalise_host(raw: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = raw or {}
    current = base or {}
    host = str(item.get("host") or current.get("host") or "").strip()
    if not host:
        raise ValueError("主机地址不能为空")
    if not re.match(r"^[A-Za-z0-9._-]{1,128}$", host):
        raise ValueError("主机地址不合法（只允许域名、IP、点、横线、下划线）")
    try:
        port = int(item.get("port") or current.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    auth_type = str(item.get("auth_type") or current.get("auth_type") or "key").strip().lower()
    if auth_type not in ("key", "password"):
        auth_type = "key"
    log_source = str(item.get("log_source") or current.get("log_source") or "auto").strip().lower()
    if log_source not in ("auto", "journalctl", "secure", "auth.log"):
        log_source = "auto"
    secret = item.get("secret")
    # secret 留空表示沿用旧值
    stored = str(current.get("secret") or "")
    if secret in (None, "", "__UNCHANGED__"):
        new_secret = stored
    else:
        new_secret = crypto.encrypt(str(secret))
    return {
        "id": str(item.get("id") or current.get("id") or ("h" + uuid.uuid4().hex[:10])),
        "name": str(item.get("name") or current.get("name") or host).strip()[:128],
        "host": host,
        "port": max(1, min(65535, port)),
        "username": str(item.get("username") or current.get("username") or "root").strip()[:64],
        "auth_type": auth_type,
        "secret": new_secret,
        "use_sudo": 1 if bool(item.get("use_sudo", current.get("use_sudo", False))) else 0,
        "log_source": log_source,
        "enabled": 1 if bool(item.get("enabled", current.get("enabled", True))) else 0,
        "known_host": str(item.get("known_host") or current.get("known_host") or "").strip()[:128],
        "updated": int(time.time()),
        "updated_by": str(item.get("updated_by") or current.get("updated_by") or "").strip()[:64],
    }


async def list_hosts(include_disabled: bool = True) -> List[Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute(
            "SELECT * FROM ssh_hosts" + ("" if include_disabled else " WHERE enabled = 1")
            + " ORDER BY name"
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_host(host_id: str) -> Optional[Dict[str, Any]]:
    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM ssh_hosts WHERE id = ?", (host_id,))
        row = await cursor.fetchone()
    return dict(row) if row else None


async def find_by_address(address: str) -> Optional[Dict[str, Any]]:
    for row in await list_hosts():
        if row.get("host") == address:
            return row
    return None


async def save_host(raw: Dict[str, Any], username: str = "") -> Dict[str, Any]:
    await init_table()
    current = await get_host(str(raw.get("id") or "")) if raw.get("id") else None
    item = normalise_host({**raw, "updated_by": username}, current)
    async with database.connect() as db:
        await db.execute(
            database.upsert_sql(
                "ssh_hosts",
                list(item.keys()),
                ["id"],
                [key for key in item.keys() if key != "id"],
            ),
            tuple(item.values()),
        )
        await db.commit()

    # 归属只在**新建**时写入：编辑一台别人的主机不该把归属改成编辑者
    # （归属改由管理员的「指派」接口负责）。
    if current is None and username:
        from . import ownership

        await ownership.set_owner(
            ownership.KIND_SSH_HOST, str(item.get("id") or ""), username
        )
    return item


async def delete_host(host_id: str) -> int:
    from . import ownership

    await init_table()
    async with database.connect() as db:
        cursor = await db.execute("DELETE FROM ssh_hosts WHERE id = ?", (host_id,))
        removed = cursor.rowcount or 0
        await db.commit()
    # 归属记录一并清掉：留着会让「同一个 id 又被创建出来」时继承到旧归属
    if removed:
        await ownership.delete_owner(ownership.KIND_SSH_HOST, host_id)
    return removed


def decrypt_secret(row: Dict[str, Any]) -> str:
    raw = str(row.get("secret") or "")
    if not raw:
        return ""
    if crypto.is_encrypted(raw):
        return crypto.decrypt(raw)
    return raw  # 历史明文（不应出现）


# ------------------------------------------------------------------ SSH 连接

class FingerprintMismatch(RuntimeError):
    """主机指纹与库里记录的不一致 —— 可能是中间人。"""


class _CapturePolicy(paramiko.MissingHostKeyPolicy):
    """记录对端指纹：库里有就比对，没有就先记下来让调用方决定。"""

    def __init__(self, expected: str = "") -> None:
        self.expected = expected
        self.seen = ""

    def missing_host_key(self, client, hostname, key) -> None:  # noqa: ANN001
        fingerprint = _fingerprint(key)
        self.seen = fingerprint
        if self.expected and self.expected != fingerprint:
            raise FingerprintMismatch(
                f"主机指纹与记录不一致（记录 {self.expected}，实际 {fingerprint}）："
                "可能遭遇中间人攻击；确认是换过 SSH 主机密钥后再重新信任。"
            )


def _fingerprint(key: Any) -> str:
    import base64
    import hashlib

    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def _load_key(text: str) -> Any:
    """逐个尝试常见密钥类型。

    用 ``getattr`` 取类：paramiko 各版本的类名并不一致（5.x 已经没有 DSSKey），
    直接写 ``paramiko.DSSKey`` 会在构造候选列表时就抛 AttributeError。
    """
    loaders = [
        cls
        for cls in (
            getattr(paramiko, name, None)
            for name in ("Ed25519Key", "RSAKey", "ECDSAKey", "DSSKey")
        )
        if cls is not None
    ]
    for loader in loaders:
        try:
            return loader.from_private_key(io.StringIO(text))
        except Exception:  # noqa: BLE001 - 逐个尝试各种密钥类型
            continue
    raise ValueError("私钥格式无法识别（支持 Ed25519 / RSA / ECDSA；PEM 或 OpenSSH 格式）")


def server_key_fingerprint(client: paramiko.SSHClient) -> str:
    """直接问已建立的连接要对端主机密钥指纹。

    **不能只依赖 ``_CapturePolicy`` 的回调**：paramiko 只在「密钥不在已知列表里」
    时才回调它。只要目标主机出现在面板本机的 ``~/.ssh/known_hosts`` 中，回调就不会
    触发、``policy.seen`` 是空串，于是「确认并信任」会返回成功却什么也没记下来
    （指纹字段留空、界面上的「未确认」永远消不掉）。所以指纹一律以 transport 为准。
    """
    try:
        transport = client.get_transport()
        key = transport.get_remote_server_key() if transport is not None else None
    except Exception:  # noqa: BLE001 - 取不到指纹不该让连接本身失败
        return ""
    return _fingerprint(key) if key is not None else ""


def _connect(row: Dict[str, Any], trust_first: bool = False) -> Tuple[paramiko.SSHClient, str]:
    """建立 SSH 连接（阻塞，调用方负责 to_thread）。

    刻意**不**调用 ``load_system_host_keys()``：面板只信自己库里的那份指纹（TOFU）。
    引入系统 known_hosts 会有两个副作用 —— 命中条目时绕过策略回调（指纹取不到，
    见 :func:`server_key_fingerprint`），以及密钥轮换后由 paramiko 直接抛
    ``BadHostKeyException``，让界面上的「重新信任」失灵。信任来源必须唯一。
    """
    client = paramiko.SSHClient()
    policy = _CapturePolicy(str(row.get("known_host") or ""))
    client.set_missing_host_key_policy(policy)
    kwargs: Dict[str, Any] = {
        "hostname": str(row.get("host") or ""),
        "port": int(row.get("port") or 22),
        "username": str(row.get("username") or "root"),
        "timeout": DEFAULT_TIMEOUT,
        "banner_timeout": DEFAULT_TIMEOUT,
        "auth_timeout": DEFAULT_TIMEOUT,
        "allow_agent": False,
        "look_for_keys": False,
    }
    secret = decrypt_secret(row)
    if str(row.get("auth_type")) == "password":
        kwargs["password"] = secret
        if not secret:
            raise ValueError("该主机使用口令登录，但没保存口令")
    elif secret:
        kwargs["pkey"] = _load_key(secret)
    try:
        client.connect(**kwargs)
    except FingerprintMismatch:
        client.close()
        raise
    except Exception as exc:  # noqa: BLE001
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"SSH 连接失败：{exc}") from exc
    fingerprint = (
        server_key_fingerprint(client)
        or policy.seen
        or str(row.get("known_host") or "")
    )
    if not row.get("known_host") and not trust_first:
        # 第一次连接：没有指纹记录且未授权信任 → 断开，把指纹交给调用方确认
        client.close()
        raise RuntimeError(
            "首次连接该主机，需要先确认指纹 " + fingerprint
            + "（在主机管理里点「确认并信任」）"
        )
    return client, fingerprint


def _sudo_prefix(row: Dict[str, Any]) -> str:
    return "sudo -n " if row.get("use_sudo") else ""


def run_command_sync(
    row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT
) -> Tuple[bool, str]:
    """在远程主机上跑一条命令（阻塞版本）。返回 (成功?, 输出)。"""
    client, _ = _connect(row)
    try:
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    text = (out or "") + (err or "")
    return code == 0, text


async def run_command(row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT) -> Tuple[bool, str]:
    return await asyncio.to_thread(run_command_sync, row, command, timeout)


async def open_command(
    row: Dict[str, Any], command: str, timeout: float = DEFAULT_TIMEOUT
) -> Tuple[paramiko.SSHClient, Any, Any]:
    """打开一条远程命令，返回 ``(client, stdout, stderr)`` 供调用方边读边转发。

    与 :func:`run_command` 的区别是**不把输出读进内存**：备份归档动辄几个 GB，
    整份读进来会把面板内存吃光。三条约定：

    * 读取请用 ``await asyncio.to_thread(stdout.read, chunk)`` —— paramiko 的读取
      是阻塞的，直接在事件循环里调用会卡住所有请求；
    * 命令的退出码要在读完 stdout 之后用 ``stdout.channel.recv_exit_status()`` 取，
      失败信息在 ``stderr``；
    * 调用方必须在 ``finally`` 里 ``client.close()``，否则连接会一直挂着。
    """
    client, _ = await asyncio.to_thread(_connect, row)
    try:
        _stdin, stdout, stderr = await asyncio.to_thread(
            client.exec_command, command, timeout=timeout
        )
    except Exception:  # noqa: BLE001 - 打开失败也要把连接关掉
        client.close()
        raise
    return client, stdout, stderr


async def write_file_sync(row: Dict[str, Any], path: str, content: str) -> Tuple[bool, str]:
    """写远程文件：先用 SFTP，失败再退回 sudo tee（口令 / 非 root 场景）。"""
    client, _ = _connect(row)
    try:
        try:
            sftp = client.open_sftp()
            with sftp.open(path, "w") as handle:
                handle.write(content)
            sftp.close()
            return True, ""
        except Exception as exc:  # noqa: BLE001 - 权限不足等情况
            fallback_error = str(exc)
    finally:
        client.close()
    # 退回：把内容交给远程的 tee（内容由面板生成，不含用户输入）
    command = f"{_sudo_prefix(row)}tee {path} > /dev/null"
    client, _ = _connect(row)
    try:
        _, stdout, stderr = client.exec_command(command, timeout=DEFAULT_TIMEOUT)
        stdout.channel.send(content.encode("utf-8"))
        stdout.channel.shutdown_write()
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    if code != 0:
        return False, f"SFTP 写入失败（{fallback_error}），tee 也失败：{err.strip()}"
    return True, ""


async def write_file(row: Dict[str, Any], path: str, content: str) -> Tuple[bool, str]:
    return await asyncio.to_thread(write_file_sync, row, path, content)


async def test_host(row: Dict[str, Any], trust_first: bool = False) -> Dict[str, Any]:
    """连通性自检：能连上吗、是谁、有没有 fail2ban、日志源是什么。"""
    try:
        client, fingerprint = await asyncio.to_thread(_connect, row, trust_first)
    except Exception as exc:  # noqa: BLE001 - 各种网络/认证错误都要给成人话
        return {"ok": False, "detail": str(exc), "fingerprint": ""}
    try:
        commands = {
            "hostname": "hostname",
            "user": "whoami",
            "fail2ban": f"{_sudo_prefix(row)}fail2ban-client --version",
            "journal": "command -v journalctl",
            "secure": "test -r /var/log/secure && echo readable",
            "authlog": "test -r /var/log/auth.log && echo readable",
        }
        result: Dict[str, Any] = {"ok": True, "detail": "", "fingerprint": fingerprint}
        for key, command in commands.items():
            ok, out = await run_command(row, command, timeout=10)
            result[key] = out.strip() if ok else ""
        result["sudo_works"] = bool(result["user"]) and str(result["user"]).strip() != ""
        return result
    finally:
        client.close()


async def trust_fingerprint(row: Dict[str, Any]) -> Dict[str, Any]:
    """显式确认并记住指纹（首次连接后调用一次）。"""
    try:
        client, fingerprint = await asyncio.to_thread(_connect, row, True)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": str(exc), "fingerprint": ""}
    client.close()
    if not fingerprint:
        # 宁可报错也不能「成功但没记下」：那会让界面上的「未确认」永远消不掉，
        # 用户点多少次都像没反应。
        return {
            "ok": False,
            "fingerprint": "",
            "detail": "没能从这台主机取到 SSH 指纹：请确认地址、端口与 SSH 服务正常后重试",
        }
    await save_host({**row, "known_host": fingerprint}, row.get("updated_by") or "")
    return {"ok": True, "fingerprint": fingerprint, "detail": "已记录主机指纹"}


# ------------------------------------------------------------- 远程日志与统计

def log_command(row: Dict[str, Any], since_ts: float) -> str:
    source = str(row.get("log_source") or "auto")
    prefix = _sudo_prefix(row)
    if source == "secure":
        return f"{prefix}tail -n 20000 /var/log/secure 2>/dev/null"
    if source == "auth.log":
        return f"{prefix}tail -n 20000 /var/log/auth.log 2>/dev/null"
    if source == "journalctl":
        return f"{prefix}journalctl -u ssh -u sshd --since @{int(since_ts)} -o short-iso --no-pager -n 20000"
    return prefix + READ_LOG_CMD.format(since=int(since_ts))


async def remote_report(row: Dict[str, Any], hours: int = 24) -> Dict[str, Any]:
    """在远程主机上取日志并聚合，结构与本机 collect() 一致。"""
    since_ts = time.time() - max(1, min(168, hours)) * 3600
    try:
        ok, output = await run_command(row, log_command(row, since_ts), timeout=LOG_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - 连接/认证/超时都按「这台读不到」处理，不能让整页 500
        ok, output = False, str(exc)
    report: Dict[str, Any] = {
        "host_id": row.get("id"),
        "host": row.get("host"),
        "name": row.get("name"),
        "ok": ok,
        "error": "" if ok else output.strip()[:300],
        "source": {
            "kind": "ssh",
            "path": str(row.get("host") or ""),
            "label": f"ssh://{row.get('username')}@{row.get('host')}",
            "available": ok,
            "host": str(row.get("name") or row.get("host") or ""),
            "detail": "远程执行" if ok else output.strip()[:200],
        },
        "summary": {"failures": 0, "distinct_ips": 0, "distinct_users": 0, "logins": 0},
        "top_ips": [],
        "top_users": [],
        "logins": [],
        "since": int(since_ts),
        "generated_at": int(time.time()),
    }
    if not ok:
        return report
    events = sshguard.parse_lines(output.splitlines())
    policy = await sshguard.load_policy()
    aggregated = sshguard.aggregate(
        events, since_ts, sshguard.split_ips(policy.get("ignore_ips", ""))
    )
    report.update(aggregated)
    report["source"] = {
        "kind": "ssh",
        "path": str(row.get("host") or ""),
        "label": f"ssh://{row.get('username')}@{row.get('host')}",
        "available": True,
        "host": str(row.get("name") or row.get("host") or ""),
        "detail": "",
    }
    return report


# ----------------------------------------------------------------- fail2ban

def _fail2ban_cmd(row: Dict[str, Any], args: str) -> str:
    return f"{_sudo_prefix(row)}fail2ban-client {args}"


async def remote_fail2ban_status(row: Dict[str, Any]) -> Dict[str, Any]:
    ok, output = await run_command(row, _fail2ban_cmd(row, "status"))
    policy = await sshguard.load_policy()
    base: Dict[str, Any] = {
        "installed": ok,
        "running": ok,
        "jails": [],
        "details": [],
        "preferred": policy.get("jail") or "",
        "host": str(row.get("name") or row.get("host") or ""),
        "binary": "",
        "checked": [],
        "hint": "" if ok else "远程主机上执行 fail2ban-client 失败：" + output.strip()[:200],
    }
    if not ok:
        return base
    match = re.search(r"Jail list:\s*(.*)", output)
    jails = [name.strip() for name in (match.group(1).split(",") if match else []) if name.strip()]
    base["jails"] = jails
    preferred = base["preferred"] if base["preferred"] in jails else ""
    if not preferred:
        ssh_jails = [name for name in jails if "ssh" in name.lower()]
        preferred = ssh_jails[0] if ssh_jails else (jails[0] if jails else "")
    base["preferred"] = preferred
    details: List[Dict[str, Any]] = []
    for name in jails:
        if not sshguard.JAIL_NAME_RE.match(name):
            continue
        jail_ok, jail_out = await run_command(row, _fail2ban_cmd(row, f"status {name}"))
        if not jail_ok:
            continue
        parsed = sshguard.parse_jail_status(jail_out)
        parsed["jail"] = parsed.get("jail") or name
        details.append(parsed)
    base["details"] = details
    return base


async def remote_fail2ban_action(
    row: Dict[str, Any], action: str, jail: str = "", ip: str = ""
) -> Dict[str, Any]:
    """对某个 jail 做封禁 / 解封，或整体 reload（reload 不需要 jail）。"""
    if action not in ("ban", "unban", "reload"):
        raise ValueError("不支持的操作：" + action)
    if action == "reload":
        ok, out = await run_command(row, _fail2ban_cmd(row, "reload"))
        if not ok:
            raise RuntimeError(out.strip()[:200])
        return {"ok": True, "detail": out.strip()[:200]}
    if not sshguard.JAIL_NAME_RE.match(jail or ""):
        raise ValueError("jail 名称不合法")
    if not sshguard.IP_RE.match(ip or ""):
        raise ValueError("IP 地址不合法")
    ok, out = await run_command(
        row, _fail2ban_cmd(row, f"set {jail} {'banip' if action == 'ban' else 'unbanip'} {ip}")
    )
    if not ok:
        raise RuntimeError(out.strip()[:200])
    return {"ok": True, "detail": out.strip()[:200]}


async def remote_write_jail(
    row: Dict[str, Any], jail: str, maxretry: int, findtime: int, bantime: int
) -> Dict[str, Any]:
    policy = await sshguard.load_policy()
    content = sshguard.render_jail_config(
        jail, maxretry, findtime, bantime, policy.get("ignore_ips", "")
    )
    path = sshguard.jail_file_path(jail)
    ok, detail = await write_file(row, path, content)
    if not ok:
        raise RuntimeError(detail)
    reload_ok, out = await run_command(row, _fail2ban_cmd(row, "reload"))
    if not reload_ok:
        raise RuntimeError("配置已写入，但 reload 失败：" + out.strip()[:200])
    return {"ok": True, "path": path, "config": content, "detail": out.strip()[:200]}


# --------------------------------------------------------------- 多机聚合

async def fleet_reports(
    hours: Optional[int] = None,
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """并发拉取启用主机的报告（远程 + 本机）。

    ``host_ids`` 为 ``None`` = 不限（后台告警任务用全量）；给了集合就只拉集合
    里的主机，且**只有集合里含 "local" 时才带本机** —— 与
    :mod:`app.baseline` / :mod:`app.portguard` 的同名参数保持同一套语义，
    普通用户因此拿不到面板本机那一份。
    """
    policy = await sshguard.load_policy()
    window = hours or int(policy["window_hours"])
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    hosts = [
        row
        for row in await list_hosts(include_disabled=False)
        if row.get("enabled") and (wanted is None or str(row.get("id")) in wanted)
    ]
    include_local = wanted is None or "local" in wanted
    reports: List[Dict[str, Any]] = []

    if hosts:
        results = await asyncio.gather(
            *[remote_report(row, window) for row in hosts], return_exceptions=True
        )
        for row, result in zip(hosts, results):
            if isinstance(result, Exception):
                reports.append(
                    {
                        "host_id": row.get("id"),
                        "host": row.get("host"),
                        "name": row.get("name"),
                        "ok": False,
                        "error": str(result)[:200],
                        "source": {
                            "kind": "ssh",
                            "label": f"ssh://{row.get('username')}@{row.get('host')}",
                            "available": False,
                            "host": str(row.get("name") or ""),
                            "detail": str(result)[:200],
                        },
                        "summary": {
                            "failures": 0,
                            "distinct_ips": 0,
                            "distinct_users": 0,
                            "logins": 0,
                        },
                        "top_ips": [],
                        "top_users": [],
                        "logins": [],
                    }
                )
            else:
                reports.append(result)

    if not include_local:
        return reports

    local = await sshguard.collect(window)
    local["host_id"] = "local"
    local["name"] = local["source"].get("host") or "本机（面板）"
    local["host"] = local["source"].get("host") or "localhost"
    local["ok"] = bool(local["source"].get("available"))
    local["error"] = "" if local["ok"] else str(local["source"].get("detail") or "本机日志不可用")
    reports.append(local)
    return reports


async def fleet_overview(
    hours: Optional[int] = None,
    host_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """多机概览：每台主机的统计 + fail2ban 状态。"""
    reports = await fleet_reports(hours, host_ids)
    hosts_payload: List[Dict[str, Any]] = []
    for report in reports:
        fail2ban: Dict[str, Any] = {"installed": False, "running": False, "jails": [], "details": [], "preferred": "", "hint": ""}
        row = None
        if report.get("host_id") != "local":
            row = await get_host(str(report.get("host_id") or ""))
        if row is not None and report.get("ok"):
            fail2ban = await remote_fail2ban_status(row)
        elif report.get("host_id") == "local":
            fail2ban = await sshguard.fail2ban_status()
        hosts_payload.append(
            {
                "id": report.get("host_id"),
                "name": report.get("name"),
                "host": report.get("host"),
                "ok": bool(report.get("ok")),
                "error": report.get("error") or "",
                "source": report.get("source"),
                "summary": report.get("summary"),
                "top_ips": (report.get("top_ips") or [])[:20],
                "fail2ban": fail2ban,
            }
        )
    totals = {
        "hosts": len(hosts_payload),
        "reachable": sum(1 for item in hosts_payload if item["ok"]),
        "failures": sum(int(item["summary"]["failures"]) for item in hosts_payload),
        "distinct_ips": sum(int(item["summary"]["distinct_ips"]) for item in hosts_payload),
        "logins": sum(int(item["summary"]["logins"]) for item in hosts_payload),
        "banned": sum(
            sum(int(jail.get("currently_banned") or 0) for jail in item["fail2ban"].get("details") or [])
            for item in hosts_payload
        ),
    }
    return {"hosts": hosts_payload, "totals": totals, "generated_at": int(time.time())}


# --------------------------------------------------------------- 多机告警

async def evaluate_fleet() -> List[Dict[str, Any]]:
    """按主机维度检查远程主机的 SSH 异常并告警。"""
    policy = await sshguard.load_policy()
    if not policy.get("enabled"):
        return []
    await sshguard.init_table()
    target_owner = policy.get("notify_user") or await store.first_admin_username() or ""
    feishu = await alerting.load_feishu(target_owner)
    email_cfg = await alerting.load_alert_email(target_owner)
    cooldown = int(policy["cooldown_minutes"]) * 60
    threshold = int(policy["max_failures"])
    now = time.time()
    fired: List[Dict[str, Any]] = []

    active = {
        key: row
        for key, row in (await alerting.load_active()).items()
        if str(row.get("target_type")) == "ssh"
    }
    still: set = set()

    for report in await fleet_reports():
        if not report.get("ok"):
            continue
        if report.get("host_id") == "local":
            continue  # 本机由 sshguard.evaluate() 负责，避免重复告警
        label = str(report.get("name") or report.get("host") or "")
        for row in report.get("top_ips") or []:
            if row["count"] < threshold:
                continue
            ip = row["ip"]
            key = alerting.alarm_key(target_owner, "ssh-fail", f"{label}:{ip}")
            still.add(key)
            # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
            prev = active.get(key) or {}
            last = float(prev.get("ts") or 0)
            if now - last < cooldown:
                continue
            card = alerting.build_card(
                "critical" if row["count"] >= threshold * 2 else "warning",
                "🛡 ProxCenter SSH 爆破告警",
                f"{label}：{ip} 失败 {row['count']} 次",
                [
                    ("主机", label),
                    ("来源 IP", ip),
                    ("失败次数", f"**{row['count']}**（阈值 {threshold}）"),
                    ("统计窗口", f"最近 {policy['window_hours']} 小时"),
                    ("尝试的用户名", "、".join(row["users"][:8]) or "-"),
                    ("发生时间", alerting._now_text(now)),
                ],
                "可在「SSH 安全」页对该主机一键封禁，或用 fail2ban 自动封禁。",
            )
            text = (
                f"SSH 爆破告警（{label}）：{ip} 在 {policy['window_hours']} 小时内失败"
                f" {row['count']} 次（阈值 {threshold}）\n"
                f"尝试的用户名：{'、'.join(row['users'][:8])}"
            )
            ok, detail = await alerting.dispatch(
                target_owner,
                feishu,
                email_cfg,
                f"SSH 爆破告警 {label}/{ip}",
                text,
                card,
                source=alerting.SOURCE_SSHREMOTE,
            )
            state = {
                "username": target_owner,
                "rule_id": "ssh-fail",
                "rule_name": "SSH 登录失败次数",
                "target_type": "ssh",
                "target": f"{label}:{ip}",
                "metric": "ssh_fail",
                "value": row["count"],
                "threshold": threshold,
                "node": label,
                "ip": ip,
                "vmid": None,
                "ts": int(now),
                "notify_source": alerting.SOURCE_SSHREMOTE,
            }
            await alerting.mark_active(key, state)
            active[key] = dict(state, alarm_key=key)
            entry = {
                **state,
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "alarm",
            }
            await alerting.record(
                entry, source=alerting.SOURCE_SSHREMOTE, repeat=bool(prev)
            )
            entry["text"] = text
            fired.append(entry)

    # 恢复：本轮不再超阈值的
    for key, row in list(active.items()):
        if row.get("rule_id") != "ssh-fail" or key in still:
            continue
        if ":" not in str(row.get("target") or ""):
            continue  # 本机告警由 sshguard 处理
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
            source=alerting.SOURCE_SSHREMOTE,
        )
        await alerting.record(
            {
                "username": target_owner,
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
            source=alerting.SOURCE_SSHREMOTE,
        )
        await alerting.clear_active(key)
        fired.append({"kind": "recovery", "target": row.get("target"), "text": text})
    return fired
