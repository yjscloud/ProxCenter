/* ==========================================================================
   ProxCenter — 虚拟机 / 容器列表（同一套实现，按 kind 成页）
   ==========================================================================

「虚拟机」页与「容器」页共用这份实现。两边除了「列的是什么」以外，表格列、
批量操作、克隆 / 迁移 / 快照 / 删除 / 指派对话框的形状完全一致，强行拆成两份
1700 行的文件只会让改一处漏一处。

差异全部收在下面两处：
  * `KIND_META` —— 文案、量词、标题图标、创建按钮、空列表引导；
  * `kind === 'lxc'` 分支 —— 容器没有的能力（转模板、链接克隆、快照内存状态）。

数据来源也随 kind 分开：容器走 `GET /lxc`（只返回容器），虚拟机走
`GET /vms?type=qemu`。两条链路各自的缓存键独立，互不串数据。
*/

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  exportUrl,
  lxcApi,
  nodesApi,
  usersApi,
  vmMetaApi,
  vmMetaKey,
  vmsApi,
} from '../api/endpoints';
import { guestPath, guestPower, guestsApi, guestTypeOf } from '../api/guests';
import { BulkResultNotice, bulkActionLabel } from '../components/BulkResultNotice';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Badge, TagList } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
  Checkbox,
  Field,
  Input,
  RadioGroup,
  Select,
  Switch,
} from '../components/ui/Input';
import { Table, type Column, type SortState } from '../components/ui/Table';
import { useColumnSettings } from '../components/ui/ColumnSettings';
import { InlineMeter } from '../components/ui/ProgressBar';
import { ErrorState, Notice } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { VmCreateWizard } from '../components/VmCreateWizard';
import { LxcCreateWizard } from '../components/LxcCreateWizard';
import {
  IconBox,
  IconVm,
  IconRefresh,
  IconSearch,
  IconPlay,
  IconPower,
  IconStop,
  IconRestart,
  IconConsole,
  IconTrash,
  IconCopy,
  IconTemplate,
  IconSnapshot,
  IconLayers,
  IconUser,
  IconMore,
  IconPlus,
  IconDownload,
  IconEdit,
} from '../components/Icons';
import {
  formatBytes,
  formatUptimeShort,
  parseTags,
  toPercent,
} from '../utils/format';
import { isRunning, isStopped, isTransient, vmStatusMeta } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  BulkAction,
  BulkParams,
  BulkResponse,
  VmSummary,
} from '../api/types';
import { Modal } from '../components/ui/Modal';

type StatusFilter = 'all' | 'running' | 'stopped' | 'template';

/** 列表要有两种：虚拟机（qemu）/ 容器（lxc） */
export type GuestKind = 'qemu' | 'lxc';

interface KindMeta {
  /** 页面标题与文案里的名词 */
  noun: string;
  /** 量词 */
  unit: string;
  /** 页面标题图标 */
  titleIcon: ReactNode;
  /** 创建按钮文案 */
  createLabel: string;
  /** 创建按钮图标 */
  createIcon: ReactNode;
  /** 空列表引导文案 */
  emptyDescription: string;
  /** 详情页无法定位 guest 时的兜底前缀（VM 100 / CT 100） */
  codePrefix: string;
  /** 克隆时「新名称」输入框的占位文案 */
  cloneNamePlaceholder: string;
}

const KIND_META: Record<GuestKind, KindMeta> = {
  qemu: {
    noun: '虚拟机',
    unit: '台',
    titleIcon: <IconVm size={20} />,
    createLabel: '创建虚拟机',
    createIcon: <IconPlus size={15} />,
    emptyDescription: '集群中还没有创建任何虚拟机，点击「创建虚拟机」开始。',
    codePrefix: 'VM',
    cloneNamePlaceholder: '克隆后的虚拟机名称',
  },
  lxc: {
    noun: '容器',
    unit: '个',
    titleIcon: <IconBox size={20} />,
    createLabel: '创建容器',
    createIcon: <IconBox size={15} />,
    emptyDescription: '集群中还没有创建任何容器，点击「创建容器」开始。',
    codePrefix: 'CT',
    cloneNamePlaceholder: '克隆后的容器主机名',
  },
};

/* ---------------------------------------------------------------------------
   指派归属：管理员把 guest 交给某个用户
   存量 guest 在创建时没有记录归属，严格隔离下普通用户看不到它们，
   管理员可以用这个操作把某台机器交给指定用户（或清除归属）。
   --------------------------------------------------------------------------- */

function AssignOwnerDialog({
  vm,
  noun,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  /** 「虚拟机」/「容器」，用于对话框文案 */
  noun: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    enabled: Boolean(vm),
    staleTime: 60_000,
    retry: false,
  });

  /* 打开时读取当前归属 */
  useEffect(() => {
    if (!vm) return;
    setBusy(false);
    setLoading(true);
    guestsApi
      .getOwner(vm, vm.connection_id)
      .then((res) => setUsername(res.owner ?? ''))
      .catch(() => setUsername(''))
      .finally(() => setLoading(false));
  }, [vm]);

  const options = [
    { label: '不指派（清除归属，仅管理员可见）', value: '' },
    ...(usersQuery.data ?? [])
      // 待审批 / 已拒绝的账号还登不进来，指派给他没有意义
      .filter((u) => u.enabled !== false && (u.status ?? 'active') === 'active')
      .map((u) => ({ label: `${u.username}（${u.role}）`, value: u.username })),
  ];

  const submit = async () => {
    if (!vm) return;
    setBusy(true);
    try {
      const res = await guestsApi.assignOwner(
        vm,
        username || null,
        vm.connection_id,
      );
      toast.success(
        res.owner ? `已指派${noun}` : '已清除归属',
        res.owner
          ? `${vm.name || `${noun} ${vm.vmid}`} → ${res.owner}`
          : vm.name || `${noun} ${vm.vmid}`,
      );
      onDone();
    } catch (err) {
      toast.error('指派失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={onClose}
      title={`指派${noun}归属`}
      description={`指派后该用户即可看到并管理这台${noun}；选「不指派」则清除归属`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            保存
          </Button>
        </>
      }
    >
      <Field label="指派给" hint={loading ? '正在读取当前归属…' : undefined}>
        <Select
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          options={options}
        />
      </Field>
    </Modal>
  );
}

interface RowMenuProps {
  vm: VmSummary;
  kind: GuestKind;
  onClone: () => void;
  onTemplate: () => void;
  onSnapshot: () => void;
  onMigrate: () => void;
  onAssign: () => void;
  onDelete: () => void;
  disabled: boolean;
  /** 是否显示「指派归属」（仅管理员可用该操作） */
  canAssign: boolean;
}

function RowMenu({
  vm,
  kind,
  onClone,
  onTemplate,
  onSnapshot,
  onMigrate,
  onAssign,
  onDelete,
  disabled,
  canAssign,
}: RowMenuProps) {
  const meta = KIND_META[kind];
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /* fixed 定位坐标（视口系）。表格容器是 overflow 裁剪上下文，行内 absolute
     菜单在列表较长时会被容器/视口底边裁掉；fixed 脱离裁剪，并按空间翻转。 */
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  /* 打开期间：点击外部、任意滚动（含容器内滚动）、窗口尺寸变化都关闭 ——
     fixed 菜单不随内容滚动移动，留着只会错位。 */
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  /* 菜单挂载后按真实高度修正方向：下方放不下且上方更宽裕则翻到按钮上方。
     同一帧内完成同步布局，视觉无闪烁。top 为 undefined 表示已向上，只翻一次。 */
  useLayoutEffect(() => {
    if (!open || !pos || pos.top === undefined) return;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - a.bottom;
    if (spaceBelow < menu.offsetHeight + 12 && a.top > spaceBelow) {
      setPos({ bottom: window.innerHeight - a.top + 4, right: pos.right });
    }
  }, [open, pos]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    setPos({
      top: rect ? rect.bottom + 4 : undefined,
      right: rect ? Math.max(8, window.innerWidth - rect.right) : 8,
    });
    setOpen(true);
  };

  const item = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      className={`dropdown-item ${danger ? 'dropdown-item-danger' : ''}`}
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        action();
      }}
      disabled={disabled}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <span
      className="row-menu"
      ref={anchorRef}
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton label="更多操作" onClick={toggle} disabled={disabled}>
        <IconMore size={16} />
      </IconButton>
      {open && pos ? (
        <div
          ref={menuRef}
          className="row-menu-dropdown"
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            bottom: pos.bottom,
            right: pos.right,
          }}
        >
          {item(`克隆${meta.noun}`, <IconCopy size={15} />, onClone)}
          {/* 容器没有「转模板」：PVE 的 pct 不提供这个能力 */}
          {kind === 'qemu' && !vm.template
            ? item('转为模板', <IconTemplate size={15} />, onTemplate)
            : null}
          {item('新建快照', <IconSnapshot size={15} />, onSnapshot)}
          {item('迁移到其他节点', <IconLayers size={15} />, onMigrate)}
          {canAssign
            ? item('指派给用户', <IconUser size={15} />, onAssign)
            : null}
          <div className="user-dropdown-divider" />
          {item(`删除${meta.noun}`, <IconTrash size={15} />, onDelete, true)}
        </div>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   列表页主体
   --------------------------------------------------------------------------- */

