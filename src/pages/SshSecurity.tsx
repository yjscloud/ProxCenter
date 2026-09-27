/* ==========================================================================
   ProxCenter — SSH 登录安全（监测数据）

   数据分两种来源：
   * **本机**：面板直接读自己所在主机的日志与 fail2ban（见后端 sshguard）；
   * **受管主机**：面板用 SSH 凭据连上去执行固定几条命令，读回来后走同一套
     解析逻辑 —— 结构与本机完全一致，所以下面的表格可以复用。

   页面顶部是「作用域」切换（本机 / 某台受管主机），下面所有面板都跟着它走。

   主机凭据与告警策略**不在这里**：那些是偶尔改一次的配置，放在
   SshSecurityConfig（/ssh-security/config），免得把监测数据拖得很长。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sshApi, sshFleetApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge, TagList } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Notice } from '../components/ui/EmptyState';
import {
  IconAlert,
  IconClose,
  IconFilter,
  IconKey,
  IconLock,
  IconRefresh,
  IconServer,
  IconShield,
  IconTerminal,
} from '../components/Icons';
import { formatDateTime, formatRelative } from '../utils/format';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import type {
  Fail2banJail,
  FleetHost,
  SshFailureRow,
  SshKnownIp,
  SshLoginRow,
} from '../api/types';

/**
 * 作用域药丸的悬浮说明。
 *
 * 原来这些指标（失败 / 来源 IP / 成功登录 / fail2ban 状态）摊在一张「多机汇总」
 * 表格里，占了半屏却只是给人扫一眼。收进药丸的 title 后，页面短了，信息也没丢。
 */
function hostTooltip(name: string, subtitle: string, state?: FleetHost): string {
  const parts = [name, subtitle];
  if (!state) return [...parts, '暂无数据'].join(' · ');

  const { summary, fail2ban } = state;
  parts.push(
    `失败 ${summary.failures} · 来源 IP ${summary.distinct_ips} · 成功登录 ${summary.logins}`,
  );
  parts.push(
    fail2ban?.installed
      ? fail2ban.running
        ? `fail2ban ${fail2ban.jails.length} 个 jail`
        : 'fail2ban 未运行'
      : 'fail2ban 未安装',
  );
  if (!state.ok) parts.push('连接失败，点「测试」看原因');
  return parts.join(' · ');
}

