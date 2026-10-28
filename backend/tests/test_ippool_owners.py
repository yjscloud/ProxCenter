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


# ------------------------------------------------------- 写侧：整表覆盖的越权面
# ``PUT /api/ip-pools`` 曾经是无条件整表覆盖：任何持 network.manage 的人都能改
# 别人的 owners（或填 "*"）、还能靠「提交里不含它」把别人的池删掉。下面这几条
# 盯的就是「按 id 合并 + 归属校验」这条线。

def _owners(api, headers) -> List[List[str]]:
    resp = api.get("/api/ip-pools", headers=headers)
    assert resp.status_code == 200, resp.text
    return [pool["owners"] for pool in resp.json()["pools"]]


def _writer(api, username: str) -> Dict[str, str]:
    """只有「查看 + 管理地址池」两项权限的普通用户（模拟自定义角色）。"""
    return user_with_permissions(api, ["network.view", "network.manage"], username)


def test_non_admin_cannot_change_owners(api) -> None:
    admin = auth_headers(api)
    _put(api, admin, owners=["carol"])
    carol = _writer(api, "carol")

    resp = api.put("/api/ip-pools", headers=carol, json=[{**POOL, "owners": ["*"]}])
    assert resp.status_code == 403, resp.text
    assert _owners(api, admin) == [["carol"]], "越权请求不能改动归属"


def test_non_admin_cannot_touch_other_pool(api) -> None:
    """看不到别人的池，但可以手工构造请求 —— 必须拒绝。"""
    admin = auth_headers(api)
    _put(api, admin, owners=["alice"])
    bob = _writer(api, "bob")

    resp = api.put("/api/ip-pools", headers=bob, json=[{**POOL, "owners": ["alice"]}])
    assert resp.status_code == 403, resp.text


def test_non_admin_cannot_create_pool(api) -> None:
    """池是管理员分配的资源：普通用户不能在整表里塞新的一行。"""
    admin = auth_headers(api)
    _put(api, admin, owners=["carol"])
    carol = _writer(api, "carol")

    fresh = {**POOL, "id": "pool-new"}
    resp = api.put(
        "/api/ip-pools",
        headers=carol,
        json=[{**POOL, "owners": ["carol"]}, fresh],
    )
    assert resp.status_code == 403, resp.text
    assert _ids(api, admin) == ["pool-1"]


def test_non_admin_save_keeps_pools_they_cannot_see(api) -> None:
    """普通用户只提交自己的池：别人的池不能被整表覆盖删掉。"""
    admin = auth_headers(api)
    other = {
        **POOL,
        "id": "pool-2",
        "name": "别的网段",
        "subnet": "10.0.0.0/24",
        "gateway": "10.0.0.1",
        "start": "10.0.0.10",
        "end": "10.0.0.20",
        "owners": ["dave"],
    }
    resp = api.put(
        "/api/ip-pools",
        headers=admin,
        json=[{**POOL, "owners": ["carol"]}, other],
    )
    assert resp.status_code == 200, resp.text

    carol = _writer(api, "carol")
    resp = api.put(
        "/api/ip-pools",
        headers=carol,
        json=[{**POOL, "name": "改名", "owners": ["carol"]}],
    )
    assert resp.status_code == 200, resp.text

    assert set(_ids(api, admin)) == {"pool-1", "pool-2"}, "别人的池被覆盖删掉了"
    names = {
        pool["id"]: pool["name"]
        for pool in api.get("/api/ip-pools", headers=admin).json()["pools"]
    }
    assert names["pool-1"] == "改名"


def test_non_admin_can_delete_his_own_pool(api) -> None:
    admin = auth_headers(api)
    _put(api, admin, owners=["carol"])
    carol = _writer(api, "carol")

    resp = api.put("/api/ip-pools", headers=carol, json=[])
    assert resp.status_code == 200, resp.text
    assert _ids(api, admin) == []


def test_legacy_row_without_id_gets_a_stable_id(api) -> None:
    """老数据没有 id：读的时候要补一个稳定的，否则合并写会把「同一个池」当成新建。"""
    admin = auth_headers(api)
    legacy = {
        key: value for key, value in POOL.items() if key not in ("owners", "id")
    }
    _store_raw([{**legacy, "owners": ["carol"]}])

    ids = _ids(api, admin)
    assert len(ids) == 1 and ids[0].startswith("pool-")
    # 再读一次还是同一个 id（按内容生成，不是随机）
    assert _ids(api, admin) == ids

    carol = _writer(api, "carol")
    resp = api.put(
        "/api/ip-pools",
        headers=carol,
        json=[{**POOL, "id": ids[0], "owners": ["carol"]}],
    )
    assert resp.status_code == 200, resp.text
    assert _ids(api, admin) == ids
