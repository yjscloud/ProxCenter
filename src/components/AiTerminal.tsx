/* ==========================================================================
   ProxCenter — AI 排查助手的远程终端（左侧）

   这个窗口同时服务两个用途，共用同一条后端会话：
   * 用户自己敲 —— 浏览器里的 xterm.js ↔ WebSocket ↔ 受管主机的交互式 shell；
   * AI 的执行实况 —— AI 这一轮跑的每条命令与输出都被后端镜像进来（见
     ``app/aiterm.py`` 的 mirror_command），所以「它在干什么」不用猜。

   刻意不做「AI 直接往用户正在敲的 shell 里打字」：那是两条不同来源的输入，
   混在一个 shell 里会让工作目录、环境变量、前台任务互相干扰。这里的定位是
   **实况窗口** —— 谁执行的、执行了什么、输出是什么，按发生顺序排在一起。

   xterm 及其样式**按需加载**（与 noVNC 同样的理由）：AI 助手页大多数人只是
   来看结论的，没必要为了一次可能的终端操作把终端库算进首屏体积。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { aiApi, aiTerminalWsUrl } from '../api/endpoints';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { Notice } from './ui/EmptyState';
import { IconRefresh } from './Icons';
import { useT } from '../i18n';

/**
 * 不撑满时的终端高度（兜底）。
 *
 * 控制台布局里会传 ``fill``，由 CSS 的 ``.ai-console-term``（flex:1）撑满父容器
 * 剩余高度 —— 那才是常态：终端越高越好用。这个常量只给「单独放一张终端卡片」
 * 的场景兜底。
 */
const TERM_HEIGHT = 420;

/* 深色终端配色。面板是浅色的，但深色底就是终端的默认长相，而且 AI 的彩色
   标记（青色命令 / 绿色成功 / 红色失败）在深底上对比度更好。 */
