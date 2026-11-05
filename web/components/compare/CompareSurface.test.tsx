import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FundDocument, Holding } from "@/lib/types";
import { decodeComparison } from "@/lib/fragment";
import { write, writeComparison } from "@/lib/fragment-store";
import { CASH_KEY } from "@/lib/types";

import { CompareSurface } from "./CompareSurface";

/**
 * The page's behaviour where a unit test cannot see it: the sentence it prints, the
 * number in that sentence, the tabs that partition it, and the two refusals — an
 * incomplete side and a fund whose coverage withholds its weights.
 *
 * The release hooks are mocked at the module boundary, so everything below them is
 * real: the fragment store, the look-through ledger, `buildOverlap`, `tallyOf`, the
 * market classification and the formatting. The one number this test asserts is the
 * one the library computes, not a number the component invented.
 */

const h = vi.hoisted(() => ({
  /** Mutable so a single test can put a fund below the coverage floor. */
  coverage: { VOO: 100, VTI: 100 } as Record<string, number>,
  holdings: {
    VOO: [
      ["c_0000000001", "Xylem Inc", "XYL", 5000],
      ["c_0000000002", "Chubb Ltd", "CB", 1000],
      ["c_0000000003", "Taiwan Semiconductor", "TSM", 2000],
      ["c_0000000004", "Waste Management", "WM", 2000],
    ],
    VTI: [
      ["c_0000000001", "Xylem Inc", "XYL", 2000],
      ["c_0000000002", "Chubb Ltd", "CB", 4000],
      ["c_0000000003", "Taiwan Semiconductor", "TSM", 2000],
      ["c_0000000005", "Visa Inc", "V", 2000],
    ],
  } as Record<string, Array<[string, string, string | null, number]>>,
}));

const COUNTRIES: Record<string, string> = {
  c_0000000001: "US",
  c_0000000002: "CH",
  c_0000000003: "TW",
  c_0000000004: "US",
  // An offshore holding domicile: the United States, because that is where it trades.
  c_0000000005: "KY",
};

const NAMES: Record<string, string> = {
  VOO: "Vanguard S&P 500 ETF",
  VTI: "Vanguard Total Stock Market ETF",
};

function fundDocument(ticker: string): FundDocument {
  return {
    schema_version: 3,
    ticker,
    fund_id: `f_${ticker.toLowerCase()}`,
    name: NAMES[ticker] ?? `${ticker} Fund`,
    issuer: "Test Issuer",
    as_of: ticker === "VOO" ? "2026-06-30" : "2026-08-31",
    filed_at: "2026-09-04",
    lag_days: 4,
    source: "N-PORT",
    source_url: "https://www.sec.gov/",
    coverage_pct: h.coverage[ticker] ?? 100,
    holdings: (h.holdings[ticker] ?? []).map(
      ([company_id, name, symbol, weight_bp]): Holding => ({
        company_id,
        name,
        ticker: symbol,
        asset_cat: "equity",
        weight_bp,
      }),
    ),
    metrics: { hhi: 0.3, hhi_pct2: 30, effective_n: 3.3, top10_pct: 100 },
    warnings: [],
  };
}

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: { as_of: "2026-11-02.7" }, error: null }),
  useTickers: () => ({ status: "ready", data: ["VOO", "VTI"], error: null }),
  useFunds: (_release: unknown, tickers: string[]) => ({
    funds: tickers.map((ticker) => fundDocument(ticker)),
    pending: [],
    error: null,
  }),
  useCatalogue: () => ({
    status: "ready",
    data: {
      as_of: "2026-11-02.7",
      funds: {
        VOO: ["Vanguard S&P 500 ETF", "Vanguard", 1, 100],
        VTI: ["Vanguard Total Stock Market ETF", "Vanguard", 1, 100],
      },
    },
    error: null,
  }),
  useCountries: () => ({
    status: "ready",
    data: { companies: COUNTRIES, contested: {} },
    error: null,
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  h.coverage.VOO = 100;
  h.coverage.VTI = 100;
  window.location.hash = "";
  writeComparison([], []);
});

/** Both sides whole and complete: A is all VOO, B is all VTI. */
function twoWholeMixes() {
  writeComparison(
    [{ ticker: "VOO", weight_bp: 10000 }],
    [{ ticker: "VTI", weight_bp: 10000 }],
  );
}

