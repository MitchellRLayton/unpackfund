import { describe, expect, it } from "vitest";

import { displayName } from "./provider-name";

/**
 * Every case below is a rule from the module's header, not a sample of output: the
 * filing strings are real shapes (Vanguard's trust files in caps, iShares in mixed
 * case, State Street parenthesises its trademark), and a change that re-cases one of
 * them is a change to a name.
 *
 * The wiki-cased result is what the directory prints — `lib/directory.ts` is the only
 * caller — so these expectations are also what a reader sees on `/funds`.
 */
describe("displayName", () => {
  it("title-cases an all-caps filing name", () => {
    expect(displayName("VANGUARD INDEX FUNDS")).toBe("Vanguard Index Funds");
    expect(displayName("VANGUARD TOTAL STOCK MARKET ETF")).toBe(
      "Vanguard Total Stock Market ETF",
    );
  });

  it("leaves an authored mixed-case name whole", () => {
    // One lower-case letter means the registrant presented the name; re-casing it
    // word by word is how `EA` becomes `Ea` and `DWS` becomes `Dws`, so the whole
    // string is returned. These are real issuer and fund strings from the release.
    expect(displayName("iShares Trust")).toBe("iShares Trust");
    expect(displayName("EA Series Trust")).toBe("EA Series Trust");
    expect(displayName("DWS RREEF Real Assets Fund")).toBe("DWS RREEF Real Assets Fund");
    expect(displayName("SPDR S&P 500 ETF Trust")).toBe("SPDR S&P 500 ETF Trust");
  });

  it("keeps the trademark and initialism punctuation", () => {
    expect(displayName("S&P")).toBe("S&P");
    expect(displayName("S&P 500 INDEX FUND")).toBe("S&P 500 Index Fund");
    expect(displayName("U.S.")).toBe("U.S.");
    expect(displayName("VANGUARD U.S. LARGE CAP")).toBe("Vanguard U.S. Large Cap");
  });

  it("keeps every listed acronym upper case", () => {
    expect(displayName("ETF")).toBe("ETF");
    expect(displayName("ETFS")).toBe("ETFS");
    expect(displayName("AI")).toBe("AI");
    expect(displayName("REIT")).toBe("REIT");
    expect(displayName("MLP")).toBe("MLP");
    expect(displayName("BDC")).toBe("BDC");
    expect(displayName("ADR")).toBe("ADR");
    expect(displayName("ESG")).toBe("ESG");
    expect(displayName("SPDR")).toBe("SPDR");
    expect(displayName("USD")).toBe("USD");
    expect(displayName("II")).toBe("II");
    expect(displayName("III")).toBe("III");
    expect(displayName("IV")).toBe("IV");
    // A compound built only from acronyms keeps both halves.
    expect(displayName("REIT-ETF")).toBe("REIT-ETF");
  });

  it("keeps parenthesised text exactly as filed", () => {
    expect(displayName("State Street(R) SPDR(R)")).toBe("State Street(R) SPDR(R)");
    expect(displayName("FUND (THE TRUST)")).toBe("Fund (THE TRUST)");
    expect(displayName("VANGUARD (LARGE-CAP) INDEX")).toBe("Vanguard (LARGE-CAP) Index");
  });

  it("leaves numbers alone", () => {
    expect(displayName("VANGUARD 500 INDEX FUND")).toBe("Vanguard 500 Index Fund");
    expect(displayName("500")).toBe("500");
  });

  it("capitalises the second half of a hyphenated or slashed word", () => {
    expect(displayName("LARGE-CAP")).toBe("Large-Cap");
    expect(displayName("SMALL/MID CAP")).toBe("Small/Mid Cap");
  });

  it("handles an empty or punctuation-only name without inventing one", () => {
    expect(displayName("")).toBe("");
    expect(displayName("—")).toBe("—");
  });
});
