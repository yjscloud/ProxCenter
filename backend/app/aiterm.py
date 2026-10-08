"""AI 排查助手的远程终端：把受管主机的 SSH 交互会话桥接到浏览器。

它解决的是这个页面上最要紧的一个疑问 ——「AI 到底在我机器上干了什么」。
左边的终端有两个用途，共用同一个窗口：

1. **用户自己敲**：浏览器里的 xterm.js ↔ WebSocket ↔ paramiko 的交互式 shell，
   就是一个网页版 SSH 客户端。日常巡检、临时看个日志，不用再开本地终端。
2. **AI 的执行实况**：AI 在这一轮里跑的每条命令（只读的自动执行、写命令的
   「用户批准后执行」）连同输出都由 :func:`mirror_command` 写进同一个窗口。
   用户不是看一段「执行中…」的转圈，而是看着命令一行行跑出来。

两者**不是同一个 shell 会话**：AI 的命令走 :mod:`app.sshremote` 的独立连接
（复用已验证的指纹策略、也不会被用户当前的工作目录影响）。刻意如此 ——
让模型往一个用户正在敲的交互式 shell 里打字，会把两边的工作目录、环境变量、
正在跑的前台任务搅在一起，既不可预期也难以审计。终端在这里的角色是
「实况窗口」：谁执行的、执行了什么、输出是什么，一目了然。

线程模型
--------
paramiko 是阻塞的，而这里跑在 asyncio 事件循环里。读方向由一个守护线程
``recv`` 阻塞读，再用 ``call_soon_threadsafe`` 把数据丢进 asyncio 队列；
写方向走 ``asyncio.to_thread``。注册表只在事件循环线程里读写，所以不加锁。
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

from . import i18n, sshremote

logger = logging.getLogger(__name__)

# 终端最长存活时间：开着的终端就是一条挂着的 SSH 连接，不能无限期留着。
MAX_LIFETIME = 2 * 3600.0
# 空闲上限：浏览器关了 / 断网了，服务端不会立刻知道，靠这个兜底回收。
IDLE_TIMEOUT = 30 * 60.0

# 单次从 SSH 通道读多少字节。太小会让高频输出（tail -f）把事件循环刷爆。
READ_CHUNK = 16384

# ANSI 序列：AI 的执行实况要一眼能从用户自己的输入里区分出来
_RESET = "\x1b[0m"
_BOLD = "\x1b[1m"
_CYAN = "\x1b[36m"
_GREEN = "\x1b[32m"
_RED = "\x1b[31m"
_YELLOW = "\x1b[33m"

# 推给前端的消息类型
_OUTPUT = "output"
# 会话结束（远端断开 / 超时）：前端据此提示「连接已断开」，并停止输入。
# 导出给路由层用，避免两边各写一个字符串字面量后对不上。
EXIT_EVENT = "exit"
_EXIT = EXIT_EVENT


class TerminalSession:
    """一条已建立的浏览器 ↔ 受管主机终端会话。"""

    def __init__(
        self,
        *,
        username: str,
        host_id: str,
        host_name: str,
        client: Any,
        channel: Any,
        loop: asyncio.AbstractEventLoop,
        cols: int,
        rows: int,
    ) -> None:
        self.id = uuid.uuid4().hex
        self.username = str(username or "")
        self.host_id = str(host_id or "")
        self.host_name = str(host_name or host_id or "")
        self.client = client
        self.channel = channel
        self.loop = loop
        self.cols = int(cols or 80)
        self.rows = int(rows or 24)
        self.opened = time.time()
        self.last_active = time.time()
        # 出方向：会话产出的文本（含 AI 镜像）都从这里出去，由 WS 的泵任务取走
        self.out: "asyncio.Queue[Optional[Dict[str, Any]]]" = asyncio.Queue()
        self._closed = False
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------ 出方向
    def _put(self, event: Dict[str, Any]) -> None:
        if self._closed:
            return
        try:
            self.out.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover - 队列无上限，理论到不了
            logger.warning("AI 终端输出队列已满，丢弃一段输出")

    def feed(self, text: str) -> None:
        """把一段终端输出推给浏览器。"""
        if text:
            self._put({"type": _OUTPUT, "data": text})

    def notice(self, text: str, *, color: str = _CYAN) -> None:
        """推一行带颜色的提示（AI 命令的起止、连接信息、错误归因）。"""
        self.feed(f"\r\n{color}{crlf(text)}{_RESET}\r\n")

    # ------------------------------------------------------------ 生命周期
    def touch(self) -> None:
        self.last_active = time.time()

    def expired(self) -> bool:
        now = time.time()
        return (now - self.opened) > MAX_LIFETIME or (now - self.last_active) > IDLE_TIMEOUT

    async def write(self, data: str) -> None:
        """把用户按键送进远端 shell。"""
        if self._closed or not data:
            return
        self.touch()
        await asyncio.to_thread(self.channel.sendall, data)

    async def resize(self, cols: int, rows: int) -> None:
        """跟随浏览器里的终端尺寸变化，远端才知道该按多少列折行。"""
        if self._closed:
            return
        self.cols = max(1, int(cols or self.cols))
        self.rows = max(1, int(rows or self.rows))
        try:
            await asyncio.to_thread(
                self.channel.resize_pty, width=self.cols, height=self.rows
            )
        except Exception:  # noqa: BLE001 - 远端不支持 resize 不该中断会话
            logger.debug("终端 resize 失败", exc_info=True)

    def start_reader(self) -> None:
        """起一个守护线程把远端输出泵进事件循环。"""

        def _pump() -> None:
            try:
                while True:
                    data = self.channel.recv(READ_CHUNK)
                    if not data:
                        break
                    try:
                        self.loop.call_soon_threadsafe(
                            self.feed, data.decode("utf-8", "replace")
                        )
                    except RuntimeError:  # 事件循环已关（服务在退出）
                        break
            except Exception as exc:  # noqa: BLE001 - 断链是常态，不是异常
                if not self._closed:
                    logger.debug("终端读线程结束：%s", exc)
            finally:
                self._finish_from_thread()

        self._thread = threading.Thread(
            target=_pump, name=f"aiterm-{self.id[:8]}", daemon=True
        )
        self._thread.start()

    def _finish_from_thread(self) -> None:
        try:
            self.loop.call_soon_threadsafe(self._finish)
        except RuntimeError:
            pass

    def _finish(self) -> None:
        """远端断开：通知前端并让 WS 收尾。幂等。"""
        if self._closed:
            return
        self._closed = True
        self._put({"type": _EXIT})

    def finish(self) -> None:
        """让 WS 那边收尾（远端 EOF / 空闲超时 / 生命周期到顶共用）。"""
        self._finish()

    def close(self) -> None:
        """本地主动断开（用户关页面 / 服务重启）。幂等。"""
        self._closed = True
        try:
            self.channel.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.client.close()
        except Exception:  # noqa: BLE001
            pass


# ------------------------------------------------------------------ 注册表
# 只在事件循环线程里读写（开 / 关 / 镜像都在异步路径上），所以不加锁。
_sessions: Dict[str, TerminalSession] = {}
# (username, host_id) → 该用户在这台主机上打开的终端集合。
# 同一个人开两个标签页是常事，AI 的命令要同时镜像到两个窗口，所以用集合。
_index: Dict[Tuple[str, str], Set[str]] = {}


def _key(username: str, host_id: str) -> Tuple[str, str]:
    return (str(username or ""), str(host_id or ""))


def _register(session: TerminalSession) -> None:
    _sessions[session.id] = session
    _index.setdefault(_key(session.username, session.host_id), set()).add(session.id)


def _unregister(session: TerminalSession) -> None:
    _sessions.pop(session.id, None)
    bucket = _index.get(_key(session.username, session.host_id))
    if bucket is not None:
        bucket.discard(session.id)
        if not bucket:
            _index.pop(_key(session.username, session.host_id), None)


def mirror_sessions(username: str, host_id: str) -> List[TerminalSession]:
    """某用户在某主机上当前开着的终端（AI 把命令镜像到它们）。"""
    ids = _index.get(_key(username, host_id))
    if not ids:
        return []
    return [s for s in (_sessions.get(i) for i in list(ids)) if s is not None and not s._closed]


def open_count() -> int:
    """当前打开的终端数（诊断 / 测试用）。"""
    return len(_sessions)


# ------------------------------------------------------------------ 开关会话
async def open_session(
    *,
    username: str,
    host_id: str,
    row: Optional[Dict[str, Any]],
    host_name: str = "",
    cols: int = 80,
    rows: int = 24,
) -> TerminalSession:
    """连接受管主机并开一个交互式 shell。

    ``row`` 是 :func:`app.hostscope.assert_host_access` 取回的受管主机原始行
    （含加密凭据）。传进来而不是在这里取，是为了让归属校验只发生一次、
    且发生在调用方（路由层）能把它翻译成合适的关闭码的地方。
    """
    if row is None:
        raise ValueError(
            i18n.pick(
                "终端只支持 SSH 受管主机；面板本机请通过其它方式登录",
                "The terminal only supports managed SSH hosts; sign in to the panel "
                "host by other means",
            )
        )

    # 复用 sshremote 的连接逻辑：拼错的指纹在这里被拦下（TOFU），
    # 免密 sudo 之类的配置也一并对齐，不会出现「终端连得上、排查连不上」。
    loop = asyncio.get_running_loop()
    client, fingerprint = await asyncio.to_thread(sshremote._connect, row)
    try:
        channel = await asyncio.to_thread(
            client.invoke_shell,
            term="xterm-256color",
            width=max(1, int(cols or 80)),
            height=max(1, int(rows or 24)),
        )
    except Exception:
        client.close()
        raise

    session = TerminalSession(
        username=username,
        host_id=host_id,
        host_name=host_name,
        client=client,
        channel=channel,
        loop=loop,
        cols=cols,
        rows=rows,
    )
    _register(session)
    session.start_reader()
    session.notice(
        i18n.pick(
            f"已连接到 {session.host_name}（{fingerprint}）。"
            "AI 在这一轮里执行的命令也会显示在这个窗口里。",
            f"Connected to {session.host_name} ({fingerprint}). Commands the AI runs "
            "during this turn will also show up in this window.",
        )
    )
    logger.info(
        "AI 终端已打开：user=%s host=%s session=%s",
        username,
        host_name or host_id,
        session.id,
    )
    return session


def close_session(session: TerminalSession) -> None:
    _unregister(session)
    session.close()
    logger.info("AI 终端已关闭：user=%s host=%s", session.username, session.host_id)


async def close_all() -> None:
    """服务退出时统一收口（app 的 lifespan 调）。"""
    for session in list(_sessions.values()):
        close_session(session)


# ------------------------------------------------------------------ AI 镜像
def crlf(text: str) -> str:
    r"""把裸 LF 补成 CRLF，供**注入**终端的文本用。

    为什么需要：用户自己敲命令那条路走的是 PTY，内核的 ONLCR 会把 ``\n``
    翻成 ``\r\n``；而 AI 的命令走 :func:`app.sshremote.run_command` 的 ``exec``，
    拿回来的是**裸 LF**。终端只把 LF 理解成「下移一行」，**不回车到行首** ——
    于是每一行都接着上一行末尾继续画，``df -h`` 那种对齐表格会错成阶梯状。

    刻意**不动**单独的 ``\r``：那是 ``curl`` / ``apt`` 这类进度条用来「原地
    重画当前行」的，改成 CRLF 会把一次进度条炸成几百行。保持原样，覆盖重画才是
    终端该有的行为。

    只在注入路径上用（:func:`mirror_command` / :meth:`TerminalSession.notice`），
    **不能**放进 :meth:`TerminalSession.feed` —— 那里也流着 PTY 的原始输出，
    而一次 ``read`` 完全可能把 ``\r\n`` 从中间劈成两半，逐块转换会凭空多出空行。
    """
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def mirror_command(
    username: str,
    host_id: str,
    command: str,
    ok: bool,
    output: str = "",
) -> None:
    """把 AI 执行的一条命令及其输出写进该用户在这台主机上打开的终端。

    没有打开的终端就是一次空操作 —— 用户没在看的时候，前端本来也收不到东西，
    这里不落任何状态（审计另有 ``ai_tool_calls`` 表负责）。

    刻意**只读注册表、只入队**：它会被 AI 的工具循环在每步调用，任何耗时或
    异常都会拖慢整轮排查，所以这里不做 IO、也不抛异常。
    """
    try:
        sessions = mirror_sessions(username, host_id)
        if not sessions:
            return
        status = f"{_GREEN}✓{_RESET}" if ok else f"{_RED}✕{_RESET}"
        body = (command or "").strip()
        header = f"{_CYAN}{_BOLD}AI{_RESET}{_CYAN} $ {body}{_RESET}"
        text = f"\r\n{header}\r\n"
        if output:
            # AI 的命令走 exec（不是 PTY），拿回来的是裸 LF —— 必须自己补成 CRLF，
            # 否则终端里每一行都接着上一行末尾继续画，表格会错成阶梯（见 crlf）。
            # 末尾再补一个换行，免得下一段提示黏在最后一行上。
            text += crlf(output).rstrip("\r\n") + "\r\n"
        text += f"{status} {_CYAN}{i18n.pick('AI 命令结束', 'AI command finished')}{_RESET}\r\n"
        for session in sessions:
            session.feed(text)
    except Exception:  # noqa: BLE001 - 镜像永远不该影响排查本身
        logger.debug("AI 终端镜像失败", exc_info=True)


def mirror_notice(username: str, host_id: str, text: str, *, color: str = _CYAN) -> None:
    """把一行非命令类的提示写进终端（例如「等待用户批准写命令」）。"""
    try:
        for session in mirror_sessions(username, host_id):
            session.notice(text, color=color)
    except Exception:  # noqa: BLE001
        logger.debug("AI 终端提示写入失败", exc_info=True)


def mirror_approval_wait(username: str, host_id: str, command: str, purpose: str) -> None:
    """提示「AI 提议了一条写命令，正在等用户批准」。

    用黄色而不是普通的青色：这一步停在**等用户拍板**，不是后台在跑 ——
    终端里要一眼看出「现在轮到我了」，否则用户会以为命令卡住了。
    """
    body = (purpose or "").strip()
    command_text = (command or "").strip()
    text = i18n.pick(
        "等待你批准后执行",
        "Waiting for your approval to run",
    )
    mirror_notice(
        username,
        host_id,
        f"⏸ {text}：{command_text}" + (f"（{body}）" if body else ""),
        color=_YELLOW,
    )
