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
      toast.success('地址池已保存', `共 ${pools.length} 个池`);
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card collapsible={false}>
      <CardHeader
        title="IP 地址池"
        subtitle="为虚拟机提供可分配的静态 IP（创建 / 克隆时可下拉选择空闲地址）"
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
              添加池
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManageNet}
              onClick={() => void save()}
            >
              保存
            </Button>
          </>
        }
      />

      {!canManageNet ? (
        <Notice tone="info" title="只读模式">
          当前账号对 IP 地址池只有查看权限，新增地址池与保存修改需要管理员权限。
        </Notice>
      ) : null}

      <Notice tone="info" title="它是怎么工作的">
        这里只维护「可用地址范围」，<b>不需要 DHCP / SDN</b>。面板会扫描各虚拟机的
        cloud-init / 网卡静态配置统计已占用地址，创建或克隆虚拟机时，在网络配置里
        就能从池中选择一个<b>未被使用</b>的 IP（写入 cloud-init 静态地址）。
        需要虚拟机使用支持 cloud-init 的镜像才会生效。
      </Notice>

      {query.isError ? (
        <Notice tone="warning" title="地址池接口暂不可用">
          读取已保存的地址池失败（{errorMessage(query.error)}）。
          如果后端刚更新过，请<b>重启后端服务</b>后再刷新页面 —— 新增的
          <code>/api/ip-pools</code> 接口需要先重启才能生效。
        </Notice>
      ) : null}

      {pools.length > 0 ? (
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>名称</th>
                <th>网桥</th>
                <th>子网</th>
                <th>网关</th>
                <th>起始 IP</th>
                <th>结束 IP</th>
                <th>DNS</th>
                <th>空闲</th>
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
                        placeholder="如 业务网"
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
                        placeholder="223.5.5.5（可选）"
                        onChange={(e) => patch(i, { dns: e.target.value })}
                      />
                    </div>
                  </td>
                  <td>
                    <Badge variant={freeOf(p.id) > 0 ? 'success' : 'warning'} size="sm">
                      {freeOf(p.id)} 个
                    </Badge>
                  </td>
                  <td>
                    <IconButton
                      label="删除该地址池"
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
        <div className="text-secondary fs-sm">
          还没有地址池，点击右上角「添加池」新增（例如 192.168.1.0/24，范围
          100–200）。
        </div>
      )}
    </Card>
  );
}
