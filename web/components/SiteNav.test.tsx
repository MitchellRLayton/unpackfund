import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteNav } from "@/components/SiteNav";

/**
 * The nav says where you are two ways: `aria-current="page"`, which a screen reader
 * announces, and the styling keyed off that attribute. The attribute is the part a
 * test can hold; the pill is CSS (`globals.css`), and asserting it here would be
 * asserting a stylesheet from a DOM that never loads one.
 */
let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

function currentLabel(): string | null | undefined {
  return screen.queryByRole("link", { current: "page" })?.textContent;
}

// The suite runs with `globals: false`, so Testing Library's automatic cleanup is
// never registered: a file that renders more than once has to take it.
afterEach(cleanup);

describe("SiteNav", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("marks exactly one section, and it is the one you are on", () => {
    const { unmount } = render(<SiteNav />);
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(currentLabel()).toBe("Portfolio");

    // `/x/` is the X-Ray, and a trailing path under it is still the X-Ray.
    for (const [path, label] of [
      ["/x/", "X-Ray"],
      ["/x", "X-Ray"],
      // `/compare` starts with the same characters as `/c`: two lit labels would
      // say the visitor is in two places at once.
      ["/compare/", "Compare"],
      ["/c/", "Companies"],
      ["/c/NVDA/", "Companies"],
      ["/funds/", "Funds"],
      ["/f/VTI/", "Funds"],
    ] as const) {
      pathname = path;
      unmount();
      const next = render(<SiteNav />);
      expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
      expect(currentLabel()).toBe(label);
      next.unmount();
    }
  });

  it("leaves the root unmarked anywhere else, rather than guessing", () => {
    pathname = "/methodology/";
    render(<SiteNav />);
    // No section claims a page it does not own: the nav is not a breadcrumb.
    expect(screen.queryByRole("link", { current: "page" })).toBeNull();
  });
});
