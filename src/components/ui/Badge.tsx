/* ==========================================================================
   ProxCenter — Badge 状态徽章（带圆点）
   ========================================================================== */

import type { ReactNode } from 'react';
import type { BadgeVariant } from '../../api/types';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  /** 显示左侧圆点 */
  dot?: boolean;
  /** 圆点脉冲动画（运行中状态）*/
  pulse?: boolean;
  /** 小号 */
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

export function Badge({
  children,
  variant = 'neutral',
  dot = false,
  pulse = false,
  size = 'md',
  className,
  title,
}: BadgeProps) {
  const classes = [
    'badge',
    `badge-${variant}`,
    `badge-${size}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} title={title}>
      {dot ? (
        <span
          className={`badge-dot ${pulse ? 'badge-dot-pulse' : ''}`}
          aria-hidden="true"
        />
      ) : null}
      <span className="badge-text">{children}</span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
   标签（tags）
   --------------------------------------------------------------------------- */

export function Tag({
  children,
  onRemove,
  className,
}: {
  children: ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span className={`tag ${className ?? ''}`}>
      {children}
      {onRemove ? (
        <button
          type="button"
          className="tag-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="移除标签"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function TagList({
  tags,
  max = 3,
}: {
  tags: string[];
  max?: number;
}) {
  if (tags.length === 0) return <span className="text-muted">—</span>;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;

  return (
    <span className="tag-list">
      {shown.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
      {rest > 0 ? (
        <span className="tag tag-more" title={tags.join(', ')}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
