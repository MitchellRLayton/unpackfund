/**
 * The lenses' CSV files.
 *
 * Rules are `lib/export.ts`'s, because a file and a page that disagree about a
 * number are two answers:
 * - **a number leaves with what it came from**: every row repeats `release_as_of`;
 * - **rounding is the page's**: two decimals for a weight (`formatShare`), one for
 *   coverage (`formatCoveragePct`), so the file never claims precision the page
 *   does not;
 * - **a cell that is not a number is empty**, never a zero standing in for "not
 *   known" — a zero in a spreadsheet is indistinguishable from a measurement.
 *
 * The builders return strings and touch nothing: the download itself is
 * `@/lib/export`'s `saveCsv`, and it happens in the page, where the numbers already
 * are (`lib/export.ts` explains why that matters).
 */

import { DEFAULT_BENCHMARK, benchmarkDelta } from "@/lib/benchmark";
import type { EffectiveHoldings } from "@/lib/effective-holdings";
import type { CoverageBand } from "@/lib/format";
import { coverageBand } from "@/lib/format";

import { bucketWord, TIER_WORD } from "./lens-math";
import type { FundMixRow, MarketSplit, PairState, UntracedTotals } from "./lens-math";
import type { Ledger, LedgerSource, UnmappedBreakdown } from "@/lib/types";

/** RFC 4180: quote when the value contains a delimiter, a quote, or a newline. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line. The builders join them with `\n` and end the file with one. */
export function csvLine(values: Array<string | number | null | undefined>): string {
  return values.map(cell).join(",");
}

/** A fraction as the page prints a weight: `0.0123` → `1.23`. */
function share(fraction: number): string {
  return (fraction * 100).toFixed(2);
}

/** A percentage that is already a percentage, at the page's coverage precision. */
function coverage(pct: number): string {
  return pct.toFixed(1);
}

/**
 * One of the two effective-holdings counts, for the file.
 *
 * One decimal and no thousands separator, so a spreadsheet reads a number rather than
 * text: the page may print `1,204`, which a CSV cell would have to quote and a sum
 * would then skip.
 */
function holdings(value: number): string {
  return value.toFixed(1);
}

function bandWord(pct: number | null): string {
  if (pct === null) return "";
  const band: CoverageBand = coverageBand(pct);
  return band;
}

/**
 * `unpackfund-markets-2026-11-03-2026-11-02.7.csv` — the date the visitor exported
 * it and the release the numbers came from. Same shape as the ledger's file name
 * (`lib/export.ts`), and the release stamp is sanitised the same way.
 */
export function lensCsvName(kind: string, now: Date, releaseAsOf: string): string {
  const date = now.toISOString().slice(0, 10);
  return `unpackfund-${kind}-${date}-${releaseAsOf.replace(/[^0-9A-Za-z._-]/g, "_")}.csv`;
}

/** `VTI 2.05%`, or `AMZN (direct) 10.00%` — the row's own words for a source. */
function sourceCell(source: LedgerSource): string {
  const label = source.kind === "fund" ? source.ref : `${source.ref} (direct)`;
  return `${label} ${share(source.weight)}%`;
}

/**
 * A signed difference in percentage points, as a spreadsheet wants it: `+2.00`.
 *
 * The page prints `(+2.00%)` — the bracket and the unit are the page's grammar
 * (`formatSignedShare`, ADR-0015). A file is read by a parser, so the sign is kept and
 * the bracket is not: the column header carries the unit, and a cell that reads `(+2.00%)`
 * is text in every spreadsheet ever written. `-0.00` cannot be produced: a difference that
 * rounds to nothing prints `0.00`, with no side to be on.
 */
function signedPoints(delta: number): string {
  const points = Number((delta * 100).toFixed(2));
  if (points === 0) return "0.00";
  return points > 0 ? `+${points.toFixed(2)}` : points.toFixed(2);
}

/**
 * The Companies lens: the whole ledger, whatever page the table is showing.
 *
 * Exactly the ledger's own columns (`lib/export.ts`) with the two benchmark numbers
 * inserted beside the weight they qualify, so a spreadsheet that already reads an export
 * from the workspace keeps every column it had.
 *
 * The two new columns carry the page's meaning and the page's single subtraction:
 * `{benchmark}_weight_pct` is the company's weight **inside the benchmark fund's own
 * NAV** (not a share of the visitor's mix, not how much of the benchmark they hold), and
 * `change_vs_{benchmark}_pp` is your weight minus that, in percentage points. The name is
 * the fund the comparison actually used, so a file cannot say VT while holding VOO's
 * numbers; VT keeps its historic `vt_` names. A release that publishes no benchmark
 * leaves both empty rather than writing `0.00`, because a zero in a spreadsheet is a
 * measurement and this would be a missing one.
 *
 * Rows are in the ledger's order, which is the table's default order — the page's sort and
 * its page number are the view's, and a file that followed them would be a different
 * answer every time it was opened.
 */
