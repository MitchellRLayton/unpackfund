/**
 * The summary block, rendered from the operator's own acceptance fixtures.
 *
 * The numbers are not written down here as strings the component could drift away from:
 * each fixture is built through the real `effectiveHoldings()`, so a change to the maths
 * moves these assertions with it. What *is* written down is the expected reading — 5 is
 * the merge case (Core 1.5, Broad 1.6, and a disjoint pair above both), 8 is the coverage
 * case (two companies plus unmatched weight, Core 1.9), and 10 is the gap case (one large
 * position and 500 small ones: Core 4.0 against Broad 44.7, the shape no single number
 * describes).
 *
 * Three rules are checked that no eye can verify: the log positions, the lanes that keep
 * three labels apart when the scale collapses to a single point (N = 1), and the absence of
 * every figure below the 60% coverage floor — no ladder, no sentence, no `<details>`, and no
 * zero standing in for a withheld number.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { effectiveHoldings, type EffectiveInput } from "@/lib/effective-holdings";

import { EffectiveHoldingsSummary, ladderMarkers } from "./EffectiveHoldingsSummary";

afterEach(cleanup);

/** A company whose weight arrived through the listed sources. */
function company(weight: number, ...sources: number[]) {
  return { weight, sources: sources.map((source) => ({ weight: source })) };
}

function holdings(input: Partial<EffectiveInput> & Pick<EffectiveInput, "companies">) {
  return effectiveHoldings({ unmatchedWeight: 0, unmatchedPositions: 0, ...input });
}

/** Fixture 5: 50% of a fund holding X and Y, plus 50% of X held directly. */
const FIVE = holdings({ companies: [company(0.8, 0.3, 0.5), company(0.2, 0.2)] });

/** Fixture 8: two companies and 20% the release could not name, across four positions. */
const EIGHT = holdings({
  companies: [company(0.5, 0.5), company(0.3, 0.3)],
  unmatchedWeight: 0.2,
  unmatchedPositions: 4,
});

/** Fixture 10: one large position and five hundred small ones. */
const TEN = holdings({
  companies: [
    company(0.5, 0.5),
    ...Array.from({ length: 500 }, () => company(0.001, 0.001)),
  ],
});

function markers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-lane]"));
}

describe("the ladder", () => {
  it("prints each count on its own marker: 1.5, 1.6 and the ceiling of 2", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={FIVE} />);

    expect(markers(container).map((marker) => marker.textContent)).toEqual([
      "Core 1.5",
      "Broad 1.6",
      "Owned 2",
    ]);
    // The picture is decorative; the numbers reach a screen reader as a caption.
    expect(container.querySelector("figcaption")?.textContent).toBe(
      "On a log scale from 1 to 2 companies: Core 1.5, Broad 1.6, and 2 owned.",
    );
    expect(container.querySelector("figcaption")?.className).toContain("visually-hidden");
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  it("places a marker at log(value) / log(N), so equal distances are equal ratios", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={TEN} />);
    const [core, broad, owned] = markers(container);

    const width = (marker: HTMLElement) => Number.parseFloat(marker.style.left) / 100;
    expect(width(core!)).toBeCloseTo(Math.log(TEN.core!) / Math.log(TEN.companies), 2);
    expect(width(broad!)).toBeCloseTo(Math.log(TEN.broad!) / Math.log(TEN.companies), 2);
    expect(width(owned!)).toBeCloseTo(1, 2);
  });

  it("puts three coincident markers on three lanes when N is 1 and the scale collapses", () => {
    const single = holdings({ companies: [company(1, 1)] });
    const { container } = render(<EffectiveHoldingsSummary effective={single} />);
    const placed = markers(container);

    expect(placed.map((marker) => Number.parseFloat(marker.style.left))).toEqual([
      0, 0, 0,
    ]);
    expect(placed.map((marker) => marker.dataset.lane)).toEqual(["0", "1", "2"]);
    // All three sit at the left end, so none of them centres its label over the edge.
    expect(placed.map((marker) => marker.dataset.align)).toEqual([
      "start",
      "start",
      "start",
    ]);
  });

  it("grows an end label inward, so the ceiling cannot hang over the right edge", () => {
    const placed = ladderMarkers(4, 44.7, 501);

    expect(placed.map((marker) => marker.align)).toEqual(["middle", "middle", "end"]);
    expect(placed.map((marker) => marker.lane)).toEqual([0, 0, 0]);
  });

  it("staggers two labels that would collide at 320 px", () => {
    // Core 1.5 and Broad 1.6 sit 1.1% of the strip apart: one label's width is far more.
    const placed = ladderMarkers(1.470588235, 1.649384888, 501);

    expect(placed[0]?.lane).toBe(0);
    expect(placed[1]?.lane).toBe(1);
  });
});

