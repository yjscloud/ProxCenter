"""腾讯云 SSL 证书客户端。

只依赖标准库 + httpx：按腾讯云 API 3.0 的 TC3-HMAC-SHA256 规则自行签名，
不引入 ``tencentcloud-sdk-python``，与本项目"依赖尽量精简"的取向一致。

用到的三个接口（Version 固定 2019-12-05，域名 ssl.tencentcloudapi.com）：

* ``ApplyCertificate``      申请免费 DV 证书（PackageType=83，有效期 3 个月）
* ``DescribeCertificates``  查询证书列表 / 单个证书状态与到期时间
* ``DownloadCertificate``   下载证书，返回 base64 编码的 ZIP

注意：腾讯云免费证书仅支持**单域名**（不支持泛域名 / IP），有效期 90 天，
额度 50 张，因此自动续期是这个功能的核心价值。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import time
import zipfile
from typing import Any, Dict, List, Optional

import httpx

HOST = "ssl.tencentcloudapi.com"
SERVICE = "ssl"
VERSION = "2019-12-05"

# 免费证书（TrustAsia C1 DV Free）目前唯一支持的套餐类型
FREE_PACKAGE_TYPE = "83"

CERT_MARK = "-----BEGIN CERTIFICATE-----"
KEY_MARK = "PRIVATE KEY"

# DescribeCertificates 的证书状态码
STATUS_TEXT = {
    0: "审核中",
    1: "已签发",
    2: "审核失败",
    3: "已过期",
    4: "等待 DNS 验证",
    5: "待提交资料",
    6: "订单取消中",
    7: "已取消",
    8: "待上传确认函",
    9: "吊销中",
    10: "已吊销",
    11: "重颁发中",
    12: "待上传吊销确认函",
    13: "免费证书待提交资料",
    14: "已退款",
    15: "证书迁移中",
}

# 已签发（可下载部署）
STATUS_ISSUED = 1
# 申请中（等待 CA 签发，需要继续轮询）
STATUS_PENDING = (0, 4)
# 终态失败
STATUS_FAILED = (2, 3, 7, 10, 13, 14)


class TencentCloudError(Exception):
    """腾讯云接口返回的错误。"""

    def __init__(self, message: str, code: str = "", request_id: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.request_id = request_id

    def __str__(self) -> str:  # pragma: no cover - 仅用于日志展示
        text = self.message
        if self.code:
            text = "[" + self.code + "] " + text
        if self.request_id:
            text += "（RequestId: " + self.request_id + "）"
        return text


# --------------------------------------------------------------------- 签名
def _hmac_sha256(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def build_headers(
    secret_id: str, secret_key: str, action: str, payload: str, timestamp: Optional[int] = None
) -> Dict[str, str]:
    """按 TC3-HMAC-SHA256 生成请求头。"""
    ts = int(timestamp if timestamp is not None else time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(ts))
    content_type = "application/json; charset=utf-8"

    canonical_headers = "content-type:" + content_type + "\nhost:" + HOST + "\n"
    signed_headers = "content-type;host"
    hashed_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    canonical_request = "\n".join(
        ["POST", "/", "", canonical_headers, signed_headers, hashed_payload]
    )

    scope = date + "/" + SERVICE + "/tc3_request"
    string_to_sign = "\n".join(
        [
            "TC3-HMAC-SHA256",
            str(ts),
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    secret_date = _hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac_sha256(secret_date, SERVICE)
    secret_signing = _hmac_sha256(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return {
        "Authorization": (
            "TC3-HMAC-SHA256 Credential="
            + secret_id
            + "/"
            + scope
            + ", SignedHeaders="
            + signed_headers
            + ", Signature="
            + signature
        ),
        "Content-Type": content_type,
        "Host": HOST,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(ts),
        "X-TC-Version": VERSION,
    }


# --------------------------------------------------------------- 证书包解析
def _cert_score(name: str) -> int:
    """给压缩包内的证书文件打分，分越高越可能是"完整证书链"。"""
    low = name.lower()
    score = 0
    if low.endswith((".crt", ".pem")):
        score += 2
    if "fullchain" in low:
        score += 6
    if "bundle" in low or "chain" in low:
        score += 5
    if "ca" in low or "intermediate" in low:
        score -= 3
    return score


def parse_certificate_bundle(data: bytes) -> Dict[str, Any]:
    """从腾讯云返回的 ZIP 里提取「证书链」与「私钥」文本。

    腾讯云的打包文件名并不固定（可能是 ``Nginx/1_域名_bundle.crt`` + ``2_域名.key``，
    也可能是 ``域名.crt/.key/.pem``），因此这里不依赖文件名，而是按文件内容识别：
    含 ``PRIVATE KEY`` 的是私钥，含 ``BEGIN CERTIFICATE`` 的是证书；再按打分
    挑选最完整的证书链，若只拿到叶子证书则把其余中间证书补在后面。

    返回 ``{"fullchain", "private_key", "chain_file", "key_file", "files"}``。
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            entries = {
                name: zf.read(name) for name in zf.namelist() if not name.endswith("/")
            }
    except zipfile.BadZipFile as exc:
        raise TencentCloudError("证书包不是有效的 ZIP 文件，无法解析") from exc

    certs: Dict[str, str] = {}
    keys: Dict[str, str] = {}
    for name, raw in entries.items():
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if KEY_MARK in text:
            keys[name] = text.strip() + "\n"
        elif CERT_MARK in text:
            certs[name] = text

    if not certs:
        raise TencentCloudError("证书包里没有找到 PEM 证书文件")
    if not keys:
        raise TencentCloudError("证书包里没有找到私钥文件")

    chain_file = max(certs, key=lambda n: (_cert_score(n), len(certs[n])))
    chain = certs[chain_file].strip() + "\n"
    if chain.count(CERT_MARK) == 1:
        # 只有叶子证书：把中间证书按打分顺序补上（排除自己）
        for name in sorted(certs, key=lambda n: (_cert_score(n), len(certs[n])), reverse=True):
            if name == chain_file:
                continue
            chain += certs[name].strip() + "\n"

    key_file = max(keys, key=lambda n: (n.lower().endswith(".key"), -len(n)))
    return {
        "fullchain": chain,
        "private_key": keys[key_file],
        "chain_file": chain_file,
        "key_file": key_file,
        "files": sorted(entries),
    }


