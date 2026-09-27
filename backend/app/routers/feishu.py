"""飞书机器人：事件回调（公开，需签名校验）+ 配置接口（仅管理员）。

机器人是全局单例（一个应用凭证、一份指令集），因此配置页面只对管理员开放；
普通用户在侧边栏里看不到这一项，接口也会直接 403。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import feishu_bot, panel_url, security

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/feishu", tags=["feishu"])

# 仅管理员：飞书机器人页面与接口都不对普通用户开放
BOT_VIEW = security.require_admin()
BOT_MANAGE = security.require_admin()


async def _process_event(payload: Dict[str, Any], cfg: Dict[str, Any]) -> None:
    """后台处理事件并回复，避免超过飞书 3 秒的回调超时。"""
    try:
        reply = await feishu_bot.handle_event(payload, cfg)
        if reply and reply.get("message_id"):
            await feishu_bot.reply_card(cfg, str(reply["message_id"]), reply["card"])
    except Exception:  # noqa: BLE001
        logger.exception("处理飞书事件失败")


@router.post("/event")
async def feishu_event(request: Request) -> Dict[str, Any]:
    """飞书事件订阅入口（无需面板登录，靠签名与 Verification Token 校验）。"""
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    cfg = await feishu_bot.load_config()

    ok, reason = feishu_bot.verify_signature(headers, body, cfg)
    if not ok:
        logger.warning("飞书事件签名校验失败")
        raise HTTPException(status_code=403, detail=reason)

    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="事件内容不是合法 JSON") from exc

    # 首次配置回调地址时飞书会发来 url_verification
    if payload.get("type") == "url_verification":
        return {"challenge": str(payload.get("challenge") or "")}

    if payload.get("encrypt"):
        raise HTTPException(
            status_code=400,
            detail="事件已加密：请在飞书开放平台关闭 Encrypt Key（或改用明文事件），当前版本不支持解密。",
        )

    if not cfg.get("enabled"):
        return {"code": 0, "msg": "机器人未启用"}

    ok, reason = feishu_bot.check_token(payload, cfg)
    if not ok:
        raise HTTPException(status_code=403, detail=reason)

    asyncio.create_task(_process_event(payload, cfg))
    return {"code": 0}


def _masked(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """对外只回传"是否已配置"，不回传密钥明文。"""
    view = dict(cfg)
    view["app_secret_set"] = bool(cfg.get("app_secret"))
    view["verification_token_set"] = bool(cfg.get("verification_token"))
    view["encrypt_key_set"] = bool(cfg.get("encrypt_key"))
    view["app_secret"] = ""
    view["verification_token"] = ""
    view["encrypt_key"] = ""
    return view


@router.get("/config")
async def get_config(
    request: Request,
    user: Dict[str, Any] = Depends(BOT_VIEW),
) -> Dict[str, Any]:
    # 机器人配置里有 App Secret / 加密密钥（只回「是否已设置」）与回调地址，
    # 属于敏感读取，记录一下谁看过。
    await security.audit_read(request, user, "config.feishu.read")
    cfg = await feishu_bot.load_config()
    # 事件回调地址必须是飞书能访问到的对外地址，配置了全局地址就用它
    base = await panel_url.resolve(request) or str(request.base_url).rstrip("/")
    return {
        "config": _masked(cfg),
        "event_url": base + "/api/feishu/event",
        "commands": [
            {"cmd": "列表", "desc": "查看虚拟机总览"},
            {"cmd": "状态 <名称/ID>", "desc": "查看单台虚拟机"},
            {"cmd": "开机 <名称/ID>", "desc": "开机"},
            {"cmd": "关机 <名称/ID>", "desc": "关机（卡片确认）"},
            {"cmd": "重启 <名称/ID>", "desc": "重启（卡片确认）"},
            {"cmd": "创建", "desc": "弹出表单，可指定名称 / CPU / 内存 / 磁盘"},
            {"cmd": "快照 <名称/ID> [快照名]", "desc": "创建快照，省略名称时自动按时间命名"},
            {"cmd": "快照列表 <名称/ID>", "desc": "查看已有快照"},
            {"cmd": "回滚 <名称/ID> <快照名>", "desc": "回滚到快照（卡片确认）"},
            {"cmd": "备份 <名称/ID> [存储]", "desc": "立即执行一次备份"},
            {"cmd": "帮助", "desc": "显示指令列表"},
        ],
    }


@router.put("/config")
async def save_config(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(BOT_MANAGE),
) -> Dict[str, Any]:
    try:
        cfg = await feishu_bot.save_config(payload)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(
        request,
        user,
        "feishu.bot.config",
        "feishu",
        "success",
        "更新飞书机器人配置（" + ("已启用" if cfg.get("enabled") else "已关闭") + "）",
    )
    return {"config": _masked(cfg)}


@router.post("/test")
async def send_test(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(BOT_MANAGE),
) -> Dict[str, Any]:
    cfg = await feishu_bot.load_config()
    chat_id = str((payload or {}).get("chat_id") or "").strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="请填写要接收测试消息的会话 ID（oc_ 开头）")
    try:
        result = await feishu_bot.send_test(cfg, chat_id)
    except feishu_bot.BotError as exc:
        await security.audit(request, user, "feishu.bot.test", "feishu", "failed", str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await security.audit(request, user, "feishu.bot.test", "feishu", "success", result["detail"])
    return result
