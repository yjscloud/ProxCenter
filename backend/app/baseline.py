"""安全基线检查与一键加固（全平台：本机 + SSH 受管主机）。

体检对象是**整个平台上的服务器**，两个来源：

* **本机**（面板所在主机）—— 直接读系统文件 / 跑只读命令，不需要额外凭据；
* **受管主机** —— 复用 :mod:`app.sshremote` 的 SSH 通道，在远端跑一条固定的
  **只读单行命令**把原始数据分节打印回来，再在本地用**同一套判定逻辑**评分。
  （Proxmox 集群的其它节点若要体检，把它作为受管主机加进「SSH 安全 → 受管主机」
  即可 —— PVE API 本身不提供在节点上执行 shell 的能力。）

设计上刻意把**采集**与**判定**分开：
``local_snapshot()`` / ``remote_snapshot()`` 只负责取原始数据，
``evaluate(snapshot)`` 是纯函数，本机与远程共用，所以两端结论口径完全一致。

七类检查，全部只读：

* **SSH 服务**：是否禁 root 直登、是否关了密码认证、是否允许空口令、重试上限；
* **密码策略**：``login.defs`` 的最长有效期 / 最小长度、PAM 强度模块、失败锁定；
* **防火墙**：ufw / firewalld / nftables / iptables（含 Proxmox 自带的 pve-firewall）；
* **时间同步**：timedatectl 的同步状态或 chrony / timesyncd 服务；
* **账号安全**：空口令且可登录的账号、UID 0 的非 root 账号；
* **内核参数**：ASLR、SYN cookies、rp_filter、ICMP 重定向等关键 sysctl。

一份报告里给出**评分**（按高 / 中 / 低危加权）、**逐项加固建议**，以及**一键修复**：
修复只动面板自己命名的两处文件（``/etc/ssh/sshd_config.d/99-panel-baseline.conf``
与 ``/etc/sysctl.d/99-panel-baseline.conf``）与 ``/etc/login.defs``（先备份再改），
改完立刻校验，校验不过自动回滚 —— 绝不把机器改到登录不上去。

远程加固额外有一道守卫：如果面板正是用「root + 口令」连这台主机的，禁止 root
登录的加固会让面板立刻失去对该主机的管理能力，此时直接拒绝并说明原因。
"""
from __future__ import annotations

import asyncio
import glob
import logging
import os
import platform
import re
import shutil
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .formatters import short_hostname
from .i18n import pick, tr

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 常量与路径

SSHD_MAIN = "/etc/ssh/sshd_config"
SSHD_DROPIN_DIR = "/etc/ssh/sshd_config.d"
# 面板托管的两处加固文件：只碰它们，不动发行版自带配置
SSHD_DROPIN = os.path.join(SSHD_DROPIN_DIR, "99-panel-baseline.conf")
SYSCTL_FILE = "/etc/sysctl.d/99-panel-baseline.conf"
LOGIN_DEFS = "/etc/login.defs"

SHADOW_FILE = "/etc/shadow"
PASSWD_FILE = "/etc/passwd"

PAM_FILES = (
    "/etc/pam.d/sshd",
    "/etc/pam.d/common-password",
    "/etc/pam.d/common-auth",
    "/etc/pam.d/system-auth",
    "/etc/pam.d/password-auth",
    "/etc/pam.d/login",
)

# 非交互 / 不可登录的 shell：这些账号即使空口令也进不来，不算「弱口令用户」
NOLOGIN_SHELLS = frozenset(
    {
        "",
        "/usr/sbin/nologin",
        "/sbin/nologin",
        "/usr/bin/false",
        "/bin/false",
        "/usr/sbin/false",
    }
)

# 严重级别 → 评分权重（高危扣得多）
WEIGHTS = {"high": 3, "medium": 2, "low": 1}

CATEGORY_LABELS: Dict[str, str] = {
    "ssh": "SSH 服务",
    "password": "密码策略",
    "firewall": "防火墙",
    "ntp": "时间同步",
    "accounts": "账号安全",
    "kernel": "内核参数",
}
CATEGORY_ORDER = ("ssh", "password", "firewall", "ntp", "accounts", "kernel")

STATUS_LABELS = {"pass": "通过", "warn": "待改进", "fail": "不合格", "unknown": "无法检测"}

# 远程探测：把一次体检所需的全部原始数据塞进**一条**只读命令，用分节标记隔开。
# 之所以要合并：sshremote.run_command 每调一次就新建一条 SSH 连接，分节输出能把
# N 次往返压成 1 次（十几台主机时差别很明显）。
SECTION_PREFIX = "##baseline:"
SECTION_RE = re.compile(r"^##baseline:([a-z0-9-]+)##$")


def _section(name: str) -> str:
    return f"printf '{SECTION_PREFIX}{name}##\\n'"


def _sshremote():
    """延迟导入 sshremote：本机体检不该被 SSH 依赖（paramiko）拖累。"""
    from . import sshremote

    return sshremote


# ---------------------------------------------------------------- 基础工具

def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def _write_text(path: str, content: str, mode: int = 0o644) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    try:
        os.chmod(path, mode)
    except OSError:  # pragma: no cover - 某些文件系统不支持 chmod
        pass


def _run(command: List[str], timeout: float = 8.0) -> Tuple[bool, str]:
    """跑一条固定命令。参数用列表传递，绝不拼 shell。"""
    import subprocess

    try:
        proc = subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    return proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")


def _which(name: str) -> str:
    return shutil.which(name) or ""


def _elevated() -> bool:
    try:
        return os.geteuid() == 0
    except AttributeError:  # pragma: no cover - 非 POSIX 平台
        return False


def _systemd_active(unit: str) -> bool:
    binary = _which("systemctl")
    if not binary:
        return False
    ok, output = _run([binary, "is-active", unit], timeout=5)
    return ok and output.strip() == "active"


def _check(
    key: str,
    category: str,
    label: str,
    status: str,
    severity: str,
    value: str,
    expected: str,
    detail: str,
    hint: str = "",
    fixable: bool = False,
    auto: bool = True,
) -> Dict[str, Any]:
    return {
        "key": key,
        "category": category,
        # 检查项文案是**全平台唯一出口**：本机与远程、单机与总览都从这里出去，
        # 所以本地化只在这一处做，各 _check_* 仍照常写字面量。
        "label": tr(label),
        "status": status,
        "severity": severity,
        "value": tr(value),
        "expected": tr(expected),
        "detail": tr(detail),
        "hint": tr(hint),
        "fixable": bool(fixable),
        # auto=False 的项仍可「单独修复」，但不参与「一键加固」——这类改动一旦
        # 生效可能把人关在门外（典型的例子：关闭 SSH 口令认证），必须由用户点名执行。
        "auto": bool(auto),
    }


# ---------------------------------------------------------------- SSH 配置

SSH_KEY_CASE = {
    "permitrootlogin": "PermitRootLogin",
    "passwordauthentication": "PasswordAuthentication",
    "permitemptypasswords": "PermitEmptyPasswords",
    "maxauthtries": "MaxAuthTries",
    "pubkeyauthentication": "PubkeyAuthentication",
    "kbdinteractiveauthentication": "KbdInteractiveAuthentication",
    "challengeresponseauthentication": "ChallengeResponseAuthentication",
    "x11forwarding": "X11Forwarding",
}

# 每个 SSH 加固项要写的键值：本机加固与远程加固共用，避免两处各写一份常量
SSH_FIX_VALUES: Dict[str, Dict[str, str]] = {
    "ssh_root_login": {"PermitRootLogin": "prohibit-password"},
    "ssh_password_auth": {"PasswordAuthentication": "no"},
    "ssh_empty_passwords": {"PermitEmptyPasswords": "no"},
    "ssh_max_auth_tries": {"MaxAuthTries": "4"},
}


def _iter_sshd_lines(path: str = SSHD_MAIN, depth: int = 0) -> List[str]:
    """按 sshd 的处理顺序展开主配置：遇到 ``Include`` 就地展开。

    sshd 对多数选项取**第一次**出现的值，所以顺序很重要（主配置里的值会盖过
    后面 Include 进来的同名值，反之亦然）——这里保持原始顺序，由调用方取首个。
    """
    if depth > 5:
        return []
    text = _read_text(path)
    if text is None:
        return []
    lines: List[str] = []
    base = os.path.dirname(path)
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.lower().startswith("include "):
            pattern = stripped.split(None, 1)[1].strip()
            if not os.path.isabs(pattern):
                pattern = os.path.join(base, pattern)
            for candidate in sorted(glob.glob(pattern)):
                lines.extend(_iter_sshd_lines(candidate, depth + 1))
            continue
        lines.append(raw)
    return lines


def _parse_sshd_lines(lines: List[str]) -> Dict[str, str]:
    settings: Dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"[\s=]+", line, maxsplit=1)
        if len(parts) != 2:
            continue
        key = parts[0].lower()
        # 首个值生效
        if key not in settings:
            settings[key] = parts[1].strip()
    return settings


def parse_sshd_effective(output: str) -> Dict[str, str]:
    """解析 ``sshd -T`` 的输出（``key value`` 全小写，值可能带空格）。

    与 :func:`_parse_sshd_lines` 分开只是因为来源不同：配置文件里可以有 ``=``
    和 ``Include``，而 ``-T`` 的输出是已经展开好的平面键值对。
    """
    settings: Dict[str, str] = {}
    for line in (output or "").splitlines():
        key, _, value = line.strip().partition(" ")
        if not key or not _:
            continue
        settings[key.strip().lower()] = value.strip()
    return settings


def sshd_settings() -> Tuple[Dict[str, str], str]:
    """读取本机 sshd 的**生效**配置，返回 (设置, 来源说明)。

    优先 ``sshd -T``（把 Include、默认值全部展开，是唯一权威的答案）；没有权限
    或没有 sshd 可执行文件时退回解析配置文件（此时默认值看不到，只能看显式配置）。
    """
    binary = _which("sshd") or ("/usr/sbin/sshd" if os.path.exists("/usr/sbin/sshd") else "")
    if binary and _elevated():
        ok, output = _run([binary, "-T"], timeout=10)
        if ok and output.strip():
            settings = parse_sshd_effective(output)
            if settings:
                return settings, "sshd -T（生效配置）"
    return _parse_sshd_lines(_iter_sshd_lines()), "配置文件（需 root 权限才能读到展开后的默认值）"


