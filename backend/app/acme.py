"""ACME v2 客户端（RFC 8555）：自己申请的证书，不再只能靠腾讯云免费额度。

为什么手写而不是拉 certbot：项目对依赖的取向是「标准库 + 已有依赖能解决就不加
SDK」（腾讯云 SSL 也是按 TC3 规则自己签的）。ACME 本身只是 JWS + 几个 JSON
接口，自己实现可以精确控制「加 DNS 记录 → 等生效 → 清理」的时序，也不必为了
一家 CA 拖进一整棵依赖树。

支持：

* 任何 ACME v2 目录（Let's Encrypt 生产 / 临时、ZeroSSL……）；
* RSA 账号密钥（RS256）、RSA 2048 或 ECC P-256 的证书密钥；
* ``http-01``（写 webroot 文件）与 ``dns-01``（钩子交给 :mod:`dnsproviders`）；
* 泛域名 ``*.example.com`` —— 只能走 DNS-01，这是 ACME 的硬约束。

刻意与业务解耦：本模块不 import ``certs``，也不碰数据库，只认参数与回调。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import NameOID

# 常见目录，界面直接给下拉，也允许自己填
DIRECTORY_LETSENCRYPT = "https://acme-v02.api.letsencrypt.org/directory"
DIRECTORY_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"
DIRECTORY_ZEROSSL = "https://acme.zerossl.com/v2/DV90"

DIRECTORIES = (
    ("letsencrypt", DIRECTORY_LETSENCRYPT),
    ("letsencrypt_staging", DIRECTORY_STAGING),
    ("zerossl", DIRECTORY_ZEROSSL),
)

#: 轮询授权 / 订单状态的节奏与上限。DNS 生效慢，给到 5 分钟。
POLL_INTERVAL = 3.0
POLL_TIMEOUT = 300.0

HTTP_TIMEOUT = 30.0

KEY_RSA = "rsa2048"
KEY_ECC = "ecc256"

CERT_MARK = "-----BEGIN CERTIFICATE-----"


class AcmeError(Exception):
    """ACME 流程失败。``problem`` 是 CA 返回的 problem+json（可空）。"""

    def __init__(self, message: str, problem: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.problem = problem or {}

    def __str__(self) -> str:  # pragma: no cover - 日志/界面展示
        detail = str(self.problem.get("detail") or "")
        if detail and detail not in self.message:
            return self.message + "：" + detail
        return self.message


class Solver(Protocol):
    """挑战的执行者：把 token 放到 CA 能查到的位置（HTTP 文件 / DNS TXT）。"""

    kind: str

    async def present(self, domain: str, token: str, value: str) -> None: ...

    async def cleanup(self, domain: str, token: str, value: str) -> None: ...

    async def cleanup_all(self) -> None:
        """流程结束（成功或失败）时把临时记录/文件全部撤掉。"""
        ...


@dataclass
class IssuedCert:
    """签发结果。``private_key`` 是本次新生成的私钥（PEM）。"""

    fullchain: str
    private_key: str
    expire_at: int
    domains: List[str] = field(default_factory=list)


# ------------------------------------------------------------------ 小工具
def b64(raw: bytes) -> str:
    """base64url 无填充 —— JWS 与 ACME 的所有二进制字段都用这个编码。"""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _json_b64(payload: Any) -> str:
    return b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def normalise_domains(raw: List[str]) -> List[str]:
    """去重、转小写、保持「泛域名在前」的稳定顺序。"""
    seen: List[str] = []
    for item in raw:
        domain = str(item or "").strip().lower().rstrip(".")
        if domain and domain not in seen:
            seen.append(domain)
    seen.sort(key=lambda d: (not d.startswith("*."), d))
    return seen


def wildcard_of(domain: str) -> str:
    return domain[2:] if domain.startswith("*.") else domain


def new_private_key(kind: str) -> Any:
    if str(kind or "").lower() in (KEY_ECC, "ecc", "ecdsa"):
        return ec.generate_private_key(ec.SECP256R1())
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _private_key_pem(key: Any) -> str:
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


def build_csr(domains: List[str], key: Any) -> bytes:
    """生成 DER 格式的 CSR；SAN 里放全部域名（含泛域名）。"""
    builder = x509.CertificateSigningRequestBuilder().subject_name(
        x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, wildcard_of(domains[0])[:64])])
    )
    builder = builder.add_extension(
        x509.SubjectAlternativeName([x509.DNSName(d) for d in domains]), critical=False
    )
    return builder.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


def cert_expire_at(fullchain: str) -> int:
    """从 PEM 链里取叶子证书的到期时间（Unix 秒），解析失败返回 0。"""
    try:
        cert = x509.load_pem_x509_certificate(fullchain.encode("utf-8"))
        expire = getattr(cert, "not_valid_after_utc", None)
        if expire is not None:
            return int(expire.timestamp())
        return int(cert.not_valid_after.timestamp())
    except Exception:  # noqa: BLE001 - 到期时间只是展示字段，解析失败不该阻断签发
        return 0


def split_chain(pem: str) -> List[str]:
    """把「叶子 + 中间证书」的 PEM 拆成单张，用于补全缺失的链。"""
    blocks: List[str] = []
    current: List[str] = []
    for line in pem.splitlines():
        if line.startswith(CERT_MARK):
            current = [line]
        elif current:
            current.append(line)
            if line.strip() == "-----END CERTIFICATE-----":
                blocks.append("\n".join(current) + "\n")
                current = []
    return blocks


# ------------------------------------------------------------------ 账号密钥
class AccountKey:
    """ACME 账号密钥。它只用于给请求签名，与站点证书私钥无关。"""

    def __init__(self, key: Any) -> None:
        self.key = key

    @classmethod
    def load(cls, pem: str) -> "AccountKey":
        if not str(pem or "").strip():
            return cls(rsa.generate_private_key(public_exponent=65537, key_size=2048))
        try:
            return cls(serialization.load_pem_private_key(pem.encode("utf-8"), password=None))
        except Exception as exc:  # noqa: BLE001 - 坏密钥给出可读错误
            raise AcmeError("ACME 账号密钥无法解析，请重新生成") from exc

    @property
    def pem(self) -> str:
        return _private_key_pem(self.key)

    @property
    def alg(self) -> str:
        return "RS256" if isinstance(self.key, rsa.RSAPrivateKey) else "ES256"

    def jwk(self) -> Dict[str, str]:
        public = self.key.public_key().public_numbers()
        if isinstance(self.key, rsa.RSAPrivateKey):
            return {
                "e": b64(public.e.to_bytes((public.e.bit_length() + 7) // 8, "big")),
                "kty": "RSA",
                "n": b64(public.n.to_bytes((public.n.bit_length() + 7) // 8, "big")),
            }
        size = 32
        return {
            "crv": "P-256",
            "kty": "EC",
            "x": b64(public.x.to_bytes(size, "big")),
            "y": b64(public.y.to_bytes(size, "big")),
        }

    @property
    def thumbprint(self) -> str:
        """RFC 7638 规定的 JWK 指纹 —— DNS-01 的 TXT 值要用它。"""
        return b64(hashlib.sha256(_canonical(self.jwk()).encode("utf-8")).digest())

    def sign(self, data: bytes) -> str:
        if isinstance(self.key, rsa.RSAPrivateKey):
            signature = self.key.sign(data, padding.PKCS1v15(), hashes.SHA256())
        else:
            der = self.key.sign(data, ec.ECDSA(hashes.SHA256()))
            # JWS 的 ES256 要求 r||s 定长拼接，而 cryptography 给的是 DER
            r, s = _decode_dss_signature(der)
            signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return b64(signature)


def _canonical(jwk: Dict[str, str]) -> str:
    """RFC 7638：按字典序拼 ``{"crv":...}`` 这类最小字段集，不能有空格。"""
    if jwk.get("kty") == "RSA":
        ordered = {"e": jwk["e"], "kty": "RSA", "n": jwk["n"]}
    else:
        ordered = {"crv": jwk["crv"], "kty": "EC", "x": jwk["x"], "y": jwk["y"]}
    return json.dumps(ordered, separators=(",", ":"), sort_keys=True)


def _decode_dss_signature(der: bytes) -> tuple:
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    return decode_dss_signature(der)


# ------------------------------------------------------------------ 客户端
class AcmeClient:
    """一次签发流程用一个实例；``directory_url`` 决定打哪家 CA。"""

    def __init__(
        self,
        directory_url: str = DIRECTORY_LETSENCRYPT,
        *,
        email: str = "",
        account_key_pem: str = "",
        timeout: float = HTTP_TIMEOUT,
    ) -> None:
        self.directory_url = str(directory_url or DIRECTORY_LETSENCRYPT)
        self.email = str(email or "").strip()
        self.account_key = AccountKey.load(account_key_pem)
        self.timeout = timeout
        self._directory: Dict[str, Any] = {}
        self._kid = ""
        self._nonce = ""
        self._client: Optional[httpx.AsyncClient] = None

    # -- 生命周期
    async def __aenter__(self) -> "AcmeClient":
        self._client = httpx.AsyncClient(
            timeout=self.timeout, headers={"User-Agent": "pvecenter-acme/1.0"}
        )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._client is None:
            raise AcmeError("ACME 客户端尚未初始化")
        return self._client

    # -- 协议层
    async def directory(self) -> Dict[str, Any]:
        if not self._directory:
            resp = await self.http.get(self.directory_url)
            if resp.status_code != 200:
                raise AcmeError(f"读取 ACME 目录失败（HTTP {resp.status_code}）")
            self._directory = resp.json()
        return self._directory

    async def _take_nonce(self) -> str:
        """优先用上一次响应里带的 Replay-Nonce，没有再 HEAD newNonce。"""
        if self._nonce:
            nonce, self._nonce = self._nonce, ""
            return nonce
        url = str((await self.directory()).get("newNonce") or "")
        if not url:
            raise AcmeError("ACME 目录里没有 newNonce 地址")
        resp = await self.http.head(url)
        nonce = resp.headers.get("Replay-Nonce", "")
        if not nonce:
            resp = await self.http.get(url)
            nonce = resp.headers.get("Replay-Nonce", "")
        if not nonce:
            raise AcmeError("CA 没有返回 nonce")
        return nonce

    async def _post(
        self, url: str, payload: Any, *, use_jwk: bool = False
    ) -> httpx.Response:
        """签名并发送一个 ACME 请求；badNonce 自动换 nonce 重试一次。"""
        for attempt in range(2):
            nonce = await self._take_nonce()
            protected: Dict[str, Any] = {
                "alg": self.account_key.alg,
                "nonce": nonce,
                "url": url,
            }
            if use_jwk or not self._kid:
                protected["jwk"] = self.account_key.jwk()
            else:
                protected["kid"] = self._kid
            body = b64(json.dumps(protected, separators=(",", ":")).encode("utf-8"))
            if payload == "":
                # POST-as-GET：payload 必须是空字符串，不是 "{}"
                payload_b64 = ""
            else:
                payload_b64 = _json_b64(payload)
            signing_input = (body + "." + payload_b64).encode("ascii")
            data = json.dumps(
                {
                    "protected": body,
                    "payload": payload_b64,
                    "signature": self.account_key.sign(signing_input),
                }
            )
            resp = await self.http.post(
                url,
                content=data,
                headers={"Content-Type": "application/jose+json"},
            )
            fresh = resp.headers.get("Replay-Nonce", "")
            if fresh:
                self._nonce = fresh
            if resp.status_code < 400:
                return resp
            problem = _problem(resp)
            if (
                attempt == 0
                and resp.status_code == 400
                and "badNonce" in str(problem.get("type") or "")
            ):
                continue
            raise AcmeError(f"ACME 请求失败（HTTP {resp.status_code}）", problem)
        raise AcmeError("ACME 请求失败：nonce 重试后仍未成功")

    async def ensure_account(self) -> str:
        """注册（或复用）账号，返回 kid。"""
        if self._kid:
            return self._kid
        payload: Dict[str, Any] = {"termsOfServiceAgreed": True}
        if self.email:
            payload["contact"] = ["mailto:" + self.email]
        resp = await self._post(str((await self.directory())["newAccount"]), payload, use_jwk=True)
        self._kid = str(resp.headers.get("Location") or "")
        if not self._kid:
            raise AcmeError("CA 没有返回账号地址（Location）")
        return self._kid

    async def get_json(self, url: str) -> Dict[str, Any]:
        resp = await self._post(url, "")
        try:
            return resp.json()
        except ValueError as exc:
            raise AcmeError("CA 返回的不是 JSON") from exc

    async def new_order(self, domains: List[str]) -> Dict[str, Any]:
        await self.ensure_account()
        payload = {"identifiers": [{"type": "dns", "value": d} for d in domains]}
        resp = await self._post(str((await self.directory())["newOrder"]), payload)
        order = resp.json()
        order["_url"] = str(resp.headers.get("Location") or "")
        return order

    async def respond_challenge(self, url: str) -> None:
        await self._post(url, {})

    async def finalize(self, order: Dict[str, Any], csr_der: bytes) -> Dict[str, Any]:
        url = str(order.get("finalize") or "")
        if not url:
            raise AcmeError("订单里没有 finalize 地址")
        resp = await self._post(url, {"csr": b64(csr_der)})
        return resp.json()

    async def download(self, url: str) -> str:
        resp = await self._post(url, "")
        text = resp.text.strip()
        if CERT_MARK not in text:
            raise AcmeError("CA 返回的证书不是 PEM 格式")
        return text + "\n"

    async def revoke(self, cert_pem: str, reason: int = 0) -> None:
        url = str((await self.directory()).get("revokeCert") or "")
        if not url:
            raise AcmeError("ACME 目录里没有 revokeCert 地址")
        der = x509.load_pem_x509_certificate(cert_pem.encode("utf-8")).public_bytes(
            serialization.Encoding.DER
        )
        await self._post(url, {"certificate": b64(der), "reason": int(reason)})

    # -- 业务层
    async def issue(
        self,
        domains: List[str],
        solver: Solver,
        *,
        key_type: str = KEY_RSA,
        poll_timeout: float = POLL_TIMEOUT,
    ) -> IssuedCert:
        """跑完整条流程：下单 → 过挑战 → finalize → 下载。"""
        domains = normalise_domains(domains)
        if not domains:
            raise AcmeError("没有要签发的域名")
        if solver.kind == "http-01" and any(d.startswith("*.") for d in domains):
            raise AcmeError("泛域名只能用 DNS-01 验证")

        order = await self.new_order(domains)
        try:
            await self._authorize(order, solver, poll_timeout)
            cert_key = new_private_key(key_type)
            order = await self.finalize(order, build_csr(domains, cert_key))
            order = await self._wait_order(order, poll_timeout)
            fullchain = await self.download(str(order.get("certificate") or ""))
        finally:
            # 成功要清理（删 DNS TXT / webroot 文件），失败更要清理
            cleanup = getattr(solver, "cleanup_all", None)
            if cleanup is not None:
                await cleanup()

        return IssuedCert(
            fullchain=fullchain,
            private_key=_private_key_pem(cert_key),
            expire_at=cert_expire_at(fullchain),
            domains=domains,
        )

    async def _authorize(
        self, order: Dict[str, Any], solver: Solver, poll_timeout: float
    ) -> None:
        deadline = time.monotonic() + poll_timeout
        pending: List[Dict[str, Any]] = []
        for authz_url in order.get("authorizations") or []:
            authz = await self.get_json(str(authz_url))
            if authz.get("status") == "valid":
                continue
            challenge = _pick_challenge(authz, solver.kind)
            if challenge is None:
                raise AcmeError(
                    "CA 没有提供 " + solver.kind + " 挑战（该域名可能只支持另一种验证方式）"
                )
            domain = str((authz.get("identifier") or {}).get("value") or "")
            key_auth = str(challenge.get("token") or "") + "." + self.account_key.thumbprint
            if solver.kind == "dns-01":
                value = b64(hashlib.sha256(key_auth.encode("utf-8")).digest())
            else:
                value = key_auth
            await solver.present(domain, str(challenge.get("token") or ""), value)
            await self.respond_challenge(str(challenge.get("url") or ""))
            pending.append({"url": str(authz_url), "domain": domain})

        for item in pending:
            await self._wait_authorization(item["url"], item["domain"], deadline)

    async def _wait_authorization(self, url: str, domain: str, deadline: float) -> None:
        while True:
            authz = await self.get_json(url)
            status = str(authz.get("status") or "")
            if status == "valid":
                return
            if status == "invalid":
                raise AcmeError(
                    domain + " 的验证未通过", _challenge_error(authz)
                )
            if time.monotonic() > deadline:
                raise AcmeError(domain + " 的验证超时（CA 一直没有确认）")
            await asyncio.sleep(POLL_INTERVAL)

    async def _wait_order(self, order: Dict[str, Any], poll_timeout: float) -> Dict[str, Any]:
        url = str(order.get("_url") or "")
        deadline = time.monotonic() + poll_timeout
        while True:
            status = str(order.get("status") or "")
            if status == "valid":
                return order
            if status == "invalid":
                raise AcmeError("证书签发失败", _order_error(order))
            if not url:
                return order
            if time.monotonic() > deadline:
                raise AcmeError("证书签发超时（CA 一直没有完成 finalize）")
            await asyncio.sleep(POLL_INTERVAL)
            order = await self.get_json(url)
            order["_url"] = url


# ------------------------------------------------------------------ 挑战辅助
def _pick_challenge(authz: Dict[str, Any], kind: str) -> Optional[Dict[str, Any]]:
    for challenge in authz.get("challenges") or []:
        if str(challenge.get("type") or "") == kind:
            return challenge
    return None


def _challenge_error(authz: Dict[str, Any]) -> Dict[str, Any]:
    for challenge in authz.get("challenges") or []:
        error = challenge.get("error")
        if isinstance(error, dict):
            return error
    return {}


def _order_error(order: Dict[str, Any]) -> Dict[str, Any]:
    error = order.get("error")
    return error if isinstance(error, dict) else {}


def _problem(resp: httpx.Response) -> Dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return {"detail": resp.text[:300]}
    return body if isinstance(body, dict) else {"detail": str(body)[:300]}


class Http01Solver:
    """把 token 写成 ``<webroot>/.well-known/acme-challenge/<token>``。

    要求 80 端口的站点根目录指向这个 webroot；面板不能替用户改 web 服务器配置，
    所以路径必须由用户填对（这也是 certbot ``--webroot`` 的用法）。
    """

    kind = "http-01"

    def __init__(self, webroot: str) -> None:
        self.webroot = str(webroot or "").strip()
        self._written: List[str] = []

    async def present(self, domain: str, token: str, value: str) -> None:
        if not self.webroot:
            raise AcmeError("HTTP-01 需要填写站点根目录（webroot）")
        await asyncio.to_thread(self._write, token, value)

    def _write(self, token: str, value: str) -> None:
        from pathlib import Path

        directory = Path(self.webroot) / ".well-known" / "acme-challenge"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / token
        target.write_text(value, encoding="utf-8")
        try:
            target.chmod(0o644)
        except OSError:
            pass
        self._written.append(str(target))

    async def cleanup(self, domain: str, token: str, value: str) -> None:
        return

    async def cleanup_all(self) -> None:
        from pathlib import Path

        for path in self._written:
            try:
                Path(path).unlink()
            except OSError:
                pass
        self._written.clear()


class Dns01Solver:
    """通过 :mod:`dnsproviders` 增删 ``_acme-challenge`` TXT 记录。

    ``provider`` 只需实现 ``create_txt`` / ``delete_txt``；等待生效的时间交给
    调用方（``wait`` 秒），因为不同 DNS 服务商的生效速度差很多。
    """

    kind = "dns-01"

    def __init__(self, provider: Any, wait: float = 0.0) -> None:
        self.provider = provider
        self.wait = float(wait or 0)
        self._records: List[tuple] = []

    async def present(self, domain: str, token: str, value: str) -> None:
        name = "_acme-challenge." + wildcard_of(domain)
        record_id = await self.provider.create_txt(name, value)
        self._records.append((name, record_id))
        if self.wait:
            await asyncio.sleep(self.wait)

    async def cleanup(self, domain: str, token: str, value: str) -> None:
        return

    async def cleanup_all(self) -> None:
        for name, record_id in self._records:
            try:
                await self.provider.delete_txt(name, record_id)
            except Exception:  # noqa: BLE001 - 清理失败不该掩盖签发结果
                pass
        self._records.clear()
