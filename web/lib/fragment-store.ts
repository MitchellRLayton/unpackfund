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
 * Three shapes share one fragment, and they are not the same thing:
 *
 * - `portfolio` is the workspace's state — entries that can be funds, stocks, or
 *   cash, with a dollars-or-percent mode (v3).
 * - `a` and `b` are `/compare`'s two fund lists. Comparison is funds-only by design,
 *   so it keeps the v2/v1 shape, and a v3 link is projected onto it (its funds, at
 *   their portfolio weights).
 * - `lens` and `companyId` are *view* state: which lens is open, and which company
 *   page is being read. They ride in the same fragment (`view-fragment.ts`) so the
 *   whole view is one shareable URL and nothing about it reaches a server.
 *
 * One writer, deliberately: a weight edit must not drop the open lens, and a lens
 * change must not drop the portfolio. Both go through `commit`, which always
 * re-encodes the whole view from the snapshot it is about to publish.
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
import {
  DEFAULT_LENS,
  encodeView,
  parseView,
  portfolioPart,
  type Lens,
} from "./view-fragment";

export interface FragmentSnapshot {
  /** The portfolio the workspace shows. */
  portfolio: Portfolio;
  /** `/compare`'s first column. Always funds, always basis points. */
  a: FundWeight[];
  /** The second portfolio, only ever non-empty on `/compare`. */
  b: FundWeight[];
  /** Which lens the workspace has open. */
  lens: Lens;
  /** The company page being read, if any. */
  companyId: string | null;
  problem: string | null;
  /** `false` until the fragment has actually been read, on the client only. */
  ready: boolean;
}

const UNREAD: FragmentSnapshot = {
  portfolio: { mode: "bp", entries: [] },
  a: [],
  b: [],
  lens: DEFAULT_LENS,
  companyId: null,
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
  const hash = window.location.hash;
  const view = parseView(hash);
  const part = portfolioPart(hash);
  const result = part ? decodeComparison(part) : null;

  if (result && result.ok) {
    return {
      portfolio: result.portfolio,
      a: result.a,
      b: result.b,
      lens: view.lens,
      companyId: view.companyId,
      problem: null,
      ready: true,
    };
  }

  // A fragment with no portfolio part is a company page or a bare lens: a real
  // view, not a broken link.
  if (!part) {
    return {
      ...UNREAD,
      lens: view.lens,
      companyId: view.companyId,
      problem: view.problem ? (PROBLEMS[view.problem] ?? null) : null,
      ready: true,
    };
  }

  return {
    ...UNREAD,
    lens: view.lens,
    companyId: view.companyId,
    problem:
      (result && !result.ok && PROBLEMS[result.reason]) ??
      "That link could not be opened.",
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
  const current = getSnapshot();
  const entries = portfolio.entries;
  const hash =
    entries.length === 0
      ? current.lens === DEFAULT_LENS && !current.companyId
        ? ""
        : `#${encodeView({ lens: current.lens, companyId: current.companyId })}`
      : `#${encodeView({
          portfolio,
          lens: current.lens,
          companyId: current.companyId,
        })}`;
  commit(hash, { ...portfolio, entries }, current.b, options, undefined, {
    lens: current.lens,
    companyId: current.companyId,
  });
}

/** Open a lens. The portfolio and the company page are untouched. */
export function writeLens(lens: Lens, options: { replace?: boolean } = {}): void {
  const current = getSnapshot();
  const hash = `#${encodeView({
    portfolio: current.portfolio.entries.length > 0 ? current.portfolio : null,
    lens,
    companyId: current.companyId,
  })}`;
  commit(hash, current.portfolio, current.b, options, current.a, {
    lens,
    companyId: current.companyId,
  });
}

/** Open a company page, keeping the portfolio so the page can say "you hold X%". */
export function writeCompany(
  companyId: string | null,
  options: { replace?: boolean } = {},
): void {
  const current = getSnapshot();
  const hash = `#${encodeView({
    portfolio: current.portfolio.entries.length > 0 ? current.portfolio : null,
    lens: current.lens,
    companyId,
  })}`;
  commit(hash, current.portfolio, current.b, options, current.a, {
    lens: current.lens,
    companyId,
  });
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
  // The order is the visitor's, on both sides — the same rule the portfolio has had
  // since 2026-11-02. This writer used to alphabetise both lists, so `/compare`
  // re-ordered the funds the moment it wrote the link: a side typed VTI, VXUS, BND
  // came back BND, VTI, VXUS on the next render, and the two pages disagreed about
  // whether order is data. It is (`fragment.ts` header), so nothing here sorts.
  const sideA = [...a];
  const sideB = [...b];
  // A comparison with only a second side is still a comparison: `/compare` lets a
  // visitor start from an empty page and fill B first, and that state has to survive
  // a reload and a copied link. Only a comparison with nothing on either side is
  // the empty view, which is the bare path.
  const hash =
    sideA.length === 0 && sideB.length === 0 ? "" : `#${encodeComparison(sideA, sideB)}`;
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
  commit(hash, portfolio, sideB, options, sideA, {
    lens: DEFAULT_LENS,
    companyId: null,
  });
}

function commit(
  hash: string,
  portfolio: Portfolio,
  b: FundWeight[],
  options: { replace?: boolean },
  a?: FundWeight[],
  view: { lens: Lens; companyId: string | null } = {
    lens: DEFAULT_LENS,
    companyId: null,
  },
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
    lens: view.lens,
    companyId: view.companyId,
    problem: null,
    ready: true,
  };
  window.dispatchEvent(new Event(EVENT));
}

/**
 * The fund-only projection of a portfolio, for the comparison column.
 *
 * `fundWeights` already returns the portfolio's own order, and that order is the
 * visitor's — a portfolio dragged into a deliberate sequence arrives on `/compare`
 * in that sequence, not alphabetised.
 */
function fundsOf(portfolio: Portfolio): FundWeight[] {
  return fundWeights(portfolio);
}

/** Re-exported so a caller does not have to import two modules to encode a link. */
export { encodePortfolio };
