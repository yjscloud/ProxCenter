"""用户资源额度预警：某人的额度快用完 / 已经超了，就走告警通道通知本人。

为什么要单独一个来源
--------------------
资源告警（:func:`app.alerting.evaluate`）判的是**某台机器的使用率**：规则挂在
节点 / 虚拟机上，比的是 CPU / 内存 / 磁盘的百分比，读的还是默认连接那一套 PVE。
「某人的额度快满了」两样都不是：

* 它比的是**额度**（面板自己的账：上限、配额、下发），不是机器的使用率；
* 它的对象是**用户**，不是某台机器。

硬塞进资源告警只有两个办法，都不合适：给「用量」加一个指标 —— 用量的分母是
**每个用户各自不同的上限**，规则表里那个 0~100 的阈值框表达不了「某人的 90%」；
或者为每个用户各生成一条规则 —— 用户会增删、改一次就要重写一遍规则表，而且
上限一改，规则里的阈值就跟着过期了。

所以照 :mod:`app.quorumguard` 的写法：自建 ``rule_id``、自己判冷却，复用告警的
去重 / 飞书 / 邮件 / Webhook / 恢复通知，**不进**告警规则表，界面上也不会多出
一行让管理员填了却不起作用的规则。

接收人是**用户自己**，不是管理员
--------------------------------
额度用完的后果落在那个人身上 —— 他建不了新机器、也建不了新快照，他自己就是
第一个该知道的人。管理员只是需要知道。因此这里逐人读通道配置
（:func:`app.alerting.load_feishu` 等），与资源告警「各发各的」是同一套口径。
超级管理员（``bypass``）不发：他不受额度约束，提醒他等于报一条永远不该发生的告警。

判定口径
--------
「快满了」= **最紧的那一项**的剩余比例 ≤ :data:`THRESHOLD`，且不限两项：

* 只看最紧的一项，不逐项各报一条 —— 一个人的核数 / 内存 / 磁盘经常同时接近
  上限，逐项报就是一条通知里四句几乎一样的话；报最紧的那项已经足够说明
  「该扩容或该停手了」。
* 不按「维度」分别记住告警状态 —— 否则最紧的那项一变（比如内核数了、接着
  磁盘吃紧），就会同时收到「内存已解除」与「磁盘告急」两条，看着像额度自己
  在动。代价是换维度时旧维度仍会补一条解除通知，但这只会发生一次（有 4 小时
  冷却兜着），比每轮都可能抖要好。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from . import alerting, i18n, quota

logger = logging.getLogger(__name__)

#: 自建的规则 id。它不落在告警规则表里，只用于告警状态的去重键。
RULE_ID = "user-quota"

#: 剩余比例低于这条线就提醒（百分比）。
#: 10% 差不多是「基本建不了新机器」的坎，但等到 0 才通知就太晚了 —— 人是在还剩
#: 两三台的时候就该知道，而不是在提交创建被拒的那一刻。
THRESHOLD = 20.0

#: 同一个人的同一项额度重复提醒的间隔（秒）。
#: 给得很长是刻意的：额度不会自己涨回去，而**回落已经由恢复通知负责告知**，
#: 没必要再为「还在告警中」每半小时重喊一遍同一个数字。默认 4 小时。
COOLDOWN = 4 * 60 * 60

#: 额度维度 → 展示时的单位与后缀。内存换算成 GB，其余照原样带单位。
_UNIT: Dict[str, tuple] = {
    "count": (1.0, " 台"),
    "cores": (1.0, " 核"),
    "memory_mb": (1.0 / 1024, " GB"),
    "disk_gb": (1.0, " GB"),
}


def _fmt(field: str, value: float) -> str:
    """把一个额度维度的数值写成人看的样子。"""
    scale, suffix = _UNIT.get(field, (1.0, ""))
    number = value * scale
    text = f"{number:g}" if number < 10 else f"{number:.1f}"
    return text + suffix


def _what(item: Dict[str, Any]) -> str:
    """「虚拟机 · 内存」这样的维度名。"""
    return quota.group_label(str(item["group"])) + " " + quota.field_label(
        str(item["field"])
    )


def tightest(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """这个用户**最紧的那一项**额度；没有可比的上限时返回 ``None``。

    「紧」= 剩余比例（0~100，越小越紧）。返回 ``None`` 的三种情况：超级管理员
    （额度对他无效）、一项上限都没配、以及每一项都还宽裕。

    跳过某一项的几种情况：

    * 上限不是正数 —— 没配就是不限，不能当成「上限 0」去比；
    * 用量读不到（``None``）—— **绝不能当成 0**。用量是逐台向 PVE 枚举出来的，
      某次枚举失败就是 ``None``，当成 0 等于报一条「内存还空着 100%」的假宽裕，
      恰好会把最该提醒的那种情况悄悄漏掉；
    * 单台封顶（``max_*``）在本模块里不比 —— 它约束的是「一台机器别开太大」，
      超了会在下发时就被拒（见 :func:`app.quota.enforce_config`），不是「快满了」。
    """
    if row.get("bypass"):
        return None
    limits = row.get("limits") or {}
    usage = row.get("usage") or {}
    remaining = row.get("remaining") or {}
    best: Optional[Dict[str, Any]] = None
    for group, group_limits in limits.items():
        if not isinstance(group_limits, dict):
            continue
        group_usage = usage.get(group) or {}
        group_left = remaining.get(group) or {}
        for field, limit in group_limits.items():
            if str(field).startswith("max_"):
                continue
            if not isinstance(limit, (int, float)) or limit <= 0:
                continue
            used = group_usage.get(field)
            if not isinstance(used, (int, float)):
                continue
            left = group_left.get(field)
            if not isinstance(left, (int, float)):
                left = float(limit) - float(used)
            ratio = max(0.0, min(100.0, float(left) / float(limit) * 100.0))
            if best is None or ratio < best["ratio"]:
                best = {
                    "group": str(group),
                    "field": str(field),
                    "limit": float(limit),
                    "used": float(used),
                    "left": float(left),
                    "ratio": ratio,
                    # 超了就是超了。卡片、通知与列表徽章都要分开说：提示语「快满了」
                    # 用在已经超了的人身上会轻得没有说服力
                    "over": float(used) > float(limit),
                }
    return best


def _title(item: Dict[str, Any], who: str) -> str:
    if item["over"]:
        return i18n.pick(
            f"🔴 {who} 的{_what(item)}额度已超出",
            f"🔴 {who} has exceeded the {_what_en(item)} quota",
        )
    return i18n.pick(
        f"🟠 {who} 的{_what(item)}额度即将用完（剩余 {item['ratio']:.0f}%）",
        f"🟠 {who} is close to the {_what_en(item)} quota "
        f"({item['ratio']:.0f}% left)",
    )


def _what_en(item: Dict[str, Any]) -> str:
    """英文维度名。与 ``quota.group_label`` 一样按分组区分，不复用中文串。"""
    group = "VM" if item["group"] == "vm" else "container"
    field = {
        "count": "count",
        "cores": "CPU cores",
        "memory_mb": "memory",
        "disk_gb": "disk",
    }.get(str(item["field"]), str(item["field"]))
    return f"{group} {field}"


def _text(item: Dict[str, Any], who: str) -> str:
    """纯文本正文（邮件与通用 Webhook 用；飞书走卡片）。"""
    used = _fmt(item["field"], item["used"])
    limit = _fmt(item["field"], item["limit"])
    left = _fmt(item["field"], item["left"])
    return i18n.pick(
        f"{who} 的{_what(item)}额度：已用 {used} / 上限 {limit}（剩余 {left}，"
        f"{item['ratio']:.0f}%）",
        f"{who} · {_what_en(item)} quota: {used} used of {limit} "
        f"({left} left, {item['ratio']:.0f}%)",
    )


def _card(item: Dict[str, Any], who: str, at: float) -> Dict[str, Any]:
    """飞书卡片：把「哪一项、用了多少、还剩多少」摆在一起。"""
    fields = [
        (i18n.tr("用户"), who),
        (i18n.tr("额度项"), _what(item)),
        (i18n.tr("已用"), _fmt(item["field"], item["used"])),
        (i18n.tr("生效上限"), _fmt(item["field"], item["limit"])),
        (i18n.tr("剩余"), _fmt(item["field"], item["left"])),
    ]
    note = i18n.pick(
        f"触发时间 {alerting._now_text(at)} · 剩余比例 {item['ratio']:.0f}%"
        f"（阈值 {THRESHOLD:.0f}%）。额度用完后这台机器的新建 / 扩容会被直接拒绝，"
        "请提前扩容，或联系管理员调整额度。",
        f"Triggered at {alerting._now_text(at)} · {item['ratio']:.0f}% left "
        f"(threshold {THRESHOLD:.0f}%). Once the quota is used up, creating or "
        "resizing guests is rejected — raise the quota or ask an admin to adjust it.",
    )
    return alerting.build_card(
        "critical" if item["over"] else "warning",
        _title(item, who),
        _text(item, who),
        fields,
        note,
    )


async def evaluate(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """算出谁的额度快满了，逐人走他自己的告警通道；回落后再发一条解除通知。

    ``owner`` 只为对齐 :func:`app.alerting.evaluate` 的调用方式。额度是**按用户**
    隔离的，所以传进来的用户名在这里是有意义的：手动「立即检测」时只算这个人。

    返回本轮触发项，供调度器摘要（见 main.py 的 ``_count``）。
    """
    await quota.init_table()
    data = await quota.overview()
    # 集群读数不全时用量偏小。按偏小的数判定会漏报，更糟的是可能把**已经满了**
    # 的人报成还宽裕 —— 宁可这一轮沉默，也不要报一条让人放心的话。
    if data.get("error"):
        logger.warning("额度预警跳过本轮：%s", data["error"])
        return []

    rows = data.get("users") or []
    if owner:
        rows = [r for r in rows if str(r.get("username")) == owner]

    now = time.time()
    fired: List[Dict[str, Any]] = []
    # 一轮里同一个人只读一次通道配置：多个用户各触发时逐次读库没有意义
    channels: Dict[str, Dict[str, Any]] = {}

    async def channel_of(name: str) -> Dict[str, Any]:
        if name not in channels:
            channels[name] = {
                "feishu": await alerting.load_feishu(name),
                "email": await alerting.load_alert_email(name),
                "hook": await alerting.load_webhook(name),
            }
        return channels[name]

    active = {
        key: row
        for key, row in (await alerting.load_active()).items()
        if str(row.get("notify_source") or "") == alerting.SOURCE_QUOTA
    }
    if owner:
        # 只看得到这一份：手动检测别人的额度不该顺手清掉别人的告警状态
        active = {
            key: row
            for key, row in active.items()
            if str(row.get("username") or "") == owner
        }
    still_alarming: set = set()

    for row in rows:
        username = str(row.get("username") or "")
        if not username:
            continue
        item = tightest(row)
        if item is None or item["ratio"] > THRESHOLD:
            continue
        key = alerting.alarm_key(
            username, RULE_ID, item["group"] + "." + item["field"]
        )
        still_alarming.add(key)
        # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
        prev = active.get(key) or {}
        if now - float(prev.get("ts") or 0) < COOLDOWN:
            continue

        # 按收件人的语言渲染：巡检是后台跑的，没有请求上下文
        i18n.pin_language(await alerting.resolve_language(username))
        ch = await channel_of(username)
        title = _title(item, username)
        text = _text(item, username)
        ok, detail = await alerting.dispatch(
            username,
            ch["feishu"],
            ch["email"],
            title,
            text,
            _card(item, username, now),
            source=alerting.SOURCE_QUOTA,
            webhook=ch["hook"],
            # context 供通用 Webhook 的请求体模板取用（飞书走卡片、邮件走正文）
            context={
                "level": "alarm",
                "title": title,
                "text": text,
                "target": username,
                "target_type": "user",
                "metric": _what(item),
                "value": f"{item['ratio']:.0f}",
                "threshold": f"{THRESHOLD:.0f}",
                "node": "",
                "vmid": "",
                "status": i18n.tr("已超出") if item["over"] else i18n.tr("即将用完"),
                "ip": "",
                "time": alerting._now_text(now),
            },
        )
        state = {
            "username": username,
            "rule_id": RULE_ID,
            "rule_name": i18n.tr("资源额度"),
            "target_type": "user",
            "target": username,
            "metric": "quota",
            # 存**已用比例**而不是剩余比例：告警历史的「数值」列画的是一根条 +
            # 阈值标记，颜色按「越高越红」取（utils/format 的 usageColor）。
            # 存剩余的话这条会显示成「5%」配一根绿色条 —— 一条正在报警的记录
            # 渲染成绿色，比文案写错还误导。改成已用后与其它指标同一套读法：
            # 「已用 95%，阈值 80%」。
            "value": round(100.0 - item["ratio"], 1),
            "threshold": 100.0 - THRESHOLD,
            "node": "",
            "ip": "",
            "vmid": None,
            "ts": int(now),
            "notify_source": alerting.SOURCE_QUOTA,
        }
        await alerting.mark_active(key, state)
        active[key] = dict(state, alarm_key=key)
        entry = {
            **state,
            "result": "sent" if ok else "failed",
            "detail": detail,
            "kind": "alarm",
        }
        await alerting.record(entry, source=alerting.SOURCE_QUOTA, repeat=bool(prev))
        entry["text"] = text
        fired.append(entry)

    # ---- 回落：之前告警过、这次不再紧张 ----
    for key, row in list(active.items()):
        if key in still_alarming:
            continue
        who = str(row.get("username") or "")
        if not who:
            await alerting.clear_active(key)
            continue
        # 回落不是看一眼就作数：要连续几轮都宽裕（见 recovery_confirmed），
        # 否则用量在阈值线上下抖时会得到「告警 / 恢复」成对刷屏
        if not await alerting.recovery_confirmed(key, row):
            continue
        i18n.pin_language(await alerting.resolve_language(who))
        ch = await channel_of(who)
        title = i18n.pick(
            f"恢复通知：{who} 的额度已回到安全线",
            f"Recovery: {who}'s quota is back within limits",
        )
        text = i18n.pick(
            f"{who} 的额度剩余比例已回到 {THRESHOLD:.0f}% 以上，"
            "可以正常创建与扩容了。",
            f"{who}'s quota is back above {THRESHOLD:.0f}% remaining — "
            "creating and resizing guests works again.",
        )
        ok, detail = await alerting.dispatch(
            who,
            ch["feishu"],
            ch["email"],
            title,
            text,
            alerting.build_recovery_card(row, None, at=now),
            source=alerting.SOURCE_QUOTA,
            webhook=ch["hook"],
        )
        await alerting.record(
            {
                "username": who,
                "rule_id": row.get("rule_id"),
                "rule_name": row.get("rule_name"),
                "target_type": "user",
                "target": row.get("target"),
                "metric": row.get("metric"),
                "value": float(row.get("value") or 0),
                "threshold": row.get("threshold"),
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "recovery",
            },
            source=alerting.SOURCE_QUOTA,
        )
        await alerting.clear_active(key)
        entry = {"kind": "recovery", "target": who, "text": text}
        fired.append(entry)

    return fired