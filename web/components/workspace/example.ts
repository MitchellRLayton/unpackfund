/**
 * The one worked example: seven real funds, equal-weighted, labelled, never recommended.
 *
 * The empty state has to answer "what does this do?" without a screenshot, and the only
 * honest way to answer it is to show a portfolio the app can actually read. So this is a
 * real one — seven funds the release publishes — written as ordinary entries and rendered
 * by the same components as anything the visitor types. Nothing about it is special-cased
 * downstream; the example is only special on this screen.
 *
 * **Why this set.** It is a representative mash rather than a considered portfolio: a
 * broad index fund, a mega-cap growth index, a semiconductor fund and several
 * growth/technology funds whose largest holdings are the same handful of large-cap growth
 * and AI names. That overlap is the point — the example exists to show the app finding it,
 * which a list of funds that held different companies would not demonstrate.
 *
 * Two constraints on the numbers:
 *
 * - **They are the app's own equal split.** `equalWeights` produces them, so the example
 *   is exactly what the app's equal split of these seven tickers produces — not a
 *   hand-typed set of percentages that could drift from it. `example.test.ts` pins the
 *   count, the order, the integers and the 10,000 sum, so a later edit cannot leave the
 *   example half-allocated.
 * - **The chosen funds are not a claim.** Nothing here says "good", "balanced", "core" or
 *   "recommended", and the label is the operator's exact sentence. A portfolio shown as an
 *   illustration is not advice, but it is close enough that the label has to do real work.
 */

import { equalWeights } from "@/lib/fragment";
import type { PortfolioEntry } from "@/lib/types";

/**
 * The label that must appear wherever the example does. Pinned by a test: it is the line
 * that keeps an illustration from reading as a suggestion, so it is a constant rather
 * than three hand-typed copies.
 */
export const EXAMPLE_LABEL = "Example portfolio, not a recommendation.";

/**
 * The seven funds, in the order the example shows them.
 *
 * Exported because the worked example fetches exactly these and the tests assert the
 * order; one list is what stops the amounts and the tickers disagreeing.
 */
export const EXAMPLE_TICKERS: string[] = [
  "QQQ",
  "VOO",
  "SMH",
  "VGT",
  "RSPT",
  "ARKK",
  "ALAI",
];

/**
 * The example's holdings: 14.29% each for the first four, 14.28% for the last three —
 * integer basis points summing to exactly 10,000, from the app's own equal split. The
 * remainder goes to the first entries rather than being dropped, so the total is whole
 * and no row is rounded away.
 */
export const EXAMPLE_ENTRIES: readonly PortfolioEntry[] = equalWeights(EXAMPLE_TICKERS);

/**
 * Whether a portfolio *is* the example, exactly.
 *
 * The label ("Example portfolio, not a recommendation.") has to follow the example out
 * of the empty state, or the same seven funds would be labelled on one screen and
 * presented as the visitor's own view on the next. Deriving it from the entries rather
 * than from a flag is what makes it survive a reload: the fragment holds the holdings,
 * not the history of where they came from. The moment an amount, a row, its order or the
 * mode changes, the label is gone — which is correct, because the portfolio is no longer
 * the example.
 *
 * The cost is a false positive for a visitor who independently enters this exact even
 * split of these seven funds in this order. The label says "example", never
 * "recommendation", so the mistake is a mild oddity rather than a claim about their money.
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
