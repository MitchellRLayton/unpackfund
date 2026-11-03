import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FreshnessStrip, MetricsList } from "@/components/FreshnessStrip";
import { LedgerTable } from "@/components/LedgerTable";
import { Notice } from "@/components/Notice";
import type { BenchmarkFacts, Ledger, LedgerRow, ReleaseDescriptor } from "@/lib/types";

afterEach(cleanup);

const release: ReleaseDescriptor = {
  schema_version: 2,
  kind: "release",
  as_of: "2026-10-30.1",
  generated_at: "2026-10-30T00:00:00Z",
  pipeline_git_sha: "abc1234",
  fund_count: 1,
  etf_count: null,
  etf_classifier: null,
  company_count: 1,
  coverage_histogram: {},
  mapping_rungs: {},
  asset_cat_counts: {},
  objects: {
    manifest: { path: "manifest.json", bytes: 10, sha256: "a".repeat(64) },
    tickers: { path: "tickers.json", bytes: 10, sha256: "b".repeat(64) },
    catalogue: { path: "catalogue.json", bytes: 10, sha256: "c".repeat(64) },
    fund_index: { prefix: "index/", shards: ["V"], funds: 1 },
    companies: {
      index: { path: "companies/index.json", bytes: 10, sha256: "d".repeat(64) },
      prefix: "companies/",
      count: 1,
    },
  },
};

function row(
  company_id: string,
  name: string,
  weight: number,
  holder_count = 1,
  benchmark_weight: number | null = null,
  country: string | null = null,
): LedgerRow {
  return {
    company_id,
    name,
    ticker: name.slice(0, 4).toUpperCase(),
    weight,
    benchmark_weight,
    country,
    holder_count,
    held_directly: false,
    sources: [{ kind: "fund", ref: "VOO", weight }],
  };
}

/**
 * The caption sentence for the geography channel, word for word as the operator's
 * instruction gives it: the mark and the edge are explained in text, so the colour is
 * reinforcement and a screen reader or a monochrome print loses nothing. The clause
 * about the two-letter code is not decoration: on Windows the flag *is* the code, and
 * a reader who sees letters where the caption promised a flag should not think the
 * page is broken.
 */
const COUNTRY_SENTENCE =
  " The flag beside a company is the domicile its holders' filings agree on by value;" +
  " where a platform has no flag glyphs it shows the two-letter code instead." +
  " The row's left edge repeats it in colour — blue for the United States, ochre for" +
  " developed markets elsewhere, a deeper ochre for emerging ones. A grey edge marks a" +
  " company with no market tier: solid where the domicile is known but is neither" +
  " developed nor emerging, dashed where the filings do not agree on a country at all.";

const vt: BenchmarkFacts = {
  ticker: "VT",
  name: "VANGUARD TOTAL WORLD STOCK INDEX FUND",
  as_of: "2026-07-31",
  filed_at: "2026-09-28",
  lag_days: 59,
  coverage_pct: 97.8,
  source_url: "https://www.sec.gov/example-vt",
};

const ledger: Ledger = {
  rows: [row("c_1", "NVIDIA Corp", 0.0751), row("c_2", "Apple Inc", 0.0659)],
  benchmark: null,
  metrics: {
    hhi: 0.305,
    effective_n: 3.2787,
    top10: 0.9,
    covered_weight_pct: 90.3,
    resolved_weight: 0.903,
    suppressed_weight: 0,
    invested_weight: 0.903,
    cash_weight: 0,
    unallocated_weight: 0,
  },
  funds: [
    {
      ticker: "VOO",
      name: "VANGUARD 500 INDEX FUND",
      as_of: "2026-06-30",
      filed_at: "2026-08-28",
      lag_days: 59,
      coverage_pct: 90.3,
      source_url: "https://www.sec.gov/example",
    },
  ],
  oldest_as_of: "2026-06-30",
  max_lag_days: 59,
  unmapped: {
    positions: 3126,
    positions_with_weight: 772,
    securities_with_weight: 764,
    securities_weight: 0.0282,
    cash_and_derivatives_with_weight: 8,
    cash_and_derivatives_weight: 0.0148,
  },
};

