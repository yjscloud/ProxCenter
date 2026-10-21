/* ==========================================================================
   ProxCenter — 面板用户管理
   用户 CRUD + 角色权限说明矩阵
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { quotaApi, rolesApi, usersApi } from '../api/endpoints';
import { PermissionPicker } from '../components/PermissionPicker';
import { QuotaEditor } from '../components/QuotaEditor';
import { errorMessage, isNotImplemented } from '../api/client';
import { invalidateQuota } from '../hooks/quotaCache';
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
  IconAlert,
  IconEye,
  IconEyeOff,
  IconUser,
  IconClock,
  IconCopy,
} from '../components/Icons';
import { formatDateTime } from '../utils/format';
import {
  isPendingApproval,
  roleMeta,
  userEnabledMeta,
  userStatusMeta,
} from '../utils/status'
import { tStatic, useT, type MessageKey } from '../i18n';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { PagerBar, usePaged } from '../hooks/usePaged';
import type {
  PanelRole,
  PermissionGroup,
  QuotaLimits,
  RoleOut,
  UserAccountStatus,
  UserOut,
  QuotaOverviewRow,
} from '../api/types';

const ROLE_ORDER: PanelRole[] = ['admin', 'operator', 'viewer'];

/* ---------------------------------------------------------------------------
   账号有效期：库里的 expires_at 是 Unix 秒，<input type="datetime-local">
   用的是「本地时区的墙上时间」。两边必须显式换算，不能把时间串直接当 UTC。
   --------------------------------------------------------------------------- */