export function GuestListPage({ kind }: { kind: GuestKind }) {
  const meta = KIND_META[kind];
  const isLxc = kind === 'lxc';

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runner = useTaskRunner();
  const { canWrite, isAdmin } = useAuth();

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制到剪贴板', text);
    } catch {
      toast.error('复制失败', '浏览器不允许访问剪贴板');
    }
  };

  /* ---- 筛选状态 ---- */
  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState('');
  // 默认只看运行中的机器，与日常使用场景一致
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('running');
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  /* 快捷入口深链：仪表盘工作台的「创建虚拟机 / 创建容器」跳到 ?new=1，
     直接拉开创建向导，省掉「进列表 → 找按钮」两步。
     读完立刻把参数抹掉：否则用户关掉向导后一刷新，它又自己弹出来。 */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (canWrite) setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canWrite]);

  /* ---- 弹窗状态 ---- */
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<VmSummary | null>(null);
  const [templateTarget, setTemplateTarget] = useState<VmSummary | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<VmSummary | null>(null);
  const [snapshotTarget, setSnapshotTarget] = useState<VmSummary | null>(null);
  const [assignTarget, setAssignTarget] = useState<VmSummary | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  /* 手动填写 IP：平台识别不到时才开放（见 IP 列） */
  const [ipTarget, setIpTarget] = useState<VmSummary | null>(null);
  const [ipDraft, setIpDraft] = useState('');
  const [ipBusy, setIpBusy] = useState(false);
  /* 列表内改名（虚拟机的 name / 容器的主机名） */
  const [renameTarget, setRenameTarget] = useState<VmSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  /* 批量：需要额外参数的动作先弹窗收集；结果逐台回报，失败的可原地重试 */
  const [bulkDialog, setBulkDialog] = useState<BulkAction | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResponse | null>(null);
  /** 上一次批量用的参数 —— "仅重试失败的" 要带着它重放 */
  const lastBulkParams = useRef<BulkParams | undefined>(undefined);

  /* ---- 数据 ----
     两个页面各自的缓存键互不重叠：容器走 /lxc，虚拟机走 /vms?type=qemu。
     键里必须带 with-ip：仪表盘/模板/备份等页面用的是 ['vms','all'] 且不带
     with_ip，共用同一个键会导致先加载的那份缓存被复用，IP 列整列变空。 */
  const guestsQuery = useQuery({
    queryKey: isLxc
      ? ['lxc', 'with-ip', nodeFilter || 'all']
      : ['vms', 'with-ip', nodeFilter || 'all'],
    queryFn: () =>
      isLxc
        ? lxcApi.list(nodeFilter || undefined, { withIp: true })
        : vmsApi.list(nodeFilter || undefined, { withIp: true, type: 'qemu' }),
    refetchInterval: 10_000,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    staleTime: 60_000,
  });

  /* ---- 可下发剩余数量 ----
     虚拟机与容器各有一份额度（后端按类型分开记账），所以键里要带类型，
     否则两个页面会共用同一份读数。所有登录用户都能读：这是给「还能建几台」
     一个明确答案的地方，不必等提交后被 403 打回来。 */
  const quotaQuery = useQuery({
    queryKey: ['guests', 'quota', isLxc ? 'lxc' : 'vm'],
    queryFn: () => guestsApi.quota(isLxc ? 'lxc' : 'vm'),
    staleTime: 30_000,
    retry: false,
  });
  const quota = quotaQuery.data;
  /* 额度用尽：禁用创建入口，并在按钮上说明原因 */
  const quotaBlocked = Boolean(quota && !quota.can_create);

  /* ---- 手动 IP（面板侧补充信息）----
     Guest Agent 没开、容器又用 DHCP 时平台拿不到地址，这里读回运维手工填的那份。
     只作为**回落**展示：自动识别到的地址优先，因为它反映的是机器此刻的真实状态。 */
  const metaQuery = useQuery({
    queryKey: ['vm-meta'],
    queryFn: vmMetaApi.list,
    staleTime: 60_000,
    retry: false,
  });
  const metaItems = useMemo(
    () => metaQuery.data?.items ?? {},
    [metaQuery.data],
  );
  const manualIpOf = useCallback(
    (vm: VmSummary) =>
      metaItems[vmMetaKey(vm.connection_id, vm.node, vm.vmid)]?.ip ?? '',
    [metaItems],
  );

  /* 多台 PVE 合并展示时同名节点会出现多次。筛选项按节点名去重
     （筛选本身就是按节点名匹配，跨主机同名节点会一起命中，行内会标出来源主机）。 */
  const nodeOptions = useMemo(() => {
    const names = Array.from(
      new Set((nodesQuery.data ?? []).map((n) => n.node)),
    ).sort();
    return [
      { label: '全部节点', value: '' },
      ...names.map((name) => ({ label: name, value: name })),
    ];
  }, [nodesQuery.data]);

  /* ---- 过滤 ---- */
  /* 搜索统一匹配「名称 / VMID / 节点 / IP / 标签 / 来源 PVE」。
     列表页的搜索框是「我只记得这台机器的一部分」时唯一的入口，只认名称等于
     逼用户先猜对字段名；IP 尤其重要 —— 排障时手里往往只有个地址。
     空格分隔按「与」处理：多敲一个词只会缩小范围，不会突然放宽。 */
  const filtered = useMemo(() => {
    const list = guestsQuery.data ?? [];
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return list.filter((vm) => {
      // 状态过滤
      if (statusFilter === 'running' && !isRunning(vm.status)) return false;
      if (statusFilter === 'stopped' && !isStopped(vm.status)) return false;
      if (statusFilter === 'template' && !vm.template) return false;
      if (statusFilter !== 'template' && vm.template) {
        // 非模板视图默认隐藏模板
        if (statusFilter === 'all') return false;
      }

      if (tokens.length === 0) return true;
      const haystack = [
        vm.name,
        String(vm.vmid),
        vm.node,
        vm.ip,
        // 手动填的地址也要能搜到：它往往是用户手上唯一记得的标识
        manualIpOf(vm),
        vm.tags,
        vm.connection_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [guestsQuery.data, search, statusFilter, manualIpOf]);

  /* ---- 选择 ---- */
  /* 多台 PVE 合并展示时，不同主机的同名节点/VMID 会撞车，键里必须带连接 */
  const rowKeyOf = (vm: VmSummary) =>
    `${vm.connection_id ?? ''}:${vm.node}/${vm.vmid}`;

  const allSelected =
    filtered.length > 0 && filtered.every((vm) => selected.has(rowKeyOf(vm)));
  const someSelected = filtered.some((vm) => selected.has(rowKeyOf(vm)));

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(rowKeyOf)));
    }
  };

  const toggleOne = (vm: VmSummary) => {
    const key = rowKeyOf(vm);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedGuests = useMemo(
    () => (guestsQuery.data ?? []).filter((vm) => selected.has(rowKeyOf(vm))),
    [guestsQuery.data, selected],
  );

  /* 筛选变化时清理已不可见的选择 */
  useEffect(() => {
    const visible = new Set(filtered.map(rowKeyOf));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => visible.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  /* ---- 刷新 ----
     两个列表是独立缓存，这里始终把 ['vms'] 与 ['lxc'] 一起失效：
     电源 / 克隆等动作在两边都可能改到对方列表里的行（例如容器页操作，
     虚拟机页的统计数字也会变），只刷自己这一份会留下过期数据。 */
  const invalidateGuests = useCallback(
    (guest?: VmSummary) => {
      void queryClient.invalidateQueries({ queryKey: ['vms'] });
      void queryClient.invalidateQueries({ queryKey: ['lxc'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
      if (guest) {
        void queryClient.invalidateQueries({
          queryKey: [isLxc ? 'lxc' : 'vm', guest.node, guest.vmid],
        });
      }
    },
    [queryClient, isLxc],
  );

  const doPower = useCallback(
    async (vm: VmSummary, action: 'start' | 'stop' | 'shutdown' | 'reboot') => {
      if (!canWrite) {
        toast.warning('权限不足', '当前角色不允许执行电源操作');
        return;
      }
      const labels: Record<typeof action, string> = {
        start: '启动',
        stop: '停止',
        shutdown: '关机',
        reboot: '重启',
      };
      // 容器与虚拟机是两套 PVE 端点，按类型分派
      const call: Record<typeof action, () => Promise<{ task?: string }>> = {
        start: () => guestPower.start(vm),
        stop: () => guestPower.stop(vm),
        shutdown: () => guestPower.shutdown(vm, 60, false),
        reboot: () => guestPower.reboot(vm),
      };

      try {
        await runner.run(call[action](), {
          title: `${labels[action]}「${vm.name || vm.vmid}」`,
          node: vm.node,
          invalidate: [
            ['vms'],
            ['lxc'],
            [isLxc ? 'lxc' : 'vm', vm.node, vm.vmid],
            ['cluster'],
          ],
        });
      } catch {
        /* toast 已提示 */
      }
    },
    [canWrite, runner, toast, isLxc],
  );

  /* ---- 批量操作 ----
     交给后端一次跑完并逐台回报：
     * 前端循环会把 N 台变成 N 次往返 + N 个 toast，中途失败也说不清动了几台；
     * 归属校验、按目标解析 PVE 连接这些只能在服务端做（前端拿不到全部连接信息）；
     * 后端返回逐台清单，失败的留在选择里，可以「仅重试失败的」。 */
  const runBulk = useCallback(
    async (action: BulkAction, params?: BulkParams) => {
      const targets = selectedGuests;
      if (targets.length === 0) return;

      setPendingAction(true);
      lastBulkParams.current = params;
      try {
        const result = await vmsApi.bulk({
          action,
          // type 带上就省掉后端一轮探测
          targets: targets.map((vm) => ({
            node: vm.node,
            vmid: vm.vmid,
            type: guestTypeOf(vm),
            name: vm.name,
          })),
          params,
        });
        setBulkResult(result);

        // 失败的留在选择里，方便直接重试；全成功才清空
        if (result.failed === 0) {
          setSelected(new Set());
          toast.success(`批量${bulkActionLabel(action)}完成`, `${result.ok} ${meta.unit}已处理`);
        } else {
          setSelected(
            new Set(
              result.results
                .filter((r) => !r.ok)
                .map((r) => `${r.node}/${r.vmid}`)
                .map((key) => {
                  const vm = targets.find((t) => `${t.node}/${t.vmid}` === key);
                  return vm ? rowKeyOf(vm) : key;
                }),
            ),
          );
        }
        invalidateGuests();
      } catch (err) {
        toast.error(`批量${bulkActionLabel(action)}失败`, errorMessage(err));
      } finally {
        setPendingAction(false);
      }
    },
    [selectedGuests, invalidateGuests, toast, meta.unit],
  );

  /* 只重跑上一次批量里失败的那几台：此时选择已被换成失败清单 */
  const retryFailed = useCallback(() => {
    if (!bulkResult) return;
    void runBulk(bulkResult.action, lastBulkParams.current);
  }, [bulkResult, runBulk]);

  /* ---- 单机删除 ---- */
  const confirmDelete = async () => {
    const vm = deleteTarget;
    if (!vm) return;
    setPendingAction(true);
    try {
      await runner.run(guestsApi.remove(vm), {
        title: `删除「${vm.name || vm.vmid}」`,
        node: vm.node,
        invalidate: [['vms'], ['lxc'], ['cluster'], ['storages']],
        destructive: true,
      });
      setDeleteTarget(null);
    } catch {
      /* toast 已提示 */
    } finally {
      setPendingAction(false);
    }
  };

  const confirmBulkDelete = async () => {
    setBulkDelete(false);
    await runBulk('delete', { purge: true });
  };

  /* ---- 改名 ----
     放在列表页而不是只留在详情页：按规范批量重命名时，用户是在列表里扫着改的，
     每台都要点进详情再点回列表，二十台就是四十次跳转。 */
  const openRename = (vm: VmSummary) => {
    setRenameTarget(vm);
    setRenameDraft(vm.name ?? '');
  };

  const saveRename = async () => {
    const vm = renameTarget;
    if (!vm) return;
    const name = renameDraft.trim();
    /* 名称合法与否最终由 PVE 说了算，这里只挡明显不合理的输入，
       让报错口径集中在一处（后端把 PVE 的原话带回来） */
    if (!name) {
      toast.warning('名称不能为空', `留空会让它退回显示 ${meta.codePrefix} ${vm.vmid}`);
      return;
    }
    if (name.length > 63) {
      toast.warning('名称过长', 'Proxmox 的名称上限是 63 个字符');
      return;
    }
    if (name === (vm.name ?? '')) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    try {
      await runner.run(guestsApi.rename(vm, name), {
        title: `重命名为「${name}」`,
        node: vm.node,
        invalidate: [
          ['vms'],
          ['lxc'],
          [isLxc ? 'lxc' : 'vm', vm.node, vm.vmid],
          ['vm-meta'],
        ],
      });
      setRenameTarget(null);
    } catch {
      /* toast 已提示 */
    } finally {
      setRenameBusy(false);
    }
  };

  /* ---- 手动 IP ---- */
  const openIpEditor = (vm: VmSummary) => {
    setIpTarget(vm);
    setIpDraft(manualIpOf(vm));
  };

  const saveManualIp = async () => {
    const vm = ipTarget;
    if (!vm) return;
    const ip = ipDraft.trim();
    // 只做「看着像个地址」的轻校验：这里存的是备注性质的展示值，
    // 过严的规则会把 IPv6、带掩码、主机名这些合法写法挡在外面。
    if (ip && (/\s/.test(ip) || ip.length > 64)) {
      toast.warning('IP 格式不正确', '不要包含空格，且不超过 64 个字符');
      return;
    }
    setIpBusy(true);
    try {
      await vmMetaApi.save({
        node: vm.node,
        vmid: vm.vmid,
        connection_id: vm.connection_id ?? null,
        ip,
      });
      await queryClient.invalidateQueries({ queryKey: ['vm-meta'] });
      toast.success(
        ip ? '已保存手动 IP' : '已清除手动 IP',
        ip ? `${vm.name || vm.vmid} → ${ip}` : '将回落到平台自动识别',
      );
      setIpTarget(null);
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setIpBusy(false);
    }
  };

  /* ---- 表格列 ----
     列清单在这里声明一次，「列设置」齿轮会据此渲染勾选项：
     表头是纯文本的列直接复用表头当菜单名，全选框（ReactNode）与操作列必须
     显式补 label / locked —— 前者念不出名字，后者被隐藏就再也删不了机器。 */
  const columns: Array<Column<VmSummary>> = [
    {
      key: 'select',
      label: '选择',
      locked: true,
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={!allSelected && someSelected}
          onChange={toggleAll}
          aria-label={`全选${meta.noun}`}
        />
      ),
      width: 44,
      render: (vm) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected.has(rowKeyOf(vm))}
            onChange={() => toggleOne(vm)}
            aria-label={`选择 ${vm.name || vm.vmid}`}
          />
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 108,
      render: (vm) => {
        const status = vmStatusMeta(vm.status);
        return (
          <Badge variant={status.variant} dot pulse={status.pulse} size="sm">
            {status.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (vm) => vm.status,
    },
    {
      key: 'vmid',
      header: 'VMID',
      width: 76,
      mono: true,
      render: (vm) => <span className="text-secondary">{vm.vmid}</span>,
      sortable: true,
      sortValue: (vm) => vm.vmid,
    },
    {
      key: 'name',
      header: '名称',
      /* 其余列都写死了宽度，名称列不写就会独占全部剩余空间，
         宽屏下被撑得很长；给一个上限后超出部分由 truncate 省略。
         178 = 原来的 160 + 改名按钮所占的宽度：按钮是 flex-shrink:0 的，
         不补回来的话名字会比加按钮之前更早被省略。 */
      width: 178,
      render: (vm) => (
        <div className="vm-name-cell">
          {/* 名称与改名按钮单独包一层横向行：.vm-name-cell 是纵向布局
              （名称在上、徽标在下），按钮直接放进去会掉到第二行，
              看起来像是在修饰下面那串徽标而不是名字。 */}
          <span className="vm-name-line">
            <span
              className="fw-500 truncate"
              title={vm.name || `${meta.codePrefix} ${vm.vmid}`}
            >
              {vm.name || `${meta.codePrefix} ${vm.vmid}`}
            </span>
            {/* 就地改名：编辑入口贴着被编辑的对象，比塞进「更多」菜单更好找。
                模板不给入口 —— 模板名改动会牵连克隆来源，属于要谨慎对待的操作。 */}
            {canWrite && !vm.template ? (
              <IconButton
                label={`重命名 ${vm.name || vm.vmid}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openRename(vm);
                }}
              >
                <IconEdit size={13} />
              </IconButton>
            ) : null}
          </span>
          {vm.template ? (
            <Badge variant="accent" size="sm">
              模板
            </Badge>
          ) : null}
          {vm.lock ? (
            <Badge variant="warning" size="sm" title={`锁定：${vm.lock}`}>
              锁定
            </Badge>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (vm) => vm.name ?? '',
    },
    {
      key: 'node',
      header: '节点',
      width: 110,
      render: (vm) => (
        <span className="fs-sm">
          {vm.node}
          {vm.connection_name ? (
            <span className="fs-xs text-muted"> · {vm.connection_name}</span>
          ) : null}
        </span>
      ),
      sortable: true,
      sortValue: (vm) => vm.node,
    },
    {
      key: 'ip',
      header: 'IP 地址',
      width: 190,
      render: (vm) => {
        const manual = manualIpOf(vm);
        const auto = vm.ip ?? '';
        /* 自动识别优先：它反映机器此刻的真实状态；
           手动值是回落，只在平台确实拿不到时顶上来。 */
        const shown = auto || manual;
        const fromManual = !auto && Boolean(manual);
        const missingHint = isLxc
          ? '未获取到 IP：容器只有 DHCP，没有静态地址配置'
          : '未获取到 IP：Guest Agent 未运行，且没有 Cloud-Init 静态地址配置';
        return (
          <div className="ip-cell" onClick={(e) => e.stopPropagation()}>
            {shown ? (
              <button
                type="button"
                className={`ip-copy mono fs-sm${fromManual ? ' is-manual' : ''}`}
                title={
                  fromManual
                    ? `手动填写${metaItems[vmMetaKey(vm.connection_id, vm.node, vm.vmid)]?.by ? `（由 ${metaItems[vmMetaKey(vm.connection_id, vm.node, vm.vmid)]?.by} 记录）` : ''} · 点击复制`
                    : '点击复制 IP'
                }
                onClick={() => void copyText(shown)}
              >
                {shown}
                {fromManual ? <span className="ip-manual-tag">手动</span> : null}
              </button>
            ) : (
              <span className="fs-sm text-muted" title={missingHint}>
                —
              </span>
            )}
            {/* 只在平台拿不到地址时给编辑入口：自动值更准，
                让它旁边常驻一个「改」按钮只会诱导用户改错 */}
            {!auto && canWrite ? (
              <IconButton
                label={`手动填写 ${vm.name || vm.vmid} 的 IP`}
                onClick={() => openIpEditor(vm)}
                title="平台未识别到 IP，可手动填写"
              >
                <IconEdit size={14} />
              </IconButton>
            ) : null}
          </div>
        );
      },
      sortable: true,
      sortValue: (vm) => vm.ip || manualIpOf(vm),
    },
    {
      key: 'cpu',
      header: 'CPU',
      width: 118,
      render: (vm) => {
        const pct = toPercent(vm.cpu);
        const running = isRunning(vm.status);
        return (
          <InlineMeter
            percent={pct}
            sub={`/ ${vm.maxcpu ?? 0} 核`}
            dim={!running}
            title={`${pct.toFixed(1)}% 使用率`}
            width={106}
          />
        );
      },
      sortable: true,
      sortValue: (vm) => vm.maxcpu ?? 0,
    },
    {
      key: 'mem',
      header: '内存',
      width: 142,
      render: (vm) => {
        const pct = vm.maxmem ? ((vm.mem ?? 0) / vm.maxmem) * 100 : 0;
        const running = isRunning(vm.status);
        return (
          <InlineMeter
            percent={pct}
            text={formatBytes(vm.mem, 0)}
            sub={`/ ${formatBytes(vm.maxmem, 0)}`}
            dim={!running}
            title={`${pct.toFixed(1)}% 使用率`}
            width={130}
          />
        );
      },
      sortable: true,
      sortValue: (vm) => vm.maxmem ?? 0,
    },
    {
      key: 'disk',
      header: '磁盘',
      width: 110,
      align: 'right',
      render: (vm) => (
        <span className="mono fs-sm">
          {vm.maxdisk ? formatBytes(vm.maxdisk, 0) : '—'}
        </span>
      ),
      sortable: true,
      sortValue: (vm) => vm.maxdisk ?? 0,
    },
    {
      key: 'uptime',
      header: '运行时长',
      width: 100,
      align: 'right',
      render: (vm) => (
        <span className="mono fs-sm text-secondary">
          {isRunning(vm.status) ? formatUptimeShort(vm.uptime) : '—'}
        </span>
      ),
      sortable: true,
      sortValue: (vm) => vm.uptime ?? 0,
    },
    {
      key: 'tags',
      header: '标签',
      width: 140,
      render: (vm) => <TagList tags={parseTags(vm.tags)} max={2} />,
    },
    {
      key: 'actions',
      header: '操作',
      /* 固定列：隐藏「操作」等于把启停、控制台、删除全部收走，
         用户只会以为面板坏了 */
      locked: true,
      width: 210,
      render: (vm) => {
        const running = isRunning(vm.status);
        const stopped = isStopped(vm.status);
        const frozen = vm.status === 'paused' || vm.status === 'suspended';
        const busy = isTransient(vm.status);
        const noWrite = !canWrite || busy || Boolean(vm.lock);

        return (
          <span className="row-actions" onClick={(e) => e.stopPropagation()}>
            {stopped ? (
              <IconButton
                label={`启动 ${vm.name}`}
                variant="primary"
                onClick={() => void doPower(vm, 'start')}
                disabled={noWrite}
              >
                <IconPlay size={15} />
              </IconButton>
            ) : null}

            {running ? (
              <>
                <IconButton
                  label={`关机 ${vm.name}`}
                  onClick={() => void doPower(vm, 'shutdown')}
                  disabled={noWrite}
                >
                  <IconPower size={15} />
                </IconButton>
                <IconButton
                  label={`停止 ${vm.name}`}
                  variant="danger"
                  onClick={() => void doPower(vm, 'stop')}
                  disabled={noWrite}
                >
                  <IconStop size={14} />
                </IconButton>
                <IconButton
                  label={`重启 ${vm.name}`}
                  onClick={() => void doPower(vm, 'reboot')}
                  disabled={noWrite}
                >
                  <IconRestart size={15} />
                </IconButton>
              </>
            ) : null}

            {frozen ? (
              <IconButton
                label={`恢复 ${vm.name}`}
                variant="primary"
                onClick={() =>
                  void runner.run(guestPower.resume(vm), {
                    title: `恢复「${vm.name || vm.vmid}」`,
                    node: vm.node,
                    invalidate: [
                      ['vms'],
                      ['lxc'],
                      [isLxc ? 'lxc' : 'vm', vm.node, vm.vmid],
                    ],
                  })
                }
                disabled={noWrite}
              >
                <IconPlay size={15} />
              </IconButton>
            ) : null}

            <IconButton
              label={`打开 ${vm.name} 控制台`}
              onClick={() => navigate(`${guestPath(vm)}?tab=console`)}
            >
              <IconConsole size={15} />
            </IconButton>

            <RowMenu
              vm={vm}
              kind={kind}
              disabled={!canWrite || busy}
              onClone={() => setCloneTarget(vm)}
              onTemplate={() => setTemplateTarget(vm)}
              onSnapshot={() => setSnapshotTarget(vm)}
              onMigrate={() => setMigrateTarget(vm)}
              onAssign={() => setAssignTarget(vm)}
              canAssign={isAdmin}
              onDelete={() => setDeleteTarget(vm)}
            />
          </span>
        );
      },
    },
  ];

  /* 列显隐与顺序：按账号存在 localStorage，虚拟机与容器各记一份
     （两边的列不完全一样，共用一份配置会互相打架）。 */
  const cols = useColumnSettings(columns, isLxc ? 'lxc' : 'vms');

  const hasError = guestsQuery.isError;

  return (
    <PageShell
      title={
        <>
          {meta.titleIcon}
          {meta.noun}
        </>
      }
      subtitle={
        guestsQuery.data
          ? `共 ${filtered.length} ${meta.unit}${
              selected.size > 0 ? ` · 已选 ${selected.size} ${meta.unit}` : ''
            }`
          : '正在加载…'
      }
      actions={
        <>
          {/* 导出走服务端流式 CSV：按「节点 + 类型」导出全量清单，并带上
              PVE 里没有的「归属人」列（合规盘点最常被问的就是这台机器归谁）。
              不受本页的搜索/状态筛选影响 —— 那些是前端在已加载数据上做的过滤。 */}
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={() =>
              window.open(
                exportUrl('vms', { type: kind, node: nodeFilter || undefined }),
                '_blank',
              )
            }
            title={`导出全部${meta.noun}清单（按当前节点筛选，含归属人）`}
          >
            导出清单
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void guestsQuery.refetch()}
            loading={guestsQuery.isFetching && !guestsQuery.isLoading}
          >
            刷新
          </Button>
          {canWrite ? (
            <Button
              variant="primary"
              icon={meta.createIcon}
              onClick={() => setCreateOpen(true)}
              disabled={quotaBlocked}
              title={
                quotaBlocked
                  ? `可下发${meta.noun}数量已用尽（上限 ${quota?.quota} ${meta.unit}），请联系管理员`
                  : undefined
              }
            >
              {meta.createLabel}
            </Button>
          ) : null}
        </>
      }
    >
      {/* ---- 批量结果回报 ---- */}
      {bulkResult ? (
        <BulkResultNotice
          result={bulkResult}
          retrying={pendingAction}
          onRetryFailed={retryFailed}
          onClose={() => setBulkResult(null)}
        />
      ) : null}

      {/* ---- 批量操作条 ---- */}
      {selected.size > 0 ? (
        <div className="bulk-bar">
          <span>
            已选择 <span className="bulk-bar-count">{selected.size}</span>{' '}
            {meta.unit}
            {meta.noun}
          </span>
          <div className="flex items-center gap-8 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPlay size={14} />}
              disabled={pendingAction}
              onClick={() => void runBulk('start')}
            >
              启动
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPower size={14} />}
              disabled={pendingAction}
              onClick={() => void runBulk('shutdown')}
            >
              关机
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconRestart size={14} />}
              disabled={pendingAction}
              onClick={() => void runBulk('reboot')}
            >
              重启
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconStop size={14} />}
              disabled={pendingAction}
              onClick={() => void runBulk('stop')}
            >
              强制停止
            </Button>

            {/* 需要额外参数的动作走这个下拉：直接铺按钮会把操作条挤爆 */}
            <Select
              value=""
              onChange={(e) => {
                const action = e.target.value as BulkAction;
                if (action) setBulkDialog(action);
              }}
              disabled={pendingAction}
              options={[
                { label: '更多批量操作…', value: '' },
                { label: '批量打标签', value: 'tag' },
                { label: '批量迁移到其他节点', value: 'migrate' },
                { label: '批量创建快照', value: 'snapshot' },
              ]}
              aria-label="更多批量操作"
            />

            <Button
              variant="danger"
              size="sm"
              icon={<IconTrash size={14} />}
              disabled={pendingAction}
              onClick={() => setBulkDelete(true)}
            >
              删除
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pendingAction}
            >
              取消选择
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- 工具栏 + 表格 ---- */}
      <div>
        <div className="toolbar">
          <div className="toolbar-left">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索名称 / VMID / 节点 / IP / 标签"
              title="支持按名称、VMID、节点、IP、标签、来源 PVE 搜索，空格分隔多个条件"
              prefix={<IconSearch size={15} />}
              block={false}
              aria-label={`搜索${meta.noun}（名称、VMID、节点、IP、标签）`}
            />
            <Select
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              options={nodeOptions}
              aria-label="按节点筛选"
            />
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              options={[
                { label: '全部状态', value: 'all' },
                { label: '运行中', value: 'running' },
                { label: '已停止', value: 'stopped' },
                { label: '模板', value: 'template' },
              ]}
              aria-label="按状态筛选"
            />
          </div>
          <div className="toolbar-right">
            {/* 可下发剩余：额度只在管理员设过时才存在；没设就写「不限」。
                用尽时变红 —— 它同时解释了「为什么创建按钮是灰的」。 */}
            {quota ? (
              <span
                className={`quota-chip${quotaBlocked ? ' is-empty' : ''}`}
                title={
                  quota.limited
                    ? `${meta.noun}额度 ${quota.quota} ${meta.unit}，当前已用 ${quota.used} ${meta.unit}`
                    : '管理员没有设置下发额度，可无限创建'
                }
              >
                {!quota.limited
                  ? '可下发不限'
                  : quotaBlocked
                    ? `已用尽 ${quota.used}/${quota.quota}`
                    : `可下发剩余 ${quota.remaining} ${meta.unit}`}
              </span>
            ) : null}
            <span className="fs-sm text-muted">
              显示 {filtered.length} / {(guestsQuery.data ?? []).length} {meta.unit}
            </span>
          </div>
        </div>

        {hasError ? (
          <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            <ErrorState
              title={`无法加载${meta.noun}列表`}
              message={errorMessage(guestsQuery.error)}
              onRetry={() => void guestsQuery.refetch()}
            />
          </div>
        ) : (
          <Table<VmSummary>
            columns={cols.columns}
            columnMenu={cols.menu}
            rows={filtered}
            rowKey={rowKeyOf}
            loading={guestsQuery.isLoading}
            caption={`${meta.noun}列表，包含状态、规格、资源占用与操作`}
            sort={sort}
            onSortChange={setSort}
            onRowClick={(vm) => navigate(guestPath(vm))}
            isRowSelected={(vm) => selected.has(rowKeyOf(vm))}
            emptyTitle={
              search || statusFilter !== 'all'
                ? `没有匹配的${meta.noun}`
                : `暂无${meta.noun}`
            }
            emptyDescription={
              search || statusFilter !== 'all'
                ? '尝试调整搜索关键词或筛选条件。'
                : meta.emptyDescription
            }
            emptyAction={
              canWrite && !search ? (
                <Button
                  variant="primary"
                  icon={meta.createIcon}
                  onClick={() => setCreateOpen(true)}
                  disabled={quotaBlocked}
                  title={
                    quotaBlocked
                      ? `可下发${meta.noun}数量已用尽（上限 ${quota?.quota} ${meta.unit}），请联系管理员`
                      : undefined
                  }
                >
                  {meta.createLabel}
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {/* ---- 改名 ----
          虚拟机的名字是 PVE 配置里的 `name`；容器没有独立的 name，
          它的名字就是主机名 `hostname`。两边的字段名由 guestsApi.rename 收口。 */}
      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title={isLxc ? '修改容器名称' : '修改虚拟机名称'}
        description={
          renameTarget
            ? `${meta.codePrefix} ${renameTarget.vmid} · ${renameTarget.node}`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRenameTarget(null)}
              disabled={renameBusy}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void saveRename()} loading={renameBusy}>
              保存
            </Button>
          </>
        }
      >
        <Input
          label={isLxc ? '主机名' : '名称'}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          placeholder={`${meta.codePrefix} ${renameTarget?.vmid ?? ''}`}
          maxLength={63}
          autoFocus
          hint={
            isLxc
              ? `容器的名称即主机名，列表与 PVE 里显示的都是它。当前：${renameTarget?.name || '未设置'}`
              : `当前名称：${renameTarget?.name || '未设置'} · 最多 63 个字符`
          }
        />
      </Modal>

      {/* ---- 手动填写 IP ----
          面板侧保存，用于补齐「Guest Agent 没开 / 容器走 DHCP」时看不到地址的场景。
          它不会写回 PVE 的网络配置 —— 只是给运维一个能记事的字段。 */}
      <Modal
        open={Boolean(ipTarget)}
        onClose={() => setIpTarget(null)}
        title="手动填写 IP 地址"
        description={
          ipTarget
            ? `${ipTarget.name || `${meta.codePrefix} ${ipTarget.vmid}`} · ${ipTarget.node}`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIpTarget(null)}
              disabled={ipBusy}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void saveManualIp()} loading={ipBusy}>
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Notice tone="info" title="这是面板侧的记录，不会改动机器">
            {isLxc
              ? '容器没有 Guest Agent 可问，面板只能读到 net0 里的静态配置。'
              : '虚拟机需要开启 Guest Agent 面板才能读到客户机内的地址。'}{' '}
            手动填写只影响面板上的展示与搜索，Proxmox 里的网络配置保持不变。
          </Notice>
          <Input
            label="IP 地址"
            value={ipDraft}
            onChange={(e) => setIpDraft(e.target.value)}
            placeholder="例如 192.168.1.10"
            mono
            autoFocus
            hint="留空并保存 = 清除这条记录，回落到平台自动识别"
          />
        </div>
      </Modal>

      {/* ---- 创建向导：两个页面各用各的向导 ----
          容器向导要的是「系统模板 + rootfs」，虚拟机向导要的是「ISO + 磁盘总线」，
          两者的必填项几乎不重叠，因此这里按 kind 二选一，不做任何合流。 */}
      {isLxc ? (
        <LxcCreateWizard
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={() => invalidateGuests()}
        />
      ) : (
        <VmCreateWizard
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={() => invalidateGuests()}
        />
      )}

      {/* ---- 删除确认 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={`删除${meta.noun}`}
        danger
        confirmText="删除"
        loading={pendingAction}
        requireText={deleteTarget?.name || String(deleteTarget?.vmid ?? '')}
        message={
          <>
            即将删除{meta.noun}{' '}
            <strong>
              {deleteTarget?.name ||
                `${meta.codePrefix} ${deleteTarget?.vmid ?? ''}`}
            </strong>
            （VMID {deleteTarget?.vmid}，位于节点 {deleteTarget?.node}）。
            该操作会同时清除其磁盘数据，且无法恢复。
          </>
        }
      />

      <ConfirmDialog
        open={bulkDelete}
        onCancel={() => setBulkDelete(false)}
        onConfirm={confirmBulkDelete}
        title={`批量删除${meta.noun}`}
        danger
        confirmText={`删除 ${selected.size} ${meta.unit}`}
        loading={pendingAction}
        message={
          <>
            即将删除选中的 <strong>{selected.size}</strong> {meta.unit}
            {meta.noun}。删除会连同磁盘数据一起清除，操作不可撤销。
          </>
        }
      />

      {/* ---- 转模板确认（仅虚拟机）---- */}
      {kind === 'qemu' ? (
        <ConfirmDialog
          open={Boolean(templateTarget)}
          onCancel={() => setTemplateTarget(null)}
          onConfirm={async () => {
            const vm = templateTarget;
            if (!vm) return;
            setPendingAction(true);
            try {
              await runner.run(vmsApi.toTemplate(vm.node, vm.vmid), {
                title: `转换「${vm.name || vm.vmid}」为模板`,
                node: vm.node,
                invalidate: [['vms'], ['lxc'], ['cluster']],
              });
              setTemplateTarget(null);
            } finally {
              setPendingAction(false);
            }
          }}
          title="转换为模板"
          confirmText="转换"
          loading={pendingAction}
          message={
            <>
              虚拟机{' '}
              <strong>{templateTarget?.name || `VM ${templateTarget?.vmid}`}</strong>{' '}
              将被转换为模板。转换过程中虚拟机会被关机，之后无法直接启动，只能用于克隆。
            </>
          }
        />
      ) : null}

      {/* ---- 克隆 / 迁移 / 快照 ---- */}
      <CloneDialog
        kind={kind}
        vm={cloneTarget}
        onClose={() => setCloneTarget(null)}
        onDone={() => {
          invalidateGuests();
          setCloneTarget(null);
        }}
      />

      <MigrateDialog
        noun={meta.noun}
        vm={migrateTarget}
        nodes={(nodesQuery.data ?? []).map((n) => n.node)}
        onClose={() => setMigrateTarget(null)}
        onDone={() => {
          invalidateGuests();
          setMigrateTarget(null);
        }}
      />

      <AssignOwnerDialog
        vm={assignTarget}
        noun={meta.noun}
        onClose={() => setAssignTarget(null)}
        onDone={() => {
          invalidateGuests();
          setAssignTarget(null);
        }}
      />

      <SnapshotDialog
        vm={snapshotTarget}
        isLxc={isLxc}
        onClose={() => setSnapshotTarget(null)}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['snapshots'] });
          setSnapshotTarget(null);
        }}
      />

      <BulkParamsDialog
        action={bulkDialog}
        count={selected.size}
        unit={meta.unit}
        noun={meta.noun}
        nodes={(nodesQuery.data ?? []).map((n) => n.node)}
        hasContainer={isLxc}
        busy={pendingAction}
        onClose={() => setBulkDialog(null)}
        onSubmit={(params) => {
          const action = bulkDialog;
          setBulkDialog(null);
          if (action) void runBulk(action, params);
        }}
      />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   克隆对话框
   --------------------------------------------------------------------------- */

function CloneDialog({
  vm,
  kind,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  kind: GuestKind;
  onClose: () => void;
  onDone: () => void;
}) {
  const meta = KIND_META[kind];
  const runner = useTaskRunner();
  const [newId, setNewId] = useState('');
  const [name, setName] = useState('');
  const [full, setFull] = useState(true);
  const [targetStorage, setTargetStorage] = useState('');
  const [busy, setBusy] = useState(false);

  const container = kind === 'lxc';

  useEffect(() => {
    if (vm) {
      setNewId('');
      setName(`${vm.name || (container ? `ct-${vm.vmid}` : `vm-${vm.vmid}`)}-clone`);
      /* 克隆模板默认链接克隆（秒级、省空间）；克隆普通虚拟机仍用完整克隆，
         因为链接克隆要求源磁盘处于可链接状态，普通虚机常不满足 */
      setFull(!vm.template);
      setTargetStorage('');
    }
  }, [vm, container]);

  const idNum = Number(newId);
  const idError =
    newId && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? 'VMID 需为 100 ~ 999999999 之间的整数'
      : undefined;

  const submit = async () => {
    if (!vm || idError || !newId) return;
    setBusy(true);
    try {
      await runner.run(
        container
          ? lxcApi.clone(vm.node, vm.vmid, {
              newid: idNum,
              hostname: name || undefined,
              target_storage: targetStorage || undefined,
            })
          : vmsApi.clone(vm.node, vm.vmid, {
              newid: idNum,
              name: name || undefined,
              full,
              target_storage: targetStorage || undefined,
            }),
        {
          title: `克隆「${vm.name || vm.vmid}」`,
          node: vm.node,
          invalidate: [['vms'], ['lxc'], ['cluster'], ['storages']],
        },
      );
      onDone();
    } catch {
      /* toast 已提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={onClose}
      title={`克隆${meta.noun}`}
      description={
        vm
          ? `源：${vm.name || `${meta.codePrefix} ${vm.vmid}`}（节点 ${vm.node}）`
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!newId || Boolean(idError)}
          >
            开始克隆
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Input
          label="新 VMID"
          required
          value={newId}
          onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))}
          placeholder="如 200"
          error={idError}
          hint={`留空可先到「${meta.createLabel}」获取建议 ID`}
        />
        <Input
          label="新名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={meta.cloneNamePlaceholder}
        />
        <Input
          label="目标存储（可选）"
          value={targetStorage}
          onChange={(e) => setTargetStorage(e.target.value)}
          placeholder="如 local-lvm"
          hint="完整克隆时需指定"
        />
      </div>
      {container ? (
        <div className="mt-16">
          <Notice tone="info" title="容器只有全量克隆">
            PVE 不支持容器的链接克隆，克隆结果始终独立于源容器。
          </Notice>
        </div>
      ) : (
        <div className="mt-16">
          <Checkbox
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
            label="完整克隆（复制所有磁盘数据，独立于源虚拟机）"
          />
          {!full ? (
            <Notice tone="warning" title="链接克隆">
              链接克隆依赖源虚拟机及快照链，源被删除或快照被合并后会导致克隆体数据损坏。生产环境建议使用完整克隆。
            </Notice>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   迁移对话框
   --------------------------------------------------------------------------- */

function MigrateDialog({
  vm,
  noun,
  nodes,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  noun: string;
  nodes: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const runner = useTaskRunner();
  const [target, setTarget] = useState('');
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (vm) {
      setTarget('');
      setOnline(vm.status === 'running');
    }
  }, [vm]);

  const options = nodes
    .filter((n) => n !== vm?.node)
    .map((n) => ({ label: n, value: n }));

  const submit = async () => {
    if (!vm || !target) return;
    setBusy(true);
    try {
      await runner.run(guestsApi.migrate(vm, target, online), {
        title: `迁移「${vm.name || vm.vmid}」到 ${target}`,
        node: vm.node,
        invalidate: [['vms'], ['lxc'], ['nodes'], ['cluster']],
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={onClose}
      title={`迁移${noun}`}
      description={
        vm ? `源节点：${vm.node} · ${vm.name || `VM ${vm.vmid}`}` : undefined
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!target}
          >
            开始迁移
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <Notice tone="warning" title="没有可用的目标节点">
          集群中只有一个节点，无法执行迁移。
        </Notice>
      ) : (
        <div className="flex flex-col gap-16">
          <Select
            label="目标节点"
            required
            placeholder="请选择目标节点"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={options}
          />
          <Checkbox
            checked={online}
            onChange={(e) => setOnline(e.target.checked)}
            label="在线迁移（不停机，需要共享存储或本地磁盘迁移支持）"
          />
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   新建快照对话框
   --------------------------------------------------------------------------- */

function SnapshotDialog({
  vm,
  isLxc,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  isLxc: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const runner = useTaskRunner();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [vmstate, setVmstate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (vm) {
      setName(`snap-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
      setDescription('');
      setVmstate(vm.status === 'running');
    }
  }, [vm]);

  const nameError =
    name && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)
      ? '快照名需以字母开头，只能包含字母、数字、- 和 _'
      : undefined;

  const submit = async () => {
    if (!vm || !name || nameError) return;
    setBusy(true);
    try {
      await runner.run(
        guestsApi.createSnapshot(vm, {
          name,
          description: description || undefined,
          // 容器快照没有内存状态，后端会忽略这个字段
          vmstate: isLxc ? false : vmstate,
        }),
        {
          title: `创建快照「${name}」`,
          node: vm.node,
          invalidate: [['snapshots'], ['vms'], ['lxc'], [isLxc ? 'lxc' : 'vm', vm.node, vm.vmid]],
        },
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={onClose}
      title="新建快照"
      description={
        vm ? `${vm.name || `VM ${vm.vmid}`}（节点 ${vm.node}）` : undefined
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!name || Boolean(nameError)}
          >
            创建快照
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
          error={nameError}
          placeholder="如 before-upgrade"
        />
        <Input
          label="描述"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="说明该快照的用途"
        />
        {/* 容器快照没有内存状态，这一项对容器不显示 */}
        {isLxc ? null : (
          <>
            <Checkbox
              checked={vmstate}
              onChange={(e) => setVmstate(e.target.checked)}
              label="包含内存状态（vmstate，回滚时可恢复到运行状态）"
            />
            {vmstate ? (
              <Notice tone="info">
                包含内存状态会额外占用与虚拟机内存等量的存储空间。
              </Notice>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   批量操作的参数弹窗（打标签 / 迁移 / 快照）
   --------------------------------------------------------------------------- */

function BulkParamsDialog({
  action,
  count,
  unit,
  noun,
  nodes,
  hasContainer,
  busy,
  onClose,
  onSubmit,
}: {
  action: BulkAction | null;
  count: number;
  unit: string;
  noun: string;
  nodes: string[];
  /** 目标是容器 —— 容器快照没有内存状态，那个开关要说明清楚 */
  hasContainer: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (params: BulkParams) => void;
}) {
  const [tags, setTags] = useState('');
  const [tagMode, setTagMode] = useState<'replace' | 'append'>('append');
  const [target, setTarget] = useState('');
  const [online, setOnline] = useState(true);
  const [snapName, setSnapName] = useState('');
  const [snapDesc, setSnapDesc] = useState('');
  const [vmstate, setVmstate] = useState(false);

  useEffect(() => {
    if (!action) return;
    setTags('');
    setTagMode('append');
    setTarget('');
    setOnline(true);
    setSnapName(`snap-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    setSnapDesc('');
    setVmstate(false);
  }, [action]);

  const nodeOptions = nodes.map((n) => ({ label: n, value: n }));
  const snapNameError =
    snapName && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(snapName)
      ? '快照名需以字母开头，只能包含字母、数字、- 和 _'
      : undefined;

  const canSubmit =
    action === 'tag'
      ? Boolean(tags.trim())
      : action === 'migrate'
        ? Boolean(target)
        : action === 'snapshot'
          ? Boolean(snapName) && !snapNameError
          : false;

  const submit = () => {
    if (!action || !canSubmit) return;
    if (action === 'tag') onSubmit({ tags: tags.trim(), tag_mode: tagMode });
    else if (action === 'migrate') onSubmit({ target_node: target, online });
    else onSubmit({ name: snapName, description: snapDesc, vmstate });
  };

  const titles: Record<string, string> = {
    tag: '批量打标签',
    migrate: '批量迁移',
    snapshot: '批量创建快照',
  };

  return (
    <Modal
      open={Boolean(action)}
      onClose={onClose}
      title={action ? titles[action] ?? '批量操作' : '批量操作'}
      description={`将对选中的 ${count} ${unit}${noun}执行${
        action === 'snapshot' ? '，**逐台**创建同名快照' : ''
      }`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
            执行
          </Button>
        </>
      }
    >
      {action === 'tag' ? (
        <div className="flex flex-col gap-16">
          <Input
            label="标签"
            required
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="如 prod;web"
            hint="多个标签用分号或逗号分隔"
          />
          <RadioGroup
            name="bulk-tag-mode"
            label="写入方式"
            value={tagMode}
            onChange={(v) => setTagMode(v as 'replace' | 'append')}
            options={[
              { label: '追加', value: 'append', hint: '保留原有标签，只补上缺失的' },
              { label: '覆盖', value: 'replace', hint: '用这里的标签替换掉原有的' },
            ]}
          />
        </div>
      ) : null}

      {action === 'migrate' ? (
        <div className="flex flex-col gap-16">
          <Select
            label="目标节点"
            required
            placeholder="请选择目标节点"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={nodeOptions}
          />
          <Switch
            checked={online}
            onChange={setOnline}
            label="在线迁移"
            hint="不停机；需要共享存储或本地磁盘迁移支持"
          />
          <Notice tone="warning" title="已在目标节点上的机器会失败">
            后端不会替你过滤：已经在目标节点的机器 PVE 会直接报错，
            结果清单里会写明是哪几台。
          </Notice>
        </div>
      ) : null}

      {action === 'snapshot' ? (
        <div className="flex flex-col gap-16">
          <Input
            label="快照名称"
            required
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            error={snapNameError}
            hint="所有目标机器用同一个名字"
          />
          <Input
            label="描述"
            value={snapDesc}
            onChange={(e) => setSnapDesc(e.target.value)}
          />
          {/* 容器没有内存状态，这个开关对容器页无意义 */}
          {hasContainer ? (
            <Notice tone="info" title="容器快照不支持内存状态">
              选中的容器会忽略「包含内存状态」，快照只保存磁盘数据。
            </Notice>
          ) : (
            <>
              <Switch
                checked={vmstate}
                onChange={setVmstate}
                label="包含内存状态"
                hint="回滚时可恢复到运行状态；会额外占用与内存等量的空间"
              />
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
