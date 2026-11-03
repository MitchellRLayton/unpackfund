import { describe, expect, it } from "vitest";

import {
  createDotsField,
  decideLite,
  DEFAULT_TWICE_BEAT_MS,
  dotBudget,
  dotPointSize,
  MIN_DOT_WEIGHT,
  hasSecond,
  LITE_DOTS,
  LITE_FRAME_SAMPLES,
  PORTRAIT_DOT_CAP,
  SQUASH_MS,
  squashWindow,
} from "./dots";

/** One record: [w, ax, ay, bx, by, rx, ry]. */
function record(
  w: number,
  a: readonly [number, number],
  b: readonly [number, number] | null,
  r: readonly [number, number],
): number[] {
  return [w, a[0], a[1], b ? b[0] : Number.NaN, b ? b[1] : Number.NaN, r[0], r[1]];
}

function field(records: number[][]): Float32Array {
  return Float32Array.from(records.flat());
}

describe("hasSecond", () => {
  const raw = field([
    record(0.9, [0.2, -0.3], null, [0.1, 0]),
    record(0.4, [1.1, -0.2], [0.6, -0.25], [0.5, 0]),
  ]);

  it("reports false for a company that is only in the first fund", () => {
    expect(hasSecond(raw, 0)).toBe(false);
  });

  it("reports true when both B coordinates are present", () => {
    expect(hasSecond(raw, 1)).toBe(true);
  });

  it("treats a half-written B position as absent", () => {
    const half = field([record(0.5, [0, 0], [0.3, 0], [0, 0])]);
    half[4] = Number.NaN; // by is NaN, bx survives
    expect(hasSecond(half, 0)).toBe(false);
  });

  it("is false outside the array instead of throwing", () => {
    expect(hasSecond(raw, -1)).toBe(false);
    expect(hasSecond(raw, 2)).toBe(false);
    expect(hasSecond(new Float32Array(0), 0)).toBe(false);
  });
});

describe("decideLite", () => {
  const fast = Array.from({ length: LITE_FRAME_SAMPLES }, () => 16.6); // ~60 fps
  const slow = Array.from({ length: LITE_FRAME_SAMPLES }, () => 30); // ~33 fps

  it("forces the lite tier on a four-core machine however fast the frames are", () => {
    expect(decideLite(4, fast)).toBe(true);
    expect(decideLite(4, [])).toBe(true);
  });

  it("keeps the full tier on a fast machine with a complete sample", () => {
    expect(decideLite(8, fast)).toBe(false);
  });

  it("switches to lite when the average drops under 50 fps", () => {
    expect(decideLite(8, slow)).toBe(true);
    expect(
      decideLite(
        8,
        Array.from({ length: LITE_FRAME_SAMPLES }, () => 20.1),
      ),
    ).toBe(true);
    expect(
      decideLite(
        8,
        Array.from({ length: LITE_FRAME_SAMPLES }, () => 19.9),
      ),
    ).toBe(false);
  });

  it("does not decide on a short sample or an unknown core count", () => {
    const short = slow.slice(0, LITE_FRAME_SAMPLES - 1);
    expect(decideLite(8, short)).toBe(false);
    expect(decideLite(0, [])).toBe(false);
  });

  it("treats a gap in the sample as a normal frame rather than a negative one", () => {
    const withGap = [...fast];
    withGap[0] = Number.NaN;
    expect(decideLite(8, withGap)).toBe(false);
  });
});

describe("squashWindow", () => {
  it("is 60 ms of whatever beat the film passes", () => {
    expect(squashWindow(2000)).toBeCloseTo(0.03, 10);
    expect(squashWindow(900)).toBeCloseTo(0.0667, 4);
    expect(squashWindow(2000) * 2000).toBeCloseTo(SQUASH_MS, 10);
    expect(squashWindow(900) * 900).toBeCloseTo(SQUASH_MS, 10);
  });

  it("gives a narrower window for a longer beat", () => {
    expect(squashWindow(2000)).toBeLessThan(squashWindow(900));
    expect(squashWindow(2000) / squashWindow(900)).toBeCloseTo(900 / 2000, 10);
  });

  it("defaults to the 900 ms beat when the length is missing or nonsense", () => {
    expect(squashWindow(Number.NaN)).toBeCloseTo(squashWindow(DEFAULT_TWICE_BEAT_MS), 10);
    expect(squashWindow(0)).toBeCloseTo(squashWindow(DEFAULT_TWICE_BEAT_MS), 10);
    expect(squashWindow(-2000)).toBeCloseTo(squashWindow(DEFAULT_TWICE_BEAT_MS), 10);
  });

  it("never lets the squash swallow more than half a flight", () => {
    expect(squashWindow(1)).toBeLessThanOrEqual(0.5);
    expect(squashWindow(60)).toBeLessThanOrEqual(0.5);
  });
});

