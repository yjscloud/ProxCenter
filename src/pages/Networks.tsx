/* ==========================================================================
   ProxCenter — 集群网络总览（只读）
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { nodesApi } from '../api/endpoints';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { CardSkeleton } from '../components/ui/Spinner';
import { IpPoolPanel } from '../components/IpPoolPanel';
import {
  IconNetwork,
  IconRefresh,
  IconSearch,
  IconChevronRight,
  IconServer,
} from '../components/Icons';
import { isBridgeType, isPhysicalType, netTypeLabel } from '../utils/status';
import { useAuth } from '../hooks/useAuth';
import type { NetworkInterface } from '../api/types';

export function Networks() {
  const navigate = useNavigate();
  /* 本页是只读总览；节点内的网络写操作同样只对管理员开放 */
  const { hasPermission } = useAuth();
  const canManageNet = hasPermission('network.manage');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    refetchInterval: 20_000,
  });

  const nodes = nodesQuery.data ?? [];

  /* 并发拉取各节点网卡（带并发限制由 react-query 内部队列处理） */
  const netQueries = useQuery({
    // 多台 PVE 合并展示时同名节点会撞车，键与请求都必须带上连接标识
    queryKey: [
      'networks',
      'all',
      nodes.map((n) => `${n.connection_id ?? ''}:${n.node}`).join(','),
    ],
    queryFn: async () => {
      const results = await Promise.all(
        nodes.map(async (n) => {
          const connectionId = n.connection_id;
          try {
            const ifaces = await nodesApi.network(n.node, connectionId);
            return {
              node: n.node,
              connectionId,
              ifaces,
              error: null as string | null,
            };
          } catch (err) {
            return {
              node: n.node,
              connectionId,
              ifaces: [] as NetworkInterface[],
              error: err instanceof Error ? err.message : '加载失败',
            };
          }
        }),
      );
      return results;
    },
    enabled: nodes.length > 0,
    refetchInterval: 30_000,
  });

  const groups = netQueries.data ?? [];

  /* 扁平化 + 过滤 */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        ifaces: g.ifaces.filter((i) => {
          if (q) {
            const hay = [
              i.iface,
              i.address,
              i.cidr,
              i.gateway,
              i.bridge_ports,
              i.comments,
              netTypeLabel(i.type),
              g.node,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            if (!hay.includes(q)) return false;
          }
          if (typeFilter === 'bridge' && !isBridgeType(i.type)) return false;
          if (typeFilter === 'physical' && !isPhysicalType(i.type)) return false;
          if (typeFilter === 'active' && !i.active) return false;
          if (activeFilter === 'active' && !i.active) return false;
          if (activeFilter === 'inactive' && i.active) return false;
          return true;
        }),
      }))
      .filter((g) => g.ifaces.length > 0 || (!search && !typeFilter && !activeFilter));
  }, [groups, search, typeFilter, activeFilter]);

  /* 统计 */
  const stats = useMemo(() => {
    const all = groups.flatMap((g) => g.ifaces);
    return {
      total: all.length,
      bridges: all.filter((i) => isBridgeType(i.type)).length,
      physical: all.filter((i) => isPhysicalType(i.type)).length,
      inactive: all.filter((i) => !i.active).length,
    };
  }, [groups]);

  const columns: Array<Column<NetworkInterface>> = [
    {
      key: 'iface',
      header: '接口名',
      render: (i) => <span className="mono fw-500">{i.iface}</span>,
      width: 150,
    },
    {
      key: 'type',
      header: '类型',
      render: (i) => (
        <Badge variant={isBridgeType(i.type) ? 'accent' : 'neutral'} size="sm">
          {netTypeLabel(i.type)}
        </Badge>
      ),
      width: 130,
    },
    {
      key: 'active',
      header: '激活',
      width: 92,
      align: 'center',
      render: (i) => (
        <Badge
          variant={i.active ? 'success' : 'neutral'}
          dot
          pulse={i.active}
          size="sm"
        >
          {i.active ? '已激活' : '未激活'}
        </Badge>
      ),
    },
    {
      key: 'address',
      header: '地址',
      render: (i) => (
        <span className="mono fs-sm">
          {i.address ? (
            <>
              {i.address}
              {i.cidr ? <span className="text-muted"> / {i.cidr}</span> : null}
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </span>
      ),
    },
    {
      key: 'gateway',
      header: '网关',
      render: (i) => (
        <span className="mono fs-sm text-secondary">{i.gateway || '—'}</span>
      ),
      width: 130,
    },
    {
      key: 'ports',
      header: '桥接端口 / 从属',
      render: (i) => (
        <span className="mono fs-sm text-secondary">
          {i.bridge_ports || i.bond_slaves || '—'}
        </span>
      ),
      width: 160,
    },
    {
      key: 'comments',
      header: '备注',
      render: (i) => (
        <span className="fs-sm text-secondary truncate" title={i.comments}>
          {i.comments || '—'}
        </span>
      ),
      width: 150,
    },
  ];

  const anyError = groups.some((g) => g.error);

  return (
    <PageShell
      title={
        <>
          <IconNetwork size={20} />
          网络总览
        </>
      }
      subtitle={
        groups.length > 0
          ? `${groups.length} 个节点 · ${stats.total} 个接口 · ${stats.bridges} 个网桥`
          : '正在加载…'
      }
      actions={
        <Button
          variant="secondary"
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void nodesQuery.refetch();
            void netQueries.refetch();
          }}
          loading={netQueries.isFetching && !netQueries.isLoading}
        >
          刷新
        </Button>
      }
    >
      <Notice tone="info" title="只读总览">
        {canManageNet
          ? '此页面汇总集群内所有节点的网络接口，仅供查看。若要新增、修改网卡或应用配置变更，请进入对应节点的「网络」标签页操作。'
          : '此页面汇总集群内所有节点的网络接口。当前账号对网络只有查看权限，新增、修改网卡或应用配置变更需要管理员权限。'}
      </Notice>

      {/* ---- 概览统计 ---- */}
      <div className="grid grid-4">
        <Card collapsible={false}>
          <CardHeader title="接口总数" icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-hint">跨 {groups.length} 个节点</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title="网桥" icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.bridges}</div>
          <div className="kpi-hint">可作为虚拟机网络</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title="物理网卡" icon={<IconServer size={16} />} />
          <div className="kpi-value">{stats.physical}</div>
          <div className="kpi-hint">含绑定接口</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title="未激活" icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.inactive}</div>
          <div className="kpi-hint">
            {stats.inactive > 0 ? '请检查这些接口' : '全部接口正常'}
          </div>
        </Card>
      </div>

      {/* ---- 筛选 ---- */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索接口名、地址、备注…"
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label="搜索网络接口"
          />
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { label: '全部类型', value: '' },
              { label: '网桥', value: 'bridge' },
              { label: '物理网卡 / 绑定', value: 'physical' },
            ]}
            aria-label="按类型筛选"
          />
          <Select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            options={[
              { label: '全部状态', value: '' },
              { label: '仅已激活', value: 'active' },
              { label: '仅未激活', value: 'inactive' },
            ]}
            aria-label="按激活状态筛选"
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            {filtered.reduce((s, g) => s + g.ifaces.length, 0)} 个接口
          </span>
        </div>
      </div>

      {/* ---- 分组展示 ---- */}
      {nodesQuery.isLoading || netQueries.isLoading ? (
        <CardSkeleton count={2} height={180} />
      ) : nodes.length === 0 ? (
        <Card>
          <EmptyState
            title="暂无节点"
            description="集群中没有可用节点。"
            icon={<IconServer size={28} />}
          />
        </Card>
      ) : anyError && groups.every((g) => g.error) ? (
        <ErrorState
          title="无法加载网络信息"
          message="所有节点的网卡接口都请求失败，请检查后端 /nodes/{node}/network 接口。"
          onRetry={() => void netQueries.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-20">
          {filtered.map((group) => (
            <Card padded={false} key={`${group.connectionId ?? ""}:${group.node}`}>
              <div
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--border-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div className="flex items-center gap-8 flex-wrap">
                  <IconServer size={16} />
                  <span className="fw-600">{group.node}</span>
                  <Badge variant="neutral" size="sm">
                    {group.ifaces.length} 个接口
                  </Badge>
                  {group.ifaces.filter((i) => !i.active).length > 0 ? (
                    <Badge variant="warning" size="sm" dot>
                      {group.ifaces.filter((i) => !i.active).length} 个未激活
                    </Badge>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  iconRight={<IconChevronRight size={14} />}
                  onClick={() =>
                    navigate(`/nodes/${encodeURIComponent(group.node)}?tab=network${group.connectionId ? `&conn=${encodeURIComponent(group.connectionId)}` : ""}`)
                  }
                >
                  {canManageNet ? '管理此节点网络' : '查看此节点网络'}
                </Button>
              </div>

              {group.error ? (
                <div style={{ padding: 16 }}>
                  <Notice tone="danger" title="该节点网络信息加载失败">
                    {group.error}
                  </Notice>
                </div>
              ) : (
                <Table<NetworkInterface>
                  columns={columns}
                  rows={group.ifaces}
                  rowKey={(i) => `${group.connectionId ?? ""}:${group.node}/${i.iface}`}
                  caption={`节点 ${group.node} 的网络接口`}
                  emptyTitle="该节点没有匹配的接口"
                  dense
                  className="table-flush"
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {/* ---- IP 地址池 ---- */}
      <IpPoolPanel />

      {/* 快捷跳转 */}
      <Card collapsible={false}>
        <CardHeader
          title="网络管理操作"
          subtitle="新增 / 修改网卡、应用配置变更请到节点详情页"
          icon={<IconNetwork size={16} />}
        />
        <div className="flex flex-wrap gap-8">
          {nodes.map((n) => (
            <Button
              key={n.node}
              variant="secondary"
              size="sm"
              icon={<IconNetwork size={14} />}
              onClick={() =>
                navigate(`/nodes/${encodeURIComponent(n.node)}?tab=network${n.connection_id ? `&conn=${encodeURIComponent(n.connection_id)}` : ""}`)
              }
            >
              {n.node} 网络设置
            </Button>
          ))}
          {nodes.length === 0 ? (
            <IconButton label="刷新" onClick={() => void nodesQuery.refetch()}>
              <IconRefresh size={16} />
            </IconButton>
          ) : null}
        </div>
      </Card>
    </PageShell>
  );
}
