/* ==========================================================================
   ProxCenter — 设置页里的「面板版本与更新」

   与顶栏那条提示（UpdateNotice）共用同一份状态（同一个 query key），所以在这
   检查完，提示条会立刻同步，反之亦然。这块给出：

   * 当前 / 最新版本、上次检查时间、上次更新的结果；
   * 「检查更新」「立即更新」「跳过这个版本」；
   * 自动检查开关、发布仓库（换仓库后端要二次确认）；
   * 不能一键更新时**说明为什么**，并给出该部署形态下的手工命令 —— 这是这个功能
     最容易让人困惑的地方：同样是「面板」，容器里的那份就是换不了自己的镜像。
   ========================================================================== */

import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import {
  useApplyUpdate,
  useCheckUpdate,
  useSaveUpdateSettings,
  useUpdateStatus,
} from '../hooks/useUpdate';
import { useT, type MessageKey } from '../i18n';
import { Button } from './ui/Button';
import { Field, Input, Switch } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { IconDownload, IconRefresh } from './Icons';
import { UpdateDetails } from './UpdateNotice';

/** 部署形态 → 文案键。写成映射而不是拼键名：拼出来的字符串不在 MessageKey 里，
 *  tsc 拦不住，改错一个字母只会在界面上显示出键名本身。 */
const FORM_KEY: Record<string, MessageKey> = {
  git: 'update.form.git',
  docker: 'update.form.docker',
  other: 'update.form.other',
};

export function PanelUpdateCard() {
  const t = useT();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const allowed = hasPermission('settings.manage');

  const query = useUpdateStatus(allowed);
  const check = useCheckUpdate();
  const apply = useApplyUpdate();
  const save = useSaveUpdateSettings();

  /* 仓库输入框：留空时显示服务端的值，改过才提交（保存成功后回到服务端的值） */
  const [repo, setRepo] = useState('');
  const [copied, setCopied] = useState(false);

  if (!allowed) return null;
  const data = query.data;
  if (!data) {
    return <div className="fs-sm text-muted mt-16">{t('update.loading')}</div>;
  }

  const skipped = data.skipped && data.skipped === data.latest;
  const last = data.last_update ?? {};

  const copyManual = async () => {
    try {
      await navigator.clipboard.writeText((data.manual ?? []).join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.warning(t('update.copyFailed'));
    }
  };

  return (
    <div className="mt-16">
      <div className="set-info-grid">
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.current')}</span>
          <span className="set-info-value mono">{data.current}</span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.latest')}</span>
          <span className="set-info-value mono">{data.latest || t('update.unknown')}</span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.checked')}</span>
          <span className="set-info-value fs-sm">
            {data.checked_at
              ? new Date(data.checked_at * 1000).toLocaleString()
              : t('update.never')}
          </span>
        </div>
        <div className="set-info-tile">
          <span className="set-info-label">{t('update.deployForm')}</span>
          <span className="set-info-value fs-sm">
            {t(FORM_KEY[data.deployment?.form ?? 'other'] ?? 'update.form.other')}
            {data.deployment?.service ? (
              <span className="mono fs-xs text-muted"> · {data.deployment.service}</span>
            ) : null}
          </span>
        </div>
      </div>

      {data.error ? (
        <Notice tone="warning" title={t('update.checkFailed')}>
          {data.error}
        </Notice>
      ) : null}

      {data.applying?.tag ? (
        <Notice tone="warning" title={t('update.applyingTitle')}>
          {t('update.applyingBody', { tag: data.applying.tag })}{' '}
          <span className="mono fs-xs">{data.applying.log ?? ''}</span>
        </Notice>
      ) : null}

      {last.tag && !data.applying?.tag ? (
        <Notice
          tone={last.ok ? 'success' : 'warning'}
          title={last.ok ? t('update.doneOkTitle') : t('update.doneFailTitle')}
        >
          {last.ok
            ? t('update.doneOk', { tag: last.tag })
            : t('update.doneFail', { tag: last.tag })}{' '}
          {last.log ? <span className="mono fs-xs">{last.log}</span> : null}
        </Notice>
      ) : null}

      <div className="row gap-8 mt-16">
        <Button
          icon={<IconRefresh size={14} />}
          loading={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? t('update.checking') : t('update.check')}
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
        {data.update_available && data.latest ? (
          <Button
            variant="secondary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({ skipped_version: skipped ? '' : data.latest })
            }
          >
            {skipped
              ? t('update.unskip', { version: data.latest })
              : t('update.skip')}
          </Button>
        ) : null}
      </div>

      <div className="row gap-8 mt-16">
        <Switch
          checked={data.auto_check}
          onChange={(next) => save.mutate({ auto_check: next })}
          disabled={save.isPending}
          label={t('update.autoCheck')}
          hint={t('update.autoCheckHint')}
        />
      </div>

      <Field label={t('update.repo')} hint={t('update.repoHint')}>
        <div className="row gap-8">
          <Input
            value={repo || data.repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            className="mono"
          />
          <Button
            size="sm"
            variant="secondary"
            loading={save.isPending}
            disabled={!repo || repo === data.repo}
            onClick={() =>
              save.mutate({ repo }, { onSuccess: () => setRepo('') })
            }
          >
            {t('update.save')}
          </Button>
        </div>
      </Field>

      {!data.can_apply ? (
        <Notice tone="info" title={t('update.reasonTitle')}>
          {data.reason}
        </Notice>
      ) : null}

      <UpdateDetails status={data} copied={copied} onCopy={copyManual} />
    </div>
  );
}
