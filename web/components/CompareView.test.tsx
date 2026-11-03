import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompareView } from "@/components/CompareView";
import { writeComparison } from "@/lib/fragment-store";
import type { FundDocument, FundWeight, ReleaseDescriptor } from "@/lib/types";

/**
 * `/compare` takes the Portfolio page's input path, and its Δ column wears the ledger's
 * sign ink.
 *
 * Both properties are held here, against the real component, the real fragment store and
 * the real shared modules (`lib/holdings.ts` decides what was typed; `lib/format.ts` owns
 * the ink class), because a test that mocked either one would only prove that the page
 * agrees with its own mock. The fixtures are hand-worked: VOO and VTI are complete
 * 100%/100% portfolios whose company weights differ by exactly +30, −30, +20, −20 and 0
 * percent of portfolio value, so every Δ class has an expected string beside it.
 */

const { release, fundDocs } = vi.hoisted(() => {
  const holding = (company_id: string, weight_bp: number, name: string) => ({
    company_id,
    name,
    ticker: company_id.toUpperCase(),
    asset_cat: "equity",
    weight_bp,
  });
  const fund = (ticker: string, holdings: ReturnType<typeof holding>[]) => ({
    schema_version: 1,
    ticker,
    fund_id: `S${ticker}`,
    name: `${ticker} Fund`,
    issuer: "Issuer",
    as_of: "2026-06-30",
    filed_at: "2026-08-28",
    lag_days: 59,
    source: "SEC N-PORT",
    source_url: `https://www.sec.gov/${ticker}`,
    coverage_pct: 100,
    holdings,
    metrics: { hhi: 0, hhi_pct2: 0, effective_n: 0, top10_pct: 0 },
    warnings: [],
  });
  return {
    // `ZZZZ` is published by nothing and listed by nothing; `AMZN` is a common stock the
    // release resolves; `SPY` is classified as a fund rather than a stock; `VFIAX` is the
    // share class of `VOO`. The mock sits at the loader boundary, not at `holdings.ts`,
    // so the shared decision path is the one under test.
    release: {
      as_of: "2026-11-02.7",
      objects: { securities: { shards: { A: {}, V: {}, Z: {} } } },
    },
    fundDocs: [
      // A side (VOO at 100%): X 50%, Y 10%, Z 20%, W 20%.
      fund("VOO", [
        holding("c_x", 5000, "X Corp"),
        holding("c_y", 1000, "Y Corp"),
        holding("c_z", 2000, "Z Corp"),
        holding("c_w", 2000, "W Corp"),
      ]),
      // B side (VTI at 100%): X 20%, Y 40%, Z 20%, V 20%.
      fund("VTI", [
        holding("c_x", 2000, "X Corp"),
        holding("c_y", 4000, "Y Corp"),
        holding("c_z", 2000, "Z Corp"),
        holding("c_v", 2000, "V Corp"),
      ]),
    ],
  } as unknown as { release: ReleaseDescriptor; fundDocs: FundDocument[] };
});

vi.mock("@/lib/data", () => ({
  loadSecurities: async (value: ReleaseDescriptor, symbols: string[]) => {
    // The real loader throws when the release carries no symbols object; mirrored so the
    // "release predates stocks" branch stays reachable, as in the builder's tests.
    if (!value.objects.securities) return new Map();
    const table: Record<string, [string, string, string | null, string]> = {
      AMZN: ["c_0001018724", "AMAZON COM INC", "Nasdaq", "ok"],
      SPY: ["c_0000884394", "SPDR S&P 500 ETF TRUST", "NYSE Arca", "fund"],
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
  publishesSecurities: (value: ReleaseDescriptor) => Boolean(value.objects.securities),
}));

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: release, error: null }),
  // A release that publishes both funds and the tickers the tests type. `ZZZZ` is
  // deliberately absent from every list: those tests are about the sentence an unknown
  // symbol earns, and the answer must not depend on a mock that knows it.
  useTickers: () => ({
    status: "ready",
    data: ["QQQ", "VTI", "VTV", "VEA", "VWO", "VOO"],
    error: null,
  }),
  // Funds are already in memory: the column's state (not the loader) is what these tests
  // are about, so `pending` is empty and both sides are complete on first render.
  useFunds: (_release: ReleaseDescriptor | null, tickers: string[]) => ({
    funds: fundDocs.filter((fund) => tickers.includes(fund.ticker)),
    pending: [],
    error: null,
  }),
}));

