/* ==========================================================================
   ProxCenter — 工作台（首页第一屏）
   ==========================================================================

   仪表盘原来的第一屏是六张「看」的卡片：KPI、节点、分布、容量、排行、任务。
   看完了「现在是什么样」，还缺一句「接下来该做什么」—— 也就是腾讯云控制台
   首屏那三块里的**待办 + 快捷操作**。

   这一块刻意不参与仪表盘的「编辑布局」：它是首页的固定引导区，用户把 KPI
   拖走了也不该把「待办」一起拖没；顺序与显隐在这里没有意义。

   数据全部复用既有接口，且尽可能复用既有 queryKey —— react-query 按 key
   去重，仪表盘与告警页/设置页同时打开时不会重复打后端：
     * 连接配置 / 连接状态    → ['connections'] / ['connections','status']
     * 待审批注册（管理员）   → ['users','pending']
     * 下发配额              → ['vms','quota']
     * 告警历史              → ['alerts']
     * 安全基线全平台总览     → ['baseline','fleet']

   每一项都按「值得为它打断用户吗」排序：连接断了 / 配额耗尽这类会**阻塞工作**
   的排前面，安全体检这类「越早越省事」的排后面。
   ========================================================================== */

import { useEffect, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  alertsApi,
  baselineApi,
  connectionsApi,
  usersApi,
  vmsApi,
} from '../api/endpoints';
import { useAuth } from '../hooks/useAuth';
import {
  IconAlert,
  IconBell,
  IconChevronRight,
  IconCheck,
  IconLayout,
  IconPlug,
  IconPlus,
  IconServer,
  IconShield,
  IconTasks,
  IconUsers,
  IconVm,
} from './Icons';

/* ---------------------------------------------------------------------------
   类型
   --------------------------------------------------------------------------- */

/** 待办的紧急程度：决定左侧色条与图标配色，也决定排序 */
type TodoTone = 'danger' | 'warning' | 'info';

interface TodoItem {
  id: string;
  tone: TodoTone;
  title: string;
  detail: string;
  /** 点击后跳转的目标 */
  to: string;
  icon: ReactNode;
}

interface QuickAction {
  id: string;
  label: string;
  hint: string;
  /** 单键快捷键（小写，按下即触发） */
  key: string;
  to: string;
  icon: ReactNode;
}

const TONE_ORDER: Record<TodoTone, number> = { danger: 0, warning: 1, info: 2 };

/* 配额告急的判定：剩余台数不超过 2 台，或只剩不到 10% 的额度。
   两者取其一即可 —— 100 台的额度剩 8 台还很宽裕，3 台的额度剩 1 台就很紧。 */
const LOW_QUOTA_ABSOLUTE = 2;
const LOW_QUOTA_RATIO = 0.1;

/* ---------------------------------------------------------------------------
   工作台
   --------------------------------------------------------------------------- */

