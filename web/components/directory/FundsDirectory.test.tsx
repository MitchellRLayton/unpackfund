import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Catalogue, ReleaseDescriptor } from "@/lib/types";

import { FundsDirectory } from "./FundsDirectory";

/**
 * The fund directory where a unit test cannot see it: the table it renders, the
 * counts it announces, and the three filters and two orders wired to it.
 *
 * The release hooks are mocked at the module boundary, so everything below them is
 * real — `toRows`, `lib/directory`'s orders, the search ladder, the paging slice
 * and the formatting. There is no fixture number this test invents: the rows below
 * are in a catalogue, and the table is what `catalogue.json` maps to.
 */
const RELEASE = {
  as_of: "2026-11-03.1",
  generated_at: "2026-11-03T07:03:58Z",
  fund_count: 4,
  company_count: 12_895,
} as ReleaseDescriptor;

const CATALOGUE: Catalogue = {
  as_of: "2026-11-03.1",
  funds: {
    VTI: ["Vanguard Total Stock Market ETF", "Vanguard", 1, 99.4, 400_000_000_000],
    BND: ["Vanguard Total Bond Market ETF", "Vanguard", 1, 45.2, 120_000_000_000],
    AVUV: ["Avantis U.S. Small Cap Value ETF", "Avantis", 1, 99.9, 9_000_000_000],
    AOR: ["iShares Core Growth Allocation ETF", "iShares", 1, 66.1, 2_000_000_000],
  },
};

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: RELEASE, error: null }),
  useCatalogue: () => ({ status: "ready", data: CATALOGUE, error: null }),
}));

afterEach(cleanup);

describe("FundsDirectory", () => {
  it("names the table with its count and the release's own order", () => {
    render(<FundsDirectory />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Funds");
    const table = screen.getByRole("table", {
      name: /4 funds, ordered largest first by the fund's own filed N-PORT net assets/,
    });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
  });

  it("prints the ticker, the size and a coverage chip for each fund", () => {
    render(<FundsDirectory />);
    const table = screen.getByRole("table");
    const [, firstBodyRow] = within(table).getAllByRole("row");
    expect(firstBodyRow?.textContent).toContain("VTI");
    expect(firstBodyRow?.textContent).toContain("$400B");
    expect(firstBodyRow?.textContent).toContain("99.4% covered");
    expect(firstBodyRow?.querySelector('a[href="/f/VTI/"]')).toBeTruthy();
  });

  it("filters by ticker text and announces the matches", () => {
    render(<FundsDirectory />);
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "bnd" },
    });
    expect(screen.getByRole("table", { name: /1 fund/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: /closest match first/ })).toBeTruthy();
  });

  it("filters by issuer", () => {
    render(<FundsDirectory />);
    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "Vanguard" },
    });
    expect(screen.getByRole("table", { name: /2 funds/ })).toBeTruthy();
  });

  it("filters by coverage band, not by a coverage number", () => {
    render(<FundsDirectory />);
    fireEvent.change(screen.getByLabelText("Coverage"), {
      target: { value: "none" },
    });
    const table = screen.getByRole("table", { name: /1 fund/ });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table.textContent).toContain("BND");
  });

  it("re-sorts on a header click and reports the direction", () => {
    render(<FundsDirectory />);
    const size = screen.getByRole("button", { name: /Fund size/ });
    fireEvent.click(size);
    expect(size.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("VTI");
    fireEvent.click(size);
    expect(size.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("AOR");
  });

  it("says so when nothing matches, and clears back to the whole release", () => {
    render(<FundsDirectory />);
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("No fund matches")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("table", { name: /4 funds/ })).toBeTruthy();
  });
});
