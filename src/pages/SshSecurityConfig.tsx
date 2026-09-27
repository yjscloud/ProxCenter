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
import type { SshHost, SshPolicy } from '../api/types';

const LOG_SOURCES = [
  { label: '自动（journalctl 优先）', value: 'auto' },
  { label: 'journalctl', value: 'journalctl' },
  { label: '/var/log/secure', value: 'secure' },
  { label: '/var/log/auth.log', value: 'auth.log' },
];

/** 受管主机列表里的短标签（下拉用的完整文案在上面） */
const LOG_SOURCE_LABEL: Record<string, string> = {
  auto: '自动',
  journalctl: 'journalctl',
  secure: '/var/log/secure',
  'auth.log': '/var/log/auth.log',
};

export function SshSecurityConfig() {
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
        res.owner ? '归属已更新' : '已收回归属',
        res.owner ? `${target.name} → ${res.owner}` : '这台主机现在只有管理员可见',
      );
      setOwnerTarget(null);
      /* 主机列表（归属）与多机汇总都跟着变：归属影响普通用户能看到什么 */
      await qc.invalidateQueries({ queryKey: ['ssh'] });
    } catch (err) {
      toast.error('指派失败', errorMessage(err));
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
      toast.success(editingHost ? '主机已更新' : '主机已添加');
      setEditingHost(null);
      setHostDraft(null);
      await refreshFleet();
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeHost = async () => {
    if (!deleteHost) return;
    setBusy(true);
    try {
      await sshFleetApi.deleteHost(deleteHost.id);
      toast.success(`已移除 ${deleteHost.name}`);
      setDeleteHost(null);
      await refreshFleet();
    } catch (err) {
      toast.error('删除失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const testHost = async (host: SshHost) => {
    setBusy(true);
    try {
      const res = await sshFleetApi.testHost(host.id);
      const r = res.result;
      setTestResult({
        name: host.name,
        text: r.ok
          ? `已连上 ${r.hostname || host.host}（登录为 ${r.user || '-'}）`
            + (r.fail2ban ? ` · fail2ban ${r.fail2ban.split('\n')[0]}` : ' · 该主机没有 fail2ban-client')
            + ` · 日志源 ${r.journal ? 'journalctl' : r.secure ? '/var/log/secure' : r.authlog ? '/var/log/auth.log' : '未找到'}`
            + (r.fingerprint ? ` · 指纹 ${r.fingerprint}` : '')
          : r.detail,
      });
      await hostsQuery.refetch();
    } catch (err) {
      toast.error('测试失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const trustHost = async (host: SshHost) => {
    setBusy(true);
    try {
      const res = await sshFleetApi.trustHost(host.id);
      toast.success(`已记住 ${host.name} 的指纹`, res.fingerprint);
      await refreshFleet();
    } catch (err) {
      toast.error('确认指纹失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hostColumns: Array<Column<SshHost>> = [
    {
      key: 'name',
      header: '主机',
      render: (row) => (
        <div>
          <div className="fw-600 fs-sm">{row.name}</div>
          <div className="fs-xs text-muted mono">
            {row.username}@{row.host}:{row.port}
          </div>
        </div>
      ),
    },
    {
      key: 'auth',
      header: '凭据',
      width: 150,
      render: (row) => (
        <span className="ssh-ip-cell">
          <Badge variant={row.secret_set ? 'success' : 'warning'} size="sm">
            {row.auth_type === 'password' ? '口令' : '私钥'}
            {row.secret_set ? '' : '（未设置）'}
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
            header: '归属',
            width: 130,
            render: (row: SshHost) =>
              row.owner ? (
                <span className="fs-sm mono">{row.owner}</span>
              ) : (
                <Badge
                  variant="neutral"
                  size="sm"
                  title="存量主机没有归属记录，普通用户看不到它"
                >
                  仅管理员
                </Badge>
              ),
          } as Column<SshHost>,
        ]
      : []),
    {
      key: 'fingerprint',
      header: '主机指纹',
      width: 160,
      render: (row) =>
        row.known_host ? (
          <span className="fs-xs text-muted mono">{row.known_host.slice(0, 16)}…</span>
        ) : (
          <Badge variant="warning" size="sm">
            未确认
          </Badge>
        ),
    },
    {
      key: 'log_source',
      header: '日志来源',
      width: 150,
      render: (row) => (
        <span className="fs-xs text-secondary">
          {LOG_SOURCE_LABEL[row.log_source] ?? row.log_source ?? '—'}
        </span>
      ),
    },
    {
      key: 'updated',
      header: '更新于',
      width: 110,
      render: (row) => (
        <span className="fs-xs text-muted">
          {row.updated ? formatRelative(row.updated) : '—'}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: '状态',
      width: 84,
      render: (row) => (
        <Badge variant={row.enabled ? 'success' : 'neutral'} size="sm">
          {row.enabled ? '启用' : '停用'}
        </Badge>
      ),
    },
    {
      key: 'ops',
      header: '操作',
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
              测试
            </Button>
            {row.known_host ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void trustHost(row)}
              >
                信任指纹
              </Button>
            )}
            {isAdmin ? (
              <Button
                size="sm"
                variant="ghost"
                title="把这台主机指派给某个用户（留空 = 收回，之后仅管理员可见）"
                onClick={() => {
                  setOwnerValue(row.owner ?? '');
                  setOwnerTarget(row);
                }}
              >
                归属
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
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="移除该主机"
              onClick={() => setDeleteHost(row)}
            >
              <IconTrash size={14} />
            </Button>
          </span>
        ) : (
          <span className="fs-xs text-muted">只读</span>
        ),
    },
  ];

  return (
    <PageShell
      title="主机与告警配置"
      subtitle="受管主机（SSH 凭据）与异常登录告警策略；监测数据在「SSH 安全」主页面"
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void overviewQuery.refetch()}
          loading={overviewQuery.isFetching}
        >
          刷新
        </Button>
      }
    >
      <div className="subnav">
        <span className="subnav-item is-active" aria-current="page">
          <IconServer size={14} /> 主机与告警配置
        </span>
        <Link className="subnav-item" to="/ssh-security">
          <IconTerminal size={14} /> 监测数据
        </Link>
      </div>

      <div className="section-block">
        <div className="section-title">
          <IconServer size={15} />
          <span className="section-name">受管主机</span>
          <span className="section-hint">
            面板用这些凭据连上去读日志、管 fail2ban
          </span>
        </div>

        <Card collapsible={false}>
          <CardHeader
            title={`受管主机（${hosts.length}）`}
            subtitle="凭据加密存储，接口永不回传明文"
            icon={<IconServer size={16} />}
            actions={
              canManage && hosts.length ? (
                <Button size="sm" variant="primary" onClick={startCreateHost}>
                  <IconPlus size={14} /> 添加主机
                </Button>
              ) : null
            }
          />
          {testResult ? (
            <Notice
              tone="info"
              title={`${testResult.name} 连接测试`}
              action={
                <Button size="sm" variant="ghost" onClick={() => setTestResult(null)}>
                  关闭
                </Button>
              }
            >
              {testResult.text}
            </Notice>
          ) : null}
          {hosts.length ? (
            <>
              <Table
                caption="受管主机"
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
                还没有受管主机。添加后（需要目标机的 SSH 私钥或口令），面板就能把它的
                SSH 日志与 fail2ban 一起纳入统计与告警。
              </div>
              {canManage ? (
                <Button size="sm" variant="primary" onClick={startCreateHost}>
                  <IconPlus size={14} /> 添加第一台主机
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={Boolean(ownerTarget)}
        onClose={() => setOwnerTarget(null)}
        title="指派主机归属"
        description={ownerTarget ? `${ownerTarget.name}（${ownerTarget.host}）` : undefined}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setOwnerTarget(null)}
              disabled={ownerBusy}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={ownerBusy}
              onClick={() => void saveOwner()}
            >
              保存
            </Button>
          </>
        }
      >
        <Field
          label="归属用户"
          hint="留空 = 收回归属，之后这台主机只有管理员可见。用户名的拼写要与管理页里的账号完全一致。"
        >
          <Input
            value={ownerValue}
            onChange={(e) => setOwnerValue(e.target.value)}
            placeholder="例如 zhangsan"
            autoComplete="off"
          />
        </Field>
      </Modal>

      {policy ? (
        <div className="section-block">
          <div className="section-title">
            <IconAlert size={15} />
            <span className="section-name">异常登录告警策略</span>
            <span className="section-hint">对当前可见的主机生效</span>
          </div>
          <PolicyCard
            policy={policy}
            canManage={canManage}
            onSave={async (next) => {
              try {
                await sshApi.savePolicy(next);
                toast.success('策略已保存');
                await overviewQuery.refetch();
              } catch (err) {
                toast.error('保存失败', errorMessage(err));
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
          title={editingHost ? `编辑主机：${editingHost.name}` : '添加受管主机'}
          description="口令与私钥都会用 SECRET_KEY 加密后落库，接口永不回传明文"
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
                取消
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void saveHost()}>
                保存
              </Button>
            </>
          }
        >
          <div className="dyn-list">
            <div className="field-row">
              <Field label="名称" hint="显示用，例如 pve-1">
                <Input
                  value={String(hostDraft.name ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, name: e.target.value })}
                  placeholder="pve-1"
                />
              </Field>
              <Field label="地址" required>
                <Input
                  value={String(hostDraft.host ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, host: e.target.value })}
                  placeholder="172.16.149.3"
                  mono
                />
              </Field>
              <Field label="端口">
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
              <Field label="登录用户" required>
                <Input
                  value={String(hostDraft.username ?? '')}
                  onChange={(e) => setHostDraft({ ...hostDraft, username: e.target.value })}
                  placeholder="root"
                  mono
                />
              </Field>
              <Field label="认证方式">
                <Select
                  value={String(hostDraft.auth_type ?? 'key')}
                  onChange={(e) => setHostDraft({ ...hostDraft, auth_type: e.target.value })}
                  options={[
                    { label: '私钥', value: 'key' },
                    { label: '口令', value: 'password' },
                  ]}
                />
              </Field>
              <Field label="日志来源">
                <Select
                  value={String(hostDraft.log_source ?? 'auto')}
                  onChange={(e) => setHostDraft({ ...hostDraft, log_source: e.target.value })}
                  options={LOG_SOURCES}
                />
              </Field>
            </div>

            <Field
              label={hostDraft.auth_type === 'password' ? 'SSH 口令' : 'SSH 私钥（PEM）'}
              required={!editingHost}
              hint={editingHost ? '留空表示不修改现有凭据' : undefined}
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
                label="命令前加 sudo -n"
                hint="登录用户不是 root 时需要（目标机要配 NOPASSWD）"
              />
              <Switch
                checked={Boolean(hostDraft.enabled ?? true)}
                onChange={(v) => setHostDraft({ ...hostDraft, enabled: v })}
                label="启用该主机"
              />
            </div>

            <Notice tone="info">
              首次连接需要先「信任指纹」：面板会连一次拿到 fingerprint，你确认后再点「信任指纹」，
              之后指纹变了会直接拒绝连接（防中间人）。
            </Notice>
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteHost)}
        title="移除受管主机"
        message={`确定移除「${deleteHost?.name ?? ''}」？只是不再采集它，目标机上的 fail2ban 配置不受影响。`}
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
  const [draft, setDraft] = useState<SshPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? policy;
  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(policy);

  return (
    <Card collapsible={false}>
      <CardHeader
        title="阈值与通知"
        subtitle="命中阈值即推送通知，冷却期内同一来源不重复提醒"
        icon={<IconShield size={16} />}
        actions={
          canManage ? (
            <>
              {dirty ? (
                <Badge variant="warning" size="sm" dot>
                  未保存
                </Badge>
              ) : null}
              {dirty ? (
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                  还原
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!dirty}
                title={dirty ? '保存当前改动' : '改点什么再保存'}
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
                保存策略
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
            label="启用异常登录检查"
            hint="每分钟跑一次（与资源告警同频）"
          />
          <Switch
            checked={value.alert_unknown_ip}
            disabled={!canManage}
            onChange={(v) => setDraft({ ...value, alert_unknown_ip: v })}
            label="陌生 IP 登录成功时告警"
            hint="仅本机：远程主机只统计失败次数"
          />
        </div>

        <div className="field-row">
          <Field label="失败次数阈值" required>
            <Input
              type="number"
              min={1}
              max={10000}
              value={value.max_failures}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, max_failures: Number(e.target.value) })}
            />
          </Field>
          <Field label="统计窗口（小时）" hint="1 - 168">
            <Input
              type="number"
              min={1}
              max={168}
              value={value.window_hours}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, window_hours: Number(e.target.value) })}
            />
          </Field>
          <Field label="重复提醒冷却（分钟）">
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
          <Field label="告警接收人" hint="留空 = 第一个管理员">
            <Input
              value={value.notify_user}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...value, notify_user: e.target.value })}
              placeholder="（第一个管理员）"
            />
          </Field>
          <Field label="忽略的来源" hint="逗号分隔：跳板机、监控探针不参与统计">
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
          远程告警按「主机 + IP」单独计数与冷却：某台机器被爆破时，通知里会写明是哪台主机。
        </Notice>
      </div>
    </Card>
  );
}
