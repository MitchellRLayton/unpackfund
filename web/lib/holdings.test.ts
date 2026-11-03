import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyInput, resolveEntry, tallyOf, MAX_HOLDINGS } from "./holdings";

/**
 * The network half of `resolveEntry` is mocked, and only that half: the alias map and
 * the securities shard are the two lookups that leave the browser, and a test that
 * needed real hashed objects to answer "is AMZN a stock" would be testing the loader
 * (`data.test.ts`) rather than this decision.
 */
const lookup = vi.hoisted(() => ({
  resolveAlias: vi.fn(async (): Promise<string | null> => null),
  loadSecurities: vi.fn(async (): Promise<Map<string, unknown> | null> => new Map()),
  publishesSecurities: vi.fn(() => true),
}));

vi.mock("./data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./data")>()),
  resolveAlias: lookup.resolveAlias,
  loadSecurities: lookup.loadSecurities,
  publishesSecurities: lookup.publishesSecurities,
}));
import type { LoadState } from "./use-release";
import type { ReleaseDescriptor } from "./types";

/**
 * The one implementation of "what did the visitor type".
 *
 * These are the tests that keep the Portfolio page and Compare from drifting apart:
 * each case names the sentence a reader sees, because the sentence is the part that
 * used to differ between the two pages (Compare said "not in this release" for a share
 * class the builder resolved, and refused a stock the builder accepts).
 */

const release: ReleaseDescriptor = {
  schema_version: 2,
  as_of: "2026-11-02.7",
  generated_at: "2026-11-02T12:00:00Z",
  pipeline_git_sha: "0123456789abcdef",
  counts: { funds: 3, companies: 10 },
  objects: {},
} as unknown as ReleaseDescriptor;

const ready: LoadState<ReleaseDescriptor> = {
  status: "ready",
  data: release,
  error: null,
};
const loading: LoadState<ReleaseDescriptor> = {
  status: "loading",
  data: null,
  error: null,
};
const failed: LoadState<ReleaseDescriptor> = {
  status: "error",
  data: null,
  error: {
    message: "The data host could not be reached.",
    detail: "TypeError",
    kind: "network",
  },
};

const ctx = { catalog: ["VTI", "VOO", "AVUV"], release: ready };

beforeEach(() => {
  lookup.resolveAlias.mockResolvedValue(null);
  lookup.loadSecurities.mockResolvedValue(new Map());
  lookup.publishesSecurities.mockReturnValue(true);
});

describe("classifyInput", () => {
  it("recognises cash as a word rather than as a ticker", () => {
    // "CASH" is five upper-case letters and would pass every shape test.
    expect(classifyInput("cash").kind).toBe("cash");
    expect(classifyInput("  Cash Position ").kind).toBe("cash");
  });

  it("normalises a typed ticker and keeps it", () => {
    expect(classifyInput(" vti ")).toEqual({ kind: "symbol", ticker: "VTI" });
    // A dot is a lookup convenience, not identity: the release's key uses a dash.
    expect(classifyInput("BRK.B")).toEqual({ kind: "symbol", ticker: "BRK-B" });
    // Interior spaces are stripped, because a pasted ticker often carries one.
    expect(classifyInput("V T I")).toEqual({ kind: "symbol", ticker: "VTI" });
  });

  it("refuses what is not a ticker before any fetch", () => {
    const shape = classifyInput("VTI!");
    expect(shape.kind).toBe("invalid");
    if (shape.kind === "invalid") {
      expect(shape.title).toBe("VTI! is not a ticker");
      expect(shape.body).toContain("upper-case letters");
    }
  });
});

describe("tallyOf", () => {
  it("calls a 100% list fully allocated and nothing else", () => {
    expect(tallyOf("bp", [6000, 4000])).toMatchObject({
      complete: true,
      sentence: "fully allocated",
      ok: true,
    });
  });

  it("states what is missing, and what is over, in words", () => {
    expect(tallyOf("bp", [5000]).sentence).toBe("50.00% unallocated");
    expect(tallyOf("bp", [6000, 5000])).toMatchObject({
      complete: false,
      sentence: "10.00% over 100%",
      overBp: 1000,
      unallocatedBp: 0,
    });
  });

  it("calls an empty percentage list 100% unallocated rather than complete", () => {
    // The builder shows the tally as soon as one row exists, so a row at 0.00% must
    // read as unallocated — the case that used to be a silent "fully allocated".
    expect(tallyOf("bp", [0])).toMatchObject({
      complete: false,
      sentence: "100.00% unallocated",
    });
    expect(tallyOf("bp", []).complete).toBe(false);
  });

  it("treats dollars as their own total", () => {
    expect(tallyOf("usd", [1_000_000])).toMatchObject({ complete: true, ok: true });
    expect(tallyOf("usd", [])).toMatchObject({
      complete: false,
      sentence: "no amounts yet",
    });
  });
});