beforeEach(() => {
  // The fragment is the only state store, so seeding it is how a test opens `/compare`
  // on a shared link. `[]` clears whatever the previous test left in the URL.
  writeComparison([], []);
});

afterEach(() => {
  cleanup();
});

/** Open `/compare` on a link that already names both sides. */
function seed(a: FundWeight[], b: FundWeight[]): void {
  writeComparison(a, b);
}

/** The form for one column, so "Add" is never ambiguous between the two sides. */
function formFor(label: string): HTMLFormElement {
  const input = screen.getByLabelText(`Fund ticker for ${label}`);
  const form = input.closest("form");
  if (!form) throw new Error(`No form around the ${label} ticker input`);
  return form;
}

/** Type into one side and submit, the way a visitor does. */
function addTo(label: string, typed: string): void {
  const form = formFor(label);
  fireEvent.change(within(form).getByRole("textbox"), { target: { value: typed } });
  fireEvent.click(within(form).getByRole("button", { name: "Add" }));
}

const completeA: FundWeight[] = [{ ticker: "VOO", weight_bp: 10_000 }];
const completeB: FundWeight[] = [{ ticker: "VTI", weight_bp: 10_000 }];

describe("CompareView — the Δ column", () => {
  it("wears the sign ink, and every printed Δ keeps its sign", () => {
    seed(completeA, completeB);
    const { container } = render(<CompareView />);

    const table = container.querySelector("table.ledger");
    expect(table).toBeTruthy();
    // VOO at 100% holds X 50 / Y 10 / Z 20 / W 20; VTI at 100% holds X 20 / Y 40 /
    // Z 20 / V 20. Δ is A − B, so: X +30, Y −30, V −20, W +20, Z exactly 0.
    const cells = [...container.querySelectorAll<HTMLSpanElement>("tbody span.delta")];
    expect(cells.map((cell) => cell.className)).toEqual([
      "delta delta--up",
      "delta delta--down",
      "delta delta--down",
      "delta delta--up",
      "delta",
    ]);
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "+30.00%",
      "−30.00%",
      "−20.00%",
      "+20.00%",
      "—",
    ]);

    // The property that lets this pair skip the colour-vision gate: the colour is never
    // the carrier. An up cell begins with "+", a down cell with "−", and both are glyphs
    // a monochrome print or a red-green reader keeps.
    for (const cell of cells) {
      const text = cell.textContent ?? "";
      if (cell.classList.contains("delta--up")) expect(text.startsWith("+")).toBe(true);
      else if (cell.classList.contains("delta--down"))
        expect(text.startsWith("−")).toBe(true);
      else {
        expect(text).toBe("—");
        expect(cell.classList.contains("delta--up")).toBe(false);
        expect(cell.classList.contains("delta--down")).toBe(false);
      }
    }

    // The caption states the mapping in words, which is the other half of the rule: a
    // reader cannot be expected to infer "green means A holds more" from the ink.
    const caption = table?.querySelector("caption")?.textContent ?? "";
    expect(caption).toContain("Δ is A minus B, in percentage points");
    expect(caption).toContain("green where A holds more of the company");
    expect(caption).toContain("red where B holds more");
    expect(caption).toContain("sign is printed beside every number");

    // The header abbreviation is the one cell that would be read as a bare glyph, so the
    // column carries its own note for a screen reader.
    const deltaHeader = container.querySelector("thead th:nth-child(4)");
    expect(deltaHeader?.querySelector(".sr-only")).toBeTruthy();
    expect(deltaHeader?.textContent).toContain("A minus B, in percentage points");
    expect(deltaHeader?.textContent).toContain("Green where A holds more");
  });

  it("states the total in the builder's own words, and keeps the 100% gate", () => {
    // A is half allocated, so the page must say exactly what the Portfolio page says and
    // must not compute an overlap: Σ min over a portfolio that only accounts for half its
    // value is a different question, not a smaller answer.
    seed([{ ticker: "VOO", weight_bp: 5_000 }], completeB);
    const { container } = render(<CompareView />);

    expect(screen.getByText(/Total 50\.00% 50\.00% unallocated\./)).toBeTruthy();
    expect(screen.getByText(/Total 100\.00% fully allocated\./)).toBeTruthy();
    expect(container.querySelector("table.ledger")).toBeNull();
    expect(screen.getByText(/overlap opens at exactly 100%/)).toBeTruthy();
  });
});

