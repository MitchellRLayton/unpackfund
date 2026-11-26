import { describe, expect, it } from "vitest";

import {
  classOf,
  classesByFund,
  documentsCarryFees,
  feeFigure,
  FEE_NOTES,
  portfolioFee,
} from "./fees";
import { formatFeeAverage, formatFeePct, formatKnownShare } from "./format";
import type { FeeBasis, FeeRow, FundDocument } from "./types";

function row(total: number | null, extra: Partial<FeeRow> = {}): FeeRow {
  return {
    class_id: null,
    total,
    net: null,
    waiver: null,
    basis: "no-waiver-stated",
    prospectus_date: "2026-04-29",
    filed_at: "2026-04-30",
    form: "485BPOS",
    source_url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    ...extra,
  };
}

function fund(ticker: string, classes?: Record<string, FeeRow>): FundDocument {
  return { ticker, ...(classes ? { fees: { classes } } : {}) } as unknown as FundDocument;
}

const docs = (...funds: FundDocument[]) => new Map(funds.map((f) => [f.ticker, f]));

describe("the stated fee of one class", () => {
  it("is the net when the prospectus states one, with the total as 'before waivers'", () => {
    // FCTDX: 0.53% gross, 0.28% net after a 0.25% waiver.
    const figure = feeFigure(
      fund("FCTDX", {
        FCTDX: row(0.0053, { net: 0.0028, waiver: -0.0025, basis: "stated-net" }),
      }),
      "FCTDX",
    );
    expect(figure).toMatchObject({ value: 0.0028, before: 0.0053, countable: true });
    expect(figure?.note).toBe(FEE_NOTES.netOfWaivers);
  });

  it("is the total, labelled, when no waiver is stated", () => {
    const figure = feeFigure(fund("VOO", { VFIAX: row(0.0004) }), "VFIAX");
    expect(figure).toMatchObject({ value: 0.0004, before: null, countable: true });
    expect(figure?.note).toBe(FEE_NOTES.noWaiver);
  });

  it("does not call a net that equals the total 'net of waivers'", () => {
    const figure = feeFigure(
      fund("X", {
        X: row(0.0103, { net: 0.0103, waiver: -0.0004, basis: "stated-net" }),
      }),
      "X",
    );
    expect(figure?.note).toBe(FEE_NOTES.netAsStated);
    expect(figure?.before).toBeNull();
  });

  it("labels a recoupment as one (EPDIX 1.25% above its 1.23% total)", () => {
    const figure = feeFigure(
      fund("EPDIX", {
        EPDIX: row(0.0123, { net: 0.0125, waiver: 0.0002, basis: "stated-net" }),
      }),
      "EPDIX",
    );
    expect(figure).toMatchObject({ value: 0.0125, before: 0.0123 });
    expect(figure?.note).toBe(FEE_NOTES.recoupment);
  });

  it.each<[FeeBasis, string]>([
    ["waiver-without-net", FEE_NOTES.waiverNoNet],
    ["waiver-unresolved", FEE_NOTES.waiverUnresolved],
  ])(
    "shows a %s total as before waivers and keeps it out of the average",
    (basis, note) => {
      const figure = feeFigure(
        fund("A", { A: row(0.009, { waiver: -0.002, basis }) }),
        "A",
      );
      expect(figure).toMatchObject({
        value: 0.009,
        before: null,
        countable: false,
        note,
      });
    },
  );

  it("never answers a typed class with a sibling's fee", () => {
    const doc = fund("VOO", { VOO: row(0.0003), VFINX: row(0.0014) });
    expect(feeFigure(doc, "VFIAX")).toBeNull();
    expect(feeFigure(doc, "VFINX")?.value).toBe(0.0014);
  });

  it("is absent for a document with no fees, no row, or a row with no number", () => {
    expect(feeFigure(fund("A"), "A")).toBeNull();
    expect(feeFigure(undefined, "A")).toBeNull();
    expect(feeFigure(fund("A", { A: row(null) }), "A")).toBeNull();
  });

  it("reads the class a fund entry was typed as, else its own ticker", () => {
    expect(classOf({ key: "VOO", cls: "VFIAX" })).toBe("VFIAX");
    expect(classOf({ key: "VOO" })).toBe("VOO");
    expect(
      classesByFund([
        { kind: "fund", key: "VOO", amount: 1, cls: "VFIAX" },
        { kind: "fund", key: "VTI", amount: 1 },
        { kind: "security", key: "AAPL", amount: 1 },
      ]),
    ).toEqual({ VOO: "VFIAX" });
  });

  it("knows whether a release carries fees at all", () => {
    expect(documentsCarryFees([fund("A"), undefined])).toBe(false);
    expect(documentsCarryFees([fund("A"), fund("B", { B: row(0.001) })])).toBe(true);
  });
});

