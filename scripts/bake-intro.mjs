#!/usr/bin/env node
/**
 * Bake the X-Ray intro's data: two real funds, their holdings, and the dots that fill the
 * letters of their tickers.
 *
 * The film is about one fact — two funds hold the same companies, so counting both lists
 * double-counts them — and it says it with dots: one dot per holding, inside the letters
 * of each ticker, with the shared companies moving from the first word to the second. So
 * the numbers and the positions both come from a published release rather than from a
 * fixture, and both are *baked*: the first visit costs one small request and no layout work
 * on a phone.
 *
 *     node scripts/bake-intro.mjs                 # live pointer, writes dots.bin + caption.json
 *     node scripts/bake-intro.mjs --release 2026-11-03.1
 *     node scripts/bake-intro.mjs --check         # exit 1 if the committed files are stale
 *
 * Outputs (schema and semantics: `web/components/intro/CONTRACT.md` §1):
 *
 *   web/public/intro/dots.bin      N × 7 float32 LE, no header, sorted by company_id
 *   web/public/intro/caption.json  the words' captions, the twelve labels, the metrics
 *
 * Both are committed, so the build needs no network, no font binary and no layout code.
 * Re-run after a release is promoted: the pair's filing dates do not move, but a fund can
 * drop out of the universe, and `--check` is what turns that into a red CI step instead of
 * a blank film.
 *
 * ── Determinism ───────────────────────────────────────────────────────────────────────
 * Same release in, byte-identical files out. Every random number comes from a seeded
 * PRNG whose seed is derived from a label ("VTI:0:V"), never from a clock; the record order
 * is a total order on `company_id`; and nothing iterates a `Map` to produce output. Running
 * the bake twice and comparing shasums is the test; `--check` is the gate.
 *
 * ── The one-off font extraction (no font tooling at build time) ───────────────────────
 * This machine has no fonttools, no brotli and no opentype.js, and the font is
 * `web/public/fonts/newsreader.woff2` — WOFF2. So the outlines were extracted **once**, in
 * a workspace-local venv, and committed as `web/public/intro/glyphs.json`; this script
 * reads only that JSON. Reproduction:
 *
 *     python3 -m venv .work/venv
 *     .work/venv/bin/pip install fonttools brotli uharfbuzz
 *     .work/venv/bin/python scripts/sample-glyphs.py    # writes glyphs.json, prints FONT
 *
 * `scripts/sample-glyphs.py` shapes "VTI" and "VOO" with HarfBuzz and flattens the V, T, I
 * and O outlines at weight 800 into closed polygons in em units, y down. It also prints the
 * `FONT` block hard-coded below: a build-time bake cannot recover an advance width or a
 * kern from a polygon soup, and `glyphs.json`'s shape is fixed by the contract to the four
 * letter paths. The V/O pair kerns by −83 units in this font — about two dot spacings — so
 * the layout is the *shaped* one, not the sum of advances. The font has a single `wght`
 * axis; there is no `opsz`, so "largest optical size" has nothing to select.
 *
 * ── How the dots get inside the letters ──────────────────────────────────────────────
 * The strokes are filled with weighted Poisson-disc sampling — not a lattice, not a
 * uniform scatter:
 *
 * 1. Each letter is rasterised at 1/256 em (nonzero winding, so the counter of O stays a
 *    hole) and an exact Euclidean distance transform gives every interior cell its distance
 *    to the nearest edge.
 * 2. Candidates are one per interior cell, jittered inside it, each carrying a centrality
 *    `c = min(1, distance / CENTRALITY_REF)`.
 * 3. Dart throwing in a seeded-shuffled order accepts a candidate when nothing already
 *    accepted is closer than `r = R · (1 − RADIUS_FALLOFF · c)`. The smaller radius near a
 *    stroke centre is what densifies the fill there: big holdings sit in the ink, small ones
 *    collect along the outline.
 * 4. `R` is found by bisection on the accepted count, so a letter gets *exactly* as many
 *    positions as it has companies. The letters of a word split its companies by ink area.
 *
 * Positions are then ranked by centrality and companies by weight, largest company to most
 * central position — "bigger weight = nearer a stroke centre" — and every position is
 * re-checked against the outlines before it is written, so a sampling bug fails the bake
 * instead of drifting off the letters.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(ROOT, "web/public/intro");
const DOTS_PATH = resolve(OUT_DIR, "dots.bin");
const CAPTION_PATH = resolve(OUT_DIR, "caption.json");
const GLYPHS_PATH = resolve(OUT_DIR, "glyphs.json");
const DATA_BASE = (process.env.INTRO_DATA_BASE ?? "https://data.unpackfund.com").replace(
  /\/$/,
  "",
);

/** The pair the film is about, in the order the two words arrive.
 *
 * VTI and VOO: the total-market fund and the S&P 500 fund inside it. On the 2026-11-03.1
 * release VTI holds 3,446 companies and VOO 503, 501 of them shared — so the merge beat is
 * a fact about the filings, not a coincidence of a sample. Swapping the pair is an edit
 * here plus an edit to `FONT.words`; nothing else in the film knows the tickers. */