describe("the sentences", () => {
  it("names what the ten largest carry, and the pair without overlap", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={FIVE} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Without overlap between your funds: Core 2.6, Broad 2.8.");
    // Two companies: a sentence about "the ten largest" would be a false claim.
    expect(text).not.toContain("The ten largest companies");
  });

  it("says the ten largest carry 99.8% of the concentration when there are 501", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={TEN} />);

    expect(container.textContent).toContain(
      "The ten largest companies make up 99.8% of the concentration behind the core count.",
    );
  });

  it("reads Core 1.9, Broad 1.9 when nothing was lost to overlap or coverage", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={EIGHT} />);
    const text = container.textContent ?? "";

    expect(markers(container).map((marker) => marker.textContent)).toEqual([
      "Core 1.9",
      "Broad 1.9",
      "Owned 2",
    ]);
    expect(text).toContain("Without overlap between your funds: Core 1.9, Broad 1.9.");
  });
});

describe("the evidence layer", () => {
  it("prints both formulas, HHI twice, H in nats and the top-heaviness", () => {
    const { container } = render(<EffectiveHoldingsSummary effective={TEN} />);
    const rows = Array.from(container.querySelectorAll("dl > div")).map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);

    expect(rows).toEqual([
      ["Core", "1 / Σ si²"],
      ["Broad", "exp(Σ −si ln si)"],
      ["HHI", "0.2505 · 2,505 points"],
      ["H", "3.8005 nats"],
      ["Broad / Core", "11.2 · top-heaviness"],
      ["Top ten, concentration", "99.8%"],
      ["Top ten, breadth", "10.8%"],
      ["Companies", "501"],
      ["Weight in companies", "100.00%"],
      ["Not companies", "0.00% (cash and derivatives)"],
      ["Unmatched", "0.00% in 0 positions"],
      ["Coverage", "100.0% of weight covered"],
      ["Core, whole portfolio", "4.0 to 4.0"],
      ["Broad, whole portfolio", "44.7 to 44.7"],
    ]);
    expect(container.querySelector("details")?.textContent).toContain(
      "si is each company's share of your matched company weight.",
    );
    // The three weight rows partition the portfolio but need not print as 100%, because
    // a fund's filed positions can total a little over its own NAV.
    expect(container.querySelector("details")?.textContent).toContain(
      "Each fund's filed positions can add up to slightly more than its own NAV, so these shares need not total 100%.",
    );
    expect(container.querySelector("details summary")?.textContent).toBe(
      "How these numbers are worked out",
    );
    expect(container.querySelector("details a")?.getAttribute("href")).toBe(
      "/methodology/#effective-holdings",
    );
  });

  it("shows the sparse evidence a fixture with matched weight actually has", () => {
    // Fixture 8: 20% of the weight is unmatched, so the range around the pair is real.
    const { container } = render(<EffectiveHoldingsSummary effective={EIGHT} />);
    const rows = Array.from(container.querySelectorAll("dl > div")).map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);

    expect(rows).toContainEqual(["Unmatched", "20.00% in 4 positions"]);
    expect(rows).toContainEqual(["Coverage", "80.0% of weight covered"]);
    expect(rows).toContainEqual(["Core, whole portfolio", "2.6 to 2.9"]);
    expect(rows).toContainEqual(["Broad, whole portfolio", "2.8 to 3.7"]);
  });
});

describe("below the coverage floor", () => {
  it("withholds every figure rather than printing a zero", () => {
    const withheld = holdings({
      companies: [company(0.5, 0.5)],
      unmatchedWeight: 0.5,
      unmatchedPositions: 2,
    });
    const { container } = render(<EffectiveHoldingsSummary effective={withheld} />);
    const text = container.textContent ?? "";

    expect(withheld.band).toBe("none");
    expect(text).toContain(
      "Coverage is below 60% of weight (50.0%), so no effective-holdings figure is shown: one computed over the part that resolved would describe a different portfolio.",
    );
    // No ladder, no disclosure opening onto nothing, and no figure dressed as a zero.
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(text).not.toContain("Core");
    expect(text).not.toContain("0.00");
    expect(container.querySelector("h2")?.textContent).toBe("Effective holdings");
  });
});
