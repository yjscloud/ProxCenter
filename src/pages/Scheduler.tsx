/* ==========================================================================
   ProxCenter — 后台任务
   ==========================================================================

   面板的后台巡检（资源告警、SSH 安全、端口/进程、监控采样、证书续期、
   各类保留清理……）统一由后端的调度器驱动，见 backend/app/scheduler.py。

   这一页回答三个问题：

     1. 它们在跑吗？—— 每个作业的上次执行时间、耗时、成败与累计次数；
     2. 多久跑一次？—— 间隔可直接改，改完下一个周期生效，不必重启；
     3. 出问题了吗？—— 失败原因、因上一轮未结束而跳过的次数、
        「疑似停摆」标记（距上次成功执行已经远超它的间隔）。

   数据每 5 秒自刷一次，所以调整完间隔能立刻看到「下次执行」跟着变。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { schedulerApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import type { BadgeVariant, SchedulerJob } from '../api/types';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Table, type Column } from '../components/ui/Table';
import { ErrorState, Notice } from '../components/ui/EmptyState';
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconClock,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSettings,
  IconTasks,
} from '../components/Icons';
import { formatUptime, formatRelative, formatDateTime } from '../utils/format';
import { useToast } from '../hooks/useToast';
import { useT, type TFunc } from '../i18n';

/* 自刷周期：比调度器的 tick（1 秒）慢得多，但足够让「下次执行」看起来是活的 */
const REFRESH = 5_000;

/* 间隔编辑里的一键预设。覆盖「巡检类」与「清理类」两个量级。 */
const INTERVAL_PRESETS = [
  { key: 'scheduler.preset1m', seconds: 60 },
  { key: 'scheduler.preset5m', seconds: 300 },
  { key: 'scheduler.preset15m', seconds: 900 },
  { key: 'scheduler.preset1h', seconds: 3_600 },
  { key: 'scheduler.preset6h', seconds: 21_600 },
  { key: 'scheduler.preset1d', seconds: 86_400 },
] as const;

function statusMeta(
  job: SchedulerJob,
  t: TFunc,
): { label: string; variant: BadgeVariant } {
  if (!job.enabled) return { label: t('scheduler.status.disabled'), variant: 'neutral' };
  if (job.running) return { label: t('scheduler.status.running'), variant: 'info' };
  switch (job.last_status) {
    case 'ok':
      return { label: t('scheduler.status.ok'), variant: 'success' };
    case 'error':
      return { label: t('scheduler.status.error'), variant: 'danger' };
    default:
      return { label: t('scheduler.status.pending'), variant: 'neutral' };
  }
}

/**
 * 疑似停摆：启用了、不在执行中，而距上次执行结束已经远超它自己的间隔。
 *
 * 光看「上次是否失败」会漏掉一类问题：作业没抛异常，但每次都卡在某个
 * 静默的重试里，或者调度任务本身已经死了 —— 那时状态还是上一次的「正常」。
 * 用「多久没跑过」判断更直接。留 3 倍间隔 + 60 秒的宽限，免得偶发慢一拍
 * 就报红。
 */
function isStale(job: SchedulerJob): boolean {
  if (!job.enabled || job.running || !job.last_end) return false;
  const silentFor = Date.now() / 1000 - job.last_end;
  return silentFor > job.interval * 3 + 60;
}

