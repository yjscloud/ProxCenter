/* ==========================================================================
   ProxCenter — 任务队列
   任务列表 + 侧滑日志面板（WebSocket 实时追加 + HTTP 回填）
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clusterApi, exportUrl, tasksApi } from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select, Switch } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { Drawer } from '../components/ui/Modal';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  IconTasks,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconStop,
  IconEye,
  IconClock,
  IconActivity,
  IconCheck,
  IconAlert,
  IconCopy,
  IconDownload,
} from '../components/Icons';
import {
  formatDateTime,
  formatRelative,
  formatUptime,
} from '../utils/format';
import { taskStatusMeta, isTaskSuccess } from '../utils/status'
import { useT, type MessageKey, type TFunc } from '../i18n';
import { useWebSocket, type WsStatus } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { TaskInfo, TaskLogLine, TaskWsMessage } from '../api/types';

/* ---------------------------------------------------------------------------
   常量
   --------------------------------------------------------------------------- */

const STATUS_FILTERS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'tasks.statusAll', value: '' },
  { label: 'status.task.running', value: 'running' },
  { label: 'status.audit.success', value: 'ok' },
  { label: 'status.audit.failed', value: 'failed' },
];

const WS_LABEL: Record<
  WsStatus,
  { text: MessageKey; variant: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  open: { text: 'tasks.wsOpen', variant: 'success' },
  connecting: { text: 'tasks.wsConnecting', variant: 'warning' },
  closed: { text: 'tasks.wsClosed', variant: 'neutral' },
  error: { text: 'tasks.wsError', variant: 'danger' },
};

/* 任务列表默认每页行数。后端一次给 300 条，全量渲染会让滚动明显发涩，
   所以前端分页；具体条数由列表底部的「每页 N 条」下拉决定（见 usePaged）。 */
