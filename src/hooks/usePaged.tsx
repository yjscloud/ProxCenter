/* ==========================================================================
   ProxCenter — 前端分页（配合 <Pagination />）

   后端的列表接口多数还不支持 offset（一次给回上限条数），所以在前端切片。
   两个容易踩的点都在这里一次处理掉：

   * ``resetKey``（通常是作用域 / 主机）一变就回到第 1 页，否则会带着上一台
     机器的页码看到一张空表；
   * 数据变少导致当前页越界时用 ``Math.min`` 夹住，不会出现「停在第 3 页
     但其实只剩 1 页」。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { Pagination } from '../components/ui/Table';

/** 「每页 N 条」的候选值 */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** 默认每页条数：10 条对日志类列表偏少，翻页翻到手酸 */
const DEFAULT_PAGE_SIZE = 20;

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
  initialSize = DEFAULT_PAGE_SIZE,
): Pager & { rows: T[] } {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

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
  return (
    <Pagination
      page={pager.page}
      pageSize={pager.pageSize}
      total={pager.total}
      onChange={pager.setPage}
      pageSizeOptions={PAGE_SIZE_OPTIONS}
      onPageSizeChange={pager.setPageSize}
      jump
    />
  );
}
