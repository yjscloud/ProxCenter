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
import { Field, Input, Select, type SelectOptionItem } from '../components/ui/Input';
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
import { formatDateTime, formatNumber, formatRelative } from '../utils/format';
import { PagerBar, usePaged } from '../hooks/usePaged';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { LocalHostNotice, useLocalHost } from '../components/LocalHostNotice';
import { useT } from '../i18n';
import type {
  Fail2banJail,
  FleetHost,
  SshFailureRow,
  SshKnownIp,
  SshLoginRow,
} from '../api/types';

export function SshSecurity() {
  const t = useT();
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission('ssh.manage');

  /* 面板本机是否已导入 —— 未导入时作用域里不出现本机，默认落到受管主机上 */
  const localHostInfo = useLocalHost();
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
     本机数据只有管理员能读（后端按归属隔离），而且**必须已导入**（未导入是 409）。
     两个条件不满足就不发请求，免得一进页面就吃三个错误。 */
  const localReady = isAdmin && localHostInfo.enabled;
  const overviewQuery = useQuery({
    queryKey: ['ssh', 'overview'],
    queryFn: () => sshApi.overview(),
    enabled: localReady,
    refetchInterval: 60_000,
    retry: false,
  });
  const loginsQuery = useQuery({
    queryKey: ['ssh', 'logins'],
    queryFn: () => sshApi.logins(100),
    enabled: localReady,
    retry: false,
  });
  const knownQuery = useQuery({
    queryKey: ['ssh', 'known-ips'],
    queryFn: sshApi.knownIps,
    enabled: localReady,
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
        name: local.report.source.host || t('ssh.localPanelName'),
        host: local.report.source.host || 'localhost',
        ok: local.report.source.available,
        error: local.report.source.available ? '' : local.report.source.detail,
        source: local.report.source,
        summary: local.report.summary,
        top_ips: local.report.top_ips,
        fail2ban: local.fail2ban,
      }
    : null;

  /* 作用域的落点。本机要**已导入**才可用（默认不管控本机，见 LocalHostNotice）：
     * 状态还没拿到先不动 —— 否则会先跳到受管主机、等本机状态回来又不跳回去；
     * 本机可用就保持用户的选择；不可用则落到第一台已启用的受管主机上。 */
  useEffect(() => {
    if (isAdmin && !localHostInfo.state) return;
    if (scopeId !== 'local') return;
    if (isAdmin && localHostInfo.enabled) return;
    const first = hosts.find((row) => row.enabled);
    setScopeId(first ? first.id : '');
  }, [isAdmin, localHostInfo.state, localHostInfo.enabled, hosts, scopeId]);

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

  /* 作用域下拉的选项：本机固定排第一，其余只列「已启用」的主机 ——
     与「端口与进程 / 安全基线 / 登录审计」三页的主机选择器同一个口径，
     几台主机时下拉比一排药丸更省地方，也不会把标题挤到第二行。 */
  const scopeOptions: SelectOptionItem[] = [
    /* 本机要**已导入**且是管理员才出现：普通用户拿到 'local' 只会 403，
       未导入时更是 409 */
    ...(isAdmin && localHostInfo.enabled
      ? [{ value: 'local', label: t('ssh.localName') }]
      : []),
    ...hosts
      .filter((row) => row.enabled)
      .map((row) => ({ value: row.id, label: row.name || row.host })),
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
        res.count ? t('ssh.checkHits', { n: res.count }) : t('ssh.checkDone'),
        res.count ? t('ssh.checkPushed') : undefined,
      );
      refreshAll();
    } catch (err) {
      toast.error(t('ssh.checkFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ban = async (ip: string) => {
    if (!jail) {
      toast.warning(t('ssh.noJailTitle'), t('ssh.noJailHint'));
      return;
    }
    setBusy(true);
    try {
      await sshFleetApi.ban(scopeId, jail, ip);
      toast.success(
        t('ssh.bannedDone', { ip }),
        t('ssh.bannedDetail', { name: current?.name ?? '', jail }),
      );
      await invalidateSsh();
    } catch (err) {
      toast.error(t('ssh.banFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const unban = async (ip: string, jailName: string) => {
    setBusy(true);
    try {
      await sshFleetApi.unban(scopeId, jailName, ip);
      toast.success(t('ssh.unbannedDone', { ip }), current?.name);
      await invalidateSsh();
    } catch (err) {
      toast.error(t('ssh.unbanFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveJail = async () => {
    setBusy(true);
    try {
      const res = await sshFleetApi.saveJail(scopeId, jailDraft);
      toast.success(t('ssh.jailSaved'), res.path);
      await invalidateSsh();
    } catch (err) {
      toast.error(t('ssh.jailSaveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const trust = async (ip: string) => {
    setBusy(true);
    try {
      await sshApi.trustIp(ip, t('ssh.trustNote'));
      toast.success(t('ssh.trusted', { ip }));
      await invalidateSsh();
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (ip: string) => {
    setBusy(true);
    try {
      await sshApi.forgetIp(ip);
      toast.success(t('ssh.untrusted', { ip }));
      await invalidateSsh();
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
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
      header: t('ssh.colIp'),
      width: 186,
      render: (row) => {
        const inJail = bannedJail(row.ip);
        return (
          <span className="ssh-ip-cell">
            <span className="mono fs-sm">{row.ip}</span>
            {inJail ? (
              <Badge variant="danger" size="sm" title={t('ssh.bannedInJail', { jail: inJail })}>
                {t('ssh.banned')}
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'count',
      header: t('ssh.colCount'),
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
          title={t('ssh.thresholdTitle', { n: policy?.max_failures ?? '-' })}
        >
          {row.count}
        </Badge>
      ),
    },
    {
      key: 'users',
      header: t('ssh.colUsers'),
      render: (row) => (
        <span className="mono">
          <TagList tags={row.users} max={2} />
        </span>
      ),
    },
    {
      key: 'last',
      header: t('ssh.colLast'),
      width: 96,
      render: (row) => (
        <span className="fs-sm" title={formatDateTime(row.last_ts)}>
          {formatRelative(row.last_ts)}
        </span>
      ),
    },
    {
      key: 'ops',
      header: t('common.actions'),
      width: 168,
      align: 'right',
      render: (row) => {
        if (!canManage) return <span className="fs-xs text-muted">{t('sshConfig.readOnly')}</span>;
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
                title={t('ssh.unbanTitle', { jail: inJail, ip: row.ip })}
                onClick={() => void unban(row.ip, inJail)}
              >
                {t('ssh.unban')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="ssh-ban-btn"
                disabled={busy || !jail}
                title={jail ? t('ssh.banTitle', { ip: row.ip, jail }) : t('ssh.noJail')}
                onClick={() => void ban(row.ip)}
              >
                <IconLock size={14} /> {t('ssh.ban')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={t('ssh.trustTitle', { ip: row.ip })}
              onClick={() => void trust(row.ip)}
            >
              {t('ssh.trust')}
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
      header: t('ssh.colHits'),
      width: 90,
      align: 'right',
      render: (row) => (typeof row.hits === 'number' ? formatNumber(row.hits) : '—'),
    },
    { key: 'last_seen', header: t('ssh.colLastSeen'), width: 120, render: (row) => formatRelative(row.last_seen) },
    { key: 'note', header: t('incident.fieldNote'), render: (row) => row.note || '—' },
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
              {t('ssh.untrust')}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const loginColumns: Array<Column<SshLoginRow>> = [
    {
      key: 'ts',
      header: t('ssh.colTime'),
      width: 145,
      render: (row) => <span className="fs-sm">{formatDateTime(row.ts)}</span>,
    },
    {
      key: 'username',
      header: t('ssh.colUser'),
      render: (row) => <span className="mono fs-sm">{row.username}</span>,
    },
    {
      key: 'ip',
      header: t('ssh.colIp'),
      width: 190,
      render: (row) => (
        <span className="ssh-ip-cell">
          <span className="mono fs-sm">{row.ip}</span>
          {row.new_ip ? (
            <Badge variant="warning" size="sm" title={t('ssh.newIpTitle')}>
              {t('ssh.newIp')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'method', header: t('sshConfig.fieldAuth'), width: 90, render: (row) => row.method || '—' },
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
              title={t('ssh.trustTitle', { ip: row.ip })}
              onClick={() => void trust(row.ip)}
            >
              {t('ssh.trust')}
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
      title={t('ssh.title')}
      subtitle={t('ssh.subtitle')}
      actions={
        <div className="form-row">
          {canManage ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void checkNow()}>
              {t('ssh.checkNow')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" loading={fleetQuery.isFetching} onClick={refreshAll}>
            <IconRefresh size={14} /> {t('common.refresh')}
          </Button>
        </div>
      }
    >
      {/* 监测数据 / 配置分成两个页面：配置是偶尔改一次的东西，混在这里会把
          滚动数据拖得很长，也容易被当成只读区块划过去。 */}
      <div className="subnav">
        <Link className="subnav-item" to="/ssh-security/config">
          <IconServer size={14} /> {t('sshConfig.title')}
        </Link>
        <span className="subnav-item is-active" aria-current="page">
          <IconTerminal size={14} /> {t('sshConfig.subnavData')}
        </span>
      </div>

      {/* 面板本机默认不管控；未导入时提示一次（已导入 / 非管理员不渲染） */}
      <LocalHostNotice />

      {/* ---------------- 当前主机监测 ---------------- */}
      <div className="section-block">
        <div className="section-title">
          <IconTerminal size={15} />
          <span className="section-name">{t('ssh.scopeSection')}</span>
          <span className="section-hint">{t('ssh.scopeSectionHint')}</span>
        </div>

        <div className="ssh-scope-bar">
          <span className="ssh-scope-label">{t('ssh.scopeLabel')}</span>
          <Select
            aria-label={t('ssh.scopeLabel')}
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
            options={scopeOptions}
            style={{ maxWidth: 280 }}
          />
          <span className="ssh-scope-meta">
            {fleet ? (
              <Badge
                variant={
                  fleet.totals.reachable === fleet.totals.hosts ? 'success' : 'danger'
                }
                size="sm"
                dot
              >
                {t('ssh.reachable', {
                  reachable: fleet.totals.reachable,
                  total: fleet.totals.hosts,
                })}
              </Badge>
            ) : null}
            {local?.report.generated_at
              ? t('ssh.checkedAt', { time: formatRelative(local.report.generated_at) })
              : ''}
          </span>
        </div>

        <div className="grid grid-4">
          <KpiCard
            label={t('ssh.kpi.failures')}
            value={formatNumber(current?.summary.failures ?? 0)}
            tone="danger"
            icon={<IconAlert size={15} />}
            hint={t('ssh.kpi.failuresHint', { hours: windowHours })}
            loading={scopeLoading}
          />
          <KpiCard
            label={t('ssh.kpi.ips')}
            value={formatNumber(current?.summary.distinct_ips ?? 0)}
            icon={<IconFilter size={15} />}
            hint={t('ssh.kpi.ipsHint', { n: current?.summary.distinct_users ?? 0 })}
            loading={scopeLoading}
          />
          <KpiCard
            label={t('ssh.kpi.logins')}
            value={formatNumber(current?.summary.logins ?? 0)}
            tone="success"
            icon={<IconKey size={15} />}
            hint={
              scopeId === 'local'
                ? t('ssh.kpi.loginsHintLocal')
                : t('ssh.kpi.loginsHintRemote')
            }
            loading={scopeLoading}
          />
          <KpiCard
            label={t('ssh.kpi.banned')}
            value={formatNumber(bannedNow)}
            tone="warning"
            icon={<IconLock size={15} />}
            hint={t('ssh.kpi.bannedHint', { n: formatNumber(bannedTotal) })}
            loading={scopeLoading}
          />
        </div>

        {current && !current.ok ? (
          <Notice tone="warning" title={t('ssh.readErrorTitle', { name: current.name })}>
            {current.error || t('ssh.unknownReason')}
            {scopeId !== 'local' ? (
              <div className="fs-xs text-muted mt-8">
                {t('ssh.readErrorHint')}
              </div>
            ) : null}
          </Notice>
        ) : null}

        {!current && !scopeLoading ? (
          <Notice tone="warning" title={t('ssh.hostGoneTitle')}>
            {t('ssh.hostGoneBody')}
          </Notice>
        ) : null}

        {/* ---------------- 失败来源 + fail2ban（宽屏并排） ---------------- */}
        <div className="split-panel is-balanced">
        <Card collapsible={false}>
          <CardHeader
            title={t('ssh.failuresTitle', { n: failures.length })}
            subtitle={t('ssh.failuresSubtitle', {
              name: current?.name || t('ssh.localName'),
              hours: windowHours,
            })}
            icon={<IconAlert size={16} />}
          />
          <Table
            caption={t('ssh.failuresCaption')}
            rows={failurePage.rows}
            columns={failureColumns}
            rowKey={(row) => row.ip}
            loading={scopeLoading}
            dense
            emptyTitle={t('ssh.failuresEmpty')}
            emptyDescription={
              current?.ok === false ? t('ssh.failuresEmptyDesc') : undefined
            }
          />
          <PagerBar pager={failurePage} />
        </Card>

        {/* ---------------- fail2ban ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title={t('ssh.f2bTitle')}
            subtitle={
              current?.fail2ban?.installed
                ? t('ssh.f2bSubtitleInstalled', {
                    name: current.name,
                    n: current.fail2ban.jails.length || 0,
                  })
                : t('ssh.f2bSubtitleMissing', {
                    name: current?.name || t('ssh.localName'),
                  })
            }
            icon={<IconLock size={16} />}
            actions={
              canManage && current?.fail2ban?.running ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowJailForm((v) => !v)}
                >
                  {showJailForm ? t('ssh.jailFormHide') : t('ssh.jailFormShow')}
                </Button>
              ) : null
            }
          />

          {current?.fail2ban && !current.fail2ban.installed ? (
            <Notice
              tone="info"
              title={t('ssh.f2bMissingTitle', {
                host: current.fail2ban.host || current.name,
              })}
            >
              {current.fail2ban.hint}
            </Notice>
          ) : null}

          {current?.fail2ban?.installed && !current.fail2ban.running ? (
            <Notice tone="warning" title={t('ssh.f2bDownTitle')}>
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
                        {t('ssh.jailPreferred')}
                      </Badge>
                    ) : null}
                    {item.managed_config ? (
                      <Badge variant="neutral" size="sm" title={item.managed_config}>
                        {t('ssh.jailManaged')}
                      </Badge>
                    ) : null}
                    <span className="ssh-jail-stats">
                      <span>
                        {t('ssh.jailCurrentlyBanned')} <b>{item.currently_banned}</b>
                      </span>
                      <span>
                        {t('ssh.jailTotalBanned')} <b>{item.total_banned}</b>
                      </span>
                      <span>
                        {t('ssh.jailCurrentlyFailed')} <b>{item.currently_failed}</b>
                      </span>
                      <span>
                        {t('ssh.jailTotalFailed')} <b>{item.total_failed}</b>
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
                              aria-label={t('ssh.unbanIp', { ip })}
                              title={t('ssh.unbanIp', { ip })}
                              onClick={() => void unban(ip, item.jail)}
                            >
                              <IconClose size={12} />
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="ssh-jail-empty">{t('ssh.jailEmpty')}</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {canManage && current?.fail2ban?.installed && current.fail2ban.running ? (
            <>
              <div className="ssh-ban-bar">
                <IconLock size={15} />
                <span className="fw-500 fs-sm">{t('ssh.manualBan')}</span>
                <Input
                  value={banIp}
                  onChange={(e) => setBanIp(e.target.value)}
                  placeholder="1.2.3.4"
                  mono
                  aria-label={t('ssh.banIpAria')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && banIp.trim() && jail) {
                      void ban(banIp.trim());
                      setBanIp('');
                    }
                  }}
                />
                <span className="ssh-ban-bar-hint">
                  {jail ? t('ssh.joinJail', { jail }) : t('ssh.enableJailFirst')}
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
                  {t('ssh.ban')}
                </Button>
              </div>

              {showJailForm ? (
                <div className="create-bar">
                  <div className="ssh-advanced-head">
                    <strong>{t('ssh.jailFormShow')}</strong>
                    <span>
                      {t('ssh.jailFormHint', { jail: jailDraft.jail || '<jail>' })}
                    </span>
                  </div>
                  <div className="field-row">
                    <Field label={t('ssh.jailName')} hint={t('ssh.jailNameHint')}>
                      <Input
                        value={jailDraft.jail}
                        onChange={(e) => setJailDraft({ ...jailDraft, jail: e.target.value })}
                        placeholder="sshd"
                        mono
                      />
                    </Field>
                    <Field label={t('ssh.maxretry')} hint="maxretry">
                      <Input
                        type="number"
                        min={1}
                        value={jailDraft.maxretry}
                        onChange={(e) =>
                          setJailDraft({ ...jailDraft, maxretry: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label={t('ssh.findtime')} hint="findtime">
                      <Input
                        type="number"
                        min={60}
                        value={jailDraft.findtime}
                        onChange={(e) =>
                          setJailDraft({ ...jailDraft, findtime: Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label={t('ssh.bantime')} hint="bantime">
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
                      {t('ssh.saveJail')}
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
          <span className="section-name">{t('ssh.localSection')}</span>
          <span className="section-hint">
            {t('ssh.localSectionHint')}
          </span>
        </div>

        <div className="split-panel is-even is-balanced">
        <Card collapsible={false}>
          <CardHeader
            title={t('ssh.loginsTitle', { n: logins.length })}
            subtitle={t('ssh.loginsSubtitle')}
            icon={<IconKey size={16} />}
          />
          <Table
            caption={t('ssh.loginsCaption')}
            rows={loginPage.rows}
            columns={loginColumns}
            rowKey={(row) => String(row.id ?? `${row.ip}-${row.ts}`)}
            loading={loginsQuery.isLoading}
            dense
            emptyTitle={t('ssh.loginsEmpty')}
            emptyDescription={t('ssh.loginsEmptyDesc')}
          />
          <PagerBar pager={loginPage} />
        </Card>

        <Card collapsible={false}>
          <CardHeader
            title={t('ssh.knownTitle', { n: knownIps.length })}
            subtitle={t('ssh.knownSubtitle')}
            icon={<IconShield size={16} />}
          />
          <Table
            caption={t('ssh.knownCaption')}
            rows={knownPage.rows}
            columns={knownColumns}
            rowKey={(row) => row.ip}
            loading={knownQuery.isLoading}
            dense
            emptyTitle={t('ssh.knownEmpty')}
            emptyDescription={t('ssh.knownEmptyDesc')}
          />
          <PagerBar pager={knownPage} />
        </Card>
        </div>
      </div>

    </PageShell>
  );
}
