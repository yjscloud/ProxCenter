"""用户界面偏好接口（仪表盘布局等）。

每个用户只能读写**自己的**偏好：归属条件由接口自己拼（``user["username"]``），
不接受调用方传入用户名 —— 否则「改一个参数就能覆盖别人的仪表盘」这种越权
虽然危害不大，但完全没有存在的理由。
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import i18n, prefs, security

router = APIRouter(prefix="/api/prefs", tags=["prefs"])

# 布局里最多允许多少个 widget。前端目前只有个位数，留足余量同时挡住
# 「往里面塞一万个 id」这种把偏好表当仓库用的写法。
MAX_WIDGETS = 60


class PrefIn(BaseModel):
    """偏好值。结构随 key 而异，由 :func:`_validate` 分派校验。"""

    value: Any = None


def _validate_dashboard_layout(value: Any) -> Dict[str, Any]:
    """校验仪表盘布局的**结构**。

    刻意只校验结构，不校验 widget id 的合法性：哪些 id 存在是前端 widget
    注册表的知识，后端再维护一份清单意味着「新增一张卡片要改两个地方」，
    迟早不同步。前端拿到布局后会拿自己的注册表对账 —— 丢弃认不出的 id、
    把新增的卡片补到末尾，所以这里放宽松一点是安全的。

    真正要挡住的是「结构不是预期的形状」：那种情况下前端的对账逻辑拿不到
    可用的 order 数组，仪表盘会整个渲染不出来。
    """
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="布局必须是一个对象")

    order = value.get("order", [])
    hidden = value.get("hidden", [])
    if not isinstance(order, list) or not all(isinstance(item, str) for item in order):
        raise HTTPException(status_code=400, detail="order 必须是字符串数组")
    if not isinstance(hidden, list) or not all(isinstance(item, str) for item in hidden):
        raise HTTPException(status_code=400, detail="hidden 必须是字符串数组")
    if len(order) > MAX_WIDGETS or len(hidden) > MAX_WIDGETS:
        raise HTTPException(
            status_code=400, detail=f"布局项过多（上限 {MAX_WIDGETS} 个）"
        )

    # 去重：前端拖动逻辑出错时可能出现重复 id，那会让同一张卡片渲染两次
    seen: List[str] = []
    for item in order:
        if item not in seen:
            seen.append(item)
    deduped_hidden: List[str] = []
    for item in hidden:
        if item not in deduped_hidden:
            deduped_hidden.append(item)

    return {"order": seen, "hidden": deduped_hidden}


def _validate_language(value: Any) -> str:
    """界面语言：只接受面板支持的语言码（见 i18n.SUPPORTED）。"""
    code = i18n.normalize(value if isinstance(value, str) else None)
    if not code:
        raise HTTPException(status_code=400, detail="不支持的语言")
    return code


def _validate(key: str, value: Any) -> Any:
    if key == prefs.PREF_DASHBOARD_LAYOUT:
        return _validate_dashboard_layout(value)
    if key == prefs.PREF_LANGUAGE:
        return _validate_language(value)
    # 白名单之外的 key 在入口就已经被挡掉了，走到这里说明漏加了校验分支
    raise HTTPException(status_code=400, detail=f"暂不支持的偏好：{key}")


def _require_key(key: str) -> str:
    if not prefs.is_allowed(key):
        raise HTTPException(status_code=404, detail=f"未知的偏好：{key}")
    return key


@router.get("")
async def list_prefs(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前用户的全部偏好 + 支持的键清单。

    一次返回全部而不是按 key 逐个取：偏好数量很少，而仪表盘打开时就要用到
    它们，分多次请求只会让首屏多几个往返。``keys`` 让前端能判断「服务端是否
    认识这个偏好」，避免对着一个被下线的 key 反复写。
    """
    return {
        "prefs": await prefs.all_for(str(user.get("username") or "")),
        "keys": sorted(prefs.ALLOWED_KEYS),
    }


@router.put("/{key}")
async def save_pref(
    key: str,
    payload: PrefIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """保存一条偏好（覆盖写）。

    这是高频操作（拖一次卡片就写一次），所以**不记审计日志** —— 记了只会把
    真正重要的操作淹掉，而且「谁调过仪表盘布局」本身没有追溯价值。
    """
    _require_key(key)
    value = _validate(key, payload.value)
    try:
        await prefs.set(str(user.get("username") or ""), key, value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"key": key, "value": value}


@router.delete("/{key}")
async def reset_pref(
    key: str,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """清除一条偏好，回到「未设置」状态（前端随即用默认值）。

    「恢复默认布局」走的就是这里 —— 删掉记录而不是写一份默认值进去：这样
    将来默认布局改了，恢复过默认的用户会跟着一起变，而不是被旧副本钉住。
    """
    _require_key(key)
    removed = await prefs.delete(str(user.get("username") or ""), key)
    return {"key": key, "removed": removed}
