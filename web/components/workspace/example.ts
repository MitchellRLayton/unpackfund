/**
 * The one worked example: a real portfolio, shown and labelled, never recommended.
 *
 * The empty state has to answer "what does this do?" without a screenshot, and the only
 * honest way to answer it is to show a portfolio the app can actually read. So this is a
 * real one — three funds the release publishes, weighted 60/30/10 — written as ordinary
 * entries and rendered by the same components as anything the visitor types. Nothing
 * about it is special-cased downstream; the example is only special on this screen.
 *
 * Two constraints on the numbers:
 *
 * - **They are percentages that add up to the whole.** `example.test.ts` pins the sum, so
 *   a later edit cannot leave the example half-allocated and teach the wrong shape.
 * - **The chosen funds are not a claim.** These are three widely held broad-market funds,
 *   which is why the label is the operator's exact sentence and why nothing here says
 *   "good", "balanced", "core" or "recommended". A portfolio shown as an illustration is
 *   not advice, but it is close enough that the label has to do real work.
 */

import type { PortfolioEntry } from "@/lib/types";

/**
 * The label that must appear wherever the example does. Pinned by a test: it is the line
 * that keeps an illustration from reading as a suggestion, so it is a constant rather
 * than three hand-typed copies.
 */
export const EXAMPLE_LABEL = "Example portfolio, not a recommendation.";

/** 60% VTI, 30% VXUS, 10% BND — integer basis points, summing to exactly 100%. */
export const EXAMPLE_ENTRIES: readonly PortfolioEntry[] = [
  { kind: "fund", key: "VTI", amount: 6_000 },
  { kind: "fund", key: "VXUS", amount: 3_000 },
  { kind: "fund", key: "BND", amount: 1_000 },
];

/**
 * Whether a portfolio *is* the example, exactly.
 *
 * The label ("Example portfolio, not a recommendation.") has to follow the example out
 * of the empty state, or the same three funds would be labelled on one screen and
 * presented as the visitor's own view on the next. Deriving it from the entries rather
 * than from a flag is what makes it survive a reload: the fragment holds the holdings,
 * not the history of where they came from. The moment an amount, a row or the mode
 * changes, the label is gone — which is correct, because the portfolio is no longer the
 * example.
 *
 * The cost is a false positive for a visitor who independently enters exactly 60/30/10
 * of these three funds. The label says "example", never "recommendation", so the mistake
 * is a mild oddity rather than a claim about their money.
 */
export function isExamplePortfolio(
  mode: string,
  entries: readonly { kind: string; key: string; amount: number }[],
): boolean {
  if (mode !== "bp" || entries.length !== EXAMPLE_ENTRIES.length) return false;
  return EXAMPLE_ENTRIES.every((expected, index) => {
    const actual = entries[index];
    return (
      actual !== undefined &&
      actual.kind === expected.kind &&
      actual.key === expected.key &&
      actual.amount === expected.amount
    );
  });
}
