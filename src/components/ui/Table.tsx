/* ==========================================================================
   ProxCenter — Table（斑马纹、排序、选择、空状态、列宽拖拽）
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TableSkeleton } from './Spinner';
import { EmptyState } from './EmptyState';

/** 拖拽列宽的下限，避免把列拖成看不见的一条缝 */
const MIN_COLUMN_WIDTH = 64;

export interface Column<T> {
  /** 列唯一 key */
  key: string;
  /** 表头 */
  header: ReactNode;
  /** 单元格渲染 */
  render: (row: T, index: number) => ReactNode;
  /** 列宽 */
  width?: number | string;
  /** 对齐 */
  align?: 'left' | 'center' | 'right';
  /** 是否显示为等宽字体 */
  mono?: boolean;
  /** 是否可排序 */
  sortable?: boolean;
  /** 排序取值函数（sortable 时使用）*/
  sortValue?: (row: T) => string | number;
  /** 表头补充说明 */
  title?: string;
  className?: string;
  /** 是否允许拖拽调整该列宽度（默认跟随表格的 resizable） */
  resizable?: boolean;
  /**
   * 列设置下拉里的显示名。表头是节点（如全选框）时菜单里念不出东西，
   * 必须显式给一个；其余情况缺省回落成 key。
   */
  label?: string;
  /**
   * 固定列：不可隐藏、也不参与拖动排序（选择框、操作列）。
   * 顺序由声明位置决定 —— 操作列被拖到中间会让人找不到「删除」。
   */
  locked?: boolean;
  /** 默认隐藏（用户仍可在列设置里打开）。宽度吃紧的次要列用它 */
  defaultHidden?: boolean;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface TableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  /** 行唯一 key */
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  /** 无障碍表格标题（sr-only）*/
  caption: string;
  /** 空状态 */
  emptyTitle?: string;
  /** 空状态说明：可以是 ReactNode，便于把操作路径（如 PVE 菜单、CLI 命令）写成代码样式 */
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  onRowClick?: (row: T) => void;
  /** 行是否高亮选中 */
  isRowSelected?: (row: T) => boolean;
  /** 紧凑模式 */
  dense?: boolean;
  /** 排序状态（受控）*/
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  className?: string;
  /** 行悬浮提示 */
  rowTitle?: (row: T) => string;
  /** 是否允许拖拽调整列宽（默认开启；双击把手可恢复该列默认宽度） */
  resizable?: boolean;
  /**
   * 表格上方右对齐的列工具条（放「列设置」齿轮）。
   *
   * 刻意渲染在 `.table-container` **之外**：容器要横向滚动，overflow 会把
   * 绝对定位的下拉面板一起裁掉。需要时也可以把这个节点放到页面工具栏里，
   * 面板放哪儿都行，渲染位置由调用方决定。
   */
  columnMenu?: ReactNode;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  caption,
  emptyTitle = '暂无数据',
  emptyDescription,
  emptyAction,
  onRowClick,
  isRowSelected,
  dense = false,
  sort,
  onSortChange,
  className,
  rowTitle,
  resizable = true,
  columnMenu,
}: TableProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null);

  /* 用户拖拽后的列宽（像素）。null = 还没拖过，沿用各列自带的 width，
     此时表格仍是常规自适应布局，不受影响。 */
  const [widths, setWidths] = useState<Record<string, number> | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(
    null,
  );

  /* 首次拖拽时把每一列的实际渲染宽度固化成像素值。
     table-layout: fixed 下未指定宽度的列会平分剩余空间，若不固化，
     拖动一列会让其它列跟着抖动；固化后每列各自独立。 */
  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>, col: Column<T>) => {
      const table = tableRef.current;
      if (!table) return;
      event.preventDefault();
      event.stopPropagation();

      const cells = Array.from(
        table.querySelectorAll<HTMLElement>('thead th'),
      );
      const base =
        widths ??
        Object.fromEntries(
          columns.map((c, i) => [
            c.key,
            cells[i]?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH,
          ]),
        );

      dragRef.current = {
        key: col.key,
        startX: event.clientX,
        startW: base[col.key] ?? MIN_COLUMN_WIDTH,
      };
      setWidths(base);
      setDraggingKey(col.key);
    },
    [columns, widths],
  );

  /* 拖拽期间监听全局指针移动：指针很容易滑出这个细窄的把手，
     挂在 window 上才不会中途丢失。 */
  useEffect(() => {
    if (!draggingKey) return;

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(
        MIN_COLUMN_WIDTH,
        drag.startW + (event.clientX - drag.startX),
      );
      setWidths((prev) => (prev ? { ...prev, [drag.key]: next } : prev));
    };
    const onUp = () => {
      dragRef.current = null;
      setDraggingKey(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    /* 拖拽时禁止选中文本，否则会拖出一片蓝色高亮 */
    document.body.classList.add('is-col-resizing');

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-col-resizing');
    };
  }, [draggingKey]);

  /* 双击把手：清掉这一列的覆盖宽度，恢复它原本的默认宽度 */
  const resetColumn = useCallback((key: string) => {
    setWidths((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const totalWidth = useMemo(
    () =>
      widths ? Object.values(widths).reduce((sum, w) => sum + w, 0) : undefined,
    [widths],
  );

  /* ---- 排序处理 ---- */
  let displayRows = rows;
  if (sort) {
    const col = columns.find((c) => c.key === sort.key);
    if (col?.sortValue) {
      const dir = sort.direction === 'asc' ? 1 : -1;
      displayRows = [...rows].sort((a, b) => {
        const va = col.sortValue!(a);
        const vb = col.sortValue!(b);
        if (typeof va === 'number' && typeof vb === 'number') {
          return (va - vb) * dir;
        }
        return String(va).localeCompare(String(vb), 'zh-CN') * dir;
      });
    }
  }

  const handleSortClick = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return;
    if (!sort || sort.key !== col.key) {
      onSortChange({ key: col.key, direction: 'asc' });
    } else if (sort.direction === 'asc') {
      onSortChange({ key: col.key, direction: 'desc' });
    } else {
      onSortChange(null);
    }
  };

  /* 列工具条在三种状态下都要在：加载中 / 空列表时也不能把齿轮弄丢，
     否则用户刚想调列就被藏了入口。 */
  const columnBar = columnMenu ? (
    <div className="table-colbar">{columnMenu}</div>
  ) : null;

  if (loading) {
    return (
      <>
        {columnBar}
        <div className={`table-container ${className ?? ''}`}>
          <TableSkeleton rows={6} cols={Math.min(columns.length, 7)} />
        </div>
      </>
    );
  }

  if (displayRows.length === 0) {
    return (
      <>
        {columnBar}
        <div className={`table-container table-container-empty ${className ?? ''}`}>
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {columnBar}
      <div className={`table-container ${className ?? ''}`}>
      <table
        ref={tableRef}
        className={`table ${dense ? 'table-dense' : ''} ${
          resizable ? 'table-resizable' : ''
        }`}
        /* 拖过列之后改用像素宽度，让各列严格等于用户设定的值；
           minWidth 保证窄表格仍能撑满容器 */
        style={totalWidth ? { width: totalWidth, minWidth: '100%' } : undefined}
      >
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = sort?.key === col.key;
              const canResize = resizable && col.resizable !== false;
              const active = draggingKey === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={`${col.align ? `ta-${col.align}` : ''} ${
                    col.sortable ? 'th-sortable' : ''
                  } ${isSorted ? 'is-sorted' : ''} ${col.className ?? ''}`}
                  style={{
                    ...(col.width ? { width: col.width } : {}),
                    ...(widths?.[col.key]
                      ? { width: `${widths[col.key]}px` }
                      : {}),
                  }}
                  title={col.title}
                  aria-sort={
                    isSorted
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className="th-sort-btn"
                      onClick={() => handleSortClick(col)}
                    >
                      <span>{col.header}</span>
                      <span className="th-sort-icon" aria-hidden="true">
                        {isSorted ? (
                          sort.direction === 'asc' ? (
                            <svg viewBox="0 0 24 24" width="12" height="12">
                              <path
                                d="m6 15 6-6 6 6"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="12" height="12">
                              <path
                                d="m6 9 6 6 6-6"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )
                        ) : (
                          <svg viewBox="0 0 24 24" width="12" height="12" opacity="0.35">
                            <path
                              d="m8 10 4-4 4 4M8 14l4 4 4-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                  {canResize ? (
                    <span
                      className={`th-resizer ${active ? 'is-active' : ''}`}
                      onPointerDown={(e) => beginResize(e, col)}
                      onDoubleClick={() => resetColumn(col.key)}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="拖拽调整列宽，双击恢复默认"
                      title="拖拽调整列宽（双击恢复默认）"
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, index) => {
            const selected = isRowSelected?.(row) ?? false;
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={rowKey(row, index)}
                className={`${selected ? 'is-selected' : ''} ${
                  clickable ? 'is-clickable' : ''
                }`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onRowClick?.(row);
                        }
                      }
                    : undefined
                }
                title={rowTitle?.(row)}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`${col.align ? `ta-${col.align}` : ''} ${
                      col.mono ? 'mono' : ''
                    } ${col.className ?? ''}`}
                  >
                    {col.render(row, index)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

/* ---------------------------------------------------------------------------
   分页
   --------------------------------------------------------------------------- */

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /**
   * 可选：每页条数的候选值。给了就在左侧多出一个「每页 N 条」下拉，
   * 并与 `onPageSizeChange` 成对使用。
   *
   * 注意它还会改变「只有一页时是否显示」的判定 —— 见下面 showBar 的注释。
   */
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  /** 可选：在右侧加一个「跳至 _ 页」输入框（长列表翻到中间某页时用） */
  jump?: boolean;
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  pageSizeOptions,
  onPageSizeChange,
  jump = false,
}: PaginationProps) {
  const [jumpValue, setJumpValue] = useState('');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /* 带「每页条数」时必须一直显示：否则把每页调大之后只剩一页，整条分页栏
     连同那个下拉一起消失，用户就再也改不回去了。 */
  const showBar = Boolean(pageSizeOptions?.length && onPageSizeChange) || totalPages > 1;
  if (!showBar) return null;

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const gotoJump = () => {
    const raw = jumpValue.trim();
    if (!raw) return;
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(Math.min(totalPages, Math.max(1, Math.trunc(next))));
    setJumpValue('');
  };

  return (
    <nav className="pagination" aria-label="分页导航">
      <div className="pagination-left">
        {pageSizeOptions?.length && onPageSizeChange ? (
          <label className="pagination-size">
            每页
            <select
              className="pagination-size-select"
              value={String(pageSize)}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={String(size)}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="pagination-info">
          第 {start}-{end} 条，共 {total} 条
        </span>
      </div>

      <div className="pagination-controls">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
        >
          上一页
        </button>
        <span className="pagination-page mono">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
        >
          下一页
        </button>

        {jump && totalPages > 1 ? (
          <span className="pagination-jump">
            跳至
            <input
              type="number"
              className="pagination-jump-input"
              min={1}
              max={totalPages}
              value={jumpValue}
              placeholder={String(page)}
              onChange={(event) => setJumpValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') gotoJump();
              }}
              onBlur={gotoJump}
              aria-label={`跳至页码，共 ${totalPages} 页`}
            />
            页
          </span>
        ) : null}
      </div>
    </nav>
  );
}
