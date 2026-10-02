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
import { useT, type MessageKey } from '../i18n';
import type { BulkAction, BulkItemResult, BulkResponse } from '../api/types';

/**
 * 动作 → 词条键。这里不能直接给文案：这个函数也会被非组件代码用到（toast 消息），
 * 带不了 hook —— 由调用方 t() 取当前语言。
 */
const ACTION_LABEL_KEYS: Record<string, MessageKey> = {
  start: 'bulk.start',
  stop: 'bulk.stop',
  shutdown: 'bulk.shutdown',
  reboot: 'bulk.reboot',
  suspend: 'bulk.suspend',
  resume: 'bulk.resume',
  delete: 'bulk.delete',
  tag: 'bulk.tag',
  migrate: 'bulk.migrate',
  snapshot: 'bulk.snapshot',
};

/** 动作对应的词条键；未知动作回退到「未知」，免得把 key 露在界面上 */
export function bulkActionKey(action: BulkAction | string): MessageKey {
  return ACTION_LABEL_KEYS[action] ?? 'common.unknown';
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
  const t = useT();
  const toast = useToast();
  const label = t(bulkActionKey(result.action));
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
          `${item.node}/${item.vmid}\t${item.name || ''}\t${
            item.error || t('bulk.unknownReason')
          }`,
      );
    if (lines.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        `${t('bulk.failedList', { label, count: lines.length })}\n${lines.join('\n')}`,
      );
      toast.success(
        t('bulk.copyList'),
        t('bulk.copiedHint', { count: lines.length }),
      );
    } catch {
      toast.error(t('common.copyFailed'), t('common.clipboardDenied'));
    }
  };

  return (
    <Notice
      tone={tone}
      title={t('bulk.summaryTitle', {
        label,
        ok: result.ok,
        failed: result.failed,
      })}
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
            {open ? t('bulk.collapse') : t('bulk.expand', { count: result.total })}
          </Button>
          {result.failed > 0 && onRetryFailed ? (
            <Button size="sm" variant="secondary" loading={retrying} onClick={onRetryFailed}>
              {t('bulk.retryFailed', { count: result.failed })}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
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
              ariaLabel={t('bulk.filterAria')}
              options={[
                { label: t('bulk.filterAll', { count: result.total }), value: 'all' },
                { label: t('bulk.filterOk', { count: result.ok }), value: 'ok' },
                { label: t('bulk.filterFail', { count: result.failed }), value: 'fail' },
              ]}
            />
            {hasFailure ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconCopy size={13} />}
                onClick={() => void copyFailed()}
              >
                {t('bulk.copyList')}
              </Button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="bulk-detail-empty">{t('bulk.emptyFilter')}</div>
          ) : (
            /* 台数多时（上限 200）不能把页面撑爆，列表自己滚 */
            <div className="bulk-detail-scroll">
              <table className="bulk-detail-table">
                <caption className="sr-only">{t('bulk.caption', { label })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('bulk.colTarget')}</th>
                    <th scope="col">{t('bulk.colName')}</th>
                    <th scope="col">{t('bulk.colResult')}</th>
                    <th scope="col">{t('bulk.colNote')}</th>
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
                          {item.ok ? t('bulk.doneOne', { label }) : t('bulk.failed')}
                        </Badge>
                      </td>
                      <td className="fs-xs text-muted bulk-detail-error">
                        {item.ok ? '—' : item.error || t('bulk.unknownReason')}
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
          {t('bulk.summaryOk', { count: result.ok })}
          {hasFailure ? t('bulk.summaryFailed', { count: result.failed }) : ''}
          {t('bulk.summaryTail')}
        </span>
      )}
    </Notice>
  );
}
