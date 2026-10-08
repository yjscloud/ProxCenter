"""AI 排查助手的只读工具集（L2）。

L2 与 L1 的区别是：模型可以**自己决定再看点什么**，而不只是被动解读一份固定
数据。能力上去了，约束就必须跟上 —— 这里的安全设计分四层，缺一不可：

1. **只给模板，不给 shell**：工具是有限的、参数化的命令模板，**不存在**
   ``run_command(cmd)`` 这种万能工具。模型能做的只有「选一个工具 + 填参数」，
   既不能拼管道，也不能追加 ``; rm -rf /``。
2. **参数白名单**：每个参数都有正则约束（路径、单元名、行数…），不匹配直接拒。
   路径还要落在允许的目录与文件清单里，读 ``/etc/shadow`` 之类的请求根本到不了
   执行层。
3. **argv 数组 + quote**：本机用 ``subprocess.run(argv)``（不过 shell）；远程
   必须拼成字符串（ssh 的 ``exec_command`` 会过远端 shell），所以逐个
   ``shlex.quote``。两条路径都不给注入留缝。
4. **不用 sudo**：所有工具都是普通用户可读的命令。即使管理员给受管主机配了免密
   sudo 凭据，AI 也拿不到 root 能力 —— 这是**刻意放弃**的能力，不是遗漏。需要
   root 才能看的检查（口令策略、影子文件）由安全基线模块负责，它有自己的加固
   流程和二次确认。

还有一层与安全无关、但很影响效果：**输出截断**。``df -h`` 几十行无所谓，但
``ps aux`` 在繁忙机器上是几千行，整段塞回模型既烧 token 又把重点淹掉 —— 业界
踩过这个坑，这里每个工具都标了合理的 ``limit``。
"""
from __future__ import annotations

import asyncio
import logging
import re
import shlex
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from . import i18n

logger = logging.getLogger(__name__)

# 单个工具返回给模型的最大字符数。超出部分截断并明确告知模型「还有更多」，
# 它就会改用更精确的参数再查，而不是把整段噪音吃下去。
MAX_OUTPUT = 4000
# 单条命令的超时。只读命令跑这么久还没完，基本是卡住了。
RUN_TIMEOUT = 15.0

# 允许「列目录」的路径前缀（前缀匹配，注意结尾的 / 不能省）
ALLOWED_DIRS = (
    "/etc/",
    "/var/log/",
    "/opt/",
    "/srv/",
    "/usr/local/",
)
# 允许「读内容」的具体文件 —— 白名单而不是黑名单：漏一个文件只是少个功能，
# 漏一条规则却是泄一份凭据。
ALLOWED_FILES = (
    "/etc/ssh/sshd_config",
    "/etc/ssh/ssh_config",
    "/etc/fstab",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/hostname",
    "/etc/os-release",
    "/etc/login.defs",
    "/etc/crontab",
    "/etc/nginx/nginx.conf",
    "/etc/security/pwquality.conf",
    "/etc/security/limits.conf",
    # 软件源：只读查看具体源文件，改源是写操作，不在助手职责内
    "/etc/apt/sources.list",
)
# 无论白名单怎么写，文件名里带这些词的都不给读
FORBIDDEN_HINTS = ("shadow", "private", "secret", "credential", "id_rsa", "id_ed25519", ".key")

PATH_RE = re.compile(r"^/[A-Za-z0-9_./\-]{1,200}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@_.\-]{1,64}$")
LINES_RE = re.compile(r"^[1-9][0-9]{0,3}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_./\-]{1,64}$")
# 主机地址（IPv4 / IPv6 / 域名）。首字符必须是字母或数字，堵住 "--help" 这类
# 以连字符开头、会被命令当成选项的参数；不含斜杠，避免被当成路径。
HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,252}$")
# 软件包名（Debian 系）：字母数字开头，允许 + . _ : -
PKG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+._:\-]{0,127}$")
# 正整数（VMID、时间窗小时数…）。PVE 的 VMID 上限很大，放到 9 位；不接受 0 开头。
NUM_RE = re.compile(r"^[1-9][0-9]{0,8}$")


class ToolError(ValueError):
    """工具参数不合法 / 工具不可用。这里抛出的都会被翻译成人话回给模型。"""


