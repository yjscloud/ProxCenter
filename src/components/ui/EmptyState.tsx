/* ==========================================================================
   ProxCenter — EmptyState / ErrorState
   ========================================================================== */

import type { ReactNode } from 'react';
import { IconAlert, IconInfo } from '../Icons';
import { useT } from '../../i18n';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** 操作按钮 */
  action?: ReactNode;
  icon?: ReactNode;
  /** 紧凑版（表格内使用）*/
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={`empty-state ${compact ? 'is-compact' : ''}`}>
      <div className="empty-icon" aria-hidden="true">
        {icon ?? <IconInfo size={compact ? 24 : 32} />}
      </div>
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-description">{description}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   错误态
   --------------------------------------------------------------------------- */

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  /** 功能未实现时的友好提示 */
  notImplemented?: boolean;
  /**
   * 附加操作，与「重试」并列。
   *
   * 给「报错之外还有一条明确的出路」用：例如页面连不上 PVE 时，除了重试，
   * 管理员更该去检查连接配置。没有它，红色报错就是一堵墙 —— 用户只能去翻文档。
   */
  action?: ReactNode;
}

export function ErrorState({
  title,
  message,
  onRetry,
  notImplemented = false,
  action,
}: ErrorStateProps) {
  const t = useT();
  return (
    <div className={`error-state ${notImplemented ? 'is-info' : ''}`} role="alert">
      <div className="error-icon" aria-hidden="true">
        {notImplemented ? <IconInfo size={26} /> : <IconAlert size={26} />}
      </div>
      <div className="error-body">
        <div className="error-title">
          {title ?? (notImplemented ? t('state.notImplemented') : t('state.loadFailed'))}
        </div>
        {message ? <div className="error-message">{message}</div> : null}
      </div>
      {onRetry || action ? (
        <div className="error-actions">
          {action}
          {onRetry ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   行内提示条
   --------------------------------------------------------------------------- */

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  icon,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="notice-icon" aria-hidden="true">
        {icon ?? <IconInfo size={16} />}
      </span>
      <div className="notice-content">
        {title ? <div className="notice-title">{title}</div> : null}
        {children ? <div className="notice-text">{children}</div> : null}
      </div>
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   可折叠说明卡片
   --------------------------------------------------------------------------- */

export function CollapsibleCard({
  title,
  children,
  defaultOpen = false,
  icon,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
}) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary className="collapsible-summary">
        {icon ? <span className="collapsible-icon">{icon}</span> : null}
        <span className="collapsible-title">{title}</span>
        <span className="collapsible-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
