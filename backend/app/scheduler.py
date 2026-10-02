"""后台作业调度：把散在 main.py 里的几个 asyncio 循环收成一张可观测、可调的作业表。

为什么要收编
------------
改造前是四个各自独立的 ``while True: sleep(...)`` 循环，间隔写成模块级常量：

* **看不见**——某个作业的 ``except Exception: logger.exception(...)`` 吞掉异常后，
  界面上完全看不出「这个巡检是不是从上周就挂了」，只能翻日志；
* **改不了**——想调整巡检频率得改代码重启；
* **数不清**——「每 5 个 tick 跑一次」这种倍数写法，要拿计算器才知道实际是几分钟。

于是改成一份作业注册表 + 单个 tick 循环：每个作业有自己的间隔、自己的运行状态
（上次执行时间、耗时、成败、错误信息、下次执行时间），间隔可以改并落库，
改完下一个周期就生效，不必重启。

设计要点
--------
* **一个 tick 循环调度所有作业**，而不是每个作业一个 ``while True``：这样
  「下次什么时候跑」是一个可计算的确定值，而不是散落在各处的 ``sleep``。
* 单个作业失败只影响它自己：异常被捕获后记进该作业的状态里，下一个周期照跑。
  改造前的循环也是一样的容错，但不能因此丢掉「失败过几次」这个事实。
* **重叠保护**：上一次还没跑完就到点了，跳过这一次并计数（``skipped``）。
  说明间隔设得比实际耗时还短，这是个该被看见的配置问题。
* 只在「与代码默认值不同」时才落库（见 :func:`_state_payload`）：这样把某个
  默认间隔在代码里调大之后，从没手动改过的部署会跟着一起变 —— 而不是被一条
  陈旧的配置记录钉死在旧值上。
* 内部用 ``time.monotonic()`` 计算下次唤醒：NTP 把墙钟往回拨时不会让所有作业
  停摆；展示给界面的时间戳仍是墙钟。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

from . import i18n, store

logger = logging.getLogger(__name__)

# tick 粒度（秒）。到点判定用「当前时刻 >= 下次执行时刻」，所以粒度决定了
# 调度精度：1 秒对本场景（间隔都是分钟级）绰绰有余，空转成本可以忽略。
TICK = 1.0

# 落库的键。存的是 {job_id: {interval, enabled}}，且只存偏离默认值的项。
STATE_KEY = "scheduler_jobs"

# 单个作业的间隔范围（秒）。下限挡住「设成 1 秒把 PVE 打爆」，
# 上限 30 天 —— 比这更稀疏的巡检基本等于关掉了。
MIN_INTERVAL = 10
MAX_INTERVAL = 30 * 86_400


@dataclass
class Job:
    """一个后台作业的静态定义。"""

    id: str
    name: str
    group: str
    description: str
    run: Callable[[], Awaitable[Any]]
    # 默认间隔（秒）。改造前那些「每 N 个 tick」的倍数，在这里换算成了真实秒数。
    default_interval: int
    # 进程启动后第一次执行的延迟。默认等于间隔（= 先睡再跑，与改造前一致），
    # 因为刚启动时 PVE 连接、缓存都还没就绪，立刻跑大概率是空转。
    first_delay: Optional[int] = None
    # 把作业返回值收成一句人话，例如「触发 2 条」「无变化」。
    summarize: Optional[Callable[[Any], str]] = None
    # 该作业多久没成功就应该被看出来。留给界面做「疑似停摆」标记。
    stale_after: Optional[int] = None


@dataclass
class JobState:
    """一个作业的运行态。"""

    job: Job
    interval: int
    enabled: bool = True
    running: bool = False
    runs: int = 0
    failures: int = 0
    skipped: int = 0
    last_status: str = "never"  # never | running | ok | error
    last_start: float = 0.0
    last_end: float = 0.0
    last_duration_ms: float = 0.0
    last_error: str = ""
    last_summary: str = ""
    last_manual: bool = False
    # 单调钟下的下次唤醒时刻（不对外暴露，见 describe）
    next_mono: float = field(default=0.0)

    @property
    def modified(self) -> bool:
        return (
            self.interval != self.job.default_interval or not self.enabled
        )


_JOBS: Dict[str, Job] = {}
_RUNTIME: Dict[str, JobState] = {}
_task: Optional[asyncio.Task] = None


# --------------------------------------------------------------------- 注册
def register(job: Job) -> Job:
    """注册一个作业。重复 id 直接报错 —— 静默覆盖会让「改了没生效」难以排查。"""
    if job.id in _JOBS:
        raise ValueError(f"作业 id 重复：{job.id}")
    _JOBS[job.id] = job
    _RUNTIME[job.id] = JobState(job=job, interval=job.default_interval)
    return job


def is_registered(job_id: str) -> bool:
    return job_id in _JOBS


def effective_interval(job_id: str, fallback: int) -> int:
    """某个作业当前生效的间隔（秒）；未注册时用 ``fallback``。

    专门给「间隔本身会影响数据正确性」的作业用：监控历史采样按这个值对齐时间戳
    （见 :func:`metrics.align_ts`），如果它固守 ``settings.metrics_sample_interval``
    而调度器实际用的是另一个值，同一分钟内的重复采样就不再落进同一行，
    历史曲线会出现重复点。
    """
    state = _RUNTIME.get(job_id)
    if state is None:
        return max(int(fallback), 1)
    return max(int(state.interval), 1)


def _clamp(interval: Any, default: int) -> int:
    try:
        value = int(interval)
    except (TypeError, ValueError):
        return max(int(default), MIN_INTERVAL)
    return max(MIN_INTERVAL, min(value, MAX_INTERVAL))


# ----------------------------------------------------------------- 状态持久化
def _state_payload() -> Dict[str, Dict[str, Any]]:
    """只导出**偏离默认值**的项（见模块说明的最后一条）。"""
    return {
        state.job.id: {"interval": state.interval, "enabled": state.enabled}
        for state in _RUNTIME.values()
        if state.modified
    }


async def load_state() -> None:
    """从 settings 表恢复间隔 / 启停。启动时调一次，失败不阻断启动。"""
    saved: Dict[str, Any] = {}
    try:
        raw = await store.get_setting(STATE_KEY, "")
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                saved = parsed
    except Exception:  # noqa: BLE001 - 配置读不出来就用默认值，不该拦住启动
        logger.exception("读取调度器配置失败，全部回落到默认间隔")

    now = time.monotonic()
    for state in _RUNTIME.values():
        entry = saved.get(state.job.id) or {}
        if not isinstance(entry, dict):
            entry = {}
        state.interval = _clamp(entry.get("interval", state.job.default_interval), state.job.default_interval)
        state.enabled = bool(entry.get("enabled", True))
        state.next_mono = now + float(
            state.job.first_delay if state.job.first_delay is not None else state.interval
        )


async def save_state() -> None:
    await store.set_setting(STATE_KEY, json.dumps(_state_payload(), ensure_ascii=False))


# ------------------------------------------------------------------- 运行时
def _summarize(job: Job, result: Any) -> str:
    if job.summarize is not None:
        try:
            return str(job.summarize(result))
        except Exception:  # noqa: BLE001 - 摘要失败不该影响作业本身的成败
            return ""
    if result is None:
        return ""
    if isinstance(result, bool):
        return "有变化" if result else "无变化"
    if isinstance(result, (list, tuple, set)):
        return f"{len(result)} 项" if result else "无变化"
    if isinstance(result, dict):
        return f"{len(result)} 项" if result else "无变化"
    return str(result)[:120]


def describe(state: JobState) -> Dict[str, Any]:
    """作业的对外视图（接口与日志共用一份口径）。"""
    job = state.job
    now_mono = time.monotonic()
    now_wall = time.time()
    next_in = max(state.next_mono - now_mono, 0.0) if state.enabled else 0.0
    return {
        "id": job.id,
        # 作业的名称 / 分组 / 说明与最近一次摘要都是中文原文，出口按请求语言
        # 本地化（见 i18n.py）；译表里没有的条目原样透传。
        "name": i18n.tr(job.name),
        "group": i18n.tr(job.group),
        "description": i18n.tr(job.description),
        "interval": state.interval,
        "default_interval": job.default_interval,
        "min_interval": MIN_INTERVAL,
        "max_interval": MAX_INTERVAL,
        "enabled": state.enabled,
        "modified": state.modified,
        "running": state.running,
        "runs": state.runs,
        "failures": state.failures,
        "skipped": state.skipped,
        "last_status": state.last_status,
        "last_start": state.last_start,
        "last_end": state.last_end,
        "last_duration_ms": state.last_duration_ms,
        "last_error": state.last_error,
        "last_summary": i18n.tr(state.last_summary),
        "last_manual": state.last_manual,
        # 下次执行的相对秒数与绝对墙钟时间：内部按单调钟算，给界面看绝对时间
        "next_in": round(next_in, 1),
        "next_at": now_wall + next_in,
    }


def snapshot() -> List[Dict[str, Any]]:
    return [describe(state) for state in _RUNTIME.values()]


async def _execute(state: JobState, manual: bool = False) -> Dict[str, Any]:
    job = state.job
    previous_status = state.last_status
    started = time.time()
    state.running = True
    state.last_start = started
    state.last_status = "running"
    state.last_error = ""
    state.last_manual = manual
    state.last_end = 0.0
    state.last_duration_ms = 0.0

    try:
        result = await job.run()
    except asyncio.CancelledError:
        # 关停时正在跑的作业：不算失败、不推进下次唤醒，恢复原状态后原样抛出
        state.running = False
        state.last_status = previous_status
        raise
    except Exception as exc:  # noqa: BLE001 - 一个作业炸掉不该影响别的作业
        state.runs += 1
        state.failures += 1
        state.last_status = "error"
        state.last_summary = ""
        state.last_error = f"{type(exc).__name__}: {exc}"
        logger.exception("后台作业执行失败：%s（%s）", job.name, job.id)
    else:
        state.runs += 1
        state.last_status = "ok"
        state.last_summary = _summarize(job, result)

    ended = time.time()
    state.last_end = ended
    state.last_duration_ms = round((ended - started) * 1000, 1)
    state.running = False
    state.next_mono = time.monotonic() + state.interval
    return describe(state)


async def trigger(job_id: str) -> Dict[str, Any]:
    """立即执行一次（界面的「立即执行」按钮）。"""
    state = _RUNTIME.get(job_id)
    if state is None:
        raise KeyError(job_id)
    if state.running:
        raise RuntimeError(i18n.t("error.job_running"))
    state.running = True
    try:
        return await _execute(state, manual=True)
    finally:
        state.running = False


async def _dispatch() -> None:
    now = time.monotonic()
    for state in _RUNTIME.values():
        if not state.enabled:
            continue
        if state.running:
            # 上一轮还没跑完就到点了：跳过并推进唤醒时刻，避免堆积
            if now >= state.next_mono:
                state.next_mono = now + state.interval
                state.skipped += 1
            continue
        if now < state.next_mono:
            continue
        # 先把 running 置上再交给事件循环：否则同一 tick 里再看到它还是「空闲」，
        # 会重复派发同一个作业
        state.running = True
        asyncio.create_task(_execute(state))


async def run_forever() -> None:
    """调度器主循环：每 :data:`TICK` 秒检查一次哪些作业到点了。"""
    logger.info("调度器已启动：%d 个作业", len(_RUNTIME))
    while True:
        try:
            await asyncio.sleep(TICK)
            await _dispatch()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - tick 自身出错也不能让调度停摆
            logger.exception("调度器 tick 失败")


def start() -> asyncio.Task:
    global _task
    _task = asyncio.create_task(run_forever())
    return _task


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    _task = None


# --------------------------------------------------------------- 配置变更
def _state(job_id: str) -> JobState:
    state = _RUNTIME.get(job_id)
    if state is None:
        raise KeyError(job_id)
    return state


async def configure(
    job_id: str,
    interval: Optional[int] = None,
    enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """改间隔 / 启停。改完立刻重算下次唤醒 —— 否则要等旧间隔到期才生效。"""
    state = _state(job_id)
    if interval is not None:
        state.interval = _clamp(interval, state.job.default_interval)
    if enabled is not None:
        state.enabled = bool(enabled)
    if state.enabled:
        state.next_mono = time.monotonic() + state.interval
    await save_state()
    return describe(state)


async def reset(job_id: str) -> Dict[str, Any]:
    """恢复该作业的代码默认间隔与启用状态。"""
    state = _state(job_id)
    state.interval = state.job.default_interval
    state.enabled = True
    state.next_mono = time.monotonic() + state.interval
    await save_state()
    return describe(state)
