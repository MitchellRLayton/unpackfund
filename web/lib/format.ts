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

const money = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Integer cents as dollars: `900000` → `$9,000.00`.
 *
 * Cents, not dollars, because a dollar entry is stored as an exact integer and a
 * float would turn `$4,000.50` into something with a `.49999` in it. The currency
 * is fixed to USD in v1: SEC filings are filed in USD, and picking a display currency
 * from the visitor's locale would relabel the same number rather than convert it.
 */
export function formatCents(cents: number): string {
  return money.format(cents / 100);
}

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

/**
 * A signed difference between two percents, in brackets: `-0.0254` → `(-2.54%)`.
 *
 * The one place the ledger subtracts two displayed weights (the operator's decision,
 * ADR-0015, 2026-11-02 amendment): the bracket means *your weight minus the
 * benchmark's*, in percentage points, so the sign is always explicit — a bare
 * `2.54%` in that position would read as a level rather than as a difference. A real
 * difference below one basis point keeps `formatShare`'s `<0.01%` / `>-0.01%` so it
 * cannot print as zero, and exact zero prints `(0.00%)` with no sign because there is
 * no side to be on.
 *
 * The value handed in is computed from unrounded fractions and rounded here once
 * (math §6: a displayed total comes from exact values, never from summing rounded
 * displays), so a reader who subtracts the two printed numbers can be 0.01 away at a
 * rounding boundary. The caption says so rather than the formatter hiding it.
 */
export function formatSignedShare(delta: number): string {
  // `-0` is zero: without this, Intl formats it `-0.00%` and the bracket would claim
  // a direction that does not exist.
  const inner = formatShare(delta === 0 ? 0 : delta);
  const signed =
    inner.startsWith("-") || inner.startsWith("<") || inner.startsWith(">")
      ? inner
      : inner === "0.00%"
        ? inner
        : `+${inner}`;
  return `(${signed})`;
}

/**
 * The ink a signed difference wears, from the sign alone: green above zero, red below,
 * `--muted` at an exact zero — a difference of zero has no side to be on, so it gets no
 * direction.
 *
 * It lives here beside `formatSignedShare` because the class and the sign are one
 * decision in two channels, and the two callers must not drift into two
 * implementations: the ledger's bracket against the benchmark (`LedgerTable`) and the
 * compare page's company-by-company Δ column (`CompareView`). The colour is allowed to
 * mean the sign only because it never carries it — the sign is always printed (the
 * formatter's job), and each table's caption states which colour is which side, so a
 * reader who cannot separate the green from the red loses nothing but emphasis
 * (`static-xray-frontend` §4a, §8; ADR-0015 amendment 2026-11-02).
 *
 * A plain function rather than a stylesheet rule keyed off a data attribute — the way
 * the geography edge works — because the sign is arithmetic: a selector can read a
 * row's `data-country`, it cannot subtract two weights. The two channels stay separate
 * even in the same cell: geography owns the row's edge, the sign owns this span.
 */
export function deltaInkClass(delta: number): string {
  if (delta > 0) return "delta delta--up";
  if (delta < 0) return "delta delta--down";
  return "delta";
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

/**
 * Short form for a table cell: `90.3% covered`, `partial 66.4%`, `17.0% not covered`.
 *
 * The percentage is in **every** band, including the one whose label is "not
 * covered". A cell that printed only the band label left the coverage column saying
 * nothing about how much of the fund was traced — the reviewer's line was "a name,
 * not an identifier, is what ships", and the same logic applies to a number that
 * exists in the data and is replaced by a word in the table.
 */
export function coverageChip(coveragePct: number): string {
  switch (coverageBand(coveragePct)) {
    case "full":
      return `${formatCoveragePct(coveragePct)} covered`;
    case "partial":
      return `partial ${formatCoveragePct(coveragePct)}`;
    case "none":
      return `${formatCoveragePct(coveragePct)} not covered`;
  }
}

/**
 * A release's ticker list as prose.
 *
 * The day-3 release published five funds, so naming them all was honest and
 * useful. The widened release publishes 12,265, and a sentence that lists them is
 * neither: it is 60 KB of text in a paragraph, on every page load. So the list is
 * named while it is short enough to read, and summarised — with the real count —
 * once it is not. The count is never rounded in the summary line, because "12k
 * funds" reads as approximate and the number is exact.
 */
export function formatFundList(tickers: string[], namedLimit = 12): string {
  if (tickers.length === 0) return "no funds";
  if (tickers.length === 1) return tickers[0] ?? "one fund";
  if (tickers.length <= namedLimit) return tickers.join(", ");
  const named = tickers.slice(0, 8).join(", ");
  return `${named} and ${formatCount(tickers.length - 8)} more`;
}
