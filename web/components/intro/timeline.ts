/**
 * timeline.ts — the score. One GSAP master timeline, seven beats, 9.0 seconds.
 *
 * The beats are declared once, in `BEATS`, and every tween is placed at an absolute time
 * relative to a beat (`T("scan", 0.4)`), never relative to the previous tween. That is the
 * whole reason this file is readable: you can look at `T("twice", 0.15)` and know the second
 * the cue lands on, without replaying the arithmetic from the top.
 *
 * **Overlap.** Two rules hold the edit together, and `overlapHealth` asserts both:
 *
 * 1. A beat's first cue starts `ENTER_LEAD` *before* the beat's nominal start. That is the
 *    hand-off: the incoming move is already running while the outgoing one is still settling,
 *    which is why nothing ever sits on a held frame waiting for the next idea.
 * 2. A beat's last cue ends exactly on the beat's nominal end. So consecutive beats overlap by
 *    exactly `ENTER_LEAD` — 200 ms, inside the 150–250 ms the brief asks for.
 *
 * **The setters.** The letter reveal, the scan, the dot field, the camera, the glow and the
 * collapse are all driven through `FilmScreen`. The timeline never reaches into the renderer,
 * and the screen never knows what time it is; the seam between them is this file.
 *
 * **The skip.** `skip()` jumps the timeline to its last frame. It is not a cut to black: every
 * cue still renders, in one tick, so the visitor lands on the final composition — rule,
 * headline, page — exactly as if the film had played. `hooks.runHandoff` is called on the way
 * through and has to be idempotent; that is what makes a skip and a completed film converge.
 */

import { gsap } from "gsap";

import { scanEase } from "./layout";
import type { FilmScreen } from "./screen";

export type BeatId = "dark" | "ticker" | "scan" | "hold" | "twice" | "lights" | "handoff";

export interface Beat {
  readonly id: BeatId;
  /** Nominal start, in seconds. */
  readonly start: number;
  /** Nominal end, in seconds. */
  readonly end: number;
}

/**
 * The seven beats of the brief, to the millisecond:
 *
 * dark 0.0–0.9 · ticker 0.9–1.8 · scan 1.8–3.6 · hold 3.6–4.4
 * twice 4.4–6.4 · lights 6.4–7.6 · handoff 7.6–9.0
 */
export const BEATS: readonly Beat[] = [
  { id: "dark", start: 0, end: 0.9 },
  { id: "ticker", start: 0.9, end: 1.8 },
  { id: "scan", start: 1.8, end: 3.6 },
  { id: "hold", start: 3.6, end: 4.4 },
  { id: "twice", start: 4.4, end: 6.4 },
  { id: "lights", start: 6.4, end: 7.6 },
  { id: "handoff", start: 7.6, end: 9 },
];

/** Total running time, and the one number the tests and the film agree on. */
export const TOTAL_SECONDS = 9;

/** How early an incoming beat's first cue starts: the overlap between beats. */
export const ENTER_LEAD = 0.2;

/** The overlap band the brief asks for, in seconds. */
export const MIN_OVERLAP = 0.15;
export const MAX_OVERLAP = 0.25;

/**
 * How long the `twice` dots take to fly from VTI to VOO, in ms.
 *
 * This is the whole beat — 4.4 to 6.4 — because the renderer converts its 60 ms impact squash
 * into a fraction of this value (`squashWindow(beatMs)`). Shorter than the beat, and the squash
 * is shorter than 60 ms too.
 */
export const TWICE_GLIDE_MS = 2000;

/** The VOO label's typing time, in ms. */
export const TYPE_MS = 440;

/** Absolute time of a fraction through a beat. The only way a cue is placed. */
export function T(beat: BeatId, fraction = 0): number {
  const found = BEATS.find((entry) => entry.id === beat);
  if (found === undefined) throw new Error(`timeline: unknown beat "${beat}"`);
  return found.start + (found.end - found.start) * fraction;
}

/** What the score actually did inside a beat: its first cue and the last cue's end. */
export interface BeatWindow {
  readonly beat: BeatId;
  readonly first: number;
  readonly last: number;
}

