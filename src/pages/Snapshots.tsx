/* ==========================================================================
   ProxCenter — 全局快照视图
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lxcApi, vmsApi } from '../api/endpoints';
import { guestPath } from '../api/guests';
import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Notice } from '../components/ui/EmptyState';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
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
   页面
   --------------------------------------------------------------------------- */

export function Snapshots() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runner = useTaskRunner();
  const { hasPermission } = useAuth();
  /* 回滚 / 删除快照按**目标类型**判权限：虚拟机 vm.snapshot、容器 ct.snapshot
     （后端 vms.py / lxc.py 就是两套），不再用「是不是非只读用户」的角色粗判。 */
  const canSnapshotOf = (s: Snapshot) =>
    hasPermission(s.vm_type === 'lxc' ? 'ct.snapshot' : 'vm.snapshot');

  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState('');
  const [rollbackTarget, setRollbackTarget] = useState<Snapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  /* 未配置连接时后端对每个请求都回 428，轮询只会刷一屏没人看的报错
     （配好之后自动恢复） */
  const pveReady = usePveReady();

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


  /* 一次向后端要**全量**快照。原先是「前端按 VM 逐台发请求」（并发 6），
     200 台机器就是 200 个浏览器请求，开两个标签页翻倍，而且每台都要等 PVE
     扫一遍快照元数据。后端 ``/api/snapshots`` 已经把这几件事一起做了：
     服务端并发（上限可配）+ 归属过滤 + 60 秒缓存，且变更路径会主动作废。
     轮询间隔仍跟「设置 → 面板设置 → 数据刷新间隔」走。 */
  const refresh = useRefreshInterval();
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', 'all'],
    queryFn: async () => {
      const rows = await vmsApi.allSnapshots();
      // 后端字段叫 vm_name，页面与列定义里用的是 vmname，这里对齐一次
      return rows.map<Snapshot>((s) => ({ ...s, vmname: s.vmname ?? s.vm_name }));
    },
    enabled: pveReady,
    refetchInterval: pveReady ? refresh : false,
    retry: false,
  });

  /* 过滤 */
  const snapshots = useMemo(() => {
    const all = snapshotsQuery.data ?? [];
    // 节点筛选在聚合结果上做：接口一次给全量，切节点不必重新请求
    const list = nodeFilter ? all.filter((s) => s.node === nodeFilter) : all;
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
  }, [snapshotsQuery.data, search, nodeFilter]);

  /* 快照会越攒越多（每台机器若干条），和其它列表一样分页。
     切片放在上面那份「已过滤 + 已按时间排序」的列表之后，翻到哪一页都是
     最新的排在前面；搜索词一变就回到第 1 页（resetKey）。 */
  const snapPage = usePaged(snapshots, search);

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
                guestPath(
                  { node: s.node, vmid: s.vmid, type: s.vm_type },
                  { tab: 'snapshots' },
                ),
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
            disabled={!canSnapshotOf(s) || busy}
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
            disabled={!canSnapshotOf(s) || busy}
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
        <PveQueryError
          title={t('snapshots.loadErrorTitle')}
          message={t('snapshots.loadErrorMsg')}
          error={snapshotsQuery.error}
          onRetry={() => void snapshotsQuery.refetch()}
        />
      ) : (
        <Table<Snapshot>
          columns={columns}
          rows={snapPage.rows}
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

      {/* 分页条接在表格下沿，成为同一张卡的页脚（见 .pagination 的样式）。
          出错时不出分页 —— 那会儿没有列表可翻 */}
      {!snapshotsQuery.isError ? <PagerBar pager={snapPage} /> : null}

      {/* ---- 回滚确认 ---- */}
      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onCancel={() => setRollbackTarget(null)}
        onConfirm={async () => {
          if (!rollbackTarget?.node || !rollbackTarget.vmid) return;
          setBusy(true);
          try {
            /* 容器与虚拟机是两套端点，按行里的类型分派 */
            const isLxcRow = rollbackTarget.vm_type === 'lxc';
            const api = isLxcRow ? lxcApi : vmsApi;
            await runner.run(
              api.rollbackSnapshot(
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
                  [isLxcRow ? 'lxc' : 'vm', rollbackTarget.node, rollbackTarget.vmid],
                  [isLxcRow ? 'lxc' : 'vms'],
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
            const isLxcRow = deleteTarget.vm_type === 'lxc';
            const api = isLxcRow ? lxcApi : vmsApi;
            await runner.run(
              api.deleteSnapshot(
                deleteTarget.node,
                deleteTarget.vmid,
                deleteTarget.name,
              ),
              {
                title: t('snapshots.taskDelete', { name: deleteTarget.name }),
                node: deleteTarget.node,
                invalidate: [
                  ['snapshots'],
                  [isLxcRow ? 'lxc' : 'vm', deleteTarget.node, deleteTarget.vmid],
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
