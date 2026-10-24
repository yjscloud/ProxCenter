/* ==========================================================================
   ProxCenter — 模板管理
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clusterApi,
  configApi,
  lxcApi,
  nodesApi,
  templatesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge, TagList } from '../components/ui/Badge';
import { Table } from '../components/ui/Table';
import type { Column } from '../components/ui/Table';
import { Button, IconButton } from '../components/ui/Button';
import {
  Checkbox,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { CardSkeleton } from '../components/ui/Spinner';
import { CollapsibleCard, EmptyState, Notice } from '../components/ui/EmptyState';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { LXC_NAV_PATH, isPathDisabled } from '../components/Sidebar';
import {
  IconTemplate,
  IconCopy,
  IconTrash,
  IconEye,
  IconPlus,
  IconRefresh,
  IconCloud,
  IconVm,
  IconDisk,
} from '../components/Icons';
import { LxcCreateWizard } from '../components/LxcCreateWizard';
import { formatBytes, formatUptimeShort, parseTags } from '../utils/format';
import { ostypeLabel } from '../utils/status'
import { useT } from '../i18n';
import { ostypeOptions, cpuTypeOptions } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useNodeStorages } from '../hooks/useNodeStorages';
import type { CtSystemTemplate, TemplateItem, VmSummary } from '../api/types';

/** 模板类型标签页：虚拟机模板与容器模板分开看，混在一屏里不好区分 */
type TemplateTab = 'qemu' | 'lxc';

/** 展示方式（与节点页保持一致的叫法） */
type ViewMode = 'cards' | 'list';

