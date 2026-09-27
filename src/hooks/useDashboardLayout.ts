/* ==========================================================================
   ProxCenter — 仪表盘布局
   ==========================================================================

   管三件事：**哪些卡片、按什么顺序、哪些被隐藏**，并把结果按用户存到服务端
   （`/api/prefs`，见 backend/app/prefs.py）。换浏览器、换设备都跟着走。

   为什么要「对账」而不是直接信服务端返回的布局
   -------------------------------------------
   服务端只校验结构，不校验 widget id 合法性 —— 哪些 id 存在是前端注册表的
   知识，后端再维护一份清单就会变成「新增一张卡片要改两个地方」。所以这里在
   读到布局后拿自己的注册表做一次 reconcile：

     * 布局里有、注册表里没有 → 丢弃（这张卡片被下线了）
     * 注册表里有、布局里没有 → 追加到末尾（新卡片要能被看见）

   于是「加一张新卡片」只需要改注册表，老用户不用手动恢复默认布局也能看到它。
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prefsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import type { DashboardLayout } from '../api/types';
import { useToast } from './useToast';

/** 布局偏好在服务端的键名，必须与后端 prefs.ALLOWED_KEYS 一致。 */
export const DASHBOARD_LAYOUT_KEY = 'dashboard_layout';

/** 一张卡片的静态描述（顺序即默认布局的顺序）。 */
export interface WidgetMeta {
  id: string;
  name: string;
  /** half = 两张并排一行；full = 独占一行 */
  span: 'half' | 'full';
}

function idsOf(widgets: WidgetMeta[]): string[] {
  return widgets.map((w) => w.id);
}

function defaultLayout(widgets: WidgetMeta[]): DashboardLayout {
  return { order: idsOf(widgets), hidden: [] };
}

/**
 * 拿注册表对账一份外部布局（见文件头说明）。
 */
export function reconcileLayout(saved: unknown, widgets: WidgetMeta[]): DashboardLayout {
  const known = new Set(idsOf(widgets));
  const raw = (saved ?? {}) as Partial<DashboardLayout>;

  const order: string[] = [];
  for (const id of Array.isArray(raw.order) ? raw.order : []) {
    if (typeof id === 'string' && known.has(id) && !order.includes(id)) order.push(id);
  }
  for (const widget of widgets) {
    if (!order.includes(widget.id)) order.push(widget.id);
  }

  const hidden: string[] = [];
  for (const id of Array.isArray(raw.hidden) ? raw.hidden : []) {
    if (known.has(id) && !hidden.includes(id)) hidden.push(id);
  }

  return { order, hidden };
}

/**
 * 把可见 widget 按顺序打包成「行」：相邻的两个 half 并成一行，
 * full 独占一行。
 *
 * 这样默认布局（原本就是「节点 + 资源分布」并排两列）看起来与改造前完全一致，
 * 而拖动之后也不会出现「半宽卡片孤零零占一整行」的空白。
 */
export function packRows(
  order: string[],
  widgets: WidgetMeta[],
): WidgetMeta[][] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const rows: WidgetMeta[][] = [];
  let pending: WidgetMeta[] = [];

  for (const id of order) {
    const widget = byId.get(id);
    if (!widget) continue;
    if (widget.span === 'half') {
      pending.push(widget);
      if (pending.length === 2) {
        rows.push(pending);
        pending = [];
      }
      continue;
    }
    if (pending.length) {
      rows.push(pending);
      pending = [];
    }
    rows.push([widget]);
  }
  if (pending.length) rows.push(pending);
  return rows;
}

export interface DashboardLayoutApi {
  /** 已按注册表对账过的布局 */
  layout: DashboardLayout;
  /** 可见 widget 的顺序 */
  visibleOrder: string[];
  hiddenWidgets: WidgetMeta[];
  /** 是否与默认布局完全一致 */
  isDefault: boolean;
  /** 从服务端读到布局之前为 true（此时先渲染默认布局，不做闪烁） */
  loading: boolean;
  /** 把 from 位置的 widget 挪到 to 位置（拖动经过时实时调用） */
  move: (from: string, to: string) => void;
  setHidden: (id: string, hidden: boolean) => void;
  reset: () => Promise<void>;
}

