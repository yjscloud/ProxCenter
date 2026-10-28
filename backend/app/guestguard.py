"""对象级鉴权：判断「这条请求能不能对**这一台**客户机做」。

为什么需要单独一层
------------------
权限点（``vm.console`` / ``vm.backup`` / ``vm.reinstall`` …）回答的是「这类操作
允不允许做」，**不回答**「这台机器是不是你的」。两者缺一不可：

* 只有权限点 → 任何拿到该权限的普通用户，把 ``vmid`` 换成别人的号段就能接管
  别人的机器（控制台、重装、整盘导出都是这条路径）；
* 只有归属校验 → 普通用户只要名下有机器，就能做管理员级操作。

以前这套判断长在 ``routers/vms.py`` 的路由级依赖里，于是**只有挂在那个 router
上的端点**享受得到。控制台、导出、重装、备份、模板转换、vm-meta、任务日志都
在别处，实际就漏成了上面第一种情况。现在把它抽到这里，任何入口——HTTP 依赖、
处理函数内部、WebSocket 握手——都调同一个函数，口径不可能再分叉。

拒绝语义
--------
一律 **404「资源不存在」**，不是 403：403 等于承认「这台存在，只是不属于你」，
拿 100~200 号段批量打一遍就能把全平台在用的 VMID 摸出来（安全审计 L-2）。
文案里也不能带 node / vmid，否则等于换个字段继续泄露存在性。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import HTTPException

from . import ownership, security, store
from .pve import requested_connection

#: 拒绝时统一的响应体。存在性泄露的最小化：既不说存在，也不说为什么。
NOT_FOUND_DETAIL = "资源不存在"

#: 会话/WS 场景下的「对象不存在」关闭码（4404 = 自定义，见 console 的握手日志）
WS_NOT_FOUND_CODE = 4404


def call_connection(explicit: Optional[str] = None) -> str:
    """本次操作作用在哪条 PVE 连接上。

    顺序与 ``pve.requested_connection()`` 一致：请求显式指定的优先，其次是中间件/
    绑定依赖放进上下文的连接，最后退回「当前生效连接」。归属 ref 的前缀就是这个
    值，取错了会把「自己名下的机器」判成别人的（或者相反，把别人的判成自己的），
    所以所有入口必须用同一个解析顺序。
    """
    text = str(explicit or "").strip()
    if text:
        return text
    return requested_connection() or str(store.get_active_connection_id() or "")


async def guest_owner(
    kind: str, node: str, vmid: int, connection: Optional[str] = None
) -> Optional[str]:
    """某台客户机的归属人；无记录返回 None（存量机器）。"""
    ref = ownership.vm_ref(call_connection(connection), node, int(vmid))
    return await ownership.get_owner_for(kind, ref)


async def require_guest_object(
    user: Dict[str, Any],
    node: Optional[str],
    vmid: Optional[int],
    kind: str,
    *,
    connection: Optional[str] = None,
) -> None:
    """要求 ``user`` 对 ``kind`` 类型、``node/vmid`` 这台客户机有合法归属。

    * 管理员：超管视角，直接放行；
    * 区域管理员：只要求连接落在其区域内（区域内**所有**机器都归他管，不逐台
      看归属）；区域外按不存在处理；
    * 其它角色：归属必须等于本人用户名。**没有归属记录的存量机器同样拒绝** ——
      严格隔离，否则「没登记的机器」就成了谁都能碰的公共资源。

    ``node`` / ``vmid`` 为空表示这条路径没有单机对象（列表类接口），直接放行。
    """
    if not node or vmid is None:
        return
    owner = security.visible_owner(user)
    if owner is None:
        return
    conn = call_connection(connection)
    if security.is_region_admin(user):
        if security.region_in_scope(user, store.connection_region(conn)):
            return
        raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
    if await guest_owner(kind, node, vmid, conn) != owner:
        raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)


async def require_guest_object_if_owned(
    user: Dict[str, Any],
    node: Optional[str],
    vmid: Optional[int],
    kind: str,
    *,
    connection: Optional[str] = None,
) -> None:
    """只拦「明确属于别人」的情况；没有归属记录时放行。

    给**正在进行中**的作业用：导入在 PVE 侧建好机器、归属还没落库的那段时间里，
    这台机器在归属表里是空的。用严格版会把这个窗口里发起人的轮询打成 404，
    等于把功能做坏。而有归属记录的机器一定是别人已经交付过的，照拦不误。
    """
    if not node or vmid is None:
        return
    owner = security.visible_owner(user)
    if owner is None:
        return
    conn = call_connection(connection)
    if security.is_region_admin(user):
        if security.region_in_scope(user, store.connection_region(conn)):
            return
        raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
    recorded = await guest_owner(kind, node, vmid, conn)
    if recorded and recorded != owner:
        raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)


async def require_import_object(
    user: Dict[str, Any],
    storage: str,
    volume: str,
    *,
    connection: Optional[str] = None,
) -> None:
    """导入文件（``import/<name>``）的归属校验。

    导入目录是所有用户共用的一格存储，文件名谁都能猜（OVA 命名很规整）。没有
    这层判断，A 用户可以把 B 刚上传的镜像 inspect 一遍（读到内存/核数/盘清单），
    甚至直接拿它建一台自己的机器 —— 原件仍在 B 名下，等 B 来导就发现被占了。
    """
    if security.is_admin(user):
        return
    ref = ownership.import_ref(call_connection(connection), storage, volume)
    try:
        recorded = await ownership.get_owner(ownership.KIND_IMPORT, ref)
    except Exception:  # noqa: BLE001 - 读不到归属时按「无主」处理，只放行管理员
        recorded = ""
    if recorded != str((user or {}).get("username") or ""):
        raise HTTPException(status_code=404, detail="导入文件不存在，可能已被删除")
