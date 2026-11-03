/**
 * Five portfolios the redesign must answer exactly as the current site does.
 *
 * The acceptance rule is "all numbers identical to the current site on five test
 * portfolios", and the only way to check that is to have the five written down
 * before the UI changes, with the numbers recorded from the code that is live
 * today. `scripts/check-fixtures.mjs` prints a canonical report for each of these
 * against a release; run it on the old branch and the new one and diff the two
 * outputs. An empty diff is the evidence.
 *
 * The five are chosen to exercise the parts that can drift:
 *
 * 1. `three-fund` — the ordinary global mix, three funds, one of them below the
 *    coverage band, so the withheld-metrics path is in play.
 * 2. `single-fund` — one fund at 100%, the smallest possible ledger.
 * 3. `stock-and-cash` — a direct stock position and a cash line, which are the two
 *    entries that are not funds and are the easiest to lose in a rewrite.
 * 4. `dollar-mode` — the same shape in dollars rather than percentages, so the
 *    fraction conversion is exercised.
 * 5. `overlap-heavy` — two funds that hold nearly the same companies, which is the
 *    case where a second, subtly different overlap implementation would show.
 *
 * The fragments are the real encoding (`fragment.ts`), not a description of one:
 * a fixture that cannot be pasted into the address bar is not a fixture.
 */

export interface Fixture {
  id: string;
  /** What the portfolio is, in words, for the report header. */
  label: string;
  /** A real `#v3.…` fragment. */
  fragment: string;
  /** Why this portfolio is in the set. */
  why: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: "three-fund",
    label: "VTI 60% / VXUS 30% / BND 10%",
    fragment:
      "#v3.WyJicCIsW1siZiIsIkJORCIsMTAwMF0sWyJmIiwiVlRJIiw2MDAwXSxbImYiLCJWWFVTIiwzMDAwXV1d",
    why: "The ordinary global mix, and BND is below the coverage band, so the withheld-metrics path is exercised.",
  },
  {
    id: "single-fund",
    label: "VTI 100%",
    fragment: "#v3.WyJicCIsW1siZiIsIlZUSSIsMTAwMDBdXV0",
    why: "The smallest possible ledger: one fund, one weight, no cash, no direct holding.",
  },
  {
    id: "stock-and-cash",
    label: "VTI 50% / AAPL 25% / cash 25%",
    fragment:
      "#v3.WyJicCIsW1siZiIsIlZUSSIsNTAwMF0sWyJzIiwiQUFQTCIsMjUwMF0sWyJjIiwiQ0FTSCIsMjUwMF1dXQ",
    why: "A direct stock position and a cash line: the two entries that are not funds, and the easiest to lose in a rewrite.",
  },
  {
    id: "dollar-mode",
    label: "VTI $8,000 / VXUS $12,000",
    fragment: "#v3.WyJ1c2QiLFtbImYiLCJWVEkiLDgwMDAwMF0sWyJmIiwiVlhVUyIsMTIwMDAwMF1dXQ",
    why: "Dollar mode: the same shape as a percentage mix, but the fraction conversion runs the other way.",
  },
  {
    id: "overlap-heavy",
    label: "VOO 50% / VTI 50%",
    fragment: "#v3.WyJicCIsW1siZiIsIlZPTyIsNTAwMF0sWyJmIiwiVlRJIiw1MDAwXV1d",
    why: "Two funds holding nearly the same companies: where a second, subtly different overlap implementation would show.",
  },
];
