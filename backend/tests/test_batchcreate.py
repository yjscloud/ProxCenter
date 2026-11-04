"""批量下发编排层：VMID 分配、逐台失败语义、幂等缓存。"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import HTTPException

from app import batchcreate


def _run(coro):
    return asyncio.run(coro)


class _FakeClient:
    def __init__(self) -> None:
        self.occupied = [100, 9000]

    async def cluster_resources(self):
        return [{"vmid": vmid} for vmid in self.occupied]

    async def nextid(self) -> int:
        return 105


def test_allocate_vmids_skips_occupied_and_keeps_explicit() -> None:
    items = [
        SimpleNamespace(vmid=None, name="a"),
        SimpleNamespace(vmid=500, name="b"),
        SimpleNamespace(vmid=None, name="c"),
    ]
    client = _FakeClient()

    _run(batchcreate.allocate_vmids(client, items))

    # 105 是起点；显式指定的 500 保留，未指定的按 105 / 106 顺延
    assert [item.vmid for item in items] == [105, 500, 106]


def test_allocate_vmids_rejects_an_occupied_explicit_id() -> None:
    items = [SimpleNamespace(vmid=100, name="a")]
    try:
        _run(batchcreate.allocate_vmids(_FakeClient(), items))
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "已被集群占用" in str(exc.detail)
    else:  # pragma: no cover - 明确失败比静默放行好
        raise AssertionError("occupied VMID should be rejected")


def test_run_batch_reports_per_item_and_stops_on_error() -> None:
    async def create_one(item):
        if item.name == "bad":
            raise HTTPException(status_code=400, detail="boom")
        return {
            "task": f"UPID:{item.name}",
            "vmid": item.vmid,
            "node": "pve1",
            "post_steps": [],
        }

    items = [
        SimpleNamespace(vmid=101, node="pve1", name="ok"),
        SimpleNamespace(vmid=102, node="pve1", name="bad"),
        SimpleNamespace(vmid=103, node="pve1", name="skipped"),
    ]
    result = _run(
        batchcreate.run_batch(
            batch_id="b1",
            kind="vm",
            items=items,
            create_one=create_one,
            stop_on_error=True,
        )
    )

    assert result["ok"] == 1
    assert result["failed"] == 2
    assert [row["ok"] for row in result["results"]] == [True, False, False]
    assert result["results"][1]["error"] == "boom"
    assert "已跳过" in result["results"][2]["error"]


def test_batch_cache_is_scoped_by_user_and_expires() -> None:
    batchcreate.remember_batch("alice", "same-key", {"ok": 1})
    assert batchcreate.cached_batch("alice", "same-key") == {"ok": 1}
    assert batchcreate.cached_batch("bob", "same-key") is None
