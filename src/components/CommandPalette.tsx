/* ==========================================================================
   ProxCenter — 命令面板（Ctrl / ⌘ + K）
   ==========================================================================

   面板有 30 多个页面，虚拟机、节点、存储、用户分属四套列表接口。要在它们之间
   跳转，得先想清楚「这台机器在哪个页面上」—— 命令面板把「找东西」收敛成一个
   输入框。

   两类结果，两个来源：
   * **页面**：直接在本地按侧边栏的导航表匹配（含权限过滤），零延迟，且不依赖
     后端；空关键词时它就是一份「去哪」的清单。
   * **资源**：走后端 /api/search（已按归属与权限隔离），200ms 防抖。

   键盘：↑↓ 选择、Enter 打开、Esc 关闭。鼠标与键盘共用同一个 activeIndex，
   所以光标停在哪、回车就开哪，不会出现「看着 A 打开 B」。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { searchApi } from '../api/endpoints';
import { NAV_SECTIONS, canAccessNav, type NavItem } from './Sidebar';
import { useAuth } from '../hooks/useAuth';
import { IconSearch, IconChevronRight } from './Icons';

/** 输入停顿多久才去搜后端。太短会把每个字符都发一趟请求。 */
const DEBOUNCE_MS = 200;

/** 侧边栏里没有、但值得能被搜到的页面（子页面 / 隐藏入口） */
const EXTRA_PAGES: NavItem[] = [
  { to: '/ssh-security/config', label: 'SSH 安全 · 配置', icon: null },
  { to: '/nodes/connections', label: '节点 · 连接配置', icon: null },
  /* 个人中心已从侧边栏分组下沉到侧边栏底部，不再是 NAV_SECTIONS 的一项，
     所以这里要显式补回来 —— 否则 Ctrl+K 会搜不到它。 */
  { to: '/profile', label: '个人中心', icon: null },
];

interface Row {
  key: string;
  /** 分组标题，用于渲染分隔行 */
  group: string;
  title: string;
  subtitle: string;
  badge: string;
  link: string;
  icon?: ReactNode;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* 打开时清空并聚焦；关闭时把状态收干净，下次打开是全新的 */
  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebounced('');
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  /* 防抖：只在输入停下来之后才打后端 */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const searchQuery = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => searchApi.query(debounced),
    enabled: open && debounced.length > 0,
    staleTime: 15_000,
    retry: false,
  });

  /* ---- 本地页面项 ---- */
  const pages = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = [...NAV_SECTIONS.flatMap((s) => s.items), ...EXTRA_PAGES].filter(
      (item) => canAccessNav(item, user),
    );
    return items.filter((item) => !q || item.label.toLowerCase().includes(q));
  }, [query, user]);

  /* ---- 合并成一个扁平列表，供键盘上下移动 ---- */
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = pages.map((item) => ({
      key: `page:${item.to}`,
      group: '页面',
      title: item.label,
      subtitle: item.to,
      badge: '',
      link: item.to,
      icon: item.icon,
    }));

    for (const group of searchQuery.data?.groups ?? []) {
      for (const item of group.items) {
        result.push({
          key: item.key,
          group: group.label,
          title: item.title,
          subtitle: item.subtitle,
          badge: item.badge,
          link: item.link,
        });
      }
    }
    return result;
  }, [pages, searchQuery.data]);

  /* 结果变了就把光标收回第一项：否则会停在一个已经不存在的位置上 */
  useEffect(() => {
    setActiveIndex(0);
  }, [debounced, query]);

  /* 键盘选中项滚动进视野 */
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const node = container.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows.length]);

  const go = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    navigate(row.link);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(rows[activeIndex]);
    }
  };

  if (!open) return null;

  const searching = debounced.length > 0 && searchQuery.isFetching;
  const total = searchQuery.data?.total ?? 0;

  return createPortal(
    <div className="cmd-layer" role="presentation">
      <div className="cmd-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="cmd-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        onKeyDown={onKeyDown}
      >
        <div className="cmd-input-row">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            className="cmd-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索页面、虚拟机、容器、节点、存储、用户…"
            aria-label="搜索"
            autoComplete="off"
            spellCheck={false}
          />
          {searching ? <span className="cmd-hint">搜索中…</span> : null}
          <kbd className="cmd-kbd">Esc</kbd>
        </div>

        <div className="cmd-list" ref={listRef}>
          {rows.length === 0 ? (
            <div className="cmd-empty">
              {debounced && searchQuery.isLoading
                ? '正在搜索…'
                : debounced
                  ? `没有匹配「${debounced}」的结果`
                  : '输入关键词开始搜索'}
            </div>
          ) : (
            rows.map((row, index) => {
              const previous = rows[index - 1];
              const showHeader = !previous || previous.group !== row.group;
              return (
                <div key={row.key}>
                  {showHeader ? (
                    <div className="cmd-group">{row.group}</div>
                  ) : null}
                  <button
                    type="button"
                    data-index={index}
                    className={`cmd-item${index === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => go(row)}
                  >
                    {row.icon ? (
                      <span className="cmd-item-icon" aria-hidden="true">
                        {row.icon}
                      </span>
                    ) : null}
                    <span className="cmd-item-main">
                      <span className="cmd-item-title">{row.title}</span>
                      {row.subtitle ? (
                        <span className="cmd-item-subtitle">{row.subtitle}</span>
                      ) : null}
                    </span>
                    {row.badge ? (
                      <span className="cmd-item-badge">{row.badge}</span>
                    ) : null}
                    <IconChevronRight size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="cmd-footer">
          <span>
            <kbd className="cmd-kbd">↑</kbd>
            <kbd className="cmd-kbd">↓</kbd> 选择
          </span>
          <span>
            <kbd className="cmd-kbd">Enter</kbd> 打开
          </span>
          {debounced ? (
            <span className="cmd-footer-count">
              命中 {total} 项{total > rows.length ? '，仅显示前几项' : ''}
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
