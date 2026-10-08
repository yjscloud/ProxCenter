/* ==========================================================================
   ProxCenter — 统一处置弹窗（预览 → 确认 → 执行）

   点「处置」时先拉一次 dry-run 预览（后端只读、不落地），把「将要做什么、
   能不能回滚、有什么影响」摊开给用户；确认后才调用 apply。

   二次确认不在这里写：apply 命中 step-up 时，axios 拦截器会弹出密码框并自动
   重放原请求 —— 与平台上其它危险操作走的是同一条路。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { remediationApi } from '../api/endpoints';
import type { RemediationPreview } from '../api/types';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';

export interface RemediationDialogProps {
  action: string;
  params: Record<string, unknown>;
  onClose: () => void;
  /** 执行成功后回调（例如刷新体检报告） */
  onDone?: () => void;
}

export function RemediationDialog({
  action,
  params,
  onClose,
  onDone,
}: RemediationDialogProps) {
  const t = useT();
  const toast = useToast();
  const [preview, setPreview] = useState<RemediationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    remediationApi
      .preview(action, params)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [action, params]);

  const irreversible = preview?.risk === 'irreversible';

  const run = async () => {
    if (applying || !preview) return;
    setApplying(true);
    setError('');
    try {
      await remediationApi.apply(action, params);
      toast.success(
        t('ai.remediation.doneTitle'),
        t('ai.remediation.doneDetail', { label: preview.label }),
      );
      onDone?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      open
      onClose={applying ? () => undefined : onClose}
      title={t('ai.remediation.title')}
      description={preview?.label}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void run()}
            loading={applying}
            disabled={!preview || loading}
          >
            {t('ai.remediation.confirm')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="fs-sm text-muted">{t('ai.remediation.previewing')}</div>
      ) : null}

      {error ? (
        <div className="login-error" role="alert">
          {error}
        </div>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-12">
          <div className="flex items-center gap-8 flex-wrap">
            <Badge variant={irreversible ? 'danger' : 'warning'} size="sm">
              {irreversible
                ? t('ai.remediation.risk.irreversible')
                : t('ai.remediation.risk.reversible')}
            </Badge>
            <span className="fs-sm">{preview.summary}</span>
          </div>

          {preview.steps.length > 0 ? (
            <div>
              <div className="fs-xs text-muted">{t('ai.remediation.steps')}</div>
              <ul className="desc-list" style={{ paddingLeft: 18, marginTop: 4 }}>
                {preview.steps.map((step, index) => (
                  <li key={index} className="desc-item fs-sm">
                    {step}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.note ? (
            <div className="fs-xs text-muted" style={{ lineHeight: 1.7 }}>
              {preview.note}
            </div>
          ) : null}

          {irreversible ? (
            <div
              className="fs-sm"
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-muted)',
                lineHeight: 1.7,
              }}
            >
              {t('ai.remediation.irreversibleHint')}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