def _first_setting(settings: Dict[str, str], *names: str) -> str:
    for name in names:
        if name in settings:
            return settings[name]
    return ""


def _check_ssh(ssh: Dict[str, Any]) -> List[Dict[str, Any]]:
    """SSH 检查。``ssh`` 是快照里的 ``ssh`` 段（本机与远程同构）。"""
    effective = ssh.get("effective") or {}
    files = ssh.get("files") or {}
    # sshd -T 是权威答案；拿不到时退回配置文件（此时看不到展开后的默认值）
    settings: Dict[str, str] = effective or files
    source = tr(
        str(ssh.get("source") or ("sshd -T（生效配置）" if effective else "配置文件"))
    )
    checks: List[Dict[str, Any]] = []

    root_login = _first_setting(settings, "permitrootlogin").lower()
    if not root_login:
        # OpenSSH 的旧默认是 prohibit-password，新版本（9.x）仍是它；配置文件里
        # 没写时按「允许密钥 root 登录、禁止口令」这一较安全的默认来判断。
        status, detail = "warn", "未显式配置 PermitRootLogin（将按 SSH 默认值处理）"
        value = "未配置"
    elif root_login in ("no", "prohibit-password", "without-password", "forced-commands-only"):
        status = "pass"
        value = root_login
        detail = "已禁止 root 用口令直接登录" if root_login != "no" else "已完全禁止 root 登录"
    else:  # yes
        status, value = "fail", root_login
        detail = "允许 root 直接登录（可被暴力破解 / 撞库）"
    checks.append(
        _check(
            "ssh_root_login",
            "ssh",
            "SSH 禁止 root 直接登录",
            status,
            "high",
            value,
            "no 或 prohibit-password",
            detail,
            tr(
                "Root 是攻击者唯一确定的用户名。改为 prohibit-password 既保留密钥登录，"
                "又堵死口令爆破。数据来源："
            )
            + source,
            fixable=True,
        )
    )

    password_auth = _first_setting(settings, "passwordauthentication").lower()
    if password_auth == "no":
        checks.append(
            _check(
                "ssh_password_auth",
                "ssh",
                "SSH 关闭口令认证",
                "pass",
                "medium",
                "no",
                "no",
                "只允许密钥登录，暴力破解无从下手",
            )
        )
    elif password_auth in ("yes", ""):
        checks.append(
            _check(
                "ssh_password_auth",
                "ssh",
                "SSH 关闭口令认证",
                "warn",
                "medium",
                password_auth or "未配置（默认 yes）",
                "no",
                "仍允许口令登录，是暴力破解的主要入口"
                + ("（如依赖密钥登录请忽略本项）" if not password_auth else ""),
                "确认所有能登录的账号都已配置密钥后，把 PasswordAuthentication 设为 no。"
                "改之前务必备份好密钥，否则会把自己关在门外。",
                fixable=True,
                auto=False,  # 改动可能把人锁在门外：只允许单独点名修复
            )
        )
    else:
        checks.append(
            _check(
                "ssh_password_auth",
                "ssh",
                "SSH 关闭口令认证",
                "warn",
                "medium",
                password_auth,
                "no",
                pick(f"当前值 {password_auth}", f"Current value {password_auth}"),
                "确认无误后设为 no。",
                fixable=True,
                auto=False,
            )
        )

    empty_pw = _first_setting(settings, "permitemptypasswords").lower()
    if empty_pw == "no":
        checks.append(
            _check(
                "ssh_empty_passwords",
                "ssh",
                "SSH 禁止空口令登录",
                "pass",
                "medium",
                "no",
                "no",
                "已拒绝空口令账号登录",
            )
        )
    elif empty_pw == "yes":
        checks.append(
            _check(
                "ssh_empty_passwords",
                "ssh",
                "SSH 禁止空口令登录",
                "fail",
                "medium",
                "yes",
                "no",
                "允许空口令登录，等于给没有口令的账号开了后门",
                "设为 no。",
                fixable=True,
            )
        )
    else:
        checks.append(
            _check(
                "ssh_empty_passwords",
                "ssh",
                "SSH 禁止空口令登录",
                "pass",
                "medium",
                empty_pw or "未配置（默认 no）",
                "no",
                "SSH 默认即为 no",
            )
        )

    max_tries = _first_setting(settings, "maxauthtries").strip()
    try:
        tries = int(max_tries)
    except (TypeError, ValueError):
        tries = 6  # OpenSSH 默认值
    if tries <= 4:
        checks.append(
            _check(
                "ssh_max_auth_tries",
                "ssh",
                "SSH 限制认证重试次数",
                "pass",
                "low",
                str(tries),
                "≤ 4",
                "单次连接最多尝试次数受限",
            )
        )
    else:
        checks.append(
            _check(
                "ssh_max_auth_tries",
                "ssh",
                "SSH 限制认证重试次数",
                "warn",
                "low",
                max_tries or str(tries),
                "≤ 4",
                pick(
                    f"允许 {tries} 次认证尝试，给爆破留的空间偏大",
                    f"Allows {tries} authentication attempts, leaving too much room for brute force",
                ),
                "设为 MaxAuthTries 4。",
                fixable=True,
            )
        )

    # 关闭 SSH 的 X11 转发（非必需时减少攻击面），仅提示不扣太多分
    x11 = _first_setting(settings, "x11forwarding").lower()
    if x11 == "no":
        checks.append(
            _check(
                "ssh_x11_forwarding",
                "ssh",
                "SSH 关闭 X11 转发",
                "pass",
                "low",
                "no",
                "no",
                "已关闭非必需的 X11 转发",
            )
        )
    else:
        checks.append(
            _check(
                "ssh_x11_forwarding",
                "ssh",
                "SSH 关闭 X11 转发",
                "warn",
                "low",
                x11 or "未配置（默认 yes）",
                "no",
                "X11 转发存在已知风险，服务器通常不需要",
                "如在 /etc/ssh/sshd_config 里把 X11Forwarding 设为 no 可减少攻击面。",
            )
        )
    return checks


# ---------------------------------------------------------------- 密码策略

def parse_login_defs(text: Optional[str]) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) == 2:
            values[parts[0].upper()] = parts[1].strip()
    return values


def _pam_text() -> str:
    chunks: List[str] = []
    for path in PAM_FILES:
        text = _read_text(path)
        if text:
            chunks.append(text)
    return "\n".join(chunks)


def _check_password(
    login_defs: Optional[str], pam_text: str = ""
) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    values = parse_login_defs(login_defs)
    readable = login_defs is not None

    def from_defs(key: str, default: str) -> str:
        return values.get(key, default)

    max_days_raw = from_defs("PASS_MAX_DAYS", "99999")
    try:
        max_days = int(max_days_raw)
    except ValueError:
        max_days = 99999
    if max_days != 99999 and 1 <= max_days <= 90:
        status = "pass"
        detail = pick(
            f"口令最长有效期 {max_days} 天",
            f"Maximum password age {max_days} days",
        )
    elif max_days != 99999 and max_days <= 365:
        status = "warn"
        detail = pick(
            f"口令最长有效期 {max_days} 天，建议不超过 90 天",
            f"Maximum password age {max_days} days; 90 days or fewer is recommended",
        )
    else:
        status, detail = "fail", "口令几乎不会过期（PASS_MAX_DAYS 未设置或过大）"
    checks.append(
        _check(
            "pwd_max_days",
            "password",
            "口令有效期上限",
            status if readable else "unknown",
            "medium",
            max_days_raw if readable else "无法读取 /etc/login.defs",
            "≤ 90 天",
            detail if readable else "读不到 /etc/login.defs（需要 root 权限）",
            "在 /etc/login.defs 里设置 PASS_MAX_DAYS 90（只对新建用户生效，"
            "已有账号需用 chage -M 90 <用户> 逐个调整）。",
            fixable=readable,
        )
    )

    min_len_raw = from_defs("PASS_MIN_LEN", "5")
    try:
        min_len = int(min_len_raw)
    except ValueError:
        min_len = 5
    checks.append(
        _check(
            "pwd_min_len",
            "password",
            "口令最小长度",
            ("pass" if min_len >= 8 else "warn") if readable else "unknown",
            "medium",
            min_len_raw if readable else "无法读取 /etc/login.defs",
            "≥ 8 位",
            (
                pick(
                    f"最小长度 {min_len} 位",
                    f"Minimum length {min_len} characters",
                )
                if readable
                else "读不到 /etc/login.defs（需要 root 权限）"
            ),
            "在 /etc/login.defs 里设置 PASS_MIN_LEN 8（PAM 强度模块启用时以它为准）。",
            fixable=readable,
        )
    )

    pam = pam_text
    quality = bool(re.search(r"pam_(pw)?quality\.so|pam_cracklib\.so", pam))
    checks.append(
        _check(
            "pwd_quality",
            "password",
            "启用口令复杂度校验（PAM）",
            "pass" if quality else "warn",
            "low",
            "已启用" if quality else "未检测到 pam_pwquality / pam_cracklib",
            "启用 pam_pwquality",
            "口令复杂度模块会拒绝「字典词 + 纯数字」这类口令"
            if quality
            else "PAM 里没有口令复杂度模块，弱口令可以随便设",
            "" if quality else
            "Debian/Ubuntu：apt install libpam-pwquality 后在 /etc/pam.d/common-password "
            "加上 pam_pwquality.so；RHEL：在 /etc/pam.d/password-auth 与 system-auth 里"
            "确认 pam_pwquality.so 已启用。",
        )
    )

    lockout = bool(
        re.search(r"pam_faillock\.so|pam_tally2?\.so", pam)
    ) or _read_text("/etc/security/faillock.conf") not in (None, "")
    checks.append(
        _check(
            "login_lockout",
            "password",
            "启用登录失败锁定（PAM）",
            "pass" if lockout else "warn",
            "medium",
            "已启用" if lockout else "未检测到 pam_faillock / pam_tally2",
            "启用 pam_faillock",
            "连续失败会被临时锁定，显著拖慢暴力破解"
            if lockout
            else "没有失败锁定，攻击者可以一直试口令",
            "" if lockout else
            "RHEL 系：authselect enable-feature with-faillock（或手工在 "
            "/etc/pam.d/system-auth 加 pam_faillock.so）；Debian/Ubuntu：设置 "
            "/etc/security/faillock.conf 的 deny 并在 common-auth 引入 pam_faillock.so。",
        )
    )
    return checks


