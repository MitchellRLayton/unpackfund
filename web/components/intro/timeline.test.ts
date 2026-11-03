import { describe, expect, it, vi } from "vitest";

import { layoutFilm } from "./layout";
import type { FilmScreen, ScreenRefs } from "./screen";
import {
  BEATS,
  ENTER_LEAD,
  MAX_OVERLAP,
  MIN_OVERLAP,
  TOTAL_SECONDS,
  TWICE_GLIDE_MS,
  TYPE_MS,
  T,
  buildTimeline,
  overlapHealth,
  type FilmHooks,
} from "./timeline";

/** The brief's beat sheet, written out independently of `BEATS` so a drift fails the test. */
const SHEET = [
  ["dark", 0, 0.9],
  ["ticker", 0.9, 1.8],
  ["scan", 1.8, 3.6],
  ["hold", 3.6, 4.4],
  ["twice", 4.4, 6.4],
  ["lights", 6.4, 7.6],
  ["handoff", 7.6, 9],
] as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

function svgPath(): SVGPathElement {
  return document.createElementNS("http://www.w3.org/2000/svg", "path");
}

/** A stage of real (if empty) nodes, so GSAP has something to read and write. */
function refs(): ScreenRefs {
  const span = (): HTMLSpanElement => element("span");
  return {
    root: element("div"),
    wordA: element("div"),
    openWord: element("div"),
    dotsLayer: element("div"),
    scanBar: element("div"),
    labels: element("div"),
    caption: element("div"),
    counter: element("div"),
    counterValue: span(),
    shared: element("p"),
    bLabel: element("div"),
    bTyped: span(),
    bTicker: "VOO",
    bCaret: span(),
    note: element("p"),
    noteText: span(),
    notePath: svgPath(),
    rule: element("div"),
    headline: element("div"),
    wink: element("div"),
    flash: element("div"),
    grain: element("div"),
    edge: element("div"),
    tools: element("div"),
    skip: element("button"),
    sound: element("button"),
  };
}

function stage(): FilmScreen {
  return {
    refs: refs(),
    layout: layoutFilm({ width: 1440, height: 900 }),
    hasDots: false,
    hasData: false,
    attach: vi.fn(),
    setScan: vi.fn(),
    setTwice: vi.fn(),
    setCollapse: vi.fn(),
    setGlow: vi.fn(),
    setCamera: vi.fn(),
    setTwiceBeat: vi.fn(),
    warmSky: vi.fn(),
    lightUp: vi.fn(),
    relayout: vi.fn(),
    setSound: vi.fn(),
    render: vi.fn(),
    destroy: vi.fn(),
  };
}

function hooks(): FilmHooks {
  return {
    prepareHandoff: vi.fn(),
    runHandoff: vi.fn(),
    cue: vi.fn(),
    onFinish: vi.fn(),
  };
}

describe("the beat sheet", () => {
  it("is the brief's seven beats, to the millisecond", () => {
    expect(BEATS.map((beat) => [beat.id, beat.start, beat.end])).toEqual(
      SHEET.map(([id, start, end]) => [id, start, end]),
    );
  });

  it("runs 0 → 9.0 s with no gap and no overlap between the beats themselves", () => {
    expect(BEATS[0]?.start).toBe(0);
    expect(BEATS[BEATS.length - 1]?.end).toBe(TOTAL_SECONDS);
    expect(TOTAL_SECONDS).toBe(9);
    for (const [index, beat] of BEATS.entries()) {
      expect(beat.end).toBeGreaterThan(beat.start);
      const previous = BEATS[index - 1];
      if (previous !== undefined) expect(beat.start).toBeCloseTo(previous.end, 6);
    }
  });

  it("maps a beat fraction to absolute seconds, and refuses a beat that is not there", () => {
    expect(T("dark")).toBe(0);
    expect(T("scan", 0.5)).toBeCloseTo(2.7, 6);
    expect(T("twice", 1)).toBe(6.4);
    expect(T("handoff", 1)).toBe(TOTAL_SECONDS);
    expect(() => T("nope" as never)).toThrow(/unknown beat/);
  });
});