# ------------------------------------------------------------------ 工具定义
# 主机只读命令：argv 模板 + 参数约束（{name} 占位由参数填充）
HOST_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "host_disk_usage",
        "description": "查看目标主机的磁盘使用情况（df -h），用于判断是否有分区将满。",
        "argv": ["df", "-h"],
        "params": {},
        "limit": 2000,
    },
    {
        "name": "host_memory",
        "description": "查看内存与 swap 使用情况（free -m）。",
        "argv": ["free", "-m"],
        "params": {},
        "limit": 1200,
    },
    {
        "name": "host_load",
        "description": "查看负载、运行时长与登录用户数（uptime）。",
        "argv": ["uptime"],
        "params": {},
        "limit": 600,
    },
    {
        "name": "host_top_processes",
        "description": "按 CPU 占用倒序列出进程（最上面的最吃 CPU），用于定位异常进程。",
        "argv": ["ps", "-eo", "pid,ppid,user,pcpu,pmem,etime,comm", "--sort=-pcpu"],
        "params": {},
        "limit": 2600,
    },
    {
        "name": "host_listening_ports",
        "description": "列出正在监听的 TCP/UDP 端口及其进程（ss -tulnp）。",
        "argv": ["ss", "-tulnp"],
        "params": {},
        "limit": 3000,
    },
    {
        "name": "host_failed_units",
        "description": "列出启动失败或异常退出的 systemd 单元（systemctl --failed）。",
        "argv": ["systemctl", "--failed", "--no-pager", "--plain"],
        "params": {},
        "limit": 2000,
    },
    {
        "name": "host_block_devices",
        "description": "查看块设备与分区（lsblk），用于确认磁盘拓扑。",
        "argv": ["lsblk", "-o", "NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE"],
        "params": {},
        "limit": 2000,
    },
    {
        "name": "host_list_dir",
        "description": (
            "列出一个目录的内容（ls -la）。只允许 /etc、/var/log、/opt、/srv、"
            "/usr/local 下面的路径。"
        ),
        "argv": ["ls", "-la", "{path}"],
        "params": {"path": {"pattern": "path", "required": True, "kind": "dir"}},
        "limit": 2500,
    },
    {
        "name": "host_read_config",
        "description": (
            "读取一个配置文件的全文（cat）。只允许读取固定的白名单文件，例如 "
            "/etc/ssh/sshd_config、/etc/fstab、/etc/nginx/nginx.conf 等。"
        ),
        "argv": ["cat", "{path}"],
        "params": {"path": {"pattern": "path", "required": True, "kind": "file"}},
        "limit": 4000,
    },
    {
        "name": "host_read_log",
        "description": (
            "读取某个 systemd 单元的最近日志（journalctl）。unit 用服务名，"
            "例如 sshd、nginx、pveproxy。"
        ),
        "argv": ["journalctl", "-u", "{unit}", "-n", "{lines}", "--no-pager"],
        "params": {
            "unit": {"pattern": "unit", "required": True},
            "lines": {"pattern": "lines", "required": False, "default": "60"},
        },
        "limit": 4000,
    },
    {
        "name": "host_recent_logins",
        "description": "查看最近的成功登录记录（last -n 20），用于发现异常来源。",
        "argv": ["last", "-n", "20"],
        "params": {},
        "limit": 2000,
    },
    {
        "name": "host_time_sync",
        "description": "查看时间同步状态（timedatectl），时间不准会让日志与告警对不上。",
        "argv": ["timedatectl", "status"],
        "params": {},
        "limit": 1200,
    },
    # ---------------- 网络诊断（连通性 / DNS / 路由 / 丢包计数）----------------
    {
        "name": "host_ping",
        "description": (
            "从目标主机向一个地址发 4 个 ICMP 包（ping），用于判断连通性、"
            "丢包率与往返延迟。address 填 IP 或域名。"
        ),
        "argv": ["ping", "-c", "4", "-W", "2", "{address}"],
        "params": {"address": {"pattern": "host", "required": True}},
        "limit": 1600,
    },
    {
        "name": "host_dns_lookup",
        "description": (
            "解析一个域名（getent hosts），用于确认 DNS 是否正常、解析到哪个地址。"
        ),
        "argv": ["getent", "hosts", "{name}"],
        "params": {"name": {"pattern": "host", "required": True}},
        "limit": 800,
    },
    {
        "name": "host_ip_route",
        "description": (
            "查看内核路由表（ip route），用于判断默认网关与到某网段的路由是否存在。"
        ),
        "argv": ["ip", "route"],
        "params": {},
        "limit": 2000,
    },
    {
        "name": "host_ip_addr",
        "description": (
            "概览各网卡的地址、状态与 MTU（ip -br addr），"
            "用于确认网卡是否 UP、IP 配置是否正确。"
        ),
        "argv": ["ip", "-br", "addr"],
        "params": {},
        "limit": 1600,
    },
    {
        "name": "host_net_stats",
        "description": (
            "查看各网卡的累计收发包与错误 / 丢弃计数（ip -s link），"
            "用于判断网卡层面是否存在丢包或错包。"
        ),
        "argv": ["ip", "-s", "link"],
        "params": {},
        "limit": 2600,
    },
    {
        "name": "host_socket_summary",
        "description": (
            "套接字总览（ss -s）：各状态连接数与 TIME_WAIT 数量，"
            "用于判断连接是否堆积、端口是否被耗尽。"
        ),
        "argv": ["ss", "-s"],
        "params": {},
        "limit": 1200,
    },
    # ---------------- 性能分析（初级：采样与快照）----------------
    {
        "name": "host_cpu_info",
        "description": (
            "查看 CPU 型号、核数、NUMA 与缓存拓扑（lscpu），"
            "是分析性能瓶颈与中断分布的基础。"
        ),
        "argv": ["lscpu"],
        "params": {},
        "limit": 2600,
    },
    {
        "name": "host_vmstat",
        "description": (
            "间隔 1 秒采样 3 次，看 CPU 使用、上下文切换、swap 换入换出与 IO 等待"
            "（vmstat），用于初步判断瓶颈在 CPU、内存还是磁盘。"
        ),
        "argv": ["vmstat", "1", "3"],
        "params": {},
        "limit": 1600,
    },
    {
        "name": "host_softirqs",
        "description": (
            "查看各 CPU 的软中断累计计数（/proc/softirqs），"
            "用于判断网络 / 定时器软中断是否集中在个别核上。"
        ),
        "argv": ["cat", "/proc/softirqs"],
        "params": {},
        "limit": 2600,
    },
    {
        "name": "host_top_memory",
        "description": (
            "按常驻内存（RSS）倒序列出进程，"
            "用于定位内存占用大户与疑似内存泄漏的进程。"
        ),
        "argv": ["ps", "-eo", "pid,ppid,user,pmem,rss,etime,comm", "--sort=-rss"],
        "params": {},
        "limit": 2600,
    },
    # ---------------- 内核与故障恢复 ----------------
    {
        "name": "host_kernel_log",
        "description": (
            "读取内核环形缓冲区的最近日志（journalctl -k），"
            "用于排查 OOM、驱动报错、硬件异常等只出现在内核日志里的问题。"
        ),
        "argv": ["journalctl", "-k", "-n", "{lines}", "--no-pager"],
        "params": {"lines": {"pattern": "lines", "required": False, "default": "80"}},
        "limit": 4000,
    },
    {
        "name": "host_kernel_cmdline",
        "description": (
            "查看内核启动参数（/proc/cmdline），"
            "用于确认是否预留了 crashkernel（kdump 的前提）、以及有无异常启动项。"
        ),
        "argv": ["cat", "/proc/cmdline"],
        "params": {},
        "limit": 800,
    },
    {
        "name": "host_unit_status",
        "description": (
            "查看某个 systemd 单元的详细状态（systemctl status），比 --failed 更细；"
            "排查 kdump、chronyd、nginx 等具体服务时使用。"
        ),
        "argv": ["systemctl", "status", "{unit}", "--no-pager", "--plain"],
        "params": {"unit": {"pattern": "unit", "required": True}},
        "limit": 2400,
    },
    # ---------------- 软件包（Debian / Ubuntu / Proxmox 系）----------------
    {
        "name": "host_package_info",
        "description": (
            "查询某个已安装软件包的版本与状态（dpkg-query），适用于 Debian / Ubuntu / "
            "Proxmox；package 填包名，例如 openssh-server。"
        ),
        "argv": ["dpkg-query", "-W", "-f=${Package} ${Version} ${Status}\\n", "{package}"],
        "params": {"package": {"pattern": "package", "required": True}},
        "limit": 800,
    },
    # ---- 授权执行（仅在用户明确授权后暴露）----
    {
        "name": "host_run_command",
        "description": (
            "在目标主机上执行一条只读诊断命令（需用户已授权本次排查）。"
            "可以用 | 串联多个只读命令，例如 ps aux | grep nginx、"
            "journalctl -u nginx -n 100 | grep -i error。"
            "仅限只读白名单内的命令；不支持 ; && || 重定向与命令替换，也不用 sudo。"
        ),
        "exec": True,
        "params": {"command": {"pattern": "command", "required": True}},
        "limit": 4000,
    },
    {
        "name": "host_propose_command",
        "description": (
            "提议在目标主机上执行一条会改动系统的命令（例如 systemctl restart nginx、"
            "清理过期日志、改配置后重载）。它不会立刻执行：先展示给用户，由用户逐条"
            "批准后才跑；被拒绝或超时会收到说明，请换方案而不是反复重试同一条。"
            "purpose 用一句话讲清楚为什么要执行它。"
        ),
        "exec": True,
        "writes": True,
        "params": {
            "command": {"pattern": "command", "required": True},
            "purpose": {"pattern": "text", "required": True},
        },
        "limit": 4000,
    },
]

