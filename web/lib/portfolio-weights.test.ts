import { describe, expect, it } from "vitest";

import { buildLedger } from "./aggregate";
import {
  bpToCents,
  centsToBp,
  convertMode,
  entryLabel,
  equalise,
  splitPortfolio,
  USD_NOTIONAL_CENTS,
} from "./portfolio-weights";
import type { FundDocument, PortfolioEntry } from "./types";

/**
 * The fixtures here are the mode-aware ones from
 * `docs/01-research/2026-11-01-direct-holdings-math-draft.md` (FIX-9 … FIX-12 and
 * invariants INV-1 … INV-3), worked out by hand. They exist because the two modes
 * must agree about the portfolio when they describe the same split: a `%` entry set
 * and a `$` entry set that mean the same thing have to produce one identical ledger.
 */

const entry = (
  kind: PortfolioEntry["kind"],
  key: string,
  amount: number,
): PortfolioEntry => ({ kind, key, amount });

function fund(ticker: string, holdings: [string, number][]): FundDocument {
  return {
    schema_version: 1,
    ticker,
    fund_id: `S${ticker}`,
    name: `${ticker} Fund`,
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${ticker}`,
    coverage_pct: 100,
    holdings: holdings.map(([company_id, weight_bp]) => ({
      company_id,
      name: `Company ${company_id}`,
      ticker: null,
      asset_cat: "equity" as const,
      weight_bp,
    })),
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const voo = fund("VOO", [
  ["c_a", 5000],
  ["c_b", 3000],
  ["c_c", 2000],
]);
const qqq = fund("QQQ", [
  ["c_a", 4000],
  ["c_d", 6000],
]);

function ledgerFor(entries: PortfolioEntry[], mode: "bp" | "usd") {
  const split = splitPortfolio(mode, entries);
  return {
    split,
    ledger: buildLedger({ funds: [voo, qqq], weights: split.fundWeights }),
  };
}

describe("splitPortfolio", () => {
  it("turns basis points into fractions of the whole portfolio", () => {
    const split = splitPortfolio("bp", [
      entry("fund", "VOO", 5994),
      entry("fund", "QQQ", 4006),
    ]);
    expect(split.fundWeights.VOO).toBeCloseTo(0.5994, 12);
    expect(split.fundWeights.QQQ).toBeCloseTo(0.4006, 12);
    expect(split.invested).toBeCloseTo(1, 12);
    expect(split.unallocated).toBe(0);
    expect(split.cash).toBe(0);
  });

  it("turns cents into fractions of their own total, with no 100% rule", () => {
    const split = splitPortfolio("usd", [
      entry("fund", "VOO", 599_400),
      entry("fund", "QQQ", 400_600),
    ]);
    expect(split.fundWeights.VOO).toBeCloseTo(0.5994, 12);
    expect(split.fundWeights.QQQ).toBeCloseTo(0.4006, 12);
    expect(split.unallocated).toBe(0);
  });

  it("reports an unallocated remainder in percent mode, never as cash", () => {
    // 60% allocated: the remaining 40% is unallocated, and no cash entry exists.
    const split = splitPortfolio("bp", [
      entry("fund", "VOO", 3000),
      entry("fund", "QQQ", 3000),
    ]);
    expect(split.unallocated).toBeCloseTo(0.4, 12);
    expect(split.cash).toBe(0);
    expect(split.invested).toBeCloseTo(0.6, 12);
  });

  it("has no unallocated remainder in dollar mode", () => {
    const split = splitPortfolio("usd", [
      entry("fund", "VOO", 500_000),
      entry("fund", "QQQ", 500_000),
    ]);
    expect(split.unallocated).toBe(0);
    expect(split.invested).toBeCloseTo(1, 12);
  });

  it("keeps one cash line out of the fund weights and out of coverage", () => {
    const split = splitPortfolio("bp", [
      entry("fund", "VOO", 5000),
      entry("cash", "CASH", 5000),
    ]);
    expect(split.cash).toBeCloseTo(0.5, 12);
    expect(split.invested).toBeCloseTo(0.5, 12);
    expect(split.fundWeights).toEqual({ VOO: 0.5 });
  });

  it("returns nothing at all for an empty or zero-dollar portfolio", () => {
    expect(splitPortfolio("bp", [])).toEqual({
      fundWeights: {},
      direct: [],
      cash: 0,
      invested: 0,
      unallocated: 0,
    });
    const zero = splitPortfolio("usd", [entry("fund", "VOO", 0)]);
    expect(zero.fundWeights).toEqual({});
    expect(zero.invested).toBe(0);
  });
});

describe("the two modes agree when they describe the same split", () => {
  it("produces one identical ledger for 59.94% / 40.06% in either unit", () => {
    const percent = ledgerFor(
      [entry("fund", "VOO", 5994), entry("fund", "QQQ", 4006)],
      "bp",
    );
    const dollars = ledgerFor(
      [entry("fund", "VOO", 599_400), entry("fund", "QQQ", 400_600)],
      "usd",
    );
    expect(dollars.ledger.rows).toEqual(percent.ledger.rows);
    expect(dollars.ledger.metrics).toEqual(percent.ledger.metrics);
  });

  it("separates 60/40 from $6,000 / $4,000.50 — those are different portfolios", () => {
    const sixtyForty = ledgerFor(
      [entry("fund", "VOO", 6000), entry("fund", "QQQ", 4000)],
      "bp",
    );
    const oddCents = ledgerFor(
      [entry("fund", "VOO", 600_000), entry("fund", "QQQ", 400_050)],
      "usd",
    );
    // The odd cents make VOO 59.9970…% rather than 60%, and the ledger shows it:
    // c_b is 30% of VOO, so 0.5999700 × 0.30 = 0.179991 against a clean 0.18.
    const odd = oddCents.ledger.rows.find((row) => row.company_id === "c_b");
    const plain = sixtyForty.ledger.rows.find((row) => row.company_id === "c_b");
    expect(odd?.weight).toBeCloseTo(0.179991, 6);
    expect(plain?.weight).toBeCloseTo(0.18, 6);
    expect(odd?.weight).not.toBeCloseTo(plain?.weight ?? 0, 6);
  });
});

describe("mode conversion", () => {
  it("maps one percent to exactly one dollar of a $10,000 portfolio", () => {
    expect(USD_NOTIONAL_CENTS).toBe(1_000_000);
    expect(bpToCents(1)).toBe(100);
    expect(bpToCents(5994)).toBe(599_400);
    expect(bpToCents(10_000)).toBe(1_000_000);
  });

  it("rounds a dollar amount back into basis points", () => {
    expect(centsToBp(599_400, 1_000_000)).toBe(5994);
    expect(centsToBp(400_050, 1_000_450)).toBe(3999);
    expect(centsToBp(100, 0)).toBe(0);
  });

  it("keeps the split when the toggle is flipped, and reverses it exactly", () => {
    const percent = [
      entry("fund", "VOO", 7000),
      entry("security", "AMZN", 2000),
      entry("cash", "CASH", 1000),
    ];
    const dollars = convertMode("bp", "usd", percent);
    expect(dollars.map((item) => item.amount)).toEqual([700_000, 200_000, 100_000]);
    // $10,000 notional divides back exactly, so a round trip is lossless.
    expect(convertMode("usd", "bp", dollars)).toEqual(percent);
  });

  it("leaves a dollar portfolio's split intact when converting to percent", () => {
    const dollars = [entry("fund", "VOO", 333_333), entry("fund", "QQQ", 666_667)];
    const percent = convertMode("usd", "bp", dollars);
    expect(percent.map((item) => item.amount)).toEqual([3333, 6667]);
    expect(percent.reduce((sum, item) => sum + item.amount, 0)).toBe(10_000);
  });
});

describe("small helpers", () => {
  it("splits equally into integers that total 100%", () => {
    const equal = equalise([
      entry("fund", "AAA", 0),
      entry("fund", "BBB", 0),
      entry("security", "CCC", 0),
    ]);
    expect(equal.map((item) => item.amount)).toEqual([3334, 3333, 3333]);
  });

  it("labels cash as a word and everything else by its key", () => {
    expect(entryLabel({ kind: "cash", key: "CASH" })).toBe("Cash");
    expect(entryLabel({ kind: "fund", key: "VT" })).toBe("VT");
    expect(entryLabel({ kind: "security", key: "AMZN" })).toBe("AMZN");
  });
});
