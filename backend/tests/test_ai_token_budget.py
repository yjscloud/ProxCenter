"""token 预算刹车：上游不返回 ``usage`` 时也要能踩下去。

``usage`` 在 OpenAI 兼容接口里不是必填 —— 流式尤其如此（要带
``stream_options.include_usage``，不少自建 / 兼容实现不支持、会被退掉）。
只认真值的话，``token_budget`` 这道刹车永远判不出「到顶」，模型可以一轮接一轮
地查下去，直到步数或总超时才停，而那时额度早烧穿了。

这里覆盖两件事：估算函数本身的口径，以及**拿不到 usage 时循环确实会被截住**。

记账口径提醒：``run_tool_loop`` 在跳出循环后还会再调一次模型收口（
``_step_limit_nudge``），所以模型调用次数 = 工具轮数 + 1。

不依赖 MySQL：模型与工具派发全部打桩。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import ai  # noqa: E402


class TestEstimateTokens:
    def test_empty_is_zero(self) -> None:
        assert ai._estimate_tokens("") == 0
        assert ai._estimate_tokens(None) == 0

    def test_ascii_is_about_four_chars_per_token(self) -> None:
        assert ai._estimate_tokens("a" * 400) == 100
        # 向上取整：宁可多估一点
        assert ai._estimate_tokens("ab") == 1

    def test_cjk_is_about_one_char_per_token(self) -> None:
        assert ai._estimate_tokens("中文字符") == 4

    def test_mixed_counts_both(self) -> None:
        # 2 个 CJK（2）+ 2 个 ASCII（1）
        assert ai._estimate_tokens("ab中文") == 3

    def test_messages_include_tool_schema_and_arguments(self) -> None:
        messages: List[Dict[str, Any]] = [{"role": "user", "content": "a" * 400}]
        base = ai._estimate_messages_tokens(messages)
        assert base == 100
        # 工具 schema 每轮都要随请求发出去，漏掉它会让估算系统性偏低
        assert ai._estimate_messages_tokens(messages, [{"name": "x" * 400}]) > base
        # tool_calls 的 arguments 也是模型生成的文本，一样要算
        called = ai._estimate_messages_tokens(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "c1", "function": {"name": "f", "arguments": "x" * 400}}
                    ],
                }
            ]
        )
        assert called > 100


class TestBudgetBrake:
    @staticmethod
    def _fake_chat(counter: Dict[str, int], *, with_usage: bool):
        async def fake_chat(messages, **kwargs):
            counter["calls"] += 1
            n = counter["calls"]
            return {
                "content": "",
                "tool_calls": [
                    {
                        "id": f"c{n}",
                        "type": "function",
                        "function": {
                            "name": "host_ping",
                            # 每次参数都不同，免得被判成重复调用而走捷径
                            "arguments": '{"address": "10.0.0.%d"}' % n,
                        },
                    }
                ],
                "usage": {"total_tokens": 10} if with_usage else {},
                "model": "stub",
            }

        return fake_chat

    def _run_loop(self, monkeypatch, *, with_usage: bool, budget: int) -> Dict[str, Any]:
        counter = {"calls": 0}

        async def fake_dispatch(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            return {"ok": True, "output": "x" * 800, "command": "ping -c 4 10.0.0.1"}

        monkeypatch.setattr(ai, "chat", self._fake_chat(counter, with_usage=with_usage))
        monkeypatch.setattr(ai, "_dispatch_tool", fake_dispatch)

        result = asyncio.run(
            ai.run_tool_loop(
                [
                    {"role": "system", "content": "你是运维工程师"},
                    {"role": "user", "content": "a" * 400},
                ],
                cfg={"token_budget": budget, "max_tokens": 100, "timeout": 5},
                provider={"model": "stub", "base_url": "http://stub.local"},
                specs=[
                    {
                        "type": "function",
                        "function": {"name": "host_ping", "description": "ping"},
                    }
                ],
                host_id="local",
                row=None,
                local=True,
                max_steps=10,
                finalize_json_mode=False,
            )
        )
        result["_chat_calls"] = counter["calls"]
        return result

    def test_estimated_budget_stops_the_loop_without_usage(self, monkeypatch) -> None:
        """上游不给 usage：估算要把刹车踩下去，而不是一路跑满 10 步。

        跑满时的形状是 ``steps=10 / calls=11``（10 个工具轮 + 1 次收口），
        被预算截住时两个数都明显更小。
        """
        result = self._run_loop(monkeypatch, with_usage=False, budget=1000)
        assert result["steps"] < 10, "预算没生效，循环跑满了步数上限"
        assert result["_chat_calls"] < 10

    def test_tiny_budget_stops_after_the_first_round(self, monkeypatch) -> None:
        """预算小到第一轮就超：之后不该再有工具轮，只留一次收口调用。"""
        result = self._run_loop(monkeypatch, with_usage=False, budget=1)
        assert result["steps"] == 2
        assert result["_chat_calls"] == 2

    def test_real_usage_is_accumulated_and_not_marked_estimated(self, monkeypatch) -> None:
        """有真实 usage 时照实累加，且不把它标成估算值。"""
        result = self._run_loop(monkeypatch, with_usage=True, budget=1000)
        assert result["usage"]["total_tokens"] == 10 * result["_chat_calls"]
        assert "estimated" not in result["usage"]

    def test_usage_falls_back_to_estimate_for_audit(self, monkeypatch) -> None:
        """整轮都没有真值：返回估算值并标注，记录页不至于显示 0。"""
        result = self._run_loop(monkeypatch, with_usage=False, budget=1000)
        usage = result["usage"]
        assert usage.get("estimated") is True
        assert usage["total_tokens"] > 0

    def test_no_budget_pressure_runs_to_the_step_limit(self, monkeypatch) -> None:
        """预算给足时不该被估算误伤 —— 该跑满步数就跑满。"""
        result = self._run_loop(monkeypatch, with_usage=False, budget=10**9)
        assert result["steps"] == 10
        assert result["_chat_calls"] == 11


@pytest.mark.parametrize("cfg_budget", [None, 0, ""])
def test_empty_budget_config_falls_back_to_default(monkeypatch, cfg_budget) -> None:
    """没配预算时用平台默认值，而不是 0 —— 0 会让第一轮就被立刻截住。"""
    seen: Dict[str, int] = {}

    async def fake_chat(messages, **kwargs):
        seen["calls"] = seen.get("calls", 0) + 1
        return {"content": "结论", "tool_calls": [], "usage": {}, "model": "stub"}

    monkeypatch.setattr(ai, "chat", fake_chat)
    asyncio.run(
        ai.run_tool_loop(
            [{"role": "user", "content": "hi"}],
            cfg={"token_budget": cfg_budget, "max_tokens": 100, "timeout": 5},
            provider={"model": "stub", "base_url": "http://stub.local"},
            specs=[],
            host_id="local",
            row=None,
            local=True,
            max_steps=3,
            finalize_json_mode=False,
        )
    )
    assert seen["calls"] == 1
