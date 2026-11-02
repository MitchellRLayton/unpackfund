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

/** Every pair that carries text. 4.5:1 is AA for normal-size text. */
const TEXT_PAIRS: Array<[fg: string, bg: string, why: string]> = [
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
  ["bg", "accent", "the primary button's label"],
  // A shaded row carries the same text as any other row, so both of its inks are
  // checked against the tint — in both schemes (2026-11-02).
  ["fg", "tint-direct", "body text on a row shaded for a direct position"],
  ["muted", "tint-direct", "secondary text on a shaded row"],
  ["fg", "tint-direct-hover", "body text on a shaded row under the pointer"],
  ["muted", "tint-direct-hover", "secondary text on a shaded row under the pointer"],
];

function pairs(theme: Record<string, string>): Array<[string, string, string]> {
  return TEXT_PAIRS.map(([fg, bg, why]) => {
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
  }
});
