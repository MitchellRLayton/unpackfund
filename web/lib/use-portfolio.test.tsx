import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodePortfolio } from "./fragment";
import { write } from "./fragment-store";
import { usePortfolio, type AddOutcome, type PortfolioState } from "./use-portfolio";

/**
 * The portfolio hook against the real fragment store.
 *
 * The store is not mocked, on purpose: the fragment is the only place a portfolio
 * lives, so a test that stood in for it would prove nothing about what a reload or a
 * shared link sees. Each test starts by writing an empty percent portfolio — the same
 * state a visitor arrives in — and asserts the URL as well as the hook, because those
 * two agreeing is the whole contract.
 *
 * What is pinned here is the operator's complaint of 2026-11-11: removing one of five
 * equal rows left the remaining four at 20% each — 80%, and nothing rescaled them.
 * `add` and `remove` now follow one rule, decided by one predicate: a list the app
 * itself spread evenly is re-spread, and a list the visitor weighted by hand keeps
 * every amount it has. `equalise` is the way back to the even split.
 *
 * One mutation per `act`: each writer closes over the entries of its own render, so
 * two writes inside one `act` block would both read the same stale list and the second
 * would drop the first. That is the hook's documented shape — one write per change —
 * not a workaround.
 */

type Hook = { current: PortfolioState };

/** Add funds one at a time, each write landing before the next render decides. */
function addFunds(hook: Hook, keys: readonly string[]): void {
  for (const key of keys) {
    act(() => {
      hook.current.add("fund", key);
    });
  }
}

const amounts = (hook: Hook): number[] =>
  hook.current.entries.map((entry) => entry.amount);

/** The portfolio as the URL carries it: the store of record, decoded. */
function stored(): number[] {
  const decoded = decodePortfolio(window.location.hash);
  if (!decoded.ok) throw new Error(`the fragment did not decode: ${decoded.reason}`);
  return decoded.portfolio.entries.map((entry) => entry.amount);
}

beforeEach(() => {
  // The store caches one snapshot, so writing an empty percent portfolio is the reset.
  write({ mode: "bp", entries: [] });
});

afterEach(() => {
  cleanup();
});

describe("adding funds", () => {
  it("splits five funds evenly: 2,000bp each, 10,000 in total", () => {
    const view = renderHook(() => usePortfolio());

    addFunds(view.result, ["VTI", "VXUS", "BND", "VNQ", "GLD"]);

    expect(amounts(view.result)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(view.result.current.total).toBe(10_000);
    expect(view.result.current.complete).toBe(true);
    // The URL is the portfolio: the numbers on screen are the ones a reload sees.
    expect(stored()).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  });
});

describe("removing a row", () => {
  it("re-spreads an even split: four rows at 2,500bp, back to 10,000", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS", "BND", "VNQ", "GLD"]);

    act(() => {
      view.result.current.remove("fund", "BND");
    });

    // Order is the visitor's, so the row that left is the only one that moves.
    expect(view.result.current.entries.map((entry) => entry.key)).toEqual([
      "VTI",
      "VXUS",
      "VNQ",
      "GLD",
    ]);
    expect(amounts(view.result)).toEqual([2_500, 2_500, 2_500, 2_500]);
    expect(view.result.current.total).toBe(10_000);
    expect(view.result.current.complete).toBe(true);
    expect(stored()).toEqual([2_500, 2_500, 2_500, 2_500]);
  });

  it("leaves hand-set amounts alone when a fund is added, and the new row arrives at 0", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS"]);
    act(() => {
      view.result.current.setAmount("fund", "VTI", 4_000);
    });

    let outcome: AddOutcome = "noop";
    act(() => {
      outcome = view.result.current.add("fund", "BND");
    });

    expect(outcome).toBe("kept");
    expect(amounts(view.result)).toEqual([4_000, 5_000, 0]);
    expect(view.result.current.total).toBe(9_000);
    expect(view.result.current.unallocatedBp).toBe(1_000);
    expect(view.result.current.complete).toBe(false);
  });

  it("leaves every amount alone when a hand-weighted portfolio loses a row", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS", "BND"]); // 3,334 / 3,333 / 3,333
    act(() => {
      view.result.current.setAmount("fund", "VXUS", 1_000);
    });

    act(() => {
      view.result.current.remove("fund", "BND");
    });

    expect(amounts(view.result)).toEqual([3_334, 1_000]);
    expect(view.result.current.total).toBe(4_334);
    expect(view.result.current.complete).toBe(false);
    // The shortfall stays stated, not spread: the pane's sentence names it.
    expect(view.result.current.unallocatedBp).toBe(5_666);
  });

  it("decides on the list before the row leaves, not on what remains", () => {
    // 60 / 20 / 20 is whole but typed by hand, so nothing may be re-spread. What is
    // left after removing the 60 happens to look like an even split, which is exactly
    // why the predicate reads the list *before* the removal: checking afterwards would
    // rescale 20/20 into 50/50 — two numbers the visitor never typed.
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS", "BND"]);
    act(() => {
      view.result.current.setAmount("fund", "VTI", 6_000);
    });
    act(() => {
      view.result.current.setAmount("fund", "VXUS", 2_000);
    });
    act(() => {
      view.result.current.setAmount("fund", "BND", 2_000);
    });
    expect(amounts(view.result)).toEqual([6_000, 2_000, 2_000]);

    act(() => {
      view.result.current.remove("fund", "VTI");
    });

    expect(amounts(view.result)).toEqual([2_000, 2_000]);
    expect(view.result.current.total).toBe(4_000);
  });
});

