/* ==========================================================================
   ProxCenter — Spinner / Skeleton 加载态
   ========================================================================== */

import type { CSSProperties } from 'react';
import { useT } from '../../i18n';

export interface SpinnerProps {
  size?: number;
  className?: string;
  /** 无障碍标签 */
  label?: string;
}

export function Spinner({ size = 20, className, label }: SpinnerProps) {
  const t = useT();
  return (
    <span
      className={`spinner ${className ?? ''}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label={label ?? t('common.loading')}
    >
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeDasharray="46 16"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Skeleton
   --------------------------------------------------------------------------- */

export function Skeleton({
  width,
  height = 14,
  radius = 4,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skeleton ${className ?? ''}`}
      style={{
        width: width ?? '100%',
        height,
        borderRadius: radius,
        display: 'block',
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

/** 表格骨架屏 */
export function TableSkeleton({
  rows = 6,
  cols = 6,
}: {
  rows?: number;
  cols?: number;
}) {
  const t = useT();
  return (
    <div className="table-skeleton" role="status" aria-label={t('state.loadingTable')}>
      <div className="table-skeleton-head">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} height={12} width={`${60 + ((i * 17) % 40)}%`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div className="table-skeleton-row" key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              height={12}
              width={`${45 + ((r * 13 + c * 29) % 50)}%`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 卡片网格骨架屏 */
export function CardSkeleton({
  count = 4,
  height = 120,
}: {
  count?: number;
  height?: number;
}) {
  const t = useT();
  return (
    <div className="grid grid-auto-280" role="status" aria-label={t('state.loadingCards')}>
      {Array.from({ length: count }).map((_, i) => (
        <div className="card card-padded" key={i}>
          <Skeleton width="55%" height={15} />
          <Skeleton width="80%" height={11} style={{ marginTop: 12 }} />
          <Skeleton width="70%" height={11} style={{ marginTop: 8 }} />
          <Skeleton height={height / 3} style={{ marginTop: 14 }} radius={6} />
        </div>
      ))}
    </div>
  );
}

/** 详情页骨架屏 */
export function DetailSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-label={t('state.loadingDetail')}>
      <div className="flex gap-12 items-center mb-24">
        <Skeleton width={200} height={22} />
        <Skeleton width={80} height={22} radius={999} />
      </div>
      <div className="grid grid-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="card card-padded" key={i}>
            <Skeleton width="40%" height={14} />
            {Array.from({ length: 4 }).map((__, j) => (
              <Skeleton
                key={j}
                height={11}
                style={{ marginTop: 14 }}
                width={`${60 + ((i * 11 + j * 23) % 35)}%`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 图表骨架屏 */
export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="chart-skeleton" style={{ height }} aria-hidden="true">
      <div className="chart-skeleton-bars">
        {Array.from({ length: 22 }).map((_, i) => (
          <span
            key={i}
            style={{ height: `${25 + ((i * 37) % 65)}%` }}
            className="chart-skeleton-bar"
          />
        ))}
      </div>
    </div>
  );
}
