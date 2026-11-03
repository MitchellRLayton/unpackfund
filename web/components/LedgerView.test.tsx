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
import { withEffective } from "../lib/testing/ledger";

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
  // No country object in these fixtures: the release answers no domicile, which is a
  // valid release and leaves the ledger's shape untouched.
  useCountries: () => ({ status: "ready", data: {}, error: null }),
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
    country: null,
    holder_count: 1,
    held_directly: false,
    sources: [{ kind: "fund", ref: "VOO", weight }],
  };
}

const ledgerBase: Omit<Ledger, "effective"> = {
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
const ledger = withEffective(ledgerBase);

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
    overBp: 0,
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
    // The bracket is explained twice, in the two places a reader meets it: the
    // table's caption (announced with the table) and the paragraph above it. Both
    // state which way round the subtraction is, so the sign cannot be guessed wrong.
    const caption = document.querySelector("table caption")?.textContent ?? "";
    expect(caption).toContain("your weight minus VT's, in percentage points");
    expect(screen.getByText(/it is not a share of your portfolio/)).toBeTruthy();
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

describe("the page's information architecture", () => {
  /**
   * The operator's complaint (2026-11-02) was about order, not about content: "too much
   * information at the top of the page discussing methodologies … all I really want are
   * the metadata information you give in tables". The page was answering the question in
   * the right way and in the wrong order — a reader met the benchmark's provenance rules
   * before the column they explain, and had to scroll past them to reach the ledger.
   *
   * The fix is one disclosure under the table, not a deletion: every sentence is still
   * on the page, one click below the numbers. This test holds both halves, because each
   * can regress on its own — a later edit could drift the explanation back above the
   * table (cheap to do by accident, invisible in a diff of one hunk) or could quiet-delete
   * a paragraph while tidying (the failure mode a "move the prose" instruction invites).
   */
  it("puts one paragraph of prose on the first screen and the method under the table", () => {
    useRelease.mockReturnValue({
      status: "ready",
      data: releaseWithBenchmark,
      error: null,
    });
    useFunds.mockImplementation(() => ({ funds: [], pending: [], error: null }));
    useBenchmark.mockReturnValue({ status: "ready", data: vtRollup, error: null });
    // Cash and an unallocated remainder, so every paragraph that used to sit above the
    // table exists in this fixture: before the change the page rendered three of them
    // (the count line, the cash line, and the benchmark's long explanation), and this test
    // failed with "expected 3 to be 1" before the move.
    useLedger.mockImplementation((_funds, _weights, _direct, _cash, benchmark) => ({
      ledger: {
        ...withBenchmarkWeights(benchmark),
        metrics: { ...ledger.metrics, cash_weight: 0.032, unallocated_weight: 0.011 },
      },
      error: null,
      mode: "main",
      durationMs: 3,
    }));

    const { container } = render(<LedgerView />);
    const table = container.querySelector("table.ledger");
    expect(table).not.toBeNull();

    // A "prose block" here is a paragraph a reader *reads* — so the count leaves out the
    // three things above the table that are not prose: the metadata tables the operator
    // asked for (the strip's cells and the metrics list, whose notes are part of the
    // table), the notices (which say what happened to *this* portfolio rather than how
    // the page is built), and the two controls that happen to be paragraphs — the CSV
    // row and the screen-reader-only status line.
    const prose = [...container.querySelectorAll("p")].filter(
      (paragraph) =>
        (table!.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_PRECEDING) !==
          0 &&
        paragraph.closest(".notice, .strip, .metrics") === null &&
        !paragraph.classList.contains("sr-only") &&
        !paragraph.classList.contains("table-more"),
    );
    expect(prose).toHaveLength(1);
    expect(prose[0]?.textContent).toContain(
      "Every weight is a share of the whole portfolio",
    );

    // The one disclosure sits after the table, and it is the page's only method block.
    const method = container.querySelector("details");
    expect(method?.firstElementChild?.tagName).toBe("SUMMARY");
    expect(method?.firstElementChild?.textContent).toBe("How to read this page");
    expect(
      table!.compareDocumentPosition(method!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    // Everything the first screen used to carry is in it, tightened rather than dropped:
    // the benchmark column (what it is, the 0.00% case, the bracket, the rounding), the
    // cash sentence, the coverage gap, the per-fund source table, and the N-PORT note.
    expect(method?.textContent).toContain("it is not a share of your portfolio");
    expect(method?.textContent).toContain("filed at under 0.01%");
    expect(method?.textContent).toContain("Cash is 3.20% of your money");
    expect(method?.textContent).toContain("1.10% is unallocated");
    expect(method?.textContent).toContain("What is not traced, and why");
    expect(method?.textContent).toContain("Where each number comes from");
    expect(method?.textContent).toContain("Weights come from Form N-PORT, as filed");

    // The benchmark explanation is not *also* above the table: the element that carries
    // it is the one inside the disclosure, so the two copies cannot drift apart.
    expect(screen.getByText(/filed at under 0\.01%/).closest("details")).toBe(method);
  });
});

describe("the ledger when the percentages do not add up", () => {
  /** The page's own branch: no table, one sentence, and the reason in words. */
  function incomplete(total: number) {
    // The hooks above the branch still run, so they need answers even though this
    // path computes nothing from them.
    useFunds.mockReturnValue({ funds: [], pending: [], error: null });
    useRelease.mockReturnValue({ status: "ready", data: release, error: null });
    useLedger.mockReturnValue({ ledger, error: null, mode: "main", durationMs: 3 });
    usePortfolio.mockReturnValue({
      entries: [{ kind: "fund", key: "VOO", amount: total }],
      mode: "bp",
      ready: true,
      problem: null,
      total,
      complete: false,
      unallocatedBp: Math.max(0, 10_000 - total),
      overBp: Math.max(0, total - 10_000),
      add: () => {},
      remove: () => {},
      setAmount: () => {},
      equalise: () => {},
      clear: () => {},
      setMode: () => {},
      replace: () => {},
    });
    render(<LedgerView />);
  }

  it("says a portfolio past 100% is over, and computes nothing from it", () => {
    // Reachable by a hand-typed link: the builder's own link is inert until the
    // total is exactly 100%, but the ledger still has to answer for what it is given.
    incomplete(10_500);
    expect(screen.getByText(/do not add up to 100%/)).toBeTruthy();
    expect(screen.getByText(/5\.00% over/, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // "Not treated as cash" is a sentence about a remainder, which an over-100
    // portfolio does not have.
    expect(screen.queryByText(/not treated as cash/)).toBeNull();
  });

  it("calls a short portfolio short, and keeps the unallocated sentence", () => {
    incomplete(9_700);
    expect(
      screen.getByText(/3\.00% short of the full value of your holdings/),
    ).toBeTruthy();
    expect(screen.getByText(/not treated as cash/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
