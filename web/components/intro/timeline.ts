/**
 * THE FILM'S TIMELINE.
 *
 * One GSAP timeline, 7.5 s, six beats, no cuts. Beat windows, from the approved animatic:
 *
 *   paper     0.00-1.25   page, grain, ledger grid, ticker types itself
 *   parcel    1.25-2.50   card folds out of the ticker, string draws, knot slips
 *   spill     2.50-3.75   three creases open, light, one dot per held position
 *   merge     3.75-5.00   second card, fusion, odometer
 *   pullback  5.00-6.25   camera eases back, field becomes a ledger line, circle, h1
 *   handoff   6.25-7.50   line becomes the real input, the page's own chrome returns
 *
 * EVERY CUE IS A FRACTION OF ITS BEAT. `T("spill", 0.4)` is 40% of the way through the spill
 * beat, whatever the story table says that beat is worth, and a negative fraction reaches
 * back into the beat before it — which is how the ~200 ms overlaps are built rather than
 * hoped for. Re-timing the run is an edit to `STORY`; the choreography follows.
 *
 * Two things differ from the animatic, both of them count-driven:
 *
 * 1. **The dots are not tweened.** The animatic made one tween per dot, which at 120 dots was
 *    fine and at 1,004 would be 4,000 tweens. Instead the timeline drives the *chrome* and
 *    declares each dot's schedule as numbers (`planDots`), and a single `onUpdate` pass
 *    samples all 1,004 dots from the timeline's clock, writing only `transform` and
 *    `opacity`. Dots that have nothing to do on a frame write nothing at all. The merge
 *    flash is a class toggle per pair, not a colour tween.
 * 2. **The stagger follows the count.** A pour that took 68 dots × 8.8 ms in the animatic
 *    would take 4.4 s over 501, so the spread is a share of the beat and the per-dot stagger
 *    is that share divided by the number of dots. The arcs, easings, overlaps and impact
 *    timings are the animatic's.
 */

import { gsap } from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { SplitText } from "gsap/SplitText";

import { clamp } from "./layout";
import { pencilLoop, type Scene } from "./scene";

