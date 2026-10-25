/* ==========================================================================
   ProxCenter — 维护模式提示条（仅管理员可见）

   维护期间普通用户被挡在公告页，管理员则一切照常。没有这条提示，最容易发生
   的就是「开完忘了关」—— 管理员自己用得毫无异样，直到用户反馈「登不进来」。

   数据用公开接口取（与登录页 / 维护页同一个 query key），所以打开开关后
   这里会跟着刷新，不需要额外的推送通道。
   ========================================================================== */

import { useNavigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { useMaintenance } from '../hooks/useMaintenance';
import { useT } from '../i18n';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';

export function MaintenanceNotice() {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const query = useMaintenance(isAdmin);

  if (!isAdmin || !query.data?.enabled) return null;

  return (
    <Notice tone="warning" title={t('layout.maintenanceBanner')}>
      <span>{t('settings.maintenanceHint')}</span>{' '}
      <Button variant="ghost" size="sm" onClick={() => navigate('/settings')}>
        {t('layout.maintenanceAction')}
      </Button>
    </Notice>
  );
}
