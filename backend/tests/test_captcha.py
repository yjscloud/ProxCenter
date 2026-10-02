"""登录人机验证：默认方式，以及「没装字体时的图形码」回归。

两件事都是实测踩出来的：

* 干净服务器（容器 / 最小化安装）上 ``/usr/share/fonts`` 里一个 TTF 都没有，
  图形码会退回 Pillow 的**固定点阵字体** —— 272x80 的画布上只有约 18px 高的字，
  表现出来就是「验证码很小」；改成内置可缩放字体后约 40px；
* 默认方式原先是图形码，现在是**拖动滑块**（不依赖字体与图片素材）。

用例不碰数据库：``get_mode`` 依赖的 settings KV 用打桩顶替。
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import sys
from pathlib import Path

from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")

from app import captcha, store  # noqa: E402
from app.config import settings  # noqa: E402


def _ink_height(png: bytes) -> int:
    """图里「明显比底色深」的像素纵向跨度 —— 也就是字的实际高度。

    底色是浅灰 (245,247,250)，干扰线与噪点都是浅色（>140），只有字是深色。
    """
    img = Image.open(io.BytesIO(png)).convert("L")
    px = img.load()
    ys = [y for y in range(img.height) for x in range(img.width) if px[x, y] < 140]
    return (max(ys) - min(ys) + 1) if ys else 0


class TestDefaultMode:
    """默认拖动滑块；显式配过以配置为准；已关掉的部署保持关闭。"""

    def test_defaults_to_slider(self, monkeypatch) -> None:
        async def no_setting(_key: str) -> str:
            return ""

        monkeypatch.setattr(store, "get_setting", no_setting)
        monkeypatch.setattr(settings, "login_captcha", True)
        assert asyncio.run(captcha.get_mode()) == captcha.MODE_SLIDER

    def test_explicit_mode_wins(self, monkeypatch) -> None:
        async def image_mode(_key: str) -> str:
            return "image"

        monkeypatch.setattr(store, "get_setting", image_mode)
        assert asyncio.run(captcha.get_mode()) == captcha.MODE_IMAGE

    def test_disabled_stays_disabled(self, monkeypatch) -> None:
        """升级不该把「已经关掉验证码」的部署悄悄打开。"""

        async def no_setting(_key: str) -> str:
            return ""

        monkeypatch.setattr(store, "get_setting", no_setting)
        monkeypatch.setattr(settings, "login_captcha", False)
        assert asyncio.run(captcha.get_mode()) == captcha.MODE_OFF


class TestImageFallback:
    """没有系统字体时图形码仍要看得清 —— 这是「验证码很小」的回归。"""

    def test_glyphs_are_not_tiny_without_system_fonts(self, monkeypatch) -> None:
        monkeypatch.setattr(captcha, "_FONTS", [])
        height = _ink_height(captcha._render("ABCD"))
        assert height >= captcha._H * captcha._SCALE * 0.35, f"字太小：{height}px"

    def test_issue_returns_full_size_png(self) -> None:
        issued = captcha.issue()
        assert issued["image"].startswith("data:image/png;base64,")
        raw = base64.b64decode(issued["image"].split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as img:
            assert img.size == (
                captcha._W * captcha._SCALE,
                captcha._H * captcha._SCALE,
            )

    def test_verify_is_one_time(self) -> None:
        """0 不在字符表里，用它当「必然错误」的答案。"""
        issued = captcha.issue()
        assert captcha.verify(issued["id"], "0000") is False
        assert captcha.verify(issued["id"], "0000") is False  # 已作废
