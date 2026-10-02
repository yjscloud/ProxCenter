/* ==========================================================================
   ProxCenter — Sidebar 侧边栏
   240px，可折叠到 64px；< 768px 变抽屉
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  IconActivity,
  IconAlert,
  IconAudit,
  IconBackup,
  IconBell,
  IconBox,
  IconChat,
  IconCheck,
  IconClock,
  IconRestart,
  IconDashboard,
  IconLock,
  IconNetwork,
  IconPlug,
  IconServer,
  IconSettings,
  IconShield,
  IconSnapshot,
  IconStorage,
  IconTerminal,
  IconTasks,
  IconTemplate,
  IconUser,
  IconUsers,
  IconVm,
  IconChevronLeft,
  IconChevronDown,
} from './Icons';
import { useSiteInfo } from '../hooks/useSiteInfo';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { BrandLogo } from './BrandLogo';
import { useT, type MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  /** 词条键：渲染时用 t() 取文案（词条表见 i18n/locales/zh-CN.ts） */
  labelKey: MessageKey;
  icon: React.ReactNode;
  /** 需要的权限（admin 自动通过）*/
  permission?: string;
  /** 仅管理员可见：用于全局单例的配置页（如飞书机器人，普通用户看不到）*/
  adminOnly?: boolean;
}

export interface NavSection {
  /**
   * 稳定标识，**不随语言变化**：折叠偏好按它记。用标题当键的话，
   * 用户切一次语言，折叠状态就会「丢」在另一种语言的标题上。
   */
  id: string;
  titleKey: MessageKey;
  items: NavItem[];
  /**
   * 低频分组：默认折叠，点标题展开，展开状态按浏览器记在 localStorage。
   *
   * 只给「系统管理」用 —— 它 5 项且都是偶尔才点的管理入口，平铺时会把
   * 侧边栏顶出可视区，让高频项之外的每一样东西都要滚一下才够得着。
   * 当前路由落在该分组内时会自动展开（不写回偏好），否则点进设置页后
   * 左侧会看不见自己在哪。
   */
  collapsible?: boolean;
}

/** 折叠分组的偏好键。与侧边栏收起状态一样是浏览器级的界面偏好，不按账号隔离。 */
const COLLAPSED_SECTIONS_KEY = 'pve_nav_collapsed_sections';

/** 首次进来时默认折叠的分组：低频、且正好在首屏之外 */
const DEFAULT_COLLAPSED_SECTIONS = ['system'];

/**
 * 早期版本拿分组标题（中文）当折叠键，改成分组 id 后要迁移一次 ——
 * 否则老用户升级回来会发现「系统管理」又被展开了。
 */
const LEGACY_SECTION_KEYS: Record<string, string> = { '系统管理': 'system' };

function readCollapsedSections(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    // 从没存过（首次使用）= 用默认值；存过空数组 = 用户主动全展开，要尊重
    if (raw === null) return DEFAULT_COLLAPSED_SECTIONS;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((x): x is string => typeof x === 'string')
          .map((x) => LEGACY_SECTION_KEYS[x] ?? x)
      : DEFAULT_COLLAPSED_SECTIONS;
  } catch {
    return DEFAULT_COLLAPSED_SECTIONS;
  }
}

