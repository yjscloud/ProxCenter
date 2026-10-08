"""AI 预案（playbook）：把常见的排障套路固化成可点选的模板。

为什么要单独一层
----------------
* **给起点**：用户打开助手时面对一个空输入框，「我该问什么」本身就是门槛。预案把
  「磁盘快满」这类高频场景变成一次点击 —— 但它是**可选的起点**，不是必经流程：
  不想用模板的人照样可以直接打字。
* **可插拔**：套路随运维经验增长（今天加「备份失败排查」，明天加「证书到期」），
  集中登记在这里，前端只消费 ``GET /api/ai/playbooks``，不必跟着改 UI。

每个预案有三件东西
------------------
* ``key``    —— 稳定标识，前端、审计都用它；
* ``title``  —— 短标题：既当按钮文案，也当对话里那条用户消息（**可读**，
  不把几十字的指令塞进聊天记录）；
* ``prompt`` —— 真正发给模型的指令（含步骤建议），只进上下文、不进聊天记录。

``mode`` 默认 ``chat``（预案只是「问得更专业的问题」）；写 ``inspect`` 的预案会
触发一次完整体检（采集证据 + 产出报告）—— 留给以后真需要「一键 XX 体检」时用。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import i18n

# 各预案的指令正文。中英各一份，正文里不写「你是…」这类角色设定 ——
# 那是 system 提示词的活，预案只负责交代「查什么、按什么顺序查」。
_ZH: Dict[str, str] = {
    "slowness": (
        "这台主机被反馈「变慢」了，请按下面的顺序查一遍，不要跳步也別上全套：\n"
        "1) 看负载与 CPU（uptime、历史负载趋势），判断是持续吃紧还是尖刺；\n"
        "2) 看内存与 swap（free），确认有没有换页抖动；\n"
        "3) 找出占用 CPU / 内存最高的进程；\n"
        "4) 看磁盘 IO 与网络连接，判断是不是 IO 或连接数打满；\n"
        "5) 如果最近有变更记录，看看和变慢的时间点是否吻合。\n"
        "最后给出：最可能的瓶颈是什么、依据是哪些数据、下一步建议怎么验证。"
    ),
    "disk": (
        "请做一次磁盘空间排查：\n"
        "1) 列出各挂载点的使用率，找出最危险的几个（超过 80% 的重点看）；\n"
        "2) 对那些挂载点，定位占用最大的目录或文件；\n"
        "3) 留意异常大的日志、core dump、残留的临时文件或旧备份；\n"
        "4) 顺手判断空间增长是否异常（日志暴涨往往意味着另一个问题）。\n"
        "最后给出：哪个挂载点最危险、被什么占了、建议怎么清理。只给建议，不要执行删除。"
    ),
    "service": (
        "请排查有没有服务异常：\n"
        "1) 列出失败的系统单元，逐个看它们的最近日志；\n"
        "2) 检查监听端口是否与预期一致（有没有该监听却没监听、或监听在不该监听的地址）；\n"
        "3) 看看有没有反复重启的单元（重启本身就是故障信号）；\n"
        "4) 如果这台机器上跑着容器或虚拟机，也一并看下它们的运行状态。\n"
        "最后给出：哪些服务处于异常状态、最可能的原因、恢复建议。不要执行重启。"
    ),
    "login": (
        "请做一次登录安全排查：\n"
        "1) 看最近的登录失败统计，找出集中的来源 IP 与尝试的用户名；\n"
        "2) 看成功的登录记录，确认有没有非预期的来源、时间或账号；\n"
        "3) 检查是否有账号被提权或新增（sudo 使用、用户变更）；\n"
        "4) 结合安全体检的未通过项，判断有没有可利用的口子。\n"
        "最后给出：风险等级、最值得关注的那几件事、建议的处置动作。"
    ),
    "changes": (
        "请做一次变更回溯，回答「问题出现之前动过什么」：\n"
        "1) 拉取最近的集群变更记录（谁、在哪台机器上、改了什么、什么时候）；\n"
        "2) 把这些变更与当前主机上的异常现象做时间线对照；\n"
        "3) 如果看不出明确关联，说明还需要哪些信息（比如具体时间点、具体服务）。\n"
        "最后给出：最可疑的变更、判断依据、以及要不要回退的建议。"
    ),
    "network": (
        "请看一下这台主机的网络与端口情况：\n"
        "1) 列出监听端口，标出对公网暴露的那些；\n"
        "2) 找出建立连接数异常多的进程或对端（可能是被扫、也可能是在扫别人）；\n"
        "3) 看有没有可疑的进程在监听高位端口；\n"
        "4) 检查防火墙规则有没有明显与监听面冲突的地方。\n"
        "最后给出：暴露面里最该收紧的是哪些、依据是什么、建议怎么处理。"
    ),
    "memory": (
        "请排查内存相关的问题：\n"
        "1) 看总内存、可用内存与 swap 使用，判断是不是真的吃紧；\n"
        "2) 按常驻内存（RSS）倒序列出占用最大的进程；\n"
        "3) 看内核日志里有没有 OOM killer 记录 —— 有的话把被杀掉的进程找出来；\n"
        "4) 看有没有像内存泄漏的特征（同一进程的内存持续上涨）；\n"
        "5) 如果平台里有历史指标，判断是突然涨上来还是长期缓慢恶化。\n"
        "最后给出：是不是内存不足、谁在占、建议怎么处理（加 swap / 限制进程 / 扩容）。"
    ),
    "kernel": (
        "请排查内核与硬件层面的异常：\n"
        "1) 读内核环形缓冲区的最近日志，找报错与硬件异常；\n"
        "2) 特别留意 OOM、IO 错误、文件系统错误、网卡与驱动报错；\n"
        "3) 看内核启动参数，确认有没有该预留却没预留的（例如 crashkernel）；\n"
        "4) 结合块设备与文件系统使用情况，判断有没有磁盘层面的隐患。\n"
        "最后给出：哪些是硬件 / 驱动层面的真信号、哪些可以忽略、需要关注的话建议怎么做。"
    ),
    "io": (
        "请排查磁盘 IO 性能：\n"
        "1) 看 CPU 的 iowait 占比与整体负载，判断瓶颈是不是在磁盘；\n"
        "2) 看内存与 swap 换页情况（换页本身就能把磁盘打满）；\n"
        "3) 找出 IO 压力最大的进程；\n"
        "4) 看块设备与文件系统的使用率和类型，判断有没有快写满的盘。\n"
        "最后给出：IO 瓶颈是否成立、由谁造成、建议怎么缓解。"
    ),
    "time": (
        "请核对这台机器的时间与定时任务：\n"
        "1) 看当前时间、时区与时间同步状态（谁在同步、上次同步成不成功）；\n"
        "2) 时间偏差会让日志与告警对不上，确认偏差在可接受范围内；\n"
        "3) 看系统定时任务（cron / systemd timer）里有没有新增或失败的条目；\n"
        "4) 时间如果明显不准，判断是同步服务没跑、上游不可达还是硬件时钟漂移。\n"
        "最后给出：时间是否可信、有没有可疑的定时任务、建议怎么修。"
    ),
    "updates": (
        "请核对系统与软件包的安全更新情况：\n"
        "1) 看发行版与内核版本，确认有没有长期未重启而累积的内核更新；\n"
        "2) 看关键组件（SSH、Web 服务等）的版本，与已知高危漏洞对照；\n"
        "3) 看有没有待安装的安全更新；\n"
        "4) 看自动更新的配置，判断这台机器平时会不会自己打补丁。\n"
        "最后给出：有没有必须尽快处理的更新、风险在哪、建议的升级顺序。不要执行升级。"
    ),
    "cert": (
        "请检查这台机器上的证书与 HTTPS 配置：\n"
        "1) 找出常用服务配置里引用的证书文件（如 nginx 的 ssl_certificate）；\n"
        "2) 逐个核对有效期，标出 30 天内到期的；\n"
        "3) 核对证书域名与实际使用是否匹配、链是否完整；\n"
        "4) 看配置里有没有明显的 TLS 弱项（过时的协议或套件）。\n"
        "最后给出：哪些证书要续、有没有配错的地方、建议怎么改。"
    ),
    "backup": (
        "请核对这台机器的备份情况：\n"
        "1) 看有没有备份任务（cron / systemd timer），最近一次成功是什么时候；\n"
        "2) 看备份产物是否真的存在、大小是否合理（有没有一直失败或只生成空文件）；\n"
        "3) 看备份目标位置的空间够不够，别让备份把源盘写满；\n"
        "4) 结合平台的备份核对结果，判断有没有「看起来有备份、其实不可用」的情况。\n"
        "最后给出：备份是否可信、缺口在哪、建议怎么补。"
    ),
    "dns": (
        "请排查域名解析与对外连通性：\n"
        "1) 看本机配置的 DNS 服务器与解析顺序；\n"
        "2) 挑几个关键域名实际解析一次，确认能不能解、解出来对不对；\n"
        "3) 看 hosts 里的静态解析有没有被动过手脚；\n"
        "4) 解析异常时进一步看路由与到上游的连通性。\n"
        "最后给出：解析是否正常、异常出在哪一层、建议怎么修。"
    ),
}

_EN: Dict[str, str] = {
    "slowness": (
        "This host has been reported as slow. Work through the following in order, "
        "and don't run the whole battery if something obvious shows up:\n"
        "1) load and CPU (uptime, historical load) — sustained pressure or spikes?\n"
        "2) memory and swap (free) — any swapping?\n"
        "3) top CPU / memory consumers;\n"
        "4) disk IO and network connections — saturated IO or connection counts?\n"
        "5) if there are recent change records, check whether they line up in time.\n"
        "Then conclude: the most likely bottleneck, the evidence behind it, and how to "
        "verify it next."
    ),
    "disk": (
        "Run a disk-space investigation:\n"
        "1) list usage per mount point and pick out the most dangerous ones (>80%);\n"
        "2) for those, locate the largest directories or files;\n"
        "3) look for oversized logs, core dumps, leftover temp files or old backups;\n"
        "4) judge whether growth is abnormal (a log explosion usually means another bug).\n"
        "Then conclude: which mount is at risk, what is filling it, and how to clean up. "
        "Suggest only — do not delete anything."
    ),
    "service": (
        "Check whether any service is unhealthy:\n"
        "1) list failed system units and read their recent logs;\n"
        "2) verify listening ports match expectations (missing, or bound to the wrong address);\n"
        "3) look for units that keep restarting — a restart is itself a failure signal;\n"
        "4) if containers or VMs run here, check their state too.\n"
        "Then conclude: which services are unhealthy, the most likely cause, and how to "
        "recover. Do not restart anything."
    ),
    "login": (
        "Run a login-security review:\n"
        "1) recent failed logins — which source IPs and usernames dominate?\n"
        "2) successful logins — any unexpected source, time or account?\n"
        "3) privilege escalation or new accounts (sudo usage, user changes);\n"
        "4) cross-check against failed baseline checks for exploitable gaps.\n"
        "Then conclude: the risk level, the few things that matter most, and what to do."
    ),
    "changes": (
        "Do a change-backtrack: what was touched before this problem appeared?\n"
        "1) pull recent cluster change records (who, which host, what, when);\n"
        "2) line them up against the current symptoms on this host;\n"
        "3) if there is no clear link, say what else you would need (timing, service).\n"
        "Then conclude: the most suspicious change, why, and whether to roll it back."
    ),
    "network": (
        "Look at this host's network and ports:\n"
        "1) list listening ports, flagging what is exposed publicly;\n"
        "2) find processes or peers with unusual connection counts (being scanned, or "
        "scanning others);\n"
        "3) look for suspicious processes listening on high ports;\n"
        "4) check firewall rules for conflicts with the exposed surface.\n"
        "Then conclude: what to tighten first, on what evidence, and how."
    ),
    "memory": (
        "Investigate memory pressure:\n"
        "1) total, available and swap usage — is it actually tight?\n"
        "2) top processes by resident memory (RSS);\n"
        "3) scan the kernel log for OOM-killer records and name the victims;\n"
        "4) look for leak-like patterns (one process growing steadily);\n"
        "5) if platform metrics exist, decide whether it spiked or crept up.\n"
        "Then conclude: is memory the problem, who is using it, and what to do "
        "(swap, limits, more RAM)."
    ),
    "kernel": (
        "Look for kernel- and hardware-level trouble:\n"
        "1) read the recent kernel ring buffer for errors and hardware faults;\n"
        "2) pay attention to OOM, IO errors, filesystem errors, NIC/driver messages;\n"
        "3) check kernel boot parameters for anything that should be reserved but is not "
        "(e.g. crashkernel);\n"
        "4) cross-check block devices and filesystem usage for disk-level risk.\n"
        "Then conclude: which signals are real, which are noise, and what to do if any matter."
    ),
    "io": (
        "Investigate disk IO performance:\n"
        "1) iowait share and overall load — is the bottleneck the disk?\n"
        "2) memory and swap paging (paging alone can saturate a disk);\n"
        "3) the processes causing the most IO;\n"
        "4) block devices and filesystem usage/type — anything close to full?\n"
        "Then conclude: is IO the bottleneck, who causes it, and how to ease it."
    ),
    "time": (
        "Check this host's clock and scheduled jobs:\n"
        "1) current time, timezone and sync status (who syncs it, did the last sync work?);\n"
        "2) clock skew makes logs and alerts unreliable — confirm it is acceptable;\n"
        "3) look at cron / systemd timers for new or failing entries;\n"
        "4) if the clock is clearly off, work out whether the sync service is down, the "
        "upstream is unreachable, or the RTC drifts.\n"
        "Then conclude: is the clock trustworthy, are there suspicious jobs, and how to fix it."
    ),
    "updates": (
        "Review security updates on this host:\n"
        "1) distro and kernel version — any kernel updates never booted into?\n"
        "2) versions of key components (SSH, web server) against known high-risk CVEs;\n"
        "3) pending security updates;\n"
        "4) auto-update configuration — does this host patch itself at all?\n"
        "Then conclude: what must be updated soon, where the risk is, and the order to do it in. "
        "Do not run any upgrade."
    ),
    "cert": (
        "Check certificates and HTTPS configuration on this host:\n"
        "1) find the certificate files referenced by common services (e.g. nginx ssl_certificate);\n"
        "2) check expiry dates and flag anything due within 30 days;\n"
        "3) verify names match actual use and the chain is complete;\n"
        "4) look for obvious TLS weaknesses in the config (outdated protocols or ciphers).\n"
        "Then conclude: what needs renewing, what is misconfigured, and how to fix it."
    ),
    "backup": (
        "Verify this host's backups:\n"
        "1) are there backup jobs (cron / systemd timers), and when did one last succeed?\n"
        "2) do the artefacts actually exist and look sane (not perpetually failing or empty)?\n"
        "3) is there room at the destination — backups must not fill the source disk;\n"
        "4) cross-check against the platform's backup verification for "
        "\"looks backed up but is not usable\" cases.\n"
        "Then conclude: are the backups trustworthy, where are the gaps, and how to close them."
    ),
    "dns": (
        "Investigate name resolution and outbound connectivity:\n"
        "1) which DNS servers are configured, and in what order?\n"
        "2) resolve a few key domains and check the answers are correct;\n"
        "3) check /etc/hosts for tampering;\n"
        "4) if resolution fails, look at routing and reachability to the upstream.\n"
        "Then conclude: is resolution healthy, which layer is broken, and how to fix it."
    ),
}

# key -> (中文标题, 英文标题, 中文提示, 英文提示)
_TITLES: List[tuple] = [
    (
        "slowness",
        "排查「这台机器变慢」",
        "Troubleshoot “this host is slow”",
        "负载 / 内存 / 进程 / IO 逐层看一遍",
        "Load, memory, processes and IO in order",
    ),
    (
        "disk",
        "排查「磁盘快满了」",
        "Troubleshoot “disk almost full”",
        "先看使用率，再定位大目录与大文件",
        "Usage first, then the biggest dirs and files",
    ),
    (
        "service",
        "排查「服务挂掉了」",
        "Troubleshoot “a service is down”",
        "失败单元、端口监听、反复重启",
        "Failed units, listening ports, restart loops",
    ),
    (
        "login",
        "排查「异常登录」",
        "Troubleshoot “suspicious logins”",
        "登录失败来源、成功登录、提权行为",
        "Failed sources, successful logins, escalation",
    ),
    (
        "changes",
        "回溯「最近改过什么」",
        "Backtrack “what changed recently”",
        "把变更记录与当前现象对时间线",
        "Line change records up with the symptoms",
    ),
    (
        "network",
        "排查「网络与端口暴露」",
        "Troubleshoot “network & port exposure”",
        "监听面、异常连接数、防火墙冲突",
        "Listening surface, odd connections, firewall conflicts",
    ),
    (
        "memory",
        "排查「内存吃紧」",
        "Troubleshoot “memory pressure”",
        "可用内存、swap、OOM 记录与占用大户",
        "Available memory, swap, OOM records, top consumers",
    ),
    (
        "kernel",
        "排查「内核与硬件异常」",
        "Troubleshoot “kernel & hardware errors”",
        "内核日志、OOM、IO / 驱动报错",
        "Kernel log, OOM, IO and driver errors",
    ),
    (
        "io",
        "排查「磁盘 IO 慢」",
        "Troubleshoot “slow disk IO”",
        "iowait、换页、IO 压力大户",
        "Iowait, paging, the processes hammering the disk",
    ),
    (
        "time",
        "核查「时间与定时任务」",
        "Check “clock & scheduled jobs”",
        "时间同步、时钟偏差、cron 条目",
        "Time sync, clock skew, cron entries",
    ),
    (
        "updates",
        "核查「安全更新」",
        "Check “security updates”",
        "内核与关键组件的补丁情况",
        "Kernel and key components vs known CVEs",
    ),
    (
        "cert",
        "排查「证书与 HTTPS」",
        "Troubleshoot “certificates & HTTPS”",
        "到期时间、域名匹配、TLS 配置",
        "Expiry, name matching, TLS configuration",
    ),
    (
        "backup",
        "核对「备份是否可信」",
        "Verify “backups are usable”",
        "任务是否成功、产物是否真的存在",
        "Did the job succeed, do the artefacts exist",
    ),
    (
        "dns",
        "排查「域名解析」",
        "Troubleshoot “DNS resolution”",
        "解析服务器、实测解析、hosts 篡改",
        "DNS servers, real lookups, /etc/hosts tampering",
    ),
]


def list_playbooks() -> List[Dict[str, str]]:
    """预案清单。

    **每次调用现取**：文案要按当前语言重新求值 —— 在模块级固化成常量的话，
    切换语言后预案还是旧语言（而界面其它部分已经切了）。
    """
    return [
        {
            "key": key,
            "mode": "chat",
            "title": i18n.pick(zh_title, en_title),
            "hint": i18n.pick(zh_hint, en_hint),
            "prompt": i18n.pick(_ZH.get(key, ""), _EN.get(key, "")),
        }
        for key, zh_title, en_title, zh_hint, en_hint in _TITLES
    ]


def get_playbook(key: Any) -> Optional[Dict[str, str]]:
    """按 key 取预案；未知 key 返回 None（调用方退化成普通对话）。"""
    wanted = str(key or "").strip()
    if not wanted:
        return None
    for item in list_playbooks():
        if item["key"] == wanted:
            return item
    return None
