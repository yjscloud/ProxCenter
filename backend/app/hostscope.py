"""受管主机的可见范围与访问校验（安全类功能的用户隔离入口）。

「安全」这四个功能（SSH 安全 / 安全基线 / 端口与进程 / 登录审计）的数据来自
两类主机：

* **面板本机**（``host_id = "local"``）：面板自己所在那台服务器。它没有「归属」
  可言，**固定只有管理员能看** —— 把宿主机的登录爆破记录、端口清单发给普通
  用户并不合理，那既不是他的机器，也不是他能处置的东西。
  另外它**默认不管控**，需要用户显式导入（见 :mod:`app.localhost`）。
* **受管主机**（``ssh_hosts``）：归属记在 ``resource_owner``（kind =
  ``ssh_host``，ref = 主机 id），**谁添加的归谁**。

于是管理员看全部、普通用户只看得到自己添加的那几台。

这里只回答「谁能看哪些主机」；「能不能用这个功能」仍由各接口的权限位
（``ssh.view`` / ``baseline.view`` / ``ports.view``）把关 —— 管理员可以用
自定义角色决定要不要把功能授权给普通用户；一旦授权，普通用户看到的就是
他自己那几台机器。

关于本机，本模块管两件事：**已导入**（``localhost.enabled()``）与**是管理员**。
前者对所有人生效（连管理员也不例外，否则「默认不管控」就形同虚设），
后者只针对普通用户。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Set

from fastapi import Depends, HTTPException

from . import localhost, ownership, security, sshremote
from .formatters import short_hostname

logger = logging.getLogger(__name__)

LOCAL_HOST_ID = "local"


def is_local(host_id: str) -> bool:
    """``""`` 与 ``"local"`` 都表示面板本机（老接口的默认值就是空串）。"""
    return str(host_id or "") in ("", LOCAL_HOST_ID)


def _scope(user: Dict[str, Any]) -> Optional[str]:
    """``None`` = 管理员（不限）。"""
    return security.visible_owner(user)


async def visible_host_rows(user: Dict[str, Any]) -> List[Dict[str, Any]]:
    """当前用户可见的受管主机**原始行**（含加密凭据，只允许后端内部使用）。"""
    rows = await sshremote.list_hosts()
    scope = _scope(user)
    if scope is None:
        return rows
    owners = await ownership.owners_map(ownership.KIND_SSH_HOST)
    return [row for row in rows if owners.get(str(row.get("id") or "")) == scope]


async def allowed_host_ids(user: Dict[str, Any]) -> Optional[Set[str]]:
    """传给聚合函数的可见集合：``None`` = 管理员不限。

    普通用户的集合里**不含** ``local``（本机不是他的）。注意**空集合是合法值**
    ——刚授权、还没添加过主机就是这样，聚合函数必须把它当「什么都不返回」
    而不是「不限」，这也是那几个函数原本就有的语义。

    ``None`` 只表示「受管主机不限」，**不代表本机也在内** —— 本机是否算数由
    ``localhost.enabled()`` 单独决定，那五个聚合函数里都会再与一次。
    """
    scope = _scope(user)
    if scope is None:
        return None
    return {str(row.get("id") or "") for row in await visible_host_rows(user)}


def assert_admin(user: Dict[str, Any]) -> None:
    """只校验「是管理员」，不看本机是否已导入。

    本机状态查询接口用它 —— 否则未导入时连「该显示导入按钮」这件事都问不出来。
    """
    if _scope(user) is None:
        return
    raise HTTPException(
        status_code=403,
        detail="面板本机的数据仅管理员可查看；普通用户只能查看自己添加的受管主机",
    )


async def assert_local_access(user: Dict[str, Any]) -> None:
    """本机专用接口的准入：**已导入** 且 **是管理员**，缺一不可。

    未导入时返回 ``409`` 而不是 ``403`` —— 前端据此区分「本机还没接入」与
    「你没权限」，前者要提示去导入，后者只需提示无权访问。
    """
    assert_admin(user)
    if not await localhost.enabled():
        raise HTTPException(
            status_code=409,
            detail="面板本机尚未纳入安全管控；需要时请在「受管主机」里显式导入",
        )


async def assert_host_access(user: Dict[str, Any], host_id: str) -> Dict[str, Any]:
    """取受管主机并校验归属（``local`` 走本机规则）。返回原始行（含凭据）。"""
    if is_local(host_id):
        await assert_local_access(user)
        return {}
    row = await sshremote.get_host(host_id)
    if not row:
        raise HTTPException(status_code=404, detail="主机不存在")
    scope = _scope(user)
    if scope is None:
        return row
    owner = await ownership.get_owner(ownership.KIND_SSH_HOST, host_id)
    if owner != scope:
        raise HTTPException(
            status_code=403,
            detail="该受管主机不属于当前用户，无权查看或操作",
        )
    return row


async def host_owners() -> Dict[str, str]:
    """主机 id → 用户名（主机列表展示归属用）。"""
    return await ownership.owners_map(ownership.KIND_SSH_HOST)


# ------------------------------------------------- 历史记录里的主机名还原
#
# AI 会话与排查记录在建行时把当时的 ``host_name`` 抄了一份 —— 那是审计事实，
# 库里那份**不改**（「当时它叫这个」本身是有意义的）。但列表里继续显示旧名，
# 用户就对不上号了：受管主机改过名之后，打开排查记录看到的还是老名字，而这恰恰
# 是最需要一眼认出「是哪台机器」的地方。于是读的时候把展示名换成当前的名字。


async def current_display_names() -> Dict[str, str]:
    """``host_id`` → **当前**展示名（受管主机 + 面板本机）。"""
    names: Dict[str, str] = {}
    try:
        rows = await sshremote.list_hosts()
    except Exception:  # noqa: BLE001 - 名字取不到不该让记录页整体报错
        logger.warning("读取受管主机名称失败，历史记录将保留原快照名", exc_info=True)
        return names
    for row in rows:
        host_id = str(row.get("id") or "")
        name = str(row.get("name") or row.get("host") or "")
        if host_id and name:
            names[host_id] = name
    # 面板本机不在 ssh_hosts 里，名字取自运行中的 hostname。助手早期允许把本机
    # 作为排查对象，库里因此可能留下 host_id=local 的历史记录，按现在的机器名显示。
    names.setdefault(LOCAL_HOST_ID, short_hostname() or LOCAL_HOST_ID)
    return names


def apply_display_names(
    rows: Iterable[Dict[str, Any]], names: Dict[str, str]
) -> None:
    """把行里快照的 ``host_name`` 就地换成当前名字。

    **拿不到就不换**（主机已被移除时）：记录不该因为主机没了就变成一串 id，
    那时保留快照反而是唯一有意义的值。就地修改 —— 调用方拿到的本来就是新拆出来的
    dict，不必再复制一遍。
    """
    for row in rows or []:
        current = names.get(str(row.get("host_id") or ""))
        if current:
            row["host_name"] = current


async def set_host_owner(host_id: str, username: str) -> None:
    """管理员指派归属。``username`` 为空 = 收回，收回后仅管理员可见。"""
    if username:
        await ownership.set_owner(ownership.KIND_SSH_HOST, host_id, username)
    else:
        await ownership.delete_owner(ownership.KIND_SSH_HOST, host_id)


# ---------------------------------------------------------------- FastAPI 依赖
# 与 ``routers/vms.require_vm_access`` 完全同一套写法：host_id 既可能是路径参数
# （``/hosts/{host_id}``）也可能是查询参数（``?host_id=``），FastAPI 都会按名字
# 灌进来；两个都取不到时按本机处理（对普通用户即 403，方向是安全的）。

async def require_host_access(
    user: Dict[str, Any] = Depends(security.get_current_user),
    host_id: str = "",
) -> None:
    """路由依赖：本次请求的目标主机必须属于当前用户。"""
    await assert_host_access(user, host_id)


async def require_local_admin(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> None:
    """路由依赖：本机专用接口（不带 host_id 的那些）—— 已导入且仅管理员。"""
    await assert_local_access(user)


async def require_admin(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> None:
    """路由依赖：仅管理员，不要求本机已导入（本机状态查询用）。"""
    assert_admin(user)