describe("FreshnessStrip", () => {
  it("prints the filing period, the lag, and the coverage in words", () => {
    render(<FreshnessStrip release={release} ledger={ledger} />);
    expect(screen.getByText(release.as_of)).toBeTruthy();
    expect(screen.getByText("2026-06-30")).toBeTruthy();
    expect(screen.getByText("59 days")).toBeTruthy();
    expect(screen.getByText("90.3%")).toBeTruthy();
    // Coverage is a percentage of invested money, and the cell says so rather than
    // leaving a reader to guess whether cash is in the denominator.
    expect(screen.getByText("90.3%")).toBeTruthy();
    expect(screen.getByText("of the money you have invested")).toBeTruthy();
    // Coverage is money, so its complement is money: 9.7% of the *invested* part —
    // 0.903 × 0.097 = 0.0876 of the portfolio — is not traced. The count of unmapped
    // positions is a disclosure below the table, not a headline number that reads as
    // 3,126 failures.
    expect(screen.getByText("8.76%")).toBeTruthy();
    expect(screen.getByText("of your money, incl. cash and derivatives")).toBeTruthy();
    expect(screen.getByText("each company counted once")).toBeTruthy();
    expect(screen.queryByText(/holdings unmapped/)).toBeNull();
  });

  it("does not claim a date it does not have", () => {
    const empty: Ledger = {
      ...ledger,
      rows: [],
      funds: [],
      oldest_as_of: null,
      max_lag_days: null,
    };
    render(<FreshnessStrip release={release} ledger={empty} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});

describe("MetricsList", () => {
  it("renders a not-computable metric as words, never as zero", () => {
    render(
      <MetricsList
        ledger={{
          ...ledger,
          metrics: { ...ledger.metrics, hhi: null, effective_n: null, top10: null },
        }}
      />,
    );
    expect(screen.getAllByText("not computable")).toHaveLength(3);
  });

  it("uses the fund pages' names for the same three numbers", () => {
    // The generated fund pages say "Concentration", "Same-size companies" and
    // "Biggest 10 companies" with a one-line explanation each. Two surfaces
    // showing the same number under two names reads as two different metrics.
    render(<MetricsList ledger={ledger} />);
    expect(screen.getByText("Concentration")).toBeTruthy();
    expect(screen.getByText("Same-size companies")).toBeTruthy();
    expect(screen.getByText("Biggest 10 companies")).toBeTruthy();
    expect(screen.getByText(/0 = spread evenly, 1 = all in one company/)).toBeTruthy();
    expect(
      screen.getByText(/How many equal-sized companies would be spread the same way/),
    ).toBeTruthy();
  });
});

describe("LedgerTable", () => {
  it("is a real table with a scope on every header and a sort on the active column", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(2);
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      "Portfolio weight",
    );
    expect(container.querySelectorAll('th[aria-sort="none"]')).toHaveLength(2);
    expect(table?.querySelector("caption")?.textContent).toContain("2 companies");
  });

  it("shows every fund a company is attributable to, never a +N more", () => {
    // Five funds, which is where the old table sliced to three and appended
    // "+2 more" — an attribution the row does not show is one it withholds.
    const fiveFunds: LedgerRow = {
      ...row("c_5", "Five Fund Co", 0.05, 5),
      sources: [
        { kind: "fund", ref: "QQQ", weight: 0.02 },
        { kind: "fund", ref: "VTI", weight: 0.01 },
        { kind: "fund", ref: "VTV", weight: 0.008 },
        { kind: "fund", ref: "VEA", weight: 0.007 },
        { kind: "fund", ref: "VWO", weight: 0.005 },
      ],
    };
    const { container } = render(<LedgerTable rows={[fiveFunds]} />);
    expect(container.querySelectorAll(".fund-attrib__item")).toHaveLength(5);
    for (const ticker of ["QQQ", "VTI", "VTV", "VEA", "VWO"]) {
      expect(screen.getByText(ticker)).toBeTruthy();
    }
    expect(screen.queryByText(/\+\d+ more/)).toBeNull();
    expect(container.querySelector("caption")?.textContent).toContain("1 company");
  });

  it("says what it is showing when it is a page of a larger ledger", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} limit={1} />);
    expect(
      screen.getByText(/Showing the top 1 of 2 companies by portfolio weight/),
    ).toBeTruthy();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("shows each company once with its weight and how many funds hold it", () => {
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(screen.getByText("NVIDIA Corp")).toBeTruthy();
    // Twice: the weight column, and the fund chip that explains where it came from.
    expect(screen.getAllByText("7.51%")).toHaveLength(2);
    // Weight is a share of the portfolio, and the row note names the source.
    expect(container.querySelector(".row-note")?.textContent).toContain("VOO 7.51%");
  });
});

