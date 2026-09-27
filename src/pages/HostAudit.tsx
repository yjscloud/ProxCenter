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
import type { HostAuditCursor, HostLoginEntry, HostSudoEntry } from '../api/types';

type View = 'success' | 'failed' | 'sudo' | 'vm';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'success', label: '成功登录（last）' },
  { key: 'failed', label: '失败登录（lastb）' },
  { key: 'sudo', label: 'sudo / su 提权' },
  { key: 'vm', label: '虚拟机视角' },
];

export function HostAudit() {
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
      header: '账号',
      render: (row) => <span className="mono fs-sm">{row.user}</span>,
    },
    { key: 'tty', header: '终端', width: 110, render: (row) => row.tty || '—' },
    {
      key: 'ip',
      header: '来源',
      render: (row) =>
        row.ip ? <span className="mono fs-sm">{row.ip}</span> : <span className="text-muted fs-xs">本机</span>,
    },
    {
      key: 'start',
      header: '开始',
      width: 180,
      render: (row) => (row.start ? formatDateTime(row.start) : '—'),
    },
    {
      key: 'end',
      header: '结束 / 状态',
      width: 180,
      render: (row) =>
        row.end ? (
          formatDateTime(row.end) + (row.duration ? `（${row.duration}）` : '')
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
      header: '时间',
      width: 180,
      render: (row) => (row.ts ? formatDateTime(row.ts) : '—'),
    },
    { key: 'user', header: '提权人', render: (row) => <span className="mono fs-sm">{row.user || '—'}</span> },
    {
      key: 'target',
      header: '目标账号',
      width: 110,
      render: (row) => <span className="mono fs-sm">{row.target || '—'}</span>,
    },
    {
      key: 'ok',
      header: '结果',
      width: 90,
      render: (row) => (
        <Badge variant={row.success ? 'success' : 'danger'} size="sm">
          {row.success ? '成功' : '失败'}
        </Badge>
      ),
    },
    {
      key: 'command',
      header: '命令',
      render: (row) => <span className="mono fs-xs">{row.command || '—'}</span>,
    },
  ];

  const cursorColumns: Array<Column<HostAuditCursor>> = [
    { key: 'name', header: '主机', render: (row) => row.name },
    {
      key: 'last_ts',
      header: '已汇入到',
      render: (row) =>
        row.last_ts ? formatDateTime(row.last_ts) : <span className="text-muted fs-xs">尚未导入</span>,
    },
    {
      key: 'updated',
      header: '最近导入',
      render: (row) => (row.updated ? formatRelative(row.updated) : '—'),
    },
  ];

  const importNow = async () => {
    setBusy(true);
    try {
      const res = await hostAuditApi.importNow(hostId);
      toast.success(
        res.imported ? `已汇入 ${res.imported} 条` : '没有新的事件需要汇入',
        '写入面板审计日志：审计日志页可按 host.ssh_login / host.sudo 过滤',
      );
      await qc.invalidateQueries({ queryKey: ['host-audit'] });
      await qc.invalidateQueries({ queryKey: ['audit'] });
    } catch (err) {
      toast.error('汇入失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const current = view === 'sudo' ? sudoQuery.data : loginsQuery.data;

  return (
    <PageShell
      title="主机登录审计"
      subtitle={
        isAdmin
          ? 'last / lastb 登录历史、sudo 提权记录，并增量汇入面板审计日志'
          : '你添加的受管主机：登录历史、sudo 提权记录（面板本机仅管理员可见）'
      }
      actions={
        <div className="form-row">
          {canManage ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void importNow()}>
              汇入审计
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
            <IconRefresh size={14} /> 刷新
          </Button>
        </div>
      }
    >
      {!hostsQuery.isLoading && hosts.length === 0 ? (
        <Notice tone="info" title="没有可审计的主机">
          {isAdmin
            ? '还没有受管主机，到「SSH 安全 · 主机与告警配置」添加，或检查连接状态。'
            : '你名下还没有受管主机。受管主机由添加它的人维护，需要的话请联系管理员为你添加或指派。'}
        </Notice>
      ) : null}

      <Card collapsible={false}>
        <CardHeader
          title="作用域"
          subtitle={
            isAdmin
              ? '面板本机 + 受管远程主机（SSH）'
              : '你添加的受管远程主机（SSH）'
          }
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
                    ? [{ label: '本机（面板）', value: 'local' }]
                    : []
              }
              aria-label="选择主机"
            />
          }
        />
        <div className="tabs" role="tablist" aria-label="审计视图切换">
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
              {item.label}
            </button>
          ))}
        </div>

        <div className="tab-panel">
          {view === 'vm' ? (
            <div className="dyn-list">
              <div className="form-row">
                <Field label="虚拟机" hint="按它的 IP 匹配「这台机器登录过哪些主机」">
                  <Select
                    value={vmKey}
                    onChange={(e) => setVmKey(e.target.value)}
                    options={[
                      { label: '请选择虚拟机', value: '' },
                      ...vmOptions,
                    ]}
                  />
                </Field>
                <Field label="时间范围" hint="小时">
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
                  caption="以该虚拟机为来源的登录记录"
                  rows={vmQuery.data.entries}
                  columns={[
                    ...loginColumns,
                    {
                      key: 'host',
                      header: '目标主机',
                      width: 140,
                      render: (row) => row.host || '—',
                    },
                  ]}
                  rowKey={(row) => `${row.host_id}-${row.user}-${row.start}`}
                  loading={vmQuery.isLoading}
                  emptyTitle="这段时间没有匹配的登录记录"
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
                        placeholder="搜索账号 / 来源 IP / 终端"
                        prefix={<IconSearch size={15} />}
                        aria-label="搜索登录记录"
                      />
                    </div>
                    {keyword ? (
                      <Button size="sm" variant="ghost" onClick={() => setKeyword('')}>
                        <IconClose size={14} /> 清空
                      </Button>
                    ) : null}
                  </>
                )}

                <span className="fs-xs text-muted ha-meta">
                  {view === 'sudo'
                    ? `来自 auth.log / secure 的提权记录（最近 ${hours} 小时）`
                    : keyword
                      ? `匹配 ${matchedLogins.length} / 共 ${loginEntries.length} 条 · 只看当前已加载的记录`
                      : view === 'failed'
                        ? `btmp：失败的登录尝试（需要 root 读）· 共 ${loginEntries.length} 条`
                        : `wtmp：成功的登录历史（含开机记录）· 共 ${loginEntries.length} 条`}
                </span>

                {view === 'sudo' ? (
                  <Input
                    type="number"
                    min={1}
                    max={168}
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                    aria-label="时间范围（小时）"
                    style={{ width: 120 }}
                  />
                ) : null}
              </div>

              {current && !current.ok ? (
                <Notice tone="warning" title="读不到这台主机的记录">
                  {current.error}
                  <div className="fs-xs text-muted mt-8">
                    常见原因：非 root 用户没配 sudo NOPASSWD（lastb 需要读 /var/log/btmp），
                    或这台主机上没有 last / lastb 命令。
                  </div>
                </Notice>
              ) : null}

              {view === 'sudo' ? (
                <>
                  <Table
                    caption="sudo / su 提权记录"
                    rows={sudoPage.rows}
                    columns={sudoColumns}
                    rowKey={(row) => `${row.ts ?? 0}-${row.user}-${row.command}`}
                    loading={sudoQuery.isLoading}
                    emptyTitle="这段时间没有提权记录"
                  />
                  <PagerBar pager={sudoPage} />
                </>
              ) : (
                <>
                  <Table
                    caption="登录记录"
                    rows={loginPage.rows}
                    columns={loginColumns}
                    rowKey={(row) => `${row.user}-${row.tty}-${row.start ?? 0}`}
                    loading={loginsQuery.isLoading}
                    emptyTitle={keyword ? `没有匹配「${keyword}」的记录` : '没有登录记录'}
                    emptyDescription={
                      keyword
                        ? `已加载的 ${loginEntries.length} 条记录里没有命中，试试换个关键词或清空搜索。`
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
          title="汇入面板审计"
          subtitle="后台每 5 分钟自动增量汇入一次；这里可以看到各主机已汇入到什么时候"
          icon={<IconClock size={16} />}
        />
        <Table
          caption="导入进度"
          rows={cursorsQuery.data ?? []}
          columns={cursorColumns}
          rowKey={(row) => row.host_id}
          loading={cursorsQuery.isLoading}
        />
        <Notice tone="info">
          汇入的是「主机级」事件：SSH 登录成功 / 失败、sudo 与 su 提权，动作名分别是
          <span className="mono"> host.ssh_login</span> /<span className="mono"> host.ssh_failed</span> /
          <span className="mono"> host.sudo</span>，与面板自身的操作一起出现在「系统管理 → 审计日志」里。
          每台主机一个游标，重复汇入不会重复写；读取这些记录本身也会被记进审计（host_audit.read）。
        </Notice>
      </Card>
    </PageShell>
  );
}
