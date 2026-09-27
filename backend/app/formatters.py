"""Shared normalisation helpers for PVE payloads."""
from __future__ import annotations

import base64
import re
import socket
from typing import Any, Dict, List, Optional


def short_hostname(value: Optional[str] = None) -> str:
    """取主机名的第一段：``kvm-web.114.114.114.114`` → ``kvm-web``。

    不少 VPS / 云主机的内核主机名被设成「名字.公网 IP」（有的干脆是
    ``名字.域名``）。原样显示既长，又很容易被读成「这台机器叫 kvm-web.114.114.114.114」
    或误以为是访问地址 —— 面板上凡是展示主机名的地方（SSH 安全 / 安全基线 /
    端口与进程的本机作用域）统一只显示短名。

    只做展示层收敛：``host_id`` 之类的内部标识仍然按原值走，不受影响。
    """
    raw = value if value is not None else socket.gethostname()
    raw = (raw or "").strip()
    if not raw:
        return ""
    return raw.split(".")[0] or raw

# 纯 base64 的样子。用来判断 Guest Agent 的输出到底编没编过码。
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/\r\n]+={0,2}$")

# df 输出里这些不是磁盘：内存文件系统与只读叠加层。混进「磁盘用量」只会误导。
_PSEUDO_FILESYSTEMS = {
    "devtmpfs",
    "tmpfs",
    "devfs",
    "overlay",
    "squashfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "none",
    "udev",
    "ramfs",
    "rootfs",
}


