import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LegalFooter } from "@/components/LegalFooter";

afterEach(cleanup);

/**
 * Launch rule 7 (`compliance-licensing-guard` §6): the footer must carry four
 * clauses on every page, and a route to the long form. This test is the check,
 * not a promise that the check exists.
 */
describe("LegalFooter", () => {
  it("carries the four mandatory clauses", () => {
    render(<LegalFooter />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("not investment advice");
    expect(text).toContain("not a registered investment adviser");
    expect(text).toContain("60 to 150 days");
    expect(text).toContain("Verify anything that matters");
  });

  it("attributes the source and disclaims endorsement", () => {
    render(<LegalFooter />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("SEC EDGAR");
    expect(text).toContain("No SEC seal or logo");
    expect(text).toContain("not affiliated with any fund issuer");
  });

  it("links to every legal page", () => {
    render(<LegalFooter />);
    for (const href of ["/about", "/methodology", "/disclaimer", "/privacy", "/terms"]) {
      const link = screen.getByRole("link", { name: new RegExp(href.slice(1), "i") });
      expect(link.getAttribute("href")).toBe(href);
    }
  });
});
