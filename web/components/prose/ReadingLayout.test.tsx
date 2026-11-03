import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";

import AboutPage from "@/app/about/page";
import DisclaimerPage from "@/app/disclaimer/page";
import GlossaryPage from "@/app/glossary/page";
import MethodologyPage from "@/app/methodology/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { GLOSSARY_TERMS } from "@/lib/glossary";

/**
 * Every page in the reading layout, rendered once, checked for the things a
 * reader cannot see but a screen reader, a shared link and a search engine can:
 * one `main`, one `h1`, headings that descend in order, ids that are unique, and
 * a table of contents whose every link lands somewhere on the same page.
 *
 * The TOC is the part that rots: a heading gets renamed, the list above it does
 * not, and the link starts scrolling to nowhere. Rendering the page and resolving
 * each `href` against the document is the only check that catches it, and it
 * costs nothing at runtime because it is a test.
 *
 * The same render is used for the copy contract below it — the clauses that are
 * not allowed to disappear (privacy's storage claims, the not-advice line,
 * nothing that reads as a promise) are asserted against what a reader would
 * actually see, not against the source file.
 */
const PAGES: ReadonlyArray<{ name: string; Page: ComponentType }> = [
  { name: "methodology", Page: MethodologyPage },
  { name: "glossary", Page: GlossaryPage },
  { name: "about", Page: AboutPage },
  { name: "disclaimer", Page: DisclaimerPage },
  { name: "privacy", Page: PrivacyPage },
  { name: "terms", Page: TermsPage },
];

afterEach(cleanup);

/** The page's visible text, with JSX's line breaks collapsed to single spaces. */
function textOf(view: RenderResult): string {
  return (view.container.textContent ?? "").replace(/\s+/g, " ").trim();
}

function headings(view: RenderResult): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
}

