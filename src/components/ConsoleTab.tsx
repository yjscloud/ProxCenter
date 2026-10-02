/* ==========================================================================
   ProxCenter — 控制台（noVNC）
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { guestsApi } from '../api/guests';
import { errorMessage } from '../api/client';
import type { GuestType } from '../api/types';
import { Button, IconButton } from './ui/Button';
import { Badge } from './ui/Badge';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import {
  IconConsole,
  IconExpand,
  IconRefresh,
  IconShrink,
  IconPower,
  IconAlert,
} from './Icons';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';

/* noVNC 是懒加载的：避免影响首屏体积 */

type ConnState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

/* 控制台高度档位（标准 / 紧凑）的本地记忆键 */
const CONSOLE_COMPACT_KEY = 'pve_console_compact';

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
}

export function ConsoleTab({
  node,
  vmid,
  vmName,
  running,
  guestType = 'qemu',
}: ConsoleTabProps) {
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

  const stageRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  /* 切换机器时重置连接状态 */
  useEffect(() => {
    setState('idle');
    setError(null);
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

  const toggleFullscreen = useCallback(async () => {
    const el = shellRef.current;
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
  }, []);

  const reconnect = () => setReconnectKey((k) => k + 1);

  /* 控制台凭据缺失 / 无效时（后端会返回专门的提示），给出去设置页的引导 */
  const needsConsoleAccount =
    !!error &&
    /proxmox account|tokens cannot|console access|控制台凭据|authentication/i.test(
      error,
    );

  return (
    <div className={`console-shell${compact ? ' is-compact' : ''}`} ref={shellRef}>
      {/* ---- 工具栏 ---- */}
      <div className="console-toolbar">
        <div className="console-toolbar-left">
          {/* 仅提供 VNC 控制台，容器与虚拟机统一走 VNC */}
          <span className="console-mode-label">
            <IconConsole size={14} />
            VNC 图形控制台
          </span>

          <span className="console-status">
            <StatusBadge state={state} />
          </span>
        </div>

        <div className="console-toolbar-right">
          {state === 'connected' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPower size={14} />}
              onClick={() => {
                // 通过自定义事件把 CAD 发送给 VNC 会话
                window.dispatchEvent(new CustomEvent('ProxCenter:vnc-cad'));
              }}
              title="发送 Ctrl+Alt+Del"
            >
              Ctrl+Alt+Del
            </Button>
          ) : null}

          <IconButton
            label={compact ? '恢复正常高度' : '收窄控制台高度'}
            onClick={() => setCompact((v) => !v)}
          >
            {compact ? <IconExpand size={16} /> : <IconShrink size={16} />}
          </IconButton>
          <IconButton label="重新连接控制台" onClick={reconnect}>
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label={fullscreen ? '退出全屏' : '进入全屏'}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <IconShrink size={16} /> : <IconExpand size={16} />}
          </IconButton>
        </div>
      </div>

      {/* ---- 未运行提示 ---- */}
      {!running ? (
        <div className="console-stage">
          <div className="console-overlay">
            <IconAlert size={30} />
            <div>
              <div className="fw-600">
                {guestType === 'lxc' ? '容器未运行' : '虚拟机未运行'}
              </div>
              <div className="fs-sm text-muted mt-8">
                {vmName
                  ? `「${vmName}」`
                  : guestType === 'lxc'
                    ? '该容器'
                    : '该虚拟机'}
                当前处于停止状态，无法连接控制台。
              </div>
            </div>
          </div>
        </div>
      ) : (
        <VncConsole
          key={`vnc-${reconnectKey}`}
          node={node}
          vmid={vmid}
          guestType={guestType}
          containerRef={stageRef}
          onStateChange={setState}
          onError={setError}
        />
      )}

      {/* ---- 错误提示 ---- */}
      {error ? (
        <div style={{ padding: 12 }}>
          <Notice
            tone="danger"
            title="控制台连接失败"
            action={
              needsConsoleAccount && isAdmin ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => navigate('/settings')}
                >
                  前往设置
                </Button>
              ) : undefined
            }
          >
            {needsConsoleAccount
              ? `VNC 控制台必须使用 Proxmox 账号密码登录（API Token 不支持）。当前控制台凭据缺失、无效或权限不足（PVE 拒绝了登录），请${
                  isAdmin ? '到「设置 → 控制台凭据」检查' : '联系管理员检查'
                }账号与密码后重试。`
              : error}
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   状态徽章
   --------------------------------------------------------------------------- */

function StatusBadge({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info'; pulse?: boolean }> = {
    idle: { label: '未连接', variant: 'neutral' },
    connecting: { label: '连接中…', variant: 'info', pulse: true },
    connected: { label: '已连接', variant: 'success', pulse: true },
    disconnected: { label: '已断开', variant: 'warning' },
    error: { label: '连接失败', variant: 'danger' },
  };
  const meta = map[state];
  return (
    <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
      {meta.label}
    </Badge>
  );
}

/* ---------------------------------------------------------------------------
   VNC 控制台（noVNC）
   --------------------------------------------------------------------------- */

interface VncProps {
  node: string;
  vmid: number;
  /** 容器走 /lxc/{vmid} 的端点，必须传下去 */
  guestType: GuestType;
  containerRef: React.RefObject<HTMLDivElement>;
  onStateChange: (s: ConnState) => void;
  onError: (msg: string | null) => void;
}

function VncConsole({
  node,
  vmid,
  guestType,
  containerRef,
  onStateChange,
  onError,
}: VncProps) {
  const toast = useToast();
  const guest = useMemo(() => ({ node, vmid, type: guestType }), [
    node,
    vmid,
    guestType,
  ]);
  const rfbRef = useRef<{
    disconnect: () => void;
    sendCtrlAltDel?: () => void;
    scaleViewport?: boolean;
    resizeSession?: boolean;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let rfb: {
      disconnect: () => void;
      sendCtrlAltDel?: () => void;
      scaleViewport?: boolean;
      resizeSession?: boolean;
    } | null = null;
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
        onError('控制台区域尚未就绪，请重新打开该标签页后重试。');
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
        ) => {
          disconnect: () => void;
          sendCtrlAltDel: () => void;
          scaleViewport: boolean;
          resizeSession: boolean;
        };

        /* 只在后端确实给了口令时才带 credentials。
           PVE 的 VNC 代理是**凭 URL 里的 vncticket 认证**的，不需要 VNC 口令；
           把 password: null 塞进去会让 noVNC 走一遍口令握手，等一个永远不会来的
           回应 —— 表现就是卡在「连接中…」。 */
        rfb = new RfbCtor(container, url, {
          ...(proxy.password ? { credentials: { password: proxy.password } } : {}),
          shared: true,
        });

        rfbRef.current = rfb;

        /* 握手超时兜底。
           noVNC 在握手卡住时既可能不触发 connect 也不触发 disconnect —— 界面就
           会永远停在「连接中…」，既不成功也不报错，用户只能干等。给一个上限，
           超时后明确归因，比转圈强。nginx 那层的读超时是 3600 秒，指望不上。 */
        handshakeTimer = window.setTimeout(() => {
          if (disposed) return;
          timedOut = true;
          onStateChange('error');
          onError(
            'VNC 握手超时（20 秒未完成）。常见原因：目标机器未开机或没有图形控制台、'
            + 'PVE 控制台凭据无效、或浏览器到面板的 WebSocket 被中间设备拦截。'
            + '可点击「重新连接」重试。',
          );
          try {
            rfbRef.current?.disconnect();
          } catch {
            /* 忽略 */
          }
        }, 20_000);

        /* 优先请求远端把桌面分辨率改成容器大小 —— 这样画面是 1:1 像素，字最清晰。
           客户机没装 vdagent 时远端不会响应，再退回本地等比缩放（至少能看到全貌）。 */
        rfb.resizeSession = true;
        rfb.scaleViewport = true;

        /* 5. 绑定事件 */
        const conn = rfb as unknown as {
          addEventListener: (type: string, cb: (e: { detail?: { clean?: boolean } }) => void) => void;
        };

        conn.addEventListener('connect', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onStateChange('connected');
        });

        conn.addEventListener('disconnect', (e) => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          /* 超时兜底已经写过更具体的归因，这里就不让它被「意外中断」覆盖 */
          if (timedOut) return;
          onStateChange('disconnected');
          if (e?.detail?.clean) {
            onError('控制台会话已结束');
          } else {
            onError('与 VNC 代理的连接意外中断，请点击「重新连接」重试。');
          }
        });

        conn.addEventListener('securityfailure', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onStateChange('error');
          onError('VNC 认证失败，请检查后端代理票据配置。');
        });

        /* 上游要求凭据但前端没拿到（极少见：PVE 开了 VNC 口令而我们没取到）。
           noVNC 会一直等一个永远不会来的输入框，表现就是卡在「连接中…」——
           这里主动报错，避免无限转圈。 */
        conn.addEventListener('credentialsrequired', () => {
          if (disposed) return;
          window.clearTimeout(handshakeTimer);
          onStateChange('error');
          onError(
            'VNC 连接需要凭据但后端未返回，请检查 PVE 控制台账号配置后重试。',
          );
        });
      } catch (err) {
        if (disposed) return;
        onStateChange('error');
        const msg = errorMessage(err);
        onError(
          msg.includes('未实现')
            ? '后端尚未实现 VNC 代理接口（/console/vncproxy）。'
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

  /* 保留 toast 引用避免未使用告警（noVNC 剪贴板可扩展） */
  void toast;

  return (
    <div className="console-stage" ref={containerRef}>
      <div className="console-overlay vnc-connecting">
        <Spinner size={26} label="正在连接 VNC" />
        <div>
          <div className="fw-600">正在建立 VNC 连接…</div>
          <div className="console-hint mt-8">
            首次连接可能需要数秒，请稍候
          </div>
        </div>
      </div>
    </div>
  );
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
