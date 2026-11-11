/**
 * The one place a typed amount becomes a fraction.
 *
 * A portfolio is entered either as percentages (basis points, summing to exactly
 * 10,000) or as dollars (integer cents, summing to whatever the visitor's amounts
 * add up to). Everything downstream — the ledger, coverage, HHI, the CSV — works in
 * **fractions of the whole portfolio**, because that is what the math skill's
 * `W_k` means. Converting in one place is what stops the two modes from disagreeing
 * about a number the visitor can see (`lookthrough-math-and-qa` §1).
 *
 * Two properties are deliberate:
 *
 * - **Dollars are exact and percentages are not re-scaled.** `$9,000 + $1,000` is
 *   `0.9 + 0.1` with no rounding step; there is no basis-point round trip that could
 *   move a cent between rows.
 * - **Unallocated is refused, not absorbed.** In percentage mode an entry set that
 *   totals 92% is an incomplete portfolio, and the remainder is reported as
 *   `unallocated` so the view can say so. Calling it "cash" would invent a holding
 *   the visitor never entered; spreading it over the others would invent weights.
 */

import {
  CASH_KEY,
  FULL_ALLOCATION_BP,
  type EntryMode,
  type PortfolioEntry,
} from "./types";

/** One entry with its weight as a fraction of the whole portfolio. */
export interface WeightedEntry {
  kind: PortfolioEntry["kind"];
  key: string;
  weight: number;
}

export interface PortfolioSplit {
  /** Fund ticker → fraction. Non-fund entries never appear here. */
  fundWeights: Record<string, number>;
  /** Directly-held symbols, in entry order, each with its own fraction. */
  direct: WeightedEntry[];
  /** Cash as a fraction of the portfolio (0 when the visitor entered none). */
  cash: number;
  /** Funds + direct holdings: the coverage denominator. Cash is excluded. */
  invested: number;
  /**
   * Percentage mode only: the share of 100% that no entry accounts for. Always 0 in
   * dollar mode, where the entries *are* the total.
   */
  unallocated: number;
}

const EMPTY: PortfolioSplit = {
  fundWeights: {},
  direct: [],
  cash: 0,
  invested: 0,
  unallocated: 0,
};

export function splitPortfolio(
  mode: EntryMode,
  entries: PortfolioEntry[],
): PortfolioSplit {
  if (entries.length === 0) return { ...EMPTY, fundWeights: {}, direct: [] };

  if (mode === "usd") {
    // The visitor's own amounts are the total. A zero total is not a portfolio:
    // report nothing rather than divide by zero.
    const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
    if (total <= 0) return { ...EMPTY, fundWeights: {}, direct: [] };
    return accumulate(entries, total, 0);
  }

  // Percentage mode: 10,000 bp is 100%, and anything under it is unallocated. The
  // remainder is divided by the same denominator as the entries, because every
  // quantity this function returns is a fraction of the whole portfolio.
  const used = entries.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
  const unallocated = Math.max(0, FULL_ALLOCATION_BP - used) / FULL_ALLOCATION_BP;
  return accumulate(entries, FULL_ALLOCATION_BP, unallocated);
}

function accumulate(
  entries: PortfolioEntry[],
  denominator: number,
  unallocated: number,
): PortfolioSplit {
  const fundWeights: Record<string, number> = {};
  const direct: WeightedEntry[] = [];
  let cash = 0;
  for (const entry of entries) {
    const weight = Math.max(0, entry.amount) / denominator;
    if (weight === 0) continue;
    switch (entry.kind) {
      case "fund":
        fundWeights[entry.key] = (fundWeights[entry.key] ?? 0) + weight;
        break;
      case "security":
        direct.push({ kind: "security", key: entry.key, weight });
        break;
      case "cash":
        // One cash line is enforced upstream; the sum is written this way so a
        // hand-edited fragment with two cannot double-count silently.
        cash += weight;
        break;
    }
  }
  return {
    fundWeights,
    direct,
    cash,
    invested: 1 - cash - unallocated,
    unallocated,
  };
}

