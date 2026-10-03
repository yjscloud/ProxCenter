"""Proxmox connection configuration and health endpoints."""
from __future__ import annotations

import secrets
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import (
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
    connection_from_profile,
    get_client,
    rebuild_client,
)
from ..schemas import (
    ConnectionConfigIn,
    ConnectionTestIn,
    FaqIn,
    LoginCaptchaIn,
    MailConfigIn,
    MailTestIn,
    PanelUrlIn,
    SiteInfoIn,
    UiPrefsIn,
    VmDefaultsIn,
    VmQuotaIn,
)

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/health")
async def health() -> Dict[str, Any]:
    """Unauthenticated liveness probe. Reports PVE reachability.

    Used by the login screen to show whether the backend can reach Proxmox,
    so it must never require a panel session.
    """
    result: Dict[str, Any] = {
        "status": "ok",
        "pve_connected": False,
        "version": "0.1.3",
        "pve_version": None,
        "node_count": 0,
        "error": None,
    }

    client = get_client()
    if not client.conn.configured:
        result["error"] = "Proxmox 连接未配置"
        return result

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
# 支持保存多台 Proxmox；所有业务模块始终使用「当前连接」，切换即全局生效。


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
    """全部已保存的 PVE 连接（密钥只回传「是否已设置」）。"""
    await security.audit_read(request, user, "config.connections.read")
    conns = store.get_connections()
    active_id = str(store.get_active_connection().get("id") or "")
    result: List[Dict[str, Any]] = []
    for c in conns:
        pub = store.public_connection_config(c)
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
    """
    client = get_client()

    checks: List[Dict[str, Any]] = []

    def add(key: str, label: str, status: str, detail: str, hint: str = "") -> None:
        checks.append(
            {"key": key, "label": label, "status": status, "detail": detail, "hint": hint}
        )

    result: Dict[str, Any] = {
        "ok": False,
        "reachable": False,
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
    """
    secret = payload.token_secret
    if not secret:
        existing = store.get_connection_config()
        secret = existing.get("token_secret", "")

    if not secret:
        raise HTTPException(status_code=400, detail="缺少 API Token Secret")

    conn = PveConnection(
        host=payload.host,
        port=payload.port,
        token_id=payload.token_id,
        token_secret=secret,
        verify_ssl=payload.verify_ssl,
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
) -> Dict[str, str]:
    """面板级创建默认值（当前只有默认 DNS）。

    创建向导向所有可创建虚拟机的用户预填这个值，因此读取只要求登录。
    """
    return await defaults.get_vm_defaults()


@router.put("/config/vm-defaults")
async def put_vm_defaults(
    payload: VmDefaultsIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.require_permission("settings.manage")),
) -> Dict[str, str]:
    """保存默认 DNS。留空 = 不干预，创建/克隆时完全继承 DHCP / RA 下发的 DNS。"""
    saved = await defaults.set_vm_defaults(payload.dns)
    await security.audit(
        request,
        user,
        "config.vm_defaults",
        target="vm-defaults",
        detail={"dns": saved["dns"] or "(空)"},
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
