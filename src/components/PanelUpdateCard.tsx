/* ==========================================================================
   ProxCenter — 设置页里的「面板版本与更新」

   与顶栏那条提示（UpdateNotice）共用同一份状态（同一个 query key）与同一批内容块
   （UpdateInfo），所以在这里检查完，提示条会立刻同步，反之亦然。

   版式：版本对照 → 操作按钮 → 开关与仓库 → 结论（能不能一键更新）→ 更新说明与
   手工命令。后两块是**可折叠**的：Release 正文动辄上千字，摊在设置页里会把整页
   撑成一屏说明书。
   ========================================================================== */

import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
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
import {
  UpdateManualCommands,
  UpdateNotes,
  UpdateNoticeLine,
  UpdateVersionGrid,
} from './UpdateInfo';

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
  const allowed = hasPermission('settings.manage');

  const query = useUpdateStatus(allowed);
  const check = useCheckUpdate();
  const apply = useApplyUpdate();
  const save = useSaveUpdateSettings();

  /* 仓库输入框：留空时显示服务端的值，改过才提交（保存成功后回到服务端的值） */
  const [repo, setRepo] = useState('');

  if (!allowed) return null;
  const data = query.data;
  if (!data) {
    return <div className="fs-sm text-muted mt-16">{t('update.loading')}</div>;
  }

  const skipped = data.skipped && data.skipped === data.latest;
  const last = data.last_update ?? {};

  return (
    <div className="mt-16">
      <UpdateVersionGrid status={data} />

      <div className="fs-xs text-muted mt-8">
        {t('update.deployForm')}：
        {t(FORM_KEY[data.deployment?.form ?? 'other'] ?? 'update.form.other')}
        {data.deployment?.service ? (
          <span className="mono"> · {data.deployment.service}</span>
        ) : null}
      </div>

      {/* 操作行：flex + gap 才撑得开（之前误用了并不存在的 .row，按钮是贴在一起的） */}
      <div className="flex flex-wrap items-center gap-8 mt-16">
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
        ) : data.can_apply_dirty ? (
          /* 只差工作区干净：更新脚本会先 stash 本地改动（可恢复），所以允许继续 */
          <Button
            variant="secondary"
            icon={<IconDownload size={14} />}
            loading={apply.isPending}
            onClick={() => apply.mutate({ tag: data.tag, allow_dirty: true })}
          >
            {t('update.applyDirty', { n: data.dirty_files ?? 0 })}
          </Button>
        ) : null}
        {data.update_available && data.latest ? (
          <Button
            variant="secondary"
            loading={save.isPending}
            onClick={() => save.mutate({ skipped_version: skipped ? '' : data.latest })}
          >
            {skipped ? t('update.unskip', { version: data.latest }) : t('update.skip')}
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-8 mt-16">
        <Switch
          checked={data.auto_check}
          onChange={(next) => save.mutate({ auto_check: next })}
          disabled={save.isPending}
          label={t('update.autoCheck')}
          hint={t('update.autoCheckHint')}
        />
      </div>

      <Field label={t('update.repo')} hint={t('update.repoHint')}>
        <div className="flex items-center gap-8">
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
            onClick={() => save.mutate({ repo }, { onSuccess: () => setRepo('') })}
          >
            {t('update.save')}
          </Button>
        </div>
      </Field>

      {/* 结论只出现一次：能一键更新 / 为什么不能 / 上次检查失败 */}
      <UpdateNoticeLine status={data} />

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

      <UpdateNotes status={data} />
      {/* 不能一键更新时命令才是「下一步」，直接展开；能更新时收起来 */}
      <UpdateManualCommands status={data} defaultOpen={!data.can_apply} />
    </div>
  );
}
