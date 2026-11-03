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
 * The heading is visually hidden because the sentences are the heading a reader wants;
 * a screen-reader user still gets a landmark name for the section.
 */

import type { ReactNode } from "react";

import type { Answer, AnswerPart } from "./answer";

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
  children,
}: {
  answer: Answer;
  /** Anything that belongs with the answer but is not a sentence: a label, a link. */
  children?: ReactNode;
}) {
  const hasSentences = answer.sentences.length > 0;
  if (!hasSentences && answer.note === null && !children) return null;

  return (
    <section className="stack stack--tight" aria-labelledby="answer-heading">
      <h2 id="answer-heading" className="visually-hidden">
        What you own
      </h2>
      {hasSentences ? (
        <div className="answer">
          {answer.sentences.map((sentence, index) => (
            <p className="answer__sentence" key={index}>
              <Parts parts={sentence.parts} />
            </p>
          ))}
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
