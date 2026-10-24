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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lxcApi, storagesApi } from '../api/endpoints';
import { setPageConnection } from '../api/client';
import { guestPower } from '../api/guests';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { Breadcrumb } from '../components/Topbar';
import { NicSpecTags } from '../components/NicSpecTags';
import { PoolIpSelect } from '../components/PoolIpSelect';
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
import { ConfirmDialog, useConfirm } from '../components/ui/ConfirmDialog';
import { DetailSkeleton } from '../components/ui/Spinner';
import { EmptyState, Notice } from '../components/ui/EmptyState';
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
  IconTerminal,
  IconInfo,
  IconMonitor,
  IconPause,
  IconConsole,
} from '../components/Icons';
import { LxcMoreMenu } from '../components/LxcMoreMenu';
import {
  formatBytes,
  formatDateTime,
  formatUptimeShort,
  parseSizeToBytes,
  parseTags,
  toPercent,
  usageColor,
  usageTone,
} from '../utils/format';
import { isRunning, isTransient, vmStatusMeta } from '../utils/status'
import { isDestructivePower, powerConfirmOptions } from '../utils/powerConfirm';
import { useT, type MessageKey } from '../i18n';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useSnapshotQuota } from '../hooks/useSnapshotQuota';
import type { RrdPoint, RrdTimeframe } from '../api/types';
import type { LxcMountConfig, LxcNetworkConfig } from '../api/types';

type TabKey = 'overview' | 'monitor' | 'network' | 'storage' | 'snapshot' | 'console';

/* 分区页签在组件内构造（文案随语言走），见 LxcDetail 里的 tabs */

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

/** PVE 的字节数可能是 number 也可能是字符串 */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* 容器网卡的参数标签要展示哪些字段：网桥 / IP / 网关 / MAC 上面已经写了，
   这里只补 VLAN、防火墙、MTU、限速这些原来没露面的。 */
const LXC_NIC_SPEC = ['vlan', 'firewall', 'mtu', 'rate'] as const;

/* Tab 清单带图标，与虚拟机详情页（VmDetail 的 TABS）同一套写法。
   胶囊分段控件只有纯文字：标签一多就分不清是「存储」还是「存储配置」，而且两页
   切换手感不一致会让人以为点进了别的页面。 */
const TABS: Array<{ key: TabKey; labelKey: MessageKey; icon: ReactNode }> = [
  { key: 'overview', labelKey: 'lxcDetail.tabOverview', icon: <IconInfo size={15} /> },
  /* 监控从概览里独立出来：四条曲线占满整页高度才读得清刻度，挤在概览底部
     既拉长了概览、又让人以为「概览」就是全部信息。位置与虚拟机详情的
     「监控」页签一致（VmDetail 的 TABS），两页切过去的肌肉记忆不会打架。 */
  { key: 'monitor', labelKey: 'lxcDetail.tabMonitor', icon: <IconMonitor size={15} /> },
  { key: 'network', labelKey: 'lxcDetail.tabNetwork', icon: <IconNetwork size={15} /> },
  { key: 'storage', labelKey: 'lxcDetail.tabStorage', icon: <IconStorage size={15} /> },
  { key: 'snapshot', labelKey: 'lxcDetail.tabSnapshot', icon: <IconSnapshot size={15} /> },
  { key: 'console', labelKey: 'lxcDetail.tabConsole', icon: <IconTerminal size={15} /> },
];

