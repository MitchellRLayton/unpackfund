import { describe, expect, it } from "vitest";

import { formatDollarsCompact } from "./money";

describe("formatDollarsCompact", () => {
  it("keeps the unit a reader scans for", () => {
    expect(formatDollarsCompact(278_318_309)).toBe("$278.3M");
    expect(formatDollarsCompact(65_400_000_000)).toBe("$65.4B");
    expect(formatDollarsCompact(1_240_000_000_000)).toBe("$1.24T");
    expect(formatDollarsCompact(1_240_000)).toBe("$1.2M");
  });

  it("drops a trailing zero rather than printing precision it does not have", () => {
    expect(formatDollarsCompact(1_000_000)).toBe("$1M");
    expect(formatDollarsCompact(300_000_000)).toBe("$300M");
    expect(formatDollarsCompact(1_000_000_000)).toBe("$1B");
  });

  it("prints small numbers in full", () => {
    expect(formatDollarsCompact(9_000)).toBe("$9K");
    expect(formatDollarsCompact(940)).toBe("$940");
    expect(formatDollarsCompact(0)).toBe("$0");
  });

  it("rounds to the unit's precision", () => {
    expect(formatDollarsCompact(278_349_999)).toBe("$278.3M");
    expect(formatDollarsCompact(278_950_000)).toBe("$279M");
  });

  it("refuses a value it cannot print", () => {
    expect(formatDollarsCompact(Number.NaN)).toBe("—");
    expect(formatDollarsCompact(-1)).toBe("—");
  });
});
