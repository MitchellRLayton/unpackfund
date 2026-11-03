/**
 * The film's data contract and the strings it prints.
 *
 * The film may run without the bake (the brief's guardrail), but everything it *does* print
 * has to come from the artifact, never from a copy of a number — so the two things worth
 * pinning down are the parser (a shape drift is caught here, not on screen) and the
 * formatting of the caption and the counter (a locale-dependent separator or a padded zero
 * would be a different number to a reader).
 */

import { describe, expect, it } from "vitest";

import {
  RECORD_BYTES,
  RECORD_FLOATS,
  captionText,
  counterTotal,
  dotRecord,
  formatCount,
  formatFiledLine,
  parseCaption,
  parseDots,
  sharedLine,
  type Caption,
} from "./types";

function fixture(): Caption {
  return {
    schema: 1,
    release: "2026-10-31",
    generated_at: "2026-11-03T00:00:00.000Z",
    a: {
      ticker: "VTI",
      name: "Vanguard Total Stock Market ETF",
      filed_at: "2026-08-28",
      as_of: "2026-06-30",
      companies: 3639,
    },
    b: {
      ticker: "VOO",
      name: "Vanguard S&P 500 ETF",
      filed_at: "2026-08-27",
      as_of: "2026-06-30",
      companies: 3703,
    },
    shared: 3081,
    labels: [
      { name: "NVIDIA", ticker: "NVDA", weight: 6.21, index: 4 },
      { name: "Apple", ticker: "AAPL", weight: 5.94, index: 11 },
    ],
    metrics: {
      unitsPerEm: 1000,
      a: { advance: 1.93, ascender: 0.77, descender: 0.23 },
      b: { advance: 2.41, ascender: 0.77, descender: 0.23 },
      rule: { width: 2.6, y: 0.62 },
    },
  };
}

function dotsBuffer(records: number[][]): ArrayBuffer {
  const raw = new Float32Array(records.length * RECORD_FLOATS);
  records.forEach((record, index) => {
    record.forEach((value, field) => {
      raw[index * RECORD_FLOATS + field] = value;
    });
  });
  return raw.buffer;
}

describe("parseCaption", () => {
  it("reads the artifact the bake publishes, including the optional label index", () => {
    const caption = parseCaption(fixture());
    expect(caption.a.ticker).toBe("VTI");
    expect(caption.metrics.rule.width).toBe(2.6);
    expect(caption.labels[0]?.index).toBe(4);
  });

  it("drops a negative label index rather than trusting it", () => {
    const value = fixture();
    value.labels[0] = { name: "NVIDIA", ticker: "NVDA", weight: 6.21, index: -1 };
    expect(parseCaption(value).labels[0]?.index).toBeUndefined();
  });

  it("refuses a shape drift loudly", () => {
    expect(() => parseCaption({ ...fixture(), schema: 2 })).toThrow(/schema/);
    expect(() => parseCaption({ ...fixture(), labels: "NVDA" })).toThrow(/labels/);
    expect(() => parseCaption({ ...fixture(), metrics: { rule: {} } })).toThrow();
    expect(() =>
      parseCaption({
        ...fixture(),
        a: { ticker: "VTI", name: "x", filed_at: "2026-08-28", as_of: "2026-06-30" },
      }),
    ).toThrow(/companies/);
  });
});

describe("parseDots", () => {
  it("reads 28-byte records in the contract's field order", () => {
    // Binary fractions, so the float32 round trip is exact and the assertion is about order.
    const field = parseDots(
      dotsBuffer([[0.5, 0.25, -0.5, Number.NaN, Number.NaN, 0.375, 0.625]]),
    );
    expect(field.count).toBe(1);
    expect(field.raw).toHaveLength(RECORD_FLOATS);
    const record = dotRecord(field.raw, 0);
    expect(record).toEqual({
      w: 0.5,
      vx: 0.25,
      vy: -0.5,
      ox: null,
      oy: null,
      rx: 0.375,
      ry: 0.625,
    });
  });

  it("refuses an empty or ragged file, so the caller can play without dots", () => {
    expect(() => parseDots(new ArrayBuffer(0))).toThrow(/empty/);
    expect(() => parseDots(new ArrayBuffer(RECORD_BYTES * 2 + 4))).toThrow(/records/);
  });
});

describe("dotRecord", () => {
  it("is null outside the field", () => {
    expect(dotRecord(new Float32Array(0), 0)).toBeNull();
    expect(dotRecord(new Float32Array(0), -1)).toBeNull();
  });
});

describe("formatCount", () => {
  it("groups thousands and never pads", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(9)).toBe("9");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(3639)).toBe("3,639");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("has no leading zero at any size", () => {
    for (const value of [0, 1, 7, 12, 999, 1000, 3081, 3639, 999999]) {
      expect(formatCount(value)).not.toMatch(/^0\d/);
    }
  });

  it("rounds a tween's intermediate value and clamps nonsense to zero", () => {
    expect(formatCount(12.4)).toBe("12");
    expect(formatCount(12.6)).toBe("13");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(-5)).toBe("0");
  });
});

describe("formatFiledLine", () => {
  it("prints the day and the month as the caption does", () => {
    expect(formatFiledLine("2026-08-28")).toBe("filed 28 AUG 2026");
    expect(formatFiledLine("2026-01-05")).toBe("filed 05 JAN 2026");
  });

  it("returns a bad date legibly instead of throwing", () => {
    expect(formatFiledLine("28/08/2026")).toBe("filed 28/08/2026");
    expect(formatFiledLine("2026-13-01")).toBe("filed 2026-13-01");
  });
});

describe("the printed lines", () => {
  it("puts the ticker and the filing date in the caption", () => {
    expect(captionText(fixture())).toBe("VTI · filed 28 AUG 2026");
    expect(captionText(null)).toBe("VTI");
  });

  it("lands the counter on the first fund's company count", () => {
    expect(counterTotal(fixture())).toBe(3639);
    expect(counterTotal(null)).toBeNull();
  });

  it("says how many companies the two funds share, with both counts grouped", () => {
    expect(sharedLine(fixture())).toBe(
      "3,081 of VOO's 3,703 companies are already in VTI",
    );
    expect(sharedLine(null)).toBeNull();
  });
});
