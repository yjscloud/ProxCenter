"""重置客户机（虚拟机 / 容器）里某个用户的口令。

面板是**纯 API 客户端**（自己跑在别的机器上，没有节点 shell），所以「改客户机
里的密码」必须借客户机自己、或宿主机的现成通道。一共三条：

====================  ======================================  =================================
方式                  做法                                        前提
====================  ======================================  =================================
``agent``             客户机内的 ``guest-set-user-password``，     虚拟机运行中，且装了
                      即时生效、不重启；老 agent 不认这条命令时    qemu-guest-agent
                      退回在客户机里执行 ``chpasswd``
``cloudinit``         写 ``cipassword`` ＋ 重新生成 config        虚拟机带 cloud-init 盘
                      drive ＋ 重启，由 cloud-init 在开机时落地
``ssh``               借「SSH → 受管主机」里该宿主机的凭据执行    容器运行中，且该宿主机在
                      ``pct exec <vmid> -- chpasswd``            受管主机里有可用凭据
====================  ======================================  =================================

**容器为什么只能走 SSH**：PVE 的 API 里没有「在容器里执行命令」这个端点 ——
对 PVE 9.2 的 API schema 逐条核对过：``/nodes/{node}/lxc/{vmid}`` 下没有 exec、
也没有 set-password；``termproxy`` 只接 ``node`` / ``vmid``，不接受自定义命令
（只有**节点级**的 termproxy 有 ``cmd``，取值还被限制成 login / upgrade /
ceph_install）；容器配置项里同样没有 ``ci*`` 那一套（cloud-init 只对虚拟机生效，
这是 PVE 的限制）。所以容器要么走宿主机 SSH，要么只能让用户进控制台 ``passwd``。
"""
from __future__ import annotations

import asyncio
import base64
import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from . import pve, security, sshremote
from .formatters import decode_agent_output
from .pve import ProxmoxError

# 方式 id：前端单选组直接用它当 value，接口回包也用同一个词
AGENT = "agent"
CLOUDINIT = "cloudinit"
SSH = "ssh"

VM_KIND = "qemu"
CT_KIND = "lxc"

# 客户机内的用户名。POSIX 用户名，顺带覆盖 Windows 的 Administrator：
# 首字符必须是字母或下划线，后面允许字母数字与 . _ - $（末尾 $ 是机器账号的写法）。
USERNAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9._$-]{0,31}$")

# 客户机内执行命令的轮询节奏：约 12 秒。chpasswd 是毫秒级的，
# 这点余量只为应对「客户机卡住」这种情况。
_AGENT_POLL_INTERVAL = 0.25
_AGENT_POLL_ATTEMPTS = 48
# agent ping 的超时：客户机没装 agent 时 PVE 会等到底，不能无限期挂着
_AGENT_PING_TIMEOUT = 6.0
# 宿主机上跑 pct exec 的超时
_SSH_TIMEOUT = 30

DEFAULT_USERNAME = "root"


# =============================================================== 能力探测
def _option(
    mid: str,
    label: str,
    description: str,
    *,
    available: bool,
    reason: str = "",
    restarts: bool = False,
) -> Dict[str, Any]:
    """一个可选的重置方式。

    ``available=False`` 时 ``reason`` 必须写清「为什么不行」，前端会原样显示 ——
    用户看到「不能选」时必须同时知道缺什么，否则他只能去猜。
    """
    return {
        "id": mid,
        "label": label,
        "description": description,
        "available": available,
        "reason": reason,
        "restarts": restarts,
    }


def _has_cloudinit_drive(config: Dict[str, Any]) -> bool:
    """虚拟机是否挂了 cloud-init 盘（``ide2: local:100/vm-100-cloudinit.qcow2``）。

    没有这块盘，写 ``cipassword`` 只是往配置里塞一个没人读的键，重启也白搭。
    """
    return any("cloudinit" in str(value).lower() for value in (config or {}).values())


