"""内网穿透（frp 客户端）管理：配置、进程启停、状态与日志。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import ownership, store
from .config import DATA_DIR

logger = logging.getLogger(__name__)

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

DEFAULT_SERVER: Dict[str, Any] = {
    "server_addr": "",
    "server_port": 7000,
    "public_addr": "",
    "token": "",
}


def normalise_public_addr(raw: Any) -> str:
    """「对外访问地址」：用户拼 ``地址:公网端口`` 时看到的那一段。

    允许域名 / IP；顺手去掉误粘进来的 ``http(s)://`` 与前后的路径、空白 ——
    ``https://frp.example.com/`` 与 ``frp.example.com`` 是同一个地址，没必要
    让管理员为此吃一次报错。IPv6 可以带方括号（拼端口时正是这个形状）。
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    for prefix in ("https://", "http://"):
        if lowered.startswith(prefix):
            text = text[len(prefix):]
            break
    text = text.split("/", 1)[0].strip()
    if any(ch.isspace() for ch in text) or "," in text:
        return ""
    # 带端口的写法（frp.example.com:7000）没有意义：用户端口来自 remote_port，
    # 拼进去只会变成 host:7000:40000。裸 IPv6（多个冒号、无方括号）不动它。
    if text.count(":") == 1 and not text.startswith("["):
        host, _, tail = text.rpartition(":")
        if host and tail.isdigit():
            text = host
    return text[:255]


def normalise_server(raw: Any) -> Dict[str, Any]:
    cfg: Dict[str, Any] = dict(DEFAULT_SERVER)
    if not isinstance(raw, dict):
        return cfg
    cfg["server_addr"] = str(raw.get("server_addr") or "").strip()
    cfg["server_port"] = _port(raw.get("server_port"), 7000)
    cfg["public_addr"] = normalise_public_addr(raw.get("public_addr"))
    cfg["token"] = str(raw.get("token") or "")
    return cfg


def normalise_guest_ref(raw: Any) -> str:
    """规则关联的客户机 ref（``<连接>:<节点>:<vmid>``）；认不出来就是空串。

    为什么存它：规则的目标合法性只在**写入时**校验过一次（见 :mod:`app.frpguard`），
    客户机改派之后那条隧道就成了一条「前主人仍能访问的通道」。记下它指向哪台机器，
    之后只读本地归属表就能判断这条规则该不该继续生效（见 :func:`annotate_rules`），
    不必再问 PVE —— PVE 抖动不该让所有隧道一起断。
    """
    text = str(raw or "").strip()
    parts = text.rsplit(":", 2)
    if len(parts) != 3:
        return ""
    connection, node, vmid = parts
    if not node or not vmid.isdigit():
        return ""
    return f"{connection or '-'}:{node}:{vmid}"


def normalise_rule(raw: Any, username: str = "") -> Dict[str, Any]:
    """把一条规则规整成落库形状（**只用于存储层，不用于校验请求**）。

    这里的默认值是为「读旧数据 / 迁移旧配置」服务的：历史上规则是裸 JSON，
    字段可能缺失。接口侧必须先用 ``schemas.FrpRuleIn`` / ``FrpRuleUpdateIn``
    校验（字段全必填），再把明确的值交进来 —— 否则一个 ``{}`` 就会被这里填成
    ``127.0.0.1:80 -> 10000`` 并直接落库（V2-01 的一半）。

    ``guest_ref`` 是后加的**关联线索**（不是鉴权字段本身）：老规则没有它，
    读出来是空串，表现为「未关联」，既不会被误停，也不会被误放行。
    """
    item = raw if isinstance(raw, dict) else {}
    return {
        "id": str(item.get("id") or uuid.uuid4().hex[:12]),
        "username": str(item.get("username") or username or "").strip(),
        "name": str(item.get("name") or "proxy").strip().replace(" ", "_") or "proxy",
        "type": "tcp",
        "local_ip": str(item.get("local_ip") or "127.0.0.1").strip(),
        "local_port": _port(item.get("local_port"), 80),
        "remote_port": _port(item.get("remote_port"), 10000),
        "guest_ref": normalise_guest_ref(item.get("guest_ref")),
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


async def drop_rules_of(username: str) -> int:
    """删掉某个账号名下的全部穿透规则，返回删除条数（删号时调用）。

    与告警规则的处理刻意不同：告警规则**转无主**保命（监控不能出现真空），
    穿透规则**直接删掉**。原因是它是一条活的网络通道 —— 账号都没了，还留着一条
    从公网指向内网某个地址的转发，只会是负担：没人能解释它为什么存在，也没人会
    去关它。而规则指向的目标是否还属于这个账号，本就不是规则自己能保证的
    （写入时校验过一次，之后客户机可能已经改派）。

    只改存储里的规则表：已经渲染出去的 frpc 配置要等下一次重载才少掉这条代理，
    与「手工删除一条规则」的现有行为一致（路由层也不在这里重启 frpc）。
    """
    name = str(username or "").strip()
    if not name:
        return 0
    rules = await load_rules()
    kept = [rule for rule in rules if str(rule.get("username") or "") != name]
    if len(kept) == len(rules):
        return 0
    await save_rules(kept)
    return len(rules) - len(kept)


# ---------------------------------------------------------------------------
# 用户授权：管理员额外放行某些目标的 IP / 网段
#
# 存储形状 ``{"alice": ["10.0.0.50", "10.0.0.0/24"], ...}``。它只影响
# 「能不能把某个地址作为 local_ip 建规则」，不改变虚机 / 容器的归属，也不
# 影响规则列表的可见性（规则仍然按 username 隔离）。
# ---------------------------------------------------------------------------
GRANTS_KEY = "frp_grants"


def normalise_grants(raw: Any) -> Dict[str, List[str]]:
    """去空、去重、保序；结构不对就当没配（宁可少放行，不能多放）。"""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, List[str]] = {}
    for username, entries in raw.items():
        name = str(username or "").strip()
        if not name:
            continue
        values = entries if isinstance(entries, list) else [entries]
        cleaned: List[str] = []
        for value in values:
            text = str(value or "").strip()
            if text and text not in cleaned:
                cleaned.append(text)
        if cleaned:
            out[name] = cleaned
    return out


