"""网站证书管理接口：腾讯云免费证书的申请、绑定、部署与续期。

按用户隔离：站点带归属（``username``），腾讯云密钥按用户分别存放，各自的证书在
各自的腾讯云账号下申请与部署。管理员可以**看到**全部站点（便于排障），但读改
一律以「自己的站点」为界 —— 证书的申请、部署、删除都只作用于本人名下的站点。
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from .. import certs, security
from ..tencent_ssl import TencentCloudError

router = APIRouter(prefix="/api/certs", tags=["certs"])

CERT_VIEW = security.require_permission("cert.view")
CERT_MANAGE = security.require_permission("cert.manage")


def _site_view(site: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """补充页面需要的派生字段；SSH 凭据只回传"是否已配置"，不回传明文。"""
    view = dict(site)
    view["ssh_password_set"] = bool(site.get("ssh_password"))
    view["ssh_key_set"] = bool(site.get("ssh_key"))
    view["ssh_password"] = ""
    view["ssh_key"] = ""
    left = certs.days_left(site)
    threshold = certs.renew_threshold(site, cfg)
    view["days_left"] = left
    view["renew_before_days_effective"] = threshold
    view["needs_renew"] = left is not None and left <= threshold
    return view


def _own(user: Dict[str, Any]) -> str:
    return str(user.get("username") or "")


async def _views(
    sites: List[Dict[str, Any]], own: str, own_cfg: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """批量构造站点视图。

    「是否需要续期」跟着站点归属者的配置走，所以管理员的页面上别人的站点也用
    对方自己的阈值，同一个归属只读一次配置。
    """
    cache: Dict[str, Dict[str, Any]] = {own: own_cfg}
    views: List[Dict[str, Any]] = []
    for site in sites:
        owner = certs.site_owner(site)
        if owner not in cache:
            cache[owner] = await certs.load_tencent(owner)
        views.append(_site_view(site, cache[owner]))
    return views


async def _view(site: Dict[str, Any], own: str, own_cfg: Dict[str, Any]) -> Dict[str, Any]:
    owner = certs.site_owner(site)
    cfg = own_cfg if owner == own else await certs.load_tencent(owner)
    return _site_view(site, cfg)


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("")
async def get_certs(
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    own = _own(user)
    scope = security.visible_owner(user)
    cfg = await certs.load_tencent(own)
    safe = dict(cfg)
    secret_set = bool(safe.get("secret_key"))
    safe["secret_key"] = ""
    sites = await _views(certs.visible_sites(await certs.load_sites(), scope), own, cfg)
    sites.sort(key=lambda s: (0 if s.get("needs_renew") else 1, s.get("days_left") if s.get("days_left") is not None else 9999))
    return {
        "tencent": safe,
        "secret_set": secret_set,
        "sites": sites,
        "logs": await certs.logs(60, owner=scope),
        "own_username": own,
        "is_admin": scope is None,
        "options": {
            "dv_auth_methods": [
                {"value": "DNS_AUTO", "label": "DNS_AUTO（自动添加解析，域名需托管在腾讯云 DNSPod）"},
                {"value": "DNS", "label": "DNS（手动添加解析记录）"},
                {"value": "FILE", "label": "FILE（站点根目录放置验证文件，需海外 CA 可访问）"},
            ],
            "encrypt_algos": [
                {"value": "RSA", "label": "RSA 2048"},
                {"value": "ECC", "label": "ECC prime256v1"},
            ],
            "deploy_methods": [
                {"value": value, "label": certs.DEPLOY_METHOD_LABELS[value]}
                for value in certs.DEPLOY_METHODS
            ],
        },
    }


@router.put("/tencent")
async def save_tencent_config(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """保存腾讯云密钥：只影响当前用户自己的账号配置。"""
    try:
        cfg = await certs.save_tencent(payload, _own(user))
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.tencent", "certs", "success", "更新腾讯云证书配置（本人）"
    )
    safe = dict(cfg)
    safe["secret_key"] = ""
    return {"tencent": safe, "secret_set": bool(cfg.get("secret_key"))}


@router.post("/tencent/test")
async def test_tencent(
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    try:
        result = await certs.test_connection(_own(user))
    except certs.CertError as exc:
        await security.audit(request, user, "cert.test", "certs", "failed", str(exc))
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        await security.audit(request, user, "cert.test", "certs", "failed", str(exc))
        raise _bad_request(exc) from exc
    await security.audit(request, user, "cert.test", "certs", "success", result["detail"])
    return result


@router.get("/tencent/list")
async def list_remote(
    search: str = "",
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """列出当前用户腾讯云账号下的证书（各人只看得到自己账号里的）。"""
    try:
        items = await certs.list_remote_certificates(_own(user), search=search)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        raise _bad_request(exc) from exc
    return {"certificates": items, "count": len(items)}


# ------------------------------------------------------------------ 站点管理
@router.post("/sites")
async def create_site(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    try:
        site = certs.normalise_site(payload)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    # 新站点归创建者所有；归属不允许由请求体指定
    site["username"] = _own(user)
    cfg = await certs.load_tencent(site["username"])
    await certs.update_site(site)
    await security.audit(
        request, user, "cert.site.create", site["domain"], "success", "新增证书站点 " + site["name"]
    )
    return {"site": _site_view(site, cfg)}


@router.put("/sites/{site_id}")
async def update_site(
    site_id: str,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    scope = _own(user)
    existing = await certs.get_site(site_id, scope)
    if not existing:
        raise HTTPException(status_code=404, detail="站点不存在")
    try:
        site = certs.normalise_site(payload, existing)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    site["id"] = existing["id"]
    cfg = await certs.load_tencent(site.get("username") or "")
    await certs.update_site(site)
    await security.audit(
        request, user, "cert.site.update", site["domain"], "success", "更新证书站点 " + site["name"]
    )
    return {"site": _site_view(site, cfg)}


@router.delete("/sites/{site_id}")
async def remove_site(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    # 只能删自己的站点：管理员能看见别人的，但不能替他删
    existing = await certs.get_site(site_id, _own(user))
    if not existing:
        raise HTTPException(status_code=404, detail="站点不存在")
    await certs.delete_site(site_id)
    await security.audit(
        request, user, "cert.site.delete", existing.get("domain", ""), "success",
        "删除证书站点 " + str(existing.get("name") or ""),
    )
    return {"removed": True, "detail": "站点已删除（已部署的证书文件未做改动）"}


async def _require_site(site_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """取自己的站点：站点变更一律只作用于本人（管理员也只读他人的）。"""
    site = await certs.get_site(site_id, _own(user))
    if not site:
        raise HTTPException(status_code=404, detail="站点不存在")
    return site


@router.post("/sites/{site_id}/apply")
async def apply_site_cert(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
    payload: Dict[str, Any] = Body(default_factory=dict),
) -> Dict[str, Any]:
    """申请免费证书；已到期或即将到期时自动走续期流程。"""
    own = _own(user)
    site = await _require_site(site_id, user)
    body = payload or {}
    if body.get("domain"):
        try:
            site["domain"] = certs.normalise_domain(body["domain"])
        except certs.CertError as exc:
            raise _bad_request(exc) from exc
    renew = bool(site.get("cert_id"))
    try:
        result = await certs.apply_certificate(site, renew=renew)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        await security.audit(request, user, "cert.apply", site["domain"], "failed", str(exc))
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.apply", site["domain"], "success", result["detail"]
    )
    fresh = await certs.get_site(site_id, own) or site
    return {**result, "site": await _view(fresh, own, await certs.load_tencent(own))}


@router.post("/sites/{site_id}/deploy")
async def deploy_site_cert(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """立即下载证书并写入部署目录。"""
    own = _own(user)
    site = await _require_site(site_id, user)
    action = "renew" if site.get("pending_cert_id") else "deploy"
    try:
        outcome = await certs.deploy_site(site, action=action)
    except certs.CertError as exc:
        await certs.record_log(site, action, "failed", str(exc))
        site["last_error"] = str(exc)
        await certs.update_site(site)
        await security.audit(request, user, "cert.deploy", site["domain"], "failed", str(exc))
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        await certs.record_log(site, action, "failed", str(exc))
        site["last_error"] = str(exc)
        await certs.update_site(site)
        await security.audit(request, user, "cert.deploy", site["domain"], "failed", str(exc))
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.deploy", site["domain"], "success", str(outcome.get("detail"))
    )
    fresh = await certs.get_site(site_id, own) or site
    return {**outcome, "site": await _view(fresh, own, await certs.load_tencent(own))}


@router.post("/sites/{site_id}/sync")
async def sync_site(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """从腾讯云同步该站点证书的状态与到期时间（用站点归属者的密钥）。"""
    own = _own(user)
    scope = security.visible_owner(user)
    site = await _require_site(site_id, scope)
    if not (site.get("cert_id") or site.get("pending_cert_id")):
        raise HTTPException(status_code=400, detail="该站点还没有绑定证书")
    cfg = await certs.cfg_for(site)
    client = certs.tencent_client(cfg)
    try:
        await certs.sync_site_cert(client, site)
    except TencentCloudError as exc:
        raise _bad_request(exc) from exc
    await certs.update_site(site)
    await security.audit(request, user, "cert.sync", site["domain"], "success", "同步证书状态")
    fresh = await certs.get_site(site_id, own) or site
    return {"site": _site_view(fresh, cfg)}


@router.post("/sites/{site_id}/bind")
async def bind_site_cert(
    site_id: str,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """绑定归属者腾讯云账号下已有的证书（不重新申请）。"""
    own = _own(user)
    scope = security.visible_owner(user)
    site = await _require_site(site_id, scope)
    try:
        result = await certs.bind_certificate(site, str((payload or {}).get("cert_id") or ""))
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.bind", site["domain"], "success", str(result.get("detail"))
    )
    fresh = await certs.get_site(site_id, own) or site
    return {**result, "site": await _view(fresh, own, await certs.load_tencent(own))}


@router.post("/sync")
async def sync_all(
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """同步自己名下站点的证书状态（管理员也不代他人同步）。"""
    own = _own(user)
    try:
        sites = await certs.sync_all(own)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    except TencentCloudError as exc:
        raise _bad_request(exc) from exc
    await security.audit(request, user, "cert.sync", "certs", "success", "同步证书状态")
    return {"sites": await _views(sites, own, await certs.load_tencent(own))}


@router.delete("/logs")
async def clear_logs(
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    removed = await certs.clear_logs(security.visible_owner(user))
    await security.audit(
        request, user, "cert.logs.clear", "certs", "success", "清空证书部署日志 " + str(removed) + " 条"
    )
    return {"removed": removed, "detail": "已清除 " + str(removed) + " 条日志"}
