#!/usr/bin/env node
/**
 * Copy budget: how much visible explanatory text is on each app surface, and every
 * block that breaks the 25-word rule.
 *
 * Written for the copy audit's iteration 0 (`docs/copy-audit/`). It is a measurement,
 * not a gate in `pnpm verify` — it drives a real browser against a real deployment, so
 * it cannot run in CI without a release to point at.
 *
 * What it does, per state and per viewport:
 *
 * 1. Loads the state's URL at 1440×900, then at 390×844.
 * 2. Opens everything that hides text: every `<details>`, every lens tab, every Compare
 *    result tab, the company dialog, the ⌘K palette.
 * 3. Collects visible text from the block elements the brief names.
 * 4. Counts words by splitting the trimmed `innerText` on whitespace, so a number is a
 *    word, exactly as the brief specifies.
 *
 * A block is skipped when it is not visible (display/visibility/opacity), inside
 * `.sr-only` or `.visually-hidden`, clipped to nothing, or inside `[data-copy-allow="long"]`.
 *
 * Reference surfaces (`/methodology/`, `/glossary/`, `/about/`) are collected but never
 * fail the run: they are being restructured, not cut. Iteration 0 identifies them by
 * state rather than by the `data-copy-allow` attribute the brief mentions, because
 * iteration 0 makes no code changes and adding the attribute is one.
 *
 * Usage:
 *   node scripts/copy-budget.mjs --iteration 0
 *   node scripts/copy-budget.mjs --iteration 1 --base https://unpackfund-nav-preview.mitchell-layton.workers.dev
 *   node scripts/copy-budget.mjs --iteration 0 --states docs/copy-audit/states.json --only S-05,S-19
 */

import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const WORD_LIMIT = 25;
const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "390", width: 390, height: 844 },
];

const BLOCK_SELECTORS = [
  "p",
  "li",
  "dd",
  "dt",
  "figcaption",
  "caption",
  "[role=status]",
  "h1",
  "h2",
  "h3",
  "h4",
  "label",
  "button",
  "summary",
  "a",
  "th",
];

function parseArgs(argv) {
  const args = { iteration: "0", base: null, states: null, only: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--iteration") { args.iteration = value; i += 1; }
    else if (key === "--base") { args.base = value; i += 1; }
    else if (key === "--states") { args.states = value; i += 1; }
    else if (key === "--only") { args.only = value.split(",").map((s) => s.trim()); i += 1; }
    else if (key === "--out") { args.out = value; i += 1; }
  }
  return args;
}

/** An absolute URL for a state, against whatever deployment we were pointed at. */
function resolveUrl(raw, base) {
  if (/^https?:\/\//.test(raw)) {
    return base ? raw.replace(/^https?:\/\/[^/]+/, base) : raw;
  }
  return `${base ?? ""}${raw}`;
}

/**
 * Everything the page can reveal, revealed. Best-effort: a missing control is not a
 * failure.
 *
 * `clickLensTabs` is false when the state already names its lens in the URL. Clicking
 * every tab there would leave all five lens states showing the last lens, so five
 * different states would report one number — which is what the first run did.
 */
async function revealAll(page, { clickLensTabs = true } = {}) {
  // Every disclosure on the page.
  for (const details of await page.locator("details:not([open])").all()) {
    await details.evaluate((el) => el.setAttribute("open", "")).catch(() => {});
  }
  // The Portfolio's own disclosures are `<details>` too; the same loop covers them.
  // Lens tabs: the strip, then each tab in order.
  const lensTabs = page.locator('#lens-strip [role="tab"]');
  const lensCount = clickLensTabs ? await lensTabs.count().catch(() => 0) : 0;
  for (let i = 0; i < lensCount; i += 1) {
    const tab = lensTabs.nth(i);
    if (await tab.isVisible().catch(() => false)) {
      await tab.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(120);
    }
  }
  // Compare's result tabs.
  const compareTabs = page.locator('.tabs [role="tab"]');
  const compareCount = await compareTabs.count().catch(() => 0);
  for (let i = 0; i < compareCount; i += 1) {
    const tab = compareTabs.nth(i);
    if (await tab.isVisible().catch(() => false)) {
      await tab.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(120);
    }
  }
}

/** Open the command palette, which holds its own copy. */
async function openPalette(page) {
  await page.keyboard.press("Meta+k").catch(() => {});
  await page.waitForTimeout(150);
  if (!(await page.locator('[role="dialog"]').first().isVisible().catch(() => false))) {
    await page.keyboard.press("Control+k").catch(() => {});
    await page.waitForTimeout(150);
  }
}

/** A stable-ish CSS path for a row of the CSV, so two runs can be diffed. */
const PATH_FN = `
  (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let name = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(name + "#" + node.id); break; }
      const cls = (node.className && typeof node.className === "string")
        ? node.className.trim().split(/\\s+/).filter(Boolean)[0]
        : null;
      if (cls) name += "." + cls;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) name += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(name);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
`;

