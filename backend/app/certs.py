"""网站证书管理：腾讯云免费证书的申请、下载、部署与自动续期。

设计要点：

* **站点配置**存 ``settings`` 表（key = ``cert_sites``），一个站点对应
  一个域名 + 一个部署目录 + 可选的部署后重载命令；
* **按用户隔离**：站点带 ``username`` 归属，腾讯云密钥按用户分别存放
  （``cert_tencent:<username>``），每个用户用自己的账号申请与部署证书；
* **腾讯云密钥**（SecretId/SecretKey）复用 :mod:`app.crypto` 加密后落库，
  与飞书 Webhook 一致，接口不回传明文；
* **部署**是把下载到的证书链/私钥写入目标目录（原子替换 + 权限收敛），
  再执行用户配置的重载命令（如 ``nginx -s reload``）；
* **自动续期**由 :func:`renew_tick` 驱动：证书剩余天数小于阈值时先用
  ``OldCertificateId`` 申请续期证书，待 CA 签发成功后自动下载并部署。
  免费证书有效期只有 90 天，这一步是必须的。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


from . import crypto, database, formatters, i18n, store
from .pve import ProxmoxError, get_client
from .tencent_ssl import (
    STATUS_FAILED,
    STATUS_ISSUED,
    STATUS_PENDING,
    TencentCloudError,
    TencentSslClient,
    parse_certificate_bundle,
    status_text,
)

logger = logging.getLogger(__name__)

SETTING_KEY = "cert_sites"
# 腾讯云配置按用户存：key = "cert_tencent:<username>"
TENCENT_KEY_PREFIX = "cert_tencent:"
# 升级前的那份全局（无归属）腾讯云配置，仅作为首个管理员的兜底回退
LEGACY_TENCENT_KEY = "cert_tencent"


# --------------------------------------------------------------- 归属（分用户）
def tencent_key(owner: str) -> str:
    """腾讯云密钥的存储 key：每个用户各自一份。"""
    return TENCENT_KEY_PREFIX + str(owner or "")


def site_owner(site: Dict[str, Any]) -> str:
    """站点归属的用户名；旧数据没有归属时为空串。"""
    return str((site or {}).get("username") or "").strip()

# 部署后重载命令的超时时间
RELOAD_TIMEOUT = 30
# 腾讯云返回的时间是北京时间
CN_TZ = timezone(timedelta(hours=8))

DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
# 部署目录：绝对路径，禁止 .. 与 shell 元字符（路径会被拼进远程命令）
DEPLOY_DIR_RE = re.compile(r"^/[A-Za-z0-9._/@+-]*(/[A-Za-z0-9._@+-]+)*$")

# 支持三种部署方式
DEPLOY_METHODS = ("local", "ssh", "agent")
DEPLOY_METHOD_LABELS = {
    "local": "本机目录（面板所在服务器）",
    "ssh": "SSH 远程服务器",
    "agent": "Proxmox 虚拟机（QEMU Guest Agent）",
}

# 站点里需要加密存储的字段
SITE_SECRETS = ("ssh_password", "ssh_key")
SSH_AUTH_METHODS = ("password", "key")

DEFAULT_TENCENT: Dict[str, Any] = {
    "secret_id": "",
    "secret_key": "",
    "dv_auth_method": "DNS_AUTO",
    "encrypt_algo": "RSA",
    "renew_before_days": 15,
}

DEFAULT_SITE: Dict[str, Any] = {
    "id": "",
    "name": "",
    # 归属：站点由谁创建就归谁，管理员可代为管理（不改变归属）
    "username": "",
    "domain": "",
    "cert_id": "",
    "pending_cert_id": "",
    # 部署方式：local（面板本机）/ ssh（远程服务器）/ agent（PVE 虚拟机 Guest Agent）
    "deploy_method": "local",
    "deploy_dir": "",
    "cert_filename": "fullchain.pem",
    "key_filename": "privkey.pem",
    "reload_command": "",
    # --- SSH 远程部署 ---
    "ssh_host": "",
    "ssh_port": 22,
    "ssh_user": "root",
    "ssh_auth": "password",  # password | key
    "ssh_password": "",
    "ssh_key": "",
    "ssh_host_key": "",  # 首次连接后记录的主机指纹（TOFU）
    # --- PVE 虚拟机 Guest Agent 部署 ---
    "agent_node": "",
    "agent_vmid": "",
    "auto_renew": True,
    "renew_before_days": 0,  # 0 = 跟随全局设置
    "enabled": True,
    "notes": "",
    # 运行时状态
    "cert_status": -1,
    "cert_status_text": "",
    "cert_domain": "",
    "expire_at": 0,
    "last_deploy_at": 0,
    "last_check_at": 0,
    "last_error": "",
}


class CertError(ValueError):
    """证书配置或部署过程中的错误。"""


class ReloadError(CertError):
    """证书文件已经写到位，但重载命令执行失败。"""


# ------------------------------------------------------------------ 基础工具
def now_ts() -> int:
    return int(time.time())


def _new_id() -> str:
    return secrets.token_hex(6)


def parse_cn_time(value: Any) -> int:
    """把腾讯云的 ``2025-05-14 07:59:59``（北京时间）转成时间戳。"""
    text = str(value or "").strip()
    if not text or text in ("--", "-"):
        return 0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(text, fmt).replace(tzinfo=CN_TZ).timestamp())
        except ValueError:
            continue
    return 0


def normalise_domain(raw: Any) -> str:
    """规整域名：允许粘贴完整 URL，去掉协议、路径与端口。"""
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"^[a-z]+://", "", text)
    text = text.split("/")[0].split("?")[0]
    text = text.split(":")[0].strip().rstrip(".")
    if not text:
        return ""
    if text.startswith("*."):
        raise CertError("腾讯云免费证书不支持泛域名（*.example.com），请填写具体域名")
    if not DOMAIN_RE.match(text):
        raise CertError(i18n.tr("域名格式不正确：") + text)
    if len(text) > 64:
        raise CertError("域名长度不能超过 64 个字符")
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", text):
        raise CertError("免费证书不支持 IP 地址")
    return text


def _safe_filename(raw: Any, default: str) -> str:
    text = str(raw or "").strip() or default
    if not FILENAME_RE.match(text):
        raise CertError(
            i18n.tr("文件名只能包含字母、数字、点、下划线和短横线：") + text
        )
    return text


def normalise_site(raw: Dict[str, Any], existing: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    site = dict(DEFAULT_SITE)
    if existing:
        site.update(existing)
    site.update({k: v for k, v in item.items() if k in DEFAULT_SITE})

    site["id"] = str(existing.get("id") if existing and existing.get("id") else item.get("id") or _new_id())
    site["name"] = str(item.get("name") or site.get("name") or "").strip()[:60]
    # 归属只由服务端决定：编辑沿用原归属，新站点由接口层补上创建者
    site["username"] = site_owner(existing) if existing else ""

    domain = normalise_domain(item.get("domain", site.get("domain")))
    if not domain:
        raise CertError("请填写要签发证书的域名")
    site["domain"] = domain
    if not site["name"]:
        site["name"] = domain

    method = str(item.get("deploy_method", site.get("deploy_method")) or "local").lower()
    if method not in DEPLOY_METHODS:
        raise CertError("部署方式只能是 本机目录 / SSH 远程 / Proxmox 虚拟机")
    site["deploy_method"] = method

    deploy_dir = str(item.get("deploy_dir", site.get("deploy_dir")) or "").strip()
    if not deploy_dir:
        raise CertError("请填写证书部署目录")
    if not deploy_dir.startswith("/"):
        raise CertError("部署目录必须是绝对路径，例如 /etc/nginx/ssl")
    deploy_dir = deploy_dir.rstrip("/") or "/"
    if not DEPLOY_DIR_RE.match(deploy_dir) or any(
        part in (".", "..") for part in deploy_dir.split("/")
    ):
        raise CertError("部署目录只能包含字母、数字与 . _ - @ + /，且不能包含 . 或 .. 路径片段")
    site["deploy_dir"] = deploy_dir

    site["cert_filename"] = _safe_filename(
        item.get("cert_filename", site.get("cert_filename")), "fullchain.pem"
    )
    site["key_filename"] = _safe_filename(
        item.get("key_filename", site.get("key_filename")), "privkey.pem"
    )
    if site["cert_filename"] == site["key_filename"]:
        raise CertError("证书文件名与私钥文件名不能相同")

    site["reload_command"] = str(item.get("reload_command", site.get("reload_command")) or "").strip()[:400]
    site["auto_renew"] = bool(item.get("auto_renew", site.get("auto_renew", True)))
    site["enabled"] = bool(item.get("enabled", site.get("enabled", True)))
    site["notes"] = str(item.get("notes", site.get("notes")) or "").strip()[:200]

    try:
        days = int(item.get("renew_before_days", site.get("renew_before_days")) or 0)
    except (TypeError, ValueError):
        days = 0
    site["renew_before_days"] = max(0, min(60, days))

    # --- 远程部署参数 ---
    site["ssh_host"] = str(item.get("ssh_host", site.get("ssh_host")) or "").strip()
    try:
        port = int(item.get("ssh_port", site.get("ssh_port")) or 22)
    except (TypeError, ValueError):
        port = 22
    site["ssh_port"] = max(1, min(65535, port))
    site["ssh_user"] = str(item.get("ssh_user", site.get("ssh_user")) or "root").strip()
    ssh_auth = str(item.get("ssh_auth", site.get("ssh_auth")) or "password").lower()
    if ssh_auth not in SSH_AUTH_METHODS:
        ssh_auth = "password"
    site["ssh_auth"] = ssh_auth
    for key in SITE_SECRETS:
        # 留空表示沿用已保存的凭据（接口不回传明文，前端提交时必然是空串）
        value = str(item.get(key) or "").strip()
        if not value and existing:
            value = str(existing.get(key) or "")
        site[key] = value
    site["ssh_host_key"] = str(item.get("ssh_host_key", site.get("ssh_host_key")) or "").strip()

    site["agent_node"] = str(item.get("agent_node", site.get("agent_node")) or "").strip()
    agent_vmid = str(item.get("agent_vmid", site.get("agent_vmid")) or "").strip()
    if agent_vmid and not agent_vmid.isdigit():
        raise CertError("虚拟机 ID 必须是数字")
    site["agent_vmid"] = agent_vmid

    if method == "ssh":
        if not site["ssh_host"]:
            raise CertError("SSH 部署需要填写目标服务器地址")
        if not site["ssh_user"]:
            raise CertError("SSH 部署需要填写登录用户名")
        if ssh_auth == "password" and not site["ssh_password"]:
            raise CertError("SSH 密码认证需要填写密码（已保存的站点可留空表示不修改）")
        if ssh_auth == "key" and not site["ssh_key"]:
            raise CertError("SSH 密钥认证需要粘贴私钥内容（已保存的站点可留空表示不修改）")
    if method == "agent":
        if not site["agent_node"] or not site["agent_vmid"]:
            raise CertError("Guest Agent 部署需要选择目标虚拟机的节点与 VMID")

    for key in ("cert_id", "pending_cert_id"):
        value = str(item.get(key, site.get(key)) or "").strip()
        site[key] = value
    return site


# ------------------------------------------------------------------ 配置读写
async def load_tencent(owner: str = "") -> Dict[str, Any]:
    """读取某个用户的腾讯云配置（密钥各自独立）。"""
    raw = await store.get_setting(tencent_key(owner))
    if raw is None and owner and owner == await store.first_admin_username():
        # 升级前的那份全局配置继续对管理员生效，直到他重新保存
        raw = await store.get_setting(LEGACY_TENCENT_KEY)
    cfg = dict(DEFAULT_TENCENT)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                cfg.update(data)
        except ValueError:
            pass
    if cfg.get("secret_key"):
        cfg["secret_key"] = crypto.decrypt(str(cfg["secret_key"]))
    return cfg


async def save_tencent(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存某个用户的腾讯云配置；密钥留空表示沿用旧值。"""
    current = await load_tencent(owner)
    item = raw if isinstance(raw, dict) else {}
    secret_key = str(item.get("secret_key") or "").strip()
    if not secret_key and not item.get("secret_key_clear"):
        secret_key = str(current.get("secret_key") or "")
    dv = str(item.get("dv_auth_method", current.get("dv_auth_method")) or "DNS_AUTO").upper()
    if dv not in ("DNS_AUTO", "DNS", "FILE"):
        raise CertError("域名验证方式只能是 DNS_AUTO / DNS / FILE")
    algo = str(item.get("encrypt_algo", current.get("encrypt_algo")) or "RSA").upper()
    if algo not in ("RSA", "ECC"):
        algo = "RSA"
    try:
        renew_days = int(item.get("renew_before_days", current.get("renew_before_days")) or 15)
    except (TypeError, ValueError):
        renew_days = 15

    cfg = {
        "secret_id": str(item.get("secret_id", current.get("secret_id")) or "").strip(),
        "secret_key": secret_key,
        "dv_auth_method": dv,
        "encrypt_algo": algo,
        "renew_before_days": max(1, min(60, renew_days)),
    }
    stored = dict(cfg)
    stored["secret_key"] = crypto.encrypt(secret_key)
    await store.set_setting(tencent_key(owner), json.dumps(stored, ensure_ascii=False))
    return cfg


