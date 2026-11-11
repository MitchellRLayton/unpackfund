import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  benchmarkFromSearch,
  benchmarkSearch,
  resetBenchmarkPreference,
  useBenchmarkPreference,
} from "./benchmark-preference";

/**
 * The benchmark in the URL.
 *
 * The choice is a view, so the tests are about the three things a reader can check: the
 * query string names the fund (and is absent for the default), a shared link opens on the
 * fund it names, and the store the workspace and the picker share cannot disagree.
 */

describe("the benchmark in the query string", () => {
  it("reads the five names case-insensitively and refuses others", () => {
    expect(benchmarkFromSearch("?bench=voo")).toBe("VOO");
    expect(benchmarkFromSearch("?bench=IEMG")).toBe("IEMG");
    expect(benchmarkFromSearch("?cls=ftse&bench=idev")).toBe("IDEV");
    expect(benchmarkFromSearch("?bench=spy")).toBeNull();
    expect(benchmarkFromSearch("?cls=ftse")).toBeNull();
    expect(benchmarkFromSearch("")).toBeNull();
  });

  it("writes the choice, removes the default, and keeps every other parameter", () => {
    expect(benchmarkSearch("", "VOO")).toBe("?bench=voo");
    expect(benchmarkSearch("?bench=vti", "VOO")).toBe("?bench=voo");
    expect(benchmarkSearch("?cls=ftse", "IEMG")).toBe("?cls=ftse&bench=iemg");
    // VT is the default, so it is never written: the plain URL is the default URL.
    expect(benchmarkSearch("?bench=voo", "VT")).toBe("");
    expect(benchmarkSearch("?bench=voo&cls=ftse", "VT")).toBe("?cls=ftse");
  });
});

describe("the preference store", () => {
  beforeEach(() => {
    resetBenchmarkPreference();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    resetBenchmarkPreference();
  });

  it("starts on VT, writes a pick, and clears it back to VT", () => {
    const { result } = renderHook(() => useBenchmarkPreference());
    expect(result.current.benchmark).toBe("VT");

    act(() => result.current.setBenchmark("VOO"));
    expect(result.current.benchmark).toBe("VOO");
    expect(window.location.search).toBe("?bench=voo");

    act(() => result.current.setBenchmark("VT"));
    expect(result.current.benchmark).toBe("VT");
    expect(window.location.search).toBe("");
  });

  it("opens a shared link on the benchmark it names, fragment untouched", () => {
    window.history.replaceState({}, "", "/?bench=iemg#v3.abc");
    const { result } = renderHook(() => useBenchmarkPreference());
    expect(result.current.benchmark).toBe("IEMG");
    expect(window.location.hash).toBe("#v3.abc");
  });
});
