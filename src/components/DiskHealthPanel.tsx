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
import { formatBytes, usageColor } from '../utils/format';
import { useT, type TFunc } from '../i18n';
import type { DiskHealth } from '../api/types';

/** 健康状态 → 徽标样式与文案（文案随语言走，故接收 t） */
function healthMeta(
  health: string,
  t: TFunc,
): {
  variant: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
} {
  switch (health) {
    case 'passed':
      return { variant: 'success', label: t('disk.healthOk') };
    case 'warning':
      return { variant: 'warning', label: t('disk.healthWarn') };
    case 'failed':
      return { variant: 'danger', label: t('disk.healthFail') };
    default:
      return { variant: 'neutral', label: t('disk.healthUnknown') };
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
  const t = useT();
  const query = useQuery({
    queryKey: ['health', 'smart', node, disk],
    queryFn: () => healthApi.diskSmart(node, disk),
    staleTime: 60_000,
    retry: false,
  });

  if (query.isLoading) {
    return <div className="fs-sm text-muted">{t('disk.smartLoading')}</div>;
  }
  if (query.isError || !query.data) {
    return <div className="fs-sm text-muted">{t('disk.smartError')}</div>;
  }

  const data = query.data;

  /* NVMe 盘没有结构化属性，PVE 给的是一段原文 */
  if (data.attributes.length === 0) {
    return (
      <pre className="smart-text">{data.text || t('disk.smartEmpty')}</pre>
    );
  }

  const failed = data.attributes.filter((a) => a.fail);

  return (
    <div className="flex flex-col gap-8">
      {failed.length > 0 ? (
        <div className="smart-alert">
          {t('disk.smartFailedAttrs', { n: failed.length })}
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
  const t = useT();
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
      header: t('disk.colDevice'),
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
      header: t('disk.colType'),
      width: 84,
      render: (d) => <span className="fs-sm text-secondary">{d.type || '—'}</span>,
    },
    {
      key: 'model',
      header: t('disk.colModel'),
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
      header: t('disk.colSize'),
      width: 90,
      align: 'right',
      render: (d) => (
        <span className="mono fs-sm">{d.size ? formatBytes(d.size, 0) : '—'}</span>
      ),
    },
    {
      key: 'used',
      header: t('disk.colUsage'),
      width: 110,
      render: (d) => (
        <span className="fs-sm text-secondary">
          {d.used || t('disk.notUsed')}
        </span>
      ),
    },
    {
      key: 'health',
      header: t('disk.colHealth'),
      width: 84,
      render: (d) => {
        const meta = healthMeta(d.health, t);
        return (
          <Badge variant={meta.variant} size="sm" dot={d.health !== 'passed'}>
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'wearout',
      header: t('disk.colWearout'),
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
          title={t('disk.title')}
          subtitle={
            disksQuery.isLoading
              ? t('disk.loading')
              : `${t('disk.summary', { n: disks.length })}${
                  problemDisks > 0
                    ? t('disk.summaryProblems', { n: problemDisks })
                    : t('disk.summaryOk')
                }`
          }
          icon={<IconDisk size={16} />}
        />
        {disksQuery.isError ? (
          <EmptyState
            title={t('disk.loadFailedTitle')}
            description={t('disk.loadFailedDesc')}
            compact
          />
        ) : (
          <Table<DiskHealth>
            columns={columns}
            rows={disks}
            rowKey={(d) => d.devpath}
            loading={disksQuery.isLoading}
            caption={t('disk.caption', { node })}
            dense
            className="table-flush"
            emptyTitle={t('disk.empty')}
            emptyDescription={t('disk.emptyDesc')}
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
              <span className="fs-xs text-muted">{t('disk.smartDetails')}</span>
            </div>
            <DiskSmartDetail node={node} disk={expanded} />
          </div>
        ) : null}
      </Card>

      {/* ZFS 只在真有池的时候出现 */}
      {pools.length > 0 ? (
        <Card>
          <CardHeader
            title={t('disk.zfsTitle')}
            subtitle={t('disk.zfsCount', { n: pools.length })}
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
                    {t('disk.zfsUsed', {
                      used: formatBytes(alloc, 0),
                      total: formatBytes(total, 0),
                    })}
                    {p.frag ? t('disk.zfsFrag', { v: p.frag }) : ''}
                    {p.errors && p.errors !== 'No known data errors'
                      ? ` · ${p.errors}`
                      : ''}
                  </div>
                  <div className="inline-meter" style={{ marginTop: 6 }}>
                    <div
                      className="inline-meter-fill"
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: usageColor(pct),
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
