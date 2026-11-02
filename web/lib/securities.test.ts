import { describe, expect, it } from "vitest";

import {
  accepts,
  isCarriable,
  normaliseSymbol,
  refusal,
  statusLabel,
} from "./securities";
import type { SecurityStatus } from "./types";

/**
 * The refusals are the part of this feature a visitor meets when something is wrong,
 * so each one is pinned by its text and by the rule that produces it. The statuses
 * are the pipeline's, and their meaning is `pipeline/pipeline/securities.py`'s
 * `STATUSES` list — one word per reason a listed symbol is not a common stock.
 */

const STATUSES: SecurityStatus[] = ["ok", "fund", "pfd", "wnt", "unit", "rgt", "twin"];

describe("normaliseSymbol", () => {
  it("upper-cases and trims what a visitor typed", () => {
    expect(normaliseSymbol(" amzn ")).toBe("AMZN");
    expect(normaliseSymbol("brk.b")).toBe("BRK-B");
  });

  it("leaves a symbol in the form the release publishes", () => {
    // The SEC file uses dashes for share classes: `BRK-B`, `WFC-PZ`, `TACHW`.
    expect(normaliseSymbol("BRK-B")).toBe("BRK-B");
    expect(normaliseSymbol("WFC-PZ")).toBe("WFC-PZ");
  });
});

describe("isCarriable", () => {
  it("accepts what the fragment format can hold", () => {
    for (const symbol of ["AMZN", "BRK-B", "WFC-PZ", "TACHW", "VOO"]) {
      expect(isCarriable(symbol)).toBe(true);
    }
  });

  it("refuses anything the URL could not round-trip", () => {
    for (const symbol of ["", " ", "amzn", "A B", "AMZN!", "TOOLONGSYM1", "$AMZN"]) {
      expect(isCarriable(symbol)).toBe(false);
    }
  });
});

describe("accepts", () => {
  it("accepts only common stock", () => {
    expect(accepts("ok")).toBe(true);
    for (const status of STATUSES.filter((value) => value !== "ok")) {
      expect(accepts(status)).toBe(false);
    }
  });
});

describe("refusal", () => {
  it("has one sentence for every status that is not common stock", () => {
    for (const status of STATUSES.filter((value) => value !== "ok")) {
      const sentence = refusal(status);
      expect(sentence).toBeTruthy();
      // One sentence, and no advice: the app never says what to do with money.
      expect(sentence?.split(/(?<=\.)\s/).filter(Boolean)).toHaveLength(1);
      expect(sentence).not.toMatch(/should|recommend|consider|you (may|might) want/i);
    }
  });

  it("says nothing when there is nothing to refuse", () => {
    expect(refusal("ok")).toBeNull();
  });

  it("names the actual reason, not a generic failure", () => {
    // A fund is the one refusal with an obvious next step: its own ticker works.
    expect(refusal("fund")).toMatch(/fund/i);
    expect(refusal("pfd")).toMatch(/preferred/i);
    expect(refusal("wnt")).toMatch(/warrant/i);
    expect(refusal("unit")).toMatch(/unit/i);
    expect(refusal("rgt")).toMatch(/right/i);
    expect(refusal("twin")).toMatch(/two companies|share class/i);
    // Every sentence names the thing it is about, so two refusals never read alike.
    const sentences = STATUSES.filter((status) => status !== "ok").map((status) =>
      refusal(status),
    );
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe("statusLabel", () => {
  it("gives every status a short word for a table cell", () => {
    for (const status of STATUSES) {
      expect(statusLabel(status)).toBeTruthy();
    }
    expect(statusLabel("ok")).toMatch(/common stock/i);
  });
});
