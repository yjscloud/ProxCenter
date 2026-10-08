"""AI 排查助手的接口。

* ``GET  /api/ai/config``      —— 读配置（密钥只回「配没配」与打码值）
* ``PUT  /api/ai/config``      —— 保存配置
* ``POST /api/ai/config/test`` —— 连通性测试（可用未保存的表单值直接测）
* ``GET  /api/ai/targets``     —— 可排查的主机清单 + 助手可用状态
* ``POST /api/ai/inspect``     —— 跑一次排查

权限上刻意分成两档：

* **排查**只读 —— 读的是平台已经采集好的巡检结果，不连目标主机、不改任何
  配置，因此沿用 ``baseline.view``：能看体检报告的人就能让 AI 解读一遍；
* **配置**是全局动作（所有用户共用同一份模型配置和密钥），只有管理员能碰。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import StreamingResponse

from .. import (
    ai,
    ai_approval,
    aichat,
    aiaudit,
    aiplaybooks,
    aiterm,
    baseline,
    hostscope,
    i18n,
    security,
    store,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])

VIEW = security.require_permission("baseline.view")
ADMIN = security.require_admin()

# 同时进行的排查上限。一次 L2 排查要 SSH 到目标主机跑多轮命令、再调七八次模型；
# 多用户并发时既可能压垮被排查的机器，也可能瞬间打爆模型额度（花的是配 key 那位的钱）。
# 超出上限的排在后面等，不直接拒绝 —— 排队比失败更符合预期。
MAX_CONCURRENT_INSPECTIONS = 4
_INSPECT_SEM: Optional[asyncio.Semaphore] = None


def _inspect_semaphore() -> asyncio.Semaphore:
    """排查并发闸门。懒建是为了不绑定到 import 时可能还不存在的事件循环。"""
    global _INSPECT_SEM
    if _INSPECT_SEM is None:
        _INSPECT_SEM = asyncio.Semaphore(MAX_CONCURRENT_INSPECTIONS)
    return _INSPECT_SEM


@router.get("/config")
async def get_config(user: Dict[str, Any] = Depends(ADMIN)) -> Dict[str, Any]:
    cfg = await ai.load_config()
    # 厂商预设跟着配置一起下发：配置面板一打开就能用，省一次往返
    return {**ai.public_config(cfg), "presets": ai.provider_presets()}


@router.put("/config")
async def put_config(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(ADMIN),
) -> Dict[str, Any]:
    """保存配置。``api_key`` 留空表示沿用旧密钥（与腾讯云那套约定一致）。"""
    saved = await ai.save_config(payload)
    await security.audit(
        request,
        user,
        "ai.config",
        "ai",
        "success",
        "更新 AI 排查助手配置（" + str(len(saved.get("providers") or [])) + " 个模型）",
    )
    return saved


@router.post("/config/test")
async def test_config(
    payload: Dict[str, Any],
    user: Dict[str, Any] = Depends(ADMIN),
) -> Dict[str, Any]:
    """连通性测试。

    允许直接拿**还没保存**的表单值来测（地址填错时不该逼用户先存一遍再发现），
    密钥留空则回退到已保存的那一份。
    """
    item = payload.get("provider") if isinstance(payload.get("provider"), dict) else payload
    prov = ai.normalise_provider(item or {})

    if not prov.get("api_key"):
        cfg = await ai.load_config()
        for old in cfg.get("providers") or []:
            if old.get("id") == prov.get("id"):
                prov["api_key"] = old.get("api_key") or ""
                break

    try:
        return await ai.test_provider(prov)
    except ai.AIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/targets")
async def targets(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """可排查的主机清单，附带助手当前的可用状态。

    状态一起回给前端，是为了让页面能区分「还没配模型」和「配好了可以排查」
    两种情形，而不是让用户点一下才被告知没配置。
    """
    allowed = await hostscope.allowed_host_ids(user)
    cfg = await ai.load_config()
    # 必须带上身份：模型是严格隔离的，"我到底有没有可用的模型"因人而异。
    # 漏传身份会按匿名算（谁都不许），于是明明配好了也显示「还没有配置大模型」，
    # 而下面的模型下拉却是满的 —— 自相矛盾的提示比没有提示更糟。
    provider = ai.active_provider(
        cfg,
        username=str(user.get("username") or ""),
        is_admin=_is_admin(user),
    )
    return {
        # 刻意**不含面板本机**（ai.ai_targets 负责剔除）：本机是跑着这个面板、
        # 握着全部受管凭据的那台机器，而助手会上机执行命令、还能开终端。
        # 本机的安全状况另有自己那几页的本机作用域，不必从这条更放权的路进来。
        "hosts": ai.ai_targets(await baseline.targets(allowed)),
        "status": {
            "enabled": bool(cfg.get("enabled")),
            "ready": bool(cfg.get("enabled") and provider),
            "provider": (provider.get("name") or provider.get("model") or "") if provider else "",
            "provider_kind": (provider.get("kind") or "") if provider else "",
        },
    }


def _is_admin(user: Dict[str, Any]) -> bool:
    return str(user.get("role") or "") == "admin"


@router.get("/models")
async def models(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """已接入的模型清单（不含密钥），**所有能排查的用户都能看**。

    放在这个权限档是有意的：用户需要知道平台接了哪些模型，才能判断该不该
    指望 AI 帮上忙。管理员那份配置（含各家 Base URL）仍然只有管理员能读。
    """
    return ai.public_models(
        await ai.load_config(),
        username=str(user.get("username") or ""),
        is_admin=_is_admin(user),
    )


@router.get("/capabilities")
async def capabilities(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """这个助手能做什么：工具清单 + 边界。给页面上的「能力说明」用。"""
    return ai.capabilities()


@router.get("/my-providers")
async def my_providers(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """我自己的模型（外加平台共享的，只读）。

    普通用户靠这个入口维护自己的模型 —— 用自己的 key、花自己的额度，也不会
    看见别人配了什么。管理员请用 ``/config``，那份能看见并管理全平台的。
    """
    # 带上用户名：分析窗口与单次 token 上限要回他**自己**设的值，而不是平台默认
    cfg = await ai.load_config(str(user.get("username") or ""))
    return {
        **ai.user_config(cfg, str(user.get("username") or "")),
        "presets": ai.provider_presets(),
        # 个人不能建「全局共享」：那会把自己的凭据推给所有人用
        "can_share": False,
    }


@router.put("/my-providers")
async def save_my_providers(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """保存自己的模型。归属由后端强制盖上，前端传什么都不作数。"""
    username = str(user.get("username") or "")
    result = await ai.save_user_providers(username, payload)
    await security.audit(
        request,
        user,
        "ai.providers.save",
        "ai_config",
        "success",
        f"保存个人模型 {len(result.get('providers') or [])} 项",
    )
    return result


@router.get("/sessions")
async def sessions(
    limit: int = 20,
    offset: int = 0,
    host_id: str = "",
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """排查记录（工具调用明细的入口）。

    普通用户只看到自己的记录；管理员能看全部 —— 这是"平台代用户在他的服务器上
    执行过命令"的账，谁都能查自己那份，管理员能查所有。
    """
    username = "" if _is_admin(user) else str(user.get("username") or "")
    return await aiaudit.list_sessions(
        limit=limit, offset=offset, username=username, host_id=host_id
    )


@router.get("/sessions/{session_id}")
async def session_detail(
    session_id: str,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """单次排查的详情：会话信息 + 每一步工具调用。"""
    record = await aiaudit.get_session(session_id)
    if not record:
        raise HTTPException(status_code=404, detail=i18n.tr("找不到这条排查记录"))
    # 越权检查：普通用户只能看自己的
    if not _is_admin(user) and str(record.get("username") or "") != str(
        user.get("username") or ""
    ):
        raise HTTPException(status_code=403, detail=i18n.tr("找不到这条排查记录"))
    return {"session": record, "calls": await aiaudit.session_calls(session_id)}


@router.post("/inspect")
async def inspect(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """跑一次排查。

    最坏要等一轮远端 SSH 体检 + 一次模型调用（十几秒到一分钟），所以前端
    需要自己显示进度，不要依赖这个接口做流式输出 —— L1 先把结论跑通，
    流式留给 L2 的 Agent 循环。
    """
    host_id = str(payload.get("host_id") or "local")
    provider_id = str(payload.get("provider_id") or "")
    allowed = await hostscope.allowed_host_ids(user)

    try:
        async with _inspect_semaphore():
            result = await ai.inspect(
                host_id,
                allowed,
                provider_id=provider_id,
                username=str(user.get("username") or ""),
                is_admin=_is_admin(user),
            )
    except ai.AIError as exc:
        # 越权、没配模型、上游报错都在这里 —— 都是可预期的业务错误，回 400
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "ai.inspect",
        result.get("host_name") or host_id,
        "success",
        "AI 排查 "
        + str(result.get("host_name") or host_id)
        + "："
        + str(len((result.get("result") or {}).get("findings") or []))
        + " 条结论，"
        + str((result.get("usage") or {}).get("total_tokens") or 0)
        + " tokens",
    )
    return result


@router.post("/inspect/stream")
async def inspect_stream(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> StreamingResponse:
    """L2：带工具调用的排查，边跑边推过程。

    为什么不用 ``EventSource``：它只能发 GET，而我们要传 body（host_id）、
    还要能带 CSRF 之外的凭据 —— 用 POST + 流式响应，前端拿 ``fetch`` 读
    ``ReadableStream`` 就行。

    事件类型（每行一个 ``data:`` JSON）：

    * ``stage``      —— 阶段切换（collect）；
    * ``thinking``   —— 第 N 轮开始；
    * ``tool_start`` —— 要调某个工具了（工具名 + 参数）；
    * ``tool_done``  —— 工具返回（成功与否 + 输出预览 + 耗时）；
    * ``done``       —— 最终结果（结构与 L1 一致，前端共用渲染）；
    * ``error``      —— 可预期的失败（没配模型、越权、上游报错）。

    过程事件是给用户「看得见」用的：一次排查要十几秒到一分钟，没有实时反馈
    用户会以为页面卡死。
    """
    host_id = str(payload.get("host_id") or "local")
    provider_id = str(payload.get("provider_id") or "")
    # 授权执行：用户勾了「允许 AI 在目标主机执行只读命令」，且本人有 ai.exec 权限。
    # 权限位与授权要同时成立 —— 勾选框不是授权本身，它只是一次显式确认。
    allow_exec = bool(payload.get("allow_exec"))
    if allow_exec and not security.has_user_permission(user, "ai.exec"):
        raise HTTPException(
            status_code=403,
            detail=i18n.tr("没有「授权 AI 上机执行」的权限"),
        )
    allowed = await hostscope.allowed_host_ids(user)
    username = str(user.get("username") or "")
    queue: "asyncio.Queue[Any]" = asyncio.Queue()

    async def emit(event: Dict[str, Any]) -> None:
        # 用户关了页面或点了「终止」：连接已经断开，再往下跑只是白烧 token。
        # 抛出去让 agent 循环停下来 —— notify 会放行这一个异常（见 StopInspection）。
        if await request.is_disconnected():
            raise ai.StopInspection()
        await queue.put(event)

    async def worker() -> None:
        session_id = ""
        started = time.time()
        host_name = host_id
        sem = _inspect_semaphore()
        try:
            # 并发到顶时先告诉前端「排队中」，否则用户对着转圈会以为页面卡死
            if sem.locked():
                await queue.put({"type": "stage", "stage": "queued"})
            async with sem:
                host = await ai.resolve_host(host_id, allowed)
                host_name = str(host.get("name") or host_id)

                session_id = await aiaudit.open_session(
                    username=username,
                    host_id=host_id,
                    host_name=host_name,
                    provider="",
                    mode="agent",
                )
                result = await ai.inspect_agent(
                    host_id,
                    allowed,
                    emit=emit,
                    provider_id=provider_id,
                    username=username,
                    is_admin=_is_admin(user),
                    allow_exec=allow_exec,
                )

                calls = result.get("tool_calls") or []
                await aiaudit.record_calls(session_id, calls)
                await aiaudit.finish_session(
                    session_id,
                    status="done",
                    model=str(result.get("model") or ""),
                    steps=int(result.get("steps") or 0),
                    tool_calls=len(calls),
                    usage=result.get("usage") or {},
                    duration_ms=int((time.time() - started) * 1000),
                    # 结论也落库：否则回看记录只有「跑了什么」，没有「结论是什么」
                    result=result.get("result"),
                )
                await queue.put({"type": "done", "result": result, "session_id": session_id})
                await security.audit(
                    request,
                    user,
                    "ai.inspect",
                    host_name,
                    "success",
                    "AI 排查（工具调用"
                    + ("，已授权上机执行" if allow_exec else "")
                    + "）"
                    + host_name
                    + "："
                    + str(len(calls))
                    + " 次工具调用，"
                    + str(len((result.get("result") or {}).get("findings") or []))
                    + " 条结论",
                )
        except ai.StopInspection:
            # 用户终止：不算失败。但会话必须收口 —— 否则排查记录里会留一条
            # 永远「进行中」的记录，事后分不清是真卡死了还是人为停掉的。
            if session_id:
                await aiaudit.finish_session(session_id, status="cancelled")
            await queue.put({"type": "aborted"})
        except ai.AIError as exc:
            if session_id:
                await aiaudit.finish_session(session_id, status="failed", error=str(exc))
            await queue.put({"type": "error", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 - 兜底：异常也要让前端收到结束信号
            logger.exception("AI 排查异常")
            if session_id:
                await aiaudit.finish_session(
                    session_id, status="failed", error=str(exc)[:300]
                )
            await queue.put({"type": "error", "message": str(exc)[:300]})
        finally:
            await queue.put(None)  # 结束哨兵

    async def gen():
        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # 面板前面有 nginx：不关缓冲的话事件会被攒着一起发，流式就没意义了
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/approval")
async def resolve_approval(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """批准 / 拒绝 AI 提议的一条写命令（逐条确认）。

    与排查是两条连接：排查挂在 SSE 上等，这里用一次普通 POST 把它唤醒。
    权限与授权一致（``ai.exec``）—— 能授权上机执行的人才谈得上逐条批准。
    """
    if not security.has_user_permission(user, "ai.exec"):
        raise HTTPException(
            status_code=403,
            detail=i18n.tr("没有「授权 AI 上机执行」的权限"),
        )

    approval_id = str(payload.get("approval_id") or "")
    approved = bool(payload.get("approved"))
    if not approval_id:
        raise HTTPException(status_code=400, detail=i18n.tr("缺少 approval_id"))

    hit = ai_approval.resolve(approval_id, approved)
    await security.audit(
        request,
        user,
        "ai.approval",
        target=approval_id,
        result="success" if hit else "failed",
        detail=("批准" if approved else "拒绝")
        + ("执行写命令" if hit else "（请求已失效或超时）"),
    )
    return {"ok": hit}


# ------------------------------------------------------------------ 会话式对话
#
# 与上面 `/inspect/stream`（一次性排查）的分工：这里把「排查」放进一条**会话线程**
# 里，首轮体检产出报告、之后可以继续追问。线程落库，刷新或换设备都能接着聊。

@router.get("/playbooks")
async def playbooks(user: Dict[str, Any] = Depends(VIEW)) -> Dict[str, Any]:
    """排障预案清单（可插拔的提问模板）。

    只读、不含任何主机信息，因此与「能排查」同权限档即可。前端拿它渲染空会话
    的快捷入口 —— 想加一套新套路，改 ``aiplaybooks.py`` 就行，前端不用动。
    """
    return {"items": aiplaybooks.list_playbooks()}


@router.get("/conversations")
async def list_conversations(
    host_id: str = "",
    limit: int = 20,
    offset: int = 0,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """我的会话列表（管理员看全部）。用于「继续上次的对话」与记录页的会话视图。"""
    username = "" if _is_admin(user) else str(user.get("username") or "")
    return await aichat.list_conversations(
        username=username, host_id=host_id, limit=limit, offset=offset
    )


@router.post("/conversations")
async def create_conversation(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """开一条新会话。

    越权在动模型之前就挡住：``resolve_host`` 会确认这台主机在该用户的可见范围内，
    不合法直接 400 —— 不能等采集完证据才发现「你没权限看这台机器」。
    """
    host_id = str(payload.get("host_id") or "local")
    allowed = await hostscope.allowed_host_ids(user)
    try:
        host = await ai.resolve_host(host_id, allowed)
    except ai.AIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 会话级的「允许上机执行」授权：与逐轮 payload 同一道权限门
    allow_exec = bool(payload.get("allow_exec"))
    if allow_exec and not security.has_user_permission(user, "ai.exec"):
        raise HTTPException(
            status_code=403,
            detail=i18n.tr("没有「授权 AI 上机执行」的权限"),
        )

    conv = await aichat.create_conversation(
        username=str(user.get("username") or ""),
        host_id=host_id,
        host_name=str(host.get("name") or host_id),
        provider=str(payload.get("provider_id") or ""),
        allow_exec=allow_exec,
    )
    await security.audit(
        request,
        user,
        "ai.conversation",
        target=conv["id"],
        result="success",
        detail="新建 AI 会话：" + str(host.get("name") or host_id),
    )
    return conv


@router.get("/conversations/{conversation_id}")
async def conversation_detail(
    conversation_id: str,
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """会话详情：元信息 + 全部消息 + 最近一次运行的元信息。

    越权按 404 处理（而不是 403）—— 不向非本人确认这条会话是否存在。
    """
    conv = await aichat.get_conversation(conversation_id)
    if not conv or not aichat.owns(
        conv, str(user.get("username") or ""), _is_admin(user)
    ):
        raise HTTPException(status_code=404, detail=i18n.tr("找不到这条会话"))
    # 会话上存的是建会话时的主机名快照（库里保留），展示用**当前**名字 ——
    # 受管主机改过名之后，报告卡上那行主机名还显示旧名就认不出了。
    hostscope.apply_display_names([conv], await hostscope.current_display_names())
    return {
        "conversation": conv,
        "messages": await aichat.list_messages(conversation_id),
        # 报告页要显示「模型 / 耗时 / token / 工具数」，这些记在运行上
        "session": await aiaudit.latest_session_for_conversation(conversation_id),
    }


@router.post("/conversations/{conversation_id}/messages/stream")
async def conversation_stream(
    conversation_id: str,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(VIEW),
) -> StreamingResponse:
    """在一条会话里发一条消息，边跑边推过程（SSE）。

    事件类型与 `/inspect/stream` 基本一致，另外多两个：
    ``assistant``（本轮回复文本）与 ``report``（首轮产出的 findings 报告）。
    """
    conv = await aichat.get_conversation(conversation_id)
    username = str(user.get("username") or "")
    is_admin = _is_admin(user)
    if not conv or not aichat.owns(conv, username, is_admin):
        raise HTTPException(status_code=404, detail=i18n.tr("找不到这条会话"))

    allow_exec = bool(payload.get("allow_exec"))
    if allow_exec and not security.has_user_permission(user, "ai.exec"):
        raise HTTPException(
            status_code=403,
            detail=i18n.tr("没有「授权 AI 上机执行」的权限"),
        )

    text = str(payload.get("text") or "")
    provider_id = str(payload.get("provider_id") or "")
    # chat（默认，自由对话）/ inspect（体检模板，产出报告）。未知值一律当自由对话。
    mode = aichat.normalise_mode(payload.get("mode"))
    # 预案 key：给了就用预案的指令代替用户输入（见 aiplaybooks）
    preset = str(payload.get("preset") or "")
    allowed = await hostscope.allowed_host_ids(user)
    queue: "asyncio.Queue[Any]" = asyncio.Queue()

    async def emit(event: Dict[str, Any]) -> None:
        # 用户关了页面或点了「终止」：连接已断，再往下跑只是白烧 token。
        if await request.is_disconnected():
            raise ai.StopInspection()
        await queue.put(event)

    async def worker() -> None:
        session_id = ""
        started = time.time()
        sem = _inspect_semaphore()
        try:
            if sem.locked():
                await queue.put({"type": "stage", "stage": "queued"})
            async with sem:
                session_id = await aiaudit.open_session(
                    username=username,
                    host_id=str(conv.get("host_id") or ""),
                    host_name=str(conv.get("host_name") or ""),
                    provider="",
                    mode="chat",
                    conversation_id=conversation_id,
                )
                result = await aichat.chat_turn(
                    conversation_id,
                    text,
                    mode=mode,
                    preset=preset,
                    emit=emit,
                    allowed=allowed,
                    provider_id=provider_id,
                    username=username,
                    is_admin=is_admin,
                    allow_exec=allow_exec,
                )
                calls = result.get("tool_calls") or []
                await aiaudit.record_calls(session_id, calls)
                await aiaudit.finish_session(
                    session_id,
                    status="done",
                    model=str(result.get("model") or ""),
                    steps=int(result.get("steps") or 0),
                    tool_calls=len(calls),
                    usage=result.get("usage") or {},
                    duration_ms=int((time.time() - started) * 1000),
                    result=result.get("report"),
                )
                await queue.put(
                    {
                        "type": "done",
                        "conversation_id": conversation_id,
                        "session_id": session_id,
                    }
                )
                await security.audit(
                    request,
                    user,
                    "ai.chat",
                    target=str(conv.get("host_name") or conversation_id),
                    result="success",
                    detail="AI 对话（"
                    + ("体检" if result.get("mode") == aichat.MODE_INSPECT else "追问")
                    + "）："
                    + str(len(calls))
                    + " 次工具调用",
                )
        except ai.StopInspection:
            # 用户终止不算失败，但会话必须收口，否则记录里会留一条永远「进行中」
            if session_id:
                await aiaudit.finish_session(session_id, status="cancelled")
            await queue.put({"type": "aborted"})
        except ai.AIError as exc:
            if session_id:
                await aiaudit.finish_session(session_id, status="failed", error=str(exc))
            await queue.put({"type": "error", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 - 兜底：异常也要让前端收到结束信号
            logger.exception("AI 会话异常")
            if session_id:
                await aiaudit.finish_session(
                    session_id, status="failed", error=str(exc)[:300]
                )
            await queue.put({"type": "error", "message": str(exc)[:300]})
        finally:
            await queue.put(None)  # 结束哨兵

    async def gen():
        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # 面板前面有 nginx：不关缓冲的话事件会被攒着一起发，流式就没意义了
            "X-Accel-Buffering": "no",
        },
    )


# ------------------------------------------------------------------ 远程终端
#
# 左侧那个终端的后端：浏览器里的 xterm.js ↔ 这条 WebSocket ↔ paramiko 的交互式
# shell。与上面几条排查接口最大的不同是 —— 它给的是一条**能敲任意命令**的通道。
#
# 因此门开得比只读排查紧得多：
# * 单列一个 ``ai.terminal`` 权限（默认仅管理员）——「能看 AI 的结论」和
#   「能亲手在这台机器上敲命令」不是一回事；
# * 归属校验沿用受管主机那一套（``hostscope.assert_host_access``），
#   别人的主机连不上；
# * 面板本机（``local``）不开放：那是面板自己所在的那台机器，走 SSH 受管
#   主机之外的路子登录更合适；
# * 打开与关闭各写一条审计。
#
# 终端里的按键由远端 shell 自己解释，不逐条进 ``ai_tool_calls``（那是 AI 的账）；
# 用户自己在机器上做过什么由该机自己的 audit / history 负责 —— 与 SSH 直连的
# 语义一致，不必也不该由面板替它记账。

TERMINAL_PERMISSION = "ai.terminal"


async def _reject_ws(websocket: WebSocket, code: int, reason: str) -> None:
    """**握手前**拒绝（来源校验失败 / 凭据无效）：不 accept，直接关。

    这两种失败发生在身份确认之前，原因只能写进服务端日志 —— 对一个还没通过
    认证的调用方说「这台主机不属于当前用户」本身就是信息泄露。

    与 console.py 同样的理由记日志：uvicorn 对「accept 之前关闭」一律记成 403，
    光看访问日志分不清是来源校验、凭据无效还是权限不足。
    """
    logger.info(
        "AI 终端握手被拒 %s：code=%s 原因=%s Origin=%s Host=%s 有Cookie=%s",
        websocket.url.path,
        code,
        reason,
        websocket.headers.get("origin") or "-",
        websocket.headers.get("host") or "-",
        bool(websocket.cookies.get(security.ACCESS_COOKIE)),
    )
    await websocket.close(code=code, reason=reason)


async def _fail_after_auth(websocket: WebSocket, code: int, reason: str) -> None:
    """**已认证之后**的失败：先 accept，把原因发给前端，再关闭。

    为什么不能像 ``_reject_ws`` 那样直接关：accept 之前关闭时，uvicorn 只回一个
    HTTP 403，浏览器侧 ``onerror`` 拿到的是没有任何内容的通用失败 ——「这台机器
    SSH 连不上」和「你没有权限」在界面上长得一模一样，用户只能看到「连接失败」
    三个字，无从下手。这几条失败都发生在身份已经验证过之后，把原因告诉本人
    不泄露任何东西。

    关闭码按语义分：策略类（权限 / 归属 / 缺参）用 1008，上游（SSH 连不上）
    用 1011。前端主要读那条 error 帧，码只是给日志看的。
    """
    logger.info(
        "AI 终端失败（已认证）%s：code=%s 原因=%s", websocket.url.path, code, reason
    )
    try:
        await websocket.accept()
        await websocket.send_text(
            json.dumps({"type": "error", "message": reason}, ensure_ascii=False)
        )
    except Exception:  # noqa: BLE001 - 对端已经跑了也要继续走关闭
        logger.debug("AI 终端错误帧发送失败", exc_info=True)
    try:
        await websocket.close(code=code, reason=reason[:120])
    except Exception:  # noqa: BLE001
        logger.debug("AI 终端关闭失败", exc_info=True)


async def _ws_identity(websocket: WebSocket, token: str) -> Dict[str, Any]:
    """WebSocket 侧的鉴权：握手令牌 → 用户（含用户级权限覆盖）。

    与 HTTP 侧只有令牌来源不同（WS 没法带 Authorization 头，走 ``?token=`` 或
    同源 HttpOnly Cookie）。身份**从库里重新读**而不是只看 JWT 里的 role：
    自定义角色与用户级权限覆盖都记在用户行上，只看 token 会让「被单独授权过的
    人」进不来、而「权限已被收回的人」照样进得来。
    """
    value = security.ws_token(websocket, token)
    if not value:
        raise PermissionError(i18n.t("error.no_credentials"))
    try:
        payload = security.decode_token(value, expected_typ="access")
        await security.ensure_session_active(payload)
    except HTTPException as exc:
        raise PermissionError(str(exc.detail)) from exc

    username = str(payload.get("sub") or "")
    user = await store.get_user(username) if username else None
    if not user:
        raise PermissionError(i18n.tr("无效的认证凭据"))
    if not user.get("enabled", True) or str(
        user.get("status") or store.STATUS_ACTIVE
    ) != store.STATUS_ACTIVE:
        raise PermissionError(
            i18n.pick("账号不可用", "The account is not usable")
        )
    return {
        "username": username,
        "role": str(user.get("role") or "viewer"),
        "permissions_override": user.get("permissions_override"),
    }


async def _terminal_pump(session: aiterm.TerminalSession, websocket: WebSocket) -> None:
    """两个方向各一个任务：浏览器 → 远端 shell，远端 → 浏览器。

    浏览器发来的每一帧都是 JSON：``input`` 是按键（原样送给远端，控制序列也在
    里面），``resize`` 让远端按新的列宽折行，``ping`` 只用来把会话标记成活跃。
    远端回来的输出走会话队列 —— AI 的镜像也进同一个队列，所以「谁输出的」在
    时间顺序上天然对齐。
    """

    async def browser_to_host() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                message = None
            if not isinstance(message, dict):
                # 容错：非 JSON 的一帧按纯输入处理（手工用 wscat 调试时方便）
                await session.write(raw)
                continue
            kind = str(message.get("type") or "")
            if kind == "input":
                await session.write(str(message.get("data") or ""))
            elif kind == "resize":
                await session.resize(
                    int(message.get("cols") or session.cols),
                    int(message.get("rows") or session.rows),
                )
            elif kind == "ping":
                session.touch()

    async def host_to_browser() -> None:
        while True:
            event = await session.out.get()
            if event is None:
                return
            await websocket.send_text(json.dumps(event, ensure_ascii=False))
            if event.get("type") == aiterm.EXIT_EVENT:
                return

    async def watchdog() -> None:
        """空闲 / 生命周期看门狗。

        浏览器关掉、断网、机器休眠时服务端不会立刻收到 close 帧 —— 没有这道
        兜底，那条 SSH 连接会一直挂着（远端还会留着这个登录会话）。
        """
        while True:
            await asyncio.sleep(30)
            if session.expired():
                session.notice(
                    i18n.pick(
                        "终端空闲过久，已自动断开。刷新页面可重新连接。",
                        "The terminal was idle for too long and has been closed. "
                        "Reload the page to reconnect.",
                    )
                )
                session.finish()
                return

    tasks = [
        asyncio.create_task(browser_to_host()),
        asyncio.create_task(host_to_browser()),
        asyncio.create_task(watchdog()),
    ]
    try:
        # 任一方向结束（远端退出 / 浏览器关页面 / 超时）就整体收尾
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.get("/terminal/preflight")
async def terminal_preflight(
    host_id: str = "",
    user: Dict[str, Any] = Depends(VIEW),
) -> Dict[str, Any]:
    """终端连接前的自检：把「为什么连不上」用**普通 HTTP 请求**问清楚。

    为什么需要它：WebSocket 握手失败时，浏览器的 ``onerror`` / ``onclose``
    里**拿不到任何东西** —— 没有状态码、没有原因。后端拒绝了是它，中间的反向
    代理没转发 ``Upgrade`` 也是它，界面上长得完全一样。

    这个接口把**后端这一侧**的前置条件逐条查一遍（权限 / 主机归属 / SSH 可达），
    返回 ``reason`` 就是第一处不满足的原因。于是：

    * 自检失败 → 原因明确，界面直接显示；
    * 自检通过、WebSocket 仍然连不上 → 后端已经确认没问题，剩下的**只可能**
      是反向代理没转发 WebSocket，界面就能给出那句该改的配置。

    只做只读探测（一个 TCP 连接），不建 SSH 会话、不写任何东西。
    """
    checks: List[Dict[str, Any]] = []

    def add(key: str, ok: bool, detail: str = "") -> None:
        checks.append({"key": key, "ok": ok, "detail": detail})

    if not security.has_user_permission(user, TERMINAL_PERMISSION):
        add("permission", False)
        return {
            "ok": False,
            "reason": i18n.pick(
                "权限不足：需要「远程终端」权限",
                "Permission denied: the “Remote terminal” permission is required",
            ),
            "checks": checks,
        }
    add("permission", True)

    if not host_id:
        add("host", False)
        return {
            "ok": False,
            "reason": i18n.pick(
                "没有选择受管主机（面板本机不支持在此打开终端）",
                "No managed host selected (the panel host itself is not exposed here)",
            ),
            "checks": checks,
        }

    try:
        row = await hostscope.assert_host_access(user, host_id)
    except HTTPException as exc:
        add("host", False, str(exc.detail))
        return {"ok": False, "reason": str(exc.detail), "checks": checks}
    add("host", True, str(row.get("host") or ""))

    address = str(row.get("host") or "")
    port = int(row.get("port") or 22)
    reachable = await _tcp_probe(address, port)
    add(
        "ssh",
        reachable,
        "" if reachable else f"{address}:{port}",
    )
    if not reachable:
        return {
            "ok": False,
            "reason": i18n.pick(
                f"连不上 {address}:{port} —— 面板所在的机器无法访问该地址的 SSH 端口",
                f"Cannot reach {address}:{port} — no SSH connectivity from the panel host",
            ),
            "checks": checks,
        }

    return {"ok": True, "reason": "", "checks": checks}


async def _tcp_probe(address: str, port: int, timeout: float = 3.0) -> bool:
    """探一下 TCP 端口通不通。

    刻意用裸 socket 而不是建 SSH 会话：自检要快要轻，握手 + 认证会慢一个数量级，
    而且真正的连接失败原因（凭据错、指纹不符）由 WebSocket 那条路自己会报。
    这一步只回答「网络能不能到」。
    """
    if not address:
        return False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(address, port), timeout=timeout
        )
    except Exception:  # noqa: BLE001 - 超时 / 拒绝 / DNS 失败都算不可达
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:  # noqa: BLE001
        pass
    del reader
    return True


@router.websocket("/terminal/ws")
async def terminal_ws(
    websocket: WebSocket,
    host_id: str = Query(default=""),
    token: str = Query(default=""),
    cols: int = Query(default=80, ge=1, le=1000),
    rows: int = Query(default=24, ge=1, le=1000),
) -> None:
    """受管主机的交互式终端（页面左侧那个窗口）。

    URL 形如 ``/api/ai/terminal/ws?host_id=<id>&cols=120&rows=30``；浏览器不带
    令牌（在 HttpOnly Cookie 里），脚本仍可 ``?token=``。
    """
    if not security.ws_origin_allowed(websocket):
        await _reject_ws(websocket, 4403, i18n.tr("来源校验失败"))
        return

    try:
        user = await _ws_identity(websocket, token)
    except PermissionError as exc:
        await _reject_ws(websocket, 4401, str(exc))
        return

    # WS 里没有 Request 对象，审计的 IP 从 ASGI scope 取（与 HTTP 侧同一个口径）。
    # 终端是「一条能敲任意命令的通道」，因此**被拒绝的尝试也要留痕** ——
    # 「谁反复试图在一台不属于他的机器上开终端」正是审计该回答的问题。
    wip = security.client_ip_from_scope(websocket.scope)

    if not security.has_user_permission(user, TERMINAL_PERMISSION):
        await store.add_audit(
            username=user["username"],
            action="ai.terminal.open",
            target=host_id,
            result="failed",
            detail="权限不足：需要 ai.terminal",
            ip=wip,
        )
        await _fail_after_auth(
            websocket,
            1008,
            i18n.pick(
                "权限不足：需要「远程终端」权限",
                "Permission denied: the “Remote terminal” permission is required",
            ),
        )
        return
    if not host_id:
        await _fail_after_auth(
            websocket, 1008, i18n.pick("缺少 host_id", "Missing host_id")
        )
        return

    try:
        row = await hostscope.assert_host_access(user, host_id)
    except HTTPException as exc:
        await store.add_audit(
            username=user["username"],
            action="ai.terminal.open",
            target=host_id,
            result="failed",
            detail=str(exc.detail)[:200],
            ip=wip,
        )
        await _fail_after_auth(websocket, 1008, str(exc.detail))
        return

    host_name = str(row.get("name") or row.get("host") or host_id)
    try:
        session = await aiterm.open_session(
            username=user["username"],
            host_id=host_id,
            row=row,
            host_name=host_name,
            cols=cols,
            rows=rows,
        )
    except Exception as exc:  # noqa: BLE001 - 连不上要让用户看到原因，不是静默断开
        logger.warning("AI 终端打开失败：host=%s %s", host_id, exc)
        await store.add_audit(
            username=user["username"],
            action="ai.terminal.open",
            target=host_name,
            result="failed",
            detail=str(exc)[:200],
            ip=wip,
        )
        await _fail_after_auth(websocket, 1011, str(exc)[:200])
        return

    await websocket.accept()
    await store.add_audit(
        username=user["username"],
        action="ai.terminal.open",
        target=host_name,
        result="success",
        detail=f"打开远程终端 {host_name}（{cols}x{rows}）",
        ip=wip,
    )

    try:
        await _terminal_pump(session, websocket)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - 收尾要照做，但异常不能抛给 ASGI
        logger.debug("AI 终端异常收尾", exc_info=True)
    finally:
        aiterm.close_session(session)
        await store.add_audit(
            username=user["username"],
            action="ai.terminal.close",
            target=host_name,
            result="success",
            detail=f"关闭远程终端 {host_name}",
            ip=wip,
        )
