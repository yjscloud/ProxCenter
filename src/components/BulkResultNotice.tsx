/* ==========================================================================
   ProxCenter — 批量操作结果回报
   ==========================================================================

   批量操作的成败是**逐台**的：20 台里第 3 台在跑、删不掉，前 2 台已经没了。
   整批抛一个 500 会让用户不知道到底动了几台，所以后端返回逐台清单，这里照着渲染。

   形状与防火墙模板下发（``FirewallApplyResult``）刻意保持一致 —— 两处都是
:「一行一台机器 + 成功/失败原因」，用户不必学两套看结果的办法。

   为什么还要「可展开的明细」：
     * 一整批 200 台时，把清单直接铺在通知里会把页面顶下去，真正要读的
       「哪台失败了、为什么」反而被淹掉；
     * 默认只在有失败时自动展开，成功批次收起成一行 —— 成功不需要被逐条确认；
     * 展开后可切「只看失败」并一键复制失败清单，直接粘进工单/群里。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { SegmentedControl } from './ui/Input';
import { IconChevronDown, IconCopy } from './Icons';
import { useToast } from '../hooks/useToast';
import type { BulkAction, BulkItemResult, BulkResponse } from '../api/types';

const ACTION_LABELS: Record<string, string> = {
  start: '开机',
  stop: '停止',
  shutdown: '关机',
  reboot: '重启',
  suspend: '挂起',
  resume: '恢复',
  delete: '删除',
  tag: '打标签',
  migrate: '迁移',
  snapshot: '创建快照',
};

export function bulkActionLabel(action: BulkAction | string): string {
  return ACTION_LABELS[action] ?? action;
}

export interface BulkResultNoticeProps {
  result: BulkResponse;
  onClose: () => void;
  /** 只重跑失败的那几台（成功后选择已清空，重试得靠结果清单还原目标） */
  onRetryFailed?: () => void;
  /** 重试进行中 */
  retrying?: boolean;
}

type ResultFilter = 'all' | 'ok' | 'fail';

export function BulkResultNotice({
  result,
  onClose,
  onRetryFailed,
  retrying = false,
}: BulkResultNoticeProps) {
  const toast = useToast();
  const label = bulkActionLabel(result.action);
  const tone = result.failed === 0 ? 'success' : result.ok === 0 ? 'danger' : 'warning';

  const hasFailure = result.failed > 0;
  /* 有失败就默认摊开 —— 用户此刻唯一想知道的就是「哪几台出问题了」；
     全成功则收起，别为了一条「都成功了」占掉半屏。 */
  const [open, setOpen] = useState(hasFailure);
  const [filter, setFilter] = useState<ResultFilter>(hasFailure ? 'fail' : 'all');

  /* 重试会产出新的 result：重新按「是否有失败」决定展开与筛选 */
  useEffect(() => {
    setOpen(result.failed > 0);
    setFilter(result.failed > 0 ? 'fail' : 'all');
  }, [result]);

  const rows = useMemo<BulkItemResult[]>(() => {
    if (filter === 'ok') return result.results.filter((item) => item.ok);
    if (filter === 'fail') return result.results.filter((item) => !item.ok);
    return result.results;
  }, [result.results, filter]);

  const copyFailed = async () => {
    const lines = result.results
      .filter((item) => !item.ok)
      .map(
        (item) =>
          `${item.node}/${item.vmid}\t${item.name || ''}\t${item.error || '未知原因'}`,
      );
    if (lines.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        `${label}失败清单（${lines.length} 台）\n${lines.join('\n')}`,
      );
      toast.success('已复制失败清单', `${lines.length} 台失败记录已复制到剪贴板`);
    } catch {
      toast.error('复制失败', '浏览器不允许访问剪贴板');
    }
  };

  return (
    <Notice
      tone={tone}
      title={`批量${label}完成：成功 ${result.ok} 台，失败 ${result.failed} 台`}
      action={
        <div className="flex items-center gap-8">
          <Button
            size="sm"
            variant="secondary"
            iconRight={
              <span className={`bulk-caret ${open ? 'is-open' : ''}`}>
                <IconChevronDown size={13} />
              </span>
            }
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起明细' : `查看明细 ${result.total}`}
          </Button>
          {result.failed > 0 && onRetryFailed ? (
            <Button size="sm" variant="secondary" loading={retrying} onClick={onRetryFailed}>
              仅重试失败的 {result.failed} 台
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      {open ? (
        <div className="bulk-detail">
          <div className="bulk-detail-bar">
            <SegmentedControl<ResultFilter>
              value={filter}
              onChange={setFilter}
              ariaLabel="批量结果筛选"
              options={[
                { label: `全部 ${result.total}`, value: 'all' },
                { label: `成功 ${result.ok}`, value: 'ok' },
                { label: `失败 ${result.failed}`, value: 'fail' },
              ]}
            />
            {hasFailure ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconCopy size={13} />}
                onClick={() => void copyFailed()}
              >
                复制失败清单
              </Button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="bulk-detail-empty">这个筛选下没有记录。</div>
          ) : (
            /* 台数多时（上限 200）不能把页面撑爆，列表自己滚 */
            <div className="bulk-detail-scroll">
              <table className="bulk-detail-table">
                <caption className="sr-only">批量{label}的逐台结果</caption>
                <thead>
                  <tr>
                    <th scope="col">对象</th>
                    <th scope="col">名称</th>
                    <th scope="col">结果</th>
                    <th scope="col">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr
                      key={`${item.node}-${item.vmid}`}
                      className={item.ok ? '' : 'is-failed'}
                    >
                      <td className="mono fs-sm">
                        {item.node}/{item.vmid}
                      </td>
                      <td className="fs-sm">
                        <span className="truncate bulk-detail-name">
                          {item.name || '—'}
                        </span>
                      </td>
                      <td>
                        <Badge
                          variant={item.ok ? 'success' : 'danger'}
                          size="sm"
                          dot
                        >
                          {item.ok ? `已${label}` : '失败'}
                        </Badge>
                      </td>
                      <td className="fs-xs text-muted bulk-detail-error">
                        {item.ok ? '—' : item.error || '未知原因'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <span className="fs-sm text-secondary">
          成功 {result.ok} 台
          {hasFailure ? `，失败 ${result.failed} 台` : ''}。点「查看明细」逐台核对。
        </span>
      )}
    </Notice>
  );
}
