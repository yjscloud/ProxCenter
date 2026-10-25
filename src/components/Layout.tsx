/* ==========================================================================
   ProxCenter — Layout 主布局
   ========================================================================== */

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Sidebar,
  canAccessNav,
  firstAvailableNavPath,
  isPathDisabled,
  navItemForPath,
} from './Sidebar';
import { Topbar } from './Topbar';
import { UpdateNotice } from './UpdateNotice';
import { MaintenanceNotice } from './MaintenanceNotice';
import { PveSetupNotice } from './PveSetupNotice';
import { SetupRedirect } from './SetupRedirect';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from './ui/Spinner';
import { useAuth } from '../hooks/useAuth';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { useTaskStream } from '../hooks/useWebSocket';
import type { PermissionKey } from '../api/permissions';
import { useT } from '../i18n';

const COLLAPSE_KEY = 'pve_sidebar_collapsed';
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1280;

export function Layout() {
  const t = useT();
  const location = useLocation();
  const { canWrite, user } = useAuth();
  const queryClient = useQueryClient();

  /* 面板级开关（见 app/ui.py）：由管理员在「设置 → 导航栏功能开关」里逐项
     关闭入口，对所有用户生效。导航栏本身始终渲染，关的是里面的功能入口。 */
  const navDisabled = useUiPrefs().nav_disabled;

  /* 当前页面该不该让这个人看。两个判据合起来：
      1. 面板级开关（管理员关掉的入口）；
      2. **角色权限** —— 与侧边栏的可见性用的是同一份 ``canAccessNav``。

     只判开关的话，自定义角色（比如只勾了虚拟机权限）手输 /storages 就进去了，
     然后在页面上吃一屏 403 —— 而侧边栏里它明明是藏起来的，等于两套规则。

     命中就弹回「第一个当前用户有权看、且还开着」的入口（见 fallbackPath）。 */
  const currentNav = navItemForPath(location.pathname);
  const pathBlocked =
    isPathDisabled(location.pathname, navDisabled) ||
    Boolean(currentNav && !canAccessNav(currentNav, user));
  const fallbackPath = firstAvailableNavPath(navDisabled, user);

  /* 侧边栏折叠状态 */
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  /* Ctrl/⌘ + K 打开命令面板。
     挂在捕获阶段：面板里到处都是输入框/下拉，冒泡阶段的事件很容易被它们
     自己的按键处理吃掉（尤其是输入框里的 ⌘K 组合）。 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);

  /* 全局任务 WS（连接一次，供各页面共享；当前仅用于保活与日志） */
  useTaskStream(Boolean(user));

  /* 持久化折叠状态 */
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }, [collapsed]);

  /* 响应式：根据视口宽度自动折叠 */
  useEffect(() => {
    const apply = () => {
      const w = window.innerWidth;
      if (w < MOBILE_BREAKPOINT) {
        setMobileOpen(false);
      } else if (w < TABLET_BREAKPOINT) {
        setCollapsed(true);
      }
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  /* 路由变化时关闭移动端抽屉 */
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  /* 顶栏「刷新全部数据」：直接失效所有查询（活跃的立刻重取，未挂载的标记过期）。
     原先这里收到事件后又转派了一个 `ProxCenter:invalidate-all`，而那个事件名
     **全仓没有任何监听者** —— 按钮实际只刷了 /health，页面数据纹丝不动。 */
  useEffect(() => {
    const handler = () => {
      void queryClient.invalidateQueries();
    };
    window.addEventListener('ProxCenter:refresh', handler);
    return () => window.removeEventListener('ProxCenter:refresh', handler);
  }, [queryClient]);

  /* 判断逻辑在 Sidebar.canAccessNav：命令面板也用同一份，避免两处不一致 */
  const canAccess = (item: { permission?: PermissionKey; adminOnly?: boolean }) =>
    canAccessNav(item, user);

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        canAccess={canAccess}
      />

      <div className="app-main">
        <Topbar
          onOpenMobileNav={() => setMobileOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
        />

        {/* 维护模式提示条：只对管理员出现。普通用户此时根本进不来后台，
            所以这条的作用是提醒管理员「你开了个影响所有人的开关」 */}
        <MaintenanceNotice />

        {/* 有面板新版本时的提示条（只对管理员出现，见组件内部判断） */}
        <UpdateNotice />

        {/* 还没接入 Proxmox 时的引导条。这一条比上面那条重要得多：没配连接时
            几乎每个业务页面都会报错，先在这里把「去添加」说清楚，用户就不会
            以为是平台坏了 —— 同样是按角色区分文案，见组件内部。 */}
        <PveSetupNotice />

        {/* 全新部署时把管理员直接带到初始化流程（连接管理页）。只引导一次，
            且只在确定没配置时才跳，详见组件内部的三条约束 */}
        <SetupRedirect />

        <main className="app-content" id="main-content">
          {pathBlocked ? (
            fallbackPath ? (
              <Navigate to={fallbackPath} replace />
            ) : (
              /* 一个还开着的页面都没有（管理员把所有入口都关了）：
                 不跳转，直接说明情况 —— 反复弹回会变成死循环。 */
              <div className="notfound">
                <div className="text-secondary">{t('shell.navAllClosed')}</div>
              </div>
            )
          ) : (
            <ErrorBoundary>
              {/* 页面是按需加载的（见 App.tsx 的 lazyPage）：这道边界只罩住
                  内容区 —— 切页时侧边栏与顶栏原地不动，不会整屏闪一下加载态。
                  chunk 取不下来（断网、发版后旧的 hash 被清掉）时抛出的错会落到
                  外面的 ErrorBoundary，用户看到的是重试提示而不是白屏。 */}
              <Suspense fallback={<PageLoading />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          )}
        </main>

        {!canWrite ? (
          <div className="readonly-bar" role="status">
            {t('shell.readonly')}
          </div>
        ) : null}
      </div>

      {/* 命令面板挂在 Layout 上：它的开关状态要同时被全局快捷键与顶栏按钮驱动 */}
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

/**
 * 按需加载页面的等待态。
 *
 * 只占内容区，不遮侧边栏与顶栏 —— 页面 chunk 一般只有几十 KB，正常网络下这点
 * 空白一闪而过；用全屏加载态反而会「整屏黑一下再回来」，比等它加载完更晃眼。
 */
function PageLoading() {
  const t = useT();
  return (
    <div className="page-loading" role="status" aria-label={t('shell.loadingPage')}>
      <Spinner size={24} label={t('shell.loadingPage')} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   页面容器（统一标题 + 操作区）
   --------------------------------------------------------------------------- */

export function PageShell({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 追加到 .page 上的类名：个别页面要单独调密度时用（如设置页） */
  className?: string;
}) {
  return (
    <div className={`page${className ? ` ${className}` : ''}`}>
      <div className="page-header">
        <div>
          <div className="page-title">{title}</div>
          {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
