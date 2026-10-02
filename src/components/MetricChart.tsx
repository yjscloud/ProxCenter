/* ==========================================================================
   ProxCenter — MetricChart（基于 recharts 的监控图表）
   浅色主题适配 + 动态读数：数值缓动滚动、曲线刷新带动画。
   ========================================================================== */

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from 'recharts';
import type { ReactNode } from 'react';
import type { RrdPoint } from '../api/types';
import { ChartSkeleton } from './ui/Spinner';
import { EmptyState } from './ui/EmptyState';
import { ErrorState } from './ui/EmptyState';
import { formatBytes, formatTimeLabel, toPercent } from '../utils/format';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { useT } from '../i18n';

/* ---------------------------------------------------------------------------
   主题色常量（与 theme.css 的令牌色保持一致）
   --------------------------------------------------------------------------- */

export const CHART_COLORS = {
  accent: '#0052d9',
  success: '#2ba471',
  warning: '#e37318',
  danger: '#d54941',
  purple: '#7d5fff',
  cyan: '#00a4ff',
  grey: '#a9aeb8',
  netIn: '#2ba471',
  netOut: '#7d5fff',
  diskRead: '#0052d9',
  diskWrite: '#e37318',
} as const;

/* 坐标轴：浅色下用中性灰，不与数据抢视觉 */
const AXIS_STYLE = {
  stroke: '#c9cdd4',
  fontSize: 11,
} as const;

const GRID_STYLE = {
  stroke: 'rgba(0, 0, 0, 0.07)',
  strokeDasharray: '4 4',
} as const;

/* 曲线刷新的动画时长：面板每几秒刷新一次，动画要快而不闪 */
const ANIM_MS = 450;

/* 图表卡片的「当前值」条目 */
export interface ChartStat {
  label: string;
  value: string;
  color?: string;
}

/* ---------------------------------------------------------------------------
   通用外壳
   --------------------------------------------------------------------------- */

export interface ChartCardProps {
  title: string;
  legend?: Array<{ label: string; color: string }>;
  actions?: ReactNode;
  /** 标题区的关键读数：不用读曲线就能看到当前值 */
  stats?: ChartStat[];
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  height?: number;
  children: ReactNode;
  className?: string;
}

