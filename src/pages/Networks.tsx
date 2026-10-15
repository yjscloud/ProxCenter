/* ==========================================================================
   ProxCenter — 集群网络总览（只读）
   ========================================================================== */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { connectionsApi, nodesApi } from '../api/endpoints';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { EmptyState, Notice } from '../components/ui/EmptyState';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { CardSkeleton } from '../components/ui/Spinner';
import { IpPoolPanel } from '../components/IpPoolPanel';
import {
  IconNetwork,
  IconRefresh,
  IconSearch,
  IconChevronRight,
  IconChevronDown,
  IconServer,
  IconLayers,
} from '../components/Icons';
import { isBridgeType, isPhysicalType, netTypeLabel } from '../utils/status'
import { useT } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import type { NetworkInterface } from '../api/types';

/* 按 PVE 连接给节点数据分组：节点是连在某一台 PVE 上的，全平铺在一起分不清谁
   属于谁 —— 多套 PVE 上同名节点更是常态。
   没有连接 id 的项归进一个兜底组，标签用 — 占位（这一层只在多连接下才渲染）。
   单连接时调用方不渲染组标题，分组本身仍然生效（那时只有一个组）。 */
function groupByPve<T>(
  items: T[],
  connIdOf: (item: T) => string,
  nameOf: (id: string) => string,
): Array<{ id: string; label: string; items: T[] }> {
  const map = new Map<string, { id: string; label: string; items: T[] }>();
  for (const item of items) {
    const id = connIdOf(item) || '';
    let hit = map.get(id);
    if (!hit) {
      hit = { id, label: id ? nameOf(id) : '—', items: [] };
      map.set(id, hit);
    }
    hit.items.push(item);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function Networks() {
  const t = useT();
  const navigate = useNavigate();
  /* 本页是只读总览；节点内的网络写操作同样只对管理员开放 */
  const { hasPermission } = useAuth();
  const canManageNet = hasPermission('network.manage');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  /* 未配置连接时后端对每个请求都回 428，轮询只会刷一屏没人看的报错
     （配好之后自动恢复） */
  const pveReady = usePveReady();
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    refetchInterval: pveReady ? refresh : false,
  });

  const nodes = nodesQuery.data ?? [];

  /* 已保存的 PVE 连接：多套 PVE 上「同名节点」是常态，节点卡头只写 pve1 谁也
     分不清是哪一台。显示口径与地址池面板一致（name → host → id） */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
  });
  const connectionList = connectionsQuery.data ?? [];
  const connNameOf = useCallback(
    (id?: string) => {
      if (!id) return '';
      const hit = connectionList.find((item) => String(item.id) === id);
      return String(hit?.name || hit?.host || id);
    },
    [connectionList],
  );
  /* 连接的「区域 / 机房」：连接配置上填的一个分组标签（老连接没有 = 空串） */
  const connRegionOf = useCallback(
    (id?: string) => {
      if (!id) return '';
      const hit = connectionList.find((item) => String(item.id) === id);
      return String(hit?.region || '').trim();
    },
    [connectionList],
  );

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
    refetchInterval: pveReady ? refresh : false,
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

  /* 接口总览：按 PVE 分组的节点（每组是「这个节点 + 它的接口」） */
  const pveGroups = useMemo(
    () => groupByPve(filtered, (g) => g.connectionId ?? '', connNameOf),
    [filtered, connNameOf],
  );

  /* 树的最外层：区域 / 机房 → 连接 → 节点。
     区域是连接上的一个标签（在「节点 → 连接管理」里填）。多机房时它比连接更粗
     一级 —— 否则七八条连接还是平铺在一起，只不过平铺的单位从节点变成了连接。
     一条连接都没填区域时这一层整个不渲染，退化成原来的两层。 */
  const regionGroups = useMemo(() => {
    const map = new Map<
      string,
      { id: string; label: string; conns: typeof pveGroups }
    >();
    for (const group of pveGroups) {
      const region = connRegionOf(group.id);
      let hit = map.get(region);
      if (!hit) {
        hit = {
          id: region,
          label: region || t('networks.regionUnassigned'),
          conns: [],
        };
        map.set(region, hit);
      }
      hit.conns.push(group);
    }
    /* 未分区排最后：它是兜底分组，不该排在有名字的区域前面 */
    return [...map.values()].sort((a, b) => {
      if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [pveGroups, connRegionOf, t]);

  /* ---- 三层固定铺满：区域 / 机房 → 连接 → 节点 ----
     与节点页同一套写法。区域层照渲染，没填区域的连接归到「未分区」；连接层在
     区域层出现时也必须跟着出现 —— 少一级的话剩下那几行会往上顶，读者看不出
     这里是三级。 */
  const showRegion = regionGroups.length > 0;
  /* 连接层：多条连接时本来就要分组；只有一条连接时它是「区域 → 连接 → 节点」
     中间的那一级，同样不能省。 */
  const showConnection = connectionList.length > 1 || showRegion;

  /* 两级的展开状态，**默认值相反**（与节点页同一套）：

      * 区域（机房标签）**默认展开**：它只是一层分组，收起它等于把下面那几条连接
        一起藏掉 —— 多机房部署里一进页面只看到几行区域名，什么都得点一下；
      * 连接**默认收起**：它下面才是接口表，一台机器十几个口一多就是好几屏，
        标题行上已经写着「几个节点、几个接口、几个掉线」—— 先看概况再决定展开
        哪台机器（存储页那边连接默认展开：那一层下面只有存储池，不占屏）。

    所以区域存「已收起」、连接存「已展开」：各自的默认值就是空数组，不必在拿到
    数据之后再补一次状态（那会多一帧的闪烁），定时刷新也不会把已展开的连接又收回去。 */
  const [collapsedRegions, setCollapsedRegions] = useState<string[]>([]);
  const [expandedConns, setExpandedConns] = useState<string[]>([]);

  const toggleRegion = (id: string) =>
    setCollapsedRegions((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  const toggleConn = (id: string) =>
    setExpandedConns((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );

  /* 所有可折叠的组，用于工具栏那个「全部展开 / 全部收起」（两层各一份） */
  const allRegionIds = useMemo(
    () => (showRegion ? regionGroups.map((g) => g.id) : []),
    [regionGroups, showRegion],
  );
  const allConnIds = useMemo(
    () => (showConnection ? pveGroups.map((g) => g.id) : []),
    [pveGroups, showConnection],
  );
  const allExpanded =
    (allRegionIds.length > 0 || allConnIds.length > 0) &&
    allRegionIds.every((id) => !collapsedRegions.includes(id)) &&
    allConnIds.every((id) => expandedConns.includes(id));

  /* 一键展开 / 收起把两层一起改 —— 区域那份存的是「已收起」，连接那份是「已展开」 */
  const setAllExpanded = (open: boolean) => {
    setCollapsedRegions(open ? [] : allRegionIds);
    setExpandedConns(open ? allConnIds : []);
  };

  /* 列宽：名称 / 类型 / 状态 / 网关 / 端口这些长度基本固定的给窄宽并把空间让
     出来，地址与备注**不设宽** —— 它们长短最不可控，交给浏览器吸收剩余宽度，
     表格才能铺满内容区，而不是右边空出一条（节点卡堆叠时尤其明显）。

     列的顺序也按「读一行」来排：这个口是什么 → 通不通 → 地址 → 网关 → 上行口。 */
  const columns: Array<Column<NetworkInterface>> = [
    {
      key: 'iface',
      header: t('networks.colIface'),
      render: (i) => <span className="mono fw-500">{i.iface}</span>,
      width: 130,
    },
    {
      key: 'type',
      header: t('networks.colType'),
      render: (i) => (
        <Badge variant={isBridgeType(i.type) ? 'accent' : 'neutral'} size="sm">
          {netTypeLabel(i.type, t)}
        </Badge>
      ),
      width: 116,
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
      width: 112,
    },
    {
      key: 'ports',
      header: t('networks.colPorts'),
      render: (i) => (
        <span className="mono fs-sm text-secondary">
          {i.bridge_ports || i.bond_slaves || '—'}
        </span>
      ),
      width: 180,
    },
    {
      key: 'comments',
      header: t('networks.colComments'),
      render: (i) => (
        <span className="fs-sm text-secondary truncate" title={i.comments}>
          {i.comments || '—'}
        </span>
      ),
    },
  ];

  const anyError = groups.some((g) => g.error);

  /* 树的最内层：一个节点 + 它的接口表 */
  const renderNodeCard = (group: (typeof filtered)[number]) => (
    <Card
      padded={false}
      /* 表格卡片（padded={false}）的标题栏内衬由这个类补上 */
      className="card-head-inset"
      key={`${group.connectionId ?? ''}:${group.node}`}
    >
      {/* 用 CardHeader 而不是自己写标题行：每个节点卡自带来折叠开关
          （节点多时先折起来看概况），也省掉一段内联样式 */}
      <CardHeader
        icon={<IconServer size={16} />}
        title={
          <span className="flex items-center gap-8 flex-wrap">
            <span>{group.node}</span>
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
          </span>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconRight={<IconChevronRight size={14} />}
            onClick={() =>
              navigate(`/nodes/${encodeURIComponent(group.node)}?tab=network${group.connectionId ? `&conn=${encodeURIComponent(group.connectionId)}` : ''}`)
            }
          >
            {canManageNet ? t('networks.manageNode') : t('networks.viewNode')}
          </Button>
        }
      />

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
  );

  /* 树的第二层：一条 PVE 连接 + 它下面的节点卡。
     抽成函数是因为它嵌在区域层里 —— 直接写在 JSX 里会叠到四层缩进，很难读。 */
  const renderConnectionGroup = (pve: (typeof pveGroups)[number]) => {
    /* 连接默认收起（见上面两级状态的说明）：空数组 = 全部收起 */
    const connOpen = expandedConns.includes(pve.id);
    const ifaceCount = pve.items.reduce((n, g) => n + g.ifaces.length, 0);
    const downCount = pve.items.reduce(
      (n, g) => n + g.ifaces.filter((i) => !i.active).length,
      0,
    );
    return (
      <section className="tree-group" key={`conn:${pve.id}`}>
        {showConnection ? (
          <button
            type="button"
            className="tree-head"
            aria-expanded={connOpen}
            onClick={() => toggleConn(pve.id)}
          >
            <span className="tree-head-icon">
              <IconChevronDown size={15} />
            </span>
            <IconServer size={15} />
            <span className="tree-name">{pve.label}</span>
            <span className="tree-meta">
              <Badge variant="neutral" size="sm">
                {t('networks.nodeCount', { n: pve.items.length })}
              </Badge>
              <Badge variant="neutral" size="sm">
                {t('networks.ifaceCount', { n: ifaceCount })}
              </Badge>
              {downCount > 0 ? (
                <Badge variant="warning" size="sm" dot>
                  {t('networks.inactiveCount', { n: downCount })}
                </Badge>
              ) : null}
            </span>
          </button>
        ) : null}

        {connOpen ? (
          /* 不渲染连接头时，那条表示层级的竖线也不该出现 —— 它上面没有组标题，
             只会是一条悬空的线 */
          <div
            className={showConnection ? 'tree-body' : 'flex flex-col gap-16'}
          >
            {pve.items.map(renderNodeCard)}
          </div>
        ) : null}
      </section>
    );
  };

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
          {/* 连接默认收起（区域默认展开）：给一个一键展开 / 收起，省得一台一台点。
              只有一台 PVE 时它没有意义（那一层根本不渲染） */}
          {pveGroups.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              icon={
                allExpanded ? (
                  <IconChevronRight size={14} />
                ) : (
                  <IconChevronDown size={14} />
                )
              }
              onClick={() => setAllExpanded(!allExpanded)}
            >
              {allExpanded
                ? t('networks.collapseAll')
                : t('networks.expandAll')}
            </Button>
          ) : null}
        </div>
      </div>

      {/* ---- 分组展示：PVE → 节点 → 接口 ----
          两级树。一级是 PVE（整组可收起，标题行给出这台 PVE 的概况），二级是
          它下面的节点卡。只有一条连接时**不渲染 PVE 这一层** —— 它只有一个
          取值，除了多占一行没有任何作用。 */}
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
        <PveQueryError
          title={t('networks.loadErrorTitle')}
          message={t('networks.loadErrorMsg')}
          error={netQueries.error}
          onRetry={() => void netQueries.refetch()}
        />
      ) : (
        /* 区域之间的间距由 .node-groups 统一给（节点 / 存储两页共用同一个容器类） */
        <div className="node-groups">
          {regionGroups.map((region) => {
            /* 区域默认展开（见上面两级状态的说明）：空数组 = 全部展开 */
            const regionOpen =
              !showRegion || !collapsedRegions.includes(region.id);
            const nodeCount = region.conns.reduce(
              (n, pve) => n + pve.items.length,
              0,
            );
            return (
              <section className="tree-group" key={`region:${region.id}`}>
                {/* 最外层：区域 / 机房。整条都是开关 */}
                {showRegion ? (
                  <button
                    type="button"
                    className="tree-head is-region"
                    aria-expanded={regionOpen}
                    onClick={() => toggleRegion(region.id)}
                  >
                    <span className="tree-head-icon">
                      <IconChevronDown size={15} />
                    </span>
                    <IconLayers size={15} />
                    <span className="tree-name">{region.label}</span>
                    <span className="tree-meta">
                      <Badge variant="neutral" size="sm">
                        {t('networks.pveCount', { n: region.conns.length })}
                      </Badge>
                      <Badge variant="neutral" size="sm">
                        {t('networks.nodeCount', { n: nodeCount })}
                      </Badge>
                    </span>
                  </button>
                ) : null}

                {regionOpen ? (
                  /* 不渲染区域头时（一条连接都没填区域），这一层也就不该有缩进 */
                  <div
                    className={
                      showRegion ? 'tree-body' : 'flex flex-col gap-16'
                    }
                  >
                    {region.conns.map(renderConnectionGroup)}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      {/* ---- IP 地址池 ---- */}
      <IpPoolPanel />
    </PageShell>
  );
}
