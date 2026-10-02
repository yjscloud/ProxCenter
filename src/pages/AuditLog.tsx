/* ==========================================================================
   ProxCenter — 审计日志
   筛选（用户/动作/结果/时间范围）+ 分页 + 行展开查看详情
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { auditApi, exportUrl } from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Select, Field } from '../components/ui/Input';
import { Table, Pagination, type Column } from '../components/ui/Table';
import { EmptyState, ErrorState, Notice, CollapsibleCard } from '../components/ui/EmptyState';
import {
  IconAudit,
  IconRefresh,
  IconSearch,
  IconFilter,
  IconChevronDown,
  IconChevronRight,
  IconUser,
  IconShield,
  IconAlert,
  IconCheck,
  IconDownload,
} from '../components/Icons';
import { formatDateTime, formatRelative } from '../utils/format';
import { auditResultMeta } from '../utils/status'
import { useT, type MessageKey, type TFunc } from '../i18n';
import { useToast } from '../hooks/useToast';
import type { AuditEntry } from '../api/types';

/* ---------------------------------------------------------------------------
   常量
   --------------------------------------------------------------------------- */

/* 取值必须与后端落库的 result 一致（security.audit 的调用点写的是
   success / failed / partial / denied / accepted）。原先写的是 failure，
   后端既没有这个值、pattern 也不放行，一选「失败」直接 422。 */
const RESULT_FILTERS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'audit.resultAll', value: '' },
  { label: 'status.audit.success', value: 'success' },
  { label: 'status.audit.failed', value: 'failed' },
  { label: 'status.audit.denied', value: 'denied' },
  { label: 'audit.resultPartial', value: 'partial' },
];

const PAGE_SIZES = [20, 50, 100] as const;

/** 常用动作前缀（后端 action 命名约定）*/
const ACTION_FILTERS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'audit.actionAll', value: '' },
  { label: 'audit.actionAuth', value: 'auth' },
  { label: 'audit.actionPower', value: 'power' },
  { label: 'audit.actionCreate', value: 'create' },
  { label: 'audit.actionConfig', value: 'config' },
  { label: 'audit.actionDelete', value: 'delete' },
  { label: 'audit.actionSnapshot', value: 'snapshot' },
  { label: 'audit.actionBackup', value: 'backup' },
  { label: 'audit.actionMigrate', value: 'migrate' },
  { label: 'audit.actionUser', value: 'user' },
  { label: 'audit.actionNetwork', value: 'network' },
];

