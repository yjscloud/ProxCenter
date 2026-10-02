/* ==========================================================================
   ProxCenter — Topbar 顶部栏
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { healthApi } from '../api/endpoints';
import { useAuth } from '../hooks/useAuth';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { isPathDisabled } from './Sidebar';
import { Badge } from './ui/Badge';
import { IconButton } from './ui/Button';
import {
  IconChevronDown,
  IconLogout,
  IconMenu,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconUser,
  IconUsers,
} from './Icons';
import { NotificationBell } from './NotificationBell';
import { ConsoleStatus } from './ConsoleStatus';
import { roleMeta } from '../utils/status';
import { useI18n, useT } from '../i18n';
import { LanguageSelect } from './LanguageSelect';

/** 命令面板的快捷键提示：Mac 上是 ⌘K，其它平台是 Ctrl K */
const SHORTCUT =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? '⌘K'
    : 'Ctrl K';

export interface TopbarProps {
  /** 打开移动端导航抽屉（窄屏时导航栏收进抽屉里） */
  onOpenMobileNav: () => void;
  /** 打开命令面板（全局搜索） */
  onOpenSearch?: () => void;
  /** 页面标题（面包屑）*/
  title?: string;
}

export function Topbar({ onOpenMobileNav, onOpenSearch, title }: TopbarProps) {
  const { user, logout, isAdmin } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  /* 这个菜单是个人中心 / 系统设置 / 用户管理的第二个入口。
     被面板级开关关闭的入口这里也要跟着消失 —— 否则「侧边栏里关掉了，
     头像菜单里还点得进去」，两套规则并存。 */
  const disabledPaths = useUiPrefs().nav_disabled;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 健康状态轮询 */
  const health = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    refetchInterval: 30_000,
    retry: false,
  });

  /* 点击外部关闭菜单 */
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen]);

  const role = roleMeta(user?.role, t);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <IconButton
          label={t('topbar.openNav')}
          className="topbar-hamburger"
          onClick={onOpenMobileNav}
        >
          <IconMenu size={18} />
        </IconButton>
        {title ? <h1 className="topbar-title">{title}</h1> : null}
      </div>

      <div className="topbar-right">
        {/* 后端 / PVE 状态收敛成一个「控制台状态」入口：常态一个状态点，
            点开才看明细。顶栏只有这么大，不能给常驻徽章越堆越多 */}
        <ConsoleStatus />

        {/* 全局搜索入口：快捷键之外也给一个看得见的按钮，否则没人知道有这功能 */}
        {onOpenSearch ? (
          <button
            type="button"
            className="topbar-search"
            onClick={onOpenSearch}
            aria-label={t('topbar.searchAria')}
            title={t('topbar.searchTitle')}
          >
            <IconSearch size={15} />
            <span className="topbar-search-text">{t('topbar.searchPlaceholder')}</span>
            <kbd className="cmd-kbd">{SHORTCUT}</kbd>
          </button>
        ) : null}

        <NotificationBell />

        {/* 手动刷新全局 query */}
        <IconButton
          label={t('topbar.refreshAll')}
          onClick={() => {
            void health.refetch();
            window.dispatchEvent(new CustomEvent('ProxCenter:refresh'));
          }}
        >
          <IconRefresh size={16} />
        </IconButton>

        {/* 语言切换：常驻顶栏。收进头像菜单里等于没有 —— 用户找不到就不会用 */}
        <LanguageSelect variant="topbar" />

        {/* 用户菜单 */}
        <div className="user-menu" ref={menuRef}>
          <button
            type="button"
            className="user-trigger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <span className="user-avatar" aria-hidden="true">
              {(user?.username ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="user-meta">
              <span className="user-name">{user?.username ?? t('topbar.notLoggedIn')}</span>
              <span className="user-role">{role.label}</span>
            </span>
            <IconChevronDown size={14} />
          </button>

          {menuOpen ? (
            <div className="user-dropdown" role="menu">
              <div className="user-dropdown-header">
                <span className="user-dropdown-name">{user?.username}</span>
                <Badge variant={role.variant} size="sm">
                  {role.label}
                </Badge>
              </div>
              <div className="user-dropdown-divider" />
              {/* 所有用户可用：改邮箱与密码。入口被关闭时整项不出现 */}
              {isPathDisabled('/profile', disabledPaths) ? null : (
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown-item"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/profile');
                  }}
                >
                  <IconUser size={15} />
                  <span>{t('topbar.profile')}</span>
                </button>
              )}
              {/* 「系统管理」下的页面仅管理员可见，普通用户菜单里不出现 */}
              {isAdmin ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/settings');
                    }}
                  >
                    <IconSettings size={15} />
                    <span>{t('topbar.settings')}</span>
                  </button>
                  {/* 用户管理：入口被关掉时这里也不出现 */}
                  {isPathDisabled('/users', disabledPaths) ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      className="dropdown-item"
                      onClick={() => {
                        setMenuOpen(false);
                        navigate('/users');
                      }}
                    >
                      <IconUsers size={15} />
                      <span>{t('topbar.users')}</span>
                    </button>
                  )}
                </>
              ) : null}
              <div className="user-dropdown-divider" />
              <button
                type="button"
                role="menuitem"
                className="dropdown-item dropdown-item-danger"
                onClick={() => {
                  setMenuOpen(false);
                  void logout().then(() => navigate('/login'));
                }}
              >
                <IconLogout size={15} />
                <span>{t('topbar.logout')}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------------------
   面包屑
   --------------------------------------------------------------------------- */

export function Breadcrumb({
  items,
}: {
  items: Array<{ label: string; to?: string }>;
}) {
  const t = useT();
  return (
    <nav className="breadcrumb" aria-label={t('breadcrumb.aria')}>
      {items.map((item, i) => (
        <span className="breadcrumb-item" key={`${item.label}-${i}`}>
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span>{item.label}</span>}
          {i < items.length - 1 ? (
            <span className="breadcrumb-sep" aria-hidden="true">
              /
            </span>
          ) : null}
        </span>
      ))}
    </nav>
  );
}
