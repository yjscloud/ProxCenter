/* ==========================================================================
   ProxCenter — 表格列设置（显隐 + 排序 + 按账号持久化）
   ==========================================================================

   长表格的痛点不是「列太多」，而是「每个人的关键列不一样」：运维盯 IP 与负载，
   值班盯状态与标签。与其争论默认列，不如让每台浏览器自己记一份。

   为什么存 localStorage 而不是走后端 prefs：
     * 这是纯粹的呈现偏好，丢了最多是「列回到默认」，没有数据价值；
     * 每点一次勾选都要等一个 PUT 才能生效，体验反而不如即时；
     * 按账号加前缀即可完成隔离（同一台机器换人登录互不影响）。

   用法：
     const cols = useColumnSettings(columns, 'vms');
     <Table columns={cols.columns} columnMenu={cols.menu} ... />

   `columnMenu` 交给 Table 渲染在表格上方右对齐的位置；也可以自己放进页面的
   工具栏（放哪儿都行，面板在容器外，不会被表格的横向滚动裁掉）。
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../../hooks/useAuth';
import { Checkbox } from './Input';
import { IconGrip, IconLock, IconRefresh, IconSettings } from '../Icons';
import type { Column } from './Table';
import { useT } from '../../i18n';

/** localStorage 键前缀。按账号隔离：key = 前缀 + 用户名 + 表名 */
const STORAGE_PREFIX = 'pve_table_columns:';

interface ColumnSettingsState {
  /** 用户拖动后的列顺序（可能缺少新加的列，读取时会补齐） */
  order: string[];
  /** 被隐藏的列 */
  hidden: string[];
}

function storageKeyOf(username: string | undefined, tableKey: string): string {
  return `${STORAGE_PREFIX}${username || 'anonymous'}:${tableKey}`;
}

/** 读偏好。没存过返回 null —— 与「存了一份空配置」必须能区分开，
    否则「恢复默认」会被刚写下的空配置覆盖掉，默认隐藏列再也回不来。 */
function readStored(key: string): ColumnSettingsState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ColumnSettingsState>;
    return {
      order: Array.isArray(parsed.order)
        ? parsed.order.filter((k): k is string => typeof k === 'string')
        : [],
      hidden: Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((k): k is string => typeof k === 'string')
        : [],
    };
  } catch {
    /* 隐私模式 / 脏数据：静默回到默认列，不影响使用 */
    return null;
  }
}

/** 首次进入（或恢复默认）时的列配置：只把声明为 defaultHidden 的列藏起来 */
function defaultState<T>(columns: Array<Column<T>>): ColumnSettingsState {
  return {
    order: [],
    hidden: columns.filter((c) => c.defaultHidden).map((c) => c.key),
  };
}

/**
 * 菜单里的列名：显式 label > 纯文本表头 > key。
 *
 * 直接复用表头可以省掉每个调用点再写一遍「名称」，代价只是全选框这种
 * ReactNode 表头必须自己补一个 label —— 少数派，值得。
 */
function columnLabel<T>(column: Column<T>): string {
  if (column.label) return column.label;
  if (typeof column.header === 'string') return column.header;
  return column.key;
}

function writeStored(key: string, state: ColumnSettingsState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* 同上：写不进去也不该让页面报错 */
  }
}

/* ---------------------------------------------------------------------------
   Hook
   --------------------------------------------------------------------------- */

export interface ColumnSettingsApi<T> {
  /** 过滤掉隐藏列、并按用户顺序排好的列，直接传给 <Table columns={...}> */
  columns: Array<Column<T>>;
  /** 齿轮下拉，交给 Table 的 columnMenu 或页面工具栏 */
  menu: ReactNode;
  /** 被隐藏的列数（>0 时齿轮上带角标，提示「你现在看的不是全部列」） */
  hiddenCount: number;
  /** 恢复默认列（清掉这份偏好） */
  reset: () => void;
}

