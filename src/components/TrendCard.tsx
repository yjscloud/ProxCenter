/* ==========================================================================
   ProxCenter — 巡检趋势卡片

   数据来自 /api/{baseline,ports}/history（按小时桶汇总的巡检结果）。
   安全基线与端口巡检共用这一个组件，差异只在 series（画哪几条线）。

   文案全部走 t()：series 只存 key，label 在渲染时取 —— 模块级常量里放中文
   会让文案停在首次加载时的语言（详见 CapacityCard 的同一条注释）。
   ========================================================================== */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { InspectionTrend } from '../api/types';
import { Card, CardHeader } from './ui/Card';
import { EmptyState, ErrorState } from './ui/EmptyState';
import { ChartSkeleton } from './ui/Spinner';
import { formatTimeLabel } from '../utils/format';
import { useT, type MessageKey } from '../i18n';

const AXIS_STYLE = { stroke: '#c9cdd4', fontSize: 11 } as const;
const GRID_STYLE = { stroke: 'rgba(0,0,0,0.07)', strokeDasharray: '4 4' } as const;

/** 一条曲线：area（面积，通常给主指标）或 line（折线） */
export interface TrendSeries {
  /** 对应趋势点里的字段名（score / fail / warn / issues） */
  key: string;
  labelKey: MessageKey;
  type: 'area' | 'line';
  /** 挂在左轴还是右轴（左轴一般是评分 / 合计，右轴是分项数量） */
  axis: 'left' | 'right';
  color: string;
  /** 左轴的值域；不给则由数据决定 */
  domain?: [number, number];
}

interface TrendDatum {
  ts: number;
  [key: string]: number;
}

const SERIES_COLORS = {
  score: '#0052d9',
  fail: '#d54941',
  warn: '#e37318',
  issues: '#e37318',
} as const;

/** 基线趋势：评分（左轴 0-100，面积）+ 不合格 / 待改进（右轴折线） */
export const BASELINE_TREND_SERIES: TrendSeries[] = [
  {
    key: 'score',
    labelKey: 'trend.score',
    type: 'area',
    axis: 'left',
    color: SERIES_COLORS.score,
    domain: [0, 100],
  },
  { key: 'fail', labelKey: 'trend.fail', type: 'line', axis: 'right', color: SERIES_COLORS.fail },
  { key: 'warn', labelKey: 'trend.warn', type: 'line', axis: 'right', color: SERIES_COLORS.warn },
];

/** 端口趋势：问题合计（面积）+ 可疑进程（折线，更严重） */
export const PORTS_TREND_SERIES: TrendSeries[] = [
  { key: 'issues', labelKey: 'trend.issues', type: 'area', axis: 'left', color: SERIES_COLORS.issues },
  { key: 'fail', labelKey: 'trend.suspicious', type: 'line', axis: 'left', color: SERIES_COLORS.fail },
];

/** X 轴刻度：跨度大于一周就只标「月-日」，否则交给 formatTimeLabel */
function axisTick(value: number, span: number): string {
  const d = new Date(value * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  if (span > 86_400 * 8) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return formatTimeLabel(value, span);
}

export function TrendCard({
  title,
  subtitle,
  trend,
  series,
  loading,
  error,
}: {
  title: string;
  subtitle?: string;
  trend: InspectionTrend | undefined;
  series: TrendSeries[];
  loading?: boolean;
  error?: unknown;
}) {
  const t = useT();
  const points = trend?.points ?? [];
  const hasData = points.length >= 2;

  const data: TrendDatum[] = points.map((p) => {
    const row: TrendDatum = { ts: p.ts, score: p.score, fail: p.fail, warn: p.warn };
    /* 端口趋势用 issues（问题合计）；后端只在单机序列里给，全平台序列没有就
       退化成 fail + warn，保证两种视图下曲线都有意义。 */
    row.issues = p.issues ?? p.fail + p.warn;
    return row;
  });
  const span = hasData ? data[data.length - 1].ts - data[0].ts : 0;
  const hasLeft = series.some((s) => s.axis === 'left');
  const hasRight = series.some((s) => s.axis === 'right');
  const leftDomain = series.find((s) => s.axis === 'left')?.domain;

  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} icon={<span className="fs-lg">📉</span>} />
      {loading ? (
        <ChartSkeleton height={180} />
      ) : error ? (
        <ErrorState title={t('trend.loadFailed')} message={t('trend.loadFailedMsg')} />
      ) : !hasData ? (
        <EmptyState
          title={t('trend.empty')}
          description={t('trend.emptyDesc')}
          compact
        />
      ) : (
        <div style={{ width: '100%', height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} {...GRID_STYLE} />
              <XAxis
                dataKey="ts"
                tickFormatter={(v: number) => axisTick(v, span || 86_400 * 7)}
                minTickGap={40}
                {...AXIS_STYLE}
              />
              {hasLeft ? (
                <YAxis
                  yAxisId="left"
                  domain={leftDomain ?? [0, 'auto']}
                  width={40}
                  {...AXIS_STYLE}
                />
              ) : null}
              {hasRight ? (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  allowDecimals={false}
                  width={36}
                  {...AXIS_STYLE}
                />
              ) : null}
              <Tooltip
                labelFormatter={(v) => formatTimeLabel(Number(v), span || 86_400 * 7)}
                contentStyle={{ fontSize: 12 }}
              />
              {series.map((s) =>
                s.type === 'area' ? (
                  <Area
                    key={s.key}
                    yAxisId={s.axis}
                    type="monotone"
                    dataKey={s.key}
                    name={t(s.labelKey)}
                    stroke={s.color}
                    strokeWidth={2.2}
                    fill={s.color}
                    fillOpacity={0.14}
                    connectNulls
                    animationDuration={450}
                  />
                ) : (
                  <Line
                    key={s.key}
                    yAxisId={s.axis}
                    type="monotone"
                    dataKey={s.key}
                    name={t(s.labelKey)}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    animationDuration={450}
                  />
                ),
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
