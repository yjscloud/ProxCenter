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
import { useT, type MessageKey, type TFunc } from '../i18n';
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

const SEVERITY_META: Record<
  PortSeverity,
  { label: MessageKey; variant: 'danger' | 'warning' | 'accent' }
> = {
  high: { label: 'ports.sev.high', variant: 'danger' },
  medium: { label: 'ports.sev.medium', variant: 'warning' },
  low: { label: 'ports.sev.low', variant: 'accent' },
};

/**
 * 三种人工处置的展示口径。
 *
 * 「忽略」与「加白」看着差不多，后果差很远：前者到期会重新冒出来，
 * 后者是永久放行并写进策略 —— 按钮提示里必须说清这一点。
 */
const DISPOSITION_META: Record<
  'ack' | 'ignore' | 'whitelist',
  { label: MessageKey; variant: BadgeVariant; done: MessageKey; hint: MessageKey }
> = {
  ack: {
    label: 'ports.disp.ack',
    variant: 'success',
    done: 'ports.disp.ackDone',
    hint: 'ports.disp.ackHint',
  },
  ignore: {
    label: 'ports.disp.ignore',
    variant: 'neutral',
    done: 'ports.disp.ignoreDone',
    hint: 'ports.disp.ignoreHint',
  },
  whitelist: {
    label: 'ports.disp.whitelist',
    variant: 'accent',
    done: 'ports.disp.whitelistDone',
    hint: 'ports.disp.whitelistHint',
  },
};

const SCOPE_LABEL: Record<string, MessageKey> = {
  loopback: 'ports.scope.loopback',
  all: 'ports.scope.all',
  specific: 'ports.scope.specific',
};

/** 按钮顺序：确认 → 忽略 → 加白，后果由轻到重 */
const DISPOSITION_ORDER = ['ack', 'ignore', 'whitelist'] as const;

const DISPOSITION_LABEL: Record<(typeof DISPOSITION_ORDER)[number], MessageKey> = {
  ack: 'ports.dispAction.ack',
  ignore: 'ports.dispAction.ignore',
  whitelist: 'ports.dispAction.whitelist',
};