export function useColumnSettings<T>(
  columns: Array<Column<T>>,
  tableKey: string,
): ColumnSettingsApi<T> {
  const { user } = useAuth();
  const storageKey = storageKeyOf(user?.username, tableKey);

  const [state, setState] = useState<ColumnSettingsState>(
    () => readStored(storageKey) ?? defaultState(columns),
  );

  /* 同一浏览器换账号登录时，读回新账号自己的那份偏好 */
  useEffect(() => {
    setState(readStored(storageKey) ?? defaultState(columns));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  /* 列是「声明式」的：权限变化、功能开关都可能让某一列消失。
     页面每次渲染都会生成新的 columns 数组，直接拿它当依赖会一直重算，
     所以先把 key 拼成一个签名字符串：只有列真的变了签名才变。 */
  const signature = columns.map((c) => c.key).join('|');
  const declaredKeys = useMemo(
    () => (signature ? signature.split('|') : []),
    [signature],
  );

  /* 对账：存下来的顺序里剔掉已经不复存在的列，再按声明顺序补上新出现的列。
     老用户读到旧配置后，新加的列能自动出现在末尾（而不是永远看不见）。 */
  const order = useMemo(() => {
    const known = new Set(declaredKeys);
    const result = state.order.filter((k) => known.has(k));
    for (const key of declaredKeys) {
      if (!result.includes(key)) result.push(key);
    }
    return result;
  }, [state.order, declaredKeys]);

  const hiddenSet = useMemo(
    () => new Set(state.hidden.filter((k) => declaredKeys.includes(k))),
    [state.hidden, declaredKeys],
  );

  const byKey = useMemo(
    () => new Map(columns.map((c) => [c.key, c])),
    [columns],
  );

  const commit = useCallback(
    (next: ColumnSettingsState) => {
      setState(next);
      writeStored(storageKey, next);
    },
    [storageKey],
  );

  const toggle = useCallback(
    (key: string, visible: boolean) => {
      const next = visible
        ? state.hidden.filter((k) => k !== key)
        : [...new Set([...state.hidden, key])];
      commit({ ...state, hidden: next });
    },
    [commit, state],
  );

  /* 拖动排序：只影响非锁定列，锁定列由下面的合并逻辑钉回声明位置 */
  const move = useCallback(
    (from: string, to: string) => {
      if (from === to) return;
      if (byKey.get(from)?.locked || byKey.get(to)?.locked) return;
      const next = [...order];
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, from);
      commit({ ...state, order: next });
    },
    [byKey, commit, order, state],
  );

  /* 恢复默认：清掉隐藏项与顺序，只保留声明为 defaultHidden 的列。
     依赖用签名而不是 columns 本身，避免每次渲染都换一个新回调。 */
  const reset = useCallback(() => {
    commit({
      order: [],
      hidden: declaredKeys.filter((key) => byKey.get(key)?.defaultHidden),
    });
  }, [commit, declaredKeys, byKey]);

  /* 可见列：先按用户顺序取可见的非锁定列，再按声明顺序把锁定列钉回原位
     （选择框必须始终在第一列、操作列必须在最后一列，不能跟着拖动跑）。 */
  const visibleColumns = useMemo(() => {
    const queue = order.filter(
      (key) => !byKey.get(key)?.locked && !hiddenSet.has(key),
    );
    const result: Array<Column<T>> = [];
    for (const key of declaredKeys) {
      const column = byKey.get(key);
      if (!column) continue;
      if (column.locked) {
        result.push(column);
        continue;
      }
      const nextKey = queue.shift();
      if (nextKey) result.push(byKey.get(nextKey) as Column<T>);
    }
    return result;
  }, [order, byKey, hiddenSet, declaredKeys]);

  const hiddenCount = declaredKeys.length - visibleColumns.length;

  const menu = (
    <ColumnSettingsMenu
      columns={columns}
      order={order}
      visibleColumns={visibleColumns}
      onToggle={toggle}
      onMove={move}
      onReset={reset}
    />
  );

  return { columns: visibleColumns, menu, hiddenCount, reset };
}

/* ---------------------------------------------------------------------------
   齿轮下拉
   --------------------------------------------------------------------------- */

interface ColumnSettingsMenuProps<T> {
  /** 全量列（含被隐藏的），用于渲染清单 */
  columns: Array<Column<T>>;
  /** 对账后的完整顺序 */
  order: string[];
  visibleColumns: Array<Column<T>>;
  onToggle: (key: string, visible: boolean) => void;
  onMove: (from: string, to: string) => void;
  onReset: () => void;
}

function ColumnSettingsMenu<T>({
  columns,
  order,
  visibleColumns,
  onToggle,
  onMove,
  onReset,
}: ColumnSettingsMenuProps<T>) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* 点击面板外 / Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const byKey = useMemo(
    () => new Map(columns.map((c) => [c.key, c])),
    [columns],
  );

  const orderedAll = useMemo(
    () => order.map((key) => byKey.get(key)).filter(Boolean) as Array<
      Column<T>
    >,
    [order, byKey],
  );

  /* 只剩最后一列可见时不让取消勾选：全隐藏会得到一个空表头，
     用户只会以为表格坏了。 */
  const visibleKeys = useMemo(
    () => new Set(visibleColumns.map((c) => c.key)),
    [visibleColumns],
  );
  const visibleToggleableCount = visibleColumns.filter((c) => !c.locked).length;

  const hiddenCount = columns.length - visibleColumns.length;

  return (
    <div className="colset" ref={rootRef}>
      <button
        type="button"
        className="btn btn-secondary btn-sm colset-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('columnSettings.triggerTitle')}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="btn-icon">
          <IconSettings size={15} />
        </span>
        <span className="btn-label">{t('columnSettings.label')}</span>
        {hiddenCount > 0 ? (
          <span className="colset-badge">{hiddenCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="colset-panel" role="dialog" aria-label={t('columnSettings.panelAria')}>
          <div className="colset-head">
            <span className="colset-title">{t('columnSettings.visibleColumns')}</span>
            <span className="colset-hint">{t('columnSettings.dragHint')}</span>
          </div>

          <div className="colset-list">
            {orderedAll.map((column) => {
              const visible = visibleKeys.has(column.key);
              const lastVisible =
                visible && !column.locked && visibleToggleableCount <= 1;
              return (
                <div
                  key={column.key}
                  className={`colset-item ${
                    column.locked ? 'is-locked' : ''
                  } ${dragKey === column.key ? 'is-dragging' : ''}`}
                  draggable={!column.locked}
                  onDragStart={(event) => {
                    if (column.locked) return;
                    event.dataTransfer.effectAllowed = 'move';
                    // 必须写入数据，否则 Firefox 不认为这是一次合法拖拽
                    event.dataTransfer.setData('text/plain', column.key);
                    setDragKey(column.key);
                  }}
                  onDragOver={(event) => {
                    if (column.locked) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDragEnter={() => {
                    if (dragKey) onMove(dragKey, column.key);
                  }}
                  onDragEnd={() => setDragKey(null)}
                >
                  <span className="colset-grip" aria-hidden="true">
                    {column.locked ? (
                      <IconLock size={12} />
                    ) : (
                      <IconGrip size={13} />
                    )}
                  </span>
                  <Checkbox
                    checked={visible}
                    disabled={Boolean(column.locked) || lastVisible}
                    onChange={(event) =>
                      onToggle(column.key, event.target.checked)
                    }
                    label={columnLabel(column)}
                  />
                  {column.locked ? (
                    <span className="colset-fixed">{t('columnSettings.fixed')}</span>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="colset-foot">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onReset}
            >
              <span className="btn-icon">
                <IconRefresh size={13} />
              </span>
              <span className="btn-label">{t('columnSettings.reset')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