/**
 * 侧边栏分组。
 *
 * 两条约定（改动前请先读一遍）：
 *  1. 顺序按「资源 → 保护 → 观测 → 管控」走，也就是用户实际的工作顺序：
 *     建资源（计算 / 存储与网络）→ 先把数据兜住（数据保护）→ 加固与观测
 *     （安全 / 观测与集成）→ 管理面板自己（系统管理）。
 *  2. **每组最多 5 项**，超过就该再拆一组 —— 一组塞 6 项时，用户得逐个读
 *     标题才能找到目标，分组本身也就失去意义了。系统管理是唯一例外（5 项
 *     且已折叠）。
 *
 * 每项使用互不重复的图标（改动时请保持唯一性）。
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    titleKey: 'nav.section.overview',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', icon: <IconDashboard size={18} /> },
    ],
  },
  {
    id: 'compute',
    titleKey: 'nav.section.compute',
    items: [
      /* 没有单独的「快速部署」页：快速 / 自定义是创建弹窗里的一个开关，
         入口只有列表页的「创建虚拟机」与「创建容器」。 */
      /* 容器与虚拟机是两套独立页面（PVE 上也是两套端点），各自带创建入口。
         虚拟机排在容器前面：绝大多数运维场景以虚拟机为主，容器是次要的那一类。 */
      { to: '/vms', labelKey: 'nav.vms', icon: <IconVm size={18} /> },
      { to: '/lxc', labelKey: 'nav.lxc', icon: <IconBox size={18} /> },
      { to: '/templates', labelKey: 'nav.templates', icon: <IconTemplate size={18} /> },
      { to: '/nodes', labelKey: 'nav.nodes', icon: <IconServer size={18} /> },
    ],
  },
  {
    id: 'storage-network',
    titleKey: 'nav.section.storageNetwork',
    items: [
      { to: '/storages', labelKey: 'nav.storages', icon: <IconStorage size={18} /> },
      { to: '/networks', labelKey: 'nav.networks', icon: <IconNetwork size={18} /> },
      { to: '/frp', labelKey: 'nav.frp', icon: <IconPlug size={18} /> },
    ],
  },
  {
    /* 紧跟在资源之后：用户心智是「建完机器立刻把数据兜住」，
       排在「安全」后面会让人跨两组往下找。
       应急响应也在这里 —— 它的内容是「隔离可疑虚拟机 + 备份防删核对」，
       属于「机器出事了怎么办」，和快照 / 备份是同一件事的两端。 */
    id: 'data-protection',
    titleKey: 'nav.section.dataProtection',
    items: [
      { to: '/snapshots', labelKey: 'nav.snapshots', icon: <IconSnapshot size={18} /> },
      { to: '/backups', labelKey: 'nav.backups', icon: <IconBackup size={18} /> },
      {
        to: '/incident',
        labelKey: 'nav.incident',
        icon: <IconAlert size={18} />,
        permission: 'vm.backup',
      },
    ],
  },
  {
    /* 只留「防」与「查」：网络策略（防火墙）、主机加固与体检（SSH 安全 /
       安全基线 / 端口与进程）、追溯（登录审计）。
       「处置」已经挪到数据保护，这一组从 6 项降到 5 项。

       注意：其中 4 项读的是**主机级**数据（宿主机登录爆破、基线评分、端口与
       进程清单），默认只有管理员有对应权限 —— 普通用户看到的这一组只剩
       「防火墙」。这不是漏配，而是因为 ssh_hosts 里没有「主机归谁」这个维度，
       发给普通用户等于公开宿主机信息；管理员可在自定义角色里单独授予。 */
    id: 'security',
    titleKey: 'nav.section.security',
    items: [
      {
        to: '/firewall',
        labelKey: 'nav.firewall',
        icon: <IconLock size={18} />,
        permission: 'firewall.view',
      },
      {
        /* 默认落在「主机与告警配置」而不是监测数据：SSH 凭据与告警策略是这台
           面板真正要人去配的东西，监测数据配好了就只是看。两个页面顶部都有一组
           subnav 可以互相跳，所以监测数据并没有变成不可达 —— 只是深了一层。 */
        to: '/ssh-security/config',
        labelKey: 'nav.sshSecurity',
        icon: <IconTerminal size={18} />,
        permission: 'ssh.view',
      },
      {
        to: '/host-audit',
        labelKey: 'nav.hostAudit',
        icon: <IconClock size={18} />,
        permission: 'ssh.view',
      },
      {
        to: '/ports',
        labelKey: 'nav.ports',
        icon: <IconActivity size={18} />,
        permission: 'ports.view',
      },
      {
        to: '/security-baseline',
        labelKey: 'nav.securityBaseline',
        icon: <IconCheck size={18} />,
        permission: 'baseline.view',
      },
    ],
  },
  {
    /* 「看」与「接」：告警是观测，证书与机器人是外部通道。
       证书不算监控，但它和告警一样是「系统在替你盯着外面的事」。 */
    id: 'observability',
    titleKey: 'nav.section.observability',
    items: [
      { to: '/alerts', labelKey: 'nav.alerts', icon: <IconBell size={18} /> },
      {
        to: '/certificates',
        labelKey: 'nav.certificates',
        icon: <IconShield size={18} />,
        permission: 'cert.view',
      },
      {
        to: '/bot',
        labelKey: 'nav.feishuBot',
        icon: <IconChat size={18} />,
        adminOnly: true,
      },
    ],
  },
  {
    // 整个分组仅管理员可见：普通用户（operator / viewer）侧边栏不会出现该分组。
    // 折叠起来是因为它全是低频入口，平铺会把下面所有内容顶出首屏。
    id: 'system',
    titleKey: 'nav.section.system',
    collapsible: true,
    items: [
      { to: '/tasks', labelKey: 'nav.tasks', icon: <IconTasks size={18} />, adminOnly: true },
      { to: '/users', labelKey: 'nav.users', icon: <IconUsers size={18} />, adminOnly: true },
      { to: '/audit', labelKey: 'nav.audit', icon: <IconAudit size={18} />, adminOnly: true },
      { to: '/settings', labelKey: 'nav.settings', icon: <IconSettings size={18} />, adminOnly: true },
      /* 后台作业：巡检什么时候跑、跑成什么样、间隔能不能调。
         用循环箭头而不是时钟 —— 时钟已给「登录审计」，这里要保持图标唯一。 */
      { to: '/scheduler', labelKey: 'nav.scheduler', icon: <IconRestart size={18} />, adminOnly: true },
    ],
  },
];

