import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioBuilder } from "@/components/PortfolioBuilder";
import { write } from "@/lib/fragment-store";
import type { ReleaseDescriptor } from "@/lib/types";

/**
 * The builder's destructive control has one job: never lose a portfolio by a
 * misclick. These tests drive the real hook and the real URL fragment, not a
 * stand-in, because the fragment is the only state store — an Undo that wrote
 * somewhere else would pass a mock and fail a visitor.
 */

const { release } = vi.hoisted(() => ({
  release: {
    as_of: "2026-10-30.8",
    objects: { securities: { shards: { A: {}, B: {}, S: {}, Z: {} } } },
  } as unknown as ReleaseDescriptor,
}));

/**
 * The release and its symbol object are mocked at the module boundary, not the
 * component's helpers, so the test drives the real builder — the real fragment
 * store, the real status table, the real conversion — against a small release.
 */
vi.mock("@/lib/data", () => ({
  // `SPY` is a fund in the real release and `BRK-B` a real share class; the mock
  // keeps both so the refusal sentence and the share-class hop are exercised.
  loadSecurities: async (value: ReleaseDescriptor, symbols: string[]) => {
    // The real loader throws when the release has no symbols object, and the builder
    // treats that as "no row". Mirrored here so the fallback sentence is reachable.
    if (!value.objects.securities) return new Map();
    const table: Record<string, [string, string, string | null, string]> = {
      AMZN: ["c_0001018724", "AMAZON COM INC", "Nasdaq", "ok"],
      SPY: ["c_0000884394", "SPDR S&P 500 ETF TRUST", "NYSE Arca", "fund"],
      "BRK-B": ["c_0001067983", "BERKSHIRE HATHAWAY INC", "NYSE", "ok"],
    };
    const rows = new Map<string, [string, string, string | null, string]>();
    for (const symbol of symbols) {
      const row = table[symbol];
      if (row) rows.set(symbol, row);
    }
    return rows;
  },
  resolveAlias: async (_release: unknown, ticker: string) =>
    ticker === "VFIAX" ? "VOO" : null,
  // The real rule, against the mocked release: a release either carries the object
  // or it does not, and the builder's sentence depends on which.
  publishesSecurities: (value: ReleaseDescriptor) => Boolean(value.objects.securities),
}));

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: release, error: null }),
  useTickers: () => ({
    status: "ready",
    data: ["QQQ", "VTI", "VTV", "VEA", "VWO", "VOO"],
    error: null,
  }),
}));

beforeEach(() => {
  write({ mode: "bp", entries: [] });
});

afterEach(() => {
  cleanup();
});

