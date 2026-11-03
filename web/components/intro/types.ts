/**
 * The film's data contract: the two artifacts the bake publishes, and every string the film
 * prints from them.
 *
 * `/intro/caption.json` and `/intro/dots.bin` are baked by `scripts/bake-intro.mjs` from two
 * published fund documents, so this file describes an artifact rather than a live endpoint
 * (CONTRACT.md §1). Nothing here touches the DOM, which is what lets the formatting and the
 * geometry be tested without a browser.
 *
 * The record layout is read from the contract, not re-derived: 7 float32 per company,
 * `[w, vx, vy, ox, oy, rx, ry]`, little-endian, sorted by company id at bake time. The film
 * never needs a company's identity — only its weight, where it sits in the two words, and
 * where it lands on the final rule.
 */

/** Which fund a caption names. The film's beats use A for the first (VTI), B for the second. */
export type FundSlot = "a" | "b";

/** One fund, as the caption names it. */
export interface CaptionFund {
  ticker: string;
  name: string;
  /** The day the N-PORT was filed, `YYYY-MM-DD`. */
  filed_at: string;
  /** The period the filing describes, `YYYY-MM-DD`. */
  as_of: string;
  /** How many companies this fund holds in the release. */
  companies: number;
}

/** A company the film writes a ticker beside — one of the twelve largest in A. */
export interface CaptionLabel {
  name: string;
  ticker: string;
  /** At the bake's discretion: basis points or a share. Only the order matters. */
  weight: number;
  /**
   * The 0-based record index in `dots.bin`, so a label can find the dot it belongs to.
   * Added at the lead's request after the first contract draft; the rank match below is
   * only the guard for a bake that predates it.
   */
  index?: number;
}

/** A word's font metrics, in em units of the word at its own font size. */
export interface WordMetrics {
  /** Total advance of the word. */
  advance: number;
  /** Height above the baseline. */
  ascender: number;
  /** Depth below the baseline. */
  descender: number;
}

/** Everything the film needs to place two words and the rule they collapse onto. */
export interface CaptionMetrics {
  unitsPerEm: number;
  a: WordMetrics;
  b: WordMetrics;
  /** The final rule, inside the ticker line's box. */
  rule: { width: number; y: number };
}

/** The whole `caption.json` artifact. */
export interface Caption {
  schema: 1;
  release: string;
  generated_at: string;
  a: CaptionFund;
  b: CaptionFund;
  /** `k`: companies in both funds. */
  shared: number;
  labels: CaptionLabel[];
  metrics: CaptionMetrics;
}

/** `dots.bin`, unpacked: one record per company in the union of the two funds. */
export interface DotField {
  count: number;
  /** Float32Array of `RECORD_FLOATS * count`. */
  raw: Float32Array;
}

/** Floats per record in `dots.bin` (CONTRACT.md §1). */
export const RECORD_FLOATS = 7;
/** Bytes per record. */
export const RECORD_BYTES = RECORD_FLOATS * 4;

/** One company's record, named. `null` fields mean "not in B" for `ox`/`oy`. */
export interface DotRecord {
  w: number;
  vx: number;
  vy: number;
  /** `null` when the company is not held by B: the bake writes NaN, NaN. */
  ox: number | null;
  oy: number | null;
  rx: number;
  ry: number;
}

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
 * `2026-08-28` → `filed 28 AUG 2026`, the caption's second half.
 *
 * Written by hand rather than through `Intl.DateTimeFormat`, for two reasons that both
 * matter here: the film must render identically on every machine (a locale-dependent month
 * is a hydration and a review hazard), and no formatter is allowed inside a timeline
 * callback. An unparseable date is returned behind the word `filed`, so a bad artifact is
 * legible on screen instead of throwing during the film.
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

/**
 * A company count with a thousands separator, and never a leading zero.
 *
 * `String#toLocaleString` is deliberately not used: the film prints counts during a tween,
 * one frame at a time, and a locale-dependent group separator (or an Arabic-Indic digit set)
 * would make the frame different on different machines. The counter is also why there is no
 * padding here: the odometer rolls from nothing to a number, and a zero slot in front of
 * `VTI`'s count would read as a second, smaller number.
 */
