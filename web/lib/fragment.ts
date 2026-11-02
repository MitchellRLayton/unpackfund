/**
 * The portfolio lives in `location.hash`, and nowhere else.
 *
 * Browsers do not send the fragment in an HTTP request, which is the whole
 * privacy guarantee: the portfolio never reaches a server or its logs. The format
 * is `#v3.<base64url>`, versioned because an old link must either decode exactly or
 * be refused — never partially guessed at, since a dropped holding is a wrong
 * answer rather than a smaller one (`static-xray-frontend` §4).
 *
 * Version history, and why each version exists rather than a flag on the last one:
 *
 * - **v1** `[[ticker, weight_bp], …]` — funds only, percentages only.
 * - **v2** `{"a": […], "b": […]}` — two portfolios for `/compare`. A v1 decoder must
 *   not half-read it and show one side of a comparison as the whole answer.
 * - **v3** `[mode, [[kind, key, amount], …]]` — the portfolio gained direct
 *   holdings, cash, and a dollars-vs-percent toggle (ADR-0014; operator decision
 *   2026-11-01). The **mode is part of the link**: a `$` portfolio stores cents and
 *   a `%` portfolio stores basis points, and re-interpreting one as the other would
 *   silently multiply every weight by 100.
 *
 * v1 and v2 still decode, forever, into the fund-only portfolio they always meant.
 * Nothing is ever re-encoded into an older version.
 *
 * **The array order is the visitor's order.** The builder used to sort entries by
 * kind and key on both encode and decode, so a portfolio came back alphabetical and
 * a typed list could never be read the way it was typed. The order is now part of
 * the portfolio: it is what the builder shows, what the visitor can drag, and what
 * the link reproduces. Two portfolios that differ only in order are different
 * links, which is correct — the order is information the visitor supplied.
 */

import {
  CASH_KEY,
  FULL_ALLOCATION_BP,
  type EntryKind,
  type EntryMode,
  type FundWeight,
  type Portfolio,
  type PortfolioEntry,
} from "./types";

export const FRAGMENT_VERSION = "v3";
/** Funds only, percentages only. Read, never written. */
export const LEGACY_VERSION = "v1";
/** Two portfolios, funds only. Read, and still written by `/compare`. */
export const COMPARE_VERSION = "v2";
export const MAX_FRAGMENT_CHARS = 2000;

/** A `$` portfolio is capped at $100bn of entries; nobody's list is longer. */
const MAX_CENTS = 10_000_000_000_00;
/** A `%` portfolio entry cannot exceed the whole allocation. */
const MAX_BP = FULL_ALLOCATION_BP;

export type DecodeFailure =
  "empty" | "too-long" | "unknown-version" | "malformed" | "invalid-entry";

export type DecodeResult =
  | { ok: true; portfolio: Portfolio; complete: boolean }
  | { ok: false; reason: DecodeFailure };

const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

const KIND_CODE: Record<EntryKind, string> = {
  fund: "f",
  security: "s",
  cash: "c",
};
const CODE_KIND: Record<string, EntryKind> = {
  f: "fund",
  s: "security",
  c: "cash",
};

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The entries' total in their own unit: basis points, or cents. */
export function totalAmount(entries: PortfolioEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}

/**
 * Whether the portfolio accounts for all of itself.
 *
 * Percentage mode must reach exactly 100% — an unallocated remainder is an
 * incomplete portfolio and the view says so. Dollar mode is complete as soon as it
 * has one non-zero amount: the visitor's dollars *are* the total.
 */
export function isComplete(mode: EntryMode, entries: PortfolioEntry[]): boolean {
  if (entries.length === 0) return false;
  const total = totalAmount(entries);
  if (mode === "usd") return total > 0;
  return total === FULL_ALLOCATION_BP;
}

export function encodePortfolio(portfolio: Portfolio): string {
  // No sorting: the entries are written in the order the visitor sees them, which
  // is also the order they will see when the link is opened again.
  const payload = [
    portfolio.mode,
    portfolio.entries.map((entry) => [KIND_CODE[entry.kind], entry.key, entry.amount]),
  ];
  return `${FRAGMENT_VERSION}.${toBase64Url(JSON.stringify(payload))}`;
}

