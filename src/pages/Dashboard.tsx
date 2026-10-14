/* ==========================================================================
   ProxCenter — 仪表盘
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clusterApi,
  connectionsApi,
  dashboardApi,
  lxcApi,
  nodesApi,
  storagesApi,
  vmsApi,
} from '../api/endpoints';
import { guestPath } from '../api/guests';
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
import { Modal } from '../components/ui/Modal';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
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
  IconChevronDown,
  IconEyeOff,
  IconEye,
  IconLayers,
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
import type {
  DashboardTop,
  FleetConnectionStatus,
  NodeInfo,
  TaskInfo,
} from '../api/types';
import {
  packRows,
  useDashboardLayout,
  type WidgetMeta,
} from '../hooks/useDashboardLayout';
import { useT } from '../i18n';

/* 仪表盘各卡片的自动刷新间隔取自「设置 → 面板设置 → 数据刷新间隔」
   （见 useRefreshInterval）：这里是全站接口最集中的一页（虚拟机 / 节点 / 集群 /
   存储 / 任务 / TopN 一起轮询），间隔调小要清楚代价。原先写死 30 秒。
   节点 KPI 那条实时曲线走 WebSocket，不受这个设置影响。 */

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
  /* 每张卡片声明自己需要什么权限，与后端的守卫一一对上（括号里是接口）：
     没权限的卡片整块不出现，也不去发那个注定 403 的请求。 */
  {
    id: 'kpi',
    nameKey: 'dashboard.widget.kpi',
    span: 'full',
    /* 复合卡片：内部还要分身份、逐项裁（见 bodies.kpi 与 kpiCount）。
       这里声明的是「最低门槛」—— 管理员行要有虚拟机数据，普通用户行则
       虚拟机或容器任一类都行（他的台数卡、占用读数按各自权限出现）。 */
    permissions: ['vm.view', 'ct.view'],
  },
  {
    id: 'nodes',
    nameKey: 'dashboard.widget.nodes',
    span: 'half',
    permissions: ['node.view'],
    /* 宿主机负载是集群运营视角：普通用户的仪表盘只讲「我的机器」 */
    adminOnly: true,
  },
  {
    id: 'distribution',
    nameKey: 'dashboard.widget.distribution',
    span: 'half',
    /* 统计口径只算虚拟机（vmsApi.list → vm.view）：这张图讲的是虚拟机分布，
       不跟着「虚拟机或容器任一类」放宽到 ct.view */
    permissions: ['vm.view'],
  },
  {
    id: 'capacity',
    nameKey: 'dashboard.widget.capacity',
    span: 'full',
    permissions: ['node.view'],
    /* 磁盘写满的预测窗口是几个月量级的事，属于「运维这个集群」的判断 */
    adminOnly: true,
  },
  {
    id: 'top',
    nameKey: 'dashboard.widget.top',
    span: 'full',
    /* 榜单跨虚拟机与容器两类（/dashboard/top 的守卫就是 require_any）。
       接口那侧已经按归属过滤，普通用户即使请求也只拿到自己名下的机器；
       这里再对普通用户整块拿掉 —— 他手上那几台机器排不出「榜」，
       而这张卡片原本最容易让人以为「仪表盘显示的是全集群」。 */
    permissions: ['vm.view', 'ct.view'],
    adminOnly: true,
  },
  {
    id: 'tasks',
    nameKey: 'dashboard.widget.tasks',
    span: 'full',
    permissions: ['task.view'],
    /* 任务队列里跑着别的节点 / 别人的操作，普通用户只需要他自己机器上的那份 */
    adminOnly: true,
  },
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
  const t = useT();
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
          <span
            className="widget-grip"
            title={t('dashboard.widget.drag')}
            aria-hidden="true"
          >
            <IconGrip size={15} />
          </span>
          <span className="widget-bar-name">{t(meta.nameKey)}</span>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconEyeOff size={14} />}
            onClick={onHide}
          >
            {t('dashboard.widget.hide')}
          </Button>
        </div>
      ) : null}
      <div className="widget-inner">{children}</div>
    </section>
  );
}

