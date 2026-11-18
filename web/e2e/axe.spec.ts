import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The accessibility gate (`docs/copy-audit/PROMPT.md` §8.2): axe-core on every state the
 * copy audit measures, failing on any violation that is not already in the baseline.
 *
 * "New" is the point. The baseline is the set of rule ids already present on a state when
 * the gate was introduced, so a pre-existing finding does not block an unrelated change,
 * and a change that adds one does. Record or refresh it deliberately:
 *
 *   E2E_BASE_URL=<url> E2E_UPDATE_BASELINE=1 pnpm --filter @unpackfund/web test:e2e
 *
 * and commit `e2e/axe-baseline.json` with the reason in the message. Never refresh it to
 * make a red run green without reading what the new findings are.
 */

/** FX-1 (example portfolio) and FX-4 (VTI vs VXUS), the brief's own fixtures (§8.4). */
const FX1 =
  "/#v3.WyJicCIsW1siZiIsIlFRUSIsMTQyOV0sWyJmIiwiVk9PIiwxNDI5XSxbImYiLCJTTUgiLDE0MjldLFsiZiIsIlZHVCIsMTQyOV0sWyJmIiwiUlNQVCIsMTQyOF0sWyJmIiwiQVJLSyIsMTQyOF0sWyJmIiwiQUxBSSIsMTQyOF1dXQ";
const FX4 = "/compare/#v2.eyJhIjpbWyJWVEkiLDEwMDAwXV0sImIiOltbIlZYVVMiLDEwMDAwXV19";

const STATES = [
  { id: "portfolio-example", url: FX1, ready: "main" },
  { id: "compare-filled", url: FX4, ready: "table" },
  { id: "compare-empty", url: "/compare/", ready: "main" },
  { id: "funds", url: "/funds/", ready: "table" },
  { id: "companies", url: "/c/", ready: "table" },
  { id: "company-dialog", url: "/c/#c_0001045810", ready: "dialog[open]" },
] as const;

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "axe-baseline.json",
);
const UPDATE = process.env.E2E_UPDATE_BASELINE === "1";
const baseline: Record<string, string[]> = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
  : {};
const recorded: Record<string, string[]> = {};

test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL is not set");

for (const state of STATES) {
  test(`axe: ${state.id}`, async ({ page }) => {
    await page.goto(state.url);
    await page
      .locator(state.ready)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    // The release is fetched after hydration; a quiet network is the honest "loaded".
    await page.waitForLoadState("networkidle");

    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const found = [...new Set(result.violations.map((violation) => violation.id))].sort();

    if (UPDATE) {
      recorded[state.id] = found;
      return;
    }
    const known = baseline[state.id] ?? [];
    const added = found.filter((id) => !known.includes(id));
    expect(added, `new axe violations on ${state.id}: ${added.join(", ")}`).toEqual([]);
  });
}

test.afterAll(() => {
  if (UPDATE) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  }
});
