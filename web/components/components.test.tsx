import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FreshnessStrip, MetricsList } from "@/components/FreshnessStrip";
import { LedgerTable } from "@/components/LedgerTable";
import { Notice } from "@/components/Notice";
import type { BenchmarkFacts, Ledger, LedgerRow, ReleaseDescriptor } from "@/lib/types";

afterEach(cleanup);

const release: ReleaseDescriptor = {
  schema_version: 2,
  kind: "release",
  as_of: "2026-10-30.1",
  generated_at: "2026-10-30T00:00:00Z",
  pipeline_git_sha: "abc1234",
  fund_count: 1,
  etf_count: null,
  etf_classifier: null,
  company_count: 1,
  coverage_histogram: {},
  mapping_rungs: {},
  asset_cat_counts: {},
  objects: {
    manifest: { path: "manifest.json", bytes: 10, sha256: "a".repeat(64) },
    tickers: { path: "tickers.json", bytes: 10, sha256: "b".repeat(64) },
    catalogue: { path: "catalogue.json", bytes: 10, sha256: "c".repeat(64) },
    fund_index: { prefix: "index/", shards: ["V"], funds: 1 },
    companies: {
      index: { path: "companies/index.json", bytes: 10, sha256: "d".repeat(64) },
      prefix: "companies/",
      count: 1,
    },
  },
};

function row(
  company_id: string,
  name: string,
  weight: number,
  holder_count = 1,
  benchmark_weight: number | null = null,
): LedgerRow {
  return {
    company_id,
    name,
    ticker: name.slice(0, 4).toUpperCase(),
    weight,
    benchmark_weight,
    holder_count,
    held_directly: false,
    sources: [{ kind: "fund", ref: "VOO", weight }],
  };
}

const vt: BenchmarkFacts = {
  ticker: "VT",
  name: "VANGUARD TOTAL WORLD STOCK INDEX FUND",
  as_of: "2026-07-31",
  filed_at: "2026-09-28",
  lag_days: 59,
  coverage_pct: 97.8,
  source_url: "https://www.sec.gov/example-vt",
};

