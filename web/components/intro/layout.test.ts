/**
 * The film's geometry: where the two words sit, how the scan moves, and how a dot finds its
 * label.
 *
 * The film cannot be judged frame by frame in a test, but the arithmetic that a frame is made
 * of can be. Three properties matter most: the word is 60% of the frame on a laptop and 80%
 * on a phone (the brief's one hard size rule); the scan is fast–slow–fast and monotonic, or
 * the counter it drives runs backwards; and a label lands on the right dot, because "the 12
 * largest companies get labels as the bar passes" is a factual claim about the picture, not a
 * decoration.
 */

import { describe, expect, it } from "vitest";

import {
  FALLBACK_METRICS,
  capField,
  edgeDot,
  isPortrait,
  labelAnchors,
  labelBudget,
  layoutFilm,
  scanEase,
  timeForScan,
} from "./layout";
import { RECORD_FLOATS, type Caption, type DotField } from "./types";

const LAPTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function caption(overrides: Partial<Caption> = {}): Caption {
  return {
    schema: 1,
    release: "2026-10-31",
    generated_at: "2026-11-03T00:00:00.000Z",
    a: {
      ticker: "VTI",
      name: "Vanguard Total Stock Market ETF",
      filed_at: "2026-08-28",
      as_of: "2026-06-30",
      companies: 3639,
    },
    b: {
      ticker: "VOO",
      name: "Vanguard S&P 500 ETF",
      filed_at: "2026-08-27",
      as_of: "2026-06-30",
      companies: 3703,
    },
    shared: 3081,
    labels: [],
    metrics: FALLBACK_METRICS,
    ...overrides,
  };
}

/** A synthetic field: `count` companies, weights rising, positions spread across the word. */
function field(
  count: number,
  weightOf: (index: number) => number = (i) => i + 1,
): DotField {
  const raw = new Float32Array(count * RECORD_FLOATS);
  for (let index = 0; index < count; index += 1) {
    const at = index * RECORD_FLOATS;
    const t = count === 1 ? 0.5 : index / (count - 1);
    raw[at] = weightOf(index);
    raw[at + 1] = 0.02 + t * 1.7;
    raw[at + 2] = -0.3 + t * 0.2;
    raw[at + 3] = Number.NaN;
    raw[at + 4] = Number.NaN;
    raw[at + 5] = t;
    raw[at + 6] = 0;
  }
  return { count, raw };
}

describe("layoutFilm", () => {
  it("gives a laptop a 60%-wide word, centred, with the second word below it", () => {
    const layout = layoutFilm(LAPTOP);
    expect(layout.portrait).toBe(false);
    expect(layout.a.width).toBeCloseTo(LAPTOP.width * 0.6, 6);
    expect(layout.a.left).toBeCloseTo((LAPTOP.width - layout.a.width) / 2, 6);
    expect(layout.b.top).toBeGreaterThan(layout.a.top + layout.a.height);
    expect(layout.b.width).toBeLessThan(layout.a.width);
    expect(layout.axis).toBe("x");
    expect(layout.rule.width).toBeGreaterThan(0);
    expect(layout.rule.top).toBeGreaterThan(layout.a.top);
  });

  it("gives a phone an 80%-wide word and a top-to-bottom scan", () => {
    const layout = layoutFilm(PHONE);
    expect(layout.portrait).toBe(true);
    expect(layout.a.width).toBeCloseTo(PHONE.width * 0.8, 6);
    expect(layout.axis).toBe("y");
    expect(layout.scanStartPct).toBeGreaterThanOrEqual(0);
    expect(layout.scanEndPct).toBeLessThanOrEqual(100);
    expect(layout.scanEndPct).toBeGreaterThan(layout.scanStartPct);
    expect(layout.b.top).toBeGreaterThan(layout.a.top + layout.a.height);
    expect(layout.rule.top).toBeLessThan(PHONE.height);
  });

  it("prefers a measured advance over the baked one", () => {
    const baked = layoutFilm(LAPTOP);
    const measured = layoutFilm(LAPTOP, FALLBACK_METRICS, { a: 2.4 });
    expect(measured.a.fontSize).toBeLessThan(baked.a.fontSize);
    expect(measured.a.width).toBeCloseTo(LAPTOP.width * 0.6, 6);
  });

  it("treats a square-ish frame as landscape and a tall one as portrait", () => {
    expect(isPortrait({ width: 900, height: 900 })).toBe(false);
    expect(isPortrait({ width: 390, height: 844 })).toBe(true);
  });

  it("survives a zero-size viewport, because the film may be measured before layout", () => {
    const layout = layoutFilm({ width: 0, height: 0 });
    expect(Number.isFinite(layout.a.width)).toBe(true);
    expect(layout.a.width).toBeGreaterThan(0);
  });

  it("falls back to a rule under the words when the bake's line is impossible", () => {
    const broken = {
      ...FALLBACK_METRICS,
      rule: { width: 40, y: -900 },
    };
    const layout = layoutFilm(LAPTOP, broken);
    expect(layout.rule.top).toBeGreaterThan(layout.b.top);
    expect(layout.rule.width).toBeGreaterThan(0);
  });
});

