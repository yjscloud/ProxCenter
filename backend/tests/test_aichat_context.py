"""AI 会话的上下文重建：``tool`` 消息必须和 assistant 的 ``tool_calls`` 成对出现。

这是上游（OpenAI 兼容接口）的硬要求，落单任何一个方向都是 400，而线上最典型的
一次来自 DeepSeek：

    Messages with role 'tool' must be a response to a preceding message with
    'tool_calls'

它**只在对话长到触发条数裁剪之后**才出现 —— 剪口落在一个工具响应行上，把它前面
那条带 ``tool_calls`` 的 assistant 一起裁走了，剩下的 ``tool`` 就成了对话的开头。
所以线上的表现是「聊着聊着偶发 400」，不看重建逻辑很难查。

这里把「裁剪 + 重建」的组合钉住：无论窗口怎么滑，喂给模型的消息都必须成对。

不依赖 MySQL：只调 ``aichat`` 里的纯函数。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import aichat  # noqa: E402


def _assistant(msg_id: str, call_ids: List[str]) -> Dict[str, Any]:
    """一条 assistant 消息。``append_message`` 落库时 ``tool_calls`` 存 JSON 串。"""
    return {
        "id": msg_id,
        "role": "assistant",
        "content": "",
        "tool_calls": json.dumps(
            [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "host_run_command", "arguments": "{}"},
                }
                for call_id in call_ids
            ]
        ),
    }


def _tool(msg_id: str, call_id: str, content: str = "out") -> Dict[str, Any]:
    return {"id": msg_id, "role": "tool", "tool_call_id": call_id, "content": content}


def _user(msg_id: str, content: str) -> Dict[str, Any]:
    return {"id": msg_id, "role": "user", "content": content}


def _long_history(turns: int = 8) -> List[Dict[str, Any]]:
    """一段真实形状的长会话：首行证据 + 多轮「问一句、调一次工具、给一句结论」。"""
    rows: List[Dict[str, Any]] = [
        {"id": "ctx", "role": "context", "content": "[数据] 证据快照"},
        _user("u0", "开始排查"),
    ]
    for n in range(1, turns + 1):
        rows.append(_assistant(f"a{n}", [f"c{n}"]))
        rows.append(_tool(f"t{n}", f"c{n}"))
        rows.append({"id": f"p{n}", "role": "assistant", "content": f"第 {n} 步结论"})
    return rows


def _assert_paired(messages: List[Dict[str, Any]]) -> None:
    """每个 tool 都有前置调用；每个调用组都有齐全的响应。违反就是一次 400。"""
    declared: set = set()
    index = 0
    while index < len(messages):
        message = messages[index]
        if message["role"] == "tool":
            assert message.get("tool_call_id") in declared, f"孤儿 tool 消息：{message}"
            index += 1
            continue
        calls = message.get("tool_calls") or []
        if calls:
            ids = [str(call["id"]) for call in calls]
            responses: List[str] = []
            cursor = index + 1
            while cursor < len(messages) and messages[cursor]["role"] == "tool":
                responses.append(str(messages[cursor].get("tool_call_id")))
                cursor += 1
            assert sorted(ids) == sorted(responses), f"响应不全：{ids} vs {responses}"
            declared.update(ids)
            index = cursor
            continue
        index += 1


@pytest.mark.parametrize("keep", [1, 2, 3, 4, 5, 7, 40])
def test_trimmed_context_never_leaves_a_tool_without_its_call(keep: int) -> None:
    """裁剪窗口怎么滑，重建出来的消息都必须成对。"""
    trimmed = aichat._context_rows(_long_history(), keep)
    _assert_paired(aichat.to_model_messages(trimmed))


def test_long_history_keeps_the_evidence_row() -> None:
    """证据行（第一行 context）再裁也不能丢 —— 丢了模型就忘了这台机器体检出过什么。"""
    trimmed = aichat._context_rows(_long_history(), 3)
    assert any(row["role"] == "context" for row in trimmed)


def test_orphan_tool_is_dropped() -> None:
    """剪口落在工具响应行上：它的 assistant 已被裁走，这条 tool 必须丢掉。"""
    rows = [_tool("t1", "c1"), {"id": "a1", "role": "assistant", "content": "结论"}]
    assert [m["role"] for m in aichat.to_model_messages(rows)] == ["assistant"]


def test_assembled_prompt_is_valid_at_any_trim_window() -> None:
    """按 ``_run_turn`` 的顺序组一遍（system + 历史 + 本轮提问），任何窗口都合法。

    这是最贴近线上的一次组装：消息数组的**开头**不能是 tool，否则上游同样报
    「必须以 tool_calls 开头」之类。
    """
    for keep in (1, 3, 6):
        trimmed = aichat._context_rows(_long_history(), keep)
        messages: List[Dict[str, Any]] = [{"role": "system", "content": "系统提示"}]
        messages += aichat.to_model_messages(trimmed)
        messages.append({"role": "user", "content": "接着查"})
        _assert_paired(messages)
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] != "tool"
        assert messages[-1] == {"role": "user", "content": "接着查"}


def test_half_tool_group_is_dropped() -> None:
    """用户「终止」留下的半截组：整组丢弃，连它的 tool 行一起。"""
    rows = [_user("u1", "查一下"), _assistant("a1", ["c1", "c2"]), _tool("t1", "c1")]
    assert [m["role"] for m in aichat.to_model_messages(rows)] == ["user"]


def test_only_the_broken_group_is_dropped() -> None:
    """中途终止过一轮，不该影响它前后的正常轮次。"""
    rows = [
        _user("u1", "第一步"),
        _assistant("a1", ["c1"]),
        _tool("t1", "c1"),
        _user("u2", "第二步"),
        _assistant("a2", ["c2", "c3"]),  # c3 的响应没能落库（用户终止）
        _tool("t2", "c2"),
        _user("u3", "第三步"),
    ]
    assert [m["role"] for m in aichat.to_model_messages(rows)] == [
        "user",
        "assistant",
        "tool",
        "user",
        "user",
    ]


def test_broken_tool_calls_json_drops_its_tool() -> None:
    """``tool_calls`` 落库内容坏掉时，assistant 退化成普通消息，它的 tool 变孤儿。"""
    rows = [
        _user("u1", "查一下"),
        {"id": "a1", "role": "assistant", "content": "", "tool_calls": "{坏掉的 json"},
        _tool("t1", "c1"),
    ]
    assert [m["role"] for m in aichat.to_model_messages(rows)] == ["user", "assistant"]


def test_tool_without_call_id_is_dropped() -> None:
    """空 ``tool_call_id`` 认不出调用方，留着必被上游拒。"""
    rows = [_user("u1", "查一下"), _tool("t1", "")]
    assert [m["role"] for m in aichat.to_model_messages(rows)] == ["user"]


def test_complete_group_is_kept_in_order() -> None:
    """完整的一轮原样回放：顺序、参数与响应都不该被改动。"""
    rows = [
        _user("u1", "查一下"),
        _assistant("a1", ["c1"]),
        _tool("t1", "c1", "ok"),
        {"id": "a2", "role": "assistant", "content": "结论"},
    ]
    messages = aichat.to_model_messages(rows)
    assert [m["role"] for m in messages] == ["user", "assistant", "tool", "assistant"]
    assert messages[1]["tool_calls"][0]["id"] == "c1"
    assert messages[2]["tool_call_id"] == "c1"
    assert messages[2]["content"] == "ok"


def test_context_row_is_replayed_as_user_message() -> None:
    """context 行是当初喂给模型的 ``[数据]`` 段，重建时要映射回 user。"""
    rows = [{"id": "ctx", "role": "context", "content": "[数据] 证据"}]
    assert aichat.to_model_messages(rows) == [{"role": "user", "content": "[数据] 证据"}]
