/* ==========================================================================
   ProxCenter — 重装作业通知器

   重装现在是后台作业：用户提交完就关掉弹窗去干别的了。这个组件在应用层盯着作业
   列表，等作业结束时把结果送到眼前 —— 成功一条提示；失败一条提示，外加一个带
   完整步骤日志的弹窗（重装失败往往要看「哪一步失败、为什么」，一行 toast 不够用）。

   为什么挂在应用层而不是向导里：向导可能早就被关掉了。项目里没有全局事件总线
   （useToast 是纯 React 上下文），所以只能靠这样一个常驻组件轮询。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { vmReinstallApi } from '../api/endpoints';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Notice } from './ui/EmptyState';
import type { ReinstallJob } from '../api/types';

/** 轮询间隔：一次重装是分钟级，5 秒够及时，也不至于把作业列表接口敲烂 */
const POLL_MS = 5_000;

export function ReinstallWatcher() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [failure, setFailure] = useState<ReinstallJob | null>(null);
  /* 已经报过的作业：轮询每隔几秒回一次同样的列表，不能每回一次就弹一次 */
  const reported = useRef<Set<string>>(new Set());
  /* 本页面挂载的时刻。比它更早结束的作业一律不弹 —— 那多半是上一次会话的残留，
     刷新一下全弹出来只会让人以为「又失败了一遍」。 */
  const mountedAt = useRef(Date.now() / 1000);

  const jobsQuery = useQuery({
    queryKey: ['reinstall-jobs'],
    queryFn: vmReinstallApi.jobs,
    enabled: Boolean(user),
    refetchInterval: POLL_MS,
    /* 切到别的标签页时也别停：用户正是冲着「它在后台跑」才离开这个页面的 */
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    for (const job of jobsQuery.data?.jobs ?? []) {
      if (job.status === 'running' || reported.current.has(job.id)) continue;
      reported.current.add(job.id);
      if (job.finished && job.finished < mountedAt.current) continue;
      if (job.status === 'success') {
        toast.success(t('vmReinstall.done'), `${job.name} → ${job.new_volume}`);
      } else {
        toast.error(t('vmReinstall.failed'), job.detail);
        setFailure(job);
      }
      /* 机器刚被整个重建过：它自己的详情、列表里的状态、卷与 IP 都可能变了。
         与其猜哪些缓存键受影响，不如全量重取一次 —— 这是低频事件。 */
      void queryClient.invalidateQueries();
    }
  }, [jobsQuery.data, queryClient, t, toast]);

  return (
    <Modal
      open={Boolean(failure)}
      onClose={() => setFailure(null)}
      title={t('vmReinstall.failedTitle', { name: failure?.name ?? '' })}
      description={t('vmReinstall.failedDesc')}
      size="md"
      footer={
        <Button variant="secondary" onClick={() => setFailure(null)}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="dyn-list">
        {failure?.detail ? (
          <Notice tone="danger" title={t('vmReinstall.failed')}>
            {failure.detail}
          </Notice>
        ) : null}
        {failure && failure.steps.length > 0 ? (
          <div className="export-job">
            <div className="export-job-head">
              <div className="fw-600">{t('vmReinstall.steps')}</div>
            </div>
            <ul className="import-warnings">
              {failure.steps.map((step, index) => (
                <li key={`${step.step}-${index}`}>
                  {step.ok ? '✔' : '✘'} {step.step}
                  {step.detail ? `：${step.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {failure && failure.steps.length === 0 ? (
          <div className="fs-xs text-muted">{t('vmReinstall.failedNoSteps')}</div>
        ) : null}
      </div>
    </Modal>
  );
}
