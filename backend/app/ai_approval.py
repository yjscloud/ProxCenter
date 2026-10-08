"""AI 写命令的逐条审批：把「等用户点批准」做成一个可跨请求唤醒的等待点。

为什么单独一个模块
------------------
Agent 循环是**一条流式连接里的 await**，而用户的批准来自**另一个 HTTP 请求**；
两者靠一个进程内的 Future 桥接。放全局状态是必要的（两个请求要能碰到同一个
Future），但键是每次提议唯一的 ``approval_id``，彼此互不干扰。

等待有超时（见 :data:`APPROVAL_TIMEOUT`）：用户不在电脑前时不该让排查一直挂着 ——
超时按「拒绝」处理，模型会收到说明并换方案。超时长度必须小于
``ai.AGENT_TOTAL_TIMEOUT``，否则等待还没结束、循环就因总超时收口了，
用户点了批准也白点。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict

logger = logging.getLogger(__name__)

# 单次审批的等待上限（秒）
APPROVAL_TIMEOUT = 120.0

_pending: Dict[str, "asyncio.Future[bool]"] = {}


async def wait_for_approval(
    approval_id: str, timeout: float = APPROVAL_TIMEOUT
) -> bool:
    """挂起等用户决定；超时 / 连接被取消一律返回 False（视作拒绝）。"""
    loop = asyncio.get_running_loop()
    future: "asyncio.Future[bool]" = loop.create_future()
    _pending[approval_id] = future
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return False
    finally:
        _pending.pop(approval_id, None)


def resolve(approval_id: str, approved: bool) -> bool:
    """由审批接口调用：唤醒等待中的排查。返回是否命中了一个正在等待的请求。"""
    future = _pending.get(approval_id)
    if future is None or future.done():
        return False
    future.set_result(bool(approved))
    return True


def pending_count() -> int:
    """当前有几个在等批准的请求（诊断 / 测试用）。"""
    return len(_pending)