/**
 * 导航项对当前用户是否可见。
 *
 * 侧边栏的过滤与命令面板的「页面」分组共用这一份判断 —— 两边各写一套的话，
 * 普通用户迟早能从 Ctrl+K 里跳进侧边栏看不见的页面（例如 /users）。
 */
export function canAccessNav(
  // 只用到这两个字段：写成结构类型，调用方不必为了传参把自己伪装成 NavItem
  item: { permission?: string; adminOnly?: boolean },
  user: { role?: string; permissions?: string[] } | null | undefined,
): boolean {
  if (user?.role === 'admin') return true;
  if (item.adminOnly) return false;
  if (!item.permission) return true;
  return user?.permissions?.includes(item.permission) ?? false;
}

/** 当前路由是否落在某一组里（用于自动展开被折叠的分组） */
export function isPathInSection(section: NavSection, pathname: string): boolean {
  return section.items.some((item) => {
    if (item.to === '/') return pathname === '/';
    return pathname === item.to || pathname.startsWith(`${item.to}/`);
  });
}

/* ---------------------------------------------------------------------------
   面板级「入口开关」（服务端配置，所有用户共享）
   ---------------------------------------------------------------------------
   管理员在「设置 → 导航栏功能开关」里逐个关闭入口。判据只有一份、写在这里：
   侧边栏、顶栏菜单、全局搜索、路由拦截都调它 —— 各处自己写一套的话，
   迟早出现「侧边栏里没有了，Ctrl+K 还搜得到」这种半关状态。

   匹配按**前缀**走：关掉 /nodes 时，它的子页面（/nodes/connections、
   /nodes/<节点名>）一起关 —— 用户心智里那些页面本来就属于同一个功能。
   --------------------------------------------------------------------------- */

/**
 * 无论配置如何都保持可达的路径。
 *
 * 目前只有「系统设置」：它是重新打开这些开关的唯一入口，把它一起关掉之后，
 * 界面上就再没有地方能恢复了（只能改数据库）。
 */
export const ALWAYS_OPEN_PATHS = ['/settings'];