const ledger: Ledger = {
  rows: [row("c_1", "NVIDIA Corp", 0.0751), row("c_2", "Apple Inc", 0.0659)],
  benchmark: null,
  metrics: {
    hhi: 0.305,
    effective_n: 3.2787,
    top10: 0.9,
    covered_weight_pct: 90.3,
    resolved_weight: 0.903,
    suppressed_weight: 0,
    invested_weight: 0.903,
    cash_weight: 0,
    unallocated_weight: 0,
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
  unmapped: {
    positions: 3126,
    positions_with_weight: 772,
    securities_with_weight: 764,
    securities_weight: 0.0282,
    cash_and_derivatives_with_weight: 8,
    cash_and_derivatives_weight: 0.0148,
  },
};

describe("FreshnessStrip", () => {
  it("prints the filing period, the lag, and the coverage in words", () => {
    render(<FreshnessStrip release={release} ledger={ledger} />);
    expect(screen.getByText(release.as_of)).toBeTruthy();
    expect(screen.getByText("2026-06-30")).toBeTruthy();
    expect(screen.getByText("59 days")).toBeTruthy();
    expect(screen.getByText("90.3%")).toBeTruthy();
    // Coverage is a percentage of invested money, and the cell says so rather than
    // leaving a reader to guess whether cash is in the denominator.
    expect(screen.getByText("90.3%")).toBeTruthy();
    expect(screen.getByText("of the money you have invested")).toBeTruthy();
    // Coverage is money, so its complement is money: 9.7% of the *invested* part —
    // 0.903 × 0.097 = 0.0876 of the portfolio — is not traced. The count of unmapped
    // positions is a disclosure below the table, not a headline number that reads as
    // 3,126 failures.
    expect(screen.getByText("8.76%")).toBeTruthy();
    expect(screen.getByText("of your money, incl. cash and derivatives")).toBeTruthy();
    expect(screen.getByText("each company counted once")).toBeTruthy();
    expect(screen.queryByText(/holdings unmapped/)).toBeNull();
  });

  it("does not claim a date it does not have", () => {
    const empty: Ledger = {
      ...ledger,
      rows: [],
      funds: [],
      oldest_as_of: null,
      max_lag_days: null,
    };
    render(<FreshnessStrip release={release} ledger={empty} />);
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

  it("uses the fund pages' names for the same three numbers", () => {
    // The generated fund pages say "Concentration", "Same-size companies" and
    // "Biggest 10 companies" with a one-line explanation each. Two surfaces
    // showing the same number under two names reads as two different metrics.
    render(<MetricsList ledger={ledger} />);
    expect(screen.getByText("Concentration")).toBeTruthy();
    expect(screen.getByText("Same-size companies")).toBeTruthy();
    expect(screen.getByText("Biggest 10 companies")).toBeTruthy();
    expect(screen.getByText(/0 = spread evenly, 1 = all in one company/)).toBeTruthy();
    expect(
      screen.getByText(/How many equal-sized companies would be spread the same way/),
    ).toBeTruthy();
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

  it("shows every fund a company is attributable to, never a +N more", () => {
    // Five funds, which is where the old table sliced to three and appended
    // "+2 more" — an attribution the row does not show is one it withholds.
    const fiveFunds: LedgerRow = {
      ...row("c_5", "Five Fund Co", 0.05, 5),
      sources: [
        { kind: "fund", ref: "QQQ", weight: 0.02 },
        { kind: "fund", ref: "VTI", weight: 0.01 },
        { kind: "fund", ref: "VTV", weight: 0.008 },
        { kind: "fund", ref: "VEA", weight: 0.007 },
        { kind: "fund", ref: "VWO", weight: 0.005 },
      ],
    };
    const { container } = render(<LedgerTable rows={[fiveFunds]} />);
    expect(container.querySelectorAll(".fund-attrib__item")).toHaveLength(5);
    for (const ticker of ["QQQ", "VTI", "VTV", "VEA", "VWO"]) {
      expect(screen.getByText(ticker)).toBeTruthy();
    }
    expect(screen.queryByText(/\+\d+ more/)).toBeNull();
    expect(container.querySelector("caption")?.textContent).toContain("1 company");
  });

  it("says what it is showing when it is a page of a larger ledger", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} limit={1} />);
    expect(
      screen.getByText(/Showing the top 1 of 2 companies by portfolio weight/),
    ).toBeTruthy();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("shows each company once with its weight and how many funds hold it", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(screen.getByText("NVIDIA Corp")).toBeTruthy();
    // Twice: the weight column, and the fund chip that explains where it came from.
    expect(screen.getAllByText("7.51%")).toHaveLength(2);
    // Weight is a share of the portfolio, and the row note names the source.
    expect(container.querySelector(".row-note")?.textContent).toContain("VOO 7.51%");
  });
});

describe("the benchmark column", () => {
  it("sits beside the portfolio weight and names the fund it compares with", () => {
    // Two quantities, two columns (`static-xray-frontend` §4a): 15% of the
    // visitor's money in NVIDIA, 4.06% of VT's. The benchmark weight is a share
    // of the benchmark's NAV and is never added to, subtracted from, or averaged
    // with the portfolio weight.
    const rows = [
      row("c_1", "NVIDIA Corp", 0.15, 1, 0.0406),
      row("c_2", "Bridgeway Omni Small-Cap Value", 0.02, 1, 0),
    ];
    const { container } = render(<LedgerTable rows={rows} benchmark={vt} />);
    const headers = [...container.querySelectorAll('thead th[scope="col"]')].map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Company", "Portfolio weight", "In VT", "Funds"]);
    // 15.00% twice: the weight column and the fund chip that explains it.
    expect(screen.getAllByText("15.00%")).toHaveLength(2);
    expect(screen.getByText("4.06%")).toBeTruthy();
    // A company the benchmark's traced holdings exclude is a true zero, printed
    // as a zero rather than left blank.
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(container.querySelector("caption")?.textContent).toContain(
      "share of VT's own portfolio",
    );
  });

  it("sorts by the benchmark weight like every other numeric column", () => {
    const rows = [
      row("c_1", "Portfolio Heavy", 0.5, 1, 0),
      row("c_2", "Benchmark Heavy", 0.01, 1, 0.2),
    ];
    const { container } = render(<LedgerTable rows={rows} benchmark={vt} />);
    const sortByBenchmark =
      container.querySelectorAll<HTMLButtonElement>("thead .sort-button")[2];
    expect(sortByBenchmark?.textContent).toContain("In VT");
    if (sortByBenchmark) fireEvent.click(sortByBenchmark);
    const first = container.querySelector("tbody tr th")?.textContent;
    expect(first).toContain("Benchmark Heavy");
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      "In VT",
    );
  });

  it("draws no comparison column when the release publishes no benchmark", () => {
    // Without a benchmark there is nothing to compare against, so the column is
    // absent — a column of zeros would claim the benchmark holds nothing.
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(container.querySelector("caption")?.textContent).not.toContain("In VT");
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
