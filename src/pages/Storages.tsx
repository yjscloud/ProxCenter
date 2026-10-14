/* ==========================================================================
   ProxCenter — 存储管理
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backupsApi, connectionsApi, nodesApi, storagesApi } from '../api/endpoints';
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
import { EmptyState, Notice } from '../components/ui/EmptyState';
import { PveQueryError } from '../components/SetupRequired';
import { usePveReady } from '../hooks/usePveStatus';
import { ProgressBar } from '../components/ui/ProgressBar';
import {
  IconStorage,
  IconRefresh,
  IconUpload,
  IconTrash,
  IconFolder,
  IconSearch,
  IconChevronDown,
  IconLayers,
  IconServer,
} from '../components/Icons';
import {
  formatBytes,
  formatDateTime,
  usageColor,
} from '../utils/format';
import { contentLabel, storageStatusMeta } from '../utils/status'
import { useT, type MessageKey } from '../i18n';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { Storage, StorageContent } from '../api/types';

const CONTENT_FILTERS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'storages.contentAll', value: '' },
  { label: 'storages.contentVm', value: 'vm' },
  { label: 'storages.contentIso', value: 'iso' },
  { label: 'storages.contentImport', value: 'import' },
  { label: 'storages.contentBackup', value: 'backup' },
  { label: 'storages.contentSnippets', value: 'snippets' },
];

/**
 * 存储内容列表的缓存时长。
 *
 * 这个接口是整页最慢的一环：PVE 侧要真的去扫存储目录（目录 / NFS / CIFS 型
 * 存储尤其慢）。而用户的操作节奏是「点开一个看一眼、再点开另一个」——
 * 60 秒内重开同一个存储直接复用上次结果，不再等第二次扫描。
 * 后端还有一层 20 秒的进程内缓存兜底（多人、多标签页）。
 */
const CONTENT_STALE_TIME = 60_000;

/**
 * 存储内容列表的 react-query key。
 *
 * 预取与正式查询共用这一个函数：两边各写一遍，早晚会写得不一样 ——
 * 那时预取照样发请求，点开却还是转圈，且没人查得出为什么。
 */
function contentQueryKey(storage: Storage | null, contentFilter: string) {
  return [
    'storages',
    'content',
    storage?.connection_id,
    storage?.node,
    storage?.storage,
    contentFilter,
  ] as const;
}

/**
 * 上传对话框里可选的内容类型。
 *
 * `value` 是**发给 PVE 的值**，必须是 PVE 的 `/storage/{id}/upload` 认的那种
 * 存储内容名。以前这里复用页面筛选用的本地取值（`vm`），而 PVE 里磁盘镜像
 * 叫 `images`——选了必然被 PVE 以非法枚举值拒掉；同时 PVE 真正支持的容器模板
 * 与备份反倒一个都没给。
 *
 * `accept` 是该类型常见的扩展名，只用于两处引导：文件选择器的默认过滤，以及
 * 选错文件时的当场提醒。真正的裁决者是 PVE，我们宁可放过一个少见的合法格式
 * （让 PVE 去判断），也不要凭猜测把用户挡在外面 —— 白名单写窄了比写宽更糟。
 */
interface UploadContentRule {
  value: string;
  label: MessageKey;
  accept: string;
}

const UPLOAD_CONTENTS: ReadonlyArray<UploadContentRule> = [
  { value: 'iso', label: 'storages.contentIso', accept: '.iso,.img' },
  {
    /* 磁盘镜像（cloud 镜像 / 模板盘）落点。PVE 的 iso 目录只认 .iso/.img，
       .qcow2 放进 iso 会被以「wrong extension」拒掉；import 目录才是它接受
       ova/qcow2/raw/vmdk 的地方，也正好是「从 cloud 镜像建模板」读取的来源。 */
    value: 'import',
    label: 'storages.contentImport',
    accept: '.qcow2,.raw,.vmdk,.ova',
  },
  {
    value: 'vztmpl',
    label: 'storages.contentVztmpl',
    accept: '.tar.gz,.tar.xz,.tar.zst,.tgz',
  },
  {
    value: 'backup',
    label: 'storages.contentBackup',
    accept: '.vma,.vma.gz,.vma.lzo,.tar,.tar.gz,.tar.zst,.tzst',
  },
  {
    value: 'snippets',
    label: 'storages.contentSnippets',
    accept: '.yaml,.yml,.sh,.conf,.txt',
  },
];

