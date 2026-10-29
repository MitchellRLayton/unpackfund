/**
 * The only place numbers become text.
 *
 * Rules come from `static-xray-frontend` §6 and `lookthrough-math-and-qa` §5:
 * basis points are exactly two decimal places of a percent (a third would be
 * false precision), a real position never prints as zero, coverage never rounds
 * across the 60/70 band boundaries, and the locale is pinned so a server render
 * and a client render cannot disagree.
 */

const LOCALE = "en-US";

const twoDp = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const oneDp = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** `273` → `2.73%`. Integer basis points are exactly representable at 2 dp. */
export function formatWeightBp(weightBp: number): string {
  return `${twoDp.format(weightBp / 100)}%`;
}

/**
 * A fraction of the portfolio as a percent: `0.0273` → `2.73%`.
 *
 * The ledger holds fractions, so a 0.3 bp position would render as `0.00%` and
 * vanish. Anything real but below half a basis point prints `<0.01%` instead;
 * only a true zero prints `0.00%`.
 */
export function formatShare(weight: number): string {
  const pct = weight * 100;
  if (pct !== 0 && Math.abs(pct) < 0.005) {
    return weight < 0 ? ">-0.01%" : "<0.01%";
  }
  return `${twoDp.format(pct)}%`;
}

/** `90.3` → `90.3%`. Coverage is stored as a percentage, not a fraction. */
export function formatCoveragePct(coveragePct: number): string {
  return `${oneDp.format(coveragePct)}%`;
}

/** `0.02074643` → `0.0207`; `77.2` → `77.2`. */
export function formatRatio(value: number, digits = 4): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** `59` → `59 days`; `1` → `1 day`. */
export function formatDays(days: number): string {
  return `${integer.format(days)} ${days === 1 ? "day" : "days"}`;
}

/** `1233` → `1,233`. */
export function formatCount(value: number): string {
  return integer.format(value);
}

/**
 * ISO dates are rendered as they are stored.
 *
 * Parsing `2026-06-30` into a `Date` and formatting it back re-introduces a
 * timezone and a locale, which is how a filing date becomes the day before.
 */
export function formatIsoDate(value: string): string {
  return value;
}

/** The scorecard strip's date line: `2026-06-30 · filed 2026-08-28 · 59 days`. */
export function formatFreshness(asOf: string, filedAt: string, lagDays: number): string {
  return `${formatIsoDate(asOf)} · filed ${formatIsoDate(filedAt)} · ${formatDays(lagDays)}`;
}

/** Coverage bands are half-open on the lower edge (math §5). */
export type CoverageBand = "full" | "partial" | "none";

export function coverageBand(coveragePct: number): CoverageBand {
  if (coveragePct >= 70) return "full";
  if (coveragePct >= 60) return "partial";
  return "none";
}

/**
 * The label a band renders, always as words rather than colour.
 *
 * `partial` carries the percentage so a reader sees how much is missing without
 * hovering; `none` states that nothing is shown rather than showing a zero.
 */
export function coverageLabel(coveragePct: number): string {
  switch (coverageBand(coveragePct)) {
    case "full":
      return `${formatCoveragePct(coveragePct)} of weight covered`;
    case "partial":
      return `partial (${formatCoveragePct(coveragePct)} of weight)`;
    case "none":
      return "not covered";
  }
}

/** Short form for a table cell: `covered`, `partial 66.4%`, `not covered`. */
export function coverageChip(coveragePct: number): string {
  switch (coverageBand(coveragePct)) {
    case "full":
      return "covered";
    case "partial":
      return `partial ${formatCoveragePct(coveragePct)}`;
    case "none":
      return "not covered";
  }
}