/** 时间范围快捷选项（小时）*/
const RANGE_OPTIONS: ReadonlyArray<{ label: MessageKey; value: string }> = [
  { label: 'audit.rangeAll', value: '' },
  { label: 'audit.range1h', value: '1' },
  { label: 'audit.range24h', value: '24' },
  { label: 'audit.range7d', value: '168' },
  { label: 'audit.range30d', value: '720' },
];

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function AuditLog() {
  const t = useT();
  const toast = useToast();

  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [range, setRange] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  /* ---- 时间范围 → ISO 字符串 ---- */
  const timeWindow = useMemo(() => {
    if (!range) return { start: undefined, end: undefined };
    const hours = Number(range);
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3_600_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, [range]);

  /* ---- 查询参数 ---- */
  const offset = (page - 1) * pageSize;

  const queryParams = useMemo(
    () => ({
      limit: pageSize,
      offset,
      username: username.trim() || undefined,
      action: action || undefined,
      result: result || undefined,
      start: timeWindow.start,
      end: timeWindow.end,
    }),
    [pageSize, offset, username, action, result, timeWindow],
  );

  const auditQuery = useQuery({
    queryKey: ['audit', queryParams],
    queryFn: () => auditApi.list(queryParams),
    staleTime: 15_000,
  });

  /* 条件变化时回到第 1 页 */
  useEffect(() => {
    setPage(1);
  }, [username, action, result, range, pageSize]);

  /* 局部关键词过滤（在当前页内） */
  const items = useMemo(() => {
    const list = auditQuery.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.action.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        (e.detail ?? '').toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q),
    );
  }, [auditQuery.data, search]);

  const total = auditQuery.data?.total ?? 0;

  /* ---- 当前页统计 ---- */
  const pageStats = useMemo(() => {
    const list = auditQuery.data?.items ?? [];
    let success = 0;
    let failure = 0;
    list.forEach((e) => {
      const r = (e.result ?? '').toLowerCase();
      if (r === 'success' || r === 'ok') success += 1;
      else if (r) failure += 1;
    });
    return { success, failure };
  }, [auditQuery.data]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const resetFilters = () => {
    setUsername('');
    setAction('');
    setResult('');
    setRange('');
    setSearch('');
    setPage(1);
  };

  const hasFilters = Boolean(username || action || result || range || search);

  /* ---- 导出 CSV（当前页） ---- */
  const exportCsv = () => {
    const list = auditQuery.data?.items ?? [];
    if (list.length === 0) {
      toast.warning(t('audit.noRecordsToExport'));
      return;
    }
    const header = [
      t('audit.csv.time'),
      t('audit.csv.user'),
      t('audit.csv.action'),
      t('audit.csv.target'),
      t('audit.csv.result'),
      t('audit.csv.ip'),
      t('audit.csv.detail'),
    ];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = list.map((e) =>
      [
        formatDateTime(e.timestamp),
        e.username,
        e.action,
        e.target,
        e.result,
        e.ip ?? '',
        (e.detail ?? '').replace(/\r?\n/g, ' '),
      ]
        .map((v) => escape(String(v)))
        .join(','),
    );
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('audit.exported', { n: list.length }));
  };

  /* ---- 导出全部（服务端流式导出，覆盖全量、带上当前筛选条件） ----
     审计表只追加不删除，几十万行是常态：前端那 50 条一页导出来对合规归档没有
     意义，所以这里交给后端边读边吐。用 window.open 而不是 fetch —— 附件下载
     直接由浏览器接管，不必把整张表读进内存再拼 Blob。 */
  const exportAll = () => {
    const seconds = (iso?: string) =>
      iso ? Math.floor(new Date(iso).getTime() / 1000) : undefined;
    window.open(
      exportUrl('audit', {
        username: username.trim() || undefined,
        action: action || undefined,
        result: result || undefined,
        start: seconds(timeWindow.start),
        end: seconds(timeWindow.end),
        search: search.trim() || undefined,
      }),
      '_blank',
    );
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<AuditEntry>> = [
    {
      key: 'expand',
      header: '',
      width: 40,
      align: 'center',
      render: (e) => (
        <span className="perm-no" aria-hidden="true">
          {expanded.has(e.id) ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )}
        </span>
      ),
    },
    {
      key: 'timestamp',
      header: t('audit.colTime'),
      width: 180,
      render: (e) => (
        <div className="vm-name-cell">
          <span className="mono fs-sm">{formatDateTime(e.timestamp)}</span>
          <span className="fs-xs text-muted">{formatRelative(e.timestamp)}</span>
        </div>
      ),
      sortable: true,
      sortValue: (e) => new Date(e.timestamp).getTime(),
    },
    {
      key: 'username',
      header: t('audit.colUser'),
      width: 140,
      render: (e) => (
        <div className="vm-name-cell">
          <span className="fw-500">{e.username}</span>
          {e.ip ? <span className="fs-xs text-muted mono">{e.ip}</span> : null}
        </div>
      ),
      sortable: true,
      sortValue: (e) => e.username,
    },
    {
      key: 'action',
      header: t('audit.colAction'),
      width: 160,
      render: (e) => (
        <Badge variant="neutral" size="sm">
          {actionLabel(e.action, t)}
        </Badge>
      ),
      sortable: true,
      sortValue: (e) => e.action,
    },
    {
      key: 'target',
      header: t('audit.colTarget'),
      render: (e) => (
        <span className="mono fs-sm truncate" title={e.target}>
          {e.target || '—'}
        </span>
      ),
    },
    {
      key: 'result',
      header: t('audit.colResult'),
      width: 100,
      align: 'center',
      render: (e) => {
        const meta = auditResultMeta(e.result, t);
        return (
          <Badge variant={meta.variant} dot size="sm">
            {meta.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (e) => e.result,
    },
  ];

  return (
    <PageShell
      title={
        <>
          <IconAudit size={20} />
          {t('audit.title')}
        </>
      }
      subtitle={t('audit.subtitle')}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={exportCsv}
            disabled={items.length === 0}
          >
            {t('audit.exportPage')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={exportAll}
            disabled={total === 0}
            title={t('audit.exportAllTitle')}
          >
            {t('audit.exportAll')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void auditQuery.refetch()}
            loading={auditQuery.isFetching && !auditQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {/* 统计 */}
      <div className="grid grid-4">
        <KpiCard
          label={t('audit.kpi.total')}
          value={total}
          icon={<IconAudit size={18} />}
          tone="accent"
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label={t('audit.kpi.pageSuccess')}
          value={pageStats.success}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label={t('audit.kpi.pageFailed')}
          value={pageStats.failure}
          icon={<IconAlert size={18} />}
          tone={pageStats.failure > 0 ? 'danger' : 'neutral'}
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label={t('audit.kpi.pageSize')}
          value={pageSize}
          icon={<IconFilter size={18} />}
          tone="neutral"
        />
      </div>

      {/* 筛选区 */}
      <Card>
        <CardHeader
          title={t('audit.filtersTitle')}
          subtitle={t('audit.filtersSubtitle')}
          icon={<IconFilter size={17} />}
          actions={
            hasFilters ? (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                {t('audit.clearFilters')}
              </Button>
            ) : undefined
          }
        />
        <div className="dyn-list">
          <div className="dyn-row">
            <Field label={t('audit.fieldUser')}>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('audit.usernamePlaceholder')}
                prefix={<IconUser size={15} />}
              />
            </Field>

            <Field label={t('audit.fieldAction')}>
              <Select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                options={ACTION_FILTERS.map((a) => ({
                  label: t(a.label),
                  value: a.value,
                }))}
              />
            </Field>

            <Field label={t('audit.fieldResult')}>
              <Select
                value={result}
                onChange={(e) => setResult(e.target.value)}
                options={RESULT_FILTERS.map((r) => ({
                  label: t(r.label),
                  value: r.value,
                }))}
              />
            </Field>

            <Field label={t('audit.fieldRange')}>
              <Select
                value={range}
                onChange={(e) => setRange(e.target.value)}
                options={RANGE_OPTIONS.map((r) => ({
                  label: t(r.label),
                  value: r.value,
                }))}
              />
            </Field>
          </div>

          <div className="dyn-row">
            <Field
              label={t('audit.fieldKeyword')}
              hint={t('audit.keywordHint')}
            >
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('audit.searchPlaceholder')}
                prefix={<IconSearch size={15} />}
              />
            </Field>
          </div>
        </div>

        {timeWindow.start && timeWindow.end ? (
          <Notice tone="info">
            {t('audit.window')}<span className="mono">{formatDateTime(timeWindow.start)}</span>
            {' → '}
            <span className="mono">{formatDateTime(timeWindow.end)}</span>
          </Notice>
        ) : null}
      </Card>

      {/* 列表 */}
      {auditQuery.isError && isNotImplemented(auditQuery.error) ? (
        <ErrorState
          notImplemented
          title={t('audit.notImplTitle')}
          message={t('audit.notImplMsg')}
          onRetry={() => void auditQuery.refetch()}
        />
      ) : auditQuery.isError ? (
        <ErrorState
          title={t('audit.loadFailed')}
          message={errorMessage(auditQuery.error)}
          onRetry={() => void auditQuery.refetch()}
        />
      ) : (
        <>
          <Table<AuditEntry>
            columns={columns}
            rows={items}
            rowKey={(e) => e.id}
            loading={auditQuery.isLoading}
            dense
            caption={t('audit.caption')}
            emptyTitle={hasFilters ? t('audit.emptyMatch') : t('audit.emptyNone')}
            emptyDescription={
              hasFilters
                ? t('audit.emptyMatchDesc')
                : t('audit.emptyNoneDesc')
            }
            onRowClick={(e) => toggleExpand(e.id)}
            rowTitle={() => t('audit.rowTitle')}
          />

          {/* 展开详情 */}
          {items
            .filter((e) => expanded.has(e.id))
            .map((e) => (
              <Card key={`detail-${e.id}`}>
                <CardHeader
                  title={t('audit.detailTitle', { id: e.id })}
                  subtitle={`${actionLabel(e.action, t)} · ${e.target || t('audit.noTarget')}`}
                  icon={<IconAudit size={17} />}
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleExpand(e.id)}
                    >
                      {t('audit.collapse')}
                    </Button>
                  }
                />
                <div className="desc-list">
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlTime')}</div>
                    <div className="desc-value mono">
                      {formatDateTime(e.timestamp)}（{formatRelative(e.timestamp)}）
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlUser')}</div>
                    <div className="desc-value">
                      {e.username}
                      {e.ip ? (
                        <span className="fs-xs text-muted mono"> · {e.ip}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlAction')}</div>
                    <div className="desc-value mono">{e.action}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlTarget')}</div>
                    <div className="desc-value mono">{e.target || '—'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlResult')}</div>
                    <div className="desc-value">
                      <Badge
                        variant={auditResultMeta(e.result, t).variant}
                        dot
                        size="sm"
                      >
                        {auditResultMeta(e.result, t).label}
                      </Badge>
                      <span className="fs-xs text-muted mono"> {e.result}</span>
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('audit.dlDetail')}</div>
                    <div className="desc-value">
                      {e.detail ? (
                        <pre className="log-viewer">{formatDetail(e.detail)}</pre>
                      ) : (
                        <span className="text-muted">{t('audit.noDetail')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}

          {items.length === 0 && total > 0 && search ? (
            <EmptyState
              compact
              title={t('audit.pageNoMatch')}
              description={t('audit.pageNoMatchDesc')}
            />
          ) : null}

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChange={setPage}
            pageSizeOptions={[...PAGE_SIZES]}
            onPageSizeChange={setPageSize}
          />

          {total > 0 ? (
            <div className="fs-sm text-muted">
              {t('audit.rangeLine', {
                start: offset + 1,
                end: Math.min(offset + items.length, total),
                total,
              })}
              {search ? t('audit.rangeLineFiltered', { n: items.length }) : ''}
            </div>
          ) : null}
        </>
      )}

      <CollapsibleCard title={t('audit.conventionsTitle')} icon={<IconShield size={15} />}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">{t('audit.cvScope')}</div>
            <div className="desc-value">
              {t('audit.cvScopeDesc')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('audit.cvFailures')}</div>
            <div className="desc-value">
              {t('audit.cvFailuresDesc')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('audit.cvIp')}</div>
            <div className="desc-value">
              {t('audit.cvIpPre')}<span className="mono">X-Forwarded-For</span>
              {t('audit.cvIpMid')}
              <span className="mono">request.client.host</span>{t('audit.cvIpPost')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('audit.cvImmutable')}</div>
            <div className="desc-value">
              {t('audit.cvImmutableDesc')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('audit.cvPagination')}</div>
            <div className="desc-value">
              {t('audit.cvPaginationDesc')}
            </div>
          </div>
        </div>
      </CollapsibleCard>
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   工具
   --------------------------------------------------------------------------- */

/** 动作标识 → 文案键 */
const ACTION_LABELS: Record<string, MessageKey> = {
  login: 'audit.act.login',
  logout: 'audit.act.logout',
  login_failed: 'audit.act.login_failed',
  vm_start: 'audit.act.vm_start',
  vm_stop: 'audit.act.vm_stop',
  vm_shutdown: 'audit.act.vm_shutdown',
  vm_reboot: 'audit.act.vm_reboot',
  vm_suspend: 'audit.act.vm_suspend',
  vm_resume: 'audit.act.vm_resume',
  vm_create: 'audit.act.vm_create',
  vm_clone: 'audit.act.vm_clone',
  vm_delete: 'audit.act.vm_delete',
  vm_config: 'audit.act.vm_config',
  vm_resize: 'audit.act.vm_resize',
  vm_move: 'audit.act.vm_move',
  vm_migrate: 'audit.act.vm_migrate',
  vm_template: 'audit.act.vm_template',
  snapshot_create: 'audit.act.snapshot_create',
  snapshot_rollback: 'audit.act.snapshot_rollback',
  snapshot_delete: 'audit.act.snapshot_delete',
  backup_create: 'audit.act.backup_create',
  backup_restore: 'audit.act.backup_restore',
  backup_delete: 'audit.act.backup_delete',
  backup_job_create: 'audit.act.backup_job_create',
  backup_job_delete: 'audit.act.backup_job_delete',
  storage_upload: 'audit.act.storage_upload',
  storage_delete: 'audit.act.storage_delete',
  network_create: 'audit.act.network_create',
  network_update: 'audit.act.network_update',
  network_delete: 'audit.act.network_delete',
  network_reload: 'audit.act.network_reload',
  user_create: 'audit.act.user_create',
  user_update: 'audit.act.user_update',
  user_delete: 'audit.act.user_delete',
  user_password: 'audit.act.user_password',
  config_update: 'audit.act.config_update',
  task_stop: 'audit.act.task_stop',
  task_remove: 'audit.act.task_remove',
};

/** 动作标识可能带前缀（vm.power.start）或下划线（vm_start），统一归一化 */
function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/\./g, '_').replace(/-/g, '_');
}

function actionLabel(action: string | null | undefined, t: TFunc): string {
  if (!action) return t('audit.unknownAction');
  const key = normalizeAction(action);
  if (ACTION_LABELS[key]) return t(ACTION_LABELS[key]);

  /* 尝试只匹配动词部分：xxx_power_start → 看是否有后缀匹配 */
  const parts = key.split('_');
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const sub = parts.slice(i).join('_');
    if (ACTION_LABELS[sub]) return t(ACTION_LABELS[sub]);
  }

  /* 兜底：把下划线换成空格，首字母大写 */
  return action.replace(/[._]/g, ' ');
}

/** 详情可能是 JSON 字符串，格式化后展示 */
function formatDetail(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) return detail;
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return detail;
    }
  }
  return detail;
}
