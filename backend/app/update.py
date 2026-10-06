"""面板自身的版本检查与在线更新。

两件事以前都不存在，所以这里从零建立：

1. **版本从哪来** —— 面板版本以前硬编码在 5 处（``package.json``、
   ``app/__init__.py``、``main.py``、``routers/config.py``、``routers/dashboard.py``），
   连「有没有新版本」都无从谈起。现在统一以 :data:`app.__version__` 为唯一来源，
   发布信息取自 GitHub Releases（仓库公开，不需要 token；默认 24 小时查一次，
   远低于未鉴权接口 60 次/小时的限额）。

2. **更新能不能做** —— 取决于**部署形态**，而不是取决于我们想不想。容器里的那份
   面板无法给自己换镜像；git 工作区 + systemd 托管的那份可以，但前提是：工作区干净、
   进程真的归 systemd 管、有 root 权限。判错一次的代价是把面板停在一个起不来的版本上，
   或者「重启了另一个进程、代码根本没换」—— 后者实测踩过：手工 ``python run.py``
   起的实例占着 8080，systemd 那个每 5 秒重启一次，日志里全是 address already in use。

   所以判定（:func:`deployment`）与执行（:func:`apply_update`）都集中在这个模块里，
   路由层只负责鉴权、转述与审计。
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import __version__, i18n, notifications, store

logger = logging.getLogger(__name__)

# 面板安装目录：``backend/app/update.py`` 往上三层
ROOT = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------- 版本与接口
#: GitHub 仓库（`owner/name`）。可在设置里改成自己的 fork —— 换掉它等于换掉
#: 「面板会去哪里取代码」，所以接口层对这一项要求二次确认。
DEFAULT_REPO = "yjscloud/ProxCenter"
REPO_KEY = "update_repo"                 # settings KV：仓库 slug
STATE_KEY = "update_state"               # settings KV：最近一次检查结果（JSON）
AUTO_KEY = "update_auto_check"           # settings KV："0" / "1"
SKIPPED_KEY = "update_skipped_version"   # settings KV：用户选择「跳过这个版本」

#: 自动检查间隔（秒）。Release 不会一天变两次，24 小时足够。
CHECK_INTERVAL = 24 * 3600
#: 启动后第一次检查的延迟：先让面板自己跑稳（连 PVE、建表、调度器起来）。
FIRST_DELAY = 15 * 60
#: 手动检查的最小间隔：连点按钮不该把 GitHub 限额打光。
MANUAL_COOLDOWN = 60
#: 「更新中」超过这个时长仍未换版本，就当这次更新失败了（部署脚本卡住、网络断等）。
APPLYING_TIMEOUT = 30 * 60
#: 出网超时。GitHub 在国外，但只取一个小 JSON，15 秒足够。
TIMEOUT = httpx.Timeout(15.0, connect=8.0)

LOG_DIR = ROOT / "logs"
#: 允许出现在版本标识里的字符。它会被拼进 shell 脚本，所以这里必须保守 ——
#: 虽然来源是 GitHub 的 tag，但「上游返回什么就原样拼进脚本」是典型的注入口子。
_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")


class UpdateError(RuntimeError):
    """可以直接展示给用户的更新相关错误。"""


# ------------------------------------------------------------------ 版本比较
_VERSION_RE = re.compile(r"(\d+)")
#: 预发布 / 构建元数据的起点：``0.1.4-rc1`` 的主段只到 ``-`` 之前
_PRE_RE = re.compile(r"[-+~]")


def parse_version(text: Any) -> Tuple[int, ...]:
    """把 ``v0.1.4`` / ``0.1.4-rc1`` 这类标识拆成可比较的数字元组。

    只取**主版本段**的数字：预发布后缀（``-rc1``/``-beta3``）整段丢掉 —— 面板只发
    正式版，而把 rc 里的数字也算进来（``0.1.4-rc1`` → ``(0,1,4,1)``）会让它比
    ``0.1.4`` 还大，正在用正式版的人于是收到莫名其妙的升级提示。
    解析不出数字时返回空元组（调用方据此判定「不可比」）。
    """
    main = _PRE_RE.split(str(text or "").strip().lstrip("vV"), 1)[0]
    numbers = _VERSION_RE.findall(main)
    if not numbers:
        return ()
    return tuple(int(n) for n in numbers[:4])


def is_newer(candidate: Any, current: Any) -> bool:
    """``candidate`` 是否比 ``current`` 新（按段比较，缺位补 0）。"""
    new, old = parse_version(candidate), parse_version(current)
    if not new or not old:
        return False
    size = max(len(new), len(old))
    return new + (0,) * (size - len(new)) > old + (0,) * (size - len(old))


# ------------------------------------------------------------------ 取发布信息
async def fetch_latest(
    repo: str, *, transport: Optional[httpx.AsyncBaseTransport] = None
) -> Dict[str, Any]:
    """取仓库的最新正式 release。

    ``transport`` 只为测试而留（注入 ``httpx.MockTransport``），生产走默认。
    """
    slug = str(repo or DEFAULT_REPO).strip() or DEFAULT_REPO
    if not re.match(r"^[\w.-]+/[\w.-]+$", slug):
        raise UpdateError(i18n.pick("仓库地址不合法，应形如 owner/name", "Invalid repository, expected owner/name"))
    url = f"https://api.github.com/repos/{slug}/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"ProxCenter/{__version__}",
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise UpdateError(
            i18n.pick(f"访问 GitHub 失败：{exc}", f"Could not reach GitHub: {exc}")
        ) from exc

    if response.status_code == 404:
        raise UpdateError(
            i18n.pick(
                f"仓库 {slug} 不存在，或者还没有发布过 Release（私有仓库面板取不到）。",
                f"Repository {slug} does not exist or has no release yet "
                "(a private repository cannot be read by the panel).",
            )
        )
    if response.status_code in (403, 429):
        raise UpdateError(
            i18n.pick(
                "GitHub 拒绝了这次请求（多半是未鉴权的每小时 60 次限额），稍后再试。",
                "GitHub rejected the request (usually the unauthenticated 60/hour limit); "
                "try again later.",
            )
        )
    if response.status_code >= 400:
        raise UpdateError(
            i18n.pick(
                f"GitHub 返回 HTTP {response.status_code}。",
                f"GitHub returned HTTP {response.status_code}.",
            )
        )

    try:
        data = response.json()
    except ValueError as exc:  # 非 JSON（被中间设备拦了之类）
        raise UpdateError(
            i18n.pick("GitHub 返回的不是 JSON，可能被网络中间设备拦截。",
                      "GitHub did not return JSON; a middlebox may be interfering.")
        ) from exc
    if not isinstance(data, dict):
        raise UpdateError(i18n.pick("GitHub 返回格式异常。", "Unexpected response from GitHub."))

    tag = str(data.get("tag_name") or "").strip()
    version = tag.lstrip("vV").strip() or str(data.get("name") or "").strip()
    if not version:
        raise UpdateError(
            i18n.pick("这个 Release 没有版本号，无法比较。", "This release has no version tag.")
        )
    return {
        "tag": tag or f"v{version}",
        "version": version,
        "name": str(data.get("name") or ""),
        "notes": str(data.get("body") or ""),
        "url": str(data.get("html_url") or ""),
        "published_at": str(data.get("published_at") or ""),
        "prerelease": bool(data.get("prerelease")),
    }


# ------------------------------------------------------------------ 设置与状态
async def get_repo() -> str:
    return str(await store.get_setting(REPO_KEY, DEFAULT_REPO) or DEFAULT_REPO).strip()


async def set_repo(repo: str) -> None:
    await store.set_setting(REPO_KEY, str(repo or DEFAULT_REPO).strip())


async def auto_check() -> bool:
    """是否自动检查。默认开：检查只是每小时几十字节的请求，没理由默认关。"""
    return str(await store.get_setting(AUTO_KEY, "1") or "1") != "0"


async def set_auto_check(enabled: bool) -> None:
    await store.set_setting(AUTO_KEY, "1" if enabled else "0")


async def get_skipped() -> str:
    """用户选择「跳过」的版本号（空串 = 不跳过）。"""
    return str(await store.get_setting(SKIPPED_KEY, "") or "").strip()


async def set_skipped(version: str) -> None:
    await store.set_setting(SKIPPED_KEY, str(version or "").strip())


async def load_state() -> Dict[str, Any]:
    raw = await store.get_setting(STATE_KEY, "") or ""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        # 手工改坏过就当作没检查过，不要让一个坏 JSON 把整个接口打挂
        logger.warning("update_state 不是合法 JSON，忽略")
        return {}
    return data if isinstance(data, dict) else {}


async def save_state(state: Dict[str, Any]) -> None:
    await store.set_setting(STATE_KEY, json.dumps(state, ensure_ascii=False))


# ------------------------------------------------------------------ 部署形态
def _run(cmd: List[str], cwd: Optional[Path] = None, timeout: int = 15) -> Tuple[int, str]:
    """跑一条**只读**命令。失败返回 ``(-1, 原因)``，绝不抛异常。"""
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, str(exc)
    text = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    return proc.returncode, text


def service_name() -> str:
    """当前进程所属的 systemd 服务名（非 systemd 托管时返回空串）。

    从 ``/proc/self/cgroup`` 读：systemd 会把进程放进 ``/<名字>.service`` 这个
    cgroup。比拿 ``systemctl show`` 逐个 unit 去问快得多，也不依赖单元文件的命名。
    """
    try:
        text = Path("/proc/self/cgroup").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    for line in text.splitlines():
        tail = line.rsplit("/", 1)[-1].strip()
        if tail.endswith(".service"):
            return tail
    return ""


def in_docker() -> bool:
    return Path("/.dockerenv").exists() or os.environ.get("PROXCENTER_IN_DOCKER") == "1"


def git_info(root: Path = ROOT) -> Dict[str, Any]:
    """安装目录的 git 状态（只读命令）。"""
    code, _ = _run(["git", "rev-parse", "--is-inside-work-tree"], root)
    if code != 0:
        return {"is_git": False, "root": str(root)}
    _, remote = _run(["git", "remote", "get-url", "origin"], root)
    _, branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root)
    _, head = _run(["git", "rev-parse", "--short", "HEAD"], root)
    # HEAD 不在任何 tag 上时 git 会往 stderr 写一句 fatal，这里必须按退出码丢弃它，
    # 否则界面上会显示「当前版本：fatal: no tag exactly matches …」
    tag_code, tag = _run(["git", "describe", "--tags", "--exact-match"], root)
    if tag_code != 0:
        tag = ""
    code, dirty = _run(["git", "status", "--porcelain"], root)
    files = [line for line in dirty.splitlines() if line.strip()] if code == 0 else []
    return {
        "is_git": True,
        "root": str(root),
        "remote": remote,
        "branch": branch,
        "head": head,
        "tag": tag,
        "dirty": bool(files),
        "dirty_files": len(files),
    }


def manual_commands(dep: Optional[Dict[str, Any]] = None, tag: str = "") -> List[str]:
    """该部署形态下**手工**升级的命令（在线更新不可用时给人照抄的）。"""
    dep = dep or deployment()
    target = tag or str((dep.get("git") or {}).get("latest_tag") or "")
    if dep.get("form") == "docker":
        return [
            "cd <面板的 docker-compose 目录>",
            "docker compose pull",
            "docker compose up -d",
        ]
    git = dep.get("git") or {}
    if git.get("is_git"):
        spec = target or "<新版本 tag>"
        lines = [f"cd {dep.get('root')}"]
        if git.get("dirty"):
            lines.append("# 工作区有未提交改动，先备份/提交：git stash")
        lines.append("sudo git fetch --tags --prune origin")
        lines.append(f"sudo git checkout {spec}")
        if dep.get("node"):
            # deploy.sh 是幂等的：装依赖 + 构建前端 + 重启服务，官方升级路径就是它
            lines.append("sudo ./deploy.sh")
        else:
            # 没有 Node 就构建不了前端：只换后端会让界面与后端版本不一致，
            # 所以要么装 Node，要么在别处构建 dist/ 后带 --skip-frontend 跑
            lines.append("# 本机没有 Node.js：先在装有 Node 18+ 的机器上构建前端，")
            lines.append("# 把 dist/ 拷回本目录，再执行：")
            lines.append("sudo ./deploy.sh --skip-frontend")
        return lines
    return [
        "# 源码安装：按 README 的升级步骤重新获取新版本并重跑安装脚本",
        "cd <面板目录> && git fetch --tags && git checkout <新版本 tag> && sudo ./deploy.sh",
        "# 只部署了 dist/ 的安装：下载新版产物覆盖 dist/ 后重启服务",
    ]


def deployment() -> Dict[str, Any]:
    """当前面板是「怎么装的」—— 决定更新该怎么做。全部只读判断。"""
    git = git_info()
    service = service_name()
    is_root = os.geteuid() == 0
    try:
        writable = os.access(ROOT, os.W_OK)
    except OSError:
        writable = False
    form = "docker" if in_docker() else ("git" if git.get("is_git") else "other")
    return {
        "form": form,
        "root": str(ROOT),
        "service": service,
        "managed": bool(service) and git.get("root") == str(ROOT),
        "is_root": is_root,
        "writable": writable,
        "node": shutil.which("node") is not None,
        "systemd_run": shutil.which("systemd-run") is not None,
        "git": git,
    }


def _applying_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """把「更新中」这个状态收干净。

    面板自己重启后没人会去回写结果，所以这里**惰性判定**：
    * 版本已经等于目标 tag → 成功，清掉标记并记一笔；
    * 超过 :data:`APPLYING_TIMEOUT` 还没换过来 → 视为失败（脚本卡住 / 命令报错）；
    * 其余情况照实返回，界面上显示「更新进行中」。
    """
    applying = state.get("applying")
    if not isinstance(applying, dict):
        return {}
    tag = str(applying.get("tag") or "")
    started = int(applying.get("started_at") or 0)
    done = bool(tag) and parse_version(tag) and parse_version(tag) == parse_version(__version__)
    if done:
        state["last_update"] = {
            "tag": tag,
            "ok": True,
            "at": int(time.time()),
            "log": str(applying.get("log") or ""),
        }
        state.pop("applying", None)
        return {}
    if started and time.time() - started > APPLYING_TIMEOUT:
        state["last_update"] = {
            "tag": tag,
            "ok": False,
            "at": int(time.time()),
            "log": str(applying.get("log") or ""),
        }
        state.pop("applying", None)
        return {}
    return dict(applying)


def _apply_ready(
    dep: Dict[str, Any], applying: Dict[str, Any], *, allow_dirty: bool = False
) -> Tuple[bool, str]:
    """能不能一键更新。返回 ``(可以, 不能的原因)``，原因直接展示给用户。"""
    if dep.get("form") == "docker":
        return False, i18n.pick(
            "面板跑在容器里，无法给自己换镜像 —— 请在宿主机上执行下面的 compose 命令升级。",
            "The panel runs in a container and cannot swap its own image — "
            "run the compose commands below on the host.",
        )
    git = dep.get("git") or {}
    if not git.get("is_git"):
        return False, i18n.pick(
            "这个安装目录不是 git 工作区（可能是打包产物安装的），请按下面的命令手工升级。",
            "This installation directory is not a git checkout — upgrade manually with "
            "the commands below.",
        )
    if not dep.get("managed"):
        return False, i18n.pick(
            "当前进程不是 systemd 托管的（多半是手工启动的实例）：更新脚本最后要重启服务，"
            "重启的却是另一个进程，代码不会生效。请先停掉手工实例，或按下面的命令手工升级。",
            "This process is not managed by systemd (probably started by hand); the update "
            "would restart a different process and the new code would never run. Stop the "
            "manual instance or upgrade with the commands below.",
        )
    if not dep.get("is_root"):
        return False, i18n.pick(
            "面板进程不是 root：更新要写安装目录、装依赖、重启服务。请用下面的命令手工升级。",
            "The panel process is not root; updating needs to write the install directory, "
            "install dependencies and restart the service. Upgrade with the commands below.",
        )
    if not dep.get("writable"):
        return False, i18n.pick(
            f"安装目录 {dep.get('root')} 不可写，请用下面的命令手工升级。",
            f"The install directory {dep.get('root')} is not writable; use the commands below.",
        )
    if not dep.get("node"):
        # 没有 Node 就构建不了前端。放它过去只会得到「后端换了、界面还是旧的」，
        # 而新版前端里那些新接口调用会对着一份老 dist 报错 —— 半更新比不更新更难查。
        return False, i18n.pick(
            "面板所在主机上没有 Node.js，更新时无法重新构建前端（只换后端会让界面与后端"
            "版本不一致）。请先装 Node.js 18+，或按下面的命令在别处构建 dist/ 后手工升级。",
            "No Node.js on the panel host, so the frontend cannot be rebuilt during the update "
            "(replacing only the backend would leave UI and API out of sync). Install Node.js "
            "18+ first, or build dist/ elsewhere and upgrade with the commands below.",
        )
    if not str(git.get("remote") or "").strip():
        return False, i18n.pick(
            "这个 git 工作区没有配置 origin 远端，无法拉取新版本。",
            "This git checkout has no origin remote, so the new version cannot be fetched.",
        )
    if git.get("dirty") and not allow_dirty:
        return False, i18n.pick(
            f"工作区有 {git.get('dirty_files')} 处未提交改动，更新会覆盖它们。"
            "请先提交/备份，或确认可以丢弃后再试。",
            f"The work tree has {git.get('dirty_files')} uncommitted change(s) that the update "
            "would overwrite. Commit or back them up first.",
        )
    if applying:
        return False, i18n.pick(
            f"已经有一次更新在进行了（目标 {applying.get('tag')}），请等它结束。",
            f"An update is already running (target {applying.get('tag')}); wait for it to finish.",
        )
    return True, ""


def _script_text(dep: Dict[str, Any], tag: str, log: Path) -> str:
    """生成更新脚本。

    刻意做成**独立进程**：脚本最后要 ``systemctl restart`` 面板自己，若在面板进程里
    执行，最后一步会把自己杀掉、脚本也一起没了 —— 前端可能还没构建完，面板就停在
    半新半旧的状态。所以走 ``systemd-run``（或 setsid）脱离当前进程，日志落文件。
    """
    root = dep.get("root") or str(ROOT)
    service = str(dep.get("service") or "proxcenter")
    pip = str(ROOT / ".venv" / "bin" / "pip")
    return f"""#!/usr/bin/env bash
