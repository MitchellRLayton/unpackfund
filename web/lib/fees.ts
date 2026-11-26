/**
 * The stated expense ratio of the share class a portfolio holds, and the portfolio's
 * weighted average (T-0052 phase 3; ADR-0030; the operator's decisions D2–D4).
 *
 * **Nothing here is computed from another field.** A fund's fee is read from the fund
 * document's `fees.classes[TICKER]` row, which the pipeline took from the prospectus; the
 * only arithmetic in this file is D4's weighted average of those stated figures. A net is
 * never total minus waiver, a missing class is "not stated" (never a sibling class's fee),
 * and an unknown fund is never counted as zero.
 *
 * **Which figure counts.** The headline is the figure the prospectus says investors pay:
 * the net where it states one, otherwise the total labelled "no fee waiver stated". A row
 * whose basis is `waiver-without-net` or `waiver-unresolved` has a total that is *not*
 * what investors pay (the filing states a waiver we cannot apply), so it is shown with that
 * label but left out of the average and counted as unknown: the average never mixes a net
 * and a gross figure.
 */

import { coverageBand, formatFeePct } from "./format";
import type { FeeBasis, FeeRow, FundDocument, PortfolioEntry } from "./types";

/**
 * Two stated fees closer than this are the same figure (the facts carry four decimals), and
 * a positive waiver above it is a recoupment candidate. The pipeline's `fees.EPS`.
 */
const EPS = 5e-5;
/** A recoupment reconciles within one basis point. The pipeline's `NET_OVER_TOTAL`. */
const RECOUP_TOLERANCE = 1e-4 + 1e-9;

/** What a fee is read as, in words, by basis. The fund page prints the same sentences. */
export const FEE_NOTES = {
  netOfWaivers: "net of fee waivers",
  netAsStated: "net expense ratio, as stated",
  recoupment: "includes a recoupment of earlier waivers, as the filing states",
  noWaiver: "no fee waiver stated",
  waiverNoNet: "before waivers; the filing states a waiver but no net figure",
  waiverUnresolved: "before any waiver; the filing's waiver could not be read",
} as const;

export interface FeeFigure {
  /** The class the fee belongs to: the ticker the visitor typed, or the fund's own. */
  classTicker: string;
  /** The headline fraction: net when stated, else the total. */
  value: number;
  /** The total before waivers, only where the filing states a net that differs. */
  before: number | null;
  basis: FeeBasis;
  /** The words that say what `value` is. */
  note: string;
  /** Whether `value` is what investors pay, and so may enter the average. */
  countable: boolean;
  /** When the prospectus is dated, else when it was filed (ISO). */
  date: string;
  /** The filing the figure was read from. */
  sourceUrl: string;
}

/** The class a fund entry's fee is read for: what was typed, else the published ticker. */
export function classOf(entry: Pick<PortfolioEntry, "key" | "cls">): string {
  return entry.cls ?? entry.key;
}

/** A positive waiver that reconciles a net above the total: a recoupment, not a waiver. */
function isRecoupment(row: FeeRow): boolean {
  const { total, net, waiver } = row;
  if (total === null || net === null || waiver === null) return false;
  return waiver > EPS && Math.abs(total + waiver - net) <= RECOUP_TOLERANCE;
}

/** The words under a row's figure, from its basis and numbers. Never from arithmetic on them. */
function noteFor(row: FeeRow, differs: boolean): string {
  switch (row.basis) {
    case "stated-net":
      if (isRecoupment(row)) return FEE_NOTES.recoupment;
      return differs ? FEE_NOTES.netOfWaivers : FEE_NOTES.netAsStated;
    case "no-waiver-stated":
      return FEE_NOTES.noWaiver;
    case "waiver-without-net":
      return FEE_NOTES.waiverNoNet;
    case "waiver-unresolved":
      return FEE_NOTES.waiverUnresolved;
  }
}

