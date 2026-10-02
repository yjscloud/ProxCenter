/* ==========================================================================
   ProxCenter — 面板用户管理
   用户 CRUD + 角色权限说明矩阵
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesApi, usersApi } from '../api/endpoints';
import { PermissionPicker } from '../components/PermissionPicker';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select, Switch, Textarea, Field } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { ErrorState, Notice, CollapsibleCard } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  IconUsers,
  IconRefresh,
  IconPlus,
  IconSearch,
  IconTrash,
  IconEdit,
  IconKey,
  IconShield,
  IconEye,
  IconEyeOff,
  IconUser,
  IconCheck,
  IconClose,
  IconClock,
} from '../components/Icons';
import { formatDateTime } from '../utils/format';
import {
  isPendingApproval,
  roleMeta,
  userEnabledMeta,
  userStatusMeta,
} from '../utils/status'
import { tStatic, useT, type TFunc } from '../i18n';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  PanelRole,
  RoleOut,
  UserAccountStatus,
  UserOut,
} from '../api/types';

/* ---------------------------------------------------------------------------
   权限矩阵：面板权限点 → 各角色是否具备
   --------------------------------------------------------------------------- */

interface PermissionRow {
  /** 权限点标识（与后端 permissions 数组一致）*/
  key: string;
  /** 展示名 */
  label: string;
  /** 说明 */
  description: string;
  /** 具备该权限的角色 */
  roles: PanelRole[];
}

/**
 * 权限矩阵：文案随语言走，因此做成接收 t 的工厂函数（模块级常量会让文案
 * 停在首次加载时的语言上）。
 */
