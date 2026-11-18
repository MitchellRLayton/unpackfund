import { describe, expect, it } from "vitest";

import { COMPANY_ID_PATTERN, isCompanyId } from "./types";
import { parseView } from "./view-fragment";

/** One valid id per namespace. Synthetic: the hex is not any real LEI's or FIGI's hash. */
const SEC = "c_0000320193";
const ISSUER = "l_0123456789abcdef";
const SECURITY = "f_fedcba9876543210";

describe("company ids", () => {
  it("accepts all three namespaces", () => {
    for (const id of [SEC, ISSUER, SECURITY]) {
      expect(isCompanyId(id)).toBe(true);
    }
  });

  it("refuses anything that is not exactly one namespace's shape", () => {
    const bad = [
      "",
      null,
      undefined,
      "x_0123456789abcdef", // no such namespace
      "f_0123456789abcde", // 15 hex
      "f_0123456789abcdef0", // 17 hex
      "f_0123456789ABCDEF", // upper-case hex
      "f_0123456789abcdeg", // not hex
      "c_123", // short CIK
      "l_0123456789abcdef ", // trailing space
    ];
    for (const id of bad) {
      expect(isCompanyId(id as string | null | undefined)).toBe(false);
    }
  });

  it("is the one pattern: the URL-fragment parser reads f_ ids through it", () => {
    expect(COMPANY_ID_PATTERN.test(SECURITY)).toBe(true);
    expect(parseView(`#${SECURITY}`).companyId).toBe(SECURITY);
    expect(parseView(`#${ISSUER}`).companyId).toBe(ISSUER);
    expect(parseView(`#${SEC}`).companyId).toBe(SEC);
    expect(parseView("#f_nothex0123456789").companyId).toBeNull();
  });
});
