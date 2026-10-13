/* ==========================================================================
   ProxCenter — 我名下的快照额度

   建快照的地方（虚拟机详情 / 容器详情 / 列表页的「更多操作」）都要说清「还能建
   几张」，三处各自写一遍查询既啰嗦又容易走偏，收在这里。

   只是**提示**：单机上限要逐台查快照列表才知道，那一步留给后端 —— 它按精确数字
   拒绝，文案里写清了是哪一台、现在几张、上限多少。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { quotaApi } from '../api/endpoints';

export interface SnapshotQuota {
  /** 名下快照总数上限；``null`` = 没配（不限制） */
  limit: number | null;
  /** 还剩几张；``null`` = 不限制 */
  remaining: number | null;
  /** 是否配了额度（没配就什么都不用显示） */
  limited: boolean;
  /** 总额度已用尽 */
  blocked: boolean;
}

export function useSnapshotQuota(enabled = true): SnapshotQuota {
  const query = useQuery({
    queryKey: ['quota', 'me'],
    queryFn: quotaApi.mine,
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const group = query.data?.groups.snapshot;
  const limit = group?.limits?.count ?? null;
  const remaining = group?.remaining?.count ?? null;

  return {
    limit,
    remaining,
    limited: limit !== null,
    blocked: remaining !== null && Number(remaining) <= 0,
  };
}
