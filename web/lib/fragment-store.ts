"use client";

/**
 * The URL fragment as an external store.
 *
 * `useSyncExternalStore` is the right tool because the fragment genuinely lives
 * outside React: the back button, a pasted link, and our own writes all change it
 * without a render. It also solves hydration honestly — the server snapshot is
 * "nothing read yet", so the prerendered HTML never claims a portfolio is empty
 * when the visitor arrived through a shared link.
 *
 * Two shapes share one fragment, and they are not the same thing:
 *
 * - `portfolio` is the ledger's state — entries that can be funds, stocks, or cash,
 *   with a dollars-or-percent mode (v3).
 * - `a` and `b` are `/compare`'s two fund lists. Comparison is funds-only by design,
 *   so it keeps the v2/v1 shape, and a v3 link is projected onto it (its funds, at
 *   their portfolio weights).
 *
 * Snapshot identity is cached, because React re-reads it on every render and a
 * fresh object each time would loop.
 */

import {
  decodeComparison,
  encodeComparison,
  encodePortfolio,
  fundWeights,
} from "./fragment";
import type { FundWeight, Portfolio } from "./types";

export interface FragmentSnapshot {
  /** The portfolio the ledger shows. */
  portfolio: Portfolio;
  /** `/compare`'s first column. Always funds, always basis points. */
  a: FundWeight[];
  /** The second portfolio, only ever non-empty on `/compare`. */
  b: FundWeight[];
  problem: string | null;
  /** `false` until the fragment has actually been read, on the client only. */
  ready: boolean;
}

const UNREAD: FragmentSnapshot = {
  portfolio: { mode: "bp", entries: [] },
  a: [],
  b: [],
  problem: null,
  ready: false,
};

const PROBLEMS: Record<string, string> = {
  "unknown-version":
    "That link was made by a different version of UnpackFund, so it was not opened.",
  malformed: "That link is damaged, so no portfolio was loaded.",
  "invalid-entry":
    "That link contains a holding this app cannot read, so nothing was loaded.",
  "too-long": "That link is longer than any portfolio should be, so it was not opened.",
};

const EVENT = "unpackfund:fragment";

let cached: FragmentSnapshot | null = null;

function read(): FragmentSnapshot {
  if (typeof window === "undefined") return UNREAD;
  const result = decodeComparison(window.location.hash);
  if (result.ok) {
    return {
      portfolio: result.portfolio,
      a: result.a,
      b: result.b,
      problem: null,
      ready: true,
    };
  }
  if (result.reason === "empty") {
    return { ...UNREAD, ready: true };
  }
  return {
    ...UNREAD,
    problem: PROBLEMS[result.reason] ?? "That link could not be opened.",
    ready: true,
  };
}

export function getSnapshot(): FragmentSnapshot {
  cached ??= read();
  return cached;
}

export function getServerSnapshot(): FragmentSnapshot {
  return UNREAD;
}

export function subscribe(listener: () => void): () => void {
  const refresh = () => {
    cached = null;
    listener();
  };
  window.addEventListener("hashchange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener(EVENT, refresh);
  return () => {
    window.removeEventListener("hashchange", refresh);
    window.removeEventListener("popstate", refresh);
    window.removeEventListener(EVENT, refresh);
  };
}

/**
 * Replace the fragment without adding a history entry.
 *
 * A sequence of weight edits would otherwise fill the Back button with
 * intermediate portfolios, and Back should return to wherever the visitor came
 * from. Passing `replace: false` keeps a user bisecting portfolios in control.
 */
export function write(portfolio: Portfolio, options: { replace?: boolean } = {}): void {
  const entries = portfolio.entries;
  const hash = entries.length === 0 ? "" : `#${encodePortfolio(portfolio)}`;
  commit(hash, { ...portfolio, entries }, [], options);
}

/**
 * Write both comparison sides. A second side with no funds collapses to a v1
 * fragment, so a comparison that only has one side is just a portfolio — one view,
 * one URL shape.
 */
export function writeComparison(
  a: FundWeight[],
  b: FundWeight[],
  options: { replace?: boolean } = {},
): void {
  const sideA = sortFunds(a);
  const sideB = sortFunds(b);
  const hash = sideA.length === 0 ? "" : `#${encodeComparison(sideA, sideB)}`;
  // `a` is also the ledger's portfolio, in the only form `/compare` can produce:
  // funds at basis points.
  const portfolio: Portfolio = {
    mode: "bp",
    entries: sideA.map((entry) => ({
      kind: "fund" as const,
      key: entry.ticker,
      amount: entry.weight_bp,
    })),
  };
  commit(hash, portfolio, sideB, options, sideA);
}

function sortFunds(entries: FundWeight[]): FundWeight[] {
  return [...entries].sort((x, y) =>
    x.ticker < y.ticker ? -1 : x.ticker > y.ticker ? 1 : 0,
  );
}

function commit(
  hash: string,
  portfolio: Portfolio,
  b: FundWeight[],
  options: { replace?: boolean },
  a?: FundWeight[],
): void {
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (options.replace === false) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
  cached = {
    portfolio,
    a: a ?? fundsOf(portfolio),
    b,
    problem: null,
    ready: true,
  };
  window.dispatchEvent(new Event(EVENT));
}

/** The fund-only projection of a portfolio, for the comparison column. */
function fundsOf(portfolio: Portfolio): FundWeight[] {
  return sortFunds(fundWeights(portfolio));
}
