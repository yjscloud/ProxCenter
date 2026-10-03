/* ==========================================================================
   ProxCenter — 面板 SSH 公钥
   ==========================================================================

   面板下发虚拟机时，把这把公钥写进 cloud-init 的 `sshkeys`，机器起来后面板就
   能自己 SSH 进去做安全采集（SSH 安全 / 安全基线 / 端口与进程 / 登录审计）。

   私钥加密落库、**永不回传**，所以这里只能看到公钥。轮换是**破坏性**操作：
   旧公钥立即失效，已经用它接入的机器会连不上，必须重新下发或手工替换。因为
   破坏性，这里用两段式确认，并把受影响的主机数直接摆在按钮上 —— 让用户在点
   之前就看见代价，而不是点完才发现一堆主机掉线。

   密钥是**惰性生成**的：从没用过「接入安全管控」的部署，这里会显示「尚未生成」
   而不是平白多出一把钥匙。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { sshPanelKeyApi } from '../api/endpoints';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { Textarea } from './ui/Input';
import { IconCopy, IconKey, IconRefresh } from './Icons';

export function PanelKeyCard() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { hasPermission, isAdmin } = useAuth();
  const canManage = hasPermission('ssh.manage');

  /* 两段式确认：点一次进入「待确认」，再点一次才真的轮换 */
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: ['ssh', 'panel-key'],
    queryFn: sshPanelKeyApi.state,
    enabled: isAdmin,
    retry: false,
  });
  const key = query.data;

  /* 密钥变了（轮换成功）就把「待确认」收起来，免得手快再点一次 */
  useEffect(() => {
    setArmed(false);
  }, [key?.created]);

  if (!isAdmin) return null;

  const copy = async () => {
    if (!key?.public) return;
    try {
      await navigator.clipboard.writeText(key.public);
      toast.success(t('panelKey.copied'), t('panelKey.copiedHint'));
    } catch {
      toast.error(t('common.copyFailed'), t('common.clipboardDenied'));
    }
  };

  const rotate = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      const res = await sshPanelKeyApi.rotate();
      toast.success(t('panelKey.rotated'), t('panelKey.rotatedHint', { n: res.affected }));
      await qc.invalidateQueries();
    } catch {
      toast.error(t('panelKey.rotateFailed'), t('panelKey.rotateFailedHint'));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    /* 默认收起：接入是自动的，正常使用根本不需要看这把钥匙 —— 展开才占版面。
       但也不能没有：① 想把「不是面板下发」的存量机器纳入管控，得把这把公钥
       贴进它的 authorized_keys；② 私钥万一外泄，轮换是唯一的补救手段。 */
    <Card defaultOpen={false}>
      <CardHeader
        title={t('panelKey.title')}
        subtitle={t('panelKey.subtitle')}
        icon={<IconKey size={16} />}
        actions={
          key?.present ? (
            <Badge variant="neutral" size="sm">
              {t('panelKey.inUse', { n: key.in_use })}
            </Badge>
          ) : null
        }
      />

      {!key?.present ? (
        <p className="fs-sm text-secondary">{t('panelKey.absent')}</p>
      ) : (
        <>
          <p className="fs-sm text-secondary">{t('panelKey.body')}</p>

          {/* 只读文本框：公钥很长，这样能整行选中、也不会把卡片撑破 */}
          <Textarea mono rows={3} value={key.public} readOnly />

          <div className="form-row">
            <Button
              size="sm"
              variant="secondary"
              icon={<IconCopy size={13} />}
              onClick={() => void copy()}
            >
              {t('panelKey.copy')}
            </Button>
            {canManage ? (
              <Button
                size="sm"
                variant={armed ? 'danger' : 'ghost'}
                icon={<IconRefresh size={13} />}
                loading={busy}
                onClick={() => void rotate()}
              >
                {armed
                  ? t('panelKey.rotateConfirm', { n: key.in_use })
                  : t('panelKey.rotate')}
              </Button>
            ) : null}
          </div>

          {armed ? (
            <p className="fs-xs text-muted">{t('panelKey.rotateWarn', { n: key.in_use })}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
