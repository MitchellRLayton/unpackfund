import { describe, expect, it } from "vitest";

import { buildLedger } from "@/lib/aggregate";
import type { FundDocument } from "@/lib/types";

import { buildAnswer, highestOverlap, type AnswerSentence } from "./answer";

/**
 * The answer strip is the only prose on the page, so its sentences are pinned here in
 * full rather than by keyword: a number that appears in a sentence has to match the
 * table under it, and the fixture ledgers are built through `buildLedger` — the same
 * function the page uses — so a change to the aggregation shows up here as a changed
 * sentence rather than as a silent disagreement.
 *
 * The negative cases matter as much as the positive ones: no concentration figure when a
 * fund is below the 60% floor, no market split when nothing was placed, no overlap
 * sentence below the threshold.
 */

function fund(
  ticker: string,
  coveragePct: number,
  holdings: [string | null, number][],
): FundDocument {
  return {
    schema_version: 1,
    ticker,
    fund_id: `S${ticker}`,
    name: `${ticker} Fund`,
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${ticker}`,
    coverage_pct: coveragePct,
    holdings: holdings.map(([companyId, weightBp]) => ({
      company_id: companyId,
      name: companyId === null ? "Unidentified position" : `Company ${companyId}`,
      ticker: null,
      asset_cat: "equity" as const,
      weight_bp: weightBp,
    })),
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  };
}

const COUNTRIES: Record<string, string> = {
  c_apple: "US",
  c_msft: "US",
  c_nvda: "US",
  c_treasury: "US",
  c_nestle: "CH",
  c_tsmc: "TW",
  c_samsung: "KR",
};

const vti = fund("VTI", 100, [
  ["c_apple", 4_000],
  ["c_msft", 3_000],
  ["c_nvda", 3_000],
]);
const vxus = fund("VXUS", 100, [
  ["c_nestle", 5_000],
  ["c_tsmc", 3_000],
  ["c_samsung", 2_000],
]);
const bnd = fund("BND", 100, [["c_treasury", 10_000]]);

const WEIGHTS = { VTI: 0.6, VXUS: 0.3, BND: 0.1 };

/** The sentence as a reader sees it, for a readable assertion. */
function flat(sentence: AnswerSentence | undefined): string {
  return (sentence?.parts ?? []).map((part) => part.strong ?? part.text ?? "").join("");
}

function flatAll(sentences: AnswerSentence[]): string[] {
  return sentences.map((sentence) => flat(sentence));
}

describe("buildAnswer — a portfolio the ledger has produced", () => {
  const ledger = buildLedger({
    funds: [vti, vxus, bnd],
    weights: WEIGHTS,
    countries: COUNTRIES,
  });
  const answer = buildAnswer({ kind: "ready", ledger, funds: [vti, vxus, bnd] });

  it("opens with how many companies, through how many funds", () => {
    expect(flat(answer.sentences[0])).toBe("You own 7 companies through 3 funds.");
  });

  it("gives the ten-largest share, the largest company, its funds and its biggest source", () => {
    expect(flat(answer.sentences[1])).toBe(
      "Your 7 companies together are 100.0% of the mix; the largest is Company c_apple at 24.00%, held by 1 fund, the largest part of it through VTI (24.00% of your mix).",
    );
  });

  it("splits the placed weight by market tier and sums to the whole", () => {
    // MSCI counts South Korea as emerging, so KR sits with Taiwan and only Switzerland
    // is developed ex-US here. The split is computed by `tierOf`, not by the test, and
    // the sentence names the convention that decided it.
    expect(flat(answer.sentences[2])).toBe(
      "By market, under the MSCI convention: 70.0% in the United States, 15.0% in international developed markets outside it, 15.0% in emerging markets.",
    );
  });

  it("places the same weight under the other convention when the reader picks it", () => {
    // The one country that moves: FTSE Russell counts South Korea as developed, so the
    // 6 points it carries leave emerging and join developed ex-US. The answer strip and
    // the Markets bar read one choice, so the sentence has to follow it.
    const ftse = buildAnswer({
      kind: "ready",
      ledger,
      funds: [vti, vxus, bnd],
      provider: "FTSE",
    });
    expect(flat(ftse.sentences[2])).toBe(
      "By market, under the FTSE Russell convention: 70.0% in the United States, 21.0% in international developed markets outside it, 9.0% in emerging markets.",
    );
  });

  it("keeps coverage and the three dates beside the numbers they qualify", () => {
    const note = (answer.note ?? [])
      .map((part) => part.strong ?? part.text ?? "")
      .join("");
    expect(note).toBe(
      "Coverage 100.0% covered of invested money · 0.0% not traced to a company · oldest reporting period Jun 30, 2026, filed Aug 28, 2026, 59 days old.",
    );
  });

  it("says nothing about overlap when no two funds share enough", () => {
    expect(flatAll(answer.sentences).some((line) => line.includes("share "))).toBe(false);
  });
});

describe("buildAnswer — the honest refusals", () => {
  it("withholds the concentration figure when a fund is below the 60% floor", () => {
    const lowCoverage = fund("BND", 55, [["c_treasury", 10_000]]);
    const ledger = buildLedger({
      funds: [vti, lowCoverage],
      weights: { VTI: 0.7, BND: 0.3 },
    });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [vti, lowCoverage] });
    expect(flat(answer.sentences[1])).toBe(
      "BND covers less than 60% of its own weight, so no concentration figure is shown here: one computed over the part that resolved would describe a different portfolio.",
    );
    expect(flatAll(answer.sentences).some((line) => line.includes("largest"))).toBe(
      false,
    );
  });

  it("names the untraced remainder instead of folding it into a market tier", () => {
    // 10% of VTI's weight is a position the release could not identify: it has no
    // company, so it cannot be placed, and the sentence has to say so.
    const partial = fund("VTI", 90, [
      ["c_apple", 4_000],
      [null, 1_000],
      ["c_msft", 3_000],
      ["c_nvda", 2_000],
    ]);
    const ledger = buildLedger({
      funds: [partial],
      weights: { VTI: 1 },
      countries: COUNTRIES,
    });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [partial] });
    const markets = flat(answer.sentences[2]);
    expect(markets).toContain(
      "By market, under the MSCI convention: 90.0% in the United States",
    );
    expect(markets).toContain("not placed in a market");
    expect(markets).toContain(
      "untraced weight, cash, or a company with no country answer",
    );
  });

  it("places a position with no company by the country its own filing states", () => {
    // Half of this fund is a position the release could not tie to a company, and its
    // filing says Switzerland. The Markets lens places that weight in developed ex-US
    // from `unmapped.securities_by_country`; the sentence has to place it too, or the
    // two surfaces disagree about the same portfolio. It did, by 2.3 points, before
    // this test existed.
    const document = fund("SWIS", 50, [["c_apple", 5_000]]);
    document.holdings.push({
      company_id: null,
      name: "Unidentified position",
      ticker: null,
      asset_cat: "equity",
      weight_bp: 5_000,
      filed_country: "CH",
    });
    const ledger = buildLedger({
      funds: [document],
      weights: { SWIS: 1 },
      countries: COUNTRIES,
    });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [document] });
    expect(flat(answer.sentences[2])).toBe(
      "By market, under the MSCI convention: 50.0% in the United States, 50.0% in international developed markets outside it, 0.0% in emerging markets.",
    );
  });

  it("omits the market split entirely when the release places no company", () => {
    const ledger = buildLedger({ funds: [vti, vxus, bnd], weights: WEIGHTS });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [vti, vxus, bnd] });
    expect(flatAll(answer.sentences).some((line) => line.startsWith("By market"))).toBe(
      false,
    );
  });

  it("calls a company with no filing of its own a direct holding, and says there are no dates", () => {
    const ledger = buildLedger({
      funds: [],
      weights: {},
      direct: [{ company_id: "c_aapl", name: "APPLE INC", ticker: "AAPL", weight: 1 }],
    });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [] });
    expect(flat(answer.sentences[0])).toBe(
      "You own 1 company 1 of these is held directly by you.",
    );
    const note = (answer.note ?? [])
      .map((part) => part.strong ?? part.text ?? "")
      .join("");
    expect(note).toContain("Direct holdings only");
  });

  it("says eleven or more companies differently from ten", () => {
    const many = fund(
      "AAA",
      100,
      Array.from({ length: 12 }, (_, index) => [
        `c_${String(index + 1).padStart(2, "0")}`,
        index === 11 ? 100 : 900,
      ]) as [string, number][],
    );
    const ledger = buildLedger({ funds: [many], weights: { AAA: 1 } });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [many] });
    expect(flat(answer.sentences[1])).toBe(
      "Your 10 largest companies are 90.0% of the mix; the largest is Company c_01 at 9.00%, held by 1 fund, the largest part of it through AAA (9.00% of your mix).",
    );
    expect(answer.sentences).toHaveLength(2);
  });
});

describe("highestOverlap", () => {
  it("computes Σ min by hand: 60% shared between two filings", () => {
    const aa = fund("AA", 100, [
      ["c_x", 6_000],
      ["c_y", 4_000],
    ]);
    const bb = fund("BB", 100, [
      ["c_x", 8_000],
      ["c_z", 2_000],
    ]);
    expect(highestOverlap([aa, bb])).toEqual({ a: "AA", b: "BB", shared: 0.6 });
  });

  it("needs two filings to compare", () => {
    expect(highestOverlap([vti])).toBeNull();
  });

  it("mentions the overlapping pair in the answer when it is above half", () => {
    const aa = fund("AA", 100, [
      ["c_x", 6_000],
      ["c_y", 4_000],
    ]);
    const bb = fund("BB", 100, [
      ["c_x", 8_000],
      ["c_z", 2_000],
    ]);
    const ledger = buildLedger({ funds: [aa, bb], weights: { AA: 0.5, BB: 0.5 } });
    const answer = buildAnswer({ kind: "ready", ledger, funds: [aa, bb] });
    expect(flat(answer.sentences.at(-1))).toBe(
      "AA and BB share 60.0% of their holdings by weight.",
    );
  });
});

describe("buildAnswer — states that are not a whole portfolio", () => {
  it("has nothing to say about an empty portfolio", () => {
    expect(buildAnswer({ kind: "empty" })).toEqual({
      sentences: [],
      note: null,
      highlights: [],
    });
  });

  it("names the filings it is waiting for", () => {
    const answer = buildAnswer({
      kind: "loading",
      pending: ["VTI", "BND"],
      fundCount: 3,
    });
    expect(flat(answer.sentences[0])).toBe("Reading 2 filings: VTI and BND.");
  });

  it("says it is adding up when nothing is pending but the ledger is not in yet", () => {
    const answer = buildAnswer({ kind: "loading", pending: [], fundCount: 3 });
    expect(flat(answer.sentences[0])).toBe("Adding up 3 filings…");
  });

  it("refuses to describe weights when the percentages do not add up", () => {
    const short = buildAnswer({
      kind: "incomplete",
      mode: "bp",
      totalBp: 6_000,
      unallocatedBp: 4_000,
      overBp: 0,
    });
    expect(flat(short.sentences[0])).toBe(
      "Your percentages add up to 60.00%, with 40.00% accounting for nothing, so no company weights are shown yet.",
    );
    expect(short.note).toBeNull();
  });

  it("says how far past the whole an over-allocated portfolio is", () => {
    const over = buildAnswer({
      kind: "incomplete",
      mode: "bp",
      totalBp: 12_000,
      unallocatedBp: 0,
      overBp: 2_000,
    });
    expect(flat(over.sentences[0])).toBe(
      "Your percentages add up to 120.00% — 20.00% more than the whole, so no company weights are shown yet.",
    );
  });

  it("asks for an amount when nothing has one", () => {
    const empty = buildAnswer({
      kind: "incomplete",
      mode: "usd",
      totalBp: 0,
      unallocatedBp: 0,
      overBp: 0,
    });
    expect(flat(empty.sentences[0])).toBe(
      "Set an amount on at least one row to see the look-through.",
    );
  });
});

/**
 * The box on screen and the prose on paper are two renderings of one computation, so the
 * rows are pinned against the same fixture the sentences are. What is checked here is not
 * the wording — that is the component's business — but that a row exists for every fact a
 * sentence carries, that the numbers are the sentence's numbers, and that a state with
 * nothing to tabulate produces no rows at all (which is what makes the box fall back to
 * the prose).
 */
describe("buildAnswer — the same facts as rows", () => {
  const ledger = buildLedger({
    funds: [vti, vxus, bnd],
    weights: WEIGHTS,
    countries: COUNTRIES,
  });
  const answer = buildAnswer({ kind: "ready", ledger, funds: [vti, vxus, bnd] });

  function row(label: string) {
    return answer.highlights.find((entry) => entry.label === label);
  }

  function flatRow(label: string): string {
    return (row(label)?.parts ?? [])
      .map((part) => part.strong ?? part.text ?? "")
      .join("");
  }

  it("labels every row with the glossary entry behind it", () => {
    expect(answer.highlights.map((entry) => entry.label)).toEqual([
      "Largest",
      "Markets (MSCI)",
      "Effective",
      "Coverage",
    ]);
    for (const entry of answer.highlights) {
      expect(entry.term).toBeTruthy();
    }
  });

  it("says the concentration the sentence says, without the fund attribution", () => {
    // Seven companies is fewer than ten, so the row is not called "10 largest".
    expect(flatRow("Largest")).toBe("100.0% of the mix · largest Company c_apple 24.00%");
  });

  it("says the market split the sentence says, under the same convention", () => {
    expect(flatRow("Markets (MSCI)")).toBe(
      "70.0% US · 15.0% developed ex-US · 15.0% emerging",
    );
  });

  it("names the two effective counts and links the words that need defining", () => {
    const parts = row("Effective")?.parts ?? [];
    expect(parts.filter((part) => part.term).map((part) => part.term)).toEqual([
      "core",
      "broad",
    ]);
    expect(flatRow("Effective")).toContain("at the core");
    expect(flatRow("Effective")).toContain("counting breadth");
  });

  it("carries the coverage chip and the oldest reporting period", () => {
    expect(flatRow("Coverage")).toBe("100.0% covered · oldest period Jun 30, 2026");
  });

  it("has no rows to tabulate for an empty, loading or incomplete portfolio", () => {
    expect(buildAnswer({ kind: "empty" }).highlights).toEqual([]);
    expect(
      buildAnswer({ kind: "loading", pending: [], fundCount: 2 }).highlights,
    ).toEqual([]);
    expect(
      buildAnswer({
        kind: "incomplete",
        mode: "bp",
        totalBp: 9_000,
        unallocatedBp: 1_000,
        overBp: 0,
      }).highlights,
    ).toEqual([]);
  });
});
