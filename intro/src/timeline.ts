/**
 * THE ANIMATIC TIMELINE.
 *
 * One GSAP timeline, 7.5 s, six beats, no cuts. It drives every div and every
 * circle directly — no canvas — so the only thing on trial in phase 1 is the
 * choreography. Skip is `progress(1)`; replay is `restart()`; the scrub bar is
 * the same object the show runs on, so what a reviewer drags is what the
 * visitor sees.
 *
 * Beat windows (from the brief) and the content that bleeds past them:
 *
 *   paper     0.00-1.25   page, grain, ledger grid, ticker types itself
 *   parcel    1.25-2.50   card folds out of the ticker, string tugs, knot slips
 *   spill     2.50-3.75   three creases open, light, one dot per holding
 *   merge     3.75-5.00   second card, ink threads, fusion, odometer
 *   pullback  5.00-6.25   camera eases back, field becomes a ledger line, circle, h1
 *   handoff   6.25-7.50   line becomes the real input, headline is the real h1, focus
 *
 * EVERY CUE IS A FRACTION OF ITS BEAT. `T("spill", 0.4)` is 40% of the way
 * through the spill beat, whatever the story table says that beat is worth, and
 * a negative fraction reaches back into the beat before it — which is how the
 * 200 ms overlaps are built rather than hoped for. Re-timing the run is an edit
 * to `STORY`; the choreography follows.
 *
 * The transport prints the *measured* overlap per beat, derived from the first
 * and last tween each beat registered, so a beat that lands outside the brief's
 * 150-250 ms shows up as a red number rather than being asserted in a comment.
 */

import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { SplitText } from "gsap/SplitText";

import { TOTALS } from "./sample";
import { pencilLoop, type Scene } from "./scene";
import { clamp } from "./util";

gsap.registerPlugin(CustomEase, DrawSVGPlugin, ScrambleTextPlugin, SplitText);

export type BeatId = "paper" | "parcel" | "spill" | "merge" | "pullback" | "handoff";

export type Beat = { id: BeatId; label: string; start: number; end: number };

export const STORY: readonly Beat[] = [
  { id: "paper", label: "Paper", start: 0.0, end: 1.25 },
  { id: "parcel", label: "Parcel", start: 1.25, end: 2.5 },
  { id: "spill", label: "Spill", start: 2.5, end: 3.75 },
  { id: "merge", label: "Merge", start: 3.75, end: 5.0 },
  { id: "pullback", label: "Pull-back", start: 5.0, end: 6.25 },
  { id: "handoff", label: "Handoff", start: 6.25, end: 7.5 },
];

export const TOTAL = STORY[STORY.length - 1]!.end;

const BEAT = Object.fromEntries(STORY.map((b) => [b.id, b])) as Record<BeatId, Beat>;

/** A point inside a beat, as a fraction of that beat's length. */
function T(id: BeatId, fraction: number): number {
  const b = BEAT[id];
  return b.start + fraction * (b.end - b.start);
}

export type BeatWindow = {
  id: BeatId;
  label: string;
  storyStart: number;
  storyEnd: number;
  contentStart: number;
  contentEnd: number;
  /** How much this beat overlaps the beat before it, in seconds. */
  overlap: number;
};

export type PageRefs = {
  h1: HTMLElement;
  header: HTMLElement;
  prose: HTMLElement;
  footer: HTMLElement;
  form: HTMLElement;
  hint: HTMLElement;
  madeBy: HTMLElement;
};

export type TimelineHandle = {
  tl: gsap.core.Timeline;
  windows: BeatWindow[];
  seek: (time: number) => void;
  destroy: () => void;
};

