"""Proxmox connection configuration and health endpoints."""
from __future__ import annotations

import secrets
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from .. import (
    # 面板版本：唯一来源在 app/__init__.py（package.json 与 CHANGELOG 跟着它走）
    __version__,
    accesscontrol,
    captcha,
    defaults,
    faq,
    mailer,
    panel_url,
    quota,
    security,
    site,
    specs,
    store,
    ui,
)
from ..config import settings
from ..pve import (
    PveConnection,
    ProxmoxClient,
    ProxmoxError,
    client_for_connection,
    connection_from_profile,
    get_client,
    rebuild_client,
    requested_connection,
)
from ..schemas import (
    ConnectionConfigIn,
    ConnectionTestIn,
    FaqIn,
    LoginCaptchaIn,
    MailConfigIn,
    MailTestIn,
    PanelUrlIn,
    SessionPolicyIn,
    SiteInfoIn,
    UiPrefsIn,
    VmDefaultsIn,
    VmQuotaIn,
)

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/health")
async def health(
    user: Optional[Dict[str, Any]] = Depends(security.get_current_user_optional),
) -> Dict[str, Any]:
    """健康检查：匿名只答「活着」，登录后才给诊断明细。

    此前这个匿名端点会把 PVE 版本、节点数、连接状态一起吐出去（审计项
    FD-04）—— 版本号可以直接拿去对公开漏洞库做匹配，节点数说明集群规模，
    ``pve_connected`` 的翻转还能被用来探测面板配置变化。而未登录访客拿这些
    信息没有任何用处。

    所以现在分两档：
      * 匿名：只回 ``{"status": "ok"}``，且**不探测 PVE** —— 顺带堵掉「匿名
        请求即可让面板反复向上游发请求」这条放大路径；
      * 已登录（前端登录后的各处都在轮询它）：字段与以前完全一致。
    需要深度诊断用的是 ``/api/config/diagnostics``（要求 settings.manage）。
    """
    if user is None:
        return {"status": "ok"}

    result: Dict[str, Any] = {
        "status": "ok",
        "pve_connected": False,
        # 与 pve_connected 分两个字段是有意的：前者是「连通」，这个是「填没填过」。
        # 未配置和配了但连不上，用户要做的事完全不同（去添加 vs 去排查），
        # 只给一个 false 的话前端只能把两者都渲染成报错。
        "pve_configured": False,
        "version": __version__,
        "pve_version": None,
        "node_count": 0,
        "error": None,
    }

    client = get_client()
    if not client.conn.configured:
        result["error"] = "Proxmox 连接未配置"
        return result

    result["pve_configured"] = True

    try:
        version = await client.version()
        nodes = await client.nodes()
        result["pve_connected"] = True
        result["pve_version"] = version.get("version")
        result["node_count"] = len(nodes or [])
    except ProxmoxError as exc:
        result["error"] = exc.message
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)

    return result


