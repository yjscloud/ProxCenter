/* ==========================================================================
   ProxCenter — 最近 N 次采样（供 KPI 迷你趋势线使用）
   ==========================================================================
   仪表盘的 KPI 只有「当前值」，没有历史序列可画。这里在客户端维护一个定长
   环形缓冲：每当数值变化就追加一点，超过上限则丢弃最旧的一点。

   刻意保持轻量：
     * 由调用方传 enabled（加载中 / 无权限时不采样），避免一上来先记一串 0；
     * 值没变就不追加 —— 轮询多轮数值不动时，曲线不该被拉平成一串重复点。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';

export function useRollingSeries(
  value: number,
  enabled = true,
  size = 24,
): number[] {
  const [series, setSeries] = useState<number[]>([]);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !Number.isFinite(value)) return;
    if (last.current === value) return;
    last.current = value;
    setSeries((prev) => {
      const next = [...prev, value];
      return next.length > size ? next.slice(next.length - size) : next;
    });
  }, [value, enabled, size]);

  /* 数据源被裁掉（切身份 / 无权限）后重置，别把上一个口径的曲线带过来 */
  useEffect(() => {
    if (enabled) return;
    last.current = null;
    setSeries((prev) => (prev.length === 0 ? prev : []));
  }, [enabled]);

  return series;
}