class BeatBuilder {
  private firstAt = Number.POSITIVE_INFINITY;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly id: BeatId,
    readonly label: string,
    private readonly tl: gsap.core.Timeline,
    readonly storyStart: number,
    readonly storyEnd: number,
  ) {}

  /**
   * Every call takes an ABSOLUTE time on the master timeline, because the beats
   * overlap: a beat cannot own a local 0 and still reach into the one before it.
   * Callers get that absolute time from `T()`.
   */
  /**
   * A staggered tween on n targets runs for `duration + stagger × (n − 1)`. The
   * window has to know that, or a beat looks shorter than it plays and the
   * overlap column lies.
   */
  private track(at: number, duration: number, vars: gsap.TweenVars, targets: gsap.TweenTarget): void {
    const count = Array.isArray(targets) ? targets.length : 1;
    const stagger = typeof vars.stagger === "number" ? vars.stagger : 0;
    this.firstAt = Math.min(this.firstAt, at);
    this.lastAt = Math.max(this.lastAt, at + duration + stagger * Math.max(0, count - 1));
  }

  fromTo(
    targets: gsap.TweenTarget,
    fromVars: gsap.TweenVars,
    toVars: gsap.TweenVars,
    at: number = this.storyStart,
  ): this {
    this.tl.fromTo(targets, fromVars, toVars, at);
    this.track(at, Number(toVars.duration ?? 0), toVars, targets);
    return this;
  }

  to(targets: gsap.TweenTarget, vars: gsap.TweenVars, at: number = this.storyStart): this {
    this.tl.to(targets, vars, at);
    this.track(at, Number(vars.duration ?? 0), vars, targets);
    return this;
  }

  set(targets: gsap.TweenTarget, vars: gsap.TweenVars, at: number = this.storyStart): this {
    this.tl.set(targets, vars, at);
    return this;
  }

  /** A named point, for the transport's beat jumps. */
  cue(name: string, at = this.storyStart): this {
    this.tl.addLabel(name, at);
    return this;
  }

  window(): BeatWindow {
    return {
      id: this.id,
      label: this.label,
      storyStart: this.storyStart,
      storyEnd: this.storyEnd,
      contentStart: Number.isFinite(this.firstAt) ? this.firstAt : this.storyStart,
      contentEnd: Number.isFinite(this.lastAt) ? this.lastAt : this.storyStart,
      overlap: 0,
    };
  }
}

