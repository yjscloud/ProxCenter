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
} from '../utils/status';
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

const PERMISSION_MATRIX: PermissionRow[] = [
  {
    key: 'vm.view',
    label: '查看虚拟机',
    description: '浏览虚拟机列表、详情、监控图表与控制台',
    roles: ['admin', 'operator', 'viewer'],
  },
  {
    key: 'vm.console',
    label: '使用控制台',
    description: '打开 VNC 图形控制台，可直接操作虚拟机 / 容器内部',
    roles: ['admin', 'operator'],
  },
  {
    key: 'vm.power',
    label: '电源操作',
    description: '启动、关闭、重启、挂起虚拟机',
    roles: ['admin', 'operator'],
  },
  {
    key: 'vm.create',
    label: '创建与克隆',
    description: '创建虚拟机、克隆、从模板部署',
    roles: ['admin', 'operator'],
  },
  {
    key: 'vm.delete',
    label: '删除虚拟机',
    description: '销毁虚拟机并清理其磁盘',
    roles: ['admin'],
  },
  {
    key: 'vm.config',
    label: '修改配置',
    description: '调整 CPU、内存、磁盘、网卡等硬件配置',
    roles: ['admin', 'operator'],
  },
  {
    key: 'vm.snapshot',
    label: '快照管理',
    description: '创建、回滚、删除虚拟机快照',
    roles: ['admin', 'operator'],
  },
  {
    key: 'vm.migrate',
    label: '迁移虚拟机',
    description: '在节点之间在线或离线迁移虚拟机',
    roles: ['admin'],
  },
  {
    key: 'backup.view',
    label: '查看备份',
    description: '浏览、下载备份文件',
    roles: ['admin', 'operator', 'viewer'],
  },
  {
    key: 'backup.create',
    label: '创建与恢复备份',
    description: '立即备份、恢复备份、管理备份计划',
    roles: ['admin', 'operator'],
  },
  {
    key: 'backup.delete',
    label: '删除备份',
    description: '删除备份文件与备份计划',
    roles: ['admin'],
  },
  {
    key: 'node.view',
    label: '查看节点',
    description: '浏览节点状态、存储、网络配置',
    roles: ['admin', 'operator', 'viewer'],
  },
  {
    key: 'network.manage',
    label: '修改网络配置',
    description: '新增/修改/删除网桥、VLAN、物理网卡绑定（普通用户仅可查看）',
    roles: ['admin'],
  },
  {
    key: 'storage.upload',
    label: '上传镜像',
    description: '向存储上传 ISO 与容器模板',
    roles: ['admin', 'operator'],
  },
  {
    key: 'task.view',
    label: '查看任务',
    description: '浏览任务队列与实时日志',
    roles: ['admin', 'operator', 'viewer'],
  },
  {
    key: 'task.control',
    label: '控制任务',
    description: '停止运行中的任务、清理任务记录',
    roles: ['admin', 'operator'],
  },
  {
    key: 'user.manage',
    label: '用户管理',
    description: '创建、编辑、删除面板用户，分配角色',
    roles: ['admin'],
  },
  {
    key: 'audit.view',
    label: '审计日志',
    description: '查看所有操作审计记录',
    roles: ['admin'],
  },
  {
    key: 'config.manage',
    label: '连接配置',
    description: '修改 Proxmox 集群连接参数与 API Token',
    roles: ['admin'],
  },
];