const PAIR = ["VTI", "VOO"];

/** Every record: weight, A position, B position, rule position. 7 float32, 28 bytes. */
const RECORD_BYTES = 28;

/** Gzipped budget for `dots.bin`, from the film's performance envelope. */
const DOTS_GZIP_BUDGET = 80 * 1024;

// ───────────────────────────────────────────────────────────────────────────────────────
// Font constants. Extracted once by `scripts/sample-glyphs.py` from
// `web/public/fonts/newsreader.woff2` at wght 800; that script prints this block verbatim.
// ───────────────────────────────────────────────────────────────────────────────────────
const FONT = {
  unitsPerEm: 2000,
  /** hhea ascent/descent, in font units. Signs are the font's own: up is positive. */
  ascender: 1470,
  descender: -530,
  /**
   * Each word as the shaper lays it out: [letter, x offset in font units], plus the total
   * advance. Offsets include the font's kerning (V/O kerns −83 units in "VOO").
   */
  words: {
    VTI: {
      letters: [
        ["V", 0],
        ["T", 1557],
        ["I", 3037],
      ],
      advance: 3868,
    },
    VOO: {
      letters: [
        ["V", 0],
        ["O", 1474],
        ["O", 3088],
      ],
      advance: 4702,
    },
  },
};

/** Raster resolution for the stencil and the sampling, in em units. */
const CELL = 1 / 256;
/** Distance (in cells) at which a cell counts as "at the stroke's centre". */
const CENTRALITY_REF = 14;
/** How much of the radius the centre gives up: radius = R · (1 − f · c). */
const RADIUS_FALLOFF = 0.62;
/** Dots sit at least this far (in cells) from an edge before jitter is applied. */
const MIN_CLEARANCE = 2.2;
/** The film writes a label beside each of the twelve largest dots, so those twelve are
 *  spread across the word before the strict centrality ranking starts: twelve labels on one
 *  stroke centre would be twelve labels on top of each other. */
const LABEL_SPREAD_COUNT = 12;
const LABEL_SPREAD = 0.12;
/** Positions snap to 1/2048 em: 0.0005 em is a tenth of a pixel on screen, and snapping
 *  makes the float32 bytes compressibly repetitive. */
const POSITION_QUANTUM = 2048;

// ───────────────────────────────────────────────────────────────────────────────────────
// Seeded PRNG and geometry. No `Math.random` anywhere: two runs must not differ.
// ───────────────────────────────────────────────────────────────────────────────────────

/** FNV-1a over a label, so a seed can be named in the code ("VTI:0:V") and reviewed. */
function seedOf(label) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: 32 bits of state, uniform, and short enough to audit. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, in place, driven by the given stream. */
function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const swap = items[index];
    items[index] = items[other];
    items[other] = swap;
  }
  return items;
}

