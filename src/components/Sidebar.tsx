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
  IconSparkle,
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
import { usePveStatus } from '../hooks/usePveStatus';
import { userHasPermission } from '../hooks/useAuth';
import type { PermissionKey } from '../api/permissions';
import { BrandLogo } from './BrandLogo';
import { useT, type MessageKey } from '../i18n';

export interface NavItem {
  to: string;
  /** 词条键：渲染时用 t() 取文案（词条表见 i18n/locales/zh-CN.ts） */
  labelKey: MessageKey;
  icon: React.ReactNode;
  /** 需要的权限（admin 自动通过）。键取 ``api/permissions.ts`` */
  permission?: PermissionKey;
  /**
   * 需要的权限之一（**任一命中即可**）。用于跨类型的汇总页：快照 / 备份这类页面
   * 同时覆盖虚拟机与容器，只认 vm.* 会把「只有容器权限」的用户挡在门外。
   * 写了 ``permissions`` 就忽略 ``permission``。
   */
  permissions?: PermissionKey[];
  /**
   * 仅**超级管理员**可见（``role == admin``）。
   *
   * 目前没有菜单项用它 —— 面板自身的页面一律走 ``permission``（users.view /
   * audit.view / settings.manage），这样自定义角色也能按需接管那部分工作。
   * 留着它是因为「只有超管能碰」与「有这个权限就能碰」是两回事：将来出现真正
   * 不可委派的面板入口（例如面板密钥轮换）时才用得上。
   */
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
 * 数据来自 Proxmox 的入口。
 *
 * 面板还没接入任何 PVE 时，这些页面点进去只会看到「去添加连接」的引导 ——
 * 与其让用户一个个点过去试（然后怀疑页面坏了），不如在导航里先标出来。
 *
 * 用路径而不是给 NavItem 加字段：这份清单要回答的是「哪些页面的数据来自 PVE」，
 * 按路径列出来一眼就能核对，也和 isPathDisabled / firstAvailableNavPath 的
 * 判定方式保持一致。
 */
const PVE_NAV_PATHS = new Set([
  '/dashboard',
  '/vms',
  '/lxc',
  '/templates',
  '/nodes',
  '/storages',
  '/networks',
  '/snapshots',
  '/backups',
  '/incident',
  '/firewall',
  '/tasks',
]);

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
 *
 * **每一项都必须写 ``permission``**（或 ``permissions``），权限键取对应页面主要
 * 数据接口用的那一个（后端 ``routers/*.py`` 里的 ``require_permission``）。漏写
 * 的项对**所有**登录用户可见 —— 自定义角色只勾了虚拟机权限，侧边栏却把存储、
 * 网络、告警、穿透全都列出来，点进去只会吃 403。
 *
 * 面板自身的页面（用户 / 审计 / 设置 / 后台作业 / 飞书）也一样走 permission：
 * users.view、audit.view、settings.manage…… 与后端接口一一对应。它们原先写的是
 * ``adminOnly``（只认 role == admin），而后端按权限放行 —— 同一件事判两次、判据
 * 还不一样，结果就是「勾了权限也进不去」。
*/
/**
 * 「SSH 安全」入口的路径。
 *
 * 单独抽出来是因为除了导航栏，**创建虚拟机**时的「接入安全管控」开关也要跟着它：
 * 勾了那个开关，机器会被登记成受管主机，而看这些主机的地方（SSH 安全 / 登录审计 /
 * 端口与进程 / 安全基线）全在这个入口下面 —— 入口被面板级开关关掉之后，那个开关
 * 就变成「勾了没处看」。两处判定必须同源，所以路径只写一遍
 * （见 QuickDeployForm 与 VmCreateWizard）。
 */
export const SSH_SECURITY_NAV_PATH = '/ssh-security/config';

/**
 * 「AI 排查助手」入口的路径。
 *
 * 同 SSH 安全：入口被面板级开关关掉之后，散落在各页面里的「问 AI」按钮也必须
 * 一起消失 —— 点过去只会被路由守卫弹回来。判定集中在 AskAiButton 的
 * `useAiAssistantEntry`，这里只负责让路径只写一遍。
 */
export const AI_ASSISTANT_NAV_PATH = '/ai-assistant';

/**
 * 「容器」入口的路径。
 *
 * 同 SSH 安全 / AI 助手：入口被面板级开关关掉之后，**别处零散的容器入口也得
 * 一起消失**，否则点过去只会被路由守卫弹回来。已知的一处是模板页的「容器模板」
 * 标签页 —— 那里装的是容器系统模板（vztmpl）与已转模板的容器，容器都不要了，
 * 留着这个页签只会给出一个死入口。判定必须同源，所以路径只写一遍。
 */
export const LXC_NAV_PATH = '/lxc';

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    titleKey: 'nav.section.overview',
    items: [
      /* 仪表盘读的是节点与虚拟机 / 容器两组数据（见 dashboard.py 的两个接口），
         取最基础的资源查看权限，虚拟机或容器任一即可 */
      {
        to: '/dashboard',
        labelKey: 'nav.dashboard',
        icon: <IconDashboard size={18} />,
        permissions: ['vm.view', 'ct.view'],
      },
    ],
  },
  {
    id: 'compute',
    titleKey: 'nav.section.compute',
    items: [
      /* 没有单独的「快速部署」页：快速 / 自定义是创建弹窗里的一个开关，
         入口只有列表页的「创建虚拟机」与「创建容器」。 */
      /* 容器与虚拟机是两套独立页面（PVE 上也是两套端点），各自带创建入口。
         虚拟机排在容器前面：绝大多数运维场景以虚拟机为主，容器是次要的那一类。
         权限也是**两套**：虚拟机 vm.*、容器 ct.*（后端 routers/vms.py 与 lxc.py
         分别校验），只被授予容器权限的用户看不到虚拟机入口，反之亦然。 */
      {
        to: '/vms',
        labelKey: 'nav.vms',
        icon: <IconVm size={18} />,
        permission: 'vm.view',
      },
      {
        to: '/lxc',
        labelKey: 'nav.lxc',
        icon: <IconBox size={18} />,
        permission: 'ct.view',
      },
      {
        to: '/templates',
        labelKey: 'nav.templates',
        icon: <IconTemplate size={18} />,
        permission: 'template.view',
      },
      {
        to: '/nodes',
        labelKey: 'nav.nodes',
        icon: <IconServer size={18} />,
        permission: 'node.view',
      },
    ],
  },
  {
    id: 'storage-network',
    titleKey: 'nav.section.storageNetwork',
    items: [
      {
        to: '/storages',
        labelKey: 'nav.storages',
        icon: <IconStorage size={18} />,
        permission: 'storage.view',
      },
      {
        to: '/networks',
        labelKey: 'nav.networks',
        icon: <IconNetwork size={18} />,
        permission: 'network.view',
      },
      {
        to: '/frp',
        labelKey: 'nav.frp',
        icon: <IconPlug size={18} />,
        permission: 'frp.view',
      },
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
      /* 快照页只是把各机器的快照汇总出来看（虚拟机 + 容器），任一类查看权限即可；
         页面里的回滚 / 删除再按目标类型判 vm.snapshot / ct.snapshot */
      {
        to: '/snapshots',
        labelKey: 'nav.snapshots',
        icon: <IconSnapshot size={18} />,
        permissions: ['vm.view', 'ct.view'],
      },
      {
        to: '/backups',
        labelKey: 'nav.backups',
        icon: <IconBackup size={18} />,
        permissions: ['vm.backup', 'ct.backup'],
      },
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
       两次外移把这组收回 5 项：处置类（应急响应）在「数据保护」，
       解读类（AI 排查助手）在「观测与集成」。

       注意：其中 4 项读的是**主机级**数据（宿主机登录爆破、基线评分、端口与
       进程清单），默认只有管理员有对应权限 —— 普通用户看到的这一组只剩
       「防火墙」。这不是漏配，而是因为 ssh_hosts 里没有「主机归谁」这个维度，
       发给普通用户等于公开宿主机信息；管理员可在自定义角色里单独授予。 */
    id: 'security',
    titleKey: 'nav.section.security',
    items: [
      {
        /* 页面里虚拟机与容器是两个独立作用域、两套权限：哪一侧都能进
           （只授予容器权限的自定义角色照样要能配容器防火墙） */
        to: '/firewall',
        labelKey: 'nav.firewall',
        icon: <IconLock size={18} />,
        permissions: ['firewall.view', 'ct.firewall.view'],
      },
      {
        /* 默认落在「主机与告警配置」而不是监测数据：SSH 凭据与告警策略是这台
           面板真正要人去配的东西，监测数据配好了就只是看。两个页面顶部都有一组
           subnav 可以互相跳，所以监测数据并没有变成不可达 —— 只是深了一层。 */
        to: SSH_SECURITY_NAV_PATH,
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
        to: '/security-baseline',
        labelKey: 'nav.securityBaseline',
        icon: <IconCheck size={18} />,
        permission: 'baseline.view',
      },
      {
        /* 端口与进程排在安全基线**之后**：两者问的都是「这台机器有没有问题」，
           基线管的是配置面（口令、补丁、内核参数），端口管的是运行面（谁在监听、
           进程可不可疑）。先看配置、再看运行面，是从静态到动态的排查顺序。 */
        to: '/ports',
        labelKey: 'nav.ports',
        icon: <IconActivity size={18} />,
        permission: 'ports.view',
      },
    ],
  },
  {
    /* 这一组回答「现在怎么样、有事谁告诉我」：告警与证书盯着外部，机器人是对外
       通道，AI 排查助手则是把巡检 / 基线结果读成结论的那一环。
       证书不算监控，但它和告警一样是「系统在替你盯着外面的事」。 */
    id: 'observability',
    titleKey: 'nav.section.observability',
    items: [
      {
        to: '/alerts',
        labelKey: 'nav.alerts',
        icon: <IconBell size={18} />,
        permission: 'alert.view',
      },
      {
        to: '/certificates',
        labelKey: 'nav.certificates',
        icon: <IconShield size={18} />,
        permission: 'cert.view',
      },
      /* 飞书机器人是**面板自身**的配置（后端 feishu.py 用 settings.manage），
         和设置同一档；放在这一组是因为它跟告警一样属于「系统替你盯着外面的事」 */
      {
        to: '/bot',
        labelKey: 'nav.feishuBot',
        icon: <IconChat size={18} />,
        permission: 'settings.manage',
      },
      /* AI 排查助手：紧跟在机器人下面 —— 两者都是「有事时把结论送到你面前」的
         一端（机器人送告警，它送归因）。原先挂在「安全」组末尾，与安全基线同档
         看着顺，但那组会因此变成 6 项；它真正消费的是巡检 / 基线结果、面向的是
         排障，归到观测更贴。
         权限仍是 baseline.view：后端 ai 路由的 VIEW 守卫、路由守卫与
         AskAiButton 用的是同一把钥匙（只有模型配置要 settings.manage）。 */
      {
        to: AI_ASSISTANT_NAV_PATH,
        labelKey: 'nav.aiAssistant',
        icon: <IconSparkle size={18} />,
        permission: 'baseline.view',
      },
    ],
  },
  {
    /* 这一组读的是**面板自己**的数据（任务队列、用户、审计日志、设置），不来自
       PVE，所以不套业务权限，而是各按**后端接口真正用的那个权限键**来：有就显示，
       没有的项由 canAccessNav 过滤掉，整组都不可见时连分组标题一起消失。

       这几项原先一律写 adminOnly（= 只有 role==admin 能看到），但后端早就是按
       users.view / audit.view / settings.manage 放行的 —— 于是「勾了权限却进不去」
       和「手输 URL 却能打开、里面每个按钮 403」同时存在。 */
    // 折叠起来是因为它全是低频入口，平铺会把下面所有内容顶出首屏。
    id: 'system',
    titleKey: 'nav.section.system',
    collapsible: true,
    items: [
      /* 任务队列：有 task.view 的用户（例如授予了它的运维）也该看到自己发起的
         任务跑成什么样 —— 后端 tasks.py 用的正是这个权限 */
      {
        to: '/tasks',
        labelKey: 'nav.tasks',
        icon: <IconTasks size={18} />,
        permission: 'task.view',
      },
      /* 用户与角色：给它的人进得来（后端 /users、/roles 读接口只要 users.view），
         但增删改还要 users.manage，页面内再判一次 */
      {
        to: '/users',
        labelKey: 'nav.users',
        icon: <IconUsers size={18} />,
        permission: 'users.view',
      },
      /* 审计日志：后端 audit.py 用 audit.view */
      {
        to: '/audit',
        labelKey: 'nav.audit',
        icon: <IconAudit size={18} />,
        permission: 'audit.view',
      },
      /* 设置与后台作业：面板自身的配置，与飞书机器人同一档（settings.manage） */
      {
        to: '/settings',
        labelKey: 'nav.settings',
        icon: <IconSettings size={18} />,
        permission: 'settings.manage',
      },
      /* 后台作业：巡检什么时候跑、跑成什么样、间隔能不能调。
         用循环箭头而不是时钟 —— 时钟已给「登录审计」，这里要保持图标唯一。 */
      {
        to: '/scheduler',
        labelKey: 'nav.scheduler',
        icon: <IconRestart size={18} />,
        permission: 'settings.manage',
      },
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
  // 只用到这几个字段：写成结构类型，调用方不必为了传参把自己伪装成 NavItem
  item: {
    permission?: PermissionKey;
    permissions?: PermissionKey[];
    adminOnly?: boolean;
  },
  user: { role?: string; permissions?: string[] } | null | undefined,
): boolean {
  if (user?.role === 'admin') return true;
  if (item.adminOnly) return false;
  // 逐项判定统一走 useAuth 的那一份（含 `*` 通配），不在两处各写一遍
  // any-of：跨类型汇总页（快照 / 备份）任一类权限即可
  if (item.permissions?.length) {
    return item.permissions.some((perm) => userHasPermission(user, perm));
  }
  if (!item.permission) return true;
  return userHasPermission(user, item.permission);
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
 * 按路径找到它对应的导航入口（子页面按前缀算作父入口）。
 *
 * 路由拦截用它回答「当前这个页面该不该让这个人看」—— 与侧边栏的可见性是同一
 * 份判据，避免出现「侧边栏里没有、手输 URL 却进得去」的两套规则。
 * 找不到对应入口的路径（详情页等）返回 undefined，调用方按「不拦」处理：那些
 * 页面各自有权限守卫，且它们的入口本来就藏在列表页里。
 */
export function navItemForPath(pathname: string): NavItem | undefined {
  return allNavItems().find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
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
  /* 面板还没接入 PVE：给依赖它的入口挂个小圆点（清单见 PVE_NAV_PATHS） */
  const pveConfigured = usePveStatus().configured;
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
                          {/* 折叠态（64px）没有位置放它，也就不显示 */}
                          {!collapsed && !pveConfigured && PVE_NAV_PATHS.has(item.to) ? (
                            <span
                              className="nav-item-flag"
                              title={t('nav.pveNotConfigured')}
                              aria-hidden="true"
                            />
                          ) : null}
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
