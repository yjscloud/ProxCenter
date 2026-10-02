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
import { isBridgeType, isPhysicalType, netTypeLabel } from '../utils/status'
import { useT } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import type { NetworkInterface } from '../api/types';

export function Networks() {
  const t = useT();
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
              error: err instanceof Error ? err.message : t('state.loadFailed'),
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
              netTypeLabel(i.type, t),
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
  }, [groups, search, typeFilter, activeFilter, t]);

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
      header: t('networks.colIface'),
      render: (i) => <span className="mono fw-500">{i.iface}</span>,
      width: 150,
    },
    {
      key: 'type',
      header: t('networks.colType'),
      render: (i) => (
        <Badge variant={isBridgeType(i.type) ? 'accent' : 'neutral'} size="sm">
          {netTypeLabel(i.type, t)}
        </Badge>
      ),
      width: 130,
    },
    {
      key: 'active',
      header: t('networks.colActive'),
      width: 92,
      align: 'center',
      render: (i) => (
        <Badge
          variant={i.active ? 'success' : 'neutral'}
          dot
          pulse={i.active}
          size="sm"
        >
          {i.active ? t('status.storage.active') : t('status.storage.inactive')}
        </Badge>
      ),
    },
    {
      key: 'address',
      header: t('networks.colAddress'),
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
      header: t('networks.colGateway'),
      render: (i) => (
        <span className="mono fs-sm text-secondary">{i.gateway || '—'}</span>
      ),
      width: 130,
    },
    {
      key: 'ports',
      header: t('networks.colPorts'),
      render: (i) => (
        <span className="mono fs-sm text-secondary">
          {i.bridge_ports || i.bond_slaves || '—'}
        </span>
      ),
      width: 160,
    },
    {
      key: 'comments',
      header: t('networks.colComments'),
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
          {t('networks.title')}
        </>
      }
      subtitle={
        groups.length > 0
          ? t('networks.subtitleSummary', {
              nodes: groups.length,
              total: stats.total,
              bridges: stats.bridges,
            })
          : t('common.loading')
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
          {t('common.refresh')}
        </Button>
      }
    >
      <Notice tone="info" title={t('networks.readOnlyTitle')}>
        {canManageNet ? t('networks.readOnlyAdmin') : t('networks.readOnlyUser')}
      </Notice>

      {/* ---- 概览统计 ---- */}
      <div className="grid grid-4">
        <Card collapsible={false}>
          <CardHeader title={t('networks.kpi.total')} icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-hint">{t('networks.kpi.totalHint', { n: groups.length })}</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title={t('networks.kpi.bridges')} icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.bridges}</div>
          <div className="kpi-hint">{t('networks.kpi.bridgesHint')}</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title={t('networks.kpi.physical')} icon={<IconServer size={16} />} />
          <div className="kpi-value">{stats.physical}</div>
          <div className="kpi-hint">{t('networks.kpi.physicalHint')}</div>
        </Card>
        <Card collapsible={false}>
          <CardHeader title={t('networks.kpi.inactive')} icon={<IconNetwork size={16} />} />
          <div className="kpi-value">{stats.inactive}</div>
          <div className="kpi-hint">
            {stats.inactive > 0 ? t('networks.kpi.inactiveHint') : t('networks.kpi.allOk')}
          </div>
        </Card>
      </div>

      {/* ---- 筛选 ---- */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('networks.searchPlaceholder')}
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label={t('networks.searchAria')}
          />
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { label: t('networks.typeAll'), value: '' },
              { label: t('networks.typeBridge'), value: 'bridge' },
              { label: t('networks.typePhysical'), value: 'physical' },
            ]}
            aria-label={t('networks.typeFilterAria')}
          />
          <Select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            options={[
              { label: t('networks.stateAll'), value: '' },
              { label: t('networks.stateActive'), value: 'active' },
              { label: t('networks.stateInactive'), value: 'inactive' },
            ]}
            aria-label={t('networks.stateFilterAria')}
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            {t('networks.ifaceCount', {
              n: filtered.reduce((s, g) => s + g.ifaces.length, 0),
            })}
          </span>
        </div>
      </div>

      {/* ---- 分组展示 ---- */}
      {nodesQuery.isLoading || netQueries.isLoading ? (
        <CardSkeleton count={2} height={180} />
      ) : nodes.length === 0 ? (
        <Card>
          <EmptyState
            title={t('networks.noNodes')}
            description={t('networks.noNodesDesc')}
            icon={<IconServer size={28} />}
          />
        </Card>
      ) : anyError && groups.every((g) => g.error) ? (
        <ErrorState
          title={t('networks.loadErrorTitle')}
          message={t('networks.loadErrorMsg')}
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
                    {t('networks.ifaceCount', { n: group.ifaces.length })}
                  </Badge>
                  {group.ifaces.filter((i) => !i.active).length > 0 ? (
                    <Badge variant="warning" size="sm" dot>
                      {t('networks.inactiveCount', {
                        n: group.ifaces.filter((i) => !i.active).length,
                      })}
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
                  {canManageNet ? t('networks.manageNode') : t('networks.viewNode')}
                </Button>
              </div>

              {group.error ? (
                <div style={{ padding: 16 }}>
                  <Notice tone="danger" title={t('networks.nodeLoadFailed')}>
                    {group.error}
                  </Notice>
                </div>
              ) : (
                <Table<NetworkInterface>
                  columns={columns}
                  rows={group.ifaces}
                  rowKey={(i) => `${group.connectionId ?? ""}:${group.node}/${i.iface}`}
                  caption={t('networks.nodeCaption', { node: group.node })}
                  emptyTitle={t('networks.nodeEmpty')}
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
          title={t('networks.manageTitle')}
          subtitle={t('networks.manageSubtitle')}
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
              {t('networks.nodeSettings', { node: n.node })}
            </Button>
          ))}
          {nodes.length === 0 ? (
            <IconButton label={t('common.refresh')} onClick={() => void nodesQuery.refetch()}>
              <IconRefresh size={16} />
            </IconButton>
          ) : null}
        </div>
      </Card>
    </PageShell>
  );
}
