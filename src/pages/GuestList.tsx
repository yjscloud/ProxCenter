/* ==========================================================================
   ProxCenter — 虚拟机 / 容器列表（同一套实现，按 kind 成页）
   ==========================================================================

「虚拟机」页与「容器」页共用这份实现。两边除了「列的是什么」以外，表格列、
批量操作、克隆 / 迁移 / 快照 / 删除 / 指派对话框的形状完全一致，强行拆成两份
1700 行的文件只会让改一处漏一处。

差异全部收在下面两处：
  * `KIND_META` —— 文案、量词、标题图标、创建按钮、空列表引导；
  * `kind === 'lxc'` 分支 —— 容器没有的能力（链接克隆、快照内存状态）。

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
import { useT, type MessageKey } from '../i18n';
import {
  connectionsApi,
  exportUrl,
  lxcApi,
  nodesApi,
  quotaApi,
  sshFleetApi,
  vmMetaApi,
  vmMetaKey,
  vmsApi,
} from '../api/endpoints';
import { guestPath, guestPower, guestsApi, guestTypeOf } from '../api/guests';
import { BulkResultNotice, bulkActionKey } from '../components/BulkResultNotice';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Badge, TagList } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
  Checkbox,
  Input,
  RadioGroup,
  Select,
  Switch,
} from '../components/ui/Input';
import { Table, sortRows, type Column, type SortState } from '../components/ui/Table';
import { useColumnSettings } from '../components/ui/ColumnSettings';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { InlineMeter } from '../components/ui/ProgressBar';
import { Notice } from '../components/ui/EmptyState';
import { QuotaChip } from '../components/QuotaChip';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { ConfirmDialog, useConfirm } from '../components/ui/ConfirmDialog';
import { UserSelect } from '../components/ui/UserSelect';
import { useAiAssistantEntry } from '../components/AskAiButton';
import { useSnapshotQuota } from '../hooks/useSnapshotQuota';
import { useNodeStorages } from '../hooks/useNodeStorages';
import { VmCreateWizard } from '../components/VmCreateWizard';
import { LxcCreateWizard } from '../components/LxcCreateWizard';
/* VMware 互操作：OVF/OVA 导入与镜像导出（只有虚拟机有这两件事，容器不参与） */
import { VmImportWizard } from '../components/VmImportWizard';
import { VmExportDialog } from '../components/VmExportDialog';
import { ResetGuestPasswordDialog } from '../components/ResetGuestPasswordDialog';
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
  IconKey,
  IconUpload,
  IconSparkle,
} from '../components/Icons';
import {
  formatBytes,
  formatDateTime,
  formatUptimeShort,
  parseTags,
  toPercent,
} from '../utils/format';
import { isRunning, isStopped, isTransient, vmStatusMeta } from '../utils/status';
import {
  bulkPowerConfirmOptions,
  isDestructivePower,
  powerConfirmOptions,
  type DestructivePower,
} from '../utils/powerConfirm';
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

/**
 * 两种 kind 的差异只有「图标 + 词条前缀」。文案一律走词条表：同一个名词会被
 * 拼进几十个句子，而中英语序不同（「暂无虚拟机」/「No VMs yet」），靠字符串
 * 拼接迟早会在某一种语言里拧巴。
 *
 * 前缀用 `as const` 收窄成字面量联合，`${prefix}.noun` 因此是 10 个具体键，
 * 拼错前缀会在编译期报错 —— 而不是静默回退成中文。
 */
const KIND_KEY = {
  qemu: 'guestList.vm',
  lxc: 'guestList.ct',
} as const;

interface KindMeta {
  /** 页面标题图标 */
  titleIcon: ReactNode;
  /** 创建按钮图标 */
  createIcon: ReactNode;
  /** 详情页无法定位 guest 时的兜底前缀（VM 100 / CT 100） */
  codePrefix: string;
}

const KIND_META: Record<GuestKind, KindMeta> = {
  qemu: {
    titleIcon: <IconVm size={20} />,
    createIcon: <IconPlus size={15} />,
    codePrefix: 'VM',
  },
  lxc: {
    titleIcon: <IconBox size={20} />,
    createIcon: <IconBox size={15} />,
    codePrefix: 'CT',
  },
};

