/* ==========================================================================
   pvecenter — 批量下发进度（方案 A）
   ==========================================================================

   后端批量接口是「同步受理 + 逐台 PVE 任务」：返回时每台只有一个 UPID，
   真正的开机关机 / 克隆 / 建盘还在 PVE 任务队列里跑。这里按每台的 task 并行
   轮询 `tasksApi.detail`，把「已受理」推进到「成功 / 失败」，用户不用自己
   去任务页一台台找。

   组件不负责建机，也不重试失败项 —— 失败原因原样展示，重新提交由用户决定
   （避免在结果页里自动重跑一部分，反而制造新的重复机器）。
   ========================================================================== */
import { useEffect, useMemo, useState } from 'react';
import type {
  BatchCreateItemResult,
  BatchCreateResponse,
  TaskInfo,
} from '../api/types';
import { waitForTask } from '../hooks/useTaskRunner';
import { useT } from '../i18n';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { ProgressBar } from './ui/ProgressBar';

type Phase = 'running' | 'done' | 'failed';

interface Row extends BatchCreateItemResult {
  phase: Phase;
  note?: string;
}

export interface BatchCreateProgressProps {
  response: BatchCreateResponse;
  /** 用户点「完成」：父组件负责关闭向导 / 刷新列表 */
  onClose: () => void;
}

export function BatchCreateProgress({ response, onClose }: BatchCreateProgressProps) {
  const t = useT();
  const [rows, setRows] = useState<Row[]>(() =>
    response.results.map((item) => ({
      ...item,
      phase: item.ok && item.task ? 'running' : 'failed',
      note: item.ok ? undefined : item.error || t('bulk.unknownReason'),
    })),
  );

  useEffect(() => {
    let cancelled = false;
    const patch = (vmid: number, next: Partial<Row>) => {
      if (cancelled) return;
      setRows((prev) =>
        prev.map((row) => (row.vmid === vmid ? { ...row, ...next } : row)),
      );
    };

    const pending = response.results.filter((item) => item.ok && item.task);
    for (const item of pending) {
      void (async () => {
        try {
          const task: TaskInfo = await waitForTask(
            String(item.task),
            item.node,
            { interval: 2_000, timeout: 600_000 },
          );
          const ok =
            task.status === 'stopped' &&
            (!task.exitstatus || task.exitstatus === 'OK');
          patch(item.vmid, {
            phase: ok ? 'done' : 'failed',
            note: ok
              ? undefined
              : `${task.status}${task.exitstatus ? `: ${task.exitstatus}` : ''}`,
          });
        } catch (err) {
          patch(item.vmid, {
            phase: 'failed',
            note: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [response]);

  const done = rows.filter((row) => row.phase === 'done').length;
  const failed = rows.filter((row) => row.phase === 'failed').length;
  const finished = rows.filter((row) => row.phase !== 'running').length;
  const pct = rows.length ? (finished / rows.length) * 100 : 100;
  const allDone = finished === rows.length;

  const tone = useMemo(() => {
    if (!allDone) return 'info' as const;
    if (failed === 0) return 'success' as const;
    return failed === rows.length ? ('danger' as const) : ('warning' as const);
  }, [allDone, failed, rows.length]);

  return (
    <div className="wizard-body">
      <Notice
        tone={tone}
        title={t('batchCreate.summary', {
          done,
          total: rows.length,
          failed,
        })}
        action={
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('batchCreate.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-8">
          <ProgressBar value={pct} label={t('batchCreate.progress')} showValue />
          <div className="fs-sm text-secondary">{t('batchCreate.pendingHint')}</div>
        </div>
      </Notice>

      <div className="bulk-detail-scroll">
        <table className="bulk-detail-table">
          <caption className="sr-only">{t('batchCreate.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('bulk.colTarget')}</th>
              <th scope="col">{t('bulk.colName')}</th>
              <th scope="col">{t('bulk.colResult')}</th>
              <th scope="col">{t('bulk.colNote')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.node}-${row.vmid}-${row.index}`}>
                <td className="mono fs-sm">
                  {row.node}/{row.vmid || '—'}
                </td>
                <td className="fs-sm">
                  <span className="truncate bulk-detail-name">
                    {row.name || '—'}
                  </span>
                </td>
                <td>
                  <Badge
                    variant={
                      row.phase === 'done'
                        ? 'success'
                        : row.phase === 'failed'
                          ? 'danger'
                          : 'info'
                    }
                    size="sm"
                    dot
                  >
                    {t(
                      row.phase === 'done'
                        ? 'batchCreate.doneOne'
                        : row.phase === 'failed'
                          ? 'batchCreate.failedOne'
                          : 'batchCreate.runningOne',
                    )}
                  </Badge>
                </td>
                <td className="fs-xs text-muted bulk-detail-error">
                  {row.note || row.disk_note || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
