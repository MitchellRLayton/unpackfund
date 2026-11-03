import { describe, expect, it } from "vitest";

import {
  firstVisibleRow,
  OVERSCAN,
  ROW_HEIGHT,
  rowWindow,
  scrollTopForRow,
  VIEWPORT_HEIGHT,
  VISIBLE_ROWS,
} from "./windowing";

/**
 * The windowed table's arithmetic.
 *
 * These are the numbers that decide whether a row exists in the DOM, and the three failures
 * they guard against are all invisible in a screenshot of the top of a table:
 *
 * - a window that is off by one silently drops a company from the table, and the table is
 *   the record;
 * - padding that is off by a row makes the scrollbar thumb drag into empty paper;
 * - a scroll position mapped to the wrong row means the bottom of the scroll stops short of
 *   the last company, which is exactly the sort of "it looks fine" bug a screenshot hides.
 */

const THREE_FUND_LEDGER = 3_665;

describe("rowWindow", () => {
  it("draws the top of the table from a standing start", () => {
    const view = rowWindow({ count: THREE_FUND_LEDGER, first: 0 });
    expect(view.start).toBe(0);
    expect(view.end).toBe(VISIBLE_ROWS + OVERSCAN);
    expect(view.topPad).toBe(0);
    expect(view.bottomPad).toBe((THREE_FUND_LEDGER - view.end) * ROW_HEIGHT);
  });

  it("puts the overscan above and below the visible rows", () => {
    const view = rowWindow({ count: THREE_FUND_LEDGER, first: 1_000 });
    expect(view.start).toBe(1_000 - OVERSCAN);
    expect(view.end).toBe(1_000 + VISIBLE_ROWS + OVERSCAN);
    // The drawn rows are one screen plus two overscans, never the whole table.
    expect(view.end - view.start).toBe(VISIBLE_ROWS + OVERSCAN * 2);
    expect(view.end - view.start).toBeLessThan(60);
  });

  it("puts the last company on screen when scrolled to the end", () => {
    // The anchor can never pass `count - visible`, or the end of the table would be a
    // window that stops short of the last row.
    const view = rowWindow({ count: THREE_FUND_LEDGER, first: THREE_FUND_LEDGER });
    expect(view.end).toBe(THREE_FUND_LEDGER);
    expect(view.start).toBe(THREE_FUND_LEDGER - VISIBLE_ROWS - OVERSCAN);
    expect(view.bottomPad).toBe(0);
    // The last row is inside the drawn slice.
    expect(view.end - 1).toBe(THREE_FUND_LEDGER - 1);
  });

  it("always leaves space for every row it does not draw", () => {
    for (const first of [0, 1, 7, 42, 1_000, 3_600, 3_665, 9_999]) {
      const view = rowWindow({ count: THREE_FUND_LEDGER, first });
      const drawn = view.end - view.start;
      expect(view.topPad + view.bottomPad).toBe((THREE_FUND_LEDGER - drawn) * ROW_HEIGHT);
      expect(view.start).toBeGreaterThanOrEqual(0);
      expect(view.end).toBeLessThanOrEqual(THREE_FUND_LEDGER);
      expect(view.end).toBeGreaterThan(view.start);
    }
  });

  it("draws everything when the table is shorter than the window", () => {
    const view = rowWindow({ count: 5, first: 0 });
    expect(view).toEqual({ start: 0, end: 5, topPad: 0, bottomPad: 0 });
  });

  it("has nothing to draw for an empty table", () => {
    expect(rowWindow({ count: 0, first: 0 })).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
    });
  });

  it("clamps a negative anchor rather than trusting it", () => {
    const view = rowWindow({ count: THREE_FUND_LEDGER, first: -40 });
    expect(view.start).toBe(0);
    expect(view.topPad).toBe(0);
  });
});

describe("firstVisibleRow", () => {
  const bodyOffset = 240; // the caption and the header scroll with the rows

  it("is the first row while the header is still on screen", () => {
    expect(firstVisibleRow({ scrollTop: 0, bodyOffset })).toBe(0);
    expect(firstVisibleRow({ scrollTop: 100, bodyOffset })).toBe(0);
    expect(firstVisibleRow({ scrollTop: bodyOffset, bodyOffset })).toBe(0);
  });

  it("counts rows past the header, not pixels from the top", () => {
    expect(firstVisibleRow({ scrollTop: bodyOffset + ROW_HEIGHT, bodyOffset })).toBe(1);
    expect(
      firstVisibleRow({ scrollTop: bodyOffset + ROW_HEIGHT * 3.5, bodyOffset }),
    ).toBe(3);
  });

  it("never returns a negative row", () => {
    expect(firstVisibleRow({ scrollTop: 10, bodyOffset: 400 })).toBe(0);
    expect(firstVisibleRow({ scrollTop: -10, bodyOffset: 0 })).toBe(0);
  });

  it("gives up rather than dividing by a zero row height", () => {
    expect(firstVisibleRow({ scrollTop: 500, bodyOffset: 0, rowHeight: 0 })).toBe(0);
  });
});

describe("scrollTopForRow", () => {
  const bodyOffset = 240;
  const clientHeight = VIEWPORT_HEIGHT;

  it("leaves a row that is already in view alone", () => {
    expect(
      scrollTopForRow({
        index: 2,
        scrollTop: bodyOffset,
        clientHeight,
        bodyOffset,
      }),
    ).toBeNull();
  });

  it("scrolls up to a row above the window", () => {
    const scrollTop = bodyOffset + ROW_HEIGHT * 20;
    expect(scrollTopForRow({ index: 3, scrollTop, clientHeight, bodyOffset })).toBe(
      bodyOffset + ROW_HEIGHT * 3,
    );
  });

  it("scrolls down to a row below the window", () => {
    const scrollTop = bodyOffset;
    const next = scrollTopForRow({ index: 30, scrollTop, clientHeight, bodyOffset });
    // The row is flush with the bottom edge, no further.
    expect(next).toBe(bodyOffset + ROW_HEIGHT * 30 + ROW_HEIGHT - clientHeight);
    expect(next).toBeGreaterThan(scrollTop);
  });

  it("scrolls to the first row's own position, never to the caption above it", () => {
    // Row zero starts after the caption and the header, so bringing it into view lands on
    // that offset rather than on zero: the caption is not part of the table's rows.
    expect(
      scrollTopForRow({ index: 0, scrollTop: 500, clientHeight, bodyOffset: 400 }),
    ).toBe(400);
    // With no header above it, the same request does reach the top of the scroller.
    expect(
      scrollTopForRow({ index: 0, scrollTop: 500, clientHeight, bodyOffset: 0 }),
    ).toBe(0);
  });
});
