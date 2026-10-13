/* ==========================================================================
   ProxCenter — 面板用户管理
   用户 CRUD + 角色权限说明矩阵
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesApi, usersApi } from '../api/endpoints';
import { PermissionPicker } from '../components/PermissionPicker';
import { QuotaEditor } from '../components/QuotaEditor';
import { errorMessage, isNotImplemented } from '../api/client';
import { PageShell } from '../components/Layout';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Input, Select, Switch, Textarea, Field } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { ProgressBar } from '../components/ui/ProgressBar';
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
  IconInfo,
  IconEye,
  IconEyeOff,
  IconUser,
  IconClock,
} from '../components/Icons';
import { formatDateTime } from '../utils/format';
import {
  isPendingApproval,
  roleMeta,
  userEnabledMeta,
  userStatusMeta,
} from '../utils/status'
import { tStatic, useT } from '../i18n';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type {
  PanelRole,
  PermissionGroup,
  QuotaLimits,
  RoleOut,
  UserAccountStatus,
  UserOut,
} from '../api/types';

const ROLE_ORDER: PanelRole[] = ['admin', 'operator', 'viewer'];

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Users() {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { hasPermission, user: currentUser } = useAuth();
  /* 「看」与「管」是两个权限：users.view 就能进这一页（后端读接口只要它），
     增删改用户 / 角色要 users.manage。所有写操作按钮一律按 canManage 禁用，
     与后端 require_permission("users.manage") 对齐。 */
  const canManage = hasPermission('users.manage');

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
  /* 「总计」卡片点开的那层按角色明细（内容见 roleBreakdown） */
  const [totalOpen, setTotalOpen] = useState(false);
  const totalRef = useRef<HTMLDivElement>(null);

  /* ---- 用户列表 ---- */
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    staleTime: 20_000,
  });

  /* ---- 角色列表 ----
     与「用户编辑器 / 审批弹窗 / 角色管理」共用 `/api/roles` 这一份：它带
     user_count（角色卡片要显示「N 个用户在用」），而 `/users/roles` 那份只有
     id/name/permissions。同一个 queryKey 也让四处共享缓存，改完角色失效一次即可。 */
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    staleTime: 60_000,
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
    /* 按角色**逐个数**，而不是三个写死的字段：角色是可以自定义的，只统计
       admin / operator / viewer 会让用自定义角色的账号落在任何一类之外 ——
       顶上几张卡的读数加起来小于「总计」，差额就是这群人。 */
    const roleCounts = new Map<string, number>();
    let disabled = 0;
    users.forEach((u) => {
      // 待审批的账号还没定角色，别混进角色统计里误导人
      if (isPendingApproval(u.status)) return;
      roleCounts.set(u.role, (roleCounts.get(u.role) ?? 0) + 1);
      if (u.enabled === false) disabled += 1;
    });
    const count = (role: PanelRole) => roleCounts.get(role) ?? 0;
    /* 内置三类之外的人数（即自定义角色）。「总计」卡上的小字会报出它 */
    const others = [...roleCounts.entries()]
      .filter(([role]) => !ROLE_ORDER.includes(role as PanelRole))
      .reduce((sum, [, n]) => sum + n, 0);
    return {
      total: users.length,
      admin: count('admin'),
      operator: count('operator'),
      viewer: count('viewer'),
      others,
      roleCounts,
      disabled,
      pending: pendingUsers.length,
    };
  }, [users, pendingUsers]);

  /* 点外面 / 滚动 / 改窗口大小都收起 —— 与额度胶囊、详情页的「更多操作」
     同一套处理（浮层是绝对定位的，滚动后位置就歪了） */
  useEffect(() => {
    if (!totalOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!totalRef.current?.contains(event.target as Node)) setTotalOpen(false);
    };
    const onScroll = () => setTotalOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [totalOpen]);

  const roleOptions = useMemo(() => {
    const fromApi = rolesQuery.data;
    if (fromApi && fromApi.length > 0) {
      return fromApi.map((r) => ({ label: roleLabel(r), value: r.id }));
    }
    return ROLE_ORDER.map((r) => ({ label: roleMeta(r, t).label, value: r }));
  }, [rolesQuery.data, t]);

  /* 自定义角色的显示名（id → 用户起的名字）。
     角色名只存在于 /roles 这份数据里，而 roleMeta 的表里只有内置三个 ——
     不查表就会把 role_f195e975 这种内部 id 直接亮给用户看。
     内置角色不入表：继续走 roleMeta 的 i18n 词条与既有配色。 */
  const customRoleNames = useMemo(() => {
    const names = new Map<string, string>();
    (rolesQuery.data ?? []).forEach((r) => {
      if (!r.builtin) names.set(String(r.id), r.name || String(r.id));
    });
    return names;
  }, [rolesQuery.data]);

  /* 「总计」点开的明细：内置三类按固定顺序在前，接着是自定义角色（名字取
     /roles，取不到就显示 id），最后补一条待审批 —— 待审批的账号同样没定角色，
     不列出来明细之和又会小于总计。
     放在 customRoleNames 之后：它就是靠那份映射把角色 id 翻成名字的。 */
  const roleBreakdown = useMemo(() => {
    const rows = ROLE_ORDER.map((role) => ({
      key: role as string,
      label: roleMeta(role, t).label,
      count: stats.roleCounts.get(role) ?? 0,
    }));
    for (const [role, count] of stats.roleCounts) {
      if (ROLE_ORDER.includes(role as PanelRole)) continue;
      rows.push({ key: role, label: customRoleNames.get(role) ?? role, count });
    }
    if (stats.pending > 0) {
      rows.push({
        key: '__pending',
        label: t('status.user.pending'),
        count: stats.pending,
      });
    }
    return rows;
  }, [stats, customRoleNames, t]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    /* 角色列表一起失效：改用户的角色会动到各角色的「N 个用户在用」 */
    void queryClient.invalidateQueries({ queryKey: ['roles'] });
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
      /* 自定义角色名比内置词条长（用户自己起的），120 会把它压成省略号 */
      width: 150,
      render: (u) => {
        const meta = roleMeta(u.role, tStatic);
        const label = customRoleNames.get(u.role) ?? meta.label;
        return (
          /* 徽章里 nowrap + 省略号，长名字看不到全名；title 里带上内部 id ——
             排障时要对的就是它，界面上又不适合直接摆出来 */
          <Badge variant={meta.variant} dot size="sm" title={`${label} · ${u.role}`}>
            {label}
          </Badge>
        );
      },
      sortable: true,
      /* 按看得见的名字排，而不是按 id —— 否则列里是「测试角色」、排序却按
         role_f195e975 来，看着像乱序 */
      sortValue: (u) => customRoleNames.get(u.role) ?? u.role,
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
            disabled={!canManage}
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
            disabled={!canManage}
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
            disabled={!canManage || u.username === currentUser?.username}
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
            disabled={!canManage}
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
            disabled={!canManage}
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
            disabled={!canManage}
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
      {!canManage ? (
        <Notice tone="info" title={t('users.readonlyTitle')}>
          {t('users.readonlyBody')}
        </Notice>
      ) : null}

      {/* 统计。「总计」那张可点：这一行只列内置三类角色，用自定义角色的账号
          不在任何一类里 —— 差额由卡上那行小字点出，完整分布点开看。 */}
      <div className="grid grid-5">
        <div className="kpi-popover-wrap" ref={totalRef}>
          <KpiCard
            label={t('users.kpiTotal')}
            value={stats.total}
            icon={<IconUsers size={18} />}
            tone="accent"
            loading={usersQuery.isLoading}
            hint={
              stats.others > 0
                ? t('users.kpiOthersHint', { n: stats.others })
                : undefined
            }
            onClick={() => setTotalOpen((prev) => !prev)}
            title={t('users.kpiTotalHint')}
          />
          {totalOpen ? (
            <div
              className="kpi-popover"
              role="dialog"
              aria-label={t('users.kpiTotalHint')}
            >
              <div className="quota-popover-head">
                {t('users.kpiBreakdownTitle')}
              </div>
              {roleBreakdown.map((row) => (
                <div className="quota-popover-line" key={row.key}>
                  <span>{row.label}</span>
                  <span className="mono">{row.count}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
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
            /* 内置三个在前（沿用表格列那套词条），后面跟上自定义角色 ——
               这里以前写死内置三个，建了自定义角色之后，用它的账号在下拉里
               根本选不出来，等于「人有、筛不了」。与表格列同一份映射
               （customRoleNames），两处的名字不会各叫各的。 */
            options={[
              { label: t('users.filterAllRoles'), value: '' },
              ...ROLE_ORDER.map((r) => ({ label: roleMeta(r, t).label, value: r })),
              ...[...customRoleNames.entries()].map(([id, label]) => ({
                label,
                value: id,
              })),
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

      {/* ---- 角色与权限 ----
          查看 / 新建 / 编辑 / 删除都在卡片上（见 RoleManager），不再分成两块 */}
      <RoleManager />

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
          /* 与表格列同一份映射：删自定义角色的用户时别把 role_xxx 写进确认文案 */
          role:
            (deleteTarget ? customRoleNames.get(deleteTarget.role) : undefined) ??
            roleMeta(deleteTarget?.role, t).label,
        })}
      />

    </PageShell>
  );
}

/**
 * 权限说明弹窗：按域分组把「这一项到底是干什么的」列出来。
 *
 * 去掉「角色 × 权限」对照表之后，这是页面上唯一一份「某个权限键代表什么」的
 * 参照 —— 角色卡片只给数量与覆盖率。所以搜索与域筛选不是锦上添花：57 项里
 * 找一条，靠滚动翻是不现实的。
 */
function PermissionHelpModal({
  open,
  catalog,
  onClose,
}: {
  open: boolean;
  catalog: PermissionGroup[];
  onClose: () => void;
}) {
  const t = useT();
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');

  /* 每次打开都从干净状态开始：否则上次留下的搜索词会让列表「看起来是空的」 */
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    setDomain('');
  }, [open]);

  const total = useMemo(
    () => catalog.reduce((sum, group) => sum + group.permissions.length, 0),
    [catalog],
  );

  /* 关键词同时匹配「名称 / 键 / 说明」：管理员可能记得中文名（快照），
     也可能手里只有日志里抄来的 vm.snapshot */
  const groups = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return catalog
      .filter((group) => !domain || group.key === domain)
      .map((group) => ({
        ...group,
        permissions: group.permissions.filter((item) =>
          q
            ? [item.label, item.key, item.desc ?? '']
                .join(' ')
                .toLowerCase()
                .includes(q)
            : true,
        ),
      }))
      .filter((group) => group.permissions.length > 0);
  }, [catalog, keyword, domain]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('users.permHelpTitle')}
      description={t('users.permHelpDesc')}
      size="lg"
    >
      <div className="perm-help">
        {/* 57 项、18 个域，纯滚动找一条太费劲：搜索 + 域筛选一起摆上来 */}
        <div className="perm-help-filter">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('users.permHelpSearch')}
            prefix={<IconSearch size={15} />}
            block={false}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('users.permHelpSearchAria')}
          />
          <div className="perm-help-domains">
            <button
              type="button"
              className={`perm-chip${domain === '' ? ' is-on' : ''}`}
              onClick={() => setDomain('')}
            >
              {t('users.permHelpAll', { n: total })}
            </button>
            {catalog.map((group) => (
              <button
                key={group.key}
                type="button"
                className={`perm-chip${domain === group.key ? ' is-on' : ''}`}
                onClick={() => setDomain(group.key)}
              >
                {group.label}
              </button>
            ))}
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="perm-help-empty">{t('users.permHelpEmpty')}</div>
        ) : (
          <PermissionGroupList groups={groups} />
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   角色卡片
   --------------------------------------------------------------------------- */

function RoleCard({
  role,
  catalogTotal,
  canManage,
  onView,
  onEdit,
  onDelete,
}: {
  role: RoleOut;
  catalogTotal: number;
  /** 有 users.manage 才显示编辑 / 删除 */
  canManage: boolean;
  /** 查看这个角色的权限清单（只读，所有人可用） */
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const keys = role.permissions ?? [];
  /* `*` = 全部权限：条数得按目录总数说，否则界面上会出现「1 / 57」这种读数 */
  const all = keys.includes('*');
  const covered = all ? catalogTotal : keys.length;
  const percent = catalogTotal > 0 ? Math.round((covered / catalogTotal) * 100) : 0;
  /* 超管角色本身不可改（后端也拒）；仍在用的角色不可删 */
  const canDelete = !role.builtin && (role.user_count ?? 0) === 0;

  return (
    <div className="entity-card role-card">
      <div className="entity-card-head">
        <div className="entity-card-title">
          {/* 名称与 id 分两层：id 是技术标识，原先和名称并排贴在右上角，
              字号还一样大 —— 结果第一眼看到的是 admin / role_3f2a */}
          <span className="entity-card-name" title={role.name}>
            {role.name}
          </span>
          <span className="entity-card-sub">{role.id}</span>
        </div>
        {/* 内置与自定义都标出来：原先只标内置，自定义角色看着像「没有类型」 */}
        <Badge variant={role.builtin ? 'accent' : 'neutral'} size="sm">
          {role.builtin ? t('users.roleBuiltinTag') : t('users.roleCustomTag')}
        </Badge>
      </div>

      {role.description ? (
        <div className="fs-sm text-secondary role-card-desc">{role.description}</div>
      ) : null}

      {/* 这两个数字才是这张卡片的主信息，用 entity-stat 的大字号；
          「12 / 57」看不出是一半还是七成，所以下面再补一条覆盖率进度条 */}
      <div className="entity-card-stats">
        <div className="entity-stat">
          <span className="entity-stat-label">{t('users.roleStatPerms')}</span>
          <span className="entity-stat-value">
            {all ? t('users.roleStatPermsAll') : covered}
          </span>
          <span className="entity-stat-unit">
            {all ? '' : t('users.roleStatPermsTotal', { total: catalogTotal })}
          </span>
        </div>
        <div className="entity-stat">
          <span className="entity-stat-label">{t('users.roleStatUsers')}</span>
          <span className="entity-stat-value">{role.user_count ?? 0}</span>
        </div>
      </div>

      {/* 固定主色，不走 ProgressBar 按占用率取色的默认行为 ——
          权限多不是「危险」，绿→橙→红在这里只会误导 */}
      <ProgressBar
        value={percent}
        color="var(--accent)"
        height={4}
        ariaLabel={t('users.roleCoverage', { percent })}
      />

      {/* 卡片本身就是操作入口（原先要滚到下面的「角色管理」列表里改） */}
      <div className="entity-card-footer">
        <Button
          variant="secondary"
          size="sm"
          icon={<IconEye size={14} />}
          onClick={onView}
        >
          {t('users.roleViewPerms')}
        </Button>
        {canManage ? (
          <span className="role-card-actions">
            <IconButton
              label={t('users.roleEditAria', { name: role.name })}
              variant="primary"
              disabled={role.id === 'admin'}
              onClick={onEdit}
            >
              <IconEdit size={15} />
            </IconButton>
            <IconButton
              label={t('users.deleteRoleAria', { name: role.name })}
              variant="danger"
              disabled={!canDelete}
              onClick={onDelete}
            >
              <IconTrash size={15} />
            </IconButton>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 按域分组的权限清单：只读清单与「权限说明」共用这一份渲染 */
function PermissionGroupList({ groups }: { groups: PermissionGroup[] }) {
  return (
    <div className="perm-help">
      {groups.map((group) => (
        <section className="perm-help-group" key={group.key}>
          <h4 className="perm-help-group-title">{group.label}</h4>
          <div className="perm-help-items">
            {group.permissions.map((item) => (
              <div className="perm-help-item" key={item.key}>
                <div className="perm-help-head">
                  <span className="perm-help-label">{item.label}</span>
                  <span className="perm-help-key">{item.key}</span>
                </div>
                {item.desc ? <p className="perm-help-desc">{item.desc}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * 某个角色的权限只读清单。
 *
 * 与「权限说明」的分工：那个讲**每一项是干什么的**（面向「这个键是什么意思」），
 * 这个回答**这个角色到底拿到了哪些**（面向「他能做什么」）。同一份目录数据，
 * 一个全列、一个只列拥有的 —— 所以那些没有这项权限的域整段不出现。
 */
function RolePermissionsModal({
  role,
  catalog,
  onClose,
}: {
  role: RoleOut | null;
  catalog: PermissionGroup[];
  onClose: () => void;
}) {
  const t = useT();
  const keys = role?.permissions ?? [];
  const all = keys.includes('*');

  const groups = useMemo(() => {
    const owned = new Set(keys);
    return catalog
      .map((group) => ({
        ...group,
        permissions: all
          ? group.permissions
          : group.permissions.filter((item) => owned.has(item.key)),
      }))
      .filter((group) => group.permissions.length > 0);
    // role 每次点击只换一次，用它的 permissions 当依赖即可
  }, [catalog, all, keys]);

  const count = groups.reduce((sum, group) => sum + group.permissions.length, 0);

  return (
    <Modal
      open={Boolean(role)}
      onClose={onClose}
      title={role ? t('users.rolePermsTitle', { name: role.name }) : ''}
      description={t('users.rolePermsCount', { n: count })}
      size="lg"
    >
      <PermissionGroupList groups={groups} />
    </Modal>
  );
}

/**
 * 「自定义权限」模式下的差量提示。
 *
 * 用户级权限是**整份替换**角色权限，不是叠加：开关一打开，这个人就只用你勾的
 * 这一套 —— 很容易以为在「加一项」，实际把角色的其余权限一起丢了，而且以后角色
 * 升级也不会再同步给他（users.customPermsHint 那句说的就是这个）。把差值摆在
 * 眼前，比再写一段说明有效。
 *
 * 具体差哪些键放在 title 里：键名是技术信息，看的人看得懂，又不占地方。
 */
function PermissionDiff({ rolePerms, perms }: { rolePerms: string[]; perms: string[] }) {
  const t = useT();
  const added = useMemo(
    () => perms.filter((key) => !rolePerms.includes(key)),
    [perms, rolePerms],
  );
  const removed = useMemo(
    () => rolePerms.filter((key) => !perms.includes(key)),
    [perms, rolePerms],
  );

  if (added.length === 0 && removed.length === 0) {
    return <span>{' · '}{t('users.permDiffSame')}</span>;
  }
  return (
    <span
      title={[
        ...added.map((key) => `+ ${key}`),
        ...removed.map((key) => `- ${key}`),
      ].join('\n')}
    >
      {' · '}
      {t('users.permDiff', { added: added.length, removed: removed.length })}
    </span>
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
  /* 资源额度：null = 继承角色默认（与权限覆盖同一个套路） */
  const [quotaDraft, setQuotaDraft] = useState<QuotaLimits | null>(null);
  const [quotaTouched, setQuotaTouched] = useState(false);
  const quotaInitRef = useRef('');

  const isEdit = Boolean(user);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 该用户现有的额度配置（编辑时才有） */
  const quotaQuery = useQuery({
    queryKey: ['user-quota', user?.username ?? ''],
    queryFn: () => usersApi.getQuota(String(user?.username)),
    enabled: open && isEdit,
    staleTime: 30_000,
    retry: false,
  });

  /* 所选角色的默认额度：让「继承」这一档能说清到底继承到什么 */
  const roleQuotaQuery = useQuery({
    queryKey: ['role-quota', role],
    queryFn: () => rolesApi.getQuota(role),
    enabled: open && Boolean(role),
    staleTime: 30_000,
    retry: false,
  });

  /* 额度只在打开时初始化一次：否则管理员改到一半，查询一刷新就把输入盖回去了 */
  useEffect(() => {
    if (!open) {
      quotaInitRef.current = '';
      return;
    }
    if (!isEdit || !quotaQuery.data) return;
    const key = user?.username ?? '';
    if (quotaInitRef.current === key) return;
    quotaInitRef.current = key;
    setQuotaDraft(quotaQuery.data.configured ? quotaQuery.data.quota : null);
    setQuotaTouched(false);
  }, [open, isEdit, quotaQuery.data, user?.username]);

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
      // 新建的用户默认「继承角色默认额度」，由 quotaQuery 那段按库里的实际值补上
      setQuotaDraft(null);
      setQuotaTouched(false);
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
      // 额度是独立的一份配置，用户建好/改好之后再写。
      // 只在管理员真的动过它时才写：否则「只改了个邮箱」会把已配好的额度抹掉。
      if (!isEdit || quotaTouched) {
        await usersApi.saveQuota(username.trim(), quotaDraft);
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
              {/* 覆盖模式下把「与角色的差」摆出来：它是**整份替换**而不是叠加，
                  管理员很容易以为自己在「加一项」，结果把角色的其余权限一起丢了 */}
              {useOverride ? (
                <PermissionDiff rolePerms={rolePerms} perms={perms} />
              ) : null}
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

        {/* ---- 资源额度 -----------------------------------------------------
            紧跟角色 / 权限：这三块一起回答「这个用户能做什么、能用多少」，
            夹在账号信息中间（邮箱、启用状态）之前更顺。 */}
        <div>
          <h3 className="fs-sm fw-600">{t('quota.titleUser')}</h3>
          <div className="fs-xs text-muted mb-8">{t('quota.descUser')}</div>
          {quotaQuery.data?.bypass ? (
            /* 超管 / 带 * 的角色根本不受额度约束：配了也不生效，直接说明白 */
            <Notice tone="warning">{t('quota.bypass')}</Notice>
          ) : (
            <QuotaEditor
              value={quotaDraft}
              onChange={(next) => {
                setQuotaDraft(next);
                setQuotaTouched(true);
              }}
              inherited={roleQuotaQuery.data?.quota ?? null}
              usage={quotaQuery.data?.usage ?? null}
              disabled={busy}
            />
          )}
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
              {/* 覆盖模式下把「与角色的差」摆出来：它是**整份替换**而不是叠加，
                  管理员很容易以为自己在「加一项」，结果把角色的其余权限一起丢了 */}
              {useOverride ? (
                <PermissionDiff rolePerms={rolePerms} perms={perms} />
              ) : null}
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
   角色管理：有 users.manage 的用户可新建 / 编辑 / 删除自定义角色
   --------------------------------------------------------------------------- */

/**
 * 角色与权限：一屏管完角色。
 *
 * 原先这块和下方的「角色管理」是两张卡 —— 上面一列只读的角色卡片（几个权限、
 * 几个人在用），下面一列带编辑 / 删除的 role-row。同一个东西两处展示：改一个
 * 角色要滚到下面，看完想对照又要滚回来。合并之后卡片自己就是操作入口。
 */
function RoleManager() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  /* 增删改角色要 users.manage；而看角色清单与权限说明只要进得来这一页（users.view） */
  const canManage = hasPermission('users.manage');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleOut | null>(null);
  /* 某个角色的权限只读清单 */
  const [permsTarget, setPermsTarget] = useState<RoleOut | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  /* 与页面顶部的角色下拉共用同一份缓存（queryKey 一致） */
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    staleTime: 60_000,
    retry: false,
  });
  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);

  /* 权限目录：只读清单与「权限说明」共用（与 PermissionPicker 同一份缓存） */
  const catalogQuery = useQuery({
    queryKey: ['permissions', 'catalog'],
    queryFn: () => rolesApi.catalog(),
    staleTime: 300_000,
    retry: false,
  });
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const catalogTotal = useMemo(
    () => catalog.reduce((sum, group) => sum + group.permissions.length, 0),
    [catalog],
  );

  /* 角色只有这一份缓存了（见页面顶部的 rolesQuery） */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['roles'] });
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

  return (
    <Card>
      <CardHeader
        title={t('users.rolesTitle')}
        subtitle={t('users.rolesSubtitle')}
        icon={<IconShield size={17} />}
        actions={
          <>
            {/* 权限说明对谁都开放：只有 users.view 的用户也得能查「这个键是什么意思」 */}
            <Button
              variant="secondary"
              size="sm"
              icon={<IconInfo size={14} />}
              onClick={() => setHelpOpen(true)}
            >
              {t('users.permHelpButton')}
            </Button>
            {canManage ? (
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
            ) : null}
          </>
        }
      />

      {rolesQuery.isLoading ? (
        <div className="fs-sm text-muted">{t('users.rolesLoading')}</div>
      ) : (
        <div className="grid grid-3">
          {roles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              catalogTotal={catalogTotal}
              canManage={canManage}
              onView={() => setPermsTarget(role)}
              onEdit={() => {
                setEditTarget(role);
                setEditorOpen(true);
              }}
              onDelete={() => setDeleteTarget(role)}
            />
          ))}
        </div>
      )}

      <RolePermissionsModal
        role={permsTarget}
        catalog={catalog}
        onClose={() => setPermsTarget(null)}
      />

      <PermissionHelpModal
        open={helpOpen}
        catalog={catalog}
        onClose={() => setHelpOpen(false)}
      />

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
  /* 角色默认额度：null = 该角色没有默认额度（用户级也没配就是不限制） */
  const [quotaDraft, setQuotaDraft] = useState<QuotaLimits | null>(null);
  const [quotaTouched, setQuotaTouched] = useState(false);
  const quotaInitRef = useRef('');

  const isEdit = Boolean(role);
  /* 超管角色不受额度限制，后端也拒收它的默认额度 */
  const quotaApplies = Boolean(role) && role?.id !== 'admin';

  const quotaQuery = useQuery({
    queryKey: ['role-quota', role?.id ?? ''],
    queryFn: () => rolesApi.getQuota(String(role?.id)),
    enabled: open && isEdit && quotaApplies,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!open) {
      quotaInitRef.current = '';
      return;
    }
    if (!isEdit) {
      setQuotaDraft(null);
      setQuotaTouched(false);
      return;
    }
    if (!quotaQuery.data) return;
    const key = role?.id ?? '';
    if (quotaInitRef.current === key) return;
    quotaInitRef.current = key;
    setQuotaDraft(quotaQuery.data.configured ? quotaQuery.data.quota : null);
    setQuotaTouched(false);
  }, [open, isEdit, quotaQuery.data, role?.id]);

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
        // 默认额度是独立的一份配置：只改名字时别去动它（否则会把已配好的抹掉）
        if (quotaApplies && quotaTouched) {
          await rolesApi.saveQuota(role.id, quotaDraft);
        }
        toast.success(t('users.roleUpdatedToast'), cleaned);
      } else {
        const created = await rolesApi.create({
          name: cleaned,
          description: description.trim(),
          permissions: perms,
        });
        // 新建时才需要写（继承 = null 不用写）
        if (quotaDraft) await rolesApi.saveQuota(created.id, quotaDraft);
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

        {/* ---- 角色默认额度 -------------------------------------------------
            紧跟「说明」：说明回答「这个角色是干什么的」，额度回答「默认给多少」，
            两者放在一起看最顺；权限勾选放在它们后面。 */}
        <div>
          <h3 className="fs-sm fw-600">{t('quota.titleRole')}</h3>
          <div className="fs-xs text-muted mb-8">
            {t('quota.descRole', { n: quotaQuery.data?.user_count ?? 0 })}
          </div>
          {!quotaApplies ? (
            <Notice tone="warning">{t('quota.bypass')}</Notice>
          ) : (
            <QuotaEditor
              value={quotaDraft}
              onChange={(next) => {
                setQuotaDraft(next);
                setQuotaTouched(true);
              }}
              disabled={busy}
            />
          )}
        </div>

        {/* 影响面：这里改的不是「当前这一份配置」，而是所有在用这个角色的人 */}
        {isEdit && (role?.user_count ?? 0) > 0 ? (
          <Notice tone="info">
            {t('users.roleImpact', { n: role?.user_count ?? 0 })}
          </Notice>
        ) : null}

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
