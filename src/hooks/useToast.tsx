/* ==========================================================================
   ProxCenter — 全局 Toast 通知
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ToastItem, ToastType } from '../api/types';

/* ---------------------------------------------------------------------------
   Context
   --------------------------------------------------------------------------- */

export interface ToastApi {
  /** 弹出 toast，返回 id */
  push: (type: ToastType, title: string, message?: string) => string;
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string) => string;
  warning: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
  /**
   * 破坏性操作成功（删除 / 隔离）。与 success 的区别只在视觉权重：
   * 不可撤销的动作用更强的配色，别让用户划过去。
   */
  destructive: (title: string, message?: string) => string;
  /** 弹出持久 toast（不自动消失），返回 id */
  loading: (title: string, message?: string) => string;
  /** 更新已存在的 toast */
  update: (
    id: string,
    patch: Partial<Omit<ToastItem, 'id'>>,
  ) => void;
  /** 手动关闭 */
  dismiss: (id: string) => void;
  /** 清空 */
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const DEFAULT_DURATION = 3000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `toast-${Date.now()}-${seq}`;
}

/* ---------------------------------------------------------------------------
   Provider
   --------------------------------------------------------------------------- */

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: string, duration: number) => {
      clearTimer(id);
      const t = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, t);
    },
    [clearTimer, dismiss],
  );

  const push = useCallback(
    (type: ToastType, title: string, message?: string): string => {
      const id = nextId();
      setToasts((prev) => {
        const next = [...prev, { id, type, title, message }];
        // 最多同时展示 5 条
        return next.length > 5 ? next.slice(next.length - 5) : next;
      });
      schedule(id, DEFAULT_DURATION);
      return id;
    },
    [schedule],
  );

  const loading = useCallback(
    (title: string, message?: string): string => {
      const id = nextId();
      setToasts((prev) => [
        ...prev,
        { id, type: 'info', title, message, persistent: true, loading: true },
      ]);
      return id;
    },
    [],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<ToastItem, 'id'>>) => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
      // 更新为持久态则清除定时器，否则重新计时
      if (patch.persistent) {
        clearTimer(id);
      } else if (patch.type || patch.title) {
        schedule(id, DEFAULT_DURATION);
      }
    },
    [clearTimer, schedule],
  );

  const clear = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setToasts([]);
  }, []);

  /* 卸载时清理定时器 */
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => push('success', title, message),
      error: (title, message) => push('error', title, message),
      warning: (title, message) => push('warning', title, message),
      info: (title, message) => push('info', title, message),
      destructive: (title, message) => push('destructive', title, message),
      loading,
      update,
      dismiss,
      clear,
    }),
    [push, loading, update, dismiss, clear],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/* ---------------------------------------------------------------------------
   Hook
   --------------------------------------------------------------------------- */

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast 必须在 <ToastProvider> 内部使用');
  }
  return ctx;
}

/* ---------------------------------------------------------------------------
   视图
   --------------------------------------------------------------------------- */

const ICON_PATHS: Record<ToastType, ReactNode> = {
  success: (
    <path
      d="M20 6 9 17l-5-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  error: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 8v4.5M12 16h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  ),
  warning: (
    <>
      <path
        d="M12 3.5 21 19H3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.5v4M12 16.5h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  ),
  info: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 11v5M12 8h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  ),
  /* 圈内对勾：语义仍是「完成」，但用圈把它和普通的成功勾区分开 */
  destructive: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8.3 12.4l2.5 2.5 5-5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

const COLOR_VAR: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  destructive: 'var(--danger)',
};

/** 需要读屏立即播报的类型（失败与不可撤销的操作） */
const ALERT_TYPES: ToastType[] = ['error', 'destructive'];

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" role="region" aria-live="polite" aria-label="通知">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type === 'destructive' ? 'toast-destructive' : ''}`}
          style={{ borderLeftColor: COLOR_VAR[t.type] }}
          role={ALERT_TYPES.includes(t.type) ? 'alert' : 'status'}
        >
          <span
            className="toast-icon"
            style={{ color: COLOR_VAR[t.type] }}
            aria-hidden="true"
          >
            {t.loading ? (
              <svg viewBox="0 0 24 24" width="18" height="18" className="spin">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeDasharray="42 18"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18">
                {ICON_PATHS[t.type]}
              </svg>
            )}
          </span>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.message ? <div className="toast-message">{t.message}</div> : null}
          </div>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(t.id)}
            aria-label="关闭通知"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6 6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
