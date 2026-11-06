"""阿里云数字证书（CAS）适配器。

RPC 风格接口，签名与 ``dnsproviders.AliyunProvider`` 同源（HMAC-SHA1），只是域名
换成 ``cas.aliyuncs.com``、版本换成 ``2020-04-07``。用到的动作：

* ``CreateCertificateForPackageRequest`` 提交免费 DV 证书申请
* ``DescribeCertificateState``        查询状态；**已签发时直接带回 PEM 与私钥**
* ``DeleteUserCertificate``           删除（阿里云没有独立的吊销接口给免费证书）
* ``ListUserCertificateOrder``        列出账号下的证书，供页面绑定
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx

from .base import (
    ApplyResult,
    CertInfo,
    CertProvider,
    ProviderError,
    STATUS_DNS_WAIT,
    STATUS_EXPIRED,
    STATUS_FAILED,
    STATUS_ISSUED,
    STATUS_PENDING,
    STATUS_REVOKED,
    parse_time,
)

HOST = "cas.aliyuncs.com"
VERSION = "2020-04-07"

#: DescribeCertificateState 的 Status → 统一状态码
STATUS_MAP = {
    "certificate": STATUS_ISSUED,
    "issued": STATUS_ISSUED,
    "active": STATUS_ISSUED,
    "success": STATUS_ISSUED,
    "pending": STATUS_PENDING,
    "processing": STATUS_PENDING,
    "applying": STATUS_PENDING,
    "checking": STATUS_PENDING,
    "expired": STATUS_EXPIRED,
    "will_expire": STATUS_EXPIRED,
    "revoked": STATUS_REVOKED,
    "failed": STATUS_FAILED,
    "rejected": STATUS_FAILED,
    "invalid": STATUS_FAILED,
    "canceled": STATUS_FAILED,
    "cancelled": STATUS_FAILED,
}


def _signature(params: Dict[str, str], secret: str) -> str:
    """RPC 签名：参数按字典序编码后 HMAC-SHA1(secret + "&")。"""
    encoded = "&".join(
        f"{quote(str(k), safe='')}={quote(str(v), safe='')}" for k, v in sorted(params.items())
    )
    string_to_sign = "GET&" + quote("/", safe="") + "&" + quote(encoded, safe="")
    digest = hmac.new(
        (secret + "&").encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1
    ).digest()
    return encoded + "&Signature=" + quote(base64.b64encode(digest).decode("ascii"), safe="")


class AliyunProvider(CertProvider):
    kind = "aliyun"
    label = "阿里云数字证书"

    def __init__(self, cfg: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(cfg)
        self.key_id = str(self.cfg.get("access_key_id") or "").strip()
        self.secret = str(self.cfg.get("access_key_secret") or "").strip()

    @property
    def configured(self) -> bool:
        return bool(self.key_id and self.secret)

    # -------------------------------------------------------------- HTTP
    async def _call(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.configured:
            raise ProviderError("未配置阿里云 AccessKey ID / AccessKey Secret")
        common = {
            "AccessKeyId": self.key_id,
            "Action": action,
            "Format": "JSON",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": secrets.token_hex(16),
            "SignatureVersion": "1.0",
            "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "Version": VERSION,
        }
        merged = {**common, **{k: str(v) for k, v in params.items() if v is not None}}
        query = _signature(merged, self.secret)
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.get("https://" + HOST + "/?" + query)
        except httpx.HTTPError as exc:
            raise ProviderError("请求阿里云接口失败：" + str(exc)) from exc

        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderError(
                "阿里云返回了无法解析的内容（HTTP " + str(resp.status_code) + "）"
            ) from exc
        # RPC 接口的错误既可能用 HTTP 4xx，也可能用 200 + Code 表达
        if resp.status_code >= 400 or data.get("Code"):
            raise ProviderError(
                str(data.get("Message") or data.get("Code") or "阿里云接口调用失败"),
                code=str(data.get("Code") or ""),
                request_id=str(data.get("RequestId") or ""),
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
        domain = domains[0] if domains else ""
        if not domain:
            raise ProviderError("请填写要签发的域名")
        if domain.startswith("*."):
            raise ProviderError("阿里云免费证书不支持泛域名")
        params: Dict[str, Any] = {
            "Domain": domain,
            "ValidateType": str(self.cfg.get("validate_type") or "DNS_AUTO"),
        }
        if alias:
            params["Alias"] = alias[:64]
        # 免费证书额度按账号计，续期时带上旧 ID 让阿里云回收旧额度
        if renew_from:
            params["OldCertificateId"] = renew_from
        data = await self._call("CreateCertificateForPackageRequest", params)
        cert_id = str(data.get("CertificateId") or "")
        if not cert_id:
            raise ProviderError("阿里云未返回证书 ID")
        return ApplyResult(
            cert_id=cert_id,
            status=STATUS_PENDING,
            domains=list(domains),
            detail="证书申请已提交（ID " + cert_id + "），等待 CA 签发",
        )

    # -------------------------------------------------------------- 查询 / 下载
    async def _state(self, cert_id: str) -> Dict[str, Any]:
        return await self._call("DescribeCertificateState", {"CertificateId": cert_id})

    async def describe(self, cert_id: str) -> Optional[CertInfo]:
        try:
            data = await self._state(cert_id)
        except ProviderError as exc:
            # 证书不存在时阿里云用 InvalidCertificateId 之类的业务码拒绝
            if "not exist" in str(exc).lower() or "InvalidCertificate" in str(exc.code):
                return None
            raise
        if not data or not (data.get("CertificateId") or data.get("Domain")):
            return None
        return self._info(data, cert_id)

    async def download(self, cert_id: str) -> Dict[str, Any]:
        data = await self._state(cert_id)
        pem = str(data.get("Certificate") or "").strip()
        key = str(data.get("PrivateKey") or "").strip()
        if "BEGIN CERTIFICATE" not in pem or "PRIVATE KEY" not in key:
            raise ProviderError("证书尚未签发，暂时无法下载")
        return {
            "fullchain": pem + "\n",
            "private_key": key + "\n",
            "chain_file": "aliyun",
            "key_file": "aliyun",
            "files": ["aliyun"],
        }

    async def remove(self, cert_id: str) -> None:
        await self._call("DeleteUserCertificate", {"CertificateId": cert_id})

    async def list_certs(self, search: str = "", limit: int = 100) -> List[CertInfo]:
        data = await self._call(
            "ListUserCertificateOrder",
            {"Keyword": search, "CurrentPage": 1, "ShowSize": max(1, min(100, limit))},
        )
        items: List[CertInfo] = []
        for item in data.get("CertificateOrderList") or data.get("CertificateList") or []:
            cert_id = str(item.get("CertificateId") or item.get("InstanceId") or "")
            if not cert_id:
                continue
            items.append(self._info(item, cert_id))
        return items

    async def test(self) -> Dict[str, Any]:
        data = await self._call(
            "ListUserCertificateOrder", {"CurrentPage": 1, "ShowSize": 1}
        )
        total = int(data.get("TotalCount") or 0)
        return {
            "total": total,
            "detail": "连接成功，账号下共有 " + str(total) + " 张证书",
        }

    # -------------------------------------------------------------- 翻译
    @staticmethod
    def _info(data: Dict[str, Any], cert_id: str) -> CertInfo:
        domain = str(data.get("Domain") or data.get("CommonName") or "")
        raw_status = str(data.get("Status") or "")
        status = STATUS_MAP.get(raw_status.strip().lower(), STATUS_PENDING)
        if "dns" in raw_status.lower():
            status = STATUS_DNS_WAIT
        expire = parse_time(
            data.get("NotAfter") or data.get("CertEndTime") or data.get("ExpireTime")
        )
        if not expire:
            expire = _expire_from_pem(str(data.get("Certificate") or ""))
        return CertInfo(
            cert_id=cert_id,
            domains=[domain] if domain else [],
            status=status,
            expire_at=expire,
            alias=str(data.get("Alias") or data.get("Name") or ""),
            wildcard=domain.startswith("*."),
            raw=data,
        )


def _expire_from_pem(pem: str) -> int:
    """阿里云的状态接口不总是给到期时间，已签发时从证书本身读。"""
    if "BEGIN CERTIFICATE" not in pem:
        return 0
    try:
        from ..acme import cert_expire_at

        return int(cert_expire_at(pem))
    except Exception:  # noqa: BLE001 - 解析失败只是少一个到期时间
        return 0
