import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BenchmarkFacts,
  BenchmarkRollup,
  FundDocument,
  Ledger,
  LedgerRow,
  ReleaseDescriptor,
} from "@/lib/types";

/**
 * `/x` end to end at the seams the page owns: the *shape* of the table depends on
 * whether the benchmark arrived, and a benchmark that fails must not hold the page
 * hostage. That bug shipped once — `useFunds().pending` lists every ticker that has
 * not loaded, so a 404 on `funds/VT.json` stayed "pending" forever and the loading
 * branch rendered instead of the column-less table. These tests pin both directions.
 */

const usePortfolio = vi.fn();
const useRelease = vi.fn();
const useFunds = vi.fn();
const useBenchmark = vi.fn();
const useLedger = vi.fn();

vi.mock("@/lib/use-portfolio", () => ({ usePortfolio: () => usePortfolio() }));
vi.mock("@/lib/use-release", () => ({
  useRelease: () => useRelease(),
  useFunds: (...args: unknown[]) => useFunds(...args),
  useBenchmark: (...args: unknown[]) => useBenchmark(...args),
  // The drawer is closed in these tests; it still calls its hook.
  useCompany: () => ({ status: "loading", data: null, error: null }),
}));
vi.mock("@/lib/use-ledger", () => ({
  useLedger: (...args: unknown[]) => useLedger(...args),
}));

const { LedgerView } = await import("@/components/LedgerView");

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

const vtFacts: BenchmarkFacts = {
  ticker: "VT",
  name: "VANGUARD TOTAL WORLD STOCK INDEX FUND",
  as_of: "2026-07-31",
  filed_at: "2026-09-28",
  lag_days: 59,
  coverage_pct: 97.8,
  source_url: "https://www.sec.gov/example-vt",
};

/** A real document, so the page rolls it up with the shipped code rather than a stub. */
/** The compact object the release now publishes for VT (ADR-0015 §7). */
const vtRollup: BenchmarkRollup = {
  schema_version: 1,
  kind: "benchmark",
  ticker: "VT",
  fund_id: "S000022482",
  name: vtFacts.name,
  as_of: vtFacts.as_of,
  filed_at: vtFacts.filed_at,
  lag_days: vtFacts.lag_days,
  coverage_pct: vtFacts.coverage_pct,
  source_url: vtFacts.source_url,
  weights: { c_nvda: 406, c_aapl: 387 },
};

/** The same release, with the compact family a build since this change publishes. */
const releaseWithBenchmark: ReleaseDescriptor = {
  ...release,
  objects: {
    ...release.objects,
    benchmarks: {
      prefix: "benchmarks/",
      files: {
        VT: { path: "benchmarks/VT.json", bytes: 320, sha256: "e".repeat(64) },
      },
    },
  },
};

const vtDocument: FundDocument = {
  schema_version: 1,
  ticker: "VT",
  fund_id: "S000022482",
  name: vtFacts.name,
  issuer: "VANGUARD INTERNATIONAL EQUITY INDEX FUNDS",
  as_of: vtFacts.as_of,
  filed_at: vtFacts.filed_at,
  lag_days: vtFacts.lag_days,
  source: "nport",
  source_url: vtFacts.source_url,
  coverage_pct: vtFacts.coverage_pct,
  holdings: [
    {
      company_id: "c_nvda",
      name: "NVIDIA Corp",
      ticker: "NVDA",
      asset_cat: "equity",
      weight_bp: 406,
    },
    {
      company_id: "c_aapl",
      name: "Apple Inc",
      ticker: "AAPL",
      asset_cat: "equity",
      weight_bp: 387,
    },
    // Filed, but rounded below one basis point — the case the caption must not call
    // "not traced".
    {
      company_id: "c_matx",
      name: "Matson Inc",
      ticker: "MATX",
      asset_cat: "equity",
      weight_bp: 0,
    },
    {
      company_id: null,
      name: "Some untraced line",
      ticker: null,
      asset_cat: "equity",
      weight_bp: 220,
    },
  ],
  metrics: { hhi: 0.005, hhi_pct2: 0.005, effective_n: 200, top10_pct: 0.18 },
  warnings: [],
};

function ledgerRow(company_id: string, name: string, weight: number): LedgerRow {
  return {
    company_id,
    name,
    ticker: name.slice(0, 4).toUpperCase(),
    weight,
    benchmark_weight: null,
    holder_count: 1,
    held_directly: false,
    sources: [{ kind: "fund", ref: "VOO", weight }],
  };
}

