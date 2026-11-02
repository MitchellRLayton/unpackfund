/**
 * Ordering arithmetic for the builder's list, kept away from the DOM so it can be
 * tested without a layout engine.
 *
 * Two facts decide where a dragged row lands, and neither needs React: the list
 * order (an array) and the vertical midpoint of every row (numbers). A pure function
 * for each means the drag handler stays a thin adapter, and a test can assert the
 * mapping "pointer between row 2 and row 3 → position 2" without a browser.
 */

/** A row's vertical band, in the units `getBoundingClientRect` returns. */
export interface RowRect {
  top: number;
  height: number;
}

/** `from` moved to `to`, in a new array; clamped, never mutates, never drops. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const last = list.length - 1;
  if (last < 0) return [];
  const start = Math.max(0, Math.min(last, from));
  const end = Math.max(0, Math.min(last, to));
  const next = [...list];
  const [moved] = next.splice(start, 1);
  // `start` is clamped into range above, so `moved` always exists; the guard is for
  // `noUncheckedIndexedAccess` deciding otherwise.
  if (moved === undefined) return next;
  next.splice(end, 0, moved);
  return next;
}

/** Vertical midpoints of every row except the one being dragged. */
export function midpointsExcept(rows: readonly RowRect[], skip: number): number[] {
  const midpoints: number[] = [];
  rows.forEach((row, index) => {
    if (index === skip) return;
    midpoints.push(row.top + row.height / 2);
  });
  return midpoints;
}

/**
 * The position a row dragged to `y` should occupy.
 *
 * The count of *other* rows whose midpoint the pointer has passed is exactly the
 * destination index: with the dragged row removed, position 0 means "above every
 * other row", and position `length - 1` means "below all of them". Midpoints arrive in
 * document order, so the first one below the pointer ends the count.
 */
export function insertionIndex(midpoints: readonly number[], y: number): number {
  let passed = 0;
  for (const midpoint of midpoints) {
    if (y <= midpoint) break;
    passed += 1;
  }
  return passed;
}
