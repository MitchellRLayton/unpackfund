/**
 * The two coverage figures, and the one place that decides whether the second is shown.
 *
 * A fund has two different shares, and they answer two different questions:
 *
 * - **attributed** (`coverage_pct`) — the share of weight we could tie to a company or
 *   entity. This is the number every metric depends on, and it stays the headline.
 * - **identified** (`identified_pct`) — the share of weight we know the *security* for.
 *   This is the weaker test, so it is always the larger number: a Treasury, a repo or a
 *   registered fund is a security we can identify and never a company we can attribute.
 *
 * The product risk is specific and it is why this module exists: a reader who sees "99%
 * identified" beside "88% attributed" and takes the first for the second has been told
 * that company coverage is better than it is. So the identified figure is always
 * labelled in words that name the quantity (`of weight identified`), never with the
 * word "coverage", and it is dropped entirely when it would be a second printing of the
 * attributed figure.
 *
 * Both fields are additive to the wire format: absent means "this release does not
 * measure it", and every function here then behaves exactly as the page did before the
 * field existed. No caller decides that for itself.
 */

import { formatCoveragePct, coverageChip } from "./format";
import type { AssetCategory, FundDocument } from "./types";

/** The six asset classes, in the order the sleeve lists them. */
export const ASSET_CATEGORY_ORDER: readonly AssetCategory[] = [
  "equity",
  "debt",
  "cash",
  "derivative",
  "fund",
  "other",
];

/**
 * The two labels, exported so a test pins the words rather than a snapshot of markup.
 *
 * `ATTRIBUTED` names the company test; `IDENTIFIED` names the security test and never
 * uses the word "coverage" — the whole point of the change is that the second number
 * cannot be read as the first.
 */
export const ATTRIBUTED_LABEL = "attributed to companies";
export const IDENTIFIED_LABEL = "of weight identified";

/** The sentence that keeps the two apart, in one line of plain English. */
export function coverageSentence(attributed: number, identified: number | null): string {
  if (identified === null) return "";
  return `We know which security ${formatCoveragePct(
    identified,
  )} of this fund's weight is; ${formatCoveragePct(
    attributed,
  )} of it is attributed to a named company.`;
}

/** What a fund's coverage figure is: one number, or two. */
export interface CoveragePair {
  attributed: number;
  /** `null` when the release does not carry the second figure, or it adds nothing. */
  identified: number | null;
}

/** The narrowest shape `coveragePair` needs, so a caller can pass a whole fund. */
export type CoverageSource = Pick<FundDocument, "coverage_pct" | "identified_pct">;

/**
 * The dual-read rule, in one place.
 *
 * The identified figure is returned only when it is present, finite, and rounds to
 * something *different* at the precision the page prints. Equality at one decimal is
 * what the reader sees, so a document whose two shares both print as `88.6%` renders
 * one figure — two identical numbers labelled differently would imply a distinction the
 * data does not make on this page.
 */
export function coveragePair(doc: CoverageSource): CoveragePair {
  const identified = doc.identified_pct;
  if (typeof identified !== "number" || !Number.isFinite(identified)) {
    return { attributed: doc.coverage_pct, identified: null };
  }
  if (formatCoveragePct(identified) === formatCoveragePct(doc.coverage_pct)) {
    return { attributed: doc.coverage_pct, identified: null };
  }
  return { attributed: doc.coverage_pct, identified };
}

/** One class of the sleeve: the two shares, or `null` for a class the fund does not hold. */
export interface SleeveRow {
  cat: AssetCategory;
  attributed: number | null;
  identified: number | null;
}

/**
 * The per-class sleeve, all six classes in a fixed order.
 *
 * A class the fund does not hold keeps `null` on both sides and the renderer skips it:
 * a percentage of nothing is not zero, and printing one would invent weight. The
 * identified side is only ever read from `identified_by_cat`; a missing identified
 * figure never borrows the attributed one.
 */
export function coverageSleeve(
  doc: Pick<FundDocument, "coverage_by_cat" | "identified_by_cat">,
): SleeveRow[] {
  const attributedByCat = doc.coverage_by_cat;
  const identifiedByCat = doc.identified_by_cat;
  return ASSET_CATEGORY_ORDER.map((cat) => ({
    cat,
    attributed: attributedByCat?.[cat] ?? null,
    identified: identifiedByCat?.[cat] ?? null,
  }));
}

/**
 * Whether the sleeve has anything the second figure adds — the switch the renderer uses.
 *
 * One class with both shares is enough. A sleeve whose identified side is entirely
 * absent or identical to its attributed side renders exactly as it did before.
 */
export function sleeveShowsIdentified(rows: SleeveRow[]): boolean {
  return rows.some(
    (row) =>
      row.attributed !== null &&
      row.identified !== null &&
      formatCoveragePct(row.identified) !== formatCoveragePct(row.attributed),
  );
}

/**
 * One sleeve line, e.g. `equity 97.1% covered · 99.9% identified`.
 *
 * The attributed half keeps `coverageChip`'s band wording — the 70/60 bands are a rule
 * about attribution and nothing else — and the identified half is a bare percentage
 * with its own label. When a class has no identified figure the line is the attributed
 * half alone, which is the page as it reads today.
 */
export function sleeveLine(row: SleeveRow): string {
  if (row.attributed === null) return "";
  const attributed = coverageChip(row.attributed);
  if (row.identified === null) return `${row.cat} ${attributed}`;
  if (formatCoveragePct(row.identified) === formatCoveragePct(row.attributed)) {
    return `${row.cat} ${attributed}`;
  }
  return `${row.cat} ${attributed} · ${formatCoveragePct(row.identified)} identified`;
}
