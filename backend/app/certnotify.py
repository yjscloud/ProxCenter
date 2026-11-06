"""证书生命周期事件的告警出口。

与 :mod:`alerting` 的分工：那边是"指标越界"的规则引擎（CPU 高、磁盘满），
这边是"证书生命周期"事件（即将到期 / 续期失败 / 续期成功 / 部署失败）。
两者共用同一批通道配置 —— 站内信、邮件、通用 Webhook、飞书，避免用户为了
证书再配一遍。

三条设计约束：

1. **绝不打断续期**。告警发不出去只是没通知到，证书该续还得续，所以这里
   所有异常就地吞掉并留日志，返回值只用于调试。
2. **自带冷却**。续期作业每 6 小时一轮，不过滤的话「剩余 14 天」会变成
   一天四条；冷却窗口写在站点上（``notices``），重启也不丢。
3. **按归属发**。站点是哪个用户的，消息就发给谁；管理员不重复收，避免
   一人多站点时被自己刷屏。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

from . import i18n, notifications

log = logging.getLogger(__name__)

#: 事件类型。与前端 ``cert.event.*`` 的文案键一一对应。
EVENT_EXPIRING = "expiring"
EVENT_RENEW_FAILED = "renew_failed"
EVENT_RENEWED = "renewed"
EVENT_DEPLOY_FAILED = "deploy_failed"
#: 站点可用性从 up 翻到 down（及恢复）时发一次，冷却窗口内不重复
EVENT_SITE_DOWN = "site_down"
EVENT_SITE_UP = "site_up"

#: 默认冷却（秒）。到期提醒这类"每天说一次就够"的事件用它。
COOLDOWN = 12 * 3600

_LEVELS = {
    EVENT_EXPIRING: "warning",
    EVENT_RENEW_FAILED: "error",
    EVENT_RENEWED: "info",
    EVENT_DEPLOY_FAILED: "error",
    EVENT_SITE_DOWN: "error",
    EVENT_SITE_UP: "info",
}


def _notices(site: Dict[str, Any]) -> Dict[str, int]:
    raw = site.get("notices")
    if not isinstance(raw, dict):
        raw = {}
        site["notices"] = raw
    return raw


def cooled(site: Dict[str, Any], event: str, ttl: int = COOLDOWN) -> bool:
    """这个站点该事件是否还在冷却窗口内。"""
    last = int(_notices(site).get(event) or 0)
    return (time.time() - last) < ttl


def mark(site: Dict[str, Any], event: str, at: Optional[int] = None) -> None:
    _notices(site)[event] = int(at or time.time())


def _feishu_card(title: str, detail: str, level: str) -> Dict[str, Any]:
    """最小的飞书卡片：标题 + 一行正文。不追求花哨，能看懂就行。"""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": {"error": "red", "warning": "orange"}.get(level, "blue"),
            "title": {"tag": "plain_text", "content": title},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": detail}},
        ],
    }


async def notify(
    owner: str,
    site: Dict[str, Any],
    event: str,
    title: str,
    detail: str = "",
    *,
    ttl: int = COOLDOWN,
) -> bool:
    """把一条证书事件发到该站点归属者的所有已配置通道。

    返回 True 表示至少发出去了一个通道；False 表示冷却中或全部失败。
    """
    if not owner:
        return False
    if cooled(site, event, ttl):
        return False

    level = _LEVELS.get(event, "info")
    sent = False

    # 站内信永远写：它是最低成本的兜底，也不会打扰人
    try:
        await notifications.push(
            owner,
            title=title,
            body=detail,
            link="/certs",
            kind="cert",
            level=level,
        )
        sent = True
    except Exception:  # noqa: BLE001 - 通知失败不能影响续期
        log.warning("证书事件站内信写入失败：%s", event, exc_info=True)

    # 其余通道按需加载：alerting 依赖较重，且证书模块不该拖慢启动
    try:
        from . import alerting

        if detail:
            ok, _ = await alerting.send_alert_email(owner, title, detail)
            sent = sent or ok
            ok, _ = await alerting.send_webhook(title, detail, {"event": event}, owner)
            sent = sent or ok
            ok, _ = await alerting.send_feishu(_feishu_card(title, detail, level), owner)
            sent = sent or ok
    except Exception:  # noqa: BLE001
        log.warning("证书事件外发通道失败：%s", event, exc_info=True)

    if sent:
        mark(site, event)
    return sent