const ledger: Ledger = {
  rows: [
    ledgerRow("c_nvda", "NVIDIA Corp", 0.0751),
    ledgerRow("c_matx", "Matson Inc", 0.0021),
  ],
  benchmark: null,
  metrics: {
    hhi: 0.305,
    effective_n: 3.2787,
    top10: 0.9,
    covered_weight_pct: 90.3,
    resolved_weight: 0.903,
    suppressed_weight: 0,
    invested_weight: 1,
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

beforeEach(() => {
  // Calls accumulate across tests otherwise, and one of the assertions below is
  // about a call that must *not* happen.
  useFunds.mockReset();
  useBenchmark.mockReset();
  useLedger.mockReset();
  usePortfolio.mockReturnValue({
    entries: [{ kind: "fund", key: "VOO", amount: 10_000 }],
    mode: "bp",
    ready: true,
    problem: null,
    total: 10_000,
    complete: true,
    unallocatedBp: 0,
    add: () => {},
    remove: () => {},
    setAmount: () => {},
    equalise: () => {},
    clear: () => {},
    setMode: () => {},
    replace: () => {},
  });
  useRelease.mockReturnValue({ status: "ready", data: release, error: null });
  // The default release below predates the compact object, so its benchmark comes
  // from the fund document; `releaseWithBenchmark` is the newer shape.
  useBenchmark.mockReturnValue({ status: "loading", data: null, error: null });
});

/** The ledger the page would build, given whichever benchmark source answered. */
function withBenchmarkWeights(
  benchmark: { weights: Record<string, number> } | null,
): Ledger {
  return {
    ...ledger,
    rows: ledger.rows.map((row) => ({
      ...row,
      benchmark_weight:
        benchmark === null ? null : (benchmark.weights[row.company_id] ?? 0),
    })),
    benchmark: vtFacts,
  };
}

describe("the ledger when the benchmark cannot be read", () => {
  it("renders the portfolio table instead of waiting for it forever", () => {
    // The failure state: no VT document, the ticker still listed as pending.
    useFunds.mockImplementation((_data: unknown, tickers: string[]) =>
      tickers.includes("VT")
        ? { funds: [], pending: ["VT"], error: { message: "not found", detail: "404" } }
        : { funds: [], pending: [], error: null },
    );
    useLedger.mockReturnValue({
      ledger,
      error: null,
      mode: "main",
      durationMs: 3,
    });

    render(<LedgerView />);

    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect(screen.getByText(/No benchmark comparison on this page/)).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /In VT/ })).toBeNull();
  });

  it("reads the compact rollup when the release pre-rolled one", () => {
    // The normal path since ADR-0015 §7: one 43 kB object instead of VT's 1.58 MB
    // fund document, which is the whole reason the object exists.
    useRelease.mockReturnValue({
      status: "ready",
      data: releaseWithBenchmark,
      error: null,
    });
    useFunds.mockImplementation(() => ({ funds: [], pending: [], error: null }));
    useBenchmark.mockReturnValue({ status: "ready", data: vtRollup, error: null });
    useLedger.mockImplementation((_funds, _weights, _direct, _cash, benchmark) => ({
      ledger: withBenchmarkWeights(benchmark),
      error: null,
      mode: "main",
      durationMs: 3,
    }));

    render(<LedgerView />);

    expect(useBenchmark).toHaveBeenCalledWith(expect.anything(), "VT");
    // VT's fund document is never requested: no fallback fetch happens behind the
    // compact one, which is what keeps the saving real.
    expect(
      useFunds.mock.calls.some(([, tickers]) => (tickers as string[]).includes("VT")),
    ).toBe(false);
    expect(screen.getByRole("columnheader", { name: /In VT/ })).toBeTruthy();
    expect(screen.getByText("4.06%")).toBeTruthy();
  });

  it("falls back to the fund document on a release that has no compact object", () => {
    // The older release, which is what the live site reads until the next one is
    // published: same column, one much larger fetch.
    useFunds.mockImplementation((_data: unknown, tickers: string[]) =>
      tickers.includes("VT")
        ? { funds: [vtDocument], pending: [], error: null }
        : { funds: [], pending: [], error: null },
    );
    useLedger.mockImplementation((_funds, _weights, _direct, _cash, benchmark) => ({
      ledger: withBenchmarkWeights(benchmark),
      error: null,
      mode: "main",
      durationMs: 3,
    }));

    render(<LedgerView />);

    expect(useBenchmark).toHaveBeenCalledWith(expect.anything(), null);
    expect(screen.getByRole("columnheader", { name: /In VT/ })).toBeTruthy();
    expect(screen.getByText("4.06%")).toBeTruthy();
    // The zero the caption must not call "not traced": Matson is a filed VT row
    // rounded to nothing, not a missing company.
    expect(screen.getByText(/filed at under 0\.01%/)).toBeTruthy();
    expect(screen.getByText(/of its gross\s+weight to companies/)).toBeTruthy();
  });

  it("waits for the compact object rather than reflowing the table", () => {
    useRelease.mockReturnValue({
      status: "ready",
      data: releaseWithBenchmark,
      error: null,
    });
    useFunds.mockImplementation(() => ({ funds: [], pending: [], error: null }));
    useBenchmark.mockReturnValue({ status: "loading", data: null, error: null });
    useLedger.mockReturnValue({ ledger, error: null, mode: "main", durationMs: 3 });

    render(<LedgerView />);

    expect(screen.getByRole("status").textContent).toContain("VT");
    expect(screen.queryByRole("columnheader", { name: /In VT/ })).toBeNull();
  });

  it("drops the column when the compact object fails, like any other benchmark failure", () => {
    useRelease.mockReturnValue({
      status: "ready",
      data: releaseWithBenchmark,
      error: null,
    });
    useFunds.mockImplementation(() => ({ funds: [], pending: [], error: null }));
    useBenchmark.mockReturnValue({
      status: "error",
      data: null,
      error: { message: "hash mismatch", detail: "e".repeat(12), kind: "hash" },
    });
    useLedger.mockReturnValue({ ledger, error: null, mode: "main", durationMs: 3 });

    render(<LedgerView />);

    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.getByText(/No benchmark comparison on this page/)).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /In VT/ })).toBeNull();
  });
});
