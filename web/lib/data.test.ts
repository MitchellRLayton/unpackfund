// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DataError,
  fundFile,
  loadFund,
  loadManifest,
  releaseUrl,
  sha256Hex,
  tickersFromManifest,
} from "./data";
import type { FundDocument, ReleaseManifest } from "./types";

const MANIFEST: ReleaseManifest = {
  schema_version: 1,
  as_of: "2026-10-28.3",
  generated_at: "2026-10-28T22:59:00Z",
  pipeline_git_sha: "abc1234",
  fund_count: 2,
  etf_count: null,
  etf_classifier: "pending_adr_0007_c3",
  company_count: 2,
  coverage_histogram: {},
  mapping_rungs: {},
  asset_cat_counts: {},
  files: [
    { path: "funds/VOO.json", bytes: 10, sha256: "a".repeat(64) },
    { path: "funds/AVUV.json", bytes: 10, sha256: "b".repeat(64) },
    { path: "indices/sp500.json", bytes: 10, sha256: "c".repeat(64) },
  ],
};

const FUND: FundDocument = {
  schema_version: 1,
  ticker: "VOO",
  fund_id: "S000002839",
  name: "VANGUARD 500 INDEX FUND",
  issuer: "VANGUARD INDEX FUNDS",
  as_of: "2026-06-30",
  filed_at: "2026-08-28",
  lag_days: 59,
  source: "SEC N-PORT",
  source_url: "https://www.sec.gov/example",
  coverage_pct: 90.3,
  holdings: [
    { company_id: "c_1", name: "X", ticker: "X", asset_cat: "equity", weight_bp: 100 },
  ],
  metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
  warnings: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the catalog comes from the manifest, not from a guess", () => {
  it("reads funded tickers out of files[] and ignores everything else", () => {
    expect(tickersFromManifest(MANIFEST)).toEqual(["AVUV", "VOO"]);
  });

  it("builds a release URL from the manifest as_of", () => {
    expect(releaseUrl(MANIFEST, "funds/VOO.json")).toBe(
      "https://data.unpackfund.com/releases/2026-10-28.3/funds/VOO.json",
    );
  });

  it("names the funds a release does have when one is missing", () => {
    expect(() => fundFile(MANIFEST, "SPY")).toThrowError(/SPY is not in this release/);
    try {
      fundFile(MANIFEST, "SPY");
    } catch (error) {
      expect(error).toBeInstanceOf(DataError);
      expect((error as DataError).kind).toBe("missing-fund");
      expect((error as DataError).detail).toContain("AVUV, VOO");
    }
  });
});

describe("loadManifest", () => {
  it("accepts a schema-v1 pointer", async () => {
    const manifest = await loadManifest(async () => jsonResponse(MANIFEST));
    expect(manifest.as_of).toBe("2026-10-28.3");
  });

  it("refuses a pointer it does not understand", async () => {
    await expect(
      loadManifest(async () => jsonResponse({ ...MANIFEST, schema_version: 2 })),
    ).rejects.toThrowError(/does not describe a release/);
  });

  it("distinguishes an unreachable host from a missing release", async () => {
    await expect(
      loadManifest(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(loadManifest(async () => jsonResponse({}, 404))).rejects.toMatchObject({
      kind: "status",
    });
  });

  it("refuses a non-JSON body without pretending it was a release", async () => {
    await expect(
      loadManifest(async () => new Response("<html>blocked</html>", { status: 200 })),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("loadFund", () => {
  it("verifies the manifest hash before the document is used", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(FUND));
    const manifest: ReleaseManifest = {
      ...MANIFEST,
      files: [
        {
          path: "funds/VOO.json",
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        },
      ],
    };
    const fund = await loadFund(manifest, "VOO", async () => new Response(bytes));
    expect(fund.ticker).toBe("VOO");
    expect(fund.holdings).toHaveLength(1);
  });

  it("refuses a document whose hash disagrees with the manifest", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(FUND));
    const manifest: ReleaseManifest = {
      ...MANIFEST,
      files: [
        { path: "funds/VOO.json", bytes: bytes.byteLength, sha256: "f".repeat(64) },
      ],
    };
    await expect(
      loadFund(manifest, "VOO", async () => new Response(bytes)),
    ).rejects.toMatchObject({ kind: "hash" });
  });

  it("reports a failed fetch as a network problem, not a missing fund", async () => {
    const manifest: ReleaseManifest = {
      ...MANIFEST,
      files: [{ path: "funds/VOO.json", bytes: 1, sha256: "a".repeat(64) }],
    };
    await expect(
      loadFund(manifest, "VOO", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});