/** 文件名是否落在 accept 列出的扩展名里（大小写不敏感） */
function matchesAccept(filename: string, accept: string): boolean {
  const name = filename.trim().toLowerCase();
  if (!name) return false;
  return accept
    .split(',')
    .some((raw) => {
      const ext = raw.trim().toLowerCase();
      return ext.length > 0 && name.endsWith(ext);
    });
}

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

  /* 未配置连接时后端对每个请求都回 428，轮询没有意义（配好后自动恢复） */
  const pveReady = usePveReady();
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  const storagesQuery = useQuery({
    queryKey: ['storages', filterConn ?? '', filterNode ?? 'all'],
    queryFn: () => storagesApi.list(filterNode, filterConn),
    enabled: pveReady,
    refetchInterval: pveReady ? refresh : false,
  });

  const storages = storagesQuery.data ?? [];

  /* ---- 区域 / 节点 / 存储 三层 ----
     与「节点」页同一套层级：区域是填在连接上的标签（见连接配置），节点是存储实际
     所在的主机，存储是叶子。以前是一张平表、节点只是其中一列，池子一多就分不清
     哪块盘在哪台机器上；现在按层级收起来看。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
    staleTime: 300_000,
  });
  const conns = connectionsQuery.data ?? [];

  const regionGroups = useMemo(() => {
    const regionOf = (connId: string) => {
      const hit = conns.find((item) => String(item.id) === connId);
      return String(hit?.region || '').trim();
    };
    /* 连接名：存储列表自带的 connection_name 做兜底，连接表里能查到就用
       name → host（与地址池面板、网络页同一个口径） */
    const connLabelOf = (connId: string, fallback: string) => {
      const hit = conns.find((item) => String(item.id) === connId);
      return (
        String(hit?.name || hit?.host || fallback || '').trim() ||
        t('nodes.defaultConnection')
      );
    };

    // 先按「连接 + 节点」归拢：两台 PVE 上完全可能有同名节点，不能只按名字分
    const nodeMap = new Map<
      string,
      {
        key: string;
        node: string;
        connection_id: string;
        connection_name: string;
        storages: Storage[];
      }
    >();
    for (const item of storages) {
      const connId = item.connection_id ?? '';
      const key = `${connId}::${item.node}`;
      const hit = nodeMap.get(key);
      if (hit) {
        hit.storages.push(item);
      } else {
        nodeMap.set(key, {
          key,
          node: item.node,
          connection_id: connId,
          connection_name: item.connection_name ?? '',
          storages: [item],
        });
      }
    }
    const nodes = [...nodeMap.values()].sort(
      (a, b) =>
        a.node.localeCompare(b.node) ||
        a.connection_name.localeCompare(b.connection_name),
    );

    /* 区域 → 连接 → 节点：与「节点」「网络」两页同一套层级。
       先按区域分，再在区域内按连接分，最后把节点挂在各自的连接上。 */
    type ConnGroup = { id: string; label: string; nodes: typeof nodes };
    const regionMap = new Map<
      string,
      { id: string; label: string; conns: ConnGroup[] }
    >();
    for (const node of nodes) {
      const region = regionOf(node.connection_id);
      let regionHit = regionMap.get(region);
      if (!regionHit) {
        regionHit = {
          id: region,
          label: region || t('nodes.regionUnassigned'),
          conns: [],
        };
        regionMap.set(region, regionHit);
      }
      let connHit = regionHit.conns.find(
        (item) => item.id === node.connection_id,
      );
      if (!connHit) {
        connHit = {
          id: node.connection_id,
          label: connLabelOf(node.connection_id, node.connection_name),
          nodes: [],
        };
        regionHit.conns.push(connHit);
      }
      connHit.nodes.push(node);
    }
    /* 未分区排最后：它是兜底分组，不该排在有名字的区域前面。
       连接层按名称排，跨区域看时顺序才稳定。 */
    return [...regionMap.values()]
      .map((region) => ({
        ...region,
        conns: [...region.conns].sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => {
        if (Boolean(a.id) !== Boolean(b.id)) return a.id ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }, [storages, conns, t]);
  /** 一个区域都没配时，这一层整个不渲染（页面与改动前一样平铺节点） */
  const showRegion = regionGroups.some((group) => group.id !== '');
  /** 只有一条连接时「连接」那层只有一个取值，渲染出来除了占一行没有任何作用 */
  const showConnection =
    new Set(storages.map((item) => item.connection_id ?? '')).size > 1;

  /* 三级的折叠状态分两套语义，因为默认值刚好相反：
       * 区域 / 连接默认**展开**（存「已收起」）—— 进这一页就是来看存储的；
       * 节点默认**收起**（存「已展开」）—— 先把有哪些节点列出来，想看哪台上的
         存储池再点开，一屏能装下更多机器。
     节点存成「已展开」而不是「已收起」：默认值就是空数组，不必等数据到了再
     补一遍 id（那会先闪一帧全展开），定时刷新也不会把已展开的又收回去。 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const toggleGroup = (id: string) => {
    setCollapsedGroups((list) =>
      list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
    );
  };

  const [openNodes, setOpenNodes] = useState<string[]>([]);
  const toggleOpenNode = (key: string) => {
    setOpenNodes((list) =>
      list.includes(key) ? list.filter((value) => value !== key) : [...list, key],
    );
  };

  /* 工具栏那两个「全部收起 / 全部展开」要覆盖三级，但两级的存储语义不同，
     所以分成两组 id：可收起的（区域 + 连接）与可展开的（节点）。 */
  const collapsedIds = useMemo(
    () =>
      regionGroups.flatMap((region) => [
        `region:${region.id}`,
        ...(showConnection ? region.conns.map((conn) => `conn:${conn.id}`) : []),
      ]),
    [regionGroups, showConnection],
  );
  const nodeKeys = useMemo(
    () =>
      regionGroups.flatMap((region) =>
        region.conns.flatMap((conn) => conn.nodes.map((node) => node.key)),
      ),
    [regionGroups],
  );
  const allExpanded =
    collapsedGroups.length === 0 &&
    (nodeKeys.length === 0 || nodeKeys.every((key) => openNodes.includes(key)));
  const allCollapsed =
    openNodes.length === 0 &&
    collapsedIds.every((id) => collapsedGroups.includes(id));

  /* 展开的存储内容 */
  const contentQuery = useQuery({
    queryKey: contentQueryKey(selected, contentFilter),
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
    staleTime: CONTENT_STALE_TIME,
  });

  /* 鼠标移到某一行就先替它把内容取回来。
     PVE 扫目录的那几秒，用户通常还在把鼠标往行的左侧 / 那行按钮上挪 ——
     等点下去的时候数据已经到了（或正在路上），弹窗里直接就是表格。
     180ms 的防抖让「一路扫过十几行」只预取最后停下的那一行：每指到新的一行
     都会清掉上一个定时器，扫得快就一次都不发。 */
  const hoverTimer = useRef<number | null>(null);
  const prefetchContent = (item: Storage) => {
    void queryClient.prefetchQuery({
      queryKey: contentQueryKey(item, ''),
      queryFn: () =>
        storagesApi.content(
          { node: item.node, storage: item.storage },
          item.connection_id,
        ),
      staleTime: CONTENT_STALE_TIME,
    });
  };
  const onRowHover = (item: Storage) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => prefetchContent(item), 180);
  };

  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

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
            {/* 节点默认收起，得说清楚怎么展开、以及点存储池会发生什么 */}
            <span className="fs-sm text-muted">{t('storages.expandHint')}</span>
          </div>
          <div className="toolbar-right">
            <span className="fs-sm text-muted">
              {t('storages.activeRatio', {
                active: storages.filter((s) => s.active).length,
                total: storages.length,
              })}
            </span>
            {/* 与「节点」页同款：区域 / 连接收起、节点展开都归这两个按钮管 */}
            <div className="flex items-center gap-8">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCollapsedGroups([]);
                  setOpenNodes(nodeKeys);
                }}
                disabled={allExpanded}
              >
                {t('nodes.expandAll')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCollapsedGroups(collapsedIds);
                  setOpenNodes([]);
                }}
                disabled={allCollapsed}
              >
                {t('nodes.collapseAll')}
              </Button>
            </div>
          </div>
        </div>

        {!pveReady || storagesQuery.isError ? (
          <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            <PveQueryError
              title={t('storages.loadFailed')}
              error={storagesQuery.error}
              notImplemented={isNotImplemented(storagesQuery.error)}
              onRetry={() => void storagesQuery.refetch()}
            />
          </div>
        ) : storagesQuery.isLoading ? (
          <Card padded={false}>
            <TableSkeleton rows={5} cols={Math.min(columns.length, 8)} />
          </Card>
        ) : storages.length === 0 ? (
          <Card>
            <EmptyState
              title={t('storages.emptyTitle')}
              description={
                <>
                  {t('storages.emptyDescPre')}
                  <code className="mono">{t('storages.emptyDescPath')}</code>
                  {t('storages.emptyDescPost')}
                </>
              }
              action={
                <Button
                  variant="secondary"
                  icon={<IconRefresh size={15} />}
                  onClick={() => void storagesQuery.refetch()}
                  loading={storagesQuery.isFetching}
                >
                  {t('storages.refreshList')}
                </Button>
              }
              compact
            />
          </Card>
        ) : (
          /* 三层：区域 → 连接 → 节点，节点下是该节点上的存储表。
             层级语言与「节点」「网络」两页一致：三级都是 tree-head 标题条，
             内容缩进在 tree-body 的竖线里。 */
          <div className="node-groups">
            {regionGroups.map((region) => {
              const regionCollapsed = collapsedGroups.includes(`region:${region.id}`);
              const regionNodeCount = region.conns.reduce(
                (n, conn) => n + conn.nodes.length,
                0,
              );
              const regionStorageCount = region.conns.reduce(
                (n, conn) =>
                  n + conn.nodes.reduce((m, g) => m + g.storages.length, 0),
                0,
              );
              return (
                <section className="tree-group" key={`region:${region.id}`}>
                  {/* 一级：区域 / 机房（填在连接上的标签） */}
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
                          {t('storages.nodeCount', { n: regionNodeCount })}
                        </Badge>
                        <Badge variant="neutral" size="sm">
                          {t('storages.storageCount', {
                            n: regionStorageCount,
                          })}
                        </Badge>
                      </span>
                    </button>
                  ) : null}

                  {regionCollapsed ? null : (
                    /* 不渲染区域头时这一层也不该有缩进 */
                    <div
                      className={
                        showRegion ? 'tree-body' : 'flex flex-col gap-16'
                      }
                    >
                      {region.conns.map((conn) => {
                        const connCollapsed = collapsedGroups.includes(
                          `conn:${conn.id}`,
                        );
                        const connStorageCount = conn.nodes.reduce(
                          (n, g) => n + g.storages.length,
                          0,
                        );
                        return (
                          <section className="tree-group" key={`conn:${conn.id}`}>
                            {/* 二级：连接（存储所在的那台 PVE）。只有一条连接时
                                这一层只有一个取值，不渲染 */}
                            {showConnection ? (
                              <button
                                type="button"
                                className="tree-head"
                                aria-expanded={!connCollapsed}
                                onClick={() => toggleGroup(`conn:${conn.id}`)}
                              >
                                <span className="tree-head-icon">
                                  <IconChevronDown size={15} />
                                </span>
                                <IconServer size={15} />
                                <span className="tree-name">{conn.label}</span>
                                <span className="tree-meta">
                                  <Badge variant="neutral" size="sm">
                                    {t('storages.nodeCount', {
                                      n: conn.nodes.length,
                                    })}
                                  </Badge>
                                  <Badge variant="neutral" size="sm">
                                    {t('storages.storageCount', {
                                      n: connStorageCount,
                                    })}
                                  </Badge>
                                </span>
                              </button>
                            ) : null}

                            {connCollapsed ? null : (
                              <div
                                className={
                                  showConnection
                                    ? 'tree-body'
                                    : 'flex flex-col gap-16'
                                }
                              >
                                {conn.nodes.map((group) => {
                                  const nodeOpen = openNodes.includes(group.key);
                                  return (
                                    <section className="tree-group" key={group.key}>
                                      {/* 三级：节点（存储实际所在的主机）。默认收起，
                                          点开才列它上面的存储池。
                                          同名节点分属两台 PVE 时，靠上面那层连接区分 */}
                                      <button
                                        type="button"
                                        className="tree-head"
                                        aria-expanded={nodeOpen}
                                        onClick={() => toggleOpenNode(group.key)}
                                      >
                                        <span className="tree-head-icon">
                                          <IconChevronDown size={15} />
                                        </span>
                                        <IconServer size={15} />
                                        <span className="tree-name">
                                          {group.node}
                                        </span>
                                        <span className="tree-meta">
                                          <Badge variant="neutral" size="sm">
                                            {t('storages.storageCount', {
                                              n: group.storages.length,
                                            })}
                                          </Badge>
                                        </span>
                                      </button>

                                      {/* 内容：存储表。表格自带边框，直接缩进在竖线里 */}
                                      {nodeOpen ? (
                                        <div className="tree-body">
                                          <Table<Storage>
                                            /* 「节点」这一列在分层视图里是重复信息
                                               （组标题已经写了），去掉，把横向空间
                                               留给容量 */
                                            columns={columns.filter(
                                              (col) => col.key !== 'node',
                                            )}
                                            rows={group.storages}
                                            rowKey={(s) =>
                                              `${s.connection_id ?? ''}/${s.node}/${s.storage}`
                                            }
                                            caption={t('storages.caption')}
                                            onRowHover={onRowHover}
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
                                          />
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
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- 内容浏览：点存储池弹出的窗口 ----
          以前这块内容铺在页面最下面：点一行存储，页面底部长出一大块表格，
          想对比另一个存储池就得先滚到底、再滚回来点。改成居中弹窗之后，列表
          始终停在原地，浏览与上传都在窗里完成，关掉就回到刚才那一行。 */}
      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        size="xl"
        title={t('storages.contentTitle', { storage: selected?.storage ?? '' })}
        /* 窗里还会再弹出「上传」「删除确认」两个弹窗：它们开着时这个窗不该
           跟着 Esc 一起关（三个弹窗都在 document 上监听 Esc，都会收到） */
        closeOnEsc={!uploadOpen && !deleteTarget}
        description={
          selected ? (
            <span className="flex items-center gap-8 flex-wrap">
              <Badge variant="neutral" size="sm">
                {selected.node}
              </Badge>
              <Badge variant="neutral" size="sm">
                {selected.type}
              </Badge>
              <span>{t('storages.avail', { size: formatBytes(selected.avail) })}</span>
            </span>
          ) : undefined
        }
      >
        {selected ? (
          <div className="flex flex-col gap-16">
            <div className="flex items-center justify-between gap-12 flex-wrap">
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
              </div>
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
            </div>

            {contentNotImpl ? (
              <Notice tone="info" title={t('storages.notImplTitle')}>
                {t('storages.contentNotImpl')}
              </Notice>
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
              />
            )}
          </div>
        ) : null}
      </Modal>

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

  /* 默认内容类型：ISO 优先（最常见），否则取这台存储支持的第一项 */
  useEffect(() => {
    if (!storage) return;
    const types = new Set(storage.content.split(/[,;]/).map((c) => c.trim()));
    const preferred = UPLOAD_CONTENTS.find(
      (c) => c.value === 'iso' && types.has('iso'),
    );
    const fallback = UPLOAD_CONTENTS.find((c) => types.has(c.value));
    setContent((preferred ?? fallback ?? UPLOAD_CONTENTS[0]).value);
  }, [storage]);

  /* 可选的内容类型 = 上传接口接受的类型 ∩ 这台存储声明支持的类型。
     不按存储过滤 PVE 也会拒，但给了就是白给：用户选了只收到一句报错，
     还得自己猜哪里不对。 */
  const availableContents = useMemo(() => {
    if (!storage) {
      return UPLOAD_CONTENTS.map((c) => ({ label: t(c.label), value: c.value }));
    }
    const types = new Set(storage.content.split(/[,;]/).map((c) => c.trim()));
    const matched = UPLOAD_CONTENTS.filter((c) => types.has(c.value));
    /* 一个都不匹配（例如只支持 images 的存储）：退回第一项，否则下拉是空的，
       用户连「选错类型」的机会都没有 */
    const usable = matched.length > 0 ? matched : [UPLOAD_CONTENTS[0]];
    return usable.map((c) => ({ label: t(c.label), value: c.value }));
  }, [storage, t]);

  /* 当前内容类型接受的扩展名：文件选择器与「选错了当场说」都用它 */
  const accept = UPLOAD_CONTENTS.find((c) => c.value === content)?.accept ?? '';

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (f.size === 0) {
      toast.error(t('storages.fileInvalid'), t('storages.fileEmpty'));
      return;
    }
    /* 扩展名对不上就当场说清楚。accept 只影响文件选择器的默认过滤，用户仍能
       选「所有文件」、或者把文件直接拖进来 —— 等传到 PVE 那边被拒，几 GB 的
       文件已经白传完了。 */
    const rule = UPLOAD_CONTENTS.find((c) => c.value === content);
    if (rule && !matchesAccept(f.name, rule.accept)) {
      toast.error(
        t('storages.uploadExtRejected'),
        t('storages.uploadExtRejectedBody', {
          name: f.name,
          kind: t(rule.label),
          accept: rule.accept,
        }),
      );
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
                  {t('storages.dropFormats', { formats: accept })}
                </div>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => pickFile(e.target.files?.[0])}
            accept={accept}
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
