"""面板准入白名单（PANEL_ALLOW_CIDRS）。

为什么需要它
------------
面板是 PVE 的全权管理入口：拿到一个面板账号，就等于拿到集群里所有虚拟机
的 root 控制台。面板通常又要对公网提供访问（见 FAQ「只有面板自身需要对外
提供访问入口」），于是它必须按互联网资产的标准收敛来源：

* 首选把入口放在 VPN / 零信任网关之后；
* 第二节是**来源白名单**：只允许办公网 / 跳板机 / 反代所在网段访问，
  其余来源连登录页、/api/openapi.json 都看不到。

实现取舍
--------
* **留空 = 关闭**。这让存量部署升级后行为不变；是否启用由运维显式决定。
* 本机回环永远放行：反代、健康检查、容器里的 sidecar 都从 127.0.0.1 来，
  一刀切会把它们一起挡掉；而能连到回环的攻击者已经在主机内，白名单不再是
  主要边界。
* ``/api/health`` 永远放行：负载均衡探活不该因为白名单配置而失败，且它不返回
  集群信息（与限流中间件的例外保持一致）。
* 解析失败时**失败关闭**：写错的 CIDR 不能悄悄退化成「允许所有人」。启动日志
  会明确指出哪一段无法解析，运维改配置即可；回环仍可用，便于就地修复。
* 只认「可信反代」传来的 X-Forwarded-For（见 security.client_ip_from_scope）。
  直接暴露公网时，客户端自己填的头不参与判断 —— 否则白名单形同虚设。
"""
from __future__ import annotations

import logging
from functools import lru_cache
from ipaddress import ip_address, ip_network
from typing import Any, List, Tuple

from .config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=8)
def _networks(raw: str) -> Tuple[Any, ...]:
    """把逗号分隔的配置解析成网络对象；非法项记录 warning 后忽略。

    用 ``lru_cache`` 按原始字符串缓存：环境变量在进程生命周期内不变，解析只
    发生一次；测试里改配置也能因为 key 变化而重新解析。
    """
    networks: List[Any] = []
    for piece in (raw or "").replace(";", ",").split(","):
        item = piece.strip()
        if not item:
            continue
        try:
            # strict=False：允许写 "10.0.0.5/24"（按 10.0.0.0/24 处理），
            # 运维常把「某个地址所在的网段」直接抄进来。
            networks.append(ip_network(item, strict=False))
        except ValueError:
            logger.warning(
                "PANEL_ALLOW_CIDRS 中的 %r 不是合法的 IP / CIDR，已忽略；"
                "其余合法项仍然生效（非法项不会放开访问）。",
                item,
            )
    return tuple(networks)


def configured() -> bool:
    """是否启用了准入白名单。"""
    return bool((settings.panel_allow_cidrs or "").strip())


def allowed_networks() -> List[str]:
    """配置里的合法网段（启动日志 / 只读状态接口用）。"""
    return [str(net) for net in _networks(settings.panel_allow_cidrs or "")]


def has_invalid_entries() -> bool:
    """是否存在写错的条目（用于启动告警）。"""
    raw = settings.panel_allow_cidrs or ""
    items = [p.strip() for p in raw.replace(";", ",").split(",") if p.strip()]
    return len(items) > len(_networks(raw))


def normalize_ip(value: str) -> str:
    """把来源地址归一成可比较的形态。

    * IPv4-mapped IPv6（``::ffff:1.2.3.4``，双栈监听时很常见）折回 IPv4；
    * 其他原样返回；解析失败返回空串（调用方按拒绝处理）。
    """
    text = (value or "").strip().strip("[]")
    if not text:
        return ""
    try:
        addr = ip_address(text)
    except ValueError:
        return ""
    if addr.version == 6 and addr.ipv4_mapped is not None:
        return str(addr.ipv4_mapped)
    return str(addr)


def is_allowed(value: str) -> bool:
    """该来源是否允许访问面板；未配置白名单时恒为 True。"""
    if not configured():
        return True
    ip = normalize_ip(value)
    if not ip:
        return False
    addr = ip_address(ip)
    if addr.is_loopback:
        return True
    for network in _networks(settings.panel_allow_cidrs or ""):
        if network.version == addr.version and addr in network:
            return True
    return False


def startup_hint() -> str:
    """启动日志一句话：白名单是否生效、包含哪些网段。"""
    if not configured():
        return (
            "面板准入白名单未配置（PANEL_ALLOW_CIDRS 为空）：任何来源都能访问面板。"
            "公网部署请收敛到 VPN / 白名单，并启用 TOTP_REQUIRED_ROLES=admin。"
        )
    nets = allowed_networks()
    if not nets:
        return "面板准入白名单已启用，但没有合法网段：仅本机回环可访问。"
    return f"面板准入白名单已启用：{', '.join(nets)}"
