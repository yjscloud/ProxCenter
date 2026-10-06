/* ==========================================================================
   ProxCenter — 顶部铃铛（消息中心入口）
   ==========================================================================

   为什么要有站内消息：告警此前只活在「监控告警」页面里。不发生告警的那一刻
   没人会主动去翻；而飞书 / 邮件 / Webhook 一旦没配或发失败，这条告警就彻底
   没人知道了。站内消息把「有没有新事件」变成面板自己就能回答的问题。

   为什么是轮询而不是 WebSocket：现有的 /ws/tasks 是广播任务状态、不区分用户；
   要做站内消息推送得再造一条按用户路由的通道（连接 → 用户映射、多实例扇出）。
   对「30 秒量级、只取一个数字」的需求来说，轮询命中索引的代价远低于那套复杂度。
   若以后真要做实时推送，改动点只有这里 —— 换成 WS 后把轮询关掉即可。

   这里是顶栏**唯一**的「消息中心」入口：无论以后加任务进度、告警数还是审批
   提醒，都应汇总成这一颗铃铛上的角标，而不是在顶栏再平铺一个徽章。顶栏的状态
   类信息已经收敛进 ConsoleStatus，两边一起守住「顶栏最多一个状态点 + 一个角标」。

   点击铃铛**弹出一个页面级窗口**，而不是在铃铛下面挂一个小面板：消息的正文动辄
   七八行（下发的配置、IP、账号、口令），几百像素宽的下拉里只能看到一行摘要，
   点开一条还得在窄栏里读 —— 那才是「消息中心」最该做好的事。列表与展开逻辑见
   NotificationPanel，/notifications 页面用的是同一份。
   ========================================================================== */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { notificationsApi } from '../api/endpoints';
import { Modal } from './ui/Modal';
import { NotificationPanel } from './NotificationPanel';
import { IconBell } from './Icons';
import { useT } from '../i18n';

/** 未读数轮询间隔。告警本身有冷却（默认 600s），30 秒足够及时。 */
const POLL_MS = 30_000;

/** 弹窗里一次拉多少条 */
const PANEL_LIMIT = 100;

export function NotificationBell() {
  const t = useT();
  const [open, setOpen] = useState(false);

  /* 只看未读数：那是常驻轮询，没打开窗口也不该把整份消息搬来搬去 */
  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: notificationsApi.unread,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
  });

  const unread = unreadQuery.data?.unread ?? 0;

  return (
    <div className="notif-menu">
      <button
        type="button"
        className="notif-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('notif.title')}
        description={t('notif.pageDesc')}
        size="xl"
      >
        <NotificationPanel limit={PANEL_LIMIT} onNavigate={() => setOpen(false)} />
      </Modal>
    </div>
  );
}