export function Templates() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const { hasPermission } = useAuth();
  /* 模板页有两种写操作，权限不同：
       * 克隆（用模板建机器）→ `template.clone`
       * 制作 / 导入 / 转换 / 删除模板 → `template.manage`
     原先统一用 canWrite（按角色名粗判），自定义角色即使勾了也点不动。 */
  const canClone = hasPermission('template.clone');
  const canManage = hasPermission('template.manage');
  /* 用系统模板新建容器走的是 /lxc 那条创建链，要的是 ct.create —— 与「克隆模板」
     是两把不同的钥匙，不能拿 canClone 顶替 */
  const canCreateCt = hasPermission('ct.create');

  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<TemplateItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateItem | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  /* 用系统模板新建容器：非 null 就打开容器向导并预选这个模板 */
  const [ctPreset, setCtPreset] = useState<CtSystemTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TemplateTab>('qemu');
  const [view, setView] = useState<ViewMode>('cards');

  /* 模板列表走专用接口 /api/templates：模板是共享资源，普通用户也必须能看到
     并用于部署。原先前端是用 /api/vms 自己筛 template，而该接口对普通用户按
     归属过滤，模板都归属管理员 → 普通用户看到的是空列表。 */
  /* 未配置连接时后端对每个请求都回 428，轮询没有意义（配好后自动恢复） */
  const pveReady = usePveReady();
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  /* 「容器」在「设置 → 导航栏功能开关」里被关掉后，这一页不该再留一个进得去的
     容器入口 —— 与侧边栏、路由拦截、AskAiButton 用同一份判据（isPathDisabled），
     路径也只写一遍（LXC_NAV_PATH）。

     必须提到两个 query **之前**：下面的 vztmpl 查询要靠它决定要不要发。 */
  const ctNavOff = isPathDisabled(LXC_NAV_PATH, useUiPrefs().nav_disabled);

  const templatesQuery = useQuery({
    queryKey: ['templates', 'all'],
    queryFn: () => templatesApi.list(),
    enabled: pveReady,
    refetchInterval: pveReady ? refresh : false,
  });

  /* 容器**系统模板**（vztmpl 文件）。
     和上面那份不是一回事：那份是「被转成模板的机器」（有 VMID，用来克隆），
     这份是存储里的模板**文件**（没有 VMID，用来新建容器时选操作系统）。
     PVE 里两者都叫「模板」—— 页面此前只统计前者，于是明明有系统模板却显示 0。
     这就是「容器模板数量为零」的直接原因（见 templatesApi.vztmpl）。

     容器关掉时**不去取**：这个接口要逐节点问「节点列表 → 存储列表 → 存储内容」
     三跳，是一个负载不轻的轮询，而结果一个字节都不会被渲染。 */
  const vztmplQuery = useQuery({
    queryKey: ['templates', 'vztmpl'],
    queryFn: () => templatesApi.vztmpl(),
    enabled: pveReady && !ctNavOff,
    refetchInterval: pveReady && !ctNavOff ? refresh : false,
  });

  const templates = useMemo(() => {
    const list = templatesQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (v) =>
        v.name?.toLowerCase().includes(q) ||
        String(v.vmid).includes(q) ||
        v.node.toLowerCase().includes(q) ||
        (v.tags ?? '').toLowerCase().includes(q),
    );
  }, [templatesQuery.data, search]);

  /* 两类模板分开统计：标签页上直接带数量，切换前就知道另一边有几个 */
  const vmTemplates = useMemo(
    () => templates.filter((t) => (t.guest_type ?? 'qemu') !== 'lxc'),
    [templates],
  );
  /* 「已转为模板的容器」：这一类是机器，能克隆 */
  const ctTemplates = useMemo(
    () => templates.filter((t) => t.guest_type === 'lxc'),
    [templates],
  );
  /* 「容器系统模板」：这一类是文件，用来新建容器 */
  const ctSystem = useMemo(() => {
    const list = vztmplQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (v) =>
        v.name?.toLowerCase().includes(q) ||
        v.storage.toLowerCase().includes(q) ||
        v.node.toLowerCase().includes(q),
    );
  }, [vztmplQuery.data, search]);
  /* 实际生效的标签页。开关一关，无论 state 停在哪儿都按虚拟机页渲染 ——
     用**派生值**而不是 useEffect 往回改：派生不会先渲染出一帧已经不该存在的
     容器视图，也不会让下面那几处 `=== 'lxc'` 各写一遍（见 ctSystemShown）。 */
  const activeTab: TemplateTab = ctNavOff ? 'qemu' : tab;

  const shown = activeTab === 'lxc' ? ctTemplates : vmTemplates;
  /* 标签页上的数字必须把两类都算上，否则又会回到「我有 2 个却显示 0」 */
  const ctCount = ctTemplates.length + ctSystem.length;
  /* 系统模板**只在「容器模板」标签页**露面。
     它是容器的东西（vztmpl 文件），放到虚拟机模板页上不对题，而且会把那一页
     整个搞乱：虚拟机模板会被打上「已转为模板的容器」的分组标题，空态也不再
     触发（条件里算了系统模板）。

     下面是**唯一**的 tab 出口，渲染和判断都只看这一份 —— 分散着各写一遍
     `tab === 'lxc'`，漏掉任何一处都会重演这个 bug。 */
  const ctSystemShown = activeTab === 'lxc' ? ctSystem : [];

  /* 「从现有虚拟机转换为模板」需要虚拟机列表，且只在要用到时才拉取 ——
     转换弹窗和创建向导里都有这一个页签，两个开关都要算进去。
     普通用户在这里只会看到自己名下的虚拟机（这正是期望的范围）。 */
  const convertCandidatesNeeded = convertOpen || wizardOpen;
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    enabled: convertCandidatesNeeded,
    staleTime: 30_000,
  });

  /* 容器同样能转模板（PVE 的 pct template），所以候选里也要有容器。
     容器关掉时不拉：转出来的「已转模板的容器」在这一页已经没有位置了
     （容器模板页签被隐去），这个列表纯粹是白跑一趟。 */
  const lxcQuery = useQuery({
    queryKey: ['lxc', 'all'],
    queryFn: () => lxcApi.list(),
    enabled: convertCandidatesNeeded && !ctNavOff,
    staleTime: 30_000,
  });

  /* 转换候选 = 非模板的虚拟机 + 非模板的容器（容器关掉时只有前者）。
     否则「从现有机器转换」的下拉里还留着容器，转出来的模板却无处可看 ——
     与页签隐去是同一件事的两半。 */
  const nonTemplates = useMemo(
    () =>
      [...(vmsQuery.data ?? []), ...(ctNavOff ? [] : (lxcQuery.data ?? []))].filter(
        (v) => !v.template,
      ),
    [vmsQuery.data, lxcQuery.data, ctNavOff],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
    void queryClient.invalidateQueries({ queryKey: ['lxc'] });
    void queryClient.invalidateQueries({ queryKey: ['templates'] });
    void queryClient.invalidateQueries({ queryKey: ['cluster'] });
  };

  /* 把一台非模板机器转成模板。
     转换弹窗与创建向导里的那个页签共用这一份 —— 两条路径的行为、报错和刷新
     必须一致，各写一份迟早会分叉。
     注意：机器必须先关机，后端对运行中的机器直接回 409。 */
  const convertToTemplate = async (vm: VmSummary) => {
    setBusy(true);
    try {
      await runner.run(
        /* 容器走 /lxc 那条（PVE 的 pct template），虚拟机走 /vms 那条 */
        vm.type === 'lxc'
          ? lxcApi.toTemplate(vm.node, vm.vmid, vm.connection_id)
          : vmsApi.toTemplate(vm.node, vm.vmid, vm.connection_id),
        {
          title: t('templates.convertTask', { name: vm.name || vm.vmid }),
          node: vm.node,
          invalidate: [['vms'], ['lxc'], ['templates'], ['cluster']],
        },
      );
      /* 两个入口都关掉：不管用户是从哪个弹窗点的，转换完都不该再留着它 */
      setConvertOpen(false);
      setWizardOpen(false);
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  /* 列表视图：与卡片同信息量，操作列锁在最后（顺序不能让用户拖走） */
  /* 系统模板（vztmpl）的列。刻意比模板机少几列：它是个**文件**，
     没有 CPU/内存/运行时长这些「机器」才有的属性，摆上来只会是一排「—」。 */
  const ctSystemColumns = useMemo<Array<Column<CtSystemTemplate>>>(
    () => [
      {
        key: 'name',
        header: t('templates.colName'),
        width: 260,
        render: (tpl) => (
          <span className="flex items-center gap-8" title={tpl.volid}>
            <IconDisk size={15} aria-hidden="true" />
            <span className="truncate">{tpl.name}</span>
          </span>
        ),
      },
      {
        key: 'storage',
        header: t('templates.colStorage'),
        width: 140,
        render: (tpl) => <code className="fs-xs">{tpl.storage}</code>,
      },
      {
        key: 'node',
        header: t('templates.colNode'),
        width: 140,
        render: (tpl) => (
          <span className="flex items-center gap-6">
            {/* 共享存储给徽章而不是节点名：模板在这台集群的任意节点都能用，
                写死一个节点等于凭空给用户加了一条限制（见 ctShared） */}
            {tpl.shared ? (
              <Badge variant="neutral" size="sm" title={t('templates.ctSharedHint')}>
                {t('templates.ctShared')}
              </Badge>
            ) : (
              tpl.node
            )}
            {tpl.connection_name ? (
              <Badge variant="neutral" size="sm">
                {tpl.connection_name}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: 'size',
        header: t('templates.colSize'),
        width: 100,
        render: (tpl) => <span className="mono">{formatBytes(tpl.size, 0)}</span>,
      },
      {
        key: 'actions',
        header: '',
        width: 120,
        align: 'right',
        locked: true,
        label: t('common.actions'),
        render: (tpl) => (
          <span
            className="form-row"
            style={{ gap: 6, justifyContent: 'flex-end' }}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={!canCreateCt}
              onClick={() => setCtPreset(tpl)}
            >
              {t('templates.ctCreate')}
            </Button>
          </span>
        ),
      },
    ],
    [canCreateCt, t],
  );

  const templateColumns = useMemo<Array<Column<TemplateItem>>>(
    () => [
      {
        key: 'name',
        header: t('templates.colName'),
        width: 200,
        render: (tpl) => (
          <span className="fw-600" title={tpl.name}>
            {tpl.name || `${activeTab === 'lxc' ? 'CT' : 'VM'} ${tpl.vmid}`}
          </span>
        ),
      },
      {
        key: 'vmid',
        header: 'VMID',
        width: 90,
        mono: true,
        render: (tpl) => tpl.vmid,
      },
      {
        key: 'node',
        header: t('common.node'),
        width: 150,
        render: (tpl) => (
          <span>
            {tpl.node}
            {tpl.connection_name ? (
              <span className="text-muted"> · {tpl.connection_name}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'cpu',
        header: 'CPU',
        width: 80,
        render: (tpl) => t('templates.coresValue', { count: tpl.maxcpu ?? '—' }),
      },
      {
        key: 'mem',
        header: t('templates.colMem'),
        width: 100,
        render: (tpl) => formatBytes(tpl.maxmem, 0),
      },
      {
        key: 'disk',
        header: t('templates.colDisk'),
        width: 100,
        render: (tpl) => formatBytes(tpl.maxdisk, 0),
      },
      {
        key: 'tags',
        header: t('templates.colTags'),
        width: 160,
        render: (tpl) =>
          parseTags(tpl.tags).length ? (
            <TagList tags={parseTags(tpl.tags)} max={2} />
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        key: 'actions',
        header: t('templates.colActions'),
        width: 170,
        align: 'right',
        locked: true,
        label: t('templates.colActions'),
        render: (tpl) => (
          /* row-actions：与列表页一致的操作单元格（右对齐、紧凑间距） */
          <span className="row-actions">
            <Button
              size="sm"
              variant="primary"
              onClick={() => setCloneTarget(tpl)}
              disabled={!canClone}
            >
              {t('templates.clone')}
            </Button>
            <IconButton
              label={t('templates.viewDetail')}
              onClick={() =>
                navigate(
                  tpl.guest_type === 'lxc'
                    ? `/lxc/${tpl.node}/${tpl.vmid}`
                    : `/vms/${tpl.node}/${tpl.vmid}`,
                )
              }
            >
              <IconEye size={15} />
            </IconButton>
            <IconButton
              label={t('templates.deleteAria', { name: tpl.name })}
              variant="danger"
              onClick={() => setDeleteTarget(tpl)}
              disabled={!canManage}
            >
              <IconTrash size={15} />
            </IconButton>
          </span>
        ),
      },
    ],
    [canClone, canManage, navigate, activeTab, t],
  );

  return (
    <PageShell
      title={
        <>
          <IconTemplate size={20} />
          {t('templates.title')}
        </>
      }
      /* 总数与容器数都要算上系统模板，否则会出现「共 4 个模板（容器 0）」
         而标签页上写着「容器模板（5）」的自相矛盾 —— 同一屏里两个数字对不上，
         比数字本身错更让人不敢信。 */
      subtitle={t('templates.subtitle', {
        total: templates.length + ctSystem.length,
        vm: vmTemplates.length,
        ct: ctCount,
      })}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void templatesQuery.refetch()}
            loading={templatesQuery.isFetching && !templatesQuery.isLoading}
          >
            {t('templates.refresh')}
          </Button>
          {canManage ? (
            <>
              {/* 「从现有机器转换」必须常驻在页头。以前它只出现在列表为空的
                  空状态里，于是模板库一旦有东西，用户就再也找不到这个入口了。 */}
              <Button
                variant="secondary"
                icon={<IconVm size={15} />}
                onClick={() => setConvertOpen(true)}
                title={t('templates.convertDesc')}
              >
                {t('templates.convertFromVm')}
              </Button>
              <Button
                variant="primary"
                icon={<IconPlus size={15} />}
                onClick={() => setWizardOpen(true)}
              >
                {t('templates.create')}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      {/* ---- 最佳实践说明 ---- */}
      <CollapsibleCard
        title={t('templates.bestPractice')}
        icon={<IconCloud size={16} />}
      >
        <ul>
          <li>
            <strong>{t('templates.bpImage')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpImageBody')}
          </li>
          <li>
            <strong>{t('templates.bpBus')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpBusBody')}
          </li>
          <li>
            <strong>{t('templates.bpFirmware')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpFirmwareBody')}
          </li>
          <li>
            <strong>{t('templates.bpCiDriver')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpCiDriverBody')}
          </li>
          <li>
            <strong>{t('templates.bpDefaultUser')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpDefaultUserBody')}
          </li>
          <li>
            <strong>{t('templates.bpNetwork')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpNetworkBody')}
          </li>
          <li>
            <strong>{t('templates.bpMemory')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpMemoryBody')}
          </li>
          <li>
            <strong>{t('templates.bpCleanup')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpCleanupBody')}
          </li>
          <li>
            <strong>{t('templates.bpTags')}</strong>
            {t('templates.bpColon')}
            {t('templates.bpTagsBody')}
          </li>
        </ul>
      </CollapsibleCard>

      {/* ---- 工具栏：类型标签页 + 搜索 + 展示方式 ---- */}
      <div className="toolbar">
        <div className="toolbar-left">
          <SegmentedControl<TemplateTab>
            value={activeTab}
            onChange={setTab}
            ariaLabel={t('templates.tabTypeAria')}
            options={
              ctNavOff
                ? /* 容器被导航栏功能开关关掉：这个页签整项隐去。留着它等于给了一个
                     点进去也会被路由弹回来的死入口（/lxc 已被 Layout 拦截）。 */
                  [{ label: t('templates.tabVm', { count: vmTemplates.length }), value: 'qemu' }]
                : [
                    {
                      label: t('templates.tabVm', { count: vmTemplates.length }),
                      value: 'qemu',
                    },
                    {
                      /* 两类都算上：已转为模板的容器 + 系统模板文件。
                         只数前者正是「明明有 2 个容器模板却显示 0」的原因。 */
                      label: t('templates.tabCt', { count: ctCount }),
                      value: 'lxc',
                    },
                  ]
            }
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('templates.searchPlaceholder')}
            block={false}
            aria-label={t('templates.searchAria')}
          />
        </div>
        <div className="toolbar-right">
          <SegmentedControl<ViewMode>
            value={view}
            onChange={setView}
            ariaLabel={t('templates.viewAria')}
            options={[
              { label: t('templates.viewCards'), value: 'cards' },
              { label: t('templates.viewList'), value: 'list' },
            ]}
          />
          <span className="fs-sm text-muted">
            {t('templates.totalShown', { count: shown.length })}
          </span>
        </div>
      </div>

      {/* ---- 模板列表：卡片网格 或 表格 ---- */}
      {templatesQuery.isLoading ? (
        <CardSkeleton count={4} height={200} />
      ) : !pveReady || templatesQuery.isError ? (
        <PveQueryError
          title={t('templates.loadFailed')}
          error={templatesQuery.error}
          onRetry={() => void templatesQuery.refetch()}
        />
      ) : shown.length === 0 && ctSystemShown.length === 0 ? (
        <Card>
          <EmptyState
            title={
              search
                ? t('templates.emptySearch')
                : activeTab === 'lxc'
                  ? t('templates.emptyCt')
                  : t('templates.emptyVm')
            }
            description={
              search ? (
                t('templates.emptySearchDesc')
              ) : (
                <>
                  {t('templates.emptyDesc')}
                  {/* 向导能覆盖绝大多数场景，但批量/自动化场景直接给命令更快，
                      省得用户去翻 PVE 文档 */}
                  <span className="empty-cli">
                    {t('templates.emptyCli')}
                    <code className="mono">{t('templates.emptyCliImport')}</code>
                    {t('templates.emptyCliTail')}
                    <code className="mono">
                      {t('templates.emptyCliTemplate')}
                    </code>
                  </span>
                </>
              )
            }
            icon={<IconTemplate size={30} />}
            action={
              canManage && !search ? (
                <div className="flex gap-8">
                  <Button
                    variant="primary"
                    icon={<IconCloud size={15} />}
                    onClick={() => setWizardOpen(true)}
                  >
                    {t('templates.createFromImage')}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<IconVm size={15} />}
                    onClick={() => setConvertOpen(true)}
                  >
                    {t('templates.convertFromVm')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* 容器系统模板（vztmpl 文件）：用来**新建**容器，不是拿来克隆的机器。
              两类在 PVE 里都叫「模板」，这里分开列并各自标名 —— 混成一个列表
              会让人以为点「克隆」就能用这些文件建出机器来。
              只在「容器模板」标签页出现（见 ctSystemShown）。 */}
          {ctSystemShown.length > 0 ? (
            <section className="mb-20">
              <div className="flex items-center gap-8 flex-wrap mb-10">
                <h3 className="card-title">{t('templates.ctSystemTitle')}</h3>
                <span className="fs-xs text-muted">
                  {t('templates.ctSystemHint')}
                </span>
              </div>
              {view === 'cards' ? (
                <div className="grid grid-auto-320">
                  {ctSystemShown.map((tpl) => (
                    <CtSystemTemplateCard
                      key={`${tpl.connection_id}/${tpl.node}/${tpl.volid}`}
                      template={tpl}
                      canCreate={canCreateCt}
                      onCreate={() => setCtPreset(tpl)}
                    />
                  ))}
                </div>
              ) : (
                <Table<CtSystemTemplate>
                  columns={ctSystemColumns}
                  rows={ctSystemShown}
                  rowKey={(tpl) => `${tpl.connection_id}/${tpl.node}/${tpl.volid}`}
                  caption={t('templates.ctSystemCaption')}
                />
              )}
            </section>
          ) : null}

          {shown.length > 0 ? (
            <section>
              {/* 只有「容器模板」页上两类同时在列时才要这个小标题：只有一类时
                  不加，免得凭空多一层。用 ctSystemShown 而不是 ctSystem ——
                  否则在虚拟机模板页上，这一页的虚拟机模板会被打上
                  「已转为模板的容器」的标题。 */}
              {ctSystemShown.length > 0 ? (
                <h3 className="card-title mb-10">
                  {t('templates.ctConvertedTitle')}
                </h3>
              ) : null}
              {view === 'cards' ? (
                <div className="grid grid-auto-320">
                  {shown.map((t) => (
                    <TemplateCard
                      key={`${t.connection_id}/${t.node}/${t.vmid}`}
                      template={t}
                      canClone={canClone}
                      canManage={canManage}
                      onClone={() => setCloneTarget(t)}
                      onDelete={() => setDeleteTarget(t)}
                      onOpen={() =>
                        navigate(
                          t.guest_type === 'lxc'
                            ? `/lxc/${t.node}/${t.vmid}`
                            : `/vms/${t.node}/${t.vmid}`,
                        )
                      }
                    />
                  ))}
                </div>
              ) : (
                <Table<TemplateItem>
                  columns={templateColumns}
                  rows={shown}
                  rowKey={(tpl) => `${tpl.connection_id}/${tpl.node}/${tpl.vmid}`}
                  caption={t('templates.tableCaption', {
                    kind:
                      activeTab === 'lxc'
                        ? t('templates.kindCt')
                        : t('templates.kindVm'),
                  })}
                />
              )}
            </section>
          ) : null}
        </>
      )}

      {/* ---- 创建模板向导 ---- */}
      <TemplateCreateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={invalidate}
        candidates={nonTemplates}
        busy={busy}
        onConvert={convertToTemplate}
      />

      {/* ---- 从现有 VM 转换 ---- */}
      <Modal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        title={t('templates.convertTitle')}
        description={t('templates.convertDesc')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConvertOpen(false)}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        <ConvertForm
          vms={nonTemplates}
          busy={busy}
          onSubmit={convertToTemplate}
        />
      </Modal>

      {/* ---- 克隆 ---- */}
      <CloneTemplateDialog
        template={cloneTarget}
        onClose={() => setCloneTarget(null)}
        onDone={() => {
          invalidate();
          setCloneTarget(null);
        }}
      />

      {/* ---- 用系统模板新建容器 ----
          复用容器创建向导，只把「节点 + 模板」预选好。模板是节点级资源，
          三个值必须一起给：少了连接或节点，选中的 volid 不在当前节点的模板
          列表里，下拉会显示成空值。 */}
      <LxcCreateWizard
        open={ctPreset !== null}
        onClose={() => setCtPreset(null)}
        initialTemplate={ctPreset?.volid}
        initialNode={ctPreset?.node}
        initialConnection={ctPreset?.connection_id}
        onCreated={() => {
          invalidate();
          setCtPreset(null);
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
            /* 容器模板走容器接口：/vms 那套删不掉 lxc（端点不同） */
            await runner.run(
              deleteTarget.guest_type === 'lxc'
                ? lxcApi.delete(
                    deleteTarget.node,
                    deleteTarget.vmid,
                    true,
                    false,
                    deleteTarget.connection_id,
                  )
                : vmsApi.delete(
                    deleteTarget.node,
                    deleteTarget.vmid,
                    true,
                    deleteTarget.connection_id,
                  ),
              {
                title: t('templates.deleteTask', {
                  name: deleteTarget.name || deleteTarget.vmid,
                }),
                node: deleteTarget.node,
                invalidate: [['vms'], ['templates'], ['cluster'], ['storages']],
              },
            );
            setDeleteTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('templates.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        requireText={deleteTarget?.name || String(deleteTarget?.vmid ?? '')}
        message={
          <>
            {t('templates.deleteBodyPre')}
            <strong>
              {deleteTarget?.name || `VM ${deleteTarget?.vmid}`}
            </strong>
            {t('templates.deleteBodyTail', { vmid: deleteTarget?.vmid })}
          </>
        }
      />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   模板卡片
   --------------------------------------------------------------------------- */

/**
 * 一个容器**系统模板**（vztmpl 文件）。与 :func:`TemplateCard` 并列但不同源：
 * 那边是「被转成模板的机器」（有 VMID、能克隆），这边是存储里的一个文件，
 * 只能拿来**新建**容器。所以这里不摆 CPU / 内存 / 运行时长 —— 文件没有这些，
 * 摆上来只会是一排「—」。
 */
function CtSystemTemplateCard({
  template,
  canCreate,
  onCreate,
}: {
  template: CtSystemTemplate;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const t = useT();
  return (
    <article className="entity-card">
      <div className="entity-card-head">
        <div className="entity-card-title">
          <span className="entity-card-name" title={template.volid}>
            {template.name}
          </span>
          {/* 共享存储上的模板集群内任意节点都能用，写一个节点名会暗示「它属于
              那一台」（cephfs 上的模板因此看着像绑在 node02 上）。 */}
          <span className="entity-card-sub">
            {template.storage} ·{' '}
            {template.shared ? t('templates.ctShared') : template.node}
            {template.connection_name ? ` · ${template.connection_name}` : ''}
          </span>
        </div>
        <Badge variant="neutral" size="sm">
          {t('templates.ctSystemBadge')}
        </Badge>
      </div>

      <div className="entity-card-stats">
        <div className="entity-stat">
          <span className="entity-stat-label">{t('templates.colSize')}</span>
          <span className="entity-stat-value">{formatBytes(template.size, 0)}</span>
        </div>
      </div>

      <div className="fs-xs text-muted mono truncate" title={template.volid}>
        {template.volid}
      </div>

      <div className="entity-card-footer">
        <div className="flex items-center gap-4">
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={14} />}
            disabled={!canCreate}
            title={
              canCreate ? undefined : t('templates.ctCreateNeedsPermission')
            }
            onClick={onCreate}
          >
            {t('templates.ctCreate')}
          </Button>
        </div>
      </div>
    </article>
  );
}

function TemplateCard({
  template,
  canClone,
  canManage,
  onClone,
  onDelete,
  onOpen,
}: {
  template: TemplateItem;
  canClone: boolean;
  canManage: boolean;
  onClone: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <article className="entity-card">
      <div className="entity-card-head">
        <div className="entity-card-title">
          <span className="entity-card-name" title={template.name}>
            {template.name || `VM ${template.vmid}`}
          </span>
          <span className="entity-card-sub">
            VMID {template.vmid} · {template.node}
            {template.connection_name ? ` · ${template.connection_name}` : ''}
          </span>
        </div>
        {/* 类型由标签页区分，卡片上只标「模板」 */}
        <Badge variant="accent" size="sm">
          {t('templates.badge')}
        </Badge>
      </div>

      <div className="entity-card-stats">
        <div className="entity-stat">
          <span className="entity-stat-label">CPU</span>
          <span className="entity-stat-value">
            {t('templates.coresValue', { count: template.maxcpu ?? '—' })}
          </span>
        </div>
        <div className="entity-stat">
          <span className="entity-stat-label">{t('templates.colMem')}</span>
          <span className="entity-stat-value">
            {formatBytes(template.maxmem, 0)}
          </span>
        </div>
        <div className="entity-stat">
          <span className="entity-stat-label">{t('templates.colDisk')}</span>
          <span className="entity-stat-value">
            {formatBytes(template.maxdisk, 0)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-8 flex-wrap">
        <span className="fs-xs text-muted">
          {t('templates.osValue', {
            value: ostypeLabel(template.type, t),
          })}
        </span>
        <span className="fs-xs text-muted">·</span>
        <span className="fs-xs text-muted">
          {t('templates.uptime', {
            uptime: formatUptimeShort(template.uptime),
          })}
        </span>
      </div>

      {parseTags(template.tags).length > 0 ? (
        <TagList tags={parseTags(template.tags)} max={4} />
      ) : null}

      <div className="entity-card-footer">
        <div className="flex items-center gap-4">
          <Button
            variant="primary"
            size="sm"
            icon={<IconCopy size={14} />}
            onClick={onClone}
            disabled={!canClone}
          >
            {t('templates.clone')}
          </Button>
          <IconButton label={t('templates.viewDetail')} onClick={onOpen}>
            <IconEye size={15} />
          </IconButton>
        </div>
        <IconButton
          label={t('templates.deleteAria', { name: template.name })}
          variant="danger"
          onClick={onDelete}
          disabled={!canManage}
        >
          <IconTrash size={15} />
        </IconButton>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------------------
   从现有虚拟机 / 容器转换表单
   --------------------------------------------------------------------------- */

function ConvertForm({
  vms,
  busy,
  onSubmit,
}: {
  vms: VmSummary[];
  busy: boolean;
  onSubmit: (vm: VmSummary) => void | Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState('');

  const options = [
    { label: t('templates.convertPick'), value: '' },
    ...vms.map((v) => ({
      label: `${v.name || `${v.type === 'lxc' ? 'CT' : 'VM'} ${v.vmid}`} · ${
        v.vmid
      } @ ${v.node} (${v.status})`,
      value: `${v.node}:${v.vmid}:${v.type ?? 'qemu'}`,
    })),
  ];

  const target = useMemo(() => {
    if (!selected) return undefined;
    const [node, idStr, type] = selected.split(':');
    const vmid = Number(idStr);
    return vms.find(
      (v) => v.node === node && v.vmid === vmid && (v.type ?? 'qemu') === type,
    );
  }, [selected, vms]);

  return (
    <div className="flex flex-col gap-16">
      <Select
        label={t('templates.convertTarget')}
        required
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        options={options}
        hint={
          vms.length === 0
            ? t('templates.convertNone')
            : t('templates.convertHint')
        }
      />

      <Notice tone="warning" title={t('templates.convertNoticeTitle')}>
        {t('templates.convertNoticeBody')}
      </Notice>

      <Button
        variant="danger"
        onClick={() => target && void onSubmit(target)}
        disabled={!target || busy}
        loading={busy}
        block
      >
        {t('templates.convertSubmit')}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   模板克隆对话框
   --------------------------------------------------------------------------- */

function CloneTemplateDialog({
  template,
  onClose,
  onDone,
}: {
  template: TemplateItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const { hasPermission } = useAuth();
  /* 这个对话框做的是「把机器转成模板」—— 属于模板管理 */
  const canManage = hasPermission('template.manage');

  const [newId, setNewId] = useState('');
  const [name, setName] = useState('');
  /** 默认链接克隆：以模板磁盘为 backing file，秒级完成且几乎不占空间 */
  const [full, setFull] = useState(false);
  const [targetStorage, setTargetStorage] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [description, setDescription] = useState('');
  /** 内存气球的最低保留量（MB）。空 = 不下发（沿用模板的值） */
  const [balloon, setBalloon] = useState('');
  const [busy, setBusy] = useState(false);

  /* 容器模板与虚拟机模板的克隆参数不同：容器没有链接克隆，且占用 rootdir 存储 */
  const isLxc = template?.guest_type === 'lxc';

  const nextIdQuery = useQuery({
    queryKey: ['cluster', 'nextid', template?.connection_id ?? ''],
    queryFn: () => clusterApi.nextId(template?.connection_id),
    enabled: Boolean(template),
    retry: false,
    staleTime: 0,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes', template?.connection_id ?? ''],
    queryFn: () => nodesApi.list(template?.connection_id),
    enabled: Boolean(template),
    staleTime: 60_000,
  });

  /* 存储 / 节点都取自模板所在的那台 PVE，且只列**目标节点上**的存储池
     （见 useNodeStorages：它会带上该节点的连接，避免被页面级连接带偏） */
  const storagesQuery = useNodeStorages(
    targetNode || template?.node || '',
    template?.connection_id,
    Boolean(template),
  );

  /* 面板默认 DNS：本对话框不单独填 DNS，由后端套用默认值，这里只做告知 */
  const vmDefaultsQuery = useQuery({
    queryKey: ['config', 'vm-defaults'],
    queryFn: configApi.getVmDefaults,
    enabled: Boolean(template),
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (template) {
      setName(`${template.name || `vm-${template.vmid}`}-clone`);
      setTargetNode('');
      setTargetStorage('');
      setDescription('');
      setBalloon('');
      setFull(false);
    }
  }, [template]);

  /* 按面板默认克隆方式预选（「设置 → 创建默认值 → 默认克隆方式」）。只在每次打开
     后第一次拿到默认值时填一次：用户勾过之后再回填，等于顶掉他的选择。
     容器模板没有这个勾选项（PVE 的 pct clone 只有全量），预填对它无影响。 */
  const fullPrefillRef = useRef(false);
  useEffect(() => {
    if (!template) {
      fullPrefillRef.current = false;
      return;
    }
    const defaults = vmDefaultsQuery.data;
    if (fullPrefillRef.current || !defaults) return;
    fullPrefillRef.current = true;
    setFull(Boolean(defaults.full_clone));
  }, [template, vmDefaultsQuery.data]);

  useEffect(() => {
    if (template && !newId && nextIdQuery.data?.vmid) {
      setNewId(String(nextIdQuery.data.vmid));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextIdQuery.data, template]);

  const idNum = Number(newId);
  const idError =
    newId && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? t('templates.vmidRule')
      : undefined;

  /* 虚拟机占 images 存储、容器占 rootdir 存储 —— 别把放不下的选项列给用户挑 */
  const storageContent = isLxc ? 'rootdir' : 'images';
  const storageOptions = [
    { label: t('templates.storageInherit'), value: '' },
    ...(storagesQuery.data ?? [])
      .filter(
        (s) =>
          s.active &&
          s.content.split(/[,;]/).some((c) => c.trim() === storageContent),
      )
      .map((s) => ({
        label: t('templates.storageAvail', {
          storage: s.storage,
          avail: formatBytes(s.avail),
        }),
        value: s.storage,
      })),
  ];

  const submit = async () => {
    if (!template || !newId || idError || !canManage) return;
    setBusy(true);
    try {
      if (isLxc) {
        /* 容器模板走容器克隆接口：它会算容器额度、审计为 ct.clone。
           注意容器没有链接克隆（PVE 的 pct clone 只有全量），所以不传 full。 */
        await runner.run(
          lxcApi.clone(
            template.node,
            template.vmid,
            {
              newid: idNum,
              hostname: name || `ct-${template.vmid}-clone`,
              target_storage: targetStorage || undefined,
              target_node: targetNode || undefined,
              description: description || undefined,
            },
            template.connection_id,
          ),
          {
            title: t('templates.cloneTaskCt', { vmid: idNum }),
            node: template.node,
            invalidate: [['vms'], ['lxc'], ['templates'], ['cluster'], ['storages']],
          },
        );
      } else {
        await runner.run(
          /* 走模板专用接口：模板属于共享资源、没有归属记录，用 /vms 的克隆接口
             会被归属校验拒绝 403；连接必须是模板所在的那台 PVE。 */
          templatesApi.clone(
            {
              source_node: template.node,
              source_vmid: template.vmid,
              newid: idNum,
              /* 后端该字段必填，缺省时给一个与表单一致的兜底名 */
              name: name || `vm-${template.vmid}-clone`,
              full,
              storage: targetStorage || undefined,
              target_node: targetNode || undefined,
              /* 内存气球：覆盖模板自带的值（模板不带就是「整份内存不回收」） */
              balloon: balloon.trim() ? Number(balloon) : undefined,
              description: description || undefined,
              /* 与旧行为保持一致：克隆完不自动开机 */
              start: false,
            },
            template.connection_id,
          ),
          {
            title: t('templates.cloneTaskVm', { vmid: idNum }),
            node: template.node,
            invalidate: [['vms'], ['templates'], ['cluster'], ['storages']],
          },
        );
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(template)}
      onClose={onClose}
      title={isLxc ? t('templates.cloneCtTitle') : t('templates.cloneVmTitle')}
      description={
        template
          ? t('templates.cloneFrom', {
              name: template.name || `${isLxc ? 'CT' : 'VM'} ${template.vmid}`,
              meta: `${template.connection_name ? `${template.connection_name} · ` : ''}${template.node}`,
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
            {t('templates.cloneStart')}
          </Button>
        </>
      }
    >
      <div className="form-grid-2">
        <Input
          label={t('templates.cloneNewId')}
          required
          value={newId}
          onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))}
          error={idError}
          hint={
            nextIdQuery.data
              ? t('templates.cloneSuggested', { vmid: nextIdQuery.data.vmid })
              : t('templates.cloneUnique')
          }
        />
        <Input
          label={
            isLxc ? t('templates.cloneNewHostname') : t('templates.cloneNewName')
          }
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            isLxc
              ? t('templates.cloneHostnamePlaceholder')
              : t('templates.cloneNamePlaceholder')
          }
        />
        <Select
          label={t('templates.cloneTargetNode')}
          value={targetNode}
          onChange={(e) => setTargetNode(e.target.value)}
          options={[
            { label: t('templates.cloneSameNode'), value: '' },
            ...(nodesQuery.data ?? []).map((n) => ({
              label: n.node,
              value: n.node,
            })),
          ]}
        />
        {/* 内存气球：模板不带这个值时 PVE 按整份内存算，克隆体在宿主机上收不回内存 */}
        {isLxc ? null : (
          <Input
            label={t('templates.cloneBalloon')}
            type="number"
            min={0}
            step={256}
            value={balloon}
            onChange={(e) => setBalloon(e.target.value)}
            hint={t('templates.cloneBalloonHint')}
          />
        )}
        <Select
          label={t('templates.cloneTargetStorage')}
          value={targetStorage}
          onChange={(e) => setTargetStorage(e.target.value)}
          options={storageOptions}
          hint={t('templates.cloneStorageHint')}
        />
      </div>

      <div className="mt-16">
        {isLxc ? (
          <div className="field-message">{t('templates.cloneCtFullNotice')}</div>
        ) : (
          <>
            <Checkbox
              checked={full}
              onChange={(e) => setFull(e.target.checked)}
              label={t('templates.cloneFullCheck')}
            />
            <div className="field-message">
              {t('templates.cloneLinkedNotice')}
            </div>
          </>
        )}
      </div>

      <div className="mt-16">
        <Textarea
          label={t('common.description')}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('templates.cloneDescPlaceholder')}
        />
        <div className="field-message">
          {vmDefaultsQuery.data?.dns ? (
            <>
              {t('templates.cloneDnsDefault', {
                dns: vmDefaultsQuery.data.dns,
              })}
            </>
          ) : (
            <>{t('templates.cloneDnsNone')}</>
          )}
        </div>
      </div>

      {!isLxc && !full ? (
        <div className="mt-16">
          <Notice tone="warning" title={t('templates.cloneLinkedTitle')}>
            {t('templates.cloneLinkedBody')}
          </Notice>
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   创建模板向导（模式 A / 模式 B）
   --------------------------------------------------------------------------- */

type CreateMode = 'image' | 'convert';

function TemplateCreateWizard({
  open,
  onClose,
  onCreated,
  candidates,
  busy,
  onConvert,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** 「从现有 VM 转换」页签的候选：非模板的虚拟机与容器 */
  candidates: VmSummary[];
  busy: boolean;
  onConvert: (vm: VmSummary) => void | Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const { hasPermission } = useAuth();
  /* 新建 / 导入模板属于模板管理 */
  const canManage = hasPermission('template.manage');

  const [mode, setMode] = useState<CreateMode>('image');

  /* 关掉时回到默认页签。向导的主线是「从镜像生成」，转换另有页头那个入口；
     不复位的话，上次从「从现有 VM 转换」页签离开，下次打开就会停在那儿。 */
  useEffect(() => {
    if (!open) setMode('image');
  }, [open]);

  /* 模式 A 表单 */
  const [node, setNode] = useState('');
  const [vmid, setVmid] = useState('');
  const [name, setName] = useState('');
  const [ostype, setOstype] = useState('l26');
  const [cpuType, setCpuType] = useState('host');
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(2048);
  /** 内存气球的最低保留量（MB）。空 = 不下发（PVE 默认按整份内存，不回收） */
  const [balloon, setBalloon] = useState('');
  const [diskStorage, setDiskStorage] = useState('');
  const [diskSize, setDiskSize] = useState(20);
  const [bridge, setBridge] = useState('vmbr0');
  const [ciUser, setCiUser] = useState('ubuntu');
  const [sshKey, setSshKey] = useState('');
  const [imageVolId, setImageVolId] = useState('');
  const [ciEnabled, setCiEnabled] = useState(true);
  const [tags, setTags] = useState('template');
  const [submitting, setSubmitting] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled: open,
    staleTime: 60_000,
  });

  /* 目标节点所属的 PVE 连接。节点是从**全部连接**里挑的，取号与创建都必须带上
     它的连接：不带就会落到「面板当前连接」（或后端兜底的那台），在别的集群的
     节点名上建机会直接 hostname lookup 失败，而 VMID 也可能与那台上的机器撞号
     （每台 PVE 的 VMID 空间各自独立）。 */
  const nodeConn = useMemo(
    () => (nodesQuery.data ?? []).find((n) => n.node === node)?.connection_id ?? '',
    [nodesQuery.data, node],
  );

  const nextIdQuery = useQuery({
    queryKey: ['cluster', 'nextid', nodeConn],
    queryFn: () => clusterApi.nextId(nodeConn),
    enabled: open,
    retry: false,
    staleTime: 0,
  });

  /* 磁盘存储池：只列**所选节点上**的池子，并带上该节点所属连接 —— 这台主机上
     可能挂着别的 PVE 的节点，只按名字查会被页面级连接带到别处（见 useNodeStorages） */
  const storagesQuery = useNodeStorages(node, undefined, open);

  /* 可作模板系统盘来源的镜像。
     这件事交给后端（/api/templates/images）：它要同时扫 import 与 iso 两种
     存储内容，还得知道每种内容里 PVE 认哪些扩展名 —— 前端自己扫容易漏，
     之前就漏掉了 import 目录，导致 .qcow2 永远选不到。 */
  const imagesQuery = useQuery({
    queryKey: ['templates', 'images', nodeConn, node],
    queryFn: () => templatesApi.images(node, nodeConn),
    enabled: open && Boolean(node),
    retry: false,
  });

  const bridgesQuery = useQuery({
    queryKey: ['nodes', nodeConn, node, 'network'],
    queryFn: () => nodesApi.network(node, nodeConn),
    enabled: open && Boolean(node),
    retry: false,
    staleTime: 60_000,
  });

  /* 初始化默认值 */
  useEffect(() => {
    if (!open) return;
    setMode('image');
    setSubmitting(false);
    setNode('');
    setVmid('');
    setName('');
    setDiskStorage('');
    setImageVolId('');
    setSshKey('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setVmid((v) => v || (nextIdQuery.data ? String(nextIdQuery.data.vmid) : ''));
    setNode((n) => {
      if (n) return n;
      const list = nodesQuery.data ?? [];
      const online = list.find((x) => x.status === 'online');
      return online?.node ?? list[0]?.node ?? '';
    });
  }, [open, nextIdQuery.data, nodesQuery.data]);

  const diskStorageOptions = useMemo(
    () => [
      { label: t('templates.wizStoragePlaceholder'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
        )
        .map((s) => ({
          label: t('templates.storageAvail', {
            storage: s.storage,
            avail: formatBytes(s.avail),
          }),
          value: s.storage,
        })),
    ],
    [storagesQuery.data, t],
  );

  const bridgeOptions = useMemo(() => {
    const ifaces = bridgesQuery.data ?? [];
    const bridges = ifaces.filter(
      (i) => i.type === 'bridge' || i.type === 'OVSBridge',
    );
    const list = bridges.length > 0 ? bridges : ifaces;
    return [
      { label: t('templates.wizBridgePlaceholder'), value: '' },
      ...list.map((i) => ({ label: i.iface, value: i.iface })),
    ];
  }, [bridgesQuery.data, t]);

  const idNum = Number(vmid);
  const idError =
    vmid && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? t('templates.vmidRule')
      : undefined;

  const canSubmit =
    canManage &&
    Boolean(node) &&
    Boolean(name.trim()) &&
    !idError &&
    Boolean(vmid) &&
    Boolean(diskStorage) &&
    memory >= 512 &&
    cores >= 1 &&
    /* 内存气球：留空 = 不回收；填了就必须低于内存上限 */
    (!balloon.trim() || (Number(balloon) >= 128 && Number(balloon) < memory));

  /* ---- 提交（模式 A） ---- */
  const submitImage = async () => {
    if (!canSubmit) {
      toast.warning(
        t('templates.wizIncomplete'),
        t('templates.wizIncompleteHint'),
      );
      return;
    }
    setSubmitting(true);
    try {
      /* 带上目标节点所属的连接：节点是从全部连接里挑的，不带会落到面板当前连接，
         在别的集群的节点名上建机会报 hostname lookup 失败 */
      const res = await vmsApi.create(
        {
          node,
          vmid: idNum,
          name: name.trim(),
          memory,
          cores,
          sockets: 1,
          /* 模板上的气球会被每个克隆继承 —— 想让克隆机能被宿主机回收内存就设它 */
          balloon: balloon.trim() ? Number(balloon) : undefined,
          cpu_type: cpuType,
          ostype,
          disks: [
            { storage: diskStorage, size: diskSize, interface: 'scsi0', format: 'qcow2' },
          ],
          networks: [
            { bridge, model: 'virtio', firewall: true },
          ],
          scsi_hw: 'virtio-scsi-single',
          bios: 'seabios',
          machine: 'pc',
          start_on_boot: false,
          tags: tags || undefined,
          description: t('templates.wizDesc'),
          source_image: imageVolId || undefined,
          target_storage: diskStorage,
          templateMode: true,
          cloudinit: ciEnabled
            ? {
                enabled: true,
                user: ciUser || undefined,
                ssh_keys: sshKey || undefined,
                ip_configs: [{ ip: 'dhcp', gateway: '' }],
              }
            : undefined,
        },
        nodeConn || undefined,
      );

      toast.success(
        t('templates.wizSubmitted'),
        t('templates.wizSubmittedDesc', { vmid: res.vmid ?? vmid }),
      );
      onCreated();
      onClose();
    } catch (err) {
      toast.error(t('templates.wizFailed'), errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('templates.createTitle')}
      description={t('templates.createDesc')}
      size="lg"
      footer={
        mode === 'image' ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submitImage}
              loading={submitting}
              disabled={!canSubmit}
            >
              {t('templates.create')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {t('templates.close')}
          </Button>
        )
      }
    >
      {/* 模式切换 */}
      <div className="mb-24">
        <SegmentedControl<CreateMode>
          value={mode}
          onChange={setMode}
          ariaLabel={t('templates.modeAria')}
          options={[
            {
              label: (
                <span className="flex items-center gap-6">
                  <IconCloud size={14} />
                  {t('templates.modeFromImage')}
                </span>
              ),
              value: 'image',
            },
            {
              label: (
                <span className="flex items-center gap-6">
                  <IconVm size={14} />
                  {t('templates.modeFromVm')}
                </span>
              ),
              value: 'convert',
            },
          ]}
        />
      </div>

      {mode === 'image' ? (
        <div className="wizard-section">
          <Notice tone="info" title={t('templates.pipelineTitle')}>
            {t('templates.pipelineBody')}
          </Notice>

          <div className="form-grid">
            <Input
              label={t('common.name')}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('templates.fieldNamePlaceholder')}
            />
            <Input
              label="VMID"
              required
              value={vmid}
              onChange={(e) => setVmid(e.target.value.replace(/\D/g, ''))}
              error={idError}
              hint={
                nextIdQuery.data
                  ? t('templates.cloneSuggested', { vmid: nextIdQuery.data.vmid })
                  : undefined
              }
            />
            <Select
              label={t('common.node')}
              required
              value={node}
              onChange={(e) => setNode(e.target.value)}
              options={[
                { label: t('templates.nodePlaceholder'), value: '' },
                ...(nodesQuery.data ?? []).map((n) => ({
                  label: `${n.node}${
                    n.status !== 'online' ? t('templates.nodeOffline') : ''
                  }`,
                  value: n.node,
                })),
              ]}
            />
            <Input
              label={t('templates.colTags')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="template;os:ubuntu"
            />
          </div>

          <div className="wizard-section-title">{t('templates.secSourceImage')}</div>
          <Select
            label={t('templates.fieldImage')}
            value={imageVolId}
            onChange={(e) => setImageVolId(e.target.value)}
            options={[
              { label: t('templates.fieldImageNone'), value: '' },
              ...(imagesQuery.data ?? []).map((img) => ({
                label: `${img.volid}（${formatBytes(img.size)}, ${img.storage}）`,
                value: img.volid,
              })),
            ]}
            hint={
              !node
                ? t('templates.fieldImagePickNode')
                : imagesQuery.isLoading
                  ? t('templates.fieldImageScanning')
                  : (imagesQuery.data ?? []).length === 0
                    ? t('templates.fieldImageNoneFound')
                    : t('templates.fieldImageHint')
            }
          />

          <div className="wizard-section-title">{t('templates.secSpecs')}</div>
          <div className="form-grid">
            <Select
              label={t('templates.fieldOstype')}
              value={ostype}
              onChange={(e) => setOstype(e.target.value)}
              options={ostypeOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
            <Select
              label={t('vmDetail.hwCpuType')}
              value={cpuType}
              onChange={(e) => setCpuType(e.target.value)}
              options={cpuTypeOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
            <Input
              label={t('vmDetail.cfgCores')}
              type="number"
              min={1}
              max={128}
              value={cores}
              onChange={(e) => setCores(Number(e.target.value) || 0)}
            />
            <Input
              label={t('vmDetail.cfgMemory')}
              type="number"
              min={512}
              step={512}
              value={memory}
              onChange={(e) => setMemory(Number(e.target.value) || 0)}
              hint={t('vmCreate.approxSize', {
                size: formatBytes(memory * 1024 ** 2),
              })}
            />
            {/* 模板的气球值会被每个克隆继承；不设则等于「整份内存不回收」 */}
            <Input
              label={t('templates.fieldBalloon')}
              type="number"
              min={0}
              step={256}
              value={balloon}
              onChange={(e) => setBalloon(e.target.value)}
              error={
                balloon.trim() && Number(balloon) >= memory
                  ? t('templates.balloonTooLarge')
                  : undefined
              }
              hint={t('templates.fieldBalloonHint')}
            />
            <Select
              label={t('templates.fieldDiskStorage')}
              required
              value={diskStorage}
              onChange={(e) => setDiskStorage(e.target.value)}
              options={diskStorageOptions}
            />
            <Input
              label={t('templates.fieldDiskSize')}
              type="number"
              min={1}
              value={diskSize}
              onChange={(e) => setDiskSize(Number(e.target.value) || 0)}
            />
            <Select
              label={t('templates.fieldBridge')}
              required
              value={bridge}
              onChange={(e) => setBridge(e.target.value)}
              options={bridgeOptions.length > 1 ? bridgeOptions : [{ label: 'vmbr0', value: 'vmbr0' }, ...bridgeOptions.filter((o) => o.value !== 'vmbr0')]}
              hint={
                bridgesQuery.isError
                  ? t('templates.bridgeLoadFailed')
                  : undefined
              }
            />
          </div>

          <div className="wizard-section-title">{t('templates.secCiDefaults')}</div>
          <Switch
            checked={ciEnabled}
            onChange={setCiEnabled}
            label={t('templates.fieldCiEnable')}
            hint={t('templates.fieldCiEnableHint')}
          />
          {ciEnabled ? (
            <div className="form-grid-2">
              <Input
                label={t('vmCreate.ciUser')}
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                placeholder="ubuntu"
              />
              <Input
                label={t('templates.fieldNetwork')}
                value="dhcp"
                disabled
                hint={t('templates.fieldNetworkHint')}
              />
            </div>
          ) : null}
          {ciEnabled ? (
            <Textarea
              label={t('vmCreate.ciSshKeys')}
              mono
              rows={3}
              value={sshKey}
              onChange={(e) => setSshKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA... user@host"
              hint={t('templates.fieldSshKeysHint')}
            />
          ) : null}
        </div>
      ) : (
        <div className="wizard-section">
          {/* 转换就是「选一台机器 → 关机 → 转模板」，没有别的参数，所以直接
              复用同一个表单 —— 它自带「会先强制关机、转完无法再启动」的警告。
              这里以前传的是空数组加一个不做事的 onSubmit，用户能看到的只有
              一个选不出东西的下拉。 */}
          <ConvertForm vms={candidates} busy={busy} onSubmit={onConvert} />
        </div>
      )}
    </Modal>
  );
}