# --------------------------------------------------------------------- 客户端
class TencentSslClient:
    """腾讯云 SSL 证书 API 客户端。"""

    def __init__(self, secret_id: str, secret_key: str, timeout: float = 20.0) -> None:
        self.secret_id = (secret_id or "").strip()
        self.secret_key = (secret_key or "").strip()
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.secret_id and self.secret_key)

    async def call(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.configured:
            raise TencentCloudError("未配置腾讯云 API 密钥（SecretId / SecretKey）")
        payload = json.dumps(params, ensure_ascii=False)
        headers = build_headers(self.secret_id, self.secret_key, action, payload)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    "https://" + HOST, content=payload.encode("utf-8"), headers=headers
                )
        except httpx.HTTPError as exc:
            raise TencentCloudError("请求腾讯云接口失败：" + str(exc)) from exc

        try:
            body = resp.json().get("Response", {})
        except ValueError as exc:
            raise TencentCloudError(
                "腾讯云返回了无法解析的内容（HTTP " + str(resp.status_code) + "）"
            ) from exc

        error = body.get("Error")
        if error:
            raise TencentCloudError(
                str(error.get("Message") or "腾讯云接口调用失败"),
                code=str(error.get("Code") or ""),
                request_id=str(body.get("RequestId") or ""),
            )
        if not body:
            raise TencentCloudError("腾讯云返回空响应（HTTP " + str(resp.status_code) + "）")
        return body

    # ------------------------------------------------------------ 业务方法
    async def apply_free_certificate(
        self,
        domain: str,
        dv_auth_method: str = "DNS_AUTO",
        old_certificate_id: str = "",
        alias: str = "",
        encrypt_algo: str = "RSA",
    ) -> str:
        """申请免费 DV 证书，返回新的 CertificateId。"""
        params: Dict[str, Any] = {
            "DvAuthMethod": dv_auth_method or "DNS_AUTO",
            "DomainName": domain,
            "PackageType": FREE_PACKAGE_TYPE,
            "ValidityPeriod": "3",
            "CsrEncryptAlgo": "ECC" if encrypt_algo.upper() == "ECC" else "RSA",
        }
        if encrypt_algo.upper() == "ECC":
            params["CsrKeyParameter"] = "prime256v1"
        if old_certificate_id:
            params["OldCertificateId"] = old_certificate_id
        if alias:
            params["Alias"] = alias[:64]
        body = await self.call("ApplyCertificate", params)
        cert_id = str(body.get("CertificateId") or "")
        if not cert_id:
            raise TencentCloudError("腾讯云未返回证书 ID")
        return cert_id

    async def describe_certificates(
        self,
        *,
        cert_ids: Optional[List[str]] = None,
        search_key: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """查询证书列表，``cert_ids`` 可精确筛选。"""
        params: Dict[str, Any] = {"Limit": max(1, min(1000, limit)), "Offset": max(0, offset)}
        if cert_ids:
            params["CertIds"] = [c for c in cert_ids if c]
        if search_key:
            params["SearchKey"] = search_key
        return await self.call("DescribeCertificates", params)

    async def describe_certificate(self, cert_id: str) -> Optional[Dict[str, Any]]:
        """查询单个证书的详情（找不到返回 None）。"""
        body = await self.describe_certificates(cert_ids=[cert_id], limit=1)
        for item in body.get("Certificates") or []:
            if str(item.get("CertificateId")) == str(cert_id):
                return item
        items = body.get("Certificates") or []
        return items[0] if items else None

    async def download_certificate(self, cert_id: str) -> bytes:
        """下载证书，返回解压后的 ZIP 字节流。"""
        body = await self.call("DownloadCertificate", {"CertificateId": cert_id})
        content = str(body.get("Content") or "")
        if not content:
            raise TencentCloudError("腾讯云未返回证书内容，请确认证书已签发")
        try:
            return base64.b64decode(content)
        except (ValueError, TypeError) as exc:
            raise TencentCloudError("证书内容不是合法的 base64") from exc


def status_text(status: Any) -> str:
    try:
        return STATUS_TEXT.get(int(status), "状态 " + str(status))
    except (TypeError, ValueError):
        return "未知状态"