function permissionMatrix(t: TFunc): PermissionRow[] {
  return [
    {
      key: 'vm.view',
      label: t('users.perm.vmView.label'),
      description: t('users.perm.vmView.desc'),
      roles: ['admin', 'operator', 'viewer'],
    },
    {
      key: 'vm.console',
      label: t('users.perm.vmConsole.label'),
      description: t('users.perm.vmConsole.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'vm.power',
      label: t('users.perm.vmPower.label'),
      description: t('users.perm.vmPower.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'vm.create',
      label: t('users.perm.vmCreate.label'),
      description: t('users.perm.vmCreate.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'vm.delete',
      label: t('users.perm.vmDelete.label'),
      description: t('users.perm.vmDelete.desc'),
      roles: ['admin'],
    },
    {
      key: 'vm.config',
      label: t('users.perm.vmConfig.label'),
      description: t('users.perm.vmConfig.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'vm.snapshot',
      label: t('users.perm.vmSnapshot.label'),
      description: t('users.perm.vmSnapshot.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'vm.migrate',
      label: t('users.perm.vmMigrate.label'),
      description: t('users.perm.vmMigrate.desc'),
      roles: ['admin'],
    },
    {
      key: 'backup.view',
      label: t('users.perm.backupView.label'),
      description: t('users.perm.backupView.desc'),
      roles: ['admin', 'operator', 'viewer'],
    },
    {
      key: 'backup.create',
      label: t('users.perm.backupCreate.label'),
      description: t('users.perm.backupCreate.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'backup.delete',
      label: t('users.perm.backupDelete.label'),
      description: t('users.perm.backupDelete.desc'),
      roles: ['admin'],
    },
    {
      key: 'node.view',
      label: t('users.perm.nodeView.label'),
      description: t('users.perm.nodeView.desc'),
      roles: ['admin', 'operator', 'viewer'],
    },
    {
      key: 'network.manage',
      label: t('users.perm.networkManage.label'),
      description: t('users.perm.networkManage.desc'),
      roles: ['admin'],
    },
    {
      key: 'storage.upload',
      label: t('users.perm.storageUpload.label'),
      description: t('users.perm.storageUpload.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'task.view',
      label: t('users.perm.taskView.label'),
      description: t('users.perm.taskView.desc'),
      roles: ['admin', 'operator', 'viewer'],
    },
    {
      key: 'task.control',
      label: t('users.perm.taskControl.label'),
      description: t('users.perm.taskControl.desc'),
      roles: ['admin', 'operator'],
    },
    {
      key: 'user.manage',
      label: t('users.perm.userManage.label'),
      description: t('users.perm.userManage.desc'),
      roles: ['admin'],
    },
    {
      key: 'audit.view',
      label: t('users.perm.auditView.label'),
      description: t('users.perm.auditView.desc'),
      roles: ['admin'],
    },
    {
      key: 'config.manage',
      label: t('users.perm.configManage.label'),
      description: t('users.perm.configManage.desc'),
      roles: ['admin'],
    },
  ];
}

const ROLE_ORDER: PanelRole[] = ['admin', 'operator', 'viewer'];

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Users() {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isAdmin, user: currentUser } = useAuth();

  const permissionMatrixData = useMemo(() => permissionMatrix(t), [t]);
  const permissionColumnsData = useMemo(() => permissionColumns(t), [t]);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserOut | null>(null);
  const [resetTarget, setResetTarget] = useState<UserOut | null>(null);
  /* 注册审批：通过时要顺带定角色与权限，所以走独立弹窗；拒绝只需确认 */
  const [approveTarget, setApproveTarget] = useState<UserOut | null>(null);
  const [rejectTarget, setRejectTarget] = useState<UserOut | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---- 用户列表 ---- */
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    staleTime: 20_000,
  });

  /* ---- 角色列表 ---- */
  const rolesQuery = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => usersApi.roles(),
    staleTime: 300_000,
    retry: false,
  });

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter && u.role !== roleFilter) return false;
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q) ||
        (u.comment ?? '').toLowerCase().includes(q)
      );
    });
  }, [users, search, roleFilter]);

  /* 等待审批的注册申请：直接从完整列表里筛，不额外发一次请求 */
  const pendingUsers = useMemo(
    () => users.filter((u) => isPendingApproval(u.status)),
    [users],
  );

  const stats = useMemo(() => {
    const byRole = { admin: 0, operator: 0, viewer: 0 };
    let disabled = 0;
    users.forEach((u) => {
      // 待审批的账号还没定角色，别混进角色统计里误导人
      if (isPendingApproval(u.status)) return;
      if (u.role in byRole) byRole[u.role as PanelRole] += 1;
      if (u.enabled === false) disabled += 1;
    });
    return {
      total: users.length,
      ...byRole,
      disabled,
      pending: pendingUsers.length,
    };
  }, [users, pendingUsers]);

  const roleOptions = useMemo(() => {
    const fromApi = rolesQuery.data;
    if (fromApi && fromApi.length > 0) {
      return fromApi.map((r) => ({ label: roleLabel(r), value: r.id }));
    }
    return ROLE_ORDER.map((r) => ({ label: roleMeta(r, t).label, value: r }));
  }, [rolesQuery.data, t]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<UserOut>> = [
    {
      key: 'username',
      header: t('users.colUsername'),
      render: (u) => (
        <div className="vm-name-cell">
          <span className="fw-500 flex items-center gap-6">
            {u.username}
            {u.username === currentUser?.username ? (
              <Badge variant="accent" size="sm">
                {t('users.currentLogin')}
              </Badge>
            ) : null}
          </span>
          {u.email ? (
            <span className="fs-xs text-muted">{u.email}</span>
          ) : null}
        </div>
      ),
      sortable: true,
      sortValue: (u) => u.username,
    },
    {
      key: 'role',
      header: t('users.colRole'),
      width: 120,
      render: (u) => {
        const meta = roleMeta(u.role, tStatic);
        return (
          <Badge variant={meta.variant} dot size="sm">
            {meta.label}
          </Badge>
        );
      },
      sortable: true,
      sortValue: (u) => u.role,
    },
    {
      key: 'enabled',
      header: t('common.status'),
      width: 110,
      render: (u) => {
        // 待审批 / 已拒绝比「启用与否」更值得先说：这类账号根本登不进来，
        // 再显示一个绿色的「已启用」只会自相矛盾。
        const meta = isPendingApproval(u.status) || u.status === 'rejected'
          ? userStatusMeta(u.status, tStatic)
          : userEnabledMeta(u.enabled, tStatic);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'comment',
      header: t('users.fieldComment'),
      render: (u) => (
        <span className="fs-sm text-secondary truncate" title={u.comment}>
          {u.comment || '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: t('common.createdAt'),
      width: 170,
      render: (u) => (
        <span className="mono fs-sm">
          {u.created ? formatDateTime(u.created) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 130,
      align: 'right',
      render: (u) => (
        <span className="row-actions">
          <IconButton
            label={t('users.editUserAria', { name: u.username })}
            variant="primary"
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setEditTarget(u);
              setEditorOpen(true);
            }}
          >
            <IconEdit size={15} />
          </IconButton>
          <IconButton
            label={t('users.resetPwAria', { name: u.username })}
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setResetTarget(u);
            }}
          >
            <IconKey size={15} />
          </IconButton>
          <IconButton
            label={t('users.deleteUserAria', { name: u.username })}
            variant="danger"
            disabled={!isAdmin || u.username === currentUser?.username}
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(u);
            }}
          >
            <IconTrash size={15} />
          </IconButton>
        </span>
      ),
    },
  ];

  /* ---- 待审批列表列：只有「通过」「拒绝」两个动作 ---- */
  const pendingColumns: Array<Column<UserOut>> = [
    {
      key: 'username',
      header: t('users.colUsername'),
      render: (u) => (
        <div className="vm-name-cell">
          <span className="fw-500">{u.username}</span>
          <span className="fs-xs text-muted">
            {u.email || t('users.emailMissing')}
          </span>
        </div>
      ),
    },
    {
      key: 'created',
      header: t('users.colAppliedAt'),
      width: 180,
      render: (u) => (
        <span className="mono fs-sm">
          {u.created ? formatDateTime(u.created) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('users.colApprove'),
      width: 160,
      align: 'right',
      render: (u) => (
        <span className="row-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setApproveTarget(u);
            }}
          >
            {t('users.approve')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setRejectTarget(u);
            }}
          >
            {t('users.reject')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <PageShell
      title={
        <>
          <IconUsers size={20} />
          {t('users.title')}
        </>
      }
      subtitle={t('users.subtitle')}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => invalidate()}
            loading={usersQuery.isFetching && !usersQuery.isLoading}
          >
            {t('common.refresh')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlus size={15} />}
            disabled={!isAdmin}
            onClick={() => {
              setEditTarget(null);
              setEditorOpen(true);
            }}
          >
            {t('users.newUser')}
          </Button>
        </>
      }
    >
      {!isAdmin ? (
        <Notice tone="info" title={t('users.readonlyTitle')}>
          {t('users.readonlyBody')}
        </Notice>
      ) : null}

      {/* 统计 */}
      <div className="grid grid-5">
        <KpiCard
          label={t('users.kpiTotal')}
          value={stats.total}
          icon={<IconUsers size={18} />}
          tone="accent"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label={t('status.role.admin')}
          value={stats.admin}
          icon={<IconShield size={18} />}
          tone="danger"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label={t('status.role.operator')}
          value={stats.operator}
          icon={<IconUser size={18} />}
          tone="warning"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label={t('users.kpiViewerDisabled')}
          value={`${stats.viewer} / ${stats.disabled}`}
          icon={<IconEye size={18} />}
          tone="neutral"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label={t('status.user.pending')}
          value={stats.pending}
          icon={<IconClock size={18} />}
          tone={stats.pending > 0 ? 'warning' : 'neutral'}
          loading={usersQuery.isLoading}
          hint={
            stats.pending > 0
              ? t('users.kpiPendingHint')
              : t('users.kpiPendingNone')
          }
        />
      </div>

      {/* ---- 待审批注册申请 ----
          只有真的有人申请时才出现，空着的时候不占地方；
          顶部「待审批」KPI 已经说明了有没有积压。 */}
      {pendingUsers.length > 0 ? (
        <Card padded={false} collapsible={false}>
          <div style={{ padding: '18px 18px 0' }}>
            <CardHeader
              title={t('users.pendingTitle')}
              subtitle={t('users.pendingSubtitle', { n: pendingUsers.length })}
              icon={<IconClock size={17} />}
            />
          </div>
          <Table<UserOut>
            columns={pendingColumns}
            rows={pendingUsers}
            rowKey={(u) => u.id ?? u.username}
            caption={t('users.pendingCaption')}
            dense
            className="table-flush"
          />
        </Card>
      ) : null}

      {/* 筛选 */}
      <div className="toolbar">
        <div className="toolbar-left">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('users.searchPlaceholder')}
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label={t('users.searchAria')}
          />
          <Select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            options={[
              { label: t('users.filterAllRoles'), value: '' },
              ...ROLE_ORDER.map((r) => ({ label: roleMeta(r, t).label, value: r })),
            ]}
            aria-label={t('users.filterRoleAria')}
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">
            {t('users.showing', { n: filtered.length })}
          </span>
        </div>
      </div>

      {usersQuery.isError && isNotImplemented(usersQuery.error) ? (
        <ErrorState
          notImplemented
          title={t('users.notImplTitle')}
          message={t('users.notImplMsg')}
          onRetry={() => void usersQuery.refetch()}
        />
      ) : usersQuery.isError ? (
        <ErrorState
          title={t('users.loadFailed')}
          message={errorMessage(usersQuery.error)}
          onRetry={() => void usersQuery.refetch()}
        />
      ) : (
        <Table<UserOut>
          columns={columns}
          rows={filtered}
          rowKey={(u) => u.id ?? u.username}
          loading={usersQuery.isLoading}
          caption={t('users.listCaption')}
          emptyTitle={
            search || roleFilter ? t('users.emptySearch') : t('users.empty')
          }
          emptyDescription={
            search || roleFilter ? t('users.emptySearchDesc') : undefined
          }
        />
      )}

      {/* ---- 角色权限说明 ---- */}
      <Card>
        <CardHeader
          title={t('users.rolesTitle')}
          subtitle={t('users.rolesSubtitle')}
          icon={<IconShield size={17} />}
        />
        <div className="grid grid-3 mb-16">
          {ROLE_ORDER.map((role) => (
            <RoleCard
              key={role}
              role={role}
              info={(rolesQuery.data ?? []).find((r) => r.id === role)}
            />
          ))}
        </div>

        <Table<PermissionRow>
          columns={permissionColumnsData}
          rows={permissionMatrixData}
          rowKey={(p) => p.key}
          caption={t('users.permCaption')}
          dense
          className="perm-matrix"
        />
      </Card>

      <CollapsibleCard title={t('users.securityTitle')} icon={<IconKey size={15} />}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">{t('users.secPwStore')}</div>
            <div className="desc-value">{t('users.secPwStoreBody')}</div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('users.secToken')}</div>
            <div className="desc-value">{t('users.secTokenBody')}</div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('users.secPve')}</div>
            <div className="desc-value">{t('users.secPveBody')}</div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('users.secDefault')}</div>
            <div className="desc-value">{t('users.secDefaultBody')}</div>
          </div>
        </div>
      </CollapsibleCard>

      {/* ---- 编辑器 ---- */}
      <UserEditor
        open={editorOpen}
        user={editTarget}
        roleOptions={roleOptions}
        onClose={() => setEditorOpen(false)}
        onDone={() => {
          setEditorOpen(false);
          invalidate();
        }}
        existingUsers={users}
      />

      {/* ---- 审批通过：分角色 + 可选自定义权限 ---- */}
      <ApprovalDialog
        user={approveTarget}
        roleOptions={roleOptions}
        onClose={() => setApproveTarget(null)}
        onDone={() => {
          setApproveTarget(null);
          invalidate();
        }}
      />

      {/* ---- 审批拒绝 ---- */}
      <ConfirmDialog
        open={Boolean(rejectTarget)}
        onCancel={() => setRejectTarget(null)}
        onConfirm={async () => {
          if (!rejectTarget) return;
          setBusy(true);
          try {
            await usersApi.reject(rejectTarget.username, t('users.rejectReason'));
            toast.success(t('users.rejectedToast', { name: rejectTarget.username }));
            setRejectTarget(null);
            invalidate();
          } catch (err) {
            toast.error(t('users.rejectFailed'), errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title={t('users.rejectTitle')}
        danger
        confirmText={t('users.rejectConfirm')}
        loading={busy}
        message={t('users.rejectMessage', { name: rejectTarget?.username ?? '' })}
      />

      {/* ---- 重置密码 ---- */}
      <ResetPasswordDialog
        user={resetTarget}
        onClose={() => setResetTarget(null)}
        onDone={() => {
          setResetTarget(null);
          invalidate();
        }}
      />

      {/* ---- 删除 ---- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await usersApi.remove(deleteTarget.username);
            toast.success(t('users.deletedToast', { name: deleteTarget.username }));
            setDeleteTarget(null);
            invalidate();
          } catch (err) {
            toast.error(t('users.deleteFailed'), errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title={t('users.deleteTitle')}
        danger
        confirmText={t('users.deleteConfirm')}
        loading={busy}
        requireText={deleteTarget?.username}
        message={t('users.deleteMessage', {
          name: deleteTarget?.username ?? '',
          role: roleMeta(deleteTarget?.role, t).label,
        })}
      />

      <RoleManager />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   权限矩阵列
   --------------------------------------------------------------------------- */

function permissionColumns(t: TFunc): Array<Column<PermissionRow>> {
  return [
    {
      key: 'label',
      header: t('users.permColLabel'),
      render: (p) => (
        <div className="vm-name-cell">
          <span className="fw-500">{p.label}</span>
          <span className="fs-xs text-muted mono">{p.key}</span>
        </div>
      ),
    },
    {
      key: 'description',
      header: t('users.permColDesc'),
      render: (p) => (
        <span className="fs-sm text-secondary">{p.description}</span>
      ),
    },
    ...ROLE_ORDER.map<Column<PermissionRow>>((role) => ({
      key: `role-${role}`,
      header: roleMeta(role, t).label,
      width: 90,
      align: 'center',
      render: (p) =>
        p.roles.includes(role) ? (
          <span className="perm-yes" title={t('users.permYes')}>
            <IconCheck size={16} />
            <span className="sr-only">{t('users.permYesShort')}</span>
          </span>
        ) : (
          <span className="perm-no" title={t('users.permNo')}>
            <IconClose size={16} />
            <span className="sr-only">{t('users.permNoShort')}</span>
          </span>
        ),
    })),
  ];
}

/* ---------------------------------------------------------------------------
   角色卡片
   --------------------------------------------------------------------------- */

function RoleCard({ role, info }: { role: PanelRole; info?: RoleOut }) {
  const t = useT();
  const meta = roleMeta(role, t);
  const matrix = permissionMatrix(t);
  const count = matrix.filter((p) => p.roles.includes(role)).length;

  const description: Record<PanelRole, string> = {
    admin: t('users.roleAdminDesc'),
    operator: t('users.roleOperatorDesc'),
    viewer: t('users.roleViewerDesc'),
  };

  return (
    <div className="entity-card">
      <div className="entity-card-head">
        <div className="entity-card-title">
          <Badge variant={meta.variant} dot size="sm">
            {meta.label}
          </Badge>
        </div>
        <span className="fs-xs text-muted mono">{role}</span>
      </div>
      <div className="fs-sm text-secondary">{description[role]}</div>
      <div className="fs-xs text-muted">
        {t('users.rolePermissionCount', { n: count, total: matrix.length })}
        {info?.permissions && info.permissions.length > 0
          ? t('users.roleBackendDeclared', { n: info.permissions.length })
          : ''}
      </div>
      {info?.description ? (
        <div className="fs-xs text-muted">{info.description}</div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   用户编辑器
   --------------------------------------------------------------------------- */

function UserEditor({
  open,
  user,
  roleOptions,
  onClose,
  onDone,
  existingUsers,
}: {
  open: boolean;
  user: UserOut | null;
  roleOptions: Array<{ label: string; value: string }>;
  onClose: () => void;
  onDone: () => void;
  existingUsers: UserOut[];
}) {
  const t = useT();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<string>('viewer');
  const [email, setEmail] = useState('');
  const [comment, setComment] = useState('');
  const [enabled, setEnabled] = useState(true);
  /* 审批状态：编辑已有用户时允许改，用来恢复被拒绝的注册 */
  const [status, setStatus] = useState<string>('active');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /* 权限：useOverride=false 表示「跟随角色」，true 表示手动勾选一组权限 */
  const [perms, setPerms] = useState<string[]>([]);
  const [useOverride, setUseOverride] = useState(false);

  const isEdit = Boolean(user);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 角色自带的权限，作为「跟随角色」时展示/回退用 */
  const rolePerms = useMemo(
    () => rolesQuery.data?.find((r) => r.id === role)?.permissions ?? [],
    [rolesQuery.data, role],
  );

  /* 打开时初始化表单 */
  useEffect(() => {
    if (!open) return;
    if (user) {
      setUsername(user.username);
      setRole(user.role);
      setEmail(user.email ?? '');
      setComment(user.comment ?? '');
      setEnabled(user.enabled ?? true);
      setStatus(user.status ?? 'active');
      setPassword('');
      setConfirm('');
      // 该用户若有自己的权限覆盖，界面按它预填并切到「自定义」模式
      const override = user.permissions_override;
      setUseOverride(override != null);
      setPerms(override ?? []);
    } else {
      setUsername('');
      setRole('viewer');
      setEmail('');
      setComment('');
      setEnabled(true);
      setStatus('active');
      setPassword('');
      setConfirm('');
      setUseOverride(false);
      setPerms([]);
    }
    setShowPassword(false);
    setErrors({});
  }, [open, user]);

  /* 跟随角色时，勾选结果随角色变化（但不要覆盖用户手动改的） */
  useEffect(() => {
    if (useOverride) return;
    setPerms(rolePerms);
  }, [rolePerms, useOverride]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};

    if (!isEdit) {
      const name = username.trim();
      if (!name) next.username = t('users.validation.usernameRequired');
      else if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) {
        next.username = t('users.validation.usernameFormat');
      } else if (
        existingUsers.some(
          (u) => u.username.toLowerCase() === name.toLowerCase(),
        )
      ) {
        next.username = t('users.validation.usernameExists');
      }
    }

    if (!isEdit || password) {
      if (!password) next.password = t('users.validation.passwordRequired');
      else if (password.length < 8) next.password = t('users.validation.passwordMin');
      else if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
        next.password = t('users.validation.passwordAlnum');
      }
      if (password !== confirm) next.confirm = t('users.validation.passwordMismatch');
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.email = t('users.validation.emailFormat');
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      if (isEdit && user) {
        await usersApi.update(user.username, {
          role,
          email: email.trim() || undefined,
          enabled,
          password: password || undefined,
          permissions: useOverride ? perms : null,
          set_permissions: true,
          status: status as UserAccountStatus,
        });
        toast.success(t('users.updatedToast', { name: user.username }));
      } else {
        await usersApi.create({
          username: username.trim(),
          password,
          role,
          email: email.trim() || undefined,
          comment: comment.trim() || undefined,
          permissions: useOverride ? perms : null,
        });
        toast.success(
          t('users.createdToast', { name: username.trim() }),
          t('users.createdRoleToast', { role: roleLabelByValue(role, roleOptions) }),
        );
      }
      setPassword('');
      setConfirm('');
      onDone();
    } catch (err) {
      toast.error(
        isEdit ? t('users.updateFailed') : t('users.createFailed'),
        errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        isEdit
          ? t('users.editUserTitle', { name: user?.username ?? '' })
          : t('users.newUserTitle')
      }
      description={
        isEdit ? t('users.editorDescEdit') : t('users.editorDescNew')
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
          >
            {isEdit ? t('users.saveChanges') : t('users.createUser')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field
          label={t('users.fieldUsername')}
          required={!isEdit}
          error={errors.username}
          hint={
            isEdit ? t('users.fieldUsernameHintEdit') : t('users.fieldUsernameHintNew')
          }
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isEdit}
            autoComplete="off"
            placeholder="zhangsan"
          />
        </Field>

        <Field
          label={isEdit ? t('users.fieldPasswordEdit') : t('users.fieldPassword')}
          required={!isEdit}
          error={errors.password}
          hint={password ? t('users.passwordHint') : undefined}
        >
          <Input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={
              isEdit ? t('users.passwordPlaceholderEdit') : t('users.passwordPlaceholder')
            }
            suffix={
              <IconButton
                label={showPassword ? t('users.hidePassword') : t('users.showPassword')}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </IconButton>
            }
          />
        </Field>

        {!isEdit || password ? (
          <Field label={t('users.fieldConfirmPassword')} required error={errors.confirm}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : null}

        <Field
          label={t('users.fieldRole')}
          required
          hint={t('users.fieldRoleHint')}
        >
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={roleOptions}
          />
        </Field>

        {/* ---- 权限：默认跟随角色，可切到自定义逐条勾选 ---- */}
        <div className="perm-block">
          <div className="perm-block-head">
            <span className="fw-600">{t('users.permBlock')}</span>
            <span className="fs-xs text-muted">
              {useOverride
                ? t('users.permCustom', { n: perms.length })
                : t('users.permFollowing', {
                    name: roleLabelByValue(role, roleOptions),
                  })}
            </span>
          </div>

          <Switch
            checked={useOverride}
            onChange={(v) => {
              setUseOverride(v);
              if (!v) setPerms(rolePerms);
            }}
            label={t('users.customPermsLabel')}
            hint={t('users.customPermsHint')}
          />

          <PermissionPicker
            value={perms}
            onChange={setPerms}
            disabled={!useOverride}
          />
        </div>

        <Field
          label={t('users.fieldEmail')}
          error={errors.email}
          hint={t('users.fieldEmailHint')}
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            autoComplete="off"
          />
        </Field>

        {!isEdit ? (
          <Field label={t('users.fieldComment')}>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder={t('users.commentPlaceholder')}
            />
          </Field>
        ) : (
          <>
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label={t('users.enableAccount')}
              hint={t('users.enableAccountHint')}
            />
            <Field
              label={t('users.fieldApprovalStatus')}
              hint={t('users.fieldApprovalStatusHint')}
            >
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={[
                  { label: t('users.statusActive'), value: 'active' },
                  { label: t('users.statusPending'), value: 'pending' },
                  { label: t('users.statusRejected'), value: 'rejected' },
                ]}
              />
            </Field>
          </>
        )}
      </div>

      <Notice tone="info" title={t('users.pwSecurityTitle')}>
        {t('users.pwSecurityBody')}
      </Notice>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   注册审批：通过时一次把角色与权限定好
   --------------------------------------------------------------------------- */

function ApprovalDialog({
  user,
  roleOptions,
  onClose,
  onDone,
}: {
  user: UserOut | null;
  roleOptions: Array<{ label: string; value: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const open = Boolean(user);

  const [role, setRole] = useState<string>('viewer');
  const [perms, setPerms] = useState<string[]>([]);
  const [useOverride, setUseOverride] = useState(false);
  const [busy, setBusy] = useState(false);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const rolePerms = useMemo(
    () => rolesQuery.data?.find((r) => r.id === role)?.permissions ?? [],
    [rolesQuery.data, role],
  );

  /* 每次打开都从「跟随角色」重新起步，避免上一次的勾选残留到这一次 */
  useEffect(() => {
    if (!open) return;
    setRole(user?.role || 'viewer');
    setUseOverride(false);
    setPerms([]);
  }, [open, user]);

  useEffect(() => {
    if (useOverride) return;
    setPerms(rolePerms);
  }, [rolePerms, useOverride]);

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await usersApi.approve(user.username, {
        role,
        permissions: useOverride ? perms : null,
        set_permissions: true,
      });
      toast.success(
        t('users.approvedToast', { name: user.username }),
        t('users.createdRoleToast', { role: roleLabelByValue(role, roleOptions) }),
      );
      onDone();
    } catch (err) {
      toast.error(t('users.approveFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        user
          ? t('users.approveTitleWith', { name: user.username })
          : t('users.approveTitle')
      }
      description={t('users.approveDesc')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
          >
            {t('users.approveConfirm')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label={t('users.fieldApplicant')}>
          <Input value={user?.username ?? ''} disabled readOnly />
        </Field>

        <Field label={t('users.fieldEmail')}>
          <Input
            value={user?.email || t('users.emailNotProvided')}
            disabled
            readOnly
          />
        </Field>

        <Field label={t('users.colAppliedAt')}>
          <Input
            value={user?.created ? formatDateTime(user.created) : '—'}
            disabled
            readOnly
            mono
          />
        </Field>

        <Field
          label={t('users.fieldRole')}
          required
          hint={t('users.fieldRoleHint')}
        >
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={roleOptions}
          />
        </Field>

        {/* ---- 权限：默认跟随角色，可切到自定义逐条勾选 ---- */}
        <div className="perm-block">
          <div className="perm-block-head">
            <span className="fw-600">{t('users.permBlock')}</span>
            <span className="fs-xs text-muted">
              {useOverride
                ? t('users.permCustom', { n: perms.length })
                : t('users.permFollowing', {
                    name: roleLabelByValue(role, roleOptions),
                  })}
            </span>
          </div>

          <Switch
            checked={useOverride}
            onChange={(v) => {
              setUseOverride(v);
              if (!v) setPerms(rolePerms);
            }}
            label={t('users.permsForUserLabel')}
            hint={t('users.customPermsHint')}
          />

          <PermissionPicker
            value={perms}
            onChange={setPerms}
            disabled={!useOverride}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   重置密码
   --------------------------------------------------------------------------- */

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserOut | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    setPassword('');
    setConfirm('');
    setShow(false);
    setError('');
  }, [user]);

  const submit = async () => {
    if (!user) return;
    if (password.length < 8) {
      setError(t('users.validation.passwordMin'));
      return;
    }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError(t('users.validation.passwordAlnum'));
      return;
    }
    if (password !== confirm) {
      setError(t('users.validation.passwordMismatch'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      await usersApi.update(user.username, { password });
      toast.success(
        t('users.resetSuccessToast', { name: user.username }),
        t('users.resetSuccessDetail'),
      );
      onDone();
    } catch (err) {
      toast.error(t('users.resetFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={t('users.resetTitle', { name: user?.username ?? '' })}
      description={t('users.resetDesc')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<IconKey size={15} />}
            onClick={() => void submit()}
            loading={busy}
            disabled={!password || !confirm}
          >
            {t('users.resetAction')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label={t('users.fieldNewPassword')} required error={error || undefined}>
          <Input
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            placeholder={t('users.passwordPlaceholder')}
            suffix={
              <IconButton
                label={show ? t('users.hidePassword') : t('users.showPassword')}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </IconButton>
            }
          />
        </Field>

        <Field label={t('users.fieldConfirmNewPassword')} required>
          <Input
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </Field>
      </div>

      <Notice tone="warning" title={t('users.resetNotifyTitle')}>
        {t('users.resetNotifyBody')}
      </Notice>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   工具
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   角色管理：admin 可新建 / 编辑 / 删除自定义角色
   --------------------------------------------------------------------------- */

function RoleManager() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleOut | null>(null);
  const [busy, setBusy] = useState(false);

  const rolesQuery = useQuery({ queryKey: ['roles'], queryFn: () => rolesApi.list() });
  const roles = rolesQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['roles'] });
    void queryClient.invalidateQueries({ queryKey: ['users', 'roles'] });
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await rolesApi.remove(deleteTarget.id);
      toast.success(t('users.roleDeletedToast'), deleteTarget.name);
      setDeleteTarget(null);
      invalidate();
    } catch (err) {
      toast.error(t('users.roleDeleteFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader
        title={t('users.roleManagerTitle')}
        subtitle={t('users.roleManagerSubtitle')}
        icon={<IconShield size={17} />}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlus size={14} />}
            onClick={() => {
              setEditTarget(null);
              setEditorOpen(true);
            }}
          >
            {t('users.newRole')}
          </Button>
        }
      />

      {rolesQuery.isLoading ? (
        <div className="fs-sm text-muted">{t('users.rolesLoading')}</div>
      ) : (
        <div className="flex flex-col gap-8">
          {roles.map((r) => (
            <div className="role-row" key={r.id}>
              <div className="role-row-main">
                <span className="set-node-icon">
                  <IconShield size={15} />
                </span>
                <div className="set-node-text">
                  <span className="set-node-name">
                    {r.name}
                    {r.builtin ? (
                      <Badge variant="neutral" size="sm">
                        {t('users.builtin')}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="fs-xs text-muted mono">{r.id}</span>
                  <span className="fs-xs text-muted">{r.description || '—'}</span>
                </div>
              </div>

              <div className="set-conn-tags set-conn-meta">
                <span>{t('users.permCount', { n: r.permissions.length })}</span>
                <span>{t('users.userCount', { n: r.user_count ?? 0 })}</span>
              </div>

              <div className="set-conn-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={r.id === 'admin'}
                  onClick={() => {
                    setEditTarget(r);
                    setEditorOpen(true);
                  }}
                >
                  {t('common.edit')}
                </Button>
                <IconButton
                  label={t('users.deleteRoleAria', { name: r.name })}
                  variant="danger"
                  disabled={r.builtin || (r.user_count ?? 0) > 0}
                  onClick={() => setDeleteTarget(r)}
                >
                  <IconTrash size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <RoleEditor
        open={editorOpen}
        role={editTarget}
        onClose={() => setEditorOpen(false)}
        onDone={() => {
          setEditorOpen(false);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          await remove();
        }}
        title={t('users.deleteRoleTitle')}
        danger
        confirmText={t('users.deleteRoleConfirm')}
        loading={busy}
        requireText={deleteTarget?.name}
        message={t('users.deleteRoleMessage', { name: deleteTarget?.name ?? '' })}
      />
    </Card>
  );
}


function RoleEditor({
  open,
  role,
  onClose,
  onDone,
}: {
  open: boolean;
  role: RoleOut | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [perms, setPerms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEdit = Boolean(role);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setPerms(role?.permissions ?? []);
    setErrors({});
  }, [open, role]);

  const submit = async () => {
    const cleaned = name.trim();
    if (!cleaned) {
      setErrors({ name: t('users.roleNameRequired') });
      return;
    }
    setBusy(true);
    try {
      if (isEdit && role) {
        await rolesApi.update(role.id, {
          name: cleaned,
          description: description.trim(),
          permissions: perms,
        });
        toast.success(t('users.roleUpdatedToast'), cleaned);
      } else {
        await rolesApi.create({
          name: cleaned,
          description: description.trim(),
          permissions: perms,
        });
        toast.success(t('users.roleCreatedToast'), cleaned);
      }
      onDone();
    } catch (err) {
      toast.error(
        isEdit ? t('users.roleUpdateFailed') : t('users.roleCreateFailed'),
        errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        isEdit
          ? t('users.roleEditTitle', { name: role?.name ?? '' })
          : t('users.roleNewTitle')
      }
      description={t('users.roleEditorDesc')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {isEdit ? t('users.saveChanges') : t('users.roleCreate')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label={t('users.fieldRoleName')} required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('users.roleNamePlaceholder')}
          />
        </Field>

        <Field label={t('users.fieldDesc')} hint={t('users.fieldDescHint')}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder={t('users.roleDescPlaceholder')}
          />
        </Field>

        <div className="perm-block">
          <div className="perm-block-head">
            <span className="fw-600">{t('users.permBlock')}</span>
            <span className="fs-xs text-muted">
              {t('users.selectedCount', { n: perms.length })}
            </span>
          </div>
          <PermissionPicker value={perms} onChange={setPerms} />
        </div>
      </div>
    </Modal>
  );
}


function roleLabel(info: RoleOut): string {
  // 自定义角色用它的名字，内置角色用既有映射
  if (info.name) return info.name;
  return roleMeta(String(info.id) as PanelRole, tStatic).label;
}

function roleLabelByValue(
  value: string,
  options: Array<{ label: string; value: string }>,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
