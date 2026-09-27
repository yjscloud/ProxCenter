"""节点备注：面板侧为 PVE 节点保存的自定义说明。

PVE 本身没有「备注/别名」这类自由文本字段，所以由面板自己存一份
（settings KV），用于让运维在节点卡片上标记用途、机房、负责人等信息。
"""
from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, Depends, Request

from .. import security, store

router = APIRouter(prefix="/api", tags=["node-notes"])
NOTES_KEY = "node_notes"


async def _load() -> Dict[str, str]:
    raw = await store.get_setting(NOTES_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items()}


@router.get("/node-notes")
async def get_node_notes(
    user: Dict[str, Any] = Depends(security.require_permission("node.view")),
) -> Dict[str, Any]:
    return {"notes": await _load()}


@router.put("/node-notes")
async def save_node_notes(
    payload: Dict[str, str],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    await store.set_setting(NOTES_KEY, json.dumps(payload, ensure_ascii=False))
    await security.audit(
        request, user, "node_notes.save", target="node_notes",
        detail={"count": len(payload)},
    )
    return {"notes": payload}