/** Nonzero winding, the fill rule the font's outlines assume: O's counter is a hole. */
function isInside(paths, px, py) {
  let winding = 0;
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 2) {
      const x0 = path[index];
      const y0 = path[index + 1];
      const x1 = path[(index + 2) % path.length];
      const y1 = path[(index + 3) % path.length];
      const side = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
      if (y0 <= py) {
        if (y1 > py && side > 0) winding += 1;
      } else if (y1 <= py && side < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

function pathBounds(paths) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 2) {
      x0 = Math.min(x0, path[index]);
      x1 = Math.max(x1, path[index]);
      y0 = Math.min(y0, path[index + 1]);
      y1 = Math.max(y1, path[index + 1]);
    }
  }
  return { x0, y0, x1, y1 };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Raster and distance field.
// ───────────────────────────────────────────────────────────────────────────────────────

/** One letter as a stencil on a grid snapped to whole cells. */
function rasterize(paths) {
  const bounds = pathBounds(paths);
  const x0 = Math.floor(bounds.x0 / CELL) * CELL - CELL;
  const y0 = Math.floor(bounds.y0 / CELL) * CELL - CELL;
  const width = Math.ceil((bounds.x1 - x0) / CELL) + 1;
  const height = Math.ceil((bounds.y1 - y0) / CELL) + 1;
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const py = y0 + (row + 0.5) * CELL;
    for (let column = 0; column < width; column += 1) {
      const px = x0 + (column + 0.5) * CELL;
      if (isInside(paths, px, py)) mask[row * width + column] = 1;
    }
  }
  let cells = 0;
  for (let cell = 0; cell < mask.length; cell += 1) cells += mask[cell];
  return { mask, width, height, x0, y0, cells };
}

const FAR = 1e20;

