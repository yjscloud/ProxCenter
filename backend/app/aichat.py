"""AI 会话：把「一次性排查」升级成能追问的对话。

为什么要单独一层
----------------
``ai.py`` 的 L2 是「一条请求跑完一次排查」，跑完即散、没有记忆。用户真正想要的
是看完结论后还能追问「那这个进程是谁起的」—— 那就需要一个**线程**把上下文留住。

线程落库而不是只留在前端：刷新页面、换设备、事后审计，都要能看到完整对话。

数据分两层
----------
* ``ai_conversations`` —— 一次会话（谁、哪台机器、产出的报告）；
* ``ai_messages``     —— 会话里每一条消息（user / assistant / tool / context）。

``ai_messages`` 与 OpenAI 的消息数组**同构**：``context`` 行的内容就是当初喂给
模型的 ``[数据]`` 段（重建上下文时映射成 user），``assistant`` 行的 ``tool_calls``
存原始 JSON。于是「把整段对话交给模型」退化成一个直接映射，不用再拼装。

首轮 = 体检并产出报告
---------------------
会话的第一轮承担原来的「排查」职责：采集证据、要求模型输出 findings JSON，
结果存进 ``ai_conversations.report``；之后的轮次是自由追问，不再重采集、不再
强制 JSON。这样「报告」与「对话」就是两个产物，各归各的入口。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional

from . import ai, aiplaybooks, aitools, database, hostscope, i18n

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_conversations (
    id        VARCHAR(40)  NOT NULL,
    username  VARCHAR(64)  NOT NULL DEFAULT '',
    host_id   VARCHAR(191) NOT NULL DEFAULT '',
    host_name VARCHAR(191) NOT NULL DEFAULT '',
    provider  VARCHAR(191) NOT NULL DEFAULT '',
    title     VARCHAR(191) NOT NULL DEFAULT '',
    report    MEDIUMTEXT,
    allow_exec TINYINT     NOT NULL DEFAULT 0,
    ctx_summary    MEDIUMTEXT,
    summarized_upto INT    NOT NULL DEFAULT 0,
    created   BIGINT       NOT NULL DEFAULT 0,
    updated   BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ai_conv_user (username, updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_messages (
    id              VARCHAR(40)  NOT NULL,
    conversation_id VARCHAR(40)  NOT NULL DEFAULT '',
    seq             INT          NOT NULL DEFAULT 0,
    role            VARCHAR(16)  NOT NULL DEFAULT 'user',
    content         MEDIUMTEXT,
    tool_calls      MEDIUMTEXT,
    tool_call_id    VARCHAR(64)  NOT NULL DEFAULT '',
    tool_name       VARCHAR(64)  NOT NULL DEFAULT '',
    command         VARCHAR(1024) NOT NULL DEFAULT '',
    ok              TINYINT      DEFAULT NULL,
    created         BIGINT       NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ai_msg_conv (conversation_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# 追问轮次比体检轮少：追问通常一两轮就能答完，多给只是让模型来回查、白烧 token。
MAX_STEPS_CHAT = 4

# 重建上下文时最多带多少条消息。历史无上限增长迟早会把 prompt 撑爆，从**最近**
# 往回取；``context``（巡检证据）单独保留，见 :func:`_context_rows`。
MAX_CONTEXT_MESSAGES = 40

# 被裁掉的旧消息累计到这个数，才值得花一次模型调用去摘要 —— 一两条不值得。
SUMMARY_MIN_MESSAGES = 8
# 送进摘要的原文字符上限，防止一次塞太多。
SUMMARY_MAX_CHARS = 4000

# 同一会话的并发闸门：一次只允许一轮在跑。
#
# 两个标签页同时发消息会让 seq 交错、上下文错乱；而且后端在同一会话上并发跑
# 两轮，模型额度也会翻倍。锁在进程内、按 conversation_id 分开，彼此不干扰。
_locks: Dict[str, asyncio.Lock] = {}


def _conversation_lock(conversation_id: str) -> asyncio.Lock:
    """取（必要时创建）某条会话的锁。锁随会话懒建，只在该会话第一次跑时创建。"""
    lock = _locks.get(conversation_id)
    if lock is None:
        # 简单防泄漏：历史会话很多时，把已经没人持有的锁清掉再建
        if len(_locks) > 500:
            for key in [k for k, v in _locks.items() if not v.locked()]:
                _locks.pop(key, None)
        lock = _locks[conversation_id] = asyncio.Lock()
    return lock


def _context_rows(
    rows: List[Dict[str, Any]], keep_recent: int = MAX_CONTEXT_MESSAGES
) -> List[Dict[str, Any]]:
    """挑出重建上下文要用的消息。

    不能简单地 ``rows[-N:]``：巡检证据是**第一行** ``context``，长对话里它会被
    切掉 —— 模型于是彻底忘了这台机器体检出过什么，后面的追问全靠猜。所以证据行
    永远保留，再拼上最近的 N 条；中间的旧轮次让位。
    """
    if len(rows) <= keep_recent:
        return rows
    head = [row for row in rows if str(row.get("role") or "") == "context"]
    tail = rows[-keep_recent:] if keep_recent > 0 else []
    picked: List[Dict[str, Any]] = []
    seen: set = set()
    for row in head + tail:
        key = str(row.get("id") or "")
        if key in seen:
            continue
        seen.add(key)
        picked.append(row)
    return picked


async def init_table() -> None:
    async with database.connect() as db:
        await db.executescript(SCHEMA)
        columns = await database.table_columns(db, "ai_conversations")
        if "report" not in columns:
            await db.execute("ALTER TABLE ai_conversations ADD COLUMN report MEDIUMTEXT")
        # 会话级的「允许上机执行」授权：记在会话上，刷新页面后开关能回到用户
        # 上次的选择，而不是悄悄退回关闭、下一句追问就少了上机能力。
        if "allow_exec" not in columns:
            await db.execute(
                "ALTER TABLE ai_conversations ADD COLUMN allow_exec TINYINT"
                " NOT NULL DEFAULT 0"
            )
        # 历史压缩：被裁掉的旧轮次压成要点摘要存这里；summarized_upto 记到哪一条为止
        if "ctx_summary" not in columns:
            await db.execute("ALTER TABLE ai_conversations ADD COLUMN ctx_summary MEDIUMTEXT")
        if "summarized_upto" not in columns:
            await db.execute(
                "ALTER TABLE ai_conversations ADD COLUMN summarized_upto INT"
                " NOT NULL DEFAULT 0"
            )
        # 工具行补列：这条工具调用**实际在主机上跑的命令**。参数（unit=sshd）
        # 不等于命令（journalctl -u sshd -n 60），回看历史时必须能看到后者 ——
        # 「AI 到底在我机器上敲了什么」是用户最想核对的一件事。
        msg_columns = await database.table_columns(db, "ai_messages")
        if "command" not in msg_columns:
            await db.execute(
                "ALTER TABLE ai_messages ADD COLUMN command VARCHAR(1024)"
                " NOT NULL DEFAULT ''"
            )
        await db.commit()


def new_id() -> str:
    return uuid.uuid4().hex


# ------------------------------------------------------------------ 会话读写
async def create_conversation(
    *,
    username: str,
    host_id: str,
    host_name: str,
    provider: str = "",
    title: str = "",
    allow_exec: bool = False,
) -> Dict[str, Any]:
    now = int(time.time())
    conv: Dict[str, Any] = {
        "id": new_id(),
        "username": str(username or ""),
        "host_id": str(host_id or ""),
        "host_name": str(host_name or "")[:191],
        "provider": str(provider or "")[:191],
        "title": str(title or "")[:191],
        "report": None,
        "allow_exec": 1 if allow_exec else 0,
        "created": now,
        "updated": now,
    }
    try:
        async with database.connect() as db:
            await db.execute(
                "INSERT INTO ai_conversations (id, username, host_id, host_name, provider,"
                " title, allow_exec, created, updated) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    conv["id"],
                    conv["username"],
                    conv["host_id"],
                    conv["host_name"],
                    conv["provider"],
                    conv["title"],
                    conv["allow_exec"],
                    conv["created"],
                    conv["updated"],
                ),
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 落库失败不该让「发起排查」直接挂掉
        logger.warning("AI 会话创建失败", exc_info=True)
    return conv


async def set_allow_exec(conversation_id: str, enabled: bool) -> None:
    """记住这条会话最新一次的「允许上机执行」选择（真和假都写）。

    只在真的时候写、假的时候不写是不行的：用户手动关掉开关后刷新，开关会自己
    弹回打开 —— 那是往「更放权」的方向漂，不能接受。
    """
    try:
        async with database.connect() as db:
            await db.execute(
                "UPDATE ai_conversations SET allow_exec=? WHERE id=?",
                (1 if enabled else 0, str(conversation_id)),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("AI 会话授权状态写入失败", exc_info=True)


async def set_context_summary(conversation_id: str, summary: str, upto_seq: int) -> None:
    """保存历史摘要，并记下「已经压到第几条」（避免下次重复压缩同一段）。"""
    try:
        async with database.connect() as db:
            await db.execute(
                "UPDATE ai_conversations SET ctx_summary=?, summarized_upto=? WHERE id=?",
                (str(summary or "")[:20000], int(upto_seq or 0), str(conversation_id)),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("AI 会话摘要写入失败", exc_info=True)


async def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT * FROM ai_conversations WHERE id=?", (str(conversation_id),)
            )
            row = await cursor.fetchone()
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 会话失败", exc_info=True)
        return None
    return dict(row) if row else None


async def list_conversations(
    *, username: str = "", host_id: str = "", limit: int = 20, offset: int = 0
) -> Dict[str, Any]:
    """会话列表，返回 ``{total, items}``。

    不含 ``report`` 大字段 —— 列表页用不上，白读一遍徒增传输；附上每条会话的
    运行次数，便于一眼看出「这条会话查得深不深」。
    """
    where: List[str] = []
    params: List[Any] = []
    if username:
        where.append("c.username=?")
        params.append(str(username))
    if host_id:
        where.append("c.host_id=?")
        params.append(str(host_id))
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    size = max(1, min(100, int(limit or 20)))
    start = max(0, int(offset or 0))
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT COUNT(*) AS n FROM ai_conversations c" + clause, tuple(params)
            )
            row = await cursor.fetchone()
            total = int((dict(row).get("n") if row else 0) or 0)

            cursor = await db.execute(
                "SELECT c.id, c.username, c.host_id, c.host_name, c.provider, c.title,"
                " c.allow_exec, c.created, c.updated,"
                " (SELECT COUNT(*) FROM ai_sessions s WHERE s.conversation_id=c.id) AS runs"
                " FROM ai_conversations c"
                + clause
                + " ORDER BY c.updated DESC LIMIT ? OFFSET ?",
                tuple(params + [size, start]),
            )
            items = [dict(item) for item in await cursor.fetchall()]
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 会话列表失败", exc_info=True)
        return {"total": 0, "items": []}
    # host_name 是建会话时的快照（库里那份保留不动），列表里换成**当前**名字：
    # 受管主机改过名之后，这里还显示旧名就认不出是哪台机器了。
    hostscope.apply_display_names(items, await hostscope.current_display_names())
    return {"total": total, "items": items}


async def set_report(conversation_id: str, report: Any) -> None:
    payload: Optional[str] = None
    if report is not None:
        try:
            payload = json.dumps(report, ensure_ascii=False)
        except (TypeError, ValueError):
            payload = None
    try:
        async with database.connect() as db:
            await db.execute(
                "UPDATE ai_conversations SET report=?, updated=? WHERE id=?",
                (payload, int(time.time()), str(conversation_id)),
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("AI 会话报告写入失败", exc_info=True)


async def append_message(
    conversation_id: str,
    *,
    role: str,
    content: str = "",
    tool_calls: Any = None,
    tool_call_id: str = "",
    tool_name: str = "",
    command: str = "",
    ok: Optional[bool] = None,
) -> Dict[str, Any]:
    """追加一条消息。seq 在会话内单调递增，保证回放顺序稳定。

    ``command`` 只对工具行有意义：这条调用实际在主机上执行的那条命令。内部工具
    （读体检报告、指标、变更记录）不走命令行，留空。
    """
    now = int(time.time())
    tool_calls_json: Optional[str] = None
    if tool_calls:
        try:
            tool_calls_json = json.dumps(tool_calls, ensure_ascii=False)
        except (TypeError, ValueError):
            tool_calls_json = None
    msg: Dict[str, Any] = {
        "id": new_id(),
        "conversation_id": str(conversation_id),
        "seq": 0,
        "role": str(role or "user"),
        "content": str(content or ""),
        "tool_calls": tool_calls_json,
        "tool_call_id": str(tool_call_id or ""),
        "tool_name": str(tool_name or "")[:64],
        "command": str(command or "")[:1024],
        # 非工具消息没有成败可言，落 NULL 而不是 0 —— 「失败」和「不适用」必须能区分
        "ok": None if ok is None else (1 if ok else 0),
        "created": now,
    }
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ai_messages WHERE conversation_id=?",
                (msg["conversation_id"],),
            )
            row = await cursor.fetchone()
            msg["seq"] = int((dict(row).get("n") if row else 1) or 1)
            await db.execute(
                "INSERT INTO ai_messages (id, conversation_id, seq, role, content,"
                " tool_calls, tool_call_id, tool_name, command, ok, created)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    msg["id"],
                    msg["conversation_id"],
                    msg["seq"],
                    msg["role"],
                    msg["content"],
                    msg["tool_calls"],
                    msg["tool_call_id"],
                    msg["tool_name"],
                    msg["command"],
                    msg["ok"],
                    msg["created"],
                ),
            )
            await db.execute(
                "UPDATE ai_conversations SET updated=? WHERE id=?",
                (now, msg["conversation_id"]),
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 单条消息写失败不该中断整轮对话
        logger.warning("AI 会话消息写入失败", exc_info=True)
    return msg


async def list_messages(conversation_id: str) -> List[Dict[str, Any]]:
    """按 seq 顺序取回一条会话的全部消息（渲染与上下文重建共用）。"""
    try:
        async with database.connect() as db:
            cursor = await db.execute(
                "SELECT * FROM ai_messages WHERE conversation_id=?"
                " ORDER BY seq ASC, created ASC",
                (str(conversation_id),),
            )
            return [dict(item) for item in await cursor.fetchall()]
    except Exception:  # noqa: BLE001
        logger.warning("读取 AI 会话消息失败", exc_info=True)
        return []


def owns(conversation: Dict[str, Any], username: str, is_admin: bool) -> bool:
    """会话归属判定。非本人（且非管理员）一律按「不存在」处理，不泄露存在性。"""
    if is_admin:
        return True
    return str(conversation.get("username") or "") == str(username or "")


# ------------------------------------------------------------- 上下文重建
def _sanitize_model_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """保证 tool 消息与带 ``tool_calls`` 的 assistant 消息**成对**出现。

    上游对这件事严格到缺一不可，而两个方向都会落单、都会 400：

    * **调用组缺响应**：assistant 带 ``tool_calls``，但它对应的 tool 响应不齐。
      用户中途「终止」时会留下这种半截组（见 :func:`append_message` 的落库时机），
      回放时上游报「tool_calls 后面必须跟 tool 响应」。
    * **没有调用方的孤儿 tool 消息**：``tool`` 找不到它的 assistant。重建上下文时
      消息是按**条数**裁剪的（见 :func:`_context_rows` 的 ``keep_recent``），剪口完全
      可能落在工具响应行上 —— 前一行被裁掉，这条 ``tool`` 就成了对话的开头。上游
      报「Messages with role 'tool' must be a response to a preceding message with
      'tool_calls'」。它只在**对话长到触发裁剪之后**才出现，所以表现为「聊着聊着
      偶发 400」，最难查。

    两条合成一句：**一条消息只有在它的配对方也被保留时才保留**。宁可少一轮上下文，
    也不能让用户的下一句话直接报错。
    """
    out: List[Dict[str, Any]] = []
    # 已经保留下来的 assistant 声明的 tool_call id；后面的 tool 只有落在其中才留。
    # 用集合而不是「往回看一条」：完整组内的响应是就地 append 的，但如果同一轮里
    # 出现了空 id 或对不上的 id，只有这个集合能把它们认出来。
    kept_calls: set = set()
    i = 0
    total = len(messages)
    while i < total:
        msg = messages[i]
        role = str(msg.get("role") or "")

        if role == "tool":
            call_id = str(msg.get("tool_call_id") or "")
            # 空 id 或对不上任何已保留的调用 → 孤儿，留着就是一次 400
            if call_id and call_id in kept_calls:
                out.append(msg)
            i += 1
            continue

        calls = msg.get("tool_calls") if role == "assistant" else None
        if calls:
            ids = [str(c.get("id") or "") for c in calls]
            responses: Dict[str, Dict[str, Any]] = {}
            j = i + 1
            while j < total and str(messages[j].get("role") or "") == "tool":
                responses[str(messages[j].get("tool_call_id") or "")] = messages[j]
                j += 1
            if ids and all(cid in responses for cid in ids):
                out.append(msg)
                for cid in ids:
                    out.append(responses[cid])
                kept_calls.update(ids)
            i = j  # 缺响应：整组跳过（含它的 tool 行）
            continue

        out.append(msg)
        i += 1
    return out


def to_model_messages(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把落库的消息还原成 OpenAI 的消息数组。

    ``context`` 是当初喂给模型的 ``[数据]`` 段，映射回 ``user``；``assistant``
    带 ``tool_calls`` 的原样还原；``tool`` 找回它的 ``tool_call_id``。最后统一过一遍
    :func:`_sanitize_model_messages`，挡掉半截的工具调用组。
    """
    out: List[Dict[str, Any]] = []
    for row in rows:
        role = str(row.get("role") or "")
        content = str(row.get("content") or "")
        if role in ("user", "context"):
            out.append({"role": "user", "content": content})
        elif role == "assistant":
            msg: Dict[str, Any] = {"role": "assistant", "content": content}
            raw = row.get("tool_calls")
            if raw:
                try:
                    calls = json.loads(raw)
                except (TypeError, ValueError):
                    calls = None
                if isinstance(calls, list) and calls:
                    msg["tool_calls"] = calls
            out.append(msg)
        elif role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": str(row.get("tool_call_id") or ""),
                    "content": content,
                }
            )
    return _sanitize_model_messages(out)


