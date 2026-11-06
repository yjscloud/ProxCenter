"""证书签发厂商的统一抽象。

这一层只回答一个问题：**怎么把某家 CA 的接口翻译成统一语义**。它不做持久化、
不管按用户隔离密钥、也不知道「站点」是什么 —— 那些属于 ``certs`` 模块。

各家接口的差异集中在三处，都在这里被抹平：

* **申请**：腾讯云同步返回 CertificateId，阿里云返回 CertificateId，华为云返回
  certificate_id；参数名、单/多域名、验证方式各不相同。
* **状态**：腾讯云是整数码、阿里云是字符串状态、华为云又是另一套大写枚举。
  统一收敛成本模块的整数状态（沿用腾讯云口径，历史数据与前端都按这套值渲染）。
* **取证书**：腾讯云给 base64 的 ZIP，阿里云在状态接口里直接给 PEM，华为云要单独
  export。统一返回与 ``tencent_ssl.parse_certificate_bundle`` 同构的 bundle。

新增一家厂商 = 写一个 :class:`CertProvider` 子类 + 在 ``certproviders/__init__.py``
登记 + 补字段 schema，其余（申请、部署、续期、退避、告警、审计）都不用动。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..certstatus import status_text as _canonical_status_text

# ---------------------------------------------------------------- 统一状态码
#: 审核中 / 等待验证
STATUS_PENDING = 0
#: 已签发，可以下载部署
STATUS_ISSUED = 1
#: 审核失败
STATUS_FAILED = 2
#: 已过期
STATUS_EXPIRED = 3
#: 等待 DNS 验证
STATUS_DNS_WAIT = 4
#: 已吊销
STATUS_REVOKED = 10

#: 还需要继续轮询的状态
PENDING_STATUSES = (STATUS_PENDING, STATUS_DNS_WAIT)
#: 终态失败：不会再自动变好，只能重新申请
FAILED_STATUSES = (STATUS_FAILED, STATUS_EXPIRED, STATUS_REVOKED)


def status_text(status: Any) -> str:
    """统一状态码 → 中文短句（出口处再按请求语言翻译）。"""
    return _canonical_status_text(status)


def normalise_status(raw: Any, mapping: Dict[str, int], default: int = STATUS_PENDING) -> int:
    """把厂商自己的状态字符串按映射表收敛；不认识的当作「审核中」。

    厂商偶尔会加新状态（例如新增一种「等待人工审核」），默认落到 PENDING 比
    直接报失败安全：流水线只会继续等，不会误判为失败而反复重试申请。
    """
    key = str(raw or "").strip().lower()
    return mapping.get(key, default)


class ProviderError(Exception):
    """厂商接口错误。

    上层 ``certs`` 会把它包成 ``CertError``（400），路由层不需要认识每家厂商的
    异常类型；``code`` / ``request_id`` 用于日志与排障。
    """

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


# ---------------------------------------------------------------- 统一数据类
@dataclass
class CertInfo:
    """一张远端证书的快照（查询状态 / 列表 / 绑定都用它）。"""

    cert_id: str
    domains: List[str] = field(default_factory=list)
    status: int = STATUS_PENDING
    expire_at: int = 0
    alias: str = ""
    encrypt_algo: str = ""
    wildcard: bool = False
    #: 厂商原始响应，排障时按需取用，不要在上面做业务判断
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def status_text(self) -> str:
        return status_text(self.status)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "cert_id": self.cert_id,
            "domains": list(self.domains),
            "status": self.status,
            "status_text": self.status_text,
            "expire_at": self.expire_at,
            "alias": self.alias,
            "encrypt_algo": self.encrypt_algo,
            "wildcard": self.wildcard,
        }


@dataclass
class ApplyResult:
    """一次申请的结果。

    ``pem`` / ``key`` 只给「同步签发」的渠道用（ACME、上传）：拿到证书的同时
    就已经可以落库；云厂商渠道走异步审核，这两个字段留空，由部署步骤去下载。
    """

    cert_id: str
    status: int = STATUS_PENDING
    expire_at: int = 0
    domains: List[str] = field(default_factory=list)
    detail: str = ""
    pem: str = ""
    key: str = ""


# ---------------------------------------------------------------- 厂商基类
class CertProvider:
    """证书签发厂商的统一接口。

    约定：所有方法都只做「翻译 + HTTP」，不写数据库、不读 settings、不做权限判断。
    配置字典由上层传入（已解密），字段含义见 ``certproviders.FIELD_SCHEMA``。
    """

    #: 存进 ``site['ca']`` 的值，也是配置的存储后缀
    kind: str = ""
    #: 展示名（中文原文，出口处翻译）
    label: str = ""
    #: 签发即拿证书，不需要再轮询/下载
    synchronous: bool = False
    #: 是否支持泛域名 / 多域名（免费 DV 普遍不支持；改成类属性，
    #: 注册表在**类**上判断，不必实例化）
    supports_wildcard: bool = False
    supports_multi_domain: bool = False

    def __init__(self, cfg: Optional[Dict[str, Any]] = None) -> None:
        self.cfg: Dict[str, Any] = dict(cfg or {})

    # -------------------------------------------------------------- 能力声明
    @property
    def configured(self) -> bool:
        """凭据是否齐全；缺凭据时上层给出「请先配置 XX」而不是发请求。"""
        raise NotImplementedError

    async def apply(
        self,
        domains: List[str],
        *,
        renew_from: str = "",
        alias: str = "",
    ) -> ApplyResult:
        """提交申请（或续期）。``renew_from`` 是旧证书 ID，厂商支持「以旧换新」时用。"""
        raise NotImplementedError

    async def describe(self, cert_id: str) -> Optional[CertInfo]:
        """查询单张证书；不存在或不属于当前账号时返回 ``None``。"""
        raise NotImplementedError

    async def download(self, cert_id: str) -> Dict[str, Any]:
        """取回可部署的证书，返回与 ``parse_certificate_bundle`` 同构的 bundle。"""
        raise NotImplementedError

    async def remove(self, cert_id: str) -> None:
        """删除（或吊销）一张证书；厂商不支持时上层只是少一步清理。"""
        raise NotImplementedError

    async def list_certs(self, search: str = "", limit: int = 100) -> List[CertInfo]:
        raise NotImplementedError

    async def test(self) -> Dict[str, Any]:
        """连通性自检，返回 ``{"total": n, "detail": "..."}``。"""
        raise NotImplementedError

    # -------------------------------------------------------------- 小工具
    def _pick(self, *keys: str, default: str = "") -> str:
        for key in keys:
            value = self.cfg.get(key)
            if value:
                return str(value)
        return default

    def _renew_days(self) -> int:
        try:
            value = int(self.cfg.get("renew_before_days") or 15)
        except (TypeError, ValueError):
            value = 15
        return max(1, min(60, value))


# ---------------------------------------------------------------- 时间解析
def parse_time(value: Any) -> int:
    """厂商返回的时间 → 秒级时间戳。

    各家格式不统一（``2026-01-01 00:00:00`` / ISO8601 / 纯时间戳），这里统一兜住；
    解析不了返回 0，由上层当作「到期时间未知」，不会因此误判为已过期。
    """
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        number = float(value)
        # 毫秒时间戳在华为云 / 阿里云的某些字段上会出现
        return int(number / 1000) if number > 10_000_000_000 else int(number)
    text = str(value).strip()
    if not text:
        return 0
    if text.isdigit():
        return parse_time(int(text))
    candidates = [
        text,
        text.replace("T", " ").replace("Z", ""),
        text.split(".")[0],
        text.split("+")[0].strip(),
    ]
    for candidate in candidates:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
            try:
                return int(time.mktime(time.strptime(candidate, fmt)))
            except (ValueError, OverflowError):
                continue
    return 0