export function ChartCard({
  title,
  legend,
  actions,
  stats,
  loading = false,
  error,
  empty = false,
  height = 290,
  children,
  className,
}: ChartCardProps) {
  const t = useT();
  return (
    <div className={`chart-wrap ${className ?? ''}`}>
      <div className="chart-header">
        <div className="chart-header-main">
          <div className="chart-title">{title}</div>
          {stats && stats.length > 0 ? (
            <div className="chart-stats">
              {stats.map((s) => (
                <div className="chart-stat" key={s.label}>
                  <span
                    className="chart-stat-value mono"
                    style={s.color ? { color: s.color } : undefined}
                  >
                    {s.value}
                  </span>
                  <span className="chart-stat-label">{s.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-12">
          {legend && legend.length > 0 ? (
            <div className="chart-legend">
              {legend.map((l) => (
                <span className="chart-legend-item" key={l.label}>
                  <span
                    className="chart-legend-swatch"
                    style={{ background: l.color }}
                    aria-hidden="true"
                  />
                  {l.label}
                </span>
              ))}
            </div>
          ) : null}
          {actions}
        </div>
      </div>

      {loading ? (
        <ChartSkeleton height={height} />
      ) : error ? (
        <ErrorState
          title={t('metric.loadFailed')}
          message={error instanceof Error ? error.message : t('metric.noRrd')}
        />
      ) : empty ? (
        <EmptyState
          title={t('metric.empty')}
          description={t('metric.emptyDesc')}
          compact
        />
      ) : (
        <div style={{ width: '100%', height }}>{children}</div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   时间轴配置
   --------------------------------------------------------------------------- */

function timeSpan(points: RrdPoint[]): number | undefined {
  if (points.length < 2) return undefined;
  const first = points[0]?.time;
  const last = points[points.length - 1]?.time;
  if (typeof first !== 'number' || typeof last !== 'number') return undefined;
  return Math.abs(last - first);
}

function TooltipBox({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string | number;
  }>;
  label?: number | string;
  formatter?: (value: number, key: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">
        {formatTimeLabel(label ?? 0, 86_400)}
      </div>
      {payload.map((p, i) => {
        const key = String(p.dataKey ?? p.name ?? '');
        const raw = typeof p.value === 'number' ? p.value : Number(p.value ?? 0);
        return (
          <div className="chart-tooltip-row" key={`${key}-${i}`}>
            <span
              className="chart-legend-swatch"
              style={{ background: p.color }}
              aria-hidden="true"
            />
            <span className="chart-tooltip-name">{p.name}</span>
            <span className="chart-tooltip-value mono">
              {formatter ? formatter(raw, key) : raw}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   CPU 使用率面积图
   --------------------------------------------------------------------------- */

export function CpuChart({
  points,
  loading,
  error,
}: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  /* Proxmox 的 cpu 是 0~1，也可能是多核累加值 → 归一化 */
  const data = points.map((p) => ({
    time: p.time,
    cpu: Math.min(100, Math.max(0, toPercent(p.cpu ?? 0))),
  }));

  const last = data.length > 0 ? data[data.length - 1].cpu : 0;
  const animatedLast = useAnimatedNumber(last);
  const peak = data.reduce((max, d) => Math.max(max, d.cpu), 0);

  return (
    <ChartCard
      title={t('metric.cpu')}
      stats={[
        {
          label: t('metric.current'),
          value: `${animatedLast.toFixed(1)}%`,
          color: CHART_COLORS.accent,
        },
        { label: t('metric.peak'), value: `${peak.toFixed(1)}%` },
      ]}
      legend={[{ label: 'CPU', color: CHART_COLORS.accent }]}
      loading={loading}
      error={error}
      empty={data.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
          <defs>
            <linearGradient id="gradCpu" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.accent} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART_COLORS.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
            {...AXIS_STYLE}
          />
          <Tooltip
            content={
              <TooltipBox formatter={(v) => `${v.toFixed(1)}%`} />
            }
          />
          <Area
            type="monotone"
            dataKey="cpu"
            name="CPU"
            stroke={CHART_COLORS.accent}
            strokeWidth={2.4}
            fill="url(#gradCpu)"
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------------------
   内存面积图
   --------------------------------------------------------------------------- */

export function MemoryChart({
  points,
  loading,
  error,
}: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const data = points.map((p) => ({
    time: p.time,
    used: p.memused ?? p.mem ?? 0,
    total: p.memtotal ?? p.maxmem ?? 0,
  }));

  const hasTotal = data.some((d) => (d.total ?? 0) > 0);
  const maxMem = hasTotal
    ? Math.max(...data.map((d) => d.total ?? 0)) * 1.05
    : undefined;

  const lastUsed = data.length > 0 ? data[data.length - 1].used : 0;
  const lastTotal = data.length > 0 ? data[data.length - 1].total : 0;
  const animUsed = useAnimatedNumber(lastUsed);
  const animTotal = useAnimatedNumber(lastTotal);

  return (
    <ChartCard
      title={t('metric.mem')}
      stats={[
        {
          label: hasTotal ? t('metric.memUsedTotal') : t('metric.used'),
          value: hasTotal
            ? `${formatBytes(animUsed, 0)} / ${formatBytes(animTotal, 0)}`
            : formatBytes(animUsed, 0),
          color: CHART_COLORS.cyan,
        },
      ]}
      legend={[
        { label: t('metric.used'), color: CHART_COLORS.cyan },
        ...(hasTotal
          ? [{ label: t('metric.total'), color: CHART_COLORS.grey }]
          : []),
      ]}
      loading={loading}
      error={error}
      empty={data.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -6 }}>
          <defs>
            <linearGradient id="gradMemUsed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.cyan} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART_COLORS.cyan} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            domain={maxMem ? [0, maxMem] : ['auto', 'auto']}
            tickFormatter={(v: number) => formatBytes(v, 0)}
            width={64}
            {...AXIS_STYLE}
          />
          <Tooltip content={<TooltipBox formatter={(v) => formatBytes(v)} />} />
          <Area
            type="monotone"
            dataKey="used"
            name={t('metric.used')}
            stroke={CHART_COLORS.cyan}
            strokeWidth={2.4}
            fill="url(#gradMemUsed)"
            animationDuration={ANIM_MS}
          />
          {hasTotal ? (
            <Area
              type="monotone"
              dataKey="total"
              name={t('metric.total')}
              stroke={CHART_COLORS.grey}
              strokeWidth={1.4}
              strokeDasharray="5 5"
              fillOpacity={0}
              animationDuration={ANIM_MS}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------------------
   网络 I/O 面积图
   --------------------------------------------------------------------------- */

export function NetworkChart({
  points,
  loading,
  error,
}: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const data = points.map((p) => ({
    time: p.time,
    netin: p.netin ?? 0,
    netout: p.netout ?? 0,
  }));

  const hasData = data.some((d) => d.netin > 0 || d.netout > 0);
  const lastIn = data.length > 0 ? data[data.length - 1].netin : 0;
  const lastOut = data.length > 0 ? data[data.length - 1].netout : 0;
  const animIn = useAnimatedNumber(lastIn);
  const animOut = useAnimatedNumber(lastOut);

  return (
    <ChartCard
      title={t('metric.net')}
      stats={[
        {
          label: t('metric.in'),
          value: `${formatBytes(animIn, 0)}/s`,
          color: CHART_COLORS.netIn,
        },
        {
          label: t('metric.out'),
          value: `${formatBytes(animOut, 0)}/s`,
          color: CHART_COLORS.netOut,
        },
      ]}
      legend={[
        { label: t('metric.in'), color: CHART_COLORS.netIn },
        { label: t('metric.out'), color: CHART_COLORS.netOut },
      ]}
      loading={loading}
      error={error}
      empty={data.length === 0 || !hasData}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -6 }}>
          <defs>
            <linearGradient id="gradNetIn" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.netIn} stopOpacity={0.34} />
              <stop offset="100%" stopColor={CHART_COLORS.netIn} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradNetOut" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.netOut} stopOpacity={0.34} />
              <stop offset="100%" stopColor={CHART_COLORS.netOut} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            tickFormatter={(v: number) => `${formatBytes(v, 0)}/s`}
            width={76}
            {...AXIS_STYLE}
          />
          <Tooltip content={<TooltipBox formatter={(v) => `${formatBytes(v)}/s`} />} />
          <Area
            type="monotone"
            dataKey="netin"
            name={t('metric.in')}
            stroke={CHART_COLORS.netIn}
            fill="url(#gradNetIn)"
            strokeWidth={2.2}
            animationDuration={ANIM_MS}
          />
          <Area
            type="monotone"
            dataKey="netout"
            name={t('metric.out')}
            stroke={CHART_COLORS.netOut}
            fill="url(#gradNetOut)"
            strokeWidth={2.2}
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------------------
   磁盘 I/O 面积图
   --------------------------------------------------------------------------- */

export function DiskIoChart({
  points,
  loading,
  error,
}: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const data = points.map((p) => ({
    time: p.time,
    read: p.diskread ?? 0,
    write: p.diskwrite ?? 0,
  }));

  const hasData = data.some((d) => d.read > 0 || d.write > 0);
  const lastRead = data.length > 0 ? data[data.length - 1].read : 0;
  const lastWrite = data.length > 0 ? data[data.length - 1].write : 0;
  const animRead = useAnimatedNumber(lastRead);
  const animWrite = useAnimatedNumber(lastWrite);

  return (
    <ChartCard
      title={t('metric.disk')}
      stats={[
        {
          label: t('metric.read'),
          value: `${formatBytes(animRead, 0)}/s`,
          color: CHART_COLORS.diskRead,
        },
        {
          label: t('metric.write'),
          value: `${formatBytes(animWrite, 0)}/s`,
          color: CHART_COLORS.diskWrite,
        },
      ]}
      legend={[
        { label: t('metric.read'), color: CHART_COLORS.diskRead },
        { label: t('metric.write'), color: CHART_COLORS.diskWrite },
      ]}
      loading={loading}
      error={error}
      empty={data.length === 0 || !hasData}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -6 }}>
          <defs>
            <linearGradient id="gradDiskRead" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.diskRead} stopOpacity={0.32} />
              <stop offset="100%" stopColor={CHART_COLORS.diskRead} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradDiskWrite" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.diskWrite} stopOpacity={0.32} />
              <stop offset="100%" stopColor={CHART_COLORS.diskWrite} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            tickFormatter={(v: number) => `${formatBytes(v, 0)}/s`}
            width={76}
            {...AXIS_STYLE}
          />
          <Tooltip content={<TooltipBox formatter={(v) => `${formatBytes(v)}/s`} />} />
          <Area
            type="monotone"
            dataKey="read"
            name={t('metric.read')}
            stroke={CHART_COLORS.diskRead}
            fill="url(#gradDiskRead)"
            strokeWidth={2.2}
            animationDuration={ANIM_MS}
          />
          <Area
            type="monotone"
            dataKey="write"
            name={t('metric.write')}
            stroke={CHART_COLORS.diskWrite}
            fill="url(#gradDiskWrite)"
            strokeWidth={2.2}
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------------------
   环形图（资源分布）
   --------------------------------------------------------------------------- */

export interface DonutDatum {
  name: string;
  value: number;
  color: string;
}

export function DonutChart({
  data,
  height = 220,
  centerLabel,
  centerValue,
  showLegend = true,
}: {
  data: DonutDatum[];
  /**
   * 数字（px）或 CSS 长度（如 '100%'）。
   * 传 '100%' 是给「左图右明细」的卡片用的：环形图跟着卡片高度伸缩，
   * 不再写死一个像素值，卡片被拉高时也不会在下方留一块空白。
   */
  height?: number | string;
  centerLabel?: string;
  centerValue?: string | number;
  /**
   * 是否在底部画 recharts 图例。
   * 关掉之后环形图独占整块高度，明细交给调用方自己排（更像控制台的资源分布卡）。
   */
  showLegend?: boolean;
}) {
  const t = useT();
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <EmptyState title={t('metric.noData')} compact />
      </div>
    );
  }

  return (
    /* has-legend 会在 CSS 里把中心文字上移半个图例高度 ——
       recharts 的图例占掉底部 28px，圆心并不在容器的垂直中点。 */
    <div className={`donut-wrap${showLegend ? ' has-legend' : ''}`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="84%"
            paddingAngle={2}
            stroke="var(--bg-surface)"
            strokeWidth={2}
            animationDuration={ANIM_MS}
          >
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const item = payload[0];
              const value = Number(item.value ?? 0);
              const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-row">
                    <span
                      className="chart-legend-swatch"
                      style={{ background: item.payload?.color }}
                      aria-hidden="true"
                    />
                    <span className="chart-tooltip-name">{item.name}</span>
                    <span className="chart-tooltip-value mono">
                      {value} ({pct}%)
                    </span>
                  </div>
                </div>
              );
            }}
          />
          {showLegend ? (
            <Legend
              verticalAlign="bottom"
              height={28}
              formatter={(value: string) => (
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                  {value}
                </span>
              )}
            />
          ) : null}
        </PieChart>
      </ResponsiveContainer>

      {centerLabel || centerValue !== undefined ? (
        <div className="donut-center" aria-hidden="true">
          <div className="donut-center-value mono">{centerValue}</div>
          <div className="donut-center-label">{centerLabel}</div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   诊断曲线：IO 等待 / 负载 / 根分区 / Swap / PSI 压力
   ---------------------------------------------------------------------------
   这几条曲线的价值在于「定位瓶颈」，而不只是展示用量：
     · iowait 高而 CPU 不高   → 卡在磁盘，加 CPU 没有用
     · 根分区 / Swap 持续上涨  → 迟早写满或开始换页
     · PSI 比平均使用率更早暴露资源争抢
   --------------------------------------------------------------------------- */

/** 通用百分比面积图：IO 等待、根分区、Swap 形态一致，抽出来避免抄三遍。 */
function PercentAreaChart({
  title,
  points,
  valueOf,
  color,
  gradientId,
  loading,
  error,
}: {
  title: string;
  points: RrdPoint[];
  valueOf: (p: RrdPoint) => number | undefined;
  color: string;
  gradientId: string;
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const data = points.map((p) => ({
    time: p.time,
    value: Math.min(100, Math.max(0, valueOf(p) ?? 0)),
  }));

  const last = data.length > 0 ? data[data.length - 1].value : 0;
  const animatedLast = useAnimatedNumber(last);
  const peak = data.reduce((max, d) => Math.max(max, d.value), 0);

  return (
    <ChartCard
      title={title}
      stats={[
        { label: t('metric.current'), value: `${animatedLast.toFixed(1)}%`, color },
        { label: t('metric.peak'), value: `${peak.toFixed(1)}%` },
      ]}
      legend={[{ label: title, color }]}
      loading={loading}
      error={error}
      empty={data.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
            {...AXIS_STYLE}
          />
          <Tooltip content={<TooltipBox formatter={(v) => `${v.toFixed(1)}%`} />} />
          <Area
            type="monotone"
            dataKey="value"
            name={title}
            stroke={color}
            strokeWidth={2.4}
            fill={`url(#${gradientId})`}
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** IO 等待：CPU 用不满但系统发卡，多半卡在这里 */
export function IowaitChart(props: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  return (
    <PercentAreaChart
      title={t('metric.iowait')}
      valueOf={(p) => toPercent(p.iowait ?? 0)}
      color={CHART_COLORS.warning}
      gradientId="gradIowait"
      {...props}
    />
  );
}

/** 根文件系统使用率：日志与备份临时文件都落在这里，写满会直接让服务异常 */
export function FilesystemChart(props: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  return (
    <PercentAreaChart
      title={t('metric.filesystem')}
      valueOf={(p) =>
        p.roottotal && p.roottotal > 0
          ? ((p.rootused ?? 0) / p.roottotal) * 100
          : 0
      }
      color={CHART_COLORS.diskRead}
      gradientId="gradRootfs"
      {...props}
    />
  );
}

/** Swap 使用率：一旦被占用，说明物理内存已经不够了 */
export function SwapChart(props: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const hasSwap = props.points.some((p) => (p.swaptotal ?? 0) > 0);
  /* 没启用 swap 的机器（swaptotal 恒为 0）不画这张图：
     一条永远贴着 0 的直线没有任何信息量，只是占地方。 */
  if (!hasSwap) return null;
  return (
    <PercentAreaChart
      title={t('metric.swap')}
      valueOf={(p) =>
        p.swaptotal && p.swaptotal > 0
          ? ((p.swapused ?? 0) / p.swaptotal) * 100
          : 0
      }
      color={CHART_COLORS.purple}
      gradientId="gradSwap"
      {...props}
    />
  );
}

/** 负载均值：rrddata 只给一个值（与 /status 的三元素数组不同） */
export function LoadChart(props: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const data = props.points.map((p) => {
    const raw = Array.isArray(p.loadavg) ? p.loadavg[0] : p.loadavg;
    return { time: p.time, load: Number(raw) || 0 };
  });

  const last = data.length > 0 ? data[data.length - 1].load : 0;
  const animatedLast = useAnimatedNumber(last);
  const peak = data.reduce((max, d) => Math.max(max, d.load), 0);

  return (
    <ChartCard
      title={t('metric.load')}
      stats={[
        {
          label: t('metric.current'),
          value: animatedLast.toFixed(2),
          color: CHART_COLORS.accent,
        },
        { label: t('metric.peak'), value: peak.toFixed(2) },
      ]}
      legend={[{ label: t('metric.loadSeries'), color: CHART_COLORS.accent }]}
      loading={props.loading}
      error={props.error}
      empty={data.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
          <defs>
            <linearGradient id="gradLoad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.accent} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART_COLORS.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(props.points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis width={48} {...AXIS_STYLE} />
          <Tooltip content={<TooltipBox formatter={(v) => v.toFixed(2)} />} />
          <Area
            type="monotone"
            dataKey="load"
            name={t('metric.loadSeries')}
            stroke={CHART_COLORS.accent}
            strokeWidth={2.4}
            fill="url(#gradLoad)"
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/**
 * PSI 资源压力曲线。
 *
 * PVE 7.2 起引入 PSI，但实测 8.4 的 rrddata 并不返回 pressure* 字段
 * （/nodes/{node}/status 里也没有），所以做成「有数据才展示」：
 * 将来 PVE 版本或配置补上之后曲线会自动出现，不必再改代码。
 */
export function PressureChart(props: {
  points: RrdPoint[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const hasPressure = props.points.some(
    (p) =>
      p.pressurecpusome !== undefined ||
      p.pressureiosome !== undefined ||
      p.pressurememorysome !== undefined,
  );
  if (!hasPressure) return null;

  const data = props.points.map((p) => ({
    time: p.time,
    cpu: toPercent(p.pressurecpusome ?? 0),
    io: toPercent(p.pressureiosome ?? 0),
    mem: toPercent(p.pressurememorysome ?? 0),
  }));

  const last = data.length > 0 ? data[data.length - 1] : { cpu: 0, io: 0, mem: 0 };
  const animCpu = useAnimatedNumber(last.cpu);
  const animIo = useAnimatedNumber(last.io);
  const animMem = useAnimatedNumber(last.mem);

  return (
    <ChartCard
      title={t('metric.pressure')}
      stats={[
        { label: 'CPU', value: `${animCpu.toFixed(1)}%`, color: CHART_COLORS.accent },
        { label: 'IO', value: `${animIo.toFixed(1)}%`, color: CHART_COLORS.warning },
        {
          label: t('metric.memory'),
          value: `${animMem.toFixed(1)}%`,
          color: CHART_COLORS.purple,
        },
      ]}
      legend={[
        { label: 'CPU', color: CHART_COLORS.accent },
        { label: 'IO', color: CHART_COLORS.warning },
        { label: t('metric.memory'), color: CHART_COLORS.purple },
      ]}
      loading={props.loading}
      error={props.error}
      empty={data.length === 0}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
          <CartesianGrid vertical={false} {...GRID_STYLE} />
          <XAxis
            dataKey="time"
            tickFormatter={(v: number) => formatTimeLabel(v, timeSpan(props.points))}
            minTickGap={44}
            {...AXIS_STYLE}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={48}
            {...AXIS_STYLE}
          />
          <Tooltip content={<TooltipBox formatter={(v) => `${v.toFixed(1)}%`} />} />
          <Area
            type="monotone"
            dataKey="cpu"
            name="CPU"
            stroke={CHART_COLORS.accent}
            strokeWidth={2}
            fillOpacity={0}
            animationDuration={ANIM_MS}
          />
          <Area
            type="monotone"
            dataKey="io"
            name="IO"
            stroke={CHART_COLORS.warning}
            strokeWidth={2}
            fillOpacity={0}
            animationDuration={ANIM_MS}
          />
          <Area
            type="monotone"
            dataKey="mem"
            name={t('metric.memory')}
            stroke={CHART_COLORS.purple}
            strokeWidth={2}
            fillOpacity={0}
            animationDuration={ANIM_MS}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
