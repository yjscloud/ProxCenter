/* ==========================================================================
   ProxCenter — SSH 安全 · 主机与告警配置

   为什么和「监测数据」拆成两个页面：

   * 监测是每台机器每天都会看的滚动数据，配置是偶尔改一次、改错代价很高的设置；
   * 混在一页里，监测数据会被两张大表单拖得很长，配置也容易被当成只读区块划过去；
   * 拆开后「SSH 安全」这个菜单项下有两层：数据看 /ssh-security，改配置来这里。

   这里管两件事：
   * **受管主机**：面板用来 SSH 连上去读日志、管 fail2ban 的凭据；
   * **异常登录告警策略**：阈值、冷却、通知人，对所有主机生效。
   ========================================================================== */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sshApi, sshFleetApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { PageShell } from '../components/Layout';
import { LocalHostCard } from '../components/LocalHostNotice';
import { PanelKeyCard } from '../components/PanelKeyCard';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field, Input, Select, Switch } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Notice } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PagerBar, usePaged } from '../hooks/usePaged';
import {
  IconAlert,
  IconPlus,
  IconServer,
  IconShield,
  IconTerminal,
  IconTrash,
} from '../components/Icons';
import { formatRelative } from '../utils/format';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useT, type MessageKey } from '../i18n';
import type { SshHost, SshPolicy } from '../api/types';

const LOG_SOURCES: Array<{ label: MessageKey; value: string }> = [
  { label: 'sshConfig.logSourceAuto', value: 'auto' },
  { label: 'sshConfig.logSourceJournalctl', value: 'journalctl' },
  { label: 'sshConfig.logSourceSecure', value: 'secure' },
  { label: 'sshConfig.logSourceAuthlog', value: 'auth.log' },
];

/** 受管主机列表里的短标签（下拉用的完整文案在上面） */
const LOG_SOURCE_LABEL: Record<string, MessageKey> = {
  auto: 'sshConfig.logSourceAutoShort',
  journalctl: 'sshConfig.logSourceJournalctl',
  secure: 'sshConfig.logSourceSecure',
  'auth.log': 'sshConfig.logSourceAuthlog',
};

