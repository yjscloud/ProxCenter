"""应急响应：虚拟机一键隔离（取证快照 + 断网 + 关机）。

## 处置顺序是刻意的

**先取证，再处置**：``快照 → 断网 → 关机``。反过来的话，一旦机器已关机，内存里的
证据就没了；而快照是 **崩溃一致性** 的磁盘副本，不具备内存取证能力 —— 这两点都在
返回结果与页面上如实说明，不假装它能提取内存镜像。

## 断网只切虚拟网卡这一层

``link_down=1`` 作用于 PVE 的 ``net*`` 设备：**PCI passthrough / SR-IOV 网卡不受
它控制**，多网卡需要逐张设置（本模块会逐张处理），而且它只断网络、不停机。所以
返回结果里会明确写清「切断了几张网卡」，而不是笼统地说「已隔离」。

## 其它几件顺手做掉的事

* ``protection=1``：把 VM 也保护起来，避免慌乱中把它误删 —— 证据就没了；
* ``link_down`` 是在**原始 net 串**上增删一个字段，其余属性（bridge/tag/mac/rate）
  原样保留（PVE 对 ``netX`` 是整串替换，直接覆盖会把别的属性抹掉）；
* 释放（``release``）做的是逆操作：去掉 ``link_down``、按需解除保护、按需开机。
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, List, Optional

from . import i18n
from .pve import ProxmoxError, get_client

logger = logging.getLogger(__name__)

# 取证快照的命名前缀：便于在快照列表里把「应急取证」与普通快照区分开
EVIDENCE_PREFIX = "quarantine-"
NET_KEY_RE = re.compile(r"^net(\d+)$")
POWER_ACTIONS = ("none", "shutdown", "stop")


def set_link_down(raw: str, down: bool) -> str:
    """在 net 原始串上增删 ``link_down``，其余属性原样保留。

    PVE 对 ``netX`` 是**整串替换**：直接写 ``virtio=...,link_down=1`` 会把 bridge /
    tag / macaddr / firewall 全抹掉。所以这里只动需要动的那一段。
    """
    segments = [item.strip() for item in (raw or "").split(",") if item.strip()]
    kept = [item for item in segments if not item.startswith("link_down=")]
    if down:
        kept.append("link_down=1")
    return ",".join(kept)


def is_link_down(raw: str) -> bool:
    return any(
        item.strip().startswith("link_down=")
        and item.strip().partition("=")[2].strip() not in ("0", "")
        for item in (raw or "").split(",")
    )


def net_keys(config: Dict[str, Any]) -> List[str]:
    keys = [key for key in (config or {}) if isinstance(key, str) and NET_KEY_RE.match(key)]
    return sorted(keys, key=lambda key: int(NET_KEY_RE.match(key).group(1)))


def evidence_snapshot_name(now: Optional[float] = None) -> str:
    """PVE 快照名只允许 ``[A-Za-z0-9_-]``，所以用 ``-`` 而不是 ``:``。"""
    return EVIDENCE_PREFIX + time.strftime("%Y%m%d-%H%M%S", time.localtime(now or time.time()))


def _step(name: str, ok: bool, detail: str, **extra: Any) -> Dict[str, Any]:
    return {"step": name, "ok": ok, "detail": detail, **extra}


async def _set_link_down(node: str, vmid: int, key: str, raw: str, down: bool) -> Dict[str, Any]:
    client = get_client()
    await client.qemu_set_config(node, vmid, {key: set_link_down(raw, down)})
    return {"interface": key, "value": set_link_down(raw, down)}


async def quarantine(
    node: str,
    vmid: int,
    *,
    take_snapshot: bool = True,
    cut_network: bool = True,
    power_action: str = "shutdown",
    protect: bool = True,
    note: str = "",
    actor: str = "",
) -> Dict[str, Any]:
    """一键隔离一台可疑虚拟机。

    每一步都独立执行并单独回报：取证快照失败（存储满、有锁）不应阻止把网络切掉，
    但结果里会明确标红，避免用户以为「已经取证好了」。
    """
    action = power_action if power_action in POWER_ACTIONS else "shutdown"
    client = get_client()
    steps: List[Dict[str, Any]] = []
    started = time.time()

    # PVE 的 net 配置在 config 里；先读一次，后面断网与状态都用它
    config: Dict[str, Any] = {}
    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        raise RuntimeError(i18n.t("isolation.detail.readConfigFail", error=exc)) from exc

    # ---- 1. 取证快照（务必在处置之前）----
    snapshot_name = ""
    if take_snapshot:
        snapshot_name = evidence_snapshot_name(started)
        description = (
            f"应急响应取证快照 · {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(started))}"
            + (f" · 操作人 {actor}" if actor else "")
            + (f" · {note}" if note else "")
            + " · 由面板在隔离前自动创建"
        )
        try:
            await client.qemu_snapshot_create(node, vmid, snapshot_name, description)
            steps.append(
                _step(
                    "snapshot",
                    True,
                    i18n.t("isolation.detail.snapshotOk", name=snapshot_name),
                    snapshot=snapshot_name,
                )
            )
        except ProxmoxError as exc:
            steps.append(
                _step(
                    "snapshot",
                    False,
                    i18n.t("isolation.detail.snapshotFail", error=exc),
                )
            )

    # ---- 2. 断网：逐张虚拟网卡置 link_down ----
    cut: List[str] = []
    if cut_network:
        keys = net_keys(config)
        failures: List[str] = []
        for key in keys:
            raw = str(config.get(key) or "")
            if is_link_down(raw):
                cut.append(key)
                continue
            try:
                await _set_link_down(node, vmid, key, raw, True)
                cut.append(key)
            except ProxmoxError as exc:
                failures.append(i18n.t("isolation.failed_item", key=key, error=exc))
        if not keys:
            steps.append(
                _step("network", False, i18n.t("isolation.detail.noNics"))
            )
        elif failures:
            steps.append(
                _step(
                    "network",
                    False,
                    i18n.t(
                        "isolation.detail.networkPartial",
                        count=len(cut),
                        failures=i18n.t("isolation.separator").join(failures),
                    ),
                    interfaces=cut,
                )
            )
        else:
            steps.append(
                _step(
                    "network",
                    True,
                    i18n.t(
                        "isolation.detail.networkOk",
                        count=len(cut),
                        list=i18n.t("isolation.separator").join(cut),
                    ),
                    interfaces=cut,
                )
            )

    # ---- 3. 电源动作 ----
    if action != "none":
        try:
            await client.qemu_power(node, vmid, action)
            steps.append(
                _step(
                    "power",
                    True,
                    i18n.t(
                        "isolation.detail.shutdown"
                        if action == "shutdown"
                        else "isolation.detail.stop"
                    ),
                    action=action,
                )
            )
        except ProxmoxError as exc:
            steps.append(
                _step(
                    "power",
                    False,
                    i18n.t("isolation.detail.powerFail", error=exc),
                    action=action,
                )
            )

    # ---- 4. 顺手保护：防止慌乱中把证据 VM 删掉 ----
    if protect:
        try:
            await client.qemu_set_config(node, vmid, {"protection": 1})
            steps.append(
                _step("protect", True, i18n.t("isolation.detail.protectOk"))
            )
        except ProxmoxError as exc:
            steps.append(
                _step(
                    "protect",
                    False,
                    i18n.t("isolation.detail.protectFail", error=exc),
                )
            )

    ok = all(item["ok"] for item in steps)
    return {
        "node": node,
        "vmid": vmid,
        "ok": ok,
        "steps": steps,
        "snapshot": snapshot_name,
        "interfaces": cut,
        "power_action": action,
        "note": note,
        "started_at": int(started),
        "summary": _summary(ok, steps),
        "caveats": i18n.tr_all(_CAVEATS),
    }


async def release(
    node: str,
    vmid: int,
    *,
    restore_network: bool = True,
    unprotect: bool = True,
    power_on: bool = False,
    note: str = "",
) -> Dict[str, Any]:
    """解除隔离：恢复网卡 → 解除保护 →（可选）开机。"""
    client = get_client()
    steps: List[Dict[str, Any]] = []

    try:
        config = await client.qemu_config(node, vmid) or {}
    except ProxmoxError as exc:
        raise RuntimeError(i18n.t("isolation.detail.readConfigFail", error=exc)) from exc

    restored: List[str] = []
    if restore_network:
        failures: List[str] = []
        for key in net_keys(config):
            raw = str(config.get(key) or "")
            if not is_link_down(raw):
                continue
            try:
                await _set_link_down(node, vmid, key, raw, False)
                restored.append(key)
            except ProxmoxError as exc:
                failures.append(i18n.t("isolation.failed_item", key=key, error=exc))
        if failures:
            steps.append(
                _step(
                    "network",
                    False,
                    i18n.t(
                        "isolation.detail.restoreFail",
                        failures=i18n.t("isolation.separator").join(failures),
                    ),
                )
            )
        else:
            steps.append(
                _step(
                    "network",
                    True,
                    i18n.t(
                        "isolation.detail.restoreOk",
                        count=len(restored),
                        list=(
                            i18n.t(
                                "isolation.detail.restoreList",
                                list=i18n.t("isolation.separator").join(restored),
                            )
                            if restored
                            else i18n.t("isolation.detail.restoreNone")
                        ),
                    ),
                )
            )

    if unprotect:
        try:
            await client.qemu_set_config(node, vmid, {"protection": 0})
            steps.append(
                _step("protect", True, i18n.t("isolation.detail.unprotectOk"))
            )
        except ProxmoxError as exc:
            steps.append(
                _step(
                    "protect",
                    False,
                    i18n.t("isolation.detail.unprotectFail", error=exc),
                )
            )

    if power_on:
        try:
            await client.qemu_power(node, vmid, "start")
            steps.append(_step("power", True, i18n.t("isolation.detail.startOk")))
        except ProxmoxError as exc:
            steps.append(
                _step("power", False, i18n.t("isolation.detail.startFail", error=exc))
            )

    return {
        "node": node,
        "vmid": vmid,
        "ok": all(item["ok"] for item in steps),
        "steps": steps,
        "note": note,
        "summary": _summary(all(item["ok"] for item in steps), steps),
    }


async def status(node: str, vmid: int) -> Dict[str, Any]:
    """当前隔离状态：哪些网卡被断、是否开启保护、有哪些取证快照。"""
    client = get_client()
    config = await client.qemu_config(node, vmid) or {}
    networks = [
        {
            "interface": key,
            "value": str(config.get(key) or ""),
            "link_down": is_link_down(str(config.get(key) or "")),
        }
        for key in net_keys(config)
    ]

    evidence: List[Dict[str, Any]] = []
    try:
        snapshots = await client.qemu_snapshots(node, vmid)
    except ProxmoxError:
        snapshots = []
    for item in snapshots:
        name = str(item.get("name") or "")
        if name.startswith(EVIDENCE_PREFIX):
            evidence.append(
                {
                    "name": name,
                    "description": item.get("description") or "",
                    "snaptime": item.get("snaptime"),
                }
            )

    protected = str(config.get("protection") or "0") not in ("0", "", "False", "false")
    cut = [item["interface"] for item in networks if item["link_down"]]
    return {
        "node": node,
        "vmid": vmid,
        "isolated": bool(cut) or protected,
        "cut_interfaces": cut,
        "networks": networks,
        "protected": protected,
        "evidence_snapshots": sorted(evidence, key=lambda item: item.get("snaptime") or 0, reverse=True),
    }


_CAVEATS = [
    "快照是崩溃一致性的磁盘副本，无法提取内存镜像；对运行中的机器做快照不等于内存取证。",
    "link_down 只切断 PVE 的虚拟网卡，PCI 直通 / SR-IOV 网卡不受控制，需要在交换机侧另行隔离。",
    "隔离不会清除入侵痕迹，但后续对这台机器做快照回滚会覆盖当前磁盘状态 —— 取证与回滚在目标上冲突，请先保留证据。",
]


def _summary(ok: bool, steps: List[Dict[str, Any]]) -> str:
    def step_name(name: str) -> str:
        return i18n.t(f"isolation.step.{name}")

    done = [step_name(item["step"]) for item in steps if item["ok"]]
    failed = [step_name(item["step"]) for item in steps if not item["ok"]]
    parts = []
    if done:
        parts.append(
            i18n.t("isolation.summary.done", items=i18n.t("isolation.separator").join(done))
        )
    if failed:
        parts.append(
            i18n.t(
                "isolation.summary.failed", items=i18n.t("isolation.separator").join(failed)
            )
        )
    head = i18n.t("isolation.summary.ok" if ok else "isolation.summary.partial")
    if not parts:
        return head
    return head + i18n.t(
        "isolation.summary.detail",
        parts=i18n.t("isolation.summary.partSep").join(parts),
    )