describe("scanEase", () => {
  it("starts and ends at the ends", () => {
    expect(scanEase(0)).toBe(0);
    expect(scanEase(1)).toBe(1);
    expect(scanEase(-1)).toBe(0);
    expect(scanEase(2)).toBe(1);
  });

  it("never moves backwards", () => {
    let previous = -1;
    for (let step = 0; step <= 400; step += 1) {
      const value = scanEase(step / 400);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("is fast out of the gate, slow through the middle, and fast into the end", () => {
    const first = (scanEase(0.2) - scanEase(0)) / 0.2;
    const middle = (scanEase(0.6) - scanEase(0.4)) / 0.2;
    const last = (scanEase(1) - scanEase(0.8)) / 0.2;
    expect(first).toBeGreaterThan(middle * 3);
    expect(last).toBeGreaterThan(middle * 3);
  });

  it("is invertible, so a label can be placed where the bar reaches it", () => {
    for (let step = 0; step <= 20; step += 1) {
      const p = step / 20;
      expect(scanEase(timeForScan(p))).toBeCloseTo(p, 6);
    }
    expect(timeForScan(0)).toBe(0);
    expect(timeForScan(1)).toBe(1);
  });
});

describe("capField", () => {
  it("keeps the heaviest companies and maps their old indices", () => {
    const capped = capField(field(10), 4);
    expect(capped.field.count).toBe(4);
    expect(Array.from(capped.field.raw.filter((_, at) => at % 7 === 0))).toEqual([
      7, 8, 9, 10,
    ]);
    expect(Array.from(capped.indexMap)).toEqual([-1, -1, -1, -1, -1, -1, 0, 1, 2, 3]);
  });

  it("leaves a field under the cap untouched", () => {
    const small = field(6);
    const capped = capField(small, 2000);
    expect(capped.field).toBe(small);
    expect(Array.from(capped.indexMap)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("labelAnchors", () => {
  it("joins a label to its dot by the bake's record index", () => {
    const layout = layoutFilm(LAPTOP);
    const labels = [
      { name: "NVIDIA", ticker: "NVDA", weight: 6.21, index: 4 },
      { name: "Apple", ticker: "AAPL", weight: 5.94, index: 1 },
    ];
    const anchors = labelAnchors(field(12), caption({ labels }), layout);
    expect(anchors.map((anchor) => anchor.ticker)).toEqual(["NVDA", "AAPL"]);
    for (const anchor of anchors) {
      expect(anchor.threshold).toBeGreaterThanOrEqual(0);
      expect(anchor.threshold).toBeLessThanOrEqual(1);
      expect(anchor.left).toBeGreaterThanOrEqual(0);
      expect(anchor.left).toBeLessThan(LAPTOP.width);
    }
  });

  it("falls back to a rank match when the bake predates the index field", () => {
    const layout = layoutFilm(LAPTOP);
    const labels = [
      { name: "NVIDIA", ticker: "NVDA", weight: 6.21 },
      { name: "Apple", ticker: "AAPL", weight: 5.94 },
    ];
    const anchors = labelAnchors(field(12), caption({ labels }), layout);
    const heaviest = layout.a.left + 0.82 * layout.a.fontSize;
    expect(anchors[0]?.ticker).toBe("NVDA");
    expect(anchors[0]?.left).toBeGreaterThan(heaviest);
    expect(anchors[1]?.left).toBeLessThan(anchors[0]!.left);
  });

  it("prints twelve labels on a laptop and six on a phone", () => {
    // Twelve 56 px labels overlap each other and the letters once the word is 312 px wide;
    // six stay legible, and they are the six heaviest because the bake sorts by weight.
    expect(labelBudget(false)).toBe(12);
    expect(labelBudget(true)).toBe(6);
    const labels = Array.from({ length: 12 }, (_, index) => ({
      name: `Company ${index}`,
      ticker: `T${index}`,
      weight: 100 - index,
      index,
    }));
    const laptop = labelAnchors(field(12), caption({ labels }), layoutFilm(LAPTOP));
    const phone = labelAnchors(field(12), caption({ labels }), layoutFilm(PHONE));
    expect(laptop.map((anchor) => anchor.ticker)).toHaveLength(12);
    expect(phone.map((anchor) => anchor.ticker)).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
    ]);
    for (const anchor of phone) {
      expect(anchor.left).toBeGreaterThanOrEqual(0);
      expect(anchor.left + 56).toBeLessThanOrEqual(PHONE.width);
    }
  });

  it("prints nothing when there is no field", () => {
    const empty: DotField = { count: 0, raw: new Float32Array(0) };
    const layout = layoutFilm(LAPTOP);
    expect(labelAnchors(empty, caption({ labels: [] }), layout)).toEqual([]);
  });
});

describe("edgeDot", () => {
  it("finds a dot at the right-hand edge of the word for the hold beat's wink", () => {
    const layout = layoutFilm(LAPTOP);
    const dot = edgeDot(field(12), layout);
    expect(dot).not.toBeNull();
    expect(dot!.x).toBeGreaterThan(layout.a.left + layout.a.width * 0.5);
    expect(dot!.y).toBeGreaterThan(layout.a.top);
  });

  it("is null without a field, so the film can wink at nothing", () => {
    const layout = layoutFilm(LAPTOP);
    expect(edgeDot({ count: 0, raw: new Float32Array(0) }, layout)).toBeNull();
  });
});
