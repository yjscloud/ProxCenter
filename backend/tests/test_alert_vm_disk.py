"""虚拟机磁盘告警的数据来源。

PVE 的 ``/cluster/resources`` 对 qemu 条目只报「分配容量」：``disk`` 恒为 0、
``maxdisk`` 是磁盘大小。拿这两个字段算使用率永远是 0%，所以「虚拟机硬盘告警」
配了也不会触发 —— 真实已用量只能从客户机的 guest agent（``get-fsinfo``）取。

这里钉住三件事：
1. 旧口径确实是 0%（说明这不是阈值配错）；
2. 新口径从 agent 拿到真实百分比，并跳过 tmpfs 之类的伪文件系统；
3. agent 不可用时返回 None（「本轮没有数据」），不能变成 0%。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import alerting  # noqa: E402


class FakeClient:
    """只实现告警用到的那一个 agent 方法。"""

    def __init__(self, entries=None, error=None):
        self.entries = entries or []
        self.error = error
        self.calls = []

    async def qemu_agent_fsinfo(self, node, vmid):
        self.calls.append((node, vmid))
        if self.error:
            raise self.error
        return list(self.entries)


QEMU_ROW = {
    "type": "qemu",
    "vmid": 103,
    "node": "pve",
    "name": "ProxCenter-17",
    "status": "running",
    "disk": 0,
    "maxdisk": 107374182400,
}


def test_cluster_resources_disk_usage_is_always_zero_for_qemu() -> None:
    """旧口径：disk=0 / maxdisk=100GiB -> 0%，低于任何阈值，永远不触发。"""
    assert alerting.usage(QEMU_ROW, "disk") == 0.0


def test_vm_disk_usage_reads_guest_agent() -> None:
    client = FakeClient(
        [{"mountpoint": "/", "type": "ext4", "used-bytes": 380, "total-bytes": 1000}]
    )
    assert asyncio.run(alerting.vm_disk_usage(client, "pve", 103)) == pytest.approx(
        38.0
    )
    assert client.calls == [("pve", 103)]


def test_pseudo_filesystems_do_not_water_down_the_result() -> None:
    """tmpfs / overlay 的 used/total 与剩余空间无关，不能参与整机总量累加。"""
    client = FakeClient(
        [
            {"mountpoint": "/run", "type": "tmpfs", "used-bytes": 99, "total-bytes": 100},
            {"mountpoint": "/", "type": "ext4", "used-bytes": 10, "total-bytes": 100},
            {"mountpoint": "/var/lib/docker", "type": "overlay", "used-bytes": 90, "total-bytes": 100},
        ]
    )
    assert asyncio.run(alerting.vm_disk_usage(client, "pve", 1)) == pytest.approx(10.0)


def test_disk_usage_is_the_whole_disk_total_not_the_busiest_partition() -> None:
    """「磁盘使用率」是整机总量：多个真实分区按 used/total 累加求占比。

    根分区 90/100、数据盘 0/100 —— 整机 90/200 = 45%；若只取最满的单个分区会误报成 90%。
    """
    client = FakeClient(
        [
            {"mountpoint": "/", "type": "ext4", "used-bytes": 90, "total-bytes": 100},
            {"mountpoint": "/data", "type": "xfs", "used-bytes": 0, "total-bytes": 100},
        ]
    )
    pct, used, total = asyncio.run(alerting.vm_disk_fs_usage(client, "pve", 1))
    assert pct == pytest.approx(45.0)
    assert (used, total) == (90.0, 200.0)


def test_agent_failure_means_no_data_instead_of_zero() -> None:
    """没装 qemu-guest-agent 时不能报 0%，否则规则静默到没人发现。"""
    client = FakeClient(error=RuntimeError("guest agent is not running"))
    assert asyncio.run(alerting.vm_disk_usage(client, "pve", 1)) is None


def test_prefetch_covers_running_qemu_only_and_dedupes() -> None:
    client = FakeClient(
        [{"mountpoint": "/", "type": "ext4", "used-bytes": 50, "total-bytes": 100}]
    )
    resources = [
        QEMU_ROW,
        {**QEMU_ROW, "vmid": 2, "status": "stopped", "name": "off"},
        {**QEMU_ROW, "vmid": 9, "name": "tpl", "template": 1},
        {"type": "lxc", "vmid": 3, "node": "pve", "status": "running", "name": "c"},
        {"type": "node", "node": "pve", "status": "online"},
    ]
    rules = [
        {"id": "1", "target_type": "vm", "target": "*", "metric": "disk"},
        {"id": "2", "target_type": "vm", "target": "*", "metric": "disk"},
        {"id": "3", "target_type": "vm", "target": "*", "metric": "cpu"},
    ]
    out = asyncio.run(alerting.prefetch_vm_disk_usage(client, rules, resources))
    # 两条规则指同一台 -> 只问一次 agent；关机 / 模板 / 容器 / 节点都不问
    assert client.calls == [("pve", 103)]
    # 返回 (使用率%, 已用字节, 总字节)：容量给模板的 {used}/{total} 用
    assert out[("pve", 103)][0] == pytest.approx(50.0)
    assert out[("pve", 103)][1:] == (50.0, 100.0)
    assert len(out) == 1


def test_prefetch_is_free_without_disk_rules() -> None:
    client = FakeClient()
    rules = [{"id": "1", "target_type": "vm", "target": "*", "metric": "cpu"}]
    out = asyncio.run(alerting.prefetch_vm_disk_usage(client, rules, [QEMU_ROW]))
    assert out == {}
    assert client.calls == []
