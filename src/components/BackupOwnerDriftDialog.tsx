/* ==========================================================================
   ProxCenter — 备份归属对账（只读）

   为什么需要单独的界面：`[owner:x]` 在「机器归属优先」之后已经降级成回落依据，
   但 PVE 的 notes 里那串字不会被改派流程碰 —— 存量归档里必然有一批与现状不一致。
   这些差异平时看不见，只在「前任还能下载别人机器的备份」这种时候才暴露出来。

   这里**只列不改**：存量 notes 是历史事实，自动改写会把唯一还能回答「这台机器
   以前归谁」的线索覆盖掉。要不要动，由人看着清单决定。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { backupsApi } from '../api/endpoints';
import type { BackupOwnerDrift, BackupOwnerDriftReport } from '../api/types';
import { useT, type MessageKey } from '../i18n';
import { Badge } from './ui/Badge';
import { Modal } from './ui/Modal';
import { ErrorState, Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';

/** 差异类型 → 徽标色调与词条（后端给的是机器可读的分类） */
const REASON_META: Record<
  BackupOwnerDrift['reason'],
  { tone: 'warning' | 'danger' | 'info'; key: MessageKey }
> = {
  reassigned: { tone: 'warning', key: 'backups.driftReassigned' },
  'machine-unowned': { tone: 'danger', key: 'backups.driftMachineGone' },
  unmarked: { tone: 'info', key: 'backups.driftUnmarked' },
};

export function BackupOwnerDriftDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const query = useQuery<BackupOwnerDriftReport>({
    queryKey: ['backups', 'owner-drift'],
    queryFn: () => backupsApi.ownerDrift(),
    /* 打开时才扫：这是全集群存储遍历，不能跟着页面轮询一起跑 */
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const data = query.data;
  const rows = data?.drift ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('backups.driftTitle')}
      description={t('backups.driftDesc')}
      size="lg"
    >
      {query.isLoading ? (
        <div className="flex items-center gap-8">
          <Spinner />
          <span className="fs-sm text-secondary">{t('backups.driftLoading')}</span>
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('backups.driftFailed')}
          message={errorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <Notice tone="success" title={t('backups.driftEmpty')}>
          {t('backups.driftSummary', { checked: data?.checked ?? 0, total: 0 })}
        </Notice>
      ) : (
        <>
          <Notice tone="warning" title={t('backups.driftSummaryTitle')}>
            {t('backups.driftSummary', {
              checked: data?.checked ?? 0,
              total: data?.total ?? rows.length,
            })}
            {data?.truncated ? ` ${t('backups.driftTruncated', { limit: rows.length })}` : ''}
          </Notice>
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>{t('backups.driftColReason')}</th>
                  <th>{t('backups.driftColArchive')}</th>
                  <th>{t('backups.driftColNode')}</th>
                  <th>{t('backups.driftColMarker')}</th>
                  <th>{t('backups.driftColOwner')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const meta = REASON_META[row.reason] ?? {
                    tone: 'info' as const,
                    key: 'backups.driftUnmarked' as MessageKey,
                  };
                  return (
                    <tr key={row.volid}>
                      <td>
                        <Badge variant={meta.tone} size="sm">
                          {t(meta.key)}
                        </Badge>
                      </td>
                      <td className="mono fs-xs">{row.volid}</td>
                      <td className="fs-xs">
                        {row.node}/{row.storage}
                        {row.vmid ? ` · ${row.vmid}` : ''}
                      </td>
                      <td className="fs-xs">{row.marker || '—'}</td>
                      <td className="fs-xs">{row.owner || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
