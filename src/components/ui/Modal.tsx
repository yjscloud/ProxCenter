/* ==========================================================================
   ProxCenter — Modal（Esc 关闭、焦点陷阱、role=dialog）
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import { IconClose } from '../Icons';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 标题下方描述 */
  description?: ReactNode;
  children: ReactNode;
  /** 底部操作区 */
  footer?: ReactNode;
  size?: ModalSize;
  /** 点击遮罩关闭，默认 true */
  closeOnOverlay?: boolean;
  /** Esc 关闭，默认 true */
  closeOnEsc?: boolean;
  /** 隐藏右上角关闭按钮（危险操作流程中）*/
  hideClose?: boolean;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlay = true,
  closeOnEsc = true,
  hideClose = false,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  /* 调用方常把 onClose 写成内联箭头函数（每次渲染都是新引用）。用 ref 兜住，
     否则 handleKeyDown 会跟着每次重建，事件监听器也随之反复解绑 / 重绑。 */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /* ---- Esc 关闭 + Tab 焦点陷阱 ---- */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const nodes = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [closeOnEsc],
  );

  /* ---- 打开时：记录焦点、锁定滚动、聚焦弹窗 ----
     这个 effect 只能依赖 open。它一旦跟着 handleKeyDown 走，就会随调用方的每次
     重渲染重跑，里面的 setTimeout 会把焦点强行抢回弹窗第一个可交互元素 ——
     表现就是表单里每输入一个字符，输入框立刻失焦，根本没法连续输入。 */
  useEffect(() => {
    if (!open) return;

    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 聚焦第一个可交互元素，否则聚焦容器
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    }, 20);

    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      lastFocusedRef.current?.focus?.();
    };
  }, [open]);

  /* ---- 键盘监听：单独一个 effect，重绑监听器本身没有副作用 ---- */
  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div className="modal-layer" role="presentation">
      <div
        className="modal-overlay"
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className={`modal modal-${size} ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '对话框'}
        tabIndex={-1}
      >
        {title || !hideClose ? (
          <div className="modal-header">
            <div className="modal-header-text">
              {title ? <h2 className="modal-title">{title}</h2> : null}
              {description ? (
                <p className="modal-description">{description}</p>
              ) : null}
            </div>
            {!hideClose ? (
              <IconButton label="关闭对话框" onClick={onClose}>
                <IconClose size={16} />
              </IconButton>
            ) : null}
          </div>
        ) : null}

        <div className="modal-body">{children}</div>

        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------------------
   抽屉（侧滑面板，任务日志等）
   --------------------------------------------------------------------------- */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 宽度 */
  width?: number;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 620,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="drawer-layer" role="presentation">
      <div className="drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '详情面板'}
      >
        <div className="drawer-header">
          <div className="drawer-header-text">
            {title ? <h2 className="drawer-title">{title}</h2> : null}
            {subtitle ? <div className="drawer-subtitle">{subtitle}</div> : null}
          </div>
          <IconButton label="关闭面板" onClick={onClose}>
            <IconClose size={16} />
          </IconButton>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}
