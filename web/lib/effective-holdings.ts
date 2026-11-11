/**
 * Effective holdings: the pair of equal-sized-holdings counts, "Core" and "Broad".
 *
 * Both answer one question — how many equal-sized holdings would spread this money as
 * evenly as the portfolio actually spreads it — and they answer it differently on
 * purpose. Core counts the large positions, so a handful of big names pull it down
 * fast; Broad counts everything, giving small positions partial credit. Neither says
 * anything about how companies move together, and neither is a risk measure.
 *
 * The arithmetic is `lookthrough-math-and-qa` §1 applied twice. Everything here works
 * on **merged** company weights: a company held through three funds is one company with
 * one weight, because the whole point of the pair is what a holder owns, not how many
 * filings said so. That merge is what makes the two "disjoint" counts meaningful — they
 * are the same arithmetic over the unmerged pieces, so the gap between the two pairs is
 * exactly what overlap removed.
 *
 * Conventions this file is the single home for:
 * - **The denominator is T, the matched company weight**, not NAV. `s_i = w_i / T` sums
 *   to 1, which is what makes the counts read as "equal-sized holdings". Cash is outside
 *   both the numerator and T, so adding cash cannot move either count.
 *
 *   There is an older figure in this codebase with the same intent and a different
 *   denominator: `FundDocument.metrics.effective_n` in the release, and `LedgerMetrics`
 *   computed from it, are `1/Σwᵢ²` with no renormalisation — the fund page's own note
 *   calls that "NAV, as filed", and it is the right number for "how many equal-sized
 *   companies is *this fund* spread across" because the fund really does hold cash. For a
 *   portfolio it is not the same question: `Σwᵢ² = T² · Σsᵢ²`, so that figure is
 *   `Core / T²` and moves when an unrelated fund's coverage moves. Core is defined over
 *   the money that resolved, on purpose; the two agree exactly only when `T = 1`. That
 *   relationship is asserted rather than assumed — see `effective-holdings.real.test.ts`.
 * - **Cash, money-market sweeps and derivatives are not companies** and never enter the
 *   shares. An unresolved *security* is different: it is company-like money the release
 *   could not name, so it stays out of the shares but stays in `Q` and therefore lowers
 *   coverage. It is never promoted to a company of its own.
 * - **A negative weight is a real exposure and an excluded one.** `Σ s²` would reward a
 *   short by shrinking the other shares, so shorts are dropped and counted, not silently
 *   netted.
 * - **`0 · ln 0 = 0`**, which is the only value that keeps H continuous as a share
 *   approaches zero.
 * - **Unrounded float64 throughout, summed in ascending order** (math §6: a displayed
 *   total comes from exact values, never from summing rounded ones). Ascending order
 *   rather than the input order because the input order is the visitor's holdings order,
 *   and the same mix typed in a different order must produce the same bits.
 */

import { coverageBand, type CoverageBand } from "./format";
import type { FundDocument, Ledger } from "./types";

/** Companies that scrape into a top ten; the share uses the ten largest by weight. */
const MAX_TOP = 10;

/** Tallies a float64 sum from the smallest term upward; see the module note. */
function sumAscending(terms: readonly number[]): number {
  const sorted = terms.slice().sort((a, b) => a - b);
  let total = 0;
  for (const term of sorted) total += term;
  return total;
}

export interface EffectiveInput {
  /**
   * Merged company weights, each with the per-source contributions that produced it.
   * `sources` is what the disjoint pair is computed from; a company's `weight` is
   * exactly the sum of its sources (minus any short, which is excluded separately).
   */
  companies: ReadonlyArray<{
    weight: number;
    sources: ReadonlyArray<{ weight: number }>;
  }>;
  /** Weight of company-like positions the release could not name. */
  unmatchedWeight: number;
  /** How many such positions there were. */
  unmatchedPositions: number;
  /** Weight in cash, money-market sweeps and derivatives — never a company. */
  excludedNonCompanyWeight?: number;
}

export interface EffectiveHoldings {
  /**
   * Every number below is `null` when coverage is below 60%: the site's rule is that a
   * figure computed over a minority of the money is not shown at all, because it would
   * describe a different portfolio (`static-xray-frontend` §4a).
   */
  core: number | null;
  broad: number | null;
  coreDisjoint: number | null;
  broadDisjoint: number | null;
  /** Evidence layer: the ten largest companies' share of each count's total. */
  topTenConcentrationShare: number | null;
  topTenBreadthShare: number | null;
  /** How many equal-sized holdings over the whole portfolio: unmatched weight counted
   *  once (lower bound) and as `unmatchedPositions` equal parts (upper). Both bounds
   *  divide by `Q = T + u`, so this is not a bracket of `core`. Evidence layer only. */
  coreRange: readonly [number, number] | null;
  broadRange: readonly [number, number] | null;
  /** Companies included — the ceiling for both counts. */
  companies: number;
  /** `Σ sᵢ²` over shares, unrounded. */
  hhi: number | null;
  /** `−Σ sᵢ ln sᵢ` in nats, unrounded. */
  entropy: number | null;
  /** `T`, the weight that resolved to a company. */
  matchedWeight: number;
  /** `u`, the company-like weight that did not resolve. */
  unmatchedWeight: number;
  unmatchedPositions: number;
  /** Cash, sweeps and derivatives — outside both `T` and `Q`. */
  excludedNonCompanyWeight: number;
  /** Negative weights dropped from the shares, and how many there were. */
  negativeWeight: number;
  negativePositions: number;
  /** `T / (T + u)`, in percent. */
  coveragePct: number;
  band: CoverageBand;
}