async def load_grants() -> Dict[str, List[str]]:
    raw = await store.get_setting(GRANTS_KEY)
    if not raw:
        return {}
    try:
        return normalise_grants(json.loads(raw))
    except ValueError:
        return {}


async def save_grants(grants: Dict[str, List[str]]) -> Dict[str, List[str]]:
    cleaned = normalise_grants(grants)
    await store.set_setting(GRANTS_KEY, json.dumps(cleaned, ensure_ascii=False))
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


# ------------------------------------------------- 规则与「当前归属」的对齐
def rule_guest_parts(ref: Any) -> Optional[Tuple[str, str, str]]:
    """把 ``guest_ref`` 拆成 ``(连接, 节点, vmid)``；认不出来返回 ``None``。"""
    text = normalise_guest_ref(ref)
    if not text:
        return None
    connection, node, vmid = text.rsplit(":", 2)
    return ("" if connection == "-" else connection, node, vmid)


async def annotate_rules(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """给规则标注 ``stale`` / ``stale_reason``：目标机器是否仍归规则作者。

    判定完全基于**本地归属表**（:mod:`app.ownership`），不问 PVE：

      * 规则没有 ``guest_ref``（存量规则，或管理员指向白名单之外的地址）→ 不判断；
      * 目标机器仍归规则作者 → 有效；
      * 已改派给别人 → 失效，原因里写明现在归谁；
      * 机器已无归属（被删、被收回、对账清过）→ 失效。

    失效的规则**不删、不改归属**：它仍是作者的一条配置，只是不再参与 frpc 渲染。
    机器改派回来时它会自动恢复，也留下了「这条隧道为什么不通」的答案。
    返回新列表（每项一份拷贝），调用方可以安全地再加工。

    读不到归属表时按「全部失效」处理（fail-closed）：宁可让隧道断，也不能因为
    一次库抖动把一条指向别人机器的通道留在公网上。
    """
    items = list(rules or [])
    if not any(normalise_guest_ref(r.get("guest_ref")) for r in items):
        return [dict(r) for r in items]
    try:
        owners = await ownership.guest_owners_map()
    except Exception:  # noqa: BLE001 - 见 docstring 的 fail-closed 说明
        logger.warning("读取归属失败：本轮把所有已关联的穿透规则按失效处理", exc_info=True)
        owners = {}

    out: List[Dict[str, Any]] = []
    for rule in items:
        item = dict(rule)
        parts = rule_guest_parts(item.get("guest_ref"))
        if parts is None:
            item["stale"] = False
            item["stale_reason"] = ""
            out.append(item)
            continue
        connection, node, vmid = parts
        current = ownership.vm_owner_from(owners, node, vmid, connection)
        owner = str(item.get("username") or "")
        # stale_owner 是给界面用的**机器可读**字段：原因文案要按用户语言渲染，
        # 而后端不该替前端决定用哪国话（stale_reason 留作日志 / 兜底展示）。
        item["stale_owner"] = current or ""
        if current == owner:
            item["stale"] = False
            item["stale_reason"] = ""
        elif not current:
            item["stale"] = True
            item["stale_reason"] = "目标机器已无归属"
        else:
            item["stale"] = True
            item["stale_reason"] = f"目标机器已改派给 {current}"
        out.append(item)
    return out


async def effective_rules() -> List[Dict[str, Any]]:
    """渲染 frpc 用的规则：已剔除失效项（见 :func:`annotate_rules`）。"""
    return [r for r in await annotate_rules(await load_rules()) if not r.get("stale")]


async def suspend_count_for_guest(ref: str, new_owner: str) -> int:
    """这台机器改派后会有几条规则因此失效（用于审计，不修改任何数据）。"""
    target = normalise_guest_ref(ref)
    if not target:
        return 0
    owner = str(new_owner or "")
    rules = await load_rules()
    return sum(
        1
        for rule in rules
        if normalise_guest_ref(rule.get("guest_ref")) == target
        and str(rule.get("username") or "") != owner
    )


async def relink_guests() -> Dict[str, Any]:
    """给尚未关联客户机的规则补上 ``guest_ref``，返回统计。

    为什么需要这个动作：``guest_ref`` 是后加的字段，升级前建的规则读出来是空串，
    也就不受改派复核保护（见 :func:`annotate_rules`）。逐条重存当然也能补上，但那
    要求每个用户自己知道这件事 —— 管理员需要一个动作把存量一次性补齐。

    只补空的，**不覆盖已有值**：已有 ``guest_ref`` 的规则要么是对的，要么已经因为
    改派被判失效；后者要改的是目标地址，不该由批量操作替用户决定。

    按用户分组解析（每人一次），避免逐条规则各查一遍 PVE；某个用户解析失败只影响
    他自己的规则，不会让整批回滚。返回 ``{"checked", "linked", "unlinked"}``，
    ``unlinked`` 里逐条列出为什么没补上，交给界面显示。
    """
    from . import frpguard  # 延迟导入：frpguard 与本模块互相引用

    rules = await load_rules()
    pending: Dict[str, List[Dict[str, Any]]] = {}
    for rule in rules:
        if normalise_guest_ref(rule.get("guest_ref")):
            continue
        name = str(rule.get("username") or "")
        if name:
            pending.setdefault(name, []).append(rule)

    linked = 0
    unlinked: List[Dict[str, Any]] = []
    for name, items in pending.items():
        try:
            targets = await frpguard.own_guest_targets(name, include_connection=True)
        except Exception:  # noqa: BLE001 - 单个人解析失败不该拖垮整批
            logger.warning("重新关联穿透规则：解析 %s 名下机器失败", name, exc_info=True)
            targets = []
        mapping = {
            str(item.get("ip") or ""): ownership.vm_ref(
                str(item.get("connection_id") or ""),
                str(item.get("node") or ""),
                item.get("vmid"),
            )
            for item in targets
            if item.get("ip")
        }
        for rule in items:
            ref = mapping.get(str(rule.get("local_ip") or "").strip(), "")
            if ref:
                rule["guest_ref"] = ref
                linked += 1
            else:
                unlinked.append(
                    {
                        "id": str(rule.get("id") or ""),
                        "name": str(rule.get("name") or ""),
                        "username": name,
                        "local_ip": str(rule.get("local_ip") or ""),
                    }
                )

    if linked:
        await save_rules(rules)
    return {
        "checked": sum(len(items) for items in pending.values()),
        "linked": linked,
        "unlinked": unlinked,
    }


async def restart_if_running() -> str:
    """规则集合变了就重启 frpc 让新配置生效；返回错误说明（空串 = 正常）。

    放在本模块而不是路由层，是为了让「归属变更」也能触发它：改派会让某些规则
    失效，不重启的话那条隧道会一直跑到下一次手工重启为止 —— 也就是这次修复
    想关掉的那个缺口。``start`` 内部有 1.5 秒同步等待，必须丢到线程里跑。
    """
    if not is_running():
        return ""
    try:
        cfg = await effective()
        await asyncio.to_thread(start, cfg)
    except FrpError as exc:
        return str(exc)
    return ""


def effective_config(
    server: Dict[str, Any], rules: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """合并成 frpc 实际使用的配置（服务端 + 所有人的规则）。

    ``stale`` 的规则一律跳过：它们的目标机器已经不属于规则作者了
    （判定见 :func:`annotate_rules`）。调用方即使传的是未过滤的列表也不会漏。
    """
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
            if not r.get("stale")
        ],
    }


async def effective() -> Dict[str, Any]:
    await migrate_legacy()
    return effective_config(await load_server(), await effective_rules())


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


def status(
    cfg: Dict[str, Any], *, include_server: bool = True
) -> Dict[str, Any]:
    """进程级状态。

    两个刻意的取舍（外部拿到它们只多一条情报，对使用毫无帮助）：

    * **不下发 ``binary``**：安装路径是面板的实现细节，谁看过一眼就知道
      这台机器上装了什么、目录怎么摆。前端只需要「装没装」→ ``available``。
    * ``include_server=False`` 时连 ``server_addr`` / ``server_port`` 也不给：
      普通用户只需要知道「在不在跑 / 有几条规则」，frps 地址是管理员那边的事。
    """
    data: Dict[str, Any] = {
        'running': is_running(),
        'available': bool(frpc_binary()),
        'proxy_count': len(cfg.get('proxies', [])),
    }
    if include_server:
        data['server_addr'] = cfg.get('server_addr', '')
        data['server_port'] = cfg.get('server_port', 7000)
    return data


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