# ---------------------------------------------------------------- 防火墙

def firewall_status() -> Dict[str, Any]:
    """探测本机是否有活动的防火墙，返回 ``{active, manager, detail, detected}``。

    按「明确的托管服务 → 命令实测」的顺序判断；pve-firewall 也算数，因为面板
    多半就装在 Proxmox 宿主上，那台机器上的防火墙由 PVE 自己管。
    """
    detected: List[str] = []

    # 1) systemd 托管的常见防火墙服务
    for unit, label in (
        ("firewalld", "firewalld"),
        ("ufw", "ufw"),
        ("nftables", "nftables"),
        ("pve-firewall", "pve-firewall"),
    ):
        if _systemd_active(unit):
            return {
                "active": True,
                "manager": label,
                "detail": pick(
                    f"{label} 服务处于 active 状态",
                    f"The {label} service is active",
                ),
                "detected": detected + [label],
            }
        detected.append(label)

    # 2) 命令实测
    ufw = _which("ufw")
    if ufw:
        ok, output = _run([ufw, "status"], timeout=8)
        if ok and "status: active" in output.lower():
            return {
                "active": True,
                "manager": "ufw",
                "detail": output.strip().splitlines()[0],
                "detected": detected,
            }

    fwcmd = _which("firewall-cmd")
    if fwcmd:
        ok, output = _run([fwcmd, "--state"], timeout=8)
        if ok and "running" in output.lower():
            return {
                "active": True,
                "manager": "firewalld",
                "detail": "firewall-cmd --state = running",
                "detected": detected,
            }

    nft = _which("nft")
    if nft and _elevated():
        ok, output = _run([nft, "list", "ruleset"], timeout=8)
        if ok and output.strip():
            return {
                "active": True,
                "manager": "nftables",
                "detail": "nft list ruleset 中有规则",
                "detected": detected,
            }

    iptables = _which("iptables")
    if iptables and _elevated():
        ok, output = _run([iptables, "-S"], timeout=8)
        if ok and output.strip():
            # 有自定义链或默认策略非 ACCEPT 才算「有防火墙」
            has_rules = any(
                line.strip().startswith("-A")
                or ("-P INPUT" in line and "DROP" in line)
                or ("-P INPUT" in line and "REJECT" in line)
                for line in output.splitlines()
            )
            if has_rules:
                return {
                    "active": True,
                    "manager": "iptables",
                    "detail": "iptables 中存在规则或默认拒绝策略",
                    "detected": detected,
                }
            return {
                "active": False,
                "manager": "iptables",
                "detail": "iptables 只有默认 ACCEPT 策略，未配置规则",
                "detected": detected,
            }

    return {
        "active": False,
        "manager": "",
        "detail": "未检测到活动的防火墙（ufw / firewalld / nftables / iptables / pve-firewall）",
        "detected": detected,
    }


def _check_firewall(
    status: Optional[Dict[str, Any]] = None, elevated: bool = True
) -> Dict[str, Any]:
    """防火墙检查。``status`` 为快照里的探测结果，缺省时现场探测本机。"""
    if status is None:
        status = firewall_status()
    if status["active"]:
        return _check(
            "firewall_active",
            "firewall",
            "主机防火墙已启用",
            "pass",
            "high",
            status["manager"],
            "存在活动的防火墙",
            status["detail"],
        )
    return _check(
        "firewall_active",
        "firewall",
        "主机防火墙已启用",
        "unknown" if not elevated else "fail",
        "high",
        "未检测到",
        "存在活动的防火墙",
        tr(status["detail"])
        + (
            ""
            if elevated
            else tr("（权限不足，无法完整探测，结果仅供参考）")
        ),
        "这台主机没有活动的防火墙，暴露的端口可被直接访问。Proxmox 宿主可用内置的"
        "pve-firewall（在面板的「防火墙」页里配置），普通主机可启用 ufw / firewalld"
        " 并只放行必要端口。注意：启用前务必先放行 SSH 端口，否则会把自己关在门外。",
    )


# ---------------------------------------------------------------- 时间同步

def time_sync_status() -> Dict[str, Any]:
    timedatectl = _which("timedatectl")
    if timedatectl:
        ok, output = _run(
            [timedatectl, "show", "-p", "NTPSynchronized", "--value"], timeout=8
        )
        if ok and output.strip():
            synced = output.strip().lower() in ("yes", "1", "true")
            return {
                "synced": synced,
                "service": "systemd-timedated",
                "detail": f"timedatectl NTPSynchronized={output.strip()}",
            }
    for unit, label in (
        ("chronyd", "chrony"),
        ("chrony", "chrony"),
        ("systemd-timesyncd", "systemd-timesyncd"),
        ("ntp", "ntp"),
        ("ntpd", "ntpd"),
    ):
        if _systemd_active(unit):
            return {
                "synced": True,
                "service": label,
                "detail": pick(
                    f"{label} 服务处于 active 状态",
                    f"The {label} service is active",
                ),
            }
    return {"synced": False, "service": "", "detail": "没有找到正在运行的时间同步服务"}