describe("dotBudget", () => {
  it("caps a portrait viewport at 2,000 dots", () => {
    expect(dotBudget(3600, false, true)).toBe(PORTRAIT_DOT_CAP);
  });

  it("draws the whole field in landscape at full tier", () => {
    expect(dotBudget(3600, false, false)).toBe(3600);
  });

  it("caps the lite tier at 1,200 dots", () => {
    expect(dotBudget(3600, true, false)).toBe(LITE_DOTS);
  });

  it("takes the smaller cap when both apply", () => {
    expect(dotBudget(3600, true, true)).toBe(LITE_DOTS);
    expect(dotBudget(900, true, true)).toBe(900);
  });

  it("does not invent dots", () => {
    expect(dotBudget(800, false, true)).toBe(800);
    expect(dotBudget(0, false, false)).toBe(0);
    expect(dotBudget(-5, false, false)).toBe(0);
  });
});

describe("dotPointSize", () => {
  it("still draws a record whose weight is zero", () => {
    // 2,179 of VTI's 3,446 rows look like this: a company filed at zero basis points
    const raw = field([record(0, [0.4, 0], null, [0.2, 0])]);
    const size = dotPointSize(raw[0] ?? 0);
    expect(size).toBeGreaterThan(1.9);
    expect(Number.isFinite(size)).toBe(true);
  });

  it("gives a zero-weight dot exactly the floor weight's size", () => {
    expect(dotPointSize(0)).toBeCloseTo(dotPointSize(MIN_DOT_WEIGHT), 10);
    expect(dotPointSize(MIN_DOT_WEIGHT)).toBeGreaterThan(1.9);
  });

  it("draws every sub-floor dot at one small size, below everything above it", () => {
    // the floor is a hard max(w, MIN_DOT_WEIGHT): all of these tie at the floor size
    expect(dotPointSize(0)).toBe(dotPointSize(0.05));
    expect(dotPointSize(0)).toBe(dotPointSize(MIN_DOT_WEIGHT - 0.01));
    // and anything above the floor is strictly larger
    expect(dotPointSize(0)).toBeLessThan(dotPointSize(MIN_DOT_WEIGHT + 0.01));
    expect(dotPointSize(0)).toBeLessThan(dotPointSize(0.5));
    expect(dotPointSize(0)).toBeLessThan(dotPointSize(1));
  });

  it("makes a field of unweighted companies visible rather than hollow", () => {
    const sizes = Array.from({ length: 50 }, () => dotPointSize(0));
    expect(Math.min(...sizes)).toBeGreaterThan(3);
  });

  it("is safe for NaN, negative and oversized weights", () => {
    expect(dotPointSize(Number.NaN)).toBeCloseTo(dotPointSize(0), 10);
    expect(dotPointSize(-1)).toBeCloseTo(dotPointSize(0), 10);
    expect(dotPointSize(5)).toBeCloseTo(dotPointSize(1), 10);
  });
});

describe("createDotsField", () => {
  const data = { count: 0, raw: new Float32Array(0) };

  function canvasWith(getContext: () => unknown): HTMLCanvasElement {
    return {
      width: 0,
      height: 0,
      clientWidth: 0,
      clientHeight: 0,
      getContext,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
  }

  it("returns null when WebGL2 is unavailable", () => {
    expect(
      createDotsField(
        canvasWith(() => null),
        data,
      ),
    ).toBeNull();
  });

  it("returns null when getContext throws", () => {
    expect(
      createDotsField(
        canvasWith(() => {
          throw new Error("no gl here");
        }),
        data,
      ),
    ).toBeNull();
  });

  it("returns null when the context reports itself lost", () => {
    expect(
      createDotsField(
        canvasWith(() => ({ isContextLost: () => true })),
        data,
      ),
    ).toBeNull();
  });
});