describe("equalise", () => {
  it("returns a hand-weighted set to exactly 10,000, spread evenly", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS", "BND", "VNQ"]); // 2,500 each
    act(() => {
      view.result.current.setAmount("fund", "VTI", 4_000);
    });
    act(() => {
      view.result.current.setAmount("fund", "VXUS", 1_000);
    });
    // Whole, but the visitor's — not an even split, so nothing rescales it by itself.
    expect(view.result.current.total).toBe(10_000);

    act(() => {
      view.result.current.equalise();
    });

    expect(amounts(view.result)).toEqual([2_500, 2_500, 2_500, 2_500]);
    expect(view.result.current.total).toBe(10_000);
    expect(view.result.current.complete).toBe(true);
    expect(stored()).toEqual([2_500, 2_500, 2_500, 2_500]);
  });

  it("brings a short set back to 10,000 too", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS", "BND"]); // 3,334 / 3,333 / 3,333
    act(() => {
      view.result.current.setAmount("fund", "VTI", 1_000);
    });
    expect(view.result.current.total).toBe(7_666);
    expect(view.result.current.complete).toBe(false);

    act(() => {
      view.result.current.equalise();
    });

    expect(amounts(view.result)).toEqual([3_334, 3_333, 3_333]);
    expect(view.result.current.total).toBe(10_000);
    expect(view.result.current.complete).toBe(true);
  });

  it("writes nothing in dollar mode: those amounts are the visitor's money", () => {
    const view = renderHook(() => usePortfolio());
    addFunds(view.result, ["VTI", "VXUS"]); // 5,000bp each
    act(() => {
      view.result.current.setMode("usd");
    });
    expect(view.result.current.mode).toBe("usd");
    act(() => {
      view.result.current.setAmount("fund", "VTI", 600_000); // $6,000.00
    });
    act(() => {
      view.result.current.setAmount("fund", "VXUS", 400_000); // $4,000.00
    });

    act(() => {
      view.result.current.equalise();
    });

    // The Equal weight button is percent-only; the hook refuses rather than inventing
    // two $5,000 balances out of the visitor's own dollars.
    expect(amounts(view.result)).toEqual([600_000, 400_000]);
  });
});
