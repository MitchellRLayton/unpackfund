/**
 * What the result of a comparison is, before it is laid out.
 *
 * The overlap number itself is never computed here: it comes from `buildOverlap`
 * and is printed exactly as that function returns it. What this module owns is the
 * three things a reader needs beside the number — which funds could not be fully
 * compared, how each mix splits across markets, and which companies belong to
 * which of the answer's three lists — plus the fixed sentences that say so.
 *
 * Sentence templates live here rather than in the components for one reason: the
 * wording is part of the answer ("below the 60% coverage floor" is a fact about the
 * data, not a turn of phrase), and a template with a number in it can be tested.
 */

import { DEFAULT_PROVIDER, tierOf, type Provider } from "@/lib/country-tier";
import { coverageBand, formatCoveragePct, formatWeightBp } from "@/lib/format";
import type { Tally } from "@/lib/holdings";
import type { LedgerRow } from "@/lib/types";
import type { OverlapRow } from "@/lib/overlap";

export type Side = "a" | "b";

/** A fund whose coverage keeps the overlap from being stated with confidence. */
export interface FundGap {
  ticker: string;
  coveragePct: number;
  /** The sides the fund is on, so the sentence can say where it came from. */
  sides: Side[];
}

export interface CoverageGap {
  /** Below the 60% floor: the fund's weights are withheld, so the answer is too. */
  suppressed: FundGap[];
  /** 60–70%: the weights are shown, and the answer says they are partial. */
  partial: FundGap[];
}

/**
 * The funds on either side that are not fully traced to companies, lowest first.
 *
 * Bands come from `format.coverageBand` — 70 and 60, not numbers of this module's
 * own — so a fund is in the same band on this page as on its own. A fund held by
 * both sides appears once, with both sides recorded: the answer should name the
 * fund once and say it is in both mixes, not list it twice.
 */
export function coverageGap(
  a: readonly { ticker: string; coverage_pct: number }[],
  b: readonly { ticker: string; coverage_pct: number }[],
): CoverageGap {
  const seen = new Map<string, FundGap>();
  const visit = (
    funds: readonly { ticker: string; coverage_pct: number }[],
    side: Side,
  ) => {
    for (const fund of funds) {
      if (coverageBand(fund.coverage_pct) === "full") continue;
      const existing = seen.get(fund.ticker);
      if (existing) {
        if (!existing.sides.includes(side)) existing.sides.push(side);
        continue;
      }
      seen.set(fund.ticker, {
        ticker: fund.ticker,
        coveragePct: fund.coverage_pct,
        sides: [side],
      });
    }
  };
  visit(a, "a");
  visit(b, "b");

  const all = [...seen.values()].sort(
    (x, y) => x.coveragePct - y.coveragePct || (x.ticker < y.ticker ? -1 : 1),
  );
  return {
    suppressed: all.filter((fund) => coverageBand(fund.coveragePct) === "none"),
    partial: all.filter((fund) => coverageBand(fund.coveragePct) === "partial"),
  };
}

/** `"Mix A" | "Mix B" | "both mixes"` — where a fund sits, in words. */
function whereOf(fund: FundGap): string {
  if (fund.sides.length > 1) return "both mixes";
  return fund.sides[0] === "a" ? "Mix A" : "Mix B";
}

function eachFund(funds: readonly FundGap[]): string {
  return joinWithAnd(
    funds.map(
      (fund) =>
        `${fund.ticker} in ${whereOf(fund)} (${formatCoveragePct(fund.coveragePct)} traced to companies)`,
    ),
  );
}

/**
 * The sentence that replaces the overlap when a fund's coverage withholds it.
 *
 * The rule this encodes: below 60% of a fund's weight traced to companies, the
 * fund's weights are suppressed everywhere else on the site, and printing an
 * overlap computed on the traced remainder would describe a different mix. So the
 * number is not printed small, it is not printed at all — and the funds that caused
 * that are named, in the answer, not in a footnote below it.
 */
export function describeUncomparable(funds: readonly FundGap[]): string {
  const verb = funds.length === 1 ? "sits" : "sit";
  return `${eachFund(funds)} ${verb} below the 60% coverage floor, so the share the two mixes hold in the same companies cannot be stated.`;
}

