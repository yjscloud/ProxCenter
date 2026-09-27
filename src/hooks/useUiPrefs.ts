/* ==========================================================================
   ProxCenter — 面板界面开关
   导航栏里哪些入口被关掉了（逐项开关）。由后端 settings 表提供（见 app/ui.py），
   管理员在「设置 → 导航栏功能开关」里改，对所有用户生效。

   读取方：Layout（路由拦截）、Sidebar、Topbar 头像菜单、CommandPalette、
   设置页。它们共用同一份 react-query 缓存，改一次各处一起变。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { configApi } from '../api/endpoints';
import type { UiPrefs } from '../api/types';

/**
 * 后端不可用时的兜底值：与后端 ui.py 的内置默认值一致 —— 显示导航栏。
 *
 * 兜底方向很重要：接口失败时按「显示」渲染，最坏是多出一条侧边栏；
 * 若反过来（失败就隐藏），一次网络抖动就会把所有用户的导航抹掉，
 * 而侧边栏正是他们回到设置页重新打开它的入口。
 */
export const DEFAULT_UI_PREFS: UiPrefs = {
  nav_disabled: [],
};

export function useUiPrefs(): UiPrefs {
  const query = useQuery({
    queryKey: ['config', 'ui'],
    queryFn: configApi.getUiPrefs,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return query.data ?? DEFAULT_UI_PREFS;
}
