/* ==========================================================================
   ProxCenter — 磁盘健康面板
   磁盘 SMART 状态 + ZFS 池。属于「事前」信号：硬盘快坏了在这里能提前看到，
   而不是等虚拟机的 IO 开始报错才发现。
   ========================================================================== */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { healthApi } from '../api/endpoints';
import { Card, CardHeader } from './ui/Card';
import { Badge } from './ui/Badge';
import { Table, type Column } from './ui/Table';
import { EmptyState } from './ui/EmptyState';
import { IconDisk, IconStorage } from './Icons';
import { formatBytes } from '../utils/format';
import type { DiskHealth } from '../api/types';

/** 健康状态 → 徽标样式与文案 */
function healthMeta(health: string): {
  variant: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
} {
  switch (health) {
    case 'passed':
      return { variant: 'success', label: '正常' };
    case 'warning':
      return { variant: 'warning', label: '警告' };
    case 'failed':
      return { variant: 'danger', label: '故障' };
    default:
      return { variant: 'neutral', label: '未知' };
  }
}

/**
 * 剩余寿命 → 颜色。
 * 注意 PVE 的 wearout 是「剩余」百分比：越小越危险，所以阈值方向和
 * 使用率的直觉相反，不能直接套 usageColor。
 */
function wearoutColor(remain: number): string {
  if (remain <= 10) return 'var(--usage-high)';
  if (remain <= 30) return 'var(--usage-mid)';
  return 'var(--usage-low)';
}

