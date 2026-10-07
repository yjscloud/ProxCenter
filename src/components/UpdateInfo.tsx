/* ==========================================================================
   ProxCenter — 更新信息的三块内容（版本对照 / 更新说明 / 手工命令）

   设置页的「面板版本与更新」卡片和顶栏那个弹窗要展示的是同一批东西。以前两边
   各写一遍，卡片里还额外套了一层「详情」组件，于是同一块内容在页面上重复渲染了
   两套（版本对照、为什么不能更新、更新说明、手工命令都出现两次）。

   现在拆成这三块 + 一个可折叠容器，两边各按自己的密度组合；长内容（Release 正文
   通常很长）默认收起，点开才看。
   ========================================================================== */

import { useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Notice } from './ui/EmptyState';
import { IconChevronDown, IconCopy } from './Icons';
import { useToast } from '../hooks/useToast';

/** 这三块只依赖这几个字段（传完整的 UpdateStatus 也兼容） */
export interface UpdateInfo {
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
  /** 未提交改动涉及的文件名；列在「为什么不能一键更新」下面，给用户一个下一步 */
  dirty_paths?: string[];
}

/* -------------------------------------------------------------- 版本对照 */
export function UpdateVersionGrid({ status }: { status: UpdateInfo }) {
  const t = useT();
  return (
    <div className="set-info-grid">
      <div className="set-info-tile">
        <span className="set-info-label">{t('update.current')}</span>
        <span className="set-info-value mono">{status.current}</span>
      </div>
      <div className="set-info-tile">
        <span className="set-info-label">{t('update.latest')}</span>
        <span className="set-info-value mono">{status.latest || t('update.unknown')}</span>
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
  );
}

/* ------------------------------------------------- 能不能一键更新（只一条） */
export function UpdateNoticeLine({ status }: { status: UpdateInfo }) {
  const t = useT();
  if (status.error) {
    return (
      <Notice tone="warning" title={t('update.checkFailed')}>
        {status.error}
      </Notice>
    );
  }
  if (status.can_apply) {
    return <Notice tone="info">{t('update.applyHint')}</Notice>;
  }
  return (
    <Notice tone="warning" title={t('update.reasonTitle')}>
      {status.reason}
      {/* 把「有 N 处改动」落成具体文件名：用户扫一眼就知道是不是自己改的。
          实测最常见的一处就是 package-lock.json —— 部署脚本跑 npm install 时
          被重写的，看一眼就能放心点「继续更新」。 */}
      {status.dirty_paths?.length ? (
        <div className="mt-8">
          <div className="fs-xs text-muted">{t('update.dirtyFiles')}</div>
          <div className="mono fs-xs" style={{ whiteSpace: 'pre-wrap' }}>
            {status.dirty_paths.join('\n')}
          </div>
        </div>
      ) : null}
    </Notice>
  );
}

/* ---------------------------------------------------------------- 可折叠 */
export function Collapsible({
  label,
  defaultOpen = false,
  children,
}: {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-16">
      <div className="flex items-center gap-8">
        <span className="set-info-label">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          iconRight={
            <span className={`bulk-caret ${open ? 'is-open' : ''}`}>
              <IconChevronDown size={13} />
            </span>
          }
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('update.collapse') : t('update.expand')}
        </Button>
      </div>
      {open ? <div className="mt-8">{children}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- 更新说明 */
export function UpdateNotes({
  status,
  defaultOpen = false,
}: {
  status: UpdateInfo;
  defaultOpen?: boolean;
}) {
  const t = useT();
  const notes = (status.notes || '').trim();
  if (!notes) return null;
  return (
    <Collapsible label={t('update.notes')} defaultOpen={defaultOpen}>
      <div className="fs-sm" style={{ whiteSpace: 'pre-wrap' }}>
        {notes}
      </div>
      {status.release_url ? (
        <a className="link fs-sm" href={status.release_url} target="_blank" rel="noreferrer">
          {t('update.release')}
        </a>
      ) : null}
    </Collapsible>
  );
}

/* ---------------------------------------------------------- 手工升级命令 */
export function UpdateManualCommands({
  status,
  defaultOpen = false,
}: {
  status: UpdateInfo;
  defaultOpen?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const lines = status.manual ?? [];
  if (!lines.length) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.warning(t('update.copyFailed'));
    }
  };

  return (
    <Collapsible label={t('update.manualTitle')} defaultOpen={defaultOpen}>
      <pre className="mono fs-xs" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {lines.join('\n')}
      </pre>
      <div className="flex items-center gap-8 mt-8">
        <Button size="sm" variant="secondary" icon={<IconCopy size={14} />} onClick={() => void copy()}>
          {copied ? t('update.copied') : t('update.copy')}
        </Button>
      </div>
    </Collapsible>
  );
}