/**
 * The style columns, when the table is showing them (§9.5).
 *
 * `caption` is the benchmark that produced `weights`: a file that carried `style_weight_pct`
 * without saying *which* style it was against would be a number with no provenance, and the
 * caption is exactly what the table prints for a reader. Passing `null` writes the file the
 * table has always written — no empty style columns.
 */
export interface StyleCsvColumns {
  caption: string;
  weights: Record<string, number>;
}

export function companiesCsv(
  ledger: Ledger,
  releaseAsOf: string,
  style?: StyleCsvColumns | null,
  benchmarkTicker: string = DEFAULT_BENCHMARK,
): string {
  // Lower case so the column reads `voo_weight_pct` beside `portfolio_weight_pct`, and so
  // VT keeps the historic `vt_weight_pct` / `change_vs_vt_pp` names exactly.
  const benchmark = benchmarkTicker.toLowerCase();
  const lines = [
    csvLine([
      "company_id",
      "name",
      "ticker",
      "portfolio_weight_pct",
      `${benchmark}_weight_pct`,
      `change_vs_${benchmark}_pp`,
      ...(style ? ["style_weight_pct", "change_vs_style_pp", "style_benchmark"] : []),
      "held_directly",
      "fund_count",
      "sources",
      "release_as_of",
    ]),
  ];

  for (const row of ledger.rows) {
    const delta = benchmarkDelta(row.weight, row.benchmark_weight);
    const styleWeight = style ? (style.weights[row.company_id] ?? 0) : null;
    const styleDelta =
      styleWeight === null ? null : benchmarkDelta(row.weight, styleWeight);
    lines.push(
      csvLine([
        row.company_id,
        row.name,
        row.ticker ?? "",
        share(row.weight),
        row.benchmark_weight === null ? "" : share(row.benchmark_weight),
        delta === null ? "" : signedPoints(delta),
        ...(style
          ? [
              share(styleWeight ?? 0),
              styleDelta === null ? "" : signedPoints(styleDelta),
              style.caption,
            ]
          : []),
        row.held_directly ? "yes" : "no",
        row.holder_count,
        row.sources.map(sourceCell).join("; "),
        releaseAsOf,
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The market tables: the five segments first (the bar's own numbers, including the
 * dashed one), then one row per country. `bucket` is the segment each row belongs
 * to, so a pivot on the file reproduces the bar.
 */
export function marketsCsv(split: MarketSplit, releaseAsOf: string): string {
  const lines = [
    csvLine([
      "section",
      "bucket",
      "country_code",
      "market",
      "tier",
      "weight_pct",
      "companies",
      "release_as_of",
    ]),
  ];

  for (const tier of split.tiers) {
    lines.push(
      csvLine([
        "market",
        tier.bucket,
        "",
        bucketWord(tier.bucket, split.provider),
        TIER_WORD[tier.bucket],
        share(tier.weight),
        tier.companies,
        releaseAsOf,
      ]),
    );
  }

  // The bar draws three segments, so the export has three market rows and no
  // "unplaced" row: what the bar does not draw is a property of the whole portfolio,
  // not a fourth market, and it is written as its own section below.
  lines.push(
    csvLine([
      "outside",
      "TOTAL",
      "",
      "Outside the bar",
      "",
      share(split.outside.total),
      split.outside.unplacedCompanies,
      releaseAsOf,
    ]),
  );

  for (const country of split.countries) {
    lines.push(
      csvLine([
        "country",
        country.tier,
        country.code,
        "",
        TIER_WORD[country.tier],
        share(country.weight),
        country.companies,
        releaseAsOf,
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * One row per fund in the mix. The three dates travel together and separately, so
 * a spreadsheet can sort by age without parsing a sentence.
 *
 * `pair` adds the fund's own two effective-holdings counts as `core` and `broad`. They
 * are appended only when the caller has them, so the file keeps `release_as_of` as its
 * last column and a caller with nothing to add gets the shape it always got.
 */
export function fundsCsv(
  rows: readonly FundMixRow[],
  releaseAsOf: string,
  pair?: ReadonlyMap<string, EffectiveHoldings>,
): string {
  const withPair = pair !== undefined;
  const counts = (pairFor: EffectiveHoldings | undefined, key: "core" | "broad") => {
    const value = pairFor ? pairFor[key] : null;
    return value === null ? "" : holdings(value);
  };

  const lines = [
    csvLine([
      "ticker",
      "name",
      "weight_pct",
      "positions",
      "coverage_pct",
      "coverage_band",
      "reporting_period",
      "filed_at",
      "age_days",
      "top10_share_pct",
      ...(withPair ? ["core", "broad"] : []),
      "release_as_of",
    ]),
  ];

  for (const row of rows) {
    const pairFor = pair?.get(row.ticker);
    lines.push(
      csvLine([
        row.ticker,
        row.name,
        share(row.weight),
        row.positions,
        row.coveragePct === null ? "" : coverage(row.coveragePct),
        bandWord(row.coveragePct),
        row.asOf,
        row.filedAt,
        row.lagDays,
        row.top10Share === null ? "" : share(row.top10Share),
        ...(withPair ? [counts(pairFor, "core"), counts(pairFor, "broad")] : []),
        releaseAsOf,
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** A pair as the Overlap lens prints it, plus the state that qualifies it. */
export interface OverlapCsvRow {
  a: string;
  b: string;
  /** `null` when the pair is not computed (a fund below the coverage floor). */
  overlap: number | null;
  onlyA: number | null;
  onlyB: number | null;
  sharedCompanies: number | null;
  unionCompanies: number | null;
  coverageAPct: number | null;
  coverageBPct: number | null;
  /**
   * The verdict, machine-readable: `printed` (both funds in the full band),
   * `floor` (a fund in the partial band, so the number is a lower bound) or
   * `withheld` (a fund below the 60% floor, so there is no number).
   */
  state: PairState;
  /** The same qualifier the page prints, so the file is not quieter than the site. */
  note: string | null;
}

export function overlapCsv(rows: readonly OverlapCsvRow[], releaseAsOf: string): string {
  const lines = [
    csvLine([
      "fund_a",
      "fund_b",
      "overlap_pct",
      "only_a_pct",
      "only_b_pct",
      "shared_companies",
      "union_companies",
      "coverage_a_pct",
      "coverage_b_pct",
      "state",
      "note",
      "release_as_of",
    ]),
  ];

  for (const row of rows) {
    lines.push(
      csvLine([
        row.a,
        row.b,
        row.overlap === null ? "" : share(row.overlap),
        row.onlyA === null ? "" : share(row.onlyA),
        row.onlyB === null ? "" : share(row.onlyB),
        row.sharedCompanies,
        row.unionCompanies,
        row.coverageAPct === null ? "" : coverage(row.coverageAPct),
        row.coverageBPct === null ? "" : coverage(row.coverageBPct),
        row.state,
        row.note,
        releaseAsOf,
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** One fund's coverage, its weight with no company, and its three filing dates. */
export interface QualityCsvFund {
  ticker: string;
  weight: number;
  /** Share of the portfolio in this fund's positions that resolved to no company. */
  noCompany: number;
  coveragePct: number;
  asOf: string;
  filedAt: string;
  lagDays: number;
}

/**
 * The quality lens is two tables — coverage with dates, and the untraced weight by
 * cause — so the file is one table with a `section` column rather than two files.
 * The two sections do not share a unit: `weight_pct` is a share of the portfolio,
 * `coverage_pct` is a share of a fund, and neither stands in for the other.
 */
export function qualityCsv(input: {
  funds: readonly QualityCsvFund[];
  invested: number;
  coveragePct: number;
  totals: UntracedTotals;
  unmapped: UnmappedBreakdown;
  releaseAsOf: string;
}): string {
  const totals = input.totals;
  const lines = [
    csvLine([
      "section",
      "item",
      "weight_pct",
      "no_company_pct",
      "coverage_pct",
      "count",
      "reporting_period",
      "filed_at",
      "age_days",
      "note",
      "release_as_of",
    ]),
    csvLine([
      "coverage",
      "portfolio (funds and stocks, cash excluded)",
      share(input.invested),
      share(totals.unmatchedSecurities + totals.unmatchedCashDerivatives),
      coverage(input.coveragePct),
      "",
      "",
      "",
      "",
      "70% and above full; 60% to just under 70% partial; below 60% withheld",
      input.releaseAsOf,
    ]),
  ];

  for (const fund of input.funds) {
    lines.push(
      csvLine([
        "coverage",
        fund.ticker,
        share(fund.weight),
        share(fund.noCompany),
        coverage(fund.coveragePct),
        "",
        fund.asOf,
        fund.filedAt,
        fund.lagDays,
        bandWord(fund.coveragePct),
        input.releaseAsOf,
      ]),
    );
  }

  lines.push(
    csvLine([
      "untraced",
      "companies the release names",
      share(totals.resolved),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "share positions with no company",
      share(totals.unmatchedSecurities),
      "",
      "",
      input.unmapped.securities_with_weight,
      "",
      "",
      "",
      `${input.unmapped.positions_with_weight} positions carry weight; ${input.unmapped.positions} filed positions have no company`,
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "cash and derivative lines inside funds",
      share(totals.unmatchedCashDerivatives),
      "",
      "",
      input.unmapped.cash_and_derivatives_with_weight,
      "",
      "",
      "",
      "no company by definition",
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "cash you hold",
      share(totals.cash),
      "",
      "",
      "",
      "",
      "",
      "",
      "no company by definition; outside coverage",
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "not entered",
      share(totals.unallocated),
      "",
      "",
      "",
      "",
      "",
      "",
      "weight the portfolio does not allocate",
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "filed weight outside the holding schedules",
      share(totals.filedOvershoot),
      "",
      "",
      "",
      "",
      "",
      "",
      "signed: sum over funds of fund weight x (filed total - 100%)",
      input.releaseAsOf,
    ]),
    csvLine([
      "untraced",
      "total",
      share(totals.total),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      input.releaseAsOf,
    ]),
  );

  return `${lines.join("\n")}\n`;
}
