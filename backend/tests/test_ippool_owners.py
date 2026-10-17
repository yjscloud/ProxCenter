"""IP 地址池的归属用户：谁看得到哪一段地址。

池是「从哪儿给谁取地址」的资源，归属判定两个方向都会出事：判宽了，普通用户会把
地址配到不属于自己的网段（地址发下去也不通）；判窄了，客户打开地址池看到的是空的
（表现就是「指定了归属、保存了，但没生效」）。所以这里盯的是**接口返回**，而不是
只测归一化函数 —— 归一化对了、过滤写错了同样会「没生效」。

三种归属（见 ``utils/ippool.ts`` 与 ``routers/ip_pools.py`` 的约定）：

* ``owners = []``     公共池：只有管理员看得到；
* ``owners = ["*"]``  全部用户：谁都看得到；
* ``owners = [a, b]`` 指定用户：只有名单里的人看得到。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers, user_with_permissions  # noqa: E402,F401


POOL: Dict[str, Any] = {
    "id": "pool-1",
    "name": "客户网段",
    "bridge": "vmbr0",
    "subnet": "192.168.50.0/24",
    "gateway": "192.168.50.1",
    "start": "192.168.50.100",
    "end": "192.168.50.105",
    "nodes": [],
    "connections": [],
    "vlan": None,
    "owners": [],
}


def _put(api, headers, **overrides) -> Dict[str, Any]:
    resp = api.put("/api/ip-pools", headers=headers, json=[{**POOL, **overrides}])
    assert resp.status_code == 200, resp.text
    return resp.json()


def _ids(api, headers) -> List[str]:
    resp = api.get("/api/ip-pools", headers=headers)
    assert resp.status_code == 200, resp.text
    return [pool["id"] for pool in resp.json()["pools"]]


def _store_raw(rows: List[Dict[str, Any]]) -> None:
    """直接把池行写进 settings，模拟**升级前落下的老数据**。

    为什么不用接口写：接口写出来的行一定是新形状（只有 ``owners``），而这几条用例
    要的正是「库里躺着一行老数据」。``settings`` 表是 ``key``/``value`` 两列。
    """
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO settings (`key`, `value`) VALUES ('ip_pools', %s) "
                "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                (json.dumps(rows, ensure_ascii=False),),
            )
    finally:
        conn.close()


def test_admin_round_trip_keeps_the_owners(api) -> None:
    """管理员保存后再读回来，归属名单要原样在（顺带确认只出 owners 一个字段）。"""
    admin = auth_headers(api)
    body = _put(api, admin, owners=["alice", "bob"])
    assert body["pools"][0]["owners"] == ["alice", "bob"]

    resp = api.get("/api/ip-pools", headers=admin)
    pool = resp.json()["pools"][0]
    assert pool["owners"] == ["alice", "bob"]
    # 单值时代的字段不再往外发：两套字段并存迟早有人读到过时的那一份
    assert "owner" not in pool


def test_assigned_user_sees_the_pool(api) -> None:
    admin = auth_headers(api)
    _put(api, admin, owners=["alice"])
    alice = user_with_permissions(api, ["network.view"], "alice")
    assert _ids(api, alice) == ["pool-1"]


def test_other_users_do_not_see_it(api) -> None:
    admin = auth_headers(api)
    _put(api, admin, owners=["alice"])
    bob = user_with_permissions(api, ["network.view"], "bob")
    assert _ids(api, bob) == []


def test_all_users_wildcard(api) -> None:
    """``["*"]``：任何登录用户都能看到并使用。"""
    admin = auth_headers(api)
    body = _put(api, admin, owners=["*", "alice"])
    # 勾了「全部用户」就不再需要具体名单，存下来只有它自己
    assert body["pools"][0]["owners"] == ["*"]

    alice = user_with_permissions(api, ["network.view"], "alice")
    bob = user_with_permissions(api, ["network.view"], "bob")
    assert _ids(api, alice) == ["pool-1"]
    assert _ids(api, bob) == ["pool-1"]
    assert _ids(api, admin) == ["pool-1"]


def test_public_pool_is_admin_only(api) -> None:
    """空名单 = 公共池（仅管理员）：普通用户一条都看不到，管理员照旧。"""
    admin = auth_headers(api)
    _put(api, admin, owners=[])
    alice = user_with_permissions(api, ["network.view"], "alice")
    assert _ids(api, alice) == []
    assert _ids(api, admin) == ["pool-1"]


def test_owners_are_normalized(api) -> None:
    """界面送进来的空白 / 重复项 / 空串，存下来都要收拾干净。"""
    admin = auth_headers(api)
    body = _put(api, admin, owners=[" alice ", "alice", "", "bob"])
    assert body["pools"][0]["owners"] == ["alice", "bob"]


def test_legacy_single_owner_payload_is_honored(api) -> None:
    """还没刷新的旧页面只发单值 ``owner``：不能当成「没设归属」把池收回去。"""
    admin = auth_headers(api)
    payload = {**POOL, "owner": "alice"}
    payload.pop("owners")
    resp = api.put("/api/ip-pools", headers=admin, json=[payload])
    assert resp.status_code == 200, resp.text
    assert resp.json()["pools"][0]["owners"] == ["alice"]

    alice = user_with_permissions(api, ["network.view"], "alice")
    assert _ids(api, alice) == ["pool-1"]


def test_legacy_stored_row_still_belongs_to_its_owner(api) -> None:
    """库里躺着的老池只有单值 owner，读的时候要能认出来 —— 否则升级后客户就看不见了。"""
    admin = auth_headers(api)
    legacy = {key: value for key, value in POOL.items() if key != "owners"}
    _store_raw([{**legacy, "owner": "alice"}])
    assert _ids(api, admin) == ["pool-1"], "老数据没读出来，下面的断言就没有意义"

    alice = user_with_permissions(api, ["network.view"], "alice")
    assert _ids(api, alice) == ["pool-1"]
    bob = user_with_permissions(api, ["network.view"], "bob")
    assert _ids(api, bob) == []


def test_empty_owners_does_not_shadow_the_legacy_owner(api) -> None:
    """一行里同时有 ``owners: []`` 和 ``owner: "alice"`` 时按归属算，不能读成公共池。

    新代码写下的行不会出现这种组合（保存时会把 ``owner`` 丢掉），但迁移到一半、
    或者手工改过的数据会出现 —— 而把它读成公共池，等于在管理员毫不知情的情况下
    撤销了归属。读取的优先级因此与保存一致：``owners`` 非空才用它。
    """
    admin = auth_headers(api)
    _store_raw([{**POOL, "owner": "alice"}])
    assert _ids(api, admin) == ["pool-1"]

    alice = user_with_permissions(api, ["network.view"], "alice")
    assert _ids(api, alice) == ["pool-1"]
