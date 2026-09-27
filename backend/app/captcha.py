"""登录验证码：图形码与滑块拼图两种形态，外加一个「关闭」档位。

三种模式由管理员在「设置 → 登录验证」里选，存在 settings KV 表：

* ``off``    不校验。内网纯人用、或自动化联调时用。
* ``image``  四位图形码（默认）。服务端画一张带干扰的 PNG，答案只留内存。
* ``slider`` 拖动滑块到轨道最右端即通过（无拼图、无图片素材）。

设计取舍：

* **答案不落库**：验证码是一次性、短命（几分钟）的验证介质，没有持久化价值；
  面板是单进程 uvicorn（见 ``run.py``），进程内存即天然的单点存储。
* **图形码画 PNG 而非 SVG**：SVG 里 ``<text>`` 的内容是明文，脚本正则一抓就能过；
  位图至少逼脚本去 OCR。Pillow 画图，干扰线 + 噪声点 + 逐字随机旋转。
* **去混淆字符集**：``0/O``、``1/I/L`` 这类不进字符集——用户被自己的验证码
  挡在门外比没有验证码更糟。
* **滑块不背任何图片素材**：自托管部署不该为了一个验证码多背几百 KB 图片、
  更不该依赖外链图床。轨道是纯 CSS 画出来的，服务端只下发几何量。
* **两种模式共用一套一次性语义**：无论对错，校验即作废（``pop``）。滑块因此
  把「拖动位置」当作答案，而不是「解出来的凭据」—— 少一次往返，也少一个
  可被重放的令牌。

滑块的判定是**宽松**的（到末端 6px 以内即算拖到底）：这是「证明你是人」的
门槛，不是精确对位游戏；把误差卡到 1~2px 只会让人反复划不过去。
"""
from __future__ import annotations

import base64
import glob
import hmac
import io
import random
import secrets
import time
from typing import Any, Dict, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

from . import store
from .config import settings

# 不含 0 O 1 I L 等易混字符
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LEN = 4
TTL = 300  # 秒：够看清并输入，又不至于被拿去慢慢试

# id -> (答案, 过期时间戳)。一次性：无论对错，校验即取出。
_pending: Dict[str, Tuple[str, float]] = {}
_MAX_PENDING = 5000

# 2 倍渲染，Retina 屏上不糊；展示尺寸 136x40
_SCALE = 2
_W, _H = 136, 40

# 系统里的粗体 TTF；一台也没有时退回 Pillow 内置字体
_FONTS = sorted(
    set(
        glob.glob("/usr/share/fonts/**/*Sans-Bold.ttf", recursive=True)
        or glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
    )
)

# 深色系字色，保证在浅底上对比度足够
_INK = [(19, 84, 173), (146, 64, 14), (22, 118, 84), (156, 28, 50), (90, 64, 160)]


def _font(size: int) -> ImageFont.ImageFont:
    if _FONTS:
        try:
            return ImageFont.truetype(random.choice(_FONTS), size)
        except OSError:
            pass
    return ImageFont.load_default()


def _render(code: str) -> bytes:
    """把答案画成 PNG 字节串：浅底 + 随机折线 + 噪声点 + 逐字旋转。"""
    w, h = _W * _SCALE, _H * _SCALE
    img = Image.new("RGB", (w, h), (245, 247, 250))
    draw = ImageDraw.Draw(img)

    # 干扰折线：糊住笔画轮廓但不挡阅读
    for _ in range(4):
        pts = [(random.randrange(w), random.randrange(h)) for _ in range(4)]
        draw.line(
            pts,
            fill=tuple(random.randint(150, 220) for _ in range(3)),
            width=_SCALE,
        )

    # 噪声点
    for _ in range(60):
        x, y = random.randrange(w), random.randrange(h)
        r = random.randrange(_SCALE, 3 * _SCALE)
        draw.ellipse(
            (x - r, y - r, x + r, y + r),
            fill=tuple(random.randint(170, 235) for _ in range(3)),
        )

    # 逐字：独立画在透明瓦片上 → 随机旋转 → 贴回主图
    margin = 8 * _SCALE
    slot = (w - 2 * margin) // CODE_LEN
    for i, ch in enumerate(code):
        size = random.randint(21, 25) * _SCALE
        font = _font(size)
        tile_w = slot
        tile_h = int(size * 1.5)
        tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
        tdraw = ImageDraw.Draw(tile)
        tdraw.text(
            (tile_w // 2, tile_h // 2),
            ch,
            font=font,
            fill=random.choice(_INK) + (255,),
            anchor="mm",
        )
        tile = tile.rotate(
            random.uniform(-25, 25), resample=Image.Resampling.BICUBIC
        )
        x = margin + i * slot
        y = random.randint(0, max(0, h - tile_h))
        img.paste(tile, (x, y), tile)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _prune() -> None:
    now = time.time()
    for book, limit in ((_pending, _MAX_PENDING), (_sliders, _SLIDER_MAX)):
        for key in [k for k, (_, exp) in book.items() if exp < now]:
            book.pop(key, None)
        # 兜底：异常流量下也别让这些 dict 无限长
        while len(book) > limit:
            book.pop(next(iter(book)), None)


def issue() -> Dict[str, str]:
    """签发一张验证码，返回 ``{"id": ..., "image": data URI}``。"""
    _prune()
    code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))
    cid = secrets.token_urlsafe(24)
    _pending[cid] = (code, time.time() + TTL)
    image = base64.b64encode(_render(code)).decode("ascii")
    return {"id": cid, "image": f"data:image/png;base64,{image}"}


