"""Guest 下发配额（**全局**容量上限，不是按用户分配的）。

按 guest 类型各记一份，两份额度互相独立：

* ``vm``  —— 虚拟机额度（配置键 ``vm_quota``，沿用旧键，升级后读数不变）
* ``lxc`` —— 容器额度（配置键 ``lxc_quota``）

为什么要拆：原先只有一份总额度，且**把容器也数进去**。于是「想限制虚拟机
台数」会连带把容器一起锁死 —— 管理员填了 20，用户建了 20 个容器后连虚拟机
都建不出来，而界面上没人说得清这 20 是被谁吃掉的。拆开之后每一类各自记账，
列表页也就能各自显示「我这类还能建几台」。

其余的取舍沿用原实现：

* **未设置 = 不限制**。存量部署装上这个功能不该突然被锁死，管理员显式填数才生效。
* **管理员不受限**。配额是给「下发」行为兜底的；真到上限时把管理员一起锁住，
  只会让谁都动不了手（清理、扩容都需要管理员）。
* **计数口径含模板**。模板在 PVE 里同样是一台机器，占 VMID 与存储；
  算进去才不会出现「账面上没超、实际堆了一堆」。
* **计数失败时放行但如实上报**。配额是容量约束而非安全边界：某条 PVE 连不上
  时宁可放行并提示，也不要因为一次网络抖动把整个创建流程堵死。
  唯一的例外是 ``quota == 0`` —— 那时无论计数成功与否都直接拦下，
  因为「管理员没开放额度」这件事与现有台数无关。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException, Request

from . import security, store
from .pve import ProxmoxError, all_connection_clients, get_client

logger = logging.getLogger(__name__)

# 两类 guest：虚拟机与容器，各有一份额度与计数口径
GUEST_KINDS: Tuple[str, ...] = ("vm", "lxc")
QUOTA_KEYS: Dict[str, str] = {"vm": "vm_quota", "lxc": "lxc_quota"}
KIND_LABEL: Dict[str, str] = {"vm": "虚拟机", "lxc": "容器"}
# cluster/resources 里对应的 type（两者都算「一台机器」，但这里分账统计）
RESOURCE_TYPES: Dict[str, Tuple[str, ...]] = {"vm": ("qemu",), "lxc": ("lxc",)}


def normalise_kind(kind: Optional[str]) -> str:
    """把外部传入的 kind 收进已知取值；不认识的一律当虚拟机。

    宁可当成虚拟机（旧行为）也不要抛 400：这个参数是从 URL 上来的，
    一个拼错的 kind 不该让配额读数整体报错。
    """
    text = str(kind or "").strip().lower()
    return text if text in QUOTA_KEYS else "vm"


def _key(kind: str) -> str:
    return QUOTA_KEYS[normalise_kind(kind)]


def label(kind: str) -> str:
    return KIND_LABEL[normalise_kind(kind)]


async def get_quota(kind: str = "vm") -> Optional[int]:
    """该类 guest 的总配额；``None`` 表示不限制。"""
    raw = await store.get_setting(_key(kind))
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError):
        # 配置坏了就当没配：绝不让一个坏值把创建流程卡死
        logger.warning("%s 配置损坏，已按「不限制」处理：%r", _key(kind), raw)
        return None
    return value if value >= 0 else 0


async def set_quota(kind: str, value: Optional[int]) -> Optional[int]:
    """设置该类配额；传 ``None`` 表示「不限制」（删掉这条配置）。"""
    if value is None:
        await store.delete_setting(_key(kind))
        return None
    if value < 0:
        raise ValueError("配额不能为负数")
    await store.set_setting(_key(kind), str(int(value)))
    return int(value)


async def count_guests(kind: str = "vm") -> Tuple[int, Optional[str]]:
    """统计现有该类 guest 的总数。返回 ``(台数, 错误信息)``。

    口径与 ``GET /vms?type=all`` 一致（都用 ``cluster/resources``），
    这样用户看到的台数和配额算的台数不会打架。模板一并计入 ——
    它在 PVE 里同样占一个 VMID 与一份存储。
    """
    wanted = RESOURCE_TYPES[normalise_kind(kind)]
    targets = list(all_connection_clients()) or [(None, get_client())]
    total = 0
    error: Optional[str] = None

    for _profile, client in targets:
        try:
            resources = await client.cluster_resources("vm")
        except ProxmoxError as exc:
            # 单条连接失败只记下来继续算其余的，总数会偏小但不会整个报错
            error = error or str(exc.message)
            continue
        total += sum(
            1 for item in (resources or []) if item.get("type") in wanted
        )

    return total, error


async def usage(user: Dict[str, Any], kind: str = "vm") -> Dict[str, Any]:
    """给前端的读数：配额 / 已用 / 可下发 / 当前用户能不能建。"""
    name = normalise_kind(kind)
    quota = await get_quota(name)
    used, error = await count_guests(name)
    return {
        "kind": name,
        "label": label(name),
        "quota": quota,
        "used": used,
        # None = 不限制；否则下限截到 0，避免出现负数
        "remaining": None if quota is None else max(0, quota - used),
        "limited": quota is not None,
        "can_create": _can_create(security.is_admin(user), quota, used),
        "count_error": error,
    }


def _can_create(is_admin: bool, quota: Optional[int], used: int) -> bool:
    if is_admin:
        return True
    if quota is None:
        return True
    return quota - used > 0


async def enforce_for_create(
    user: Dict[str, Any], request: Request, kind: str = "vm"
) -> None:
    """创建该类 guest 前调用；普通用户超限时抛 403。

    只在「确实要新增一台」的入口调用（``POST /vms`` / ``POST /lxc`` 与单台克隆）。
    """
    name = normalise_kind(kind)
    if security.is_admin(user):
        return

    quota = await get_quota(name)
    if quota is None:
        return

    used, _ = await count_guests(name)
    if quota - used > 0:
        return

    noun = label(name)
    await security.audit(
        request,
        user,
        f"{'lxc' if name == 'lxc' else 'vm'}.create",
        result="denied",
        detail={"reason": "quota", "kind": name, "quota": quota, "used": used},
    )
    if quota <= 0:
        raise HTTPException(
            status_code=403, detail=f"管理员当前没有开放{noun}下发额度"
        )
    raise HTTPException(
        status_code=403,
        detail=f"可下发{noun}数量已用尽（上限 {quota} 台，当前 {used} 台），请联系管理员",
    )
