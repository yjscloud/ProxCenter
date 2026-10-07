/* ==========================================================================
   ProxCenter — 节点
   ==========================================================================

   这一页承担两件事，因为它们本来就是同一个问题的两面：

   1. **看节点**：多台 PVE、每台若干节点时，平铺的大卡片很快就会变成
      「一片长得差不多的方块」—— 45 个节点要滚五六屏才看完，还看不出谁在冒烟。
      所以补了「列表视图」：一行一个节点，CPU / 内存 / 磁盘三根迷你条横向对齐，
      一屏看几十个，谁红谁绿一眼分辨；再按来源 PVE 分组，多主机不会混在一起。
      卡片视图保留给节点不多的场景（信息更舒展，备注输入框也好点）。
   2. **管连接**：节点连不上时，要修的是「连接」，不是节点本身。连接配置
      因此挪到了同一功能域下的子页面 `/nodes/connections`（点顶部子页签或
      「添加节点」都能进）—— 但它不该和节点列表挤在一页：那张表单很长，
      混在下面会把节点列表顶到屏幕外。
   ========================================================================== */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clusterApi, connectionsApi, nodesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Input, SegmentedControl, Select } from '../components/ui/Input';
import { CardSkeleton } from '../components/ui/Spinner';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { NodeSubNav } from '../components/NodeSubNav';
import {
  IconServer,
  IconRefresh,
  IconCpu,
  IconMemory,
  IconDisk,
  IconActivity,
  IconClose,
  IconPlus,
  IconSearch,
  IconChevronRight,
  IconPlug,
} from '../components/Icons';
import {
  formatBytes,
  formatUptime,
  formatUptimeShort,
  toPercent,
  usageColor,
} from '../utils/format';
import { nodeStatusMeta } from '../utils/status'
import { useT, type MessageKey } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { NodeNoteField, useNodeMeta } from '../components/NodeMeta';
import type { NodeInfo } from '../api/types';

/* 「集群失去仲裁」提示的关闭状态记忆键 */
const QUORUM_NOTICE_KEY = 'pve_quorum_notice_dismissed';
/* 视图偏好：节点少时卡片好看，节点多时列表好用，让用户自己定 */
const VIEW_KEY = 'pve_nodes_view';

type ViewMode = 'list' | 'cards';
type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'status';

const SORT_OPTIONS: Array<{ label: MessageKey; value: SortKey }> = [
  { label: 'nodes.sortName', value: 'name' },
  { label: 'nodes.sortCpu', value: 'cpu' },
  { label: 'nodes.sortMem', value: 'mem' },
  { label: 'nodes.sortDisk', value: 'disk' },
  { label: 'nodes.sortStatus', value: 'status' },
];