/** An input that cannot produce a count: no matched company weight at all. */
const EMPTY: EffectiveHoldings = {
  core: null,
  broad: null,
  coreDisjoint: null,
  broadDisjoint: null,
  topTenConcentrationShare: null,
  topTenBreadthShare: null,
  coreRange: null,
  broadRange: null,
  companies: 0,
  hhi: null,
  entropy: null,
  matchedWeight: 0,
  unmatchedWeight: 0,
  unmatchedPositions: 0,
  excludedNonCompanyWeight: 0,
  negativeWeight: 0,
  negativePositions: 0,
  coveragePct: 0,
  band: "none",
};

/**
 * `−Σ p ln p` for one share, with `0 · ln 0` defined as 0.
 *
 * Written as a branch rather than relying on `0 * -Infinity` being `NaN`, because the
 * arithmetic has to be true before the guard can be relied on: a zero share is absent,
 * not infinitesimal.
 */
function entropyTerm(share: number): number {
  return share > 0 ? -share * Math.log(share) : 0;
}

/**
 * The pair, and everything the evidence layer needs to explain it.
 *
 * One function, three callers: the workspace ledger, the overlap engine's per-side
 * ledgers, and a single fund's own page (where "the portfolio" is a 100% holding of that
 * fund, so the fund's own weights are the shares).
 */
export function effectiveHoldings(input: EffectiveInput): EffectiveHoldings {
  const positive: number[] = [];
  const sources: number[] = [];
  let negativeWeight = 0;
  let negativePositions = 0;

  for (const company of input.companies) {
    if (company.weight > 0) {
      positive.push(company.weight);
      for (const source of company.sources) {
        if (source.weight > 0) sources.push(source.weight);
      }
    } else if (company.weight < 0) {
      negativeWeight += company.weight;
      negativePositions += 1;
    }
  }

  const matchedWeight = sumAscending(positive);
  const unmatchedWeight = Math.max(0, input.unmatchedWeight);
  const excludedNonCompanyWeight = Math.max(0, input.excludedNonCompanyWeight ?? 0);
  const unmatchedPositions = Math.max(0, input.unmatchedPositions);

  if (positive.length === 0 || !(matchedWeight > 0)) {
    return {
      ...EMPTY,
      matchedWeight,
      unmatchedWeight,
      unmatchedPositions,
      excludedNonCompanyWeight,
      negativeWeight,
      negativePositions,
      coveragePct: 0,
      band: "none",
    };
  }

  // The whole-portfolio denominator. Cash is outside both terms on purpose: a reader who
  // holds 80% of a fund and 20% cash holds the same companies as one who holds 100% of
  // that fund, so the counts must not move.
  const totalWeight = matchedWeight + unmatchedWeight;
  const coveragePct = totalWeight > 0 ? (100 * matchedWeight) / totalWeight : 0;
  const band = coverageBand(coveragePct);

  const shares = positive.map((weight) => weight / matchedWeight);
  const sourceShares = sources.map((weight) => weight / matchedWeight);

  const hhi = sumAscending(shares.map((share) => share * share));
  const entropy = sumAscending(shares.map(entropyTerm));
  const hhiDisjoint = sumAscending(sourceShares.map((share) => share * share));
  const entropyDisjoint = sumAscending(sourceShares.map(entropyTerm));

  const core = hhi > 0 ? 1 / hhi : null;
  // `entropy` legitimately reaches 0 for a single company — one share of 1 contributes
  // `−1 · ln 1 = 0`, so `exp(0) = 1` is the right answer and must not be gated on `> 0`.
  // Only an empty portfolio has no entropy at all.
  const broad = entropy >= 0 ? Math.exp(entropy) : null;

  // The top ten by share. `shares` is parallel to `positive`, so sorting a copy of the
  // shares and taking the first ten is the same selection without carrying pairs around.
  const largest = shares
    .slice()
    .sort((a, b) => b - a)
    .slice(0, MAX_TOP);
  const topTenConcentration = sumAscending(largest.map((share) => share * share));
  const topTenBreadth = sumAscending(largest.map(entropyTerm));

  // The range over the whole portfolio: the same two counts with the unmatched weight
  // put back in, once as one holding (`[0]`, the most concentrated it can be) and once
  // split into `unmatchedPositions` equal ones (`[1]`, the most spread). Both
  // denominators are Q = T + u, not T, so this is a different pair of numbers from Core
  // and Broad by construction and neither bound is a bracket of them: renormalising to Q
  // moves the matched companies' shares too, so `[0]` can sit below Core — ten equal
  // names plus 2.5 unmatched is Core 10 against a floor of 9.615. Every other split of
  // the unmatched money lands between the two bounds, because Σx² is largest for one
  // holding and smallest for equal ones, and the entropy is the mirror image.
  const q = totalWeight > 0 ? totalWeight : 1;
  const qShares = positive.map((weight) => weight / q);
  const unmatchedShare = unmatchedWeight / q;
  const parts = Math.max(1, unmatchedPositions);

  const hhiOne = sumAscending([
    ...qShares.map((share) => share * share),
    unmatchedShare * unmatchedShare,
  ]);
  const hhiParts = sumAscending([
    ...qShares.map((share) => share * share),
    (unmatchedShare * unmatchedShare) / parts,
  ]);
  const entropyOne = sumAscending([
    ...qShares.map(entropyTerm),
    entropyTerm(unmatchedShare),
  ]);
  // `-x·ln(x/M)` written as `-x·(ln x - ln M)` rather than `-x·ln(x/M)`: dividing first
  // underflows to zero for an unmatched weight small enough, and `0 · ln 0` is the one
  // NaN this file is meant to be free of. The two forms are algebraically identical.
  const entropyParts = sumAscending([
    ...qShares.map(entropyTerm),
    // Guarded on the *share*, not the weight: a weight small enough to underflow when
    // divided by Q is below the resolution of the sum, and `ln 0` would poison it.
    unmatchedShare > 0
      ? -(unmatchedShare * (Math.log(unmatchedShare) - Math.log(parts)))
      : 0,
  ]);

  const withheld = band === "none";

  return {
    core: withheld ? null : core,
    broad: withheld ? null : broad,
    coreDisjoint: withheld || hhiDisjoint <= 0 ? null : 1 / hhiDisjoint,
    broadDisjoint: withheld ? null : Math.exp(entropyDisjoint),
    topTenConcentrationShare: withheld || hhi <= 0 ? null : topTenConcentration / hhi,
    topTenBreadthShare: withheld || entropy <= 0 ? null : topTenBreadth / entropy,
    coreRange:
      withheld || hhiOne <= 0 || hhiParts <= 0
        ? null
        : ([1 / hhiOne, 1 / hhiParts] as const),
    broadRange: withheld
      ? null
      : ([Math.exp(entropyOne), Math.exp(entropyParts)] as const),
    companies: positive.length,
    hhi,
    entropy,
    matchedWeight,
    unmatchedWeight,
    unmatchedPositions,
    excludedNonCompanyWeight,
    negativeWeight,
    negativePositions,
    coveragePct,
    band,
  };
}