/** Felzenszwalb & Huttenlocher's exact 1-D squared distance transform. */
function distanceTransform1d(source, length, target) {
  const v = new Int32Array(length);
  const z = new Float64Array(length + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1; q < length; q += 1) {
    let s = (source[q] + q * q - (source[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = (source[q] + q * q - (source[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < length; q += 1) {
    while (z[k + 1] < q) k += 1;
    const delta = q - v[k];
    target[q] = delta * delta + source[v[k]];
  }
}

/** Distance, in cells, from every interior cell to the nearest cell outside the shape. */
function distanceField(stencil) {
  const { mask, width, height } = stencil;
  const field = new Float64Array(width * height);
  const row = new Float64Array(width);
  const rowOut = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) row[x] = mask[y * width + x] ? FAR : 0;
    distanceTransform1d(row, width, rowOut);
    for (let x = 0; x < width; x += 1) field[y * width + x] = rowOut[x];
  }
  const column = new Float64Array(height);
  const columnOut = new Float64Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = field[y * width + x];
    distanceTransform1d(column, height, columnOut);
    for (let y = 0; y < height; y += 1) field[y * width + x] = columnOut[y];
  }
  for (let cell = 0; cell < field.length; cell += 1) field[cell] = Math.sqrt(field[cell]);
  return field;
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Weighted Poisson-disc sampling.
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Greedy variable-radius packing. Returns the accepted candidates in acceptance order and
 * stops as soon as `count` of them are in — the bisection only ever asks "at least".
 */
function pack(candidates, count, radius) {
  const accepted = [];
  const grid = new Map();
  const radiusAt = (centrality) => radius * (1 - RADIUS_FALLOFF * centrality);
  for (const candidate of candidates) {
    const limit = radiusAt(candidate.centrality);
    const gx = Math.floor(candidate.x / radius);
    const gy = Math.floor(candidate.y / radius);
    let clear = true;
    for (let dy = -1; dy <= 1 && clear; dy += 1) {
      for (let dx = -1; dx <= 1 && clear; dx += 1) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (bucket === undefined) continue;
        for (const other of bucket) {
          const ex = other.x - candidate.x;
          const ey = other.y - candidate.y;
          if (ex * ex + ey * ey < limit * limit) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) continue;
    accepted.push(candidate);
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [candidate]);
    else bucket.push(candidate);
    if (accepted.length >= count) break;
  }
  return accepted;
}

/** The largest radius whose packing still seats `count` dots. Bisection, so the radius and
 *  the accepted set are a pure function of the candidate list and the count. */
function packExact(candidates, count) {
  if (candidates.length < count) {
    throw new Error(
      `bake-intro: not enough interior cells (${candidates.length}) for ${count} dots`,
    );
  }
  let tight = 1e-4;
  let loose = 1;
  for (let step = 0; step < 22; step += 1) {
    const middle = (tight + loose) / 2;
    if (pack(candidates, count, middle).length >= count) tight = middle;
    else loose = middle;
  }
  const accepted = pack(candidates, count, tight);
  return accepted.length > count ? accepted.slice(0, count) : accepted;
}

/** A letter instance: its outline, its stencil, and where it sits in the word. */
function makeInstance(paths, name, offset) {
  const stencil = rasterize(paths);
  return { name, paths, stencil, field: distanceField(stencil), offset };
}

/**
 * Fills one letter instance with exactly `count` dots and returns them in the word's em
 * coordinates (origin at the baseline's left edge, y down), each carrying the centrality
 * that ordered the packing.
 */
function sampleInstance(instance, count, seed) {
  const { stencil, field, offset } = instance;
  const random = mulberry32(seed);
  const candidates = [];
  for (let row = 0; row < stencil.height; row += 1) {
    for (let column = 0; column < stencil.width; column += 1) {
      const distance = field[row * stencil.width + column];
      if (distance < MIN_CLEARANCE) continue;
      const jitterX = random() - 0.5;
      const jitterY = random() - 0.5;
      candidates.push({
        x: stencil.x0 + (column + 0.5 + jitterX * 0.7) * CELL,
        y: stencil.y0 + (row + 0.5 + jitterY * 0.7) * CELL,
        centrality: Math.min(1, distance / CENTRALITY_REF),
      });
    }
  }
  shuffle(candidates, mulberry32(seed ^ 0x9e3779b9));
  return packExact(candidates, count).map((candidate) => ({
    x: candidate.x + offset,
    y: candidate.y,
    centrality: candidate.centrality,
  }));
}

/** Split `count` dots over letter instances in proportion to the ink each one covers. */
function apportion(instances, count) {
  const total = instances.reduce((sum, instance) => sum + instance.stencil.cells, 0);
  const exact = instances.map((instance) => (count * instance.stencil.cells) / total);
  const shares = exact.map((share) => Math.floor(share));
  let remaining = count - shares.reduce((sum, share) => sum + share, 0);
  const order = exact
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let step = 0; remaining > 0; step += 1) {
    shares[order[step % order.length].index] += 1;
    remaining -= 1;
  }
  return shares;
}

/** Every position for one word, most central first. */
function sampleWord(wordKey, glyphs, count) {
  const spec = FONT.words[wordKey];
  if (spec === undefined) throw new Error(`bake-intro: no FONT layout for ${wordKey}`);
  const instances = spec.letters.map(([name, offsetUnits], index) => {
    const paths = glyphs.letters[name];
    if (!paths) throw new Error(`bake-intro: glyphs.json has no outline for ${name}`);
    const instance = makeInstance(paths, name, offsetUnits / FONT.unitsPerEm);
    instance.index = index;
    return instance;
  });
  const shares = apportion(instances, count);
  const positions = [];
  instances.forEach((instance) => {
    const seed = seedOf(`${wordKey}:${instance.index}:${instance.name}`);
    positions.push(...sampleInstance(instance, shares[instance.index], seed));
  });
  positions.sort((a, b) => b.centrality - a.centrality || a.x - b.x || a.y - b.y);
  return { positions, instances, shares };
}

/**
 * Companies to positions: heaviest to most central, with one exception. The first
 * `spreadCount` companies (the ones the film labels) are placed first, each at the most
 * central position still at least `spreadDistance` em from every position already taken —
 * so twelve labels get twelve places to sit instead of one stroke centre. Every other
 * company is a strict centrality rank, which is the rule the field is built on.
 */
function assignPositions(companies, positions, spreadCount, spreadDistance) {
  const assignment = new Map();
  const taken = new Uint8Array(positions.length);
  const spread = Math.min(spreadCount, companies.length);
  for (let index = 0; index < spread; index += 1) {
    let chosen = -1;
    for (
      let candidate = 0;
      candidate < positions.length && chosen === -1;
      candidate += 1
    ) {
      if (taken[candidate]) continue;
      const point = positions[candidate];
      let clear = true;
      for (let other = 0; other < positions.length && clear; other += 1) {
        if (!taken[other]) continue;
        const dx = positions[other].x - point.x;
        const dy = positions[other].y - point.y;
        if (dx * dx + dy * dy < spreadDistance * spreadDistance) clear = false;
      }
      if (clear) chosen = candidate;
    }
    if (chosen === -1) {
      // The word is too small for the requested separation: fall back to the next most
      // central free position rather than failing the bake.
      chosen = taken.indexOf(0);
    }
    taken[chosen] = 1;
    assignment.set(companies[index].id, positions[chosen]);
  }
  let cursor = 0;
  for (let index = spread; index < companies.length; index += 1) {
    while (taken[cursor]) cursor += 1;
    taken[cursor] = 1;
    assignment.set(companies[index].id, positions[cursor]);
  }
  return assignment;
}

/** `[x, y]` → the nearest 1/2048 em, so the float32 bytes repeat their low mantissa bits. */
function snap(value) {
  return Math.round(value * POSITION_QUANTUM) / POSITION_QUANTUM;
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Release loading. Kept from the previous bake: the pointer, then the immutable prefix.
// ───────────────────────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
  return response.json();
}

async function loadRelease(requested) {
  const pointer = await getJson(`${DATA_BASE}/latest/release.json`);
  const asOf = requested && requested !== true ? requested : pointer.as_of;
  // A named release is read from its immutable prefix, so a bake of an older release stays
  // reproducible after the pointer moves. `generated_at` comes from that release's own
  // manifest, never from the clock, or two runs a minute apart would differ.
  const base = `${DATA_BASE}/releases/${asOf}`;
  const manifest = await getJson(`${base}/manifest.json`).catch(() => null);
  const generatedAt =
    manifest?.generated_at ??
    (asOf === pointer.as_of ? (pointer.generated_at ?? null) : null);
  if (typeof generatedAt !== "string") {
    throw new Error(`bake-intro: release ${asOf} publishes no generated_at`);
  }
  return { asOf, base, generatedAt };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// The bake.
// ───────────────────────────────────────────────────────────────────────────────────────

/** One company in the union, with its weight in each fund (basis points). */
function collectCompanies(documents) {
  const companies = new Map();
  const funds = documents.map((document, index) => {
    for (const holding of document.holdings) {
      if (!holding.company_id) continue;
      const row = companies.get(holding.company_id) ?? {
        id: holding.company_id,
        name: holding.name,
        ticker: holding.ticker ?? null,
        nameWeight: -1,
        present: [false, false],
        weights: [0, 0],
      };
      // A fund can name one company twice (two share lines); the fund's own vector already
      // sums them, so adding is right and duplicating a dot is not.
      row.weights[index] += holding.weight_bp;
      row.present[index] = true;
      // The name of the fund's biggest line for that company, so a label does not depend
      // on the release's row order.
      if (holding.weight_bp > row.nameWeight) {
        row.nameWeight = holding.weight_bp;
        row.name = holding.name;
        row.ticker = holding.ticker ?? row.ticker;
      }
      companies.set(holding.company_id, row);
    }
    return {
      ticker: document.ticker,
      name: document.name,
      asOf: document.as_of,
      filedAt: document.filed_at,
    };
  });
  // Total order on the id: the file order must not depend on which document was read first.
  const rows = [...companies.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { rows, funds };
}

function bake(release, documents, glyphs) {
  const { rows, funds } = collectCompanies(documents);
  const companiesA = rows.filter((row) => row.present[0]);
  const companiesB = rows.filter((row) => row.present[1]);
  const shared = rows.filter((row) => row.present[0] && row.present[1]).length;

  // `w` is normalised against the largest holding in the pair: the biggest company position
  // either fund files becomes 1.0, so dot areas are comparable across the two words.
  // Max, not sum: a shared company is one company, and summing its two filings would double
  // count exactly the way the film exists to expose.
  const heaviest = rows.reduce(
    (max, row) => Math.max(max, row.weights[0], row.weights[1]),
    0,
  );
  if (heaviest <= 0)
    throw new Error("bake-intro: no positive holding weights in the pair");

  const a = sampleWord(PAIR[0], glyphs, companiesA.length);
  const b = sampleWord(PAIR[1], glyphs, companiesB.length);

  // Rank order: the heaviest company in a fund takes the most central position in that
  // fund's word. Ties break on the id, so the assignment is a total order.
  const rankA = [...companiesA].sort(
    (left, right) => right.weights[0] - left.weights[0] || (left.id < right.id ? -1 : 1),
  );
  const rankB = [...companiesB].sort(
    (left, right) => right.weights[1] - left.weights[1] || (left.id < right.id ? -1 : 1),
  );
  const positionA = assignPositions(rankA, a.positions, LABEL_SPREAD_COUNT, LABEL_SPREAD);
  const positionB = assignPositions(rankB, b.positions, 0, 0);

  // The final rule: a hairline under the ticker line at the descender line (the bottom of
  // the box the words are set in — the contract fixes the units and the origin but not
  // which line, so the box's own floor is the reading least likely to surprise the motion).
  // Its width is word A's advance, not the longer word's: the film draws its DOM rule at
  // A's advance and the renderer maps rule-x with A's advance, so a caption that named a
  // different width would be a trap for the next person.
  const advanceA = FONT.words[PAIR[0]].advance / FONT.unitsPerEm;
  const advanceB = FONT.words[PAIR[1]].advance / FONT.unitsPerEm;
  const ruleWidth = advanceA;
  const ruleY = -FONT.descender / FONT.unitsPerEm;
  // Along the rule, records are ordered by weight so the collapse reads as a gradient
  // (biggest dots at the left) rather than as filing order.
  const ruleOrder = [...rows].sort(
    (left, right) =>
      Math.max(right.weights[0], right.weights[1]) -
        Math.max(left.weights[0], left.weights[1]) || (left.id < right.id ? -1 : 1),
  );
  const ruleIndex = new Map(ruleOrder.map((row, index) => [row.id, index]));

  const records = rows.map((row) => {
    const left = positionA.get(row.id);
    const right = positionB.get(row.id);
    return {
      w: Math.max(row.weights[0], row.weights[1]) / heaviest,
      vx: left ? snap(left.x) : Number.NaN,
      vy: left ? snap(left.y) : Number.NaN,
      ox: right ? snap(right.x) : Number.NaN,
      oy: right ? snap(right.y) : Number.NaN,
      rx: snap((ruleWidth * (ruleIndex.get(row.id) + 0.5)) / rows.length),
      ry: snap(ruleY),
    };
  });

  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  const labels = [...companiesA]
    .sort(
      (left, right) =>
        right.weights[0] - left.weights[0] || (left.id < right.id ? -1 : 1),
    )
    .slice(0, 12)
    .map((row) => ({
      name: row.name,
      ticker: row.ticker,
      // Basis points, the release's own unit for a holding weight (751 = 7.51% of NAV).
      weight: row.weights[0],
      // The join the film needs: this company is record #index of dots.bin.
      index: indexById.get(row.id),
    }));

  const caption = {
    schema: 1,
    release: release.asOf,
    generated_at: release.generatedAt,
    a: {
      ticker: funds[0].ticker,
      name: funds[0].name,
      filed_at: funds[0].filedAt,
      as_of: funds[0].asOf,
      companies: companiesA.length,
    },
    b: {
      ticker: funds[1].ticker,
      name: funds[1].name,
      filed_at: funds[1].filedAt,
      as_of: funds[1].asOf,
      companies: companiesB.length,
    },
    shared,
    labels,
    metrics: {
      unitsPerEm: FONT.unitsPerEm,
      a: {
        advance: advanceA,
        ascender: FONT.ascender / FONT.unitsPerEm,
        descender: FONT.descender / FONT.unitsPerEm,
      },
      b: {
        advance: advanceB,
        ascender: FONT.ascender / FONT.unitsPerEm,
        descender: FONT.descender / FONT.unitsPerEm,
      },
      rule: { width: ruleWidth, y: ruleY },
    },
  };

  const dots = Buffer.alloc(rows.length * RECORD_BYTES);
  records.forEach((record, index) => {
    const offset = index * RECORD_BYTES;
    dots.writeFloatLE(record.w, offset);
    dots.writeFloatLE(record.vx, offset + 4);
    dots.writeFloatLE(record.vy, offset + 8);
    dots.writeFloatLE(record.ox, offset + 12);
    dots.writeFloatLE(record.oy, offset + 16);
    dots.writeFloatLE(record.rx, offset + 20);
    dots.writeFloatLE(record.ry, offset + 24);
  });

  const instancesByWord = { [PAIR[0]]: a.instances, [PAIR[1]]: b.instances };
  const placed = verifyBuffer(dots, rows.length, instancesByWord);

  return {
    dots,
    caption,
    captionBytes: Buffer.from(`${JSON.stringify(caption)}\n`, "utf8"),
    rows,
    a,
    b,
    placed,
    counts: {
      records: rows.length,
      companiesA: companiesA.length,
      companiesB: companiesB.length,
      shared,
      held: companiesA.length + companiesB.length,
    },
  };
}

/**
 * Every position re-tested against the outlines it was sampled from — decoded back out of
 * the bytes that are about to be committed, not from the floats still in memory. A dot
 * outside a letter is a failed bake, not a cosmetic bug. The margin is the sampling's own:
 * the distance field at the dot's cell, in em, so the log line says how much room the
 * tightest dot has.
 */
function verifyBuffer(dots, count, instancesByWord) {
  const fields = [
    [PAIR[0], 4, 8],
    [PAIR[1], 12, 16],
  ];
  let checked = 0;
  let margin = Infinity;
  for (let index = 0; index < count; index += 1) {
    const base = index * RECORD_BYTES;
    for (const [wordKey, xOffset, yOffset] of fields) {
      const x = dots.readFloatLE(base + xOffset);
      const y = dots.readFloatLE(base + yOffset);
      if (Number.isNaN(x)) {
        if (!Number.isNaN(y)) {
          throw new Error(
            `bake-intro: record ${index} has one NaN ${wordKey} coordinate`,
          );
        }
        continue;
      }
      let inside = false;
      for (const instance of instancesByWord[wordKey]) {
        const localX = x - instance.offset;
        if (!isInside(instance.paths, localX, y)) continue;
        inside = true;
        const column = Math.floor((localX - instance.stencil.x0) / CELL);
        const row = Math.floor((y - instance.stencil.y0) / CELL);
        const cell = row * instance.stencil.width + column;
        if (cell >= 0 && cell < instance.field.length) {
          margin = Math.min(margin, instance.field[cell] * CELL);
        }
      }
      if (!inside) {
        throw new Error(
          `bake-intro: record ${index} sits outside the ${wordKey} letters at ` +
            `(${x.toFixed(5)}, ${y.toFixed(5)})`,
        );
      }
      checked += 1;
    }
  }
  return { checked, margin };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Entry point.
// ───────────────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? true);
};

function gzipBytes(buffer) {
  return gzipSync(buffer, { level: 9 }).length;
}

async function main() {
  const release = await loadRelease(flag("release"));
  const glyphs = JSON.parse(await readFile(GLYPHS_PATH, "utf8"));
  if (glyphs.unitsPerEm !== FONT.unitsPerEm) {
    throw new Error(
      `bake-intro: glyphs.json is ${glyphs.unitsPerEm} units/em but the bake assumes ${FONT.unitsPerEm}`,
    );
  }

  const documents = await Promise.all(
    PAIR.map((ticker) => getJson(`${release.base}/funds/${ticker}.json`)),
  );
  const field = bake(release, documents, glyphs);
  const dotsGzip = gzipBytes(field.dots);
  const captionGzip = gzipBytes(field.captionBytes);

  if (dotsGzip > DOTS_GZIP_BUDGET) {
    throw new Error(
      `bake-intro: dots.bin is ${dotsGzip} B gzipped, over the ${DOTS_GZIP_BUDGET} B budget`,
    );
  }

  const summary =
    `${field.counts.companiesA} ${PAIR[0]} + ${field.counts.companiesB} ${PAIR[1]} = ` +
    `${field.counts.held} held, ${field.counts.records} distinct (${field.counts.shared} shared)`;

  if (flag("check")) {
    const committedDots = await readFile(DOTS_PATH).catch(() => null);
    const committedCaption = await readFile(CAPTION_PATH, "utf8").catch(() => "");
    const stored = committedCaption
      ? (() => {
          try {
            return JSON.parse(committedCaption);
          } catch {
            return null;
          }
        })()
      : null;
    if (stored?.release !== release.asOf) {
      console.error(
        `bake-intro: web/public/intro/caption.json is stale — it names release ` +
          `${stored?.release ?? "(nothing)"}, the live pointer is ${release.asOf}. ` +
          `Run \`node scripts/bake-intro.mjs\` and commit the result.`,
      );
      process.exit(1);
    }
    if (committedDots === null || !committedDots.equals(field.dots)) {
      console.error(
        `bake-intro: web/public/intro/dots.bin is stale for release ${release.asOf}. ` +
          `Run \`node scripts/bake-intro.mjs\` and commit the result.`,
      );
      process.exit(1);
    }
    if (committedCaption !== field.captionBytes.toString("utf8")) {
      console.error(
        `bake-intro: web/public/intro/caption.json is stale for release ${release.asOf}. ` +
          `Run \`node scripts/bake-intro.mjs\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`bake-intro: current for ${release.asOf} (${summary})`);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(DOTS_PATH, field.dots);
  await writeFile(CAPTION_PATH, field.captionBytes);
  const hash = createHash("sha256").update(field.dots).digest("hex");
  console.log(
    `bake-intro: ${release.asOf} — ${summary}\n` +
      `           positions   ${field.placed.checked} inside the outlines, min margin ` +
      `${field.placed.margin.toFixed(4)} em\n` +
      `           dots.bin    ${field.dots.length} B raw, ${dotsGzip} B gzip, ` +
      `sha256 ${hash.slice(0, 12)}…\n` +
      `           caption.json ${field.captionBytes.length} B raw, ${captionGzip} B gzip ` +
      `→ ${OUT_DIR}`,
  );
}

main().catch((error) => {
  console.error(error?.stack ?? `bake-intro: ${error?.message ?? error}`);
  process.exit(1);
});