export function Nodes() {
  const t = useT();
  const navigate = useNavigate();
  /* 连接写操作需要 settings.manage，仅管理员可进入表单 */
  const { isAdmin } = useAuth();

  /* ---- 视图与筛选 ---- */
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'list';
    } catch {
      return 'list';
    }
  });
  const [search, setSearch] = useState('');
  const [connFilter, setConnFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* 忽略 */
    }
  }, [view]);

  /* 提示允许用户关掉，关掉后记住；等仲裁恢复正常会自动清掉标记，
     这样下次真出问题时还会重新提醒，而不是永久失声 */
  const [quorumDismissed, setQuorumDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(QUORUM_NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    refetchInterval: 10_000,
  });

  const clusterQuery = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: clusterApi.status,
    refetchInterval: 30_000,
    retry: false,
  });

  /* 多台 PVE 同时在线：哪台连不上要能说明白，否则「列表里少了一台」会被误当成 bug */
  const connStatusQuery = useQuery({
    queryKey: ['connections', 'status'],
    queryFn: connectionsApi.status,
    refetchInterval: 30_000,
    retry: false,
  });
  const failedConnections = (connStatusQuery.data ?? []).filter((c) => !c.ok);
  /* 连得上但读不到指标 = 令牌权限不足，PVE 会把虚拟机/模板返回成空列表 */
  const limitedConnections = (connStatusQuery.data ?? []).filter(
    (c) => c.ok && !c.node_metrics,
  );

  /* ---- 默认读取的 PVE ----
     少数接口（健康探活、/cluster/status）一次只能读一台，页头那行「集群版本 /
     仲裁」就取自它。多套 PVE 时「读哪一套」必须由人决定，否则「这里怎么只有
     一台的版本」是个没人答得上的问题。它**不等于主连接**：其余连接照样同级，
     下方节点列表也仍然汇总全部连接。 */
  const queryClient = useQueryClient();
  const toast = useToast();
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
    enabled: isAdmin,
  });
  const conns = connectionsQuery.data ?? [];
  const defaultConnId = conns.find((item) => item.active)?.id ?? '';
  const [switchingDefault, setSwitchingDefault] = useState(false);

  const pickDefaultConn = async (id: string) => {
    if (!id || id === defaultConnId) return;
    setSwitchingDefault(true);
    try {
      await connectionsApi.activate(id);
      toast.success(
        t('nodes.defaultPveSwitched'),
        t('nodes.defaultPveSwitchedHint', {
          name: conns.find((item) => item.id === id)?.name || id,
        }),
      );
      /* 只读单台的接口都要重取：页头的集群版本 / 仲裁、健康探活，以及全站合计 */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['connections'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'fleet-status'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ]);
    } catch (err) {
      toast.error(t('nodes.defaultPveSwitchFailed'), errorMessage(err));
    } finally {
      setSwitchingDefault(false);
    }
  };

  const list = useMemo(() => nodesQuery.data ?? [], [nodesQuery.data]);

  /* ---- 过滤 + 排序 ----
     排序把「有问题」的排前面，而不是只按字母：运维打开这一页通常是为了
     找谁在冒烟，不是来查通讯录的。 */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const connId = connFilter || '';
    const filtered = list.filter((n) => {
      if (connId && (n.connection_id ?? '') !== connId) return false;
      if (!q) return true;
      const haystack = [n.node, n.connection_name, n.level, n.kernel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    const score = (n: NodeInfo) => {
      switch (sortKey) {
        case 'cpu':
          return toPercent(n.cpu);
        case 'mem':
          return n.maxmem ? ((n.mem ?? 0) / n.maxmem) * 100 : 0;
        case 'disk':
          return n.maxdisk ? ((n.disk ?? 0) / n.maxdisk) * 100 : 0;
        case 'status':
          // 离线 / 未知排前面，其余按名称
          return n.status === 'online' ? 1 : 0;
        default:
          return 0;
      }
    };

    return [...filtered].sort((a, b) => {
      if (sortKey === 'name') return a.node.localeCompare(b.node);
      if (sortKey === 'status') {
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        return a.node.localeCompare(b.node);
      }
      // 负载类排序：占用高的在前
      const diff = score(b) - score(a);
      if (Math.abs(diff) > 0.0001) return diff;
      return a.node.localeCompare(b.node);
    });
  }, [list, search, connFilter, sortKey]);

  /* ---- 按来源 PVE 分组 ----
     多主机同名节点最容易踩坑，分组后「这是哪台机器上的 node1」一目了然；
     只有一条连接时不分组（组标题纯属占地方）。 */
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; nodes: NodeInfo[] }>();
    for (const node of visible) {
      const key = node.connection_id ?? '';
      const existing = map.get(key);
      if (existing) {
        existing.nodes.push(node);
      } else {
        map.set(key, {
          label: node.connection_name || node.node || t('nodes.defaultConnection'),
          nodes: [node],
        });
      }
    }
    return [...map.entries()].map(([id, value]) => ({ id, ...value }));
  }, [visible, t]);
  const grouped = groups.length > 1;

  const connectionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of list) {
      const id = n.connection_id ?? '';
      if (!seen.has(id)) seen.set(id, n.connection_name || t('nodes.defaultConnection'));
    }
    return [
      { label: t('nodes.allHosts'), value: '' },
      ...[...seen.entries()].map(([value, label]) => ({ label, value })),
    ];
  }, [list, t]);

  /* 后端在「单机（未组集群）」时返回 quorate=null —— 那不是失去仲裁，不能报警。
     所以必须用 === false 判断；写成 !quorate 会把单机环境也误报成集群故障。 */
  const quorate = clusterQuery.data?.quorate ?? null;
  const showQuorumWarning = quorate === false && !quorumDismissed;
  const quorumLabel =
    quorate === true
      ? t('nodes.quorumOk')
      : quorate === false
        ? t('nodes.quorumBad')
        : t('nodes.quorumStandalone');

  const onlineCount = list.filter((n) => n.status === 'online').length;

  /* 仲裁恢复正常 → 清掉「已关闭」标记，下次真异常时重新提示 */
  useEffect(() => {
    if (quorate !== true || !quorumDismissed) return;
    setQuorumDismissed(false);
    try {
      localStorage.removeItem(QUORUM_NOTICE_KEY);
    } catch {
      /* 忽略 */
    }
  }, [quorate, quorumDismissed]);

  const dismissQuorumNotice = () => {
    setQuorumDismissed(true);
    try {
      localStorage.setItem(QUORUM_NOTICE_KEY, '1');
    } catch {
      /* 忽略 */
    }
  };

  const openDetail = (node: NodeInfo) =>
    navigate(
      `/nodes/${encodeURIComponent(node.node)}${
        node.connection_id ? `?conn=${encodeURIComponent(node.connection_id)}` : ''
      }`,
    );

  /* 「添加节点」= 接入一台新的 Proxmox 主机：跳到连接配置子页面并直接
     摊开「新增连接」表单（?new=1 由 ConnectionManager 读取） */
  const addNode = () => navigate('/nodes/connections?new=1');

  return (
    <PageShell
      title={
        <>
          <IconServer size={20} />
          {t('nodes.title')}
        </>
      }
      subtitle={
        clusterQuery.data
          ? t('nodes.subtitle', {
              version: clusterQuery.data.version || t('common.unknown'),
              quorum: quorumLabel,
              online: onlineCount,
              total: list.length,
              connections: groups.length,
            })
          : t('dashboard.subtitle.loading')
      }
      actions={
        <>
          <SegmentedControl<ViewMode>
            value={view}
            onChange={setView}
            ariaLabel={t('nodes.viewAria')}
            options={[
              { label: t('nodes.viewCards'), value: 'cards' },
              { label: t('nodes.viewList'), value: 'list' },
            ]}
          />
          {isAdmin ? (
            <Button
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={addNode}
              title={t('nodes.addNodeTitle')}
            >
              {t('nodes.addNode')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void nodesQuery.refetch();
              void clusterQuery.refetch();
              void connStatusQuery.refetch();
            }}
            loading={nodesQuery.isFetching && !nodesQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      <NodeSubNav active="nodes" />

      {/* 多套 PVE 时「读哪一套」必须能选：页头的集群版本 / 仲裁这类接口一次只能
          读一台，默认由后端挑（第一条），而那往往不是想看的那台。 */}
      {isAdmin && conns.length > 1 ? (
        <div className="scope-bar">
          <span className="scope-label">
            <IconPlug size={15} />
            {t('nodes.defaultPveLabel')}
          </span>
          <Select
            aria-label={t('nodes.defaultPveLabel')}
            value={defaultConnId}
            disabled={switchingDefault}
            onChange={(event) => void pickDefaultConn(event.target.value)}
            options={conns.map((item) => ({
              label: `${item.name || item.host}${
                item.id === defaultConnId ? t('nodes.defaultPveCurrent') : ''
              }`,
              value: item.id,
            }))}
            style={{ maxWidth: 280 }}
          />
          <span className="scope-meta">{t('nodes.defaultPveHint')}</span>
        </div>
      ) : null}

      {showQuorumWarning ? (
        <Notice
          tone="danger"
          title={t('nodes.quorumNoticeTitle')}
          action={
            <IconButton label={t('nodes.dismissNotice')} onClick={dismissQuorumNotice}>
              <IconClose size={15} />
            </IconButton>
          }
        >
          {t('nodes.quorumNoticeBody')}
        </Notice>
      ) : null}

      {failedConnections.length > 0 ? (
        <Notice
          tone="warning"
          title={t('nodes.failedConnsTitle', { n: failedConnections.length })}
        >
          {t('nodes.failedConnsBody')}
          {failedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {isAdmin ? t('nodes.failedConnsTailAdmin') : t('nodes.failedConnsTailUser')}
          {isAdmin ? (
            <div className="mt-8">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/nodes/connections')}
              >
                {t('nodes.goConnections')}
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {limitedConnections.length > 0 ? (
        <Notice
          tone="warning"
          title={t('nodes.limitedConnsTitle', { n: limitedConnections.length })}
        >
          {t('nodes.limitedConnsBody')}
          {limitedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {isAdmin ? t('nodes.limitedConnsTailAdmin') : t('nodes.limitedConnsTailUser')}
        </Notice>
      ) : null}

      {/* ---- 工具栏：节点多时才值得占一行 ---- */}
      {list.length > 3 ? (
        <div className="toolbar">
          <div className="toolbar-left">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('nodes.searchPlaceholder')}
              prefix={<IconSearch size={15} />}
              block={false}
              aria-label={t('nodes.searchAria')}
            />
            {connectionOptions.length > 2 ? (
              <Select
                value={connFilter}
                onChange={(e) => setConnFilter(e.target.value)}
                options={connectionOptions}
                aria-label={t('nodes.filterConnAria')}
              />
            ) : null}
            <Select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              options={SORT_OPTIONS.map((s) => ({ label: t(s.label), value: s.value }))}
              aria-label={t('nodes.sortAria')}
            />
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              {t('nodes.showing', { shown: visible.length, total: list.length })}
            </span>
          </div>
        </div>
      ) : null}

      {nodesQuery.isLoading ? (
        <CardSkeleton count={3} height={220} />
      ) : nodesQuery.isError ? (
        <ErrorState
          title={t('nodes.loadFailed')}
          message={errorMessage(nodesQuery.error)}
          onRetry={() => void nodesQuery.refetch()}
        />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title={t('nodes.emptyTitle')}
            description={isAdmin ? t('nodes.emptyAdmin') : t('nodes.emptyUser')}
            icon={<IconServer size={30} />}
            action={
              isAdmin ? (
                <Button
                  variant="primary"
                  icon={<IconPlus size={15} />}
                  onClick={addNode}
                >
                  {t('nodes.addNode')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={t('nodes.noMatchTitle')}
            description={t('nodes.noMatchDesc')}
            compact
          />
        </Card>
      ) : view === 'list' ? (
        <div className="node-groups">
          {groups.map((group) => (
            <Card key={group.id || 'default'} padded={false}>
              {grouped ? (
                <div className="node-group-head">
                  <IconServer size={14} />
                  <span className="fw-600">{group.label}</span>
                  <span className="fs-xs text-muted">
                    {t('nodes.onlineRatio', {
                      online: group.nodes.filter((n) => n.status === 'online').length,
                      total: group.nodes.length,
                    })}
                  </span>
                </div>
              ) : null}

              <div className="node-list" role="list">
                <div className="node-list-row is-head" aria-hidden="true">
                  <span>{t('nodes.colNode')}</span>
                  <span>{t('common.status')}</span>
                  <span>{t('nodes.colCpu')}</span>
                  <span>{t('nodes.colMem')}</span>
                  <span>{t('nodes.colDisk')}</span>
                  <span>{t('nodes.colUptime')}</span>
                  <span>{t('nodes.colNote')}</span>
                  <span />
                </div>
                {group.nodes.map((node) => (
                  <NodeListRow key={`${node.connection_id ?? ''}:${node.node}`} node={node} onOpen={() => openDetail(node)} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="node-groups">
          {groups.map((group) => (
            <div key={group.id || 'default'}>
              {grouped ? (
                <div className="node-group-title">
                  <IconServer size={14} />
                  {group.label}
                  <span className="fs-xs text-muted">
                    {t('nodes.onlineRatio', {
                      online: group.nodes.filter((n) => n.status === 'online').length,
                      total: group.nodes.length,
                    })}
                  </span>
                </div>
              ) : null}
              <div className="grid grid-auto-320">
                {group.nodes.map((node) => (
                  <NodeCard
                    key={`${node.connection_id ?? ''}:${node.node}`}
                    node={node}
                    onOpen={() => openDetail(node)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   指标百分比（卡片与列表共用同一套口径）
   --------------------------------------------------------------------------- */

function nodePercents(node: NodeInfo) {
  return {
    cpu: toPercent(node.cpu),
    mem: node.maxmem > 0 ? ((node.mem ?? 0) / node.maxmem) * 100 : 0,
    disk: node.maxdisk > 0 ? ((node.disk ?? 0) / node.maxdisk) * 100 : 0,
  };
}

/* ---------------------------------------------------------------------------
   列表视图的一行
   ---------------------------------------------------------------------------
   一行一个节点：名称 / 状态 / 三根迷你条 / 运行时长 / 备注。
   行整体可点进详情，备注是输入框，必须拦住冒泡。
   --------------------------------------------------------------------------- */

function NodeListRow({ node, onOpen }: { node: NodeInfo; onOpen: () => void }) {
  const t = useT();
  const { canWrite } = useAuth();
  const pct = nodePercents(node);
  const meta = nodeStatusMeta(node.status, t);
  const offline = node.status !== 'online';
  const { version, address } = useNodeMeta(node.node, !offline, node.connection_id);

  return (
    <div
      className={`node-list-row${offline ? ' is-offline' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={t('nodes.viewNodeAria', { node: node.node })}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div className="node-list-name">
        <span className="fw-600 truncate">{node.node}</span>
        <span className="fs-xs text-muted truncate">
          {version
            ? t('nodes.pveVersion', { version })
            : node.kernel
              ? t('nodes.kernel', { kernel: node.kernel })
              : ''}
          {address ? ` · ${address}` : ''}
        </span>
      </div>

      <div className="node-list-status">
        <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
          {meta.label}
        </Badge>
        {node.level ? (
          <Badge variant="warning" size="sm" title={t('nodes.maintenanceLevel', { level: node.level })}>
            {t('nodes.maintenance')}
          </Badge>
        ) : null}
      </div>

      <NodeListMetric
        percent={pct.cpu}
        sub={node.maxcpu ? t('dashboard.nodes.cores', { n: node.maxcpu }) : '—'}
        offline={offline}
      />
      <NodeListMetric percent={pct.mem} sub={formatBytes(node.maxmem, 0)} offline={offline} />
      <NodeListMetric percent={pct.disk} sub={formatBytes(node.maxdisk, 0)} offline={offline} />

      <span className="fs-sm text-secondary truncate">
        {offline ? t('nodes.offline') : formatUptimeShort(node.uptime)}
      </span>

      {/* 备注是可编辑输入框，必须拦住冒泡 —— 否则点一下就会触发跳转 */}
      <div
        className="node-list-note"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <NodeNoteField node={node.node} canEdit={canWrite} />
      </div>

      <IconChevronRight size={14} />
    </div>
  );
}

function NodeListMetric({
  percent,
  sub,
  offline,
}: {
  percent: number;
  sub: string;
  offline: boolean;
}) {
  const color = offline ? 'var(--text-muted)' : usageColor(percent);
  return (
    <div className="node-list-metric">
      <span className="mono fs-sm" style={{ color }}>
        {offline ? '—' : `${percent.toFixed(1)}%`}
      </span>
      <ProgressBar value={offline ? 0 : percent} color={color} height={5} />
      <span className="fs-xs text-muted truncate">{sub}</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   卡片视图（节点不多的场景）
   --------------------------------------------------------------------------- */

function NodeCard({ node, onOpen }: { node: NodeInfo; onOpen: () => void }) {
  const t = useT();
  const { canWrite } = useAuth();
  const pct = nodePercents(node);
  const meta = nodeStatusMeta(node.status, t);
  const offline = node.status !== 'online';
  /* 地址与 PVE 版本是按需拉取的补充信息 */
  const { version, address } = useNodeMeta(node.node, !offline, node.connection_id);

  return (
    <article
      className="entity-card node-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      role="button"
      tabIndex={0}
      aria-label={t('nodes.viewNodeAria', { node: node.node })}
    >
      <div className="entity-card-head">
        <div className="entity-card-title">
          <span className="entity-card-name">{node.node}</span>
          <span className="entity-card-sub">
            {version
              ? t('nodes.pveVersion', { version })
              : node.kernel
                ? t('nodes.kernel', { kernel: node.kernel })
                : t('nodes.nodeLabel', { node: node.node })}
            {address ? ` · ${address}` : ''}
          </span>
        </div>
        <div className="entity-card-badges">
          {node.connection_name ? (
            <Badge
              variant="neutral"
              size="sm"
              title={t('nodes.sourceHost', { name: node.connection_name })}
            >
              {node.connection_name}
            </Badge>
          ) : null}
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        </div>
      </div>

      {/* 指标区：数值 + 迷你条合并到一格，替代原先「数值区 + 进度条区」两份重复展示 */}
      <div className="node-metrics">
        <NodeMetric
          icon={<IconCpu size={12} />}
          label={t('nodes.colCpu')}
          percent={pct.cpu}
          sub={node.maxcpu ? t('dashboard.nodes.cores', { n: node.maxcpu }) : '—'}
          offline={offline}
        />
        <NodeMetric
          icon={<IconMemory size={12} />}
          label={t('nodes.colMem')}
          percent={pct.mem}
          sub={formatBytes(node.maxmem, 0)}
          offline={offline}
        />
        <NodeMetric
          icon={<IconDisk size={12} />}
          label={t('nodes.colDisk')}
          percent={pct.disk}
          sub={formatBytes(node.maxdisk, 0)}
          offline={offline}
        />
      </div>

      {/* 备注是可编辑输入框，必须拦住冒泡 —— 否则点一下就会触发卡片跳转 */}
      <div
        className="node-card-note"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <NodeNoteField node={node.node} canEdit={canWrite} />
      </div>

      <div className="node-card-foot">
        <span className="fs-xs text-muted flex items-center gap-6">
          <IconActivity size={12} />
          {offline
            ? t('nodes.offline')
            : t('dashboard.nodes.uptime', { uptime: formatUptimeShort(node.uptime) })}
        </span>
        {node.level ? (
          <Badge variant="warning" size="sm">
            {t('nodes.maintenanceLevel', { level: node.level })}
          </Badge>
        ) : (
          <span className="fs-xs text-muted">
            {offline ? '—' : formatUptime(node.uptime)}
          </span>
        )}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------------------
   指标格：图标 + 名称 + 大数值 + 迷你进度条 + 规格
   把「百分比」「进度条」「总量」收在一格内，避免同一份数据在卡片里出现两次。
   --------------------------------------------------------------------------- */

function NodeMetric({
  icon,
  label,
  percent,
  sub,
  offline,
}: {
  icon: ReactNode;
  label: string;
  percent: number;
  sub: string;
  offline: boolean;
}) {
  const color = offline ? 'var(--text-muted)' : usageColor(percent);
  return (
    <div className="node-metric">
      <span className="node-metric-label">
        {icon} {label}
      </span>
      <span className="node-metric-value" style={{ color }}>
        {offline ? '—' : `${percent.toFixed(1)}%`}
      </span>
      <ProgressBar value={offline ? 0 : percent} color={color} height={6} />
      <span className="node-metric-sub">{sub}</span>
    </div>
  );
}
