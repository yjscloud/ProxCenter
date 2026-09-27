/* ==========================================================================
   ProxCenter — ConfirmDialog（二次确认，危险操作）
   ========================================================================== */

import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Input } from './Input';
import { Notice } from './EmptyState';

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /** 主体描述 */
  message?: ReactNode;
  /** 额外内容（表单等）*/
  children?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（红色按钮 + 图标）*/
  danger?: boolean;
  /** 需要用户输入指定文本才能确认（如删除时输入 VM 名称）*/
  requireText?: string;
  /** 确认按钮 loading */
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  children,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  requireText,
  loading = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  /* 每次打开重置输入 */
  useEffect(() => {
    if (open) {
      setTyped('');
      setBusy(false);
    }
  }, [open]);

  const textOk = !requireText || typed.trim() === requireText;
  const isBusy = busy || loading;

  const handleConfirm = async () => {
    if (!textOk || isBusy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={isBusy ? () => undefined : onCancel}
      title={title}
      size="sm"
      closeOnOverlay={!isBusy}
      hideClose={isBusy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isBusy}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={handleConfirm}
            loading={isBusy}
            disabled={!textOk}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="confirm-body">
        {danger ? (
          <Notice tone="danger" title="此操作不可撤销">
            {message ?? '请确认你了解该操作的影响。'}
          </Notice>
        ) : message ? (
          <div className="confirm-message">{message}</div>
        ) : null}

        {children ? <div className="confirm-extra">{children}</div> : null}

        {requireText ? (
          <Input
            label={`请输入 "${requireText}" 以确认`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={requireText}
            autoComplete="off"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConfirm();
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   Hook：命令式使用确认框
   --------------------------------------------------------------------------- */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  children?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  requireText?: string;
}

/**
 * 返回 [dialogElement, confirm]。
 * confirm(options) 返回 Promise<boolean>。
 *
 * 用法：
 * ```tsx
 * const [confirmEl, confirm] = useConfirm();
 * ...
 * if (await confirm({ title: '删除？', danger: true })) { ... }
 * return <>{confirmEl}...</>;
 * ```
 */
export function useConfirm(): [
  ReactNode,
  (options: ConfirmOptions) => Promise<boolean>,
] {
  const [state, setState] = useState<{
    options: ConfirmOptions | null;
    resolve: ((v: boolean) => void) | null;
  }>({ options: null, resolve: null });

  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      setState({ options, resolve });
    });

  const close = (result: boolean) => {
    state.resolve?.(result);
    setState({ options: null, resolve: null });
  };

  const element = state.options ? (
    <ConfirmDialog
      open
      title={state.options.title}
      message={state.options.message}
      confirmText={state.options.confirmText}
      cancelText={state.options.cancelText}
      danger={state.options.danger}
      requireText={state.options.requireText}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    >
      {state.options.children}
    </ConfirmDialog>
  ) : null;

  return [element, confirm];
}
