"""腾讯云 SSL 证书适配器。

底层仍是 ``tencent_ssl.TencentSslClient``（TC3-HMAC-SHA256 手写签名），这里只做
「厂商响应 → 统一结构」的翻译，把腾讯云的整数状态码原样透传（它本来就是统一
状态码的口径来源）。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..tencent_ssl import TencentCloudError, TencentSslClient, parse_certificate_bundle
from .base import (
    CertInfo,
    CertProvider,
    ApplyResult,
    ProviderError,
    STATUS_PENDING,
    parse_time,
)


class TencentProvider(CertProvider):
    kind = "tencent"
    label = "腾讯云 SSL 证书"

    def __init__(self, cfg: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(cfg)
        self.client = TencentSslClient(
            str(self.cfg.get("secret_id") or ""),
            str(self.cfg.get("secret_key") or ""),
        )

    @property
    def configured(self) -> bool:
        return self.client.configured

    # -------------------------------------------------------------- 申请
    async def apply(
        self,
        domains: List[str],
        *,
        renew_from: str = "",
        alias: str = "",
    ) -> ApplyResult:
        domain = domains[0] if domains else ""
        if not domain:
            raise ProviderError("请填写要签发的域名")
        try:
            cert_id = await self.client.apply_free_certificate(
                domain,
                dv_auth_method=str(self.cfg.get("dv_auth_method") or "DNS_AUTO"),
                old_certificate_id=renew_from,
                alias=alias or domain,
                encrypt_algo=str(self.cfg.get("encrypt_algo") or "RSA"),
            )
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc
        return ApplyResult(
            cert_id=cert_id,
            status=STATUS_PENDING,
            domains=list(domains),
            detail="证书申请已提交（ID " + cert_id + "），等待 CA 签发",
        )

    # -------------------------------------------------------------- 查询 / 下载
    async def describe(self, cert_id: str) -> Optional[CertInfo]:
        try:
            cert = await self.client.describe_certificate(cert_id)
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc
        if not cert:
            return None
        return self._info(cert)

    async def download(self, cert_id: str) -> Dict[str, Any]:
        try:
            data = await self.client.download_certificate(cert_id)
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc
        return parse_certificate_bundle(data)

    async def remove(self, cert_id: str) -> None:
        try:
            await self.client.delete_certificate(cert_id)
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc

    async def list_certs(self, search: str = "", limit: int = 100) -> List[CertInfo]:
        try:
            body = await self.client.describe_certificates(search_key=search, limit=limit)
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc
        return [self._info(item) for item in body.get("Certificates") or []]

    async def test(self) -> Dict[str, Any]:
        try:
            body = await self.client.describe_certificates(limit=1)
        except TencentCloudError as exc:
            raise ProviderError(str(exc), code=exc.code, request_id=exc.request_id) from exc
        total = int(body.get("TotalCount") or 0)
        return {
            "total": total,
            "detail": "连接成功，账号下共有 " + str(total) + " 张证书",
        }

    # -------------------------------------------------------------- 翻译
    @staticmethod
    def _info(cert: Dict[str, Any]) -> CertInfo:
        domain = str(cert.get("Domain") or "")
        status = int(cert.get("Status") or 0)
        return CertInfo(
            cert_id=str(cert.get("CertificateId") or ""),
            domains=[domain] if domain else [],
            status=status,
            expire_at=parse_time(cert.get("CertEndTime")),
            alias=str(cert.get("Alias") or ""),
            encrypt_algo=str(cert.get("EncryptAlgorithm") or ""),
            wildcard=bool(cert.get("IsWildcard")) or domain.startswith("*."),
            raw=cert,
        )
