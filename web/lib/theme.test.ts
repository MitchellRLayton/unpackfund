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
  // The bracketed difference in the `In VT` column, painted in the row's geography ink
  // (operator's instruction, 2026-11-02). It is text, so it answers to 4.5:1 on every
  // background a ledger row can have — the same four the edges are held to at 3:1. This
  // is why the text inks are a step darker than the stripes; the stripe tokens
  // (`country-us`, `country-dm`, `country-em`) would fail here on the tinted rows and are
  // deliberately not listed. The ink stays a two-group channel — American or not — even
  // though the edge now has three tiers: the comment at the token says why.
  ["country-us-ink", "bg", "the bracket on a US company's row"],
  ["country-us-ink", "surface", "the bracket on a US company's row, hovered"],
  ["country-us-ink", "tint-direct", "the bracket on a US company held directly"],
  [
    "country-us-ink",
    "tint-direct-hover",
    "the bracket on a US direct row under the pointer",
  ],
  ["country-intl-ink", "bg", "the bracket on an international company's row"],
  [
    "country-intl-ink",
    "surface",
    "the bracket on an international company's row, hovered",
  ],
  ["country-intl-ink", "tint-direct", "the bracket on an international direct row"],
  [
    "country-intl-ink",
    "tint-direct-hover",
    "the bracket on an international direct row under the pointer",
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
      // convenience. The bracket's text ink is a two-group channel (American or not; see
      // the token comment for why it did not gain a third ink), so it contributes one pair
      // at the same 40 as the blue-versus-ochre edges.
      const INK_PAIRS: Array<[string, string, number, string]> = [
        ["country-us", "country-dm", 40, "blue against the developed ochre"],
        ["country-us", "country-em", 40, "blue against the emerging ochre"],
        ["country-dm", "country-em", 30, "the two ochres against each other"],
        ["country-us-ink", "country-intl-ink", 40, "the two bracket inks"],
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

  it("paints the bracket from the row's geography attribute, not from a second class", () => {
    // `LedgerTable` writes `span.delta` and the row's `data-country`; these three rules do
    // the mapping, so the ink and the 6 px edge cannot disagree about what a row is. A
    // rename on either side would drop the colour silently — the table would keep working
    // and the operator would see a plain number again — which is what this holds.
    expect(CSS).toMatch(/\.delta\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(CSS).toMatch(
      /tr\[data-country="US"\]\s+\.delta\s*\{[^}]*color:\s*var\(--country-us-ink\)/,
    );
    expect(CSS).toMatch(
      /tr\[data-country\]:not\(\[data-country="US"\]\)\s+\.delta\s*\{[^}]*color:\s*var\(--country-intl-ink\)/,
    );
  });
});