export function SshSecurityConfig() {
  const t = useT();
  const { hasPermission, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission('ssh.manage');

  const [busy, setBusy] = useState(false);
  const [editingHost, setEditingHost] = useState<SshHost | null>(null);
  const [hostDraft, setHostDraft] = useState<Record<string, unknown> | null>(null);
  const [deleteHost, setDeleteHost] = useState<SshHost | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; text: string } | null>(null);
  /* 指派归属（管理员）：把存量主机交还给真正维护它的人 */
  const [ownerTarget, setOwnerTarget] = useState<SshHost | null>(null);
  const [ownerValue, setOwnerValue] = useState('');
  const [ownerBusy, setOwnerBusy] = useState(false);

  const hostsQuery = useQuery({
    queryKey: ['ssh', 'hosts'],
    queryFn: sshFleetApi.hosts,
    retry: false,
  });
  /* 策略挂在概览接口里（后端就这一处给出），这里只需要其中的 policy */
  const overviewQuery = useQuery({
    queryKey: ['ssh', 'overview'],
    queryFn: () => sshApi.overview(),
    retry: false,
  });

  const hosts = hostsQuery.data ?? [];
  const policy = overviewQuery.data?.policy ?? null;
  const hostPage = usePaged(hosts, 'hosts');

  /** 主机增删改后，两边页面共用 ['ssh'] 前缀，一次失效即可 */
  const refreshFleet = () => qc.invalidateQueries({ queryKey: ['ssh'] });

  /** 打开「添加主机」表单（标题栏按钮与空状态引导按钮共用一份默认值） */
  const saveOwner = async () => {
    const target = ownerTarget;
    if (!target) return;
    setOwnerBusy(true);
    try {
      const res = await sshFleetApi.assignOwner(target.id, ownerValue.trim());
      toast.success(
        res.owner ? t('sshConfig.ownerUpdated') : t('sshConfig.ownerCleared'),
        res.owner
          ? `${target.name} → ${res.owner}`
          : t('sshConfig.ownerClearedDetail'),
      );
      setOwnerTarget(null);
      /* 主机列表（归属）与多机汇总都跟着变：归属影响普通用户能看到什么 */
      await qc.invalidateQueries({ queryKey: ['ssh'] });
    } catch (err) {
      toast.error(t('sshConfig.assignFailed'), errorMessage(err));
    } finally {
      setOwnerBusy(false);
    }
  };

  const startCreateHost = () => {
    setEditingHost(null);
    setHostDraft({
      name: '',
      host: '',
      port: 22,
      username: 'root',
      auth_type: 'key',
      secret: '',
      use_sudo: false,
      log_source: 'auto',
      enabled: true,
    });
  };

  const saveHost = async () => {
    if (!hostDraft) return;
    setBusy(true);
    try {
      if (editingHost) {
        await sshFleetApi.updateHost(editingHost.id, hostDraft);
      } else {
        await sshFleetApi.createHost(hostDraft);
      }
      toast.success(
        editingHost ? t('sshConfig.hostUpdated') : t('sshConfig.hostAdded'),
      );
      setEditingHost(null);
      setHostDraft(null);
      await refreshFleet();
    } catch (err) {
      toast.error(t('sshConfig.saveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeHost = async () => {
    if (!deleteHost) return;
    setBusy(true);
    try {
      await sshFleetApi.deleteHost(deleteHost.id);
      toast.success(t('sshConfig.hostRemoved', { name: deleteHost.name }));
      setDeleteHost(null);
      await refreshFleet();
    } catch (err) {
      toast.error(t('sshConfig.deleteFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const testHost = async (host: SshHost) => {
    setBusy(true);
    try {
      const res = await sshFleetApi.testHost(host.id);
      const r = res.result;
      const logSource = r.journal
        ? 'journalctl'
        : r.secure
          ? '/var/log/secure'
          : r.authlog
            ? '/var/log/auth.log'
            : t('sshConfig.notFound');
      setTestResult({
        name: host.name,
        text: r.ok
          ? t('sshConfig.testOk', {
              host: r.hostname || host.host,
              user: r.user || '-',
            })
            + (r.fail2ban
              ? t('sshConfig.testFail2ban', { version: r.fail2ban.split('\n')[0] })
              : t('sshConfig.testNoFail2ban'))
            + t('sshConfig.testLogSource', { source: logSource })
            + (r.fingerprint ? t('sshConfig.testFingerprint', { fp: r.fingerprint }) : '')
          : r.detail,
      });
      await hostsQuery.refetch();
    } catch (err) {
      toast.error(t('sshConfig.testFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const trustHost = async (host: SshHost) => {
    setBusy(true);
    try {
      const res = await sshFleetApi.trustHost(host.id);
      toast.success(t('sshConfig.trustDone', { name: host.name }), res.fingerprint);
      await refreshFleet();
    } catch (err) {
      toast.error(t('sshConfig.trustFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hostColumns: Array<Column<SshHost>> = [
    {
      key: 'name',
      header: t('sshConfig.colHost'),
      render: (row) => (
        <div>
          <div className="fw-600 fs-sm">
            {row.name}
            {/* 面板下发虚拟机时自动登记的主机：凭据是面板统一密钥对、首连自动
                信任指纹，和用户手工添加的那几台不是一回事，标出来免得混淆。 */}
            {row.origin === 'panel' ? (
              <Badge variant="neutral" size="sm">
                {t('sshConfig.originPanel')}
              </Badge>
            ) : null}
          </div>
          <div className="fs-xs text-muted mono">
            {row.username}@{row.host}:{row.port}
          </div>
        </div>
      ),
    },
    {
      key: 'auth',
      header: t('sshConfig.colAuth'),
      width: 150,
      render: (row) => (
        <span className="ssh-ip-cell">
          <Badge variant={row.secret_set ? 'success' : 'warning'} size="sm">
            {row.auth_type === 'password' ? t('sshConfig.authPassword') : t('sshConfig.authKey')}
            {row.secret_set ? '' : t('sshConfig.authUnset')}
          </Badge>
          {row.use_sudo ? (
            <Badge variant="neutral" size="sm">
              sudo
            </Badge>
          ) : null}
        </span>
      ),
    },
    /* 归属：普通用户看到的列表里本来只有自己的机器，这一列主要是给管理员看的 */
    ...(isAdmin
      ? [
          {
            key: 'owner',
            header: t('sshConfig.colOwner'),
            width: 130,
            render: (row: SshHost) =>
              row.owner ? (
                <span className="fs-sm mono">{row.owner}</span>
              ) : (
                <Badge
                  variant="neutral"
                  size="sm"
                  title={t('sshConfig.adminOnlyTitle')}
                >
                  {t('sshConfig.adminOnly')}
                </Badge>
              ),
          } as Column<SshHost>,
        ]
      : []),
    {
      key: 'fingerprint',
      header: t('sshConfig.colFingerprint'),
      width: 160,
      render: (row) =>
        row.known_host ? (
          <span className="fs-xs text-muted mono">{row.known_host.slice(0, 16)}…</span>
        ) : (
          <Badge variant="warning" size="sm">
            {t('sshConfig.unconfirmed')}
          </Badge>
        ),
    },
    {
      key: 'log_source',
      header: t('sshConfig.colLogSource'),
      width: 150,
      render: (row) => (
        <span className="fs-xs text-secondary">
          {LOG_SOURCE_LABEL[row.log_source]
            ? t(LOG_SOURCE_LABEL[row.log_source])
            : row.log_source ?? '—'}
        </span>
      ),
    },
    {
      key: 'updated',
      header: t('sshConfig.colUpdated'),
      width: 110,
      render: (row) => (
        <span className="fs-xs text-muted">
          {row.updated ? formatRelative(row.updated) : '—'}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: t('common.status'),
      width: 84,
      render: (row) => (
        <Badge variant={row.enabled ? 'success' : 'neutral'} size="sm">
          {row.enabled ? t('common.enable') : t('sshConfig.disabled')}
        </Badge>
      ),
    },
    {
      key: 'ops',
      header: t('common.actions'),
      width: 284,
      align: 'right',
      render: (row) =>
        canManage ? (
          <span className="row-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void testHost(row)}
            >
              {t('sshConfig.test')}
            </Button>
            {row.known_host ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void trustHost(row)}
              >
                {t('sshConfig.trust')}
              </Button>
            )}
            {isAdmin ? (
              <Button
                size="sm"
                variant="ghost"
                title={t('sshConfig.ownerBtnTitle')}
                onClick={() => {
                  setOwnerValue(row.owner ?? '');
                  setOwnerTarget(row);
                }}
              >
                {t('sshConfig.owner')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingHost(row);
                setHostDraft({ ...row, secret: '' });
              }}
            >
              {t('common.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title={t('sshConfig.removeHostBtnTitle')}
              onClick={() => setDeleteHost(row)}
            >
              <IconTrash size={14} />
            </Button>
          </span>
        ) : (
          <span className="fs-xs text-muted">{t('sshConfig.readOnly')}</span>
        ),
    },
  ];

  return (
    <PageShell
      title={t('sshConfig.title')}
      subtitle={t('sshConfig.subtitle')}
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void overviewQuery.refetch()}
          loading={overviewQuery.isFetching}
        >
          {t('common.refresh')}
        </Button>
      }
    >
      <div className="subnav">
        <span className="subnav-item is-active" aria-current="page">
          <IconServer size={14} /> {t('sshConfig.title')}
        </span>
        <Link className="subnav-item" to="/ssh-security">
          <IconTerminal size={14} /> {t('sshConfig.subnavData')}
        </Link>
      </div>

      <div className="section-block">
        <div className="section-title">
          <IconServer size={15} />
          <span className="section-name">{t('sshConfig.hostsSection')}</span>
          <span className="section-hint">
            {t('sshConfig.hostsSectionHint')}
          </span>
        </div>

        <Card collapsible={false}>
          <CardHeader
            title={t('sshConfig.hostsTitle', { n: hosts.length })}
            subtitle={t('sshConfig.hostsSubtitle')}
            icon={<IconServer size={16} />}
            actions={
              canManage && hosts.length ? (
                <Button size="sm" variant="primary" onClick={startCreateHost}>
                  <IconPlus size={14} /> {t('sshConfig.addHost')}
                </Button>
              ) : null
            }
          />
          {testResult ? (
            <Notice
              tone="info"
              title={t('sshConfig.testTitle', { name: testResult.name })}
              action={
                <Button size="sm" variant="ghost" onClick={() => setTestResult(null)}>
                  {t('common.close')}
                </Button>
              }
            >
              {testResult.text}
            </Notice>
          ) : null}
          {hosts.length ? (
            <>
              <Table
                caption={t('sshConfig.hostsSection')}
                rows={hostPage.rows}
                columns={hostColumns}
                rowKey={(row) => row.id}
                loading={hostsQuery.isLoading}
              />
              <PagerBar pager={hostPage} />
            </>
          ) : (
            <div className="ssh-empty">
              <div className="ssh-empty-text">
                {t('sshConfig.emptyText')}
              </div>
              {canManage ? (
                <Button size="sm" variant="primary" onClick={startCreateHost}>
                  <IconPlus size={14} /> {t('sshConfig.addFirstHost')}
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      {/* 面板本机：已导入时才渲染。它不是受管主机（没有凭据、不走 SSH），
          所以单独一张卡片，只提供「移出」；容器部署下本机没有意义，不渲染。 */}
      <LocalHostCard />

      {/* 面板 SSH 公钥：下发虚拟机时用它注入公钥，之后面板自己 SSH 进去采集。
          做成独立组件，避免把这一页再撑长。 */}
      <PanelKeyCard />

      <Modal
        open={Boolean(ownerTarget)}
        onClose={() => setOwnerTarget(null)}
        title={t('sshConfig.ownerModalTitle')}
        description={
          ownerTarget
            ? t('sshConfig.ownerModalDesc', {
                name: ownerTarget.name,
                host: ownerTarget.host,
              })
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setOwnerTarget(null)}
              disabled={ownerBusy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={ownerBusy}
              onClick={() => void saveOwner()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field
          label={t('sshConfig.ownerField')}
          hint={t('sshConfig.ownerHint')}
        >
          <Input
            value={ownerValue}
            onChange={(e) => setOwnerValue(e.target.value)}
            placeholder={t('sshConfig.ownerPlaceholder')}
            autoComplete="off"
          />
        </Field>
      </Modal>

      {policy ? (
        <div className="section-block">
          <div className="section-title">
            <IconAlert size={15} />
            <span className="section-name">{t('sshConfig.policySection')}</span>
            <span className="section-hint">{t('sshConfig.policySectionHint')}</span>
          </div>
          <PolicyCard
            policy={policy}
            canManage={canManage}
            onSave={async (next) => {
              try {
                await sshApi.savePolicy(next);
                toast.success(t('sshConfig.policySaved'));
                await overviewQuery.refetch();
              } catch (err) {
                toast.error(t('sshConfig.saveFailed'), errorMessage(err));
                throw err;
              }
            }}
          />
        </div>
      ) : null}

      {hostDraft ? (
        <Modal
          open
          onClose={() => {
            setHostDraft(null);
            setEditingHost(null);
          }}
          title={
            editingHost
              ? t('sshConfig.editHostTitle', { name: editingHost.name })
              : t('sshConfig.addHostTitle')
          }
          description={t('sshConfig.hostModalDesc')}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setHostDraft(null);
                  setEditingHost(null);
                }}
                disabled={busy}
              >
                {t('common.cancel')}
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void saveHost()}>
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="dyn-list">
            <div className="field-row">
              <Field label={t('common.name')} hint={t('sshConfig.nameHint')}>
                <Input
                  value={String(hostDraft.name ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, name: e.target.value })}
                  placeholder="pve-1"
                />
              </Field>
              <Field label={t('sshConfig.fieldHost')} required>
                <Input
                  value={String(hostDraft.host ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, host: e.target.value })}
                  placeholder="172.16.149.3"
                  mono
                />
              </Field>
              <Field label={t('sshConfig.fieldPort')}>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={Number(hostDraft.port ?? 22)}
                  onChange={(e) => setHostDraft({ ...hostDraft, port: Number(e.target.value) })}
                />
              </Field>
            </div>

            <div className="field-row">
              <Field label={t('sshConfig.fieldUser')} required>
                <Input
                  value={String(hostDraft.username ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, username: e.target.value })}
                  placeholder="root"
                  mono
                />
              </Field>
              <Field label={t('sshConfig.fieldAuth')}>
                <Select
                  value={String(hostDraft.auth_type ?? 'key')}
                  onChange={(e) => setHostDraft({ ...hostDraft, auth_type: e.target.value })}
                  options={[
                    { label: t('sshConfig.authKey'), value: 'key' },
                    { label: t('sshConfig.authPassword'), value: 'password' },
                  ]}
                />
              </Field>
              <Field label={t('sshConfig.colLogSource')}>
                <Select
                  value={String(hostDraft.log_source ?? 'auto')}
                  onChange={(e) => setHostDraft({ ...hostDraft, log_source: e.target.value })}
                  options={LOG_SOURCES.map((item) => ({
                    label: t(item.label),
                    value: item.value,
                  }))}
                />
              </Field>
            </div>

            <Field
              label={
                hostDraft.auth_type === 'password'
                  ? t('sshConfig.fieldPassword')
                  : t('sshConfig.fieldPrivateKey')
              }
              required={!editingHost}
              hint={editingHost ? t('sshConfig.secretHint') : undefined}
            >
              <Input
                type={hostDraft.auth_type === 'password' ? 'password' : undefined}
                value={String(hostDraft.secret ?? '')}
                onChange={(e) => setHostDraft({ ...hostDraft, secret: e.target.value })}
                placeholder={
                  hostDraft.auth_type === 'password'
                    ? '••••••••'
                    : '-----BEGIN OPENSSH PRIVATE KEY-----'
                }
                mono
              />
            </Field>

            <div className="form-row" style={{ alignItems: 'center' }}>
              <Switch
                checked={Boolean(hostDraft.use_sudo)}
                onChange={(v) => setHostDraft({ ...hostDraft, use_sudo: v })}
                label={t('sshConfig.sudoSwitch')}
                hint={t('sshConfig.sudoSwitchHint')}
              />
              <Switch
                checked={Boolean(hostDraft.enabled ?? true)}
                onChange={(v) => setHostDraft({ ...hostDraft, enabled: v })}
                label={t('sshConfig.enabledSwitch')}
              />
            </div>

            <Notice tone="info">
              {t('sshConfig.firstConnectNotice')}
            </Notice>
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteHost)}
        title={t('sshConfig.removeHostTitle')}
        message={t('sshConfig.removeHostMessage', { name: deleteHost?.name ?? '' })}
        danger
        loading={busy}
        onCancel={() => setDeleteHost(null)}
        onConfirm={() => void removeHost()}
      />
    </PageShell>
  );
}

/* -------------------------------------------------------------- 告警策略 */
function PolicyCard({
  policy,
  canManage,
  onSave,
}: {
  policy: SshPolicy;
  canManage: boolean;
  onSave: (next: SshPolicy) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<SshPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? policy;
  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(policy);

  return (
    <Card collapsible={false}>
      <CardHeader
        title={t('sshConfig.policyTitle')}
        subtitle={t('sshConfig.policySubtitle')}
        icon={<IconShield size={16} />}
        actions={
          canManage ? (
            <>
              {dirty ? (
                <Badge variant="warning" size="sm" dot>
                  {t('sshConfig.unsaved')}
                </Badge>
              ) : null}
              {dirty ? (
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                  {t('sshConfig.revert')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!dirty}
                title={dirty ? t('sshConfig.savePolicyTitle') : t('sshConfig.nothingToSave')}
                onClick={async () => {
                  if (!draft) return;
                  setBusy(true);
                  try {
                    await onSave(draft);
                    setDraft(null);
                  } catch {
                    /* 失败时保留草稿，方便直接重试 */
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('sshConfig.savePolicy')}
              </Button>
            </>
          ) : null
        }
      />
      <div className="dyn-list">
        <div className="form-row" style={{ alignItems: 'center' }}>
          <Switch
            checked={value.enabled}
            disabled={!canManage}
            onChange={(v) => setDraft({ ...value, enabled: v })}
            label={t('sshConfig.policyEnabled')}
            hint={t('sshConfig.policyEnabledHint')}
          />
          <Switch
            checked={value.alert_unknown_ip}
            disabled={!canManage}
            onChange={(v) => setDraft({ ...value, alert_unknown_ip: v })}
            label={t('sshConfig.policyUnknownIp')}
            hint={t('sshConfig.policyUnknownIpHint')}
          />
        </div>

        <div className="field-row">
          <Field label={t('sshConfig.maxFailures')} required>
            <Input
              type="number"
              min={1}
              max={10000}
              value={value.max_failures}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, max_failures: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('sshConfig.windowHours')} hint={t('sshConfig.windowHint')}>
            <Input
              type="number"
              min={1}
              max={168}
              value={value.window_hours}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, window_hours: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('sshConfig.cooldown')}>
            <Input
              type="number"
              min={1}
              max={1440}
              value={value.cooldown_minutes}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, cooldown_minutes: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('sshConfig.notifyUser')} hint={t('sshConfig.notifyUserHint')}>
            <Input
              value={value.notify_user}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, notify_user: e.target.value })}
              placeholder={t('sshConfig.notifyUserPlaceholder')}
            />
          </Field>
          <Field label={t('sshConfig.ignoreIps')} hint={t('sshConfig.ignoreIpsHint')}>
            <Input
              value={value.ignore_ips}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, ignore_ips: e.target.value })}
              placeholder="10.0.0.1,10.0.0.2"
              mono
            />
          </Field>
        </div>

        <Notice tone="info">
          {t('sshConfig.remoteNotice')}
        </Notice>
      </div>
    </Card>
  );
}