async def _summarize_history(
    prev_summary: str,
    rows: List[Dict[str, Any]],
    *,
    cfg: Dict[str, Any],
    provider: Dict[str, Any],
) -> str:
    """把被裁掉的旧轮次压成要点摘要（一次额外的模型调用）。

    与「直接把旧消息丢掉」相比，多花一次便宜调用换来的是：几十轮之后模型仍然
    记得「用户一路在追查 nginx 502、已经确认是后端超时」。失败就返回空串，
    调用方退化为结构化裁剪 —— 压缩是优化，不该成为对话的失败点。
    """
    lines: List[str] = []
    for row in rows:
        role = str(row.get("role") or "")
        content = str(row.get("content") or "").strip()
        if not content:
            continue
        if role == "tool":
            label = "[工具 " + str(row.get("tool_name") or "") + "]"
        elif role == "assistant":
            label = "[助手]"
        else:
            label = "[用户]"
        lines.append(label + " " + content)
    body = "\n".join(lines)[:SUMMARY_MAX_CHARS]
    if not body.strip():
        return ""

    system = i18n.pick(
        "你负责把一段运维排查对话压缩成要点摘要，供后续追问时回忆上下文。\n"
        "必须保留：用户关心的问题、已经确认的结论、做过的关键操作及其结果、尚未解决的问题。\n"
        "不要编造、不要展开细节，用简洁的中文分条列出。",
        "Compress an ops troubleshooting conversation into a short bullet summary so "
        "later turns can recall the context.\n"
        "Keep: what the user cares about, confirmed conclusions, key actions and their "
        "results, and open questions.\n"
        "Do not invent anything or go into detail; use concise English bullets.",
    )
    parts: List[str] = []
    if prev_summary.strip():
        parts.append(
            i18n.pick("已有摘要：\n", "Existing summary:\n") + prev_summary.strip()
        )
    parts.append(i18n.pick("新增对话：\n", "New turns:\n") + body)
    try:
        reply = await ai.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": "\n\n".join(parts)},
            ],
            cfg=cfg,
            provider=provider,
            json_mode=False,
            # 摘要是副产品，别让它把预算吃掉：给个够用的上限即可
            max_tokens=min(800, int(cfg.get("max_tokens") or 800)),
        )
    except ai.AIError:
        logger.warning("会话摘要失败，退化为结构化裁剪", exc_info=True)
        return ""
    return str(reply.get("content") or "").strip()[:20000]


