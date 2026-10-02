/* ==========================================================================
   ProxCenter — 节点详情
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clusterApi, connectionsApi, nodesApi, storagesApi } from '../api/endpoints';
import { isNotImplemented } from '../api/client';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { Breadcrumb } from '../components/Topbar';
import {
  Card,
  CardHeader,
  InfoGrid,
  InfoRow,
  KpiCard,
} from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DetailSkeleton } from '../components/ui/Spinner';
import { ErrorState, Notice } from '../components/ui/EmptyState';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Table, type Column } from '../components/ui/Table';
import {
  CpuChart,
  DiskIoChart,
  FilesystemChart,
  IowaitChart,
  LoadChart,
  MemoryChart,
  NetworkChart,
  PressureChart,
  SwapChart,
} from '../components/MetricChart';
import { DiskHealthPanel } from '../components/DiskHealthPanel';
import {
  IconServer,
  IconRefresh,
  IconNetwork,
  IconStorage,
  IconTasks,
  IconMonitor,
  IconPlus,
  IconEdit,
  IconTrash,
  IconCheck,
  IconCpu,
  IconMemory,
  IconDisk,
} from '../components/Icons';
import {
  formatBytes,
  formatDateTime,
  formatUptime,
  formatUptimeShort,
  toPercent,
  usageColor,
  usageTone,
} from '../utils/format';
import {
  contentLabel,
  isBridgeType,
  isPhysicalType,
  netTypeLabel,
  nodeStatusMeta,
  storageStatusMeta,
  taskStatusMeta,
} from '../utils/status'
import { useT } from '../i18n';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  NetworkInterface,
  NetworkInterfaceInput,
  NodeInfo,
  NodeStatus,
  RrdPoint,
  RrdTimeframe,
  Storage,
  TaskInfo,
} from '../api/types';

type TabKey = 'overview' | 'network' | 'storage' | 'tasks' | 'monitor';

/* 分区页签在组件内构造（文案随语言走），见 NodeDetail 里的 tabs */

/** PVE 的 loadavg 可能是字符串数组，统一转成保留两位小数的字符串。 */
function formatLoad(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

export function NodeDetail() {
  const t = useT();
  const { node = '' } = useParams<{ node: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs = useMemo(
    () => [
      {
        key: 'overview' as TabKey,
        label: t('nodeDetail.tabOverview'),
        icon: <IconServer size={15} />,
      },
      {
        key: 'network' as TabKey,
        label: t('nodeDetail.tabNetwork'),
        icon: <IconNetwork size={15} />,
      },
      {
        key: 'storage' as TabKey,
        label: t('nodeDetail.tabStorage'),
        icon: <IconStorage size={15} />,
      },
      {
        key: 'tasks' as TabKey,
        label: t('nodeDetail.tabTasks'),
        icon: <IconTasks size={15} />,
      },
      {
        key: 'monitor' as TabKey,
        label: t('nodeDetail.tabMonitor'),
        icon: <IconMonitor size={15} />,
      },
    ],
    [t],
  );

  /* 多台 PVE 合并展示时，不同主机可能出现同名节点；连接标识从列表页带过来，
     否则详情页会落到「当前连接」那台，看到别人家的监控数据。 */
  const conn = searchParams.get('conn') ?? '';

  const tabParam = (searchParams.get('tab') as TabKey | null) ?? 'overview';
  const tab: TabKey = tabs.some((item) => item.key === tabParam)
    ? tabParam
    : 'overview';

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  /* 列出所有连接，以便头部可以展示「数据来自哪台」徽标。
     —— 多主机同名节点最容易踩坑，让用户一眼看清当前是哪个 PVE 的视图。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
  });
  const connProfile = (connectionsQuery.data ?? []).find((c) => c.id === conn);
  const connName = connProfile?.name || connProfile?.host || conn;

  const nodesQuery = useQuery({
    queryKey: ['nodes', conn],
    queryFn: () => nodesApi.list(conn),
    refetchInterval: 10_000,
  });

  const nodeInfo: NodeInfo | undefined = useMemo(
    () =>
      (nodesQuery.data ?? []).find(
        (n) => n.node === node && (!conn || n.connection_id === conn),
      ),
    [nodesQuery.data, node, conn],
  );

  const statusQuery = useQuery({
    queryKey: ['nodes', conn, node, 'status'],
    queryFn: () => nodesApi.status(node, conn),
    enabled: Boolean(node),
    refetchInterval: 15_000,
  });

  if (!node) {
    return (
      <div className="page">
        <ErrorState
          title={t('nodeDetail.invalidNode')}
          onRetry={() => navigate('/nodes')}
        />
      </div>
    );
  }

  if (nodesQuery.isLoading) {
    return (
      <div className="page">
        <DetailSkeleton />
      </div>
    );
  }

  const status: NodeStatus | undefined = statusQuery.data;

  return (
    <div className="page">
      {/* ---- 头部 ---- */}
      <div className="detail-header">
        <div className="detail-header-main">
          <Breadcrumb
            items={[{ label: t('nodeDetail.breadcrumbNodes'), to: '/nodes' }, { label: node }]}
          />
          <div className="detail-title-row">
            <span className="detail-name">{node}</span>
            {connName ? (
              <Badge variant="info" size="sm" title={t('nodeDetail.connBadgeTitle')}>
                <IconServer size={12} />
                {connName}
              </Badge>
            ) : null}
            <Badge
              variant={nodeStatusMeta(nodeInfo?.status, t).variant}
              dot
              pulse={nodeStatusMeta(nodeInfo?.status, t).pulse}
            >
              {nodeStatusMeta(nodeInfo?.status, t).label}
            </Badge>
            {status?.pveversion ? (
              <Badge variant="neutral" size="sm">
                {status.pveversion}
              </Badge>
            ) : null}
            {nodeInfo?.level ? (
              <Badge variant="warning" size="sm">
                {t('nodeDetail.maintenanceLevel', { level: nodeInfo.level })}
              </Badge>
            ) : null}
          </div>
          <div className="detail-meta">
            <span className="detail-meta-item">
              <IconCpu size={13} />
              {t('nodeDetail.cores', { n: status?.cpus ?? nodeInfo?.maxcpu ?? '—' })}
            </span>
            <span className="detail-meta-item">
              <IconMemory size={13} />
              {formatBytes(status?.memory?.total ?? nodeInfo?.maxmem)}
            </span>
            <span className="detail-meta-item">
              <IconDisk size={13} />
              {formatBytes(status?.rootfs?.total ?? nodeInfo?.maxdisk)}
            </span>
            <span className="detail-meta-item">
              {t('nodeDetail.uptime', {
                time: formatUptime(status?.uptime ?? nodeInfo?.uptime),
              })}
            </span>
          </div>
        </div>

        <div className="detail-actions">
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void nodesQuery.refetch();
              void statusQuery.refetch();
            }}
            loading={statusQuery.isFetching && !statusQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* ---- Tabs ---- */}
      <div className="tabs" role="tablist" aria-label={t('nodeDetail.tabsAria')}>
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* 多台 PVE 同时在线时，URL 没带 conn 参数就会落到「当前连接」那台，
         同名节点（两台都叫 "pve"）会拿错数据 —— 显式提示并给出回到列表的入口。 */}
      {!conn && (connectionsQuery.data?.length ?? 0) > 1 ? (
        <Notice
          tone="warning"
          title={t('nodeDetail.connUnknownTitle')}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/nodes')}
            >
              {t('nodeDetail.backToList')}
            </Button>
          }
        >
          {t('nodeDetail.connUnknownPre')}
          <span className="mono">?conn=&lt;id&gt;</span>
          {t('nodeDetail.connUnknownMid')}
        </Notice>
      ) : null}

      <div className="tab-panel">
        {tab === 'overview' ? (
          <NodeOverview
            node={node}
            conn={conn}
            nodeInfo={nodeInfo}
            status={status}
            loading={statusQuery.isLoading}
          />
        ) : null}
        {tab === 'network' ? <NetworkTab node={node} conn={conn} /> : null}
        {tab === 'storage' ? <NodeStorageTab node={node} conn={conn} /> : null}
        {tab === 'tasks' ? <NodeTasksTab node={node} /> : null}
        {tab === 'monitor' ? <NodeMonitorTab node={node} conn={conn} /> : null}
      </div>
    </div>
  );
}