/** The same sentence's softer form: the weights are shown, and marked partial. */
export function describePartial(funds: readonly FundGap[]): string {
  return `Partly traced: ${eachFund(funds)}. Only the traced part of those funds can appear on either side, so this share is a floor as well as a figure.`;
}

/** English list joining: "A", "A and B", "A, B and C". */
export function joinWithAnd(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/**
 * "Mix A totals 88.00%." for whichever sides are short of a whole.
 *
 * `tallyOf`'s own sentence is the per-side one ("12.00% unallocated"), which is
 * right in the column. This is the sentence that explains why the comparison has
 * no answer yet, and it has to name the side.
 */
export function mixTotals(parts: readonly { label: string; tally: Tally }[]): string {
  const phrases = parts.map(
    ({ label, tally }) => `${label} totals ${formatWeightBp(tally.total)}`,
  );
  return `${joinWithAnd(phrases)}.`;
}

/** The four market tiers, as fractions of one mix. `unplaced` is the remainder. */
export interface MarketSplit {
  us: number;
  dm: number;
  em: number;
  unplaced: number;
}

/**
 * Where one mix sits by market, on the ledger's own weights.
 *
 * `unplaced` is every weight that is not in one of the three published tiers: a
 * company in a domicile the classification does not list (offshore holding
 * companies, frontier markets) and weight no company could be found for at all.
 * The two are one bar segment because the reader's question is "how much of this
 * mix can I place", and both answers are "not in a market I can name". It is the
 * remainder rather than a fourth sum, so the four segments always close at 100%
 * and a rounding difference can never leave a sliver of the bar empty.
 */
export function marketSplit(
  rows: readonly { company_id: string; weight: number }[],
  countries: Record<string, string> | null,
  provider: Provider = DEFAULT_PROVIDER,
): MarketSplit {
  let us = 0;
  let dm = 0;
  let em = 0;
  for (const row of rows) {
    const tier = tierOf(countries ? countries[row.company_id] : null, { provider });
    if (tier === "US") us += row.weight;
    else if (tier === "DM") dm += row.weight;
    else if (tier === "EM") em += row.weight;
  }
  return { us, dm, em, unplaced: Math.max(0, 1 - (us + dm + em)) };
}

/**
 * The companies both mixes hold, largest shared weight first.
 *
 * Shared means both weights are above zero: the row's `min(wA, wB)` is the share
 * both mixes hold in that company, and those minima are what the overlap sentence
 * adds up. A company one side holds at 0 basis points is not shared, so the three
 * tabs are a partition of the rows — no company can be counted twice on screen.
 */
export function sharedRows(rows: readonly OverlapRow[]): OverlapRow[] {
  return rows
    .filter((row) => row.weightA > 0 && row.weightB > 0)
    .sort(
      (x, y) =>
        Math.min(y.weightA, y.weightB) - Math.min(x.weightA, x.weightB) ||
        (x.company_id < y.company_id ? -1 : 1),
    );
}

/** The companies only one mix holds, largest weight on that side first. */
export function onlyRows(rows: readonly OverlapRow[], side: Side): OverlapRow[] {
  return rows
    .filter((row) =>
      side === "a"
        ? row.weightA > 0 && row.weightB === 0
        : row.weightB > 0 && row.weightA === 0,
    )
    .sort((x, y) => {
      const byWeight = side === "a" ? y.weightA - x.weightA : y.weightB - x.weightB;
      return byWeight || (x.company_id < y.company_id ? -1 : 1);
    });
}

/**
 * Company id → the fund tickers holding it, largest contribution first.
 *
 * The comparison is funds-only, so every source is a fund; the filter is there so
 * the function stays correct if a direct position ever reaches it. This is the
 * answer to "which of my funds is this company coming from", which is the question
 * the shared table exists to answer beyond the number.
 */
export function sourceTickers(rows: readonly LedgerRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const tickers = row.sources
      .filter((source) => source.kind === "fund")
      .sort((x, y) => y.weight - x.weight || (x.ref < y.ref ? -1 : 1))
      .map((source) => source.ref);
    if (tickers.length > 0) map.set(row.company_id, [...new Set(tickers)]);
  }
  return map;
}