def _check_ntp(status: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """时间同步检查。``status`` 为快照里的探测结果，缺省时现场探测本机。"""
    if status is None:
        status = time_sync_status()
    return _check(
        "time_sync",
        "ntp",
        "系统时间同步正常",
        "pass" if status["synced"] else "warn",
        "medium",
        status["service"] or "未启用",
        "chrony / timesyncd / ntp 处于活动状态",
        status["detail"],
        "" if status["synced"] else
        "时间不同步会让日志时间错乱、TLS 校验失败、集群节点间凭据失效。"
        "执行 timedatectl set-ntp true 即可。",
        fixable=not status["synced"],
    )


# ---------------------------------------------------------------- 账号安全

def parse_passwd(text: Optional[str]) -> Dict[str, Dict[str, str]]:
    users: Dict[str, Dict[str, str]] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split(":")
        if len(fields) < 7:
            continue
        users[fields[0]] = {
            "uid": fields[2],
            "gid": fields[3],
            "shell": fields[6],
        }
    return users


def empty_password_users(
    shadow_text: Optional[str], passwd_text: Optional[str]
) -> List[str]:
    """空口令**且能登录**的账号（空口令 + 非 nologin shell）。

    空口令的系统账号（``sync`` 之类）本来就用 nologin 锁着，把它们算进「弱口令
    用户」只会制造噪音。
    """
    if shadow_text is None:
        return []
    pw_passwd = parse_passwd(passwd_text)
    weak: List[str] = []
    for raw in shadow_text.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("#"):
            continue
        fields = line.split(":")
        if len(fields) < 2:
            continue
        user, password = fields[0], fields[1]
        if password != "":
            continue  # 有口令哈希（含 * / ! 锁定）都不算空口令
        shell = pw_passwd.get(user, {}).get("shell", "")
        if shell in NOLOGIN_SHELLS:
            continue
        weak.append(user)
    return weak


def uid0_users(passwd_text: Optional[str]) -> List[str]:
    """除 root 外的 UID 0 账号（提权后门最常见的形态）。"""
    users = parse_passwd(passwd_text)
    return sorted(name for name, info in users.items() if info["uid"] == "0" and name != "root")


def _check_accounts(
    shadow: Optional[str] = None,
    passwd: Optional[str] = None,
    elevated: bool = True,
) -> List[Dict[str, Any]]:
    """账号安全检查。三个参数缺省时读本机；远程由快照传入。"""
    if shadow is None and passwd is None:
        shadow = _read_text(SHADOW_FILE)
        passwd = _read_text(PASSWD_FILE)
    checks: List[Dict[str, Any]] = []

    if shadow is None:
        checks.append(
            _check(
                "accounts_empty_password",
                "accounts",
                "无空口令账号",
                "unknown",
                "high",
                "无法读取 /etc/shadow",
                "没有可登录的空口令账号",
                "读不到 /etc/shadow（需要 root 权限），无法判断是否存在空口令账号",
            )
        )
    else:
        weak = empty_password_users(shadow, passwd)
        if weak:
            checks.append(
                _check(
                    "accounts_empty_password",
                    "accounts",
                    "无空口令账号",
                    "fail",
                    "high",
                    "、".join(weak),
                    "没有可登录的空口令账号",
                    pick(
                        f"发现 {len(weak)} 个可登录且没有口令的账号：{'、'.join(weak)}",
                        f"{len(weak)} login-capable account(s) without a password: "
                        f"{', '.join(weak)}",
                    ),
                    "这些账号无需口令即可登录，应立即锁定（passwd -l <用户>）或设置强口令。",
                    fixable=elevated,
                )
            )
        else:
            checks.append(
                _check(
                    "accounts_empty_password",
                    "accounts",
                    "无空口令账号",
                    "pass",
                    "high",
                    "无",
                    "没有可登录的空口令账号",
                    "未发现空口令且可登录的账号",
                )
            )

    if passwd is None:
        checks.append(
            _check(
                "accounts_uid0",
                "accounts",
                "无额外 UID 0 账号",
                "unknown",
                "high",
                "无法读取 /etc/passwd",
                "除 root 外没有 UID 0 账号",
                "读不到 /etc/passwd",
            )
        )
    else:
        extra = uid0_users(passwd)
        if extra:
            checks.append(
                _check(
                    "accounts_uid0",
                    "accounts",
                    "无额外 UID 0 账号",
                    "fail",
                    "high",
                    "、".join(extra),
                    "除 root 外没有 UID 0 账号",
                    pick(
                        f"发现 {len(extra)} 个 UID 为 0 的账号：{'、'.join(extra)}（等同于 root）",
                        f"{len(extra)} account(s) with UID 0: {', '.join(extra)} "
                        "(equivalent to root)",
                    ),
                    "若非刻意设置，删除或改掉这些账号的 UID；这类账号常被用作持久化后门。",
                )
            )
        else:
            checks.append(
                _check(
                    "accounts_uid0",
                    "accounts",
                    "无额外 UID 0 账号",
                    "pass",
                    "high",
                    "无",
                    "除 root 外没有 UID 0 账号",
                    "只有 root 拥有 UID 0",
                )
            )
    return checks


# ---------------------------------------------------------------- 内核参数

# (sysctl 名, 期望值比较函数, 人类可读期望, 严重级别, 说明)
def _int_equals(value: str, expected: int) -> bool:
    try:
        return int(value) == expected
    except (TypeError, ValueError):
        return False


def _int_gte(value: str, expected: int) -> bool:
    try:
        return int(value) >= expected
    except (TypeError, ValueError):
        return False


SYSCTL_CHECKS: Tuple[Dict[str, Any], ...] = (
    {
        "key": "sysctl_randomize_va_space",
        "name": "kernel.randomize_va_space",
        "expected": "2",
        "severity": "low",
        "label": "内核 ASLR 已开启",
        "detail": "地址空间随机化（ASLR）加大内存攻击的难度",
        "test": lambda v: _int_equals(v, 2),
        "fix_value": "2",
    },
    {
        "key": "sysctl_tcp_syncookies",
        "name": "net.ipv4.tcp_syncookies",
        "expected": "1",
        "severity": "medium",
        "label": "启用 SYN cookies",
        "detail": "SYN cookies 用于抵御 SYN Flood 拒绝服务攻击",
        "test": lambda v: _int_equals(v, 1),
        "fix_value": "1",
    },
    {
        "key": "sysctl_rp_filter",
        "name": "net.ipv4.conf.all.rp_filter",
        "expected": "1",
        "severity": "medium",
        "label": "启用反向路径过滤",
        "detail": "rp_filter 丢弃源地址不可能从该网卡到达的包，防 IP 欺骗",
        "test": lambda v: _int_equals(v, 1),
        "fix_value": "1",
    },
    {
        "key": "sysctl_accept_redirects",
        "name": "net.ipv4.conf.all.accept_redirects",
        "expected": "0",
        "severity": "medium",
        "label": "忽略 ICMP 重定向",
        "detail": "接受 ICMP 重定向可能被用来篡改路由表",
        "test": lambda v: _int_equals(v, 0),
        "fix_value": "0",
    },
    {
        "key": "sysctl_accept_source_route",
        "name": "net.ipv4.conf.all.accept_source_route",
        "expected": "0",
        "severity": "medium",
        "label": "拒绝源路由包",
        "detail": "源路由允许发送方指定路径，常被用于绕过网络控制",
        "test": lambda v: _int_equals(v, 0),
        "fix_value": "0",
    },
    {
        "key": "sysctl_dmesg_restrict",
        "name": "kernel.dmesg_restrict",
        "expected": "1",
        "severity": "low",
        "label": "限制 dmesg 访问",
        "detail": "非特权用户不应能读取内核日志（可能泄露地址与设备信息）",
        "test": lambda v: _int_equals(v, 1),
        "fix_value": "1",
    },
    {
        "key": "sysctl_kptr_restrict",
        "name": "kernel.kptr_restrict",
        "expected": "≥ 1",
        "severity": "low",
        "label": "隐藏内核指针",
        "detail": "隐藏 /proc 中的内核符号地址，抬高本地提权的门槛",
        "test": lambda v: _int_gte(v, 1),
        "fix_value": "2",
    },
)


def read_sysctl(name: str) -> Optional[str]:
    path = os.path.join("/proc/sys", name.replace(".", "/"))
    text = _read_text(path)
    return text.strip() if text is not None else None


def sysctl_paths() -> List[str]:
    """本套检查要读的 /proc/sys 路径（远程探测命令与解析共用，保证顺序一致）。"""
    return [os.path.join("/proc/sys", spec["name"].replace(".", "/")) for spec in SYSCTL_CHECKS]


def _check_kernel(
    values: Optional[Dict[str, Optional[str]]] = None,
) -> List[Dict[str, Any]]:
    """内核参数检查。``values`` 为 sysctl 名 → 值；缺省时读本机 /proc。"""
    checks: List[Dict[str, Any]] = []
    for spec in SYSCTL_CHECKS:
        value = (
            read_sysctl(spec["name"]) if values is None else values.get(spec["name"])
        )
        if value is None:
            checks.append(
                _check(
                    spec["key"],
                    "kernel",
                    spec["label"],
                    "unknown",
                    spec["severity"],
                    "无法读取",
                    spec["expected"],
                    pick(
                        f"读不到 /proc/sys/{spec['name'].replace('.', '/')}",
                        f"Cannot read /proc/sys/{spec['name'].replace('.', '/')}",
                    ),
                )
            )
            continue
        ok = spec["test"](value)
        checks.append(
            _check(
                spec["key"],
                "kernel",
                spec["label"],
                "pass" if ok else "warn",
                spec["severity"],
                value,
                spec["expected"],
                spec["detail"],
                "" if ok else
                pick(
                    f"执行 sysctl -w {spec['name']}={spec['fix_value']} 可立即生效，"
                    f"写入 /etc/sysctl.d/ 可持久化。",
                    f"Run sysctl -w {spec['name']}={spec['fix_value']} to apply it "
                    "immediately; write it under /etc/sysctl.d/ to make it persistent.",
                ),
                fixable=not ok,
            )
        )
    return checks


# ---------------------------------------------------------------- 报告与评分

CHECK_ORDER = [spec["key"] for spec in SYSCTL_CHECKS]


def _score(checks: List[Dict[str, Any]]) -> Tuple[int, str, str]:
    total = 0.0
    earned = 0.0
    for item in checks:
        if item["status"] == "unknown":
            continue
        weight = WEIGHTS.get(item["severity"], 1)
        total += weight
        if item["status"] == "pass":
            earned += weight
        elif item["status"] == "warn":
            earned += weight * 0.5
    if total <= 0:
        return 100, "A", "优秀"
    value = int(round(100 * earned / total))
    if value >= 90:
        return value, "A", "优秀"
    if value >= 75:
        return value, "B", "良好"
    if value >= 60:
        return value, "C", "一般"
    return value, "D", "较差"


# ------------------------------------------------------------ 采集：本机快照

def local_snapshot() -> Dict[str, Any]:
    """本机的原始数据快照（只读）。

    结构与 :func:`remote_snapshot` 完全一致，所以两端能喂给同一个
    :func:`evaluate` —— 这是「远程结论与本机同构」的实现方式。
    """
    elevated = _elevated()
    settings, source = sshd_settings()
    # sshd -T 给出的才是生效配置；配置文件只代表显式写下的那部分
    effective = settings if source.startswith("sshd -T") else {}
    return {
        "elevated": elevated,
        "privilege": "root" if elevated else "none",
        "ssh": {
            "effective": effective or None,
            "files": None if effective else (settings or None),
            "source": source,
        },
        "login_defs": _read_text(LOGIN_DEFS),
        "pam": _pam_text(),
        "firewall": firewall_status(),
        "ntp": time_sync_status(),
        "shadow": _read_text(SHADOW_FILE),
        "passwd": _read_text(PASSWD_FILE),
        "sysctl": {spec["name"]: read_sysctl(spec["name"]) for spec in SYSCTL_CHECKS},
        "hostname": short_hostname(),
        "kernel": platform.release(),
        "os_release": _read_text("/etc/os-release"),
    }


# ------------------------------------------------------------ 判定（纯函数）

def os_info(snapshot: Dict[str, Any]) -> Dict[str, str]:
    """从快照里抽出展示用的系统信息（本机/远程同一套）。"""
    data: Dict[str, str] = {}
    for line in (snapshot.get("os_release") or "").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            data[key.strip()] = value.strip().strip('"')
    return {
        "system": "Linux",
        "distribution": data.get("PRETTY_NAME") or data.get("NAME") or "",
        "kernel": str(snapshot.get("kernel") or ""),
        "hostname": str(snapshot.get("hostname") or ""),
    }


def evaluate(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """快照 → 检查项 + 评分。纯函数，本机与远程共用，保证两端口径一致。"""
    elevated = bool(snapshot.get("elevated"))
    checks: List[Dict[str, Any]] = []
    checks.extend(_check_ssh(snapshot.get("ssh") or {}))
    checks.extend(
        _check_password(snapshot.get("login_defs"), snapshot.get("pam") or "")
    )
    checks.append(_check_firewall(snapshot.get("firewall"), elevated))
    checks.append(_check_ntp(snapshot.get("ntp")))
    checks.extend(
        _check_accounts(snapshot.get("shadow"), snapshot.get("passwd"), elevated)
    )
    checks.extend(_check_kernel(snapshot.get("sysctl")))

    score, grade, grade_label = _score(checks)

    summary = {
        "total": len(checks),
        "pass": sum(1 for c in checks if c["status"] == "pass"),
        "warn": sum(1 for c in checks if c["status"] == "warn"),
        "fail": sum(1 for c in checks if c["status"] == "fail"),
        "unknown": sum(1 for c in checks if c["status"] == "unknown"),
        "fixable": sum(
            1 for c in checks if c["fixable"] and c["status"] in ("warn", "fail")
        ),
        # 其中可纳入「一键加固」的（排除需点名执行的项）
        "auto_fixable": sum(
            1
            for c in checks
            if c["fixable"] and c["auto"] and c["status"] in ("warn", "fail")
        ),
    }

    categories: List[Dict[str, Any]] = []
    for key in CATEGORY_ORDER:
        items = [c for c in checks if c["category"] == key]
        if not items:
            continue
        cat_score, _, _ = _score(items)
        categories.append(
            {
                "key": key,
                "label": tr(CATEGORY_LABELS.get(key, key)),
                "score": cat_score,
                "checks": items,
            }
        )

    return {
        "elevated": elevated,
        "privilege": str(
            snapshot.get("privilege") or ("root" if elevated else "none")
        ),
        "score": score,
        "grade": grade,
        "grade_label": tr(grade_label),
        "summary": summary,
        "categories": categories,
        "checks": checks,
    }


def _collect_sync() -> Dict[str, Any]:
    """本机体检（同步实现，交给后台线程跑）。"""
    snapshot = local_snapshot()
    hostname = short_hostname(snapshot.get("hostname")) or short_hostname() or "local"
    report = evaluate(snapshot)
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
            "os": os_info(snapshot),
        }
    )
    return report


async def collect() -> Dict[str, Any]:
    """体检本机并给出评分报告（只读，不改系统）。"""
    return await asyncio.to_thread(_collect_sync)


# ------------------------------------------------------- 采集：远程快照（SSH）

# 远程探测要跑十几条命令，给足时间（sshd -T 在慢机器上也要几秒）
PROBE_TIMEOUT = 45.0


