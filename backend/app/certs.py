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
import shlex
import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


from . import acme as acme_mod
from . import certnotify, crypto, database, dnsproviders, formatters, i18n, store
from .certpipeline import Context, Pipeline, RunResult, Step
from .certproviders import (
    DEFAULTS as PROVIDER_DEFAULTS,
    FIELDS as PROVIDER_FIELDS,
    SECRET_FIELDS as PROVIDER_SECRETS,
    PROVIDERS as PROVIDER_KINDS,
    ProviderError,
    build_provider,
    label as provider_label,
)
from .pve import ProxmoxError, get_client
from .tencent_ssl import (
    STATUS_FAILED,
    STATUS_ISSUED,
    STATUS_PENDING,
    TencentCloudError,
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

# PVE 节点证书：走 ``/nodes/{node}/certificates/custom`` 上传，PVE 会把证书
# 落盘为 ``/etc/pve/local/pveproxy-ssl.pem`` / ``.key``（面板不直接写该目录）。
PVE_CERT_DIR = "/etc/pve/local"
# 节点名会拼进 API 路径：只允许 PVE 合法主机名（字母 / 数字 / . _ -）
PVE_NODE_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$")

# 部署后重载命令只允许这些程序（比对 argv[0] 的 basename）。命令一律以 argv
# 形式执行、不经过 shell，所以管道 / 重定向 / 命令串联在保存时就会被拒绝 ——
# 否则拿到 cert.manage 就等于拿到容器内的任意命令执行。
RELOAD_ALLOWED = frozenset(
    {
        "nginx",
        "openresty",
        "systemctl",
        "service",
        "apachectl",
        "apache2ctl",
        "httpd",
        "caddy",
        "traefik",
    }
)
# sudo / doas / env 只是前缀：真正执行的是它们后面的那条命令，仍需过白名单
RELOAD_PREFIX = frozenset({"sudo", "doas", "env"})
RELOAD_BAD_CHARS = (";", "|", "&", "$", "`", ">", "<", "\n", "\r")

#: 续期失败后的重试间隔（秒）：10 分钟 → 30 分钟 → 2 小时 → 6 小时。
#: 90 天的免费证书大约只有 6 次机会，靠"失败就等 6 小时"很容易把次数耗光。
BACKOFF_STEPS = (600, 1800, 7200, 21600)


def backoff_after(attempts: int) -> int:
    """第 N 次失败后等多久再试；超过表长就按最后一档封顶。"""
    if attempts <= 0:
        return 0
    return BACKOFF_STEPS[min(attempts, len(BACKOFF_STEPS)) - 1]

# 支持五种部署方式
DEPLOY_METHODS = ("local", "ssh", "agent", "lxc", "pve")
DEPLOY_METHOD_LABELS = {
    "local": "本机目录（面板所在服务器）",
    "ssh": "SSH 远程服务器",
    "agent": "Proxmox 虚拟机（QEMU Guest Agent）",
    "lxc": "Proxmox 容器（经节点 SSH 执行 pct push/exec）",
    "pve": "PVE 节点（API 上传自定义证书）",
}

# 站点里需要加密存储的字段（ACME 签发 / 用户上传的私钥同样不能明文落库）
SITE_SECRETS = ("ssh_password", "ssh_key", "acme_key")
#: 单个部署目标里需要加密的字段（多目标后每个目标各有一套 SSH 凭据）
TARGET_SECRETS = ("ssh_password", "ssh_key")

#: 一个部署目标。站点可以挂多个，同一张证书依次写到所有目标。
DEFAULT_TARGET: Dict[str, Any] = {
    "id": "",
    "name": "",
    # local = 面板本机；ssh = 远程服务器；agent = QEMU Guest Agent；
    # lxc = PVE 容器（经 PVE 节点 SSH 执行 pct push/exec）；
    # pve = PVE 节点证书（经节点 API 上传，由 PVE 自行落盘并重启 pveproxy）
    "method": "local",
    "deploy_dir": "",
    "cert_filename": "fullchain.pem",
    "key_filename": "privkey.pem",
    "reload_command": "",
    # SSH / LXC（LXC 填的是 PVE 节点的登录信息）
    "ssh_host": "",
    "ssh_port": 22,
    "ssh_user": "root",
    "ssh_auth": "password",
    "ssh_password": "",
    "ssh_key": "",
    "ssh_host_key": "",
    # Guest Agent / LXC
    "agent_node": "",
    "agent_vmid": "",
    # 每个目标自己的部署结果
    "last_error": "",
    "last_deploy_at": 0,
}
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
    # / lxc（PVE 容器）/ pve（PVE 节点证书）
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
    # 签发渠道：tencent（腾讯云免费证书）/ acme（自建 ACME，支持泛域名与多域名）
    # / upload（托管用户自己上传的证书，不申请也不续期，只部署与提醒）
    "ca": "tencent",
    # 额外域名（SAN）。主域名始终在 domain 里，这里只放其余域名
    "domains": [],
    "acme_challenge": "dns",  # dns | http
    "acme_webroot": "",       # http-01 的站点根目录
    "acme_dns_provider": "",  # 空 = 跟随账号级 ACME 配置
    # ACME 签发或用户上传的证书链与私钥（私钥加密存储，见 SITE_SECRETS）
    "acme_pem": "",
    "acme_key": "",
    # 多部署目标：一张证书依次写到列表里的每个目标；空 = 用上面的单目标字段
    "targets": [],
    # --- 站点可用性监控 ---
    "monitor_enabled": False,
    "monitor_url": "",
    "monitor_status": "",  # up / down / ""
    "monitor_checked_at": 0,
    "monitor_latency_ms": 0,
    "monitor_error": "",
    # 部署成功后是否删除 CA 侧的旧证书（腾讯云没有吊销，只能删）
    "auto_delete_old": True,
    # 续期失败计数与下次可重试时间（指数退避，见 certs.BACKOFF_STEPS）
    "attempt_count": 0,
    "next_attempt_at": 0,
    # 已发过的告警事件与时间戳，用于冷却去重（见 certnotify）
    "notices": {},
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
    # 上一次续期流水线的逐步结果（见 certpipeline）：只保留最近一次，排障用
    "last_run": [],
    "last_run_at": 0,
    "last_run_status": "",
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
    """规整域名：允许粘贴完整 URL，去掉协议、路径与端口。

    泛域名（``*.example.com``）在这里**只做格式校验**，能不能签由调用方按
    渠道判断：腾讯云免费证书不支持，ACME + DNS-01 支持（见 :func:`site_domains`）。
    """
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"^[a-z]+://", "", text)
    text = text.split("/")[0].split("?")[0]
    text = text.split(":")[0].strip().rstrip(".")
    if not text:
        return ""
    wildcard = text.startswith("*.")
    rest = text[2:] if wildcard else text
    if not DOMAIN_RE.match(rest):
        raise CertError(i18n.tr("域名格式不正确：") + text)
    if len(rest) > 64:
        raise CertError("域名长度不能超过 64 个字符")
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", rest):
        raise CertError("免费证书不支持 IP 地址")
    return ("*." + rest) if wildcard else rest


def site_domains(site: Dict[str, Any]) -> List[str]:
    """站点要签的全部域名：主域名 + 额外（SAN），去重且泛域名在前。

    ACME 下单与 CSR 都用这一份，避免「主域名改了、附加域名没跟着去重」这类
    「证书里少一个名字」的隐蔽问题。
    """
    raw = [site.get("domain") or ""]
    extra = site.get("domains")
    if isinstance(extra, (list, tuple)):
        raw.extend(str(item or "") for item in extra)
    return acme_mod.normalise_domains([str(item) for item in raw if str(item or "").strip()])


# ------------------------------------------------------------------ 部署目标
def _legacy_target(site: Dict[str, Any]) -> Dict[str, Any]:
    """把单目标时代的站点字段合成一个目标，兼容多目标改造前的数据。"""
    target = dict(DEFAULT_TARGET)
    target.update(
        {
            "id": "default",
            "method": str(site.get("deploy_method") or "local"),
            "deploy_dir": str(site.get("deploy_dir") or ""),
            "cert_filename": str(site.get("cert_filename") or "fullchain.pem"),
            "key_filename": str(site.get("key_filename") or "privkey.pem"),
            "reload_command": str(site.get("reload_command") or ""),
        }
    )
    for key in (
        "ssh_host",
        "ssh_port",
        "ssh_user",
        "ssh_auth",
        "ssh_password",
        "ssh_key",
        "ssh_host_key",
        "agent_node",
        "agent_vmid",
    ):
        value = site.get(key)
        if value not in (None, ""):
            target[key] = value
    return target


