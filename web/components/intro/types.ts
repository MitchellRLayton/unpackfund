/**
 * The film's data contract, and the three pure helpers that touch it.
 *
 * `/intro/field.json` is baked by `scripts/bake-intro.mjs` from two published fund
 * documents, so this file describes an artifact rather than a live endpoint. Nothing here
 * touches the DOM, which is what lets `layout.test.ts` exercise the packing and the
 * caption formatter without a browser.
 *
 * The shape, as baked:
 *
 *   { schema: 1, release, generated_at, pair: [A, B],
 *     funds: [{ ticker, name, as_of, filed_at, lag_days, coverage_pct, holdings }, …],
 *     totals: { held, distinct, shared },
 *     labels: [{ name, ticker, weight }],          // the twelve the film prints
 *     companies: [{ k: "a" | "b" | "s", w }] }     // 504 rows, one per company
 *
 * `k` says which funds hold the company (`s` = both) and `w` is its combined holding
 * weight in basis points, which is what sets a dot's area. There is deliberately no
 * company identity in the field: the film never needs one, and a name per dot would be a
 * table rather than a picture.
 */

/** Which funds hold a company: only the first, only the second, or both. */
export type HeldBy = "a" | "b" | "s";

/** One fund, as the card caption names it. */
export interface IntroFund {
  ticker: string;
  name: string;
  /** The period the filing describes, `YYYY-MM-DD`. */
  as_of: string;
  /** The day the N-PORT was filed, `YYYY-MM-DD`. */
  filed_at: string;
  lag_days: number;
  coverage_pct: number;
  /** How many mapped holdings the filing lists. */
  holdings: number;
}

/** A company the film writes a ticker beside — one of the twelve largest. */
export interface IntroLabel {
  name: string;
  ticker: string;
  /** Combined weight in basis points, matching one row of `companies`. */
  weight: number;
}

/** One company in the field. */
export interface IntroCompany {
  k: HeldBy;
  /** Combined holding weight in basis points — the dot's area. */
  w: number;
}

/** The whole artifact. */
export interface IntroField {
  schema: 1;
  release: string;
  generated_at: string | null;
  pair: readonly [string, string];
  funds: readonly [IntroFund, IntroFund];
  totals: { held: number; distinct: number; shared: number };
  labels: IntroLabel[];
  companies: IntroCompany[];
}

/**
 * One dot on the field: a company as one card spills it.
 *
 * `fund` is the card that spills the dot, not the only fund that holds it — a company
 * both funds hold is spilled by the first card and receives the second card's weight at
 * the merge.
 */
export interface DotSpec {
  /** 0 = the first card (left / top), 1 = the second. */
  fund: 0 | 1;
  /** Combined weight in basis points; drives the dot's area. */
  weightBp: number;
  /** Both funds hold it: it carries a merge flash, and a thread from the second card. */
  shared: boolean;
  /**
   * Deterministic packing group. The film no longer colours by group — every dot is ink —
   * but eleven seeded patches are what make the field read as a field rather than a pile,
   * so the packing keeps the grouping and the group is derived from the company's index.
   */
  cluster: number;
  /** The mono label this dot carries, or `null` for the 492 that carry none. */
  label: string | null;
}

/** The twelve mono labels the film writes, largest position first. */
const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * `2026-08-28` → `filed 28 AUG 2026`, the caption's third column.
 *
 * Written by hand rather than through `Intl.DateTimeFormat`, for two reasons that both
 * matter here: the film must render identically on every machine (a locale-dependent
 * month is a hydration and a review hazard), and no formatter is allowed inside a
 * timeline callback. An unparseable date is returned as-is behind the word `filed`, so a
 * bad artifact is legible on screen instead of throwing during the film.
 */
export function formatFiledLine(filedAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filedAt);
  if (!match) return `filed ${filedAt}`;
  const year = match[1]!;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const name = MONTHS[month - 1];
  if (!name || day < 1 || day > 31) return `filed ${filedAt}`;
  return `filed ${String(day).padStart(2, "0")} ${name} ${year}`;
}

/** A caption row: what the card under the field prints about one fund. */
export function captionRows(field: IntroField): Array<{
  ticker: string;
  name: string;
  filed: string;
}> {
  return field.funds.map((fund) => ({
    ticker: fund.ticker,
    name: fund.name,
    filed: formatFiledLine(fund.filed_at),
  }));
}

/**
 * Assign the twelve printed tickers to their companies.
 *
 * The artifact carries no company identity — only weight — so the join is by weight, and
 * the bake guarantees every label's weight appears in `companies` (verified below). Two
 * companies can share a weight (AMD and LLY both sit at 294 bp), so the tie is broken by
 * index: the label goes to the first unclaimed company of that weight, which is stable
 * because `companies` is sorted by company id at bake time.
 *
 * Returns company index → ticker for the twelve labels, and nothing else. Labels only
 * ever land on a dot the first card spills, or the label would appear after the merge.
 */
