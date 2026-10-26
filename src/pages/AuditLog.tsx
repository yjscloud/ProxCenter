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
import { PAGE_SIZE_OPTIONS } from '../hooks/usePaged';
import { panelPageSize } from '../utils/panelSettings';
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
import { useAuth } from '../hooks/useAuth';
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

/**
 * 审计 detail 的两种形态。
 *
 * 后端 ``store.add_audit`` 会把 dict/list 编码成 JSON 再落库，所以额度那几处写的
 * ``{"reason": "quota", ...}`` 拿回来是**可解析的 JSON**；其余调用点传的仍是纯文本
 * （成功/失败的说明）。两种都要能读，所以这里先试解析、失败就当文本。
 *
 * 这条能力是「只看被额度挡住的」能做得精确的原因：光看 ``result === 'denied'``
 * 只能旁证（denied 目前确实只有额度会写），按 ``reason`` 才是**直接**判据。
 */
function auditDetail(entry: AuditEntry): string | Record<string, unknown> {
  const raw = entry.detail;
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : raw;
  } catch {
    return raw;
  }
}

/** 拒绝原因（后端写的 ``reason``）；纯文本的 detail 没有它，返回空串 */
function auditReason(entry: AuditEntry): string {
  const parsed = auditDetail(entry);
  return typeof parsed === 'string' ? '' : String(parsed.reason ?? '');
}

export function AuditLog() {
  const t = useT();
  const toast = useToast();
  /* 可见范围与后端同一口径：管理员看全部，其他人只看自己。后端已经强制
     按当前用户过滤（越权索取别人的用户名会 403），这里只负责别把「操作者」
     筛选框摆给一个永远只能看自己的人。 */
  const { isAdmin } = useAuth();

  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [range, setRange] = useState('');
  const [search, setSearch] = useState('');
  /* 「只看被额度挡住的」的服务端那一半（result=denied）交给 queryParams，
     这一半按 reason 在当前页里再收窄 —— 光靠 result 只是旁证。 */
  const [quotaOnly, setQuotaOnly] = useState(false);
  const [page, setPage] = useState(1);
  /* 初始每页条数跟随「设置 → 面板设置 → 列表每页条数」（原先写死 50）。
     这一页是**服务端分页**（limit / offset），所以用不了 usePaged 的前端切片，
     只借它的默认值与候选值，保证各列表的条数口径一致。 */
  const [pageSize, setPageSize] = useState<number>(() => panelPageSize());
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
      /* 关键词交给后端做全量匹配（动作/对象/详情/用户/来源 IP），而不是只翻
         当前这一页 —— 审计表几十万行，本页过滤搜 IP 基本搜不到。 */
      search: search.trim() || undefined,
    }),
    [pageSize, offset, username, action, result, timeWindow, search],
  );

  const auditQuery = useQuery({
    queryKey: ['audit', queryParams],
    queryFn: () => auditApi.list(queryParams),
    staleTime: 15_000,
  });

  /* 条件变化时回到第 1 页 */
  useEffect(() => {
    setPage(1);
  }, [username, action, result, range, search, pageSize]);

  /* 关键词已上移到服务端，这里只剩「被额度挡住」的本地收窄：额度拒绝的原因
     藏在 detail JSON 的 reason 里（quota / quota_stats），后端没有这一列可筛。 */
  const items = useMemo(() => {
    const list = auditQuery.data?.items ?? [];
    return list.filter(
      (e) =>
        !quotaOnly ||
        auditReason(e) === 'quota' ||
        auditReason(e) === 'quota_stats',
    );
  }, [auditQuery.data, quotaOnly]);

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

  /** 行内展开的内容：与原先的独立详情卡同一份字段，就地铺开在记录正下方 */
  const renderAuditDetail = (e: AuditEntry) => (
    <div className="desc-list audit-detail-inline">
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
  );

  const resetFilters = () => {
    setUsername('');
    setAction('');
    setResult('');
    setRange('');
    setSearch('');
    setQuotaOnly(false);
    setPage(1);
  };

  const hasFilters = Boolean(username || action || result || range || search || quotaOnly);

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
      subtitle={isAdmin ? t('audit.subtitle') : t('audit.subtitleOwn')}
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
      {/* 只有管理员能看全量：把范围说清楚，别让人以为「记录只有这么几条」 */}
      {!isAdmin ? (
        <Notice tone="info" title={t('audit.ownScopeTitle')}>
          {t('audit.ownScopeNotice')}
        </Notice>
      ) : null}

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
            {/* 「操作者」筛选只对管理员有意义：其他人无论填谁都只会拿到自己的
                记录（后端会 403），摆出来只会让人以为能看到别人的日志。 */}
            {isAdmin ? (
              <Field label={t('audit.fieldUser')}>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('audit.usernamePlaceholder')}
                  prefix={<IconUser size={15} />}
                />
              </Field>
            ) : null}

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

            {/* 「被额度挡住」的一键入口。额度是唯一需要管理员**持续**看的拒绝：
                「谁建不了机器」直接决定要不要给谁放宽。放在结果筛选旁边而不是
                藏进下拉里 —— 那个下拉叫「结果」，没人会想到去那里找额度。

                判据就是 ``result=denied``：后端只有额度那几处会写它
                （app/quota.py 的 enforce_* / enforce_snapshot，以及 bulk 里
                转发过来的同一个异常）。别的失败一律是 ``failed``。 */}
            <Field label={t('audit.fieldQuota')}>
              <Button
                variant={result === 'denied' ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={quotaOnly}
                onClick={() => {
                  const next = !quotaOnly;
                  setQuotaOnly(next);
                  setResult(next ? 'denied' : '');
                }}
              >
                {t('audit.onlyQuotaDenied')}
              </Button>
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
            /* 点开哪行，详情就就地展开在哪行正下方 —— 不再渲染成表格下方的
               独立卡片把用户往下推（记录多时要滚很久才找得到刚点的那条）。 */
            isRowExpanded={(e) => expanded.has(e.id)}
            renderExpanded={renderAuditDetail}
          />

          {/* 分页条紧跟表格 —— 它会接成这张表格卡的下沿（见 .pagination 的样式）。 */}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChange={setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={setPageSize}
          />

          {items.length === 0 && total > 0 && search ? (
            <EmptyState
              compact
              title={t('audit.pageNoMatch')}
              description={t('audit.pageNoMatchDesc')}
            />
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
  user_expire: 'audit.act.user_expire',
  auth_new_ip: 'audit.act.auth_new_ip',
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
