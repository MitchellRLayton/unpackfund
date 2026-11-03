/**
 * The arithmetic behind a windowed table: which rows to draw, and how much space to leave
 * where the rest of them would be.
 *
 * The Companies lens has one row per company in the ledger, and a three-fund portfolio is
 * already 3,665 of them. Drawing all of them is ~22,000 nodes and is exactly the case the
 * "interactive under 2 s" budget is about, so the table draws a window and lets two spacer
 * rows carry the height of everything it is not drawing. The scrollbar is then honest, the
 * scroll position is honest, and the DOM is small.
 *
 * The arithmetic lives here, away from the component, for one reason: it is the part that
 * can be wrong. A window that is off by one drops a row from the table; padding that is
 * off by a row makes the scrollbar jump as you drag it. Neither is visible in a screenshot
 * of the top of the table, and both are cheap to test as plain numbers.
 *
 * The three rules the functions below hold to:
 *
 * 1. **A window is never empty when there are rows.** `start` is clamped so the first row
 *    of the table is always drawable, and `end` is never behind `start`.
 * 2. **The padding is measured in whole rows and adds up.** `topPad + drawn + bottomPad`
 *    is always `count` rows of height, whatever the scroll position.
 * 3. **The bottom of the scroll reaches the last row.** The anchor is clamped to
 *    `count - visible`, so scrolling to the end draws the end rather than a window that
 *    stops just short of it.
 *
 * Rows are a fixed height, which is what makes all of this possible: the tables clamp the
 * company name to one line, so a row cannot grow and the geometry never has to be
 * re-measured mid-scroll.
 */

/** One row's height in CSS pixels, including its rule. Must match `rowHeight` in the table. */
export const ROW_HEIGHT = 64;

/** How many rows fit the scroll container. Keep in step with `VIEWPORT_HEIGHT`. */
export const VISIBLE_ROWS = 8;

/** Rows drawn above and below the visible ones: two screens' worth of slack for a fast drag. */
export const OVERSCAN = 12;

/** The scroll container's height: exactly the rows it can show. */
export const VIEWPORT_HEIGHT = ROW_HEIGHT * VISIBLE_ROWS;

export interface RowWindow {
  /** First drawn row, 0-based. */
  start: number;
  /** One past the last drawn row. */
  end: number;
  /** Space above the drawn rows, in pixels, standing in for every row before `start`. */
  topPad: number;
  /** Space below them, in pixels, for every row from `end` on. */
  bottomPad: number;
}

/**
 * The slice to draw for a scroll position expressed as an anchor row.
 *
 * `first` is the row at the top of the visible area, not the top of the drawn area: the
 * overscan is the difference, and it is what stops a drag from showing blank paper before
 * the next render arrives.
 */
export function rowWindow({
  count,
  first,
  visible = VISIBLE_ROWS,
  overscan = OVERSCAN,
  rowHeight = ROW_HEIGHT,
}: {
  count: number;
  first: number;
  visible?: number;
  overscan?: number;
  rowHeight?: number;
}): RowWindow {
  if (count <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };

  const anchor = Math.min(
    Math.max(0, Math.floor(first)),
    Math.max(0, count - Math.max(1, visible)),
  );
  const start = Math.max(0, anchor - Math.max(0, overscan));
  const end = Math.min(count, anchor + Math.max(1, visible) + Math.max(0, overscan));

  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, count - end) * rowHeight,
  };
}

/**
 * Which row is at the top of the scroll container.
 *
 * `bodyOffset` is the height of everything above the first body row — the caption and the
 * header scroll with the rows, and the caption alone is taller than several rows, so the
 * scroll position is not an index until that is subtracted. It is measured from the DOM by
 * the caller (and passed in) rather than assumed here, because it changes with the width of
 * the window and the length of the caption.
 */
export function firstVisibleRow({
  scrollTop,
  bodyOffset,
  rowHeight = ROW_HEIGHT,
}: {
  scrollTop: number;
  bodyOffset: number;
  rowHeight?: number;
}): number {
  if (!(rowHeight > 0)) return 0;
  const rows = Math.floor((scrollTop - bodyOffset) / rowHeight);
  return Number.isFinite(rows) && rows > 0 ? rows : 0;
}

/**
 * The scroll position that brings `index` fully into view, or `null` when it already is.
 *
 * This is what keeps a keyboard on a windowed table working: a row that receives focus is
 * scrolled to, the scroll moves the window, and the rows just past it are drawn by the
 * time the next Tab arrives. Without it, Tab would walk into the overscan and stop, because
 * there is nothing beyond the window to focus.
 */
export function scrollTopForRow({
  index,
  scrollTop,
  clientHeight,
  bodyOffset,
  rowHeight = ROW_HEIGHT,
}: {
  index: number;
  scrollTop: number;
  clientHeight: number;
  bodyOffset: number;
  rowHeight?: number;
}): number | null {
  if (!(rowHeight > 0) || index < 0) return null;
  const top = bodyOffset + index * rowHeight;
  if (top < scrollTop) return Math.max(0, top);
  const bottom = top + rowHeight;
  if (bottom > scrollTop + clientHeight) {
    return Math.max(0, bottom - Math.max(clientHeight, rowHeight));
  }
  return null;
}