describe("nothing to compare", () => {
  it("opens on two empty mixes and says what a comparison is", () => {
    render(<CompareSurface />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Compare two mixes" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Mix A" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Mix B" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Nothing to compare yet" }),
    ).toBeTruthy();
    // No answer, and no table pretending to hold one.
    expect(screen.queryByText(/overlap by/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("starting from a portfolio", () => {
  it("fills Mix A with the portfolio's funds, and only its funds", () => {
    // A link from the workspace: 60% VOO, 40% cash. The comparison is funds only, so
    // A arrives holding VOO at 60% and says the side is short — cash is not a fund.
    write({
      mode: "bp",
      entries: [
        { kind: "fund", key: "VOO", amount: 6000 },
        { kind: "cash", key: CASH_KEY, amount: 4000 },
      ],
    });
    render(<CompareSurface />);

    const columnA = screen.getByRole("region", { name: "Mix A" });
    expect(within(columnA).getByText("Total 60.00%")).toBeTruthy();
    expect(
      (
        within(columnA).getByLabelText(
          "Weight of VOO in Mix A, in percent",
        ) as HTMLInputElement
      ).value,
    ).toBe("60.00");
    // Mix B is empty, so this is a portfolio with a comparison beside it, not a
    // comparison — and no number is claimed for it.
    expect(screen.getByText("This is a portfolio, not a comparison.")).toBeTruthy();
    expect(screen.queryByText(/overlap by/)).toBeNull();
  });
});

describe("one side only", () => {
  it("calls a one-sided mix a portfolio and points at the X-Ray", () => {
    writeComparison([{ ticker: "VOO", weight_bp: 10000 }], []);
    render(<CompareSurface />);

    expect(screen.getByText("This is a portfolio, not a comparison.")).toBeTruthy();
    // `next/link` normalises the trailing slash before a hash, so the href is the
    // same form `PortfolioBuilder` renders; the payload is what matters.
    const link = screen.getByRole("link", { name: "Open Mix A in the X-Ray" });
    expect(link.getAttribute("href")).toMatch(/^\/x\/?#v1\./);
    expect(screen.queryByText(/overlap by/)).toBeNull();
  });
});

describe("a whole comparison", () => {
  it("states the overlap as one sentence, answer first", () => {
    twoWholeMixes();
    render(<CompareSurface />);

    const sentence = screen.getByText(/These two mixes overlap by/);
    // Σ min: XYL 0.20 + CB 0.10 + TSM 0.20 = 50.00% of each mix.
    expect(sentence.textContent).toContain("50.00%");
    expect(sentence.textContent).toContain(
      "that is the share of each mix held in the same companies.",
    );
    expect(
      screen.getByText(/3 companies are held on both sides, of 5 held across the two/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Oldest filing behind these numbers: 2026-06-30/),
    ).toBeTruthy();
  });

  it("partitions the companies between the three tabs", () => {
    twoWholeMixes();
    render(<CompareSurface />);

    const shared = screen.getByRole("tab", { name: "Shared" });
    expect(shared.getAttribute("aria-selected")).toBe("true");

    const sharedRow = screen.getByRole("row", { name: /Xylem Inc/ });
    expect(sharedRow.textContent).toContain("50.00%");
    expect(sharedRow.textContent).toContain("20.00%");
    expect(sharedRow.textContent).toContain("VOO");
    expect(sharedRow.textContent).toContain("VTI");

    fireEvent.click(screen.getByRole("tab", { name: "Only in A" }));
    expect(screen.getByRole("row", { name: /Waste Management/ }).textContent).toContain(
      "20.00%",
    );
    expect(screen.queryByRole("row", { name: /Visa Inc/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Only in B" }));
    expect(screen.getByRole("row", { name: /Visa Inc/ }).textContent).toContain("20.00%");
    expect(screen.queryByRole("row", { name: /Waste Management/ })).toBeNull();
  });

  it("is one tab stop, and the arrow keys move between tabs", () => {
    twoWholeMixes();
    render(<CompareSurface />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    const shared = screen.getByRole("tab", { name: "Shared" });
    fireEvent.keyDown(shared, { key: "ArrowRight" });
    const onlyA = screen.getByRole("tab", { name: "Only in A" });
    expect(onlyA.getAttribute("aria-selected")).toBe("true");
    expect(shared.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(onlyA.id);

    fireEvent.keyDown(onlyA, { key: "End" });
    expect(
      screen.getByRole("tab", { name: "Only in B" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Only in B" }), { key: "Home" });
    expect(
      screen.getByRole("tab", { name: "Shared" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("puts both market bars on one scale and prints every number again", () => {
    twoWholeMixes();
    render(<CompareSurface />);

    const markets = screen.getByRole("region", { name: "Where the two mixes sit" });
    const bars = within(markets).getAllByRole("img");
    expect(bars).toHaveLength(2);

    // Same 0–100% axis: three segments each, and the text alternative carries the
    // percentages so the colour is never the only meaning.
    for (const bar of bars) {
      expect(bar.querySelectorAll(".bar__seg")).toHaveLength(3);
    }
    expect(bars[0]?.getAttribute("aria-label")).toContain("70.00% United States");
    expect(bars[0]?.getAttribute("aria-label")).toContain(
      "10.00% International Developed ex-US",
    );
    expect(bars[0]?.getAttribute("aria-label")).toContain("20.00% Emerging Markets");

    const us = within(markets).getByRole("row", { name: /United States/ });
    expect(us.textContent).toContain("70.00%");
    // Visa's Cayman domicile is the United States, not a fourth bucket: Mix B is
    // 20% Xylem + 20% Visa.
    expect(us.textContent).toContain("40.00%");
    // There is no "not placed" row: what the bar cannot place is stated in the caption.
    expect(within(markets).queryByRole("row", { name: /Not placed/ })).toBeNull();
  });
});

describe("refusals", () => {
  it("withholds the number when a side is not whole, and says which side", () => {
    writeComparison(
      [{ ticker: "VOO", weight_bp: 8800 }],
      [{ ticker: "VTI", weight_bp: 10000 }],
    );
    render(<CompareSurface />);

    expect(screen.getByText("Not yet: Mix A has to total 100%.")).toBeTruthy();
    expect(screen.getByText(/Mix A totals 88\.00%\./)).toBeTruthy();
    expect(screen.queryByText(/overlap by/)).toBeNull();
    // Nothing is silently normalised to fill the gap.
    expect(screen.getByText("Total 88.00%")).toBeTruthy();
  });

  it("names the fund when coverage withholds the answer", () => {
    h.coverage.VTI = 52.1;
    twoWholeMixes();
    render(<CompareSurface />);

    const sentence = screen.getByText(/cannot be compared on overlap/);
    expect(sentence.textContent).toContain("VTI in Mix B");
    expect(sentence.textContent).toContain("52.1% traced to companies");
    expect(screen.queryByText(/overlap by/)).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("prints the number beside the fund it could only partly trace", () => {
    h.coverage.VTI = 66.4;
    twoWholeMixes();
    render(<CompareSurface />);

    expect(screen.getByText(/These two mixes overlap by/).textContent).toContain(
      "50.00%",
    );
    expect(screen.getByText(/Partly traced: VTI in Mix B/)).toBeTruthy();
  });
});

describe("making a side whole", () => {
  it("scales the side to 100% and writes the result into the link", () => {
    writeComparison(
      [
        { ticker: "VOO", weight_bp: 6000 },
        { ticker: "VTI", weight_bp: 2800 },
      ],
      [],
    );
    render(<CompareSurface />);

    const columnA = screen.getByRole("region", { name: "Mix A" });
    expect(within(columnA).getByText("Total 88.00%")).toBeTruthy();

    fireEvent.click(within(columnA).getByRole("button", { name: "Scale to 100%" }));

    expect(within(columnA).getByText("Total 100.00%")).toBeTruthy();
    const vti = within(columnA).getByLabelText(
      "Weight of VTI in Mix A, in percent",
    ) as HTMLInputElement;
    expect(vti.value).toBe("31.82");
    const decoded = decodeComparison(window.location.hash);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.a).toEqual([
        { ticker: "VOO", weight_bp: 6818 },
        { ticker: "VTI", weight_bp: 3182 },
      ]);
    }
  });

  it("splits a side evenly with the library's own split", () => {
    writeComparison(
      [
        { ticker: "VOO", weight_bp: 6000 },
        { ticker: "VTI", weight_bp: 4000 },
      ],
      [],
    );
    render(<CompareSurface />);

    const columnA = screen.getByRole("region", { name: "Mix A" });
    fireEvent.click(within(columnA).getByRole("button", { name: "Split equally" }));

    expect(within(columnA).getByText("Total 100.00%")).toBeTruthy();
    for (const ticker of ["VOO", "VTI"]) {
      const field = within(columnA).getByLabelText(
        `Weight of ${ticker} in Mix A, in percent`,
      ) as HTMLInputElement;
      expect(field.value).toBe("50.00");
    }
  });
});
