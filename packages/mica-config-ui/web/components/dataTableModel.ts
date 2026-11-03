/**
 * 数据表分页的纯计算。
 *
 * `DataTable` 只负责画，页码夹紧、区间文本与「一共几页」都在这里算：越界（数据变少、
 * 过滤器收紧）时会落回最后一页，而不是画出一张空表。
 */
export type PageWindow = {
  /** 夹紧之后的页码（0 起）。 */
  page: number;
  pageCount: number;
  /** 本页第一行在整体里的序号（0 起）。 */
  start: number;
  /** 本页末行的后一位（不含）。 */
  end: number;
  total: number;
  pageSize: number;
};

/**
 * `pageSize` 为 0（或不合法）表示不分页：全部行算一页，`pageCount` 仍是 1，
 * 调用方据此决定要不要画翻页控件。
 */
export function pageWindow(total: number, page: number, pageSize: number): PageWindow {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const size = Math.floor(Number(pageSize) || 0) > 0 ? Math.floor(Number(pageSize)) : Math.max(1, count);
  const pageCount = Math.max(1, Math.ceil(count / size));
  const clamped = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pageCount - 1);
  const start = clamped * size;
  return { page: clamped, pageCount, start, end: Math.min(count, start + size), total: count, pageSize: size };
}

/** 「1–20 / 137」：给页面底部的区间说明，没有行时如实说 0。 */
export function pageRangeLabel(window: PageWindow): string {
  if (window.total <= 0) return '0';
  return `${window.start + 1}–${window.end} / ${window.total}`;
}
