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


def _trace(target: float, points: int = 8, duration_ms: int = 400) -> list:
    """一条像人拖出来的轨迹：单调递增采样点 + 合理耗时。"""
    return [
        {"x": round(target * i / (points - 1)), "t": round(duration_ms * i / (points - 1))}
        for i in range(points)
    ]


def test_slider_without_trace_is_wrong() -> None:
    """位置完全正确但没有轨迹 ⇒ 判负。

    这是安全审计 H-1 的复现路径：脚本拿到目标坐标后直接提交，不产生任何
    拖动过程。修复前这种请求会直接通过。
    """
    cid = f"slider-{time.time_ns()}"
    captcha._sliders[cid] = (200.0, time.time() + 120)
    assert captcha.check_slider(cid, 200.0) == captcha.RESULT_WRONG


def test_slider_must_reach_the_end() -> None:
    """没拖到末端（差得比容差还多）⇒ 判负。

    判据是 x >= 右端点 - 容差：拖到一半、或者脚本随手编个中间坐标，都过不去。
    """
    cid = f"slider-{time.time_ns()}"
    captcha._sliders[cid] = (200.0, time.time() + 120)
    short = 200.0 - captcha.SLIDER_TOLERANCE - 5
    assert captcha.check_slider(cid, short, _trace(short)) == captcha.RESULT_WRONG


def test_slider_within_tolerance_passes() -> None:
    """差在容差以内就算拖到底：最后几像素不该让人反复划不过去。"""
    cid = f"slider-{time.time_ns()}"
    captcha._sliders[cid] = (200.0, time.time() + 120)
    near = 200.0 - captcha.SLIDER_TOLERANCE + 1
    assert captcha.check_slider(cid, near, _trace(near)) == captcha.RESULT_OK


def test_slider_is_single_use() -> None:
    cid = f"slider-{time.time_ns()}"
    captcha._sliders[cid] = (200.0, time.time() + 120)
    assert captcha.check_slider(cid, 200.0, _trace(200.0)) == captcha.RESULT_OK
    # 位置 + 轨迹都对，也拿不到第二次机会
    assert captcha.check_slider(cid, 200.0, _trace(200.0)) == captcha.RESULT_GONE


def test_expired_challenge_is_gone() -> None:
    cid = f"expired-{time.time_ns()}"
    captcha._pending[cid] = ("abc123", time.time() - 1)
    assert captcha.check(cid, "abc123") == captcha.RESULT_GONE


def test_unknown_id_is_gone() -> None:
    assert captcha.check("no-such-id", "abc123") == captcha.RESULT_GONE
