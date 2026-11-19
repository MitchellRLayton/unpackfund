"use client";

/**
 * What the results column says until the visitor submits the portfolio.
 *
 * Results are the answer to a whole portfolio the visitor has put forward: a lens drawn
 * from a half-entered list is a table of a different portfolio. So with holdings on the
 * page but nothing submitted, this card stands where the lenses would be. It opens with
 * one sentence that carries a number (the answer-first rule) and names the next step
 * inside the tool; it never advises.
 */

import { formatCents, formatCount, formatWeightBp } from "@/lib/format";
import type { PortfolioState } from "@/lib/use-portfolio";

import styles from "./Workspace.module.css";

/** The one sentence. Pure, so a test can read it without rendering the page. */
export function placeholderSentence(portfolio: PortfolioState): string {
  const rows = portfolio.entries.length;
  const holdings = `${formatCount(rows)} ${rows === 1 ? "holding" : "holdings"}`;
  if (portfolio.complete) {
    const total =
      portfolio.mode === "bp"
        ? formatWeightBp(portfolio.total)
        : formatCents(portfolio.total);
    return `Your ${holdings} total ${total}. Press Show results to see the companies inside them.`;
  }
  if (portfolio.mode === "bp") {
    return portfolio.overBp > 0
      ? `Your ${holdings} total ${formatWeightBp(portfolio.total)}, ${formatWeightBp(portfolio.overBp)} over 100%. Results open once they total exactly 100% and you press Show results.`
      : `${formatWeightBp(portfolio.unallocatedBp)} of your portfolio has no holding yet. Results open once it totals 100% and you press Show results.`;
  }
  return `None of your ${holdings} has an amount yet. Results open once one does and you press Show results.`;
}

export function ResultsPlaceholder({
  portfolio,
  onShowResults,
}: {
  portfolio: PortfolioState;
  onShowResults: () => void;
}) {
  return (
    <section className="stack stack--loose" aria-labelledby="results-waiting-heading">
      <div className="empty">
        <h2 id="results-waiting-heading" className="empty__title">
          Results appear when you submit
        </h2>
        <p className="muted">{placeholderSentence(portfolio)}</p>
        {portfolio.complete ? (
          <div className={styles.helpers}>
            <button type="button" className="btn btn--primary" onClick={onShowResults}>
              Show results
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
