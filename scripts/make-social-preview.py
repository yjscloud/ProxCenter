#!/usr/bin/env python3
"""生成 GitHub 社交预览图（1280×640）→ docs/screenshots/social-preview.png

GitHub 的仓库社交预览图要在 Settings → General → Social preview 里手工上传，
尺寸必须是 1280×640（否则会被裁切），这张图决定链接分享到微信 / Telegram /
Slack / X 时的样子 —— 没有它就是一块灰底占位。

刻意用**真实截图 + 本地字体**渲染，而不是让画图模型生成：模型画的标题文字经常
糊成一团，而这张图最要紧的就是让人一眼看清项目名。左侧文案一律经 `fit()` 按
「可用宽度」自动缩字号 —— 换文案 / 换截图都不会压到右边的卡片上。

依赖：Pillow（后端虚拟环境里已有）+ 一套 Noto Sans CJK（Debian/Ubuntu 是
fonts-noto-cjk，RHEL 系是 google-noto-sans-cjk-fonts）。用法：

    .venv/bin/python scripts/make-social-preview.py

换截图 / 改文案直接改下面的常量后重跑即可。
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover - 环境问题
    sys.exit("需要 Pillow：../.venv/bin/python -m pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SHOT = ROOT / "docs" / "screenshots" / "dashboard.png"
OUT = ROOT / "docs" / "screenshots" / "social-preview.png"

# --- 画布 ---------------------------------------------------------------------
W, H = 1280, 640
MARGIN = 64                      # 左右留白
CARD_W = 716                     # 右侧截图卡片宽度
GAP = 44                         # 左栏文字与卡片之间的最小间距

BG_TOP = (13, 17, 23)            # GitHub 深色底
BG_BOTTOM = (22, 27, 34)
ACCENT = (88, 166, 255)          # 与面板同一个蓝色系
TEXT = (230, 237, 243)
MUTED = (139, 148, 158)

TITLE = "ProxCenter"
SUBTITLE = "Proxmox VE 8.x / 9.x 管理面板"
BULLETS = (
    "虚拟机与 LXC 容器全生命周期",
    "cloud-init 模板 · 监控大盘",
    "VNC 控制台 · 多用户权限 · 操作审计",
)
FOOTER = "github.com/yjscloud/ProxCenter"

# Noto Sans CJK 的 .ttc 里第 2 个 face 是简体中文（0=JP, 1=KR, 2=SC）
CJK_BOLD = ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc", 2)
CJK_REGULAR = ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", 2)


def load_font(spec: tuple[str, int], size: int) -> ImageFont.FreeTypeFont:
    path, index = spec
    try:
        return ImageFont.truetype(path, size, index=index)
    except OSError:
        # 字体不在（或不是 .ttc）：退到 PIL 自带位图字体，图丑但不会崩
        return ImageFont.load_default(size)


def fit(
    draw: ImageDraw.ImageDraw,
    text: str,
    spec: tuple[str, int],
    want: int,
    max_width: int,
    min_size: int = 12,
) -> ImageFont.FreeTypeFont:
    """从 `want` 号字往下缩，直到这行字放得进 `max_width`。

    手写死字号最容易踩的坑：换一句更长的文案（或换了字体）就压到右边的截图上，
    而截图是浅色的，被压住的部分会直接糊掉。所以宽度约束交给代码。
    """
    size = want
    while size > min_size:
        font = load_font(spec, size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return load_font(spec, min_size)


def gradient(size: tuple[int, int]) -> Image.Image:
    """竖向渐变：纯色底在大图上看会很平。"""
    img = Image.new("RGB", (1, size[1]))
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        img.putpixel((0, y), tuple(
            round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        ))
    return img.resize(size)


def glow(size: tuple[int, int], center: tuple[int, int], radius: int) -> Image.Image:
    """卡片背后的柔光：让截图看起来是浮在底上，而不是贴上去的。"""
    layer = Image.new("L", size, 0)
    ImageDraw.Draw(layer).ellipse(
        [center[0] - radius, center[1] - radius // 2,
         center[0] + radius, center[1] + radius // 2],
        fill=70,
    )
    return layer.filter(ImageFilter.GaussianBlur(90))


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255
    )
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> int:
    if not SHOT.exists():
        sys.exit(f"找不到截图：{SHOT}")
    canvas = gradient((W, H)).convert("RGB")

    # --- 右侧：真实截图卡片 -------------------------------------------------
    shot = Image.open(SHOT).convert("RGB")
    card_h = round(shot.height * CARD_W / shot.width)
    shot = shot.resize((CARD_W, card_h), Image.LANCZOS)
    card_x, card_y = W - CARD_W - MARGIN, (H - card_h) // 2

    canvas.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, 0),
                 glow((W, H), (card_x + CARD_W // 2, H // 2), 440))

    card = rounded(shot, 14)
    # 1px 描边：浅色截图贴在深色底上，不描边会糊在一起
    ImageDraw.Draw(card).rounded_rectangle(
        [0, 0, CARD_W - 1, card_h - 1], radius=14, outline=(48, 54, 61), width=1
    )
    canvas.paste(card, (card_x, card_y), card)

    # --- 左侧：文案（宽度自适应，绝不越界）----------------------------------
    draw = ImageDraw.Draw(canvas)
    x = MARGIN
    room = card_x - GAP - x          # 左栏可用宽度

    title_font = fit(draw, TITLE, CJK_BOLD, 72, room)
    draw.text((x, 138), TITLE, font=title_font, fill=TEXT)

    sub_font = fit(draw, SUBTITLE, CJK_BOLD, 30, room)
    draw.text((x, 138 + title_font.size + 26), SUBTITLE, font=sub_font, fill=ACCENT)

    rule_y = 138 + title_font.size + 26 + sub_font.size + 30
    draw.rectangle([x, rule_y, x + 96, rule_y + 3], fill=ACCENT)

    bullet_font = fit(draw, max(BULLETS, key=len), CJK_REGULAR, 21, room)
    y = rule_y + 40
    for line in BULLETS:
        draw.text((x, y), line, font=bullet_font, fill=TEXT)
        y += round(bullet_font.size * 2)

    draw.text((x, H - MARGIN - 24), FOOTER,
              font=fit(draw, FOOTER, CJK_REGULAR, 22, room), fill=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, "PNG", optimize=True)
    print(f"已生成 {OUT.relative_to(ROOT)}  {canvas.size[0]}×{canvas.size[1]}  "
          f"{OUT.stat().st_size // 1024}KB")

    # 自检：任何一行都不该越到卡片上（越了就是文案该改短，或卡片该改小）
    room_limit = card_x - GAP
    for label, text, font in [
        ("标题", TITLE, title_font),
        ("副标题", SUBTITLE, sub_font),
        ("要点", max(BULLETS, key=len), bullet_font),
        ("落款", FOOTER, load_font(CJK_REGULAR, 22)),
    ]:
        end = x + draw.textlength(text, font=font)
        flag = "✗ 越界" if end > room_limit else "✓"
        print(f"   {label}：右边界 {end:.0f}px / 限 {room_limit}px  {flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
