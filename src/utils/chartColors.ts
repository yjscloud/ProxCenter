/* ==========================================================================
   ProxCenter — 图表配色令牌（单一来源）
   ==========================================================================
   以前 recharts 的系列色散落在 MetricChart / CapacityCard 里各写一份十六进制，
   改一处、漏一处就会出现「同一个蓝在两张图里不是一个蓝」。这里收成一份令牌：
   组件只引用这里的名字，不再直接写色值。

   注意：recharts 把颜色写进 SVG 的 stroke / fill 属性，桌面与移动端对
   「属性里用 var(--x)」的支持并不一致，因此令牌保持十六进制字面量，而不是
   指向 CSS 变量；theme.css 里同步声明了同名变量，供纯 CSS 图表/图例使用。

   对比度：坐标轴刻度色从原来的 #c9cdd4 提到 #8c8c8c（白底约 3.5:1），
   保证细线刻度在浅色背景上仍可辨认（WCAG 1.4.11 非文本对比度）。
   ========================================================================== */

export const CHART_TOKENS = {
  accent: '#0052d9',
  success: '#2ba471',
  warning: '#e37318',
  danger: '#d54941',
  purple: '#7d5fff',
  cyan: '#00a4ff',
  grey: '#a9aeb8',
  /** 坐标轴 / 刻度 */
  axis: '#8c8c8c',
  /** 网格线（极浅，不与数据抢视觉） */
  grid: 'rgba(0, 0, 0, 0.07)',
} as const;

/** 兼容原有调用方：语义名 → 令牌色 */
export const CHART_COLORS = {
  accent: CHART_TOKENS.accent,
  success: CHART_TOKENS.success,
  warning: CHART_TOKENS.warning,
  danger: CHART_TOKENS.danger,
  purple: CHART_TOKENS.purple,
  cyan: CHART_TOKENS.cyan,
  grey: CHART_TOKENS.grey,
  netIn: CHART_TOKENS.success,
  netOut: CHART_TOKENS.purple,
  diskRead: CHART_TOKENS.accent,
  diskWrite: CHART_TOKENS.warning,
} as const;
