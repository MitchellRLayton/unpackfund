#!/usr/bin/env node
/**
 * Bake the first-visit intro's data: two real funds, their holdings, and the union.
 *
 * The intro is a film about one fact — two funds hold the same companies, so counting
 * both lists double-counts them. It needs three numbers and a field of dots, and every
 * one of them has to come from a published release rather than from a fixture, because
 * the caption names the funds and their filing dates on screen.
 *
 *     node scripts/bake-intro.mjs                # live pointer, writes the asset
 *     node scripts/bake-intro.mjs --release 2026-11-03.1
 *     node scripts/bake-intro.mjs --check        # fail if the committed asset is stale
 *
 * Output is committed (`web/public/intro/field.json`) so the build needs no network and
 * the first visit costs one 8 kB request that is already in the CDN. Re-run it after a
 * release is promoted: the pair's filing dates do not move, but a fund can drop out of
 * the universe, and `--check` is what turns that into a red CI step instead of a blank
 * film. The script is deterministic — same release in, byte-identical file out.
 *
 * What it does *not* bake: the dot positions. `web/components/intro/layout.ts` packs them
 * on the client from the weights written here, so the packing rule has one implementation
 * and can be re-tuned without a re-bake.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../web/public/intro/field.json");
const DATA_BASE = (process.env.INTRO_DATA_BASE ?? "https://data.unpackfund.com").replace(
  /\/$/,
  "",
);

/** The pair the film is about, in the order the two cards arrive.
 *
 * VTI and VOO are the two largest US equity funds in the release and one is inside the
 * other: every S&P 500 company VOO holds is also in VTI's total-market list. That makes
 * the merge beat — 501 + 317, 73 shared, 745 distinct — a fact about the filings rather
 * than a coincidence of the sample, which is the whole argument of the film.
 *
 * Swapping the pair is a one-line edit here plus a re-bake; the film reads the counts, so
 * nothing else changes. */
const PAIR = ["SPY", "VOO"];

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? true);
};

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
  return response.json();
}

/** The pointer, then `releases/{as_of}/…` — the app's own order, never a guessed path. */
async function loadRelease(requested) {
  const pointer = await getJson(`${DATA_BASE}/latest/release.json`);
  const asOf = requested && requested !== true ? requested : pointer.as_of;
  if (asOf !== pointer.as_of) {
    // A named release is read from its immutable prefix, so a bake of an older release
    // stays reproducible after the pointer moves.
    return { asOf, base: `${DATA_BASE}/releases/${asOf}`, pointer };
  }
  return { asOf, base: `${DATA_BASE}/releases/${asOf}`, pointer };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function bake(release, documents) {
  /** company_id → the weights it carries, per fund. */
  const companies = new Map();
  const funds = documents.map((doc) => {
    const mapped = doc.holdings.filter((holding) => holding.company_id);
    for (const holding of mapped) {
      const row = companies.get(holding.company_id) ?? {
        id: holding.company_id,
        weight: 0,
        inA: false,
        inB: false,
        name: holding.name,
        ticker: holding.ticker,
      };
      // A fund can name one company twice (two share lines); the fund's own vector
      // already sums them, so adding is right and duplicating a dot is not.
      row.weight += holding.weight_bp;
      if (doc.ticker === PAIR[0]) row.inA = true;
      else row.inB = true;
      companies.set(holding.company_id, row);
    }
    return {
      ticker: doc.ticker,
      name: doc.name,
      as_of: doc.as_of,
      filed_at: doc.filed_at,
      lag_days: doc.lag_days,
      coverage_pct: doc.coverage_pct,
      holdings: mapped.length,
    };
  });

  const rows = [...companies.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const shared = rows.filter((row) => row.inA && row.inB).length;
  const held = funds[0].holdings + funds[1].holdings;

  return {
    schema: 1,
    release: release.asOf,
    generated_at: release.pointer.generated_at ?? null,
    pair: PAIR,
    funds,
    totals: { held, distinct: rows.length, shared },
    // The dozen names the film writes beside the largest dots, so the labels are the
    // release's own and a reader can find them in the ledger. Nothing else carries a
    // name: 504 labels would be a table, not a field.
    labels: [...rows]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((row) => ({ name: row.name, ticker: row.ticker, weight: row.weight })),
    companies: rows.map((row) => ({
      // `k` is the dot's provenance, which is the only colour the film uses:
      //  a = only the first fund, b = only the second, s = both.
      k: row.inA && row.inB ? "s" : row.inA ? "a" : "b",
      w: row.weight,
    })),
  };
}

async function main() {
  const release = await loadRelease(flag("release"));
  const documents = await Promise.all(
    PAIR.map((ticker) => getJson(`${release.base}/funds/${ticker}.json`)),
  );
  const field = bake(release, documents);
  const json = `${JSON.stringify(field)}\n`;

  if (flag("check")) {
    const committed = await readFile(OUT, "utf8").catch(() => "");
    if (committed !== json) {
      console.error(
        `bake-intro: web/public/intro/field.json is stale or missing for release ${release.asOf}.\n` +
          `Run \`node scripts/bake-intro.mjs\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`bake-intro: current for ${release.asOf} (${field.totals.distinct} dots)`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, json);
  console.log(
    `bake-intro: ${release.asOf} — ${field.funds.map((f) => `${f.ticker} ${f.holdings}`).join(" + ")} = ` +
      `${field.totals.held} held, ${field.totals.distinct} distinct (${field.totals.shared} shared)\n` +
      `           ${json.length} B raw, sha256 ${sha256(json).slice(0, 12)}… → ${OUT}`,
  );
}

main().catch((error) => {
  console.error(`bake-intro: ${error.message}`);
  process.exit(1);
});