async def cfg_for(site: Dict[str, Any]) -> Dict[str, Any]:
    """站点对应的腾讯云配置：证书属于站点归属者，用谁的账号就用谁的密钥。"""
    return await load_tencent(site_owner(site))


def tencent_client(cfg: Dict[str, Any]) -> TencentSslClient:
    return TencentSslClient(str(cfg.get("secret_id") or ""), str(cfg.get("secret_key") or ""))


async def load_sites() -> List[Dict[str, Any]]:
    raw = await store.get_setting(SETTING_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    sites: List[Dict[str, Any]] = []
    for item in data:
        site = dict(DEFAULT_SITE)
        if isinstance(item, dict):
            site.update({k: v for k, v in item.items() if k in DEFAULT_SITE})
        for key in SITE_SECRETS:
            value = str(site.get(key) or "")
            site[key] = crypto.decrypt(value) if crypto.is_encrypted(value) else value
        sites.append(site)
    return sites


async def save_sites(sites: List[Dict[str, Any]]) -> None:
    stored: List[Dict[str, Any]] = []
    for site in sites:
        item = dict(site)
        for key in SITE_SECRETS:
            item[key] = crypto.encrypt(str(site.get(key) or ""))
        stored.append(item)
    await store.set_setting(SETTING_KEY, json.dumps(stored, ensure_ascii=False))


def visible_sites(sites: List[Dict[str, Any]], owner: Optional[str]) -> List[Dict[str, Any]]:
    """按可见范围过滤站点：``owner=None``（管理员）表示全部。"""
    if owner is None:
        return list(sites)
    return [site for site in sites if site_owner(site) == owner]


async def get_site(site_id: str, owner: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """按 id 取站点；``owner`` 有值时只在该用户的站点里找（管理员传 None）。"""
    for site in visible_sites(await load_sites(), owner):
        if str(site.get("id")) == str(site_id):
            return site
    return None


async def update_site(site: Dict[str, Any]) -> Dict[str, Any]:
    """按 id 覆盖站点并落库，返回最新站点。"""
    sites = await load_sites()
    for index, item in enumerate(sites):
        if str(item.get("id")) == str(site.get("id")):
            sites[index] = site
            break
    else:
        sites.append(site)
    await save_sites(sites)
    return site


async def delete_site(site_id: str) -> bool:
    sites = await load_sites()
    remain = [s for s in sites if str(s.get("id")) != str(site_id)]
    if len(remain) == len(sites):
        return False
    await save_sites(remain)
    return True


# ------------------------------------------------------------------ 部署日志
SCHEMA = """
CREATE TABLE IF NOT EXISTS cert_deploy_log (
    id        BIGINT NOT NULL AUTO_INCREMENT,
    username  VARCHAR(64) NOT NULL DEFAULT '',
    site_id   VARCHAR(64),
    site_name VARCHAR(128),
    domain    VARCHAR(255),
    action    VARCHAR(64),
    result    VARCHAR(32),
    detail    TEXT,
    ts        BIGINT,
    PRIMARY KEY (id),
    KEY idx_cert_log_owner (username, ts DESC),
    KEY idx_cert_log_ts (ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        # 旧库补列：日志按用户隔离
        columns = await database.table_columns(db, "cert_deploy_log")
        if "username" not in columns:
            await db.execute(
                "ALTER TABLE cert_deploy_log ADD COLUMN username VARCHAR(64) NOT NULL DEFAULT ''"
            )
        await db.commit()


async def record_log(
    site: Dict[str, Any], action: str, result: str, detail: str
) -> None:
    async with database.connect() as db:
        await db.execute(
            "INSERT INTO cert_deploy_log"
            " (username, site_id, site_name, domain, action, result, detail, ts)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                site_owner(site),
                str(site.get("id") or ""),
                str(site.get("name") or ""),
                str(site.get("domain") or ""),
                action,
                result,
                detail[:800],
                now_ts(),
            ),
        )
        await db.commit()


async def logs(
    limit: int = 80, site_id: str = "", owner: Optional[str] = None
) -> List[Dict[str, Any]]:
    """部署日志：``owner=None``（管理员）返回全部，否则只看该用户的。"""
    clauses: List[str] = []
    params: List[Any] = []
    if site_id:
        clauses.append("site_id = ?")
        params.append(str(site_id))
    if owner is not None:
        clauses.append("username = ?")
        params.append(owner)
    sql = "SELECT * FROM cert_deploy_log"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(max(1, min(500, limit)))
    async with database.connect() as db:
        cursor = await db.execute(sql, tuple(params))
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def clear_logs(owner: Optional[str] = None) -> int:
    sql = "DELETE FROM cert_deploy_log"
    params: Tuple[Any, ...] = ()
    if owner is not None:
        sql += " WHERE username = ?"
        params = (owner,)
    async with database.connect() as db:
        cursor = await db.execute(sql, params)
        removed = cursor.rowcount or 0
        await db.commit()
    return removed


# ------------------------------------------------------------------ 文件写入
def deploy_target_text(site: Dict[str, Any]) -> str:
    """部署目标的简短描述，用于日志与页面展示。"""
    directory = str(site.get("deploy_dir") or "")
    method = str(site.get("deploy_method") or "local")
    if method == "ssh":
        return (
            str(site.get("ssh_user") or "root") + "@" + str(site.get("ssh_host") or "")
            + ":" + str(site.get("ssh_port") or 22) + directory
        )
    if method == "agent":
        return (
            "VM " + str(site.get("agent_vmid") or "") + "@" + str(site.get("agent_node") or "")
            + directory
        )
    return i18n.tr("本机 ") + directory


def _site_files(site: Dict[str, Any], bundle: Dict[str, Any]) -> List[Tuple[str, str, int]]:
    return [
        (str(site.get("cert_filename") or "fullchain.pem"), bundle["fullchain"], 0o644),
        (str(site.get("key_filename") or "privkey.pem"), bundle["private_key"], 0o600),
    ]


def _atomic_write(path: Path, text: str, mode: int) -> None:
    """原子写入：先写临时文件再 rename，避免 Web 服务器读到半个证书。"""
    tmp = path.with_name("." + path.name + ".tmp-" + secrets.token_hex(4))
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(str(tmp), mode)
        os.replace(str(tmp), str(path))
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


async def _run_reload(command: str) -> str:
    """在本机执行重载命令，返回输出摘要；失败抛 :class:`ReloadError`。"""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        raise ReloadError(i18n.tr("无法执行重载命令：") + str(exc)) from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=RELOAD_TIMEOUT)
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise ReloadError(
            i18n.pick("重载命令执行超时（", "Reload command timed out (")
            + str(RELOAD_TIMEOUT)
            + i18n.pick(" 秒）：", "s): ")
            + command
        ) from exc
    text = (out or b"").decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise ReloadError(
            i18n.tr("重载命令返回 ")
            + str(proc.returncode)
            + i18n.tr("：")
            + (text[-300:] or command)
        )
    return text[-300:]


# ------------------------------------------------------------- 本机目录部署
async def _push_local(site: Dict[str, Any], bundle: Dict[str, Any]) -> Tuple[str, str]:
    target_dir = Path(str(site.get("deploy_dir")))
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CertError(i18n.tr("创建部署目录失败：") + str(exc)) from exc

    names: List[str] = []
    for name, content, mode in _site_files(site, bundle):
        path = target_dir / name
        try:
            _atomic_write(path, content, mode)
        except OSError as exc:
            raise CertError(i18n.tr("写入证书文件失败：") + str(exc)) from exc
        names.append(path.name)

    detail = i18n.pick("已写入本机 ", "Written to local ")
    detail += (
        str(target_dir)
        + i18n.pick("（", " (")
        + " / ".join(names)
        + i18n.pick("，来源 ", ", from ")
        + str(bundle["chain_file"])
        + i18n.pick("）", ")")
    )
    command = str(site.get("reload_command") or "").strip()
    if command:
        output = await _run_reload(command)
        detail += i18n.tr("，重载命令已执行") + (i18n.tr("：") + output if output else "")
    return detail, ""


# ---------------------------------------------------------------- SSH 部署
def _fingerprint(key: Any) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _parse_private_key(paramiko: Any, text: str) -> Any:
    candidates = [
        getattr(paramiko, name, None)
        for name in ("Ed25519Key", "ECDSAKey", "RSAKey", "DSSKey")
    ]
    for cls in candidates:
        if cls is None:
            continue
        try:
            return cls.from_private_key(io.StringIO(text))
        except Exception:  # noqa: BLE001 - 逐类型尝试，全部失败才算错误
            continue
    raise CertError(
        i18n.tr("无法解析 SSH 私钥，支持 RSA / ECDSA / Ed25519 且不能带密码")
    )


def _sftp_makedirs(sftp: Any, path: str) -> None:
    parts = [p for p in path.split("/") if p]
    current = ""
    for part in parts:
        current += "/" + part
        try:
            sftp.stat(current)
        except IOError:
            sftp.mkdir(current)


def _ssh_deploy_sync(
    site: Dict[str, Any], bundle: Dict[str, Any], captured: Dict[str, str]
) -> str:
    """SSH 上传并重载（同步实现，由 :func:`asyncio.to_thread` 调用）。"""
    try:
        import paramiko
    except ImportError as exc:  # pragma: no cover - 依赖缺失时的兜底
        raise CertError(i18n.tr("缺少 paramiko 依赖，无法使用 SSH 部署")) from exc

    host = str(site.get("ssh_host") or "")
    port = int(site.get("ssh_port") or 22)
    user = str(site.get("ssh_user") or "root")
    recorded = str(site.get("ssh_host_key") or "")

    class _Policy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client: Any, hostname: str, key: Any) -> None:
            fingerprint = _fingerprint(key)
            captured["fp"] = fingerprint
            if recorded and recorded != fingerprint:
                raise CertError(
                    i18n.pick(
                        "目标主机指纹与记录不一致（记录 ",
                        "The target host key fingerprint does not match the "
                        "recorded one (recorded ",
                    )
                    + recorded
                    + i18n.pick("，实际 ", ", got ")
                    + fingerprint
                    + i18n.pick(
                        "），可能存在中间人风险，已中止部署",
                        "); possible man-in-the-middle, deployment aborted",
                    )
                )

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(_Policy())
    kwargs: Dict[str, Any] = {
        "hostname": host,
        "port": port,
        "username": user,
        "timeout": 15,
        "banner_timeout": 20,
        "auth_timeout": 20,
        "allow_agent": False,
        "look_for_keys": False,
    }
    if str(site.get("ssh_auth") or "password") == "key":
        kwargs["pkey"] = _parse_private_key(paramiko, str(site.get("ssh_key") or ""))
    else:
        kwargs["password"] = str(site.get("ssh_password") or "")
    try:
        client.connect(**kwargs)
    except CertError:
        raise
    except paramiko.AuthenticationException as exc:
        raise CertError(
            i18n.tr("SSH 认证失败，请检查用户名与密码/私钥")
        ) from exc
    except paramiko.SSHException as exc:
        raise CertError(i18n.tr("SSH 连接失败：") + str(exc)) from exc
    except OSError as exc:
        raise CertError(
            i18n.tr("无法连接 ")
            + host
            + ":"
            + str(port)
            + i18n.pick("（", " (")
            + str(exc)
            + i18n.pick("）", ")")
        ) from exc

    directory = str(site.get("deploy_dir") or "")
    names: List[str] = []
    try:
        sftp = client.open_sftp()
        try:
            _sftp_makedirs(sftp, directory)
            for name, content, mode in _site_files(site, bundle):
                remote = directory.rstrip("/") + "/" + name
                tmp = remote + ".tmp-" + secrets.token_hex(4)
                with sftp.open(tmp, "wb") as handle:
                    handle.write(content.encode("utf-8"))
                sftp.chmod(tmp, mode)
                try:
                    sftp.posix_rename(tmp, remote)
                except (IOError, OSError):
                    # 老服务器不支持 posix-rename 时退化为普通 rename
                    try:
                        sftp.remove(remote)
                    except (IOError, OSError):
                        pass
                    sftp.rename(tmp, remote)
                names.append(name)
        finally:
            sftp.close()
    except CertError:
        raise
    except (IOError, OSError) as exc:
        raise CertError(
            i18n.tr("上传证书文件到 ") + host + i18n.tr(" 失败：") + str(exc)
        ) from exc

    detail = i18n.pick("已部署到 ", "Deployed to ")
    detail += (
        user
        + "@"
        + host
        + ":"
        + str(port)
        + directory
        + i18n.pick("（", " (")
        + " / ".join(names)
        + i18n.pick("，来源 ", ", from ")
        + str(bundle["chain_file"])
        + i18n.pick("）", ")")
    )
    command = str(site.get("reload_command") or "").strip()
    try:
        if command:
            _, stdout, stderr = client.exec_command(command, timeout=RELOAD_TIMEOUT)
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
            output = (out or err).strip()
            if code != 0:
                raise ReloadError(
                    i18n.tr("远程重载命令返回 ")
                    + str(code)
                    + i18n.tr("：")
                    + (output[-300:] or command)
                )
            detail += i18n.tr("，远程重载命令已执行") + (
                i18n.tr("：") + output[-200:] if output else ""
            )
    finally:
        client.close()
    return detail


async def _push_ssh(site: Dict[str, Any], bundle: Dict[str, Any]) -> Tuple[str, str]:
    captured: Dict[str, str] = {}
    try:
        detail = await asyncio.to_thread(_ssh_deploy_sync, site, bundle, captured)
    except ReloadError:
        # 文件已经传上去了，指纹仍然要记住，避免下次再提示
        if captured.get("fp") and captured["fp"] != site.get("ssh_host_key"):
            site["ssh_host_key"] = captured["fp"]
            await update_site(site)
        raise
    return detail, captured.get("fp", "")


# --------------------------------------------------- Proxmox Guest Agent 部署
async def _agent_exec(
    client: Any, node: str, vmid: int, argv: List[str], timeout: int = RELOAD_TIMEOUT
) -> str:
    """在虚拟机内执行命令并等待结果（依赖 QEMU Guest Agent）。"""
    try:
        result = await client.qemu_agent_exec(node, vmid, argv)
    except ProxmoxError as exc:
        raise CertError(
            i18n.tr("Guest Agent 调用失败：")
            + str(exc.message)
            + i18n.tr("（请确认虚拟机内已安装并运行 qemu-guest-agent）")
        ) from exc
    pid = (result or {}).get("pid")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status = await client.qemu_agent_exec_status(node, vmid, pid)
        except ProxmoxError as exc:
            raise CertError(i18n.tr("读取命令执行结果失败：") + str(exc.message)) from exc
        if status.get("exited"):
            # PVE 文档说 out-data 是 base64，实测 8.4 返回明文，
            # 用 formatters.decode_agent_output 两种都兼容
            out = formatters.decode_agent_output(status.get("out-data"))
            err = formatters.decode_agent_output(status.get("err-data"))
            code = int(status.get("exitcode") or 0)
            if code != 0:
                raise CertError(
                    i18n.pick("虚拟机内命令执行失败（", "Command failed in the VM (")
                    + " ".join(argv)
                    + i18n.pick("）：", "): ")
                    + (
                        (err or out).strip()[-300:]
                        or i18n.pick("退出码 ", "exit code ") + str(code)
                    )
                )
            return (out or err).strip()
        await asyncio.sleep(0.4)
    raise CertError(
        i18n.pick("虚拟机内命令执行超时：", "Command timed out in the VM: ")
        + " ".join(argv)
    )


async def _push_guest_agent(
    site: Dict[str, Any], bundle: Dict[str, Any]
) -> Tuple[str, str]:
    client = get_client()
    node = str(site.get("agent_node") or "")
    vmid = int(str(site.get("agent_vmid") or "0"))
    directory = str(site.get("deploy_dir") or "")
    await _agent_exec(client, node, vmid, ["mkdir", "-p", directory])

    names: List[str] = []
    for name, content, mode in _site_files(site, bundle):
        remote = directory.rstrip("/") + "/" + name
        tmp = remote + ".tmp-" + secrets.token_hex(4)
        try:
            handle = await client.qemu_agent_file_open(node, vmid, tmp, "wb")
        except ProxmoxError as exc:
            raise CertError(
                i18n.tr("打开虚拟机内文件失败：") + str(exc.message)
            ) from exc
        if handle is None:
            raise CertError(
                i18n.tr("Guest Agent 未返回文件句柄，可能是磁盘路径不可写")
            )
        try:
            await client.qemu_agent_file_write(
                node, vmid, handle, base64.b64encode(content.encode("utf-8")).decode("ascii")
            )
        except ProxmoxError as exc:
            raise CertError(
                i18n.tr("写入虚拟机内文件失败：") + str(exc.message)
            ) from exc
        finally:
            try:
                await client.qemu_agent_file_close(node, vmid, handle)
            except ProxmoxError:
                pass
        await _agent_exec(client, node, vmid, ["chmod", format(mode, "o"), tmp])
        await _agent_exec(client, node, vmid, ["mv", "-f", tmp, remote])
        names.append(name)

    detail = i18n.pick("已写入虚拟机 ", "Written to VM ")
    detail += (
        str(vmid)
        + "@"
        + node
        + directory
        + i18n.pick("（", " (")
        + " / ".join(names)
        + i18n.pick("，来源 ", ", from ")
        + str(bundle["chain_file"])
        + i18n.pick("）", ")")
    )
    command = str(site.get("reload_command") or "").strip()
    if command:
        output = await _agent_exec(client, node, vmid, ["/bin/sh", "-c", command])
        detail += i18n.tr("，虚拟机内重载命令已执行") + (
            i18n.tr("：") + output[-200:] if output else ""
        )
    return detail, ""


# ---------------------------------------------------------------- 证书状态同步
def _apply_cert_meta(site: Dict[str, Any], cert: Dict[str, Any]) -> None:
    try:
        status = int(cert.get("Status"))
    except (TypeError, ValueError):
        status = -1
    site["cert_status"] = status
    site["cert_status_text"] = status_text(status)
    site["cert_domain"] = str(cert.get("Domain") or "")
    site["expire_at"] = parse_cn_time(cert.get("CertEndTime"))
    site["last_check_at"] = now_ts()


async def sync_site_cert(client: TencentSslClient, site: Dict[str, Any]) -> Dict[str, Any]:
    """从腾讯云拉取该站点当前（或待签发）证书的状态并写回站点。"""
    cert_id = str(site.get("pending_cert_id") or site.get("cert_id") or "")
    if not cert_id:
        return site
    cert = await client.describe_certificate(cert_id)
    if not cert:
        site["last_error"] = i18n.pick(
            "证书 " + cert_id + " 在腾讯云账号下不存在",
            f"Certificate {cert_id} does not exist in this Tencent Cloud account",
        )
        return site
    _apply_cert_meta(site, cert)
    if not site.get("pending_cert_id"):
        site["last_error"] = "" if site.get("cert_status") != -1 else site.get("last_error", "")
    return site


# -------------------------------------------------------------------- 部署
async def deploy_site(
    site: Dict[str, Any],
    cfg: Optional[Dict[str, Any]] = None,
    action: str = "deploy",
) -> Dict[str, Any]:
    """下载证书并按站点配置的部署方式（本机 / SSH / Guest Agent）落地。"""
    cfg = cfg or await cfg_for(site)
    client = tencent_client(cfg)
    cert_id = str(site.get("pending_cert_id") or site.get("cert_id") or "")
    if not cert_id:
        raise CertError(i18n.tr("该站点还没有证书，请先申请或绑定证书"))

    data = await client.download_certificate(cert_id)
    bundle = parse_certificate_bundle(data)

    method = str(site.get("deploy_method") or "local")
    try:
        if method == "ssh":
            detail, fingerprint = await _push_ssh(site, bundle)
            if fingerprint and fingerprint != site.get("ssh_host_key"):
                site["ssh_host_key"] = fingerprint
        elif method == "agent":
            detail, _ = await _push_guest_agent(site, bundle)
        else:
            detail, _ = await _push_local(site, bundle)
    except ReloadError as exc:
        # 文件已经写到位，只是重载失败：如实记录，让用户去修命令
        site["last_error"] = str(exc)
        await record_log(
            site, action, "failed",
            i18n.pick(
                deploy_target_text(site) + " 证书已写入，但重载失败：" + str(exc),
                f"{deploy_target_text(site)}: certificate written, but the reload "
                f"failed: {exc}",
            ),
        )
        await update_site(site)
        return {"ok": False, "detail": str(exc), "deployed": True, "files": bundle["files"]}

    site["cert_id"] = cert_id
    site["pending_cert_id"] = ""
    site["last_deploy_at"] = now_ts()
    site["last_error"] = ""

    detail = detail + i18n.tr("，证书 ID ") + cert_id
    await record_log(site, action, "success", detail)
    await update_site(site)
    return {
        "ok": True,
        "detail": detail,
        "deployed": True,
        "files": bundle["files"],
        "target": deploy_target_text(site),
    }


# ------------------------------------------------------------------ 申请证书
async def apply_certificate(
    site: Dict[str, Any],
    cfg: Optional[Dict[str, Any]] = None,
    *,
    renew: bool = False,
) -> Dict[str, Any]:
    """申请免费证书（或为已有证书申请续期），返回新的证书 ID。"""
    cfg = cfg or await cfg_for(site)
    client = tencent_client(cfg)
    domain = str(site.get("domain") or "")
    old_id = str(site.get("cert_id") or "") if renew else ""
    cert_id = await client.apply_free_certificate(
        domain,
        dv_auth_method=str(cfg.get("dv_auth_method") or "DNS_AUTO"),
        old_certificate_id=old_id,
        alias=str(site.get("name") or domain),
        encrypt_algo=str(cfg.get("encrypt_algo") or "RSA"),
    )
    site["pending_cert_id"] = cert_id
    site["cert_status"] = 0
    site["cert_status_text"] = status_text(0)
    site["last_error"] = ""
    action = "renew" if renew else "apply"
    await record_log(
        site,
        action,
        "pending",
        i18n.pick(
            "证书申请已提交（ID " + cert_id + "，验证方式 "
            + str(cfg.get("dv_auth_method") or "DNS_AUTO")
            + "），等待 CA 签发后自动部署",
            f"Certificate request submitted (ID {cert_id}, validation "
            f"{cfg.get('dv_auth_method') or 'DNS_AUTO'}); it will be deployed "
            "automatically once the CA issues it",
        ),
    )
    await update_site(site)
    return {
        "cert_id": cert_id,
        "domain": domain,
        "detail": i18n.pick("证书申请已提交，等待签发", "Request submitted; waiting for the CA to issue"),
    }


async def bind_certificate(site: Dict[str, Any], cert_id: str) -> Dict[str, Any]:
    """绑定腾讯云上已有的证书。"""
    cert_id = str(cert_id or "").strip()
    if not cert_id:
        raise CertError(i18n.tr("请填写证书 ID"))
    cfg = await cfg_for(site)
    client = tencent_client(cfg)
    cert = await client.describe_certificate(cert_id)
    if not cert:
        raise CertError(
            i18n.pick(
                "证书 " + cert_id + " 不存在或不属于当前账号",
                f"Certificate {cert_id} does not exist or belongs to another account",
            )
        )
    site["cert_id"] = cert_id
    site["pending_cert_id"] = ""
    _apply_cert_meta(site, cert)
    site["last_error"] = ""
    await record_log(
        site,
        "bind",
        "success",
        i18n.pick(
            "已绑定证书 " + cert_id + "（" + str(cert.get("Domain") or "") + "，"
            + status_text(cert.get("Status")) + "）",
            f"Bound certificate {cert_id} ({cert.get('Domain') or ''}, "
            f"{i18n.tr(status_text(cert.get('Status')))})",
        ),
    )
    await update_site(site)
    return {"cert_id": cert_id, "detail": i18n.tr("证书已绑定"), "cert_status_text": site["cert_status_text"]}


# ---------------------------------------------------------------- 定时续期
def days_left(site: Dict[str, Any]) -> Optional[int]:
    expire = int(site.get("expire_at") or 0)
    if not expire:
        return None
    return int((expire - time.time()) // 86400)


def renew_threshold(site: Dict[str, Any], cfg: Dict[str, Any]) -> int:
    own = int(site.get("renew_before_days") or 0)
    if own:
        return own
    return int(cfg.get("renew_before_days") or 15)


async def renew_tick() -> List[Dict[str, Any]]:
    """定时任务：同步证书状态，必要时申请续期并部署。"""
    cfg = await load_tencent()
    client = tencent_client(cfg)
    if not client.configured:
        return []
    sites = await load_sites()
    if not sites:
        return []

    results: List[Dict[str, Any]] = []
    for site in sites:
        if not site.get("enabled"):
            continue
        try:
            result = await _renew_one(client, cfg, site)
        except TencentCloudError as exc:
            site["last_error"] = str(exc)
            await record_log(
                site, "sync", "failed",
                i18n.tr("腾讯云接口调用失败：") + str(exc),
            )
            await update_site(site)
            result = None
        if result:
            results.append(result)
    return results


async def _renew_one(
    client: TencentSslClient, cfg: Dict[str, Any], site: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    pending = str(site.get("pending_cert_id") or "")

    # 1) 有等待签发的证书：拿到结果就部署
    if pending:
        await sync_site_cert(client, site)
        status = int(site.get("cert_status") or 0)
        if status == STATUS_ISSUED:
            outcome = await deploy_site(site, cfg, action="renew")
            await record_log(
                site,
                "renew",
                "success" if outcome.get("ok") else "failed",
                i18n.pick(
                    "续期证书 " + pending + " 已签发并部署",
                    f"Renewal certificate {pending} was issued and deployed",
                ),
            )
            return {"site": site.get("name"), "action": "deploy", "detail": outcome.get("detail")}
        if status in STATUS_FAILED:
            site["pending_cert_id"] = ""
            site["last_error"] = i18n.pick(
                "续期证书申请失败：" + status_text(status),
                f"Renewal request failed: {i18n.tr(status_text(status))}",
            )
            await record_log(site, "renew", "failed", site["last_error"])
            await update_site(site)
            return {"site": site.get("name"), "action": "renew", "detail": site["last_error"]}
        if status in STATUS_PENDING:
            await update_site(site)
            return None
        await update_site(site)
        return None

    if not site.get("cert_id"):
        return None

    # 2) 同步到期时间
    await sync_site_cert(client, site)
    left = days_left(site)
    threshold = renew_threshold(site, cfg)
    if left is None:
        await update_site(site)
        return None

    # 3) 未到续期时间
    if left > threshold:
        await update_site(site)
        return None

    if not site.get("auto_renew"):
        site["last_error"] = i18n.pick(
            "证书剩余 " + str(left) + " 天，未开启自动续期",
            f"Certificate expires in {left} days; auto-renew is off",
        )
        await update_site(site)
        return {"site": site.get("name"), "action": "notice", "detail": site["last_error"]}

    # 4) 申请续期
    await apply_certificate(site, cfg, renew=True)
    return {
        "site": site.get("name"),
        "action": "renew",
        "detail": i18n.pick(
            "证书剩余 " + str(left) + " 天，已提交续期申请",
            f"Certificate expires in {left} days; renewal request submitted",
        ),
    }


async def sync_all(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """手动同步站点的证书状态（``owner=None`` 表示管理员同步全部）。"""
    sites = [
        site
        for site in visible_sites(await load_sites(), owner)
        if site.get("cert_id") or site.get("pending_cert_id")
    ]
    for owner_name, owner_sites in _group_by_owner(sites).items():
        cfg = await load_tencent(owner_name)
        client = tencent_client(cfg)
        if not client.configured:
            raise CertError(i18n.tr("请先配置腾讯云 API 密钥"))
        for site in owner_sites:
            await sync_site_cert(client, site)
            await update_site(site)
    # 重新读一遍：上面的 site 是副本，读回来才是刚写库的最新状态
    return visible_sites(await load_sites(), owner)


async def list_remote_certificates(search: str = "", limit: int = 100) -> List[Dict[str, Any]]:
    """列出腾讯云账号下的证书，供页面绑定选择。"""
    cfg = await load_tencent()
    client = tencent_client(cfg)
    if not client.configured:
        raise CertError(i18n.tr("请先配置腾讯云 API 密钥"))
    body = await client.describe_certificates(search_key=search, limit=limit)
    items: List[Dict[str, Any]] = []
    for cert in body.get("Certificates") or []:
        status = cert.get("Status")
        items.append(
            {
                "cert_id": str(cert.get("CertificateId") or ""),
                "domain": str(cert.get("Domain") or ""),
                "alias": str(cert.get("Alias") or ""),
                "status": status,
                "status_text": i18n.tr(status_text(status)),
                "expire_at": parse_cn_time(cert.get("CertEndTime")),
                "encrypt_algo": str(cert.get("EncryptAlgorithm") or ""),
                "wildcard": bool(cert.get("IsWildcard")),
                "is_dv": bool(cert.get("IsDv")),
                "source": str(cert.get("From") or ""),
            }
        )
    return items


async def test_connection(owner: str = "") -> Dict[str, Any]:
    """验证该用户的密钥是否可用（顺带返回账号下的证书数量）。"""
    cfg = await load_tencent(owner)
    client = tencent_client(cfg)
    if not client.configured:
        raise CertError(i18n.tr("请先填写 SecretId 与 SecretKey"))
    body = await client.describe_certificates(limit=1)
    total = int(body.get("TotalCount") or 0)
    return {
        "total": total,
        "detail": i18n.pick(
            "连接成功，账号下共有 " + str(total) + " 张证书",
            f"Connected; this account has {total} certificate(s)",
        ),
    }
