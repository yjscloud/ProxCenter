"""站点信息（品牌名 / 副标题 / 版权 / 自定义 Logo）：可在「设置 → 站点信息」中修改。

这些值原先硬编码在前端（侧边栏、登录页、落地页、浏览器标题），换个部署
环境就要改代码。现在统一存进 settings KV 表；未配置或数据损坏时回落到与
历史完全一致的内置默认值，因此升级后表现不变。

Logo 与登录页背景图例外：以文件形式落在 data/logo/、data/login_bg/ 下，KV 表
只存元信息，避免把二进制塞进数据库行，同时让浏览器可以直接缓存图片。
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import store
from .config import DATA_DIR

logger = logging.getLogger(__name__)

SITE_INFO_KEY = "site_info"

# 内置默认值：数据库里没存过 site_info（或记录损坏）时回落到这里
DEFAULT_NAME = "ProxCenter"
DEFAULT_SUBTITLE = "Proxmox 管理面板"
DEFAULT_COPYRIGHT = "ProxCenter · 自建 Proxmox VE 管理面板"

# 备案号与友情链接默认留空 = 不在页面上展示
DEFAULT_ICP = ""

# 长度上限：侧边栏宽度固定，名字过长会把导航挤变形
MAX_NAME = 32
MAX_SUBTITLE = 40
MAX_COPYRIGHT = 120
MAX_ICP = 64

# 友情链接条数上限：页脚是横向排布，再多会破坏版式
MAX_LINKS = 12
MAX_LINK_NAME = 24
MAX_LINK_URL = 300

# ------------------------------------------------------------------ 站点 Logo

LOGO_KEY = "site_logo"
LOGO_DIR = DATA_DIR / "logo"

# 512 KB 足够放下一个高清 logo，同时避免有人拿它当图床
MAX_LOGO_BYTES = 512 * 1024

# 允许的图片类型 → 落盘扩展名（Logo 与背景图共用）
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
}

# 文件头 → 类型。客户端声明的 MIME 不可信，位图一律按魔数复核。
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
)


def _sniff_mime(data: bytes) -> Optional[str]:
    """按文件内容判断真实图片类型；认不出来返回 None。"""
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    # WebP 是 RIFF 容器，头部还带 'WEBP' 标记
    if len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    # SVG 是文本，没法用魔数，退而检查正文里有没有 <svg>
    if b"<svg" in data[:4096]:
        return "image/svg+xml"
    return None


def _normalize(value: Any, default: str, limit: int) -> str:
    """折叠空白并截断；空串回落默认值。"""
    text = " ".join(str(value or "").split())
    if not text:
        return default
    return text[:limit]


def _clean_url(value: Any) -> str:
    """友链地址白名单：只放行 http/https 与站内相对路径。

    这些地址会被渲染成 ``<a href>``，放任 ``javascript:`` / ``data:`` 之类的
    伪协议等于开放一个存储型 XSS 入口，所以用白名单而不是黑名单。
    """
    url = " ".join(str(value or "").split())
    if not url:
        return ""
    if url.startswith(("http://", "https://", "/")):
        return url[:MAX_LINK_URL]
    return ""


def _clean_links(value: Any) -> List[Dict[str, str]]:
    """整理友情链接：丢掉残缺项、截断超长项、限制总条数。"""
    if not isinstance(value, list):
        return []
    links: List[Dict[str, str]] = []
    for item in value[:MAX_LINKS]:
        if not isinstance(item, dict):
            continue
        name = " ".join(str(item.get("name") or "").split())[:MAX_LINK_NAME]
        url = _clean_url(item.get("url"))
        # 名称与地址缺一不可，否则这条链接既没文字也没去处
        if not name or not url:
            continue
        links.append({"name": name, "url": url})
    return links


def _builtin() -> Dict[str, Any]:
    return {
        "name": DEFAULT_NAME,
        "subtitle": DEFAULT_SUBTITLE,
        "copyright": DEFAULT_COPYRIGHT,
        "icp": DEFAULT_ICP,
        "links": [],
    }


# ------------------------------------------------------------------ 站点信息

async def get_logo_meta() -> Optional[Dict[str, Any]]:
    """当前 logo 的元信息；未上传或文件已丢失时返回 None。"""
    raw = await store.get_setting(LOGO_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("site_logo 元信息损坏，已忽略：%r", raw)
        return None
    if not isinstance(data, dict):
        return None

    filename = str(data.get("filename") or "")
    path = LOGO_DIR / filename
    # 记录在库但文件没了（例如手工清过目录）→ 当作没有 logo，前端回落默认图标
    if not filename or not path.is_file():
        return None

    try:
        updated_at = int(data.get("updated_at") or 0)
    except (TypeError, ValueError):
        updated_at = 0

    return {
        "filename": filename,
        "mime": str(data.get("mime") or "application/octet-stream"),
        "size": int(data.get("size") or 0),
        "updated_at": updated_at,
        "path": str(path),
    }


def logo_url(meta: Optional[Dict[str, Any]]) -> Optional[str]:
    """带版本号的 logo 访问地址；换图后 URL 立即变化，绕开浏览器缓存。"""
    if not meta:
        return None
    return f"/api/config/site/logo?v={meta['updated_at']}"


async def _purge_logo_files() -> None:
    """清掉 logo 目录里的旧文件（换扩展名时避免残留）。"""
    if not LOGO_DIR.is_dir():
        return
    for old in LOGO_DIR.glob("logo.*"):
        try:
            old.unlink()
        except OSError:
            logger.warning("清理旧 logo 失败：%s", old, exc_info=True)


async def save_logo(data: bytes, declared_mime: str = "") -> Dict[str, Any]:
    """保存 logo。类型以文件内容为准，客户端声明只作兜底。

    校验失败抛 ValueError，由路由层转成 400。
    """
    if not data:
        raise ValueError("上传的文件是空的")
    if len(data) > MAX_LOGO_BYTES:
        raise ValueError(f"图片不能超过 {MAX_LOGO_BYTES // 1024} KB")

    mime = _sniff_mime(data) or str(declared_mime or "").split(";")[0].strip().lower()
    ext = IMAGE_TYPES.get(mime)
    if not ext:
        raise ValueError("仅支持 PNG / JPG / WebP / GIF / SVG / ICO 格式的图片")

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    await _purge_logo_files()
    filename = f"logo{ext}"
    (LOGO_DIR / filename).write_bytes(data)

    meta = {
        "filename": filename,
        "mime": mime,
        "size": len(data),
        "updated_at": int(time.time()),
    }
    await store.set_setting(LOGO_KEY, json.dumps(meta, ensure_ascii=False))
    logger.info("站点 logo 已更新：%s（%d 字节，%s）", filename, len(data), mime)
    return meta


async def delete_logo() -> None:
    """移除自定义 logo，前端回落到内置图标。"""
    await _purge_logo_files()
    await store.delete_setting(LOGO_KEY)


# ------------------------------------------------------------- 登录页背景图
# 与 Logo 同一套机制：图片落盘 data/login_bg/，KV 只存元信息。
# 背景是整屏大图，上限放宽到 4 MB；且只收位图 —— SVG 拿来做背景收益不大，
# 还多一类需要额外提防的攻击面，登录页默认插画本来也是位图。

LOGIN_BG_KEY = "site_login_bg"
LOGIN_BG_DIR = DATA_DIR / "login_bg"

MAX_LOGIN_BG_BYTES = 4 * 1024 * 1024

LOGIN_BG_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


async def get_login_bg_meta() -> Optional[Dict[str, Any]]:
    """当前登录页背景图的元信息；未上传或文件已丢失时返回 None。"""
    raw = await store.get_setting(LOGIN_BG_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("site_login_bg 元信息损坏，已忽略：%r", raw)
        return None
    if not isinstance(data, dict):
        return None

    filename = str(data.get("filename") or "")
    path = LOGIN_BG_DIR / filename
    # 记录在库但文件没了 → 当作没有背景图，前端回落内置插画
    if not filename or not path.is_file():
        return None

    try:
        updated_at = int(data.get("updated_at") or 0)
    except (TypeError, ValueError):
        updated_at = 0

    return {
        "filename": filename,
        "mime": str(data.get("mime") or "application/octet-stream"),
        "size": int(data.get("size") or 0),
        "updated_at": updated_at,
        "path": str(path),
    }


def login_bg_url(meta: Optional[Dict[str, Any]]) -> Optional[str]:
    """带版本号的背景图访问地址；换图后 URL 立即变化，绕开浏览器缓存。"""
    if not meta:
        return None
    return f"/api/config/site/login-bg?v={meta['updated_at']}"


async def _purge_login_bg_files() -> None:
    """清掉背景图目录里的旧文件（换扩展名时避免残留）。"""
    if not LOGIN_BG_DIR.is_dir():
        return
    for old in LOGIN_BG_DIR.glob("bg.*"):
        try:
            old.unlink()
        except OSError:
            logger.warning("清理旧登录背景失败：%s", old, exc_info=True)


async def save_login_bg(data: bytes) -> Dict[str, Any]:
    """保存登录页背景图。

    与 Logo 的一点差别：这里**不采信**客户端声明的 MIME —— 支持的四种位图
    全都能按魔数识别，认不出来就是伪装的文件，直接拒收。

    校验失败抛 ValueError，由路由层转成 400。
    """
    if not data:
        raise ValueError("上传的文件是空的")
    if len(data) > MAX_LOGIN_BG_BYTES:
        raise ValueError(f"背景图不能超过 {MAX_LOGIN_BG_BYTES // 1024 // 1024} MB")

    mime = _sniff_mime(data)
    ext = IMAGE_TYPES.get(mime or "")
    if mime not in LOGIN_BG_TYPES or not ext:
        raise ValueError("仅支持 PNG / JPG / WebP / GIF 格式的背景图")

    LOGIN_BG_DIR.mkdir(parents=True, exist_ok=True)
    await _purge_login_bg_files()
    filename = f"bg{ext}"
    (LOGIN_BG_DIR / filename).write_bytes(data)

    meta = {
        "filename": filename,
        "mime": mime,
        "size": len(data),
        "updated_at": int(time.time()),
    }
    await store.set_setting(LOGIN_BG_KEY, json.dumps(meta, ensure_ascii=False))
    logger.info("登录页背景已更新：%s（%d 字节，%s）", filename, len(data), mime)
    return meta


async def delete_login_bg() -> None:
    """移除自定义背景图，登录页回落到内置插画。"""
    await _purge_login_bg_files()
    await store.delete_setting(LOGIN_BG_KEY)


# ------------------------------------------------------------------ 站点信息

async def get_site_info() -> Dict[str, Any]:
    """读取站点信息；未配置或数据损坏时返回内置默认值。"""
    raw = await store.get_setting(SITE_INFO_KEY)
    data: Dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("site_info 配置损坏，已忽略：%r", raw)
            parsed = None
        if isinstance(parsed, dict):
            data = parsed

    return {
        "name": _normalize(data.get("name"), DEFAULT_NAME, MAX_NAME),
        "subtitle": _normalize(data.get("subtitle"), DEFAULT_SUBTITLE, MAX_SUBTITLE),
        "copyright": _normalize(data.get("copyright"), DEFAULT_COPYRIGHT, MAX_COPYRIGHT),
        "icp": _normalize(data.get("icp"), DEFAULT_ICP, MAX_ICP),
        # 读的时候也过一遍清洗：库里的数据可能是旧版本写入的，
        # 或者被手工改过，不能默认它一定合法
        "links": _clean_links(data.get("links")),
        "logo_url": logo_url(await get_logo_meta()),
        "login_bg_url": login_bg_url(await get_login_bg_meta()),
    }


async def set_site_info(
    name: Any = None,
    subtitle: Any = None,
    copyright_text: Any = None,
    icp: Any = None,
    links: Any = None,
) -> Dict[str, Any]:
    """保存站点信息。

    品牌三项留空即恢复默认值；备案号与友情链接留空即不展示。
    """
    payload = {
        "name": _normalize(name, DEFAULT_NAME, MAX_NAME),
        "subtitle": _normalize(subtitle, DEFAULT_SUBTITLE, MAX_SUBTITLE),
        "copyright": _normalize(copyright_text, DEFAULT_COPYRIGHT, MAX_COPYRIGHT),
        "icp": _normalize(icp, DEFAULT_ICP, MAX_ICP),
        "links": _clean_links(links),
    }
    await store.set_setting(SITE_INFO_KEY, json.dumps(payload, ensure_ascii=False))
    # 返回完整信息，保证与前端的 SiteInfo 结构一致（含 logo_url）
    return await get_site_info()
