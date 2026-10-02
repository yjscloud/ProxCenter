/* ==========================================================================
   ProxCenter — 虚拟机详情
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  backupsApi,
  clusterApi,
  nodesApi,
  storagesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { Breadcrumb } from '../components/Topbar';
import {
  Card,
  CardHeader,
  InfoGrid,
  InfoRow,
  KpiCard,
} from '../components/ui/Card';
import { Badge, TagList } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
} from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DetailSkeleton } from '../components/ui/Spinner';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Table, type Column } from '../components/ui/Table';
import { ConsoleTab } from '../components/ConsoleTab';
import {
  CpuChart,
  DiskIoChart,
  MemoryChart,
  NetworkChart,
} from '../components/MetricChart';
import {
  IconPlay,
  IconPower,
  IconStop,
  IconRestart,
  IconRefresh,
  IconTrash,
  IconEdit,
  IconCpu,
  IconMemory,
  IconDisk,
  IconNetwork,
  IconSnapshot,
  IconBackup,
  IconConsole,
  IconMonitor,
  IconVm,
  IconLayers,
  IconPause,
  IconPlus,
  IconAlert,
} from '../components/Icons';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  formatUptime,
  parseTags,
  parseSizeToBytes,
  toPercent,
  usageColor,
  usageTone,
} from '../utils/format';
import {
  isRunning,
  isStopped,
  isTransient,
  ostypeLabel,
  taskStatusMeta,
  vmStatusMeta,
} from '../utils/status'
import { tStatic, useT, type MessageKey } from '../i18n';;
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  BackupItem,
  RrdPoint,
  RrdTimeframe,
  Snapshot,
  TaskInfo,
  VmAddDiskRequest,
  VmAddNetworkRequest,
  VmDetail as VmDetailType,
  VmGuestFilesystem,
} from '../api/types';

/** 硬件页要卸掉的目标：键名 + 给用户看的描述 + 可选的补充说明 */
interface HardwareRemoveTarget {
  key: string;
  title: string;
  detail?: string;
}

type TabKey =
  | 'overview'
  | 'hardware'
  | 'console'
  | 'snapshots'
  | 'backups'
  | 'monitor'
  | 'config';

const TABS: Array<{ key: TabKey; labelKey: MessageKey; icon: React.ReactNode }> = [
  { key: 'overview', labelKey: 'vmDetail.tab.overview', icon: <IconVm size={15} /> },
  { key: 'hardware', labelKey: 'vmDetail.tab.hardware', icon: <IconCpu size={15} /> },
  { key: 'console', labelKey: 'vmDetail.tab.console', icon: <IconConsole size={15} /> },
  { key: 'snapshots', labelKey: 'vmDetail.tab.snapshots', icon: <IconSnapshot size={15} /> },
  { key: 'backups', labelKey: 'vmDetail.tab.backups', icon: <IconBackup size={15} /> },
  { key: 'monitor', labelKey: 'vmDetail.tab.monitor', icon: <IconMonitor size={15} /> },
  { key: 'config', labelKey: 'vmDetail.tab.config', icon: <IconLayers size={15} /> },
];

/* ==========================================================================
   主页面
   ========================================================================== */

export function VmDetail() {
  const t = useT();
  const { node = '', vmid: vmidParam = '' } = useParams<{
    node: string;
    vmid: string;
  }>();
  const vmid = Number(vmidParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runner = useTaskRunner();
  const { canWrite } = useAuth();

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = (searchParams.get('tab') as TabKey | null) ?? 'overview';
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'overview';

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /* 改名：只写 PVE 的 `name` 字段（不会连带写回其它配置） */
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const validParams = Boolean(node) && Number.isInteger(vmid) && vmid > 0;

  /* ---- 客户机磁盘用量 ----
     放在页面级而不是概览 Tab 里：Tab 切换会卸载重挂载子组件，状态放在里面
     会导致每切一次 Tab 就往客户机里发一次 df。这里持有后切 Tab 不再重跑。 */
  const [guestFs, setGuestFs] = useState<VmGuestFilesystem[] | null>(null);
  const [fsBusy, setFsBusy] = useState(false);

  const probeDiskUsage = useCallback(async () => {
    if (!validParams) return;
    setFsBusy(true);
    try {
      const res = await vmsApi.diskUsage(node, vmid);
      setGuestFs(res.filesystems);
    } catch {
      /* 读客户机用量是「有则更好」的增强信息，失败不打扰用户：
         客户机没装 qemu-guest-agent、虚拟机里不是 Linux、命令超时……
         都会走到这里，KPI 会自动退回显示分配容量。 */
    } finally {
      setFsBusy(false);
    }
  }, [node, vmid, validParams]);

  /* 客户机各文件系统的合计用量。挂载点之间不重叠（/ 与 /boot 是不同设备），
     所以直接相加不会重复计算。读不到时为 null，KPI 退回显示分配容量。 */
  const diskUsage = useMemo(() => {
    if (!guestFs || guestFs.length === 0) return null;
    const total = guestFs.reduce((sum, f) => sum + f.total_bytes, 0);
    const used = guestFs.reduce((sum, f) => sum + f.used_bytes, 0);
    if (total <= 0) return null;
    return { total, used, percent: (used / total) * 100 };
  }, [guestFs]);

  /* ---- 主查询 ----
     刻意关掉 react-query 的自动重试：默认会退避重试 3 次（约 7 秒），
     接口真出错时页面会先「卡」住再报错，看起来像卡死；本身已有 10 秒
     轮询兜底，不需要再加一层重试。 */
  const vmQuery = useQuery({
    queryKey: ['vm', node, vmid],
    queryFn: () => vmsApi.detail(node, vmid),
    enabled: validParams,
    refetchInterval: 10_000,
    retry: false,
  });

  /* ---- 最近任务 ---- */
  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', node, 20],
    queryFn: () => clusterApi.tasks({ node, limit: 20 }),
    enabled: validParams,
    refetchInterval: 15_000,
    retry: false,
  });

  const vmTasks = useMemo(() => {
    const list = tasksQuery.data ?? [];
    return list
      .filter((t) => {
        const id = t.id ?? '';
        return id === String(vmid) || id.includes(String(vmid));
      })
      .slice(0, 6);
  }, [tasksQuery.data, vmid]);

  const vm: VmDetailType | undefined = vmQuery.data;

  /* 进页面自动探测一次客户机磁盘用量，KPI 一打开就是真实使用率。
     只探一次（ref 保证），不会跟着 10 秒轮询反复在客户机里起进程；
     失败也不自动重试，交给卡片上的按钮手动重试。 */
  const diskProbed = useRef(false);
  useEffect(() => {
    if (diskProbed.current || !vm) return;
    if (!vm.agent_enabled || !isRunning(vm.status)) return;
    diskProbed.current = true;
    void probeDiskUsage();
  }, [vm, probeDiskUsage]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['vm', node, vmid] });
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
    void queryClient.invalidateQueries({ queryKey: ['cluster'] });
  }, [queryClient, node, vmid]);

  /* ---- 改名 ----
     只提交 `{ name }` 一个字段：PVE 的 qemu 配置接口是「改哪项传哪项」，
     不会因为少传字段就把内存/磁盘清掉。
     名称没有内置校验 —— 真正说了算的是 PVE，这里只挡住明显不合法的输入，
     让错误信息来自一处（后端把 PVE 的原话带回来）。 */
  const saveRename = async () => {
    if (!vm) return;
    const name = renameValue.trim();
    if (!name) {
      toast.warning(t('vmDetail.renameRequired'), t('vmDetail.renameRequiredHint'));
      return;
    }
    if (name.length > 63) {
      toast.warning(t('vmDetail.nameTooLong'), t('vmDetail.nameTooLongHint'));
      return;
    }
    if (name === (vm.name ?? '')) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await runner.run(vmsApi.updateConfig(node, vmid, { name }), {
        title: t('vmDetail.renameTask', { name }),
        node,
        invalidate: [['vm', node, vmid], ['vms']],
      });
      setRenameOpen(false);
    } catch {
      /* toast 已处理 */
    } finally {
      setRenaming(false);
    }
  };

  /* ---- 电源操作 ---- */
  const power = useCallback(
    async (action: 'start' | 'stop' | 'shutdown' | 'reboot' | 'suspend' | 'resume') => {
      if (!canWrite) {
        toast.warning(t('vmDetail.noPermission'), t('power.denied'));
        return;
      }
      if (!vm) return;

      const labels: Record<typeof action, MessageKey> = {
        start: 'power.start',
        stop: 'power.stop',
        shutdown: 'power.shutdown',
        reboot: 'power.reboot',
        suspend: 'power.suspend',
        resume: 'power.resume',
      };

      const calls: Record<typeof action, () => Promise<{ task?: string }>> = {
        start: () => vmsApi.start(node, vmid),
        stop: () => vmsApi.stop(node, vmid),
        shutdown: () => vmsApi.shutdown(node, vmid, 60, false),
        reboot: () => vmsApi.reboot(node, vmid),
        suspend: () => vmsApi.suspend(node, vmid),
        resume: () => vmsApi.resume(node, vmid),
      };

      try {
        await runner.run(calls[action](), {
          title: t('power.task', {
            action: t(labels[action]),
            name: vm.name || vmid,
          }),
          node,
          invalidate: [['vm', node, vmid], ['vms'], ['cluster']],
        });
      } catch {
        /* toast 已处理 */
      }
    },
    [canWrite, vm, node, vmid, runner, toast],
  );

  /* ---- 加载 / 错误 ---- */
  if (!validParams) {
    return (
      <div className="page">
        <ErrorState
          title={t('vmDetail.invalidTitle')}
          message={t('vmDetail.invalidMessage')}
          onRetry={() => navigate('/vms')}
        />
      </div>
    );
  }

  if (vmQuery.isLoading) {
    return (
      <div className="page">
        <DetailSkeleton />
      </div>
    );
  }

  if (vmQuery.isError || !vm) {
    const notImpl = isNotImplemented(vmQuery.error);
    return (
      <div className="page">
        <Breadcrumb
          items={[
            { label: t('nav.vms'), to: '/vms' },
            { label: `${node} / ${vmid}` },
          ]}
        />
        <ErrorState
          title={notImpl ? t('vmDetail.notAvailable') : t('vmDetail.loadFailed')}
          message={errorMessage(vmQuery.error)}
          notImplemented={notImpl}
          onRetry={() => void vmQuery.refetch()}
        />
        <Button variant="secondary" onClick={() => navigate('/vms')}>
          {t('vmDetail.backToList')}
        </Button>
      </div>
    );
  }

  const statusMeta = vmStatusMeta(vm.status, tStatic);
  const running = isRunning(vm.status);
  const stopped = isStopped(vm.status);
  const frozen = vm.status === 'paused' || vm.status === 'suspended';
  const busy = isTransient(vm.status) || Boolean(vm.lock);
  const noWrite = !canWrite || busy;

  /* Guest Agent 三态：区分「没开」「开了但没回话」「开着且正常」。
     以前只看 agent_available，配置开了却没回复时会显示成「不可用」，
     让人以为开关没生效；虚拟机根本没运行时也不该说 Agent 有问题。 */
  const agentBadge: { label: string; variant: 'success' | 'warning' | 'neutral' } =
    !vm.agent_enabled
      ? { label: t('vmDetail.agentDisabled'), variant: 'neutral' }
      : vm.agent_available
        ? { label: t('vmDetail.agentAvailable'), variant: 'success' }
        : running
          ? { label: t('vmDetail.agentNoResponse'), variant: 'warning' }
          : { label: t('vmDetail.notRunning'), variant: 'neutral' };

  const cpuPct = toPercent(vm.cpu);
  const memPct = vm.maxmem ? ((vm.mem ?? 0) / vm.maxmem) * 100 : 0;

  return (
    <div className="page">
      {/* ---- 头部 ---- */}
      <div className="detail-header">
        <div className="detail-header-main">
          <Breadcrumb
            items={[
              { label: t('nav.vms'), to: '/vms' },
              { label: `${vm.name || `VM ${vmid}`}` },
            ]}
          />
          <div className="detail-title-row">
            <span className="detail-name">{vm.name || `VM ${vmid}`}</span>
            {/* 改名放在标题旁：它修饰的就是这个名字本身，在概览卡片里再放一个
                反而要用户先切回概览页 */}
            {canWrite ? (
              <IconButton
                label={t('vmDetail.renameAction')}
                onClick={() => {
                  setRenameValue(vm.name ?? '');
                  setRenameOpen(true);
                }}
              >
                <IconEdit size={14} />
              </IconButton>
            ) : null}
            <span className="detail-id">{vm.vmid}</span>
            <Badge variant={statusMeta.variant} dot pulse={statusMeta.pulse}>
              {statusMeta.label}
            </Badge>
            {vm.template ? (
              <Badge variant="accent" size="sm">
                {t('vmDetail.badgeTemplate')}
              </Badge>
            ) : null}
            {vm.lock ? (
              <Badge variant="warning" size="sm">
                {t('vmDetail.badgeLocked', { lock: vm.lock })}
              </Badge>
            ) : null}
          </div>
          <div className="detail-meta">
            <span className="detail-meta-item">
              <IconVm size={13} />
              {t('common.node')} <span className="mono">{vm.node}</span>
            </span>
            <span className="detail-meta-item">
              {ostypeLabel(vm.config.ostype, tStatic)}
            </span>
            <span className="detail-meta-item">
              {vm.config.bios === 'ovmf' ? 'UEFI (OVMF)' : 'SeaBIOS'}
            </span>
            <span className="detail-meta-item">
              {running
                ? t('vmDetail.uptimeRunning', { uptime: formatUptime(vm.uptime) })
                : t('vmDetail.notRunning')}
            </span>
            <span className="detail-meta-item">
              <Badge variant={agentBadge.variant} dot size="sm">
                Guest Agent {agentBadge.label}
              </Badge>
            </span>
          </div>
          {parseTags(vm.tags).length > 0 ? (
            <TagList tags={parseTags(vm.tags)} max={8} />
          ) : null}
        </div>

        <div className="detail-actions">
          {stopped ? (
            <Button
              variant="primary"
              icon={<IconPlay size={15} />}
              onClick={() => void power('start')}
              disabled={noWrite}
            >
              {t('power.start')}
            </Button>
          ) : null}
          {running ? (
            <>
              <Button
                variant="secondary"
                icon={<IconPower size={15} />}
                onClick={() => void power('shutdown')}
                disabled={noWrite}
              >
                {t('power.shutdown')}
              </Button>
              <Button
                variant="secondary"
                icon={<IconRestart size={15} />}
                onClick={() => void power('reboot')}
                disabled={noWrite}
              >
                {t('power.reboot')}
              </Button>
              <Button
                variant="danger"
                icon={<IconStop size={14} />}
                onClick={() => void power('stop')}
                disabled={noWrite}
              >
                {t('power.stop')}
              </Button>
              <Button
                variant="ghost"
                icon={<IconPause size={14} />}
                onClick={() => void power('suspend')}
                disabled={noWrite}
              >
                {t('power.suspend')}
              </Button>
              <Button
                variant="secondary"
                icon={<IconConsole size={14} />}
                onClick={() => setTab('console')}
              >
                {t('vmDetail.tab.console')}
              </Button>
            </>
          ) : null}
          {frozen ? (
            <Button
              variant="primary"
              icon={<IconPlay size={15} />}
              onClick={() => void power('resume')}
              disabled={noWrite}
            >
              {t('power.resume')}
            </Button>
          ) : null}

          <IconButton
            label={t('vmDetail.refreshDetail')}
            onClick={() => {
              void vmQuery.refetch();
              invalidate();
            }}
          >
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label={t('vmDetail.deleteTitle')}
            variant="danger"
            onClick={() => setDeleteOpen(true)}
            disabled={!canWrite}
          >
            <IconTrash size={16} />
          </IconButton>
        </div>
      </div>

      {/* ---- Tab 导航 ---- */}
      <div className="tabs" role="tablist" aria-label={t('vmDetail.tablistAria')}>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.icon}
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="tab-panel">
        {tab === 'overview' ? (
          <OverviewTab
            vm={vm}
            cpuPct={cpuPct}
            memPct={memPct}
            tasks={vmTasks}
            tasksLoading={tasksQuery.isLoading}
            diskUsage={diskUsage}
            fsBusy={fsBusy}
            onRenameName={
              canWrite
                ? () => {
                    setRenameValue(vm.name ?? '');
                    setRenameOpen(true);
                  }
                : undefined
            }
          />
        ) : null}

        {tab === 'hardware' ? (
          <HardwareTab vm={vm} node={node} vmid={vmid} onChanged={invalidate} />
        ) : null}

        {tab === 'console' ? (
          <ConsoleTab
            node={node}
            vmid={vmid}
            vmName={vm.name}
            running={running}
          />
        ) : null}

        {tab === 'snapshots' ? <SnapshotsTab vm={vm} node={node} vmid={vmid} /> : null}

        {tab === 'backups' ? <BackupsTab vm={vm} node={node} vmid={vmid} /> : null}

        {tab === 'monitor' ? (
          <MonitorTab
            node={node}
            vmid={vmid}
            guestFs={guestFs}
            diskUsage={diskUsage}
          />
        ) : null}

        {tab === 'config' ? <ConfigTab node={node} vmid={vmid} vm={vm} /> : null}
      </div>

      {/* ---- 改名 ---- */}
      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('vmDetail.renameTitle')}
        description={t('vmDetail.renameDesc', { vmid, node })}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRenameOpen(false)}
              disabled={renaming}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void saveRename()} loading={renaming}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Input
          label={t('common.name')}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder={`VM ${vmid}`}
          maxLength={63}
          autoFocus
          hint={t('vmDetail.renameHint', {
            name: vm.name || t('vmDetail.unset'),
          })}
        />
      </Modal>

      {/* ---- 删除确认 ---- */}
      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await runner.run(vmsApi.delete(node, vmid, true), {
              title: t('vmDetail.deleteTask', { name: vm.name || vmid }),
              node,
              invalidate: [['vms'], ['cluster'], ['storages']],
              destructive: true,
            });
            setDeleteOpen(false);
            navigate('/vms');
          } finally {
            setDeleting(false);
          }
        }}
        title={t('vmDetail.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={deleting}
        requireText={vm.name || String(vmid)}
        message={
          <>
            {t('vmDetail.deleteSoon')} <strong>{vm.name || `VM ${vmid}`}</strong>
            {t('vmDetail.deleteTail', { vmid })}
          </>
        }
      />
    </div>
  );
}

