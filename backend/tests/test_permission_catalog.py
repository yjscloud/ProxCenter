"""权限目录自检：目录 ↔ 代码 ↔ 前端清单，三边必须对得上。

加一个权限点时最容易漏掉"另一半"，而三种漏法在界面上都表现为**功能凭空消失**：

* 目录漏了键 —— 接口用 ``require_permission("vm.foo")`` 把关，勾选界面里却没有这一项，
  于是这个能力谁都授不出去；
* 前端清单漏了键 —— 管理员勾得动，前端判定不认，按钮不显示（后端倒是放行）；
* 前端清单多了键 —— 界面勾得动，后端不认，点了 403。

前端那份清单是**手写**的（理由见 ``src/api/permissions.ts``：字面量拼错时两端都是
静默失败，换成联合类型才挡得住），手写就意味着会漂移，所以用这个用例兜底。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app import security

BACKEND_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BACKEND_DIR / "app"
FRONTEND_KEYS_FILE = (
    Path(__file__).resolve().parent.parent.parent / "src" / "api" / "permissions.ts"
)

# require_permission("x.y") / require_any_permission("x.y", "z.w")，也覆盖
# `VIEW = security.require_permission("ports.view")` 这种先定义后引用的写法
_CALL = re.compile(r"require_(?:any_)?permission\(\s*([^)]*)\)")
# 形如 `域.动作` 的字符串字面量（``vm.view`` / ``ct.firewall.view``）
_KEY = re.compile(r"[\"']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)[\"']")


def _keys_used_in_code() -> set:
    used: set = set()
    for path in APP_DIR.rglob("*.py"):
        for args in _CALL.findall(path.read_text(encoding="utf-8")):
            used.update(_KEY.findall(args))
    return used


def test_catalog_covers_code_permissions():
    """接口用到的每个权限键都得能在目录里勾出来。"""
    used = _keys_used_in_code()
    # 正则一旦失效，used 就是空集，下面那条断言会永远成立（假绿）——
    # 所以先证明真的从代码里抓到了东西
    assert len(used) > 40, f"只从代码里抓到 {len(used)} 个权限键，检查 _CALL / _KEY 正则"
    missing = sorted(used - security.permission_keys())
    assert not missing, (
        f"这些权限键被接口使用，却不在 PERMISSION_CATALOG 里（勾选界面看不到）：{missing}"
    )


def test_builtin_roles_use_catalog_keys():
    """内置角色的权限必须都在目录里 —— 否则前端会把它们画成"没有说明"的空勾。"""
    catalog = security.permission_keys()
    for role, perms in security.ROLE_PERMISSIONS.items():
        # `*` 是超管标记，不来自目录（见 security.validate_permissions）
        unknown = sorted(set(perms) - catalog - {"*"})
        assert not unknown, f"内置角色 {role} 用了目录外的权限键：{unknown}"


def test_frontend_keys_match_catalog():
    """前端 api/permissions.ts 的清单必须与目录一致（双向）。"""
    if not FRONTEND_KEYS_FILE.exists():
        pytest.skip("前端源码不在场（只部署了 backend）")

    text = FRONTEND_KEYS_FILE.read_text(encoding="utf-8")
    parts = text.split("export const PERMISSION_KEYS", 1)
    assert len(parts) == 2, "没找到前端的 PERMISSION_KEYS 清单"
    declared = set(_KEY.findall(parts[1].split("] as const", 1)[0]))
    assert len(declared) > 40, f"前端清单只解析出 {len(declared)} 个键，检查 _KEY 正则"

    catalog = security.permission_keys()
    assert declared == catalog, (
        "前端清单与后端目录不一致 —— "
        f"前端少了：{sorted(catalog - declared)}；前端多了：{sorted(declared - catalog)}"
    )
