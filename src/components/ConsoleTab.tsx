/* ==========================================================================
   ProxCenter — 控制台（noVNC）
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { guestsApi } from '../api/guests';
import { vmsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import type { GuestType } from '../api/types';
import { Button, IconButton } from './ui/Button';
import { Badge } from './ui/Badge';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { useConfirm } from './ui/ConfirmDialog';
import {
  IconConsole,
  IconExpand,
  IconRefresh,
  IconShrink,
  IconPower,
  IconAlert,
  IconCopy,
  IconUpload,
  IconMonitor,
  IconTerminal,
} from './Icons';
import {
  ConsoleAssist,
  TYPE_TEXT_LIMIT,
  type ConsoleAssistMode,
} from './ConsoleAssist';
import { ConsoleXterm, type ConsoleTermHandle } from './ConsoleXterm';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';

/* noVNC 是懒加载的：避免影响首屏体积 */

type ConnState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

/**
 * VNC 会话对外暴露的最小能力集。
 *
 * 面板（剪贴板 / 文件上传）需要往客户机送文本，但它不应该知道 noVNC 的存在；
 * 由 VncConsole 在连接建立后把这两个方法注册上来，断开时清空。
 */
export interface VncHandle {
  /** 走 RFB 剪贴板通道（依赖客户机的 VNC 服务端实现 CutText） */
  pasteText: (text: string) => void;
  /** 逐字符键入（不依赖客户机剪贴板；只支持 ASCII） */
  typeText: (text: string) => Promise<{ typed: number; skipped: number }>;
}

/* 控制台高度档位（标准 / 紧凑）的本地记忆键 */
const CONSOLE_COMPACT_KEY = 'pve_console_compact';

/* 图形 / 终端的选择也记住：同一个管理员对同一类机器的偏好基本固定 */
const CONSOLE_MODE_KEY = 'pve_console_mode';

type ConsoleMode = 'vnc' | 'term';

/**
 * 控制台会话句柄。
 *
 * VNC（位图）与终端（字符流）都实现同样两个方法，外层只管「把文本送进客户机」，
 * 不需要知道底下是哪一种。
 */
type ConsoleHandle = VncHandle | ConsoleTermHandle;

export interface ConsoleTabProps {
  node: string;
  vmid: number;
  vmName?: string;
  /** VM 是否运行中（未运行时 disable） */
  running: boolean;
  /**
   * guest 类型。容器走 `/lxc/{vmid}` 的 PVE 端点，虚拟机走 `/qemu/{vmid}`；
   * VNC 对两者都成立 —— 容器的 VNC 画面就是它的控制台（tty）本身。
   */
  guestType?: GuestType;
  /**
   * 虚拟机是否已配置串口（终端控制台只认 serial0）。
   *
   * 未配置时给一条能直接跳去「硬件」页的提示 —— 光说「请先在硬件里添加」
   * 没有路径可走，用户会以为功能坏了。容器不需要这个（tty 天然存在）。
   */
  hasSerial?: boolean;
  /** 跳去硬件 Tab，让用户直接加串口 */
  onOpenHardware?: () => void;
}