export function buildTimeline(
  scene: Scene,
  refs: PageRefs,
  options: { tardy: number; onFinish: () => void },
): TimelineHandle {
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power2.out" } });
  const { geometry, metrics } = scene;
  const portrait = metrics.portrait;

  if (!CustomEase.get("scurry")) {
    CustomEase.create(
      "scurry",
      "M0,0 C0.12,0.3 0.26,0.55 0.38,0.52 0.5,0.49 0.54,0.86 0.68,0.9 0.8,0.94 0.86,0.8 1,1",
    );
  }

  const beat = (index: number): BeatBuilder => {
    const s = STORY[index]!;
    return new BeatBuilder(s.id, s.label, tl, s.start, s.end);
  };
  const paper = beat(0);
  const parcel = beat(1);
  const spill = beat(2);
  const merge = beat(3);
  const pullback = beat(4);
  const handoff = beat(5);

  // The camera starts slightly tighter than unit and settles back later.
  const cameraStart = { x: 0, y: -metrics.vh * 0.045, k: metrics.unit * 1.05 };

  // Initial state. Every property a tween touches gets an explicit from-value
  // later; this is only the state before the timeline exists.
  gsap.set(scene.world, {
    x: cameraStart.x,
    y: cameraStart.y,
    scale: cameraStart.k,
    transformOrigin: "50% 50%",
  });
  scene.cards.forEach((card) => {
    gsap.set(card.root, { xPercent: -50, yPercent: -50, opacity: 0 });
  });
  gsap.set(scene.cards[0]!.root, { x: geometry.cardA.x, y: geometry.cardA.y });
  gsap.set(scene.cards[1]!.root, {
    x: geometry.cardB.x + (portrait ? 0 : 360),
    y: geometry.cardB.y + (portrait ? 300 : 12),
  });
  scene.dots.forEach((dot) => {
    const seam = dot.spec.fund === 0 ? geometry.seamA : geometry.seamB;
    gsap.set(dot.el, { x: seam.x, y: seam.y, scaleX: 0, scaleY: 0, opacity: 0 });
  });
  gsap.set(scene.ledger, { opacity: 0 });
  gsap.set(scene.circleSvg, { opacity: 0 });
  gsap.set(refs.madeBy, { opacity: 0 });
  gsap.set(refs.h1, { opacity: 0 });
  gsap.set([refs.header, refs.prose, refs.footer, refs.form, refs.hint], { opacity: 0 });

  // SplitText after fonts are ready, so the two lines break where the real h1
  // breaks in the real builder.
  const split = SplitText.create(refs.h1, { type: "lines", mask: "lines" });
  gsap.set(split.lines, { yPercent: 116 });

  // ---------------------------------------------------------------- paper
  // 0.00-1.25. The page arrives, the grid and grain settle, and the ticker types
  // itself across the middle of the frame, then underlines.
  paper.cue("paper");
  paper.fromTo(scene.root, { opacity: 0 }, { opacity: 1, duration: 0.16 }, T("paper", 0));
  paper.fromTo(scene.paper, { opacity: 0 }, { opacity: 1, duration: 0.3 }, T("paper", 0));
  paper.fromTo(scene.grid, { opacity: 0 }, { opacity: 1, duration: 0.48 }, T("paper", 0.02));
  paper.fromTo(scene.grain, { opacity: 0 }, { opacity: 0.55, duration: 0.46 }, T("paper", 0.02));
  paper.fromTo(scene.ticker, { opacity: 0 }, { opacity: 1, duration: 0.12 }, T("paper", 0.1));
  paper.fromTo(scene.ticker, { y: 9 }, { y: 0, duration: 0.4, ease: "power3.out" }, T("paper", 0.1));
  paper.to(
    scene.tickerText,
    {
      duration: 0.6,
      ease: "none",
      scrambleText: { text: "SPY · VGT", chars: "upperCase", speed: 0.55 },
    },
    T("paper", 0.12),
  );
  paper.fromTo(
    scene.tickerRule,
    { scaleX: 0, transformOrigin: "50% 50%" },
    { scaleX: 1, duration: 0.24, ease: "expo.out" },
    T("paper", 0.76),
  );
  paper.fromTo(scene.skip, { opacity: 0 }, { opacity: 1, duration: 0.22 }, T("paper", 0.32));
  // The filings the run is reading are on screen for the whole of it.
  paper.fromTo(scene.caption, { opacity: 0 }, { opacity: 1, duration: 0.3 }, T("paper", 0.24));

  // --------------------------------------------------------------- parcel
  // 1.00-2.50. The ticker folds into a card, the string draws, the knot takes a
  // tug and slips, and the parcel hangs there wound down.
  parcel.cue("parcel");
  parcel.to(scene.ticker, { opacity: 0, y: -7, duration: 0.14 }, T("parcel", -0.2));
  parcel.fromTo(
    scene.cards[0]!.root,
    { opacity: 0, y: geometry.cardA.y + 14, scale: 0.93, rotation: -3 },
    { opacity: 1, y: geometry.cardA.y, scale: 1, rotation: 0, duration: 0.36, ease: "expo.out" },
    T("parcel", -0.16),
  );
  parcel.fromTo(
    scene.cards[0]!.creases,
    { scaleX: 0, transformOrigin: "50% 50%" },
    { scaleX: 1, duration: 0.22, stagger: 0.06, ease: "expo.out" },
    T("parcel", -0.08),
  );
  parcel.fromTo(
    scene.cards[0]!.stringPaths,
    { drawSVG: "0%" },
    { drawSVG: "100%", duration: 0.4, stagger: 0.03, ease: "power2.inOut" },
    T("parcel", 0.04),
  );
  parcel.fromTo(
    scene.cards[0]!.knot,
    { scale: 0, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.2, ease: "power2.out" },
    T("parcel", 0.2),
  );
  // Anticipation: a small lean away from the knot, then the slip.
  parcel.to(
    scene.cards[0]!.root,
    { x: geometry.cardA.x - 4, y: geometry.cardA.y - 3, rotation: -0.8, duration: 0.14, ease: "power2.in" },
    T("parcel", 0.44),
  );
  parcel.to(
    scene.cards[0]!.root,
    { x: geometry.cardA.x + 0.5, y: geometry.cardA.y, rotation: 0.35, duration: 0.1, ease: "power2.out" },
    T("parcel", 0.56),
  );
  parcel.to(
    scene.cards[0]!.knot,
    { x: 5, y: 7, rotation: 14, opacity: 0, duration: 0.2, ease: "power2.in" },
    T("parcel", 0.6),
  );
  parcel.to(
    scene.cards[0]!.stringPaths,
    { y: 20, rotation: 3, opacity: 0, duration: 0.24, ease: "power1.in" },
    T("parcel", 0.62),
  );
  // The parcel hangs there, wound down, until the card opens on the next breath.
  parcel.to(scene.cards[0]!.root, { rotation: -0.3, duration: 0.25 }, T("parcel", 0.8));

  // ---------------------------------------------------------------- spill
  // 2.30-3.75. Three creases open, light comes out of the seam, and one dot per
  // holding pours onto the page.
  spill.cue("spill");
  spill.fromTo(
    scene.cards[0]!.bands,
    { y: 0, rotation: 0, opacity: 1 },
    {
      y: (i: number) => (i - 1) * 13,
      rotation: (i: number) => (i - 1) * 2.4,
      opacity: (i: number) => (i === 1 ? 0.98 : 0.9),
      duration: 0.3,
      stagger: 0.06,
      ease: "expo.out",
    },
    T("spill", -0.16),
  );
  spill.to(scene.cards[0]!.creases, { opacity: 0, duration: 0.2 }, T("spill", -0.06));
  spill.fromTo(
    scene.cards[0]!.seam,
    { scaleX: 0, transformOrigin: "50% 50%" },
    { scaleX: 1, duration: 0.2, ease: "expo.out" },
    T("spill", -0.04),
  );
  spill.fromTo(scene.cards[0]!.seam, { opacity: 0 }, { opacity: 0.8, duration: 0.2 }, T("spill", -0.04));
  // The card stays open while the field fills, then lets go.
  spill.to(scene.cards[0]!.root, { opacity: 0, duration: 0.3 }, T("spill", 0.76));

  // One dot per holding, largest first, each on its own arc.
  const aDots = scene.dots
    .map((dot, index) => ({ dot, index }))
    .filter(({ dot }) => dot.spec.fund === 0)
    .sort((x, y) => y.dot.spec.weightBp - x.dot.spec.weightBp);
  const pourStart = T("spill", -0.02);
  const pourStagger = 0.0088;
  aDots.forEach(({ index }, rank) => {
    if (index === options.tardy) return;
    const dot = scene.dots[index]!;
    const distance = Math.hypot(dot.home.x - geometry.seamA.x, dot.home.y - geometry.seamA.y);
    const duration = 0.34 + distance / 1400;
    const apex = clamp(distance * 0.22, 24, 150);
    const at = pourStart + rank * pourStagger;
    spill.to(dot.el, { scaleX: 1, scaleY: 1, opacity: 1, duration: 0.22, ease: "back.out(2.6)" }, at);
    spill.to(dot.el, { x: dot.home.x, duration: duration * 0.62, ease: "power2.out" }, at);
    spill.to(
      dot.el,
      {
        keyframes: [
          { y: dot.home.y - apex, duration: duration * 0.45, ease: "power2.out" },
          { y: dot.home.y, duration: duration * 0.55, ease: "back.out(1.7)" },
        ],
      },
      at,
    );
  });

  // The tardy one: leaves late, scuttles, arrives after its neighbours.
  const tardy = scene.dots[options.tardy];
  if (tardy) {
    spill.set(
      tardy.el,
      { opacity: 1, scaleX: 1, scaleY: 1, x: geometry.seamA.x + 9, y: geometry.seamA.y + 7 },
      T("spill", 0.5),
    );
    spill.to(tardy.el, { x: tardy.home.x, duration: 0.5, ease: "scurry" }, T("spill", 0.54));
    spill.to(
      tardy.el,
      {
        keyframes: [
          { y: tardy.home.y - 30, duration: 0.24, ease: "power2.out" },
          { y: tardy.home.y, duration: 0.26, ease: "back.out(2.2)" },
        ],
      },
      T("spill", 0.54),
    );
  }

  // Twelve labels scramble in once the field is mostly settled.
  const labelled = scene.dots
    .map((dot, index) => ({ dot, index }))
    .filter(({ dot }) => dot.label)
    .sort((x, y) => y.dot.spec.weightBp - x.dot.spec.weightBp);
  labelled.forEach(({ dot }, rank) => {
    const label = dot.label!;
    gsap.set(label, { x: 500 + dot.home.x + dot.r + 7, y: 500 + dot.home.y - 5 });
    const at = T("spill", 0.42) + rank * 0.026;
    spill.fromTo(label, { opacity: 0 }, { opacity: 1, duration: 0.14, ease: "none" }, at);
    spill.to(
      label,
      {
        duration: 0.2,
        ease: "none",
        scrambleText: { text: dot.spec.key, chars: "upperCase", speed: 0.4 },
      },
      at,
    );
  });

  // ---------------------------------------------------------------- merge
  // 3.55-5.00. The second card slides in and spills; the companies both funds
  // hold reach for each other and fuse; the odometer rolls to the distinct total.
  merge.cue("merge");
  const cardB = scene.cards[1]!.root;
  merge.to(
    cardB,
    { x: geometry.cardB.x, y: geometry.cardB.y, rotation: 1.5, opacity: 1, duration: 0.4, ease: "expo.out" },
    T("merge", -0.16),
  );
  merge.fromTo(
    scene.cards[1]!.stringPaths,
    { drawSVG: "0%" },
    { drawSVG: "100%", duration: 0.3, stagger: 0.02, ease: "power2.inOut" },
    T("merge", -0.06),
  );
  merge.to(
    cardB,
    { x: geometry.cardB.x - 3, y: geometry.cardB.y - 2, duration: 0.1, ease: "power2.in" },
    T("merge", 0.02),
  );
  merge.to(cardB, { x: geometry.cardB.x, y: geometry.cardB.y, duration: 0.1, ease: "power2.out" }, T("merge", 0.1));
  merge.fromTo(
    scene.cards[1]!.bands,
    { y: 0, rotation: 0 },
    {
      y: (i: number) => (i - 1) * 11,
      rotation: (i: number) => (i - 1) * 2,
      duration: 0.26,
      stagger: 0.05,
      ease: "expo.out",
    },
    T("merge", 0.14),
  );
  merge.fromTo(
    scene.cards[1]!.seam,
    { scaleX: 0, opacity: 0 },
    { scaleX: 1, opacity: 0.8, duration: 0.2, ease: "expo.out" },
    T("merge", 0.18),
  );
  merge.to(cardB, { opacity: 0, duration: 0.28 }, T("merge", 0.3));
  merge.to(
    labelled.map(({ dot }) => dot.label!),
    { opacity: 0, duration: 0.26 },
    T("merge", 0.18),
  );

  // Fund B's dots: shared companies first, so a partner exists when the thread
  // reaches for it.
  const bDots = scene.dots
    .map((dot, index) => ({ dot, index }))
    .filter(({ dot }) => dot.spec.fund === 1)
    .sort(
      (x, y) =>
        Number(y.dot.spec.shared) - Number(x.dot.spec.shared) ||
        y.dot.spec.weightBp - x.dot.spec.weightBp,
    );
  bDots.forEach(({ index }, rank) => {
    const dot = scene.dots[index]!;
    const distance = Math.hypot(dot.home.x - geometry.seamB.x, dot.home.y - geometry.seamB.y);
    const duration = 0.3 + distance / 1600;
    const apex = clamp(distance * 0.2, 18, 120);
    const at = T("merge", 0.06) + rank * 0.0082;
    merge.to(dot.el, { scaleX: 1, scaleY: 1, opacity: 1, duration: 0.2, ease: "back.out(2.6)" }, at);
    merge.to(dot.el, { x: dot.home.x, duration: duration * 0.62, ease: "power2.out" }, at);
    merge.to(
      dot.el,
      {
        keyframes: [
          { y: dot.home.y - apex, duration: duration * 0.45, ease: "power2.out" },
          { y: dot.home.y, duration: duration * 0.55, ease: "back.out(1.7)" },
        ],
      },
      at,
    );
  });

  // Threads, fusion, squash. Staggered so the field resolves left to right.
  scene.pairs.forEach(([aIndex, bIndex], pairIndex) => {
    const pair = geometry.pairs[pairIndex]!;
    const a = scene.dots[aIndex]!;
    const b = scene.dots[bIndex]!;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "thread");
    path.setAttribute(
      "d",
      `M${pair.a.x.toFixed(1)} ${pair.a.y.toFixed(1)} L${pair.b.x.toFixed(1)} ${pair.b.y.toFixed(1)}`,
    );
    scene.threadsGroup.appendChild(path);
    const t = T("merge", 0.24) + pairIndex * 0.014;
    merge.fromTo(path, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.1, ease: "power2.out" }, t);
    merge.to(a.el, { x: pair.mid.x, y: pair.mid.y, duration: 0.18, ease: "power2.inOut" }, t + 0.04);
    merge.to(b.el, { x: pair.mid.x, y: pair.mid.y, duration: 0.18, ease: "power2.inOut" }, t + 0.04);
    // The 60 ms squash-and-stretch: the fused dot takes the impact.
    merge.to(
      a.el,
      {
        keyframes: [
          { scaleX: 1.34, scaleY: 0.66, duration: 0.03, ease: "power2.out" },
          { scaleX: pair.r / a.r, scaleY: pair.r / a.r, duration: 0.07, ease: "power2.out" },
        ],
      },
      t + 0.2,
    );
    merge.to(b.el, { scaleX: 0.55, scaleY: 0.55, opacity: 0, duration: 0.12, ease: "power2.in" }, t + 0.18);
    merge.to(path, { opacity: 0, duration: 0.1 }, t + 0.24);
    // The merge flash: string red, once, and gone.
    const flash = scene.flashes[pairIndex];
    if (flash) {
      merge.fromTo(
        flash,
        { scale: 0.5, opacity: 0.9 },
        // Not immediate: a from-state of "visible" would park twenty rings on the
        // field until their turn came.
        { scale: 1.45, opacity: 0, duration: 0.18, ease: "power2.out", immediateRender: false },
        t + 0.16,
      );
    }
  });

  // The odometer: 818 companies before the fusion, 745 distinct after.
  rollCounter(merge, scene, { from: TOTALS.sum, to: TOTALS.union, start: T("merge", 0.36), duration: 0.4 });
  merge.fromTo(scene.counter, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.22 }, T("merge", 0.36));
  merge.to(scene.counter, { opacity: 0, duration: 0.25 }, T("merge", 0.8));

  // ------------------------------------------------------------- pull-back
  // 4.80-6.25. The camera eases back, the field compresses onto one ledger line,
  // a pencil loops one company, and the real headline rises by line.
  pullback.cue("pullback");
  const lineCentre = metrics.input.top + metrics.input.height / 2;
  const cameraEnd = {
    x: 0,
    y: lineCentre - metrics.vh / 2,
    k: metrics.unit * (portrait ? 0.8 : 0.72),
  };
  pullback.to(
    scene.world,
    { x: cameraEnd.x, y: cameraEnd.y, scale: cameraEnd.k, duration: 0.9, ease: "expo.inOut" },
    T("pullback", -0.16),
  );
  // The intro's paper is the page's paper, so letting it go is not a cut: the
  // grid and the grain lift and the product's own page is what is left.
  pullback.to(
    [scene.paper, scene.grid, scene.grain],
    { opacity: 0, duration: 0.34, ease: "power1.inOut" },
    T("pullback", 0.36),
  );
  pullback.to(scene.threads, { opacity: 0, duration: 0.24 }, T("pullback", 0.04));

  // The field becomes a register: every survivor lands on one line, as a tick.
  const lineWidthPx = geometry.lineWidth * cameraEnd.k;
  const ledgerLeft = metrics.vw / 2 - lineWidthPx / 2;
  gsap.set(scene.ledger, {
    width: `${lineWidthPx}px`,
    height: "1px",
    left: `${ledgerLeft}px`,
    top: `${lineCentre}px`,
    transformOrigin: "50% 50%",
  });
  scene.dots.forEach((dot) => {
    if (!dot.line) return;
    const slot = geometry.lineOwner.findIndex((owner) => scene.dots[owner] === dot);
    const target = geometry.line[slot];
    if (!target) return;
    const delay = T("pullback", 0) + (slot / geometry.line.length) * 0.25;
    pullback.to(
      dot.el,
      { x: target.x, y: 0, scaleX: target.r / dot.r, scaleY: target.r / dot.r, duration: 0.45, ease: "power2.inOut" },
      delay,
    );
  });
  pullback.fromTo(
    scene.ledger,
    { opacity: 0, scaleX: 0 },
    { opacity: 1, scaleX: 1, duration: 0.34, ease: "expo.out" },
    T("pullback", 0.4),
  );

  // The pencil loop, around the biggest fused company on the line.
  const circleTarget = geometry.line[geometry.circleSlot]!;
  const circlePoint = {
    x: metrics.vw / 2 + circleTarget.x * cameraEnd.k,
    y: lineCentre,
  };
  scene.circlePath.setAttribute("d", pencilLoop(circlePoint, 11, 7.5));
  gsap.set(scene.circlePath, { transformOrigin: `${circlePoint.x}px ${circlePoint.y}px` });
  pullback.fromTo(scene.circleSvg, { opacity: 0 }, { opacity: 1, duration: 0.1 }, T("pullback", 0.56));
  pullback.fromTo(
    scene.circlePath,
    { drawSVG: "0%" },
    { drawSVG: "100%", duration: 0.34, ease: "power2.inOut" },
    T("pullback", 0.6),
  );
  // One overshoot, at the close of the loop: the hand presses a little too far.
  pullback.fromTo(
    scene.circlePath,
    { scale: 1.035, rotation: -1.2 },
    { scale: 1, rotation: 0, duration: 0.2, ease: "power2.out" },
    T("pullback", 0.84),
  );

  // The headline is the real h1, revealed by line.
  pullback.to(refs.h1, { opacity: 1, duration: 0.02 }, T("pullback", 0.64));
  pullback.to(split.lines, { yPercent: 0, duration: 0.38, stagger: 0.06, ease: "expo.out" }, T("pullback", 0.64));
  pullback.to(scene.caption, { opacity: 0, duration: 0.28 }, T("pullback", 0.68));
  pullback.to(scene.skip, { opacity: 0, duration: 0.2 }, T("pullback", 0.76));
  pullback.to(scene.dots.map((dot) => dot.el), { opacity: 0, duration: 0.2 }, T("pullback", 0.84));

  // --------------------------------------------------------------- handoff
  // 6.05-7.50. The ledger line becomes the real input, the headline is already
  // the real h1, and the page's own chrome comes back.
  handoff.cue("handoff");
  const input = metrics.input;
  handoff.to(
    scene.ledger,
    {
      left: input.left,
      top: input.top,
      width: input.width,
      height: input.height,
      backgroundColor: "rgba(21, 27, 36, 0)",
      borderWidth: 1,
      borderRadius: 6,
      duration: 0.5,
      ease: "expo.out",
    },
    T("handoff", -0.16),
  );
  // The pencil lifts before the box is drawn, so the two never overlap.
  handoff.to(scene.circleSvg, { opacity: 0, duration: 0.16 }, T("handoff", -0.1));
  handoff.to(scene.ledger, { opacity: 0, duration: 0.2 }, T("handoff", 0.08));
  handoff.to(refs.form, { opacity: 1, duration: 0.3 }, T("handoff", 0.16));
  handoff.to(
    [refs.header, refs.prose, refs.hint, refs.footer],
    { opacity: 1, duration: 0.4, stagger: 0.05 },
    T("handoff", 0.4),
  );
  handoff.fromTo(refs.madeBy, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, T("handoff", 0.4));
  handoff.to(scene.root, { opacity: 0, duration: 0.2, ease: "power1.in" }, T("handoff", 0.84));

  const windows: BeatWindow[] = [paper, parcel, spill, merge, pullback, handoff].map(
    (builder, index, all) => {
      const window = builder.window();
      if (index > 0) window.overlap = all[index - 1]!.window().contentEnd - window.contentStart;
      return window;
    },
  );

  tl.eventCallback("onComplete", options.onFinish);

  return {
    tl,
    windows,
    seek: (time) => {
      tl.pause();
      tl.time(clamp(time, 0, TOTAL));
    },
    destroy: () => {
      tl.kill();
      split.revert();
      scene.threadsGroup.replaceChildren();
    },
  };
}

