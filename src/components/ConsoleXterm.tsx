/* ==========================================================================
   ProxCenter — 终端控制台（xterm.js + PVE termproxy）

   为什么还要一条终端通道：VNC 画出来的是一帧位图 —— 文本选不中、不能回滚看历史、
   不能搜索，剪贴板还要靠 RFB 的 CutText（客户机常常没实现）。容器的控制台本来
   就是 tty，虚拟机也支持 serial0，把它们交给终端才是对的模型：选中/复制/粘贴/
   滚动/改字号全是 xterm 自带能力，长输出也不会撑爆画面。

   PVE 的 termproxy 协议（照 PVE 前端 ``/xtermjs/main.js``，不能想当然）：
     * WS 打开后**第一件事是发一行** ``<user>:<ticket>\n`` 完成鉴权。少了这一行，
       对面不会分配 pty，也不会回任何字节 —— 界面上就是「已连接但一片空白」；
     * 服务端首帧是二进制，前两个字节为 ``OK``，其后可能已经跟着首屏输出；
     * 之后服务端发的是**裸字节**（没有 tag 包装），直接喂给 xterm；
     * 客户端输入包成 ``0:<UTF-8 字节数>:<data>``，尺寸变化是 ``1:<cols>:<rows>:``，
       另外每 30 秒发一个 ``2`` 保活（PVE 自己的实现就是这样）。

   xterm 与它的样式按需加载：只有真的切到终端模式才付这份体积。
   ========================================================================== */

import { useEffect, useMemo, useRef } from 'react';
import { guestsApi } from '../api/guests';
import { errorMessage } from '../api/client';
import type { GuestType } from '../api/types';
import { useT } from '../i18n';

type TermModule = typeof import('@xterm/xterm');
type FitModule = typeof import('@xterm/addon-fit');

/** 与 ConsoleTab 共用的连接状态集合（VNC / 终端同一套徽章） */
export type ConsoleConnState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

/**
 * 终端会话对外暴露的能力。
 *
 * 与 VNC 的 handle 刻意保持同形：外层（剪贴板面板 / 快捷键）不需要知道下面
 * 是位图还是字符流。
 */
export interface ConsoleTermHandle {
  /** 把文本送进客户机（终端里等价于一次粘贴，整段发送） */
  pasteText: (text: string) => void;
  /**
   * 兼容 VNC 的「逐字符键入」接口。
   *
   * 终端不需要逐字符：整段发过去就是一次粘贴，由行规程处理。这里仍返回同样的
   * 结构，避免调用方为了两种模式各写一套。
   */
  typeText: (text: string) => Promise<{ typed: number; skipped: number }>;
}

interface ConsoleXtermProps {
  node: string;
  vmid: number;
  guestType: GuestType;
  onStateChange: (s: ConsoleConnState) => void;
  onError: (msg: string | null) => void;
  onReady?: (handle: ConsoleTermHandle | null) => void;
}

/* 深色终端配色：终端默认长相就是深底，浅色面板里反而更易读 */
const TERMINAL_THEME = {
  background: '#0f1419',
  foreground: '#d6deeb',
  cursor: '#7dd3fc',
  selectionBackground: 'rgba(125, 211, 252, 0.28)',
  black: '#1b2430',
  red: '#f07178',
  green: '#7ec699',
  yellow: '#f2c97d',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#7dd3fc',
  white: '#d6deeb',
  brightBlack: '#5c6773',
  brightRed: '#ff9cac',
  brightGreen: '#a5e6a5',
  brightYellow: '#ffd479',
  brightBlue: '#a5c8ff',
  brightMagenta: '#e2b8ff',
  brightCyan: '#a5e8ff',
  brightWhite: '#ffffff',
};

