import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Answer } from "./answer";
import { Summary } from "./Summary";

/**
 * The box that replaced the answer's paragraphs.
 *
 * What is pinned here is the shape, not the numbers: the numbers are `answer.ts`'s and
 * are pinned in `answer.test.ts`. This file checks the three things the component itself
 * decides — that the first sentence becomes the headline and the rest become rows, that
 * every label and every defined word is a real glossary control rather than dead text,
 * and that a state with nothing to tabulate falls back to the prose instead of rendering
 * an empty box.
 */

afterEach(cleanup);

const READY: Answer = {
  sentences: [
    { parts: [{ text: "You own " }, { strong: "8" }, { text: " companies." }] },
  ],
  note: [{ text: "Coverage " }, { strong: "96.0% covered" }],
  highlights: [
    {
      label: "Largest",
      term: "top-10",
      parts: [{ strong: "9.4%" }, { text: " of the mix" }],
    },
    {
      label: "Effective",
      term: "effective-holdings",
      parts: [{ strong: "429" }, { text: " at the " }, { text: "core", term: "core" }],
    },
  ],
};

describe("Summary — the answer as a box", () => {
  it("prints the first sentence as the headline and the rest as rows", () => {
    const { container } = render(<Summary answer={READY} />);

    expect(container.querySelector(".summary-box__headline")?.textContent).toBe(
      "You own 8 companies.",
    );
    const labels = Array.from(container.querySelectorAll(".summary-box__label")).map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Largest", "Effective"]);
    // The note is a row now, so the prose note is not printed a second time.
    expect(container.querySelector(".answer__note")).toBeNull();
  });

  it("pairs every label with its value in a description list", () => {
    const { container } = render(<Summary answer={READY} />);

    const rows = Array.from(container.querySelectorAll(".summary-box__row"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector("dt")).not.toBeNull();
      expect(row.querySelector("dd")).not.toBeNull();
    }
    expect(container.querySelector(".summary-box__value")?.textContent).toBe(
      "9.4% of the mix",
    );
  });

  it("makes every label and every defined word a glossary control", () => {
    const { container } = render(<Summary answer={READY} />);

    const terms = Array.from(container.querySelectorAll(".term"));
    expect(terms.map((term) => term.textContent)).toEqual([
      "Largest",
      "Effective",
      "core",
    ]);
    // A term is a control with a definition behind it, never a dead word.
    for (const term of terms) {
      expect(term.hasAttribute("href") || term.hasAttribute("popovertarget")).toBe(true);
    }
  });

  it("falls back to the prose when there is nothing to tabulate", () => {
    const { container } = render(
      <Summary
        answer={{
          sentences: [{ parts: [{ text: "Reading 2 filings." }] }],
          note: null,
          highlights: [],
        }}
      />,
    );

    expect(container.querySelector(".summary-box")).toBeNull();
    expect(container.querySelector(".answer")?.textContent).toContain(
      "Reading 2 filings.",
    );
  });

  it("renders nothing at all when the answer has nothing to say", () => {
    const { container } = render(
      <Summary answer={{ sentences: [], note: null, highlights: [] }} />,
    );

    expect(container.innerHTML).toBe("");
  });
});
