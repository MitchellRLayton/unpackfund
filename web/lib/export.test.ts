import { describe, expect, it } from "vitest";

import { CSV_COLUMNS, ledgerCsv, ledgerCsvName } from "./export";
import type { Ledger, LedgerRow } from "./types";
import { withEffective } from "./testing/ledger";

/**
 * The export is the one place a computed number leaves the page, so its two
 * properties are pinned by hand rather than by a snapshot: a row says where its
 * weight came from, and the file says which release it was computed against.
 *
 * Fixtures are written out, not generated from the aggregator — an export test that
 * builds its own input from the code under test proves only that the code agrees
 * with itself.
 */

function row(over: Partial<LedgerRow> & Pick<LedgerRow, "name" | "weight">): LedgerRow {
  return {
    company_id: "c_0001018724",
    ticker: "AMZN",
    // The benchmark comparison is required on a row: `null` is "no benchmark in this
    // release", which is a different statement from a zero (ADR-0015).
    benchmark_weight: null,
    // Geography is its own channel and it is not a CSV column: the export's shape is
    // unchanged by it, so a row here says "no answer" and the file says nothing.
    country: null,
    holder_count: 1,
    held_directly: false,
    sources: [],
    ...over,
  };
}

function ledgerOf(rows: LedgerRow[]): Ledger {
  return withEffective({
    rows,
    metrics: {
      hhi: null,
      effective_n: null,
      top10: null,
      covered_weight_pct: 98,
      resolved_weight: 1,
      suppressed_weight: 0,
      invested_weight: 1,
      cash_weight: 0,
      unallocated_weight: 0,
    },
    funds: [],
    benchmark: null,
    oldest_as_of: "2026-06-30",
    max_lag_days: 120,
    unmapped: {
      positions: 0,
      positions_with_weight: 0,
      securities_with_weight: 0,
      securities_weight: 0,
      cash_and_derivatives_with_weight: 0,
      cash_and_derivatives_weight: 0,
    },
  });
}

describe("ledgerCsv", () => {
  it("writes the columns in the order the header declares", () => {
    const csv = ledgerCsv(ledgerOf([row({ name: "AMAZON COM INC", weight: 0.1205 })]), {
      as_of: "2026-11-02.1",
    });
    const [header, first] = csv.trimEnd().split("\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    // Weight is a percentage with the page's two decimals, not the fraction.
    expect(first).toBe("c_0001018724,AMAZON COM INC,AMZN,12.05,no,1,,2026-11-02.1");
  });

  it("names both contributions to a company the visitor holds directly", () => {
    const csv = ledgerCsv(
      ledgerOf([
        row({
          name: "AMAZON COM INC",
          weight: 0.1205,
          held_directly: true,
          sources: [
            { kind: "security", ref: "AMZN", weight: 0.1 },
            { kind: "fund", ref: "VT", weight: 0.0205 },
          ],
        }),
      ]),
      { as_of: "2026-11-02.1" },
    );
    const [, first] = csv.trimEnd().split("\n");
    expect(first).toContain(",yes,1,You 10.00%; VT 2.05%,");
  });

  it("quotes a company name that contains a comma, and doubles a quote", () => {
    const csv = ledgerCsv(
      ledgerOf([row({ name: 'BERKSHIRE HATHAWAY INC, "CLASS B"', weight: 0.01 })]),
      { as_of: "2026-11-02.1" },
    );
    const [, first] = csv.trimEnd().split("\n");
    expect(first).toContain('"BERKSHIRE HATHAWAY INC, ""CLASS B"""');
  });

  it("leaves a missing ticker empty rather than writing a placeholder", () => {
    const csv = ledgerCsv(
      ledgerOf([row({ name: "AN ISSUER", ticker: null, weight: 0.01 })]),
      {
        as_of: "2026-11-02.1",
      },
    );
    const [, first] = csv.trimEnd().split("\n");
    expect(first).toBe("c_0001018724,AN ISSUER,,1.00,no,1,,2026-11-02.1");
  });

  it("ends with a newline and repeats the release on every row", () => {
    const csv = ledgerCsv(
      ledgerOf([row({ name: "A", weight: 0.1 }), row({ name: "B", weight: 0.2 })]),
      { as_of: "2026-11-02.1" },
    );
    expect(csv.endsWith("\n")).toBe(true);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) expect(line.endsWith(",2026-11-02.1")).toBe(true);
  });

  it("writes a header and nothing else for an empty ledger", () => {
    expect(ledgerCsv(ledgerOf([]), { as_of: "2026-11-02.1" })).toBe(
      `${CSV_COLUMNS.join(",")}\n`,
    );
  });
});

describe("ledgerCsvName", () => {
  it("carries the export date and the release", () => {
    expect(ledgerCsvName(new Date("2026-11-02T18:00:00Z"), "2026-11-02.1")).toBe(
      "unpackfund-ledger-2026-11-02-2026-11-02.1.csv",
    );
  });

  it("keeps the filename safe when a release stamp is not", () => {
    expect(ledgerCsvName(new Date("2026-11-02T18:00:00Z"), "a/b c")).toBe(
      "unpackfund-ledger-2026-11-02-a_b_c.csv",
    );
  });
});