# 平台内部数据：不走命令，直接读已有巡检模块的结果（零风险，且比读日志准）
INTERNAL_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "get_baseline_report",
        "description": (
            "取这台主机的完整安全体检报告（比一开始给你的摘要更全），"
            "包含全部检查项的结论与修复建议。"
        ),
        "handler": "baseline",
        "params": {},
    },
    {
        "name": "get_ssh_failures",
        "description": "取这台主机最近 24 小时的 SSH 登录失败统计与来源 IP 排名。",
        "handler": "ssh",
        "params": {},
    },
    {
        "name": "get_alert_history",
        "description": "取最近的告警历史（含已恢复的），用于判断问题是长期存在还是刚刚出现。",
        "handler": "alerts",
        "params": {},
    },
    {
        "name": "get_metrics_history",
        "description": (
            "取平台已落库的历史资源指标（CPU / 内存 / 磁盘 / 网络），用于判断问题"
            "「什么时候开始的、是突发还是持续恶化」——这是只看瞬时命令看不到的。"
            "scope 填 guest 查虚拟机/容器（需同时填 node 与 vmid），填 node 查节点"
            "（需管理员）；hours 是回看窗口（小时，默认 6）。"
        ),
        "handler": "metrics",
        "params": {
            "scope": {"pattern": "scope", "required": True},
            "node": {"pattern": "name", "required": False},
            "vmid": {"pattern": "num", "required": False},
            "hours": {"pattern": "num", "required": False, "default": "6"},
        },
    },
    {
        "name": "get_recent_changes",
        "description": (
            "取最近的集群变更记录（启动 / 关机 / 快照 / 备份 / 迁移 / 克隆 / 配置修改"
            "等任务），用于回答「问题出现之前做过什么」。hours 是回看窗口（默认 24）。"
        ),
        "handler": "changes",
        "params": {
            "hours": {"pattern": "num", "required": False, "default": "24"},
        },
    },
    {
        "name": "get_related_resources",
        "description": (
            "取与被排查对象相关的集群资源：节点负载、同节点邻居虚拟机、节点存储用量，"
            "用于判断「这台机器慢」是否由宿主或邻居资源争抢导致。node 填节点名、vmid 可选；"
            "两个都留空则返回集群的节点概览，可用它先找出有哪些节点。"
        ),
        "handler": "related",
        "params": {
            "node": {"pattern": "name", "required": False},
            "vmid": {"pattern": "num", "required": False},
        },
    },
]

HOST_TOOL_MAP = {item["name"]: item for item in HOST_TOOLS}
INTERNAL_TOOL_MAP = {item["name"]: item for item in INTERNAL_TOOLS}


# 参数类型 → 给模型看的说明。同一份映射既用于主机命令，也用于平台内部工具。
_PARAM_HINTS: Dict[str, str] = {
    "path": "绝对路径",
    "unit": "systemd 单元名，例如 sshd",
    "lines": "读取的行数",
    "host": "IP 或域名",
    "package": "软件包名，例如 openssh-server",
    "num": "正整数",
    "scope": "node（节点）或 guest（虚拟机 / 容器）",
    "name": "名称",
    "command": "一条只读诊断命令，可用 | 串联多个只读命令",
    "text": "一句话说明（不要换行）",
}


def _params_schema(item: Dict[str, Any]) -> Dict[str, Any]:
    """把一个工具定义的 ``params`` 转成 JSON Schema（两类工具共用）。"""
    props: Dict[str, Any] = {}
    required: List[str] = []
    for key, rule in (item.get("params") or {}).items():
        hint = _PARAM_HINTS.get(rule.get("pattern", ""), key)
        props[key] = {"type": "string", "description": hint}
        if rule.get("required"):
            required.append(key)
    return {"type": "object", "properties": props, "required": required}


def openai_tools(include_exec: bool = False) -> List[Dict[str, Any]]:
    """转成 OpenAI function calling 的 tools 格式（主机命令 + 平台内部工具）。

    ``include_exec=True`` 时额外带上 ``host_run_command``（模型自己拼只读命令）。
    只有本次排查拿到了用户授权、调用方才会传 True —— 默认这条路径不存在。
    """
    specs: List[Dict[str, Any]] = []
    for item in INTERNAL_TOOLS + HOST_TOOLS:
        if item.get("exec") and not include_exec:
            continue
        specs.append(
            {
                "type": "function",
                "function": {
                    "name": item["name"],
                    "description": item["description"],
                    "parameters": _params_schema(item),
                },
            }
        )
    return specs


def tool_names() -> List[str]:
    return [item["name"] for item in INTERNAL_TOOLS + HOST_TOOLS]


# ------------------------------------------------------------------ 参数校验
def _check_path(value: str, kind: str) -> str:
    text = str(value or "").strip()
    if not PATH_RE.match(text):
        raise ToolError(i18n.pick("路径不合法", "Invalid path"))
    lowered = text.lower()
    if any(hint in lowered for hint in FORBIDDEN_HINTS):
        raise ToolError(i18n.pick("该文件不允许读取", "Reading this file is not allowed"))
    if ".." in text.split("/"):
        raise ToolError(i18n.pick("路径中不允许 ..", "“..” is not allowed in a path"))

    if kind == "dir":
        if not any(text == d.rstrip("/") or text.startswith(d) for d in ALLOWED_DIRS):
            raise ToolError(
                i18n.pick(
                    "只能列 " + "、".join(ALLOWED_DIRS) + " 下的目录",
                    "Only directories under " + " / ".join(ALLOWED_DIRS) + " may be listed",
                )
            )
    else:
        if text not in ALLOWED_FILES:
            raise ToolError(
                i18n.pick(
                    "该文件不在允许读取的白名单里",
                    "This file is not on the readable allowlist",
                )
            )
    return text


def _check_scalar(key: str, value: str, rule: Dict[str, Any]) -> str:
    """按参数规则校验单个标量值（主机命令与内部工具共用一套口径）。

    ``key`` 只用于报错定位；校验方式完全由 ``rule["pattern"]`` 决定，
    没有 ``pattern`` 的占位符不做额外限制（与既有行为一致）。
    """
    kind = rule.get("pattern")
    if kind == "path":
        return _check_path(value, rule.get("kind") or "dir")
    if kind == "unit":
        if not UNIT_RE.match(value):
            raise ToolError(i18n.pick("单元名不合法", "Invalid unit name"))
    elif kind == "lines":
        if not LINES_RE.match(value):
            raise ToolError(i18n.pick("行数必须是 1-9999", "Line count must be 1-9999"))
    elif kind == "name":
        if not NAME_RE.match(value):
            raise ToolError(i18n.pick("名称不合法", "Invalid name"))
    elif kind == "host":
        if not HOST_RE.match(value):
            raise ToolError(i18n.pick("主机地址不合法", "Invalid host address"))
    elif kind == "package":
        if not PKG_RE.match(value):
            raise ToolError(i18n.pick("软件包名不合法", "Invalid package name"))
    elif kind == "num":
        if not NUM_RE.match(value):
            raise ToolError(i18n.pick("必须是正整数", "Must be a positive integer"))
    elif kind == "scope":
        if value not in ("node", "guest"):
            raise ToolError(
                i18n.pick("scope 只能是 node 或 guest", "scope must be node or guest")
            )
    elif kind == "text":
        if len(value) > 200 or "\n" in value or "\r" in value:
            raise ToolError(
                i18n.pick("说明过长或含换行", "Text is too long or spans lines")
            )
    return value


