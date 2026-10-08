/* ==========================================================================
   ProxCenter — AI 写命令的内联审批卡

   与「弹一个模态框」的做法不同：这张卡**内嵌在对话流里**。
   「授权」本身就是对话中的一个动作 —— 用户在右边看着 AI 的请求就地拍板，
   不必被一个模态框打断，也不用在日志与弹窗之间来回跳。

   倒计时仍然必要：后端等待有上限（APPROVAL_TIMEOUT），超时即按拒绝处理 ——
   界面上先把这件事说清楚，比让用户点了按钮才发现「请求已失效」好得多。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import { aiApi } from '../api/endpoints';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { useT } from '../i18n';

/** 一条待用户拍板的写命令（与 SSE 的 approval 事件同构） */
export interface ApprovalRequest {
  approval_id: string;
  command: string;
  purpose: string;
  timeout: number;
}

export function ApprovalCard({
  request,
  onDone,
}: {
  request: ApprovalRequest;
  /** 决策完成后回调（是否批准），调用方据此把卡片从对话流里摘掉 */
  onDone: (approved: boolean) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(Math.max(0, Math.floor(request.timeout)));
  /* 一旦做出决定（含超时）就不再重复提交 —— 倒计时与手动点击必须只生效一次 */
  const settled = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          if (!settled.current) {
            settled.current = true;
            onDone(false);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onDone]);

  const decide = async (approved: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setBusy(true);
    setError('');
    try {
      await aiApi.approve(request.approval_id, approved);
      onDone(approved);
    } catch (err) {
      // 提交失败就把决定「撤销」，让用户能重试（否则卡片卡死在已决定状态）
      settled.current = false;
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={t('ai.approval.title')}
      style={{
        border: '1px solid var(--warning)',
        background: 'var(--warning-dim)',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div className="flex items-center gap-8 flex-wrap">
        <Badge variant="warning" size="sm">
          {t('ai.approval.badge')}
        </Badge>
        <span className="fs-xs text-muted">
          {t('ai.approval.countdown', { s: left })}
        </span>
      </div>

      {error ? (
        <div className="login-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}

      <div className="fs-xs text-muted" style={{ marginTop: 8 }}>
        {t('ai.approval.purpose')}
      </div>
      <div className="fs-sm" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        {request.purpose}
      </div>

      <div className="fs-xs text-muted">{t('ai.approval.command')}</div>
      <div
        className="mono fs-xs"
        style={{
          marginTop: 4,
          padding: '8px 10px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-muted)',
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          lineHeight: 1.6,
          maxHeight: 160,
          overflow: 'auto',
        }}
      >
        {request.command}
      </div>

      <div className="flex items-center gap-8" style={{ marginTop: 10 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void decide(false)}
          disabled={busy}
        >
          {t('ai.approval.reject')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void decide(true)}
          loading={busy}
        >
          {t('ai.approval.approve')}
        </Button>
      </div>
    </div>
  );
}