const TERMINAL_THEME = {
  background: '#0f1419',
  foreground: '#d6deeb',
  cursor: '#7dd3fc',
  cursorAccent: '#0f1419',
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

type TermStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed';

/* 动态 import 的模块类型。用 typeof import(...) 取，既拿到准确类型，
   又不会在编译产物里留下静态依赖（xterm 要留到真正开终端时再加载）。 */
type XtermModule = typeof import('@xterm/xterm');
type FitModule = typeof import('@xterm/addon-fit');

export function AiTerminal({
  hostId,
  hostName,
  /** 有没有 ai.terminal 权限（没有就说明白，不给一个敲不动还报错的窗口） */
  canUse,
  visible = true,
  fill = false,
}: {
  hostId: string;
  hostName: string;
  canUse: boolean;
  /**
   * 这个卡片当前是不是可见的。
   *
   * 父级在「终端 / 执行过程」之间切换时用 ``display:none`` 藏起另一个，
   * **两个页签始终挂载** —— 终端一卸载就等于断开 SSH，切去看一眼过程再切回来
   * 会变成一条新连接，当前目录、环境变量、跑着的进程全没了。隐藏期间容器尺寸
   * 为 0，``fit()`` 会自己跳过；重新可见时要主动对齐一次（见下面的 effect）。
   */
  visible?: boolean;
  /** 撑满父容器剩余高度（控制台布局用，见 layout.css 的 .ai-console） */
  fill?: boolean;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** fit 插件实例。用结构类型而不是 xterm 的类型：那个模块是动态加载的 */
  const fitRef = useRef<{ fit: () => void } | null>(null);
  /** 递增即重连：xterm 实例与 WebSocket 一起重建，比在旧连接上重试干净 */
  const [reconnectKey, setReconnectKey] = useState(0);
  const [status, setStatus] = useState<TermStatus>('idle');
  /** 失败原因。优先用后端在 accept 之后发来的那条具体原因（权限 / 归属 / SSH 连不上），
      拿不到时才退化成一句通用的「连接失败」—— 后者对排查没有任何帮助。 */
  const [error, setError] = useState('');
  /** 通用失败（握手就没成功，前端拿不到原因）时补一句怎么办 */
  const [errorHint, setErrorHint] = useState('');

  // 「本机」不是 SSH 受管主机，后端不开放（那等于把面板所在的那台机器交出去）
  const isLocalHost = !hostId || hostId === 'local';
  const active = canUse && !isLocalHost;

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      return;
    }
    const container = hostRef.current;
    if (!container) return;

    let disposed = false;
    /** 远端主动结束（收到 exit）时不把状态改回「意外断开」 */
    let remoteEnded = false;
    /** 已经显示过后端给的具体原因，onclose / onerror 不许再覆盖成通用的 */
    let explained = false;
    /**
     * HTTP 自检的结果，用来在 WebSocket 握手失败时把原因说准：
     *
     * * 自检**通过**了还连不上 → 后端那侧已逐条确认没问题，问题只可能在
     *   中间的反向代理上（没转发 ``Upgrade``）；
     * * 自检**接口本身**就用不了（404 = 后端还是旧版本）→ 提示去重启后端；
     * * 其余（网络抖动等）→ 给一句通用的怎么办。
     */
    let preflightOk = false;
    /** 自检请求失败的 HTTP 状态（0 = 连状态都没有，比如网络断了） */
    let preflightStatus = 0;
    let ws: WebSocket | null = null;
    /** 异步加载完模块后才知道要销毁什么，统一收在这里 */
    let teardown: (() => void) | null = null;

    setStatus('connecting');
    setError('');
    setErrorHint('');

    void (async () => {
      // 先走一次普通 HTTP 自检：WebSocket 握手失败时浏览器拿不到任何状态码，
      // 只有这条路能把「后端拒绝了什么」和「代理没转发」分开。
      //
      // 但自检是**诊断辅助、不是门槛** —— 自检接口不存在（后端还跑着旧版本，
      // 这条路由还没发布）或者网络抖了一下，都不该让终端彻底用不了：那些情况
      // 下继续去连，连不上时再把「后端可能是旧的」当成提示说出来。
      // 只有自检**明确回答「不行」**（ok=false，带具体原因）时才拦下。
      try {
        const check = await aiApi.terminalPreflight(hostId);
        if (disposed) return;
        if (!check.ok) {
          setStatus('disconnected');
          setError(check.reason || t('ai.terminalError'));
          return;
        }
        preflightOk = true;
      } catch (err) {
        if (disposed) return;
        preflightStatus =
          (err as { response?: { status?: number } })?.response?.status ?? 0;
      }

      let xtermMod: XtermModule;
      let fitMod: FitModule;
      try {
        const [loadedXterm, loadedFit] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          // 样式跟着库一起进来：首屏不可能用到，静态引入会白占一份 CSS
          import('@xterm/xterm/css/xterm.css'),
        ]);
        xtermMod = loadedXterm;
        fitMod = loadedFit;
      } catch {
        if (!disposed) {
          setStatus('disconnected');
          setError(t('ai.terminalError'));
        }
        return;
      }
      // 加载期间组件可能已被卸载 / 已切主机
      if (disposed) return;

      const { Terminal } = xtermMod;
      const { FitAddon } = fitMod;
      container.innerHTML = '';

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        scrollback: 5000,
        // AI 命令的输出由后端注入（不是 PTY 出来的），可能带裸 LF。xterm 默认把
        // LF 当成「只下移一行」，那样每一行都会接着上一行末尾继续画，`df -h` 的
        // 表格会错成阶梯。开启后 LF 等价于 CRLF —— 后端那边也会补一道，这里是兜底：
        // 用户自己敲命令那条路走 PTY（内核 ONLCR 已经翻过），不受影响。
        convertEol: true,
        theme: TERMINAL_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      fitRef.current = fit;
      term.open(container);
      try {
        fit.fit();
      } catch {
        /* 容器还没量出尺寸时 fit 会抛，下一帧 ResizeObserver 会补上 */
      }

      const send = (payload: Record<string, unknown>) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      };

      const onData = term.onData((data) => send({ type: 'input', data }));
      // 列宽变化要告诉远端：否则 vim / top 这类全屏程序会按旧尺寸画，画面错位
      const onResize = term.onResize(({ cols, rows }) =>
        send({ type: 'resize', cols, rows }),
      );

      ws = new WebSocket(aiTerminalWsUrl(hostId, term.cols, term.rows));

      ws.onopen = () => {
        if (disposed) return;
        setStatus('connected');
        // 握手时量到的尺寸可能还不是最终值（面板刚挂载），连上后再对齐一次
        try {
          fit.fit();
        } catch {
          /* 忽略 */
        }
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        let message: { type?: string; data?: string; message?: string };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'output') {
          term.write(String(message.data ?? ''));
        } else if (message.type === 'exit') {
          remoteEnded = true;
          setStatus('closed');
          term.write(`\r\n\x1b[36m[${t('ai.terminalClosed')}]\x1b[0m\r\n`);
        } else if (message.type === 'error') {
          // 后端已认证之后才失败的那一类（无权限 / 主机不属于自己 / SSH 连不上）：
          // 它在握手阶段直接关掉的话浏览器拿不到任何原因，所以后端先 accept 再发这条。
          const reason = String(message.message || t('ai.terminalError'));
          explained = true;
          setStatus('disconnected');
          setError(reason);
          term.write(`\r\n\x1b[31m[${reason}]\x1b[0m\r\n`);
        }
      };

      /**
       * 握手失败时的兜底提示。三种成因给出的下一步完全不同，不能糊成一句。
       */
      const handshakeHint = () => {
        if (preflightOk) {
          // 后端已确认没问题，那就只可能是中间那层没转发 Upgrade
          setErrorHint(t('ai.terminalProxyHint'));
        } else if (preflightStatus === 404) {
          // 自检接口都没发布 —— 后端还跑着旧版本，这条最该先说
          setErrorHint(t('ai.terminalStaleHint'));
        } else {
          setErrorHint(t('ai.terminalErrorHint'));
        }
      };

      ws.onerror = () => {
        // 握手就没成功，浏览器不告诉我们是哪一步：拿不到原因，给一句通用的
        if (!disposed && !explained) {
          setError(t('ai.terminalError'));
          handshakeHint();
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        setStatus(remoteEnded ? 'closed' : 'disconnected');
        if (explained || remoteEnded) return;
        // 1000 / 1005 是正常收尾；其余把原因显示出来 —— 否则用户只看到「断了」，
        // 不知道该去授权、确认指纹还是等网络恢复
        if (event.code && event.code !== 1000 && event.code !== 1005) {
          setError(event.reason || t('ai.terminalError'));
        } else {
          setError(t('ai.terminalError'));
        }
        handshakeHint();
      };

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* 忽略 */
        }
      });
      observer.observe(container);

      teardown = () => {
        observer.disconnect();
        onData.dispose();
        onResize.dispose();
        try {
          ws?.close();
        } catch {
          /* 忽略 */
        }
        ws = null;
        term.dispose();
        fitRef.current = null;
        container.innerHTML = '';
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
      teardown = null;
    };
    // t 只用于拼提示文案，不进依赖：语言切换时整页会重挂，不必为此重连终端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hostId, reconnectKey]);

  // 从隐藏切回可见时容器才真正有尺寸，主动对齐一次列宽。
  // 不指望 ResizeObserver 能覆盖这个时机：一次没对齐的表现就是整屏错位，
  // 而用户只能靠手动拉窗口才好 —— 这种「偶发」最难查。
  useEffect(() => {
    if (!visible) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* 忽略 */
    }
  }, [visible]);

  const statusMeta: Record<
    TermStatus,
    { label: string; variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
  > = {
    idle: { label: t('ai.terminalIdle'), variant: 'neutral' },
    connecting: { label: t('ai.terminalConnecting'), variant: 'info' },
    connected: { label: t('ai.terminalConnected'), variant: 'success' },
    disconnected: { label: t('ai.terminalDisconnected'), variant: 'warning' },
    closed: { label: t('ai.terminalClosed'), variant: 'neutral' },
  };
  const meta = statusMeta[status];

  return (
    <Card>
      <CardHeader
        // 为什么开不了由下面的提示块说明，标题栏只说这个卡是干什么的 ——
        // 两处都写一遍同样的句子，读起来像出了两次错。
        title={t('ai.terminalTitle')}
        subtitle={t('ai.terminalSubtitle')}
        actions={
          active ? (
            <div className="flex items-center gap-8">
              <Badge variant={meta.variant} size="sm" dot pulse={status === 'connected'}>
                {meta.label}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconRefresh size={14} />}
                onClick={() => setReconnectKey((key) => key + 1)}
                title={t('ai.terminalReconnectHint')}
              >
                {t('ai.terminalReconnect')}
              </Button>
            </div>
          ) : undefined
        }
      />

      {active ? (
        <>
          {/* 一句话说清这个窗口里会出现什么：用户自己敲的、AI 跑的，是同一个
              画面里的两种来源 —— 不说清楚会以为两条线串在一起了 */}
          <div className="fs-xs text-muted" style={{ marginBottom: 8 }}>
            {t('ai.terminalHint', { host: hostName || hostId })}
          </div>
          <div
            ref={hostRef}
            className={fill ? 'ai-console-term' : undefined}
            style={{
              // 撑满时高度由 CSS 的 flex:1 决定，这里不再写死
              ...(fill ? null : { height: TERM_HEIGHT }),
              background: TERMINAL_THEME.background,
              borderRadius: 8,
              padding: '6px 8px',
              overflow: 'hidden',
            }}
          />
          {error ? (
            <div style={{ marginTop: 10 }}>
              <Notice tone="danger" title={t('ai.terminalError')}>
                {error}
                {errorHint ? (
                  <div className="fs-xs text-muted" style={{ marginTop: 6 }}>
                    {errorHint}
                  </div>
                ) : null}
              </Notice>
            </div>
          ) : null}
        </>
      ) : (
        <Notice tone={canUse ? 'info' : 'warning'}>
          {canUse ? t('ai.terminalNeedHost') : t('ai.terminalNoPermission')}
        </Notice>
      )}
    </Card>
  );
}
