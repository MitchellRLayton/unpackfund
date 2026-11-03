/** @vitest-environment node */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The theme is automatic: the page declares `color-scheme: light dark` and one
 * `prefers-color-scheme: dark` block redefines the tokens. Nothing in the app
 * chooses a mode, so there is no toggle to test — what can silently break is a
 * palette that stops meeting contrast, in one scheme and not the other, which a
 * screenshot in the operator's own scheme would never reveal.
 *
 * These are WCAG 2.2 AA text-contrast ratios over the *tokens*, computed from the
 * stylesheet itself rather than from a copy of it: a token change that fixes one
 * surface and breaks another fails here (static-xray-frontend §7).
 *
 * The redesign moved the palette to OKLCH, so this file converts OKLCH to sRGB
 * before measuring. The conversion is the standard one (Björn Ottosson's OKLab
 * matrices) and it clamps to the sRGB gamut, which is what a browser does when it
 * paints an out-of-gamut colour: measuring the unclamped value would report a
 * contrast the reader never sees.
 */

const CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function blockAfter(pattern: RegExp): string {
  const start = CSS.search(pattern);
  if (start < 0) throw new Error(`globals.css is missing ${pattern}`);
  const match = CSS.slice(start).match(/:root\s*\{([\s\S]*?)\n\s*\}/);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("globals.css has no :root block after " + pattern);
  }
  return body;
}

/** `--name: value;` for every token in a block, comments stripped. */
function declarations(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) found[name] = value.trim();
  }
  return found;
}

