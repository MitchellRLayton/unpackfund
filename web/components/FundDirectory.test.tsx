import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FundDirectory } from "@/components/FundDirectory";

/**
 * What `/funds` opens on is a product decision, so it is pinned here rather than
 * inferred from the sort unit tests: the 50 largest funds by filed net assets when
 * the release carries them, a search box that still reaches a fund outside those 50,
 * and today's editorial order plus a visible reason when the release carries no
 * figure at all (the live `2026-11-02.7`).
 *
 * The release hook is mocked at the module boundary, the way `PortfolioBuilder.test`
 * mocks it, so everything under test is the real component stack: the real `toRows`,
 * `sortRows`, search and paging.
 */

const { state } = vi.hoisted(() => ({
  state: {
    release: { status: "loading", data: null, error: null } as unknown,
    catalogue: { status: "loading", data: null, error: null } as unknown,
  },
}));

vi.mock("@/lib/use-release", () => ({
  useRelease: () => state.release,
  useCatalogue: () => state.catalogue,
}));

/** A catalogue row from a release built before 2026-11-02 (no assets element). */
type FourFieldRow = [string, string, number, number];
/** A catalogue row from a release built with `net_assets` as the fifth element. */
type FiveFieldRow = [string, string, number, number, number | null];

const RELEASE_ID = "2026-11-02.8";

afterEach(cleanup);

beforeEach(() => {
  state.release = { status: "loading", data: null, error: null };
  state.catalogue = { status: "loading", data: null, error: null };
});

function readyCatalogue(funds: Record<string, FourFieldRow | FiveFieldRow>) {
  state.release = { status: "ready", data: { as_of: RELEASE_ID }, error: null };
  state.catalogue = { status: "ready", data: { as_of: RELEASE_ID, funds }, error: null };
}

/**
 * 60 synthetic funds whose assets run the opposite way to their tickers, so a page
 * that actually applied the size order cannot be confused with one that fell back to
 * ticker order. T060 is the largest; T001–T010 are outside the default 50.
 */
function sizedFunds(): Record<string, FiveFieldRow> {
  const funds: Record<string, FiveFieldRow> = {};
  for (let index = 1; index <= 60; index += 1) {
    const ticker = `T${String(index).padStart(3, "0")}`;
    funds[ticker] = [`Test Fund ${index}`, "TEST TRUST", 1, 90, index * 1_000_000_000];
  }
  return funds;
}

/**
 * The live release's shape: four-element rows, real curated tickers. `popular` puts
 * VTI first; a ticker order would put AAAA first, so the assertion can tell them
 * apart.
 */
function assetlessFunds(): Record<string, FourFieldRow> {
  return {
    AAAA: ["Amplius Aggressive Asset Allocation ETF", "EA Series Trust", 1, 27.0],
    AVUV: ["Avantis U.S. Small Cap Value ETF", "EA Series Trust", 1, 97.7],
    VTI: ["VANGUARD TOTAL STOCK MARKET ETF", "VANGUARD INDEX FUNDS", 1, 90.0],
  };
}

/** The body rows, without the header. */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

describe("default view", () => {
  it("shows the 50 largest funds by filed assets", () => {
    readyCatalogue(sizedFunds());
    render(<FundDirectory />);

    expect(screen.getAllByRole("row")).toHaveLength(51);
    const rows = dataRows();
    expect(rows[0]?.textContent).toContain("T060");
    expect(rows[49]?.textContent).toContain("T011");
    // The ten smallest are outside the default view until the reader asks for them.
    expect(screen.queryByText("T001")).toBeNull();
    expect(
      screen.getByText(/The 50 largest by assets, from each fund's own N-PORT filing/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Assets" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reaches a fund outside the top 50 through the search box", () => {
    readyCatalogue(sizedFunds());
    render(<FundDirectory />);
    expect(screen.queryByText("T001")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "T001" } });

    expect(screen.getByText("T001")).toBeTruthy();
    expect(dataRows()).toHaveLength(1);
    expect(screen.getByText(/1 match\./)).toBeTruthy();
  });

  it("reorders when the reader chooses A–Z", () => {
    readyCatalogue(sizedFunds());
    render(<FundDirectory />);
    expect(dataRows()[0]?.textContent).toContain("T060");

    fireEvent.click(screen.getByRole("button", { name: "A–Z" }));

    expect(dataRows()[0]?.textContent).toContain("T001");
    expect(screen.getByRole("button", { name: "A–Z" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("falls back to the editorial order and says why when the release has no figures", () => {
    readyCatalogue(assetlessFunds());
    render(<FundDirectory />);

    const rows = dataRows();
    expect(rows[0]?.textContent).toContain("VTI");
    expect(
      screen.getByText(/This release carries no fund asset figures yet/),
    ).toBeTruthy();
    // Nothing claims a size ranking there is no figure for.
    expect(screen.queryByText(/The 50 largest by assets/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Popular" }).getAttribute("aria-pressed"),
    ).toBe("true");
    // A size order the release cannot support is offered but not selectable.
    expect(screen.getByRole("button", { name: "Assets" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("offers all three orders", () => {
    readyCatalogue(assetlessFunds());
    render(<FundDirectory />);
    for (const label of ["Assets", "Popular", "A–Z"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });
});
