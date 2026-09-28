"""监控告警接口：规则、飞书配置、历史与手动检测。

告警配置按用户隔离：规则、通知通道、历史记录各归属到使用它的用户
（规则的 ``username`` 字段）。管理员（``security.visible_owner`` 返回 ``None``）
可见并统计全部用户的规则与历史，普通用户只看得到自己的。
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import alerting, mailer, security, store

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

ALERT_VIEW = security.require_permission("alert.view")
ALERT_MANAGE = security.require_permission("alert.manage")


def _masked_feishu(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """对外只暴露打码后的 Webhook，明文地址与签名密钥永不回传前端。"""
    webhook = str(cfg.get("webhook") or "")
    secret = str(cfg.get("secret") or "")
    safe = dict(cfg)
    safe["webhook"] = ""
    safe["secret"] = ""
    return {
        "feishu": safe,
        "webhook_set": bool(webhook),
        "webhook_masked": alerting.mask_webhook(webhook),
        "secret_set": bool(secret),
    }


def _masked_hook(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """通用 Webhook 配置对外只说「配没配」，明文地址与签名密钥永不回传。

    字段名刻意与飞书那组（``webhook_set`` / ``webhook_masked``）区分开：
    两者同名会让前端把通用 Webhook 的状态错当成飞书的。
    """
    url = str(cfg.get("webhook") or "")
    secret = str(cfg.get("secret") or "")
    safe = dict(cfg)
    safe["webhook"] = ""
    safe["secret"] = ""
    return {
        "hook": safe,
        "hook_set": bool(url),
        "hook_masked": alerting.mask_webhook(url),
        "hook_secret_set": bool(secret),
    }


def _own(user: Dict[str, Any]) -> str:
    """当前登录用户名：他的规则、通知通道与历史都挂在这个名字下。"""
    return str(user.get("username") or "")


@router.get("")
async def get_alerts(
    user: Dict[str, Any] = Depends(ALERT_VIEW),
) -> Dict[str, Any]:
    scope = security.visible_owner(user)
    # 通知通道永远是自己那一份，不做汇总
    feishu = await alerting.load_feishu(_own(user))
    email = await alerting.load_alert_email(_own(user))
    hook = await alerting.load_webhook(_own(user))
    return {
        **_masked_feishu(feishu),
        **_masked_hook(hook),
        # 预设模板与可用占位符随配置一起给前端：让用户「一键填企微/钉钉/Slack」
        # 而不是对着空文本框猜 JSON 怎么写
        "hook_presets": alerting.WEBHOOK_PRESETS,
        "hook_placeholders": alerting.WEBHOOK_PLACEHOLDERS,
        "email": email,
        # 邮件要能发出去得先有全局 SMTP；没有就把状态一起回给前端，
        # 界面上直接提示「去设置页配置 SMTP」，而不是让用户猜为什么收不到
        "mail_ready": mailer.is_configured(await mailer.load_mail()),
        "account_email": (await store.get_user(_own(user)) or {}).get("email") or "",
        "rules": alerting.visible_rules(await alerting.load_rules(), scope),
        "history": await alerting.history(80, scope),
        # 此刻还没恢复的告警。与 history 的区别：history 是「发生过什么」，
        # 这里是「还有几件事没解决」—— 首页工作台的待办数量以它为准。
        "active": await alerting.visible_active(scope),
        "metrics": alerting.METRIC_LABELS,
        # 推送来源开关是**全局**（跨用户）设置，读取不设门槛 —— 每个能看告警页的
        # 人都该知道「现在这类告警是被关掉的」，否则会误以为系统没告警能力。
        # 改是管理员权限，见 PUT /notify-sources。
        "notify_sources": alerting.NOTIFY_SOURCES,
        "notify_enabled": await alerting.load_notify_sources(),
        "own_username": _own(user),
        "is_admin": scope is None,
    }


@router.put("/notify-sources")
async def save_notify_sources(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_admin()),
) -> Dict[str, Any]:
    """保存「哪些来源允许推送告警」。

    管的是**推送**，不是巡检：关掉之后该来源的巡检照跑，但命中的告警**整条丢弃**
    —— 飞书 / 邮件 / 通用 Webhook / 站内消息不再发出，告警历史与首页工作台待办
    里也不会出现（见 alerting.record 与 alerting.push_enabled）。
    用户关这个开关的动机通常就是「别再用这类告警烦我」，留痕会让待处理条数降不
    下去，看起来像开关没生效。

    刻意要管理员而不是 ``alert.manage``：这几个开关是全局的，一关就是**所有人**
    都收不到该类告警。让持有 alert.manage 的普通用户能一键捂掉管理员的告警，
    等于开了一个「先把告警关掉再干活」的后门。
    """
    saved = await alerting.save_notify_sources(payload)
    await security.audit(
        request,
        user,
        "alert.notify_sources",
        "alerts",
        "success",
        "更新告警推送来源开关："
        + "，".join(
            f"{alerting.NOTIFY_LABELS.get(k, k)}={'开' if v else '关'}"
            for k, v in saved.items()
        ),
    )
    return {
        "notify_sources": alerting.NOTIFY_SOURCES,
        "notify_enabled": saved,
    }


@router.put("/feishu")
async def save_feishu(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    try:
        cfg = await alerting.save_feishu(payload, _own(user))
    except alerting.FeishuConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request, user, "alert.feishu", "alerts", "success", "更新告警通知配置（本人）"
    )
    return _masked_feishu(cfg)


@router.put("/email")
async def save_email(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    """保存当前用户的告警邮件收件人 —— 只影响自己那一份。

    SMTP 服务器是全局配置（管理员在设置页配），这里管的只是「发给谁」。
    """
    try:
        cfg = await alerting.save_alert_email(payload, _own(user))
    except alerting.AlertEmailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request, user, "alert.email", "alerts", "success",
        "更新告警邮件通知（本人）："
        + ("开启" if cfg["enabled"] else "关闭")
        + "，收件人 " + (cfg["recipients"] or "（默认账号邮箱）"),
    )
    return {
        "email": cfg,
        "mail_ready": mailer.is_configured(await mailer.load_mail()),
    }


@router.put("/webhook")
async def save_hook(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    """保存当前用户的通用 Webhook —— 地址与签名密钥加密存储。

    与飞书通道同一约定：字段留空 = 不修改，要清除得显式带 ``webhook_clear`` /
    ``secret_clear``。
    """
    try:
        cfg = await alerting.save_webhook(payload, _own(user))
    except alerting.WebhookConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "alert.webhook",
        "alerts",
        "success",
        "更新通用 Webhook（本人）："
        + ("开启" if cfg["enabled"] else "关闭")
        + ("，已设签名" if cfg["secret"] else "，未设签名"),
    )
    return _masked_hook(cfg)


@router.put("/rules")
async def save_rule_list(
    payload: List[Dict[str, Any]],
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    """保存规则：只覆盖自己名下的规则，别人的规则原样保留。"""
    scope = security.visible_owner(user)
    saved = await alerting.save_rules_for(payload, _own(user))
    await security.audit(
        request,
        user,
        "alert.rules",
        "alerts",
        "success",
        "保存告警规则 " + str(len(alerting.visible_rules(saved, scope))) + " 条",
    )
    return {"rules": alerting.visible_rules(saved, scope)}


@router.post("/test")
async def test_notify(
    request: Request,
    channel: str = Query(default="feishu", pattern="^(feishu|webhook)$"),
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    """发一条测试通知。``channel`` 默认飞书，保持既有前端调用不变。"""
    if channel == "webhook":
        ok, detail = await alerting.send_webhook(
            "测试通知",
            "这是一条来自 ProxCenter 的测试消息，收到即表示通用 Webhook 配置正确。",
            {"level": "test", "target": "-", "metric": "-", "value": "-"},
            _own(user),
        )
    else:
        ok, detail = await alerting.send_feishu(alerting.build_test_card(), _own(user))

    await security.audit(
        request,
        user,
        "alert.test",
        "alerts",
        "success" if ok else "failed",
        f"{channel}：{detail}",
    )
    if not ok:
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True, "detail": detail, "channel": channel}


@router.post("/check")
async def check_now(
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    """立即检测：普通用户只检测自己的规则，管理员检测全部。"""
    fired = await alerting.evaluate(security.visible_owner(user))
    await security.audit(
        request, user, "alert.check", "alerts", "success", "手动检测命中 " + str(len(fired)) + " 条"
    )
    return {"fired": fired, "count": len(fired)}


@router.delete("/history")
async def clear_history(
    request: Request,
    user: Dict[str, Any] = Depends(ALERT_MANAGE),
) -> Dict[str, Any]:
    removed = await alerting.clear_history(security.visible_owner(user))
    await security.audit(
        request, user, "alert.history.clear", "alerts", "success", "清空告警历史 " + str(removed) + " 条"
    )
    return {"removed": removed, "detail": "已清除 " + str(removed) + " 条告警历史"}
