/* ==========================================================================
   ProxCenter — 模板管理
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clusterApi,
  configApi,
  nodesApi,
  storagesApi,
  templatesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge, TagList } from '../components/ui/Badge';
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
import { ostypeLabel } from '../utils/status';
import { OSTYPE_OPTIONS, CPU_TYPE_OPTIONS } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { TemplateItem, VmSummary } from '../api/types';

export function Templates() {
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

  /* 「从现有虚拟机转换为模板」仍需要虚拟机列表，且只在弹窗打开时拉取：
     普通用户在这里只会看到自己名下的虚拟机（这正是期望的范围）。 */
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    enabled: convertOpen,
    staleTime: 30_000,
  });

  const nonTemplates = useMemo(
    () => (vmsQuery.data ?? []).filter((v) => !v.template),
    [vmsQuery.data],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
    void queryClient.invalidateQueries({ queryKey: ['cluster'] });
  };

  return (
    <PageShell
      title={
        <>
          <IconTemplate size={20} />
          模板
        </>
      }
      subtitle={`共 ${templates.length} 个模板 · 用于快速批量部署虚拟机`}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void templatesQuery.refetch()}
            loading={templatesQuery.isFetching && !templatesQuery.isLoading}
          >
            刷新
          </Button>
          {canWrite ? (
            <Button
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={() => setWizardOpen(true)}
            >
              创建模板
            </Button>
          ) : null}
        </>
      }
    >
      {/* ---- 最佳实践说明 ---- */}
      <CollapsibleCard
        title="Cloud-Init 模板最佳实践"
        icon={<IconCloud size={16} />}
      >
        <ul>
          <li>
            <strong>镜像选择</strong>：优先使用官方 Cloud Image（Ubuntu Cloud
            Image、Debian Generic Cloud、Rocky/Alma Cloud），这类镜像自带 cloud-init
            与 virtio 驱动。下载后放到任一 <code>dir</code> 类型存储（如{' '}
            <code>local</code>）的 iso 目录即可。
          </li>
          <li>
            <strong>磁盘总线</strong>：使用 <code>SCSI + virtio-scsi-single</code>{' '}
            控制器，并把磁盘格式设为 <code>qcow2</code>，兼顾性能与快照能力。
          </li>
          <li>
            <strong>机型与固件</strong>：Linux 用 <code>i440fx + SeaBIOS</code>；
            Windows 11 / Server 2022 必须 <code>q35 + OVMF</code>，并添加 EFI 磁盘与
            TPM。
          </li>
          <li>
            <strong>Cloud-Init 驱动</strong>：创建模板时必须挂载 Cloud-Init
            驱动（IDA 总线），否则首次开机无法注入用户与网络配置。
          </li>
          <li>
            <strong>默认用户</strong>：不要依赖镜像默认账号。统一在 Cloud-Init
            中指定 <code>user</code> 与 SSH 公钥，禁用密码登录更安全。
          </li>
          <li>
            <strong>网络</strong>：Cloud-Init 的 <code>ip_configs</code> 推荐使用{' '}
            <code>dhcp</code>；若需静态地址，务必带上 CIDR 前缀（如{' '}
            <code>192.168.1.10/24</code>）与网关。
          </li>
          <li>
            <strong>内存与 Balloon</strong>：模板内存设置不要过小（建议 ≥ 1024
            MB），并保留 balloon 以便克隆后动态调整。
          </li>
          <li>
            <strong>转换前清理</strong>：转模板前执行{' '}
            <code>cloud-init clean</code>、清空 <code>/etc/machine-id</code> 与
            SSH host key，避免克隆体之间身份冲突。
          </li>
          <li>
            <strong>标签规范</strong>：给模板打上 <code>template</code>、
            <code>os:ubuntu</code> 之类的标签，方便克隆时快速筛选。
          </li>
        </ul>
      </CollapsibleCard>

      {/* ---- 工具栏 ---- */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模板名称、VMID、标签…"
            block={false}
            aria-label="搜索模板"
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">共 {templates.length} 个</span>
        </div>
      </div>

      {/* ---- 模板卡片网格 ---- */}
      {templatesQuery.isLoading ? (
        <CardSkeleton count={4} height={200} />
      ) : templatesQuery.isError ? (
        <ErrorState
          title="无法加载模板列表"
          message={errorMessage(templatesQuery.error)}
          onRetry={() => void templatesQuery.refetch()}
        />
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            title={search ? '没有匹配的模板' : '暂无模板'}
            description={
              search ? (
                '尝试调整搜索关键词。'
              ) : (
                <>
                  模板可以让虚拟机部署变得可重复。你既可以从 cloud-init 镜像生成，
                  也可以把现有虚拟机转换而来。
                  {/* 向导能覆盖绝大多数场景，但批量/自动化场景直接给命令更快，
                      省得用户去翻 PVE 文档 */}
                  <span className="empty-cli">
                    命令行等价写法：
                    <code className="mono">
                      qm importdisk &lt;vmid&gt; &lt;镜像&gt; &lt;存储&gt;
                    </code>
                    ，再执行
                    <code className="mono">qm template &lt;vmid&gt;</code>
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
                    从镜像生成模板
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<IconVm size={15} />}
                    onClick={() => setConvertOpen(true)}
                  >
                    从现有 VM 转换
                  </Button>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid grid-auto-320">
          {templates.map((t) => (
            <TemplateCard
              key={`${t.node}/${t.vmid}`}
              template={t}
              canWrite={canWrite}
              onClone={() => setCloneTarget(t)}
              onDelete={() => setDeleteTarget(t)}
              onOpen={() => navigate(`/vms/${t.node}/${t.vmid}`)}
            />
          ))}
        </div>
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
        title="从现有虚拟机转换"
        description="选择一台非模板虚拟机，将其转换为模板"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConvertOpen(false)}>
              取消
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
              await runner.run(vmsApi.toTemplate(vm.node, vm.vmid, vm.connection_id), {
                title: `转换「${vm.name || vm.vmid}」为模板`,
                node: vm.node,
                invalidate: [['vms'], ['cluster']],
              });
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
            await runner.run(
              vmsApi.delete(
                deleteTarget.node,
                deleteTarget.vmid,
                true,
                deleteTarget.connection_id,
              ),
              {
                title: `删除模板「${deleteTarget.name || deleteTarget.vmid}」`,
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
        title="删除模板"
        danger
        confirmText="删除"
        loading={busy}
        requireText={deleteTarget?.name || String(deleteTarget?.vmid ?? '')}
        message={
          <>
            即将删除模板{' '}
            <strong>{deleteTarget?.name || `VM ${deleteTarget?.vmid}`}</strong>
            （VMID {deleteTarget?.vmid}）。已克隆出的虚拟机不受影响，但该模板将无法再用于新建。
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
        <Badge variant="accent" size="sm">
          模板
        </Badge>
      </div>

      <div className="entity-card-stats">
        <div className="entity-stat">
          <span className="entity-stat-label">CPU</span>
          <span className="entity-stat-value">{template.maxcpu ?? '—'} 核</span>
        </div>
        <div className="entity-stat">
          <span className="entity-stat-label">内存</span>
          <span className="entity-stat-value">
            {formatBytes(template.maxmem, 0)}
          </span>
        </div>
        <div className="entity-stat">
          <span className="entity-stat-label">磁盘</span>
          <span className="entity-stat-value">
            {formatBytes(template.maxdisk, 0)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-8 flex-wrap">
        <span className="fs-xs text-muted">OS：{ostypeLabel(template.type)}</span>
        <span className="fs-xs text-muted">·</span>
        <span className="fs-xs text-muted">
          运行 {formatUptimeShort(template.uptime)}
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
            克隆
          </Button>
          <IconButton label="查看详情" onClick={onOpen}>
            <IconEye size={15} />
          </IconButton>
        </div>
        <IconButton
          label={`删除模板 ${template.name}`}
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
   从现有 VM 转换表单
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
  const [selected, setSelected] = useState('');

  const options = [
    { label: '请选择虚拟机', value: '' },
    ...vms.map((v) => ({
      label: `${v.name || `VM ${v.vmid}`} · ${v.vmid} @ ${v.node} (${v.status})`,
      value: `${v.node}:${v.vmid}`,
    })),
  ];

  const target = useMemo(() => {
    if (!selected) return undefined;
    const [node, idStr] = selected.split(':');
    const vmid = Number(idStr);
    return vms.find((v) => v.node === node && v.vmid === vmid);
  }, [selected, vms]);

  return (
    <div className="flex flex-col gap-16">
      <Select
        label="目标虚拟机"
        required
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        options={options}
        hint={
          vms.length === 0
            ? '没有可转换的虚拟机（已排除模板）'
            : '将关机并转换为模板'
        }
      />

      <Notice tone="warning" title="转换影响">
        转换过程中虚拟机会被强制关机。转换完成后该虚拟机无法再直接启动，只能用于克隆。
        若仍需正常运行，请先克隆一份再转换。
      </Notice>

      <Button
        variant="danger"
        onClick={() => target && void onSubmit(target)}
        disabled={!target || busy}
        loading={busy}
        block
      >
        关机并转换为模板
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
  const runner = useTaskRunner();
  const { canWrite } = useAuth();

  const [newId, setNewId] = useState('');
  const [name, setName] = useState('');
  /** 默认链接克隆：以模板磁盘为 backing file，秒级完成且几乎不占空间 */
  const [full, setFull] = useState(false);
  const [targetStorage, setTargetStorage] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

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
      ? 'VMID 需为 100 ~ 999999999 之间的整数'
      : undefined;

  const storageOptions = [
    { label: '继承模板存储', value: '' },
    ...(storagesQuery.data ?? [])
      .filter(
        (s) =>
          s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
      )
      .map((s) => ({
        label: `${s.storage}（可用 ${formatBytes(s.avail)}）`,
        value: s.storage,
      })),
  ];

  const submit = async () => {
    if (!template || !newId || idError || !canWrite) return;
    setBusy(true);
    try {
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
            description: description || undefined,
            /* 与旧行为保持一致：克隆完不自动开机 */
            start: false,
          },
          template.connection_id,
        ),
        {
          title: `从模板克隆（VMID ${idNum}）`,
          node: template.node,
          invalidate: [['vms'], ['templates'], ['cluster'], ['storages']],
        },
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(template)}
      onClose={onClose}
      title="从模板克隆虚拟机"
      description={
        template
          ? `模板：${template.name || `VM ${template.vmid}`}（${
              template.connection_name ? `${template.connection_name} · ` : ''
            }${template.node}）`
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
      <div className="form-grid-2">
        <Input
          label="新 VMID"
          required
          value={newId}
          onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))}
          error={idError}
          hint={
            nextIdQuery.data
              ? `建议 ID：${nextIdQuery.data.vmid}`
              : '需为唯一整数'
          }
        />
        <Input
          label="新名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="克隆后的虚拟机名称"
        />
        <Select
          label="目标节点（可选）"
          value={targetNode}
          onChange={(e) => setTargetNode(e.target.value)}
          options={[
            { label: '与模板同节点', value: '' },
            ...(nodesQuery.data ?? []).map((n) => ({
              label: n.node,
              value: n.node,
            })),
          ]}
        />
        <Select
          label="目标存储（可选）"
          value={targetStorage}
          onChange={(e) => setTargetStorage(e.target.value)}
          options={storageOptions}
          hint="完整克隆必须指定或继承可用存储"
        />
      </div>

      <div className="mt-16">
        <Checkbox
          checked={full}
          onChange={(e) => setFull(e.target.checked)}
          label="完整克隆（复制全部磁盘数据，独立运行）"
        />
        <div className="field-message">
          默认不勾选，即<b>链接克隆</b>：几秒完成、几乎不额外占用空间，但依赖模板磁盘。
        </div>
      </div>

      <div className="mt-16">
        <Textarea
          label="描述"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="记录该虚拟机用途"
        />
        <div className="field-message">
          {vmDefaultsQuery.data?.dns ? (
            <>
              DNS 将写入面板默认值 <span className="mono">{vmDefaultsQuery.data.dns}</span>
              （可在「设置 → 虚拟机创建默认值」修改，清空该设置则改为继承 DHCP / RA）。
            </>
          ) : (
            <>DNS 未在面板配置默认值，将继承模板 / DHCP / RA 下发的设置。</>
          )}
        </div>
      </div>

      {!full ? (
        <div className="mt-16">
          <Notice tone="warning" title="链接克隆">
            以模板磁盘为 backing file 增量生成，秒级完成；但模板一旦被删除或磁盘链被合并，
            克隆体将无法使用。需要完全独立的副本时，请勾选上方「完整克隆」。
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
      { label: '请选择存储池', value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) =>
            s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'images'),
        )
        .map((s) => ({
          label: `${s.storage}（可用 ${formatBytes(s.avail)}）`,
          value: s.storage,
        })),
    ],
    [storagesQuery.data],
  );

  const bridgeOptions = useMemo(() => {
    const ifaces = bridgesQuery.data ?? [];
    const bridges = ifaces.filter(
      (i) => i.type === 'bridge' || i.type === 'OVSBridge',
    );
    const list = bridges.length > 0 ? bridges : ifaces;
    return [
      { label: '请选择网桥', value: '' },
      ...list.map((i) => ({ label: i.iface, value: i.iface })),
    ];
  }, [bridgesQuery.data]);

  const idNum = Number(vmid);
  const idError =
    vmid && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? 'VMID 需为 100 ~ 999999999 之间的整数'
      : undefined;

  const canSubmit =
    canWrite &&
    Boolean(node) &&
    Boolean(name.trim()) &&
    !idError &&
    Boolean(vmid) &&
    Boolean(diskStorage) &&
    memory >= 512 &&
    cores >= 1;

  /* ---- 提交（模式 A） ---- */
  const submitImage = async () => {
    if (!canSubmit) {
      toast.warning('请完善表单', '有必填项未填写或格式不正确');
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
        description: '由 ProxCenter 从 cloud-init 镜像生成的模板',
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
        '模板创建已提交',
        `VMID ${res.vmid ?? vmid} 将依次执行：创建 VM → 导入镜像 → 配置 cloud-init → 转模板`,
      );
      onCreated();
      onClose();
    } catch (err) {
      toast.error('创建模板失败', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建模板"
      description="从 cloud-init 镜像生成，或把现有虚拟机转换而来"
      size="lg"
      footer={
        mode === 'image' ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={submitImage}
              loading={submitting}
              disabled={!canSubmit}
            >
              创建模板
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      {/* 模式切换 */}
      <div className="mb-24">
        <SegmentedControl<CreateMode>
          value={mode}
          onChange={setMode}
          ariaLabel="创建模板方式"
          options={[
            {
              label: (
                <span className="flex items-center gap-6">
                  <IconCloud size={14} />
                  从 cloud-init 镜像生成
                </span>
              ),
              value: 'image',
            },
            {
              label: (
                <span className="flex items-center gap-6">
                  <IconVm size={14} />
                  从现有 VM 转换
                </span>
              ),
              value: 'convert',
            },
          ]}
        />
      </div>

      {mode === 'image' ? (
        <div className="wizard-section">
          <Notice tone="info" title="生成的流水线">
            提交后后端将依次执行：创建虚拟机 → <code>importdisk</code> 导入镜像 →
            配置 cloud-init 驱动 → 转换为模板。整个过程可在「任务队列」查看。
          </Notice>

          <div className="form-grid">
            <Input
              label="名称"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 tmpl-ubuntu-2404"
            />
            <Input
              label="VMID"
              required
              value={vmid}
              onChange={(e) => setVmid(e.target.value.replace(/\D/g, ''))}
              error={idError}
              hint={
                nextIdQuery.data ? `建议 ID：${nextIdQuery.data.vmid}` : undefined
              }
            />
            <Select
              label="节点"
              required
              value={node}
              onChange={(e) => setNode(e.target.value)}
              options={[
                { label: '请选择节点', value: '' },
                ...(nodesQuery.data ?? []).map((n) => ({
                  label: `${n.node}${n.status !== 'online' ? '（离线）' : ''}`,
                  value: n.node,
                })),
              ]}
            />
            <Input
              label="标签"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="template;os:ubuntu"
            />
          </div>

          <div className="wizard-section-title">源镜像</div>
          <Select
            label="cloud-init 镜像文件"
            value={imageVolId}
            onChange={(e) => setImageVolId(e.target.value)}
            options={[
              { label: '不指定（仅创建空模板）', value: '' },
              ...(imagesQuery.data ?? []).map(({ storage, item }) => ({
                label: `${item.volid}（${formatBytes(item.size)}, ${storage}）`,
                value: item.volid,
              })),
            ]}
            hint={
              imagesQuery.isLoading
                ? '正在扫描镜像文件…'
                : (imagesQuery.data ?? []).length === 0
                  ? '未找到 .img / .qcow2 镜像。请先到「存储」页上传，或用 wget 下载到节点的 iso 目录。'
                  : '列表来自节点各存储的 ISO 目录，已筛选 img/qcow2/raw 文件'
            }
          />

          <div className="wizard-section-title">规格</div>
          <div className="form-grid">
            <Select
              label="操作系统类型"
              value={ostype}
              onChange={(e) => setOstype(e.target.value)}
              options={OSTYPE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
            <Select
              label="CPU 类型"
              value={cpuType}
              onChange={(e) => setCpuType(e.target.value)}
              options={CPU_TYPE_OPTIONS.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
            <Input
              label="核心数"
              type="number"
              min={1}
              max={128}
              value={cores}
              onChange={(e) => setCores(Number(e.target.value) || 0)}
            />
            <Input
              label="内存（MB）"
              type="number"
              min={512}
              step={512}
              value={memory}
              onChange={(e) => setMemory(Number(e.target.value) || 0)}
              hint={`约 ${formatBytes(memory * 1024 ** 2)}`}
            />
            <Select
              label="磁盘存储池"
              required
              value={diskStorage}
              onChange={(e) => setDiskStorage(e.target.value)}
              options={diskStorageOptions}
            />
            <Input
              label="磁盘大小（GB）"
              type="number"
              min={1}
              value={diskSize}
              onChange={(e) => setDiskSize(Number(e.target.value) || 0)}
            />
            <Select
              label="网桥"
              required
              value={bridge}
              onChange={(e) => setBridge(e.target.value)}
              options={bridgeOptions.length > 1 ? bridgeOptions : [{ label: 'vmbr0', value: 'vmbr0' }, ...bridgeOptions.filter((o) => o.value !== 'vmbr0')]}
              hint={
                bridgesQuery.isError
                  ? '无法读取网卡列表，可手动填写网桥名'
                  : undefined
              }
            />
          </div>

          <div className="wizard-section-title">Cloud-Init 默认配置</div>
          <Switch
            checked={ciEnabled}
            onChange={setCiEnabled}
            label="启用 Cloud-Init"
            hint="在模板中预置默认用户与 SSH 密钥"
          />
          {ciEnabled ? (
            <div className="form-grid-2">
              <Input
                label="默认用户名"
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                placeholder="ubuntu"
              />
              <Input
                label="网络"
                value="dhcp"
                disabled
                hint="模板中固定为 DHCP，克隆后可在详情页改为静态"
              />
            </div>
          ) : null}
          {ciEnabled ? (
            <Textarea
              label="SSH 公钥"
              mono
              rows={3}
              value={sshKey}
              onChange={(e) => setSshKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA... user@host"
              hint="每行一个公钥；克隆出的虚拟机将自动注入这些密钥"
            />
          ) : null}
        </div>
      ) : (
        <div className="wizard-section">
          <Notice tone="info" title="切换到「从现有 VM 转换」">
            请关闭本窗口后，在主页面点击「创建模板」旁的入口，或在空状态中选择「从现有 VM
            转换」。
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
