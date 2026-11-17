"use client";

/**
 * The one fact the old "What you own" card carried that no metric tab shows.
 *
 * The strip's Companies tab says how many companies and what the portfolio behaves
 * like; it has no room for the ten largest share and the largest name. That fact is the
 * card's headline claim, so it moves to the top of the lens it belongs to rather than
 * being dropped — and it keeps its glossary term, which is what the card's label was.
 *
 * The sentence itself comes from `topTenFact` in `answer.ts`, the same function the
 * printed answer uses, so the panel and the paper cannot disagree.
 */

import { Term } from "@/components/prose/Term";
import type { Ledger } from "@/lib/types";

import { Parts } from "@/components/workspace/AnswerStrip";
import { topTenFact } from "@/components/workspace/answer";

export function ConcentrationLine({ ledger }: { ledger: Ledger }) {
  const fact = topTenFact(ledger);
  if (fact === null) return null;

  return (
    <p className="small muted">
      {fact.term ? <Term name={fact.term}>{fact.label}</Term> : fact.label}{" "}
      <Parts parts={fact.parts} />
    </p>
  );
}