export function useDashboardLayout(widgets: WidgetMeta[]): DashboardLayoutApi {
  const toast = useToast();
  const [layout, setLayout] = useState<DashboardLayout>(() => defaultLayout(widgets));
  const [loading, setLoading] = useState(true);

  /* 用 ref 存最新的布局，供「变更后立即写回」使用：直接读 state 会拿到
     本次渲染的旧值（setState 是异步的）。 */
  const latest = useRef(layout);

  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  /* 拉取已保存的布局。失败就用默认布局 —— 读不到偏好不该让仪表盘打不开。 */
  useEffect(() => {
    let alive = true;
    prefsApi
      .list()
      .then((payload) => {
        if (!alive) return;
        const next = reconcileLayout(payload.prefs?.[DASHBOARD_LAYOUT_KEY], widgets);
        latest.current = next;
        setLayout(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // widgets 是注册表常量，实际只在模块加载时确定一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 落库。拖动/隐藏都是即时保存 —— 布局没有「编辑到一半」的语义。 */
  const persist = useCallback(
    async (next: DashboardLayout) => {
      latest.current = next;
      setLayout(next);
      try {
        await prefsApi.save(DASHBOARD_LAYOUT_KEY, next);
      } catch (err) {
        toast.error('布局未能保存', errorMessage(err));
      }
    },
    [toast],
  );

  /**
   * 交换两块的位置（拖动经过目标时实时调用）。
   *
   * 用**交换**而不是「插入到目标之前」：拖动时指针会持续停在目标区域上，
   * 插入语义在「A 紧挨着 B 之前」的情况下算出来还是原顺序（等于拖不动），
   * 而交换语义一次就能看到变化。更重要的是交换后指针落回被拖的那块自己
   * 身上（`from === to` → 空操作），不会出现两块来回换的抖动。
   */
  const move = useCallback(
    (from: string, to: string) => {
      if (from === to) return;
      const current = latest.current;
      const order = [...current.order];
      const fromIndex = order.indexOf(from);
      const toIndex = order.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return;

      order[fromIndex] = to;
      order[toIndex] = from;
      void persist({ ...current, order });
    },
    [persist],
  );

  const setHidden = useCallback(
    (id: string, hidden: boolean) => {
      const current = latest.current;
      const next = hidden
        ? current.hidden.includes(id)
          ? current.hidden
          : [...current.hidden, id]
        : current.hidden.filter((item) => item !== id);
      if (next === current.hidden) return;
      void persist({ ...current, hidden: next });
    },
    [persist],
  );

  const reset = useCallback(async () => {
    try {
      // 删掉记录而不是写一份默认值：这样将来默认布局改了，恢复过默认的
      // 用户会跟着一起变，而不是被一份旧副本钉住
      await prefsApi.reset(DASHBOARD_LAYOUT_KEY);
      const next = defaultLayout(widgets);
      latest.current = next;
      setLayout(next);
      toast.success('已恢复默认布局');
    } catch (err) {
      toast.error('恢复默认失败', errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const visibleOrder = useMemo(
    () => layout.order.filter((id) => !layout.hidden.includes(id)),
    [layout],
  );

  const hiddenWidgets = useMemo(
    () =>
      layout.order
        .filter((id) => layout.hidden.includes(id))
        .map((id) => byId.get(id))
        .filter((w): w is WidgetMeta => Boolean(w)),
    [layout, byId],
  );

  const isDefault = useMemo(() => {
    const order = idsOf(widgets);
    return (
      layout.hidden.length === 0 &&
      layout.order.length === order.length &&
      layout.order.every((id, index) => id === order[index])
    );
  }, [layout, widgets]);

  return {
    layout,
    visibleOrder,
    hiddenWidgets,
    isDefault,
    loading,
    move,
    setHidden,
    reset,
  };
}
