/* ==========================================================================
   ProxCenter — 读取当前集群作用域（响应式）
   ==========================================================================

   作用域本身存在 api/scope.ts（模块级变量 + localStorage），拦截器在 React
   之外读它。这个 hook 把同一份值接进渲染树：任何 ``setGlobalScope`` 都会让
   调用方重渲染，于是「页面标题里的节点数」「选择器上的当前值」不会滞后一拍。

   用 ``useSyncExternalStore`` 而不是 useState + useEffect：它天然处理
   「订阅期间值又变了」的竞态（切换作用域会同时触发一堆查询重取，正是这种场景）。
   ========================================================================== */

import { useSyncExternalStore } from 'react';
import { getGlobalScope, subscribeScope } from '../api/scope';

/** 当前集群作用域；空串 = 全部集群。 */
export function useGlobalScope(): string {
  /* getServerSnapshot 也传同步读取：本面板是纯前端应用（无 SSR），
     这个参数只用来满足 API 签名 */
  return useSyncExternalStore(subscribeScope, getGlobalScope, getGlobalScope);
}
