/* ==========================================================================
   ProxCenter — 仪表盘
   ========================================================================== */

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  clusterApi,
  dashboardApi,
  nodesApi,
  storagesApi,
  vmsApi,
} from '../api/endpoints';
import { PageShell } from '../components/Layout';
import { useAuth } from '../hooks/useAuth';
import { useMetricsStream } from '../hooks/useMetricsStream';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Workbench } from '../components/Workbench';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SegmentedControl } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { ErrorState, EmptyState } from '../components/ui/EmptyState';
import { DonutChart, CHART_COLORS } from '../components/MetricChart';
import { CapacityCard } from '../components/CapacityCard';
import type { CapacityTimeframe } from '../components/CapacityCard';
import { ProgressBar } from '../components/ui/ProgressBar';
import {
  IconVm,
  IconServer,
  IconCpu,
  IconMemory,
  IconStorage,
  IconRefresh,
  IconTasks,
  IconActivity,
  IconGrip,
  IconLayout,
  IconChevronRight,
  IconEyeOff,
  IconEye,
} from '../components/Icons';
import {
  formatBytes,
  formatUptimeShort,
  formatRelative,
  toPercent,
  usageColor,
  usageTone,
} from '../utils/format';
import { taskStatusMeta, nodeStatusMeta } from '../utils/status';
import type { DashboardTop, NodeInfo, TaskInfo } from '../api/types';
import {
  packRows,
  useDashboardLayout,
  type WidgetMeta,
} from '../hooks/useDashboardLayout';

const REFRESH = 10_000;

/* 「集群节点」卡片最多列几个节点。
   节点一多，卡片里再一行行堆下去就是半屏滚动条 —— 这块是「扫一眼健康度」
   的地方，不是节点管理页。超出部分给一条「还有 N 个」+ 跳转，明细去 /nodes。 */
const NODE_ROWS_IN_CARD = 6;

/* ---------------------------------------------------------------------------
   卡片注册表
   ---------------------------------------------------------------------------

   仪表盘由这几块组成，顺序即默认布局。用户可以拖动排序、隐藏不关心的卡片，
   布局按账号存在服务端（见 hooks/useDashboardLayout）。

   加一张新卡片只需要在这里加一项 + 在下面的 `bodies` 里补一处渲染：
   老用户读到布局后会拿这份注册表对账，新卡片自动补到末尾，不需要
   「恢复默认布局」才看得见（也不需要动后端）。
   --------------------------------------------------------------------------- */
const WIDGET_META: WidgetMeta[] = [
  { id: 'kpi', name: '关键指标', span: 'full' },
  { id: 'nodes', name: '集群节点', span: 'half' },
  { id: 'distribution', name: '资源分布', span: 'half' },
  { id: 'capacity', name: '磁盘容量预测', span: 'full' },
  { id: 'top', name: '资源占用排行', span: 'full' },
  { id: 'tasks', name: '最近任务', span: 'full' },
];

interface WidgetShellProps {
  meta: WidgetMeta;
  editing: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onHide: () => void;
  children: ReactNode;
}

/**
 * 卡片外壳：非编辑态几乎是一个透明容器（不改变原有视觉），编辑态才加上
 * 顶部工具条、虚线框和拖动能力。
 *
 * 编辑时会把内层内容设为不可点（见 CSS `.widget-editing .widget-inner`）：
 * 卡片里到处是链接和按钮（节点行、排行都是 `<Link>`），而 `<a>` 默认就是
 * 可拖动的 —— 不隔绝的话拖卡片会变成拖链接，浏览器给出的拖拽影像是那个
 * 链接的地址。顺带也让「编辑布局」这个模式不会被误点进详情页。
 */
