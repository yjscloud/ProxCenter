"""面板多语言：语言协商 + 文案翻译。

前端界面语言存在浏览器（localStorage），请求时通过 ``Accept-Language`` 头带给
后端；后端据此决定**结构性文案**用哪种语言返回：

* 权限目录（创建用户 / 自定义角色时的勾选项）
* 内置角色的名称
* 内置 FAQ 默认值
* 错误消息与自检提示

为什么不用 ``?lang=en`` 查询参数：语言是请求级偏好而不是资源定位的一部分，
而且面板的接口很多（含 WebSocket 子协议握手与静态资源），逐个补参数一定会漏。
放在请求头里则一次覆盖全部路径。

为什么用「中文原文 → 英文」映射而不是给每条文案起 key：
存量文案有上千条，其中权限目录、FAQ、自检项都是**结构化数据**（label/desc/q/a），
把它们全部改成 key 会牵动 schema、数据库与前端契约。用原文当键可以直接在
「返回值出口」包一层 :func:`tr` 完成本地化，改动面小、也天然去重
（各模块里反复出现的「查看」「管理」只维护一份）。

新写的代码建议直接用 :func:`t`（带占位符的消息表），可读性更好。
"""
from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Dict, Iterator, List, Optional, Tuple

logger = logging.getLogger(__name__)

LANG_ZH = "zh-CN"
LANG_EN = "en"
DEFAULT_LANG = LANG_ZH
SUPPORTED = (LANG_ZH, LANG_EN)

# 与 pve.set_request_connection 同样的思路：请求级状态放 ContextVar，
# 每个请求任务各持一份，并发下不会互相覆盖。
_lang: ContextVar[str] = ContextVar("panel_lang", default=DEFAULT_LANG)

# 英文请求下没查到译文、被原样返回的中文文案（每条只告警一次）
_untranslated: set = set()

# 只有含汉字的文本才可能是「漏翻译的文案」：原始配置值（yes / 6 / 99999）与
# 已由 pick() 渲染好的英文都会流经 tr()，对它们告警纯属噪音。
_HAN = re.compile(r"[\u4e00-\u9fa5]")


# --------------------------------------------------------------- 语言协商
def normalize(value: Optional[str]) -> Optional[str]:
    """把一个语言标记归一成受支持的语言码；不认识则返回 None。"""
    if not value:
        return None
    token = value.strip().lower()
    if token.startswith("zh"):
        return LANG_ZH
    if token.startswith("en"):
        return LANG_EN
    return None


def parse_accept_language(header: Optional[str]) -> str:
    """按 RFC 9110 的 q 值挑一个受支持的语言。

    只认前缀（``zh-CN`` / ``zh`` / ``en-US`` → zh / en）：面板只有两种语言，
    没必要把语言区域（region）也纳入匹配。
    """
    if not header:
        return DEFAULT_LANG

    ranked: List[tuple] = []
    for index, part in enumerate(header.split(",")):
        piece = part.strip()
        if not piece:
            continue
        lang, _, params = piece.partition(";")
        quality = 1.0
        for param in params.split(";"):
            key, _, raw = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(raw.strip())
                except ValueError:
                    quality = 0.0
        ranked.append((quality, -index, lang.strip()))

    # q 越大越优先；q 相同时按出现顺序（用 -index 保持稳定）
    for quality, _, lang in sorted(ranked, reverse=True):
        if quality <= 0:
            continue
        matched = normalize(lang) if lang != "*" else None
        if matched:
            return matched
    return DEFAULT_LANG


def set_language(header: Optional[str]) -> None:
    """由中间件在每次请求开始时调用。"""
    _lang.set(parse_accept_language(header))


@contextmanager
def use_language(lang: Optional[str]) -> Iterator[None]:
    """临时切换语言（发邮件、后台任务等没有请求上下文的场景）。

    通知邮件要按**收件人**的语言渲染，而收件人语言存在 user_prefs 里、
    与当前请求的语言无关 —— 这里显式覆盖，退出时还原，不污染同一任务里
    后续的代码。
    """
    token = _lang.set(normalize(lang) or DEFAULT_LANG)
    try:
        yield
    finally:
        _lang.reset(token)


def pin_language(lang: Optional[str]) -> None:
    """设定当前语言且不还原（后台任务 / 按收件人发通知时用）。

    与 :func:`use_language` 的区别：那个是临时覆盖、退出即还原，适合在一小段
    代码里穿插；这里是「接下来整段就按这个语言走」，适合整个后台任务 ——
    任务结束 ContextVar 随之销毁，不会泄漏到下一个任务或下一个请求。
    """
    _lang.set(normalize(lang) or DEFAULT_LANG)


def current_language() -> str:
    return _lang.get()


def is_english() -> bool:
    return _lang.get() == LANG_EN


# ------------------------------------------------------------ 翻译入口
def pick(zh: str, en: str) -> str:
    """按当前语言二选一。"""
    return en if is_english() else zh


def tr(text: Any) -> Any:
    """把一条已有中文文案翻译成当前语言（查不到就原样返回）。

    非字符串（None、数字、结构化对象）原样透传，方便直接包在返回值上。

    译表没命中时会在英文请求下**原样返回中文** —— 这是「页面框架是英文、
    列表却还是中文」的典型来源，所以这里把没命中的文案各记一条 warning，
    照着日志补译表即可（同一条只报一次，不会刷屏）。
    """
    if not isinstance(text, str):
        return text
    if _lang.get() == LANG_ZH:
        return text
    fixed = ZH_EN.get(text)
    if fixed is not None:
        return fixed
    # 后台作业的摘要带数字（如「命中 3 项」），无法用固定表查，走模式匹配
    for pattern, template, names in PATTERNS:
        matched = pattern.match(text)
        if matched:
            return template.format(**dict(zip(names, matched.groups())))
    if _HAN.search(text) and text not in _untranslated:
        _untranslated.add(text)
        logger.warning("i18n: 英文请求下没有对应译文，已原样返回中文：%s", text)
    return text


def tr_all(items: Optional[List[str]]) -> Optional[List[str]]:
    if items is None:
        return None
    return [tr(item) for item in items]


