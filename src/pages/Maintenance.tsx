/* ==========================================================================
   ProxCenter — 维护公告页

   维护模式开启后，普通用户（含未登录访客）打开任何页面都会落到这里：
   与其让几十个页面各自弹一句「无法加载」，不如只讲一件事 —— 现在在维护、
   大概什么时候恢复。

   管理员不会看到它：后端对他们不返回 503。这里的「管理员登录」入口是给
   「从普通入口点进来、想自己确认一下」的管理员用的。
   ========================================================================== */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMaintenance } from '../hooks/useMaintenance';
import { AuthShell } from '../components/AuthShell';
import { Button } from '../components/ui/Button';
import { IconRefresh, IconWrench } from '../components/Icons';
import { useT } from '../i18n';

export function Maintenance({ message }: { message?: string }) {
  const t = useT();
  const navigate = useNavigate();

  /* 每 20 秒问一次「还在维护吗」：维护结束就整页重载，不用用户自己盯着刷新。
     用公开接口，普通用户在维护期间也读得到。 */
  const state = useMaintenance(true, 20_000);

  useEffect(() => {
    document.title = t('maintenance.title');
  }, [t]);

  /* 只有「看着它从开变成关」才整页重载。
     不能见到 enabled=false 就 reload：管理员在设置页点「预览」（维护还没开、
     或已经关掉）打开的就是这个页面，那样会 reload → 又是 false → 再 reload，
     页面变成一直闪。 */
  const sawEnabled = useRef(false);

  useEffect(() => {
    if (!state.data) return;
    if (state.data.enabled) {
      sawEnabled.current = true;
      return;
    }
    if (sawEnabled.current) window.location.reload();
  }, [state.data]);

  /* 拦截器带来的文案优先（那就是后端刚刚拒绝时说的话）；直接访问 /maintenance
     时用接口返回的公告，再没有才用内置文案。 */
  const notice = message || state.data?.message || '';

  return (
    <AuthShell>
      <h1 className="login-title">{t('maintenance.title')}</h1>
      <p className="login-subtitle">{t('maintenance.subtitle')}</p>

      <div className="login-form">
        <div className="login-notice">
          <IconWrench size={16} />
          {/* 管理员写了公告就照登，没写则用内置文案（前端按当前语言渲染） */}
          <span>{notice || t('maintenance.defaultMessage')}</span>
        </div>

        <Button
          variant="primary"
          block
          icon={<IconRefresh size={14} />}
          onClick={() => window.location.reload()}
        >
          {t('maintenance.retry')}
        </Button>
        <Button variant="secondary" block onClick={() => navigate('/login')}>
          {t('maintenance.adminLogin')}
        </Button>

        <div className="login-register-hint">{t('maintenance.adminHint')}</div>
      </div>
    </AuthShell>
  );
}
