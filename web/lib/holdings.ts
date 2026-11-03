/**
 * What the visitor typed, and what it means — one implementation, two pages.
 *
 * The Portfolio page (`/`) and Compare (`/compare`) both take a fund ticker by hand,
 * and before this module each had its own answer to the same five questions: is this
 * cash, is it a well-formed ticker, is it a fund this release publishes, is it a share
 * class of one, is it a stock the visitor holds directly? Two implementations of that
 * answer is how the two pages end up refusing the same input in different words — which
 * is exactly what happened (`/compare` said "not in this release" for a share class the
 * builder resolved, and refused a stock the builder accepts).
 *
 * So the *decision* lives here and the *rendering* stays in each page. Everything this
 * module returns is presentation-ready: the tone, the title and the body of the sentence
 * the reader will see. That is deliberate — a shared function that returned only
 * `boolean` would leave the wording free to drift again, and the wording is the part the
 * visitor experiences.
 *
 * The order of the checks is the builder's, and it is not arbitrary:
 *   1. `cash` is a word, not a symbol, and it is matched before the shape test because
 *      "CASH" is five upper-case letters and would otherwise pass as a ticker;
 *   2. the shape test runs before any fetch, so a typo does not cost a network round
 *      trip;
 *   3. a fund this release publishes is the common case and the cheapest lookup;
 *   4. a share class resolves to its published portfolio (`VFIAX` → `VOO`), which is the
 *      one case where an input that is *not* in the release is still addable;
 *   5. a stock comes last because it costs a shard fetch.
 *
 * Nothing here decides what the number means. Amounts are the store's business
 * (`use-portfolio`, `use-comparison`) and the arithmetic is `aggregate`/`overlap`'s; this
 * module only answers "is this a holding, and what do I call it".
 */

import {
  loadSecurities,
  publishesSecurities,
  resolveAlias,
  type FetchImpl,
} from "./data";
import { formatFundList, formatWeightBp } from "./format";
import { accepts, isCarriable, normaliseSymbol, refusal } from "./securities";
import { FULL_ALLOCATION_BP, type EntryKind, type EntryMode } from "./types";
import type { ReleaseDescriptor } from "./types";
import type { LoadState } from "./use-release";

/**
 * How many rows one list may hold.
 *
 * Two reasons, and both are real: the fragment has a 2,000-character budget (forty
 * entries is what fits with the version prefix), and a list longer than this is not a
 * portfolio anyone reads down the page. Refusing an add is better than writing a link
 * that will not open.
 */
export const MAX_HOLDINGS = 40;

/** The key the cash row is stored under. `CASH` is not a symbol to make a visitor guess. */
export const CASH_KEY = "CASH";

/** Both spellings the builder accepts, lower-cased. */
const CASH_WORDS = new Set(["cash", "cash position"]);

/** What the visitor asked for, before the release is consulted. */
export type InputShape =
  | { kind: "cash" }
  | { kind: "symbol"; ticker: string }
  /** Not a ticker at all — refused without a fetch. */
  | { kind: "invalid"; title: string; body: string };

/**
 * Split one typed line into the three things this app accepts.
 *
 * Pure and synchronous: it is the whole of the validation that can be done without the
 * release, which is why both pages can run it before deciding whether to await anything.
 */
export function classifyInput(raw: string): InputShape {
  const typed = raw.trim();
  if (CASH_WORDS.has(typed.toLowerCase())) return { kind: "cash" };
  const ticker = normaliseSymbol(typed);
  if (!isCarriable(ticker)) {
    return {
      kind: "invalid",
      title: `${typed} is not a ticker`,
      body: "Tickers are upper-case letters, digits, dots and dashes.",
    };
  }
  return { kind: "symbol", ticker };
}

/** Every sentence either page can show after an add attempt. */
export type EntryDecision =
  | {
      ok: true;
      kind: EntryKind;
      key: string;
      /** What the row is called: the ticker, or `CASH`. */
      label: string;
      /** The confirmation body, when there is something worth saying beyond "Added X". */
      body?: string;
      /** The name the reader should see, when the release resolved one (`AMZN — AMAZON COM INC`). */
      resolved?: string;
    }
  | {
      ok: false;
      /** `warn` for "not in this release", `info` for "not yet" and "already there". */
      tone: "warn" | "info";
      title: string;
      body?: string;
    };