def validate_args(tool: Dict[str, Any], raw: Any) -> List[str]:
    """把模型给的参数校验并归一成 argv。

    任何不合法都直接抛错（会在对话里作为工具结果回给模型），**不做「尽力修正」**：
    猜用户想查哪个文件不是这里该做的事，猜错了等于替他执行了一条他没要求的命令。
    """
    args = raw if isinstance(raw, dict) else {}
    argv: List[str] = []
    for part in tool["argv"]:
        if not (part.startswith("{") and part.endswith("}")):
            argv.append(part)
            continue

        key = part[1:-1]
        rule = (tool.get("params") or {}).get(key) or {}
        value = str(args.get(key) or rule.get("default") or "").strip()
        if not value:
            value = rule.get("default") or ""
        if not value:
            raise ToolError(
                i18n.pick(f"缺少参数 {key}", f"Missing required argument: {key}")
            )

        argv.append(_check_scalar(key, value, rule))
    return argv


def command_preview(name: str, args: Any) -> str:
    """这次调用**打算**在主机上跑的那条命令；拿不到就返回空串。

    用来在「排查过程」里把命令原文摊给用户看 —— 只说「调用了 host_read_log
    （unit=sshd）」等于没说：用户要知道的是它到底往他机器里敲了什么。所以这里
    把模板 + 参数还原成最终命令，与 :func:`run_host_tool` 走的是同一套
    :func:`validate_args`，展示的命令不会和实际执行的对不上。

    两种情况下返回空串：
    * **平台内部工具**（读体检报告 / 指标 / 变更记录）：它们根本不走命令行，
      界面据此把「跑了条命令」和「读了一份报表」分开显示；
    * 参数不合法：那时命令压根不会执行，与其编一条不如不显示（参数错误本身
      会作为工具结果回到对话里）。

    注意 ``host_run_command`` 这里给的是**模型写的原文**，而实际落地的是
    :func:`_run_command_tool` 里逐段 quote 之后的版本 —— 两者语义相同，只在参数
    含空格 / 特殊字符时字面不同。执行完的准确原文由 outcome 的 ``command``
    带回（见 :func:`run_host_tool`）。
    """
    tool = HOST_TOOL_MAP.get(name)
    if tool is None:
        return ""
    raw = args if isinstance(args, dict) else {}
    if tool.get("exec"):
        return str(raw.get("command") or "").strip()[:MAX_WRITE_COMMAND_LENGTH]
    try:
        argv = validate_args(tool, raw)
    except ToolError:
        return ""
    return " ".join(argv)


def validate_params(tool: Dict[str, Any], raw: Any) -> Dict[str, str]:
    """校验平台内部工具的具名参数（不生成 argv）。

    空值先按默认值补；补完仍为空的可选参数直接忽略，交由 handler 决定语义
    （例如 ``node`` 留空表示「全部节点」）；必填项缺了立即报错。
    """
    args = raw if isinstance(raw, dict) else {}
    out: Dict[str, str] = {}
    for key, rule in (tool.get("params") or {}).items():
        value = str(args.get(key) or "").strip() or str(rule.get("default") or "").strip()
        if not value:
            if rule.get("required"):
                raise ToolError(
                    i18n.pick(f"缺少参数 {key}", f"Missing required argument: {key}")
                )
            continue
        out[key] = _check_scalar(key, value, rule)
    return out


# ------------------------------------------------- 授权执行：只读命令白名单
#
# 用户显式授权后，模型可以**自己拼一条只读诊断命令**（例如 ``ps aux | grep nginx``），
# 不再受固定模板限制 —— 这才是「真正上机排查」与「点几个预设按钮」的区别。
#
# 约束与模块开头那四条一脉相承，只是从「模板 + 参数」放宽到「白名单命令」：
#
# 1. **不给任意 shell**：先做结构检查（禁 ``;`` / ``&&`` / ``||`` / 重定向 /
#    命令替换），再按 ``|`` 分段，每段的首个可执行文件必须在 READONLY_COMMANDS 里；
# 2. **逐命令限制子命令**：``systemctl`` 只认查询类子命令，``ip`` 不许 set / add / del，
#    ``find`` 不许 ``-exec``，``awk`` 不许 ``system(``；
# 3. **仍然不用 sudo**：即使受管主机配了免密 sudo，模型也拿不到 root。
#
# 这是一道**防误伤的门槛，不是安全沙箱**：命令由模型生成、用户已授权、全程记入
# 审计（工具调用明细）。要更硬的隔离，应当用专用只读账号 + ``authorized_keys`` 的
# forced command，而不是靠这一层字符串校验。
READONLY_COMMANDS = frozenset(
    {
        # 资源与进程
        "df", "du", "free", "uptime", "ps", "vmstat", "iostat", "mpstat", "sar",
        "pidstat", "lscpu", "lsblk", "lsmod", "lspci", "lsusb", "nproc", "sensors",
        "smartctl",
        # 文件与文本（只读）
        "cat", "head", "tail", "ls", "stat", "file", "wc", "sort", "uniq", "grep",
        "egrep", "fgrep", "cut", "tr", "awk", "find", "which", "whereis",
        # 日志与服务
        "journalctl", "dmesg", "systemctl", "hostnamectl",
        # 网络
        "ss", "netstat", "ip", "ifconfig", "route", "arp", "ethtool", "ping",
        "traceroute", "tracepath", "mtr", "dig", "nslookup", "host", "getent",
        "iptables", "ip6tables", "nft", "ufw", "fail2ban-client",
        # 系统与账号信息
        "uname", "hostname", "date", "timedatectl", "who", "w", "last", "lastb",
        "id", "groups", "mount", "findmnt", "swapon", "lsof", "getconf", "env",
        "printenv",
    }
)

# 出现即整条拒绝：多命令、命令替换、输入输出重定向（重定向会改文件）
_SHELL_METACHARS = (";", "&&", "||", "`", "$(", "${", ">", "<", "\n", "\r")

# 子命令白名单：第一个非选项参数必须是其中之一（没给子命令时至少要有个 -- 开关）
_SUBCOMMAND_ALLOW: Dict[str, tuple] = {
    "systemctl": (
        "status", "show", "cat", "list-units", "list-unit-files",
        "list-dependencies", "list-timers", "list-sockets", "is-active",
        "is-enabled", "is-failed", "is-system-running", "get-default",
    ),
    "nft": ("list",),
    "ufw": ("status",),
    "fail2ban-client": ("status",),
}