const DEFAULT_PAGE_SIZE = 20;

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Tasks() {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canWrite } = useAuth();

  const [nodeFilter, setNodeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  /* 实时日志 Map：upid → 增量行 */
  const [liveLogs, setLiveLogs] = useState<Record<string, string[]>>({});

  const [drawerTask, setDrawerTask] = useState<TaskInfo | null>(null);
  const [stopTarget, setStopTarget] = useState<TaskInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---- 任务列表 ---- */
  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', nodeFilter],
    queryFn: () => clusterApi.tasks({ node: nodeFilter || undefined, limit: 300 }),
    refetchInterval: autoRefresh ? 5_000 : false,
    staleTime: 2_000,
  });

  /* 集群状态（节点名来自它的 .nodes）。
     键必须是 ['cluster','status']：Nodes / Settings / Dashboard 都用这个键，
     写成 ['nodes'] 会和那 12 处 nodesApi.list 的**节点数组**撞在同一个缓存条目上 ——
     谁先取到就把形状写进缓存，另一边按另一种形状去读就炸
     （表现是 Guests 等页报「xxx.data.map is not a function」）。 */
  const clusterQuery = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: () => clusterApi.status(),
    staleTime: 30_000,
  });

  /* ---- WebSocket 实时日志 ---- */
  const handleWsMessage = useCallback((msg: TaskWsMessage) => {
    if (!msg.log) return;
    setLiveLogs((prev) => {
      const lines = prev[msg.upid] ?? [];
      // 同一条日志可能重复推送，做一次去重
      if (lines[lines.length - 1] === msg.log) return prev;
      const next = [...lines, msg.log as string];
      // 每个任务最多缓存 2000 行，避免内存膨胀
      return { ...prev, [msg.upid]: next.length > 2000 ? next.slice(-2000) : next };
    });
  }, []);

  const { status: wsStatus, reconnect } = useWebSocket({
    onMessage: handleWsMessage,
  });

  const nodeOptions = useMemo(() => {
    const names = (clusterQuery.data?.nodes ?? []).map((n) => n.name);
    return [
      { label: t('common.allNodes'), value: '' },
      ...names.sort().map((name) => ({ label: name, value: name })),
    ];
  }, [clusterQuery.data, t]);

  /* ---- 过滤 ---- */
  const tasks = useMemo(() => {
    const list = tasksQuery.data ?? [];
    const q = search.trim().toLowerCase();

    return list.filter((t) => {
      if (statusFilter === 'running' && t.status !== 'running') return false;
      if (statusFilter === 'ok' && !isTaskSuccess(t)) return false;
      if (
        statusFilter === 'failed' &&
        !(t.status === 'stopped' && t.exitstatus !== 'OK')
      ) {
        return false;
      }
      if (!q) return true;
      return (
        t.upid.toLowerCase().includes(q) ||
        (t.type ?? '').toLowerCase().includes(q) ||
        (t.user ?? '').toLowerCase().includes(q) ||
        (t.id ?? '').toLowerCase().includes(q) ||
        t.node.toLowerCase().includes(q)
      );
    });
  }, [tasksQuery.data, statusFilter, search]);

  /* ---- 分页 ----
     一次拉 300 条全铺在页面上，浏览器要渲染几千个单元格，滚动明显发涩，而且
     一路滚到底也找不到「最新一条在哪」。这里交给统一的分页 hook：
     它管页码越界夹取、筛选条件变化回第一页，并提供「每页 N 条」下拉。
     筛选条件作为 resetKey —— 换了条件还停在第 7 页只会看到一张空表。 */
  const pager = usePaged(
    tasks,
    `${nodeFilter}|${statusFilter}|${search}`,
    DEFAULT_PAGE_SIZE,
  );
  const pageTasks = pager.rows;

  const stats = useMemo(() => {
    const list = tasksQuery.data ?? [];
    const running = list.filter((t) => t.status === 'running').length;
    const success = list.filter((t) => isTaskSuccess(t)).length;
    const failed = list.filter(
      (t) => t.status === 'stopped' && t.exitstatus !== 'OK',
    ).length;
    return { total: list.length, running, success, failed };
  }, [tasksQuery.data]);

  /* ---- 操作 ---- */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cluster', 'tasks'] });
  };

  const copyUpid = async (upid: string) => {
    try {
      await navigator.clipboard.writeText(upid);
      toast.success(t('tasks.copiedUpid'));
    } catch {
      toast.error(t('common.copyFailed'), t('common.clipboardDenied'));
    }
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: t('tasks.colType'),
      render: (task) => (
        <div className="vm-name-cell">
          <span className="fw-500">{taskTypeLabel(task.type, t)}</span>
          <span className="fs-xs text-muted mono" title={task.upid}>
            {task.upid.slice(0, 26)}…
          </span>
        </div>
      ),
    },
    {
      key: 'node',
      header: t('common.node'),
      width: 110,
      render: (task) => (
        <div className="vm-name-cell">
          <span className="fs-sm">{task.node}</span>
          {task.id ? <span className="fs-xs text-muted">{task.id}</span> : null}
        </div>
      ),
    },
    {
      key: 'user',
      header: t('tasks.colUser'),
      width: 130,
      render: (task) => <span className="fs-sm text-secondary">{task.user || '—'}</span>,
    },
    {
      key: 'status',
      header: t('common.status'),
      width: 120,
      render: (task) => {
        const meta = taskStatusMeta(task.status, task.exitstatus, t);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (task) => task.status ?? '',
    },
    {
      key: 'starttime',
      header: t('tasks.colStart'),
      width: 180,
      render: (task) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{formatDateTime(task.starttime)}</span>
          <span className="fs-xs text-muted">{formatRelative(task.starttime)}</span>
        </div>
      ),
      sortable: true,
      sortValue: (task) => task.starttime ?? 0,
    },
    {
      key: 'duration',
      header: t('tasks.colDuration'),
      width: 100,
      align: 'right',
      render: (task) => (
        <span className="mono fs-sm">
          {task.status === 'running'
            ? t('tasks.inProgress')
            : task.starttime && task.endtime
              ? formatUptime(task.endtime - task.starttime)
              : '—'}
        </span>
      ),
      sortable: true,
      sortValue: (task) =>
        task.starttime && task.endtime ? task.endtime - task.starttime : 0,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 130,
      align: 'right',
      render: (task) => (
        <span className="row-actions">
          <IconButton
            label={t('tasks.viewLog', { upid: task.upid })}
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              setDrawerTask(task);
            }}
          >
            <IconEye size={15} />
          </IconButton>
          <IconButton
            label={t('tasks.copyUpid')}
            onClick={(e) => {
              e.stopPropagation();
              void copyUpid(task.upid);
            }}
          >
            <IconCopy size={15} />
          </IconButton>
          {task.status === 'running' ? (
            <IconButton
              label={t('tasks.stopTaskLabel', { upid: task.upid })}
              variant="danger"
              disabled={!canWrite}
              onClick={(e) => {
                e.stopPropagation();
                setStopTarget(task);
              }}
            >
              <IconStop size={15} />
            </IconButton>
          ) : (
            <IconButton
              label={t('tasks.clearTaskLabel')}
              variant="danger"
              disabled={!canWrite}
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(task);
              }}
            >
              <IconTrash size={15} />
            </IconButton>
          )}
        </span>
      ),
    },
  ];

  const wsMeta = WS_LABEL[wsStatus];

  return (
    <PageShell
      title={
        <>
          <IconTasks size={20} />
          {t('tasks.title')}
        </>
      }
      subtitle={t('tasks.subtitle')}
      actions={
        <>
          <Badge variant={wsMeta.variant} dot pulse={wsStatus === 'open'} size="sm">
            {t(wsMeta.text)}
          </Badge>
          {wsStatus !== 'open' ? (
            <Button variant="ghost" size="sm" onClick={reconnect}>
              {t('tasks.reconnect')}
            </Button>
          ) : null}
          {/* 导出走服务端流式 CSV：本页只加载最近 300 条，导出则按筛选条件取
              每台 PVE 的完整任务日志（后端上限 1000 条/台），适合复盘与归档 */}
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={() => window.open(exportUrl('tasks', { node: nodeFilter || undefined }), '_blank')}
            title={t('tasks.exportTitle')}
          >
            {t('tasks.export')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => invalidate()}
            loading={tasksQuery.isFetching && !tasksQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {/* 统计 */}
      <div className="grid grid-4">
        <KpiCard
          label={t('tasks.kpi.total')}
          value={stats.total}
          icon={<IconActivity size={18} />}
          tone="accent"
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label={t('tasks.kpi.running')}
          value={stats.running}
          icon={<IconClock size={18} />}
          tone={stats.running > 0 ? 'warning' : 'neutral'}
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label={t('tasks.kpi.success')}
          value={stats.success}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label={t('tasks.kpi.failed')}
          value={stats.failed}
          icon={<IconAlert size={18} />}
          tone={stats.failed > 0 ? 'danger' : 'neutral'}
          loading={tasksQuery.isLoading}
        />
      </div>

      {wsStatus === 'error' ? (
        <Notice tone="warning" title={t('tasks.wsNoticeTitle')}>
          {t('tasks.wsNoticePre')}<span className="mono">/api/ws/tasks</span>
          {t('tasks.wsNoticePost')}
        </Notice>
      ) : null}

      {/* 筛选 */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label={t('tasks.searchAria')}
          />
          <Select
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            options={nodeOptions}
            aria-label={t('tasks.filterNodeAria')}
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={STATUS_FILTERS.map((s) => ({ label: t(s.label), value: s.value }))}
            aria-label={t('tasks.filterStatusAria')}
          />
        </div>
        <div className="toolbar-right">
          <Switch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label={t('tasks.autoRefresh')}
          />
          <span className="fs-sm text-muted">{t('tasks.showing', { n: tasks.length })}</span>
        </div>
      </div>

      {tasksQuery.isError && isNotImplemented(tasksQuery.error) ? (
        <ErrorState
          notImplemented
          title={t('tasks.notImplTitle')}
          message={t('tasks.notImplMsg')}
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : tasksQuery.isError ? (
        <ErrorState
          title={t('tasks.loadFailed')}
          message={errorMessage(tasksQuery.error)}
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : (
        <>
          <Table<TaskInfo>
            columns={columns}
            rows={pageTasks}
            rowKey={(task) => `${task.node}/${task.upid}`}
            loading={tasksQuery.isLoading}
            caption={t('tasks.caption')}
            emptyTitle={
              search || statusFilter ? t('tasks.emptyMatch') : t('tasks.emptyNone')
            }
            emptyDescription={
              search || statusFilter
                ? t('tasks.emptyMatchDesc')
                : t('tasks.emptyNoneDesc')
            }
            onRowClick={(task) => setDrawerTask(task)}
            rowTitle={(task) => task.upid}
          />

          {/* 分页条：左侧是「每页 N 条」下拉与「第 X-Y 条，共 N 条」，
              右侧是翻页与「跳至 _ 页」——任务多时不用一路滚 */}
          <PagerBar pager={pager} />
        </>
      )}

      {/* ---- 日志抽屉 ---- */}
      <TaskLogDrawer
        task={drawerTask}
        liveLines={drawerTask ? (liveLogs[drawerTask.upid] ?? []) : []}
        wsStatus={wsStatus}
        onClose={() => setDrawerTask(null)}
      />

      {/* ---- 停止任务 ---- */}
      <ConfirmDialog
        open={Boolean(stopTarget)}
        onCancel={() => setStopTarget(null)}
        onConfirm={async () => {
          if (!stopTarget) return;
          setBusy(true);
          try {
            await tasksApi.stop(stopTarget.upid, stopTarget.node);
            toast.success(t('tasks.stopRequested'), t('tasks.stopRequestedDetail'));
            setStopTarget(null);
            invalidate();
          } catch (err) {
            toast.error(t('tasks.stopFailed'), errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title={t('tasks.stopTitle')}
        danger
        confirmText={t('tasks.stopTitle')}
        loading={busy}
        message={
          <>
            {t('tasks.stopMessagePre')}
            <strong> {taskTypeLabel(stopTarget?.type, t)} </strong>
            {t('tasks.stopMessagePost', { node: stopTarget?.node ?? '' })}
          </>
        }
      />

      {/* ---- 清理任务记录 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await tasksApi.remove(deleteTarget.upid, deleteTarget.node);
            toast.success(t('tasks.cleared'));
            setDeleteTarget(null);
            invalidate();
          } catch (err) {
            toast.error(t('tasks.clearFailed'), errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title={t('tasks.clearTitle')}
        danger
        confirmText={t('tasks.clearConfirm')}
        loading={busy}
        message={
          <>
            {t('tasks.clearMessage')}
          </>
        }
      />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   日志抽屉
   --------------------------------------------------------------------------- */

function TaskLogDrawer({
  task,
  liveLines,
  wsStatus,
  onClose,
}: {
  task: TaskInfo | null;
  liveLines: string[];
  wsStatus: WsStatus;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  /* 日志容器自身的 ref：自动滚动要作用在它身上（见下面的滚动说明） */
  const logRef = useRef<HTMLDivElement>(null);

  /* HTTP 获取历史日志（WS 只推增量） */
  const logQuery = useQuery({
    queryKey: ['task', 'detail', task?.node, task?.upid],
    queryFn: () => tasksApi.detail(task!.upid, task!.node),
    enabled: Boolean(task),
    // 运行中的任务定时回填，避免 WS 丢包导致日志不全
    refetchInterval:
      task && task.status === 'running' ? 4_000 : false,
    retry: 1,
  });

  /* 历史日志行 + WS 增量行合并去重 */
  const lines = useMemo<TaskLogLine[] | string[]>(() => {
    const base = logQuery.data?.log ?? [];
    if (liveLines.length === 0) return base;

    /* 用文本做去重：历史里已有的行不再追加 */
    const seen = new Set(base.map((l) => l.t));
    const extra = liveLines.filter((t) => !seen.has(t));
    return [
      ...base,
      ...extra.map((t, i) => ({ n: base.length + i + 1, t })),
    ];
  }, [logQuery.data, liveLines]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = lines.map((l) =>
      typeof l === 'string' ? { n: 0, t: l } : l,
    );
    return q ? list.filter((l) => l.t.toLowerCase().includes(q)) : list;
  }, [lines, filter]);

  /* 自动滚到底部。
     这里滚的是**日志容器自己**，不是外面那层抽屉：.log-viewer 带着
     max-height + overflow，它才是滚动容器；用 scrollIntoView 去滚 bottomRef
     会连带把抽屉甚至整个页面一起滚，日志内部的位置反而可能不动 —— 表现就是
     「怎么都拉不到最新那几行」。直接写 scrollTop 确定、且只动这一个容器。 */
  useEffect(() => {
    if (!autoScroll) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length, autoScroll, task?.upid]);

  /* 打开新任务时重置过滤与滚动 */
  useEffect(() => {
    setFilter('');
    setAutoScroll(true);
  }, [task?.upid]);

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(
        filtered.map((l) => l.t).join('\n'),
      );
      toast.success(t('tasks.copiedLog'));
    } catch {
      toast.error(t('common.copyFailed'), t('common.clipboardDenied'));
    }
  };

  const meta = task ? taskStatusMeta(task.status, task.exitstatus, t) : null;

  return (
    <Drawer
      open={Boolean(task)}
      onClose={onClose}
      width={760}
      title={t('tasks.logTitle')}
      subtitle={
        task ? (
          <div className="flex items-center gap-8 flex-wrap">
            <span className="fw-500">{taskTypeLabel(task.type, t)}</span>
            {meta ? (
              <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
                {meta.label}
              </Badge>
            ) : null}
            <span className="fs-xs text-muted mono">
              {task.node} · {task.upid.slice(0, 32)}…
            </span>
          </div>
        ) : null
      }
      footer={
        <div className="flex items-center justify-between gap-8 w-100">
          <span className="fs-xs text-muted">
            {t('tasks.logRows', { n: filtered.length })}
            {wsStatus === 'open' && task?.status === 'running'
              ? t('tasks.liveStreaming')
              : ''}
          </span>
          <div className="flex items-center gap-8">
            <Button variant="ghost" size="sm" onClick={() => void copyLog()}>
              {t('tasks.copyLog')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      }
    >
      {!task ? null : (
        <>
          {/* 任务元信息 */}
          <div className="desc-list mb-16">
            <div className="desc-item">
              <div className="desc-label">{t('tasks.metaUpid')}</div>
              <div className="desc-value mono fs-sm">{task.upid}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">{t('tasks.metaNodeObject')}</div>
              <div className="desc-value">
                {task.node}
                {task.id ? ` · ${task.id}` : ''}
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">{t('tasks.metaUser')}</div>
              <div className="desc-value">{task.user || '—'}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">{t('tasks.metaStartEnd')}</div>
              <div className="desc-value mono fs-sm">
                {formatDateTime(task.starttime)}
                {task.endtime
                  ? ` → ${formatDateTime(task.endtime)}`
                  : t('tasks.inProgressSuffix')}
              </div>
            </div>
            {task.exitstatus ? (
              <div className="desc-item">
                <div className="desc-label">{t('tasks.metaExit')}</div>
                <div className="desc-value mono fs-sm">{task.exitstatus}</div>
              </div>
            ) : null}
          </div>

          {logQuery.isError ? (
            <Notice tone="warning" title={t('tasks.logLoadFailed')}>
              {errorMessage(logQuery.error)}
              {t('tasks.logLoadFailedTail')}
            </Notice>
          ) : null}

          {/* 日志工具栏 */}
          <div className="toolbar mb-12">
            <div className="toolbar-left">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('tasks.filterLogPlaceholder')}
                prefix={<IconSearch size={14} />}
                block={false}
                aria-label={t('tasks.filterLogAria')}
              />
            </div>
            <div className="toolbar-right">
              <Switch
                checked={autoScroll}
                onChange={setAutoScroll}
                label={t('tasks.autoScroll')}
              />
            </div>
          </div>

          {/* 日志内容 */}
          {logQuery.isLoading ? (
            <div className="log-viewer text-muted">{t('tasks.logLoading')}</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              compact
              title={filter ? t('tasks.logNoMatch') : t('tasks.logEmpty')}
              description={
                filter
                  ? t('tasks.logNoMatchDesc')
                  : t('tasks.logEmptyDesc')
              }
            />
          ) : (
            <div
              className="log-viewer"
              role="log"
              aria-label={t('tasks.logAria')}
              ref={logRef}
              /* 用户手动往上翻看历史时停掉自动滚动：否则新日志一来就把视图拽回
                 底部，正在看的那几行被抢走。回到底部附近再自动恢复。 */
              onScroll={(e) => {
                const el = e.currentTarget;
                const atBottom =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                setAutoScroll(atBottom);
              }}
            >
              {filtered.map((l, i) => (
                <div
                  key={`${l.n}-${i}`}
                  className={`log-line ${logLineTone(l.t)}`}
                >
                  <span className="log-line-no">{l.n || i + 1}</span>
                  <span className="log-line-text">{l.t}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
   工具
   --------------------------------------------------------------------------- */

/** 日志行着色：识别 Proxmox 日志里的常见关键词 */
function logLineTone(text: string): string {
  const lower = text.toLowerCase();
  if (/(error|failed|failure|unable|cannot|denied|refused)/.test(lower)) {
    return 'is-error';
  }
  if (/(warn|warning|deprecated|skipping)/.test(lower)) return 'is-warn';
  if (/(done|success|finished|completed|ok\b)/.test(lower)) return 'is-ok';
  return '';
}

/** Proxmox 任务类型 → 文案键（非单词字符统一换成下划线） */
const TASK_TYPE_LABEL: Record<string, MessageKey> = {
  qmstart: 'tasks.type.qmstart',
  qmstop: 'tasks.type.qmstop',
  qmshutdown: 'tasks.type.qmshutdown',
  qmreboot: 'tasks.type.qmreboot',
  qmsuspend: 'tasks.type.qmsuspend',
  qmresume: 'tasks.type.qmresume',
  qmcreate: 'tasks.type.qmcreate',
  qmclone: 'tasks.type.qmclone',
  qmdestroy: 'tasks.type.qmdestroy',
  qmmigrate: 'tasks.type.qmmigrate',
  qmresize: 'tasks.type.qmresize',
  qmmove: 'tasks.type.qmmove',
  qmconfig: 'tasks.type.qmconfig',
  qmtemplate: 'tasks.type.qmtemplate',
  qmsnapshot: 'tasks.type.qmsnapshot',
  qmrollback: 'tasks.type.qmrollback',
  qmdelsnapshot: 'tasks.type.qmdelsnapshot',
  vzstart: 'tasks.type.vzstart',
  vzstop: 'tasks.type.vzstop',
  vzshutdown: 'tasks.type.vzshutdown',
  vzdump: 'tasks.type.vzdump',
  qmrestore: 'tasks.type.qmrestore',
  vzmigrate: 'tasks.type.vzmigrate',
  aptupdate: 'tasks.type.aptupdate',
  startall: 'tasks.type.startall',
  stopall: 'tasks.type.stopall',
  'cluster/backup': 'tasks.type.cluster_backup',
};

function taskTypeLabel(type: string | null | undefined, t: TFunc): string {
  if (!type) return t('tasks.unknownTask');
  const key = TASK_TYPE_LABEL[type];
  return key ? t(key) : type;
}