/** Total amount an entry set holds, in its own unit (bp or cents). */
export function totalAmount(mode: EntryMode, entries: PortfolioEntry[]): number {
  const sum = entries.reduce((total, entry) => total + Math.max(0, entry.amount), 0);
  return mode === "bp" ? sum : sum;
}

/**
 * What a percentage-mode amount becomes in dollar mode.
 *
 * A **$10,000 notional**, not the visitor's real balance: switching the toggle must
 * not change the weights, and the only way to keep them while changing units is to
 * pick a total. 1 bp of $10,000 is exactly $1.00 = 100 cents, so the conversion is
 * an integer multiply with no rounding at all.
 */
export const USD_NOTIONAL_CENTS = 1_000_000;

export function bpToCents(bp: number): number {
  return Math.round((bp * USD_NOTIONAL_CENTS) / FULL_ALLOCATION_BP);
}

/**
 * What a dollar amount becomes in percentage mode: its share of the current total.
 *
 * Lossy in the way percentages are — two places — and the caller is expected to
 * have already decided the amounts are worth converting.
 */
export function centsToBp(cents: number, totalCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round((cents * FULL_ALLOCATION_BP) / totalCents);
}

/** Convert every entry of a portfolio when the visitor flips the toggle. */
export function convertMode(
  from: EntryMode,
  to: EntryMode,
  entries: PortfolioEntry[],
): PortfolioEntry[] {
  if (from === to) return entries;
  const total = totalAmount(from, entries);
  return entries.map((entry) => ({
    ...entry,
    amount: to === "usd" ? bpToCents(entry.amount) : centsToBp(entry.amount, total),
  }));
}

/** Equal split of the whole portfolio across `entries`, as integers summing to 10,000. */
export function equalise(entries: PortfolioEntry[]): PortfolioEntry[] {
  if (entries.length === 0) return [];
  const base = Math.floor(FULL_ALLOCATION_BP / entries.length);
  const remainder = FULL_ALLOCATION_BP - base * entries.length;
  return entries.map((entry, index) => ({
    ...entry,
    amount: base + (index < remainder ? 1 : 0),
  }));
}

/**
 * Whether the amounts are still exactly the split the app itself produced.
 *
 * The builder has one automatic behaviour: a portfolio it started (empty, or the even
 * split every first row receives) keeps following its own count. This is how a set of
 * amounts is recognised as still being in that state — `equalise` totals 10,000 by
 * construction, so a set that matches it is both evenly spread *and* whole.
 *
 * A total of exactly 100% is **not** the test. `60/40` is whole, was typed by the
 * visitor, and must survive the next added row untouched; re-splitting it is the
 * "adding a fund resets my portfolio" complaint of 2026-11-02. Requiring both
 * conditions also keeps `25/25` (even, but short) out: re-splitting that would move
 * two rows in order to fund a third.
 */
export function isEqualSplit(entries: PortfolioEntry[]): boolean {
  if (entries.length === 0) return false;
  const even = equalise(entries);
  // Same length by construction (`equalise` maps one entry to one entry), so the
  // index is always in range; read through a guard so a future caller passing a
  // different shape fails a test rather than crashing on `undefined.amount`.
  return entries.every((entry, index) => entry.amount === (even[index]?.amount ?? -1));
}

/**
 * Whether this entry set still follows the app's own even split, in a mode that has one.
 *
 * The one predicate behind the builder's single automatic behaviour, so `add` and
 * `remove` cannot disagree about when the app may move a number the visitor sees: a list
 * the app itself spread keeps following its own count, and a list weighted by hand is
 * never touched. Dollar mode has no even split to follow — those amounts are the
 * visitor's money, each already its own share of the total, so nothing may re-spread
 * them. `add` keeps its extra "empty list" case, because an empty portfolio has no
 * predicate to satisfy; `remove` has nothing to remove from one.
 */
export function followsEvenSplit(mode: EntryMode, entries: PortfolioEntry[]): boolean {
  return mode === "bp" && isEqualSplit(entries);
}

/** The label a key carries in the UI: cash is a word, not a symbol. */
export function entryLabel(entry: { kind: PortfolioEntry["kind"]; key: string }): string {
  return entry.kind === "cash" || entry.key === CASH_KEY ? "Cash" : entry.key;
}
