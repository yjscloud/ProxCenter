"""硬件健康：磁盘状态、ZFS 池、Ceph 集群。

这类指标属于「事前」信号 —— 硬盘快坏了、池降级了，在这里就能提前看到，
而不是等虚拟机的 IO 开始报错才发现。面板原先完全没有这一块。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import security
from ..formatters import pve_flag
from ..pve import (
    ProxmoxError,
    all_connection_clients,
    connection_label,
    get_client,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["health"])


def _http_error(exc: ProxmoxError) -> HTTPException:
    """把上游 PVE 的错误码与文案原样转成 HTTP 异常。"""
    return HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500,
        detail=exc.message,
    )


# 磁盘「健康」字段的归一化：PVE 各存储后端给出的写法不完全一致
_HEALTH_ALIASES = {
    "passed": "passed",
    "ok": "passed",
    "good": "passed",
    "unknown": "unknown",
    "warning": "warning",
    "failed": "failed",
    "fail": "failed",
    "bad": "failed",
}


def _normalize_health(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    return _HEALTH_ALIASES.get(text, "unknown")


def _normalize_disk(item: Dict[str, Any]) -> Dict[str, Any]:
    """把 Disks list 的一条记录整理成前端直接可用的形状。

    ``wearout`` 是固态硬盘的剩余寿命百分比（PVE 给出的是「剩余」而非「已用」），
    机械盘为 None —— 用 ``None`` 而不是 0，前端才能区分「没这个概念」和「磨损殆尽」。
    """
    wearout = item.get("wearout")
    try:
        wearout = int(wearout) if wearout is not None else None
    except (TypeError, ValueError):
        wearout = None

    return {
        "devpath": str(item.get("devpath") or ""),
        "type": str(item.get("type") or ""),
        "vendor": str(item.get("vendor") or ""),
        "model": str(item.get("model") or ""),
        "serial": str(item.get("serial") or ""),
        "size": item.get("size"),
        "used": str(item.get("used") or ""),
        "health": _normalize_health(item.get("health")),
        "wearout": wearout,
        "rpm": item.get("rpm"),
        "gpt": pve_flag(item.get("gpt") or 0) == 1,
    }


@router.get("/nodes/{node}/disks/health")
async def node_disks_health(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    """节点磁盘健康总览。

    刻意用 ``/disks/list`` 而不是逐个磁盘拉 SMART：前者一次请求就带回所有磁盘的
    health 与 wearout，十幾块盘的机器上差别很大。需要细节时前端再单独请求
    :func:`node_disk_smart`。
    """
    client = get_client()
    try:
        disks = await client.get(f"/nodes/{node}/disks/list")
    except ProxmoxError as exc:
        raise _http_error(exc) from exc

    output = [_normalize_disk(d) for d in (disks or []) if isinstance(d, dict)]
    output.sort(key=lambda d: d["devpath"])
    return output


@router.get("/nodes/{node}/disks/smart")
async def node_disk_smart(
    node: str,
    disk: str = Query(..., description="磁盘设备路径，如 /dev/sda"),
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """单块磁盘的 SMART 详情，点击展开时才请求。

    返回结构因盘而异：ATA 盘给结构化的 ``attributes``（重分配扇区、通电时间等），
    NVMe 盘只给一段 ``text`` 原文。这里原样透传，由前端分别渲染。
    """
    client = get_client()
    try:
        data = await client.get(
            f"/nodes/{node}/disks/smart", params={"disk": disk}
        )
    except ProxmoxError as exc:
        raise _http_error(exc) from exc

    if not isinstance(data, dict):
        return {"health": "unknown", "type": "", "attributes": [], "text": ""}

    return {
        "health": _normalize_health(data.get("health")),
        "type": str(data.get("type") or ""),
        "wearout": data.get("wearout"),
        "attributes": [
            {
                "id": a.get("id"),
                "name": str(a.get("name") or ""),
                "value": a.get("value"),
                "worst": a.get("worst"),
                "threshold": a.get("threshold"),
                # PVE 对「已触发失败」的属性会置 fail，这是最该高亮的一列
                "fail": str(a.get("fail") or "") not in ("", "-", "none"),
                "flags": str(a.get("flags") or ""),
            }
            for a in (data.get("attributes") or [])
            if isinstance(a, dict)
        ],
        "text": str(data.get("text") or ""),
    }


@router.get("/nodes/{node}/disks/zfs")
async def node_zfs_pools(
    node: str,
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> List[Dict[str, Any]]:
    """ZFS 池列表。没有池的节点返回空数组（这是正常情况，不是错误）。"""
    client = get_client()
    try:
        pools = await client.get(f"/nodes/{node}/disks/zfs")
    except ProxmoxError as exc:
        raise _http_error(exc) from exc

    output: List[Dict[str, Any]] = []
    for item in pools or []:
        if not isinstance(item, dict):
            continue
        output.append(
            {
                "name": str(item.get("name") or ""),
                "state": str(item.get("state") or "UNKNOWN"),
                "size": item.get("size"),
                "alloc": item.get("alloc"),
                "free": item.get("free"),
                "frag": item.get("frag"),
                "dedup": item.get("dedup"),
                "health": item.get("health"),
                "errors": str(item.get("errors") or ""),
            }
        )
    return output


# -------------------------------------------------------------------- Ceph
# Ceph 是集群级的，且**大多数部署根本没装** —— PVE 在没装时直接抛
# "binary not installed: /usr/bin/ceph-mon"。所以这里把「未安装」当作
# 正常结果返回，而不是让前端看到一个刺眼的报错。


@router.get("/cluster/ceph/status")
async def ceph_status(
    node: Optional[str] = None,
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    """Ceph 集群状态。未部署时返回 ``installed: false`` 而非报错。"""
    pairs = all_connection_clients()
    if not pairs:
        client = get_client()
        pairs = [({}, client)]

    results: List[Dict[str, Any]] = []

    async def probe(profile: Dict[str, Any], client: Any) -> Optional[Dict[str, Any]]:
        try:
            data = await client.get("/cluster/ceph/status")
        except ProxmoxError as exc:
            message = str(exc.message or "")
            # 未安装 / 未配置：明确区分于「查询失败」
            if "not installed" in message or "no ceph" in message.lower():
                return None
            logger.debug("读取 Ceph 状态失败：%s", message)
            return None
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(data, dict):
            return None
        health = data.get("health") or {}
        return {
            "connection_id": str(profile.get("id") or ""),
            "connection_name": connection_label(profile) if profile else "",
            "health": str(health.get("status") or "UNKNOWN"),
            "summary": [
                {"name": str(m.get("name") or ""), "value": m.get("value")}
                for m in (data.get("monmap", {}).get("mons") or [])
                if isinstance(m, dict)
            ],
            "num_mon": len(data.get("monmap", {}).get("mons") or []),
            "osdmap": {
                "num_osd": data.get("osdmap", {}).get("num_osd"),
                "num_up_osd": data.get("osdmap", {}).get("num_up_osd"),
                "num_in_osd": data.get("osdmap", {}).get("num_in_osd"),
            },
            "pgmap": {
                "bytes_total": (data.get("pgmap") or {}).get("bytes_total"),
                "bytes_used": (data.get("pgmap") or {}).get("bytes_used"),
                "bytes_avail": (data.get("pgmap") or {}).get("bytes_avail"),
                "num_pgs": (data.get("pgmap") or {}).get("num_pgs"),
            },
        }

    groups = await asyncio.gather(*(probe(p, c) for p, c in pairs))
    results = [g for g in groups if g]

    return {
        "installed": len(results) > 0,
        "clusters": results,
    }