/**
 * The stated fee of one class of a fund document, or `null` when the document states none
 * for it: no `fees` block, no row for that class, or a row with no number. Another class's
 * row is never a substitute.
 */
export function feeFigure(
  document: FundDocument | undefined,
  classTicker: string,
): FeeFigure | null {
  const row = document?.fees?.classes?.[classTicker];
  if (!row) return null;
  const value = row.net ?? row.total;
  if (value === null || value === undefined) return null;
  const differs =
    row.basis === "stated-net" &&
    row.total !== null &&
    row.net !== null &&
    Math.abs(row.total - row.net) > EPS;
  return {
    classTicker,
    value,
    before: differs ? row.total : null,
    basis: row.basis,
    note: noteFor(row, differs),
    countable: row.basis === "stated-net" || row.basis === "no-waiver-stated",
    date: row.prospectus_date ?? row.filed_at,
    sourceUrl: row.source_url,
  };
}

/** Whether any fund document in hand carries expense ratios at all. */
export function documentsCarryFees(
  documents: Iterable<FundDocument | undefined>,
): boolean {
  for (const document of documents) if (document?.fees) return true;
  return false;
}

export interface PortfolioFee {
  /** D4's `Σ wᵢ·ERᵢ / Σ wᵢ` over funds with a countable fee, as a fraction; else `null`. */
  average: number | null;
  /** Fund weight with a countable fee ÷ all fund weight, as a percentage 0–100. */
  knownPct: number;
  /** How many funds have a countable fee, of how many. */
  counted: number;
  funds: number;
  /** The average is withheld because the known share is under the 60% line. */
  suppressed: boolean;
}

/**
 * D4. `fundWeights` is each fund's share of the whole portfolio (series ticker → fraction),
 * `classes` the class each fund was entered as. Stocks and cash are not in `fundWeights`,
 * so they neither enter nor dilute: the denominator is fund weight alone.
 *
 * The average is withheld under the same 60% line as coverage (`coverageBand`): a fee known
 * for a minority of the money is not "your fee". The known share is printed beside it
 * whenever there is any fund weight, so the reader sees what the number covers.
 */
export function portfolioFee(
  fundWeights: Record<string, number>,
  classes: Record<string, string>,
  documents: ReadonlyMap<string, FundDocument>,
): PortfolioFee | null {
  let total = 0;
  let known = 0;
  let weighted = 0;
  let funds = 0;
  let counted = 0;
  for (const [ticker, weight] of Object.entries(fundWeights)) {
    if (!(weight > 0)) continue;
    funds += 1;
    total += weight;
    const figure = feeFigure(documents.get(ticker), classes[ticker] ?? ticker);
    if (figure?.countable) {
      counted += 1;
      known += weight;
      weighted += weight * figure.value;
    }
  }
  if (total <= 0) return null;
  // Rounded to a millionth of a point so `0.3 / 0.5 * 100` is the 60 it is, not 59.99999.
  const knownPct = Math.round((known / total) * 100 * 1e6) / 1e6;
  const suppressed = coverageBand(knownPct) === "none";
  return {
    average: !suppressed && known > 0 ? weighted / known : null,
    knownPct,
    counted,
    funds,
    suppressed,
  };
}

/** `class by fund key`, from the entries: the map `portfolioFee` wants. */
export function classesByFund(
  entries: readonly PortfolioEntry[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind === "fund" && entry.cls !== undefined) out[entry.key] = entry.cls;
  }
  return out;
}

/**
 * One fee as a sentence fragment: `0.28%, net of fee waivers; 0.53% before waivers`. The
 * builder row prints it; a table cell prints its parts (`formatFeePct`, `note`, `before`)
 * on separate lines, from the same figure.
 */
export function feeSentence(figure: FeeFigure): string {
  const before =
    figure.before === null ? "" : `; ${formatFeePct(figure.before)} before waivers`;
  return `${formatFeePct(figure.value)}, ${figure.note}${before}`;
}