def _report_to_text(report: Dict[str, Any]) -> str:
    """把 findings 报告压成一句给对话流看的话（完整结论在下方报告卡里）。"""
    summary = str(report.get("summary") or "").strip()
    if summary:
        return summary
    findings = report.get("findings") or []
    if findings:
        return i18n.pick(
            f"排查完成：共 {len(findings)} 条待处理事项，详见下方报告。",
            f"Inspection finished: {len(findings)} item(s) to address — see the report below.",
        )
    return i18n.pick(
        "排查完成，未发现需要立即处理的问题。",
        "Inspection finished — nothing urgent found.",
    )


# ------------------------------------------------------------------ 跑一轮
# 一轮的两种形态。这是这里最关键的一条分界：
#
# * ``chat``    —— **默认**。自由对话，不预采集证据、不强制 JSON。模型需要什么
#   自己调工具去查（平台那批「结论类」内部工具就是为它准备的）。首轮开销只有
#   一次模型调用，用户「不点排查直接问」也能得到直接回答。
# * ``inspect`` —— 体检模板。按固定流程采集证据 + 强制输出 findings 报告。
#   它是个**可选动作**（按钮 / 定时任务），而不是进入对话的必经之路。
MODE_CHAT = "chat"
MODE_INSPECT = "inspect"


