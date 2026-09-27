/* ==========================================================================
   ProxCenter — 备份
   三个 Tab：备份文件 / 备份计划 / 立即备份
   ========================================================================== */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backupsApi, nodesApi, storagesApi, vmsApi } from '../api/endpoints';
import type { BackupStats } from '../api/types';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select, Switch, Textarea, Field } from '../components/ui/Input';
import { Table, Pagination, type Column } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { ErrorState, Notice, CollapsibleCard } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  IconBackup,
  IconRefresh,
  IconPlus,
  IconSearch,
  IconTrash,
  IconDownload,
  IconClock,
  IconCheck,
  IconShield,
  IconCopy,
  IconActivity,
  IconUpload,
} from '../components/Icons';
import { formatBytes, formatDateTime, formatRelative } from '../utils/format';
import { BACKUP_MODE_OPTIONS, COMPRESS_OPTIONS } from '../utils/status';
import { useTaskRunner, type TaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  BackupItem,
  BackupJob,
  BackupJobInput,
  BackupMode,
  BackupRestoreRequest,
} from '../api/types';

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

type TabKey = 'files' | 'jobs' | 'create';

export function Backups() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { canWrite, isAdmin } = useAuth();

  const tab = (params.get('tab') as TabKey | null) ?? 'files';

  const setTab = (next: TabKey) => {
    const p = new URLSearchParams(params);
    if (next === 'files') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const tabs: Array<{ key: TabKey; label: string; icon: ReactNode }> = [
    { key: 'files', label: '备份文件', icon: <IconBackup size={15} /> },
    { key: 'jobs', label: '备份计划', icon: <IconClock size={15} /> },
    { key: 'create', label: '立即备份', icon: <IconPlus size={15} /> },
  ];

  return (
    <PageShell
      title={
        <>
          <IconBackup size={20} />
          备份
        </>
      }
      subtitle="浏览备份文件、管理定时备份计划、即时创建备份"
      actions={
        <Button
          variant="secondary"
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['backups'] });
          }}
        >
          刷新
        </Button>
      }
    >
      <div className="tabs" role="tablist" aria-label="备份视图切换">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'files' ? (
        <BackupFilesTab canWrite={canWrite} onGoCreate={() => setTab('create')} />
      ) : tab === 'jobs' ? (
        <BackupJobsTab canWrite={canWrite} isAdmin={isAdmin} />
      ) : (
        <BackupCreateTab canWrite={canWrite} />
      )}
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   Tab：立即备份
   --------------------------------------------------------------------------- */

