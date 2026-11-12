/**
 * The redesigned Effective holdings block, rendered from the real maths.
 *
 * The fixtures go through `effectiveHoldings()` rather than hand-written numbers, so a
 * change to the arithmetic moves these assertions with it. What is written down is the
 * reading: the headline, the verdict, the three bars, the two facts, the disclosure, and
 * the states the plan requires (withheld coverage, one stock, no benchmark, one fund).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { effectiveHoldings, type EffectiveInput } from "@/lib/effective-holdings";
import type { BenchmarkComparison, LedgerRow } from "@/lib/types";

import { EffectiveHoldingsSummary } from "./EffectiveHoldingsSummary";

afterEach(cleanup);

function company(weight: number, ...sources: number[]) {
  return { weight, sources: sources.map((source) => ({ weight: source })) };
}

function holdings(input: Partial<EffectiveInput> & Pick<EffectiveInput, "companies">) {
  return effectiveHoldings({ unmatchedWeight: 0, unmatchedPositions: 0, ...input });
}

function row(name: string, weight: number, holderCount = 1): LedgerRow {
  return {
    company_id: `c_${name}`,
    name,
    ticker: null,
    country: "US",
    weight,
    benchmark_weight: null,
    holder_count: holderCount,
    held_directly: false,
    sources: [{ kind: "fund", ref: "AAA", weight }],
  };
}

const TWO = holdings({ companies: [company(0.5, 0.5), company(0.5, 0.5)] });
const ROWS = [row("Alpha", 0.5), row("Beta", 0.5)];
const BENCHMARK: BenchmarkComparison = {
  ticker: "VT",
  name: "Vanguard Total World Stock ETF",
  as_of: "2026-06-30",
  filed_at: "2026-08-28",
  lag_days: 59,
  coverage_pct: 98,
  source_url: "https://www.sec.gov/x",
  weights: { c_Alpha: 0.5, c_Beta: 0.5 },
};

function renderBlock(
  overrides: Partial<Parameters<typeof EffectiveHoldingsSummary>[0]> = {},
) {
  return render(
    <EffectiveHoldingsSummary
      effective={TWO}
      rows={ROWS}
      benchmark={BENCHMARK}
      fundCount={1}
      directCount={0}
      onSeeOverlap={() => {}}
      {...overrides}
    />,
  );
}

describe("the redesigned block", () => {
  it("leads with the headline, the verdict and the three bars", () => {
    const { container } = renderBlock();
    expect(
      screen.getByText(
        "You own 2 companies, but your portfolio behaves like 2 equally weighted ones.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("About as diversified as VT.")).toBeTruthy();
    const bars = Array.from(container.querySelectorAll("ul[aria-label] li")).map((item) =>
      item.getAttribute("aria-label"),
    );
    expect(bars).toEqual(["You: 2 effective companies", "VT: 2 effective companies"]);
    // One fund: no no-overlap bar, and no overlap bullet.
    expect(screen.queryByText(/if they didn't overlap/)).toBeNull();
    expect(screen.queryByText(/Overlap is the biggest reason/)).toBeNull();
  });

  it("keeps the arithmetic's names inside the disclosure", () => {
    const { container } = renderBlock();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Core");
    expect(text).not.toContain("Broad");
    expect(screen.getByText("How this is calculated")).toBeTruthy();
    expect(screen.getByText("See the curve")).toBeTruthy();
  });

  it("prints the explanation instead of a figure below 60% coverage", () => {
    const withheld = holdings({
      companies: [company(0.5, 0.5)],
      unmatchedWeight: 0.5,
      unmatchedPositions: 2,
    });
    const { container } = renderBlock({ effective: withheld });
    expect(container.textContent).toContain("Coverage is below 60% of weight");
    expect(container.querySelector("ul[aria-label]")).toBeNull();
  });

  it("says one company and hides the bars for a single stock", () => {
    const single = holdings({ companies: [company(1, 1)] });
    const { container } = renderBlock({
      effective: single,
      rows: [row("AAPL", 1)],
      benchmark: null,
      fundCount: 0,
      directCount: 1,
    });
    expect(screen.getByText("Your portfolio is one company.")).toBeTruthy();
    expect(container.querySelector("ul[aria-label]")).toBeNull();
  });

  it("drops the comparison, not the block, when there is no benchmark", () => {
    const { container } = renderBlock({ benchmark: null });
    expect(screen.queryByText(/About as diversified/)).toBeNull();
    const bars = Array.from(container.querySelectorAll("ul[aria-label] li")).map((item) =>
      item.getAttribute("aria-label"),
    );
    expect(bars).toEqual(["You: 2 effective companies"]);
  });
});
