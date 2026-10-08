"""告警根因聚合：把同一时刻的多条活动告警按「对象」与「指标」聚类，识别疑似同源，
必要时交给模型给出根因假设与处置顺序，再推送给告警归属人。

为什么单独成一块，而不是塞进资源告警的评估循环
------------------------------------------------
* 资源告警是**逐条**判定、逐条发的：一条规则得出一个结论；
* 根因聚合是**跨条**的：只有把同一时刻的多条告警放在一起看才有意义
  （一台机器 CPU / 内存 / 磁盘同时告警，或所有虚拟机磁盘同时告警）；
* 若塞进评估循环，「发一条告警」就可能变成「触发一次模型调用」，把每分钟一轮的
  巡检拖慢，且同一个根因会被反复推送。

推送克制原则与 AI 巡检报告一致：只有同一归属人名下的活动告警达到
:data:`STORM_MIN` 才聚合；同一批告警（指纹相同）在 :data:`REMIND_COOLDOWN`
内不重复推。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from . import ai, alerting, i18n, store

logger = logging.getLogger(__name__)

SOURCE = alerting.SOURCE_ROOTCAUSE

# 同一归属人名下活动告警达到这个数，才值得做一次聚合
STORM_MIN = 3
# 一个聚类组至少几条才算「疑似同源」
GROUP_MIN = 2
# 单次最多分析多少条活动告警
MAX_ALARMS = 60
# 同一批告警（指纹未变）最短多久提醒一次
REMIND_COOLDOWN = 6 * 3600

# owner → (指纹, 上次推送时刻)。进程内即可：重启后最多多推一次，可以接受。
_last_push: Dict[str, Tuple[str, float]] = {}


# ------------------------------------------------------------------ 聚类（纯函数）
def _object_key(row: Dict[str, Any]) -> str:
    return "{}:{}:{}".format(
        str(row.get("target_type") or ""),
        str(row.get("node") or ""),
        str(row.get("vmid") or row.get("target") or ""),
    )


def _object_label(row: Dict[str, Any]) -> str:
    target = str(row.get("target") or "")
    node = str(row.get("node") or "")
    if target and target != "*":
        return target + ("@" + node if node else "")
    return node or str(row.get("vmid") or "?")


def _brief(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "metric": row.get("metric"),
        "value": row.get("value"),
        "threshold": row.get("threshold"),
        "rule": row.get("rule_name") or row.get("rule_id"),
        "since": row.get("ts"),
    }


def group(alarms: List[Dict[str, Any]]) -> Dict[str, Any]:
    """按对象与指标聚类（纯函数，便于单独验证）。"""
    objects: Dict[str, Dict[str, Any]] = {}
    metrics: Dict[str, List[Dict[str, Any]]] = {}
    for row in alarms:
        okey = _object_key(row)
        obj = objects.setdefault(
            okey, {"key": okey, "label": _object_label(row), "alarms": []}
        )
        obj["alarms"].append(_brief(row))
        metric = str(row.get("metric") or "?").lower()
        # 指标组保留原始行：suspects 里要取 target 列表，_brief 里没有它
        metrics.setdefault(metric, []).append(row)

    obj_list = sorted(objects.values(), key=lambda o: len(o["alarms"]), reverse=True)
    for obj in obj_list:
        obj["metrics"] = sorted({str(a.get("metric") or "") for a in obj["alarms"]})

    metric_list = [
        {
            "metric": metric,
            "count": len(rows),
            "targets": sorted(
                {str(r.get("target") or "") for r in rows if str(r.get("target") or "")}
            ),
        }
        for metric, rows in sorted(metrics.items(), key=lambda kv: len(kv[1]), reverse=True)
    ]

    suspects: List[Dict[str, Any]] = [
        {
            "kind": "object",
            "label": obj["label"],
            "metrics": obj["metrics"],
            "count": len(obj["alarms"]),
        }
        for obj in obj_list
        if len(obj["alarms"]) >= GROUP_MIN
    ] + [
        {
            "kind": "metric",
            "metric": item["metric"],
            "targets": item["targets"][:10],
            "count": item["count"],
        }
        for item in metric_list
        if item["count"] >= GROUP_MIN
    ]

    return {
        "total": len(alarms),
        "objects": obj_list,
        "metrics": metric_list,
        "suspects": suspects,
    }


def _fingerprint(alarms: List[Dict[str, Any]]) -> str:
    """一批告警的指纹：谁在告警（alarm_key）决定，与顺序无关。"""
    keys = sorted(str(row.get("alarm_key") or "") for row in alarms)
    return "|".join(keys)


def _should_push(owner: str, fingerprint: str) -> bool:
    prev = _last_push.get(owner)
    if prev is None:
        return True
    last_fp, last_ts = prev
    if fingerprint != last_fp:
        return True
    return (time.time() - last_ts) >= REMIND_COOLDOWN


def _mark_pushed(owner: str, fingerprint: str) -> None:
    _last_push[owner] = (fingerprint, time.time())


# ------------------------------------------------------------------ AI 归因
ROOTCAUSE_PROMPT = """你是资深运维工程师。下面是同一时刻仍处于告警状态的一批阈值告警，
已经按「同一对象」与「同一指标」预先聚类。请判断它们之间可能的共同根因，并给出处置顺序。

