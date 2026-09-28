/* ==========================================================================
   ProxCenter — LXC 容器详情
   ==========================================================================

与 ``VmDetail`` 平行的一页。刻意不把容器塞进虚拟机详情页：

* 两者的**硬件模型完全不同**（rootfs / mpN 对 scsiN / netN 的语义都不同），
  合成一页会让「磁盘」这类区块一半是条件渲染；
* 容器**没有 cloud-init**，也就没有那块配置区；
* 但容器的 ``disk`` / ``maxdisk`` 是**真实用量**（QEMU 恒为 0），
  所以这里的磁盘 KPI 可以直接算百分比，不用像虚拟机那样进客户机跑 df。

归属、权限、任务等待、控制台这些机制两边完全一致，直接复用。
*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lxcApi, storagesApi } from '../api/endpoints';
import { guestPower } from '../api/guests';
import { errorMessage } from '../api/client';
import { Breadcrumb } from '../components/Topbar';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, InfoGrid, InfoRow, KpiCard } from '../components/ui/Card';
import { Badge, TagList } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
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
import { Table, type Column } from '../components/ui/Table';
import { CpuChart, MemoryChart, NetworkChart, DiskIoChart } from '../components/MetricChart';
import { ConsoleTab } from '../components/ConsoleTab';
import {
  IconRefresh,
  IconPlay,
  IconStop,
  IconRestart,
  IconTrash,
  IconPlus,
  IconCpu,
  IconMemory,
  IconStorage,
  IconNetwork,
  IconSnapshot,
  IconLayers,
  IconEdit,
} from '../components/Icons';
import { formatBytes, formatDateTime, formatUptimeShort, parseTags, toPercent } from '../utils/format';
import { isRunning, isTransient, vmStatusMeta } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { RrdPoint, RrdTimeframe } from '../api/types';
import type { LxcMountConfig, LxcNetworkConfig } from '../api/types';

type TabKey = 'overview' | 'network' | 'storage' | 'snapshot' | 'console';

const TABS: Array<{ label: string; value: TabKey }> = [
  { label: '概览', value: 'overview' },
  { label: '网络', value: 'network' },
  { label: '存储', value: 'storage' },
  { label: '快照', value: 'snapshot' },
  { label: '控制台', value: 'console' },
];

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

/** PVE 的字节数可能是 number 也可能是字符串 */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function LxcDetail() {
  const { node = '', vmid = '' } = useParams<{ node: string; vmid: string }>();
  const ctId = Number(vmid);
  const navigate = useNavigate();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();

  const [tab, setTab] = useState<TabKey>('overview');
  const [timeframe, setTimeframe] = useState<RrdTimeframe>('hour');
  const [pending, setPending] = useState(false);

  const canPower = hasPermission('vm.power');
  const canConfig = hasPermission('vm.config');
  const canDelete = hasPermission('vm.delete');
  const canSnapshot = hasPermission('vm.snapshot');

  const queryKey = useMemo(() => ['lxc', node, ctId] as const, [node, ctId]);

  const ctQuery = useQuery({
    queryKey,
    queryFn: () => lxcApi.detail(node, ctId),
    enabled: Boolean(node) && Number.isFinite(ctId),
    refetchInterval: 10_000,
  });

  const rrdQuery = useQuery<RrdPoint[]>({
    queryKey: ['lxc', node, ctId, 'rrd', timeframe],
    queryFn: () => lxcApi.rrddata(node, ctId, timeframe),
    enabled: tab === 'overview' && Boolean(node) && Number.isFinite(ctId),
    staleTime: 30_000,
    retry: false,
  });

  const snapshotsQuery = useQuery({
    queryKey: ['lxc', node, ctId, 'snapshots'],
    queryFn: () => lxcApi.snapshots(node, ctId),
    enabled: tab === 'snapshot' && Boolean(node) && Number.isFinite(ctId),
    staleTime: 15_000,
    retry: false,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', 'lxc-detail', node],
    queryFn: () => storagesApi.list(node),
    enabled: Boolean(node),
    staleTime: 60_000,
  });

  const ct = ctQuery.data;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['lxc', node, ctId] });
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
    void queryClient.invalidateQueries({ queryKey: ['lxc'] });
  }, [queryClient, node, ctId]);

  /* ---- 电源操作 ---- */
  const doPower = async (action: 'start' | 'stop' | 'shutdown' | 'reboot') => {
    const labels = { start: '启动', stop: '停止', shutdown: '关机', reboot: '重启' };
    setPending(true);
    try {
      await runner.run(guestPower[action]({ node, vmid: ctId, type: 'lxc' }), {
        title: `${labels[action]}容器「${ct?.name ?? ctId}」`,
        node,
        invalidate: [['lxc', node, ctId], ['vms'], ['lxc']],
      });
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 删除 ---- */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const confirmDelete = async () => {
    setPending(true);
    try {
      await runner.run(lxcApi.delete(node, ctId, true), {
        title: `删除容器「${ct?.name ?? ctId}」`,
        node,
        invalidate: [['vms'], ['lxc'], ['cluster']],
        destructive: true,
      });
      toast.destructive('容器已删除', '该容器及其磁盘卷已从集群中移除');
      navigate('/lxc');
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
      setDeleteOpen(false);
    }
  };

  /* ---- 改配置 ---- */
  const [configOpen, setConfigOpen] = useState(false);
  const [cfgForm, setCfgForm] = useState({
    hostname: '',
    memory: 0,
    swap: 0,
    cores: 0,
    onboot: false,
    protection: false,
    description: '',
  });

  useEffect(() => {
    if (!configOpen || !ct) return;
    setCfgForm({
      hostname: ct.hostname ?? ct.name,
      memory: Number(ct.config?.memory ?? 0),
      swap: Number(ct.config?.swap ?? 0),
      cores: Number(ct.config?.cores ?? 0),
      onboot: Number(ct.config?.onboot ?? 0) === 1,
      protection: Number(ct.config?.protection ?? 0) === 1,
      description: ct.description ?? '',
    });
  }, [configOpen, ct]);

  const submitConfig = async () => {
    setPending(true);
    try {
      await runner.run(
        lxcApi.updateConfig(node, ctId, {
          hostname: cfgForm.hostname || undefined,
          memory: cfgForm.memory || undefined,
          swap: cfgForm.swap,
          cores: cfgForm.cores || undefined,
          onboot: cfgForm.onboot ? 1 : 0,
          protection: cfgForm.protection ? 1 : 0,
          description: cfgForm.description,
        }),
        {
          title: `更新容器「${ct?.name ?? ctId}」配置`,
          node,
          invalidate: [['lxc', node, ctId], ['vms']],
        },
      );
      setConfigOpen(false);
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 新增网卡 ---- */
  const [netOpen, setNetOpen] = useState(false);
  const [netForm, setNetForm] = useState({
    bridge: 'vmbr0',
    ip: 'dhcp',
    gateway: '',
    vlanTag: '',
    firewall: false,
  });

  const submitNetwork = async () => {
    setPending(true);
    try {
      await runner.run(
        lxcApi.addNetwork(node, ctId, {
          bridge: netForm.bridge,
          ip: netForm.ip || 'dhcp',
          gateway: netForm.gateway || undefined,
          vlan_tag: netForm.vlanTag ? Number(netForm.vlanTag) : undefined,
          firewall: netForm.firewall,
        }),
        {
          title: '新增网卡',
          node,
          invalidate: [['lxc', node, ctId]],
        },
      );
      setNetOpen(false);
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 新增挂载点 ---- */
  const [mountOpen, setMountOpen] = useState(false);
  const [mountForm, setMountForm] = useState({
    storage: '',
    size: 8,
    mp: '/data',
    backup: false,
  });

  const mountStorageOptions = useMemo(
    () =>
      (storagesQuery.data ?? [])
        .filter((s) => (s.content ?? '').split(',').map((c) => c.trim()).includes('rootdir'))
        .map((s) => ({ label: `${s.storage}（${s.type}）`, value: s.storage })),
    [storagesQuery.data],
  );

  const submitMount = async () => {
    if (!mountForm.mp.trim()) {
      toast.warning('请填写挂载路径', '例如 /data');
      return;
    }
    setPending(true);
    try {
      await runner.run(
        lxcApi.addMount(node, ctId, {
          storage: mountForm.storage,
          size: mountForm.size,
          mp: mountForm.mp.trim(),
          backup: mountForm.backup,
        }),
        { title: '新增挂载点', node, invalidate: [['lxc', node, ctId]] },
      );
      setMountOpen(false);
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 扩容 ---- */
  const [resizeTarget, setResizeTarget] = useState<string | null>(null);
  const [resizeSize, setResizeSize] = useState('+8G');
  const submitResize = async () => {
    const disk = resizeTarget;
    if (!disk) return;
    setPending(true);
    try {
      await runner.run(lxcApi.resize(node, ctId, { disk, size: resizeSize }), {
        title: `扩容 ${disk}`,
        node,
        invalidate: [['lxc', node, ctId]],
      });
      setResizeTarget(null);
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 快照 ---- */
  const [snapOpen, setSnapOpen] = useState(false);
  const [snapName, setSnapName] = useState('');
  const [snapDesc, setSnapDesc] = useState('');
  const submitSnapshot = async () => {
    if (!snapName.trim()) {
      toast.warning('请填写快照名称');
      return;
    }
    setPending(true);
    try {
      await runner.run(
        lxcApi.createSnapshot(node, ctId, {
          name: snapName.trim(),
          description: snapDesc,
        }),
        {
          title: '创建快照',
          node,
          invalidate: [['lxc', node, ctId, 'snapshots'], ['lxc', node, ctId]],
        },
      );
      setSnapOpen(false);
      setSnapName('');
      setSnapDesc('');
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
    }
  };

  /* ---- 移除硬件（网卡 / 挂载点）---- */
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const confirmRemove = async () => {
    const key = removeTarget;
    if (!key) return;
    setPending(true);
    try {
      await runner.run(lxcApi.removeHardware(node, ctId, key), {
        title: `移除 ${key}`,
        node,
        invalidate: [['lxc', node, ctId]],
      });
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
      setRemoveTarget(null);
    }
  };

  /* ---- 快照回滚 / 删除 ---- */
  const [snapAction, setSnapAction] = useState<{
    kind: 'rollback' | 'delete';
    name: string;
  } | null>(null);

  const confirmSnapAction = async () => {
    if (!snapAction) return;
    setPending(true);
    try {
      const promise =
        snapAction.kind === 'rollback'
          ? lxcApi.rollbackSnapshot(node, ctId, snapAction.name)
          : lxcApi.deleteSnapshot(node, ctId, snapAction.name);
      await runner.run(promise, {
        title:
          snapAction.kind === 'rollback'
            ? `回滚到快照「${snapAction.name}」`
            : `删除快照「${snapAction.name}」`,
        node,
        invalidate: [['lxc', node, ctId, 'snapshots'], ['lxc', node, ctId]],
        /* 回滚会丢弃快照之后的全部改动，删除则不可撤销 —— 两者都算不可逆 */
        destructive: true,
      });
    } catch {
      /* toast 已提示 */
    } finally {
      setPending(false);
      setSnapAction(null);
    }
  };

  /* ========================================================= 渲染 ================= */

  if (ctQuery.isLoading) return <DetailSkeleton />;
  if (ctQuery.isError || !ct) {
    return (
      <div className="page">
        <ErrorState
          title="无法加载容器详情"
          message={errorMessage(ctQuery.error)}
          onRetry={() => void ctQuery.refetch()}
        />
      </div>
    );
  }

  const status = vmStatusMeta(ct.status);
  const running = isRunning(ct.status);
  const busy = isTransient(ct.status) || pending || Boolean(ct.lock);

  const memPct = toPercent(toNumber(ct.mem) / Math.max(toNumber(ct.maxmem), 1));
  const cpuPct = toPercent(ct.cpu ?? 0) * Math.max(Number(ct.cpus ?? 1), 1);
  /* 与虚拟机不同：容器的 disk / maxdisk 就是真实用量，可以直接算 */
  const diskPct = toPercent(toNumber(ct.disk) / Math.max(toNumber(ct.maxdisk), 1));

  const networkColumns: Array<Column<LxcNetworkConfig>> = [
    { key: 'interface', header: '接口', width: 110, render: (r) => <code>{r.interface}</code> },
    { key: 'name', header: '容器内', width: 100, render: (r) => r.name ?? '-' },
    { key: 'bridge', header: '网桥', width: 120, render: (r) => r.bridge ?? '-' },
    { key: 'ip', header: 'IPv4', render: (r) => r.ip ?? '-' },
    { key: 'gw', header: '网关', width: 140, render: (r) => r.gw ?? '-' },
    { key: 'ip6', header: 'IPv6', render: (r) => r.ip6 ?? '-' },
    {
      key: 'firewall',
      header: '防火墙',
      width: 90,
      align: 'center',
      render: (r) =>
        r.firewall === '1' ? <Badge variant="success" size="sm">开</Badge> : <span className="text-muted">关</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 90,
      align: 'right',
      render: (r) => (
        <IconButton
          label={`移除 ${r.interface}`}
          variant="ghost"
          disabled={!canConfig || busy}
          onClick={() => setRemoveTarget(r.interface)}
        >
          <IconTrash size={15} />
        </IconButton>
      ),
    },
  ];

  const mountRows: Array<LxcMountConfig & { interface: string }> = [
    { ...ct.rootfs, interface: ct.rootfs.interface || 'rootfs', mp: '/' },
    ...ct.mounts.map((m) => ({ ...m, interface: m.interface ?? '' })),
  ];

  const storageColumns: Array<Column<LxcMountConfig & { interface: string }>> = [
    { key: 'interface', header: '键', width: 100, render: (r) => <code>{r.interface}</code> },
    { key: 'mp', header: '挂载路径', width: 160, render: (r) => r.mp ?? '-' },
    { key: 'storage', header: '存储', width: 130, render: (r) => r.storage ?? '-' },
    { key: 'size', header: '容量', width: 100, render: (r) => r.size || '-' },
    { key: 'volid', header: '卷', render: (r) => <code className="fs-xs">{r.volid || '-'}</code> },
    {
      key: 'actions',
      header: '操作',
      width: 150,
      align: 'right',
      render: (r) => (
        <div className="flex items-center gap-4 justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canConfig || busy}
            onClick={() => {
              setResizeTarget(r.interface);
              setResizeSize('+8G');
            }}
          >
            扩容
          </Button>
          {r.interface !== 'rootfs' ? (
            <IconButton
              label={`移除 ${r.interface}`}
              variant="ghost"
              disabled={!canConfig || busy}
              onClick={() => setRemoveTarget(r.interface)}
            >
              <IconTrash size={15} />
            </IconButton>
          ) : null}
        </div>
      ),
    },
  ];

  const snapshotColumns: Array<Column<Record<string, unknown>>> = [
    { key: 'name', header: '名称', render: (r) => <code>{String(r.name)}</code> },
    { key: 'description', header: '描述', render: (r) => String(r.description ?? '-') },
    {
      key: 'snaptime',
      header: '创建时间',
      width: 180,
      render: (r) =>
        r.snaptime ? new Date(Number(r.snaptime) * 1000).toLocaleString('zh-CN') : '-',
    },
    {
      key: 'actions',
      header: '操作',
      width: 160,
      align: 'right',
      render: (r) => {
        const name = String(r.name);
        if (name === 'current') return <span className="text-muted">当前状态</span>;
        return (
          <div className="flex items-center gap-4 justify-end">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canSnapshot || busy}
              onClick={() => setSnapAction({ kind: 'rollback', name })}
            >
              回滚
            </Button>
            <IconButton
              label={`删除快照 ${name}`}
              variant="ghost"
              disabled={!canSnapshot || busy}
              onClick={() => setSnapAction({ kind: 'delete', name })}
            >
              <IconTrash size={15} />
            </IconButton>
          </div>
        );
      },
    },
  ];

  return (
    <PageShell
      title={
        <div className="flex items-center gap-8">
          <Breadcrumb
            items={[
              { label: '容器', to: '/lxc' },
              { label: ct.name || `CT ${ctId}` },
            ]}
          />
          <Badge variant={status.variant} dot pulse={status.pulse}>
            {status.label}
          </Badge>
          <Badge variant="neutral" size="sm">
            容器 LXC
          </Badge>
          {ct.lock ? <Badge variant="warning" size="sm">锁定：{ct.lock}</Badge> : null}
        </div>
      }
      subtitle={`${node} · CT ${ctId}${ct.ostemplate ? ` · ${ct.ostemplate.split('/').pop()}` : ''}`}
      actions={
        <div className="flex items-center gap-8">
          <IconButton label="刷新" variant="secondary" onClick={invalidate}>
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label="编辑配置"
            variant="secondary"
            disabled={!canConfig || busy}
            onClick={() => setConfigOpen(true)}
          >
            <IconEdit size={16} />
          </IconButton>
          {running ? (
            <>
              <Button
                variant="secondary"
                icon={<IconRestart size={15} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('reboot')}
              >
                重启
              </Button>
              <Button
                variant="secondary"
                icon={<IconStop size={15} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('shutdown')}
              >
                关机
              </Button>
              <Button
                variant="danger"
                icon={<IconStop size={15} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('stop')}
              >
                强制停止
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<IconPlay size={15} />}
              disabled={!canPower || busy}
              onClick={() => void doPower('start')}
            >
              启动
            </Button>
          )}
          <Button
            variant="danger"
            icon={<IconTrash size={15} />}
            disabled={!canDelete || busy}
            onClick={() => setDeleteOpen(true)}
          >
            删除
          </Button>
        </div>
      }
    >
      <div className="mb-16">
        <SegmentedControl<TabKey>
          value={tab}
          onChange={setTab}
          options={TABS}
          ariaLabel="容器详情分区"
        />
      </div>

      {/* ==================== 概览 ==================== */}
      {tab === 'overview' ? (
        <>
          <div className="kpi-grid mb-16">
            <KpiCard
              label="CPU"
              value={`${cpuPct.toFixed(1)}%`}
              hint={`${ct.cpus ?? 1} 核`}
              icon={<IconCpu size={18} />}
              progress={Math.min(100, cpuPct)}
            />
            <KpiCard
              label="内存"
              value={`${memPct.toFixed(0)}%`}
              hint={`${formatBytes(toNumber(ct.mem))} / ${formatBytes(toNumber(ct.maxmem))}`}
              icon={<IconMemory size={18} />}
              progress={memPct}
            />
            <KpiCard
              label="磁盘"
              value={`${diskPct.toFixed(0)}%`}
              hint={`${formatBytes(toNumber(ct.disk))} / ${formatBytes(toNumber(ct.maxdisk))}`}
              icon={<IconStorage size={18} />}
              progress={diskPct}
            />
            <KpiCard
              label="运行时长"
              value={formatUptimeShort(ct.uptime)}
              hint={running ? '运行中' : '已停止'}
              icon={<IconLayers size={18} />}
            />
          </div>

          <div className="grid grid-2 mb-16">
            <Card>
              <CardHeader title="基本信息" icon={<IconLayers size={16} />} />
              <InfoGrid>
                {/* 容器没有独立的 name 字段，主机名就是它的名字。
                    编辑入口直接开「编辑配置」弹窗（第一项就是主机名），
                    不另做一个只改一行的弹窗 —— 两处表单会各自漂移。 */}
                <InfoRow
                  label="主机名"
                  value={
                    <span className="info-editable">
                      <span className="truncate">{ct.hostname || ct.name}</span>
                      {canConfig && !busy ? (
                        <IconButton
                          label="修改主机名"
                          onClick={() => setConfigOpen(true)}
                        >
                          <IconEdit size={13} />
                        </IconButton>
                      ) : null}
                    </span>
                  }
                />
                <InfoRow label="VMID" value={String(ctId)} />
                <InfoRow label="节点" value={node} />
                <InfoRow label="类型" value={ct.unprivileged ? '非特权容器' : '特权容器'} />
                <InfoRow label="状态" value={status.label} />
                <InfoRow label="运行时长" value={formatUptimeShort(ct.uptime)} />
                <InfoRow
                  label="创建时间"
                  /* 容器实测都没有 meta，通常是「—」；留着是为了以后 PVE 补上时
                     自动显示，不必再改一次界面 */
                  title="PVE 记录的创建时间（config 的 meta.ctime）；容器普遍没有这个记录"
                  value={ct.created ? formatDateTime(ct.created) : '—'}
                />
                <InfoRow label="CPU 核心" value={String(ct.cpus ?? '-')} />
                <InfoRow label="内存" value={`${formatBytes(toNumber(ct.maxmem))}`} />
                <InfoRow label="Swap" value={`${formatBytes(toNumber(ct.maxswap))}`} />
                <InfoRow
                  label="特性"
                  value={ct.features || '无'}
                />
                <InfoRow label="系统模板" value={ct.ostemplate || '-'} />
                <InfoRow label="SSH 公钥" value={ct.ssh_keys_set ? '已注入' : '未设置'} />
                <InfoRow label="DNS" value={ct.nameserver || '默认'} />
              </InfoGrid>
              {ct.tags ? (
                <div className="mt-12">
                  <TagList tags={parseTags(ct.tags)} />
                </div>
              ) : null}
              {ct.description ? (
                <p className="mt-12 fs-sm text-secondary">{ct.description}</p>
              ) : null}
            </Card>

            <Card>
              <CardHeader
                title="监控"
                icon={<IconNetwork size={16} />}
                actions={
                  <SegmentedControl<RrdTimeframe>
                    value={timeframe}
                    onChange={setTimeframe}
                    options={[
                      { label: '小时', value: 'hour' },
                      { label: '天', value: 'day' },
                      { label: '周', value: 'week' },
                      { label: '月', value: 'month' },
                    ]}
                  />
                }
              />
              <div className="chart-stack">
                <CpuChart
                  points={rrdQuery.data ?? []}
                  loading={rrdQuery.isLoading}
                  error={rrdQuery.error}
                />
                <MemoryChart
                  points={rrdQuery.data ?? []}
                  loading={rrdQuery.isLoading}
                  error={rrdQuery.error}
                />
                <NetworkChart
                  points={rrdQuery.data ?? []}
                  loading={rrdQuery.isLoading}
                  error={rrdQuery.error}
                />
                <DiskIoChart
                  points={rrdQuery.data ?? []}
                  loading={rrdQuery.isLoading}
                  error={rrdQuery.error}
                />
              </div>
            </Card>
          </div>
        </>
      ) : null}

      {/* ==================== 网络 ==================== */}
      {tab === 'network' ? (
        <Card>
          <CardHeader
            title="网卡"
            icon={<IconNetwork size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canConfig || busy}
                onClick={() => setNetOpen(true)}
              >
                新增网卡
              </Button>
            }
          />
          <Notice tone="info" title="容器的 IP 写在网卡配置里">
            容器没有 cloud-init，改 IP 需要改网卡配置后重启容器才生效。
          </Notice>
          <Table
            columns={networkColumns}
            rows={ct.networks}
            rowKey={(r) => r.interface}
            caption="容器网卡列表"
            emptyTitle="没有网卡"
            emptyDescription="容器至少需要一张网卡才能联网"
          />
        </Card>
      ) : null}

      {/* ==================== 存储 ==================== */}
      {tab === 'storage' ? (
        <Card>
          <CardHeader
            title="存储"
            icon={<IconStorage size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canConfig || busy}
                onClick={() => setMountOpen(true)}
              >
                新增挂载点
              </Button>
            }
          />
          <Notice tone="warning" title="扩容不可逆">
            容器只支持**增加**容量，缩容会被 PVE 直接拒绝。
          </Notice>
          <Table
            columns={storageColumns}
            rows={mountRows}
            rowKey={(r) => r.interface}
            caption="容器存储列表"
            emptyTitle="没有存储卷"
          />
        </Card>
      ) : null}

      {/* ==================== 快照 ==================== */}
      {tab === 'snapshot' ? (
        <Card>
          <CardHeader
            title="快照"
            icon={<IconSnapshot size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canSnapshot || busy}
                onClick={() => setSnapOpen(true)}
              >
                创建快照
              </Button>
            }
          />
          <Notice tone="info" title="容器快照不含内存状态">
            与虚拟机不同，容器快照只保存磁盘与配置，不能保存运行时内存。
          </Notice>
          <Table
            columns={snapshotColumns}
            rows={(snapshotsQuery.data ?? []) as unknown as Array<Record<string, unknown>>}
            rowKey={(r) => String(r.name)}
            loading={snapshotsQuery.isLoading}
            caption="容器快照列表"
            emptyTitle="还没有快照"
          />
        </Card>
      ) : null}

      {/* ==================== 控制台 ==================== */}
      {tab === 'console' ? (
        <ConsoleTab
          node={node}
          vmid={ctId}
          vmName={ct.name}
          running={running}
          guestType="lxc"
        />
      ) : null}

      {/* ---- 编辑配置 ---- */}
      <Modal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title="编辑容器配置"
        description="CPU / 内存等改动在容器重启后完全生效"
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setConfigOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitConfig()}>
              保存
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label="主机名"
            value={cfgForm.hostname}
            onChange={(e) => setCfgForm({ ...cfgForm, hostname: e.target.value })}
            hint="容器的名称：面板列表与 PVE 里显示的都是它"
          />
          <Input
            label="内存（MB）"
            type="number"
            min={16}
            step={128}
            value={cfgForm.memory}
            onChange={(e) =>
              setCfgForm({ ...cfgForm, memory: Number(e.target.value) || 0 })
            }
          />
          <Input
            label="Swap（MB）"
            type="number"
            min={0}
            step={128}
            value={cfgForm.swap}
            onChange={(e) => setCfgForm({ ...cfgForm, swap: Number(e.target.value) || 0 })}
          />
          <Input
            label="CPU 核心"
            type="number"
            min={1}
            value={cfgForm.cores}
            onChange={(e) => setCfgForm({ ...cfgForm, cores: Number(e.target.value) || 0 })}
          />
        </div>
        <Switch
          checked={cfgForm.onboot}
          onChange={(v) => setCfgForm({ ...cfgForm, onboot: v })}
          label="开机自启"
        />
        <Switch
          checked={cfgForm.protection}
          onChange={(v) => setCfgForm({ ...cfgForm, protection: v })}
          label="保护模式"
          hint="开启后禁止删除该容器"
        />
        <Field label="描述">
          <Textarea
            rows={3}
            value={cfgForm.description}
            onChange={(e) =>
              setCfgForm({ ...cfgForm, description: e.target.value })
            }
          />
        </Field>
      </Modal>

      {/* ---- 新增网卡 ---- */}
      <Modal
        open={netOpen}
        onClose={() => setNetOpen(false)}
        title="新增网卡"
        description="键名（netN）与容器内接口名（ethN）由后端自动分配"
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setNetOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitNetwork()}>
              添加
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label="网桥"
            value={netForm.bridge}
            onChange={(e) => setNetForm({ ...netForm, bridge: e.target.value })}
            hint="常见为 vmbr0"
          />
          <Input
            label="IPv4"
            value={netForm.ip}
            onChange={(e) => setNetForm({ ...netForm, ip: e.target.value })}
            hint="dhcp 或 192.168.1.50/24"
          />
          <Input
            label="网关"
            value={netForm.gateway}
            onChange={(e) => setNetForm({ ...netForm, gateway: e.target.value })}
          />
          <Input
            label="VLAN Tag"
            type="number"
            min={1}
            max={4094}
            value={netForm.vlanTag}
            onChange={(e) => setNetForm({ ...netForm, vlanTag: e.target.value })}
          />
        </div>
        <Switch
          checked={netForm.firewall}
          onChange={(v) => setNetForm({ ...netForm, firewall: v })}
          label="启用防火墙"
        />
      </Modal>

      {/* ---- 新增挂载点 ---- */}
      <Modal
        open={mountOpen}
        onClose={() => setMountOpen(false)}
        title="新增挂载点"
        description="给容器额外挂一块数据盘，键名（mpN）由后端自动分配"
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setMountOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitMount()}>
              添加
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Select
            label="存储池"
            value={mountForm.storage}
            onChange={(e) => setMountForm({ ...mountForm, storage: e.target.value })}
            options={[{ label: '请选择存储池', value: '' }, ...mountStorageOptions]}
          />
          <Input
            label="容量（GB）"
            type="number"
            min={1}
            value={mountForm.size}
            onChange={(e) =>
              setMountForm({ ...mountForm, size: Number(e.target.value) || 0 })
            }
          />
          <Input
            label="容器内挂载路径"
            value={mountForm.mp}
            onChange={(e) => setMountForm({ ...mountForm, mp: e.target.value })}
            hint="如 /data"
          />
        </div>
        <Switch
          checked={mountForm.backup}
          onChange={(v) => setMountForm({ ...mountForm, backup: v })}
          label="纳入备份"
        />
      </Modal>

      {/* ---- 扩容 ---- */}
      <Modal
        open={Boolean(resizeTarget)}
        onClose={() => setResizeTarget(null)}
        title={`扩容 ${resizeTarget ?? ''}`}
        description="支持绝对值（20G）与增量（+10G）；容器不支持缩容"
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setResizeTarget(null)}>
              取消
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitResize()}>
              扩容
            </Button>
          </div>
        }
      >
        <Input
          label="目标容量"
          value={resizeSize}
          onChange={(e) => setResizeSize(e.target.value)}
          hint="填 20G 表示扩到 20G，填 +10G 表示增加 10G"
        />
      </Modal>

      {/* ---- 创建快照 ---- */}
      <Modal
        open={snapOpen}
        onClose={() => setSnapOpen(false)}
        title="创建快照"
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setSnapOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitSnapshot()}>
              创建
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label="快照名称"
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            hint="字母、数字、连字符与下划线"
          />
          <Input
            label="描述"
            value={snapDesc}
            onChange={(e) => setSnapDesc(e.target.value)}
          />
        </div>
      </Modal>

      {/* ---- 删除确认 ---- */}
      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDelete()}
        title="删除容器"
        danger
        confirmText="删除"
        loading={pending}
        requireText={ct.name || String(ctId)}
        message={
          running
            ? `容器 ${ctId} 正在运行，请先关机后再删除。`
            : `将删除容器「${ct.name}」（CT ${ctId}）及其全部数据，此操作不可恢复。请输入容器名称以确认。`
        }
      />

      {/* ---- 移除硬件确认 ---- */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        title={`移除 ${removeTarget ?? ''}`}
        danger
        confirmText="移除"
        loading={pending}
        message="只删除配置项，卷数据会作为孤立卷留在存储池（可在「存储」页回收）。"
      />

      {/* ---- 快照回滚 / 删除确认 ---- */}
      <ConfirmDialog
        open={Boolean(snapAction)}
        onCancel={() => setSnapAction(null)}
        onConfirm={() => void confirmSnapAction()}
        title={
          snapAction?.kind === 'rollback'
            ? `回滚到快照「${snapAction?.name}」`
            : `删除快照「${snapAction?.name}」`
        }
        danger={snapAction?.kind === 'delete'}
        confirmText={snapAction?.kind === 'rollback' ? '回滚' : '删除'}
        loading={pending}
        message={
          snapAction?.kind === 'rollback'
            ? '容器会回到该快照的状态，之后的变更将丢失。'
            : '删除后无法恢复。'
        }
      />
    </PageShell>
  );
}
