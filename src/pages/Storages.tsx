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
import { contentLabel, storageStatusMeta } from '../utils/status';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { Storage, StorageContent } from '../api/types';

const CONTENT_FILTERS = [
  { label: '全部内容', value: '' },
  { label: 'VM 磁盘 (vm)', value: 'vm' },
  { label: 'ISO 镜像 (iso)', value: 'iso' },
  { label: '备份 (backup)', value: 'backup' },
  { label: '代码片段 (snippets)', value: 'snippets' },
];

export function Storages() {
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
      { label: '全部节点', value: '' },
      ...(nodesQuery.data ?? []).map((n) => ({
        label: n.connection_name ? `${n.node}（${n.connection_name}）` : n.node,
        value: n.connection_id ? `${n.connection_id}::${n.node}` : n.node,
      })),
    ],
    [nodesQuery.data],
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
      header: '名称',
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
      header: '类型',
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
      header: '节点',
      render: (s) => <span className="fs-sm mono">{s.node}</span>,
      width: 110,
      sortable: true,
      sortValue: (s) => s.node,
    },
    {
      key: 'content',
      header: '内容类型',
      render: (s) => <span className="fs-sm">{contentLabel(s.content)}</span>,
      width: 200,
    },
    {
      key: 'total',
      header: '总量',
      align: 'right',
      width: 100,
      render: (s) => <span className="mono fs-sm">{formatBytes(s.total)}</span>,
      sortable: true,
      sortValue: (s) => s.total,
    },
    {
      key: 'used',
      header: '已用',
      align: 'right',
      width: 100,
      render: (s) => <span className="mono fs-sm">{formatBytes(s.used)}</span>,
      sortable: true,
      sortValue: (s) => s.used,
    },
    {
      key: 'avail',
      header: '可用',
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
      header: '使用率',
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
      header: '状态',
      width: 100,
      render: (s) => {
        const meta = storageStatusMeta(s.active);
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
      header: '共享',
      width: 80,
      align: 'center',
      render: (s) => (
        <Badge variant={s.shared ? 'info' : 'neutral'} size="sm">
          {s.shared ? '是' : '否'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '操作',
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
            浏览
          </Button>
        </span>
      ),
    },
  ];

  /* 删除卷：要 storage.manage。没有该权限时这一整列都不出现 ——
     与其留一个有表头、每行却什么都没有的「操作」列，不如整列省掉。 */
  const contentActionColumn: Column<StorageContent> = {
    key: 'actions',
    header: '操作',
    width: 80,
    align: 'right',
    render: (c) => (
      <IconButton
        label={`删除 ${c.volid}`}
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
      header: '卷标识 (volid)',
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
      header: '名称',
      render: (c) => (
        <span className="fs-sm text-secondary">{c.name || '—'}</span>
      ),
      width: 180,
    },
    {
      key: 'format',
      header: '格式',
      render: (c) => (
        <Badge variant="neutral" size="sm">
          {c.format || '—'}
        </Badge>
      ),
      width: 100,
    },
    {
      key: 'size',
      header: '大小',
      align: 'right',
      width: 110,
      render: (c) => <span className="mono fs-sm">{formatBytes(c.size)}</span>,
      sortable: true,
      sortValue: (c) => c.size,
    },
    {
      key: 'ctime',
      header: '创建时间',
      render: (c) => (
        <span className="mono fs-sm text-secondary">{formatDateTime(c.ctime)}</span>
      ),
      width: 170,
      sortable: true,
      sortValue: (c) => c.ctime,
    },
    {
      key: 'vmid',
      header: '所属 VM',
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
          存储
        </>
      }
      subtitle={
        storagesQuery.data
          ? `共 ${storages.length} 个存储池 · 总容量 ${formatBytes(
              storages.reduce((s, x) => s + x.total, 0),
            )}`
          : '正在加载…'
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
            刷新
          </Button>
          {/* 只有能管理存储的人才看到上传入口：普通用户只有 storage.view，
              给了按钮也是点了必 403 */}
          {canManageStorage ? (
            <Button
              variant="primary"
              icon={<IconUpload size={15} />}
              onClick={() => {
                if (!selected) {
                  toast.info('请先选择存储池', '在下方表格中点击「浏览」选定目标存储');
                  return;
                }
                setUploadOpen(true);
              }}
            >
              上传 ISO
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
              aria-label="按节点筛选存储"
            />
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              {storages.filter((s) => s.active).length} / {storages.length} 已激活
            </span>
          </div>
        </div>

        {storagesQuery.isError ? (
          <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            <ErrorState
              title="无法加载存储列表"
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
            caption="集群存储池列表，包含类型、容量与使用率"
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
            emptyTitle="暂无存储"
            emptyDescription={
              <>
                当前还没有配置任何存储池。存储池要在 Proxmox VE 侧添加
                （<code className="mono">数据中心 → 存储 → 添加</code>
                ），加好后回到这里刷新即可看到。
              </>
            }
            emptyAction={
              <Button
                variant="secondary"
                icon={<IconRefresh size={15} />}
                onClick={() => void storagesQuery.refetch()}
                loading={storagesQuery.isFetching && !storagesQuery.isLoading}
              >
                刷新列表
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
                内容浏览 · {selected.storage}
              </span>
              <Badge variant="neutral" size="sm">
                {selected.node}
              </Badge>
              <Badge variant="neutral" size="sm">
                {selected.type}
              </Badge>
              <span className="fs-sm text-muted">
                可用 {formatBytes(selected.avail)}
              </span>
            </div>

            <div className="flex items-center gap-8 flex-wrap">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 volid / 名称…"
                prefix={<IconSearch size={14} />}
                block={false}
                aria-label="搜索存储内容"
              />
              <Select
                value={contentFilter}
                onChange={(e) => setContentFilter(e.target.value)}
                options={CONTENT_FILTERS}
                aria-label="按内容类型筛选"
              />
              {canManageStorage ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<IconUpload size={14} />}
                  onClick={() => setUploadOpen(true)}
                >
                  上传
                </Button>
              ) : null}
              <IconButton label="关闭内容浏览" onClick={() => setSelected(null)}>
                <IconClose size={16} />
              </IconButton>
            </div>
          </div>

          {contentNotImpl ? (
            <div style={{ padding: 16 }}>
              <Notice tone="info" title="该功能需要后端支持">
                /storages/content 接口尚未实现，无法浏览存储内容。
              </Notice>
            </div>
          ) : contentQuery.isLoading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <Table<StorageContent>
              columns={contentColumns}
              rows={filteredContent}
              rowKey={(c) => c.volid}
              caption={`存储 ${selected.storage} 的内容列表`}
              emptyTitle={contentFilter ? '该类型下暂无内容' : '暂无内容'}
              emptyDescription={
                contentFilter ? (
                  '该类型下没有文件，试试把「内容类型」切回全部。'
                ) : (
                  <>
                    这个存储池还是空的。可以直接上传 ISO / 镜像，或在创建虚拟机时
                    把磁盘建在这里。
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
                    上传文件
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
            title="选择存储池以浏览内容"
            description="点击上方表格中的任意存储行，即可查看其中的磁盘镜像、ISO 与备份文件。"
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
                title: `删除 ${deleteTarget.volid}`,
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
        title="删除存储内容"
        danger
        confirmText="删除"
        loading={busy}
        message={
          <>
            即将删除 <strong>{deleteTarget?.volid}</strong>
            （{formatBytes(deleteTarget?.size)}）。
            {deleteTarget?.vmid
              ? `该卷属于虚拟机 ${deleteTarget.vmid}，删除后该虚拟机可能无法启动。`
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
    if (!storage) return CONTENT_FILTERS.filter((c) => c.value);
    const types = storage.content.split(/[,;]/).map((c) => c.trim());
    const options = [
      { label: 'ISO 镜像 (iso)', value: 'iso', key: 'iso' },
      { label: 'VM 磁盘 (vm)', value: 'vm', key: 'images' },
      { label: '代码片段 (snippets)', value: 'snippets', key: 'snippets' },
    ];
    const filtered = options.filter((o) => types.includes(o.key));
    return filtered.length > 0
      ? filtered.map((o) => ({ label: o.label, value: o.value }))
      : options.map((o) => ({ label: o.label, value: o.value }));
  }, [storage]);

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (f.size === 0) {
      toast.error('文件无效', '该文件为空');
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
      toast.success('上传成功', `${file.name} 已上传到 ${storage.storage}`);
      onUploaded();
    } catch (err) {
      const notImpl = isNotImplemented(err);
      if (notImpl) {
        setUnsupported(true);
        toast.warning('功能暂不可用', '后端尚未实现文件上传接口');
      } else {
        toast.error('上传失败', errorMessage(err));
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
      title="上传文件"
      description={
        storage ? `目标存储：${storage.storage}（${storage.node}）` : undefined
      }
      size="sm"
      closeOnOverlay={!uploading}
      hideClose={uploading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={doUpload}
            loading={uploading}
            disabled={!canUpload}
          >
            开始上传
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-16">
        <Select
          label="内容类型"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          options={availableContents}
          disabled={uploading}
          hint="决定文件存放的目录（iso 目录用于安装镜像）"
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
          aria-label="选择要上传的文件"
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
                <div>点击选择文件，或将文件拖拽到此处</div>
                <div className="fs-sm text-muted mt-8">
                  支持 .iso / .img / .qcow2 等格式
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
              label={uploading ? '上传中' : '已完成'}
              value={progress}
              showValue
              height={7}
              color={progress >= 100 ? 'var(--success)' : 'var(--accent)'}
            />
          </div>
        ) : null}

        {unsupported ? (
          <Notice tone="info" title="该功能需要后端支持">
            后端尚未实现 <code>POST /storages/upload</code>
            接口。你可以先在 Proxmox 节点的对应目录（如{' '}
            <code>/var/lib/vz/template/iso</code>）中用 wget 下载镜像，再回到此处浏览。
          </Notice>
        ) : null}

        {file && file.size > 4 * 1024 ** 3 ? (
          <Notice tone="warning" title="大文件提示">
            超过 4GB 的上传可能受后端超时或反向代理（Nginx
            client_max_body_size）限制，建议使用 Proxmox 自带的下载任务或直接在节点上下载。
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
