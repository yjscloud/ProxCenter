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
import { auditResultMeta } from '../utils/status';
import { useToast } from '../hooks/useToast';
import type { AuditEntry } from '../api/types';

/* ---------------------------------------------------------------------------
   常量
   --------------------------------------------------------------------------- */

/* 取值必须与后端落库的 result 一致（security.audit 的调用点写的是
   success / failed / partial / denied / accepted）。原先写的是 failure，
   后端既没有这个值、pattern 也不放行，一选「失败」直接 422。 */
const RESULT_FILTERS = [
  { label: '全部结果', value: '' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '拒绝', value: 'denied' },
  { label: '部分完成', value: 'partial' },
] as const;

const PAGE_SIZES = [20, 50, 100] as const;

/** 常用动作前缀（后端 action 命名约定）*/
const ACTION_FILTERS = [
  { label: '全部动作', value: '' },
  { label: '登录 / 登出', value: 'auth' },
  { label: '电源操作', value: 'power' },
  { label: '创建 / 克隆', value: 'create' },
  { label: '修改配置', value: 'config' },
  { label: '删除', value: 'delete' },
  { label: '快照', value: 'snapshot' },
  { label: '备份', value: 'backup' },
  { label: '迁移', value: 'migrate' },
  { label: '用户管理', value: 'user' },
  { label: '网络配置', value: 'network' },
] as const;

