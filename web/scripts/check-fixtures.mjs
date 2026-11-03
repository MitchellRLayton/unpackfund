/**
 * Print the five test portfolios' numbers, from the code in this worktree.
 *
 * The acceptance rule is that the redesign answers exactly as the current site
 * does. This script is how that is checked: run it on the branch that is live
 * today, run it here, and diff the two files. It bundles the real modules with
 * esbuild (the same tool `build-worker.mjs` uses) so the report comes from the
 * code under test rather than from a reimplementation.
 *
 *   node scripts/check-fixtures.mjs > /tmp/fixtures-new.txt
 *
 * It reads the live release from R2, so it needs network access and takes a few
 * seconds per portfolio.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, ".fixtures");
const outFile = resolve(outDir, "entry.mjs");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(here, "fixtures-entry.ts")],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
});

const { run } = await import(pathToFileURL(outFile).href);
const report = await run();
await writeFile(resolve(outDir, "report.txt"), report, "utf8");
process.stdout.write(report);
