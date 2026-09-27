"""面板的「全局地址」——邮件等外发内容里用来拼链接的对外域名。

为什么需要它
------------
拼链接时直接取 ``request.base_url`` 只在「用户从哪个 Host 访问」和「外部收件
人能访问哪个地址」一致时才成立。面板挂在反向代理 / frp 后面时，内部请求的
Host 可能是 ``localhost:8080`` 或内网 IP —— 邮件里发出的重置密码链接就会指向
收件人根本打不开的地方。

所以这里提供一份**全局配置**：管理员在「设置」里填一次对外地址
（如 ``https://prox.yjscloud.com``），所有外发链接统一用它；未配置时才回落到
本次请求的 Host（保持向后兼容）。
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request

from . import store

KEY = "panel_base_url"


def normalize(url: Optional[str]) -> str:
    """规范化地址：去空白、去尾部 ``/``、补协议；非 http(s) 一律拒绝。

    留空返回空串，表示「未配置」，调用方回落到 request Host。
    """
    text = str(url or "").strip().rstrip("/")
    if not text:
        return ""
    if "://" not in text:
        # 允许管理员只填域名，协议默认 https（现代部署的基本预期）
        text = f"https://{text}"
    if not (text.startswith("http://") or text.startswith("https://")):
        raise ValueError("面板地址只支持 http:// 或 https://")
    if " " in text:
        raise ValueError("面板地址不能包含空格")
    return text


async def get_base_url() -> str:
    """读取已配置的全局地址；未配置返回空串。"""
    return normalize(await store.get_setting(KEY))


async def set_base_url(url: Optional[str]) -> str:
    """保存全局地址。传空串即清除配置（回落到请求 Host）。"""
    cleaned = normalize(url)
    if cleaned:
        await store.set_setting(KEY, cleaned)
    else:
        await store.delete_setting(KEY)
    return cleaned


async def resolve(request: Optional[Request] = None) -> str:
    """外发链接该用的面板根地址：**配置优先**，未配置才用请求 Host。"""
    configured = await get_base_url()
    if configured:
        return configured
    if request is None:
        return ""
    try:
        return str(request.base_url).rstrip("/")
    except Exception:  # noqa: BLE001 - 取不到就返回空，绝不让发信流程炸掉
        return ""
