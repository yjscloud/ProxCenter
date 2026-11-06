"""证书状态的统一口径。

腾讯云的整数状态码被沿用为内部标准（历史数据、日志与前端都按它渲染），阿里云 /
华为云等厂商的字符串状态在各自的适配器里映射到这套值。这样上层只认一种状态，
换厂商不会让「已签发 / 审核中」的判断失效。

单独成模块是为了避免 ``certproviders`` 反向依赖某一家厂商的客户端。
"""
from __future__ import annotations

from typing import Any

#: 内部状态码 → 中文短句（出口处再按请求语言翻译）
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


def status_text(status: Any) -> str:
    try:
        return STATUS_TEXT.get(int(status), "状态 " + str(status))
    except (TypeError, ValueError):
        return "未知状态"