# 参数黑名单（精确匹配；以 "-" 开头的项按前缀匹配，覆盖 -AINPUT 这类连写）
_TOKEN_DENY: Dict[str, tuple] = {
    "ip": ("set", "add", "del", "delete", "flush", "change", "replace", "up", "down"),
    "iptables": ("-A", "-D", "-I", "-F", "-X", "-P", "-N", "-E", "-R"),
    "ip6tables": ("-A", "-D", "-I", "-F", "-X", "-P", "-N", "-E", "-R"),
    "mount": ("-o", "-a", "--all"),
    "swapon": ("-a", "--all"),
    "smartctl": ("-t", "--test", "-s", "--set", "-X"),
}

# 子串黑名单：参数本身是一段脚本 / 表达式，只能按内容匹配
_SUBSTR_DENY: Dict[str, tuple] = {
    "awk": ("system(", "exec(", "print >", "printf >"),
    "find": ("-exec", "-delete", "-fprint", "-fls"),
}

MAX_COMMAND_LENGTH = 500


def _segment_ok(argv: List[str]) -> bool:
    """单段管道是否只读：可执行文件在白名单内，且子命令 / 参数都合规。"""
    if not argv:
        return False
    exe = argv[0].rsplit("/", 1)[-1]
    if exe not in READONLY_COMMANDS:
        return False
    rest = argv[1:]

    allow = _SUBCOMMAND_ALLOW.get(exe)
    if allow is not None:
        sub = next((arg for arg in rest if not arg.startswith("-")), "")
        if sub:
            if sub not in allow:
                return False
        elif not any(arg.startswith("--") for arg in rest):
            # 既没子命令也没开关（例如光敲一个 systemctl），无从判断，拒绝
            return False

    for bad in _TOKEN_DENY.get(exe, ()):
        if bad.startswith("-"):
            if any(arg.startswith(bad) for arg in rest):
                return False
        elif any(arg == bad for arg in rest):
            return False

    for bad in _SUBSTR_DENY.get(exe, ()):
        if any(bad in arg for arg in rest):
            return False
    return True


def validate_command(command: Any) -> List[List[str]]:
    """校验一条只读诊断命令，返回按 ``|`` 拆好的 argv 列表。不合法抛 ToolError。"""
    text = str(command or "").strip()
    if not text:
        raise ToolError(i18n.pick("命令不能为空", "Command must not be empty"))
    if len(text) > MAX_COMMAND_LENGTH:
        raise ToolError(i18n.pick("命令过长", "Command is too long"))
    for bad in _SHELL_METACHARS:
        if bad in text:
            raise ToolError(
                i18n.pick(
                    f"只读命令里不允许出现 {bad}（写操作 / 多命令 / 命令替换）",
                    f"“{bad}” is not allowed in a read-only command "
                    "(writes / chained commands / substitution)",
                )
            )

    segments: List[List[str]] = []
    for piece in text.split("|"):
        seg = piece.strip()
        if not seg:
            raise ToolError(i18n.pick("命令里有空段", "The command has an empty segment"))
        try:
            argv = shlex.split(seg)
        except ValueError as exc:
            raise ToolError(i18n.pick("命令无法解析", "The command cannot be parsed")) from exc
        if not _segment_ok(argv):
            raise ToolError(
                i18n.pick(
                    "不允许执行：" + (argv[0] if argv else "?"),
                    "Not allowed: " + (argv[0] if argv else "?"),
                )
            )
        segments.append(argv)
    return segments


# ------------------------------------------------- 授权执行：写命令的硬拦截
#
# 写命令**不套只读白名单**（重启服务、改配置、装包没有统一形状），改由
# **用户逐条批准**把关。这里只拦「批了也不该执行」的那一类 —— 会毁掉机器或
# 直接断开连接的：
# 每项是 (中文说明, 英文说明, 正则)：前两项是给「能力说明」页展示的人话，
# 与正则一一对应 —— 改正则时别忘了改它，否则说明页会和实际拦截对不上。
_WRITE_FORBIDDEN = (
    ("删除根目录（rm -rf /）", "Wipe the root filesystem (rm -rf /)", re.compile(r"\brm\s+(-\w+\s+)*/(\s|$|\*)")),
    ("格式化文件系统（mkfs）", "Format a filesystem (mkfs)", re.compile(r"\bmkfs(\.\w+)?\b")),
    ("直接写块设备（dd）", "Write straight to a block device (dd)", re.compile(r"\bdd\s+")),
    ("fork 炸弹", "Fork bomb", re.compile(r":\(\)\s*\{")),
    ("关机或重启", "Shut down or reboot", re.compile(r"\b(shutdown|reboot|halt|poweroff)\b")),
    ("重定向覆盖块设备", "Overwrite a block device by redirection", re.compile(r">\s*/dev/(sd|nvme|vd|hd|mmcblk)")),
    ("放开根目录权限（chmod -R 777 /）", "Open up root permissions (chmod -R 777 /)", re.compile(r"\bchmod\s+-R\s+777\s+/(\s|$)")),
)

MAX_WRITE_COMMAND_LENGTH = 1000


def validate_write_command(command: Any) -> str:
    """校验一条**会改动系统**的命令（用户已逐条批准）。

    与只读那条路不同：这里不限可执行文件，只拦下「即便用户批了也不该跑」的
    灾难性命令。返回规范化后的命令文本，不合法抛 :class:`ToolError`。
    """
    text = str(command or "").strip()
    if not text:
        raise ToolError(i18n.pick("命令不能为空", "Command must not be empty"))
    if len(text) > MAX_WRITE_COMMAND_LENGTH:
        raise ToolError(i18n.pick("命令过长", "Command is too long"))
    if "\n" in text or "\r" in text:
        raise ToolError(i18n.pick("命令不能包含换行", "The command must be a single line"))
    for _label_zh, _label_en, pattern in _WRITE_FORBIDDEN:
        if pattern.search(text):
            raise ToolError(
                i18n.pick(
                    "这类命令不允许执行（可能毁坏系统或断开连接），请改用平台自带的操作入口",
                    "This kind of command is not allowed (it may destroy the system or drop the "
                    "connection); use the platform's own action instead",
                )
            )
    return text


