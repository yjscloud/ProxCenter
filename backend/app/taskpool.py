"""巡检类阻塞调用的专用线程池。

## 为什么要单独一个池

参数 `paramiko` 的 SSH 读取与安全基线 / 端口巡检的本地子进程（``ss`` / ``ps``）
都是**阻塞**的，必须丢到线程里跑。此前统一用 ``asyncio.to_thread``，也就是走事件
循环的**默认** executor（上限约 ``min(32, cpu+4)``）。

巡检的并发上限是 ``PROBE_CONCURRENCY``（16 条 SSH），再叠加每台主机的本机检查，
很容易把默认池占满 —— 于是同一进程里其它走 ``to_thread`` 的调用（例如
``database.read_setting_sync`` 的旁路、证书部署等）会被巡检排队拖住。

这里给巡检类调用一个独立池：巡检再重也只在自己的池里排队，不挤占默认池。
"""
from __future__ import annotations

import asyncio
import functools
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

#: 专用池线程数。巡检并发上限 16，本机 subprocess 与 PVE 阻塞读取再算几路，
#: 给到 24 有一倍余量；再多只是把压力推给对端。
MAX_WORKERS = 24

_pool: Optional[ThreadPoolExecutor] = None


def _get_pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(
            max_workers=MAX_WORKERS, thread_name_prefix="inspection"
        )
    return _pool


async def run_blocking(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """在专用池里跑一个阻塞函数，等价于 ``asyncio.to_thread`` 但换池。"""
    loop = asyncio.get_running_loop()
    call = functools.partial(func, *args, **kwargs)
    return await loop.run_in_executor(_get_pool(), call)


def shutdown() -> None:
    """进程退出时释放线程池（在 FastAPI lifespan 的停止阶段调用）。"""
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None