function WidgetShell({
  meta,
  editing,
  dragging,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onHide,
  children,
}: WidgetShellProps) {
  return (
    <section
      className={`widget${editing ? ' widget-editing' : ''}${
        dragging ? ' widget-dragging' : ''
      }`}
      draggable={editing}
      onDragStart={(event) => {
        if (!editing) return;
        event.dataTransfer.effectAllowed = 'move';
        // 必须写点数据，否则 Firefox 不认为这是一次合法拖拽
        event.dataTransfer.setData('text/plain', meta.id);
        onDragStart();
      }}
      onDragEnter={() => {
        if (editing) onDragEnter();
      }}
      onDragOver={(event) => {
        if (!editing) return;
        // 不 preventDefault 就不会触发 drop，浏览器也不显示「可放置」光标
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        if (editing) event.preventDefault();
      }}
      onDragEnd={onDragEnd}
    >
      {editing ? (
        <div className="widget-bar">
          <span className="widget-grip" title="拖动调整顺序" aria-hidden="true">
            <IconGrip size={15} />
          </span>
          <span className="widget-bar-name">{meta.name}</span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconEyeOff size={14} />}
            onClick={onHide}
          >
            隐藏
          </Button>
        </div>
      ) : null}
      <div className="widget-inner">{children}</div>
    </section>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  /* 任务队列页属于「系统管理」，仅管理员可进入 */
  const { isAdmin } = useAuth();

  /* ---- 数据查询（每 10 秒自动刷新）---- */
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    refetchInterval: REFRESH,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    refetchInterval: REFRESH,
  });

  const clusterQuery = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: clusterApi.status,
    refetchInterval: REFRESH,
    retry: false,
  });

  /* 集群仲裁与 HA：单节点恒为 quorate，多节点时掉仲裁意味着整群只读 */
  const haQuery = useQuery({
    queryKey: ['cluster', 'ha-status'],
    queryFn: clusterApi.haStatus,
    refetchInterval: REFRESH,
    retry: false,
  });

  const haHint = (() => {
    const ha = haQuery.data;
    if (!ha) return 'HA 状态暂不可用';
    /* 前缀带上连接名：多套 PVE 同级的部署里，这张卡只反映默认连接那一套 */
    const prefix = ha.connection_name ? `${ha.connection_name} · ` : '';
    if (ha.cluster_mode === 'standalone') return `${prefix}单机模式 · 无 HA`;
    if (ha.quorum.quorate === false) return `${prefix}集群失去仲裁`;
    if (!ha.ha_enabled) return `${prefix}多节点集群 · 未启用 HA`;
    return ha.ha_resources.length > 0
      ? `${prefix}HA 托管 ${ha.ha_resources.length} 个资源`
      : `${prefix}HA 已启用 · 暂无托管资源`;
  })();

  const storagesQuery = useQuery({
    queryKey: ['storages', 'all'],
    queryFn: () => storagesApi.list(),
    refetchInterval: REFRESH,
  });

  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', 8],
    queryFn: () => clusterApi.tasks({ limit: 8 }),
    refetchInterval: REFRESH,
    retry: false,
  });

  /* 容量预测：节点磁盘趋势外推，变化慢，30s 刷一次即可。
     窗口可切换（周 / 月 / 年），不同窗口都可能有用：
     周看短期暴涨，年看长期趋势（月度尖峰在 30 天窗口里容易被平均掉）。 */
  const [capacityTimeframe, setCapacityTimeframe] =
    useState<CapacityTimeframe>('month');
  const capacityQuery = useQuery({
    queryKey: ['dashboard', 'capacity', capacityTimeframe],
    queryFn: () => dashboardApi.capacity(capacityTimeframe),
    refetchInterval: 30_000,
    retry: false,
  });

  /* Top N 资源占用排行（CPU / 内存），后端按指标排序 */
  const topQuery = useQuery({
    queryKey: ['dashboard', 'top', 8],
    queryFn: () => dashboardApi.top(8),
    refetchInterval: REFRESH,
    retry: false,
  });

  /* 实时节点指标流：后端把逐页轮询集中到一条 WebSocket 上，
     5s 推一次。连接正常时优先用实时值驱动 KPI 与节点行，
     断线则回落到 10s 轮询，保证任何情况下都有数据。 */
  const metrics = useMetricsStream(true);

  /* ---- 统计计算 ---- */
  const stats = useMemo(() => {
    const vms = vmsQuery.data ?? [];
    // 排除模板
    const realVms = vms.filter((v) => !v.template);
    const running = realVms.filter((v) => v.status === 'running');
    const stopped = realVms.filter((v) => v.status === 'stopped');
    const other = realVms.length - running.length - stopped.length;

    return {
      total: realVms.length,
      running: running.length,
      stopped: stopped.length,
      other,
      /* 模板单独计数：它不参与运行状态分布（既不是运行中也不是已停止），
         但要让人知道「还有这些机器存在」，否则总数会对不上侧边栏的读数。 */
      templates: vms.length - realVms.length,
    };
  }, [vmsQuery.data]);

  /* ---- Top N 资源占用排行（CPU / 内存）----
     用后端 /dashboard/top 排序，比前端按单次采样排更稳：
     CPU 峰值波动大，内存吃紧更难靠感觉发现。 */
  const [topTab, setTopTab] = useState<'cpu' | 'mem'>('mem');
  const topList = useMemo(() => {
    const data = (topQuery.data ?? { by_cpu: [], by_memory: [] }) as DashboardTop;
    return topTab === 'mem' ? data.by_memory : data.by_cpu;
  }, [topQuery.data, topTab]);

  /* ---- 实时节点指标合并 ----
     WebSocket 在线时，用它覆盖轮询拿到的 cpu/mem/状态，让 KPI 与节点行
     变成秒级刷新；离线则原样回落到轮询数据。 */
  const mergedNodes = useMemo(() => {
    const list = nodesQuery.data ?? [];
    if (!metrics.connected) return list;
    return list.map((n) => {
      const live = metrics.metrics[n.node];
      if (!live) return n;
      return {
        ...n,
        cpu: live.cpu ?? n.cpu,
        mem: live.mem ?? n.mem,
        maxmem: live.maxmem ?? n.maxmem,
        maxcpu: live.maxcpu ?? n.maxcpu,
        status: live.status ?? n.status,
        uptime: live.uptime ?? n.uptime,
      };
    });
  }, [nodesQuery.data, metrics]);

  const storageStats = useMemo(() => {
    const list = (storagesQuery.data ?? []).filter((s) => s.active);
    /* 去重规则（列表此时已跨所有 PVE 连接聚合）：
       1) 同一条连接内，共享存储（NFS / Ceph 等）会被每个节点各上报一次，
          必须按名称去重，否则容量被重复累加；
       2) 本地存储按「节点+名称」区分 —— 不同节点上的同名本地存储是两份独立容量；
       3) 整体再按「连接」隔离 —— 两台 PVE 上的同名存储同样是两份独立容量，
          不隔离的话跨主机就会误去重、把其中一台的容量整个丢掉。 */
    const seen = new Set<string>();
    let total = 0;
    let used = 0;
    for (const s of list) {
      const conn = s.connection_id ?? '';
      const key = s.shared
        ? `${conn}/${s.storage}`
        : `${conn}/${s.node}/${s.storage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += s.total ?? 0;
      used += s.used ?? 0;
    }
    return {
      total,
      used,
      percent: total > 0 ? (used / total) * 100 : 0,
      count: seen.size,
    };
  }, [storagesQuery.data]);

  /* 集群实时资源占用。
     CPU 按物理核心数加权 —— 多节点核心数不同时，简单平均会失真。
     不用虚拟机列表来算使用率：那是「分配层面」的数据 ——
       1) 关机虚拟机的 vCPU / 内存仍留在分母里，会把使用率稀释掉；
       2) 每台虚拟机的 cpu 是相对它自己 vCPU 数的占用率，与物理机实际负载
          根本不是同一个量纲。
     实测差距很大：虚拟机口径 2.5%，物理机口径 19.8%。 */
  const nodeStats = useMemo(() => {
    const list = mergedNodes;
    const totalCores = list.reduce((s, n) => s + (n.maxcpu ?? 0), 0);
    const usedCores = list.reduce(
      (s, n) => s + (toPercent(n.cpu) / 100) * (n.maxcpu ?? 0),
      0,
    );
    const totalMem = list.reduce((s, n) => s + (n.maxmem ?? 0), 0);
    const usedMem = list.reduce((s, n) => s + (n.mem ?? 0), 0);
    return {
      online: list.filter((n) => n.status === 'online').length,
      total: list.length,
      totalCores,
      usedCores,
      cpuAvg: totalCores > 0 ? (usedCores / totalCores) * 100 : 0,
      totalMem,
      usedMem,
      memPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
    };
  }, [mergedNodes]);

  /* 卡片里显示的节点：离线优先，其次按 CPU 负载降序。
     不是简单按名字排 —— 打开仪表盘是为了看谁在冒烟，
     「最吃力的排最前」比「字母序」有用得多。 */
  const cardNodes = useMemo(() => {
    return [...mergedNodes]
      .sort((a, b) => {
        const aOff = a.status === 'online' ? 1 : 0;
        const bOff = b.status === 'online' ? 1 : 0;
        if (aOff !== bOff) return aOff - bOff;
        const diff = toPercent(b.cpu) - toPercent(a.cpu);
        if (Math.abs(diff) > 0.0001) return diff;
        return a.node.localeCompare(b.node);
      })
      .slice(0, NODE_ROWS_IN_CARD);
  }, [mergedNodes]);
  const hiddenNodeCount = Math.max(0, mergedNodes.length - cardNodes.length);

  /* 资源分布：三个状态**始终都在**。
     这里刻意不把 0 值过滤掉 —— 明细里少一行会让人以为「这一类不存在」，
     而「已停止 0 台」本身也是一条有用的信息。环形图那边再单独滤掉 0 值切片
     （0 值切片会让甜甜圈的 paddingAngle 留下一道多余的缝）。 */
  const distribution = useMemo(
    () => [
      { name: '运行中', value: stats.running, color: CHART_COLORS.success },
      { name: '已停止', value: stats.stopped, color: CHART_COLORS.grey },
      { name: '其他', value: stats.other, color: CHART_COLORS.warning },
    ],
    [stats],
  );

  const donutData = useMemo(
    () => distribution.filter((d) => d.value > 0),
    [distribution],
  );

  /* ---- 最近任务表格 ---- */
  const taskColumns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: '任务类型',
      render: (t) => <span className="mono fs-sm">{t.type}</span>,
      sortable: true,
      sortValue: (t) => t.type,
    },
    {
      key: 'node',
      header: '节点',
      render: (t) => <span className="fs-sm">{t.node}</span>,
      width: 110,
    },
    {
      key: 'id',
      header: '对象',
      render: (t) => (
        <span className="fs-sm text-secondary mono">{t.id ?? '—'}</span>
      ),
      width: 100,
    },
    {
      key: 'status',
      header: '状态',
      render: (t) => {
        const meta = taskStatusMeta(t.status, t.exitstatus);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
      width: 110,
    },
    {
      key: 'time',
      header: '开始时间',
      render: (t) => (
        <span className="fs-sm text-secondary">
          {formatRelative(t.starttime)}
        </span>
      ),
      align: 'right',
      width: 120,
      sortable: true,
      sortValue: (t) => t.starttime ?? 0,
    },
  ];

  /* ---- 布局：卡片顺序与显隐，按账号存在服务端 ---- */
  const board = useDashboardLayout(WIDGET_META);
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const rows = useMemo(
    () => packRows(board.visibleOrder, WIDGET_META),
    [board.visibleOrder],
  );

  const hasError =
    vmsQuery.isError && nodesQuery.isError && storagesQuery.isError;

  if (hasError) {
    return (
      <PageShell title="仪表盘">
        <ErrorState
          title="无法加载集群数据"
          message="请确认后端服务已启动并已配置 Proxmox 连接。"
          onRetry={() => {
            void vmsQuery.refetch();
            void nodesQuery.refetch();
            void storagesQuery.refetch();
          }}
        />
      </PageShell>
    );
  }

  /* ------------------------------------------------------------------
     各卡片的内容。键必须与 WIDGET_META 里的 id 一一对应：布局只存 id，
     渲染时按 id 取这里的内容（见下面的 rows 循环）。
     ------------------------------------------------------------------ */
  const bodies: Record<string, ReactNode> = {
    /* ---- KPI 卡片（含集群态势，共 5 项）---- */
    kpi: (
      <div className="grid grid-5">
        <KpiCard
          label="虚拟机总数"
          value={stats.total}
          icon={<IconVm size={16} />}
          tone="accent"
          loading={vmsQuery.isLoading}
          hint={
            <>
              <span className="text-success">{stats.running} 运行中</span>
              <span className="text-muted">·</span>
              <span className="text-secondary">{stats.stopped} 已停止</span>
            </>
          }
        />

        {/* ---- 集群态势：紧挨「虚拟机总数」 ----
            这两张卡一起回答「现在有多少机器、整个集群健康不健康」，
            是进入大盘最先要看到的信息，所以放在最前两位；
            CPU / 内存 / 存储三个利用率顺延到右边。

            quorate 掉了在多节点集群里意味着整个集群进入只读保护。
            直接用 KpiCard 而不是自建卡片：和左右四个指标共用同一套
            label / value / hint 结构，视觉才不会是「五张卡里混了个异类」。
            Quorum 作为主读数，HA 状态退到 hint 里。

            这张卡**恒定渲染**：以前 HA 取不到数据时整张卡消失，grid-5 当场
            变成四列，右边四个指标一起左移一格 —— 只是打开一次页面就能看到
            整行跳一下。现在改成「加载中骨架 / 有数据正常态 / 拿不到写未知」，
            卡片始终占住它那一格。 */}
        <KpiCard
          label="集群态势"
          value={
            haQuery.data ? (
              <span className="posture-inline">
                <span
                  className={`posture-dot ${
                    haQuery.data.quorum.quorate ? 'is-ok' : 'is-bad'
                  }`}
                />
                {haQuery.data.quorum.quorate ? '正常' : '失去仲裁'}
              </span>
            ) : (
              /* 拿不到 quorum 时给一个明确的「未知」，而不是让整张卡消失 */
              <span className="posture-inline">
                <span className="posture-dot" />
                未知
              </span>
            )
          }
          icon={<IconServer size={16} />}
          /* 与左右四个指标同一套配色逻辑：正常态用 accent（蓝），
             只有真正出问题时才转 danger（红）—— CPU / 内存 / 存储
             超阈值时也是这样变色的，保持整行读起来一致；
             读不到状态则退成 neutral，不用红去吓人。 */
          tone={
            haQuery.data
              ? haQuery.data.quorum.quorate
                ? 'accent'
                : 'danger'
              : 'neutral'
          }
          loading={haQuery.isLoading}
          /* HA 的几种状态要说清楚是哪一种，不能一律写成「未启用」：
             单机根本不存在 HA（显示为「未启用」会让人以为配置漏了），
             多节点集群跑着 HA 但没托管资源，也应该读作「已启用」。
             多连接部署下这张卡只反映默认连接那一套，所以把连接名带上。 */
          hint={haHint}
        />

        <KpiCard
          label="CPU 使用率"
          value={`${nodeStats.cpuAvg.toFixed(1)}%`}
          icon={<IconCpu size={16} />}
          tone={usageTone(nodeStats.cpuAvg)}
          loading={nodesQuery.isLoading}
          progress={nodeStats.cpuAvg}
          progressColor={usageColor(nodeStats.cpuAvg)}
          hint={
            <span className="mono">
              {nodeStats.usedCores.toFixed(2)} / {nodeStats.totalCores} 物理核心
            </span>
          }
        />

        <KpiCard
          label="内存使用率"
          value={`${nodeStats.memPercent.toFixed(1)}%`}
          icon={<IconMemory size={16} />}
          tone={usageTone(nodeStats.memPercent)}
          loading={nodesQuery.isLoading}
          progress={nodeStats.memPercent}
          progressColor={usageColor(nodeStats.memPercent)}
          hint={
            <span className="mono">
              {formatBytes(nodeStats.usedMem)} / {formatBytes(nodeStats.totalMem)}
            </span>
          }
        />

        <KpiCard
          label="存储使用率"
          value={`${storageStats.percent.toFixed(1)}%`}
          icon={<IconStorage size={16} />}
          tone={usageTone(storageStats.percent)}
          loading={storagesQuery.isLoading}
          progress={storageStats.percent}
          progressColor={usageColor(storageStats.percent)}
          hint={
            <span className="mono">
              {formatBytes(storageStats.used)} / {formatBytes(storageStats.total)}
            </span>
          }
        />
      </div>
    ),

    /* 集群节点与资源分布是半边宽的，渲染时会被并成一行（见 packRows） */
    nodes: (
      <>
        <Card collapsible={false}>
          <CardHeader
            title="集群节点"
            subtitle={
              nodesQuery.data
                ? `${nodeStats.online}/${nodeStats.total} 在线 · 平均 CPU ${nodeStats.cpuAvg.toFixed(1)}%`
                : undefined
            }
            icon={<IconServer size={16} />}
            actions={
              <>
                {metrics.connected ? (
                  <span className="live-badge" title="实时指标已连接">
                    <span className="live-badge-dot" />
                    实时
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/nodes')}
                >
                  查看全部
                </Button>
              </>
            }
          />

          {nodesQuery.isLoading ? (
            <div className="flex flex-col gap-16">
              {[0, 1].map((i) => (
                <div key={i}>
                  <div className="skeleton skeleton-text" style={{ width: '30%' }} />
                  <div className="skeleton skeleton-text" style={{ height: 6, marginTop: 10 }} />
                </div>
              ))}
            </div>
          ) : nodesQuery.isError ? (
            <ErrorState
              title="无法获取节点列表"
              onRetry={() => void nodesQuery.refetch()}
            />
          ) : mergedNodes.length === 0 ? (
            <EmptyState
              title="暂无节点"
              description="集群中还没有可用节点。"
              compact
            />
          ) : (
            <>
              {/* 紧凑列表：每个指标固定在同一列上，跨行可比；
                  节点多时只列最需要注意的前几个，剩下的去节点页看 */}
              <div className="dash-nodes">
                <div className="dash-node-row is-head" aria-hidden="true">
                  <span>节点</span>
                  <span>CPU</span>
                  <span>内存</span>
                  <span>磁盘</span>
                  <span />
                </div>
                {cardNodes.map((node) => (
                  <DashboardNodeRow key={node.node} node={node} />
                ))}
              </div>

              {hiddenNodeCount > 0 ? (
                <button
                  type="button"
                  className="dash-nodes-more"
                  onClick={() => navigate('/nodes')}
                >
                  还有 {hiddenNodeCount} 个节点未显示 · 去节点页查看全部
                  <IconChevronRight size={13} />
                </button>
              ) : null}
            </>
          )}
        </Card>
      </>
    ),

    /* 资源分布：环形图 + 状态明细。
       明细不是装饰 —— 它同时解决两个问题：
         ① 环形图只能看出「占比」，看不出「几台」，明细把绝对值补上；
         ② 这张卡和左边的「集群节点」同排，节点一多左边就变高，
            卡片被拉高后光靠一个固定高度的环形图会在下方留一块空白。
            明细行 + 可伸缩的环形图把纵向空间用满，两边高度自然对齐。 */
    distribution: (
      <>
        <Card collapsible={false}>
          <CardHeader
            title="资源分布"
            subtitle={`虚拟机运行状态 · 共 ${stats.total} 台`}
            icon={<IconActivity size={16} />}
          />
          <div className="dist-body">
            <div className="dist-chart">
              <DonutChart
                data={donutData}
                height="100%"
                showLegend={false}
                centerLabel="虚拟机"
                centerValue={stats.total}
              />
            </div>

            <ul className="dist-legend">
              {distribution.map((row) => {
                const pct = stats.total > 0 ? (row.value / stats.total) * 100 : 0;
                return (
                  <li className="dist-item" key={row.name}>
                    <span
                      className="dist-dot"
                      style={{ background: row.color }}
                      aria-hidden="true"
                    />
                    <span className="dist-name">{row.name}</span>
                    <span className="dist-count mono">{row.value}</span>
                    <span className="dist-pct mono">{pct.toFixed(1)}%</span>
                    <span className="dist-bar" aria-hidden="true">
                      <span
                        className="dist-bar-fill"
                        style={{ width: `${pct}%`, background: row.color }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>

            {stats.templates > 0 ? (
              <div className="dist-foot">
                另有 {stats.templates} 个模板未计入运行状态
              </div>
            ) : null}
          </div>
        </Card>
      </>
    ),

    /* ---- 磁盘容量预测 ---- */
    capacity: (
      <CapacityCard
        forecast={capacityQuery.data}
        loading={capacityQuery.isLoading}
        error={capacityQuery.isError}
        timeframe={capacityTimeframe}
        onTimeframeChange={setCapacityTimeframe}
      />
    ),

    /* ---- Top N 资源占用排行（CPU / 内存双 Tab）---- */
    top: (
      <Card>
        <CardHeader
          title="资源占用排行"
          subtitle={
            topQuery.isLoading
              ? '加载中…'
              : `运行中的虚拟机 · Top ${topList.length || 8}`
          }
          icon={<IconActivity size={16} />}
          actions={
            <SegmentedControl<'cpu' | 'mem'>
              value={topTab}
              onChange={setTopTab}
              ariaLabel="资源占用排行指标"
              options={[
                { label: '内存', value: 'mem' },
                { label: 'CPU', value: 'cpu' },
              ]}
            />
          }
        />
        <div className="top-vms">
          {topQuery.isLoading ? (
            <div className="flex flex-col gap-16">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton skeleton-text" style={{ width: '70%' }} />
              ))}
            </div>
          ) : topList.length === 0 ? (
            <EmptyState
              title="暂无数据"
              description="集群中还没有运行中的虚拟机。"
              compact
            />
          ) : (
            topList.map((v, i) => {
              const pct =
                topTab === 'mem'
                  ? v.maxmem
                    ? (v.mem / v.maxmem) * 100
                    : 0
                  : toPercent(v.cpu);
              return (
                <Link
                  key={`${v.node}-${v.vmid}`}
                  to={`/vms/${encodeURIComponent(v.node)}/${v.vmid}`}
                  className="top-vm"
                  style={{ textDecoration: 'none' }}
                >
                  <span className="top-vm-rank mono">{i + 1}</span>
                  <span className="top-vm-name truncate">
                    {v.name || `VM ${v.vmid}`}
                    <span className="fs-xs text-muted mono"> {v.node}</span>
                  </span>
                  <div className="top-vm-bar">
                    <ProgressBar
                      value={pct}
                      height={6}
                      color={usageColor(pct)}
                      showValue
                    />
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </Card>
    ),

    /* ---- 最近任务 ---- */
    tasks: (
      <Card padded={false} collapsible={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHeader
            title="最近任务"
            subtitle="集群中最近执行的操作"
            icon={<IconTasks size={16} />}
            actions={
              isAdmin ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/tasks')}
                >
                  查看全部
                </Button>
              ) : undefined
            }
          />
        </div>
        <Table<TaskInfo>
          columns={taskColumns}
          rows={tasksQuery.data ?? []}
          rowKey={(t) => t.upid}
          loading={tasksQuery.isLoading}
          caption="最近执行的集群任务列表"
          emptyTitle="暂无任务记录"
          emptyDescription="集群中还没有执行过任何任务。"
          onRowClick={isAdmin ? () => navigate('/tasks') : undefined}
          dense
          className="table-flush"
        />
      </Card>
    ),
  };

  /**
   * 渲染一块卡片。非编辑态下 WidgetShell 是一个透明容器，视觉与改造前一致。
   */
  const renderWidget = (meta: WidgetMeta) => (
    <WidgetShell
      key={meta.id}
      meta={meta}
      editing={editing}
      dragging={dragId === meta.id}
      onDragStart={() => setDragId(meta.id)}
      onDragEnter={() => {
        // 拖动经过另一块时实时交换位置，这样松手前就能看到结果
        if (dragId) board.move(dragId, meta.id);
      }}
      onDragEnd={() => setDragId(null)}
      onHide={() => board.setHidden(meta.id, true)}
    >
      {bodies[meta.id]}
    </WidgetShell>
  );

  return (
    <PageShell
      title="集群仪表盘"
      subtitle={
        clusterQuery.data
          ? `Proxmox VE ${clusterQuery.data.version || ''} · ${
              clusterQuery.data.quorate === true
                ? '集群仲裁正常'
                : clusterQuery.data.quorate === false
                  ? '集群仲裁异常'
                  : '单机模式'
            }`
          : '正在加载集群信息…'
      }
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void vmsQuery.refetch();
              void nodesQuery.refetch();
              void storagesQuery.refetch();
              void tasksQuery.refetch();
              void clusterQuery.refetch();
            }}
            loading={vmsQuery.isFetching && !vmsQuery.isLoading}
          >
            刷新
          </Button>
          <Button
            variant={editing ? 'primary' : 'secondary'}
            icon={<IconLayout size={15} />}
            onClick={() => {
              setDragId(null);
              setEditing((value) => !value);
            }}
          >
            {editing ? '完成' : '编辑布局'}
          </Button>
          {/* 布局完全默认时不给这个按钮：没有可恢复的东西，点了只会困惑 */}
          {editing && !board.isDefault ? (
            <Button
              variant="ghost"
              icon={<IconRefresh size={15} />}
              onClick={() => void board.reset()}
            >
              恢复默认布局
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon={<IconVm size={15} />}
            onClick={() => navigate('/vms')}
          >
            管理虚拟机
          </Button>
        </>
      }
    >
      {editing ? (
        <div className="widget-edit-hint">
          <IconLayout size={16} />
          <span>
            拖动卡片调整顺序、点「隐藏」收起不关心的内容。改动会立即保存到你的账号，
            换浏览器或换设备都保持不变。
          </span>
        </div>
      ) : null}

      {/* 工作台：首页第一屏的「下一步做什么」。
          刻意放在可编辑卡片之外 —— 布局只负责数据卡片的顺序与显隐，
          待办与快捷入口是固定引导区，不该被拖走或隐藏。 */}
      <Workbench />

      {rows.map((row, index) =>
        row.length === 2 ? (
          <div key={`row-${index}`} className="grid grid-2 dashboard-split">
            {row.map(renderWidget)}
          </div>
        ) : (
          renderWidget(row[0])
        ),
      )}

      {editing && board.hiddenWidgets.length > 0 ? (
        <Card collapsible={false}>
          <CardHeader
            title="已隐藏的卡片"
            subtitle="点一下放回它原来的位置"
            icon={<IconEye size={16} />}
          />
          <div className="form-row">
            {board.hiddenWidgets.map((meta) => (
              <Button
                key={meta.id}
                variant="ghost"
                size="sm"
                icon={<IconEye size={14} />}
                onClick={() => board.setHidden(meta.id, false)}
              >
                {meta.name}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   节点概览行（紧凑版）
   ---------------------------------------------------------------------------
   原先每行是「标题行 + 两根整宽进度条」，一行接近 100px：十几个节点就要滚
   一整屏，而且各行的进度条宽度不同，横着没法比较。
   现在一行只占 40px 上下，三根迷你条分别固定在 CPU / 内存 / 磁盘三列上，
   竖着一扫就知道谁快满了。运行时长这类次要信息退到名称下方的小字。
   --------------------------------------------------------------------------- */

function DashboardNodeRow({ node }: { node: NodeInfo }) {
  const offline = node.status !== 'online';
  const meta = nodeStatusMeta(node.status);

  const metrics = [
    { key: 'cpu', pct: toPercent(node.cpu), sub: node.maxcpu ? `${node.maxcpu} 核` : '—' },
    {
      key: 'mem',
      pct: node.maxmem > 0 ? ((node.mem ?? 0) / node.maxmem) * 100 : 0,
      sub: formatBytes(node.maxmem, 0),
    },
    {
      key: 'disk',
      pct: node.maxdisk > 0 ? ((node.disk ?? 0) / node.maxdisk) * 100 : 0,
      sub: formatBytes(node.maxdisk, 0),
    },
  ];

  return (
    <Link
      to={`/nodes/${encodeURIComponent(node.node)}${
        node.connection_id ? `?conn=${encodeURIComponent(node.connection_id)}` : ''
      }`}
      className={`dash-node-row${offline ? ' is-offline' : ''}`}
    >
      <div className="dash-node-name">
        <span className={`dash-node-dot is-${offline ? 'off' : 'on'}`} aria-hidden="true" />
        <span className="fw-600 truncate">{node.node}</span>
        <span className="fs-xs text-muted truncate">
          {offline ? '离线' : `运行 ${formatUptimeShort(node.uptime)}`}
          {node.connection_name ? ` · ${node.connection_name}` : ''}
        </span>
        {/* 屏幕阅读器读不到颜色，状态用徽章文字兜底 */}
        <span className="sr-only">{meta.label}</span>
      </div>

      {metrics.map((item) => {
        const color = offline ? 'var(--text-muted)' : usageColor(item.pct);
        return (
          <div className="dash-node-metric" key={item.key}>
            <span className="dash-node-pct mono" style={{ color }}>
              {offline ? '—' : `${item.pct.toFixed(0)}%`}
            </span>
            <ProgressBar value={offline ? 0 : item.pct} color={color} height={5} />
            <span className="fs-xs text-muted">{item.sub}</span>
          </div>
        );
      })}

      <IconChevronRight size={13} />
    </Link>
  );
}
