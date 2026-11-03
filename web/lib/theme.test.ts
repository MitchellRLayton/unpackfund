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
 */

const CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function blockAfter(pattern: RegExp): string {
  const start = CSS.search(pattern);
  if (start < 0) throw new Error(`globals.css is missing ${pattern}`);
  const match = CSS.slice(start).match(/:root\s*\{([\s\S]*?)\}/);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error("globals.css has no :root block after " + pattern);
  }
  return body;
}

function tokens(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const [, name, value] = match;
    if (name && value) found[name] = value.toLowerCase();
  }
  return found;
}

const LIGHT = tokens(blockAfter(/:root\s*\{/));
const DARK = tokens(blockAfter(/@media\s*\(prefers-color-scheme:\s*dark\)/));

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
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

function linearChannels(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
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

/** Every pair that carries text. 4.5:1 is AA for normal-size text. */ const TEXT_PAIRS: Array<
  [fg: string, bg: string, why: string]
> = [
  ["fg", "bg", "body text"],
  ["fg", "surface", "text on a raised surface"],
  // The current section's pill is a darker step of `--surface` (operator's instruction,
  // 2026-11-02), so it needs its own pair: a future darkening must fail here rather than
  // in a reader's eyes.
  ["fg", "pill-bg", "the current section's label on its pill"],
  ["muted", "bg", "secondary text"],
  ["muted", "surface", "secondary text on a raised surface"],
  ["accent", "bg", "links and accent labels"],
  ["accent", "surface", "links in a table header"],
  ["accent", "accent-soft", "accent text in an accent notice"],
  ["warn", "warn-soft", "warning text in a warning notice"],
  ["fg", "warn-soft", "body text in a warning notice"],
  ["danger", "bg", "error text"],
  // The ledger gate's sentence: red while the portfolio is short or over, green once it
  // is exactly 100% (operator's instruction, 2026-11-02). Both inks on the page.
  ["ok", "bg", "the ledger gate once the portfolio is at 100%"],
  ["bg", "accent", "the primary button's label"],
  // A shaded row carries the same text as any other row, so both of its inks are
  // checked against the tint — in both schemes (2026-11-02).
  ["fg", "tint-direct", "body text on a row shaded for a direct position"],
  ["muted", "tint-direct", "secondary text on a shaded row"],
  ["fg", "tint-direct-hover", "body text on a shaded row under the pointer"],
  ["muted", "tint-direct-hover", "secondary text on a shaded row under the pointer"],
  // The bracketed difference in the `In VT` column, painted green above the benchmark and
  // red below it (operator's instruction, 2026-11-02). It is text, so it answers to 4.5:1
  // on every background a ledger row can have — the same four the edges are held to at 3:1.
  // The values are the searched neon pair, darkened in the light scheme until they clear
  // this floor and used as-is in the dark one, because `#39ff14` measures 1.36:1 on white.
  // `--muted` covers the exact match, already checked above against both tints.
  ["delta-up", "bg", "a bracket above the benchmark"],
  ["delta-up", "surface", "a bracket above the benchmark, hovered"],
  ["delta-up", "tint-direct", "a bracket above the benchmark on a direct row"],
  [
    "delta-up",
    "tint-direct-hover",
    "a bracket above the benchmark on a direct row under the pointer",
  ],
  ["delta-down", "bg", "a bracket below the benchmark"],
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
 * would have caught it (operator's instruction, 2026-11-02, "slightly more prominent blue
 * color differentiation"). A graphic that carries a distinction gets a gate, or the next
 * palette tweak quietly makes it invisible again.
 */
const UI_PAIRS: Array<[fg: string, bg: string, why: string]> = [
  ["country-us", "bg", "the US geography edge on a plain row"],
  ["country-us", "surface", "the US geography edge on a hovered row"],
  ["country-us", "tint-direct", "the US geography edge on a direct-position row"],
  [
    "country-us",
    "tint-direct-hover",
    "the US geography edge on a direct-position row under the pointer",
  ],
  // Split into two international inks on 2026-11-02 (developed ex-US against emerging), so
  // both are now held to the floor on every row background rather than one standing for
  // "everywhere else".
  ["country-dm", "bg", "the developed geography edge on a plain row"],
  ["country-dm", "surface", "the developed geography edge on a hovered row"],
  ["country-dm", "tint-direct", "the developed geography edge on a direct-position row"],
  [
    "country-dm",
    "tint-direct-hover",
    "the developed geography edge on a direct-position row under the pointer",
  ],
  ["country-em", "bg", "the emerging geography edge on a plain row"],
  ["country-em", "surface", "the emerging geography edge on a hovered row"],
  ["country-em", "tint-direct", "the emerging geography edge on a direct-position row"],
  [
    "country-em",
    "tint-direct-hover",
    "the emerging geography edge on a direct-position row under the pointer",
  ],
  // The neutral returned on 2026-11-02 for the two states that had no colour at all: a
  // domicile in neither list (solid) and a company the release could not place (dashed).
  // Both draw the same token, so one set of pairs covers both.
  ["country-other", "bg", "the neutral edge on a plain row"],
  ["country-other", "surface", "the neutral edge on a hovered row"],
  ["country-other", "tint-direct", "the neutral edge on a direct-position row"],
  [
    "country-other",
    "tint-direct-hover",
    "the neutral edge on a direct-position row under the pointer",
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

  it("redefines the same tokens in dark, so nothing is left on a light value", () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(10);
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
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
      // either ochre clears 40 with room (81.7 and 64.4 in the light scheme). The two
      // ochres cannot: both must clear the 3:1 non-text floor on every row background,
      // which confines them to roughly L* 18-54 and caps their separation at about dE 37.
      // Their floor is 30 — still two clearly different tones, measured at 34.2 and 33.2 —
      // because 40 is unreachable by construction, not because it was lowered for
      // convenience. The bracket's ink left this gate on 2026-11-02, when the operator
      // replaced the geography pair there with green and red; the reason it may leave is
      // written beside the list.
      const INK_PAIRS: Array<[string, string, number, string]> = [
        ["country-us", "country-dm", 40, "blue against the developed ochre"],
        ["country-us", "country-em", 40, "blue against the emerging ochre"],
        ["country-dm", "country-em", 30, "the two ochres against each other"],
        // The bracket's green against red is **not** listed, and that is a recorded
        // decision rather than an omission: green and red are the pair that collapses for a
        // deuteranope, so gating them at 25 dE would forbid the ink the operator asked for
        // and force a hue nobody wanted. The colour is allowed to carry the sign only
        // because it is never the carrier: `formatSignedShare` prints `+` or `-`, the
        // caption states green-for-more and red-for-less, and `LedgerTable`'s component
        // test holds that every coloured bracket also carries its sign. A pair that fails
        // this gate but is fully duplicated in text is not the defect the gate exists to
        // catch (`static-xray-frontend` §4a, §8).
        // The neutral has to read as "no tier" rather than as a washed-out tier, so it gets
        // an uncorrected floor of 28 — the tightest the three tier pairs allow it without
        // pretending a grey is a hue. Measured 30.2 / 29.5 / 31.1 in the light scheme and
        // 32.5 / 34.0 / 31.4 in the dark; the simulated floor stays at 25 for every pair.
        ["country-other", "country-us", 28, "the neutral against the blue tier"],
        ["country-other", "country-dm", 28, "the neutral against the developed ochre"],
        ["country-other", "country-em", 28, "the neutral against the emerging ochre"],
      ];
      const MIN_SIMULATED_SEPARATION = 25;
      const background = theme["bg"];
      if (!background) throw new Error("missing --bg");

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
    // `LedgerTable` writes `span.delta` plus `--up` or `--down` from the arithmetic sign;
    // these three rules are the whole mapping. A rename on either side would drop the
    // colour silently — the table would keep working and the operator would see a plain
    // number again — which is what this holds. The rules must key off the class, not off
    // `data-country`: geography owns the 6 px edge, and a row can be American and below the
    // benchmark at the same time, so the two channels may not share a selector.
    expect(CSS).toMatch(/\.delta\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(CSS).toMatch(/\.delta--up\s*\{[^}]*color:\s*var\(--delta-up\)/);
    expect(CSS).toMatch(/\.delta--down\s*\{[^}]*color:\s*var\(--delta-down\)/);
    expect(CSS).not.toMatch(/data-country[^{]*\.delta--?(up|down)?\s*\{/);
  });
});
