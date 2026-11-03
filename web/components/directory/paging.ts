/**
 * Pagination arithmetic, as a pure module.
 *
 * Both directories are larger than a table should render at once — 9,112 funds
 * and 12,895 companies in the 2026-11-03.1 release — so they are paginated
 * rather than virtualized. Pagination was chosen over a virtual window because a
 * literal `<table>` keeps the semantics a screen reader relies on: a caption,
 * `scope="col"` headers, and a row position that is real rather than announced
 * through `aria-rowindex` (`static-xray-frontend` §8 allows either, and prefers
 * the real table when it costs nothing).
 *
 * Every number here is display arithmetic, never a statistic, so the module is
 * tested against hand-worked cases rather than snapshots.
 */

/** Rows per page. 50 is one comfortable screen and keeps the DOM light. */
export const PAGE_SIZE = 50;

export interface Page<T> {
  /** The rows of this page, in the order they were given. */
  rows: T[];
  /** 1-based page number actually used, after clamping. */
  page: number;
  /** Total number of pages; always at least 1, so "page 1 of 1" is the empty case. */
  pages: number;
  /** 1-based index of the first row on this page, or 0 when there are no rows. */
  start: number;
  /** 1-based index of the last row on this page, or 0 when there are no rows. */
  end: number;
  total: number;
}

/** Total pages for a row count. An empty list still has one (empty) page. */
export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * A page number that exists.
 *
 * Clamping rather than throwing is deliberate: a filter can shorten the result
 * list while the reader is on page 40, and the right response is to show the
 * last page rather than an empty table or an error.
 */
export function clampPage(page: number, total: number, pageSize = PAGE_SIZE): number {
  const pages = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), pages);
}

/** The rows and the display range of one page. */
export function pageOf<T>(rows: T[], page: number, pageSize = PAGE_SIZE): Page<T> {
  const total = rows.length;
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  const offset = (current - 1) * pageSize;
  const end = Math.min(offset + pageSize, total);
  return {
    rows: rows.slice(offset, end),
    page: current,
    pages,
    start: total === 0 ? 0 : offset + 1,
    end: total === 0 ? 0 : end,
    total,
  };
}
