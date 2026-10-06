/* ==========================================================================
   ProxCenter — 「面板有新版本」的全局提示

   挂在 Layout 里（顶栏正下方），且**只在有「设置管理」权限的账号**上出现：
   更新面板等于换掉面板自己运行的代码，普通用户那边多一条看不懂的提示没有意义。

   三种状态：
   1. 有新版本（且没被「以后再说」掉）→ 一条可关闭的提示条 + 弹窗详情；
   2. 更新进行中 → 提示条换成进度说明，每 5 秒问一次状态；
   3. 面板重启回来、版本号变了 → 自动刷新页面（不然用户看到的还是旧前端）。

   弹窗正文与设置页那张卡片复用同一批内容块（见 UpdateInfo），两边不会各说各话。
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useApplyUpdate, useSaveUpdateSettings, useUpdateStatus } from '../hooks/useUpdate';
import { useT } from '../i18n';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { IconDownload } from './Icons';
import {
  UpdateManualCommands,
  UpdateNotes,
  UpdateNoticeLine,
  UpdateVersionGrid,
} from './UpdateInfo';

/** 「以后再说」记到本地：只跳过**这一个**版本，下个版本照旧提醒。 */
const DISMISS_KEY = 'pve_update_dismissed';

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function UpdateNotice() {
  const t = useT();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const allowed = hasPermission('settings.manage');

  const query = useUpdateStatus(allowed);
  const apply = useApplyUpdate();
  const save = useSaveUpdateSettings();

  const [dismissed, setDismissed] = useState<string>(readDismissed);
  const [open, setOpen] = useState(false);

  const data = query.data;
  const applyingTag = data?.applying?.tag ?? '';
  const latest = data?.latest ?? '';

  if (!allowed || !data) return null;

  const dismiss = () => {
    setDismissed(latest);
    setOpen(false);
    try {
      localStorage.setItem(DISMISS_KEY, latest);
    } catch {
      /* 忽略：隐私模式下写不进去，刷新后还会再提示一次而已 */
    }
  };

  /* 更新进行中：不弹窗也让人知道发生了什么（面板随时会重启）。
     顶栏的位置放得下的只有一句，所以这里只带百分比与阶段，进度条在设置页那张卡片上。 */
  if (applyingTag && !open) {
    const progress = data.applying?.progress;
    return (
      <Notice tone="warning" title={t('update.applyingTitle')}>
        {t('update.applyingBody', { tag: applyingTag })}{' '}
        {progress ? (
          <strong>
            {progress.label} · {progress.percent}%
          </strong>
        ) : null}
      </Notice>
    );
  }

  /* 弹窗正文：三块内容 + 可折叠的长文本（弹窗里默认展开说明，命令默认收起） */
  const body = (
    <>
      <UpdateVersionGrid status={data} />
      <UpdateNoticeLine status={data} />
      <UpdateNotes status={data} defaultOpen />
      <UpdateManualCommands status={data} />
    </>
  );

  if (!data.update_available || dismissed === latest || !latest) {
    return (
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('update.modalTitle')}
        description={t('update.modalSubtitle', { current: data.current, latest: latest || '—' })}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('update.close')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/settings')}>
              {t('update.gotoSettings')}
            </Button>
            {data.update_available && latest ? (
              <Button
                variant="secondary"
                onClick={() => save.mutate({ skipped_version: latest })}
                loading={save.isPending}
              >
                {t('update.skip')}
              </Button>
            ) : null}
            {data.can_apply ? (
              <Button
                icon={<IconDownload size={14} />}
                loading={apply.isPending}
                onClick={() => apply.mutate({ tag: data.tag })}
              >
                {t('update.apply')}
              </Button>
            ) : data.can_apply_dirty ? (
              /* 只差工作区干净：更新脚本会先把本地改动 stash 起来（可恢复），所以允许继续 */
              <Button
                variant="secondary"
                icon={<IconDownload size={14} />}
                loading={apply.isPending}
                onClick={() => apply.mutate({ tag: data.tag, allow_dirty: true })}
              >
                {t('update.applyDirty', { n: data.dirty_files ?? 0 })}
              </Button>
            ) : null}
          </>
        }
      >
        {body}
      </Modal>
    );
  }

  return (
    <>
      <Notice
        tone="info"
        title={t('update.bannerTitle')}
        action={
          <div className="flex items-center gap-8">
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t('update.later')}
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('update.view')}
            </Button>
          </div>
        }
      >
        {t('update.bannerBody', { current: data.current, latest })}
      </Notice>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('update.modalTitle')}
        description={t('update.modalSubtitle', { current: data.current, latest })}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('update.close')}
            </Button>
            <Button variant="secondary" onClick={dismiss}>
              {t('update.later')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => save.mutate({ skipped_version: latest })}
              loading={save.isPending}
            >
              {t('update.skip')}
            </Button>
            {data.can_apply ? (
              <Button
                icon={<IconDownload size={14} />}
                loading={apply.isPending}
                onClick={() => apply.mutate({ tag: data.tag })}
              >
                {t('update.apply')}
              </Button>
            ) : data.can_apply_dirty ? (
              /* 只差工作区干净：更新脚本会先把本地改动 stash 起来（可恢复），所以允许继续 */
              <Button
                variant="secondary"
                icon={<IconDownload size={14} />}
                loading={apply.isPending}
                onClick={() => apply.mutate({ tag: data.tag, allow_dirty: true })}
              >
                {t('update.applyDirty', { n: data.dirty_files ?? 0 })}
              </Button>
            ) : null}
          </>
        }
      >
        {body}
      </Modal>
    </>
  );
}
