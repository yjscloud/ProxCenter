"""飞书机器人指令控制：在飞书里对虚拟机执行开机 / 关机 / 重启 / 创建等操作。

与 :mod:`app.alerting` 的关系：那个模块是「面板 → 飞书」的单向告警推送（群机器人
Webhook），本模块是「飞书 → 面板」的双向交互，需要飞书**自建应用**的凭据
（App ID / App Secret），因为要接收事件回调、并在同一个会话里回复消息。

安全约束（这是把一个远程指令入口接到虚拟机上，必须收紧）：

* 默认关闭，需要在页面里显式开启；
* 必须配置群 / 用户白名单，白名单之外的消息一律忽略；
* 写操作用 ``allow_write`` 单独开关，只读指令不受影响；
* 危险操作（关机 / 重启 / 创建）要求卡片二次确认；
* 所有指令结果都写审计日志。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import crypto, defaults, store
from .pve import ProxmoxError, get_client

logger = logging.getLogger(__name__)

SETTING_KEY = "feishu_bot"
OPEN_API = "https://open.feishu.cn/open-apis"

DEFAULT_BOT: Dict[str, Any] = {
    "enabled": False,
    "app_id": "",
    "app_secret": "",
    "verification_token": "",
    "encrypt_key": "",
    "allowed_chat_ids": [],
    "allowed_user_ids": [],
    "allow_write": True,
    "allow_create": True,
    "default_template_vmid": "",
    "default_node": "",
    "default_storage": "",
    "default_backup_storage": "",
    "max_vms": 20,
}

SENSITIVE = ("app_secret", "verification_token", "encrypt_key")


class BotError(ValueError):
    """机器人配置或调用错误。"""


def _as_list(value: Any) -> List[str]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        items = value.replace(",", "\n").split("\n")
    else:
        items = []
    return [str(i).strip() for i in items if str(i).strip()]


async def load_config() -> Dict[str, Any]:
    raw = await store.get_setting(SETTING_KEY)
    cfg = dict(DEFAULT_BOT)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                cfg.update(data)
        except ValueError:
            pass
    for key in SENSITIVE:
        value = str(cfg.get(key) or "")
        cfg[key] = crypto.decrypt(value) if crypto.is_encrypted(value) else value
    return cfg


async def save_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    current = await load_config()
    item = raw if isinstance(raw, dict) else {}
    cfg = dict(current)
    for key in DEFAULT_BOT:
        if key in item:
            cfg[key] = item[key]
    cfg["allowed_chat_ids"] = _as_list(cfg.get("allowed_chat_ids"))
    cfg["allowed_user_ids"] = _as_list(cfg.get("allowed_user_ids"))
    for key in SENSITIVE:
        value = str(item.get(key) or "").strip()
        if not value:
            value = str(current.get(key) or "")
        cfg[key] = value
    cfg["enabled"] = bool(cfg.get("enabled"))
    cfg["allow_write"] = bool(cfg.get("allow_write"))
    cfg["allow_create"] = bool(cfg.get("allow_create"))
    cfg["max_vms"] = max(1, min(100, int(cfg.get("max_vms") or 20)))
    stored = dict(cfg)
    for key in SENSITIVE:
        stored[key] = crypto.encrypt(str(cfg.get(key) or ""))
    await store.set_setting(SETTING_KEY, json.dumps(stored, ensure_ascii=False))
    return cfg


# --------------------------------------------------------------- 校验与鉴权
def verify_signature(headers: Dict[str, str], body: bytes, cfg: Dict[str, Any]) -> Tuple[bool, str]:
    """校验飞书事件签名（配置了 Encrypt Key 时飞书才会带签名）。"""
    encrypt_key = str(cfg.get("encrypt_key") or "")
    signature = str(headers.get("x-lark-signature") or "")
    if not encrypt_key or not signature:
        return True, ""
    timestamp = str(headers.get("x-lark-request-timestamp") or "")
    nonce = str(headers.get("x-lark-request-nonce") or "")
    raw = (timestamp + nonce + encrypt_key).encode("utf-8") + body
    expected = hashlib.sha256(raw).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return False, "飞书事件签名校验失败"
    return True, ""


def check_token(payload: Dict[str, Any], cfg: Dict[str, Any]) -> Tuple[bool, str]:
    token = str(cfg.get("verification_token") or "")
    if not token:
        return True, ""
    header = payload.get("header") or {}
    got = str(payload.get("token") or header.get("token") or "")
    if got and not hmac.compare_digest(got, token):
        return False, "Verification Token 不匹配"
    return True, ""


async def tenant_access_token(cfg: Dict[str, Any]) -> str:
    """获取 tenant_access_token（带进程内缓存）。"""
    app_id = str(cfg.get("app_id") or "")
    app_secret = str(cfg.get("app_secret") or "")
    if not app_id or not app_secret:
        raise BotError("未配置飞书应用的 App ID / App Secret")
    now = time.time()
    if _TOKEN["value"] and now < _TOKEN["expire_at"] - 120:
        return str(_TOKEN["value"])
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            OPEN_API + "/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
    data = resp.json()
    if data.get("code") != 0:
        raise BotError("获取 tenant_access_token 失败：" + str(data.get("msg")))
    _TOKEN["value"] = data.get("tenant_access_token")
    _TOKEN["expire_at"] = now + int(data.get("expire") or 7200)
    return str(_TOKEN["value"])


_TOKEN: Dict[str, Any] = {"value": "", "expire_at": 0.0}


async def _api(cfg: Dict[str, Any], method: str, path: str, **kw: Any) -> Dict[str, Any]:
    token = await tenant_access_token(cfg)
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.request(
            method,
            OPEN_API + path,
            headers={"Authorization": "Bearer " + token},
            **kw,
        )
    try:
        data = resp.json()
    except ValueError as exc:
        raise BotError("飞书接口返回异常（HTTP " + str(resp.status_code) + "）") from exc
    if data.get("code") != 0:
        raise BotError("飞书接口报错：" + str(data.get("msg") or data.get("code")))
    return data.get("data") or {}


async def send_card(cfg: Dict[str, Any], content: Dict[str, Any], chat_id: str = "") -> None:
    """主动推送（用于测试与告警），chat_id 形如 oc_xxx。"""
    if not chat_id:
        raise BotError("缺少会话 ID")
    await _api(
        cfg,
        "POST",
        "/im/v1/messages",
        params={"receive_id_type": "chat_id"},
        json={
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(content, ensure_ascii=False),
        },
    )


async def reply_card(cfg: Dict[str, Any], message_id: str, content: Dict[str, Any]) -> None:
    """在收到消息的会话里回复一张卡片。"""
    await _api(
        cfg,
        "POST",
        "/im/v1/messages/" + message_id + "/reply",
        json={"msg_type": "interactive", "content": json.dumps(content, ensure_ascii=False)},
    )


# ------------------------------------------------------------------- 卡片
LEVEL_COLOR = {"info": "blue", "ok": "green", "warn": "orange", "error": "red"}

# 「标签：值」形式的结果行会被自动排成两列，卡片更整齐
FIELD_RE = re.compile(r"^([^：:]{1,12})[：:]\s*(.+)$")


def _text_element(content: str) -> Dict[str, Any]:
    return {"tag": "div", "text": {"tag": "lark_md", "content": content}}


def _fields_element(pairs: List[Tuple[str, str]]) -> Dict[str, Any]:
    """两列字段网格（飞书里每行排两个，窄屏自动换行）。"""
    return {
        "tag": "div",
        "fields": [
            {
                "is_short": True,
                "text": {"tag": "lark_md", "content": "**" + str(key) + "**\n" + str(val)},
            }
            for key, val in pairs
        ],
    }


def _note_element(content: str) -> Dict[str, Any]:
    return {"tag": "note", "elements": [{"tag": "plain_text", "content": content}]}


def as_card(
    level: str,
    title: str,
    subtitle: str = "",
    elements: Optional[List[Dict[str, Any]]] = None,
    footer: str = "",
) -> Dict[str, Any]:
    """统一的卡片外壳：彩色头部 + 副标题 + 内容块 + 底部灰色说明。"""
    items: List[Dict[str, Any]] = list(elements or [])
    if footer:
        items += [{"tag": "hr"}, _note_element(footer)]
    header: Dict[str, Any] = {
        "template": LEVEL_COLOR.get(level, "blue"),
        "title": {"tag": "plain_text", "content": title},
    }
    if subtitle:
        header["subtitle"] = {"tag": "plain_text", "content": subtitle}
    return {
        "config": {"wide_screen_mode": True},
        "header": header,
        "elements": items or [_text_element("—")],
    }


def make_card(
    title: str,
    lines: List[str],
    level: str = "info",
    buttons: Optional[List[Dict]] = None,
    *,
    subtitle: str = "",
    footer: str = "",
) -> Dict[str, Any]:
    elements = [_text_element("\n".join(lines) if lines else "—")]
    if buttons:
        elements += [{"tag": "hr"}, {"tag": "action", "actions": buttons}]
    return as_card(level, title, subtitle, elements, footer)


def result_card(
    title: str,
    level: str,
    lines: List[str],
    subtitle: str = "",
    footer: str = "",
) -> Dict[str, Any]:
    """结果卡片：连续出现的「标签：值」自动并成两列，其余按整行文本展示。"""
    elements: List[Dict[str, Any]] = []
    texts: List[str] = []
    pairs: List[Tuple[str, str]] = []

    def flush_text() -> None:
        if texts:
            elements.append(_text_element("\n".join(texts)))
            texts.clear()

    def flush_pairs() -> None:
        if pairs:
            elements.append(_fields_element(list(pairs)))
            pairs.clear()

    for raw in lines:
        text = str(raw or "").strip()
        if not text:
            continue
        match = FIELD_RE.match(text)
        if match:
            flush_text()
            pairs.append((match.group(1).strip(), match.group(2).strip()))
        else:
            flush_pairs()
            texts.append(text)
    flush_text()
    flush_pairs()
    return as_card(level, title, subtitle, elements, footer)


def confirm_card(
    action: str,
    title: str,
    lines: List[str],
    value: Dict[str, Any],
    subject: str = "",
) -> Dict:
    """危险操作二次确认卡片。按钮回调里带着 action 与目标。"""
    payload = dict(value)
    payload["action"] = action
    payload["ts"] = int(time.time())
    buttons = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "确认执行"},
            "type": "danger",
            "value": payload,
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "取消"},
            "type": "default",
            "value": {"action": "cancel"},
        },
    ]
    elements = [_text_element(line) for line in lines if str(line).strip()]
    elements += [
        {"tag": "hr"},
        _text_element("**需要二次确认**，点击下方按钮后立即执行。"),
        {"tag": "action", "actions": buttons},
    ]
    return as_card("warn", title, subject, elements, "请确认对象无误；误操作可在面板查看任务记录。")


# --------------------------------------------------------------- 虚拟机操作
async def find_vm(client: Any, keyword: str) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """按 VMID 精确匹配，其次按名称精确匹配，最后按名称模糊匹配。"""
    keyword = str(keyword or "").strip().lower()
    if not keyword:
        return None, []
    resources = await client.cluster_resources("vm")
    vms = [r for r in resources if r.get("type") == "qemu"]
    for vm in vms:
        if str(vm.get("vmid")) == keyword:
            return vm, []
    for vm in vms:
        if str(vm.get("name") or "").lower() == keyword:
            return vm, []
    partial = [vm for vm in vms if keyword in str(vm.get("name") or "").lower()]
    if len(partial) == 1:
        return partial[0], []
    return None, partial[:8]


STATUS_LABEL = {
    "running": "运行中",
    "stopped": "已停止",
    "paused": "已暂停",
    "suspended": "已挂起",
}


def status_icon(vm: Dict[str, Any]) -> str:
    return "🟢" if str(vm.get("status")) == "running" else "⚪"


def status_text(vm: Dict[str, Any]) -> str:
    raw = str(vm.get("status") or "")
    return STATUS_LABEL.get(raw, raw or "-")


def vm_name(vm: Dict[str, Any]) -> str:
    return str(vm.get("name") or ("VM " + str(vm.get("vmid"))))


def _gb(value: Any) -> float:
    try:
        return float(value or 0) / 1073741824
    except (TypeError, ValueError):
        return 0.0


def _uptime_text(seconds: Any) -> str:
    try:
        total = int(seconds or 0)
    except (TypeError, ValueError):
        return "-"
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    if days:
        return str(days) + " 天 " + str(hours) + " 小时"
    if hours:
        return str(hours) + " 小时 " + str(minutes) + " 分"
    return str(minutes) + " 分钟"


def vm_line(vm: Dict[str, Any]) -> str:
    """列表里的一行：状态图标 + 名称 + VMID + 实时占用。"""
    parts = [status_icon(vm) + " **" + vm_name(vm) + "**", "VMID " + str(vm.get("vmid"))]
    if str(vm.get("status")) == "running":
        parts.append("CPU " + format(float(vm.get("cpu") or 0) * 100, ".1f") + "%")
        parts.append(
            "内存 "
            + format(_gb(vm.get("mem")), ".1f")
            + "/"
            + format(_gb(vm.get("maxmem")), ".1f")
            + " GB"
        )
        if vm.get("uptime"):
            parts.append("已运行 " + _uptime_text(vm.get("uptime")))
    else:
        parts.append("内存上限 " + format(_gb(vm.get("maxmem")), ".1f") + " GB")
    return " · ".join(parts)


def vm_detail_pairs(vm: Dict[str, Any]) -> List[Tuple[str, str]]:
    """单台虚拟机的详情字段。"""
    pairs: List[Tuple[str, str]] = [
        ("运行状态", status_icon(vm) + " " + status_text(vm)),
        ("VMID", str(vm.get("vmid"))),
        ("所在节点", str(vm.get("node") or "-")),
    ]
    if str(vm.get("status")) == "running":
        pairs.append(("CPU 使用率", format(float(vm.get("cpu") or 0) * 100, ".1f") + "%"))
        mem, maxmem = _gb(vm.get("mem")), _gb(vm.get("maxmem"))
        pct = (mem / maxmem * 100) if maxmem else 0.0
        pairs.append(
            (
                "内存占用",
                format(mem, ".1f")
                + " / "
                + format(maxmem, ".1f")
                + " GB（"
                + format(pct, ".0f")
                + "%）",
            )
        )
        if vm.get("uptime"):
            pairs.append(("运行时长", _uptime_text(vm.get("uptime"))))
    else:
        pairs.append(("内存上限", format(_gb(vm.get("maxmem")), ".1f") + " GB"))
    return pairs


def help_card() -> Dict[str, Any]:
    """帮助卡片：分区标题 + 两列字段，不使用反引号。"""
    return as_card(
        "info",
        "ProxCenter 机器人",
        "在飞书里直接管理 Proxmox 虚拟机",
        [
            _text_element("**查询**"),
            _fields_element(
                [
                    ("列表", "查看全部虚拟机"),
                    ("状态 名称或ID", "单台虚拟机详情"),
                    ("快照列表 名称或ID", "查看该虚拟机的快照"),
                ]
            ),
            {"tag": "hr"},
            _text_element("**操作**"),
            _fields_element(
                [
                    ("开机 名称或ID", "启动虚拟机"),
                    ("关机 名称或ID", "需卡片确认"),
                    ("重启 名称或ID", "需卡片确认"),
                    ("快照 名称或ID [快照名]", "创建快照，留空自动命名"),
                    ("回滚 名称或ID 快照名", "需卡片确认"),
                    ("备份 名称或ID [存储]", "立即执行备份"),
                    ("创建", "表单填写名称 / CPU / 内存 / 磁盘"),
                ]
            ),
            {"tag": "hr"},
            _text_element("**用法示例**"),
            _text_element("状态 105　　开机 web-01　　快照 105 before-upgrade"),
        ],
        "名称含空格时请改用 VMID；关机 / 重启 / 回滚会先弹出确认卡片。",
    )

CONFIRM_ACTIONS = {"stop", "restart", "rollback"}


def parse_command(text: str) -> Tuple[str, str]:
    """把消息文本解析成 (指令, 参数)。"""
    raw = str(text or "").strip()
    parts = [p for p in raw.split() if not p.startswith("@")]
    if not parts:
        return "", ""
    head = parts[0].lstrip("/").lower()
    arg = " ".join(parts[1:]).strip()
    table = {
        "help": "help", "帮助": "help", "?": "help",
        "list": "list", "列表": "list", "ls": "list",
        "status": "status", "状态": "status",
        "start": "start", "开机": "start", "启动": "start",
        "stop": "stop", "关机": "stop", "停止": "stop",
        "restart": "restart", "reboot": "restart", "重启": "restart",
        "create": "create", "创建": "create", "新建": "create",
        "snap": "snapshot", "快照": "snapshot",
        "snaps": "snap_list", "快照列表": "snap_list", "snapshot-list": "snap_list",
        "rollback": "rollback", "回滚": "rollback",
        "backup": "backup", "备份": "backup",
    }
    return table.get(head, "unknown"), arg


async def op_list_card() -> Dict[str, Any]:
    """虚拟机列表卡片：按运行状态分组，附实时占用。"""
    client = get_client()
    resources = await client.cluster_resources("vm")
    vms = [r for r in resources if r.get("type") == "qemu" and not r.get("template")]
    running = sorted(
        [v for v in vms if str(v.get("status")) == "running"], key=lambda v: v.get("vmid") or 0
    )
    stopped = sorted(
        [v for v in vms if str(v.get("status")) != "running"], key=lambda v: v.get("vmid") or 0
    )

    elements: List[Dict[str, Any]] = [_text_element("**运行中（" + str(len(running)) + "）**")]
    if running:
        elements.append(_text_element("\n".join(vm_line(v) for v in running[:20])))
        if len(running) > 20:
            elements.append(
                _text_element("…另有 " + str(len(running) - 20) + " 台运行中的虚拟机未显示")
            )
    else:
        elements.append(_text_element("当前没有运行中的虚拟机。"))
    if stopped:
        elements += [
            {"tag": "hr"},
            _text_element("**未运行（" + str(len(stopped)) + "）**"),
            _text_element("\n".join(vm_line(v) for v in stopped[:10])),
        ]
        if len(stopped) > 10:
            elements.append(_text_element("…另有 " + str(len(stopped) - 10) + " 台未显示"))

    return as_card(
        "info",
        "虚拟机列表",
        "共 "
        + str(len(vms))
        + " 台 · 运行中 "
        + str(len(running))
        + " 台 · 未运行 "
        + str(len(stopped))
        + " 台",
        elements,
        "发送「状态 VMID」查看单台详情。",
    )


async def op_status_card(keyword: str) -> Dict[str, Any]:
    """单台虚拟机详情卡片。"""
    client = get_client()
    vm, candidates = await find_vm(client, keyword)
    if not vm:
        if candidates:
            names = "、".join(str(c.get("name") or c.get("vmid")) for c in candidates)
            return result_card(
                "匹配到多台虚拟机",
                "warn",
                ["关键词命中了多台：" + names, "请改用 VMID 精确指定。"],
            )
        return result_card(
            "未找到虚拟机", "warn", ["没有找到与「" + str(keyword) + "」匹配的虚拟机。"]
        )
    vmid = str(vm.get("vmid"))
    running = str(vm.get("status")) == "running"
    return as_card(
        "info",
        "虚拟机详情",
        vm_name(vm) + " · VMID " + vmid,
        [_fields_element(vm_detail_pairs(vm))],
        "发送「关机 " + vmid + "」可关机（需确认）。"
        if running
        else "发送「开机 " + vmid + "」可启动该虚拟机。",
    )


POWER_MAP = {
    "start": ("start", "开机", "已在运行，无需开机"),
    "stop": ("shutdown", "关机", "已处于关机状态"),
    "restart": ("reboot", "重启", "已处于关机状态，无法重启"),
}


async def op_power(action: str, keyword: str) -> Tuple[str, List[str]]:
    api_action, label, skip_reason = POWER_MAP[action]
    client = get_client()
    vm, candidates = await find_vm(client, keyword)
    if not vm:
        if candidates:
            names = "、".join(str(c.get("name") or c.get("vmid")) for c in candidates)
            return "warn", ["匹配到多台虚拟机：" + names, "请用 VMID 精确指定。"]
        return "warn", ["没有找到「" + keyword + "」对应的虚拟机。"]
    status = str(vm.get("status") or "")
    need_running = action in ("stop", "restart")
    if need_running and status != "running":
        return "warn", [str(vm.get("name")) + " " + skip_reason + "。"]
    if not need_running and status == "running":
        return "warn", [str(vm.get("name")) + " " + skip_reason + "。"]
    node = str(vm.get("node") or "")
    await client.qemu_power(node, int(vm["vmid"]), api_action)
    return "ok", [
        "已下发**" + label + "**指令",
        "对象：" + str(vm.get("name")) + "（" + str(vm.get("vmid")) + "）",
        "节点：" + node,
    ]


async def op_create(
    cfg: Dict[str, Any],
    keyword: str,
    cpu: int = 0,
    mem: int = 0,
    disk: int = 0,
) -> Tuple[str, List[str]]:
    """按默认模板克隆一台新虚拟机，并按需调整 CPU / 内存 / 磁盘。"""
    name = str(keyword or "").strip()
    if not name:
        return "warn", ["请提供新虚拟机的名称，例如：创建 web-01"]
    template_id = str(cfg.get("default_template_vmid") or "").strip()
    if not template_id:
        return "warn", ["尚未配置默认模板（模板 VMID），请先在面板里填写。"]
    client = get_client()
    template, _ = await find_vm(client, template_id)
    if not template:
        return "warn", ["模板 " + template_id + " 不存在。"]
    if not int(template.get("template") or 0):
        return "warn", ["VMID " + template_id + " 不是模板，请用模板克隆。"]
    new_id = int(await client.nextid())
    await client.qemu_clone(
        str(template.get("node") or ""),
        int(template["vmid"]),
        new_id,
        name=name,
        # 从模板创建默认链接克隆：秒级完成，机器人场景下等待更短
        full=False,
        target_storage=str(cfg.get("default_storage") or "") or None,
        target_node=str(cfg.get("default_node") or "") or None,
    )
    node = str(template.get("node") or "")
    lines = [
        "已提交**创建**任务",
        "新虚拟机：" + name + "（" + str(new_id) + "）",
        "来源模板：" + str(template.get("name")) + "（" + str(template.get("vmid")) + "）",
    ]
    spec: Dict[str, Any] = {}
    if cpu:
        spec["cores"] = int(cpu)
    if mem:
        spec["memory"] = int(mem)
    # 机器人创建没有填 DNS 的交互，只能套用面板默认 DNS；留空则不干预
    dns = await defaults.effective_dns(None)
    if dns:
        spec["nameserver"] = dns
    if spec:
        await client.qemu_set_config(node, new_id, spec)
        if cpu or mem:
            lines.append(
                "规格：CPU "
                + str(spec.get("cores") or "-")
                + " 核 · 内存 "
                + str(spec.get("memory") or "-")
                + " MB"
            )
        if dns:
            lines.append("DNS：" + dns)
    if disk:
        try:
            current = await client.qemu_config(node, new_id)
            disks = [
                k for k, v in current.items()
                if k.startswith(("virtio", "scsi", "sata", "ide")) and "media=cdrom" not in str(v)
            ]
            if disks:
                await client.qemu_resize(node, new_id, sorted(disks)[0], str(int(disk)) + "G")
                lines.append("磁盘：" + sorted(disks)[0] + " 调整为 " + str(int(disk)) + " GB")
        except ProxmoxError as exc:
            lines.append("磁盘调整失败（扩容只能变大）：" + str(exc.message))
    lines.append("提示：可在面板或本会话发送「开机 " + str(new_id) + "」启动该虚拟机。")
    return "ok", lines


def check_allowlist(cfg: Dict[str, Any], chat_id: str, open_id: str) -> Tuple[bool, str]:
    """白名单校验：群与用户都未配置时一律拒绝（安全默认）。"""
    chats = _as_list(cfg.get("allowed_chat_ids"))
    users = _as_list(cfg.get("allowed_user_ids"))
    if not chats and not users:
        return False, "机器人未配置群 / 用户白名单，已拒绝执行。请在面板中配置后重试。"
    if chats and chat_id and chat_id not in chats:
        return False, "该会话不在允许列表中。"
    if users and open_id and open_id not in users:
        return False, "该用户不在允许列表中。"
    if users and not open_id:
        return False, "无法识别发送者身份，已拒绝执行。"
    return True, ""


def _reply(chat_id: str, message_id: str, card: Dict[str, Any]) -> Dict[str, Any]:
    return {"chat_id": chat_id, "message_id": message_id, "card": card}


def _reject_card(reason: str, chat_id: str, sender_id: Dict[str, Any]) -> Dict[str, Any]:
    """拒绝时回显识别到的身份，照抄即可填进白名单，省去翻日志。"""
    ids = sender_id or {}
    open_id = str(ids.get("open_id") or "")
    elements: List[Dict[str, Any]] = [
        _text_element(reason),
        {"tag": "hr"},
        _text_element("**识别到的身份**"),
        _fields_element(
            [
                ("用户 open_id", open_id or "未获取到"),
                ("会话 chat_id", chat_id or "未获取到"),
            ]
        ),
    ]
    if not open_id:
        # 只拿到 user_id / union_id 说明应用缺少相关权限，白名单无法按 open_id 匹配
        elements.append(
            _fields_element(
                [
                    ("user_id", str(ids.get("user_id") or "-")),
                    ("union_id", str(ids.get("union_id") or "-")),
                ]
            )
        )
        elements.append(
            _text_element("未能取得 open_id，通常是应用缺少消息接收相关权限，请在开放平台补齐后重发。")
        )
    return as_card(
        "warn",
        "已拒绝",
        "白名单校验未通过",
        elements,
        "把上面两项分别填入面板「飞书机器人」的允许的用户 open_id 与允许的群会话 ID 后保存即可，立即生效。",
    )


async def _dispatch(cfg: Dict[str, Any], cmd: str, arg: str, chat_id: str) -> Dict[str, Any]:
    """执行指令并返回一张结果卡片。"""
    try:
        if cmd == "help":
            return help_card()
        if cmd == "list":
            return await op_list_card()
        if cmd == "status":
            return await op_status_card(arg)
        if cmd in ("start", "stop", "restart"):
            if cmd != "start" and not cfg.get("allow_write"):
                return result_card("已禁用写操作", "warn", ["当前机器人只允许只读指令。"])
            if cmd in CONFIRM_ACTIONS:
                label = {"stop": "关机", "restart": "重启"}[cmd]
                return confirm_card(
                    cmd,
                    "确认" + label,
                    ["即将对 **" + arg + "** 执行「" + label + "」。"],
                    {"keyword": arg, "chat_id": chat_id},
                    subject="危险操作二次确认",
                )
            level, lines = await op_power(cmd, arg)
            return result_card("执行结果", level, lines)
        if cmd == "create":
            if not cfg.get("allow_create"):
                return result_card("已禁用创建", "warn", ["当前不允许通过机器人创建虚拟机。"])
            return create_form_card(cfg)
        if cmd in ("snapshot", "rollback", "backup") and not cfg.get("allow_write"):
            return result_card("已禁用写操作", "warn", ["当前机器人只允许只读指令。"])
        if cmd == "snapshot":
            parts = arg.split()
            level, lines = await op_snapshot(
                parts[0] if parts else "",
                " ".join(parts[1:]).strip() if len(parts) > 1 else "",
            )
            return result_card("创建快照", level, lines)
        if cmd == "snap_list":
            return await op_snap_card(arg)
        if cmd == "rollback":
            parts = arg.split()
            keyword = parts[0] if parts else ""
            snap = " ".join(parts[1:]).strip() if len(parts) > 1 else ""
            if not snap:
                return result_card("缺少快照名", "warn", ["用法：回滚 名称或ID 快照名"])
            return confirm_card(
                "rollback",
                "确认回滚快照",
                [
                    "即将把 **" + keyword + "** 回滚到快照 **" + snap + "**。",
                    "该快照之后的数据变更会丢失。",
                ],
                {"keyword": keyword, "snap": snap, "chat_id": chat_id},
                subject="危险操作二次确认",
            )
        if cmd == "backup":
            parts = arg.split()
            level, lines = await op_backup(
                cfg,
                parts[0] if parts else "",
                " ".join(parts[1:]).strip() if len(parts) > 1 else "",
            )
            return result_card("立即备份", level, lines)
    except ProxmoxError as exc:
        return result_card("Proxmox 调用失败", "error", [str(exc.message)])
    except BotError as exc:
        return result_card("机器人调用失败", "error", [str(exc)])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Feishu bot command failed")
        return result_card("执行异常", "error", [str(exc)])
    return result_card("未识别指令", "warn", ["没听懂这条指令，发送「帮助」查看用法。"])


async def _handle_message(cfg: Dict[str, Any], event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    msg = event.get("message") or {}
    chat_id = str(msg.get("chat_id") or "")
    message_id = str(msg.get("message_id") or "")
    sender_id = (event.get("sender") or {}).get("sender_id") or {}
    sender = str(sender_id.get("open_id") or sender_id.get("user_id") or "")
    ok, reason = check_allowlist(cfg, chat_id, sender)
    if not ok:
        logger.warning(
            "飞书机器人拒绝执行：%s（chat=%s, open_id=%s, user_id=%s）",
            reason,
            chat_id or "-",
            sender_id.get("open_id") or "-",
            sender_id.get("user_id") or "-",
        )
        return _reply(chat_id, message_id, _reject_card(reason, chat_id, sender_id))
    if str(msg.get("message_type") or "") != "text":
        return _reply(chat_id, message_id, make_card("暂不支持", ["目前只支持文本指令，发送「帮助」查看用法。"], "warn"))
    try:
        text = json.loads(msg.get("content") or "{}").get("text") or ""
    except ValueError:
        text = ""
    cmd, arg = parse_command(text)
    await store.add_audit(
        username="feishu:" + (sender or "unknown"),
        action="bot.command",
        target=cmd or "-",
        result="accepted",
        detail=(text or "").strip()[:120],
        ip="feishu",
    )
    card = await _dispatch(cfg, cmd, arg, chat_id)
    return _reply(chat_id, message_id, card)


async def _handle_card_action(cfg: Dict[str, Any], event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    value = ((event.get("action") or {}).get("value")) or {}
    operator_ids = event.get("operator") or {}
    operator = str(operator_ids.get("open_id") or "")
    context = event.get("context") or {}
    chat_id = str(context.get("open_chat_id") or "")
    message_id = str(context.get("open_message_id") or "")
    action = str(value.get("action") or "")

    if action == "cancel":
        return _reply(chat_id, message_id, make_card("已取消", ["操作已取消，未做任何变更。"], "info"))

    ok, reason = check_allowlist(cfg, chat_id, operator)
    if not ok:
        logger.warning(
            "飞书卡片回调被拒绝：%s（chat=%s, open_id=%s）",
            reason,
            chat_id or "-",
            operator or "-",
        )
        return _reply(chat_id, message_id, _reject_card(reason, chat_id, operator_ids))

    keyword = str(value.get("keyword") or "")
    try:
        if action in ("stop", "restart"):
            if not cfg.get("allow_write"):
                return _reply(chat_id, message_id, make_card("已禁用写操作", ["当前只允许只读指令。"], "warn"))
            level, lines = await op_power(action, keyword)
        elif action == "create_submit":
            if not cfg.get("allow_create"):
                return _reply(chat_id, message_id, make_card("已禁用创建", ["当前不允许创建虚拟机。"], "warn"))
            form = ((event.get("action") or {}).get("form_value")) or {}
            name = str(form.get("vm_name") or "").strip()
            if not name:
                return _reply(chat_id, message_id, make_card("缺少名称", ["请在表单里填写虚拟机名称后再提交。"], "warn"))
            level, lines = await op_create(
                cfg, name, _to_int(form.get("cpu")), _to_int(form.get("memory")), _to_int(form.get("disk"))
            )
        elif action == "rollback":
            if not cfg.get("allow_write"):
                return _reply(chat_id, message_id, make_card("已禁用写操作", ["当前只允许只读指令。"], "warn"))
            level, lines = await op_rollback(str(value.get("keyword") or ""), str(value.get("snap") or ""))
        else:
            level, lines = "warn", ["该卡片已失效，请重新发送指令。"]
    except ProxmoxError as exc:
        level, lines = "error", [str(exc.message)]
    except BotError as exc:
        level, lines = "error", [str(exc)]
    except Exception as exc:  # noqa: BLE001
        logger.exception("飞书卡片操作失败")
        level, lines = "error", [str(exc)]

    await store.add_audit(
        username="feishu:" + (operator or "unknown"),
        action="bot." + (action or "unknown"),
        target=keyword or "-",
        result="success" if level == "ok" else "failed",
        detail="；".join(lines)[:200],
        ip="feishu",
    )
    return _reply(chat_id, message_id, result_card("执行结果", level, lines))


async def handle_event(payload: Dict[str, Any], cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """处理飞书事件，返回需要回复的卡片描述（None 表示无需回复）。"""
    header = payload.get("header") or {}
    event_type = str(header.get("event_type") or payload.get("type") or "")
    event = payload.get("event") or {}
    if event_type == "im.message.receive_v1":
        return await _handle_message(cfg, event)
    if event_type in ("card.action.trigger", "card_action_trigger"):
        return await _handle_card_action(cfg, event)
    logger.info("忽略飞书事件类型：%s", event_type)
    return None


async def send_test(cfg: Dict[str, Any], chat_id: str) -> Dict[str, Any]:
    """向指定会话推送一张测试卡片。"""
    card = as_card(
        "ok",
        "ProxCenter 机器人已连通",
        "消息通道验证",
        [
            _text_element("现在可以直接在飞书里管理 Proxmox 虚拟机了。"),
            _fields_element(
                [
                    ("查询类", "列表 / 状态 / 快照列表"),
                    ("操作类", "开机 / 关机 / 重启 / 快照 / 回滚 / 备份"),
                ]
            ),
        ],
        "发送「帮助」查看完整指令说明。",
    )
    await send_card(cfg, card, chat_id)
    return {"detail": "测试卡片已发送到 " + chat_id}


async def _resolve(client: Any, keyword: str):
    vm, candidates = await find_vm(client, keyword)
    if vm:
        return vm, None
    if candidates:
        names = "、".join(str(c.get("name") or c.get("vmid")) for c in candidates)
        return None, "匹配到多台虚拟机：" + names + "，请用 VMID 精确指定。"
    return None, "没有找到「" + keyword + "」对应的虚拟机。"


async def op_snapshot(keyword: str, name: str) -> Tuple[str, List[str]]:
    client = get_client()
    vm, err = await _resolve(client, keyword)
    if not vm:
        return "warn", [err or ""]
    snap = (name or "bot-" + time.strftime("%Y%m%d-%H%M%S")).strip()
    await client.qemu_snapshot_create(
        str(vm.get("node") or ""), int(vm["vmid"]), snap, description="由飞书机器人创建"
    )
    return "ok", [
        "已创建快照 **" + snap + "**",
        "对象：" + str(vm.get("name")) + "（" + str(vm.get("vmid")) + "）",
    ]


async def op_snap_card(keyword: str) -> Dict[str, Any]:
    """快照列表卡片。"""
    client = get_client()
    vm, err = await _resolve(client, keyword)
    if not vm:
        return result_card("未找到虚拟机", "warn", [err or ""])
    snaps = await client.qemu_snapshots(str(vm.get("node") or ""), int(vm["vmid"]))
    items = [s for s in snaps if str(s.get("name")) != "current"]
    lines: List[str] = []
    if not items:
        lines.append("该虚拟机还没有任何快照。")
    for snap in items[-10:]:
        when = snap.get("snaptime")
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(int(when))) if when else "-"
        lines.append("· " + str(snap.get("name")) + " · " + stamp)
    vmid = str(vm.get("vmid"))
    return as_card(
        "info",
        "快照列表",
        vm_name(vm) + " · VMID " + vmid + " · 共 " + str(len(items)) + " 个",
        [_text_element("\n".join(lines))],
        "发送「回滚 " + vmid + " 快照名」可回滚到指定快照（需确认）。" if items else "",
    )


async def op_rollback(keyword: str, snap: str) -> Tuple[str, List[str]]:
    client = get_client()
    vm, err = await _resolve(client, keyword)
    if not vm:
        return "warn", [err or ""]
    if not snap:
        return "warn", ["请提供快照名，例如：回滚 web-01 before-upgrade"]
    snaps = await client.qemu_snapshots(str(vm.get("node") or ""), int(vm["vmid"]))
    if not any(str(s.get("name")) == snap for s in snaps):
        return "warn", ["快照 " + snap + " 不存在，发送「快照列表 " + keyword + "」查看现有快照。"]
    await client.qemu_snapshot_rollback(str(vm.get("node") or ""), int(vm["vmid"]), snap)
    return "ok", [
        "已回滚到快照 **" + snap + "**",
        "对象：" + str(vm.get("name")) + "（" + str(vm.get("vmid")) + "）",
        "回滚会丢弃快照之后的数据变更，请确认业务可接受。",
    ]


async def op_backup(cfg: Dict[str, Any], keyword: str, storage: str) -> Tuple[str, List[str]]:
    client = get_client()
    vm, err = await _resolve(client, keyword)
    if not vm:
        return "warn", [err or ""]
    target = (storage or str(cfg.get("default_backup_storage") or "") or str(cfg.get("default_storage") or "")).strip()
    if not target:
        return "warn", ["未指定备份存储，请用「备份 名称或ID 存储名」，或先在面板里配置默认备份存储。"]
    await client.backup_create(
        str(vm.get("node") or ""), int(vm["vmid"]), target, mode="snapshot", compress="zstd"
    )
    return "ok", [
        "已提交**备份**任务",
        "对象：" + str(vm.get("name")) + "（" + str(vm.get("vmid")) + "）",
        "存储：" + target + " · 模式 snapshot · 压缩 zstd",
        "可在面板「任务队列」里查看进度。",
    ]



def _to_int(value: Any) -> int:
    """把表单里的字符串转成整数，非法值按 0 处理。"""
    try:
        return max(0, int(str(value).strip()))
    except (TypeError, ValueError):
        return 0

def create_form_card(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """创建虚拟机的表单卡片：名称 / CPU / 内存 / 磁盘。"""
    template_id = str(cfg.get("default_template_vmid") or "").strip()

    def field(name: str, label: str, placeholder: str, default: str = "") -> Dict[str, Any]:
        return {
            "tag": "input",
            "name": name,
            "label": {"tag": "plain_text", "content": label},
            "placeholder": {"tag": "plain_text", "content": placeholder},
            "default_value": default,
        }

    hint = (
        "将以模板 VMID " + template_id + " 克隆，未填写的规格按表单默认值处理。"
        if template_id
        else "尚未配置默认模板，请先在面板「飞书机器人」里填写模板 VMID。"
    )
    return as_card(
        "info",
        "创建虚拟机",
        "基于默认模板克隆",
        [
            _text_element(hint),
            {
                "tag": "form",
                "name": "create_form",
                "elements": [
                    field("vm_name", "名称", "例如 web-01"),
                    field("cpu", "CPU 核数", "2", "2"),
                    field("memory", "内存（MB）", "2048", "2048"),
                    field("disk", "磁盘（GB，可留空）", "20", ""),
                    {
                        "tag": "button",
                        "action_type": "form_submit",
                        "type": "primary",
                        "text": {"tag": "plain_text", "content": "确认创建"},
                        "value": {"action": "create_submit"},
                    },
                ],
            },
        ],
        "创建完成后可在面板调整硬件，或在本会话发送「开机 名称」启动。",
    )
