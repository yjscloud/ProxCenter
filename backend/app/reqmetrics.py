"""请求级调用计数（可观测性基线）。

性能优化的第一步不是改代码，而是让「慢多少」变成可断言的数字。之前所有耗时
都是按调用链推算的区间，改完只能凭手感说「似乎快了」。这里给每个请求挂两个
计数：

* ``X-PVE-Calls``   —— 这个请求真实打了几次 Proxmox API（缓存命中时为 0）；
* ``X-DB-Queries``  —— 这个请求执行了几条 SQL（含同步读 settings 的那条）。

两个数都走 ``contextvars``，由原生 ASGI 中间件在请求入口归零、响应开始前写进
响应头。用原生 ASGI 而不是 ``BaseHTTPMiddleware`` 是必须的：后者会把下游放进
独立任务，contextvar 的写入就传不进处理函数了（与
:class:`app.main.PveConnectionScopeMiddleware` 同一取舍）。

**为什么存的是可变计数器而不是 int**：``asyncio.gather`` 里的每个子任务跑在
context 的**副本**上，子任务里 ``ContextVar.set()`` 只在它自己那份里生效，父
任务看不到 —— 一开始就写成 int，结果 fan-out 出去的请求（``pve.parallel``）
一条都没算进去，计数器永远偏小。改成「contextvar 持有同一个计数器对象、计数
发生在对象内部」之后，副本里改的是同一个对象，父任务读到的就是全量。
"""
from __future__ import annotations

import contextvars
from typing import Any, Tuple


class _Counter:
    """单次请求内共享的计数器。只做自增，不做减法 —— 没有「误解计」的需求。"""

    __slots__ = ("value",)

    def __init__(self) -> None:
        self.value = 0

    def add(self, count: int = 1) -> None:
        self.value += count


#: 本次请求内的两个计数器；``None`` 表示「不在请求上下文里」（后台任务、脚本）
_counters: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "reqmetrics_counters", default=None
)


def reset() -> Tuple[Any, Any, Any]:
    """请求入口装一对新计数器，返回 ``(计数器, 旧值, token)`` 供恢复。"""
    previous = _counters.get()
    token = _counters.set((_Counter(), _Counter()))
    return previous, token


def restore(previous: Any, token: Any) -> None:
    """请求结束恢复上一个上下文。"""
    if previous is None:
        try:
            _counters.reset(token)
        except (ValueError, RuntimeError):
            pass
    else:
        _counters.set(previous)


def bump_pve(count: int = 1) -> None:
    """记一次真实 PVE 调用。缓存命中不该调它 —— 那正是断言要证明的事。"""
    pair = _counters.get()
    if pair is not None:
        pair[0].add(count)


def bump_db(count: int = 1) -> None:
    """记一条 SQL。"""
    pair = _counters.get()
    if pair is not None:
        pair[1].add(count)


def snapshot() -> Tuple[int, int]:
    """当前请求的 ``(PVE 调用数, SQL 条数)``；不在请求上下文里时为 ``(0, 0)``。"""
    pair = _counters.get()
    if pair is None:
        return (0, 0)
    return (pair[0].value, pair[1].value)


class RequestMetricsMiddleware:
    """归零计数并在响应头回写本次请求的两个数字。

    ``/api/health`` 这类探针也会带上（值都是 0），这样「有没有埋点」本身就是
    一眼可见的，不需要翻日志确认。
    """

    HEADER_PVE = b"x-pve-calls"
    HEADER_DB = b"x-db-queries"

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        previous, token = reset()

        async def send_with_metrics(message: Any) -> None:
            if message.get("type") == "http.response.start":
                pve, db = snapshot()
                headers = list(message.get("headers") or [])
                headers.append((self.HEADER_PVE, str(pve).encode()))
                headers.append((self.HEADER_DB, str(db).encode()))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_metrics)
        finally:
            restore(previous, token)