export function Dashboard() {
  const t = useT();
  const navigate = useNavigate();
  /* 任务队列页属于「系统管理」，仅管理员可进入 */
  const { isAdmin, hasPermission } = useAuth();

  /* ---- 权限开关：仪表盘按权限自适应 ----
     「没权限就不请求、也不显示」是这一页与工作台（components/Workbench）共用的口径。
     照样发请求只会换回一屏红色 403，而用户看到的「故障」其实只是「这块不给他看」。
     每个开关同时喂两处：卡片渲染（要不要出现）与查询 enabled（要不要发送），
     两者必须同源，否则又会出现「卡片在、数据是红的」。
     （括号里是各接口在后端的守卫，见 backend/app/routers） */
  const canVm = hasPermission('vm.view'); //       /vms list
  const canCt = hasPermission('ct.view'); //       /lxc list
  const canGuest = canVm || canCt; //              /dashboard/top
  const canNode = hasPermission('node.view'); //   /nodes、/cluster/*、/dashboard/capacity
  const canStorage = hasPermission('storage.view'); // /storages
  const canTask = hasPermission('task.view'); //   /cluster/tasks

  /* 集群级那几路再加一道**身份**门槛（卡片侧对应 WIDGET_META 里的 adminOnly）：
     普通用户的仪表盘只剩「我的机器」那一摊，看不到节点 / 容量 / 任务 / 榜单，
     请求也就不该发 —— 不然卡片裁掉了、轮询还在跑，每 30 秒白打六路接口，其中
     最重的容量预测还要逐节点去读 PVE 的 rrddata。 */
  const loadNodes = isAdmin && canNode;
  const loadStorages = isAdmin && canStorage;
  const loadTasks = isAdmin && canTask;
  const loadTop = isAdmin && canGuest;

  /* 未配置连接时后端对每个请求都回 428，轮询只会刷一屏没人看的报错
     （配好之后自动恢复） */
  const pveReady = usePveReady();
  const queryClient = useQueryClient();
  /* 手动刷新按钮的转圈状态：**只在用户点过之后**才转，而不是看全局 isFetching ——
     这一页每 30 秒自动轮询一次，用全局值会让按钮自己转个不停、还点不动。 */
  const anyFetching = useIsFetching() > 0;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (refreshing && !anyFetching) setRefreshing(false);
  }, [refreshing, anyFetching]);

  /* ---- 数据查询 ----
     每路都挂权限开关：没权限的连接上就不发请求（见上面的 canXxx）。
     另外 enabled 为 false 时 react-query 不会置 isLoading —— 被裁掉的卡片
     连加载骨架都不会闪一下，这也是「自适应」需要的一半。
     刷新间隔跟「设置 → 面板设置 → 数据刷新间隔」走。 */
  const refresh = useRefreshInterval();
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    refetchInterval: pveReady ? refresh : false,
    enabled: canVm,
  });

  /* 容器是**另一套接口与权限**（/lxc → ct.view），不搭 /vms 的车：那条接口的
     守卫是 vm.view，用它取容器等于绕开了 ct.view。
     只有普通用户需要它 —— 管理员的指标行读的是宿主机与集群容量，
     跟「我名下的容器」无关。 */
  const ctsQuery = useQuery({
    queryKey: ['lxc', 'dashboard'],
    queryFn: () => lxcApi.list(),
    refetchInterval: pveReady ? refresh : false,
    enabled: !isAdmin && canCt,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    refetchInterval: pveReady ? refresh : false,
    enabled: canNode,
  });


  /* ---- 集群态势（全机队口径）----
     这里原先读 /cluster/ha-status —— 那个接口只能读**默认连接**那一套（面板把
     多条 PVE 当同级，见 connections 的说明）。症状是：套着四台 PVE 时，非默认的
     那几套失去仲裁，仪表盘照样一片绿。失去仲裁意味着那个集群进入只读保护，
     是最高级别的异常，不能漏。
     fleet-status 已经把每条连接的仲裁 / HA / 可达性算好（顶栏「控制台状态」用的
     是同一个接口、同一个 queryKey，所以不会多发请求）。 */
  const fleetQuery = useQuery({
    queryKey: ['cluster', 'fleet-status'],
    queryFn: clusterApi.fleetStatus,
    refetchInterval: refresh,
    retry: false,
    enabled: loadNodes,
  });

  const fleetItems = fleetQuery.data?.connections ?? [];
  const noQuorum = fleetItems.filter((item) => item.quorate === false);
  const unreachable = fleetItems.filter((item) => !item.ok);

  /* 副标题里的 PVE 版本：多套 PVE 未必同版本，去重后展示，超过两个折叠成 +N
     （与顶栏「控制台状态」同一套写法）。 */
  const pveVersions = Array.from(
    new Set(fleetItems.map((item) => item.version).filter(Boolean)),
  );
  const versionText =
    pveVersions.length > 2
      ? `${pveVersions[0]} / ${pveVersions[1]} +${pveVersions.length - 2}`
      : pveVersions.join(' / ');

  /* 三态取「全机队里最坏的那一个」：失去仲裁 > 有连接不可达 > 正常 */
  const posture: 'ok' | 'degraded' | 'down' | 'unknown' = !fleetQuery.data
    ? 'unknown'
    : noQuorum.length > 0
      ? 'down'
      : unreachable.length > 0
        ? 'degraded'
        : 'ok';

  const postureDot =
    posture === 'ok'
      ? 'is-ok'
      : posture === 'degraded'
        ? 'is-warn'
        : posture === 'down'
          ? 'is-bad'
          : '';
  const postureLabel =
    posture === 'ok'
      ? t('dashboard.posture.ok')
      : posture === 'degraded'
        ? t('dashboard.posture.degraded')
        : posture === 'down'
          ? t('dashboard.posture.down')
          : t('dashboard.kpi.unknown');
  const postureTone =
    posture === 'ok'
      ? 'accent'
      : posture === 'degraded'
        ? 'warning'
        : posture === 'down'
          ? 'danger'
          : 'neutral';

  /* 单条连接的细节说明（沿用原来那套措辞，数据换成 fleet 里的那一条） */
  const connectionHint = (item: FleetConnectionStatus) => {
    const prefix = item.name ? `${item.name} · ` : '';
    if (!item.ok) return prefix + t('dashboard.posture.unreachableShort');
    if (item.cluster_mode === 'standalone') return prefix + t('dashboard.ha.standalone');
    if (item.quorate === false) return prefix + t('dashboard.ha.lostQuorum');
    if (!item.ha_enabled) return prefix + t('dashboard.ha.notEnabled');
    return item.ha_resources > 0
      ? prefix + t('dashboard.ha.managed', { n: item.ha_resources })
      : prefix + t('dashboard.ha.enabledEmpty');
  };

  /* 异常必须出现在**明面上**（hint 就是明面）：以前它只是 hover 才知道的前缀，
     非默认集群掉仲裁根本没人会看到。 */
  const postureHint = (() => {
    const fleet = fleetQuery.data;
    if (!fleet) return t('dashboard.ha.unavailable');
    if (noQuorum.length === 1) {
      return t('dashboard.posture.lostQuorum', { name: noQuorum[0].name });
    }
    if (noQuorum.length > 1) {
      return t('dashboard.posture.lostQuorumMany', { n: noQuorum.length });
    }
    if (unreachable.length === 1) {
      return t('dashboard.posture.unreachable', { name: unreachable[0].name });
    }
    if (unreachable.length > 1) {
      return t('dashboard.posture.unreachableMany', { n: unreachable.length });
    }
    /* 只有一套 PVE 时不讲「几套 PVE 几个节点」那套合计话术，讲这一套自己 */
    if (fleet.connections.length === 1) return connectionHint(fleet.connections[0]);
    return t('dashboard.posture.fleetSummary', {
      pve: fleet.totals.connections,
      nodes: fleet.totals.nodes,
      ha: fleet.totals.ha_resources,
    });
  })();

  /* ---- 下钻明细：每套 PVE 一行，按区域分组（与节点 / 网络 / 存储三页同一套层级语言）---- */
  const [postureOpen, setPostureOpen] = useState(false);
  /* 连接表只用来取「区域」标签。它在打开明细前就先查好（而不是等弹窗打开了
     再查）：否则第一次展开时会先按「未分区」画一遍，连接表回来后再跳成真实
     区域名 —— 一次可见的重新分组。接口本身很轻（读面板自己的配置）。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
    enabled: loadNodes,
  });

  const postureGroups = useMemo(() => {
    const regionOf = (connId: string) => {
      const hit = (connectionsQuery.data ?? []).find(
        (item) => String(item.id) === connId,
      );
      return String(hit?.region || '').trim();
    };
    /* 异常排前面：打开明细的人是来看「哪一套出问题了」的 */
    const severity = (item: FleetConnectionStatus) =>
      item.quorate === false ? 0 : item.ok ? 2 : 1;

    const map = new Map<
      string,
      { id: string; label: string; items: FleetConnectionStatus[] }
    >();
    for (const item of fleetItems) {
      const region = regionOf(item.id);
      let hit = map.get(region);
      if (!hit) {
        hit = {
          id: region,
          label: region || t('nodes.regionUnassigned'),
          items: [],
        };
        map.set(region, hit);
      }
      hit.items.push(item);
    }
    const groups = [...map.values()];
    for (const group of groups) {
      group.items.sort(
        (a, b) => severity(a) - severity(b) || a.name.localeCompare(b.name),
      );
    }
    /* 未分区排最后：它是兜底分组，不该排在有名字的区域前面 */
    return groups.sort((a, b) => {
      if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [fleetItems, connectionsQuery.data, t]);
  const showPostureRegion = postureGroups.some((group) => group.id !== '');

  /* 第三级：具体节点。数据直接用仪表盘已经在查的 /nodes —— 它本来就汇总了全部
     连接的节点，按来源连接分一下组即可，不为了这个弹窗再打一路接口。
     离线优先排序：打开这份明细就是为了看哪台机器出问题。 */
  const nodesByConnection = useMemo(() => {
    const map = new Map<string, NodeInfo[]>();
    for (const node of nodesQuery.data ?? []) {
      const key = String(node.connection_id ?? '');
      const list = map.get(key);
      if (list) list.push(node);
      else map.set(key, [node]);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          (a.status === 'online' ? 1 : 0) - (b.status === 'online' ? 1 : 0) ||
          a.node.localeCompare(b.node),
      );
    }
    return map;
  }, [nodesQuery.data]);

  /* 折叠状态分两套语义，因为两级的默认值刚好相反：
       * 连接**默认收起** —— 先看「哪几套 PVE 有问题」，要看某台的节点再点开；
       * 区域默认展开 —— 它一般只有一两个，收起它等于把内容藏两层。
     收起的连接存成「已展开的连接」而不是「已收起的连接」：默认值就是空数组，
     不必等 fleet 数据到了再挨个补 id（那会先闪一帧全展开）。 */
  const [openPostureConns, setOpenPostureConns] = useState<string[]>([]);
  const [closedPostureRegions, setClosedPostureRegions] = useState<string[]>([]);
  const togglePostureConn = (id: string) => {
    setOpenPostureConns((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  };
  const togglePostureRegion = (id: string) => {
    setClosedPostureRegions((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  };

  /* 明细里一套 PVE 的状态词与配色 */
  const itemMeta = (item: FleetConnectionStatus) => {
    const parts = [
      item.cluster_mode === 'standalone'
        ? t('dashboard.posture.standalone')
        : t('dashboard.posture.cluster'),
      t('dashboard.posture.nodeCount', { n: item.node_count }),
    ];
    if (item.version) parts.push(`v${item.version}`);
    if (item.cluster_mode === 'cluster') {
      parts.push(
        item.ha_enabled
          ? t('dashboard.posture.haManaged', { n: item.ha_resources })
          : t('dashboard.posture.haOff'),
      );
    }
    return parts.join(' · ');
  };

  /* 明细里一套 PVE 的状态点 / 徽章 / 状态词。
     失去仲裁最重（整群只读），其次是不可达；单机没有仲裁可言，标成中性。 */
  const postureItemDot = (item: FleetConnectionStatus) =>
    item.quorate === false ? 'is-bad' : item.ok ? 'is-ok' : 'is-warn';
  const postureItemBadge = (
    item: FleetConnectionStatus,
  ): 'danger' | 'warning' | 'neutral' | 'success' =>
    item.quorate === false
      ? 'danger'
      : !item.ok
        ? 'warning'
        : item.cluster_mode === 'standalone'
          ? 'neutral'
          : 'success';
  const postureItemLabel = (item: FleetConnectionStatus) => {
    if (item.quorate === false) return t('dashboard.kpi.lostQuorum');
    if (!item.ok) return t('dashboard.posture.unreachableShort');
    if (item.cluster_mode === 'standalone') return t('dashboard.posture.standalone');
    return t('dashboard.kpi.quorate');
  };

  const storagesQuery = useQuery({
    queryKey: ['storages', 'all'],
    queryFn: () => storagesApi.list(),
    refetchInterval: pveReady ? refresh : false,
    enabled: loadStorages,
  });

  const tasksQuery = useQuery({
    queryKey: ['cluster', 'tasks', 8],
    queryFn: () => clusterApi.tasks({ limit: 8 }),
    refetchInterval: refresh,
    retry: false,
    enabled: loadTasks,
  });

  /* 容量预测：节点磁盘趋势外推，变化慢 —— 也跟设置走，别处刷得勤它跟着勤。
     窗口可切换（周 / 月 / 年），不同窗口都可能有用：
     周看短期暴涨，年看长期趋势（月度尖峰在 30 天窗口里容易被平均掉）。 */
  const [capacityTimeframe, setCapacityTimeframe] =
    useState<CapacityTimeframe>('month');
  const capacityQuery = useQuery({
    queryKey: ['dashboard', 'capacity', capacityTimeframe],
    queryFn: () => dashboardApi.capacity(capacityTimeframe),
    refetchInterval: refresh,
    retry: false,
    enabled: loadNodes,
  });

  /* Top N 资源占用排行（CPU / 内存），后端按指标排序 */
  const topQuery = useQuery({
    queryKey: ['dashboard', 'top', 8],
    queryFn: () => dashboardApi.top(8),
    refetchInterval: refresh,
    retry: false,
    enabled: loadTop,
  });

  /* 实时节点指标流：后端把逐页轮询集中到一条 WebSocket 上，
     5s 推一次。连接正常时优先用实时值驱动 KPI 与节点行，
     断线则回落到 10s 轮询，保证任何情况下都有数据。
     没有 node.view 就别连：这条 WS 也过 node.view，连上会被后端拒，
     而 hook 是按指数退避「断线重连」的（它分不出拒绝与网络抖动），
     结果就是这类账号在后台一直空转握手、服务端日志一路刷 403。 */
  const metrics = useMetricsStream(loadNodes);

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
    };
  }, [vmsQuery.data]);

  /* 普通用户指标行的读数：**我名下**的虚拟机 + 容器一起算。
     与上面的 stats 分开是有意的 —— 那个口径只统计虚拟机，要跟「资源分布」
     那张卡（运行状态、中心读数）对齐；这里要的是「我这些机器一共占了多少」。
     CPU 按核数加权，与集群那张同一口径：逐台简单平均会在机器核数悬殊时失真。 */
  const myStats = useMemo(() => {
    const vmList = (vmsQuery.data ?? []).filter((g) => !g.template);
    const ctList = (ctsQuery.data ?? []).filter((g) => !g.template);
    const all = [...vmList, ...ctList];
    const sumOf = (list: typeof all, field: 'maxcpu' | 'maxmem' | 'maxdisk') =>
      list.reduce((sum, g) => sum + (g[field] ?? 0), 0);
    const runningCount = (list: typeof all) =>
      list.filter((g) => g.status === 'running').length;

    const totalCores = sumOf(all, 'maxcpu');
    const usedCores = all.reduce(
      (sum, g) => sum + (toPercent(g.cpu) / 100) * (g.maxcpu ?? 0),
      0,
    );
    const totalMem = sumOf(all, 'maxmem');
    const usedMem = all.reduce((sum, g) => sum + (g.mem ?? 0), 0);
    const totalDisk = sumOf(all, 'maxdisk');
    const usedDisk = all.reduce((sum, g) => sum + (g.disk ?? 0), 0);

    return {
      vms: vmList.length,
      cts: ctList.length,
      vmRunning: runningCount(vmList),
      ctRunning: runningCount(ctList),
      cpuPercent: totalCores > 0 ? (usedCores / totalCores) * 100 : 0,
      usedCores,
      totalCores,
      memPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
      usedMem,
      totalMem,
      diskPercent: totalDisk > 0 ? (usedDisk / totalDisk) * 100 : 0,
      usedDisk,
      totalDisk,
      /* PVE 的 disk（已用空间）不是每台都给得出：它来自存储层的块统计，
         LVM 这类厚置备存储拿不到值，PVE 就回 0；容器走的是文件系统统计，
         一般有值。所以「整批都为 0」要读作**这个读数取不到**，而不是
         「磁盘是空的」—— 那种情况改报已分配容量，别显示成 0.0%。 */
      diskUsageKnown: usedDisk > 0,
    };
  }, [vmsQuery.data, ctsQuery.data]);

  /* 三张占用读数的加载态：两份列表**任一份**还在路上就得转圈。
     只盯 vmsQuery 的话，只有 ct.view 的账号（vms 那路没发出去 → isLoading 恒
     false）会先看到一片 0%，随后数字才跳上来。 */
  const myLoading = vmsQuery.isLoading || ctsQuery.isLoading;

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
      {
        name: t('dashboard.dist.running'),
        value: stats.running,
        color: CHART_COLORS.success,
      },
      {
        name: t('dashboard.dist.stopped'),
        value: stats.stopped,
        color: CHART_COLORS.grey,
      },
      {
        name: t('dashboard.dist.other'),
        value: stats.other,
        color: CHART_COLORS.warning,
      },
    ],
    [stats, t],
  );

  const donutData = useMemo(
    () => distribution.filter((d) => d.value > 0),
    [distribution],
  );

  /* ---- 最近任务表格 ---- */
  const taskColumns: Array<Column<TaskInfo>> = [
    {
      key: 'type',
      header: t('dashboard.tasks.colType'),
      render: (task) => <span className="mono fs-sm">{task.type}</span>,
      sortable: true,
      sortValue: (task) => task.type,
    },
    {
      key: 'node',
      header: t('dashboard.tasks.colNode'),
      /* 任务跨连接合并时把来源一并写出来：两台 PVE 都有 pve1 时，
         光看节点名会以为是同一条任务出现了两次 */
      render: (task) => (
        <span
          className="fs-sm truncate"
          title={
            task.connection_name ? `${task.node} · ${task.connection_name}` : task.node
          }
        >
          {task.node}
          {task.connection_name ? (
            <span className="fs-xs text-muted"> · {task.connection_name}</span>
          ) : null}
        </span>
      ),
      width: 160,
    },
    {
      key: 'id',
      header: t('dashboard.tasks.colId'),
      render: (task) => (
        <span className="fs-sm text-secondary mono">{task.id ?? '—'}</span>
      ),
      width: 100,
    },
    {
      key: 'status',
      header: t('dashboard.tasks.colStatus'),
      render: (task) => {
        const meta = taskStatusMeta(task.status, task.exitstatus, t);
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
      header: t('dashboard.tasks.colTime'),
      render: (task) => (
        <span className="fs-sm text-secondary">
          {formatRelative(task.starttime)}
        </span>
      ),
      align: 'right',
      width: 120,
      sortable: true,
      sortValue: (task) => task.starttime ?? 0,
    },
  ];

  /* ---- 布局：卡片顺序与显隐，按账号存在服务端 ---- */
  const board = useDashboardLayout(WIDGET_META);
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  /* 这张卡片此刻该不该出现（两条声明见 WIDGET_META，两处判断缺一不可）：
       * permissions —— 有没有看这件事的权限；
       * adminOnly   —— 这件事跟「普通用户」这个身份相不相称。集群节点、
         跨用户榜单、任务队列都属于后者：普通用户的仪表盘只讲他自己那几台机器。
     **只过滤渲染，不动布局数据**：无权限期间随便拖一下就会把「裁短后」的
     顺序落库，权限恢复后卡片顺序再也回不来（见 useDashboardLayout 的说明）。 */
  const canSee = useCallback(
    (meta: WidgetMeta) =>
      (!meta.adminOnly || isAdmin) &&
      (!meta.permissions || meta.permissions.some((perm) => hasPermission(perm))),
    [isAdmin, hasPermission],
  );

  const allowedIds = useMemo(
    () => new Set(WIDGET_META.filter(canSee).map((w) => w.id)),
    [canSee],
  );

  const rows = useMemo(
    () =>
      packRows(
        board.visibleOrder.filter((id) => allowedIds.has(id)),
        WIDGET_META,
      ),
    [board.visibleOrder, allowedIds],
  );

  /* 编辑布局时的「已隐藏卡片」同样过滤：没权限的卡片摆在「加回来」那一栏，
     点一下只会得到一张空卡 */
  const hiddenWidgets = useMemo(
    () => board.hiddenWidgets.filter(canSee),
    [board.hiddenWidgets, canSee],
  );

  /* 「该看的都失败了」才整页报错 —— 而「该看的有哪几路」随身份而变：
     普通用户的仪表盘只剩「我的虚拟机」那一路，节点 / 存储两路压根没发出去
     （enabled=false 的查询 isError 恒为 false）。照原样要求三路同时失败，
     普通用户在真拿不到数据时就只会看到一片 0，连一句「加载失败」都等不到。 */
  const dataQueries = [
    vmsQuery,
    ...(loadNodes ? [nodesQuery] : []),
    ...(loadStorages ? [storagesQuery] : []),
  ];
  const hasError = dataQueries.every((query) => query.isError);

  if (hasError) {
    return (
      <PageShell title={t('nav.dashboard')}>
        <PveQueryError
          title={t('dashboard.loadErrorTitle')}
          message={t('dashboard.loadErrorMsg')}
          error={vmsQuery.error}
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
  /* KPI 行是这一页唯一的**复合卡片**，而且两套身份下装的东西完全不同：
     * 管理员 —— 集群视角：虚拟机总数 + 集群态势 + CPU / 内存（宿主机）+ 存储；
     * 普通用户 —— 我的视角：我的虚拟机 / 我的容器 / 我这些机器占用的 CPU /
       内存 / 硬盘。宿主机负载他不该看，那几路查询也压根没发出去。
     所以张数分两套算。普通用户那三张占用读数没有数据源（两类机器权限都没有）
     时整行也不渲染 —— 显示三张 0% 比不显示更容易让人以为「我的机器都没占用」。 */
  const kpiCount = isAdmin
    ? (canVm ? 1 : 0) + (loadNodes ? 3 : 0) + (loadStorages ? 1 : 0)
    : canGuest
      ? (canVm ? 1 : 0) + (canCt ? 1 : 0) + 3
      : 0;
  /* 列数跟实际张数走：写死 grid-5 的话，裁到 3 张就会三张挤在一格宽的位置、
     右边空两格（原本想避免的「整行跳一下」会以另一种形式回来） */
  const kpiCols = `grid-${Math.min(Math.max(kpiCount, 2), 5)}`;

  const bodies: Record<string, ReactNode> = {
    /* ---- KPI 卡片（含集群态势，共 5 项，按权限裁剪）---- */
    kpi: kpiCount === 0 ? null : isAdmin ? (
      <div className={`grid ${kpiCols}`}>
        {canVm ? (
          <KpiCard
            label={t('dashboard.kpi.vms')}
            value={stats.total}
            icon={<IconVm size={16} />}
            tone="accent"
            loading={vmsQuery.isLoading}
            hint={
              <>
                <span className="text-success">
                  {t('dashboard.kpi.running', { n: stats.running })}
                </span>
                <span className="text-muted">·</span>
                <span className="text-secondary">
                  {t('dashboard.kpi.stopped', { n: stats.stopped })}
                </span>
              </>
            }
          />
        ) : null}

        {/* ---- 集群态势：紧挨「虚拟机总数」 ----
            这两张卡一起回答「现在有多少机器、整个集群健康不健康」，
            是进入大盘最先要看到的信息，所以放在最前两位；
            CPU / 内存 / 存储三个利用率顺延到右边。

            quorate 掉了在多节点集群里意味着整个集群进入只读保护。
            直接用 KpiCard 而不是自建卡片：和左右四个指标共用同一套
            label / value / hint 结构，视觉才不会是「五张卡里混了个异类」。
            主读数是**全机队**的三态结论（正常 / 降级 / 异常），哪一套出了
            什么问题写在 hint 里；点开还能逐套看明细。

            这张卡**恒定渲染**：以前 HA 取不到数据时整张卡消失，整行当场
            少一格、右边几个指标一起左移 —— 只是打开一次页面就能看到整行跳一下。
            现在改成「加载中骨架 / 有数据正常态 / 拿不到写未知」，卡片始终占住
            它那一格。
            三张节点类的卡（态势 / CPU / 内存）合成一组共用一个 loadNodes 判断：
            它们同源，拆成三个判断只是把同一件事写三遍（loadNodes 即
            isAdmin && canNode，与这三张卡的查询 enabled 是同一个值）。 */}
        {loadNodes ? (
          <>
            <KpiCard
              label={t('dashboard.kpi.posture')}
              value={
                <span className="posture-inline">
                  <span className={`posture-dot ${postureDot}`} />
                  {postureLabel}
                </span>
              }
              icon={<IconServer size={16} />}
              /* 与左右四个指标同一套配色逻辑：正常态用 accent（蓝），降级转
                 warning（橙）、失去仲裁转 danger（红）—— CPU / 内存 / 存储
                 超阈值时也是这样变色的，保持整行读起来一致；
                 读不到状态则退成 neutral，不用红去吓人。 */
              tone={postureTone}
              loading={fleetQuery.isLoading}
              /* HA 的几种状态要说清楚是哪一种，不能一律写成「未启用」：
                 单机根本不存在 HA（显示为「未启用」会让人以为配置漏了），
                 多节点集群跑着 HA 但没托管资源，也应该读作「已启用」。
                 多套 PVE 时给全机队合计；有异常则直接点名是哪一套 ——
                 异常必须写在明面上，不能只在悬停提示里。 */
              hint={postureHint}
              /* 点开看逐套 PVE 的明细：KPI 卡撑不下多行，细节按需展开 */
              onClick={() => setPostureOpen(true)}
              title={t('dashboard.posture.detailTitle')}
            />

            <KpiCard
              label={t('dashboard.kpi.cpu')}
              value={`${nodeStats.cpuAvg.toFixed(1)}%`}
              icon={<IconCpu size={16} />}
              tone={usageTone(nodeStats.cpuAvg)}
              loading={nodesQuery.isLoading}
              progress={nodeStats.cpuAvg}
              progressColor={usageColor(nodeStats.cpuAvg)}
              hint={
                <span className="mono">
                  {t('dashboard.kpi.cores', {
                    used: nodeStats.usedCores.toFixed(2),
                    total: nodeStats.totalCores,
                  })}
                </span>
              }
            />

            <KpiCard
              label={t('dashboard.kpi.mem')}
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
          </>
        ) : null}

        {loadStorages ? (
          <KpiCard
            label={t('dashboard.kpi.storage')}
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
        ) : null}
      </div>
    ) : (
      /* 普通用户那一行：只回答「我有什么、占了多少」。
         两类机器的台数来自两份**已按归属过滤**的列表（/vms 与 /lxc），
         后端已经把别人的机器拿掉了 —— 这里不需要前端再筛一遍。 */
      <div className={`grid ${kpiCols}`}>
        {canVm ? (
          <KpiCard
            label={t('dashboard.kpi.myVms')}
            value={myStats.vms}
            icon={<IconVm size={16} />}
            tone="accent"
            loading={vmsQuery.isLoading}
            hint={
              <>
                <span className="text-success">
                  {t('dashboard.kpi.running', { n: myStats.vmRunning })}
                </span>
                <span className="text-muted">·</span>
                <span className="text-secondary">
                  {t('dashboard.kpi.stopped', {
                    n: myStats.vms - myStats.vmRunning,
                  })}
                </span>
              </>
            }
          />
        ) : null}

        {canCt ? (
          <KpiCard
            label={t('dashboard.kpi.myCts')}
            value={myStats.cts}
            icon={<IconServer size={16} />}
            tone="accent"
            loading={ctsQuery.isLoading}
            hint={
              <>
                <span className="text-success">
                  {t('dashboard.kpi.running', { n: myStats.ctRunning })}
                </span>
                <span className="text-muted">·</span>
                <span className="text-secondary">
                  {t('dashboard.kpi.stopped', {
                    n: myStats.cts - myStats.ctRunning,
                  })}
                </span>
              </>
            }
          />
        ) : null}

        {/* 三张占用读数：虚拟机与容器**合在一起**算 —— 用户问的是「我这些机器
            一共占了多少」，按类型拆开反而要多看两张卡才拼得出一个数。
            CPU 按核数加权，与管理员那张宿主机口径一致。 */}
        <KpiCard
          label={t('dashboard.kpi.cpu')}
          value={`${myStats.cpuPercent.toFixed(1)}%`}
          icon={<IconCpu size={16} />}
          tone={usageTone(myStats.cpuPercent)}
          loading={myLoading}
          progress={myStats.cpuPercent}
          progressColor={usageColor(myStats.cpuPercent)}
          hint={
            <span className="mono">
              {/* 用 myCores 而不是管理员那张的 cores：「物理核心」说的是宿主机
                  核数，这里是机器分配到的 vCPU */}
              {t('dashboard.kpi.myCores', {
                used: myStats.usedCores.toFixed(2),
                total: myStats.totalCores,
              })}
            </span>
          }
        />

        <KpiCard
          label={t('dashboard.kpi.mem')}
          value={`${myStats.memPercent.toFixed(1)}%`}
          icon={<IconMemory size={16} />}
          tone={usageTone(myStats.memPercent)}
          loading={myLoading}
          progress={myStats.memPercent}
          progressColor={usageColor(myStats.memPercent)}
          hint={
            <span className="mono">
              {formatBytes(myStats.usedMem)} / {formatBytes(myStats.totalMem)}
            </span>
          }
        />

        {/* 磁盘这张有两种形态（见 myStats.diskUsageKnown）：
            拿得到已用空间就报使用率，拿不到就只报已分配容量。
            后者绝不能显示成 0.0% —— 那读起来像「磁盘是空的」，
            而事实是这个读数 PVE 给不出来。 */}
        {myStats.diskUsageKnown ? (
          <KpiCard
            label={t('dashboard.kpi.myDisk')}
            value={`${myStats.diskPercent.toFixed(1)}%`}
            icon={<IconStorage size={16} />}
            tone={usageTone(myStats.diskPercent)}
            loading={myLoading}
            progress={myStats.diskPercent}
            progressColor={usageColor(myStats.diskPercent)}
            hint={
              <span className="mono">
                {formatBytes(myStats.usedDisk)} / {formatBytes(myStats.totalDisk)}
              </span>
            }
          />
        ) : (
          <KpiCard
            label={t('dashboard.kpi.myDisk')}
            value={formatBytes(myStats.totalDisk)}
            icon={<IconStorage size={16} />}
            tone="neutral"
            loading={myLoading}
            hint={
              <span className="mono">{t('dashboard.kpi.myDiskAllocated')}</span>
            }
          />
        )}
      </div>
    ),

    /* 集群节点与资源分布是半边宽的，渲染时会被并成一行（见 packRows） */
    nodes: (
      <>
        <Card collapsible={false}>
          <CardHeader
            title={t('dashboard.widget.nodes')}
            subtitle={
              nodesQuery.data
                ? t('dashboard.nodes.subtitle', {
                    online: nodeStats.online,
                    total: nodeStats.total,
                    cpu: nodeStats.cpuAvg.toFixed(1),
                  })
                : undefined
            }
            icon={<IconServer size={16} />}
            actions={
              <>
                {metrics.connected ? (
                  <span className="live-badge" title={t('dashboard.nodes.liveTitle')}>
                    <span className="live-badge-dot" />
                    {t('dashboard.nodes.live')}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/nodes')}
                >
                  {t('dashboard.nodes.viewAll')}
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
              title={t('dashboard.nodes.loadError')}
              onRetry={() => void nodesQuery.refetch()}
            />
          ) : mergedNodes.length === 0 ? (
            <EmptyState
              title={t('dashboard.nodes.empty')}
              description={t('dashboard.nodes.emptyDesc')}
              compact
            />
          ) : (
            <>
              {/* 紧凑列表：每个指标固定在同一列上，跨行可比；
                  节点多时只列最需要注意的前几个，剩下的去节点页看 */}
              <div className="dash-nodes">
                <div className="dash-node-row is-head" aria-hidden="true">
                  <span>{t('dashboard.nodes.colNode')}</span>
                  <span>CPU</span>
                  <span>{t('dashboard.top.memory')}</span>
                  <span>{t('dashboard.nodes.colDisk')}</span>
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
                  {t('dashboard.nodes.more', { n: hiddenNodeCount })}
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
            title={t('dashboard.dist.title')}
            /* 普通用户的数字本来就只是他名下的（/vms 按归属过滤，见
               security.visible_owner），但卡片长得和管理员那张一模一样 ——
               「共 N 台」到底是他那几台还是整个集群，光看卡片分不出来。
               副标题里写明「我名下」。 */
            subtitle={
              isAdmin
                ? t('dashboard.dist.subtitle', { n: stats.total })
                : t('dashboard.dist.subtitleMine', { n: stats.total })
            }
            icon={<IconActivity size={16} />}
          />
          <div className="dist-body">
            <div className="dist-chart">
              <DonutChart
                data={donutData}
                height="100%"
                showLegend={false}
                centerLabel={t('dashboard.dist.center')}
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
          title={t('dashboard.top.title')}
          subtitle={
            topQuery.isLoading
              ? t('common.loading')
              : t('dashboard.top.subtitle', { n: topList.length || 8 })
          }
          icon={<IconActivity size={16} />}
          actions={
            <SegmentedControl<'cpu' | 'mem'>
              value={topTab}
              onChange={setTopTab}
              ariaLabel={t('dashboard.top.aria')}
              options={[
                { label: t('dashboard.top.memory'), value: 'mem' },
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
              title={t('dashboard.top.empty')}
              description={t('dashboard.top.emptyDesc')}
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
                  /* 榜单汇总全部连接：同名节点 + 同 VMID 在不同 PVE 上是两台机器，
                     只按 node+vmid 做 key 会撞键 */
                  key={`${v.connection_id ?? ''}-${v.node}-${v.vmid}`}
                  /* 走 guestPath：它会把 connection 一并带进详情页地址，
                     否则多集群下点进去可能落到另一台同名节点上的机器 */
                  to={guestPath({
                    node: v.node,
                    vmid: v.vmid,
                    type: 'qemu',
                    connection_id: v.connection_id,
                  })}
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
            title={t('dashboard.tasks.title')}
            subtitle={t('dashboard.tasks.subtitle')}
            icon={<IconTasks size={16} />}
            actions={
              isAdmin ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/tasks')}
                >
                  {t('dashboard.nodes.viewAll')}
                </Button>
              ) : undefined
            }
          />
        </div>
        <Table<TaskInfo>
          columns={taskColumns}
          rows={tasksQuery.data ?? []}
          rowKey={(task) => task.upid}
          loading={tasksQuery.isLoading}
          caption={t('dashboard.tasks.caption')}
          emptyTitle={t('dashboard.tasks.empty')}
          emptyDescription={t('dashboard.tasks.emptyDesc')}
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
      title={t('dashboard.title')}
      subtitle={
        /* 副标题走**全机队**口径：这里原先读 /cluster/status —— 那条接口只能读一台，
           套着四套 PVE 时页头只报其中一套的版本与仲裁，另一套掉仲裁也照样「正常」。
           现在与下面的「集群态势」卡用同一份 fleet 数据：版本去重后列出，
           态势取全机队最坏的那个。没 node.view 时整段不显示（否则会停在
           「加载中」这个永远转不完的假象）。 */
        !loadNodes
          ? undefined
          : fleetQuery.data
            ? [
                versionText ? `Proxmox VE ${versionText}` : '',
                t('dashboard.subtitle.posture', { state: postureLabel }),
              ]
                .filter(Boolean)
                .join(' · ')
            : t('dashboard.subtitle.loading')
      }
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              setRefreshing(true);
              /* 按前缀失效，而不是逐个 refetch：这个页面有 8 路查询（vms / nodes /
                 storages / cluster.status / cluster.tasks / cluster.ha-status /
                 dashboard.capacity / dashboard.top），逐个列一定会有漏 —— 原先就
                 漏了 HA、容量预测、Top 排行三路，点刷新后它们停在旧值不动。 */
              void queryClient.invalidateQueries({ queryKey: ['vms'] });
              void queryClient.invalidateQueries({ queryKey: ['nodes'] });
              void queryClient.invalidateQueries({ queryKey: ['storages'] });
              void queryClient.invalidateQueries({ queryKey: ['cluster'] });
              void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
            }}
            loading={refreshing}
          >
            {t('dashboard.refresh')}
          </Button>
          <Button
            variant={editing ? 'primary' : 'secondary'}
            icon={<IconLayout size={15} />}
            onClick={() => {
              setDragId(null);
              setEditing((value) => !value);
            }}
          >
            {editing ? t('dashboard.editDone') : t('dashboard.editLayout')}
          </Button>
          {/* 布局完全默认时不给这个按钮：没有可恢复的东西，点了只会困惑 */}
          {editing && !board.isDefault ? (
            <Button
              variant="ghost"
              icon={<IconRefresh size={15} />}
              onClick={() => void board.reset()}
            >
              {t('dashboard.resetLayout')}
            </Button>
          ) : null}
          {/* 落地页是虚拟机 / 容器列表，两类都看不了就不给这个入口
              （点进去只会撞上权限提示） */}
          {canGuest ? (
            <Button
              variant="primary"
              icon={<IconVm size={15} />}
              onClick={() => navigate('/vms')}
            >
              {t('dashboard.manageVms')}
            </Button>
          ) : null}
        </>
      }
    >
      {editing ? (
        <div className="widget-edit-hint">
          <IconLayout size={16} />
          <span>{t('dashboard.editHint')}</span>
        </div>
      ) : null}

      {/* 工作台：首页第一屏的「下一步做什么」。
          刻意放在可编辑卡片之外 —— 布局只负责数据卡片的顺序与显隐，
          待办与快捷入口是固定引导区，不该被拖走或隐藏。 */}
      <Workbench />

      {/* 一张卡片都渲染不出来时，给一句解释而不是留一片空白。
          两种「空」要分开说，出口完全不同：
            * 权限裁空 —— 这些数据本来就不对他开放，得找管理员开权限；
            * 自己全隐藏了 —— 右上角「编辑布局」里能加回来。
          两者混成一句，用户会照着错的出口去试。 */}
      {rows.length === 0 ? (
        board.visibleOrder.length === 0 ? (
          <EmptyState
            title={t('dashboard.emptyAllHidden')}
            description={t('dashboard.emptyAllHiddenDesc')}
          />
        ) : (
          <EmptyState
            title={t('dashboard.emptyNoAccess')}
            description={t('dashboard.emptyNoAccessDesc')}
          />
        )
      ) : (
        rows.map((row, index) =>
          row.length === 2 ? (
            <div key={`row-${index}`} className="grid grid-2 dashboard-split">
              {row.map(renderWidget)}
            </div>
          ) : (
            renderWidget(row[0])
          ),
        )
      )}

      {editing && hiddenWidgets.length > 0 ? (
        <Card collapsible={false}>
          <CardHeader
            title={t('dashboard.hiddenTitle')}
            subtitle={t('dashboard.hiddenSubtitle')}
            icon={<IconEye size={16} />}
          />
          <div className="form-row">
            {hiddenWidgets.map((meta) => (
              <Button
                key={meta.id}
                variant="ghost"
                size="sm"
                icon={<IconEye size={14} />}
                onClick={() => board.setHidden(meta.id, false)}
              >
                {t(meta.nameKey)}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ---- 集群态势明细：区域 → 连接 → 节点 ----
          KPI 卡只放得下一个三态结论，这里是它的下钻。层级语言与节点 / 网络 /
          存储三页一致（tree-head 标题条 + tree-body 竖线缩进），每一级都可折叠；
          区域默认展开、连接默认收起 —— 先看到「哪几套 PVE 有问题」，要看某台的
          节点再点开，异常项排在各组最前面。 */}
      <Modal
        open={postureOpen}
        onClose={() => setPostureOpen(false)}
        size="xl"
        title={t('dashboard.posture.detailTitle')}
        description={t('dashboard.posture.detailDesc')}
      >
        {fleetItems.length === 0 ? (
          <EmptyState title={t('dashboard.posture.empty')} compact />
        ) : (
          <div className="node-groups">
            {postureGroups.map((group) => {
              const regionCollapsed = closedPostureRegions.includes(group.id);
              const regionNodes = group.items.reduce(
                (n, item) =>
                  n + (nodesByConnection.get(String(item.id))?.length ?? 0),
                0,
              );
              return (
                /* 一级：区域 / 机房 */
                <section className="tree-group" key={`region:${group.id}`}>
                  {showPostureRegion ? (
                    <button
                      type="button"
                      className="tree-head is-region"
                      aria-expanded={!regionCollapsed}
                      onClick={() => togglePostureRegion(group.id)}
                    >
                      <span className="tree-head-icon">
                        <IconChevronDown size={15} />
                      </span>
                      <IconLayers size={15} />
                      <span className="tree-name">{group.label}</span>
                      <span className="tree-meta">
                        <Badge variant="neutral" size="sm">
                          {t('dashboard.posture.pveCount', {
                            n: group.items.length,
                          })}
                        </Badge>
                        <Badge variant="neutral" size="sm">
                          {t('dashboard.posture.nodeCount', { n: regionNodes })}
                        </Badge>
                      </span>
                    </button>
                  ) : null}

                  {regionCollapsed ? null : (
                    <div
                      className={
                        showPostureRegion ? 'tree-body' : 'flex flex-col gap-16'
                      }
                    >
                      {group.items.map((item) => {
                        const nodes =
                          nodesByConnection.get(String(item.id)) ?? [];
                        const connOpen = openPostureConns.includes(item.id);
                        return (
                          /* 二级：连接（一套 PVE）。默认收起，点开看它下面的节点 */
                          <section className="tree-group" key={`conn:${item.id}`}>
                            <button
                              type="button"
                              className="tree-head"
                              aria-expanded={connOpen}
                              onClick={() => togglePostureConn(item.id)}
                            >
                              <span className="tree-head-icon">
                                <IconChevronDown size={15} />
                              </span>
                              <span
                                className={`posture-dot ${postureItemDot(item)}`}
                              />
                              <span className="tree-name">{item.name}</span>
                              <span className="tree-meta">
                                <Badge
                                  variant={postureItemBadge(item)}
                                  size="sm"
                                >
                                  {postureItemLabel(item)}
                                </Badge>
                                <span className="posture-conn-meta">
                                  {item.ok
                                    ? itemMeta(item)
                                    : item.error ||
                                      t('dashboard.posture.unreachableShort')}
                                </span>
                              </span>
                            </button>

                            {connOpen ? (
                              /* 三级：这台主机上的具体节点 */
                              <div className="tree-body">
                                {nodes.length > 0 ? (
                                  nodes.map((node) => (
                                    <DashboardNodeRow
                                      key={`${item.id}:${node.node}`}
                                      node={node}
                                      hideConnection
                                    />
                                  ))
                                ) : (
                                  /* 连接通但一个节点都读不到：多半是令牌权限不足
                                     （PVE 对无权限的读取返回空列表而不是报错） */
                                  <p className="posture-empty">
                                    {item.ok
                                      ? t('dashboard.posture.nodesEmpty')
                                      : t('dashboard.posture.nodesUnreachable')}
                                  </p>
                                )}
                              </div>
                            ) : null}
                          </section>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </Modal>
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

function DashboardNodeRow({
  node,
  hideConnection = false,
}: {
  node: NodeInfo;
  /** 集群态势明细里第三级就挂在某个连接下，连接名上一级已经写了，不必重复 */
  hideConnection?: boolean;
}) {
  const t = useT();
  const offline = node.status !== 'online';
  const meta = nodeStatusMeta(node.status, t);

  const metrics = [
    {
      key: 'cpu',
      pct: toPercent(node.cpu),
      sub: node.maxcpu ? t('dashboard.nodes.cores', { n: node.maxcpu }) : '—',
    },
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
          {offline
            ? t('dashboard.nodes.offline')
            : t('dashboard.nodes.uptime', { uptime: formatUptimeShort(node.uptime) })}
          {node.connection_name && !hideConnection ? ` · ${node.connection_name}` : ''}
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