describe("resolveEntry", () => {
  it("adds a fund the release publishes", async () => {
    await expect(resolveEntry("vti", ctx)).resolves.toMatchObject({
      ok: true,
      kind: "fund",
      key: "VTI",
      label: "VTI",
    });
  });

  it("refuses a duplicate in the words both pages use", async () => {
    await expect(resolveEntry("VTI", ctx, ["VTI"])).resolves.toMatchObject({
      ok: false,
      tone: "info",
      title: "VTI is already in your portfolio",
    });
    await expect(
      resolveEntry("VTI", { ...ctx, where: "Portfolio A" }, ["VTI"]),
    ).resolves.toMatchObject({ title: "VTI is already in Portfolio A" });
  });

  it("waits for the release rather than claiming a fund is missing", async () => {
    await expect(
      resolveEntry("VTI", { ...ctx, release: loading }),
    ).resolves.toMatchObject({
      ok: false,
      tone: "info",
      title: "Still reading the release",
    });
    await expect(resolveEntry("VTI", { ...ctx, release: failed })).resolves.toMatchObject(
      {
        ok: false,
        title: "The release could not be read",
        body: "The data host could not be reached.",
      },
    );
  });

  it("refuses cash where cash has no meaning, naming the page that can hold it", async () => {
    await expect(
      resolveEntry("cash", { ...ctx, allowCash: false }),
    ).resolves.toMatchObject({
      ok: false,
      title: "Cash cannot be compared",
    });
  });

  it("resolves a share class to the portfolio the release publishes", async () => {
    lookup.resolveAlias.mockResolvedValue("VOO");
    await expect(resolveEntry("VFIAX", ctx)).resolves.toMatchObject({
      ok: true,
      kind: "fund",
      key: "VOO",
      body: "VFIAX is a share class of VOO, so the holdings are the same.",
    });
  });

  it("tells a stock apart from a missing fund when the list is funds-only", async () => {
    // Compare's case: AMZN *is* a stock, and "not in this release" would be untrue.
    lookup.loadSecurities.mockResolvedValue(
      new Map([["AMZN", ["c_0001018724", "AMAZON COM INC", "Nasdaq", "ok"]]]),
    );
    await expect(
      resolveEntry("AMZN", { ...ctx, allowSecurities: false }),
    ).resolves.toMatchObject({
      ok: false,
      tone: "warn",
      title: "AMZN is a stock, not a fund",
    });
  });

  it("does not call an unknown symbol a stock", async () => {
    // The defect this test exists for: an early funds-only refusal said "ZZZZ is a
    // stock, not a fund" about a symbol it never looked up. A typo must be told it is
    // not in the release, which is a claim the lookup supports.
    await expect(
      resolveEntry("ZZZZ", { ...ctx, allowSecurities: false }),
    ).resolves.toMatchObject({
      ok: false,
      title: "ZZZZ is not in release 2026-11-02.7",
    });
  });

  it("keeps the build's own refusal for a symbol that is not common stock", async () => {
    lookup.loadSecurities.mockResolvedValue(
      new Map([["SPY", ["c_0000884394", "SPDR S&P 500 ETF TRUST", "NYSE", "fund"]]]),
    );
    const decision = await resolveEntry("SPY", ctx);
    expect(decision).toMatchObject({
      ok: false,
      title: "SPY cannot be added as a stock",
    });
  });

  it("says the release cannot answer for stocks when it predates them", async () => {
    lookup.publishesSecurities.mockReturnValue(false);
    await expect(resolveEntry("AMZN", ctx)).resolves.toMatchObject({
      ok: false,
      title: "This release does not list stock symbols yet",
    });
  });

  it("adds cash as its own kind, with the sentence that explains it", async () => {
    await expect(resolveEntry("cash", ctx)).resolves.toMatchObject({
      ok: true,
      kind: "cash",
      label: "cash",
    });
  });

  it("keeps the entry cap a number the pages can quote", () => {
    expect(MAX_HOLDINGS).toBe(40);
  });
});
