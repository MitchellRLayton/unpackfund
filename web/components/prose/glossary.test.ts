/** @vitest-environment node */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GLOSSARY_ALPHABET,
  GLOSSARY_LETTERS,
  GLOSSARY_TERMS,
  glossaryHref,
  glossaryTerm,
} from "@/lib/glossary";

const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every `.tsx` under `app/` or `components/`, recursively. */
function sources(dirs: readonly string[]): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".tsx"))
        out.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  for (const dir of dirs) walk(join(WEB_ROOT, dir));
  return out;
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

describe("the glossary registry", () => {
  it("gives every term a unique, stable, kebab-case anchor", () => {
    const ids = GLOSSARY_TERMS.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // An anchor is a URL fragment that a shared link carries, so it has to look
      // like one and must never be renamed once published.
      expect(id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it("says something worth opening on every term", () => {
    for (const term of GLOSSARY_TERMS) {
      expect(term.label.length).toBeGreaterThan(1);
      expect(term.label.length).toBeLessThanOrEqual(40);
      // The popover is one or two sentences: long enough to define the word,
      // short enough to read without scrolling a floating box.
      expect(term.short.length).toBeGreaterThan(50);
      expect(term.short.length).toBeLessThanOrEqual(400);
      // The entry is a paragraph. A one-line entry is a tooltip with a heading;
      // four hundred words is a methodology page, and that page already exists.
      expect(term.definition.length).toBeGreaterThan(120);
      expect(term.definition.length).toBeLessThanOrEqual(1_200);
      expect(term.definition).not.toContain("\n");
      expect(term.appears.length).toBeGreaterThan(10);
      // The short version cannot be the whole definition cut in half: it is the
      // sentence a reader gets first, so it must not open a claim the entry does
      // not finish.
      expect(term.definition.length).toBeGreaterThan(term.short.length);
    }
  });

  it("is alphabetical by label, so the file decides the order and not a sort", () => {
    for (let index = 1; index < GLOSSARY_TERMS.length; index += 1) {
      const previous = GLOSSARY_TERMS[index - 1];
      const current = GLOSSARY_TERMS[index];
      expect(previous && current).toBeTruthy();
      if (!previous || !current) continue;
      expect(
        collator.compare(previous.label, current.label),
        `${current.label} should sort after ${previous.label}`,
      ).toBeLessThan(0);
    }
  });

  it("groups the terms into letters without losing one", () => {
    const flattened = GLOSSARY_LETTERS.flatMap((group) => [...group.terms]);
    expect(flattened.map((term) => term.id)).toEqual(
      GLOSSARY_TERMS.map((term) => term.id),
    );
    for (const group of GLOSSARY_LETTERS) {
      expect(group.id).toBe(glossaryLetterHrefId(group.letter));
      expect(group.terms.length).toBeGreaterThan(0);
      for (const term of group.terms) {
        expect(term.label.slice(0, 1).toUpperCase()).toBe(group.letter);
      }
    }
    const letters = GLOSSARY_LETTERS.map((group) => group.letter);
    expect(letters).toEqual([...letters].sort());
  });

  it("keeps an A–Z alphabet for the index, even for letters with no terms", () => {
    expect(GLOSSARY_ALPHABET).toHaveLength(26);
    expect(GLOSSARY_ALPHABET[0]).toBe("A");
    expect(GLOSSARY_ALPHABET[25]).toBe("Z");
    const used = new Set(GLOSSARY_LETTERS.map((group) => group.letter));
    for (const letter of used) expect(GLOSSARY_ALPHABET).toContain(letter);
    // A letter with terms is never missing from the index; that is the only way
    // this assertion can be useful, so it is also asserted the other way.
    expect(used.size).toBeGreaterThan(5);
    expect(used.size).toBeLessThanOrEqual(GLOSSARY_ALPHABET.length);
  });

  it("spells a link one way", () => {
    expect(glossaryHref("coverage")).toBe("/glossary/#coverage");
    expect(GLOSSARY_LETTERS.find((group) => group.letter === "C")?.id).toBe("letter-c");
    expect(glossaryTerm("coverage")?.label).toBe("Coverage");
    expect(glossaryTerm("not-a-term")).toBeUndefined();
  });

  it("resolves every <Term name> the site renders", () => {
    const usages = sources(["app", "components"]).flatMap(({ path, text }) => {
      const found: Array<{ path: string; name: string }> = [];
      for (const match of text.matchAll(/<Term\b[^>]*?\bname="([^"]+)"/g)) {
        const name = match[1];
        if (name) found.push({ path: path.slice(WEB_ROOT.length), name });
      }
      return found;
    });
    // A vacuous scan passes forever, so the count is part of the assertion: the
    // prose pages use the component, and a regex that stopped matching would be
    // caught here rather than by nobody noticing the popovers had gone.
    expect(usages.length).toBeGreaterThanOrEqual(20);
    const unknown = usages.filter(({ name }) => glossaryTerm(name) === undefined);
    expect(unknown).toEqual([]);
  });
});

/** `letter-c` without going through the href, so a typo in either fails. */
function glossaryLetterHrefId(letter: string): string {
  return `letter-${letter.toLowerCase()}`;
}
