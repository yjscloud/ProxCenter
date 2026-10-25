"""节点可见性：哪些用户 / 角色能看到哪些节点。

背景：有些节点是特殊项目专用机，普通用户既不该在节点页看到，也不该在建机
向导里选到。节点本身不落库（来自 PVE 的实时接口），所以这里只维护「例外」：

* 一条 ``subject_type='*' / subject='*' / allowed=false`` 的行 = **受限节点**，
  从此对普通用户默认隐藏；
* 再给需要的人写 ``user`` 或 ``role`` 的 ``allowed=true`` 行放开；
* 判定优先级 用户行 > 角色行 > 默认行 > 无行（可见），见
  :func:`app.security.node_visibility`。

管理员与区域管理员不受节点级限制（区域内节点全部可见），所以这里改的只影响
普通用户。写操作需要 ``node.scope`` 权限并走二次确认：改错一条的后果是「某个
人突然建不了机器」，或是「特殊项目节点被放了出来」。
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import security, store
from ..schemas import NodeScopeIn

router = APIRouter(prefix="/api", tags=["node-scope"])


@router.get("/node-scope")
async def list_node_scope(
    user: Dict[str, Any] = Depends(security.require_permission("node.scope")),
) -> Dict[str, Any]:
    """全部节点授权行（含受限标记与例外）。"""
    items: List[Dict[str, Any]] = await store.list_node_scope()
    return {"items": items}


@router.put("/node-scope")
async def set_node_scope(
    payload: NodeScopeIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("node.scope")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """新增 / 覆盖一条节点授权。"""
    if payload.subject_type in ("user", "role") and not payload.subject.strip():
        raise HTTPException(status_code=400, detail="请填写要授权的用户名或角色")

    await store.save_node_scope(
        payload.connection_id,
        payload.node,
        payload.subject_type,
        payload.subject,
        payload.allowed,
    )
    await security.audit(
        request,
        user,
        "node.scope",
        target=f"{payload.connection_id or '-'}:{payload.node}",
        detail=(
            f"subject={payload.subject_type}/{payload.subject} "
            f"allowed={'yes' if payload.allowed else 'no'}"
        ),
    )
    return {
        "connection_id": payload.connection_id,
        "node": payload.node,
        "subject_type": payload.subject_type,
        "subject": payload.subject,
        "allowed": payload.allowed,
    }


@router.delete("/node-scope")
async def delete_node_scope(
    request: Request,
    connection_id: str = "",
    node: str = "",
    subject_type: str = "",
    subject: str = "",
    user: Dict[str, Any] = Depends(security.require_permission("node.scope")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """删除授权。不传 subject_type/subject 时清空该节点的全部例外（含受限标记）。"""
    if not node:
        raise HTTPException(status_code=400, detail="缺少节点名")
    removed = await store.delete_node_scope(connection_id, node, subject_type, subject)
    await security.audit(
        request,
        user,
        "node.scope.delete",
        target=f"{connection_id or '-'}:{node}",
        detail=f"subject={subject_type or '*'}/{subject or '*'} removed={removed}",
    )
    return {"removed": removed}
