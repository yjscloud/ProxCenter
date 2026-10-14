/* ==========================================================================
   ProxCenter — 前端分页（配合 <Pagination />）

   后端的列表接口多数还不支持 offset（一次给回上限条数），所以在前端切片。
   三个容易踩的点都在这里一次处理掉：

   * ``resetKey``（通常是作用域 / 主机 / 筛选条件）一变就回到第 1 页，否则会带着
     上一台机器的页码看到一张空表；
   * 数据变少导致当前页越界时用 ``Math.min`` 夹住，不会出现「停在第 3 页
     但其实只剩 1 页」；
   * **初始每页条数跟着「设置 → 面板设置 → 列表每页条数」走**
     （见 utils/panelSettings 的 panelPageSize）。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { Pagination } from '../components/ui/Table';
import { panelPageSize } from '../utils/panelSettings';

/** 「每页 N 条」的候选值（设置页里那一栏给的也是这几个） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export interface Pager {
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

export function usePaged<T>(
  items: T[],
  resetKey: string,
  /** 显式指定初始条数：只有「这一列就该比别处密 / 疏」的列表才传 */
  initialSize?: number,
): Pager & { rows: T[] } {
  const [page, setPage] = useState(1);
  /* 初始条数取「设置 → 面板设置 → 列表每页条数」：设置里的是**默认值**，分页条上
     的「每页 N 条」是本次浏览的临时选择（不写回设置）。挂载时读一次即可 ——
     换个页面就会重新挂载并重读，而追着设置改会把用户刚选好的条数冲掉。 */
  const [pageSize, setPageSize] = useState(
    () => initialSize ?? panelPageSize(),
  );

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  /* 改每页条数后原来的页码基本没有意义，回到第 1 页 */
  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);

  const rows = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );

  return {
    page: safePage,
    pageSize,
    total: items.length,
    rows,
    setPage,
    setPageSize,
  };
}

/**
 * 统一的分页条：带「每页 N 条」下拉与「跳至 _ 页」。
 * 条数不够一页时 Pagination 内部会自行判断是否渲染。
 */
export function PagerBar({ pager }: { pager: Pager }) {
  /* 当前条数不在候选里时临时补进候选：否则 <select> 的 value 找不到对应 option，
     下拉会显示成空白 —— 部署时用 VITE_PAGE_SIZE 定过一个非候选值时就会这样 */
  const options = useMemo(
    () =>
      PAGE_SIZE_OPTIONS.includes(pager.pageSize)
        ? PAGE_SIZE_OPTIONS
        : [...PAGE_SIZE_OPTIONS, pager.pageSize].sort((a, b) => a - b),
    [pager.pageSize],
  );

  return (
    <Pagination
      page={pager.page}
      pageSize={pager.pageSize}
      total={pager.total}
      onChange={pager.setPage}
      pageSizeOptions={options}
      onPageSizeChange={pager.setPageSize}
      jump
    />
  );
}