export function LxcDetail() {
  const t = useT();
  const { node = '', vmid = '' } = useParams<{ node: string; vmid: string }>();
  const ctId = Number(vmid);
  /* 这台容器属于哪条 PVE 连接（列表页跳转时带上）。设成页面级默认后，页面里所有
     请求都跟着走 —— 多连接部署下光有节点名判断不出该打哪台 PVE，落到「当前连接」
     会看到另一台机器上的同名容器，或者报 hostname lookup 失败。容器详情页原先
     没有这一步，列表带过来的 ?connection= 等于白带。

     旧链接兼容：跳控制台 / 快照时曾把 `?tab=…` 拼在连接 id 后面
     （见 api/guests.guestPath），书签与历史里可能还留着这种地址。 */
  const [searchParams, setSearchParams] = useSearchParams();
  const pageConnection = (searchParams.get('connection') ?? '').split('?')[0];
  useEffect(() => {
    setPageConnection(pageConnection);
    return () => setPageConnection('');
  }, [pageConnection]);
  const navigate = useNavigate();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  /* 关机 / 停止 / 重启前弹一次确认（见 utils/powerConfirm） */
  const [powerConfirmEl, confirmPower] = useConfirm();

  /* Tab 写进 URL：刷新、分享链接、浏览器前进后退都停在原来那个 Tab，
     与虚拟机详情页一致（见 VmDetail）。首屏也认 ?tab=，否则分享出去的一律
     落在概览。用 URLSearchParams 包一层是为了保住列表页带过来的 ?connection。 */
  const [tab, setTab] = useState<TabKey>(() => {
    const raw = searchParams.get('tab');
    return raw && TABS.some((item) => item.key === raw) ? (raw as TabKey) : 'overview';
  });
  const selectTab = (next: TabKey) => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const [pending, setPending] = useState(false);

  /* 容器是独立的一套权限（ct.*），与虚拟机的 vm.* 不通用 */
  const canPower = hasPermission('ct.power');
  const canConfig = hasPermission('ct.config');
  const canSnapshot = hasPermission('ct.snapshot');

  const queryKey = useMemo(() => ['lxc', node, ctId] as const, [node, ctId]);

  /* 未配置连接时不必发请求：页面会直接给出「去添加连接」的引导 */
  const pveReady = usePveReady();
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  const ctQuery = useQuery({
    queryKey,
    queryFn: () => lxcApi.detail(node, ctId),
    enabled: pveReady && Boolean(node) && Number.isFinite(ctId),
    refetchInterval: pveReady ? refresh : false,
  });

  /* 曲线数据由「监控」页签自己查（见文件末尾的 LxcMonitorTab）：概览不再画图，
     停留在概览时也就不必每小时桶地拉一次 rrddata。 */

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
  const doPower = async (
    action: 'start' | 'stop' | 'shutdown' | 'reboot' | 'suspend' | 'resume',
  ) => {
    /* 关机 / 停止 / 重启 / 挂起先确认：详情页里这几个按钮挨在一起，误点一下容器
       里的服务就断了。启动与恢复不拦 —— 它们不会让服务停下来。
       （isDestructivePower 已把 suspend 算进去，这里不必再单独判一次。） */
    if (isDestructivePower(action)) {
      const ok = await confirmPower(
        powerConfirmOptions(t, action, { name: ct?.name, vmid: ctId }, 'lxc'),
      );
      if (!ok) return;
    }
    const labels = {
      start: t('lxcDetail.powerStart'),
      stop: t('lxcDetail.powerStop'),
      shutdown: t('lxcDetail.powerShutdown'),
      reboot: t('lxcDetail.powerReboot'),
      /* 挂起 / 恢复与虚拟机共用同一套文案（power.*），不另立一份 */
      suspend: t('power.suspend'),
      resume: t('power.resume'),
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
  /* 快照额度（提示用）：只有管理员配了总额度时才显示，单机上限由后端按精确数字拒 */
  const snapQuota = useSnapshotQuota(snapOpen);
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

  /* 骨架与错误态都包在 .page 里，与虚拟机详情页一致 —— 否则加载过程中页面没有
     内容区留白，骨架是「贴着顶栏」出现的，和加载完成后的版面差一截。 */
  if (ctQuery.isLoading) {
    return (
      <div className="page">
        <DetailSkeleton />
      </div>
    );
  }
  if (ctQuery.isError || !ct) {
    return (
      <div className="page">
        <Breadcrumb
          items={[
            { label: t('lxcDetail.breadcrumbLxc'), to: '/lxc' },
            { label: ct?.name || `CT ${ctId}` },
          ]}
        />
        <PveQueryError
          title={t('lxcDetail.loadFailed')}
          error={ctQuery.error}
          onRetry={() => void ctQuery.refetch()}
        />
        <Button variant="secondary" onClick={() => navigate('/lxc')}>
          {t('vmDetail.backToList')}
        </Button>
      </div>
    );
  }

  const status = vmStatusMeta(ct.status, t);
  const running = isRunning(ct.status);
  /* 挂起中的容器要单独给一个「恢复」按钮 —— 它既不算运行也不算停止，
     少了这个出口就只能去列表页操作。取值与虚拟机详情页同一口径。 */
  const frozen = ct.status === 'paused' || ct.status === 'suspended';
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
      render: (r) => (r.snaptime ? formatDateTime(Number(r.snaptime)) : '-'),
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
        /* 加上 flex-wrap：现在这一排有「刷新 / 编辑配置 / 重启 / 关机 / 停止 /
           挂起 / 控制台 / 更多操作」八个控件，窄屏上排不下时要能自己换行，
           否则会顶出页面宽度（虚拟机的 .detail-actions 本来就带 wrap）。 */
        <div className="flex items-center gap-8 flex-wrap">
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
              {/* 挂起用 ghost：它不终止服务、之后可以恢复，不该和上面三个
                  会断服务的按钮抢同一个视觉权重（与虚拟机详情页一致） */}
              <Button
                variant="ghost"
                icon={<IconPause size={14} />}
                disabled={!canPower || busy}
                onClick={() => void doPower('suspend')}
              >
                {t('power.suspend')}
              </Button>
              <Button
                variant="secondary"
                icon={<IconConsole size={14} />}
                onClick={() => selectTab('console')}
              >
                {t('lxcDetail.tabConsole')}
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
          {frozen ? (
            <Button
              variant="primary"
              icon={<IconPlay size={15} />}
              disabled={!canPower || busy}
              onClick={() => void doPower('resume')}
            >
              {t('power.resume')}
            </Button>
          ) : null}
          {/* 低频与危险操作（克隆 / 转模板 / 迁移 / 删除）收进「更多操作」：
              常驻在标题栏会把开机 / 关机 / 控制台这几个主操作挤散，而删除摆在
              最显眼处也不合适（见 LxcMoreMenu）。 */}
          <LxcMoreMenu
            ct={ct}
            connectionId={pageConnection}
            onDelete={() => setDeleteOpen(true)}
            onChanged={invalidate}
          />
        </div>
      }
    >
      {/* ---- Tab 导航：与虚拟机详情页同一套 .tabs / .tab ---- */}
      <div className="tabs" role="tablist" aria-label={t('lxcDetail.tabsAria')}>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => selectTab(item.key)}
          >
            {item.icon}
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="tab-panel">

      {/* ==================== 概览 ====================
           骨架与虚拟机详情页的 OverviewTab 逐块对齐：KPI 行跨满 → 左「基本信息」
           / 右「存储 + 网卡」两列等高。曲线不在这里 —— 已独立成「监控」页签。

           原来这里写的是 `.kpi-grid` 与 `.chart-stack` —— **这两个类全仓库都没有
           CSS 定义**。没有网格容器，4 张 KPI 卡就是 4 个整宽块级元素竖着堆，
           四张图也在右栏里一路排下去；虚拟机那边是 3 张并排 + 2×2 图表网格。
           两页看起来像两个产品，就是这两个类名断链造成的。 */}
      {tab === 'overview' ? (
        <div className="detail-columns is-balanced">
          {/* ---- 实时资源：跨两列铺开 ---- */}
          <div className="grid grid-4 detail-full">
            <KpiCard
              label="CPU"
              value={`${cpuPct.toFixed(1)}%`}
              icon={<IconCpu size={16} />}
              tone={usageTone(cpuPct)}
              progress={Math.min(100, cpuPct)}
              progressColor={usageColor(cpuPct)}
              hint={<span className="mono">{t('lxcDetail.kpiCpuHint', { n: ct.cpus ?? 1 })}</span>}
            />
            <KpiCard
              label={t('lxcDetail.kpiMem')}
              value={`${memPct.toFixed(1)}%`}
              icon={<IconMemory size={16} />}
              tone={usageTone(memPct)}
              progress={memPct}
              progressColor={usageColor(memPct)}
              hint={
                <span className="mono">
                  {formatBytes(toNumber(ct.mem))} / {formatBytes(toNumber(ct.maxmem))}
                </span>
              }
            />
            <KpiCard
              label={t('lxcDetail.kpiDisk')}
              value={`${diskPct.toFixed(1)}%`}
              icon={<IconStorage size={16} />}
              tone={usageTone(diskPct)}
              progress={diskPct}
              progressColor={usageColor(diskPct)}
              hint={
                <span className="mono">
                  {formatBytes(toNumber(ct.disk))} / {formatBytes(toNumber(ct.maxdisk))}
                </span>
              }
            />
            {/* 运行时长没有「占比」可谈，因此不给 tone / progressColor ——
                三个百分比的卡走绿→黄→红分档，这张若也上色就分不清它量的是什么 */}
            <KpiCard
              label={t('lxcDetail.kpiUptime')}
              value={formatUptimeShort(ct.uptime)}
              icon={<IconLayers size={16} />}
              hint={running ? t('lxcDetail.running') : t('lxcDetail.stopped')}
            />
          </div>

          <div className="detail-column">
            <Card collapsible={false} className="vm-basic-info">
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
          </div>

          {/* ---- 右列：存储 + 网卡 ----
              与虚拟机概览右列同构（那边是「磁盘 + 网络」，用同一套 .hw-item 视觉
              语言）。数据不用额外请求：rootfs / mounts / networks 本来就在这份
              详情里，之前只是没往概览上摆。 */}
          <div className="detail-column">
            <Card collapsible={false}>
              <CardHeader
                title={t('lxcDetail.storageCard')}
                subtitle={t('lxcDetail.storageSubtitle', {
                  count: ct.mounts.length + 1,
                  size: formatBytes(toNumber(ct.maxdisk), 0),
                })}
                icon={<IconStorage size={16} />}
              />
              {ct.rootfs?.volid || ct.rootfs?.size || ct.mounts.length ? (
                <div className="flex flex-col">
                  {ct.rootfs?.volid || ct.rootfs?.size ? (
                  <div className="hw-item">
                    <div className="hw-item-main">
                      <span className="hw-item-icon">
                        <IconStorage size={15} />
                      </span>
                      <div className="hw-item-text">
                        <span className="hw-item-label">rootfs</span>
                        <span className="hw-item-value">
                          {formatBytes(parseSizeToBytes(ct.rootfs.size))}
                          {ct.rootfs.storage ? ` · ${ct.rootfs.storage}` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}
                {ct.mounts.map((m, i) => (
                  <div className="hw-item" key={m.mp || m.volid || i}>
                    <div className="hw-item-main">
                      <span className="hw-item-icon">
                        <IconStorage size={15} />
                      </span>
                      <div className="hw-item-text">
                        <span className="hw-item-label">{m.mp || `mp${i}`}</span>
                        <span className="hw-item-value">
                          {m.size ? formatBytes(parseSizeToBytes(m.size)) : '—'}
                          {m.storage ? ` · ${m.storage}` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
                </div>
              ) : (
                <EmptyState title={t('lxcDetail.noStorage')} compact />
              )}
            </Card>

            <Card collapsible={false}>
              <CardHeader
                title={t('lxcDetail.network')}
                subtitle={t('lxcDetail.nicCount', { count: ct.networks.length })}
                icon={<IconNetwork size={16} />}
              />
              {ct.networks.length === 0 ? (
                <EmptyState title={t('lxcDetail.noNics')} compact />
              ) : (
                <div className="flex flex-col">
                  {ct.networks.map((n) => (
                    <div className="hw-item" key={n.interface}>
                      <div className="hw-item-main">
                        <span className="hw-item-icon">
                          <IconNetwork size={15} />
                        </span>
                        <div className="hw-item-text">
                          <span className="hw-item-label">
                            {n.interface}
                            {n.name ? ` · ${n.name}` : ''}
                          </span>
                          <span className="hw-item-value">
                            {n.bridge || t('vmDetail.noBridge')}
                            {n.ip ? ` · ${n.ip}` : ''}
                            {n.gw ? ` · ${n.gw}` : ''}
                          </span>
                          {n.hwaddr ? (
                            <span className="fs-xs text-muted mono">{n.hwaddr}</span>
                          ) : null}
                          {/* 上面是「通到哪」，下面补 PVE 后台会列的其余参数：
                              VLAN / 防火墙 / MTU / 限速。 */}
                          <NicSpecTags spec={n} fields={LXC_NIC_SPEC} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* 曲线不在这里了：四条 RRD 曲线已独立成「监控」页签（见 LxcMonitorTab），
              概览只放读数与配置，切过去看趋势。 */}
        </div>
      ) : null}

      {/* ==================== 监控 ==================== */}
      {tab === 'monitor' ? (
        <LxcMonitorTab node={node} ctId={ctId} enabled={Boolean(node) && Number.isFinite(ctId)} />
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
      </div>

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
          {/* 从地址池挑一个空闲地址，省得去「网络」页抄一遍（抄错一位就不通）。
              网关留空时保持用户已经填的值 —— 池没配网关时不该把人家填的清掉 */}
          <PoolIpSelect
            enabled={netOpen}
            scope={{
              node,
              connection: pageConnection,
              bridge: netForm.bridge,
              vlan: netForm.vlanTag ? Number(netForm.vlanTag) : null,
            }}
            onPick={(ip, gw) =>
              setNetForm((form) => ({ ...form, ip, gateway: gw || form.gateway }))
            }
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
            <Button
              variant="primary"
              loading={pending}
              onClick={() => void submitSnapshot()}
              disabled={snapQuota.blocked}
              title={
                snapQuota.blocked
                  ? t('guestList.snap.quotaUsedUp', { limit: Number(snapQuota.limit) })
                  : undefined
              }
            >
              {t('common.create')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          {/* 快照额度：只在管理员配了总额度时出现 */}
          {snapQuota.limited ? (
            <Notice tone={snapQuota.blocked ? 'warning' : 'info'}>
              {snapQuota.blocked
                ? t('guestList.snap.quotaUsedUp', { limit: Number(snapQuota.limit) })
                : t('guestList.snap.quotaRemaining', { n: Number(snapQuota.remaining ?? 0) })}
            </Notice>
          ) : null}
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

      {/* 电源操作确认（关机 / 停止 / 重启）：启动不经过这里（见 doPower） */}
      {powerConfirmEl}

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

/* ---------------------------------------------------------------------------
   监控页签

   四条 RRD 曲线（CPU / 内存 / 网络 / 磁盘 IO）原来压在概览底部：要滚过整块
   配置信息才看得到曲线，而概览也因此显得没有重点。独立成页后，两条路径各自
   只说自己那件事。

   数据由本组件自己查：停在概览时不再顺带拉一次 rrddata（原来 enabled 绑的是
   tab === 'overview'，等于每次进概览都为图形付一次请求）。

   时间范围只影响本页、不写进 URL —— 与虚拟机详情的 MonitorTab 口径一致：
   页签本身已经进了 URL（?tab=monitor），范围属于浏览时的一次性选择。
   --------------------------------------------------------------------------- */
function LxcMonitorTab({
  node,
  ctId,
  enabled,
}: {
  node: string;
  ctId: number;
  enabled: boolean;
}) {
  const t = useT();
  const [timeframe, setTimeframe] = useState<RrdTimeframe>('hour');

  const rrdQuery = useQuery<RrdPoint[]>({
    queryKey: ['lxc', node, ctId, 'rrd', timeframe],
    queryFn: () => lxcApi.rrddata(node, ctId, timeframe),
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  return (
    <div className="flex flex-col gap-20">
      <div className="flex items-center justify-between gap-12 flex-wrap">
        {/* .card-title 而不是 CardHeader：CardHeader 自带下边框与 14px 外边距，
            脱离卡片单独摆在工具行里会画出一条悬空的横线 */}
        <span className="card-title">
          <IconMonitor size={16} />
          {t('lxcDetail.monitor')}
        </span>
        <SegmentedControl<RrdTimeframe>
          value={timeframe}
          onChange={setTimeframe}
          ariaLabel={t('lxcDetail.monRangeAria')}
          options={[
            { label: t('lxcDetail.tfHour'), value: 'hour' },
            { label: t('lxcDetail.tfDay'), value: 'day' },
            { label: t('lxcDetail.tfWeek'), value: 'week' },
            { label: t('lxcDetail.tfMonth'), value: 'month' },
          ]}
        />
      </div>

      {/* 与虚拟机「监控」页签同一套 .monitor-grid（charts.css）：两列网格 +
          卡片专属内边距 + 悬停描边，四张图正好 2×2 */}
      <div className="monitor-grid">
        <Card>
          <CpuChart
            points={rrdQuery.data ?? []}
            loading={rrdQuery.isLoading}
            error={rrdQuery.error}
          />
        </Card>
        <Card>
          <MemoryChart
            points={rrdQuery.data ?? []}
            loading={rrdQuery.isLoading}
            error={rrdQuery.error}
          />
        </Card>
        <Card>
          <NetworkChart
            points={rrdQuery.data ?? []}
            loading={rrdQuery.isLoading}
            error={rrdQuery.error}
          />
        </Card>
        <Card>
          <DiskIoChart
            points={rrdQuery.data ?? []}
            loading={rrdQuery.isLoading}
            error={rrdQuery.error}
          />
        </Card>
      </div>
    </div>
  );
}