def normalise_mode(value: Any) -> str:
    """把外部传入的 mode 归一成 ``chat`` / ``inspect``（未知值一律当自由对话）。"""
    return MODE_INSPECT if str(value or "").strip().lower() == MODE_INSPECT else MODE_CHAT


async def chat_turn(
    conversation_id: str,
    user_text: str = "",
    *,
    mode: str = MODE_CHAT,
    preset: str = "",
    emit: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    allowed: Optional[Iterable[str]] = None,
    provider_id: Optional[str] = None,
    username: str = "",
    is_admin: bool = False,
    allow_exec: bool = False,
    perms: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """在一条会话里跑一轮（带并发闸门）。

    ``mode`` 决定这一轮是自由对话还是体检模板（见模块里的 MODE_* 说明）；
    ``preset`` 是预案 key（见 :mod:`app.aiplaybooks`），给了就用预案的指令代替
    用户输入。

    同一条会话同一时刻只跑一轮：两个标签页同时发消息会让 seq 交错、上下文错乱，
    模型额度也会翻倍。已经在跑时直接报错让用户稍候，而不是排队 —— 排队意味着他
    按下发送后界面上什么都没有，比一句「正在处理」更让人困惑。
    """
    lock = _conversation_lock(conversation_id)
    if lock.locked():
        raise ai.AIError(i18n.tr("这条会话正在处理上一条消息，请稍候再发"))
    async with lock:
        return await _run_turn(
            conversation_id,
            user_text,
            mode=mode,
            preset=preset,
            emit=emit,
            allowed=allowed,
            provider_id=provider_id,
            username=username,
            is_admin=is_admin,
            allow_exec=allow_exec,
            perms=perms,
        )


async def _run_turn(
    conversation_id: str,
    user_text: str = "",
    *,
    mode: str = MODE_CHAT,
    preset: str = "",
    emit: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    allowed: Optional[Iterable[str]] = None,
    provider_id: Optional[str] = None,
    username: str = "",
    is_admin: bool = False,
    allow_exec: bool = False,
    perms: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """真正跑一轮：自由对话，或按体检模板产出报告。"""
    mode = normalise_mode(mode)
    playbook = aiplaybooks.get_playbook(preset)
    if playbook:
        # 预案可以指定形态（默认 chat）
        mode = normalise_mode(playbook.get("mode") or mode)
    # 两者要分开：**发给模型的**是完整指令，**落库/展示的**是短标题 ——
    # 聊天记录里出现几十行操作说明既难读，也会污染后续上下文重建。
    if playbook:
        display_text = str(playbook.get("title") or "").strip()
        model_text = str(playbook.get("prompt") or display_text).strip()
    else:
        display_text = str(user_text or "").strip()
        model_text = display_text

    # 带上 username：分析窗口与单次 token 上限可以是这个人自己设的值
    # （见 ai.USER_SETTING_KEYS），不是非得跟平台默认走
    cfg = await ai.load_config(username)
    if not cfg.get("enabled"):
        raise ai.AIError(i18n.tr("AI 排查助手未启用，请先在设置里配置并启用大模型"))

    conv = await get_conversation(conversation_id)
    if not conv or not owns(conv, username, is_admin):
        raise ai.AIError(i18n.tr("找不到这条会话"))

    # 记住这次的授权选择：刷新页面后开关回到用户上次的设置
    await set_allow_exec(conversation_id, bool(allow_exec))

    provider = ai.pick_provider(
        cfg,
        provider_id or str(conv.get("provider") or ""),
        username=username,
        is_admin=is_admin,
    )
    if provider is None:
        raise ai.AIError(i18n.tr("还没有可用的模型，请先在设置里添加并启用一个"))

    host_id = str(conv.get("host_id") or "local")
    host = await ai.resolve_host(host_id, allowed)
    hours = int(cfg.get("hours") or 24)
    started = time.time()
    notify = ai._make_notify(emit)
    approve = ai._make_approver(notify)
    local, row = await ai._resolve_target(host_id)

    history = await list_messages(conversation_id)

    if mode == MODE_INSPECT:
        # 体检模板：固定流程 —— 采集证据 → 强制 findings JSON → 报告落库。
        # 它可以是会话的第一轮，也可以中途再来一次（「重新体检」）。
        await notify({"type": "stage", "stage": "collect"})
        evidence = await ai.collect_evidence(
            host_id, hours=hours, username=username, is_admin=is_admin, perms=perms
        )
        context_content = ai.evidence_user_content(host, evidence)
        # context 行落库：它是「这台机器当时的证据快照」，回看与上下文重建都要它
        await append_message(conversation_id, role="context", content=context_content)
        # 只带对话内容、丢掉**旧的**证据块：重新体检要用最新那份证据，否则每体检
        # 一次就往上下文里再堆一份完整证据，token 白白翻倍。
        prior = [
            row
            for row in _context_rows(history, MAX_CONTEXT_MESSAGES)
            if str(row.get("role") or "") != "context"
        ]
        model_messages: List[Dict[str, Any]] = [
            # 体检轮也要按授权切换「能做什么」那一段：重新体检时同样可能开着授权
            {"role": "system", "content": ai.report_system_prompt(allow_exec=allow_exec)},
        ]
        model_messages += to_model_messages(prior)
        model_messages.append({"role": "user", "content": context_content})
        if display_text:
            await append_message(conversation_id, role="user", content=display_text)
            model_messages.append({"role": "user", "content": model_text})
        finalize_json = True
        max_steps = ai.MAX_STEPS
    else:
        # 自由对话：**不预采集证据**。模型需要什么自己调工具去查 —— 平台那批
        # 「结论类」内部工具（体检报告 / 登录失败 / 告警 / 指标 / 变更 / 关联资源）
        # 正是为这条路径准备的，首轮开销只有一次模型调用。
        if not display_text:
            raise ai.AIError(i18n.tr("消息不能为空"))
        # 先重建历史、再落库这条新消息 —— 反过来会把用户这句话塞进上下文两次。
        # 历史超长时 _context_rows 保留证据、裁掉中间旧轮次；被裁掉的那部分
        # 交给模型压成摘要，别让几十轮之后 AI 忘了用户到底在查什么。
        trimmed = _context_rows(history, MAX_CONTEXT_MESSAGES)
        kept_ids = {str(row.get("id") or "") for row in trimmed}
        dropped = [row for row in history if str(row.get("id") or "") not in kept_ids]

        summary = str(conv.get("ctx_summary") or "")
        covered = int(conv.get("summarized_upto") or 0)
        fresh = [row for row in dropped if int(row.get("seq") or 0) > covered]
        if len(fresh) >= SUMMARY_MIN_MESSAGES:
            merged = await _summarize_history(
                summary, fresh, cfg=cfg, provider=provider
            )
            if merged:
                summary = merged
                covered = max(int(row.get("seq") or 0) for row in fresh)
                await set_context_summary(conversation_id, summary, covered)

        # 长度分档：预案（playbook）自己跑了一整套排查，用户点它就是要一份交代
        # 清楚的报告，压到自由对话那档会把「已排除什么、还剩什么不确定」全砍掉；
        # 其余按最严的那档。两档的字数上限可以由用户自己调（见 ai.USER_SETTING_KEYS），
        # cfg 已经合并过他自己设的值，这里只管把档位和字数传下去。
        system_prompt = ai.chat_system_prompt(
            MAX_STEPS_CHAT,
            length=ai.reply_length_style(
                playbook=bool(playbook),
                terse_chars=int(
                    cfg.get("reply_chars_terse") or ai.DEFAULT_REPLY_CHARS_TERSE
                ),
                deep_chars=int(
                    cfg.get("reply_chars_deep") or ai.DEFAULT_REPLY_CHARS_DEEP
                ),
            ),
            # 「能做什么」那一段按授权切换（见 ai.scope_for）：不传就等于告诉模型
            # 「你只能读」，而工具表里明明摆着提议写命令的那把 —— 它会不敢用。
            allow_exec=allow_exec,
        )
        if summary.strip():
            system_prompt += i18n.pick(
                "\n（更早对话的摘要：\n" + summary.strip() + "\n）",
                "\n(Summary of earlier turns:\n" + summary.strip() + "\n)",
            )
        if any(int(row.get("seq") or 0) > covered for row in dropped):
            # 还没攒够值得摘要的量：如实说明有省略，别把「没提过」当成「没发生过」
            system_prompt += i18n.pick(
                "\n（注意：部分较早的对话已被省略，只保留了摘要与最近的往来。）",
                "\n(Note: some earlier turns were omitted; only the summary and the "
                "most recent messages are included.)",
            )

        model_messages = [{"role": "system", "content": system_prompt}]
        model_messages += to_model_messages(trimmed)
        model_messages.append({"role": "user", "content": model_text})
        await append_message(conversation_id, role="user", content=display_text)
        finalize_json = False
        max_steps = MAX_STEPS_CHAT

    async def _persist(msg: Dict[str, Any]) -> None:
        """把循环里的协议消息落库（用户中途终止也能留下已发生的部分）。"""
        await append_message(
            conversation_id,
            role=str(msg.get("role") or "assistant"),
            content=str(msg.get("content") or ""),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=str(msg.get("tool_call_id") or ""),
            tool_name=str(msg.get("tool_name") or ""),
            command=str(msg.get("command") or ""),
            ok=msg.get("ok") if msg.get("role") == "tool" else None,
        )

    specs = aitools.openai_tools(include_exec=allow_exec)
    loop = await ai.run_tool_loop(
        model_messages,
        cfg=cfg,
        provider=provider,
        specs=specs,
        host_id=host_id,
        row=row,
        local=local,
        username=username,
        is_admin=is_admin,
        notify=notify,
        approve=approve,
        started=started,
        max_steps=max_steps,
        finalize_json_mode=finalize_json,
        # 只有追问轮（自然语言）才做打字机流式；体检轮要的是整段 JSON，
        # 流出去是一屏半截的括号。
        stream_tokens=not finalize_json,
        perms=perms,
        on_message=_persist,
    )

    content = str(loop.get("content") or "").strip()
    report: Optional[Dict[str, Any]] = None
    if finalize_json:
        try:
            report = ai.parse_reply(content)
            assistant_text = _report_to_text(report)
        except ai.AIError:
            # 模型没按 JSON 来也不该整轮失败：降级成一段普通回复
            assistant_text = content or i18n.pick("排查完成。", "Inspection finished.")
        if report is not None:
            # 解析失败时**保留上一份报告**而不是清空 —— 一次没吐 JSON，
            # 不该把用户手里那份能看的结论抹掉
            await set_report(conversation_id, report)
    else:
        assistant_text = content or i18n.pick(
            "抱歉，这一轮我没有生成有效回复，请再问一次。",
            "Sorry, I produced no answer this round — please ask again.",
        )

    message = await append_message(
        conversation_id, role="assistant", content=assistant_text
    )
    await notify(
        {"type": "assistant", "message_id": message["id"], "content": assistant_text}
    )
    if report is not None:
        await notify({"type": "report", "report": report})
    # 不在这里发 done：结束事件由路由层统一发（它还要补上 session_id），
    # 两边都发就会出现两个 done，前端会重复处理。

    return {
        "conversation_id": conversation_id,
        "mode": mode,
        "message": message,
        "report": report,
        "usage": loop.get("usage") or {},
        "steps": loop.get("steps") or 0,
        "tool_calls": loop.get("calls") or [],
        "model": (loop.get("reply") or {}).get("model") or provider.get("model"),
        "provider": provider.get("name") or provider.get("id"),
        "host_name": host.get("name") or host_id,
        "timing": {"total_ms": int((time.time() - started) * 1000)},
    }
