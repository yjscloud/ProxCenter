"""虚拟机 / 容器的手动补充信息（面板侧存储）。

面板展示的「IP」有两种情况拿不到：

* **QEMU**：客户机没装或没开 Guest Agent，且网卡是 DHCP —— 没有任何地方能问到地址；
* **LXC**：容器没有 Agent 可问，只能读 `netN` 里的静态配置，DHCP 容器读出来就是 dhcp。

这时让运维手工填一个地址，列表与详情照常展示（并标出「手动」），
不必为了看一眼 IP 去开控制台。

存储沿用 settings KV（与 node-notes 同一套机制），
键为 ``<connection_id 或 ''>|<node>|<vmid>``，值为
``{"ip": ..., "by": <填写人>, "at": <时间戳>}``。

**这份数据只用于展示**：面板绝不会把它写回 PVE 的 ipconfig / net0 ——
「改了个显示值却动了机器网络」是这类功能最容易出的事故。

可见性：管理员看到全部条目；普通用户只看得到自己填的 —— 否则别人的
虚拟机地址会顺着这个接口漏出来（列表本身是按归属过滤的）。
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import security, store

router = APIRouter(prefix="/api", tags=["vm-meta"])
META_KEY = "vm_meta"


def _entry_key(node: str, vmid: int, connection_id: Optional[str]) -> str:
    """条目键：连接 + 节点 + vmid。

    一定要带连接：两台 PVE 上完全可能同时存在 node1/100，
    不带连接会把两台不同的机器当成同一台，IP 互相覆盖。
    """
    return f"{connection_id or ''}|{node}|{vmid}"


async def _load() -> Dict[str, Dict[str, Any]]:
    raw = await store.get_setting(META_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    result: Dict[str, Dict[str, Any]] = {}
    for key, value in data.items():
        if not isinstance(value, dict):
            continue
        ip = str(value.get("ip") or "").strip()
        if not ip:
            # 空 IP 视为没有条目，避免脏数据把「未填写」显示成空白
            continue
        result[str(key)] = {
            "ip": ip,
            "by": str(value.get("by") or ""),
            "at": int(value.get("at") or 0),
        }
    return result


class VmMetaInput(BaseModel):
    node: str
    vmid: int
    connection_id: Optional[str] = None
    # 留空 = 清除该条手动记录（回落到平台自动识别）
    ip: str = Field(default="", max_length=64)


@router.get("/vm-meta")
async def get_vm_meta(
    user: Dict[str, Any] = Depends(security.require_permission("vm.view")),
) -> Dict[str, Any]:
    items = await _load()
    if user.get("role") != "admin":
        username = str(user.get("username") or "")
        items = {k: v for k, v in items.items() if v.get("by") == username}
    return {"items": items}


@router.put("/vm-meta")
async def save_vm_meta(
    payload: VmMetaInput,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("vm.config")),
) -> Dict[str, Any]:
    node = payload.node.strip()
    ip = payload.ip.strip()
    items = await _load()
    key = _entry_key(node, payload.vmid, payload.connection_id)

    if ip:
        items[key] = {
            "ip": ip,
            "by": str(user.get("username") or ""),
            "at": int(time.time()),
        }
    else:
        items.pop(key, None)

    await store.set_setting(META_KEY, json.dumps(items, ensure_ascii=False))
    await security.audit(
        request,
        user,
        "vm_meta.save" if ip else "vm_meta.clear",
        target=f"{node}/{payload.vmid}",
        detail={"ip": ip, "connection_id": payload.connection_id or ""},
    )
    return {"key": key, "item": items.get(key)}
