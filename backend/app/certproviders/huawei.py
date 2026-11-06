"""华为云证书管理服务（SCM）适配器。

接口是 REST + SDK-HMAC-SHA256 签名（与 ``dnsproviders.HuaweiProvider`` 同一套算法，
只是域名换成 SCM、路径不同）。用到的端点（v3）：

* ``POST   /v3/scm/certificates``                 申请证书
* ``GET    /v3/scm/certificates/{id}``            查询状态 / 到期时间
* ``POST   /v3/scm/certificates/{id}/export``     导出证书与私钥
* ``DELETE /v3/scm/certificates/{id}``            退订 / 删除
* ``GET    /v3/scm/certificates``                 列表（页面绑定用）
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import httpx

from .base import (
    ApplyResult,
    CertInfo,
    CertProvider,
    ProviderError,
    STATUS_EXPIRED,
    STATUS_FAILED,
    STATUS_ISSUED,
    STATUS_PENDING,
    STATUS_REVOKED,
    parse_time,
)

#: SCM 的 status 字符串 → 统一状态码
STATUS_MAP = {
    "issued": STATUS_ISSUED,
    "active": STATUS_ISSUED,
    "success": STATUS_ISSUED,
    "normal": STATUS_ISSUED,
    "pending": STATUS_PENDING,
    "applying": STATUS_PENDING,
    "issuing": STATUS_PENDING,
    "checking": STATUS_PENDING,
    "pending_domain_validation": STATUS_PENDING,
    "expired": STATUS_EXPIRED,
    "revoked": STATUS_REVOKED,
    "failed": STATUS_FAILED,
    "canceled": STATUS_FAILED,
    "cancelled": STATUS_FAILED,
}


def _headers(
    key_id: str, secret: str, host: str, method: str, uri: str, query: str, body: str
) -> Dict[str, str]:
    """SDK-HMAC-SHA256：方法 / 路径 / 查询 / 头 / 头名 / 载荷哈希。"""
    now = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    content_type = "application/json;charset=utf8"
    canonical_headers = f"content-type:{content_type}\nhost:{host}\nx-sdk-date:{now}\n"
    signed_headers = "content-type;host;x-sdk-date"
    canonical_request = "\n".join(
        [
            method,
            uri,
            query,
            canonical_headers,
            signed_headers,
            hashlib.sha256(body.encode("utf-8")).hexdigest(),
        ]
    )
    string_to_sign = "\n".join(
        [
            "SDK-HMAC-SHA256",
            now,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {
        "Authorization": (
            f"SDK-HMAC-SHA256 Access={key_id}, SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        ),
        "Content-Type": content_type,
        "Host": host,
        "X-Sdk-Date": now,
    }


class HuaweiProvider(CertProvider):
    kind = "huawei"
    label = "华为云证书管理（SCM）"

    def __init__(self, cfg: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(cfg)
        self.key_id = str(self.cfg.get("access_key_id") or "").strip()
        self.secret = str(self.cfg.get("access_key_secret") or "").strip()
        region = str(self.cfg.get("region") or "cn-north-4").strip() or "cn-north-4"
        self.host = f"scm.{region}.myhuaweicloud.com"

    @property
    def configured(self) -> bool:
        return bool(self.key_id and self.secret)

    # -------------------------------------------------------------- HTTP
    async def _call(
        self, method: str, path: str, params: Optional[Dict[str, str]] = None, body: Any = None
    ) -> Any:
        if not self.configured:
            raise ProviderError("未配置华为云 Access Key / Secret Key")
        query = urlencode(sorted((params or {}).items()))
        payload = "" if body is None else _json(body)
        headers = _headers(
            self.key_id, self.secret, self.host, method, path, query, payload
        )
        url = "https://" + self.host + path + (("?" + query) if query else "")
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.request(
                    method,
                    url,
                    content=payload.encode("utf-8") if payload else None,
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            raise ProviderError("请求华为云接口失败：" + str(exc)) from exc

        text = resp.text or ""
        data: Any = {}
        if text:
            try:
                data = resp.json()
            except ValueError:
                data = {"message": text[:300]}
        if resp.status_code >= 400:
            message = ""
            if isinstance(data, dict):
                message = str(
                    data.get("message")
                    or data.get("error_msg")
                    or (data.get("error") or {}).get("message")
                    or ""
                )
            raise ProviderError(
                message or ("华为云返回 HTTP " + str(resp.status_code)),
                code=str(resp.status_code),
            )
        return data

    # -------------------------------------------------------------- 申请
    async def apply(
        self,
        domains: List[str],
        *,
        renew_from: str = "",
        alias: str = "",
    ) -> ApplyResult:
        if not domains:
            raise ProviderError("请填写要签发的域名")
        wildcard = any(domain.startswith("*.") for domain in domains)
        body = {
            "domain_name": list(domains),
            "cert_brand": str(self.cfg.get("cert_brand") or "GEOTRUST_GLOBAL"),
            "cert_type": "DV_SSL_CERT",
            "key_algorithm": str(self.cfg.get("key_algorithm") or "RSA_2048"),
            "domain_type": "WILDCARD_DOMAIN" if wildcard else (
                "MULTI_DOMAIN" if len(domains) > 1 else "SINGLE_DOMAIN"
            ),
            "validity_period": 1,
        }
        if alias:
            body["alias"] = alias[:64]
        data = await self._call("POST", "/v3/scm/certificates", body=body)
        cert_id = str((data or {}).get("certificate_id") or "")
        if not cert_id:
            raise ProviderError("华为云未返回证书 ID")
        return ApplyResult(
            cert_id=cert_id,
            status=STATUS_PENDING,
            domains=list(domains),
            detail="证书申请已提交（ID " + cert_id + "），等待 CA 签发",
        )

    # -------------------------------------------------------------- 查询 / 下载
    async def describe(self, cert_id: str) -> Optional[CertInfo]:
        try:
            data = await self._call("GET", "/v3/scm/certificates/" + cert_id)
        except ProviderError as exc:
            if str(exc.code) == "404":
                return None
            raise
        if not isinstance(data, dict) or not data:
            return None
        return self._info(data, cert_id)

    async def download(self, cert_id: str) -> Dict[str, Any]:
        data = await self._call(
            "POST", "/v3/scm/certificates/" + cert_id + "/export", body={"type": "server"}
        )
        data = data if isinstance(data, dict) else {}
        pem = str(data.get("certificate") or "").strip()
        key = str(data.get("private_key") or "").strip()
        if "BEGIN CERTIFICATE" not in pem or "PRIVATE KEY" not in key:
            raise ProviderError("证书尚未签发，暂时无法导出")
        return {
            "fullchain": pem + "\n",
            "private_key": key + "\n",
            "chain_file": "huawei",
            "key_file": "huawei",
            "files": ["huawei"],
        }

    async def remove(self, cert_id: str) -> None:
        await self._call("DELETE", "/v3/scm/certificates/" + cert_id)

    async def list_certs(self, search: str = "", limit: int = 100) -> List[CertInfo]:
        data = await self._call(
            "GET",
            "/v3/scm/certificates",
            params={"limit": str(max(1, min(100, limit))), "offset": "0", "keyword": search},
        )
        data = data if isinstance(data, dict) else {}
        items: List[CertInfo] = []
        for item in data.get("certificates") or []:
            cert_id = str(item.get("certificate_id") or item.get("id") or "")
            if cert_id:
                items.append(self._info(item, cert_id))
        return items

    async def test(self) -> Dict[str, Any]:
        data = await self._call(
            "GET", "/v3/scm/certificates", params={"limit": "1", "offset": "0"}
        )
        data = data if isinstance(data, dict) else {}
        total = int(data.get("total_count") or data.get("total") or 0)
        return {
            "total": total,
            "detail": "连接成功，账号下共有 " + str(total) + " 张证书",
        }

    # -------------------------------------------------------------- 翻译
    @staticmethod
    def _info(data: Dict[str, Any], cert_id: str) -> CertInfo:
        raw_domains = data.get("domain_name")
        if isinstance(raw_domains, str):
            domains = [raw_domains]
        elif isinstance(raw_domains, list):
            domains = [str(item) for item in raw_domains if item]
        else:
            domains = []
        status = STATUS_MAP.get(str(data.get("status") or "").strip().lower(), STATUS_PENDING)
        return CertInfo(
            cert_id=cert_id,
            domains=domains or ([str(data.get("domain") or "")] if data.get("domain") else []),
            status=status,
            expire_at=parse_time(data.get("expire_time") or data.get("not_after")),
            alias=str(data.get("alias") or data.get("cert_name") or ""),
            encrypt_algo=str(data.get("key_algorithm") or ""),
            wildcard=any(domain.startswith("*.") for domain in domains),
            raw=data,
        )


def _json(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
