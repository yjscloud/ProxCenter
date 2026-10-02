/* ==========================================================================
   节点补充信息：管理地址、PVE 版本、面板侧备注

   这些都不是 PVE 节点列表直接返回的字段：
   - 地址：来自 /nodes/{node}/network，取带网关的管理地址
   - 版本：来自 /nodes/{node}/status 的 pveversion
   - 备注：PVE 没有该字段，由面板自行存储（/api/node-notes）
   ========================================================================== */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nodeNotesApi, nodesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import type { NetworkInterface } from '../api/types';

/** 从节点网卡列表中挑一个管理地址（优先带网关的） */
export function pickNodeAddress(ifaces?: NetworkInterface[]): string {
  if (!ifaces || ifaces.length === 0) return '';
  const withGateway = ifaces.find((i) => i.address && i.gateway);
  if (withGateway?.address) return withGateway.address;
  const any = ifaces.find(
    (i) => i.address && i.address !== '127.0.0.1' && !i.address.startsWith('169.254'),
  );
  return any?.address ?? '';
}

/** 节点备注（面板侧） */
export function useNodeNotes() {
  return useQuery({
    queryKey: ['node-notes'],
    queryFn: nodeNotesApi.get,
    staleTime: 60_000,
    retry: false,
  });
}

/** 按需拉取节点的地址与 PVE 版本（离线节点不查 status）。

 *  ``connectionId`` 必传于多台 PVE 合并展示的场景：不同主机的节点可能同名，
 *  不带连接标识就会取到「当前连接」那台的数据。
 */
export function useNodeMeta(node: string, online: boolean, connectionId?: string) {
  const statusQuery = useQuery({
    queryKey: ['nodes', connectionId ?? '', node, 'status'],
    queryFn: () => nodesApi.status(node, connectionId),
    enabled: online,
    staleTime: 120_000,
    retry: false,
  });
  const networkQuery = useQuery({
    queryKey: ['nodes', connectionId ?? '', node, 'network'],
    queryFn: () => nodesApi.network(node, connectionId),
    staleTime: 300_000,
    retry: false,
  });

  // pveversion 形如 "pve-manager/8.4.0/ec58e45e1bcdf2ac"，只取版本号部分
  const raw = statusQuery.data?.pveversion as string | undefined;
  const version = raw ? raw.split('/')[1] || raw : '';

  return {
    version,
    address: pickNodeAddress(networkQuery.data ?? undefined),
  };
}

/* ---------------------------------------------------------------------------
   备注编辑（失焦或回车保存）
   --------------------------------------------------------------------------- */

export function NodeNoteField({
  node,
  canEdit,
}: {
  node: string;
  canEdit: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const notesQuery = useNodeNotes();
  const saved = notesQuery.data?.notes?.[node] ?? '';
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  async function save() {
    if (draft === saved) return;
    setSaving(true);
    try {
      const next = { ...(notesQuery.data?.notes ?? {}), [node]: draft };
      await nodeNotesApi.save(next);
      await qc.invalidateQueries({ queryKey: ['node-notes'] });
      toast.success(t('nodeMeta.saved'), t('nodeMeta.savedDetail', { node }));
    } catch (err) {
      toast.error(t('nodeMeta.saveFailed'), errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="input-wrap"
      /* 卡片整体可点击跳转详情，这里阻止冒泡，避免点输入框被导航走 */
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        className="input"
        value={draft}
        disabled={!canEdit || saving}
        placeholder={
          canEdit
            ? t('nodeMeta.placeholderEdit')
            : t('nodeMeta.placeholderEmpty')
        }
        aria-label={t('nodeMeta.aria', { node })}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