const ROLE_ORDER: PanelRole[] = ['admin', 'operator', 'viewer'];

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Users() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isAdmin, user: currentUser } = useAuth();

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
    return ROLE_ORDER.map((r) => ({ label: roleMeta(r).label, value: r }));
  }, [rolesQuery.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  /* ---- 表格列 ---- */
  const columns: Array<Column<UserOut>> = [
    {
      key: 'username',
      header: '用户名',
      render: (u) => (
        <div className="vm-name-cell">
          <span className="fw-500 flex items-center gap-6">
            {u.username}
            {u.username === currentUser?.username ? (
              <Badge variant="accent" size="sm">
                当前登录
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
      header: '角色',
      width: 120,
      render: (u) => {
        const meta = roleMeta(u.role);
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
      header: '状态',
      width: 110,
      render: (u) => {
        // 待审批 / 已拒绝比「启用与否」更值得先说：这类账号根本登不进来，
        // 再显示一个绿色的「已启用」只会自相矛盾。
        const meta = isPendingApproval(u.status) || u.status === 'rejected'
          ? userStatusMeta(u.status)
          : userEnabledMeta(u.enabled);
        return (
          <Badge variant={meta.variant} dot pulse={meta.pulse} size="sm">
            {meta.label}
          </Badge>
        );
      },
    },
    {
      key: 'comment',
      header: '备注',
      render: (u) => (
        <span className="fs-sm text-secondary truncate" title={u.comment}>
          {u.comment || '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: '创建时间',
      width: 170,
      render: (u) => (
        <span className="mono fs-sm">
          {u.created ? formatDateTime(u.created) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 130,
      align: 'right',
      render: (u) => (
        <span className="row-actions">
          <IconButton
            label={`编辑用户 ${u.username}`}
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
            label={`重置密码 ${u.username}`}
            disabled={!isAdmin}
            onClick={(e) => {
              e.stopPropagation();
              setResetTarget(u);
            }}
          >
            <IconKey size={15} />
          </IconButton>
          <IconButton
            label={`删除用户 ${u.username}`}
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
      header: '用户名',
      render: (u) => (
        <div className="vm-name-cell">
          <span className="fw-500">{u.username}</span>
          <span className="fs-xs text-muted">
            {u.email || '未填写邮箱'}
          </span>
        </div>
      ),
    },
    {
      key: 'created',
      header: '申请时间',
      width: 180,
      render: (u) => (
        <span className="mono fs-sm">
          {u.created ? formatDateTime(u.created) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '审批',
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
            通过
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
            拒绝
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
          用户管理
        </>
      }
      subtitle="管理面板账号与角色分配，所有操作均记录到审计日志"
      actions={
        <>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            onClick={() => invalidate()}
            loading={usersQuery.isFetching && !usersQuery.isLoading}
          >
            刷新
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
            新建用户
          </Button>
        </>
      }
    >
      {!isAdmin ? (
        <Notice tone="info" title="只读视图">
          用户管理仅对管理员开放。你可以查看现有账号与角色权限说明，
          但无法进行创建、编辑或删除操作。
        </Notice>
      ) : null}

      {/* 统计 */}
      <div className="grid grid-5">
        <KpiCard
          label="用户总数"
          value={stats.total}
          icon={<IconUsers size={18} />}
          tone="accent"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label="管理员"
          value={stats.admin}
          icon={<IconShield size={18} />}
          tone="danger"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label="普通用户"
          value={stats.operator}
          icon={<IconUser size={18} />}
          tone="warning"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label="只读 / 已禁用"
          value={`${stats.viewer} / ${stats.disabled}`}
          icon={<IconEye size={18} />}
          tone="neutral"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label="待审批"
          value={stats.pending}
          icon={<IconClock size={18} />}
          tone={stats.pending > 0 ? 'warning' : 'neutral'}
          loading={usersQuery.isLoading}
          hint={
            stats.pending > 0
              ? '自助注册的账号，需分配角色后才能登录'
              : '没有待处理的注册申请'
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
              title="待审批注册申请"
              subtitle={`${pendingUsers.length} 个账号等待审批，通过时可一并分配角色与权限`}
              icon={<IconClock size={17} />}
            />
          </div>
          <Table<UserOut>
            columns={pendingColumns}
            rows={pendingUsers}
            rowKey={(u) => u.id ?? u.username}
            caption="等待管理员审批的注册申请"
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
            placeholder="搜索用户名、邮箱、备注…"
            prefix={<IconSearch size={15} />}
            block={false}
            aria-label="搜索用户"
          />
          <Select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            options={[
              { label: '全部角色', value: '' },
              ...ROLE_ORDER.map((r) => ({ label: roleMeta(r).label, value: r })),
            ]}
            aria-label="按角色筛选"
          />
        </div>
        <div className="toolbar-right">
          <span className="fs-sm text-muted">显示 {filtered.length} 个用户</span>
        </div>
      </div>

      {usersQuery.isError && isNotImplemented(usersQuery.error) ? (
        <ErrorState
          notImplemented
          title="用户管理接口尚未实现"
          message="后端 /users 返回未实现。建议后端把面板用户存到独立数据库表，不要复用 Proxmox 的 PVE 用户体系。"
          onRetry={() => void usersQuery.refetch()}
        />
      ) : usersQuery.isError ? (
        <ErrorState
          title="无法加载用户列表"
          message={errorMessage(usersQuery.error)}
          onRetry={() => void usersQuery.refetch()}
        />
      ) : (
        <Table<UserOut>
          columns={columns}
          rows={filtered}
          rowKey={(u) => u.id ?? u.username}
          loading={usersQuery.isLoading}
          caption="面板用户列表"
          emptyTitle={search || roleFilter ? '没有匹配的用户' : '暂无用户'}
          emptyDescription={
            search || roleFilter ? '尝试调整搜索关键词或筛选条件。' : undefined
          }
        />
      )}

      {/* ---- 角色权限说明 ---- */}
      <Card>
        <CardHeader
          title="角色与权限"
          subtitle="面板采用三级角色模型，权限点由后端在 JWT 中下发"
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
          columns={PERMISSION_COLUMNS}
          rows={PERMISSION_MATRIX}
          rowKey={(p) => p.key}
          caption="各角色权限对照表"
          dense
          className="perm-matrix"
        />
      </Card>

      <CollapsibleCard title="关于密码与安全策略" icon={<IconKey size={15} />}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">密码存储</div>
            <div className="desc-value">
              面板用户的密码必须在后端用 bcrypt 或 argon2 做单向哈希，
              绝不可明文落库或写入日志。前端提交后立即清空内存中的原文。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">Token 有效期</div>
            <div className="desc-value">
              建议 access_token 有效期 8 小时，并在响应中带 exp；
              前端在收到 401 时会自动清理本地会话并跳回登录页。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">Proxmox 凭据</div>
            <div className="desc-value">
              面板用同一个 API Token 访问集群，因此「面板角色」只限制面板自身的能力。
              如果需要对不同用户做 Proxmox 级别的细粒度授权，需要在后端改用
              Proxmox 的用户票据（PVEAuthCookie）而非单一 Token。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">默认账号</div>
            <div className="desc-value">
              首次部署后请立即修改默认管理员密码，并删除或禁用任何示例账号。
            </div>
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
            await usersApi.reject(
              rejectTarget.username,
              '管理员在用户管理页拒绝',
            );
            toast.success(`已拒绝 ${rejectTarget.username} 的注册申请`);
            setRejectTarget(null);
            invalidate();
          } catch (err) {
            toast.error('拒绝申请失败', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="拒绝注册申请"
        danger
        confirmText="拒绝申请"
        loading={busy}
        message={
          <>
            将拒绝 <strong>{rejectTarget?.username}</strong> 的注册申请。
            该账号会保留在列表中（状态「已拒绝」）但无法登录，
            用户名也不会被他人重复注册。如需恢复，可在编辑用户时把状态改回「正常」。
          </>
        }
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
            toast.success(`已删除用户 ${deleteTarget.username}`);
            setDeleteTarget(null);
            invalidate();
          } catch (err) {
            toast.error('删除用户失败', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="删除面板用户"
        danger
        confirmText="删除用户"
        loading={busy}
        requireText={deleteTarget?.username}
        message={
          <>
            即将删除面板账号 <strong>{deleteTarget?.username}</strong>
            （{roleMeta(deleteTarget?.role).label}）。
            该用户将无法再登录面板，但其在 Proxmox 上已执行的操作与审计记录会保留。
          </>
        }
      />

      <RoleManager />
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   权限矩阵列
   --------------------------------------------------------------------------- */

const PERMISSION_COLUMNS: Array<Column<PermissionRow>> = [
  {
    key: 'label',
    header: '权限',
    render: (p) => (
      <div className="vm-name-cell">
        <span className="fw-500">{p.label}</span>
        <span className="fs-xs text-muted mono">{p.key}</span>
      </div>
    ),
  },
  {
    key: 'description',
    header: '说明',
    render: (p) => (
      <span className="fs-sm text-secondary">{p.description}</span>
    ),
  },
  ...ROLE_ORDER.map<Column<PermissionRow>>((role) => ({
    key: `role-${role}`,
    header: roleMeta(role).label,
    width: 90,
    align: 'center',
    render: (p) =>
      p.roles.includes(role) ? (
        <span className="perm-yes" title="具备该权限">
          <IconCheck size={16} />
          <span className="sr-only">具备</span>
        </span>
      ) : (
        <span className="perm-no" title="不具备该权限">
          <IconClose size={16} />
          <span className="sr-only">不具备</span>
        </span>
      ),
  })),
];

/* ---------------------------------------------------------------------------
   角色卡片
   --------------------------------------------------------------------------- */

function RoleCard({ role, info }: { role: PanelRole; info?: RoleOut }) {
  const meta = roleMeta(role);
  const count = PERMISSION_MATRIX.filter((p) => p.roles.includes(role)).length;

  const description: Record<PanelRole, string> = {
    admin: '完全控制面板与集群，包含用户管理、网络改造、删除等高风险操作。',
    operator: '普通用户权限：电源操作、创建克隆、快照、备份恢复，不能删除虚拟机或改动网络。',
    viewer: '只读账号：可浏览所有资源与监控数据，无法执行任何修改类操作。',
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
        拥有 {count} / {PERMISSION_MATRIX.length} 项权限
        {info?.permissions && info.permissions.length > 0
          ? ` · 后端声明 ${info.permissions.length} 条`
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
      if (!name) next.username = '请填写用户名';
      else if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) {
        next.username = '3-32 位，仅允许字母、数字、点、下划线、连字符';
      } else if (
        existingUsers.some(
          (u) => u.username.toLowerCase() === name.toLowerCase(),
        )
      ) {
        next.username = '该用户名已存在';
      }
    }

    if (!isEdit || password) {
      if (!password) next.password = '请设置密码';
      else if (password.length < 8) next.password = '密码至少 8 位';
      else if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
        next.password = '密码需同时包含字母与数字';
      }
      if (password !== confirm) next.confirm = '两次输入的密码不一致';
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.email = '邮箱格式不正确';
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
        toast.success(`已更新用户 ${user.username}`);
      } else {
        await usersApi.create({
          username: username.trim(),
          password,
          role,
          email: email.trim() || undefined,
          comment: comment.trim() || undefined,
          permissions: useOverride ? perms : null,
        });
        toast.success(`已创建用户 ${username.trim()}`, `角色：${roleLabelByValue(role, roleOptions)}`);
      }
      setPassword('');
      setConfirm('');
      onDone();
    } catch (err) {
      toast.error(isEdit ? '更新用户失败' : '创建用户失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `编辑用户 ${user?.username}` : '新建面板用户'}
      description={
        isEdit
          ? '留空密码字段表示不修改现有密码'
          : '创建后用户即可使用该账号登录面板'
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
          >
            {isEdit ? '保存修改' : '创建用户'}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field
          label="用户名"
          required={!isEdit}
          error={errors.username}
          hint={isEdit ? '用户名创建后不可修改' : '登录面板时使用'}
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
          label={isEdit ? '新密码' : '密码'}
          required={!isEdit}
          error={errors.password}
          hint={
            password
              ? '建议包含大小写字母、数字与符号，长度 12 位以上'
              : undefined
          }
        >
          <Input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={isEdit ? '留空则不修改' : '至少 8 位，含字母与数字'}
            suffix={
              <IconButton
                label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </IconButton>
            }
          />
        </Field>

        {!isEdit || password ? (
          <Field label="确认密码" required error={errors.confirm}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        ) : null}

        <Field label="角色" required hint="决定该用户在面板中可执行的操作范围">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={roleOptions}
          />
        </Field>

        {/* ---- 权限：默认跟随角色，可切到自定义逐条勾选 ---- */}
        <div className="perm-block">
          <div className="perm-block-head">
            <span className="fw-600">权限</span>
            <span className="fs-xs text-muted">
              {useOverride
                ? `自定义（${perms.length} 项）`
                : `跟随角色「${roleLabelByValue(role, roleOptions)}」`}
            </span>
          </div>

          <Switch
            checked={useOverride}
            onChange={(v) => {
              setUseOverride(v);
              if (!v) setPerms(rolePerms);
            }}
            label="自定义该用户的权限"
            hint="关闭时权限随角色变化；打开后可逐条勾选，之后改角色不再影响他"
          />

          <PermissionPicker
            value={perms}
            onChange={setPerms}
            disabled={!useOverride}
          />
        </div>

        <Field label="邮箱" error={errors.email} hint="可选，用于接收通知">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            autoComplete="off"
          />
        </Field>

        {!isEdit ? (
          <Field label="备注">
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="例如：张三，运维组"
            />
          </Field>
        ) : (
          <>
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label="启用该账号"
              hint="禁用后用户无法登录，但账号与其审计记录保留"
            />
            <Field
              label="审批状态"
              hint="自助注册的账号先落在「待审批」；这里可以把被拒绝的申请改回正常"
            >
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={[
                  { label: '正常（可登录）', value: 'active' },
                  { label: '待审批（禁止登录）', value: 'pending' },
                  { label: '已拒绝（禁止登录）', value: 'rejected' },
                ]}
              />
            </Field>
          </>
        )}
      </div>

      <Notice tone="info" title="密码安全提示">
        面板密码与 Proxmox 集群凭据相互独立。面板使用统一的 API Token 访问集群，
        因此所有面板用户的集群操作权限由「角色」在面板层拦截。
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
        `已通过 ${user.username} 的注册申请`,
        `角色：${roleLabelByValue(role, roleOptions)}`,
      );
      onDone();
    } catch (err) {
      toast.error('审批失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`审批注册申请${user ? ` · ${user.username}` : ''}`}
      description="通过后该账号即可登录面板，角色与权限在这里一次定好"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
          >
            通过并开通
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label="申请人">
          <Input value={user?.username ?? ''} disabled readOnly />
        </Field>

        <Field label="邮箱">
          <Input
            value={user?.email || '（申请时未填写）'}
            disabled
            readOnly
          />
        </Field>

        <Field label="申请时间">
          <Input
            value={user?.created ? formatDateTime(user.created) : '—'}
            disabled
            readOnly
            mono
          />
        </Field>

        <Field
          label="角色"
          required
          hint="决定该用户在面板中可执行的操作范围"
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
            <span className="fw-600">权限</span>
            <span className="fs-xs text-muted">
              {useOverride
                ? `自定义（${perms.length} 项）`
                : `跟随角色「${roleLabelByValue(role, roleOptions)}」`}
            </span>
          </div>

          <Switch
            checked={useOverride}
            onChange={(v) => {
              setUseOverride(v);
              if (!v) setPerms(rolePerms);
            }}
            label="为该用户单独指定权限"
            hint="关闭时权限随角色变化；打开后可逐条勾选，之后改角色不再影响他"
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
      setError('密码至少 8 位');
      return;
    }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError('密码需同时包含字母与数字');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await usersApi.update(user.username, { password });
      toast.success(
        `已重置 ${user.username} 的密码`,
        '请通过安全渠道告知该用户新密码',
      );
      onDone();
    } catch (err) {
      toast.error('重置密码失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={`重置密码 — ${user?.username ?? ''}`}
      description="直接设置新密码，用户下次登录时生效"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<IconKey size={15} />}
            onClick={() => void submit()}
            loading={busy}
            disabled={!password || !confirm}
          >
            重置密码
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label="新密码" required error={error || undefined}>
          <Input
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            placeholder="至少 8 位，含字母与数字"
            suffix={
              <IconButton
                label={show ? '隐藏密码' : '显示密码'}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </IconButton>
            }
          />
        </Field>

        <Field label="确认新密码" required>
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

      <Notice tone="warning" title="重置后请通知用户">
        面板不会通过邮件自动发送新密码。请通过安全渠道（如内部 IM）告知用户，
        并建议其登录后立即修改。
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
      toast.success('已删除角色', deleteTarget.name);
      setDeleteTarget(null);
      invalidate();
    } catch (err) {
      toast.error('删除角色失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader
        title="角色管理"
        subtitle="角色 = 一组权限的命名预设。内置角色中「超级管理员」不可修改，还有用户在用的角色不可删除"
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
            新建角色
          </Button>
        }
      />

      {rolesQuery.isLoading ? (
        <div className="fs-sm text-muted">正在加载角色…</div>
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
                        内置
                      </Badge>
                    ) : null}
                  </span>
                  <span className="fs-xs text-muted mono">{r.id}</span>
                  <span className="fs-xs text-muted">{r.description || '—'}</span>
                </div>
              </div>

              <div className="set-conn-tags set-conn-meta">
                <span>{r.permissions.length} 项权限</span>
                <span>{r.user_count ?? 0} 个用户</span>
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
                  编辑
                </Button>
                <IconButton
                  label={`删除角色 ${r.name}`}
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
        title="删除角色"
        danger
        confirmText="删除角色"
        loading={busy}
        requireText={deleteTarget?.name}
        message={
          <>
            即将删除角色 <strong>{deleteTarget?.name}</strong>
            。删除后使用该角色的用户需要重新指派角色。
          </>
        }
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
      setErrors({ name: '请填写角色名称' });
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
        toast.success('已更新角色', cleaned);
      } else {
        await rolesApi.create({
          name: cleaned,
          description: description.trim(),
          permissions: perms,
        });
        toast.success('已创建角色', cleaned);
      }
      onDone();
    } catch (err) {
      toast.error(isEdit ? '更新角色失败' : '创建角色失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `编辑角色 ${role?.name}` : '新建角色'}
      description="勾选该角色包含的权限。用户可选它作为权限模板，也可在此基础上单独微调"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {isEdit ? '保存修改' : '创建角色'}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <Field label="角色名称" required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 只读审计 / 自建运维组"
          />
        </Field>

        <Field label="说明" hint="可选，展示在角色列表中">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="这个角色的用途"
          />
        </Field>

        <div className="perm-block">
          <div className="perm-block-head">
            <span className="fw-600">权限</span>
            <span className="fs-xs text-muted">已选 {perms.length} 项</span>
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
  return roleMeta(String(info.id) as PanelRole).label;
}

function roleLabelByValue(
  value: string,
  options: Array<{ label: string; value: string }>,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
