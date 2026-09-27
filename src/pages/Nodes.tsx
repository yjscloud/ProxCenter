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
import { useQuery } from '@tanstack/react-query';
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
} from '../components/Icons';
import {
  formatBytes,
  formatUptime,
  formatUptimeShort,
  toPercent,
  usageColor,
} from '../utils/format';
import { nodeStatusMeta } from '../utils/status';
import { useAuth } from '../hooks/useAuth';
import { NodeNoteField, useNodeMeta } from '../components/NodeMeta';
import type { NodeInfo } from '../api/types';

/* 「集群失去仲裁」提示的关闭状态记忆键 */
const QUORUM_NOTICE_KEY = 'pve_quorum_notice_dismissed';
/* 视图偏好：节点少时卡片好看，节点多时列表好用，让用户自己定 */
const VIEW_KEY = 'pve_nodes_view';

type ViewMode = 'list' | 'cards';
type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'status';

const SORT_OPTIONS: Array<{ label: string; value: SortKey }> = [
  { label: '按名称排序', value: 'name' },
  { label: '按 CPU 负载排序', value: 'cpu' },
  { label: '按内存占用排序', value: 'mem' },
  { label: '按磁盘占用排序', value: 'disk' },
  { label: '离线优先', value: 'status' },
];

export function Nodes() {
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
          label: node.connection_name || node.node || '默认连接',
          nodes: [node],
        });
      }
    }
    return [...map.entries()].map(([id, value]) => ({ id, ...value }));
  }, [visible]);
  const grouped = groups.length > 1;

  const connectionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of list) {
      const id = n.connection_id ?? '';
      if (!seen.has(id)) seen.set(id, n.connection_name || '默认连接');
    }
    return [
      { label: '全部 PVE 主机', value: '' },
      ...[...seen.entries()].map(([value, label]) => ({ label, value })),
    ];
  }, [list]);

  /* 后端在「单机（未组集群）」时返回 quorate=null —— 那不是失去仲裁，不能报警。
     所以必须用 === false 判断；写成 !quorate 会把单机环境也误报成集群故障。 */
  const quorate = clusterQuery.data?.quorate ?? null;
  const showQuorumWarning = quorate === false && !quorumDismissed;
  const quorumLabel =
    quorate === true ? '仲裁正常' : quorate === false ? '仲裁异常' : '单机模式';

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
          节点
        </>
      }
      subtitle={
        clusterQuery.data
          ? `集群版本 ${clusterQuery.data.version || '未知'} · ${quorumLabel} · ${onlineCount}/${list.length} 在线 · ${groups.length} 个 PVE 连接`
          : '正在加载集群信息…'
      }
      actions={
        <>
          <SegmentedControl<ViewMode>
            value={view}
            onChange={setView}
            ariaLabel="节点展示方式"
            options={[
              { label: '卡片', value: 'cards' },
              { label: '列表', value: 'list' },
            ]}
          />
          {isAdmin ? (
            <Button
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={addNode}
              title="接入一台新的 Proxmox 主机（新增 PVE 连接）"
            >
              添加节点
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
            刷新
          </Button>
        </>
      }
    >
      <NodeSubNav active="nodes" />

      {showQuorumWarning ? (
        <Notice
          tone="danger"
          title="集群失去仲裁"
          action={
            <IconButton label="关闭提示" onClick={dismissQuorumNotice}>
              <IconClose size={15} />
            </IconButton>
          }
        >
          当前集群不满足法定节点数（quorate=false），部分操作可能被拒绝。请检查各节点间的
          Corosync 通信与网络状态。
        </Notice>
      ) : null}

      {failedConnections.length > 0 ? (
        <Notice tone="warning" title={`${failedConnections.length} 台 PVE 连接异常`}>
          以下主机暂时取不到数据，其余主机不受影响：
          {failedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {`。${isAdmin ? '可在「连接配置」子页面中修正（例如使用「修复权限」）。' : '请联系管理员在「连接配置」子页面中修正。'}`}
          {isAdmin ? (
            <div className="mt-8">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/nodes/connections')}
              >
                前往连接配置
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {limitedConnections.length > 0 ? (
        <Notice tone="warning" title={`${limitedConnections.length} 台 PVE 的令牌权限不足`}>
          这些主机能连上，但读不到节点指标与虚拟机/模板列表（Proxmox 对无权限的读取
          返回空结果，而不是报错）：
          {limitedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {`。${isAdmin ? '请到「连接配置」子页面对该连接使用「修复权限」。' : '请联系管理员处理。'}`}
        </Notice>
      ) : null}

      {/* ---- 工具栏：节点多时才值得占一行 ---- */}
      {list.length > 3 ? (
        <div className="toolbar">
          <div className="toolbar-left">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索节点名、来源主机…"
              prefix={<IconSearch size={15} />}
              block={false}
              aria-label="搜索节点"
            />
            {connectionOptions.length > 2 ? (
              <Select
                value={connFilter}
                onChange={(e) => setConnFilter(e.target.value)}
                options={connectionOptions}
                aria-label="按来源 PVE 筛选"
              />
            ) : null}
            <Select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              options={SORT_OPTIONS.map((s) => ({ label: s.label, value: s.value }))}
              aria-label="排序方式"
            />
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              显示 {visible.length} / {list.length} 个节点
            </span>
          </div>
        </div>
      ) : null}

      {nodesQuery.isLoading ? (
        <CardSkeleton count={3} height={220} />
      ) : nodesQuery.isError ? (
        <ErrorState
          title="无法加载节点列表"
          message={errorMessage(nodesQuery.error)}
          onRetry={() => void nodesQuery.refetch()}
        />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title="暂无节点"
            description={
              isAdmin
                ? '面板还没有接入可用的 Proxmox 主机。点「添加节点」填写 PVE 地址与 API Token 即可。'
                : '集群中没有检测到任何节点，请联系管理员检查 Proxmox 连接配置。'
            }
            icon={<IconServer size={30} />}
            action={
              isAdmin ? (
                <Button
                  variant="primary"
                  icon={<IconPlus size={15} />}
                  onClick={addNode}
                >
                  添加节点
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title="没有匹配的节点"
            description="调整搜索关键词或来源主机筛选试试。"
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
                    {group.nodes.filter((n) => n.status === 'online').length}/
                    {group.nodes.length} 在线
                  </span>
                </div>
              ) : null}

              <div className="node-list" role="list">
                <div className="node-list-row is-head" aria-hidden="true">
                  <span>节点</span>
                  <span>状态</span>
                  <span>CPU</span>
                  <span>内存</span>
                  <span>磁盘</span>
                  <span>运行时长</span>
                  <span>备注</span>
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
                    {group.nodes.filter((n) => n.status === 'online').length}/
                    {group.nodes.length} 在线
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
  const { canWrite } = useAuth();
  const pct = nodePercents(node);
  const meta = nodeStatusMeta(node.status);
  const offline = node.status !== 'online';
  const { version, address } = useNodeMeta(node.node, !offline, node.connection_id);

  return (
    <div
      className={`node-list-row${offline ? ' is-offline' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`查看节点 ${node.node} 详情`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div className="node-list-name">
        <span className="fw-600 truncate">{node.node}</span>
        <span className="fs-xs text-muted truncate">
          {version ? `PVE ${version}` : node.kernel ? `内核 ${node.kernel}` : ''}
          {address ? ` · ${address}` : ''}
        </span>
      </div>

      <div className="node-list-status">
        <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
          {meta.label}
        </Badge>
        {node.level ? (
          <Badge variant="warning" size="sm" title={`维护级别 ${node.level}`}>
            维护
          </Badge>
        ) : null}
      </div>

      <NodeListMetric percent={pct.cpu} sub={node.maxcpu ? `${node.maxcpu} 核` : '—'} offline={offline} />
      <NodeListMetric percent={pct.mem} sub={formatBytes(node.maxmem, 0)} offline={offline} />
      <NodeListMetric percent={pct.disk} sub={formatBytes(node.maxdisk, 0)} offline={offline} />

      <span className="fs-sm text-secondary truncate">
        {offline ? '节点离线' : formatUptimeShort(node.uptime)}
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
  const { canWrite } = useAuth();
  const pct = nodePercents(node);
  const meta = nodeStatusMeta(node.status);
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
      aria-label={`查看节点 ${node.node} 详情`}
    >
      <div className="entity-card-head">
        <div className="entity-card-title">
          <span className="entity-card-name">{node.node}</span>
          <span className="entity-card-sub">
            {version
              ? `PVE ${version}`
              : node.kernel
                ? `内核 ${node.kernel}`
                : `节点 ${node.node}`}
            {address ? ` · ${address}` : ''}
          </span>
        </div>
        <div className="entity-card-badges">
          {node.connection_name ? (
            <Badge
              variant="neutral"
              size="sm"
              title={`来源主机：${node.connection_name}`}
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
          label="CPU"
          percent={pct.cpu}
          sub={node.maxcpu ? `${node.maxcpu} 核` : '—'}
          offline={offline}
        />
        <NodeMetric
          icon={<IconMemory size={12} />}
          label="内存"
          percent={pct.mem}
          sub={formatBytes(node.maxmem, 0)}
          offline={offline}
        />
        <NodeMetric
          icon={<IconDisk size={12} />}
          label="磁盘"
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
          {offline ? '节点离线' : `运行 ${formatUptimeShort(node.uptime)}`}
        </span>
        {node.level ? (
          <Badge variant="warning" size="sm">
            维护级别 {node.level}
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