export function ConsoleTab({
  node,
  vmid,
  vmName,
  running,
  guestType = 'qemu',
  hasSerial = true,
  onOpenHardware,
}: ConsoleTabProps) {
  const t = useT();
  const navigate = useNavigate();
  /* 控制台凭据配置位于「系统设置」，仅管理员可进入 */
  const { isAdmin } = useAuth();
  const [state, setState] = useState<ConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CONSOLE_COMPACT_KEY) === '1';
    } catch {
      return false;
    }
  });
  /**
   * 是否提供「终端」模式 —— 只有虚拟机有。
   *
   * 容器的控制台**就是它自己的 tty**，PVE 用 vncterm 把这块 tty 渲染成 VNC 画面；
   * 再开一条 termproxy 等于给同一块 tty 接第二个入口，两边会互相抢输入，
   * 光标位置也对不上。所以容器只保留图形模式，不做二选一。
   */
  const termAvailable = guestType !== 'lxc';

  /* 图形（VNC）/ 终端（xterm）二选一。虚拟机默认图形界面（多数人是去看安装界面 /
     桌面），上次的选择记在 localStorage 里。 */
  const [mode, setMode] = useState<ConsoleMode>(() => {
    if (guestType === 'lxc') return 'vnc';
    try {
      const saved = localStorage.getItem(CONSOLE_MODE_KEY);
      if (saved === 'vnc' || saved === 'term') return saved;
    } catch {
      /* 忽略：隐私模式下 localStorage 不可用 */
    }
    return 'vnc';
  });

  /* 同一个 ConsoleTab 实例换了机器类型（或从虚拟机切到容器）时兜底：
     终端模式对容器不成立，必须回到图形 */
  useEffect(() => {
    if (!termAvailable) setMode('vnc');
  }, [termAvailable]);

  const stageRef = useRef<HTMLDivElement>(null);
  /* 控制台外壳元素（同时是全屏元素）。用 state 而不是 ref 存：它有两个用途 ——
     全屏、以及当确认框的挂载点（确认框要挂在控制台自己的容器里，而不是默认的
     body：全屏时浏览器只显示全屏元素及其后代，挂到 body 的弹窗会被挡在外面，
     用户点了 Ctrl+Alt+Del 既没看到确认框、也没发出按键，像按钮坏了）。 */
  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
  const attachShell = useCallback((el: HTMLDivElement | null) => setShellEl(el), []);
  const [cadConfirmEl, confirmCad] = useConfirm();

  const toast = useToast();
  /* 辅助面板（剪贴板 / 文件上传）。null = 收起 */
  const [assistMode, setAssistMode] = useState<ConsoleAssistMode | null>(null);
  /* 客户机剪贴板：由 VncConsole 的 noVNC clipboard 事件填入 */
  const [guestClipboard, setGuestClipboard] = useState('');
  const consoleHandle = useRef<ConsoleHandle | null>(null);
  /* 键入是逐字符排队发的：连点两次会让两段文本交错打进终端 */
  const typingRef = useRef(false);
  /* 「启用串口登录」进行中：按钮期间不可重复点（会重复起 getty） */
  const [serialBusy, setSerialBusy] = useState(false);

  /* 切换机器时重置连接状态与面板状态：
     上一台机器的剪贴板残留会让人误以为是当前这台的内容。 */
  useEffect(() => {
    setState('idle');
    setError(null);
    setAssistMode(null);
    setGuestClipboard('');
    consoleHandle.current = null;
  }, [node, vmid]);

  /* 全屏状态跟踪 */
  useEffect(() => {
    const handler = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  /* 记住高度档位，下次打开控制台沿用 */
  useEffect(() => {
    try {
      localStorage.setItem(CONSOLE_COMPACT_KEY, compact ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }, [compact]);

  /* 记住图形 / 终端的选择。容器的 mode 恒为 vnc，不该覆盖掉虚拟机的偏好 */
  useEffect(() => {
    if (!termAvailable) return;
    try {
      localStorage.setItem(CONSOLE_MODE_KEY, mode);
    } catch {
      /* 忽略 */
    }
  }, [mode, termAvailable]);

  /* 切换模式 = 换一条完全不同的通道：旧会话的句柄、状态与错误都要清掉，
     否则徽章还停在「已连接」、错误提示却说的是上一条通道的事。 */
  const switchMode = useCallback(
    (next: ConsoleMode) => {
      setMode((prev) => {
        if (prev === next) return prev;
        setState('idle');
        setError(null);
        setGuestClipboard('');
        consoleHandle.current = null;
        return next;
      });
    },
    [],
  );

  const toggleFullscreen = useCallback(async () => {
    const el = shellEl;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch (err) {
      /* 某些浏览器/权限下会失败，静默处理 */
      console.warn('全屏切换失败', err);
    }
  }, [shellEl]);

  const reconnect = () => setReconnectKey((k) => k + 1);

  /**
   * 客户机的串口上没人监听时，画面就只有 PVE 的 starting serial terminal 一行。
   * 这一步通过 Guest Agent 在客户机里启一个 serial-getty，让终端真正可用。
   */
  const enableSerialLogin = async () => {
    setSerialBusy(true);
    try {
      await vmsApi.enableSerialLogin(node, vmid);
      toast.success(t('console.serialLoginOk'), t('console.serialLoginOkHint'));
      /* getty 起来后会在 ttyS0 上打登录提示；重连一次把旧 pty 换掉，
         免得两路输入叠在一起 */
      window.setTimeout(reconnect, 800);
    } catch (err) {
      toast.error(t('console.serialLoginFailed'), errorMessage(err));
    } finally {
      setSerialBusy(false);
    }
  };

  /* ---- 剪贴板 / 键入 ---- */

  const openAssist = useCallback((mode: ConsoleAssistMode) => {
    setAssistMode((prev) => (prev === mode ? null : mode));
  }, []);

  const sendPaste = useCallback(
    (text: string) => {
      const handle = consoleHandle.current;
      if (!handle || state !== 'connected') {
        toast.warning(t('console.assistNotReady'));
        return;
      }
      handle.pasteText(text);
      toast.success(t('console.pasteSent'));
    },
    [state, t, toast],
  );

  const sendType = useCallback(
    (text: string) => {
      const handle = consoleHandle.current;
      if (!handle || state !== 'connected') {
        toast.warning(t('console.assistNotReady'));
        return;
      }
      if (!text) return;
      if (typingRef.current) {
        toast.warning(t('console.typingBusy'));
        return;
      }
      if (text.length > TYPE_TEXT_LIMIT) {
        /* 逐字符键入是「一个键一个键」发，长文本要几十秒，用户会以为卡死 */
        toast.warning(
          t('console.typeTooLong', { limit: TYPE_TEXT_LIMIT }),
          t('console.typeTooLongHint'),
        );
        return;
      }
      const id = toast.loading(t('console.typingStarted', { count: text.length }));
      typingRef.current = true;
      void handle
        .typeText(text)
        .then(({ typed, skipped }) => {
          if (skipped > 0) {
            toast.update(id, {
              type: 'warning',
              title: t('console.typedSkipped', { typed, skipped }),
            });
          } else {
            toast.update(id, {
              type: 'success',
              title: t('console.typedDone', { count: typed }),
            });
          }
        })
        .catch(() => {
          toast.update(id, { type: 'error', title: t('console.typeFailed') });
        })
        .finally(() => {
          typingRef.current = false;
        });
    },
    [state, t, toast],
  );

  /* Ctrl+Shift+V：把本机剪贴板直接送到客户机。
     必须用**捕获阶段**并 stopPropagation —— noVNC 在 canvas 上绑了 keydown，
     冒泡阶段拦已经晚了，Ctrl+Shift+V 会被当成普通按键发给客户机。
     面板里的输入框不拦：那里的 Ctrl+Shift+V 是浏览器自己的「粘贴为纯文本」。 */
  useEffect(() => {
    const el = shellEl;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      if ((event.key || '').toLowerCase() !== 'v') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) {
            toast.info(t('console.clipboardEmpty'));
            return;
          }
          sendPaste(text);
        } catch {
          /* 非 HTTPS / 未授权：让用户到面板里手动粘贴 */
          setAssistMode('clipboard');
          toast.warning(
            t('console.readClipboardFailed'),
            t('console.readClipboardHint'),
          );
        }
      })();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [shellEl, sendPaste, t, toast]);

  /* 控制台凭据缺失 / 无效时（后端会返回专门的提示），给出去设置页的引导 */
  const needsConsoleAccount =
    !!error &&
    /proxmox account|tokens cannot|console access|控制台凭据|authentication/i.test(
      error,
    );

  return (
    <div className={`console-shell${compact ? ' is-compact' : ''}`} ref={attachShell}>
      {/* ---- 工具栏 ---- */}
      <div className="console-toolbar">
        <div className="console-toolbar-left">
          {/* 图形（VNC）与终端（xterm）是两条通道，只有虚拟机有得选：容器不提供
              终端。两个选项做成一个分段控件（而不是两个各自带边框的按钮）——
              它们本就是同一个「控制台类型」的两种取值，视觉上应该像一个整体。 */}
          {termAvailable ? (
            <>
              <span className="console-mode-label">
                <IconConsole size={14} />
                {t('console.mode')}
              </span>

              <span className="console-modes" role="group" aria-label={t('console.mode')}>
                <button
                  type="button"
                  className={`console-mode-opt${mode === 'vnc' ? ' is-active' : ''}`}
                  onClick={() => switchMode('vnc')}
                  title={t('console.modeVncHint')}
                  aria-pressed={mode === 'vnc'}
                >
                  <IconMonitor size={14} />
                  {t('console.modeVnc')}
                </button>
                <button
                  type="button"
                  className={`console-mode-opt${mode === 'term' ? ' is-active' : ''}`}
                  onClick={() => switchMode('term')}
                  title={t('console.modeTermHint')}
                  aria-pressed={mode === 'term'}
                >
                  <IconTerminal size={14} />
                  {t('console.modeTerm')}
                </button>
              </span>
            </>
          ) : null}

          <span className="console-status">
            <StatusBadge state={state} />
          </span>
        </div>

        <div className="console-toolbar-right">
          {/* Ctrl+Alt+Del 是 RFB 键盘消息，终端模式没有这个概念，不显示 */}
          {state === 'connected' && mode === 'vnc' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPower size={14} />}
              onClick={() => {
                /* 先确认再发：客户机收到的是「安全注意序列」，Windows 一般只是回到
                   安全选项，Linux / GRUB 却往往直接重启 —— 按下去之前得知道这一下
                   会让机器上的服务停掉。确认框挂在全屏容器内（见上面的 shellEl）。 */
                void confirmCad({
                  title: t('console.cadConfirmTitle', { name: vmName || vmid }),
                  message: t('console.cadConfirmMessage'),
                  confirmText: t('console.sendCad'),
                  container: shellEl,
                }).then((ok) => {
                  if (!ok) return;
                  // 通过自定义事件把 CAD 发送给 VNC 会话
                  window.dispatchEvent(new CustomEvent('ProxCenter:vnc-cad'));
                });
              }}
              title={t('console.sendCad')}
            >
              Ctrl+Alt+Del
            </Button>
          ) : null}

          {/* 剪贴板 / 文件：VNC 画面里点不动的东西，从这里送进去 */}
          <IconButton
            label={t('console.assistClipboard')}
            className={`console-assist-toggle${assistMode === 'clipboard' ? ' is-active' : ''}`}
            aria-pressed={assistMode === 'clipboard'}
            disabled={!running}
            onClick={() => openAssist('clipboard')}
          >
            <IconCopy size={16} />
            {guestClipboard && assistMode !== 'clipboard' ? (
              <span className="console-assist-dot" aria-hidden="true" />
            ) : null}
          </IconButton>
          <IconButton
            label={t('console.assistFiles')}
            className={`console-assist-toggle${assistMode === 'files' ? ' is-active' : ''}`}
            aria-pressed={assistMode === 'files'}
            disabled={!running}
            onClick={() => openAssist('files')}
          >
            <IconUpload size={16} />
          </IconButton>

          <IconButton
            label={
              compact ? t('console.restoreHeight') : t('console.compactHeight')
            }
            onClick={() => setCompact((v) => !v)}
          >
            {compact ? <IconExpand size={16} /> : <IconShrink size={16} />}
          </IconButton>
          <IconButton label={t('console.reconnect')} onClick={reconnect}>
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label={
              fullscreen ? t('console.exitFullscreen') : t('console.enterFullscreen')
            }
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <IconShrink size={16} /> : <IconExpand size={16} />}
          </IconButton>
        </div>
      </div>

      {/* 虚拟机的终端模式走 serial0：没加串口的机器只会拿到一句 PVE 的原始报错，
          这里先把前提说清楚；加了串口但客户机没人监听 ttyS0 时，再给一个
          「启用串口登录」的入口（终端的画面来自客户机，面板只能把它送到对面） */}
      {running && mode === 'term' && termAvailable ? (
        <div className="console-term-hint">
          <span>
            {hasSerial
              ? t('console.termSerialGuestHint')
              : t('console.termSerialHint')}
          </span>
          {!hasSerial && onOpenHardware ? (
            <button type="button" className="console-term-hint-action" onClick={onOpenHardware}>
              {t('console.termAddSerial')}
            </button>
          ) : null}
          {hasSerial ? (
            <button
              type="button"
              className="console-term-hint-action"
              onClick={() => void enableSerialLogin()}
              disabled={serialBusy}
            >
              {serialBusy
                ? t('console.serialLoginBusy')
                : t('console.termEnableSerialLogin')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ---- 未运行提示 ---- */}
      {!running ? (
        <div className="console-stage">
          <div className="console-overlay">
            <IconAlert size={30} />
            <div>
              <div className="fw-600">
                {guestType === 'lxc'
                  ? t('console.lxcNotRunning')
                  : t('console.vmNotRunning')}
              </div>
              <div className="fs-sm text-muted mt-8">
                {vmName
                  ? t('console.nameQuoted', { name: vmName })
                  : guestType === 'lxc'
                    ? t('console.thisLxc')
                    : t('console.thisVm')}
                {t('console.stoppedHint')}
              </div>
            </div>
          </div>
        </div>
      ) : mode === 'term' && termAvailable ? (
        <ConsoleXterm
          key={`term-${reconnectKey}`}
          node={node}
          vmid={vmid}
          guestType={guestType}
          onStateChange={setState}
          onError={setError}
          onReady={(handle) => {
            consoleHandle.current = handle;
          }}
        />
      ) : (
        <VncConsole
          key={`vnc-${reconnectKey}`}
          node={node}
          vmid={vmid}
          guestType={guestType}
          containerRef={stageRef}
          onStateChange={setState}
          onError={setError}
          onReady={(handle) => {
            consoleHandle.current = handle;
          }}
          onClipboard={setGuestClipboard}
        />
      )}

      {/* ---- 剪贴板 / 文件上传面板（挂在控制台外壳里，全屏时也在） ---- */}
      {running ? (
        <ConsoleAssist
          key={`assist-${node}-${vmid}`}
          open={assistMode !== null}
          mode={assistMode ?? 'clipboard'}
          onModeChange={setAssistMode}
          onClose={() => setAssistMode(null)}
          container={shellEl}
          connected={state === 'connected'}
          guestClipboard={guestClipboard}
          onPasteToGuest={sendPaste}
          onTypeToGuest={sendType}
          guestType={guestType}
          node={node}
          vmid={vmid}
        />
      ) : null}

      {/* ---- 错误提示 ---- */}
      {error ? (
        <div style={{ padding: 12 }}>
          <Notice
            tone="danger"
            title={t('console.connFailed')}
            action={
              needsConsoleAccount && isAdmin ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => navigate('/settings')}
                >
                  {t('console.goSettings')}
                </Button>
              ) : undefined
            }
          >
            {needsConsoleAccount
              ? `${t('console.needCredsPre')}${
                  isAdmin ? t('console.checkSettings') : t('console.contactAdmin')
                }${t('console.needCredsPost')}`
              : error}
          </Notice>
        </div>
      ) : null}

      {/* Ctrl+Alt+Del 的确认框：挂在控制台容器内（见 shellEl），全屏时也看得见 */}
      {cadConfirmEl}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   状态徽章
   --------------------------------------------------------------------------- */

function StatusBadge({ state }: { state: ConnState }) {
  const t = useT();
  const map: Record<ConnState, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info'; pulse?: boolean }> = {
    idle: { label: t('console.stateIdle'), variant: 'neutral' },
    connecting: { label: t('console.stateConnecting'), variant: 'info', pulse: true },
    connected: { label: t('console.stateConnected'), variant: 'success', pulse: true },
    disconnected: { label: t('console.stateDisconnected'), variant: 'warning' },
    error: { label: t('console.stateError'), variant: 'danger' },
  };
  const meta = map[state];
  return (
    <Badge variant={meta.variant} dot pulse={meta.pulse} size="md">
      {meta.label}
    </Badge>
  );
}

/* ---------------------------------------------------------------------------
   VNC 控制台（noVNC）
   --------------------------------------------------------------------------- */

/** noVNC RFB 实例里我们用到的那部分（noVNC 没有类型声明，只能自己收口） */
interface RfbApi {
  disconnect: () => void;
  sendCtrlAltDel?: () => void;
  clipboardPasteFrom?: (text: string) => void;
  sendKey?: (keysym: number, code?: string, down?: boolean) => void;
  focus?: () => void;
  scaleViewport?: boolean;
  resizeSession?: boolean;
  addEventListener: (
    type: string,
    cb: (e: { detail?: { clean?: boolean; text?: string } }) => void,
  ) => void;
}

interface VncProps {
  node: string;
  vmid: number;
  /** 容器走 /lxc/{vmid} 的端点，必须传下去 */
  guestType: GuestType;
  containerRef: React.RefObject<HTMLDivElement>;
  onStateChange: (s: ConnState) => void;
  onError: (msg: string | null) => void;
  /** 连接建立后把剪贴板 / 键入能力交给外层（断开时传 null） */
  onReady?: (handle: VncHandle | null) => void;
  /** 客户机剪贴板更新（noVNC 的 clipboard 事件） */
  onClipboard?: (text: string) => void;
}

function VncConsole({
  node,
  vmid,
  guestType,
  containerRef,
  onStateChange,
  onError,
  onReady,
  onClipboard,
}: VncProps) {
  const t = useT();
  const guest = useMemo(() => ({ node, vmid, type: guestType }), [
    node,
    vmid,
    guestType,
  ]);
  const rfbRef = useRef<RfbApi | null>(null);

  useEffect(() => {
    let disposed = false;
    let rfb: RfbApi | null = null;
    let handshakeTimer: number | undefined;
    /* 握手超时时置位：这样 disconnect 处理器（timeout 里已主动 disconnect）
       触发的「意外中断」就不会把那段更具体的归因文案覆盖掉。 */
    let timedOut = false;

    async function connect() {
      onStateChange('connecting');
      onError(null);

      const container = containerRef.current;
      if (!container) {
        /* 拿不到容器时不能默默 return：状态已经写成 connecting，用户就只能对着
           转圈等下去。容器没就绪是明确的失败，如实报出来。 */
        onStateChange('error');
        onError(t('console.stageNotReady'));
        return;
      }

      try {
        /* 1. 申请 VNC 代理票据 */
        const proxy = await guestsApi.vncProxy(guest);
        if (disposed) return;

        /* 2. 动态加载 noVNC */
        const mod = await import('@novnc/novnc');
        const RFB =
          (mod as unknown as { default?: unknown }).default ??
          (mod as unknown as unknown);
        if (disposed) return;

        /* 3. 清空容器 */
        container.innerHTML = '';

        /* 4. 建立连接 */
        const url = guestsApi.vncWsUrl(guest, proxy.port, proxy.ticket);
        // noVNC 的 RFB 构造函数签名：new RFB(target, urlOrChannel, options)
        const RfbCtor = RFB as new (
          target: HTMLElement,
          url: string,
          options?: { credentials?: { password?: string }; shared?: boolean },
        ) => RfbApi;

        /* 只在后端确实给了口令时才带 credentials。
           PVE 的 VNC 代理是**凭 URL 里的 vncticket 认证**的，不需要 VNC 口令；
           把 password: null 塞进去会让 noVNC 走一遍口令握手，等一个永远不会来的
           回应 —— 表现就是卡在「连接中…」。 */
        const session = new RfbCtor(container, url, {
          ...(proxy.password ? { credentials: { password: proxy.password } } : {}),
          shared: true,
        });
        rfb = session;
        rfbRef.current = session;

        /* 把「往客户机送文本」的两条通道交给外层面板：
           * clipboardPasteFrom 走 RFB CutText，能不能生效取决于客户机；
           * sendKey 逐字符键入，不依赖客户机，但只支持 ASCII。 */
        onReady?.({
          pasteText: (text) => {
            try {
              session.clipboardPasteFrom?.(text);
            } catch {
              /* 连接已断：面板会拿 disconnected 提示，这里不必再吵 */
            }
          },
          typeText: (text) => typeViaKeys(session, text),
        });

        /* 握手超时兜底。
           noVNC 在握手卡住时既可能不触发 connect 也不触发 disconnect —— 界面就
           会永远停在「连接中…」，既不成功也不报错，用户只能干等。给一个上限，
           超时后明确归因，比转圈强。nginx 那层的读超时是 3600 秒，指望不上。 */
        handshakeTimer = window.setTimeout(() => {
          if (disposed) return;
          timedOut = true;
          onStateChange('error');
          onError(t('console.handshakeTimeout'));
          try {
            rfbRef.current?.disconnect();
          } catch {
            /* 忽略 */
          }
        }, 20_000);

        /* 优先请求远端把桌面分辨率改成容器大小 —— 这样画面是 1:1 像素，字最清晰。
           客户机没装 vdagent 时远端不会响应，再退回本地等比缩放（至少能看到全貌）。 */
        session.resizeSession = true;
        session.scaleViewport = true;

        /* 5. 绑定事件 */
        session.addEventListener('connect', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onStateChange('connected');
        });

        session.addEventListener('disconnect', (e) => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          /* 断线后旧句柄不能再用：面板按钮会据此禁用 */
          onReady?.(null);
          /* 超时兜底已经写过更具体的归因，这里就不让它被「意外中断」覆盖 */
          if (timedOut) return;
          onStateChange('disconnected');
          if (e?.detail?.clean) {
            onError(t('console.sessionEnded'));
          } else {
            onError(t('console.proxyInterrupted'));
          }
        });

        session.addEventListener('securityfailure', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onReady?.(null);
          onStateChange('error');
          onError(t('console.authFailed'));
        });

        /* 上游要求凭据但前端没拿到（极少见：PVE 开了 VNC 口令而我们没取到）。
           noVNC 会一直等一个永远不会来的输入框，表现就是卡在「连接中…」——
           这里主动报错，避免无限转圈。 */
        session.addEventListener('credentialsrequired', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onReady?.(null);
          onStateChange('error');
          onError(t('console.credentialsMissing'));
        });

        /* 客户机剪贴板：面板里展示，并提供「复制到本机」。
           注意这只是**客户机主动推送**时才有的内容；多数 Linux 控制台没有
           剪贴板代理，收不到是正常的。 */
        session.addEventListener('clipboard', (e) => {
          if (disposed) return;
          onClipboard?.(String(e?.detail?.text ?? ''));
        });
      } catch (err) {
        if (disposed) return;
        onStateChange('error');
        const msg = errorMessage(err);
        onError(
          /未实现|not implemented/i.test(msg)
            ? t('console.proxyNotImpl')
            : msg,
        );
      }
    }

    void connect();

    return () => {
      disposed = true;
      window.clearTimeout(handshakeTimer);
      try {
        rfb?.disconnect();
      } catch {
        /* 忽略 */
      }
      rfbRef.current = null;
      onReady?.(null);
      const container = containerRef.current;
      if (container) container.innerHTML = '';
    };
    // 依赖刻意精简：仅 node/vmid 变化时重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, vmid]);

  /* Ctrl+Alt+Del 事件：工具栏按钮触发，这里转发给当前 noVNC 实例。
     单独挂一个 effect（而不是塞进 connect 里），避免重连时重复注册、
     以及卸载时漏注销导致的内存泄漏。 */
  useEffect(() => {
    const cadHandler = () => {
      try {
        rfbRef.current?.sendCtrlAltDel?.();
      } catch {
        /* 忽略 */
      }
    };
    window.addEventListener('ProxCenter:vnc-cad', cadHandler);
    return () =>
      window.removeEventListener('ProxCenter:vnc-cad', cadHandler);
  }, []);

  return (
    <div className="console-stage" ref={containerRef}>
      <div className="console-overlay vnc-connecting">
        <Spinner size={26} label={t('console.connectingLabel')} />
        <div>
          <div className="fw-600">{t('console.connectingTitle')}</div>
          <div className="console-hint mt-8">{t('console.connectingHint')}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   把文本当成真实按键敲进客户机
   --------------------------------------------------------------------------- */

/** 每个字符之间的间隔。太快时容器的 vncterm / 老式终端会丢键。 */
const KEY_DELAY_MS = 6;

const XK_SHIFT_L = 0xffe1;
const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;

/** 「需要按住 Shift 才打出来的字符」→ 基础键（keysym 取基础字符的码点） */
const SHIFTED_TO_BASE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const pairs: Array<[string, string]> = [
    ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'],
    ['6', '^'], ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'],
    ['-', '_'], ['=', '+'], ['[', '{'], [']', '}'], ['\\', '|'],
    [';', ':'], ["'", '"'], [',', '<'], ['.', '>'], ['/', '?'], ['`', '~'],
  ];
  for (const [base, shifted] of pairs) map[shifted] = base;
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') map[ch.toUpperCase()] = ch;
  return map;
})();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 用 sendKey 逐字符键入。
 *
 * 为什么不是直接 clipboardPasteFrom：CutText 只是把文本交给客户机的剪贴板
 * 代理，没有代理（绝大多数 Linux 控制台、容器的 vncterm）时等于什么也没发生。
 * 按键是 VNC 协议最基本的通道，任何服务端都实现。
 *
 * 局限：只处理可打印 ASCII。keysym 与字符码点一致（X11 的规定），所以
 * ``sendKey(ch.charCodeAt(0))`` 就是打这个字符；需要 Shift 的字符则按住
 * Shift 再送「基础键」，避免依赖客户机键盘布局把 '!' 解释成别的键。
 * 中文等非 ASCII 字符只能走剪贴板通道。
 */
