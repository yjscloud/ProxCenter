"""前端构建产物的版本一致性检查。

构建时 :file:`scripts/write-build-info.mjs` 往 ``dist/build-info.json`` 写一份版本号，
这里读它与 :data:`app.__version__` 比对 —— 不一致就说明**前端产物陈旧**。

为什么非要有人查这件事：这种不一致此前在界面上毫无迹象。后端代码已是新版、服务
照常运行、页面照常打开，只是界面跑着旧前端（少了新加的按钮，或者干脆是构建失败后
留下的上一版 ``dist/``）。实测能走到这个状态的路径不止一条：

* 跳版本升级时新加的依赖没装上，``npm run build`` 直接失败（0.2.0 → 0.2.2 踩过）；
* 用户按提示用了 ``--skip-frontend``，复用了上一版的 ``dist/``；
* 源码包安装的 ``rsync`` 明确排除 ``dist``，于是留着上个版本的产物；
* 构建跑到一半被中断。

这里校验的是**结果**（产物版本 vs 代码版本），上面每一条都会落成同一个状态，
所以一道检查全兜住 —— 而不是去逐个堵住那些过程。同时它也是 ``deploy.sh`` 那处
「每次都装依赖」的兜底：万一还有没预料到的路径，这个状态一定看得见。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from . import __version__
from .config import BASE_DIR

logger = logging.getLogger(__name__)

#: 与 ``main.DIST_DIR`` 指向同一处（后端直接托管前端产物）。这里自己算一遍而不是
#: import main —— main 会反过来 import 本模块，绕成环。
DIST_DIR = BASE_DIR.parent / "dist"
BUILD_INFO = DIST_DIR / "build-info.json"


def read() -> Optional[Dict[str, Any]]:
    """读构建标记；文件不存在、内容损坏或没有版本号时返回 ``None``。"""
    try:
        data = json.loads(BUILD_INFO.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    version = str(data.get("version") or "")
    if not version:
        return None
    built_at = data.get("built_at")
    return {
        "version": version,
        "built_at": int(built_at) if isinstance(built_at, (int, float)) else None,
    }


def status() -> Dict[str, Any]:
    """给接口与界面用的状态：产物版本、代码版本、是否一致，以及不一致的原因。

    ``reason`` 的取值：

    * ``""``        —— 一致；
    * ``mismatch``  —— 两边版本号不同，这是真正要修的那种；
    * ``no_build``  —— 有 dist 但没有版本标记（0.2.2 之前的老脚本构建的产物，
      无法判断新旧，提示重建即可）；
    * ``no_dist``   —— 没有 dist 目录（开发时只跑后端、或从未构建过），不算故障。
    """
    backend = __version__
    info = read()
    if info is None:
        return {
            "backend": backend,
            "frontend": None,
            "consistent": False,
            "built_at": None,
            "reason": "no_dist" if not DIST_DIR.is_dir() else "no_build",
        }
    consistent = info["version"] == backend
    return {
        "backend": backend,
        "frontend": info["version"],
        "consistent": consistent,
        "built_at": info["built_at"],
        "reason": "" if consistent else "mismatch",
    }


def log_at_startup() -> None:
    """启动时查一次，不一致就留下一条说明白的告警。

    只在启动时记一次而不是每次请求：这是**部署状态**，不是运行时故障，日志里重复
    几百遍只会把人淹掉。持续性的提示交给接口和界面（见 ``PanelUpdateCard``）。
    """
    state = status()
    if state["consistent"]:
        logger.info("前端构建产物 v%s，与后端一致", state["frontend"])
        return
    if state["reason"] == "no_dist":
        # 没有 dist 是正常情况：开发时前端由 Vite 开发服务器提供，后端只出 API。
        # 报成告警会让每次本地起后端都刷一条吓人的日志。
        logger.info("未找到前端构建产物 dist/，本服务只提供 API")
        return
    if state["reason"] == "no_build":
        logger.warning(
            "前端构建产物没有版本标记（dist/build-info.json）：它可能是旧版本构建的，"
            "界面与后端不一定配套。执行 npm run build 即可带上标记。"
        )
        return
    logger.warning(
        "前端构建产物与后端版本不一致：dist/ 是 v%s，后端是 v%s。"
        "界面可能缺少新功能或行为不对 —— 执行 npm install && npm run build 后重启面板。",
        state["frontend"],
        state["backend"],
    )
