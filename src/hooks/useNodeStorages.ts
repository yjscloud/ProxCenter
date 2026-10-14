/* ==========================================================================
   ProxCenter — 「只能选这个节点上的存储」的存储候选

   为什么不能直接用 ``storagesApi.list(node)``：

   1. **请求可能被路由到别的主机。** 后端只在请求没带 ``X-PVE-Connection`` 时才
      按节点名去推断该节点属于哪台 PVE；而虚拟机 / 容器详情页会设页面级连接
      （见 api/client.ts 的 ``setPageConnection``），于是向导里选了 A 集群的节点，
      请求却打到 B 集群 —— 轻则报 ``hostname lookup 'x' failed``，重则两边的节点
      同名，**静默列出 B 集群的存储**。这里把连接显式写进请求头，优先级高于
      页面级连接与顶栏的集群作用域（后两者都可能指向另一套集群）。
   2. **不带节点名时后端会聚合**（这台主机的**全部节点**、甚至全部主机的存储），
      于是「选了节点还看见别的节点的池子」。所以：没选节点就不去查，查回来的
      再按 ``node`` 收敛一次。

   返回结构刻意与 ``useQuery`` 的结果兼容（``data`` / ``isLoading`` / ``error``），
   调用方原来写 ``storagesQuery.data`` 的地方不用改。
   ========================================================================== */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nodesApi, storagesApi } from '../api/endpoints';
import type { Storage } from '../api/types';

export interface NodeStorages {
  /** 该节点上的存储（已按 ``node`` 收敛；没选节点时为空） */
  data: Storage[];
  isLoading: boolean;
  error: unknown;
  /** 解析出来的、该节点所属的连接 id（显式传给后端，避免被页面级连接带偏） */
  connectionId: string;
}

export function useNodeStorages(
  node: string,
  connectionId?: string,
  enabled = true,
): NodeStorages {
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled,
    staleTime: 60_000,
  });

  /* 节点所属连接。**显式传入的连接优先**：调用点（详情页 / 各创建向导）本来就知道
     这台机器在哪条连接上（vm.connection_id / 向导选的目标主机）。

     只有在没显式给时，才回落到「按节点名去节点列表里反查」。反查是有歧义的 ——
     多套 PVE 上同名节点是常态（两台都叫 pve1），而且 `/nodes` 会跟着顶栏作用域
     变窄：向导目标主机是 A、节点名在两台都存在时，反查可能命中 B。
     两个都拿不到时留空，让后端自己按节点名推断。 */
  const nodeConn = useMemo(() => {
    if (connectionId) return connectionId;
    if (!node) return '';
    const hit = (nodesQuery.data ?? []).find((item) => item.node === node);
    return hit?.connection_id || '';
  }, [node, nodesQuery.data, connectionId]);

  const query = useQuery({
    // 连接进了 key：换节点 / 换主机都要重新取
    queryKey: ['storages', nodeConn || '', node],
    queryFn: () => storagesApi.list(node, nodeConn || undefined),
    // 没选节点就别查：那会取回整台主机所有节点的池子（见文件头第 2 条）
    enabled: enabled && Boolean(node),
    staleTime: 60_000,
  });

  const data = useMemo(() => {
    if (!node) return [];
    // 再收敛一次：多节点聚合回来的行会带上各自的 node，不属于本节点的直接丢掉
    return (query.data ?? []).filter((item) => item.node === node);
  }, [query.data, node]);

  return {
    data,
    isLoading: query.isLoading,
    error: query.error,
    connectionId: nodeConn,
  };
}