describe("the benchmark column", () => {
  it("sits beside the portfolio weight and names the fund it compares with", () => {
    // Two quantities, two columns (`static-xray-frontend` §4a): 15% of the
    // visitor's money in NVIDIA, 4.06% of VT's. The benchmark weight is a share
    // of the benchmark's NAV, so the bracket beside it is the difference of two
    // shares of different wholes — the only arithmetic this column carries.
    const rows = [
      row("c_1", "NVIDIA Corp", 0.15, 1, 0.0406),
      row("c_2", "Bridgeway Omni Small-Cap Value", 0.02, 1, 0),
    ];
    const { container } = render(<LedgerTable rows={rows} benchmark={vt} />);
    const headers = [...container.querySelectorAll('thead th[scope="col"]')].map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Company", "Portfolio weight", "In VT", "Funds"]);
    // 15.00% twice: the weight column and the fund chip that explains it.
    expect(screen.getAllByText("15.00%")).toHaveLength(2);
    expect(screen.getByText("4.06%")).toBeTruthy();
    // The bracket is your weight minus the benchmark's, signed: 15.00% - 4.06%.
    expect(screen.getByText("(+10.94%)")).toBeTruthy();
    // A company the benchmark's traced holdings exclude is a true zero, printed
    // as a zero rather than left blank, and its bracket is the whole of your
    // weight because there is nothing of the benchmark's to subtract.
    expect(screen.getByText("0.00%")).toBeTruthy();
    expect(screen.getByText("(+2.00%)")).toBeTruthy();
    expect(container.querySelector("caption")?.textContent).toContain(
      "share of VT's own portfolio",
    );
  });

  it("puts the signed difference beside the benchmark weight, the operator's example", () => {
    // Held 1.52% of NVIDIA while VT holds 4.06%: the column reads `4.06% (-2.54%)`,
    // i.e. you hold 2.54 percentage points less than the benchmark does.
    const rows = [row("c_1", "NVIDIA Corp", 0.0152, 1, 0.0406)];
    const { container } = render(<LedgerTable rows={rows} benchmark={vt} />);
    const cell = container.querySelectorAll<HTMLTableCellElement>("td.numeric")[1];
    expect(cell?.textContent?.replace(/\s+/g, " ").trim()).toBe("4.06% (-2.54%)");
    // The direction is stated in words as well as by the sign, so a reader does
    // not have to infer which side is which from the minus.
    expect(container.querySelector("caption")?.textContent).toContain(
      "your weight minus VT's, in percentage points: negative means you hold less",
    );
  });

  it("prints both numbers for a directly held stock the benchmark does not own", () => {
    // "No matter what the portfolio is" (the operator's words): a stock entry, no
    // fund behind it, and a company VT holds none of. The bracket is the whole of
    // the visitor's weight, which is what a comparison against 0.00% means.
    const direct = {
      ...row("c_3", "Bridgeway Omni Small-Cap Value", 0.003, 0, 0),
      held_directly: true,
      sources: [{ kind: "security" as const, ref: "BSVO", weight: 0.003 }],
    };
    const { container } = render(<LedgerTable rows={[direct]} benchmark={vt} />);
    const cells = [...container.querySelectorAll<HTMLTableCellElement>("td.numeric")].map(
      (cell) => cell.textContent?.replace(/\s+/g, " ").trim(),
    );
    // Portfolio weight, In VT, then the Funds column's `direct`.
    expect(cells[0]).toBe("0.30%");
    expect(cells[1]).toBe("0.00% (+0.30%)");
    expect(cells[2]).toBe("direct");
  });

  it("marks a directly held company's row, and says in words what the shading means", () => {
    // The operator's instruction (2026-11-02): a single-stock position should be
    // visible at a glance. `data-direct` is what the stylesheet shades, and the
    // caption carries the meaning as text, so colour is reinforcement and never the
    // message (static-xray-frontend §8) — a reader in forced-colours mode, on a
    // monochrome e-ink screen, or with a screen reader loses nothing.
    const direct: LedgerRow = {
      ...row("c_3", "Bridgeway Omni Small-Cap Value", 0.003, 0, 0),
      held_directly: true,
      sources: [{ kind: "security" as const, ref: "BSVO", weight: 0.003 }],
    };
    const viaFund = row("c_4", "Fund Only Co", 0.05, 2, 0.01);
    const { container } = render(<LedgerTable rows={[direct, viaFund]} benchmark={vt} />);
    const shaded = [
      ...container.querySelectorAll("tbody tr[data-direct='true']"),
    ] as HTMLTableRowElement[];
    expect(shaded).toHaveLength(1);
    expect(shaded[0]?.textContent).toContain("Bridgeway Omni Small-Cap Value");
    expect(container.querySelector("caption")?.textContent).toContain(
      "hold directly, as a stock",
    );
  });

  it("neither shades a row nor explains shading when nothing is held directly", () => {
    // A fund-only portfolio is the common case, and a sentence about shading with
    // no shaded row on screen is noise in the caption.
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(container.querySelectorAll("tbody tr[data-direct='true']")).toHaveLength(0);
    expect(container.querySelector("caption")?.textContent).not.toContain("shaded");
  });

  it("sorts by the benchmark weight like every other numeric column", () => {
    const rows = [
      row("c_1", "Portfolio Heavy", 0.5, 1, 0),
      row("c_2", "Benchmark Heavy", 0.01, 1, 0.2),
    ];
    const { container } = render(<LedgerTable rows={rows} benchmark={vt} />);
    const sortByBenchmark =
      container.querySelectorAll<HTMLButtonElement>("thead .sort-button")[2];
    expect(sortByBenchmark?.textContent).toContain("In VT");
    if (sortByBenchmark) fireEvent.click(sortByBenchmark);
    const first = container.querySelector("tbody tr th")?.textContent;
    expect(first).toContain("Benchmark Heavy");
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      "In VT",
    );
  });

  it("draws no comparison column when the release publishes no benchmark", () => {
    // Without a benchmark there is nothing to compare against, so the column is
    // absent — a column of zeros would claim the benchmark holds nothing.
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(container.querySelector("caption")?.textContent).not.toContain("In VT");
  });
});