async function typeViaKeys(
  session: RfbApi,
  text: string,
): Promise<{ typed: number; skipped: number }> {
  let typed = 0;
  let skipped = 0;
  try {
    session.focus?.();
  } catch {
    /* 忽略 */
  }
  for (const ch of text) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      session.sendKey?.(XK_RETURN, 'Enter');
      typed += 1;
      await sleep(KEY_DELAY_MS);
      continue;
    }
    if (ch === '\t') {
      session.sendKey?.(XK_TAB, 'Tab');
      typed += 1;
      await sleep(KEY_DELAY_MS);
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      skipped += 1;
      continue;
    }
    const base = SHIFTED_TO_BASE[ch];
    if (base) {
      session.sendKey?.(XK_SHIFT_L, 'ShiftLeft', true);
      session.sendKey?.(base.charCodeAt(0));
      session.sendKey?.(XK_SHIFT_L, 'ShiftLeft', false);
    } else {
      session.sendKey?.(code);
    }
    typed += 1;
    await sleep(KEY_DELAY_MS);
  }
  return { typed, skipped };
}

/* ---------------------------------------------------------------------------
   导出：控制台 Tab 用的查询失效辅助（供 VmDetail 使用）
   --------------------------------------------------------------------------- */

export function useConsoleInvalidate(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['vm'] });
  };
}