export function Scheduler() {
  const t = useT();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SchedulerJob | null>(null);
  const [intervalDraft, setIntervalDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ['scheduler'],
    queryFn: schedulerApi.list,
    refetchInterval: REFRESH,
  });

  const jobs = query.data?.jobs ?? [];

  /* 弹框里的编辑对象来自列表快照：每 5 秒刷新一次，若直接引用 query 里的
     对象，用户正在输入时表单会被刷掉。所以用打开那一刻的快照。 */
  useEffect(() => {
    if (editing) setIntervalDraft(String(editing.interval));
  }, [editing]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const buckets: Record<string, SchedulerJob[]> = {};
    for (const job of jobs) {
      if (!buckets[job.group]) {
        buckets[job.group] = [];
        order.push(job.group);
      }
      buckets[job.group].push(job);
    }
    return order.map((name) => ({ name, jobs: buckets[name] }));
  }, [jobs]);

  const failing = jobs.filter((job) => job.enabled && job.last_status === 'error');
  const stale = jobs.filter(isStale);

  const runNow = async (job: SchedulerJob) => {
    setBusyId(job.id);
    try {
      const result = await schedulerApi.runNow(job.id);
      if (result.last_status === 'ok') {
        toast.success(
          t('scheduler.runDone', { name: job.name }),
          result.last_summary
            ? t('scheduler.runDoneDetail', {
                summary: result.last_summary,
                ms: result.last_duration_ms,
              })
            : t('scheduler.duration', { ms: result.last_duration_ms }),
        );
      } else {
        // 失败也要把原因直接说出来：这个按钮的用途就是看错误
        toast.error(
          t('scheduler.runFailed', { name: job.name }),
          result.last_error || t('scheduler.unknownError'),
        );
      }
      await query.refetch();
    } catch (err) {
      toast.error(t('scheduler.cannotRun'), errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (job: SchedulerJob) => {
    setBusyId(job.id);
    try {
      await schedulerApi.configure(job.id, { enabled: !job.enabled });
      await query.refetch();
      toast.success(
        job.enabled
          ? t('scheduler.disabledJob', { name: job.name })
          : t('scheduler.enabledJob', { name: job.name }),
      );
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const saveConfig = async () => {
    if (!editing) return;
    const interval = Number(intervalDraft);
    if (!Number.isFinite(interval) || interval <= 0) {
      toast.error(t('scheduler.invalidInterval'), t('scheduler.invalidIntervalHint'));
      return;
    }
    setSaving(true);
    try {
      await schedulerApi.configure(editing.id, { interval });
      await query.refetch();
      setEditing(null);
      toast.success(
        t('scheduler.intervalUpdated', { name: editing.name }),
        t('scheduler.intervalUpdatedHint'),
      );
    } catch (err) {
      toast.error(t('scheduler.saveFailed'), errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const resetJob = async (job: SchedulerJob) => {
    setBusyId(job.id);
    try {
      await schedulerApi.reset(job.id);
      await query.refetch();
      setEditing(null);
      toast.success(t('scheduler.resetDone', { name: job.name }));
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const columns: Array<Column<SchedulerJob>> = [
    {
      key: 'job',
      header: t('scheduler.colJob'),
      render: (job) => (
        <div>
          <div className="flex items-center gap-6">
            <span className="fw-600">{job.name}</span>
            {job.modified ? (
              <Badge variant="warning" size="sm">
                {t('scheduler.adjusted')}
              </Badge>
            ) : null}
            {job.last_manual ? (
              <Badge variant="info" size="sm">
                {t('scheduler.manual')}
              </Badge>
            ) : null}
          </div>
          <div className="fs-xs text-muted">{job.description}</div>
        </div>
      ),
    },
    {
      key: 'interval',
      header: t('scheduler.colInterval'),
      width: 120,
      render: (job) => (
        <div>
          <div className="fs-sm">{formatUptime(job.interval)}</div>
          {job.modified ? (
            <div className="fs-xs text-muted">
              {t('scheduler.defaultValue', { value: formatUptime(job.default_interval) })}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      width: 150,
      render: (job) => {
        const meta = statusMeta(job, t);
        const stalled = isStale(job);
        return (
          <div>
            <Badge variant={meta.variant} size="sm" dot pulse={job.running}>
              {meta.label}
            </Badge>
            {stalled ? (
              <div className="fs-xs text-warning">{t('scheduler.staleHint')}</div>
            ) : null}
            {job.last_summary ? (
              <div className="fs-xs text-muted">{job.last_summary}</div>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'last',
      header: t('scheduler.colLastRun'),
      width: 170,
      render: (job) => (
        <div>
          <div className="fs-sm">{formatRelative(job.last_start)}</div>
          <div className="fs-xs text-muted">
            {job.last_duration_ms
              ? t('scheduler.duration', { ms: job.last_duration_ms })
              : job.last_end
                ? '—'
                : t('scheduler.neverRun')}
          </div>
        </div>
      ),
    },
    {
      key: 'next',
      header: t('scheduler.colNextRun'),
      width: 140,
      render: (job) =>
        !job.enabled ? (
          <span className="text-muted fs-sm">{t('scheduler.status.disabled')}</span>
        ) : job.running ? (
          <span className="text-muted fs-sm">{t('scheduler.status.running')}</span>
        ) : (
          <div>
            <div className="fs-sm">
              {job.next_in < 1
                ? t('scheduler.imminent')
                : t('scheduler.afterSeconds', { n: Math.round(job.next_in) })}
            </div>
            <div className="fs-xs text-muted">{formatDateTime(job.next_at)}</div>
          </div>
        ),
    },
    {
      key: 'counters',
      header: t('scheduler.colTotals'),
      width: 130,
      render: (job) => (
        <div className="fs-xs">
          <div className="text-muted">{t('scheduler.runsCount', { n: job.runs })}</div>
          {job.failures ? (
            <div className="text-danger">{t('scheduler.failCount', { n: job.failures })}</div>
          ) : null}
          {job.skipped ? (
            <div className="text-warning" title={t('scheduler.skippedTitle')}>
              {t('scheduler.skippedCount', { n: job.skipped })}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 210,
      render: (job) => (
        <div className="form-row">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconPlay size={14} />}
            loading={busyId === job.id}
            onClick={() => void runNow(job)}
          >
            {t('scheduler.runNow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconSettings size={14} />}
            onClick={() => setEditing(job)}
          >
            {t('scheduler.configure')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={job.enabled ? <IconPause size={14} /> : <IconCheck size={14} />}
            onClick={() => void toggle(job)}
          >
            {job.enabled ? t('scheduler.disable') : t('common.enable')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title={t('scheduler.title')}
      subtitle={t('scheduler.subtitle')}
      actions={
        <Button
          variant="ghost"
          icon={<IconRefresh size={15} />}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      {query.isError ? (
        <ErrorState
          title={t('scheduler.loadFailed')}
          message={errorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {/* ---- KPI ---- */}
      <div className="grid grid-4">
        <KpiCard
          label={t('scheduler.kpi.total')}
          value={query.data?.total ?? 0}
          icon={<IconTasks size={16} />}
          tone="accent"
          loading={query.isLoading}
          hint={t('scheduler.kpi.enabledHint', { n: query.data?.enabled ?? 0 })}
        />
        <KpiCard
          label={t('scheduler.kpi.running')}
          value={query.data?.running ?? 0}
          icon={<IconActivity size={16} />}
          tone="accent"
          loading={query.isLoading}
          hint={t('scheduler.kpi.runningHint')}
        />
        <KpiCard
          label={t('scheduler.kpi.failing')}
          value={failing.length}
          icon={<IconAlert size={16} />}
          tone={failing.length ? 'danger' : 'success'}
          loading={query.isLoading}
          hint={failing.length ? t('scheduler.kpi.failingHint') : t('scheduler.kpi.allOk')}
        />
        <KpiCard
          label={t('scheduler.kpi.stale')}
          value={stale.length}
          icon={<IconClock size={16} />}
          tone={stale.length ? 'warning' : 'success'}
          loading={query.isLoading}
          hint={t('scheduler.kpi.staleHint')}
        />
      </div>

      {/* ---- 失败明细：放在最上面，这是最该被处理的信息 ---- */}
      {failing.length > 0 ? (
        <Card collapsible={false}>
          <CardHeader
            title={t('scheduler.failingTitle')}
            subtitle={t('scheduler.failingSubtitle')}
            icon={<IconAlert size={16} />}
          />
          <div className="dyn-list">
            {failing.map((job) => (
              <div key={job.id}>
                <div className="fs-sm fw-600">
                  {job.name}
                  <span className="fs-xs text-muted"> · {formatRelative(job.last_end)}</span>
                </div>
                <div className="fs-xs text-danger" style={{ wordBreak: 'break-all' }}>
                  {job.last_error || t('scheduler.noErrorRecord')}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ---- 分组表格 ---- */}
      {groups.map((group) => (
        <Card key={group.name} collapsible={false}>
          <CardHeader
            title={group.name}
            subtitle={t('scheduler.groupJobs', { n: group.jobs.length })}
            icon={<IconTasks size={16} />}
          />
          <Table
            columns={columns}
            rows={group.jobs}
            rowKey={(job) => job.id}
            caption={t('scheduler.tableCaption', { group: group.name })}
            loading={query.isLoading}
            emptyTitle={t('scheduler.emptyTitle')}
            emptyDescription={t('scheduler.emptyDesc')}
          />
        </Card>
      ))}

      <Notice tone="info" title={t('scheduler.noticeTitle')}>
        {t('scheduler.noticeBody')}
      </Notice>

      {/* ---- 配置弹框 ---- */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? t('scheduler.configTitle', { name: editing.name }) : t('scheduler.configTitleFallback')}
        description={editing?.description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => editing && void resetJob(editing)}
              disabled={editing ? !editing.modified : true}
              title={
                editing?.modified
                  ? t('scheduler.restoreDefaultTitle')
                  : t('scheduler.alreadyDefaultTitle')
              }
            >
              {t('scheduler.restoreDefault')}
            </Button>
            <Button variant="primary" onClick={() => void saveConfig()} loading={saving}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <>
            <Field
              label={t('scheduler.intervalLabel')}
              required
              hint={t('scheduler.intervalHint', {
                human: formatUptime(Number(intervalDraft) || 0),
                min: editing.min_interval,
                max: editing.max_interval,
              })}
            >
              <Input
                type="number"
                min={editing.min_interval}
                max={editing.max_interval}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="form-row">
              {INTERVAL_PRESETS.map((preset) => (
                <Button
                  key={preset.seconds}
                  size="sm"
                  variant="ghost"
                  onClick={() => setIntervalDraft(String(preset.seconds))}
                >
                  {t(preset.key)}
                </Button>
              ))}
            </div>
            <div className="fs-xs text-muted">
              {t('scheduler.stateLine', {
                state: editing.enabled ? t('scheduler.status.enabled') : t('scheduler.status.disabled'),
                runs: editing.runs,
                failures: editing.failures
                  ? t('scheduler.stateFailures', { n: editing.failures })
                  : '',
                def: formatUptime(editing.default_interval),
              })}
            </div>
          </>
        ) : null}
      </Modal>
    </PageShell>
  );
}
