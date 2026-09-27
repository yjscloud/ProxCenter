"""面板级界面开关（服务端，全局生效）：可在「设置 → 导航栏功能开关」中修改。

当前只有一组开关：``nav_disabled`` —— 逐项关闭导航栏里的入口。清单中的路径
对应侧边栏里的那一项：该项从导航栏消失，且直接输 URL 也进不去（前端路由层
把它弹回一个还开着的页面）。导航栏本身始终渲染，关的是里面的功能入口。

为什么是「关闭清单」而不是「启用清单」
--------------------------------------
新加一个页面时，它默认是**开着**的（与升级前的表现一致）。反过来存一份
「启用清单」的话，任何一次新增页面都会在管理员改过设置之后被默认关掉 ——
这种「加了功能却看不见」的问题很难排查。

为什么落 ``settings`` 表而不是 ``user_prefs``
--------------------------------------------
``settings`` 是**面板级**配置（连接、站点信息、登录验证……），改一次对所有
人生效；``user_prefs`` 是「这个人怎么看界面」（见 prefs.py 的说明）。这些开关
由管理员在系统设置里改，语义属于前者。

默认值
------
没配过（或记录损坏）时回落到「没有任何入口被关闭」，与升级前的表现完全一致。

边界说明：这里关掉的是**入口**（导航栏、顶栏菜单、Ctrl+K、直达 URL），不是
授权 —— 对应的后端接口不会因此拒绝请求。接口级的开关属于权限体系（角色与
permission），两者混在一起会出现「关个入口把别的页面一起弄挂」的连带伤害。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Iterable, List, Optional

from . import store

logger = logging.getLogger(__name__)

UI_KEY = "ui_prefs"

# 关闭清单的条数上限。导航栏总共就二十来项，留到 200 是为了容忍历史遗留的
# 子路径（/nodes/connections 这类），同时挡住把这张表当记事本用。
MAX_DISABLED_NAV = 200
MAX_NAV_PATH_LEN = 64

# 只收「站内路径」形状的值。清单会被前端当作路由前缀匹配，放任任意字符串
# 进去等于把一份不受控的数据喂给路由判断，所以这里按形状收口。
_NAV_PATH_RE = re.compile(r"^/[A-Za-z0-9\-_/]*$")


def _clean_nav_disabled(value: Any) -> List[str]:
    """整理「已关闭的入口」清单：丢掉不合形状的项、去重、排序。"""
    if isinstance(value, (str, bytes)) or not isinstance(value, Iterable):
        return []

    out: List[str] = []
    for raw in value:
        path = str(raw).strip()
        if not path or len(path) > MAX_NAV_PATH_LEN:
            continue
        if not _NAV_PATH_RE.match(path):
            continue
        # 末尾斜杠归一：/vms/ 与 /vms 是同一个入口
        path = path.rstrip("/") or "/"
        if path in out:
            continue
        out.append(path)
        if len(out) >= MAX_DISABLED_NAV:
            break
    return sorted(out)


async def get_ui_prefs() -> Dict[str, Any]:
    """读取面板界面开关；未配置或数据损坏时返回内置默认值。"""
    raw = await store.get_setting(UI_KEY)
    data: Dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("ui_prefs 配置损坏，已忽略：%r", raw)
            parsed = None
        if isinstance(parsed, dict):
            data = parsed

    return {
        # 读的时候也过一遍清洗：库里的数据可能是旧版本写入的，或被手工改过
        "nav_disabled": _clean_nav_disabled(data.get("nav_disabled")),
    }


async def set_ui_prefs(
    nav_disabled: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """保存面板界面开关，返回保存后的完整开关集合。

    ``nav_disabled`` 传 ``None`` 表示「保持当前值」—— 前端只提交改过的那一项
    时，不会把其余设置重置掉。
    """
    current = await get_ui_prefs()
    payload = {
        "nav_disabled": current["nav_disabled"]
        if nav_disabled is None
        else _clean_nav_disabled(nav_disabled),
    }
    await store.set_setting(UI_KEY, json.dumps(payload, ensure_ascii=False))
    return payload
