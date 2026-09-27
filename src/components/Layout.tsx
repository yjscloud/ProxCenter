/* ==========================================================================
   ProxCenter — Layout 主布局
   ========================================================================== */

import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar, canAccessNav } from './Sidebar';
import { Topbar } from './Topbar';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { useAuth } from '../hooks/useAuth';
import { useTaskStream } from '../hooks/useWebSocket';

const COLLAPSE_KEY = 'pve_sidebar_collapsed';
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1280;

export function Layout() {
  const location = useLocation();
  const { canWrite, user } = useAuth();

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

        <main className="app-content" id="main-content">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>

        {!canWrite ? (
          <div className="readonly-bar" role="status">
            当前为只读模式（viewer 角色），修改类操作已禁用
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