# 带占位符的消息表：新代码用这个写，比拼字符串好翻译。
# 用法：t("error.permission_denied", permission="vm.create")
MESSAGES: Dict[str, Dict[str, str]] = {
    "error.permission_denied": {
        "zh-CN": "权限不足：需要 {permission}",
        "en": "Permission denied: {permission} is required",
    },
    "error.permission_denied_role": {
        "zh-CN": "权限不足：需要 {permission} 权限（当前角色：{role}）",
        "en": "Permission denied: {permission} is required (current role: {role})",
    },
    "error.no_credentials": {
        "zh-CN": "未提供认证凭据",
        "en": "No authentication credentials were provided",
    },
    "error.not_authenticated": {
        "zh-CN": "未登录或登录已失效",
        "en": "Not signed in, or the session has expired",
    },
    "error.job_not_found": {
        "zh-CN": "作业 {job_id} 不存在",
        "en": "Job {job_id} does not exist",
    },
    "error.no_fields_to_update": {
        "zh-CN": "没有需要修改的字段",
        "en": "No fields to update",
    },
    "error.job_running": {
        "zh-CN": "该作业正在执行中",
        "en": "This job is already running",
    },
    # ---- 应急响应：隔离处置 ----
    "isolation.separator": {"zh-CN": "、", "en": ", "},
    "isolation.summary.ok": {"zh-CN": "隔离处置成功", "en": "Isolation completed"},
    "isolation.summary.partial": {
        "zh-CN": "隔离处置部分失败",
        "en": "Isolation partially failed",
    },
    "isolation.summary.detail": {"zh-CN": "（{parts}）", "en": " ({parts})"},
    "isolation.summary.partSep": {"zh-CN": "；", "en": "; "},
    "isolation.summary.done": {"zh-CN": "已完成：{items}", "en": "Done: {items}"},
    "isolation.summary.failed": {"zh-CN": "失败：{items}", "en": "Failed: {items}"},
    "isolation.step.snapshot": {"zh-CN": "取证快照", "en": "Forensic snapshot"},
    "isolation.step.network": {"zh-CN": "切断网络", "en": "Cut network"},
    "isolation.step.power": {"zh-CN": "电源动作", "en": "Power action"},
    "isolation.step.protect": {"zh-CN": "开启保护", "en": "Enable protection"},
    "isolation.failed_item": {"zh-CN": "{key}（{error}）", "en": "{key} ({error})"},
    "isolation.detail.snapshotOk": {
        "zh-CN": "已创建取证快照 {name}（崩溃一致性，不含内存镜像）",
        "en": "Forensic snapshot {name} created (crash-consistent, no memory image)",
    },
    "isolation.detail.snapshotFail": {
        "zh-CN": "取证快照失败（不影响后续隔离）：{error}",
        "en": "Forensic snapshot failed (isolation continues): {error}",
    },
    "isolation.detail.noNics": {
        "zh-CN": "这台虚拟机没有虚拟网卡（net*），未做断网",
        "en": "This VM has no virtual NIC (net*); the network was left untouched",
    },
    "isolation.detail.networkPartial": {
        "zh-CN": "已断网 {count} 张网卡；失败：{failures}",
        "en": "{count} NIC(s) cut; failures: {failures}",
    },
    "isolation.detail.networkOk": {
        "zh-CN": "已切断 {count} 张虚拟网卡（{list}）。注意：PCI 直通 / SR-IOV 网卡不受此控制，需要另行在交换机侧隔离",
        "en": "{count} virtual NIC(s) cut ({list}). Note: PCI passthrough / SR-IOV NICs are unaffected and must be isolated at the switch",
    },
    "isolation.detail.shutdown": {
        "zh-CN": "已下发优雅关机",
        "en": "Graceful shutdown requested",
    },
    "isolation.detail.stop": {
        "zh-CN": "已下发强制关机（可能丢失未落盘数据）",
        "en": "Forced power off requested (unsaved data may be lost)",
    },
    "isolation.detail.powerFail": {
        "zh-CN": "电源操作失败：{error}",
        "en": "Power action failed: {error}",
    },
    "isolation.detail.protectOk": {
        "zh-CN": "已开启虚拟机保护（禁止误删，需手动解除）",
        "en": "VM protection enabled (blocks accidental deletion; release it manually)",
    },
    "isolation.detail.protectFail": {
        "zh-CN": "开启虚拟机保护失败：{error}",
        "en": "Failed to enable VM protection: {error}",
    },
    "isolation.detail.restoreFail": {
        "zh-CN": "恢复网卡失败：{failures}",
        "en": "Failed to restore NICs: {failures}",
    },
    "isolation.detail.restoreOk": {
        "zh-CN": "已恢复 {count} 张网卡{list}",
        "en": "Restored {count} NIC(s){list}",
    },
    "isolation.detail.restoreList": {"zh-CN": "（{list}）", "en": " ({list})"},
    "isolation.detail.restoreNone": {
        "zh-CN": "（本来就没有被切断）",
        "en": " (none were cut in the first place)",
    },
    "isolation.detail.unprotectOk": {
        "zh-CN": "已解除虚拟机保护",
        "en": "VM protection released",
    },
    "isolation.detail.unprotectFail": {
        "zh-CN": "解除保护失败：{error}",
        "en": "Failed to release VM protection: {error}",
    },
    "isolation.detail.startOk": {"zh-CN": "已下发开机", "en": "Power on requested"},
    "isolation.detail.startFail": {"zh-CN": "开机失败：{error}", "en": "Failed to power on: {error}"},
    "isolation.detail.readConfigFail": {
        "zh-CN": "读取虚拟机配置失败：{error}",
        "en": "Could not read the VM configuration: {error}",
    },
    # ---- SSH 安全：日志来源与 fail2ban 提示 ----
    "ssh.logUnreadable": {
        "zh-CN": "日志文件存在但当前用户读不到（需要 root）",
        "en": "The log file exists but the current user cannot read it (root required)",
    },
    "ssh.usingJournald": {
        "zh-CN": "未找到 auth.log / secure，改用 journald",
        "en": "No auth.log / secure found; falling back to journald",
    },
    "ssh.noLogSource": {
        "zh-CN": "{host} 上既没有 /var/log/secure、/var/log/auth.log，也没有 journalctl",
        "en": "{host} has neither /var/log/secure nor /var/log/auth.log, and no journalctl",
    },
    "ssh.f2bMissingLocal": {
        "zh-CN": "面板在 {host}（本机）上没找到 fail2ban-client：查过 PATH 与 {paths}。"
        "注意面板只看得到**自己所在主机**的 fail2ban —— 装在别的机器（比如 PVE 节点）上，"
        "这里不会显示。本机安装：Debian/Ubuntu 用 apt install fail2ban；"
        "RHEL/CentOS 用 yum install epel-release && yum install fail2ban；"
        "装好后确认 [sshd] jail 是启用的（RHEL 默认关闭）并 systemctl enable --now fail2ban。",
        "en": "The panel could not find fail2ban-client on {host} (its own host): it checked "
        "PATH and {paths}. Note that the panel can only see the fail2ban running on "
        "**its own host** — one installed elsewhere (a PVE node, say) will not show up here. "
        "To install it here: apt install fail2ban on Debian/Ubuntu; "
        "yum install epel-release && yum install fail2ban on RHEL/CentOS; then make sure the "
        "[sshd] jail is enabled (off by default on RHEL) and run systemctl enable --now fail2ban.",
    },
    "ssh.f2bNotRunning": {
        "zh-CN": "fail2ban 已安装（{binary}）但服务没在跑：systemctl enable --now fail2ban。{output}",
        "en": "fail2ban is installed ({binary}) but the service is not running: "
        "systemctl enable --now fail2ban. {output}",
    },
    "ssh.f2bWrapOutput": {"zh-CN": "（{output}）", "en": "({output})"},
    "ssh.f2bNoJail": {
        "zh-CN": "fail2ban 在跑，但一个 jail 都没启用：在 /etc/fail2ban/jail.local 里加上"
        " [sshd]\nenabled = true\n然后 systemctl reload fail2ban（RHEL 的 sshd jail 默认是关的）。",
        "en": "fail2ban is running but no jail is enabled: add [sshd]\n"
        "enabled = true\nto /etc/fail2ban/jail.local and run systemctl reload fail2ban "
        "(the sshd jail is off by default on RHEL).",
    },
    "ssh.remoteF2bFail": {
        "zh-CN": "远程主机上执行 fail2ban-client 失败：{output}",
        "en": "fail2ban-client failed on the remote host: {output}",
    },
    "ssh.noLocalLog": {"zh-CN": "本机日志不可用", "en": "Panel host logs unavailable"},
}


def t(key: str, **variables: Any) -> str:
    """按当前语言取消息并替换 ``{placeholder}``。"""
    entry = MESSAGES.get(key)
    if entry is None:
        logger.warning("i18n 缺少消息：%s", key)
        return key
    template = entry.get(current_language()) or entry.get(LANG_ZH, key)
    if not variables:
        return template
    try:
        return template.format(**variables)
    except (KeyError, IndexError):
        # 占位符对不上时宁可露出模板，也不要让整个请求 500
        logger.warning("i18n 占位符不匹配：%s %s", key, variables)
        return template


# 带数字的运行时摘要（后台作业的执行结果，见 main.py 的 summarize 回调）：
# 形如「命中 3 项」，数量不定，无法用固定表查，这里用正则抽出数字再套英文模板。
# 只在英文时走这条路；每条都是 (正则, 英文模板, 捕获组名顺序)。
PATTERNS: List[Tuple["re.Pattern[str]", str, Tuple[str, ...]]] = [
    (re.compile(r"^命中 (\d+) 项$"), "{n} hits", ("n",)),
    (re.compile(r"^处理 (\d+) 项$"), "{n} processed", ("n",)),
    (re.compile(r"^导入 (\d+) 条$"), "{n} imported", ("n",)),
    (re.compile(r"^落库 (\d+) 个点$"), "{n} points stored", ("n",)),
    (re.compile(r"^退避中（已连续失败 (\d+) 次）$"), "Backing off ({n} consecutive failures)", ("n",)),
    (re.compile(r"^清理 (\d+) 行$"), "{n} rows purged", ("n",)),
    (re.compile(r"^清理 (\d+) 台已删除主机$"), "{n} deleted hosts purged", ("n",)),
    (re.compile(r"^续期 (\d+) 张、失败 (\d+) 张$"), "{n} renewed, {m} failed", ("n", "m")),
    (re.compile(r"^续期 (\d+) 张$"), "{n} renewed", ("n",)),
    (re.compile(r"^(\d+) 项$"), "{n} items", ("n",)),
]


