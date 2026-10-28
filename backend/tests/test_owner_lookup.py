"""归属反查的查询形状。

背景：``resolve_vm_connection`` 曾经把整张 ``resource_owner`` 读回来再在内存里
``endswith`` 过滤。机器上千台时，一次单机请求要搬几千行，而「批量指派」是
逐台打开一次指派弹窗 —— 总数就是平方级增长，表现为越来越慢。

现在调用方把「当前存在哪些连接」传进来，反查退化成 ``(kind, ref)`` 主键上的
几条点查。这里钉住三件事：查询带候选 ref、结果能还原回连接 id、不给候选时
仍走原来的整表路径（兼容老调用方）。
"""
from __future__ import annotations

import asyncio
from typing import Any, List, Optional, Tuple

import pytest

from app import ownership


class _FakeCursor:
    def __init__(self, rows: List[Tuple[Any, ...]]) -> None:
        self._rows = rows

    async def fetchall(self) -> List[Tuple[Any, ...]]:
        return self._rows


class _FakeDB:
    def __init__(self, rows: List[Tuple[Any, ...]], sink: List[Tuple[str, Any]]) -> None:
        self._rows = rows
        self._sink = sink

    async def execute(self, sql: str, params: Optional[Any] = None) -> _FakeCursor:
        self._sink.append((" ".join(sql.split()), params))
        return _FakeCursor(self._rows)

    async def __aenter__(self) -> "_FakeDB":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


def _patch_db(
    monkeypatch: pytest.MonkeyPatch, rows: List[Tuple[Any, ...]]
) -> List[Tuple[str, Any]]:
    sink: List[Tuple[str, Any]] = []
    monkeypatch.setattr(ownership.database, "connect", lambda: _FakeDB(rows, sink))
    return sink


def test_lookup_uses_indexed_candidate_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    """给了候选连接就只点查这些 ref —— 不再把整表搬回进程。"""
    rows = [("conn-b:pve1:100", "alice"), ("-:pve1:100", "bob")]
    sink = _patch_db(monkeypatch, rows)

    found = asyncio.run(
        ownership.find_refs_by_vm("pve1", 100, connection_ids={"conn-b", ""})
    )

    sql, params = sink[0]
    assert "ref IN (" in sql, sql
    # 空连接对应的历史前缀是 "-"（vm_ref 的历史写法），必须一并查
    assert set(params) == {"vm", "ct", "conn-b:pve1:100", "-:pve1:100"}

    # 命中的行还原回连接 id，"-" 保留（调用方 _normalize 会把它折成空串）
    assert set(found) == {("conn-b", "alice"), ("-", "bob")}


def test_lookup_without_candidates_keeps_the_streaming_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """没给候选的连接（老调用方）仍走原来的整表读取，行为不变。"""
    rows = [("conn-b:pve1:100", "alice"), ("conn-c:pve1:100", "carol"), ("-:pve1:101", "dave")]
    sink = _patch_db(monkeypatch, rows)

    found = asyncio.run(ownership.find_refs_by_vm("pve1", 100))

    sql, _ = sink[0]
    assert "ref IN (" not in sql, sql
    assert set(found) == {("conn-b", "alice"), ("conn-c", "carol")}


def test_lookup_with_empty_candidate_set_skips_the_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一个连接都没有时直接返回，不发无谓的 SQL。"""
    sink = _patch_db(monkeypatch, [])

    assert asyncio.run(ownership.find_refs_by_vm("pve1", 100, connection_ids=set())) == []
    assert sink == []
