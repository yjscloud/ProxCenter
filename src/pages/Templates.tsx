/* ==========================================================================
   ProxCenter — 模板管理
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clusterApi,
  configApi,
  lxcApi,
  nodesApi,
  storagesApi,
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
import { CollapsibleCard, EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import {
  IconTemplate,
  IconCopy,
  IconTrash,
  IconEye,
  IconPlus,
  IconRefresh,
  IconCloud,
  IconVm,
} from '../components/Icons';
import { formatBytes, formatUptimeShort, parseTags } from '../utils/format';
import { ostypeLabel } from '../utils/status'
import { useT } from '../i18n';
import { ostypeOptions, cpuTypeOptions } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { TemplateItem, VmSummary } from '../api/types';

/** 模板类型标签页：虚拟机模板与容器模板分开看，混在一屏里不好区分 */
type TemplateTab = 'qemu' | 'lxc';

/** 展示方式（与节点页保持一致的叫法） */
type ViewMode = 'cards' | 'list';

export function Templates() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const { canWrite } = useAuth();

  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<TemplateItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateItem | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TemplateTab>('qemu');
  const [view, setView] = useState<ViewMode>('cards');

  /* 模板列表走专用接口 /api/templates：模板是共享资源，普通用户也必须能看到
     并用于部署。原先前端是用 /api/vms 自己筛 template，而该接口对普通用户按
     归属过滤，模板都归属管理员 → 普通用户看到的是空列表。 */
  const templatesQuery = useQuery({
    queryKey: ['templates', 'all'],
    queryFn: () => templatesApi.list(),
    refetchInterval: 20_000,
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
  const ctTemplates = useMemo(
    () => templates.filter((t) => t.guest_type === 'lxc'),
    [templates],
  );
  const shown = tab === 'lxc' ? ctTemplates : vmTemplates;

  /* 「从现有虚拟机转换为模板」仍需要虚拟机列表，且只在弹窗打开时拉取：
     普通用户在这里只会看到自己名下的虚拟机（这正是期望的范围）。 */
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    enabled: convertOpen,
    staleTime: 30_000,
  });

  /* 容器同样能转模板（PVE 的 pct template），所以候选里也要有容器 */
  const lxcQuery = useQuery({
    queryKey: ['lxc', 'all'],
    queryFn: () => lxcApi.list(),
    enabled: convertOpen,
    staleTime: 30_000,
  });

  /* 转换候选 = 非模板的虚拟机 + 非模板的容器 */
  const nonTemplates = useMemo(
    () =>
      [...(vmsQuery.data ?? []), ...(lxcQuery.data ?? [])].filter(
        (v) => !v.template,
      ),
    [vmsQuery.data, lxcQuery.data],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
    void queryClient.invalidateQueries({ queryKey: ['lxc'] });
    void queryClient.invalidateQueries({ queryKey: ['templates'] });
    void queryClient.invalidateQueries({ queryKey: ['cluster'] });
  };

  /* 列表视图：与卡片同信息量，操作列锁在最后（顺序不能让用户拖走） */
  const templateColumns = useMemo<Array<Column<TemplateItem>>>(
    () => [
      {
        key: 'name',
        header: t('templates.colName'),
        width: 200,
        render: (tpl) => (
          <span className="fw-600" title={tpl.name}>
            {tpl.name || `${tab === 'lxc' ? 'CT' : 'VM'} ${tpl.vmid}`}
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
              disabled={!canWrite}
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
              disabled={!canWrite}
            >
              <IconTrash size={15} />
            </IconButton>
          </span>
        ),
      },
    ],
    [canWrite, navigate, tab, t],
  );

  return (
    <PageShell
      title={
        <>
          <IconTemplate size={20} />
          {t('templates.title')}
        </>
      }
      subtitle={t('templates.subtitle', {
        total: templates.length,
        vm: vmTemplates.length,
        ct: ctTemplates.length,
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
          {canWrite ? (
            <Button
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={() => setWizardOpen(true)}
            >
              {t('templates.create')}
            </Button>
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
            value={tab}
            onChange={setTab}
            ariaLabel={t('templates.tabTypeAria')}
            options={[
              {
                label: t('templates.tabVm', { count: vmTemplates.length }),
                value: 'qemu',
              },
              {
                label: t('templates.tabCt', { count: ctTemplates.length }),
                value: 'lxc',
              },
            ]}
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
      ) : templatesQuery.isError ? (
        <ErrorState
          title={t('templates.loadFailed')}
          message={errorMessage(templatesQuery.error)}
          onRetry={() => void templatesQuery.refetch()}
        />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            title={
              search
                ? t('templates.emptySearch')
                : tab === 'lxc'
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
              canWrite && !search ? (
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
      ) : view === 'cards' ? (
        <div className="grid grid-auto-320">
          {shown.map((t) => (
            <TemplateCard
              key={`${t.connection_id}/${t.node}/${t.vmid}`}
              template={t}
              canWrite={canWrite}
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
            kind: tab === 'lxc' ? t('templates.kindCt') : t('templates.kindVm'),
          })}
        />
      )}

      {/* ---- 创建模板向导 ---- */}
      <TemplateCreateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={invalidate}
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
          onSubmit={async (vm) => {
            setBusy(true);
            try {
              await runner.run(
                /* 容器走 /lxc 那条（PVE 的 pct template），虚拟机走 /vms 那条 */
                vm.type === 'lxc'
                  ? lxcApi.toTemplate(vm.node, vm.vmid, vm.connection_id)
                  : vmsApi.toTemplate(vm.node, vm.vmid, vm.connection_id),
                {
                  title: t('templates.convertTask', {
                    name: vm.name || vm.vmid,
                  }),
                  node: vm.node,
                  invalidate: [['vms'], ['lxc'], ['templates'], ['cluster']],
                },
              );
              setConvertOpen(false);
              invalidate();
            } finally {
              setBusy(false);
            }
          }}
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

function TemplateCard({
  template,
  canWrite,
  onClone,
  onDelete,
  onOpen,
}: {
  template: TemplateItem;
  canWrite: boolean;
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
            disabled={!canWrite}
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
          disabled={!canWrite}
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
  const { canWrite } = useAuth();

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

  /* 存储 / 节点都取自模板所在的那台 PVE，否则多主机场景下会列出别家的存储 */
  const storagesQuery = useQuery({
    queryKey: ['storages', template?.connection_id ?? '', targetNode || template?.node || 'all'],
    queryFn: () =>
      storagesApi.list(
        targetNode || template?.node || undefined,
        template?.connection_id,
      ),
    enabled: Boolean(template),
    staleTime: 60_000,
  });

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
    if (!template || !newId || idError || !canWrite) return;
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
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { canWrite } = useAuth();

  const [mode, setMode] = useState<CreateMode>('image');

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

  const nextIdQuery = useQuery({
    queryKey: ['cluster', 'nextid'],
    queryFn: clusterApi.nextId,
    enabled: open,
    retry: false,
    staleTime: 0,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', node || 'all'],
    queryFn: () => storagesApi.list(node || undefined),
    enabled: open,
    staleTime: 60_000,
  });

  /* 镜像文件（.img / .qcow2 / .raw） */
  const imagesQuery = useQuery({
    queryKey: ['storages', 'content', 'images', node],
    queryFn: async () => {
      const list = (storagesQuery.data ?? []).filter((s) => s.active);
      const results = await Promise.all(
        list.map((s) =>
          storagesApi
            .content({ node, storage: s.storage, content: 'iso' })
            .then((items) =>
              items
                .filter((it) =>
                  /\.(img|qcow2|raw)$/i.test(it.volid) ||
                  /\.(img|qcow2|raw)$/i.test(it.format ?? ''),
                )
                .map((it) => ({ storage: s.storage, item: it })),
            )
            .catch(() => []),
        ),
      );
      return results.flat();
    },
    enabled: open && Boolean(node) && (storagesQuery.data?.length ?? 0) > 0,
    retry: false,
  });

  const bridgesQuery = useQuery({
    queryKey: ['nodes', node, 'network'],
    queryFn: () => nodesApi.network(node),
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
    canWrite &&
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
      const res = await vmsApi.create({
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
      });

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
              ...(imagesQuery.data ?? []).map(({ storage, item }) => ({
                label: `${item.volid}（${formatBytes(item.size)}, ${storage}）`,
                value: item.volid,
              })),
            ]}
            hint={
              imagesQuery.isLoading
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
          <Notice tone="info" title={t('templates.switchModeTitle')}>
            {t('templates.switchModeBody')}
          </Notice>
          <ConvertForm
            vms={[]}
            busy={false}
            onSubmit={() => {
              /* 由主页面处理 */
            }}
          />
        </div>
      )}
    </Modal>
  );
}
