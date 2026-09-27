/* ==========================================================================
   ProxCenter — Button
   ========================================================================== */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 左侧图标 */
  icon?: ReactNode;
  /** 右侧图标 */
  iconRight?: ReactNode;
  loading?: boolean;
  /** 撑满父容器宽度 */
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    block ? 'btn-block' : '',
    loading ? 'is-loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="btn-spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeDasharray="42 18"
              strokeLinecap="round"
            />
          </svg>
        </span>
      ) : (
        icon && <span className="btn-icon">{icon}</span>
      )}
      {children != null && children !== '' ? (
        <span className="btn-label">{children}</span>
      ) : null}
      {iconRight ? <span className="btn-icon">{iconRight}</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   按钮组 & 图标按钮
   --------------------------------------------------------------------------- */

export function ButtonGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`btn-group ${className ?? ''}`} role="group">
      {children}
    </div>
  );
}

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 无障碍标签（必填，图标按钮无可见文字）*/
  label: string;
  children: ReactNode;
}

export function IconButton({
  variant = 'ghost',
  label,
  children,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={`btn-icon-only btn-${variant} ${className ?? ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}
