import { defineConfig } from "@playwright/test";

/**
 * Browser checks that jsdom cannot make: the accessibility gate (`e2e/axe.spec.ts`).
 *
 * They run against a deployed build, never a local server: the pages read the published
 * release over the network, so a local static server would only exercise empty shells.
 * Point `E2E_BASE_URL` at the preview Worker (or production) — there is deliberately no
 * default, so a run that forgot to say where fails loudly instead of testing nothing.
 *
 * The browser is Playwright's own Chromium, kept inside the workspace:
 * `PLAYWRIGHT_BROWSERS_PATH=<workspace>/.work/ms-playwright pnpm --filter @unpackfund/web
 * exec playwright install chromium`. The harness rule is that nothing is written outside
 * `Personal-AI-Sandbox`, and Playwright's default cache is `~/Library/Caches`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1440, height: 900 },
  },
});
