/* ==========================================================================
   ProxCenter — 存储管理
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backupsApi, nodesApi, storagesApi } from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Table, type Column } from '../components/ui/Table';
import { TableSkeleton } from '../components/ui/Spinner';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { ProgressBar } from '../components/ui/ProgressBar';
import {
  IconStorage,
  IconRefresh,
  IconUpload,
  IconTrash,
  IconFolder,
  IconSearch,
  IconClose,
} from '../components/Icons';
import {
  formatBytes,
  formatDateTime,
  usageColor,
} from '../utils/format';
import { contentLabel, storageStatusMeta } from '../utils/status'
import { useT, type MessageKey } from '../i18n';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { Storage, StorageContent } from '../api/types';

const CONTENT_FILTERS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'storages.contentAll', value: '' },
  { label: 'storages.contentVm', value: 'vm' },
  { label: 'storages.contentIso', value: 'iso' },
  { label: 'storages.contentBackup', value: 'backup' },
  { label: 'storages.contentSnippets', value: 'snippets' },
];

export function Storages() {
  const t = useT();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const toast = useToast();
  /* 上传与删除内容都要 storage.manage，而普通用户（operator）只有 storage.view。
     早先这里用的是 canWrite（operator 也算 true），结果按钮看得见、点得动，
     提交后必然被后端 403 —— 所以写操作一律按「具体权限」判断，不用角色粗判。 */
  const { hasPermission } = useAuth();
  const canManageStorage = hasPermission('storage.manage');

  const [nodeFilter, setNodeFilter] = useState('');
  const [selected, setSelected] = useState<Storage | null>(null);
  const [contentFilter, setContentFilter] = useState('');
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<StorageContent | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    staleTime: 60_000,
  });

  /* 节点下拉的值形如 "连接id::节点名"。
     多台 PVE 上可能都有同名节点（例如都叫 pve），只凭名字没法区分是哪一台；
     带上来源连接后，请求才会精确落到所选的那台主机上。 */
  const nodeOptions = useMemo(
    () => [
      { label: t('common.allNodes'), value: '' },
      ...(nodesQuery.data ?? []).map((n) => ({
        label: n.connection_name ? `${n.node}（${n.connection_name}）` : n.node,
        value: n.connection_id ? `${n.connection_id}::${n.node}` : n.node,
      })),
    ],
    [nodesQuery.data, t],
  );

  const [filterConn, filterNode] = useMemo(() => {
    if (!nodeFilter) return [undefined, undefined] as const;
    const at = nodeFilter.indexOf('::');
    if (at < 0) return [undefined, nodeFilter] as const;
    return [nodeFilter.slice(0, at), nodeFilter.slice(at + 2)] as const;
  }, [nodeFilter]);

  const storagesQuery = useQuery({
    queryKey: ['storages', filterConn ?? '', filterNode ?? 'all'],
    queryFn: () => storagesApi.list(filterNode, filterConn),
    refetchInterval: 15_000,
  });

  const storages = storagesQuery.data ?? [];

  /* 展开的存储内容 */
  const contentQuery = useQuery({
    queryKey: [
      'storages',
      'content',
      selected?.connection_id,
      selected?.node,
      selected?.storage,
      contentFilter,
    ],
    queryFn: () =>
      storagesApi.content(
        {
          node: selected!.node,
          storage: selected!.storage,
          content: contentFilter || undefined,
        },
        selected!.connection_id,
      ),
    enabled: Boolean(selected),
    retry: false,
    staleTime: 15_000,
  });

  const filteredContent = useMemo(() => {
    const list = contentQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.volid.toLowerCase().includes(q) ||
        (c.name ?? '').toLowerCase().includes(q) ||
        String(c.vmid ?? '').includes(q),
    );
  }, [contentQuery.data, search]);

  /* 选中存储被删除时清理 */
  useEffect(() => {
    if (!selected) return;
    const stillExists = storages.some(
      (s) => s.storage === selected.storage && s.node === selected.node,
    );
    if (!stillExists && storages.length > 0) setSelected(null);
  }, [storages, selected]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['storages'] });
  };

  const columns: Array<Column<Storage>> = [
    {
      key: 'storage',
      header: t('storages.colName'),
      render: (s) => (
        <div className="flex items-center gap-8">
          <IconStorage size={15} />
          <span className="fw-500">{s.storage}</span>
        </div>
      ),
      sortable: true,
      sortValue: (s) => s.storage,
    },
    {
      key: 'type',
      header: t('storages.colType'),
      render: (s) => (
        <Badge variant="neutral" size="sm">
          {s.type}
        </Badge>
      ),
      width: 110,
      sortable: true,
      sortValue: (s) => s.type,
    },
    {
      key: 'node',
      header: t('common.node'),
      render: (s) => <span className="fs-sm mono">{s.node}</span>,
      width: 110,
      sortable: true,
      sortValue: (s) => s.node,
    },
    {
      key: 'content',
      header: t('storages.colContent'),
      render: (s) => <span className="fs-sm">{contentLabel(s.content, t)}</span>,
      width: 200,
    },
    {
      key: 'total',
      header: t('storages.colTotal'),
      align: 'right',
      width: 100,
      render: (s) => <span className="mono fs-sm">{formatBytes(s.total)}</span>,
      sortable: true,
      sortValue: (s) => s.total,
    },
    {
      key: 'used',
      header: t('storages.colUsed'),
      align: 'right',
      width: 100,
      render: (s) => <span className="mono fs-sm">{formatBytes(s.used)}</span>,
      sortable: true,
      sortValue: (s) => s.used,
    },
    {
      key: 'avail',
      header: t('storages.colAvail'),
      align: 'right',
      width: 100,
      render: (s) => (
        <span className="mono fs-sm text-secondary">{formatBytes(s.avail)}</span>
      ),
      sortable: true,
      sortValue: (s) => s.avail,
    },
    {
      key: 'usage',
      header: t('storages.colUsage'),
      width: 160,
      render: (s) => {
        const pct = s.total > 0 ? (s.used / s.total) * 100 : 0;
        return (
          <div className="flex items-center gap-8" style={{ minWidth: 130 }}>
            <div className="flex-1">
              <ProgressBar value={pct} height={5} color={usageColor(pct)} />
            </div>
            <span className="mono fs-sm" style={{ color: usageColor(pct) }}>
              {pct.toFixed(1)}%
            </span>
          </div>
        );
      },
      sortable: true,
      sortValue: (s) => (s.total > 0 ? s.used / s.total : 0),
    },
    {
      key: 'active',
      header: t('common.status'),
      width: 100,
      render: (s) => {
        const meta = storageStatusMeta(s.active, t);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (s) => (s.active ? 1 : 0),
    },
    {
      key: 'shared',
      header: t('storages.colShared'),
      width: 80,
      align: 'center',
      render: (s) => (
        <Badge variant={s.shared ? 'info' : 'neutral'} size="sm">
          {s.shared ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 130,
      align: 'right',
      render: (s) => (
        <span className="row-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconFolder size={14} />}
            onClick={() => {
              setSelected(s);
              setContentFilter('');
              setSearch('');
            }}
          >
            {t('storages.browse')}
          </Button>
        </span>
      ),
    },
  ];

  /* 删除卷：要 storage.manage。没有该权限时这一整列都不出现 ——
     与其留一个有表头、每行却什么都没有的「操作」列，不如整列省掉。 */
  const contentActionColumn: Column<StorageContent> = {
    key: 'actions',
    header: t('common.actions'),
    width: 80,
    align: 'right',
    render: (c) => (
      <IconButton
        label={t('storages.deleteLabel', { volid: c.volid })}
        variant="danger"
        onClick={() => setDeleteTarget(c)}
        disabled={busy}
      >
        <IconTrash size={15} />
      </IconButton>
    ),
  };

  const contentColumns: Array<Column<StorageContent>> = [
    {
      key: 'volid',
      header: t('storages.colVolid'),
      render: (c) => (
        <span className="mono fs-sm" title={c.volid}>
          {c.volid}
        </span>
      ),
      sortable: true,
      sortValue: (c) => c.volid,
    },
    {
      key: 'name',
      header: t('common.name'),
      render: (c) => (
        <span className="fs-sm text-secondary">{c.name || '—'}</span>
      ),
      width: 180,
    },
    {
      key: 'format',
      header: t('storages.colFormat'),
      render: (c) => (
        <Badge variant="neutral" size="sm">
          {c.format || '—'}
        </Badge>
      ),
      width: 100,
    },
    {
      key: 'size',
      header: t('storages.colSize'),
      align: 'right',
      width: 110,
      render: (c) => <span className="mono fs-sm">{formatBytes(c.size)}</span>,
      sortable: true,
      sortValue: (c) => c.size,
    },
    {
      key: 'ctime',
      header: t('storages.colCtime'),
      render: (c) => (
        <span className="mono fs-sm text-secondary">{formatDateTime(c.ctime)}</span>
      ),
      width: 170,
      sortable: true,
      sortValue: (c) => c.ctime,
    },
    {
      key: 'vmid',
      header: t('storages.colVmid'),
      width: 100,
      render: (c) => (
        <span className="mono fs-sm">{c.vmid ?? '—'}</span>
      ),
      sortable: true,
      sortValue: (c) => c.vmid ?? 0,
    },
    ...(canManageStorage ? [contentActionColumn] : []),
  ];

  const contentNotImpl = isNotImplemented(contentQuery.error);

  return (
    <PageShell
      title={
        <>
          <IconStorage size={20} />
          {t('storages.title')}
        </>
      }
      subtitle={
        storagesQuery.data
          ? t('storages.subtitle', {
              n: storages.length,
              size: formatBytes(storages.reduce((s, x) => s + x.total, 0)),
            })
          : t('common.loading')
      }
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void storagesQuery.refetch();
              if (selected) void contentQuery.refetch();
            }}
            loading={storagesQuery.isFetching && !storagesQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
          {/* 只有能管理存储的人才看到上传入口：普通用户只有 storage.view，
              给了按钮也是点了必 403 */}
          {canManageStorage ? (
            <Button
              variant="primary"
              icon={<IconUpload size={15} />}
              onClick={() => {
                if (!selected) {
                  toast.info(t('storages.selectFirst'), t('storages.selectFirstDetail'));
                  return;
                }
                setUploadOpen(true);
              }}
            >
              {t('storages.uploadIso')}
            </Button>
          ) : null}
        </>
      }
    >
      {/* ---- 存储列表 ---- */}
      <div>
        <div className="toolbar">
          <div className="toolbar-left">
            <Select
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              options={nodeOptions}
              aria-label={t('storages.filterNodeAria')}
            />
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              {t('storages.activeRatio', {
                active: storages.filter((s) => s.active).length,
                total: storages.length,
              })}
            </span>
          </div>
        </div>

        {storagesQuery.isError ? (
          <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            <ErrorState
              title={t('storages.loadFailed')}
              message={errorMessage(storagesQuery.error)}
              notImplemented={isNotImplemented(storagesQuery.error)}
              onRetry={() => void storagesQuery.refetch()}
            />
          </div>
        ) : (
          <Table<Storage>
            columns={columns}
            rows={storages}
            rowKey={(s) => `${s.connection_id ?? ''}/${s.node}/${s.storage}`}
            loading={storagesQuery.isLoading}
            caption={t('storages.caption')}
            onRowClick={(s) => {
              setSelected(s);
              setContentFilter('');
              setSearch('');
            }}
            isRowSelected={(s) =>
              selected?.storage === s.storage &&
              selected?.node === s.node &&
              selected?.connection_id === s.connection_id
            }
            emptyTitle={t('storages.emptyTitle')}
            emptyDescription={
              <>
                {t('storages.emptyDescPre')}
                <code className="mono">{t('storages.emptyDescPath')}</code>
                {t('storages.emptyDescPost')}
              </>
            }
            emptyAction={
              <Button
                variant="secondary"
                icon={<IconRefresh size={15} />}
                onClick={() => void storagesQuery.refetch()}
                loading={storagesQuery.isFetching && !storagesQuery.isLoading}
              >
                {t('storages.refreshList')}
              </Button>
            }
          />
        )}
      </div>

      {/* ---- 内容浏览 ---- */}
      {selected ? (
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
            <div className="flex items-center gap-8 flex-wrap">
              <IconFolder size={16} />
              <span className="fw-600">
                {t('storages.contentTitle', { storage: selected.storage })}
              </span>
              <Badge variant="neutral" size="sm">
                {selected.node}
              </Badge>
              <Badge variant="neutral" size="sm">
                {selected.type}
              </Badge>
              <span className="fs-sm text-muted">
                {t('storages.avail', { size: formatBytes(selected.avail) })}
              </span>
            </div>

            <div className="flex items-center gap-8 flex-wrap">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('storages.searchPlaceholder')}
                prefix={<IconSearch size={14} />}
                block={false}
                aria-label={t('storages.searchAria')}
              />
              <Select
                value={contentFilter}
                onChange={(e) => setContentFilter(e.target.value)}
                options={CONTENT_FILTERS.map((item) => ({
                  label: t(item.label),
                  value: item.value,
                }))}
                aria-label={t('storages.contentFilterAria')}
              />
              {canManageStorage ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<IconUpload size={14} />}
                  onClick={() => setUploadOpen(true)}
                >
                  {t('storages.upload')}
                </Button>
              ) : null}
              <IconButton label={t('storages.closeContent')} onClick={() => setSelected(null)}>
                <IconClose size={16} />
              </IconButton>
            </div>
          </div>

          {contentNotImpl ? (
            <div style={{ padding: 16 }}>
              <Notice tone="info" title={t('storages.notImplTitle')}>
                {t('storages.contentNotImpl')}
              </Notice>
            </div>
          ) : contentQuery.isLoading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <Table<StorageContent>
              columns={contentColumns}
              rows={filteredContent}
              rowKey={(c) => c.volid}
              caption={t('storages.contentCaption', { storage: selected.storage })}
              emptyTitle={
                contentFilter ? t('storages.contentEmptyFiltered') : t('storages.contentEmpty')
              }
              emptyDescription={
                contentFilter ? (
                  t('storages.contentEmptyFilteredDesc')
                ) : (
                  <>
                    {t('storages.contentEmptyDesc')}
                  </>
                )
              }
              emptyAction={
                /* 有上传权限且不是「筛选筛没了」时才给按钮：
                   筛选态下给「上传」会让用户以为文件丢了，其实只是被筛掉 */
                canManageStorage && !contentFilter ? (
                  <Button
                    variant="primary"
                    icon={<IconUpload size={15} />}
                    onClick={() => setUploadOpen(true)}
                  >
                    {t('storages.uploadFile')}
                  </Button>
                ) : undefined
              }
              className="table-flush"
            />
          )}
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={t('storages.selectTitle')}
            description={t('storages.selectDesc')}
            icon={<IconFolder size={28} />}
          />
        </Card>
      )}

      {/* ---- 上传 ISO ---- */}
      <UploadDialog
        open={uploadOpen}
        storage={selected}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          invalidate();
          if (selected) void contentQuery.refetch();
          setUploadOpen(false);
        }}
      />

      {/* ---- 删除内容 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget || !selected) return;
          setBusy(true);
          try {
            // 备份卷分流到备份专用接口（vm.backup + 归属校验）；ISO/磁盘等
            // 其它内容仍走通用卷删除（storage.manage）。
            const isBackup =
              deleteTarget.content === 'backup' ||
              deleteTarget.volid.includes('vzdump');
            await runner.run(
              isBackup
                ? backupsApi.remove({
                    node: selected.node,
                    storage: selected.storage,
                    volid: deleteTarget.volid,
                  })
                : storagesApi.deleteContent({
                    node: selected.node,
                    storage: selected.storage,
                    volid: deleteTarget.volid,
                  }),
              {
                title: t('storages.deleteTask', { volid: deleteTarget.volid }),
                node: selected.node,
                invalidate: [
                  ['storages'],
                  ['storages', 'content', selected.node, selected.storage],
                ],
                destructive: true,
              },
            );
            setDeleteTarget(null);
            invalidate();
            void contentQuery.refetch();
          } finally {
            setBusy(false);
          }
        }}
        title={t('storages.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        message={
          <>
            {t('storages.deleteMessagePre')}<strong>{deleteTarget?.volid}</strong>
            {t('storages.deleteMessageMid', { size: formatBytes(deleteTarget?.size) })}
            {deleteTarget?.vmid
              ? t('storages.deleteMessageVmid', { vmid: deleteTarget.vmid })
              : ''}
          </>
        }
      />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   上传对话框（带进度条，后端未实现时优雅降级）
   --------------------------------------------------------------------------- */

function UploadDialog({
  open,
  storage,
  onClose,
  onUploaded,
}: {
  open: boolean;
  storage: Storage | null;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('iso');
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setProgress(0);
      setUploading(false);
      setUnsupported(false);
      setDragover(false);
    }
  }, [open]);

  /* ISO 存储池默认选 iso */
  useEffect(() => {
    if (storage) {
      const types = storage.content.split(/[,;]/).map((c) => c.trim());
      if (types.includes('iso') && !types.includes('images')) setContent('iso');
      else if (types.includes('images')) setContent('vm');
    }
  }, [storage]);

  const availableContents = useMemo(() => {
    if (!storage)
      return CONTENT_FILTERS.filter((c) => c.value).map((c) => ({
        label: t(c.label),
        value: c.value,
      }));
    const types = storage.content.split(/[,;]/).map((c) => c.trim());
    const options = [
      { label: t('storages.contentIso'), value: 'iso', key: 'iso' },
      { label: t('storages.contentVm'), value: 'vm', key: 'images' },
      { label: t('storages.contentSnippets'), value: 'snippets', key: 'snippets' },
    ];
    const filtered = options.filter((o) => types.includes(o.key));
    return filtered.length > 0
      ? filtered.map((o) => ({ label: o.label, value: o.value }))
      : options.map((o) => ({ label: o.label, value: o.value }));
  }, [storage, t]);

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (f.size === 0) {
      toast.error(t('storages.fileInvalid'), t('storages.fileEmpty'));
      return;
    }
    setFile(f);
    setProgress(0);
  };

  const doUpload = async () => {
    if (!file || !storage) return;
    setUploading(true);
    setProgress(0);
    setUnsupported(false);

    try {
      await storagesApi.upload(
        { node: storage.node, storage: storage.storage, content },
        file,
        (p) => setProgress(p),
      );
      toast.success(
        t('storages.uploadOk'),
        t('storages.uploadOkDetail', { name: file.name, storage: storage.storage }),
      );
      onUploaded();
    } catch (err) {
      const notImpl = isNotImplemented(err);
      if (notImpl) {
        setUnsupported(true);
        toast.warning(t('storages.featureUnavailable'), t('storages.uploadNotImpl'));
      } else {
        toast.error(t('storages.uploadFailed'), errorMessage(err));
      }
    } finally {
      setUploading(false);
    }
  };

  const canUpload = Boolean(file) && Boolean(storage) && !uploading;

  return (
    <Modal
      open={open}
      onClose={uploading ? () => undefined : onClose}
      title={t('storages.uploadTitle')}
      description={
        storage
          ? t('storages.uploadTarget', { storage: storage.storage, node: storage.node })
          : undefined
      }
      size="sm"
      closeOnOverlay={!uploading}
      hideClose={uploading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={doUpload}
            loading={uploading}
            disabled={!canUpload}
          >
            {t('storages.startUpload')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Select
          label={t('storages.contentType')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          options={availableContents}
          disabled={uploading}
          hint={t('storages.contentTypeHint')}
        />

        <div
          className={`upload-zone ${dragover ? 'is-dragover' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragLeave={() => setDragover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragover(false);
            pickFile(e.dataTransfer.files?.[0]);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          aria-label={t('storages.pickFileAria')}
        >
          <IconUpload size={26} />
          <div className="upload-zone-text">
            {file ? (
              <>
                <div className="fw-600 text-primary">{file.name}</div>
                <div className="fs-sm text-muted mt-8">
                  {formatBytes(file.size)}
                </div>
              </>
            ) : (
              <>
                <div>{t('storages.dropHint')}</div>
                <div className="fs-sm text-muted mt-8">
                  {t('storages.dropFormats')}
                </div>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => pickFile(e.target.files?.[0])}
            accept=".iso,.img,.qcow2,.raw,.tar.gz,.tar.zst"
          />
        </div>

        {uploading || progress > 0 ? (
          <div className="upload-progress">
            <ProgressBar
              label={uploading ? t('storages.uploading') : t('storages.completed')}
              value={progress}
              showValue
              height={7}
              color={progress >= 100 ? 'var(--success)' : 'var(--accent)'}
            />
          </div>
        ) : null}

        {unsupported ? (
          <Notice tone="info" title={t('storages.notImplTitle')}>
            {t('storages.uploadNotImplBodyPre')}
            <code>POST /storages/upload</code>
            {t('storages.uploadNotImplBodyMid')}
            <code>/var/lib/vz/template/iso</code>
            {t('storages.uploadNotImplBodyPost')}
          </Notice>
        ) : null}

        {file && file.size > 4 * 1024 ** 3 ? (
          <Notice tone="warning" title={t('storages.largeFileTitle')}>
            {t('storages.largeFileBody')}
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
