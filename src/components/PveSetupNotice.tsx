/* ==========================================================================
   ProxCenter — 「面板还没接入 Proxmox」的全局引导条

   挂在 Layout 顶栏下方，与「有新版本」的提示并排。

   它要解决的是这个体验问题：全新部署时，VMs / 节点 / 存储 / 备份 / 任务……
   十几个页面全都会因为未配置而报错，用户看到满屏红色只会得出一个结论 ——
   平台坏了。所以：

   1. 只在这一处提示，并且用中性色（info）而不是危险色：这不是故障，
      是「还没设置好」；
   2. 直接给出出口（管理员给「添加节点」按钮），而不是让用户自己找；
   3. 普通用户不引导操作（他们没权限），只说明情况，避免给出点不动的按钮；
   4. 连接管理页自己就是添加连接的地方，在那儿不再重复提醒。
   ========================================================================== */

import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { usePveStatus } from '../hooks/usePveStatus';
import { useT } from '../i18n';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';
import { IconPlug } from './Icons';

/* 「添加节点」跳转的目标：连接管理页，并让它自动摊开新增表单 */
const SETUP_PATH = '/nodes/connections';

export function PveSetupNotice() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin } = useAuth();
  const { configured, loading } = usePveStatus();

  if (configured || loading || location.pathname.startsWith(SETUP_PATH)) {
    return null;
  }

  if (!isAdmin) {
    return (
      <Notice tone="info" title={t('setup.pveUserTitle')}>
        {t('setup.pveUserDesc')}
      </Notice>
    );
  }

  return (
    <Notice
      tone="info"
      icon={<IconPlug size={16} />}
      title={t('setup.pveTitle')}
      action={
        <Button size="sm" onClick={() => navigate(`${SETUP_PATH}?new=1`)}>
          {t('setup.pveAction')}
        </Button>
      }
    >
      {t('setup.pveDesc')}
    </Notice>
  );
}
