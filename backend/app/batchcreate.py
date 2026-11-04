"""批量下发的编排层：VMID 分配、逐台执行、幂等缓存、统一结果形状。

批量创建不复制单台创建的业务逻辑 —— 每个 item 仍走 ``vms._create_vm_core`` /
``lxc._create_lxc_core``，归属、审计、通知、创建时间全部与单台一致。这个模块
只负责三件「单台没有」的事：

* 一次把 N 个 VMID 分好，避免并发/循环里各自 ``nextid`` 撞号；
* 单台失败不整批抛错，逐台记 ``ok / error / task``；
* ``batch_id`` 幂等：同一账号重复提交同一个键，直接返回上次的结果。

幂等缓存是**进程内**的（TTL 10 分钟）。面板通常单进程；多 worker 部署时最坏
情况是重试落到另一个 worker，退化成「没有幂等」，不会比不实现更差。
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException

logger = logging.getLogger(__name__)

#: 幂等结果保留时长（秒）。批量结果本身不落库，超过这个时间重提会重新执行。
BATCH_CACHE_TTL = 600.0
_BATCH_CACHE: Dict[tuple, tuple] = {}


def _prune_cache(now: float) -> None:
    if len(_BATCH_CACHE) < 256:
        return
    for key, (deadline, _result) in list(_BATCH_CACHE.items()):
        if deadline <= now:
            _BATCH_CACHE.pop(key, None)


def cached_batch(username: str, batch_id: str) -> Optional[Dict[str, Any]]:
    """同一个账号 + 同一个 batch_id 的已受理结果。"""
    if not batch_id:
        return None
    item = _BATCH_CACHE.get((username, batch_id))
    if not item:
        return None
    deadline, result = item
    if deadline <= time.time():
        _BATCH_CACHE.pop((username, batch_id), None)
        return None
    return result


def remember_batch(username: str, batch_id: str, result: Dict[str, Any]) -> None:
    if not batch_id:
        return
    now = time.time()
    _prune_cache(now)
    _BATCH_CACHE[(username, batch_id)] = (now + BATCH_CACHE_TTL, result)


def new_batch_id() -> str:
    return uuid.uuid4().hex


async def allocate_vmids(client: Any, items: List[Any]) -> None:
    """给没有指定 ``vmid`` 的 item 分配唯一 ID（就地写回 item）。

    不能对 ``nextid`` 连调 N 次：PVE 的 ``cluster/nextid`` 返回的是「当前最小的
    空闲号」，在真正建出机器之前它不会前进，连调只会拿到同一个值。这里改成
    「取一次起点，然后跳过集群里已占用的号」。一次拉 ``cluster/resources``
    既能把已占用的 ID 收全，也能提前把用户显式填的冲突 ID 挡在创建之前。
    """
    explicit: set = set()
    for item in items:
        raw = getattr(item, "vmid", None)
        if not raw:
            continue
        try:
            vmid = int(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="VMID 必须是整数")
        if vmid in explicit:
            raise HTTPException(status_code=400, detail=f"VMID {vmid} 在本批中重复")
        explicit.add(vmid)

    try:
        resources = await client.cluster_resources()
    except Exception as exc:  # noqa: BLE001 - 拿不到占用表就不能安全分号
        raise HTTPException(
            status_code=503,
            detail="暂时读不到集群 VMID 占用情况，已拒绝本次批量下发；请稍后重试",
        ) from exc

    occupied: set = set(explicit)
    for row in resources or []:
        try:
            occupied.add(int(row.get("vmid")))
        except (TypeError, ValueError):
            continue

    for vmid in explicit:
        if any(
            int(row.get("vmid") or 0) == vmid
            for row in (resources or [])
            if row.get("vmid") is not None
        ):
            raise HTTPException(
                status_code=400, detail=f"VMID {vmid} 已被集群占用，请换一个"
            )

    pending = [item for item in items if not getattr(item, "vmid", None)]
    if not pending:
        return

    try:
        candidate = int(await client.nextid())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503, detail="暂时取不到可用 VMID，请稍后重试"
        ) from exc

    for item in pending:
        while candidate in occupied:
            candidate += 1
        item.vmid = candidate
        occupied.add(candidate)
        candidate += 1


def _item_name(item: Any) -> str:
    return str(getattr(item, "name", None) or getattr(item, "hostname", "") or "")


def _error_text(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, (dict, list)):
            return str(detail)[:500]
        return str(detail)[:500]
    return str(exc)[:500] or exc.__class__.__name__


async def run_batch(
    *,
    batch_id: str,
    kind: str,
    items: List[Any],
    create_one: Callable[[Any], Any],
    stop_on_error: bool = True,
) -> Dict[str, Any]:
    """逐台执行 ``create_one``，返回与 ``BulkResponse`` 兼容的逐台清单。

    ``kind`` 是 ``vm`` / ``lxc``，结果里的 ``type`` 用 PVE 叫法（qemu / lxc）。
    """
    result: Dict[str, Any] = {
        "action": "create",
        "batch_id": batch_id,
        "kind": kind,
        "total": len(items),
        "ok": 0,
        "failed": 0,
        "results": [],
    }
    stopped = False
    for index, item in enumerate(items):
        base = {
            "index": index,
            "node": str(getattr(item, "node", "") or ""),
            "vmid": int(getattr(item, "vmid", 0) or 0),
            "name": _item_name(item),
            "type": "qemu" if kind == "vm" else "lxc",
        }
        if stopped:
            result["failed"] += 1
            result["results"].append(
                {
                    **base,
                    "ok": False,
                    "task": None,
                    "error": "已跳过：前序任务失败（stop_on_error=true）",
                }
            )
            continue

        try:
            created = await create_one(item)
        except HTTPException as exc:
            logger.warning(
                "批量下发 %s 第 %d 台失败：%s", batch_id, index, exc.detail
            )
            result["failed"] += 1
            result["results"].append(
                {**base, "ok": False, "task": None, "error": _error_text(exc)}
            )
            stopped = bool(stop_on_error)
            continue
        except Exception as exc:  # noqa: BLE001 - 单台失败不能拖垮整批
            logger.warning(
                "批量下发 %s 第 %d 台异常", batch_id, index, exc_info=True
            )
            result["failed"] += 1
            result["results"].append(
                {**base, "ok": False, "task": None, "error": _error_text(exc)}
            )
            stopped = bool(stop_on_error)
            continue

        created = created or {}
        result["ok"] += 1
        result["results"].append(
            {
                **base,
                "node": str(created.get("node") or base["node"]),
                "vmid": int(created.get("vmid") or base["vmid"] or 0),
                "ok": True,
                "task": created.get("task") or None,
                "error": None,
                "post_steps": created.get("post_steps") or [],
                "disk_note": created.get("disk_note") or "",
                "template": bool(created.get("template")),
            }
        )
    return result