export function ConsoleXterm({
  node,
  vmid,
  guestType,
  onStateChange,
  onError,
  onReady,
}: ConsoleXtermProps) {
  const t = useT();
  const guest = useMemo(
    () => ({ node, vmid, type: guestType }),
    [node, vmid, guestType],
  );
  /* 舞台容器由本组件自己渲染。
     之前是复用外层 VncConsole 的 stageRef —— 但那个 div 是 VncConsole 渲染的，
     终端模式下它压根不存在，containerRef.current 恒为 null，于是连票据都没申请
     就报「容器尚未就绪」，界面上就是一片空白。 */
  const hostRef = useRef<HTMLDivElement>(null);
  /* onStateChange / onError / onReady 是父组件每次渲染新建的函数：
     放进依赖数组会让每次父渲染都重连一次控制台，所以用 ref 拿最新的。 */
  const cbRef = useRef({ onStateChange, onError, onReady });
  cbRef.current = { onStateChange, onError, onReady };

  useEffect(() => {
    let disposed = false;
    let term: InstanceType<TermModule['Terminal']> | null = null;
    let fit: InstanceType<FitModule['FitAddon']> | null = null;
    let ws: WebSocket | null = null;
    let observer: ResizeObserver | null = null;
    let raf = 0;
    /* PVE 握手完成前，输入与尺寸都不能发：此时 pty 还没挂上来 */
    let ready = false;
    let pingTimer = 0;

    const setState = (s: ConsoleConnState) => {
      if (!disposed) cbRef.current.onStateChange(s);
    };
    const fail = (msg: string) => {
      if (disposed) return;
      cbRef.current.onError(msg);
      cbRef.current.onStateChange('error');
    };

    async function connect() {
      setState('connecting');
      cbRef.current.onError(null);

      const container = hostRef.current;
      if (!container) {
        fail(t('console.stageNotReady'));
        return;
      }

      /* 1. 申请 termproxy 票据（容器 = tty，虚拟机 = serial0） */
      let proxy;
      try {
        proxy = await guestsApi.xtermProxy(guest);
      } catch (err) {
        if (disposed) return;
        const raw = errorMessage(err);
        /* PVE 对「虚拟机没有串口」的原话只有一句 serial0 does not exist，对用户
           没有任何指导意义 —— 补一句该怎么办 */
        if (guestType !== 'lxc' && /serial/i.test(raw)) {
          fail(`${raw} ${t('console.termSerialHint')}`);
        } else {
          fail(raw);
        }
        return;
      }
      if (disposed) return;

      /* 2. 按需加载 xterm（样式一起） */
      let xtermMod: TermModule;
      let fitMod: FitModule;
      try {
        const [loadedXterm, loadedFit] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/xterm/css/xterm.css'),
        ]);
        xtermMod = loadedXterm;
        fitMod = loadedFit;
      } catch {
        fail(t('console.termLibFailed'));
        return;
      }
      if (disposed) return;

      container.innerHTML = '';
      term = new xtermMod.Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        scrollback: 5000,
        theme: TERMINAL_THEME,
        // 允许程序用 OSC 52 写浏览器剪贴板（vim/tmux 里 y 复制）
        allowProposedApi: true,
      });
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        /* 容器尚未量出尺寸时 fit 会抛，下一帧 ResizeObserver 会补 */
      }

      const encoder = new TextEncoder();
      const send = (payload: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
      };
      /* 长度必须是**字节**数：PVE 按这个数字切包，中文一个字 3 字节，
         用 data.length 会让远端把多字节字符切成两半。 */
      const sendData = (text: string) =>
        send(`0:${encoder.encode(text).length}:${text}`);

      /* 3. 本地输入 -> 远端：tag=0；尺寸变化 -> tag=1 */
      term.onData((data) => {
        if (ready) sendData(data);
      });
      term.onResize(({ cols, rows }) => {
        if (ready) send(`1:${cols}:${rows}:`);
      });

      /* 4. 连接代理 WS（Cookie 里带登录态，ticket 是 PVE 的一次性凭据） */
      ws = new WebSocket(guestsApi.xtermWsUrl(guest, proxy.port, proxy.ticket));

      ws.onopen = () => {
        if (disposed || !term) return;
        /* PVE 只认这一行：``<user>:<ticket>`` + 换行。user 必须与 ticket 里
           打包的账号一致，所以用 termproxy 回给我们的那个，而不是面板用户名 */
        send(`${proxy.user || ''}:${proxy.ticket}\n`);
      };

      /* 服务端首帧 ``OK`` + 首屏输出；之后全是裸字节 */
      const handleChunk = (first: Uint8Array) => {
        if (!term) return;
        let bytes = first;
        if (!ready) {
          const ok = bytes.length >= 2 && bytes[0] === 0x4f && bytes[1] === 0x4b; // "OK"
          if (!ok) {
            /* 不是 OK：PVE 拒了这个会话，交给 onclose 走错误分支 */
            try {
              ws?.close();
            } catch {
              /* 忽略 */
            }
            return;
          }
          ready = true;
          setState('connected');
          bytes = bytes.subarray(2);
          try {
            fit?.fit();
          } catch {
            /* 容器尚未量出尺寸时忽略 */
          }
          send(`1:${term.cols}:${term.rows}:`);
          term.focus();
          pingTimer = window.setInterval(() => send('2'), 30_000);
        }
        if (bytes.length) term.write(bytes);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleChunk(encoder.encode(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buf) => {
            if (!disposed) handleChunk(new Uint8Array(buf));
          });
        } else if (event.data instanceof ArrayBuffer) {
          handleChunk(new Uint8Array(event.data));
        }
      };

      ws.onclose = (event) => {
        ready = false;
        window.clearInterval(pingTimer);
        if (disposed) return;
        if (event.wasClean) {
          setState('disconnected');
        } else {
          cbRef.current.onError(t('console.proxyInterrupted'));
          setState('error');
        }
      };

      ws.onerror = () => {
        /* 具体原因由 onclose 统一给（error 事件本身不带信息） */
      };

      /* 5. 跟随容器尺寸：全屏、侧栏折叠、窗口缩放都要重新量 */
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          try {
            fit?.fit();
          } catch {
            /* 忽略 */
          }
        });
      });
      observer.observe(container);

      cbRef.current.onReady?.({
        pasteText: (text: string) => {
          if (!text || !ready) return;
          sendData(text);
          term?.focus();
        },
        typeText: async (text: string) => {
          if (!text || !ready) return { typed: 0, skipped: 0 };
          sendData(text);
          term?.focus();
          return { typed: text.length, skipped: 0 };
        },
      });
    }

    void connect();

    return () => {
      disposed = true;
      ready = false;
      window.clearInterval(pingTimer);
      cancelAnimationFrame(raf);
      cbRef.current.onReady?.(null);
      observer?.disconnect();
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
      try {
        term?.dispose();
      } catch {
        /* 忽略 */
      }
      term = null;
      fit = null;
      ws = null;
    };
    /* guest 变了就重连；t 只用于文案，值稳定不放进依赖 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest]);

  /* 终端自己就是舞台：xterm 的 canvas 直接铺在这个 div 里 */
  return <div className="console-stage console-term-stage" ref={hostRef} />;
}