/* ==========================================================================
   概览 Tab
   ========================================================================== */

function OverviewTab({
  vm,
  cpuPct,
  memPct,
  tasks,
  tasksLoading,
  diskUsage,
  fsBusy,
  onRenameName,
}: {
  vm: VmDetailType;
  cpuPct: number;
  memPct: number;
  tasks: TaskInfo[];
  tasksLoading: boolean;
  /* 客户机磁盘用量（合计）由页面级持有：切 Tab 不重跑探测，这里只负责展示 */
  diskUsage: { total: number; used: number; percent: number } | null;
  fsBusy: boolean;
  /** 改名由页面级处理（它持有 mutation 与刷新逻辑）；无写权限时传 undefined */
  onRenameName?: () => void;
}) {
  const t = useT();
  const running = isRunning(vm.status);

  /* 磁盘的「分配总量」。真实的已用量由 probeDiskUsage 从客户机里取，
     这个值只在探测不到时作为 KPI 的兜底读数。 */
  const diskTotal = useMemo(
    () => vm.disks.reduce((sum, d) => sum + (parseSizeToBytes(d.size) || 0), 0),
    [vm.disks],
  );

  /* CPU 类型 + 拓扑。config.cpu 允许带 flags（形如 "host,flags=+aes"），只取类型段。 */
  const cpuType = String(vm.config.cpu ?? '').split(',')[0].trim();
  const cpuTopology =
    vm.config.cores || vm.config.sockets
      ? t('vmDetail.cpuTopology', {
          sockets: vm.config.sockets ?? 1,
          cores: vm.config.cores ?? 1,
        })
      : '';
  const cpuText = [cpuType, cpuTopology].filter(Boolean).join(' · ') || '—';

  const taskColumns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: t('vmDetail.colType'),
      render: (task) => <span className="mono fs-sm">{task.type}</span>,
    },
    {
      key: 'status',
      header: t('vmDetail.colStatus'),
      render: (task) => {
        const meta = taskStatusMeta(task.status, task.exitstatus, tStatic);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      width: 96,
    },
    {
      key: 'time',
      header: t('vmDetail.colTime'),
      render: (task) => (
        <span className="fs-sm text-secondary">
          {formatRelative(task.starttime)}
        </span>
      ),
      align: 'right',
      width: 110,
    },
  ];

  return (
    <div className="detail-columns is-balanced">
      {/* ---- 实时资源：跨两列铺开 ----
          这三个读数是进详情页最先要看的，横排一行才好横向比较；
          原先挤在左列里竖着堆，和右列的任务表比起来一高一矮，
          底下会空出一大块。 */}
      <div className="grid grid-3 detail-full">
        <KpiCard
          label={t('vmDetail.kpiCpu')}
          value={`${cpuPct.toFixed(1)}%`}
          icon={<IconCpu size={16} />}
          tone={usageTone(cpuPct)}
          progress={cpuPct}
          progressColor={usageColor(cpuPct)}
          hint={
            /* QEMU 的 status 里只有 cpus（vCPU 数），没有 maxcpu，
               取错字段会显示成「0 vCPU」 */
            <span className="mono">
              {vm.cpus ?? vm.maxcpu ?? 0} vCPU
            </span>
          }
        />
        <KpiCard
          label={t('vmDetail.kpiMem')}
          value={`${memPct.toFixed(1)}%`}
          icon={<IconMemory size={16} />}
          tone={usageTone(memPct)}
          progress={memPct}
          progressColor={usageColor(memPct)}
          hint={
            <span className="mono">
              {formatBytes(vm.mem)} / {formatBytes(vm.maxmem)}
            </span>
          }
        />
        {/* 磁盘使用率来自客户机内实测（经 Guest Agent 执行 df）。
            PVE 侧的 status.disk / rrddata 的 disk 对 QEMU 恒为 0，
            maxdisk 只是分配总量，用它们算出来的百分比永远是 0%。
            探测不到时（未启用 Agent / 未运行 / 非 Linux 客户机 / 读取失败）
            退回显示分配容量，不让 KPI 空着或显示假读数。 */}
        <KpiCard
          label={t('vmDetail.kpiDisk')}
          value={
            diskUsage ? `${diskUsage.percent.toFixed(1)}%` : formatBytes(diskTotal, 0)
          }
          icon={<IconDisk size={16} />}
          tone={diskUsage ? usageTone(diskUsage.percent) : 'neutral'}
          progress={diskUsage ? diskUsage.percent : undefined}
          progressColor={diskUsage ? usageColor(diskUsage.percent) : undefined}
          loading={fsBusy && !diskUsage}
          hint={
            diskUsage ? (
              <span className="mono">
                {formatBytes(diskUsage.used, 0)} / {formatBytes(diskUsage.total, 0)}
              </span>
            ) : (
              <span className="mono">
                {t('vmDetail.diskMounts', {
                  count: vm.disks.length,
                  size: formatBytes(diskTotal, 0),
                })}
              </span>
            )
          }
        />
      </div>

      {/* ---- 左列：基本信息 ---- */}
      <div className="detail-column">
        {/* 概览这三张卡都不提供收起：内容是固定的一组事实，
            收起只会让人多点一下，还容易忘了自己收过 */}
        <Card className="vm-basic-info" collapsible={false}>
          <CardHeader title={t('vmDetail.basicInfo')} icon={<IconVm size={16} />} />
          <InfoGrid>
            {/* 名称是可改的（PVE 的 `name` 字段）：仍用 InfoRow 保持与其余各项
                同一套排版，只在值右侧挂一个编辑按钮 —— 单独的「重命名」按钮
                放在标题栏反而离它修饰的对象更远。 */}
            <InfoRow
              label={t('common.name')}
              value={
                <span className="info-editable">
                  <span className="truncate" title={vm.name || `VM ${vm.vmid}`}>
                    {vm.name || `VM ${vm.vmid}`}
                  </span>
                  {onRenameName ? (
                    <IconButton
                      label={t('vmDetail.renameAction')}
                      onClick={onRenameName}
                    >
                      <IconEdit size={13} />
                    </IconButton>
                  ) : null}
                </span>
              }
            />
            <InfoRow label="VMID" value={vm.vmid} mono />
            <InfoRow label={t('common.node')} value={vm.node} mono />
            <InfoRow
              label={t('vmDetail.os')}
              value={ostypeLabel(vm.config.ostype, tStatic)}
            />
            <InfoRow
              label="BIOS"
              value={vm.config.bios === 'ovmf' ? 'OVMF (UEFI)' : 'SeaBIOS'}
            />
            <InfoRow
              label={t('vmDetail.machine')}
              value={String(vm.config.machine ?? '—')}
              mono
            />
            <InfoRow label="CPU" value={cpuText} />
            {/* 基本信息里这一行问的是「配置开关」，用 agent_enabled；
                顶部那个徽标问的是「此刻能不能用」，用 agent_available */}
            <InfoRow
              label={t('vmDetail.agent')}
              value={
                <Badge
                  variant={vm.agent_enabled ? 'success' : 'neutral'}
                  dot
                  size="sm"
                >
                  {vm.agent_enabled
                    ? t('status.user.enabled')
                    : t('vmDetail.agentDisabled')}
                </Badge>
              }
            />
            <InfoRow
              label={t('vmDetail.uptime')}
              value={running ? formatUptime(vm.uptime) : t('vmDetail.notRunning')}
            />
            <InfoRow
              label={t('common.createdAt')}
              /* PVE 8 之前建的机器没有 meta，克隆出来的机器继承来源的时间 */
              title={t('vmDetail.createdTitle')}
              value={vm.created ? formatDateTime(vm.created) : '—'}
            />
            <InfoRow
              label={t('vmDetail.onboot')}
              value={vm.config.onboot ? t('common.yes') : t('common.no')}
            />
            <InfoRow
              label={t('vmDetail.tag')}
              value={<TagList tags={parseTags(vm.tags)} max={5} />}
            />
          </InfoGrid>
        </Card>
      </div>

      {/* ---- 右列：磁盘 + 网络 ----
          左列「基本信息」、右列「磁盘 + 网络」，两组各占一列，
          两列高度由 .is-balanced 拉平成一样高。 */}
      <div className="detail-column">
        <Card collapsible={false}>
          <CardHeader
            title={t('vmDetail.disks')}
            subtitle={t('vmDetail.disksSubtitle', {
              count: vm.disks.length,
              size: formatBytes(diskTotal, 0),
            })}
            icon={<IconDisk size={16} />}
          />
          {vm.disks.length === 0 ? (
            <EmptyState title={t('vmDetail.noDisks')} compact />
          ) : (
            <div className="flex flex-col">
              {vm.disks.map((d) => (
                <div className="hw-item" key={d.key}>
                  <div className="hw-item-main">
                    <span className="hw-item-icon">
                      <IconDisk size={15} />
                    </span>
                    <div className="hw-item-text">
                      <span className="hw-item-label">{d.key}</span>
                      <span className="hw-item-value">
                        {formatBytes(parseSizeToBytes(d.size))} · {d.storage}
                        {d.format ? ` · ${d.format}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card collapsible={false}>
          <CardHeader
            title={t('vmDetail.network')}
            subtitle={t('vmDetail.nicCount', { count: vm.networks.length })}
            icon={<IconNetwork size={16} />}
          />
          {vm.networks.length === 0 ? (
            <EmptyState title={t('vmDetail.noNics')} compact />
          ) : (
            <div className="flex flex-col">
              {vm.networks.map((n) => {
                const name = nicKey(n);
                const ipcfg = parseIpconfig(vm.config[`ipconfig${name.replace(/\D/g, '')}`]);
                const ipStatic = ipcfg.ip && ipcfg.ip.toLowerCase() !== 'dhcp';
                const vlan = n.vlan_tag ?? n.tag;
                return (
                  <div className="hw-item" key={name || n.macaddr}>
                    <div className="hw-item-main">
                      <span className="hw-item-icon">
                        <IconNetwork size={15} />
                      </span>
                      <div className="hw-item-text">
                        <span className="hw-item-label">{name || t('vmDetail.nic')}</span>
                        <span className="hw-item-value">
                          {n.model ?? '—'} · {n.bridge ?? t('vmDetail.noBridge')}
                          {vlan ? ` · VLAN ${vlan}` : ''}
                        </span>
                        {n.macaddr ? (
                          <span className="fs-xs text-muted mono">{n.macaddr}</span>
                        ) : null}
                        <span className="fs-xs text-muted">
                          {ipStatic
                            ? `${t('vmDetail.ipStatic', { ip: ipcfg.ip })}${
                                ipcfg.gateway
                                  ? t('vmDetail.ipGateway', {
                                      gateway: ipcfg.gateway,
                                    })
                                  : ''
                              }`
                            : t('vmDetail.ipDhcp')}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Guest Agent 网卡信息（容错） */}
          {vm.agent_available && (vm.agent_interfaces?.length ?? 0) > 0 ? (
            <div className="mt-16">
              <div className="wizard-section-title">{t('vmDetail.agentNics')}</div>
              <div className="flex flex-col">
                {vm.agent_interfaces?.map((iface) => (
                  <div className="hw-item" key={iface.name}>
                    <div className="hw-item-main">
                      <div className="hw-item-text">
                        <span className="hw-item-label">{iface.name}</span>
                        <span className="hw-item-value mono">
                          {iface.ip_addresses?.map((a) => a.ip_address).join(', ') ||
                            t('vmDetail.noAddress')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      {/* ---- 最近任务：跨两列 ----
          表格放全宽才好读，也不会像挤在半列里那样把一边拉得老长。 */}
      <Card padded={false} className="detail-full">
        <div style={{ padding: '18px 18px 0' }}>
          <CardHeader title={t('vmDetail.recentTasks')} icon={<IconRefresh size={16} />} />
        </div>
        <Table<TaskInfo>
          columns={taskColumns}
          rows={tasks}
          rowKey={(t) => t.upid}
          loading={tasksLoading}
          caption={t('vmDetail.recentTasksCaption', { vmid: vm.vmid })}
          emptyTitle={t('vmDetail.noTasks')}
          emptyDescription={t('vmDetail.noTasksDesc')}
          dense
          className="table-flush"
        />
      </Card>
    </div>
  );
}

/* ==========================================================================
   硬件 Tab
   ========================================================================== */

function HardwareTab({
  vm,
  node,
  vmid,
  onChanged,
}: {
  vm: VmDetailType;
  node: string;
  vmid: number;
  onChanged: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const toast = useToast();
  const { canWrite } = useAuth();

  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [resizeDisk, setResizeDisk] = useState<string | null>(null);
  const [resizeValue, setResizeValue] = useState('');
  const [busy, setBusy] = useState(false);
  /* 网卡 IP 编辑（映射 cloud-init 的 ipconfigN） */
  const [ipEditNet, setIpEditNet] = useState<string | null>(null);
  const [ipValue, setIpValue] = useState('dhcp');
  const [gwValue, setGwValue] = useState('');
  /* 硬件增删：新增走弹窗（要挑存储池 / 网桥），卸载走二次确认 */
  const [addDiskOpen, setAddDiskOpen] = useState(false);
  const [addNetOpen, setAddNetOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HardwareRemoveTarget | null>(
    null,
  );

  const storagesQuery = useQuery({
    queryKey: ['storages', node],
    queryFn: () => storagesApi.list(node),
    staleTime: 60_000,
  });

  const storageOptions = useMemo(
    () => [
      { label: t('vmDetail.selectStorage'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter((s) => s.active)
        .map((s) => ({ label: `${s.storage} (${s.type})`, value: s.storage })),
    ],
    [storagesQuery.data, t],
  );

  /* 新增磁盘只能落在支持 images 内容的存储池上（ISO / 备份池放不了磁盘） */
  const diskStorageOptions = useMemo(
    () => [
      { label: t('vmDetail.selectStorage'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active &&
            s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
        )
        .map((s) => ({ label: `${s.storage} (${s.type})`, value: s.storage })),
    ],
    [storagesQuery.data, t],
  );

  /* ---- 保存通用配置 ---- */
  const saveConfig = async (key: string, value: string) => {
    setBusy(true);
    try {
      const numericKeys = ['memory', 'cores', 'sockets', 'balloon', 'cpuunits'];
      const payload: Record<string, string | number> =
        numericKeys.includes(key) && /^\d+$/.test(value)
          ? { [key]: Number(value) }
          : { [key]: value };

      await runner.run(vmsApi.updateConfig(node, vmid, payload), {
        title: t('vmDetail.editConfigTask', { key }),
        node,
        invalidate: [['vm', node, vmid], ['vms']],
      });
      setEditKey(null);
      onChanged();
    } catch {
      /* toast 已处理 */
    } finally {
      setBusy(false);
    }
  };

  /* ---- 保存网卡 IP（写入 ipconfigN）---- */
  const saveNicIp = async () => {
    if (!ipEditNet) return;
    const ip = ipValue.trim();
    if (ip && ip.toLowerCase() !== 'dhcp' && !ip.includes('/')) {
      toast.warning(t('vmDetail.formatInvalid'), t('vmDetail.ipCidr'));
      return;
    }
    const idx = ipEditNet.replace(/\D/g, '');
    setBusy(true);
    try {
      await runner.run(
        vmsApi.updateConfig(node, vmid, {
          [`ipconfig${idx}`]: buildIpconfig(ip, gwValue),
        }),
        {
          title: t('vmDetail.editNicIpTask', { nic: ipEditNet }),
          node,
          invalidate: [['vm', node, vmid], ['vms']],
        },
      );
      setIpEditNet(null);
      onChanged();
    } catch {
      /* toast 已处理 */
    } finally {
      setBusy(false);
    }
  };

  /* ---- 磁盘扩容 ---- */
  const doResize = async () => {
    if (!resizeDisk) return;
    const size = resizeValue.trim().toUpperCase();
    if (!/^\d+(\.\d+)?[KMGT]?$/.test(size)) {
      toast.warning(t('vmDetail.formatInvalid'), t('vmDetail.resizeFormat'));
      return;
    }
    setBusy(true);
    try {
      await runner.run(
        vmsApi.resize(node, vmid, {
          disk: resizeDisk,
          size: /[KMGT]$/.test(size) ? size : `${size}G`,
        }),
        {
          title: t('vmDetail.resizeTask', { disk: resizeDisk }),
          node,
          invalidate: [['vm', node, vmid], ['vms'], ['storages']],
        },
      );
      setResizeDisk(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /* ---- 磁盘迁移存储 ---- */
  const doMove = async (disk: string, storage: string) => {
    setBusy(true);
    try {
      await runner.run(
        vmsApi.move(node, vmid, { disk, storage, delete_source: true }),
        {
          title: t('vmDetail.moveTask', { disk, storage }),
          node,
          invalidate: [['vm', node, vmid], ['vms'], ['storages']],
        },
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /* ---- 新增磁盘 / 网卡 ---- */
  const doAddDisk = async (body: VmAddDiskRequest) => {
    setBusy(true);
    try {
      await runner.run(vmsApi.addDisk(node, vmid, body), {
        title: t('vmDetail.addDiskTask', { size: body.size }),
        node,
        invalidate: [['vm', node, vmid], ['vms'], ['storages']],
      });
      setAddDiskOpen(false);
      onChanged();
    } catch {
      /* toast 已处理 */
    } finally {
      setBusy(false);
    }
  };

  const doAddNetwork = async (body: VmAddNetworkRequest) => {
    setBusy(true);
    try {
      await runner.run(vmsApi.addNetwork(node, vmid, body), {
        title: t('vmDetail.addNicTask', { bridge: body.bridge }),
        node,
        invalidate: [['vm', node, vmid], ['vms']],
      });
      setAddNetOpen(false);
      onChanged();
    } catch {
      /* toast 已处理 */
    } finally {
      setBusy(false);
    }
  };

  /* ---- 卸掉一件硬件 ---- */
  const doRemoveHardware = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await runner.run(vmsApi.removeHardware(node, vmid, removeTarget.key), {
        title: t('vmDetail.removeTask', { key: removeTarget.key }),
        node,
        invalidate: [['vm', node, vmid], ['vms'], ['storages']],
      });
      setRemoveTarget(null);
      onChanged();
    } catch {
      /* toast 已处理 */
    } finally {
      setBusy(false);
    }
  };

  const canEdit = canWrite && !busy;

  const configValue = (key: string): string => {
    const v = vm.config[key];
    return v === undefined || v === null ? '' : String(v);
  };

  return (
    <div className="detail-columns">
      <div className="detail-column">
        <Card>
          <CardHeader title={t('vmDetail.cpuMem')} icon={<IconCpu size={16} />} />
          <div className="flex flex-col">
            <HwRow
              label="cpu"
              title={t('vmDetail.hwCpuType')}
              value={String(vm.config.cpu ?? 'kvm64')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('cpu');
                setEditValue(configValue('cpu'));
              }}
            />
            <HwRow
              label="cores"
              title={t('vmDetail.hwCores')}
              value={t('vmDetail.hwCoresValue', { count: vm.config.cores ?? 1 })}
              editable={canEdit}
              onEdit={() => {
                setEditKey('cores');
                setEditValue(configValue('cores'));
              }}
            />
            <HwRow
              label="sockets"
              title={t('vmDetail.hwSockets')}
              value={t('vmDetail.hwSocketsValue', {
                count: vm.config.sockets ?? 1,
              })}
              editable={canEdit}
              onEdit={() => {
                setEditKey('sockets');
                setEditValue(configValue('sockets'));
              }}
            />
            <HwRow
              label="memory"
              title={t('vmDetail.hwMemory')}
              value={formatBytes(Number(vm.config.memory ?? 0) * 1024 ** 2)}
              editable={canEdit}
              onEdit={() => {
                setEditKey('memory');
                setEditValue(configValue('memory'));
              }}
              hint={t('vmDetail.hintMemory')}
            />
            <HwRow
              label="balloon"
              title={t('vmDetail.hwBalloon')}
              value={
                vm.config.balloon
                  ? formatBytes(Number(vm.config.balloon) * 1024 ** 2)
                  : t('vmDetail.unset')
              }
              editable={canEdit}
              onEdit={() => {
                setEditKey('balloon');
                setEditValue(configValue('balloon'));
              }}
            />
            <HwRow
              label="numa"
              title={t('vmDetail.hwNuma')}
              value={Number(vm.config.numa) === 1 ? t('vmDetail.enabled') : t('vmDetail.disabled')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('numa');
                setEditValue(configValue('numa'));
              }}
              hint={t('vmDetail.hintNuma')}
            />
            <HwRow
              label="affinity"
              title={t('vmDetail.hwAffinity')}
              value={String(vm.config.affinity ?? t('vmDetail.hwAffinityValue'))}
              editable={canEdit}
              onEdit={() => {
                setEditKey('affinity');
                setEditValue(configValue('affinity'));
              }}
              hint={t('vmDetail.hintAffinity')}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title={t('vmDetail.firmware')} icon={<IconVm size={16} />} />
          <div className="flex flex-col">
            <HwRow
              label="bios"
              title="BIOS"
              value={String(vm.config.bios ?? 'seabios')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('bios');
                setEditValue(configValue('bios'));
              }}
            />
            <HwRow
              label="machine"
              title={t('vmDetail.hwMachine')}
              value={String(vm.config.machine ?? 'pc')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('machine');
                setEditValue(configValue('machine'));
              }}
            />
            <HwRow
              label="scsihw"
              title={t('vmDetail.hwScsihw')}
              value={String(vm.config.scsihw ?? '—')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('scsihw');
                setEditValue(configValue('scsihw'));
              }}
            />
            <HwRow
              label="boot"
              title={t('vmDetail.hwBoot')}
              value={String(vm.config.boot ?? vm.config.bootdisk ?? '—')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('boot');
                setEditValue(configValue('boot'));
              }}
            />
            <HwRow
              label="efidisk0"
              title={t('vmDetail.hwEfi')}
              value={String(vm.config.efidisk0 ?? t('vmDetail.unsetCfg'))}
              editable={canEdit}
              onEdit={() => {
                setEditKey('efidisk0');
                setEditValue(configValue('efidisk0'));
              }}
              hint={t('vmDetail.hintEfi')}
            />
            <HwRow
              label="tpmstate0"
              title={t('vmDetail.hwTpm')}
              value={String(vm.config.tpmstate0 ?? t('vmDetail.unsetCfg'))}
              editable={canEdit}
              onEdit={() => {
                setEditKey('tpmstate0');
                setEditValue(configValue('tpmstate0'));
              }}
              hint={t('vmDetail.hintTpm')}
            />
            <HwRow
              label="ostype"
              title={t('vmDetail.hwOstype')}
              value={ostypeLabel(String(vm.config.ostype ?? ''), tStatic)}
              editable={false}
            />
          </div>
        </Card>
      </div>

      <div className="detail-column">
        <Card>
          <CardHeader
            title={t('vmDetail.disks')}
            subtitle={t('vmDetail.disksSubtitleShort', { count: vm.disks.length })}
            icon={<IconDisk size={16} />}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setAddDiskOpen(true)}
                disabled={!canEdit}
              >
                {t('vmDetail.addDisk')}
              </Button>
            }
          />
          {vm.disks.length === 0 ? (
            <EmptyState title={t('vmDetail.noDisks')} compact />
          ) : (
            <div className="flex flex-col">
              {vm.disks.map((d, i) => {
                const name = diskKey(d);
                return (
                  <div className="hw-item" key={name || `disk-${i}`}>
                    <div className="hw-item-main">
                      <span className="hw-item-icon">
                        <IconDisk size={15} />
                      </span>
                      <div className="hw-item-text">
                        <span className="hw-item-label">{name || t('vmDetail.hwDisk')}</span>
                        <span className="hw-item-value">
                          {formatBytes(parseSizeToBytes(d.size))} · {d.storage}
                          {d.format ? ` · ${d.format}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="hw-item-actions">
                      <IconButton
                        label={t('vmDetail.resizeDiskAria', {
                          disk: name || t('vmDetail.hwDisk'),
                        })}
                        onClick={() => {
                          setResizeDisk(name);
                          setResizeValue((d.size || '').replace(/[^0-9.GTKM]/gi, '') || '');
                        }}
                        disabled={!canEdit}
                      >
                        <IconPlus size={15} />
                      </IconButton>
                      <Select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) void doMove(name, e.target.value);
                        }}
                        options={[
                          { label: t('vmDetail.moveTo'), value: '' },
                          ...(storagesQuery.data ?? [])
                            .filter((s) => s.active && s.storage !== d.storage)
                            .map((s) => ({ label: s.storage, value: s.storage })),
                        ]}
                        disabled={!canEdit}
                        aria-label={t('vmDetail.moveDiskAria', {
                          disk: name || t('vmDetail.hwDisk'),
                        })}
                        style={{ width: 110, height: 28, fontSize: 12 }}
                      />
                      <IconButton
                        label={t('vmDetail.removeDiskAria', {
                          disk: name || t('vmDetail.hwDisk'),
                        })}
                        variant="danger"
                        disabled={!canEdit || !name}
                        onClick={() =>
                          setRemoveTarget({
                            key: name,
                            title: `${name}（${formatBytes(
                              parseSizeToBytes(d.size),
                            )} · ${d.storage}）`,
                            detail: t('vmDetail.removeDiskDetail'),
                          })
                        }
                      >
                        <IconTrash size={15} />
                      </IconButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title={t('vmDetail.nicCard')}
            subtitle={t('vmDetail.nicCountShort', { count: vm.networks.length })}
            icon={<IconNetwork size={16} />}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setAddNetOpen(true)}
                disabled={!canEdit}
              >
                {t('vmDetail.addNic')}
              </Button>
            }
          />
          {vm.networks.length === 0 ? (
            <EmptyState title={t('vmDetail.noNics')} compact />
          ) : (
            <div className="flex flex-col">
              {vm.networks.map((n) => {
                const name = nicKey(n);
                const idx = name.replace(/\D/g, '');
                const ipcfg = parseIpconfig(vm.config[`ipconfig${idx}`]);
                const ipStatic = ipcfg.ip && ipcfg.ip.toLowerCase() !== 'dhcp';
                const vlan = n.vlan_tag ?? n.tag;
                const ipLabel = ipStatic
                  ? `${t('vmDetail.ipStatic', { ip: ipcfg.ip })}${
                      ipcfg.gateway
                        ? t('vmDetail.ipGateway', { gateway: ipcfg.gateway })
                        : ''
                    }`
                  : t('vmDetail.ipDhcp');
                const nicName = name || t('vmDetail.nic');
                return (
                  <HwRow
                    key={name || n.macaddr}
                    label={nicName}
                    title={`${nicName} (${n.model ?? '—'})`}
                    value={`${n.bridge ?? t('vmDetail.noBridge')}${
                      vlan ? ` · VLAN ${vlan}` : ''
                    }${n.firewall ? t('vmDetail.nicFirewall') : ''}`}
                    hint={`${n.macaddr ? `${n.macaddr} · ` : ''}${ipLabel}`}
                    editable={canEdit}
                    onEdit={() => {
                      setEditKey(name);
                      setEditValue(String(vm.config[name] ?? ''));
                    }}
                    onRemove={() =>
                      setRemoveTarget({
                        key: name,
                        title: `${name}（${n.model ?? '—'} · ${
                          n.bridge ?? t('vmDetail.noBridge')
                        }${vlan ? ` · VLAN ${vlan}` : ''}）`,
                        detail: t('vmDetail.removeNicDetail', { idx }),
                      })
                    }
                    extraActions={
                      <IconButton
                        label={t('vmDetail.editNicIpAria', { nic: nicName })}
                        onClick={() => {
                          setIpEditNet(name);
                          setIpValue(ipcfg.ip || 'dhcp');
                          setGwValue(ipcfg.gateway);
                        }}
                        disabled={!canEdit}
                      >
                        <IconNetwork size={15} />
                      </IconButton>
                    }
                  />
                );
              })}
            </div>
          )}
        </Card>

        {/* CD-ROM / ISO */}
        <Card>
          <CardHeader title={t('vmDetail.cdrom')} icon={<IconDisk size={16} />} />
          <div className="flex flex-col">
            {Object.keys(vm.config)
              .filter((k) => /^(ide|sata)\d+$/.test(k) && k !== vm.config.bootdisk)
              .map((k) => (
                <HwRow
                  key={k}
                  label={k}
                  title={t('vmDetail.cdromLabel', { key: k })}
                  value={String(vm.config[k] ?? '—')}
                  editable={canEdit}
                  onEdit={() => {
                    setEditKey(k);
                    setEditValue(configValue(k));
                  }}
                  onRemove={() =>
                    setRemoveTarget({
                      key: k,
                      title: t('vmDetail.cdromLabel', { key: k }),
                      detail: t('vmDetail.removeCdromDetail'),
                    })
                  }
                />
              ))}
            {Object.keys(vm.config).filter((k) => /^(ide|sata)\d+$/.test(k)).length ===
            0 ? (
              <EmptyState title={t('vmDetail.noCdrom')} compact />
            ) : null}
          </div>
        </Card>
      </div>

      {/* ---- 编辑配置 Modal ---- */}
      <EditConfigModal
        configKey={editKey}
        value={editValue}
        onValueChange={setEditValue}
        onClose={() => setEditKey(null)}
        onSave={() => {
          if (editKey) void saveConfig(editKey, editValue);
        }}
        busy={busy}
        node={node}
        storageOptions={storageOptions}
        currentConfig={vm.config}
      />

      {/* ---- 网卡 IP Modal ---- */}
      <Modal
        open={Boolean(ipEditNet)}
        onClose={() => setIpEditNet(null)}
        title={t('vmDetail.nicIpTitle', { nic: ipEditNet ?? '' })}
        description={t('vmDetail.nicIpDesc')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIpEditNet(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={saveNicIp} loading={busy}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label={t('vmDetail.nicIpLabel')}
            value={ipValue}
            onChange={(e) => setIpValue(e.target.value)}
            placeholder={t('vmDetail.nicIpPlaceholder')}
            mono
            autoFocus
            hint={t('vmDetail.nicIpHint')}
          />
          <Input
            label={t('vmDetail.gateway')}
            value={gwValue}
            onChange={(e) => setGwValue(e.target.value)}
            placeholder={t('vmDetail.gatewayPlaceholder')}
            mono
            disabled={ipValue.trim().toLowerCase() === 'dhcp'}
            hint={t('vmDetail.gatewayHint')}
          />
          <Notice tone="info" title={t('vmDetail.nicIpNoticeTitle')}>
            {t('vmDetail.nicIpNoticeDesc', {
              idx: ipEditNet?.replace(/\D/g, '') ?? '',
            })}
          </Notice>
        </div>
      </Modal>

      {/* ---- 磁盘扩容 Modal ---- */}
      <Modal
        open={Boolean(resizeDisk)}
        onClose={() => setResizeDisk(null)}
        title={t('vmDetail.resizeTitle')}
        description={t('vmDetail.resizeDesc', { disk: resizeDisk ?? '' })}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResizeDisk(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={doResize} loading={busy}>
              {t('vmDetail.resizeConfirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label={t('vmDetail.resizeLabel')}
            required
            value={resizeValue}
            onChange={(e) => setResizeValue(e.target.value)}
            placeholder={t('vmDetail.resizePlaceholder')}
            autoFocus
            hint={t('vmDetail.resizeHint')}
          />
          <Notice tone="warning" title={t('vmDetail.resizeNoticeTitle')}>
            {t('vmDetail.resizeNoticeDesc')}
          </Notice>
        </div>
      </Modal>

      {/* ---- 新增磁盘 / 网卡 ---- */}
      <AddDiskModal
        open={addDiskOpen}
        storageOptions={diskStorageOptions}
        busy={busy}
        onClose={() => setAddDiskOpen(false)}
        onSubmit={(body) => void doAddDisk(body)}
      />

      <AddNetworkModal
        open={addNetOpen}
        node={node}
        busy={busy}
        onClose={() => setAddNetOpen(false)}
        onSubmit={(body) => void doAddNetwork(body)}
      />

      {/* ---- 移除硬件 ---- */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void doRemoveHardware()}
        title={t('vmDetail.removeHwTitle')}
        danger
        confirmText={t('vmDetail.removeHwConfirm')}
        loading={busy}
        message={
          <>
            {t('vmDetail.removeHwSoon')}{' '}
            <strong>{removeTarget?.title}</strong>
            {removeTarget?.detail ? <> {removeTarget.detail}</> : null}
          </>
        }
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   新增磁盘
   --------------------------------------------------------------------------- */

function AddDiskModal({
  open,
  storageOptions,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  storageOptions: Array<{ label: string; value: string }>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: VmAddDiskRequest) => void;
}) {
  const t = useT();
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('20');
  const [format, setFormat] = useState('raw');
  /* discard 默认开启：SSD 与精简置备存储靠它回收客户机里已删除文件的块，
     不开的话存储侧的空间只涨不跌，久了会出现「看着快满了、其实大部分是垃圾」。
     关掉的场景（机械盘、或对 TRIM 敏感的业务）是少数，真需要关手动关掉即可。 */
  const [discard, setDiscard] = useState(true);
  const [ssd, setSsd] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /* 每次打开都复位，别把上一次的选择带进来 */
  useEffect(() => {
    if (!open) return;
    setStorage('');
    setSize('20');
    setFormat('qcow2');
    // 复位回默认开启，别把上一次「关掉」的选择带进下一次
    setDiscard(true);
    setSsd(false);
    setErrors({});
  }, [open]);

  const submit = () => {
    const next: Record<string, string> = {};
    const gb = Number(size.trim());
    if (!storage) next.storage = t('vmDetail.selectStorage');
    if (!Number.isFinite(gb) || gb <= 0) next.size = t('vmDetail.addDiskSizeMin');
    else if (gb > 8192) next.size = t('vmDetail.addDiskSizeMax');
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({ storage, size: Math.floor(gb), format, discard, ssd });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('vmDetail.addDisk')}
      description={t('vmDetail.addDiskDesc')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {t('vmDetail.addDiskSubmit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Field label={t('vmDetail.addDiskStorage')} required error={errors.storage}>
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
          />
        </Field>
        <Input
          label={t('vmDetail.addDiskSize')}
          required
          value={size}
          onChange={(e) => setSize(e.target.value)}
          error={errors.size}
          mono
          autoFocus
          hint={t('vmDetail.addDiskSizeHint')}
        />
        <Field
          label={t('vmDetail.addDiskFormat')}
          hint={t('vmDetail.addDiskFormatHint')}
        >
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            options={[
              { label: 'raw', value: 'raw' },
              { label: 'qcow2', value: 'qcow2' },
              { label: 'vmdk', value: 'vmdk' },
            ]}
          />
        </Field>
        <Switch
          checked={discard}
          onChange={setDiscard}
          label={t('vmDetail.addDiskDiscard')}
          hint={t('vmDetail.addDiskDiscardHint')}
        />
        <Switch
          checked={ssd}
          onChange={setSsd}
          label={t('vmDetail.addDiskSsd')}
          hint={t('vmDetail.addDiskSsdHint')}
        />
        <Notice tone="info" title={t('vmDetail.addDiskNoticeTitle')}>
          {t('vmDetail.addDiskNoticeDesc')}
        </Notice>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   新增网卡
   --------------------------------------------------------------------------- */

function AddNetworkModal({
  open,
  node,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  node: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: VmAddNetworkRequest) => void;
}) {
  const t = useT();
  const [bridge, setBridge] = useState('vmbr0');
  const [model, setModel] = useState('virtio');
  const [vlan, setVlan] = useState('');
  const [firewall, setFirewall] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /* 节点上可用作网桥的网卡，与创建向导取的是同一份数据 */
  const bridgesQuery = useQuery({
    queryKey: ['nodes', node, 'network'],
    queryFn: () => nodesApi.network(node),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const bridgeOptions = useMemo(() => {
    const ifaces = bridgesQuery.data ?? [];
    const bridges = ifaces.filter(
      (i) => i.type === 'bridge' || i.type === 'OVSBridge',
    );
    const list = bridges.length > 0 ? bridges : ifaces;
    return list.map((i) => ({
      label: `${i.iface}${i.active ? '' : t('vmDetail.addNicInactive')}`,
      value: i.iface,
    }));
  }, [bridgesQuery.data, t]);

  useEffect(() => {
    if (!open) return;
    setModel('virtio');
    setVlan('');
    setFirewall(true);
    setErrors({});
  }, [open]);

  /* 网桥列表回来后，默认选中的 vmbr0 若不存在就退到第一个可用网桥；
     用户已经选了有效值时不动它。 */
  useEffect(() => {
    if (!open || bridgeOptions.length === 0) return;
    setBridge((cur) =>
      bridgeOptions.some((o) => o.value === cur) ? cur : bridgeOptions[0].value,
    );
  }, [open, bridgeOptions]);

  const submit = () => {
    const next: Record<string, string> = {};
    const tag = vlan.trim();
    if (!bridge) next.bridge = t('vmDetail.addNicBridgePlaceholder');
    if (tag && (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > 4094)) {
      next.vlan = t('vmDetail.addNicVlanInvalid');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({
      bridge,
      model,
      vlan_tag: tag ? Number(tag) : null,
      firewall,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('vmDetail.addNic')}
      description={t('vmDetail.addNicDesc')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {t('vmDetail.addNicSubmit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Field
          label={t('vmDetail.addNicBridge')}
          required
          error={errors.bridge}
          hint={
            bridgesQuery.isError
              ? t('vmDetail.addNicBridgeLoadFailed')
              : undefined
          }
        >
          <Select
            value={bridge}
            onChange={(e) => setBridge(e.target.value)}
            options={[
              ...(bridgeOptions.some((o) => o.value === bridge) || !bridge
                ? []
                : [{ label: bridge, value: bridge }]),
              ...bridgeOptions,
            ]}
            placeholder={t('vmDetail.addNicBridgePlaceholder')}
          />
        </Field>
        <Field label={t('vmDetail.addNicModel')}>
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            options={[
              { label: t('vmDetail.addNicModelVirtio'), value: 'virtio' },
              { label: 'Intel E1000', value: 'e1000' },
              { label: 'VMware vmxnet3', value: 'vmxnet3' },
              { label: 'Realtek RTL8139', value: 'rtl8139' },
            ]}
          />
        </Field>
        <Input
          label={t('vmDetail.addNicVlan')}
          value={vlan}
          onChange={(e) => setVlan(e.target.value)}
          error={errors.vlan}
          placeholder={t('vmDetail.addNicVlanPlaceholder')}
          mono
          hint={t('vmDetail.addNicVlanRange')}
        />
        <Switch
          checked={firewall}
          onChange={setFirewall}
          label={t('vmDetail.addNicFirewall')}
          hint={t('vmDetail.addNicFirewallHint')}
        />
        <Notice tone="info" title={t('vmDetail.addNicNoticeTitle')}>
          {t('vmDetail.addNicNoticeDesc')}
        </Notice>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------------- */

function HwRow({
  label,
  title,
  value,
  hint,
  editable,
  onEdit,
  onRemove,
  extraActions,
}: {
  label: string;
  title: string;
  value: string;
  hint?: string;
  editable: boolean;
  onEdit?: () => void;
  /** 传入即在右侧多一个「移除」按钮（会走二次确认） */
  onRemove?: () => void;
  extraActions?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="hw-item">
      <div className="hw-item-main">
        <div className="hw-item-text">
          <span className="hw-item-label">{label}</span>
          <span className="hw-item-value" title={title}>
            {value || '—'}
          </span>
          {hint ? <span className="fs-xs text-muted mono">{hint}</span> : null}
        </div>
      </div>
      {onEdit || onRemove || extraActions ? (
        <div className="hw-item-actions">
          {extraActions}
          {onEdit ? (
            <IconButton
              label={t('vmDetail.editHwAria', { title })}
              onClick={onEdit}
              disabled={!editable}
            >
              <IconEdit size={15} />
            </IconButton>
          ) : null}
          {onRemove ? (
            <IconButton
              label={t('vmDetail.removeHwAria', { title })}
              variant="danger"
              onClick={onRemove}
              disabled={!editable}
            >
              <IconTrash size={15} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   cloud-init ipconfigN 解析 / 生成
   --------------------------------------------------------------------------- */

function parseIpconfig(raw: unknown): { ip: string; gateway: string } {
  const text = typeof raw === 'string' ? raw : '';
  const ipMatch = text.match(/(?:^|,)\s*ip=([^,]+)/);
  const gwMatch = text.match(/(?:^|,)\s*gw=([^,]+)/);
  const ip = ipMatch ? ipMatch[1].trim() : '';
  return { ip, gateway: gwMatch ? gwMatch[1].trim() : '' };
}

function buildIpconfig(ip: string, gateway: string): string {
  const clean = ip.trim();
  if (!clean || clean.toLowerCase() === 'dhcp') return 'ip=dhcp';
  return gateway.trim() ? `ip=${clean},gw=${gateway.trim()}` : `ip=${clean}`;
}

/** 网卡名：后端可能返回 interface（net0）或 key，二者兼容。 */
function nicKey(n: { key?: string; interface?: string }): string {
  return (n.interface || n.key || '').trim();
}

/** 磁盘名：后端可能返回 interface（scsi0）或 key，二者兼容。 */
function diskKey(d: { key?: string; interface?: string }): string {
  return (d.interface || d.key || '').trim();
}

/* ---------------------------------------------------------------------------
   编辑配置 Modal（按 key 提供合适的控件）
   --------------------------------------------------------------------------- */

/** PVE 的 cpuset 写法：逗号分隔的「单核或区间」，如 0 / 0-3 / 0-3,8-11 */
const CPUSET_RE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

function EditConfigModal({
  configKey,
  value,
  onValueChange,
  onClose,
  onSave,
  busy,
  node,
  storageOptions,
  currentConfig,
}: {
  configKey: string | null;
  value: string;
  onValueChange: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  node: string;
  storageOptions: Array<{ label: string; value: string }>;
  currentConfig: Record<string, string | number | boolean | undefined>;
}) {
  const t = useT();
  if (!configKey) return null;

  /* 字段名 → 词条键。能复用硬件卡片那套标签的直接复用，不再造一批同义词 */
  const LABELS: Record<string, MessageKey> = {
    cpu: 'vmDetail.hwCpuType',
    cores: 'vmDetail.cfgCores',
    sockets: 'vmDetail.hwSockets',
    memory: 'vmDetail.cfgMemory',
    balloon: 'vmDetail.cfgBalloon',
    bios: 'vmDetail.cfgBios',
    machine: 'vmDetail.hwMachine',
    scsihw: 'vmDetail.hwScsihw',
    boot: 'vmDetail.hwBoot',
    numa: 'vmDetail.cfgNumaLabel',
    affinity: 'vmDetail.hwAffinity',
    efidisk0: 'vmDetail.hwEfi',
    tpmstate0: 'vmDetail.hwTpm',
    name: 'common.name',
    description: 'common.description',
    agent: 'vmDetail.cfgAgent',
    onboot: 'vmDetail.onboot',
  };

  /* 表里没有的键（例如 scsi1、net0）直接用原始键名 —— 它本身就是用户要看的标识 */
  const labelFor = (key: string): string => {
    const messageKey = LABELS[key];
    return messageKey ? t(messageKey) : key;
  };

  const isNumeric = ['cores', 'sockets', 'memory', 'balloon', 'cpuunits'].includes(
    configKey,
  );

  const isDiskOrNet = /^(scsi|virtio|sata|ide|net)\d+$/.test(configKey);

  const renderControl = () => {
    if (configKey === 'bios') {
      /* 固件类型与客户机的分区表 / 引导器是绑死的：改错一次就是「开机直接进
         不到系统」。值真的变了才升级成告警，否则只给一段说明。 */
      const currentBios = String(currentConfig.bios ?? 'seabios');
      const nextBios = value || 'seabios';
      const changingBios = nextBios !== currentBios;
      const hasEfiDisk = Boolean(currentConfig.efidisk0);
      return (
        <div className="flex flex-col gap-16">
          <Select
            label={labelFor('bios')}
            value={nextBios}
            onChange={(e) => onValueChange(e.target.value)}
            options={[
              { label: t('vmDetail.biosLegacy'), value: 'seabios' },
              { label: t('vmDetail.biosUefi'), value: 'ovmf' },
            ]}
          />
          {changingBios ? (
            <Notice
              tone="warning"
              title={t('vmDetail.biosSwitchTitle', {
                from: currentBios,
                to: nextBios,
              })}
            >
              {t('vmDetail.biosSwitchBody')}
              {nextBios === 'ovmf' && !hasEfiDisk
                ? t('vmDetail.biosSwitchEfiExtra')
                : ''}
            </Notice>
          ) : (
            <Notice tone="info" title={t('vmDetail.biosOvmfTitle')}>
              {t('vmDetail.biosOvmfBody')}
            </Notice>
          )}
        </div>
      );
    }

    if (configKey === 'machine') {
      /* 机型决定芯片组与 PCI 拓扑：改完之后客户机里的磁盘控制器地址会变，
         装好的系统可能找不到引导盘。同时 EFI 盘 / TPM 都要求 q35。 */
      const currentMachine = String(currentConfig.machine ?? 'pc');
      const nextMachine = value || 'pc';
      const changingMachine = nextMachine !== currentMachine;
      const needsQ35 = Boolean(currentConfig.efidisk0 || currentConfig.tpmstate0);
      return (
        <div className="flex flex-col gap-16">
          <Select
            label={labelFor('machine')}
            value={nextMachine}
            onChange={(e) => onValueChange(e.target.value)}
            options={[
              { label: 'i440fx', value: 'pc' },
              { label: 'q35', value: 'q35' },
            ]}
          />
          {changingMachine ? (
            <Notice
              tone="warning"
              title={t('vmDetail.machineSwitchTitle', {
                from: currentMachine,
                to: nextMachine,
              })}
            >
              {t('vmDetail.machineSwitchBody')}
            </Notice>
          ) : null}
          {nextMachine !== 'q35' && needsQ35 ? (
            <Notice tone="danger" title={t('vmDetail.machineQ35Title')}>
              {t('vmDetail.machineQ35Body')}
            </Notice>
          ) : null}
        </div>
      );
    }

    if (configKey === 'scsihw') {
      return (
        <Select
          label={labelFor('scsihw')}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          options={[
            { label: 'VirtIO SCSI single', value: 'virtio-scsi-single' },
            { label: 'VirtIO SCSI', value: 'virtio-scsi-pci' },
            { label: 'LSI 53C895A', value: 'lsi' },
            { label: 'MegaRAID SAS', value: 'megaraid_sas' },
          ]}
        />
      );
    }

    if (configKey === 'cpu') {
      return (
        <Select
          label={labelFor('cpu')}
          value={value || 'kvm64'}
          onChange={(e) => onValueChange(e.target.value)}
          options={[
            { label: 'host', value: 'host' },
            { label: 'kvm64', value: 'kvm64' },
            { label: 'x86-64-v2-AES', value: 'x86-64-v2-AES' },
            { label: 'x86-64-v3', value: 'x86-64-v3' },
          ]}
        />
      );
    }

    if (configKey === 'boot') {
      return (
        <Input
          label={labelFor('boot')}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={t('vmDetail.bootPlaceholder')}
          mono
          hint={t('vmDetail.bootHint')}
        />
      );
    }

    if (configKey === 'numa') {
      return (
        <Select
          label={labelFor('numa')}
          value={Number(value) === 1 ? '1' : '0'}
          onChange={(e) => onValueChange(e.target.value)}
          options={[
            { label: t('vmDetail.numaOff'), value: '0' },
            { label: t('vmDetail.numaOn'), value: '1' },
          ]}
          hint={t('vmDetail.hintNuma')}
        />
      );
    }

    if (configKey === 'affinity') {
      const bad = value.trim() !== '' && !CPUSET_RE.test(value.trim());
      return (
        <Input
          label={labelFor('affinity')}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={t('vmDetail.affinityPlaceholder')}
          mono
          error={bad ? t('vmDetail.affinityInvalid') : undefined}
          hint={t('vmDetail.affinityHint')}
        />
      );
    }

    if (configKey === 'efidisk0' || configKey === 'tpmstate0') {
      /* 这两项是 PVE 的复合值（存储:容量,参数…），既让用户手改也要有快捷生成，
         因为「加一块 EFI 盘 / TPM」最常见的做法就是挑个存储池。 */
      const isEfi = configKey === 'efidisk0';
      return (
        <div className="flex flex-col gap-16">
          <Input
            label={labelFor(configKey)}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            mono
            placeholder={
              isEfi
                ? 'local-lvm:1,efitype=4m,pre-enrolled-keys=1'
                : 'local-lvm:4,version=v2.0'
            }
            hint={isEfi ? t('vmDetail.efiHint') : t('vmDetail.tpmHint')}
          />
          <Select
            label={t('vmDetail.generateFromStorage')}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              onValueChange(
                isEfi
                  ? `${e.target.value}:1,efitype=4m,pre-enrolled-keys=1`
                  : `${e.target.value}:4,version=v2.0`,
              );
            }}
            options={storageOptions}
            hint={t('vmDetail.generateFromStorageHint')}
          />
          <Notice
            tone="warning"
            title={
              isEfi ? t('vmDetail.efiNoticeTitle') : t('vmDetail.tpmNoticeTitle')
            }
          >
            {t('vmDetail.efiTpmNoticeBody')}
          </Notice>
        </div>
      );
    }

    if (isDiskOrNet) {
      /* 磁盘 / 网卡：附加存储池选择 */
      return (
        <div className="flex flex-col gap-16">
          <Input
            label={t('vmDetail.keyConfig', { key: configKey })}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            mono
            hint={
              /^net/.test(configKey)
                ? t('vmDetail.keyHintNet')
                : t('vmDetail.keyHintDisk')
            }
          />
          {/^(scsi|virtio|sata|ide)/.test(configKey) ? (
            <Select
              label={t('vmDetail.changeStorage')}
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const parts = value.split(',');
                const sizeIdx = parts.findIndex((p) => p.startsWith('size='));
                const size = sizeIdx >= 0 ? parts[sizeIdx] : 'size=20G';
                onValueChange(`${e.target.value}:vm-0-disk-0,${size}`);
              }}
              options={storageOptions}
              hint={t('vmDetail.changeStorageHint', {
                storage: value.split(':')[0] || '—',
                node,
              })}
            />
          ) : null}
        </div>
      );
    }

    if (isNumeric) {
      return (
        <Input
          label={labelFor(configKey)}
          type="number"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          mono
          autoFocus
        />
      );
    }

    return (
      <Input
        label={labelFor(configKey)}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        mono
        hint={t('vmDetail.currentValue', {
          value: String(currentConfig[configKey] ?? '—'),
        })}
        autoFocus
      />
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('vmDetail.cfgModalTitle', { key: configKey })}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={onSave} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        {renderControl()}
        <Notice tone="info">{t('vmDetail.cfgModalNotice')}</Notice>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   快照 Tab
   ========================================================================== */

function SnapshotsTab({
  vm,
  node,
  vmid,
}: {
  vm: VmDetailType;
  node: string;
  vmid: number;
}) {
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const t = useT();
  const { canWrite } = useAuth();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [vmstate, setVmstate] = useState(isRunning(vm.status));
  const [rollbackTarget, setRollbackTarget] = useState<Snapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const snapQuery = useQuery({
    queryKey: ['snapshots', node, vmid],
    queryFn: () => vmsApi.snapshots(node, vmid),
    staleTime: 15_000,
  });

  /* Proxmox 会返回一个名为 "current" 的特殊条目，需过滤 */
  const snapshots = useMemo(
    () => (snapQuery.data ?? []).filter((s) => s.name !== 'current'),
    [snapQuery.data],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['snapshots', node, vmid] });
    void queryClient.invalidateQueries({ queryKey: ['vm', node, vmid] });
  };

  const create = async () => {
    if (!name.trim()) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return;
    setBusy(true);
    try {
      await runner.run(
        vmsApi.createSnapshot(node, vmid, {
          name: name.trim(),
          description: description || undefined,
          vmstate,
        }),
        {
          title: t('vmDetail.snapCreateTask', { name }),
          node,
          invalidate: [['snapshots', node, vmid], ['vm', node, vmid]],
        },
      );
      setCreateOpen(false);
      setName('');
      setDescription('');
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<Snapshot>> = [
    {
      key: 'name',
      header: t('vmDetail.snapColName'),
      render: (s) => <span className="fw-500 mono">{s.name}</span>,
      sortable: true,
      sortValue: (s) => s.name,
    },
    {
      key: 'description',
      header: t('common.description'),
      render: (s) => (
        <span className="fs-sm text-secondary">{s.description || '—'}</span>
      ),
    },
    {
      key: 'snaptime',
      header: t('vmDetail.snapColCreated'),
      render: (s) => <span className="fs-sm mono">{formatDateTime(s.snaptime)}</span>,
      width: 160,
      sortable: true,
      sortValue: (s) => s.snaptime ?? 0,
    },
    {
      key: 'vmstate',
      header: t('vmDetail.snapColVmstate'),
      width: 88,
      align: 'center',
      render: (s) => (
        <Badge variant={s.vmstate ? 'info' : 'neutral'} size="sm">
          {s.vmstate ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'parent',
      header: t('vmDetail.snapColParent'),
      render: (s) => (
        <span className="fs-sm text-muted mono">{s.parent || '—'}</span>
      ),
      width: 140,
    },
    {
      key: 'actions',
      header: t('vmDetail.snapColActions'),
      width: 150,
      align: 'right',
      render: (s) => (
        <span className="row-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRollbackTarget(s)}
            disabled={!canWrite || busy}
          >
            {t('vmDetail.snapRollback')}
          </Button>
          <IconButton
            label={t('vmDetail.snapDeleteAria', { name: s.name })}
            variant="danger"
            onClick={() => setDeleteTarget(s)}
            disabled={!canWrite || busy}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  return (
    <>
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
            <IconSnapshot size={16} />
            <span className="fw-600">{t('vmDetail.tab.snapshots')}</span>
            <Badge variant="neutral" size="sm">
              {snapshots.length}
            </Badge>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlus size={14} />}
            onClick={() => setCreateOpen(true)}
            disabled={!canWrite}
          >
            {t('vmDetail.snapCreate')}
          </Button>
        </div>

        <Table<Snapshot>
          columns={columns}
          rows={snapshots}
          rowKey={(s) => s.name}
          loading={snapQuery.isLoading}
          caption={t('vmDetail.snapCaption', { vmid })}
          emptyTitle={t('vmDetail.snapEmpty')}
          emptyDescription={t('vmDetail.snapEmptyDesc')}
          className="table-flush"
        />
      </Card>

      {/* 新建快照 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('vmDetail.snapCreate')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={create}
              loading={busy}
              disabled={!name.trim()}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label={t('vmDetail.snapColName')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('vmDetail.snapNamePlaceholder')}
            autoFocus
            error={
              name && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)
                ? t('vmDetail.snapNameRule')
                : undefined
            }
          />
          <Input
            label={t('common.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('vmDetail.snapDescPlaceholder')}
          />
          <Checkbox
            checked={vmstate}
            onChange={(e) => setVmstate(e.target.checked)}
            label={t('vmDetail.snapIncludeState')}
          />
        </div>
      </Modal>

      {/* 回滚确认 */}
      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={async () => {
          if (!rollbackTarget) return;
          setBusy(true);
          try {
            await runner.run(
              vmsApi.rollbackSnapshot(node, vmid, rollbackTarget.name),
              {
                title: t('vmDetail.snapRollbackTask', {
                  name: rollbackTarget.name,
                }),
                node,
                invalidate: [['snapshots', node, vmid], ['vm', node, vmid]],
                destructive: true,
              },
            );
            setRollbackTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('vmDetail.snapRollbackTitle')}
        confirmText={t('vmDetail.snapRollbackConfirm')}
        loading={busy}
        requireText={rollbackTarget?.name}
        message={
          <>
            {t('vmDetail.snapRollbackBodyPre')}
            <strong>{rollbackTarget?.name}</strong>
            {t('vmDetail.snapRollbackBodyTail')}
          </>
        }
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await runner.run(vmsApi.deleteSnapshot(node, vmid, deleteTarget.name), {
              title: t('vmDetail.snapDeleteTask', { name: deleteTarget.name }),
              node,
              invalidate: [['snapshots', node, vmid], ['vm', node, vmid]],
              destructive: true,
            });
            setDeleteTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('vmDetail.snapDeleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        message={
          <>
            {t('vmDetail.snapDeleteBodyPre')}
            <strong>{deleteTarget?.name}</strong>
            {t('vmDetail.snapDeleteBodyTail')}
          </>
        }
      />
    </>
  );
}

/* ==========================================================================
   备份 Tab
   ========================================================================== */

function BackupsTab({
  vm,
  node,
  vmid,
}: {
  vm: VmDetailType;
  node: string;
  vmid: number;
}) {
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const toast = useToast();
  const t = useT();
  const { canWrite } = useAuth();

  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null);
  const [busy, setBusy] = useState(false);

  /* 备份表单 */
  const [storage, setStorage] = useState('');
  const [mode, setMode] = useState('snapshot');
  const [compress, setCompress] = useState('zstd');
  const [notes, setNotes] = useState('');

  /* 恢复表单 */
  const [restoreVmid, setRestoreVmid] = useState('');
  const [restoreStorage, setRestoreStorage] = useState('');
  const [restoreStart, setRestoreStart] = useState(false);
  const [restoreForce, setRestoreForce] = useState(false);

  const backupsQuery = useQuery({
    queryKey: ['backups', node, vmid],
    queryFn: () => backupsApi.list({ vmid }),
    staleTime: 20_000,
    retry: false,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', node],
    queryFn: () => storagesApi.list(node),
    staleTime: 60_000,
  });

  const backupStorages = useMemo(
    () =>
      (storagesQuery.data ?? []).filter(
        (s) => s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'backup'),
      ),
    [storagesQuery.data],
  );

  const storageOptions = useMemo(
    () => [
      { label: t('vmDetail.selectStorage'), value: '' },
      ...backupStorages.map((s) => ({
        label: t('vmDetail.backupStorageAvail', {
          storage: s.storage,
          avail: formatBytes(s.avail),
        }),
        value: s.storage,
      })),
    ],
    [backupStorages, t],
  );

  /* 默认选中第一个备份存储 */
  useEffect(() => {
    if (!storage && backupStorages[0]) setStorage(backupStorages[0].storage);
  }, [backupStorages, storage]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
    void queryClient.invalidateQueries({ queryKey: ['storages'] });
  };

  const runBackup = async () => {
    if (!storage) {
      toast.warning(t('vmDetail.selectStorage'));
      return;
    }
    setBusy(true);
    try {
      await runner.run(
        backupsApi.create({
          node,
          vmid,
          storage,
          mode: mode as 'snapshot' | 'suspend' | 'stop',
          compress,
          notes: notes || undefined,
        }),
        {
          title: t('vmDetail.backupTask', { name: vm.name || vmid }),
          node,
          invalidate: [['backups'], ['storages'], ['cluster']],
        },
      );
      setBackupOpen(false);
      setNotes('');
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<BackupItem>> = [
    {
      key: 'volid',
      header: t('vmDetail.backupColFile'),
      render: (b) => (
        <span className="mono fs-sm" title={b.volid}>
          {b.volid.split('/').pop() ?? b.volid}
        </span>
      ),
    },
    {
      key: 'ctime',
      header: t('vmDetail.snapColCreated'),
      render: (b) => <span className="fs-sm mono">{formatDateTime(b.ctime)}</span>,
      width: 160,
      sortable: true,
      sortValue: (b) => b.ctime,
    },
    {
      key: 'size',
      header: t('vmDetail.backupColSize'),
      render: (b) => <span className="mono fs-sm">{formatBytes(b.size)}</span>,
      width: 100,
      align: 'right',
      sortable: true,
      sortValue: (b) => b.size,
    },
    {
      key: 'format',
      header: t('vmDetail.backupColFormat'),
      render: (b) => (
        <Badge variant="neutral" size="sm">
          {b.format}
        </Badge>
      ),
      width: 90,
    },
    {
      key: 'notes',
      header: t('vmDetail.backupColNote'),
      render: (b) => (
        <span className="fs-sm text-secondary truncate" title={b.notes}>
          {b.notes || '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('vmDetail.snapColActions'),
      width: 176,
      align: 'right',
      render: (b) => (
        <span className="row-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setRestoreTarget(b);
              setRestoreVmid(String(b.vmid));
              setRestoreStorage('');
              setRestoreStart(false);
              setRestoreForce(false);
            }}
            disabled={!canWrite || busy}
          >
            {t('vmDetail.backupRestore')}
          </Button>
          <IconButton
            label={t('vmDetail.backupDownload')}
            onClick={() => {
              /* 宿主机上的路径由「存储路径 + 归档名」拼出，缺存储信息就下不了。
                 连接不用带：下载链接是浏览器直接打开的，带不了请求头，后端会按
                 节点归属推断（这台机器在哪个 PVE 上）。 */
              if (!b.storage) {
                toast.error(
                  t('vmDetail.backupDownloadFailed'),
                  t('vmDetail.backupDownloadFailedHint'),
                );
                return;
              }
              window.open(
                backupsApi.downloadUrl({
                  node: b.node ?? node,
                  storage: b.storage,
                  volid: b.volid,
                }),
                '_blank',
              );
            }}
          >
            <IconBackup size={15} />
          </IconButton>
          <IconButton
            label={t('vmDetail.backupDelete')}
            variant="danger"
            onClick={() => setDeleteTarget(b)}
            disabled={!canWrite || busy}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  return (
    <>
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
            <IconBackup size={16} />
            <span className="fw-600">{t('vmDetail.backupFiles')}</span>
            <Badge variant="neutral" size="sm">
              {(backupsQuery.data ?? []).length}
            </Badge>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<IconBackup size={14} />}
            onClick={() => setBackupOpen(true)}
            disabled={!canWrite}
          >
            {t('vmDetail.backupNow')}
          </Button>
        </div>

        {backupsQuery.isError && isNotImplemented(backupsQuery.error) ? (
          <div style={{ padding: 16 }}>
            <Notice tone="info" title={t('vmDetail.backupBackendTitle')}>
              {t('vmDetail.backupBackendBody')}
            </Notice>
          </div>
        ) : (
          <Table<BackupItem>
            columns={columns}
            rows={backupsQuery.data ?? []}
            rowKey={(b) => b.volid}
            loading={backupsQuery.isLoading}
            caption={t('vmDetail.backupCaption', { vmid })}
            emptyTitle={t('vmDetail.backupEmpty')}
            emptyDescription={t('vmDetail.backupEmptyDesc')}
            className="table-flush"
          />
        )}
      </Card>

      {/* 立即备份 */}
      <Modal
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        title={t('vmDetail.backupNow')}
        description={t('vmDetail.backupDesc', { name: vm.name || vmid, node })}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBackupOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={runBackup}
              loading={busy}
              disabled={!storage}
            >
              {t('vmDetail.backupStart')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Select
            label={t('vmDetail.backupStorage')}
            required
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
            hint={
              backupStorages.length === 0
                ? t('vmDetail.backupNoStorage')
                : undefined
            }
          />
          <Select
            label={t('vmDetail.backupMode')}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { label: t('vmDetail.backupModeSnapshot'), value: 'snapshot' },
              { label: t('vmDetail.backupModeSuspend'), value: 'suspend' },
              { label: t('vmDetail.backupModeStop'), value: 'stop' },
            ]}
          />
          <Select
            label={t('vmDetail.backupCompress')}
            value={compress}
            onChange={(e) => setCompress(e.target.value)}
            options={[
              { label: t('vmDetail.backupCompressZstd'), value: 'zstd' },
              { label: 'LZO', value: 'lzo' },
              { label: 'GZIP', value: 'gzip' },
              { label: t('vmDetail.backupCompressNone'), value: '0' },
            ]}
          />
          <Input
            label={t('vmDetail.backupColNote')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('vmDetail.backupNotePlaceholder')}
          />
        </div>
      </Modal>

      {/* 恢复确认（危险操作二次确认） */}
      <ConfirmDialog
        open={Boolean(restoreTarget)}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={async () => {
          if (!restoreTarget) return;
          const targetId = Number(restoreVmid);
          if (!Number.isInteger(targetId) || targetId < 100) {
            toast.error(
              t('vmDetail.restoreInvalidTitle'),
              t('vmDetail.restoreInvalidHint'),
            );
            return;
          }
          setBusy(true);
          try {
            await runner.run(
              backupsApi.restore({
                node,
                storage: restoreStorage || restoreTarget.storage || '',
                volid: restoreTarget.volid,
                vmid: targetId,
                force: restoreForce,
                start: restoreStart,
              }),
              {
                title: t('vmDetail.restoreTask', { vmid: targetId }),
                node,
                invalidate: [['vms'], ['vm', node, vmid], ['cluster']],
              },
            );
            setRestoreTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('vmDetail.restoreTitle')}
        danger
        confirmText={t('vmDetail.restoreConfirm')}
        loading={busy}
        requireText={restoreTarget ? String(restoreTarget.vmid) : undefined}
        message={
          <>
            {t('vmDetail.restoreBodyPre')}
            <strong>{restoreTarget?.volid.split('/').pop()}</strong>
            {t('vmDetail.restoreBodyTail')}
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label={t('vmDetail.restoreVmid')}
            required
            value={restoreVmid}
            onChange={(e) => setRestoreVmid(e.target.value.replace(/\D/g, ''))}
            mono
            hint={t('vmDetail.restoreVmidHint')}
          />
          <Select
            label={t('vmDetail.restoreStorage')}
            value={restoreStorage}
            onChange={(e) => setRestoreStorage(e.target.value)}
            options={storageOptions}
            hint={t('vmDetail.restoreStorageHint')}
          />
          <div className="flex flex-col gap-8">
            <Checkbox
              checked={restoreStart}
              onChange={(e) => setRestoreStart(e.target.checked)}
              label={t('vmDetail.restoreStartNow')}
            />
            <Checkbox
              checked={restoreForce}
              onChange={(e) => setRestoreForce(e.target.checked)}
              label={t('vmDetail.restoreForce')}
            />
          </div>
        </div>
      </ConfirmDialog>

      {/* 删除备份 */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            // 备份专用接口（vm.backup + 归属校验），通用卷删除接口要求
            // storage.manage，普通用户角色会被 403 挡下。
            await runner.run(
              backupsApi.remove({
                node,
                storage: deleteTarget.storage ?? '',
                volid: deleteTarget.volid,
              }),
              {
                title: t('vmDetail.backupDeleteTitle'),
                node,
                invalidate: [['backups'], ['storages']],
                destructive: true,
              },
            );
            setDeleteTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('vmDetail.backupDeleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        message={
          <>
            {t('vmDetail.backupDeleteBodyPre')}
            <strong>{deleteTarget?.volid.split('/').pop()}</strong>
            {t('vmDetail.backupDeleteBodyTail')}
          </>
        }
      />
    </>
  );
}

/* ==========================================================================
   监控 Tab
   ========================================================================== */

function MonitorTab({
  node,
  vmid,
  guestFs,
  diskUsage,
}: {
  node: string;
  vmid: number;
  /* 客户机磁盘用量由页面级持有并探测（切 Tab 不重跑 df），这里只负责展示 */
  guestFs: VmGuestFilesystem[] | null;
  diskUsage: { total: number; used: number; percent: number } | null;
}) {
  const t = useT();
  const [timeframe, setTimeframe] = useState<RrdTimeframe>('hour');

  const rrdQuery = useQuery({
    queryKey: ['vm', node, vmid, 'rrd', timeframe],
    queryFn: () => vmsApi.rrddata(node, vmid, timeframe),
    // 监控页要求实时感：5 秒拉一次，配合数值缓动与曲线动画
    refetchInterval: 5_000,
    retry: false,
  });

  const points: RrdPoint[] = useMemo(() => {
    const list = rrdQuery.data ?? [];
    return list.filter((p) => typeof p.time === 'number');
  }, [rrdQuery.data]);

  const notImpl = isNotImplemented(rrdQuery.error);

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
          {t('vmDetail.monLive')}
        </span>
        <SegmentedControl<RrdTimeframe>
          value={timeframe}
          onChange={setTimeframe}
          ariaLabel={t('vmDetail.monRangeAria')}
          options={[
            { label: t('vmDetail.monHour'), value: 'hour' },
            { label: t('vmDetail.monDay'), value: 'day' },
            { label: t('vmDetail.monWeek'), value: 'week' },
            { label: t('vmDetail.monMonth'), value: 'month' },
          ]}
        />
      </div>

      {notImpl ? (
        <Notice tone="info" title={t('vmDetail.monNotImplTitle')}>
          {t('vmDetail.monNotImplBody', { node, vmid })}
        </Notice>
      ) : null}

      {/* 实时读数：进入监控页第一眼就能看到当前负载 */}
      {latest ? (
        <div className="grid grid-4">
          <KpiCard
            label={t('vmDetail.kpiCpu')}
            value={`${latestCpu.toFixed(1)}%`}
            tone={
              usageTone(latestCpu)
            }
            progress={latestCpu}
            progressColor={usageColor(latestCpu)}
            hint={<span className="text-secondary">{t('vmDetail.monLastSample')}</span>}
          />
          <KpiCard
            label={t('vmDetail.monMemUsed')}
            value={formatBytes(memUsed, 0)}
            hint={<span className="mono">/ {formatBytes(memTotal, 0)}</span>}
            tone={
              usageTone(latestMem)
            }
            progress={latestMem}
            progressColor={usageColor(latestMem)}
          />
          <KpiCard
            label={t('vmDetail.monNet')}
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
            label={t('vmDetail.monDiskIo')}
            value={`${formatBytes(
              (latest.diskread ?? 0) + (latest.diskwrite ?? 0),
              0,
            )}/s`}
            hint={
              <>
                <span>
                  {t('vmDetail.monRead', {
                    value: `${formatBytes(latest.diskread, 0)}/s`,
                  })}
                </span>
                <span className="text-muted">·</span>
                <span>
                  {t('vmDetail.monWrite', {
                    value: `${formatBytes(latest.diskwrite, 0)}/s`,
                  })}
                </span>
              </>
            }
          />
        </div>
      ) : null}

      <div className="monitor-grid">
        {/* ---- 客户机磁盘用量 ----
            排在曲线网格的最前面（即顶部 KPI 行的正下方）：它是「现在用了多少」
            的读数，紧跟在 KPI 行那组读数后面最顺，四条曲线整块排在它下面做趋势。

            整行铺满（.monitor-span）：网格是两列，四张曲线卡正好 2×2，
            这张卡再占一格就会在末行留一个空洞，所以让它横跨整行。

            数据来自 Guest Agent 在客户机内执行 df（PVE 对 QEMU 虚拟机的
            status.disk / rrddata 的 disk 恒为 0，maxdisk 只是分配总量，
            两者都拿不到真实占用）。
            读不到时整张卡不渲染，网格自动回到 2×2，不会留下半张空卡。 */}
        {guestFs && guestFs.length > 0 ? (
          <Card className="monitor-span">
            <div className="chart-wrap">
              <div className="chart-header">
                <div className="chart-header-main">
                  <div className="chart-title">{t('vmDetail.monGuestFs')}</div>
                  <div className="chart-stats">
                    <div className="chart-stat">
                      <span
                        className="chart-stat-value mono"
                        style={
                          diskUsage
                            ? { color: usageColor(diskUsage.percent) }
                            : undefined
                        }
                      >
                        {diskUsage ? `${diskUsage.percent.toFixed(1)}%` : '—'}
                      </span>
                      <span className="chart-stat-label">{t('vmDetail.monFsOverall')}</span>
                    </div>
                    {diskUsage ? (
                      <div className="chart-stat">
                        <span className="chart-stat-value mono">
                          {formatBytes(diskUsage.used, 0)}
                        </span>
                        <span className="chart-stat-label">
                          {t('vmDetail.monFsTotal', {
                            total: formatBytes(diskUsage.total, 0),
                          })}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
                <span className="chart-legend-item fs-source">
                  {t('vmDetail.monFsSource')}
                </span>
              </div>

              {/* 用 flex 而不是 grid：分区数量不定，flex 会让最后一行自动撑满，
                  grid 则会在末行留下填不满的空格（比如 5 个分区按 3 列排）。 */}
              <div className="fs-tiles">
                {guestFs.map((fs) => (
                  <div className="fs-tile" key={fs.mountpoint}>
                    <div className="fs-tile-head">
                      <span className="mono fw-600">{fs.mountpoint}</span>
                      <span
                        className="mono fs-sm"
                        style={{ color: usageColor(fs.percent) }}
                      >
                        {fs.percent.toFixed(1)}%
                      </span>
                    </div>
                    <ProgressBar
                      value={fs.percent}
                      height={6}
                      color={usageColor(fs.percent)}
                      ariaLabel={t('vmDetail.monFsTileAria', {
                        mountpoint: fs.mountpoint,
                        percent: fs.percent.toFixed(1),
                      })}
                    />
                    <div className="fs-tile-foot">
                      <span className="mono">
                        {formatBytes(fs.used_bytes, 0)} /{' '}
                        {formatBytes(fs.total_bytes, 0)}
                      </span>
                      <span className="mono truncate" title={fs.filesystem}>
                        {fs.filesystem}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        ) : null}
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
      </div>
    </div>
  );
}

/* ==========================================================================
   配置 Tab
   ========================================================================== */

function ConfigTab({
  node,
  vmid,
  vm,
}: {
  node: string;
  vmid: number;
  vm: VmDetailType;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();

  const pendingQuery = useQuery({
    queryKey: ['vm', node, vmid, 'pending'],
    queryFn: () => vmsApi.pending(node, vmid),
    retry: false,
  });

  const json = useMemo(() => {
    try {
      return JSON.stringify(vm.config, null, 2);
    } catch {
      return '{}';
    }
  }, [vm.config]);

  /* 显示的 JSON：折叠时只展示前 40 行 */
  const lines = json.split('\n');
  const displayJson =
    expanded || lines.length <= 40 ? json : `${lines.slice(0, 40).join('\n')}\n  …`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success(t('vmDetail.cfgCopied'), t('vmDetail.cfgCopiedHint'));
    } catch {
      toast.error(
        t('vmDetail.cfgCopyFailed'),
        t('vmDetail.cfgCopyFailedHint'),
      );
    }
  };

  const pendingNotImpl = isNotImplemented(pendingQuery.error);

  return (
    <div className="flex flex-col gap-20">
      <Card>
        <CardHeader
          title={t('vmDetail.cfgRaw')}
          subtitle={t('vmDetail.cfgRawSub')}
          icon={<IconLayers size={16} />}
          actions={
            <>
              {lines.length > 40 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded
                    ? t('vmDetail.cfgCollapse')
                    : t('vmDetail.cfgExpandAll')}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void copy()}>
                {t('vmDetail.cfgCopyJson')}
              </Button>
            </>
          }
        />
        <pre className="code-block">{displayJson}</pre>
      </Card>

      <Card>
        <CardHeader
          title={t('vmDetail.cfgPending')}
          subtitle={t('vmDetail.cfgPendingSub')}
          icon={<IconAlert size={16} />}
        />
        {pendingNotImpl ? (
          <Notice tone="info" title={t('vmDetail.cfgPendingBackendTitle')}>
            {t('vmDetail.cfgPendingBackendBody', { node, vmid })}
          </Notice>
        ) : pendingQuery.isLoading ? (
          <div className="skeleton" style={{ height: 60, borderRadius: 6 }} />
        ) : (pendingQuery.data ?? []).length === 0 ? (
          <EmptyState
            title={t('vmDetail.cfgPendingEmpty')}
            description={t('vmDetail.cfgPendingEmptyDesc')}
            compact
          />
        ) : (
          <div className="desc-list">
            {(pendingQuery.data ?? []).map((item) => (
              <div className="desc-item" key={item.key}>
                <span className="desc-label mono">{item.key}</span>
                <span className="desc-value mono">
                  {item.pending
                    ? `${String(vm.config[item.key] ?? '—')} → ${item.pending}`
                    : String(vm.config[item.key] ?? '—')}
                  {item.delete ? (
                    <Badge variant="danger" size="sm" className="ml-8">
                      {t('vmDetail.cfgPendingDelete')}
                    </Badge>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