def site_targets(site: Dict[str, Any]) -> List[Dict[str, Any]]:
    """站点的全部部署目标；空列表表示「还没有选写入位置」。

    新数据直接读 ``targets``；旧数据（只有 deploy_dir 等单目标字段）在这里
    动态合成一个目标，不写库、不需要迁移脚本。
    """
    raw = site.get("targets")
    if isinstance(raw, list) and raw:
        targets: List[Dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            target = dict(DEFAULT_TARGET)
            target.update({k: v for k, v in item.items() if k in DEFAULT_TARGET})
            targets.append(target)
        if targets:
            return targets
    if not str(site.get("deploy_dir") or "").strip():
        return []
    return [_legacy_target(site)]


def _target_view(site: Dict[str, Any], target: Dict[str, Any]) -> Dict[str, Any]:
    """把「站点 + 目标」合并成部署函数认识的单站点结构。

    部署通道（本机 / SSH / Agent / LXC）只关心一套字段，多目标在调用处展开，
    通道实现本身不用改 —— 这是拆目标时刻意保住的边界。
    """
    view = dict(site)
    view["deploy_method"] = str(target.get("method") or "local")
    for key in DEFAULT_TARGET:
        if key == "method":
            continue
        if key in target:
            view[key] = target[key]
    return view


def _safe_filename(raw: Any, default: str) -> str:
    text = str(raw or "").strip() or default
    if not FILENAME_RE.match(text):
        raise CertError(
            i18n.tr("文件名只能包含字母、数字、点、下划线和短横线：") + text
        )
    return text


def reload_argv(command: Any) -> List[str]:
    """把重载命令解析成 argv 并做白名单校验；空命令返回 ``[]``。

    所有部署通道（本机 / SSH / Guest Agent）都用这里的结果执行，差别只在于
    本机与虚拟机直接以 argv 启动、SSH 用 :func:`shlex.quote` 拼成远端命令行。
    因此「管道、重定向、多条命令」在保存阶段就被拒掉，``cert.manage`` 不再
    等价于任意命令执行。
    """
    text = str(command or "").strip()
    if not text:
        return []
    if len(text) > 400:
        raise CertError(i18n.t("cert.reloadTooLong"))
    if any(ch in text for ch in RELOAD_BAD_CHARS):
        raise CertError(i18n.t("cert.reloadBadChars"))
    try:
        argv = shlex.split(text)
    except ValueError as exc:
        raise CertError(i18n.t("cert.reloadParseFail", error=str(exc))) from exc
    if not argv:
        raise CertError(i18n.t("cert.reloadEmpty"))

    # sudo / doas / env 只是前缀：跳过它们的选项与 VAR=VAL，校验真正的目标命令
    idx = 0
    if os.path.basename(argv[0]) in RELOAD_PREFIX:
        idx = 1
        while idx < len(argv) and (argv[idx].startswith("-") or "=" in argv[idx]):
            idx += 1
    target = os.path.basename(argv[idx]) if idx < len(argv) else ""
    if target not in RELOAD_ALLOWED:
        raise CertError(
            i18n.t("cert.reloadNotAllowed", allowed=" / ".join(sorted(RELOAD_ALLOWED)))
        )
    return argv


def _normalise_target(
    raw: Dict[str, Any],
    existing: Optional[Dict[str, Any]] = None,
    fallback: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """校验单个部署目标。

    规则与单目标时代完全一致（目录白名单、文件名、reload 命令白名单、SSH /
    Proxmox 参数），只是把字段从「站点上的 method」搬进目标对象。``fallback``
    是站点级字段：旧前端只提交站点级字段时，用它合成第一个目标。
    """
    item = raw if isinstance(raw, dict) else {}
    base = fallback or {}
    target = dict(DEFAULT_TARGET)
    if existing:
        target.update({k: v for k, v in existing.items() if k in DEFAULT_TARGET})
    for key in DEFAULT_TARGET:
        if key in base and base[key] not in (None, ""):
            target[key] = base[key]
    target.update({k: v for k, v in item.items() if k in DEFAULT_TARGET})
    target["id"] = str((existing or {}).get("id") or item.get("id") or _new_id())
    target["name"] = str(item.get("name", target.get("name")) or "").strip()[:40]

    method = str(
        item.get("method", item.get("deploy_method", target.get("method"))) or "local"
    ).lower()
    if method not in DEPLOY_METHODS:
        raise CertError("部署方式只能是 本机目录 / SSH 远程 / Proxmox 虚拟机 / PVE 容器 / PVE 节点")
    target["method"] = method

    if method == "pve":
        # 证书由 PVE 的 custom 接口落盘，目录由 PVE 固定，用户不需要填写；
        # 重载也由 restart=1 交给 pveproxy，保留一条 reload 命令只会造成误解。
        target["deploy_dir"] = PVE_CERT_DIR
        target["reload_command"] = ""
    else:
        deploy_dir = str(item.get("deploy_dir", target.get("deploy_dir")) or "").strip()
        if not deploy_dir:
            raise CertError("请填写证书部署目录")
        if not deploy_dir.startswith("/"):
            raise CertError("部署目录必须是绝对路径，例如 /etc/nginx/ssl")
        deploy_dir = deploy_dir.rstrip("/") or "/"
        if not DEPLOY_DIR_RE.match(deploy_dir) or any(
            part in (".", "..") for part in deploy_dir.split("/")
        ):
            raise CertError("部署目录只能包含字母、数字与 . _ - @ + /，且不能包含 . 或 .. 路径片段")
        target["deploy_dir"] = deploy_dir
        target["reload_command"] = " ".join(
            reload_argv(item.get("reload_command", target.get("reload_command")))
        )

    target["cert_filename"] = _safe_filename(
        item.get("cert_filename", target.get("cert_filename")), "fullchain.pem"
    )
    target["key_filename"] = _safe_filename(
        item.get("key_filename", target.get("key_filename")), "privkey.pem"
    )
    if target["cert_filename"] == target["key_filename"]:
        raise CertError("证书文件名与私钥文件名不能相同")

    target["ssh_host"] = str(item.get("ssh_host", target.get("ssh_host")) or "").strip()
    try:
        port = int(item.get("ssh_port", target.get("ssh_port")) or 22)
    except (TypeError, ValueError):
        port = 22
    target["ssh_port"] = max(1, min(65535, port))
    target["ssh_user"] = str(item.get("ssh_user", target.get("ssh_user")) or "root").strip()
    auth = str(item.get("ssh_auth", target.get("ssh_auth")) or "password").lower()
    if auth not in SSH_AUTH_METHODS:
        auth = "password"
    target["ssh_auth"] = auth
    for key in TARGET_SECRETS:
        value = str(item.get(key) or "").strip()
        if not value and existing:
            value = str(existing.get(key) or "")
        target[key] = value
    target["ssh_host_key"] = str(item.get("ssh_host_key", target.get("ssh_host_key")) or "").strip()

    target["agent_node"] = str(item.get("agent_node", target.get("agent_node")) or "").strip()
    if method == "pve":
        # pve 方式复用 agent_node 存节点名；VMID 与它无关，切换方式后清掉旧值
        target["agent_vmid"] = ""
    else:
        vmid = str(item.get("agent_vmid", target.get("agent_vmid")) or "").strip()
        if vmid and not vmid.isdigit():
            raise CertError("虚拟机 / 容器 ID 必须是数字")
        target["agent_vmid"] = vmid

    if method == "ssh":
        if not target["ssh_host"]:
            raise CertError("SSH 部署需要填写目标服务器地址")
        if not target["ssh_user"]:
            raise CertError("SSH 部署需要填写登录用户名")
        if auth == "password" and not target["ssh_password"]:
            raise CertError("SSH 密码认证需要填写密码（已保存的站点可留空表示不修改）")
        if auth == "key" and not target["ssh_key"]:
            raise CertError("SSH 密钥认证需要粘贴私钥内容（已保存的站点可留空表示不修改）")
    if method in ("agent", "lxc"):
        if not target["agent_node"] or not target["agent_vmid"]:
            raise CertError("Proxmox 部署需要选择节点与 VMID")
    if method == "lxc":
        # LXC 没有 API 级文件写入，只能 SSH 到节点执行 pct，节点凭据必须齐全
        if not target["ssh_host"]:
            raise CertError("PVE 容器部署需要填写节点地址（用于 SSH 执行 pct push / pct exec）")
        if auth == "password" and not target["ssh_password"]:
            raise CertError("PVE 容器部署需要填写节点 SSH 密码（或改用密钥）")
        if auth == "key" and not target["ssh_key"]:
            raise CertError("PVE 容器部署需要填写节点 SSH 私钥")
    if method == "pve":
        # PVE 节点证书走面板已配置的 API 连接，只需指定证书要覆盖到哪个节点
        if not target["agent_node"]:
            raise CertError("PVE 节点部署需要填写节点名称")
        if not PVE_NODE_RE.match(target["agent_node"]):
            raise CertError("PVE 节点名称不合法：" + target["agent_node"])
    return target


def normalise_site(raw: Dict[str, Any], existing: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    # 只提交 targets（新版前端）时，用第一个目标补齐站点级字段，让下面的
    # 单目标校验逻辑继续可用 —— 两套入参走同一条校验路径
    raw_targets = item.get("targets")
    if isinstance(raw_targets, list) and raw_targets and isinstance(raw_targets[0], dict):
        first = raw_targets[0]
        item = dict(item)
        for key in DEFAULT_TARGET:
            if key in first and key not in item:
                item[key] = first[key]
        item.setdefault("deploy_method", first.get("method"))
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
        raise CertError("部署方式只能是 本机目录 / SSH 远程 / Proxmox 虚拟机 / PVE 容器 / PVE 节点")
    site["deploy_method"] = method

    if method == "pve":
        # 证书由 PVE 落盘到固定路径，目录与重载命令都不需要用户填写
        site["deploy_dir"] = PVE_CERT_DIR
    else:
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

    # 保存时就校验白名单，并把命令规范化成 argv 拼接（前端拿到的就是最终执行形式）
    if method == "pve":
        site["reload_command"] = ""
    else:
        site["reload_command"] = " ".join(
            reload_argv(item.get("reload_command", site.get("reload_command")))
        )
    # --- 签发渠道、附加域名与 ACME 参数 ---
    # 渠道就是厂商注册表里的 kind；ACME 与「托管证书」是两条非厂商通道
    ca = str(item.get("ca", site.get("ca")) or "tencent").lower()
    if ca not in ("acme", "upload") and not is_cloud_provider(ca):
        raise CertError(
            "不支持的签发渠道："
            + ca
            + "（可选："
            + "、".join(PROVIDER_KINDS)
            + "、acme、upload）"
        )
    site["ca"] = ca

    raw_extra = item.get("domains", site.get("domains"))
    if isinstance(raw_extra, str):
        # 界面上是一个逗号分隔的输入框，容忍空格、逗号、分号混用
        raw_extra = re.split(r"[,;\s]+", raw_extra)
    extra: List[str] = []
    for entry in raw_extra or []:
        normalized = normalise_domain(entry)
        if normalized and normalized != site["domain"] and normalized not in extra:
            extra.append(normalized)
    if len(extra) > 5:
        raise CertError("一个站点最多附加 5 个域名")
    site["domains"] = extra

    challenge = str(item.get("acme_challenge", site.get("acme_challenge")) or "dns").lower()
    if challenge not in ("dns", "http"):
        challenge = "dns"
    site["acme_challenge"] = challenge
    webroot = str(item.get("acme_webroot", site.get("acme_webroot")) or "").strip()
    if webroot and not webroot.startswith("/"):
        raise CertError("HTTP-01 的站点根目录必须是绝对路径，例如 /var/www/html")
    site["acme_webroot"] = webroot.rstrip("/") or ("/" if webroot else "")
    provider = str(item.get("acme_dns_provider", site.get("acme_dns_provider")) or "").lower()
    if provider and provider not in dnsproviders.PROVIDERS:
        raise CertError("不支持的 DNS 服务商：" + provider)
    site["acme_dns_provider"] = provider

    # 证书内容只由签发流程写入：请求体里带了也不认，避免伪造/覆盖
    for key in ("acme_pem", "acme_key"):
        site[key] = str((existing or {}).get(key) or "")

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
    if method == "pve":
        site["agent_vmid"] = ""
    else:
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
    if method == "pve":
        if not site["agent_node"]:
            raise CertError("PVE 节点部署需要填写节点名称")
        if not PVE_NODE_RE.match(site["agent_node"]):
            raise CertError("PVE 节点名称不合法：" + site["agent_node"])

    for key in ("cert_id", "pending_cert_id"):
        value = str(item.get(key, site.get(key)) or "").strip()
        site[key] = value

    # 域名集合或渠道变了，旧证书已经覆盖不到新名字：清掉缓存让下次重新签
    if existing and (
        site["domain"] != str(existing.get("domain") or "")
        or site["domains"] != list(existing.get("domains") or [])
        or site["ca"] != str(existing.get("ca") or "tencent")
    ):
        site["acme_pem"] = ""
        site["acme_key"] = ""
        site["cert_id"] = ""
        site["pending_cert_id"] = ""
        site["cert_status"] = -1
        site["cert_status_text"] = ""
        site["expire_at"] = 0

    # 渠道与验证方式的硬约束
    all_domains = site_domains(site)
    if not all_domains:
        raise CertError("请填写要签发证书的域名")
    if is_cloud_provider(site["ca"]):
        # 各家的免费 DV 证书都只签单域名，且不支持泛域名：在保存时就拦住
        label = provider_label(site["ca"])
        if any(d.startswith("*.") for d in all_domains):
            raise CertError(label + " 免费证书不支持泛域名（*.example.com），请改用 ACME")
        if len(all_domains) > 1 and not PROVIDER_KINDS[site["ca"]].supports_multi_domain:
            raise CertError(label + " 免费证书只支持单域名，多域名请改用 ACME")
    elif site["ca"] == "acme":
        if site["acme_challenge"] == "http" and any(
            d.startswith("*.") for d in all_domains
        ):
            raise CertError("泛域名只能用 DNS-01 验证，请把验证方式改成 DNS")
        if site["acme_challenge"] == "http" and not site["acme_webroot"]:
            raise CertError("HTTP-01 需要填写站点根目录（webroot）")

    # --- 部署目标：多目标优先，否则用站点级字段合成一个 ---
    existing_targets = {
        str(t.get("id")): t
        for t in ((existing or {}).get("targets") or [])
        if isinstance(t, dict)
    }
    raw_target_list = item.get("targets")
    targets: List[Dict[str, Any]] = []
    if isinstance(raw_target_list, list) and raw_target_list:
        for entry in raw_target_list[:10]:
            if not isinstance(entry, dict):
                continue
            targets.append(
                _normalise_target(entry, existing_targets.get(str(entry.get("id"))))
            )
    if not targets:
        targets = [_normalise_target(item, existing_targets.get("default"))]
    site["targets"] = targets
    # 站点级字段跟随第一个目标：列表页摘要与旧接口都还读这几个字段
    first = targets[0]
    site["deploy_method"] = str(first["method"])
    for key in DEFAULT_TARGET:
        if key in ("id", "method", "last_error", "last_deploy_at"):
            continue
        site[key] = first.get(key)
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


# ------------------------------------------------------------- 签发厂商配置
PROVIDER_KEY_PREFIX = "cert_provider:"


def provider_key(kind: str, owner: str = "") -> str:
    """厂商配置的存储 key：``cert_provider:<kind>:<username>``，按用户隔离。"""
    return PROVIDER_KEY_PREFIX + str(kind or "") + ":" + str(owner or "")


def ca_kind(site: Dict[str, Any]) -> str:
    """站点的签发渠道：``tencent`` / ``aliyun`` / ``huawei``，或 ``acme`` / ``upload``。

    老数据没有 ``ca`` 字段，一律当腾讯云处理（历史行为）。
    """
    return str((site or {}).get("ca") or "tencent").strip().lower()


def is_cloud_provider(kind: str) -> bool:
    return str(kind or "") in PROVIDER_KINDS


async def load_provider(kind: str, owner: str = "") -> Dict[str, Any]:
    """读取某个用户在某家厂商上的配置（密文字段在这里解密）。

    腾讯云沿用历史 key（``cert_tencent:<owner>``）与首个管理员的全局兜底，
    所以升级后旧配置继续生效，不需要用户重新填一遍。
    """
    kind = str(kind or "").strip().lower()
    if kind == "tencent":
        return await load_tencent(owner)
    if not is_cloud_provider(kind):
        raise CertError(i18n.tr("不支持的证书签发厂商：") + str(kind or "(空)"))
    cfg = dict(PROVIDER_DEFAULTS.get(kind, {}))
    raw = await store.get_setting(provider_key(kind, owner))
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                cfg.update(data)
        except ValueError:
            pass
    for field in PROVIDER_SECRETS.get(kind, ()):
        text = str(cfg.get(field) or "")
        if text:
            cfg[field] = crypto.decrypt(text) if crypto.is_encrypted(text) else text
    return cfg


def _normalise_provider_cfg(
    kind: str, raw: Any, current: Dict[str, Any]
) -> Dict[str, Any]:
    """按 schema 收口一份厂商配置：密文留空表示沿用旧值，选项越界直接拒绝。"""
    item = raw if isinstance(raw, dict) else {}
    cfg = dict(current)
    for field in PROVIDER_FIELDS.get(kind, []):
        key = str(field.get("key") or "")
        if not key:
            continue
        if field.get("secret"):
            value = str(item.get(key) or "").strip()
            if not value and not item.get(key + "_clear"):
                value = str(current.get(key) or "")
            cfg[key] = value
            continue
        if key not in item:
            continue
        value = item.get(key)
        if field.get("type") == "number":
            try:
                number = int(value)
            except (TypeError, ValueError):
                number = int(current.get(key) or field.get("default") or 0)
            low = int(field.get("min") or 0)
            high = int(field.get("max") or 9999)
            cfg[key] = max(low, min(high, number))
        elif field.get("type") == "select":
            allowed = {str(opt.get("value")) for opt in field.get("options") or []}
            text = str(value or "").strip()
            if text not in allowed:
                raise CertError(
                    i18n.tr("不支持的取值：") + text + i18n.tr("（字段 ") + key + "）"
                )
            cfg[key] = text
        else:
            cfg[key] = str(value or "").strip()
    return cfg


async def save_provider(kind: str, raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存某个用户的厂商配置；密文字段留空表示不修改。"""
    kind = str(kind or "").strip().lower()
    if kind == "tencent":
        return await save_tencent(raw or {}, owner)
    if not is_cloud_provider(kind):
        raise CertError(i18n.tr("不支持的证书签发厂商：") + str(kind or "(空)"))
    current = await load_provider(kind, owner)
    cfg = _normalise_provider_cfg(kind, raw or {}, current)
    stored = dict(cfg)
    for field in PROVIDER_SECRETS.get(kind, ()):
        stored[field] = crypto.encrypt(str(cfg.get(field) or ""))
    await store.set_setting(
        provider_key(kind, owner), json.dumps(stored, ensure_ascii=False)
    )
    return cfg


async def provider_cfg_for(site: Dict[str, Any]) -> Dict[str, Any]:
    """站点对应的厂商配置：证书属于站点归属者，用谁的账号就用谁的密钥。"""
    return await load_provider(ca_kind(site), site_owner(site))


async def cfg_for(site: Dict[str, Any]) -> Dict[str, Any]:
    """兼容旧调用点：等价于 :func:`provider_cfg_for`。"""
    return await provider_cfg_for(site)


async def provider_for(site: Dict[str, Any]) -> Any:
    """造一个已配置好的厂商客户端；没配密钥时给出可读的业务错误。"""
    kind = ca_kind(site)
    if not is_cloud_provider(kind):
        raise CertError(
            i18n.tr("该站点使用的是") + provider_label(kind) + i18n.tr("，不需要云厂商密钥")
        )
    provider = build_provider(kind, await load_provider(kind, site_owner(site)))
    if not provider.configured:
        raise CertError(
            i18n.tr("请先在证书设置里配置")
            + provider_label(kind)
            + i18n.tr("的 API 密钥")
        )
    return provider


# ------------------------------------------------------------------ ACME 配置
ACME_KEY_PREFIX = "cert_acme:"

DEFAULT_ACME: Dict[str, Any] = {
    "email": "",
    "directory": acme_mod.DIRECTORY_LETSENCRYPT,
    "encrypt_algo": "RSA",
    #: 账号密钥（PEM）。首次签发时生成并回写，换掉等于换一个 ACME 账号
    "account_key": "",
    "dns_provider": "",
    #: 加完 TXT 记录后等多久再让 CA 来查。各家 DNS 生效速度差很多，交给用户调
    "dns_wait": 30,
    "dnspod": {"secret_id": "", "secret_key": ""},
    "aliyun": {"access_key_id": "", "access_key_secret": ""},
    "huawei": {"access_key_id": "", "access_key_secret": ""},
    "cloudflare": {"api_token": ""},
}

#: 各 provider 里需要加密落库的字段
ACME_SECRET_FIELDS = {
    "dnspod": ("secret_key",),
    "aliyun": ("access_key_secret",),
    "huawei": ("access_key_secret",),
    "cloudflare": ("api_token",),
}


def acme_key(owner: str) -> str:
    """ACME 账号配置的存储 key（按用户隔离，与腾讯云密钥同一条约定）。"""
    return ACME_KEY_PREFIX + str(owner or "")


def _decrypt_text(value: Any) -> str:
    text = str(value or "")
    return crypto.decrypt(text) if crypto.is_encrypted(text) else text


async def load_acme(owner: str = "") -> Dict[str, Any]:
    """读取某个用户的 ACME 配置；凭据在库里是密文，这里统一解密。"""
    cfg: Dict[str, Any] = json.loads(json.dumps(DEFAULT_ACME))  # 深拷贝，别改到常量
    raw = await store.get_setting(acme_key(owner))
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                for key, value in data.items():
                    if key in ACME_SECRET_FIELDS:
                        if isinstance(value, dict):
                            cfg[key].update(value)
                    elif key in cfg:
                        cfg[key] = value
        except ValueError:
            pass
    cfg["account_key"] = _decrypt_text(cfg.get("account_key"))
    for name, fields in ACME_SECRET_FIELDS.items():
        block = cfg.get(name)
        if not isinstance(block, dict):
            block = {}
            cfg[name] = block
        for field in fields:
            block[field] = _decrypt_text(block.get(field))
    return cfg


#: 各 DNS 服务商在 ACME 配置里需要哪几个凭据字段（与 ACME_SECRET_FIELDS 互为表里）
ACME_DNS_FIELDS = {
    "dnspod": ("secret_id", "secret_key"),
    "aliyun": ("access_key_id", "access_key_secret"),
    "huawei": ("access_key_id", "access_key_secret"),
    "cloudflare": ("api_token",),
}

_ACME_FIELD_LABELS = {
    "secret_id": "cert.fieldSecretId",
    "secret_key": "cert.fieldSecretKey",
    "access_key_id": "cert.fieldAccessKeyId",
    "access_key_secret": "cert.fieldAccessKeySecret",
    "api_token": "cert.fieldApiToken",
}


def acme_fields() -> List[Dict[str, Any]]:
    """ACME 账号的字段 schema。

    形状与 ``certproviders`` 下发的厂商字段一致，所以前端同一个弹窗就能渲染；
    只是 DNS 凭据要跟着 ``dns_provider`` 走，用 ``show_if`` 声明「选了哪家才出现」。
    """
    fields: List[Dict[str, Any]] = [
        {
            "key": "email",
            "label_key": "cert.acmeEmail",
            "type": "text",
            "required": True,
            "placeholder": "ops@example.com",
        },
        {
            "key": "directory",
            "label_key": "cert.acmeDirectory",
            "type": "select",
            "required": True,
            "options": [
                {"value": value, "label_key": "cert.acmeDir_" + name}
                for name, value in acme_mod.DIRECTORIES
            ],
        },
        {
            "key": "encrypt_algo",
            "label_key": "cert.acmeKeyAlgo",
            "type": "select",
            "options": [
                {"value": "RSA", "label_key": "cert.algoRsa"},
                {"value": "ECC", "label_key": "cert.algoEcc"},
            ],
        },
        {
            "key": "dns_provider",
            "label_key": "cert.acmeProvider",
            "type": "select",
            "options": [{"value": "", "label_key": "cert.acmeProviderNone"}]
            + [
                {"value": key, "label_key": "cert.dnsProvider_" + key}
                for key in dnsproviders.PROVIDERS
            ],
        },
        {
            "key": "dns_wait",
            "label_key": "cert.acmeWait",
            "type": "number",
            "min": 0,
            "max": 900,
            "hint_key": "cert.acmeWaitHint",
        },
    ]
    for name, keys in ACME_DNS_FIELDS.items():
        for key in keys:
            fields.append(
                {
                    "key": name + "_" + key,
                    "label_key": _ACME_FIELD_LABELS[key],
                    "type": "password" if key in ACME_SECRET_FIELDS.get(name, ()) else "text",
                    "secret": key in ACME_SECRET_FIELDS.get(name, ()),
                    "required": True,
                    "show_if": {"key": "dns_provider", "in": [name]},
                }
            )
    return fields


def acme_channel_view(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """ACME 账号按「签发渠道」的形状返回，和厂商共用列表与弹窗。"""
    values: Dict[str, Any] = {
        key: cfg.get(key) for key in ("email", "directory", "encrypt_algo", "dns_provider", "dns_wait")
    }
    secret_set: Dict[str, bool] = {}
    for name, keys in ACME_DNS_FIELDS.items():
        block = cfg.get(name) if isinstance(cfg.get(name), dict) else {}
        for key in keys:
            values[name + "_" + key] = str(block.get(key) or "")
            secret_set[name + "_" + key] = bool(block.get(key))
    return {
        "kind": "acme",
        "label": "ACME（Let's Encrypt / ZeroSSL）",
        "label_key": "cert.providerAcme",
        "tagline": "免费泛域名 / 多域名证书；走 DNS 验证时填 DNS 服务商凭据",
        "tagline_key": "cert.providerAcmeTagline",
        "configured": bool(str(cfg.get("email") or "").strip()),
        "identity_key": "email",
        # ACME 没有「列一次证书」的接口，测连接就没有意义
        "test_disabled": True,
        "synchronous": True,
        "fields": acme_fields(),
        "values": values,
        "secret_set": secret_set,
    }


def acme_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    """前端弹窗提交的扁平字段 → ``save_acme`` 认识的嵌套结构。"""
    item = raw if isinstance(raw, dict) else {}
    payload: Dict[str, Any] = {
        key: item[key]
        for key in ("email", "directory", "encrypt_algo", "dns_provider", "dns_wait")
        if key in item
    }
    for name, keys in ACME_DNS_FIELDS.items():
        block = {key: item[name + "_" + key] for key in keys if name + "_" + key in item}
        if block:
            payload[name] = block
    return payload


async def save_acme(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存 ACME 配置；凭据留空表示沿用旧值（与腾讯云密钥同一套约定）。"""
    current = await load_acme(owner)
    item = raw if isinstance(raw, dict) else {}
    directory = str(item.get("directory", current.get("directory")) or "").strip()
    if not directory:
        directory = acme_mod.DIRECTORY_LETSENCRYPT
    if not directory.startswith("https://"):
        raise CertError("ACME 目录必须是 https:// 开头的地址")
    algo = str(item.get("encrypt_algo", current.get("encrypt_algo")) or "RSA").upper()
    if algo not in ("RSA", "ECC"):
        algo = "RSA"
    provider = str(item.get("dns_provider", current.get("dns_provider")) or "").lower()
    if provider and provider not in dnsproviders.PROVIDERS:
        raise CertError("不支持的 DNS 服务商：" + provider)
    try:
        wait = int(item.get("dns_wait", current.get("dns_wait")) or 0)
    except (TypeError, ValueError):
        wait = 30
    cfg: Dict[str, Any] = {
        "email": str(item.get("email", current.get("email")) or "").strip(),
        "directory": directory,
        "encrypt_algo": algo,
        "account_key": str(item.get("account_key", current.get("account_key")) or ""),
        "dns_provider": provider,
        "dns_wait": max(0, min(900, wait)),
    }
    for name, fields in ACME_SECRET_FIELDS.items():
        current_block = current.get(name) or {}
        incoming = item.get(name) if isinstance(item.get(name), dict) else {}
        block: Dict[str, str] = {}
        for key in current_block:
            block[key] = str(incoming.get(key) or "") or str(current_block.get(key) or "")
        for key in fields:
            block.setdefault(key, str(incoming.get(key) or ""))
        cfg[name] = block

    stored = json.loads(json.dumps(cfg))
    stored["account_key"] = crypto.encrypt(str(cfg["account_key"]))
    for name, fields in ACME_SECRET_FIELDS.items():
        for field in fields:
            stored[name][field] = crypto.encrypt(str(cfg[name].get(field) or ""))
    await store.set_setting(acme_key(owner), json.dumps(stored, ensure_ascii=False))
    return cfg


# ------------------------------------------------------------------ 站点模板
TEMPLATE_KEY_PREFIX = "cert_templates:"

#: 模板保存的字段：部署方式、目录、文件名、重载命令、Proxmox 目标、续期策略。
#: 刻意不含域名（每个站点不同）与任何密码（模板会被复制粘贴，不该带凭据）。
TEMPLATE_FIELDS = (
    "name",
    "deploy_method",
    "deploy_dir",
    "cert_filename",
    "key_filename",
    "reload_command",
    "ssh_host",
    "ssh_port",
    "ssh_user",
    "ssh_auth",
    "agent_node",
    "agent_vmid",
    "auto_renew",
    "auto_delete_old",
    "renew_before_days",
    "ca",
    "acme_challenge",
    "acme_webroot",
    "acme_dns_provider",
    "monitor_enabled",
)

_TEMPLATES_LOCK = asyncio.Lock()


def template_key(owner: str) -> str:
    return TEMPLATE_KEY_PREFIX + str(owner or "")


async def load_templates(owner: str = "") -> List[Dict[str, Any]]:
    """读取某个用户的站点模板（模板不含任何凭据，明文存）。"""
    raw = await store.get_setting(template_key(owner))
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    return [dict(item) for item in data if isinstance(item, dict) and item.get("id")]


async def save_template(
    raw: Dict[str, Any], owner: str = "", site: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """保存模板。可以从现有站点（``site``）或请求体（``raw``）生成。"""
    item = raw if isinstance(raw, dict) else {}
    source = dict(site or {})
    template: Dict[str, Any] = {
        "id": str(item.get("id") or _new_id()),
        "name": str(item.get("name") or source.get("name") or "").strip()[:40],
    }
    if not template["name"]:
        raise CertError(i18n.tr("请填写模板名称"))
    for key in TEMPLATE_FIELDS:
        if key in item:
            template[key] = item[key]
        elif key in source:
            template[key] = source[key]

    async with _TEMPLATES_LOCK:
        templates = [t for t in await load_templates(owner) if t.get("id") != template["id"]]
        templates.append(template)
        await store.set_setting(
            template_key(owner), json.dumps(templates[-50:], ensure_ascii=False)
        )
    return template


async def delete_template(template_id: str, owner: str = "") -> bool:
    async with _TEMPLATES_LOCK:
        templates = await load_templates(owner)
        remain = [t for t in templates if str(t.get("id")) != str(template_id)]
        if len(remain) == len(templates):
            return False
        await store.set_setting(
            template_key(owner), json.dumps(remain, ensure_ascii=False)
        )
    return True


#: 站点列表是 settings 表里的**一个 JSON 数组**，读-改-写必须串行：主续期作业
#: （6 小时）与退避补跑作业（5 分钟）、以及页面上的保存/同步接口都可能同时落库，
#: 否则后写的一方会用自己那份旧快照盖掉对方刚写进去的状态。
_SITES_LOCK = asyncio.Lock()
#: 续期作业之间也互斥。``update_site`` 一次只覆盖一个站点，但一轮流水线持有多份
#: 站点副本，两轮并存时仍会用旧副本盖掉对方刚写的 pending_cert_id / 退避计数。
_TICK_LOCK = asyncio.Lock()


async def _read_sites() -> List[Dict[str, Any]]:
    """读站点列表（不加锁的版本，只在已持锁的调用点里用）。"""
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
        targets = site.get("targets")
        if isinstance(targets, list):
            for target in targets:
                if not isinstance(target, dict):
                    continue
                for key in TARGET_SECRETS:
                    value = str(target.get(key) or "")
                    target[key] = crypto.decrypt(value) if crypto.is_encrypted(value) else value
        sites.append(site)
    return sites


async def _write_sites(sites: List[Dict[str, Any]]) -> None:
    """写站点列表（不加锁的版本，只在已持锁的调用点里用）。"""
    stored: List[Dict[str, Any]] = []
    for site in sites:
        item = dict(site)
        for key in SITE_SECRETS:
            item[key] = crypto.encrypt(str(site.get(key) or ""))
        targets = site.get("targets")
        if isinstance(targets, list):
            item["targets"] = []
            for target in targets:
                sealed = dict(target) if isinstance(target, dict) else {}
                for key in TARGET_SECRETS:
                    sealed[key] = crypto.encrypt(str(sealed.get(key) or ""))
                item["targets"].append(sealed)
        stored.append(item)
    await store.set_setting(SETTING_KEY, json.dumps(stored, ensure_ascii=False))


async def load_sites() -> List[Dict[str, Any]]:
    async with _SITES_LOCK:
        return await _read_sites()


async def save_sites(sites: List[Dict[str, Any]]) -> None:
    async with _SITES_LOCK:
        await _write_sites(sites)


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
    async with _SITES_LOCK:
        sites = await _read_sites()
        for index, item in enumerate(sites):
            if str(item.get("id")) == str(site.get("id")):
                sites[index] = site
                break
        else:
            sites.append(site)
        await _write_sites(sites)
    return site


async def delete_site(site_id: str) -> bool:
    async with _SITES_LOCK:
        sites = await _read_sites()
        remain = [s for s in sites if str(s.get("id")) != str(site_id)]
        if len(remain) == len(sites):
            return False
        await _write_sites(remain)
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
def _in_container() -> bool:
    """面板是否跑在容器里（Docker / Podman）。"""
    return Path("/.dockerenv").exists() or Path("/run/.containerenv").exists()


def local_deploy_hint() -> str:
    """容器内运行时「本机目录」写的是容器文件系统，宿主机 Web 服务器读不到。

    这里只负责给页面一句提示：面板直接跑在宿主机上时 ``local`` 方式完全有效，
    所以不能在后端拦截，只能在 UI 上说清楚。
    """
    if _in_container():
        return i18n.t("cert.localDeployInContainer")
    return ""


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
    if method == "pve":
        return i18n.pick("PVE 节点 ", "PVE node ") + str(site.get("agent_node") or "?")
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


def _reload_argv_checked(command: str) -> List[str]:
    """取重载命令的 argv；旧数据里不合规的命令按「重载失败」处理。

    走到部署这一步时证书文件已经写好了，命令不合规不该让整个接口 400，
    否则用户会以为证书没部署。转成 :class:`ReloadError` 后由 ``deploy_site``
    记成「已写入、但重载失败」，用户改完命令重试即可。
    """
    try:
        return reload_argv(command)
    except CertError as exc:
        raise ReloadError(str(exc)) from exc


def _kill_tree(proc: Any) -> None:
    """超时后连同子进程一起杀掉。

    ``start_new_session=True`` 让子进程自成一个进程组，只 kill 主进程会留下
    孙进程（例如命令里再起的辅助脚本），所以整组 SIGKILL。
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass


async def _run_reload(command: str) -> str:
    """在本机执行重载命令，返回输出摘要；失败抛 :class:`ReloadError`。"""
    # 不经过 shell：命令在保存时已过白名单，这里再解析一次做纵深防御
    argv = _reload_argv_checked(command)
    if not argv:
        return ""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        raise ReloadError(i18n.tr("无法执行重载命令：") + str(exc)) from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=RELOAD_TIMEOUT)
    except asyncio.TimeoutError as exc:
        _kill_tree(proc)
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
def _snapshot(files: List[Tuple[Path, int]]) -> List[Tuple[Path, int, Any]]:
    """记录部署前的文件内容，供重载失败时回滚。"""
    snap: List[Tuple[Path, int, Any]] = []
    for path, mode in files:
        try:
            snap.append((path, mode, path.read_text(encoding="utf-8")))
        except (OSError, UnicodeDecodeError):
            snap.append((path, mode, None))  # 文件不存在（或不是文本）：回滚时删掉
    return snap


def _rollback(snap: List[Tuple[Path, int, Any]]) -> bool:
    """把部署前的文件写回去；返回是否全部成功。"""
    ok = True
    for path, mode, text in snap:
        try:
            if text is None:
                if path.exists():
                    path.unlink()
            else:
                _atomic_write(path, text, mode)
        except OSError:
            ok = False
    return ok


def _preflight_local(
    site: Dict[str, Any], target_dir: Path, files: List[Tuple[Path, int]]
) -> None:
    """部署前检查：目录可写、文件名合法、重载命令能被解析。

    这些都能在"写盘之前"发现：写完了再发现命令不合法，轻则留下半套证书，
    重则站点 502 而用户以为是证书问题。
    """
    problems: List[str] = []
    if not os.access(str(target_dir), os.W_OK):
        problems.append(i18n.tr("部署目录不可写：") + str(target_dir))
    for path, _mode in files:
        name = path.name
        if not name or name in (".", "..") or "/" in name:
            problems.append(i18n.tr("证书文件名不合法：") + repr(name))
    command = str(site.get("reload_command") or "").strip()
    if command:
        try:
            reload_argv(command)
        except CertError as exc:
            problems.append(str(exc))
    if problems:
        raise CertError(
            i18n.tr("部署前检查未通过：") + i18n.pick("；", "; ").join(problems)
        )


async def _push_local(site: Dict[str, Any], bundle: Dict[str, Any]) -> Tuple[str, str]:
    target_dir = Path(str(site.get("deploy_dir")))
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CertError(i18n.tr("创建部署目录失败：") + str(exc)) from exc

    files = [
        (target_dir / name, mode)
        for name, _content, mode in _site_files(site, bundle)
    ]
    _preflight_local(site, target_dir, files)
    snap = _snapshot(files)

    names: List[str] = []
    for name, content, mode in _site_files(site, bundle):
        path = target_dir / name
        try:
            _atomic_write(path, content, mode)
        except OSError as exc:
            _rollback(snap)
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
        try:
            output = await _run_reload(command)
        except ReloadError as exc:
            # 新证书写进去了但服务没起来 —— 先把旧文件放回去再重载一次，
            # 让站点继续用上一份有效证书，而不是挂着一份没生效的新证书。
            rolled = _rollback(snap)
            if rolled:
                try:
                    await _run_reload(command)
                except ReloadError:
                    pass
            raise ReloadError(
                str(exc)
                + (
                    i18n.pick("；已回滚到上一份证书", "; rolled back to the previous certificate")
                    if rolled
                    else i18n.pick("；回滚失败，请人工检查", "; rollback failed, check manually")
                )
            ) from exc
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


def _ssh_snapshot(sftp: Any, paths: List[str]) -> Dict[str, Any]:
    """把远端现有文件读进内存（内容 + 权限位），供失败时回滚。

    读不到（首次部署、权限不足）记 ``None``：回滚时删掉这次新写的文件即可。
    与本地通道的 :func:`_snapshot` 同一套语义，只是走 SFTP。
    """
    snap: Dict[str, Any] = {}
    for path in paths:
        try:
            attrs = sftp.stat(path)
            with sftp.open(path, "rb") as handle:
                snap[path] = (handle.read(), attrs.st_mode & 0o777)
        except (IOError, OSError):
            snap[path] = None
    return snap


def _ssh_restore(sftp: Any, snap: Dict[str, Any]) -> bool:
    """按快照恢复远端文件；返回是否全部成功。"""
    ok = True
    for path, saved in snap.items():
        try:
            if saved is None:
                try:
                    sftp.remove(path)
                except (IOError, OSError):
                    pass
                continue
            content, mode = saved
            tmp = path + ".rollback-" + secrets.token_hex(4)
            with sftp.open(tmp, "wb") as handle:
                handle.write(content)
            sftp.chmod(tmp, mode)
            try:
                sftp.posix_rename(tmp, path)
            except (IOError, OSError):
                try:
                    sftp.remove(path)
                except (IOError, OSError):
                    pass
                sftp.rename(tmp, path)
        except (IOError, OSError):
            ok = False
    return ok


def _ssh_rollback(client: Any, snap: Dict[str, Any], command: str) -> bool:
    """重新开一个 SFTP 会话恢复文件，并把恢复后的配置重新加载一次。

    重载失败的服务（如 nginx）通常还挂着旧配置在跑，光把文件放回去不够 ——
    再 reload 一次，才能让「文件内容」与「进程实际加载的配置」重新对齐。
    """
    if not snap:
        return False
    try:
        sftp = client.open_sftp()
        try:
            restored = _ssh_restore(sftp, snap)
        finally:
            sftp.close()
    except Exception:  # noqa: BLE001 - 回滚是尽力而为
        return False
    if restored and command:
        try:
            remote_cmd = " ".join(
                shlex.quote(part) for part in _reload_argv_checked(command)
            )
            _, stdout, _ = client.exec_command(remote_cmd, timeout=RELOAD_TIMEOUT)
            stdout.read()  # 等命令真正结束，不能发出去就关连接
        except Exception:  # noqa: BLE001 - 回滚后的重载失败不再升级错误
            pass
    return restored


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
    files = _site_files(site, bundle)
    remotes = [directory.rstrip("/") + "/" + name for name, _content, _mode in files]
    snap: Dict[str, Any] = {}
    names: List[str] = []
    try:
        sftp = client.open_sftp()
    except Exception as exc:  # noqa: BLE001 - Paramiko 各版本抛的异常不统一
        client.close()
        raise CertError(
            i18n.tr("上传证书文件到 ") + host + i18n.tr(" 失败：") + str(exc)
        ) from exc
    try:
        try:
            _sftp_makedirs(sftp, directory)
            # 覆盖前先留一份旧文件：写一半失败或 reload 失败时要能放回去
            snap = _ssh_snapshot(sftp, remotes)
            for name, content, mode in files:
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
        except CertError:
            raise
        except (IOError, OSError) as exc:
            # 已经写进去的部分还原，别留一半新一半旧
            _ssh_restore(sftp, snap)
            raise CertError(
                i18n.tr("上传证书文件到 ") + host + i18n.tr(" 失败：") + str(exc)
            ) from exc
    finally:
        sftp.close()

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
            # 远端一定经过 shell，所以逐段 quote；命令本身已过白名单
            remote_cmd = " ".join(
                shlex.quote(part) for part in _reload_argv_checked(command)
            )
            _, stdout, stderr = client.exec_command(remote_cmd, timeout=RELOAD_TIMEOUT)
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
    except ReloadError as exc:
        # 新证书传上去了但服务没起来：把旧文件放回去再重载，避免站点停在
        # 「文件是新的、进程加载的还是旧的」这种错配状态
        rolled = _ssh_rollback(client, snap, command)
        raise ReloadError(
            str(exc)
            + (
                i18n.pick("；已回滚到上一份证书", "; rolled back to the previous certificate")
                if rolled
                else i18n.pick("；回滚失败，请人工检查", "; rollback failed, check manually")
            )
        ) from exc
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


async def _agent_backup(
    client: Any, node: str, vmid: int, remotes: List[str]
) -> Dict[str, str]:
    """在虚拟机内给现有文件留一份 ``.bak``；返回 {原路径: 备份路径}。

    原文件不存在（首次部署）时备份路径为空串 —— 回滚就是把新写的删掉。
    Guest Agent 没有「读文件」接口，用 ``cp -p`` 借用虚拟机自己的文件系统，
    大文件也不会占面板内存。
    """
    backups: Dict[str, str] = {}
    for remote in remotes:
        backup = remote + ".bak-" + secrets.token_hex(4)
        try:
            await _agent_exec(client, node, vmid, ["cp", "-p", remote, backup])
            backups[remote] = backup
        except CertError:
            backups[remote] = ""
    return backups


async def _agent_rollback(
    client: Any, node: str, vmid: int, backups: Dict[str, str], argv: List[str]
) -> bool:
    """按备份还原虚拟机内的文件；``argv`` 非空时再重载一次配置。"""
    ok = True
    for remote, backup in backups.items():
        try:
            if backup:
                await _agent_exec(client, node, vmid, ["mv", "-f", backup, remote])
            else:
                try:
                    await _agent_exec(client, node, vmid, ["rm", "-f", remote])
                except CertError:
                    pass
        except CertError:
            ok = False
    if ok and argv:
        try:
            await _agent_exec(client, node, vmid, argv)
        except CertError:
            pass
    return ok


async def _push_guest_agent(
    site: Dict[str, Any], bundle: Dict[str, Any]
) -> Tuple[str, str]:
    client = get_client()
    node = str(site.get("agent_node") or "")
    vmid = int(str(site.get("agent_vmid") or "0"))
    directory = str(site.get("deploy_dir") or "")
    await _agent_exec(client, node, vmid, ["mkdir", "-p", directory])

    files = _site_files(site, bundle)
    remotes = [directory.rstrip("/") + "/" + name for name, _content, _mode in files]
    backups = await _agent_backup(client, node, vmid, remotes)

    names: List[str] = []
    try:
        for name, content, mode in files:
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
    except CertError:
        # 写了一半就失败：把已替换掉的文件还原，别留新的旧的混在一起
        await _agent_rollback(client, node, vmid, backups, [])
        raise

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
    argv = _reload_argv_checked(command)
    if argv:
        # Guest Agent 支持直接传 argv，不需要 /bin/sh -c
        try:
            output = await _agent_exec(client, node, vmid, argv)
        except CertError as exc:
            # 与 local / ssh 通道保持同一语义：文件已写入但重载失败，
            # 先还原文件再报 ReloadError（部署结果里 deployed=True）
            rolled = await _agent_rollback(client, node, vmid, backups, argv)
            raise ReloadError(
                str(exc)
                + (
                    i18n.pick("；已回滚到上一份证书", "; rolled back to the previous certificate")
                    if rolled
                    else i18n.pick("；回滚失败，请人工检查", "; rollback failed, check manually")
                )
            ) from exc
        detail += i18n.tr("，虚拟机内重载命令已执行") + (
            i18n.tr("：") + output[-200:] if output else ""
        )
    return detail, ""


# ------------------------------------------------------------- PVE 容器部署
#: PVE 没有「往容器里写文件」的 API（没有 lxc exec / 文件上传端点），
#: 所以这条路走节点 SSH + ``pct push`` / ``pct exec``：先把证书 SFTP 到节点
#: 的 /tmp，再推进容器，最后在容器里跑重载命令。
def _node_exec(
    client: Any, argv: List[str], timeout: int = RELOAD_TIMEOUT
) -> Tuple[int, str]:
    """在 PVE 节点上执行一条命令，返回 (退出码, 输出)。"""
    command = " ".join(shlex.quote(part) for part in argv)
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, (out or err).strip()


def _node_or_raise(client: Any, argv: List[str], message: str) -> str:
    code, output = _node_exec(client, argv)
    if code != 0:
        raise CertError(message + (output[-300:] or f"exit {code}"))
    return output


def _lxc_restore(client: Any, vmid: int, backups: Dict[str, str]) -> bool:
    """把容器里的旧文件放回去；首次部署（没有备份）就删掉新写的。"""
    ok = True
    for dest, backup in backups.items():
        argv = ["pct", "exec", str(vmid), "--"] + (
            ["mv", "-f", backup, dest] if backup else ["rm", "-f", dest]
        )
        code, _ = _node_exec(client, argv)
        ok = ok and code == 0
    return ok


def _lxc_deploy_sync(
    site: Dict[str, Any], bundle: Dict[str, Any], captured: Dict[str, str]
) -> str:
    """经 PVE 节点把证书推入容器并重载（同步实现，由 asyncio.to_thread 调用）。"""
    try:
        import paramiko
    except ImportError as exc:  # pragma: no cover - 依赖缺失时的兜底
        raise CertError(i18n.tr("缺少 paramiko 依赖，无法通过节点部署到容器")) from exc

    host = str(site.get("ssh_host") or "")
    port = int(site.get("ssh_port") or 22)
    user = str(site.get("ssh_user") or "root")
    vmid = int(str(site.get("agent_vmid") or "0"))
    directory = str(site.get("deploy_dir") or "")
    recorded = str(site.get("ssh_host_key") or "")

    class _Policy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client: Any, hostname: str, key: Any) -> None:
            fingerprint = _fingerprint(key)
            captured["fp"] = fingerprint
            if recorded and recorded != fingerprint:
                raise CertError(
                    i18n.pick(
                        "PVE 节点主机指纹与记录不一致（记录 ",
                        "The PVE node host key does not match the recorded one (recorded ",
                    )
                    + recorded
                    + i18n.pick("，实际 ", ", got ")
                    + fingerprint
                    + i18n.pick("），已中止部署", "); deployment aborted")
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
        raise CertError(i18n.tr("PVE 节点 SSH 认证失败，请检查用户名与密码/私钥")) from exc
    except paramiko.SSHException as exc:
        raise CertError(i18n.tr("PVE 节点 SSH 连接失败：") + str(exc)) from exc
    except OSError as exc:
        raise CertError(
            i18n.tr("无法连接 PVE 节点 ") + host + ":" + str(port) + i18n.pick("（", " (")
            + str(exc) + i18n.pick("）", ")")
        ) from exc

    files = _site_files(site, bundle)
    tmpdir = "/tmp/pvecenter-cert-" + secrets.token_hex(4)
    backups: Dict[str, str] = {}
    names: List[str] = []
    try:
        sftp = client.open_sftp()
        try:
            try:
                sftp.mkdir(tmpdir)
            except (IOError, OSError):
                pass
            for name, content, mode in files:
                with sftp.open(tmpdir + "/" + name, "wb") as handle:
                    handle.write(content.encode("utf-8"))
                sftp.chmod(tmpdir + "/" + name, mode)
        finally:
            sftp.close()

        try:
            for name, _content, mode in files:
                dest = directory.rstrip("/") + "/" + name
                backup = dest + ".bak-" + secrets.token_hex(4)
                code, _ = _node_exec(
                    client, ["pct", "exec", str(vmid), "--", "cp", "-p", dest, backup]
                )
                backups[dest] = backup if code == 0 else ""
                _node_or_raise(
                    client,
                    ["pct", "push", str(vmid), tmpdir + "/" + name, dest],
                    i18n.tr("推送证书到容器 ") + str(vmid) + i18n.tr(" 失败："),
                )
                _node_or_raise(
                    client,
                    ["pct", "exec", str(vmid), "--", "chmod", format(mode, "o"), dest],
                    i18n.tr("设置容器内证书权限失败："),
                )
                names.append(name)
        except CertError:
            _lxc_restore(client, vmid, backups)
            raise
    finally:
        _node_exec(client, ["rm", "-rf", tmpdir])

    detail = i18n.pick("已写入容器 ", "Written to container ") + str(vmid) + "@" + host + directory
    detail += (
        i18n.pick("（", " (")
        + " / ".join(names)
        + i18n.pick("，来源 ", ", from ")
        + str(bundle["chain_file"])
        + i18n.pick("）", ")")
    )

    command = str(site.get("reload_command") or "").strip()
    argv = _reload_argv_checked(command)
    try:
        if argv:
            code, output = _node_exec(client, ["pct", "exec", str(vmid), "--", *argv])
            if code != 0:
                raise ReloadError(
                    i18n.tr("容器内重载命令返回 ")
                    + str(code)
                    + i18n.tr("：")
                    + (output[-300:] or command)
                )
            detail += i18n.tr("，容器内重载命令已执行") + (
                i18n.tr("：") + output[-200:] if output else ""
            )
    except ReloadError as exc:
        rolled = _lxc_restore(client, vmid, backups)
        raise ReloadError(
            str(exc)
            + (
                i18n.pick("；已回滚到上一份证书", "; rolled back to the previous certificate")
                if rolled
                else i18n.pick("；回滚失败，请人工检查", "; rollback failed, check manually")
            )
        ) from exc
    finally:
        client.close()
    return detail


async def _push_lxc(site: Dict[str, Any], bundle: Dict[str, Any]) -> Tuple[str, str]:
    captured: Dict[str, str] = {}
    try:
        detail = await asyncio.to_thread(_lxc_deploy_sync, site, bundle, captured)
    except ReloadError:
        if captured.get("fp") and captured["fp"] != site.get("ssh_host_key"):
            site["ssh_host_key"] = captured["fp"]
            await update_site(site)
        raise
    return detail, captured.get("fp", "")


# ------------------------------------------------------------- PVE 节点证书
async def _push_pve_node(
    site: Dict[str, Any], bundle: Dict[str, Any]
) -> Tuple[str, str]:
    """通过 PVE 接口上传自定义证书（等价 certd 的「上传证书到 Proxmox」）。

    与其它通道不同，这里不写文件、不执行重载命令：``certificates/custom``
    负责把证书落到 ``/etc/pve/local/pveproxy-ssl.pem``，``restart=1`` 会让
    pveproxy 自己重载。因此也没有回滚动作 —— 接口失败时 PVE 保持原证书。
    """
    node = str(site.get("agent_node") or "").strip()
    if not node:
        raise CertError(i18n.tr("PVE 节点部署需要填写节点名称"))
    try:
        client = get_client()
    except ProxmoxError as exc:
        # 作用域指定的连接不存在 / 已被删除时，get_client 抛的是 ProxmoxError；
        # 统一转成 CertError，部署结果里才会记「失败」而不是整个请求 500。
        raise CertError(str(exc)) from exc
    if not client.conn.configured:
        raise CertError(
            i18n.tr("请先在设置里配置 Proxmox 连接（地址与 API Token）")
        )
    try:
        # force=1：新证书有效期不比旧证书长时也覆盖，否则 PVE 会保留旧证书
        # 却返回成功（certd 早期版本踩过的坑）。
        result = await client.upload_node_certificate(
            node,
            str(bundle["fullchain"]),
            str(bundle["private_key"]),
            force=True,
            restart=True,
        )
    except ProxmoxError as exc:
        raise CertError(
            i18n.tr("上传证书到 PVE 节点 ")
            + node
            + i18n.tr(" 失败：")
            + str(exc)
            + i18n.pick(
                "（请检查节点名称，以及 API Token 是否具备 Sys.Modify 权限）",
                " (check the node name and whether the API token has Sys.Modify)",
            )
        ) from exc
    detail = i18n.pick(
        "已通过 PVE API 上传到节点 ", "Uploaded through the PVE API to node "
    )
    detail += node + i18n.pick(
        "（已由 PVE 落盘并重启 pveproxy）",
        " (written by PVE; pveproxy restarted)",
    )
    upid = str(result or "").strip()
    if upid:
        detail += i18n.pick("，任务 ", ", task ") + upid
    return detail, ""


# ---------------------------------------------------------------- 证书状态同步
def _apply_cert_meta(site: Dict[str, Any], info: Any) -> None:
    """把厂商无关的证书快照写回站点。``info`` 是 ``certproviders.CertInfo``。"""
    site["cert_status"] = int(info.status)
    site["cert_status_text"] = status_text(info.status)
    if info.domains:
        site["cert_domain"] = info.domains[0]
    if info.expire_at:
        site["expire_at"] = int(info.expire_at)
    site["last_check_at"] = now_ts()


async def sync_site_cert(site: Dict[str, Any], provider: Any = None) -> Dict[str, Any]:
    """拉取该站点证书在厂商侧的最新状态并写回站点。

    ``provider`` 由流水线的 prepare 步骤传进来（省一次配置读取）；单独调用时
    按站点归属者现造一个。
    """
    kind = ca_kind(site)
    if kind in ("acme", "upload"):
        # ACME / 托管证书没有「远端状态」可拉：证书就在站点上，到期时间已落库
        return site
    cert_id = str(site.get("pending_cert_id") or site.get("cert_id") or "")
    if not cert_id:
        return site
    if provider is None:
        provider = await provider_for(site)
    try:
        info = await provider.describe(cert_id)
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    if not info:
        site["last_error"] = (
            i18n.pick("证书 ", "Certificate ")
            + cert_id
            + i18n.pick(
                " 在" + provider_label(kind) + "账号下不存在",
                " does not exist in the " + provider_label(kind) + " account",
            )
        )
        return site
    _apply_cert_meta(site, info)
    if not site.get("pending_cert_id"):
        site["last_error"] = ""
    return site


# -------------------------------------------------------------------- 部署
async def _push_target(view: Dict[str, Any], bundle: Dict[str, Any]) -> Tuple[str, str]:
    """按目标的方式分派到具体通道，返回 ``(detail, 主机指纹)``。"""
    method = str(view.get("deploy_method") or "local")
    if method == "ssh":
        return await _push_ssh(view, bundle)
    if method == "agent":
        return await _push_guest_agent(view, bundle)
    if method == "lxc":
        return await _push_lxc(view, bundle)
    if method == "pve":
        return await _push_pve_node(view, bundle)
    return await _push_local(view, bundle)


async def deploy_site(
    site: Dict[str, Any],
    cfg: Optional[Dict[str, Any]] = None,
    action: str = "deploy",
) -> Dict[str, Any]:
    """把证书写到站点的**每一个**部署目标；任一目标失败即整体算失败。

    证书只取一次（腾讯云下载 / ACME 与托管直接用站点缓存的 PEM），然后逐个
    目标落地。失败的目标单独记 ``last_error``，站点保留 ``pending_cert_id``，
    下一轮流水线会重试部署；已经成功的目���重复写同一张证书是幂等的。
    """
    cert_id = str(site.get("pending_cert_id") or site.get("cert_id") or "")
    if not cert_id:
        raise CertError(i18n.tr("该站点还没有证书，请先申请或上传证书"))

    kind = ca_kind(site)
    if kind in ("acme", "upload"):
        # 证书与私钥在签发 / 上传时就放到站点上了，不必再去 CA 下载
        bundle = _acme_bundle(site)
    else:
        # 同步签发（如 ACME）已经在 upload/apply 阶段落库；云厂商在这里才去下载
        provider = build_provider(kind, cfg or await provider_cfg_for(site))
        if not provider.configured:
            raise CertError(
                i18n.tr("请先在证书设置里配置") + provider_label(kind) + i18n.tr("的 API 密钥")
            )
        try:
            bundle = await provider.download(cert_id)
        except ProviderError as exc:
            raise CertError(str(exc)) from exc

    targets = site_targets(site)
    if not targets:
        raise CertError(i18n.tr("请先添加部署目标（至少一个写入位置）"))

    results: List[Dict[str, Any]] = []
    failures: List[str] = []
    for target in targets:
        view = _target_view(site, target)
        label = str(target.get("name") or "").strip() or deploy_target_text(view)
        try:
            detail, fingerprint = await _push_target(view, bundle)
        except ReloadError as exc:
            target["last_error"] = str(exc)
            failures.append(
                label
                + i18n.pick("：证书已写入，但重载失败：", ": written, but reload failed: ")
                + str(exc)
            )
            results.append(
                {"id": target.get("id"), "name": label, "ok": False, "written": True, "detail": str(exc)}
            )
        except CertError as exc:
            target["last_error"] = str(exc)
            failures.append(label + i18n.pick("：", ": ") + str(exc))
            results.append(
                {"id": target.get("id"), "name": label, "ok": False, "written": False, "detail": str(exc)}
            )
        else:
            target["last_error"] = ""
            target["last_deploy_at"] = now_ts()
            if fingerprint:
                target["ssh_host_key"] = fingerprint
            results.append(
                {"id": target.get("id"), "name": label, "ok": True, "written": True, "detail": detail}
            )

    site["targets"] = targets
    # 站点级字段跟着第一个目标走：列表页与旧接口仍然按「一个目录」展示
    first = targets[0]
    site["deploy_method"] = str(first.get("method") or "local")
    for key in DEFAULT_TARGET:
        if key in ("id", "method", "last_error", "last_deploy_at"):
            continue
        site[key] = first.get(key)

    ok_all = not failures
    if ok_all:
        site["cert_id"] = cert_id
        site["pending_cert_id"] = ""
        site["last_deploy_at"] = now_ts()
        site["last_error"] = ""
        detail = i18n.pick(
            "已部署到 " + str(len(results)) + " 个目标：" + "、".join(str(r["name"]) for r in results),
            "Deployed to " + str(len(results)) + " target(s): "
            + ", ".join(str(r["name"]) for r in results),
        )
        detail += i18n.tr("，证书 ID ") + cert_id
    else:
        site["last_error"] = "；".join(failures)[:500]
        detail = site["last_error"]

    await record_log(site, action, "success" if ok_all else "failed", detail)
    await update_site(site)
    return {
        "ok": ok_all,
        "detail": detail,
        "deployed": True,
        "files": bundle["files"],
        "targets": results,
        "target": deploy_target_text(_target_view(site, first)),
    }


# ------------------------------------------------------------------ 申请证书
def _acme_bundle(site: Dict[str, Any]) -> Dict[str, Any]:
    """把站点上缓存的 ACME 证书包装成与腾讯云 ZIP 解析结果同构的 bundle。"""
    fullchain = str(site.get("acme_pem") or "").strip()
    private_key = str(site.get("acme_key") or "").strip()
    if "BEGIN CERTIFICATE" not in fullchain or "PRIVATE KEY" not in private_key:
        raise CertError(
            i18n.tr("该站点还没有可部署的证书，请先申请（ACME）或上传证书（托管）")
        )
    return {
        "fullchain": fullchain + "\n",
        "private_key": private_key + "\n",
        "chain_file": "ACME",
        "key_file": "ACME",
        "files": ["ACME"],
    }


def _acme_solver(site: Dict[str, Any], cfg: Dict[str, Any]) -> Any:
    """按站点配置造挑战执行器：HTTP-01 写 webroot，DNS-01 改 TXT 记录。"""
    if str(site.get("acme_challenge") or "dns") == "http":
        return acme_mod.Http01Solver(str(site.get("acme_webroot") or ""))
    kind = str(site.get("acme_dns_provider") or cfg.get("dns_provider") or "")
    if not kind:
        raise CertError(i18n.tr("DNS-01 需要先在证书设置里选择 DNS 服务商"))
    provider = dnsproviders.build_provider(kind, cfg.get(kind) or {})
    return acme_mod.Dns01Solver(provider, wait=float(cfg.get("dns_wait") or 0))


async def _apply_acme(site: Dict[str, Any], *, renew: bool = False) -> Dict[str, Any]:
    """走 ACME 签发：同步跑完下单 → 验证 → finalize → 下载。

    与腾讯云的异步申请不同，这一步返回时证书已经在手上，但**先不部署**：
    仍然留 ``pending_cert_id`` 交给流水线的 deploy 步骤，保证两条渠道的
    日志、失败退避与通知走同一套路径。
    """
    owner = site_owner(site)
    cfg = await load_acme(owner)
    domains = site_domains(site)
    if not domains:
        raise CertError(i18n.tr("请填写要签发的域名"))
    solver = _acme_solver(site, cfg)
    key_type = (
        acme_mod.KEY_ECC
        if str(cfg.get("encrypt_algo") or "RSA").upper() == "ECC"
        else acme_mod.KEY_RSA
    )
    try:
        async with acme_mod.AcmeClient(
            str(cfg.get("directory") or acme_mod.DIRECTORY_LETSENCRYPT),
            email=str(cfg.get("email") or ""),
            account_key_pem=str(cfg.get("account_key") or ""),
        ) as client:
            issued = await client.issue(domains, solver, key_type=key_type)
            if not cfg.get("account_key"):
                # 首次签发：把新生成的账号密钥存下来，否则下次会再注册一个账号
                await save_acme({**cfg, "account_key": client.account_key.pem}, owner)
    except acme_mod.AcmeError as exc:
        raise CertError(str(exc)) from exc
    except dnsproviders.DnsError as exc:
        raise CertError(str(exc)) from exc
    except OSError as exc:
        raise CertError(i18n.tr("连接 CA 失败：") + str(exc)) from exc

    site["acme_pem"] = issued.fullchain
    site["acme_key"] = issued.private_key
    cert_id = "acme-" + hashlib.sha256(
        (issued.fullchain[:256] + str(issued.expire_at)).encode("utf-8")
    ).hexdigest()[:16]
    site["pending_cert_id"] = cert_id
    site["cert_status"] = STATUS_ISSUED
    site["cert_status_text"] = status_text(STATUS_ISSUED)
    site["cert_domain"] = domains[0]
    site["expire_at"] = issued.expire_at
    site["last_check_at"] = now_ts()
    site["last_error"] = ""
    action = "renew" if renew else "apply"
    await record_log(
        site,
        action,
        "pending",
        i18n.pick(
            "ACME 已签发证书（" + " / ".join(domains) + "），等待部署",
            "ACME issued the certificate (" + " / ".join(domains) + "); waiting for deployment",
        ),
    )
    await update_site(site)
    return {
        "cert_id": cert_id,
        "domain": domains[0],
        "domains": domains,
        "detail": i18n.pick("证书已签发，正在部署", "Certificate issued; deploying"),
    }


def parse_uploaded_certificate(pem: str, key: str) -> Dict[str, Any]:
    """解析用户上传的证书与私钥，返回域名 / 到期时间；不配对时直接拒绝。

    同时校验两件事：私钥与叶子证书是否同一对（贴错文件很常见），以及内容
    里是否有 PEM 头。证书本身是公开信息，但私钥必须整段完整。
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.x509.oid import NameOID

    pem = str(pem or "").strip()
    key = str(key or "").strip()
    if "BEGIN CERTIFICATE" not in pem:
        raise CertError(i18n.tr("证书内容不是 PEM 格式（缺少 BEGIN CERTIFICATE）"))
    if "PRIVATE KEY" not in key:
        raise CertError(i18n.tr("私钥内容不是 PEM 格式（缺少 PRIVATE KEY）"))
    try:
        leaf = x509.load_pem_x509_certificate(pem.encode("utf-8"))
        private = serialization.load_pem_private_key(key.encode("utf-8"), password=None)
    except Exception as exc:  # noqa: BLE001 - 解析失败就是内容不对
        raise CertError(i18n.tr("证书或私钥无法解析：") + str(exc)) from exc

    leaf_pub = leaf.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    key_pub = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    if leaf_pub != key_pub:
        raise CertError(i18n.tr("私钥与证书不匹配（不是同一对）"))

    try:
        san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        domains = [str(item).lower() for item in san.get_values_for_type(x509.DNSName)]
    except x509.ExtensionNotFound:
        names = leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        domains = [str(names[0].value).lower()] if names else []
    expire = getattr(leaf, "not_valid_after_utc", None)
    expire_at = int(expire.timestamp()) if expire is not None else int(leaf.not_valid_after.timestamp())
    return {"domains": domains, "expire_at": expire_at}


def _cert_covers(cert_domains: List[str], wanted: str) -> bool:
    """通配符只覆盖一级：``*.example.com`` 覆盖 a.example.com，不覆盖 a.b.example.com。"""
    for name in cert_domains:
        if name == wanted:
            return True
        if name.startswith("*.") and wanted.count(".") == name.count("."):
            if wanted.endswith(name[1:]):
                return True
    return False


async def import_certificate(
    site: Dict[str, Any], pem: str, key: str
) -> Dict[str, Any]:
    """托管一张外部证书：只校验 + 落库，不申请、不自动续期。"""
    meta = parse_uploaded_certificate(pem, key)
    cert_domains = list(meta["domains"])
    wanted = site_domains(site)
    missing = [name for name in wanted if not _cert_covers(cert_domains, name)]
    if missing:
        raise CertError(
            i18n.tr("证书不包含这些域名：") + "、".join(missing)
        )
    site["acme_pem"] = str(pem).strip() + "\n"
    site["acme_key"] = str(key).strip() + "\n"
    site["ca"] = "upload"
    site["cert_id"] = "upload-" + hashlib.sha256(str(pem).encode("utf-8")).hexdigest()[:16]
    site["pending_cert_id"] = ""
    site["cert_status"] = STATUS_ISSUED
    site["cert_status_text"] = status_text(STATUS_ISSUED)
    site["cert_domain"] = cert_domains[0] if cert_domains else (wanted[0] if wanted else "")
    site["expire_at"] = meta["expire_at"]
    site["last_check_at"] = now_ts()
    site["last_error"] = ""
    await record_log(
        site,
        "import",
        "success",
        i18n.pick(
            "已托管证书（" + " / ".join(cert_domains[:5]) + "），等待部署",
            "Certificate imported (" + " / ".join(cert_domains[:5]) + "); waiting for deployment",
        ),
    )
    await update_site(site)
    return {
        "cert_id": site["cert_id"],
        "domains": cert_domains,
        "expire_at": site["expire_at"],
        "detail": i18n.pick("证书已导入，可以部署了", "Certificate imported; ready to deploy"),
    }


async def apply_certificate(
    site: Dict[str, Any],
    cfg: Optional[Dict[str, Any]] = None,
    *,
    renew: bool = False,
) -> Dict[str, Any]:
    """申请证书（或为已有证书申请续期），返回新的证书 ID。

    云厂商是异步的（提交后等 CA 签发）；ACME 在这个调用里就跑完验证与签发。
    两条路径的对外语义保持一致：都留下 ``pending_cert_id``，由部署步骤接手。
    具体走哪家厂商由 ``site['ca']`` 决定，这里不再出现厂商名。
    """
    kind = ca_kind(site)
    if kind == "upload":
        raise CertError(
            i18n.tr("该站点使用托管证书，请直接上传证书，而不是向 CA 申请")
        )
    if kind == "acme":
        return await _apply_acme(site, renew=renew)

    provider = build_provider(kind, cfg or await provider_cfg_for(site))
    if not provider.configured:
        raise CertError(
            i18n.tr("请先在证书设置里配置") + provider_label(kind) + i18n.tr("的 API 密钥")
        )
    domains = site_domains(site)
    old_id = str(site.get("cert_id") or "") if renew else ""
    try:
        result = await provider.apply(
            domains, renew_from=old_id, alias=str(site.get("name") or domains[0])
        )
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    except TencentCloudError as exc:  # 兼容直接抛腾讯云异常的老客户端
        raise CertError(str(exc)) from exc

    site["pending_cert_id"] = result.cert_id
    site["cert_status"] = int(result.status)
    site["cert_status_text"] = status_text(result.status)
    if result.expire_at:
        site["expire_at"] = int(result.expire_at)
    if result.pem:
        # 同步签发的厂商（如自建 CA）直接把证书落库，部署时不必再远程取
        site["acme_pem"] = result.pem
        site["acme_key"] = result.key
    site["last_error"] = ""
    action = "renew" if renew else "apply"
    await record_log(
        site,
        action,
        "pending",
        provider_label(kind)
        + i18n.pick(" 已受理申请（ID ", " accepted the request (ID ")
        + result.cert_id
        + i18n.pick("），等待 CA 签发后自动部署", "); it will be deployed once the CA issues it"),
    )
    await update_site(site)
    return {
        "cert_id": result.cert_id,
        "domain": domains[0] if domains else "",
        "domains": domains,
        "provider": kind,
        "detail": i18n.pick("证书申请已提交，等待签发", "Request submitted; waiting for the CA to issue"),
    }


async def bind_certificate(
    site: Dict[str, Any],
    cert_id: str,
    *,
    kind: Optional[str] = None,
) -> Dict[str, Any]:
    """绑定厂商账号下已有的证书。

    ``kind`` 用于「把某家厂商的证书绑到站点上」：绑定同时把站点的签发渠道切到
    这家厂商，否则部署时会拿着别家的证书 ID 去错误的接口下载。
    """
    cert_id = str(cert_id or "").strip()
    if not cert_id:
        raise CertError(i18n.tr("请填写证书 ID"))
    target_kind = str(kind or ca_kind(site)).strip().lower()
    if not is_cloud_provider(target_kind):
        raise CertError(i18n.tr("不支持的证书签发厂商：") + target_kind)
    provider = build_provider(target_kind, await load_provider(target_kind, site_owner(site)))
    if not provider.configured:
        raise CertError(
            i18n.tr("请先在证书设置里配置") + provider_label(target_kind) + i18n.tr("的 API 密钥")
        )
    try:
        info = await provider.describe(cert_id)
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    if not info:
        raise CertError(
            i18n.pick(
                "证书 " + cert_id + " 不存在或不属于当前账号",
                f"Certificate {cert_id} does not exist or belongs to another account",
            )
        )
    site["ca"] = target_kind
    site["cert_id"] = cert_id
    site["pending_cert_id"] = ""
    _apply_cert_meta(site, info)
    site["last_error"] = ""
    await record_log(
        site,
        "bind",
        "success",
        i18n.pick("已绑定证书 ", "Bound certificate ")
        + cert_id
        + "（"
        + (info.domains[0] if info.domains else "")
        + "，"
        + provider_label(target_kind)
        + "，"
        + status_text(info.status)
        + "）",
    )
    await update_site(site)
    return {
        "cert_id": cert_id,
        "provider": target_kind,
        "detail": i18n.tr("证书已绑定"),
        "cert_status_text": site["cert_status_text"],
    }


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


#: 单站点续期流水线。顺序固定，分支只表现为「哪几步被跳过」：
#:
#:     prepare（取该站点归属者的密钥与客户端）
#:     sync（拉 CA 侧状态） → decide（纯计算，不写库）
#:       ├─ deploy  已签发   → 下载 + 部署 + 重载
#:       ├─ drop    申请失败 → 清掉 pending 并记原因
#:       ├─ notice  到期但未开自动续期 → 记提示
#:       ├─ due     到期且允许续期 → 提交续期申请
#:       └─ wait    仍在签发中 → 只落库
#:
#: 要加动作（到期提醒、多目标分发、部署后回滚），往列表里 append 一个 Step 即可。
async def _step_prepare(ctx: Context) -> str:
    """取「这个站点归属者」在该签发渠道上的配置。

    以前是整轮共用一个 ``load_tencent()`` 的客户端，管理员和普通用户都会因
    归属不同而拿不到自己的密钥（管理员那份存在 ``cert_tencent:<username>``），
    结果是定时续期对谁都不生效。现在按站点归属逐个取，并且按 ``site['ca']``
    选厂商 —— 同一轮里可以混着腾讯云、阿里云、华为云与 ACME 的站点。
    """
    kind = ca_kind(ctx.site)
    if kind == "upload":
        # 托管证书不签发也不续期，只需要部署与到期提醒
        ctx.set("cfg", {})
        ctx.set("provider", None)
        ctx.set("configured", True)
        ctx.set("prepared", True)
        return i18n.pick("托管证书（自行上传）", "Managed certificate (uploaded manually)")
    if kind == "acme":
        cfg = await load_acme(site_owner(ctx.site))
        configured = bool(cfg.get("email"))
        if str(ctx.site.get("acme_challenge") or "dns") == "dns":
            configured = configured and bool(
                ctx.site.get("acme_dns_provider") or cfg.get("dns_provider")
            )
        else:
            configured = configured and bool(ctx.site.get("acme_webroot"))
        ctx.set("cfg", cfg)
        ctx.set("provider", None)
        ctx.set("configured", configured)
        ctx.set("prepared", True)
        if configured:
            return i18n.pick("已配置", "Configured")
        return i18n.pick(
            "ACME 配置不完整（邮箱 / 验证方式 / DNS 服务商）",
            "Incomplete ACME configuration (email / validation / DNS provider)",
        )
    # 云厂商：按站点归属者取配置，造一个统一客户端（不认厂商名）
    kind = ca_kind(ctx.site)
    cfg = await provider_cfg_for(ctx.site)
    provider = build_provider(kind, cfg)
    ctx.set("cfg", cfg)
    ctx.set("provider", provider)
    ctx.set("configured", bool(provider.configured))
    ctx.set("prepared", True)
    if provider.configured:
        return provider_label(kind) + i18n.pick(" 已配置", " configured")
    return provider_label(kind) + i18n.pick(" 未配置 API 密钥", " API credentials missing")


async def _step_sync(ctx: Context) -> None:
    """拉取证书在 CA 侧的最新状态（签发结果、到期时间）。"""
    await sync_site_cert(ctx.site, ctx.get("provider"))
    ctx.set("synced", True)


def _decide(ctx: Context) -> str:
    """纯计算：本次该走哪条分支。不写库、不发请求，便于单独测试。"""
    site = ctx.site
    pending = str(site.get("pending_cert_id") or "")
    if pending:
        status = int(site.get("cert_status") or 0)
        if status == STATUS_ISSUED:
            return "deploy"
        if status in STATUS_FAILED:
            return "drop"
        return "wait"
    left = days_left(site)
    ctx.set("left", left)
    threshold = renew_threshold(site, ctx.get("cfg"))
    if left is None or left > threshold:
        return "none"
    if str(site.get("ca") or "tencent") == "upload":
        # 托管证书无法自动续期：到期只能提醒用户重新上传
        return "notice"
    if not site.get("auto_renew"):
        return "notice"
    return "due"


async def _step_decide(ctx: Context) -> str:
    decision = _decide(ctx)
    ctx.set("decision", decision)
    return decision


async def _step_guard(ctx: Context) -> str:
    """失败退避窗口内先不动手。

    没有这道闸，重试作业（5 分钟一轮）会变成"每 5 分钟打一次 CA"，既浪费
    调用配额，也让失败日志刷屏。窗口只拦"静默续期"，不影响手动操作。
    """
    site = ctx.site
    due = int(site.get("next_attempt_at") or 0)
    if due and due > now_ts() and not site.get("pending_cert_id"):
        ctx.set("hold", True)
        return i18n.pick("等待重试（", "Retry in ") + str(max(1, (due - now_ts()) // 60)) + i18n.pick(" 分钟后）", " min")
    return i18n.pick("可以执行", "Ready")


async def _step_issue(ctx: Context) -> None:
    site = ctx.site
    await apply_certificate(site, ctx.get("cfg"), renew=True)
    left = ctx.get("left")
    kind = ca_kind(site)
    if kind == "acme":
        detail = i18n.pick(
            "证书剩余 " + str(left) + " 天，已通过 ACME 重新签发",
            f"Certificate expires in {left} days; reissued through ACME",
        )
    else:
        detail = (
            provider_label(kind)
            + i18n.pick("：证书剩余 ", ": certificate expires in ")
            + str(left)
            + i18n.pick(" 天，已提交续期申请", " days; renewal request submitted")
        )
    ctx.set(
        "result",
        {"site": site.get("name"), "action": "renew", "detail": detail},
    )


async def _cleanup_old_cert(
    ctx: Context, site: Dict[str, Any], old_id: str, new_id: str
) -> None:
    """部署成功后删掉 CA 侧的旧证书。

    删除失败不算部署失败：新证书已经在用了，旧证书只是多占一个配额，
    记一条 cleanup 日志让人知道就行。
    """
    if not site.get("auto_delete_old") or not old_id or old_id == new_id:
        return
    provider = ctx.get("provider")
    if provider is None:
        return
    try:
        await provider.remove(old_id)
    except Exception as exc:  # noqa: BLE001 - 清理是尽力而为
        await record_log(
            site,
            "cleanup",
            "failed",
            i18n.pick("旧证书 " + old_id + " 删除失败：", f"Failed to delete old cert {old_id}: ")
            + str(exc),
        )
        return
    await record_log(
        site,
        "cleanup",
        "success",
        i18n.pick("已删除 CA 侧旧证书 " + old_id, f"Deleted the old certificate {old_id}"),
    )


async def _step_deploy(ctx: Context) -> None:
    site = ctx.site
    pending = str(site.get("pending_cert_id") or "")
    old_id = str(site.get("cert_id") or "")
    outcome = await deploy_site(site, ctx.get("cfg"), action="renew")
    ok = bool(outcome.get("ok"))
    detail = str(outcome.get("detail") or "")
    if ok:
        message = i18n.pick(
            "续期证书 " + pending + " 已签发并部署",
            f"Renewal certificate {pending} was issued and deployed",
        )
    else:
        message = (
            i18n.pick("续期证书 " + pending + " 部署失败：", f"Renewal certificate {pending} failed to deploy: ")
            + detail
        )
    await record_log(site, "renew", "success" if ok else "failed", message)
    owner = site_owner(site)
    if ok:
        site["attempt_count"] = 0
        site["next_attempt_at"] = 0
        await _cleanup_old_cert(ctx, site, old_id, pending)
        await certnotify.notify(
            owner,
            site,
            certnotify.EVENT_RENEWED,
            i18n.pick("证书已续期：" + str(site.get("domain") or ""), "Certificate renewed: " + str(site.get("domain") or "")),
            i18n.pick(
                "站点「" + str(site.get("name") or "") + "」已换上新证书并完成部署。",
                "Site \"" + str(site.get("name") or "") + "\" was renewed and deployed.",
            ),
        )
    else:
        await certnotify.notify(
            owner,
            site,
            certnotify.EVENT_DEPLOY_FAILED,
            i18n.pick("证书部署失败：" + str(site.get("domain") or ""), "Certificate deploy failed: " + str(site.get("domain") or "")),
            str(outcome.get("detail") or site.get("last_error") or ""),
        )
    ctx.set(
        "result",
        {"site": site.get("name"), "action": "deploy", "detail": outcome.get("detail")},
    )


async def _step_drop(ctx: Context) -> None:
    """CA 侧申请失败：清掉 pending，排一次退避重试，并告警。"""
    site = ctx.site
    status = int(site.get("cert_status") or 0)
    site["pending_cert_id"] = ""
    site["last_error"] = i18n.pick(
        "续期证书申请失败：" + status_text(status),
        f"Renewal request failed: {i18n.tr(status_text(status))}",
    )
    attempts = int(site.get("attempt_count") or 0) + 1
    site["attempt_count"] = attempts
    if attempts >= len(BACKOFF_STEPS):
        # 连续失败到上限就停手，避免把配额和日志都刷光；等人为介入
        site["next_attempt_at"] = 0
        site["last_error"] += i18n.pick(
            "（已连续失败 " + str(attempts) + " 次，暂停自动重试）",
            f" ({attempts} failures in a row; auto-retry paused)",
        )
    else:
        site["next_attempt_at"] = now_ts() + backoff_after(attempts)
    await record_log(site, "renew", "failed", site["last_error"])
    await certnotify.notify(
        site_owner(site),
        site,
        certnotify.EVENT_RENEW_FAILED,
        i18n.pick("证书续期失败：" + str(site.get("domain") or ""), "Certificate renewal failed: " + str(site.get("domain") or "")),
        site["last_error"],
    )
    ctx.set("result", {"site": site.get("name"), "action": "renew", "detail": site["last_error"]})


async def _step_notice(ctx: Context) -> None:
    """到期但没开自动续期：记提示，并且真的发一次提醒。"""
    site = ctx.site
    left = ctx.get("left")
    site["last_error"] = i18n.pick(
        "证书剩余 " + str(left) + " 天，未开启自动续期",
        f"Certificate expires in {left} days; auto-renew is off",
    )
    await certnotify.notify(
        site_owner(site),
        site,
        certnotify.EVENT_EXPIRING,
        i18n.pick("证书即将到期：" + str(site.get("domain") or ""), "Certificate expiring: " + str(site.get("domain") or "")),
        i18n.pick(
            "站点「" + str(site.get("name") or "") + "」的证书剩余 " + str(left) + " 天，且未开启自动续期。",
            "Site \"" + str(site.get("name") or "") + "\" expires in " + str(left) + " days and auto-renew is off.",
        ),
    )
    ctx.set("result", {"site": site.get("name"), "action": "notice", "detail": site["last_error"]})


async def _step_warn(ctx: Context) -> str:
    """到期前 7 天提醒一次（按 12 小时冷却），用来兜住"续期一直没成功"。"""
    site = ctx.site
    left = ctx.get("left")
    if left is None or int(left) > 7:
        return ""
    await certnotify.notify(
        site_owner(site),
        site,
        certnotify.EVENT_EXPIRING,
        i18n.pick("证书即将到期：" + str(site.get("domain") or ""), "Certificate expiring: " + str(site.get("domain") or "")),
        i18n.pick(
            "站点「" + str(site.get("name") or "") + "」的证书剩余 " + str(left) + " 天。",
            "Site \"" + str(site.get("name") or "") + "\" expires in " + str(left) + " days.",
        ),
    )
    return i18n.pick("剩余 ", "") + str(left) + i18n.pick(" 天", " days left")


def _only(decision: str) -> Any:
    """只有被 decide 选中时才执行该步骤。"""
    return lambda ctx: ctx.get("decision") == decision


def _has_cert(ctx: Context) -> bool:
    """没有证书也没有待签发证书时，整条流水线无事可做（连库都不写）。"""
    return bool(ctx.site.get("pending_cert_id") or ctx.site.get("cert_id"))


_RENEW_PIPELINE = Pipeline(
    "cert-renew",
    [
        Step("guard", _step_guard, when=_has_cert, detail=lambda ctx, value: value),
        Step(
            "prepare",
            _step_prepare,
            when=lambda ctx: _has_cert(ctx) and not ctx.get("hold"),
            detail=lambda ctx, value: value,
        ),
        Step("sync", _step_sync, when=lambda ctx: ctx.get("configured", False)),
        Step(
            "decide",
            _step_decide,
            when=lambda ctx: ctx.get("synced", False),
            detail=lambda ctx, value: i18n.pick("决策：", "Decision: ") + str(value),
        ),
        Step("warn", _step_warn, when=lambda ctx: ctx.get("decision") in ("due", "notice")),
        Step("issue", _step_issue, when=_only("due")),
        Step("deploy", _step_deploy, when=_only("deploy")),
        Step("drop", _step_drop, when=_only("drop")),
        Step("notice", _step_notice, when=_only("notice")),
    ],
)


async def renew_site(site: Dict[str, Any]) -> RunResult:
    """跑一次单站点续期流水线，并把「最后运行结果」记到站点上。

    配置与客户端由流水线内的 ``prepare`` 按站点归属现取（见该步骤的说明），
    调用方不必也不该传一份「全局」客户端进来。

    逐步结果（``last_run``）留在站点 JSON 里而不是单独建表：一次运行最多六七
    行、每行不到 100 字节，够排障用，也省掉一次清理与分页。
    """
    ctx = Context(site=site)
    run = await _RENEW_PIPELINE.run(ctx)
    site["last_run"] = run.as_list()
    site["last_run_at"] = now_ts()
    site["last_run_status"] = run.status
    # 取过配置或同步过的站点才落库；没证书的站点保持「不碰库」的旧行为
    if ctx.get("prepared", False) or ctx.get("synced", False):
        await update_site(site)
    return run


async def _run_sites(sites: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """逐站点跑流水线；单站点失败登记退避后继续下一个。"""
    results: List[Dict[str, Any]] = []
    for site in sites:
        if not site.get("enabled"):
            continue
        run = await renew_site(site)
        if run.exc is not None:
            # 接口抖动：记一笔就继续下一个站点，别让一个坏站点拖垮整轮；
            # 其它异常（代码 bug / 数据库）照旧往上抛，交给调度器记失败。
            if not isinstance(run.exc, TencentCloudError):
                raise run.exc
            site["last_error"] = str(run.exc)
            attempts = int(site.get("attempt_count") or 0) + 1
            site["attempt_count"] = attempts
            site["next_attempt_at"] = (
                0 if attempts >= len(BACKOFF_STEPS) else now_ts() + backoff_after(attempts)
            )
            await record_log(
                site, "sync", "failed",
                i18n.tr("腾讯云接口调用失败：") + str(run.exc),
            )
            await update_site(site)
            continue
        if run.value:
            results.append(run.value)
    return results


async def renew_tick() -> List[Dict[str, Any]]:
    """定时任务：逐站点跑续期流水线（配置 → 同步 → 判定 → 申请/部署 → 落库）。"""
    if _TICK_LOCK.locked():
        logger.info("续期流水线仍在执行，本轮跳过")
        return []
    async with _TICK_LOCK:
        sites = await load_sites()
        if not sites:
            return []
        return await _run_sites(sites)


async def retry_tick() -> List[Dict[str, Any]]:
    """补跑作业：只处理退避到点（``next_attempt_at`` 已到期）的站点。

    6 小时一轮的主作业覆盖不到 10 分钟 / 30 分钟这类短退避，所以单独起一个
    5 分钟的轻量作业。每轮最多 3 个站点，避免一条坏链路把 5 分钟窗口占满。
    """
    if _TICK_LOCK.locked():
        # 主作业正在跑：它本次会重新判定每个站点，补跑没有额外价值
        logger.info("续期流水线仍在执行，退避补跑本轮跳过")
        return []
    async with _TICK_LOCK:
        now = now_ts()
        sites = await load_sites()
        due = []
        for site in sites:
            if not site.get("enabled"):
                continue
            at = int(site.get("next_attempt_at") or 0)
            if at and at <= now:
                due.append(site)
        if not due:
            return []
        return await _run_sites(due[:3])


async def sync_all(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """手动同步站点的证书状态（``owner=None`` 表示管理员同步全部）。

    按「归属 + 厂商」分组：同一家厂商的密钥只读一次，不同厂商的站点互不影响；
    某一家没配密钥时只跳过它，不让整批同步失败。
    """
    sites = [
        site
        for site in visible_sites(await load_sites(), owner)
        if (site.get("cert_id") or site.get("pending_cert_id"))
        # ACME / 托管证书没有远端状态，混进来只会让整批同步无谓失败
        and ca_kind(site) not in ("acme", "upload")
    ]
    groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for site in sites:
        groups.setdefault((site_owner(site), ca_kind(site)), []).append(site)
    for (owner_name, kind), group_sites in groups.items():
        provider = build_provider(kind, await load_provider(kind, owner_name))
        if not provider.configured:
            raise CertError(
                i18n.tr("请先配置") + provider_label(kind) + i18n.tr("的 API 密钥")
            )
        for site in group_sites:
            await sync_site_cert(site, provider)
            await update_site(site)
    # 重新读一遍：上面的 site 是副本，读回来才是刚写库的最新状态
    return visible_sites(await load_sites(), owner)


async def list_remote_certificates(
    kind: str = "tencent",
    owner: str = "",
    search: str = "",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """列出某家厂商账号下的证书，供页面绑定选择。"""
    kind = str(kind or "tencent").strip().lower()
    provider = build_provider(kind, await load_provider(kind, owner))
    if not provider.configured:
        raise CertError(i18n.tr("请先配置") + provider_label(kind) + i18n.tr("的 API 密钥"))
    try:
        items = await provider.list_certs(search=search, limit=limit)
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    result: List[Dict[str, Any]] = []
    for info in items:
        item = info.as_dict()
        item["domain"] = info.domains[0] if info.domains else ""
        item["domains"] = list(info.domains)
        item["status_text"] = i18n.tr(info.status_text)
        item["provider"] = kind
        item["provider_label"] = provider_label(kind)
        result.append(item)
    return result


async def test_connection(kind: str = "tencent", owner: str = "") -> Dict[str, Any]:
    """验证该用户在指定厂商上的密钥是否可用（顺带返回账号下的证书数量）。"""
    kind = str(kind or "tencent").strip().lower()
    provider = build_provider(kind, await load_provider(kind, owner))
    if not provider.configured:
        raise CertError(
            i18n.tr("请先填写") + provider_label(kind) + i18n.tr("的 API 密钥")
        )
    try:
        result = await provider.test()
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    total = int(result.get("total") or 0)
    return {
        "total": total,
        "detail": i18n.pick(
            "连接成功，账号下共有 " + str(total) + " 张证书",
            f"Connected; this account has {total} certificate(s)",
        ),
    }


# ---------------------------------------------------------------- 证书清单
def _cert_covered_by(info: Any, site: Dict[str, Any]) -> List[str]:
    """证书覆盖不到的站点域名（返回空列表表示可以绑）。"""
    missing: List[str] = []
    for name in site_domains(site):
        if not _cert_covers(list(info.domains), name):
            missing.append(name)
    return missing


async def inventory(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """站点证书清单：按「厂商 + 证书 ID」聚合，一张证书绑了几个站点一目了然。

    直接从站点派生而不是另存一份：站点才是唯一事实来源，避免两处数据不同步。
    """
    sites = visible_sites(await load_sites(), owner)
    # key 里带上归属者：不同用户的证书 ID 来自各自账号，理论上可能撞号
    groups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for site in sites:
        cert_id = str(site.get("cert_id") or site.get("pending_cert_id") or "")
        if not cert_id:
            continue
        kind = ca_kind(site)
        item = groups.setdefault(
            (site_owner(site), kind, cert_id),
            {
                "provider": kind,
                "provider_label": provider_label(kind),
                "username": site_owner(site),
                "cert_id": cert_id,
                "domains": [],
                "status": int(site.get("cert_status") or 0),
                "status_text": status_text(int(site.get("cert_status") or 0)),
                "expire_at": int(site.get("expire_at") or 0),
                "days_left": days_left(site),
                "pending": not bool(site.get("cert_id")),
                "sites": [],
            },
        )
        for name in site_domains(site):
            if name not in item["domains"]:
                item["domains"].append(name)
        item["sites"].append(
            {
                "id": str(site.get("id") or ""),
                "name": str(site.get("name") or ""),
                "domain": str(site.get("domain") or ""),
                "username": site_owner(site),
            }
        )
        # 同一张证书被多个站点使用时，取最保守的到期/状态信息
        if int(site.get("expire_at") or 0) and (
            not item["expire_at"] or int(site["expire_at"]) < item["expire_at"]
        ):
            item["expire_at"] = int(site["expire_at"])
            item["days_left"] = days_left(site)
    items = sorted(
        groups.values(),
        key=lambda item: (item["days_left"] if item["days_left"] is not None else 9999),
    )
    for item in items:
        item["site_count"] = len(item["sites"])
        item["status_text"] = i18n.tr(item["status_text"])
    return items


async def bind_to_sites(
    kind: str,
    cert_id: str,
    site_ids: List[str],
    owner: str = "",
) -> Dict[str, Any]:
    """把一张已有证书一次性绑到多个站点上（多站点多证书绑定的入口）。

    只处理归属者自己的站点；证书覆盖不到某个站点的域名时跳过并给出原因，
    不会因为一个不匹配的站点让整批失败。
    """
    kind = str(kind or "").strip().lower()
    cert_id = str(cert_id or "").strip()
    if not is_cloud_provider(kind):
        raise CertError(i18n.tr("不支持的证书签发厂商：") + kind)
    if not cert_id:
        raise CertError(i18n.tr("请填写证书 ID"))
    wanted = {str(item) for item in site_ids or [] if str(item)}
    if not wanted:
        raise CertError(i18n.tr("请选择要绑定的站点"))
    provider = build_provider(kind, await load_provider(kind, owner))
    if not provider.configured:
        raise CertError(i18n.tr("请先配置") + provider_label(kind) + i18n.tr("的 API 密钥"))
    try:
        info = await provider.describe(cert_id)
    except ProviderError as exc:
        raise CertError(str(exc)) from exc
    if not info:
        raise CertError(
            i18n.pick(
                "证书 " + cert_id + " 不存在或不属于当前账号",
                f"Certificate {cert_id} does not exist or belongs to another account",
            )
        )

    bound: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    for site in await load_sites():
        if str(site.get("id") or "") not in wanted:
            continue
        if owner and site_owner(site) != owner:
            continue
        missing = _cert_covered_by(info, site)
        if missing:
            skipped.append(
                {
                    "id": str(site.get("id") or ""),
                    "name": str(site.get("name") or ""),
                    "reason": i18n.pick(
                        "证书不包含域名：" + "、".join(missing),
                        "Certificate does not cover: " + ", ".join(missing),
                    ),
                }
            )
            continue
        site["ca"] = kind
        site["cert_id"] = cert_id
        site["pending_cert_id"] = ""
        _apply_cert_meta(site, info)
        site["last_error"] = ""
        await record_log(
            site,
            "bind",
            "success",
            i18n.pick(
                "已绑定" + provider_label(kind) + "证书 " + cert_id + "（多站点绑定）",
                f"Bound the {provider_label(kind)} certificate {cert_id} (multi-site binding)",
            ),
        )
        await update_site(site)
        bound.append({"id": site.get("id"), "name": site.get("name")})
    if not bound and skipped:
        raise CertError(skipped[0]["reason"])
    return {
        "bound": len(bound),
        "sites": bound,
        "skipped": skipped,
        "detail": i18n.pick(
            "已绑定 " + str(len(bound)) + " 个站点",
            f"Bound to {len(bound)} site(s)",
        ),
    }
