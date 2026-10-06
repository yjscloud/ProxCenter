"""虚拟机重装系统的 HTTP 接口。

    GET  /api/vms/{node}/reinstall-templates   本节点可用的重装模板
    GET  /api/vms/{node}/{vmid}/reinstall/network   这台机器在用的网络配置（重装默认值）
    POST /api/vms/{node}/{vmid}/reinstall      提交一次重装（立即返回作业，后台执行）
    GET  /api/vms/reinstall-jobs               重装作业列表（界面据此提示成功 / 失败）

路径刻意写成 ``/{node}/reinstall-templates``（三段）而不是
``/reinstall/templates``（两段）：后者会与 vms 路由里的 ``/{node}/{vmid}``
同形，只能靠注册顺序抢，改天有人挪一下注册位置就会静默失效 —— 这个坑上一版
刚踩过一次（见 main.py 里 vmtransfer 的注释）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import reinstall, security, store
from ..vm_scope import bind_node_connection
from ..pve import ProxmoxError, get_client, requested_connection
from ..schemas import VmReinstallRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vms", tags=["vmtransfer"])

VM_VIEW = security.require_permission("vm.view")
VM_REINSTALL = security.require_permission("vm.reinstall")


def _raise(exc: ProxmoxError) -> None:
    code = exc.status_code if 400 <= exc.status_code < 600 else 500
    raise HTTPException(status_code=code, detail=exc.message)


@router.get("/{node}/reinstall-templates")
async def reinstall_templates(
    node: str,
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """可用来重装的模板（同节点的模板虚拟机）。"""
    await bind_node_connection(node)
    client = get_client()
    try:
        items = await reinstall.list_templates(client, node)
    except reinstall.ReinstallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProxmoxError as exc:
        _raise(exc)
    return {"templates": items}


@router.get("/{node}/{vmid}/reinstall/network")
async def reinstall_network(
    node: str,
    vmid: int,
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """这台机器**当前**在用的网络配置 —— 重装向导拿它做默认值。

    为什么要单独问一次：重装默认要「沿用原系统在用的地址」，而不是掉回 DHCP。
    地址写在 PVE 配置的 ``ipconfigN`` 里，只有后端读得到（列表接口不带 config）；
    让界面自己猜，结果就是装完机器换了个地址 —— 用户按记忆里的 IP 连不上，
    还得跑一趟机房。

    只读；读不到时 ``mode`` 返回空串，界面按「没配过」处理，不报错。
    """
    await bind_node_connection(node)
    client = get_client()
    try:
        cfg = await client.get(f"/nodes/{node}/qemu/{vmid}/config") or {}
    except ProxmoxError as exc:
        _raise(exc)
    result = reinstall.network_from_config(cfg)
    dns = str(cfg.get("nameserver") or "").strip()
    if dns:
        result["dns"] = dns
    return result


@router.post("/{node}/{vmid}/reinstall")
async def reinstall_vm(
    node: str,
    vmid: int,
    payload: VmReinstallRequest,
    request: Request,
    user: Dict[str, Any] = Depends(VM_REINSTALL),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    """提交一次重装，**立即返回作业**。

    这里以前是同步接口：整条流水线（复制系统盘 → 换盘 → 删旧盘 → 注入 cloud-init）
    跑完才返回，几十 GB 的盘要几分钟，界面只能卡在弹窗上 —— 关掉就不知道结果，
    刷新更是什么都看不到。现在只做「能不能开始」的校验，真正的活交给后台协程，
    进度与结果从 ``GET /vms/reinstall-jobs`` 查。

    只允许对**已关机**的虚拟机执行。旧系统盘会**连卷一起删除** ——
    上面的系统与数据不可恢复，界面上必须让用户明确知道这一点。
    """
    await bind_node_connection(node)
    client = get_client()
    try:
        job = await reinstall.start_reinstall(
            client,
            owner=str(user.get("username") or ""),
            # 连接 id 必须在**请求里**取：后台协程没有请求级 contextvar，
            # 只能靠这个 id 重新拿客户端（与导出作业同一套办法）
            connection=requested_connection() or store.get_active_connection_id() or "",
            node=node,
            vmid=vmid,
            template_node=payload.template_node,
            template_vmid=payload.template_vmid,
            target_storage=payload.target_storage,
            hostname=payload.hostname or None,
            ci_user=payload.ci_user or None,
            ci_password=payload.ci_password or None,
            ssh_keys=payload.ssh_keys or None,
            ip_mode=payload.ip_mode,
            ip=payload.ip or None,
            gateway=payload.gateway or None,
            dns=payload.dns or None,
            start=payload.start,
            wipe_data_disks=payload.wipe_data_disks,
        )
    except reinstall.ReinstallError as exc:
        await security.audit(
            request,
            user,
            "vm.reinstall",
            target=f"{node}/{vmid}",
            result="failed",
            detail=str(exc)[:300],
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProxmoxError as exc:
        await security.audit(
            request,
            user,
            "vm.reinstall",
            target=f"{node}/{vmid}",
            result="failed",
            detail=exc.message[:300],
        )
        _raise(exc)

    await security.audit(
        request,
        user,
        "vm.reinstall",
        # target 写成「来源 -> 目标」，与克隆同一种格式：详情页的「来源模板」正是
        # 从这条记录里读出来的（见 guest_created.source_of）。只写目标自己的话，
        # 重装换了模板，概览里那行还停在旧模板上。
        target=f"{payload.template_node}/{payload.template_vmid} -> {node}/{vmid}",
        detail=(
            f"已提交后台作业 {job.id}：模板 "
            f"{payload.template_node}/{payload.template_vmid} → {payload.target_storage}"
        )[:400],
    )
    # 结束时的审计在作业里写（那里才有 旧卷 → 新卷 的真实结果）
    return {"job": job.public()}


@router.get("/reinstall-jobs")
async def reinstall_jobs(
    user: Dict[str, Any] = Depends(VM_VIEW),
) -> Dict[str, Any]:
    """重装作业列表：管理员看全部，其他人只看自己提交的。

    路径写成 ``/reinstall-jobs`` 这个**两段**形状，和 ``/vms/exports`` 一样：
    再深一段就会撞上 ``/{node}/{vmid}``，只能靠注册顺序抢，改天有人挪一下注册
    位置就静默失效（这个坑见模块开头的注释）。

    界面拿它做两件事：轮询还没结束的作业、失败时把步骤日志弹出来。
    """
    is_admin = security.is_admin(user)
    username = str(user.get("username") or "")
    return {
        "jobs": [
            job.public()
            for job in reinstall.list_jobs()
            if is_admin or job.owner == username
        ]
    }
