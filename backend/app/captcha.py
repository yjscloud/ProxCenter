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
from typing import Any, Dict, List, Optional, Tuple

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
    # 干净系统（容器 / 最小化安装）上 /usr/share/fonts 里一个 TTF 都没有。此时
    # Pillow 的 load_default() 是**固定尺寸的点阵字体**：请求 size 也画不大，
    # 结果是 272x80 的画布上只有十几像素高的小字 —— 验证码「很小」就是这个原因
    # （实测：有字体时字高约 41px，退化成点阵字体后只剩 18px）。
    # Pillow ≥ 10.1 的 load_default(size=...) 用内置的可缩放字体，优先用它。
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # 更老的 Pillow：只能退回固定点阵字体
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


# 校验结果。不只用 True/False：调用方需要区分「答错」与「这张题已经没了」，
# 否则同一个 captcha_id 被反复提交时用户一直看到「验证失败」，看起来像没作废
# （审计项 PT-09）。三态还能让审计日志记清到底是猜错还是重放。
RESULT_OK = "ok"
RESULT_WRONG = "wrong"
RESULT_GONE = "gone"


def check(captcha_id: Optional[str], captcha_code: Optional[str]) -> str:
    """一次性校验：**取出即作废**（无论对错），返回三态结果。

    作废发生在比较之前 —— 一次失败之后同一个 id 只会得到 ``RESULT_GONE``，
    不能拿它继续试探坐标/字符。
    """
    entry = _pending.pop((captcha_id or "").strip(), None)
    if not entry:
        return RESULT_GONE
    expected, deadline = entry
    if time.time() > deadline:
        return RESULT_GONE
    got = (captcha_code or "").strip().lower()
    return RESULT_OK if hmac.compare_digest(expected.lower(), got) else RESULT_WRONG


def verify(captcha_id: Optional[str], captcha_code: Optional[str]) -> bool:
    """``check`` 的布尔包装（老调用方 / 测试用）。"""
    return check(captcha_id, captcha_code) == RESULT_OK


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

    在线配置优先；没配过时回落到 ``LOGIN_CAPTCHA``，**默认拖动滑块**：

    * 滑块不依赖字体与图片素材，任何系统上表现都一致 —— 图形码在没装字体的
      干净服务器上字会小到看不清（见 :func:`_font`），默认给滑块更稳；
    * 已经有部署把 ``LOGIN_CAPTCHA`` 设成 0 关掉了验证码，升级后不该被悄悄
      重新打开，所以这种情况仍然保持「关闭」。
    """
    raw = (await store.get_setting(MODE_KEY) or "").strip().lower()
    if raw in MODES:
        return raw
    return MODE_SLIDER if settings.login_captcha else MODE_OFF


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

# 形态沿革，取舍要写清楚：
#
#   v1  拼图（背景挖缺口 + 拼图块对位）→ 真人常差几像素，反复失败；
#   v2  「拖到底」：把滑块推到最右端即通过。判据只剩「有没有拖到底」，
#       而答案就是 `width - handle_size` 这个固定值 —— 脚本 curl 一次
#       带上 264 就能过，验证码对人机识别零作用（H-1）；
#   v3  随机目标 + 把目标画进图片（脚本得先做 CV）；
#   v4  随机目标 + 目标坐标直接下发，画成轨道上的蓝色竖标；
#   v5（当前）外观退回 v2 的「拖到底」，但保留 v4 的轨迹校验。
#
# 退回原因：v3/v4 都要求用户「对准某个位置」，实测反馈是不知道往哪拖、
# 拖过去也不确定对没对上，可用性代价大于它换来的防护。
#
# 退回样式不等于退回防护 —— v2 的死穴是「固定答案 + 不需要过程」，这里
# 只补回了「拖到底」这个判据，过程仍然要交：
#
#   1. 轨迹校验：只交坐标不交轨迹直接判负（见 _path_ok），H-1 的复现脚本
#      照旧过不去；要过就得伪造一条递增采样点，那已经不是三行脚本的量级；
#   2. 一次性 + TTL：同一个 captcha_id 用一次就作废；
#   3. 登录接口按来源 IP 限流兜底。
#
# 挡得住批量撞库与现成脚本，挡不住针对性攻击。要真正抗住，应该接第三方
# 人机验证（Turnstile / hCaptcha），而不是继续在自研滑块上加像素。

# 轨道的设计宽度（展示坐标；前端按它换算百分比，窄屏也不会走形）
SLIDER_W = 320
# 手柄宽度（展示坐标）；拖到最右时手柄右缘正好贴住轨道右缘
SLIDER_HANDLE = 56

# 到末端还差这么多 px 也算拖到底。留余量是刻意的：手指 / 触控板最后几像素
# 很难控制住，卡死在「必须严丝合缝」只会让人反复划不过去。
SLIDER_TOLERANCE = 6

SLIDER_TTL = 180
_SLIDER_MAX = 2000

# 轨迹校验的门槛。真人手指/鼠标拖动必然产生中间采样点与耗时；只提交一个最终
# 坐标的脚本没有轨迹，在这一步就会被拒。
SLIDER_PATH_MIN_POINTS = 5
SLIDER_MIN_MS = 180
SLIDER_MAX_MS = 30_000
# 允许的手抖回弹（px）：轨迹整体要单调向右，但触控板回滑几像素很正常
SLIDER_PATH_BACKTRACK = 3

# id -> (拖到底时的 x, 过期时间戳)。一次性：校验即取出。
_sliders: Dict[str, Tuple[int, float]] = {}


def slider_pass_x() -> int:
    """拖到底时的 x：可拖动范围的右端点（= SLIDER_W - SLIDER_HANDLE）。"""
    return max(0, SLIDER_W - SLIDER_HANDLE)


def issue_slider() -> Dict[str, Any]:
    """签发一道滑动验证题。

    只给几何量与 id，**没有任何图片，也不下发目标坐标** —— 判定是「有没有
    拖到底」，这个答案前端自己就能算出来（width - handle_size），不需要也不
    应该由服务端告诉它。真正起作用的是 id 的一次性、时效，以及提交时的轨迹
    校验（见 :func:`check_slider`）。
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


