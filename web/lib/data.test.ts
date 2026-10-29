// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import {
  DataError,
  POINTER_PATH,
  POINTER_URL,
  clearShardCache,
  loadCompany,
  loadFund,
  loadRelease,
  loadTickers,
  releaseUrl,
  shardFor,
  sha256Hex,
} from "./data";
import type {
  CompanyShard,
  FundDocument,
  FundIndexShard,
  ReleaseDescriptor,
} from "./types";

const RELEASE: ReleaseDescriptor = {
  schema_version: 2,
  kind: "release",
  as_of: "2026-10-30.1",
  generated_at: "2026-10-30T00:00:00Z",
  pipeline_git_sha: "abc1234",
  fund_count: 2,
  etf_count: 3,
  etf_classifier: "name_rule_v1",
  company_count: 2,
  coverage_histogram: {},
  mapping_rungs: {},
  asset_cat_counts: {},
  objects: {
    manifest: { path: "manifest.json", bytes: 10, sha256: "a".repeat(64) },
    tickers: { path: "tickers.json", bytes: 10, sha256: "b".repeat(64) },
    catalogue: { path: "catalogue.json", bytes: 10, sha256: "c".repeat(64) },
    fund_index: { prefix: "index/", shards: ["A", "V"], funds: 2 },
    companies: {
      index: { path: "companies/index.json", bytes: 10, sha256: "d".repeat(64) },
      prefix: "companies/",
      count: 1,
    },
  },
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

async function shardForFunds(
  entries: Record<string, FundDocument>,
): Promise<FundIndexShard> {
  const funds: FundIndexShard["funds"] = {};
  for (const [ticker, fund] of Object.entries(entries)) {
    const bytes = new TextEncoder().encode(JSON.stringify(fund));
    funds[ticker] = { bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }
  return { as_of: RELEASE.as_of, funds };
}

/** A fetch that serves a release directory out of a map, the way R2 would. */
function releaseHost(files: Record<string, unknown>): (url: string) => Promise<Response> {
  const prefix = `https://data.unpackfund.com/releases/${RELEASE.as_of}/`;
  return async (url: string) => {
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    if (!(path in files)) return new Response("missing", { status: 404 });
    return jsonResponse(files[path]);
  };
}

beforeEach(() => {
  clearShardCache();
});

describe("the pointer a production build reads", () => {
  it("is the live one, not the rehearsal prefix", () => {
    // A production bundle that reads staging/ looks healthy — the rehearsal prefix
    // held a byte-identical copy — and then moves when someone uploads a rehearsal.
    // The name carries the schema: `manifest.json` was the day-4 inventory pointer.
    expect(POINTER_PATH).toBe("latest/release.json");
    expect(POINTER_URL).toBe("https://data.unpackfund.com/latest/release.json");
  });
});

describe("the release descriptor", () => {
  it("accepts a schema-v2 pointer", async () => {
    const release = await loadRelease(async () => jsonResponse(RELEASE));
    expect(release.as_of).toBe("2026-10-30.1");
    expect(release.objects.fund_index.shards).toEqual(["A", "V"]);
  });

  it("refuses the day-4 inventory, which is not a descriptor", async () => {
    // The old pointer was a manifest with files[]; reading it as a descriptor
    // would silently give a release with no tickers, so it is refused.
    await expect(
      loadRelease(async () =>
        jsonResponse({ ...RELEASE, schema_version: 1, kind: undefined }),
      ),
    ).rejects.toThrowError(/does not describe a release/);
  });

  it("distinguishes an unreachable host from a missing release", async () => {
    await expect(
      loadRelease(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(loadRelease(async () => jsonResponse({}, 404))).rejects.toMatchObject({
      kind: "status",
    });
  });

  it("refuses a non-JSON body without pretending it was a release", async () => {
    await expect(
      loadRelease(async () => new Response("<html>blocked</html>", { status: 200 })),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("builds a release URL from the descriptor's as_of", () => {
    expect(releaseUrl(RELEASE, "funds/VOO.json")).toBe(
      "https://data.unpackfund.com/releases/2026-10-30.1/funds/VOO.json",
    );
  });
});

describe("shardFor", () => {
  it("is the ticker's first letter, with one shard for the rest", () => {
    expect(shardFor("VOO")).toBe("V");
    expect(shardFor("avuv")).toBe("A");
    expect(shardFor("1234")).toBe("_");
    expect(shardFor("")).toBe("_");
  });
});

describe("loadTickers", () => {
  it("verifies the hash the descriptor publishes", async () => {
    const body = { as_of: RELEASE.as_of, tickers: ["AVUV", "VOO"] };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const release: ReleaseDescriptor = {
      ...RELEASE,
      objects: {
        ...RELEASE.objects,
        tickers: {
          path: "tickers.json",
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        },
      },
    };
    const tickers = await loadTickers(release, releaseHost({ "tickers.json": body }));
    expect(tickers).toEqual(["AVUV", "VOO"]);
  });

  it("refuses a ticker list whose hash disagrees", async () => {
    await expect(
      loadTickers(
        RELEASE,
        releaseHost({ "tickers.json": { as_of: RELEASE.as_of, tickers: [] } }),
      ),
    ).rejects.toMatchObject({ kind: "hash" });
  });

  it("refuses a ticker list from another release", async () => {
    const body = { as_of: "2026-01-01.1", tickers: ["VOO"] };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const release: ReleaseDescriptor = {
      ...RELEASE,
      objects: {
        ...RELEASE.objects,
        tickers: {
          path: "tickers.json",
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        },
      },
    };
    await expect(
      loadTickers(release, releaseHost({ "tickers.json": body })),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("loadFund", () => {
  it("verifies the fund against its index shard before use", async () => {
    const shard = await shardForFunds({ VOO: FUND });
    const fund = await loadFund(
      RELEASE,
      "VOO",
      releaseHost({ "index/V.json": shard, "funds/VOO.json": FUND }),
    );
    expect(fund.ticker).toBe("VOO");
    expect(fund.holdings).toHaveLength(1);
  });

  it("fetches one shard for several funds that share a first letter", async () => {
    const shard = await shardForFunds({ VOO: FUND });
    const calls: string[] = [];
    const host = releaseHost({ "index/V.json": shard, "funds/VOO.json": FUND });
    const counting = async (url: string) => {
      calls.push(url);
      return host(url);
    };
    await loadFund(RELEASE, "VOO", counting);
    await loadFund(RELEASE, "VOO", counting);
    expect(calls.filter((url) => url.endsWith("index/V.json"))).toHaveLength(1);
  });

  it("refuses a document whose hash disagrees with the shard", async () => {
    const shard: FundIndexShard = {
      as_of: RELEASE.as_of,
      funds: { VOO: { bytes: 10, sha256: "f".repeat(64) } },
    };
    await expect(
      loadFund(
        RELEASE,
        "VOO",
        releaseHost({ "index/V.json": shard, "funds/VOO.json": FUND }),
      ),
    ).rejects.toMatchObject({ kind: "hash" });
  });

  it("names the release when a ticker is not in it", async () => {
    const empty: FundIndexShard = { as_of: RELEASE.as_of, funds: {} };
    await expect(
      loadFund(RELEASE, "SPY", releaseHost({ "index/S.json": empty })),
    ).rejects.toMatchObject({ kind: "missing-fund" });
    try {
      await loadFund(RELEASE, "SPY", releaseHost({ "index/S.json": empty }));
    } catch (error) {
      expect(error).toBeInstanceOf(DataError);
      expect((error as DataError).message).toContain("SPY is not in this release");
      expect((error as DataError).detail).toContain("2 funds");
    }
  });

  it("reports a failed fetch as a network problem, not a missing fund", async () => {
    const shard = await shardForFunds({ VOO: FUND });
    await expect(
      loadFund(RELEASE, "VOO", async (url) => {
        if (url.endsWith("index/V.json")) return jsonResponse(shard);
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("does not remember a failed shard", async () => {
    const shard = await shardForFunds({ VOO: FUND });
    let attempts = 0;
    const flaky = async (url: string) => {
      if (url.endsWith("index/V.json")) {
        if (attempts++ === 0) return new Response("nope", { status: 503 });
        return jsonResponse(shard);
      }
      return jsonResponse(FUND);
    };
    await expect(loadFund(RELEASE, "VOO", flaky)).rejects.toMatchObject({
      kind: "status",
    });
    await expect(loadFund(RELEASE, "VOO", flaky)).resolves.toMatchObject({
      ticker: "VOO",
    });
  });
});

describe("loadCompany", () => {
  const shard: CompanyShard = {
    as_of: RELEASE.as_of,
    company_id: "c_0001045810",
    name: "NVIDIA Corp.",
    ticker: "NVDA",
    funds: [["QQQ", 760]],
  };

  it("reads one company's holders", async () => {
    const company = await loadCompany(
      RELEASE,
      "c_0001045810",
      releaseHost({ "companies/c_0001045810.json": shard }),
    );
    expect(company.funds).toEqual([["QQQ", 760]]);
  });

  it("refuses a shard from another release", async () => {
    await expect(
      loadCompany(
        RELEASE,
        "c_0001045810",
        releaseHost({
          "companies/c_0001045810.json": { ...shard, as_of: "2026-01-01.1" },
        }),
      ),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("refuses a shard for a different company", async () => {
    await expect(
      loadCompany(
        RELEASE,
        "c_0001045810",
        releaseHost({
          "companies/c_0001045810.json": { ...shard, company_id: "c_other" },
        }),
      ),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});