/* ==========================================================================
   概览
   ========================================================================== */

function NodeOverview({
  node,
  conn,
  nodeInfo,
  status,
  loading,
}: {
  node: string;
  conn: string;
  nodeInfo?: NodeInfo;
  status?: NodeStatus;
  loading: boolean;
}) {
  const t = useT();

  if (loading) return <DetailSkeleton />;

  const cpuPct = toPercent(status?.cpu ?? nodeInfo?.cpu);
  const memTotal = status?.memory?.total ?? nodeInfo?.maxmem ?? 0;
  const memUsed = status?.memory?.used ?? nodeInfo?.mem ?? 0;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const rootTotal = status?.rootfs?.total ?? nodeInfo?.maxdisk ?? 0;
  const rootUsed = status?.rootfs?.used ?? nodeInfo?.disk ?? 0;
  const rootPct = rootTotal > 0 ? (rootUsed / rootTotal) * 100 : 0;
  const swapTotal = status?.swap?.total ?? 0;
  const swapUsed = status?.swap?.used ?? 0;
  const swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

  return (
    <div className="detail-columns">
      <div className="detail-column">
        <Card>
          <CardHeader
            title={t('nodeDetail.resourceUsage')}
            icon={<IconMonitor size={16} />}
          />
          <div className="flex flex-col gap-16">
            <ProgressBar
              label={t('nodeDetail.cpuLabel', {
                n: status?.cpus ?? nodeInfo?.maxcpu ?? 0,
              })}
              value={cpuPct}
              showValue
              height={8}
              color={usageColor(cpuPct)}
            />
            <ProgressBar
              label={t('nodeDetail.memLabel', {
                used: formatBytes(memUsed),
                total: formatBytes(memTotal),
              })}
              value={memPct}
              showValue
              height={8}
              color={usageColor(memPct)}
            />
            <ProgressBar
              label={t('nodeDetail.rootfsLabel', {
                used: formatBytes(rootUsed),
                total: formatBytes(rootTotal),
              })}
              value={rootPct}
              showValue
              height={8}
              color={usageColor(rootPct)}
            />
            {swapTotal > 0 ? (
              <ProgressBar
                label={t('nodeDetail.swapLabel', {
                  used: formatBytes(swapUsed),
                  total: formatBytes(swapTotal),
                })}
                value={swapPct}
                showValue
                height={8}
                color={usageColor(swapPct)}
              />
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('nodeDetail.loadKernel')} icon={<IconCpu size={16} />} />
          {status?.loadavg && status.loadavg.length >= 3 ? (
            <InfoGrid>
              <InfoRow
                label={t('nodeDetail.load1')}
                value={formatLoad(status.loadavg[0])}
                mono
              />
              <InfoRow
                label={t('nodeDetail.load5')}
                value={formatLoad(status.loadavg[1])}
                mono
              />
              <InfoRow
                label={t('nodeDetail.load15')}
                value={formatLoad(status.loadavg[2])}
                mono
              />
            </InfoGrid>
          ) : (
            <Notice tone="info">{t('nodeDetail.loadUnsupported', { node })}</Notice>
          )}
        </Card>
      </div>

      <div className="detail-column">
        <Card>
          <CardHeader title={t('nodeDetail.nodeInfo')} icon={<IconServer size={16} />} />
          <InfoGrid>
            <InfoRow label={t('nodeDetail.fieldNodeName')} value={node} mono />
            <InfoRow
              label={t('nodeDetail.fieldStatus')}
              value={
                <Badge
                  variant={nodeStatusMeta(nodeInfo?.status, t).variant}
                  dot
                  size="sm"
                >
                  {nodeStatusMeta(nodeInfo?.status, t).label}
                </Badge>
              }
            />
            <InfoRow
              label={t('nodeDetail.fieldCpuCores')}
              value={status?.cpus ?? nodeInfo?.maxcpu ?? '—'}
              mono
            />
            <InfoRow
              label={t('nodeDetail.fieldMemTotal')}
              value={formatBytes(memTotal)}
              mono
            />
            <InfoRow
              label={t('nodeDetail.fieldRootfs')}
              value={formatBytes(rootTotal)}
              mono
            />
            <InfoRow
              label={t('nodeDetail.fieldUptime')}
              value={formatUptimeShort(status?.uptime ?? nodeInfo?.uptime)}
              mono
            />
            {status?.pveversion ? (
              <InfoRow
                label={t('nodeDetail.fieldPveVersion')}
                value={status.pveversion}
                mono
              />
            ) : null}
            {status?.kernel ? (
              <InfoRow
                label={t('nodeDetail.fieldKernel')}
                value={status.kernel}
                mono
              />
            ) : null}
            {nodeInfo?.ssl_fingerprint ? (
              /* 指纹是 95 字符的冒号分隔十六进制串（SHA-256），_info-value 自带的
                 overflow-wrap 会在窄列里把它折成好几行、极难比对。这里让它占满
                 整行，读起来就是一行完整指纹 —— 比对证书时要看的是全文。 */
              <InfoRow
                label={t('nodeDetail.fieldSslFingerprint')}
                value={nodeInfo.ssl_fingerprint}
                mono
                className="detail-full"
              />
            ) : null}
          </InfoGrid>
        </Card>

        {/* 磁盘健康是「事前」信号：硬盘快坏了在这里就能看到，
            而不是等虚拟机 IO 报错。放在概览里保证一眼可见。 */}
        <DiskHealthPanel node={node} conn={conn} />
      </div>
    </div>
  );
}

/* ==========================================================================
   网络 Tab（重点）
   ========================================================================== */

/** 本地追踪待应用的变更（Proxmox 有 pending 概念，这里简化处理） */
const PENDING_KEY = 'pve_network_pending';

function readPending(node: string): Set<string> {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as Record<string, string[]>;
    return new Set(map[node] ?? []);
  } catch {
    return new Set();
  }
}

