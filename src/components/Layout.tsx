/* ==========================================================================
   ProxCenter — Layout 主布局
   ========================================================================== */

import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import {
  Sidebar,
  canAccessNav,
  firstAvailableNavPath,
  isPathDisabled,
} from './Sidebar';
import { Topbar } from './Topbar';
import { UpdateNotice } from './UpdateNotice';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { useAuth } from '../hooks/useAuth';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { useTaskStream } from '../hooks/useWebSocket';
import { useT } from '../i18n';

const COLLAPSE_KEY = 'pve_sidebar_collapsed';
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1280;

export function Layout() {
  const t = useT();
  const location = useLocation();
  const { canWrite, user } = useAuth();

  /* 面板级开关（见 app/ui.py）：由管理员在「设置 → 导航栏功能开关」里逐项
     关闭入口，对所有用户生效。导航栏本身始终渲染，关的是里面的功能入口。 */
  const navDisabled = useUiPrefs().nav_disabled;

  /* 当前所在的页面是不是已被关闭的入口。是的话不渲染它，弹回一个还开着的
     页面 —— 与导航栏「看不见的项就是进不去」保持一致，避免出现「导航栏里
     没有，手输 URL 却进得去」的两套规则。 */
  const pathBlocked = isPathDisabled(location.pathname, navDisabled);
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

  /* 全局刷新事件 → 触发所有 react-query 重取（由各页面监听） */
  useEffect(() => {
    const handler = () => {
      window.dispatchEvent(new CustomEvent('ProxCenter:invalidate-all'));
    };
    const onTopbarRefresh = () => handler();
    window.addEventListener('ProxCenter:refresh', onTopbarRefresh);
    return () => window.removeEventListener('ProxCenter:refresh', onTopbarRefresh);
  }, []);

  /* 判断逻辑在 Sidebar.canAccessNav：命令面板也用同一份，避免两处不一致 */
  const canAccess = (item: { permission?: string; adminOnly?: boolean }) =>
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

        {/* 有面板新版本时的提示条（只对管理员出现，见组件内部判断） */}
        <UpdateNotice />

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
              <Outlet />
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

/* ---------------------------------------------------------------------------
   页面容器（统一标题 + 操作区）
   --------------------------------------------------------------------------- */

export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
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