def probe_command(sudo: str = "") -> str:
    """一条只读单行命令：把体检所需的原始数据分节打印回来。

    合并成一条命令，是因为 ``sshremote.run_command`` 每调一次都要新建一条 SSH
    连接；分节输出把 N 次往返压成 1 次。末尾补一个 ``printf`` 让整条命令的退出
    码为 0 —— 中间 ``systemctl is-active`` 之类的非零退出不该让调用方以为失败。
    """
    s = sudo
    paths = " ".join(sysctl_paths())
    steps = [
        _section("uid"), "id -u 2>/dev/null",
        _section("sshd-t"), f"{s}sshd -T 2>/dev/null",
        _section("sshd-f"), f"cat {SSHD_MAIN} {SSHD_DROPIN_DIR}/*.conf 2>/dev/null",
        _section("login-defs"), f"cat {LOGIN_DEFS} 2>/dev/null",
        _section("pam"), f"cat {' '.join(PAM_FILES)} 2>/dev/null",
        _section("shadow"), f"{s}cat {SHADOW_FILE} 2>/dev/null",
        _section("passwd"), f"cat {PASSWD_FILE} 2>/dev/null",
        _section("sysctl"),
        f"for p in {paths}; do printf '%s=' \"$p\"; cat \"$p\" 2>/dev/null; done",
        _section("fw-units"),
        "systemctl is-active firewalld ufw nftables pve-firewall 2>/dev/null",
        _section("fw-ufw"),
        f"command -v ufw >/dev/null 2>&1 && {s}ufw status 2>/dev/null",
        _section("fw-cmd"),
        "command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null",
        _section("fw-nft"),
        f"command -v nft >/dev/null 2>&1 && {s}nft list ruleset 2>/dev/null | head -20",
        _section("fw-ipt"),
        f"command -v iptables >/dev/null 2>&1 && {s}iptables -S 2>/dev/null | head -30",
        _section("ntp-td"), "timedatectl show -p NTPSynchronized --value 2>/dev/null",
        _section("ntp-units"),
        "systemctl is-active chronyd chrony systemd-timesyncd ntp ntpd 2>/dev/null",
        _section("hostname"), "hostname 2>/dev/null",
        _section("kernel"), "uname -r 2>/dev/null",
        _section("os-release"), "cat /etc/os-release 2>/dev/null",
        _section("end"),
    ]
    return "; ".join(steps)


def parse_probe_sections(output: str) -> Dict[str, str]:
    """把分节输出切成 ``{节名: 正文}``。"""
    sections: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in (output or "").splitlines():
        match = SECTION_RE.match(line.strip())
        if match:
            current = match.group(1)
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def _parse_sysctl_probe(text: str) -> Dict[str, Optional[str]]:
    """探测输出形如 ``/proc/sys/kernel/randomize_va_space=2``，按路径反查参数名。"""
    by_path = {path: spec["name"] for path, spec in zip(sysctl_paths(), SYSCTL_CHECKS)}
    values: Dict[str, Optional[str]] = {spec["name"]: None for spec in SYSCTL_CHECKS}
    for line in (text or "").splitlines():
        path, sep, value = line.partition("=")
        name = by_path.get(path.strip())
        if sep and name:
            values[name] = value.strip()
    return values


# 远程 fw-units 节里各行的顺序与这里一致
FW_UNITS = ("firewalld", "ufw", "nftables", "pve-firewall")
NTP_UNITS = (
    ("chronyd", "chrony"),
    ("chrony", "chrony"),
    ("systemd-timesyncd", "systemd-timesyncd"),
    ("ntp", "ntp"),
    ("ntpd", "ntpd"),
)


def parse_firewall_probe(
    sections: Dict[str, str], elevated: bool
) -> Dict[str, Any]:
    """从探测分节里判断防火墙状态（端口巡检也复用它，所以是公开的）。"""
    units = [u.strip() for u in (sections.get("fw-units") or "").splitlines()]
    for index, name in enumerate(FW_UNITS):
        if index < len(units) and units[index] == "active":
            return {
                "active": True,
                "manager": name,
                "detail": pick(
                    f"{name} 服务处于 active 状态",
                    f"The {name} service is active",
                ),
            }
    if "status: active" in (sections.get("fw-ufw") or "").lower():
        return {"active": True, "manager": "ufw", "detail": "ufw status = active"}
    if "running" in (sections.get("fw-cmd") or "").lower():
        return {
            "active": True,
            "manager": "firewalld",
            "detail": "firewall-cmd --state = running",
        }
    if elevated and (sections.get("fw-nft") or "").strip():
        return {
            "active": True,
            "manager": "nftables",
            "detail": "nft list ruleset 中有规则",
        }
    iptables = sections.get("fw-ipt") or ""
    if elevated and iptables.strip():
        has_rules = any(
            line.strip().startswith("-A")
            or ("-P INPUT" in line and ("DROP" in line or "REJECT" in line))
            for line in iptables.splitlines()
        )
        if has_rules:
            return {
                "active": True,
                "manager": "iptables",
                "detail": "iptables 中存在规则或默认拒绝策略",
            }
        return {
            "active": False,
            "manager": "iptables",
            "detail": "iptables 只有默认 ACCEPT 策略，未配置规则",
        }
    return {
        "active": False,
        "manager": "",
        "detail": "未检测到活动的防火墙（ufw / firewalld / nftables / iptables / pve-firewall）",
    }


def _parse_ntp_probe(sections: Dict[str, str]) -> Dict[str, Any]:
    value = (sections.get("ntp-td") or "").strip().lower()
    if value in ("yes", "1", "true"):
        return {
            "synced": True,
            "service": "systemd-timedated",
            "detail": "timedatectl NTPSynchronized=yes",
        }
    if value in ("no", "0", "false"):
        return {
            "synced": False,
            "service": "systemd-timedated",
            "detail": "timedatectl NTPSynchronized=no",
        }
    units = [u.strip() for u in (sections.get("ntp-units") or "").splitlines()]
    for index, (_unit, label) in enumerate(NTP_UNITS):
        if index < len(units) and units[index] == "active":
            return {
                "synced": True,
                "service": label,
                "detail": pick(
                    f"{label} 服务处于 active 状态",
                    f"The {label} service is active",
                ),
            }
    return {"synced": False, "service": "", "detail": "没有找到正在运行的时间同步服务"}


def remote_snapshot(row: Dict[str, Any], output: str) -> Dict[str, Any]:
    """远程分节输出 → 与本机同构的快照。"""
    sections = parse_probe_sections(output)
    uid = (sections.get("uid") or "").strip()
    shadow = sections.get("shadow") or None
    # /etc/shadow 读得到就说明 sudo（或 root）真的可用，比只看 use_sudo 靠谱
    sudo_works = bool(shadow)
    elevated = uid == "0" or sudo_works
    privilege = "root" if uid == "0" else ("sudo" if sudo_works else "none")

    effective = parse_sshd_effective(sections.get("sshd-t") or "")
    files = _parse_sshd_lines((sections.get("sshd-f") or "").splitlines())
    return {
        "elevated": elevated,
        "privilege": privilege,
        "ssh": {
            "effective": effective or None,
            "files": files or None,
            "source": (
                "sshd -T（生效配置）"
                if effective
                else "配置文件（/etc/ssh/sshd_config 及其 include，未展开默认值）"
            ),
        },
        "login_defs": sections.get("login-defs") or None,
        "pam": sections.get("pam") or "",
        "firewall": parse_firewall_probe(sections, elevated),
        "ntp": _parse_ntp_probe(sections),
        "shadow": shadow,
        "passwd": sections.get("passwd") or None,
        "sysctl": _parse_sysctl_probe(sections.get("sysctl") or ""),
        "hostname": (sections.get("hostname") or "").strip(),
        "kernel": (sections.get("kernel") or "").strip(),
        "os_release": sections.get("os-release") or "",
    }


def _empty_summary() -> Dict[str, int]:
    return {
        "total": 0,
        "pass": 0,
        "warn": 0,
        "fail": 0,
        "unknown": 0,
        "fixable": 0,
        "auto_fixable": 0,
    }


def _remote_error_report(row: Dict[str, Any], error: str) -> Dict[str, Any]:
    """单机体检失败时的占位报告：整页仍然可用，问题如实标在这台主机上。"""
    return {
        "host_id": str(row.get("id") or ""),
        "local": False,
        "name": str(row.get("name") or row.get("host") or ""),
        "host": str(row.get("host") or ""),
        "address": str(row.get("host") or ""),
        "checked_at": int(time.time()),
        "ok": False,
        "error": tr(error[:300]),
        "elevated": False,
        "privilege": "none",
        "score": 0,
        "grade": "",
        "grade_label": tr("未体检"),
        "summary": _empty_summary(),
        "categories": [],
        "checks": [],
        "os": {},
    }


async def collect_remote(row: Dict[str, Any]) -> Dict[str, Any]:
    """体检一台受管主机。任何失败都降级成 ok=False 的报告，绝不抛给调用方。"""
    remote = _sshremote()
    try:
        _ok, output = await remote.run_command(
            row, probe_command(remote._sudo_prefix(row)), timeout=PROBE_TIMEOUT
        )
        if not parse_probe_sections(output):
            raise RuntimeError(output.strip()[:200] or "远程命令没有返回任何数据")
        snapshot = remote_snapshot(row, output)
    except Exception as exc:  # noqa: BLE001 - 单机失败不能拖垮整页
        logger.warning("远程基线体检失败 %s：%s", row.get("host"), exc)
        return _remote_error_report(row, str(exc))

    report = evaluate(snapshot)
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
            "os": os_info(snapshot),
        }
    )
    return report


# ------------------------------------------------------------ 主机清单与总览

def local_host_row() -> Dict[str, Any]:
    hostname = short_hostname() or "localhost"
    return {
        "id": "local",
        "name": hostname,
        "host": hostname,
        "address": "localhost",
        "local": True,
        "enabled": True,
    }


async def managed_hosts() -> List[Dict[str, Any]]:
    """可体检的受管主机**完整记录**（仅启用的），读不到时退回空列表。

    ⚠️ 返回的是 ``ssh_hosts`` 的原始行，**含加密凭据**（``secret`` / ``auth_type``
    / ``use_sudo``）—— 采集流程必须拿到这些字段才连得上主机。因此：

    * 只允许内部采集流程（``collect_remote`` / ``fleet_reports``）使用；
    * **绝不能**直接回给前端，出接口前一律过一遍 :func:`host_card`。

    曾经这里是「顺手做了一层展示用映射」，只留了 id/name/host 等字段，结果采集
    拿到的记录没有凭据 —— paramiko 直接报 ``No authentication methods available``，
    远程主机永远巡检失败，界面表现为「怎么点都停在未巡检」。
    """
    try:
        rows = await _sshremote().list_hosts(include_disabled=False)
    except Exception:  # noqa: BLE001 - 主机清单读不到不该让整个体检失败
        logger.exception("读取受管主机列表失败")
        return []
    return [dict(row) for row in rows]