async def _is_running(client: Any, node: str, vmid: int, kind: str) -> bool:
    """客户机是否在运行。读不到状态时按「没在运行」处理，别让对话框整体报错。"""
    try:
        status = await (
            client.lxc_status(node, vmid)
            if kind == CT_KIND
            else client.qemu_status(node, vmid)
        )
    except ProxmoxError:
        return False
    return str((status or {}).get("status") or "") == "running"


async def _agent_alive(client: Any, node: str, vmid: int) -> bool:
    """客户机里的 qemu-guest-agent 是否应答。"""
    try:
        await asyncio.wait_for(
            client.qemu_agent_ping(node, vmid), timeout=_AGENT_PING_TIMEOUT
        )
        return True
    except (ProxmoxError, asyncio.TimeoutError):
        return False


def _connection_hosts() -> List[str]:
    """当前（及默认）PVE 连接的地址，用来匹配「SSH → 受管主机」。"""
    from . import store

    hosts: List[str] = []
    conns = store.get_connections()
    conn_id = pve.requested_connection() or str(store.get_active_connection_id() or "")
    ordered = [c for c in conns if str(c.get("id") or "") == conn_id] + [
        c for c in conns if str(c.get("id") or "") != conn_id
    ]
    for conn in ordered:
        host = str(conn.get("host") or "")
        if host and host not in hosts:
            hosts.append(host)
    return hosts


async def _ssh_host(node: str) -> Optional[Dict[str, Any]]:
    """找这台宿主机在「SSH → 受管主机」里的凭据。

    先按 PVE 连接地址匹配（用户多半就是把连接地址那台加了进去），再退回按
    受管主机的名称匹配节点名 —— 集群里各节点地址不同，只加了一台是很常见的情况。
    """
    rows = [row for row in await sshremote.list_hosts() if row.get("enabled")]
    if not rows:
        return None
    wanted = _connection_hosts()
    for address in wanted:
        for row in rows:
            if str(row.get("host") or "") == address:
                return row
    for row in rows:
        if str(row.get("name") or "") == node:
            return row
    return None


def _ssh_missing_reason(node: str) -> str:
    hosts = "、".join(_connection_hosts()) or "当前 PVE 连接地址"
    return (
        f"宿主机 {node}（{hosts}）还没在「SSH → 受管主机」里配置凭据；"
        "PVE 的 API 没有「在容器里执行命令」的端点，这条是容器唯一可走的通道"
    )


async def inspect(
    kind: str, client: Any, node: str, vmid: int
) -> Dict[str, Any]:
    """这台客户机现在能走哪几条路，返回给前端渲染方式单选组。"""
    if kind == CT_KIND:
        return await _inspect_container(client, node, vmid)
    return await _inspect_vm(client, node, vmid)


async def _inspect_vm(client: Any, node: str, vmid: int) -> Dict[str, Any]:
    # 取配置失败说明这台机器根本不存在 / 读不到，让异常抛出去（路由统一转错误）
    config = await client.qemu_config(node, vmid)
    running = await _is_running(client, node, vmid, VM_KIND)
    has_ci = _has_cloudinit_drive(config)
    agent_ok = running and await _agent_alive(client, node, vmid)

    if agent_ok:
        agent_reason = ""
    elif not running:
        agent_reason = "客户机没在运行（Guest Agent 只在运行时应答）"
    else:
        agent_reason = "没检测到 qemu-guest-agent：客户机内没装，或服务没起来"

    methods = [
        _option(
            AGENT,
            "Guest Agent（即时生效）",
            "在客户机内直接下发新口令，不用重启，也不会打断正在跑的业务。",
            available=agent_ok,
            reason=agent_reason,
        ),
        _option(
            CLOUDINIT,
            "Cloud-init（会重启）",
            "写入 cipassword 并重新生成 config drive，重启后由 cloud-init 落地；"
            "要求客户机里确实装了 cloud-init（面板创建的机器默认都有）。",
            available=has_ci,
            reason="这台虚拟机没挂 cloud-init 盘，写了也没人读"
            if not has_ci
            else "",
            restarts=running,
        ),
    ]
    return _payload(VM_KIND, node, vmid, methods, running=running)


