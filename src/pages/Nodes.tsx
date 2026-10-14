/* ==========================================================================
   ProxCenter — 节点
   ==========================================================================

   这一页承担两件事，因为它们本来就是同一个问题的两面：

   1. **看节点**：多台 PVE、每台若干节点时，平铺的大卡片很快就会变成
      「一片长得差不多的方块」—— 45 个节点要滚五六屏才看完，还看不出谁在冒烟。
      所以按「区域 → 连接 → 节点」铺成三层树（与网络页同一套层级语言：
      每层一个可折叠的标题条，缩进用一条竖线画出来），每个节点是一张独立卡片：
      卡头写它是谁、活没活着，卡体是 CPU / 内存 / 磁盘与备注。
   2. **管连接**：节点连不上时，要修的是「连接」，不是节点本身。连接配置
      因此挪到了同一功能域下的子页面 `/nodes/connections`（点顶部子页签或
      「添加节点」都能进）—— 但它不该和节点列表挤在一页：那张表单很长，
      混在下面会把节点列表顶到屏幕外。
   ========================================================================== */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clusterApi, connectionsApi, nodesApi } from '../api/endpoints';
import { errorMessage, isNotConfigured } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Input, Select } from '../components/ui/Input';
import { CardSkeleton } from '../components/ui/Spinner';
import { EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { SetupRequired } from '../components/SetupRequired';
import { NodeSubNav } from '../components/NodeSubNav';
import {
  IconServer,
  IconRefresh,
  IconCpu,
  IconMemory,
  IconDisk,
  IconActivity,
  IconClose,
  IconPlus,
  IconSearch,
  IconChevronRight,
  IconChevronDown,
  IconPlug,
  IconLayers,
} from '../components/Icons';
import {
  formatBytes,
  formatUptime,
  formatUptimeShort,
  toPercent,
  usageColor,
} from '../utils/format';
import { nodeStatusMeta } from '../utils/status'
import { useT, type MessageKey } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import { useGlobalScope } from '../hooks/useGlobalScope';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { NodeNoteField, useNodeMeta } from '../components/NodeMeta';
import type { NodeInfo } from '../api/types';

/* 「集群失去仲裁」提示的关闭状态记忆键 */
const QUORUM_NOTICE_KEY = 'pve_quorum_notice_dismissed';

type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'status';

const SORT_OPTIONS: Array<{ label: MessageKey; value: SortKey }> = [
  { label: 'nodes.sortName', value: 'name' },
  { label: 'nodes.sortCpu', value: 'cpu' },
  { label: 'nodes.sortMem', value: 'mem' },
  { label: 'nodes.sortDisk', value: 'disk' },
  { label: 'nodes.sortStatus', value: 'status' },
];

export function Nodes() {
  const t = useT();
  const navigate = useNavigate();
  /* 连接写操作需要 settings.manage，仅管理员可进入表单 */
  const { isAdmin } = useAuth();
  /* 顶栏的集群作用域（空串 = 全部集群）：页头那行读数与下方列表都跟着它，
     而仲裁告警不受它影响（见下面 quorum 那段的说明） */
  const scope = useGlobalScope();

  /* ---- 筛选 ---- */
  const [search, setSearch] = useState('');
  const [connFilter, setConnFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');

  /* 提示允许用户关掉，关掉后记住；等仲裁恢复正常会自动清掉标记，
     这样下次真出问题时还会重新提醒，而不是永久失声 */
  const [quorumDismissed, setQuorumDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(QUORUM_NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  });

  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    /* 面板还没配置连接时，后端对每个请求都回 428：继续轮询只会刷一屏
       没人看的报错（重试也已在 main.tsx 关掉）。配好之后自动恢复轮询。 */
    refetchInterval: (query) =>
      isNotConfigured(query.state.error) ? false : refresh,
  });

  /* 机队（全部连接）的合计状态。页头那行「集群版本 / 仲裁」以前取自
     `/cluster/status` —— 那条接口一次只能读**默认那一台**，于是 4 套连接里
     非默认的那几套失去仲裁时，页头照样一片绿（仪表盘的集群态势卡踩过同一个坑）。
     换用 fleet-status 之后页头与告警都是全机队口径，且与顶栏「控制台状态」、
     设置页共用同一份缓存，不多发请求。 */
  const fleetQuery = useQuery({
    queryKey: ['cluster', 'fleet-status'],
    queryFn: clusterApi.fleetStatus,
    refetchInterval: refresh,
    retry: false,
  });

  /* 多台 PVE 同时在线：哪台连不上要能说明白，否则「列表里少了一台」会被误当成 bug */
  const connStatusQuery = useQuery({
    queryKey: ['connections', 'status'],
    queryFn: connectionsApi.status,
    refetchInterval: refresh,
    retry: false,
  });
  const failedConnections = (connStatusQuery.data ?? []).filter((c) => !c.ok);
  /* 连得上但读不到指标 = 令牌权限不足，PVE 会把虚拟机/模板返回成空列表 */
  const limitedConnections = (connStatusQuery.data ?? []).filter(
    (c) => c.ok && !c.node_metrics,
  );

  /* 连接列表：只为「区域标签」而读（节点按「区域 → 连接 → 节点」分组）。
     这里**不按 isAdmin 关掉** —— 区域分组所有用户都要用，接口本身也只要求登录。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
  });
  const conns = connectionsQuery.data ?? [];

  const list = useMemo(() => nodesQuery.data ?? [], [nodesQuery.data]);

  /* ---- 过滤 + 排序 ----
     排序把「有问题」的排前面，而不是只按字母：运维打开这一页通常是为了
     找谁在冒烟，不是来查通讯录的。 */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const connId = connFilter || '';
    const filtered = list.filter((n) => {
      if (connId && (n.connection_id ?? '') !== connId) return false;
      if (!q) return true;
      const haystack = [n.node, n.connection_name, n.level, n.kernel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    const score = (n: NodeInfo) => {
      switch (sortKey) {
        case 'cpu':
          return toPercent(n.cpu);
        case 'mem':
          return n.maxmem ? ((n.mem ?? 0) / n.maxmem) * 100 : 0;
        case 'disk':
          return n.maxdisk ? ((n.disk ?? 0) / n.maxdisk) * 100 : 0;
        case 'status':
          // 离线 / 未知排前面，其余按名称
          return n.status === 'online' ? 1 : 0;
        default:
          return 0;
      }
    };

    return [...filtered].sort((a, b) => {
      if (sortKey === 'name') return a.node.localeCompare(b.node);
      if (sortKey === 'status') {
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        return a.node.localeCompare(b.node);
      }
      // 负载类排序：占用高的在前
      const diff = score(b) - score(a);
      if (Math.abs(diff) > 0.0001) return diff;
      return a.node.localeCompare(b.node);
    });
  }, [list, search, connFilter, sortKey]);

  /* ---- 按来源 PVE 分组 ----
     多主机同名节点最容易踩坑，分组后「这是哪台机器上的 node1」一目了然；
     只有一条连接时不分组（组标题纯属占地方）。 */
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; nodes: NodeInfo[] }>();
    for (const node of visible) {
      const key = node.connection_id ?? '';
      const existing = map.get(key);
      if (existing) {
        existing.nodes.push(node);
      } else {
        map.set(key, {
          label: node.connection_name || node.node || t('nodes.defaultConnection'),
          nodes: [node],
        });
      }
    }
    return [...map.entries()].map(([id, value]) => ({ id, ...value }));
  }, [visible, t]);
  const grouped = groups.length > 1;

  /* ---- 区域 / 机房（填在连接上的标签）----
     多机房时它比连接更粗一级：否则七八条连接还是平铺在一起，只是平铺的单位从
     节点变成了连接。一条连接都没填区域时这一层整个不渲染，页面与改动前一致。 */
  const regionGroups = useMemo(() => {
    const regionOf = (connId: string) => {
      const hit = conns.find((item) => String(item.id) === connId);
      return String(hit?.region || '').trim();
    };
    const map = new Map<
      string,
      { id: string; label: string; conns: typeof groups }
    >();
    for (const group of groups) {
      const region = regionOf(group.id);
      let hit = map.get(region);
      if (!hit) {
        hit = {
          id: region,
          label: region || t('nodes.regionUnassigned'),
          conns: [],
        };
        map.set(region, hit);
      }
      hit.conns.push(group);
    }
    /* 未分区排最后：它是兜底分组，不该排在有名字的区域前面 */
    return [...map.values()].sort((a, b) => {
      if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [groups, conns, t]);
  const showRegion = regionGroups.some((group) => group.id !== '');

  /* 两级折叠状态分两套语义，因为默认值刚好相反：
       * 区域默认**展开**（存「已收起」）—— 区域一般只有一两个，收起它等于把内容藏两层；
       * 连接默认**收起**（存「已展开」）—— 节点一多要滚好几屏，先列出有哪些 PVE、
         想看哪台再点开；节点卡本身也是默认收起（见 NodeCard），点开才看指标。
     连接存成「已展开」而不是「已收起」：默认值就是空数组，不必等节点数据到了再
     挨个补 id（那会先闪一帧全展开），10 秒轮询也不会把已展开的连接又收回去。 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const toggleGroup = (id: string) => {
    setCollapsedGroups((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  };

  const [openConns, setOpenConns] = useState<string[]>([]);
  const toggleOpenConn = (id: string) => {
    setOpenConns((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  };

  /* 工具栏那个「全部展开 / 全部收起」要覆盖两级，但两级语义相反，
     所以分成两组 id：一组往 collapsedGroups 里放，一组往 openConns 里放。 */
  const regionIds = useMemo(
    () => (showRegion ? regionGroups.map((g) => g.id) : []),
    [regionGroups, showRegion],
  );
  const connIds = useMemo(
    () => (grouped ? groups.map((g) => g.id) : []),
    [groups, grouped],
  );
  const allCollapsed =
    openConns.length === 0 &&
    regionIds.every((id) => collapsedGroups.includes(`region:${id}`));

  const connectionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of list) {
      const id = n.connection_id ?? '';
      if (!seen.has(id)) seen.set(id, n.connection_name || t('nodes.defaultConnection'));
    }
    return [
      { label: t('nodes.allHosts'), value: '' },
      ...[...seen.entries()].map(([value, label]) => ({ label, value })),
    ];
  }, [list, t]);

  /* ---- 仲裁（告警全机队、标题跟随作用域）----
     告警逐个连接看，而不是只看兜底那台：失去仲裁意味着那个集群进入只读保护，
     是最高级别的异常 —— 它**不跟顶栏作用域走**，聚焦 A 集群时 B 集群掉仲裁
     照样要报（提示里会点名是哪几台，不会看不懂）。
     后端在「单机（未组集群）」时返回 quorate=null —— 那不是失去仲裁，不能报警，
     所以必须用 === false 判断。 */
  const fleet = fleetQuery.data;
  const fleetItems = fleet?.connections ?? [];
  const noQuorumConns = fleetItems.filter((c) => c.quorate === false);
  const showQuorumWarning = noQuorumConns.length > 0 && !quorumDismissed;

  /* 页头那行读数描述的是**当前正在看的东西**：聚焦某套集群时，
     「几个连接 / 几个集群 / 仲裁如何」都只算那一套（节点数与在线数来自下面
     这份列表，它本来就会被作用域过滤）。告警仍是全机队的。 */
  const scopedFleet = scope
    ? fleetItems.filter((c) => c.id === scope)
    : fleetItems;
  const scopedNoQuorum = scopedFleet.filter((c) => c.quorate === false);
  const scopedClusters = scopedFleet.filter(
    (c) => c.cluster_mode === 'cluster',
  ).length;
  const quorumLabel =
    scopedNoQuorum.length > 0
      ? t('nodes.quorumBadCount', { n: scopedNoQuorum.length })
      : t('nodes.quorumOk');

  const onlineCount = list.filter((n) => n.status === 'online').length;

  /* 仲裁恢复正常 → 清掉「已关闭」标记，下次真异常时重新提示 */
  useEffect(() => {
    if (noQuorumConns.length > 0 || !quorumDismissed) return;
    setQuorumDismissed(false);
    try {
      localStorage.removeItem(QUORUM_NOTICE_KEY);
    } catch {
      /* 忽略 */
    }
    // noQuorumConns 每次渲染都是新数组，这里只关心「还有没有失去仲裁的集群」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noQuorumConns.length, quorumDismissed]);

  const dismissQuorumNotice = () => {
    setQuorumDismissed(true);
    try {
      localStorage.setItem(QUORUM_NOTICE_KEY, '1');
    } catch {
      /* 忽略 */
    }
  };

  /* 一个连接分组里「几台在线」的文案（列表视图与卡片视图共用） */
  const onlineRatioOf = (nodes: NodeInfo[]) =>
    t('nodes.onlineRatio', {
      online: nodes.filter((n) => n.status === 'online').length,
      total: nodes.length,
    });

  const openDetail = (node: NodeInfo) =>
    navigate(
      `/nodes/${encodeURIComponent(node.node)}${
        node.connection_id ? `?conn=${encodeURIComponent(node.connection_id)}` : ''
      }`,
    );

  /* 「添加节点」= 接入一台新的 Proxmox 主机：跳到连接配置子页面并直接
     摊开「新增连接」表单（?new=1 由 ConnectionManager 读取） */
  const addNode = () => navigate('/nodes/connections?new=1');

  return (
    <PageShell
      title={
        <>
          <IconServer size={20} />
          {t('nodes.title')}
        </>
      }
      subtitle={
        fleet
          ? t('nodes.subtitleFleet', {
              connections: scopedFleet.length,
              clusters: scopedClusters,
              /* 节点数与在线数取页面上这份列表，与下方列表、工具条的
                 「显示 x / y 个节点」同一口径（它同样会被作用域过滤） */
              online: onlineCount,
              total: list.length,
              quorum: quorumLabel,
            })
          : t('dashboard.subtitle.loading')
      }
      actions={
        <>
          {isAdmin ? (
            <Button
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={addNode}
              title={t('nodes.addNodeTitle')}
            >
              {t('nodes.addNode')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => {
              void nodesQuery.refetch();
              void fleetQuery.refetch();
              void connStatusQuery.refetch();
            }}
            loading={nodesQuery.isFetching && !nodesQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      <NodeSubNav active="nodes" />

      {/* 失去仲裁的集群逐个点名：只报「有一个」而不说是哪个，等于把排障的
          第一步留给用户。「读取哪一台」不再由这一页决定 —— 集群级接口的兜底
          目标移到了「设置 → 系统信息」，这里只呈现全机队的事实。 */}
      {showQuorumWarning ? (
        <Notice
          tone="danger"
          title={t('nodes.quorumNoticeTitle')}
          action={
            <IconButton label={t('nodes.dismissNotice')} onClick={dismissQuorumNotice}>
              <IconClose size={15} />
            </IconButton>
          }
        >
          {t('nodes.quorumNoticeBody')}
          {noQuorumConns.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
        </Notice>
      ) : null}

      {failedConnections.length > 0 ? (
        <Notice
          tone="warning"
          title={t('nodes.failedConnsTitle', { n: failedConnections.length })}
        >
          {t('nodes.failedConnsBody')}
          {failedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {isAdmin ? t('nodes.failedConnsTailAdmin') : t('nodes.failedConnsTailUser')}
          {isAdmin ? (
            <div className="mt-8">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/nodes/connections')}
              >
                {t('nodes.goConnections')}
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {limitedConnections.length > 0 ? (
        <Notice
          tone="warning"
          title={t('nodes.limitedConnsTitle', { n: limitedConnections.length })}
        >
          {t('nodes.limitedConnsBody')}
          {limitedConnections.map((c) => (
            <span key={c.id} className="mono">
              {' '}
              {c.name || c.host}
            </span>
          ))}
          {isAdmin ? t('nodes.limitedConnsTailAdmin') : t('nodes.limitedConnsTailUser')}
        </Notice>
      ) : null}

      {/* ---- 工具栏：节点多时才值得占一行 ---- */}
      {list.length > 3 ? (
        <div className="toolbar">
          <div className="toolbar-left">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('nodes.searchPlaceholder')}
              prefix={<IconSearch size={15} />}
              block={false}
              aria-label={t('nodes.searchAria')}
            />
            {connectionOptions.length > 2 ? (
              <Select
                value={connFilter}
                onChange={(e) => setConnFilter(e.target.value)}
                options={connectionOptions}
                aria-label={t('nodes.filterConnAria')}
              />
            ) : null}
            <Select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              options={SORT_OPTIONS.map((s) => ({ label: t(s.label), value: s.value }))}
              aria-label={t('nodes.sortAria')}
            />
            {/* 连接与节点卡都是默认收起的：不说清楚怎么展开，一列标题条
                会被读成「这里没有节点」。
                但只有一条连接时**连接那一层不渲染**（见 grouped），提示里
                再写「点击连接展开」就是在让人去点一个不存在的东西。 */}
            <span className="fs-sm text-muted">
              {t(grouped ? 'nodes.expandHint' : 'nodes.expandHintSingle')}
            </span>
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              {t('nodes.showing', { shown: visible.length, total: list.length })}
            </span>
            {/* 分组默认展开（区域）或收起（连接）；节点一多时一键切换，省得一个个点 */}
            {regionIds.length + connIds.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                icon={
                  allCollapsed ? (
                    <IconChevronDown size={14} />
                  ) : (
                    <IconChevronRight size={14} />
                  )
                }
                onClick={() => {
                  if (allCollapsed) {
                    setCollapsedGroups([]);
                    setOpenConns(connIds);
                  } else {
                    setCollapsedGroups(regionIds.map((id) => `region:${id}`));
                    setOpenConns([]);
                  }
                }}
              >
                {allCollapsed ? t('nodes.expandAll') : t('nodes.collapseAll')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {nodesQuery.isLoading ? (
        <CardSkeleton count={3} height={220} />
      ) : nodesQuery.isError ? (
        /* 「还没配连接」不是故障：换成引导态（去添加），别给重试 ——
           未配置时重试永远失败，只会让用户以为面板坏了。 */
        isNotConfigured(nodesQuery.error) ? (
          <SetupRequired />
        ) : (
          <ErrorState
            title={t('nodes.loadFailed')}
            message={errorMessage(nodesQuery.error)}
            onRetry={() => void nodesQuery.refetch()}
          />
        )
      ) : list.length === 0 ? (
        <Card>
          {/* 「列表空」有两种原因，不该共用一句文案：真没接主机（该去添加），
              还是接了但令牌读不到节点（该去修权限）。后者提示「添加节点」会让人
              往完全错误的方向走 —— 连接明明已经在那儿了。 */}
          <EmptyState
            title={t('nodes.emptyTitle')}
            description={
              !isAdmin
                ? t('nodes.emptyUser')
                : limitedConnections.length > 0
                  ? t('nodes.emptyPermission')
                  : t('nodes.emptyAdmin')
            }
            icon={<IconServer size={30} />}
            action={
              isAdmin ? (
                limitedConnections.length > 0 ? (
                  <Button
                    variant="secondary"
                    icon={<IconPlug size={15} />}
                    onClick={() => navigate('/nodes/connections')}
                  >
                    {t('setup.pveManage')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    icon={<IconPlus size={15} />}
                    onClick={addNode}
                  >
                    {t('nodes.addNode')}
                  </Button>
                )
              ) : undefined
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={t('nodes.noMatchTitle')}
            description={t('nodes.noMatchDesc')}
            compact
          />
        </Card>
      ) : (
        <div className="node-groups">
          {regionGroups.map((region) => {
            const regionCollapsed = collapsedGroups.includes(
              `region:${region.id}`,
            );
            const regionNodeCount = region.conns.reduce(
              (n, group) => n + group.nodes.length,
              0,
            );
            return (
              <section className="tree-group" key={`region:${region.id}`}>
                {/* 一级：区域 / 机房。整条都是开关 */}
                {showRegion ? (
                  <button
                    type="button"
                    className="tree-head is-region"
                    aria-expanded={!regionCollapsed}
                    onClick={() => toggleGroup(`region:${region.id}`)}
                  >
                    <span className="tree-head-icon">
                      <IconChevronDown size={15} />
                    </span>
                    <IconLayers size={15} />
                    <span className="tree-name">{region.label}</span>
                    <span className="tree-meta">
                      <Badge variant="neutral" size="sm">
                        {t('nodes.pveCount', { n: region.conns.length })}
                      </Badge>
                      <Badge variant="neutral" size="sm">
                        {t('nodes.nodeCount', { n: regionNodeCount })}
                      </Badge>
                    </span>
                  </button>
                ) : null}

                {regionCollapsed ? null : (
                  /* 不渲染区域头时这一层也不该有缩进（与网络页同一套写法） */
                  <div
                    className={
                      showRegion ? 'tree-body' : 'flex flex-col gap-16'
                    }
                  >
                    {region.conns.map((group) => {
/* 没有标题条时必须**当作展开**。
                         标题条只在多条连接时渲染（见下面的 grouped），而 openConns
                         默认是空 —— 于是只有一条 PVE 时既没有可点的开关、
                         卡片又被判成收起，页面看着像「这台 PVE 没有节点」。
                         折叠是为了省滚动，不是为了把内容藏掉且再也拿不出来。

                         网络页是同一套三层树，那边从一开始就写对了
                         （Networks.tsx 的 ``!showConnection || expandedConns…``）；
                         这里是照它抄的时候漏了那半个条件。 */
                      const connOpen =
                        !grouped || openConns.includes(group.id);
                      const offlineCount = group.nodes.filter(
                        (n) => n.status !== 'online',
                      ).length;
                      return (
                        <section
                          className="tree-group"
                          key={group.id || 'default'}
                        >
                          {/* 二级：连接。与区域同款的标题条，整行可折叠 */}
                          {grouped ? (
                            <button
                              type="button"
                              className="tree-head"
                              aria-expanded={connOpen}
                              title={onlineRatioOf(group.nodes)}
                              onClick={() => toggleOpenConn(group.id)}
                            >
                              <span className="tree-head-icon">
                                <IconChevronDown size={15} />
                              </span>
                              <IconServer size={15} />
                              <span className="tree-name">{group.label}</span>
                              <span className="tree-meta">
                                <Badge variant="neutral" size="sm">
                                  {t('nodes.nodeCount', {
                                    n: group.nodes.length,
                                  })}
                                </Badge>
                                {offlineCount > 0 ? (
                                  <Badge variant="warning" size="sm" dot>
                                    {t('nodes.offlineCount', {
                                      n: offlineCount,
                                    })}
                                  </Badge>
                                ) : null}
                              </span>
                            </button>
                          ) : null}

                          {connOpen ? (
                            /* 三级：节点卡。每行一张，缩进用竖线画出来 */
                            <div
                              className={
                                grouped ? 'tree-body' : 'flex flex-col gap-16'
                              }
                            >
                              {group.nodes.map((node) => (
                                <NodeCard
                                  key={`${node.connection_id ?? ''}:${node.node}`}
                                  node={node}
                                  onOpen={() => openDetail(node)}
                                />
                              ))}
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
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   指标百分比（卡片与列表共用同一套口径）
   --------------------------------------------------------------------------- */

function nodePercents(node: NodeInfo) {
  return {
    cpu: toPercent(node.cpu),
    mem: node.maxmem > 0 ? ((node.mem ?? 0) / node.maxmem) * 100 : 0,
    disk: node.maxdisk > 0 ? ((node.disk ?? 0) / node.maxdisk) * 100 : 0,
  };
}

/* ---------------------------------------------------------------------------
   节点卡：层级树里的一个节点
   ---------------------------------------------------------------------------
   卡头回答「这是谁、活没活着、什么时候进来的」，卡体是 CPU / 内存 / 磁盘 与
   运行时长、备注。骨架与网络页的节点卡一致（Card + CardHeader + 卡片内衬），
   两页看起来才是同一个东西。

   但这里的卡**默认收起**：这一页的主任务是「先看有哪些节点、谁不在线」，
   一屏列完比每台都摊开指标更有用；要看某台的负载，点一下卡头即可展开。
   --------------------------------------------------------------------------- */

function NodeCard({ node, onOpen }: { node: NodeInfo; onOpen: () => void }) {
  const t = useT();
  const { hasPermission } = useAuth();
  /* 节点备注写在面板自己的库里（见 node_notes.py），后端要 `node.view` ——
     这里与它保持一致，不再用「是不是非只读用户」的角色粗判 */
  const canEditNote = hasPermission('node.view');
  const pct = nodePercents(node);
  const meta = nodeStatusMeta(node.status, t);
  const offline = node.status !== 'online';
  /* 地址与 PVE 版本是按需拉取的补充信息 */
  const { version, address } = useNodeMeta(node.node, !offline, node.connection_id);

  /* 卡头副标题：PVE 版本（没有版本就退到内核）+ 管理地址，中间用点分开 */
  const spec = [
    version
      ? t('nodes.pveVersion', { version })
      : node.kernel
        ? t('nodes.kernel', { kernel: node.kernel })
        : '',
    address,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card padded={false} className="card-head-inset" defaultOpen={false}>
      <CardHeader
        icon={<IconServer size={16} />}
        title={
          /* 卡头只留下结论（活没活着、是不是在维护）—— 连接名归属上层标题条，
             版本与地址是副标题，指标全在卡体里 */
          <span className="flex items-center gap-8 flex-wrap">
            <span>{node.node}</span>
            <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
              {meta.label}
            </Badge>
            {node.level ? (
              <Badge
                variant="warning"
                size="sm"
                title={t('nodes.maintenanceLevel', { level: node.level })}
              >
                {t('nodes.maintenance')}
              </Badge>
            ) : null}
          </span>
        }
        subtitle={spec || undefined}
        actions={
          <Button
            variant="ghost"
            size="sm"
            iconRight={<IconChevronRight size={14} />}
            aria-label={t('nodes.viewNodeAria', { node: node.node })}
            onClick={onOpen}
          >
            {t('nodes.viewDetail')}
          </Button>
        }
      />

      {/* 卡体：左边三根指标条（宽度归它们，进度条才看得出差别），
          右边是运行时长与备注 —— 一屏看下来视线不用来回跳 */}
      <div className="node-card-body">
        <div className="node-metrics">
          <NodeMetric
            icon={<IconCpu size={12} />}
            label={t('nodes.colCpu')}
            percent={pct.cpu}
            sub={node.maxcpu ? t('dashboard.nodes.cores', { n: node.maxcpu }) : '—'}
            offline={offline}
          />
          <NodeMetric
            icon={<IconMemory size={12} />}
            label={t('nodes.colMem')}
            percent={pct.mem}
            sub={formatBytes(node.maxmem, 0)}
            offline={offline}
          />
          <NodeMetric
            icon={<IconDisk size={12} />}
            label={t('nodes.colDisk')}
            percent={pct.disk}
            sub={formatBytes(node.maxdisk, 0)}
            offline={offline}
          />
        </div>

        <div className="node-card-aside">
          <span className="fs-sm text-secondary flex items-center gap-6">
            <IconActivity size={12} />
            <span title={offline ? undefined : formatUptime(node.uptime)}>
              {offline ? t('nodes.offline') : formatUptimeShort(node.uptime)}
            </span>
          </span>
          <NodeNoteField node={node.node} canEdit={canEditNote} />
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   指标格：图标 + 名称 + 大数值 + 迷你进度条 + 规格
   把「百分比」「进度条」「总量」收在一格内，避免同一份数据在卡片里出现两次。
   --------------------------------------------------------------------------- */

function NodeMetric({
  icon,
  label,
  percent,
  sub,
  offline,
}: {
  icon: ReactNode;
  label: string;
  percent: number;
  sub: string;
  offline: boolean;
}) {
  const color = offline ? 'var(--text-muted)' : usageColor(percent);
  return (
    <div className="node-metric">
      <div className="node-metric-head">
        <span className="node-metric-label">
          {icon} {label}
        </span>
        <span className="node-metric-value" style={{ color }}>
          {offline ? '—' : `${percent.toFixed(1)}%`}
        </span>
      </div>
      <ProgressBar value={offline ? 0 : percent} color={color} height={6} />
      <span className="node-metric-sub">{sub}</span>
    </div>
  );
}
