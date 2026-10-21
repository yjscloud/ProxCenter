"""PT-09：captcha_id 必须一次性 —— 无论答对答错，校验后立刻作废。

审计方看到「同一个 id 连续 4 次都是验证失败」，判定 id 没作废。实际代码是
先 pop 再比较，所以那 4 次里有 3 次已经是「这张题不存在」；问题在于提示语
无法区分，看起来像没失效。这里用三态结果把语义钉死。
"""
from __future__ import annotations

import time

from app import captcha


def _issue(answer: str = "abc123", ttl: float = 120.0) -> str:
    cid = f"test-{time.time_ns()}"
    captcha._pending[cid] = (answer, time.time() + ttl)
    return cid


def test_wrong_answer_burns_the_id() -> None:
    cid = _issue()
    assert captcha.check(cid, "wrong") == captcha.RESULT_WRONG
    # 同一 id 再拿正确答案来也不再通过 —— 一次性
    assert captcha.check(cid, "abc123") == captcha.RESULT_GONE


def test_correct_answer_is_single_use() -> None:
    cid = _issue()
    assert captcha.check(cid, "abc123") == captcha.RESULT_OK
    assert captcha.check(cid, "abc123") == captcha.RESULT_GONE


def test_slider_is_single_use() -> None:
    cid = f"slider-{time.time_ns()}"
    captcha._sliders[cid] = (200.0, time.time() + 120)
    assert captcha.check_slider(cid, 1.0) == captcha.RESULT_WRONG
    # 擦线拖到底也拿不到第二次机会
    assert captcha.check_slider(cid, 199.0) == captcha.RESULT_GONE


def test_expired_challenge_is_gone() -> None:
    cid = f"expired-{time.time_ns()}"
    captcha._pending[cid] = ("abc123", time.time() - 1)
    assert captcha.check(cid, "abc123") == captcha.RESULT_GONE


def test_unknown_id_is_gone() -> None:
    assert captcha.check("no-such-id", "abc123") == captcha.RESULT_GONE