gsap.registerPlugin(DrawSVGPlugin, ScrambleTextPlugin, SplitText);

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
export function T(id: BeatId, fraction: number): number {
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

/**
 * The page's own furniture, which the film hides and then hands back.
 *
 * Every one of these is painted before the film runs and must survive it: the film sets an
 * inline `opacity` on each, and `play.ts` restores exactly what it set. `subtitle` is absent
 * whenever the workspace has not loaded a portfolio, and `form` is the add field (or its
 * form), which a phone may not have at all.
 */
export type PageRefs = {
  header: HTMLElement | null;
  eyebrow: HTMLElement | null;
  h1: HTMLElement | null;
  subtitle: HTMLElement | null;
  form: HTMLElement | null;
  footer: HTMLElement | null;
};

/** The subset that exists on this page: a reveal tween must not be handed a `null` target. */
function present(targets: Array<HTMLElement | null>): HTMLElement[] {
  return targets.filter((target): target is HTMLElement => target !== null);
}

export type TimelineHandle = {
  tl: gsap.core.Timeline;
  windows: BeatWindow[];
  /** The frame the dots were last sampled at; exposed for review, not used in production. */
  time: () => number;
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
   * Every call takes an ABSOLUTE time on the master timeline, because the beats overlap: a
   * beat cannot own a local 0 and still reach into the one before it. Callers get that
   * absolute time from `T()`.
   */
  /**
   * A staggered tween on n targets runs for `duration + stagger × (n − 1)`. The window has to
   * know that, or a beat looks shorter than it plays and the overlap column lies.
   */
  private track(
    at: number,
    duration: number,
    vars: gsap.TweenVars,
    targets: gsap.TweenTarget,
  ): void {
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

  to(
    targets: gsap.TweenTarget,
    vars: gsap.TweenVars,
    at: number = this.storyStart,
  ): this {
    this.tl.to(targets, vars, at);
    this.track(at, Number(vars.duration ?? 0), vars, targets);
    return this;
  }

  set(
    targets: gsap.TweenTarget,
    vars: gsap.TweenVars,
    at: number = this.storyStart,
  ): this {
    this.tl.set(targets, vars, at);
    return this;
  }

  /**
   * Reserve a stretch of the beat for work the timeline does not tween — the sampled dots.
   * Without it a beat's measured window would stop at its last GSAP tween and the overlap
   * column would report a beat as ending half a second before the field finishes filling.
   */
  span(at: number, duration: number): this {
    this.tl.to({}, { duration }, at);
    this.track(at, duration, { duration }, {});
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
  options: { onFinish: () => void },
): TimelineHandle {
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power2.out" } });
  const { geometry, metrics } = scene;
  const portrait = metrics.portrait;

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

  // Initial state. Every property a tween touches gets an explicit from-value later; this is
  // only the state before the timeline exists.
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
  gsap.set(scene.ledger, { opacity: 0 });
  gsap.set(scene.circleSvg, { opacity: 0 });
  gsap.set(scene.made, { opacity: 0 });
  gsap.set(
    present([refs.header, refs.eyebrow, refs.h1, refs.form, refs.footer, refs.subtitle]),
    {
      opacity: 0,
    },
  );

  // SplitText after fonts are ready, so the headline breaks where the real h1 breaks.
  const split =
    refs.h1 === null ? null : SplitText.create(refs.h1, { type: "lines", mask: "lines" });
  if (split !== null) gsap.set(split.lines, { yPercent: 116 });

  // ---------------------------------------------------------------- paper
  // 0.00-1.25. The page arrives, the grid and grain settle, and the ticker types itself
  // across the middle of the frame, then underlines.
  paper.fromTo(scene.root, { opacity: 0 }, { opacity: 1, duration: 0.16 }, T("paper", 0));
  paper.fromTo(scene.paper, { opacity: 0 }, { opacity: 1, duration: 0.3 }, T("paper", 0));
  paper.fromTo(
    scene.grid,
    { opacity: 0 },
    { opacity: 1, duration: 0.48 },
    T("paper", 0.02),
  );
  paper.fromTo(
    scene.grain,
    { opacity: 0 },
    { opacity: 0.55, duration: 0.46 },
    T("paper", 0.02),
  );
  paper.fromTo(
    scene.ticker,
    { opacity: 0 },
    { opacity: 1, duration: 0.12 },
    T("paper", 0.1),
  );
  paper.fromTo(
    scene.ticker,
    { y: 9 },
    { y: 0, duration: 0.4, ease: "power3.out" },
    T("paper", 0.1),
  );
  paper.to(
    scene.tickerText,
    {
      duration: 0.6,
      ease: "none",
      scrambleText: {
        text: scene.field.pair.join(" · "),
        chars: "upperCase",
        speed: 0.55,
      },
    },
    T("paper", 0.12),
  );
  paper.fromTo(
    scene.tickerRule,
    { scaleX: 0, transformOrigin: "50% 50%" },
    { scaleX: 1, duration: 0.24, ease: "expo.out" },
    T("paper", 0.76),
  );
  paper.fromTo(
    scene.skip,
    { opacity: 0 },
    { opacity: 1, duration: 0.22 },
    T("paper", 0.32),
  );
  // The filings the run is reading are on screen for the whole of it.
  paper.fromTo(
    scene.caption,
    { opacity: 0 },
    { opacity: 1, duration: 0.3 },
    T("paper", 0.24),
  );

  // --------------------------------------------------------------- parcel
  // 1.25-2.50. The ticker folds into a card, the string draws, the knot takes a tug and slips,
  // and the parcel hangs there wound down.
  parcel.to(scene.ticker, { opacity: 0, y: -7, duration: 0.14 }, T("parcel", -0.2));
  parcel.fromTo(
    scene.cards[0]!.root,
    { opacity: 0, y: geometry.cardA.y + 14, scale: 0.93, rotation: -3 },
    {
      opacity: 1,
      y: geometry.cardA.y,
      scale: 1,
      rotation: 0,
      duration: 0.36,
      ease: "expo.out",
    },
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
    {
      x: geometry.cardA.x - 4,
      y: geometry.cardA.y - 3,
      rotation: -0.8,
      duration: 0.14,
      ease: "power2.in",
    },
    T("parcel", 0.44),
  );
  parcel.to(
    scene.cards[0]!.root,
    {
      x: geometry.cardA.x + 0.5,
      y: geometry.cardA.y,
      rotation: 0.35,
      duration: 0.1,
      ease: "power2.out",
    },
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
  // 2.50-3.75. Three creases open, light comes out of the seam, and one dot per holding pours
  // onto the page.
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
  spill.fromTo(
    scene.cards[0]!.seam,
    { opacity: 0 },
    { opacity: 0.8, duration: 0.2 },
    T("spill", -0.04),
  );
  // The card stays open while the field fills, then lets go.
  spill.to(scene.cards[0]!.root, { opacity: 0, duration: 0.3 }, T("spill", 0.76));

  const plan = planDots(scene);
  spill.span(plan.spillStartA, plan.spillEndA - plan.spillStartA);

  // Twelve labels scramble in once the field is mostly settled.
  const labelled = scene.dots
    .filter((dot) => dot.label !== null)
    .sort((x, y) => y.spec.weightBp - x.spec.weightBp);
  labelled.forEach((dot, rank) => {
    const label = dot.label!;
    const at = T("spill", 0.42) + rank * 0.026;
    spill.fromTo(label, { opacity: 0 }, { opacity: 1, duration: 0.14, ease: "none" }, at);
    spill.to(
      label,
      {
        duration: 0.2,
        ease: "none",
        scrambleText: { text: dot.labelText ?? "", chars: "upperCase", speed: 0.4 },
      },
      at,
    );
  });

  // ---------------------------------------------------------------- merge
  // 3.75-5.00. The second card slides in and spills; the companies both funds hold reach for
  // each other and fuse; the odometer rolls to the distinct total.
  const cardB = scene.cards[1]!.root;
  merge.to(
    cardB,
    {
      x: geometry.cardB.x,
      y: geometry.cardB.y,
      rotation: 1.5,
      opacity: 1,
      duration: 0.4,
      ease: "expo.out",
    },
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
    {
      x: geometry.cardB.x - 3,
      y: geometry.cardB.y - 2,
      duration: 0.1,
      ease: "power2.in",
    },
    T("merge", 0.02),
  );
  merge.to(
    cardB,
    { x: geometry.cardB.x, y: geometry.cardB.y, duration: 0.1, ease: "power2.out" },
    T("merge", 0.1),
  );
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
    labelled.map((dot) => dot.label!),
    { opacity: 0, duration: 0.26 },
    T("merge", 0.18),
  );
  merge.span(plan.spillStartB, plan.fuseEnd - plan.spillStartB);

  // The odometer: every held position before the fusion, every company after it.
  rollCounter(merge, scene, {
    from: scene.field.totals.held,
    to: scene.field.totals.distinct,
    start: T("merge", 0.36),
    duration: 0.4,
  });
  merge.fromTo(
    scene.counter,
    { opacity: 0, y: 10 },
    { opacity: 1, y: 0, duration: 0.22 },
    T("merge", 0.36),
  );
  merge.to(scene.counter, { opacity: 0, duration: 0.25 }, T("merge", 0.8));

  // ------------------------------------------------------------- pull-back
  // 5.00-6.25. The camera eases back, the field compresses onto one ledger line, a pencil
  // loops one company, and the real headline rises by line.
  const lineCentre = metrics.input.top + metrics.input.height / 2;
  const cameraEnd = {
    x: 0,
    y: lineCentre - metrics.vh / 2,
    k: metrics.unit * (portrait ? 0.8 : 0.72),
  };
  pullback.to(
    scene.world,
    {
      x: cameraEnd.x,
      y: cameraEnd.y,
      scale: cameraEnd.k,
      duration: 0.9,
      ease: "expo.inOut",
    },
    T("pullback", -0.16),
  );
  // The film's paper is the page's paper, so letting it go is not a cut: the grid and the
  // grain lift and the product's own page is what is left.
  pullback.to(
    [scene.paper, scene.grid, scene.grain],
    { opacity: 0, duration: 0.34, ease: "power1.inOut" },
    T("pullback", 0.36),
  );

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
  pullback.span(plan.lineStart, plan.lineEnd - plan.lineStart);
  pullback.fromTo(
    scene.ledger,
    { opacity: 0, scaleX: 0 },
    { opacity: 1, scaleX: 1, duration: 0.34, ease: "expo.out" },
    T("pullback", 0.4),
  );

  // The pencil loop, around the biggest company on the line.
  const circleTarget = geometry.line[geometry.circleSlot]!;
  const circlePoint = {
    x: metrics.vw / 2 + circleTarget.x * cameraEnd.k,
    y: lineCentre,
  };
  scene.circlePath.setAttribute("d", pencilLoop(circlePoint, 11, 7.5));
  gsap.set(scene.circlePath, {
    transformOrigin: `${circlePoint.x}px ${circlePoint.y}px`,
  });
  pullback.fromTo(
    scene.circleSvg,
    { opacity: 0 },
    { opacity: 1, duration: 0.1 },
    T("pullback", 0.56),
  );
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
  pullback.to(present([refs.h1]), { opacity: 1, duration: 0.02 }, T("pullback", 0.64));
  if (split !== null) {
    pullback.to(
      split.lines,
      { yPercent: 0, duration: 0.38, stagger: 0.06, ease: "expo.out" },
      T("pullback", 0.64),
    );
  }
  // The eyebrow and the subtitle are the rest of that block, so they land with it — before
  // the input, which is what makes the sequence read as "the page, then the field".
  pullback.to(
    present([refs.eyebrow, refs.subtitle]),
    { opacity: 1, duration: 0.4 },
    T("pullback", 0.72),
  );
  pullback.to(scene.caption, { opacity: 0, duration: 0.28 }, T("pullback", 0.68));
  pullback.to(scene.skip, { opacity: 0, duration: 0.2 }, T("pullback", 0.76));
  pullback.span(plan.fadeStart, plan.fadeDur);

  // --------------------------------------------------------------- handoff
  // 6.25-7.50. The ledger line becomes the real input, the headline is already the real h1,
  // and the page's own chrome comes back.
  const input = metrics.input;
  handoff.to(
    scene.ledger,
    {
      left: input.left,
      top: input.top,
      width: input.width,
      height: input.height,
      backgroundColor: "rgba(0, 0, 0, 0)",
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
  handoff.to(present([refs.form]), { opacity: 1, duration: 0.3 }, T("handoff", 0.16));
  handoff.to(
    present([refs.header, refs.footer]),
    { opacity: 1, duration: 0.4, stagger: 0.05 },
    T("handoff", 0.4),
  );
  handoff.fromTo(
    scene.made,
    { opacity: 0 },
    { opacity: 1, duration: 0.4, ease: "power2.out" },
    T("handoff", 0.4),
  );
  handoff.to(
    scene.root,
    { opacity: 0, duration: 0.2, ease: "power1.in" },
    T("handoff", 0.84),
  );

  const windows: BeatWindow[] = [paper, parcel, spill, merge, pullback, handoff].map(
    (builder, index, all) => {
      const window = builder.window();
      if (index > 0)
        window.overlap = all[index - 1]!.window().contentEnd - window.contentStart;
      return window;
    },
  );

  // One pass per rendered frame, sampling every dot from the timeline's clock. This is the
  // whole of the field's animation: 1,004 dots, no tweens.
  const render = (): void => {
    renderDots(plan, tl.time());
  };
  renderDots(plan, 0);
  tl.eventCallback("onUpdate", render);
  tl.eventCallback("onComplete", () => {
    render();
    options.onFinish();
  });

  return {
    tl,
    windows,
    time: () => tl.time(),
    seek: (time) => {
      tl.pause();
      tl.time(clamp(time, 0, TOTAL));
      render();
    },
    destroy: () => {
      tl.kill();
      split?.revert();
    },
  };
}

// ---------------------------------------------------------------- the dots

/**
 * One dot's schedule, as numbers.
 *
 * The field's whole animation is these four windows per dot, sampled from the timeline clock:
 * pour (out of its card's seam), fuse (pairs only), line (survivors only), fade (all). Nothing
 * here is a tween, so a frame costs 1,004 small arithmetic checks and writes only for the dots
 * that are actually travelling.
 */
type DotTrack = {
  el: HTMLDivElement;
  /** The accent overlay, on the half of a shared pair that survives the fusion. */
  flash: HTMLDivElement | null;
  /** The half that the fusion consumes: it slides to the midpoint and fades out. */
  vanishing: boolean;
  /** Where the dot is drawn while it is parked, before the ledger line. */
  restX: number;
  restY: number;
  restScale: number;
  pourAt: number;
  pourDur: number;
  apex: number;
  seamX: number;
  seamY: number;
  homeX: number;
  homeY: number;
  /** Fusion window; Infinity for a dot with no partner. */
  fuseAt: number;
  midX: number;
  midY: number;
  /** The fused dot's radius as a scale of its own: areas add, not radii. */
  fuseScale: number;
  /** Line window; Infinity for a dot that does not survive. */
  lineAt: number;
  lineX: number;
  lineScale: number;
  /** 0 = seam, 1 = home, 2 = fused, 3 = line, 4 = gone; -1 = never written. */
  parked: number;
  flashOn: boolean;
};

export type DotPlan = {
  tracks: DotTrack[];
  spillStartA: number;
  spillEndA: number;
  spillStartB: number;
  fuseEnd: number;
  lineStart: number;
  lineEnd: number;
  fadeStart: number;
  fadeDur: number;
};

const FUSE_SLIDE = 0.18;
const FUSE_SQUASH = 0.03;
const FUSE_SETTLE = 0.07;
const FUSE_SHRINK = 0.12;
const FUSE_TOTAL = FUSE_SLIDE + FUSE_SQUASH + FUSE_SETTLE;
const FLASH_AT = 0.16;
const FLASH_FOR = 0.24;
const LINE_DUR = 0.45;
/**
 * The world is a 1000 × 1000 box whose origin is its centre, and a dot is a `left: 0; top: 0`
 * element moved by `transform`. So every world coordinate the geometry hands out has to be
 * shifted by half the box on its way to the DOM — the cards and the ticker get this from their
 * own `left: 500px; top: 500px` in CSS, and the dots get it here, in the one place that writes
 * their transform.
 */
const WORLD_CENTRE = 500;
/** How much of a beat one fund's pour is spread across. */
const POUR_SPREAD = 0.3;

export function planDots(scene: Scene): DotPlan {
  const { geometry } = scene;
  const beatLength = STORY[2]!.end - STORY[2]!.start;
  const pourA = T("spill", -0.02);
  const pourB = T("merge", 0.06);

  const aDots = scene.dots.filter((dot) => dot.spec.fund === 0);
  const bDots = scene.dots.filter((dot) => dot.spec.fund === 1);
  const staggerA = aDots.length > 1 ? (beatLength * POUR_SPREAD) / (aDots.length - 1) : 0;
  const staggerB = bDots.length > 1 ? (beatLength * POUR_SPREAD) / (bDots.length - 1) : 0;

  // Pour order: largest first, so the field fills from its heaviest companies outward.
  const rank = new Map<number, number>();
  [...aDots]
    .sort((x, y) => y.spec.weightBp - x.spec.weightBp)
    .forEach((dot, index) => rank.set(dot.index, index));
  [...bDots]
    .sort(
      (x, y) =>
        Number(y.spec.shared) - Number(x.spec.shared) ||
        y.spec.weightBp - x.spec.weightBp,
    )
    .forEach((dot, index) => rank.set(dot.index, index));

  const count = scene.dots.length;
  const pourAt = new Float64Array(count);
  const pourDur = new Float64Array(count);
  const apex = new Float64Array(count);
  scene.dots.forEach((dot) => {
    const fundA = dot.spec.fund === 0;
    const seam = fundA ? geometry.seamA : geometry.seamB;
    const distance = Math.hypot(dot.home.x - seam.x, dot.home.y - seam.y);
    const first = fundA ? pourA : pourB;
    const stagger = fundA ? staggerA : staggerB;
    const travel = fundA
      ? clamp(0.34 + distance / 1400, 0.34, 0.55)
      : clamp(0.3 + distance / 1600, 0.3, 0.5);
    pourAt[dot.index] = first + (rank.get(dot.index) ?? 0) * stagger;
    pourDur[dot.index] = travel;
    apex[dot.index] = clamp(distance * 0.21, fundA ? 24 : 18, fundA ? 150 : 120);
  });

  // The fusion follows the pour, left to right, and never reaches a dot that is still in the
  // air: each pair's turn waits for the later of its two halves to land.
  const fuseAt = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const fuseStagger =
    scene.pairs.length > 1 ? (beatLength * 0.28) / (scene.pairs.length - 1) : 0;
  scene.pairs.forEach(([a, b], pairIndex) => {
    const landed = Math.max(pourAt[b]! + pourDur[b]!, pourAt[a]! + pourDur[a]!);
    const at = Math.max(T("merge", 0.24) + pairIndex * fuseStagger, landed + 0.04);
    fuseAt[a] = at;
    fuseAt[b] = at;
  });

  const lineSlot = new Map<number, number>();
  geometry.lineOwner.forEach((owner, slot) => lineSlot.set(owner, slot));
  const lineStagger = 0.25 / Math.max(1, geometry.line.length - 1);
  const lineStart = T("pullback", 0);
  const fadeStart = T("pullback", 0.84);
  const fadeDur = 0.2;

  let spillEndA = pourA;
  let spillEndB = pourB;
  let fuseEnd = T("merge", 0.24);

  const tracks: DotTrack[] = scene.dots.map((dot) => {
    const fundA = dot.spec.fund === 0;
    const seam = fundA ? geometry.seamA : geometry.seamB;
    const pairIndex = scene.pairs.findIndex(
      ([a, b]) => a === dot.index || b === dot.index,
    );
    const pair = pairIndex < 0 ? null : scene.pairs[pairIndex]!;
    const merge = pairIndex < 0 ? null : geometry.pairs[pairIndex]!;
    const keeper = pair !== null && pair[0] === dot.index;

    const slot = lineSlot.get(dot.index) ?? -1;
    const lineAt = slot < 0 ? Number.POSITIVE_INFINITY : lineStart + slot * lineStagger;

    if (fundA) spillEndA = Math.max(spillEndA, pourAt[dot.index]! + pourDur[dot.index]!);
    else spillEndB = Math.max(spillEndB, pourAt[dot.index]! + pourDur[dot.index]!);
    if (merge !== null) fuseEnd = Math.max(fuseEnd, fuseAt[dot.index]! + FUSE_TOTAL);

    return {
      el: dot.el,
      flash: keeper ? dot.flash : null,
      vanishing: pair !== null && !keeper,
      restX: keeper && merge !== null ? merge.mid.x : dot.home.x,
      restY: keeper && merge !== null ? merge.mid.y : dot.home.y,
      restScale: keeper && merge !== null ? merge.r / dot.r : 1,
      pourAt: pourAt[dot.index]!,
      pourDur: pourDur[dot.index]!,
      apex: apex[dot.index]!,
      seamX: seam.x,
      seamY: seam.y,
      homeX: dot.home.x,
      homeY: dot.home.y,
      fuseAt: fuseAt[dot.index]!,
      midX: merge === null ? dot.home.x : merge.mid.x,
      midY: merge === null ? dot.home.y : merge.mid.y,
      fuseScale: merge === null ? 1 : merge.r / dot.r,
      lineAt,
      lineX: dot.line === null ? 0 : dot.line.x,
      lineScale: dot.line === null ? 1 : dot.line.r / dot.r,
      parked: -1,
      flashOn: false,
    };
  });

  return {
    tracks,
    spillStartA: pourA,
    spillEndA,
    spillStartB: pourB,
    fuseEnd,
    lineStart,
    lineEnd: lineStart + Math.max(0, geometry.line.length - 1) * lineStagger + LINE_DUR,
    fadeStart,
    fadeDur,
  };
}

const outCubic = (p: number): number => 1 - (1 - p) ** 3;
const inQuad = (p: number): number => p * p;
const inOutCubic = (p: number): number =>
  p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
const backOut = (p: number, overshoot: number): number => {
  const c1 = 1.70158 * overshoot;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
};
const lerp = (from: number, to: number, p: number): number => from + (to - from) * p;

/**
 * Sample every dot at time `t` and write the ones that are not simply parked.
 *
 * The rule that keeps 1,004 divs at 60 fps is the `parked` check: a dot writes its transform
 * when it starts and stops being somewhere, and on the frames it is actually travelling.
 * Through most of the film the field is standing still and costs a few comparisons a frame.
 */
function renderDots(plan: DotPlan, t: number): void {
  const tracks = plan.tracks;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]!;
    // One toggle per pair, on the frame the flash window opens and on the frame it closes.
    flash(track, t);

    if (t < track.pourAt) {
      park(track, 0, track.seamX, track.seamY, 0, 0);
      continue;
    }
    if (t < track.pourAt + track.pourDur) {
      pour(track, (t - track.pourAt) / track.pourDur);
      continue;
    }
    if (track.vanishing) {
      if (t < track.fuseAt) park(track, 1, track.homeX, track.homeY, 1, 1);
      else if (t < track.fuseAt + FUSE_TOTAL) fuseAway(track, t - track.fuseAt);
      else park(track, 4, track.midX, track.midY, 0.55, 0);
      continue;
    }
    if (t < track.fuseAt) {
      park(track, 1, track.homeX, track.homeY, 1, 1);
      continue;
    }
    if (t < track.fuseAt + FUSE_TOTAL) {
      fuse(track, t - track.fuseAt);
      continue;
    }
    if (t < track.lineAt) {
      park(track, 2, track.restX, track.restY, track.restScale, 1);
      continue;
    }
    if (t < track.lineAt + LINE_DUR) {
      line(track, (t - track.lineAt) / LINE_DUR);
      continue;
    }
    if (t < plan.fadeStart) {
      park(track, 3, track.lineX, 0, track.lineScale, 1);
      continue;
    }
    if (t < plan.fadeStart + plan.fadeDur) {
      track.parked = -1;
      track.el.style.opacity = (1 - (t - plan.fadeStart) / plan.fadeDur).toFixed(3);
      continue;
    }
    park(track, 4, track.lineX, 0, track.lineScale, 0);
  }
}

function write(
  track: DotTrack,
  x: number,
  y: number,
  scaleX: number,
  opacity: number,
  scaleY: number = scaleX,
): void {
  const el = track.el;
  const left = (x + WORLD_CENTRE).toFixed(2);
  const top = (y + WORLD_CENTRE).toFixed(2);
  el.style.transform =
    scaleX === scaleY
      ? `translate3d(${left}px, ${top}px, 0) scale(${scaleX.toFixed(4)})`
      : `translate3d(${left}px, ${top}px, 0) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
  el.style.opacity = opacity >= 1 ? "1" : opacity <= 0 ? "0" : opacity.toFixed(3);
}

function park(
  track: DotTrack,
  state: number,
  x: number,
  y: number,
  scale: number,
  opacity: number,
): void {
  if (track.parked === state) return;
  track.parked = state;
  write(track, x, y, scale, opacity);
}

/** Out of the card's seam and onto its home, on an arc that overshoots its landing. */
function pour(track: DotTrack, p: number): void {
  const x = lerp(track.seamX, track.homeX, outCubic(clamp(p / 0.62, 0, 1)));
  const firstLeg = 0.45;
  const rise = track.apex * (1 - outCubic(clamp(p / firstLeg, 0, 1)));
  const fall =
    track.apex * (1 - backOut(clamp((p - firstLeg) / (1 - firstLeg), 0, 1), 1.7));
  const land = p < firstLeg ? rise : fall;
  const grow = clamp((p * track.pourDur) / 0.22, 0, 1);
  const scale = backOut(grow, 2.6);
  track.parked = -1;
  write(track, x, track.homeY - land, scale, clamp(scale, 0, 1));
}

/** Both halves of a pair meet at the midpoint; this is the half that survives, and takes it. */
function fuse(track: DotTrack, dt: number): void {
  if (dt < FUSE_SLIDE) {
    const e = inOutCubic(dt / FUSE_SLIDE);
    track.parked = -1;
    write(
      track,
      lerp(track.homeX, track.midX, e),
      lerp(track.homeY, track.midY, e),
      1,
      1,
    );
    return;
  }
  track.parked = -1;
  if (dt < FUSE_SLIDE + FUSE_SQUASH) {
    // The 30 ms squash: the dot lands wide and flat, then swells back to its fused area.
    const e = outCubic((dt - FUSE_SLIDE) / FUSE_SQUASH);
    write(track, track.midX, track.midY, 1 + 0.34 * e, 1, 1 - 0.34 * e);
    return;
  }
  const e = outCubic(clamp((dt - FUSE_SLIDE - FUSE_SQUASH) / FUSE_SETTLE, 0, 1));
  write(
    track,
    track.midX,
    track.midY,
    lerp(1.34, track.fuseScale, e),
    1,
    lerp(0.66, track.fuseScale, e),
  );
}

function fuseAway(track: DotTrack, dt: number): void {
  track.parked = -1;
  if (dt < FUSE_SLIDE) {
    const e = inOutCubic(dt / FUSE_SLIDE);
    write(
      track,
      lerp(track.homeX, track.midX, e),
      lerp(track.homeY, track.midY, e),
      1,
      1,
    );
    return;
  }
  const e = inQuad(clamp((dt - FUSE_SLIDE) / FUSE_SHRINK, 0, 1));
  write(track, track.midX, track.midY, 1 - 0.45 * e, 1 - e);
}

/** The accent moment: one class toggle per pair, faded by CSS, never a colour tween per dot. */
function flash(track: DotTrack, t: number): void {
  const overlay = track.flash;
  if (overlay === null) return;
  const on = t >= track.fuseAt + FLASH_AT && t < track.fuseAt + FLASH_AT + FLASH_FOR;
  if (on === track.flashOn) return;
  track.flashOn = on;
  overlay.classList.toggle("is-fusing", on);
}

/** The field becomes a register: every survivor slides onto one line, shrinking to a tick. */
function line(track: DotTrack, p: number): void {
  const e = inOutCubic(clamp(p, 0, 1));
  track.parked = -1;
  write(
    track,
    lerp(track.restX, track.lineX, e),
    lerp(track.restY, 0, e),
    lerp(track.restScale, track.lineScale, e),
    1,
  );
}

/** Roll an odometer from `from` to `to`; each digit falls through its own strip. */
function rollCounter(
  builder: BeatBuilder,
  scene: Scene,
  options: { from: number; to: number; start: number; duration: number },
): void {
  const strips = scene.counterStrips;
  const lineHeight = scene.counterSlots[0]?.clientHeight || 44;
  const digits = String(options.from).padStart(strips.length, "0").split("").map(Number);
  const finals = String(options.to).padStart(strips.length, "0").split("").map(Number);
  strips.forEach((strip, index) => {
    const startDigit = digits[index] ?? 0;
    const endDigit = finals[index] ?? 0;
    const startPosition = 30 + startDigit;
    // Counting down: every digit falls forward through its strip, wrapping at 0, which is what
    // a real odometer does when the number decreases.
    const stepsDown = (startDigit - endDigit + 10) % 10 || 10;
    gsap.set(strip, { y: -startPosition * lineHeight });
    builder.to(
      strip,
      {
        y: -(startPosition - stepsDown) * lineHeight,
        duration: options.duration,
        ease: "power2.inOut",
      },
      options.start,
    );
  });
  // 1,004 becomes 504, not 0504: the leading slot is a blank once the roll has landed.
  const leading = scene.counterSlots[0];
  if (leading && String(options.to).length < String(options.from).length) {
    builder.to(leading, { opacity: 0, duration: 0.12 }, options.start + options.duration);
  }
}

/** The brief's overlap contract, measured from the real cues rather than asserted. */
export function overlapHealth(windows: BeatWindow[]): {
  ok: boolean;
  min: number;
  max: number;
} {
  const overlaps = windows.slice(1).map((window) => window.overlap);
  return {
    ok: overlaps.every((overlap) => overlap >= 0.15 && overlap <= 0.25),
    min: Math.min(...overlaps),
    max: Math.max(...overlaps),
  };
}
