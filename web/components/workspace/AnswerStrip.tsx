"use client";

/**
 * The answer, at the top of the results column.
 *
 * The sentences are built by `answer.ts` and arrive here as runs of text with
 * emphasised numbers, so this component has one job: put them in one block, with the
 * coverage note underneath at the smaller weight. No sentence is assembled here, and
 * nothing here decides what to say — an empty answer renders nothing at all rather
 * than a heading over an empty space.
 *
 * The effective-holdings sentence is the one exception, and it is deliberate: it is the
 * pair of equal-sized-holdings counts the ledger carries as a computed object
 * (`ledger.effective`), and this strip is the first place on the page the pair is named.
 * It is written here so the numbers, the three defined terms and the sentence that
 * introduces them cannot drift apart — and it renders only when the maths produced both
 * counts, so a withheld pair (coverage below 60%) adds no sentence and no zero. The
 * second sentence appears only when overlap moved the core count by a tenth or more; that
 * threshold reads the unrounded values, never the printed ones.
 *
 * The heading is visually hidden because the sentences are the heading a reader wants;
 * a screen-reader user still gets a landmark name for the section.
 */

import type { ReactNode } from "react";

import { Term } from "@/components/prose/Term";
import type { EffectiveHoldings } from "@/lib/effective-holdings";
import { formatCount, formatEffective } from "@/lib/format";

import type { Answer, AnswerPart } from "./answer";

/** Overlap must move the core count by this factor before the strip spends a sentence on it. */
const OVERLAP_NOTABLE = 1.1;

function Parts({ parts }: { parts: readonly AnswerPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.strong !== undefined ? (
          <strong key={index}>{part.strong}</strong>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function AnswerStrip({
  answer,
  effective,
  children,
}: {
  answer: Answer;
  /**
   * The ledger's effective-holdings pair. Optional, and `null` when there is no ledger, so
   * the strip still renders for an empty or loading portfolio and for a printed summary of
   * either.
   */
  effective?: EffectiveHoldings | null;
  /** Anything that belongs with the answer but is not a sentence: a label, a link. */
  children?: ReactNode;
}) {
  const core = effective?.core ?? null;
  const broad = effective?.broad ?? null;
  const coreDisjoint = effective?.coreDisjoint ?? null;
  const companies = effective?.companies ?? 0;

  const hasSentences = answer.sentences.length > 0;
  if (!hasSentences && core === null && answer.note === null && !children) return null;

  return (
    <section className="stack stack--tight" aria-labelledby="answer-heading">
      <h2 id="answer-heading" className="visually-hidden">
        What you own
      </h2>
      {hasSentences || core !== null ? (
        <div className="answer">
          {answer.sentences.map((sentence, index) => (
            <p className="answer__sentence" key={index}>
              <Parts parts={sentence.parts} />
            </p>
          ))}
          {core !== null && broad !== null ? (
            <>
              <p className="answer__sentence">
                Your <strong>{formatCount(companies)}</strong>{" "}
                {companies === 1 ? "company acts" : "companies act"} like{" "}
                <strong>{formatEffective(core)}</strong>{" "}
                <Term name="effective-holdings">equal-sized holdings</Term> at the{" "}
                <Term name="core">core</Term>, and{" "}
                <strong>{formatEffective(broad)}</strong> counting{" "}
                <Term name="broad">breadth</Term>.
              </p>
              {coreDisjoint !== null && coreDisjoint >= OVERLAP_NOTABLE * core ? (
                <p className="answer__sentence">
                  Overlap between your funds brings the core count down from{" "}
                  <strong>{formatEffective(coreDisjoint)}</strong>.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {answer.note ? (
        <p className="answer__note">
          <Parts parts={answer.note} />
        </p>
      ) : null}
      {children}
    </section>
  );
}