/** Roll an odometer from `from` to `to`; each digit falls through its own strip. */
function rollCounter(
  builder: BeatBuilder,
  scene: Scene,
  options: { from: number; to: number; start: number; duration: number },
): void {
  const strips = Array.from(scene.counterDigits.querySelectorAll<HTMLElement>(".counter__strip"));
  const slots = Array.from(scene.counterDigits.querySelectorAll<HTMLElement>(".counter__slot"));
  const lineHeight = slots[0]?.clientHeight || 44;
  const digits = String(options.from).padStart(strips.length, "0").split("").map(Number);
  const finals = String(options.to).padStart(strips.length, "0").split("").map(Number);
  strips.forEach((strip, index) => {
    const startDigit = digits[index] ?? 0;
    const endDigit = finals[index] ?? 0;
    const startPosition = 30 + startDigit;
    // Counting down: every digit falls forward through its strip, wrapping at 0,
    // which is what a real odometer does when the number decreases.
    const stepsDown = (startDigit - endDigit + 10) % 10 || 10;
    gsap.set(strip, { y: -startPosition * lineHeight });
    builder.to(
      strip,
      { y: -(startPosition - stepsDown) * lineHeight, duration: options.duration, ease: "power2.inOut" },
      options.start,
    );
  });
}

export function overlapHealth(windows: BeatWindow[]): { ok: boolean; min: number; max: number } {
  const overlaps = windows.slice(1).map((window) => window.overlap);
  return {
    ok: overlaps.every((overlap) => overlap >= 0.15 && overlap <= 0.25),
    min: Math.min(...overlaps),
    max: Math.max(...overlaps),
  };
}