/**
 * The two checks the brief makes on the edit, as one function so a test can run it.
 *
 * A beat window must start no later than its nominal start, end exactly on its nominal end,
 * and overlap the beat before it by 150–250 ms.
 */
export function overlapHealth(windows: readonly BeatWindow[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (windows.length !== BEATS.length) {
    problems.push(`expected ${BEATS.length} beat windows, got ${windows.length}`);
  }
  for (const [index, window] of windows.entries()) {
    const beat = BEATS[index];
    if (beat === undefined || window.beat !== beat.id) {
      problems.push(`window ${index} is "${window.beat}", expected "${beat?.id ?? "?"}"`);
      continue;
    }
    if (window.first > beat.start + 0.001) {
      problems.push(
        `${beat.id} first cue at ${window.first.toFixed(3)}, after ${beat.start}`,
      );
    }
    if (Math.abs(window.last - beat.end) > 0.001) {
      problems.push(
        `${beat.id} last cue ends at ${window.last.toFixed(3)}, not ${beat.end}`,
      );
    }
    if (index === 0) continue;
    const overlap = (BEATS[index - 1]?.end ?? 0) - window.first;
    if (overlap < MIN_OVERLAP - 0.001 || overlap > MAX_OVERLAP + 0.001) {
      problems.push(
        `${beat.id} overlaps by ${(overlap * 1000).toFixed(0)} ms, outside ` +
          `${MIN_OVERLAP * 1000}–${MAX_OVERLAP * 1000} ms`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The film asks the page to do these things; `play.ts` owns what they mean. */
export interface FilmHooks {
  /** The rule and the headline are about to be handed over: name them for a swap. */
  prepareHandoff(): void;
  /** Take the last frame over the page. Must be idempotent: a skip calls it too. */
  runHandoff(): void;
  /** A foley cue for the sound module; silent unless the visitor turned sound on. */
  cue(name: "hum" | "whir" | "click"): void;
  /** The timeline reached its last frame (not called when `skip()` cut it short). */
  onFinish(): void;
}

export interface TimelineHandle {
  readonly timeline: gsap.core.Timeline;
  /** What the score did in each beat, for the overlap assertion and the tests. */
  readonly windows: BeatWindow[];
  play(): void;
  /** Jump to the final frame. Every cue renders; the film does not cut away. */
  skip(): void;
  destroy(): void;
}

/**
 * A timeline plus a log of where each cue landed.
 *
 * GSAP can say when a tween starts; it cannot say which *beat* the tween belongs to, and the
 * overlap check needs both. So cues are added through this builder, which tags each one with
 * the beat that was open when it was added. `windows()` then reports, per beat, the first cue
 * and the last cue's end — the two numbers the brief constrains.
 */
class Score {
  private beat: BeatId = "dark";
  private readonly log: Array<{ beat: BeatId; start: number; end: number }> = [];

  constructor(readonly timeline: gsap.core.Timeline) {}

  enter(beat: BeatId): this {
    this.beat = beat;
    return this;
  }

  private record(start: number, duration: number): void {
    this.log.push({ beat: this.beat, start, end: start + Math.max(0, duration) });
  }

  set(target: gsap.TweenTarget, vars: gsap.TweenVars, at: number): this {
    this.record(at, 0);
    this.timeline.set(target, vars, at);
    return this;
  }

  to(target: gsap.TweenTarget, vars: gsap.TweenVars, at: number): this {
    this.record(at, typeof vars.duration === "number" ? vars.duration : 0);
    this.timeline.to(target, vars, at);
    return this;
  }

  fromTo(
    target: gsap.TweenTarget,
    from: gsap.TweenVars,
    to: gsap.TweenVars,
    at: number,
  ): this {
    this.record(at, typeof to.duration === "number" ? to.duration : 0);
    this.timeline.fromTo(target, from, to, at);
    return this;
  }

  call(fn: () => void, at: number): this {
    this.record(at, 0);
    this.timeline.call(fn, undefined, at);
    return this;
  }

  /** Mark a stretch a beat owns that is not a tween (a CSS transition, say). */
  span(at: number, duration: number): this {
    this.record(at, duration);
    return this;
  }

  windows(): BeatWindow[] {
    return BEATS.map((beat) => {
      const cues = this.log.filter((entry) => entry.beat === beat.id);
      if (cues.length === 0)
        return { beat: beat.id, first: beat.start, last: beat.start };
      return {
        beat: beat.id,
        first: Math.min(...cues.map((entry) => entry.start)),
        last: Math.max(...cues.map((entry) => entry.end)),
      };
    });
  }
}

/**
 * Build and return the score. The timeline is paused; the caller decides when it starts, and
 * calls `play()` at the exact moment the first frame becomes visible.
 */
export function buildTimeline(screen: FilmScreen, hooks: FilmHooks): TimelineHandle {
  const timeline = gsap.timeline({
    paused: true,
    defaults: { ease: "none" },
    onComplete: hooks.onFinish,
  });
  const score = new Score(timeline);
  const { refs } = screen;

  const scanProxy = { value: 0 };
  const twiceProxy = { value: 0 };
  const glowProxy = { value: 0 };
  const cameraProxy = { value: 0 };
  const collapseProxy = { value: 0 };
  const typeProxy = { value: 0 };

  const renderScan = (): void => {
    screen.setScan(scanEase(scanProxy.value));
  };
  const renderGlow = (): void => {
    screen.setGlow(glowProxy.value);
  };
  const renderTwice = (): void => {
    screen.setTwice(twiceProxy.value);
  };
  const renderCollapse = (): void => {
    screen.setCollapse(collapseProxy.value);
  };
  const renderCamera = (): void => {
    screen.setCamera(cameraProxy.value);
  };
  const renderType = (): void => {
    const ticker = refs.bTicker;
    const count = Math.min(
      ticker.length,
      Math.floor(typeProxy.value * ticker.length + 1e-6),
    );
    refs.bTyped.textContent = ticker.slice(0, count);
  };

  // The renderer wants the glide length before its first twice frame; the field may not exist
  // yet, so the screen holds the value until it does.
  screen.setTwiceBeat(TWICE_GLIDE_MS);

  // ── dark 0.0–0.9 ────────────────────────────────────────────────────────────────────────
  // A near-black table. The grain, the thin edge of cool light and the caption arrive in that
  // order, each a little slower than the last, so the frame fills without seeming to load.
  score
    .enter("dark")
    .set(refs.grain, { autoAlpha: 0 }, 0)
    .set(refs.edge, { autoAlpha: 0, scaleY: 0.3 }, 0)
    .set(refs.caption, { autoAlpha: 0 }, 0)
    .set(refs.tools, { autoAlpha: 0 }, 0)
    .set(refs.scanBar, { autoAlpha: 0, scaleY: 0.6 }, 0)
    .set(refs.counter, { autoAlpha: 0 }, 0)
    .set(refs.shared, { autoAlpha: 0 }, 0)
    .set(refs.bLabel, { autoAlpha: 0 }, 0)
    .set(refs.note, { autoAlpha: 0, rotate: -4 }, 0)
    .set(refs.rule, { autoAlpha: 0, scaleX: 0.9 }, 0)
    .set(refs.headline, { autoAlpha: 0, clipPath: "inset(0 100% 0 0)" }, 0)
    .set(refs.wink, { autoAlpha: 0 }, 0)
    .set(refs.flash, { opacity: 0 }, 0)
    .call(() => {
      screen.setScan(0);
      screen.setGlow(0);
      screen.setCamera(0);
    }, 0)
    .to(refs.grain, { autoAlpha: 0.55, duration: 0.5 }, 0.04)
    .to(refs.edge, { autoAlpha: 1, scaleY: 1, duration: 0.6, ease: "power2.out" }, 0.1)
    .to(refs.caption, { autoAlpha: 1, duration: 0.34 }, 0.28)
    .to(refs.tools, { autoAlpha: 1, duration: 0.2 }, 0.4)
    .call(() => hooks.cue("hum"), T("dark", 0.03))
    .to(refs.caption, { opacity: 0.92, duration: 0.3 }, 0.6);

  // ── ticker 0.9–1.8 ──────────────────────────────────────────────────────────────────────
  // VTI rises as solid matte letters at 60% of the frame, then settles once from a 6% squeeze.
  // The camera is still finishing its push-in, and both land together. The word rises whole
  // rather than letter by letter: splitting it into inline boxes drops the font's kerning and
  // the word would no longer be the 1.934 em the dot field was baked against.
  score
    .enter("ticker")
    .fromTo(
      refs.wordA,
      { yPercent: 112, autoAlpha: 0 },
      { yPercent: 0, autoAlpha: 1, duration: 0.52, ease: "expo.out" },
      0.7,
    )
    .fromTo(
      refs.wordA,
      { scale: 0.94 },
      { scale: 1, duration: 0.45, ease: "back.out(1.8)" },
      1.35,
    )
    .fromTo(
      cameraProxy,
      { value: 0.26 },
      { value: 0, duration: 0.55, ease: "power2.out", onUpdate: renderCamera },
      1.25,
    );

  // ── scan 1.8–3.6 ────────────────────────────────────────────────────────────────────────
  // The light bar sweeps left to right: fast out of the gate, unhurried through the middle,
  // quick again at the end. Behind it the letters turn translucent and fill with dots, twelve
  // labels land as it passes, and the counter rolls. It ends on a small mechanical bump — the
  // bar hitting its stop — rather than on a fade.
  score
    .enter("scan")
    .to(refs.scanBar, { autoAlpha: 1, scaleY: 1, duration: 0.22 }, 1.6)
    .to(scanProxy, { value: 1, duration: 1.72, ease: "none", onUpdate: renderScan }, 1.62)
    .call(() => hooks.cue("whir"), T("scan", 0))
    .to(refs.counter, { autoAlpha: 1, duration: 0.26 }, 1.9)
    .to(refs.scanBar, { x: 7, duration: 0.1, ease: "power2.out" }, 3.34)
    .to(refs.scanBar, { autoAlpha: 0, duration: 0.16 }, 3.44)
    .to(refs.scanBar, { x: 0, duration: 0.16, ease: "back.out(2.4)" }, 3.44);

  // ── hold 3.6–4.4 ────────────────────────────────────────────────────────────────────────
  // Stillness. The ticker takes one breath of glow, the counter lands, and one dot near an
  // edge winks — once, so nothing in the film flashes more than three times a second.
  score
    .enter("hold")
    .to(
      glowProxy,
      { value: 1, duration: 0.7, ease: "power2.out", onUpdate: renderGlow },
      3.4,
    )
    .set(refs.counterValue, { scale: 1.06 }, 3.4)
    .to(refs.counterValue, { scale: 1, duration: 0.26, ease: "power2.out" }, 3.44)
    .set(refs.wink, { autoAlpha: 0, scale: 0.5 }, 4)
    .to(refs.wink, { autoAlpha: 1, scale: 1.15, duration: 0.14, ease: "power2.out" }, 4)
    .to(refs.wink, { autoAlpha: 0, scale: 1.7, duration: 0.26, ease: "power2.in" }, 4.14);

  // ── twice 4.4–6.4 ───────────────────────────────────────────────────────────────────────
  // VOO is typed in small mono under VTI — clean keystrokes, no scramble. Then VOO's companies
  // lift out of VTI as the same dots, coral-tinted, and fly down to spell the second word,
  // biggest first. The renderer does the flying; the score moves the one value that drives it,
  // after giving the typing a head start.
  score
    .enter("twice")
    .set(refs.bLabel, { autoAlpha: 1 }, 4.2)
    .set(refs.bCaret, { autoAlpha: 1 }, 4.2)
    .set(typeProxy, { value: 0 }, 4.2)
    .call(renderType, 4.2)
    .to(
      typeProxy,
      { value: 1, duration: TYPE_MS / 1000, ease: "none", onUpdate: renderType },
      4.24,
    )
    .to(refs.bCaret, { autoAlpha: 0, duration: 0.2 }, 4.64)
    .to(
      twiceProxy,
      { value: 1, duration: TWICE_GLIDE_MS / 1000, ease: "none", onUpdate: renderTwice },
      4.4,
    )
    .to(refs.note, { autoAlpha: 1, duration: 0.4 }, 5.1)
    .to(refs.note, { rotate: -2.2, duration: 0.6, ease: "power2.out" }, 5.1)
    .to(refs.notePath, { strokeDashoffset: 0, duration: 0.55, ease: "power2.inOut" }, 5.2)
    .fromTo(
      refs.shared,
      { y: 6 },
      { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" },
      5.7,
    )
    .to(refs.counterValue, { scale: 1.03, duration: 0.15 }, 6.1)
    .to(refs.counterValue, { scale: 1, duration: 0.15 }, 6.25);

  // ── lights 6.4–7.6 ──────────────────────────────────────────────────────────────────────
  // The room lights come on: one soft flash, and the table colour eases to the site's paper
  // from a registered `@property` so the midpoint is a real colour, not a muddy mix (that
  // transition is the CSS one, so `span` is here just so the overlap check sees it). Both
  // words collapse along curves onto one thin rule while the camera pulls back.
  score
    .enter("lights")
    .to(
      cameraProxy,
      { value: -0.86, duration: 1.1, ease: "power1.inOut", onUpdate: renderCamera },
      6.2,
    )
    .to(
      collapseProxy,
      { value: 1, duration: 1.02, ease: "none", onUpdate: renderCollapse },
      6.2,
    )
    .set(refs.flash, { opacity: 0 }, 6.4)
    .to(refs.flash, { opacity: 0.14, duration: 0.1 }, 6.4)
    .call(() => {
      // The room lights come on first; the chrome turns over once the paper is mostly there,
      // so the captions are never dark-on-dark in between.
      screen.warmSky();
      hooks.cue("click");
    }, 6.42)
    .call(() => screen.lightUp(), 7.02)
    .span(6.42, 0.86)
    .to(refs.flash, { opacity: 0, duration: 0.35 }, 6.5)
    .to(refs.wordA, { autoAlpha: 0, duration: 0.35 }, 6.95)
    .to(refs.openWord, { autoAlpha: 0, duration: 0.35 }, 6.95)
    .to(refs.labels, { autoAlpha: 0, duration: 0.3 }, 6.95)
    .to(refs.bLabel, { autoAlpha: 0, duration: 0.3 }, 6.95)
    .to(refs.note, { autoAlpha: 0, duration: 0.3 }, 6.95)
    .to(refs.grain, { autoAlpha: 0, duration: 0.5 }, 6.95)
    .to(refs.edge, { autoAlpha: 0, duration: 0.5 }, 6.95)
    .to(refs.dotsLayer, { autoAlpha: 0, duration: 0.3 }, 7.16)
    .set(refs.rule, { autoAlpha: 0 }, 7.02)
    .to(refs.rule, { autoAlpha: 1, duration: 0.3, ease: "power2.out" }, 7.05)
    .set(refs.headline, { autoAlpha: 1 }, 7.2)
    .fromTo(
      refs.headline,
      { y: 10 },
      { clipPath: "inset(0 0% 0 0)", y: 0, duration: 0.4, ease: "power2.inOut" },
      7.2,
    );

  // ── handoff 7.6–9.0 ─────────────────────────────────────────────────────────────────────
  // The overlays go first — caption, counter, Skip, sound — so the last frame is only the rule
  // and the headline. Then the swap: `runHandoff` hands those two to the page, which names the
  // real h1 and a hairline over the input's edge, so the rule becomes the field's underline and
  // the headline becomes the page's own h1. The score keeps running to 9.0, so the film's last
  // frame and the page's first are the same frame.
  score
    .enter("handoff")
    .call(hooks.prepareHandoff, 7.4)
    .to([refs.caption, refs.counter, refs.tools], { autoAlpha: 0, duration: 0.22 }, 7.6)
    .call(hooks.runHandoff, 8.36)
    // The swap runs from 8.36 to about 8.9: the last 0.64 s of the brief's handoff *is* the
    // transition, so there is nothing left to animate. This no-op holds the score open to 9.0
    // so the timeline's own duration is the film's duration, and a skip lands on the frame the
    // page takes over from.
    .span(8.86, 0.14)
    .call(() => undefined, TOTAL_SECONDS);

  return {
    timeline,
    get windows(): BeatWindow[] {
      return score.windows();
    },
    play(): void {
      timeline.play(0);
    },
    skip(): void {
      // Not a cut: every cue between here and 9.0 renders in one tick, so the visitor lands on
      // the frame the film was heading for.
      timeline.progress(1);
    },
    destroy(): void {
      timeline.kill();
    },
  };
}