# ------------------------------------------------- 口径快照：给「能力说明」用
def security_policy() -> Dict[str, Any]:
    """本模块的白名单 / 黑名单快照，供界面上的「能力说明」渲染。

    为什么不把这些清单在前端写第二份：它们就是**真正执行时校验的那份规则**
    （见 :func:`validate_command` / :func:`_check_path` / :func:`validate_write_command`）。
    抄一份到界面上，改了代码忘了改文案的那一刻，说明页就开始骗人了 —— 而用户
    正是照着它判断「敢不敢把机器交给这个助手」。这里只做结构转换，不新增判断。

    返回的都是语言无关的原始素材（命令名、路径、字符、正则pattern），
    标题与解释由前端按当前界面语言套上去。
    """
    return {
        # 只读白名单：模型自己拼命令时，每段管道首个可执行文件必须命中这里
        "readonly_commands": sorted(READONLY_COMMANDS),
        # 出现即整条拒绝的字符 / 结构（多命令、命令替换、重定向）
        "denied_metachars": [item for item in _SHELL_METACHARS],
        # 子命令白名单：第一个非选项参数必须命中
        "subcommand_allow": {key: list(value) for key, value in _SUBCOMMAND_ALLOW.items()},
        # 参数黑名单（"-" 开头按前缀匹配，覆盖 -AINPUT 这类连写）
        "token_deny": {key: list(value) for key, value in _TOKEN_DENY.items()},
        # 子串黑名单：参数本身是脚本 / 表达式，只能按内容匹配
        "substr_deny": {key: list(value) for key, value in _SUBSTR_DENY.items()},
        # 路径与文件：先过白名单，再被 FORBIDDEN_HINTS 一票否决
        "allowed_dirs": list(ALLOWED_DIRS),
        "allowed_files": list(ALLOWED_FILES),
        "forbidden_hints": list(FORBIDDEN_HINTS),
        # 写命令（用户逐条批准那条路）的灾难性命令硬拦截；带人话说明，
        # 因为正则没法直接给人看
        "write_forbidden": [
            i18n.pick(label_zh, label_en)
            for label_zh, label_en, _pattern in _WRITE_FORBIDDEN
        ],
        "max_readonly_length": MAX_COMMAND_LENGTH,
        "max_write_length": MAX_WRITE_COMMAND_LENGTH,
    }


# ------------------------------------------------------------------ 执行
def _run_local(argv: List[str], timeout: float) -> Tuple[bool, str]:
    """本机执行：argv 数组直接交给 subprocess，不过 shell。"""
    import subprocess

    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired:
        return False, "命令执行超时"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, out


async def _run_remote(row: Dict[str, Any], argv: List[str], timeout: float) -> Tuple[bool, str]:
    """远程执行：ssh 的 exec_command 会过远端 shell，所以逐个 quote。

    这一句是整个模块最要紧的地方 —— 少了 quote，模型给出的参数就能在目标机上
    拼出第二条命令。注意**不加 sudo**，见模块开头的第 4 条。
    """
    from . import sshremote

    command = " ".join(shlex.quote(part) for part in argv)
    return await sshremote.run_command(row, command, timeout=timeout)


def _truncate(text: str, limit: int) -> str:
    body = (text or "").strip()
    if len(body) <= limit:
        return body
    return body[:limit] + "\n…（已截断，完整输出共 " + str(len(body)) + " 字符）"


