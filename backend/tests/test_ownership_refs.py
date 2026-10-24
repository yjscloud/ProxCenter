"""归属匹配：多套 PVE 上「同名节点 + 相同 VMID」时必须按连接区分。

归属表按 ``<连接>:<节点>:<vmid>`` 记录，本来就能分清两套集群里的 pve/105；
但 :func:`app.ownership.vm_owner_from` 原先只按 ``:节点:vmid`` 后缀匹配，
两条记录同时命中、归属人又不同时返回 ``None``，调用方就当成「没有归属」。

症状是两边不一致：``/vms`` 列表用的是精确 ref，普通用户看得见自己的机器；
仪表盘排行（``/dashboard/top``）走的是这个函数，过滤后一台不剩 —— 卡片在，
但永远「暂无数据」。
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ownership  # noqa: E402


def test_prefers_the_exact_connection_ref() -> None:
    owners = {
        "baa23847:pve:105": "test02",
        "default:pve:105": "admin",
    }
    assert ownership.vm_owner_from(owners, "pve", 105, "baa23847") == "test02"
    assert ownership.vm_owner_from(owners, "pve", 105, "default") == "admin"


def test_unknown_connection_falls_back_to_suffix() -> None:
    """拿不到连接（老接口 / 未指定作用域）时仍按后缀认，行为与从前一致。"""
    owners = {"baa23847:pve:105": "test02"}
    assert ownership.vm_owner_from(owners, "pve", 105, "") == "test02"


def test_legacy_dash_prefix_is_accepted() -> None:
    """旧版本记录时连接留空，前缀是 ``-``；查询带真实连接也要认。"""
    owners = {"-:pve:105": "test02"}
    assert ownership.vm_owner_from(owners, "pve", 105, "baa23847") == "test02"


def test_other_connection_record_is_not_claimed() -> None:
    """A 连接上的归属不能被 B 连接的同号机器认领（否则是隔离漏洞）。"""
    owners = {"default:pve:105": "admin"}
    assert ownership.vm_owner_from(owners, "pve", 105, "baa23847") is None


def test_unclaimed_vm_has_no_owner() -> None:
    assert ownership.vm_owner_from({}, "pve", 105, "baa23847") is None