def decode_agent_output(value: Any) -> str:
    """解出 Guest Agent 命令的输出。

    PVE 的文档说 ``exec-status.out-data`` 是 base64，但**实测 8.4 返回的是明文**
    （直接按 base64 解会抛 ``Invalid base64-encoded string``）。不同版本 / 不同
    接口的行为并不统一，所以两种都认，免得换个 PVE 版本就解析失败。
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    text = str(value)
    if not text:
        return ""
    # 只有「长度是 4 的倍数 + 全是 base64 字符 + 解出来是合法 UTF-8」才当编码过。
    # 三个条件缺一不可：像 "abcd" 这种明文恰好也能被 base64 解开，但结果是
    # 乱码字节，严格 UTF-8 解码会失败，于是正确地回落到明文。
    if len(text) % 4 == 0 and _BASE64_RE.match(text):
        try:
            return base64.b64decode(text).decode("utf-8")
        except Exception:  # noqa: BLE001 - 解不开或不是文本就按明文处理
            return text
    return text


def parse_df_output(text: str) -> List[Dict[str, Any]]:
    """解析 ``df -P -B1`` 的输出（POSIX 单行格式，单位字节）。

    这是**唯一**能拿到客户机真实磁盘用量的途径：PVE 对 QEMU 虚拟机的
    ``status.disk`` 恒为 0，而 guest-get-fsinfo 的容量字段要
    qemu-guest-agent ≥ 5.2 才有（CentOS 7 自带 2.12，拿不到）。

    返回 ``[{filesystem, mountpoint, total_bytes, used_bytes, available_bytes,
    percent}]``；内存文件系统（tmpfs 等）会被剔除，它们不是磁盘。
    """
    rows: List[Dict[str, Any]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("Filesystem"):
            continue
        # 挂载点本身可能含空格，所以只切前 5 段
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        name, blocks, used, avail, capacity, mountpoint = parts
        if name in _PSEUDO_FILESYSTEMS:
            continue
        if not blocks.isdigit():
            continue
        total = int(blocks)
        if total <= 0:
            continue
        used_bytes = int(used) if used.isdigit() else 0
        rows.append(
            {
                "filesystem": name,
                "mountpoint": mountpoint,
                "total_bytes": total,
                "used_bytes": used_bytes,
                "available_bytes": int(avail) if avail.isdigit() else 0,
                "percent": round(used_bytes / total * 100, 1),
            }
        )
    # 挂载点短的排前面（/ 最先），读起来顺
    rows.sort(key=lambda r: (r["mountpoint"].count("/"), r["mountpoint"]))
    return rows


def normalize_storage(storage: Dict[str, Any], node: Optional[str] = None) -> Dict[str, Any]:
    """Give storage records a consistent shape across the two PVE endpoints.

    ``/cluster/storage`` and ``/nodes/{node}/storage`` differ in which fields
    they populate, so unify them here:

    * ``/nodes/{node}/storage``  → ``total`` / ``used`` / ``avail``
    * ``/cluster/resources``     → ``maxdisk`` / ``disk``（没有 used 字段）

    ``disk`` 只是最后兜底，避免集群总览里的存储使用率被算成 0。
    """
    total = _first_number(storage, "total", "maxdisk", "total_bytes")
    used = _first_number(storage, "used", "used_bytes", "disk")
    avail = _first_number(storage, "avail", "avail_bytes")

    if used is None and total is not None and avail is not None:
        used = total - avail
    if avail is None and total is not None and used is not None:
        avail = total - used

    share = None
    if total and used is not None and total > 0:
        share = round(used / total, 4)

    return {
        "storage": storage.get("storage"),
        "type": storage.get("type", ""),
        "content": storage.get("content", ""),
        "active": pve_flag(storage.get("active", 1), 1) == 1,
        "enabled": pve_flag(storage.get("enabled", 1), 1) == 1,
        "shared": pve_flag(storage.get("shared", 0)) == 1,
        "total": total,
        "used": used,
        "avail": avail,
        "usage": share,
        "node": storage.get("node") or node or "",
        "pool": storage.get("pool", ""),
        "path": storage.get("path", ""),
        # 多 PVE 聚合时，两台主机上的同名存储是各自独立的两份容量，
        # 前端必须靠来源标识区分与去重，不能只认名字。
        "connection_id": storage.get("connection_id", ""),
        "connection_name": storage.get("connection_name", ""),
    }


def pve_flag(value: Any, default: int = 0) -> int:
    """把 PVE 的「布尔」字段解析成 0 / 1，任何形态都不抛异常。

    PVE 同一个字段在不同版本 / 写法下形态不一，直接 ``int()`` 会让整个接口
    500（实测：某台 VM 的 ``agent`` 是 ``enabled=1``，虚拟机详情直接打不开）：

    * ``0`` / ``1``（整数或字符串）
    * ``"enabled=1,fstrim_cloned_disks=1"`` —— QEMU ``agent`` 的 k=v 写法
    * 空值 / 不认识的写法 → 返回 ``default``

    对合法的数值输入，行为与 ``int(value) == 1`` 完全一致（只有 1 算真），
    因此替换旧代码不会改变既有语义。
    """
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return 1 if value == 1 else 0

    text = str(value).strip().lower()
    if not text:
        return default
    if "=" in text:
        # k=v 形式：只看 enabled= 那一段，找不到就按默认值处理
        for part in text.split(","):
            key, sep, raw = part.partition("=")
            if sep and key.strip() == "enabled":
                text = raw.strip()
                break
        else:
            return default

    if text in ("1", "on", "yes", "true"):
        return 1
    if text in ("0", "off", "no", "false"):
        return 0
    return default


def normalize_agent_interfaces(payload: Any) -> List[Dict[str, Any]]:
    """把 Guest Agent 的网卡信息拍平成前端约定的形状。

    PVE ``agent/network-get-interfaces`` 返回的是
    ``{"result": [{"name": ..., "hardware-address": ..., "ip-addresses": [...]}]}``
    —— 外面套了一层 ``result``，字段还是连字符命名。前端用的是
    ``agent_interfaces[].hardware_address / .ip_addresses[].ip_address``，
    这里一次性转换到位，前端不必再兼容两套命名。
    """
    if isinstance(payload, dict):
        items = payload.get("result")
    elif isinstance(payload, list):
        items = payload
    else:
        items = None
    if not isinstance(items, list):
        return []

    interfaces: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        addresses: List[Dict[str, Any]] = []
        for addr in item.get("ip-addresses") or []:
            if not isinstance(addr, dict):
                continue
            addresses.append(
                {
                    "ip_address": addr.get("ip-address") or addr.get("ip_address") or "",
                    "prefix": addr.get("prefix"),
                    "ip_address_type": (
                        addr.get("ip-address-type") or addr.get("ip_address_type") or ""
                    ),
                }
            )
        interfaces.append(
            {
                "name": item.get("name") or "",
                "hardware_address": (
                    item.get("hardware-address") or item.get("hardware_address") or ""
                ),
                "ip_addresses": addresses,
            }
        )
    return interfaces


def _first_number(source: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        value = source.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def normalize_task(task: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise a task record from either the per-node or cluster endpoint."""
    return {
        "upid": task.get("upid"),
        "node": task.get("node"),
        "type": task.get("type", ""),
        "id": task.get("id") or task.get("id_raw"),
        "user": task.get("user", ""),
        "status": task.get("status", "unknown"),
        "exitstatus": task.get("exitstatus"),
        "starttime": task.get("starttime"),
        "endtime": task.get("endtime"),
        "pid": task.get("pid"),
        "running": task.get("status") == "running",
    }