# ------------------------------------------------- 中文原文 → 英文对照表
# 说明：权限目录 / FAQ / 内置角色里的文案都用中文原文当键。同一条中文在多处
# 出现（如各模块的「查看」）只需维护一份。
ZH_EN: Dict[str, str] = {
    # ---- 权限目录：模块名 ----
    "虚拟机": "Virtual machines",
    "模板": "Templates",
    "存储": "Storage",
    "网络": "Network",
    "防火墙": "Firewall",
    "节点": "Nodes",
    "任务": "Tasks",
    "内网穿透": "Tunnels",
    "监控告警": "Monitoring & alerts",
    "证书": "Certificates",
    "SSH 安全": "SSH security",
    "安全基线": "Security baseline",
    "端口与进程": "Ports & processes",
    "用户与角色": "Users & roles",
    "系统设置": "Settings",
    "审计日志": "Audit log",
    # ---- 权限目录：通用动作 ----
    "查看": "View",
    "创建": "Create",
    "删除": "Delete",
    "指派归属": "Assign owner",
    "电源操作": "Power operations",
    "控制台": "Console",
    "修改配置": "Change configuration",
    "快照": "Snapshots",
    "备份": "Backups",
    "克隆": "Clone",
    "应急隔离": "Emergency isolation",
    "克隆模板": "Clone template",
    "管理模板": "Manage templates",
    "管理": "Manage",
    "集群级": "Cluster-wide",
    "管理规则": "Manage rules",
    "加固": "Harden",
    "巡检": "Inspect",
    # ---- 权限目录：说明 ----
    "查看自己名下的虚拟机": "View the virtual machines you own",
    "新建虚拟机": "Create virtual machines",
    "删除自己创建的虚拟机": "Delete the virtual machines you created",
    "把虚拟机指派给指定用户（含存量无主机）":
        "Assign a virtual machine to a user (including ones with no owner)",
    "开机 / 关机 / 重启 / 挂起": "Start / shut down / reboot / suspend",
    "打开 VNC 控制台": "Open the VNC console",
    "改 CPU / 内存 / 磁盘 / 网卡 / 迁移":
        "Change CPU / memory / disks / NICs, migrate",
    "创建 / 回滚 / 删除快照": "Create / roll back / delete snapshots",
    "备份与恢复": "Back up and restore",
    "从模板或虚拟机克隆": "Clone from a template or a virtual machine",
    "一键隔离可疑虚拟机（取证快照 + 断网 + 关机）与解除隔离":
        "Isolate a suspicious VM in one click (forensic snapshot + link down + power off) and release it",
    "查看模板列表": "View the template list",
    "用模板创建虚拟机": "Create virtual machines from a template",
    "制作 / 删除 / 导入模板": "Build / delete / import templates",
    "查看存储池与内容": "View storage pools and their contents",
    "上传 ISO / 删除卷": "Upload ISOs / delete volumes",
    "查看宿主机网络与虚拟机网卡": "View host networks and VM NICs",
    "改宿主机网桥 / 网卡": "Change host bridges / NICs",
    "查看集群 / 节点 / 虚拟机的防火墙规则、安全组与选项":
        "View firewall rules, security groups and options for the cluster, nodes and VMs",
    "改自己名下虚拟机的规则、安全组规则与 IP 集合条目、下发模板":
        "Edit rules and security-group rules of VMs you own, IP set entries, and apply templates",
    "改集群级规则与默认策略、建删安全组 / IP 集合（影响所有主机）":
        "Edit cluster-wide rules and default policy, create or delete security groups / IP sets (affects every host)",
    "查看节点状态与监控": "View node status and monitoring",
    "查看任务队列与日志": "View the task queue and logs",
    "取消 / 清理任务": "Cancel / clear tasks",
    "查看穿透配置与日志": "View tunnel configuration and logs",
    "新增 / 修改自己的穿透规则": "Add / edit your own tunnel rules",
    "查看自己的告警规则与历史": "View your alert rules and history",
    "配置自己的规则与通知": "Configure your own rules and notifications",
    "查看自己的证书与续期状态": "View your certificates and renewal status",
    "申请 / 部署 / 续期自己的证书": "Issue / deploy / renew your own certificates",
    "查看 SSH 登录失败统计与 fail2ban。默认仅管理员：面板本机与别人的受管主机都不对普通用户开放，授予后只看到自己添加的主机":
        "View SSH login failures and fail2ban. Administrators only by default: neither the panel host nor other people's managed hosts are exposed to regular users; once granted, a user only sees the hosts they added",
    "封禁 / 解封 IP、调整封禁与异常登录告警策略":
        "Ban / unban IPs, tune ban and anomalous-login alert policies",
    "查看基线体检报告与评分。默认仅管理员：授予后普通用户只看到自己添加的主机，面板本机不开放":
        "View baseline reports and scores. Administrators only by default: once granted, a regular user only sees the hosts they added, and the panel host stays closed",
    "一键修复 SSH / 内核参数 / 口令策略等基线项（改动面板所在主机）":
        "Fix baseline items such as SSH / kernel parameters / password policy in one click (modifies the panel host)",
    "查看监听端口与可疑进程清单。默认仅管理员：授予后普通用户只看到自己添加的主机，面板本机不开放":
        "View listening ports and suspicious processes. Administrators only by default: once granted, a regular user only sees the hosts they added, and the panel host stays closed",
    "配置巡检策略（预期端口 / 进程白名单）与立即巡检推送告警":
        "Configure inspection policy (expected ports / process allowlist) and run an inspection with alerts",
    "查看用户与角色": "View users and roles",
    "增删改用户与角色": "Create, edit and delete users and roles",
    "Proxmox 连接配置、节点备注等": "Proxmox connection settings, node notes, and more",
    "查看操作审计日志": "View the operation audit log",
    # ---- 内置角色 ----
    "超级管理员": "Super administrator",
    "普通用户": "Standard user",
    "只读用户": "Read-only user",
    "超级管理员：可见并管理全部资源（不受用户隔离限制），可管理用户、连接配置与宿主机网络。":
        "Super administrator: can see and manage every resource without per-user isolation, "
        "including users, connection settings and the host network.",
    "普通用户：可创建、开关机、控制台、快照、备份、克隆，并删除「自己创建」的虚拟机；"
    "只能看到自己名下的虚拟机，不能管理用户、连接配置或宿主机网络。":
        "Standard user: can create virtual machines, power them on and off, use the console, "
        "snapshots, backups and clones, and delete the VMs they created themselves; "
        "they only see their own virtual machines and cannot manage users, connection settings "
        "or the host network.",
    "只读用户：仅可查看自己名下的资源、监控与任务，不能执行任何变更操作。":
        "Read-only user: can only view their own resources, monitoring and tasks, and cannot "
        "perform any operation that changes state.",
    # ---- 内置 FAQ ----
    "需要把 Proxmox 暴露到公网吗？": "Does Proxmox need to be exposed to the internet?",
    "不需要。面板在内网通过 Proxmox API（默认 8006）访问集群，只有面板自身需要对外提供访问入口。":
        "No. The panel reaches the cluster over the internal network through the Proxmox API "
        "(port 8006 by default); only the panel itself needs to accept inbound connections.",
    "为什么浏览器控制台还需要额外填一个 Proxmox 账号？":
        "Why does the in-browser console need another Proxmox account?",
    "Proxmox 不允许 API Token 调用 vncproxy，控制台只认用户名密码换取的 ticket。该功能可选，不填不影响其它功能。":
        "Proxmox does not allow an API token to call vncproxy — the console only accepts a ticket "
        "derived from a username and password. The feature is optional; leaving it empty affects nothing else.",
    "SSL 证书「自动续期」是怎么工作的？": "How does automatic SSL certificate renewal work?",
    "以腾讯云免费 DV 证书为例：证书有效期 90 天，面板会按你设定的天数（默认到期前 15 天）自动提交续期申请，等 CA 签发成功后自动下载并重新部署到目标机器，最后执行你配置的重载命令（如 nginx -s reload）。":
        "Taking a free Tencent Cloud DV certificate as an example: certificates are valid for 90 days. "
        "The panel submits the renewal automatically N days before expiry (15 by default), downloads the "
        "new certificate once the CA issues it, redeploys it to the target host, and finally runs the reload "
        "command you configured (for example nginx -s reload).",
    "飞书机器人需要公网回调吗？会不会被人乱操作？":
        "Does the Feishu bot need a public callback? Can anyone misuse it?",
    "需要：机器人通过飞书开放平台的事件回调访问面板，回调地址必须能被飞书访问到（内网部署可用反向代理或内网穿透）。安全上做了两层限制：一是必须配置群会话或用户白名单，名单外的消息一律拒绝；二是关机、重启、回滚这类危险操作会先弹确认卡片，点确认才执行，全过程写入审计日志。":
        "Yes. The bot reaches the panel through the Feishu open platform's event callback, so the callback "
        "URL must be reachable from Feishu (use a reverse proxy or a tunnel for internal deployments). Two "
        "layers of protection are in place: a chat or user allowlist that rejects everyone else, and a "
        "confirmation card for destructive actions such as shutdown, reboot and rollback — nothing runs "
        "until it is confirmed, and everything is written to the audit log.",
    # ---- 飞书机器人：可用指令（配置页表格） ----
    "列表": "List",
    "查看虚拟机总览": "Show the virtual machine overview",
    "状态 <名称/ID>": "Status <name/ID>",
    "查看单台虚拟机": "Show a single virtual machine",
    "开机 <名称/ID>": "Start <name/ID>",
    "开机": "Start",
    "关机 <名称/ID>": "Shutdown <name/ID>",
    "关机": "Shut down",
    "关机（卡片确认）": "Shut down (card confirmation)",
    "重启 <名称/ID>": "Reboot <name/ID>",
    "重启": "Reboot",
    "重启（卡片确认）": "Reboot (card confirmation)",
    "弹出表单，可指定名称 / CPU / 内存 / 磁盘":
        "Open a form to set the name / CPU / memory / disk",
    "快照 <名称/ID> [快照名]": "Snapshot <name/ID> [snapshot name]",
    "创建快照，省略名称时自动按时间命名":
        "Create a snapshot; when the name is omitted it is named by timestamp",
    "快照列表 <名称/ID>": "Snapshots <name/ID>",
    "查看已有快照": "List existing snapshots",
    "回滚 <名称/ID> <快照名>": "Rollback <name/ID> <snapshot name>",
    "回滚到快照（卡片确认）": "Roll back to a snapshot (card confirmation)",
    "备份 <名称/ID> [存储]": "Backup <name/ID> [storage]",
    "立即执行一次备份": "Run a backup right now",
    "帮助": "Help",
    "显示指令列表": "Show the command list",
    # ---- 后台作业：分组 ----
    "安全巡检": "Security inspection",
    "监控与证书": "Monitoring & certificates",
    "服务看护": "Service watchdog",
    "数据清理": "Data cleanup",
    # ---- 后台作业：名称 ----
    "资源告警巡检": "Resource alert inspection",
    "SSH 登录安全": "SSH login security",
    "受管主机 SSH 巡检": "Managed host SSH inspection",
    "端口与进程巡检": "Port & process inspection",
    "备份完整性核对": "Backup integrity check",
    "主机登录审计导入": "Host login audit import",
    "监控历史采样": "Metrics history sampling",
    "证书状态同步与续期": "Certificate sync & renewal",
    "内网穿透看护": "Tunnel watchdog",
    "受管主机核对": "Managed host reconciliation",
    "监控历史保留清理": "Metrics history retention purge",
    "站内通知保留清理": "Notification retention purge",
    "API Token 残留清理": "API token residue purge",
    # ---- 后台作业：说明 ----
    "按阈值评估节点与虚拟机的 CPU / 内存 / 存储，命中规则即告警":
        "Evaluate node and VM CPU / memory / storage against thresholds and alert on matches",
    "检查本机的失败登录、爆破与异常来源，命中即告警":
        "Check the panel host for failed logins, brute force and unusual sources, alerting on matches",
    "遍历已登记的受管主机，检查其 SSH 登录异常与策略偏移":
        "Walk the registered managed hosts to spot SSH login anomalies and policy drift",
    "扫描监听端口与关键进程，发现新增对外暴露的服务":
        "Scan listening ports and key processes to spot newly exposed services",
    "核对受保护备份是否仍然存在且未被篡改（防删 / 防篡改）":
        "Verify protected backups still exist and are untampered (anti-delete / anti-tamper)",
    "把各主机的 SSH 登录 / sudo 事件增量汇入面板审计日志":
        "Import new SSH login / sudo events from each host into the panel audit log",
    "把节点与虚拟机的资源指标按周期采样进 metrics_history（实时那条走 WebSocket）":
        "Sample node and VM metrics into metrics_history on a schedule (the live one goes over WebSocket)",
    "同步网站证书状态并自动续期（免费证书只有 90 天）":
        "Sync website certificate status and renew automatically (free certificates last only 90 days)",
    "frpc 进程不在时自动拉起（仅在「自动拉起」开启时生效）":
        "Restart frpc when the process is gone (only when auto-restart is enabled)",
    "按 METRICS_RETENTION_DAYS 清理超期的指标采样行":
        "Purge metrics sample rows older than METRICS_RETENTION_DAYS",
    "核对「面板下发」的受管主机与 PVE 上的虚拟机是否一致，清掉已删除机器留下的安全数据":
        "Reconcile panel-provisioned managed hosts against PVE VMs and drop the security data "
        "left behind by deleted machines",
    "清理已读且超期的站内消息": "Purge read notifications past their retention",
    "清理过期 / 已吊销超过 30 天的 API Token 记录":
        "Purge API tokens expired or revoked more than 30 days ago",
    # ---- 后台作业：无数字的固定摘要 ----
    "无变化": "No change",
    "无新增": "Nothing new",
    "本轮无数据": "No data this round",
    "检测到 frpc 已停止，已自动拉起": "frpc was down and has been restarted",
    "未开启自动拉起": "Auto-restart is off",
    "frpc 运行中": "frpc is running",
    "无需清理": "Nothing to purge",
    "无需续期": "Nothing to renew",
    # ---- SSH 安全：指纹确认结果 ----
    "没能从这台主机取到 SSH 指纹：请确认地址、端口与 SSH 服务正常后重试":
        "Could not fetch the SSH fingerprint from this host: check the address, port and SSH service, then try again",
    "已记录主机指纹": "Host fingerprint recorded",
    # ---- 应急响应：处置能力边界（隔离结果里的 caveats） ----
    "快照是崩溃一致性的磁盘副本，无法提取内存镜像；对运行中的机器做快照不等于内存取证。":
        "A snapshot is a crash-consistent disk copy and cannot capture a memory image; snapshotting a running machine is not memory forensics.",
    "link_down 只切断 PVE 的虚拟网卡，PCI 直通 / SR-IOV 网卡不受控制，需要在交换机侧另行隔离。":
        "link_down only cuts the PVE virtual NICs; PCI passthrough / SR-IOV NICs are unaffected and must be isolated separately at the switch.",
    "隔离不会清除入侵痕迹，但后续对这台机器做快照回滚会覆盖当前磁盘状态 —— 取证与回滚在目标上冲突，请先保留证据。":
        "Isolation does not erase intrusion traces, but a later snapshot rollback of this machine will overwrite the current disk state — forensics and rollback conflict on the same target, so preserve the evidence first.",
    # ---- 安全基线：分类 ----
    "SSH 服务": "SSH service",
    "密码策略": "Password policy",
    "时间同步": "Time sync",
    "账号安全": "Account security",
    "内核参数": "Kernel parameters",
    # ---- 安全基线：评级与状态 ----
    "优秀": "Excellent",
    "良好": "Good",
    "一般": "Fair",
    "较差": "Poor",
    "未体检": "Not scanned",
    "待改进": "Needs improvement",
    "不合格": "Fail",
    "无法检测": "Unknown",
    # ---- 安全基线：检查项名称 ----
    "SSH 禁止 root 直接登录": "No direct root login over SSH",
    "SSH 关闭口令认证": "SSH password authentication disabled",
    "SSH 禁止空口令登录": "SSH empty passwords rejected",
    "SSH 限制认证重试次数": "SSH authentication retries limited",
    "SSH 关闭 X11 转发": "SSH X11 forwarding disabled",
    "口令有效期上限": "Maximum password age",
    "口令最小长度": "Minimum password length",
    "启用口令复杂度校验（PAM）": "Password complexity checks enabled (PAM)",
    "启用登录失败锁定（PAM）": "Login failure lockout enabled (PAM)",
    "主机防火墙已启用": "Host firewall enabled",
    "系统时间同步正常": "System time is synchronized",
    "无空口令账号": "No accounts with empty passwords",
    "无额外 UID 0 账号": "No extra UID 0 accounts",
    "内核 ASLR 已开启": "Kernel ASLR enabled",
    "启用 SYN cookies": "SYN cookies enabled",
    "启用反向路径过滤": "Reverse path filtering enabled",
    "忽略 ICMP 重定向": "ICMP redirects ignored",
    "拒绝源路由包": "Source-routed packets rejected",
    "限制 dmesg 访问": "dmesg access restricted",
    "隐藏内核指针": "Kernel pointers hidden",
    # ---- 安全基线：检查项结论（detail）----
    "未显式配置 PermitRootLogin（将按 SSH 默认值处理）": "PermitRootLogin is not set explicitly (the SSH default applies)",
    "已禁止 root 用口令直接登录": "Root password login is disabled",
    "已完全禁止 root 登录": "Root login is fully disabled",
    "允许 root 直接登录（可被暴力破解 / 撞库）": "Root may log in directly (exposed to brute force / credential stuffing)",
    "只允许密钥登录，暴力破解无从下手": "Key-only login; brute force has nothing to work with",
    "仍允许口令登录，是暴力破解的主要入口": "Password login is still allowed — the main entry point for brute force",
    "（如依赖密钥登录请忽略本项）": " (ignore this item if you rely on key-based login)",
    "已拒绝空口令账号登录": "Accounts with empty passwords are rejected",
    "允许空口令登录，等于给没有口令的账号开了后门": "Empty-password login is allowed, opening a back door for passwordless accounts",
    "SSH 默认即为 no": "The SSH default is already no",
    "单次连接最多尝试次数受限": "Authentication attempts per connection are limited",
    "已关闭非必需的 X11 转发": "Unnecessary X11 forwarding is disabled",
    "X11 转发存在已知风险，服务器通常不需要": "X11 forwarding has known risks and servers rarely need it",
    "口令几乎不会过期（PASS_MAX_DAYS 未设置或过大）": "Passwords practically never expire (PASS_MAX_DAYS unset or too large)",
    "读不到 /etc/login.defs（需要 root 权限）": "Cannot read /etc/login.defs (root is required)",
    "读不到 /etc/passwd": "Cannot read /etc/passwd",
    "读不到 /etc/shadow（需要 root 权限），无法判断是否存在空口令账号": "Cannot read /etc/shadow (root is required); empty-password accounts cannot be determined",
    "口令复杂度模块会拒绝「字典词 + 纯数字」这类口令": "The complexity module rejects passwords such as “dictionary word + digits”",
    "PAM 里没有口令复杂度模块，弱口令可以随便设": "PAM has no password complexity module, so weak passwords are accepted",
    "连续失败会被临时锁定，显著拖慢暴力破解": "Repeated failures trigger a temporary lockout, greatly slowing brute force",
    "没有失败锁定，攻击者可以一直试口令": "No failure lockout, so an attacker can keep guessing passwords",
    "未发现空口令且可登录的账号": "No login-capable account has an empty password",
    "只有 root 拥有 UID 0": "Only root has UID 0",
    "（权限不足，无法完整探测，结果仅供参考）": " (insufficient privileges; the result is indicative only)",
    "地址空间随机化（ASLR）加大内存攻击的难度": "Address space randomization (ASLR) makes memory attacks harder",
    "SYN cookies 用于抵御 SYN Flood 拒绝服务攻击": "SYN cookies defend against SYN flood denial-of-service attacks",
    "rp_filter 丢弃源地址不可能从该网卡到达的包，防 IP 欺骗": "rp_filter drops packets whose source address cannot arrive on that interface, preventing IP spoofing",
    "接受 ICMP 重定向可能被用来篡改路由表": "Accepting ICMP redirects can be used to tamper with the routing table",
    "源路由允许发送方指定路径，常被用于绕过网络控制": "Source routing lets the sender choose the path and is often used to bypass network controls",
    "非特权用户不应能读取内核日志（可能泄露地址与设备信息）": "Unprivileged users should not be able to read the kernel log (it may leak addresses and device details)",
    "隐藏 /proc 中的内核符号地址，抬高本地提权的门槛": "Hides kernel symbol addresses in /proc, raising the bar for local privilege escalation",
    # ---- 安全基线：实测值 / 期望值 ----
    "未配置": "Not set",
    "未配置（默认 no）": "Not set (default no)",
    "未配置（默认 yes）": "Not set (default yes)",
    "无法读取": "Unreadable",
    "无法读取 /etc/login.defs": "Cannot read /etc/login.defs",
    "无法读取 /etc/passwd": "Cannot read /etc/passwd",
    "无法读取 /etc/shadow": "Cannot read /etc/shadow",
    "已启用": "Enabled",
    "未启用": "Not enabled",
    "未检测到": "Not detected",
    "未检测到 pam_pwquality / pam_cracklib": "pam_pwquality / pam_cracklib not detected",
    "未检测到 pam_faillock / pam_tally2": "pam_faillock / pam_tally2 not detected",
    "无": "None",
    "no 或 prohibit-password": "no or prohibit-password",
    "≤ 90 天": "≤ 90 days",
    "≥ 8 位": "≥ 8 characters",
    "启用 pam_pwquality": "Enable pam_pwquality",
    "启用 pam_faillock": "Enable pam_faillock",
    "存在活动的防火墙": "An active firewall exists",
    "没有可登录的空口令账号": "No login-capable account with an empty password",
    "除 root 外没有 UID 0 账号": "No UID 0 account other than root",
    "chrony / timesyncd / ntp 处于活动状态": "chrony / timesyncd / ntp is active",
    "sshd -T（生效配置）": "sshd -T (effective configuration)",
    "配置文件": "Configuration file",
    "配置文件（/etc/ssh/sshd_config 及其 include，未展开默认值）": "Configuration file (/etc/ssh/sshd_config and its includes; defaults not expanded)",
    "配置文件（需 root 权限才能读到展开后的默认值）": "Configuration file (root is required to read the expanded defaults)",
    # ---- 安全基线：加固建议（hint）----
    "Root 是攻击者唯一确定的用户名。改为 prohibit-password 既保留密钥登录，又堵死口令爆破。数据来源：":
        "Root is the one username an attacker is certain of. Setting prohibit-password keeps key-based login while blocking password brute force. Data source: ",
    "确认所有能登录的账号都已配置密钥后，把 PasswordAuthentication 设为 no。改之前务必备份好密钥，否则会把自己关在门外。":
        "Once every login-capable account has a key, set PasswordAuthentication to no. Back up your keys first, or you may lock yourself out.",
    "设为 no。": "Set it to no.",
    "设为 MaxAuthTries 4。": "Set MaxAuthTries to 4.",
    "如在 /etc/ssh/sshd_config 里把 X11Forwarding 设为 no 可减少攻击面。":
        "Setting X11Forwarding to no in /etc/ssh/sshd_config reduces the attack surface.",
    "确认无误后设为 no。": "Set it to no once verified.",
    "在 /etc/login.defs 里设置 PASS_MAX_DAYS 90（只对新建用户生效，已有账号需用 chage -M 90 <用户> 逐个调整）。":
        "Set PASS_MAX_DAYS 90 in /etc/login.defs (it applies to new users only; adjust existing accounts one by one with chage -M 90 <user>).",
    "在 /etc/login.defs 里设置 PASS_MIN_LEN 8（PAM 强度模块启用时以它为准）。":
        "Set PASS_MIN_LEN 8 in /etc/login.defs (when a PAM strength module is enabled, that module takes precedence).",
    "Debian/Ubuntu：apt install libpam-pwquality 后在 /etc/pam.d/common-password 加上 pam_pwquality.so；RHEL：在 /etc/pam.d/password-auth 与 system-auth 里确认 pam_pwquality.so 已启用。":
        "Debian/Ubuntu: install libpam-pwquality with apt, then add pam_pwquality.so to /etc/pam.d/common-password; RHEL: make sure pam_pwquality.so is enabled in /etc/pam.d/password-auth and system-auth.",
    "RHEL 系：authselect enable-feature with-faillock（或手工在 /etc/pam.d/system-auth 加 pam_faillock.so）；Debian/Ubuntu：设置 /etc/security/faillock.conf 的 deny 并在 common-auth 引入 pam_faillock.so。":
        "RHEL family: run authselect enable-feature with-faillock (or add pam_faillock.so to /etc/pam.d/system-auth manually); Debian/Ubuntu: set deny in /etc/security/faillock.conf and include pam_faillock.so in common-auth.",
    "这台主机没有活动的防火墙，暴露的端口可被直接访问。Proxmox 宿主可用内置的pve-firewall（在面板的「防火墙」页里配置），普通主机可启用 ufw / firewalld 并只放行必要端口。注意：启用前务必先放行 SSH 端口，否则会把自己关在门外。":
        "This host has no active firewall, so exposed ports are directly reachable. Proxmox hosts can use the built-in pve-firewall (configured on the panel’s Firewall page); ordinary hosts can enable ufw / firewalld and allow only the necessary ports. Note: allow the SSH port before enabling it, or you will lock yourself out.",
    "时间不同步会让日志时间错乱、TLS 校验失败、集群节点间凭据失效。执行 timedatectl set-ntp true 即可。":
        "Unsynchronized time scrambles log timestamps, breaks TLS validation and invalidates credentials between cluster nodes. Run timedatectl set-ntp true to fix it.",
    "这些账号无需口令即可登录，应立即锁定（passwd -l <用户>）或设置强口令。":
        "These accounts can be signed into without a password. Lock them immediately (passwd -l <user>) or set a strong password.",
    "若非刻意设置，删除或改掉这些账号的 UID；这类账号常被用作持久化后门。":
        "Unless this was deliberate, remove or change the UID of these accounts; they are a common persistence back door.",
    # ---- 安全基线：探测结论 ----
    "nft list ruleset 中有规则": "nft list ruleset contains rules",
    "iptables 中存在规则或默认拒绝策略": "iptables has rules or a default deny policy",
    "iptables 只有默认 ACCEPT 策略，未配置规则": "iptables only has the default ACCEPT policy and no rules",
    "未检测到活动的防火墙（ufw / firewalld / nftables / iptables / pve-firewall）":
        "No active firewall detected (ufw / firewalld / nftables / iptables / pve-firewall)",
    "没有找到正在运行的时间同步服务": "No running time synchronization service was found",
    # ---- 安全基线：加固结果与失败原因 ----
    "修改 SSH 配置": "Modify the SSH configuration",
    "修改口令策略": "Modify the password policy",
    "修改内核参数": "Modify kernel parameters",
    "启用时间同步": "Enable time synchronization",
    "锁定空口令账号": "Lock accounts with empty passwords",
    "已写入": "Written",
    "已应用": "Applied",
    "已写入并生效，": "Written and in effect, ",
    "已执行 timedatectl set-ntp true": "Ran timedatectl set-ntp true",
    "没有 timedatectl": "timedatectl is not available",
    "已启用 systemd-timesyncd": "systemd-timesyncd enabled",
    "没有需要处理的空口令账号": "No empty-password account needs handling",
    "已锁定账号：": "Locked accounts: ",
    "写入成功但 sysctl 应用失败：": "The write succeeded, but applying sysctl failed: ",
    "内核参数未按预期生效：": "Kernel parameters did not take effect as expected: ",
    "远程内核参数未按预期生效：": "Remote kernel parameters did not take effect as expected: ",
    "启用时间同步失败：": "Failed to enable time synchronization: ",
    "无法启用时间同步：": "Cannot enable time synchronization: ",
    "没有找到 sshd 可执行文件，无法校验配置": "The sshd binary was not found; the configuration cannot be validated",
    "远程主机上找不到 sshd 可执行文件，无法校验配置": "The sshd binary was not found on the remote host; the configuration cannot be validated",
    "（未能自动重载，请手动 systemctl reload sshd）": " (automatic reload failed; run systemctl reload sshd manually)",
    "（未能自动重载，请手动 reload sshd）": " (automatic reload failed; run reload sshd manually)",
    "sshd 配置校验失败，已回滚：": "sshd configuration validation failed; changes were rolled back: ",
    "写入成功但设置未生效：主配置可能没有 Include /etc/ssh/sshd_config.d/*.conf。请在 /etc/ssh/sshd_config 里加上 `Include /etc/ssh/sshd_config.d/*.conf` 后重试（已回滚本次改动）。":
        "The write succeeded but the setting did not take effect: the main configuration may not include /etc/ssh/sshd_config.d/*.conf. Add `Include /etc/ssh/sshd_config.d/*.conf` to /etc/ssh/sshd_config and try again (this change was rolled back).",
    "写入成功但设置未生效：主配置可能没有 Include /etc/ssh/sshd_config.d/*.conf。请在它的 /etc/ssh/sshd_config 里加上 `Include /etc/ssh/sshd_config.d/*.conf` 后重试（已回滚本次改动）。":
        "The write succeeded but the setting did not take effect: the remote main configuration may not include /etc/ssh/sshd_config.d/*.conf. Add `Include /etc/ssh/sshd_config.d/*.conf` to its /etc/ssh/sshd_config and try again (this change was rolled back).",
    "这台主机的凭据是「用户名 + 口令」：关闭 SSH 口令认证会让面板立刻失去对它的管理能力。请先配置 SSH 密钥（改为密钥认证）再来加固。":
        "This host uses a username + password credential: turning off SSH password authentication would immediately cost the panel its ability to manage it. Configure SSH keys (switch to key authentication) before hardening.",
    "面板正用 root + 口令登录这台主机：禁止 root 直接登录会连同面板一起锁在门外。请先给一个普通用户配好 SSH 密钥再来加固。":
        "The panel signs in to this host as root with a password: disabling direct root login would lock the panel out too. Set up SSH keys for a regular user before hardening.",
    "远程命令没有返回任何数据": "The remote command returned no data",
    # ---- 认证 / 授权 / 控制台 / 任务：全站错误文案 ----
    "权限不足": "Permission denied",
    "无效的认证凭据": "Invalid authentication credentials",
    "来源校验失败": "Origin check failed",
    "权限不足：需要控制台访问权限": "Permission denied: console access is required",
    "Proxmox 连接未配置": "No Proxmox connection is configured",
    "无法连接到 Proxmox 控制台：": "Cannot connect to the Proxmox console: ",
    "PVE 控制台凭据无效或权限不足：": "The PVE console credential is invalid or lacks permission: ",
    "未配置控制台账号，无法打开控制台：PVE 的 VNC WebSocket 不接受 API Token。请在「设置 → 连接配置」中填写 Proxmox 控制台账号与密码（例如 root@pam）。":
        "No console account is configured, so the console cannot be opened: the PVE VNC WebSocket does not accept an API token. Fill in a Proxmox console account and password (e.g. root@pam) under “Settings → Connections”.",
    "无法从 UPID 解析节点": "Cannot resolve the node from the UPID",
    "无法从 UPID 解析节点，请显式提供 node 参数": "Cannot resolve the node from the UPID; pass the node parameter explicitly",
    "起始时间必须早于结束时间": "The start time must be earlier than the end time",
    # ---- 监控告警：Webhook 预设 / 指标名 / 推送来源开关 ----
    "企业微信机器人": "WeCom bot",
    "钉钉机器人": "DingTalk bot",
    "通用 JSON（自定义接收端）": "Generic JSON (custom receiver)",
    "CPU 使用率": "CPU usage",
    "内存使用率": "Memory usage",
    "磁盘使用率": "Disk usage",
    "离线": "Offline",
    "备份失败": "Backup failure",
    "资源告警": "Resource alerts",
    "状态告警": "Status alert",
    "CPU / 内存 / 磁盘的阈值规则及其恢复通知": "Threshold rules for CPU / memory / disk and their recovery notifications",
    "对外开放端口、可疑进程": "Exposed ports and suspicious processes",
    "本机 SSH 安全": "Local SSH security",
    "登录爆破、恶意 IP、账号异常": "Login brute force, malicious IPs, account anomalies",
    "远程主机 SSH 巡检": "Remote host SSH inspection",
    "受管远程主机的登录安全": "Login security of managed remote hosts",
    "受保护备份核对": "Protected backup verification",
    "受保护备份丢失或被改动": "Protected backups lost or modified",
    "该来源已停止推送告警（静默，不记录历史）": "This source no longer pushes alerts (muted, not recorded in history)",
    # ---- 监控告警：配置校验与通道投递结果 ----
    "Webhook 地址需要是完整的 http(s) 链接": "The webhook URL must be a complete http(s) link",
    "自定义请求头需要是合法的 JSON 对象": "Custom headers must be a valid JSON object",
    '自定义请求头需要是 JSON 对象（形如 {"Key":"value"}）': 'Custom headers must be a JSON object (e.g. {"Key":"value"})',
    "请求体模板不是合法 JSON（占位符会替换成文本，其余部分需符合 JSON 语法）": "The request body template is not valid JSON (placeholders are replaced with text; the rest must follow JSON syntax)",
    "收件地址格式不正确：": "Invalid recipient address: ",
    "未启用通用 Webhook": "The generic webhook is not enabled",
    "未配置通用 Webhook 地址": "No generic webhook URL is configured",
    "Webhook 地址不是合法的 http(s) 链接": "The webhook URL is not a valid http(s) link",
    "发送失败：": "Send failed: ",
    "已发送": "Sent",
    "未配置收件地址": "No recipient address is configured",
    "SMTP 未配置": "SMTP is not configured",
    "告警通知已停用，仅记录": "Alert notifications are disabled; events are recorded only",
    "飞书：": "Feishu: ",
    "邮件：": "Email: ",
    "Webhook：": "Webhook: ",
    "未配置飞书机器人 Webhook": "No Feishu bot webhook is configured",
    "飞书返回 HTTP ": "Feishu returned HTTP ",
    "飞书返回错误：": "Feishu returned an error: ",
    "：": ": ",
    # ---- 监控告警：飞书卡片与通知正文 ----
    "告警对象": "Target",
    "IP 地址": "IP address",
    "接入地址": "Host address",
    "未获取": "not available",
    "所在节点": "Node",
    "监控指标": "Metric",
    "期望状态": "Expected status",
    "实际状态": "Actual status",
    "当前值": "Current value",
    "触发阈值": "Threshold",
    "运行状态": "Run status",
    "恢复状态": "Recovery status",
    "触发时间 ": "Triggered at ",
    " · 恢复后会自动发送通知": " · a recovery notification will be sent automatically",
    " 秒内同一对象不重复提醒": "s cooldown for the same target",
    "告警规则": "Alert rule",
    "已恢复正常": "back to normal",
    "已恢复": "Recovered",
    "对象已回到期望状态，告警自动解除": "The target is back to its expected state; the alert was cleared automatically",
    "指标已回落至阈值以下，告警解除": "The metric dropped below the threshold; the alert was cleared",
    "对象已恢复可用，告警自动解除": "The target is available again; the alert was cleared automatically",
    "✅ ProxCenter 告警恢复": "✅ ProxCenter alert recovered",
    "恢复时间 ": "Recovered at ",
    "恢复通知：": "Recovery: ",
    "✅ ProxCenter 通知测试": "✅ ProxCenter notification test",
    "告警通道连通性验证": "Alert channel connectivity check",
    "通知渠道": "Channel",
    "飞书机器人": "Feishu bot",
    "消息类型": "Message type",
    "交互式卡片": "Interactive card",
    "发送时间": "Sent at",
    "通道状态": "Channel status",
    "正常": "OK",
    "收到这条消息，说明飞书机器人配置正确，可以正常接收 ProxCenter 告警。": "Receiving this message means the Feishu bot is configured correctly and can receive ProxCenter alerts.",
    "测试通知": "Test notification",
    "这是一条来自 ProxCenter 的测试消息，收到即表示通用 Webhook 配置正确。": "This is a test message from ProxCenter; receiving it means the generic webhook is configured correctly.",
    "：异常（期望 ": ": abnormal (expected ",
    "，实际 ": ", actual ",
    " (阈值 ": " (threshold ",
    "IP：": "IP: ",
    "节点：": "Node: ",
    "状态：": "Status: ",
    # ---- 巡检告警：端口 / 进程（portguard）----
    "未知进程": "unknown process",
    "主机": "Host",
    "系统": "OS",
    "非预期开放端口": "Unexpected open ports",
    "可疑进程": "Suspicious processes",
    "主机防火墙": "Host firewall",
    "明细": "Details",
    "ProxCenter 端口/进程告警": "ProxCenter port/process alert",
    # ---- 巡检告警：本机 / 远程 SSH（sshguard、sshremote）----
    "🛡 ProxCenter SSH 爆破告警": "🛡 ProxCenter SSH brute-force alert",
    "来源 IP": "Source IP",
    "失败次数": "Failures",
    "统计窗口": "Window",
    "尝试的用户名": "Attempted usernames",
    "发生时间": "Occurred at",
    "可在「SSH 安全」页对该主机一键封禁，或用 fail2ban 自动封禁。": "You can ban it on this host from the “SSH security” page, or let fail2ban ban it automatically.",
    "连续失败通常意味着暴力破解。可在「SSH 安全」页一键封禁该 IP，或用 fail2ban 自动封禁。": "Repeated failures usually mean brute force. You can ban this IP from the “SSH security” page, or let fail2ban ban it automatically.",
    "🔑 ProxCenter 陌生 IP 登录成功": "🔑 ProxCenter: sign-in from an unknown IP",
    "登录用户": "User",
    "认证方式": "Auth method",
    "登录时间": "Signed in at",
    "IP 是否见过": "IP seen before",
    "第一次出现": "first time seen",
    "如果不是你本人的操作，请立刻在「用户管理」里踢掉该账号的会话并改密码。": "If this was not you, revoke this account’s sessions under “Users” and change the password right away.",
    "SSH 爆破告警：": "SSH brute-force alert: ",
    "陌生 IP 登录：": "Sign-in from an unknown IP: ",
    "SSH 登录失败次数": "SSH sign-in failures",
    "陌生 IP 登录": "Sign-in from unknown IP",
    # ---- 巡检告警：受保护备份（backupguard）----
    "ProxCenter 备份防护告警": "ProxCenter backup protection alert",
    "受保护备份丢失": "Protected backup lost",
    "受保护备份异常": "Protected backup anomaly",
    "备份卷": "Backup volume",
    "状态": "Status",
    "已丢失": "lost",
    "元数据变化": "metadata changed",
    "原因": "Reason",
    "登记人 / 时间": "Registered by / at",
    "备份防护告警：": "Backup protection alert: ",
    # ---- 站内消息（notifications）----
    "外部通道未送达：": "External channels did not deliver: ",
    # ---- 端口巡检：可疑进程信号（portguard.SUSPICIOUS_PATTERNS）----
    "命令行里出现 /dev/tcp：Bash 自带的网络重定向，是反弹 shell 的典型写法": "/dev/tcp appears on the command line: Bash’s built-in network redirection, the classic reverse-shell idiom",
    "netcat 带 -e/--exec：把 shell 挂到网络连接上": "netcat with -e/--exec: it attaches a shell to the network connection",
    "交互式 shell 进程：正常服务不会这么起，常见于反弹 shell": "Interactive shell process: no legitimate service is started this way; common in reverse shells",
    "socat 把命令执行接到网络连接上": "socat wires command execution to a network connection",
    "Python 单行脚本里出现 socket/dup2：反弹 shell 的经典实现": "Python one-liner uses socket/dup2: the classic reverse-shell implementation",
    "Perl 单行脚本里出现 Socket/exec": "Perl one-liner uses Socket/exec",
    "Ruby 单行脚本加载 socket": "Ruby one-liner loads socket",
    "PHP 单行脚本里出现 fsockopen / 命令执行": "PHP one-liner uses fsockopen / command execution",
    "openssl s_client 管道给 shell：加密的反弹 shell": "openssl s_client piped into a shell: an encrypted reverse shell",
    "mkfifo + nc 组合：命名管道反弹 shell": "mkfifo + nc: a named-pipe reverse shell",
    "命中已知挖矿 / 蠕虫 / 扫描器进程名": "Matches a known miner / worm / scanner process name",
    "netcat 处于监听模式：可能是后门监听": "netcat is listening: it may be a backdoor listener",
    "curl/wget 管道给 shell：远程代码执行的常见手法": "curl/wget piped into a shell: the usual remote-code-execution trick",
    # ---- 网站证书：下拉选项与部署方式 ----
    "DNS_AUTO（自动添加解析，域名需托管在腾讯云 DNSPod）": "DNS_AUTO (records are added automatically; the domain must be hosted on Tencent Cloud DNSPod)",
    "DNS（手动添加解析记录）": "DNS (add the validation records manually)",
    "FILE（站点根目录放置验证文件，需海外 CA 可访问）": "FILE (put the validation files in the site root; they must be reachable by the CA from outside mainland China)",
    "本机目录（面板所在服务器）": "Local directory (the server running this panel)",
    "SSH 远程服务器": "Remote server over SSH",
    "Proxmox 虚拟机（QEMU Guest Agent）": "Proxmox VM (QEMU Guest Agent)",
    # ---- 网站证书：站点与校验错误（经 _bad_request 收口翻译）----
    "站点不存在": "Site not found",
    "站点已删除（已部署的证书文件未做改动）": "Site deleted (deployed certificate files are left untouched)",
    "腾讯云免费证书不支持泛域名（*.example.com），请填写具体域名": "Free certificates do not support wildcards (*.example.com); enter a specific domain",
    "域名格式不正确：": "Invalid domain: ",
    "域名长度不能超过 64 个字符": "The domain cannot exceed 64 characters",
    "免费证书不支持 IP 地址": "Free certificates do not support IP addresses",
    "文件名只能包含字母、数字、点、下划线和短横线：": "Filenames may only contain letters, digits, dots, underscores and hyphens: ",
    "请填写要签发证书的域名": "Please enter the domain to issue the certificate for",
    "部署方式只能是 本机目录 / SSH 远程 / Proxmox 虚拟机": "The deploy method must be one of: local directory / SSH remote / Proxmox VM",
    "请填写证书部署目录": "Please enter the certificate deploy directory",
    "部署目录必须是绝对路径，例如 /etc/nginx/ssl": "The deploy directory must be an absolute path, e.g. /etc/nginx/ssl",
    "部署目录只能包含字母、数字与 . _ - @ + /，且不能包含 . 或 .. 路径片段": "The deploy directory may only contain letters, digits and . _ - @ + /, and cannot contain . or .. path segments",
    "证书文件名与私钥文件名不能相同": "The certificate filename and the key filename cannot be the same",
    "虚拟机 ID 必须是数字": "The VM ID must be numeric",
    "SSH 部署需要填写目标服务器地址": "SSH deployment needs the target server address",
    "SSH 部署需要填写登录用户名": "SSH deployment needs the login username",
    "SSH 密码认证需要填写密码（已保存的站点可留空表示不修改）": "Password authentication needs a password (leave it blank on a saved site to keep the current one)",
    "SSH 密钥认证需要粘贴私钥内容（已保存的站点可留空表示不修改）": "Key authentication needs the private key (leave it blank on a saved site to keep the current one)",
    "Guest Agent 部署需要选择目标虚拟机的节点与 VMID": "Guest Agent deployment needs the target VM’s node and VMID",
    "域名验证方式只能是 DNS_AUTO / DNS / FILE": "The domain validation method must be DNS_AUTO / DNS / FILE",
    "请填写证书 ID": "Please enter the certificate ID",
    "请先配置腾讯云 API 密钥": "Configure the Tencent Cloud API key first",
    "请先填写 SecretId 与 SecretKey": "Enter the SecretId and SecretKey first",
    "该站点还没有证书，请先申请或绑定证书": "This site has no certificate yet; request or bind one first",
    # ---- 网站证书：部署与重载 ----
    "无法执行重载命令：": "Cannot run the reload command: ",
    "重载命令返回 ": "Reload command exited with ",
    "，重载命令已执行": ", reload command executed",
    "创建部署目录失败：": "Failed to create the deploy directory: ",
    "写入证书文件失败：": "Failed to write the certificate file: ",
    "已写入本机 ": "Written to local ",
    "本机 ": "local ",
    "无法解析 SSH 私钥，支持 RSA / ECDSA / Ed25519 且不能带密码": "Cannot parse the SSH private key; RSA / ECDSA / Ed25519 without a passphrase are supported",
    "缺少 paramiko 依赖，无法使用 SSH 部署": "The paramiko package is missing; SSH deployment is unavailable",
    "SSH 认证失败，请检查用户名与密码/私钥": "SSH authentication failed; check the username and password / key",
    "SSH 连接失败：": "SSH connection failed: ",
    "无法连接 ": "Cannot connect to ",
    "上传证书文件到 ": "Failed to upload the certificate files to ",
    " 失败：": ": ",
    "已部署到 ": "Deployed to ",
    "远程重载命令返回 ": "Remote reload command exited with ",
    "，远程重载命令已执行": ", remote reload command executed",
    "Guest Agent 调用失败：": "Guest Agent call failed: ",
    "（请确认虚拟机内已安装并运行 qemu-guest-agent）": " (make sure qemu-guest-agent is installed and running inside the VM)",
    "读取命令执行结果失败：": "Failed to read the command result: ",
    "打开虚拟机内文件失败：": "Failed to open the file in the VM: ",
    "Guest Agent 未返回文件句柄，可能是磁盘路径不可写": "The Guest Agent returned no file handle; the path may not be writable",
    "写入虚拟机内文件失败：": "Failed to write the file in the VM: ",
    "已写入虚拟机 ": "Written to VM ",
    "，虚拟机内重载命令已执行": ", reload command executed in the VM",
    "，来源 ": ", from ",
    "，证书 ID ": ", certificate ID ",
    "证书已绑定": "Certificate bound",
    "腾讯云接口调用失败：": "Tencent Cloud API call failed: ",
    # ---- 网站证书：腾讯云证书状态（STATUS_TEXT）----
    "审核中": "Under review",
    "已签发": "Issued",
    "审核失败": "Review failed",
    "已过期": "Expired",
    "等待 DNS 验证": "Waiting for DNS validation",
    "待提交资料": "Waiting for documents",
    "订单取消中": "Cancelling",
    "已取消": "Cancelled",
    "待上传确认函": "Waiting for the confirmation letter",
    "吊销中": "Being revoked",
    "已吊销": "Revoked",
    "重颁发中": "Being reissued",
    "待上传吊销确认函": "Waiting for the revocation confirmation letter",
    "免费证书待提交资料": "Free certificate: waiting for documents",
    "已退款": "Refunded",
    "证书迁移中": "Being migrated",
}


# ------------------------------------------------------- 结构化数据本地化
def localize_permission_catalog(catalog: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把权限目录的 label / desc 换成当前语言（返回新对象，不动原表）。"""
    if not is_english():
        return catalog

    localized: List[Dict[str, Any]] = []
    for group in catalog:
        localized.append(
            {
                **group,
                "label": tr(group.get("label")),
                "permissions": [
                    {**item, "label": tr(item.get("label")), "desc": tr(item.get("desc"))}
                    for item in group.get("permissions", [])
                ],
            }
        )
    return localized


def localized_builtin_role_names(names: Dict[str, str]) -> Dict[str, str]:
    """内置角色名按当前语言返回（角色 id 不变，只有显示名翻译）。"""
    return {role_id: tr(name) for role_id, name in names.items()}
