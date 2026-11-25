import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import contract from "./nav-contract.json";

/**
 * The nav is rendered twice — by this component for the twelve Next routes, and by
 * `pipeline/pipeline/fund_pages.py` for the 9,016 generated fund pages, which ship no
 * React. Both read `web/nav.json`, and both are compared against the same committed
 * contract (`nav-contract.json`): this test extracts the structure from the React
 * output, and `pipeline/tests/test_fund_pages.py` extracts it from a generated page.
 *
 * That is the drift gate. The previous header was two hand-maintained copies and they
 * had already diverged — the React one marked "How it works" current on `/about/`,
 * the generated one hardcoded Funds — and nothing failed.
 */

let pathname = "/funds/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
// The palette fetches a catalogue on open; the nav does not depend on it.
vi.mock("./SearchPalette", () => ({ SearchPalette: () => null }));

const { Sidebar } = await import("./Sidebar");
const { AppShell } = await import("./AppShell");

interface NavItemShape {
  label: string;
  href: string | null;
  current: boolean;
  icon: boolean;
}

/**
 * jsdom renders `next/link` without the router's `trailingSlash` setting, so a
 * `href="/compare/"` comes back as `/compare`. The built export has the slash (checked
 * in `web/out/index.html`), and the Python test holds the fund page to the contract's
 * exact form. This test is about which path an entry points at, so both sides are
 * compared without the slash.
 */
function normalizeHref(href: string | null): string | null {
  return href && href.length > 1 && href.endsWith("/") ? href.slice(0, -1) : href;
}

function extract(
  container: HTMLElement,
): { group: string; items: NavItemShape[] }[] | null {
  const nav = container.querySelector('nav[aria-label="Sections"]');
  if (!nav) return null;
  return [...nav.querySelectorAll(".app-nav__group")].map((group) => ({
    group: group.querySelector(".app-nav__label")?.textContent?.trim() ?? "",
    items: [...group.querySelectorAll("a.app-nav__link")].map((link) => ({
      label: link.querySelector(".app-nav__text")?.textContent?.trim() ?? "",
      href: normalizeHref(link.getAttribute("href")),
      current: link.getAttribute("aria-current") === "page",
      icon: link.querySelector("svg") !== null,
    })),
  }));
}

function currentLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-current="page"]')].map(
    (element) => element.textContent?.trim() ?? "",
  );
}

afterEach(cleanup);

describe("the sidebar nav", () => {
  it("matches the contract the fund-page renderer is held to", () => {
    pathname = "/funds/";
    const { container } = render(<Sidebar />);
    const expected = contract.nav.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, href: normalizeHref(item.href) })),
    }));
    expect(extract(container)).toEqual(expected);
  });

  it("marks exactly one entry current, and the right one", () => {
    const cases: [string, string][] = [
      ["/", "Portfolio"],
      ["/x/", "Portfolio"],
      ["/compare/", "Compare"],
      ["/c/", "Companies"],
      ["/funds/", "Funds"],
      ["/f/VTI/", "Funds"],
      ["/methodology/", "How it works"],
      ["/glossary/", "Glossary"],
      ["/about/", "About"],
      ["/privacy/", "Privacy"],
    ];
    for (const [path, expected] of cases) {
      pathname = path;
      const { container, unmount } = render(<Sidebar />);
      expect(currentLabels(container), path).toEqual([expected]);
      unmount();
    }
  });

  it("marks nothing current on a page outside the nav", () => {
    pathname = "/design/";
    const { container } = render(<Sidebar />);
    expect(currentLabels(container)).toEqual([]);
  });

  it("gives every nav a distinct accessible name", () => {
    pathname = "/";
    const { container } = render(<Sidebar />);
    const labels = [...container.querySelectorAll("nav")].map((nav) =>
      nav.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Sections", "About and legal"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is a popover, so the drawer needs no JavaScript", () => {
    pathname = "/";
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside.app-sidebar");
    expect(aside?.getAttribute("popover")).toBe("auto");
    expect(aside?.getAttribute("id")).toBe("app-nav");
  });

  it("folds to the rail and back on the visitor's click, and remembers it", () => {
    window.localStorage.clear();
    const first = render(<AppShell>page</AppShell>);
    const shell = first.container.querySelector(".app-shell") as HTMLElement;
    const fold = first.getByRole("button", { name: "Collapse sidebar" });
    expect(shell.dataset.nav).toBeUndefined();
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fold);
    expect(shell.dataset.nav).toBe("collapsed");
    const expand = first.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // A folded rail still names every link, because the text is hidden from everyone.
    for (const link of first.container.querySelectorAll(".app-nav__link")) {
      expect(link.getAttribute("aria-label")).toBeTruthy();
    }
    first.unmount();

    // A new page in the same browser opens folded.
    const second = render(<AppShell>page</AppShell>);
    const again = second.container.querySelector(".app-shell") as HTMLElement;
    expect(again.dataset.nav).toBe("collapsed");
    fireEvent.click(second.getByRole("button", { name: "Expand sidebar" }));
    expect(again.dataset.nav).toBeUndefined();
    expect(window.localStorage.getItem("unpackfund:nav")).toBe("expanded");
  });
});