/** 展开行：单块磁盘的 SMART 明细 */
function DiskSmartDetail({ node, disk }: { node: string; disk: string }) {
  const query = useQuery({
    queryKey: ['health', 'smart', node, disk],
    queryFn: () => healthApi.diskSmart(node, disk),
    staleTime: 60_000,
    retry: false,
  });

  if (query.isLoading) {
    return <div className="fs-sm text-muted">正在读取 SMART 数据…</div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="fs-sm text-muted">
        无法读取该磁盘的 SMART 数据（可能需要 node.manage 权限）。
      </div>
    );
  }

  const data = query.data;

  /* NVMe 盘没有结构化属性，PVE 给的是一段原文 */
  if (data.attributes.length === 0) {
    return (
      <pre className="smart-text">{data.text || '该磁盘没有返回 SMART 明细。'}</pre>
    );
  }

  const failed = data.attributes.filter((a) => a.fail);

  return (
    <div className="flex flex-col gap-8">
      {failed.length > 0 ? (
        <div className="smart-alert">
          {failed.length} 项属性已触发失败阈值：
          {failed.map((a) => a.name).join('、')}
        </div>
      ) : null}
      <div className="smart-attrs">
        {data.attributes.map((a) => (
          <div
            className={`smart-attr ${a.fail ? 'is-fail' : ''}`}
            key={`${a.id ?? ''}-${a.name}`}
          >
            <span className="smart-attr-name" title={a.name}>
              {a.name}
            </span>
            <span className="smart-attr-value mono">
              {a.value ?? '-'}
              {a.threshold !== null && a.threshold !== undefined
                ? ` / ${a.threshold}`
                : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiskHealthPanel({
  node,
  conn,
}: {
  node: string;
  conn: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const disksQuery = useQuery({
    queryKey: ['health', 'disks', conn, node],
    queryFn: () => healthApi.disks(node, conn),
    staleTime: 60_000,
    retry: false,
  });

  const zfsQuery = useQuery({
    queryKey: ['health', 'zfs', conn, node],
    queryFn: () => healthApi.zfs(node, conn),
    staleTime: 60_000,
    retry: false,
  });

  const disks = disksQuery.data ?? [];
  const pools = zfsQuery.data ?? [];
  const problemDisks = disks.filter((d) => d.health !== 'passed').length;

  const columns: Array<Column<DiskHealth>> = [
    {
      key: 'devpath',
      header: '设备',
      width: 150,
      mono: true,
      render: (d) => (
        <span className="disk-dev">
          <span className={`disk-expand ${expanded === d.devpath ? 'is-open' : ''}`}>
            ▸
          </span>
          {d.devpath}
        </span>
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 84,
      render: (d) => <span className="fs-sm text-secondary">{d.type || '—'}</span>,
    },
    {
      key: 'model',
      header: '型号 / 序列号',
      render: (d) => (
        <div className="flex flex-col">
          <span className="fs-sm truncate" title={d.model || d.vendor}>
            {d.model || d.vendor || '—'}
          </span>
          {d.serial ? (
            <span className="fs-xs text-muted mono truncate" title={d.serial}>
              {d.serial}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'size',
      header: '容量',
      width: 90,
      align: 'right',
      render: (d) => (
        <span className="mono fs-sm">{d.size ? formatBytes(d.size, 0) : '—'}</span>
      ),
    },
    {
      key: 'used',
      header: '用途',
      width: 110,
      render: (d) => (
        <span className="fs-sm text-secondary">{d.used || '未使用'}</span>
      ),
    },
    {
      key: 'health',
      header: '健康',
      width: 84,
      render: (d) => {
        const meta = healthMeta(d.health);
        return (
          <Badge variant={meta.variant} size="sm" dot={d.health !== 'passed'}>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'wearout',
      header: '剩余寿命',
      width: 110,
      align: 'right',
      render: (d) =>
        /* 机械盘没有磨损度：显示「—」而不是 0%，否则会被误读成「磨损殆尽」 */
        d.wearout === null || d.wearout === undefined ? (
          <span className="fs-sm text-muted">—</span>
        ) : (
          <span
            className="mono fs-sm fw-600"
            style={{ color: wearoutColor(d.wearout) }}
          >
            {d.wearout}%
          </span>
        ),
    },
  ];

  return (
    <>
      <Card>
        <CardHeader
          title="磁盘健康"
          subtitle={
            disksQuery.isLoading
              ? '正在读取…'
              : `${disks.length} 块磁盘${problemDisks > 0 ? ` · ${problemDisks} 块异常` : ' · 全部正常'}`
          }
          icon={<IconDisk size={16} />}
        />
        {disksQuery.isError ? (
          <EmptyState
            title="无法读取磁盘信息"
            description="PVE 未返回磁盘列表，可能是权限不足（需要 node.manage）。"
            compact
          />
        ) : (
          <Table<DiskHealth>
            columns={columns}
            rows={disks}
            rowKey={(d) => d.devpath}
            loading={disksQuery.isLoading}
            caption={`节点 ${node} 的磁盘健康状态`}
            dense
            className="table-flush"
            emptyTitle="暂无磁盘"
            emptyDescription="该节点上没有检测到物理磁盘。"
            onRowClick={(d) =>
              setExpanded((cur) => (cur === d.devpath ? null : d.devpath))
            }
            isRowSelected={(d) => expanded === d.devpath}
          />
        )}

        {/* 展开行放在表格外面：表格组件不支持插入详情行，
            这里用一段独立区域展示，避免改动通用表格 */}
        {expanded ? (
          <div className="disk-smart-panel">
            <div className="disk-smart-head">
              <span className="fw-600 mono">{expanded}</span>
              <span className="fs-xs text-muted">SMART 明细</span>
            </div>
            <DiskSmartDetail node={node} disk={expanded} />
          </div>
        ) : null}
      </Card>

      {/* ZFS 只在真有池的时候出现 */}
      {pools.length > 0 ? (
        <Card>
          <CardHeader
            title="ZFS 池"
            subtitle={`${pools.length} 个池`}
            icon={<IconStorage size={16} />}
          />
          <div className="flex flex-col gap-12">
            {pools.map((p) => {
              const total = p.size ?? 0;
              const alloc = p.alloc ?? 0;
              const pct = total > 0 ? (alloc / total) * 100 : 0;
              const healthy = p.state.toUpperCase() === 'ONLINE';
              return (
                <div className="zfs-pool" key={p.name}>
                  <div className="zfs-pool-head">
                    <span className="fw-600 mono">{p.name}</span>
                    <Badge variant={healthy ? 'success' : 'danger'} size="sm" dot={!healthy}>
                      {p.state}
                    </Badge>
                  </div>
                  <div className="fs-xs text-secondary">
                    已用 {formatBytes(alloc, 0)} / {formatBytes(total, 0)}
                    {p.frag ? ` · 碎片 ${p.frag}` : ''}
                    {p.errors && p.errors !== 'No known data errors'
                      ? ` · ${p.errors}`
                      : ''}
                  </div>
                  <div className="inline-meter" style={{ marginTop: 6 }}>
                    <div
                      className="inline-meter-fill"
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: pct >= 85 ? 'var(--usage-high)' : 'var(--accent)',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}
    </>
  );
}
