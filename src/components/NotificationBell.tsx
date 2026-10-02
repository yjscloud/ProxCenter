/* ==========================================================================
   ProxCenter — 顶部铃铛（站内通知中心）
   ==========================================================================

   为什么要有站内消息：告警此前只活在「监控告警」页面里。不发生告警的那一刻
   没人会主动去翻；而飞书 / 邮件 / Webhook 一旦没配或发失败，这条告警就彻底
   没人知道了。站内消息把「有没有新事件」变成面板自己就能回答的问题。

   为什么是轮询而不是 WebSocket：现有的 /ws/tasks 是广播任务状态、不区分用户；
   要做站内消息推送得再造一条按用户路由的通道（连接 → 用户映射、多实例扇出）。
   对「30 秒量级、只取一个数字」的需求来说，轮询命中索引的代价远低于那套复杂度。
   若以后真要做实时推送，改动点只有这里 —— 换成 WS 后把轮询关掉即可。

   这里是顶栏**唯一**的「消息中心」入口：无论以后加任务进度、告警数还是审批
   提醒，都应汇总成这一颗铃铛上的角标（必要时在面板里分组），而不是在顶栏
   再平铺一个徽章。顶栏的状态类信息已经收敛进 ConsoleStatus，两边一起守住
   「顶栏最多一个状态点 + 一个角标」这条线。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '../api/endpoints';
import { Button } from './ui/Button';
import { IconBell, IconCheck } from './Icons';
import { formatRelative } from '../utils/format';
import { useT } from '../i18n';
import type { AppNotification } from '../api/types';

/** 未读数轮询间隔。告警本身有冷却（默认 600s），30 秒足够及时。 */
const POLL_MS = 30_000;

export function NotificationBell() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: notificationsApi.unread,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
  });

  /* 面板打开时才拉列表：没人看的时候不必把 20 条消息搬来搬去 */
  const listQuery = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list({ limit: 20 }),
    enabled: open,
    staleTime: 5_000,
  });

  const markRead = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) =>
      notificationsApi.markRead(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  /* 点击外部 / Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = unreadQuery.data?.unread ?? 0;
  const items = listQuery.data?.items ?? [];

  const openItem = (item: AppNotification) => {
    // 点开即已读：用户已经看到这条了，再让他去点「全部已读」是多余的
    if (!item.read) markRead.mutate({ ids: [item.id] });
    setOpen(false);
    if (item.link) navigate(item.link);
  };

  return (
    <div className="notif-menu" ref={rootRef}>
      <button
        type="button"
        className="notif-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          unread > 0
            ? t('notif.ariaUnread', { count: unread })
            : t('notif.ariaNone')
        }
        title={t('notif.title')}
      >
        <IconBell size={17} />
        {unread > 0 ? (
          <span className="notif-badge" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notif-dropdown" role="menu">
          <div className="notif-header">
            <span className="notif-title">
              {t('notif.title')}
              {unread > 0 ? (
                <span className="notif-count">
                  {t('notif.unreadCount', { count: unread })}
                </span>
              ) : null}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconCheck size={13} />}
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              {t('notif.markAll')}
            </Button>
          </div>

          <div className="notif-list">
            {listQuery.isLoading ? (
              <div className="notif-empty">{t('notif.loading')}</div>
            ) : items.length === 0 ? (
              <div className="notif-empty">{t('notif.empty')}</div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`notif-item${item.read ? '' : ' is-unread'}`}
                  onClick={() => openItem(item)}
                >
                  <span
                    className={`notif-dot notif-dot-${item.level}`}
                    aria-hidden="true"
                  />
                  <span className="notif-item-main">
                    <span className="notif-item-title">{item.title}</span>
                    {item.body ? (
                      // 只展示正文首行：面板里是一行摘要，完整内容在告警历史里
                      <span className="notif-item-text">
                        {item.body.split('\n')[0]}
                      </span>
                    ) : null}
                    <span className="notif-item-time">
                      {formatRelative(item.created)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="notif-footer">
            <button
              type="button"
              className="notif-more"
              onClick={() => {
                setOpen(false);
                navigate('/alerts');
              }}
            >
              {t('notif.viewAll')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
