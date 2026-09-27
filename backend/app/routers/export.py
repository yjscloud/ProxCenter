"""数据导出：审计日志 / 任务队列 / 资产清单 / 告警历史导成 CSV 附件。

设计要点
--------
* **服务端流式**：直接吐 ``StreamingResponse``，不受分页限制，覆盖全量数据。
  合规归档要的是「这张表里的全部记录」，前端那 50 条一页的导出没有意义。
* **筛选条件与列表页一致**：每个导出接口都接受和对应列表接口相同的查询参数，
  界面上筛出什么，导出就是什么。逐个接口共用同一份 WHERE 构造（审计用
  ``store.audit_filters``），避免两边慢慢分叉。
* **归属隔离同样生效**：任务 / 资产 / 告警导出沿用各自列表接口的可见范围
  （管理员看全部，普通用户只看自己的），否则导出会成为一个绕过隔离的后门。
* **导出行为本身入审计**：导出等于把一批敏感数据带走，属于必须留痕的读取。
  记 ``*.export`` 动作并带上行数，方便事后回答「谁在什么时候导走了多少条」。
"""
from __future__ import annotations

import time
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence

from fastapi import APIRouter, Depends, Query, Request

from .. import alerting, exporting, ownership, security, store
from ..formatters import normalize_task
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
    requested_connection,
)
from . import vms as vms_router

router = APIRouter(prefix="/api/export", tags=["export"])

# 导出时每台 PVE 最多取多少条任务。PVE 自己的任务日志也会滚动清理，
# 1000 条通常覆盖最近几天，够复盘；要更长历史得靠面板侧的审计日志。
TASK_LIMIT = 1000

GUEST_TYPE_LABELS = {"qemu": "虚拟机", "lxc": "容器"}
ALERT_KIND_LABELS = {"alarm": "告警", "recovery": "恢复"}


def _time_header(base: str = "时间") -> str:
    """时间列名带上服务器时区偏移。

    导出文件会被转发给别人看，而「14:03」在不同时区的人眼里是不同的时刻；
    把偏移写进列名，拿到表的人不用再去问「这是哪个时区的时间」。
    """
    offset = time.strftime("%z")
    if not offset:
        return base
    return f"{base}(UTC{offset[:3]}:{offset[3:]})"


def _ts(value: Any) -> str:
    """Unix 秒 → ``YYYY-MM-DD HH:MM:SS``（服务器本地时间，Excel 直接可排序）。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(number))


def _size_mb(value: Any) -> Any:
    """字节 → MB（保留一位小数）。清单类报表用 MB/GB 比裸字节可读得多。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return 0
    return round(number / (1024 * 1024), 1)


def _stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


# ------------------------------------------------------------------ 审计日志
@router.get("/audit")
async def export_audit(
    request: Request,
    username: Optional[str] = None,
    action: Optional[str] = None,
    result: Optional[str] = None,
    start: Optional[float] = None,
    end: Optional[float] = None,
    search: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("audit.view")),
):
    """导出审计日志（全量，支持与列表页相同的筛选）。"""
    await security.audit_read(
        request,
        user,
        "audit.export",
        target="audit_log",
        detail=(
            f"username={username or '-'} action={action or '-'} result={result or '-'}"
            f" start={start or '-'} end={end or '-'} search={search or '-'}"
        ),
    )

    async def rows() -> AsyncIterator[Sequence[Any]]:
        async for item in store.stream_audit(
            username=username,
            action=action,
            result=result,
            start=start,
            end=end,
            search=search,
        ):
            yield [
                _ts(item.get("timestamp")),
                item.get("username") or "",
                item.get("action") or "",
                item.get("target") or "",
                item.get("result") or "",
                item.get("ip") or "",
                item.get("detail") or "",
            ]

    return exporting.csv_attachment(
        filename=f"审计日志-{_stamp()}.csv",
        ascii_filename=f"audit-log-{_stamp()}.csv",
        header=[_time_header(), "用户", "动作", "目标", "结果", "来源 IP", "详情"],
        rows=rows(),
    )


# ------------------------------------------------------------------ 任务队列
@router.get("/tasks")
async def export_tasks(
    request: Request,
    node: Optional[str] = None,
    limit: int = Query(default=TASK_LIMIT, ge=1, le=10_000),
    user: Dict[str, Any] = Depends(security.require_permission("task.view")),
):
    """导出任务队列。

    任务列表来自各台 PVE 自己的任务日志（面板不落库），因此这里逐条连接去取，
    单台连不上只跳过它 —— 与 ``/api/tasks`` 的容错口径一致。合并所有连接时
    主机名可能重名，额外输出一列「连接」用于区分。
    """
    await security.audit_read(
        request,
        user,
        "task.export",
        target=node or "all",
        detail=f"node={node or '-'} limit={limit}",
    )

    def targets() -> List[Any]:
        if requested_connection():
            cid = requested_connection()
            profile = next(
                (c for c in store.get_connections() if str(c.get("id")) == cid),
                None,
            )
            return [(profile, get_client())]
        return list(all_connection_clients()) or [(None, get_client())]

    async def rows() -> AsyncIterator[Sequence[Any]]:
        for profile, client in targets():
            label = connection_label(profile) if profile else ""
            try:
                tasks = await client.tasks(node=node, limit=limit) or []
            except ProxmoxError:
                # 单台 PVE 不可达不影响其它主机已取到的任务
                continue
            for raw in tasks:
                task = normalize_task(raw)
                starttime = task.get("starttime")
                endtime = task.get("endtime")
                duration = ""
                if isinstance(starttime, (int, float)) and isinstance(endtime, (int, float)):
                    duration = max(int(endtime - starttime), 0)
                yield [
                    task.get("node") or "",
                    label,
                    task.get("type") or "",
                    str(task.get("id") or ""),
                    task.get("user") or "",
                    "运行中" if task.get("running") else (task.get("status") or ""),
                    task.get("exitstatus") or "",
                    _ts(starttime),
                    _ts(endtime),
                    duration,
                    task.get("upid") or "",
                ]

    return exporting.csv_attachment(
        filename=f"任务队列-{_stamp()}.csv",
        ascii_filename=f"tasks-{_stamp()}.csv",
        header=[
            "节点",
            "连接",
            "任务类型",
            "任务对象",
            "发起用户",
            "状态",
            "退出状态",
            _time_header("开始时间"),
            _time_header("结束时间"),
            "耗时(秒)",
            "UPID",
        ],
        rows=rows(),
    )


