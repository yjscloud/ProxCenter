"""个人 API Token：生成 / 校验 / 吊销 / 保留清理，以及它接入鉴权链后的行为。

分两层驱动，两层各有自己的数据库连接方式：

* **模块层**（生成、校验、吊销、清理）用 ``asyncio.run`` 直接调
  :mod:`app.apitokens`，配 ``db`` 夹具 —— 只建表、不启动 app。**不能**借
  ``api`` 夹具：TestClient 的全局连接池绑在它自己的事件循环上，模块层再用
  ``asyncio.run`` 新建一个循环去碰同一个池，两个循环会互相踩。
* **接口 / 鉴权层**用 ``api`` 夹具的 TestClient。这一层**只用同步 pymysql
  查库**与真实 HTTP 请求做断言，绝不调 ``asyncio.run``，从根上避开跨循环。

被测的关键控制（错了就等于开后门）：

* 明文只在创建响应里出现一次，库里只有 SHA-256；
* 已吊销 / 已过期 / 不存在的令牌一律拒绝；
* 令牌继承用户角色权限，但**拒绝**所有二次确认接口；
* 令牌不能管理令牌（否则吊销永远追不上派生出来的那枚）；
* 改密码 / 退出所有设备 / 管理员禁用账号，都必须把令牌一起带走。
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import apitokens, database  # noqa: E402
from app.config import settings  # noqa: E402
from conftest import connect  # noqa: E402
from test_api_routes import api, auth_headers  # noqa: E402,F401

ADMIN_PASSWORD = settings.admin_password
VIEWER_PASSWORD = "Unit-Test-Pa55word"


# ------------------------------------------------------------------ 测试工具
async def _shutdown_pool(coro):
    """跑完协程顺手关掉连接池（它绑在 asyncio.run 新建的循环上）。"""
    try:
        return await coro
    finally:
        await database.close_pool()


def _run(coro):
    return asyncio.run(_shutdown_pool(coro))


@pytest.fixture()
def db(clean_mysql_db):
    """只建表、不启动 app（见模块说明）。

    ``store.init_db()`` 只建 ``store.SCHEMA`` 里的那几张表，``api_tokens`` 是
    :mod:`app.apitokens` 自己的表（走 ``init_table()``）—— 这条建表链平时由
    lifespan 串起来，这里不启动 app 就得自己接上。
    """
    from app import store

    _run(store.init_db())
    _run(apitokens.init_table())
    yield


def _exec(sql: str, params: Optional[tuple] = None) -> List[Any]:
    """同步执行一条 SQL（conftest 的 connect 是 autocommit）。"""
    conn = connect(settings.db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or ())
            return cursor.fetchall()
    finally:
        conn.close()


def _sha256(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _token_usable(plain: str) -> bool:
    """直接查库判断这枚令牌当前是否有用。

    刻意不走 :func:`apitokens.authenticate`：那个函数要用异步连接池，而本文件
    里调用它的用例都带着 ``api`` 夹具（TestClient 有自己的事件循环）。这里按
    「未吊销且未过期」复刻一遍判定 —— 复刻得对不对由模块层用例保证。
    """
    rows = _exec(
        "SELECT revoked, expires_at FROM api_tokens WHERE token_hash = %s",
        (_sha256(plain),),
    )
    if not rows:
        return False
    revoked, expires_at = rows[0]
    if revoked:
        return False
    return not (expires_at and float(expires_at) <= time.time())


def _token_exists(token_id: int) -> bool:
    return bool(_exec("SELECT id FROM api_tokens WHERE id = %s", (token_id,)))


def _issue(api, name: str, ttl_days: int = 90, headers: Optional[Dict[str, str]] = None) -> str:
    """通过接口签发一枚令牌，返回明文。"""
    resp = api.post(
        "/api/tokens",
        json={"name": name, "ttl_days": ttl_days},
        headers=headers or auth_headers(api),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["token"]


def _as_token(plain: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {plain}"}


def _drop_session_cookies(api) -> None:
    """清掉会话 Cookie，逼着后面的请求真的走令牌鉴权。

    ``api`` 夹具登录过，Cookie 里还留着会话 —— 不清掉的话，即使令牌被拒，
    请求也会因为 Cookie 而成功，用例就变成「什么都没测到」。
    """
    api.cookies.clear()


# ================================================================ 模块层
class TestTokenModule:
    def test_create_returns_plaintext_but_stores_only_hash(self, db) -> None:
        created = _run(apitokens.create("admin", name="采集", ttl_days=30))
        plain = created["token"]

        assert plain.startswith(apitokens.PREFIX)
        assert created["prefix"] == plain[: len(apitokens.PREFIX) + 8]
        rows = _exec("SELECT token_hash FROM api_tokens WHERE id = %s", (created["id"],))
        assert rows and rows[0][0] == _sha256(plain)
        assert rows[0][0] != plain

    def test_authenticate_accepts_a_valid_token(self, db) -> None:
        created = _run(apitokens.create("admin", name="采集", ttl_days=30))
        record = _run(apitokens.authenticate(created["token"], ip="10.0.0.9"))
        assert record is not None
        assert record["username"] == "admin"
        assert int(record["id"]) == created["id"]

    def test_authenticate_rejects_unknown_revoked_and_expired(self, db) -> None:
        created = _run(apitokens.create("admin", name="将被吊销"))
        _run(apitokens.revoke(int(created["id"])))

        assert _run(apitokens.authenticate(created["token"])) is None
        # 形状对但从未签发过
        assert _run(apitokens.authenticate(apitokens.PREFIX + "nope-nope-nope")) is None

        # 已过期：直接改库里的 expires_at，绕开「创建时算 TTL」
        expired = _run(apitokens.create("admin", name="已过期"))
        _exec(
            "UPDATE api_tokens SET expires_at = %s WHERE id = %s",
            (time.time() - 10, expired["id"]),
        )
        assert _run(apitokens.authenticate(expired["token"])) is None

    def test_authenticate_ignores_non_token_strings(self, db) -> None:
        assert _run(apitokens.authenticate("eyJhbGciOiJIUzI1NiJ9.payload.sig")) is None
        assert _run(apitokens.authenticate("")) is None
        assert apitokens.looks_like_token("eyJhbGci") is False
        assert apitokens.looks_like_token(apitokens.PREFIX + "x") is True

    def test_revoke_respects_ownership(self, db) -> None:
        created = _run(apitokens.create("admin", name="别人的"))

        # 换个用户名去吊销：不能成功
        assert _run(apitokens.revoke(int(created["id"]), username="someone-else")) is False
        assert _run(apitokens.authenticate(created["token"])) is not None

        # 本人（或管理员传 None）才吊销得掉
        assert _run(apitokens.revoke(int(created["id"]), username="admin")) is True
        # 已经吊销过的再吊销一次：如实回 False，而不是假装成功
        assert _run(apitokens.revoke(int(created["id"]), username="admin")) is False

    def test_revoke_all_and_count_active(self, db) -> None:
        for index in range(3):
            _run(apitokens.create("admin", name=f"t{index}"))

        assert _run(apitokens.count_active("admin")) == 3
        assert _run(apitokens.revoke_all("admin")) == 3
        assert _run(apitokens.count_active("admin")) == 0
        # 空跑一次应当返回 0，而不是报错或重复计数
        assert _run(apitokens.revoke_all("admin")) == 0

    def test_count_active_excludes_expired(self, db) -> None:
        fresh = _run(apitokens.create("admin", name="有效"))
        stale = _run(apitokens.create("admin", name="过期"))
        _exec(
            "UPDATE api_tokens SET expires_at = %s WHERE id = %s",
            (time.time() - 10, stale["id"]),
        )
        assert _run(apitokens.count_active("admin")) == 1
        assert int(fresh["id"]) != int(stale["id"])

    def test_purge_expired_only_removes_stale_rows(self, db) -> None:
        old = _run(apitokens.create("admin", name="很老的过期项"))
        recent = _run(apitokens.create("admin", name="刚过期"))
        _exec(
            "UPDATE api_tokens SET expires_at = %s WHERE id = %s",
            (time.time() - 100 * 86_400, old["id"]),
        )
        _exec(
            "UPDATE api_tokens SET expires_at = %s WHERE id = %s",
            (time.time() - 10, recent["id"]),
        )

        assert _run(apitokens.purge_expired()) == 1
        remaining = {row[0] for row in _exec("SELECT id FROM api_tokens")}
        assert int(recent["id"]) in remaining
        assert int(old["id"]) not in remaining

    def test_last_used_is_written_but_throttled(self, db) -> None:
        created = _run(apitokens.create("admin", name="采集"))
        assert created["last_used"] == 0

        _run(apitokens.authenticate(created["token"], ip="10.1.2.3"))
        (last_used, last_ip) = _exec(
            "SELECT last_used, last_ip FROM api_tokens WHERE id = %s", (created["id"],)
        )[0]
        assert last_used > 0
        assert last_ip == "10.1.2.3"

        # 节流窗口内不重复写：把 last_ip 改成哨兵值再认证一次，
        # 如果被覆盖就说明每次请求都在写库。
        _exec("UPDATE api_tokens SET last_ip = 'sentinel' WHERE id = %s", (created["id"],))
        _run(apitokens.authenticate(created["token"], ip="10.9.9.9"))
        (still,) = _exec("SELECT last_ip FROM api_tokens WHERE id = %s", (created["id"],))[0]
        assert still == "sentinel"

    def test_generate_produces_distinct_secrets(self, db) -> None:
        assert len({apitokens.generate()[1] for _ in range(20)}) == 20


# ================================================================ 接口层
class TestTokenRouter:
    def test_list_is_empty_and_reports_limits(self, api) -> None:
        resp = api.get("/api/tokens", headers=auth_headers(api))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["items"] == []
        assert body["active"] == 0
        assert body["enabled"] is True
        assert body["max"] >= 1
        assert body["default_ttl_days"] == apitokens.DEFAULT_TTL_DAYS

    def test_create_then_list_never_repeats_the_plaintext(self, api) -> None:
        plain = _issue(api, "监控采集")
        assert plain.startswith(apitokens.PREFIX)

        resp = api.get("/api/tokens", headers=auth_headers(api))
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["name"] == "监控采集"
        # 列表里不能出现明文，也不能有摘要
        assert "token" not in items[0]
        assert "token_hash" not in items[0]
        assert plain not in resp.text

    def test_create_requires_a_name(self, api) -> None:
        resp = api.post("/api/tokens", json={"name": "   "}, headers=auth_headers(api))
        assert resp.status_code == 400
        assert "名字" in resp.json()["detail"]

    def test_create_enforces_the_per_user_quota(self, api) -> None:
        headers = auth_headers(api)
        limit = max(int(settings.api_token_max_per_user), 1)
        for index in range(limit):
            _issue(api, f"t{index}", headers=headers)

        resp = api.post("/api/tokens", json={"name": "overflow"}, headers=headers)
        assert resp.status_code == 400
        assert str(limit) in resp.json()["detail"]

    def test_revoke_marks_the_token_and_drops_active(self, api) -> None:
        headers = auth_headers(api)
        created = api.post("/api/tokens", json={"name": "临时"}, headers=headers).json()

        resp = api.delete(f"/api/tokens/{created['id']}", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["active"] == 0

        items = api.get("/api/tokens", headers=headers).json()["items"]
        assert items[0]["revoked"] is True
        # 吊销后立即失效
        assert _token_usable(created["token"]) is False

    def test_revoke_of_someone_elses_token_is_404(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "tokviewer", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        victim_token = _issue(api, "别人的", headers=admin)
        victim_id = api.get("/api/tokens", headers=admin).json()["items"][0]["id"]

        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokviewer", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        resp = api.delete(f"/api/tokens/{victim_id}", headers=viewer)
        assert resp.status_code == 404
        # 别人的令牌必须仍然可用 —— 越权吊销是「误伤」，比越权读更危险
        assert _token_usable(victim_token) is True

    def test_list_only_shows_own_tokens(self, api) -> None:
        admin = auth_headers(api)
        _issue(api, "管理员的", headers=admin)
        api.post(
            "/api/users",
            json={"username": "tokviewer2", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokviewer2", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        assert api.get("/api/tokens", headers=viewer).json()["items"] == []


# ================================================================ 鉴权链
class TestTokenAuth:
    def test_token_authenticates_read_requests(self, api) -> None:
        plain = _issue(api, "采集")
        _drop_session_cookies(api)

        resp = api.get("/api/vms", headers=_as_token(plain))
        assert resp.status_code == 200, resp.text

    def test_invalid_token_is_401(self, api) -> None:
        _drop_session_cookies(api)
        resp = api.get("/api/vms", headers=_as_token(apitokens.PREFIX + "bogus-bogus"))
        assert resp.status_code == 401
        assert "Token" in resp.json()["detail"]

    def test_non_token_bearer_is_rejected_as_bad_jwt(self, api) -> None:
        """前缀分流只认 ``zp_``：别的字符串仍走 JWT 解码，不能误判成令牌。"""
        _drop_session_cookies(api)
        resp = api.get("/api/vms", headers=_as_token("not-a-real-jwt"))
        assert resp.status_code == 401

    def test_revoked_token_stops_working_immediately(self, api) -> None:
        headers = auth_headers(api)
        plain = _issue(api, "采集", headers=headers)
        token_id = api.get("/api/tokens", headers=headers).json()["items"][0]["id"]
        assert api.delete(f"/api/tokens/{token_id}", headers=headers).status_code == 200

        _drop_session_cookies(api)
        assert api.get("/api/vms", headers=_as_token(plain)).status_code == 401

    def test_token_is_refused_on_step_up_endpoints(self, api) -> None:
        """核心安全约束：无人值守的长期凭据不能做不可逆操作。

        响应头刻意用 ``X-Step-Up: unsupported`` 而不是 ``required``：前端的
        拦截器只认 required，会弹出「请输入登录密码」的框，而脚本永远填不上，
        只会让人以为面板坏了。
        """
        admin = auth_headers(api)
        plain = _issue(api, "脚本", headers=admin)
        # 删虚拟机是 require_step_up 的接口；用一个不存在的 vmid 也无所谓 ——
        # 校验发生在业务逻辑之前，必须是被二次确认拦下（403）而不是 404。
        _drop_session_cookies(api)
        resp = api.delete("/api/vms/pve1/999", headers=_as_token(plain))
        assert resp.status_code == 403, resp.text
        assert resp.headers.get("x-step-up") == "unsupported"
        assert "API Token" in resp.json()["detail"]

    def test_token_cannot_manage_tokens(self, api) -> None:
        """令牌不能签发令牌：否则吊销一枚后，它派生出来的那枚还在。"""
        admin = auth_headers(api)
        plain = _issue(api, "脚本", headers=admin)
        _drop_session_cookies(api)

        create = api.post("/api/tokens", json={"name": "派生"}, headers=_as_token(plain))
        assert create.status_code == 403
        assert "凭据" in create.json()["detail"]

        # 列表用的是 get_current_user（只读，允许），但拿不到任何明文/摘要字段
        listed = api.get("/api/tokens", headers=_as_token(plain))
        assert listed.status_code == 200
        assert all("token" not in item for item in listed.json()["items"])

    def test_token_inherits_role_permissions(self, api) -> None:
        """viewer 的令牌不能做写操作 —— 令牌不比它主人更能干。"""
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "tokviewer3", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokviewer3", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        created = api.post("/api/tokens", json={"name": "只读"}, headers=viewer).json()

        _drop_session_cookies(api)
        headers = _as_token(created["token"])
        # 读得到
        assert api.get("/api/vms", headers=headers).status_code == 200
        # 写不了（viewer 没有 users.manage）
        assert api.get("/api/users", headers=headers).status_code == 403

    def test_disabled_account_kills_its_tokens(self, api) -> None:
        """禁用账号会让令牌**彻底吊销**，而不是「令牌仍有效但被状态挡住」。

        两种都拦得住，但差别是实质性的：前者把令牌标记为已吊销（``revoked = 1``），
        「这个用户名下还有一枚可用凭据」这个事实不再成立；后者令牌还是有效的，
        只在这条鉴权链上被用户状态半路拦下 —— 一旦哪天状态判断的路径被绕过，
        令牌就又能用了。所以这里断言的是 401（令牌已失效）而不是 403。
        """
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "tokdisable", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokdisable", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        plain = api.post(
            "/api/tokens", json={"name": "将被禁用"}, headers=viewer
        ).json()["token"]

        # 还没禁用时可用
        _drop_session_cookies(api)
        assert api.get("/api/vms", headers=_as_token(plain)).status_code == 200

        admin = auth_headers(api)
        resp = api.put("/api/users/tokdisable", json={"enabled": False}, headers=admin)
        assert resp.status_code == 200, resp.text

        _drop_session_cookies(api)
        blocked = api.get("/api/vms", headers=_as_token(plain))
        assert blocked.status_code == 401
        assert "Token" in blocked.json()["detail"]
        # 不只是这次请求被拦：令牌本身已被标记吊销
        assert _token_usable(plain) is False

    def test_disabling_the_feature_blocks_all_tokens(self, api, monkeypatch) -> None:
        plain = _issue(api, "采集")
        monkeypatch.setattr(settings, "api_token_enabled", False, raising=False)

        _drop_session_cookies(api)
        resp = api.get("/api/vms", headers=_as_token(plain))
        assert resp.status_code == 403
        assert "停用" in resp.json()["detail"]


# ================================================================ 凭据生命周期
class TestCredentialRevocation:
    def test_password_change_revokes_every_token(self, api) -> None:
        headers = auth_headers(api)
        plain = _issue(api, "采集", headers=headers)

        resp = api.post(
            "/api/auth/password",
            json={
                "current_password": ADMIN_PASSWORD,
                "new_password": "Rotated-Pa55word!",
                "totp_code": "",
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["api_tokens_revoked"] == 1
        assert _token_usable(plain) is False

    def test_logout_all_revokes_every_token(self, api) -> None:
        headers = auth_headers(api)
        plain = _issue(api, "采集", headers=headers)

        resp = api.post("/api/auth/logout-all", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["api_tokens_revoked"] == 1
        assert _token_usable(plain) is False

    def test_admin_revoke_sessions_revokes_tokens(self, api) -> None:
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "tokkick", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokkick", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        plain = api.post("/api/tokens", json={"name": "将被踢"}, headers=viewer).json()[
            "token"
        ]

        admin = auth_headers(api)
        resp = api.post("/api/users/tokkick/revoke-sessions", headers=admin)
        assert resp.status_code == 200, resp.text
        assert resp.json()["api_tokens_revoked"] == 1
        assert _token_usable(plain) is False

    def test_admin_disabling_user_revokes_tokens(self, api) -> None:
        """管理员改状态时也要把令牌带走，否则「禁用」对脚本形同虚设。"""
        admin = auth_headers(api)
        api.post(
            "/api/users",
            json={"username": "tokban", "password": VIEWER_PASSWORD, "role": "viewer"},
            headers=admin,
        )
        viewer = {
            "Authorization": "Bearer "
            + api.post(
                "/api/auth/login",
                json={"username": "tokban", "password": VIEWER_PASSWORD},
            ).json()["access_token"]
        }
        created = api.post("/api/tokens", json={"name": "将被停用"}, headers=viewer).json()

        admin = auth_headers(api)
        api.put("/api/users/tokban", json={"enabled": False}, headers=admin)
        assert _token_usable(created["token"]) is False
        assert _token_exists(created["id"]) is True  # 软删除：记录仍在，只是失效


def test_db_fixture_does_not_leak_into_api_fixture(api) -> None:
    """两个夹具各自管好自己的连接池：混用会互相踩，这里守住这个边界。

    只要 ``api`` 能正常读到空表（接口返回 200 而不是 500），就说明上一个用例
    用 ``db`` 夹具建/关的池没有污染 TestClient 的循环。
    """
    resp = api.get("/api/tokens", headers=auth_headers(api))
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"] == []
