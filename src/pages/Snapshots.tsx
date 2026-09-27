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
      { label: '全部节点', value: '' },
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
      header: '虚拟机',
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
      header: '快照名称',
      render: (s) => <span className="mono fw-500">{s.name}</span>,
      sortable: true,
      sortValue: (s) => s.name,
    },
    {
      key: 'description',
      header: '描述',
      render: (s) => (
        <span className="fs-sm text-secondary truncate" title={s.description}>
          {s.description || '—'}
        </span>
      ),
    },
    {
      key: 'snaptime',
      header: '创建时间',
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
      header: '含内存',
      width: 90,
      align: 'center',
      render: (s) => (
        <Badge variant={s.vmstate ? 'info' : 'neutral'} size="sm">
          {s.vmstate ? '是' : '否'}
        </Badge>
      ),
    },
    {
      key: 'parent',
      header: '父快照',
      render: (s) => (
        <span className="mono fs-sm text-muted">{s.parent || '—'}</span>
      ),
      width: 140,
    },
    {
      key: 'owner',
      header: '创建者',
      width: 90,
      render: (s) => <span className="fs-sm text-secondary">{s.owner || '—'}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      width: 160,
      align: 'right',
      render: (s) => (
        <span className="row-actions">
          <IconButton
            label={`回滚到快照 ${s.name}`}
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
            label={`删除快照 ${s.name}`}
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
          快照
        </>
      }
      subtitle={
        snapshotsQuery.isLoading
          ? '正在扫描各虚拟机的快照…'
          : `共 ${stats.total} 个快照 · 覆盖 ${stats.vmsWithSnapshots} 台虚拟机`
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
          刷新
        </Button>
      }
    >
      <Notice tone="info" title="聚合视图说明">
        本页汇总集群中所有虚拟机的快照，数据通过并发遍历各虚拟机获得，因此加载可能稍慢。
        回滚与删除操作会直接作用于对应虚拟机。
        按用户隔离：普通用户只显示自己创建的快照，管理员可见全部。
      </Notice>

      {/* 统计卡片 */}
      <div className="grid grid-3">
        <Card>
          <div className="kpi-label">快照总数</div>
          <div className="kpi-value">{stats.total}</div>
        </Card>
        <Card>
          <div className="kpi-label">包含内存状态</div>
          <div className="kpi-value">{stats.withState}</div>
        </Card>
        <Card>
          <div className="kpi-label">涉及虚拟机</div>
          <div className="kpi-value">{stats.vmsWithSnapshots}</div>
        </Card>
      </div>

      {/* 筛选 */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索快照名、虚拟机名、VMID…"
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label="搜索快照"
          />
          <Select
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            options={nodeOptions}
            aria-label="按节点筛选"
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            显示 {snapshots.length} 个
          </span>
        </div>
      </div>

      {snapshotsQuery.isError ? (
        <ErrorState
          title="无法加载快照数据"
          message="请求各虚拟机快照时出错，请稍后重试。"
          onRetry={() => void snapshotsQuery.refetch()}
        />
      ) : (
        <Table<Snapshot>
          columns={columns}
          rows={snapshots}
          rowKey={(s) => `${s.node}/${s.vmid}/${s.name}`}
          loading={snapshotsQuery.isLoading}
          caption="集群所有虚拟机的快照列表"
          emptyTitle={search ? '没有匹配的快照' : '暂无快照'}
          emptyDescription={
            search
              ? '尝试调整搜索关键词。'
              : vms.length === 0
                ? '集群中还没有虚拟机。'
                : '集群中还没有任何虚拟机快照。快照可在虚拟机详情页创建。'
          }
          emptyAction={
            !search && vms.length > 0 ? (
              <Button variant="primary" onClick={() => navigate('/vms')}>
                前往虚拟机列表
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
                title: `回滚「${rollbackTarget.vmname || rollbackTarget.vmid}」到 ${rollbackTarget.name}`,
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
        title="回滚快照"
        confirmText="执行回滚"
        loading={busy}
        requireText={rollbackTarget?.name}
        message={
          <>
            即将把 <strong>{rollbackTarget?.vmname || rollbackTarget?.vmid}</strong>{' '}
            回滚到快照 <strong>{rollbackTarget?.name}</strong>（
            {formatDateTime(rollbackTarget?.snaptime)}）。
            该快照之后的所有变更都会丢失。
          </>
        }
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
                title: `删除快照「${deleteTarget.name}」`,
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
        title="删除快照"
        danger
        confirmText="删除"
        loading={busy}
        message={
          <>
            即将删除 <strong>{deleteTarget?.vmname || deleteTarget?.vmid}</strong> 的快照{' '}
            <strong>{deleteTarget?.name}</strong>。删除后无法再回滚到该时间点。
          </>
        }
      />

    </PageShell>
  );
}