要求：
- 只依据给到的数据推断，不要臆测系统里不存在的组件；
- 若多条告警很可能同源，明确指出「哪些告警属于同一根因」；
- 给出处置顺序（先做什么、后做什么），指向可主动检查的方向；
- 数据不足以判断时直说，不要编造。

只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块：
{
  "summary": "一到三句话的总体判断",
  "root_causes": [
    {"cause": "根因假设", "confidence": "high|medium|low",
     "related": ["涉及的对象或指标"], "action": "建议动作"}
  ],
  "order": ["第一步", "第二步"]
}

所有面向用户的文字用{language}书写。"""


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """从模型回复里抽出 JSON（直接解析 → 去 ``` 围栏 → 截取首尾大括号）。"""
    raw = (text or "").strip()
    if not raw:
        return None
    candidates = [raw]
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start : end + 1])
    for item in candidates:
        try:
            parsed = json.loads(item)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


async def analyse(
    groups: Dict[str, Any], *, username: str = "", is_admin: bool = False
) -> Dict[str, Any]:
    """有可用模型就让它给出根因与处置顺序；没有就返回空（降级为纯聚类）。"""
    cfg = await ai.load_config()
    if not cfg.get("enabled"):
        return {}
    provider = ai.active_provider(cfg, username=username, is_admin=is_admin)
    if provider is None:
        return {}

    language = "中文" if i18n.current_language() == i18n.LANG_ZH else "English"
    messages = [
        {
            "role": "system",
            "content": ROOTCAUSE_PROMPT.replace("{language}", language),
        },
        {"role": "user", "content": json.dumps(groups, ensure_ascii=False)},
    ]
    try:
        reply = await ai.chat(messages, cfg=cfg, provider=provider)
    except Exception as exc:  # noqa: BLE001 - 归因失败不该让整条聚合发不出去
        logger.warning("告警根因聚合：模型调用失败：%s", exc)
        return {}
    return _extract_json(reply.get("content") or "") or {}


# ------------------------------------------------------------------ 渲染
def _render(
    groups: Dict[str, Any], insight: Dict[str, Any]
) -> Tuple[str, str, Dict[str, Any]]:
    stamp = time.strftime("%Y-%m-%d %H:%M")
    title = i18n.pick("告警根因聚合", "Alert root-cause grouping")
    total = int(groups.get("total") or 0)
    objects = groups.get("objects") or []
    suspects = groups.get("suspects") or []

    lines: List[str] = [
        title + " · " + stamp,
        i18n.pick(
            "活动告警 {total} 条，涉及 {n} 个对象。",
            "{total} active alerts across {n} objects.",
        ).format(total=total, n=len(objects)),
        "",
    ]

    if suspects:
        lines.append(i18n.pick("【疑似同源】", "[Suspected same origin]"))
        for item in suspects:
            if item.get("kind") == "object":
                lines.append(
                    "- " + i18n.pick("对象 ", "Object ")
                    + str(item.get("label"))
                    + i18n.pick("：", ": ")
                    + i18n.pick("、", ", ").join(
                        str(m) for m in (item.get("metrics") or [])
                    )
                    + i18n.pick(
                        " 同时告警（{n} 条）", " alerting together ({n})"
                    ).format(n=item.get("count"))
                )
            else:
                lines.append(
                    "- " + i18n.pick("指标 ", "Metric ")
                    + str(item.get("metric"))
                    + i18n.pick(
                        "：{n} 个对象同时告警", ": {n} objects alerting together"
                    ).format(n=item.get("count"))
                )
        lines.append("")

    root_causes = insight.get("root_causes") or []
    if root_causes:
        lines.append(i18n.pick("【根因分析】", "[Root cause]"))
        if insight.get("summary"):
            lines.append(str(insight.get("summary")))
        for item in root_causes:
            entry = "- " + str(item.get("cause") or "")
            conf = str(item.get("confidence") or "").strip()
            if conf:
                entry += i18n.pick("（置信度 ", " (confidence ") + conf + i18n.pick("）", ")")
            lines.append(entry)
            action = str(item.get("action") or "").strip()
            if action:
                lines.append("  " + i18n.pick("建议：", "Action: ") + action)
        if insight.get("order"):
            lines.append(
                i18n.pick("处置顺序：", "Order: ")
                + " → ".join(str(x) for x in insight.get("order"))
            )
        lines.append("")

    if objects:
        lines.append(i18n.pick("【明细】", "[Details]"))
        for obj in objects[:20]:
            items = i18n.pick("、", ", ").join(
                "{} {}≥{}".format(
                    a.get("metric"), a.get("value"), a.get("threshold")
                )
                for a in (obj.get("alarms") or [])
            )
            lines.append("- " + str(obj.get("label")) + i18n.pick("：", ": ") + items)

    high = any(str(c.get("confidence") or "") == "high" for c in root_causes)
    fields = [
        (i18n.pick("活动告警", "Active alerts"), str(total)),
        (i18n.pick("涉及对象", "Objects"), str(len(objects))),
        (i18n.pick("疑似同源", "Suspected groups"), str(len(suspects))),
    ]
    card = alerting.build_card(
        "critical" if high else "warning",
        title,
        stamp,
        fields,
        i18n.pick(
            "多条疑似同源的告警已聚合，详情见面板「告警」页面。",
            "Alerts that likely share a root cause have been grouped; see the “Alerts” page for details.",
        ),
    )
    return title, "\n".join(lines).strip(), card


# ------------------------------------------------------------------ 作业入口
async def run_once() -> Dict[str, Any]:
    """调度作业入口：同一个归属人名下的活动告警偏多时，聚合后推送一条根因报告。"""
    alarms = await alerting.visible_active(None)
    if not alarms:
        return {"skipped": i18n.pick("当前没有活动告警", "No active alerts")}

    by_owner: Dict[str, List[Dict[str, Any]]] = {}
    for row in alarms:
        by_owner.setdefault(str(row.get("username") or ""), []).append(row)

    checked = 0
    sent = 0
    failures: List[str] = []

    for owner, rows in by_owner.items():
        if len(rows) < STORM_MIN:
            continue
        checked += 1
        rows = rows[:MAX_ALARMS]
        groups = group(rows)
        fingerprint = _fingerprint(rows)
        if not _should_push(owner, fingerprint):
            continue

        feishu = await alerting.load_feishu(owner)
        email_cfg = await alerting.load_alert_email(owner)
        webhook = await alerting.load_webhook(owner)
        if not (
            feishu.get("enabled")
            or email_cfg.get("enabled")
            or webhook.get("enabled")
        ):
            continue

        user = await store.get_user(owner) or {}
        if str(user.get("status") or "") != store.STATUS_ACTIVE:
            continue
        is_admin = str(user.get("role") or "") == "admin"

        # 渲染与投递都切到收件人语言
        async with alerting.recipient_language(owner):
            insight = await analyse(groups, username=owner, is_admin=is_admin)
            title, text, card = _render(groups, insight)
            delivered, detail = await alerting.dispatch(
                owner,
                feishu,
                email_cfg,
                title,
                text,
                card,
                webhook=webhook,
                context={"level": "warning", "alarms": len(rows)},
                source=SOURCE,
            )
        if delivered:
            sent += 1
            _mark_pushed(owner, fingerprint)
        else:
            failures.append(owner + "：" + str(detail))

    if not checked:
        return {
            "skipped": i18n.pick(
                "没有达到聚合阈值的归属人", "No owner reached the grouping threshold"
            )
        }
    return {
        "owners": checked,
        "alarms": len(alarms),
        "sent": sent,
        "failures": failures[:5],
    }