export function formatCount(value: number): string {
  const whole = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The caption at the top-left: the ticker and the day its filing arrived. */
export function captionText(caption: Caption | null, ticker = "VTI"): string {
  if (caption === null) return ticker;
  return `${caption.a.ticker} · ${formatFiledLine(caption.a.filed_at)}`;
}

/** VTI's own company count: the number the counter lands on. */
export function counterTotal(caption: Caption | null): number | null {
  if (caption === null) return null;
  const total = caption.a.companies;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * The line under the counter during the `twice` beat:
 * `{k} of VOO's {m} companies are already in VTI`.
 *
 * Both tickers come from the artifact rather than from the copy, so a re-bake for a
 * different pair says the right thing; `null` means the artifact is not here yet.
 */
export function sharedLine(caption: Caption | null): string | null {
  if (caption === null) return null;
  const k = formatCount(caption.shared);
  const total = formatCount(caption.b.companies);
  return `${k} of ${caption.b.ticker}'s ${total} companies are already in ${caption.a.ticker}`;
}

/** One record, by index, or `null` when the index is outside the field. */
export function dotRecord(raw: Float32Array, index: number): DotRecord | null {
  const at = index * RECORD_FLOATS;
  if (index < 0 || at + RECORD_FLOATS > raw.length) return null;
  const w = raw[at];
  const vx = raw[at + 1];
  const vy = raw[at + 2];
  const ox = raw[at + 3];
  const oy = raw[at + 4];
  const rx = raw[at + 5];
  const ry = raw[at + 6];
  if (
    w === undefined ||
    vx === undefined ||
    vy === undefined ||
    ox === undefined ||
    oy === undefined ||
    rx === undefined ||
    ry === undefined
  ) {
    return null;
  }
  return {
    w,
    vx,
    vy,
    ox: Number.isNaN(ox) ? null : ox,
    oy: Number.isNaN(oy) ? null : oy,
    rx,
    ry,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function expectNumber(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = source[key];
  if (!isFiniteNumber(value))
    throw new Error(`caption.json: ${where}.${key} is not a number`);
  return value;
}

function expectString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = source[key];
  if (!isString(value)) throw new Error(`caption.json: ${where}.${key} is not a string`);
  return value;
}

function parseFund(value: unknown, where: string): CaptionFund {
  if (!isRecord(value)) throw new Error(`caption.json: ${where} is not an object`);
  const companies = expectNumber(value, "companies", where);
  return {
    ticker: expectString(value, "ticker", where),
    name: expectString(value, "name", where),
    filed_at: expectString(value, "filed_at", where),
    as_of: expectString(value, "as_of", where),
    companies,
  };
}

function parseWord(value: unknown, where: string): WordMetrics {
  if (!isRecord(value)) throw new Error(`caption.json: ${where} is not an object`);
  return {
    advance: expectNumber(value, "advance", where),
    ascender: expectNumber(value, "ascender", where),
    descender: expectNumber(value, "descender", where),
  };
}

/**
 * Validate `caption.json` into a `Caption`, or throw with the field that broke.
 *
 * The film is allowed to play without dots and without this file (the brief's guardrail),
 * so a throw here is caught by the caller and the film simply prints tickers it already
 * knows. Throwing rather than defaulting means a bake that drifts shape is reported by the
 * tests instead of silently printing the wrong filing date.
 */
export function parseCaption(value: unknown): Caption {
  if (!isRecord(value)) throw new Error("caption.json: not an object");
  if (value.schema !== 1) throw new Error("caption.json: schema is not 1");
  const labelsRaw = value.labels;
  if (!Array.isArray(labelsRaw)) throw new Error("caption.json: labels is not an array");
  const metricsRaw = value.metrics;
  if (!isRecord(metricsRaw)) throw new Error("caption.json: metrics is not an object");
  const ruleRaw = metricsRaw.rule;
  if (!isRecord(ruleRaw)) throw new Error("caption.json: metrics.rule is not an object");

  const labels: CaptionLabel[] = labelsRaw.map((row, index) => {
    const where = `labels[${index}]`;
    if (!isRecord(row)) throw new Error(`caption.json: ${where} is not an object`);
    const label: CaptionLabel = {
      name: expectString(row, "name", where),
      ticker: expectString(row, "ticker", where),
      weight: expectNumber(row, "weight", where),
    };
    if (isFiniteNumber(row.index) && row.index >= 0) label.index = Math.trunc(row.index);
    return label;
  });

  const unitsPerEm = expectNumber(metricsRaw, "unitsPerEm", "metrics");
  const a = parseFund(value.a, "a");
  const b = parseFund(value.b, "b");
  if (a.ticker === "" || b.ticker === "")
    throw new Error("caption.json: a ticker is empty");
  if (a.companies <= 0) throw new Error("caption.json: a.companies is not positive");

  return {
    schema: 1,
    release: expectString(value, "release", "caption"),
    generated_at: expectString(value, "generated_at", "caption"),
    a,
    b,
    shared: expectNumber(value, "shared", "caption"),
    labels,
    metrics: {
      unitsPerEm,
      a: parseWord(metricsRaw.a, "metrics.a"),
      b: parseWord(metricsRaw.b, "metrics.b"),
      rule: {
        width: expectNumber(ruleRaw, "width", "metrics.rule"),
        y: expectNumber(ruleRaw, "y", "metrics.rule"),
      },
    },
  };
}

/**
 * Unpack `dots.bin` into a `DotField`.
 *
 * Little-endian float32 is a platform-independent byte format and `Float32Array` reads it
 * in the platform's own order, so the browser side needs exactly one check: the byte length
 * has to be a whole number of 28-byte records. An empty or ragged file is a bake defect, and
 * throwing it lets the caller play without dots rather than drawing noise.
 */
export function parseDots(buffer: ArrayBuffer): DotField {
  if (buffer.byteLength === 0) throw new Error("dots.bin: empty");
  if (buffer.byteLength % RECORD_BYTES !== 0) {
    throw new Error(
      `dots.bin: ${buffer.byteLength} bytes is not ${RECORD_BYTES}-byte records`,
    );
  }
  return { count: buffer.byteLength / RECORD_BYTES, raw: new Float32Array(buffer) };
}
