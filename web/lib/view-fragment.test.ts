import { describe, expect, it } from "vitest";

import { encodePortfolio } from "./fragment";
import { encodeView, parseView, portfolioPart } from "./view-fragment";
import type { Portfolio } from "./types";

/**
 * A fragment may carry a company, a portfolio and a lens, joined by `~`. The portfolio part is
 * recognised by its version prefix, so a version the codec writes must also be one this file
 * recognises: v4 (a fund entered by its share class) was written for a day before this list
 * learned it, and the link then opened as "no portfolio" with no error.
 */
const withClass: Portfolio = {
  mode: "bp",
  entries: [
    { kind: "fund", key: "VOO", amount: 6000, cls: "VFIAX" },
    { kind: "fund", key: "VTI", amount: 4000 },
  ],
};
const without: Portfolio = {
  mode: "bp",
  entries: [{ kind: "fund", key: "VOO", amount: 10000 }],
};

describe("the portfolio part of a view fragment", () => {
  it.each([
    ["v3", without],
    ["v4", withClass],
  ])("finds a %s portfolio and reads it back exactly", (version, portfolio) => {
    const hash = `#${encodePortfolio(portfolio)}`;
    expect(hash.startsWith(`#${version}.`)).toBe(true);
    expect(portfolioPart(hash)).toBe(hash.slice(1));
    expect(parseView(hash).portfolio).toEqual(portfolio);
  });

  it("reads a v4 portfolio between a company and a lens", () => {
    const hash = `#c_0000320193~${encodePortfolio(withClass)}~markets`;
    const view = parseView(hash);
    expect(view).toMatchObject({
      companyId: "c_0000320193",
      lens: "markets",
      problem: null,
    });
    expect(view.portfolio).toEqual(withClass);
  });

  it("round-trips a class portfolio and a lens through encodeView", () => {
    const hash = encodeView({ portfolio: withClass, lens: "funds" });
    expect(parseView(`#${hash}`)).toMatchObject({ lens: "funds", portfolio: withClass });
  });

  it("still reports a damaged v4 part rather than ignoring it", () => {
    expect(parseView("#v4.not-base64!").problem).toBe("malformed");
  });
});
