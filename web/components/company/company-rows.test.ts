import { describe, expect, it } from "vitest";

import type { Catalogue, CompanyIndex, CompanyShard, Ledger } from "@/lib/types";

import {
  companyAriaSort,
  companyCountry,
  companyFundRows,
  companyOrderDescription,
  DEFAULT_COMPANY_ORDER,
  holdingLine,
  nextCompanyOrder,
  orderCompanyRows,
  searchCompanyRows,
  toCompanyRows,
} from "./company-rows";

const INDEX: CompanyIndex = {
  as_of: "2026-11-03",
  companies: [
    ["c_0000001750", "AAR CORP", "AIR", 620],
    ["c_0001652044", "ALPHABET INC.", "GOOGL", 2991],
    ["c_0001018724", "AMAZON.COM, INC.", "AMZN", 2779],
    ["l_0123456789abcdef", "PRIVATE HOLDING CO", null, 3],
  ],
};

const COUNTRIES: Record<string, string> = {
  c_0000001750: "US",
  c_0001652044: "US",
  c_0001018724: "US",
};

const SHARD: CompanyShard = {
  as_of: "2026-11-03",
  company_id: "c_0001652044",
  name: "ALPHABET INC.",
  ticker: "GOOGL",
  country: "US",
  funds: [
    ["VTI", 312],
    ["FXAIX", 500],
    ["VNQ", 120],
    ["ZZZZ", 120],
  ],
};

const CATALOGUE: Catalogue = {
  as_of: "2026-11-03",
  funds: {
    VTI: ["Vanguard Total Stock Market ETF", "Vanguard", 1, 99.4, 1_000_000],
    FXAIX: ["Fidelity 500 Index Fund", "Fidelity", 0, 96.1],
    VNQ: ["Vanguard Real Estate ETF", "Vanguard", 1, 88.2],
  },
};

describe("toCompanyRows", () => {
  it("keeps the index order it was given and joins the country map", () => {
    const rows = toCompanyRows(INDEX, COUNTRIES);
    expect(rows.map((row) => row.id)).toEqual(INDEX.companies.map(([id]) => id));
    expect(rows[0]).toEqual({
      id: "c_0000001750",
      name: "AAR CORP",
      ticker: "AIR",
      holders: 620,
      country: "US",
    });
  });

  it("leaves every country null until the map has loaded", () => {
    expect(toCompanyRows(INDEX, null).every((row) => row.country === null)).toBe(true);
  });

  it("is empty without an index", () => {
    expect(toCompanyRows(null, COUNTRIES)).toEqual([]);
  });

  it("does not invent a country for a company the map does not name", () => {
    const rows = toCompanyRows(INDEX, COUNTRIES);
    expect(rows.find((row) => row.id === "l_0123456789abcdef")?.country).toBeNull();
  });
});

describe("orderCompanyRows", () => {
  const rows = toCompanyRows(INDEX, COUNTRIES);

  it("opens alphabetically by name", () => {
    expect(orderCompanyRows(rows, DEFAULT_COMPANY_ORDER).map((row) => row.name)).toEqual([
      "AAR CORP",
      "ALPHABET INC.",
      "AMAZON.COM, INC.",
      "PRIVATE HOLDING CO",
    ]);
  });

  it("sorts the widest holder count first when asked for descending", () => {
    expect(
      orderCompanyRows(rows, { key: "holders", direction: "descending" }).map(
        (row) => row.holders,
      ),
    ).toEqual([2991, 2779, 620, 3]);
  });

  it("keeps a company with no ticker at the end in both directions", () => {
    for (const direction of ["ascending", "descending"] as const) {
      const ordered = orderCompanyRows(rows, { key: "ticker", direction });
      expect(ordered[ordered.length - 1]?.ticker).toBeNull();
    }
  });

  it("breaks ties on the company id, so the order is stable across renders", () => {
    const tied = [
      { id: "c_0000000002", name: "SAME", ticker: "S", holders: 5, country: "US" },
      { id: "c_0000000001", name: "SAME", ticker: "S", holders: 5, country: "US" },
    ];
    expect(
      orderCompanyRows(tied, { key: "holders", direction: "descending" }).map(
        (row) => row.id,
      ),
    ).toEqual(["c_0000000001", "c_0000000002"]);
  });

  it("keeps the search's own order for a closest-match table", () => {
    const ranked = [...rows].reverse();
    expect(orderCompanyRows(ranked, { key: "match" }).map((row) => row.id)).toEqual(
      ranked.map((row) => row.id),
    );
  });

  it("does not mutate the rows it was given", () => {
    const before = rows.map((row) => row.id);
    orderCompanyRows(rows, { key: "holders", direction: "descending" });
    expect(rows.map((row) => row.id)).toEqual(before);
  });
});

