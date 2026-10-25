"""节点可见性的路由级依赖。

节点清单（``GET /api/nodes``）已经按可见性裁剪，但只裁剪清单还不够：知道节点名
的人可以直接请求 ``/api/nodes/{node}/status`` 这类接口，照样能读到被隐藏节点的
状态。这里提供一个依赖，把「路径里的节点必须对我可见」这件事补在第一个入口上。

单独成文件而不是塞进 ``security.py``：判定要用 ``pve.requested_connection()``，
而 ``pve`` 已经依赖 ``security``，放在一起会形成循环导入。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException

from . import security, store
from .pve import requested_connection


async def require_node_visible(
    user: Dict[str, Any] = Depends(security.get_current_user),
    node: Optional[str] = None,
) -> None:
    """路径参数 ``node`` 不可见时按「不存在」处理（404）。

    用 404 而不是 403：与客户机归属校验同一口径 —— 403 等于承认「这个节点存在，
    只是不给你看」，拿常见节点名（pve、pve1…）批量试一遍就能把隐藏节点摸出来。
    """
    if not node:
        return
    connection_id = requested_connection() or str(
        store.get_active_connection_id() or ""
    )
    visible = await security.node_visibility(user)
    if not visible(connection_id, node):
        raise HTTPException(status_code=404, detail="节点不存在")
