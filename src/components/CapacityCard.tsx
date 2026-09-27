/* ==========================================================================
   ProxCenter — 容量预测卡片
   基于后端 /dashboard/capacity：把节点磁盘历史拼成时间线，线性外推满容时间。
   ========================================================================== */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CapacityForecast } from '../api/types';
import { Card, CardHeader } from './ui/Card';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/EmptyState';
import { ErrorState } from './ui/EmptyState';
import { SegmentedControl } from './ui/Input';
import { ChartSkeleton } from './ui/Spinner';
import { formatBytes, formatTimeLabel, trendColor } from '../utils/format';

const AXIS_STYLE = { stroke: '#c9cdd4', fontSize: 11 } as const;
const GRID_STYLE = { stroke: 'rgba(0,0,0,0.07)', strokeDasharray: '4 4' } as const;

const HORIZON_CAP = 720; // 投影最多画 720 天，避免曲线被拉平

/**
 * X 轴刻度的粒度跟着跨度走。
 *
 * 不能直接用 formatTimeLabel：它对超过一天的跨度一律输出「09-01 08:00」，
 * 而容量预测的跨度动辄几十天（历史 30 天 + 投影 54 天），一年窗口下这串标签
 * 会横向挤成一排。跨度大了之后「哪一天」才是坐标，时刻没有意义。
 */
function axisTick(value: number, span: number): string {
  const d = new Date(value * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  if (span > 86_400 * 8) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return formatTimeLabel(value, span);
}

/** 后端 rrddata 支持的三种回溯窗口 */
export type CapacityTimeframe = 'week' | 'month' | 'year';

const WINDOW_LABEL: Record<CapacityTimeframe, string> = {
  week: '近 7 天',
  month: '近 30 天',
  year: '近 1 年',
};

const TIMEFRAME_OPTIONS: Array<{ label: string; value: CapacityTimeframe }> = [
  { label: '1 周', value: 'week' },
  { label: '1 月', value: 'month' },
  { label: '1 年', value: 'year' },
];

interface ChartDatum {
  time: number;
  used: number | null;
  proj: number | null;
}

function buildData(forecast: CapacityForecast): {
  data: ChartDatum[];
  span: number;
} {
  const hist = forecast.history;
  if (hist.length === 0) return { data: [], span: 0 };

  const first = hist[0].time;
  const last = hist[hist.length - 1];
  const data: ChartDatum[] = hist.map((p) => ({
    time: p.time,
    used: p.used,
    proj: null,
  }));

  // 投影起点与历史末端重合，保证虚线从曲线尾部接出来
  const slope = forecast.daily_rate_bytes ?? 0;

  let horizon: number;
  if (forecast.days_to_full != null) {
    horizon = Math.min(forecast.days_to_full, HORIZON_CAP);
  } else if (slope <= 0) {
    horizon = 180; // 无增长：展示一段平稳/下降的趋势
  } else {
    horizon = HORIZON_CAP;
  }

  data.push({ time: last.time, used: last.used, proj: last.used });
  for (let d = 1; d <= horizon; d++) {
    const t = last.time + d * 86_400;
    const v = last.used + slope * d;
    data.push({ time: t, used: null, proj: Math.max(0, v) });
  }

  return { data, span: data.length > 1 ? data[data.length - 1].time - first : 0 };
}

function TooltipBox({
  active,
  payload,
  label,
  span,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | null; dataKey?: string | number; color?: string }>;
  label?: number | string;
  span?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload.find((p) => p.value != null);
  if (!point || point.value == null) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">
        {formatTimeLabel(label ?? 0, span ?? 86_400 * 30)}
      </div>
      <div className="chart-tooltip-row">
        <span className="chart-tooltip-name">
          {point.dataKey === 'proj' ? '预测已用' : '已用'}
        </span>
        <span className="chart-tooltip-value mono">
          {formatBytes(point.value, 0)}
        </span>
      </div>
    </div>
  );
}

