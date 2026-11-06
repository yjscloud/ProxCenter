"""网站证书管理接口：腾讯云免费证书的申请、绑定、部署与续期。

按用户隔离：站点带归属（``username``），腾讯云密钥按用户分别存放，各自的证书在
各自的腾讯云账号下申请与部署。管理员可以**看到**全部站点（便于排障），但读改
一律以「自己的站点」为界 —— 证书的申请、部署、删除都只作用于本人名下的站点。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from .. import certs, dnsproviders, i18n, security
from ..acme import DIRECTORIES
from ..certproviders import (
    PROVIDERS as CLOUD_PROVIDERS,
    SECRET_FIELDS as PROVIDER_SECRET_FIELDS,
    ProviderError,
    label as provider_label,
    schema as provider_schema,
)
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
    # 站点当前用哪家厂商签发：页面只读展示，切换厂商不影响历史日志
    view["ca"] = certs.ca_kind(site)
    view["ca_label"] = i18n.tr(provider_label(view["ca"]))
    # 腾云状态与上一次错误是存库的中文字符串，出口按请求语言渲染：
    # 状态是固定枚举（tencent_ssl.STATUS_TEXT）一定命中；last_error 多为
    # 「前缀 + 动态值」，在生成处已用双语拼好，这里兜底整句命中的情况。
    view["cert_status_text"] = i18n.tr(str(view.get("cert_status_text") or ""))
    view["last_error"] = i18n.tr(str(view.get("last_error") or ""))
    return view


def _own(user: Optional[Dict[str, Any]]) -> str:
    """当前用户名。

    正常情况下拿到的都是用户字典；这里容错非字典入参 —— 曾经有调用点把
    ``security.visible_owner(user)``（管理员为 ``None``）当作 user 传进来，
    直接 ``user.get`` 炸成 500。现在退化成「归属为空」，最坏是查不到站点（404）。
    """
    if not isinstance(user, dict):
        return ""
    return str(user.get("username") or "")


def _acme_view(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """ACME 配置的对外视图：只说明「有没有配」，凭据一律不回传。"""
    view: Dict[str, Any] = {
        "email": cfg.get("email") or "",
        "directory": cfg.get("directory") or "",
        "encrypt_algo": cfg.get("encrypt_algo") or "RSA",
        "dns_provider": cfg.get("dns_provider") or "",
        "dns_wait": int(cfg.get("dns_wait") or 0),
        "account_key": "",
        "account_key_set": bool(cfg.get("account_key")),
    }
    secret_set: Dict[str, Dict[str, bool]] = {}
    for name, fields in certs.ACME_SECRET_FIELDS.items():
        block = dict(cfg.get(name) or {})
        secret_set[name] = {}
        for field in fields:
            secret_set[name][field] = bool(block.get(field))
            block[field] = ""
        view[name] = block  # secret_id / access_key_id 这类非密文字段照常回显
    view["secret_set"] = secret_set
    return view


async def _views(sites: List[Dict[str, Any]], own: str) -> List[Dict[str, Any]]:
    """批量构造站点视图。

    「是否需要续期」跟着站点归属者在该**签发渠道**上的配置走：同一个用户可能给
    不同站点配了不同厂商，阈值也各自独立。缓存键是「归属 + 厂商」。
    """
    cache: Dict[tuple, Dict[str, Any]] = {}
    views: List[Dict[str, Any]] = []
    for site in sites:
        key = (certs.site_owner(site), certs.ca_kind(site))
        if key not in cache:
            cache[key] = await certs.provider_cfg_for(site) if certs.is_cloud_provider(key[1]) else {}
        views.append(_site_view(site, cache[key]))
    return views


async def _view(site: Dict[str, Any]) -> Dict[str, Any]:
    kind = certs.ca_kind(site)
    cfg = await certs.provider_cfg_for(site) if certs.is_cloud_provider(kind) else {}
    return _site_view(site, cfg)


def _provider_view(kind: str, item: Dict[str, Any]) -> Dict[str, Any]:
    """厂商配置的对外视图：结构给前端渲染表单，密文只回「有没有配」。"""
    cfg = item.get("_cfg") or {}
    view: Dict[str, Any] = {
        "kind": kind,
        "label": i18n.tr(provider_label(kind)),
        "label_key": item.get("label_key") or "",
        "tagline": i18n.tr(item.get("tagline") or ""),
        "tagline_key": item.get("tagline_key") or "",
        "help_url": item.get("help_url") or "",
        "configured": bool(item.get("_configured")),
        "synchronous": bool(item.get("synchronous")),
        "fields": item.get("fields") or [],
        "values": {},
        "secret_set": {},
    }
    defaults = item.get("defaults") or {}
    for field in item.get("fields") or []:
        key = str(field.get("key") or "")
        if field.get("secret"):
            view["secret_set"][key] = bool(cfg.get(key))
            view["values"][key] = ""
        else:
            value = cfg.get(key, defaults.get(key, ""))
            view["values"][key] = value
    return view


async def _providers_view(owner: str) -> List[Dict[str, Any]]:
    """把已登记的厂商逐个包成页面需要的结构（含当前用户的配置）。"""
    result: List[Dict[str, Any]] = []
    for item in provider_schema():
        kind = str(item.get("kind") or "")
        cfg = await certs.load_provider(kind, owner)
        try:
            configured = bool(certs.build_provider(kind, cfg).configured)
        except ProviderError:
            configured = False
        data = dict(item)
        data["_cfg"] = cfg
        data["_configured"] = configured
        result.append(_provider_view(kind, data))
    # ACME 不是厂商，但对用户来说同样是「一条签发渠道」：并进同一份列表，
    # 页面就不必再单独维护一张 ACME 卡片
    result.append(certs.acme_channel_view(await certs.load_acme(owner)))
    return result


def _bad_request(exc: Exception) -> HTTPException:
    """把模块抛出的业务错误转成 400，并按请求语言翻译。

    证书模块的校验消息（域名、目录、SSH、部署方式……几十条）都集中在
    ``certs`` 里以中文抛出，在这里收口翻译比在每个 ``raise`` 处包 ``tr()``
    干净得多；腾讯云返回的英文报错查不到译表，原样透传，不受影响。
    """
    return HTTPException(status_code=400, detail=i18n.tr(str(exc)))


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
    sites = await _views(certs.visible_sites(await certs.load_sites(), scope), own)
    sites.sort(key=lambda s: (0 if s.get("needs_renew") else 1, s.get("days_left") if s.get("days_left") is not None else 9999))
    return {
        # 兼容旧前端：腾讯云的单独视图继续保留
        "tencent": safe,
        "secret_set": secret_set,
        "acme": _acme_view(await certs.load_acme(own)),
        # 统一抽象层：每家厂商一份 schema + 当前用户的配置视图（密文只回「有没有」）
        "providers": await _providers_view(own),
        "sites": sites,
        "templates": await certs.load_templates(own),
        "logs": await certs.logs(60, owner=scope),
        "inventory": await certs.inventory(scope),
        "own_username": own,
        "is_admin": scope is None,
        # 容器内运行时「本机目录」写的是容器文件系统，页面据这条提示引导改用 SSH / 虚拟机
        "local_deploy_hint": certs.local_deploy_hint(),
        "options": {
            "dv_auth_methods": [
                {
                    "value": "DNS_AUTO",
                    "label": i18n.tr("DNS_AUTO（自动添加解析，域名需托管在 DNS 服务商）"),
                },
                {"value": "DNS", "label": i18n.tr("DNS（手动添加解析记录）")},
                {
                    "value": "FILE",
                    "label": i18n.tr("FILE（站点根目录放置验证文件，需海外 CA 可访问）"),
                },
            ],
            "encrypt_algos": [
                {"value": "RSA", "label": "RSA 2048"},
                {"value": "ECC", "label": "ECC prime256v1"},
            ],
            "deploy_methods": [
                {
                    "value": value,
                    "label": i18n.tr(certs.DEPLOY_METHOD_LABELS[value]),
                }
                for value in certs.DEPLOY_METHODS
            ],
            # 签发渠道 = 已登记的云厂商 + ACME + 托管证书；新增厂商自动出现在这里
            "cas": [
                {
                    "value": kind,
                    "label": i18n.tr(provider_label(kind)),
                }
                for kind in CLOUD_PROVIDERS
            ]
            + [
                {
                    "value": "acme",
                    "label": i18n.tr("ACME（Let's Encrypt / ZeroSSL，支持泛域名与多域名）"),
                },
                {
                    "value": "upload",
                    "label": i18n.tr("托管证书（自行上传 PEM / 私钥）"),
                },
            ],
            "provider_kinds": list(CLOUD_PROVIDERS),
            "acme_challenges": [
                {
                    "value": "dns",
                    "label": i18n.tr("DNS-01（自动加 TXT 记录，支持泛域名）"),
                },
                {
                    "value": "http",
                    "label": i18n.tr("HTTP-01（把验证文件写进 webroot）"),
                },
            ],
            "acme_directories": [
                {"value": value, "label": name} for name, value in DIRECTORIES
            ],
            "dns_providers": [
                {"value": key, "label": dnsproviders.PROVIDER_LABELS[key]}
                for key in dnsproviders.PROVIDERS
            ],
        },
    }


@router.get("/providers")
async def list_providers(
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """已登记的签发厂商 + 当前用户的配置视图（凭据只回「有没有配」）。"""
    return {"providers": await _providers_view(_own(user))}


@router.put("/providers/{kind}")
async def save_provider_config(
    kind: str,
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """保存某家厂商的凭据：只影响当前用户自己的账号配置。

    密文字段留空表示沿用旧值，因此页面上不必每次都把 Secret 回填出来。
    """
    kind = str(kind or "").strip().lower()
    try:
        if kind == "acme":
            await certs.save_acme(certs.acme_payload(payload or {}), _own(user))
        else:
            await certs.save_provider(kind, payload or {}, _own(user))
    except (certs.CertError, ProviderError) as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request,
        user,
        "cert.provider." + kind,
        "certs",
        "success",
        "更新证书厂商配置（" + kind + "，本人）",
    )
    providers = await _providers_view(_own(user))
    current = next((item for item in providers if item["kind"] == kind), None)
    return {"provider": current, "providers": providers}


@router.post("/providers/{kind}/test")
async def test_provider(
    kind: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """验证当前用户在某家厂商上的密钥是否可用。"""
    kind = str(kind or "").strip().lower()
    try:
        result = await certs.test_connection(kind, _own(user))
    except (certs.CertError, ProviderError, TencentCloudError) as exc:
        await security.audit(
            request, user, "cert.provider.test", "certs", "failed", str(exc)
        )
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.provider.test", "certs", "success", str(result.get("detail") or "")
    )
    return {**result, "provider": kind}


@router.get("/providers/{kind}/certificates")
async def list_provider_certificates(
    kind: str,
    search: str = "",
    limit: int = 100,
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """列出某家厂商账号下的证书，供页面选择绑定。"""
    kind = str(kind or "").strip().lower()
    try:
        items = await certs.list_remote_certificates(
            kind, _own(user), search=search, limit=limit
        )
    except (certs.CertError, ProviderError, TencentCloudError) as exc:
        raise _bad_request(exc) from exc
    return {"certificates": items, "count": len(items), "provider": kind}


@router.put("/tencent")
async def save_tencent_config(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """兼容旧入口：等价于 ``PUT /providers/tencent``。"""
    try:
        cfg = await certs.save_provider("tencent", payload or {}, _own(user))
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.tencent", "certs", "success", "更新腾讯云证书配置（本人）"
    )
    safe = dict(cfg)
    safe["secret_key"] = ""
    return {"tencent": safe, "secret_set": bool(cfg.get("secret_key"))}


@router.put("/acme")
async def save_acme_config(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """保存 ACME 配置（邮箱、目录、DNS 服务商凭据），只影响当前用户。"""
    try:
        cfg = await certs.save_acme(payload or {}, _own(user))
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.acme", "certs", "success", "更新 ACME 证书配置（本人）"
    )
    return {"acme": _acme_view(cfg)}


@router.post("/tencent/test")
async def test_tencent(
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """兼容旧入口：等价于 ``POST /providers/tencent/test``。"""
    return await test_provider("tencent", request, user)


@router.get("/tencent/list")
async def list_remote(
    search: str = "",
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """兼容旧入口：等价于 ``GET /providers/tencent/certificates``。"""
    return await list_provider_certificates("tencent", search, 100, user)


# ------------------------------------------------------------ 证书清单（多站点）
@router.get("/inventory")
async def get_inventory(
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """站点证书清单：按「厂商 + 证书 ID」聚合，能看到一张证书绑了哪些站点。"""
    items = await certs.inventory(security.visible_owner(user))
    return {"items": items, "count": len(items)}


@router.post("/inventory/bind")
async def bind_inventory(
    payload: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """把某家厂商账号下的一张证书一次绑到多个站点上。

    绑定同时把站点的签发渠道切到该厂商；证书覆盖不到域名的站点会被跳过并给出
    原因（不会让整批失败）。
    """
    body = payload or {}
    own = _own(user)
    kind = str(body.get("provider") or "tencent").strip().lower()
    site_ids = [str(item) for item in body.get("site_ids") or []]
    try:
        result = await certs.bind_to_sites(
            kind, str(body.get("cert_id") or ""), site_ids, owner=own
        )
    except (certs.CertError, ProviderError, TencentCloudError) as exc:
        await security.audit(
            request, user, "cert.inventory.bind", kind, "failed", str(exc)
        )
        raise _bad_request(exc) from exc
    await security.audit(
        request,
        user,
        "cert.inventory.bind",
        str(body.get("cert_id") or ""),
        "success",
        str(result.get("detail") or ""),
    )
    return {
        **result,
        "inventory": await certs.inventory(security.visible_owner(user)),
    }


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
    cfg = await certs.provider_cfg_for(site)
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
        raise HTTPException(status_code=404, detail=i18n.tr("站点不存在"))
    try:
        site = certs.normalise_site(payload, existing)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    site["id"] = existing["id"]
    cfg = await certs.provider_cfg_for(site)
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
        raise HTTPException(status_code=404, detail=i18n.tr("站点不存在"))
    await certs.delete_site(site_id)
    await security.audit(
        request, user, "cert.site.delete", existing.get("domain", ""), "success",
        "删除证书站点 " + str(existing.get("name") or ""),
    )
    return {
        "removed": True,
        "detail": i18n.tr("站点已删除（已部署的证书文件未做改动）"),
    }


async def _require_site(site_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """取自己的站点：站点变更一律只作用于本人（管理员也只读他人的）。"""
    site = await certs.get_site(site_id, _own(user))
    if not site:
        raise HTTPException(status_code=404, detail=i18n.tr("站点不存在"))
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
        # 云厂商的免费 DV 证书都不支持泛域名：在提交前拦下，别等对面报错
        if certs.is_cloud_provider(certs.ca_kind(site)) and site["domain"].startswith("*."):
            raise HTTPException(
                status_code=400,
                detail=i18n.tr("该渠道的免费证书不支持泛域名，请把站点改成 ACME 渠道"),
            )
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
    return {**result, "site": await _view(fresh)}


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
    return {**outcome, "site": await _view(fresh)}


@router.post("/sites/{site_id}/sync")
async def sync_site(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """从腾讯云同步该站点证书的状态与到期时间（用站点归属者的密钥）。"""
    own = _own(user)
    site = await _require_site(site_id, user)
    if not (site.get("cert_id") or site.get("pending_cert_id")):
        raise HTTPException(status_code=400, detail="该站点还没有绑定证书")
    if certs.ca_kind(site) in ("acme", "upload"):
        # ACME / 托管证书在签发或上传时就把证书落到站点上了，没有「远端状态」这一说
        raise HTTPException(
            status_code=400,
            detail=i18n.tr("该站点的证书已保存在本地，没有远端状态可同步"),
        )
    cfg = await certs.provider_cfg_for(site)
    try:
        await certs.sync_site_cert(site)
    except (certs.CertError, TencentCloudError) as exc:
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
    """绑定归属者某家厂商账号下已有的证书（不重新申请）。

    请求体可带 ``provider``（``tencent`` / ``aliyun`` / ``huawei``）：带上就把站点
    的签发渠道一并切到这家厂商，之后续期与下载都走它。
    """
    own = _own(user)
    site = await _require_site(site_id, user)
    body = payload or {}
    try:
        result = await certs.bind_certificate(
            site,
            str(body.get("cert_id") or ""),
            kind=str(body.get("provider") or "") or None,
        )
    except (certs.CertError, ProviderError, TencentCloudError) as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.bind", site["domain"], "success", str(result.get("detail"))
    )
    fresh = await certs.get_site(site_id, own) or site
    return {**result, "site": await _view(fresh)}


@router.post("/sites/{site_id}/certificate")
async def import_site_certificate(
    site_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
    payload: Dict[str, Any] = Body(default_factory=dict),
) -> Dict[str, Any]:
    """托管一张外部证书：校验 PEM/KEY 配对、域名覆盖与到期时间后落库。"""
    own = _own(user)
    site = await _require_site(site_id, user)
    body = payload or {}
    try:
        result = await certs.import_certificate(
            site, str(body.get("pem") or ""), str(body.get("key") or "")
        )
    except certs.CertError as exc:
        await security.audit(request, user, "cert.import", site["domain"], "failed", str(exc))
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.import", site["domain"], "success", str(result.get("detail"))
    )
    fresh = await certs.get_site(site_id, own) or site
    return {**result, "site": await _view(fresh)}


# ------------------------------------------------------------------ 站点模板
@router.get("/templates")
async def list_templates(
    user: Dict[str, Any] = Depends(CERT_VIEW),
) -> Dict[str, Any]:
    """当前用户的站点模板（部署方式 / 目录 / 续期策略，不含凭据）。"""
    return {"templates": await certs.load_templates(_own(user))}


@router.post("/templates")
async def create_template(
    request: Request,
    payload: Dict[str, Any] = Body(default_factory=dict),
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    """保存模板：传 ``site_id`` 就从该站点复制，否则按请求体里的字段存。"""
    own = _own(user)
    body = payload or {}
    site = None
    if body.get("site_id"):
        site = await certs.get_site(str(body["site_id"]), own)
        if not site:
            raise HTTPException(status_code=404, detail=i18n.tr("站点不存在"))
    if site is None and not str(body.get("deploy_dir") or "").strip():
        raise HTTPException(
            status_code=400,
            detail=i18n.tr("请指定要复制的站点，或至少填写部署目录"),
        )
    try:
        template = await certs.save_template(body, own, site)
    except certs.CertError as exc:
        raise _bad_request(exc) from exc
    await security.audit(
        request, user, "cert.template", template.get("name", ""), "success", "保存站点模板"
    )
    return {"template": template}


@router.delete("/templates/{template_id}")
async def remove_template(
    template_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(CERT_MANAGE),
) -> Dict[str, Any]:
    if not await certs.delete_template(template_id, _own(user)):
        raise HTTPException(status_code=404, detail=i18n.tr("模板不存在"))
    await security.audit(request, user, "cert.template", template_id, "success", "删除站点模板")
    return {"removed": True}


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
    return {"sites": await _views(sites, own)}


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