describe("the built score", () => {
  it("is exactly nine seconds long", () => {
    const handle = buildTimeline(stage(), hooks());
    expect(handle.timeline.duration()).toBeCloseTo(TOTAL_SECONDS, 6);
    handle.destroy();
  });

  it("places every cue inside its beat and overlaps the beat before by 150–250 ms", () => {
    const handle = buildTimeline(stage(), hooks());
    const health = overlapHealth(handle.windows);
    expect(health.problems).toEqual([]);
    expect(health.ok).toBe(true);

    expect(handle.windows.map((window) => window.beat)).toEqual(
      BEATS.map((beat) => beat.id),
    );
    for (const [index, window] of handle.windows.entries()) {
      const beat = BEATS[index];
      expect(beat).toBeDefined();
      if (beat === undefined) continue;
      // Nothing starts after its beat, and nothing ends past the frame.
      expect(window.first).toBeLessThanOrEqual(beat.start + 0.001);
      expect(window.last).toBeCloseTo(beat.end, 3);
      expect(window.last).toBeLessThanOrEqual(TOTAL_SECONDS + 0.001);
      const previous = handle.windows[index - 1];
      if (previous === undefined) continue;
      const overlap = previous.last - window.first;
      expect(overlap).toBeGreaterThanOrEqual(MIN_OVERLAP - 0.001);
      expect(overlap).toBeLessThanOrEqual(MAX_OVERLAP + 0.001);
      // The lead is a constant, so the overlap is the same seam every time.
      expect(overlap).toBeCloseTo(ENTER_LEAD, 3);
    }
    handle.destroy();
  });

  it("tells the renderer the twice glide is the whole beat, so its squash stays 60 ms", () => {
    const screen = stage();
    const handle = buildTimeline(screen, hooks());
    expect(TWICE_GLIDE_MS).toBe(2000);
    expect(TWICE_GLIDE_MS).toBe(Math.round((T("twice", 1) - T("twice", 0)) * 1000));
    expect(screen.setTwiceBeat).toHaveBeenCalledWith(TWICE_GLIDE_MS);
    expect(screen.setTwiceBeat).toHaveBeenCalledTimes(1);
    // The typing has to finish inside the beat it introduces, before the dots are done flying.
    expect(TYPE_MS).toBeGreaterThan(0);
    expect(TYPE_MS).toBeLessThan(TWICE_GLIDE_MS);
    handle.destroy();
  });

  it("starts paused and finishes on the last frame when skipped", () => {
    const screen = stage();
    const finish = hooks();
    const handle = buildTimeline(screen, finish);
    expect(handle.timeline.paused()).toBe(true);
    expect(handle.timeline.progress()).toBe(0);

    handle.skip();
    expect(handle.timeline.progress()).toBe(1);
    expect(handle.timeline.time()).toBeCloseTo(TOTAL_SECONDS, 6);
    // A jump to the last frame is not a cut: the final values are rendered.
    expect(screen.setScan).toHaveBeenCalled();
    expect(screen.warmSky).toHaveBeenCalled();
    expect(screen.lightUp).toHaveBeenCalled();
    handle.destroy();
  });

  it("lights the room before it turns the chrome to paper", () => {
    const screen = stage();
    const handle = buildTimeline(screen, hooks());
    handle.timeline.pause();
    // Mid-lights: the table is already easing to paper, but the captions are still light on
    // dark — turning them to ink here would be dark-on-dark for most of a second.
    handle.timeline.seek(6.6, false);
    expect(screen.warmSky).toHaveBeenCalledTimes(1);
    expect(screen.lightUp).not.toHaveBeenCalled();
    handle.timeline.seek(7.1, false);
    expect(screen.lightUp).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("hands off once, at the very end", () => {
    const finish = hooks();
    const handle = buildTimeline(stage(), finish);
    handle.timeline.progress(1);
    expect(finish.prepareHandoff).toHaveBeenCalledTimes(1);
    expect(finish.runHandoff).toHaveBeenCalledTimes(1);
    handle.destroy();
  });
});
