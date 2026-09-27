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
import type {
  BadgeVariant,
  BaselineCheck,
  BaselineHostSummary,
  BaselinePrivilege,
  BaselineReport,
  BaselineSeverity,
  BaselineStatus,
} from '../api/types';

const STATUS_META: Record<BaselineStatus, { variant: BadgeVariant; label: string }> = {
  pass: { variant: 'success', label: '通过' },
  warn: { variant: 'warning', label: '待改进' },
  fail: { variant: 'danger', label: '不合格' },
  unknown: { variant: 'neutral', label: '无法检测' },
};

const SEV_META: Record<BaselineSeverity, string> = {
  high: '高危',
  medium: '中危',
  low: '低危',
};

const GRADE_VARIANT: Record<string, BadgeVariant> = {
  A: 'success',
  B: 'accent',
  C: 'warning',
  D: 'danger',
};

const PRIVILEGE_LABEL: Record<BaselinePrivilege, string> = {
  root: 'root',
  sudo: 'sudo',
  none: '无特权',
};

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
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = ok ? Math.max(0, Math.min(100, score)) / 100 : 0;
  const level = ok && grade ? grade.toLowerCase() : 'none';

  return (
    <div
      className={`baseline-ring baseline-lvl-${level}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ok ? `评分 ${score} 分，等级 ${grade || '未评级'}` : '未完成体检'}
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
          {ok ? (grade ? `${grade} 级` : '') : '未体检'}
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
  const tone = size === 'sm' ? 'fs-xs' : '';
  return (
    <span className="baseline-counts">
      <span className={`baseline-count is-pass ${tone}`}>通过 {summary.pass}</span>
      {summary.fail > 0 ? (
        <span className={`baseline-count is-fail ${tone}`}>
          不合格 {summary.fail}
        </span>
      ) : null}
      {summary.warn > 0 ? (
        <span className={`baseline-count is-warn ${tone}`}>
          待改进 {summary.warn}
        </span>
      ) : null}
      {(summary.unknown ?? 0) > 0 ? (
        <span className={`baseline-count is-unknown ${tone}`}>
          无法检测 {summary.unknown}
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
            {SEV_META[item.severity]}
          </span>
          {item.status !== 'pass' ? (
            <Badge variant={STATUS_META[item.status].variant} size="sm">
              {STATUS_META[item.status].label}
            </Badge>
          ) : null}
        </div>

        <div className="baseline-item-values">
          实际：<span className={item.status === 'fail' ? 'is-bad' : ''}>{item.value}</span>
          {'　'}
          期望：{item.expected}
        </div>

        {item.detail ? (
          <div className="fs-xs text-muted">{item.detail}</div>
        ) : null}
        {item.hint && item.status !== 'pass' ? (
          <div className="baseline-item-hint">建议：{item.hint}</div>
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
      aria-label={`查看 ${host.name || host.host_id} 的体检详情`}
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
            {host.local ? '面板本机' : host.host || host.host_id}
          </span>
          <span className="form-row" style={{ gap: 6 }}>
            <Badge variant={GRADE_VARIANT[host.grade] ?? 'neutral'} size="sm">
              {host.ok ? host.grade_label : '未体检'}
            </Badge>
            {host.ok && !host.elevated ? (
              <Badge variant="neutral" size="sm" title="没有 root / sudo，只能体检不能加固">
                只读
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
            title={`通过 ${summary.pass} · 待改进 ${summary.warn} · 不合格 ${summary.fail}`}
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
              全部 {summary.total} 项检查通过
            </span>
          )}
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
        {/* 阻止冒泡：点「扫描」不该顺带把详情也打开 */}
        <span
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="baseline-host-scan"
            disabled={scanning}
            title={`只重新扫描 ${host.name || host.host_id} 这台主机`}
            onClick={() => onScan(host.host_id)}
          >
            {scanning ? '扫描中…' : '扫描'}
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
        label: host.local ? `本机（${host.name}）` : host.name || host.address,
        value: host.id,
      })),
    [hosts],
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
        `已扫描 ${fresh.name || id}`,
        fresh.ok
          ? `评分 ${fresh.score}（${fresh.grade_label}）· ${fresh.summary.fail} 项不合格 / ${fresh.summary.warn} 项待改进`
          : fresh.error || '这台主机连不上',
      );
    } catch (err) {
      toast.error('扫描失败', errorMessage(err));
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
        key: 'score',
        header: '评分',
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
        header: '等级',
        width: 108,
        sortable: true,
        sortValue: (host) => (host.ok ? host.grade : ''),
        render: (host) => (
          <Badge variant={GRADE_VARIANT[host.grade] ?? 'neutral'} size="sm">
            {host.ok ? host.grade_label : '未体检'}
          </Badge>
        ),
      },
      {
        key: 'counts',
        header: '通过 / 待改进 / 不合格',
        width: 150,
        sortable: true,
        title: '按不合格项数量排序',
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
            <span className="fs-xs text-danger">{host.error || '无法连接'}</span>
          ),
      },
      {
        key: 'issues',
        header: '待处理',
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
              全部 {host.summary.total} 项通过
            </span>
          ) : null,
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
              title={`只重新扫描 ${host.name || host.host_id} 这台主机`}
              onClick={() => void scanHost(host.host_id)}
            >
              {scanningId === host.host_id ? '扫描中…' : '扫描'}
            </button>
          </div>
        ),
      },
    ],
    [openHost, scanHost, scanningId],
  );

  const runFix = async (key: string, label: string) => {
    setBusyKey(key);
    try {
      const result = await baselineApi.fix(key, hostId);
      toast.success(`已加固：${label}`, result.detail);
      await refreshAll();
    } catch (err) {
      toast.error('加固失败', errorMessage(err));
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
          '部分加固失败',
          `成功 ${result.fixed} 项，失败 ${result.failed} 项，详见各项提示`,
        );
      } else if (result.fixed) {
        toast.success(`已加固 ${result.fixed} 项`, '已重新体检，可查看最新评分');
      } else {
        toast.info('没有需要加固的项', '当前可自动处理的项均已达标');
      }
      await refreshAll();
    } catch (err) {
      toast.error('批量加固失败', errorMessage(err));
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
        '已重新体检全部服务器',
        `${fresh.totals.hosts} 台 · 平均 ${fresh.totals.avg_score} 分 · 体检时间 ${formatDateTime(fresh.generated_at)}`,
      );
    } catch (err) {
      toast.error('体检失败', errorMessage(err));
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
      title="安全基线"
      subtitle="对整个平台的服务器做一键体检：SSH、口令策略、防火墙、时间同步、弱口令账号与内核参数"
      actions={
        <div className="form-row">
          {view === 'host' && canManage && report?.elevated && report.summary.auto_fixable > 0 ? (
            <Button
              size="sm"
              variant="primary"
              icon={<IconShield size={14} />}
              loading={busyAll}
              onClick={() => void runFixAll()}
              title="批量修复所有可安全自动处理的项；关闭 SSH 口令认证等可能锁定登录的项需单独修复"
            >
              一键加固（{report.summary.auto_fixable}）
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefresh size={14} />}
            loading={busy}
            onClick={refetch}
          >
            {view === 'fleet' ? '重新体检全部' : '重新体检'}
          </Button>
        </div>
      }
    >
      {/* ---- 视图切换 ---- */}
      <Card collapsible={false}>
        <div className="baseline-viewbar">
          <div className="segmented" role="tablist" aria-label="体检视图">
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
                  : /* 兜底只给管理员：普通用户看不到本机，给这个选项点了必 403 */
                    isAdmin
                    ? [{ label: '本机', value: 'local' }]
                    : []
              }
              style={{ maxWidth: 280 }}
            />
          ) : null}

          <span className="baseline-viewbar-meta">
            {view === 'fleet' && fleet ? (
              <>
                <span>
                  体检时间 {formatDateTime(fleet.generated_at)}
                  {/* 缓存过期后进页面会先显示这份结果再后台重扫：得让人知道
                      屏幕上的分数正在被刷新，而不是以为它过时了 */}
                  {fleetQuery.isFetching ? ' · 正在重新体检…' : ''}
                </span>
                <span>
                  {fleet.totals.hosts} 台服务器 · 平均 {fleet.totals.avg_score} 分
                </span>
              </>
            ) : null}
            {view === 'host' && report ? (
              <>
                <span>体检时间 {formatDateTime(report.checked_at)}</span>
                <span>
                  {report.local ? '面板所在主机' : `受管主机 ${report.address}`}
                </span>
                {hostQuery.isFetching ? <span>正在重新体检…</span> : null}
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
                title="体检失败"
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
                label="服务器总数"
                value={fleet?.totals.hosts ?? '—'}
                icon={<IconServer size={16} />}
                tone="accent"
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.unreachable
                      ? `可达 ${fleet.totals.reachable} · 不可达 ${fleet.totals.unreachable}`
                      : '全部可达'
                    : undefined
                }
              />
              <KpiCard
                label="平均评分"
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
                    ? `最低 ${fleet.totals.worst_score} 分 · 达标 ${fleet.totals.healthy} 台`
                    : undefined
                }
              />
              <KpiCard
                label="不合格项"
                value={fleet?.totals.fail ?? '—'}
                icon={<IconAlert size={16} />}
                tone={fleet?.totals.fail ? 'danger' : 'success'}
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.fail
                      ? '建议优先处理高危项'
                      : '没有不合格项'
                    : undefined
                }
              />
              <KpiCard
                label="待改进项"
                value={fleet?.totals.warn ?? '—'}
                icon={<IconInfo size={16} />}
                tone={fleet?.totals.warn ? 'warning' : 'success'}
                loading={fleetQuery.isLoading}
                hint={
                  fleet
                    ? fleet.totals.fixable
                      ? `其中 ${fleet.totals.fixable} 项可自动加固`
                      : '没有可自动加固的项'
                    : undefined
                }
              />
            </div>
          ) : null}

          <Card collapsible={false}>
            <CardHeader
              title={fleet ? `服务器（${fleet.hosts.length}）` : '服务器'}
              subtitle="按「最需要处理」排序：有不合格项的最前，其次是连不上的主机"
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
            {fleetQuery.isLoading ? (
              <>
                <p className="fs-sm text-muted mb-16">
                  正在并发体检所有服务器…（每台一条 SSH，首次要等几秒；结果会缓存 5
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
                  caption="服务器安全基线总览"
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
                title="还没有可体检的服务器"
                description="本机应该总是可用；要体检其它服务器，先去「SSH 安全 → 受管主机」把它们加进来。"
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
                title="体检失败"
                message={errorMessage(hostQuery.error)}
                onRetry={() => void hostQuery.refetch()}
              />
            </Card>
          ) : null}

          {hostQuery.isLoading ? (
            <Card collapsible={false}>
              <div className="fs-sm text-muted">正在读取安全配置…</div>
            </Card>
          ) : null}

          {report ? (
            <>
              {/* ---- 主机概览 ---- */}
              <Card collapsible={false}>
                <CardHeader
                  title="体检评分"
                  subtitle={
                    report.local
                      ? '面板所在主机'
                      : `受管主机 ${report.address}`
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
                          面板本机
                        </Badge>
                      ) : null}
                      {report.ok && !report.elevated ? (
                        <Badge
                          variant="neutral"
                          size="sm"
                          title="该主机上没有 root / sudo，只能体检不能加固"
                        >
                          只读体检
                        </Badge>
                      ) : null}
                    </div>

                    <div className="baseline-head-conclusion">
                      {conclusionOf(report)}
                    </div>

                    {report.ok ? <Counts summary={report.summary} /> : null}
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
                    <div className="baseline-meta-item">
                      <span className="baseline-meta-label">加固权限</span>
                      <span className="baseline-meta-value">
                        {PRIVILEGE_LABEL[report.privilege]}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* ---- 不可达 / 只读提示 ---- */}
              {!report.ok ? (
                <Notice tone="danger" title="这台服务器体检不了" icon={<IconAlert size={16} />}>
                  {report.error || '无法连接'}
                  。请先在「SSH 安全 → 受管主机」里确认它能连上（地址、端口、凭据、
                  指纹是否已信任），修好之后回到这里刷新。
                </Notice>
              ) : null}

              {report.ok && !report.elevated ? (
                <Notice tone="warning" title="这台服务器只有只读权限" icon={<IconInfo size={16} />}>
                  {report.local
                    ? '面板进程不是以 root 运行，读不到 /etc/shadow 等文件，也改不了系统配置。用 root 运行面板（或 systemd 以 root 托管）即可解锁全部检查与一键加固。'
                    : '该主机的 SSH 凭据没有 root / sudo 权限：读不到 /etc/shadow 或系统日志，也无法写入配置文件。请给它一个带免密 sudo 的账号（在「SSH 安全 → 受管主机」里勾选「使用 sudo」）后再来加固。'}
                </Notice>
              ) : null}

              {/* ---- 需要处理（可操作清单，置顶） ---- */}
              {report.ok && pending.length > 0 ? (
                <Card collapsible={false}>
                  <CardHeader
                    title={`需要处理（${pending.length}）`}
                    subtitle="按严重程度排序。可自动修复的直接点「修复」，其余的按建议手动处理"
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
                                  : '缺少 root / sudo 权限，无法自动加固'
                              }
                              onClick={() => void runFix(item.key, item.label)}
                            >
                              修复
                            </Button>
                          ) : null
                        }
                      />
                    ))}
                  </div>
                </Card>
              ) : null}

              {report.ok && pending.length === 0 ? (
                <Notice tone="success" title="全部检查通过" icon={<IconCheck size={16} />}>
                  {report.summary.total} 项检查全部达标，保持定期体检即可。
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
                          ? `${category.checks.length} 项检查 · ${fail} 项不合格 / ${warn} 项待改进`
                          : `${category.checks.length} 项检查全部通过`
                      }
                      icon={CATEGORY_ICONS[category.key] ?? <IconShield size={15} />}
                      actions={
                        <span className="baseline-cat-score">
                          {category.score} 分
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
                title="体检范围与加固策略"
                icon={<IconInfo size={15} />}
              >
                <div className="fs-sm text-secondary" style={{ lineHeight: 1.9 }}>
                  <div>
                    <strong>体检对象</strong>：整个平台的服务器 —— 面板所在主机（本机）
                    与「SSH 安全 → 受管主机」里启用的主机。两端在后端共用同一套判定
                    逻辑，结论口径一致；集群里的 Proxmox 节点若要体检，把它作为受管
                    主机加进来即可（PVE API 本身不提供在节点上执行 shell 的能力）。
                  </div>
                  <div>
                    <strong>评分口径</strong>：按严重级别加权 —— 高危 3、中危 2、
                    低危 1，「待改进」按半分计；「无法检测」的项不计入分母，所以缺
                    权限时不会被冤枉扣分。
                  </div>
                  <div>
                    <strong>一键加固写哪儿</strong>：只写面板自己命名的文件 ——
                    <span className="mono">/etc/ssh/sshd_config.d/99-panel-baseline.conf</span>
                    与 <span className="mono">/etc/sysctl.d/99-panel-baseline.conf</span>；
                    修改 <span className="mono">/etc/login.defs</span> 前先备份。SSH
                    配置改完立刻 <span className="mono">sshd -t</span> 校验、内核参数
                    改完复读 <span className="mono">/proc</span> 确认，校验不过
                    <strong>自动回滚</strong>，不会把机器改到登录不上去。
                  </div>
                  <div>
                    <strong>不会自动做的事</strong>：关闭 SSH 口令认证这类可能把人锁
                    在门外的项只能逐项确认后单独修复；受管主机若正用「root + 口令」
                    或「口令认证」连接，相应的加固会被直接拒绝（否则面板会连同自己
                    一起关在门外）。防火墙、PAM 复杂度模块、UID 0 账号这些因环境而
                    异的项只给可执行的手动建议。
                  </div>
                  <div>
                    <strong>审计</strong>：报告读取记{' '}
                    <span className="mono">baseline.read</span> /{' '}
                    <span className="mono">baseline.fleet_read</span>，加固记{' '}
                    <span className="mono">baseline.fix</span> /{' '}
                    <span className="mono">baseline.fix_all</span>。
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

function conclusionOf(report: BaselineReport): string {
  if (!report.ok) {
    return '这台服务器暂时体检不了，先在「SSH 安全 → 受管主机」里确认它能连上。';
  }
  const { fail, warn, total } = report.summary;
  if (!fail && !warn) {
    return `全部 ${total} 项检查达标，保持定期体检即可。`;
  }
  if (fail) {
    return `有 ${fail} 项不合格、${warn} 项待改进，建议优先处理不合格的高危项。`;
  }
  return `没有不合格项，还有 ${warn} 项可以再收紧一些。`;
}
