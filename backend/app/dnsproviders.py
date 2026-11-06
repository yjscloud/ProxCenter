"""DNS 服务商适配层：给 ACME 的 DNS-01 挑战增删一条 TXT 记录。

只做一件事 —— ``create_txt(name, value) -> record_id`` 与
``delete_txt(name, record_id)``。四条实现都按各家签名规则手写，不引入 SDK：
项目里腾讯云 SSL 已经说明了这套取向，多拉四家 SDK 会让镜像大一圈。

* **DNSPod**（腾讯云）   TC3-HMAC-SHA256
* **阿里云 DNS**         RPC 风格，HMAC-SHA1
* **华为云 DNS**         SDK-HMAC-SHA256
* **Cloudflare**         Bearer Token，最省事的一家

``name`` 一律传完整记录名（``_acme-challenge.example.com``），内部自己找 zone；
泛域名的 ``*.`` 已在调用方剥掉，这里不处理通配符语义。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

import httpx

HTTP_TIMEOUT = 20.0

#: 记录 TTL。验证期间要尽快生效，所以取各家允许的最小值附近。
TXT_TTL = 60

PROVIDER_LABELS = {
    "dnspod": "DNSPod（腾讯云）",
    "aliyun": "阿里云 DNS",
    "huawei": "华为云 DNS",
    "cloudflare": "Cloudflare",
}

PROVIDERS = tuple(PROVIDER_LABELS)


class DnsError(Exception):
    """DNS 服务商接口返回的错误。"""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=HTTP_TIMEOUT)


def zone_candidates(name: str) -> List[str]:
    """从完整记录名逐级截断出可能的 zone，供「哪个才是托管域」的探测用。"""
    parts = [p for p in str(name or "").strip(".").split(".") if p]
    out: List[str] = []
    for index in range(len(parts) - 1):
        candidate = ".".join(parts[index:])
        if candidate.count(".") >= 1:
            out.append(candidate)
    return out


class DnsProvider:
    """接口约定。实现类只需保证两个方法，挑战流程不关心是哪家。"""

    name = ""

    async def create_txt(self, name: str, value: str) -> str:
        raise NotImplementedError

    async def delete_txt(self, name: str, record_id: str) -> None:
        raise NotImplementedError


# ------------------------------------------------------------------ DNSPod
def _tc3_headers(
    secret_id: str,
    secret_key: str,
    *,
    service: str,
    host: str,
    action: str,
    version: str,
    payload: str,
) -> Dict[str, str]:
    """腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名（与 app/tencent_ssl.py 同一套）。"""
    timestamp = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(timestamp))
    content_type = "application/json; charset=utf-8"

    canonical_headers = f"content-type:{content_type}\nhost:{host}\nx-tc-action:{action.lower()}\n"
    signed_headers = "content-type;host;x-tc-action"
    hashed_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    canonical_request = "\n".join(
        ["POST", "/", "", canonical_headers, signed_headers, hashed_payload]
    )

    scope = f"{date}/{service}/tc3_request"
    string_to_sign = "\n".join(
        [
            "TC3-HMAC-SHA256",
            str(timestamp),
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    def _sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _sign(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _sign(secret_date, service)
    secret_signing = _sign(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return {
        "Authorization": (
            f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
        "Content-Type": content_type,
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(timestamp),
        "X-TC-Version": version,
    }


class DnspodProvider(DnsProvider):
    name = "dnspod"

    HOST = "dnspod.tencentcloudapi.com"
    VERSION = "2021-03-23"

    def __init__(self, secret_id: str, secret_key: str) -> None:
        if not secret_id or not secret_key:
            raise DnsError("DNSPod 需要 SecretId 与 SecretKey")
        self.secret_id = secret_id
        self.secret_key = secret_key

    async def _call(self, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"))
        headers = _tc3_headers(
            self.secret_id,
            self.secret_key,
            service="dnspod",
            host=self.HOST,
            action=action,
            version=self.VERSION,
            payload=body,
        )
        async with _client() as client:
            resp = await client.post("https://" + self.HOST, content=body, headers=headers)
        try:
            data = resp.json().get("Response") or {}
        except ValueError as exc:
            raise DnsError("DNSPod 返回的不是 JSON") from exc
        error = data.get("Error")
        if error:
            raise DnsError(f"DNSPod {action} 失败：{error.get('Message') or error.get('Code')}")
        return data

    async def _find_zone(self, name: str) -> str:
        last: Optional[Exception] = None
        for candidate in zone_candidates(name):
            try:
                data = await self._call("DescribeRecordList", {"Domain": candidate, "Limit": 1})
                if data.get("Domain"):
                    return str(data["Domain"])
                return candidate
            except DnsError as exc:
                last = exc
                continue
        raise DnsError(f"找不到 {name} 对应的 DNSPod 域名") from last

    async def create_txt(self, name: str, value: str) -> str:
        zone = await self._find_zone(name)
        sub = name[: -(len(zone) + 1)] if name.endswith("." + zone) else name
        data = await self._call(
            "CreateRecord",
            {
                "Domain": zone,
                "SubDomain": sub,
                "RecordType": "TXT",
                "RecordLine": "默认",
                "Value": value,
                "TTL": TXT_TTL,
            },
        )
        return str((data.get("RecordInfo") or {}).get("Id") or "")

    async def delete_txt(self, name: str, record_id: str) -> None:
        if not record_id:
            return
        zone = await self._find_zone(name)
        sub = name[: -(len(zone) + 1)] if name.endswith("." + zone) else name
        await self._call(
            "DeleteRecord", {"Domain": zone, "RecordId": int(record_id), "SubDomain": sub}
        )


# ------------------------------------------------------------------ 阿里云
def _aliyun_query(params: Dict[str, str], secret: str) -> str:
    """RPC 签名：按字典序拼 query，再 HMAC-SHA1(secret + "&")。"""
    encoded = "&".join(
        f"{quote(str(k), safe='')}={quote(str(v), safe='')}" for k, v in sorted(params.items())
    )
    string_to_sign = "GET&" + quote("/", safe="") + "&" + quote(encoded, safe="")
    digest = hmac.new(
        (secret + "&").encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1
    ).digest()
    return encoded + "&Signature=" + quote(base64.b64encode(digest).decode("ascii"), safe="")


class AliyunProvider(DnsProvider):
    name = "aliyun"

    HOST = "alidns.cn-hangzhou.aliyuncs.com"
    VERSION = "2015-01-09"

    def __init__(self, access_key_id: str, access_key_secret: str) -> None:
        if not access_key_id or not access_key_secret:
            raise DnsError("阿里云需要 AccessKey ID 与 Secret")
        self.key_id = access_key_id
        self.secret = access_key_secret

    async def _call(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        common = {
            "AccessKeyId": self.key_id,
            "Action": action,
            "Format": "JSON",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": secrets.token_hex(16),
            "SignatureVersion": "1.0",
            "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "Version": self.VERSION,
        }
        merged = {**common, **{k: str(v) for k, v in params.items()}}
        query = _aliyun_query(merged, self.secret)
        async with _client() as client:
            resp = await client.get("https://" + self.HOST + "/?" + query)
        try:
            data = resp.json()
        except ValueError as exc:
            raise DnsError("阿里云返回的不是 JSON") from exc
        if resp.status_code >= 400 or data.get("Code"):
            raise DnsError(f"阿里云 {action} 失败：{data.get('Message') or data.get('Code')}")
        return data

    async def _find_zone(self, name: str) -> str:
        last: Optional[Exception] = None
        for candidate in zone_candidates(name):
            try:
                await self._call("DescribeDomainRecords", {"DomainName": candidate, "PageSize": 1})
                return candidate
            except DnsError as exc:
                last = exc
                continue
        raise DnsError(f"找不到 {name} 对应的阿里云域名") from last

    async def create_txt(self, name: str, value: str) -> str:
        zone = await self._find_zone(name)
        sub = name[: -(len(zone) + 1)] if name.endswith("." + zone) else name
        data = await self._call(
            "AddDomainRecord",
            {
                "DomainName": zone,
                "RR": sub,
                "Type": "TXT",
                "Value": value,
                "TTL": TXT_TTL,
            },
        )
        return str(data.get("RecordId") or "")

    async def delete_txt(self, name: str, record_id: str) -> None:
        if not record_id:
            return
        await self._call("DeleteDomainRecord", {"RecordId": record_id})


# ------------------------------------------------------------------ 华为云
def _huawei_headers(
    key_id: str, secret: str, method: str, uri: str, query: str, body: str
) -> Dict[str, str]:
    """SDK-HMAC-SHA256：签名串是「方法 / 路径 / 查询 / 头 / 头名 / 载荷哈希」。"""
    now = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    host = "dns.myhuaweicloud.com"
    content_type = "application/json;charset=utf8"
    canonical_headers = f"content-type:{content_type}\nhost:{host}\nx-sdk-date:{now}\n"
    signed_headers = "content-type;host;x-sdk-date"
    canonical_request = "\n".join(
        [
            method,
            uri if uri.endswith("/") else uri + "/",
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


class HuaweiProvider(DnsProvider):
    name = "huawei"

    HOST = "dns.myhuaweicloud.com"

    def __init__(self, access_key_id: str, access_key_secret: str) -> None:
        if not access_key_id or not access_key_secret:
            raise DnsError("华为云需要 AK 与 SK")
        self.key_id = access_key_id
        self.secret = access_key_secret

    async def _call(
        self, method: str, path: str, query: str = "", payload: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":")) if payload else ""
        headers = _huawei_headers(self.key_id, self.secret, method, path, query, body)
        url = "https://" + self.HOST + path + (("?" + query) if query else "")
        async with _client() as client:
            resp = await client.request(method, url, content=body, headers=headers)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if resp.status_code >= 400:
            raise DnsError(
                f"华为云 {path} 失败：{data.get('message') or data.get('error_msg') or resp.status_code}"
            )
        return data

    async def _find_zone(self, name: str) -> Dict[str, str]:
        last: Optional[Exception] = None
        for candidate in zone_candidates(name):
            try:
                data = await self._call(
                    "GET", "/v2/zones", urlencode({"name": candidate + "."})
                )
                zones = data.get("zones") or []
                if zones:
                    zone = zones[0]
                    return {"id": str(zone.get("id") or ""), "name": str(zone.get("name") or "")}
            except DnsError as exc:
                last = exc
                continue
        raise DnsError(f"找不到 {name} 对应的华为云域名") from last

    async def create_txt(self, name: str, value: str) -> str:
        zone = await self._find_zone(name)
        zone_name = zone["name"].rstrip(".")
        sub = name[: -(len(zone_name) + 1)] if name.endswith("." + zone_name) else name
        data = await self._call(
            "POST",
            f"/v2/zones/{zone['id']}/recordsets",
            payload={
                "name": sub + "." + zone_name + ".",
                "type": "TXT",
                "ttl": TXT_TTL,
                "records": [f'"{value}"'],
            },
        )
        return str(data.get("id") or "")

    async def delete_txt(self, name: str, record_id: str) -> None:
        if not record_id:
            return
        zone = await self._find_zone(name)
        await self._call("DELETE", f"/v2/zones/{zone['id']}/recordsets/{record_id}")


# ------------------------------------------------------------------ Cloudflare
class CloudflareProvider(DnsProvider):
    name = "cloudflare"

    API = "https://api.cloudflare.com/client/v4"

    def __init__(self, api_token: str) -> None:
        if not api_token:
            raise DnsError("Cloudflare 需要 API Token")
        self.token = api_token

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}

    async def _call(
        self, method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        async with _client() as client:
            resp = await client.request(
                method, self.API + path, json=payload, headers=self._headers()
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise DnsError("Cloudflare 返回的不是 JSON") from exc
        if not data.get("success"):
            errors = data.get("errors") or []
            raise DnsError(
                "Cloudflare 请求失败："
                + "; ".join(str(e.get("message") or e) for e in errors)[:300]
            )
        return data

    async def _find_zone(self, name: str) -> Dict[str, str]:
        last: Optional[Exception] = None
        for candidate in zone_candidates(name):
            try:
                data = await self._call("GET", "/zones?" + urlencode({"name": candidate}))
                zones = data.get("result") or []
                if zones:
                    return {"id": str(zones[0].get("id") or ""), "name": str(zones[0].get("name") or "")}
            except DnsError as exc:
                last = exc
                continue
        raise DnsError(f"找不到 {name} 对应的 Cloudflare 域名") from last

    async def create_txt(self, name: str, value: str) -> str:
        zone = await self._find_zone(name)
        data = await self._call(
            "POST",
            f"/zones/{zone['id']}/dns_records",
            {"type": "TXT", "name": name, "content": value, "ttl": TXT_TTL},
        )
        return str((data.get("result") or {}).get("id") or "")

    async def delete_txt(self, name: str, record_id: str) -> None:
        if not record_id:
            return
        zone = await self._find_zone(name)
        await self._call("DELETE", f"/zones/{zone['id']}/dns_records/{record_id}")


# ------------------------------------------------------------------ 工厂
def build_provider(kind: str, cfg: Dict[str, Any]) -> DnsProvider:
    """按配置造一个 provider；``cfg`` 里的键就用各家界面上的字段名。"""
    kind = str(kind or "").strip().lower()
    data = cfg or {}
    if kind == "dnspod":
        return DnspodProvider(
            str(data.get("secret_id") or ""), str(data.get("secret_key") or "")
        )
    if kind == "aliyun":
        return AliyunProvider(
            str(data.get("access_key_id") or ""), str(data.get("access_key_secret") or "")
        )
    if kind == "huawei":
        return HuaweiProvider(
            str(data.get("access_key_id") or ""), str(data.get("access_key_secret") or "")
        )
    if kind == "cloudflare":
        return CloudflareProvider(str(data.get("api_token") or ""))
    raise DnsError("不支持的 DNS 服务商：" + (kind or "（未选择）"))
