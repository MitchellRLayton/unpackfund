import { describe, expect, it } from "vitest";

import {
  MAX_FRAGMENT_CHARS,
  decodeComparison,
  decodePortfolio,
  encodePortfolio,
  equalWeights,
  fundWeights,
  isComplete,
  shareUrl,
} from "./fragment";
import type { Portfolio, PortfolioEntry } from "./types";

const fiveFunds: PortfolioEntry[] = [
  { kind: "fund", key: "QQQ", amount: 2000 },
  { kind: "fund", key: "AVUV", amount: 2000 },
  { kind: "fund", key: "VOO", amount: 2000 },
  { kind: "fund", key: "SPY", amount: 2000 },
  { kind: "fund", key: "ARKK", amount: 2000 },
];

const portfolio = (
  entries: PortfolioEntry[],
  mode: Portfolio["mode"] = "bp",
): Portfolio => ({ mode, entries });

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("v3 encode/decode", () => {
  it("round-trips a five-fund portfolio exactly", () => {
    const decoded = decodePortfolio(`#${encodePortfolio(portfolio(fiveFunds))}`);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.mode).toBe("bp");
    expect(decoded.portfolio.entries).toEqual(
      [...fiveFunds].sort((a, b) => a.key.localeCompare(b.key)),
    );
    expect(decoded.complete).toBe(true);
  });

  it("produces one URL for one portfolio, whatever order it was built in", () => {
    const a = encodePortfolio(portfolio(fiveFunds));
    const b = encodePortfolio(portfolio([...fiveFunds].reverse()));
    expect(a).toBe(b);
  });

  it("keeps the mode, because a $ link is not a % link", () => {
    const dollars = portfolio(
      [
        { kind: "fund", key: "VT", amount: 900_000 },
        { kind: "security", key: "AMZN", amount: 100_000 },
      ],
      "usd",
    );
    const decoded = decodePortfolio(encodePortfolio(dollars));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.mode).toBe("usd");
    expect(decoded.portfolio.entries).toEqual([
      { kind: "fund", key: "VT", amount: 900_000 },
      { kind: "security", key: "AMZN", amount: 100_000 },
    ]);
    // Dollars are their own total: 90/10 needs no 100% rule.
    expect(decoded.complete).toBe(true);
  });

  it("stays far inside the length cap for a large portfolio", () => {
    const many: PortfolioEntry[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "fund",
      key: `FUND${index}`,
      amount: 250,
    }));
    const encoded = encodePortfolio(portfolio(many));
    expect(encoded.length).toBeLessThan(MAX_FRAGMENT_CHARS);
    expect(decodePortfolio(encoded).ok).toBe(true);
  });

  it("accepts a bare fragment as well as a hash", () => {
    const encoded = encodePortfolio(portfolio(fiveFunds));
    expect(decodePortfolio(encoded).ok).toBe(true);
    expect(decodePortfolio(`#${encoded}`).ok).toBe(true);
  });

  it("decodes a golden URL, so the format cannot drift unnoticed", () => {
    expect(encodePortfolio(portfolio(fiveFunds))).toBe(
      "v3.WyJicCIsW1siZiIsIkFSS0siLDIwMDBdLFsiZiIsIkFWVVYiLDIwMDBdLFsiZiIsIlFRUSIsMjAwMF0sWyJmIiwiU1BZIiwyMDAwXSxbImYiLCJWT08iLDIwMDBdXV0",
    );
  });

  it("carries a stock and cash in the same list as a fund", () => {
    const mixed = portfolio([
      { kind: "fund", key: "VT", amount: 9000 },
      { kind: "security", key: "AMZN", amount: 900 },
      { kind: "cash", key: "CASH", amount: 100 },
    ]);
    expect(encodePortfolio(mixed)).toBe(
      "v3.WyJicCIsW1siYyIsIkNBU0giLDEwMF0sWyJmIiwiVlQiLDkwMDBdLFsicyIsIkFNWk4iLDkwMF1dXQ",
    );
    const decoded = decodePortfolio(encodePortfolio(mixed));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.entries.map((entry) => entry.kind)).toEqual([
      "cash",
      "fund",
      "security",
    ]);
  });
});

