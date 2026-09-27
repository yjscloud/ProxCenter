#!/usr/bin/env python3
"""校验/修复虚拟环境的解释器版本，避免「解释器与已装依赖不匹配」。

## 为什么需要这个脚本

虚拟环境不是自包含的：`lib/python3.x/site-packages` 里带二进制扩展的包
（pydantic_core、httptools、watchfiles、websockets、PyYAML、cffi 等）都是
**针对某个 Python 次版本编译**的，文件名形如
`_pydantic_core.cpython-313-x86_64-linux-gnu.so`。

如果 `.venv` 被另一个 Python 版本重新创建过（例如系统里装了 3.12，某个
`python -m venv` 用 3.12 覆盖了原先用 3.13 建的环境），那么：

- `pyvenv.cfg` 与 `bin/python` 指向新解释器（3.12）
- 但 `site-packages` 里仍然是旧版本编译的二进制（cp313）

于是启动时抛出：

    ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'

这个报错极具误导性——看上去像「依赖没装」，实际是**解释器换过**，重装依赖
也会因为用错解释器而把情况弄得更糟（装成 cp312，与 3.13 混在一起）。

本脚本比对版本，不一致时用当前解释器重新生成虚拟环境启动器
（`python -m venv <dir>` 会覆盖 `pyvenv.cfg`/`bin/python`，但**不会**清空
`site-packages`），因此已装依赖得以保留。随后做一次导入冒烟测试，把仍不可用的
依赖逐条列出来。

## 用法

    python scripts/ensure_env.py --venv /path/to/.venv

**必须用「期望作为虚拟环境基础」的那个 Python 来运行本脚本**，因为脚本以
`sys.executable` 作为修复时的基准解释器。

## 退出码

    0  解释器版本已一致（依赖可能仍待安装，交由调用方执行 pip install）
    1  无法修复（调用方应中止并提示用户）
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# 启动后端的必要依赖；缺任何一个都跑不起来。
CRITICAL_MODULES = [
    "pydantic_core",
    "pydantic",
    "pydantic_settings",
    "fastapi",
    "uvicorn",
    "httpx",
    "aiomysql",
    "pymysql",
    "jwt",
    "passlib",
    "yaml",
]


def venv_python(venv: Path) -> Path:
    """虚拟环境里的解释器路径（POSIX 布局）。"""
    return venv / "bin" / "python"


def read_cfg(venv: Path) -> dict[str, str]:
    """读取 pyvenv.cfg，返回小写键的字典。"""
    cfg = venv / "pyvenv.cfg"
    if not cfg.is_file():
        return {}
    out: dict[str, str] = {}
    for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            out[key.strip().lower()] = value.strip()
    return out


def major_minor(version: str) -> str:
    """`3.13.14` -> `3.13`；无法解析时原样返回。"""
    parts = version.split(".")
    if len(parts) >= 2 and all(p.isdigit() for p in parts[:2]):
        return f"{parts[0]}.{parts[1]}"
    return version


def probe(vpy: Path) -> str | None:
    """实际调用一次虚拟环境解释器，返回它的版本号；失败返回 None。"""
    try:
        done = subprocess.run(
            [str(vpy), "-c", "import sys; print(sys.version.split()[0])"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout.strip() or None


def create_venv(venv: Path) -> bool:
    """用基准解释器创建/重新生成虚拟环境启动器（保留 site-packages）。"""
    done = subprocess.run(
        [sys.executable, "-m", "venv", str(venv)],
        capture_output=True,
        text=True,
    )
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip()
        print(f"[env] [x] 生成虚拟环境失败：{detail}", file=sys.stderr)
        return False
    return True


def smoke_test(vpy: Path) -> list[str]:
    """逐个导入关键依赖，返回失败描述列表（空列表表示全部可用）。"""
    modules = list(CRITICAL_MODULES)
    code = (
        "import importlib\n"
        f"mods = {modules!r}\n"
        "bad = []\n"
        "for name in mods:\n"
        "    try:\n"
        "        importlib.import_module(name)\n"
        "    except Exception as exc:\n"
        "        bad.append('%s: %s: %s' % (name, exc.__class__.__name__, exc))\n"
        "print('\\n'.join(bad))\n"
    )
    try:
        done = subprocess.run(
            [str(vpy), "-c", code], capture_output=True, text=True, timeout=180
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [f"无法执行导入测试：{exc}"]
    if done.returncode != 0 and not done.stdout.strip():
        return [(done.stderr or "导入测试异常退出").strip()]
    return [line for line in done.stdout.splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description="校验并修复虚拟环境解释器版本")
    parser.add_argument("--venv", required=True, help="虚拟环境目录")
    parser.add_argument(
        "--skip-smoke", action="store_true", help="跳过依赖导入冒烟测试"
    )
    args = parser.parse_args()

    venv = Path(args.venv).resolve()
    want = major_minor(f"{sys.version_info.major}.{sys.version_info.minor}")
    want_full = (
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    )
    vpy = venv_python(venv)

    print(f"[env] [i] 基准解释器 {want_full}（{sys.executable}）")

    # --- 1. 环境不存在则创建 -------------------------------------------------
    if not vpy.is_file():
        print(f"[env] [!] 虚拟环境不存在，正在创建：{venv}")
        if not create_venv(venv):
            return 1
        vpy = venv_python(venv)

    # --- 2. 比对「配置声明的版本」与「实际解释器版本」------------------------
    declared = read_cfg(venv).get("version", "")
    actual = probe(vpy)
    mismatch = (
        major_minor(declared) != want
        or actual is None
        or major_minor(actual) != want
    )

    if mismatch:
        print(
            f"[env] [!] 解释器不匹配：pyvenv.cfg 声明「{declared or '未知'}」，"
            f"实际为「{actual or '无法执行'}」，期望「{want_full}」"
        )
        print("[env]     正在重新生成启动器（site-packages 会保留）...")
        if not create_venv(venv):
            return 1
        actual = probe(venv_python(venv))
        if actual is None or major_minor(actual) != want:
            print(
                f"[env] [x] 修复后仍为「{actual or '无法执行'}」。"
                f"请手动删除 {venv} 后重新运行启动脚本。",
                file=sys.stderr,
            )
            return 1
        print(f"[env] [i] 已修复为 {actual}")
    else:
        print(f"[env] [i] 解释器版本一致：{actual}")

    # --- 3. 依赖冒烟测试 -----------------------------------------------------
    if args.skip_smoke:
        return 0

    broken = smoke_test(venv_python(venv))
    if broken:
        # 不视为致命错误：调用方紧接着会执行 pip install。
        # 但把话说清楚，免得又出现「找不到 _pydantic_core」这种误导性报错。
        print(f"[env] [!] {len(broken)} 个依赖当前不可用，接下来安装依赖时会被修复：")
        for line in broken:
            print(f"[env]     - {line}")
    else:
        print("[env] [i] 关键依赖导入正常")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