/** 随语言变的五个常用词：名词、量词、创建按钮、空状态引导、克隆占位 */
function useKindLabels(kind: GuestKind): {
  noun: string;
  unit: string;
  create: string;
  empty: string;
  cloneName: string;
} {
  const t = useT();
  const prefix = KIND_KEY[kind];
  return useMemo(
    () => ({
      noun: t(`${prefix}.noun`),
      unit: t(`${prefix}.unit`),
      create: t(`${prefix}.create`),
      empty: t(`${prefix}.empty`),
      cloneName: t(`${prefix}.cloneName`),
    }),
    [t, prefix],
  );
}

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
  const t = useT();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 打开时读到的归属。与 `username` 分开：它回答的是「本来是谁」 */
  const [current, setCurrent] = useState('');
  /** 读失败的原因。读不到当前归属时**不允许保存**（见下面的 submit） */
  const [loadError, setLoadError] = useState('');
  /**
   * 管理员是否动过这个下拉。
   *
   * 它是「清除归属」与「还没选人」之间唯一的区别 —— 后端把空 username 当成
   * 「清除」，而清空这个框只需要一次误点（或者输了用户名直接点保存，点外面
   * 收起时搜索词被丢掉、value 根本没变）。没有这个标记的话，一次保存就能把
   * 已经设好的归属抹掉，而且**全程不报错**，toast 还会说「归属已清除」。
   */
  const [touched, setTouched] = useState(false);

  /* 打开时读取当前归属 */
  useEffect(() => {
    if (!vm) return;
    setBusy(false);
    setTouched(false);
    setLoadError('');
    setLoading(true);
    guestsApi
      .getOwner(vm, vm.connection_id)
      .then((res) => {
        setCurrent(res.owner ?? '');
        setUsername(res.owner ?? '');
      })
      /* 读失败**不能**静默当成「本来就没有归属」：那会让管理员在一个未知的
         状态上做决定 —— 界面上是空的，他若随手一存就是把别人的归属清掉。 */
      .catch((err) => {
        setCurrent('');
        setUsername('');
        setLoadError(errorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [vm]);

  const submit = async () => {
    if (!vm || loading) return;
    if (loadError) {
      toast.error(t('guestList.assignLoadFailed'), loadError);
      return;
    }
    /* 没动过下拉且结果为空 —— 不当作「清除」。要清除得明确选那一项，
       那一下点击本身就是确认（选项文案也写清了后果，见 emptyLabel）。 */
    if (!username && !touched) {
      toast.error(t('guestList.assignPickFirst'));
      return;
    }
    setBusy(true);
    try {
      const res = await guestsApi.assignOwner(
        vm,
        username || null,
        vm.connection_id,
      );
      toast.success(
        res.owner ? t('guestList.assignDone', { noun }) : t('guestList.assignCleared'),
        res.owner
          ? `${vm.name || `${noun} ${vm.vmid}`} → ${res.owner}`
          : vm.name || `${noun} ${vm.vmid}`,
      );
      onDone();
    } catch (err) {
      toast.error(t('guestList.assignFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={onClose}
      title={t('guestList.assignTitle', { noun })}
      description={t('guestList.assignDesc', { noun })}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            /* 读失败时禁止保存：在一个未知的当前状态上保存，等于赌一把
               「反正它也没有归属」。 */
            disabled={loading || Boolean(loadError)}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {/* 可搜索的用户下拉：账号一多，原生下拉靠按键逐项跳根本找不到人；
          归属在库里就是用户名字符串，手打拼错一个字母等于「指派给一个不存在的人」 */}
      <UserSelect
        label={t('guestList.assignField')}
        hint={
          loading
            ? t('guestList.assignLoading')
            : /* 把「本来是谁」也摆出来：空输入框在别处常表示「没填」，
                 而这里它表示「清除」，不写明当前值就得靠管理员自己记。 */
              current
              ? t('guestList.assignCurrent', { name: current })
              : undefined
        }
        value={username}
        /* 空项的含义要说清：它不是「不填」，而是「让这台机器变回无人认领」 */
        emptyLabel={t('guestList.assignEmpty')}
        onChange={(next) => {
          setUsername(next);
          setTouched(true);
        }}
        disabled={loading || Boolean(loadError)}
      />
      {loadError ? (
        <Notice tone="danger" title={t('guestList.assignLoadFailed')}>
          {loadError}
        </Notice>
      ) : null}
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
  onResetPassword: () => void;
  onExport: () => void;
  onDelete: () => void;
  disabled: boolean;
  /** 是否显示「指派归属」（仅管理员可用该操作） */
  canAssign: boolean;
  /** 是否显示「重置用户口令」（需要 vm.config） */
  canResetPassword: boolean;
  /** 是否显示「导出」（仅虚拟机，且需要 vm.backup） */
  canExport: boolean;
  /**
   * 这台机器对应的受管主机 id（面板下发的机器靠 vmid 关联，见 sshremote）。
   * 空串 = 还没登记为受管主机，此时「问 AI」只带问题过去，让用户自己选主机。
   */
  askHostId?: string;
}

function RowMenu({
  vm,
  kind,
  onClone,
  onTemplate,
  onSnapshot,
  onMigrate,
  onAssign,
  onResetPassword,
  onExport,
  onDelete,
  disabled,
  canAssign,
  canResetPassword,
  canExport,
  askHostId,
}: RowMenuProps) {
  const t = useT();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const L = useKindLabels(kind);
  /* 逐个动作按**后端接口真正要求的那把钥匙**判：没权限的入口不摆出来，而不是
     让人点进去吃 403（权限点随类型走：虚拟机 vm.*、容器 ct.*）。 */
  const isLxc = kind === 'lxc';
  const permPrefix = isLxc ? 'ct' : 'vm';
  const canCloneRow = hasPermission(`${permPrefix}.clone`);
  /* 转模板是集群级能力（后端 vms.py / lxc.py 都要 template.manage） */
  const canToTemplate = hasPermission('template.manage');
  const canSnapshotRow = hasPermission(`${permPrefix}.snapshot`);
  /* 迁移是独立权限点：后端 vms.py / lxc.py 的 migrate 接口要 vm.migrate / ct.migrate
     （原先与「修改配置」共用 config，矩阵上却写着迁移仅管理员）。 */
  const canMigrateRow = hasPermission(`${permPrefix}.migrate`);
  const canDeleteRow = hasPermission(`${permPrefix}.delete`);
  /* 「问 AI」能不能出现：与详情页那个按钮同一套判定（权限 + 面板级开关），
     见 AskAiButton.useAiAssistantEntry */
  const aiAvailable = useAiAssistantEntry();
  /* 「问 AI」只给虚拟机留。判定与入口写在一起，因为分隔线跟着它走：
     容器这一侧少了一项，若还照常画那条分隔线，菜单顶部就只剩一条孤零零的线。
     anyAction 也换成它 —— 否则「只有 AI 入口可用」的用户在容器列表上会看到一个
     能点亮、点开却空空的菜单。 */
  const showAskAi = aiAvailable && !isLxc;
  /* 菜单里有没有可做的事：一件都没有就把整个入口禁掉（点开是空壳） */
  const anyAction =
    canCloneRow ||
    canToTemplate ||
    canSnapshotRow ||
    canExport ||
    canMigrateRow ||
    canAssign ||
    canResetPassword ||
    canDeleteRow ||
    showAskAi;
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

  /* 只读条目：不吃上面那个 `disabled`。
     它是给「问 AI」用的 —— 问 AI 不改这台机器上的任何东西，被「你没有写权限」
     或「机器正在忙」拦住毫无道理（恰恰是只读账号、机器卡住时最想找人看看）。 */
  const readonlyItem = (label: string, icon: React.ReactNode, action: () => void) => (
    <button
      type="button"
      className="dropdown-item"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        action();
      }}
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
      {/* 一个可做的动作都没有（例如只读用户）就别摆这个菜单：点开是个空壳。
          这里的判断**不**依赖角色名 —— 自定义角色完全可能只有一个 power 权限。 */}
      <IconButton
        label={t('guestList.moreActions')}
        onClick={toggle}
        disabled={disabled || !anyAction}
      >
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
          {/* 放在最前：机器出问题时，「让 AI 看看」是最先想找的入口。
              但要么有 AI 排查助手的权限、要么这个入口没被面板级开关关掉 —— 否则
              点进去只会被路由守卫弹回仪表盘（与详情页那个按钮同一套判定，
              见 AskAiButton.useAiAssistantEntry）。

              容器不摆这一项（见 showAskAi）。分隔线跟着它一起渲染，否则容器
              列表的菜单顶部会剩一条没有上文的分隔线。 */}
          {showAskAi ? (
            <>
              {readonlyItem(t('guestList.askAi'), <IconSparkle size={15} />, () => {
                const params = new URLSearchParams();
                if (askHostId) params.set('host', askHostId);
                params.set(
                  'question',
                  t('guestList.askAiQuestion', {
                    noun: L.noun,
                    name: vm.name || String(vm.vmid),
                  }),
                );
                navigate(`/ai-assistant?${params.toString()}`);
              })}
              <div className="user-dropdown-divider" />
            </>
          ) : null}
          {canCloneRow
            ? item(t('guestList.cloneTitle', { noun: L.noun }), <IconCopy size={15} />, onClone)
            : null}
          {/* 转模板两边都有：虚拟机走 qemu → template，容器走 pct template
              （后端 lxc.py 的 /lxc/{node}/{vmid}/template），都要求机器已关机 */}
          {!vm.template && canToTemplate
            ? item(t('guestList.toTemplate'), <IconTemplate size={15} />, onTemplate)
            : null}
          {canSnapshotRow
            ? item(t('guestList.newSnapshot'), <IconSnapshot size={15} />, onSnapshot)
            : null}
          {/* 导出：导的是磁盘镜像（VMDK/QCOW2/RAW/OVA），只有虚拟机有这个概念 */}
          {canExport
            ? item(t('vmExport.menuItem'), <IconDownload size={15} />, onExport)
            : null}
          {canMigrateRow
            ? item(t('guestList.migrate'), <IconLayers size={15} />, onMigrate)
            : null}
          {canAssign
            ? item(t('guestList.assign'), <IconUser size={15} />, onAssign)
            : null}
          {canResetPassword
            ? item(t('guestList.resetPassword'), <IconKey size={15} />, onResetPassword)
            : null}
          <div className="user-dropdown-divider" />
          {canDeleteRow
            ? item(t('guestList.deleteTitle', { noun: L.noun }), <IconTrash size={15} />, onDelete, true)
            : null}
        </div>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   列表页主体
   --------------------------------------------------------------------------- */

export function GuestListPage({ kind }: { kind: GuestKind }) {
  const t = useT();
  const meta = KIND_META[kind];
  const L = useKindLabels(kind);
  const isLxc = kind === 'lxc';

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runner = useTaskRunner();
  const { isAdmin, hasPermission } = useAuth();
  /* 权限点随类型走：虚拟机是 vm.*、容器是 ct.* —— 后端也是两套接口分别校验
     （routers/vms.py 用 vm.*，routers/lxc.py 用 ct.*）。 */
  const permPrefix = isLxc ? 'ct' : 'vm';
  /* 「新建虚拟机 / 容器」与「从 OVF 导入」都要 create */
  const canCreate = hasPermission(`${permPrefix}.create`);
  /* 后端的重置口令接口要 config；没这个权限就别把入口摆出来（点进去只会 403） */
  const canConfig = hasPermission(`${permPrefix}.config`);
  /* 批量快照同样按权限给（后端 bulk 的 snapshot 动作要 snapshot） */
  const canSnapshot = hasPermission(`${permPrefix}.snapshot`);
  /* 批量迁移要 migrate 这个独立权限点（后端 bulk.py 的 migrate 动作） */
  const canMigrate = hasPermission(`${permPrefix}.migrate`);
  /* 批量条上有没有可做的事（与行菜单同一套口径）：只读用户选中一行时，
     别弹出一条点不动的操作栏 */
  const canBulkPower = hasPermission(`${permPrefix}.power`);
  const canBulkDelete = hasPermission(`${permPrefix}.delete`);
  const bulkAny =
    canBulkPower || canBulkDelete || canConfig || canSnapshot || canMigrate;
  const bulkMore = canConfig || canSnapshot || canMigrate;
  /* 导出会把整块磁盘镜像交出去，与备份同一口径（只有虚拟机有导出这件事） */
  const canExport = kind === 'qemu' && hasPermission('vm.backup');

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('guestList.copied'), text);
    } catch {
      toast.error(t('guestList.copyFailed'), t('guestList.clipboardDenied'));
    }
  };

  /* ---- 筛选状态 ---- */
  const [search, setSearch] = useState('');
  /* 连接点（来源 PVE）在节点之前：多台 PVE 合并展示时同名节点会撞车，
     先选定这台主机，节点选择器才收窄成它自己的节点 */
  const [connFilter, setConnFilter] = useState('');
  const [nodeFilter, setNodeFilter] = useState('');
  // 默认显示全部状态。只看运行中会把「刚建完没起来」「关机待排查」「关机待维护」
  // 这些恰恰需要被看见的机器一起藏掉，而页面看着像个空列表 —— 用户的第一反应是
  // 「我的机器呢」，要去猜还有状态筛选这回事。想安静的可以自己筛。
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  /* 归属筛选：只给能看全量机器的人（管理员）。「无归属」的机器在按人分配的
     额度里不算任何人 —— 面板外建的、或归属记录丢了的，就是一份白送的额度，
     而此前在界面上完全看不见。 */
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'unowned'>('all');
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  /* 导入 / 导出都是虚拟机专有：容器没有 OVF、也没有「导出磁盘镜像」这回事 */
  const [importOpen, setImportOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<VmSummary | null>(null);

  /* 快捷入口深链：仪表盘工作台的「创建虚拟机 / 创建容器」跳到 ?new=1，
     直接拉开创建向导，省掉「进列表 → 找按钮」两步。
     读完立刻把参数抹掉：否则用户关掉向导后一刷新，它又自己弹出来。 */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (canCreate) setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canCreate]);

  /* ---- 弹窗状态 ---- */
  const [deleteTarget, setDeleteTarget] = useState<VmSummary | null>(null);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<VmSummary | null>(null);
  const [templateTarget, setTemplateTarget] = useState<VmSummary | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<VmSummary | null>(null);
  const [snapshotTarget, setSnapshotTarget] = useState<VmSummary | null>(null);
  const [assignTarget, setAssignTarget] = useState<VmSummary | null>(null);
  /* 重置客户机内用户口令（虚拟机走 Guest Agent / cloud-init，容器走宿主机 SSH） */
  const [passwordTarget, setPasswordTarget] = useState<VmSummary | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  /* 关机 / 停止 / 重启前弹一次确认（见 utils/powerConfirm）：这三件事都会让机器上
     的服务中断，而它们在列表里只是三个挨着的图标按钮 */
  const [powerConfirmEl, confirmPower] = useConfirm();
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
  /* 未配置连接时后端对每个请求都回 428，轮询只会刷一屏没人看的报错；
     配好之后这个值自动变回 true，轮询自己接上 */
  const pveReady = usePveReady();
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  const guestsQuery = useQuery({
    queryKey: isLxc
      ? ['lxc', 'with-ip', connFilter || 'all', nodeFilter || 'all']
      : ['vms', 'with-ip', connFilter || 'all', nodeFilter || 'all'],
    queryFn: () =>
      isLxc
        ? lxcApi.list(nodeFilter || undefined, {
            withIp: true,
            connectionId: connFilter || undefined,
          })
        : vmsApi.list(nodeFilter || undefined, {
            withIp: true,
            type: 'qemu',
            connectionId: connFilter || undefined,
          }),
    /* IP 列现在读后端的落库快照（后台作业预热，见 app.inspection），请求本身
       已经很便宜；间隔由「数据刷新间隔」定，列表要的是「状态大致是新的」。 */
    enabled: pveReady,
    refetchInterval: pveReady ? refresh : false,
  });

  /* 连接点列表：节点选择器的选项要靠它圈定范围（而非从已过滤的节点里反推，
     否则选定一台主机后选项会自己塌成一个）。键与节点页共用，切页不重复请求。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
  });

  /* 节点列表跟着连接点收窄：选定来源 PVE 后，节点下拉只列这台主机上的节点。
     未选连接时用 ['nodes'] 这个键，与节点页共用同一份缓存。 */
  const nodesQuery = useQuery({
    queryKey: connFilter ? ['nodes', connFilter] : ['nodes'],
    queryFn: () => nodesApi.list(connFilter || undefined),
    staleTime: 60_000,
  });

  /* ---- 受管主机对照表 ----
     面板下发的机器在「SSH 安全 → 受管主机」里有一条记录，靠 vmid 关联（见
     sshremote.remember_host）；**手工添加**的受管主机没有 vmid，只能靠地址认。
     列表里的「问 AI」据此带上目标主机，AI 才能真的连上去查这台机器。

     读不到（无 ssh 权限）时整表为空，功能照旧可用，只是少一个预选 ——
     所以失败不提示、不打扰。 */
  const sshHostsQuery = useQuery({
    queryKey: ['ssh', 'hosts'],
    queryFn: sshFleetApi.hosts,
    staleTime: 60_000,
    retry: false,
  });
  const hostIndex = useMemo(() => {
    const byVmid = new Map<number, string>();
    const byIp = new Map<string, string>();
    for (const item of sshHostsQuery.data ?? []) {
      if (item.vmid != null) byVmid.set(Number(item.vmid), item.id);
      const ip = String(item.host || '').trim();
      if (ip) byIp.set(ip, item.id);
    }
    return { byVmid, byIp };
  }, [sshHostsQuery.data]);

  /** 这台机器对应哪台受管主机：先按 vmid 认（最准），认不到再按 IP 认。 */
  const hostForGuest = (guest: VmSummary): string | undefined =>
    hostIndex.byVmid.get(Number(guest.vmid)) ||
    (guest.ip ? hostIndex.byIp.get(guest.ip) : undefined);

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

  /* ---- 按人分配的额度（资源池）----
     与上面那份**全局**台数上限是两层：那份是整个集群的护栏，这份是「我名下还能用
     多少」。两层取最严：任一层用尽都不能再建。 */
  const myQuotaQuery = useQuery({
    queryKey: ['quota', 'me'],
    queryFn: quotaApi.mine,
    staleTime: 30_000,
    retry: false,
  });
  const myGroup = myQuotaQuery.data?.groups[isLxc ? 'ct' : 'vm'];
  const myRemaining = myGroup?.remaining;
  const myCountUsedUp =
    myRemaining?.count != null && Number(myRemaining.count) <= 0;
  /* 额度用尽：禁用创建入口，并在按钮上说明原因 */
  const quotaBlocked = Boolean((quota && !quota.can_create) || myCountUsedUp);
  /* 创建入口被额度挡住时按钮上那句话。两层额度必须分开报（与快速部署同一条规矩）：
     混着报会把「你名下用完了」说成「平台用完了」，数字还是平台那份。上限也只在
     管理员那里有意义 —— 普通用户改不了那份设置，只需要知道该找谁。 */
  const createBlockedHint = !quotaBlocked
    ? undefined
    : myCountUsedUp
      ? t('guestList.myQuotaUsedUp')
      : isAdmin
        ? t('guestList.quotaExhausted', {
            noun: L.noun,
            quota: quota?.quota,
            unit: L.unit,
          })
        : t('quota.askAdmin');

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

  /* 连接点（来源 PVE）选项：只有一条连接时这一层没有意义，整只下拉不渲染
     （见工具栏），省掉一个恒为「全部连接」的占位控件。 */
  const connectionOptions = useMemo(() => {
    const items = connectionsQuery.data ?? [];
    return [
      { label: t('guestList.allConnections'), value: '' },
      ...items.map((c) => ({ label: c.name || c.id, value: c.id })),
    ];
  }, [connectionsQuery.data, t]);

  /* 多台 PVE 合并展示时同名节点会出现多次。筛选项按节点名去重
     （筛选本身就是按节点名匹配，跨主机同名节点会一起命中，行内会标出来源主机）。 */
  const nodeOptions = useMemo(() => {
    const names = Array.from(
      new Set((nodesQuery.data ?? []).map((n) => n.node)),
    ).sort();
    return [
      { label: t('guestList.allNodes'), value: '' },
      ...names.map((name) => ({ label: name, value: name })),
    ];
  }, [nodesQuery.data, t]);

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

      // 归属过滤。只认真实的空值：后端只给能看全量的人回填这个字段，
      // 拿不到时不会误判成「无归属」。
      if (ownerFilter === 'unowned' && vm.owner) return false;

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
  }, [guestsQuery.data, search, statusFilter, ownerFilter, manualIpOf]);

  /* 「无人认领」的台数。从已加载的清单里数，不另发请求 —— 列表本来就是它算出来的。
     模板不算在内：模板页另有归属语义，这里要的是「能认领的机器」。 */
  const unownedCount = useMemo(
    () => (guestsQuery.data ?? []).filter((vm) => !vm.template && !vm.owner).length,
    [guestsQuery.data],
  );

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
     虚拟机页的统计数字也会变），只刷自己这一份会留下过期数据。

     额度那两份也要一起失效，**这是「删了机器额度却没恢复」的元凶**：
     用量是从「归属表 ∩ PVE 实时清单」现算的，后端每次都会给对的数；但
     额度查询带 30 秒 staleTime，删除后没有任何东西去作废它，于是胶囊上
     一直挂着删除前的已用数，看着就像额度根本没还回来。
       * ['quota'] —— 「我的额度」（GET /quota/me）
       * ['guests'] —— 列表页顶部那份全局台数读数 */
  const invalidateGuests = useCallback(
    (guest?: VmSummary) => {
      void queryClient.invalidateQueries({ queryKey: ['vms'] });
      void queryClient.invalidateQueries({ queryKey: ['lxc'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
      void queryClient.invalidateQueries({ queryKey: ['quota'] });
      void queryClient.invalidateQueries({ queryKey: ['guests'] });
      if (guest) {
        void queryClient.invalidateQueries({
          queryKey: [isLxc ? 'lxc' : 'vm', guest.node, guest.vmid],
        });
      }
    },
    [queryClient, isLxc],
  );

  /* 勾了「接入安全管控」的虚拟机在**创建那一刻**就登记成了受管主机（见
     backend/app/routers/vms._register_managed），于是「端口与进程 / 安全基线 /
     SSH 安全」三页的主机清单与全平台总览都会多出一台。

     但那两页的总览不是现成数据：前端有 5 分钟 staleTime、后端还有 2 分钟巡检
     缓存（见 app.reportcache），不失效的话，刚纳管的机器会「看不见」几分钟 ——
     用户只会以为面板下发的虚拟机没被纳管。这里一并作废，让它们重新取一次。 */
  const invalidateSecurityViews = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['ports'] });
    void queryClient.invalidateQueries({ queryKey: ['baseline'] });
    void queryClient.invalidateQueries({ queryKey: ['ssh'] });
  }, [queryClient]);

  const doPower = useCallback(
    async (vm: VmSummary, action: 'start' | 'stop' | 'shutdown' | 'reboot') => {
      /* 按**具体权限**判，不按角色粗判：自定义角色（角色名不是 operator）完全
         可能有 power 权限，用 canWrite 会把它们一律当成只读 —— 表现就是「明明勾了
         电源权限，点下去却提示权限不足」。容器对应 ct.power。 */
      if (!hasPermission(`${permPrefix}.power`)) {
        toast.warning(t('guestList.noPermission'), t('guestList.powerDenied'));
        return;
      }
      /* 关机 / 停止 / 重启先确认一次：列表里这三个图标紧挨着，误点一下机器就断
         了服务。启动不拦 —— 它没有这个风险，多一步反而碍事。 */
      if (isDestructivePower(action)) {
        const ok = await confirmPower(
          powerConfirmOptions(t, action, vm, isLxc ? 'lxc' : 'qemu'),
        );
        if (!ok) return;
      }
      const labels: Record<typeof action, MessageKey> = {
        start: 'power.start',
        stop: 'power.stop',
        shutdown: 'power.shutdown',
        reboot: 'power.reboot',
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
          title: t('guestList.powerTask', {
            action: t(labels[action]),
            name: vm.name || vm.vmid,
          }),
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
    [hasPermission, permPrefix, runner, toast, isLxc, t, confirmPower],
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
          toast.success(
            t('guestList.bulkDone', { action: t(bulkActionKey(action)) }),
            t('guestList.bulkProcessed', { count: result.ok, unit: L.unit }),
          );
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
        toast.error(
          t('guestList.bulkFailed', { action: t(bulkActionKey(action)) }),
          errorMessage(err),
        );
      } finally {
        setPendingAction(false);
      }
    },
    [selectedGuests, invalidateGuests, toast, t, L.unit],
  );

  /* 批量电源操作前的确认：一次点击打的是勾选里的每一台，代价比单台大得多，
     标题里必须写清台数（「停止选中的 5 台虚拟机？」）。 */
  const askBulkPower = useCallback(
    async (action: DestructivePower) => {
      const count = selectedGuests.length;
      if (count === 0) return;
      const ok = await confirmPower(
        bulkPowerConfirmOptions(t, action, count, L.unit, L.noun),
      );
      if (ok) await runBulk(action);
    },
    [selectedGuests.length, confirmPower, t, L.unit, L.noun, runBulk],
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
        title: t('guestList.deleteTask', { name: vm.name || vm.vmid }),
        node: vm.node,
        /* 额度两份必须一起作废：机器没了，名下用量要立刻降下来。
           漏掉它们就会出现「删除成功、额度不动」的观感（见 invalidateGuests）。 */
        invalidate: [
          ['vms'],
          ['lxc'],
          ['cluster'],
          ['storages'],
          ['quota'],
          ['guests'],
        ],
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
      toast.warning(
        t('guestList.nameRequired'),
        t('guestList.nameRequiredHint', { code: meta.codePrefix, vmid: vm.vmid }),
      );
      return;
    }
    if (name.length > 63) {
      toast.warning(t('guestList.nameTooLong'), t('guestList.nameTooLongHint'));
      return;
    }
    if (name === (vm.name ?? '')) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    try {
      await runner.run(guestsApi.rename(vm, name), {
        title: t('guestList.renameTask', { name }),
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
      toast.warning(t('guestList.ipInvalid'), t('guestList.ipInvalidHint'));
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
        ip ? t('guestList.ipSaved') : t('guestList.ipCleared'),
        ip ? `${vm.name || vm.vmid} → ${ip}` : t('guestList.ipFallback'),
      );
      setIpTarget(null);
    } catch (err) {
      toast.error(t('guestList.saveFailed'), errorMessage(err));
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
      label: t('guestList.colSelect'),
      locked: true,
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={!allSelected && someSelected}
          onChange={toggleAll}
          aria-label={t('guestList.selectAll', { noun: L.noun })}
        />
      ),
      width: 44,
      render: (vm) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected.has(rowKeyOf(vm))}
            onChange={() => toggleOne(vm)}
            aria-label={t('guestList.selectOne', { name: vm.name || vm.vmid })}
          />
        </span>
      ),
    },
    {
      key: 'status',
      header: t('guestList.colStatus'),
      width: 108,
      render: (vm) => {
        const status = vmStatusMeta(vm.status, t);
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
      header: t('guestList.name'),
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
            {canConfig && !vm.template ? (
              <IconButton
                label={t('guestList.renameAria', { name: vm.name || vm.vmid })}
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
              {t('guestList.status.template')}
            </Badge>
          ) : null}
          {vm.lock ? (
            <Badge
              variant="warning"
              size="sm"
              title={t('guestList.lockTitle', { lock: vm.lock })}
            >
              {t('guestList.locked')}
            </Badge>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (vm) => vm.name ?? '',
    },
    {
      key: 'node',
      header: t('common.node'),
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
      header: t('guestList.ipLabel'),
      width: 190,
      render: (vm) => {
        const manual = manualIpOf(vm);
        const auto = vm.ip ?? '';
        /* 自动识别优先：它反映机器此刻的真实状态；
           手动值是回落，只在平台确实拿不到时顶上来。 */
        const shown = auto || manual;
        const fromManual = !auto && Boolean(manual);
        const manualBy = metaItems[vmMetaKey(vm.connection_id, vm.node, vm.vmid)]?.by ?? '';
        /* 虚拟机这条提示不写「Cloud-Init」：Windows 客户机用的是 Cloudbase-Init，
           而列表接口里没有 ostype（只有详情接口有），判断不出该叫哪个名字，
           所以按「初始化」统称，两种都覆盖。 */
        const missingHint = isLxc ? t('guestList.ipMissingCt') : t('guestList.ipMissingVm');
        return (
          <div className="ip-cell" onClick={(e) => e.stopPropagation()}>
            {shown ? (
              <button
                type="button"
                className={`ip-copy mono fs-sm${fromManual ? ' is-manual' : ''}`}
                title={
                  fromManual
                    ? t('guestList.ipManualTitle', {
                        by: manualBy
                          ? t('guestList.ipManualBy', { name: manualBy })
                          : '',
                      })
                    : t('guestList.ipCopyTitle')
                }
                onClick={() => void copyText(shown)}
              >
                {shown}
                {fromManual ? (
                  <span className="ip-manual-tag">{t('guestList.ipManualTag')}</span>
                ) : null}
              </button>
            ) : (
              <span className="fs-sm text-muted" title={missingHint}>
                —
              </span>
            )}
            {/* 只在平台拿不到地址时给编辑入口：自动值更准，
                让它旁边常驻一个「改」按钮只会诱导用户改错 */}
            {!auto && canConfig ? (
              <IconButton
                label={t('guestList.ipEditAria', { name: vm.name || vm.vmid })}
                onClick={() => openIpEditor(vm)}
                title={t('guestList.ipEditTitle')}
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
            sub={t('guestList.meterCores', { count: vm.maxcpu ?? 0 })}
            dim={!running}
            title={t('guestList.meterUsage', { pct: pct.toFixed(1) })}
            width={106}
          />
        );
      },
      sortable: true,
      sortValue: (vm) => vm.maxcpu ?? 0,
    },
    {
      key: 'mem',
      header: t('guestList.colMem'),
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
            title={t('guestList.meterUsage', { pct: pct.toFixed(1) })}
            width={130}
          />
        );
      },
      sortable: true,
      sortValue: (vm) => vm.maxmem ?? 0,
    },
    {
      key: 'disk',
      header: t('guestList.colDisk'),
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
      header: t('guestList.colUptime'),
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
      key: 'created',
      header: t('common.createdAt'),
      width: 150,
      /* 表头悬停说明：PVE 只在建机时写下这个时间，克隆 / 恢复出来的机器会
         继承来源机器的那一份 —— 不说清楚，用户会以为面板记错了。 */
      title: t('guestList.colCreatedTitle'),
      render: (vm) => (
        <span className="mono fs-sm text-secondary">
          {vm.created ? formatDateTime(vm.created) : '—'}
        </span>
      ),
      sortable: true,
      sortValue: (vm) => vm.created ?? 0,
    },
    {
      key: 'tags',
      header: t('guestList.colTags'),
      width: 140,
      render: (vm) => <TagList tags={parseTags(vm.tags)} max={2} />,
    },
      /* 「归属」列**只对管理员存在**。
         普通用户看到的每一台都是自己的，这一列对他既没有信息量，又会误导：
         后端刻意不给非管理员回填 ``owner``（少一处「哪台归谁」的暴露面），
         所以他这一列**每行都是「无人认领」** —— 连他自己名下那台也是。
         看起来像「我的机器全是无主的」，实际上只是这一列压根不该出现。 */
      ...(isAdmin
        ? [
            {
              key: 'owner',
              header: t('guestList.colOwner'),
              width: 132,
              render: (vm: VmSummary) =>
                vm.owner ? (
                  <span className="truncate" title={vm.owner}>
                    {vm.owner}
                  </span>
                ) : (
                  <span className="fs-xs text-muted">{t('guestList.ownerNone')}</span>
                ),
            } satisfies Column<VmSummary>,
          ]
        : []),
    {
      key: 'actions',
      header: t('common.actions'),
      /* 固定列：隐藏「操作」等于把启停、控制台、删除全部收走，
         用户只会以为面板坏了 */
      locked: true,
      width: 210,
      render: (vm) => {
        const running = isRunning(vm.status);
        const stopped = isStopped(vm.status);
        const frozen = vm.status === 'paused' || vm.status === 'suspended';
        const busy = isTransient(vm.status);
        const noPower =
          !hasPermission(`${permPrefix}.power`) || busy || Boolean(vm.lock);

        return (
          <span className="row-actions" onClick={(e) => e.stopPropagation()}>
            {stopped ? (
              <IconButton
                label={`${t('power.start')} ${vm.name}`}
                variant="primary"
                onClick={() => void doPower(vm, 'start')}
                disabled={noPower}
              >
                <IconPlay size={15} />
              </IconButton>
            ) : null}

            {running ? (
              <>
                <IconButton
                  label={`${t('power.shutdown')} ${vm.name}`}
                  onClick={() => void doPower(vm, 'shutdown')}
                  disabled={noPower}
                >
                  <IconPower size={15} />
                </IconButton>
                <IconButton
                  label={`${t('power.stop')} ${vm.name}`}
                  variant="danger"
                  onClick={() => void doPower(vm, 'stop')}
                  disabled={noPower}
                >
                  <IconStop size={14} />
                </IconButton>
                <IconButton
                  label={`${t('power.reboot')} ${vm.name}`}
                  onClick={() => void doPower(vm, 'reboot')}
                  disabled={noPower}
                >
                  <IconRestart size={15} />
                </IconButton>
              </>
            ) : null}

            {frozen ? (
              <IconButton
                label={`${t('power.resume')} ${vm.name}`}
                variant="primary"
                onClick={() =>
                  void runner.run(guestPower.resume(vm), {
                    title: t('guestList.resumeTask', { name: vm.name || vm.vmid }),
                    node: vm.node,
                    invalidate: [
                      ['vms'],
                      ['lxc'],
                      [isLxc ? 'lxc' : 'vm', vm.node, vm.vmid],
                    ],
                  })
                }
                disabled={noPower}
              >
                <IconPlay size={15} />
              </IconButton>
            ) : null}

            {/* 控制台要 vm.console / ct.console（后端 console.py 两个端点各判一次）：
                没这把钥匙就不摆按钮 —— 详情页的控制台标签同样打不开 */}
            {hasPermission(`${permPrefix}.console`) ? (
              <IconButton
                label={t('guestList.consoleAria', { name: vm.name })}
                /* 带上 tab 必须走 guestPath 的 extra：自己接 `?tab=console` 会在
                   连接参数后多出一个问号，后端收到的连接 id 就带上了 `?tab=console` */
                onClick={() => navigate(guestPath(vm, { tab: 'console' }))}
              >
                <IconConsole size={15} />
              </IconButton>
            ) : null}

            <RowMenu
              vm={vm}
              kind={kind}
              /* 只传「忙」：能不能开菜单由 RowMenu 按逐项权限自己判（不再看角色名，
                 自定义角色完全可能只有一个 power 权限） */
              disabled={busy}
              onClone={() => setCloneTarget(vm)}
              onTemplate={() => setTemplateTarget(vm)}
              onSnapshot={() => setSnapshotTarget(vm)}
              onMigrate={() => setMigrateTarget(vm)}
              onAssign={() => setAssignTarget(vm)}
              canAssign={isAdmin}
              onResetPassword={() => setPasswordTarget(vm)}
              canResetPassword={canConfig}
              onExport={() => setExportTarget(vm)}
              canExport={canExport}
              onDelete={() => setDeleteTarget(vm)}
              askHostId={hostForGuest(vm)}
            />
          </span>
        );
      },
    },
  ];

  /* 列显隐与顺序：按账号存在 localStorage，虚拟机与容器各记一份
     （两边的列不完全一样，共用一份配置会互相打架）。 */
  const cols = useColumnSettings(columns, isLxc ? 'lxc' : 'vms');

  /* ---- 排序 + 分页 ----
     这两步的**顺序不能反**：先按整份 filtered 排好，再交给 usePaged 切页。
     反过来的话排的只是当前这一页 —— 第 2 页里 CPU 最高的那台排不到前面来，
     翻页时排序看起来像坏了。排序规则与表格内部共用同一个 sortRows。
     筛选条件（连接 / 节点 / 状态 / 关键词）作为重置键：换了条件还停在第 5 页
     只会看到一张空表。 */
  const sorted = useMemo(
    () => sortRows(filtered, cols.columns, sort),
    [filtered, cols.columns, sort],
  );
  const guestPage = usePaged(
    sorted,
    `${connFilter}|${nodeFilter}|${statusFilter}|${ownerFilter}|${search}`,
  );

  /* 未配置时查询被 enabled 关掉、不出错也不出数据：这里一并按「取不到数据」处理，
     否则页面会渲染成一张空表，比报错更让人摸不着头脑 */
  const hasError = !pveReady || guestsQuery.isError;

  return (
    <PageShell
      title={
        <>
          {meta.titleIcon}
          {L.noun}
        </>
      }
      subtitle={
        guestsQuery.data
          ? `${t('guestList.countTotal', { count: filtered.length, unit: L.unit })}${
              selected.size > 0
                ? t('guestList.countSelected', { count: selected.size, unit: L.unit })
                : ''
            }`
          : t('common.loading')
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
            title={t('guestList.exportAll', { noun: L.noun })}
          >
            {t('guestList.export')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void guestsQuery.refetch();
              /* 节点筛选下拉、受管主机对照表是另外两路查询：不刷的话，新增节点 /
                 新登记的受管主机在这一页不会出现 */
              void queryClient.invalidateQueries({ queryKey: ['nodes'] });
              void queryClient.invalidateQueries({ queryKey: ['ssh', 'hosts'] });
            }}
            loading={guestsQuery.isFetching && !guestsQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
          {/* 从 OVF/OVA 导入（VMware 互操作）：与「新建」并列摆在创建区 ——
              对用户来说这两件事的意图是同一个（我要多一台机器），只是来源不同 */}
          {canCreate && kind === 'qemu' ? (
            <Button
              variant="secondary"
              icon={<IconUpload size={15} />}
              onClick={() => setImportOpen(true)}
              title={t('vmImport.entryTitle')}
            >
              {t('vmImport.entry')}
            </Button>
          ) : null}
          {canCreate ? (
            <Button
              variant="primary"
              icon={meta.createIcon}
              onClick={() => setCreateOpen(true)}
              disabled={quotaBlocked}
              title={createBlockedHint}
            >
              {L.create}
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
      {selected.size > 0 && bulkAny ? (
        <div className="bulk-bar">
          <span>
            {t('guestList.bulkSelectedPre')}
            <span className="bulk-bar-count">{selected.size}</span>{' '}
            {t('guestList.bulkSelectedPost', { unit: L.unit, noun: L.noun })}
          </span>
          <div className="flex items-center gap-8 flex-wrap">
            {/* 批量动作同样按权限给：后端会逐台按 permission_for 拒，但摆一排点不动的
                按钮没有意义 —— 没权限就不显示这一类。 */}
            {canBulkPower ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlay size={14} />}
                  disabled={pendingAction}
                  onClick={() => void runBulk('start')}
                >
                  {t('power.start')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPower size={14} />}
                  disabled={pendingAction}
                  onClick={() => void askBulkPower('shutdown')}
                >
                  {t('power.shutdown')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconRestart size={14} />}
                  disabled={pendingAction}
                  onClick={() => void askBulkPower('reboot')}
                >
                  {t('power.reboot')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconStop size={14} />}
                  disabled={pendingAction}
                  onClick={() => void askBulkPower('stop')}
                >
                  {t('guestList.bulkForceStop')}
                </Button>
              </>
            ) : null}

            {/* 需要额外参数的动作走这个下拉：直接铺按钮会把操作条挤爆。
                选项按权限收敛（打标签 / 迁移 / 气球要 config，快照要 snapshot），
                一个都没有时整个下拉不渲染 —— 只剩占位项的下拉没有意义。 */}
            {bulkMore ? (
              <Select
                value=""
                onChange={(e) => {
                  const action = e.target.value as BulkAction;
                  if (action) setBulkDialog(action);
                }}
                disabled={pendingAction}
                options={[
                  { label: t('guestList.bulkMore'), value: '' },
                  ...(canConfig
                    ? [
                        { label: t('guestList.bulkTag'), value: 'tag' as BulkAction },
                        { label: t('guestList.bulkBalloon'), value: 'balloon' as BulkAction },
                      ]
                    : []),
                  ...(canMigrate
                    ? [{ label: t('guestList.bulkMigrate'), value: 'migrate' as BulkAction }]
                    : []),
                  ...(canSnapshot
                    ? [{ label: t('guestList.bulkSnapshot'), value: 'snapshot' as BulkAction }]
                    : []),
                ]}
                aria-label={t('guestList.bulkMoreAria')}
              />
            ) : null}

            {canBulkDelete ? (
              <Button
                variant="danger"
                size="sm"
                icon={<IconTrash size={14} />}
                disabled={pendingAction}
                onClick={() => setBulkDelete(true)}
              >
                {t('common.delete')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pendingAction}
            >
              {t('guestList.clearSelection')}
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
              placeholder={t('guestList.searchPlaceholder')}
              title={t('guestList.searchTitle')}
              prefix={<IconSearch size={15} />}
              block={false}
              aria-label={t('guestList.searchAria', { noun: L.noun })}
              /* 这格是页面里第一个纯文本框，浏览器的自动填充（尤其登录过面板之后）
                 有时会把保存的用户名塞进来 —— 表现为「搜索框自己多了一串字符」，
                 列表跟着被过滤成空。显式关掉自动填充与拼写检查。 */
              autoComplete="off"
              spellCheck={false}
            />
            {/* 连接点在节点之前：先圈定是哪台 PVE，再看它上面有哪些节点。
                切换连接会清掉节点筛选 —— 旧节点多半不属于新连接，留着会得到空列表。 */}
            {connectionOptions.length > 2 ? (
              <Select
                value={connFilter}
                onChange={(e) => {
                  setConnFilter(e.target.value);
                  setNodeFilter('');
                }}
                options={connectionOptions}
                aria-label={t('guestList.connFilterAria')}
              />
            ) : null}
            <Select
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              options={nodeOptions}
              aria-label={t('guestList.nodeFilterAria')}
            />
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              options={[
                { label: t('guestList.status.all'), value: 'all' },
                { label: t('guestList.status.running'), value: 'running' },
                { label: t('guestList.status.stopped'), value: 'stopped' },
                { label: t('guestList.status.template'), value: 'template' },
              ]}
              aria-label={t('guestList.statusFilterAria')}
            />
            {/* 归属筛选只给管理员：普通用户看到的每一台都是自己的，这一档对他
                没有意义。管理员则需要它来找出「没人认领」的机器 ——
                那种机器在按人分配的额度里不算任何人。 */}
            {isAdmin ? (
              <Select
                value={ownerFilter}
                onChange={(e) =>
                  setOwnerFilter(e.target.value as 'all' | 'unowned')
                }
                options={[
                  { label: t('guestList.ownerAll'), value: 'all' },
                  { label: t('guestList.ownerUnowned'), value: 'unowned' },
                ]}
                aria-label={t('guestList.ownerFilterAria')}
              />
            ) : null}
          </div>
          <div className="toolbar-right">
            {/* 额度只有管理员设过时才存在；两层合成一颗，明细点开看（见 QuotaChip） */}
            <QuotaChip
              quota={quota}
              mine={myGroup}
              unit={L.unit}
              noun={L.noun}
            />
            {/* 无人认领是个**入口**而不是统计数字：点一下就把列表筛到那几台，
                接着逐台指派归属。没有它，这类机器在界面上完全看不见。 */}
            {isAdmin && unownedCount > 0 ? (
              <button
                type="button"
                className={`unowned-chip${
                  ownerFilter === 'unowned' ? ' is-active' : ''
                }`}
                aria-pressed={ownerFilter === 'unowned'}
                onClick={() =>
                  setOwnerFilter((prev) =>
                    prev === 'unowned' ? 'all' : 'unowned',
                  )
                }
                title={t('guestList.unownedHint')}
              >
                {t('guestList.unownedCount', { n: unownedCount })}
              </button>
            ) : null}
            <span className="fs-sm text-muted">
              {t('guestList.showing', {
                shown: filtered.length,
                total: (guestsQuery.data ?? []).length,
                unit: L.unit,
              })}
            </span>
            {/* 「列」按钮直接排进状态栏这一行：原先交给 Table 渲染，它会落在表格
                上方单独一条工具条里（.table-colbar）——为了一个按钮多占一整行，
                还把这张卡从中间切成两截。渲染位置本来就由调用方决定（见
                useColumnSettings 的说明），这里跟读数并排最省地方。 */}
            {cols.menu}
          </div>
        </div>

        {hasError ? (
          <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            <PveQueryError
              title={t('guestList.loadFailed', { noun: L.noun })}
              error={guestsQuery.error}
              onRetry={() => void guestsQuery.refetch()}
            />
          </div>
        ) : (
          <Table<VmSummary>
            columns={cols.columns}
            rows={guestPage.rows}
            rowKey={rowKeyOf}
            loading={guestsQuery.isLoading}
            caption={t('guestList.caption', { noun: L.noun })}
            sort={sort}
            onSortChange={setSort}
            onRowClick={(vm) => navigate(guestPath(vm))}
            isRowSelected={(vm) => selected.has(rowKeyOf(vm))}
            emptyTitle={
              search || statusFilter !== 'all'
                ? t('guestList.noMatch', { noun: L.noun })
                : t('guestList.empty', { noun: L.noun })
            }
            emptyDescription={
              search || statusFilter !== 'all'
                ? t('guestList.emptyFiltered')
                : L.empty
            }
            emptyAction={
              canCreate && !search ? (
                <Button
                  variant="primary"
                  icon={meta.createIcon}
                  onClick={() => setCreateOpen(true)}
                  disabled={quotaBlocked}
                  title={createBlockedHint}
                >
                  {L.create}
                </Button>
              ) : undefined
            }
          />
        )}

        {/* 分页条接在表格下沿 —— 工具栏 + 表格 + 分页条是同一张卡（见 .pagination
            的样式）。出错时不出分页：那会儿没有列表可翻 */}
        {!hasError ? <PagerBar pager={guestPage} /> : null}
      </div>

      {/* ---- 改名 ----
          虚拟机的名字是 PVE 配置里的 `name`；容器没有独立的 name，
          它的名字就是主机名 `hostname`。两边的字段名由 guestsApi.rename 收口。 */}
      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title={isLxc ? t('guestList.renameCt') : t('guestList.renameVm')}
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
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void saveRename()} loading={renameBusy}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Input
          label={isLxc ? t('guestList.hostname') : t('guestList.name')}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          placeholder={`${meta.codePrefix} ${renameTarget?.vmid ?? ''}`}
          maxLength={63}
          autoFocus
          hint={
            isLxc
              ? t('guestList.renameCtHint', {
                  name: renameTarget?.name || t('guestList.unset'),
                })
              : t('guestList.renameVmHint', {
                  name: renameTarget?.name || t('guestList.unset'),
                })
          }
        />
      </Modal>

      {/* ---- 手动填写 IP ----
          面板侧保存，用于补齐「Guest Agent 没开 / 容器走 DHCP」时看不到地址的场景。
          它不会写回 PVE 的网络配置 —— 只是给运维一个能记事的字段。 */}
      <Modal
        open={Boolean(ipTarget)}
        onClose={() => setIpTarget(null)}
        title={t('guestList.ipTitle')}
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
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void saveManualIp()} loading={ipBusy}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-16">
          <Notice tone="info" title={t('guestList.ipNoticeTitle')}>
            {isLxc ? t('guestList.ipNoticeCt') : t('guestList.ipNoticeVm')}{' '}
            {t('guestList.ipNoticeTail')}
          </Notice>
          <Input
            label={t('guestList.ipLabel')}
            value={ipDraft}
            onChange={(e) => setIpDraft(e.target.value)}
            placeholder={t('guestList.ipPlaceholder')}
            mono
            autoFocus
            hint={t('guestList.ipHint')}
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
          onCreated={() => {
            invalidateGuests();
            invalidateSecurityViews();
          }}
        />
      )}

      {/* OVF/OVA 导入 与 镜像导出：两件事都只有虚拟机有（容器既没有 OVF，
          也没有「把磁盘导成 VMDK」这回事），所以整块按 kind 收口 */}
      {kind === 'qemu' ? (
        <>
          <VmImportWizard
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onCreated={() => {
              invalidateGuests();
              invalidateSecurityViews();
            }}
          />
          <VmExportDialog
            open={Boolean(exportTarget)}
            vm={exportTarget}
            onClose={() => setExportTarget(null)}
          />
        </>
      ) : null}

      {/* 电源操作确认（关机 / 停止 / 重启）：列表里这三个图标挨着，点哪个都
          先问一次；启动不经过这里（见 doPower） */}
      {powerConfirmEl}

      {/* ---- 删除确认 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={t('guestList.deleteTitle', { noun: L.noun })}
        danger
        confirmText={t('common.delete')}
        loading={pendingAction}
        requireText={deleteTarget?.name || String(deleteTarget?.vmid ?? '')}
        message={
          <>
            {t('guestList.deleteSoon', { noun: L.noun })}{' '}
            <strong>
              {deleteTarget?.name ||
                `${meta.codePrefix} ${deleteTarget?.vmid ?? ''}`}
            </strong>
            {t('guestList.deleteTail', {
              vmid: deleteTarget?.vmid,
              node: deleteTarget?.node,
            })}
          </>
        }
      />

      <ConfirmDialog
        open={bulkDelete}
        onCancel={() => setBulkDelete(false)}
        onConfirm={confirmBulkDelete}
        title={t('guestList.bulkDeleteTitle', { noun: L.noun })}
        danger
        confirmText={t('guestList.bulkDeleteConfirm', {
          count: selected.size,
          unit: L.unit,
        })}
        loading={pendingAction}
        message={
          <>
            {t('guestList.bulkDeleteSoon')} <strong>{selected.size}</strong>{' '}
            {t('guestList.bulkDeleteTail', { unit: L.unit, noun: L.noun })}
          </>
        }
      />

      {/* ---- 转模板确认 ---- */}
      <ConfirmDialog
        open={Boolean(templateTarget)}
        onCancel={() => setTemplateTarget(null)}
        onConfirm={async () => {
          const vm = templateTarget;
          if (!vm) return;
          setPendingAction(true);
          try {
            /* 容器与虚拟机的转模板端点是两条（pct template / qemu → template），
               都要带上来源连接 —— 不带的话后端会去归属表里推断。 */
            await runner.run(
              isLxc
                ? lxcApi.toTemplate(vm.node, vm.vmid, vm.connection_id ?? undefined)
                : vmsApi.toTemplate(vm.node, vm.vmid, vm.connection_id),
              {
                title: t('guestList.toTemplateTask', { name: vm.name || vm.vmid }),
                node: vm.node,
                invalidate: [['vms'], ['lxc'], ['cluster'], ['templates']],
              },
            );
            setTemplateTarget(null);
          } finally {
            setPendingAction(false);
          }
        }}
        title={t('guestList.toTemplate')}
        confirmText={t('guestList.toTemplateConfirm')}
        loading={pendingAction}
        message={
          <>
            {t('guestList.toTemplateSoon', { noun: L.noun })}{' '}
            <strong>{templateTarget?.name || `${L.noun} ${templateTarget?.vmid}`}</strong>{' '}
            {t('guestList.toTemplateTail', { noun: L.noun })}
          </>
        }
      />

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
        noun={L.noun}
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
        noun={L.noun}
        onClose={() => setAssignTarget(null)}
        onDone={() => {
          invalidateGuests();
          setAssignTarget(null);
        }}
      />

      <ResetGuestPasswordDialog
        guest={passwordTarget}
        noun={L.noun}
        onClose={() => setPasswordTarget(null)}
        onDone={() => {
          invalidateGuests(passwordTarget ?? undefined);
          setPasswordTarget(null);
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
        unit={L.unit}
        noun={L.noun}
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
  const t = useT();
  const meta = KIND_META[kind];
  const L = useKindLabels(kind);
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
      ? t('guestList.cloneIdRange')
      : undefined;

  /* 目标存储：只列**源机器所在节点**上、且能放这类磁盘的存储池（虚拟机 images、
     容器 rootdir）。原先是个自由文本框，名字写错（或写了别的主机上的池子）必然
     被 PVE 拒；候选随节点走，见 useNodeStorages。 */
  const storagesQuery = useNodeStorages(
    vm?.node ?? '',
    vm?.connection_id,
    Boolean(vm),
  );
  const storageOptions = useMemo(() => {
    const want = container ? 'rootdir' : 'images';
    return [
      { label: t('guestList.cloneTargetDefault'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active &&
            s.content.split(/[,;]/).some((c) => c.trim() === want),
        )
        .map((s) => ({
          label: t('templates.storageAvail', {
            storage: s.storage,
            avail: formatBytes(s.avail),
          }),
          value: s.storage,
        })),
    ];
  }, [storagesQuery.data, container, t]);

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
          title: t('guestList.cloneTask', { name: vm.name || vm.vmid }),
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
      title={t('guestList.cloneTitle', { noun: L.noun })}
      description={
        vm
          ? t('guestList.cloneSource', {
              name: vm.name || `${meta.codePrefix} ${vm.vmid}`,
              node: vm.node,
            })
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!newId || Boolean(idError)}
          >
            {t('guestList.cloneStart')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Input
          label={t('guestList.cloneNewId')}
          required
          value={newId}
          onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))}
          placeholder={t('guestList.cloneNewIdPlaceholder')}
          error={idError}
          hint={t('guestList.cloneIdHint', { create: L.create })}
        />
        <Input
          label={t('guestList.cloneNewName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={L.cloneName}
        />
        <Select
          label={t('guestList.cloneTarget')}
          value={targetStorage}
          onChange={(e) => setTargetStorage(e.target.value)}
          options={storageOptions}
          hint={t('guestList.cloneTargetHint')}
        />
      </div>
      {container ? (
        <div className="mt-16">
          <Notice tone="info" title={t('guestList.cloneCtOnlyTitle')}>
            {t('guestList.cloneCtOnlyDesc')}
          </Notice>
        </div>
      ) : (
        <div className="mt-16">
          <Checkbox
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
            label={t('guestList.cloneFullLabel')}
          />
          {!full ? (
            <Notice tone="warning" title={t('guestList.cloneLinkedTitle')}>
              {t('guestList.cloneLinkedDesc')}
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
  const t = useT();
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
        title: t('guestList.migrate.task', { name: vm.name || vm.vmid, node: target }),
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
      title={t('guestList.migrate.title', { noun })}
      description={
        vm
          ? t('guestList.migrate.desc', {
              node: vm.node,
              name: vm.name || `VM ${vm.vmid}`,
            })
          : undefined
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!target}
          >
            {t('guestList.migrate.start')}
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <Notice tone="warning" title={t('guestList.migrate.noTargetTitle')}>
          {t('guestList.migrate.noTargetDesc')}
        </Notice>
      ) : (
        <div className="flex flex-col gap-16">
          <Select
            label={t('guestList.migrate.targetLabel')}
            required
            placeholder={t('guestList.migrate.targetPlaceholder')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={options}
          />
          <Checkbox
            checked={online}
            onChange={(e) => setOnline(e.target.checked)}
            label={t('guestList.migrate.online')}
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
  const t = useT();
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

  /* 快照额度：配了就在这儿说清还剩几张，别等提交后被 403 打回来 */
  const snap = useSnapshotQuota(Boolean(vm));

  const nameError =
    name && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)
      ? t('guestList.snap.nameError')
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
          title: t('guestList.snap.task', { name }),
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
      title={t('guestList.snap.title')}
      description={
        vm
          ? t('guestList.snap.subtitle', {
              name: vm.name || `VM ${vm.vmid}`,
              node: vm.node,
            })
          : undefined
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!name || Boolean(nameError) || snap.blocked}
            title={
              snap.blocked
                ? t('guestList.snap.quotaUsedUp', { limit: Number(snap.limit) })
                : undefined
            }
          >
            {t('guestList.snap.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Input
          label={t('guestList.snap.nameLabel')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          placeholder={t('guestList.snap.namePlaceholder')}
        />
        <Input
          label={t('common.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('guestList.snap.descPlaceholder')}
        />
        {/* 快照额度：只在管理员配了总额度时出现 */}
        {snap.limited ? (
          <Notice tone={snap.blocked ? 'warning' : 'info'}>
            {snap.blocked
              ? t('guestList.snap.quotaUsedUp', { limit: Number(snap.limit) })
              : t('guestList.snap.quotaRemaining', { n: Number(snap.remaining ?? 0) })}
          </Notice>
        ) : null}
        {/* 容器快照没有内存状态，这一项对容器不显示 */}
        {isLxc ? null : (
          <>
            <Checkbox
              checked={vmstate}
              onChange={(e) => setVmstate(e.target.checked)}
              label={t('guestList.snap.vmstate')}
            />
            {vmstate ? (
              <Notice tone="info">{t('guestList.snap.vmstateNote')}</Notice>
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
  const t = useT();
  const [tags, setTags] = useState('');
  const [tagMode, setTagMode] = useState<'replace' | 'append'>('append');
  const [target, setTarget] = useState('');
  const [online, setOnline] = useState(true);
  const [snapName, setSnapName] = useState('');
  const [snapDesc, setSnapDesc] = useState('');
  const [vmstate, setVmstate] = useState(false);
  /** 内存气球的最低保留量（MB）。空 = 没填（不能提交）；0 = 关闭气球驱动 */
  const [balloon, setBalloon] = useState('');

  useEffect(() => {
    if (!action) return;
    setTags('');
    setTagMode('append');
    setTarget('');
    setOnline(true);
    setSnapName(`snap-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    setSnapDesc('');
    setVmstate(false);
    setBalloon('');
  }, [action]);

  const nodeOptions = nodes.map((n) => ({ label: n, value: n }));
  const snapNameError =
    snapName && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(snapName)
      ? t('guestList.snap.nameError')
      : undefined;

  /* 内存气球：必须填，且是 >= 0 的整数（0 表示关掉气球驱动） */
  const balloonValue = balloon.trim() === '' ? NaN : Number(balloon);
  const balloonError =
    balloon.trim() === '' || !Number.isFinite(balloonValue) || balloonValue < 0
      ? t('guestList.bulkDialog.balloonError')
      : balloonValue > 0 && balloonValue < 128
        ? t('guestList.bulkDialog.balloonErrorMin')
        : undefined;

  const canSubmit =
    action === 'tag'
      ? Boolean(tags.trim())
      : action === 'migrate'
        ? Boolean(target)
        : action === 'balloon'
          ? !balloonError
          : action === 'snapshot'
            ? Boolean(snapName) && !snapNameError
            : false;

  const submit = () => {
    if (!action || !canSubmit) return;
    if (action === 'tag') onSubmit({ tags: tags.trim(), tag_mode: tagMode });
    else if (action === 'migrate') onSubmit({ target_node: target, online });
    else if (action === 'balloon') onSubmit({ balloon: balloonValue });
    else onSubmit({ name: snapName, description: snapDesc, vmstate });
  };

  const titles: Record<string, MessageKey> = {
    tag: 'guestList.bulkTag',
    migrate: 'guestList.bulkDialog.titleMigrate',
    balloon: 'guestList.bulkBalloon',
    snapshot: 'guestList.bulkSnapshot',
  };

  return (
    <Modal
      open={Boolean(action)}
      onClose={onClose}
      title={
        action
          ? t(titles[action] ?? 'guestList.bulkDialog.titleDefault')
          : t('guestList.bulkDialog.titleDefault')
      }
      description={t('guestList.bulkDialog.desc', {
        count,
        unit,
        noun,
        extra: action === 'snapshot' ? t('guestList.bulkDialog.descSnapshot') : '',
      })}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
            {t('guestList.bulkDialog.run')}
          </Button>
        </>
      }
    >
      {action === 'tag' ? (
        <div className="flex flex-col gap-16">
          <Input
            label={t('guestList.bulkDialog.tagLabel')}
            required
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('guestList.bulkDialog.tagPlaceholder')}
            hint={t('guestList.bulkDialog.tagHint')}
          />
          <RadioGroup
            name="bulk-tag-mode"
            label={t('guestList.bulkDialog.tagMode')}
            value={tagMode}
            onChange={(v) => setTagMode(v as 'replace' | 'append')}
            options={[
              {
                label: t('guestList.bulkDialog.tagAppend'),
                value: 'append',
                hint: t('guestList.bulkDialog.tagAppendHint'),
              },
              {
                label: t('guestList.bulkDialog.tagReplace'),
                value: 'replace',
                hint: t('guestList.bulkDialog.tagReplaceHint'),
              },
            ]}
          />
        </div>
      ) : null}

      {action === 'migrate' ? (
        <div className="flex flex-col gap-16">
          <Select
            label={t('guestList.migrate.targetLabel')}
            required
            placeholder={t('guestList.migrate.targetPlaceholder')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={nodeOptions}
          />
          <Switch
            checked={online}
            onChange={setOnline}
            label={t('guestList.bulkDialog.onlineMigrate')}
            hint={t('guestList.bulkDialog.onlineMigrateHint')}
          />
          <Notice tone="warning" title={t('guestList.bulkDialog.migrateWarnTitle')}>
            {t('guestList.bulkDialog.migrateWarnDesc')}
          </Notice>
        </div>
      ) : null}

      {action === 'balloon' ? (
        <div className="flex flex-col gap-16">
          <Input
            label={t('guestList.bulkDialog.balloonLabel')}
            required
            type="number"
            min={0}
            step={256}
            value={balloon}
            onChange={(e) => setBalloon(e.target.value)}
            error={balloon.trim() === '' ? undefined : balloonError}
            placeholder={t('guestList.bulkDialog.balloonPlaceholder')}
            hint={t('guestList.bulkDialog.balloonHint')}
          />
          <Notice tone="info" title={t('guestList.bulkDialog.balloonNoticeTitle')}>
            {t('guestList.bulkDialog.balloonNoticeDesc')}
          </Notice>
          {hasContainer ? (
            <Notice tone="warning" title={t('guestList.bulkDialog.balloonCtTitle')}>
              {t('guestList.bulkDialog.balloonCtDesc')}
            </Notice>
          ) : null}
        </div>
      ) : null}

      {action === 'snapshot' ? (
        <div className="flex flex-col gap-16">
          <Input
            label={t('guestList.snap.nameLabel')}
            required
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            error={snapNameError}
            hint={t('guestList.bulkDialog.snapNameHint')}
          />
          <Input
            label={t('common.description')}
            value={snapDesc}
            onChange={(e) => setSnapDesc(e.target.value)}
          />
          {/* 容器没有内存状态，这个开关对容器页无意义 */}
          {hasContainer ? (
            <Notice tone="info" title={t('guestList.bulkDialog.snapCtTitle')}>
              {t('guestList.bulkDialog.snapCtDesc')}
            </Notice>
          ) : (
            <>
              <Switch
                checked={vmstate}
                onChange={setVmstate}
                label={t('guestList.bulkDialog.snapVmstate')}
                hint={t('guestList.bulkDialog.snapVmstateHint')}
              />
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
