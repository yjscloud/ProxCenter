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
import { taskStatusMeta, isTaskSuccess } from '../utils/status';
import { useWebSocket, type WsStatus } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { TaskInfo, TaskLogLine, TaskWsMessage } from '../api/types';

/* ---------------------------------------------------------------------------
   常量
   --------------------------------------------------------------------------- */

const STATUS_FILTERS = [
  { label: '全部状态', value: '' },
  { label: '执行中', value: 'running' },
  { label: '成功', value: 'ok' },
  { label: '失败', value: 'failed' },
] as const;

const WS_LABEL: Record<WsStatus, { text: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  open: { text: '实时连接', variant: 'success' },
  connecting: { text: '连接中', variant: 'warning' },
  closed: { text: '已断开', variant: 'neutral' },
  error: { text: '连接异常', variant: 'danger' },
};

/* 任务列表默认每页行数。后端一次给 300 条，全量渲染会让滚动明显发涩，
   所以前端分页；具体条数由列表底部的「每页 N 条」下拉决定（见 usePaged）。 */
const DEFAULT_PAGE_SIZE = 20;

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Tasks() {
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

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
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
    const names = (nodesQuery.data?.nodes ?? []).map((n) => n.name);
    return [
      { label: '全部节点', value: '' },
      ...names.sort().map((n) => ({ label: n, value: n })),
    ];
  }, [nodesQuery.data]);

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
      toast.success('已复制 UPID');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: '任务类型',
      render: (t) => (
        <div className="vm-name-cell">
          <span className="fw-500">{taskTypeLabel(t.type)}</span>
          <span className="fs-xs text-muted mono" title={t.upid}>
            {t.upid.slice(0, 26)}…
          </span>
        </div>
      ),
    },
    {
      key: 'node',
      header: '节点',
      width: 110,
      render: (t) => (
        <div className="vm-name-cell">
          <span className="fs-sm">{t.node}</span>
          {t.id ? <span className="fs-xs text-muted">{t.id}</span> : null}
        </div>
      ),
    },
    {
      key: 'user',
      header: '发起者',
      width: 130,
      render: (t) => <span className="fs-sm text-secondary">{t.user || '—'}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 120,
      render: (t) => {
        const meta = taskStatusMeta(t.status, t.exitstatus);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (t) => t.status ?? '',
    },
    {
      key: 'starttime',
      header: '开始时间',
      width: 180,
      render: (t) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{formatDateTime(t.starttime)}</span>
          <span className="fs-xs text-muted">{formatRelative(t.starttime)}</span>
        </div>
      ),
      sortable: true,
      sortValue: (t) => t.starttime ?? 0,
    },
    {
      key: 'duration',
      header: '耗时',
      width: 100,
      align: 'right',
      render: (t) => (
        <span className="mono fs-sm">
          {t.status === 'running'
            ? '进行中'
            : t.starttime && t.endtime
              ? formatUptime(t.endtime - t.starttime)
              : '—'}
        </span>
      ),
      sortable: true,
      sortValue: (t) =>
        t.starttime && t.endtime ? t.endtime - t.starttime : 0,
    },
    {
      key: 'actions',
      header: '操作',
      width: 130,
      align: 'right',
      render: (t) => (
        <span className="row-actions">
          <IconButton
            label={`查看日志 ${t.upid}`}
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              setDrawerTask(t);
            }}
          >
            <IconEye size={15} />
          </IconButton>
          <IconButton
            label={`复制 UPID`}
            onClick={(e) => {
              e.stopPropagation();
              void copyUpid(t.upid);
            }}
          >
            <IconCopy size={15} />
          </IconButton>
          {t.status === 'running' ? (
            <IconButton
              label={`停止任务 ${t.upid}`}
              variant="danger"
              disabled={!canWrite}
              onClick={(e) => {
                e.stopPropagation();
                setStopTarget(t);
              }}
            >
              <IconStop size={15} />
            </IconButton>
          ) : (
            <IconButton
              label={`清理任务记录`}
              variant="danger"
              disabled={!canWrite}
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(t);
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
          任务队列
        </>
      }
      subtitle="集群所有历史与进行中的任务，日志实时推送到当前页面"
      actions={
        <>
          <Badge variant={wsMeta.variant} dot pulse={wsStatus === 'open'} size="sm">
            {wsMeta.text}
          </Badge>
          {wsStatus !== 'open' ? (
            <Button variant="ghost" size="sm" onClick={reconnect}>
              重连
            </Button>
          ) : null}
          {/* 导出走服务端流式 CSV：本页只加载最近 300 条，导出则按筛选条件取
              每台 PVE 的完整任务日志（后端上限 1000 条/台），适合复盘与归档 */}
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={() => window.open(exportUrl('tasks', { node: nodeFilter || undefined }), '_blank')}
            title="导出任务队列（按当前节点筛选，不受本页 300 条限制）"
          >
            导出
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => invalidate()}
            loading={tasksQuery.isFetching && !tasksQuery.isLoading}
          >
            刷新
          </Button>
        </>
      }
    >
      {/* 统计 */}
      <div className="grid grid-4">
        <KpiCard
          label="任务总数"
          value={stats.total}
          icon={<IconActivity size={18} />}
          tone="accent"
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label="执行中"
          value={stats.running}
          icon={<IconClock size={18} />}
          tone={stats.running > 0 ? 'warning' : 'neutral'}
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label="成功"
          value={stats.success}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={tasksQuery.isLoading}
        />
        <KpiCard
          label="失败 / 中断"
          value={stats.failed}
          icon={<IconAlert size={18} />}
          tone={stats.failed > 0 ? 'danger' : 'neutral'}
          loading={tasksQuery.isLoading}
        />
      </div>

      {wsStatus === 'error' ? (
        <Notice tone="warning" title="实时日志连接异常">
          无法连接到 <span className="mono">/api/ws/tasks</span>，
          日志将通过 HTTP 定时回填。任务本身不受影响。
        </Notice>
      ) : null}

      {/* 筛选 */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 UPID、任务类型、发起者…"
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label="搜索任务"
          />
          <Select
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            options={nodeOptions}
            aria-label="按节点筛选"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={STATUS_FILTERS.map((s) => ({ label: s.label, value: s.value }))}
            aria-label="按状态筛选"
          />
        </div>
        <div className="toolbar-right">
          <Switch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label="自动刷新（5 秒）"
          />
          <span className="fs-sm text-muted">显示 {tasks.length} 条</span>
        </div>
      </div>

      {tasksQuery.isError && isNotImplemented(tasksQuery.error) ? (
        <ErrorState
          notImplemented
          title="任务列表接口尚未实现"
          message="后端 /cluster/tasks 返回未实现，无法获取集群任务历史。"
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : tasksQuery.isError ? (
        <ErrorState
          title="无法加载任务列表"
          message={errorMessage(tasksQuery.error)}
          onRetry={() => void tasksQuery.refetch()}
        />
      ) : (
        <>
          <Table<TaskInfo>
            columns={columns}
            rows={pageTasks}
            rowKey={(t) => `${t.node}/${t.upid}`}
            loading={tasksQuery.isLoading}
            caption="集群任务历史列表"
            emptyTitle={search || statusFilter ? '没有匹配的任务' : '暂无任务记录'}
            emptyDescription={
              search || statusFilter
                ? '尝试调整搜索关键词或筛选条件。'
                : '集群中还没有执行过任何任务。'
            }
            onRowClick={(t) => setDrawerTask(t)}
            rowTitle={(t) => t.upid}
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
            toast.success('已请求停止任务', '该任务会尽快终止');
            setStopTarget(null);
            invalidate();
          } catch (err) {
            toast.error('停止任务失败', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="停止任务"
        danger
        confirmText="停止任务"
        loading={busy}
        message={
          <>
            即将向 Proxmox 发送停止信号，中断任务
            <strong> {taskTypeLabel(stopTarget?.type)} </strong>
            （{stopTarget?.node}）。任务可能不会立即结束，
            部分操作被中断后可能留下不完整的中间状态。
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
            toast.success('任务记录已清理');
            setDeleteTarget(null);
            invalidate();
          } catch (err) {
            toast.error('清理任务记录失败', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="清理任务记录"
        danger
        confirmText="清理"
        loading={busy}
        message={
          <>
            即将从 Proxmox 任务历史中删除该条记录。
            此操作只移除日志元数据，不影响任何虚拟机状态。
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
      toast.success('日志已复制到剪贴板');
    } catch {
      toast.error('复制失败', '浏览器拒绝了剪贴板访问');
    }
  };

  const meta = task ? taskStatusMeta(task.status, task.exitstatus) : null;

  return (
    <Drawer
      open={Boolean(task)}
      onClose={onClose}
      width={760}
      title="任务日志"
      subtitle={
        task ? (
          <div className="flex items-center gap-8 flex-wrap">
            <span className="fw-500">{taskTypeLabel(task.type)}</span>
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
            共 {filtered.length} 行
            {wsStatus === 'open' && task?.status === 'running'
              ? ' · 实时推送中'
              : ''}
          </span>
          <div className="flex items-center gap-8">
            <Button variant="ghost" size="sm" onClick={() => void copyLog()}>
              复制日志
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              关闭
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
              <div className="desc-label">UPID</div>
              <div className="desc-value mono fs-sm">{task.upid}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">节点 / 对象</div>
              <div className="desc-value">
                {task.node}
                {task.id ? ` · ${task.id}` : ''}
              </div>
            </div>
            <div className="desc-item">
              <div className="desc-label">发起者</div>
              <div className="desc-value">{task.user || '—'}</div>
            </div>
            <div className="desc-item">
              <div className="desc-label">开始 / 结束</div>
              <div className="desc-value mono fs-sm">
                {formatDateTime(task.starttime)}
                {task.endtime ? ` → ${formatDateTime(task.endtime)}` : ' → 进行中'}
              </div>
            </div>
            {task.exitstatus ? (
              <div className="desc-item">
                <div className="desc-label">退出状态</div>
                <div className="desc-value mono fs-sm">{task.exitstatus}</div>
              </div>
            ) : null}
          </div>

          {logQuery.isError ? (
            <Notice tone="warning" title="日志加载失败">
              {errorMessage(logQuery.error)}。如果任务仍在运行，
              下方会继续显示 WebSocket 推送的增量日志。
            </Notice>
          ) : null}

          {/* 日志工具栏 */}
          <div className="toolbar mb-12">
            <div className="toolbar-left">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="过滤日志行…"
                prefix={<IconSearch size={14} />}
                block={false}
                aria-label="过滤日志"
              />
            </div>
            <div className="toolbar-right">
              <Switch
                checked={autoScroll}
                onChange={setAutoScroll}
                label="自动滚动"
              />
            </div>
          </div>

          {/* 日志内容 */}
          {logQuery.isLoading ? (
            <div className="log-viewer text-muted">正在加载日志…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              compact
              title={filter ? '没有匹配的日志行' : '暂无日志输出'}
              description={
                filter
                  ? '尝试更换过滤关键词。'
                  : '任务可能还未产生输出，或 Proxmox 已回收该日志。'
              }
            />
          ) : (
            <div
              className="log-viewer"
              role="log"
              aria-label="任务日志"
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

/** Proxmox 任务类型 → 中文标签 */
const TASK_TYPE_LABEL: Record<string, string> = {
  qmstart: '启动虚拟机',
  qmstop: '停止虚拟机',
  qmshutdown: '关闭虚拟机',
  qmreboot: '重启虚拟机',
  qmsuspend: '挂起虚拟机',
  qmresume: '恢复虚拟机',
  qmcreate: '创建虚拟机',
  qmclone: '克隆虚拟机',
  qmdestroy: '删除虚拟机',
  qmmigrate: '迁移虚拟机',
  qmresize: '调整磁盘',
  qmmove: '移动磁盘',
  qmconfig: '修改配置',
  qmtemplate: '转换为模板',
  qmsnapshot: '创建快照',
  qmrollback: '回滚快照',
  qmdelsnapshot: '删除快照',
  vzstart: '启动容器',
  vzstop: '停止容器',
  vzshutdown: '关闭容器',
  vzdump: '备份虚拟机',
  qmrestore: '恢复备份',
  vzmigrate: '迁移容器',
  aptupdate: '更新软件源',
  startall: '批量启动',
  stopall: '批量停止',
  'cluster/backup': '备份计划',
};

function taskTypeLabel(type?: string | null): string {
  if (!type) return '未知任务';
  return TASK_TYPE_LABEL[type] ?? type;
}
