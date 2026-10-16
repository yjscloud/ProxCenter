/* ==========================================================================
   ProxCenter — 「从地址池取一个地址」下拉

   创建向导里早就能从池里挑地址，但**改网卡 IP / 新增网卡时只能手打**：同一个池，
   用户得先去「网络」页翻出空闲地址，再抄回表单里 —— 抄错一位就是一个不通的地址，
   而且他自己也看不出来。

   这里把那段挑选做成一个下拉，VM 的 ipconfigN 与容器的 net 表单共用。

   池的适用范围判定交给 utils/ippool（网桥 / VLAN / 节点 / PVE 连接），与创建向导、
   与服务端下发时用的是同一处判定 —— 各写一份迟早会分叉。
   ========================================================================== */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipPoolsApi } from '../api/endpoints';
import { fitsPools, type PoolScope } from '../utils/ippool';
import { Select } from './ui/Input';
import { useT } from '../i18n';

export interface PoolIpSelectProps {
  /** 目标网卡所处的环境，用来筛出真正可用的池 */
  scope: PoolScope;
  /** 选中地址时回调：给出带掩码的地址（如 192.168.1.10/24）与网关 */
  onPick: (ip: string, gateway: string, poolName: string) => void;
  /** 弹窗没打开时不请求池列表 */
  enabled?: boolean;
  label?: string;
  hint?: string;
}

/** 单个池最多列出多少个空闲地址：池本身可能上百个，下拉太长反而难选 */
const MAX_OPTIONS = 100;

export function PoolIpSelect({
  scope,
  onPick,
  enabled = true,
  label,
  hint,
}: PoolIpSelectProps) {
  const t = useT();
  const { bridge, vlan, node, connection } = scope;

  const poolsQuery = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const options = useMemo(() => {
    const usable = fitsPools(poolsQuery.data?.pools ?? [], {
      bridge,
      vlan,
      node,
      connection,
    });
    const list: Array<{ value: string; label: string; gateway: string; pool: string }> = [];
    usable.forEach((pool) => {
      const prefix = (pool.subnet || '').split('/')[1] || '24';
      pool.free.slice(0, MAX_OPTIONS).forEach((ip) => {
        list.push({
          value: `${ip}/${prefix}`,
          label: `${ip}/${prefix}${pool.name ? ` · ${pool.name}` : ''}`,
          gateway: pool.gateway,
          pool: pool.name,
        });
      });
    });
    return list;
  }, [poolsQuery.data, bridge, vlan, node, connection]);

  const empty = options.length === 0;

  return (
    <Select
      label={label ?? t('poolIpSelect.label')}
      hint={hint ?? (empty ? t('poolIpSelect.empty') : t('poolIpSelect.hint'))}
      placeholder={t('poolIpSelect.placeholder')}
      /* 固定空值：选完立刻回到占位项，同一个下拉可以反复挑（不是「当前值」） */
      value=""
      disabled={empty}
      onChange={(e) => {
        const hit = options.find((o) => o.value === e.target.value);
        if (hit) onPick(hit.value, hit.gateway, hit.pool);
      }}
      options={options.map((o) => ({ label: o.label, value: o.value }))}
    />
  );
}
