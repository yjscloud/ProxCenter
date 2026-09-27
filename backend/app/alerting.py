"""监控告警：阈值检测 + 飞书通知卡片。"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

from . import crypto, database, mailer, notifications, site, store
from .pve import get_client

logger = logging.getLogger(__name__)

RULES_KEY = "alert_rules"
# 飞书通知配置按用户存：key = "alert_feishu:<username>"
FEISHU_KEY_PREFIX = "alert_feishu:"
# 升级前的全局配置（只有一份，没有归属）：管理员没保存过自己的配置时沿用，只读不写
LEGACY_FEISHU_KEY = "alert_feishu"
# 邮件通知的收件人同样按用户存：key = "alert_email:<username>"
# 注意与「全局的 SMTP 服务器配置」（mailer.MAIL_KEY）区分：服务器只有一台，
# 收件人是各人自己的。
ALERT_EMAIL_KEY_PREFIX = "alert_email:"
# 通用 Webhook 同样按用户存：key = "alert_webhook:<username>"
WEBHOOK_KEY_PREFIX = "alert_webhook:"

# 落库前需要加密的敏感字段。
SENSITIVE_KEYS = ("webhook", "secret")

# ---------------------------------------------------------------- 通用 Webhook
#
# 为什么加一个「通用」通道而不是逐个接企业微信 / 钉钉 / Slack：
# 这些渠道的差异只在**请求体形状**上，鉴权与投递逻辑完全一样。与其为每家写一遍
# 发送代码与配置界面，不如让用户自己填请求体模板（内置几家常用的预设），
# 新增一家渠道不需要改代码。
#
# 签名是面板自己的约定（不是各家的原生签名）：``X-Panel-Signature: sha256=<hex>``，
# 计算方式为 ``HMAC-SHA256(secret, f"{timestamp}\n{body}")``。接收端照这个口径
# 校验即可确认请求确实来自本面板、且请求体没被篡改。
#
# 已知限制：钉钉开启「加签」后要求把 sign 放进 URL 查询参数（每请求重算），
# 那不是通用模板能表达的东西，需要在接收端关掉加签或自行中转。
DEFAULT_WEBHOOK: Dict[str, Any] = {
    "webhook": "",
    "secret": "",
    # 默认关闭：填了地址还要显式打开，避免试配置时就把告警泼到生产群里
    "enabled": False,
    "cooldown": 600,
    # 请求体模板（JSON 文本，支持 {{占位符}}）；留空用下面这份默认体
    "template": "",
    # 额外请求头（JSON 对象文本），用于渠道特有的鉴权头
    "headers": "",
}

DEFAULT_WEBHOOK_TEMPLATE = (
    '{"source":"ProxCenter","level":"{{level}}",'
    '"title":"{{title}}","text":"{{text}}","target":"{{target}}",'
    '"metric":"{{metric}}","value":"{{value}}","threshold":"{{threshold}}",'
    '"node":"{{node}}","time":"{{time}}"}'
)

# 一键填充的请求体模板。企业微信 / 钉钉 / Slack 都吃 JSON，只是字段名不同。
WEBHOOK_PRESETS: Dict[str, Dict[str, str]] = {
    "wecom": {
        "label": "企业微信机器人",
        "template": '{"msgtype":"markdown","markdown":{"content":"**{{title}}**\\n{{text}}\\n> {{time}}"}}',
        "headers": "",
    },
    "dingtalk": {
        "label": "钉钉机器人",
        "template": '{"msgtype":"markdown","markdown":{"title":"{{title}}","text":"### {{title}}\\n\\n{{text}}\\n\\n> {{time}}"}}',
        "headers": "",
    },
    "slack": {
        "label": "Slack Incoming Webhook",
        "template": '{"text":"*{{title}}*\\n{{text}}\\n> {{time}}"}',
        "headers": "",
    },
    "generic": {
        "label": "通用 JSON（自定义接收端）",
        "template": DEFAULT_WEBHOOK_TEMPLATE,
        "headers": "",
    },
}

# 模板里可用的占位符（前端把它列给用户，避免靠猜）
WEBHOOK_PLACEHOLDERS: List[str] = [
    "level",
    "title",
    "text",
    "target",
    "target_type",
    "metric",
    "value",
    "threshold",
    "node",
    "vmid",
    "status",
    "ip",
    "time",
]

# {{name}}：允许花括号内有空格，方便手写
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


class WebhookConfigError(ValueError):
    """通用 Webhook 配置不合法。"""


# --------------------------------------------------------------- 归属（分用户）
def feishu_key(owner: str) -> str:
    """飞书通知配置的存储 key：每个用户各自一份。"""
    return FEISHU_KEY_PREFIX + str(owner or "")


def owner_of(item: Dict[str, Any]) -> str:
    """条目的归属用户名；旧数据没有归属时为空串。"""
    return str((item or {}).get("username") or "").strip()


def alarm_key(owner: str, rule_id: Any, label: str) -> str:
    """告警状态的主键：同一对象在不同用户下各自独立计数与冷却。"""
    return str(owner or "") + "|" + str(rule_id) + "|" + str(label)


def visible_rules(
    rules: List[Dict[str, Any]], owner: Optional[str]
) -> List[Dict[str, Any]]:
    """按可见范围过滤规则：``owner=None``（管理员）表示全部。"""
    if owner is None:
        return list(rules)
    return [rule for rule in rules if owner_of(rule) == owner]

METRIC_LABELS = {
    "cpu": "CPU 使用率",
    "mem": "内存使用率",
    "disk": "磁盘使用率",
    # 离线不是百分比指标：状态不为 running / online 即告警，
    # 见 evaluate() 里对它的单独分支。运维里机器宕机往往比资源跑满更紧急，
    # 而按使用率告警是永远等不到它的 —— 关机状态下没有使用率数据。
    "offline": "离线",
    # 备份失败率：由 /nodes/{node}/tasks 里最近的 vzdump 任务统计得出
    "backup": "备份失败",
}

# 这些指标的「值」不是 0-100 的百分比，卡片与历史记录要换一种呈现方式
STATE_METRICS = {"offline", "backup"}

# 判定「在线」的期望状态：节点是 online，虚拟机是 running
EXPECTED_STATUS = {"node": "online", "vm": "running"}

# 规则里的 target_type 与 /cluster/resources 返回的 type 并不一致：
# PVE 的条目用 "qemu" 表示虚拟机、"node" 表示宿主机，而面板面向的
# 虚拟机就是 QEMU 虚拟机（与「计算 → 虚拟机」页面一致）。
RESOURCE_TYPES = {
    "vm": {"qemu"},
    "node": {"node"},
}

# 卡片头部配色：飞书模板色卡
CARD_TEMPLATES = {
    "critical": "red",
    "warning": "orange",
    "info": "blue",
    "success": "green",
}

# 卡片大标题里的产品名。各处的卡片标题都写成 "🔴 ProxCenter 资源告警"
# 这种形式，发送前会被 :func:`_apply_title_brand` 统一换成用户配置的名字
# （见下面 DEFAULT_FEISHU 的 title 字段），所以这里是个**占位**而不是品牌。
DEFAULT_TITLE_BRAND = "ProxCenter"
MAX_TITLE_BRAND = 32

DEFAULT_FEISHU: Dict[str, Any] = {
    "webhook": "",
    "secret": "",
    "enabled": True,
    "cooldown": 600,
    # 告警卡片标题里的名字：留空 = 用「设置 → 站点信息」里的面板名称
    "title": "",
}

# 告警邮件的收件人配置。收件人留空时回退到账号邮箱，所以默认「开」也不会
# 凭空发信 —— 没邮箱的用户根本不会被投递。
DEFAULT_ALERT_EMAIL: Dict[str, Any] = {
    "enabled": False,
    "recipients": "",
}

# =============================================================== 推送来源开关
#
# 五个告警来源各有一个「是否发送告警」开关。它**只管推送，不管巡检**：关掉之后
# 巡检照跑、告警历史照记，只是飞书 / 邮件 / 通用 Webhook / 站内消息都不再发出。
#
# 为什么不复用各巡检模块策略里的 enabled：那是「巡检总开关」，一关连检查都不跑
# （见 portguard.evaluate 开头的 ``if not policy.get("enabled"): return []``），
# 没有「继续巡检、但先别打扰人」这个中间档 —— 而割接窗口要的正是这个中间档：
# 告警不想发，但也不想让巡检停掉、事后什么记录都没有。
#
# 开关是**全局**的：端口/SSH/远程/备份四个来源的接收人由策略里的 notify_user
# 决定（通常是管理员），资源规则虽按用户隔离，但一条规则触发时也只该有一个
# 「发不发」的结论。所以这是管理员权限的操作，不是每用户一份。
NOTIFY_SOURCES: List[Dict[str, str]] = [
    {
        "id": "resource",
        "label": "资源告警",
        "description": "CPU / 内存 / 磁盘的阈值规则及其恢复通知",
    },
    {
        "id": "portguard",
        "label": "端口与进程巡检",
        "description": "对外开放端口、可疑进程",
    },
    {
        "id": "sshguard",
        "label": "本机 SSH 安全",
        "description": "登录爆破、恶意 IP、账号异常",
    },
    {
        "id": "sshremote",
        "label": "远程主机 SSH 巡检",
        "description": "受管远程主机的登录安全",
    },
    {
        "id": "backupguard",
        "label": "受保护备份核对",
        "description": "受保护备份丢失或被改动",
    },
]

NOTIFY_SOURCE_IDS = tuple(item["id"] for item in NOTIFY_SOURCES)
# 审计日志里要把 id 翻成人话，否则「关掉了 portguard」没人看得懂
NOTIFY_LABELS = {item["id"]: item["label"] for item in NOTIFY_SOURCES}

# 各调用点用的常量。写成常量而不是散落的字面量：拼错一个字母不会报错，只会
# 让那一路的告警永远发不出去 —— 那是排查起来最费劲的一类故障。
SOURCE_RESOURCE = "resource"
SOURCE_PORTGUARD = "portguard"
SOURCE_SSHGUARD = "sshguard"
SOURCE_SSHREMOTE = "sshremote"
SOURCE_BACKUPGUARD = "backupguard"

NOTIFY_SOURCES_KEY = "alert_notify_sources"

# 停推时统一用这一句，前端和历史列表都靠它认出「这不是发送失败，是被关掉了」
MUTED_DETAIL = "该来源已停止推送告警（仅记录历史）"

# 告警历史的投递结果。``muted`` 是「主动静默」而不是「发失败」：
# 两者都不算送达，但意义完全相反 —— 前者是运维自己关的，后者是真出问题了。
# 混成一个 failed 会让割接窗口结束后历史页红成一片，真正的发送故障反而淹没
# 在里面，这正是最该被一眼看到的东西。
RESULT_SENT = "sent"
RESULT_MUTED = "muted"


def default_notify_sources() -> Dict[str, bool]:
    """默认全开：升级后不会突然少收到本该收到的告警。"""
    return {source_id: True for source_id in NOTIFY_SOURCE_IDS}


async def load_notify_sources() -> Dict[str, bool]:
    """读推送来源开关。缺失 / 损坏一律回落默认全开。"""
    cfg = default_notify_sources()
    raw = await store.get_setting(NOTIFY_SOURCES_KEY)
    if not raw:
        return cfg
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("推送来源开关不是合法 JSON，已按默认全开处理")
        return cfg
    if not isinstance(data, dict):
        return cfg
    for source_id in NOTIFY_SOURCE_IDS:
        if source_id in data:
            cfg[source_id] = bool(data[source_id])
    return cfg


async def save_notify_sources(raw: Dict[str, Any]) -> Dict[str, bool]:
    """保存推送来源开关。只接受注册表里认得的来源，其余键忽略。"""
    cfg = await load_notify_sources()
    for source_id in NOTIFY_SOURCE_IDS:
        if source_id in raw:
            cfg[source_id] = bool(raw[source_id])
    await store.set_setting(NOTIFY_SOURCES_KEY, json.dumps(cfg, ensure_ascii=False))
    return cfg


async def push_enabled(source: str) -> bool:
    """该来源当前是否允许推送。

    未知来源（含空串）一律放行：宁可多推一条，也不要因为某个调用点把来源名
    写错就让整类告警静默 —— 静默是「谁都收不到」的故障，最难被发现。
    """
    if source not in NOTIFY_SOURCE_IDS:
        return True
    return (await load_notify_sources()).get(source, True)


def alert_email_key(owner: str) -> str:
    """告警邮件配置的存储 key：每个用户各自一份。"""
    return ALERT_EMAIL_KEY_PREFIX + str(owner or "")


class FeishuConfigError(ValueError):
    """飞书通知配置不合法。"""


def _now_text(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts if ts else time.time()))


# 告警状态（谁正在告警）落库保存，进程重启后依然能识别「恢复正常」并补发恢复通知
ACTIVE_COLUMNS = (
    "alarm_key",
    "username",
    "rule_id",
    "rule_name",
    "target_type",
    "target",
    "metric",
    "value",
    "threshold",
    "node",
    "ip",
    "vmid",
    "ts",
)


# 主键 / 索引列定长，需要默认值的列不能用 TEXT（MySQL 的 TEXT 不允许 DEFAULT）
SCHEMA = """
CREATE TABLE IF NOT EXISTS alert_history (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    username    VARCHAR(64) NOT NULL DEFAULT '',
    rule_id     VARCHAR(64),
    rule_name   VARCHAR(128),
    target_type VARCHAR(32),
    target      VARCHAR(255),
    metric      VARCHAR(64),
    value       DOUBLE,
    threshold   DOUBLE,
    result      VARCHAR(32),
    detail      TEXT,
    kind        VARCHAR(16) DEFAULT 'alarm',
    ts          BIGINT,
    PRIMARY KEY (id),
    KEY idx_alert_history_owner (username, ts DESC),
    KEY idx_alert_history_ts (ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS alert_active (
    alarm_key   VARCHAR(255) NOT NULL,
    username    VARCHAR(64) NOT NULL DEFAULT '',
    rule_id     VARCHAR(64),
    rule_name   VARCHAR(128),
    target_type VARCHAR(32),
    target      VARCHAR(255),
    metric      VARCHAR(64),
    value       DOUBLE,
    threshold   DOUBLE,
    node        VARCHAR(64),
    ip          VARCHAR(64),
    vmid        VARCHAR(32),
    ts          BIGINT,
    PRIMARY KEY (alarm_key),
    KEY idx_alert_active_owner (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        # 旧库补列：kind（alarm / recovery）与归属（按用户隔离）都要补
        columns = await database.table_columns(db, "alert_history")
        if "kind" not in columns:
            # MySQL 的 TEXT 列不允许默认值，补列时用定长字符串
            await db.execute(
                "ALTER TABLE alert_history ADD COLUMN kind VARCHAR(16) DEFAULT 'alarm'"
            )
        if "username" not in columns:
            await db.execute(
                "ALTER TABLE alert_history ADD COLUMN username VARCHAR(64) NOT NULL DEFAULT ''"
            )
        columns = await database.table_columns(db, "alert_active")
        if "username" not in columns:
            await db.execute(
                "ALTER TABLE alert_active ADD COLUMN username VARCHAR(64) NOT NULL DEFAULT ''"
            )
        # 归属进了主键，key 会变长（旧表的 191 位不够装）
        cursor = await db.execute(
            "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns"
            " WHERE table_schema = DATABASE() AND table_name = 'alert_active'"
            " AND column_name = 'alarm_key'"
        )
        row = await cursor.fetchone()
        if row and row[0] is not None and int(row[0]) < 255:
            await db.execute(
                "ALTER TABLE alert_active MODIFY COLUMN alarm_key VARCHAR(255) NOT NULL"
            )
        await db.commit()


async def load_rules() -> List[Dict[str, Any]]:
    raw = await store.get_setting(RULES_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def normalise_rule(raw: Any, username: Optional[str] = None) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    try:
        threshold = float(item.get("threshold") or 80)
    except (TypeError, ValueError):
        threshold = 80.0
    metric = item.get("metric")
    return {
        "id": str(item.get("id") or str(int(time.time() * 1000))),
        "name": str(item.get("name") or "告警规则").strip(),
        "target_type": "vm" if item.get("target_type") == "vm" else "node",
        "target": str(item.get("target") or "*").strip() or "*",
        "metric": metric if metric in METRIC_LABELS else "cpu",
        "threshold": max(1.0, min(100.0, threshold)),
        "enabled": bool(item.get("enabled", True)),
        # 归属：新建的规则落到当前登录用户名下，已有归属原样保留
        "username": str(item.get("username") or username or "").strip()[:64],
    }


async def save_rules(rules: List[Dict[str, Any]]) -> None:
    await store.set_setting(RULES_KEY, json.dumps(rules, ensure_ascii=False))


def _dedupe_by_id(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 id 合并重复条目，同一 id 只保留一份。

    历史数据里同一条规则可能存了多份（升级前没有归属的旧条目 + 认领后的副本），
    直接拼接会让规则数每保存一次就增长一批。合并时字段取靠后提交的那份，
    ``enabled`` 取「都启用才启用」：只要有一份是停用的，结果就是停用，
    避免规则被意外重新启用。
    """
    merged: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for rule in rules:
        rid = str(rule.get("id"))
        if rid in merged:
            previous = merged[rid]
            rule = {
                **rule,
                "enabled": bool(previous.get("enabled")) and bool(rule.get("enabled")),
            }
        else:
            order.append(rid)
        merged[rid] = rule
    return [merged[rid] for rid in order]


async def save_rules_for(rules: Any, username: str) -> List[Dict[str, Any]]:
    """保存规则集合：整体替换 ``username`` 名下的规则，别人的原样保留。

    列表里出现的他人规则一律忽略（以库里为准），既防止越权改别人的规则，也避免
    管理员页面长时间未刷新就把别人新加的规则冲掉。

    同 id 的库中旧条目要被本次提交「取代」而不是并存：升级前的规则没有归属，
    提交时会被认领到当前用户名下，若库里的无主副本继续保留，每保存一次就会多出
    一批同名规则（且副本不受停用影响，照样参与检测）。最后按 id 兜底去重，
    顺带清掉历史遗留的重复份。
    """
    items = [item for item in rules if isinstance(item, dict)] if isinstance(rules, list) else []
    incoming = [normalise_rule(item, username) for item in items]
    own = [{**rule, "username": username} for rule in incoming if owner_of(rule) == username]
    own_ids = {str(rule.get("id")) for rule in own}
    others = [
        rule
        for rule in await load_rules()
        if owner_of(rule) != username and str(rule.get("id")) not in own_ids
    ]
    merged = _dedupe_by_id(others + own)
    await save_rules(merged)
    return merged


def valid_webhook(url: str) -> bool:
    """只接受 http(s) 的完整 URL，避免把无效地址加密存进库里。"""
    if not url:
        return True
    parts = urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def mask_webhook(url: str) -> str:
    """Webhook 打码：保留域名与路径结构，只隐藏最后一段令牌。"""
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return crypto.mask(url)
    segments = [seg for seg in parts.path.split("/") if seg]
    if segments:
        segments[-1] = crypto.mask(segments[-1], 4, 4)
    path = "/" + "/".join(segments) if segments else ""
    return parts.scheme + "://" + parts.netloc + path


async def _persist_feishu(
    cfg: Dict[str, Any], keep: Optional[Dict[str, str]] = None, owner: str = ""
) -> None:
    """把明文配置加密后写入该用户的 key；``keep`` 里的字段按原样保留。"""
    preserved = keep or {}
    stored = dict(cfg)
    for key in SENSITIVE_KEYS:
        stored[key] = preserved.get(key) or crypto.encrypt(str(cfg.get(key) or ""))
    await store.set_setting(feishu_key(owner), json.dumps(stored, ensure_ascii=False))


async def load_feishu(owner: str = "") -> Dict[str, Any]:
    """读取某个用户的飞书通知配置并解密敏感字段；历史明文会自动迁移为密文。"""
    raw = await store.get_setting(feishu_key(owner))
    if raw is None and owner and owner == await store.first_admin_username():
        # 升级前的那份全局配置继续对管理员生效，直到他重新保存
        raw = await store.get_setting(LEGACY_FEISHU_KEY)
    cfg = dict(DEFAULT_FEISHU)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                cfg.update(data)
        except ValueError:
            pass
    plaintext_found = False
    unreadable: Dict[str, str] = {}
    for key in SENSITIVE_KEYS:
        value = str(cfg.get(key) or "")
        if not value:
            continue
        if crypto.is_encrypted(value):
            plain = crypto.decrypt(value)
            if plain:
                cfg[key] = plain
            else:
                # 密文解不开（如 secret_key 被更换）：按未配置处理，但保留原密文
                logger.warning("飞书配置 %s 解密失败，请检查 secret_key 是否被更换", key)
                cfg[key] = ""
                unreadable[key] = value
        else:
            plaintext_found = True
    if plaintext_found:
        try:
            await _persist_feishu(cfg, keep=unreadable, owner=owner)
            logger.info("已将历史明文的飞书通知配置加密存储")
        except Exception:  # pragma: no cover - 迁移失败不影响读取
            logger.exception("飞书通知配置加密迁移失败")
    return cfg


async def save_feishu(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存某个用户的飞书配置：敏感字段加密落库，空值表示沿用旧值。"""
    current = await load_feishu(owner)
    try:
        cooldown = int(raw.get("cooldown") or 600)
    except (TypeError, ValueError):
        cooldown = 600

    webhook = str(raw.get("webhook") or "").strip()
    if not webhook and not raw.get("webhook_clear"):
        webhook = str(current.get("webhook") or "")
    secret = str(raw.get("secret") or "").strip()
    if not secret and not raw.get("secret_clear"):
        secret = str(current.get("secret") or "")

    if not valid_webhook(webhook):
        raise FeishuConfigError("Webhook 地址需要是完整的 http(s) 链接")

    cfg = {
        "webhook": webhook,
        "secret": secret,
        "enabled": bool(raw.get("enabled", True)),
        "cooldown": max(60, cooldown),
        # 这里的空串是**有效值**（= 用站点名称），不像 webhook / secret 那样
        # 表示「不改」——「清掉自定义标题」正是用户会做的动作
        "title": _clean_title(raw.get("title")),
    }
    await _persist_feishu(cfg, owner=owner)
    return cfg


def _clean_title(value: Any) -> str:
    """告警卡片标题里的名字：去空白、限长；空串 = 用面板名称。"""
    return str(value or "").strip()[:MAX_TITLE_BRAND]


async def resolve_title_brand(cfg: Dict[str, Any]) -> str:
    """卡片标题里的名字：用户填的优先，留空用「设置 → 站点信息」的面板名称。

    之所以收口成一个函数：告警卡片由 alerting / sshguard / portguard /
    backupguard / sshremote 五处拼出来，标题里都写死着 ``DEFAULT_TITLE_BRAND``，
    改名只能在这一处做。
    """
    custom = _clean_title((cfg or {}).get("title"))
    if custom:
        return custom
    try:
        info = await site.get_site_info()
        name = _clean_title(info.get("name"))
        return name or DEFAULT_TITLE_BRAND
    except Exception:  # 站点信息读不到，不该让告警发不出去
        logger.warning("读取站点名称失败，卡片标题回落内置名", exc_info=True)
        return DEFAULT_TITLE_BRAND


def _apply_title_brand(card: Dict[str, Any], brand: str) -> Dict[str, Any]:
    """把卡片大标题里的产品名换成 ``brand``。没命中就原样返回，且不改动入参。"""
    if not brand or brand == DEFAULT_TITLE_BRAND:
        return card
    header = card.get("header")
    if not isinstance(header, dict):
        return card
    title = header.get("title")
    if not isinstance(title, dict):
        return card
    content = str(title.get("content") or "")
    if DEFAULT_TITLE_BRAND not in content:
        return card
    return {
        **card,
        "header": {
            **header,
            "title": {
                **title,
                "content": content.replace(DEFAULT_TITLE_BRAND, brand),
            },
        },
    }


# ------------------------------------------------------- 通用 Webhook（按用户）
def webhook_key(owner: str) -> str:
    """通用 Webhook 配置的存储 key：每个用户各自一份。"""
    return WEBHOOK_KEY_PREFIX + str(owner or "")


async def _persist_webhook(
    cfg: Dict[str, Any], keep: Optional[Dict[str, str]] = None, owner: str = ""
) -> None:
    """与飞书配置同一套：地址与签名密钥加密后再落库。"""
    preserved = keep or {}
    stored = dict(cfg)
    for key in SENSITIVE_KEYS:
        stored[key] = preserved.get(key) or crypto.encrypt(str(cfg.get(key) or ""))
    await store.set_setting(webhook_key(owner), json.dumps(stored, ensure_ascii=False))


async def load_webhook(owner: str = "") -> Dict[str, Any]:
    """读取某个用户的通用 Webhook 配置并解密敏感字段。"""
    cfg = dict(DEFAULT_WEBHOOK)
    raw = await store.get_setting(webhook_key(owner))
    if not raw:
        return cfg
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("通用 Webhook 配置不是合法 JSON，已忽略（owner=%s）", owner or "-")
        return cfg
    if not isinstance(data, dict):
        return cfg

    unreadable: Dict[str, str] = {}
    plaintext_found = False
    for field, value in data.items():
        if field not in cfg:
            continue
        if field in SENSITIVE_KEYS and isinstance(value, str) and value:
            if crypto.is_encrypted(value):
                plain = crypto.decrypt(value)
                if not plain:
                    # 密钥换了之类的解不开：保留密文，别把配置写坏
                    unreadable[field] = value
                    continue
                cfg[field] = plain
            else:
                cfg[field] = value
                plaintext_found = True
        else:
            cfg[field] = value

    if plaintext_found:
        try:
            await _persist_webhook(cfg, keep=unreadable, owner=owner)
            logger.info("已将历史明文的通用 Webhook 配置加密存储")
        except Exception:  # pragma: no cover - 迁移失败不影响读取
            logger.exception("通用 Webhook 配置加密迁移失败")
    return cfg


async def save_webhook(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存通用 Webhook 配置。

    与飞书配置同一约定：敏感字段留空 = 沿用旧值，要清除得显式带 ``*_clear``。
    """
    current = await load_webhook(owner)

    webhook = str(raw.get("webhook") or "").strip()
    if not webhook and not raw.get("webhook_clear"):
        webhook = str(current.get("webhook") or "")
    secret = str(raw.get("secret") or "").strip()
    if not secret and not raw.get("secret_clear"):
        secret = str(current.get("secret") or "")

    if not valid_webhook(webhook):
        raise WebhookConfigError("Webhook 地址需要是完整的 http(s) 链接")

    template = str(raw.get("template") or "").strip()
    if template:
        _validate_template(template)

    try:
        cooldown = int(raw.get("cooldown") or 600)
    except (TypeError, ValueError):
        cooldown = 600

    cfg = {
        "webhook": webhook,
        "secret": secret,
        "enabled": bool(raw.get("enabled", False)),
        "cooldown": max(60, cooldown),
        "template": template,
        "headers": str(raw.get("headers") or "").strip(),
    }
    # 请求头是 JSON 对象文本；不合法就拒掉，别等到发告警时才发现
    if cfg["headers"]:
        try:
            parsed = json.loads(cfg["headers"])
        except (TypeError, ValueError) as exc:
            raise WebhookConfigError("自定义请求头需要是合法的 JSON 对象") from exc
        if not isinstance(parsed, dict):
            raise WebhookConfigError("自定义请求头需要是 JSON 对象（形如 {\"Key\":\"value\"}）")

    await _persist_webhook(cfg, owner=owner)
    return cfg


def _validate_template(template: str) -> None:
    """模板必须是合法 JSON（占位符先替换成空串再解析）。

    提前拦住：模板写坏了却要等到真出告警时才发现通知发不出去，代价太高。
    """
    probe = _PLACEHOLDER_RE.sub("", template)
    try:
        json.loads(probe)
    except (TypeError, ValueError) as exc:
        raise WebhookConfigError(
            "请求体模板不是合法 JSON（占位符会替换成文本，其余部分需符合 JSON 语法）"
        ) from exc


def render_webhook_body(template: str, context: Dict[str, Any]) -> str:
    """把 ``{{占位符}}`` 替换成实际值，返回请求体文本。

    替换值按 **JSON 字符串字面量** 转义：模板里的占位符总是写在引号内，而对象名、
    详情这类内容可能自带引号或反斜杠（``web-01"``、``C:\\data``）。不转义的话轻则
    请求体非法、渠道端 400，重则直接改掉了整段 JSON 的结构。
    """
    source = template or DEFAULT_WEBHOOK_TEMPLATE

    def substitute(match: "re.Match[str]") -> str:
        value = context.get(match.group(1))
        if value is None:
            return ""
        # json.dumps 会带上首尾引号，去掉它们把引号留给模板自己
        return json.dumps(str(value), ensure_ascii=False)[1:-1]

    return _PLACEHOLDER_RE.sub(substitute, source)


def webhook_signature(secret: str, ts: int, body: str) -> str:
    """``HMAC-SHA256(secret, f"{ts}\\n{body}")`` 的十六进制摘要。

    把时间戳一起签进去（而不是只签 body）：否则抓到一次请求就能无限重放。
    接收端应先校验时间戳在可接受窗口内，再比对签名。
    """
    message = f"{ts}\n{body}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _parse_extra_headers(raw: str) -> Dict[str, str]:
    """自定义请求头（JSON 对象文本）→ dict；解析失败当作没有。"""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items()}


async def send_webhook(
    title: str,
    text: str,
    context: Optional[Dict[str, Any]] = None,
    owner: str = "",
    cfg: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str]:
    """把一条告警投递到用户配置的通用 Webhook。

    ``cfg`` 可由调用方预先读好传进来（一轮评估里多个规则共用同一份配置，
    省掉每告警一次库读）。
    """
    config = cfg if cfg is not None else await load_webhook(owner)
    if not config.get("enabled"):
        return False, "未启用通用 Webhook"

    url = str(config.get("webhook") or "")
    if not url:
        return False, "未配置通用 Webhook 地址"
    if not valid_webhook(url):
        return False, "Webhook 地址不是合法的 http(s) 链接"

    payload = dict(context or {})
    payload.setdefault("level", "alarm")
    payload.setdefault("title", title)
    payload.setdefault("text", text)
    payload.setdefault("time", _now_text())

    body = render_webhook_body(str(config.get("template") or ""), payload)

    headers: Dict[str, str] = {"Content-Type": "application/json; charset=utf-8"}
    headers.update(_parse_extra_headers(str(config.get("headers") or "")))
    headers.setdefault("X-Panel-Event", "alert")

    secret = str(config.get("secret") or "")
    if secret:
        ts = int(time.time())
        headers["X-Panel-Timestamp"] = str(ts)
        headers["X-Panel-Signature"] = "sha256=" + webhook_signature(secret, ts, body)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                url, content=body.encode("utf-8"), headers=headers
            )
    except httpx.HTTPError as exc:
        return False, "发送失败：" + str(exc)

    if resp.status_code >= 300:
        return False, "HTTP " + str(resp.status_code) + "：" + resp.text[:160]
    return True, "已发送"


# ------------------------------------------------------- 告警邮件通道（按用户）
class AlertEmailConfigError(ValueError):
    """告警邮件配置不合法。"""


async def load_alert_email(owner: str = "") -> Dict[str, Any]:
    """某个用户的告警邮件配置。

    收件人是**明文**存的不加密：它不算密钥，而且用户自己要看得到自己填了什么。
    真正敏感的是发信用的 SMTP 密码，那是全局配置，见 :mod:`app.mailer`。
    """
    cfg = dict(DEFAULT_ALERT_EMAIL)
    raw = await store.get_setting(alert_email_key(owner))
    if raw:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            cfg.update(parsed)

    cfg["enabled"] = bool(cfg.get("enabled"))
    cfg["recipients"] = ",".join(mailer.recipients_of(cfg.get("recipients")))
    return cfg


async def save_alert_email(raw: Dict[str, Any], owner: str = "") -> Dict[str, Any]:
    """保存某个用户的告警邮件配置。收件人留空 = 用账号邮箱。"""
    recipients = mailer.recipients_of(raw.get("recipients"))
    for item in recipients:
        if "@" not in item:
            raise AlertEmailConfigError("收件地址格式不正确：" + item)

    cfg = {
        "enabled": bool(raw.get("enabled")),
        "recipients": ",".join(recipients),
    }
    await store.set_setting(
        alert_email_key(owner), json.dumps(cfg, ensure_ascii=False)
    )
    return cfg


async def resolve_email_recipients(owner: str) -> List[str]:
    """这条告警实际该发给谁：填了收件地址就用它，否则退回账号邮箱。"""
    cfg = await load_alert_email(owner)
    if not cfg.get("enabled"):
        return []
    explicit = mailer.recipients_of(cfg.get("recipients"))
    if explicit:
        return explicit
    if not owner:
        return []
    record = await store.get_user(owner) or {}
    return mailer.recipients_of(record.get("email"))


async def send_alert_email(
    owner: str, title: str, text: str
) -> Tuple[bool, str]:
    """把一条告警 / 恢复通知发到该用户的收件箱。"""
    targets = await resolve_email_recipients(owner)
    if not targets:
        return False, "未配置收件地址"

    cfg = await mailer.load_mail()
    if not mailer.is_configured(cfg):
        return False, "SMTP 未配置"

    lines = [line for line in text.splitlines() if line.strip()]
    subject, body, html = mailer.alert_mail(title, lines)
    return await mailer.send_mail(targets, subject, body, html=html, cfg=cfg)


async def dispatch(
    owner: str,
    feishu: Dict[str, Any],
    email_cfg: Dict[str, Any],
    title: str,
    text: str,
    card: Dict[str, Any],
    webhook: Optional[Dict[str, Any]] = None,
    context: Optional[Dict[str, Any]] = None,
    source: str = "",
) -> Tuple[bool, str]:
    """按用户配置的通道发一条通知：飞书 + 邮件 + 通用 Webhook，任一送达即算送达。

    ``webhook`` 可由调用方预先读好传进来 —— 一轮评估里同一个用户的多个规则会
    触发多次 dispatch，逐次读库没有意义。不传则现读。

    ``source`` 是告警来源（见 NOTIFY_SOURCES）。该来源被停推时直接返回，一个
    通道都不碰。判定放在**最前面**：停推时连长啥样都不该去读库。

    三个通道都没开时保持原提示「告警通知已停用，仅记录」，
    免得历史行为被这次改动改掉。
    """
    if source and not await push_enabled(source):
        return False, MUTED_DETAIL

    if webhook is None:
        webhook = await load_webhook(owner)

    if not (
        feishu.get("enabled")
        or email_cfg.get("enabled")
        or webhook.get("enabled")
    ):
        return False, "告警通知已停用，仅记录"

    channels: List[str] = []
    delivered = False
    if feishu.get("enabled"):
        ok, detail = await send_feishu(card, owner)
        delivered = delivered or ok
        channels.append("飞书：" + detail)
    if email_cfg.get("enabled"):
        ok, detail = await send_alert_email(owner, title, text)
        delivered = delivered or ok
        channels.append("邮件：" + detail)
    if webhook.get("enabled"):
        ok, detail = await send_webhook(title, text, context, owner, cfg=webhook)
        delivered = delivered or ok
        channels.append("Webhook：" + detail)
    return delivered, "；".join(channels)


def _sign(secret: str, ts: int) -> str:
    message = str(ts) + chr(10) + secret
    digest = hmac.new(message.encode("utf-8"), b"", hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def build_card(
    level: str,
    title: str,
    subtitle: str,
    fields: List[Tuple[str, str]],
    note: str,
) -> Dict[str, Any]:
    """组装飞书交互式卡片（interactive card）。"""
    elements: List[Dict[str, Any]] = []
    if fields:
        elements.append(
            {
                "tag": "div",
                "fields": [
                    {
                        "is_short": True,
                        "text": {"tag": "lark_md", "content": "**" + name + "**\n" + value},
                    }
                    for name, value in fields
                ],
            }
        )
    elements.append({"tag": "hr"})
    elements.append({"tag": "note", "elements": [{"tag": "plain_text", "content": note}]})
    header: Dict[str, Any] = {
        "template": CARD_TEMPLATES.get(level, "blue"),
        "title": {"tag": "plain_text", "content": title},
    }
    if subtitle:
        header["subtitle"] = {"tag": "plain_text", "content": subtitle}
    return {"config": {"wide_screen_mode": True}, "header": header, "elements": elements}


def build_alert_card(
    rule: Dict[str, Any],
    *,
    kind: str,
    label: str,
    metric: str,
    value: float,
    threshold: float,
    node: str,
    status: str,
    ip: str = "",
    vmid: Optional[Any] = None,
    at: Optional[float] = None,
    cooldown: int = 0,
    target_type: str = "",
) -> Dict[str, Any]:
    """告警卡片。

    分两类：使用率类展示「当前值 / 阈值」；状态类（离线、备份失败）展示
    「期望 / 实际状态」—— 给离线硬套一个百分比只会让人看不懂。
    """
    metric_label = METRIC_LABELS.get(metric, str(metric))
    state_metric = metric in STATE_METRICS
    # 状态类本身就是严重级别，不存在「离阈值的远近」
    critical = state_metric or value >= 90 or value >= threshold + 10
    title = ("🔴 " if critical else "🟠 ") + "ProxCenter " + (
        "状态告警" if state_metric else "资源告警"
    )

    target = kind + " · " + label
    if vmid:
        target += "（VMID " + str(vmid) + "）"
    fields: List[Tuple[str, str]] = [
        # 虚拟机显示 IP，宿主机显示面板接入该节点的地址
        ("告警对象", target),
        ("IP 地址" if vmid else "接入地址", ip or "未获取"),
    ]
    if vmid:
        fields.append(("所在节点", node or "-"))
    fields.append(("监控指标", metric_label))
    if state_metric:
        fields.append(
            ("期望状态", EXPECTED_STATUS.get(target_type or "vm", "running"))
        )
        fields.append(("实际状态", "**" + (status or "-") + "**"))
    else:
        fields.append(("当前值", "**" + format(value, ".1f") + "%**"))
        fields.append(("触发阈值", format(threshold, ".0f") + "%"))
        # 状态型指标上面已经给出「实际状态」，这里再来一行只会重复
        fields.append(("运行状态", status or "-"))

    note = "触发时间 " + _now_text(at)
    if state_metric:
        note += " · 恢复后会自动发送通知"
    if cooldown:
        note += " · " + str(cooldown) + " 秒内同一对象不重复提醒"
    return build_card(
        "critical" if critical else "warning",
        title,
        str(rule.get("name") or "告警规则"),
        fields,
        note,
    )


def build_recovery_card(
    row: Dict[str, Any],
    value: Optional[float] = None,
    at: Optional[float] = None,
) -> Dict[str, Any]:
    """告警恢复卡片：指标回落或被监控对象恢复可用时发送。"""
    metric_label = METRIC_LABELS.get(row.get("metric"), str(row.get("metric") or "-"))
    vmid = row.get("vmid")
    is_vm = str(row.get("target_type")) == "vm"
    kind = "虚拟机" if is_vm else "宿主机"

    target = kind + " · " + str(row.get("target") or "-")
    if vmid:
        target += "（VMID " + str(vmid) + "）"
    fields: List[Tuple[str, str]] = [
        ("告警对象", target),
        ("IP 地址" if is_vm else "接入地址", str(row.get("ip") or "") or "未获取"),
    ]
    if is_vm:
        fields.append(("所在节点", str(row.get("node") or "-")))
    fields.append(("监控指标", metric_label))
    if str(row.get("metric") or "") in STATE_METRICS:
        # 状态型指标没有百分比可回落，直接陈述「已恢复正常」
        fields.append(("恢复状态", "**已恢复正常**"))
        reason = "对象已回到期望状态，告警自动解除"
    elif isinstance(value, (int, float)):
        fields.append(("当前值", "**" + format(value, ".1f") + "%**"))
        fields.append(
            ("触发阈值", format(float(row.get("threshold") or 0), ".0f") + "%")
        )
        reason = "指标已回落至阈值以下，告警解除"
    else:
        fields.append(("当前值", "已恢复"))
        reason = "对象已恢复可用，告警自动解除"
    return build_card(
        "success",
        "✅ ProxCenter 告警恢复",
        str(row.get("rule_name") or "告警规则"),
        fields,
        "恢复时间 " + _now_text(at) + " · " + reason,
    )


def build_test_card() -> Dict[str, Any]:
    """连通性测试卡片。"""
    return build_card(
        "success",
        "✅ ProxCenter 通知测试",
        "告警通道连通性验证",
        [
            ("通知渠道", "飞书机器人"),
            ("消息类型", "交互式卡片"),
            ("发送时间", _now_text()),
            ("通道状态", "✅ 正常"),
        ],
        "收到这条消息，说明飞书机器人配置正确，可以正常接收 ProxCenter 告警。",
    )


async def send_feishu(card: Dict[str, Any], owner: str = "") -> Tuple[bool, str]:
    """推送一张交互式卡片到该用户的飞书群机器人。"""
    cfg = await load_feishu(owner)
    webhook = cfg.get("webhook") or ""
    if not webhook:
        return False, "未配置飞书机器人 Webhook"
    if not valid_webhook(webhook):
        return False, "Webhook 地址不是合法的 http(s) 链接"
    # 卡片标题里的产品名换成用户配置的名字 —— 所有飞书卡片都从这里出门，
    # 收口在这一处，五个拼卡片的模块不用各改一遍
    card = _apply_title_brand(card, await resolve_title_brand(cfg))
    payload: Dict[str, Any] = {"msg_type": "interactive", "card": card}
    secret = cfg.get("secret") or ""
    if secret:
        ts = int(time.time())
        payload["timestamp"] = str(ts)
        payload["sign"] = _sign(secret, ts)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(webhook, json=payload)
    except httpx.HTTPError as exc:
        return False, "发送失败：" + str(exc)
    if resp.status_code != 200:
        return False, "飞书返回 HTTP " + str(resp.status_code) + "：" + resp.text[:160]
    try:
        body = resp.json()
    except ValueError:
        return True, "已发送"
    if body.get("code") not in (0, None):
        return False, "飞书返回错误：" + str(body.get("msg"))
    return True, "已发送"


async def record(entry: Dict[str, Any], *, source: str = "") -> None:
    """记一条告警历史，并给规则归属者留一条站内消息。

    两件事放在一处，是因为它们描述的是同一个事件、且必须同时发生：
    「这条告警发生了」与「该有人知道」。分开写迟早会出现「历史里有、铃铛上没有」
    这种漏报 —— 而铃铛正是外部通道没配或发失败时的兜底。

    例外只有一个：来源被停推（``source`` 对应的开关关掉了）。这时**历史照写、
    站内消息不发** —— 停推的语义是「彻底静默」，只留一份可事后追溯的记录。
    历史仍然照写很关键：否则「停推期间到底有没有出事」就无从查证，那就不是
    静默而是失明了。
    """
    # 归一化投递结果放在这里，而不是让十个调用点各自判断：record 是历史唯一的
    # 写入口，判定只写一遍就不会出现「有的地方标 muted、有的地方标 failed」。
    # 条件是「来源被停推 **且** 确实没送达」—— 后者不能省：万一某个调用点把
    # source 传给了 record 却忘了传给 dispatch，告警其实真发失败了，不能被
    # 错标成主动静默。
    muted = bool(source) and not await push_enabled(source)
    if muted and entry.get("result") != RESULT_SENT:
        entry["result"] = RESULT_MUTED

    sql = (
        "INSERT INTO alert_history (username, rule_id, rule_name, target_type, target, metric,"
        " value, threshold, result, detail, kind, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    at = int(entry.get("ts") or time.time())
    async with database.connect() as db:
        await db.execute(
            sql,
            (
                str(entry.get("username") or ""),
                entry.get("rule_id", ""),
                entry.get("rule_name", ""),
                entry.get("target_type", ""),
                entry.get("target", ""),
                entry.get("metric", ""),
                entry.get("value", 0),
                entry.get("threshold", 0),
                entry.get("result", ""),
                entry.get("detail", ""),
                entry.get("kind", "alarm"),
                at,
            ),
        )
        await db.commit()

    if muted:
        return
    await notifications.push_alert(entry, created=at)


async def load_active() -> Dict[str, Dict[str, Any]]:
    """读取当前处于告警状态的对象。"""
    async with database.connect() as db:
        cursor = await db.execute("SELECT * FROM alert_active")
        rows = await cursor.fetchall()
    return {str(r["alarm_key"]): dict(r) for r in rows}


async def mark_active(key: str, row: Dict[str, Any]) -> None:
    """记录 / 刷新某个对象的告警状态（同时充当冷却时间戳）。"""
    values = [key] + [row.get(col) for col in ACTIVE_COLUMNS[1:]]
    sql = database.upsert_sql(
        "alert_active",
        list(ACTIVE_COLUMNS),
        ["alarm_key"],
        list(ACTIVE_COLUMNS[1:]),
    )
    async with database.connect() as db:
        await db.execute(sql, values)
        await db.commit()


async def clear_active(key: str) -> None:
    async with database.connect() as db:
        await db.execute("DELETE FROM alert_active WHERE alarm_key = ?", (key,))
        await db.commit()


async def history(limit: int = 100, owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """告警历史：``owner=None``（管理员）返回全部，否则只返回该用户的。"""
    sql = "SELECT * FROM alert_history"
    params: List[Any] = []
    if owner is not None:
        sql += " WHERE username = ?"
        params.append(owner)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(max(1, min(1000, limit)))
    async with database.connect() as db:
        cursor = await db.execute(sql, tuple(params))
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def stream_history(
    *,
    owner: Optional[str] = None,
    kind: Optional[str] = None,
    batch: int = 2_000,
) -> AsyncIterator[Dict[str, Any]]:
    """流式读取告警历史（导出用），按时间倒序。

    与 :func:`history` 同一套归属口径（``owner=None`` = 管理员看全部），
    但走键集分页，不受 ``history`` 那个 1000 条上限约束。
    """
    where: List[str] = []
    params: List[Any] = []
    if owner is not None:
        where.append("username = ?")
        params.append(owner)
    if kind:
        where.append("kind = ?")
        params.append(kind)

    last_id = 2**63 - 1
    batch = max(1, int(batch))

    while True:
        clause = " AND ".join([*where, "id < ?"])
        async with database.connect() as db:
            cursor = await db.execute(
                f"SELECT * FROM alert_history WHERE {clause} ORDER BY id DESC LIMIT ?",
                [*params, last_id, batch],
            )
            rows = await cursor.fetchall()

        if not rows:
            return
        for row in rows:
            item = dict(row)
            last_id = int(item["id"])
            yield item
        if len(rows) < batch:
            return


async def clear_history(owner: Optional[str] = None) -> int:
    """清空告警历史。正在告警中的状态不受影响，恢复通知照常发送。"""
    sql = "DELETE FROM alert_history"
    params: Tuple[Any, ...] = ()
    if owner is not None:
        sql += " WHERE username = ?"
        params = (owner,)
    async with database.connect() as db:
        cursor = await db.execute(sql, params)
        removed = cursor.rowcount or 0
        await db.commit()
    return removed


def _ratio(res: Dict[str, Any], used_key: str, total_key: str) -> Optional[float]:
    total = res.get(total_key)
    used = res.get(used_key)
    if not isinstance(total, (int, float)) or total <= 0:
        return None
    if not isinstance(used, (int, float)):
        return None
    return max(0.0, min(100.0, (used / total) * 100))


def usage(res: Dict[str, Any], metric: str) -> Optional[float]:
    """把 PVE 的 cluster resources 条目换算成百分比。"""
    if metric == "cpu":
        cpu = res.get("cpu")
        if not isinstance(cpu, (int, float)):
            return None
        return max(0.0, min(100.0, cpu * 100))
    if metric == "mem":
        return _ratio(res, "mem", "maxmem")
    if metric == "disk":
        return _ratio(res, "disk", "maxdisk")
    return None


def _label(res: Dict[str, Any], target_type: str) -> str:
    if target_type == "node":
        return str(res.get("node") or "")
    return str(res.get("name") or res.get("vmid") or "")


# ---------------------------------------------------------------- IP 解析
IPCONFIG_RE = re.compile(r"(?:^|,)\s*ip=([^,]+)")


def _pick_ip(interfaces: List[Dict[str, Any]]) -> str:
    """从 Guest Agent 的网卡列表里挑一个可用的业务地址（优先 IPv4）。"""
    candidates: List[str] = []
    for item in interfaces or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "") == "lo":
            continue
        for addr in item.get("ip-addresses") or []:
            if not isinstance(addr, dict):
                continue
            value = str(addr.get("ip-address") or "").strip()
            if not value:
                continue
            if value.startswith("127.") or value.startswith("169.254."):
                continue
            if value in ("::1",) or value.lower().startswith("fe80"):
                continue
            candidates.append(value)
    for value in candidates:
        if ":" not in value:
            return value
    return candidates[0] if candidates else ""


def _static_ip_from_config(cfg: Dict[str, Any]) -> str:
    """从 VM 配置的 cloud-init / 网卡参数里取静态 IP（DHCP 返回空）。"""
    for key in ("ipconfig0", "net0", "net1", "net2"):
        raw = str((cfg or {}).get(key) or "")
        if not raw:
            continue
        match = IPCONFIG_RE.search(raw)
        if not match:
            continue
        value = match.group(1).split("/")[0].strip()
        if not value or value.lower() in ("dhcp", "auto", "manual", "none"):
            continue
        return value
    return ""


async def resolve_vm_ip(client: Any, node: str, vmid: Any) -> str:
    """尽力解析虚拟机 IP：先问 Guest Agent，再退回配置里的静态地址。"""
    if not node or not vmid:
        return ""
    try:
        interfaces = await asyncio.wait_for(
            client.qemu_agent_network(node, int(vmid)), timeout=5.0
        )
    except Exception:  # agent 未装 / 无响应都不影响告警本身
        interfaces = []
    ip = _pick_ip(interfaces or [])
    if ip:
        return ip
    try:
        cfg = await asyncio.wait_for(
            client.qemu_config(node, int(vmid)), timeout=5.0
        )
    except Exception:
        return ""
    return _static_ip_from_config(cfg or {})


def host_address(client: Any) -> str:
    """面板访问该宿主机所用的 PVE 地址。"""
    return str(getattr(getattr(client, "conn", None), "host", "") or "")


async def evaluate(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """拉取 PVE 资源，检查启用的规则：超阈值发告警，回落则发恢复通知。

    ``owner=None`` 表示评估全部用户（定时任务用）；传用户名则只评估该用户的规则与
    告警状态（用户手动「立即检测」用），通知也只发到他自己配置的飞书机器人。
    """
    await init_table()
    rules = [r for r in await load_rules() if r.get("enabled")]
    if owner is not None:
        rules = [r for r in rules if owner_of(r) == owner]
    enabled_ids = {str(r.get("id")) for r in rules}
    active = await load_active()
    if owner is not None:
        active = {
            key: row
            for key, row in active.items()
            if str(row.get("username") or "") == owner
        }
    if not rules:
        # 规则被全部停用/删除：清理它们的告警状态，避免下次重新启用时误报恢复
        for key, row in active.items():
            if str(row.get("rule_id")) not in enabled_ids:
                await clear_active(key)
        return []
    client = get_client()
    if not client.conn.configured:
        return []
    try:
        resources = await client.cluster_resources()
    except Exception:
        return []
    now = time.time()
    fired: List[Dict[str, Any]] = []
    # 本轮各对象的实测值（key -> 百分比）与仍处于超阈值状态的对象
    measured: Dict[str, float] = {}
    alarming: set = set()
    # 规则按归属分组：同一个用户共用一个飞书通道与冷却时间
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for rule in rules:
        groups.setdefault(owner_of(rule), []).append(rule)
    need_fallback = "" in groups or any(
        not str(row.get("username") or "") for row in active.values()
    )
    fallback = await store.first_admin_username() if need_fallback else ""
    if fallback and "" in groups:
        # 没有归属的规则（手工写进 settings 的旧数据）算作管理员的
        groups.setdefault(fallback, []).extend(groups.pop(""))
    channels: Dict[str, Dict[str, Any]] = {}
    mail_channels: Dict[str, Dict[str, Any]] = {}
    hook_channels: Dict[str, Dict[str, Any]] = {}

    async def channel(name: str) -> Dict[str, Any]:
        """某个用户的飞书通知配置（含 cooldown）；一轮评估里只读一次。"""
        if name not in channels:
            channels[name] = await load_feishu(name)
        return channels[name]

    async def email_channel(name: str) -> Dict[str, Any]:
        """某个用户的告警邮件配置；同样一轮只读一次。"""
        if name not in mail_channels:
            mail_channels[name] = await load_alert_email(name)
        return mail_channels[name]

    async def webhook_channel(name: str) -> Dict[str, Any]:
        """某个用户的通用 Webhook 配置；同样一轮只读一次。"""
        if name not in hook_channels:
            hook_channels[name] = await load_webhook(name)
        return hook_channels[name]

    for rule_owner, owner_rules in groups.items():
        feishu = await channel(rule_owner)
        email_cfg = await email_channel(rule_owner)
        webhook_cfg = await webhook_channel(rule_owner)
        cooldown = int(feishu.get("cooldown") or 600)
        for rule in owner_rules:
            target_type = rule.get("target_type")
            want = rule.get("target") or "*"
            for res in resources:
                if res.get("type") not in RESOURCE_TYPES.get(target_type, set()):
                    continue
                metric = rule.get("metric")
                if target_type == "vm":
                    # 模板一律跳过 —— 它们按设计就不运行。
                    # 使用率类指标需要运行中的数据，关机机器也跳过；
                    # 但「离线」指标恰恰只在未运行时才成立，不能跟着一起跳过，
                    # 否则这个规则永远不会触发（这正是它要解决的问题）。
                    if res.get("template"):
                        continue
                    if metric != "offline" and str(res.get("status")) != "running":
                        continue
                label = _label(res, target_type)
                if want != "*" and want != label and want != str(res.get("vmid") or ""):
                    continue

                if metric in STATE_METRICS:
                    # 状态型指标：不看阈值，只看状态是否偏离预期。
                    # value 固定为 0，卡片与历史记录另行呈现（见 build_alert_card）。
                    expected = EXPECTED_STATUS.get(target_type, "running")
                    if str(res.get("status")) == expected:
                        continue
                    value = 0.0
                    threshold = 0.0
                else:
                    value = usage(res, metric)
                    if value is None:
                        continue
                    threshold = float(rule.get("threshold") or 80)
                    if value < threshold:
                        continue

                # key 带上归属：不同用户的同名规则/对象各自独立计数与冷却
                key = alarm_key(rule_owner, rule.get("id"), label)
                measured[key] = value
                alarming.add(key)
                # 冷却时间以库里的告警状态为准，重启后不会重复轰炸
                last = float((active.get(key) or {}).get("ts") or 0)
                if now - last < cooldown:
                    continue
                metric_label = METRIC_LABELS.get(rule.get("metric"), str(rule.get("metric")))
                kind = "宿主机" if target_type == "node" else "虚拟机"
                node = str(res.get("node") or "-")
                status = str(res.get("status") or "-")
                vmid = res.get("vmid") if target_type == "vm" else None
                # 虚拟机优先取 Guest Agent / cloud-init 里的地址，宿主机用 PVE 接入地址
                if target_type == "vm":
                    ip = await resolve_vm_ip(client, node, vmid)
                else:
                    ip = host_address(client)
                # 纯文本摘要仅用于面板历史记录展示，推送走卡片
                if metric in STATE_METRICS:
                    detail_text = (
                        metric_label + "：异常（期望 "
                        + EXPECTED_STATUS.get(target_type, "running")
                        + "，实际 " + status + "）"
                    )
                else:
                    detail_text = (
                        metric_label + "：" + format(value, ".1f")
                        + "% (阈值 " + format(threshold, ".0f") + "%)"
                    )
                text = (
                    kind + "：" + label + chr(10)
                    + detail_text + chr(10)
                    + ("IP：" + ip + chr(10) if ip else "")
                    + "节点：" + node + chr(10)
                    + "状态：" + status
                )
                card = build_alert_card(
                    rule,
                    kind=kind,
                    label=label,
                    metric=rule.get("metric"),
                    value=value,
                    threshold=threshold,
                    node=node,
                    status=status,
                    ip=ip,
                    vmid=vmid,
                    at=now,
                    cooldown=cooldown,
                    target_type=target_type,
                )
                # 各发各的：用规则归属者自己的通道（飞书 / 邮件 / 通用 Webhook）推送。
                # context 供通用 Webhook 的请求体模板取用（飞书走卡片、邮件走正文，
                # 只有自定义 Webhook 需要这些散字段）。
                alert_title = kind + "：" + label
                ok, detail = await dispatch(
                    rule_owner,
                    feishu,
                    email_cfg,
                    alert_title,
                    text,
                    card,
                    source=SOURCE_RESOURCE,
                    webhook=webhook_cfg,
                    context={
                        "level": "alarm",
                        "title": alert_title,
                        "text": text,
                        "target": label,
                        "target_type": target_type,
                        "metric": metric_label,
                        "value": format(value, ".1f"),
                        "threshold": format(threshold, ".0f"),
                        "node": node,
                        "vmid": "" if vmid is None else vmid,
                        "status": status,
                        "ip": ip,
                        "time": _now_text(now),
                    },
                )
                state = {
                    "username": rule_owner,
                    "rule_id": rule.get("id"),
                    "rule_name": rule.get("name"),
                    "target_type": target_type,
                    "target": label,
                    "metric": rule.get("metric"),
                    "value": round(value, 1),
                    "threshold": threshold,
                    "node": node,
                    "ip": ip,
                    "vmid": vmid,
                    "ts": int(now),
                    # 只给站内消息用来判断该跳 /vms 还是 /lxc：qemu 与 lxc 的
                    # 详情页是两套。mark_active 按固定列写库，多出来的键会被忽略，
                    # 但它会留在内存里的 active 行上，恢复通知也能用上。
                    "guest_type": res.get("type") if target_type == "vm" else "",
                }
                await mark_active(key, state)
                active[key] = dict(state, alarm_key=key)
                entry = {
                    **state,
                    "result": "sent" if ok else "failed",
                    "detail": detail,
                    "kind": "alarm",
                }
                await record(entry, source=SOURCE_RESOURCE)
                entry["text"] = text
                fired.append(entry)

    # ---- 恢复通知：上一轮告警中、本轮已不再超阈值的对象 ----
    enabled_by_owner: Dict[str, set] = {
        name: {str(r.get("id")) for r in owner_rules}
        for name, owner_rules in groups.items()
    }
    for key, row in list(active.items()):
        if key in alarming:
            continue
        row_owner = str(row.get("username") or "") or fallback
        if key != alarm_key(row_owner, row.get("rule_id"), row.get("target")):
            # 旧版（未按用户拆分）遗留的状态：静默清理，不误报恢复
            await clear_active(key)
            continue
        if str(row.get("rule_id")) not in enabled_by_owner.get(row_owner, set()):
            # 规则被停用或删除：静默清理状态，不打扰用户
            await clear_active(key)
            continue
        value = measured.get(key)
        card = build_recovery_card(row, value, at=now)
        recovery_text = (
            str(row.get("target") or "-")
            + " 的 "
            + str(METRIC_LABELS.get(row.get("metric"), row.get("metric")))
            + " 已恢复正常"
        )
        # 谁配置的规则，恢复通知就发给谁
        feishu = await channel(row_owner)
        email_cfg = await email_channel(row_owner)
        recovery_title = "恢复通知：" + str(row.get("target") or "-")
        ok, detail = await dispatch(
            row_owner,
            feishu,
            email_cfg,
            recovery_title,
            recovery_text,
            card,
            source=SOURCE_RESOURCE,
            webhook=await webhook_channel(row_owner),
            context={
                "level": "recovery",
                "title": recovery_title,
                "text": recovery_text,
                "target": row.get("target") or "",
                "target_type": row.get("target_type") or "",
                "metric": METRIC_LABELS.get(
                    row.get("metric"), str(row.get("metric") or "")
                ),
                "value": "" if value is None else format(float(value), ".1f"),
                "threshold": row.get("threshold") or "",
                "node": row.get("node") or "",
                "vmid": row.get("vmid") or "",
                "status": "",
                "ip": row.get("ip") or "",
                "time": _now_text(now),
            },
        )
        entry = {
            "username": row_owner,
            "rule_id": row.get("rule_id"),
            "rule_name": row.get("rule_name"),
            "target_type": row.get("target_type"),
            "target": row.get("target"),
            "metric": row.get("metric"),
            "value": round(value, 1) if isinstance(value, (int, float)) else 0,
            "threshold": row.get("threshold"),
            "result": "sent" if ok else "failed",
            "detail": detail,
            "kind": "recovery",
        }
        await record(entry, source=SOURCE_RESOURCE)
        await clear_active(key)
        entry["text"] = recovery_text
        fired.append(entry)
    return fired