def verify(captcha_id: Optional[str], captcha_code: Optional[str]) -> bool:
    """一次性校验：取出即作废，答错/过期/不存在都返回 False。"""
    entry = _pending.pop((captcha_id or "").strip(), None)
    if not entry:
        return False
    expected, deadline = entry
    if time.time() > deadline:
        return False
    got = (captcha_code or "").strip().lower()
    return hmac.compare_digest(expected.lower(), got)


# ===========================================================================
# 一、验证方式（管理员可在「设置 → 登录验证」里切换）
# ===========================================================================

MODE_OFF = "off"
MODE_IMAGE = "image"
MODE_SLIDER = "slider"
MODES: Tuple[str, ...] = (MODE_OFF, MODE_IMAGE, MODE_SLIDER)

# 存 settings KV 表；没有这一行时回落到 .env 的 LOGIN_CAPTCHA
MODE_KEY = "login_captcha_mode"

MODE_LABEL = {
    MODE_OFF: "关闭",
    MODE_IMAGE: "图形验证码",
    MODE_SLIDER: "拖动滑块",
}


async def get_mode() -> str:
    """当前登录验证方式。

    在线配置优先；没配过时回落到 ``LOGIN_CAPTCHA``（默认 True → 图形码）——
    已经有部署把它设成 0 关掉了验证码，升级后不该被悄悄重新打开。
    """
    raw = (await store.get_setting(MODE_KEY) or "").strip().lower()
    if raw in MODES:
        return raw
    return MODE_IMAGE if settings.login_captcha else MODE_OFF


async def set_mode(mode: str) -> str:
    """保存在线配置。非法值抛 ``ValueError``（路由层转 400）。"""
    value = (mode or "").strip().lower()
    if value not in MODES:
        raise ValueError(
            f"登录验证方式只能是 {'/'.join(MODES)} 之一，收到 {mode!r}"
        )
    await store.set_setting(MODE_KEY, value)
    return value


# ===========================================================================
# 二、滑动验证（拖动滑块）
# ===========================================================================

# 判定从「对位」改成了「到底」：
#   早先是拼图 —— 背景挖个缺口，把拼图块拖过去对上，服务端比对 x 是否落在
#   目标附近。它对真人不够友好（手机上经常差几个像素反复失败），还要生成并
#   传输两张图。现在改成控制台里更常见的「拖到底即通过」：一条轨道，把滑块
#   推到最右端就算完成，判据只有「有没有拖到底」。
#
# 安全性上的取舍要说清楚：纯「拖到底」比拼图弱 —— 脚本可以直接提交最大值，
# 它挡的是最朴素的批量撞库，挡不住针对性攻击。真要更硬得上行为特征或第三方
# 人机验证。这里仍保留 id + 一次性 + TTL，至少让「不请求挑战直接提交」与
# 「重放」都过不去。

# 轨道的设计宽度（展示坐标；前端按它换算百分比，窄屏也不会走形）
SLIDER_W = 320
# 手柄宽度（展示坐标）；拖到最右时手柄右缘正好贴住轨道右缘
SLIDER_HANDLE = 56

# 到末端还差这么多 px 也算拖到底。留余量是刻意的：手指 / 触控板最后几像素
# 很难控制住，卡死在「必须严丝合缝」只会让人反复划不过去。
SLIDER_TOLERANCE = 6

SLIDER_TTL = 180
_SLIDER_MAX = 2000

# id -> (拖到底时的 x, 过期时间戳)。一次性：校验即取出。
_sliders: Dict[str, Tuple[int, float]] = {}


def slider_pass_x() -> int:
    """拖到底时的 x：可拖动范围的右端点。"""
    return max(0, SLIDER_W - SLIDER_HANDLE)


def issue_slider() -> Dict[str, Any]:
    """签发一道滑动验证题。

    只给几何量与 id，**没有任何图片**。也不需要藏答案：判定是「有没有拖到
    底」，这个答案前端自己就能算出来；真正起作用的是 id 的一次性与时效。
    """
    _prune()
    cid = secrets.token_urlsafe(24)
    _sliders[cid] = (slider_pass_x(), time.time() + SLIDER_TTL)
    return {
        "id": cid,
        # 前端用 width / handle_size 算手柄宽度与可拖动范围的百分比
        "width": SLIDER_W,
        "handle_size": SLIDER_HANDLE,
        # 差这么多 px 以内也算拖到底：前端据此提前给出「已达标」的视觉反馈
        "tolerance": SLIDER_TOLERANCE,
    }


def verify_slider(captcha_id: Optional[str], x: Optional[float]) -> bool:
    """一次性校验：取出即作废；没拖到底 / 过期 / 不存在都返回 False。"""
    entry = _sliders.pop((captcha_id or "").strip(), None)
    if not entry:
        return False
    target, deadline = entry
    if time.time() > deadline:
        return False
    try:
        got = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return got >= target - SLIDER_TOLERANCE
