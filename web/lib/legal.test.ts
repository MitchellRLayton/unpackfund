/** @vitest-environment node */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTACT_EMAIL } from "./legal";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every `.tsx` under `app/`, recursively. */
function appSources(dir = join(WEB_ROOT, "app")): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...appSources(path));
    else if (entry.endsWith(".tsx")) out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/**
 * The contact address is a privacy decision, so it is a test rather than a
 * convention: the operator's personal address was published on five pages, and
 * the fix is only durable if a literal cannot creep back into a page.
 */
describe("the published contact address", () => {
  it("is the site's own alias, not the operator's personal address", () => {
    expect(CONTACT_EMAIL).toBe("unfetteredaccess@duck.com");
    expect(CONTACT_EMAIL).not.toContain("proton.me");
  });

  it("is the only email address in the pages, read from the one constant", () => {
    const literal = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
    const offenders = appSources()
      .filter(({ text }) => literal.test(text))
      .map(({ path }) => path.slice(WEB_ROOT.length));
    expect(offenders).toEqual([]);
  });

  it("renders on the methodology page through the constant", () => {
    const page = readFileSync(join(WEB_ROOT, "app", "methodology", "page.tsx"), "utf8");
    expect(page).toContain("CONTACT_EMAIL");
    expect(page).not.toContain("proton.me");
  });
});