/** One `[kind, key, amount]` triple, validated against the mode it claims. */
function isEntry(value: unknown, mode: EntryMode): value is [string, string, number] {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [code, key, amount] = value;
  if (typeof code !== "string" || !(code in CODE_KIND)) return false;
  if (typeof key !== "string") return false;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return false;
  const ceiling = mode === "bp" ? MAX_BP : MAX_CENTS;
  if (amount > ceiling) return false;
  // `CASH` is a reserved key: cash is a kind, never a symbol. An entry that claimed
  // the reserved word under another kind would be counted twice — once as cash and
  // once as a company-less holding — so the format refuses it outright.
  if (key === CASH_KEY) return CODE_KIND[code] === "cash";
  if (CODE_KIND[code] === "cash") return false;
  return TICKER_RE.test(key);
}

function parsePortfolioEntries(raw: unknown, mode: EntryMode): PortfolioEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const entries: PortfolioEntry[] = [];
  let cash = 0;
  for (const value of raw) {
    if (!isEntry(value, mode)) return null;
    const [code, key, amount] = value;
    // `code` was validated against CODE_KIND by `isEntry`, so the lookup holds;
    // the annotation makes that explicit rather than leaving an `undefined` in the
    // type of every downstream entry.
    const kind = CODE_KIND[code] as EntryKind;
    const identity = `${kind}:${key}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    if (kind === "cash") {
      cash += 1;
      if (cash > 1) return null;
    }
    entries.push({ kind, key, amount });
  }
  // A percentage portfolio above 100% is not a portfolio the ledger can read: the
  // shares would sum past the whole, and every weight would be a guess about what
  // the visitor meant.
  if (mode === "bp" && totalAmount(entries) > FULL_ALLOCATION_BP) return null;
  // Payload order, not sorted: the link is the portfolio's order (see the header).
  return entries;
}

export interface Comparison {
  a: FundWeight[];
  b: FundWeight[];
}

export type CompareDecodeResult =
  | {
      ok: true;
      portfolio: Portfolio;
      a: FundWeight[];
      b: FundWeight[];
      completeA: boolean;
      completeB: boolean;
    }
  | { ok: false; reason: DecodeFailure };

/** Read the version and payload of a hash, without interpreting the payload. */
function split(hash: string): { version: string; payload: string } | DecodeFailure {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return "empty";
  if (raw.length > MAX_FRAGMENT_CHARS) return "too-long";
  const dot = raw.indexOf(".");
  if (dot < 0) return "malformed";
  return { version: raw.slice(0, dot), payload: raw.slice(dot + 1) };
}

function decodePayload(payload: string): unknown {
  try {
    return JSON.parse(fromBase64Url(payload));
  } catch {
    return undefined;
  }
}

/** Legacy v1 payload: `[[ticker, weight_bp], …]`, funds only. */
function parseLegacyEntries(values: unknown): PortfolioEntry[] | null {
  if (!Array.isArray(values)) return null;
  const seen = new Set<string>();
  const entries: PortfolioEntry[] = [];
  for (const value of values) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [ticker, weightBp] = value;
    if (typeof ticker !== "string" || !TICKER_RE.test(ticker)) return null;
    if (
      typeof weightBp !== "number" ||
      !Number.isInteger(weightBp) ||
      weightBp < 0 ||
      weightBp > FULL_ALLOCATION_BP
    ) {
      return null;
    }
    if (seen.has(ticker)) return null;
    seen.add(ticker);
    entries.push({ kind: "fund", key: ticker, amount: weightBp });
  }
  return entries;
}

/** The fund-only view of a portfolio, which is what `/compare` renders. */
export function fundWeights(portfolio: Portfolio): FundWeight[] {
  const funds = portfolio.entries.filter((entry) => entry.kind === "fund");
  if (portfolio.mode === "bp") {
    return funds.map((entry) => ({ ticker: entry.key, weight_bp: entry.amount }));
  }
  const total = totalAmount(portfolio.entries);
  if (total <= 0) return [];
  return funds.map((entry) => ({
    ticker: entry.key,
    weight_bp: Math.round((entry.amount * FULL_ALLOCATION_BP) / total),
  }));
}

/**
 * Accepts a raw hash (`#v3.…`, `#v2.…`, `#v1.…`) or a bare fragment and returns
 * the portfolio plus both comparison sides.
 */
export function decodeComparison(hash: string): CompareDecodeResult {
  const head = split(hash);
  if (typeof head === "string") return { ok: false, reason: head };

  if (head.version === FRAGMENT_VERSION) {
    const payload = decodePayload(head.payload);
    if (payload === undefined) return { ok: false, reason: "malformed" };
    if (!Array.isArray(payload) || payload.length !== 2) {
      return { ok: false, reason: "malformed" };
    }
    const [mode, rawEntries] = payload as [unknown, unknown];
    if (mode !== "bp" && mode !== "usd") return { ok: false, reason: "malformed" };
    const entries = parsePortfolioEntries(rawEntries, mode);
    if (!entries) return { ok: false, reason: "invalid-entry" };
    if (entries.length === 0) return { ok: false, reason: "empty" };
    const portfolio: Portfolio = { mode, entries };
    return {
      ok: true,
      portfolio,
      a: fundWeights(portfolio),
      b: [],
      completeA: isComplete(mode, entries),
      completeB: false,
    };
  }

  if (head.version === LEGACY_VERSION) {
    const payload = decodePayload(head.payload);
    if (payload === undefined) return { ok: false, reason: "malformed" };
    const entries = parseLegacyEntries(payload);
    if (!entries) return { ok: false, reason: "invalid-entry" };
    if (entries.length === 0) return { ok: false, reason: "empty" };
    const portfolio: Portfolio = { mode: "bp", entries };
    return {
      ok: true,
      portfolio,
      a: fundWeights(portfolio),
      b: [],
      completeA: isComplete("bp", entries),
      completeB: false,
    };
  }

  if (head.version !== COMPARE_VERSION) {
    return { ok: false, reason: "unknown-version" };
  }

  const parsed = decodePayload(head.payload) as { a?: unknown; b?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  const a = parseLegacyEntries(parsed.a ?? []);
  const b = parseLegacyEntries(parsed.b ?? []);
  if (!a || !b) return { ok: false, reason: "invalid-entry" };
  if (a.length === 0) return { ok: false, reason: "empty" };
  const portfolio: Portfolio = { mode: "bp", entries: a };
  return {
    ok: true,
    portfolio,
    a: fundWeights(portfolio),
    b: fundWeights({ mode: "bp", entries: b }),
    completeA: isComplete("bp", a),
    completeB: isComplete("bp", b),
  };
}

/** The single-portfolio view of a hash: whichever version it came from. */
export function decodePortfolio(hash: string): DecodeResult {
  const result = decodeComparison(hash);
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    portfolio: result.portfolio,
    complete: result.completeA,
  };
}

/**
 * The comparison hash. `/compare` is a funds-only surface, so its links stay v2 —
 * a v2 link opened on `/x` shows side A, and both are funds at basis points.
 */
export function encodeComparison(a: FundWeight[], b: FundWeight[]): string {
  const sideA = sortFundWeights(a).map((entry) => [entry.ticker, entry.weight_bp]);
  const sideB = sortFundWeights(b).map((entry) => [entry.ticker, entry.weight_bp]);
  if (sideB.length === 0) {
    return `${LEGACY_VERSION}.${toBase64Url(JSON.stringify(sideA))}`;
  }
  return `${COMPARE_VERSION}.${toBase64Url(JSON.stringify({ a: sideA, b: sideB }))}`;
}

export function sortFundWeights(entries: FundWeight[]): FundWeight[] {
  return [...entries].sort((a, b) =>
    a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0,
  );
}

/** The URL to share: origin, path, and the fragment. No query, no shortener. */
export function shareUrl(base: string, portfolio: Portfolio): string {
  const [path] = base.split("#");
  return `${path}#${encodePortfolio(portfolio)}`;
}

/**
 * Equal weights for `count` funds, as integers, summing to exactly 10,000.
 *
 * The remainder goes to the first entries rather than being dropped, because a
 * portfolio that silently totals 9,999 bp would render a 0.01% ghost row.
 */
export function equalWeights(tickers: string[]): PortfolioEntry[] {
  if (tickers.length === 0) return [];
  const base = Math.floor(FULL_ALLOCATION_BP / tickers.length);
  const remainder = FULL_ALLOCATION_BP - base * tickers.length;
  return tickers.map((ticker, index) => ({
    kind: "fund" as const,
    key: ticker,
    amount: base + (index < remainder ? 1 : 0),
  }));
}
