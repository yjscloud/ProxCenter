"""重装作业入口的参数透传。

这个文件是补出来的 —— 上一次给流水线加参数（``wipe_data_disks``）时，只改了
``reinstall()`` 和路由，漏了夹在中间的 ``start_reinstall()``，于是**功能一上线
就是坏的**：用户在界面上点重装，收到的是

    服务器内部错误：start_reinstall() got an unexpected keyword argument 'wipe_data_disks'

这类错误有个共同特征：``py_compile`` 与 ``tsc`` 都看不见它 —— 那不是语法错，是运行
时的 TypeError，只有真的有人去点那一下才会暴露。所以这里把「入口参数必须覆盖流水线
参数」直接写成断言：下次再漏，测试先红。
"""
from __future__ import annotations

import asyncio
import inspect
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import reinstall  # noqa: E402


def test_entry_forwards_every_pipeline_argument():
    """start_reinstall 的参数必须能完整喂给 reinstall，一个都不能少。"""
    pipeline = inspect.signature(reinstall.reinstall)
    entry = inspect.signature(reinstall.start_reinstall)
    # client 由入口自己取；on_step 由后台作业接上 job.add_step —— 这两个都不经路由
    skip = {"client", "on_step"}
    missing = [
        name
        for name in pipeline.parameters
        if name not in skip and name not in entry.parameters
    ]
    assert not missing, (
        f"start_reinstall 少了这些参数：{missing} —— "
        "路由会把它们当关键字参数传进来，结果是运行时 TypeError"
    )


def test_identity_overrides_keep_identity_and_drop_disks():
    """重建时从旧机器带回来的只能是「身份」：磁盘、cloud-init、引导项都不能带。

    带回来的磁盘尤其危险 —— 那些卷已经随旧机器删掉了，写回新机器就是让 PVE
    去引用一块不存在的盘。
    """
    old = {
        "net0": "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
        "scsi0": "local:110/vm-110-disk-0.qcow2,size=100G",
        "ide0": "local:110/vm-110-cloudinit.qcow2,media=cdrom",
        "memory": 3072,
        "cores": 3,
        "tags": "prod;web",
        "smbios1": "uuid=xxx",
        "cipassword": "secret",
        "ciuser": "root",
        "ipconfig0": "ip=dhcp",
        "boot": "order=scsi0",
        "digest": "abc",
        "vmgenid": "xxx",
    }
    kept = reinstall.identity_overrides(old)

    assert {"net0", "memory", "cores", "tags", "smbios1"} <= set(kept)
    for dropped in ("scsi0", "ide0", "cipassword", "ciuser", "ipconfig0", "boot", "digest"):
        assert dropped not in kept, f"{dropped} 不该被带回新机器"
    # vmgenid 只有 root 能设，写回去会让整批恢复失败 —— 必须排除在外
    assert "vmgenid" not in kept


def test_firmware_overrides_rebuild_efi_and_tpm():
    """EFI 变量盘与 TPM 状态盘也是磁盘，会随机器消失，必须按原类型重开。"""
    out = reinstall.firmware_overrides(
        {
            "efidisk0": "local-lvm:vm-110-disk-1,efitype=4m,pre-enrolled-keys=1",
            "tpmstate0": "local-lvm:vm-110-disk-2,size=4M,version=v2.0",
        }
    )
    assert out["efidisk0"].startswith("local-lvm:1,")
    assert "efitype=4m" in out["efidisk0"] and "pre-enrolled-keys=1" in out["efidisk0"]
    assert out["tpmstate0"].startswith("local-lvm:4,")
    assert "version=v2.0" in out["tpmstate0"]
    assert reinstall.firmware_overrides({}) == {}


class FakeClient:
    """只回答「这台机器是关机的」；后台作业其余一律不该碰。"""

    async def get(self, path: str):
        if path.endswith("/status/current"):
            return {"status": "stopped", "name": "demo-vm"}
        raise AssertionError(f"不该走到这里：{path}")


def test_submit_accepts_every_option(monkeypatch):
    """真的提交一次（带上 wipe_data_disks），确认参数一路传得进去。"""
    steps: list = []

    async def fake_reinstall(client, **kwargs):
        steps.append(kwargs)
        return {"old_volume": "a", "new_volume": "b", "steps": []}

    async def fake_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(reinstall, "reinstall", fake_reinstall)
    monkeypatch.setattr(reinstall.security, "audit", fake_audit)
    # 后台协程按连接 id 重新取客户端（请求级的 contextvar 早就没了）
    monkeypatch.setattr(reinstall, "client_for_connection", lambda _conn: FakeClient())

    async def main():
        job = await reinstall.start_reinstall(
            FakeClient(),
            owner="tester",
            connection="conn-1",
            node="pve",
            vmid=110,
            template_node="pve",
            template_vmid=9000,
            target_storage="local-lvm",
            wipe_data_disks=False,
        )
        await job.task
        return job

    job = asyncio.run(main())

    assert job.status == "success", job.detail
    assert len(steps) == 1
    # 关键：开关真的传到了流水线，而不是被入口吞掉
    assert steps[0]["wipe_data_disks"] is False, steps[0]
    assert steps[0]["template_vmid"] == 9000