export function SshSecurity() {
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission('ssh.manage');

  /* 作用域：'local' = 面板本机，其它 = 受管主机 id */
  const [scopeId, setScopeId] = useState('local');
  const [busy, setBusy] = useState(false);
  const [banIp, setBanIp] = useState('');
  const [jailDraft, setJailDraft] = useState({
    jail: '',
    maxretry: 5,
    findtime: 600,
    bantime: 3600,
  });
  /** 自定义封禁策略是低频 + 写配置的高危操作，默认收起来 */
  const [showJailForm, setShowJailForm] = useState(false);

  /* ---- 本机 ----
     面板本机的数据只有管理员能读（后端按归属隔离），所以这里直接按身份关掉，
     免得普通用户一进页面就吃三个 403。 */
  const overviewQuery = useQuery({
    queryKey: ['ssh', 'overview'],
    queryFn: () => sshApi.overview(),
    enabled: isAdmin,
    refetchInterval: 60_000,
    retry: false,
  });
  const loginsQuery = useQuery({
    queryKey: ['ssh', 'logins'],
    queryFn: () => sshApi.logins(100),
    enabled: isAdmin,
    retry: false,
  });
  const knownQuery = useQuery({
    queryKey: ['ssh', 'known-ips'],
    queryFn: sshApi.knownIps,
    enabled: isAdmin,
    retry: false,
  });

  /* ---- 多机 ---- */
  const fleetQuery = useQuery({
    queryKey: ['ssh', 'fleet'],
    queryFn: () => sshFleetApi.overview(),
    refetchInterval: 120_000,
    retry: false,
  });
  const hostsQuery = useQuery({
    queryKey: ['ssh', 'hosts'],
    queryFn: sshFleetApi.hosts,
    retry: false,
  });

  const local = overviewQuery.data;
  const fleet = fleetQuery.data;
  const hosts = hostsQuery.data ?? [];

  /* 本机也伪装成一台「受管主机」：下面所有面板都只认 FleetHost 这一种形状 */
  const localHost: FleetHost | null = local
    ? {
        id: 'local',
        name: local.report.source.host || '本机（面板）',
        host: local.report.source.host || 'localhost',
        ok: local.report.source.available,
        error: local.report.source.available ? '' : local.report.source.detail,
        source: local.report.source,
        summary: local.report.summary,
        top_ips: local.report.top_ips,
        fail2ban: local.fail2ban,
      }
    : null;

  /* 普通用户看不到本机：作用域默认落到第一台自己的受管主机上。
     （本机那一项只有管理员才有，见下面的 scopePills。） */
  useEffect(() => {
    if (isAdmin) return;
    if (scopeId !== 'local') return;
    const first = hosts.find((row) => row.enabled);
    if (first) setScopeId(first.id);
  }, [isAdmin, hosts, scopeId]);

  const fleetById = new Map((fleet?.hosts ?? []).map((item) => [item.id, item]));

  /* 当前作用域的数据：远程直接从 fleet 里取，本机走本机接口 */
  const current: FleetHost | null =
    scopeId === 'local'
      ? localHost
      : (fleetById.get(scopeId) ?? null);

  const policy = local?.policy ?? null;
  const jail = current?.fail2ban?.preferred || '';
  const windowHours = local?.window_hours ?? policy?.window_hours ?? 24;

  /* 当前作用域的封禁汇总 */
  const jails: Fail2banJail[] = current?.fail2ban?.details ?? [];
  const bannedNow = jails.reduce((sum, item) => sum + item.currently_banned, 0);
  const bannedTotal = jails.reduce((sum, item) => sum + item.total_banned, 0);

  /* 作用域切换条：本机固定排第一，其余只列「已启用」的主机
     （与旧的下拉框可选范围一致），状态与失败数取多机汇总里的最新值 */
  const scopePills = [
    /* 本机只有管理员能看：后端按归属隔离，普通用户拿到 'local' 只会 403 */
    ...(isAdmin
      ? [
          {
            id: 'local',
            name: '本机',
            title: hostTooltip(
              localHost?.name ?? '本机',
              '面板所在主机',
              localHost ?? undefined,
            ),
            ok: localHost?.ok ?? null,
            failures: local ? local.report.summary.failures : null,
          },
        ]
      : []),
    ...hosts
      .filter((row) => row.enabled)
      .map((row) => {
        const state = fleetById.get(row.id);
        return {
          id: row.id,
          name: row.name || row.host,
          title: hostTooltip(
            row.name || row.host,
            `${row.username}@${row.host}:${row.port}`,
            state,
          ),
          ok: state?.ok ?? null,
          failures: state?.summary.failures ?? null,
        };
      }),
  ];

  useEffect(() => {
    if (jail && !jailDraft.jail) setJailDraft((prev) => ({ ...prev, jail }));
  }, [jail, jailDraft.jail]);

  const refreshAll = () => {
    void overviewQuery.refetch();
    void fleetQuery.refetch();
    void hostsQuery.refetch();
    void loginsQuery.refetch();
    void knownQuery.refetch();
  };

  /* --------------------------------------------------------------- 操作 */

  const invalidateSsh = () => qc.invalidateQueries({ queryKey: ['ssh'] });

  const checkNow = async () => {
    setBusy(true);
    try {
      const res = await sshApi.check();
      toast.success(
        res.count ? `命中 ${res.count} 条异常` : '检查完成，没有新的异常',
        res.count ? '已按策略推送通知（含受管主机）' : undefined,
      );
      refreshAll();
    } catch (err) {
      toast.error('检查失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ban = async (ip: string) => {
    if (!jail) {
      toast.warning('没有可用的 fail2ban jail', '该主机上先安装并启用 fail2ban');
      return;
    }
    setBusy(true);
    try {
      await sshFleetApi.ban(scopeId, jail, ip);
      toast.success(`已封禁 ${ip}`, `${current?.name} · jail ${jail}`);
      await invalidateSsh();
    } catch (err) {
      toast.error('封禁失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unban = async (ip: string, jailName: string) => {
    setBusy(true);
    try {
      await sshFleetApi.unban(scopeId, jailName, ip);
      toast.success(`已解封 ${ip}`, current?.name);
      await invalidateSsh();
    } catch (err) {
      toast.error('解封失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveJail = async () => {
    setBusy(true);
    try {
      const res = await sshFleetApi.saveJail(scopeId, jailDraft);
      toast.success('封禁策略已写入并重载', res.path);
      await invalidateSsh();
    } catch (err) {
      toast.error('写入失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const trust = async (ip: string) => {
    setBusy(true);
    try {
      await sshApi.trustIp(ip, '面板标记为已知');
      toast.success(`已把 ${ip} 标记为已知`);
      await invalidateSsh();
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (ip: string) => {
    setBusy(true);
    try {
      await sshApi.forgetIp(ip);
      toast.success(`已取消 ${ip} 的已知标记`);
      await invalidateSsh();
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------------------------------------------- 表格 */

  /** 这个地址当前在哪个 jail 里被封着（不在任何 jail 里返回空串） */
  const bannedJail = (ip: string) =>
    jails.find((item) => item.banned_ips.includes(ip))?.jail ?? '';

  const failureColumns: Array<Column<SshFailureRow>> = [
    {
      key: 'ip',
      header: '来源 IP',
      width: 186,
      render: (row) => {
        const inJail = bannedJail(row.ip);
        return (
          <span className="ssh-ip-cell">
            <span className="mono fs-sm">{row.ip}</span>
            {inJail ? (
              <Badge variant="danger" size="sm" title={`已在 jail ${inJail} 中被封禁`}>
                已封禁
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'count',
      header: '失败次数',
      width: 84,
      align: 'right',
      render: (row) => (
        <Badge
          variant={
            policy && row.count >= policy.max_failures
              ? 'danger'
              : row.count >= 5
                ? 'warning'
                : 'neutral'
          }
          size="sm"
          title={`告警阈值 ${policy?.max_failures ?? '-'}`}
        >
          {row.count}
        </Badge>
      ),
    },
    {
      key: 'users',
      header: '尝试的用户名',
      render: (row) => (
        <span className="mono">
          <TagList tags={row.users} max={2} />
        </span>
      ),
    },
    {
      key: 'last',
      header: '最近一次',
      width: 96,
      render: (row) => (
        <span className="fs-sm" title={formatDateTime(row.last_ts)}>
          {formatRelative(row.last_ts)}
        </span>
      ),
    },
    {
      key: 'ops',
      header: '操作',
      width: 168,
      align: 'right',
      render: (row) => {
        if (!canManage) return <span className="fs-xs text-muted">只读</span>;
        const inJail = bannedJail(row.ip);
        return (
          <span className="row-actions">
            {/* 已经封着的地址，按钮直接变成「解封」——省掉「先去上面找它」这一步 */}
            {inJail ? (
              <Button
                size="sm"
                variant="ghost"
                className="ssh-ban-btn"
                disabled={busy}
                title={`从 jail ${inJail} 解封 ${row.ip}`}
                onClick={() => void unban(row.ip, inJail)}
              >
                解封
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="ssh-ban-btn"
                disabled={busy || !jail}
                title={jail ? `封禁 ${row.ip} 到 jail ${jail}` : '该主机没有可用的 jail'}
                onClick={() => void ban(row.ip)}
              >
                <IconLock size={14} /> 封禁
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={`把 ${row.ip} 标记为可信，之后不再算「陌生 IP」`}
              onClick={() => void trust(row.ip)}
            >
              标记可信
            </Button>
          </span>
        );
      },
    },
  ];


  const knownColumns: Array<Column<SshKnownIp>> = [
    { key: 'ip', header: 'IP', width: 150, render: (row) => <span className="mono fs-sm">{row.ip}</span> },
    {
      key: 'hits',
      header: '登录次数',
      width: 90,
      align: 'right',
      render: (row) => (typeof row.hits === 'number' ? row.hits.toLocaleString('zh-CN') : '—'),
    },
    { key: 'last_seen', header: '最近登录', width: 120, render: (row) => formatRelative(row.last_seen) },
    { key: 'note', header: '备注', render: (row) => row.note || '—' },
    {
      key: 'ops',
      header: '',
      width: 96,
      align: 'right',
      render: (row) => (
        <span className="row-actions">
          {canManage ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void forget(row.ip)}
            >
              取消标记
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const loginColumns: Array<Column<SshLoginRow>> = [
    {
      key: 'ts',
      header: '时间',
      width: 145,
      render: (row) => <span className="fs-sm">{formatDateTime(row.ts)}</span>,
    },
    {
      key: 'username',
      header: '用户',
      render: (row) => <span className="mono fs-sm">{row.username}</span>,
    },
    {
      key: 'ip',
      header: '来源 IP',
      width: 190,
      render: (row) => (
        <span className="ssh-ip-cell">
          <span className="mono fs-sm">{row.ip}</span>
          {row.new_ip ? (
            <Badge variant="warning" size="sm" title="该地址第一次出现">
              陌生
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'method', header: '认证方式', width: 90, render: (row) => row.method || '—' },
    {
      key: 'ops',
      header: '',
      width: 120,
      align: 'right',
      render: (row) => (
        <span className="row-actions">
          {canManage ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={`把 ${row.ip} 标记为可信，之后不再算「陌生 IP」`}
              onClick={() => void trust(row.ip)}
            >
              标记可信
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  /* --------------------------------------------------------------- 渲染 */

  const scopeLoading = overviewQuery.isLoading || fleetQuery.isLoading;

  const failures = current?.top_ips ?? [];
  const logins = loginsQuery.data?.logins ?? [];
  const knownIps = knownQuery.data ?? [];

  /* 三张长表格各自分页：失败排行最多 50 条、登录明细 100 条、已知 IP 不封顶，
     不分页时这一页能拖到几千像素。每页条数可在分页条上随时调整。 */
  const failurePage = usePaged(failures, scopeId);
  const loginPage = usePaged(logins, scopeId);
  const knownPage = usePaged(knownIps, scopeId);

  return (
    <PageShell
      title="SSH 登录安全"
      subtitle="本机日志统计 + 受管远程主机（SSH）统一采集、封禁与告警"
      actions={
        <div className="form-row">
          {canManage ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void checkNow()}>
              立即检测
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" loading={fleetQuery.isFetching} onClick={refreshAll}>
            <IconRefresh size={14} /> 刷新
          </Button>
        </div>
      }
    >
      {/* 监测数据 / 配置分成两个页面：配置是偶尔改一次的东西，混在这里会把
          滚动数据拖得很长，也容易被当成只读区块划过去。 */}
      <div className="subnav">
        <Link className="subnav-item" to="/ssh-security/config">
          <IconServer size={14} /> 主机与告警配置
        </Link>
        <span className="subnav-item is-active" aria-current="page">
          <IconTerminal size={14} /> 监测数据
        </span>
      </div>

      {/* ---------------- 当前主机监测 ---------------- */}
      <div className="section-block">
        <div className="section-title">
          <IconTerminal size={15} />
          <span className="section-name">当前主机监测</span>
          <span className="section-hint">失败来源与 fail2ban 都跟随下面的作用域</span>
        </div>

        <div className="ssh-scope-bar">
          <span className="ssh-scope-label">作用域</span>
          <div className="ssh-pills">
            {scopePills.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ssh-pill ${scopeId === item.id ? 'is-active' : ''}`}
                title={item.title}
                aria-pressed={scopeId === item.id}
                onClick={() => setScopeId(item.id)}
              >
                <span
                  className={`ssh-pill-dot ${item.ok === false ? 'is-down' : ''}`}
                  aria-hidden="true"
                />
                <span className="ssh-pill-name">{item.name}</span>
                {item.failures ? (
                  <span className="ssh-pill-count">
                    {item.failures.toLocaleString('zh-CN')}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <span className="ssh-scope-meta">
            {fleet ? (
              <Badge
                variant={
                  fleet.totals.reachable === fleet.totals.hosts ? 'success' : 'danger'
                }
                size="sm"
                dot
              >
                {fleet.totals.reachable}/{fleet.totals.hosts} 台可达
              </Badge>
            ) : null}
            {local?.report.generated_at
              ? `检查于 ${formatRelative(local.report.generated_at)}`
              : ''}
          </span>
        </div>

        <div className="grid grid-4">
          <KpiCard
            label="失败尝试"
            value={(current?.summary.failures ?? 0).toLocaleString('zh-CN')}
            tone="danger"
            icon={<IconAlert size={15} />}
            hint={`近 ${windowHours} 小时`}
            loading={scopeLoading}
          />
          <KpiCard
            label="失败来源 IP"
            value={(current?.summary.distinct_ips ?? 0).toLocaleString('zh-CN')}
            icon={<IconFilter size={15} />}
            hint={`${current?.summary.distinct_users ?? 0} 个用户名被尝试`}
            loading={scopeLoading}
          />
          <KpiCard
            label="成功登录"
            value={(current?.summary.logins ?? 0).toLocaleString('zh-CN')}
            tone="success"
            icon={<IconKey size={15} />}
            hint={scopeId === 'local' ? '明细见下方「本机数据」' : '远程主机只统计次数'}
            loading={scopeLoading}
          />
          <KpiCard
            label="封禁中"
            value={bannedNow.toLocaleString('zh-CN')}
            tone="warning"
            icon={<IconLock size={15} />}
            hint={`累计封禁 ${bannedTotal.toLocaleString('zh-CN')}`}
            loading={scopeLoading}
          />
        </div>

        {current && !current.ok ? (
          <Notice tone="warning" title={`${current.name} 读不到数据`}>
            {current.error || '未知原因'}
            {scopeId !== 'local' ? (
              <div className="fs-xs text-muted mt-8">
                常见原因：SSH 没连上（指纹未确认 / 凭据错误 / 端口不通）、sudo 没配 NOPASSWD、
                或者该主机上既没有 journalctl 也没有 auth.log / secure。
                到「主机与告警配置」里点「测试」能看到具体报错。
              </div>
            ) : null}
          </Notice>
        ) : null}

        {!current && !scopeLoading ? (
          <Notice tone="warning" title="这台主机的数据取不到">
            它可能已被移除或停用。点上面其它主机，或到「主机与告警配置」里检查配置。
          </Notice>
        ) : null}

        {/* ---------------- 失败来源 + fail2ban（宽屏并排） ---------------- */}
        <div className="split-panel is-balanced">
        <Card collapsible={false}>
          <CardHeader
            title={`登录失败来源（${failures.length}）`}
            subtitle={`${current?.name || '当前主机'} · 近 ${windowHours} 小时，按失败次数倒序`}
            icon={<IconAlert size={16} />}
          />
          <Table
            caption="SSH 登录失败来源"
            rows={failurePage.rows}
            columns={failureColumns}
            rowKey={(row) => row.ip}
            loading={scopeLoading}
            dense
            emptyTitle="这段窗口内没有失败的登录尝试"
            emptyDescription={
              current?.ok === false ? '主机读不到数据，先解决上面的连接问题' : undefined
            }
          />
          <PagerBar pager={failurePage} />
        </Card>

        {/* ---------------- fail2ban ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title="fail2ban 封禁管理"
            subtitle={
              current?.fail2ban?.installed
                ? `${current.name} · ${current.fail2ban.jails.length || 0} 个 jail`
                : `${current?.name || '当前主机'}：未检测到 fail2ban`
            }
            icon={<IconLock size={16} />}
            actions={
              canManage && current?.fail2ban?.running ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowJailForm((v) => !v)}
                >
                  {showJailForm ? '收起封禁策略' : '自定义封禁策略'}
                </Button>
              ) : null
            }
          />

          {current?.fail2ban && !current.fail2ban.installed ? (
            <Notice
              tone="info"
              title={`未检测到 fail2ban（${current.fail2ban.host || current.name}）`}
            >
              {current.fail2ban.hint}
            </Notice>
          ) : null}

          {current?.fail2ban?.installed && !current.fail2ban.running ? (
            <Notice tone="warning" title="fail2ban 没在运行">
              {current.fail2ban.hint}
            </Notice>
          ) : null}

          {jails.length ? (
            <div>
              {jails.map((item) => (
                <div
                  key={item.jail}
                  className={`ssh-jail ${item.currently_banned > 0 ? 'is-blocking' : ''}`}
                >
                  <div className="ssh-jail-head">
                    <span className="ssh-jail-name">{item.jail}</span>
                    {item.jail === current?.fail2ban?.preferred ? (
                      <Badge variant="accent" size="sm">
                        默认操作对象
                      </Badge>
                    ) : null}
                    {item.managed_config ? (
                      <Badge variant="neutral" size="sm" title={item.managed_config}>
                        面板托管
                      </Badge>
                    ) : null}
                    <span className="ssh-jail-stats">
                      <span>
                        当前封禁 <b>{item.currently_banned}</b>
                      </span>
                      <span>
                        累计封禁 <b>{item.total_banned}</b>
                      </span>
                      <span>
                        当前失败 <b>{item.currently_failed}</b>
                      </span>
                      <span>
                        累计失败 <b>{item.total_failed}</b>
                      </span>
                    </span>
                  </div>

                  {item.banned_ips.length ? (
                    <div className="ssh-ip-chips">
                      {item.banned_ips.map((ip) => (
                        <span key={ip} className="ssh-ip-chip">
                          <span className="mono">{ip}</span>
                          {canManage ? (
                            <button
                              type="button"
                              className="ssh-ip-chip-x"
                              disabled={busy}
                              aria-label={`解封 ${ip}`}
                              title={`解封 ${ip}`}
                              onClick={() => void unban(ip, item.jail)}
                            >
                              <IconClose size={12} />
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="ssh-jail-empty">当前没有封禁中的地址</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {canManage && current?.fail2ban?.installed && current.fail2ban.running ? (
            <>
              <div className="ssh-ban-bar">
                <IconLock size={15} />
                <span className="fw-500 fs-sm">手动封禁</span>
                <Input
                  value={banIp}
                  onChange={(e) => setBanIp(e.target.value)}
                  placeholder="1.2.3.4"
                  mono
                  aria-label="要封禁的 IP"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && banIp.trim() && jail) {
                      void ban(banIp.trim());
                      setBanIp('');
                    }
                  }}
                />
                <span className="ssh-ban-bar-hint">
                  {jail ? `加入 jail ${jail}` : '先启用一个 jail'}
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  disabled={!banIp.trim() || !jail}
                  onClick={() => {
                    void ban(banIp.trim());
                    setBanIp('');
                  }}
                >
                  封禁
                </Button>
              </div>

              {showJailForm ? (
                <div className="create-bar">
                  <div className="ssh-advanced-head">
                    <strong>自定义封禁策略</strong>
                    <span>
                      写入 /etc/fail2ban/jail.d/panel-
                      {jailDraft.jail || '<jail>'}.local 并重载 fail2ban
                    </span>
                  </div>
                  <div className="field-row">
                    <Field label="jail 名称" hint="要覆盖的 jail，通常为 sshd">
                      <Input
                        value={jailDraft.jail}
                        onChange={(e) => setJailDraft({ ...jailDraft, jail: e.target.value })}
                        placeholder="sshd"
                        mono
                      />
                    </Field>
                    <Field label="失败次数" hint="maxretry">
                      <Input
                        type="number"
                        min={1}
                        value={jailDraft.maxretry}
                        onChange={(e) =>
                          setJailDraft({ ...jailDraft, maxretry: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="统计窗口（秒）" hint="findtime">
                      <Input
                        type="number"
                        min={60}
                        value={jailDraft.findtime}
                        onChange={(e) =>
                          setJailDraft({ ...jailDraft, findtime: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="封禁时长（秒）" hint="bantime">
                      <Input
                        type="number"
                        min={60}
                        value={jailDraft.bantime}
                        onChange={(e) =>
                          setJailDraft({ ...jailDraft, bantime: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Button variant="primary" loading={busy} onClick={() => void saveJail()}>
                      保存并重载
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </Card>
        </div>
      </div>

      {/* ---------------- 本机数据（与作用域无关） ---------------- */}
      <div className="section-block">
        <div className="section-title">
          <IconTerminal size={15} />
          <span className="section-name">本机数据</span>
          <span className="section-hint">
            不随上面的作用域切换 —— 面板只能读自己所在主机
          </span>
        </div>

        <div className="split-panel is-even is-balanced">
        <Card collapsible={false}>
          <CardHeader
            title={`成功登录记录（${logins.length}）`}
            subtitle="远程主机只做统计告警，登录明细只记本机"
            icon={<IconKey size={16} />}
          />
          <Table
            caption="SSH 成功登录"
            rows={loginPage.rows}
            columns={loginColumns}
            rowKey={(row) => String(row.id ?? `${row.ip}-${row.ts}`)}
            loading={loginsQuery.isLoading}
            dense
            emptyTitle="还没有记录"
            emptyDescription="面板每次检查时会把本机的成功登录落库"
          />
          <PagerBar pager={loginPage} />
        </Card>

        <Card collapsible={false}>
          <CardHeader
            title={`已知 IP（${knownIps.length}）`}
            subtitle="这些地址登录成功不再算「陌生 IP」"
            icon={<IconShield size={16} />}
          />
          <Table
            caption="已知 IP"
            rows={knownPage.rows}
            columns={knownColumns}
            rowKey={(row) => row.ip}
            loading={knownQuery.isLoading}
            dense
            emptyTitle="还没有已知 IP"
            emptyDescription="在「登录失败来源」里点「标记可信」，或在上面的登录记录里点，就会加到这儿"
          />
          <PagerBar pager={knownPage} />
        </Card>
        </div>
      </div>

    </PageShell>
  );
}
