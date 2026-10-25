"""区域管理员与节点可见性。

覆盖三件事（都只靠纯逻辑与面板自己的库，不碰 PVE）：

1. **区域判定**：区域管理员的可见范围就是 ``users.regions`` 里那几个区域名；
   未分区（region 为空）的连接不归任何人；普通用户不受区域限制。
2. **节点授权解析**：默认可见 → 标记受限后默认隐藏 → 用户行 / 角色行放开，
   优先级 user > role > 默认 > 无行。
3. **写操作兜底**：``ensure_node_allowed`` 在节点不可见时拒绝（创建接口用它），
   ``ensure_region_allowed`` 在越区时拒绝。

注意：面板用的是**全局** aiomysql 连接池，池里的连接绑定在创建它的事件循环上。
所以每个用例必须把所有异步动作放进同一个 ``asyncio.run``，结束时关掉池 ——
否则下一个 ``asyncio.run`` 会拿到「属于另一个循环」的连接（RuntimeError）。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Awaitable, Callable

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import database, security, store  # noqa: E402

ADMIN = {"role": "admin", "username": "admin", "regions": []}
REGION_ADMIN = {"role": "region_admin", "username": "ra", "regions": ["华东", "华北"]}
OPERATOR = {"role": "operator", "username": "test02", "regions": []}


def _run(scenario: Callable[[], Awaitable[None]]) -> None:
    """建表 → 跑场景 → 关池，全部在同一个事件循环里。"""

    async def main() -> None:
        await store.init_db()
        try:
            await scenario()
        finally:
            await database.close_pool()

    asyncio.run(main())


@pytest.fixture()
def db(clean_mysql_db):
    """只清库；建表交给 :func:`_run`（必须和用例动作同一个循环）。"""
    yield


# --------------------------------------------------------------- 区域判定
def test_region_admin_scope_is_its_regions() -> None:
    assert security.is_region_admin(REGION_ADMIN)
    assert not security.is_region_admin(OPERATOR)

    assert security.region_in_scope(REGION_ADMIN, "华东")
    assert security.region_in_scope(REGION_ADMIN, "华北")
    assert not security.region_in_scope(REGION_ADMIN, "华南")


def test_unassigned_region_is_nobodys() -> None:
    """忘了填区域的连接不能变成一个「谁都能管」的缺口。"""
    assert not security.region_in_scope(REGION_ADMIN, "")
    assert not security.region_in_scope(REGION_ADMIN, "   ")


def test_ordinary_users_are_not_limited_by_region() -> None:
    """普通用户的范围由「自己名下」与节点授权决定，不受区域标签限制。"""
    assert security.region_in_scope(OPERATOR, "华南")
    assert security.region_in_scope(ADMIN, "随便")


def test_region_admin_without_regions_sees_only_own() -> None:
    empty = {"role": "region_admin", "username": "ra", "regions": []}
    assert security.user_regions(empty) == []
    assert not security.region_in_scope(empty, "华东")


def test_user_view_keeps_regions() -> None:
    """认证视图必须带上 regions。

    路由里的区域判定（连接清单、节点列表、单机访问）读的都是这份视图；漏掉
    regions 会让区域管理员在每个 HTTP 请求里都表现为「没分配区域」——连接与
    节点直接变空，但库里数据其实是对的。
    """
    raw = {
        "id": 1,
        "username": "zbh",
        "role": "region_admin",
        "regions": ["广州测试服"],
        "enabled": True,
        "status": store.STATUS_ACTIVE,
        "totp_enabled": True,
        "token_version": 0,
    }
    view = security._user_view(raw, "/api/nodes")
    assert view["regions"] == ["广州测试服"]


def test_user_view_regions_accepts_json_string() -> None:
    raw = {
        "id": 1,
        "username": "zbh",
        "role": "region_admin",
        "regions": '["广州测试服"]',
        "enabled": True,
        "status": store.STATUS_ACTIVE,
        "totp_enabled": True,
        "token_version": 0,
    }
    assert security._user_view(raw, "/api/nodes")["regions"] == ["广州测试服"]


def test_ensure_region_allowed_rejects_outside(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "connection_region", lambda cid: "华南")
    with pytest.raises(HTTPException) as exc:
        security.ensure_region_allowed(REGION_ADMIN, "c1")
    assert exc.value.status_code == 403

    monkeypatch.setattr(store, "connection_region", lambda cid: "华东")
    security.ensure_region_allowed(REGION_ADMIN, "c1")  # 不抛


# ----------------------------------------------------------- 节点可见性
def test_node_visible_by_default(db) -> None:
    async def scenario() -> None:
        check = await security.node_visibility(OPERATOR)
        assert check("c1", "pve1")

    _run(scenario)


def test_restricted_node_hidden_then_granted(db) -> None:
    async def scenario() -> None:
        await store.save_node_scope("c1", "pve9", "*", "*", False)

        assert not (await security.node_visibility(OPERATOR))("c1", "pve9")
        # 别的节点不受影响
        assert (await security.node_visibility(OPERATOR))("c1", "pve1")
        # 管理员与区域管理员不受节点级限制
        assert (await security.node_visibility(ADMIN))("c1", "pve9")
        assert (await security.node_visibility(REGION_ADMIN))("c1", "pve9")

        # 单独授权给某个用户
        await store.save_node_scope("c1", "pve9", "user", "test02", True)
        assert (await security.node_visibility(OPERATOR))("c1", "pve9")

        # 去掉授权 → 又回到受限
        await store.delete_node_scope("c1", "pve9", "user", "test02")
        assert not (await security.node_visibility(OPERATOR))("c1", "pve9")

    _run(scenario)


def test_role_grant_and_user_beats_role(db) -> None:
    async def scenario() -> None:
        await store.save_node_scope("c1", "pve9", "*", "*", False)
        await store.save_node_scope("c1", "pve9", "role", "operator", True)
        assert (await security.node_visibility(OPERATOR))("c1", "pve9")

        # 用户级拒绝优先于角色级允许（个别例外压过批量授权）
        await store.save_node_scope("c1", "pve9", "user", "test02", False)
        assert not (await security.node_visibility(OPERATOR))("c1", "pve9")

    _run(scenario)


def test_grant_is_scoped_to_connection_and_node(db) -> None:
    async def scenario() -> None:
        await store.save_node_scope("c1", "pve9", "*", "*", False)
        # 另一条连接上的同名节点不受影响（节点名只在连接内唯一）
        assert (await security.node_visibility(OPERATOR))("c2", "pve9")

    _run(scenario)


def test_ensure_node_allowed_raises(db) -> None:
    async def scenario() -> None:
        await store.save_node_scope("c1", "pve9", "*", "*", False)
        with pytest.raises(HTTPException) as exc:
            await security.ensure_node_allowed(OPERATOR, "c1", "pve9")
        assert exc.value.status_code == 403

        await security.ensure_node_allowed(OPERATOR, "c1", "pve1")

    _run(scenario)
