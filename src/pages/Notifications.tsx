/* ==========================================================================
   ProxCenter — 消息中心（完整列表页）

   站内消息的正式落点：顶栏铃铛弹出的是同一份列表，这个页面提供一个可收藏、
   可分享的地址，也给「一次看很多条」留了更大空间。列表与展开逻辑都在
   NotificationPanel 里，两边不会有第二种行为。
   ========================================================================== */

import { PageShell } from '../components/Layout';
import { Card } from '../components/ui/Card';
import { NotificationPanel } from '../components/NotificationPanel';
import { useT } from '../i18n';

/** 一次拉多少条。消息在服务端保留 90 天，这里不做分页。 */
const PAGE_LIMIT = 200;

export function Notifications() {
  const t = useT();

  return (
    <PageShell title={t('notif.title')} subtitle={t('notif.pageDesc')}>
      <Card>
        <NotificationPanel limit={PAGE_LIMIT} />
      </Card>
    </PageShell>
  );
}