export function CapacityCard({
  forecast,
  loading,
  error,
  timeframe = 'month',
  onTimeframeChange,
}: {
  forecast: CapacityForecast | undefined;
  loading?: boolean;
  error?: unknown;
  timeframe?: CapacityTimeframe;
  onTimeframeChange?: (value: CapacityTimeframe) => void;
}) {
  const hasData = !!forecast && forecast.history.length >= 2;
  const { data, span } = hasData ? buildData(forecast) : { data: [], span: 0 };
  const windowLabel = WINDOW_LABEL[timeframe];

  /* ---- 满容结论 ---- */
  let verdict: { text: string; tone: 'danger' | 'warning' | 'success' | 'neutral' };
  if (!forecast || forecast.history.length < 2) {
    verdict = { text: '数据不足（需节点磁盘历史）', tone: 'neutral' };
  } else if (forecast.days_to_full != null) {
    const days = Math.round(forecast.days_to_full);
    verdict = {
      text: `预计 ${days.toLocaleString('zh-CN')} 天后写满`,
      tone: days < 90 ? 'danger' : days < 365 ? 'warning' : 'success',
    };
  } else if ((forecast.daily_rate_bytes ?? 0) < 0) {
    /* 负增长说明在清空间（删备份 / 清日志），不是「平稳」也不是「要满」 */
    verdict = { text: `${windowLabel}用量在下降`, tone: 'success' };
  } else if ((forecast.daily_rate_bytes ?? 0) === 0) {
    verdict = { text: `${windowLabel}趋势平稳`, tone: 'success' };
  } else {
    verdict = { text: '已接近满容', tone: 'danger' };
  }

  const rate = forecast?.daily_rate_bytes ?? null;
  const used = forecast?.current_used ?? 0;
  const total = forecast?.total_bytes ?? 0;
  const usedPct = total > 0 ? (used / total) * 100 : 0;

  return (
    <Card>
      <CardHeader
        title="磁盘容量预测"
        subtitle={`基于${windowLabel}节点根分区趋势线性外推`}
        icon={<span className="fs-lg">📈</span>}
        actions={
          <>
            {onTimeframeChange ? (
              <SegmentedControl<CapacityTimeframe>
                value={timeframe}
                onChange={onTimeframeChange}
                ariaLabel="容量趋势回溯窗口"
                options={TIMEFRAME_OPTIONS}
              />
            ) : null}
            <Badge variant={verdict.tone}>{verdict.text}</Badge>
          </>
        }
      />

      {/* 切换回溯窗口会重新取数：这段时间先占位，
          否则会闪出「0 B / 0 B」这种明显错误的读数 */}
      {!forecast && loading ? (
        <div className="capacity-summary">
          {[0, 1, 2].map((i) => (
            <div className="capacity-stat" key={i}>
              <span
                className="skeleton skeleton-text"
                style={{ width: 88, height: 20 }}
              />
              <span
                className="skeleton skeleton-text"
                style={{ width: 52, height: 12, marginTop: 4 }}
              />
            </div>
          ))}
        </div>
      ) : forecast ? (
        <div className="capacity-summary">
          <div className="capacity-stat">
            <span className="capacity-stat-value mono">
              {formatBytes(used, 0)}
              <span className="fs-xs text-muted"> / {formatBytes(total, 0)}</span>
            </span>
            <span className="capacity-stat-label">当前已用</span>
          </div>
          <div className="capacity-stat">
            <span
              className="capacity-stat-value mono"
              style={{
                color: rate != null && rate !== 0 ? trendColor(rate) : undefined,
              }}
            >
              {/* formatBytes 对负数一律返回「—」，增速为负时得自己带上符号 */}
              {rate == null
                ? '—'
                : `${rate >= 0 ? '+' : '-'}${formatBytes(Math.abs(rate), 0)}/天`}
            </span>
            <span className="capacity-stat-label">
              {rate != null && rate < 0 ? '日均回落' : '日均增长'}
            </span>
          </div>
          <div className="capacity-stat">
            <span className="capacity-stat-value mono">{usedPct.toFixed(1)}%</span>
            <span className="capacity-stat-label">已用占比</span>
          </div>
        </div>
      ) : null}

      {loading ? (
        <ChartSkeleton height={200} />
      ) : error ? (
        <ErrorState title="加载容量数据失败" message="无法获取节点磁盘历史。" />
      ) : !hasData ? (
        <EmptyState
          title="暂无容量数据"
          description="节点未上报磁盘历史，无法预测满容时间。"
          compact
        />
      ) : (
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            {/* 必须是 ComposedChart 而不是 AreaChart：
                recharts 的 AreaChart 只渲染 Area 子节点，混在里面的 <Line>
                会被静默丢掉 —— 表现是「投影虚线根本不画、右半边整图表空白，
                连容量上限参考线也不出现」（参考线在 y 轴域外时同样不画，
                而域是由实际渲染的曲线算出来的，于是互为因果）。
                ComposedChart 才是官方支持的 Area + Line 组合容器。 */}
            <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
              <defs>
                <linearGradient id="gradCapacity" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0052d9" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#0052d9" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} {...GRID_STYLE} />
              <XAxis
                dataKey="time"
                tickFormatter={(v: number) => axisTick(v, span || 86_400 * 30)}
                minTickGap={48}
                {...AXIS_STYLE}
              />
              <YAxis
                tickFormatter={(v: number) => formatBytes(v, 0)}
                width={72}
                {...AXIS_STYLE}
              />
              <Tooltip content={<TooltipBox span={span} />} />
              <ReferenceLine
                y={total}
                stroke="#d54941"
                strokeDasharray="6 4"
                label={{
                  value: '容量上限',
                  position: 'insideTopRight',
                  fontSize: 10,
                  fill: '#d54941',
                }}
              />
              <Area
                type="monotone"
                dataKey="used"
                name="已用"
                stroke="#0052d9"
                strokeWidth={2.4}
                fill="url(#gradCapacity)"
                connectNulls={false}
                animationDuration={450}
              />
              <Line
                type="monotone"
                dataKey="proj"
                name="预测"
                stroke="#e37318"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls={false}
                animationDuration={450}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
