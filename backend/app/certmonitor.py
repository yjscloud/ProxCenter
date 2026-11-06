"""站点可用性监控：HTTP 探测 + 证书链到期检查。

与「证书到期」是两件事：证书可能有效但站点已经 502，也可能站点正常但证书
三天后过期。这里每次探测都同时记录「HTTP 是否可用」和「对端证书还剩几天」，
状态翻转时才发通知（每 5 分钟一条没人受得了）。

刻意不复用 :mod:`alerting`：那套是「指标越界 + 规则匹配」，为一个 URL 的
200/500 写规则太重；这里只需要「上次是什么、这次是什么」。
"""
from __future__ import annotations

import asyncio
import socket
import ssl
import time
from typing import Any, Dict, List, Optional

import httpx

from . import certnotify, certs, i18n

#: 单次探测超时。站点慢不该拖住 5 分钟一轮的作业。
TIMEOUT = 10.0
#: 单轮最多检查多少个站点，避免一条坏链路占满窗口
BATCH = 20


def _cert_days_left(host: str, port: int = 443) -> Optional[int]:
    """读对端证书的剩余天数；连不上或没有证书返回 None。"""
    try:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
        if not der:
            return None
        from cryptography import x509

        cert = x509.load_der_x509_certificate(der)
        expire = getattr(cert, "not_valid_after_utc", None)
        stamp = expire.timestamp() if expire is not None else cert.not_valid_after.timestamp()
        return int((stamp - time.time()) // 86400)
    except Exception:  # noqa: BLE001 - 探测失败就是「读不到」，不算监控失败
        return None


def _url_host(url: str) -> tuple:
    from urllib.parse import urlparse

    parsed = urlparse(url if "://" in url else "https://" + url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return str(parsed.hostname or ""), int(port)


async def probe(url: str) -> Dict[str, Any]:
    """探测一个 URL，返回状态、耗时与对端证书剩余天数。"""
    target = str(url or "").strip()
    if not target:
        return {"status": "", "code": 0, "latency_ms": 0, "error": "", "cert_days": None}
    if "://" not in target:
        target = "https://" + target
    started = time.perf_counter()
    status, code, error = "down", 0, ""
    try:
        # 关掉校验：自签 / 过期证书也要能探到「站点本身是活的」
        async with httpx.AsyncClient(
            timeout=TIMEOUT, verify=False, follow_redirects=True
        ) as client:
            response = await client.get(target)
        code = int(response.status_code)
        if code >= 500:
            status, error = "down", f"HTTP {code}"
        else:
            status = "up"
    except Exception as exc:  # noqa: BLE001 - 任何异常都算 down，原因留给页面
        error = str(exc)[:200]
    latency = int((time.perf_counter() - started) * 1000)

    host, port = _url_host(target)
    cert_days = await asyncio.to_thread(_cert_days_left, host, port) if host else None
    return {
        "status": status,
        "code": code,
        "latency_ms": latency,
        "error": error,
        "cert_days": cert_days,
    }


async def check_site(site: Dict[str, Any]) -> Dict[str, Any]:
    """探测一个站点并写回状态；状态翻转时发一次通知。"""
    url = str(site.get("monitor_url") or "").strip()
    if not url:
        return {}
    previous = str(site.get("monitor_status") or "")
    result = await probe(url)

    site["monitor_status"] = result["status"]
    site["monitor_checked_at"] = int(time.time())
    site["monitor_latency_ms"] = result["latency_ms"]
    site["monitor_error"] = result["error"]
    if result["cert_days"] is not None:
        # 对端证书剩余天数直接落到 expire_at：页面上的「到期」与监控一致
        site["expire_at"] = int(time.time()) + int(result["cert_days"]) * 86400
        site["last_check_at"] = int(time.time())

    name = str(site.get("name") or site.get("domain") or url)
    if result["status"] == "down" and previous != "down":
        await certnotify.notify(
            certs.site_owner(site),
            site,
            certnotify.EVENT_SITE_DOWN,
            i18n.pick("站点不可用：" + url, "Site unreachable: " + url),
            i18n.pick(
                "站点「" + name + "」探测失败：" + (result["error"] or "未知错误"),
                f'Site "{name}" probe failed: {result["error"] or "unknown error"}',
            ),
        )
    elif result["status"] == "up" and previous == "down":
        await certnotify.notify(
            certs.site_owner(site),
            site,
            certnotify.EVENT_SITE_UP,
            i18n.pick("站点已恢复：" + url, "Site recovered: " + url),
            i18n.pick(
                "站点「" + name + "」已恢复，响应 " + str(result["latency_ms"]) + " ms",
                f'Site "{name}" is back, responded in {result["latency_ms"]} ms',
            ),
        )

    return {
        "site": name,
        "status": result["status"],
        "latency_ms": result["latency_ms"],
        "cert_days": result["cert_days"],
        "detail": result["error"] or f"HTTP {result['code']}",
    }


async def monitor_tick() -> List[Dict[str, Any]]:
    """定时作业：逐站点探测（只挑开了监控且有 URL 的启用站点）。"""
    sites = [
        site
        for site in await certs.load_sites()
        if site.get("enabled") and site.get("monitor_enabled") and site.get("monitor_url")
    ]
    results: List[Dict[str, Any]] = []
    for site in sites[:BATCH]:
        result = await check_site(site)
        if result:
            await certs.update_site(site)
            results.append(result)
    return results