# 由 ProxCenter 生成：把面板从 {__version__} 更新到 {tag}。
# 每一步都显式判断退出码（不用 set -e）：失败时要把原因留在日志里，而不是静默退出。
set -uo pipefail
exec >>"{log}" 2>&1
echo "[$(date -Is)] 更新开始：{__version__} → {tag}"
cd "{root}" || {{ echo "安装目录不存在"; exit 1; }}

if ! git fetch --tags --prune origin; then echo "git fetch 失败（网络或凭据问题），放弃更新"; exit 1; fi
if ! git rev-parse --verify --quiet "{tag}^{{commit}}" >/dev/null; then echo "远端找不到 {tag}，放弃更新"; exit 1; fi
if ! git checkout --force "{tag}"; then echo "切到 {tag} 失败，放弃更新"; exit 1; fi
echo "[$(date -Is)] 代码已切到 {tag}（commit $(git rev-parse --short HEAD)）"

echo "[$(date -Is)] 开始按官方脚本重装：{pip} + 前端构建 + 重启 {service}"
if ! ./deploy.sh --service "{service}"; then
  echo "[$(date -Is)] deploy.sh 失败。面板可能仍停在旧版本（服务未重启）；"
  echo "            修好上面的报错后手工重跑：cd {root} && sudo ./deploy.sh"
  exit 1
