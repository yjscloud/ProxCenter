"""内网穿透（frp 客户端）管理：配置、进程启停、状态与日志。"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from . import store
from .config import DATA_DIR

SETTING_KEY = "frp_config"
# 「进程停了自动拉起」开关。与配置分开存：配置是「连去哪」，这是「要不要一直跑」。
AUTOSTART_KEY = "frp_auto_restart"

# 连续拉起失败时的退避间隔（秒）。配置填错 / 服务端不通时不退避的话，
# 每 60 秒拉一次又崩一次，日志会被刷爆、真正的报错反而被淹掉。
_RETRY_DELAYS = [60.0, 120.0, 300.0, 600.0, 900.0]

_failures = 0
_next_attempt_at = 0.0

DEFAULT_CONFIG: Dict[str, Any] = {
    "server_addr": "",
    "server_port": 7000,
    "token": "",
    "proxies": [],
}

BIN_DIR = DATA_DIR / "frp"
CONFIG_PATH = BIN_DIR / "frpc.toml"
LOG_PATH = BIN_DIR / "frpc.log"
PID_PATH = BIN_DIR / "frpc.pid"

FRP_VERSION = "0.61.1"
DOWNLOAD_URL = (
    "https://github.com/fatedier/frp/releases/download/"
    f"v{FRP_VERSION}/frp_{FRP_VERSION}_linux_amd64.tar.gz"
)

_process: Optional[subprocess.Popen] = None


def _port(value: Any, default: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return default
    return num if 1 <= num <= 65535 else default


def _normalise_proxy(raw: Any) -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    name = str(item.get('name') or 'proxy').strip().replace(' ', '_')
    return {
        'name': name or 'proxy',
        'type': 'tcp',
        'local_ip': str(item.get('local_ip') or '127.0.0.1').strip(),
        'local_port': _port(item.get('local_port'), 80),
        'remote_port': _port(item.get('remote_port'), 10000),
    }


def normalise(raw: Any) -> Dict[str, Any]:
    cfg: Dict[str, Any] = dict(DEFAULT_CONFIG)
    if not isinstance(raw, dict):
        return cfg
    cfg['server_addr'] = str(raw.get('server_addr') or '').strip()
    cfg['server_port'] = _port(raw.get('server_port'), 7000)
    cfg['token'] = str(raw.get('token') or '')
    proxies = raw.get('proxies')
    cfg['proxies'] = [_normalise_proxy(p) for p in proxies] if isinstance(proxies, list) else []
    return cfg


def render_toml(cfg: Dict[str, Any]) -> str:
    """把面板配置渲染成 frpc.toml。"""
    lines: List[str] = [
        'serverAddr = ' + json.dumps(cfg['server_addr']),
        'serverPort = ' + str(cfg['server_port']),
        'auth.method = "token"',
        'auth.token = ' + json.dumps(cfg['token']),
        'log.level = "info"',
        'log.to = ' + json.dumps(str(LOG_PATH)),
        'log.maxDays = 3',
    ]
    for item in cfg['proxies']:
        lines.extend([
            '',
            '[[proxies]]',
            'name = ' + json.dumps(item['name']),
            'type = ' + json.dumps(item['type']),
            'localIP = ' + json.dumps(item['local_ip']),
            'localPort = ' + str(item['local_port']),
            'remotePort = ' + str(item['remote_port']),
        ])
    return chr(10).join(lines) + chr(10)


# ---------------------------------------------------------------------------
# 服务端配置与穿透规则分离
#
# 服务端（server_addr / server_port / token、启停与安装）属于基础设施，
# 只有管理员能改；穿透规则则是「每个人把自己的服务暴露出去」，按用户隔离。
# 但 frpc 只有一个进程、一份配置文件，所以运行时用的是两者合并后的结果。
# ---------------------------------------------------------------------------
SERVER_KEY = "frp_server"
RULES_KEY = "frp_rules"
LEGACY_KEY = "frp_config"

DEFAULT_SERVER: Dict[str, Any] = {"server_addr": "", "server_port": 7000, "token": ""}


def normalise_server(raw: Any) -> Dict[str, Any]:
    cfg: Dict[str, Any] = dict(DEFAULT_SERVER)
    if not isinstance(raw, dict):
        return cfg
    cfg["server_addr"] = str(raw.get("server_addr") or "").strip()
    cfg["server_port"] = _port(raw.get("server_port"), 7000)
    cfg["token"] = str(raw.get("token") or "")
    return cfg


def normalise_rule(raw: Any, username: str = "") -> Dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    return {
        "id": str(item.get("id") or uuid.uuid4().hex[:12]),
        "username": str(item.get("username") or username or "").strip(),
        "name": str(item.get("name") or "proxy").strip().replace(" ", "_") or "proxy",
        "type": "tcp",
        "local_ip": str(item.get("local_ip") or "127.0.0.1").strip(),
        "local_port": _port(item.get("local_port"), 80),
        "remote_port": _port(item.get("remote_port"), 10000),
    }


def normalise_rules(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [normalise_rule(r) for r in raw]


async def load_server() -> Dict[str, Any]:
    raw = await store.get_setting(SERVER_KEY)
    if not raw:
        return normalise_server(None)
    try:
        return normalise_server(json.loads(raw))
    except ValueError:
        return normalise_server(None)


async def save_server(cfg: Dict[str, Any]) -> Dict[str, Any]:
    cleaned = normalise_server(cfg)
    await store.set_setting(SERVER_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


async def load_rules() -> List[Dict[str, Any]]:
    raw = await store.get_setting(RULES_KEY)
    if not raw:
        return []
    try:
        return normalise_rules(json.loads(raw))
    except ValueError:
        return []


async def save_rules(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned = normalise_rules(rules)
    await store.set_setting(RULES_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


async def migrate_legacy() -> None:
    """把旧的单一 frp_config 拆成服务端配置 + 规则（仅执行一次）。

    旧规则没有归属，交给管理员（username 留空即视为无主，只有管理员可见可改）。
    """
    if await store.get_setting(SERVER_KEY) or await store.get_setting(RULES_KEY):
        return
    raw = await store.get_setting(LEGACY_KEY)
    if not raw:
        return
    try:
        old = normalise(json.loads(raw))
    except ValueError:
        return
    await save_server(
        {
            "server_addr": old.get("server_addr", ""),
            "server_port": old.get("server_port", 7000),
            "token": old.get("token", ""),
        }
    )
    await save_rules([normalise_rule(p) for p in old.get("proxies", [])])


def effective_config(
    server: Dict[str, Any], rules: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """合并成 frpc 实际使用的配置（服务端 + 所有人的规则）。"""
    return {
        "server_addr": server.get("server_addr", ""),
        "server_port": server.get("server_port", 7000),
        "token": server.get("token", ""),
        "proxies": [
            {
                "name": r["name"],
                "type": r["type"],
                "local_ip": r["local_ip"],
                "local_port": r["local_port"],
                "remote_port": r["remote_port"],
            }
            for r in rules
        ],
    }


async def effective() -> Dict[str, Any]:
    await migrate_legacy()
    return effective_config(await load_server(), await load_rules())


class FrpError(RuntimeError):
    """frp 操作失败，带可直接展示给用户的中文说明。"""


def frpc_binary() -> Optional[str]:
    """优先使用面板自带（data/frp/frpc）的二进制，其次回退到系统 PATH。"""
    local = BIN_DIR / 'frpc'
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    return shutil.which('frpc')


def read_logs(limit: int = 200) -> List[str]:
    if not LOG_PATH.is_file():
        return []
    try:
        text = LOG_PATH.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []
    return text.splitlines()[-limit:]


def _pid() -> Optional[int]:
    if not PID_PATH.is_file():
        return None
    try:
        return int(PID_PATH.read_text(encoding='utf-8').strip())
    except (OSError, ValueError):
        return None


def _alive(pid: int) -> bool:
    """这个 pid 是不是还活着，**而且确实是 frpc**。

    只看 ``os.kill(pid, 0)`` 有两个坑，都会让「自动拉起」形同虚设：

    * **僵尸进程**：frpc 是本进程 Popen 出来的子进程，它退出后没人 wait，
      会一直以僵尸形态挂着 —— ``os.kill`` 对僵尸照样返回成功，于是界面显示
      「运行中」，可穿透其实早就断了；
    * **PID 复用**：面板重启后 PID 文件里那个号可能已经被系统分给别的进程。

    僵尸的 ``/proc/<pid>/cmdline`` 是空的，被复用的进程则不是 frpc —— 核一下
    命令行这两个坑一起填掉。
    """
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        cmdline = Path("/proc").joinpath(str(pid), "cmdline").read_bytes()
    except OSError:
        return True  # 读不到（不是 Linux / 没权限）：退回只判存活
    return b"frpc" in cmdline


def is_running() -> bool:
    pid = _pid()
    return bool(pid and _alive(pid))


def _reap() -> None:
    """收掉我们自己拉起过的那个子进程（如果有）。

    frpc 退出后会变成僵尸等父进程来收；不收的话 ``os.kill`` 仍认为它活着，
    看护就永远不会去拉起 —— 所以每次判断是否要拉起之前先收一次。
    """
    global _process
    if _process is None:
        return
    try:
        _process.poll()  # 已退出则顺带回收，未退出则只是查状态
        if _process.poll() is not None:
            _process = None
    except Exception:  # noqa: BLE001 - 回收失败不影响后续判断
        _process = None


def _log(line: str) -> None:
    """往 frpc 日志里补一行。

    自动拉起的痕迹要能在「日志」页看到：否则用户只看到进程在跑，不知道它
    崩过、又被谁拉起来了 —— 而「为什么断了又好了」正是要排查的东西。
    """
    try:
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "ab") as log:
            log.write(f"{stamp} [看护] {line}\n".encode("utf-8"))
    except OSError:
        pass


async def auto_restart_enabled() -> bool:
    """「停止后自动拉起」开关。存 settings，所以面板重启后依然记得。"""
    raw = await store.get_setting(AUTOSTART_KEY)
    return str(raw or "").strip() in ("1", "true", "yes", "on")


async def set_auto_restart(enabled: bool) -> bool:
    await store.set_setting(AUTOSTART_KEY, "1" if enabled else "0")
    return enabled


async def watchdog() -> Dict[str, Any]:
    """看护一轮：开关开着、而 frpc 不在，就重新拉起。

    返回值交给调度器做摘要（界面上看得到这一轮干了什么）。失败按
    :data:`_RETRY_DELAYS` 逐步退避；异常照抛，调度器会把作业标成 error，
    别把「一直在崩」伪装成正常运行。
    """
    global _failures, _next_attempt_at

    if not await auto_restart_enabled():
        _failures = 0
        _next_attempt_at = 0.0
        return {"action": "skipped"}

    _reap()  # 先把可能已经变成僵尸的旧进程收掉，否则永远判定成「还在跑」
    if is_running():
        _failures = 0
        _next_attempt_at = 0.0
        return {"action": "running"}

    now = time.time()
    if now < _next_attempt_at:
        return {"action": "backoff", "failures": _failures}

    cfg = await effective()
    try:
        # start() 里有写配置、Popen 和 1.5 秒的探活等待 —— 放进线程执行，
        # 别把事件循环里其它作业一起堵住。
        await asyncio.to_thread(start, cfg)
    except FrpError as exc:
        _failures += 1
        _next_attempt_at = (
            now + _RETRY_DELAYS[min(_failures - 1, len(_RETRY_DELAYS) - 1)]
        )
        _log(f"自动拉起失败（第 {_failures} 次）：{exc}")
        raise
    _log("检测到 frpc 已停止，已自动拉起")
    _failures = 0
    _next_attempt_at = 0.0
    return {"action": "restarted"}


def start(cfg: Dict[str, Any]) -> None:
    """写出 frpc.toml 并拉起 frpc 进程。"""
    global _process
    binary = frpc_binary()
    if not binary:
        raise FrpError('未找到 frpc 可执行文件，请先点击「下载安装 frpc」。')
    if not cfg.get('server_addr'):
        raise FrpError('请先填写 frps 服务端地址。')
    if not cfg.get('proxies'):
        raise FrpError('请至少添加一条穿透规则。')
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(render_toml(cfg), encoding='utf-8')
    _reap()  # 收掉上一轮的僵尸，否则 is_running() 会把它当成还活着
    if is_running():
        stop()
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    header = chr(10) + '=== 启动 ' + stamp + ' ===' + chr(10)
    with open(LOG_PATH, 'ab') as log:
        log.write(header.encode('utf-8'))
        proc = subprocess.Popen(
            [binary, '-c', str(CONFIG_PATH)],
            stdout=log,
            stderr=log,
            cwd=str(BIN_DIR),
        )
    PID_PATH.write_text(str(proc.pid), encoding='utf-8')
    _process = proc  # 记下来：将来它退出时要靠 _reap() 回收（否则变僵尸）
    time.sleep(1.5)
    if proc.poll() is not None:
        PID_PATH.unlink(missing_ok=True)
        detail = '；'.join(read_logs(4)) or '未知原因'
        raise FrpError('frpc 启动失败：' + detail)


def stop() -> None:
    """优雅停止 frpc，超时后强杀。"""
    pid = _pid()
    if pid and _alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(20):
            if not _alive(pid):
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    PID_PATH.unlink(missing_ok=True)


def status(cfg: Dict[str, Any]) -> Dict[str, Any]:
    binary = frpc_binary()
    return {
        'running': is_running(),
        'available': bool(binary),
        'binary': binary or '',
        'server_addr': cfg.get('server_addr', ''),
        'server_port': cfg.get('server_port', 7000),
        'proxy_count': len(cfg.get('proxies', [])),
    }


async def install() -> str:
    """从 GitHub 下载 frp 发行包，仅取出 frpc 二进制。"""
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / 'frp.tar.gz'
        try:
            async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
                resp = await client.get(DOWNLOAD_URL)
        except httpx.HTTPError as exc:
            raise FrpError('下载失败，请检查服务器外网连通性：' + str(exc)) from exc
        if resp.status_code != 200:
            raise FrpError('下载失败（HTTP ' + str(resp.status_code) + '）。')
        archive.write_bytes(resp.content)
        with tarfile.open(archive, 'r:gz') as tar:
            member = next(
                (m for m in tar.getmembers() if m.name.endswith('/frpc') and m.isfile()),
                None,
            )
            if member is None:
                raise FrpError('发行包中未找到 frpc 二进制。')
            tar.extract(member, path=tmp)
            target = BIN_DIR / 'frpc'
            shutil.copyfile(Path(tmp) / member.name, target)
            target.chmod(0o755)
    return str(BIN_DIR / 'frpc')
