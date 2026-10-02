/* ==========================================================================
   ProxCenter — 主机登录审计

   两块内容：

   1. **原始登录记录**：``last``（成功）/ ``lastb``（失败）/ auth.log 里的
      sudo、su 提权 —— 直接读 wtmp / btmp 与日志，比翻 auth.log 更全。
   2. **汇入面板审计**：这些「主机级」事件按增量游标写进 audit_log，于是它们
      和面板自己的操作出现在同一张审计表里（在「系统管理 → 审计日志」里按
      host.ssh_login / host.ssh_failed / host.sudo 过滤即可看到）。

   主机范围 = 面板本机 + 受管远程主机（走 SSH），顶部切换。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hostAuditApi, vmsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { Notice } from '../components/ui/EmptyState';
import {
  IconAlert,
  IconClock,
  IconClose,
  IconKey,
  IconRefresh,
  IconSearch,
  IconServer,
  IconTerminal,
} from '../components/Icons';
import { formatDateTime, formatRelative } from '../utils/format';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useT, type MessageKey } from '../i18n';
import type { HostAuditCursor, HostLoginEntry, HostSudoEntry } from '../api/types';

type View = 'success' | 'failed' | 'sudo' | 'vm';

const VIEWS: Array<{ key: View; label: MessageKey }> = [
  { key: 'success', label: 'hostAudit.view.success' },
  { key: 'failed', label: 'hostAudit.view.failed' },
  { key: 'sudo', label: 'hostAudit.view.sudo' },
  { key: 'vm', label: 'hostAudit.view.vm' },
];

export function HostAudit() {
  const t = useT();
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission('ssh.manage');

  const [hostId, setHostId] = useState('local');
  const [view, setView] = useState<View>('success');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [vmKey, setVmKey] = useState('');   // "node/vmid"
  /** 成功 / 失败登录列表的本地搜索词（账号、来源 IP、终端、状态） */
  const [keyword, setKeyword] = useState('');

  const hostsQuery = useQuery({
    queryKey: ['host-audit', 'hosts'],
    queryFn: hostAuditApi.hosts,
    retry: false,
  });
  const cursorsQuery = useQuery({
    queryKey: ['host-audit', 'cursors'],
    queryFn: hostAuditApi.cursors,
    refetchInterval: 120_000,
    retry: false,
  });
  const loginsQuery = useQuery({
    queryKey: ['host-audit', 'logins', hostId, view],
    queryFn: () => hostAuditApi.logins(hostId, view === 'failed' ? 'failed' : 'success', 300),
    enabled: (view === 'success' || view === 'failed') && Boolean(hostId),
    retry: false,
  });
  const sudoQuery = useQuery({
    queryKey: ['host-audit', 'sudo', hostId, hours],
    queryFn: () => hostAuditApi.sudo(hostId, hours),
    enabled: view === 'sudo' && Boolean(hostId),
    retry: false,
  });
  const vmsQuery = useQuery({
    queryKey: ['vms', 'all'],
    queryFn: () => vmsApi.list(),
    enabled: view === 'vm',
    staleTime: 60_000,
  });
  const vmQuery = useQuery({
    queryKey: ['host-audit', 'vm', vmKey, hours],
    queryFn: () => {
      const [node, vmid] = vmKey.split('/');
      return hostAuditApi.vm(node, Number(vmid), hours);
    },
    enabled: view === 'vm' && Boolean(vmKey),
    retry: false,
  });

  const hosts = hostsQuery.data ?? [];

  /* 面板本机只有管理员能看；普通用户进来时把默认主机改到第一台自己的机器上，
     否则会拿着 'local' 去请求而直接 403（下拉里也不再出现本机）。 */
  useEffect(() => {
    if (isAdmin) return;
    if (hostId !== 'local') return;
    if (hostsQuery.isLoading) return;
    setHostId(hosts[0]?.id ?? '');
  }, [isAdmin, hostId, hosts, hostsQuery.isLoading]);
  const hostOptions = hosts.map((item) => ({ label: item.name, value: item.id }));
  const vms = (vmsQuery.data ?? []).filter((vm) => !vm.template);
  const vmOptions = vms.map((vm) => ({
    label: `${vm.name}（${vm.node}/${vm.vmid}）`,
    value: `${vm.node}/${vm.vmid}`,
  }));

  /* ---- 成功 / 失败登录的搜索 ----
     接口一次给回 300 条，在本地过滤即可（不用再打一次接口）：
     命中的字段是账号、来源 IP、终端、状态。 */
  const loginEntries = loginsQuery.data?.entries ?? [];
  const matchedLogins = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return loginEntries;
    return loginEntries.filter((row) =>
      [row.user, row.ip, row.tty, row.state, row.host]
        .filter((field) => field !== undefined && field !== null && field !== '')
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [loginEntries, keyword]);

  /* 换主机或换视图时清掉关键词：否则会带着上一台机器的过滤条件看到空表 */
  useEffect(() => {
    setKeyword('');
  }, [hostId, view]);

  /* last / lastb 一次给回最多 300 条，不翻页的话这一页能拖到近一万像素 */
  const loginPage = usePaged(matchedLogins, `${hostId}-${view}`);
  const sudoEntries = sudoQuery.data?.entries ?? [];
  const sudoPage = usePaged(sudoEntries, `${hostId}-${hours}`);

  const loginColumns: Array<Column<HostLoginEntry>> = [
    {
      key: 'user',
      header: t('hostAudit.colUser'),
      render: (row) => <span className="mono fs-sm">{row.user}</span>,
    },
    { key: 'tty', header: t('hostAudit.colTty'), width: 110, render: (row) => row.tty || '—' },
    {
      key: 'ip',
      header: t('hostAudit.colSource'),
      render: (row) =>
        row.ip ? <span className="mono fs-sm">{row.ip}</span> : <span className="text-muted fs-xs">{t('hostAudit.local')}</span>,
    },
    {
      key: 'start',
      header: t('hostAudit.colStart'),
      width: 180,
      render: (row) => (row.start ? formatDateTime(row.start) : '—'),
    },
    {
      key: 'end',
      header: t('hostAudit.colEndStatus'),
      width: 180,
      render: (row) =>
        row.end ? (
          formatDateTime(row.end) + (row.duration ? t('hostAudit.durationSuffix', { d: row.duration }) : '')
        ) : row.state ? (
          <Badge variant="success" size="sm">
            {row.state}
          </Badge>
        ) : (
          '—'
        ),
    },
  ];

  const sudoColumns: Array<Column<HostSudoEntry>> = [
    {
      key: 'ts',
      header: t('hostAudit.colTime'),
      width: 180,
      render: (row) => (row.ts ? formatDateTime(row.ts) : '—'),
    },
    { key: 'user', header: t('hostAudit.colSudoUser'), render: (row) => <span className="mono fs-sm">{row.user || '—'}</span> },
    {
      key: 'target',
      header: t('hostAudit.colTargetUser'),
      width: 110,
      render: (row) => <span className="mono fs-sm">{row.target || '—'}</span>,
    },
    {
      key: 'ok',
      header: t('hostAudit.colResult'),
      width: 90,
      render: (row) => (
        <Badge variant={row.success ? 'success' : 'danger'} size="sm">
          {row.success ? t('status.audit.success') : t('status.audit.failed')}
        </Badge>
      ),
    },
    {
      key: 'command',
      header: t('hostAudit.colCommand'),
      render: (row) => <span className="mono fs-xs">{row.command || '—'}</span>,
    },
  ];

  const cursorColumns: Array<Column<HostAuditCursor>> = [
    { key: 'name', header: t('hostAudit.colHost'), render: (row) => row.name },
    {
      key: 'last_ts',
      header: t('hostAudit.colImportedTo'),
      render: (row) =>
        row.last_ts ? formatDateTime(row.last_ts) : <span className="text-muted fs-xs">{t('hostAudit.notImported')}</span>,
    },
    {
      key: 'updated',
      header: t('hostAudit.colLastImport'),
      render: (row) => (row.updated ? formatRelative(row.updated) : '—'),
    },
  ];

  const importNow = async () => {
    setBusy(true);
    try {
      const res = await hostAuditApi.importNow(hostId);
      toast.success(
        res.imported ? t('hostAudit.imported', { n: res.imported }) : t('hostAudit.noNewEvents'),
        t('hostAudit.importDetail'),
      );
      await qc.invalidateQueries({ queryKey: ['host-audit'] });
      await qc.invalidateQueries({ queryKey: ['audit'] });
    } catch (err) {
      toast.error(t('hostAudit.importFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const current = view === 'sudo' ? sudoQuery.data : loginsQuery.data;

  return (
    <PageShell
      title={t('hostAudit.title')}
      subtitle={isAdmin ? t('hostAudit.subtitleAdmin') : t('hostAudit.subtitleUser')}
      actions={
        <div className="form-row">
          {canManage ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void importNow()}>
              {t('hostAudit.importNow')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            loading={loginsQuery.isFetching || sudoQuery.isFetching}
            onClick={() => {
              void loginsQuery.refetch();
              void sudoQuery.refetch();
              void cursorsQuery.refetch();
            }}
          >
            <IconRefresh size={14} /> {t('common.refresh')}
          </Button>
        </div>
      }
    >
      {!hostsQuery.isLoading && hosts.length === 0 ? (
        <Notice tone="info" title={t('hostAudit.noHostsTitle')}>
          {isAdmin ? t('hostAudit.noHostsAdmin') : t('hostAudit.noHostsUser')}
        </Notice>
      ) : null}

      <Card collapsible={false}>
        <CardHeader
          title={t('hostAudit.scopeTitle')}
          subtitle={isAdmin ? t('hostAudit.scopeAdmin') : t('hostAudit.scopeUser')}
          icon={<IconServer size={16} />}
          actions={
            <Select
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              options={
                hostOptions.length
                  ? hostOptions
                  : /* 兜底只给管理员：普通用户看不到本机，选了必 403 */
                    isAdmin
                    ? [{ label: t('hostAudit.localHost'), value: 'local' }]
                    : []
              }
              aria-label={t('hostAudit.selectHostAria')}
            />
          }
        />
        <div className="tabs" role="tablist" aria-label={t('hostAudit.viewAria')}>
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={view === item.key}
              className={`tab ${view === item.key ? 'is-active' : ''}`}
              onClick={() => setView(item.key)}
            >
              <span className="tab-icon" aria-hidden="true">
                {item.key === 'vm' ? (
                  <IconServer size={15} />
                ) : item.key === 'sudo' ? (
                  <IconKey size={15} />
                ) : item.key === 'failed' ? (
                  <IconAlert size={15} />
                ) : (
                  <IconTerminal size={15} />
                )}
              </span>
              {t(item.label)}
            </button>
          ))}
        </div>

        <div className="tab-panel">
          {view === 'vm' ? (
            <div className="dyn-list">
              <div className="form-row">
                <Field label={t('common.vm')} hint={t('hostAudit.vmFieldHint')}>
                  <Select
                    value={vmKey}
                    onChange={(e) => setVmKey(e.target.value)}
                    options={[
                      { label: t('hostAudit.selectVm'), value: '' },
                      ...vmOptions,
                    ]}
                  />
                </Field>
                <Field label={t('hostAudit.timeRange')} hint={t('hostAudit.hours')}>
                  <Input
                    type="number"
                    min={1}
                    max={168}
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                  />
                </Field>
              </div>
              {vmQuery.data?.note ? <Notice tone="warning">{vmQuery.data.note}</Notice> : null}
              {vmQuery.data && !vmQuery.data.note ? (
                <Table
                  caption={t('hostAudit.vmCaption')}
                  rows={vmQuery.data.entries}
                  columns={[
                    ...loginColumns,
                    {
                      key: 'host',
                      header: t('hostAudit.colTargetHost'),
                      width: 140,
                      render: (row) => row.host || '—',
                    },
                  ]}
                  rowKey={(row) => `${row.host_id}-${row.user}-${row.start}`}
                  loading={vmQuery.isLoading}
                  emptyTitle={t('hostAudit.vmEmpty')}
                />
              ) : null}
            </div>
          ) : (
            <>
              <div className="form-row">
                {view === 'sudo' ? null : (
                  <>
                    <div className="ha-search">
                      <Input
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        placeholder={t('hostAudit.searchPlaceholder')}
                        prefix={<IconSearch size={15} />}
                        aria-label={t('hostAudit.searchAria')}
                      />
                    </div>
                    {keyword ? (
                      <Button size="sm" variant="ghost" onClick={() => setKeyword('')}>
                        <IconClose size={14} /> {t('hostAudit.clear')}
                      </Button>
                    ) : null}
                  </>
                )}

                <span className="fs-xs text-muted ha-meta">
                  {view === 'sudo'
                    ? t('hostAudit.sudoMeta', { hours })
                    : keyword
                      ? t('hostAudit.matchMeta', {
                          matched: matchedLogins.length,
                          total: loginEntries.length,
                        })
                      : view === 'failed'
                        ? t('hostAudit.failedMeta', { n: loginEntries.length })
                        : t('hostAudit.successMeta', { n: loginEntries.length })}
                </span>

                {view === 'sudo' ? (
                  <Input
                    type="number"
                    min={1}
                    max={168}
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                    aria-label={t('hostAudit.timeRangeAria')}
                    style={{ width: 120 }}
                  />
                ) : null}
              </div>

              {current && !current.ok ? (
                <Notice tone="warning" title={t('hostAudit.readErrorTitle')}>
                  {current.error}
                  <div className="fs-xs text-muted mt-8">
                    {t('hostAudit.readErrorHint')}
                  </div>
                </Notice>
              ) : null}

              {view === 'sudo' ? (
                <>
                  <Table
                    caption={t('hostAudit.sudoCaption')}
                    rows={sudoPage.rows}
                    columns={sudoColumns}
                    rowKey={(row) => `${row.ts ?? 0}-${row.user}-${row.command}`}
                    loading={sudoQuery.isLoading}
                    emptyTitle={t('hostAudit.sudoEmpty')}
                  />
                  <PagerBar pager={sudoPage} />
                </>
              ) : (
                <>
                  <Table
                    caption={t('hostAudit.loginsCaption')}
                    rows={loginPage.rows}
                    columns={loginColumns}
                    rowKey={(row) => `${row.user}-${row.tty}-${row.start ?? 0}`}
                    loading={loginsQuery.isLoading}
                    emptyTitle={
                      keyword
                        ? t('hostAudit.noMatchKeyword', { keyword })
                        : t('hostAudit.noLogins')
                    }
                    emptyDescription={
                      keyword
                        ? t('hostAudit.noMatchDesc', { n: loginEntries.length })
                        : undefined
                    }
                  />
                  <PagerBar pager={loginPage} />
                </>
              )}
            </>
          )}
        </div>
      </Card>

      <Card collapsible={false}>
        <CardHeader
          title={t('hostAudit.importCardTitle')}
          subtitle={t('hostAudit.importCardSubtitle')}
          icon={<IconClock size={16} />}
        />
        <Table
          caption={t('hostAudit.cursorCaption')}
          rows={cursorsQuery.data ?? []}
          columns={cursorColumns}
          rowKey={(row) => row.host_id}
          loading={cursorsQuery.isLoading}
        />
        <Notice tone="info">
          {t('hostAudit.notePre')}
          <span className="mono">host.ssh_login</span> /<span className="mono">host.ssh_failed</span> /
          <span className="mono">host.sudo</span>
          {t('hostAudit.noteMid')}
        </Notice>
      </Card>
    </PageShell>
  );
}
