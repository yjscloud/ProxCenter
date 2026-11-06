"""证书签发厂商注册表。

``site['ca']`` 里存的就是这里的 ``kind``。新增厂商只需两步：

1. 写一个 :class:`~app.certproviders.base.CertProvider` 子类，实现申请 / 查询 /
   下载 / 删除 / 列表 / 自检；
2. 在本文件的 :data:`PROVIDERS`、:data:`FIELDS`、:data:`DEFAULTS` 里登记。

上层的站点模型、申请与续期流水线、部署、告警、审计都不认识厂商名 —— 它们只
调用统一接口，所以换厂商不影响已有站点：改 ``site['ca']`` 即可，旧站点继续用
自己的厂商配置跑。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Type

from .aliyun import AliyunProvider
from .base import (
    ApplyResult,
    CertInfo,
    CertProvider,
    ProviderError,
    STATUS_FAILED,
    STATUS_ISSUED,
    STATUS_PENDING,
    parse_time,
    status_text,
)
from .huawei import HuaweiProvider
from .tencent import TencentProvider

#: 云厂商（不含 ACME 与「托管证书」，那两条不是厂商）
PROVIDERS: Dict[str, Type[CertProvider]] = {
    TencentProvider.kind: TencentProvider,
    AliyunProvider.kind: AliyunProvider,
    HuaweiProvider.kind: HuaweiProvider,
}

#: 页面上的展示名（中文原文，出口处翻译）
LABELS: Dict[str, str] = {
    TencentProvider.kind: TencentProvider.label,
    AliyunProvider.kind: AliyunProvider.label,
    HuaweiProvider.kind: HuaweiProvider.label,
}

#: 「添加厂商」里的一句说明（前端词条 key；原文在这里做兜底）
TAGLINES: Dict[str, str] = {
    TencentProvider.kind: "免费 DV 证书，腾讯云账号直接签发，不需要 DNS 授权",
    AliyunProvider.kind: "免费 DV 证书，在阿里云证书服务里自动完成域名验证",
    HuaweiProvider.kind: "免费 DV 证书，需要先在华为云 SCM 开通证书服务",
}

#: 去哪里拿 AK/SK：添加向导里的「如何获取密钥」直接跳到对应控制台
HELP_URLS: Dict[str, str] = {
    TencentProvider.kind: "https://console.cloud.tencent.com/cam/capi",
    AliyunProvider.kind: "https://ram.console.aliyun.com/manage/ak",
    HuaweiProvider.kind: "https://console.huaweicloud.com/iam/#/mine/accessKey",
}

#: 每个厂商需要加密落库的字段
SECRET_FIELDS: Dict[str, tuple] = {
    TencentProvider.kind: ("secret_key",),
    AliyunProvider.kind: ("access_key_secret",),
    HuaweiProvider.kind: ("access_key_secret",),
}

#: 各厂商配置的默认值（新增字段时只需改这里）
DEFAULTS: Dict[str, Dict[str, Any]] = {
    TencentProvider.kind: {
        "secret_id": "",
        "secret_key": "",
        "dv_auth_method": "DNS_AUTO",
        "encrypt_algo": "RSA",
        "renew_before_days": 15,
    },
    AliyunProvider.kind: {
        "access_key_id": "",
        "access_key_secret": "",
        "validate_type": "DNS_AUTO",
        "renew_before_days": 15,
    },
    HuaweiProvider.kind: {
        "access_key_id": "",
        "access_key_secret": "",
        "region": "cn-north-4",
        "key_algorithm": "RSA_2048",
        "renew_before_days": 15,
    },
}

_DV_OPTIONS = [
    {"value": "DNS_AUTO", "label_key": "cert.dvAuthAuto"},
    {"value": "DNS", "label_key": "cert.dvAuthDns"},
    {"value": "FILE", "label_key": "cert.dvAuthFile"},
]

#: 前端表单的字段 schema：label 走前端词条 key，后端只描述结构
FIELDS: Dict[str, List[Dict[str, Any]]] = {
    TencentProvider.kind: [
        {
            "key": "secret_id",
            "label_key": "cert.fieldSecretId",
            "placeholder": "AKIDxxxxxxxxxxxxxxxx",
            "required": True,
        },
        {
            "key": "secret_key",
            "label_key": "cert.fieldSecretKey",
            "type": "password",
            "secret": True,
            "required": True,
        },
        {"key": "dv_auth_method", "label_key": "cert.fieldDvAuth", "type": "select", "options": _DV_OPTIONS},
        {
            "key": "encrypt_algo",
            "label_key": "cert.fieldEncryptAlgo",
            "type": "select",
            "options": [
                {"value": "RSA", "label_key": "cert.algoRsa"},
                {"value": "ECC", "label_key": "cert.algoEcc"},
            ],
        },
        {
            "key": "renew_before_days",
            "label_key": "cert.fieldDefaultRenewDays",
            "type": "number",
            "min": 1,
            "max": 60,
        },
    ],
    AliyunProvider.kind: [
        {
            "key": "access_key_id",
            "label_key": "cert.fieldAccessKeyId",
            "placeholder": "LTAI...",
            "required": True,
        },
        {
            "key": "access_key_secret",
            "label_key": "cert.fieldAccessKeySecret",
            "type": "password",
            "secret": True,
            "required": True,
        },
        {"key": "validate_type", "label_key": "cert.fieldValidateType", "type": "select", "options": _DV_OPTIONS},
        {
            "key": "renew_before_days",
            "label_key": "cert.fieldDefaultRenewDays",
            "type": "number",
            "min": 1,
            "max": 60,
        },
    ],
    HuaweiProvider.kind: [
        {
            "key": "access_key_id",
            "label_key": "cert.fieldAccessKeyId",
            "placeholder": "HPUA...",
            "required": True,
        },
        {
            "key": "access_key_secret",
            "label_key": "cert.fieldAccessKeySecret",
            "type": "password",
            "secret": True,
            "required": True,
        },
        {"key": "region", "label_key": "cert.fieldRegion", "placeholder": "cn-north-4"},
        {
            "key": "key_algorithm",
            "label_key": "cert.fieldKeyAlgorithm",
            "type": "select",
            "options": [
                {"value": "RSA_2048", "label_key": "cert.algoRsa2048"},
                {"value": "EC_P256", "label_key": "cert.algoEcP256"},
            ],
        },
        {
            "key": "renew_before_days",
            "label_key": "cert.fieldDefaultRenewDays",
            "type": "number",
            "min": 1,
            "max": 60,
        },
    ],
}


def kinds() -> List[str]:
    return list(PROVIDERS)


def is_provider(kind: Any) -> bool:
    return str(kind or "") in PROVIDERS


def label(kind: Any) -> str:
    return LABELS.get(str(kind or ""), str(kind or ""))


def build_provider(kind: str, cfg: Optional[Dict[str, Any]] = None) -> CertProvider:
    """按 ``site['ca']`` 造一个厂商客户端；未知厂商直接报错，不要静默降级。"""
    factory = PROVIDERS.get(str(kind or ""))
    if factory is None:
        raise ProviderError("不支持的证书签发厂商：" + str(kind or "(空)"))
    return factory(cfg or {})


def schema() -> List[Dict[str, Any]]:
    """给前端的厂商描述：字段、默认值、哪些字段是密文。"""
    items: List[Dict[str, Any]] = []
    for kind, factory in PROVIDERS.items():
        items.append(
            {
                "kind": kind,
                "label": label(kind),
                "label_key": "cert.provider" + kind.capitalize(),
                "synchronous": bool(factory.synchronous),
                "secret_fields": list(SECRET_FIELDS.get(kind, ())),
                "defaults": dict(DEFAULTS.get(kind, {})),
                # 添加向导用：一句说明 + 「去哪拿密钥」的控制台地址
                "tagline": TAGLINES.get(kind, ""),
                "tagline_key": "cert.provider" + kind.capitalize() + "Tagline",
                "help_url": HELP_URLS.get(kind, ""),
                "fields": [dict(field) for field in FIELDS.get(kind, [])],
            }
        )
    return items


__all__ = [
    "ApplyResult",
    "CertInfo",
    "CertProvider",
    "DEFAULTS",
    "FIELDS",
    "HELP_URLS",
    "LABELS",
    "PROVIDERS",
    "TAGLINES",
    "ProviderError",
    "SECRET_FIELDS",
    "STATUS_FAILED",
    "STATUS_ISSUED",
    "STATUS_PENDING",
    "build_provider",
    "is_provider",
    "kinds",
    "label",
    "parse_time",
    "schema",
    "status_text",
]