function BackupCreateTab({ canWrite }: { canWrite: boolean }) {
  const runner = useTaskRunner();

  const [node, setNode] = useState('');
  const [vmid, setVmid] = useState('');
  const [all, setAll] = useState(false);
  const [storage, setStorage] = useState('');
  const [mode, setMode] = useState<BackupMode>('snapshot');
  const [compress, setCompress] = useState('zstd');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    staleTime: 30_000,
  });

  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    staleTime: 30_000,
  });

  /* 默认选中第一个节点 */
  useEffect(() => {
    if (!node && nodesQuery.data && nodesQuery.data.length > 0) {
      setNode(nodesQuery.data[0].node);
    }
  }, [node, nodesQuery.data]);

  const storagesQuery = useQuery({
    queryKey: ['storages', node],
    queryFn: () => storagesApi.list(node || undefined),
    enabled: Boolean(node),
    staleTime: 30_000,
  });

  /* 只保留启用了 backup 内容的存储 */
  const backupStorages = useMemo(
    () =>
      (storagesQuery.data ?? []).filter((s) =>
        (s.content ?? '').split(',').includes('backup'),
      ),
    [storagesQuery.data],
  );

  useEffect(() => {
    if (!storage && backupStorages.length > 0) {
      setStorage(backupStorages[0].storage);
    }
  }, [storage, backupStorages]);

  const nodeVms = useMemo(
    () =>
      (vmsQuery.data ?? [])
        .filter((v) => !v.template && v.node === node)
        .sort((a, b) => a.vmid - b.vmid),
    [vmsQuery.data, node],
  );

  const storageOptions = useMemo(
    () => backupStorages.map((s) => ({ label: s.storage, value: s.storage })),
    [backupStorages],
  );

  const nodeOptions = useMemo(
    () => (nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
    [nodesQuery.data],
  );

  const canSubmit =
    canWrite && Boolean(node) && Boolean(storage) && (all || Boolean(vmid)) && !busy;

  const submit = async () => {
    setBusy(true);
    try {
      await runner.run(
        backupsApi.create({
          node,
          vmid: all ? undefined : Number(vmid),
          storage,
          mode,
          compress,
          notes: notes.trim() || undefined,
          all: all || undefined,
        }),
        {
          title: all ? `备份节点 ${node} 上全部虚拟机` : `备份虚拟机 ${vmid}`,
          node,
          invalidate: [['backups', 'list'], ['tasks']],
        },
      );
    } catch {
      /* 错误已由 runner 提示 */
    } finally {
      setBusy(false);
    }
  };

  if (!canWrite) {
    return (
      <Notice tone="info" title="只读模式">
        当前角色没有创建备份的权限，请联系管理员。
      </Notice>
    );
  }

  return (
    <div className="grid grid-2">
      <Card>
        <CardHeader
          title="新建备份"
          subtitle="备份通过 Proxmox vzdump 执行，任务期间可在「任务队列」跟踪进度"
          icon={<IconBackup size={17} />}
        />

        <div className="dyn-list">
          <Field label="目标节点" required>
            <Select
              value={node}
              onChange={(e) => {
                setNode(e.target.value);
                setVmid('');
                setStorage('');
              }}
              options={nodeOptions}
              placeholder={nodeOptions.length === 0 ? '加载中…' : '请选择节点'}
            />
          </Field>

          <Field label="备份内容" required>
            <div className="radio-group" role="radiogroup" aria-label="备份内容">
              <label className="radio-field">
                <input
                  type="radio"
                  name="backup-scope"
                  className="radio-input"
                  checked={!all}
                  onChange={() => setAll(false)}
                />
                <span className="radio-dot" aria-hidden="true" />
                <span className="radio-content">
                  <span className="radio-label">指定虚拟机</span>
                  <span className="radio-hint">只备份选中的单台虚拟机</span>
                </span>
              </label>
              <label className="radio-field">
                <input
                  type="radio"
                  name="backup-scope"
                  className="radio-input"
                  checked={all}
                  onChange={() => {
                    setAll(true);
                    setVmid('');
                  }}
                />
                <span className="radio-dot" aria-hidden="true" />
                <span className="radio-content">
                  <span className="radio-label">该节点全部虚拟机</span>
                  <span className="radio-hint">
                    当前节点共 {nodeVms.length} 台非模板虚拟机
                  </span>
                </span>
              </label>
            </div>
          </Field>

          {!all ? (
            <Field
              label="虚拟机"
              required
              hint={nodeVms.length === 0 ? '当前节点没有可备份的虚拟机' : undefined}
            >
              <Select
                value={vmid}
                onChange={(e) => setVmid(e.target.value)}
                placeholder="请选择虚拟机"
                options={nodeVms.map((v) => ({
                  label: `${v.vmid} — ${v.name || '未命名'}`,
                  value: String(v.vmid),
                }))}
              />
            </Field>
          ) : null}

          <Field
            label="备份存储"
            required
            hint={
              backupStorages.length === 0
                ? '该节点上没有启用 backup 内容的存储'
                : '仅列出启用了 backup 内容的存储'
            }
          >
            <Select
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              options={storageOptions}
              placeholder="请选择存储"
            />
          </Field>

          <Field label="备份模式" required>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as BackupMode)}
              options={BACKUP_MODE_OPTIONS.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label="压缩算法" required>
            <Select
              value={compress}
              onChange={(e) => setCompress(e.target.value)}
              options={COMPRESS_OPTIONS.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label="备注" hint="会写入备份的 notes 字段">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="例如：升级内核前的完整备份"
            />
          </Field>
        </div>

        <div className="flex items-center gap-8 mt-16">
          <Button
            variant="primary"
            icon={<IconBackup size={15} />}
            onClick={() => void submit()}
            loading={busy}
            disabled={!canSubmit}
          >
            开始备份
          </Button>
        </div>
      </Card>

      <div className="flex flex-col gap-16">
        <Card>
          <CardHeader title="备份模式说明" icon={<IconShield size={17} />} />
          <div className="desc-list">
            <div className="desc-item">
              <div className="desc-label">Snapshot</div>
              <div className="desc-value">
                借助存储快照能力，在虚拟机持续运行的情况下完成备份。对业务零中断，
                但要求底层存储支持快照（ZFS、LVM-thin、Ceph、NFS 等）。推荐日常使用。
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">Suspend</div>
              <div className="desc-value">
                备份开始时短暂挂起虚拟机，备份完成后自动恢复运行。适用于存储不支持
                快照、但业务可以容忍短时暂停的场景。
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">Stop</div>
              <div className="desc-value">
                先关闭虚拟机再备份，备份完成后保持关闭状态，不会自动启动。
                一致性最好，但会造成服务中断，适合离线维护窗口。
              </div>
            </div>
          </div>
        </Card>

        <CollapsibleCard title="压缩算法怎么选？" icon={<IconShield size={15} />}>
          <div className="desc-list">
            <div className="desc-item">
              <div className="desc-label">ZSTD</div>
              <div className="desc-value">
                默认推荐。压缩率与速度平衡最好，多线程压缩，对 CPU 影响可控。
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">LZO</div>
              <div className="desc-value">
                压缩/解压速度最快，压缩率低于 ZSTD。CPU 性能紧张时可选。
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">GZIP</div>
              <div className="desc-value">
                压缩率最高但 CPU 开销大、速度慢，仅在磁盘空间极度紧张时使用。
              </div>
            </div>
          </div>
        </CollapsibleCard>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tab：备份文件
   --------------------------------------------------------------------------- */

function BackupFilesTab({
  canWrite,
  onGoCreate,
}: {
  canWrite: boolean;
  /** 跳到「立即备份」标签页：空列表时最需要的下一步 */
  onGoCreate: () => void;
}) {
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  const [node, setNode] = useState('');
  const [storage, setStorage] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    staleTime: 30_000,
  });

  const listQuery = useQuery({
    queryKey: ['backups', 'list', node, storage],
    queryFn: () =>
      backupsApi.list({
        node: node || undefined,
        storage: storage || undefined,
      }),
    staleTime: 20_000,
  });

  /* 备份失败最怕「事前不知道」：把最近的成功率摆在页面上，
     和归档列表放在一起，跑没跑、成没成一目了然 */
  const statsQuery = useQuery({
    queryKey: ['backups', 'stats'],
    queryFn: () => backupsApi.stats(),
    staleTime: 60_000,
    retry: false,
  });
  const backupStats: BackupStats | undefined = statsQuery.data;

  const nodeOptions = useMemo(
    () => [
      { label: '全部节点', value: '' },
      ...(nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
    ],
    [nodesQuery.data],
  );

  /* 从已加载数据中提取存储名，避免额外请求 */
  const storageOptions = useMemo(() => {
    const set = new Set(
      (listQuery.data ?? [])
        .map((b) => b.storage)
        .filter((s): s is string => Boolean(s)),
    );
    return [
      { label: '全部存储', value: '' },
      ...[...set].sort().map((s) => ({ label: s, value: s })),
    ];
  }, [listQuery.data]);

  const items = useMemo(() => {
    const list = listQuery.data ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (b) =>
            b.volid.toLowerCase().includes(q) ||
            String(b.vmid).includes(q) ||
            (b.notes ?? '').toLowerCase().includes(q),
        )
      : list;
    return [...filtered].sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
  }, [listQuery.data, search]);

  useEffect(() => {
    setPage(1);
  }, [search, node, storage]);

  const paged = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page],
  );

  const stats = useMemo(() => {
    const list = listQuery.data ?? [];
    const totalSize = list.reduce((acc, b) => acc + (b.size ?? 0), 0);
    const vms = new Set(list.map((b) => b.vmid)).size;
    return { count: list.length, totalSize, vms };
  }, [listQuery.data]);

  /* 下载：新标签页会自动带上 HttpOnly Cookie，不再把令牌拼进 URL */
  const download = (item: BackupItem) => {
    window.open(backupsApi.downloadUrl(item.volid), '_blank');
  };

  const copyVolid = async (volid: string) => {
    try {
      await navigator.clipboard.writeText(volid);
      toast.success('已复制卷标识');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  const columns: Array<Column<BackupItem>> = [
    {
      key: 'vmid',
      header: '虚拟机',
      width: 110,
      render: (b) => (
        <div className="vm-name-cell">
          <span className="fw-500">VM {b.vmid}</span>
          <span className="fs-xs text-muted mono">{b.node ?? '—'}</span>
        </div>
      ),
      sortable: true,
      sortValue: (b) => b.vmid,
    },
    {
      key: 'volid',
      header: '卷标识',
      render: (b) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm truncate" title={b.volid}>
            {b.volid}
          </span>
          <span className="fs-xs text-muted truncate">
            {b.format || '未知格式'}
            {b.notes ? ` · ${b.notes}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'ctime',
      header: '创建时间',
      width: 180,
      render: (b) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{formatDateTime(b.ctime)}</span>
          <span className="fs-xs text-muted">{formatRelative(b.ctime)}</span>
        </div>
      ),
      sortable: true,
      sortValue: (b) => b.ctime ?? 0,
    },
    {
      key: 'size',
      header: '大小',
      width: 110,
      align: 'right',
      render: (b) => <span className="mono fs-sm">{formatBytes(b.size)}</span>,
      sortable: true,
      sortValue: (b) => b.size ?? 0,
    },
    {
      key: 'owner',
      header: '创建者',
      width: 90,
      render: (b) => (
        <span className="fs-sm text-secondary">{b.owner || '—'}</span>
      ),
      sortable: true,
      sortValue: (b) => b.owner ?? '',
    },
    {
      key: 'actions',
      header: '操作',
      width: 170,
      align: 'right',
      render: (b) => (
        <span className="row-actions">
          <IconButton
            label={`恢复备份 ${b.volid}`}
            variant="primary"
            disabled={!canWrite}
            onClick={(e) => {
              e.stopPropagation();
              setRestoreTarget(b);
            }}
          >
            <IconUpload size={15} />
          </IconButton>
          <IconButton
            label={`下载备份 ${b.volid}`}
            onClick={(e) => {
              e.stopPropagation();
              download(b);
            }}
          >
            <IconDownload size={15} />
          </IconButton>
          <IconButton
            label="复制卷标识"
            onClick={(e) => {
              e.stopPropagation();
              void copyVolid(b.volid);
            }}
          >
            <IconCopy size={15} />
          </IconButton>
          <IconButton
            label={`删除备份 ${b.volid}`}
            variant="danger"
            disabled={!canWrite}
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(b);
            }}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  if (listQuery.isError && isNotImplemented(listQuery.error)) {
    return (
      <ErrorState
        notImplemented
        title="备份列表接口尚未实现"
        message="后端 /backups 返回未实现。前端已完成对接，待后端提供数据后自动生效。"
        onRetry={() => void listQuery.refetch()}
      />
    );
  }

  return (
    <>
      <div className="grid grid-4">
        <KpiCard
          label="备份文件"
          value={stats.count}
          icon={<IconBackup size={18} />}
          tone="accent"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label="占用空间"
          value={formatBytes(stats.totalSize)}
          icon={<IconShield size={18} />}
          tone="neutral"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label="覆盖虚拟机"
          value={stats.vms}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label="近期成功率"
          value={
            backupStats?.success_rate === null ||
            backupStats?.success_rate === undefined
              ? '—'
              : `${backupStats.success_rate}%`
          }
          hint={
            backupStats
              ? `近 ${backupStats.days} 天 ${backupStats.ok} 成功 / ${backupStats.failed} 失败`
              : undefined
          }
          icon={<IconActivity size={18} />}
          tone={
            backupStats?.failed ? 'danger' : backupStats?.success_rate === 100 ? 'success' : 'neutral'
          }
          loading={statsQuery.isLoading}
        />
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索卷标识、VMID、备注…"
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label="搜索备份"
          />
          <Select
            value={node}
            onChange={(e) => {
              setNode(e.target.value);
              setStorage('');
            }}
            options={nodeOptions}
            aria-label="按节点筛选"
          />
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
            aria-label="按存储筛选"
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">共 {items.length} 个备份</span>
          <Button
            variant="secondary"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => void listQuery.refetch()}
            loading={listQuery.isFetching && !listQuery.isLoading}
          >
            刷新
          </Button>
        </div>
      </div>

      {listQuery.isError && !isNotImplemented(listQuery.error) ? (
        <ErrorState
          title="无法加载备份列表"
          message={errorMessage(listQuery.error)}
          onRetry={() => void listQuery.refetch()}
        />
      ) : (
        <>
          <Table<BackupItem>
            columns={columns}
            rows={paged}
            rowKey={(b) => b.volid}
            loading={listQuery.isLoading}
            caption="备份文件列表"
            emptyTitle={search ? '没有匹配的备份' : '暂无备份文件'}
            emptyDescription={
              search
                ? '尝试调整搜索关键词或筛选条件。'
                : '这个范围内还没有备份文件。可以现在给某台机器做一次备份，或者建一个定时备份计划让它自动跑。'
            }
            emptyAction={
              canWrite && !search ? (
                <Button
                  variant="primary"
                  icon={<IconPlus size={15} />}
                  onClick={onGoCreate}
                >
                  立即创建备份
                </Button>
              ) : undefined
            }
            rowTitle={(b) => b.volid}
          />
          <Pagination
            page={page}
            pageSize={pageSize}
            total={items.length}
            onChange={setPage}
          />
        </>
      )}

      {/* ---- 恢复 ---- */}
      <RestoreDialog
        item={restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onDone={() => {
          setRestoreTarget(null);
          void queryClient.invalidateQueries({ queryKey: ['backups'] });
          void queryClient.invalidateQueries({ queryKey: ['vms'] });
        }}
        runner={runner}
      />

      {/* ---- 删除 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          const nodeName = deleteTarget.node ?? node;
          const storageName = deleteTarget.storage ?? storage;
          if (!nodeName || !storageName) {
            toast.error('删除失败', '缺少节点或存储信息');
            return;
          }
          setBusy(true);
          try {
            // 走备份专用接口（vm.backup + 归属校验）。不能用 storages 的
            // 通用卷删除：那条路要求 storage.manage，普通用户角色会被 403。
            await runner.run(
              backupsApi.remove({
                node: nodeName,
                storage: storageName,
                volid: deleteTarget.volid,
              }),
              {
                title: `删除备份 ${deleteTarget.volid}`,
                node: nodeName,
                invalidate: [['backups', 'list']],
                destructive: true,
              },
            );
            setDeleteTarget(null);
          } catch {
            /* 已提示 */
          } finally {
            setBusy(false);
          }
        }}
        title="删除备份文件"
        danger
        confirmText="删除"
        loading={busy}
        requireText={deleteTarget?.volid}
        message={
          <>
            即将永久删除备份{' '}
            <strong className="mono">{deleteTarget?.volid}</strong>（
            {formatBytes(deleteTarget?.size)}）。删除后无法用于恢复。
          </>
        }
      />
    </>
  );
}

/* ---------------------------------------------------------------------------
   Tab：备份计划
   --------------------------------------------------------------------------- */

function BackupJobsTab({
  canWrite,
  isAdmin,
}: {
  canWrite: boolean;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BackupJob | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupJob | null>(null);
  const [busy, setBusy] = useState(false);

  const jobsQuery = useQuery({
    queryKey: ['backups', 'jobs'],
    queryFn: () => backupsApi.jobs(),
    staleTime: 30_000,
  });

  const columns: Array<Column<BackupJob>> = [
    {
      key: 'job_id',
      header: '任务 ID',
      width: 110,
      render: (j) => <span className="mono fw-500">{j.job_id}</span>,
    },
    {
      key: 'schedule',
      header: '调度计划',
      render: (j) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{j.schedule || '—'}</span>
          <span className="fs-xs text-muted">{describeSchedule(j.schedule)}</span>
        </div>
      ),
    },
    {
      key: 'scope',
      header: '备份范围',
      render: (j) => (
        <div className="vm-name-cell">
          <span className="fs-sm">
            {j.vmid ? `VMID: ${j.vmid}` : '节点全部虚拟机'}
          </span>
          <span className="fs-xs text-muted">
            {j.node ? `节点 ${j.node} → ` : ''}
            {j.storage}
          </span>
        </div>
      ),
    },
    {
      key: 'mode',
      header: '模式',
      width: 120,
      render: (j) => (
        <Badge variant="neutral" size="sm">
          {j.mode} / {j.compress}
        </Badge>
      ),
    },
    {
      key: 'retention',
      header: '保留策略',
      width: 170,
      render: (j) => (
        <span className="fs-sm text-secondary truncate">
          {j.prune_backups
            ? j.prune_backups
            : [
                j.keep_daily ? `日 ${j.keep_daily}` : '',
                j.keep_weekly ? `周 ${j.keep_weekly}` : '',
                j.keep_monthly ? `月 ${j.keep_monthly}` : '',
              ]
                .filter(Boolean)
                .join(' / ') || '—'}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: '状态',
      width: 100,
      align: 'center',
      render: (j) => (
        <Badge variant={j.enabled ? 'success' : 'neutral'} dot size="sm">
          {j.enabled ? '已启用' : '已停用'}
        </Badge>
      ),
    },
    {
      key: 'next_run',
      header: '下次执行',
      width: 180,
      render: (j) => (
        <div className="vm-name-cell">
          <span className="fs-sm">
            {j.next_run ? formatDateTime(j.next_run) : '—'}
          </span>
          <span className="fs-xs text-muted">
            {j.last_run ? `上次：${formatRelative(j.last_run)}` : '从未执行'}
          </span>
        </div>
      ),
    },
    {
      key: 'owner',
      header: '创建者',
      width: 90,
      render: (j) => (
        <span className="fs-sm text-secondary">{j.owner || '—'}</span>
      ),
      sortable: true,
      sortValue: (j) => j.owner ?? '',
    },
    {
      key: 'actions',
      header: '操作',
      width: 100,
      align: 'right',
      render: (j) => (
        <span className="row-actions">
          <IconButton
            label={`编辑计划 ${j.job_id}`}
            disabled={!canWrite}
            onClick={(e) => {
              e.stopPropagation();
              setEditTarget(j);
              setEditorOpen(true);
            }}
          >
            <IconClock size={15} />
          </IconButton>
          <IconButton
            label={`删除计划 ${j.job_id}`}
            variant="danger"
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(j);
            }}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  return (
    <>
      {!isAdmin ? (
        <Notice tone="info" title="权限说明">
          只有管理员可以删除备份计划；普通用户角色可以创建与编辑。
        </Notice>
      ) : null}

      <div className="toolbar">
        <div className="toolbar-left">
          <span className="fs-sm text-secondary">
            共 {jobsQuery.data?.length ?? 0} 个定时备份计划
          </span>
        </div>
        <div className="toolbar-right">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => void jobsQuery.refetch()}
            loading={jobsQuery.isFetching && !jobsQuery.isLoading}
          >
            刷新
          </Button>
          <Button
            variant="primary"
            icon={<IconPlus size={15} />}
            onClick={() => {
              setEditTarget(null);
              setEditorOpen(true);
            }}
            disabled={!canWrite}
          >
            新建计划
          </Button>
        </div>
      </div>

      {jobsQuery.isError && isNotImplemented(jobsQuery.error) ? (
        <ErrorState
          notImplemented
          title="备份计划接口尚未实现"
          message="后端 /backups/jobs 返回未实现。建议基于 Proxmox 的 /cluster/backup 接口实现增删改查。"
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : jobsQuery.isError ? (
        <ErrorState
          title="无法加载备份计划"
          message={errorMessage(jobsQuery.error)}
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : (
        <Table<BackupJob>
          columns={columns}
          rows={jobsQuery.data ?? []}
          rowKey={(j) => String(j.job_id)}
          loading={jobsQuery.isLoading}
          caption="定时备份计划列表"
          emptyTitle="暂无备份计划"
          emptyDescription="创建定时备份计划，Proxmox 会按调度自动执行备份并应用保留策略。"
          emptyAction={
            canWrite ? (
              <Button
                variant="primary"
                icon={<IconPlus size={15} />}
                onClick={() => {
                  setEditTarget(null);
                  setEditorOpen(true);
                }}
              >
                新建计划
              </Button>
            ) : undefined
          }
        />
      )}

      <JobEditor
        open={editorOpen}
        job={editTarget}
        onClose={() => setEditorOpen(false)}
        onDone={() => {
          setEditorOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['backups', 'jobs'] });
        }}
        runner={runner}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await runner.run(backupsApi.deleteJob(deleteTarget.job_id), {
              title: `删除备份计划 ${deleteTarget.job_id}`,
              node: deleteTarget.node ?? '',
              invalidate: [['backups', 'jobs']],
            });
            setDeleteTarget(null);
          } catch (err) {
            toast.error('删除备份计划失败', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="删除备份计划"
        danger
        confirmText="删除计划"
        loading={busy}
        message={
          <>
            即将删除备份计划 <strong>{deleteTarget?.job_id}</strong>（
            {deleteTarget?.schedule}）。已生成的备份文件不会被删除。
          </>
        }
      />
    </>
  );
}

/* ---------------------------------------------------------------------------
   恢复对话框
   --------------------------------------------------------------------------- */

function RestoreDialog({
  item,
  onClose,
  onDone,
  runner,
}: {
  item: BackupItem | null;
  onClose: () => void;
  onDone: () => void;
  runner: TaskRunner;
}) {
  const toast = useToast();

  const [node, setNode] = useState('');
  const [vmid, setVmid] = useState('');
  const [storage, setStorage] = useState('');
  const [force, setForce] = useState(false);
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    staleTime: 30_000,
  });

  /* 打开时用备份自带信息预填 */
  useEffect(() => {
    if (!item) return;
    setNode(item.node ?? '');
    setVmid(String(item.vmid ?? ''));
    setStorage(item.storage ?? '');
    setForce(false);
    setStart(false);
  }, [item]);

  const storagesQuery = useQuery({
    queryKey: ['storages', node],
    queryFn: () => storagesApi.list(node || undefined),
    enabled: Boolean(node),
    staleTime: 30_000,
  });

  const storageOptions = useMemo(
    () =>
      (storagesQuery.data ?? []).map((s) => ({
        label: s.storage,
        value: s.storage,
      })),
    [storagesQuery.data],
  );

  const nodeOptions = useMemo(
    () => (nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
    [nodesQuery.data],
  );

  const submit = async () => {
    if (!item) return;
    const targetVmid = Number(vmid);
    if (!node || !storage || !Number.isFinite(targetVmid) || targetVmid <= 0) {
      toast.error('无法提交', '请填写完整的目标节点、存储与 VMID');
      return;
    }
    setBusy(true);
    try {
      const body: BackupRestoreRequest = {
        node,
        storage,
        volid: item.volid,
        vmid: targetVmid,
        force: force || undefined,
        start: start || undefined,
      };
      await runner.run(backupsApi.restore(body), {
        title: `恢复备份到 VM ${targetVmid}`,
        node,
        invalidate: [['backups'], ['vms'], ['tasks']],
      });
      onDone();
    } catch {
      /* 已提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(item)}
      onClose={onClose}
      title="恢复备份"
      description="把备份文件恢复为虚拟机，已有同 VMID 的虚拟机会被覆盖"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            确认恢复
          </Button>
        </>
      }
    >
      <Notice tone="danger" title="该操作会覆盖现有数据">
        恢复将把备份内容写回目标 VMID。如果该 VMID 已存在虚拟机，
        必须先删除或开启「强制覆盖」，否则 Proxmox 会拒绝执行。
      </Notice>

      <div className="dyn-list mt-16">
        <Field label="备份文件">
          <div className="mono fs-sm truncate" title={item?.volid}>
            {item?.volid}
          </div>
        </Field>

        <div className="dyn-row">
          <Field label="目标节点" required>
            <Select
              value={node}
              onChange={(e) => {
                setNode(e.target.value);
                setStorage('');
              }}
              options={nodeOptions}
              placeholder="请选择节点"
            />
          </Field>

          <Field label="目标存储" required>
            <Select
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              options={storageOptions}
              placeholder="请选择存储"
            />
          </Field>
        </div>

        <Field label="目标 VMID" required hint="默认为备份所属的原始 VMID">
          <Input
            type="number"
            min={1}
            value={vmid}
            onChange={(e) => setVmid(e.target.value)}
            className="mono"
          />
        </Field>

        <Switch
          checked={force}
          onChange={setForce}
          label="强制覆盖已存在的 VMID"
          hint="对应 Proxmox 的 force 参数，仅在确认原虚拟机已废弃时使用"
        />

        <Switch
          checked={start}
          onChange={setStart}
          label="恢复完成后立即启动"
          hint="对应 Proxmox 的 start 参数"
        />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   备份计划编辑器
   --------------------------------------------------------------------------- */

const EMPTY_JOB: BackupJobInput = {
  schedule: '02:00',
  storage: '',
  mode: 'snapshot',
  compress: 'zstd',
  vmid: '',
  node: '',
  enabled: true,
  notes: '',
  prune_backups: 'keep-daily=7,keep-weekly=4,keep-monthly=3',
};

function JobEditor({
  open,
  job,
  onClose,
  onDone,
  runner,
}: {
  open: boolean;
  job: BackupJob | null;
  onClose: () => void;
  onDone: () => void;
  runner: TaskRunner;
}) {
  const toast = useToast();

  const [form, setForm] = useState<BackupJobInput>(EMPTY_JOB);
  const [busy, setBusy] = useState(false);
  const [startNow, setStartNow] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (job) {
      setForm({
        schedule: job.schedule ?? '02:00',
        storage: job.storage ?? '',
        mode: job.mode ?? 'snapshot',
        compress: job.compress ?? 'zstd',
        vmid: job.vmid ?? '',
        node: job.node ?? '',
        enabled: job.enabled ?? true,
        notes: job.notes ?? job.comment ?? '',
        prune_backups: job.prune_backups ?? '',
      });
    } else {
      setForm(EMPTY_JOB);
    }
    setStartNow(false);
  }, [open, job]);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    enabled: open,
    staleTime: 30_000,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', form.node],
    queryFn: () => storagesApi.list(form.node || undefined),
    enabled: open && Boolean(form.node),
    staleTime: 30_000,
  });

  const storageOptions = useMemo(
    () =>
      (storagesQuery.data ?? [])
        .filter((s) => (s.content ?? '').split(',').includes('backup'))
        .map((s) => ({ label: s.storage, value: s.storage })),
    [storagesQuery.data],
  );

  const nodeOptions = useMemo(
    () => (nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
    [nodesQuery.data],
  );

  const patch = <K extends keyof BackupJobInput>(
    key: K,
    value: BackupJobInput[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const valid =
    Boolean(form.schedule.trim()) && Boolean(form.storage) && Boolean(form.node);

  const submit = async () => {
    if (!valid) {
      toast.error('请填写完整', '调度计划、节点与存储为必填项');
      return;
    }
    setBusy(true);
    try {
      await runner.run(
        backupsApi.createJob({
          ...form,
          vmid: form.vmid?.trim() || undefined,
          notes: form.notes?.trim() || undefined,
          prune_backups: form.prune_backups?.trim() || undefined,
        }),
        {
          title: job ? '更新备份计划' : '创建备份计划',
          node: form.node ?? '',
          invalidate: [['backups', 'jobs']],
        },
      );
      if (startNow) {
        await runner.run(
          backupsApi.create({
            node: form.node ?? '',
            vmid: form.vmid ? Number(form.vmid) : undefined,
            storage: form.storage,
            mode: form.mode,
            compress: form.compress,
            notes: form.notes?.trim() || undefined,
            all: form.vmid ? undefined : true,
          }),
          {
            title: '立即执行一次备份',
            node: form.node ?? '',
            invalidate: [['backups', 'list']],
          },
        );
      }
      onDone();
    } catch {
      /* 已提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={job ? `编辑备份计划 ${job.job_id}` : '新建备份计划'}
      description="Proxmox 会按调度计划自动执行备份，并应用保留策略清理旧备份"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!valid}
          >
            {job ? '保存修改' : '创建计划'}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <div className="dyn-row">
          <Field label="目标节点" required>
            <Select
              value={form.node ?? ''}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, node: e.target.value, storage: '' }))
              }
              options={nodeOptions}
              placeholder="请选择节点"
            />
          </Field>

          <Field
            label="调度计划"
            required
            hint="Proxmox 格式：HH:MM 或 星期几 HH:MM，如 02:30、sat 03:00"
          >
            <Input
              value={form.schedule}
              onChange={(e) => patch('schedule', e.target.value)}
              placeholder="02:00"
              className="mono"
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field label="备份存储" required>
            <Select
              value={form.storage}
              onChange={(e) => patch('storage', e.target.value)}
              options={storageOptions}
              placeholder="请选择存储"
            />
          </Field>

          <Field label="备份模式" required>
            <Select
              value={form.mode}
              onChange={(e) => patch('mode', e.target.value as BackupMode)}
              options={BACKUP_MODE_OPTIONS.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label="压缩" required>
            <Select
              value={form.compress}
              onChange={(e) => patch('compress', e.target.value)}
              options={COMPRESS_OPTIONS.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>
        </div>

        <Field
          label="备份哪些虚拟机"
          hint="留空表示备份该节点上全部虚拟机；多个 VMID 用英文逗号分隔"
        >
          <Input
            value={form.vmid ?? ''}
            onChange={(e) => patch('vmid', e.target.value)}
            placeholder="100,101,102"
            className="mono"
          />
        </Field>

        <Field
          label="保留策略"
          hint="Proxmox 的 prune-backups 语法，按数量或天数保留历史备份"
        >
          <Input
            value={form.prune_backups ?? ''}
            onChange={(e) => patch('prune_backups', e.target.value)}
            placeholder="keep-daily=7,keep-weekly=4,keep-monthly=3"
            className="mono"
          />
        </Field>

        <Field label="备注">
          <Textarea
            value={form.notes ?? ''}
            onChange={(e) => patch('notes', e.target.value)}
            rows={2}
          />
        </Field>

        <Switch
          checked={form.enabled ?? true}
          onChange={(v) => patch('enabled', v)}
          label="启用该计划"
          hint="停用后 Proxmox 不会按调度执行，但计划配置保留"
        />

        <Switch
          checked={startNow}
          onChange={setStartNow}
          label="创建后立即执行一次"
          hint="忽略调度时间，马上跑一次验证配置"
        />
      </div>

      <Notice tone="info" title="保留策略示例">
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label mono">keep-daily=7</div>
            <div className="desc-value">保留最近 7 天的每日备份</div>
          </div>
          <div className="desc-item">
            <div className="desc-label mono">keep-weekly=4</div>
            <div className="desc-value">保留最近 4 周的每周备份</div>
          </div>
          <div className="desc-item">
            <div className="desc-label mono">keep-last=3</div>
            <div className="desc-value">保留最近 3 份备份，不论时间间隔</div>
          </div>
        </div>
      </Notice>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   调度描述（把 Proxmox 的 schedule 字符串转成中文说明）
   --------------------------------------------------------------------------- */

const WEEKDAY_CN: Record<string, string> = {
  mon: '周一',
  tue: '周二',
  wed: '周三',
  thu: '周四',
  fri: '周五',
  sat: '周六',
  sun: '周日',
};

function describeSchedule(schedule?: string | null): string {
  if (!schedule) return '未设置调度';
  const raw = schedule.trim();

  if (/^\d{1,2}:\d{2}$/.test(raw)) return `每天 ${raw}`;

  const m = /^([a-z,*-]+)\s+(\d{1,2}:\d{2})$/.exec(raw.toLowerCase());
  if (m) {
    const dayPart = m[1];
    const time = m[2];
    if (dayPart === '*') return `每天 ${time}`;
    const days = dayPart
      .split(',')
      .map((d) => WEEKDAY_CN[d] ?? d)
      .filter(Boolean);
    return `每${days.join('、')} ${time}`;
  }

  return raw;
}
