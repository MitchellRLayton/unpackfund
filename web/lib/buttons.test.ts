import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The button contract, as a gate (operator's principles, 2026-11-18; `web/DESIGN.md` →
 * "Buttons and controls").
 *
 * "Color carries meaning only: the market tiers own the hues, and everything else is ink,
 * paper or grey." A button is not a market, an error or a chart, so every colour a
 * button-like rule paints comes from the neutral tokens, and nothing in it is a literal.
 * This reads the stylesheets themselves, so a new control that borrows `--accent` (which
 * is the US tier's blue) or a hex value fails here rather than in a review.
 */

// vitest runs from `web/`, the same folder `pnpm verify` runs it in.
const ROOT = `${process.cwd()}/`;

function files(dir: string, suffix: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "out") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, suffix, out);
    else if (name.endsWith(suffix)) out.push(path);
  }
  return out;
}

const SOURCE = [
  ...files(join(ROOT, "app"), ".css"),
  ...files(join(ROOT, "components"), ".css"),
];

/** The selectors that are a control: the `.btn` family and every hand-rolled button. */
const CONTROL =
  /btn|button|trigger|choiceoption|inlinelink|__close|__menu|__sort|handle|collapsecontrol|modebtn/i;

/** Tokens that carry a meaning of their own; a control may not wear them. */
const MEANING_TOKENS =
  /--(accent|tier-|band-|whole|delta-|warn|ok\b|danger|alert|tint-|country-)/;

/** A colour written out instead of named. `color-mix(in oklch, …)` is a method, not a value. */
function literalColour(value: string): string | null {
  const stripped = value.replace(/color-mix\(\s*in\s+\w+\s*,/g, "color-mix(");
  const match = stripped.match(
    /#[0-9a-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|lab|lch)\(|\b(?:white|black|red|green|blue)\b/i,
  );
  return match ? match[0] : null;
}

const PAINT =
  /^(color|background(-color)?|border(-[a-z]+)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-decoration-color)$/;

interface Rule {
  file: string;
  selector: string;
  declarations: [string, string][];
}

function rules(): Rule[] {
  const found: Rule[] = [];
  for (const file of SOURCE) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? "").trim();
      if (selector.startsWith("@") || selector.length === 0) continue;
      const declarations = (match[2] ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part): [string, string] => {
          const at = part.indexOf(":");
          return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        });
      found.push({ file: file.slice(ROOT.length), selector, declarations });
    }
  }
  return found;
}

const CONTROL_RULES = rules().filter((rule) => CONTROL.test(rule.selector));

describe("button contract: the stylesheets", () => {
  it("finds the controls it is meant to police", () => {
    // A selector pattern that matched nothing would pass forever; these are the anchors.
    const selectors = CONTROL_RULES.map((rule) => rule.selector).join("\n");
    for (const anchor of [
      ".btn",
      ".btn--primary",
      ".modeBtn",
      ".choiceOption",
      ".exportButton",
    ]) {
      expect(selectors, anchor).toContain(anchor);
    }
  });

  it("paints every control from the neutral tokens: ink, paper, surface, graphite, rule, wash", () => {
    const offences: string[] = [];
    for (const rule of CONTROL_RULES) {
      for (const [property, value] of rule.declarations) {
        if (!PAINT.test(property)) continue;
        if (MEANING_TOKENS.test(value)) {
          offences.push(
            `${rule.file}: ${rule.selector} { ${property}: ${value} } uses a meaning token`,
          );
        }
        const literal = literalColour(value);
        if (literal) {
          offences.push(
            `${rule.file}: ${rule.selector} { ${property}: ${value} } writes ${literal} out`,
          );
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("sets control type from the scale, never a size of its own", () => {
    const offences: string[] = [];
    for (const rule of CONTROL_RULES) {
      for (const [property, value] of rule.declarations) {
        if (property !== "font-size") continue;
        if (/^var\(--text-(12|14|16|20|28|40)\)$/.test(value) || value === "inherit")
          continue;
        // The "i" glyph inside the 17 px info circle is an icon, not a label.
        if (rule.file.endsWith("InfoTip.module.css")) continue;
        offences.push(`${rule.file}: ${rule.selector} { font-size: ${value} }`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("button contract: the markup", () => {
  it("never glues a variant onto the previous class", () => {
    // `btn btn--sm${on ? "btn--primary" : ""}` renders `btn--smbtn--primary`: the selected
    // state of the Markets provider switch was invisible for exactly this reason.
    const offences: string[] = [];
    for (const file of [
      ...files(join(ROOT, "app"), ".tsx"),
      ...files(join(ROOT, "components"), ".tsx"),
    ]) {
      if (/\.test\.tsx$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/btn(?:--[a-z]+)?\$\{[^}]*"btn--/g)) {
        offences.push(`${file.slice(ROOT.length)}: ${match[0]}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
