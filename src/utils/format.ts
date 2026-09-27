/* ==========================================================================
   ProxCenter — 格式化工具
   ========================================================================== */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/**
 * 字节格式化，二进制单位（1024 进位）
 * @param bytes 字节数
 * @param decimals 小数位，默认 1；数值 >= 100 时自动降为 0 位
 */
export function formatBytes(bytes?: number | null, decimals = 1): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '—';

  const k = 1024;
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / Math.pow(k, i);
  const digits = value >= 100 ? 0 : decimals;
  return `${value.toFixed(digits)} ${BYTE_UNITS[i]}`;
}

/**
 * 速率格式化（字节/秒）
 */
export function formatRate(bytesPerSec?: number | null): string {
  if (bytesPerSec === undefined || bytesPerSec === null) return '—';
  return `${formatBytes(bytesPerSec, 1)}/s`;
}

/**
 * 运行时长格式化：秒 → 中文可读
 * 例：3661 → "1 小时 1 分"
 */
export function formatUptime(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) {
    return '—';
  }
  if (seconds <= 0) return '0 秒';

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分`;
  return `${Math.floor(seconds)} 秒`;
}

/**
 * 紧凑时长（表格用）：3661 → "1h 1m"
 */
export function formatUptimeShort(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * 百分比格式化。入参可为 0~1 的小数（Proxmox 惯例）或已是 0~100
 */
export function formatPercent(
  value?: number | null,
  decimals = 1,
  alreadyPercent = false,
): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const pct = alreadyPercent ? value : value * 100;
  return `${pct.toFixed(decimals)}%`;
}

/**
 * 把 Proxmox 的 0~1 使用率转成 0~100 的数字
 */
export function toPercent(value?: number | null): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value * 100));
}

/**
 * 使用率 → 主题色（蓝 → 橙 → 红）
 */
export function usageColor(percent: number): string {
  if (percent >= 85) return 'var(--usage-high)';
  if (percent >= 65) return 'var(--usage-mid)';
  return 'var(--usage-low)';
}

/**
 * 使用率 → 语义状态
 */
export function usageLevel(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 85) return 'danger';
  if (percent >= 65) return 'warn';
  return 'ok';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 数字可能是 Unix 秒，也可能是 ISO 字符串 */
function toDate(value: number | string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // 小于 1e11 视为秒级时间戳
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 日期时间：2026-09-19 19:33:17
 */
export function formatDateTime(
  value?: number | string | Date | null,
): string {
  const d = toDate(value);
  if (!d) return '—';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * 仅日期：2026-09-19
 */
export function formatDate(value?: number | string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 相对时间："3 分钟前"
 */
export function formatRelative(value?: number | string | Date | null): string {
  const d = toDate(value);
  if (!d) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 0) return formatDateTime(d);
  if (diff < 60) return '刚刚';
  if (diff < 3_600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)} 小时前`;
  if (diff < 2_592_000) return `${Math.floor(diff / 86_400)} 天前`;
  return formatDate(d);
}

/**
 * 图表 X 轴时间标签，按时长跨度自适应
 */
export function formatTimeLabel(value: number | string, span?: number): string {
  const d = toDate(value);
  if (!d) return '—';
  // span 单位秒
  if (span !== undefined && span <= 86_400) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

/**
 * 数字千分位
 */
export function formatNumber(value?: number | null, decimals = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * 解析 Proxmox 磁盘体积字符串 "32G" / "8M" / "1T" → 字节
 */
export function parseSizeToBytes(size: string | number): number {
  if (typeof size === 'number') return size;
  const m = /^([\d.]+)\s*([KMGT])?/i.exec(size.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  if (Number.isNaN(num)) return 0;
  const unit = (m[2] ?? '').toUpperCase();
  const mult: Record<string, number> = {
    '': 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return num * (mult[unit] ?? 1);
}

/**
 * 标签字符串 → 数组（Proxmox 用 ; 或 , 分隔）
 */
export function parseTags(tags?: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 相对值 → 增减色（用于"增长率"等指标）
 * 说明：按中国习惯，增长=红，下降=绿
 */
export function trendColor(delta: number): string {
  if (delta > 0) return 'var(--danger)';
  if (delta < 0) return 'var(--success)';
  return 'var(--text-secondary)';
}

/**
 * 截断文本
 */
export function truncate(text: string, max = 40): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
