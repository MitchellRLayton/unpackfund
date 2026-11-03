import { describe, expect, it } from "vitest";

import { parsePaste, previewCounts, previewPaste } from "./paste";

/**
 * The paste box's contract, line by line. Each case is a shape a person actually types:
 * the four forms in the brief (`VTI 40%`, `VXUS $12,000`, `VTI 40`, `BND`), plus the
 * formatting a pasted list arrives with — bullets, numbering, a colon.
 *
 * The refusals are pinned too, because the sentence is what the visitor sees: a dollar
 * amount in percentage mode is not converted to a number nobody asked for, it is
 * explained and left out.
 */
describe("parsePaste", () => {
  it("reads a percentage, a dollar amount, a bare number, and a bare ticker", () => {
    const rows = parsePaste("VTI 40%\nVXUS $12,000\nBND 25\ncash");
    expect(rows).toHaveLength(4);

    expect(rows[0]).toMatchObject({ key: "VTI", percent: 40, cents: null });
    expect(rows[1]).toMatchObject({ key: "VXUS", percent: null, cents: 1_200_000 });
    // A bare number is a percentage: the unit this app is about.
    expect(rows[2]).toMatchObject({ key: "BND", percent: 25, cents: null });
    // No amount at all is a real state — the row arrives and waits for an amount.
    expect(rows[3]).toMatchObject({
      key: "CASH",
      isCash: true,
      percent: null,
      cents: null,
    });
    expect(rows.every((row) => row.problem === undefined)).toBe(true);
  });

  it("ignores blank lines rather than counting them as failures", () => {
    expect(parsePaste("\n\nVTI 40%\n\n")).toHaveLength(1);
  });

  it("strips bullets, numbering, tabs and a colon after the ticker", () => {
    const rows = parsePaste("1. VTI 40%\n- VXUS 30%\n• BND: 30%\n\tSCHD\t10%");
    expect(rows.map((row) => row.key)).toEqual(["VTI", "VXUS", "BND", "SCHD"]);
    expect(rows.map((row) => row.percent)).toEqual([40, 30, 30, 10]);
  });

  it("normalises a share class the way the rest of the app does", () => {
    expect(parsePaste("BRK.B 10%")[0]?.key).toBe("BRK-B");
  });

  it("refuses a line that is not a ticker", () => {
    const row = parsePaste("VTI!! 40%")[0];
    expect(row?.problem).toContain("not a ticker");
  });

  it("refuses a percentage above 100", () => {
    expect(parsePaste("VTI 140%")[0]?.problem).toContain("more than 100%");
  });

  it("refuses text it cannot read as an amount, and says what it could not read", () => {
    const row = parsePaste("VTI fourty")[0];
    expect(row?.problem).toContain("fourty");
  });

  it("marks the second of two identical lines rather than adding it twice", () => {
    const rows = parsePaste("VTI 40%\nVTI 30%");
    expect(rows[0]?.problem).toBeUndefined();
    expect(rows[1]?.problem).toContain("Listed twice");
  });
});

describe("previewPaste", () => {
  it("shows each line's amount in percentage mode", () => {
    const lines = previewPaste(parsePaste("VTI 40%\nBND"), "bp");
    expect(lines[0]).toMatchObject({ label: "VTI", amount: 4_000, amountText: "40.00%" });
    // A row with no amount is honest about it instead of showing 0.00%.
    expect(lines[1]).toMatchObject({
      label: "BND",
      amount: 0,
      amountText: "no weight yet",
    });
  });

  it("refuses a dollar amount in percentage mode, because its share of 100% is undefined", () => {
    const lines = previewPaste(parsePaste("VXUS $12,000"), "bp");
    expect(lines[0]?.problem).toContain("dollar mode");
    expect(previewCounts(lines)).toEqual({ usable: 0, refused: 1 });
  });

  it("converts a percentage in dollar mode at the toggle's own notional", () => {
    // 40% of the $10,000 notional is $4,000 — the same conversion the toggle performs.
    const lines = previewPaste(parsePaste("VTI 40%"), "usd");
    expect(lines[0]).toMatchObject({ amount: 400_000, amountText: "$4,000.00" });
  });

  it("keeps an exact dollar amount in dollar mode", () => {
    const lines = previewPaste(parsePaste("VXUS $12,000.50"), "usd");
    expect(lines[0]).toMatchObject({ amount: 1_200_050, amountText: "$12,000.50" });
  });

  it("counts what the add would do", () => {
    const lines = previewPaste(parsePaste("VTI 40%\nBND\nVXUS $1,000"), "bp");
    expect(previewCounts(lines)).toEqual({ usable: 2, refused: 1 });
  });
});
