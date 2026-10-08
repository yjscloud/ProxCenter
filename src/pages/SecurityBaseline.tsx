/* ==========================================================================
   ProxCenter — 安全基线（全平台服务器的体检与加固）

   信息架构分两层，默认停在第一层：

   * **全平台总览**：每台服务器一张卡片（评分环 + 问题构成占比条 + 最需处理的
     几项），最需要处理的排最前 —— 先回答「哪台机器有事」；
   * **单机详情**：评分环 + 一句话结论 + 元信息，然后是「需要处理」清单（可
     一键加固），最后是按分类罗列的全部检查项 —— 再回答「具体是什么事、怎么改」。

   体检对象是**整台服务器**：本机（面板所在主机）+ 「SSH 安全 → 受管主机」里
   启用的主机。两端在后端共用同一套判定逻辑，所以结论口径完全一致。
   ========================================================================== */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { baselineApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { AskAiButton } from '../components/AskAiButton';
import { LocalHostNotice, useLocalHost } from '../components/LocalHostNotice';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { SegmentedControl, Select } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import type { Column, SortState } from '../components/ui/Table';
import {
  CollapsibleCard,
  EmptyState,
  ErrorState,
  Notice,
} from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Spinner';
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCpu,
  IconInfo,
  IconKey,
  IconLock,
  IconRefresh,
  IconServer,
  IconShield,
  IconTerminal,
  IconUser,
} from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/format';
import { useT, type MessageKey, type TFunc } from '../i18n';
import type {
  BadgeVariant,
  BaselineCheck,
  BaselineHostSummary,
  BaselinePrivilege,
  BaselineReport,
  BaselineSeverity,
  BaselineStatus,
} from '../api/types';

const STATUS_META: Record<BaselineStatus, { variant: BadgeVariant; label: MessageKey }> = {
  pass: { variant: 'success', label: 'baseline.status.pass' },
  warn: { variant: 'warning', label: 'baseline.status.warn' },
  fail: { variant: 'danger', label: 'baseline.status.fail' },
  unknown: { variant: 'neutral', label: 'baseline.status.unknown' },
};

const SEV_META: Record<BaselineSeverity, MessageKey> = {
  high: 'baseline.sev.high',
  medium: 'baseline.sev.medium',
  low: 'baseline.sev.low',
};

const GRADE_VARIANT: Record<string, BadgeVariant> = {
  A: 'success',
  B: 'accent',
  C: 'warning',
  D: 'danger',
};

/** root / sudo 是标识符本身，不用翻译；只有「无特权」需要本地化 */
function privilegeLabel(value: BaselinePrivilege, t: TFunc): string {
  return value === 'none' ? t('baseline.priv.none') : value;
}

/** 服务器区的两种视图：卡片看一台机器的细节，列表横向比对多台机器 */
type HostViewMode = 'card' | 'list';

const HOST_VIEW_KEY = 'proxcenter.baseline.host-view';

