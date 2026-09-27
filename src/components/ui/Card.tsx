/* ==========================================================================
   ProxCenter — Card / Panel
   ========================================================================== */

import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { IconChevronDown } from '../Icons';

/**
 * 折叠状态经 Context 下传给 CardHeader：卡片可折叠时，按钮要渲染在标题栏
 * 右侧（那里才有位置，也符合「标题即开关」的直觉），而状态归 Card 管。
 */
interface CardCollapse {
  open: boolean;
  toggle: () => void;
}

const CardCollapseContext = createContext<CardCollapse | null>(null);

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** DOM id：页内区块导航的锚点目标（见 layout.css 的 .page-block） */
  id?: string;
  /** 内边距，默认 true */
  padded?: boolean;
  /** 悬浮高亮（可点击卡片）*/
  interactive?: boolean;
  onClick?: () => void;
  /** 无障碍：点击卡的描述 */
  ariaLabel?: string;
  /**
   * 标题栏是否显示折叠按钮（默认开启）。
   * 没有 CardHeader 的卡片自然不会有按钮 —— 没有标题栏就没地方放。
   */
  collapsible?: boolean;
  /** 初始是否展开，默认 true */
  defaultOpen?: boolean;
}

export function Card({
  children,
  className,
  id,
  padded = true,
  interactive = false,
  onClick,
  ariaLabel,
  collapsible = true,
  defaultOpen = true,
}: CardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const collapse = useMemo<CardCollapse | null>(
    () =>
      collapsible
        ? { open, toggle: () => setOpen((value) => !value) }
        : null,
    [collapsible, open],
  );

  const classes = [
    'card',
    padded ? 'card-padded' : '',
    interactive ? 'card-interactive' : '',
    collapsible ? 'card-collapsible' : '',
    collapsible && !open ? 'is-collapsed' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  /* 收起时隐藏标题栏以外的一切，由 .card.is-collapsed 的 CSS 负责；
     这里只保证 Context 能到达 CardHeader。 */
  const content = (
    <CardCollapseContext.Provider value={collapse}>
      {children}
    </CardCollapseContext.Provider>
  );

  if (interactive || onClick) {
    return (
      <div
        className={classes}
        id={id}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <div className={classes} id={id}>
      {content}
    </div>
  );
}

/* --------------------------------------------------------------------------- */

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}

export function CardHeader({ title, subtitle, actions, icon }: CardHeaderProps) {
  const collapse = useContext(CardCollapseContext);

  return (
    <div
      className={`card-header ${collapse ? 'card-header-collapsible' : ''}`}
      /* 整条标题栏都是开关，不必非去瞄准右侧那个小按钮。
         刻意不加 role="button"：标题栏里已经有标题、操作按钮等可交互元素，
         再声明一次按钮会造成嵌套交互，反而干扰读屏。
         键盘与屏幕阅读器依旧走那个带 aria-expanded 的折叠按钮。 */
      onClick={collapse ? collapse.toggle : undefined}
    >
      <div className="card-header-main">
        {icon ? <span className="card-header-icon">{icon}</span> : null}
        <div className="card-header-text">
          <h3 className="card-title">{title}</h3>
          {subtitle ? <div className="card-subtitle">{subtitle}</div> : null}
        </div>
      </div>
      {actions || collapse ? (
        <div
          className="card-header-actions"
          /* 保存 / 刷新这类操作不该顺带把卡片折叠掉 */
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
          {collapse ? (
            <button
              type="button"
              className="card-collapse-btn"
              aria-expanded={collapse.open}
              aria-label={collapse.open ? '收起该模块' : '展开该模块'}
              title={collapse.open ? '收起' : '展开'}
              onClick={(event) => {
                /* 阻止冒泡，否则会连同标题栏的点击一起触发，等于点了两次 */
                event.stopPropagation();
                collapse.toggle();
              }}
            >
              <IconChevronDown size={16} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------- */

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card-body ${className ?? ''}`}>{children}</div>;
}

/* ---------------------------------------------------------------------------
   键值对展示（详情页常用）
   --------------------------------------------------------------------------- */

export function InfoRow({
  label,
  value,
  mono = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`info-row ${className ?? ''}`}>
      <span className="info-label">{label}</span>
      <span className={`info-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}

export function InfoGrid({ children }: { children: ReactNode }) {
  return <div className="info-grid">{children}</div>;
}

/* ---------------------------------------------------------------------------
   KPI 卡片
   --------------------------------------------------------------------------- */

export type KpiTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: KpiTone;
  /** 底部进度条（0~100） */
  progress?: number;
  /** 进度条颜色覆盖 */
  progressColor?: string;
  loading?: boolean;
}

export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = 'accent',
  progress,
  progressColor,
  loading = false,
}: KpiCardProps) {
  if (loading) {
    return (
      <div className="kpi-card">
        <div className="skeleton skeleton-text" style={{ width: '40%' }} />
        <div
          className="skeleton skeleton-text"
          style={{ width: '60%', height: 26, marginTop: 10 }}
        />
        <div
          className="skeleton skeleton-text"
          style={{ width: '80%', marginTop: 12 }}
        />
      </div>
    );
  }

  return (
    <div className={`kpi-card kpi-${tone}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon ? (
          <span className={`kpi-icon kpi-icon-${tone}`} aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="kpi-value">{value}</div>
      {hint ? <div className="kpi-hint">{hint}</div> : null}
      {progress !== undefined ? (
        <div className="kpi-progress" role="presentation">
          <div
            className="kpi-progress-fill"
            /* 进度条做成实心色块，不再加外发光：一排五张卡同时发光时，
               反倒是「哪里有问题」这个信息被淹掉了（浅色主题下尤其明显）。 */
            style={{
              width: `${Math.min(100, Math.max(0, progress))}%`,
              background: progressColor ?? `var(--${tone === 'neutral' ? 'accent' : tone})`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