fi
echo "[$(date -Is)] 更新完成，当前版本：$(git describe --tags 2>/dev/null || git rev-parse --short HEAD)"
echo "[$(date -Is)] 本脚本日志：{log}"
"""


async def apply_update(tag: str, *, allow_dirty: bool = False) -> Dict[str, Any]:
    """把面板更新到 ``tag``：写脚本 → 脱离当前进程启动 → 记状态。"""
    state = await load_state()
    dep = deployment()
    latest = state.get("latest") if isinstance(state.get("latest"), dict) else {}
    target = str(tag or (latest or {}).get("tag") or "").strip()
    if not target:
        raise UpdateError(
            i18n.pick("还没有可更新的版本，请先检查一次。", "Nothing to update to — check first.")
        )
    if not _TAG_RE.match(target):
        raise UpdateError(
            i18n.pick(f"版本标识不合法：{target}", f"Invalid version identifier: {target}")
        )
    applying = _applying_state(state)
    ready, reason = _apply_ready(dep, applying, allow_dirty=allow_dirty)
    if not ready:
        raise UpdateError(reason)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log = LOG_DIR / f"update-{stamp}.log"
    script = LOG_DIR / f"update-{stamp}.sh"
    try:
        script.write_text(_script_text(dep, target, log), encoding="utf-8")
        script.chmod(0o700)
    except OSError as exc:
        raise UpdateError(
            i18n.pick(f"写更新脚本失败：{exc}", f"Could not write the update script: {exc}")
        ) from exc

    if dep.get("systemd_run"):
        # --collect：跑完自动回收，不在系统里留一堆一次性 unit
        cmd = [
            "systemd-run",
            f"--unit=proxcenter-update-{stamp}",
            "--collect",
            "--description=ProxCenter 面板更新",
            "/bin/bash",
            str(script),
        ]
        code, out = _run(cmd, ROOT, timeout=20)
        if code != 0:
            raise UpdateError(
                i18n.pick(f"启动更新任务失败：{out}", f"Could not start the update job: {out}")
            )
    else:
        # 保底：setsid 让它脱离当前进程组，面板重启不会把它带走
        cmd = ["setsid", "nohup", "/bin/bash", str(script)]
        try:
            subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise UpdateError(
                i18n.pick(f"启动更新任务失败：{exc}", f"Could not start the update job: {exc}")
            ) from exc

    state["applying"] = {
        "tag": target,
        "started_at": int(time.time()),
        "log": str(log),
        "from": __version__,
    }
    await save_state(state)
    logger.info("面板更新已启动：%s → %s（日志 %s）", __version__, target, log)
    return {
        "started": True,
        "tag": target,
        "log": str(log),
        "script": str(script),
        "command": " ".join(cmd),
        "current": __version__,
    }


# ------------------------------------------------------------------ 提醒
async def _notify_targets() -> List[str]:
    """该提醒谁：有「设置管理」权限的在用账号 —— 更新是管理员的事。"""
    from . import security  # 延迟导入，避免与 security → store 的初始化顺序纠缠

    targets: List[str] = []
    try:
        users = await store.list_users()
    except Exception:  # noqa: BLE001 - 取不到用户列表不该让整次检查失败
        logger.warning("取用户列表失败，本次不发更新提醒", exc_info=True)
        return targets
    for user in users or []:
        if not user.get("enabled", True):
            continue
        if str(user.get("status") or "active") != "active":
            continue
        perms = user.get("permissions")
        if isinstance(perms, list) and perms:
            allowed = "settings.manage" in perms
        else:
            allowed = security.has_permission(str(user.get("role") or ""), "settings.manage")
        name = str(user.get("username") or "").strip()
        if allowed and name:
            targets.append(name)
    return targets


async def _announce(state: Dict[str, Any], release: Dict[str, Any]) -> None:
    """发现新版本 → 给管理员发站内消息（同一个版本只发一次）。"""
    version = str(release.get("version") or "")
    if not version or state.get("notified") == version:
        return
    title = i18n.pick(f"面板有新版本 v{version}", f"Panel update v{version} is available")
    notes = str(release.get("notes") or "").strip()
    if len(notes) > 600:
        notes = notes[:600] + "…"
    body = i18n.pick(
        f"当前版本 {__version__}，最新版本 {version}。\n"
        "可以在「设置 → 面板更新」里一键更新，也可以按提示手工升级。"
        + (f"\n\n更新说明：\n{notes}" if notes else ""),
        f"Running {__version__}, latest is {version}.\n"
        "Update with one click under Settings → Panel update, or follow the manual steps."
        + (f"\n\nRelease notes:\n{notes}" if notes else ""),
    )
    for username in await _notify_targets():
        try:
            await notifications.push(
                username,
                title=title,
                body=body,
                link="/settings",
                kind="update",
                level="info",
            )
        except Exception:  # noqa: BLE001 - 单个用户写失败不影响别人
            logger.warning("给 %s 发更新提醒失败", username, exc_info=True)
    state["notified"] = version


# ------------------------------------------------------------------ 对外状态
async def status(known: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """界面要的全部信息：版本、检查结果、能否一键更新、手工命令。"""
    state = known if isinstance(known, dict) else await load_state()
    applying = _applying_state(state)
    dep = deployment()
    latest = state.get("latest") if isinstance(state.get("latest"), dict) else {}
    version = str(latest.get("version") or "")
    skipped = await get_skipped()
    available = bool(version) and is_newer(version, __version__) and version != skipped
    ready, reason = _apply_ready(dep, applying)
    if not ready and applying:
        # 「更新中」不是错误：按钮置灰的原因要能区分开
        reason = i18n.pick("正在更新中，请等面板重启。", "An update is in progress; wait for the restart.")
    if ready and not available:
        ready, reason = False, i18n.pick("当前已是最新版本。", "Already up to date.")
    manual = manual_commands(dep, str(latest.get("tag") or ""))
    # 落库一次：上面可能刚把「更新中」判定成成功/失败，让下次读到的就是干净的
    if known is None:
        await save_state(state)
    return {
        "current": __version__,
        "latest": version,
        "tag": str(latest.get("tag") or ""),
        "release_name": str(latest.get("name") or ""),
        "notes": str(latest.get("notes") or ""),
        "release_url": str(latest.get("url") or ""),
        "published_at": str(latest.get("published_at") or ""),
        "checked_at": int(state.get("checked_at") or 0),
        "update_available": available,
        "skipped": skipped,
        "auto_check": await auto_check(),
        "repo": await get_repo(),
        "error": str(state.get("error") or ""),
        "applying": applying,
        "last_update": state.get("last_update") if isinstance(state.get("last_update"), dict) else {},
        "can_apply": ready,
        "reason": reason,
        "deployment": {
            "form": dep.get("form"),
            "root": dep.get("root"),
            "service": dep.get("service"),
            "managed": dep.get("managed"),
            "is_root": dep.get("is_root"),
            "git": dep.get("git"),
        },
        "manual": manual,
    }


async def check(*, force: bool = False) -> Dict[str, Any]:
    """查一次最新版本并落库。

    失败**不抛异常**（网络、限额、被墙都算常态）：错误写进 ``state["error"]``，
    界面照常显示当前版本与上次检查时间 —— 让一次 404 把定时作业打成红色错误，
    比不检查更没用。手动检查时 :data:`MANUAL_COOLDOWN` 内不重复打 GitHub。
    """
    state = await load_state()
    now = int(time.time())
    last = int(state.get("checked_at") or 0)
    if not force and last and now - last < MANUAL_COOLDOWN:
        return await status(state)
    state["checked_at"] = now
    try:
        release = await fetch_latest(await get_repo())
    except UpdateError as exc:
        state["error"] = str(exc)
        await save_state(state)
        logger.warning("检查面板新版本失败：%s", exc)
        return await status(state)
    state["error"] = ""
    state["latest"] = release
    skipped = await get_skipped()
    if is_newer(release.get("version"), __version__) and release.get("version") != skipped:
        await _announce(state, release)
    await save_state(state)
    return await status(state)


async def run_check() -> List[str]:
    """调度作业入口。返回发现的新版本（空列表 = 无事发生，正好喂给调度器摘要）。"""
    if not await auto_check():
        return []
    result = await check(force=True)
    if result.get("update_available"):
        return [str(result.get("latest") or "")]
    return []
