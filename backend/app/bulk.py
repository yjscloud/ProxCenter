"""虚拟机 / 容器的批量操作编排。

为什么单独一个模块，而不是在 ``routers/vms.py`` 里加个循环：

* **逐台独立成败**。批量操作最怕「第 3 台失败了，前 2 台已改、后 17 台没动，
  前端只看到一个 500」。这里每台都独立捕获异常，最终一次返回完整的
  ``results`` —— 与防火墙模板下发（``FirewallApplyResult``）同一套回报形状，
  前端能直接照着渲染。
* **每台机器的连接可能不同**。面板支持多台 PVE，一次批量完全可能横跨两台主机。
  所以连接是**按目标解析**的（``vm_scope.resolve_vm_connection``），不是整个
  请求绑一条；并发下也不能用 ContextVar 切换（见 ``pve.client_for_connection``）。
* **权限与归属逐台校验**。批量接口拿不到路径参数，路由级依赖（``require_vm_access``）
  在这里不生效，因此显式复刻一遍同样的判定，避免「批量 = 绕过归属隔离」。

一个刻意的设计：**不整批回滚**。已经关掉的机器不会因为第 N 台失败就再开机 ——
电源 / 标签这类操作幂等或易改，回滚反而更危险（把刚关的机器又拉起来）。
删除是唯一不可逆的，靠「运行中拒绝」+ 二次确认兜底。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request

from . import ownership, security, vm_scope
from .pve import (
    ProxmoxError,
    client_for_connection,
    parallel,
    requested_connection,
)
from .schemas import BulkParams, BulkRequest, BulkTarget

logger = logging.getLogger(__name__)

# 一次批量最多并发多少台。太大会把 PVE 的任务队列打满（它自己的 worker 有限），
# 表现为后面的请求超时；太小则 100 台要等很久。6 是与只读聚合一致的取值。
CONCURRENCY = 6

POWER_ACTIONS = ("start", "stop", "shutdown", "reboot", "suspend", "resume")

# action -> 需要的权限
ACTION_PERMISSION: Dict[str, str] = {
    **{action: "vm.power" for action in POWER_ACTIONS},
    "delete": "vm.delete",
    "tag": "vm.config",
    "migrate": "vm.config",
    "balloon": "vm.config",
    "snapshot": "vm.snapshot",
}

# 需要二次确认（重输密码）的动作 —— 只放不可逆 / 高影响的
STEP_UP_ACTIONS = frozenset({"delete"})

ACTION_LABELS: Dict[str, str] = {
    "start": "开机",
    "stop": "停止",
    "shutdown": "关机",
    "reboot": "重启",
    "suspend": "挂起",
    "resume": "恢复",
    "delete": "删除",
    "tag": "打标签",
    "migrate": "迁移",
    "balloon": "设置内存气球",
    "snapshot": "创建快照",
}


def _op_connection() -> str:
    """同 ``routers.vms._op_connection``：显式指定优先，否则当前连接。"""
    from . import store

    return requested_connection() or str(store.get_active_connection_id() or "")


def _task_of(result: Any) -> Optional[str]:
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        value = result.get("task")
        return str(value) if value else None
    return None


def _split_tags(raw: Optional[str]) -> List[str]:
    """与前端 ``parseTags`` 同一口径：分号或逗号分隔。"""
    if not raw:
        return []
    return [t.strip() for t in raw.replace(",", ";").split(";") if t.strip()]


def _merge_tags(current: Optional[str], incoming: List[str], mode: str) -> str:
    if mode == "append":
        merged = _split_tags(current)
        for tag in incoming:
            if tag not in merged:
                merged.append(tag)
    else:
        merged = incoming
    return ";".join(merged)


def validate_action(action: str, params: BulkParams) -> None:
    """动作合法性 + 该动作必填参数。"""
    if action not in ACTION_PERMISSION:
        raise HTTPException(
            status_code=400,
            detail=(
                f"不支持的批量操作：{action}。"
                f"可用操作：{', '.join(sorted(ACTION_PERMISSION))}"
            ),
        )

    if action == "migrate" and not (params.target_node or "").strip():
        raise HTTPException(status_code=400, detail="批量迁移需要指定目标节点")

    if action == "snapshot":
        name = (params.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="批量创建快照需要指定快照名称")
        # 与单机新建快照同一套校验，避免造出 PVE 不认的名字
        from .schemas import SnapshotCreate

        SnapshotCreate(name=name, description=params.description)

    if action == "tag" and params.tags is None:
        raise HTTPException(status_code=400, detail="批量打标签需要填写标签内容")

    if action == "tag" and params.tag_mode not in ("replace", "append"):
        raise HTTPException(status_code=400, detail="标签写入方式只能是 replace 或 append")

    if action == "balloon":
        if params.balloon is None:
            raise HTTPException(status_code=400, detail="批量设置内存气球需要填写保留量（MB）")
        # 0 是有效值（关掉气球驱动）;负数 PVE 会拒，早点拦下来给一条清楚的话
        if params.balloon < 0:
            raise HTTPException(status_code=400, detail="内存气球不能小于 0")
        if params.balloon > 0 and params.balloon < 128:
            raise HTTPException(
                status_code=400, detail="内存气球至少 128 MB，或填 0 关闭气球驱动"
            )


async def _resolve(conn_id_hint: str, node: str, vmid: int, owner: Optional[str]) -> str:
    """目标机器所在的连接 id。显式指定（请求头）优先，其次按归属表 / 探测。"""
    if conn_id_hint:
        return conn_id_hint
    resolved = await vm_scope.resolve_vm_connection(node, vmid, owner)
    return resolved or _op_connection()


async def _ensure_access(user: Dict[str, Any], node: str, vmid: int, conn_id: str) -> None:
    """复刻 ``routers.vms.require_vm_access``：没有路径参数，只能显式判定。"""
    owner = security.visible_owner(user)
    if owner is None:
        return
    ref = ownership.vm_ref(conn_id, node, vmid)
    if await ownership.get_owner(ownership.KIND_VM, ref) != owner:
        raise PermissionError(f"{node}/{vmid} 不属于当前用户，无权操作")


async def _detect_type(client: Any, node: str, vmid: int) -> str:
    """目标没带 type 时探测一次；VMID 在集群内唯一，两条路径只会命中一条。"""
    for family in ("qemu", "lxc"):
        try:
            await client.get(f"/nodes/{node}/{family}/{vmid}/status/current")
            return family
        except ProxmoxError:
            continue
    raise ProxmoxError(f"在节点 {node} 上找不到 {vmid}（虚拟机和容器都没有）", 404)


async def _run_one(
    request: Request,
    user: Dict[str, Any],
    action: str,
    target: BulkTarget,
    params: BulkParams,
) -> Dict[str, Any]:
    """单台执行。永远返回结果字典，不向外抛（外层还有 parallel 兜底）。"""
    node, vmid = target.node, int(target.vmid)
    item: Dict[str, Any] = {
        "node": node,
        "vmid": vmid,
        "name": target.name or "",
        "type": target.type or "",
        "ok": False,
        "task": None,
        "error": None,
    }

    try:
        owner = security.visible_owner(user)
        conn_id = await _resolve(requested_connection(), node, vmid, owner)
        await _ensure_access(user, node, vmid, conn_id)
        client = client_for_connection(conn_id)

        gtype = target.type if target.type in ("qemu", "lxc") else await _detect_type(
            client, node, vmid
        )
        item["type"] = gtype

        result: Any = None
        if action in POWER_ACTIONS:
            power = client.qemu_power if gtype == "qemu" else client.lxc_power
            result = await power(
                node,
                vmid,
                action,
                timeout=params.timeout,
                force_stop=params.force_stop,
            )

        elif action == "delete":
            status_getter = client.qemu_status if gtype == "qemu" else client.lxc_status
            try:
                status = await status_getter(node, vmid)
            except ProxmoxError:
                status = {}  # 探测失败就让删除自己决定，别替 PVE 报错
            if status.get("status") == "running":
                raise ProxmoxError(f"{vmid} 正在运行，请先关机后再删除", 409)
            destroy = client.qemu_destroy if gtype == "qemu" else client.lxc_destroy
            result = await destroy(node, vmid, purge=params.purge)

        elif action == "tag":
            config_getter = client.qemu_config if gtype == "qemu" else client.lxc_config
            setter = client.qemu_set_config if gtype == "qemu" else client.lxc_set_config
            current = await config_getter(node, vmid)
            merged = _merge_tags(
                str(current.get("tags") or ""), _split_tags(params.tags), params.tag_mode
            )
            result = await setter(node, vmid, {"tags": merged})

        elif action == "balloon":
            # 容器没有内存气球（LXC 的内存是硬上限，PVE 也没有 balloon 这个键）。
            # 逐台报错而不是静默跳过 —— 用户打了勾的机器必须有个交代。
            if gtype != "qemu":
                raise ProxmoxError(f"{vmid} 是容器，容器不支持内存气球", 400)
            result = await client.qemu_set_config(node, vmid, {"balloon": params.balloon})

        elif action == "migrate":
            target_node = (params.target_node or "").strip()
            if gtype == "qemu":
                result = await client.qemu_migrate(
                    node, vmid, target_node, online=params.online
                )
            else:
                result = await client.lxc_migrate(
                    node, vmid, target_node, online=params.online
                )

        elif action == "snapshot":
            name = (params.name or "").strip()
            if gtype == "qemu":
                result = await client.qemu_snapshot_create(
                    node, vmid, name, params.description, vmstate=params.vmstate
                )
            else:
                # 容器快照没有内存状态，vmstate 直接忽略
                result = await client.lxc_snapshot_create(
                    node, vmid, name, params.description
                )

        item["task"] = _task_of(result)
        item["ok"] = True
        await security.audit(
            request, user, f"vm.{action}", target=f"{node}/{vmid}",
            detail={"bulk": True, "type": gtype},
        )

    except ProxmoxError as exc:
        item["error"] = exc.message
        await security.audit(
            request, user, f"vm.{action}", target=f"{node}/{vmid}",
            result="failed", detail={"bulk": True, "error": exc.message},
        )
    except PermissionError as exc:
        item["error"] = str(exc)
        await security.audit(
            request, user, f"vm.{action}", target=f"{node}/{vmid}",
            result="denied", detail={"bulk": True, "error": str(exc)},
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 单台异常不能拖垮整批
        logger.warning("批量操作 %s 在 %s/%s 失败", action, node, vmid, exc_info=True)
        item["error"] = str(exc) or exc.__class__.__name__
        await security.audit(
            request, user, f"vm.{action}", target=f"{node}/{vmid}",
            result="failed", detail={"bulk": True, "error": item["error"]},
        )

    return item


async def run_bulk(
    request: Request,
    user: Dict[str, Any],
    payload: BulkRequest,
) -> Dict[str, Any]:
    """对一批机器执行同一动作，逐台回报结果。

    返回 ``{action, total, ok, failed, results[]}``。HTTP 200 只代表请求合法，
    具体成败看 ``results[i].ok`` —— 前端据此渲染「成功 N 台，失败 M 台」的清单。
    """
    action = payload.action.strip()
    validate_action(action, payload.params)

    permission = ACTION_PERMISSION[action]
    if not security.has_user_permission(user, permission):
        raise HTTPException(
            status_code=403, detail=f"没有执行「{ACTION_LABELS.get(action, action)}」的权限"
        )

    # 不可逆动作整批要求一次二次确认，而不是每台弹一次
    if action in STEP_UP_ACTIONS:
        security.check_step_up(request, user)

    raw = await parallel(
        [
            _run_one(request, user, action, target, payload.params)
            for target in payload.targets
        ],
        limit=CONCURRENCY,
    )

    results: List[Dict[str, Any]] = []
    for target, item in zip(payload.targets, raw):
        if isinstance(item, BaseException):
            # parallel 的兜底：理论上到不了这里（_run_one 自己吞异常）
            results.append(
                {
                    "node": target.node,
                    "vmid": int(target.vmid),
                    "name": target.name or "",
                    "type": target.type or "",
                    "ok": False,
                    "task": None,
                    "error": str(item),
                }
            )
            continue
        results.append(item)

    ok_count = sum(1 for r in results if r["ok"])
    return {
        "action": action,
        "total": len(results),
        "ok": ok_count,
        "failed": len(results) - ok_count,
        "results": results,
    }
