/* ==========================================================================
   ProxCenter — 建机规格 vs 资源额度

   后端在提交时会做同一套判断（并且是权威的，见 app/quota.py 的 check_limits）。
   这里做一遍是为了**在提交之前**就把话说清楚：让用户在向导里改规格，而不是
   填完一整页再被 403 打回来。

   两条纪律：
   * 读数不可信（``error`` 非空）时**不下结论** —— 交给后端拒绝，前端不猜；
   * 拿不到的规格（例如导入时由 OVF 决定的核数）不检查，与后端一致。
   ========================================================================== */

import type { QuotaGroupReport } from '../api/types';

/** 本次要建的一台机器的规格；只知道哪几项就传哪几项 */
export interface GuestSpecDraft {
  /** 台数，默认 1 */
  count?: number;
  cores?: number | null;
  memory_mb?: number | null;
  disk_gb?: number | null;
}

/** 越界的维度：``count``/``cores``/``memory_mb``/``disk_gb`` 是总量，``max_*`` 是单台封顶 */
export type QuotaViolation =
  | 'count'
  | 'cores'
  | 'memory_mb'
  | 'disk_gb'
  | 'max_cores'
  | 'max_memory_mb'
  | 'max_disk_gb';

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function checkGuestSpec(
  group: QuotaGroupReport | undefined | null,
  spec: GuestSpecDraft,
): QuotaViolation[] {
  if (!group || group.error) return [];
  const limits = group.limits ?? {};
  const usage = group.usage;
  const out: QuotaViolation[] = [];

  const count = spec.count ?? 1;
  const countLimit = asNumber(limits.count);
  if (countLimit !== null && (usage?.count ?? 0) + count > countLimit) {
    out.push('count');
  }

  const pairs: Array<[QuotaViolation, string, number | null]> = [
    ['cores', 'max_cores', asNumber(spec.cores)],
    ['memory_mb', 'max_memory_mb', asNumber(spec.memory_mb)],
    ['disk_gb', 'max_disk_gb', asNumber(spec.disk_gb)],
  ];
  for (const [field, capField, need] of pairs) {
    if (need === null) continue;
    const cap = asNumber(limits[capField]);
    if (cap !== null && need > cap) out.push(capField as QuotaViolation);

    const total = asNumber(limits[field]);
    if (total === null) continue;
    const used =
      field === 'cores'
        ? usage?.cores ?? 0
        : field === 'memory_mb'
          ? usage?.memory_mb ?? 0
          : usage?.disk_gb ?? 0;
    if (used + need > total) out.push(field);
  }
  return out;
}

/**
 * 把一组读数摘成「还剩多少」的一句话（数量/核数/内存/磁盘）。
 *
 * 只列出**被限制**的维度；一项都没限就返回空串（界面上不显示这一行）。
 *
 * ``labels`` 只给**维度名**，单位由本函数拼 —— 传额度编辑器那套带单位的字段名
 * （``quota.memory`` = 「内存 (GB)」）会拼出「内存 (GB) 8 GB」这种重复。
 */
export function remainingSummary(
  group: QuotaGroupReport | undefined | null,
  labels: { count: string; cores: string; memory: string; disk: string },
  units: { count: string; cores: string },
): string {
  const remaining = group?.remaining;
  if (!remaining) return '';
  const parts: string[] = [];
  const push = (key: string, label: string, transform: (value: number) => string) => {
    const value = asNumber(remaining[key]);
    if (value === null) return;
    parts.push(`${label} ${transform(value)}`);
  };
  push('count', labels.count, (v) => `${v}${units.count}`);
  push('cores', labels.cores, (v) => `${v}${units.cores}`);
  // 内存后端按 MB 存，界面一律换成 GB（与额度编辑器同一套口径）
  push('memory_mb', labels.memory, (v) => `${Math.round(v / 1024)} GB`);
  push('disk_gb', labels.disk, (v) => `${v} GB`);
  return parts.join(' · ');
}
