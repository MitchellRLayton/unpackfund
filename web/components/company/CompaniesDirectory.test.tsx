import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReleaseDescriptor } from "@/lib/types";

import { CompaniesDirectory } from "./CompaniesDirectory";
import type { CompanyRow } from "./company-rows";

/**
 * The directory where a unit test cannot see it: the table it renders, the count it
 * announces, the page it moves to, and the two orders it can be read in.
 *
 * Only the fields `CompaniesDirectory` reads are on the release fixture — the
 * component never sees the rest, and inventing 40 fields would be a fixture that
 * looks like a release and is not one.
 */
const RELEASE = {
  as_of: "2026-11-03.1",
  generated_at: "2026-11-03T07:03:58Z",
  fund_count: 9112,
  company_count: 60,
} as ReleaseDescriptor;

function rows(count: number): CompanyRow[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const id = `c_${String(n).padStart(10, "0")}`;
    return {
      id,
      name: `Company ${String(n).padStart(2, "0")}`,
      ticker: `C${String(n).padStart(2, "0")}`,
      holders: n,
      // Half the rows have no domicile, so the em dash path is exercised too.
      country: n % 2 === 0 ? "US" : null,
    };
  });
}

function renderDirectory(count = 60) {
  return render(
    <CompaniesDirectory
      rows={rows(count)}
      status="ready"
      error={null}
      release={RELEASE}
      onOpen={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("CompaniesDirectory", () => {
  it("names the table with its own count and order", () => {
    renderDirectory();
    const table = screen.getByRole("table", { name: /60 companies/ });
    expect(table).toBeTruthy();
    expect(screen.getByRole("table", { name: /ordered by company name/ })).toBe(table);
  });

  it("renders one page of rows rather than the whole index", () => {
    const { container } = renderDirectory();
    const table = screen.getByRole("table");
    // One header row plus the 50 rows on the first page.
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    expect(container.querySelectorAll("tr[data-country-missing]")).toHaveLength(25);
  });

  it("starts on the first company alphabetically", () => {
    renderDirectory();
    const table = screen.getByRole("table");
    const [, firstBodyRow] = within(table).getAllByRole("row");
    expect(firstBodyRow?.textContent).toContain("Company 01");
  });

  it("moves to the last page with the counts announced", () => {
    renderDirectory();
    expect(screen.getByRole("status").textContent).toContain(
      "Showing rows 1–50 of 60 · page 1 of 2",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Showing rows 51–60 of 60 · page 2 of 2",
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(11);
  });

  it("filters on the name and says it is showing closest matches", () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "company 5" },
    });
    // 05, 15, 25, 35, 45 and 50–59: every name that carries a "5".
    expect(screen.getByRole("table", { name: /15 companies/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: /closest match first/ })).toBeTruthy();
  });

  it("re-sorts on a header click and reports the direction", () => {
    renderDirectory();
    const table = screen.getByRole("table");
    const holders = screen.getByRole("button", { name: /Held by/ });
    fireEvent.click(holders);
    const header = holders.closest("th");
    expect(header?.getAttribute("aria-sort")).toBe("descending");
    const [firstBodyRow] = within(table).getAllByRole("row").slice(1);
    // The most widely held company first.
    expect(firstBodyRow?.textContent).toContain("Company 60");
  });

  it("offers a way back when nothing matches", () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("No company matches")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("table", { name: /60 companies/ })).toBeTruthy();
  });

  it("opens a company through the fragment rather than a bare jump", () => {
    const onOpen = vi.fn();
    render(
      <CompaniesDirectory
        rows={rows(3)}
        status="ready"
        error={null}
        release={RELEASE}
        onOpen={onOpen}
      />,
    );
    const link = screen.getByRole("link", { name: "Company 02" });
    fireEvent.click(link);
    // The default jump would replace the fragment and lose the portfolio in it.
    expect(onOpen).toHaveBeenCalledWith("c_0000000002");
    expect(link.getAttribute("href")).toBe("/c/#c_0000000002");
  });

  it("says it is reading the index while it loads", () => {
    render(
      <CompaniesDirectory
        rows={[]}
        status="loading"
        error={null}
        release={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Reading the company index");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
