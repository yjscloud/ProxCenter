/* ==========================================================================
   ProxCenter — ProgressBar
   资源使用率：青 → 橙 → 红。数值缓动，刷新时平滑滚动。
   ========================================================================== */

export interface ProgressBarProps {
  /** 0~100 */
  value: number;
  /** 自定义颜色；不传则按使用率自动取色 */
  color?: string;
  /** 高度 */
  height?: number;
  /** 右侧显示的文字 */
  label?: string;
  /** 是否显示百分比数字 */
  showValue?: boolean;
  /** 分段式（多段占用，如内存已用/缓存）*/
  segments?: Array<{ value: number; color: string; title?: string }>;
  className?: string;
  /** 无障碍描述 */
  ariaLabel?: string;
}

import { usageColor } from '../../utils/format';
import { useAnimatedNumber } from '../../hooks/useAnimatedNumber';

export function ProgressBar({
  value,
  color,
  height = 6,
  label,
  showValue = false,
  segments,
  className,
  ariaLabel,
}: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value));
  const animated = useAnimatedNumber(pct);
  const fill = color ?? usageColor(pct);

  return (
    <div className={`progress-wrap ${className ?? ''}`}>
      {label || showValue ? (
        <div className="progress-meta">
          {label ? <span className="progress-label">{label}</span> : null}
          {showValue ? (
            <span className="progress-value mono">{animated.toFixed(1)}%</span>
          ) : null}
        </div>
      ) : null}
      <div
        className="progress-track"
        style={{ height }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? label ?? '进度'}
      >
        {segments && segments.length > 0 ? (
          segments.map((s, i) => (
            <div
              key={i}
              className="progress-segment"
              style={{
                width: `${Math.min(100, Math.max(0, s.value))}%`,
                background: s.color,
              }}
              title={s.title}
            />
          ))
        ) : (
          <div
            className="progress-fill"
            style={{
              width: `${animated}%`,
              background: fill,
              boxShadow: `0 0 6px -1px ${fill}`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   使用率行：label + 数值 + 进度条
   --------------------------------------------------------------------------- */

export function UsageRow({
  label,
  used,
  total,
  /** 已格式化好的文字，若提供则覆盖 used/total 显示 */
  text,
  /** 0~100 */
  percent,
  color,
}: {
  label: string;
  used?: number;
  total?: number;
  text?: string;
  percent: number;
  color?: string;
}) {
  const display =
    text ??
    (used !== undefined && total !== undefined
      ? `${formatLocal(used)} / ${formatLocal(total)}`
      : '');

  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-label">{label}</span>
        <span className="usage-row-text mono">{display}</span>
      </div>
      <ProgressBar value={percent} color={color} height={6} />
    </div>
  );
}

/* 本地小工具，避免在组件里再 import 一次 formatBytes 造成循环感的可读性问题 */
function formatLocal(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/* ---------------------------------------------------------------------------
   InlineMeter：表格单元格里的紧凑使用率仪表
   大号数值 + 迷你条，让列表页不点进详情就能看清负载；
   数值每 10 秒随列表刷新平滑滚动，肉眼能看出负载在动。
   --------------------------------------------------------------------------- */

export function InlineMeter({
  percent,
  text,
  sub,
  title,
  dim = false,
  width,
}: {
  /** 0~100 */
  percent: number;
  /** 主数值（已格式化）；不传则显示百分比 */
  text?: string;
  /** 次要说明，如「/ 4 核」「/ 8 GB」 */
  sub?: string;
  title?: string;
  /** 已停止的虚拟机等场景：灰显且不画条 */
  dim?: boolean;
  width?: number;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  const animated = useAnimatedNumber(dim ? 0 : pct);
  const color = dim ? 'var(--text-muted)' : usageColor(pct);

  return (
    <div className="inline-meter" style={width ? { width } : undefined} title={title}>
      <div className="inline-meter-head">
        <span className="inline-meter-value mono" style={{ color }}>
          {text ?? `${animated.toFixed(1)}%`}
        </span>
        {sub ? <span className="inline-meter-sub mono">{sub}</span> : null}
      </div>
      <div className="inline-meter-track">
        <div
          className="inline-meter-fill"
          style={{
            width: `${animated}%`,
            background: color,
            boxShadow: dim ? 'none' : `0 0 6px -1px ${color}`,
          }}
        />
      </div>
    </div>
  );
}