/** What a page allows its own list to contain. */
export interface EntryContext {
  /** Published fund tickers, upper case. */
  catalog: string[];
  /** The release's load state — an add may have to wait for it or report its failure. */
  release: LoadState<ReleaseDescriptor>;
  /**
   * Whether a stock may be added here. Compare holds funds only, and says so in a
   * sentence that points at the page which can: a silent refusal would look like a
   * missing symbol.
   */
  allowSecurities?: boolean;
  /** Whether cash may be added here (Compare: no — a comparison is between funds). */
  allowCash?: boolean;
  /**
   * Names of the two sides for the refusal copy, e.g. `"Portfolio A"`. Compare passes
   * its column label; the builder passes nothing and gets "this list".
   */
  where?: string;
  /** Injected for tests; production passes nothing and the loader uses `fetch`. */
  fetchImpl?: FetchImpl;
}

/** "Already in Compare" is a different sentence from a bare refusal; both name the row. */
function duplicate(label: string, where: string): EntryDecision {
  return {
    ok: false,
    tone: "info",
    title: `${label} is already in ${where}`,
    body: "One row per holding: set its amount instead of adding it twice.",
  };
}

/**
 * Turn one typed line into a holding, a refusal, or a wait.
 *
 * The caller does not have to catch: a network failure inside the alias or symbol
 * lookup is a refusal with the reason in it, because the visitor typed something and
 * deserves an answer rather than a broken page.
 */
export async function resolveEntry(
  raw: string,
  ctx: EntryContext,
  /** Keys already in the list this input is being added to. */
  present: readonly string[] = [],
): Promise<EntryDecision> {
  const where = ctx.where ?? "your portfolio";
  const shape = classifyInput(raw);
  if (shape.kind === "invalid") {
    return { ok: false, tone: "warn", title: shape.title, body: shape.body };
  }
  if (shape.kind === "cash") {
    if (ctx.allowCash === false) {
      return {
        ok: false,
        tone: "warn",
        title: "Cash cannot be compared",
        body: `A comparison is between what funds hold, and cash has no company behind it. Add it in the Portfolio instead.`,
      };
    }
    if (present.includes(CASH_KEY)) return duplicate("cash", where);
    return {
      ok: true,
      kind: "cash",
      key: CASH_KEY,
      label: "cash",
      body: "Set the amount it represents. Cash is part of your money but has no company behind it.",
    };
  }

  const ticker = shape.ticker;
  if (ctx.release.status === "loading") {
    return {
      ok: false,
      tone: "info",
      title: "Still reading the release",
      body: "One moment — the fund list has not loaded yet.",
    };
  }
  if (ctx.release.status === "error") {
    return {
      ok: false,
      tone: "warn",
      title: "The release could not be read",
      body: ctx.release.error.message,
    };
  }
  const release = ctx.release.data;

  // 1. A fund this release publishes.
  if (ctx.catalog.includes(ticker)) {
    if (present.includes(ticker)) return duplicate(ticker, where);
    return { ok: true, kind: "fund", key: ticker, label: ticker };
  }

  // 2. A share class of a published fund (`VFIAX` → `VOO`): one portfolio, many
  //    tickers, and the release publishes one document per portfolio.
  const published = await resolveAlias(release, ticker, ctx.fetchImpl).catch(() => null);
  if (published && ctx.catalog.includes(published)) {
    if (present.includes(published)) return duplicate(published, where);
    return {
      ok: true,
      kind: "fund",
      key: published,
      label: published,
      body: `${ticker} is a share class of ${published}, so the holdings are the same.`,
    };
  }

  // 3. A stock the visitor holds directly. Identity comes from the release's own
  //    symbol object, and its status is the build's verdict on whether the symbol is
  //    one company's common stock.
  //
  //    The funds-only refusal for Compare lives *inside* the hit, not before the
  //    lookup: a page that refuses an unknown symbol as "a stock, not a fund" has made
  //    a claim about a symbol it never looked up, so a typo would be told it is a
  //    stock. One shard fetch on the refusal path is what makes the sentence true.
  const rows = await loadSecurities(release, [ticker], ctx.fetchImpl).catch(() => null);
  const row = rows?.get(ticker);
  if (row) {
    const status = row[3];
    if (!accepts(status)) {
      return {
        ok: false,
        tone: "warn",
        title: `${ticker} cannot be added as a stock`,
        body: refusal(status) ?? "This release lists it, but not as a common stock.",
      };
    }
    if (ctx.allowSecurities === false) {
      return {
        ok: false,
        tone: "warn",
        title: `${ticker} is a stock, not a fund`,
        body: "A comparison is between funds, so a directly held stock has no side here. Look it through on the Portfolio page instead.",
      };
    }
    // The confirmation step: a symbol is a label, and the reader should see the company
    // the release resolved it to before it enters their portfolio.
    return {
      ok: true,
      kind: "security",
      key: ticker,
      label: ticker,
      resolved: `${ticker} — ${row[1]}`,
      body: `Held directly. ${row[2] ?? "Exchange not filed"} · company ${row[0]}. Its weight is yours, not a fund's.`,
    };
  }

  // 4. Nothing published for this symbol, and the release does not carry the symbols
  //    object at all: it predates stocks, so it has not been asked the question.
  //    Saying "AMZN is not in release X" would be a false claim about the symbol.
  if (!publishesSecurities(release)) {
    return {
      ok: false,
      tone: "warn",
      title: "This release does not list stock symbols yet",
      body: `Release ${release.as_of} was built before stocks were published, so it can answer for funds but not for a stock you hold directly.`,
    };
  }

  return {
    ok: false,
    tone: "warn",
    title: `${ticker} is not in release ${release.as_of}`,
    body:
      ctx.catalog.length > 0
        ? `It is not a fund or a listed stock in this release. Funds published: ${formatFundList(ctx.catalog)}.`
        : "This release publishes no funds.",
  };
}