def _run_local_shell(command: str, timeout: float) -> Tuple[bool, str]:
    """本机执行一条**已通过白名单校验**的只读命令管道。

    这里必须过 shell —— 管道（``|``）只有 shell 能串起来。安全性由
    :func:`validate_command` 在**进入本函数之前**兜住：结构检查 + 逐段白名单。
    """
    import subprocess

    try:
        proc = subprocess.run(
            ["sh", "-c", command],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "命令执行超时"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    return proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")


async def _run_remote_shell(
    row: Dict[str, Any], command: str, timeout: float
) -> Tuple[bool, str]:
    """远程执行（远端本来就走 shell，命令已经校验过）。"""
    from . import sshremote

    return await sshremote.run_command(row, command, timeout=timeout)


async def _run_command_tool(
    tool: Dict[str, Any],
    args: Any,
    *,
    row: Optional[Dict[str, Any]],
    local: bool,
) -> Dict[str, Any]:
    """执行 ``host_run_command``：模型自己拼的只读命令，先过白名单再落地。"""
    raw = (args or {}).get("command") if isinstance(args, dict) else ""
    try:
        segments = validate_command(raw)
    except ToolError as exc:
        # 校验被拒是**预期内的交互**：如实回给模型，它会改写命令
        return {"ok": False, "output": str(exc)}

    command = " | ".join(
        " ".join(shlex.quote(part) for part in argv) for argv in segments
    )
    started = time.time()
    try:
        if local:
            ok, output = await asyncio.to_thread(_run_local_shell, command, RUN_TIMEOUT)
        elif row is not None:
            ok, output = await _run_remote_shell(row, command, RUN_TIMEOUT)
        else:
            return {"ok": False, "output": i18n.pick("目标主机不可达", "Target host unreachable")}
    except Exception as exc:  # noqa: BLE001 - 单条命令失败不该中断整次排查
        logger.warning("AI 命令执行失败：%s", exc)
        return {"ok": False, "output": str(exc)[:300]}

    return {
        "ok": ok,
        "output": _truncate(output, int(tool.get("limit") or MAX_OUTPUT)),
        "elapsed_ms": int((time.time() - started) * 1000),
        "command": command,
    }


async def _run_propose_tool(
    tool: Dict[str, Any],
    args: Any,
    *,
    row: Optional[Dict[str, Any]],
    local: bool,
    approval: Optional[Callable[[str, str], Awaitable[bool]]],
) -> Dict[str, Any]:
    """执行 ``host_propose_command``：**先请用户批准，批准后才真正落地**。

    ``approval(command, purpose)`` 由调用方（:mod:`app.ai`）提供 —— 它负责把
    「待批准」推给前端并挂起等待。这里只关心「批没批」。
    """
    source = args if isinstance(args, dict) else {}
    purpose = str(source.get("purpose") or "").strip()
    try:
        command = validate_write_command(source.get("command"))
        if not purpose:
            raise ToolError(
                i18n.pick("缺少 purpose（说明这条命令要干什么）", "Missing purpose")
            )
    except ToolError as exc:
        return {"ok": False, "output": str(exc)}

    if approval is None:
        return {
            "ok": False,
            "output": i18n.pick(
                "本次排查没有开启写命令审批通道，无法执行",
                "No approval channel is available for this run",
            ),
        }

    if not await approval(command, purpose):
        return {
            "ok": False,
            "output": i18n.pick(
                "用户没有批准这条命令。不要重复提议同一条，换个方案或先说明理由",
                "The user did not approve this command. Do not re-propose the same one; "
                "try a different approach or explain your reasoning first",
            ),
        }

    started = time.time()
    try:
        if local:
            ok, output = await asyncio.to_thread(_run_local_shell, command, RUN_TIMEOUT)
        elif row is not None:
            ok, output = await _run_remote_shell(row, command, RUN_TIMEOUT)
        else:
            return {"ok": False, "output": i18n.pick("目标主机不可达", "Target host unreachable")}
    except Exception as exc:  # noqa: BLE001 - 单条命令失败不该中断整次排查
        logger.warning("AI 写命令执行失败：%s", exc)
        return {"ok": False, "output": str(exc)[:300]}

    return {
        "ok": ok,
        "output": _truncate(output, int(tool.get("limit") or MAX_OUTPUT)),
        "elapsed_ms": int((time.time() - started) * 1000),
        "command": command,
    }


async def run_host_tool(
    name: str,
    args: Any,
    *,
    row: Optional[Dict[str, Any]],
    local: bool,
    approval: Optional[Callable[[str, str], Awaitable[bool]]] = None,
) -> Dict[str, Any]:
    """执行一个主机工具。返回 ``{ok, output}``，不抛异常给上层。"""
    tool = HOST_TOOL_MAP.get(name)
    if tool is None:
        return {"ok": False, "output": i18n.pick("没有这个工具", "No such tool")}

    # 写命令：先过用户审批再落地
    if tool.get("writes"):
        return await _run_propose_tool(
            tool, args, row=row, local=local, approval=approval
        )
    # 授权执行的自由只读命令：参数不是模板，而是模型拼好的整条命令
    if tool.get("exec"):
        return await _run_command_tool(tool, args, row=row, local=local)

    try:
        argv = validate_args(tool, args)
    except ToolError as exc:
        # 参数被拒是**预期内**的交互：如实告诉模型，它会换个参数再试
        return {"ok": False, "output": str(exc)}

    started = time.time()
    try:
        if local:
            ok, output = await asyncio.to_thread(_run_local, argv, RUN_TIMEOUT)
        elif row is not None:
            ok, output = await _run_remote(row, argv, RUN_TIMEOUT)
        else:
            return {"ok": False, "output": i18n.pick("目标主机不可达", "Target host unreachable")}
    except Exception as exc:  # noqa: BLE001 - 单条命令失败不该中断整次排查
        logger.warning("AI 工具 %s 执行失败：%s", name, exc)
        return {"ok": False, "output": str(exc)[:300]}

    return {
        "ok": ok,
        "output": _truncate(output, int(tool.get("limit") or MAX_OUTPUT)),
        "elapsed_ms": int((time.time() - started) * 1000),
        "command": " ".join(argv),
    }


async def _internal_baseline(host_id: str) -> Dict[str, Any]:
    from . import baseline

    report = await baseline.collect_host(host_id)
    issues = [
        {
            "key": item.get("key"),
            "status": item.get("status"),
            "label": item.get("label"),
            "value": item.get("value"),
            "expected": item.get("expected"),
            "detail": item.get("detail"),
            "hint": item.get("hint"),
        }
        for item in (report.get("checks") or [])
        if str(item.get("status")) != "pass"
    ]
    return {
        "score": report.get("score"),
        "grade": report.get("grade"),
        "issues": issues[:60],
    }


async def _internal_ssh() -> Dict[str, Any]:
    from . import sshguard

    report = await sshguard.collect(24)
    return {
        "summary": report.get("summary"),
        "top_ips": (report.get("top_ips") or [])[:15],
        "top_users": (report.get("top_users") or [])[:15],
    }


async def _internal_alerts() -> Dict[str, Any]:
    from . import alerting

    history = await alerting.history(40, None)
    return {
        "history": [
            {
                "target": row.get("target"),
                "metric": row.get("metric"),
                "value": row.get("value"),
                "threshold": row.get("threshold"),
                "result": row.get("result"),
                "kind": row.get("kind"),
                "ts": row.get("ts"),
            }
            for row in (history or [])
        ]
    }


def _clamp_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(low, min(number, high))


async def _owned_vm_refs(username: str, is_admin: bool) -> Optional[List[str]]:
    """非管理员返回自己名下的虚拟机 ref（``<conn>:<node>:<vmid>``）；管理员 ``None``（不限）。

    ref 的拼法与 :func:`metrics.query` 的 ``owned_refs`` 完全一致，直接透传即可完成隔离。
    """
    if is_admin:
        return None
    from . import ownership

    return await ownership.list_owned(ownership.KIND_VM, username or "")


def _stat(values: List[Any]) -> Optional[Dict[str, Any]]:
    """把一条时间序列压成 min/max/avg 与首尾值 —— 不给模型灌上千个采样点。"""
    nums = [float(v) for v in values if isinstance(v, (int, float))]
    if not nums:
        return None
    return {
        "min": round(min(nums), 4),
        "max": round(max(nums), 4),
        "avg": round(sum(nums) / len(nums), 4),
        "first": round(nums[0], 4),
        "last": round(nums[-1], 4),
    }


async def _internal_metrics(
    params: Dict[str, str], *, username: str, is_admin: bool
) -> Dict[str, Any]:
    scope = params.get("scope") or "guest"
    hours = _clamp_int(params.get("hours"), 1, 168, 6)
    node = params.get("node") or None
    vmid = int(params["vmid"]) if params.get("vmid") else None

    if scope == "node" and not is_admin:
        return {
            "error": i18n.pick(
                "节点级指标仅管理员可查看；请改查 guest 并指定 node 与 vmid",
                "Node-level metrics are admin-only; query scope=guest with node and vmid instead",
            )
        }
    if scope == "guest" and (not node or vmid is None):
        return {
            "error": i18n.pick(
                "查虚拟机指标必须同时提供 node 和 vmid",
                "Guest metrics require both node and vmid",
            )
        }

    from . import metrics

    now = int(time.time())
    start = now - hours * 3600
    step = metrics.pick_step(hours * 3600)
    refs = await _owned_vm_refs(username, is_admin) if scope == "guest" else None

    data = await metrics.query(
        scope=scope,
        start=start,
        end=now,
        step=step,
        node=node,
        vmid=vmid,
        owned_refs=refs,
    )

    series: List[Dict[str, Any]] = []
    for item in data.get("series") or []:
        points = item.get("points") or []
        if not points:
            continue
        series.append(
            {
                "node": item.get("node"),
                "vmid": item.get("vmid"),
                "name": item.get("name"),
                "samples": len(points),
                "cpu": _stat([p.get("cpu") for p in points]),
                "mem": _stat([p.get("mem") for p in points]),
                "disk": _stat([p.get("disk") for p in points]),
                "netin": _stat([p.get("netin") for p in points]),
                "netout": _stat([p.get("netout") for p in points]),
                "up_ratio": _stat([p.get("up_ratio") for p in points]),
            }
        )

    return {
        "scope": scope,
        "window_hours": hours,
        "step_seconds": step,
        "from": start,
        "to": now,
        "series": series[:20],
        "truncated": bool(data.get("truncated")),
        "note": i18n.pick(
            "cpu / up_ratio 是 0-1 的比率，mem / disk / net* 是字节或字节/秒；"
            "对比 first 与 last 判断趋势方向。",
            "cpu / up_ratio are 0-1 ratios; mem / disk / net* are bytes or bytes/s. "
            "Compare first and last to read the trend.",
        ),
    }


def _task_vmid(row: Dict[str, Any]) -> str:
    """任务关联的 VMID：PVE 任务的 ``id`` 为纯数字时即为 vmid，否则视为与 VM 无关。"""
    ident = str(row.get("id") or "")
    return ident if NUM_RE.match(ident) else ""


async def recent_changes(
    hours: int = 24, *, username: str = "", is_admin: bool = False
) -> Dict[str, Any]:
    """最近的集群变更记录（启动 / 快照 / 备份 / 迁移 / 克隆…）。

    AI 判断「问题出现前做过什么」的依据（对应工具 ``get_recent_changes``）。
    """
    from .formatters import normalize_task
    from .pve import get_client

    hours = _clamp_int(hours, 1, 720, 24)
    now = int(time.time())
    since = now - hours * 3600

    client = get_client()
    tasks = await client.tasks(limit=300)
    rows = [normalize_task(t) for t in (tasks or [])]
    rows = [row for row in rows if int(row.get("starttime") or 0) >= since]

    if not is_admin:
        mine = await _owned_vm_refs(username, False) or []
        keep: List[Dict[str, Any]] = []
        for row in rows:
            vmid = _task_vmid(row)
            owner_match = bool(vmid) and any(ref.endswith(":" + vmid) for ref in mine)
            user_match = str(row.get("user") or "").split("@")[0] == (username or "")
            if owner_match or user_match:
                keep.append(row)
        rows = keep

    rows.sort(key=lambda item: int(item.get("starttime") or 0), reverse=True)
    return {
        "window_hours": hours,
        "count": len(rows),
        "changes": [
            {
                "time": row.get("starttime"),
                "type": row.get("type"),
                "status": row.get("status"),
                "exitstatus": row.get("exitstatus"),
                "node": row.get("node"),
                "id": row.get("id"),
                "user": row.get("user"),
            }
            for row in rows[:60]
        ],
    }


async def _internal_changes(
    params: Dict[str, str], *, username: str, is_admin: bool
) -> Dict[str, Any]:
    return await recent_changes(
        _clamp_int(params.get("hours"), 1, 720, 24),
        username=username,
        is_admin=is_admin,
    )


async def _internal_related(
    params: Dict[str, str], *, username: str, is_admin: bool
) -> Dict[str, Any]:
    from .pve import get_client

    client = get_client()
    node = params.get("node") or None
    vmid = params.get("vmid") or ""

    nodes = await client.nodes() or []
    resources = await client.cluster_resources("vm") or []
    owned = await _owned_vm_refs(username, is_admin)

    def _visible(row: Dict[str, Any]) -> bool:
        if owned is None:
            return True
        suffix = f":{row.get('node')}:{row.get('vmid')}"
        return any(ref.endswith(suffix) for ref in owned)

    if node is None and vmid:
        hit = next(
            (r for r in resources if str(r.get("vmid")) == vmid and _visible(r)), None
        )
        node = str(hit.get("node")) if hit else None

    if node is None:
        return {
            "nodes": [
                {
                    "node": n.get("node"),
                    "status": n.get("status"),
                    "cpu": n.get("cpu"),
                    "maxcpu": n.get("maxcpu"),
                    "mem": n.get("mem"),
                    "maxmem": n.get("maxmem"),
                    "loadavg": n.get("loadavg"),
                    "uptime": n.get("uptime"),
                }
                for n in nodes
                if isinstance(n, dict)
            ],
            "note": i18n.pick(
                "上面是集群节点概览；带上 node（可选 vmid）再查即可看节点负载、邻居与存储。",
                "Node overview above; call again with node (optionally vmid) for load, neighbours and storage.",
            ),
        }

    node_row = next(
        (n for n in nodes if isinstance(n, dict) and str(n.get("node")) == node), {}
    )
    vms = [
        {
            "vmid": r.get("vmid"),
            "name": r.get("name"),
            "type": r.get("type"),
            "status": r.get("status"),
            "cpu": r.get("cpu"),
            "maxcpu": r.get("maxcpu"),
            "mem": r.get("mem"),
            "maxmem": r.get("maxmem"),
            "disk": r.get("disk"),
            "maxdisk": r.get("maxdisk"),
            "uptime": r.get("uptime"),
        }
        for r in resources
        if str(r.get("node")) == node and _visible(r)
    ]

    storages: List[Dict[str, Any]] = []
    try:
        for st in await client.storages(node) or []:
            if not isinstance(st, dict):
                continue
            storages.append(
                {
                    "storage": st.get("storage"),
                    "type": st.get("type"),
                    "used": st.get("used"),
                    "total": st.get("total"),
                    "avail": st.get("avail"),
                    "active": st.get("active"),
                }
            )
    except Exception as exc:  # noqa: BLE001 - 存储读不到不该让整个工具失败
        logger.warning("AI 关联资源：存储查询失败 %s：%s", node, exc)

    return {
        "node": node,
        "node_status": {
            "status": node_row.get("status"),
            "cpu": node_row.get("cpu"),
            "maxcpu": node_row.get("maxcpu"),
            "mem": node_row.get("mem"),
            "maxmem": node_row.get("maxmem"),
            "loadavg": node_row.get("loadavg"),
            "uptime": node_row.get("uptime"),
        },
        "vm_count": len(vms),
        "vms": vms[:40],
        "storages": storages[:20],
        "note": i18n.pick(
            "vms 已按你的可见范围过滤。",
            "vms are already filtered to what you can see.",
        )
        if owned is not None
        else "",
    }


async def run_internal_tool(
    name: str,
    args: Any = None,
    *,
    host_id: str = "local",
    username: str = "",
    is_admin: bool = False,
) -> Dict[str, Any]:
    """执行一个平台内部数据工具（直接读现有巡检模块，不经命令行）。

    ``args`` 是模型给的具名参数（metrics / changes / related 用得到）；
    其余工具忽略它。权限隔离在这里落地：非管理员只能看到自己名下的虚拟机。
    """
    tool = INTERNAL_TOOL_MAP.get(name)
    if tool is None:
        return {"ok": False, "output": i18n.pick("没有这个工具", "No such tool")}

    try:
        params = validate_params(tool, args)
    except ToolError as exc:
        return {"ok": False, "output": str(exc)}

    runners: Dict[str, Any] = {
        "baseline": lambda: _internal_baseline(host_id),
        "ssh": _internal_ssh,
        "alerts": _internal_alerts,
        "metrics": lambda: _internal_metrics(params, username=username, is_admin=is_admin),
        "changes": lambda: _internal_changes(params, username=username, is_admin=is_admin),
        "related": lambda: _internal_related(params, username=username, is_admin=is_admin),
    }
    runner = runners.get(str(tool.get("handler") or ""))
    if runner is None:
        return {"ok": False, "output": i18n.pick("没有这个工具", "No such tool")}

    try:
        payload = await runner()
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI 内部工具 %s 失败：%s", name, exc)
        return {"ok": False, "output": str(exc)[:300]}

    import json

    return {
        "ok": True,
        "output": _truncate(json.dumps(payload, ensure_ascii=False), MAX_OUTPUT),
    }