/** 该路径对应的入口是否已被面板级开关关闭。 */
export function isPathDisabled(
  pathname: string,
  disabled: readonly string[],
): boolean {
  if (
    ALWAYS_OPEN_PATHS.some(
      (open) => pathname === open || pathname.startsWith(`${open}/`),
    )
  ) {
    return false;
  }
  return disabled.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * 侧边栏底部（账号区）的入口。不属于任何分组，但同样是「侧边栏的一项」，
 * 所以同样参与开关、搜索与路由拦截。
 *
 * 注意：它必须与下面 footer 里真实渲染的链接保持一致（加一项就补一项）。
 */
export const FOOTER_NAV_ITEMS: NavItem[] = [
  { to: '/profile', labelKey: 'nav.profile', icon: null },
];

/** 侧边栏里所有入口（按显示顺序），供「逐项开关」与兜底跳转共用。 */
export function allNavItems(): NavItem[] {
  return [...NAV_SECTIONS.flatMap((section) => section.items), ...FOOTER_NAV_ITEMS];
}

/**
 * 被关闭的入口被直接访问时，该弹回哪个页面。
 *
 * 取「第一个当前用户有权看、且还开着」的入口。特意在这里就把权限算进去：
 * 弹回一个该用户进不去的页面，会被那个页面的权限守卫再弹一次，几个来回
 * 就是死循环。一个都没有时返回空串，由调用方渲染一句说明。
 */
export function firstAvailableNavPath(
  disabled: readonly string[],
  user: { role?: string; permissions?: string[] } | null | undefined,
): string {
  for (const item of allNavItems()) {
    if (!canAccessNav(item, user)) continue;
    if (isPathDisabled(item.to, disabled)) continue;
    return item.to;
  }
  return '';
}

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 移动端抽屉是否打开 */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** 过滤导航项（权限）*/
  canAccess: (item: NavItem) => boolean;
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  canAccess,
}: SidebarProps) {
  const site = useSiteInfo();
  const t = useT();
  const { pathname } = useLocation();
  /* 被管理员关闭的入口：与权限过滤一样，属于「这一项该不该出现」的判断 */
  const disabledPaths = useUiPrefs().nav_disabled;
  const [collapsedSections, setCollapsedSections] = useState<string[]>(readCollapsedSections);

  /* 持久化折叠偏好 */
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(collapsedSections));
    } catch {
      /* 忽略 */
    }
  }, [collapsedSections]);

  /* 用户手动点过的分组：一旦点过，就完全听用户的，不再被「当前页在这一组里
     就自动展开」覆盖 —— 否则站在设置页上点收起会像点了没反应。 */
  const userToggled = useRef<Set<string>>(new Set());

  const toggleSection = (title: string) => {
    userToggled.current.add(title);
    setCollapsedSections((list) =>
      list.includes(title) ? list.filter((t) => t !== title) : [...list, title],
    );
  };

  const classes = [
    'sidebar',
    collapsed ? 'is-collapsed' : '',
    mobileOpen ? 'is-mobile-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {mobileOpen ? (
        <div
          className="sidebar-mobile-overlay"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      ) : null}

      <aside className={classes} aria-label={t('sidebar.aria')}>
        {/* 品牌区 */}
        <div className="sidebar-brand">
          <NavLink to="/dashboard" className="brand-link" onClick={onCloseMobile}>
            <span className="brand-mark" aria-hidden="true">
              <BrandLogo size={26} />
            </span>
            {!collapsed ? (
              <span className="brand-text">
                <span className="brand-name">{site.name}</span>
                <span className="brand-sub">{site.subtitle}</span>
              </span>
            ) : null}
          </NavLink>
        </div>

        {/* 导航 */}
        <nav className="sidebar-nav">
          {NAV_SECTIONS.map((section) => {
            const items = section.items
              .filter(canAccess)
              .filter((item) => !isPathDisabled(item.to, disabledPaths));
            if (items.length === 0) return null;

            /* 折叠态（64px）下没有标题栏可点，也放不下箭头：直接展开，
               否则分组会被永久藏起来。 */
            const folded =
              !collapsed &&
              Boolean(section.collapsible) &&
              collapsedSections.includes(section.id) &&
              // 当前页在这一组里时自动展开，免得「我在哪」都看不见；
              // 但用户手动点过就以用户的为准
              !(
                !userToggled.current.has(section.id) &&
                isPathInSection(section, pathname)
              );
            const expanded = !folded;

            return (
              <div className="nav-section" key={section.id}>
                {!collapsed ? (
                  section.collapsible ? (
                    <button
                      type="button"
                      className="nav-section-title is-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleSection(section.id)}
                    >
                      <span>{t(section.titleKey)}</span>
                      <span className={`nav-section-caret ${expanded ? 'is-open' : ''}`}>
                        <IconChevronDown size={13} />
                      </span>
                    </button>
                  ) : (
                    <div className="nav-section-title">{t(section.titleKey)}</div>
                  )
                ) : (
                  <div className="nav-section-divider" aria-hidden="true" />
                )}

                {expanded
                  ? items.map((item) => {
                      /* 折叠态下拉菜单只显示图标，label 同时用于 tooltip 与读屏 */
                      const label = t(item.labelKey);
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.to === '/'}
                          className={({ isActive }) =>
                            `nav-item ${isActive ? 'is-active' : ''}`
                          }
                          onClick={onCloseMobile}
                          title={collapsed ? label : undefined}
                        >
                          <span className="nav-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                          {!collapsed ? (
                            <span className="nav-label">{label}</span>
                          ) : (
                            <span className="sr-only">{label}</span>
                          )}
                        </NavLink>
                      );
                    })
                  : null}
              </div>
            );
          })}
        </nav>

        {/* 底部：「账号」区 + 折叠按钮。
            个人中心原先自己占一个「账号」分组（1 项 + 1 个组标题 ≈ 62px），
            挪到这里既省掉一个分组，也和顶栏头像菜单的位置语义一致（都在「我的」上）。
            对 viewer / operator 来说它仍是唯一可见入口，所以不能只留顶栏那份。 */}
        <div className="sidebar-footer">
          {/* 与「个人中心」这一项对应的开关：路径取自 FOOTER_NAV_ITEMS，
              两处必须一致（那边是给设置页与兜底跳转用的） */}
          {isPathDisabled(FOOTER_NAV_ITEMS[0].to, disabledPaths) ? null : (
            <NavLink
              to={FOOTER_NAV_ITEMS[0].to}
              className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}
              onClick={onCloseMobile}
              title={collapsed ? t(FOOTER_NAV_ITEMS[0].labelKey) : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <IconUser size={18} />
              </span>
              {!collapsed ? (
                <span className="nav-label">{t(FOOTER_NAV_ITEMS[0].labelKey)}</span>
              ) : (
                <span className="sr-only">{t(FOOTER_NAV_ITEMS[0].labelKey)}</span>
              )}
            </NavLink>
          )}

          <button
            type="button"
            className="collapse-btn"
            onClick={onToggleCollapse}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            <span className="collapse-icon" aria-hidden="true">
              <IconChevronLeft size={16} />
            </span>
            {!collapsed ? <span>{t('sidebar.collapse')}</span> : null}
          </button>
        </div>
      </aside>
    </>
  );
}
