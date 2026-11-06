/**
 * The effective-holdings sentence in the answer strip.
 *
 * Two rules are easy to get wrong and invisible in a screenshot: the sentence is absent
 * when the maths withheld the pair, and the overlap sentence is a *threshold* on the two
 * core counts (a tenth), not on their printed values. Both are asserted here against the
 * operator's acceptance fixtures, built through the real `effectiveHoldings()`.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { effectiveHoldings } from "@/lib/effective-holdings";

import type { Answer } from "./answer";
import { AnswerStrip } from "./AnswerStrip";

afterEach(cleanup);

/** A strip with no sentences of its own, so only the new pair can appear in the text. */
const NOTHING: Answer = { sentences: [], note: null, highlights: [] };

function company(weight: number, ...sources: number[]) {
  return { weight, sources: sources.map((source) => ({ weight: source })) };
}

/** Fixture 5, the merge case: Core 1.5, Broad 1.6, and 2.6 without the merge. */
const MERGED = effectiveHoldings({
  companies: [company(0.8, 0.3, 0.5), company(0.2, 0.2)],
  unmatchedWeight: 0,
  unmatchedPositions: 0,
});

/** Fixture 8: every source is a company, so the pair and the disjoint pair are the same. */
const UNSHARED = effectiveHoldings({
  companies: [company(0.5, 0.5), company(0.3, 0.3)],
  unmatchedWeight: 0.2,
  unmatchedPositions: 4,
});

describe("the effective-holdings sentence", () => {
  it("names the pair, and marks the three defined terms where they first appear", () => {
    const { container } = render(<AnswerStrip answer={NOTHING} effective={MERGED} />);

    expect(container.textContent).toContain(
      "Your 2 companies act like 1.5 equal-sized holdings at the core, and 1.6 counting breadth.",
    );
    const terms = Array.from(container.querySelectorAll(".term"));
    expect(terms.map((term) => term.textContent)).toEqual([
      "equal-sized holdings",
      "core",
      "breadth",
    ]);
    expect(
      terms.every(
        (term) => term.hasAttribute("href") || term.hasAttribute("popovertarget"),
      ),
    ).toBe(true);
  });

  it("spends the overlap sentence only when funding brought the core count down a tenth", () => {
    const merged = render(<AnswerStrip answer={NOTHING} effective={MERGED} />);
    expect(merged.container.textContent).toContain(
      "Overlap between your funds brings the core count down from 2.6.",
    );
    merged.unmount();

    // Fixture 8: no company is reached twice, so the pair already is the disjoint pair.
    // A sentence saying overlap moved something would be false.
    const unshared = render(<AnswerStrip answer={NOTHING} effective={UNSHARED} />);
    expect(unshared.container.textContent).toContain("Your 2 companies act like 1.9");
    expect(unshared.container.textContent).not.toContain(
      "Overlap between your funds brings the core count down",
    );
  });

  it("says company in the singular when the portfolio holds one", () => {
    const single = effectiveHoldings({
      companies: [company(1, 1)],
      unmatchedWeight: 0,
      unmatchedPositions: 0,
    });
    const { container } = render(<AnswerStrip answer={NOTHING} effective={single} />);

    expect(container.textContent).toContain(
      "Your 1 company acts like 1.0 equal-sized holdings",
    );
  });

  it("adds nothing at all when coverage withheld the pair", () => {
    const withheld = effectiveHoldings({
      companies: [company(0.5, 0.5)],
      unmatchedWeight: 0.5,
      unmatchedPositions: 2,
    });
    const { container } = render(<AnswerStrip answer={NOTHING} effective={withheld} />);

    expect(withheld.band).toBe("none");
    expect(withheld.core).toBeNull();
    // No sentences, no note, no children: the strip renders nothing rather than a heading.
    expect(container.innerHTML).toBe("");
  });

  it("keeps the sentences the answer builder wrote, in order, above the new pair", () => {
    const answer: Answer = {
      sentences: [
        { parts: [{ text: "Your " }, { strong: "8" }, { text: " companies." }] },
      ],
      note: null,
      highlights: [],
    };
    const { container } = render(<AnswerStrip answer={answer} effective={MERGED} />);
    const sentences = Array.from(container.querySelectorAll(".answer__sentence"));

    // The builder's sentence, then the pair, then the overlap sentence it earns.
    expect(sentences).toHaveLength(3);
    expect(sentences[0]?.textContent).toBe("Your 8 companies.");
    expect(sentences[1]?.textContent).toContain("act like 1.5 equal-sized holdings");
    expect(sentences[2]?.textContent).toContain("down from 2.6");
  });
});