@router.get("/config/connection")
async def get_connection(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    # 读操作也留痕：连接配置虽然不回传密钥明文，但它描述了面板能碰哪些集群，
    # 「谁在什么时候看了这份配置」是事后追溯的关键线索。
    await security.audit_read(request, user, "config.connection.read")
    cfg = store.public_connection_config()
    # 新建连接的默认校验策略跟随后端配置 PVE_VERIFY_SSL（生产默认校验证书），
    # 前端建号/新建表单直接取这个值，免得两端各写一套默认值。
    cfg["verify_ssl_default"] = settings.pve_verify_ssl
    return cfg


@router.put("/config/connection")
async def update_connection(
    payload: ConnectionConfigIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    # 这里能写入 PVE 的 API Token（等于集群权限）：必须二次确认身份
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    await store.save_connection_config(payload.model_dump(exclude_none=True))
    rebuild_client()
    await security.audit(
        request, user, "config.update", target="pve_connection",
        detail={"host": payload.host, "port": payload.port},
    )
    return store.public_connection_config()


# ================================================================= multi-PVE
# 支持保存多台 Proxmox。多条连接**一律同级**：节点 / 虚拟机 / 存储等列表接口
# 未指定连接时会遍历全部连接合并返回；只有「一次只能读一台」的接口（健康探活、
# 集群版本 / 仲裁等）才回落到这里维护的「兜底连接」。它不对外表示「主集群」，
# 设置页只把它作为「兜底读取目标」呈现。


def _find_connection(
    conns: List[Dict[str, Any]], conn_id: str
) -> Optional[Dict[str, Any]]:
    for c in conns:
        if str(c.get("id")) == conn_id:
            return c
    return None


@router.get("/connections")
async def list_connections(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> List[Dict[str, Any]]:
    """全部已保存的 PVE 连接。

    **按权限裁剪**：完整字段（主机地址 / 端口 / 令牌与控制台凭据的「是否已设置」）
    只给管理员（``settings.manage``）。连接配置说的是「面板能碰哪些集群、拿什么
    凭据碰」，属于管理信息 —— 它不该跟着 ``node.view`` 这类权限一起扩散出去，
    更不该让没有任何节点权限的账号也看得到。

    普通用户拿到的是精简版（id / 名称 / 区域 / 是否当前 / 是否配好），见
    ``store.public_connection_brief``：他们确实需要它 —— 节点列表按「区域 →
    连接 → 节点」分组、创建向导要选目标 PVE、地址池按连接限定适用范围 —— 但
    这些只需要认得出是哪台。
    """
    await security.audit_read(request, user, "config.connections.read")
    conns = store.get_connections()
    active_id = str(store.get_active_connection().get("id") or "")
    can_manage = security.has_user_permission(user, "settings.manage")
    # 区域管理员只应看到本区域的连接：连接清单决定他能切到哪台 PVE，看到
    # 其它区域的连接等于把「另一个区域的入口」摆在他面前（普通用户不受限，
    # 他们的范围由节点授权决定）。
    conns = [
        c
        for c in conns
        if security.region_in_scope(user, str(c.get("region") or ""))
    ]
    result: List[Dict[str, Any]] = []
    for c in conns:
        pub = (
            store.public_connection_config(c)
            if can_manage
            else store.public_connection_brief(c)
        )
        pub["active"] = str(c.get("id")) == active_id
        result.append(pub)
    return result


@router.post("/connections")
async def create_connection(
    payload: ConnectionConfigIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    conns = store.get_connections()
    was_empty = len(conns) == 0
    data = payload.model_dump(exclude_none=True)
    data.pop("id", None)
    name = str(data.pop("name", "") or "") or str(data.get("host") or "") or "未命名连接"
    cid = secrets.token_hex(4)
    profile: Dict[str, Any] = {"id": cid, "name": name, **data}
    conns.append(profile)
    await store.save_connections(conns)

    # 仅当这是第一条连接时自动设为当前，避免新增时抢占用户正在用的那台
    if was_empty:
        await store.set_active_connection(cid)
        rebuild_client()

    await security.audit(
        request, user, "connection.create", target=f"connection/{cid}",
        detail={"host": data.get("host"), "port": data.get("port")},
    )
    pub = store.public_connection_config(profile)
    pub["active"] = store.get_active_connection_id() == cid
    return pub


@router.put("/connections/{conn_id}")
async def update_connection_profile(
    conn_id: str,
    payload: ConnectionConfigIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    conns = store.get_connections()
    if _find_connection(conns, conn_id) is None:
        raise HTTPException(status_code=404, detail="连接不存在")

    data = payload.model_dump(exclude_none=True)
    data.pop("id", None)
    name = str(data.pop("name", "") or "")
    # 密钥单独处理：留空表示保留原值
    data.pop("token_secret", None)
    data.pop("console_password", None)

    updated: List[Dict[str, Any]] = []
    for c in conns:
        if str(c.get("id")) != conn_id:
            updated.append(c)
            continue
        merged = {**c, **data}
        if payload.token_secret not in (None, "", "__UNCHANGED__"):
            merged["token_secret"] = payload.token_secret
        if payload.console_password not in (None, "", "__UNCHANGED__"):
            merged["console_password"] = payload.console_password
        if name:
            merged["name"] = name
        if not merged.get("name"):
            merged["name"] = merged.get("host") or "未命名连接"
        updated.append(merged)

    await store.save_connections(updated)
    if store.get_active_connection_id() == conn_id:
        rebuild_client()

    await security.audit(request, user, "connection.update", target=f"connection/{conn_id}")
    pub = store.public_connection_config(_find_connection(updated, conn_id) or {})
    pub["active"] = store.get_active_connection_id() == conn_id
    return pub


@router.delete("/connections/{conn_id}")
async def delete_connection_profile(
    conn_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    conns = store.get_connections()
    remaining = [c for c in conns if str(c.get("id")) != conn_id]
    if len(remaining) == len(conns):
        raise HTTPException(status_code=404, detail="连接不存在")

    await store.save_connections(remaining)
    # 删除的是当前连接时，自动切到剩余的第一条
    if store.get_active_connection_id() == conn_id:
        new_active = str(remaining[0].get("id")) if remaining else ""
        await store.set_active_connection(new_active)
        rebuild_client()

    await security.audit(request, user, "connection.delete", target=f"connection/{conn_id}")
    return {"deleted": conn_id, "remaining": len(remaining)}


@router.post("/connections/{conn_id}/activate")
async def activate_connection(
    conn_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """把某条连接设为「当前连接」，全站立即切到它。"""
    conns = store.get_connections()
    if _find_connection(conns, conn_id) is None:
        raise HTTPException(status_code=404, detail="连接不存在")

    await store.set_active_connection(conn_id)
    rebuild_client()
    await security.audit(request, user, "connection.activate", target=f"connection/{conn_id}")
    return {"active": conn_id}


@router.post("/connections/{conn_id}/repair-permissions")
async def repair_connection_permissions(
    conn_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """一键修复：给该连接的 API Token 授予 PVEAdmin。

    为什么需要它：在 Proxmox 界面新建 Token 时「特权分离」默认勾选，这种
    Token 的有效权限为空，PVE 会隐藏节点 CPU / 内存 / 磁盘指标并在特权接口
    返回 403 —— 表现就是「面板读不到节点信息」。零权限的 Token 无法给自己
    授权，所以这里用该连接里保存的 Proxmox 账号密码换取票据来改 ACL。
    """
    conns = store.get_connections()
    profile = _find_connection(conns, conn_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="连接不存在")

    conn = connection_from_profile(profile)
    if not (conn.console_user and conn.console_password):
        raise HTTPException(
            status_code=400,
            detail=(
                "需要先在该连接中填写 Proxmox 账号与密码（例如 root@pam），"
                "只有账号密码才能修改 PVE 权限。"
            ),
        )
    if not conn.token_id:
        raise HTTPException(status_code=400, detail="该连接未填写 API Token ID")

    # 1) 用账号密码换票据，给令牌授予 PVEAdmin
    admin = ProxmoxClient(conn)
    try:
        await admin.grant_token_role(conn.token_id, role="PVEAdmin", path="/")
    except ProxmoxError as exc:
        raise HTTPException(
            status_code=400, detail=f"授予权限失败：{exc.message}"
        ) from exc
    finally:
        await admin.aclose()

    # 2) 复验：改用令牌本身再读一次权限与节点指标，确认真的生效
    verify = ProxmoxClient(conn)
    privileges: List[str] = []
    node_metrics = False
    try:
        perms = await verify.access_permissions()
        for path, privs in (perms or {}).items():
            privileges.extend(f"{priv}@{path}" for priv in privs or [])
        nodes = await verify.nodes() or []
        node_metrics = bool(nodes) and any(n.get("maxmem") is not None for n in nodes)
    except ProxmoxError as exc:
        raise HTTPException(
            status_code=400, detail=f"已提交授权，但复验失败：{exc.message}"
        ) from exc
    finally:
        await verify.aclose()

    if not privileges:
        raise HTTPException(
            status_code=400,
            detail=(
                "已提交授权，但令牌仍无有效权限。请确认控制台账号本身具备"
                "「权限管理」权限（通常是 root@pam）。"
            ),
        )

    await security.audit(
        request, user, "connection.repair", target=f"connection/{conn_id}",
        detail={"token_id": conn.token_id, "role": "PVEAdmin"},
    )

    return {
        "ok": True,
        "token_id": conn.token_id,
        "role": "PVEAdmin",
        "effective_privileges": sorted(set(privileges)),
        "node_metrics": node_metrics,
    }


@router.get("/config/diagnostics")
async def diagnostics(
    connection_id: str = Query(default=""),
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """Probe the configured credential and report what the panel can actually do.

    This exists because of a Proxmox behaviour that is easy to misread as a
    panel bug. An API token created with "privilege separation" (the default
    in the web UI) starts with *no* permissions: privileged reads answer 403,
    and some endpoints — ``/storage`` in particular — answer 200 with an empty
    list rather than an error. The panel then honestly renders an empty
    dashboard, and the operator concludes the panel is broken.

    So we ask Proxmox directly for the credential's effective privileges and
    turn the gaps into concrete remediation commands.

    **必须说明探测的是哪一条连接。** 多连接部署里 ``get_client()`` 在未指定
    连接时只读「兜底连接」（``store.get_active_connection_id()``，通常是第一条
    保存的连接）。于是刚新增完一台节点、在它的表单上点「环境自检」，报告里
    回的却是旧连接的 ``host``（例如新增 172.16.149.42，报告显示
    ``https://172.16.149.3:8006``）—— 看起来像节点 IP 存错了，实际是自检
    打错了主机。``?connection_id=`` 或 ``X-PVE-Connection`` 指定后，凭据与
    地址都取自那一条连接，报告的 ``connection_id`` / ``host`` 才说得清归属。
    """
    # 目标连接：显式参数 → 请求头 / 顶栏作用域 → 兜底连接。
    # 与 pve.get_client() 同一套解析口径，报告里的 connection_id 就是真正被
    # 探测的那条，不会出现「报告写 A、实际打 B」。
    conn_id = (connection_id or "").strip() or requested_connection()
    profiles = store.get_connections()
    if conn_id:
        profile: Optional[Dict[str, Any]] = next(
            (c for c in profiles if str(c.get("id") or "") == conn_id), None
        )
        # 存的是已删除的 id（老页面标签页 / 顶栏作用域残留）：直接说清楚，
        # 别让它退化成一次「连不上」的 502。
        if profile is None:
            raise HTTPException(status_code=404, detail="连接不存在")
    else:
        conn_id = str(store.get_active_connection_id() or "")
        profile = next(
            (c for c in profiles if str(c.get("id") or "") == conn_id), None
        )

    # 按 id 取客户端：命中的是这条连接自己的 host / port / 令牌，
    # 而不是全局那个「兜底」客户端（见 pve.client_for_connection）。
    client = client_for_connection(conn_id)

    checks: List[Dict[str, Any]] = []

    def add(key: str, label: str, status: str, detail: str, hint: str = "") -> None:
        checks.append(
            {"key": key, "label": label, "status": status, "detail": detail, "hint": hint}
        )

    result: Dict[str, Any] = {
        "ok": False,
        "reachable": False,
        # 报告回显「这次探测的是哪条连接」：host 只说明打到哪台 PVE，
        # 同一台 PVE 也可能被登记成多条连接（端口 / 令牌不同）。
        "connection_id": conn_id,
        "connection_name": str(
            (profile or {}).get("name") or (profile or {}).get("host") or ""
        ),
        # host 由 PveConnection.base_url 拼出：协议前缀 https:// + 该连接的
        # host:port（未显式给协议时补 https，端口缺省 8006）——
        # 取值来源就是上面这条连接的 profile，不再来自全局兜底客户端。
        "host": client.conn.base_url,
        "token_id": client.conn.token_id,
        "pve_version": None,
        "effective_privileges": [],
        "checks": checks,
        "remediation": [],
    }

    if not client.conn.configured:
        add("configured", "连接配置", "fail", "尚未填写主机或 API Token")
        result["remediation"].append("在「Proxmox 连接配置」中填写主机地址与 API Token")
        result["status"] = "fail"
        return result

    # --- 1. reachability ---------------------------------------------------
    try:
        version = await client.version()
        result["reachable"] = True
        result["pve_version"] = version.get("version")
        add(
            "version",
            "API 可达",
            "ok",
            f"Proxmox VE {version.get('version')}（{version.get('release')}）",
        )
    except ProxmoxError as exc:
        add("version", "API 可达", "fail", exc.message)
        result["remediation"].append(
            "检查主机地址、8006 端口连通性与 Token Secret；"
            "若集群使用自签名证书，可关闭「校验证书」"
        )
        result["status"] = "fail"
        return result

    # --- 2. effective privileges ------------------------------------------
    privileges: List[str] = []
    no_privileges = False
    try:
        perms = await client.access_permissions()
        for path, privs in (perms or {}).items():
            for priv in privs or []:
                privileges.append(f"{priv}@{path}")
        no_privileges = not privileges
    except ProxmoxError as exc:
        add("privileges", "权限查询", "warn", f"无法读取 /access/permissions：{exc.message}")

    result["effective_privileges"] = sorted(set(privileges))

    if no_privileges:
        add(
            "privileges",
            "令牌有效权限",
            "fail",
            "该令牌没有任何有效权限（/access/permissions 返回空）",
            "令牌创建时很可能勾选了「特权分离（Privilege Separation）」。"
            "特权分离的令牌默认零权限，必须显式授予 ACL 才能使用。",
        )
        result["remediation"].append(
            f"pveum acl modify / --tokens '{client.conn.token_id}' --roles PVEAdmin"
        )
        result["remediation"].append(
            "或在 Proxmox 界面「数据中心 → 权限 → 添加 → API 令牌权限」中授予角色"
        )
        add(
            "storage",
            "存储可见性",
            "warn",
            "未做进一步检测：无权限时该接口会返回空列表而非报错",
        )
        add("vms", "虚拟机读取", "warn", "未做进一步检测：无权限时结果同样为空")
        result["checks"] = checks
        result["status"] = "fail"
        return result

    # --- 3. node visibility ------------------------------------------------
    nodes: List[Dict[str, Any]] = []
    try:
        nodes = await client.nodes() or []
        if nodes:
            names = "、".join(n.get("node", "?") for n in nodes)
            add("nodes", "节点可见", "ok", f"{len(nodes)} 个节点：{names}")
        else:
            add(
                "nodes",
                "节点可见",
                "fail",
                "看不到任何节点，需在 / 或 /nodes 上授予 Sys.Audit",
            )
            result["remediation"].append(
                f"pveum acl modify / --tokens '{client.conn.token_id}' --roles PVEAuditor"
            )
    except ProxmoxError as exc:
        add("nodes", "节点可见", "fail", exc.message)

    # A node with no metrics is the signature of a missing Sys.Audit.
    if nodes and all(n.get("maxmem") is None for n in nodes):
        add(
            "node_metrics",
            "节点资源指标",
            "fail",
            "/nodes 未返回 CPU / 内存 / 磁盘数据（字段被权限过滤）",
            "实时监控与资源大盘依赖 Sys.Audit",
        )
        result["remediation"].append(
            f"pveum acl modify / --tokens '{client.conn.token_id}' --roles PVEAuditor"
        )
    elif nodes:
        add("node_metrics", "节点资源指标", "ok", "CPU / 内存 / 磁盘数据可读")

    # --- 4. storage --------------------------------------------------------
    try:
        storages = await client.storages() or []
        if storages:
            add("storage", "存储可见", "ok", f"{len(storages)} 个存储")
        else:
            add(
                "storage",
                "存储可见",
                "warn",
                "/storage 返回空列表。若集群确实配置了存储，通常是缺少 Datastore.Audit 权限",
                "创建虚拟机与导入镜像都需要选择存储",
            )
            result["remediation"].append(
                f"pveum acl modify / --tokens '{client.conn.token_id}' --roles PVEDatastoreUser"
            )
    except ProxmoxError as exc:
        add("storage", "存储可见", "fail", exc.message)

    # --- 5. guests ---------------------------------------------------------
    try:
        guests = await client.cluster_resources("vm") or []
        running = sum(1 for g in guests if g.get("status") == "running")
        add(
            "guests",
            "虚拟机可见",
            "ok",
            f"{len(guests)} 台虚拟机（运行中 {running} 台）",
        )
    except ProxmoxError as exc:
        add("guests", "虚拟机可见", "fail", exc.message)

    # --- 6. console credentials -------------------------------------------
    if client.conn.console_user and client.conn.console_password:
        add("console", "控制台凭据", "ok", f"已配置账号 {client.conn.console_user}")
    else:
        add(
            "console",
            "控制台凭据",
            "warn",
            "未配置。Proxmox 不接受 API Token 打开 VNC 控制台",
            "如需浏览器内控制台，请额外填写一个 Proxmox 账号密码",
        )

    # Overall verdict. "warn" still means the panel is usable — a missing
    # optional console account, for example, does not block anything — while
    # "fail" means core functionality is unavailable.
    worst = "ok"
    for check in checks:
        if check["status"] == "fail":
            worst = "fail"
            break
        if check["status"] == "warn":
            worst = "warn"

    result["ok"] = worst != "fail"
    result["status"] = worst
    return result


@router.post("/config/connection/test")
async def test_connection(
    payload: ConnectionTestIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """Try a candidate connection without persisting it.

    An empty ``token_secret`` means "use the stored one", which lets the user
    re-test a saved config without retyping the secret.

    **「存的那一份」必须是这条连接的**：多连接部署里不能再无条件读
    ``store.get_connection_config()``（那是「兜底连接」，通常是第一条保存的
    连接）。编辑第二条连接时留空 secret，拿到的会是第一条的密钥，于是报
    「Proxmox 拒绝了该凭据」—— 而凭据其实是好的。连接取自
    ``connection_id``（请求体）或 ``X-PVE-Connection`` 头，两者都没有时才
    回落到兜底连接（旧行为，供单连接部署与脚本使用）。
    """
    secret = payload.token_secret
    if not secret:
        conn_id = (payload.connection_id or "").strip() or requested_connection()
        if conn_id:
            profile: Optional[Dict[str, Any]] = next(
                (
                    c
                    for c in store.get_connections()
                    if str(c.get("id") or "") == conn_id
                ),
                None,
            )
            # 指向已删除的连接：说清楚，别退化成「凭据被拒绝」
            if profile is None:
                raise HTTPException(status_code=404, detail="连接不存在")
        else:
            profile = store.get_connection_config()
        secret = str((profile or {}).get("token_secret") or "")

    if not secret:
        raise HTTPException(status_code=400, detail="缺少 API Token Secret")

    conn = PveConnection(
        host=payload.host,
        port=payload.port,
        token_id=payload.token_id,
        token_secret=secret,
        verify_ssl=payload.verify_ssl,
        ca_cert=payload.ca_cert,
    )
    client = ProxmoxClient(conn)

    try:
        version = await client.version()
        nodes = await client.nodes()
    except ProxmoxError as exc:
        await security.audit(
            request, user, "config.test", target=payload.host,
            result="failed", detail=exc.message,
        )
        raise HTTPException(
            status_code=400,
            detail=f"连接失败：{exc.message}",
        ) from exc
    finally:
        await client.aclose()

    await security.audit(
        request, user, "config.test", target=payload.host, result="success",
        detail={"version": version.get("version")},
    )

    return {
        "ok": True,
        "version": version.get("version"),
        "release": version.get("release"),
        "repoid": version.get("repoid"),
        "nodes": [
            {"name": n.get("node"), "status": n.get("status"), "type": n.get("type")}
            for n in (nodes or [])
        ],
    }

@router.get("/config/vm-defaults")
async def get_vm_defaults(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """面板级创建默认值：默认 DNS 与默认克隆方式。

    创建向导向所有可创建虚拟机的用户预填这两个值（DNS 写进 cloud-init，克隆方式
    预选链接 / 完整），因此读取只要求登录。
    """
    return await defaults.get_vm_defaults()


@router.put("/config/vm-defaults")
async def put_vm_defaults(
    payload: VmDefaultsIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """保存默认 DNS 与默认克隆方式。

    DNS 留空 = 不干预，创建/克隆时完全继承 DHCP / RA 下发的 DNS；
    full_clone 只是各创建入口预选的初值（False 链接克隆 / True 完整克隆），
    用户在快速部署、自定义部署、模板页克隆里都可以单独改。
    """
    saved = await defaults.set_vm_defaults(payload.dns, payload.full_clone)
    await security.audit(
        request,
        user,
        "config.vm_defaults",
        target="vm-defaults",
        detail={
            "dns": saved["dns"] or "(空)",
            "full_clone": "完整克隆" if saved["full_clone"] else "链接克隆",
        },
    )
    return saved


# ==================================================== 资源规格（管理员定义）
# 用户下单时挑「几核几 G 多大盘」，规格由管理员在设置页维护。
# 读取只要求登录（下单页要用它渲染规格卡片，且它不含敏感信息）；
# 写入要求 settings.manage —— 与 IP 池、创建默认值同一档。
@router.get("/config/specs")
async def get_specs(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """全量资源规格。从未保存过时返回默认那几档（1C2G / 2C4G / 4C8G / 8C16G）。"""
    return {"specs": await specs.list_specs()}


@router.put("/config/specs")
async def put_specs(
    payload: List[Dict[str, Any]],
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """整份覆盖保存（前端本地编辑完一次性提交，与 IP 池同一契约）。

    不合法的条目会被逐条丢掉而不是整份拒绝（见 :func:`app.specs.normalise`），
    返回值就是真正落库的那份，前端据此回显。
    """
    saved = await specs.save_specs(payload)
    await security.audit(
        request,
        user,
        "config.specs",
        target="resource-specs",
        detail={"count": len(saved), "names": [s["name"] for s in saved][:8]},
    )
    return {"specs": saved}


# ============================================================ 登录验证方式
# 三档：关闭 / 图形验证码 / 拖动滑块。存在 settings KV 表，改完立即生效，
# 不需要重启（登录接口每次现读，见 captcha.get_mode）。
#
# 读取只要求登录：设置页要显示当前值，而它不含任何敏感信息（就是个枚举）。
# 写入要求 settings.manage，并且**要过二次确认** —— 把验证码关掉等于降低
# 整个面板的登录门槛，和改连接凭据属于同一类操作，不该只凭一个在线的会话
# 就能完成。


@router.get("/config/login-captcha")
async def get_login_captcha(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, str]:
    return {"mode": await captcha.get_mode()}


@router.put("/config/login-captcha")
async def put_login_captcha(
    payload: LoginCaptchaIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, str]:
    try:
        mode = await captcha.set_mode(payload.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "config.login_captcha",
        target="login-captcha",
        detail={"mode": mode, "label": captcha.MODE_LABEL.get(mode, mode)},
    )
    return {"mode": mode}


# ============================================================ 会话有效期
# 管理员可调：访问令牌多久过期、会话（refresh token）保留几天。
#
# 存 settings KV，改完**立即生效**、不用重启 —— security.py 里有一份进程内
# 缓存（签发令牌是同步函数，不能在那里查库），写入路径负责刷新它。
#
# 读取只要求登录：设置页要回显当前值，且它不含凭据类信息。
# 写入要求 settings.manage + 二次确认：把有效期调成 30 天等于放松整个面板的
# 会话保障，和「关掉验证码」属于同一类操作。


@router.get("/config/session")
async def get_session_policy(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    return {
        "access_minutes": security.session_access_minutes(),
        "refresh_days": security.session_refresh_days(),
        "limits": {
            "access_min": security.SESSION_ACCESS_MIN,
            "access_max": security.SESSION_ACCESS_MAX,
            "refresh_min": security.SESSION_REFRESH_MIN,
            "refresh_max": security.SESSION_REFRESH_MAX,
        },
        # 环境变量里的出厂默认值：界面上标一句「默认 720 分钟」，
        # 让管理员知道自己是改过还是没改过
        "defaults": {
            "access_minutes": int(settings.access_token_expire_minutes),
            "refresh_days": int(settings.refresh_token_expire_days),
        },
    }


@router.put("/config/session")
async def put_session_policy(
    payload: SessionPolicyIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, int]:
    await store.set_setting("session_access_minutes", str(payload.access_minutes))
    await store.set_setting("session_refresh_days", str(payload.refresh_days))
    await security.refresh_session_policy()

    await security.audit(
        request,
        user,
        "config.session",
        target="session-policy",
        detail={
            "access_minutes": payload.access_minutes,
            "refresh_days": payload.refresh_days,
        },
    )
    return {
        "access_minutes": security.session_access_minutes(),
        "refresh_days": security.session_refresh_days(),
    }


# ============================================================ 面板界面开关
# 即「设置 → 导航栏功能开关」（见 app/ui.py）：逐项关闭导航栏里的入口。
# 它决定每个用户的控制台里能看见哪些入口，所以读取只要求登录 —— 控制台外壳
# 在渲染前就得拿到它，只给管理员读的话，被关掉的入口对其他用户依然可见。
# 写入要求 settings.manage：这个开关对所有用户生效。


@router.get("/config/ui")
async def get_ui_prefs(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """面板界面开关。无需特权：控制台布局在每个用户登录后立即需要。"""
    return await ui.get_ui_prefs()


@router.put("/config/ui")
async def put_ui_prefs(
    payload: UiPrefsIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """保存面板界面开关（被关闭的导航栏入口）。保存后立即对所有人生效。"""
    saved = await ui.set_ui_prefs(nav_disabled=payload.nav_disabled)
    await security.audit(
        request,
        user,
        "config.ui_prefs",
        target="ui-prefs",
        # 关掉了哪些入口是这次改动的全部内容，审计日志里必须能看出来
        detail={"nav_disabled": saved["nav_disabled"]},
    )
    return saved


# =============================================================== site info
# 站点信息（品牌名 / 副标题 / 版权）。登录页与产品官网都要在「未登录」状态下
# 展示品牌名，所以这里刻意不做鉴权：读取只返回可公开的品牌文案，不含任何
# 连接信息或凭据。写入仍然要求 settings.manage。


@router.get("/config/site")
async def get_site() -> Dict[str, Any]:
    """站点信息。无需登录：登录页 / 落地页的标题都依赖它。"""
    return await site.get_site_info()


@router.put("/config/site")
async def put_site(
    payload: SiteInfoIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """保存站点信息。品牌三项留空恢复默认值，备案号与友链留空则不展示。"""
    saved = await site.set_site_info(
        name=payload.name,
        subtitle=payload.subtitle,
        copyright_text=payload.copyright,
        icp=payload.icp,
        links=[link.model_dump() for link in payload.links],
    )
    await security.audit(
        request,
        user,
        "config.site_info",
        target="site-info",
        detail={
            "name": saved["name"],
            "subtitle": saved["subtitle"],
            "icp": saved["icp"] or "(空)",
            # 只记条数：审计日志没必要存一长串外部地址
            "links": len(saved["links"]),
        },
    )
    return saved


# ================================================================ 常见问题
# 与站点信息同样刻意不鉴权：产品官网在未登录状态下就要渲染 FAQ。
# 读取只返回问题与答案，不含任何连接信息或凭据。


@router.get("/config/faq")
async def get_faq() -> List[Dict[str, str]]:
    """常见问题。无需登录：产品官网的 FAQ 区块依赖它。"""
    return await faq.get_faqs()


@router.put("/config/faq")
async def put_faq(
    payload: FaqIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> List[Dict[str, str]]:
    """保存常见问题。传空列表 = 关闭官网上的 FAQ 区块。"""
    saved = await faq.set_faqs([item.model_dump() for item in payload.items])
    await security.audit(
        request,
        user,
        "config.faq",
        target="site-faq",
        detail={"count": len(saved)},
    )
    return saved


@router.delete("/config/faq")
async def delete_faq(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> List[Dict[str, str]]:
    """恢复内置的默认问题（删掉配置记录，回到「从未配置」状态）。"""
    restored = await faq.reset_faqs()
    await security.audit(request, user, "config.faq.reset", target="site-faq")
    return restored


@router.get("/config/site/logo", response_class=FileResponse)
async def get_site_logo() -> FileResponse:
    """自定义 Logo 图片。无需登录：登录页与落地页都要显示它。"""
    meta = await site.get_logo_meta()
    if not meta:
        raise HTTPException(status_code=404, detail="未设置自定义 Logo")
    return FileResponse(
        meta["path"],
        media_type=meta["mime"],
        headers={
            # 该接口与面板同源。若直接打开 SVG，里面的脚本会以面板身份执行，
            # 所以用严格 CSP + sandbox 把它压成纯图片；放在 <img> 里不受影响。
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; sandbox"
            ),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.post("/config/site/logo")
async def upload_site_logo(
    request: Request,
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """上传 / 替换站点 Logo（PNG / JPG / WebP / GIF / SVG / ICO，≤ 512 KB）。"""
    # 多读 1 字节用于判断超限，避免把超大文件整个读进内存
    data = await file.read(site.MAX_LOGO_BYTES + 1)
    try:
        meta = await site.save_logo(data, file.content_type or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "config.site_logo",
        target="site-logo",
        detail={
            "filename": meta["filename"],
            "size": meta["size"],
            "mime": meta["mime"],
        },
    )
    return await site.get_site_info()


@router.delete("/config/site/logo")
async def delete_site_logo(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """移除自定义 Logo，界面回落到内置图标。"""
    await site.delete_logo()
    await security.audit(request, user, "config.site_logo.delete", target="site-logo")
    return await site.get_site_info()


# ------------------------------------------------------------ 登录页背景图
# 与 Logo 同一套约定：读取公开（登录 / 注册 / 找回密码页都要用），
# 上传与删除要求 settings.manage。


@router.get("/config/site/login-bg", response_class=FileResponse)
async def get_site_login_bg() -> FileResponse:
    """登录页背景图。无需登录：未登录状态下就要展示。"""
    meta = await site.get_login_bg_meta()
    if not meta:
        raise HTTPException(status_code=404, detail="未设置自定义登录页背景")
    return FileResponse(
        meta["path"],
        media_type=meta["mime"],
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.post("/config/site/login-bg")
async def upload_site_login_bg(
    request: Request,
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """上传 / 替换登录页背景图（PNG / JPG / WebP / GIF，≤ 4 MB）。"""
    data = await file.read(site.MAX_LOGIN_BG_BYTES + 1)
    try:
        meta = await site.save_login_bg(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request,
        user,
        "config.site_login_bg",
        target="site-login-bg",
        detail={
            "filename": meta["filename"],
            "size": meta["size"],
            "mime": meta["mime"],
        },
    )
    return await site.get_site_info()


@router.delete("/config/site/login-bg")
async def delete_site_login_bg(
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """移除自定义背景图，登录页回落到内置插画。"""
    await site.delete_login_bg()
    await security.audit(
        request, user, "config.site_login_bg.delete", target="site-login-bg"
    )
    return await site.get_site_info()


# --------------------------------------------------------------- 邮件通知
@router.get("/config/mail")
async def get_mail_config(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """邮件配置。SMTP 密码只回 ``password_set``，明文永不出库。"""
    await security.audit_read(request, user, "config.mail.read")
    return mailer.public_mail(await mailer.load_mail())


@router.put("/config/mail")
async def update_mail_config(
    payload: MailConfigIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
    # SMTP 口令 = 「以面板名义发信」的凭据（可用于钓鱼）：改它要二次确认
    _step_up: Dict[str, Any] = Depends(security.require_step_up()),
) -> Dict[str, Any]:
    try:
        saved = await mailer.save_mail(payload.model_dump(exclude_none=True))
    except mailer.MailConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request, user, "config.mail", target="mail_settings",
        detail={
            "enabled": saved["enabled"],
            "host": saved["host"],
            "port": saved["port"],
            "tls": saved["tls"],
            "verify_ssl": saved["verify_ssl"],
            "password_changed": bool(payload.password),
        },
    )
    return mailer.public_mail(saved)


# ------------------------------------------------------------- 面板全局地址
# 邮件里拼「重置密码 / 审批结果」链接时用的对外域名。不配则回落到请求 Host
# —— 挂在反向代理后面时那个 Host 常是 localhost，收件人根本打不开。


@router.get("/config/panel-url")
async def get_panel_url(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, str]:
    """当前配置的面板全局地址；空串 = 未配置（回落到请求 Host）。"""
    return {"url": await panel_url.get_base_url()}


@router.put("/config/panel-url")
async def put_panel_url(
    payload: PanelUrlIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, str]:
    """保存面板全局地址。留空 = 清除配置，回落到请求 Host。"""
    try:
        saved = await panel_url.set_base_url(payload.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await security.audit(
        request, user, "config.panel_url", target="panel-url",
        detail={"url": saved or "(未配置，回落请求 Host)"},
    )
    return {"url": saved}


@router.get("/config/security-posture")
async def get_security_posture(
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """公网暴露加固的当前状态（只读）。

    这些开关都来自环境变量：安全边界不适合做成「点一下就能关掉」的界面开关，
    而且白名单一旦在界面里填错，保存的那一刻就会把人锁在门外。这里只把
    「现在到底生效了什么」摊开给管理员看，改配置仍然走 `.env` + 重启。

    ``admins_without_totp`` 让管理员一眼看到还有谁没绑 2FA —— 公网面板上
    这等同于一个只靠口令守着的 root 入口。
    """
    admins: List[Dict[str, Any]] = []
    for row in await store.list_users():
        if str(row.get("role") or "") == "admin" or "*" in security.effective_permissions(row):
            if row.get("enabled", True) and str(
                row.get("status") or store.STATUS_ACTIVE
            ) == store.STATUS_ACTIVE:
                admins.append(row)

    return {
        "allow_configured": accesscontrol.configured(),
        "allow_cidrs": accesscontrol.allowed_networks(),
        "allow_invalid": accesscontrol.has_invalid_entries(),
        "forwarded_allow_ips": settings.forwarded_allow_ips,
        "trusts_any_proxy": (settings.forwarded_allow_ips or "").strip() == "*",
        "force_https": settings.force_https,
        "totp_required_roles": list(settings.totp_required_role_list),
        "admins_without_totp": [
            str(row.get("username") or "")
            for row in admins
            if not row.get("totp_enabled")
        ],
        "login_ip_alert": settings.login_ip_alert,
        "panel_url": await panel_url.get_base_url(),
    }


@router.get("/config/vm-quota")
async def get_vm_quota(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """虚拟机下发总配额（全局容量上限）。

    ``quota`` 为 ``null`` 表示不限制。读取只要求登录：创建向导要把它显示给
    每一个可创建虚拟机的用户。
    """
    return await quota.usage(user, "vm")


@router.get("/config/lxc-quota")
async def get_lxc_quota(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """容器下发总配额。与虚拟机额度**互相独立**（互不占用）。

    单独给一条路径而不是复用 ``?kind=``：前端两个创建向导各自拉自己那份，
    显式路径比查询参数少一层「传错了就静默拿错额度」的风险。
    """
    return await quota.usage(user, "lxc")


@router.put("/config/vm-quota")
async def put_vm_quota(
    payload: VmQuotaIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """保存总配额。填 0 = 普通用户完全不能下发；留空 = 不限制。"""
    value = payload.quota
    if value is not None and value < 0:
        raise HTTPException(status_code=400, detail="配额不能为负数")

    saved = await quota.set_quota("vm", value)
    await security.audit(
        request,
        user,
        "config.vm_quota",
        target="vm-quota",
        detail={"quota": "不限制" if saved is None else saved},
    )
    return await quota.usage(user, "vm")


@router.put("/config/lxc-quota")
async def put_lxc_quota(
    payload: VmQuotaIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """保存容器下发额度。填 0 = 普通用户完全不能建容器；留空 = 不限制。"""
    value = payload.quota
    if value is not None and value < 0:
        raise HTTPException(status_code=400, detail="配额不能为负数")

    saved = await quota.set_quota("lxc", value)
    await security.audit(
        request,
        user,
        "config.lxc_quota",
        target="lxc-quota",
        detail={"quota": "不限制" if saved is None else saved},
    )
    return await quota.usage(user, "lxc")


@router.get("/quota/me")
async def my_quota(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """我自己的资源额度与名下用量。

    只要求登录：这是**自己的**读数，创建向导与列表页都要用它 —— 普通用户同样
    应该知道「我还能建几台 / 还能用几核」。别人的读数在管理端
    ``GET /api/users/{username}/quota``。

    与上面两条全局额度（``/config/vm-quota`` 等）的区别：那些是**集群护栏**
    （全集群台数、所有人共享），这里是**按人分配**的资源额度。
    """
    return await quota.resource_report(user)


@router.get("/quota/overview")
async def quota_overview(
    user: Dict[str, Any] = Depends(security.require_permission("users.view")),
) -> Dict[str, Any]:
    """**所有用户**的额度与用量一览（管理端）。

    额度这个功能唯一需要管理员持续做的决策是「要不要给谁放宽」，而此前没有任何
    一个地方支撑它 —— 只能逐个打开用户编辑器看。这个接口把读数取一次、按归属
    分桶算全，代价是 O(用户数 + 机器数) 而不是「每人一次 PVE 请求」。

    口径与用户侧那份（``/quota/me``）完全共用。``error`` 非空表示集群读数不全，
    用量会偏小 —— 界面必须把它显示出来，不能当成「大家都还没用」。
    """
    return await quota.overview()


@router.post("/config/mail/test")
async def test_mail_config(
    payload: MailTestIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, Any]:
    """发一封测试邮件。收件人留空时发给「管理员收件人」。"""
    # HTML 走 mailer.wrap_html：移动端的排版（宽度自适应、长文本可折行）
    # 只在那一处维护，测试邮件不另起一套。
    sent_at = time.strftime('%Y-%m-%d %H:%M:%S')
    subject = "[测试] 面板邮件通知配置成功"
    body = (
        "如果你收到这封邮件，说明面板的 SMTP 配置可用。\n\n"
        f"发件时间：{sent_at}\n"
        "这封邮件由管理员的「测试发送」按钮触发。"
    )
    html = mailer.wrap_html(
        "邮件通知配置成功",
        [
            "如果你收到这封邮件，说明面板的 SMTP 配置可用。",
            f"发件时间：{sent_at}",
        ],
        "由管理员的「测试发送」按钮触发。",
    )

    target = (payload.to or "").strip()
    if target:
        ok, detail = await mailer.send_mail(target, subject, body, html=html)
    else:
        ok, detail = await mailer.send_to_admins(subject, body, html=html)

    await security.audit(
        request, user, "config.mail.test", target="mail_settings",
        result="success" if ok else "failed", detail=detail,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True, "detail": detail}