export function labelByCompany(
  companies: readonly IntroCompany[],
  labels: readonly IntroLabel[],
): Map<number, string> {
  const claimed = new Set<number>();
  const assigned = new Map<number, string>();
  const ordered = [...labels].sort((a, b) => b.weight - a.weight);
  for (const label of ordered) {
    const index = companies.findIndex(
      (company, at) =>
        !claimed.has(at) && company.w === label.weight && company.k !== "b",
    );
    if (index === -1) continue;
    claimed.add(index);
    assigned.set(index, label.ticker);
  }
  return assigned;
}

/**
 * The packing group of a company, derived from its position in the artifact.
 *
 * The baked field is sorted by company id and carries no group, and the film must not
 * invent one that looks like data — so the group is a scramble of the index: deterministic
 * (the same field packs the same way on every load and every resize), spreading the
 * companies evenly over the eleven patches, and meaningful to nobody.
 */
export function clusterOf(index: number): number {
  let h = (index + 1) * 0x9e3779b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 11;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseFund(value: unknown): IntroFund {
  if (!isRecord(value)) throw new Error("field.funds[]: not an object");
  const { ticker, name, as_of, filed_at, lag_days, coverage_pct, holdings } = value;
  if (!isString(ticker) || !isString(name) || !isString(as_of) || !isString(filed_at)) {
    throw new Error("field.funds[]: missing ticker, name, as_of or filed_at");
  }
  if (!isNumber(lag_days) || !isNumber(coverage_pct) || !isNumber(holdings)) {
    throw new Error(
      `field.funds[${ticker}]: lag_days, coverage_pct or holdings is not a number`,
    );
  }
  return { ticker, name, as_of, filed_at, lag_days, coverage_pct, holdings };
}

/**
 * Type the artifact, refusing anything the film cannot draw.
 *
 * The fetch is a network read of a committed file, so the failure that matters is a stale
 * or half-written artifact after a release: it must land as a refused film (the page is
 * revealed, no focus stolen) rather than as a half-built stage with `undefined` coordinates
 * three beats in. Only the fields the choreography reads are checked.
 */
export function parseField(value: unknown): IntroField {
  if (!isRecord(value)) throw new Error("field.json: not an object");
  if (value.schema !== 1)
    throw new Error(`field.json: schema ${String(value.schema)} is not 1`);

  const pair = value.pair;
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isString)) {
    throw new Error("field.json: pair must be two tickers");
  }

  const funds = value.funds;
  if (!Array.isArray(funds) || funds.length < 2)
    throw new Error("field.json: needs two funds");
  const [a, b] = funds as [unknown, unknown];
  const parsedFunds: [IntroFund, IntroFund] = [parseFund(a), parseFund(b)];

  const totals = value.totals;
  if (!isRecord(totals) || !isNumber(totals.held) || !isNumber(totals.distinct)) {
    throw new Error("field.json: totals.held and totals.distinct are required numbers");
  }
  if (!isNumber(totals.shared)) throw new Error("field.json: totals.shared is required");

  const companiesRaw = value.companies;
  if (!Array.isArray(companiesRaw) || companiesRaw.length === 0) {
    throw new Error("field.json: companies is empty");
  }
  const companies: IntroCompany[] = companiesRaw.map((row, index) => {
    if (!isRecord(row))
      throw new Error(`field.json: companies[${index}] is not an object`);
    const { k, w } = row;
    if (k !== "a" && k !== "b" && k !== "s") {
      throw new Error(`field.json: companies[${index}].k is not a, b or s`);
    }
    if (!isNumber(w) || w < 0)
      throw new Error(`field.json: companies[${index}].w is not a weight`);
    return { k, w };
  });

  const labelsRaw = value.labels;
  if (!Array.isArray(labelsRaw)) throw new Error("field.json: labels is not an array");
  const labels: IntroLabel[] = labelsRaw.map((row, index) => {
    if (!isRecord(row)) throw new Error(`field.json: labels[${index}] is not an object`);
    const { name, ticker, weight } = row;
    if (!isString(name) || !isString(ticker) || !isNumber(weight)) {
      throw new Error(`field.json: labels[${index}] needs name, ticker and weight`);
    }
    return { name, ticker, weight };
  });

  return {
    schema: 1,
    release: isString(value.release) ? value.release : "",
    generated_at: isString(value.generated_at) ? value.generated_at : null,
    pair: [pair[0] as string, pair[1] as string],
    funds: parsedFunds,
    totals: { held: totals.held, distinct: totals.distinct, shared: totals.shared },
    labels,
    companies,
  };
}