describe("refusals", () => {
  const reject = (hash: string) => {
    const decoded = decodePortfolio(hash);
    expect(decoded.ok).toBe(false);
    return decoded.ok ? null : decoded.reason;
  };

  it("refuses a version it does not know rather than guessing", () => {
    expect(reject(`#v9.${encodeBase64Url("[]")}`)).toBe("unknown-version");
  });

  it("refuses a damaged payload", () => {
    expect(reject("#v3.!!!!")).toBe("malformed");
    // Valid base64, invalid JSON.
    expect(reject(`#v3.${encodeBase64Url("not json")}`)).toBe("malformed");
    // Valid JSON, not the v3 shape.
    expect(reject(`#v3.${encodeBase64Url('{"a":1}')}`)).toBe("malformed");
  });

  it("refuses percentages that add up to more than 100%", () => {
    const over = portfolio([
      { kind: "fund", key: "VOO", amount: 6000 },
      { kind: "fund", key: "QQQ", amount: 6000 },
    ]);
    // The encoder will emit it; the decoder must refuse it — renormalising 120%
    // would answer a question the visitor did not ask.
    expect(reject(`#${encodePortfolio(over)}`)).toBe("invalid-entry");
  });

  it("refuses two cash entries, because cash is one line", () => {
    const twoCash = portfolio([
      { kind: "cash", key: "CASH", amount: 1000 },
      { kind: "cash", key: "CASH", amount: 2000 },
    ]);
    expect(reject(`#${encodePortfolio(twoCash)}`)).toBe("invalid-entry");
  });

  it("refuses a holding repeated in the list", () => {
    const duplicated = portfolio([
      { kind: "fund", key: "VOO", amount: 4000 },
      { kind: "fund", key: "VOO", amount: 6000 },
    ]);
    expect(reject(`#${encodePortfolio(duplicated)}`)).toBe("invalid-entry");
  });

  it("refuses a symbol the fragment format cannot carry", () => {
    const lower = portfolio([{ kind: "security", key: "amzn", amount: 10_000 }]);
    const tooLong = portfolio([{ kind: "security", key: "TOOLONGSYM1", amount: 10_000 }]);
    expect(reject(`#${encodePortfolio(lower)}`)).toBe("invalid-entry");
    expect(reject(`#${encodePortfolio(tooLong)}`)).toBe("invalid-entry");
  });

  it("refuses a fund entry keyed CASH", () => {
    // Cash is a kind, not a ticker: an entry that claims both would make the ledger
    // count it twice — once as a company-less position and once as a security.
    const sneaky = portfolio([{ kind: "fund", key: "CASH", amount: 10_000 }]);
    expect(reject(`#${encodePortfolio(sneaky)}`)).toBe("invalid-entry");
  });

  it("refuses an amount that is not a non-negative integer", () => {
    for (const amount of [-1, 12.5, 10_001]) {
      const bad = portfolio([{ kind: "fund", key: "VOO", amount }]);
      expect(reject(`#${encodePortfolio(bad)}`)).toBe("invalid-entry");
    }
  });

  it("refuses a link longer than any portfolio should be", () => {
    expect(reject(`#v3.${"A".repeat(MAX_FRAGMENT_CHARS)}`)).toBe("too-long");
  });

  it("reports an empty fragment as empty, not as an error", () => {
    expect(reject("#")).toBe("empty");
  });
});

describe("legacy versions still read", () => {
  it("decodes a v1 funds-only link", () => {
    const decoded = decodePortfolio(
      "#v1.W1siQVJLSyIsMjAwMF0sWyJBVlVWIiwyMDAwXSxbIlFRUSIsMjAwMF0sWyJTUFkiLDIwMDBdLFsiVk9PIiwyMDAwXV0",
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.mode).toBe("bp");
    expect(decoded.portfolio.entries.map((entry) => entry.key)).toEqual([
      "ARKK",
      "AVUV",
      "QQQ",
      "SPY",
      "VOO",
    ]);
    expect(decoded.portfolio.entries.every((entry) => entry.kind === "fund")).toBe(true);
    expect(decoded.complete).toBe(true);
  });

  it("decodes a v2 comparison into two fund lists", () => {
    const payload = encodeBase64Url(
      JSON.stringify({
        a: [["VOO", 6000]],
        b: [["QQQ", 4000]],
      }),
    );
    const decoded = decodeComparison(`#v2.${payload}`);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.a).toEqual([{ ticker: "VOO", weight_bp: 6000 }]);
    expect(decoded.b).toEqual([{ ticker: "QQQ", weight_bp: 4000 }]);
    expect(decoded.completeA).toBe(false);
    // A v2 link is a fund portfolio at basis points with the same entries as side A.
    expect(decoded.portfolio.entries).toEqual([
      { kind: "fund", key: "VOO", amount: 6000 },
    ]);
  });

  it("projects a v3 portfolio onto the fund-only comparison view", () => {
    const mixed = portfolio(
      [
        { kind: "fund", key: "VT", amount: 900_000 },
        { kind: "security", key: "AMZN", amount: 100_000 },
      ],
      "usd",
    );
    expect(fundWeights(mixed)).toEqual([{ ticker: "VT", weight_bp: 9000 }]);
  });
});

describe("weights and completeness", () => {
  it("needs exactly 100% in percent mode", () => {
    expect(isComplete("bp", [])).toBe(false);
    expect(isComplete("bp", [{ kind: "fund", key: "VOO", amount: 9999 }])).toBe(false);
    expect(isComplete("bp", [{ kind: "fund", key: "VOO", amount: 10_000 }])).toBe(true);
  });

  it("treats any non-zero total as complete in dollar mode", () => {
    expect(isComplete("usd", [])).toBe(false);
    expect(isComplete("usd", [{ kind: "cash", key: "CASH", amount: 0 }])).toBe(false);
    expect(isComplete("usd", [{ kind: "fund", key: "VOO", amount: 1 }])).toBe(true);
  });

  it("splits equally into integers that total exactly 100%", () => {
    const entries = equalWeights(["AAA", "BBB", "CCC"]);
    expect(entries.map((entry) => entry.amount)).toEqual([3334, 3333, 3333]);
    expect(entries.every((entry) => entry.kind === "fund")).toBe(true);
  });

  it("builds a share URL from path and fragment only", () => {
    const url = shareUrl("https://unpackfund.com/#stale", portfolio(fiveFunds));
    expect(url.startsWith("https://unpackfund.com/#v3.")).toBe(true);
    expect(url).not.toContain("stale");
  });
});
