"""资源规格（套餐）：管理员定义「几核 / 几 G 内存 / 多大盘」，用户下单时挑一个。

为什么不建表：这是一份**纯配置** —— 条数在几十以内、每次整份读写、不参与任何
计算，与 :mod:`app.routers.ip_pools` 的 IP 池同一性质。用 ``settings`` 表存一份
JSON 就够，省掉一次迁移与并发写入的复杂度。规格只在创建那一刻被翻译成
``cores`` / ``memory`` / 磁盘大小，交给既有的 ``POST /api/vms`` / ``POST /api/lxc``。

一条规格：::

    {
      "id": "s-1c2g",           # 稳定标识（默认规格自带，管理员新增的自动生成）
      "name": "入门型 1C2G",
      "kind": "both",           # vm | lxc | both —— 多数规格两类通用
      "cores": 1,
      "memory": 2048,           # MB
      "disk": 100,              # GB
      "description": "轻量服务、测试环境"
    }

首访（设置里还没有这份配置）返回 :data:`DEFAULT_SPECS`，管理员保存后即以保存的
为准。**不落库**默认值：这样管理员能直接看到一组可用的示例，改动也只在点保存后
生效，不会被一次误访问写成既定配置。
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Dict, Iterable, List, Optional

from . import store

SPECS_KEY = "resource_specs"

KINDS = ("vm", "lxc", "both")

# 首访默认给的几档（与需求里举例的三档一致，外加一档 8C16G）
DEFAULT_SPECS: List[Dict[str, Any]] = [
    {
        "id": "spec-1c2g",
        "name": "入门型 1C2G",
        "kind": "both",
        "cores": 1,
        "memory": 2048,
        "disk": 100,
        "description": "轻量服务、测试环境",
    },
    {
        "id": "spec-2c4g",
        "name": "标准型 2C4G",
        "kind": "both",
        "cores": 2,
        "memory": 4096,
        "disk": 100,
        "description": "常规业务、小型数据库",
    },
    {
        "id": "spec-4c8g",
        "name": "性能型 4C8G",
        "kind": "both",
        "cores": 4,
        "memory": 8192,
        "disk": 100,
        "description": "中等并发、容器宿主",
    },
    {
        "id": "spec-8c16g",
        "name": "计算型 8C16G",
        "kind": "both",
        "cores": 8,
        "memory": 16384,
        "disk": 100,
        "description": "高负载应用、编译构建",
    },
]

# 规格的数量上限：这不是「越多越好」的列表，几百条会把人机两边的界面都拖垮
MAX_SPECS = 64
MAX_CORES = 128
# 内存下限 128 MB、上限 1 TB；磁盘下限 1 GB、上限 64 TB（与 PVE 的量级一致）
MIN_MEMORY, MAX_MEMORY = 128, 1024 * 1024
MIN_DISK, MAX_DISK = 1, 65536


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return default
    return num if low <= num <= high else default


def _clean_id(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    # 只留安全字符：id 会进 URL（/api/config/specs 的整份覆盖不按 id 取，但前端
    # 会拿它当 React key 与表单 value），别让奇怪字符混进来
    return re.sub(r"[^A-Za-z0-9_.-]", "", raw)[:64]


def normalise(raw: Any) -> List[Dict[str, Any]]:
    """把外部传进来的一坨规整成可用的规格列表。

    任何一条不合法（名字为空、核数为 0、类型不认识）就**丢那一条**，其余照收 ——
    管理员一次填错一行，不该让整份配置保存失败。条数上限 :data:`MAX_SPECS`。
    """
    items = raw if isinstance(raw, list) else []
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:64]
        if not name:
            continue
        kind = str(item.get("kind") or "both").strip().lower()
        if kind not in KINDS:
            kind = "both"
        spec_id = _clean_id(item.get("id")) or f"spec-{uuid.uuid4().hex[:8]}"
        if spec_id in seen:
            spec_id = f"spec-{uuid.uuid4().hex[:8]}"
        seen.add(spec_id)
        out.append(
            {
                "id": spec_id,
                "name": name,
                "kind": kind,
                "cores": _int(item.get("cores"), 1, 1, MAX_CORES),
                "memory": _int(item.get("memory"), 2048, MIN_MEMORY, MAX_MEMORY),
                "disk": _int(item.get("disk"), 100, MIN_DISK, MAX_DISK),
                "description": str(item.get("description") or "").strip()[:200],
            }
        )
        if len(out) >= MAX_SPECS:
            break
    return out


async def list_specs() -> List[Dict[str, Any]]:
    """全量规格；从未保存过时返回默认那几档。"""
    raw = await store.get_setting(SPECS_KEY)
    if not raw:
        return [dict(item) for item in DEFAULT_SPECS]
    try:
        return normalise(json.loads(raw))
    except ValueError:
        return [dict(item) for item in DEFAULT_SPECS]


async def save_specs(items: Any) -> List[Dict[str, Any]]:
    """整份覆盖保存（与 IP 池一样的前端契约：本地编辑完一次性提交）。"""
    cleaned = normalise(items)
    await store.set_setting(SPECS_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


async def get_spec(spec_id: str) -> Optional[Dict[str, Any]]:
    for item in await list_specs():
        if item["id"] == spec_id:
            return item
    return None


def for_kind(specs: Iterable[Dict[str, Any]], kind: str) -> List[Dict[str, Any]]:
    """只要某类可用的规格（``both`` 两类都算）。"""
    return [s for s in specs if s.get("kind") in (kind, "both")]
