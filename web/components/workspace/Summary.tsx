"use client";

/**
 * The answer, as a box a reader can scan.
 *
 * The prose this replaces was four paragraphs and a note — accurate, and about twenty
 * lines tall, which pushed the one thing the page is for (the five tables) below the fold.
 * So the same facts are printed as a headline and five rows: a label, and the numbers
 * behind it. Nothing is computed here. `answer.ts` builds both renderings from one set of
 * ledger fields, so the box on screen and the prose on the printed page cannot disagree
 * about the same portfolio.
 *
 * **The prose is not gone, it is the fallback.** An empty, loading or incomplete portfolio
 * has a sentence to say and no numbers to put in rows — "Your percentages add up to
 * 90.00%, with 10.00% accounting for nothing" is not a table — so `highlights` is empty
 * for those states and this component renders `AnswerStrip` instead. That is also why the
 * printed page still uses `AnswerStrip` directly: paper has no fold to get under.
 *
 * **The labels are glossary terms.** Every row's label is a word the site defines —
 * "10 largest", "Markets", "Effective", "Overlap", "Coverage" — so each one is a `Term`
 * and the definition is a keystroke away, exactly as it was in the prose. The two counts
 * inside the Effective row keep their own terms, because "core" and "breadth" are the
 * words a reader actually has to look up.
 *
 * The heading is visually hidden for the same reason it is in `AnswerStrip`: the headline
 * is the heading a reader wants, and a screen-reader user still gets a landmark name.
 */

import type { ReactNode } from "react";

import { Term } from "@/components/prose/Term";
import type { EffectiveHoldings } from "@/lib/effective-holdings";

import { AnswerStrip, Parts } from "./AnswerStrip";
import type { Answer } from "./answer";

export function Summary({
  answer,
  effective,
  children,
}: {
  answer: Answer;
  /**
   * The ledger's effective-holdings pair, for the prose fallback. Optional and `null`
   * when there is no ledger, so the fallback still renders for an empty or loading
   * portfolio.
   */
  effective?: EffectiveHoldings | null;
  /** Anything that belongs with the answer but is not a row: a label, a link. */
  children?: ReactNode;
}) {
  if (answer.highlights.length === 0) {
    return (
      <AnswerStrip answer={answer} effective={effective}>
        {children}
      </AnswerStrip>
    );
  }

  const headline = answer.sentences[0];

  return (
    <section className="stack stack--tight" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="visually-hidden">
        What you own
      </h2>
      <div className="card summary-box">
        {headline ? (
          <p className="summary-box__headline">
            <Parts parts={headline.parts} />
          </p>
        ) : null}
        <dl className="summary-box__rows">
          {answer.highlights.map((row) => (
            <div className="summary-box__row" key={row.label}>
              <dt className="summary-box__label">
                {row.term ? <Term name={row.term}>{row.label}</Term> : row.label}
              </dt>
              <dd className="summary-box__value">
                <Parts parts={row.parts} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {children}
    </section>
  );
}
