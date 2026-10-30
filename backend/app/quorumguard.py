"""集群仲裁巡检：任意一套 PVE 集群失去仲裁就告警。

为什么要单独一个来源
--------------------
资源告警（:func:`app.alerting.evaluate`）是「按对象比阈值」：规则挂在某个节点 /
虚拟机上，比的是 CPU / 内存 / 磁盘的百分比，而且只读**默认连接**那一套 PVE。
「集群失去仲裁」两样都不是 ——

* 它是 cluster 级的**状态翻转**（不是某个对象的百分比）；
* 多套 PVE 同级的部署里必须逐套检查，而恰恰是**非默认的那几套**最容易漏：
  仪表盘那张卡以前只读默认连接，非默认集群掉仲裁时页面上什么都看不出来。

所以这里照 :mod:`app.portguard` 的写法：自建 ``rule_id``、自己判冷却、复用告警
的去重 / 飞书邮件 / 恢复通知，**不需要**往告警规则表里加新指标。

判据来自 :func:`app.fleetstatus.collect` —— 与仪表盘集群态势卡、顶栏「控制台
状态」是同一份探测，避免出现「页面红着、告警不响」。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from . import alerting, fleetstatus, i18n, store

logger = logging.getLogger(__name__)

#: 自建的规则 id。它不落在 alert_rules 表里，只用于告警状态的去重键。
RULE_ID = "cluster-quorum"

#: 同一条连接重复提醒的间隔（秒）。失去仲裁不会自己恢复，这条规则存在的意义是
#: 「别让它静悄悄过去」，而不是每分钟喊一次。
COOLDOWN = 30 * 60


def no_quorum_connections(
    items: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """挑出**真的**失去仲裁的连接。

    判据必须是 ``is False``：单机连接与读不到 HA 的连接都是 ``quorate=None``，
    那不是「掉仲裁」。写成 ``not item.get("quorate")`` 会把它们一起报成集群故障 ——
    多套单机 PVE 的部署会立刻收到一屏假告警。
    """
    return [item for item in items if item.get("quorate") is False]


def _card(item: Dict[str, Any], at: float) -> Dict[str, Any]:
    """飞书卡片：把「哪一套、多大、什么版本」摆在一起，便于就地判断影响面。"""
    name = str(item.get("name") or item.get("id") or "")
    fields = [
        (i18n.tr("集群"), name),
        (i18n.tr("节点数"), str(item.get("node_count") or 0)),
        (i18n.tr("版本"), f"v{item.get('version') or '-'}"),
        (i18n.tr("HA 资源"), str(item.get("ha_resources") or 0)),
    ]
    return alerting.build_card(
        "critical",
        i18n.pick(f"🔴 {name} 失去仲裁", f"🔴 {name} lost quorum"),
        i18n.pick("集群已进入只读保护", "The cluster is in read-only protection"),
        fields,
        i18n.pick(
            f"触发时间 {alerting._now_text(at)} · quorate=false：该集群上的开机、"
            "迁移与配置修改都会被拒。请检查各节点间的 Corosync 通信与网络。",
            f"Triggered at {alerting._now_text(at)} · quorate=false: start, "
            "migrate and config operations on this cluster will be rejected. "
            "Check Corosync communication and networking between its nodes.",
        ),
    )


async def evaluate(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    """巡检所有 PVE 连接，失去仲裁即告警；恢复后再发一条解除通知。

    ``owner`` 只为对齐 :func:`app.alerting.evaluate` 的调用方式：集群是主机级的，
    没有「按用户隔离」的概念，传进来的用户名会被忽略（接收人取第一个管理员，
    与端口 / 备份巡检一致）。

    返回本轮触发项，供调度器摘要（见 main.py 的 ``_count``）。
    """
    data = await fleetstatus.collect()
    bad = no_quorum_connections(data.get("connections") or [])

    target_owner = await store.first_admin_username() or ""
    # 按收件人的语言渲染（巡检是后台跑的，没有请求上下文）
    i18n.pin_language(await alerting.resolve_language(target_owner))
    feishu = await alerting.load_feishu(target_owner)
    email_cfg = await alerting.load_alert_email(target_owner)
    # 显式读一份 Webhook：dispatch 不传时会自己读，但历史里的渠道要按「实际
    # 传给 dispatch 的那份配置」算（见 alerting.channel_ids），必须握在手上。
    webhook_cfg = await alerting.load_webhook(target_owner)
    now = time.time()

    active = await alerting.load_active()
    active = {
        key: row
        for key, row in active.items()
        if str(row.get("target_type")) == "cluster"
    }
    still_alarming: set = set()
    fired: List[Dict[str, Any]] = []

    for item in bad:
        name = str(item.get("name") or item.get("id") or "")
        key = alerting.alarm_key(target_owner, RULE_ID, name)
        still_alarming.add(key)
        # prev 非空 = 上一轮就在告警中，这一轮只是重复提醒（不写新历史）
        prev = active.get(key) or {}
        if now - float(prev.get("ts") or 0) < COOLDOWN:
            continue

        text = i18n.pick(
            f"集群「{name}」失去仲裁（quorate=false）：该集群已进入只读保护，"
            "开机 / 迁移 / 改配置都会被拒。请检查各节点间的 Corosync 通信与网络。",
            f"Cluster “{name}” lost quorum (quorate=false): it is in read-only "
            "protection, so start / migrate / config changes will be rejected. "
            "Check Corosync communication and networking between its nodes.",
        )
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            i18n.pick(f"集群失去仲裁：{name}", f"Cluster lost quorum: {name}"),
            text,
            _card(item, now),
            source=alerting.SOURCE_QUORUM,
            webhook=webhook_cfg,
        )
        state = {
            "username": target_owner,
            "rule_id": RULE_ID,
            "rule_name": i18n.pick("集群仲裁", "Cluster quorum"),
            "target_type": "cluster",
            "target": name,
            "metric": "quorum",
            "value": 0.0,
            "threshold": 1.0,
            "node": "",
            "ip": str(item.get("host") or ""),
            "vmid": None,
            "ts": int(now),
            "notify_source": alerting.SOURCE_QUORUM,
        }
        await alerting.mark_active(key, state)
        active[key] = dict(state, alarm_key=key)
        entry = {
            **state,
            "result": "sent" if ok else "failed",
            "detail": detail,
            "kind": "alarm",
        }
        await alerting.record(
            entry,
            source=alerting.SOURCE_QUORUM,
            repeat=bool(prev),
            channels=alerting.channel_ids(feishu, email_cfg, webhook_cfg),
        )
        entry["text"] = text
        fired.append(entry)

    # 恢复：之前告警过、这次不再命中 → 发恢复通知并清掉
    for key, row in list(active.items()):
        if key in still_alarming:
            continue
        if not await alerting.recovery_confirmed(key, row):
            continue  # 本轮只是没命中，还没到「连续 N 轮正常」的恢复门槛
        card = alerting.build_recovery_card(row, None, at=now)
        text = i18n.pick(
            f"集群「{row.get('target')}」的仲裁已恢复，告警解除",
            f"Cluster “{row.get('target')}” regained quorum; the alert is cleared",
        )
        ok, detail = await alerting.dispatch(
            target_owner,
            feishu,
            email_cfg,
            i18n.tr("恢复通知：") + str(row.get("target")),
            text,
            card,
            source=alerting.SOURCE_QUORUM,
            webhook=webhook_cfg,
        )
        await alerting.record(
            {
                "username": row.get("username") or target_owner,
                "rule_id": row.get("rule_id"),
                "rule_name": row.get("rule_name"),
                "target_type": "cluster",
                "target": row.get("target"),
                "metric": row.get("metric"),
                "value": float(row.get("value") or 0),
                "threshold": row.get("threshold"),
                "result": "sent" if ok else "failed",
                "detail": detail,
                "kind": "recovery",
            },
            source=alerting.SOURCE_QUORUM,
            channels=alerting.channel_ids(feishu, email_cfg, webhook_cfg),
        )
        await alerting.clear_active(key)
        fired.append({"kind": "recovery", "target": row.get("target"), "text": text})

    return fired