/** 时间范围快捷选项（小时）*/
const RANGE_OPTIONS = [
  { label: '全部时间', value: '' },
  { label: '最近 1 小时', value: '1' },
  { label: '最近 24 小时', value: '24' },
  { label: '最近 7 天', value: '168' },
  { label: '最近 30 天', value: '720' },
] as const;

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function AuditLog() {
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
      toast.warning('没有可导出的记录');
      return;
    }
    const header = ['时间', '用户', '动作', '目标', '结果', 'IP', '详情'];
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
    toast.success(`已导出当前页 ${list.length} 条记录`);
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
      header: '时间',
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
      header: '操作者',
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
      header: '动作',
      width: 160,
      render: (e) => (
        <Badge variant="neutral" size="sm">
          {actionLabel(e.action)}
        </Badge>
      ),
      sortable: true,
      sortValue: (e) => e.action,
    },
    {
      key: 'target',
      header: '操作对象',
      render: (e) => (
        <span className="mono fs-sm truncate" title={e.target}>
          {e.target || '—'}
        </span>
      ),
    },
    {
      key: 'result',
      header: '结果',
      width: 100,
      align: 'center',
      render: (e) => {
        const meta = auditResultMeta(e.result);
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
          审计日志
        </>
      }
      subtitle="记录所有经面板发起的操作，用于安全审计与故障回溯"
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={exportCsv}
            disabled={items.length === 0}
          >
            导出当前页
          </Button>
          <Button
            variant="secondary"
            icon={<IconDownload size={15} />}
            onClick={exportAll}
            disabled={total === 0}
            title="按当前筛选条件导出全部记录（不受分页限制）"
          >
            导出全部
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => void auditQuery.refetch()}
            loading={auditQuery.isFetching && !auditQuery.isLoading}
          >
            刷新
          </Button>
        </>
      }
    >
      {/* 统计 */}
      <div className="grid grid-4">
        <KpiCard
          label="记录总数"
          value={total}
          icon={<IconAudit size={18} />}
          tone="accent"
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label="当前页成功"
          value={pageStats.success}
          icon={<IconCheck size={18} />}
          tone="success"
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label="当前页失败"
          value={pageStats.failure}
          icon={<IconAlert size={18} />}
          tone={pageStats.failure > 0 ? 'danger' : 'neutral'}
          loading={auditQuery.isLoading}
        />
        <KpiCard
          label="每页条数"
          value={pageSize}
          icon={<IconFilter size={18} />}
          tone="neutral"
        />
      </div>

      {/* 筛选区 */}
      <Card>
        <CardHeader
          title="筛选条件"
          subtitle="所有条件为「与」关系，修改后自动回到第一页"
          icon={<IconFilter size={17} />}
          actions={
            hasFilters ? (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                清除筛选
              </Button>
            ) : undefined
          }
        />
        <div className="dyn-list">
          <div className="dyn-row">
            <Field label="操作者">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="用户名，例如 admin"
                prefix={<IconUser size={15} />}
              />
            </Field>

            <Field label="动作类型">
              <Select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                options={ACTION_FILTERS.map((a) => ({
                  label: a.label,
                  value: a.value,
                }))}
              />
            </Field>

            <Field label="执行结果">
              <Select
                value={result}
                onChange={(e) => setResult(e.target.value)}
                options={RESULT_FILTERS.map((r) => ({
                  label: r.label,
                  value: r.value,
                }))}
              />
            </Field>

            <Field label="时间范围">
              <Select
                value={range}
                onChange={(e) => setRange(e.target.value)}
                options={RANGE_OPTIONS.map((r) => ({
                  label: r.label,
                  value: r.value,
                }))}
              />
            </Field>
          </div>

          <div className="dyn-row">
            <Field
              label="本页关键词过滤"
              hint="仅在当前已加载的这一页内做文本匹配，不触发新请求"
            >
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索动作、对象、详情…"
                prefix={<IconSearch size={15} />}
              />
            </Field>
          </div>
        </div>

        {timeWindow.start && timeWindow.end ? (
          <Notice tone="info">
            查询区间：<span className="mono">{formatDateTime(timeWindow.start)}</span>
            {' → '}
            <span className="mono">{formatDateTime(timeWindow.end)}</span>
          </Notice>
        ) : null}
      </Card>

      {/* 列表 */}
      {auditQuery.isError && isNotImplemented(auditQuery.error) ? (
        <ErrorState
          notImplemented
          title="审计日志接口尚未实现"
          message="后端 /audit 返回未实现。建议返回 { items, total } 结构，并支持 limit/offset/username/action/result/start/end 查询参数。"
          onRetry={() => void auditQuery.refetch()}
        />
      ) : auditQuery.isError ? (
        <ErrorState
          title="无法加载审计日志"
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
            caption="操作审计日志列表"
            emptyTitle={hasFilters ? '没有匹配的记录' : '暂无审计记录'}
            emptyDescription={
              hasFilters
                ? '尝试放宽筛选条件或清除筛选后重试。'
                : '面板尚未产生任何操作记录。'
            }
            onRowClick={(e) => toggleExpand(e.id)}
            rowTitle={() => '点击展开详情'}
          />

          {/* 展开详情 */}
          {items
            .filter((e) => expanded.has(e.id))
            .map((e) => (
              <Card key={`detail-${e.id}`}>
                <CardHeader
                  title={`记录详情 #${e.id}`}
                  subtitle={`${actionLabel(e.action)} · ${e.target || '无对象'}`}
                  icon={<IconAudit size={17} />}
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleExpand(e.id)}
                    >
                      收起
                    </Button>
                  }
                />
                <div className="desc-list">
                  <div className="desc-item">
                    <div className="desc-label">时间</div>
                    <div className="desc-value mono">
                      {formatDateTime(e.timestamp)}（{formatRelative(e.timestamp)}）
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">操作者</div>
                    <div className="desc-value">
                      {e.username}
                      {e.ip ? (
                        <span className="fs-xs text-muted mono"> · {e.ip}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">动作</div>
                    <div className="desc-value mono">{e.action}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">操作对象</div>
                    <div className="desc-value mono">{e.target || '—'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">结果</div>
                    <div className="desc-value">
                      <Badge
                        variant={auditResultMeta(e.result).variant}
                        dot
                        size="sm"
                      >
                        {auditResultMeta(e.result).label}
                      </Badge>
                      <span className="fs-xs text-muted mono"> {e.result}</span>
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">详情</div>
                    <div className="desc-value">
                      {e.detail ? (
                        <pre className="log-viewer">{formatDetail(e.detail)}</pre>
                      ) : (
                        <span className="text-muted">无附加详情</span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}

          {items.length === 0 && total > 0 && search ? (
            <EmptyState
              compact
              title="本页没有匹配的记录"
              description="关键词过滤只作用于当前页，试试翻页或清除关键词。"
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
              第 {offset + 1} - {Math.min(offset + items.length, total)} 条，
              共 {total} 条记录
              {search ? `（本页过滤后显示 ${items.length} 条）` : ''}
            </div>
          ) : null}
        </>
      )}

      <CollapsibleCard title="审计日志的设计约定" icon={<IconShield size={15} />}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">记录范围</div>
            <div className="desc-value">
              所有经面板发起、且会改变集群状态的操作（电源、创建、删除、配置修改、
              快照、备份、迁移、用户变更、网络改造）都应写入审计表；
              纯查询操作默认不记录，避免日志膨胀。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">失败也要记</div>
            <div className="desc-value">
              被拒绝或执行失败的请求同样要落库，并写入失败原因。
              这是排查越权尝试的关键线索。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">记录 IP</div>
            <div className="desc-value">
              后端需从 <span className="mono">X-Forwarded-For</span> 或
              <span className="mono"> request.client.host</span> 取真实来源 IP；
              若面板部署在反向代理之后，务必正确配置代理头。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">不可篡改</div>
            <div className="desc-value">
              审计表只允许追加，不提供任何删除接口。
              如需归档，应导出到不可变存储而不是物理删除。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">前端分页</div>
            <div className="desc-value">
              本页采用服务端分页（limit / offset），关闭了 react-query 的占位保留，
              翻页时会显示骨架屏，保证 total 与 items 始终来自同一次查询。
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

/** 动作标识 → 中文标签 */
const ACTION_LABELS: Record<string, string> = {
  login: '登录',
  logout: '登出',
  login_failed: '登录失败',
  vm_start: '启动虚拟机',
  vm_stop: '停止虚拟机',
  vm_shutdown: '关闭虚拟机',
  vm_reboot: '重启虚拟机',
  vm_suspend: '挂起虚拟机',
  vm_resume: '恢复虚拟机',
  vm_create: '创建虚拟机',
  vm_clone: '克隆虚拟机',
  vm_delete: '删除虚拟机',
  vm_config: '修改配置',
  vm_resize: '调整磁盘',
  vm_move: '移动磁盘',
  vm_migrate: '迁移虚拟机',
  vm_template: '转为模板',
  snapshot_create: '创建快照',
  snapshot_rollback: '回滚快照',
  snapshot_delete: '删除快照',
  backup_create: '创建备份',
  backup_restore: '恢复备份',
  backup_delete: '删除备份',
  backup_job_create: '创建备份计划',
  backup_job_delete: '删除备份计划',
  storage_upload: '上传文件',
  storage_delete: '删除存储内容',
  network_create: '新增网络接口',
  network_update: '修改网络接口',
  network_delete: '删除网络接口',
  network_reload: '应用网络配置',
  user_create: '创建用户',
  user_update: '修改用户',
  user_delete: '删除用户',
  user_password: '重置密码',
  config_update: '修改连接配置',
  task_stop: '停止任务',
  task_remove: '清理任务记录',
};

/** 动作标识可能带前缀（vm.power.start）或下划线（vm_start），统一归一化 */
function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/\./g, '_').replace(/-/g, '_');
}

function actionLabel(action?: string | null): string {
  if (!action) return '未知动作';
  const key = normalizeAction(action);
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];

  /* 尝试只匹配动词部分：xxx_power_start → 看是否有后缀匹配 */
  const parts = key.split('_');
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const sub = parts.slice(i).join('_');
    if (ACTION_LABELS[sub]) return ACTION_LABELS[sub];
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