export function Workbench() {
  const navigate = useNavigate();
  const { isAdmin, hasPermission } = useAuth();

  /* 能力开关：没这个权限就不去请求、也不显示对应条目（否则一点就 403） */
  const canVmCreate = hasPermission('vm.create');
  const canFrp = hasPermission('frp.view');
  const canAlert = hasPermission('alert.view');
  const canBaseline = hasPermission('baseline.view');
  const canNodes = hasPermission('node.view');

  /* ---- 数据 ---- */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 60_000,
    enabled: isAdmin,
  });

  const connStatusQuery = useQuery({
    queryKey: ['connections', 'status'],
    queryFn: connectionsApi.status,
    refetchInterval: 30_000,
    enabled: isAdmin,
  });

  const pendingQuery = useQuery({
    queryKey: ['users', 'pending'],
    queryFn: () => usersApi.list('pending'),
    staleTime: 60_000,
    enabled: isAdmin,
  });

  const quotaQuery = useQuery({
    queryKey: ['vms', 'quota'],
    queryFn: vmsApi.quota,
    staleTime: 60_000,
  });

  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: alertsApi.get,
    refetchInterval: 60_000,
    enabled: canAlert,
  });

  /* 基线体检会并发去 SSH 每台受管主机（实测 3 秒，主机不可达时几十秒）—— 它是
     待办里**最不紧急**的一项，所以三件事一起做，别让它拖慢首页：

     * `stale=1`：有旧值就先返回、真扫放到后台（后端 reportcache 的 stale 通路），
       于是几乎每次打开都是毫秒级；
     * 缓存留久一点（staleTime 10 分钟、gcTime 30 分钟），来回切页面不重扫；
     * 不轮询、不在挂载 / 聚焦时重取。 */
  const baselineQuery = useQuery({
    queryKey: ['baseline', 'fleet'],
    queryFn: () => baselineApi.fleet(false, true),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    enabled: canBaseline,
  });

  /* ---- 待办聚合 ---- */
  const todos = useMemo<TodoItem[]>(() => {
    const items: TodoItem[] = [];

    /* 1) 连接未配置 / 2) 已配置的 PVE 连不上。
       这是最该先说的事：它一断，页面上到处都是空的，别让用户以为是数据不刷新。 */
    if (isAdmin && connectionsQuery.data) {
      const connections = connectionsQuery.data;
      if (connections.length === 0) {
        items.push({
          id: 'conn-missing',
          tone: 'danger',
          title: '尚未配置 Proxmox 连接',
          detail: '面板还连不上任何 PVE，节点与虚拟机数据都是空的',
          to: '/settings',
          icon: <IconPlug size={16} />,
        });
      } else {
        const down = (connStatusQuery.data ?? []).filter((c) => !c.ok);
        if (down.length > 0) {
          items.push({
            id: 'conn-down',
            tone: 'danger',
            title: `${down.length} 个 PVE 连接不可用`,
            detail: down
              .map((c) => c.name || c.host)
              .filter(Boolean)
              .join('、'),
            to: '/settings',
            icon: <IconAlert size={16} />,
          });
        }
      }
    }

    /* 3) 待审批注册（管理员）：账号在门外等着，审批前一步也走不了 */
    const pendingCount = pendingQuery.data?.length ?? 0;
    if (isAdmin && pendingCount > 0) {
      items.push({
        id: 'pending-users',
        tone: 'warning',
        title: `${pendingCount} 个注册申请待审批`,
        detail: '通过并分配角色后对方才能登录',
        to: '/users',
        icon: <IconUsers size={16} />,
      });
    }

    /* 4) 下发配额告急：快没额度了，等建不出来时才说就晚了 */
    const quota = quotaQuery.data;
    if (quota?.limited && quota.remaining !== null) {
      const ratio = quota.quota && quota.quota > 0 ? quota.remaining / quota.quota : 1;
      const tight =
        quota.remaining <= LOW_QUOTA_ABSOLUTE || ratio <= LOW_QUOTA_RATIO;
      if (tight) {
        const exhausted = quota.remaining <= 0;
        items.push({
          id: 'quota-low',
          tone: exhausted ? 'danger' : 'warning',
          title: exhausted
            ? '下发配额已用尽，无法再创建机器'
            : `下发配额仅剩 ${quota.remaining} 台`,
          detail: `已用 ${quota.used} / ${quota.quota} 台${
            exhausted ? '' : '，请提前调整额度'
          }`,
          to: isAdmin ? '/settings' : '/vms',
          icon: <IconVm size={16} />,
        });
      }
    }

    /* 5) 待处理告警：**只数还没恢复的**。
       早先这里数的是历史条数（除「恢复」外的都算），但历史回答的是「发生过
       什么」—— 实测过：某个时刻一个对象都没在告警，待办却挂着 50 条，全是
       过去 27 小时里反复触发的旧记录。
       改用后端给的 active（正在告警中的对象）：它已经排除了已恢复的，以及
       来源被静默（停推）的。按目标去重，同一台机器的 CPU 与内存两条规则也
       只算一个对象。 */
    const activeAlarms = alertsQuery.data?.active ?? [];
    const alarmingTargets = Array.from(
      new Set(activeAlarms.map((a) => String(a.target || '')).filter(Boolean)),
    );
    if (alarmingTargets.length > 0) {
      const shown = alarmingTargets.slice(0, 3).join('、');
      items.push({
        id: 'alerts',
        tone: 'warning',
        title: `${alarmingTargets.length} 个对象正在告警`,
        detail: `${shown}${alarmingTargets.length > 3 ? ' 等' : ''}（已恢复的不计入）`,
        to: '/alerts',
        icon: <IconBell size={16} />,
      });
    }

    /* 6) 安全基线：不阻塞工作，但越早处理代价越小 */
    const totals = baselineQuery.data?.totals;
    if (totals && totals.fail > 0) {
      items.push({
        id: 'baseline',
        tone: 'info',
        title: `${totals.fail} 项安全基线未通过`,
        detail: `${totals.hosts} 台服务器受检，其中 ${totals.fixable} 项可一键加固`,
        to: '/security-baseline',
        icon: <IconShield size={16} />,
      });
    }

    return items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  }, [
    isAdmin,
    connectionsQuery.data,
    connStatusQuery.data,
    pendingQuery.data,
    quotaQuery.data,
    alertsQuery.data,
    baselineQuery.data,
  ]);

  /* ---- 快捷操作：按权限裁剪，最多 6 个（两列三行正好铺满，再多就不「快」了） ---- */
  const actions = useMemo<QuickAction[]>(() => {
    const list: QuickAction[] = [];

    if (canVmCreate) {
      list.push({
        id: 'create-vm',
        label: '创建虚拟机',
        hint: '直接打开创建向导',
        key: 'c',
        to: '/vms?new=1',
        icon: <IconPlus size={15} />,
      });
    }
    /* 紧跟在「创建虚拟机」之后：这两件事是同一个动作的两端 ——
       先建机器，再把它提供的服务放出去。放到列表末尾就得跨两行去找。 */
    if (canFrp) {
      list.push({
        id: 'frp',
        label: '内网穿透',
        hint: '用 frp 把内网服务映射到公网',
        key: 'f',
        to: '/frp',
        icon: <IconPlug size={15} />,
      });
    }
    if (isAdmin) {
      list.push({
        id: 'tasks',
        label: '任务队列',
        hint: '查看最近的集群任务',
        key: 't',
        to: '/tasks',
        icon: <IconTasks size={15} />,
      });
    }
    if (canAlert) {
      list.push({
        id: 'alerts',
        label: '查看告警',
        hint: '监控规则与告警历史',
        key: 'a',
        to: '/alerts',
        icon: <IconBell size={15} />,
      });
    }
    if (canNodes) {
      list.push({
        id: 'nodes',
        label: '节点总览',
        hint: '集群节点负载与状态',
        key: 'n',
        to: '/nodes',
        icon: <IconServer size={15} />,
      });
    }
    if (canBaseline) {
      list.push({
        id: 'baseline',
        label: '安全体检',
        hint: '基线评分与一键加固',
        key: 'b',
        to: '/security-baseline',
        icon: <IconShield size={15} />,
      });
    }
    return list.slice(0, 6);
  }, [canVmCreate, canFrp, isAdmin, canAlert, canNodes, canBaseline]);

  /* ---- 单键快捷键 ----
     只在「没在输入框里、没按修饰键」时生效：面板里到处是搜索框，若不加这层
     判断，用户在筛选框里打个 c 就被弹去创建虚拟机了。 */
  useEffect(() => {
    if (actions.length === 0) return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      const hit = actions.find((a) => a.key === event.key.toLowerCase());
      if (!hit) return;
      event.preventDefault();
      navigate(hit.to);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [actions, navigate]);

  /* 首屏还在等数据（且暂时没有待办可展示）时才铺骨架屏；
     已有待办就先显示，剩下的慢慢补，避免整块区域闪烁。

     这里**刻意不算基线体检**：那一项要 SSH 每台主机（几秒到几十秒），而它是
     待办里最不紧急的一条 —— 因为它把整块待办按住、让「连接断了」这种真正
     阻塞工作的事一起等，是本末倒置。它到了自己会补上来。 */
  const loading =
    todos.length === 0 &&
    ((isAdmin && (connectionsQuery.isPending || pendingQuery.isPending)) ||
      quotaQuery.isPending ||
      (canAlert && alertsQuery.isPending));

  if (todos.length === 0 && actions.length === 0) return null;

  return (
    <section className="wb" aria-label="工作台">
      <div className="wb-head">
        <div className="wb-head-title">
          <IconLayout size={16} />
          <span>工作台</span>
          {todos.length > 0 ? (
            <span className={`wb-head-count wb-tone-${todos[0].tone}`}>
              {todos.length} 项待办
            </span>
          ) : null}
        </div>
        <div className="wb-head-note">按快捷键直达常用操作</div>
      </div>

      <div className="wb-grid">
        {/* ---- 待办事项 ---- */}
        <div className="wb-col">
          <div className="wb-col-title">待办事项</div>

          {loading ? (
            <div className="wb-list" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton wb-skeleton" />
              ))}
            </div>
          ) : todos.length === 0 && baselineQuery.isPending ? (
            /* 体检还没回来：这时候不能先说「待办已清空」—— 它随时可能带出一条 */
            <div className="wb-list">
              <div className="skeleton wb-skeleton" />
            </div>
          ) : todos.length === 0 ? (
            <div className="wb-clear">
              <span className="wb-clear-icon" aria-hidden="true">
                <IconCheck size={17} />
              </span>
              <div className="wb-clear-text">
                <div className="wb-clear-title">待办已清空</div>
                <div className="wb-clear-desc">
                  集群运转正常，当前没有需要你处理的事项
                </div>
              </div>
            </div>
          ) : (
            <div className="wb-list">
              {todos.map((todo) => (
                <button
                  key={todo.id}
                  type="button"
                  className={`wb-todo wb-tone-${todo.tone}`}
                  onClick={() => navigate(todo.to)}
                >
                  <span className="wb-todo-icon" aria-hidden="true">
                    {todo.icon}
                  </span>
                  <span className="wb-todo-main">
                    <span className="wb-todo-title">{todo.title}</span>
                    {todo.detail ? (
                      <span className="wb-todo-detail truncate">
                        {todo.detail}
                      </span>
                    ) : null}
                  </span>
                  <IconChevronRight size={14} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ---- 快捷操作 ---- */}
        {actions.length > 0 ? (
          <div className="wb-col">
            <div className="wb-col-title">快捷操作</div>
            <div className="wb-actions">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="wb-action"
                  title={`${action.hint}（快捷键 ${action.key.toUpperCase()}）`}
                  aria-keyshortcuts={action.key}
                  onClick={() => navigate(action.to)}
                >
                  <span className="wb-action-icon" aria-hidden="true">
                    {action.icon}
                  </span>
                  <span className="wb-action-label truncate">
                    {action.label}
                  </span>
                  <kbd className="wb-kbd">{action.key.toUpperCase()}</kbd>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
