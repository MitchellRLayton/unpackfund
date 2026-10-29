import { describe, expect, it } from "vitest";

import {
  MAX_FRAGMENT_CHARS,
  decodeComparison,
  decodePortfolio,
  encodePortfolio,
  equalWeights,
  isBalanced,
  shareUrl,
  totalWeightBp,
} from "./fragment";

const fiveFunds = [
  { ticker: "QQQ", weight_bp: 2000 },
  { ticker: "AVUV", weight_bp: 2000 },
  { ticker: "VOO", weight_bp: 2000 },
  { ticker: "SPY", weight_bp: 2000 },
  { ticker: "ARKK", weight_bp: 2000 },
];

describe("encode/decode", () => {
  it("round-trips a five-fund portfolio exactly", () => {
    const encoded = encodePortfolio({ entries: fiveFunds });
    const decoded = decodePortfolio(`#${encoded}`);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.entries).toEqual(
      [...fiveFunds].sort((a, b) => (a.ticker < b.ticker ? -1 : 1)),
    );
    expect(decoded.balanced).toBe(true);
  });

  it("produces one URL for one portfolio, whatever order it was built in", () => {
    const a = encodePortfolio({ entries: fiveFunds });
    const b = encodePortfolio({ entries: [...fiveFunds].reverse() });
    expect(a).toBe(b);
  });

  it("stays far inside the length cap for a large portfolio", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ticker: `FUND${index}`,
      weight_bp: 250,
    }));
    const encoded = encodePortfolio({ entries: many });
    expect(encoded.length).toBeLessThan(MAX_FRAGMENT_CHARS);
    expect(decodePortfolio(encoded).ok).toBe(true);
  });

  it("accepts a bare fragment as well as a hash", () => {
    const encoded = encodePortfolio({ entries: fiveFunds });
    expect(decodePortfolio(encoded).ok).toBe(true);
    expect(decodePortfolio(`#${encoded}`).ok).toBe(true);
  });

  it("decodes a golden URL, so the format cannot drift unnoticed", () => {
    const encoded = encodePortfolio({ entries: fiveFunds });
    expect(encoded).toBe(
      "v1.W1siQVJLSyIsMjAwMF0sWyJBVlVWIiwyMDAwXSxbIlFRUSIsMjAwMF0sWyJTUFkiLDIwMDBdLFsiVk9PIiwyMDAwXV0",
    );
  });
});

describe("refusals", () => {
  it("refuses an unknown version instead of guessing", () => {
    const encoded = encodePortfolio({ entries: fiveFunds }).replace(/^v1/, "v9");
    expect(decodePortfolio(encoded)).toEqual({ ok: false, reason: "unknown-version" });
  });

  it("refuses a v2 link whose payload is not a comparison", () => {
    // The failure this prevents: reading one side of a comparison and showing it as
    // if it were the whole answer. A v1-shaped payload behind a v2 prefix is refused.
    const encoded = encodePortfolio({ entries: fiveFunds }).replace(/^v1/, "v2");
    expect(decodePortfolio(encoded)).toEqual({ ok: false, reason: "malformed" });
    expect(decodeComparison(encoded)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses junk, empty and over-long fragments", () => {
    expect(decodePortfolio("")).toEqual({ ok: false, reason: "empty" });
    expect(decodePortfolio("#")).toEqual({ ok: false, reason: "empty" });
    expect(decodePortfolio("#v1")).toEqual({ ok: false, reason: "malformed" });
    expect(decodePortfolio("#v1.%%%")).toEqual({ ok: false, reason: "malformed" });
    expect(decodePortfolio(`#v1.${"A".repeat(MAX_FRAGMENT_CHARS)}`)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("refuses an entry that is not a ticker and an integer weight", () => {
    const b64 = (value: unknown) =>
      btoa(JSON.stringify(value))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    expect(decodePortfolio(`#v1.${b64([["VOO", 5000.5]])}`)).toEqual({
      ok: false,
      reason: "invalid-entry",
    });
    expect(decodePortfolio(`#v1.${b64([["VOO", -100]])}`)).toEqual({
      ok: false,
      reason: "invalid-entry",
    });
    expect(decodePortfolio(`#v1.${b64([["voo", 5000]])}`)).toEqual({
      ok: false,
      reason: "invalid-entry",
    });
    expect(
      decodePortfolio(
        `#v1.${b64([
          ["VOO", 5000],
          ["VOO", 5000],
        ])}`,
      ),
    ).toEqual({ ok: false, reason: "invalid-entry" });
    expect(decodePortfolio(`#v1.${b64([])}`)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("weights", () => {
  it("equalises to exactly 10,000 bp and keeps the remainder", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
      const entries = equalWeights(
        Array.from({ length: count }, (_, index) => `F${index}`),
      );
      expect(totalWeightBp(entries)).toBe(10_000);
      expect(isBalanced(entries)).toBe(true);
      expect(
        Math.max(...entries.map((entry) => entry.weight_bp)) -
          Math.min(...entries.map((entry) => entry.weight_bp)),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("reports an unbalanced portfolio rather than fixing it silently", () => {
    const decoded = decodePortfolio(
      encodePortfolio({ entries: [{ ticker: "VOO", weight_bp: 4000 }] }),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.balanced).toBe(false);
  });

  it("builds a share URL from path and fragment only", () => {
    expect(shareUrl("https://unpackfund.com/x/#old", { entries: fiveFunds })).toBe(
      `https://unpackfund.com/x/#${encodePortfolio({ entries: fiveFunds })}`,
    );
  });
});