const LIGHT_RAW = declarations(blockAfter(/:root\s*\{/));
const DARK_RAW = declarations(blockAfter(/@media\s*\(prefers-color-scheme:\s*dark\)/));

/** A colour token is one that paints: an OKLCH value or a mix of them. */
function isColour(value: string): boolean {
  return /^oklch\(/.test(value) || /^color-mix\(/.test(value);
}

/**
 * Resolve `var(--x)` aliases within one theme, so a pair can name either the
 * semantic token or the compatibility alias and measure the same colour.
 */
function resolve(theme: Record<string, string>, name: string, depth = 0): string {
  const value = theme[name];
  if (value === undefined) throw new Error(`missing token --${name}`);
  if (depth > 8) throw new Error(`alias loop at --${name}`);
  const reference = /^var\(--([\w-]+)\)$/.exec(value);
  if (reference?.[1]) return resolve(theme, reference[1], depth + 1);
  return value;
}

/** OKLCH → linear sRGB, clamped to the gamut the way a browser paints it. */
function linearFromOklch(value: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!match) throw new Error(`not an oklch colour: ${value}`);
  const [, rawL, rawC, rawH] = match;
  const lightness = Number(rawL) > 1 ? Number(rawL) / 100 : Number(rawL);
  const chroma = Number(rawC);
  const hue = (Number(rawH) * Math.PI) / 180;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const clamp = (channel: number) => Math.min(1, Math.max(0, channel));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function hexFromLinear(channels: readonly number[]): string {
  const encode = (value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    const srgb =
      clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + channels.map(encode).join("");
}

/** Every colour token as a hex string, for the contrast and CVD maths below. */
function hexes(theme: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(theme)) {
    const value = resolve(theme, name);
    if (/^oklch\(/.test(value)) out[name] = hexFromLinear(linearFromOklch(value));
  }
  return out;
}

const LIGHT = hexes(LIGHT_RAW);
// The dark block overrides the light one rather than replacing it, so an alias
// declared only in `:root` still resolves in the dark scheme — which is exactly how
// the browser cascades it.
const DARK = hexes({ ...LIGHT_RAW, ...DARK_RAW });

function linearChannels(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

function luminance(hex: string): number {
  const [r, g, b] = linearChannels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const high = Math.max(first, second);
  const low = Math.min(first, second);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Colour-vision deficiency, so "the two geography inks are distinguishable" is a
 * measurement and not a claim. Machado, Oliveira & Fernandes (2009) severity-1.0 matrices
 * applied in linear sRGB — the standard approximation for complete dichromacy, which
 * covers the ~8% of men (0.5% of women) with the common forms.
 *
 * This exists because the ledger's first blue-versus-violet pair *looked* fine and was
 * one colour to a deuteranope: 35.9 apart normally, 7.5 after simulation. The operator
 * adopted a blue-versus-ochre palette on exactly that reasoning (2026-11-02), so the
 * reasoning is now a test: a future hue that collapses for a red-green reader fails here.
 */
const CVD_MATRICES: Record<string, readonly (readonly number[])[]> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function simulate(hex: string, matrix: readonly (readonly number[])[]): string {
  const source = linearChannels(hex);
  return hexFromLinear(
    matrix.map((row) => row.reduce((sum, weight, i) => sum + weight * source[i]!, 0)),
  );
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = linearChannels(hex);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a: string, b: string): number {
  const [first, second] = [lab(a), lab(b)];
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/**
 * Every pair that carries text. 4.5:1 is AA for normal-size text.
 *
 * The redesign's names are used directly (`--ink`, `--graphite`, `--tier-*-ink`), and
 * the compatibility aliases are exercised through the same list where a legacy
 * component still reads them, so an alias that drifts from its token fails here.
 */
const TEXT_PAIRS: Array<[fg: string, bg: string, why: string]> = [
  ["ink", "paper", "body text"],
  ["ink", "surface", "text on a raised surface"],
  ["graphite", "paper", "secondary text"],
  ["graphite", "surface", "secondary text on a raised surface"],
  ["fg", "bg", "the legacy alias pair, which must still resolve"],
  ["muted", "bg", "the legacy secondary alias"],
  // A country code is text, so the tier's text-weight ink answers to 4.5:1 even
  // though the 4px edge beside it only has to answer to 3:1.
  ["tier-us-ink", "paper", "a US country code"],
  ["tier-dm-ink", "paper", "a developed-market country code"],
  ["tier-em-ink", "paper", "an emerging-market country code"],
  ["tier-none-ink", "paper", "an untiered country code"],
  ["tier-us-ink", "surface", "a US country code on a raised surface"],
  ["tier-dm-ink", "surface", "a developed-market code on a raised surface"],
  ["tier-em-ink", "surface", "an emerging-market code on a raised surface"],
  ["tier-none-ink", "surface", "an untiered code on a raised surface"],
  // Errors are the only place `--alert` is allowed, and they always carry an icon
  // and words, so the ink is what has to be readable.
  ["alert-ink", "alert-wash", "error text in an alert notice"],
  ["ink", "alert-wash", "body text in an alert notice"],
  ["paper", "ink", "the primary button's label"],
  // A shaded row carries the same text as any other row, so both of its inks are
  // checked against the tint — in both schemes.
  ["ink", "tint-direct", "body text on a row shaded for a direct position"],
  ["graphite", "tint-direct", "secondary text on a shaded row"],
  ["ink", "tint-direct-hover", "body text on a shaded row under the pointer"],
  ["graphite", "tint-direct-hover", "secondary text on a shaded row under the pointer"],
  // The bracketed difference in the `In VT` column, painted green above the benchmark
  // and red below it. It is text, so it answers to 4.5:1 on every background a ledger
  // row can have — the same four the edges are held to at 3:1. The sign is always
  // printed, so the colour never carries the meaning alone.
  ["delta-up", "paper", "a bracket above the benchmark"],
  ["delta-up", "surface", "a bracket above the benchmark, hovered"],
  ["delta-up", "tint-direct", "a bracket above the benchmark on a direct row"],
  [
    "delta-up",
    "tint-direct-hover",
    "a bracket above the benchmark on a direct row under the pointer",
  ],
  ["delta-down", "paper", "a bracket below the benchmark"],
  ["delta-down", "surface", "a bracket below the benchmark, hovered"],
  ["delta-down", "tint-direct", "a bracket below the benchmark on a direct row"],
  [
    "delta-down",
    "tint-direct-hover",
    "a bracket below the benchmark on a direct row under the pointer",
  ],
];

/**
 * Non-text pairs, held to 3:1 — AA for a graphical object (WCAG 2.2 SC 1.4.11). The
 * geography edges are exactly that: a stripe whose job is to be found while scanning a
 * table, painted over the row's own colour rather than over the page, which is why every
 * background a ledger row can have is listed.
 *
 * These were excluded from this file when the channel shipped, on the reasoning that "a
 * 3px stripe is not text". The operator then could not tell the two domiciles apart, and
 * the US edge measured 1.85:1 on the page: the exclusion had removed the only check that
 * would have caught it. A graphic that carries a distinction gets a gate, or the next
 * palette tweak quietly makes it invisible again.
 */
const UI_PAIRS: Array<[fg: string, bg: string, why: string]> = [
  ["tier-us", "paper", "the US edge on a plain row"],
  ["tier-us", "surface", "the US edge on a hovered row"],
  ["tier-us", "tint-direct", "the US edge on a direct-position row"],
  ["tier-us", "tint-direct-hover", "the US edge on a direct row under the pointer"],
  ["tier-dm", "paper", "the developed edge on a plain row"],
  ["tier-dm", "surface", "the developed edge on a hovered row"],
  ["tier-dm", "tint-direct", "the developed edge on a direct-position row"],
  [
    "tier-dm",
    "tint-direct-hover",
    "the developed edge on a direct row under the pointer",
  ],
  ["tier-em", "paper", "the emerging edge on a plain row"],
  ["tier-em", "surface", "the emerging edge on a hovered row"],
  ["tier-em", "tint-direct", "the emerging edge on a direct-position row"],
  ["tier-em", "tint-direct-hover", "the emerging edge on a direct row under the pointer"],
  // The neutral covers the two states that have no colour at all: a domicile in
  // neither list (solid) and a company the release could not place (dashed). Both draw
  // the same token, so one set of pairs covers both.
  ["tier-none", "paper", "the neutral edge on a plain row"],
  ["tier-none", "surface", "the neutral edge on a hovered row"],
  ["tier-none", "tint-direct", "the neutral edge on a direct-position row"],
  [
    "tier-none",
    "tint-direct-hover",
    "the neutral edge on a direct row under the pointer",
  ],
];

function pairs(
  theme: Record<string, string>,
  list: Array<[string, string, string]> = TEXT_PAIRS,
): Array<[string, string, string]> {
  return list.map(([fg, bg, why]) => {
    const foreground = theme[fg];
    const background = theme[bg];
    if (!foreground || !background) {
      throw new Error(`missing token ${fg} or ${bg}`);
    }
    return [foreground, background, `${why} (${fg} on ${bg})`];
  });
}

describe("automatic light/dark", () => {
  it("declares both schemes and follows the system setting", () => {
    expect(CSS).toMatch(/color-scheme:\s*light dark/);
    expect(CSS).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  });

  it("redefines every painted token in dark, so nothing is left on a light value", () => {
    const painted = Object.entries(LIGHT_RAW)
      .filter(([, value]) => isColour(value))
      .map(([name]) => name)
      .sort();
    expect(painted.length).toBeGreaterThan(10);
    // Every colour the light scheme paints must be repainted in dark. A token that is
    // only an alias (`var(--x)`) needs no entry: it resolves through the token that is.
    for (const name of painted) {
      expect(DARK_RAW[name], `--${name} is not redefined in dark`).toBeDefined();
    }
  });

  for (const [theme, name] of [
    [LIGHT, "light"],
    [DARK, "dark"],
  ] as const) {
    it(`meets WCAG AA text contrast in ${name}`, () => {
      const failures = pairs(theme)
        .filter(([fg, bg]) => contrast(fg, bg) < 4.5)
        .map(
          ([fg, bg, why]) => `${why}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}:1`,
        );
      expect(failures).toEqual([]);
    });

    it(`keeps the geography edges at 3:1 in ${name}`, () => {
      const failures = pairs(theme, UI_PAIRS)
        .filter(([fg, bg]) => contrast(fg, bg) < 3)
        .map(
          ([fg, bg, why]) => `${why}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}:1`,
        );
      expect(failures).toEqual([]);
    });

    it(`keeps every pair of geography inks apart for colour-blind readers in ${name}`, () => {
      // Each entry: the two tokens, the separation uncorrected vision must show, and why.
      // The simulated floor is the same for every pair — 25 is where two inks read as one
      // colour — and the uncorrected floor differs by what the pair is. Blue against
      // either ochre clears 40 with room. The two ochres cannot: both must clear the 3:1
      // non-text floor on every row background, which confines them to a narrow lightness
      // band and caps their separation. Their floor is 30 — still two clearly different
      // tones — because 40 is unreachable by construction, not because it was lowered for
      // convenience.
      const INK_PAIRS: Array<[string, string, number, string]> = [
        ["tier-us", "tier-dm", 40, "blue against the developed ochre"],
        ["tier-us", "tier-em", 40, "blue against the emerging ochre"],
        ["tier-dm", "tier-em", 30, "the two ochres against each other"],
        // The bracket's green against red is **not** listed, and that is a recorded
        // decision rather than an omission: green and red are the pair that collapses for
        // a deuteranope, so gating them at 25 dE would forbid the ink the operator asked
        // for and force a hue nobody wanted. The colour is allowed to carry the sign only
        // because it is never the carrier: `formatSignedShare` prints `+` or `-`, the
        // caption states green-for-more and red-for-less, and the component test holds
        // that every coloured bracket also carries its sign.
        // The neutral has to read as "no tier" rather than as a washed-out tier, so it
        // gets an uncorrected floor of 28 — the tightest the three tier pairs allow it
        // without pretending a grey is a hue. The simulated floor stays at 25 for every
        // pair.
        ["tier-none", "tier-us", 28, "the neutral against the blue tier"],
        ["tier-none", "tier-dm", 28, "the neutral against the developed ochre"],
        ["tier-none", "tier-em", 28, "the neutral against the emerging ochre"],
      ];
      const MIN_SIMULATED_SEPARATION = 25;
      const background = theme["paper"];
      if (!background) throw new Error("missing --paper");

      const failures: string[] = [];
      for (const [leftName, rightName, normalFloor, why] of INK_PAIRS) {
        const left = theme[leftName];
        const right = theme[rightName];
        if (!left || !right) throw new Error(`missing ${leftName} or ${rightName}`);

        const normal = deltaE(left, right);
        if (normal < normalFloor) {
          failures.push(
            `${why}: uncorrected dE ${normal.toFixed(1)} (want >= ${normalFloor})`,
          );
        }
        for (const [kind, matrix] of Object.entries(CVD_MATRICES)) {
          const simulatedLeft = simulate(left, matrix);
          const simulatedRight = simulate(right, matrix);
          const separation = deltaE(simulatedLeft, simulatedRight);
          if (separation < MIN_SIMULATED_SEPARATION) {
            failures.push(
              `${why}: ${kind} dE ${separation.toFixed(1)} (want >= ${MIN_SIMULATED_SEPARATION}) — ` +
                `${left} -> ${simulatedLeft} and ${right} -> ${simulatedRight}`,
            );
          }
          // A pair that reached the floor only because the simulated background moved
          // would still be a stripe a reader cannot find.
          const simulatedBackground = simulate(background, matrix);
          for (const [ink, simulated] of [
            [left, simulatedLeft],
            [right, simulatedRight],
          ] as const) {
            const ratio = contrast(simulated, simulatedBackground);
            if (ratio < 3) {
              failures.push(
                `${why}: ${kind} turns ${ink} into ${simulated}, ${ratio.toFixed(2)}:1 on ${simulatedBackground}`,
              );
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("paints the bracket from its sign class, and leaves an exact match quiet", () => {
    // The table writes `span.delta` plus `--up` or `--down` from the arithmetic sign;
    // these three rules are the whole mapping. A rename on either side would drop the
    // colour silently — the table would keep working and the operator would see a plain
    // number again — which is what this holds. The rules must key off the class, not off
    // `data-tier`: geography owns the row edge, and a row can be American and below the
    // benchmark at the same time, so the two channels may not share a selector.
    expect(CSS).toMatch(/\.delta\s*\{[^}]*color:\s*var\(--graphite\)/);
    expect(CSS).toMatch(/\.delta--up\s*\{[^}]*color:\s*var\(--delta-up\)/);
    expect(CSS).toMatch(/\.delta--down\s*\{[^}]*color:\s*var\(--delta-down\)/);
    expect(CSS).not.toMatch(/data-tier[^{]*\.delta--?(up|down)?\s*\{/);
  });
});