describe("PortfolioBuilder — Remove all", () => {
  it("empties the portfolio and offers the removed funds back", () => {
    render(<PortfolioBuilder />);

    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    // A chip also carries the ticker text, so the row is asserted by its control.
    expect(screen.getByRole("button", { name: "Remove QQQ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    expect(window.location.hash).not.toBe("");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove everything from the portfolio" }),
    );

    expect(screen.getByText("Portfolio cleared")).toBeTruthy();
    expect(screen.getByText(/Removed 2 holdings/)).toBeTruthy();
    expect(screen.getByText(/Nothing added yet/)).toBeTruthy();
    // The URL is the portfolio: if it still names funds, the clear did nothing.
    expect(window.location.hash).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.queryByText("Portfolio cleared")).toBeNull();
    // A chip also carries the ticker text, so the row is asserted by its control.
    expect(screen.getByRole("button", { name: "Remove QQQ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    expect(screen.getByText("100.00%")).toBeTruthy();
    expect(window.location.hash).not.toBe("");
  });

  it("drops the undo offer once a new fund is added", () => {
    render(<PortfolioBuilder />);

    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove everything from the portfolio" }),
    );
    expect(screen.getByText("Portfolio cleared")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));

    expect(screen.queryByText("Portfolio cleared")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
  });
});

describe("PortfolioBuilder — stocks, cash, and units", () => {
  it("adds a stock by symbol and names the company it resolved to", async () => {
    render(<PortfolioBuilder />);
    fireEvent.change(screen.getByLabelText("Fund ticker or stock symbol"), {
      target: { value: "AMZN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // The confirmation step: a symbol is a label, so the company is named back.
    expect(await screen.findByText(/Added AMZN — AMAZON COM INC/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove AMZN" })).toBeTruthy();
    expect(screen.getByText("held directly")).toBeTruthy();
    // The URL carries the kind, so the link reproduces a stock and not a fund.
    expect(window.location.hash.startsWith("#v3.")).toBe(true);
  });

  it("refuses a fund typed as a stock, and says which list it is on", async () => {
    render(<PortfolioBuilder />);
    fireEvent.change(screen.getByLabelText("Fund ticker or stock symbol"), {
      target: { value: "SPY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("SPY cannot be added as a stock")).toBeTruthy();
    expect(screen.getByText(/add it as a fund/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove SPY" })).toBeNull();
  });

  it("says a symbol is not in this release rather than pretending it is", async () => {
    render(<PortfolioBuilder />);
    fireEvent.change(screen.getByLabelText("Fund ticker or stock symbol"), {
      target: { value: "ZZZZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/ZZZZ is not in release/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove ZZZZ" })).toBeNull();
  });

  it("adds cash as its own row, once", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add cash" }));
    expect(screen.getByRole("button", { name: "Remove cash" })).toBeTruthy();
    // A second cash line is refused by the button, because cash is one row.
    expect(screen.getByRole("button", { name: "Add cash" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("re-expresses percentages as dollars of a $10,000 notional and back", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));

    fireEvent.click(screen.getByRole("button", { name: "Dollars" }));
    // 50/50 of $10,000: the split is unchanged and the unit is spelled out.
    expect(screen.getByLabelText("Amount for QQQ, in dollars")).toBeTruthy();
    // 50% of $10,000 on each row: the same split, counted in money.
    expect(screen.getAllByDisplayValue("5000.00")).toHaveLength(2);
    expect(screen.getByText(/Amounts shown in dollars/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Percentages" }));
    expect(screen.getAllByDisplayValue("50.00")).toHaveLength(2);
  });

  it("reports an unallocated remainder in percent mode and never calls it cash", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    fireEvent.change(screen.getByLabelText("Amount for QQQ, in percent"), {
      target: { value: "30" },
    });
    expect(screen.getByText(/unallocated/)).toBeTruthy();
    expect(screen.queryByText(/Cash/)).toBeNull();
  });
});

describe("PortfolioBuilder — the 100% ceiling", () => {
  it("stops a row where the others leave room, and says why", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    // 50/50 by default. Drop VTI to 10 (legal: 40% is then unallocated), then try
    // to put QQQ at 95, which would make 105%.
    fireEvent.change(screen.getByLabelText("Amount for VTI, in percent"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Amount for QQQ, in percent"), {
      target: { value: "95" },
    });

    expect(screen.getByText("That would take the portfolio over 100%")).toBeTruthy();
    // The row holds the largest legal amount, and the total is still exactly 100%.
    expect(screen.getByDisplayValue("90.00")).toBeTruthy();
    expect(screen.getByText("100.00%")).toBeTruthy();
    // The link still opens: a build that wrote 140% would emit a dead fragment.
    expect(window.location.hash).not.toBe("");
  });
});

describe("PortfolioBuilder — a release that predates stocks", () => {
  it("says the release does not carry symbols instead of blaming the symbol", async () => {
    // The live release before the first stock-ready one has no `objects.securities`.
    // "AMZN is not in release X" is then a false claim about Amazon, and the visitor
    // cannot act on it: the release has not been asked the question at all.
    const objects = release.objects;
    delete (objects as { securities?: unknown }).securities;
    try {
      render(<PortfolioBuilder />);
      fireEvent.change(screen.getByLabelText("Fund ticker or stock symbol"), {
        target: { value: "AMZN" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(
        await screen.findByText("This release does not list stock symbols yet"),
      ).toBeTruthy();
      expect(screen.queryByText(/AMZN is not in release/)).toBeNull();
      expect(window.location.hash).toBe("");
    } finally {
      (objects as { securities?: unknown }).securities = {
        shards: { A: {}, B: {}, S: {}, Z: {} },
      };
    }
  });
});