/**
 * The ledger's pair, read off the rows the look-through already built.
 *
 * `securities_weight` is the company-like money the release could not name — the only
 * weight that lowers coverage — while cash and derivatives are excluded from both terms.
 */
export function effectiveHoldingsForLedger(
  ledger: Pick<Ledger, "rows" | "unmapped">,
): EffectiveHoldings {
  return effectiveHoldings({
    companies: ledger.rows,
    unmatchedWeight: ledger.unmapped.securities_weight,
    unmatchedPositions: ledger.unmapped.securities_with_weight,
    excludedNonCompanyWeight: ledger.unmapped.cash_and_derivatives_weight,
  });
}

/**
 * One fund's pair, for the Funds lens: the fund at 100% is its own portfolio.
 *
 * Two things differ from the ledger case and both are deliberate. Every traced company
 * is one source (`fund.ticker`), so the disjoint pair would equal the merged pair and is
 * left out rather than computed twice. And `asset_cat` is read the way the look-through
 * reads it: cash and derivatives are not companies, everything else without a
 * `company_id` is company-like money that did not resolve.
 */
export function effectiveHoldingsForFund(fund: FundDocument): EffectiveHoldings {
  const companies = new Map<string, { weight: number }>();
  let unmatchedWeight = 0;
  let unmatchedPositions = 0;
  let excluded = 0;

  for (const holding of fund.holdings) {
    if (holding.weight_bp === 0) continue;
    const weight = holding.weight_bp / 10_000;
    if (!holding.company_id) {
      if (holding.asset_cat === "cash" || holding.asset_cat === "derivative") {
        if (weight > 0) excluded += weight;
      } else if (weight > 0) {
        unmatchedWeight += weight;
        unmatchedPositions += 1;
      }
      continue;
    }
    const existing = companies.get(holding.company_id);
    if (existing) existing.weight += weight;
    else companies.set(holding.company_id, { weight });
  }

  return effectiveHoldings({
    companies: [...companies.values()].map((company) => ({
      weight: company.weight,
      sources: [company],
    })),
    unmatchedWeight,
    unmatchedPositions,
    excludedNonCompanyWeight: excluded,
  });
}
