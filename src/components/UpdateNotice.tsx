/* ==========================================================================
   ProxCenter — 「面板有新版本」的全局提示

   挂在 Layout 里（顶栏正下方），且**只在有「设置管理」权限的账号**上出现：
   更新面板等于换掉面板自己运行的代码，普通用户那边多一条看不懂的提示没有意义。

   三种状态：
   1. 有新版本（且没被「以后再说」掉）→ 一条可关闭的提示条 + 弹窗详情；
   2. 更新进行中 → 提示条换成进度说明，每 5 秒问一次状态；
   3. 面板重启回来、版本号变了 → 自动刷新页面（不然用户看到的还是旧前端）。

   弹窗里既有一键更新，也有该部署形态下的**手工命令** —— 容器、非 systemd 托管、
   没装 Node 这些情况下后端会明确拒绝一键更新，并给出为什么。
   ========================================================================== */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useApplyUpdate, useSaveUpdateSettings, useUpdateStatus } from '../hooks/useUpdate';
import { useT } from '../i18n';
import { Notice } from './ui/EmptyState';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { IconCopy, IconDownload } from './Icons';

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
  const toast = useToast();
  const allowed = hasPermission('settings.manage');

  const query = useUpdateStatus(allowed);
  const apply = useApplyUpdate();
  const save = useSaveUpdateSettings();

  const [dismissed, setDismissed] = useState<string>(readDismissed);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const data = query.data;
  const applyingTag = data?.applying?.tag ?? '';
  const latest = data?.latest ?? '';

  /* 更新进行中的轮询与「重启后自动刷新」都在 useUpdateStatus 里（两个组件共用一份，
     否则提示条与设置页同时挂载时会各起一个定时器、各刷一次页面） */

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

  const copyManual = async () => {
    try {
      await navigator.clipboard.writeText((data.manual ?? []).join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.warning(t('update.copyFailed'));
    }
  };

  /* 更新进行中：不弹窗也让人知道发生了什么（面板随时会重启） */
  if (applyingTag && !open) {
    return (
      <Notice tone="warning" title={t('update.applyingTitle')}>
        {t('update.applyingBody', { tag: applyingTag })}{' '}
        <span className="mono fs-xs">{data.applying?.log ?? ''}</span>
      </Notice>
    );
  }

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
            ) : null}
          </>
        }
      >
        <UpdateDetails status={data} copied={copied} onCopy={copyManual} />
      </Modal>
    );
  }

  return (
    <>
      <Notice
        tone="info"
        title={t('update.bannerTitle')}
        action={
          <div className="row gap-8">
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
            ) : null}
          </>
        }
      >
        <UpdateDetails status={data} copied={copied} onCopy={copyManual} />
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------------------
   详情正文：版本对照 + 更新说明 + 能不能一键更新（不能则给命令）
   --------------------------------------------------------------------------- */

function UpdateDetails({
  status,
  copied,
  onCopy,
}: {
  status: {
    current: string;
    latest: string;
    published_at: string;
    checked_at: number;
    notes: string;
    release_url: string;
    error: string;
    can_apply: boolean;
    reason: string;
    manual: string[];
  };
  copied: boolean;
  onCopy: () => void;
}) {
  const t = useT();
  const notes = (status.notes || '').trim();
  return (
    <>
      <div className="set-info-grid">
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.current')}</span>
          <span className="set-info-value mono">{status.current}</span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.latest')}</span>
          <span className="set-info-value mono">{status.latest || '—'}</span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.published')}</span>
          <span className="set-info-value fs-sm">
            {status.published_at
              ? new Date(status.published_at).toLocaleString()
              : t('update.unknown')}
          </span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.checked')}</span>
          <span className="set-info-value fs-sm">
            {status.checked_at
              ? new Date(status.checked_at * 1000).toLocaleString()
              : t('update.never')}
          </span>
        </div>
      </div>

      {status.error ? (
        <Notice tone="warning" title={t('update.checkFailed')}>
          {status.error}
        </Notice>
      ) : null}

      {notes ? (
        <div className="mt-16">
          <div className="set-info-label">{t('update.notes')}</div>
          <div className="fs-sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notes}
          </div>
        </div>
      ) : null}

      {status.can_apply ? (
        <Notice tone="info">{t('update.applyHint')}</Notice>
      ) : (
        <Notice tone="warning" title={t('update.reasonTitle')}>
          {status.reason}
        </Notice>
      )}

      <div className="mt-16">
        <div className="set-info-label">{t('update.manualTitle')}</div>
        <pre className="mono fs-xs" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {(status.manual ?? []).join('\n')}
        </pre>
        <div className="row gap-8 mt-8">
          <Button size="sm" variant="secondary" icon={<IconCopy size={14} />} onClick={onCopy}>
            {copied ? t('update.copied') : t('update.copy')}
          </Button>
          {status.release_url ? (
            <a
              className="link fs-sm"
              href={status.release_url}
              target="_blank"
              rel="noreferrer"
            >
              {t('update.release')}
            </a>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* 设置页里那一段（版本对照 / 更新说明 / 手工命令）复用同一个正文组件 */
export { UpdateDetails };
