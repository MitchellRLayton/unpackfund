import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioBuilder } from "@/components/PortfolioBuilder";
import { write } from "@/lib/fragment-store";
import type { ReleaseDescriptor } from "@/lib/types";

/**
 * The builder's destructive control has one job: never lose a portfolio by a
 * misclick. These tests drive the real hook and the real URL fragment, not a
 * stand-in, because the fragment is the only state store — an Undo that wrote
 * somewhere else would pass a mock and fail a visitor.
 */

const { release } = vi.hoisted(() => ({
  release: { as_of: "2026-10-30.8", objects: {} } as unknown as ReleaseDescriptor,
}));

vi.mock("@/lib/use-release", () => ({
  useRelease: () => ({ status: "ready", data: release, error: null }),
  useTickers: () => ({
    status: "ready",
    data: ["QQQ", "VTI", "VTV", "VEA", "VWO"],
    error: null,
  }),
}));

beforeEach(() => {
  write([]);
});

afterEach(() => {
  cleanup();
});

describe("PortfolioBuilder — Remove all", () => {
  it("empties the portfolio and offers the removed funds back", () => {
    render(<PortfolioBuilder />);

    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));
    // A chip also carries the ticker text, so the row is asserted by its control.
    expect(screen.getByRole("button", { name: "Remove QQQ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    expect(window.location.hash).not.toBe("");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove all funds from the portfolio" }),
    );

    expect(screen.getByText("Portfolio cleared")).toBeTruthy();
    expect(screen.getByText(/Removed 2 funds/)).toBeTruthy();
    expect(screen.getByText(/Nothing added yet/)).toBeTruthy();
    // The URL is the portfolio: if it still names funds, the clear did nothing.
    expect(window.location.hash).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.queryByText("Portfolio cleared")).toBeNull();
    // A chip also carries the ticker text, so the row is asserted by its control.
    expect(screen.getByRole("button", { name: "Remove QQQ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
    expect(screen.getByText("100.00%")).toBeTruthy();
    expect(window.location.hash).not.toBe("");
  });

  it("drops the undo offer once a new fund is added", () => {
    render(<PortfolioBuilder />);

    fireEvent.click(screen.getByRole("button", { name: "Add QQQ" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all funds from the portfolio" }),
    );
    expect(screen.getByText("Portfolio cleared")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add VTI" }));

    expect(screen.queryByText("Portfolio cleared")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove VTI" })).toBeTruthy();
  });
});
