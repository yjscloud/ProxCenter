/* ==========================================================================
   ProxCenter — 端口与进程（异常检测）

   两层信息架构，与「安全基线」保持一致：

   * **全平台总览**：每台服务器一张卡片（非预期开放端口 + 可疑进程 + 防火墙状态），
     最需要看的排最前；
   * **单机详情**：可疑进程（带命中的规则）与完整监听端口表，附巡检策略编辑。

   页面上反复强调一件事：**这是启发式**。每条可疑命中都会列出「命中了哪条规则」，
   由人判断；面板不会据此杀进程。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, SegmentedControl, Select, Switch, Textarea } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { CollapsibleCard, EmptyState, ErrorState, Notice } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Spinner';
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconLock,
  IconRefresh,
  IconServer,
  IconShield,
} from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/format';
import type {
  BadgeVariant,
  PortDisposition,
  PortDispositionItem,
  PortHostSummary,
  PortListener,
  PortPolicy,
  PortSeverity,
  SuspiciousProcess,
} from '../api/types';

const SEVERITY_META: Record<PortSeverity, { label: string; variant: 'danger' | 'warning' | 'accent' }> = {
  high: { label: '高危', variant: 'danger' },
  medium: { label: '中危', variant: 'warning' },
  low: { label: '低危', variant: 'accent' },
};

/**
 * 三种人工处置的展示口径。
 *
 * 「忽略」与「加白」看着差不多，后果差很远：前者到期会重新冒出来，
 * 后者是永久放行并写进策略 —— 按钮提示里必须说清这一点。
 */
const DISPOSITION_META: Record<
  'ack' | 'ignore' | 'whitelist',
  { label: string; variant: BadgeVariant; done: string; hint: string }
> = {
  ack: {
    label: '已确认',
    variant: 'success',
    done: '已标记为确认',
    hint: '已知晓这条发现：不再计入待处理与告警，但列表里仍可见、可撤销',
  },
  ignore: {
    label: '已忽略',
    variant: 'neutral',
    done: '已忽略',
    hint: '7 天内不再提示；到期自动回到待处理',
  },
  whitelist: {
    label: '已加白',
    variant: 'accent',
    done: '已加入白名单',
    hint: '永久放行：端口写进「预期端口」、进程按程序名写进「进程白名单」',
  },
};

const SCOPE_LABEL: Record<string, string> = {
  loopback: '仅本机',
  all: '全部网卡',
  specific: '指定地址',
};

/** 按钮顺序：确认 → 忽略 → 加白，后果由轻到重 */
const DISPOSITION_ORDER = ['ack', 'ignore', 'whitelist'] as const;

const DISPOSITION_LABEL: Record<(typeof DISPOSITION_ORDER)[number], string> = {
  ack: '确认',
  ignore: '忽略',
  whitelist: '加白',
};

/** 处置徽章：把「什么时候、被谁、忽略到什么时候」说给看的人听 */
function dispositionHint(item: PortDisposition): string {
  const parts: string[] = [];
  if (item.actor) parts.push(item.actor);
  parts.push(formatDateTime(new Date(item.ts * 1000)));
  if (item.action === 'ignore' && item.expires_at) {
    parts.push(`${formatDateTime(new Date(item.expires_at * 1000))} 前不再提示`);
  }
  return parts.join(' · ');
}

const EMPTY_POLICY: PortPolicy = {
  enabled: true,
  alert_open_ports: true,
  alert_suspicious: true,
  cooldown_minutes: 60,
  notify_user: '',
  expected_ports: [],
  process_whitelist: [],
};

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/* 总览的两种视图：卡片看清一台机器的构成，列表横向比对多台。
   偏好记在本地，下次进来还是同一种（与「安全基线」同一套做法）。 */
type HostViewMode = 'card' | 'list';

const HOST_VIEW_KEY = 'proxcenter.ports.host-view';