def host_card(row: Dict[str, Any]) -> Dict[str, Any]:
    """主机记录的**展示形态**：给前端挑主机用，凭据一个字段都不带。"""
    return {
        "id": str(row.get("id") or ""),
        "name": str(row.get("name") or row.get("host") or ""),
        "host": str(row.get("host") or ""),
        "address": str(row.get("host") or ""),
        "local": False,
        "enabled": bool(row.get("enabled", True)),
    }


async def targets(host_ids: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
    """体检目标清单（展示用）：本机在前，受管主机在后。

    ``host_ids=None`` = 不限（含本机）；给了集合则只列集合里的受管主机，
    且只有集合含 ``"local"`` 时才带上本机 —— 普通用户的集合里没有 ``local``，
    所以面板本机对他们不可见。
    """
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    rows = await managed_hosts()
    if wanted is not None:
        rows = [row for row in rows if str(row.get("id")) in wanted]
    cards = [host_card(row) for row in rows]
    include_local = wanted is None or "local" in wanted
    return ([local_host_row()] if include_local else []) + cards


async def collect_host(host_id: str) -> Dict[str, Any]:
    """体检单台主机（``local`` 或受管主机 id）。"""
    if host_id in ("", "local"):
        return await collect()
    row = await _sshremote().get_host(host_id)
    if not row:
        raise LookupError(
            pick(f"受管主机 {host_id} 不存在", f"Managed host {host_id} does not exist")
        )
    return await collect_remote(row)


_SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}


def compact_report(report: Dict[str, Any]) -> Dict[str, Any]:
    """总览用的一台主机摘要（不带全部检查项，响应体小很多）。"""
    issues = [
        c for c in (report.get("checks") or []) if c.get("status") in ("fail", "warn")
    ]
    # 高危优先，同级别里「不合格」排在「待改进」前面
    issues.sort(
        key=lambda c: (
            _SEVERITY_RANK.get(str(c.get("severity")), 3),
            c.get("status") != "fail",
        )
    )
    return {
        "host_id": report.get("host_id"),
        "name": report.get("name"),
        "host": report.get("host"),
        "local": bool(report.get("local")),
        "ok": bool(report.get("ok")),
        "error": report.get("error") or "",
        "elevated": bool(report.get("elevated")),
        "privilege": report.get("privilege") or "none",
        "score": report.get("score") or 0,
        "grade": report.get("grade") or "",
        "grade_label": report.get("grade_label") or tr("未体检"),
        "summary": report.get("summary") or _empty_summary(),
        "os": report.get("os") or {},
        "issues": [
            {
                "key": c["key"],
                "label": c["label"],
                "severity": c["severity"],
                "status": c["status"],
                "category": c["category"],
            }
            for c in issues[:4]
        ],
    }


