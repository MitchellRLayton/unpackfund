import { describe, expect, it } from "vitest";

import { clampPage, PAGE_SIZE, pageCount, pageOf } from "@/components/directory/paging";

const rows = Array.from({ length: 130 }, (_, index) => index + 1);

describe("pageCount", () => {
  it("counts whole pages, rounding the last one up", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(1)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(9112)).toBe(183);
  });

  it("is at least one page even for a nonsense total", () => {
    expect(pageCount(-4)).toBe(1);
    expect(pageCount(Number.NaN)).toBe(1);
  });
});

describe("clampPage", () => {
  it("keeps a page inside the list", () => {
    expect(clampPage(0, 130)).toBe(1);
    expect(clampPage(1, 130)).toBe(1);
    expect(clampPage(3, 130)).toBe(3);
    expect(clampPage(99, 130)).toBe(3);
    expect(clampPage(1, 0)).toBe(1);
  });

  it("truncates a fractional page", () => {
    expect(clampPage(2.9, 130)).toBe(2);
  });
});

describe("pageOf", () => {
  it("returns the first page with a 1-based display range", () => {
    const page = pageOf(rows, 1);
    expect(page.rows).toHaveLength(PAGE_SIZE);
    expect(page.rows[0]).toBe(1);
    expect(page.start).toBe(1);
    expect(page.end).toBe(50);
    expect(page.pages).toBe(3);
    expect(page.total).toBe(130);
  });

  it("returns a short last page and its true range", () => {
    const page = pageOf(rows, 3);
    expect(page.rows).toHaveLength(30);
    expect(page.rows[0]).toBe(101);
    expect(page.start).toBe(101);
    expect(page.end).toBe(130);
  });

  it("clamps a page past the end instead of returning nothing", () => {
    const page = pageOf(rows, 40);
    expect(page.page).toBe(3);
    expect(page.end).toBe(130);
  });

  it("describes an empty list as page 1 of 1 with no range", () => {
    const page = pageOf<number>([], 2);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.pages).toBe(1);
    expect(page.start).toBe(0);
    expect(page.end).toBe(0);
    expect(page.total).toBe(0);
  });
});