function readHostView(): HostViewMode {
  try {
    return localStorage.getItem(HOST_VIEW_KEY) === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

/*
  巡检的缓存时长。
  总览与单机都不是「读一份现成数据」，而是**现场巡检**：每台主机新建一条 SSH、
  跑一条合并的探测命令（最坏 45 秒超时），一轮下来几秒到几十秒。所以缓存刻意
  放长，别每次点进这一页都重跑一轮：

    * 5 分钟内再进来直接吃缓存，一个请求都不发；
    * 超过 5 分钟也是先把上次结果画出来、后台静默重扫，页面不再空等。

  想立刻要新数据，用右上角「重新巡检 / 重新巡检全部」。
*/
const SCAN_STALE_TIME = 5 * 60_000;
const SCAN_GC_TIME = 30 * 60_000;

/** 一台机器的巡检结论（卡片与列表共用同一套口径） */
function hostStatusMeta(host: PortHostSummary): { variant: BadgeVariant; label: string } {
  if (!host.ok) return { variant: 'neutral', label: '未巡检' };
  if (host.summary.suspicious > 0) {
    return { variant: 'danger', label: `可疑进程 ${host.summary.suspicious}` };
  }
  if (host.summary.unexpected > 0) {
    return { variant: 'warning', label: `待确认端口 ${host.summary.unexpected}` };
  }
  return { variant: 'success', label: '未发现异常' };
}

/** 一台机器的待处理项：可疑进程优先，其次是非预期开放端口 */
function HostFindings({ host }: { host: PortHostSummary }) {
  if (!host.ok) {
    return <span className="fs-xs text-danger">{host.error || '无法连接该主机'}</span>;
  }
  if (host.top_suspicious.length > 0) {
    return (
      <span className="baseline-issue-list">
        {host.top_suspicious.map((item) => (
          <span key={item.pid} className="baseline-issue">
            <span className={`baseline-dot is-${item.severity}`} aria-hidden="true" />
            {item.name}（{item.user}）：{item.labels[0] ?? ''}
          </span>
        ))}
      </span>
    );
  }
  if (host.top_ports.length > 0) {
    return (
      <span className="baseline-issue-list">
        {host.top_ports.slice(0, 4).map((item) => (
          <span key={`${item.proto}-${item.address}-${item.port}`} className="baseline-issue">
            <span className={`baseline-dot is-${item.severity}`} aria-hidden="true" />
            <span className="mono">
              {item.address}:{item.port}
            </span>
            <span className="text-muted">{item.process || '未知进程'}</span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="fs-xs" style={{ color: 'var(--success)' }}>
      没有对外开放的端口
    </span>
  );
}

/* ---------------------------------------------------------------------------
   总览里的一台服务器
   --------------------------------------------------------------------------- */

function HostCard({
  host,
  onOpen,
  onScan,
  scanning,
}: {
  host: PortHostSummary;
  onOpen: (hostId: string) => void;
  onScan: (hostId: string) => void;
  scanning: boolean;
}) {
  const { summary } = host;
  const status = hostStatusMeta(host);
  return (
    /* div + role=button：卡片里还要放「巡检」按钮，原生按钮不能嵌套 */
    <div
      className={`baseline-host-card ${host.ok ? '' : 'is-unreachable'}`}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${host.name || host.host_id} 的端口与进程`}
      onClick={() => onOpen(host.host_id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(host.host_id);
        }
      }}
    >
      <span className="baseline-host-top">
        <span className="baseline-host-ident">
          <span className="baseline-host-name">{host.name || host.host_id}</span>
          <span className="baseline-host-addr">
            {host.local ? '面板本机' : host.host || host.host_id}
          </span>
          <span className="form-row" style={{ gap: 6 }}>
            <Badge variant={status.variant} size="sm">
              {status.label}
            </Badge>
            {host.ok && !summary.firewall_active ? (
              <Badge variant="danger" size="sm" title="这台主机没有活动防火墙，暴露的端口风险更高">
                无防火墙
              </Badge>
            ) : null}
            {host.ok && !host.elevated ? (
              <Badge variant="neutral" size="sm" title="权限不足，看不到别人的进程与可执行文件">
                只读
              </Badge>
            ) : null}
          </span>
        </span>
      </span>

      {host.ok ? (
        <span className="baseline-host-body">
          <span className="fs-xs text-muted">
            监听 {summary.listeners} 个 · 对外开放 {summary.exposed} 个 · 非预期{' '}
            {summary.unexpected} 个
          </span>
          <HostFindings host={host} />
        </span>
      ) : (
        <span className="baseline-host-body fs-xs text-muted">
          {host.error || '无法连接该主机'}
        </span>
      )}

      <span className="baseline-host-foot">
        <span className="baseline-host-foot-main">
          查看详情 <IconChevronRight size={13} />
        </span>
        {/* 阻止冒泡：点「巡检」不该顺带打开详情 */}
        <span
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="baseline-host-scan"
            disabled={scanning}
            title={`只巡检 ${host.name || host.host_id} 这一台`}
            onClick={() => onScan(host.host_id)}
          >
            {scanning ? '巡检中…' : '巡检'}
          </button>
        </span>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   主组件
   --------------------------------------------------------------------------- */

export function PortGuard() {
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = hasPermission('ports.manage');

  /*
    列表 / 详情放进 URL（?host=<id>），与「安全基线」一致。
    左侧菜单是 <NavLink>：点一个「当前已经在的那个路由」不会重新挂载组件，
    组件 state 会原样保留 —— 从详情点菜单就回不到总览。URL 一变即可回到列表。
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const hostParam = searchParams.get('host') ?? '';
  const view: 'fleet' | 'host' = hostParam ? 'host' : 'fleet';
  const hostId = hostParam || 'local';
  const [busy, setBusy] = useState(false);
  /* 正在单机巡检的 host_id：按钮就地转圈，不阻塞其它主机 */
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<PortPolicy>(EMPTY_POLICY);
  const [expectedText, setExpectedText] = useState('');
  const [whitelistText, setWhitelistText] = useState('');
  const [savingPolicy, setSavingPolicy] = useState(false);
  /* 正在处置 / 撤销的指纹：按钮就地转圈 */
  const [disposing, setDisposing] = useState<string | null>(null);
  /* 总览：卡片 / 列表。偏好记在本地 —— 它只是口味，不该进分享出去的链接 */
  const [hostView, setHostView] = useState<HostViewMode>(readHostView);
  useEffect(() => {
    try {
      localStorage.setItem(HOST_VIEW_KEY, hostView);
    } catch {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  }, [hostView]);

  const hostsQuery = useQuery({
    queryKey: ['ports', 'hosts'],
    queryFn: portsApi.hosts,
    staleTime: 300_000,
    retry: false,
  });
  const overviewQuery = useQuery({
    queryKey: ['ports', 'overview'],
    queryFn: () => portsApi.overview(),
    enabled: view === 'fleet',
    staleTime: SCAN_STALE_TIME,
    gcTime: SCAN_GC_TIME,
    retry: false,
  });
  const reportQuery = useQuery({
    queryKey: ['ports', 'host', hostId],
    queryFn: () => portsApi.host(hostId),
    enabled: view === 'host',
    staleTime: SCAN_STALE_TIME,
    gcTime: SCAN_GC_TIME,
    retry: false,
  });
  const policyQuery = useQuery({
    queryKey: ['ports', 'policy'],
    queryFn: portsApi.policy,
    enabled: canManage && view === 'host',
    retry: false,
  });

  const hosts = hostsQuery.data?.hosts ?? [];
  const overview = overviewQuery.data;
  const report = reportQuery.data;

  useEffect(() => {
    if (!policyQuery.data) return;
    setPolicyDraft(policyQuery.data.policy);
    setExpectedText(policyQuery.data.policy.expected_ports.join('\n'));
    setWhitelistText(policyQuery.data.policy.process_whitelist.join('\n'));
  }, [policyQuery.data]);

  const hostOptions = useMemo(
    () =>
      hosts.map((host) => ({
        label: host.local ? `本机（${host.name}）` : host.name || host.address,
        value: host.id,
      })),
    [hosts],
  );

  /** 进单机详情；再点一次「总览」= 清掉 ?host= */
  const openHost = (id: string) => setSearchParams({ host: id });
  const showFleet = () => setSearchParams({});

  /* 单机巡检：只巡检这一台，再把总览拉一遍。
     总览的汇总口径（排序、KPI 合计）在服务端算，前端不重复实现一份。 */
  const scanHost = async (id: string) => {
    setScanningId(id);
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: ['ports', 'host', id],
        queryFn: () => portsApi.host(id),
        /* 点了「巡检」就必须真跑一遍：查询缓存里那份可能还新鲜（5 分钟），
           不写 0 的话 fetchQuery 直接回缓存，按钮转一圈其实什么都没做 */
        staleTime: 0,
      });
      await queryClient.invalidateQueries({ queryKey: ['ports', 'overview'] });
      const s = fresh.summary;
      toast.success(
        `已巡检 ${fresh.name || id}`,
        fresh.ok
          ? `监听 ${s.listeners} · 对外开放 ${s.exposed} · 非预期 ${s.unexpected} · 可疑进程 ${s.suspicious}`
          : fresh.error || '这台主机连不上',
      );
    } catch (err) {
      toast.error('巡检失败', errorMessage(err));
    } finally {
      setScanningId(null);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      const result = await portsApi.check();
      toast.success(
        result.fired ? `已推送 ${result.fired} 条通知` : '巡检完成，没有需要告警的项',
        '同一对象在冷却期内不会重复提醒',
      );
      /* 这一下后端已经跑完一轮全平台巡检了，再立刻把总览拉一遍等于同一轮扫两遍。
         只标脏不重取：页面上显示的就是刚刚这轮的结果，下次进这一页自然拿新的。 */
      await queryClient.invalidateQueries({
        queryKey: ['ports'],
        refetchType: 'none',
      });
    } catch (err) {
      toast.error('巡检失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      const saved = await portsApi.savePolicy({
        ...policyDraft,
        expected_ports: linesToArray(expectedText),
        process_whitelist: linesToArray(whitelistText),
      });
      setPolicyDraft(saved.policy);
      setExpectedText(saved.policy.expected_ports.join('\n'));
      setWhitelistText(saved.policy.process_whitelist.join('\n'));
      toast.success('策略已保存', '下次巡检即按新策略判定');
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setSavingPolicy(false);
    }
  };

  /* 人工处置记录：处置过的条目不再计入「待处理」，但必须还能看见、能撤销 */
  const dispositionsQuery = useQuery({
    queryKey: ['ports', 'dispositions', hostId],
    queryFn: () => portsApi.dispositions.list(hostId),
    enabled: canManage && view === 'host',
    staleTime: 30_000,
    retry: false,
  });

  /*
    确认 / 忽略 / 加白。
    三种动作的区别写在按钮的 title 上：它们是「人工认定」而不是「删掉」，
    所以每一次都会进审计日志，且在下方「已处置」里能撤销。
  */
  const applyDisposition = async (
    fingerprint: string,
    action: 'ack' | 'ignore' | 'whitelist',
    detail: Record<string, unknown>,
  ) => {
    setDisposing(fingerprint);
    try {
      await portsApi.dispositions.create({
        host_id: hostId,
        fingerprint,
        action,
        detail,
      });
      toast.success(
        DISPOSITION_META[action].done,
        action === 'ignore'
          ? '7 天内不再提示，到期会自动回到待处理'
          : action === 'whitelist'
            ? '已写进巡检策略，之后不再判定为异常'
            : '不再计入待处理与告警；可在下方「已处置」里撤销',
      );
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    } finally {
      setDisposing(null);
    }
  };

  const undoDisposition = async (fingerprint: string) => {
    setDisposing(fingerprint);
    try {
      await portsApi.dispositions.remove(hostId, fingerprint);
      toast.success('已撤销', '下一轮巡检它会重新出现在待处理里');
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error('撤销失败', errorMessage(err));
    } finally {
      setDisposing(null);
    }
  };

  /*
    「重新巡检全部」不能走 refetch()：后端的这份总览有一层 2 分钟报告缓存，
    普通 GET 会直接吃缓存，点了等于没点。这里显式带 refresh=1 重扫一轮，
    再把结果写回查询缓存（写回同时把本地缓存标成刚更新，不会紧接着又请求一次）。
    单机详情没有那层缓存，照旧 refetch。
  */
  const [rescanningAll, setRescanningAll] = useState(false);

  const rescanAll = async () => {
    setRescanningAll(true);
    try {
      const fresh = await portsApi.overview(true);
      queryClient.setQueryData(['ports', 'overview'], fresh);
      toast.success(
        '已重新巡检全部服务器',
        `${fresh.totals.hosts} 台 · 巡检时间 ${formatDateTime(fresh.generated_at)}`,
      );
    } catch (err) {
      toast.error('巡检失败', errorMessage(err));
    } finally {
      setRescanningAll(false);
    }
  };

  const refreshing = view === 'fleet' ? rescanningAll : reportQuery.isFetching;

  /** 一条发现上的「确认 / 忽略 / 加白」：处置的是**指纹**，不是这一次的具体 PID */
  const renderDispositionActions = (
    fingerprint: string,
    detail: Record<string, unknown>,
  ) =>
    canManage ? (
      <div className="form-row" style={{ gap: 4 }}>
        {DISPOSITION_ORDER.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="ghost"
            disabled={disposing === fingerprint}
            title={DISPOSITION_META[action].hint}
            onClick={() => void applyDisposition(fingerprint, action, detail)}
          >
            {DISPOSITION_LABEL[action]}
          </Button>
        ))}
      </div>
    ) : null;

  /*
    列表视图的列：与卡片同一份数据、同一套结论，只是摊成行 ——
    服务器一多，横向比对「哪台有几条待处理」比翻卡片快得多。
  */
  const hostColumns = useMemo<Array<Column<PortHostSummary>>>(
    () => [
      {
        key: 'name',
        header: '服务器',
        width: 190,
        sortable: true,
        sortValue: (host) => host.name || host.host_id,
        render: (host) => (
          <div className="vm-name-cell">
            <span className="fw-500">{host.name || host.host_id}</span>
            <span className="fs-xs text-muted mono">
              {host.local ? '面板本机' : host.host || host.host_id}
            </span>
          </div>
        ),
      },
      {
        key: 'status',
        header: '巡检结论',
        width: 130,
        sortable: true,
        /* 可疑进程 → 待确认端口 → 干净 → 未巡检 */
        sortValue: (host) =>
          !host.ok
            ? 3
            : host.summary.suspicious
              ? 0
              : host.summary.unexpected
                ? 1
                : 2,
        render: (host) => {
          const meta = hostStatusMeta(host);
          return (
            <Badge variant={meta.variant} size="sm">
              {meta.label}
            </Badge>
          );
        },
      },
      {
        key: 'ports',
        header: '监听 / 开放 / 非预期',
        width: 150,
        sortable: true,
        title: '按非预期开放端口数排序',
        sortValue: (host) => (host.ok ? host.summary.unexpected : -1),
        render: (host) =>
          host.ok ? (
            <span className="baseline-list-counts mono fs-sm">
              <span>{host.summary.listeners}</span>
              <span className="is-sep"> / </span>
              <span>{host.summary.exposed}</span>
              <span className="is-sep"> / </span>
              <span className={host.summary.unexpected ? 'is-warn' : 'is-pass'}>
                {host.summary.unexpected}
              </span>
            </span>
          ) : (
            <span className="fs-xs text-muted">—</span>
          ),
      },
      {
        key: 'findings',
        header: '待处理',
        render: (host) => <HostFindings host={host} />,
      },
      {
        key: 'firewall',
        header: '防火墙',
        width: 104,
        sortable: true,
        sortValue: (host) => (host.ok && host.summary.firewall_active ? 0 : 1),
        render: (host) =>
          !host.ok ? (
            <span className="fs-xs text-muted">—</span>
          ) : host.summary.firewall_active ? (
            <Badge variant="success" size="sm">
              已启用
            </Badge>
          ) : (
            <Badge
              variant="danger"
              size="sm"
              title="这台主机没有活动防火墙，暴露的端口风险更高"
            >
              无防火墙
            </Badge>
          ),
      },
      {
        key: 'actions',
        header: '',
        width: 104,
        align: 'right',
        locked: true,
        label: '操作',
        render: (host) => (
          <div className="form-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => openHost(host.host_id)}>
              详情
            </Button>
            <button
              type="button"
              className="baseline-host-scan"
              disabled={scanningId === host.host_id}
              title={`只巡检 ${host.name || host.host_id} 这一台`}
              onClick={() => void scanHost(host.host_id)}
            >
              {scanningId === host.host_id ? '巡检中…' : '巡检'}
            </button>
          </div>
        ),
      },
    ],
    [openHost, scanHost, scanningId],
  );

  const listenerColumns: Array<Column<PortListener>> = [
    {
      key: 'proto',
      header: '协议',
      width: 70,
      render: (row) => <span className="mono fs-xs">{row.proto}</span>,
    },
    {
      key: 'address',
      header: '监听地址',
      width: 190,
      render: (row) => (
        <span className="mono fs-xs">
          {row.address}:{row.port}
        </span>
      ),
    },
    {
      key: 'scope',
      header: '范围',
      width: 90,
      render: (row) => (
        <Badge variant={row.scope === 'loopback' ? 'neutral' : 'warning'} size="sm">
          {SCOPE_LABEL[row.scope] ?? row.scope}
        </Badge>
      ),
    },
    {
      key: 'process',
      header: '归属进程',
      render: (row) => (
        <span className="fs-xs">
          {row.process || <span className="text-muted">未知（需 root 查看）</span>}
          {row.pid ? <span className="text-muted mono"> #{row.pid}</span> : null}
        </span>
      ),
    },
    {
      key: 'tags',
      header: '标记',
      width: 190,
      render: (row) => (
        <span className="form-row" style={{ gap: 4 }}>
          {row.sensitive ? (
            <Badge variant="danger" size="sm">敏感服务</Badge>
          ) : null}
          {row.exposed && !row.expected && !row.disposition ? (
            <Badge variant="warning" size="sm">非预期开放</Badge>
          ) : null}
          {row.expected ? <Badge variant="success" size="sm">预期内</Badge> : null}
          {row.disposition ? (
            <Badge
              variant={DISPOSITION_META[row.disposition.action].variant}
              size="sm"
              title={dispositionHint(row.disposition)}
            >
              {DISPOSITION_META[row.disposition.action].label}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 190,
      align: 'right',
      locked: true,
      label: '操作',
      render: (row) => {
        /* 只有「对外暴露且不在预期清单里」的端口需要处置；其余行不给按钮，
           否则每行挂三个按钮会把整张表撑爆 */
        if (!canManage) return null;
        if (!row.disposition && !(row.exposed && !row.expected)) return null;
        const key = row.fingerprint || `port:${row.port}`;
        return row.disposition ? (
          <Button
            size="sm"
            variant="ghost"
            loading={disposing === key}
            title={dispositionHint(row.disposition)}
            onClick={() => void undoDisposition(key)}
          >
            撤销处置
          </Button>
        ) : (
          renderDispositionActions(key, {
            label: `${row.address}:${row.port}/${row.proto}`,
            port: String(row.port),
          })
        );
      },
    },
  ];

  const renderProcess = (item: SuspiciousProcess) => (
    <div key={item.pid} className={`baseline-item is-${item.severity === 'high' ? 'fail' : 'warn'}`}>
      <span className="baseline-item-icon" aria-hidden="true">
        <IconAlert size={15} />
      </span>
      <div className="baseline-item-body">
        <div className="baseline-item-head">
          <span className="baseline-item-title">{item.name}</span>
          <Badge variant={SEVERITY_META[item.severity].variant} size="sm">
            {SEVERITY_META[item.severity].label}
          </Badge>
          {item.disposition ? (
            <Badge
              variant={DISPOSITION_META[item.disposition.action].variant}
              size="sm"
              title={dispositionHint(item.disposition)}
            >
              {DISPOSITION_META[item.disposition.action].label}
            </Badge>
          ) : null}
          <span className="mono fs-xs text-muted">
            PID {item.pid} · {item.user} · 已运行 {item.etime}
          </span>
        </div>
        <div className="baseline-item-values">命令行：{item.args}</div>
        {item.exe ? (
          <div className="baseline-item-values">可执行文件：{item.exe}</div>
        ) : null}
        {item.connections.length > 0 ? (
          <div className="baseline-item-values">
            连接：{item.connections.map((conn) => `${conn.local} → ${conn.peer}`).join('；')}
          </div>
        ) : null}
        <div className="fs-xs text-muted">
          命中规则：
          {item.signals.map((signal) => `${signal.label}（${signal.code}）`).join('；')}
        </div>
        {item.disposition ? (
          <div className="baseline-item-values">
            {DISPOSITION_META[item.disposition.action].label}
            {item.disposition.note ? `：${item.disposition.note}` : ''}
            <span className="text-muted"> · {dispositionHint(item.disposition)}</span>
          </div>
        ) : null}
        <div className="baseline-item-actions">
          {item.disposition ? (
            <Button
              size="sm"
              variant="ghost"
              loading={disposing === item.fingerprint}
              onClick={() => void undoDisposition(item.fingerprint)}
            >
              撤销处置
            </Button>
          ) : (
            renderDispositionActions(item.fingerprint, {
              label: `${item.name}（PID ${item.pid}）`,
              name: item.name,
              exe: item.exe,
            })
          )}
        </div>
      </div>
    </div>
  );

  const showManagePanel = canManage && view === 'host';

  return (
    <PageShell
      title="端口与进程"
      subtitle="巡检各服务器的监听端口与可疑进程（反弹 shell 启发式），异常时推送告警"
      actions={
        <div className="form-row">
          {canManage ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<IconShield size={14} />}
              loading={busy}
              onClick={() => void checkNow()}
              title="立刻巡检一遍并按策略推送告警（用于验证通知是否可达）"
            >
              立即巡检
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh size={14} />}
            loading={refreshing}
            onClick={() =>
              view === 'fleet' ? void rescanAll() : void reportQuery.refetch()
            }
          >
            {view === 'fleet' ? '重新巡检全部' : '重新巡检'}
          </Button>
        </div>
      }
    >
      <Notice tone="info" title="这是启发式检测，不是杀毒引擎">
        每条命中都会列出「命中了哪条规则」供人工判断，面板<b>不会</b>据此杀进程。
        误报可以用巡检策略里的「进程白名单」压掉；「对外开放」只代表监听在非回环地址，
        是否真能被外部访问还取决于防火墙与上游网络。
      </Notice>

      <Card collapsible={false}>
        <div className="baseline-viewbar">
          <div className="segmented" role="tablist" aria-label="巡检视图">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'fleet'}
              className={`segmented-item ${view === 'fleet' ? 'is-active' : ''}`}
              onClick={showFleet}
            >
              全平台总览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'host'}
              className={`segmented-item ${view === 'host' ? 'is-active' : ''}`}
              onClick={() => openHost(hostId)}
            >
              单机详情
            </button>
          </div>

          {view === 'host' ? (
            <Select
              aria-label="选择服务器"
              value={hostId}
              onChange={(event) => openHost(event.target.value)}
              options={
                hostOptions.length
                  ? hostOptions
                  : /* 兜底只给管理员：普通用户看不到本机 */
                    isAdmin
                    ? [{ label: '本机', value: 'local' }]
                    : []
              }
              style={{ maxWidth: 280 }}
            />
          ) : null}

          <span className="baseline-viewbar-meta">
            {view === 'fleet' && overview ? (
              <span>
                巡检时间 {formatDateTime(overview.generated_at)}
                {/* 缓存过期后进页面会先显示这份结果再后台重扫，得让人知道
                    屏幕上的数字正在被刷新，而不是以为它过时了 */}
                {overviewQuery.isFetching ? ' · 正在重新巡检…' : ''}
              </span>
            ) : null}
            {view === 'host' && report ? (
              <>
                <span>巡检时间 {formatDateTime(report.checked_at)}</span>
                <span>{report.local ? '面板所在主机' : `受管主机 ${report.address}`}</span>
                {reportQuery.isFetching ? <span>正在重新巡检…</span> : null}
              </>
            ) : null}
          </span>
        </div>
      </Card>

      {/* ------------------------------------------------ 全平台总览 */}
      {view === 'fleet' ? (
        <>
          {overviewQuery.isError ? (
            <Card collapsible={false}>
              <ErrorState
                title="巡检失败"
                message={errorMessage(overviewQuery.error)}
                onRetry={() => void overviewQuery.refetch()}
              />
            </Card>
          ) : null}

          {/* 没有数据时也把 KPI 摆上（转骨架）：一轮巡检要几秒到几十秒，
              这段时间页面不该只剩底下那一行「正在巡检」 */}
          {!overviewQuery.isError ? (
            <div className="grid grid-4">
              <KpiCard
                label="服务器总数"
                value={overview?.totals.hosts ?? '—'}
                icon={<IconServer size={16} />}
                tone="accent"
                loading={overviewQuery.isLoading}
                hint={
                  overview
                    ? overview.totals.unreachable
                      ? `可达 ${overview.totals.reachable} · 不可达 ${overview.totals.unreachable}`
                      : '全部可达'
                    : undefined
                }
              />
              <KpiCard
                label="可疑进程"
                value={overview?.totals.suspicious ?? '—'}
                icon={<IconAlert size={16} />}
                tone={overview?.totals.suspicious ? 'danger' : 'success'}
                loading={overviewQuery.isLoading}
                hint={
                  overview
                    ? overview.totals.suspicious
                      ? '请登录主机人工确认'
                      : '未发现可疑进程'
                    : undefined
                }
              />
              <KpiCard
                label="非预期开放端口"
                value={overview?.totals.unexpected ?? '—'}
                icon={<IconLock size={16} />}
                tone={overview?.totals.unexpected ? 'warning' : 'success'}
                loading={overviewQuery.isLoading}
                hint={
                  overview ? '可在策略里把确认无误的端口标记为预期' : undefined
                }
              />
              <KpiCard
                label="没有防火墙的主机"
                value={overview?.totals.no_firewall ?? '—'}
                icon={<IconShield size={16} />}
                tone={overview?.totals.no_firewall ? 'warning' : 'success'}
                loading={overviewQuery.isLoading}
                hint={overview ? '这些主机上的开放端口风险更高' : undefined}
              />
            </div>
          ) : null}

          <Card collapsible={false}>
            <CardHeader
              title={overview ? `服务器（${overview.hosts.length}）` : '服务器'}
              subtitle="按「最需要看的」排序：有可疑进程的最前，其次是有非预期开放端口的"
              icon={<IconServer size={16} />}
              actions={
                <SegmentedControl<HostViewMode>
                  value={hostView}
                  onChange={setHostView}
                  ariaLabel="服务器展示方式"
                  options={[
                    { label: '卡片', value: 'card' },
                    { label: '列表', value: 'list' },
                  ]}
                />
              }
            />
            {overviewQuery.isLoading ? (
              <>
                <p className="fs-sm text-muted mb-16">
                  正在并发巡检所有服务器…（每台一条 SSH，首次要等几秒；结果会缓存 5
                  分钟，期间进这一页不再重扫）
                </p>
                {/* 骨架沿用真卡片的外形（.baseline-host-card），
                    别在卡片里再套一排白卡 */}
                <div className="baseline-host-grid" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <div className="baseline-host-card" key={i}>
                      <Skeleton width="45%" height={15} />
                      <Skeleton width="85%" height={11} />
                      <Skeleton height={24} radius={6} />
                    </div>
                  ))}
                </div>
              </>
            ) : overview && overview.hosts.length ? (
              hostView === 'card' ? (
                <div className="baseline-host-grid">
                  {overview.hosts.map((host) => (
                    <HostCard
                      key={host.host_id}
                      host={host}
                      onOpen={openHost}
                      onScan={(id) => void scanHost(id)}
                      scanning={scanningId === host.host_id}
                    />
                  ))}
                </div>
              ) : (
                <Table
                  caption="服务器端口与进程巡检总览"
                  rows={overview.hosts}
                  columns={hostColumns}
                  rowKey={(host) => host.host_id}
                  dense
                />
              )
            ) : !overviewQuery.isError ? (
              <EmptyState
                title="还没有可巡检的服务器"
                description="本机应该总是可用；要巡检其它服务器，先去「SSH 安全 → 受管主机」把它们加进来。"
                icon={<IconServer size={26} />}
              />
            ) : null}
          </Card>
        </>
      ) : null}

      {/* ------------------------------------------------ 单机详情 */}
      {view === 'host' ? (
        <>
          {reportQuery.isError ? (
            <Card collapsible={false}>
              <ErrorState
                title="巡检失败"
                message={errorMessage(reportQuery.error)}
                onRetry={() => void reportQuery.refetch()}
              />
            </Card>
          ) : null}

          {reportQuery.isLoading ? (
            <Card collapsible={false}>
              <div className="fs-sm text-muted">正在读取端口与进程…</div>
            </Card>
          ) : null}

          {report ? (
            <>
              <Card collapsible={false}>
                <CardHeader
                  title="巡检概况"
                  subtitle={report.local ? '面板所在主机' : `受管主机 ${report.address}`}
                  icon={<IconShield size={16} />}
                />
                <div className="baseline-head">
                  <div className="baseline-head-main">
                    <div className="baseline-head-title">
                      {report.name || report.host_id}
                      <Badge
                        variant={report.summary.firewall_active ? 'success' : 'danger'}
                        size="sm"
                      >
                        {report.summary.firewall_active
                          ? `防火墙：${report.firewall.manager || '已启用'}`
                          : '无活动防火墙'}
                      </Badge>
                      {report.ok && !report.elevated ? (
                        <Badge variant="neutral" size="sm">只读巡检</Badge>
                      ) : null}
                    </div>
                    {report.ok ? (
                      <div className="form-row" style={{ gap: 8 }}>
                        <span className="baseline-count is-unknown">
                          监听 {report.summary.listeners}
                        </span>
                        <span className="baseline-count is-unknown">
                          对外开放 {report.summary.exposed}
                        </span>
                        <span
                          className={`baseline-count ${
                            report.summary.unexpected ? 'is-warn' : 'is-pass'
                          }`}
                        >
                          非预期 {report.summary.unexpected}
                        </span>
                        <span
                          className={`baseline-count ${
                            report.summary.suspicious ? 'is-fail' : 'is-pass'
                          }`}
                        >
                          可疑进程 {report.summary.suspicious}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="baseline-head-meta">
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">主机名</span>
                      <span className="baseline-meta-value mono">
                        {report.host || report.host_id}
                      </span>
                    </div>
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">系统</span>
                      <span className="baseline-meta-value">
                        {report.os.distribution || '—'}
                      </span>
                    </div>
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">内核</span>
                      <span className="baseline-meta-value mono">
                        {report.os.kernel || '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {!report.ok ? (
                <Notice tone="danger" title="这台服务器巡检不了" icon={<IconAlert size={16} />}>
                  {report.error || '无法连接'}
                  。请先在「SSH 安全 → 受管主机」里确认它能连上，再回到这里刷新。
                </Notice>
              ) : null}

              <Card collapsible={false}>
                <CardHeader
                  title={`可疑进程（${report.summary.suspicious}）`}
                  subtitle={
                    report.summary.disposed
                      ? `命中即列出规则，供人工判断；面板不会自动处置。已处置的 ${report.summary.disposed} 条排在末尾，可撤销`
                      : '命中即列出规则，供人工判断；面板不会自动处置'
                  }
                  icon={<IconAlert size={16} />}
                />
                {report.suspicious.length ? (
                  <div className="baseline-todo">{report.suspicious.map(renderProcess)}</div>
                ) : (
                  <EmptyState
                    compact
                    title="没有发现可疑进程"
                    description="未命中任何反弹 shell / 恶意进程特征。"
                    icon={<IconCheck size={22} />}
                  />
                )}
              </Card>

              <Card collapsible={false}>
                <CardHeader
                  title={`监听端口（${report.listeners.length}）`}
                  subtitle="按实际暴露范围标记；「非预期开放」可就地确认 / 忽略 / 加白，也可在策略里维护"
                  icon={<IconLock size={16} />}
                />
                <Table
                  columns={listenerColumns}
                  rows={report.listeners}
                  rowKey={(row) => `${row.proto}-${row.address}-${row.port}`}
                  caption="监听端口清单"
                  dense
                  emptyTitle="没有监听端口"
                />
              </Card>

              {/* 已处置：处置不等于删掉，必须能看见、能撤销 —— 否则「忽略」就是
                  一次不可逆的放弃，审计上也说不清是谁放的。 */}
              {canManage && dispositionsQuery.data?.items.length ? (
                <Card collapsible={false}>
                  <CardHeader
                    title={`已处置（${dispositionsQuery.data.items.length}）`}
                    subtitle="确认 / 忽略 / 加白过的条目不再计入待处理与告警；撤销后下一轮巡检会重新出现"
                    icon={<IconCheck size={16} />}
                  />
                  <div className="baseline-todo">
                    {dispositionsQuery.data.items.map(
                      (item: PortDispositionItem) => (
                        <div className="baseline-item" key={item.fingerprint}>
                          <div className="baseline-item-body">
                            <div className="baseline-item-head">
                              <span className="baseline-item-title">
                                {item.label || item.fingerprint}
                              </span>
                              <Badge
                                variant={DISPOSITION_META[item.action].variant}
                                size="sm"
                              >
                                {DISPOSITION_META[item.action].label}
                              </Badge>
                              <span className="fs-xs text-muted">
                                {dispositionHint(item)}
                              </span>
                            </div>
                            {item.note ? (
                              <div className="baseline-item-values">备注：{item.note}</div>
                            ) : null}
                            <div className="fs-xs text-muted mono">
                              {item.fingerprint}
                            </div>
                          </div>
                          <div className="baseline-item-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={disposing === item.fingerprint}
                              onClick={() => void undoDisposition(item.fingerprint)}
                            >
                              撤销
                            </Button>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </Card>
              ) : null}

              {showManagePanel ? (
                <Card collapsible={false}>
                  <CardHeader
                    title="巡检策略"
                    subtitle="预期端口与进程白名单是压掉误报的主要手段"
                    icon={<IconShield size={16} />}
                    actions={
                      <Button
                        size="sm"
                        variant="primary"
                        loading={savingPolicy}
                        onClick={() => void savePolicy()}
                      >
                        保存策略
                      </Button>
                    }
                  />
                  <div className="dyn-row">
                    <Switch
                      checked={policyDraft.enabled}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, enabled: value }))
                      }
                      label="启用定时巡检"
                      hint="关闭后不再自动检查与告警"
                    />
                    <Switch
                      checked={policyDraft.alert_open_ports}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, alert_open_ports: value }))
                      }
                      label="端口异常告警"
                    />
                    <Switch
                      checked={policyDraft.alert_suspicious}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, alert_suspicious: value }))
                      }
                      label="可疑进程告警"
                    />
                  </div>
                  <div className="dyn-row">
                    <Input
                      label="告警冷却（分钟）"
                      type="number"
                      min={1}
                      max={1440}
                      value={policyDraft.cooldown_minutes}
                      onChange={(event) =>
                        setPolicyDraft((prev) => ({
                          ...prev,
                          cooldown_minutes: Number(event.target.value) || 60,
                        }))
                      }
                    />
                    <Input
                      label="告警接收人"
                      value={policyDraft.notify_user}
                      placeholder="留空 = 第一个管理员"
                      onChange={(event) =>
                        setPolicyDraft((prev) => ({ ...prev, notify_user: event.target.value }))
                      }
                    />
                  </div>
                  <Textarea
                    label="预期对外开放的端口"
                    hint="每行一条：22 / 0.0.0.0:80 / *:443 —— 列在这里的不算「非预期开放」"
                    mono
                    rows={4}
                    value={expectedText}
                    onChange={(event) => setExpectedText(event.target.value)}
                  />
                  <Textarea
                    label="进程白名单（正则）"
                    hint="每行一条，匹配命令行即忽略。用来压掉本环境里的已知误报"
                    mono
                    rows={4}
                    value={whitelistText}
                    onChange={(event) => setWhitelistText(event.target.value)}
                  />
                </Card>
              ) : null}

              <CollapsibleCard title="这些启发式各自在找什么" icon={<IconInfo size={15} />}>
                <div className="fs-sm text-secondary" style={{ lineHeight: 1.9 }}>
                  <div>
                    <strong>反弹 shell 特征</strong>：/dev/tcp 重定向、netcat -e/--exec、
                    socat exec、Python/Perl/Ruby/PHP 单行脚本里的 socket 与 dup2、
                    openssl s_client 管道给 shell、mkfifo + nc —— 这些都是「把 shell 挂到
                    网络连接上」的经典写法。
                  </div>
                  <div>
                    <strong>上下文特征</strong>：shell 进程持有对外连接（排除本地回环与
                    22/3389 这类正常会话端口）、父进程是 Web 服务却落了个 shell、
                    可执行文件在 /tmp 或 /dev/shm、可执行文件已被删除（跑起来就删自己）。
                  </div>
                  <div>
                    <strong>已知恶意</strong>：挖矿与蠕虫常见进程名（xmrig、kdevtmpfsi、
                    kinsing 等）、netcat 监听模式、连接到常见后门/远控端口。
                  </div>
                  <div>
                    <strong>权限的影响</strong>：看不到别人的进程时（非 root），
                    「归属进程」会显示未知、「可执行文件已删除」这类特征也拿不到 ——
                    报告里会标「只读巡检」，不是问题消失了。
                  </div>
                </div>
              </CollapsibleCard>
            </>
          ) : null}
        </>
      ) : null}
    </PageShell>
  );
}
