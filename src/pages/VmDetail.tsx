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
} from '../utils/status';
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

const TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'overview', label: '概览', icon: <IconVm size={15} /> },
  { key: 'hardware', label: '硬件', icon: <IconCpu size={15} /> },
  { key: 'console', label: '控制台', icon: <IconConsole size={15} /> },
  { key: 'snapshots', label: '快照', icon: <IconSnapshot size={15} /> },
  { key: 'backups', label: '备份', icon: <IconBackup size={15} /> },
  { key: 'monitor', label: '监控', icon: <IconMonitor size={15} /> },
  { key: 'config', label: '配置', icon: <IconLayers size={15} /> },
];

/* ==========================================================================
   主页面
   ========================================================================== */

export function VmDetail() {
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
      toast.warning('名称不能为空', '留空会让虚拟机在列表里退回显示 VMID');
      return;
    }
    if (name.length > 63) {
      toast.warning('名称过长', 'Proxmox 的名称上限是 63 个字符');
      return;
    }
    if (name === (vm.name ?? '')) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      await runner.run(vmsApi.updateConfig(node, vmid, { name }), {
        title: `重命名为「${name}」`,
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
        toast.warning('权限不足', '当前角色不允许执行电源操作');
        return;
      }
      if (!vm) return;

      const labels = {
        start: '启动',
        stop: '停止',
        shutdown: '关机',
        reboot: '重启',
        suspend: '挂起',
        resume: '恢复',
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
          title: `${labels[action]}「${vm.name || vmid}」`,
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
          title="无效的虚拟机地址"
          message="请从虚拟机列表进入详情页。"
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
            { label: '虚拟机', to: '/vms' },
            { label: `${node} / ${vmid}` },
          ]}
        />
        <ErrorState
          title={notImpl ? '该虚拟机接口暂不可用' : '无法加载虚拟机详情'}
          message={errorMessage(vmQuery.error)}
          notImplemented={notImpl}
          onRetry={() => void vmQuery.refetch()}
        />
        <Button variant="secondary" onClick={() => navigate('/vms')}>
          返回列表
        </Button>
      </div>
    );
  }

  const statusMeta = vmStatusMeta(vm.status);
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
      ? { label: '未启用', variant: 'neutral' }
      : vm.agent_available
        ? { label: '可用', variant: 'success' }
        : running
          ? { label: '无响应', variant: 'warning' }
          : { label: '未运行', variant: 'neutral' };

  const cpuPct = toPercent(vm.cpu);
  const memPct = vm.maxmem ? ((vm.mem ?? 0) / vm.maxmem) * 100 : 0;

  return (
    <div className="page">
      {/* ---- 头部 ---- */}
      <div className="detail-header">
        <div className="detail-header-main">
          <Breadcrumb
            items={[
              { label: '虚拟机', to: '/vms' },
              { label: `${vm.name || `VM ${vmid}`}` },
            ]}
          />
          <div className="detail-title-row">
            <span className="detail-name">{vm.name || `VM ${vmid}`}</span>
            {/* 改名放在标题旁：它修饰的就是这个名字本身，在概览卡片里再放一个
                反而要用户先切回概览页 */}
            {canWrite ? (
              <IconButton
                label="修改名称"
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
                模板
              </Badge>
            ) : null}
            {vm.lock ? (
              <Badge variant="warning" size="sm">
                锁定：{vm.lock}
              </Badge>
            ) : null}
          </div>
          <div className="detail-meta">
            <span className="detail-meta-item">
              <IconVm size={13} />
              节点 <span className="mono">{vm.node}</span>
            </span>
            <span className="detail-meta-item">
              {ostypeLabel(vm.config.ostype)}
            </span>
            <span className="detail-meta-item">
              {vm.config.bios === 'ovmf' ? 'UEFI (OVMF)' : 'SeaBIOS'}
            </span>
            <span className="detail-meta-item">
              {running ? `运行 ${formatUptime(vm.uptime)}` : '未运行'}
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
              启动
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
                关机
              </Button>
              <Button
                variant="secondary"
                icon={<IconRestart size={15} />}
                onClick={() => void power('reboot')}
                disabled={noWrite}
              >
                重启
              </Button>
              <Button
                variant="danger"
                icon={<IconStop size={14} />}
                onClick={() => void power('stop')}
                disabled={noWrite}
              >
                停止
              </Button>
              <Button
                variant="ghost"
                icon={<IconPause size={14} />}
                onClick={() => void power('suspend')}
                disabled={noWrite}
              >
                挂起
              </Button>
              <Button
                variant="secondary"
                icon={<IconConsole size={14} />}
                onClick={() => setTab('console')}
              >
                控制台
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
              恢复
            </Button>
          ) : null}

          <IconButton
            label="刷新详情"
            onClick={() => {
              void vmQuery.refetch();
              invalidate();
            }}
          >
            <IconRefresh size={16} />
          </IconButton>
          <IconButton
            label="删除虚拟机"
            variant="danger"
            onClick={() => setDeleteOpen(true)}
            disabled={!canWrite}
          >
            <IconTrash size={16} />
          </IconButton>
        </div>
      </div>

      {/* ---- Tab 导航 ---- */}
      <div className="tabs" role="tablist" aria-label="虚拟机详情分区">
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
        title="修改虚拟机名称"
        description={`VMID ${vmid} · 节点 ${node}`}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRenameOpen(false)}
              disabled={renaming}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void saveRename()} loading={renaming}>
              保存
            </Button>
          </>
        }
      >
        <Input
          label="名称"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder={`VM ${vmid}`}
          maxLength={63}
          autoFocus
          hint={`当前名称：${vm.name || '未设置'} · 最多 63 个字符`}
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
              title: `删除「${vm.name || vmid}」`,
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
        title="删除虚拟机"
        danger
        confirmText="删除"
        loading={deleting}
        requireText={vm.name || String(vmid)}
        message={
          <>
            即将删除虚拟机 <strong>{vm.name || `VM ${vmid}`}</strong>
            （VMID {vmid}）。该操作会清除所有磁盘数据且不可恢复。
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
      ? `${vm.config.sockets ?? 1} 插槽 × ${vm.config.cores ?? 1} 核`
      : '';
  const cpuText = [cpuType, cpuTopology].filter(Boolean).join(' · ') || '—';

  const taskColumns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: '类型',
      render: (t) => <span className="mono fs-sm">{t.type}</span>,
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
      width: 96,
    },
    {
      key: 'time',
      header: '时间',
      render: (t) => (
        <span className="fs-sm text-secondary">
          {formatRelative(t.starttime)}
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
          label="CPU 使用率"
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
          label="内存使用率"
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
          label="磁盘使用率"
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
                {vm.disks.length} 块 · 共 {formatBytes(diskTotal, 0)}（未读客户机）
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
          <CardHeader title="基本信息" icon={<IconVm size={16} />} />
          <InfoGrid>
            {/* 名称是可改的（PVE 的 `name` 字段）：仍用 InfoRow 保持与其余各项
                同一套排版，只在值右侧挂一个编辑按钮 —— 单独的「重命名」按钮
                放在标题栏反而离它修饰的对象更远。 */}
            <InfoRow
              label="名称"
              value={
                <span className="info-editable">
                  <span className="truncate" title={vm.name || `VM ${vm.vmid}`}>
                    {vm.name || `VM ${vm.vmid}`}
                  </span>
                  {onRenameName ? (
                    <IconButton label="修改名称" onClick={onRenameName}>
                      <IconEdit size={13} />
                    </IconButton>
                  ) : null}
                </span>
              }
            />
            <InfoRow label="VMID" value={vm.vmid} mono />
            <InfoRow label="节点" value={vm.node} mono />
            <InfoRow label="操作系统" value={ostypeLabel(vm.config.ostype)} />
            <InfoRow
              label="BIOS"
              value={vm.config.bios === 'ovmf' ? 'OVMF (UEFI)' : 'SeaBIOS'}
            />
            <InfoRow label="机型" value={String(vm.config.machine ?? '—')} mono />
            <InfoRow label="CPU" value={cpuText} />
            {/* 基本信息里这一行问的是「配置开关」，用 agent_enabled；
                顶部那个徽标问的是「此刻能不能用」，用 agent_available */}
            <InfoRow
              label="Guest Agent"
              value={
                <Badge
                  variant={vm.agent_enabled ? 'success' : 'neutral'}
                  dot
                  size="sm"
                >
                  {vm.agent_enabled ? '已启用' : '未启用'}
                </Badge>
              }
            />
            <InfoRow label="运行时长" value={running ? formatUptime(vm.uptime) : '未运行'} />
            <InfoRow
              label="创建时间"
              /* PVE 8 之前建的机器没有 meta，克隆出来的机器继承来源的时间 */
              title="面板发起的新建 / 克隆 / 恢复按实际时刻记录；其余取 PVE config 里的 meta.ctime（PVE 克隆 / 恢复会继承来源机器的时间）"
              value={vm.created ? formatDateTime(vm.created) : '—'}
            />
            <InfoRow
              label="开机自启"
              value={vm.config.onboot ? '是' : '否'}
            />
            <InfoRow label="标签" value={<TagList tags={parseTags(vm.tags)} max={5} />} />
          </InfoGrid>
        </Card>
      </div>

      {/* ---- 右列：磁盘 + 网络 ----
          左列「基本信息」、右列「磁盘 + 网络」，两组各占一列，
          两列高度由 .is-balanced 拉平成一样高。 */}
      <div className="detail-column">
        <Card collapsible={false}>
          <CardHeader
            title="磁盘"
            subtitle={`${vm.disks.length} 块 · 共 ${formatBytes(diskTotal, 0)}`}
            icon={<IconDisk size={16} />}
          />
          {vm.disks.length === 0 ? (
            <EmptyState title="暂无磁盘" compact />
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
            title="网络"
            subtitle={`${vm.networks.length} 个网卡`}
            icon={<IconNetwork size={16} />}
          />
          {vm.networks.length === 0 ? (
            <EmptyState title="暂无网卡" compact />
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
                        <span className="hw-item-label">{name || '网卡'}</span>
                        <span className="hw-item-value">
                          {n.model ?? '—'} · {n.bridge ?? '未桥接'}
                          {vlan ? ` · VLAN ${vlan}` : ''}
                        </span>
                        {n.macaddr ? (
                          <span className="fs-xs text-muted mono">{n.macaddr}</span>
                        ) : null}
                        <span className="fs-xs text-muted">
                          {ipStatic
                            ? `IP ${ipcfg.ip}${ipcfg.gateway ? ` · 网关 ${ipcfg.gateway}` : ''}`
                            : 'IP 自动获取（DHCP）'}
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
              <div className="wizard-section-title">客户机内网卡（Guest Agent）</div>
              <div className="flex flex-col">
                {vm.agent_interfaces?.map((iface) => (
                  <div className="hw-item" key={iface.name}>
                    <div className="hw-item-main">
                      <div className="hw-item-text">
                        <span className="hw-item-label">{iface.name}</span>
                        <span className="hw-item-value mono">
                          {iface.ip_addresses?.map((a) => a.ip_address).join(', ') ||
                            '无地址'}
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
          <CardHeader title="最近任务" icon={<IconRefresh size={16} />} />
        </div>
        <Table<TaskInfo>
          columns={taskColumns}
          rows={tasks}
          rowKey={(t) => t.upid}
          loading={tasksLoading}
          caption={`虚拟机 ${vm.vmid} 的最近任务`}
          emptyTitle="暂无任务"
          emptyDescription="该虚拟机近期没有执行过任务。"
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
      { label: '请选择存储池', value: '' },
      ...(storagesQuery.data ?? [])
        .filter((s) => s.active)
        .map((s) => ({ label: `${s.storage} (${s.type})`, value: s.storage })),
    ],
    [storagesQuery.data],
  );

  /* 新增磁盘只能落在支持 images 内容的存储池上（ISO / 备份池放不了磁盘） */
  const diskStorageOptions = useMemo(
    () => [
      { label: '请选择存储池', value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active &&
            s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
        )
        .map((s) => ({ label: `${s.storage} (${s.type})`, value: s.storage })),
    ],
    [storagesQuery.data],
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
        title: `修改 ${key}`,
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
      toast.warning('IP 格式不正确', '静态地址需带 CIDR 前缀，如 192.168.1.10/24');
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
          title: `修改 ${ipEditNet} 的 IP`,
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
      toast.warning('格式不正确', '请输入如 50G、100G 的容量');
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
          title: `扩容磁盘 ${resizeDisk}`,
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
          title: `迁移磁盘 ${disk} 到 ${storage}`,
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
        title: `新增磁盘 ${body.size} GB`,
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
        title: `新增网卡 ${body.bridge}`,
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
        title: `移除 ${removeTarget.key}`,
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
          <CardHeader title="处理器与内存" icon={<IconCpu size={16} />} />
          <div className="flex flex-col">
            <HwRow
              label="cpu"
              title="CPU 类型"
              value={String(vm.config.cpu ?? 'kvm64')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('cpu');
                setEditValue(configValue('cpu'));
              }}
            />
            <HwRow
              label="cores"
              title="核心数"
              value={`${vm.config.cores ?? 1} 核`}
              editable={canEdit}
              onEdit={() => {
                setEditKey('cores');
                setEditValue(configValue('cores'));
              }}
            />
            <HwRow
              label="sockets"
              title="插槽数"
              value={`${vm.config.sockets ?? 1} 插槽`}
              editable={canEdit}
              onEdit={() => {
                setEditKey('sockets');
                setEditValue(configValue('sockets'));
              }}
            />
            <HwRow
              label="memory"
              title="内存"
              value={formatBytes(Number(vm.config.memory ?? 0) * 1024 ** 2)}
              editable={canEdit}
              onEdit={() => {
                setEditKey('memory');
                setEditValue(configValue('memory'));
              }}
              hint="支持在线调整（需 Guest Agent）"
            />
            <HwRow
              label="balloon"
              title="Balloon 最小内存"
              value={
                vm.config.balloon
                  ? formatBytes(Number(vm.config.balloon) * 1024 ** 2)
                  : '未设置'
              }
              editable={canEdit}
              onEdit={() => {
                setEditKey('balloon');
                setEditValue(configValue('balloon'));
              }}
            />
            <HwRow
              label="numa"
              title="NUMA"
              value={Number(vm.config.numa) === 1 ? '已启用' : '未启用'}
              editable={canEdit}
              onEdit={() => {
                setEditKey('numa');
                setEditValue(configValue('numa'));
              }}
              hint="只向客户机呈现 NUMA 拓扑；要把 vCPU 钉到宿主节点需另配 numaN"
            />
            <HwRow
              label="affinity"
              title="CPU 亲和性"
              value={String(vm.config.affinity ?? '未限制')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('affinity');
                setEditValue(configValue('affinity'));
              }}
              hint="整机允许落在哪些宿主逻辑 CPU 上，如 0-7"
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="固件与引导" icon={<IconVm size={16} />} />
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
              title="机型"
              value={String(vm.config.machine ?? 'pc')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('machine');
                setEditValue(configValue('machine'));
              }}
            />
            <HwRow
              label="scsihw"
              title="SCSI 控制器"
              value={String(vm.config.scsihw ?? '—')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('scsihw');
                setEditValue(configValue('scsihw'));
              }}
            />
            <HwRow
              label="boot"
              title="启动顺序"
              value={String(vm.config.boot ?? vm.config.bootdisk ?? '—')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('boot');
                setEditValue(configValue('boot'));
              }}
            />
            <HwRow
              label="efidisk0"
              title="EFI 变量盘"
              value={String(vm.config.efidisk0 ?? '未配置')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('efidisk0');
                setEditValue(configValue('efidisk0'));
              }}
              hint="Windows 11 必需（UEFI 启动）；需配合 BIOS=OVMF、机型=q35"
            />
            <HwRow
              label="tpmstate0"
              title="虚拟 TPM"
              value={String(vm.config.tpmstate0 ?? '未配置')}
              editable={canEdit}
              onEdit={() => {
                setEditKey('tpmstate0');
                setEditValue(configValue('tpmstate0'));
              }}
              hint="Windows 11 要求 TPM 2.0"
            />
            <HwRow
              label="ostype"
              title="操作系统类型"
              value={ostypeLabel(String(vm.config.ostype ?? ''))}
              editable={false}
            />
          </div>
        </Card>
      </div>

      <div className="detail-column">
        <Card>
          <CardHeader
            title="磁盘"
            subtitle={`${vm.disks.length} 块`}
            icon={<IconDisk size={16} />}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setAddDiskOpen(true)}
                disabled={!canEdit}
              >
                新增磁盘
              </Button>
            }
          />
          {vm.disks.length === 0 ? (
            <EmptyState title="暂无磁盘" compact />
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
                        <span className="hw-item-label">{name || '磁盘'}</span>
                        <span className="hw-item-value">
                          {formatBytes(parseSizeToBytes(d.size))} · {d.storage}
                          {d.format ? ` · ${d.format}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="hw-item-actions">
                      <IconButton
                        label={`扩容 ${name || '磁盘'}`}
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
                          { label: '迁移到…', value: '' },
                          ...(storagesQuery.data ?? [])
                            .filter((s) => s.active && s.storage !== d.storage)
                            .map((s) => ({ label: s.storage, value: s.storage })),
                        ]}
                        disabled={!canEdit}
                        aria-label={`迁移磁盘 ${name || '磁盘'} 到其他存储`}
                        style={{ width: 110, height: 28, fontSize: 12 }}
                      />
                      <IconButton
                        label={`移除 ${name || '磁盘'}`}
                        variant="danger"
                        disabled={!canEdit || !name}
                        onClick={() =>
                          setRemoveTarget({
                            key: name,
                            title: `${name}（${formatBytes(
                              parseSizeToBytes(d.size),
                            )} · ${d.storage}）`,
                            detail:
                              '只会从虚拟机配置里摘掉这块盘，卷数据仍留在存储池上；'
                              + '要回收空间请到「存储」页面删除该卷。',
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
            title="网络设备"
            subtitle={`${vm.networks.length} 个`}
            icon={<IconNetwork size={16} />}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setAddNetOpen(true)}
                disabled={!canEdit}
              >
                新增网卡
              </Button>
            }
          />
          {vm.networks.length === 0 ? (
            <EmptyState title="暂无网卡" compact />
          ) : (
            <div className="flex flex-col">
              {vm.networks.map((n) => {
                const name = nicKey(n);
                const idx = name.replace(/\D/g, '');
                const ipcfg = parseIpconfig(vm.config[`ipconfig${idx}`]);
                const ipStatic = ipcfg.ip && ipcfg.ip.toLowerCase() !== 'dhcp';
                const vlan = n.vlan_tag ?? n.tag;
                const ipLabel = ipStatic
                  ? `IP ${ipcfg.ip}${ipcfg.gateway ? ` · 网关 ${ipcfg.gateway}` : ''}`
                  : 'IP 自动获取（DHCP）';
                return (
                  <HwRow
                    key={name || n.macaddr}
                    label={name || '网卡'}
                    title={`${name || '网卡'} (${n.model ?? '—'})`}
                    value={`${n.bridge ?? '未桥接'}${vlan ? ` · VLAN ${vlan}` : ''}${
                      n.firewall ? ' · 防火墙' : ''
                    }`}
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
                          n.bridge ?? '未桥接'
                        }${vlan ? ` · VLAN ${vlan}` : ''}）`,
                        detail:
                          `移除后客户机里的对应网卡会消失，IP 配置（ipconfig${idx}）本身保留。`,
                      })
                    }
                    extraActions={
                      <IconButton
                        label={`编辑 ${name || '网卡'} 的 IP 地址`}
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
          <CardHeader title="光驱" icon={<IconDisk size={16} />} />
          <div className="flex flex-col">
            {Object.keys(vm.config)
              .filter((k) => /^(ide|sata)\d+$/.test(k) && k !== vm.config.bootdisk)
              .map((k) => (
                <HwRow
                  key={k}
                  label={k}
                  title={`${k}（光驱）`}
                  value={String(vm.config[k] ?? '—')}
                  editable={canEdit}
                  onEdit={() => {
                    setEditKey(k);
                    setEditValue(configValue(k));
                  }}
                  onRemove={() =>
                    setRemoveTarget({
                      key: k,
                      title: `${k}（光驱）`,
                      detail:
                        '只删配置项，ISO 文件本身不受影响；'
                        + '如果这一项是 cloud-init 驱动器，移除后 cloud-init 会一并失效。',
                    })
                  }
                />
              ))}
            {Object.keys(vm.config).filter((k) => /^(ide|sata)\d+$/.test(k)).length ===
            0 ? (
              <EmptyState title="没有光驱设备" compact />
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
        title={`编辑 ${ipEditNet ?? ''} 的 IP 地址`}
        description="静态地址通过 Cloud-Init 下发，需要虚拟机使用 cloud-init 镜像"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIpEditNet(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={saveNicIp} loading={busy}>
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label="IP 地址"
            value={ipValue}
            onChange={(e) => setIpValue(e.target.value)}
            placeholder="dhcp 或 192.168.1.10/24"
            mono
            autoFocus
            hint="填 dhcp 表示自动获取"
          />
          <Input
            label="网关"
            value={gwValue}
            onChange={(e) => setGwValue(e.target.value)}
            placeholder="如 192.168.1.1"
            mono
            disabled={ipValue.trim().toLowerCase() === 'dhcp'}
            hint="DHCP 时无需填写"
          />
          <Notice tone="info" title="生效方式">
            修改的是该网卡的 Cloud-Init 网络配置（<code>ipconfig{ipEditNet?.replace(/\D/g, '')}</code>）。
            若虚拟机正在运行，需重启或在客户机内重新应用网络配置后生效。
          </Notice>
        </div>
      </Modal>

      {/* ---- 磁盘扩容 Modal ---- */}
      <Modal
        open={Boolean(resizeDisk)}
        onClose={() => setResizeDisk(null)}
        title="扩容磁盘"
        description={`磁盘 ${resizeDisk ?? ''}`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setResizeDisk(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={doResize} loading={busy}>
              确认扩容
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label="新容量"
            required
            value={resizeValue}
            onChange={(e) => setResizeValue(e.target.value)}
            placeholder="如 50G"
            autoFocus
            hint="单位可为 G / T，例如 100G"
          />
          <Notice tone="warning" title="仅支持增大">
            磁盘只能扩容，无法缩小。扩容后需在客户机内扩展分区与文件系统才能生效。
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
        title="移除硬件"
        danger
        confirmText="移除"
        loading={busy}
        message={
          <>
            将从虚拟机配置中移除 <strong>{removeTarget?.title}</strong>。
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
    if (!storage) next.storage = '请选择存储池';
    if (!Number.isFinite(gb) || gb <= 0) next.size = '请输入大于 0 的容量';
    else if (gb > 8192) next.size = '单块磁盘最大 8192 GB';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({ storage, size: Math.floor(gb), format, discard, ssd });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新增磁盘"
      description="槽位（scsiN）由后端挑第一个空闲的，格式会按存储池类型自动纠正"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            添加磁盘
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Field label="存储池" required error={errors.storage}>
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
          />
        </Field>
        <Input
          label="容量（GB）"
          required
          value={size}
          onChange={(e) => setSize(e.target.value)}
          error={errors.size}
          mono
          autoFocus
          hint="例如 20、100"
        />
        <Field
          label="磁盘格式"
          hint="LVM / ZFS 等块存储只支持 raw，选了别的会被自动纠正"
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
          label="启用 discard"
          hint="让客户机回收未使用的块，SSD / 精简置备存储上建议开启"
        />
        <Switch
          checked={ssd}
          onChange={setSsd}
          label="标记为 SSD"
          hint="让客户机按 SSD 优化 IO 调度策略"
        />
        <Notice tone="info" title="添加之后">
          新盘是一块未格式化的裸设备，需要进客户机分区并格式化之后才能使用。
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
      label: `${i.iface}${i.active ? '' : '（未激活）'}`,
      value: i.iface,
    }));
  }, [bridgesQuery.data]);

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
    if (!bridge) next.bridge = '请选择网桥';
    if (tag && (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > 4094)) {
      next.vlan = 'VLAN ID 需在 1 - 4094 之间';
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
      title="新增网卡"
      description="键名（netN）由后端挑空位，MAC 地址交给 Proxmox 自动生成"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            添加网卡
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Field
          label="网桥"
          required
          error={errors.bridge}
          hint={
            bridgesQuery.isError
              ? '无法读取节点网卡列表，请先确认名称是否正确'
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
            placeholder="请选择网桥"
          />
        </Field>
        <Field label="网卡型号">
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            options={[
              { label: 'VirtIO（半虚拟化，性能最好）', value: 'virtio' },
              { label: 'Intel E1000', value: 'e1000' },
              { label: 'VMware vmxnet3', value: 'vmxnet3' },
              { label: 'Realtek RTL8139', value: 'rtl8139' },
            ]}
          />
        </Field>
        <Input
          label="VLAN 标签"
          value={vlan}
          onChange={(e) => setVlan(e.target.value)}
          error={errors.vlan}
          placeholder="留空表示不打标签"
          mono
          hint="1 - 4094"
        />
        <Switch
          checked={firewall}
          onChange={setFirewall}
          label="启用防火墙"
          hint="由 Proxmox 的防火墙规则管控这张网卡"
        />
        <Notice tone="info" title="生效方式">
          新网卡会立刻出现在配置里。若客户机没有热插拔支持，需要关机再开机才能识别。
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
            <IconButton label={`编辑 ${title}`} onClick={onEdit} disabled={!editable}>
              <IconEdit size={15} />
            </IconButton>
          ) : null}
          {onRemove ? (
            <IconButton
              label={`移除 ${title}`}
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
  if (!configKey) return null;

  const LABELS: Record<string, string> = {
    cpu: 'CPU 类型',
    cores: '核心数（每插槽）',
    sockets: '插槽数',
    memory: '内存（MB）',
    balloon: 'Balloon 最小内存（MB）',
    bios: 'BIOS 类型',
    machine: '机型',
    scsihw: 'SCSI 控制器',
    boot: '启动顺序',
    numa: 'NUMA 拓扑',
    affinity: 'CPU 亲和性',
    efidisk0: 'EFI 变量盘',
    tpmstate0: '虚拟 TPM',
    name: '名称',
    description: '描述',
    agent: 'QEMU Guest Agent',
    onboot: '开机自启',
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
            label={LABELS.bios}
            value={nextBios}
            onChange={(e) => onValueChange(e.target.value)}
            options={[
              { label: 'SeaBIOS（传统）', value: 'seabios' },
              { label: 'OVMF（UEFI）', value: 'ovmf' },
            ]}
          />
          {changingBios ? (
            <Notice
              tone="warning"
              title={`即将由 ${currentBios} 切换为 ${nextBios}`}
            >
              固件类型和磁盘分区方式、引导器是绑死的：MBR 装的系统需要 SeaBIOS，
              GPT + EFI 分区需要 OVMF。已经装好系统的机器直接切换会开机失败，
              只能通过改回原值或重装系统恢复。
              {nextBios === 'ovmf' && !hasEfiDisk
                ? '另外，OVMF 还要求先挂一块 EFI 变量盘（efidisk0），否则虚拟机会直接引导失败。'
                : ''}
            </Notice>
          ) : (
            <Notice tone="info" title="OVMF 的前置条件">
              Windows 11 等 UEFI 系统需要 OVMF，并同时配置 EFI 变量盘（efidisk0）
              与 q35 机型。三者要配套，缺一个都起不来。
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
            label={LABELS.machine}
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
              title={`即将由 ${currentMachine} 切换为 ${nextMachine}`}
            >
              机型决定了芯片组与磁盘控制器的 PCI 地址，切换后客户机里的系统可能
              认不出原来的引导盘（Windows 尤其明显）。已上线的机器建议先停机、
              确认可以回滚再改。
            </Notice>
          ) : null}
          {nextMachine !== 'q35' && needsQ35 ? (
            <Notice tone="danger" title="这台机器需要 q35">
              它已配置 EFI 变量盘或虚拟 TPM，而 OVMF 在 i440fx 上不可用 ——
              改成 i440fx 后会直接引导失败，请把 BIOS 一并改回 SeaBIOS 并移除
              这两块盘，或保持 q35。
            </Notice>
          ) : null}
        </div>
      );
    }

    if (configKey === 'scsihw') {
      return (
        <Select
          label={LABELS.scsihw}
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
          label={LABELS.cpu}
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
          label={LABELS.boot}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="如 scsi0;net0"
          mono
          hint="按顺序尝试引导设备，分号分隔"
        />
      );
    }

    if (configKey === 'numa') {
      return (
        <Select
          label={LABELS.numa}
          value={Number(value) === 1 ? '1' : '0'}
          onChange={(e) => onValueChange(e.target.value)}
          options={[
            { label: '关闭（PVE 默认调度）', value: '0' },
            { label: '开启（向客户机呈现 NUMA 拓扑）', value: '1' },
          ]}
          hint="只影响客户机拓扑；把 vCPU 钉到宿主 NUMA 节点需改配置项 numaN"
        />
      );
    }

    if (configKey === 'affinity') {
      const bad = value.trim() !== '' && !CPUSET_RE.test(value.trim());
      return (
        <Input
          label={LABELS.affinity}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="如 0-7"
          mono
          error={bad ? 'CPU 列表格式如 0-3,8-11（仅数字、逗号与连字符）' : undefined}
          hint="整机允许落在哪些宿主逻辑 CPU 上；留空 = 不限制"
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
            label={LABELS[configKey]}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            mono
            placeholder={
              isEfi
                ? 'local-lvm:1,efitype=4m,pre-enrolled-keys=1'
                : 'local-lvm:4,version=v2.0'
            }
            hint={
              isEfi
                ? 'efitype=4m 才支持 pre-enrolled-keys（Win11 安全启动）'
                : 'PVE 的 TPM 状态盘最小 4MB'
            }
          />
          <Select
            label="用选中的存储池生成"
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
            hint="会覆盖上面的值；存储池需支持 images 内容"
          />
          <Notice
            tone="warning"
            title={isEfi ? 'EFI 盘要求 OVMF + q35' : '虚拟 TPM 要求 OVMF + q35'}
          >
            设置后请确认 BIOS=OVMF、机型=q35，否则虚拟机会引导失败。
          </Notice>
        </div>
      );
    }

    if (isDiskOrNet) {
      /* 磁盘 / 网卡：附加存储池选择 */
      return (
        <div className="flex flex-col gap-16">
          <Input
            label={`${configKey} 配置`}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            mono
            hint={
              /^net/.test(configKey)
                ? '格式示例：virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1'
                : '格式示例：local-lvm:vm-100-disk-0,size=20G'
            }
          />
          {/^(scsi|virtio|sata|ide)/.test(configKey) ? (
            <Select
              label="更换存储池（仅改写卷路径）"
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const parts = value.split(',');
                const sizeIdx = parts.findIndex((p) => p.startsWith('size='));
                const size = sizeIdx >= 0 ? parts[sizeIdx] : 'size=20G';
                onValueChange(`${e.target.value}:vm-0-disk-0,${size}`);
              }}
              options={storageOptions}
              hint={`当前存储：${value.split(':')[0] || '—'} · 节点 ${node}`}
            />
          ) : null}
        </div>
      );
    }

    if (isNumeric) {
      return (
        <Input
          label={LABELS[configKey] ?? configKey}
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
        label={LABELS[configKey] ?? configKey}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        mono
        hint={`当前值：${String(currentConfig[configKey] ?? '—')}`}
        autoFocus
      />
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`编辑配置 · ${configKey}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onSave} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        {renderControl()}
        <Notice tone="info">
          部分配置（如 CPU 类型、BIOS、机型）需在虚拟机停止后修改才会生效；内存与
          CPU 核心数支持在线调整。
        </Notice>
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
          title: `创建快照「${name}」`,
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
      header: '快照名称',
      render: (s) => <span className="fw-500 mono">{s.name}</span>,
      sortable: true,
      sortValue: (s) => s.name,
    },
    {
      key: 'description',
      header: '描述',
      render: (s) => (
        <span className="fs-sm text-secondary">{s.description || '—'}</span>
      ),
    },
    {
      key: 'snaptime',
      header: '创建时间',
      render: (s) => <span className="fs-sm mono">{formatDateTime(s.snaptime)}</span>,
      width: 160,
      sortable: true,
      sortValue: (s) => s.snaptime ?? 0,
    },
    {
      key: 'vmstate',
      header: '含内存',
      width: 88,
      align: 'center',
      render: (s) => (
        <Badge variant={s.vmstate ? 'info' : 'neutral'} size="sm">
          {s.vmstate ? '是' : '否'}
        </Badge>
      ),
    },
    {
      key: 'parent',
      header: '父快照',
      render: (s) => (
        <span className="fs-sm text-muted mono">{s.parent || '—'}</span>
      ),
      width: 140,
    },
    {
      key: 'actions',
      header: '操作',
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
            回滚
          </Button>
          <IconButton
            label={`删除快照 ${s.name}`}
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
            <span className="fw-600">快照</span>
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
            新建快照
          </Button>
        </div>

        <Table<Snapshot>
          columns={columns}
          rows={snapshots}
          rowKey={(s) => s.name}
          loading={snapQuery.isLoading}
          caption={`虚拟机 ${vmid} 的快照列表`}
          emptyTitle="暂无快照"
          emptyDescription="为虚拟机创建快照，可在系统变更前保留还原点。"
          className="table-flush"
        />
      </Card>

      {/* 新建快照 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建快照"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={create}
              loading={busy}
              disabled={!name.trim()}
            >
              创建
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label="快照名称"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 before-upgrade"
            autoFocus
            error={
              name && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)
                ? '需以字母开头，只含字母、数字、- 和 _'
                : undefined
            }
          />
          <Input
            label="描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="记录快照用途"
          />
          <Checkbox
            checked={vmstate}
            onChange={(e) => setVmstate(e.target.checked)}
            label="包含内存状态（回滚可恢复到运行状态）"
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
                title: `回滚到快照「${rollbackTarget.name}」`,
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
        title="回滚快照"
        confirmText="执行回滚"
        loading={busy}
        requireText={rollbackTarget?.name}
        message={
          <>
            即将把虚拟机回滚到快照{' '}
            <strong>{rollbackTarget?.name}</strong>。当前磁盘状态将被丢弃，
            该快照之后产生的所有变更都会丢失。
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
              title: `删除快照「${deleteTarget.name}」`,
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
        title="删除快照"
        danger
        confirmText="删除"
        loading={busy}
        message={
          <>
            即将删除快照 <strong>{deleteTarget?.name}</strong>。
            删除后无法再回滚到该时间点。
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
      { label: '请选择存储池', value: '' },
      ...backupStorages.map((s) => ({
        label: `${s.storage} (可用 ${formatBytes(s.avail)})`,
        value: s.storage,
      })),
    ],
    [backupStorages],
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
      toast.warning('请选择存储池');
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
          title: `备份「${vm.name || vmid}」`,
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
      header: '备份文件',
      render: (b) => (
        <span className="mono fs-sm" title={b.volid}>
          {b.volid.split('/').pop() ?? b.volid}
        </span>
      ),
    },
    {
      key: 'ctime',
      header: '创建时间',
      render: (b) => <span className="fs-sm mono">{formatDateTime(b.ctime)}</span>,
      width: 160,
      sortable: true,
      sortValue: (b) => b.ctime,
    },
    {
      key: 'size',
      header: '大小',
      render: (b) => <span className="mono fs-sm">{formatBytes(b.size)}</span>,
      width: 100,
      align: 'right',
      sortable: true,
      sortValue: (b) => b.size,
    },
    {
      key: 'format',
      header: '格式',
      render: (b) => (
        <Badge variant="neutral" size="sm">
          {b.format}
        </Badge>
      ),
      width: 90,
    },
    {
      key: 'notes',
      header: '备注',
      render: (b) => (
        <span className="fs-sm text-secondary truncate" title={b.notes}>
          {b.notes || '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
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
            恢复
          </Button>
          <IconButton
            label="下载备份文件"
            onClick={() => {
              /* 宿主机上的路径由「存储路径 + 归档名」拼出，缺存储信息就下不了。
                 连接不用带：下载链接是浏览器直接打开的，带不了请求头，后端会按
                 节点归属推断（这台机器在哪个 PVE 上）。 */
              if (!b.storage) {
                toast.error('无法下载', '这条归档缺少存储信息，请刷新后重试');
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
            label="删除备份"
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
            <span className="fw-600">备份文件</span>
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
            立即备份
          </Button>
        </div>

        {backupsQuery.isError && isNotImplemented(backupsQuery.error) ? (
          <div style={{ padding: 16 }}>
            <Notice tone="info" title="该功能需要后端支持">
              备份列表接口（/backups）尚未实现，暂时无法展示备份文件。
            </Notice>
          </div>
        ) : (
          <Table<BackupItem>
            columns={columns}
            rows={backupsQuery.data ?? []}
            rowKey={(b) => b.volid}
            loading={backupsQuery.isLoading}
            caption={`虚拟机 ${vmid} 的备份文件列表`}
            emptyTitle="暂无备份"
            emptyDescription="该虚拟机还没有备份文件，点击「立即备份」创建。"
            className="table-flush"
          />
        )}
      </Card>

      {/* 立即备份 */}
      <Modal
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        title="立即备份"
        description={`虚拟机 ${vm.name || vmid}（节点 ${node}）`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBackupOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={runBackup}
              loading={busy}
              disabled={!storage}
            >
              开始备份
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Select
            label="目标存储"
            required
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
            hint={
              backupStorages.length === 0
                ? '该节点没有支持备份的存储池'
                : undefined
            }
          />
          <Select
            label="备份模式"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { label: 'Snapshot（不中断服务）', value: 'snapshot' },
              { label: 'Suspend（短暂挂起）', value: 'suspend' },
              { label: 'Stop（停止后备份）', value: 'stop' },
            ]}
          />
          <Select
            label="压缩算法"
            value={compress}
            onChange={(e) => setCompress(e.target.value)}
            options={[
              { label: 'ZSTD（推荐，快且压缩率好）', value: 'zstd' },
              { label: 'LZO', value: 'lzo' },
              { label: 'GZIP', value: 'gzip' },
              { label: '不压缩', value: '0' },
            ]}
          />
          <Input
            label="备注"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="如 升级前全量备份"
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
            toast.error('VMID 无效', '请输入 100 以上的整数');
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
                title: `恢复备份到 VMID ${targetId}`,
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
        title="从备份恢复虚拟机"
        danger
        confirmText="开始恢复"
        loading={busy}
        requireText={restoreTarget ? String(restoreTarget.vmid) : undefined}
        message={
          <>
            即将从备份{' '}
            <strong>{restoreTarget?.volid.split('/').pop()}</strong> 恢复虚拟机。
            若目标 VMID 已存在，其数据将被覆盖，操作不可撤销。
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Input
            label="目标 VMID"
            required
            value={restoreVmid}
            onChange={(e) => setRestoreVmid(e.target.value.replace(/\D/g, ''))}
            mono
            hint="填写原 VMID 表示覆盖恢复；填写新 ID 表示恢复为新虚拟机"
          />
          <Select
            label="目标存储（可选）"
            value={restoreStorage}
            onChange={(e) => setRestoreStorage(e.target.value)}
            options={storageOptions}
            hint="留空则恢复到备份中记录的原始存储"
          />
          <div className="flex flex-col gap-8">
            <Checkbox
              checked={restoreStart}
              onChange={(e) => setRestoreStart(e.target.checked)}
              label="恢复完成后立即启动"
            />
            <Checkbox
              checked={restoreForce}
              onChange={(e) => setRestoreForce(e.target.checked)}
              label="强制覆盖同名磁盘（force）"
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
                title: '删除备份文件',
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
        title="删除备份文件"
        danger
        confirmText="删除"
        loading={busy}
        message={
          <>
            即将删除备份文件{' '}
            <strong>{deleteTarget?.volid.split('/').pop()}</strong>。
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
          后端尚未实现 /vms/{node}/{vmid}/rrddata 接口。
        </Notice>
      ) : null}

      {/* 实时读数：进入监控页第一眼就能看到当前负载 */}
      {latest ? (
        <div className="grid grid-4">
          <KpiCard
            label="CPU 使用率"
            value={`${latestCpu.toFixed(1)}%`}
            tone={
              usageTone(latestCpu)
            }
            progress={latestCpu}
            progressColor={usageColor(latestCpu)}
            hint={<span className="text-secondary">最近一次采样</span>}
          />
          <KpiCard
            label="内存已用"
            value={formatBytes(memUsed, 0)}
            hint={<span className="mono">/ {formatBytes(memTotal, 0)}</span>}
            tone={
              usageTone(latestMem)
            }
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
                  <div className="chart-title">客户机磁盘用量</div>
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
                      <span className="chart-stat-label">整体已用</span>
                    </div>
                    {diskUsage ? (
                      <div className="chart-stat">
                        <span className="chart-stat-value mono">
                          {formatBytes(diskUsage.used, 0)}
                        </span>
                        <span className="chart-stat-label">
                          共 {formatBytes(diskUsage.total, 0)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
                <span className="chart-legend-item fs-source">
                  经 Guest Agent 执行 df 读取
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
                      ariaLabel={`${fs.mountpoint} 使用率 ${fs.percent.toFixed(1)}%`}
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
      toast.success('已复制', '配置 JSON 已复制到剪贴板');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  const pendingNotImpl = isNotImplemented(pendingQuery.error);

  return (
    <div className="flex flex-col gap-20">
      <Card>
        <CardHeader
          title="原始配置"
          subtitle="来自 Proxmox /config 接口的完整 JSON"
          icon={<IconLayers size={16} />}
          actions={
            <>
              {lines.length > 40 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? '收起' : '展开全部'}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void copy()}>
                复制 JSON
              </Button>
            </>
          }
        />
        <pre className="code-block">{displayJson}</pre>
      </Card>

      <Card>
        <CardHeader
          title="待生效配置"
          subtitle="需要重启或关机后才会应用变更"
          icon={<IconAlert size={16} />}
        />
        {pendingNotImpl ? (
          <Notice tone="info" title="该功能需要后端支持">
            /vms/{node}/{vmid}/pending 接口尚未实现。
          </Notice>
        ) : pendingQuery.isLoading ? (
          <div className="skeleton" style={{ height: 60, borderRadius: 6 }} />
        ) : (pendingQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="没有待生效的配置"
            description="当前所有配置变更均已应用。"
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
                      待删除
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
