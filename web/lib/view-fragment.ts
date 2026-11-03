/**
 * The whole view lives in the fragment: the portfolio, the open lens, and the
 * company being read.
 *
 * `fragment.ts` owns the portfolio codec and must keep decoding every link that
 * has ever been shared. This module adds the two pieces of *view* state the
 * redesign needs without touching that codec's payload, so a link written by the
 * old site still opens the same portfolio, and a link written here still opens
 * the same portfolio in the old site's decoder (which reads the part before the
 * first `~` and ignores the rest).
 *
 * Grammar — `~` is the separator because base64url never contains it:
 *
 *   #v3.<payload>                     portfolio, Companies lens
 *   #v3.<payload>~markets             portfolio, Markets lens
 *   #c_<company_id>                   a company page, no portfolio
 *   #c_<company_id>~v3.<payload>      a company page, with "you hold X%"
 *   #markets                          a lens with no portfolio yet
 *
 * Nothing here is sent to a server: the fragment is not part of an HTTP request,
 * which is the privacy guarantee the whole product rests on.
 */

import { decodePortfolio, encodePortfolio } from "./fragment";
import type { Portfolio } from "./types";

export const LENSES = ["companies", "markets", "funds", "overlap", "quality"] as const;
export type Lens = (typeof LENSES)[number];
export const DEFAULT_LENS: Lens = "companies";

export interface ViewState {
  /** `null` when the fragment carries no portfolio (a company page, or a bare lens). */
  portfolio: Portfolio | null;
  lens: Lens;
  /** A company id (`c_…` or `l_…`), or `null`. */
  companyId: string | null;
  /** Why a portfolio part failed to decode, when it did. */
  problem: string | null;
}

const COMPANY_RE = /^(?:c_\d{10}|l_[0-9a-f]{16})$/;

export function isLens(value: string): value is Lens {
  return (LENSES as readonly string[]).includes(value);
}

/** Split a hash into its `~`-separated parts, without interpreting them. */
function parts(hash: string): string[] {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return [];
  return raw.split("~").filter((part) => part.length > 0);
}

/**
 * The portfolio part of a fragment, exactly as it was written, or `null`.
 *
 * The store needs the raw part rather than the decoded portfolio because
 * `/compare` reads the same part through `decodeComparison`, which also returns
 * the two comparison sides.
 */
export function portfolioPart(hash: string): string | null {
  for (const part of parts(hash)) {
    if (/^v[123]\./.test(part)) return part;
  }
  return null;
}

/**
 * Read a fragment into the view it describes.
 *
 * A part that is neither a company id, a portfolio, nor a lens is ignored rather
 * than fatal: the fragment is user-editable text, and a stray character should
 * not blank the page. A portfolio part that *looks* like a portfolio but fails to
 * decode is reported in `problem`, because a dropped holding is a wrong answer
 * and the page has to say so.
 */
export function parseView(hash: string): ViewState {
  const state: ViewState = {
    portfolio: null,
    lens: DEFAULT_LENS,
    companyId: null,
    problem: null,
  };

  for (const part of parts(hash)) {
    if (COMPANY_RE.test(part)) {
      state.companyId = part;
      continue;
    }
    if (isLens(part)) {
      state.lens = part;
      continue;
    }
    if (/^v[123]\./.test(part)) {
      const decoded = decodePortfolio(part);
      if (decoded.ok) {
        state.portfolio = decoded.portfolio;
      } else if (decoded.reason !== "empty") {
        state.problem = decoded.reason;
      }
    }
  }

  return state;
}

/**
 * The fragment for a view. A portfolio with the default lens and no company
 * encodes to exactly what `fragment.ts` writes, so the common share link is
 * byte-identical to the one the old site produced.
 */
export function encodeView(state: {
  portfolio?: Portfolio | null;
  lens?: Lens;
  companyId?: string | null;
}): string {
  const out: string[] = [];
  if (state.companyId) out.push(state.companyId);
  if (state.portfolio && state.portfolio.entries.length > 0) {
    out.push(encodePortfolio(state.portfolio));
  }
  const lens = state.lens ?? DEFAULT_LENS;
  if (lens !== DEFAULT_LENS) out.push(lens);
  return out.join("~");
}

/** A full URL for the current view, for the share button and the address bar. */
export function viewUrl(base: string, state: Parameters<typeof encodeView>[0]): string {
  const path = base.split("#")[0] ?? "";
  const fragment = encodeView(state);
  return fragment.length > 0 ? `${path}#${fragment}` : path;
}
