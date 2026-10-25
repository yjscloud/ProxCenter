/* ==========================================================================
   ProxCenter — 维护模式状态

   一个公开接口 + 一个 query key，全站共用一份缓存：登录页、维护公告页、
   后台顶栏提示、设置页开关读的是同一份数据，保存后刷新一次就全都对上。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { panelApi } from '../api/endpoints';

export const MAINTENANCE_KEY = ['panel-maintenance'] as const;

/**
 * @param enabled 传 false 可跳过请求（例如还没确定是不是管理员时）。
 *
 * ``retry: false``：维护期间后端只回 503，重试三次没有意义，只会让页面
 * 多转几秒圈。``staleTime`` 给 30 秒，避免每个组件各发一次。
 */
export function useMaintenance(enabled = true, refetchInterval?: number) {
  return useQuery({
    queryKey: MAINTENANCE_KEY,
    queryFn: panelApi.maintenance,
    enabled,
    staleTime: 30_000,
    retry: false,
    refetchInterval,
  });
}