describe("CompareView — the Portfolio page's input path", () => {
  it("refuses a duplicate in the column named, with the shared sentence", async () => {
    seed(completeA, completeB);
    render(<CompareView />);

    addTo("Portfolio A", "VOO");

    // The title's only difference from the Portfolio page is the list named, which is
    // what `ctx.where` is for; the body is the module's fixed sentence, verbatim.
    expect(await screen.findByText("VOO is already in Portfolio A")).toBeTruthy();
    expect(
      screen.getByText("One row per holding: set its amount instead of adding it twice."),
    ).toBeTruthy();
    // It refused the add: the row count is unchanged, so no second VOO row appeared.
    expect(
      screen.getAllByRole("button", { name: "Remove VOO from Portfolio A" }),
    ).toHaveLength(1);
  });

  it("refuses a ticker the release does not publish with the same sentence", async () => {
    seed([], completeB);
    render(<CompareView />);

    addTo("Portfolio A", "ZZZZ");

    // The builder's sentence, not a guess about what the symbol is. Compare has to look
    // before it speaks: an unknown ticker is unknown, not "a stock".
    expect(
      await screen.findByText(`ZZZZ is not in release ${release.as_of}`),
    ).toBeTruthy();
    expect(screen.queryByText(/is a stock, not a fund/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove ZZZZ from Portfolio A" }),
    ).toBeNull();
  });

  it("resolves VFIAX to VOO rather than refusing the share class", async () => {
    // B is complete; A is empty, so the alias add lands as A's only fund at 100% and the
    // comparison opens — which is also the check that the resolved key, not the typed
    // text, reached the store.
    seed([], completeB);
    const { container } = render(<CompareView />);

    addTo("Portfolio A", "VFIAX");

    expect(
      await screen.findByText(
        /VFIAX is a share class of VOO, so the holdings are the same\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove VOO from Portfolio A" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove VFIAX from Portfolio A" }),
    ).toBeNull();
    expect(screen.queryByText(/is not in release/)).toBeNull();
    expect(container.querySelector("table.ledger")).toBeTruthy();
  });

  it("gets the funds-only sentence for a stock, not 'not in this release'", async () => {
    seed([], completeB);
    render(<CompareView />);

    addTo("Portfolio A", "AMZN");

    // The sentence points at the page that can hold a stock: a comparison is between what
    // funds hold, so a directly held position has no side here. The old page answered
    // "AMZN is not in this release", which was both false and unactionable.
    expect(await screen.findByText("AMZN is a stock, not a fund")).toBeTruthy();
    expect(
      screen.getByText(/Look it through on the Portfolio page instead/),
    ).toBeTruthy();
    expect(screen.queryByText(/AMZN is not in release/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove AMZN from Portfolio A" }),
    ).toBeNull();
  });
});
