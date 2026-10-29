import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FreshnessStrip, MetricsList } from "@/components/FreshnessStrip";
import { LedgerTable } from "@/components/LedgerTable";
import { Notice } from "@/components/Notice";
import type { Ledger, LedgerRow, ReleaseManifest } from "@/lib/types";

afterEach(cleanup);

const manifest: ReleaseManifest = {
  schema_version: 1,
  as_of: "2026-10-28.3",
  generated_at: "2026-10-28T22:59:00Z",
  pipeline_git_sha: "abc1234",
  fund_count: 1,
  etf_count: null,
  etf_classifier: null,
  company_count: 1,
  coverage_histogram: {},
  mapping_rungs: {},
  asset_cat_counts: {},
  files: [],
};

function row(
  company_id: string,
  name: string,
  weight: number,
  fund_count = 1,
): LedgerRow {
  return {
    company_id,
    name,
    ticker: name.slice(0, 4).toUpperCase(),
    weight,
    fund_count,
    sources: [{ ticker: "VOO", weight }],
  };
}

const ledger: Ledger = {
  rows: [row("c_1", "NVIDIA Corp", 0.0751), row("c_2", "Apple Inc", 0.0659)],
  metrics: {
    hhi: 0.305,
    effective_n: 3.2787,
    top10: 0.9,
    covered_weight_pct: 90.3,
    resolved_weight: 0.903,
    suppressed_weight: 0,
  },
  funds: [
    {
      ticker: "VOO",
      name: "VANGUARD 500 INDEX FUND",
      as_of: "2026-06-30",
      filed_at: "2026-08-28",
      lag_days: 59,
      coverage_pct: 90.3,
      source_url: "https://www.sec.gov/example",
    },
  ],
  oldest_as_of: "2026-06-30",
  max_lag_days: 59,
  unmapped_holdings: 189,
};

describe("FreshnessStrip", () => {
  it("prints the filing period, the lag, and the coverage in words", () => {
    render(<FreshnessStrip manifest={manifest} ledger={ledger} />);
    expect(screen.getByText("2026-10-28.3")).toBeTruthy();
    expect(screen.getByText("2026-06-30")).toBeTruthy();
    expect(screen.getByText("59 days")).toBeTruthy();
    expect(screen.getByText("90.3%")).toBeTruthy();
    expect(screen.getByText("90.3% of weight covered")).toBeTruthy();
    expect(screen.getByText("189 holdings unmapped")).toBeTruthy();
  });

  it("does not claim a date it does not have", () => {
    const empty: Ledger = {
      ...ledger,
      rows: [],
      funds: [],
      oldest_as_of: null,
      max_lag_days: null,
    };
    render(<FreshnessStrip manifest={manifest} ledger={empty} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});

describe("MetricsList", () => {
  it("renders a not-computable metric as words, never as zero", () => {
    render(
      <MetricsList
        ledger={{
          ...ledger,
          metrics: { ...ledger.metrics, hhi: null, effective_n: null, top10: null },
        }}
      />,
    );
    expect(screen.getAllByText("not computable")).toHaveLength(3);
  });
});

describe("LedgerTable", () => {
  it("is a real table with a scope on every header and a sort on the active column", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(2);
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      "Portfolio weight",
    );
    expect(container.querySelectorAll('th[aria-sort="none"]')).toHaveLength(2);
    expect(table?.querySelector("caption")?.textContent).toContain("2 companies");
  });

  it("shows each company once with its weight and how many funds hold it", () => {
    render(<LedgerTable rows={ledger.rows} />);
    expect(screen.getByText("NVIDIA Corp")).toBeTruthy();
    expect(screen.getByText("7.51%")).toBeTruthy();
    // Weight is a share of the portfolio, and the row note names the source.
    expect(screen.getAllByText(/VOO 7\.51%/).length).toBeGreaterThan(0);
  });
});

describe("Notice", () => {
  it("names its kind in the heading as well as the styling", () => {
    const { container } = render(
      <Notice tone="warn" title="These weights do not add up to 100%">
        <p>Details</p>
      </Notice>,
    );
    expect(container.querySelector(".notice--warn")).toBeTruthy();
    expect(screen.getByText("These weights do not add up to 100%")).toBeTruthy();
  });
});