describe("nextCompanyOrder", () => {
  it("flips the direction of the column already sorted", () => {
    expect(nextCompanyOrder(DEFAULT_COMPANY_ORDER, "name")).toEqual({
      key: "name",
      direction: "descending",
    });
  });

  it("starts a new column in its natural direction", () => {
    expect(nextCompanyOrder(DEFAULT_COMPANY_ORDER, "holders")).toEqual({
      key: "holders",
      direction: "descending",
    });
    expect(nextCompanyOrder(DEFAULT_COMPANY_ORDER, "country")).toEqual({
      key: "country",
      direction: "ascending",
    });
  });
});

describe("companyAriaSort", () => {
  it("reports the direction only for the sorted column", () => {
    const order = { key: "holders", direction: "descending" } as const;
    expect(companyAriaSort(order, "holders")).toBe("descending");
    expect(companyAriaSort(order, "name")).toBeUndefined();
    expect(companyAriaSort({ key: "match" }, "name")).toBeUndefined();
  });
});

describe("companyOrderDescription", () => {
  it("says which column and which direction in words", () => {
    expect(companyOrderDescription(DEFAULT_COMPANY_ORDER)).toBe("by company name");
    expect(companyOrderDescription({ key: "holders", direction: "descending" })).toBe(
      "by how many funds hold it, most first",
    );
    expect(companyOrderDescription({ key: "ticker", direction: "ascending" })).toBe(
      "by ticker, ascending",
    );
    expect(companyOrderDescription({ key: "match" })).toBe("closest match first");
  });
});

describe("searchCompanyRows", () => {
  const rows = toCompanyRows(INDEX, COUNTRIES);

  it("returns every row for an empty query", () => {
    expect(searchCompanyRows(rows, "   ")).toHaveLength(rows.length);
  });

  it("ranks a ticker prefix ahead of a name substring", () => {
    const ids = searchCompanyRows(rows, "A").map((row) => row.id);
    expect(ids[ids.length - 1]).toBe("l_0123456789abcdef");
    expect(ids).toHaveLength(rows.length);
  });

  it("matches the words of a name in any order", () => {
    expect(searchCompanyRows(rows, "alphabet inc").map((row) => row.id)).toEqual([
      "c_0001652044",
    ]);
    expect(searchCompanyRows(rows, "inc alphabet").map((row) => row.id)).toEqual([
      "c_0001652044",
    ]);
  });

  it("requires every word", () => {
    expect(searchCompanyRows(rows, "alphabet amazon")).toEqual([]);
  });

  it("finds a company by its ticker", () => {
    expect(searchCompanyRows(rows, "amzn").map((row) => row.id)).toEqual([
      "c_0001018724",
    ]);
  });
});

describe("companyFundRows", () => {
  it("orders the funds by their weight in the company, largest first", () => {
    expect(companyFundRows(SHARD, CATALOGUE).map((row) => row.ticker)).toEqual([
      "FXAIX",
      "VTI",
      "VNQ",
      "ZZZZ",
    ]);
  });

  it("names the funds from the catalogue and carries their coverage", () => {
    const [first] = companyFundRows(SHARD, CATALOGUE);
    expect(first).toEqual({
      ticker: "FXAIX",
      name: "Fidelity 500 Index Fund",
      weightBp: 500,
      coverage: 96.1,
    });
  });

  it("falls back to the ticker for a fund the catalogue does not know", () => {
    const row = companyFundRows(SHARD, CATALOGUE).find(
      (entry) => entry.ticker === "ZZZZ",
    );
    expect(row).toEqual({ ticker: "ZZZZ", name: "ZZZZ", weightBp: 120, coverage: null });
  });

  it("is empty without a shard", () => {
    expect(companyFundRows(null, CATALOGUE)).toEqual([]);
  });
});

describe("holdingLine", () => {
  const ledger = {
    rows: [
      {
        company_id: "c_0001652044",
        name: "ALPHABET INC.",
        weight: 0.0421,
        holder_count: 2,
      },
      { company_id: "c_0000001750", name: "AAR CORP", weight: 0, holder_count: 0 },
    ],
  } as unknown as Ledger;

  it("reads the company's share out of the ledger", () => {
    expect(holdingLine(ledger, "c_0001652044")).toEqual({ weight: 0.0421, funds: 2 });
  });

  it("says nothing for a company the portfolio does not hold", () => {
    expect(holdingLine(ledger, "c_0001018724")).toBeNull();
  });

  it("says nothing for a zero weight", () => {
    expect(holdingLine(ledger, "c_0000001750")).toBeNull();
  });

  it("says nothing before the ledger exists", () => {
    expect(holdingLine(null, "c_0001652044")).toBeNull();
  });
});

describe("companyCountry", () => {
  it("prefers the shard's own answer", () => {
    expect(companyCountry(SHARD, "c_0001652044", { c_0001652044: "IE" })).toBe("US");
  });

  it("falls back to the release's country map", () => {
    expect(companyCountry(null, "c_0001652044", { c_0001652044: "IE" })).toBe("IE");
  });

  it("returns null when neither has an answer", () => {
    expect(companyCountry(null, "c_0001652044", null)).toBeNull();
  });
});
