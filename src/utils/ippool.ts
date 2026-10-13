/* ==========================================================================
   ProxCenter — IP 地址池的适用范围判断
   ==========================================================================
   池有三层约束：

   * **网桥**：地址在哪个桥上通；
   * **节点**：集群里哪个节点接的是这个网段（同一个 vmbr0，node1 可能是
     192.168.1.0/24、node2 却是 10.0.0.0/24）；
   * **PVE 连接**：是哪一台 PVE 上的那个节点 —— 多套 PVE 上「同名节点」是常态
     （每台都可能叫 pve），只按节点名匹配，为 A 主机配的池会在 B 主机的同名
     节点上也被列出来。

   三条约束是**与**的关系，取值约定一致：**空 = 不限**。这也是老数据天然兼容的
   原因 —— 保存时还没有这些字段的池读出来就是空，行为与改造前完全一致。

   判定收在这一处，三个下发入口（快速部署 / 自定义部署 / OVF 导入）共用：
   各写一份的话，漏掉一个入口就会一直漏下去。
   ========================================================================== */

import type { IpPoolStatus } from '../api/types';

export interface PoolScope {
  /** 目标网桥；空串表示还没选，此时不看网桥 */
  bridge?: string;
  /** 目标 VLAN 标签；null / undefined 表示网卡没划 VLAN，此时不看 VLAN */
  vlan?: number | null;
  /** 目标节点；空串表示还没选，此时不看节点 */
  node?: string;
  /** 目标 PVE 连接 id；空串表示还没选（或这个入口没有连接概念），此时不看连接 */
  connection?: string;
}

/** 这个池能不能用在「这个网桥 + 这个 VLAN + 这个节点 + 这台 PVE」上。 */
export function poolFits(pool: IpPoolStatus, scope: PoolScope): boolean {
  const bridge = (scope.bridge || '').trim();
  /* 池没写网桥 = 不限网桥；两边都写了且不一致才排除 */
  if (bridge && pool.bridge && pool.bridge !== bridge) return false;

  /* VLAN 与其它几项**不完全一样**：池记了 tag 时，网卡明确划了另一个 tag 才排除；
     网卡当前没划 VLAN 时仍然列出来 —— 池就属于那个二层网络，选中它之后会把 tag
     一起带过去（见 QuickDeployForm 的选池处理）。若这里也排除，用户会先看到
     「池不见了」，还得反过来先猜一个 tag 才能把池找回来。 */
  const poolVlan = pool.vlan ?? null;
  const targetVlan = scope.vlan ?? null;
  if (poolVlan !== null && targetVlan !== null && targetVlan !== poolVlan) {
    return false;
  }

  /* 下面两项是「目标还没选（向导第一步没走完）时不排除任何池」—— 否则用户面对
     一个空下拉，却不知道为什么空。 */
  const conn = (scope.connection || '').trim();
  const conns = pool.connections ?? [];
  if (conn && conns.length > 0 && !conns.includes(conn)) return false;

  const node = (scope.node || '').trim();
  const nodes = pool.nodes ?? [];
  if (node && nodes.length > 0 && !nodes.includes(node)) return false;

  return true;
}

/** 过滤出一批可用的池（保持原顺序）。 */
export function fitsPools<T extends IpPoolStatus>(pools: T[], scope: PoolScope): T[] {
  return pools.filter((pool) => poolFits(pool, scope));
}

export interface ScopeLabels {
  /** 没限定连接时的说法，如「全部 PVE」 */
  anyPve: string;
  /** 没限定节点时的说法，如「全部节点」 */
  anyNode: string;
  /** 连接 id → 展示名（一般用连接的名称，没有名称就退回 id） */
  connName: (id: string) => string;
}

/** 「适用范围」的一行摘要：`<哪些 PVE> · <哪些节点>`。 */
export function poolScopeLabel(
  pool: { connections?: string[]; nodes?: string[] },
  labels: ScopeLabels,
): string {
  const conns = (pool.connections ?? []).filter(Boolean).map(labels.connName);
  const nodes = (pool.nodes ?? []).filter(Boolean);
  return [
    conns.length ? conns.join(', ') : labels.anyPve,
    nodes.length ? nodes.join(', ') : labels.anyNode,
  ].join(' · ');
}
