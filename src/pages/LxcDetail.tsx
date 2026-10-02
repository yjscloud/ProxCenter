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
import { isRunning, isTransient, vmStatusMeta } from '../utils/status'
import { useT } from '../i18n';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { RrdPoint, RrdTimeframe } from '../api/types';
import type { LxcMountConfig, LxcNetworkConfig } from '../api/types';

type TabKey = 'overview' | 'network' | 'storage' | 'snapshot' | 'console';

/* 分区页签在组件内构造（文案随语言走），见 LxcDetail 里的 tabs */

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

/** PVE 的字节数可能是 number 也可能是字符串 */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function LxcDetail() {
  const t = useT();
  const { node = '', vmid = '' } = useParams<{ node: string; vmid: string }>();
  const ctId = Number(vmid);
  const navigate = useNavigate();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();

  const tabs = useMemo(
    () => [
      { label: t('lxcDetail.tabOverview'), value: 'overview' as TabKey },
      { label: t('lxcDetail.tabNetwork'), value: 'network' as TabKey },
      { label: t('lxcDetail.tabStorage'), value: 'storage' as TabKey },
      { label: t('lxcDetail.tabSnapshot'), value: 'snapshot' as TabKey },
      { label: t('lxcDetail.tabConsole'), value: 'console' as TabKey },
    ],
    [t],
  );

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
    const labels = {
      start: t('lxcDetail.powerStart'),
      stop: t('lxcDetail.powerStop'),
      shutdown: t('lxcDetail.powerShutdown'),
      reboot: t('lxcDetail.powerReboot'),
    };
    setPending(true);
    try {
      await runner.run(guestPower[action]({ node, vmid: ctId, type: 'lxc' }), {
        title: t('lxcDetail.powerTask', {
          action: labels[action],
          name: ct?.name ?? ctId,
        }),
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
        title: t('lxcDetail.deleteTask', { name: ct?.name ?? ctId }),
        node,
        invalidate: [['vms'], ['lxc'], ['cluster']],
        destructive: true,
      });
      toast.destructive(t('lxcDetail.deleted'), t('lxcDetail.deletedHint'));
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
          title: t('lxcDetail.updateConfigTask', { name: ct?.name ?? ctId }),
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
          title: t('lxcDetail.addNetworkTask'),
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
      toast.warning(t('lxcDetail.mountPathRequired'), t('lxcDetail.mountPathExample'));
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
        {
          title: t('lxcDetail.addMountTask'),
          node,
          invalidate: [['lxc', node, ctId]],
        },
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
        title: t('lxcDetail.resizeTask', { disk }),
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
      toast.warning(t('lxcDetail.snapshotNameRequired'));
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
          title: t('lxcDetail.createSnapshotTask'),
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
        title: t('lxcDetail.removeTask', { key }),
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
            ? t('lxcDetail.rollbackTask', { name: snapAction.name })
            : t('lxcDetail.deleteSnapshotTask', { name: snapAction.name }),
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
          title={t('lxcDetail.loadFailed')}
          message={errorMessage(ctQuery.error)}
          onRetry={() => void ctQuery.refetch()}
        />
      </div>
    );
  }

  const status = vmStatusMeta(ct.status, t);
  const running = isRunning(ct.status);
  const busy = isTransient(ct.status) || pending || Boolean(ct.lock);

  const memPct = toPercent(toNumber(ct.mem) / Math.max(toNumber(ct.maxmem), 1));
  const cpuPct = toPercent(ct.cpu ?? 0) * Math.max(Number(ct.cpus ?? 1), 1);
  /* 与虚拟机不同：容器的 disk / maxdisk 就是真实用量，可以直接算 */
  const diskPct = toPercent(toNumber(ct.disk) / Math.max(toNumber(ct.maxdisk), 1));

  const networkColumns: Array<Column<LxcNetworkConfig>> = [
    {
      key: 'interface',
      header: t('lxcDetail.colInterface'),
      width: 110,
      render: (r) => <code>{r.interface}</code>,
    },
    {
      key: 'name',
      header: t('lxcDetail.colContainerSide'),
      width: 100,
      render: (r) => r.name ?? '-',
    },
    {
      key: 'bridge',
      header: t('lxcDetail.colBridge'),
      width: 120,
      render: (r) => r.bridge ?? '-',
    },
    { key: 'ip', header: 'IPv4', render: (r) => r.ip ?? '-' },
    {
      key: 'gw',
      header: t('lxcDetail.colGateway'),
      width: 140,
      render: (r) => r.gw ?? '-',
    },
    { key: 'ip6', header: 'IPv6', render: (r) => r.ip6 ?? '-' },
    {
      key: 'firewall',
      header: t('lxcDetail.colFirewall'),
      width: 90,
      align: 'center',
      render: (r) =>
        r.firewall === '1' ? (
          <Badge variant="success" size="sm">
            {t('lxcDetail.on')}
          </Badge>
        ) : (
          <span className="text-muted">{t('lxcDetail.off')}</span>
        ),
    },
    {
      key: 'actions',
      header: t('nodeDetail.colActions'),
      width: 90,
      align: 'right',
      render: (r) => (
        <IconButton
          label={t('lxcDetail.removeAria', { name: r.interface })}
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
    {
      key: 'interface',
      header: t('lxcDetail.colKey'),
      width: 100,
      render: (r) => <code>{r.interface}</code>,
    },
    {
      key: 'mp',
      header: t('lxcDetail.colMountPath'),
      width: 160,
      render: (r) => r.mp ?? '-',
    },
    {
      key: 'storage',
      header: t('lxcDetail.colStorage'),
      width: 130,
      render: (r) => r.storage ?? '-',
    },
    {
      key: 'size',
      header: t('lxcDetail.colSize'),
      width: 100,
      render: (r) => r.size || '-',
    },
    {
      key: 'volid',
      header: t('lxcDetail.colVolume'),
      render: (r) => <code className="fs-xs">{r.volid || '-'}</code>,
    },
    {
      key: 'actions',
      header: t('nodeDetail.colActions'),
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
            {t('lxcDetail.resize')}
          </Button>
          {r.interface !== 'rootfs' ? (
            <IconButton
              label={t('lxcDetail.removeAria', { name: r.interface })}
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
    {
      key: 'name',
      header: t('common.name'),
      render: (r) => <code>{String(r.name)}</code>,
    },
    {
      key: 'description',
      header: t('lxcDetail.colDescription'),
      render: (r) => String(r.description ?? '-'),
    },
    {
      key: 'snaptime',
      header: t('common.createdAt'),
      width: 180,
      render: (r) =>
        r.snaptime ? new Date(Number(r.snaptime) * 1000).toLocaleString() : '-',
    },
    {
      key: 'actions',
      header: t('nodeDetail.colActions'),
      width: 160,
      align: 'right',
      render: (r) => {
        const name = String(r.name);
        if (name === 'current')
          return <span className="text-muted">{t('lxcDetail.currentState')}</span>;
        return (
          <div className="flex items-center gap-4 justify-end">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canSnapshot || busy}
              onClick={() => setSnapAction({ kind: 'rollback', name })}
            >
              {t('lxcDetail.rollback')}
            </Button>
            <IconButton
              label={t('lxcDetail.deleteSnapshotAria', { name })}
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
              { label: t('lxcDetail.breadcrumbLxc'), to: '/lxc' },
              { label: ct.name || `CT ${ctId}` },
            ]}
          />
          <Badge variant={status.variant} dot pulse={status.pulse}>
            {status.label}
          </Badge>
          <Badge variant="neutral" size="sm">
            {t('lxcDetail.lxcBadge')}
          </Badge>
          {ct.lock ? (
            <Badge variant="warning" size="sm">
              {t('lxcDetail.locked', { lock: ct.lock })}
            </Badge>
          ) : null}
        </div>
      }
      subtitle={`${node} · CT ${ctId}${ct.ostemplate ? ` · ${ct.ostemplate.split('/').pop()}` : ''}`}
      actions={
        <div className="flex items-center gap-8">
          <IconButton
            label={t('common.refresh')}
            variant="secondary"
            onClick={invalidate}
          >
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label={t('lxcDetail.editConfig')}
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
                {t('lxcDetail.powerReboot')}
              </Button>
              <Button
                variant="secondary"
                icon={<IconStop size={15} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('shutdown')}
              >
                {t('lxcDetail.powerShutdown')}
              </Button>
              <Button
                variant="danger"
                icon={<IconStop size={15} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('stop')}
              >
                {t('lxcDetail.forceStop')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<IconPlay size={15} />}
              disabled={!canPower || busy}
              onClick={() => void doPower('start')}
            >
              {t('lxcDetail.powerStart')}
            </Button>
          )}
          <Button
            variant="danger"
            icon={<IconTrash size={15} />}
            disabled={!canDelete || busy}
            onClick={() => setDeleteOpen(true)}
          >
            {t('common.delete')}
          </Button>
        </div>
      }
    >
      <div className="mb-16">
        <SegmentedControl<TabKey>
          value={tab}
          onChange={setTab}
          options={tabs}
          ariaLabel={t('lxcDetail.tabsAria')}
        />
      </div>

      {/* ==================== 概览 ==================== */}
      {tab === 'overview' ? (
        <>
          <div className="kpi-grid mb-16">
            <KpiCard
              label="CPU"
              value={`${cpuPct.toFixed(1)}%`}
              hint={t('lxcDetail.kpiCpuHint', { n: ct.cpus ?? 1 })}
              icon={<IconCpu size={18} />}
              progress={Math.min(100, cpuPct)}
            />
            <KpiCard
              label={t('lxcDetail.kpiMem')}
              value={`${memPct.toFixed(0)}%`}
              hint={`${formatBytes(toNumber(ct.mem))} / ${formatBytes(toNumber(ct.maxmem))}`}
              icon={<IconMemory size={18} />}
              progress={memPct}
            />
            <KpiCard
              label={t('lxcDetail.kpiDisk')}
              value={`${diskPct.toFixed(0)}%`}
              hint={`${formatBytes(toNumber(ct.disk))} / ${formatBytes(toNumber(ct.maxdisk))}`}
              icon={<IconStorage size={18} />}
              progress={diskPct}
            />
            <KpiCard
              label={t('lxcDetail.kpiUptime')}
              value={formatUptimeShort(ct.uptime)}
              hint={running ? t('lxcDetail.running') : t('lxcDetail.stopped')}
              icon={<IconLayers size={18} />}
            />
          </div>

          <div className="grid grid-2 mb-16">
            <Card>
              <CardHeader
                title={t('lxcDetail.basicInfo')}
                icon={<IconLayers size={16} />}
              />
              <InfoGrid>
                {/* 容器没有独立的 name 字段，主机名就是它的名字。
                    编辑入口直接开「编辑配置」弹窗（第一项就是主机名），
                    不另做一个只改一行的弹窗 —— 两处表单会各自漂移。 */}
                <InfoRow
                  label={t('lxcDetail.fieldHostname')}
                  value={
                    <span className="info-editable">
                      <span className="truncate">{ct.hostname || ct.name}</span>
                      {canConfig && !busy ? (
                        <IconButton
                          label={t('lxcDetail.renameHostname')}
                          onClick={() => setConfigOpen(true)}
                        >
                          <IconEdit size={13} />
                        </IconButton>
                      ) : null}
                    </span>
                  }
                />
                <InfoRow label="VMID" value={String(ctId)} />
                <InfoRow label={t('lxcDetail.fieldNode')} value={node} />
                <InfoRow
                  label={t('lxcDetail.fieldType')}
                  value={
                    ct.unprivileged
                      ? t('lxcDetail.unprivileged')
                      : t('lxcDetail.privileged')
                  }
                />
                <InfoRow label={t('lxcDetail.fieldStatus')} value={status.label} />
                <InfoRow
                  label={t('lxcDetail.fieldUptime')}
                  value={formatUptimeShort(ct.uptime)}
                />
                <InfoRow
                  label={t('lxcDetail.fieldCreated')}
                  /* 容器实测都没有 meta，通常是「—」；留着是为了以后 PVE 补上时
                     自动显示，不必再改一次界面 */
                  title={t('lxcDetail.createdTitle')}
                  value={ct.created ? formatDateTime(ct.created) : '—'}
                />
                <InfoRow
                  label={t('lxcDetail.fieldCpuCores')}
                  value={String(ct.cpus ?? '-')}
                />
                <InfoRow
                  label={t('lxcDetail.fieldMemory')}
                  value={`${formatBytes(toNumber(ct.maxmem))}`}
                />
                <InfoRow
                  label={t('lxcDetail.fieldSwap')}
                  value={`${formatBytes(toNumber(ct.maxswap))}`}
                />
                <InfoRow
                  label={t('lxcDetail.fieldFeatures')}
                  value={ct.features || t('lxcDetail.none')}
                />
                <InfoRow
                  label={t('lxcDetail.fieldTemplate')}
                  value={ct.ostemplate || '-'}
                />
                <InfoRow
                  label={t('lxcDetail.fieldSshKeys')}
                  value={
                    ct.ssh_keys_set ? t('lxcDetail.injected') : t('lxcDetail.notSet')
                  }
                />
                <InfoRow
                  label={t('lxcDetail.fieldDns')}
                  value={ct.nameserver || t('lxcDetail.default')}
                />
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
                title={t('lxcDetail.monitor')}
                icon={<IconNetwork size={16} />}
                actions={
                  <SegmentedControl<RrdTimeframe>
                    value={timeframe}
                    onChange={setTimeframe}
                    options={[
                      { label: t('lxcDetail.tfHour'), value: 'hour' },
                      { label: t('lxcDetail.tfDay'), value: 'day' },
                      { label: t('lxcDetail.tfWeek'), value: 'week' },
                      { label: t('lxcDetail.tfMonth'), value: 'month' },
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
            title={t('lxcDetail.netCard')}
            icon={<IconNetwork size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canConfig || busy}
                onClick={() => setNetOpen(true)}
              >
                {t('lxcDetail.addNetwork')}
              </Button>
            }
          />
          <Notice tone="info" title={t('lxcDetail.ipNoticeTitle')}>
            {t('lxcDetail.ipNoticeBody')}
          </Notice>
          <Table
            columns={networkColumns}
            rows={ct.networks}
            rowKey={(r) => r.interface}
            caption={t('lxcDetail.netCaption')}
            emptyTitle={t('lxcDetail.netEmpty')}
            emptyDescription={t('lxcDetail.netEmptyDesc')}
          />
        </Card>
      ) : null}

      {/* ==================== 存储 ==================== */}
      {tab === 'storage' ? (
        <Card>
          <CardHeader
            title={t('lxcDetail.storageCard')}
            icon={<IconStorage size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canConfig || busy}
                onClick={() => setMountOpen(true)}
              >
                {t('lxcDetail.addMount')}
              </Button>
            }
          />
          <Notice tone="warning" title={t('lxcDetail.resizeWarnTitle')}>
            {t('lxcDetail.resizeWarnBody')}
          </Notice>
          <Table
            columns={storageColumns}
            rows={mountRows}
            rowKey={(r) => r.interface}
            caption={t('lxcDetail.storageCaption')}
            emptyTitle={t('lxcDetail.storageEmpty')}
          />
        </Card>
      ) : null}

      {/* ==================== 快照 ==================== */}
      {tab === 'snapshot' ? (
        <Card>
          <CardHeader
            title={t('lxcDetail.snapshotCard')}
            icon={<IconSnapshot size={16} />}
            actions={
              <Button
                size="sm"
                icon={<IconPlus size={14} />}
                disabled={!canSnapshot || busy}
                onClick={() => setSnapOpen(true)}
              >
                {t('lxcDetail.createSnapshot')}
              </Button>
            }
          />
          <Notice tone="info" title={t('lxcDetail.snapshotNoticeTitle')}>
            {t('lxcDetail.snapshotNoticeBody')}
          </Notice>
          <Table
            columns={snapshotColumns}
            rows={(snapshotsQuery.data ?? []) as unknown as Array<Record<string, unknown>>}
            rowKey={(r) => String(r.name)}
            loading={snapshotsQuery.isLoading}
            caption={t('lxcDetail.snapshotCaption')}
            emptyTitle={t('lxcDetail.snapshotEmpty')}
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
        title={t('lxcDetail.configTitle')}
        description={t('lxcDetail.configDesc')}
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setConfigOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitConfig()}>
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label={t('lxcDetail.fieldHostname')}
            value={cfgForm.hostname}
            onChange={(e) => setCfgForm({ ...cfgForm, hostname: e.target.value })}
            hint={t('lxcDetail.hostnameHint')}
          />
          <Input
            label={t('lxcDetail.memoryMb')}
            type="number"
            min={16}
            step={128}
            value={cfgForm.memory}
            onChange={(e) =>
              setCfgForm({ ...cfgForm, memory: Number(e.target.value) || 0 })
            }
          />
          <Input
            label={t('lxcDetail.swapMb')}
            type="number"
            min={0}
            step={128}
            value={cfgForm.swap}
            onChange={(e) => setCfgForm({ ...cfgForm, swap: Number(e.target.value) || 0 })}
          />
          <Input
            label={t('lxcDetail.fieldCpuCores')}
            type="number"
            min={1}
            value={cfgForm.cores}
            onChange={(e) => setCfgForm({ ...cfgForm, cores: Number(e.target.value) || 0 })}
          />
        </div>
        <Switch
          checked={cfgForm.onboot}
          onChange={(v) => setCfgForm({ ...cfgForm, onboot: v })}
          label={t('lxcDetail.onboot')}
        />
        <Switch
          checked={cfgForm.protection}
          onChange={(v) => setCfgForm({ ...cfgForm, protection: v })}
          label={t('lxcDetail.protection')}
          hint={t('lxcDetail.protectionHint')}
        />
        <Field label={t('lxcDetail.description')}>
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
        title={t('lxcDetail.addNetwork')}
        description={t('lxcDetail.addNetworkDesc')}
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setNetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitNetwork()}>
              {t('lxcDetail.add')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label={t('lxcDetail.colBridge')}
            value={netForm.bridge}
            onChange={(e) => setNetForm({ ...netForm, bridge: e.target.value })}
            hint={t('lxcDetail.bridgeHint')}
          />
          <Input
            label="IPv4"
            value={netForm.ip}
            onChange={(e) => setNetForm({ ...netForm, ip: e.target.value })}
            hint={t('lxcDetail.ipHint')}
          />
          <Input
            label={t('lxcDetail.colGateway')}
            value={netForm.gateway}
            onChange={(e) => setNetForm({ ...netForm, gateway: e.target.value })}
          />
          <Input
            label={t('lxcDetail.vlanTag')}
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
          label={t('lxcDetail.enableFirewall')}
        />
      </Modal>

      {/* ---- 新增挂载点 ---- */}
      <Modal
        open={mountOpen}
        onClose={() => setMountOpen(false)}
        title={t('lxcDetail.addMount')}
        description={t('lxcDetail.addMountDesc')}
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setMountOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitMount()}>
              {t('lxcDetail.add')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Select
            label={t('lxcDetail.storagePool')}
            value={mountForm.storage}
            onChange={(e) => setMountForm({ ...mountForm, storage: e.target.value })}
            options={[
              { label: t('lxcDetail.selectStoragePool'), value: '' },
              ...mountStorageOptions,
            ]}
          />
          <Input
            label={t('lxcDetail.sizeGb')}
            type="number"
            min={1}
            value={mountForm.size}
            onChange={(e) =>
              setMountForm({ ...mountForm, size: Number(e.target.value) || 0 })
            }
          />
          <Input
            label={t('lxcDetail.mountPathLabel')}
            value={mountForm.mp}
            onChange={(e) => setMountForm({ ...mountForm, mp: e.target.value })}
            hint={t('lxcDetail.mountPathHint')}
          />
        </div>
        <Switch
          checked={mountForm.backup}
          onChange={(v) => setMountForm({ ...mountForm, backup: v })}
          label={t('lxcDetail.includeBackup')}
        />
      </Modal>

      {/* ---- 扩容 ---- */}
      <Modal
        open={Boolean(resizeTarget)}
        onClose={() => setResizeTarget(null)}
        title={t('lxcDetail.resizeTitle', { disk: resizeTarget ?? '' })}
        description={t('lxcDetail.resizeDesc')}
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setResizeTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitResize()}>
              {t('lxcDetail.resize')}
            </Button>
          </div>
        }
      >
        <Input
          label={t('lxcDetail.targetSize')}
          value={resizeSize}
          onChange={(e) => setResizeSize(e.target.value)}
          hint={t('lxcDetail.targetSizeHint')}
        />
      </Modal>

      {/* ---- 创建快照 ---- */}
      <Modal
        open={snapOpen}
        onClose={() => setSnapOpen(false)}
        title={t('lxcDetail.createSnapshot')}
        footer={
          <div className="flex items-center gap-8 justify-end">
            <Button variant="secondary" onClick={() => setSnapOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submitSnapshot()}>
              {t('common.create')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Input
            label={t('lxcDetail.snapshotName')}
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            hint={t('lxcDetail.snapshotNameHint')}
          />
          <Input
            label={t('lxcDetail.colDescription')}
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
        title={t('lxcDetail.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={pending}
        requireText={ct.name || String(ctId)}
        message={
          running
            ? t('lxcDetail.deleteRunning', { vmid: ctId })
            : t('lxcDetail.deleteMessage', { name: ct.name, vmid: ctId })
        }
      />

      {/* ---- 移除硬件确认 ---- */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        title={t('lxcDetail.removeTitle', { key: removeTarget ?? '' })}
        danger
        confirmText={t('lxcDetail.removeConfirm')}
        loading={pending}
        message={t('lxcDetail.removeMessage')}
      />

      {/* ---- 快照回滚 / 删除确认 ---- */}
      <ConfirmDialog
        open={Boolean(snapAction)}
        onCancel={() => setSnapAction(null)}
        onConfirm={() => void confirmSnapAction()}
        title={
          snapAction?.kind === 'rollback'
            ? t('lxcDetail.rollbackTitle', { name: snapAction?.name ?? '' })
            : t('lxcDetail.deleteSnapTitle', { name: snapAction?.name ?? '' })
        }
        danger={snapAction?.kind === 'delete'}
        confirmText={
          snapAction?.kind === 'rollback'
            ? t('lxcDetail.rollback')
            : t('common.delete')
        }
        loading={pending}
        message={
          snapAction?.kind === 'rollback'
            ? t('lxcDetail.rollbackMessage')
            : t('lxcDetail.deleteSnapMessage')
        }
      />
    </PageShell>
  );
}
