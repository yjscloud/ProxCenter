/* ==========================================================================
   ProxCenter — 全局快照视图
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { vmsApi } from '../api/endpoints';
import { guestPath } from '../api/guests';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { ErrorState, Notice } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  IconSnapshot,
  IconRefresh,
  IconTrash,
  IconSearch,
  IconRestart,
} from '../components/Icons';
import { formatDateTime, formatRelative } from '../utils/format';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import type { Snapshot } from '../api/types';

/* ---------------------------------------------------------------------------
   带并发限制的批量请求
   --------------------------------------------------------------------------- */

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Snapshots() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const { canWrite } = useAuth();

  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState('');
  const [rollbackTarget, setRollbackTarget] = useState<Snapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  /* 虚拟机列表 */
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    staleTime: 30_000,
  });

  const vms = useMemo(() => vmsQuery.data ?? [], [vmsQuery.data]);

  const nodeOptions = useMemo(() => {
    const set = new Set(vms.map((v) => v.node));
    return [
      { label: t('snapshots.allNodes'), value: '' },
      ...[...set].sort().map((n) => ({ label: n, value: n })),
    ];
  }, [vms]);

  const targetVms = useMemo(
    () => (nodeFilter ? vms.filter((v) => v.node === nodeFilter) : vms),
    [vms, nodeFilter],
  );

  /* 并发拉取各 VM 快照（限制 6 并发） */
  const snapshotsQuery = useQuery({
    queryKey: [
      'snapshots',
      'all',
      targetVms.map((v) => `${v.node}/${v.vmid}`).join(','),
    ],
    queryFn: async () => {
      const results = await mapWithConcurrency(targetVms, 6, async (vm) => {
        try {
          const list = await vmsApi.snapshots(vm.node, vm.vmid);
          return list
            .filter((s) => s.name !== 'current')
            .map<Snapshot>((s) => ({
              ...s,
              vmid: vm.vmid,
              node: vm.node,
              vmname: vm.name,
            }));
        } catch {
          /* 单个 VM 失败不影响整体 */
          return [] as Snapshot[];
        }
      });
      return results.flat();
    },
    enabled: targetVms.length > 0,
    refetchInterval: 60_000,
    retry: false,
  });

  /* 过滤 */
  const snapshots = useMemo(() => {
    const list = snapshotsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.description ?? '').toLowerCase().includes(q) ||
            (s.vmname ?? '').toLowerCase().includes(q) ||
            String(s.vmid ?? '').includes(q),
        )
      : list;

    return [...filtered].sort(
      (a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0),
    );
  }, [snapshotsQuery.data, search]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['snapshots'] });
    void queryClient.invalidateQueries({ queryKey: ['vms'] });
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<Snapshot>> = [
    {
      key: 'vm',
      header: t('common.vm'),
      render: (s) => (
        <button
          type="button"
          className="link-button"
          onClick={(e) => {
            e.stopPropagation();
            if (s.node && s.vmid) {
              // 容器快照要跳到容器页：虚拟机页拿不到 /lxc 的配置
              navigate(
                `${guestPath({ node: s.node, vmid: s.vmid, type: s.vm_type })}?tab=snapshots`,
              );
            }
          }}
        >
          <span className="fw-500">{s.vmname || `VM ${s.vmid}`}</span>
          <span className="fs-xs text-muted mono">
            {s.vmid} @ {s.node}
          </span>
        </button>
      ),
      sortable: true,
      sortValue: (s) => s.vmname ?? '',
    },
    {
      key: 'name',
      header: t('snapshots.colName'),
      render: (s) => <span className="mono fw-500">{s.name}</span>,
      sortable: true,
      sortValue: (s) => s.name,
    },
    {
      key: 'description',
      header: t('common.description'),
      render: (s) => (
        <span className="fs-sm text-secondary truncate" title={s.description}>
          {s.description || '—'}
        </span>
      ),
    },
    {
      key: 'snaptime',
      header: t('common.createdAt'),
      render: (s) => (
        <div className="flex flex-col">
          <span className="mono fs-sm">{formatDateTime(s.snaptime)}</span>
          <span className="fs-xs text-muted">{formatRelative(s.snaptime)}</span>
        </div>
      ),
      width: 180,
      sortable: true,
      sortValue: (s) => s.snaptime ?? 0,
    },
    {
      key: 'vmstate',
      header: t('snapshots.colVmstate'),
      width: 90,
      align: 'center',
      render: (s) => (
        <Badge variant={s.vmstate ? 'info' : 'neutral'} size="sm">
          {s.vmstate ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'parent',
      header: t('snapshots.colParent'),
      render: (s) => (
        <span className="mono fs-sm text-muted">{s.parent || '—'}</span>
      ),
      width: 140,
    },
    {
      key: 'owner',
      header: t('common.owner'),
      width: 90,
      render: (s) => <span className="fs-sm text-secondary">{s.owner || '—'}</span>,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 160,
      align: 'right',
      render: (s) => (
        <span className="row-actions">
          <IconButton
            label={t('snapshots.rollbackLabel', { name: s.name })}
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              setRollbackTarget(s);
            }}
            disabled={!canWrite || busy}
          >
            <IconRestart size={15} />
          </IconButton>
          <IconButton
            label={t('snapshots.deleteLabel', { name: s.name })}
            variant="danger"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(s);
            }}
            disabled={!canWrite || busy}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  /* 统计 */
  const stats = useMemo(() => {
    const list = snapshotsQuery.data ?? [];
    const withState = list.filter((s) => s.vmstate).length;
    const vmsWithSnapshots = new Set(list.map((s) => `${s.node}/${s.vmid}`)).size;
    return { total: list.length, withState, vmsWithSnapshots };
  }, [snapshotsQuery.data]);

  return (
    <PageShell
      title={
        <>
          <IconSnapshot size={20} />
          {t('snapshots.title')}
        </>
      }
      subtitle={
        snapshotsQuery.isLoading
          ? t('snapshots.subtitle.loading')
          : t('snapshots.subtitle.summary', {
              total: stats.total,
              vms: stats.vmsWithSnapshots,
            })
      }
      actions={
        <Button
          variant="secondary"
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void vmsQuery.refetch();
            void snapshotsQuery.refetch();
          }}
          loading={snapshotsQuery.isFetching && !snapshotsQuery.isLoading}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      <Notice tone="info" title={t('snapshots.noticeTitle')}>
        {t('snapshots.noticeBody')}
      </Notice>

      {/* 统计卡片 */}
      <div className="grid grid-3">
        <Card>
          <div className="kpi-label">{t('snapshots.kpi.total')}</div>
          <div className="kpi-value">{stats.total}</div>
        </Card>
        <Card>
          <div className="kpi-label">{t('snapshots.kpi.withState')}</div>
          <div className="kpi-value">{stats.withState}</div>
        </Card>
        <Card>
          <div className="kpi-label">{t('snapshots.kpi.vms')}</div>
          <div className="kpi-value">{stats.vmsWithSnapshots}</div>
        </Card>
      </div>

      {/* 筛选 */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('snapshots.searchPlaceholder')}
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label={t('snapshots.searchAria')}
          />
          <Select
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            options={nodeOptions}
            aria-label={t('snapshots.filterNodeAria')}
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            {t('common.showing', { n: snapshots.length })}
          </span>
        </div>
      </div>

      {snapshotsQuery.isError ? (
        <ErrorState
          title={t('snapshots.loadErrorTitle')}
          message={t('snapshots.loadErrorMsg')}
          onRetry={() => void snapshotsQuery.refetch()}
        />
      ) : (
        <Table<Snapshot>
          columns={columns}
          rows={snapshots}
          rowKey={(s) => `${s.node}/${s.vmid}/${s.name}`}
          loading={snapshotsQuery.isLoading}
          caption={t('snapshots.caption')}
          emptyTitle={search ? t('snapshots.emptyNoMatch') : t('snapshots.emptyNone')}
          emptyDescription={
            search
              ? t('snapshots.emptyAdjust')
              : vms.length === 0
                ? t('snapshots.emptyNoVms')
                : t('snapshots.emptyHint')
          }
          emptyAction={
            !search && vms.length > 0 ? (
              <Button variant="primary" onClick={() => navigate('/vms')}>
                {t('snapshots.goToVms')}
              </Button>
            ) : undefined
          }
        />
      )}

      {/* ---- 回滚确认 ---- */}
      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={async () => {
          if (!rollbackTarget?.node || !rollbackTarget.vmid) return;
          setBusy(true);
          try {
            await runner.run(
              vmsApi.rollbackSnapshot(
                rollbackTarget.node,
                rollbackTarget.vmid,
                rollbackTarget.name,
              ),
              {
                title: t('snapshots.taskRollback', {
                  vm: rollbackTarget.vmname || rollbackTarget.vmid,
                  name: rollbackTarget.name,
                }),
                node: rollbackTarget.node,
                invalidate: [
                  ['snapshots'],
                  ['vm', rollbackTarget.node, rollbackTarget.vmid],
                  ['vms'],
                ],
                destructive: true,
              },
            );
            setRollbackTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('snapshots.rollbackTitle')}
        confirmText={t('snapshots.rollbackConfirm')}
        loading={busy}
        requireText={rollbackTarget?.name}
        message={t('snapshots.rollbackMessage', {
          vm: rollbackTarget?.vmname || rollbackTarget?.vmid || '',
          name: rollbackTarget?.name || '',
          time: formatDateTime(rollbackTarget?.snaptime),
        })}
      />

      {/* ---- 删除确认 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget?.node || !deleteTarget.vmid) return;
          setBusy(true);
          try {
            await runner.run(
              vmsApi.deleteSnapshot(
                deleteTarget.node,
                deleteTarget.vmid,
                deleteTarget.name,
              ),
              {
                title: t('snapshots.taskDelete', { name: deleteTarget.name }),
                node: deleteTarget.node,
                invalidate: [
                  ['snapshots'],
                  ['vm', deleteTarget.node, deleteTarget.vmid],
                ],
                destructive: true,
              },
            );
            setDeleteTarget(null);
            invalidate();
          } finally {
            setBusy(false);
          }
        }}
        title={t('snapshots.deleteTitle')}
        danger
        confirmText={t('common.delete')}
        loading={busy}
        message={t('snapshots.deleteMessage', {
          vm: deleteTarget?.vmname || deleteTarget?.vmid || '',
          name: deleteTarget?.name || '',
        })}
      />

    </PageShell>
  );
}