async function collect(page) {
  return page.evaluate(
    ({ selectors, pathFn }) => {
      const toPath = eval(pathFn);
      const selector = selectors.join(",");
      const seen = new Set();
      const rows = [];

      const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

      const visible = (el) => {
        if (el.closest('[data-copy-allow="long"]')) return false;
        if (el.closest(".sr-only, .visually-hidden")) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (Number(cs.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 && rect.height <= 1) return false;
        return true;
      };

      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!visible(el)) continue;
        // A parent already counted carries the child's words; counting both would
        // double the budget. The brief names block elements, which nest (`li > p`).
        if (el.parentElement && el.parentElement.closest(selector)) {
          const parentText = el.parentElement.textContent || "";
          if (parentText.trim() === (el.textContent || "").trim()) continue;
        }
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        rows.push({
          tag: el.tagName.toLowerCase(),
          path: toPath(el),
          words: wordCount(text),
          text,
          captionVisible: el.tagName === "CAPTION",
        });
      }
      return rows;
    },
    { selectors: BLOCK_SELECTORS, pathFn: PATH_FN },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args.states ?? "docs/copy-audit/states.json";
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const base = args.base ?? spec.site;
  const outDir = args.out ?? "docs/copy-audit";
  fs.mkdirSync(outDir, { recursive: true });

  const states = args.only
    ? spec.states.filter((s) => args.only.includes(s.id))
    : spec.states;

  const browser = await chromium.launch();
  const rows = [];
  const failures = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      reduceMotion: "reduce",
    });
    for (const state of states) {
      const page = await context.newPage();
      const url = resolveUrl(state.url, base);
      try {
        // S-03 is the loading frame: capture it as soon as the shell paints.
        if (state.id === "S-03") {
          await page.goto(url, { waitUntil: "commit", timeout: 30000 });
          await page.waitForTimeout(250);
        } else {
          // `networkidle` never settles on the generated fund pages, which keep a
          // connection open; `domcontentloaded` plus a fixed settle is enough, because
          // the copy is in the initial HTML.
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(2200);
        }

        if (state.id === "S-09") {
          const dollars = page.getByRole("button", { name: "Dollars" });
          if (await dollars.count()) await dollars.first().click().catch(() => {});
          await page.waitForTimeout(600);
        }
        if (state.id === "S-18") await openPalette(page);
        await revealAll(page, { clickLensTabs: !state.lens });
        if (state.id === "S-18") await openPalette(page);

        for (const row of await collect(page)) {
          rows.push({ state: state.id, viewport: viewport.label, reference: state.reference, ...row });
        }
      } catch (error) {
        failures.push({ state: state.id, viewport: viewport.label, error: String(error).slice(0, 200) });
      } finally {
        await page.close().catch(() => {});
      }
    }
    await context.close();
  }
  await browser.close();

  // --- CSV -------------------------------------------------------------------
  const csvPath = path.join(outDir, `budget-${args.iteration}.csv`);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["state,viewport,selectorPath,words,text"];
  for (const r of rows) {
    lines.push([esc(r.state), esc(r.viewport), esc(r.path), r.words, esc(r.text)].join(","));
  }
  fs.writeFileSync(csvPath, lines.join("\n") + "\n");

  // --- totals ----------------------------------------------------------------
  const byState = new Map();
  for (const r of rows) {
    const key = `${r.state}`;
    const entry = byState.get(key) ?? { state: r.state, reference: r.reference, words: 0, blocks: 0, v: {} };
    entry.words += r.words;
    entry.blocks += 1;
    entry.v[r.viewport] = (entry.v[r.viewport] ?? 0) + r.words;
    byState.set(key, entry);
  }

  const over = rows
    .filter((r) => !r.reference && r.words > WORD_LIMIT)
    .sort((a, b) => b.words - a.words);
  const visibleCaptions = rows.filter((r) => r.captionVisible);

  const totalsPath = path.join(outDir, `budget-${args.iteration}-totals.md`);
  const out = [];
  out.push(`# Copy budget, iteration ${args.iteration}`);
  out.push("");
  out.push(`Base: ${base}`);
  out.push(`States: ${states.length} · viewports: ${VIEWPORTS.map((v) => v.label).join(", ")}`);
  out.push(`Blocks collected: ${rows.length} · failing the ${WORD_LIMIT}-word rule: ${over.length}`);
  out.push("");
  out.push("## Per state");
  out.push("");
  out.push("| state | route | 1440 words | 390 words | blocks | reference |");
  out.push("|---|---|---:|---:|---:|---|");
  for (const state of states) {
    const e = byState.get(state.id);
    if (!e) { out.push(`| ${state.id} | ${state.url.slice(0, 60)} | — | — | 0 | ${state.reference ? "yes" : ""} |`); continue; }
    out.push(`| ${state.id} | ${state.url.slice(0, 60)} | ${e.v["1440"] ?? 0} | ${e.v["390"] ?? 0} | ${e.blocks} | ${state.reference ? "yes" : ""} |`);
  }
  out.push("");
  out.push("## Blocks over the word limit (app surfaces only)");
  out.push("");
  if (over.length === 0) out.push("None.");
  else {
    out.push("| state | viewport | words | text |");
    out.push("|---|---|---:|---|");
    for (const r of over) out.push(`| ${r.state} | ${r.viewport} | ${r.words} | ${r.text.slice(0, 140).replace(/\|/g, "\\|")} |`);
  }
  out.push("");
  out.push("## Visible `<caption>` elements");
  out.push("");
  if (visibleCaptions.length === 0) out.push("None.");
  else {
    out.push("| state | viewport | text |");
    out.push("|---|---|---|");
    for (const r of visibleCaptions) out.push(`| ${r.state} | ${r.viewport} | ${r.text.slice(0, 120).replace(/\|/g, "\\|")} |`);
  }
  if (failures.length) {
    out.push("");
    out.push("## States that failed to load");
    out.push("");
    for (const f of failures) out.push(`- ${f.state} @ ${f.viewport}: ${f.error}`);
  }
  fs.writeFileSync(totalsPath, out.join("\n") + "\n");

  const verdict = over.length === 0 && visibleCaptions.length === 0 ? "PASS" : "FAIL";
  console.log(`${verdict}: ${rows.length} blocks, ${over.length} over ${WORD_LIMIT} words, ${visibleCaptions.length} visible captions`);
  console.log(`  ${csvPath}`);
  console.log(`  ${totalsPath}`);
  if (failures.length) console.log(`  ${failures.length} state(s) failed to load`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

await main();
