"""控制台文件中转（VNC 里「上传文件」的后端）。

为什么不是直接往客户机里写
--------------------------
PVE 的 API 没有「把文件塞进正在运行的虚拟机 / 容器」这种通用能力：
虚拟机要靠 Guest Agent（只暴露 exec / 文件读写的一部分，且要求客户机装好
agent 与网络），容器要靠宿主机 SSH 上的 ``pct push``（面板不一定配了 SSH）。
VNC 协议本身也只同步剪贴板文本，不传文件。

所以这里做的是**中转**：浏览器把文件传到面板，得到一枚一次性（限时）
下载地址；用户把面板生成的 ``curl`` / ``Invoke-WebRequest`` 命令粘进客户机
控制台，由客户机自己把文件拉回去。这样：
  * 不依赖 Guest Agent / SSH / PVE 版本；
  * 对虚拟机、容器、乃至控制台里跑的任何系统都成立；
  * 代价是客户机要能访问到面板地址（生成命令时用的是「面板对外地址」，
    见 :mod:`app.panel_url`，因此内网客户机也能拿到正确域名）。

存储与生命周期
--------------
文件落在 ``DATA_DIR/console-files``，盘上形如 ``<token>.bin`` + ``<token>.json``。
token 是 32 位十六进制（128 bit 随机），下载接口不要求登录 —— 它本来就要被
客户机（没有面板凭据）拉取，token 就是「能力凭据」。因此：

  * 有有效期（默认 24 小时），过期即删；
  * 下载地址不可枚举（128 bit 随机），也拿不到上传者之外的任何信息；
  * 每次上传都会顺带清理一遍过期文件，不需要额外的定时任务。
"""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import UploadFile

from .config import DATA_DIR

#: 中转文件目录。与数据库同盘，但单独一个子目录，方便运维整体清理。
STORE_DIR = DATA_DIR / "console-files"

#: token 只接受我们自己生成的形态。下载接口拿它直接拼盘上路径，必须严格校验
#: （否则 ``..`` 之类会变成路径穿越）。
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")

#: 单个文件上限。中转是为了「把脚本 / 配置 / 补丁带进去」这类场景，
#: 不是网盘；太大既占面板磁盘，也常被反代的 client_max_body_size 挡掉。
MAX_BYTES = 1024 * 1024 * 1024  # 1 GiB

#: 下载链接有效期（秒）。太短来不及在客户机里操作，太长等于在面板上留文件。
TTL_SECONDS = 24 * 3600

_CHUNK = 1024 * 1024
_NAME_MAX = 120


class FileTooLarge(Exception):
    """上传超过 :data:`MAX_BYTES`。"""


def clean_filename(raw: Optional[str]) -> str:
    """把浏览器给的文件名收敛成一个安全的「展示名」。

    只做展示与 ``Content-Disposition`` 用，不参与拼路径（盘上是 token），
    但仍要去掉路径分隔符与控制字符：Windows 上传的浏览器有时会带
    ``C:\\fakepath\\``，名称里的换行则会破坏生成的 shell 命令。
    """
    name = str(raw or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable())
    # 只去掉**尾部**的点与空格（Windows 不允许以它们结尾）；开头的点要留着，
    # 否则 `.env`、`.bashrc` 这类上传会被改名成 `env`、`bashrc`。
    name = name.strip().rstrip(". ")
    if not name:
        name = "download.bin"
    if len(name) > _NAME_MAX:
        # 保留扩展名（下载 / 双击时用得上），把主名截短到总长不超限
        suffix = Path(name).suffix[:16]
        stem = Path(name).stem[: max(1, _NAME_MAX - len(suffix))]
        name = f"{stem}{suffix}"
    return name


def _dir() -> Path:
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    return STORE_DIR


def _meta_path(token: str) -> Path:
    return _dir() / f"{token}.json"


def file_path(token: str) -> Path:
    return _dir() / f"{token}.bin"


def _write_meta(meta: Dict[str, Any]) -> None:
    _meta_path(meta["token"]).write_text(
        json.dumps(meta, ensure_ascii=False), encoding="utf-8"
    )


def _drop(token: str) -> None:
    """删除一个中转文件（元数据 + 内容），不存在就忽略。"""
    for path in (_meta_path(token), file_path(token)):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def purge_expired(now: Optional[float] = None) -> int:
    """清掉已过期的中转文件，返回删除的条数。"""
    moment = time.time() if now is None else now
    removed = 0
    try:
        entries = list(_dir().glob("*.json"))
    except OSError:
        return 0
    for meta_file in entries:
        token = meta_file.stem
        if not TOKEN_RE.match(token):
            continue
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            expires = float(meta.get("expires_at") or 0)
        except (OSError, ValueError):
            expires = 0
        if expires <= moment:
            _drop(token)
            removed += 1

    # 元数据之外的残留（写完盘、还没来得及落元数据就被杀掉）：留一小时再清，
    # 避免把「正在上传」的半成品当成垃圾。
    try:
        leftovers = list(_dir().glob("*.bin")) + list(_dir().glob("*.part"))
    except OSError:
        leftovers = []
    cutoff = moment - 3600
    for path in leftovers:
        token = path.stem
        if not TOKEN_RE.match(token) or _meta_path(token).exists():
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            pass
    return removed


async def save(upload: UploadFile, username: str = "") -> Dict[str, Any]:
    """把上传内容流式写盘，返回可直接回给前端的元数据。

    刻意不 ``await upload.read()`` 一次性读完：几百 MB 的文件那样会整块进内存。
    """
    token = secrets.token_hex(16)
    target = file_path(token)
    part = target.with_suffix(".part")
    name = clean_filename(upload.filename)
    size = 0

    try:
        with part.open("wb") as fh:
            while True:
                chunk = await upload.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise FileTooLarge()
                await asyncio.to_thread(fh.write, chunk)
        await asyncio.to_thread(part.replace, target)
    except BaseException:
        # 失败 / 超限 / 客户端断开：别在盘上留半截文件
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    now = time.time()
    meta: Dict[str, Any] = {
        "token": token,
        "name": name,
        "size": size,
        "created_at": now,
        "expires_at": now + TTL_SECONDS,
        "uploader": username or "",
    }
    await asyncio.to_thread(_write_meta, meta)
    # 上传是最自然的清理时机：没有额外的后台任务，也不会拖慢下载
    await asyncio.to_thread(purge_expired)
    return meta


async def load(token: str) -> Optional[Tuple[Path, Dict[str, Any]]]:
    """按 token 取文件；不存在 / 已过期 / token 非法一律返回 ``None``。"""
    if not TOKEN_RE.match(token or ""):
        return None
    path = file_path(token)
    try:
        meta = json.loads(_meta_path(token).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        expires = float(meta.get("expires_at") or 0)
    except (TypeError, ValueError):
        expires = 0
    if expires <= time.time() or not await asyncio.to_thread(path.exists):
        await asyncio.to_thread(_drop, token)
        return None
    return path, meta


async def revoke(token: str) -> bool:
    """手动作废一个下载链接。"""
    if not TOKEN_RE.match(token or ""):
        return False
    found = await load(token)
    if found is None:
        return False
    await asyncio.to_thread(_drop, token)
    return True