function readHostView(): HostViewMode {
  try {
    return localStorage.getItem(HOST_VIEW_KEY) === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

/*
  体检结果的缓存时长。与「端口与进程」同一条道理：总览和单机都不是读现成数据，
  而是**现场体检** —— 每台主机新建一条 SSH、跑一条合并的探测命令（最坏 45 秒
  超时）。缓存放长，别每次进这一页都重跑一轮：5 分钟内直接吃缓存、不发请求；
  超过 5 分钟也是先显示上次结果、后台静默重扫。要立刻要新数据用「重新体检」。
*/
const SCAN_STALE_TIME = 5 * 60_000;
const SCAN_GC_TIME = 30 * 60_000;

const CATEGORY_ICONS: Record<string, ReactNode> = {
  ssh: <IconTerminal size={15} />,
  password: <IconKey size={15} />,
  firewall: <IconLock size={15} />,
  ntp: <IconClock size={15} />,
  accounts: <IconUser size={15} />,
  kernel: <IconCpu size={15} />,
};

/* ---------------------------------------------------------------------------
   评分环：SVG 圆环 + 居中分数。颜色跟随等级（A 绿 / B 蓝 / C 橙 / D 红），
   拿不到成绩（未体检）时画灰环并用「—」占位。
   --------------------------------------------------------------------------- */

function ScoreRing({
  score,
  grade,
  ok = true,
  size = 132,
  stroke = 10,
}: {
  score: number;
  grade: string;
  ok?: boolean;
  size?: number;
  stroke?: number;
}) {
  const t = useT();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = ok ? Math.max(0, Math.min(100, score)) / 100 : 0;
  const level = ok && grade ? grade.toLowerCase() : 'none';

  return (
    <div
      className={`baseline-ring baseline-lvl-${level}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        ok
          ? t('baseline.ringAria', { score, grade: grade || t('baseline.ungraded') })
          : t('baseline.ringAriaNone')
      }
    >
      <svg width={size} height={size} aria-hidden="true">
        <circle
          className="baseline-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          className="baseline-ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="baseline-ring-text">
        <span
          className="baseline-ring-score"
          style={{ fontSize: size >= 100 ? 34 : 19 }}
        >
          {ok ? score : '—'}
        </span>
        <span className="baseline-ring-unit">
          {ok
            ? grade
              ? t('baseline.gradeSuffix', { grade })
              : ''
            : t('baseline.notScanned')}
        </span>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   计数胶囊：通过 / 待改进 / 不合格 / 无法检测
   --------------------------------------------------------------------------- */

function Counts({
  summary,
  size = 'md',
}: {
  summary: { pass: number; warn: number; fail: number; unknown?: number };
  size?: 'sm' | 'md';
}) {
  const t = useT();
  const tone = size === 'sm' ? 'fs-xs' : '';
  return (
    <span className="baseline-counts">
      <span className={`baseline-count is-pass ${tone}`}>
        {t('baseline.count.pass', { n: summary.pass })}
      </span>
      {summary.fail > 0 ? (
        <span className={`baseline-count is-fail ${tone}`}>
          {t('baseline.count.fail', { n: summary.fail })}
        </span>
      ) : null}
      {summary.warn > 0 ? (
        <span className={`baseline-count is-warn ${tone}`}>
          {t('baseline.count.warn', { n: summary.warn })}
        </span>
      ) : null}
      {(summary.unknown ?? 0) > 0 ? (
        <span className={`baseline-count is-unknown ${tone}`}>
          {t('baseline.count.unknown', { n: summary.unknown })}
        </span>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   一行检查项。``action`` 存在时按钮贴右侧（用于「需要处理」清单）。
   --------------------------------------------------------------------------- */

function CheckRow({
  item,
  action,
}: {
  item: BaselineCheck;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className={`baseline-item is-${item.status}`}>
      <span className="baseline-item-icon" aria-hidden="true">
        {item.status === 'pass' ? (
          <IconCheck size={15} />
        ) : item.status === 'unknown' ? (
          <IconInfo size={15} />
        ) : (
          <IconAlert size={15} />
        )}
      </span>

      <div className="baseline-item-body">
        <div className="baseline-item-head">
          <span className="baseline-item-title">{item.label}</span>
          <span className={`sev-chip is-${item.severity}`}>
            {t(SEV_META[item.severity])}
          </span>
          {item.status !== 'pass' ? (
            <Badge variant={STATUS_META[item.status].variant} size="sm">
              {t(STATUS_META[item.status].label)}
            </Badge>
          ) : null}
        </div>

        <div className="baseline-item-values">
          {t('baseline.actual')}<span className={item.status === 'fail' ? 'is-bad' : ''}>{item.value}</span>
          {'　'}
          {t('baseline.expected')}{item.expected}
        </div>

        {item.detail ? (
          <div className="fs-xs text-muted">{item.detail}</div>
        ) : null}
        {item.hint && item.status !== 'pass' ? (
          <div className="baseline-item-hint">
            {t('baseline.suggestion')}{item.hint}
          </div>
        ) : null}
      </div>

      {action ? <div className="baseline-item-action">{action}</div> : null}
    </div>
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
  host: BaselineHostSummary;
  onOpen: (hostId: string) => void;
  onScan: (hostId: string) => void;
  scanning: boolean;
}) {
  const t = useT();
  const { summary } = host;
  const total = summary.total || 0;
  const width = (value: number) => (total ? `${(value / total) * 100}%` : '0%');

  return (
    /* 用 div + role=button 而不是 <button>：卡片里还要放一个「扫描」按钮，
       原生按钮不能嵌套。键盘可达性用 tabIndex + Enter/Space 手动补上。 */
    <div
      className={`baseline-host-card ${host.ok ? '' : 'is-unreachable'}`}
      role="button"
      tabIndex={0}
      aria-label={t('baseline.viewHostAria', { name: host.name || host.host_id })}
      onClick={() => onOpen(host.host_id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(host.host_id);
        }
      }}
    >
      <span className="baseline-host-top">
        <ScoreRing
          score={host.score}
          grade={host.grade}
          ok={host.ok}
          size={64}
          stroke={6}
        />
        <span className="baseline-host-ident">
          <span className="baseline-host-name">{host.name || host.host_id}</span>
          <span className="baseline-host-addr">
            {host.local ? t('baseline.localPanelHost') : host.host || host.host_id}
          </span>
          <span className="form-row" style={{ gap: 6 }}>
            <Badge variant={GRADE_VARIANT[host.grade] ?? 'neutral'} size="sm">
              {host.ok ? host.grade_label : t('baseline.notScanned')}
            </Badge>
            {host.ok && !host.elevated ? (
              <Badge
                variant="neutral"
                size="sm"
                title={t('baseline.readonlyBadgeTitle')}
              >
                {t('baseline.readonlyBadge')}
              </Badge>
            ) : null}
          </span>
        </span>
      </span>

      {host.ok ? (
        <span className="baseline-host-body">
          {/* 问题构成占比条：绿=通过 橙=待改进 红=不合格 */}
          <span
            className="baseline-bar"
            title={t('baseline.barTitle', {
              pass: summary.pass,
              warn: summary.warn,
              fail: summary.fail,
            })}
          >
            <span className="is-pass" style={{ width: width(summary.pass) }} />
            <span className="is-warn" style={{ width: width(summary.warn) }} />
            <span className="is-fail" style={{ width: width(summary.fail) }} />
          </span>

          {host.issues.length > 0 ? (
            <span className="baseline-issue-list">
              {host.issues.map((issue) => (
                <span key={issue.key} className="baseline-issue">
                  <span
                    className={`baseline-dot is-${issue.severity}`}
                    aria-hidden="true"
                  />
                  {issue.label}
                </span>
              ))}
            </span>
          ) : (
            <span className="fs-xs" style={{ color: 'var(--success)' }}>
              {t('baseline.allPassedN', { n: summary.total })}
            </span>
          )}
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
        {/* 阻止冒泡：点「扫描」不该顺带把详情也打开 */}
        <span
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="baseline-host-scan"
            disabled={scanning}
            title={t('baseline.scanOneTitle', { name: host.name || host.host_id })}
            onClick={() => onScan(host.host_id)}
          >
            {scanning ? t('baseline.scanning') : t('baseline.scan')}
          </button>
        </span>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   主组件
   --------------------------------------------------------------------------- */

export function SecurityBaseline() {
  const t = useT();
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = hasPermission('baseline.manage');

  /*
    列表 / 详情这两层状态放进 URL（?host=<id>）。
    不能只存在组件 state 里：左侧菜单是 <NavLink>，点一个「当前已经在的那个
    路由」只会重渲染、不会重新挂载组件，state 原样保留 —— 于是从详情视图点
    「安全基线」菜单回不到总览。URL 一变，这里就自然回到列表。
  */
  const [searchParams, setSearchParams] = useSearchParams();
  /* 面板本机是否已导入 —— 本机默认不管控，未导入时选项里不出现、也不回落过去 */
  const localHostInfo = useLocalHost();
  const localUsable = isAdmin && localHostInfo.enabled;
  const hostParam = searchParams.get('host') ?? '';
  const view: 'fleet' | 'host' = hostParam ? 'host' : 'fleet';
  const hostId = hostParam || 'local';
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  /* 正在单机扫描的 host_id：让「扫描」按钮就地转圈，不阻塞其它主机 */
  const [scanningId, setScanningId] = useState<string | null>(null);

  /*
    服务器区是「卡片」还是「表格」：两种视图回答的问题不一样 ——
    卡片把一台机器的评分、问题构成、待办项摊开看；列表把十几台机器拉成行，
    一眼横向比对分数与不合格数。记在本地，下次进来还是同一种。
    放进 localStorage 而不是 URL：它只是偏好，不该进分享出去的链接。
  */
  const [hostView, setHostView] = useState<HostViewMode>(readHostView);
  useEffect(() => {
    try {
      localStorage.setItem(HOST_VIEW_KEY, hostView);
    } catch {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  }, [hostView]);

  const targetsQuery = useQuery({
    queryKey: ['baseline', 'targets'],
    queryFn: baselineApi.targets,
    staleTime: 300_000,
    retry: false,
  });

  const fleetQuery = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: () => baselineApi.fleet(),
    enabled: view === 'fleet',
    staleTime: SCAN_STALE_TIME,
    gcTime: SCAN_GC_TIME,
    retry: false,
  });

  const hostQuery = useQuery({
    queryKey: ['baseline', 'host', hostId],
    queryFn: () => baselineApi.host(hostId),
    enabled: view === 'host',
    staleTime: SCAN_STALE_TIME,
    gcTime: SCAN_GC_TIME,
    retry: false,
  });

  const hosts = targetsQuery.data?.hosts ?? [];
  const fleet = fleetQuery.data;
  const report = hostQuery.data;

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

  /* 加固后让总览与详情一起失效：改动会同时影响两边的评分 */
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ['baseline'] });
  };

  /** 进单机详情；再点一次「总览」= 清掉 ?host= */
  const openHost = (id: string) => setSearchParams({ host: id });
  const showFleet = () => setSearchParams({});

  /* 单机扫描：只体检这一台，再把总览拉一遍。
     总览的汇总口径（问题排序、KPI 合计）在服务端算，这里不重复实现一份 ——
     否则后端改了 compaction，前端那份副本会悄悄跑偏。 */
  const scanHost = async (id: string) => {
    setScanningId(id);
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: ['baseline', 'host', id],
        queryFn: () => baselineApi.host(id),
        /* 点了「扫描」就必须真跑一遍：缓存里那份可能还新鲜（5 分钟），
           不写 0 的话 fetchQuery 直接回缓存，按钮转一圈其实什么都没做 */
        staleTime: 0,
      });
      await queryClient.invalidateQueries({ queryKey: ['baseline', 'fleet'] });
      toast.success(
        t('baseline.scannedToast', { name: fresh.name || id }),
        fresh.ok
          ? t('baseline.scannedDetail', {
              score: fresh.score,
              grade: fresh.grade_label,
              fail: fresh.summary.fail,
              warn: fresh.summary.warn,
            })
          : fresh.error || t('baseline.hostUnreachable'),
      );
    } catch (err) {
      toast.error(t('baseline.scanFailed'), errorMessage(err));
    } finally {
      setScanningId(null);
    }
  };

  /*
    列表视图的列：与卡片用的是同一份数据、同一套口径，只是把它摊成行 ——
    十几台机器时横向比对分数比翻卡片快得多。排序交给 Table 自己处理。
  */
  const [hostSort, setHostSort] = useState<SortState | null>(null);
  const hostColumns = useMemo<Array<Column<BaselineHostSummary>>>(
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
        key: 'score',
        header: t('baseline.colScore'),
        width: 78,
        align: 'center',
        sortable: true,
        /* 连不上的排最后：它的问题不是分数低，是没分数 */
        sortValue: (host) => (host.ok ? host.score : -1),
        render: (host) =>
          host.ok ? (
            <span className="baseline-list-score">{host.score}</span>
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        key: 'grade',
        header: t('baseline.colGrade'),
        width: 108,
        sortable: true,
        sortValue: (host) => (host.ok ? host.grade : ''),
        render: (host) => (
          <Badge variant={GRADE_VARIANT[host.grade] ?? 'neutral'} size="sm">
            {host.ok ? host.grade_label : t('baseline.notScanned')}
          </Badge>
        ),
      },
      {
        key: 'counts',
        header: t('baseline.colCounts'),
        width: 150,
        sortable: true,
        title: t('baseline.sortByFail'),
        sortValue: (host) => (host.ok ? host.summary.fail : -1),
        render: (host) =>
          host.ok ? (
            <span className="baseline-list-counts mono fs-sm">
              <span className="is-pass">{host.summary.pass}</span>
              <span className="is-sep"> / </span>
              <span className="is-warn">{host.summary.warn}</span>
              <span className="is-sep"> / </span>
              <span className="is-fail">{host.summary.fail}</span>
            </span>
          ) : (
            <span className="fs-xs text-danger">
              {host.error || t('baseline.cannotConnect')}
            </span>
          ),
      },
      {
        key: 'issues',
        header: t('baseline.colPending'),
        render: (host) =>
          host.issues.length ? (
            <span className="baseline-issue-list">
              {host.issues.map((issue) => (
                <span key={issue.key} className="baseline-issue">
                  <span
                    className={`baseline-dot is-${issue.severity}`}
                    aria-hidden="true"
                  />
                  {issue.label}
                </span>
              ))}
            </span>
          ) : host.ok ? (
            <span className="fs-xs" style={{ color: 'var(--success)' }}>
              {t('baseline.allPassedShort', { n: host.summary.total })}
            </span>
          ) : null,
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
              title={t('baseline.scanOneTitle', { name: host.name || host.host_id })}
              onClick={() => void scanHost(host.host_id)}
            >
              {scanningId === host.host_id ? t('baseline.scanning') : t('baseline.scan')}
            </button>
          </div>
        ),
      },
    ],
    [openHost, scanHost, scanningId, t],
  );

  const runFix = async (key: string, label: string) => {
    setBusyKey(key);
    try {
      const result = await baselineApi.fix(key, hostId);
      toast.success(t('baseline.fixDone', { label }), result.detail);
      await refreshAll();
    } catch (err) {
      toast.error(t('baseline.fixFailed'), errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const runFixAll = async () => {
    setBusyAll(true);
    try {
      const result = await baselineApi.fixAll(hostId);
      if (result.failed) {
        toast.warning(
          t('baseline.fixPartial'),
          t('baseline.fixPartialDetail', {
            fixed: result.fixed,
            failed: result.failed,
          }),
        );
      } else if (result.fixed) {
        toast.success(
          t('baseline.fixedN', { fixed: result.fixed }),
          t('baseline.fixedNDetail'),
        );
      } else {
        toast.info(t('baseline.nothingToFix'), t('baseline.nothingToFixDetail'));
      }
      await refreshAll();
    } catch (err) {
      toast.error(t('baseline.fixAllFailed'), errorMessage(err));
    } finally {
      setBusyAll(false);
    }
  };

  /*
    「重新体检全部」不能走 refetch()：后端的这份报告有一层 2 分钟缓存，
    普通 GET 会直接吃缓存，点了等于没点。这里显式带 refresh=1 重跑一轮，
    再把结果写回查询缓存（写回同时把本地缓存标成刚更新，不会紧接着又请求一次）。
    单机详情没有那层缓存，照旧 refetch。
  */
  const [rescanningAll, setRescanningAll] = useState(false);

  const rescanAll = async () => {
    setRescanningAll(true);
    try {
      const fresh = await baselineApi.fleet(true);
      queryClient.setQueryData(['baseline', 'fleet'], fresh);
      toast.success(
        t('baseline.rescannedAll'),
        t('baseline.rescannedAllDetail', {
          hosts: fresh.totals.hosts,
          avg: fresh.totals.avg_score,
          time: formatDateTime(fresh.generated_at),
        }),
      );
    } catch (err) {
      toast.error(t('baseline.checkFailed'), errorMessage(err));
    } finally {
      setRescanningAll(false);
    }
  };

  const busy = view === 'fleet' ? rescanningAll : hostQuery.isFetching;
  const refetch = () =>
    view === 'fleet' ? void rescanAll() : void hostQuery.refetch();

  const pending = report
    ? report.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    : [];

  return (
    <PageShell
      title={t('baseline.title')}
      subtitle={t('baseline.subtitle')}
      actions={
        <div className="form-row">
          {/* 体检出问题之后，最自然的下一步是「让 AI 帮我看看」——
              带着当前主机跳过去，问题也一并预填好 */}
          {view === 'host' && hostId ? (
            <AskAiButton hostId={hostId} question={t('ai.askFromBaseline')} />
          ) : null}
          {view === 'host' && canManage && report?.elevated && report.summary.auto_fixable > 0 ? (
            <Button
              size="sm"
              variant="primary"
              icon={<IconShield size={14} />}
              loading={busyAll}
              onClick={() => void runFixAll()}
              title={t('baseline.fixAllTitle')}
            >
              {t('baseline.fixAll', { n: report.summary.auto_fixable })}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh size={14} />}
            loading={busy}
            onClick={refetch}
          >
            {view === 'fleet' ? t('baseline.rescanAll') : t('baseline.rescan')}
          </Button>
        </div>
      }
    >
      {/* 面板本机默认不管控；未导入时提示一次（已导入 / 非管理员不渲染） */}
      <LocalHostNotice />

      {/* ---- 视图切换 ---- */}
      <Card collapsible={false}>
        <div className="baseline-viewbar">
          <div className="segmented" role="tablist" aria-label={t('baseline.viewAria')}>
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
                  : /* 兜底只给「已导入本机」的管理员：本机默认不管控，未导入时点了必 409 */
                    localUsable
                    ? [{ label: t('baseline.localOption'), value: 'local' }]
                    : []
              }
              style={{ maxWidth: 280 }}
            />
          ) : null}

          <span className="baseline-viewbar-meta">
            {view === 'fleet' && fleet ? (
              <>
                <span>
                  {t('baseline.checkedAt', { time: formatDateTime(fleet.generated_at) })}
                  {/* 缓存过期后进页面会先显示这份结果再后台重扫：得让人知道
                      屏幕上的分数正在被刷新，而不是以为它过时了 */}
                  {fleetQuery.isFetching ? t('baseline.rescanning') : ''}
                </span>
                <span>
                  {t('baseline.fleetTotals', {
                    n: fleet.totals.hosts,
                    score: fleet.totals.avg_score,
                  })}
                </span>
              </>
            ) : null}
            {view === 'host' && report ? (
              <>
                <span>
                  {t('baseline.checkedAt', { time: formatDateTime(report.checked_at) })}
                </span>
                <span>
                  {report.local
                    ? t('baseline.hostOfPanel')
                    : t('baseline.managedHost', { address: report.address })}
                </span>
                {hostQuery.isFetching ? (
                  <span>{t('baseline.rescanningShort')}</span>
                ) : null}
              </>
            ) : null}
          </span>
        </div>
      </Card>

      {/* ================================================== 全平台总览 */}
      {view === 'fleet' ? (
        <>
          {fleetQuery.isError ? (
            <Card collapsible={false}>
              <ErrorState
                title={t('baseline.checkFailed')}
                message={errorMessage(fleetQuery.error)}
                onRetry={() => void fleetQuery.refetch()}
              />
            </Card>
          ) : null}

          {/* 没有数据时也把 KPI 摆上（转骨架）：一轮体检要几秒到几十秒，
              这段时间页面不该只剩底下那一行「正在体检」 */}
          {!fleetQuery.isError ? (
            <div className="grid grid-4">
              <KpiCard
                label={t('baseline.kpi.hosts')}
                value={fleet?.totals.hosts ?? '—'}
                icon={<IconServer size={16} />}
                tone="accent"
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.unreachable
                      ? t('baseline.kpi.reachable', {
                          reachable: fleet.totals.reachable,
                          unreachable: fleet.totals.unreachable,
                        })
                      : t('baseline.kpi.allReachable')
                    : undefined
                }
              />
              <KpiCard
                label={t('baseline.kpi.avg')}
                value={fleet?.totals.avg_score ?? '—'}
                icon={<IconShield size={16} />}
                tone={
                  !fleet || fleet.totals.avg_score >= 90
                    ? 'success'
                    : fleet.totals.avg_score >= 75
                      ? 'accent'
                      : fleet.totals.avg_score >= 60
                        ? 'warning'
                        : 'danger'
                }
                progress={fleet?.totals.avg_score}
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? t('baseline.kpi.worst', {
                        worst: fleet.totals.worst_score,
                        healthy: fleet.totals.healthy,
                      })
                    : undefined
                }
              />
              <KpiCard
                label={t('baseline.kpi.fail')}
                value={fleet?.totals.fail ?? '—'}
                icon={<IconAlert size={16} />}
                tone={fleet?.totals.fail ? 'danger' : 'success'}
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.fail
                      ? t('baseline.kpi.failHint')
                      : t('baseline.kpi.noFail')
                    : undefined
                }
              />
              <KpiCard
                label={t('baseline.kpi.warn')}
                value={fleet?.totals.warn ?? '—'}
                icon={<IconInfo size={16} />}
                tone={fleet?.totals.warn ? 'warning' : 'success'}
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.fixable
                      ? t('baseline.kpi.fixableHint', { n: fleet.totals.fixable })
                      : t('baseline.kpi.nothingFixable')
                    : undefined
                }
              />
            </div>
          ) : null}

          <Card collapsible={false}>
            <CardHeader
              title={
                fleet
                  ? t('baseline.hostsTitle', { n: fleet.hosts.length })
                  : t('baseline.hostsTitlePlain')
              }
              subtitle={t('baseline.hostsSubtitle')}
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
            {fleetQuery.isLoading ? (
              <>
                <p className="fs-sm text-muted mb-16">
                  {t('baseline.scanningAll')}
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
            ) : fleet && fleet.hosts.length ? (
              hostView === 'card' ? (
                <div className="baseline-host-grid">
                  {fleet.hosts.map((host) => (
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
                  caption={t('baseline.tableCaption')}
                  rows={fleet.hosts}
                  columns={hostColumns}
                  rowKey={(host) => host.host_id}
                  dense
                  sort={hostSort}
                  onSortChange={setHostSort}
                />
              )
            ) : !fleetQuery.isError ? (
              <EmptyState
                title={t('baseline.emptyFleetTitle')}
                description={t('baseline.emptyFleetDesc')}
                icon={<IconServer size={26} />}
              />
            ) : null}
          </Card>
        </>
      ) : null}

      {/* ================================================== 单机详情 */}
      {view === 'host' ? (
        <>
          {hostQuery.isError ? (
            <Card collapsible={false}>
              <ErrorState
                title={t('baseline.checkFailed')}
                message={errorMessage(hostQuery.error)}
                onRetry={() => void hostQuery.refetch()}
              />
            </Card>
          ) : null}

          {hostQuery.isLoading ? (
            <Card collapsible={false}>
              <div className="fs-sm text-muted">{t('baseline.dataLoading')}</div>
            </Card>
          ) : null}

          {report ? (
            <>
              {/* ---- 主机概览 ---- */}
              <Card collapsible={false}>
                <CardHeader
                  title={t('baseline.reportTitle')}
                  subtitle={
                    report.local
                      ? t('baseline.hostOfPanel')
                      : t('baseline.managedHost', { address: report.address })
                  }
                  icon={<IconShield size={16} />}
                />
                <div className="baseline-head">
                  <ScoreRing
                    score={report.score}
                    grade={report.grade}
                    ok={report.ok}
                    size={132}
                    stroke={10}
                  />

                  <div className="baseline-head-main">
                    <div className="baseline-head-title">
                      {report.name || report.host_id}
                      {report.local ? (
                        <Badge variant="accent" size="sm">
                          {t('baseline.localPanelHost')}
                        </Badge>
                      ) : null}
                      {report.ok && !report.elevated ? (
                        <Badge
                          variant="neutral"
                          size="sm"
                          title={t('baseline.readonlyHostTitle')}
                        >
                          {t('baseline.readonlyScan')}
                        </Badge>
                      ) : null}
                    </div>

                    <div className="baseline-head-conclusion">
                      {conclusionOf(report, t)}
                    </div>

                    {report.ok ? <Counts summary={report.summary} /> : null}
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
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">{t('baseline.metaPrivilege')}</span>
                      <span className="baseline-meta-value">
                        {privilegeLabel(report.privilege, t)}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* ---- 不可达 / 只读提示 ---- */}
              {!report.ok ? (
                <Notice
                  tone="danger"
                  title={t('baseline.unreachableTitle')}
                  icon={<IconAlert size={16} />}
                >
                  {report.error || t('baseline.cannotConnectShort')}
                  {t('baseline.unreachableTail')}
                </Notice>
              ) : null}

              {report.ok && !report.elevated ? (
                <Notice
                  tone="warning"
                  title={t('baseline.readonlyTitle')}
                  icon={<IconInfo size={16} />}
                >
                  {report.local
                    ? t('baseline.readonlyLocal')
                    : t('baseline.readonlyRemote')}
                </Notice>
              ) : null}

              {/* ---- 需要处理（可操作清单，置顶） ---- */}
              {report.ok && pending.length > 0 ? (
                <Card collapsible={false}>
                  <CardHeader
                    title={t('baseline.pendingTitle', { n: pending.length })}
                    subtitle={t('baseline.pendingSubtitle')}
                    icon={<IconAlert size={16} />}
                  />
                  <div className="baseline-todo">
                    {pending.map((item) => (
                      <CheckRow
                        key={item.key}
                        item={item}
                        action={
                          canManage && item.fixable ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busyKey === item.key}
                              disabled={busyAll || !report.elevated}
                              title={
                                report.elevated
                                  ? undefined
                                  : t('baseline.fixNoPermTitle')
                              }
                              onClick={() => void runFix(item.key, item.label)}
                            >
                              {t('baseline.fix')}
                            </Button>
                          ) : null
                        }
                      />
                    ))}
                  </div>
                </Card>
              ) : null}

              {report.ok && pending.length === 0 ? (
                <Notice
                  tone="success"
                  title={t('baseline.allPassTitle')}
                  icon={<IconCheck size={16} />}
                >
                  {t('baseline.allPassBody', { n: report.summary.total })}
                </Notice>
              ) : null}

              {/* ---- 全部检查（按分类，默认全部折叠） ----
                  需要处理的项已经在上面单独置顶了，这里只当参考手册用，所以默认收起；
                  但标题行必须自带信息量（有问题的项数 + 得分），否则收起就成了盲盒。 */}
              {report.categories.map((category) => {
                const fail = category.checks.filter((c) => c.status === 'fail').length;
                const warn = category.checks.filter((c) => c.status === 'warn').length;
                return (
                  <Card key={category.key} collapsible defaultOpen={false}>
                    <CardHeader
                      title={category.label}
                      subtitle={
                        fail || warn
                          ? t('baseline.catSubtitleIssues', {
                              total: category.checks.length,
                              fail,
                              warn,
                            })
                          : t('baseline.catSubtitleOk', {
                              total: category.checks.length,
                            })
                      }
                      icon={CATEGORY_ICONS[category.key] ?? <IconShield size={15} />}
                      actions={
                        <span className="baseline-cat-score">
                          {t('baseline.scoreValue', { n: category.score })}
                        </span>
                      }
                    />
                    <div className="baseline-todo">
                      {category.checks.map((item) => (
                        <CheckRow key={item.key} item={item} />
                      ))}
                    </div>
                  </Card>
                );
              })}

              {/* ---- 说明与加固策略 ---- */}
              <CollapsibleCard
                title={t('baseline.policyTitle')}
                icon={<IconInfo size={15} />}
              >
                <div className="fs-sm text-secondary" style={{ lineHeight: 1.9 }}>
                  <div>
                    <strong>{t('baseline.policyScopeLabel')}</strong>
                    {t('baseline.policyScope')}
                  </div>
                  <div>
                    <strong>{t('baseline.policyScoreLabel')}</strong>
                    {t('baseline.policyScore')}
                  </div>
                  <div>
                    <strong>{t('baseline.policyWriteLabel')}</strong>
                    {t('baseline.policyWriteA')}
                    <span className="mono">/etc/ssh/sshd_config.d/99-panel-baseline.conf</span>
                    {t('baseline.policyWriteB')}
                    <span className="mono">/etc/sysctl.d/99-panel-baseline.conf</span>
                    {t('baseline.policyWriteC')}
                    <span className="mono">/etc/login.defs</span>
                    {t('baseline.policyWriteD')}
                    <span className="mono">sshd -t</span>
                    {t('baseline.policyWriteE')}
                    <span className="mono">/proc</span>
                    {t('baseline.policyWriteF')}
                    <strong>{t('baseline.policyWriteG')}</strong>
                    {t('baseline.policyWriteH')}
                  </div>
                  <div>
                    <strong>{t('baseline.policyNoAutoLabel')}</strong>
                    {t('baseline.policyNoAuto')}
                  </div>
                  <div>
                    <strong>{t('baseline.policyAuditLabel')}</strong>
                    {t('baseline.policyAuditA')}
                    <span className="mono">baseline.read</span>
                    {t('baseline.policyAuditB')}
                    <span className="mono">baseline.fleet_read</span>
                    {t('baseline.policyAuditC')}
                    <span className="mono">baseline.fix</span>
                    {t('baseline.policyAuditD')}
                    <span className="mono">baseline.fix_all</span>
                    {t('baseline.policyAuditE')}
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

/* ---------------------------------------------------------------------------
   一句话结论
   --------------------------------------------------------------------------- */

function conclusionOf(report: BaselineReport, t: TFunc): string {
  if (!report.ok) {
    return t('baseline.conclusionUnreachable');
  }
  const { fail, warn, total } = report.summary;
  if (!fail && !warn) {
    return t('baseline.conclusionAllPass', { total });
  }
  if (fail) {
    return t('baseline.conclusionFails', { fail, warn });
  }
  return t('baseline.conclusionWarns', { warn });
}
