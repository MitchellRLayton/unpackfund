import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Catalogue, CompanyShard, Ledger, ReleaseDescriptor } from "@/lib/types";

import { CompanyDetail, type CompanyDetailProps } from "./CompanyDetail";
import type { CompanyRow } from "./company-rows";

/**
 * The company detail where a unit test cannot see it: the fragment it follows, the
 * sentence it prints when the URL carries a portfolio, and the two ways it closes.
 *
 * The release and workspace hooks are mocked at the module boundary; the lookup in
 * the ledger, the fund table's order and every string below are the real ones.
 * `dialog.showModal` and `dialog.close` are stubbed to record the calls, because
 * jsdom's dialog support is not what this test is about — the browser owns the
 * focus trap, and asserting on a re-implementation of it would prove nothing.
 */
const state = vi.hoisted(() => ({
  companyId: "c_0000320193" as string | null,
  ledger: null as unknown,
  openCompany: vi.fn(),
  shown: vi.fn(),
  closed: vi.fn(),
}));

const RELEASE = {
  as_of: "2026-11-03.1",
  generated_at: "2026-11-03T07:03:58Z",
  fund_count: 2,
  company_count: 12_895,
} as ReleaseDescriptor;

const SHARD: CompanyShard = {
  as_of: "2026-11-03.1",
  company_id: "c_0000320193",
  name: "APPLE INC.",
  ticker: "AAPL",
  country: "US",
  funds: [
    ["VTI", 550],
    ["FXAIX", 700],
  ],
};

const CATALOGUE: Catalogue = {
  as_of: "2026-11-03.1",
  funds: {
    VTI: ["Vanguard Total Stock Market ETF", "Vanguard", 1, 99.4, 400_000_000_000],
    FXAIX: ["Fidelity 500 Index Fund", "Fidelity", 0, 96.1],
  },
};

const ROWS: CompanyRow[] = [
  {
    id: "c_0000320193",
    name: "APPLE INC.",
    ticker: "AAPL",
    holders: 2,
    country: "US",
  },
];

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: RELEASE, error: null }),
  useCompany: () => ({ status: "ready", data: SHARD, error: null }),
  useCatalogue: () => ({ status: "ready", data: CATALOGUE, error: null }),
}));

function renderDetail(overrides: Partial<CompanyDetailProps> = {}) {
  return render(
    <CompanyDetail
      rows={ROWS}
      release={RELEASE}
      companyId={state.companyId}
      ledger={state.ledger as Ledger | null}
      countryOf={() => "US"}
      openCompany={state.openCompany}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  state.companyId = "c_0000320193";
  state.ledger = null;
  state.openCompany.mockClear();
  state.shown.mockClear();
  state.closed.mockClear();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    state.shown();
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    state.closed();
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(cleanup);

describe("CompanyDetail", () => {
  it("opens the dialog on the company the fragment names", () => {
    renderDetail();
    expect(state.shown).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("APPLE INC.");
    expect(dialog.textContent).toContain("AAPL");
    expect(dialog.textContent).toContain("c_0000320193");
  });

  it("lists the funds holding it, largest position first", () => {
    renderDetail();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]?.textContent).toContain("Fidelity 500 Index Fund");
    expect(rows[1]?.textContent).toContain("7.00%");
    expect(rows[2]?.textContent).toContain("Vanguard Total Stock Market ETF");
    expect(rows[2]?.textContent).toContain("5.50%");
    expect(table.querySelector('a[href="/f/FXAIX/"]')).toBeTruthy();
  });

  it("says nothing about a holding when the URL carries no portfolio", () => {
    renderDetail();
    expect(screen.getByRole("dialog").textContent).not.toContain("You hold");
  });

  it("prints the look-through holding when the ledger has one", () => {
    state.ledger = {
      rows: [
        {
          company_id: "c_0000320193",
          name: "APPLE INC.",
          weight: 0.0421,
          holder_count: 2,
        },
      ],
    } as unknown as Ledger;
    renderDetail();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("You hold");
    expect(dialog.textContent).toContain("4.21%");
    expect(dialog.textContent).toContain("through 2 funds");
  });

  it("closes the dialog and clears the fragment", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(state.closed).toHaveBeenCalledTimes(1);
    expect(state.openCompany).toHaveBeenCalledWith(null);
  });

  it("stays shut and empty when no company is open", () => {
    state.companyId = null;
    const { container } = renderDetail();
    expect(state.shown).not.toHaveBeenCalled();
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(false);
    expect(container.querySelector("dialog")?.textContent).toBe("");
  });

  it("ignores a fragment that is not a company id", () => {
    state.companyId = "not-a-company";
    const { container } = renderDetail();
    expect(state.shown).not.toHaveBeenCalled();
    expect(container.querySelector("dialog")?.textContent).toBe("");
  });
});
