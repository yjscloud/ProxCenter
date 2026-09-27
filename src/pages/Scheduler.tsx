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

/* 自刷周期：比调度器的 tick（1 秒）慢得多，但足够让「下次执行」看起来是活的 */
const REFRESH = 5_000;

/* 间隔编辑里的一键预设。覆盖「巡检类」与「清理类」两个量级。 */
const INTERVAL_PRESETS = [
  { label: '1 分钟', seconds: 60 },
  { label: '5 分钟', seconds: 300 },
  { label: '15 分钟', seconds: 900 },
  { label: '1 小时', seconds: 3_600 },
  { label: '6 小时', seconds: 21_600 },
  { label: '1 天', seconds: 86_400 },
];

function statusMeta(job: SchedulerJob): { label: string; variant: BadgeVariant } {
  if (!job.enabled) return { label: '已停用', variant: 'neutral' };
  if (job.running) return { label: '执行中', variant: 'info' };
  switch (job.last_status) {
    case 'ok':
      return { label: '正常', variant: 'success' };
    case 'error':
      return { label: '失败', variant: 'danger' };
    default:
      return { label: '待执行', variant: 'neutral' };
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
          `「${job.name}」执行完成`,
          result.last_summary
            ? `${result.last_summary}（${result.last_duration_ms} ms）`
            : `耗时 ${result.last_duration_ms} ms`,
        );
      } else {
        // 失败也要把原因直接说出来：这个按钮的用途就是看错误
        toast.error(`「${job.name}」执行失败`, result.last_error || '未知错误');
      }
      await query.refetch();
    } catch (err) {
      toast.error('无法执行', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (job: SchedulerJob) => {
    setBusyId(job.id);
    try {
      await schedulerApi.configure(job.id, { enabled: !job.enabled });
      await query.refetch();
      toast.success(job.enabled ? `已停用「${job.name}」` : `已启用「${job.name}」`);
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const saveConfig = async () => {
    if (!editing) return;
    const interval = Number(intervalDraft);
    if (!Number.isFinite(interval) || interval <= 0) {
      toast.error('间隔不合法', '请输入一个大于 0 的秒数');
      return;
    }
    setSaving(true);
    try {
      await schedulerApi.configure(editing.id, { interval });
      await query.refetch();
      setEditing(null);
      toast.success(`「${editing.name}」间隔已更新`, `下次执行按新间隔计算`);
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
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
      toast.success(`已恢复「${job.name}」的默认设置`);
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const columns: Array<Column<SchedulerJob>> = [
    {
      key: 'job',
      header: '作业',
      render: (job) => (
        <div>
          <div className="flex items-center gap-6">
            <span className="fw-600">{job.name}</span>
            {job.modified ? (
              <Badge variant="warning" size="sm">
                已调整
              </Badge>
            ) : null}
            {job.last_manual ? (
              <Badge variant="info" size="sm">
                手动
              </Badge>
            ) : null}
          </div>
          <div className="fs-xs text-muted">{job.description}</div>
        </div>
      ),
    },
    {
      key: 'interval',
      header: '间隔',
      width: 120,
      render: (job) => (
        <div>
          <div className="fs-sm">{formatUptime(job.interval)}</div>
          {job.modified ? (
            <div className="fs-xs text-muted">
              默认 {formatUptime(job.default_interval)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 150,
      render: (job) => {
        const meta = statusMeta(job);
        const stale = isStale(job);
        return (
          <div>
            <Badge variant={meta.variant} size="sm" dot pulse={job.running}>
              {meta.label}
            </Badge>
            {stale ? (
              <div className="fs-xs text-warning">疑似停摆，已很久没执行</div>
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
      header: '上次执行',
      width: 170,
      render: (job) => (
        <div>
          <div className="fs-sm">{formatRelative(job.last_start)}</div>
          <div className="fs-xs text-muted">
            {job.last_duration_ms
              ? `耗时 ${job.last_duration_ms} ms`
              : job.last_end
                ? '—'
                : '尚未执行'}
          </div>
        </div>
      ),
    },
    {
      key: 'next',
      header: '下次执行',
      width: 140,
      render: (job) =>
        !job.enabled ? (
          <span className="text-muted fs-sm">已停用</span>
        ) : job.running ? (
          <span className="text-muted fs-sm">执行中</span>
        ) : (
          <div>
            <div className="fs-sm">
              {job.next_in < 1 ? '即将执行' : `${Math.round(job.next_in)} 秒后`}
            </div>
            <div className="fs-xs text-muted">{formatDateTime(job.next_at)}</div>
          </div>
        ),
    },
    {
      key: 'counters',
      header: '累计',
      width: 130,
      render: (job) => (
        <div className="fs-xs">
          <div className="text-muted">执行 {job.runs} 次</div>
          {job.failures ? (
            <div className="text-danger">失败 {job.failures} 次</div>
          ) : null}
          {job.skipped ? (
            <div className="text-warning" title="上一次还没跑完就到了下次时间，说明间隔短于实际耗时">
              跳过 {job.skipped} 次
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
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
            立即执行
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconSettings size={14} />}
            onClick={() => setEditing(job)}
          >
            配置
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={job.enabled ? <IconPause size={14} /> : <IconCheck size={14} />}
            onClick={() => void toggle(job)}
          >
            {job.enabled ? '停用' : '启用'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="后台任务"
      subtitle="面板的后台巡检与清理作业：查看运行状态、调整执行间隔、立即执行一次"
      actions={
        <Button
          variant="ghost"
          icon={<IconRefresh size={15} />}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新
        </Button>
      }
    >
      {query.isError ? (
        <ErrorState
          title="后台任务加载失败"
          message={errorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {/* ---- KPI ---- */}
      <div className="grid grid-4">
        <KpiCard
          label="作业总数"
          value={query.data?.total ?? 0}
          icon={<IconTasks size={16} />}
          tone="accent"
          loading={query.isLoading}
          hint={`已启用 ${query.data?.enabled ?? 0} 个`}
        />
        <KpiCard
          label="正在执行"
          value={query.data?.running ?? 0}
          icon={<IconActivity size={16} />}
          tone="accent"
          loading={query.isLoading}
          hint="调度器每秒检查一次是否到点"
        />
        <KpiCard
          label="最近失败"
          value={failing.length}
          icon={<IconAlert size={16} />}
          tone={failing.length ? 'danger' : 'success'}
          loading={query.isLoading}
          hint={failing.length ? '点「立即执行」可直接看到错误' : '全部作业最近一次都成功'}
        />
        <KpiCard
          label="疑似停摆"
          value={stale.length}
          icon={<IconClock size={16} />}
          tone={stale.length ? 'warning' : 'success'}
          loading={query.isLoading}
          hint="距上次执行已远超自身间隔"
        />
      </div>

      {/* ---- 失败明细：放在最上面，这是最该被处理的信息 ---- */}
      {failing.length > 0 ? (
        <Card collapsible={false}>
          <CardHeader
            title="最近失败的作业"
            subtitle="错误已记在作业状态里，修好后点「立即执行」可直接验证"
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
                  {job.last_error || '未记录错误信息'}
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
            subtitle={`${group.jobs.length} 个作业`}
            icon={<IconTasks size={16} />}
          />
          <Table
            columns={columns}
            rows={group.jobs}
            rowKey={(job) => job.id}
            caption={`${group.name}后台作业`}
            loading={query.isLoading}
            emptyTitle="没有作业"
            emptyDescription="该分组下暂无已注册的后台作业。"
          />
        </Card>
      ))}

      <Notice tone="info" title="关于间隔调整">
        间隔保存在服务端（每项只存与代码默认值的差异），改完下一个周期即生效，
        不需要重启面板。调度器内部用单调时钟计算下次唤醒，系统时间被 NTP 校正
        也不会让作业停摆。恢复默认可用配置弹框里的「恢复默认」。
      </Notice>

      {/* ---- 配置弹框 ---- */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `配置：${editing.name}` : '配置作业'}
        description={editing?.description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant="ghost"
              onClick={() => editing && void resetJob(editing)}
              disabled={editing ? !editing.modified : true}
              title={
                editing?.modified
                  ? '恢复代码里的默认间隔与启用状态'
                  : '当前就是默认值'
              }
            >
              恢复默认
            </Button>
            <Button variant="primary" onClick={() => void saveConfig()} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        {editing ? (
          <>
            <Field
              label="执行间隔（秒）"
              required
              hint={`约等于 ${formatUptime(Number(intervalDraft) || 0)}；允许范围 ${editing.min_interval} ~ ${editing.max_interval} 秒，超出会被自动收拢到边界`}
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
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="fs-xs text-muted">
              当前状态：{editing.enabled ? '已启用' : '已停用'} · 累计执行{' '}
              {editing.runs} 次
              {editing.failures ? `（失败 ${editing.failures} 次）` : ''} · 代码默认{' '}
              {formatUptime(editing.default_interval)}
            </div>
          </>
        ) : null}
      </Modal>
    </PageShell>
  );
}
