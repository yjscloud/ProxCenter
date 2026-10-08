/* ==========================================================================
   ProxCenter — 站内消息列表（顶栏弹窗与消息中心页面共用）

   为什么抽成一个组件：同一份东西要出现在两个地方 —— 顶栏铃铛点开的弹窗，以及
   /notifications 页面。各写一份的结局必然是「弹窗里能展开、页面里点不动」。

   为什么默认折叠：一条下发通知有七八行（配置、IP、账号、口令），几十条一起铺开
   根本翻不到底。折叠时那行摘要是「认出是哪一条」，点开才给全文 —— 正文保留换行，
   因为那本来就是一行一条配置。
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { notificationsApi } from '../api/endpoints';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Notice } from './ui/EmptyState';
import { SegmentedControl } from './ui/Input';
import { IconCheck, IconTrash } from './Icons';
import { formatDateTime, formatRelative } from '../utils/format';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import type { AppNotification, NotificationListResult } from '../api/types';

export interface NotificationPanelProps {
  /** 一次拉多少条 */
  limit?: number;
  /** 点「查看相关资源」之后的收尾：弹窗要先关掉自己，页面不用管 */
  onNavigate?: () => void;
}

export function NotificationPanel({ limit = 200, onNavigate }: NotificationPanelProps) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const listQuery = useQuery({
    queryKey: ['notifications', 'panel', filter, limit],
    queryFn: () => notificationsApi.list({ limit, unread_only: filter === 'unread' }),
    staleTime: 10_000,
  });

  /**
   * 标记已读。
   *
   * 这里刻意**不**整表重取（``invalidateQueries``）：当前若在「未读」筛选下，
   * 重取走的是 ``unread_only=true``，刚被标成已读的这一条会被过滤掉 ——
   * 用户点开它要看正文的那一刻，行连同正文一起消失，列表还变成「暂无未读」。
   * 也就是「点击未读无法读取内容」。
   *
   * 改成就地更新缓存：这一条转成已读样式留在原地（正文继续可读），未读数同步
   * 更新；等用户切走再回来（换筛选 = 换 query key，重新取一次）时，它自然不在
   * 「未读」里了 —— 这正是预期：读完了它就不该再占着未读列表。
   */
  const markRead = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) => notificationsApi.markRead(body),
    onSuccess: (res, body) => {
      const ids = body.ids ?? [];
      qc.setQueryData<NotificationListResult>(
        ['notifications', 'panel', filter, limit],
        (old) => {
          if (!old) return old;
          if (body.all) {
            // 「全部标为已读」是用户主动点的动作：未读视图清空才符合预期，
            // 与「点开某一条」要留在原地不是一回事
            return filter === 'unread'
              ? { ...old, items: [], unread: res.unread }
              : {
                  ...old,
                  items: old.items.map((item) => ({ ...item, read: true })),
                  unread: res.unread,
                };
          }
          return {
            ...old,
            items: old.items.map((item) =>
              ids.includes(item.id) ? { ...item, read: true } : item,
            ),
            unread: res.unread,
          };
        },
      );
      // 顶栏铃铛的角标是另一个 query key，单独同步一次
      qc.setQueryData(['notifications', 'unread'], { unread: res.unread });
    },
  });

  /* 清空是不可撤销的：走 ConfirmDialog 而不是「点一下就没」 */
  const clearAll = useMutation({
    mutationFn: notificationsApi.clear,
    onSuccess: (res) => {
      setConfirmClear(false);
      setOpenId(null);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(
        t('notif.cleared'),
        t('notif.clearedBody', { count: res.removed }),
      );
    },
    onError: (err) => {
      setConfirmClear(false);
      toast.error(t('notif.clearFailed'), errorMessage(err));
    },
  });

  const items = listQuery.data?.items ?? [];
  const unread = listQuery.data?.unread ?? 0;

  /** 展开一条，顺带标记已读 —— 内容已经摆在眼前了，不该还留着未读催他。 */
  const toggle = (item: AppNotification) => {
    if (!item.read) markRead.mutate({ ids: [item.id] });
    setOpenId((prev) => (prev === item.id ? null : item.id));
  };

  return (
    <>
      <div className="notif-toolbar">
        <SegmentedControl<'all' | 'unread'>
          value={filter}
          onChange={(value) => {
            setFilter(value);
            /* 换筛选条件时收起展开项：换完列表里可能已经没有它了，
               留着展开状态只会让人以为「刚才那条消失了」 */
            setOpenId(null);
          }}
          options={[
            { label: t('notif.filterAll'), value: 'all' },
            {
              /* 未读数挂在「未读」这一段上：读/未读的界线在筛选条这一层
                 就能看出来，不必先点进去数一遍 */
              label: (
                <>
                  {t('notif.filterUnread')}
                  {unread > 0 ? (
                    <span className="notif-seg-count">{unread}</span>
                  ) : null}
                </>
              ),
              value: 'unread',
            },
          ]}
        />
        <span className="row-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconCheck size={14} />}
            disabled={unread === 0 || markRead.isPending || clearAll.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            {t('notif.markAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconTrash size={14} />}
            disabled={clearAll.isPending}
            onClick={() => setConfirmClear(true)}
          >
            {t('notif.clearAll')}
          </Button>
        </span>
      </div>

      {listQuery.isError ? (
        <Notice tone="danger" title={t('notif.loadFailed')}>
          {errorMessage(listQuery.error)}
        </Notice>
      ) : items.length === 0 ? (
        <div className="notif-empty">
          {listQuery.isLoading
            ? t('notif.loading')
            : filter === 'unread'
              ? t('notif.emptyUnread')
              : t('notif.empty')}
        </div>
      ) : (
        <div className="notif-feed">
          {items.map((item) => (
            <div
              key={item.id}
              className={`notif-feed-item${item.read ? '' : ' is-unread'}`}
            >
              <button
                type="button"
                className="notif-feed-head"
                aria-expanded={openId === item.id}
                onClick={() => toggle(item)}
              >
                <span
                  className={`notif-dot notif-dot-${item.level}`}
                  aria-hidden="true"
                />
                <span className="notif-feed-title">{item.title}</span>
                {/* 读/未读在视觉上是「竖条 + 字重 + 底色」三条线索，
                    读屏则只拿得到这一句 —— 否则未读与否完全听不出来 */}
                {item.read ? null : (
                  <span className="sr-only">{t('notif.unreadLabel')}</span>
                )}
                <span className="notif-item-time" title={formatDateTime(item.created)}>
                  {formatRelative(item.created)}
                </span>
              </button>

              {openId === item.id ? (
                <>
                  {/* 保留换行：下发通知是一行一条配置，挤成一行就读不出来了 */}
                  <div className="notif-feed-body">
                    {item.body || t('notif.noBody')}
                  </div>
                  <div className="notif-feed-actions">
                    {item.link ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onNavigate?.();
                          navigate(item.link);
                        }}
                      >
                        {t('notif.openTarget')}
                      </Button>
                    ) : null}
                    <span className="fs-xs text-muted">
                      {formatDateTime(item.created)}
                    </span>
                  </div>
                </>
              ) : item.body ? (
                <div className="notif-feed-preview">{item.body.split('\n')[0]}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        danger
        title={t('notif.clearTitle')}
        message={t('notif.clearMessage')}
        confirmText={t('notif.clearConfirm')}
        loading={clearAll.isPending}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => clearAll.mutate()}
      />
    </>
  );
}
