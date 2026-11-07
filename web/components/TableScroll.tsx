"use client";

/**
 * A table wider than the column that shows it, with a scrollbar you can always reach.
 *
 * The native horizontal scrollbar lives at the bottom of the scroll box, and on a
 * table taller than the viewport that is below the fold: the only way to reach it is
 * to scroll to the end of the table first. A mouse with no horizontal wheel and no
 * touchpad then has no way to move the table sideways at all, which is the report this
 * exists to answer.
 *
 * The rail is a second scrollbar that pins itself to the bottom of the viewport for as
 * long as the table is on screen, so the control sits where the reader is looking
 * rather than where the table ends. It is a duplicate control, not a second scroll
 * box: it drives the same `scrollLeft` as the table, and the table's own box is
 * focusable so the arrow keys scroll it without the rail. That is also why the rail is
 * `aria-hidden` — a screen reader gets one scrollable region, not two.
 *
 * Nothing here computes a number the table shows. The only arithmetic is the thumb's
 * width and position, which are the scroll box's own geometry.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface Rail {
  /** Whether the table is wider than the box that shows it. */
  overflow: boolean;
  /** The thumb's width, as a fraction of the track. */
  thumb: number;
  /** The thumb's left edge, as a fraction of the track. */
  offset: number;
}

const NO_RAIL: Rail = { overflow: false, thumb: 1, offset: 0 };

/** How far a click on the track moves the table: most of a screen, never all of it. */
const PAGE_FRACTION = 0.8;

export function TableScroll({
  label,
  children,
}: {
  /** The scrollable region's accessible name. */
  label: string;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [rail, setRail] = useState<Rail>(NO_RAIL);
  const drag = useRef<{ x: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const { scrollWidth, clientWidth, scrollLeft } = box;
    // A sub-pixel difference is rounding, not something to scroll.
    if (scrollWidth <= clientWidth + 1) {
      setRail(NO_RAIL);
      return;
    }
    setRail({
      overflow: true,
      thumb: clientWidth / scrollWidth,
      offset: scrollLeft / scrollWidth,
    });
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // The table's own width changes when a column's content does, and the box's width
    // does not move when that happens — so the table is observed too.
    const table = box.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [measure]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const { scrollWidth, clientWidth, scrollLeft } = box;
    if (scrollWidth <= clientWidth + 1) return;
    setRail({
      overflow: true,
      thumb: clientWidth / scrollWidth,
      offset: scrollLeft / scrollWidth,
    });
  }, []);

  const onThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, left: box.scrollLeft };
  };

  const onThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    const track = trackRef.current;
    const start = drag.current;
    if (!box || !track || !start) return;
    const trackWidth = track.clientWidth;
    const travel = box.scrollWidth - box.clientWidth;
    if (trackWidth <= 0 || travel <= 0) return;
    // The thumb travels `trackWidth - thumbWidth` while the table travels `travel`;
    // that ratio is what makes the thumb follow the pointer instead of outrunning it.
    const usable = trackWidth - trackWidth * (box.clientWidth / box.scrollWidth);
    if (usable <= 0) return;
    box.scrollLeft = start.left + ((event.clientX - start.x) * travel) / usable;
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /** A click on the track pages the table; the thumb handles its own drag. */
  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    const track = trackRef.current;
    if (!box || !track || event.target !== track) return;
    const rect = track.getBoundingClientRect();
    const forward = event.clientX > rect.left + rect.width / 2;
    const page = box.clientWidth * PAGE_FRACTION;
    box.scrollLeft = Math.max(0, box.scrollLeft + (forward ? page : -page));
  };

  return (
    <div className="table-scroll">
      <div
        className="table-wrap"
        ref={boxRef}
        onScroll={onScroll}
        // Focusable so the arrow keys scroll it: a scroll box a keyboard cannot reach
        // is a scroll box half the readers cannot use (WCAG 2.1.1).
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
      {rail.overflow ? (
        <div
          className="table-scroll__rail"
          ref={trackRef}
          aria-hidden="true"
          onPointerDown={onTrackPointerDown}
        >
          <div
            className="table-scroll__thumb"
            style={{
              width: `${rail.thumb * 100}%`,
              marginLeft: `${rail.offset * 100}%`,
            }}
            onPointerDown={onThumbPointerDown}
            onPointerMove={onThumbPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </div>
      ) : null}
    </div>
  );
}