/** 处置徽章：把「什么时候、被谁、忽略到什么时候」说给看的人听 */
function dispositionHint(item: PortDisposition, t: TFunc): string {
  const parts: string[] = [];
  if (item.actor) parts.push(item.actor);
  parts.push(formatDateTime(new Date(item.ts * 1000)));
  if (item.action === 'ignore' && item.expires_at) {
    parts.push(
      t('ports.ignoreUntil', {
        time: formatDateTime(new Date(item.expires_at * 1000)),
      }),
    );
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
function hostStatusMeta(
  host: PortHostSummary,
  t: TFunc,
): { variant: BadgeVariant; label: string } {
  if (!host.ok) return { variant: 'neutral', label: t('ports.status.notScanned') };
  if (host.summary.suspicious > 0) {
    return {
      variant: 'danger',
      label: t('ports.status.suspicious', { n: host.summary.suspicious }),
    };
  }
  if (host.summary.unexpected > 0) {
    return {
      variant: 'warning',
      label: t('ports.status.unexpected', { n: host.summary.unexpected }),
    };
  }
  return { variant: 'success', label: t('ports.status.clean') };
}

/** 一台机器的待处理项：可疑进程优先，其次是非预期开放端口 */
function HostFindings({ host }: { host: PortHostSummary }) {
  const t = useT();
  if (!host.ok) {
    return (
      <span className="fs-xs text-danger">
        {host.error || t('baseline.cannotConnectHost')}
      </span>
    );
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
            <span className="text-muted">{item.process || t('ports.unknownProcess')}</span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="fs-xs" style={{ color: 'var(--success)' }}>
      {t('ports.noOpenPorts')}
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
  const t = useT();
  const { summary } = host;
  const status = hostStatusMeta(host, t);
  return (
    /* div + role=button：卡片里还要放「巡检」按钮，原生按钮不能嵌套 */
    <div
      className={`baseline-host-card ${host.ok ? '' : 'is-unreachable'}`}
      role="button"
      tabIndex={0}
      aria-label={t('ports.viewHostAria', { name: host.name || host.host_id })}
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
            {host.local ? t('baseline.localPanelHost') : host.host || host.host_id}
          </span>
          <span className="form-row" style={{ gap: 6 }}>
            <Badge variant={status.variant} size="sm">
              {status.label}
            </Badge>
            {host.ok && !summary.firewall_active ? (
              <Badge
                variant="danger"
                size="sm"
                title={t('ports.noFirewallBadgeTitle')}
              >
                {t('ports.noFirewallBadge')}
              </Badge>
            ) : null}
            {host.ok && !host.elevated ? (
              <Badge variant="neutral" size="sm" title={t('ports.readonlyTitle')}>
                {t('baseline.readonlyBadge')}
              </Badge>
            ) : null}
          </span>
        </span>
      </span>

      {host.ok ? (
        <span className="baseline-host-body">
          <span className="fs-xs text-muted">
            {t('ports.listenSummary', {
              listeners: summary.listeners,
              exposed: summary.exposed,
              unexpected: summary.unexpected,
            })}
          </span>
          <HostFindings host={host} />
        </span>
      ) : (
        <span className="baseline-host-body fs-xs text-muted">
          {host.error || t('baseline.cannotConnectHost')}
        </span>
      )}

      <span className="baseline-host-foot">
        <span className="baseline-host-foot-main">
          {t('baseline.viewDetails')} <IconChevronRight size={13} />
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
            title={t('ports.scanOneTitle', { name: host.name || host.host_id })}
            onClick={() => onScan(host.host_id)}
          >
            {scanning ? t('ports.scanning') : t('ports.scan')}
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
  const t = useT();
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
        label: host.local
          ? `${t('baseline.localOption')}（${host.name}）`
          : host.name || host.address,
        value: host.id,
      })),
    [hosts, t],
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
        t('ports.scannedToast', { name: fresh.name || id }),
        fresh.ok
          ? t('ports.scannedDetail', {
              listeners: s.listeners,
              exposed: s.exposed,
              unexpected: s.unexpected,
              suspicious: s.suspicious,
            })
          : fresh.error || t('ports.hostUnreachable'),
      );
    } catch (err) {
      toast.error(t('ports.scanFailed'), errorMessage(err));
    } finally {
      setScanningId(null);
    }
  };

  const checkNow = async () => {
    setBusy(true);
    try {
      const result = await portsApi.check();
      toast.success(
        result.fired
          ? t('ports.pushedN', { n: result.fired })
          : t('ports.checkDone'),
        t('ports.cooldownNote'),
      );
      /* 这一下后端已经跑完一轮全平台巡检了，再立刻把总览拉一遍等于同一轮扫两遍。
         只标脏不重取：页面上显示的就是刚刚这轮的结果，下次进这一页自然拿新的。 */
      await queryClient.invalidateQueries({
        queryKey: ['ports'],
        refetchType: 'none',
      });
    } catch (err) {
      toast.error(t('ports.checkFailed'), errorMessage(err));
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
      toast.success(t('ports.policySaved'), t('ports.policySavedDetail'));
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error(t('ports.saveFailed'), errorMessage(err));
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
        t(DISPOSITION_META[action].done),
        action === 'ignore'
          ? t('ports.dispIgnoreDetail')
          : action === 'whitelist'
            ? t('ports.dispWhitelistDetail')
            : t('ports.dispAckDetail'),
      );
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setDisposing(null);
    }
  };

  const undoDisposition = async (fingerprint: string) => {
    setDisposing(fingerprint);
    try {
      await portsApi.dispositions.remove(hostId, fingerprint);
      toast.success(t('ports.undoDone'), t('ports.undoDoneDetail'));
      await queryClient.invalidateQueries({ queryKey: ['ports'] });
    } catch (err) {
      toast.error(t('ports.undoFailed'), errorMessage(err));
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
        t('ports.rescannedAll'),
        t('ports.rescannedAllDetail', {
          hosts: fresh.totals.hosts,
          time: formatDateTime(fresh.generated_at),
        }),
      );
    } catch (err) {
      toast.error(t('ports.checkFailed'), errorMessage(err));
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
            title={t(DISPOSITION_META[action].hint)}
            onClick={() => void applyDisposition(fingerprint, action, detail)}
          >
            {t(DISPOSITION_LABEL[action])}
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
        header: t('baseline.colHost'),
        width: 190,
        sortable: true,
        sortValue: (host) => host.name || host.host_id,
        render: (host) => (
          <div className="vm-name-cell">
            <span className="fw-500">{host.name || host.host_id}</span>
            <span className="fs-xs text-muted mono">
              {host.local ? t('baseline.localPanelHost') : host.host || host.host_id}
            </span>
          </div>
        ),
      },
      {
        key: 'status',
        header: t('ports.colVerdict'),
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
          const meta = hostStatusMeta(host, t);
          return (
            <Badge variant={meta.variant} size="sm">
              {meta.label}
            </Badge>
          );
        },
      },
      {
        key: 'ports',
        header: t('ports.colPorts'),
        width: 150,
        sortable: true,
        title: t('ports.sortByUnexpected'),
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
        header: t('baseline.colPending'),
        render: (host) => <HostFindings host={host} />,
      },
      {
        key: 'firewall',
        header: t('ports.colFirewall'),
        width: 104,
        sortable: true,
        sortValue: (host) => (host.ok && host.summary.firewall_active ? 0 : 1),
        render: (host) =>
          !host.ok ? (
            <span className="fs-xs text-muted">—</span>
          ) : host.summary.firewall_active ? (
            <Badge variant="success" size="sm">
              {t('ports.firewallEnabled')}
            </Badge>
          ) : (
            <Badge
              variant="danger"
              size="sm"
              title={t('ports.noFirewallBadgeTitle')}
            >
              {t('ports.noFirewallBadge')}
            </Badge>
          ),
      },
      {
        key: 'actions',
        header: '',
        width: 104,
        align: 'right',
        locked: true,
        label: t('common.actions'),
        render: (host) => (
          <div className="form-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => openHost(host.host_id)}>
              {t('baseline.details')}
            </Button>
            <button
              type="button"
              className="baseline-host-scan"
              disabled={scanningId === host.host_id}
              title={t('ports.scanOneTitle', { name: host.name || host.host_id })}
              onClick={() => void scanHost(host.host_id)}
            >
              {scanningId === host.host_id ? t('ports.scanning') : t('ports.scan')}
            </button>
          </div>
        ),
      },
    ],
    [openHost, scanHost, scanningId, t],
  );

  const listenerColumns: Array<Column<PortListener>> = [
    {
      key: 'proto',
      header: t('ports.colProto'),
      width: 70,
      render: (row) => <span className="mono fs-xs">{row.proto}</span>,
    },
    {
      key: 'address',
      header: t('ports.colAddress'),
      width: 190,
      render: (row) => (
        <span className="mono fs-xs">
          {row.address}:{row.port}
        </span>
      ),
    },
    {
      key: 'scope',
      header: t('ports.colScope'),
      width: 90,
      render: (row) => (
        <Badge variant={row.scope === 'loopback' ? 'neutral' : 'warning'} size="sm">
          {SCOPE_LABEL[row.scope] ? t(SCOPE_LABEL[row.scope]) : row.scope}
        </Badge>
      ),
    },
    {
      key: 'process',
      header: t('ports.colProcess'),
      render: (row) => (
        <span className="fs-xs">
          {row.process || (
            <span className="text-muted">{t('ports.unknownNeedsRoot')}</span>
          )}
          {row.pid ? <span className="text-muted mono"> #{row.pid}</span> : null}
        </span>
      ),
    },
    {
      key: 'tags',
      header: t('ports.colTags'),
      width: 190,
      render: (row) => (
        <span className="form-row" style={{ gap: 4 }}>
          {row.sensitive ? (
            <Badge variant="danger" size="sm">{t('ports.tagSensitive')}</Badge>
          ) : null}
          {row.exposed && !row.expected && !row.disposition ? (
            <Badge variant="warning" size="sm">{t('ports.tagUnexpected')}</Badge>
          ) : null}
          {row.expected ? (
            <Badge variant="success" size="sm">{t('ports.tagExpected')}</Badge>
          ) : null}
          {row.disposition ? (
            <Badge
              variant={DISPOSITION_META[row.disposition.action].variant}
              size="sm"
              title={dispositionHint(row.disposition, t)}
            >
              {t(DISPOSITION_META[row.disposition.action].label)}
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
      label: t('common.actions'),
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
            title={dispositionHint(row.disposition, t)}
            onClick={() => void undoDisposition(key)}
          >
            {t('ports.undoDisposition')}
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
            {t(SEVERITY_META[item.severity].label)}
          </Badge>
          {item.disposition ? (
            <Badge
              variant={DISPOSITION_META[item.disposition.action].variant}
              size="sm"
              title={dispositionHint(item.disposition, t)}
            >
              {t(DISPOSITION_META[item.disposition.action].label)}
            </Badge>
          ) : null}
          <span className="mono fs-xs text-muted">
            {t('ports.pidLine', {
              pid: item.pid,
              user: item.user,
              etime: item.etime,
            })}
          </span>
        </div>
        <div className="baseline-item-values">{t('ports.cmdline')}{item.args}</div>
        {item.exe ? (
          <div className="baseline-item-values">{t('ports.exePath')}{item.exe}</div>
        ) : null}
        {item.connections.length > 0 ? (
          <div className="baseline-item-values">
            {t('ports.connections')}
            {item.connections
              .map((conn) => `${conn.local} → ${conn.peer}`)
              .join(t('ports.connectionSeparator'))}
          </div>
        ) : null}
        <div className="fs-xs text-muted">
          {t('ports.signals')}
          {item.signals
            .map((signal) => `${signal.label}（${signal.code}）`)
            .join(t('ports.connectionSeparator'))}
        </div>
        {item.disposition ? (
          <div className="baseline-item-values">
            {t(DISPOSITION_META[item.disposition.action].label)}
            {item.disposition.note ? `：${item.disposition.note}` : ''}
            <span className="text-muted"> · {dispositionHint(item.disposition, t)}</span>
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
              {t('ports.undoDisposition')}
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
      title={t('ports.title')}
      subtitle={t('ports.subtitle')}
      actions={
        <div className="form-row">
          {canManage ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<IconShield size={14} />}
              loading={busy}
              onClick={() => void checkNow()}
              title={t('ports.checkNowTitle')}
            >
              {t('ports.checkNow')}
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
            {view === 'fleet' ? t('ports.rescanAll') : t('ports.rescan')}
          </Button>
        </div>
      }
    >
      <Notice tone="info" title={t('ports.heuristicTitle')}>
        {t('ports.heuristicPre')}<b>{t('ports.heuristicBold')}</b>
        {t('ports.heuristicPost')}
      </Notice>

      <Card collapsible={false}>
        <div className="baseline-viewbar">
          <div className="segmented" role="tablist" aria-label={t('ports.viewAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'fleet'}
              className={`segmented-item ${view === 'fleet' ? 'is-active' : ''}`}
              onClick={showFleet}
            >
              {t('baseline.fleetView')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'host'}
              className={`segmented-item ${view === 'host' ? 'is-active' : ''}`}
              onClick={() => openHost(hostId)}
            >
              {t('baseline.hostView')}
            </button>
          </div>

          {view === 'host' ? (
            <Select
              aria-label={t('baseline.selectHostAria')}
              value={hostId}
              onChange={(event) => openHost(event.target.value)}
              options={
                hostOptions.length
                  ? hostOptions
                  : /* 兜底只给管理员：普通用户看不到本机 */
                    isAdmin
                    ? [{ label: t('baseline.localOption'), value: 'local' }]
                    : []
              }
              style={{ maxWidth: 280 }}
            />
          ) : null}

          <span className="baseline-viewbar-meta">
            {view === 'fleet' && overview ? (
              <span>
                {t('ports.checkedAt', { time: formatDateTime(overview.generated_at) })}
                {/* 缓存过期后进页面会先显示这份结果再后台重扫，得让人知道
                    屏幕上的数字正在被刷新，而不是以为它过时了 */}
                {overviewQuery.isFetching ? t('ports.rescanning') : ''}
              </span>
            ) : null}
            {view === 'host' && report ? (
              <>
                <span>
                  {t('ports.checkedAt', { time: formatDateTime(report.checked_at) })}
                </span>
                <span>
                  {report.local
                    ? t('baseline.hostOfPanel')
                    : t('baseline.managedHost', { address: report.address })}
                </span>
                {reportQuery.isFetching ? (
                  <span>{t('ports.rescanningShort')}</span>
                ) : null}
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
                title={t('ports.checkFailed')}
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
                label={t('baseline.kpi.hosts')}
                value={overview?.totals.hosts ?? '—'}
                icon={<IconServer size={16} />}
                tone="accent"
                loading={overviewQuery.isLoading}
                hint={
                  overview
                    ? overview.totals.unreachable
                      ? t('baseline.kpi.reachable', {
                          reachable: overview.totals.reachable,
                          unreachable: overview.totals.unreachable,
                        })
                      : t('baseline.kpi.allReachable')
                    : undefined
                }
              />
              <KpiCard
                label={t('ports.kpi.suspicious')}
                value={overview?.totals.suspicious ?? '—'}
                icon={<IconAlert size={16} />}
                tone={overview?.totals.suspicious ? 'danger' : 'success'}
                loading={overviewQuery.isLoading}
                hint={
                  overview
                    ? overview.totals.suspicious
                      ? t('ports.kpi.suspiciousHint')
                      : t('ports.kpi.noSuspicious')
                    : undefined
                }
              />
              <KpiCard
                label={t('ports.kpi.unexpected')}
                value={overview?.totals.unexpected ?? '—'}
                icon={<IconLock size={16} />}
                tone={overview?.totals.unexpected ? 'warning' : 'success'}
                loading={overviewQuery.isLoading}
                hint={overview ? t('ports.kpi.unexpectedHint') : undefined}
              />
              <KpiCard
                label={t('ports.kpi.noFirewall')}
                value={overview?.totals.no_firewall ?? '—'}
                icon={<IconShield size={16} />}
                tone={overview?.totals.no_firewall ? 'warning' : 'success'}
                loading={overviewQuery.isLoading}
                hint={overview ? t('ports.kpi.noFirewallHint') : undefined}
              />
            </div>
          ) : null}

          <Card collapsible={false}>
            <CardHeader
              title={
                overview
                  ? t('ports.hostsTitle', { n: overview.hosts.length })
                  : t('baseline.hostsTitlePlain')
              }
              subtitle={t('ports.hostsSubtitle')}
              icon={<IconServer size={16} />}
              actions={
                <SegmentedControl<HostViewMode>
                  value={hostView}
                  onChange={setHostView}
                  ariaLabel={t('baseline.hostViewAria')}
                  options={[
                    { label: t('nodes.viewCards'), value: 'card' },
                    { label: t('nodes.viewList'), value: 'list' },
                  ]}
                />
              }
            />
            {overviewQuery.isLoading ? (
              <>
                <p className="fs-sm text-muted mb-16">
                  {t('ports.scanningAll')}
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
                  caption={t('ports.fleetCaption')}
                  rows={overview.hosts}
                  columns={hostColumns}
                  rowKey={(host) => host.host_id}
                  dense
                />
              )
            ) : !overviewQuery.isError ? (
              <EmptyState
                title={t('ports.emptyFleetTitle')}
                description={t('ports.emptyFleetDesc')}
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
                title={t('ports.checkFailed')}
                message={errorMessage(reportQuery.error)}
                onRetry={() => void reportQuery.refetch()}
              />
            </Card>
          ) : null}

          {reportQuery.isLoading ? (
            <Card collapsible={false}>
              <div className="fs-sm text-muted">{t('ports.dataLoading')}</div>
            </Card>
          ) : null}

          {report ? (
            <>
              <Card collapsible={false}>
                <CardHeader
                  title={t('ports.reportTitle')}
                  subtitle={
                    report.local
                      ? t('baseline.hostOfPanel')
                      : t('baseline.managedHost', { address: report.address })
                  }
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
                          ? t('ports.firewallWithManager', {
                              manager: report.firewall.manager || t('ports.firewallEnabled'),
                            })
                          : t('ports.noActiveFirewall')}
                      </Badge>
                      {report.ok && !report.elevated ? (
                        <Badge variant="neutral" size="sm">
                          {t('baseline.readonlyScan')}
                        </Badge>
                      ) : null}
                    </div>
                    {report.ok ? (
                      <div className="form-row" style={{ gap: 8 }}>
                        <span className="baseline-count is-unknown">
                          {t('ports.count.listeners', { n: report.summary.listeners })}
                        </span>
                        <span className="baseline-count is-unknown">
                          {t('ports.count.exposed', { n: report.summary.exposed })}
                        </span>
                        <span
                          className={`baseline-count ${
                            report.summary.unexpected ? 'is-warn' : 'is-pass'
                          }`}
                        >
                          {t('ports.count.unexpected', { n: report.summary.unexpected })}
                        </span>
                        <span
                          className={`baseline-count ${
                            report.summary.suspicious ? 'is-fail' : 'is-pass'
                          }`}
                        >
                          {t('ports.count.suspicious', { n: report.summary.suspicious })}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="baseline-head-meta">
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">{t('baseline.metaHostname')}</span>
                      <span className="baseline-meta-value mono">
                        {report.host || report.host_id}
                      </span>
                    </div>
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">{t('baseline.metaOs')}</span>
                      <span className="baseline-meta-value">
                        {report.os.distribution || '—'}
                      </span>
                    </div>
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">{t('baseline.metaKernel')}</span>
                      <span className="baseline-meta-value mono">
                        {report.os.kernel || '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {!report.ok ? (
                <Notice
                  tone="danger"
                  title={t('ports.unreachableTitle')}
                  icon={<IconAlert size={16} />}
                >
                  {report.error || t('baseline.cannotConnectShort')}
                  {t('ports.unreachableTail')}
                </Notice>
              ) : null}

              <Card collapsible={false}>
                <CardHeader
                  title={t('ports.processTitle', { n: report.summary.suspicious })}
                  subtitle={
                    report.summary.disposed
                      ? t('ports.processSubtitleDisposed', {
                          n: report.summary.disposed,
                        })
                      : t('ports.processSubtitle')
                  }
                  icon={<IconAlert size={16} />}
                />
                {report.suspicious.length ? (
                  <div className="baseline-todo">{report.suspicious.map(renderProcess)}</div>
                ) : (
                  <EmptyState
                    compact
                    title={t('ports.noSuspiciousTitle')}
                    description={t('ports.noSuspiciousDesc')}
                    icon={<IconCheck size={22} />}
                  />
                )}
              </Card>

              <Card collapsible={false}>
                <CardHeader
                  title={t('ports.listenersTitle', { n: report.listeners.length })}
                  subtitle={t('ports.listenersSubtitle')}
                  icon={<IconLock size={16} />}
                />
                <Table
                  columns={listenerColumns}
                  rows={report.listeners}
                  rowKey={(row) => `${row.proto}-${row.address}-${row.port}`}
                  caption={t('ports.listenersCaption')}
                  dense
                  emptyTitle={t('ports.listenersEmpty')}
                />
              </Card>

              {/* 已处置：处置不等于删掉，必须能看见、能撤销 —— 否则「忽略」就是
                  一次不可逆的放弃，审计上也说不清是谁放的。 */}
              {canManage && dispositionsQuery.data?.items.length ? (
                <Card collapsible={false}>
                  <CardHeader
                    title={t('ports.disposedTitle', {
                      n: dispositionsQuery.data.items.length,
                    })}
                    subtitle={t('ports.disposedSubtitle')}
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
                                {t(DISPOSITION_META[item.action].label)}
                              </Badge>
                              <span className="fs-xs text-muted">
                                {dispositionHint(item, t)}
                              </span>
                            </div>
                            {item.note ? (
                              <div className="baseline-item-values">
                                {t('ports.noteLabel')}{item.note}
                              </div>
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
                              {t('ports.undo')}
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
                    title={t('ports.policyTitle')}
                    subtitle={t('ports.policySubtitle')}
                    icon={<IconShield size={16} />}
                    actions={
                      <Button
                        size="sm"
                        variant="primary"
                        loading={savingPolicy}
                        onClick={() => void savePolicy()}
                      >
                        {t('ports.savePolicy')}
                      </Button>
                    }
                  />
                  <div className="dyn-row">
                    <Switch
                      checked={policyDraft.enabled}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, enabled: value }))
                      }
                      label={t('ports.policyEnabled')}
                      hint={t('ports.policyEnabledHint')}
                    />
                    <Switch
                      checked={policyDraft.alert_open_ports}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, alert_open_ports: value }))
                      }
                      label={t('ports.alertOpenPorts')}
                    />
                    <Switch
                      checked={policyDraft.alert_suspicious}
                      onChange={(value) =>
                        setPolicyDraft((prev) => ({ ...prev, alert_suspicious: value }))
                      }
                      label={t('ports.alertSuspicious')}
                    />
                  </div>
                  <div className="dyn-row">
                    <Input
                      label={t('ports.cooldown')}
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
                      label={t('sshConfig.notifyUser')}
                      value={policyDraft.notify_user}
                      placeholder={t('sshConfig.notifyUserHint')}
                      onChange={(event) =>
                        setPolicyDraft((prev) => ({ ...prev, notify_user: event.target.value }))
                      }
                    />
                  </div>
                  <Textarea
                    label={t('ports.expectedPorts')}
                    hint={t('ports.expectedPortsHint')}
                    mono
                    rows={4}
                    value={expectedText}
                    onChange={(event) => setExpectedText(event.target.value)}
                  />
                  <Textarea
                    label={t('ports.processWhitelist')}
                    hint={t('ports.processWhitelistHint')}
                    mono
                    rows={4}
                    value={whitelistText}
                    onChange={(event) => setWhitelistText(event.target.value)}
                  />
                </Card>
              ) : null}

              <CollapsibleCard
                title={t('ports.heuristicsTitle')}
                icon={<IconInfo size={15} />}
              >
                <div className="fs-sm text-secondary" style={{ lineHeight: 1.9 }}>
                  <div>
                    <strong>{t('ports.heurShellLabel')}</strong>
                    {t('ports.heurShell')}
                  </div>
                  <div>
                    <strong>{t('ports.heurCtxLabel')}</strong>
                    {t('ports.heurCtx')}
                  </div>
                  <div>
                    <strong>{t('ports.heurKnownLabel')}</strong>
                    {t('ports.heurKnown')}
                  </div>
                  <div>
                    <strong>{t('ports.heurPermLabel')}</strong>
                    {t('ports.heurPerm')}
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