def _path_ok(path: Optional[List[Dict[str, Any]]], got: float) -> bool:
    """拖动轨迹是否像真人拖出来的。

    H-1 的复现脚本只交一个 captcha_x，没有轨迹 —— 这里直接判负。伪造一条
    递增采样点 + 合理耗时当然可能，但那已经不是「三行脚本」的量级，
    且每次都要新的 captcha_id（一次性）。
    """
    if not path:
        return False
    points: List[Tuple[float, float]] = []
    for item in path:
        if not isinstance(item, dict):
            return False
        try:
            points.append((float(item.get("x")), float(item.get("t"))))
        except (TypeError, ValueError):
            return False
    if len(points) < SLIDER_PATH_MIN_POINTS:
        return False

    ts = [t for _, t in points]
    if any(b < a for a, b in zip(ts, ts[1:])):
        return False
    span = ts[-1] - ts[0]
    if span < SLIDER_MIN_MS or span > SLIDER_MAX_MS:
        return False

    xs = [x for x, _ in points]
    # 末点必须就是提交的位置：否则「轨迹画到 A、坐标交 B」也能蒙过
    if abs(xs[-1] - got) > SLIDER_TOLERANCE:
        return False
    # 整体单调向右（允许小幅回弹）
    if any(b < a - SLIDER_PATH_BACKTRACK for a, b in zip(xs, xs[1:])):
        return False
    return True


def check_slider(
    captcha_id: Optional[str],
    x: Optional[float],
    path: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """滑块的一次性校验，语义同 :func:`check`：先作废再比较。

    三道关：拖到了末端（x >= 右端点 - 容差）、轨迹像人拖的、题目没过期且
    只此一次。判据只要求「不短于末端 - 容差」，往右多报不会有额外好处
    （前端本来最多就到右端点）。
    """
    entry = _sliders.pop((captcha_id or "").strip(), None)
    if not entry:
        return RESULT_GONE
    target, deadline = entry
    if time.time() > deadline:
        return RESULT_GONE
    try:
        got = float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return RESULT_WRONG
    if got < target - SLIDER_TOLERANCE:
        return RESULT_WRONG
    if not _path_ok(path, got):
        return RESULT_WRONG
    return RESULT_OK


def verify_slider(captcha_id: Optional[str], x: Optional[float]) -> bool:
    """``check_slider`` 的布尔包装（老调用方 / 测试用）。"""
    return check_slider(captcha_id, x) == RESULT_OK