describe("the country channel", () => {
  // Two companies the release answers for (US and Taiwan) and one it does not: the
  // filings disagree about it, so it is absent from the map. Absence is a no-answer,
  // not a default, and the row must show nothing rather than guess a domicile.
  const rows = [
    row("c_1", "NVIDIA Corp", 0.075, 1, null, "US"),
    row("c_2", "Taiwan Semiconductor", 0.05, 1, null, "TW"),
    row("c_3", "Undecided Co", 0.02, 1),
  ];

  it("marks exactly the rows the release answers for, and names the country aloud", () => {
    const { container } = render(<LedgerTable rows={rows} />);
    const tagged = [
      ...container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-country]"),
    ];
    expect(tagged.map((tr) => tr.dataset.country)).toEqual(["US", "TW"]);
    // The mark is a flag glyph, so it is not text a screen reader can read: the span
    // carries the country's *name* as its accessible name instead, and the glyph itself
    // is never announced (static-xray-frontend §8 — the meaning is never the picture).
    expect(screen.getByRole("img", { name: "United States" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Taiwan" })).toBeTruthy();
    // The glyph is the code's two regional indicators, so the mark is derived and not
    // a table entry: `US` → U+1F1FA U+1F1F8.
    expect(container.querySelector(".country-tag")?.textContent).toBe(
      "\u{1F1FA}\u{1F1F8}",
    );
    // The undecided company carries neither the attribute nor a tag.
    const untagged = [
      ...container.querySelectorAll<HTMLTableRowElement>("tbody tr"),
    ].filter((tr) => !tr.hasAttribute("data-country"));
    expect(untagged).toHaveLength(1);
    expect(untagged[0]?.textContent).toContain("Undecided Co");
    expect(untagged[0]?.querySelector(".country-tag")).toBeNull();
    expect(container.querySelectorAll(".country-tag")).toHaveLength(2);
  });

  it("turns each domicile into its market tier, and marks the two unplaced states", () => {
    // The third axis: the same country code the row tags becomes the edge's tier. Taiwan
    // is emerging under FTSE (the IMF calls it advanced) and the United States is its own
    // tier. The two states with no tier are distinguished by *pattern*, not by a fourth
    // colour: a domicile in neither list (Cayman) keeps its code and takes the solid
    // neutral edge, and a company whose filings do not agree (no country at all) loses the
    // code and takes the dashed one. That distinction is what the operator asked for on
    // 2026-11-02 — before it, both rendered as nothing, which read as a bug.
    const tiers = [
      row("c_5", "Cayman Holdco", 0.02, 0, null, "KY"),
      row("c_6", "Samsung Electronics", 0.03, 0, null, "KR"),
      row("c_7", "Nestle", 0.03, 0, null, "CH"),
      row("c_8", "Glencore", 0.02, 0, null, undefined),
    ];
    const { container } = render(<LedgerTable rows={tiers} />);
    const byName = (name: string) =>
      [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((tr) =>
        tr.textContent?.includes(name),
      );
    expect(byName("Cayman Holdco")?.dataset.tier).toBe("OTHER");
    expect(byName("Samsung Electronics")?.dataset.tier).toBe("DM");
    expect(byName("Nestle")?.dataset.tier).toBe("DM");
    // The unclassified row keeps its mark; the unplaced row has none and says so in an
    // attribute the stylesheet turns into the dashed edge.
    expect(screen.getByRole("img", { name: "Cayman Islands" })).toBeTruthy();
    expect(byName("Cayman Holdco")?.dataset.countryMissing).toBeUndefined();
    expect(byName("Glencore")?.dataset.tier).toBeUndefined();
    expect(byName("Glencore")?.dataset.countryMissing).toBe("true");
    expect(byName("Glencore")?.querySelector(".country-tag")).toBeNull();
    // Every classified row still carries its mark, whatever its tier.
    expect(screen.getByRole("img", { name: "South Korea" })).toBeTruthy();
  });

  it("explains the tag and the edge in the caption, word for word", () => {
    const { container } = render(<LedgerTable rows={rows} />);
    const caption = container.querySelector("caption")?.textContent ?? "";
    expect(caption).toContain(COUNTRY_SENTENCE);
    // Named, not implied: a colour that encodes a publisher's judgement has to say whose
    // judgement and which vintage, or the reader cannot check it against the fund page.
    expect(caption).toContain(
      "Developed and emerging follow the FTSE country classification, as of 2026-11-02",
    );
  });

  it("paints the bracket green above the benchmark and red below it", () => {
    // The operator's instruction (2026-11-02): the plus-or-minus against VT reads as an
    // indicator, green for more of the company than the benchmark holds and red for less.
    // This holds the ends together — the class comes from the sign, an exact match stays
    // quiet, and every coloured bracket still carries its sign in text, which is what lets
    // this pair skip the colour-vision gate (`lib/theme.test.ts`). The geography edge keeps
    // its own attribute and its own ink; the two channels do not share this cell.
    const withBenchmark = [
      row("c_1", "NVIDIA Corp", 0.075, 1, 0.04, "US"), // +3.50% — above, green
      row("c_2", "Taiwan Semiconductor", 0.04, 1, 0.05, "TW"), // -1.00% — below, red
      row("c_3", "Undecided Co", 0.02, 1, 0.02), // 0.00% — level, quiet
    ];
    const { container } = render(<LedgerTable rows={withBenchmark} benchmark={vt} />);
    const brackets = [...container.querySelectorAll<HTMLSpanElement>("tbody span.delta")];
    expect(brackets).toHaveLength(3);
    expect(brackets.map((span) => span.className)).toEqual([
      "delta delta--up",
      "delta delta--down",
      "delta",
    ]);
    expect(brackets.map((span) => span.textContent)).toEqual([
      "(+3.50%)",
      "(-1.00%)",
      "(0.00%)",
    ]);
    // The sign is never implied by the ink: an up bracket begins `(+`, a down `(-`, and a
    // level one carries no sign at all because there is no side to be on.
    for (const span of brackets) {
      const text = span.textContent ?? "";
      if (span.classList.contains("delta--up")) expect(text.startsWith("(+")).toBe(true);
      else if (span.classList.contains("delta--down"))
        expect(text.startsWith("(-")).toBe(true);
      else expect(text).toBe("(0.00%)");
    }
    // The edge still says where each company is domiciled, in its own channel.
    expect(
      brackets.map((span) => span.closest("tr")?.getAttribute("data-country") ?? null),
    ).toEqual(["US", "TW", null]);
    expect(container.querySelector("caption")?.textContent).toContain(
      "The bracketed difference in the In VT column is green when you hold more of the" +
        " company than VT does and red when you hold less",
    );
  });

  it("carries a direct position and a country on the same row, one channel each", () => {
    // The combination the two axes exist for: a stock you hold directly that also has
    // a decided domicile. The background keeps meaning position kind and the edge
    // means geography, so neither meaning is asked to share an encoding.
    const both: LedgerRow = {
      ...row("c_4", "Taiwan Semiconductor", 0.04, 0, null, "TW"),
      held_directly: true,
      sources: [{ kind: "security" as const, ref: "TSM", weight: 0.04 }],
    };
    const { container } = render(<LedgerTable rows={[both]} />);
    const tr = container.querySelector<HTMLTableRowElement>("tbody tr");
    expect(tr?.dataset.direct).toBe("true");
    expect(tr?.dataset.country).toBe("TW");
    expect(tr?.dataset.tier).toBe("EM");
    expect(tr?.querySelector(".country-tag")?.getAttribute("aria-label")).toBe("Taiwan");
    expect(container.querySelector("caption")?.textContent).toContain(COUNTRY_SENTENCE);
  });

  it("adds no tag and no sentence when the release publishes no countries", () => {
    // Every release before this one, and the common case today: the table renders as
    // it did before the channel existed — no attribute, no tag, no sentence.
    const { container } = render(<LedgerTable rows={ledger.rows} />);
    expect(container.querySelectorAll("tbody tr[data-country]")).toHaveLength(0);
    expect(container.querySelector(".country-tag")).toBeNull();
    const caption = container.querySelector("caption")?.textContent ?? "";
    expect(caption).not.toContain("country");
    expect(caption).not.toContain("shaded");
    // No geography, no ink promised: the caption cannot describe a colour code the table
    // is not using.
    expect(caption).not.toContain("is green when you hold more");
  });
});

describe("Notice", () => {
  it("names its kind in the heading as well as the styling", () => {
    const { container } = render(
      <Notice tone="warn" title="These weights do not add up to 100%">
        <p>Details</p>
      </Notice>,
    );
    expect(container.querySelector(".notice--warn")).toBeTruthy();
    expect(screen.getByText("These weights do not add up to 100%")).toBeTruthy();
  });
});
