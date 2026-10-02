/* ==========================================================================
   ProxCenter — 备份
   三个 Tab：备份文件 / 备份计划 / 立即备份
   ========================================================================== */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  backupsApi,
  connectionsApi,
  nodesApi,
  storagesApi,
  vmsApi,
} from '../api/endpoints';
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
import { backupModeOptions, compressOptions } from '../utils/status';
import { useTaskRunner, type TaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { tStatic, useT, type MessageKey } from '../i18n';
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

/**
 * 备份计划行：多台 PVE 的计划合并展示，额外记住它来自哪条连接。
 *
 * 任务号是各主机各自编的（两台都可能有 job_id=1），没有这个字段就无法确定
 * 「删除该发给哪一台」，表格的行键也会撞车。
 */
type JobRow = BackupJob & { connection_id?: string };

/**
 * 备份归档行：多台 PVE 的归档合并展示时记住来源连接。
 *
 * 卷标识形如 ``local:backup/vzdump-qemu-100-….vma.zst``，两台 PVE 上完全可能
 * 重名 —— 表格行键与「删除该发给谁」都靠这个字段区分。
 */
type BackupRow = BackupItem & { connection_id?: string };

export function Backups() {
  const t = useT();
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

  const tabs: Array<{ key: TabKey; labelKey: MessageKey; icon: ReactNode }> = [
    { key: 'files', labelKey: 'backups.tabFiles', icon: <IconBackup size={15} /> },
    { key: 'jobs', labelKey: 'backups.tabJobs', icon: <IconClock size={15} /> },
    {
      key: 'create',
      labelKey: 'backups.tabCreate',
      icon: <IconPlus size={15} />,
    },
  ];

  return (
    <PageShell
      title={
        <>
          <IconBackup size={20} />
          {t('backups.title')}
        </>
      }
      subtitle={t('backups.subtitle')}
      actions={
        <Button
          variant="secondary"
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['backups'] });
          }}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      <div className="tabs" role="tablist" aria-label={t('backups.tabAria')}>
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            <span className="tab-icon" aria-hidden="true">
              {item.icon}
            </span>
            {t(item.labelKey)}
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
  const t = useT();
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

  /* 选中的节点属于哪台 PVE。/api/nodes 是**跨主机聚合**的（每条都带 connection_id），
     而节点作用域的接口不带连接时会落到「面板当前连接」—— 在别的主机的节点名上
     会直接报 `hostname lookup 'pve9' failed`。查询键也带上连接：两台 PVE 上的
     同名节点不能共用一份缓存。 */
  const connOfNode = (name: string) =>
    (nodesQuery.data ?? []).find((n) => n.node === name)?.connection_id;

  const storagesQuery = useQuery({
    queryKey: ['storages', connOfNode(node), node],
    queryFn: () => storagesApi.list(node || undefined, connOfNode(node)),
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
        backupsApi.create(
          {
            node,
            vmid: all ? undefined : Number(vmid),
            storage,
            mode,
            compress,
            notes: notes.trim() || undefined,
            all: all || undefined,
          },
          connOfNode(node),
        ),
        {
          title: all
            ? t('backups.taskAll', { node })
            : t('backups.taskOne', { vmid }),
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
      <Notice tone="info" title={t('backups.readOnlyTitle')}>
        {t('backups.readOnlyBody')}
      </Notice>
    );
  }

  return (
    <div className="grid grid-2">
      <Card>
        <CardHeader
          title={t('backups.createCard')}
          subtitle={t('backups.createCardSub')}
          icon={<IconBackup size={17} />}
        />

        <div className="dyn-list">
          <Field label={t('backups.fieldNode')} required>
            <Select
              value={node}
              onChange={(e) => {
                setNode(e.target.value);
                setVmid('');
                setStorage('');
              }}
              options={nodeOptions}
              placeholder={
                nodeOptions.length === 0
                  ? t('backups.nodeLoading')
                  : t('backups.nodePlaceholder')
              }
            />
          </Field>

          <Field label={t('backups.fieldScope')} required>
            <div
              className="radio-group"
              role="radiogroup"
              aria-label={t('backups.fieldScope')}
            >
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
                  <span className="radio-label">{t('backups.scopeOne')}</span>
                  <span className="radio-hint">{t('backups.scopeOneHint')}</span>
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
                  <span className="radio-label">{t('backups.scopeAll')}</span>
                  <span className="radio-hint">
                    {t('backups.scopeAllHint', { count: nodeVms.length })}
                  </span>
                </span>
              </label>
            </div>
          </Field>

          {!all ? (
            <Field
              label={t('backups.fieldVm')}
              required
              hint={nodeVms.length === 0 ? t('backups.noVm') : undefined}
            >
              <Select
                value={vmid}
                onChange={(e) => setVmid(e.target.value)}
                placeholder={t('backups.vmPlaceholder')}
                options={nodeVms.map((v) => ({
                  label: `${v.vmid} — ${v.name || t('backups.vmUnnamed')}`,
                  value: String(v.vmid),
                }))}
              />
            </Field>
          ) : null}

          <Field
            label={t('backups.fieldStorage')}
            required
            hint={
              backupStorages.length === 0
                ? t('backups.noBackupStorage')
                : t('backups.storageHint')
            }
          >
            <Select
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              options={storageOptions}
              placeholder={t('backups.storagePlaceholder')}
            />
          </Field>

          <Field label={t('backups.fieldMode')} required>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as BackupMode)}
              options={backupModeOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label={t('backups.fieldCompress')} required>
            <Select
              value={compress}
              onChange={(e) => setCompress(e.target.value)}
              options={compressOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label={t('backups.fieldNotes')} hint={t('backups.fieldNotesHint')}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={t('backups.notesPlaceholder')}
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
            {t('backups.start')}
          </Button>
        </div>
      </Card>

      <div className="flex flex-col gap-16">
        <Card>
          <CardHeader title={t('backups.modeHelp')} icon={<IconShield size={17} />} />
          <div className="desc-list">
            <div className="desc-item">
              <div className="desc-label">Snapshot</div>
              <div className="desc-value">{t('backups.modeSnapshot')}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">Suspend</div>
              <div className="desc-value">{t('backups.modeSuspend')}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">Stop</div>
              <div className="desc-value">{t('backups.modeStop')}</div>
            </div>
          </div>
        </Card>

        <CollapsibleCard
          title={t('backups.compressHelp')}
          icon={<IconShield size={15} />}
        >
          <div className="desc-list">
            <div className="desc-item">
              <div className="desc-label">ZSTD</div>
              <div className="desc-value">{t('backups.compressZstd')}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">LZO</div>
              <div className="desc-value">{t('backups.compressLzo')}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">GZIP</div>
              <div className="desc-value">{t('backups.compressGzip')}</div>
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
  const t = useT();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  const [node, setNode] = useState('');
  const [storage, setStorage] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupRow | null>(null);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    staleTime: 30_000,
  });

  /* 节点属于哪台 PVE（/api/nodes 跨主机聚合，每条带 connection_id）：
     选中别的 PVE 上的节点时，不带连接的请求会被送到「面板当前连接」，
     在那边找这个节点名 —— PVE 回 hostname lookup 失败，列表就是空的/报错。 */
  const connOfNode = (name: string) =>
    (nodesQuery.data ?? []).find((n) => n.node === name)?.connection_id;
  const conn = node ? connOfNode(node) : undefined;

  /* 「全部节点」必须跨所有 PVE 取：归档各存各家，只查当前连接会让别的主机的备份
     凭空消失（而页头的 KPI 是跨主机汇总的，两边会自相矛盾）。每条归档记住来源
     连接 —— 卷标识（local:backup/xxx）在不同主机上可能重名，删除要知道发给谁。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
  });
  const connectionIds = (connectionsQuery.data ?? []).map((c) => c.id).join(',');

  const listQuery = useQuery({
    queryKey: ['backups', 'list', conn, node, storage, connectionIds],
    queryFn: async () => {
      if (node) {
        // 选了具体节点：只问它所在的那台主机
        return backupsApi.list(
          { node, storage: storage || undefined },
          conn,
        );
      }
      const conns = connectionsQuery.data ?? [];
      const results = await Promise.all(
        conns.map(async (c) => {
          try {
            const list = await backupsApi.list(
              { storage: storage || undefined },
              c.id,
            );
            return list.map((b) => ({ ...b, connection_id: c.id }));
          } catch {
            // 单台主机读失败只跳过它自己，不影响其它主机的归档
            return [] as BackupRow[];
          }
        }),
      );
      return results.flat();
    },
    enabled: Boolean(node) || connectionsQuery.isSuccess,
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
      { label: t('backups.filterAllNodes'), value: '' },
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
      { label: t('backups.filterAllStorage'), value: '' },
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
  const download = (item: BackupRow) => {
    // 归档在宿主机上的路径由「存储路径 + 归档名」拼出，两个字段缺一不可
    if (!item.node || !item.storage) {
      toast.error(
        t('backups.downloadFailed'),
        t('backups.downloadFailedHint'),
      );
      return;
    }
    window.open(
      backupsApi.downloadUrl({
        node: item.node,
        storage: item.storage,
        volid: item.volid,
        connectionId: item.connection_id,
      }),
      '_blank',
    );
  };

  const copyVolid = async (volid: string) => {
    try {
      await navigator.clipboard.writeText(volid);
      toast.success(t('backups.volidCopied'));
    } catch {
      toast.error(t('backups.copyFailed'), t('backups.copyFailedHint'));
    }
  };

  const columns: Array<Column<BackupRow>> = [
    {
      key: 'vmid',
      header: t('backups.colVm'),
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
      header: t('backups.colVolid'),
      render: (b) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm truncate" title={b.volid}>
            {b.volid}
          </span>
          <span className="fs-xs text-muted truncate">
            {b.format || t('backups.unknownFormat')}
            {b.notes ? ` · ${b.notes}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'ctime',
      header: t('vmDetail.snapColCreated'),
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
      header: t('vmDetail.backupColSize'),
      width: 110,
      align: 'right',
      render: (b) => <span className="mono fs-sm">{formatBytes(b.size)}</span>,
      sortable: true,
      sortValue: (b) => b.size ?? 0,
    },
    {
      key: 'owner',
      header: t('backups.colCreator'),
      width: 90,
      render: (b) => (
        <span className="fs-sm text-secondary">{b.owner || '—'}</span>
      ),
      sortable: true,
      sortValue: (b) => b.owner ?? '',
    },
    {
      key: 'actions',
      header: t('backups.colActions'),
      width: 170,
      align: 'right',
      render: (b) => (
        <span className="row-actions">
          <IconButton
            label={t('backups.restoreAria', { volid: b.volid })}
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
            label={t('backups.downloadAria', { volid: b.volid })}
            onClick={(e) => {
              e.stopPropagation();
              download(b);
            }}
          >
            <IconDownload size={15} />
          </IconButton>
          <IconButton
            label={t('backups.copyVolid')}
            onClick={(e) => {
              e.stopPropagation();
              void copyVolid(b.volid);
            }}
          >
            <IconCopy size={15} />
          </IconButton>
          <IconButton
            label={t('backups.deleteAria', { volid: b.volid })}
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
        title={t('backups.notImplTitle')}
        message={t('backups.notImplMessage')}
        onRetry={() => void listQuery.refetch()}
      />
    );
  }

  return (
    <>
      <div className="grid grid-4">
        <KpiCard
          label={t('backups.kpiFiles')}
          value={stats.count}
          icon={<IconBackup size={18} />}
          tone="accent"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label={t('backups.kpiSpace')}
          value={formatBytes(stats.totalSize)}
          icon={<IconShield size={18} />}
          tone="neutral"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label={t('backups.kpiVms')}
          value={stats.vms}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label={t('backups.kpiSuccess')}
          value={
            backupStats?.success_rate === null ||
            backupStats?.success_rate === undefined
              ? '—'
              : `${backupStats.success_rate}%`
          }
          hint={
            backupStats
              ? t('backups.kpiRecent', {
                  days: backupStats.days,
                  ok: backupStats.ok,
                  failed: backupStats.failed,
                })
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
            placeholder={t('backups.searchPlaceholder')}
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label={t('backups.searchAria')}
          />
          <Select
            value={node}
            onChange={(e) => {
              setNode(e.target.value);
              setStorage('');
            }}
            options={nodeOptions}
            aria-label={t('backups.filterNodeAria')}
          />
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
            aria-label={t('backups.filterStorageAria')}
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            {t('backups.totalItems', { count: items.length })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => void listQuery.refetch()}
            loading={listQuery.isFetching && !listQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {listQuery.isError && !isNotImplemented(listQuery.error) ? (
        <ErrorState
          title={t('backups.loadFailed')}
          message={errorMessage(listQuery.error)}
          onRetry={() => void listQuery.refetch()}
        />
      ) : (
        <>
          <Table<BackupRow>
            columns={columns}
            rows={paged}
            /* 卷标识在不同 PVE 上可能重名，行键必须带上来源连接 */
            rowKey={(b) => `${b.connection_id ?? ''}:${b.volid}`}
            loading={listQuery.isLoading}
            caption={t('backups.tableCaption')}
            emptyTitle={
              search ? t('backups.emptySearch') : t('backups.empty')
            }
            emptyDescription={
              search
                ? t('backups.emptySearchDesc')
                : t('backups.emptyDesc')
            }
            emptyAction={
              canWrite && !search ? (
                <Button
                  variant="primary"
                  icon={<IconPlus size={15} />}
                  onClick={onGoCreate}
                >
                  {t('backups.goCreate')}
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
            toast.error(t('backups.deleteFailed'), t('backups.deleteFailedHint'));
            return;
          }
          setBusy(true);
          try {
            // 走备份专用接口（vm.backup + 归属校验）。不能用 storages 的
            // 通用卷删除：那条路要求 storage.manage，普通用户角色会被 403。
            await runner.run(
              backupsApi.remove(
                {
                  node: nodeName,
                  storage: storageName,
                  volid: deleteTarget.volid,
                },
                // 归档来自哪台 PVE 就以它为准（列表跨主机合并，卷标识可能重名），
                // 退一步再按节点名定位连接
                deleteTarget.connection_id ?? connOfNode(nodeName),
              ),
              {
                title: t('backups.deleteTask', { volid: deleteTarget.volid }),
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
        title={t('backups.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        requireText={deleteTarget?.volid}
        message={
          <>
            {t('backups.deleteBodyPre')}
            <strong className="mono">{deleteTarget?.volid}</strong>（
            {formatBytes(deleteTarget?.size)}）
            {t('backups.deleteBodyTail')}
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
  const t = useT();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<JobRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobRow | null>(null);
  const [busy, setBusy] = useState(false);

  /* 备份计划是**每台 PVE 各存一份**（standalone 时互不相通）。只查「面板当前
     连接」的话，给别的 PVE 建完计划在列表里根本看不见 —— 于是这里跨所有连接
     合并，每条计划带上来源连接，删除时才知道该发给哪一台。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
  });

  const jobsQuery = useQuery({
    queryKey: [
      'backups',
      'jobs',
      (connectionsQuery.data ?? []).map((c) => c.id).join(','),
    ],
    queryFn: async () => {
      const conns = connectionsQuery.data ?? [];
      const results = await Promise.all(
        conns.map(async (c) => {
          try {
            const jobs = await backupsApi.jobs(c.id);
            return jobs.map((j) => ({ ...j, connection_id: c.id }));
          } catch {
            // 单台主机读失败只跳过它自己，不影响其它主机的计划
            return [] as JobRow[];
          }
        }),
      );
      return results.flat();
    },
    enabled: connectionsQuery.isSuccess,
    staleTime: 30_000,
  });

  const columns: Array<Column<JobRow>> = [
    {
      key: 'job_id',
      header: t('backups.colJobId'),
      width: 110,
      render: (j) => <span className="mono fw-500">{j.job_id}</span>,
    },
    {
      key: 'schedule',
      header: t('backups.colSchedule'),
      render: (j) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{j.schedule || '—'}</span>
          <span className="fs-xs text-muted">{describeSchedule(j.schedule)}</span>
        </div>
      ),
    },
    {
      key: 'scope',
      header: t('backups.colScope'),
      render: (j) => (
        <div className="vm-name-cell">
          <span className="fs-sm">
            {j.vmid ? `VMID: ${j.vmid}` : t('backups.scopeAllNode')}
          </span>
          <span className="fs-xs text-muted">
            {j.node ? t('backups.nodePrefix', { node: j.node }) : ''}
            {j.storage}
          </span>
        </div>
      ),
    },
    {
      key: 'mode',
      header: t('backups.colMode'),
      width: 120,
      render: (j) => (
        <Badge variant="neutral" size="sm">
          {j.mode} / {j.compress}
        </Badge>
      ),
    },
    {
      key: 'retention',
      header: t('backups.colRetention'),
      width: 170,
      render: (j) => (
        <span className="fs-sm text-secondary truncate">
          {j.prune_backups
            ? j.prune_backups
            : [
                j.keep_daily ? t('backups.keepDaily', { n: j.keep_daily }) : '',
                j.keep_weekly ? t('backups.keepWeekly', { n: j.keep_weekly }) : '',
                j.keep_monthly ? t('backups.keepMonthly', { n: j.keep_monthly }) : '',
              ]
                .filter(Boolean)
                .join(' / ') || '—'}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: t('common.status'),
      width: 100,
      align: 'center',
      render: (j) => (
        <Badge variant={j.enabled ? 'success' : 'neutral'} dot size="sm">
          {j.enabled ? t('backups.jobEnabled') : t('backups.jobDisabled')}
        </Badge>
      ),
    },
    {
      key: 'next_run',
      header: t('backups.colNextRun'),
      width: 180,
      render: (j) => (
        <div className="vm-name-cell">
          <span className="fs-sm">
            {j.next_run ? formatDateTime(j.next_run) : '—'}
          </span>
          <span className="fs-xs text-muted">
            {j.last_run
              ? t('backups.lastRun', { time: formatRelative(j.last_run) })
              : t('backups.neverRun')}
          </span>
        </div>
      ),
    },
    {
      key: 'owner',
      header: t('backups.colCreator'),
      width: 90,
      render: (j) => (
        <span className="fs-sm text-secondary">{j.owner || '—'}</span>
      ),
      sortable: true,
      sortValue: (j) => j.owner ?? '',
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 100,
      align: 'right',
      render: (j) => (
        <span className="row-actions">
          <IconButton
            label={t('backups.editPlanAria', { id: j.job_id })}
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
            label={t('backups.deletePlanAria', { id: j.job_id })}
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
        <Notice tone="info" title={t('backups.permTitle')}>
          {t('backups.permBody')}
        </Notice>
      ) : null}

      <div className="toolbar">
        <div className="toolbar-left">
          <span className="fs-sm text-secondary">
            {t('backups.jobsSummary', { n: jobsQuery.data?.length ?? 0 })}
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
            {t('common.refresh')}
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
            {t('backups.newPlan')}
          </Button>
        </div>
      </div>

      {jobsQuery.isError && isNotImplemented(jobsQuery.error) ? (
        <ErrorState
          notImplemented
          title={t('backups.jobsNotImplTitle')}
          message={t('backups.jobsNotImplMsg')}
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : jobsQuery.isError ? (
        <ErrorState
          title={t('backups.jobsLoadFailed')}
          message={errorMessage(jobsQuery.error)}
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : (
        <Table<JobRow>
          columns={columns}
          rows={jobsQuery.data ?? []}
          /* 任务号是各主机各自编的，两台 PVE 都可能有 job_id=1 —— 键必须带上连接 */
          rowKey={(j) => `${j.connection_id ?? ''}:${j.job_id}`}
          loading={jobsQuery.isLoading}
          caption={t('backups.jobsCaption')}
          emptyTitle={t('backups.jobsEmpty')}
          emptyDescription={t('backups.jobsEmptyDesc')}
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
                {t('backups.newPlan')}
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
            await runner.run(
              backupsApi.deleteJob(deleteTarget.job_id, deleteTarget.connection_id),
              {
              title: t('backups.deleteJobTask', { id: deleteTarget.job_id }),
              node: deleteTarget.node ?? '',
              invalidate: [['backups', 'jobs']],
            });
            setDeleteTarget(null);
          } catch (err) {
            toast.error(t('backups.deleteJobFailed'), errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title={t('backups.deletePlanTitle')}
        danger
        confirmText={t('backups.deletePlanConfirm')}
        loading={busy}
        message={t('backups.deletePlanMessage', {
          id: deleteTarget?.job_id ?? '',
          schedule: deleteTarget?.schedule ?? '',
        })}
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
  const t = useT();
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

  /* 目标节点属于哪台 PVE：归档可能来自别的 PVE（列表跨主机聚合），恢复时必须
     把请求送到那台主机上，否则会落到「面板当前连接」并在那边找这个节点名。 */
  const connOfNode = (name: string) =>
    (nodesQuery.data ?? []).find((n) => n.node === name)?.connection_id;

  const storagesQuery = useQuery({
    queryKey: ['storages', connOfNode(node), node],
    queryFn: () => storagesApi.list(node || undefined, connOfNode(node)),
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
      toast.error(t('common.opFailed'), t('backups.restoreMissing'));
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
      await runner.run(backupsApi.restore(body, connOfNode(node)), {
        title: t('backups.restoreTask', { vmid: targetVmid }),
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
      title={t('backups.restoreTitle')}
      description={t('backups.restoreDesc')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            {t('backups.restoreConfirm')}
          </Button>
        </>
      }
    >
      <Notice tone="danger" title={t('backups.restoreWarnTitle')}>
        {t('backups.restoreWarnBody')}
      </Notice>

      <div className="dyn-list mt-16">
        <Field label={t('backups.fieldBackupFile')}>
          <div className="mono fs-sm truncate" title={item?.volid}>
            {item?.volid}
          </div>
        </Field>

        <div className="dyn-row">
          <Field label={t('backups.fieldNode')} required>
            <Select
              value={node}
              onChange={(e) => {
                setNode(e.target.value);
                setStorage('');
              }}
              options={nodeOptions}
              placeholder={t('backups.nodePlaceholder')}
            />
          </Field>

          <Field label={t('backups.fieldTargetStorage')} required>
            <Select
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              options={storageOptions}
              placeholder={t('backups.storagePlaceholder')}
            />
          </Field>
        </div>

        <Field
          label={t('backups.fieldTargetVmid')}
          required
          hint={t('backups.targetVmidHint')}
        >
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
          label={t('backups.forceOverwrite')}
          hint={t('backups.forceOverwriteHint')}
        />

        <Switch
          checked={start}
          onChange={setStart}
          label={t('backups.startAfterRestore')}
          hint={t('backups.startAfterRestoreHint')}
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
  const t = useT();
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

  /* 计划落在哪台 PVE 上：按选中的节点定位它的连接（节点下拉是跨主机聚合的），
     否则计划会被写到「面板当前连接」上、并带上别的主机的节点名。 */
  const connOfNode = (name: string) =>
    (nodesQuery.data ?? []).find((n) => n.node === name)?.connection_id;
  const conn = connOfNode(form.node ?? '');

  const storagesQuery = useQuery({
    queryKey: ['storages', conn, form.node],
    queryFn: () => storagesApi.list(form.node || undefined, conn),
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
      toast.error(t('common.opFailed'), t('backups.jobMissing'));
      return;
    }
    setBusy(true);
    try {
      await runner.run(
        backupsApi.createJob(
          {
            ...form,
            vmid: form.vmid?.trim() || undefined,
            notes: form.notes?.trim() || undefined,
            prune_backups: form.prune_backups?.trim() || undefined,
          },
          conn,
        ),
        {
          title: job ? t('backups.jobUpdateTask') : t('backups.jobCreateTask'),
          node: form.node ?? '',
          invalidate: [['backups', 'jobs']],
        },
      );
      if (startNow) {
        await runner.run(
          backupsApi.create(
            {
              node: form.node ?? '',
              vmid: form.vmid ? Number(form.vmid) : undefined,
              storage: form.storage,
              mode: form.mode,
              compress: form.compress,
              notes: form.notes?.trim() || undefined,
              all: form.vmid ? undefined : true,
            },
            conn,
          ),
          {
            title: t('backups.jobRunNowTask'),
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
      title={
        job ? t('backups.jobEditTitle', { id: job.job_id }) : t('backups.jobNewTitle')
      }
      description={t('backups.jobDesc')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!valid}
          >
            {job ? t('backups.saveChanges') : t('backups.createPlan')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <div className="dyn-row">
          <Field label={t('backups.fieldNode')} required>
            <Select
              value={form.node ?? ''}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, node: e.target.value, storage: '' }))
              }
              options={nodeOptions}
              placeholder={t('backups.nodePlaceholder')}
            />
          </Field>

          <Field
            label={t('backups.colSchedule')}
            required
            hint={t('backups.scheduleHint')}
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
          <Field label={t('backups.fieldStorage')} required>
            <Select
              value={form.storage}
              onChange={(e) => patch('storage', e.target.value)}
              options={storageOptions}
              placeholder={t('backups.storagePlaceholder')}
            />
          </Field>

          <Field label={t('backups.fieldMode')} required>
            <Select
              value={form.mode}
              onChange={(e) => patch('mode', e.target.value as BackupMode)}
              options={backupModeOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>

          <Field label={t('backups.fieldCompress')} required>
            <Select
              value={form.compress}
              onChange={(e) => patch('compress', e.target.value)}
              options={compressOptions(t).map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </Field>
        </div>

        <Field
          label={t('backups.vmidsLabel')}
          hint={t('backups.vmidsHint')}
        >
          <Input
            value={form.vmid ?? ''}
            onChange={(e) => patch('vmid', e.target.value)}
            placeholder="100,101,102"
            className="mono"
          />
        </Field>

        <Field
          label={t('backups.colRetention')}
          hint={t('backups.retentionHint')}
        >
          <Input
            value={form.prune_backups ?? ''}
            onChange={(e) => patch('prune_backups', e.target.value)}
            placeholder="keep-daily=7,keep-weekly=4,keep-monthly=3"
            className="mono"
          />
        </Field>

        <Field label={t('backups.fieldNotes')}>
          <Textarea
            value={form.notes ?? ''}
            onChange={(e) => patch('notes', e.target.value)}
            rows={2}
          />
        </Field>

        <Switch
          checked={form.enabled ?? true}
          onChange={(v) => patch('enabled', v)}
          label={t('backups.enablePlan')}
          hint={t('backups.enablePlanHint')}
        />

        <Switch
          checked={startNow}
          onChange={setStartNow}
          label={t('backups.startNow')}
          hint={t('backups.startNowHint')}
        />
      </div>

      <Notice tone="info" title={t('backups.retentionExample')}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label mono">keep-daily=7</div>
            <div className="desc-value">{t('backups.keepDailyValue')}</div>
          </div>
          <div className="desc-item">
            <div className="desc-label mono">keep-weekly=4</div>
            <div className="desc-value">{t('backups.keepWeeklyValue')}</div>
          </div>
          <div className="desc-item">
            <div className="desc-label mono">keep-last=3</div>
            <div className="desc-value">{t('backups.keepLastValue')}</div>
          </div>
        </div>
      </Notice>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   调度描述（把 Proxmox 的 schedule 字符串转成中文说明）
   --------------------------------------------------------------------------- */

const WEEKDAY_KEYS: Record<string, MessageKey> = {
  mon: 'backups.wdMon',
  tue: 'backups.wdTue',
  wed: 'backups.wdWed',
  thu: 'backups.wdThu',
  fri: 'backups.wdFri',
  sat: 'backups.wdSat',
  sun: 'backups.wdSun',
};

function describeSchedule(schedule?: string | null): string {
  if (!schedule) return tStatic('backups.schedNone');
  const raw = schedule.trim();

  if (/^\d{1,2}:\d{2}$/.test(raw)) return tStatic('backups.schedDaily', { time: raw });

  const m = /^([a-z,*-]+)\s+(\d{1,2}:\d{2})$/.exec(raw.toLowerCase());
  if (m) {
    const dayPart = m[1];
    const time = m[2];
    if (dayPart === '*') return tStatic('backups.schedDaily', { time });
    const days = dayPart
      .split(',')
      .map((d) => (WEEKDAY_KEYS[d] ? tStatic(WEEKDAY_KEYS[d]) : d))
      .filter(Boolean);
    return tStatic('backups.schedWeekdays', { days: days.join('、') });
  }

  return raw;
}