describe("the portfolio's average fee (D4)", () => {
  // Hand-calculated: a stock 10%, fund A 45% at 0.10%, fund B 30% at 0.50%, fund C 15% with
  // no stated fee. Fund weight is 45 + 30 + 15 = 90; fees are known for 45 + 30 = 75.
  //   known share = 75 / 90 = 83.333…%
  //   average     = (45 × 0.10 + 30 × 0.50) / 75 = (4.5 + 15) / 75 = 0.26%
  const fixture = () => ({
    weights: { A: 0.45, B: 0.3, C: 0.15 }, // the stock's 0.10 is not a fund and is not here
    documents: docs(
      fund("A", { A: row(0.001) }),
      fund("B", { B: row(0.005) }),
      fund("C"),
    ),
  });

  it("is 0.26% over 83.3% of fund weight, leaving the stock out and the unknown fund uncounted", () => {
    const { weights, documents } = fixture();
    const result = portfolioFee(weights, {}, documents);
    expect(result?.average).toBeCloseTo(0.0026, 12);
    expect(result?.knownPct).toBeCloseTo(83.333333, 5);
    expect(result).toMatchObject({ counted: 2, funds: 3, suppressed: false });
    expect(formatFeeAverage(result?.average ?? 0)).toBe("0.26%");
    expect(formatKnownShare(result?.knownPct ?? 0)).toBe("83.3%");
  });

  it("does not count the unknown fund as zero (that would make it 0.17%)", () => {
    const { weights, documents } = fixture();
    const naive = (0.45 * 0.001 + 0.3 * 0.005) / 0.9;
    expect(naive).toBeCloseTo(0.002167, 6);
    expect(portfolioFee(weights, {}, documents)?.average).not.toBeCloseTo(naive, 4);
  });

  it("reads the class each fund was typed as", () => {
    const documents = docs(fund("VOO", { VOO: row(0.0003), VFIAX: row(0.0004) }));
    expect(portfolioFee({ VOO: 1 }, {}, documents)?.average).toBe(0.0003);
    expect(portfolioFee({ VOO: 1 }, { VOO: "VFIAX" }, documents)?.average).toBe(0.0004);
    // A typed class that states nothing is unknown, not VOO's figure.
    expect(portfolioFee({ VOO: 1 }, { VOO: "VFINX" }, documents)).toMatchObject({
      average: null,
      knownPct: 0,
      suppressed: true,
    });
  });

  it("leaves a waiver-without-net class out of the average and counts it unknown", () => {
    const documents = docs(
      fund("A", { A: row(0.001) }),
      fund("B", { B: row(0.009, { waiver: -0.002, basis: "waiver-without-net" }) }),
    );
    const result = portfolioFee({ A: 0.7, B: 0.3 }, {}, documents);
    expect(result?.average).toBe(0.001);
    expect(result?.knownPct).toBeCloseTo(70, 6);
    expect(result?.counted).toBe(1);
  });

  // The 60% line is the site's (`coverageBand`): half-open, so 60.0 shows and 59.9 does not.
  it.each([
    [0.599, true],
    [0.6, false],
    [0.601, false],
  ])("with fees known for %s of fund weight, suppressed = %s", (known, suppressed) => {
    const documents = docs(fund("A", { A: row(0.002) }), fund("B"));
    const result = portfolioFee({ A: known, B: 1 - known }, {}, documents);
    expect(result?.suppressed).toBe(suppressed);
    expect(result?.average === null).toBe(suppressed);
    // The share is always reported, so the reader can see what the average would cover.
    expect(result?.knownPct).toBeCloseTo(known * 100, 6);
  });

  it("never prints a known share that rounds up across the line", () => {
    expect(formatKnownShare(59.96)).toBe("59.9%");
    expect(formatKnownShare(60)).toBe("60.0%");
    expect(formatKnownShare(0.6 * 100)).toBe("60.0%");
  });

  it("has no average, and no zero, when no fund states a fee", () => {
    const result = portfolioFee({ A: 0.5, B: 0.5 }, {}, docs(fund("A"), fund("B")));
    expect(result).toMatchObject({
      average: null,
      knownPct: 0,
      counted: 0,
      suppressed: true,
    });
  });

  it("is null when there is no fund weight at all (a portfolio of stocks and cash)", () => {
    expect(portfolioFee({}, {}, docs())).toBeNull();
  });
});

describe("how a fee prints", () => {
  it("is two decimals, and more only where the filing gives them", () => {
    expect(formatFeePct(0.0004)).toBe("0.04%");
    expect(formatFeePct(0.0014)).toBe("0.14%");
    expect(formatFeePct(0.0085)).toBe("0.85%");
    expect(formatFeePct(0.000945)).toBe("0.0945%");
    expect(formatFeePct(0.0123)).toBe("1.23%");
    expect(formatFeePct(0)).toBe("0.00%");
    expect(formatFeePct(0.0528)).toBe("5.28%");
  });

  it("agrees with the fund page's formatter on the same inputs", () => {
    // pipeline/tests/test_fund_pages.py::test_a_fee_prints_two_decimals_and_more_only_where_the_filing_gives_them
    const pairs: Array<[number, string]> = [
      [0.0004, "0.04%"],
      [0.0014, "0.14%"],
      [0.0085, "0.85%"],
      [0.000945, "0.0945%"],
      [0.0123, "1.23%"],
      [0.0, "0.00%"],
      [0.01, "1.00%"],
      [0.0528, "5.28%"],
    ];
    for (const [value, shown] of pairs) expect(formatFeePct(value)).toBe(shown);
  });

  it("does not let a real average print as zero", () => {
    expect(formatFeeAverage(0.00004)).toBe("<0.01%");
    expect(formatFeeAverage(0.0026)).toBe("0.26%");
  });
});