/** The whole-vs-part arithmetic both pages state in words. */
export interface Tally {
  /** The entries' total in the mode's own unit: basis points, or cents. */
  total: number;
  /** Whether the entries account for the whole (see `fragment.isComplete`). */
  complete: boolean;
  /** Percent mode only: how much of 100% is unallocated, in basis points. */
  unallocatedBp: number;
  /** Percent mode only: how far past 100% the entries are, in basis points. */
  overBp: number;
  /** The sentence: "fully allocated" | "12.00% unallocated" | "5.00% over 100%". */
  sentence: string;
  /** Whether `sentence` describes a whole, so a caller can colour it green. */
  ok: boolean;
}

/**
 * Total a list of amounts, and say what state it is in.
 *
 * The wording is the builder's, moved here so Compare says the same words. Dollars are
 * their own total, so a dollar list is complete as soon as one amount is non-zero and
 * there is nothing to be short of; percentages are shares of 100 and must reach exactly
 * it, because a look-through weight is a share of a whole.
 */
export function tallyOf(mode: EntryMode, amounts: readonly number[]): Tally {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (mode === "usd") {
    const complete = total > 0;
    return {
      total,
      complete,
      unallocatedBp: 0,
      overBp: 0,
      sentence: complete ? "fully allocated" : "no amounts yet",
      ok: complete,
    };
  }
  const unallocatedBp = Math.max(0, FULL_ALLOCATION_BP - total);
  const overBp = Math.max(0, total - FULL_ALLOCATION_BP);
  if (overBp > 0) {
    return {
      total,
      complete: false,
      unallocatedBp: 0,
      overBp,
      sentence: `${formatWeightBp(overBp)} over 100%`,
      ok: false,
    };
  }
  if (unallocatedBp > 0) {
    return {
      total,
      complete: false,
      unallocatedBp,
      overBp: 0,
      sentence: `${formatWeightBp(unallocatedBp)} unallocated`,
      ok: false,
    };
  }
  return {
    total,
    complete: true,
    unallocatedBp: 0,
    overBp: 0,
    sentence: "fully allocated",
    ok: true,
  };
}

/** What a row is called on screen. `CASH` is stored upper-case and read as "Cash". */
export function entryLabel(kind: EntryKind, key: string): string {
  return kind === "cash" ? "Cash" : key;
}

/** What the row's identity is called in a remove button, for a screen reader. */
export function removeLabel(kind: EntryKind, key: string): string {
  return kind === "cash" ? "cash" : key;
}