# ------------------------------------------------------------------ 资产清单
@router.get("/vms")
async def export_vms(
    request: Request,
    node: Optional[str] = None,
    guest_type: str = Query(default="all", alias="type", pattern="^(qemu|lxc|all)$"),
    with_ip: bool = Query(default=False),
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
):
    """导出虚拟机 / 容器清单。

    走 :func:`routers.vms.collect_vms`，与界面列表共用同一份过滤与归属隔离 ——
    否则「列表里 3 台、导出里 30 台」就是一个现成的越权通道。

    多一列「归属人」（面板侧的归属记录，PVE 里没有）：合规盘点时最常被问的
    就是「这台机器归谁」。``with_ip=true`` 才解析 IP，因为每台机器要多发两次
    PVE 请求，大集群上会明显变慢。
    """
    await security.audit_read(
        request,
        user,
        "vm.export",
        target=node or "all",
        detail=f"type={guest_type} node={node or '-'} with_ip={with_ip}",
    )

    guests = await vms_router.collect_vms(
        user=user, node=node, with_ip=with_ip, guest_type=guest_type
    )
    # 归属是面板侧数据，PVE 里拿不到；一次取全表再按 ref 反查，避免逐台查库
    owners = await ownership.owners_map(ownership.KIND_VM)

    async def rows() -> AsyncIterator[Sequence[Any]]:
        for vm in guests:
            ref = ownership.vm_ref(
                str(vm.get("connection_id") or ""),
                str(vm.get("node") or ""),
                vm.get("vmid"),
            )
            yield [
                vm.get("connection_name") or "",
                vm.get("node") or "",
                vm.get("vmid") or "",
                vm.get("name") or "",
                GUEST_TYPE_LABELS.get(str(vm.get("type") or ""), str(vm.get("type") or "")),
                vm.get("status") or "",
                "是" if vm.get("template") else "否",
                vm.get("maxcpu") or 0,
                _size_mb(vm.get("maxmem")),
                _size_mb(vm.get("maxdisk")),
                vm.get("tags") or "",
                owners.get(ref, ""),
                vm.get("ip", "") if with_ip else "",
            ]

    header = [
        "连接",
        "节点",
        "VMID",
        "名称",
        "类型",
        "状态",
        "模板",
        "vCPU",
        "内存(MB)",
        "磁盘(MB)",
        "标签",
        "归属人",
    ]
    if with_ip:
        header.append("IP 地址")

    return exporting.csv_attachment(
        filename=f"资产清单-{_stamp()}.csv",
        ascii_filename=f"vm-inventory-{_stamp()}.csv",
        header=header,
        rows=rows(),
    )


# ------------------------------------------------------------------ 告警历史
@router.get("/alerts")
async def export_alerts(
    request: Request,
    kind: Optional[str] = Query(default=None, pattern="^(alarm|recovery)$"),
    user: Dict[str, Any] = Depends(security.require_permission("alert.view")),
):
    """导出告警历史。``kind`` 留空导出告警与恢复两类。"""
    await security.audit_read(
        request,
        user,
        "alert.export",
        target=kind or "all",
        detail=f"kind={kind or '-'}",
    )

    # 与 /api/alerts 同一归属口径：管理员看全部，普通用户只看自己的
    scope = security.visible_owner(user)

    async def rows() -> AsyncIterator[Sequence[Any]]:
        async for item in alerting.stream_history(owner=scope, kind=kind):
            metric = str(item.get("metric") or "")
            yield [
                _ts(item.get("ts")),
                item.get("username") or "",
                ALERT_KIND_LABELS.get(str(item.get("kind") or ""), item.get("kind") or ""),
                item.get("rule_name") or "",
                alerting.METRIC_LABELS.get(metric, metric),
                item.get("target_type") or "",
                item.get("target") or "",
                item.get("value") if item.get("value") is not None else "",
                item.get("threshold") if item.get("threshold") is not None else "",
                item.get("result") or "",
                item.get("detail") or "",
            ]

    return exporting.csv_attachment(
        filename=f"告警历史-{_stamp()}.csv",
        ascii_filename=f"alert-history-{_stamp()}.csv",
        header=[
            _time_header(),
            "归属用户",
            "类型",
            "规则",
            "指标",
            "对象类型",
            "对象",
            "当前值",
            "阈值",
            "结果",
            "详情",
        ],
        rows=rows(),
    )
