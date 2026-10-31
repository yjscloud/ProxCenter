/* ==========================================================================
   ProxCenter — 迷你趋势线（Sparkline）
   ==========================================================================
   KPI 卡上的「走向」提示：只画最近若干个采样点，无坐标轴、无交互。
   数据点不足 2 个时直接不渲染 —— 一个点画不出趋势，留白比画一条假线好。
   ========================================================================== */

import { useId } from 'react';

export interface SparklineProps {
  /** 最近若干采样值（按时间先后排列） */
  points: number[];
  /** 线条颜色，默认品牌蓝 */
  color?: string;
  width?: number;
  height?: number;
  /** 读屏摘要；不传则整体对读屏隐藏（KPI 主数值已经表达了当前状态） */
  ariaLabel?: string;
  className?: string;
}

export function Sparkline({
  points,
  color = 'var(--accent)',
  width = 96,
  height = 24,
  ariaLabel,
  className,
}: SparklineProps) {
  const rawId = useId();
  const gradientId = `spark-${rawId.replace(/:/g, '')}`;

  if (!points || points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  /* 上下各留 2px，避免线贴边被裁 */
  const yOf = (value: number) => 2 + (1 - (value - min) / span) * (height - 4);
  const coords = points.map((value, index) => ({
    x: index * stepX,
    y: yOf(value),
  }));

  const linePath = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L${width} ${height} L0 ${height} Z`;

  return (
    <svg
      className={`sparkline ${className ?? ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 末点加一个实心圆：让人一眼看出「最新值在哪一端」 */}
      <circle
        cx={coords[coords.length - 1].x}
        cy={coords[coords.length - 1].y}
        r={2}
        fill={color}
      />
    </svg>
  );
}
