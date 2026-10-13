"""资源额度（按所有者分配的那一层）的纯函数回归。

只测「数据」这一半：结构规范化、三层取值、与请求模型的字段一致性。
落库与 HTTP 那部分需要真实 MySQL，走 test_api_routes 的 ``api`` fixture。

重点盯两件事（都是设计上容易走偏的地方）：
1. **整份覆盖**：用户级一旦配置，就不该再逐字段回退到角色默认 —— 否则
   「给某个用户解除角色设的核数上限」根本表达不出来；
2. ``LIMIT_GROUPS`` 与 :class:`app.schemas.QuotaLimitsIn` 的字段必须一一对应，
   两处各写一份是迟早会漂的。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import ownership, quota, vmconfig  # noqa: E402
from app.schemas import QuotaLimitsIn  # noqa: E402


MIB = 1024**2
GIB = 1024**3


def _row(
    vmid: int,
    *,
    node: str = "pve1",
    connection_id: str = "",
    kind: str = "qemu",
    cores: int = 4,
    memory_bytes: int = 4 * GIB,
    disk_bytes: int = 32 * GIB,
) -> dict:
    """一行 PVE 分配读数（形状与 quota._build_guest_rows 一致）。"""
    return {
        "connection_id": connection_id,
        "node": node,
        "vmid": vmid,
        "type": kind,
        "cores": cores,
        "memory_bytes": memory_bytes,
        "disk_bytes": disk_bytes,
    }


def _refs(*, vm: list | None = None, ct: list | None = None) -> dict:
    """``owned_refs_for`` 的返回形状（``ct`` 里已含 KIND_VM 的回落）。"""
    return {"vm": set(vm or []), "ct": set(ct or [])}


def _ref(vmid: int, *, node: str = "pve1", connection_id: str = "") -> str:
    """用 ownership 的拼法造 ref —— 统计侧和归属侧必须完全一致。"""
    return ownership.vm_ref(connection_id, node, vmid)


# ------------------------------------------------------------------ 结构定义
class TestDefinitions:
    def test_groups_match_request_schema(self) -> None:
        """额度分组 / 字段必须与请求模型逐字一致。

        对不上时的表现很难查：管理员在界面上勾了「内存 8G」，后端却按另一个键名
        存进 JSON，读回来永远是 null —— 看起来就像「没保存成功」。
        """
        assert set(QuotaLimitsIn.model_fields) == set(quota.LIMIT_GROUPS)
        for group, fields in quota.LIMIT_GROUPS.items():
            sub_model = QuotaLimitsIn.model_fields[group].annotation
            assert tuple(sub_model.model_fields) == fields, group

    def test_group_kind_mapping_covers_legacy_kinds(self) -> None:
        """``ct`` / ``vm`` 到上一层的 ``lxc`` / ``vm`` 换算只有一处，别写错。

        注意两组名字**故意不同**：分组叫 ``ct``（与归属 / ``ct.*`` 权限一致），
        上半部分沿用历史叫法 ``lxc``。换算关系只此一处。
        """
        assert set(quota.GROUP_GUEST_KIND) == {"vm", "ct"}
        assert set(quota.GROUP_GUEST_KIND.values()) == set(quota.GUEST_KINDS)
        assert quota.GROUP_GUEST_KIND["ct"] == "lxc"
        assert quota.GROUP_GUEST_KIND["vm"] == "vm"

    def test_empty_limits_shape(self) -> None:
        limits = quota.empty_limits()
        assert set(limits) == set(quota.LIMIT_GROUPS)
        for group, fields in quota.LIMIT_GROUPS.items():
            assert set(limits[group]) == set(fields)
            assert all(value is None for value in limits[group].values())


# -------------------------------------------------------------- 规范化输入
class TestNormaliseLimits:
    def test_keeps_valid_numbers(self) -> None:
        result = quota.normalise_limits(
            {
                "vm": {"count": 3, "cores": 8, "memory_mb": 16384, "disk_gb": 200},
                "snapshot": {"per_guest": 2},
            }
        )
        assert result["vm"]["count"] == 3
        assert result["vm"]["cores"] == 8
        assert result["vm"]["memory_mb"] == 16384
        assert result["vm"]["disk_gb"] == 200
        assert result["vm"]["max_cores"] is None  # 没填的字段保持「不限制」
        assert result["snapshot"]["per_guest"] == 2
        assert result["ct"]["count"] is None

    def test_accepts_strings_from_db_json(self) -> None:
        """JSON 里存成字符串也能收（面板侧手工改过库的情形）。"""
        assert quota.normalise_limits({"vm": {"count": "5"}})["vm"]["count"] == 5

    def test_bad_values_fall_back_to_unlimited(self) -> None:
        """坏值当没配，不抛错 —— 一个坏字段不该让整个额度体系报错。"""
        result = quota.normalise_limits(
            {"vm": {"count": "abc", "cores": None, "disk_gb": ""}}
        )
        assert result["vm"]["count"] is None
        assert result["vm"]["cores"] is None
        assert result["vm"]["disk_gb"] is None

    def test_negative_clamped_to_zero(self) -> None:
        """负数按 0：0 表示明确禁止，比负数更有意义。"""
        assert quota.normalise_limits({"vm": {"count": -5}})["vm"]["count"] == 0

    def test_unknown_keys_and_groups_dropped(self) -> None:
        result = quota.normalise_limits(
            {"vm": {"count": 1, "bogus": 99}, "backup": {"count": 3}}
        )
        assert result["vm"]["count"] == 1
        assert "bogus" not in result["vm"]
        assert "backup" not in result  # 备份维度尚未开放，不该悄悄进库

    @pytest.mark.parametrize("raw", [None, "", "not-a-dict", 42, []])
    def test_non_dict_input_yields_empty(self, raw: object) -> None:
        assert quota.normalise_limits(raw) == quota.empty_limits()


# ------------------------------------------------------------ 三层取值语义
class TestResolveLimits:
    ROLE = {"vm": {"count": 5, "cores": 16}, "ct": {"count": 2}, "snapshot": {}}
    USER = {"vm": {"count": 1}, "ct": {}, "snapshot": {}}

    def test_user_layer_wins(self) -> None:
        effective, source = quota.resolve_limits(self.USER, self.ROLE)
        assert source == quota.SOURCE_USER
        assert effective["vm"]["count"] == 1

    def test_user_layer_is_whole_not_field_wise(self) -> None:
        """回归：用户级配置了但某个字段留空 = 这一项**不限制**，不是回退角色默认。

        逐字段合并的写法会在这里给出 16 —— 那用户就永远没法把自己从角色的核数
        上限里摘出来。
        """
        effective, source = quota.resolve_limits(self.USER, self.ROLE)
        assert source == quota.SOURCE_USER
        assert effective["vm"]["cores"] is None
        assert effective["ct"]["count"] is None  # 角色里给的是 2，也不继承

    def test_role_layer_is_fallback(self) -> None:
        effective, source = quota.resolve_limits(None, self.ROLE)
        assert source == quota.SOURCE_ROLE
        assert effective["vm"]["count"] == 5
        assert effective["vm"]["cores"] == 16

    def test_no_layer_means_unlimited(self) -> None:
        effective, source = quota.resolve_limits(None, None)
        assert source == quota.SOURCE_NONE
        assert effective == quota.empty_limits()

    def test_explicit_zero_is_not_unlimited(self) -> None:
        """0 = 明确禁止，必须与 null（不限制）区分开。"""
        effective, _ = quota.resolve_limits({"vm": {"count": 0}}, None)
        assert effective["vm"]["count"] == 0
        assert effective["vm"]["cores"] is None


# ------------------------------------------------------------ 用量汇总
class TestSummariseUsage:
    def test_counts_only_owned(self) -> None:
        rows = [_row(100), _row(101)]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(100)]))
        assert usage["vm"]["count"] == 1

    def test_splits_vm_and_ct(self) -> None:
        rows = [_row(100), _row(200, kind="lxc", cores=2, memory_bytes=2 * GIB, disk_bytes=8 * GIB)]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(100)], ct=[_ref(200)]))
        assert usage["vm"] == {"count": 1, "cores": 4, "memory_mb": 4096, "disk_gb": 32}
        assert usage["ct"] == {"count": 1, "cores": 2, "memory_mb": 2048, "disk_gb": 8}

    def test_connection_is_part_of_the_key(self) -> None:
        """不同 PVE 上同名节点 + 相同 VMID 是两台机器，别把它们算成同一台。"""
        rows = [_row(100, connection_id="a"), _row(100, connection_id="b")]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(100, connection_id="a")]))
        assert usage["vm"]["count"] == 1

    def test_container_recorded_under_legacy_kind_still_counts(self) -> None:
        """回落：容器归属记在旧的 KIND_VM 下时，照样要计入（否则看得见却不计数）。"""
        rows = [_row(200, kind="lxc")]
        refs = _refs(vm=[_ref(200)], ct=[_ref(200)])  # owned_refs_for 会把 vm 并进 ct
        assert quota.summarise_usage(rows, refs)["ct"]["count"] == 1

    def test_template_row_counts(self) -> None:
        """模板同样占核数 / 内存 / 磁盘，沿用第一层的口径。"""
        rows = [_row(9000, cores=2, memory_bytes=2 * GIB, disk_bytes=16 * GIB)]
        assert quota.summarise_usage(rows, _refs(vm=[_ref(9000)]))["vm"]["count"] == 1

    def test_bytes_round_to_nearest_unit(self) -> None:
        """字节 → MB / GB 四舍五入：PVE 的卷常比申请的略大，不能向上取整。"""
        rows = [
            _row(
                100,
                # 4596.5 MiB -> 4597（半个单位进位）
                memory_bytes=4596 * MIB + MIB // 2,
                # 32.0039 GiB -> 32：PVE 的卷按 4MiB 对齐，向上取整会变成 33，
                # 用户按额度一算就莫名其妙超了
                disk_bytes=32 * GIB + 4 * MIB,
            )
        ]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(100)]))
        assert usage["vm"]["memory_mb"] == 4597
        assert usage["vm"]["disk_gb"] == 32

    def test_half_unit_rounds_up(self) -> None:
        rows = [_row(100, disk_bytes=GIB + GIB // 2)]  # 1.5 GiB
        assert quota.summarise_usage(rows, _refs(vm=[_ref(100)]))["vm"]["disk_gb"] == 2

    def test_missing_fields_count_as_zero(self) -> None:
        """PVE 没给某个字段（老版本 / 无盘机器）时按 0 算，但不能因此漏掉台数。"""
        rows = [
            {
                "connection_id": "",
                "node": "pve1",
                "vmid": 100,
                "type": "qemu",
                "cores": None,
                "memory_bytes": None,
                "disk_bytes": "",
            }
        ]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(100)]))
        assert usage["vm"] == {"count": 1, "cores": 0, "memory_mb": 0, "disk_gb": 0}

    def test_non_guest_types_ignored(self) -> None:
        rows = [{"type": "node", "node": "pve1", "vmid": 0}, {"type": "storage", "node": "pve1"}]
        usage = quota.summarise_usage(rows, _refs(vm=[_ref(0)]))
        assert usage["vm"]["count"] == 0

    def test_usage_fields_match_total_fields(self) -> None:
        """汇总出来的字段必须与 TOTAL_FIELDS 对齐（校验按它逐项比）。"""
        usage = quota.summarise_usage([], _refs())
        for group in ("vm", "ct"):
            assert set(usage[group]) == set(quota.TOTAL_FIELDS)


# ------------------------------------------------------------ 剩余量
class TestRemainingFor:
    def test_unlimited_stays_none(self) -> None:
        assert quota.remaining_for({"count": None}, {"count": 3})["count"] is None

    def test_subtracts_usage(self) -> None:
        limits = {"count": 5, "cores": 16, "memory_mb": 32768, "disk_gb": 500}
        usage = {"count": 2, "cores": 4, "memory_mb": 8192, "disk_gb": 100}
        remaining = quota.remaining_for(limits, usage)
        assert remaining == {"count": 3, "cores": 12, "memory_mb": 24576, "disk_gb": 400}

    def test_negative_is_kept(self) -> None:
        """管理员下调额度后，已建出来的机器就会超出 —— 那是事实，不该截断成 0。"""
        assert quota.remaining_for({"count": 1}, {"count": 3})["count"] == -2

    def test_missing_usage_is_zero(self) -> None:
        assert quota.remaining_for({"count": 2}, None)["count"] == 2


# -------------------------------------------- 存量归属记录的兜底（真有这种数据）
class TestLegacyOwnership:
    """面板早期只有单连接，归属 ref 前缀是 ``-``；现在行里带的是真实连接 id。

    严格匹配会让这些机器「看得见却不计数」—— 少算额度是 fail-closed 下最危险的
    方向，所以按 node/vmid 兜一次。
    """

    def test_legacy_ref_without_connection_is_counted(self) -> None:
        rows = [_row(107, connection_id="conn-1")]
        refs = _refs(vm=[ownership.vm_ref("", "pve1", 107)])
        assert quota.summarise_usage(rows, refs)["vm"]["count"] == 1

    def test_ambiguous_node_vmid_is_not_guessed(self) -> None:
        """两台 PVE 上同名节点 + 相同 VMID 是两台机器，兜底那一路不猜。"""
        rows = [_row(100, connection_id="a"), _row(100, connection_id="b")]
        refs = _refs(vm=[ownership.vm_ref("", "pve1", 100)])
        assert quota.summarise_usage(rows, refs)["vm"]["count"] == 0

    def test_exact_match_still_wins(self) -> None:
        rows = [_row(100, connection_id="a"), _row(100, connection_id="b")]
        refs = _refs(vm=[ownership.vm_ref("a", "pve1", 100)])
        assert quota.summarise_usage(rows, refs)["vm"]["count"] == 1

    def test_ref_for_removed_connection_is_ignored(self) -> None:
        """指向已删除连接的记录不计数：那台机器用户本来也访问不到。"""
        rows = [_row(100, connection_id="a")]
        refs = _refs(vm=[ownership.vm_ref("gone", "pve1", 100)])
        assert quota.summarise_usage(rows, refs)["vm"]["count"] == 0


# ------------------------------------------- NULL 与「空 JSON」的区别（三层的地基）
class TestLimitsResult:
    def test_null_or_blank_means_not_configured(self) -> None:
        """库里的 NULL / 空串 = 这一层没配过，继续往下继承。"""
        assert quota._limits_result(None)["configured"] is False
        assert quota._limits_result("")["configured"] is False
        assert quota._limits_result()["quota"] is None

    def test_json_object_is_configured(self) -> None:
        row = quota._limits_result('{"vm": {"count": 3}}')
        assert row["configured"] is True
        assert row["quota"]["vm"]["count"] == 3

    def test_explicit_empty_json_is_configured(self) -> None:
        """存了一份 ``{}`` = 显式覆盖成「全不限制」，与「没配」是两回事。

        这两者混掉的后果很具体：「清除额度回到继承角色」与「显式解除所有限制」
        会变成同一个动作，管理员就没法只给某个人放开而不动角色。
        """
        row = quota._limits_result("{}")
        assert row["configured"] is True
        assert row["quota"] == quota.empty_limits()

    def test_broken_json_is_treated_as_unlimited_not_as_unconfigured(self) -> None:
        """坏 JSON 按「有配置但全不限制」处理：宁可放宽也不该悄悄回退到角色默认。"""
        row = quota._limits_result("{not json")
        assert row["configured"] is True
        assert row["quota"] == quota.empty_limits()

    def test_user_row_meta_is_kept(self) -> None:
        row = quota._limits_result('{"vm": {"count": 1}}', 1700000000, "admin")
        assert row["updated"] == 1700000000.0
        assert row["updated_by"] == "admin"


# ------------------------------------------------------------ 新增前的校验
class TestCheckLimits:
    def test_unlimited_passes(self) -> None:
        assert quota.check_limits("vm", {}, {}, {"count": 1, "cores": 64}) is None

    def test_count_exhausted(self) -> None:
        msg = quota.check_limits("vm", {"count": 2}, {"count": 2}, {"count": 1})
        assert msg and "数量" in msg and "上限" in msg

    def test_count_allows_when_room(self) -> None:
        assert quota.check_limits("vm", {"count": 2}, {"count": 1}, {"count": 1}) is None

    def test_zero_blocks(self) -> None:
        """0 = 明确禁止（而不是不限制）—— 与 None 必须分开。"""
        assert quota.check_limits("vm", {"count": 0}, {"count": 0}, {"count": 1})

    def test_total_cores_uses_used_plus_need(self) -> None:
        limits = {"cores": 16}
        assert quota.check_limits("vm", limits, {"cores": 14}, {"count": 1, "cores": 2}) is None
        assert quota.check_limits("vm", limits, {"cores": 15}, {"count": 1, "cores": 2})

    def test_per_guest_cap(self) -> None:
        msg = quota.check_limits("vm", {"max_cores": 8}, {}, {"cores": 16})
        assert msg and "单台" in msg

    def test_cap_checked_even_when_total_is_unlimited(self) -> None:
        assert quota.check_limits("vm", {"max_disk_gb": 100}, {}, {"disk_gb": 200})

    def test_unknown_dimensions_are_skipped(self) -> None:
        """``spec`` 里没有的维度不查：不是按 0 放行，而是不假装知道。"""
        assert quota.check_limits("vm", {"count": 1}, {"count": 0}, {"count": 1}) is None
        assert quota.check_limits("vm", {"disk_gb": 1}, {"disk_gb": 0}, {"count": 1}) is None

    def test_count_checked_first(self) -> None:
        """报错按 TOTAL_FIELDS 的顺序，「台数」排最前 —— 用户最容易理解的那条。"""
        msg = quota.check_limits("vm", {"count": 0, "cores": 0}, {}, {"count": 1, "cores": 1})
        assert "数量" in msg

    def test_group_appears_in_message(self) -> None:
        assert "容器" in quota.check_limits("ct", {"count": 0}, {}, {"count": 1})
        assert "虚拟机" in quota.check_limits("vm", {"count": 0}, {}, {"count": 1})

    def test_memory_is_rendered_in_gb(self) -> None:
        msg = quota.check_limits("vm", {"memory_mb": 1024}, {}, {"memory_mb": 2048})
        assert "1 GB" in msg and "2 GB" in msg


# ------------------------------------------------------------ 来源机器规格
class TestSpecFromSource:
    def test_reads_existing_machine(self) -> None:
        rows = [_row(100, cores=4, memory_bytes=4 * GIB, disk_bytes=32 * GIB)]
        assert quota.spec_from_source(rows, "pve1", 100) == {
            "cores": 4,
            "memory_mb": 4096,
            "disk_gb": 32,
        }

    def test_missing_machine_returns_empty(self) -> None:
        assert quota.spec_from_source([], "pve1", 100) == {}

    def test_connection_hint_disambiguates(self) -> None:
        rows = [_row(100, connection_id="a", cores=4), _row(100, connection_id="b", cores=8)]
        assert quota.spec_from_source(rows, "pve1", 100, "b")["cores"] == 8

    def test_ambiguous_without_hint_returns_empty(self) -> None:
        """两台 PVE 上同名节点 + 相同 VMID：没有连接提示就不猜。"""
        rows = [_row(100, connection_id="a"), _row(100, connection_id="b")]
        assert quota.spec_from_source(rows, "pve1", 100) == {}


class TestBytesToGb:
    def test_rounds_like_usage_stats(self) -> None:
        assert quota.bytes_to_gb(32 * GIB + 4 * MIB) == 32
        assert quota.bytes_to_gb(GIB + GIB // 2) == 2

    def test_bad_input_is_zero(self) -> None:
        assert quota.bytes_to_gb(None) == 0
        assert quota.bytes_to_gb("abc") == 0


# --------------------------------------------------- 已有机器「长大」的校验
class TestCheckGrowth:
    def test_unlimited_passes(self) -> None:
        assert quota.check_growth("vm", {}, {}, {"cores": 2}, {"cores": 64}) is None

    def test_total_counts_only_the_delta(self) -> None:
        """回归：已用量里本来就含这台机器，按整机值算会把它算两遍。

        这台机器 50 GB、名下共 100 GB；涨到 80 GB 只多占 30 GB。
        上限 130 → 100+30=130 正好；上限 120 → 130 > 120 拦下。
        """
        current, final = {"disk_gb": 50}, {"disk_gb": 80}
        usage = {"disk_gb": 100}
        assert quota.check_growth("vm", {"disk_gb": 130}, usage, current, final) is None
        assert quota.check_growth("vm", {"disk_gb": 120}, usage, current, final)

    def test_cap_uses_the_final_value(self) -> None:
        limits = {"max_cores": 8}
        assert quota.check_growth("vm", limits, {}, {"cores": 4}, {"cores": 8}) is None
        assert quota.check_growth("vm", limits, {}, {"cores": 4}, {"cores": 16})

    def test_shrink_is_allowed(self) -> None:
        """缩容是往好的方向走，不该被额度拦（哪怕已经超额）。"""
        limits = {"disk_gb": 10, "max_disk_gb": 10}
        assert (
            quota.check_growth("vm", limits, {"disk_gb": 999}, {"disk_gb": 50}, {"disk_gb": 20})
            is None
        )

    def test_untouched_dimensions_are_ignored(self) -> None:
        """只改了内存时，别拿核数/磁盘的额度去拦。"""
        limits = {"cores": 0, "max_cores": 0}
        assert quota.check_growth("vm", limits, {}, {"cores": 4}, {"memory_mb": 8192}) is None

    def test_missing_current_is_treated_as_zero(self) -> None:
        """读数里查不到这台机器（例如刚建出来还没登记）时按 0 算 —— 宁严不宽。"""
        assert quota.check_growth("vm", {"cores": 4}, {"cores": 0}, {}, {"cores": 8})


# --------------------------------------------------------- 扩容请求的换算
class TestDiskGrowDelta:
    def test_relative_form_needs_no_baseline(self) -> None:
        assert quota.disk_grow_delta("+10G", None) == 10

    def test_absolute_form_needs_the_current_size(self) -> None:
        assert quota.disk_grow_delta("80G", 50) == 30
        assert quota.disk_grow_delta("30G", 50) == 0  # 缩小 / 没变
        assert quota.disk_grow_delta("80G", None) is None  # 不知道现状就不查

    def test_blank_and_broken_input(self) -> None:
        assert quota.disk_grow_delta("", None) is None
        assert quota.disk_grow_delta("不是数字", None) is None


class TestDiskValueGb:
    """从 config 值里取容量：认两种写法，取不到就返回 None（不猜）。"""

    def test_new_disk_form(self) -> None:
        assert vmconfig.disk_value_gb("local-lvm:50") == 50
        assert vmconfig.disk_value_gb("local-lvm:512M") == 0.5

    def test_existing_disk_form(self) -> None:
        assert vmconfig.disk_value_gb("local-lvm:vm-100-disk-0,size=32G") == 32
        assert vmconfig.disk_value_gb("local-lvm:vm-100-disk-1,size=20G,mp=/data") == 20

    def test_bare_volume_name_is_unknown(self) -> None:
        assert vmconfig.disk_value_gb("local-lvm:vm-100-disk-0") is None
        assert vmconfig.disk_value_gb("") is None


# ------------------------------------------------------------ 快照额度
def _run(coro):
    """同步跑协程（与 test_bulk / test_firewall 同一套路）。"""
    return asyncio.run(coro)


class _SnapClient:
    """只实现快照列表的最小客户端（测计数时的过滤规则）。"""

    def __init__(self, snaps, kind: str = "qemu"):
        self._snaps = snaps
        self.calls = []

    async def qemu_snapshots(self, node, vmid):
        self.calls.append(("qemu", node, vmid))
        return self._snaps

    async def lxc_snapshots(self, node, vmid):
        self.calls.append(("lxc", node, vmid))
        return self._snaps


class TestFetchSnapshotCount:
    def test_current_pseudo_entry_is_not_counted(self) -> None:
        """PVE 的列表里第一个是「当前状态」的伪条目，不是快照。

        忘了这件事的后果很具体：每台机器凭空多一张，单机上限跟着虚高一格。
        """
        client = _SnapClient([{"name": "current"}, {"name": "s1"}, {"name": "s2"}])
        assert _run(quota._fetch_snapshot_count(client, "qemu", "pve1", 100)) == 2
        assert client.calls == [("qemu", "pve1", 100)]

    def test_container_uses_lxc_endpoint(self) -> None:
        client = _SnapClient([{"name": "current"}], kind="lxc")
        assert _run(quota._fetch_snapshot_count(client, "lxc", "pve1", 200)) == 0
        assert client.calls == [("lxc", "pve1", 200)]

    def test_empty_and_broken_entries(self) -> None:
        assert _run(quota._fetch_snapshot_count(_SnapClient(None), "qemu", "n", 1)) == 0
        broken = [{"name": ""}, {}, {"description": "无名字"}]
        assert _run(quota._fetch_snapshot_count(_SnapClient(broken), "qemu", "n", 1)) == 0


class TestCheckSnapshotLimits:
    def test_unlimited_passes(self) -> None:
        assert quota.check_snapshot_limits({}, 99, 99) is None
        assert quota.check_snapshot_limits({"per_guest": None}, 0, 0) is None

    def test_per_guest_blocks_the_next_one(self) -> None:
        """验收口径：单机上限 2、这台已有 2 → 第三张被拒。"""
        msg = quota.check_snapshot_limits({"per_guest": 2}, 2, 2)
        assert msg and "单台" in msg and "上限 2" in msg

    def test_per_guest_allows_until_full(self) -> None:
        assert quota.check_snapshot_limits({"per_guest": 2}, 1, 1) is None
        assert quota.check_snapshot_limits({"per_guest": 2}, 2, 2)

    def test_zero_blocks_everything(self) -> None:
        assert quota.check_snapshot_limits({"per_guest": 0}, 0, 0)
        assert quota.check_snapshot_limits({"count": 0}, 0, 0)

    def test_total_blocks_regardless_of_which_guest(self) -> None:
        msg = quota.check_snapshot_limits({"count": 5}, 1, 5)
        assert msg and "快照总数额度不足" in msg

    def test_per_guest_is_reported_before_total(self) -> None:
        """两个都超时先说单机那条 —— 用户正在某台机器上点「建快照」，这条更贴题。"""
        msg = quota.check_snapshot_limits({"per_guest": 1, "count": 1}, 5, 5)
        assert msg and "单台" in msg


class TestSnapshotCacheKey:
    def test_key_lives_under_one_prefix(self) -> None:
        """对账作业按前缀整片作废，键必须都挂在同一个前缀下。"""
        assert quota._snapshot_key("c:pve:100").startswith(quota._SNAPSHOT_PREFIX)
        assert quota._snapshot_key("c:pve:100") != quota._snapshot_key("c:pve:101")


class TestOwnedRefsInRows:
    """归属 ref → 读数 ref 的映射：存量数据的连接前缀对不上时必须兜住。

    回归点：快照总数按这套映射筛机器，漏一台就少算一份用量。
    """

    def test_exact_match(self) -> None:
        rows = [_row(110, connection_id="conn-1")]
        refs = {ownership.vm_ref("conn-1", "pve1", 110)}
        assert quota.owned_refs_in_rows(rows, refs) == {ownership.vm_ref("conn-1", "pve1", 110)}

    def test_legacy_prefix_is_mapped_to_the_row_ref(self) -> None:
        rows = [_row(110, connection_id="conn-1")]
        refs = {ownership.vm_ref("", "pve1", 110)}  # 面板早期记的 "-:pve1:110"
        assert quota.owned_refs_in_rows(rows, refs) == {"conn-1:pve1:110"}

    def test_ambiguous_node_vmid_is_not_guessed(self) -> None:
        rows = [_row(100, connection_id="a"), _row(100, connection_id="b")]
        refs = {ownership.vm_ref("", "pve1", 100)}
        assert quota.owned_refs_in_rows(rows, refs) == set()

    def test_other_peoples_machines_are_skipped(self) -> None:
        rows = [_row(100, connection_id="a"), _row(200, connection_id="a")]
        refs = {ownership.vm_ref("a", "pve1", 100)}
        assert quota.owned_refs_in_rows(rows, refs) == {"a:pve1:100"}

    def test_empty_inputs(self) -> None:
        assert quota.owned_refs_in_rows([], {"x"}) == set()
        assert quota.owned_refs_in_rows([_row(1)], set()) == set()
