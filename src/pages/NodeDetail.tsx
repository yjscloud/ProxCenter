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
} from '../utils/status';
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

const TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'overview', label: '概览', icon: <IconServer size={15} /> },
  { key: 'network', label: '网络', icon: <IconNetwork size={15} /> },
  { key: 'storage', label: '存储', icon: <IconStorage size={15} /> },
  { key: 'tasks', label: '任务', icon: <IconTasks size={15} /> },
  { key: 'monitor', label: '监控', icon: <IconMonitor size={15} /> },
];

/** PVE 的 loadavg 可能是字符串数组，统一转成保留两位小数的字符串。 */
function formatLoad(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

export function NodeDetail() {
  const { node = '' } = useParams<{ node: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  /* 多台 PVE 合并展示时，不同主机可能出现同名节点；连接标识从列表页带过来，
     否则详情页会落到「当前连接」那台，看到别人家的监控数据。 */
  const conn = searchParams.get('conn') ?? '';

  const tabParam = (searchParams.get('tab') as TabKey | null) ?? 'overview';
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'overview';

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
        <ErrorState title="无效的节点地址" onRetry={() => navigate('/nodes')} />
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
            items={[{ label: '节点', to: '/nodes' }, { label: node }]}
          />
          <div className="detail-title-row">
            <span className="detail-name">{node}</span>
            {connName ? (
              <Badge variant="info" size="sm" title="当前查看的数据来自此 PVE 主机">
                <IconServer size={12} />
                {connName}
              </Badge>
            ) : null}
            <Badge
              variant={nodeStatusMeta(nodeInfo?.status).variant}
              dot
              pulse={nodeStatusMeta(nodeInfo?.status).pulse}
            >
              {nodeStatusMeta(nodeInfo?.status).label}
            </Badge>
            {status?.pveversion ? (
              <Badge variant="neutral" size="sm">
                {status.pveversion}
              </Badge>
            ) : null}
            {nodeInfo?.level ? (
              <Badge variant="warning" size="sm">
                维护级别 {nodeInfo.level}
              </Badge>
            ) : null}
          </div>
          <div className="detail-meta">
            <span className="detail-meta-item">
              <IconCpu size={13} />
              {status?.cpus ?? nodeInfo?.maxcpu ?? '—'} 核
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
              已运行 {formatUptime(status?.uptime ?? nodeInfo?.uptime)}
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
            刷新
          </Button>
        </div>
      </div>

      {/* ---- Tabs ---- */}
      <div className="tabs" role="tablist" aria-label="节点详情分区">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* 多台 PVE 同时在线时，URL 没带 conn 参数就会落到「当前连接」那台，
         同名节点（两台都叫 "pve"）会拿错数据 —— 显式提示并给出回到列表的入口。 */}
      {!conn && (connectionsQuery.data?.length ?? 0) > 1 ? (
        <Notice
          tone="warning"
          title="无法确认节点来自哪台 PVE"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/nodes')}
            >
              回到节点列表
            </Button>
          }
        >
          当前面板已配置多台 PVE，但本页面 URL 未携带
          <span className="mono">?conn=&lt;id&gt;</span> 参数，
          数据会落到「当前连接」主机。请从「计算 - 节点」列表点击进入，
          每个节点卡片会带上所属主机的参数。
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
          <CardHeader title="资源使用" icon={<IconMonitor size={16} />} />
          <div className="flex flex-col gap-16">
            <ProgressBar
              label={`CPU（${status?.cpus ?? nodeInfo?.maxcpu ?? 0} 核）`}
              value={cpuPct}
              showValue
              height={8}
              color={usageColor(cpuPct)}
            />
            <ProgressBar
              label={`内存（${formatBytes(memUsed)} / ${formatBytes(memTotal)}）`}
              value={memPct}
              showValue
              height={8}
              color={usageColor(memPct)}
            />
            <ProgressBar
              label={`根文件系统（${formatBytes(rootUsed)} / ${formatBytes(rootTotal)}）`}
              value={rootPct}
              showValue
              height={8}
              color={usageColor(rootPct)}
            />
            {swapTotal > 0 ? (
              <ProgressBar
                label={`Swap（${formatBytes(swapUsed)} / ${formatBytes(swapTotal)}）`}
                value={swapPct}
                showValue
                height={8}
                color={usageColor(swapPct)}
              />
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="负载与内核" icon={<IconCpu size={16} />} />
          {status?.loadavg && status.loadavg.length >= 3 ? (
            <InfoGrid>
              <InfoRow label="1 分钟负载" value={formatLoad(status.loadavg[0])} mono />
              <InfoRow label="5 分钟负载" value={formatLoad(status.loadavg[1])} mono />
              <InfoRow label="15 分钟负载" value={formatLoad(status.loadavg[2])} mono />
            </InfoGrid>
          ) : (
            <Notice tone="info">负载数据需要后端 /nodes/{node}/status 接口支持。</Notice>
          )}
        </Card>
      </div>

      <div className="detail-column">
        <Card>
          <CardHeader title="节点信息" icon={<IconServer size={16} />} />
          <InfoGrid>
            <InfoRow label="节点名称" value={node} mono />
            <InfoRow
              label="状态"
              value={
                <Badge
                  variant={nodeStatusMeta(nodeInfo?.status).variant}
                  dot
                  size="sm"
                >
                  {nodeStatusMeta(nodeInfo?.status).label}
                </Badge>
              }
            />
            <InfoRow label="CPU 核心" value={status?.cpus ?? nodeInfo?.maxcpu ?? '—'} mono />
            <InfoRow
              label="总内存"
              value={formatBytes(memTotal)}
              mono
            />
            <InfoRow label="根分区" value={formatBytes(rootTotal)} mono />
            <InfoRow
              label="运行时长"
              value={formatUptimeShort(status?.uptime ?? nodeInfo?.uptime)}
              mono
            />
            {status?.pveversion ? (
              <InfoRow label="PVE 版本" value={status.pveversion} mono />
            ) : null}
            {status?.kernel ? (
              <InfoRow label="内核版本" value={status.kernel} mono />
            ) : null}
            {nodeInfo?.ssl_fingerprint ? (
              <InfoRow
                label="SSL 指纹"
                value={
                  <span className="truncate mono fs-xs" title={nodeInfo.ssl_fingerprint}>
                    {nodeInfo.ssl_fingerprint}
                  </span>
                }
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
            title: `应用网卡配置 ${iface}`,
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
      header: '接口名',
      render: (i) => (
        <div className="flex items-center gap-8">
          <span className="mono fw-500">{i.iface}</span>
          {pending.has(i.iface) ? (
            <Badge variant="warning" size="sm" dot>
              待应用
            </Badge>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (i) => i.iface,
      width: 160,
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
      sortable: true,
      sortValue: (i) => i.type,
    },
    {
      key: 'active',
      header: '激活',
      width: 90,
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
      sortable: true,
      sortValue: (i) => (i.active ? 1 : 0),
    },
    {
      key: 'address',
      header: '地址 / CIDR',
      render: (i) => (
        <span className="mono fs-sm">
          {i.address || i.cidr ? (
            <>
              {i.address ?? '—'}
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
      width: 160,
    },
    {
      key: 'actions',
      header: '操作',
      width: 120,
      align: 'right',
      render: (i) => (
        <span className="row-actions">
          <IconButton
            label={`编辑 ${i.iface}`}
            onClick={() => setEditing(i)}
            disabled={!canManageNet || busy}
          >
            <IconEdit size={15} />
          </IconButton>
          <IconButton
            label={`应用 ${i.iface} 配置`}
            variant="primary"
            onClick={async () => {
              setBusy(true);
              try {
                await runner.run(nodesApi.reloadNetwork(node, i.iface, conn), {
                  title: `应用网卡配置 ${i.iface}`,
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
            label={`删除 ${i.iface}`}
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
          <Notice tone="info" title="只读模式">
            当前账号对宿主机网络只有查看权限。新增、修改、删除网卡以及应用配置变更需要管理员权限。
          </Notice>
        </div>
      ) : null}

      {/* 待应用提示 */}
      {pending.size > 0 ? (
        <div className="mb-16">
          <Notice
            tone="warning"
            title={`有 ${pending.size} 个网卡配置尚未生效`}
            action={
              canManageNet ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void applyChanges()}
                  loading={busy}
                >
                  应用配置
                </Button>
              ) : undefined
            }
          >
            修改网络配置后需要重新加载网卡才会生效。注意：错误的网络配置可能导致节点失联，请在具备带外管理（IPMI/iKVM）的前提下操作。
          </Notice>
        </div>
      ) : null}

      <Card padded={false}>
        <div
          style={{
            padding: '16px 18px',
            borderBottom: '1px solid var(--border-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div className="flex items-center gap-8">
            <IconNetwork size={16} />
            <span className="fw-600">网络接口</span>
            <Badge variant="neutral" size="sm">
              {ifaces.length}
            </Badge>
          </div>
          <div className="flex items-center gap-8">
            <IconButton
              label="刷新网卡列表"
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
              新增网卡
            </Button>
          </div>
        </div>

        {notImpl ? (
          <div style={{ padding: 16 }}>
            <Notice tone="info" title="该功能需要后端支持">
              /nodes/{node}/network 接口尚未实现，暂时无法管理网络。
            </Notice>
          </div>
        ) : (
          <Table<NetworkInterface>
            columns={columns}
            rows={ifaces}
            rowKey={(i) => i.iface}
            loading={netQuery.isLoading}
            caption={`节点 ${node} 的网络接口列表`}
            emptyTitle="暂无网络接口"
            emptyDescription="该节点没有检测到网络接口。"
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
            '配置已保存',
            '请点击「应用配置」使变更生效（可能导致短暂网络中断）',
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
                title: `删除网卡 ${deleteTarget.iface}`,
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
        title="删除网络接口"
        danger
        confirmText="删除"
        loading={busy}
        message={
          <>
            即将删除接口 <strong>{deleteTarget?.iface}</strong>（
            {netTypeLabel(deleteTarget?.type)}）。若该网桥仍被虚拟机使用，删除后这些虚拟机将失去网络。
          </>
        }
      />
    </>
  );
}

/* ---------------------------------------------------------------------------
   网卡表单
   --------------------------------------------------------------------------- */

const NET_TYPE_OPTIONS = [
  { label: 'Linux 网桥 (bridge)', value: 'bridge' },
  { label: '物理网卡 (eth)', value: 'eth' },
  { label: '网卡绑定 (bond)', value: 'bond' },
  { label: 'VLAN', value: 'vlan' },
  { label: 'OVS 网桥 (OVSBridge)', value: 'OVSBridge' },
  { label: 'OVS 绑定 (OVSBond)', value: 'OVSBond' },
  { label: 'OVS 内部端口 (OVSIntPort)', value: 'OVSIntPort' },
];

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
  const runner = useTaskRunner();
  const toast = useToast();

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
    if (!form.iface.trim()) e.iface = '请输入接口名称';
    else if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(form.iface)) {
      e.iface = '接口名需以字母开头，仅含字母数字与 . _ -';
    }
    if (form.gateway && !/^\d{1,3}(\.\d{1,3}){3}$/.test(form.gateway)) {
      e.gateway = '网关格式不正确，应形如 192.168.1.1';
    }
    if (form.cidr && !/^\d{1,3}(\.\d{1,3}){3}$/.test(form.cidr)) {
      e.cidr = '网络地址格式不正确，应形如 192.168.1.0';
    }
    if (form.type === 'bridge' && form.bridgePorts.length === 0 && !editing) {
      // 允许空（无端口网桥也是合法的）
    }
    if (form.type === 'vlan' && !form.vlanId) {
      e.vlanId = 'VLAN 接口必须指定 VLAN ID';
    }
    if (form.type === 'vlan' && !form.vlanRawDevice) {
      e.vlanRawDevice = '请选择承载 VLAN 的物理网卡';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) {
      toast.warning('请检查表单', '有字段未通过校验');
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
        title: editing ? `修改网卡 ${editing.iface}` : `新增网卡 ${payload.iface}`,
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
      title={editing ? `编辑网络接口 · ${editing.iface}` : '新增网络接口'}
      description={`节点 ${node} · 保存后需要「应用配置」才会生效`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {editing ? '保存修改' : '创建接口'}
          </Button>
        </>
      }
    >
      <div className="form-grid-2">
        <Input
          label="接口名称"
          required
          value={form.iface}
          onChange={(e) => set('iface', e.target.value)}
          placeholder="如 vmbr1、eth1"
          error={errors.iface}
          disabled={Boolean(editing)}
          hint={editing ? '接口名不可修改' : '创建后不可改名'}
          mono
        />
        <Select
          label="接口类型"
          required
          value={form.type}
          onChange={(e) => set('type', e.target.value)}
          options={NET_TYPE_OPTIONS}
          disabled={Boolean(editing)}
          hint={editing ? '类型不可修改' : '决定该接口的工作模式'}
        />
      </div>

      {/* --- 桥接端口 --- */}
      {isBridge ? (
        <div className="mt-16">
          <Field
            label="桥接端口"
            hint="选择要桥接进该网桥的物理网卡或绑定接口，可多选"
          >
            {physicalIfaces.length === 0 ? (
              <Notice tone="info">
                没有检测到可作为端口的物理网卡。若需要，可先创建 bond 或直接使用已有接口名。
              </Notice>
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
                          {netTypeLabel(p.type)}
                          {p.active ? '' : ' · 未激活'}
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
              已选端口：<span className="mono">{form.bridgePorts.join(' ')}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* --- Bond --- */}
      {isBond ? (
        <>
          <div className="mt-16">
            <Field label="从属网卡" hint="选择组成该绑定接口的物理网卡，至少两块">
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
              label="绑定模式"
              value={form.bondMode}
              onChange={(e) => set('bondMode', e.target.value)}
              options={[
                { label: 'balance-rr（轮询）', value: 'balance-rr' },
                { label: 'active-backup（主备）', value: 'active-backup' },
                { label: 'balance-xor', value: 'balance-xor' },
                { label: '802.3ad（LACP）', value: '802.3ad' },
                { label: 'balance-tlb', value: 'balance-tlb' },
                { label: 'balance-alb', value: 'balance-alb' },
              ]}
            />
          </div>
        </>
      ) : null}

      {/* --- VLAN --- */}
      {form.type === 'vlan' ? (
        <div className="form-grid-2 mt-16">
          <Select
            label="承载网卡"
            required
            value={form.vlanRawDevice}
            onChange={(e) => set('vlanRawDevice', e.target.value)}
            options={[
              { label: '请选择物理网卡', value: '' },
              ...allIfaces
                .filter((i) => isPhysicalType(i.type) || isBridgeType(i.type))
                .map((i) => ({ label: i.iface, value: i.iface })),
            ]}
            error={errors.vlanRawDevice}
          />
          <Input
            label="VLAN ID"
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
      <div className="mt-24 wizard-section-title">IP 配置</div>
      <div className="form-grid-2">
        <Input
          label="IP 地址"
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          placeholder="如 192.168.1.10"
          mono
          hint="留空表示不配置 IPv4 地址"
        />
        <Input
          label="子网掩码 / CIDR"
          value={form.cidr}
          onChange={(e) => set('cidr', e.target.value)}
          placeholder="如 24 或 192.168.1.0"
          mono
          error={errors.cidr}
          hint="可填前缀长度（24）或网络地址"
        />
        <Input
          label="网关"
          value={form.gateway}
          onChange={(e) => set('gateway', e.target.value)}
          placeholder="如 192.168.1.1"
          mono
          error={errors.gateway}
        />
        <Input
          label="MTU"
          type="number"
          min={576}
          max={9000}
          value={form.mtu}
          onChange={(e) => set('mtu', e.target.value)}
          placeholder="留空使用默认 1500"
          mono
        />
      </div>

      <div className="mt-16">
        <Textarea
          label="备注"
          rows={2}
          value={form.comments}
          onChange={(e) => set('comments', e.target.value)}
          placeholder="记录该接口的用途，例如「生产网络上行」"
        />
      </div>

      <div className="mt-16">
        <Switch
          checked={form.autostart}
          onChange={(v) => set('autostart', v)}
          label="开机自动启用"
          hint="节点启动时自动激活该接口"
        />
      </div>

      <div className="mt-16">
        <Notice tone="warning" title="操作风险提示">
          修改承载管理网络的接口（通常是 <code>vmbr0</code>）后，需要点击「应用配置」才会生效，
          此过程可能造成节点网络短暂中断。请确保具备 IPMI / iKVM
          等带外管理手段再操作。
        </Notice>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   存储 Tab
   ========================================================================== */

function NodeStorageTab({ node, conn }: { node: string; conn: string }) {
  const navigate = useNavigate();

  const storagesQuery = useQuery({
    queryKey: ['storages', conn, node],
    queryFn: () => storagesApi.list(node, conn),
    staleTime: 30_000,
  });

  const columns: Array<Column<Storage>> = [
    {
      key: 'storage',
      header: '存储名称',
      render: (s) => <span className="fw-500">{s.storage}</span>,
      sortable: true,
      sortValue: (s) => s.storage,
    },
    {
      key: 'type',
      header: '类型',
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
      header: '内容',
      render: (s) => <span className="fs-sm">{contentLabel(s.content)}</span>,
    },
    {
      key: 'active',
      header: '状态',
      width: 100,
      render: (s) => {
        const meta = storageStatusMeta(s.active);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'shared',
      header: '共享',
      width: 80,
      align: 'center',
      render: (s) => (
        <Badge variant={s.shared ? 'info' : 'neutral'} size="sm">
          {s.shared ? '是' : '否'}
        </Badge>
      ),
    },
    {
      key: 'usage',
      header: '使用率',
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
          浏览
        </Button>
      ),
    },
  ];

  if (isNotImplemented(storagesQuery.error)) {
    return (
      <Notice tone="info" title="该功能需要后端支持">
        /storages 接口尚未实现。
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
        caption={`节点 ${node} 的存储列表`}
        emptyTitle="暂无存储"
        emptyDescription="该节点没有配置任何存储。"
        className="table-flush"
      />
    </Card>
  );
}

/* ==========================================================================
   任务 Tab
   ========================================================================== */

function NodeTasksTab({ node }: { node: string }) {
  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', node, 50],
    queryFn: () => clusterApi.tasks({ node, limit: 50 }),
    refetchInterval: 10_000,
    retry: false,
  });

  const columns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: '类型',
      render: (t) => <span className="mono fs-sm">{t.type}</span>,
      sortable: true,
      sortValue: (t) => t.type,
    },
    {
      key: 'id',
      header: '对象',
      render: (t) => (
        <span className="mono fs-sm text-secondary">{t.id ?? '—'}</span>
      ),
      width: 110,
    },
    {
      key: 'status',
      header: '状态',
      render: (t) => {
        const meta = taskStatusMeta(t.status, t.exitstatus);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      width: 110,
      sortable: true,
      sortValue: (t) => t.exitstatus ?? t.status,
    },
    {
      key: 'user',
      header: '用户',
      render: (t) => <span className="fs-sm text-secondary">{t.user ?? '—'}</span>,
      width: 150,
    },
    {
      key: 'start',
      header: '开始时间',
      render: (t) => <span className="fs-sm mono">{formatDateTime(t.starttime)}</span>,
      width: 160,
      sortable: true,
      sortValue: (t) => t.starttime ?? 0,
    },
    {
      key: 'duration',
      header: '耗时',
      align: 'right',
      width: 90,
      render: (t) => (
        <span className="mono fs-sm text-secondary">
          {t.starttime && t.endtime
            ? formatUptimeShort(t.endtime - t.starttime)
            : t.status === 'running'
              ? '进行中'
              : '—'}
        </span>
      ),
    },
  ];

  if (isNotImplemented(tasksQuery.error)) {
    return (
      <Notice tone="info" title="该功能需要后端支持">
        /cluster/tasks 接口尚未实现。
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
        caption={`节点 ${node} 的任务记录`}
        emptyTitle="暂无任务"
        emptyDescription="该节点上没有记录到任务。"
        className="table-flush"
      />
    </Card>
  );
}

/* ==========================================================================
   监控 Tab
   ========================================================================== */

function NodeMonitorTab({ node, conn }: { node: string; conn: string }) {
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
          实时更新 · 每 5 秒刷新
        </span>
        <SegmentedControl<RrdTimeframe>
          value={timeframe}
          onChange={setTimeframe}
          ariaLabel="监控时间范围"
          options={[
            { label: '1 小时', value: 'hour' },
            { label: '1 天', value: 'day' },
            { label: '1 周', value: 'week' },
            { label: '1 月', value: 'month' },
          ]}
        />
      </div>

      {notImpl ? (
        <Notice tone="info" title="监控接口暂不可用">
          后端尚未实现 /nodes/{node}/rrddata 接口。
        </Notice>
      ) : null}

      {/* 实时读数：进入监控页第一眼就能看到当前负载 */}
      {latest ? (
        <div className="grid grid-4">
          <KpiCard
            label="CPU 使用率"
            value={`${latestCpu.toFixed(1)}%`}
            tone={usageTone(latestCpu)}
            progress={latestCpu}
            progressColor={usageColor(latestCpu)}
            hint={<span className="text-secondary">最近一次采样</span>}
          />
          <KpiCard
            label="内存已用"
            value={formatBytes(memUsed, 0)}
            hint={<span className="mono">/ {formatBytes(memTotal, 0)}</span>}
            tone={usageTone(latestMem)}
            progress={latestMem}
            progressColor={usageColor(latestMem)}
          />
          <KpiCard
            label="网络吞吐"
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
            label="磁盘 I/O"
            value={`${formatBytes(
              (latest.diskread ?? 0) + (latest.diskwrite ?? 0),
              0,
            )}/s`}
            hint={
              <>
                <span>读 {formatBytes(latest.diskread, 0)}/s</span>
                <span className="text-muted">·</span>
                <span>写 {formatBytes(latest.diskwrite, 0)}/s</span>
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