function toLocalInput(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromLocalInput(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
}

/* ---------------------------------------------------------------------------
   重置密码：自动生成
   口令要一次性满足后端的强度校验（长度 + 同时含字母和数字），所以先各取一个
   大写 / 小写 / 数字，再补满、打乱 —— 纯随机 16 位有小概率全是字母。
   去掉了 0/O/1/l/I 这类容易抄错的字符：这个密码要靠人念、靠人抄。
   --------------------------------------------------------------------------- */

const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PW_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const PW_DIGIT = '23456789';
const PW_ALPHABET = `${PW_UPPER}${PW_LOWER}${PW_DIGIT}`;

function randomIndex(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function generatePassword(length = 16): string {
  const chars = [
    PW_UPPER[randomIndex(PW_UPPER.length)],
    PW_LOWER[randomIndex(PW_LOWER.length)],
    PW_DIGIT[randomIndex(PW_DIGIT.length)],
  ];
  while (chars.length < length) {
    chars.push(PW_ALPHABET[randomIndex(PW_ALPHABET.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 非安全上下文 / 未授权：走下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

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

  /* 分页交给统一的分页 hook（原先这一段是手写的页码 / 每页条数 + 两个 effect）：
     它一并处理「筛选条件换了回第 1 页」与「删到最后一页时越界夹取」，
     初始条数也跟随「设置 → 面板设置 → 列表每页条数」，而不是写死 10。 */
  const userPage = usePaged(filtered, `${search}|${roleFilter}`);

  /* 等待审批的注册申请：直接从完整列表里筛，不额外发一次请求 */
  const pendingUsers = useMemo(
    () => users.filter((u) => isPendingApproval(u.status)),
    [users],
  );

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);

  const stats = useMemo(() => {
    /* 卡片按「账号状态」分，而不是按角色分。角色是可以自定义的、数量不固定：
       顶上几张卡写死 admin / operator / viewer，一旦建了自定义角色，那些账号
       就落在任何一类之外，读数还会随角色增减而失真。
       改为启用 / 禁用 / 待审批三类，三者相加正好是总数；角色分布放到「用户总数」
       点开的浮层里 —— 角色有几个都能列全。 */
    const roleCounts = new Map<string, number>();
    let enabled = 0;
    let disabled = 0;
    let pending = 0;
    let rejected = 0;
    users.forEach((u) => {
      // 待审批 / 已拒绝的账号根本登不进来，先单独计数，也不进角色统计
      if (isPendingApproval(u.status)) {
        pending += 1;
        return;
      }
      if (u.status === 'rejected') {
        rejected += 1;
        return;
      }
      roleCounts.set(u.role, (roleCounts.get(u.role) ?? 0) + 1);
      if (u.enabled === false) disabled += 1;
      else enabled += 1;
    });
    return {
      total: users.length,
      enabled,
      disabled,
      pending,
      rejected,
      roleCounts,
    };
  }, [users]);

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
     /roles，取不到就显示 id），最后补待审批 / 已拒绝 —— 这两种账号同样没定角色，
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
    if (stats.rejected > 0) {
      rows.push({
        key: '__rejected',
        label: t('status.user.rejected'),
        count: stats.rejected,
      });
    }
    return rows;
  }, [stats, customRoleNames, t]);

  /* 额度总览：**一次**算出所有人的额度与用量。
     放在页面级而不是塞进每一行 —— 逐行去问就是每人一次 PVE 读数。 */
  const overviewQuery = useQuery({
    queryKey: ['quota', 'overview'],
    queryFn: quotaApi.overview,
    staleTime: 30_000,
    retry: false,
  });
  const overviewByUser = useMemo(
    () =>
      new Map(
        (overviewQuery.data?.users ?? []).map((row) => [row.username, row]),
      ),
    [overviewQuery.data],
  );

  /* 「谁快满了」：按**最紧的那一项**的剩余比例升序，只留紧张的那些。
     口径与后端 :func:`app.quotaalert.tightest` 完全一致 —— 同一个 20% 线，
     界面与推送不会一个说紧张另一个说没事，否则管理员会怀疑自己看错了。

     只排一项不逐项罗列：一个人的核数 / 内存 / 磁盘经常同时见底，逐项排出来
     每一行都是同一个意思，占的却是不同的列。 */
  const atRisk = useMemo(
    () =>
      (overviewQuery.data?.users ?? [])
        .map((row) => ({ row, tight: tightestQuota(row) }))
        .filter((item) => item.tight && item.tight.ratio <= AT_RISK_RATIO)
        .sort((a, b) => a.tight!.ratio - b.tight!.ratio),
    [overviewQuery.data],
  );
  /* 从用户列表里取 UserOut 对象：预警行上那个「调整额度」要的是完整用户对象，
     而总览里只有用户名与额度。取不到就把按钮藏起来 —— 宁可少一个入口，
     也不能点开一个空白编辑器。 */
  const userByName = useMemo(
    () => new Map(users.map((u) => [u.username, u])),
    [users],
  );

  const openEditorFor = (username: string) => {
    const target = userByName.get(username);
    if (!target) return;
    setEditTarget(target);
    setEditorOpen(true);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    /* 角色列表一起失效：改用户的角色会动到各角色的「N 个用户在用」 */
    void queryClient.invalidateQueries({ queryKey: ['roles'] });
    /* 额度读数一起失效（见 hooks/quotaCache）。漏掉它的表现是「改完再打开还是旧
       数字」：编辑器是拿缓存初始化草稿的，于是管理员以为设置没生效、甚至以为额度
       重置不了。编辑器内部有「只在打开时初始化一次」的守卫（quotaInitRef），所以
       这里作废不会把管理员改到一半的输入冲掉。 */
    invalidateQuota(queryClient);
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
      key: 'quotaLimit',
      header: t('users.colQuota'),
      width: 118,
      render: (u) => {
        const row = overviewByUser.get(u.username);
        if (!row) return <span className="fs-xs text-muted">—</span>;
        return <QuotaLimitCell row={row} />;
      },
    },
    {
      key: 'quotaUsed',
      header: t('users.colQuotaUsed'),
      width: 132,
      render: (u) => {
        const row = overviewByUser.get(u.username);
        if (!row) return <span className="fs-xs text-muted">—</span>;
        return <QuotaUsageCell row={row} />;
      },
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
      key: 'expires',
      header: t('users.colExpires'),
      width: 168,
      sortable: true,
      sortValue: (u) => u.expires_at ?? 0,
      render: (u) => <UserExpiryCell user={u} />,
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

      {/* 额度总览的两种「数字不可信」都要说出来，因为这一页的「已用 / 生效上限」
          正是管理员据以配额度的依据 —— 按偏小的数字配，等于把额度开在最不该
          开的地方（后端在创建校验那边对同一件事是 fail-closed 的）。

          两态必须分开：
            * isError —— 请求本身失败（403 / 500 / 后端没重启）。此前这一种
              **什么都不显示**，两列全是「—」，与「这个用户确实没配额度」在
              界面上完全一样 —— 于是表现为「功能没生效」且毫无线索。
            * data.error —— 请求成功但集群读数不全，用量偏小。 */}
      {overviewQuery.isError ? (
        <Notice tone="danger" title={t('users.quotaFailedTitle')}>
          {t('users.quotaFailedHint')}
          {overviewQuery.error instanceof Error
            ? `（${overviewQuery.error.message}）`
            : ''}
        </Notice>
      ) : overviewQuery.data?.error ? (
        <Notice tone="warning" title={t('users.quotaPartialTitle')}>
          {overviewQuery.data.error}
        </Notice>
      ) : null}


      {/* ---- 谁快满了 ----
          独立的预警视图：下面那张表是「逐个用户看全貌」，这一块是「谁需要我
          处理」，按最紧的那一项升序 —— 管理员扫一眼就知道先动谁。

          没人数时整块**不出现**。「所有人都还宽裕」是默认状态，一张空卡只是
          噪音；真正需要告知的只有「有一个人快满了」。

          口径与后端 :func:`app.quotaalert.tightest` 一致（同一条 20% 线）：
          界面说紧张、推送却没响，或者反过来，都只会让人怀疑自己看错了。 */}
      {atRisk.length > 0 ? (
        <Card className="page-block">
          <CardHeader
            title={t('users.atRiskTitle', { n: atRisk.length })}
            subtitle={t('users.atRiskHint')}
            icon={<IconAlert size={16} />}
          />
          <div className="table-container">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>{t('users.atRiskUser')}</th>
                  <th>{t('users.atRiskItem')}</th>
                  <th style={{ width: 220 }}>{t('users.atRiskLeft')}</th>
                  <th>{t('users.quotaColUsed')}</th>
                  <th>{t('users.quotaColLimit')}</th>
                  <th>{t('users.atRiskState')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {atRisk.map(({ row, tight }) => {
                  const info = tight!;
                  /* 这条进度是**剩余**而不是已用：看的就是「还剩多少」，填满意味
                     着安全、见底意味着该处理了 —— 与用「已用」正好相反。 */
                  const pct = Math.round(info.ratio * 100);
                  const color =
                    info.ratio <= 0.05
                      ? 'var(--danger)'
                      : info.ratio <= 0.15
                        ? 'var(--warning)'
                        : 'var(--success)';
                  return (
                    <tr key={row.username}>
                      <td>
                        <span className="fw-500">{row.username}</span>
                      </td>
                      <td>
                        {/* 分组必须写出来：「内存快满了」分不清是虚拟机还是容器，
                            而这两组的额度是各算各的。 */}
                        <span className="text-secondary">
                          {t(info.group === 'vm' ? 'quota.groupVm' : 'quota.groupCt')}
                          {' · '}
                          {t(info.label)}
                        </span>
                      </td>
                      <td>
                        <ProgressBar
                          value={pct}
                          color={color}
                          label={`${pct}%`}
                          ariaLabel={t('users.atRiskLeft')}
                        />
                      </td>
                      <td className="mono">
                        {formatQuotaValue(info.field, info.used)}
                      </td>
                      <td className="mono">
                        {formatQuotaValue(info.field, info.limit)}
                      </td>
                      <td>
                        <Badge
                          variant={info.over ? 'danger' : 'warning'}
                          size="sm"
                          dot
                        >
                          {info.over ? t('users.atRiskOver') : t('users.atRiskLow')}
                        </Badge>
                      </td>
                      <td align="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage || !userByName.has(row.username)}
                          onClick={() => openEditorFor(row.username)}
                        >
                          {t('users.atRiskAdjust')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* 统计按「账号状态」分（启用 / 禁用 / 待审批），不再写死角色卡：角色可以
          自定义、数量不固定，写死 admin / operator / viewer 迟早失真。角色分布放在
          「用户总数」点开的浮层里 —— 角色有几个都能列全。 */}
      <div className="grid grid-4">
        <div className="kpi-popover-wrap" ref={totalRef}>
          <KpiCard
            label={t('users.kpiTotal')}
            value={stats.total}
            icon={<IconUsers size={18} />}
            tone="accent"
            loading={usersQuery.isLoading}
            hint={roles.length > 0 ? t('users.kpiRoleCountHint', { n: roles.length }) : undefined}
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
          label={t('users.kpiEnabled')}
          value={stats.enabled}
          icon={<IconUser size={18} />}
          tone="success"
          loading={usersQuery.isLoading}
        />
        <KpiCard
          label={t('users.kpiDisabled')}
          value={stats.disabled}
          icon={<IconEyeOff size={18} />}
          tone={stats.disabled > 0 ? 'warning' : 'neutral'}
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
        <>
          <Table<UserOut>
            columns={columns}
            rows={userPage.rows}
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
          {/* 分页：账号一多，列表不能再一路铺到底。接在表格下沿，是这张卡的页脚 */}
          <PagerBar pager={userPage} />
        </>
      )}

      {/* ---- 角色与权限 ----
          查看 / 新建 / 编辑 / 删除都在表格行上（见 RoleManager），不再分成两块 */}
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
   角色权限格（角色表格里的「权限」列）
   --------------------------------------------------------------------------- */

/**
 * 权限读数 + 一条细覆盖率条。
 *
 * 「12 / 57」看不出是一半还是七成，所以下面补一条只读进度条；颜色固定主色，
 * 不走 ProgressBar 按占用率取色的默认行为 —— 权限多不是「危险」，绿→橙→红
 * 在这里只会误导。
 */
function RolePermissionsCell({
  role,
  catalogTotal,
}: {
  role: RoleOut;
  catalogTotal: number;
}) {
  const t = useT();
  const keys = role.permissions ?? [];
  /* `*` = 全部权限：条数得按目录总数说，否则界面上会出现「1 / 57」这种读数 */
  const all = keys.includes('*');
  const covered = all ? catalogTotal : keys.length;
  const percent = catalogTotal > 0 ? Math.round((covered / catalogTotal) * 100) : 0;

  return (
    <div className="role-perms-cell">
      <span className="fs-sm">
        {all ? t('users.roleStatPermsAll') : covered}
        {all ? null : <span className="text-muted"> / {catalogTotal}</span>}
      </span>
      <ProgressBar
        value={percent}
        color="var(--accent)"
        height={4}
        ariaLabel={t('users.roleCoverage', { percent })}
      />
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
   有效期单元格：日期 + 剩余天数；已过期时直接标红，别让人以为还能登录
   --------------------------------------------------------------------------- */

function UserExpiryCell({ user }: { user: UserOut }) {
  const t = useT();
  const expires = user.expires_at ?? 0;
  if (!expires) {
    return <span className="fs-sm text-muted">{t('users.expiryNever')}</span>;
  }
  const now = Date.now() / 1000;
  if (expires <= now) {
    return (
      <div className="flex flex-col gap-4">
        <Badge variant="danger" size="sm">
          {t('users.expiryExpired')}
        </Badge>
        <span className="mono fs-xs text-muted">{formatDateTime(expires)}</span>
      </div>
    );
  }
  const days = Math.max(1, Math.ceil((expires - now) / 86_400));
  return (
    <div className="flex flex-col gap-4">
      <span className="mono fs-sm">{formatDateTime(expires)}</span>
      <Badge variant={days <= 7 ? 'warning' : 'neutral'} size="sm">
        {t('users.expiryDaysLeft', { days })}
      </Badge>
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
  /* 账号有效期：datetime-local 的本地时间串，空 = 永不过期 */
  const [expires, setExpires] = useState('');
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
      setExpires(user.expires_at ? toLocalInput(user.expires_at) : '');
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
      setExpires('');
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

    /* datetime-local 正常不会给出非法值，但清空 / 手输异常时别把 0 当成
       「永不过期」悄悄提交 —— 那是与管理员意图相反的结果 */
    if (expires && fromLocalInput(expires) <= 0) {
      next.expires = t('users.validation.expiryInvalid');
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
          /* 0 是有意义的：清空 = 永不过期 */
          expires_at: expires ? fromLocalInput(expires) : 0,
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
          expires_at: expires ? fromLocalInput(expires) : 0,
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

        {/* ---- 账号状态（只有编辑时才有）---------------------------------
            提到权限块之前：它俩回答的是「这个账号到底能不能登录」—— 角色与权限
            配得再对，账号没启用、或还挂在「待审批 / 已拒绝」，照样进不来。
            而权限块（尤其切到自定义以后）很高，原先把它俩压在表单最底部，
            只想改个启用状态也得先滚过整屏权限勾选。 */}
        {isEdit ? (
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
        ) : null}

        {/* ---- 账号有效期 ---------------------------------------------------
            到期前 7 / 3 / 1 天自动发提醒（有邮箱才发），到期后自动关闭该账号
            名下的虚拟机与容器并冻结账号。时间用本地时区输入，提交时换成 Unix 秒。 */}
        <Field
          label={t('users.fieldExpiry')}
          hint={t('users.fieldExpiryHint')}
          error={errors.expires}
        >
          <div className="flex items-center gap-8">
            <div style={{ flex: 1 }}>
              <Input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>
            {expires ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setExpires('')}
                disabled={busy}
              >
                {t('users.expiryClear')}
              </Button>
            ) : null}
          </div>
        </Field>
        {expires && fromLocalInput(expires) > 0 &&
        fromLocalInput(expires) <= Date.now() / 1000 ? (
          <Notice tone="warning">{t('users.expiryPastWarning')}</Notice>
        ) : null}
        {isEdit && user?.expiry_frozen ? (
          <Notice tone="warning" title={t('users.expiryFrozenTitle')}>
            {t('users.expiryFrozenBody')}
          </Notice>
        ) : null}

        {/* ---- 资源额度 -----------------------------------------------------
            与邮箱一起排在权限之前：这两项都是几个字就能填完的短输入，而权限块
            切到自定义后是一长串勾选。把「账号层面先定的事」（启用 / 审批 / 额度 /
            邮箱）收在上面，权限留到最后 —— 上来就能填，不必先滚过整屏勾选。 */}
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

        {/* 备注只有新建时填（编辑时后端不接受这个字段）。它跟着邮箱留在权限之前：
            新建时它也是「一句话能填完」的输入，落到权限块之后就会被淹没 */}
        {!isEdit ? (
          <Field label={t('users.fieldComment')}>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder={t('users.commentPlaceholder')}
            />
          </Field>
        ) : null}

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
  /* auto = 面板生成一串强口令；manual = 管理员自己指定 */
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [generated, setGenerated] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /* 提交成功后的「结果页」：留在这里让管理员把密码抄走 */
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!user) return;
    setMode('auto');
    setGenerated(generatePassword());
    setPassword('');
    setConfirm('');
    setShow(false);
    setError('');
    setDone(false);
  }, [user]);

  const effective = mode === 'auto' ? generated : password;

  /* 成功之后关闭对话框要作废列表缓存；没提交过则只关窗，不必刷新 */
  const finish = () => {
    if (done) onDone();
    else onClose();
  };

  const regenerate = () => {
    setGenerated(generatePassword());
    setError('');
  };

  const copyGenerated = async () => {
    const ok = await copyToClipboard(effective);
    if (ok) toast.success(t('users.passwordCopied'));
    else toast.warning(t('users.copyFailed'), t('users.copyManualHint'));
  };

  const submit = async () => {
    if (!user || done) return;
    if (mode === 'manual') {
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
    }
    setError('');
    setBusy(true);
    try {
      await usersApi.update(user.username, { password: effective });
      setDone(true);
      toast.success(
        t('users.resetSuccessToast', { name: user.username }),
        t('users.resetSuccessDetail'),
      );
    } catch (err) {
      toast.error(t('users.resetFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={finish}
      title={t('users.resetTitle', { name: user?.username ?? '' })}
      description={t('users.resetDesc')}
      size="sm"
      footer={
        done ? (
          <Button variant="primary" onClick={finish}>
            {t('common.done')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<IconKey size={15} />}
              onClick={() => void submit()}
              loading={busy}
              disabled={mode === 'auto' ? !generated : !password || !confirm}
            >
              {t('users.resetAction')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="dyn-list">
          <Notice tone="success" title={t('users.resetDoneTitle')}>
            {t('users.resetDoneBody', { name: user?.username ?? '' })}
          </Notice>
          <Field label={t('users.fieldNewPassword')}>
            <Input
              value={effective}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              suffix={
                <IconButton label={t('users.copyPassword')} onClick={() => void copyGenerated()}>
                  <IconCopy size={15} />
                </IconButton>
              }
            />
          </Field>
          <p className="fs-xs text-muted">{t('users.resetDoneHint')}</p>
        </div>
      ) : (
        <>
          {/* 两种模式：默认自动生成（省事且不容易撞上弱口令），需要时再自己填 */}
          <div className="flex items-center gap-8 mb-12">
            <Button
              size="sm"
              variant={mode === 'auto' ? 'primary' : 'secondary'}
              onClick={() => {
                setMode('auto');
                setError('');
              }}
            >
              {t('users.resetModeAuto')}
            </Button>
            <Button
              size="sm"
              variant={mode === 'manual' ? 'primary' : 'secondary'}
              onClick={() => {
                setMode('manual');
                setError('');
              }}
            >
              {t('users.resetModeManual')}
            </Button>
          </div>

          {mode === 'auto' ? (
            <div className="dyn-list">
              <Field
                label={t('users.fieldGeneratedPassword')}
                hint={t('users.generatedPasswordHint')}
              >
                <Input
                  value={generated}
                  readOnly
                  mono
                  onFocus={(e) => e.currentTarget.select()}
                  suffix={
                    <>
                      <IconButton
                        label={t('users.regeneratePassword')}
                        onClick={regenerate}
                      >
                        <IconRefresh size={15} />
                      </IconButton>
                      <IconButton
                        label={t('users.copyPassword')}
                        onClick={() => void copyGenerated()}
                      >
                        <IconCopy size={15} />
                      </IconButton>
                    </>
                  }
                />
              </Field>
              <p className="fs-xs text-muted">{t('users.generatedPasswordWarn')}</p>
            </div>
          ) : (
            <div className="dyn-list">
              <Field
                label={t('users.fieldNewPassword')}
                required
                error={error || undefined}
              >
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
          )}
        </>
      )}

      {!done ? (
        <Notice tone="warning" title={t('users.resetNotifyTitle')}>
          {t('users.resetNotifyBody')}
        </Notice>
      ) : null}
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
    /* 角色默认额度改了，额度读数一起过期（见 hooks/quotaCache）：角色编辑器自己
       的草稿、用户编辑器里「继承到手的是什么」那段说明，以及用户读数里的
       effective / source / usage 都依赖它。漏掉的话同一个 bug 会换个地方再来
       一遍：改完角色默认，再打开还是旧数字。 */
    invalidateQuota(queryClient);
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

  /* 角色列表列：每个角色一行，比原先「一角色一卡片」省下大量纵向空间，
     角色再多也不至于把页面撑成一长条。 */
  const roleColumns: Array<Column<RoleOut>> = [
    {
      key: 'name',
      header: t('users.colRole'),
      render: (role) => (
        <div className="vm-name-cell">
          <span className="fw-500" title={role.name}>
            {role.name}
          </span>
          {/* id 是技术标识，放在名称下面一行、走等宽小字 */}
          <span className="fs-xs text-muted mono">{role.id}</span>
        </div>
      ),
      sortable: true,
      sortValue: (role) => role.name || role.id,
    },
    {
      key: 'type',
      header: t('users.colRoleType'),
      width: 90,
      render: (role) => (
        <Badge variant={role.builtin ? 'accent' : 'neutral'} size="sm">
          {role.builtin ? t('users.roleBuiltinTag') : t('users.roleCustomTag')}
        </Badge>
      ),
      sortable: true,
      // 内置在前（0）、自定义在后（1）
      sortValue: (role) => (role.builtin ? 0 : 1),
    },
    {
      key: 'perms',
      header: t('users.roleStatPerms'),
      width: 170,
      render: (role) => (
        <RolePermissionsCell role={role} catalogTotal={catalogTotal} />
      ),
      sortable: true,
      sortValue: (role) =>
        role.permissions?.includes('*')
          ? catalogTotal
          : (role.permissions?.length ?? 0),
    },
    {
      key: 'users',
      header: t('users.roleStatUsers'),
      width: 110,
      align: 'right',
      render: (role) => <span className="mono">{role.user_count ?? 0}</span>,
      sortable: true,
      sortValue: (role) => role.user_count ?? 0,
    },
    {
      key: 'description',
      header: t('users.fieldDesc'),
      render: (role) => (
        <span className="fs-sm text-secondary truncate" title={role.description}>
          {role.description || '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      width: 150,
      align: 'right',
      render: (role) => {
        /* 超管角色本身不可改（后端也拒）；仍在用的角色不可删 */
        const canDelete = !role.builtin && (role.user_count ?? 0) === 0;
        return (
          <span className="row-actions">
            <IconButton
              label={t('users.roleViewPerms')}
              onClick={() => setPermsTarget(role)}
            >
              <IconEye size={15} />
            </IconButton>
            {canManage ? (
              <>
                <IconButton
                  label={t('users.roleEditAria', { name: role.name })}
                  variant="primary"
                  disabled={role.id === 'admin'}
                  onClick={() => {
                    setEditTarget(role);
                    setEditorOpen(true);
                  }}
                >
                  <IconEdit size={15} />
                </IconButton>
                <IconButton
                  label={t('users.deleteRoleAria', { name: role.name })}
                  variant="danger"
                  disabled={!canDelete}
                  onClick={() => setDeleteTarget(role)}
                >
                  <IconTrash size={15} />
                </IconButton>
              </>
            ) : null}
          </span>
        );
      },
    },
  ];

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
        <Table<RoleOut>
          columns={roleColumns}
          rows={roles}
          rowKey={(role) => role.id}
          caption={t('users.rolesCaption')}
          emptyTitle={t('users.rolesEmpty')}
          dense
        />
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


/**
 * 「谁快满了」的判定线：剩余 ≤20% 就列进来。
 *
 * 与后端 :data:`app.quotaalert.THRESHOLD` 是同一条线，且都表达成比例（0~1），
 * 不是百分比 —— 两边各存一个 20 / 0.2，早晚有一个写错，表现是「界面说紧张、
 * 推送却没响」，谁也说不清该信哪个。
 */
const AT_RISK_RATIO = 0.2;

/**
 * 最紧的那一项额度：返回剩余比例（`0` = 已经见底）、字段名与那一项的实测数字，
 * 没有任何限制时返回 `null`。
 *
 * 为什么要看**所有维度**而不只看台数：真正拦住用户的常常是核数或内存 ——
 * 「还能建 1 台」但核数已经 0，实际是建不了的（见 enforce_create 的判定）。
 *
 * `ratio` 是 0~1 的**比例**（不是百分比）：显示层负责乘 100，别在两处各乘一次。
 * 超额时钳到 0，所以「超了 40%」和「正好用完」在这里都显示 0 —— 要区分得看
 * 返回的 `over`。
 *
 * 判据与后端 :func:`app.quotaalert.tightest` 一致：跳过未配置的上限、
 * 跳过单台封顶（``max_*``，那是「一台别开太大」，不是「快满了」）。
 */
function tightestQuota(row: QuotaOverviewRow) {
  let worst: {
    ratio: number;
    label: MessageKey;
    group: 'vm' | 'ct';
    field: string;
    limit: number;
    used: number;
    left: number;
    over: boolean;
  } | null = null;
  for (const group of ['vm', 'ct'] as const) {
    for (const [field, label] of [
      ['count', 'quota.fieldLabel.count'],
      ['cores', 'quota.fieldLabel.cores'],
      ['memory_mb', 'quota.fieldLabel.memory'],
      ['disk_gb', 'quota.fieldLabel.disk'],
    ] as const) {
      const limit = row.limits[group][field];
      const left = row.remaining[group][field];
      if (limit === null || limit === undefined || left === null) continue;
      const used = row.usage[group][field];
      if (used === null || used === undefined) continue;
      const ratio = limit > 0 ? Math.max(0, left) / limit : 0;
      if (!worst || ratio < worst.ratio) {
        worst = {
          ratio,
          label,
          group,
          field,
          limit,
          used,
          left,
          over: used > limit,
        };
      }
    }
  }
  return worst;
}

/**
 * 额度数值的展示：内存换算成 GB，其余按本来的单位。
 *
 * 为什么不用 `formatBytes`：那里是**字节**，额度里的 `memory_mb` / `disk_gb`
 * 记的是 MB / GB，`formatBytes` 会再乘一次 1024 —— 96 GB 的上限会被写成
 * 96 TB。
 */
function formatQuotaValue(field: string, value: number) {
  if (field === 'memory_mb') return `${(value / 1024).toFixed(1)} GB`;
  if (field === 'disk_gb') return `${value} GB`;
  if (field === 'cores') return `${value} ${tStatic('quota.unitCores')}`;
  return tStatic('users.quotaUnit', { n: value });
}

/** 「生效上限」那一格。上限按台数给（最直觉的一项），完整清单挂在 title 上。 */
function QuotaLimitCell({ row }: { row: QuotaOverviewRow }) {
  const t = useT();
  if (row.bypass) {
    return <span className="fs-xs text-muted">{t('users.quotaBypass')}</span>;
  }
  const vm = row.limits.vm.count;
  const ct = row.limits.ct.count;
  if (vm === null && ct === null) {
    return <span className="fs-xs text-muted">{t('quota.unlimitedShort')}</span>;
  }
  /* 只显示一个数（虚拟机优先，没配就显示容器）。两个都摆出来的话
     「6 台 · 容器 2 台」在 118px 的列里会折成两行，这一列就废了 ——
     它存在的意义是**一眼扫过去**，需要细节的人点开编辑器。 */
  const shown = vm ?? ct;
  return (
    <span className="mono fs-sm" title={t('users.quotaLimitHint')}>
      {shown === null ? t('quota.unlimitedShort') : t('users.quotaUnit', { n: shown })}
    </span>
  );
}

/**
 * 「已用」那一格：显示名下台数，并在**最紧的一项**剩余偏低/见底时点出来。
 * 它是这张表存在的理由 —— 管理员扫一眼就知道该给谁放宽。
 */
function QuotaUsageCell({ row }: { row: QuotaOverviewRow }) {
  const t = useT();
  if (row.bypass) return <span className="fs-xs text-muted">—</span>;
  const used = row.usage.vm.count + row.usage.ct.count;
  const tight = tightestQuota(row);
  const level = !tight ? '' : tight.ratio <= 0 ? ' is-empty' : tight.ratio <= 0.2 ? ' is-low' : '';
  return (
    <span
      className={`quota-usage-cell${level}`}
      title={tight ? `${t('users.quotaTight')}：${t(tight.label)}` : undefined}
    >
      <span className="mono">{t('users.quotaUnit', { n: used })}</span>
      {level ? (
        <span className="quota-usage-flag">
          {tight!.ratio <= 0 ? t('users.quotaEmpty') : t('users.quotaLow')}
        </span>
      ) : null}
    </span>
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