function writePending(node: string, set: Set<string>): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    map[node] = [...set];
    localStorage.setItem(PENDING_KEY, JSON.stringify(map));
  } catch {
    /* 忽略 */
  }
}

function NetworkTab({ node, conn }: { node: string; conn: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const toast = useToast();
  const { hasPermission } = useAuth();
  /* 宿主机网络是高危操作（配错可能让节点失联），后端只授予管理员
     network.manage；界面沿用同一判定，避免按钮可点但提交必然 403。 */
  const canManageNet = hasPermission('network.manage');

  const [editing, setEditing] = useState<NetworkInterface | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NetworkInterface | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => readPending(node));

  const netQuery = useQuery({
    queryKey: ['nodes', conn, node, 'network'],
    queryFn: () => nodesApi.network(node, conn),
    enabled: Boolean(node),
    retry: false,
    staleTime: 20_000,
  });

  const ifaces = netQuery.data ?? [];

  /* 可作为桥接端口的物理网卡 */
  const physicalIfaces = useMemo(
    () => ifaces.filter((i) => isPhysicalType(i.type)),
    [ifaces],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['nodes', node, 'network'] });
  }, [queryClient, node]);

  const markPending = (iface: string, isPending = true) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (isPending) next.add(iface);
      else next.delete(iface);
      writePending(node, next);
      return next;
    });
  };

  /* ---- 应用配置（reload） ---- */
  const applyChanges = async () => {
    if (pending.size === 0) return;
    setBusy(true);
    try {
      for (const iface of pending) {
        try {
          await runner.run(nodesApi.reloadNetwork(node, iface, conn), {
            title: t('nodeDetail.netTaskReload', { iface }),
            node,
            invalidate: [['nodes', node, 'network']],
          });
          markPending(iface, false);
        } catch {
          /* 继续处理其余网卡 */
        }
      }
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<NetworkInterface>> = [
    {
      key: 'iface',
      header: t('nodeDetail.colIface'),
      render: (i) => (
        <div className="net-cell">
          <div className="flex items-center gap-8">
            <span className="mono fw-600">{i.iface}</span>
            {pending.has(i.iface) ? (
              <Badge variant="warning" size="sm" dot>
                {t('nodeDetail.pendingBadge')}
              </Badge>
            ) : null}
          </div>
          {/* 取址方式。manual 是 PVE 的默认值（等于没配地址），不值一行；
              真正有信息量的是 static / dhcp 这两种 —— 换机器后 IP 会不会变，
              取决于这一行。 */}
          {i.method && i.method !== 'manual' ? (
            <span className="net-sub mono">{i.method}</span>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (i) => i.iface,
      width: 180,
    },
    {
      key: 'type',
      header: t('nodeDetail.colType'),
      render: (i) => (
        <Badge variant={isBridgeType(i.type) ? 'accent' : 'neutral'} size="sm">
          {netTypeLabel(i.type, t)}
        </Badge>
      ),
      width: 130,
      sortable: true,
      sortValue: (i) => i.type,
    },
    {
      key: 'active',
      header: t('nodeDetail.colActive'),
      width: 130,
      render: (i) => (
        <div className="net-cell">
          <Badge
            variant={i.active ? 'success' : 'neutral'}
            dot
            pulse={i.active}
            size="sm"
          >
            {i.active ? t('nodeDetail.active') : t('nodeDetail.inactive')}
          </Badge>
          {/* 桥 / bond 能不能跟着开机起来，看的就是 autostart */}
          {i.autostart ? (
            <span className="net-sub">{t('nodeDetail.netAutostart')}</span>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (i) => (i.active ? 1 : 0),
    },
    {
      /* 网关并进地址列：两者本是同一件事（同一网段里的地址与出口），
         拆成两列要来回扫才能对上。
         另外 cidr 本身已经含地址，PVE 又同时给 address + netmask ——
         早先三个字段一起塞进一格会渲染成「172.16.149.3 / 172.16.149.3/24」，
         同一个地址写了两遍。所以优先用 cidr，缺了才退回 address+netmask。 */
      key: 'address',
      header: t('nodeDetail.colAddress'),
      render: (i) => {
        const addr =
          i.cidr ||
          (i.address ? (i.netmask ? `${i.address}/${i.netmask}` : i.address) : '');
        return (
          <div className="net-cell">
            {addr ? (
              <span className="mono fs-sm">{addr}</span>
            ) : (
              <span className="text-muted">—</span>
            )}
            {i.gateway ? (
              <span className="net-sub mono">
                {t('nodeDetail.netGw')} {i.gateway}
              </span>
            ) : null}
          </div>
        );
      },
      sortable: true,
      sortValue: (i) => i.cidr || i.address || '',
      width: 210,
    },
    {
      key: 'ports',
      header: t('nodeDetail.colPorts'),
      render: (i) => {
        const list = (i.bridge_ports || i.bond_slaves || '')
          .split(/[\s,]+/)
          .filter(Boolean);
        if (!list.length && i.type !== 'vlan') {
          return <span className="text-muted">—</span>;
        }
        /* 逐个拆成芯片：一整串逗号文本既数不出有几个、也认不出是哪个 */
        return (
          <div className="net-chips">
            {i.type === 'vlan' ? (
              <span className="net-chip is-accent mono">
                {t('nodeDetail.netVlanId', { id: i.vlan_id ?? '—' })}
              </span>
            ) : null}
            {list.map((p) => (
              <span className="net-chip mono" key={p}>
                {p}
              </span>
            ))}
          </div>
        );
      },
      width: 210,
    },
    {
      key: 'actions',
      header: t('nodeDetail.colActions'),
      width: 120,
      align: 'right',
      render: (i) => (
        <span className="row-actions">
          <IconButton
            label={t('nodeDetail.editIfaceAria', { iface: i.iface })}
            onClick={() => setEditing(i)}
            disabled={!canManageNet || busy}
          >
            <IconEdit size={15} />
          </IconButton>
          <IconButton
            label={t('nodeDetail.applyIfaceAria', { iface: i.iface })}
            variant="primary"
            onClick={async () => {
              setBusy(true);
              try {
                await runner.run(nodesApi.reloadNetwork(node, i.iface, conn), {
                  title: t('nodeDetail.netTaskReload', { iface: i.iface }),
                  node,
                  invalidate: [['nodes', node, 'network']],
                });
                markPending(i.iface, false);
                invalidate();
              } finally {
                setBusy(false);
              }
            }}
            disabled={!canManageNet || busy}
          >
            <IconCheck size={15} />
          </IconButton>
          <IconButton
            label={t('nodeDetail.deleteIfaceAria', { iface: i.iface })}
            variant="danger"
            onClick={() => setDeleteTarget(i)}
            disabled={!canManageNet || busy}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  const notImpl = isNotImplemented(netQuery.error);

  return (
    <>
      {/* 只读账号的说明：网卡写操作需要 network.manage（仅管理员） */}
      {!canManageNet ? (
        <div className="mb-16">
          <Notice tone="info" title={t('nodeDetail.readonlyTitle')}>
            {t('nodeDetail.netReadonlyBody')}
          </Notice>
        </div>
      ) : null}

      {/* 待应用提示 */}
      {pending.size > 0 ? (
        <div className="mb-16">
          <Notice
            tone="warning"
            title={t('nodeDetail.pendingTitle', { n: pending.size })}
            action={
              canManageNet ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void applyChanges()}
                  loading={busy}
                >
                  {t('nodeDetail.applyConfig')}
                </Button>
              ) : undefined
            }
          >
            {t('nodeDetail.pendingBody')}
          </Notice>
        </div>
      ) : null}

      {/* collapsible={false}：网卡表是这一页的主内容，不该被标题栏点一下就折起来。
          标题栏改用 CardHeader，与概览里的卡片同一套排版 —— 原来那段内联
          style 手搓的 div（padding / border / flex 都写死在 JSX 里）既和全站
          不一致，也没有 --border-muted 之外的响应式处理。 */}
      <Card padded={false} collapsible={false}>
        <CardHeader
          icon={<IconNetwork size={16} />}
          title={
            <span className="flex items-center gap-8">
              {t('nodeDetail.netIfaces')}
              <Badge variant="neutral" size="sm">
                {ifaces.length}
              </Badge>
            </span>
          }
          actions={
            <>
              <IconButton
                label={t('nodeDetail.refreshIfaces')}
                onClick={() => void netQuery.refetch()}
              >
                <IconRefresh size={16} />
              </IconButton>
              <Button
                variant="primary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setCreateOpen(true)}
                disabled={!canManageNet}
              >
                {t('nodeDetail.addIface')}
              </Button>
            </>
          }
        />

        {notImpl ? (
          <div style={{ padding: 16 }}>
            <Notice tone="info" title={t('nodeDetail.needsBackendTitle')}>
              {t('nodeDetail.netNotImpl', { node })}
            </Notice>
          </div>
        ) : (
          <Table<NetworkInterface>
            columns={columns}
            rows={ifaces}
            rowKey={(i) => i.iface}
            loading={netQuery.isLoading}
            caption={t('nodeDetail.netCaption', { node })}
            emptyTitle={t('nodeDetail.netEmpty')}
            emptyDescription={t('nodeDetail.netEmptyDesc')}
            className="table-flush"
          />
        )}
      </Card>

      {/* ---- 新增 / 编辑 ---- */}
      <NetworkFormModal
        open={createOpen || Boolean(editing)}
        editing={editing}
        node={node}
        conn={conn}
        physicalIfaces={physicalIfaces}
        allIfaces={ifaces}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        onSaved={(iface) => {
          markPending(iface, true);
          invalidate();
          setCreateOpen(false);
          setEditing(null);
          toast.info(
            t('nodeDetail.configSaved'),
            t('nodeDetail.configSavedHint'),
          );
        }}
      />

      {/* ---- 删除 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await runner.run(
              nodesApi.deleteNetwork(node, deleteTarget.iface, conn),
              {
                title: t('nodeDetail.deleteTask', { iface: deleteTarget.iface }),
                node,
                invalidate: [['nodes', node, 'network']],
              },
            );
            markPending(deleteTarget.iface, false);
            setDeleteTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('nodeDetail.deleteTitle')}
        danger
        confirmText={t('nodeDetail.deleteConfirm')}
        loading={busy}
        message={
          <>
            {t('nodeDetail.deleteMessagePre')}
            <strong>{deleteTarget?.iface}</strong>
            {t('nodeDetail.deleteMessageMid')}
            {netTypeLabel(deleteTarget?.type, t)}
            {t('nodeDetail.deleteMessagePost')}
          </>
        }
      />
    </>
  );
}

/* ---------------------------------------------------------------------------
   网卡表单
   --------------------------------------------------------------------------- */

/* 网卡类型选项在表单组件内取词构造（见 NetworkFormModal 的 netTypeOptions） */

interface NetFormState {
  iface: string;
  type: string;
  address: string;
  cidr: string;
  gateway: string;
  bridgePorts: string[];
  bondSlaves: string[];
  bondMode: string;
  vlanId: string;
  vlanRawDevice: string;
  mtu: string;
  autostart: boolean;
  comments: string;
}

const emptyForm: NetFormState = {
  iface: '',
  type: 'bridge',
  address: '',
  cidr: '',
  gateway: '',
  bridgePorts: [],
  bondSlaves: [],
  bondMode: 'balance-rr',
  vlanId: '',
  vlanRawDevice: '',
  mtu: '',
  autostart: true,
  comments: '',
};

function NetworkFormModal({
  open,
  editing,
  node,
  conn,
  physicalIfaces,
  allIfaces,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: NetworkInterface | null;
  node: string;
  conn: string;
  physicalIfaces: NetworkInterface[];
  allIfaces: NetworkInterface[];
  onClose: () => void;
  onSaved: (iface: string) => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const toast = useToast();

  const netTypeOptions = useMemo(
    () => [
      { label: t('nodeDetail.netType.bridge'), value: 'bridge' },
      { label: t('nodeDetail.netType.eth'), value: 'eth' },
      { label: t('nodeDetail.netType.bond'), value: 'bond' },
      { label: t('nodeDetail.netType.vlan'), value: 'vlan' },
      { label: t('nodeDetail.netType.ovsBridge'), value: 'OVSBridge' },
      { label: t('nodeDetail.netType.ovsBond'), value: 'OVSBond' },
      { label: t('nodeDetail.netType.ovsIntPort'), value: 'OVSIntPort' },
    ],
    [t],
  );

  const [form, setForm] = useState<NetFormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        iface: editing.iface,
        type: editing.type,
        address: editing.address ?? '',
        cidr: editing.cidr ?? '',
        gateway: editing.gateway ?? '',
        bridgePorts: (editing.bridge_ports ?? '')
          .split(/[\s,;]+/)
          .filter(Boolean),
        bondSlaves: (editing.bond_slaves ?? '')
          .split(/[\s,;]+/)
          .filter(Boolean),
        bondMode: 'balance-rr',
        vlanId: editing.vlan_id ? String(editing.vlan_id) : '',
        vlanRawDevice: editing.vlan_raw_device ?? '',
        mtu: editing.mtu ? String(editing.mtu) : '',
        autostart: editing.autostart ?? true,
        comments: editing.comments ?? '',
      });
    } else {
      setForm(emptyForm);
    }
    setErrors({});
  }, [open, editing]);

  const set = <K extends keyof NetFormState>(key: K, value: NetFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.iface.trim()) e.iface = t('nodeDetail.errIfaceRequired');
    else if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(form.iface)) {
      e.iface = t('nodeDetail.errIfaceFormat');
    }
    if (form.gateway && !/^\d{1,3}(\.\d{1,3}){3}$/.test(form.gateway)) {
      e.gateway = t('nodeDetail.errGateway');
    }
    if (form.cidr && !/^\d{1,3}(\.\d{1,3}){3}$/.test(form.cidr)) {
      e.cidr = t('nodeDetail.errCidr');
    }
    if (form.type === 'bridge' && form.bridgePorts.length === 0 && !editing) {
      // 允许空（无端口网桥也是合法的）
    }
    if (form.type === 'vlan' && !form.vlanId) {
      e.vlanId = t('nodeDetail.errVlanId');
    }
    if (form.type === 'vlan' && !form.vlanRawDevice) {
      e.vlanRawDevice = t('nodeDetail.errVlanRaw');
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) {
      toast.warning(t('nodeDetail.formInvalid'), t('nodeDetail.formInvalidHint'));
      return;
    }
    setBusy(true);
    try {
      const payload: NetworkInterfaceInput = {
        iface: form.iface.trim(),
        type: form.type,
        address: form.address || undefined,
        cidr: form.cidr || undefined,
        gateway: form.gateway || undefined,
        bridge_ports:
          form.type === 'bridge' && form.bridgePorts.length > 0
            ? form.bridgePorts.join(' ')
            : undefined,
        bond_slaves:
          (form.type === 'bond' || form.type === 'OVSBond') &&
          form.bondSlaves.length > 0
            ? form.bondSlaves.join(' ')
            : undefined,
        vlan_id: form.type === 'vlan' && form.vlanId ? Number(form.vlanId) : undefined,
        vlan_raw_device:
          form.type === 'vlan' ? form.vlanRawDevice || undefined : undefined,
        mtu: form.mtu ? Number(form.mtu) : undefined,
        autostart: form.autostart,
        comments: form.comments || undefined,
      };

      const promise = editing
        ? nodesApi.updateNetwork(node, editing.iface, payload, conn)
        : nodesApi.createNetwork(node, payload, conn);

      await runner.run(promise, {
        title: editing
          ? t('nodeDetail.netModalEditTitle', { iface: editing.iface })
          : t('nodeDetail.netModalNewTitle'),
        node,
        invalidate: [['nodes', node, 'network']],
      });

      onSaved(payload.iface);
    } catch {
      /* toast 已提示 */
    } finally {
      setBusy(false);
    }
  };

  const isBridge = form.type === 'bridge' || isBridgeType(form.type);
  const isBond = form.type === 'bond' || form.type === 'OVSBond';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        editing
          ? t('nodeDetail.netModalEditTitle', { iface: editing.iface })
          : t('nodeDetail.netModalNewTitle')
      }
      description={t('nodeDetail.netModalDesc', { node })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {editing ? t('nodeDetail.saveChanges') : t('nodeDetail.createIface')}
          </Button>
        </>
      }
    >
      <div className="form-grid-2">
        <Input
          label={t('nodeDetail.fieldIfaceName')}
          required
          value={form.iface}
          onChange={(e) => set('iface', e.target.value)}
          placeholder={t('nodeDetail.ifacePlaceholder')}
          error={errors.iface}
          disabled={Boolean(editing)}
          hint={
            editing ? t('nodeDetail.ifaceHintEdit') : t('nodeDetail.ifaceHintNew')
          }
          mono
        />
        <Select
          label={t('nodeDetail.fieldIfaceType')}
          required
          value={form.type}
          onChange={(e) => set('type', e.target.value)}
          options={netTypeOptions}
          disabled={Boolean(editing)}
          hint={editing ? t('nodeDetail.typeHintEdit') : t('nodeDetail.typeHintNew')}
        />
      </div>

      {/* --- 桥接端口 --- */}
      {isBridge ? (
        <div className="mt-16">
          <Field
            label={t('nodeDetail.fieldBridgePorts')}
            hint={t('nodeDetail.bridgePortsHint')}
          >
            {physicalIfaces.length === 0 ? (
              <Notice tone="info">{t('nodeDetail.noPhysicalIfaces')}</Notice>
            ) : (
              <div className="checkbox-grid">
                {physicalIfaces.map((p) => (
                  <Checkbox
                    key={p.iface}
                    checked={form.bridgePorts.includes(p.iface)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...form.bridgePorts, p.iface]
                        : form.bridgePorts.filter((x) => x !== p.iface);
                      set('bridgePorts', next);
                    }}
                    label={
                      <span className="flex items-center gap-6">
                        <span className="mono">{p.iface}</span>
                        <span className="fs-xs text-muted">
                          {netTypeLabel(p.type, t)}
                          {p.active ? '' : t('nodeDetail.inactiveSuffix')}
                        </span>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </Field>
          {form.bridgePorts.length > 0 ? (
            <div className="fs-sm text-secondary mt-8">
              {t('nodeDetail.selectedPorts')}
              <span className="mono">{form.bridgePorts.join(' ')}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* --- Bond --- */}
      {isBond ? (
        <>
          <div className="mt-16">
            <Field
              label={t('nodeDetail.fieldBondSlaves')}
              hint={t('nodeDetail.bondSlavesHint')}
            >
              <div className="checkbox-grid">
                {physicalIfaces.map((p) => (
                  <Checkbox
                    key={p.iface}
                    checked={form.bondSlaves.includes(p.iface)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...form.bondSlaves, p.iface]
                        : form.bondSlaves.filter((x) => x !== p.iface);
                      set('bondSlaves', next);
                    }}
                    label={<span className="mono">{p.iface}</span>}
                  />
                ))}
              </div>
            </Field>
          </div>
          <div className="mt-16">
            <Select
              label={t('nodeDetail.fieldBondMode')}
              value={form.bondMode}
              onChange={(e) => set('bondMode', e.target.value)}
              options={[
                { label: t('nodeDetail.bondMode.balanceRr'), value: 'balance-rr' },
                { label: t('nodeDetail.bondMode.activeBackup'), value: 'active-backup' },
                { label: t('nodeDetail.bondMode.balanceXor'), value: 'balance-xor' },
                { label: t('nodeDetail.bondMode.lacp'), value: '802.3ad' },
                { label: t('nodeDetail.bondMode.balanceTlb'), value: 'balance-tlb' },
                { label: t('nodeDetail.bondMode.balanceAlb'), value: 'balance-alb' },
              ]}
            />
          </div>
        </>
      ) : null}

      {/* --- VLAN --- */}
      {form.type === 'vlan' ? (
        <div className="form-grid-2 mt-16">
          <Select
            label={t('nodeDetail.fieldVlanRaw')}
            required
            value={form.vlanRawDevice}
            onChange={(e) => set('vlanRawDevice', e.target.value)}
            options={[
              { label: t('nodeDetail.selectPhysicalIface'), value: '' },
              ...allIfaces
                .filter((i) => isPhysicalType(i.type) || isBridgeType(i.type))
                .map((i) => ({ label: i.iface, value: i.iface })),
            ]}
            error={errors.vlanRawDevice}
          />
          <Input
            label={t('nodeDetail.fieldVlanId')}
            required
            type="number"
            min={1}
            max={4094}
            value={form.vlanId}
            onChange={(e) => set('vlanId', e.target.value)}
            error={errors.vlanId}
            mono
          />
        </div>
      ) : null}

      {/* --- IP 配置 --- */}
      <div className="mt-24 wizard-section-title">{t('nodeDetail.ipConfig')}</div>
      <div className="form-grid-2">
        <Input
          label={t('nodeDetail.fieldIp')}
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          placeholder={t('nodeDetail.ipPlaceholder')}
          mono
          hint={t('nodeDetail.ipHint')}
        />
        <Input
          label={t('nodeDetail.fieldMask')}
          value={form.cidr}
          onChange={(e) => set('cidr', e.target.value)}
          placeholder={t('nodeDetail.maskPlaceholder')}
          mono
          error={errors.cidr}
          hint={t('nodeDetail.maskHint')}
        />
        <Input
          label={t('nodeDetail.fieldGateway')}
          value={form.gateway}
          onChange={(e) => set('gateway', e.target.value)}
          placeholder={t('nodeDetail.gatewayPlaceholder')}
          mono
          error={errors.gateway}
        />
        <Input
          label={t('nodeDetail.fieldMtu')}
          type="number"
          min={576}
          max={9000}
          value={form.mtu}
          onChange={(e) => set('mtu', e.target.value)}
          placeholder={t('nodeDetail.mtuPlaceholder')}
          mono
        />
      </div>

      <div className="mt-16">
        <Textarea
          label={t('nodeDetail.fieldComments')}
          rows={2}
          value={form.comments}
          onChange={(e) => set('comments', e.target.value)}
          placeholder={t('nodeDetail.commentsPlaceholder')}
        />
      </div>

      <div className="mt-16">
        <Switch
          checked={form.autostart}
          onChange={(v) => set('autostart', v)}
          label={t('nodeDetail.autostart')}
          hint={t('nodeDetail.autostartHint')}
        />
      </div>

      <div className="mt-16">
        <Notice tone="warning" title={t('nodeDetail.riskTitle')}>
          {t('nodeDetail.riskBodyPre')}
          <code>vmbr0</code>
          {t('nodeDetail.riskBodyPost')}
        </Notice>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   存储 Tab
   ========================================================================== */

function NodeStorageTab({ node, conn }: { node: string; conn: string }) {
  const t = useT();
  const navigate = useNavigate();

  const storagesQuery = useQuery({
    queryKey: ['storages', conn, node],
    queryFn: () => storagesApi.list(node, conn),
    staleTime: 30_000,
  });

  const columns: Array<Column<Storage>> = [
    {
      key: 'storage',
      header: t('nodeDetail.colStorageName'),
      render: (s) => <span className="fw-500">{s.storage}</span>,
      sortable: true,
      sortValue: (s) => s.storage,
    },
    {
      key: 'type',
      header: t('nodeDetail.colType'),
      render: (s) => (
        <Badge variant="neutral" size="sm">
          {s.type}
        </Badge>
      ),
      width: 110,
      sortable: true,
      sortValue: (s) => s.type,
    },
    {
      key: 'content',
      header: t('nodeDetail.colContent'),
      render: (s) => <span className="fs-sm">{contentLabel(s.content, t)}</span>,
    },
    {
      key: 'active',
      header: t('common.status'),
      width: 100,
      render: (s) => {
        const meta = storageStatusMeta(s.active, t);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'shared',
      header: t('nodeDetail.colShared'),
      width: 80,
      align: 'center',
      render: (s) => (
        <Badge variant={s.shared ? 'info' : 'neutral'} size="sm">
          {s.shared ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'usage',
      header: t('nodeDetail.colUsage'),
      width: 200,
      render: (s) => {
        const pct = s.total > 0 ? (s.used / s.total) * 100 : 0;
        return (
          <div style={{ minWidth: 160 }}>
            <div className="flex items-center justify-between gap-8 fs-sm">
              <span className="text-secondary mono">
                {formatBytes(s.used, 0)} / {formatBytes(s.total, 0)}
              </span>
              <span className="mono" style={{ color: usageColor(pct) }}>
                {pct.toFixed(1)}%
              </span>
            </div>
            <ProgressBar value={pct} height={5} color={usageColor(pct)} />
          </div>
        );
      },
      sortable: true,
      sortValue: (s) => (s.total > 0 ? s.used / s.total : 0),
    },
    {
      key: 'actions',
      header: '',
      width: 90,
      align: 'right',
      render: () => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/storages')}
        >
          {t('nodeDetail.browse')}
        </Button>
      ),
    },
  ];

  if (isNotImplemented(storagesQuery.error)) {
    return (
      <Notice tone="info" title={t('nodeDetail.needsBackendTitle')}>
        {t('nodeDetail.storageNotImpl')}
      </Notice>
    );
  }

  return (
    <Card padded={false}>
      <Table<Storage>
        columns={columns}
        rows={storagesQuery.data ?? []}
        rowKey={(s) => `${s.node}/${s.storage}`}
        loading={storagesQuery.isLoading}
        caption={t('nodeDetail.storageCaption', { node })}
        emptyTitle={t('nodeDetail.storageEmpty')}
        emptyDescription={t('nodeDetail.storageEmptyDesc')}
        className="table-flush"
      />
    </Card>
  );
}

/* ==========================================================================
   任务 Tab
   ========================================================================== */

function NodeTasksTab({ node }: { node: string }) {
  const t = useT();
  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', node, 50],
    queryFn: () => clusterApi.tasks({ node, limit: 50 }),
    refetchInterval: 10_000,
    retry: false,
  });

  const columns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: t('nodeDetail.colType'),
      render: (row) => <span className="mono fs-sm">{row.type}</span>,
      sortable: true,
      sortValue: (row) => row.type,
    },
    {
      key: 'id',
      header: t('nodeDetail.colTarget'),
      render: (t) => (
        <span className="mono fs-sm text-secondary">{t.id ?? '—'}</span>
      ),
      width: 110,
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (row) => {
        const meta = taskStatusMeta(row.status, row.exitstatus, t);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      width: 110,
      sortable: true,
      sortValue: (row) => row.exitstatus ?? row.status,
    },
    {
      key: 'user',
      header: t('nodeDetail.colUser'),
      render: (row) => (
        <span className="fs-sm text-secondary">{row.user ?? '—'}</span>
      ),
      width: 150,
    },
    {
      key: 'start',
      header: t('nodeDetail.colStart'),
      render: (row) => (
        <span className="fs-sm mono">{formatDateTime(row.starttime)}</span>
      ),
      width: 160,
      sortable: true,
      sortValue: (row) => row.starttime ?? 0,
    },
    {
      key: 'duration',
      header: t('nodeDetail.colDuration'),
      align: 'right',
      width: 90,
      render: (row) => (
        <span className="mono fs-sm text-secondary">
          {row.starttime && row.endtime
            ? formatUptimeShort(row.endtime - row.starttime)
            : row.status === 'running'
              ? t('nodeDetail.running')
              : '—'}
        </span>
      ),
    },
  ];

  if (isNotImplemented(tasksQuery.error)) {
    return (
      <Notice tone="info" title={t('nodeDetail.needsBackendTitle')}>
        {t('nodeDetail.tasksNotImpl')}
      </Notice>
    );
  }

  return (
    <Card padded={false}>
      <Table<TaskInfo>
        columns={columns}
        rows={tasksQuery.data ?? []}
        rowKey={(t) => t.upid}
        loading={tasksQuery.isLoading}
        caption={t('nodeDetail.tasksCaption', { node })}
        emptyTitle={t('nodeDetail.tasksEmpty')}
        emptyDescription={t('nodeDetail.tasksEmptyDesc')}
        className="table-flush"
      />
    </Card>
  );
}

/* ==========================================================================
   监控 Tab
   ========================================================================== */

function NodeMonitorTab({ node, conn }: { node: string; conn: string }) {
  const t = useT();
  const [timeframe, setTimeframe] = useState<RrdTimeframe>('hour');

  const rrdQuery = useQuery({
    queryKey: ['nodes', conn, node, 'rrd', timeframe],
    queryFn: () => nodesApi.rrddata(node, timeframe, conn),
    // 监控页要求实时感：5 秒拉一次，配合数值缓动与曲线动画
    refetchInterval: 5_000,
    retry: false,
  });

  const points: RrdPoint[] = useMemo(() => rrdQuery.data ?? [], [rrdQuery.data]);
  const notImpl = isNotImplemented(rrdQuery.error);

  /* 这两项不是每台机器都有，用来决定要不要渲染对应的图 */
  const hasSwap = useMemo(
    () => points.some((p) => (p.swaptotal ?? 0) > 0),
    [points],
  );
  const hasPressure = useMemo(
    () =>
      points.some(
        (p) =>
          p.pressurecpusome !== undefined ||
          p.pressureiosome !== undefined ||
          p.pressurememorysome !== undefined,
      ),
    [points],
  );

  /* 最新一个 RRD 采样点：用于顶部实时读数卡 */
  const latest = points.length > 0 ? points[points.length - 1] : undefined;
  const memTotal = latest?.memtotal ?? latest?.maxmem ?? 0;
  const memUsed = latest?.memused ?? latest?.mem ?? 0;
  const latestMemRaw =
    memTotal > 0
      ? (memUsed / memTotal) * 100
      : 0;
  /* 读数做缓动：5 秒刷新一次时数字平滑滚动，而不是硬跳 */
  const latestCpu = useAnimatedNumber(toPercent(latest?.cpu ?? 0));
  const latestMem = useAnimatedNumber(latestMemRaw);

  return (
    <div className="flex flex-col gap-20">
      <div className="flex items-center justify-between gap-12 flex-wrap">
        <span className="live-indicator">
          <span className="live-dot" aria-hidden="true" />
          {t('nodeDetail.liveIndicator')}
        </span>
        <SegmentedControl<RrdTimeframe>
          value={timeframe}
          onChange={setTimeframe}
          ariaLabel={t('nodeDetail.timeframeAria')}
          options={[
            { label: t('nodeDetail.tfHour'), value: 'hour' },
            { label: t('nodeDetail.tfDay'), value: 'day' },
            { label: t('nodeDetail.tfWeek'), value: 'week' },
            { label: t('nodeDetail.tfMonth'), value: 'month' },
          ]}
        />
      </div>

      {notImpl ? (
        <Notice tone="info" title={t('nodeDetail.monitorNotImplTitle')}>
          {t('nodeDetail.monitorNotImpl', { node })}
        </Notice>
      ) : null}

      {/* 实时读数：进入监控页第一眼就能看到当前负载 */}
      {latest ? (
        <div className="grid grid-4">
          <KpiCard
            label={t('nodeDetail.kpiCpu')}
            value={`${latestCpu.toFixed(1)}%`}
            tone={usageTone(latestCpu)}
            progress={latestCpu}
            progressColor={usageColor(latestCpu)}
            hint={
              <span className="text-secondary">{t('nodeDetail.latestSample')}</span>
            }
          />
          <KpiCard
            label={t('nodeDetail.kpiMemUsed')}
            value={formatBytes(memUsed, 0)}
            hint={<span className="mono">/ {formatBytes(memTotal, 0)}</span>}
            tone={usageTone(latestMem)}
            progress={latestMem}
            progressColor={usageColor(latestMem)}
          />
          <KpiCard
            label={t('nodeDetail.kpiNet')}
            value={`${formatBytes((latest.netin ?? 0) + (latest.netout ?? 0), 0)}/s`}
            hint={
              <>
                <span className="text-success">
                  ↓ {formatBytes(latest.netin, 0)}/s
                </span>
                <span className="text-muted">·</span>
                <span className="text-accent">
                  ↑ {formatBytes(latest.netout, 0)}/s
                </span>
              </>
            }
          />
          <KpiCard
            label={t('nodeDetail.kpiDiskIo')}
            value={`${formatBytes(
              (latest.diskread ?? 0) + (latest.diskwrite ?? 0),
              0,
            )}/s`}
            hint={
              <>
                <span>
                  {t('nodeDetail.read', { v: `${formatBytes(latest.diskread, 0)}/s` })}
                </span>
                <span className="text-muted">·</span>
                <span>
                  {t('nodeDetail.write', {
                    v: `${formatBytes(latest.diskwrite, 0)}/s`,
                  })}
                </span>
              </>
            }
          />
        </div>
      ) : null}

      <div className="monitor-grid">
        <Card>
          <CpuChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        <Card>
          <MemoryChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        <Card>
          <NetworkChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        <Card>
          <DiskIoChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>

        {/* ---- 诊断曲线：定位瓶颈用 ---- */}
        <Card>
          <IowaitChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        <Card>
          <LoadChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        <Card>
          <FilesystemChart
            points={points}
            loading={rrdQuery.isLoading}
            error={notImpl ? undefined : rrdQuery.error}
          />
        </Card>
        {/* Swap 与 PSI 并非每台机器都有数据：
             未启用 swap 时 swaptotal 恒为 0，实测 PVE 8.4 的 rrddata
             也不返回 PSI 字段 —— 没有数据就整块不渲染，免得留下空卡片。 */}
        {hasSwap ? (
          <Card>
            <SwapChart
              points={points}
              loading={rrdQuery.isLoading}
              error={notImpl ? undefined : rrdQuery.error}
            />
          </Card>
        ) : null}
        {hasPressure ? (
          <Card>
            <PressureChart
              points={points}
              loading={rrdQuery.isLoading}
              error={notImpl ? undefined : rrdQuery.error}
            />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