async def _inspect_container(client: Any, node: str, vmid: int) -> Dict[str, Any]:
    await client.lxc_config(node, vmid)
    running = await _is_running(client, node, vmid, CT_KIND)
    row = await _ssh_host(node)

    if row is None:
        reason = _ssh_missing_reason(node)
    elif not running:
        reason = "容器没在运行（pct exec 要求容器处于运行状态）"
    else:
        reason = ""

    where = f"{row.get('username')}@{row.get('host')}" if row else ""
    methods = [
        _option(
            SSH,
            "宿主机 SSH 执行 pct exec（即时生效）",
            (
                f"借「SSH → 受管主机」里的 {where} 在宿主机上执行 "
                f"pct exec {vmid} -- chpasswd，即时生效、不重启容器。"
                if row
                else "借宿主机的 SSH 凭据在宿主机上执行 pct exec <vmid> -- chpasswd。"
            ),
            available=bool(row) and running,
            reason=reason,
        )
    ]
    return _payload(CT_KIND, node, vmid, methods, running=running, ssh_host=row)


def _payload(
    kind: str,
    node: str,
    vmid: int,
    methods: List[Dict[str, Any]],
    *,
    running: bool,
    ssh_host: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    usable = [m["id"] for m in methods if m["available"]]
    # 偏好顺序：不重启的排前面。虚拟机优先 agent，容器只有 ssh 这一条。
    for preferred in (AGENT, SSH, CLOUDINIT):
        if preferred in usable:
            recommended = preferred
            break
    else:
        recommended = ""

    payload: Dict[str, Any] = {
        "kind": kind,
        "node": node,
        "vmid": int(vmid),
        "running": running,
        "methods": methods,
        "recommended": recommended,
        "username": DEFAULT_USERNAME,
    }
    if ssh_host is not None:
        payload["ssh_host"] = {
            "name": str(ssh_host.get("name") or ""),
            "host": str(ssh_host.get("host") or ""),
            "username": str(ssh_host.get("username") or ""),
        }
    return payload


# =================================================================== 执行
def username_error(username: str) -> str:
    """用户名合不合法；空串表示通过。"""
    name = (username or "").strip()
    if not name:
        return "请填写客户机内的用户名"
    if not USERNAME_RE.match(name):
        return "用户名不合法：只允许字母、数字与 . _ - $，且以字母或下划线开头"
    return ""


async def reset(
    kind: str,
    client: Any,
    node: str,
    vmid: int,
    *,
    username: str,
    password: str,
    method: str = "",
) -> Dict[str, Any]:
    """按选定方式重置客户机内某个用户的口令。

    口令强度沿用面板自己那一套（``security.password_policy_error``：至少 8 位、
    字母 + 数字）。PVE 对 agent 方式只要求 5 位，但客户机口令是这台机器的最高
    权限凭据，没必要比面板账号更松。
    """
    username = (username or "").strip()
    problem = username_error(username)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    weak = security.password_policy_error(password or "")
    if weak:
        raise HTTPException(status_code=400, detail=weak)

    info = await inspect(kind, client, node, vmid)
    usable = {m["id"]: m for m in info["methods"] if m["available"]}
    if not usable:
        raise HTTPException(
            status_code=409,
            detail="这台客户机现在没有可用的重置方式："
            + "；".join(f"{m['label']} —— {m['reason']}" for m in info["methods"]),
        )
    if method and method not in usable:
        why = next(
            (m["reason"] for m in info["methods"] if m["id"] == method),
            "这种方式现在不可用",
        )
        raise HTTPException(status_code=409, detail="不能使用该方式：" + why)
    chosen = method or info["recommended"] or sorted(usable)[0]

    if chosen == AGENT:
        detail = await _reset_via_agent(client, node, vmid, username, password)
        return _result(AGENT, username, detail=detail, restarted=False)
    if chosen == SSH:
        detail = await _reset_via_ssh(node, vmid, username, password)
        return _result(SSH, username, detail=detail, restarted=False)
    outcome = await _reset_via_cloudinit(client, node, vmid, username, password)
    return _result(CLOUDINIT, username, **outcome)


def _result(method: str, username: str, **extra: Any) -> Dict[str, Any]:
    return {
        "ok": True,
        "method": method,
        "username": username,
        "detail": str(extra.get("detail") or ""),
        "restarted": bool(extra.get("restarted")),
        "task": str(extra.get("task") or ""),
    }


def _raise(exc: ProxmoxError, prefix: str = "") -> None:
    detail = (prefix + str(exc.message or exc)).strip()
    raise HTTPException(
        status_code=exc.status_code if exc.status_code < 600 else 500, detail=detail
    )


# ------------------------------------------------------------- Guest Agent
async def _reset_via_agent(
    client: Any, node: str, vmid: int, username: str, password: str
) -> str:
    try:
        await client.qemu_agent_set_password(node, vmid, username, password)
        return (
            f"已通过 Guest Agent 把 {username} 的口令改成新值（即时生效，未重启）"
        )
    except ProxmoxError as exc:
        first = exc

    # 走到这里通常是老版本 agent 不认 guest-set-user-password。
    # 但只有 agent 确实活着才值得再试 chpasswd —— 否则两条错误互相矛盾，
    # 用户看到「不支持这条命令」，真实原因其实是「agent 根本没跑」。
    if not await _agent_alive(client, node, vmid):
        _raise(first)

    await _agent_chpasswd(client, node, vmid, username, password)
    return (
        f"Guest Agent 不支持直接改口令，已在客户机内用 chpasswd 改掉 {username} 的口令"
        "（即时生效，未重启）"
    )


async def _agent_chpasswd(
    client: Any, node: str, vmid: int, username: str, password: str
) -> None:
    """在客户机内执行 ``chpasswd``。

    口令走 **base64 编码的 stdin**，不拼进命令行：口令里带引号 / 反斜杠 / 空格
    时，拼接写法几乎必错，而这恰恰是很常见的口令。base64 的字符集里没有 shell
    元字符，塞进命令里是安全的。
    """
    payload = base64.b64encode(
        f"{username}:{password}\n".encode("utf-8")
    ).decode("ascii")
    await _agent_run(
        client,
        node,
        vmid,
        ["/bin/sh", "-c", f"printf %s {payload} | base64 -d | chpasswd"],
    )


async def _agent_run(
    client: Any, node: str, vmid: int, argv: List[str]
) -> str:
    """在客户机内执行命令并取回 stdout（虚拟机专用，容器没有这种东西）。"""
    try:
        result = await client.qemu_agent_exec(node, vmid, argv)
    except ProxmoxError as exc:
        raise HTTPException(
            status_code=502,
            detail="Guest Agent 调用失败："
            + str(exc.message)
            + "（请确认客户机内已安装并运行 qemu-guest-agent）",
        ) from exc

    pid = (result or {}).get("pid")
    if not pid:
        raise HTTPException(status_code=502, detail="Guest Agent 未返回执行句柄")

    for _ in range(_AGENT_POLL_ATTEMPTS):
        try:
            status = await client.qemu_agent_exec_status(node, vmid, pid)
        except ProxmoxError as exc:
            raise HTTPException(
                status_code=502,
                detail="读取客户机命令输出失败：" + str(exc.message),
            ) from exc
        if status.get("exited"):
            code = int(status.get("exitcode") or 0)
            out = decode_agent_output(status.get("out-data"))
            err = decode_agent_output(status.get("err-data"))
            if code != 0:
                raise HTTPException(
                    status_code=502,
                    detail="客户机内改口令失败："
                    + ((err or out).strip()[-200:] or f"退出码 {code}")
                    + "（用户名不存在、或 agent 不是 root 身份运行时都会这样）",
                )
            return out
        await asyncio.sleep(_AGENT_POLL_INTERVAL)

    raise HTTPException(status_code=504, detail="客户机内命令执行超时")


# --------------------------------------------------------------- cloud-init
async def _reset_via_cloudinit(
    client: Any, node: str, vmid: int, username: str, password: str
) -> Dict[str, Any]:
    data: Dict[str, Any] = {"cipassword": password}
    if username:
        # 不指定 ciuser 的话，口令会落到镜像里预设的默认用户（ubuntu / debian …），
        # 而不是用户填的这个
        data["ciuser"] = username
    try:
        await client.qemu_set_config(node, vmid, data)
        await client.qemu_cloudinit_regen(node, vmid)
    except ProxmoxError as exc:
        _raise(exc, "写入 cloud-init 失败：")

    running = await _is_running(client, node, vmid, VM_KIND)
    task = ""
    if running:
        try:
            task = _upid(await client.qemu_power(node, vmid, "reboot"))
        except ProxmoxError as exc:
            return {
                "detail": "cloud-init 已写好，但重启没发出去："
                + str(exc.message)
                + "；口令会在下次开机时生效",
                "restarted": False,
                "task": "",
            }
    return {
        "detail": (
            f"已把 {username} 的新口令写进 cloud-init 并重新生成 config drive，"
            + ("客户机正在重启，开机后生效" if running else "客户机没在运行，下次开机时生效")
        ),
        "restarted": running,
        "task": task,
    }


# --------------------------------------------------------------------- SSH
async def _reset_via_ssh(
    node: str, vmid: int, username: str, password: str
) -> str:
    row = await _ssh_host(node)
    if row is None:
        raise HTTPException(status_code=409, detail=_ssh_missing_reason(node))

    payload = base64.b64encode(
        f"{username}:{password}\n".encode("utf-8")
    ).decode("ascii")
    # sudo 只加在 pct 上：写成 `sudo printf … | pct exec` 的话，sudo 只管到管道
    # 左边那条命令，pct 仍然是普通用户，会以「没有权限」告终。
    sudo = "sudo -n " if row.get("use_sudo") else ""
    command = f"printf %s {payload} | base64 -d | {sudo}pct exec {int(vmid)} -- chpasswd"

    try:
        ok, out = await sshremote.run_command(row, command, timeout=_SSH_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - 连接层的失败也要给出人话
        raise HTTPException(
            status_code=502,
            detail=f"连接宿主机 {row.get('host')} 失败：{str(exc)[:200]}",
        ) from exc

    if not ok:
        raise HTTPException(status_code=502, detail=_ssh_failure(node, vmid, out))

    return (
        f"已在宿主机 {row.get('host')} 上执行 pct exec {vmid} -- chpasswd，"
        f"{username} 的口令已改成新值（即时生效，未重启容器）"
    )


def _ssh_failure(node: str, vmid: int, output: str) -> str:
    """把宿主机的报错翻译成能照着做的中文。

    判定顺序有讲究：``chpasswd`` 的报错里也带 ``does not exist``
    （``user 'nobody' does not exist``），所以「容器不存在」那一条必须写得足够
    具体（PVE 的原话是 ``Configuration file 'nodes/pve/lxc/110.conf' does not
    exist``），否则会把「容器里的用户名不存在」误报成「容器不存在」。
    """
    text = (output or "").strip()
    low = text.lower()
    if "chpasswd" in low:
        # 命令确实进到容器里了，报错来自容器内部 —— 别说成「宿主机执行失败」
        return "容器内改口令失败：" + (text[:200] or "没有任何输出")
    if "command not found" in low or "pct: not found" in low:
        return f"宿主机 {node} 上没有 pct 命令，它看起来不是 PVE 节点"
    if "no such container" in low or "configuration file" in low:
        return f"宿主机 {node} 上找不到容器 {vmid}"
    if "permission denied" in low or "password is required" in low or "sudo" in low:
        return (
            f"SSH 账号权限不足（需要 root，或在受管主机里勾上「使用 sudo」"
            "且该账号能免密 sudo）"
        )
    return "宿主机执行失败：" + (text[:200] or "没有任何输出")


def _upid(result: Any) -> str:
    """从 PVE 的返回值里取任务 UPID。"""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return str(result.get("task") or "")
    return ""