async def fleet_reports(
    host_ids: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """并发体检全部目标主机（本机 + 受管主机），返回**完整**报告列表。"""
    from .pve import parallel

    # 必须用 `is not None` 而不是真值判断：空集合表示「一台都不可见」（刚授权、
    # 还没添加主机），用真值判断会把它当成 None = 不限，普通用户于是能看到
    # 全部主机与面板本机。targets() 用的就是下面这种写法。
    wanted = {str(item) for item in host_ids} if host_ids is not None else None
    rows = await managed_hosts()
    if wanted is not None:
        rows = [row for row in rows if row["id"] in wanted]
    include_local = wanted is None or "local" in wanted

    results = await parallel([collect_remote(row) for row in rows], limit=8) if rows else []

    reports: List[Dict[str, Any]] = []
    if include_local:
        reports.append(await collect())
    for row, item in zip(rows, results):
        if isinstance(item, BaseException):  # parallel 把异常原样返回
            reports.append(_remote_error_report(row, str(item)))
        else:
            reports.append(item)
    return reports


def _attention_rank(host: Dict[str, Any]) -> int:
    """排序权重：有不合格 → 不可达 → 只有待改进 → 全通过。"""
    if not host.get("ok"):
        return 1
    summary = host.get("summary") or {}
    if summary.get("fail"):
        return 0
    if summary.get("warn"):
        return 2
    return 3


async def fleet_overview(
    host_ids: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """全平台体检总览：每台主机一行摘要，最需要处理的排最前。"""
    hosts = [compact_report(report) for report in await fleet_reports(host_ids)]
    hosts.sort(key=lambda h: (_attention_rank(h), h.get("score") or 0))

    reachable = [h for h in hosts if h["ok"]]
    totals = {
        "hosts": len(hosts),
        "reachable": len(reachable),
        "unreachable": len(hosts) - len(reachable),
        "fail": sum((h["summary"] or {}).get("fail", 0) for h in reachable),
        "warn": sum((h["summary"] or {}).get("warn", 0) for h in reachable),
        "fixable": sum((h["summary"] or {}).get("auto_fixable", 0) for h in reachable),
        "avg_score": (
            int(round(sum(h["score"] for h in reachable) / len(reachable)))
            if reachable
            else 0
        ),
        "worst_score": min((h["score"] for h in reachable), default=0),
        "healthy": sum(1 for h in reachable if h["grade"] in ("A", "B")),
    }
    return {"hosts": hosts, "totals": totals, "generated_at": int(time.time())}


# --------------------------------------------------------------------- 加固

class FixError(RuntimeError):
    """加固失败（权限不足、校验不过已回滚等）。"""


def _require_root(action: str) -> None:
    if not _elevated():
        raise FixError(
            pick(
                f"{action}需要 root 权限：面板进程当前不是 root，"
                "请用 root 运行面板（或用 systemd 以 root 托管）后再试。",
                f"{tr(action)} requires root: the panel process is not running as root. "
                "Run the panel as root (or manage it with systemd as root) and try again.",
            )
        )


def _parse_kv_file(text: Optional[str], separator: Optional[str] = None) -> Dict[str, str]:
    """把 ``key = value`` 形式（sysctl）或 sshd 的 ``Key value`` 解析成字典。"""
    values: Dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if separator:
            key, sep, value = line.partition(separator)
            if not sep:
                continue
        else:
            parts = re.split(r"[\s=]+", line, maxsplit=1)
            if len(parts) != 2:
                continue
            key, value = parts
        values[key.strip().lower()] = value.strip()
    return values


# ---- SSH ----

def render_sshd_dropin(settings: Dict[str, str]) -> str:
    lines = [
        "# 由 ProxCenter 生成：在这里手改会被面板下一次加固覆盖。",
        "# 单独成文件是为了不碰发行版自带的 sshd_config。",
    ]
    for key in sorted(settings):
        lines.append(f"{SSH_KEY_CASE.get(key, key)} {settings[key]}")
    lines.append("")
    return "\n".join(lines)


def _sshd_binary() -> str:
    return _which("sshd") or ("/usr/sbin/sshd" if os.path.exists("/usr/sbin/sshd") else "")


# sshd 会对若干取值做别名归一（例如 PermitRootLogin 的 without-password 与
# prohibit-password 等价），校验前先抹平，免得把一次正确的改动误判成「未生效」。
_SSH_VALUE_ALIASES = {
    "without-password": "prohibit-password",
    "yes": "yes",
    "no": "no",
}


def _ssh_value_equal(actual: str, expected: str) -> bool:
    left = _SSH_VALUE_ALIASES.get(str(actual).strip().lower(), str(actual).strip().lower())
    right = _SSH_VALUE_ALIASES.get(
        str(expected).strip().lower(), str(expected).strip().lower()
    )
    return left == right


def _reload_ssh() -> str:
    systemctl = _which("systemctl")
    if systemctl:
        for unit in ("sshd", "ssh"):
            ok, output = _run([systemctl, "reload", unit], timeout=10)
            if ok:
                return f"systemctl reload {unit}"
    for name in ("ssh", "sshd"):
        if _which(name):
            ok, _ = _run([name, "reload"], timeout=10)  # pragma: no cover - 老系统
            if ok:
                return f"{name} reload"
    return ""


def apply_sshd_settings(updates: Dict[str, str]) -> Dict[str, Any]:
    """把若干 sshd 设置写入面板托管的 drop-in 并重载 SSH。

    安全措施：写前先存旧内容 → 写后 ``sshd -t`` 校验 → 校验不过或发现 drop-in
    根本没被主配置 Include（设置不生效）时**回滚**并报错。改 SSH 配置最怕的就是
    改完重启连不上去，所以宁可不改也不留下一个校验不过的文件。
    """
    _require_root("修改 SSH 配置")
    binary = _sshd_binary()
    if not binary:
        raise FixError(tr("没有找到 sshd 可执行文件，无法校验配置"))

    before = _read_text(SSHD_DROPIN)
    current = _parse_kv_file(before)
    merged = {**current, **{k.lower(): v for k, v in updates.items()}}
    content = render_sshd_dropin(merged)

    _write_text(SSHD_DROPIN, content, mode=0o600)

    ok, output = _run([binary, "-t"], timeout=10)
    if not ok:
        _restore(SSHD_DROPIN, before)
        raise FixError(tr("sshd 配置校验失败，已回滚：") + output.strip()[:300])

    # 确认 drop-in 真的被主配置 Include 了：没有的话设置不会生效，写了也是白写
    effective, _ = sshd_settings()
    not_applied = [
        key
        for key, value in updates.items()
        if not _ssh_value_equal(effective.get(key.lower(), ""), value)
    ]
    if not_applied:
        _restore(SSHD_DROPIN, before)
        raise FixError(
            tr(
                "写入成功但设置未生效：主配置可能没有 Include "
                f"{SSHD_DROPIN_DIR}/*.conf。请在 /etc/ssh/sshd_config 里加上 "
                "`Include /etc/ssh/sshd_config.d/*.conf` 后重试（已回滚本次改动）。"
            )
        )

    reload_detail = _reload_ssh() or tr("（未能自动重载，请手动 systemctl reload sshd）")
    return {
        "ok": True,
        "path": SSHD_DROPIN,
        "config": content,
        "detail": tr("已写入并生效，") + reload_detail,
    }


def _restore(path: str, before: Optional[str]) -> None:
    try:
        if before is None:
            if os.path.exists(path):
                os.remove(path)
        else:
            _write_text(path, before, mode=0o600)
    except OSError as exc:  # pragma: no cover - 回滚失败只能记日志
        logger.error("回滚 %s 失败：%s", path, exc)


def fix_ssh_root_login() -> Dict[str, Any]:
    return apply_sshd_settings(SSH_FIX_VALUES["ssh_root_login"])


def fix_ssh_password_auth() -> Dict[str, Any]:
    return apply_sshd_settings(SSH_FIX_VALUES["ssh_password_auth"])


def fix_ssh_empty_passwords() -> Dict[str, Any]:
    return apply_sshd_settings(SSH_FIX_VALUES["ssh_empty_passwords"])


def fix_ssh_max_auth_tries() -> Dict[str, Any]:
    return apply_sshd_settings(SSH_FIX_VALUES["ssh_max_auth_tries"])


# ---- login.defs ----

def merge_login_defs(text: str, updates: Dict[str, str]) -> str:
    """在 login.defs 文本里就地改键值（找不到就追加）。

    只动 ``KEY<TAB>value`` 这一行，保留文件里的注释与顺序 —— login.defs 是
    人读的配置，整文件重写会丢掉发行版的注释。
    """
    result = text
    for key, value in updates.items():
        pattern = re.compile(rf"(?m)^[ \t]*{re.escape(key)}[ \t]+.*$")
        replacement = f"{key}\t{value}"
        if pattern.search(result):
            result = pattern.sub(lambda _m, r=replacement: r, result, count=1)
        else:
            if result and not result.endswith("\n"):
                result += "\n"
            result += replacement + "\n"
    return result


def apply_login_defs(updates: Dict[str, str]) -> Dict[str, Any]:
    _require_root("修改口令策略")
    text = _read_text(LOGIN_DEFS)
    if text is None:
        raise FixError(pick(f"读不到 {LOGIN_DEFS}", f"Cannot read {LOGIN_DEFS}"))
    backup = LOGIN_DEFS + ".panel.bak"
    if not os.path.exists(backup):
        _write_text(backup, text)
    _write_text(LOGIN_DEFS, merge_login_defs(text, updates))
    return {
        "ok": True,
        "path": LOGIN_DEFS,
        "detail": pick(
            "已更新口令策略（原文件备份为 "
            + backup
            + "；PASS_MAX_DAYS / PASS_MIN_LEN 只对新建用户生效，"
            "已有账号可用 chage -M 90 <用户> 逐个调整）",
            "Password policy updated (the original file was backed up to "
            + backup
            + "; PASS_MAX_DAYS / PASS_MIN_LEN apply to new users only — adjust "
            "existing accounts one by one with chage -M 90 <user>)",
        ),
    }


def fix_pwd_max_days() -> Dict[str, Any]:
    return apply_login_defs({"PASS_MAX_DAYS": "90"})


def fix_pwd_min_len() -> Dict[str, Any]:
    return apply_login_defs({"PASS_MIN_LEN": "8"})


# ---- sysctl ----

SYSCTL_FIX_VALUES: Dict[str, Tuple[str, str]] = {
    spec["key"]: (spec["name"], spec["fix_value"]) for spec in SYSCTL_CHECKS
}


def render_sysctl_file(values: Dict[str, str]) -> str:
    lines = [
        "# 由 ProxCenter 生成：在这里手改会被面板下一次加固覆盖。",
    ]
    for name in sorted(values):
        lines.append(f"{name} = {values[name]}")
    lines.append("")
    return "\n".join(lines)


def apply_sysctl(updates: Dict[str, str]) -> Dict[str, Any]:
    """把 sysctl 值写入面板托管文件并立即生效。"""
    _require_root("修改内核参数")
    current = _parse_kv_file(_read_text(SYSCTL_FILE), separator="=")
    merged = {**current, **updates}
    content = render_sysctl_file(merged)
    _write_text(SYSCTL_FILE, content)

    sysctl = _which("sysctl")
    detail = ""
    if sysctl:
        ok, output = _run([sysctl, "--system"], timeout=15)
        if not ok:
            ok2, output2 = _run([sysctl, "-p", SYSCTL_FILE], timeout=15)
            if not ok2:
                raise FixError(
                    tr("写入成功但 sysctl 应用失败：")
                    + (output2.strip() or output.strip())[:300]
                )
        detail = tr("已应用")

    # 复验：确认每个键真的生效了
    failed: List[str] = []
    for name, value in updates.items():
        actual = read_sysctl(name)
        if actual is not None and actual.strip() != str(value).strip():
            failed.append(
                pick(
                    f"{name}={actual}（期望 {value}）",
                    f"{name}={actual} (expected {value})",
                )
            )
    if failed:
        raise FixError(
            tr("内核参数未按预期生效：") + pick("、", ", ").join(failed)
        )
    return {
        "ok": True,
        "path": SYSCTL_FILE,
        "config": content,
        "detail": detail or tr("已写入"),
    }


def _sysctl_fixer(key: str) -> Callable[[], Dict[str, Any]]:
    def run() -> Dict[str, Any]:
        name, value = SYSCTL_FIX_VALUES[key]
        return apply_sysctl({name: value})

    return run


# ---- 时间同步 ----

def fix_time_sync() -> Dict[str, Any]:
    _require_root("启用时间同步")
    timedatectl = _which("timedatectl")
    if timedatectl:
        ok, output = _run([timedatectl, "set-ntp", "true"], timeout=10)
        if ok:
            return {"ok": True, "detail": tr("已执行 timedatectl set-ntp true")}
        detail = output.strip()[:200]
    else:
        detail = tr("没有 timedatectl")
    # 退回到启用 systemd-timesyncd
    systemctl = _which("systemctl")
    if systemctl:
        ok, output = _run([systemctl, "enable", "--now", "systemd-timesyncd"], timeout=15)
        if ok:
            return {"ok": True, "detail": tr("已启用 systemd-timesyncd")}
        raise FixError(
            tr("启用时间同步失败：") + (output.strip() or detail)[:300]
        )
    raise FixError(tr("无法启用时间同步：") + detail)


# ---- 弱口令账号 ----

def fix_empty_password_accounts() -> Dict[str, Any]:
    _require_root("锁定空口令账号")
    shadow = _read_text(SHADOW_FILE)
    passwd = _read_text(PASSWD_FILE)
    users = empty_password_users(shadow, passwd)
    if not users:
        return {"ok": True, "detail": tr("没有需要处理的空口令账号")}
    passwd_bin = _which("passwd") or "/usr/bin/passwd"
    locked: List[str] = []
    for user in users:
        if not re.match(r"^[A-Za-z0-9._-]{1,32}$", user):
            continue
        ok, output = _run([passwd_bin, "-l", user], timeout=10)
        if not ok:
            raise FixError(
                pick(
                    f"锁定账号 {user} 失败：{output.strip()[:200]}",
                    f"Failed to lock the account {user}: {output.strip()[:200]}",
                )
            )
        locked.append(user)
    return {
        "ok": True,
        "detail": tr("已锁定账号：") + pick("、", ", ").join(locked),
    }


# ------------------------------------------------------------- 远程加固（SSH）
#
# 与本地加固同一套语义：先备份 → 写入 → 立刻校验 → 失败回滚。区别只是每一步都
# 通过 SSH 执行（sshremote.write_file 在 SFTP 权限不足时会自动退回 sudo tee）。


async def _remote_run(
    row: Dict[str, Any], command: str, timeout: float = 30.0
) -> Tuple[bool, str]:
    return await _sshremote().run_command(row, command, timeout=timeout)


async def _remote_read_file(
    row: Dict[str, Any], path: str, sudo: str
) -> Optional[str]:
    """读远程文件；不存在返回 ``None``（用标记区分「不存在」与「空文件」）。"""
    marker = "##panel:exists##"
    _ok, output = await _remote_run(
        row,
        f"if [ -e {path} ]; then printf '{marker}'; {sudo}cat {path} 2>/dev/null; fi",
    )
    if marker not in output:
        return None
    return output.split(marker, 1)[1]


async def _remote_write_file(
    row: Dict[str, Any], path: str, content: str, sudo: str
) -> None:
    """写远程文件：先建目录（SFTP 不会自动建父目录），再交给 sshremote。"""
    directory = os.path.dirname(path)
    if directory:
        await _remote_run(row, f"{sudo}mkdir -p {directory} 2>/dev/null")
    ok, error = await _sshremote().write_file(row, path, content)
    if not ok:
        raise FixError(
            pick(
                f"写入 {path} 失败：{error.strip()[:240]}",
                f"Failed to write {path}: {error.strip()[:240]}",
            )
        )


async def _remote_restore(
    row: Dict[str, Any], path: str, before: Optional[str], sudo: str
) -> None:
    try:
        if before is None:
            await _remote_run(row, f"{sudo}rm -f {path}")
        else:
            await _remote_write_file(row, path, before, sudo)
    except Exception:  # noqa: BLE001 - 回滚失败只能记日志
        logger.exception("远程回滚 %s 失败", path)


async def _remote_sshd_settings(row: Dict[str, Any], sudo: str) -> Dict[str, str]:
    ok, output = await _remote_run(row, f"{sudo}sshd -T 2>/dev/null")
    if ok and output.strip():
        return parse_sshd_effective(output)
    return {}


async def _remote_sshd_guard(row: Dict[str, Any], key: str) -> None:
    """防止「加固把自己关在门外」。

    面板正是用「口令」连这台主机时，一旦禁止口令认证 / 禁止 root 口令登录，面板
    立刻就失去对该主机的管理能力 —— 远端没有控制台可救，比本机更危险。
    """
    if str(row.get("auth_type") or "") != "password":
        return
    if key == "ssh_password_auth":
        raise FixError(
            "这台主机的凭据是「用户名 + 口令」：关闭 SSH 口令认证会让面板立刻失去"
            "对它的管理能力。请先配置 SSH 密钥（改为密钥认证）再来加固。"
        )
    if key == "ssh_root_login" and str(row.get("username") or "") == "root":
        raise FixError(
            "面板正用 root + 口令登录这台主机：禁止 root 直接登录会连同面板一起"
            "锁在门外。请先给一个普通用户配好 SSH 密钥再来加固。"
        )


async def _remote_apply_sshd(
    row: Dict[str, Any], updates: Dict[str, str], sudo: str
) -> Dict[str, Any]:
    before = await _remote_read_file(row, SSHD_DROPIN, sudo)
    merged = {**_parse_kv_file(before), **{k.lower(): v for k, v in updates.items()}}
    content = render_sshd_dropin(merged)
    await _remote_write_file(row, SSHD_DROPIN, content, sudo)

    _ok, binary_out = await _remote_run(
        row, "command -v sshd 2>/dev/null || ls /usr/sbin/sshd 2>/dev/null"
    )
    binary = (binary_out.strip().splitlines() or [""])[0].strip()
    if not binary:
        await _remote_restore(row, SSHD_DROPIN, before, sudo)
        raise FixError("远程主机上找不到 sshd 可执行文件，无法校验配置")

    ok, output = await _remote_run(row, f"{sudo}{binary} -t")
    if not ok:
        await _remote_restore(row, SSHD_DROPIN, before, sudo)
        raise FixError(tr("sshd 配置校验失败，已回滚：") + output.strip()[:300])

    effective = await _remote_sshd_settings(row, sudo)
    not_applied = [
        key
        for key, value in updates.items()
        if not _ssh_value_equal(effective.get(key.lower(), ""), value)
    ]
    if not_applied:
        await _remote_restore(row, SSHD_DROPIN, before, sudo)
        raise FixError(
            tr(
                f"写入成功但设置未生效：主配置可能没有 Include {SSHD_DROPIN_DIR}/*.conf。"
                "请在它的 /etc/ssh/sshd_config 里加上 "
                "`Include /etc/ssh/sshd_config.d/*.conf` 后重试（已回滚本次改动）。"
            )
        )

    reload_detail = ""
    for unit in ("sshd", "ssh"):
        reloaded, _ = await _remote_run(row, f"{sudo}systemctl reload {unit} 2>/dev/null")
        if reloaded:
            reload_detail = f"systemctl reload {unit}"
            break
    return {
        "ok": True,
        "path": SSHD_DROPIN,
        "config": content,
        "detail": tr("已写入并生效，")
        + (reload_detail or tr("（未能自动重载，请手动 reload sshd）")),
    }


async def _remote_apply_login_defs(
    row: Dict[str, Any], updates: Dict[str, str], sudo: str
) -> Dict[str, Any]:
    before = await _remote_read_file(row, LOGIN_DEFS, sudo)
    if before is None:
        raise FixError(
            pick(
                f"读不到远程主机上的 {LOGIN_DEFS}",
                f"Cannot read {LOGIN_DEFS} on the remote host",
            )
        )
    backup = LOGIN_DEFS + ".panel.bak"
    if await _remote_read_file(row, backup, sudo) is None:
        await _remote_write_file(row, backup, before, sudo)
    await _remote_write_file(row, LOGIN_DEFS, merge_login_defs(before, updates), sudo)
    return {
        "ok": True,
        "path": LOGIN_DEFS,
        "detail": pick(
            f"已更新远程主机口令策略（原文件备份为 {backup}；"
            "只对新建用户生效，已有账号可用 chage -M 90 <用户> 调整）",
            f"Remote password policy updated (the original file was backed up to {backup}; "
            "applies to new users only — adjust existing accounts with chage -M 90 <user>)",
        ),
    }


async def _remote_apply_sysctl(
    row: Dict[str, Any], updates: Dict[str, str], sudo: str
) -> Dict[str, Any]:
    before = await _remote_read_file(row, SYSCTL_FILE, sudo)
    merged = {**_parse_kv_file(before, separator="="), **updates}
    content = render_sysctl_file(merged)
    await _remote_write_file(row, SYSCTL_FILE, content, sudo)

    ok, output = await _remote_run(row, f"{sudo}sysctl -p {SYSCTL_FILE} 2>/dev/null", timeout=30)
    if not ok:
        ok, output = await _remote_run(row, f"{sudo}sysctl --system 2>/dev/null", timeout=30)
        if not ok:
            raise FixError(tr("写入成功但 sysctl 应用失败：") + output.strip()[:300])

    # 复验：逐个读回 /proc/sys，确认真的生效
    failed: List[str] = []
    for name, value in updates.items():
        path = os.path.join("/proc/sys", name.replace(".", "/"))
        _ok, out = await _remote_run(row, f"cat {path} 2>/dev/null")
        actual = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if actual and actual != str(value).strip():
            failed.append(
                pick(
                    f"{name}={actual}（期望 {value}）",
                    f"{name}={actual} (expected {value})",
                )
            )
    if failed:
        raise FixError(
            tr("远程内核参数未按预期生效：") + pick("、", ", ").join(failed)
        )
    return {
        "ok": True,
        "path": SYSCTL_FILE,
        "config": content,
        "detail": tr("已应用"),
    }


async def _remote_fix_time_sync(row: Dict[str, Any], sudo: str) -> Dict[str, Any]:
    ok, output = await _remote_run(row, f"{sudo}timedatectl set-ntp true 2>&1", timeout=20)
    if ok:
        return {"ok": True, "detail": tr("已执行 timedatectl set-ntp true")}
    ok2, out2 = await _remote_run(
        row, f"{sudo}systemctl enable --now systemd-timesyncd 2>&1", timeout=30
    )
    if ok2:
        return {"ok": True, "detail": tr("已启用 systemd-timesyncd")}
    raise FixError(
        tr("启用时间同步失败：") + (out2.strip() or output.strip())[:300]
    )


async def _remote_fix_empty_password_accounts(
    row: Dict[str, Any], sudo: str
) -> Dict[str, Any]:
    shadow = await _remote_read_file(row, SHADOW_FILE, sudo)
    passwd = await _remote_read_file(row, PASSWD_FILE, sudo)
    users = empty_password_users(shadow, passwd)
    if not users:
        return {"ok": True, "detail": tr("没有需要处理的空口令账号")}
    locked: List[str] = []
    for user in users:
        if not re.match(r"^[A-Za-z0-9._-]{1,32}$", user):
            continue
        ok, output = await _remote_run(row, f"{sudo}passwd -l {user} 2>&1")
        if not ok:
            raise FixError(
                pick(
                    f"锁定账号 {user} 失败：{output.strip()[:200]}",
                    f"Failed to lock the account {user}: {output.strip()[:200]}",
                )
            )
        locked.append(user)
    return {
        "ok": True,
        "detail": tr("已锁定账号：") + pick("、", ", ").join(locked),
    }


async def _apply_remote_fix(row: Dict[str, Any], key: str) -> Dict[str, Any]:
    """在受管主机上执行一个加固项。"""
    await _remote_sshd_guard(row, key)
    sudo = _sshremote()._sudo_prefix(row)
    if key in SSH_FIX_VALUES:
        return await _remote_apply_sshd(row, SSH_FIX_VALUES[key], sudo)
    if key == "pwd_max_days":
        return await _remote_apply_login_defs(row, {"PASS_MAX_DAYS": "90"}, sudo)
    if key == "pwd_min_len":
        return await _remote_apply_login_defs(row, {"PASS_MIN_LEN": "8"}, sudo)
    if key == "time_sync":
        return await _remote_fix_time_sync(row, sudo)
    if key == "accounts_empty_password":
        return await _remote_fix_empty_password_accounts(row, sudo)
    name, value = SYSCTL_FIX_VALUES[key]
    return await _remote_apply_sysctl(row, {name: value}, sudo)


# ------------------------------------------------------------------ 修复注册表
#
# FIXERS 是「本机修复函数」的注册表；它的键同时也是「有哪些项支持自动修复」的
# 唯一答案（远程复用同一套键，只是换成通过 SSH 执行）。

FIXERS: Dict[str, Callable[[], Dict[str, Any]]] = {
    "ssh_root_login": fix_ssh_root_login,
    "ssh_password_auth": fix_ssh_password_auth,
    "ssh_empty_passwords": fix_ssh_empty_passwords,
    "ssh_max_auth_tries": fix_ssh_max_auth_tries,
    "pwd_max_days": fix_pwd_max_days,
    "pwd_min_len": fix_pwd_min_len,
    "time_sync": fix_time_sync,
    "accounts_empty_password": fix_empty_password_accounts,
}
for _spec in SYSCTL_CHECKS:
    FIXERS[_spec["key"]] = _sysctl_fixer(_spec["key"])


def fixable_keys() -> List[str]:
    return sorted(FIXERS)


async def apply_fix(key: str, host_id: str = "local") -> Dict[str, Any]:
    """执行单个加固项（本机或受管主机）。失败抛 :class:`FixError`（路由转 400）。"""
    if key not in FIXERS:
        raise FixError(
            pick(
                f"「{key}」不支持一键修复，请按建议手动处理",
                f"“{key}” cannot be fixed automatically; follow the recommendation manually",
            )
        )
    if host_id in ("", "local"):
        return await asyncio.to_thread(FIXERS[key])
    row = await _sshremote().get_host(host_id)
    if not row:
        raise FixError(
            pick(f"受管主机 {host_id} 不存在", f"Managed host {host_id} does not exist")
        )
    return await _apply_remote_fix(row, key)


async def apply_fixes(
    keys: Optional[List[str]] = None, host_id: str = "local"
) -> Dict[str, Any]:
    """批量加固：``keys`` 为空时自动挑出「不合格 / 待改进且可修复」的项。

    逐项单独执行 —— 某一项失败不影响其它项，结果里逐条回报成败。需要点名确认的
    项（``auto=False``，例如关闭 SSH 口令认证）永远不进自动清单。
    """
    if keys is None:
        report = await collect_host(host_id)
        keys = [
            item["key"]
            for item in report.get("checks", [])
            if item["fixable"] and item["auto"] and item["status"] in ("warn", "fail")
        ]
    applied: List[Dict[str, Any]] = []
    for key in keys:
        try:
            result = await apply_fix(key, host_id)
            applied.append(
                {
                    "key": key,
                    "ok": True,
                    "detail": result.get("detail", ""),
                    "path": result.get("path", ""),
                }
            )
        except FixError as exc:
            applied.append({"key": key, "ok": False, "detail": "", "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - 单项异常不能拖垮批量
            logger.exception("加固 %s 失败", key)
            applied.append(
                {"key": key, "ok": False, "detail": "", "error": str(exc)[:300]}
            )
    return {
        "applied": applied,
        "fixed": sum(1 for item in applied if item["ok"]),
        "failed": sum(1 for item in applied if not item["ok"]),
    }
