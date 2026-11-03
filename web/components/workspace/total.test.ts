import { describe, expect, it } from "vitest";

import { scaleToWhole, unallocatedOf, WHOLE_BP } from "./total";

/**
 * Hand-computed cases, because this is arithmetic a reader can check on paper.
 *
 * The property that matters is stated as an invariant rather than as a snapshot: the
 * scaled set sums to exactly 10,000, and every row stays within one basis point of its
 * exact proportional share. A rounding rule that quietly moves money between rows by
 * more than that would make a printed total disagree with the printed rows.
 */
describe("unallocatedOf", () => {
  it("reports what is left of the whole", () => {
    expect(unallocatedOf([6_000, 3_000])).toBe(1_000);
  });

  it("reports nothing left when the rows already fill the whole", () => {
    expect(unallocatedOf([6_000, 4_000])).toBe(0);
  });

  it("reports nothing left when the rows overshoot, rather than a negative amount", () => {
    expect(unallocatedOf([6_000, 6_000])).toBe(0);
  });

  it("treats a negative row as zero: a negative row is not money", () => {
    expect(unallocatedOf([6_000, -500])).toBe(4_000);
  });

  it("reports the whole of an empty list", () => {
    expect(unallocatedOf([])).toBe(WHOLE_BP);
  });
});

describe("scaleToWhole", () => {
  it("keeps a set that already fills the whole exactly as it is", () => {
    expect(scaleToWhole([6_000, 4_000])).toEqual([6_000, 4_000]);
    expect(scaleToWhole([3_334, 3_333, 3_333])).toEqual([3_334, 3_333, 3_333]);
  });

  it("scales a 60/30 split to 66.67% / 33.33%", () => {
    // 6000/9000 × 10000 = 6666.67 and 3000/9000 × 10000 = 3333.33: the largest
    // remainder takes the left-over point, so the total lands on exactly 10,000.
    expect(scaleToWhole([6_000, 3_000])).toEqual([6_667, 3_333]);
  });

  it("scales up a single row to the whole", () => {
    expect(scaleToWhole([1])).toEqual([10_000]);
  });

  it("splits three equal rows the way every other even split does", () => {
    expect(scaleToWhole([1, 1, 1])).toEqual([3_334, 3_333, 3_333]);
  });

  it("splits seven equal rows without losing a basis point", () => {
    const scaled = scaleToWhole([1, 1, 1, 1, 1, 1, 1]);
    expect(scaled.reduce((sum, value) => sum + value, 0)).toBe(WHOLE_BP);
    expect(scaled).toEqual([1_429, 1_429, 1_429, 1_429, 1_428, 1_428, 1_428]);
  });

  it("scales a set that overshoots back down to the whole", () => {
    // 120% entered as 60/60 becomes the same 50/50 shape at 100%.
    expect(scaleToWhole([6_000, 6_000])).toEqual([5_000, 5_000]);
  });

  it("has nothing to scale in an empty list, and nothing to divide by in a zero list", () => {
    expect(scaleToWhole([])).toEqual([]);
    expect(scaleToWhole([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("always lands on exactly 10,000, and never moves a row more than a basis point", () => {
    const sets = [
      [1, 2, 3],
      [1_000, 2_000, 3_000, 4_000],
      [7_777, 2_223],
      [16, 17, 33, 34],
      [999, 1_001],
      [5, 5, 5, 5, 5, 5, 5, 5, 5],
    ];
    for (const amounts of sets) {
      const total = amounts.reduce((sum, value) => sum + value, 0);
      const scaled = scaleToWhole(amounts);
      expect(scaled.reduce((sum, value) => sum + value, 0)).toBe(WHOLE_BP);
      amounts.forEach((amount, index) => {
        const exact = (amount * WHOLE_BP) / total;
        expect(Math.abs((scaled[index] ?? 0) - exact)).toBeLessThan(1);
      });
    }
  });
});
