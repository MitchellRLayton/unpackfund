/**
 * Drag-to-reorder and keyboard-to-reorder for the builder's list.
 *
 * One row at a time is "held": the drag handle captures the pointer, and the row
 * follows the pointer through the list. The browser's native HTML drag-and-drop would
 * have been less code, but it does not fire on touch screens, and the builder is
 * mobile-first — so this is pointer events, which behave the same for a mouse, a
 * finger, and a pen.
 *
 * The hook owns only the interaction; the order itself lives in the URL fragment via
 * `usePortfolio().move`. It never keeps a second copy of the order, which is why a
 * dropped drag, a reload, and a shared link all agree.
 *
 * Keyboard support is not an afterthought: a handle is a real button, arrow keys move
 * its row one position, Home and End jump to the ends, and every move is announced
 * through a polite live region the builder renders (`role="status"`).
 */

import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";

import { insertionIndex, midpointsExcept, type RowRect } from "./reorder";

/**
 * Milliseconds between two applied drag moves.
 *
 * A reorder changes the geometry under the pointer, and a `pointermove` that arrives
 * before the browser has painted the new layout reads the old midpoints and would drag
 * the row back. Dropping moves for ~2 frames is invisible at drag speed and makes the
 * oscillation impossible.
 */
const MOVE_INTERVAL_MS = 32;

export interface ReorderHandleProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface ReorderList {
  /** Attach to the `<ul>`; the hook reads row geometry from its children. */
  listRef: RefObject<HTMLUListElement | null>;
  /** Index being dragged, or `null`; the builder turns it into a row class. */
  draggingIndex: number | null;
  /** What the last move was, for the polite live region. */
  announcement: string;
  /** Props for the handle button of the row at `index`. */
  handleProps: (index: number) => ReorderHandleProps;
}

function rectOf(element: Element): RowRect {
  const { top, height } = element.getBoundingClientRect();
  return { top, height };
}

export function useReorderList(options: {
  count: number;
  labelAt: (index: number) => string;
  onMove: (from: number, to: number) => void;
}): ReorderList {
  const { count, labelAt, onMove } = options;
  const listRef = useRef<HTMLUListElement | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // `index` is where the dragged row currently sits in the written order: the DOM can
  // be a frame behind at pointerup, the URL cannot.
  const drag = useRef<{ lastAt: number; label: string; index: number } | null>(null);

  /** The row's current position, read from the DOM so it is never a render behind. */
  const indexOfRow = useCallback((element: Element | null): number => {
    const list = listRef.current;
    const row = element?.closest("li") ?? null;
    if (!list || !row) return -1;
    return Array.prototype.indexOf.call(list.children, row) as number;
  }, []);

  // The row's name is taken before the move, never after: the entries reorder
  // underneath, so `labelAt(destination)` after a move can name the row that used to
  // sit there. A drag keeps the name it started with, which is the row the visitor is
  // holding.
  const announce = useCallback(
    (label: string, position: number) => {
      if (position < 0 || label.length === 0) return;
      setAnnouncement(`${label} moved to position ${position + 1} of ${count}`);
    },
    [count],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (count < 2 || event.button !== 0) return;
      const index = indexOfRow(event.currentTarget);
      if (index < 0) return;
      drag.current = { lastAt: 0, label: labelAt(index), index };
      setDraggingIndex(index);
      // Capture keeps the moves coming once the pointer leaves the handle. A rejected
      // capture (a pointer that is already gone, or an event a test dispatched) must
      // not abort the drag, so it is attempted last and its failure is ignored.
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* no active pointer to capture; the drag still works from the handle */
      }
      // Stops the browser from selecting row text while the pointer moves.
      event.preventDefault();
    },
    [count, indexOfRow, labelAt],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const state = drag.current;
      const list = listRef.current;
      if (!state || !list) return;
      const from = indexOfRow(event.currentTarget);
      if (from < 0) return;
      const rows = Array.from(list.children);
      const to = insertionIndex(midpointsExcept(rows.map(rectOf), from), event.clientY);
      if (to === from) return;
      const now = Date.now();
      if (now - state.lastAt < MOVE_INTERVAL_MS) return;
      drag.current = { lastAt: now, label: state.label, index: to };
      setDraggingIndex(to);
      onMove(from, to);
    },
    [indexOfRow, onMove],
  );

  const finishDrag = useCallback(
    (announcePosition: boolean) => {
      const state = drag.current;
      if (!state) return;
      drag.current = null;
      setDraggingIndex(null);
      // Announced from the written order, not from the DOM: at pointerup the list can
      // still be showing the pre-move positions for one frame.
      if (announcePosition) announce(state.label, state.index);
    },
    [announce],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const handle = event.currentTarget;
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      finishDrag(true);
    },
    [finishDrag],
  );

  const onPointerCancel = useCallback(() => finishDrag(false), [finishDrag]);

  const onLostPointerCapture = useCallback(() => finishDrag(false), [finishDrag]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, index: number) => {
      if (count < 2) return;
      let to: number;
      switch (event.key) {
        case "ArrowUp":
          to = index - 1;
          break;
        case "ArrowDown":
          to = index + 1;
          break;
        case "Home":
          to = 0;
          break;
        case "End":
          to = count - 1;
          break;
        default:
          return;
      }
      // Arrow keys on a focused handle move the row, never scroll the page.
      event.preventDefault();
      if (to < 0 || to > count - 1 || to === index) return;
      const label = labelAt(index);
      onMove(index, to);
      announce(label, to);
    },
    [announce, count, labelAt, onMove],
  );

  const handleProps = useCallback(
    (index: number): ReorderHandleProps => ({
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onKeyDown: (event) => onKeyDown(event, index),
    }),
    [
      onKeyDown,
      onPointerCancel,
      onPointerDown,
      onLostPointerCapture,
      onPointerMove,
      onPointerUp,
    ],
  );

  return { listRef, draggingIndex, announcement, handleProps };
}
