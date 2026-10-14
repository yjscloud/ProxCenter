/* ==========================================================================
   ProxCenter — 额度读数的缓存作废（唯一出口）
   ==========================================================================

   为什么单独一个模块：额度有**好几份**读数，散在多个页面与向导里，而每一份都
   会因为「建了一台 / 删了一台 / 改了规格 / 换了归属 / 改了额度配置」而变。

   之前每个调用点各自 `invalidateQueries({ queryKey: ['quota'] })` —— 那个前缀
   只命中 `['quota','me']`，**不命中**其余几份。于是「删了机器额度没还回来」
   「改了额度设置还是旧数字」这类问题反复出现：不是某个点写错了，而是**要求
   几十个调用点都记得同一件事**。

   现在收成两个出口：

   * `QUOTA_QUERY_KEYS` —— 展开到 `runner.run({ invalidate: [...] })` 里；
   * `invalidateQuota(qc)` —— 不走 runner 的直连写操作调它。

   另外 `useTaskRunner` 会**无条件**把这份清单一起作废（见那里），所以绝大多数
   写路径（创建 / 删除 / 电源 / 快照 / 迁移）不需要调用方再操心。

   新增额度读数时只需要往 `QUOTA_QUERY_KEYS` 里加一条。
   ========================================================================== */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * 全部「额度读数」的 query key。都是**两段前缀**，刻意不写成 `['vms']` / `['lxc']`
 * 那种宽前缀 —— 作废额度不该顺带把客户机列表整片刷掉（那会让调用方以为自己
 * 只刷了额度，实际刷了一屏）。
 *
 * 逐条对应：
 *   ['quota']              —— 我的额度（`GET /quota/me`，各页面各实例共用同一份）
 *   ['guests','quota']     —— 客户机列表顶部的平台台数读数
 *   ['vms','quota']        —— 虚拟机向导 / 工作台里的平台台数读数
 *   ['lxc','quota']        —— 容器向导里的同一份
 *   ['config','vm-quota']  —— 设置页里的全局额度配置
 *   ['user-quota']         —— 管理端：某用户的额度（含已用/生效值）
 *   ['role-quota']         —— 管理端：角色默认额度，以及用户编辑器里的「继承到手的是什么」
 */
export const QUOTA_QUERY_KEYS: QueryKey[] = [
  ['quota'],
  ['guests', 'quota'],
  ['vms', 'quota'],
  ['lxc', 'quota'],
  ['config', 'vm-quota'],
  ['user-quota'],
  ['role-quota'],
];

/** 把上面那份清单一次性作废。不走 `runner.run` 的直连写操作调这个。 */
export function invalidateQuota(queryClient: QueryClient): void {
  for (const key of QUOTA_QUERY_KEYS) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
