/* ==========================================================================
   IP 地址池管理（网络页）

   不依赖 DHCP / SDN：池只是一段「子网 + 可分配范围」，面板扫描各虚拟机
   的静态配置得出已占用地址，创建 / 克隆虚拟机时把空闲地址作为下拉选项。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipPoolsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Button, IconButton } from './ui/Button';
import { Notice } from './ui/EmptyState';
import { Badge } from './ui/Badge';
import { IconPlus, IconTrash, IconSave, IconNetwork } from './Icons';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import type { IpPool } from '../api/types';

function newPool(): IpPool {
  return {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    name: '',
    bridge: 'vmbr0',
    subnet: '',
    gateway: '',
    start: '',
    end: '',
    dns: '',
  };
}

export function IpPoolPanel() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  /* 地址池保存在后端、写入走 network.manage（仅管理员），界面沿用同一判定 */
  const { hasPermission } = useAuth();
  const canManageNet = hasPermission('network.manage');
  // 直接用数组而不是 null，避免接口暂时不可用时连「添加池」都点不了。
  const [pools, setPools] = useState<IpPool[]>([]);
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setPools(
      (query.data.pools ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        bridge: p.bridge,
        subnet: p.subnet,
        gateway: p.gateway,
        start: p.start,
        end: p.end,
        dns: p.dns,
      })),
    );
  }, [query.data]);

  const freeOf = (id: string): number =>
    (query.data?.pools ?? []).find((p) => p.id === id)?.free_count ?? 0;

  function patch(index: number, next: Partial<IpPool>) {
    setPools((list) =>
      list ? list.map((p, i) => (i === index ? { ...p, ...next } : p)) : list,
    );
  }

  async function save() {
    setBusy(true);
    try {
      await ipPoolsApi.save(pools);
      await qc.invalidateQueries({ queryKey: ['ip-pools'] });
      toast.success(
        t('ippool.saved'),
        t('ippool.savedDetail', { n: pools.length }),
      );
    } catch (err) {
      toast.error(t('ippool.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card collapsible={false}>
      <CardHeader
        title={t('ippool.title')}
        subtitle={t('ippool.subtitle')}
        icon={<IconNetwork size={16} />}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconPlus size={14} />}
              disabled={!canManageNet}
              onClick={() => setPools([...pools, newPool()])}
            >
              {t('ippool.addPool')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManageNet}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />

      {!canManageNet ? (
        <Notice tone="info" title={t('ippool.readonlyTitle')}>
          {t('ippool.readonlyBody')}
        </Notice>
      ) : null}

      <Notice tone="info" title={t('ippool.howTitle')}>
        {t('ippool.howPre')}
        <b>{t('ippool.howBold1')}</b>
        {t('ippool.howMid')}
        <b>{t('ippool.howBold2')}</b>
        {t('ippool.howPost')}
      </Notice>

      {query.isError ? (
        <Notice tone="warning" title={t('ippool.apiTitle')}>
          {t('ippool.apiPre')}
          {errorMessage(query.error)}
          {t('ippool.apiMid')}
          <b>{t('ippool.apiBold')}</b>
          {t('ippool.apiMid2')}
          <code>/api/ip-pools</code>
          {t('ippool.apiPost')}
        </Notice>
      ) : null}

      {pools.length > 0 ? (
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>{t('ippool.colName')}</th>
                <th>{t('ippool.colBridge')}</th>
                <th>{t('ippool.colSubnet')}</th>
                <th>{t('ippool.colGateway')}</th>
                <th>{t('ippool.colStart')}</th>
                <th>{t('ippool.colEnd')}</th>
                <th>DNS</th>
                <th>{t('ippool.colFree')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pools.map((p, i) => (
                <tr key={p.id}>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.name}
                        placeholder={t('ippool.namePlaceholder')}
                        onChange={(e) => patch(i, { name: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.bridge}
                        placeholder="vmbr0"
                        onChange={(e) => patch(i, { bridge: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.subnet}
                        placeholder="192.168.1.0/24"
                        onChange={(e) => patch(i, { subnet: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.gateway}
                        placeholder="192.168.1.1"
                        onChange={(e) => patch(i, { gateway: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.start}
                        placeholder="192.168.1.100"
                        onChange={(e) => patch(i, { start: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.end}
                        placeholder="192.168.1.200"
                        onChange={(e) => patch(i, { end: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="input-wrap">
                      <input
                        className="input"
                        value={p.dns}
                        placeholder={t('ippool.dnsPlaceholder')}
                        onChange={(e) => patch(i, { dns: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <Badge variant={freeOf(p.id) > 0 ? 'success' : 'warning'} size="sm">
                      {t('ippool.freeCount', { n: freeOf(p.id) })}
                    </Badge>
                  </td>
                  <td>
                    <IconButton
                      label={t('ippool.deleteAria')}
                      variant="danger"
                      disabled={!canManageNet}
                      onClick={() => setPools(pools.filter((_, k) => k !== i))}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-secondary fs-sm">{t('ippool.empty')}</div>
      )}
    </Card>
  );
}
