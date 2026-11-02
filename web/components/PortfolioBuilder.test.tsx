import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioBuilder } from "@/components/PortfolioBuilder";
import { decodePortfolio } from "@/lib/fragment";
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

describe("PortfolioBuilder — 100% is a statement, not a clamp", () => {
  it("keeps the amount that was typed and never moves the other rows", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    // 50/50 by default. Drop VTI to 10 — 40% short, which is a normal state while
    // editing — then put QQQ at 95, which makes 105%.
    fireEvent.change(screen.getByLabelText("Amount for VTI, in percent"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Amount for QQQ, in percent"), {
      target: { value: "95" },
    });

    // Leaving each field shows the number the store kept: no clamp, no rebalancing.
    // (While the field has focus it shows the half-typed text, "95", which is why
    // the assertion blurs first.)
    fireEvent.blur(screen.getByLabelText("Amount for QQQ, in percent"));
    fireEvent.blur(screen.getByLabelText("Amount for VTI, in percent"));
    expect(screen.getByDisplayValue("95.00")).toBeTruthy();
    expect(screen.getByDisplayValue("10.00")).toBeTruthy();
    expect(screen.getByText("105.00%")).toBeTruthy();
    // And the tally says which side of 100% the portfolio is on, in words.
    expect(screen.getByText("5.00% over 100%")).toBeTruthy();
    // The over-100 total is in the link, so a reload restores it rather than
    // silently discarding the numbers on screen.
    expect(window.location.hash).not.toBe("");
    const decoded = decodePortfolio(window.location.hash);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.entries.map((entry) => entry.amount)).toEqual([9500, 1000]);
  });

  it("holds the ledger link until the total is exactly 100%", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    // A clean 50/50 split opens the ledger.
    expect(
      screen.getByRole("link", { name: "View the ledger" }).getAttribute("aria-disabled"),
    ).toBeNull();
    expect(screen.queryByText("The ledger opens at exactly 100%.")).toBeNull();

    fireEvent.change(screen.getByLabelText("Amount for QQQ, in percent"), {
      target: { value: "95" },
    });
    const gated = screen.getByRole("link", { name: "View the ledger" });
    expect(gated.getAttribute("aria-disabled")).toBe("true");
    expect(gated.getAttribute("aria-describedby")).toBe("ledger-gate");
    expect(screen.getByText("The ledger opens at exactly 100%.")).toBeTruthy();
    // Still a link, still focusable: the explanation has to be reachable.
    expect(gated.getAttribute("href")).toContain("/x#");

    // Back to exactly 100% (VTI is still 50) and it opens again.
    fireEvent.change(screen.getByLabelText("Amount for QQQ, in percent"), {
      target: { value: "50" },
    });
    expect(
      screen.getByRole("link", { name: "View the ledger" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("opens the ledger in dollar mode whatever the amounts are", () => {
    render(<PortfolioBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Dollars" }));
    fireEvent.change(screen.getByLabelText("Amount for QQQ, in dollars"), {
      target: { value: "1234.56" },
    });
    // Dollars are their own total, so nothing to be short of.
    expect(
      screen.getByRole("link", { name: "View the ledger" }).getAttribute("aria-disabled"),
    ).toBeNull();
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

/** The tickers in the portfolio list, top to bottom, as the visitor sees them. */
function rowTickers(): string[] {
  const list = document.querySelector(".portfolio-list");
  if (!list) return [];
  return Array.from(list.querySelectorAll("li .ticker")).map(
    (cell) => cell.textContent ?? "",
  );
}

function addFunds(...tickers: string[]): void {
  for (const ticker of tickers) {
    fireEvent.click(screen.getByRole("button", { name: `Add ${ticker}` }));
  }
}

describe("PortfolioBuilder — the order is the visitor's", () => {
  it("shows funds in the order they were added, never re-sorted", () => {
    render(<PortfolioBuilder />);
    // Alphabetical order would be QQQ, VOO, VTI — the old behaviour, and the reason
    // a portfolio typed as "my core fund first" came back unrecognisable.
    addFunds("QQQ", "VTI", "VOO");
    expect(rowTickers()).toEqual(["QQQ", "VTI", "VOO"]);

    const decoded = decodePortfolio(window.location.hash);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.entries.map((entry) => entry.key)).toEqual([
      "QQQ",
      "VTI",
      "VOO",
    ]);
  });

  it("reorders with the arrow keys and says where the row went", () => {
    render(<PortfolioBuilder />);
    addFunds("QQQ", "VTI", "VOO");

    const handle = screen.getByRole("button", { name: "Reorder VTI" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowUp" });

    expect(rowTickers()).toEqual(["VTI", "QQQ", "VOO"]);
    // The announcement is the only thing a screen-reader visitor gets: "moved" alone
    // would leave them re-reading the list to find out where.
    expect(screen.getByText("VTI moved to position 1 of 3")).toBeTruthy();
    // Focus stays on the same handle, so a second press keeps moving the same row.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reorder VTI" }),
    );
  });

  it("jumps to either end with Home and End", () => {
    render(<PortfolioBuilder />);
    addFunds("QQQ", "VTI", "VOO");

    const qqq = screen.getByRole("button", { name: "Reorder QQQ" });
    qqq.focus();
    fireEvent.keyDown(qqq, { key: "End" });
    expect(rowTickers()).toEqual(["VTI", "VOO", "QQQ"]);

    fireEvent.keyDown(qqq, { key: "Home" });
    expect(rowTickers()).toEqual(["QQQ", "VTI", "VOO"]);
  });

  it("writes the dragged order into the link, so it survives a reload", () => {
    render(<PortfolioBuilder />);
    addFunds("QQQ", "VTI", "VOO");

    const vti = screen.getByRole("button", { name: "Reorder VTI" });
    vti.focus();
    fireEvent.keyDown(vti, { key: "ArrowDown" });

    // The link is the portfolio: re-read what the visitor would get on reload.
    const decoded = decodePortfolio(window.location.hash);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.portfolio.entries.map((entry) => entry.key)).toEqual([
      "QQQ",
      "VOO",
      "VTI",
    ]);
  });

  it("offers no handle when there is nothing to reorder", () => {
    render(<PortfolioBuilder />);
    addFunds("QQQ");
    expect(screen.getByRole("button", { name: "Reorder QQQ" })).toHaveProperty(
      "disabled",
      true,
    );
    // The hint would describe an interaction that cannot happen yet.
    expect(screen.queryByText(/Drag a handle/)).toBeNull();
  });
});
