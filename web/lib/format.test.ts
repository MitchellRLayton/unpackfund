import { describe, expect, it } from "vitest";

import {
  coverageBand,
  coverageChip,
  coverageLabel,
  formatCoveragePct,
  formatDays,
  formatFreshness,
  formatRatio,
  formatShare,
  formatWeightBp,
} from "./format";

describe("formatWeightBp", () => {
  it("renders integer basis points as exactly two decimals of a percent", () => {
    expect(formatWeightBp(273)).toBe("2.73%");
    expect(formatWeightBp(5000)).toBe("50.00%");
    expect(formatWeightBp(1234)).toBe("12.34%");
  });

  it("keeps a one-basis-point position visible", () => {
    expect(formatWeightBp(1)).toBe("0.01%");
  });
});

describe("formatShare", () => {
  it("renders a fraction of the portfolio as a percent", () => {
    expect(formatShare(0.35)).toBe("35.00%");
    expect(formatShare(0.0001)).toBe("0.01%");
  });

  it("never rounds a real position to zero", () => {
    // 0.4 bp of the portfolio would print 0.00% at two decimals.
    expect(formatShare(0.00004)).toBe("<0.01%");
  });

  it("prints a true zero as zero", () => {
    expect(formatShare(0)).toBe("0.00%");
  });
});

describe("coverage bands", () => {
  it("is half-open at the lower edge", () => {
    expect(coverageBand(70)).toBe("full");
    expect(coverageBand(69.9)).toBe("partial");
    expect(coverageBand(60)).toBe("partial");
    expect(coverageBand(59.9)).toBe("none");
  });

  it("carries the words, not only the colour", () => {
    expect(coverageLabel(90.3)).toBe("90.3% of weight covered");
    expect(coverageLabel(66.4)).toBe("partial (66.4% of weight)");
    expect(coverageLabel(41)).toBe("not covered");
    expect(coverageChip(66.4)).toBe("partial 66.4%");
  });

  it("never rounds across a boundary in the label", () => {
    // 69.96 would round to 70.0 and claim full coverage it does not have.
    expect(coverageLabel(69.96)).toBe("partial (70.0% of weight)");
    expect(coverageBand(69.96)).toBe("partial");
  });
});

describe("other formatting", () => {
  it("renders dates as stored, without reinterpreting a timezone", () => {
    expect(formatFreshness("2026-06-30", "2026-08-28", 59)).toBe(
      "2026-06-30 · filed 2026-08-28 · 59 days",
    );
    expect(formatDays(1)).toBe("1 day");
  });

  it("pins the locale for ratios and coverage", () => {
    expect(formatRatio(0.02074643, 4)).toBe("0.0207");
    expect(formatRatio(48.201064, 1)).toBe("48.2");
    expect(formatCoveragePct(90.3)).toBe("90.3%");
  });
});
