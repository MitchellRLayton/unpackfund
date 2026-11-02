import { describe, expect, it } from "vitest";

import { insertionIndex, midpointsExcept, moveItem } from "./reorder";

/**
 * The drag arithmetic, tested without a DOM.
 *
 * A row is 40 px tall starting at 100, 140, 180: midpoints 120, 160, 200. These
 * numbers stand in for `getBoundingClientRect`, which jsdom reports as all zeroes.
 */
const rows = [
  { top: 100, height: 40 },
  { top: 140, height: 40 },
  { top: 180, height: 40 },
];

describe("moveItem", () => {
  it("moves down and up without losing anything", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps instead of dropping or growing the list", () => {
    expect(moveItem(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 99, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem([], 0, 3)).toEqual([]);
  });

  it("leaves the input array alone", () => {
    const original = ["a", "b", "c"];
    moveItem(original, 0, 2);
    expect(original).toEqual(["a", "b", "c"]);
  });
});

describe("midpointsExcept", () => {
  it("skips the row being dragged and keeps document order", () => {
    expect(midpointsExcept(rows, 1)).toEqual([120, 200]);
    expect(midpointsExcept(rows, 0)).toEqual([160, 200]);
  });
});

describe("insertionIndex", () => {
  const others = midpointsExcept(rows, 0); // dragging row 0: midpoints 160, 200

  it("is 0 above every other row", () => {
    expect(insertionIndex(others, 10)).toBe(0);
    expect(insertionIndex(others, 159)).toBe(0);
  });

  it("is the count of other rows the pointer has passed", () => {
    // Just past row 1's midpoint: the dragged row belongs between rows 1 and 2.
    expect(insertionIndex(others, 161)).toBe(1);
    expect(insertionIndex(others, 250)).toBe(2);
  });

  it("puts a pointer exactly on a midpoint above that row", () => {
    // Not "past" the midpoint, so the row has not been crossed yet.
    expect(insertionIndex(others, 160)).toBe(0);
    expect(insertionIndex(others, 200)).toBe(1);
  });
});