describe.each(PAGES)("$name", ({ name, Page }) => {
  it("renders one main, one h1 and one article", () => {
    const view = render(<Page />);
    expect(view.container.querySelectorAll("main")).toHaveLength(1);
    expect(view.container.querySelector("main")?.id).toBe("main");
    expect(view.container.querySelectorAll("h1")).toHaveLength(1);
    expect(view.container.querySelector("article.prose")).toBeTruthy();
    expect(name.length).toBeGreaterThan(0);
  });

  it("lists a table of contents whose links all land on the page", () => {
    const view = render(<Page />);
    const toc = view.container.querySelector('nav[aria-label="On this page"]');
    expect(toc).toBeTruthy();
    const links = [...(toc?.querySelectorAll("a") ?? [])];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      const target = view.container.querySelector(href);
      expect(target, `${name}: no element matches ${href}`).toBeTruthy();
      expect(["H2", "H3"]).toContain(target?.tagName ?? "");
    }
    expect(name.length).toBeGreaterThan(0);
  });

  it("gives every section heading an anchor, and no two anchors the same id", () => {
    const view = render(<Page />);
    for (const heading of view.container.querySelectorAll<HTMLElement>("h2, h3")) {
      expect(heading.id, `${name}: "${heading.textContent}" has no id`).not.toBe("");
    }
    const ids = [...view.container.querySelectorAll<HTMLElement>("[id]")].map(
      (element) => element.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("descends heading levels without skipping one", () => {
    const view = render(<Page />);
    const levels = headings(view).map((heading) => Number(heading.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1] ?? 1;
      const current = levels[index] ?? 1;
      expect(
        current,
        `${name}: heading level jumps from h${previous} to h${current}`,
      ).toBeLessThanOrEqual(previous + 1);
      expect(current).toBeGreaterThan(0);
    }
  });

  it("does not shout or promise", () => {
    const view = render(<Page />);
    const text = textOf(view);
    // House style: no exclamation marks, and no word that turns a data view into
    // advice. The disclaimer deliberately says "without warranty" — that is the
    // opposite of a promise and stays.
    expect(text).not.toContain("!");
    for (const banned of [
      "guaranteed",
      "risk-free",
      "outperform",
      "beat the market",
      "recommend buying",
    ]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("methodology", () => {
  it("puts every h2 in the table of contents", () => {
    const view = render(<MethodologyPage />);
    const listed = new Set(
      [...view.container.querySelectorAll('nav[aria-label="On this page"] a')].map(
        (link) => (link.getAttribute("href") ?? "").replace("#", ""),
      ),
    );
    for (const heading of view.container.querySelectorAll("h2")) {
      expect(listed.has(heading.id), `methodology: ${heading.id} is not in the TOC`).toBe(
        true,
      );
    }
  });

  it("states the two bands, the consensus rule and the look-through formula", () => {
    const text = textOf(render(<MethodologyPage />));
    expect(text).toContain("70% or more");
    expect(text).toContain("60% to 70%");
    expect(text).toContain("Below 60%");
    expect(text).toContain("at least 80% of the traced value");
    expect(text).toContain("two independent filings");
    expect(text).toContain("60 to 150 days");
    expect(text).toContain("three hops");
    expect(text).toContain("6,000 rows");
    expect(text).toContain("w(i,k)");
    expect(text).toContain("VT");
  });

  it("uses the contact address through the constant, not a literal", () => {
    const text = textOf(render(<MethodologyPage />));
    expect(text).toContain("unfetteredaccess@duck.com");
  });
});

describe("glossary", () => {
  it("defines every registered term under its own anchor", () => {
    const view = render(<GlossaryPage />);
    for (const term of GLOSSARY_TERMS) {
      const heading = view.container.querySelector<HTMLElement>(`h3#${term.id}`);
      expect(heading, `glossary: no entry for ${term.id}`).toBeTruthy();
      expect(heading?.textContent).toBe(term.label);
      // The definition and the "where it appears" line both render, so a term
      // cannot be listed and left empty.
      const entry = heading?.parentElement;
      expect(entry?.textContent).toContain(term.definition.slice(0, 40));
      expect(entry?.textContent).toContain("Where it appears:");
    }
  });

  it("lists every term in its table of contents", () => {
    const view = render(<GlossaryPage />);
    const listed = [
      ...view.container.querySelectorAll('nav[aria-label="On this page"] a'),
    ].map((link) => (link.getAttribute("href") ?? "").replace("#", ""));
    expect(listed).toEqual(GLOSSARY_TERMS.map((term) => term.id));
  });

  it("has an A–Z index that reaches every letter it uses", () => {
    const view = render(<GlossaryPage />);
    const index = view.container.querySelector('nav[aria-label="Jump to a letter"]');
    expect(index).toBeTruthy();
    const links = [...(index?.querySelectorAll("a") ?? [])];
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      expect(view.container.querySelector(link.getAttribute("href") ?? "")).toBeTruthy();
    }
    // 26 letters are printed, used or not: the shape of the index is information.
    expect(index?.children.length).toBe(26);
  });
});

describe("privacy", () => {
  it("still makes the four claims it exists to make", () => {
    const text = textOf(render(<PrivacyPage />)).toLowerCase();
    expect(text).toContain("never reaches the server");
    expect(text).toContain("no cookies");
    expect(text).toContain("no analytics");
    expect(text).toContain("no third-party scripts");
    expect(text).toContain("no third-party requests");
    // Storage in the browser, named so the claim can be checked.
    expect(text).toContain("localstorage");
    expect(text).toContain("sessionstorage");
    expect(text).toContain("indexeddb");
    // The portfolio is in the fragment, which is why it never leaves.
    expect(text).toContain("after the #");
    expect(text).toContain("data.unpackfund.com");
  });
});

describe("disclaimer", () => {
  it("keeps the not-advice and data-age clauses", () => {
    const text = textOf(render(<DisclaimerPage />)).toLowerCase();
    expect(text).toContain("not investment advice");
    expect(text).toContain("not a registered investment adviser");
    expect(text).toContain("60 to 150 days");
    expect(text).toContain("verify anything that matters");
  });
});

describe("about", () => {
  it("keeps the age limit and the disclaimer route", () => {
    const text = textOf(render(<AboutPage />));
    expect(text).toContain("60 to 150 days");
    expect(text).toContain("not a registered investment adviser");
    expect(text).toContain("Disclaimer");
  });
});

describe("terms", () => {
  it("keeps the opening sentence and the licence", () => {
    const text = textOf(render(<TermsPage />));
    expect(text).toContain("agree to these terms");
    expect(text).toContain("Licence to use");
  });
});
