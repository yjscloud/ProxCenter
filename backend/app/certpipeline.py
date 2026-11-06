"""证书流水线引擎：有序步骤 + 失败短路 + 逐步留痕。

借鉴 certd「流水线 = 触发器 + 有序动作」的思路，但不做可视化编排：一个
:class:`Pipeline` 就是一串**固定顺序**的 :class:`Step`，步骤之间通过
:class:`Context` 传递产物（配置、客户端、决策、结果）。

四条约定：

1. **一步一件事**。每步只负责一个动作（同步 / 判定 / 申请 / 部署 / 落库），
   出错时一眼看得出是哪一环，而不是一整个 200 行的函数抛了个异常。
2. **失败短路**。任何一步抛异常即中止后续步骤，但已完成的步骤结果全部保留，
   排障时能看到「卡在第几步」；异常本身不吞掉，由调用方决定怎么记录。
3. **可跳过**。``Step.when`` 返回 False 时记一条 ``skipped``，不计入耗时，
   这样「没有待签发证书就不查腾讯云」这类分支不必写成嵌套 if。
4. **可扩展**。新增动作（到期提醒、多目标分发、CDN 刷新、部署后回滚）
   只需往列表里 append 一个 Step，主流程一行都不用改。

刻意与业务解耦：本模块不 import 任何 ``certs`` 的符号，方便单独测试。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

# 步骤状态。与 ``cert_deploy_log.result`` 的 ok/failed 保持同一套词表，
# 前端「最后运行结果」可以直接渲染，不必再做映射。
STEP_OK = "ok"
STEP_SKIPPED = "skipped"
STEP_FAILED = "failed"

# 单条 detail 落库前的截断长度：站点 JSON 里只留排障够用的信息。
# 600 是「一次 CA 报错能看清楚原因」与「站点 JSON 不被日志撑爆」之间的折中。
DETAIL_LIMIT = 600


@dataclass
class StepResult:
    """一步的执行结果。``ms`` 只统计真正执行了的步骤（跳过恒为 0）。

    ``at`` 是相对本次运行开始的毫秒偏移 —— 页面的日志视图按它排时间轴，
    也能看出「哪一步卡了很久」（前面几步加起来才 10ms，这一步 50s）。
    """

    name: str
    status: str
    detail: str = ""
    ms: int = 0
    at: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "step": self.name,
            "status": self.status,
            "detail": self.detail,
            "ms": self.ms,
            "at": self.at,
        }


@dataclass
class RunResult:
    """一次流水线运行的结果。

    ``exc`` 保留原始异常对象（而不是只留字符串）：调用方需要按异常类型分流
    （例如腾讯云接口错误记日志后继续跑下一个站点，其它异常继续往上抛）。
    """

    status: str
    steps: List[StepResult] = field(default_factory=list)
    value: Any = None
    error: str = ""
    exc: Optional[BaseException] = None

    @property
    def failed(self) -> bool:
        return self.status == STEP_FAILED

    @property
    def ran(self) -> bool:
        """有任何一个步骤真正执行过（用来区分「本次无事可做」与「做完了」）。"""
        return any(s.status != STEP_SKIPPED for s in self.steps)

    def as_list(self) -> List[Dict[str, Any]]:
        return [s.as_dict() for s in self.steps]


@dataclass
class Context:
    """流水线上下文：``site`` 是被处理的站点，``data`` 放各步骤之间的产物。"""

    site: Dict[str, Any]
    data: Dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:  # noqa: A003 - 与 dict 的手感对齐
        self.data[key] = value


@dataclass
class Step:
    """一个流水线步骤。

    :param name: 步骤名，会作为「最后运行结果」里的一行，也是日志里的定位锚点
    :param run: ``async def (ctx) -> Any``，产物直接写进 ``ctx`` 即可
    :param when: 可选前置条件，返回 False 则记 ``skipped`` 并跳过
    :param detail: 可选，``(ctx, 返回值) -> str``，给这一步留一句人话说明
    """

    name: str
    run: Callable[[Context], Awaitable[Any]]
    when: Optional[Callable[[Context], bool]] = None
    detail: Optional[Callable[[Context, Any], str]] = None


def _short(text: Any) -> str:
    return str(text).strip().replace("\n", " ")[:DETAIL_LIMIT]


class Pipeline:
    """固定顺序的步骤序列；一次 :meth:`run` 对应一条流水的执行。"""

    def __init__(self, name: str, steps: List[Step]) -> None:
        self.name = name
        self.steps = steps

    async def run(self, ctx: Context) -> RunResult:
        results: List[StepResult] = []
        started_all = time.perf_counter()

        def elapsed() -> int:
            return int((time.perf_counter() - started_all) * 1000)

        for step in self.steps:
            if step.when is not None and not step.when(ctx):
                results.append(
                    StepResult(step.name, STEP_SKIPPED, at=elapsed())
                )
                continue
            started = time.perf_counter()
            try:
                value = await step.run(ctx)
            except Exception as exc:  # noqa: BLE001 - 统一收口，原样交还调用方
                cost = int((time.perf_counter() - started) * 1000)
                results.append(StepResult(step.name, STEP_FAILED, _short(exc), cost, elapsed()))
                return RunResult(
                    status=STEP_FAILED,
                    steps=results,
                    value=ctx.get("result"),
                    error=f"{step.name}: {exc}",
                    exc=exc,
                )
            cost = int((time.perf_counter() - started) * 1000)
            detail = ""
            if step.detail is not None:
                try:
                    detail = _short(step.detail(ctx, value))
                except Exception:  # 说明文案出错不该影响主流程
                    detail = ""
            results.append(StepResult(step.name, STEP_OK, detail, cost, elapsed()))
        return RunResult(status=STEP_OK, steps=results, value=ctx.get("result"))
