/**
 * The animatic's DOM. Plain divs and circles, exactly as phase 1 asks: no
 * canvas, no WebGPU, no shader — so the only thing under review is *timing*.
 *
 * Everything that moves on screen is created here once and then handed to the
 * timeline by reference. The timeline never queries the DOM, so a rebuild (on
 * resize or an orientation change) is a clean teardown, not a scavenger hunt.
 */

import { layoutField, type FieldGeometry } from "./layout";
import { captionLines, type DotSpec, type FundMeta } from "./sample";
import { el, svgEl } from "./util";

export type DotHandle = {
  spec: DotSpec;
  el: HTMLDivElement;
  label: HTMLDivElement | null;
  /** Packed position, world units, pre-merge. */
  home: { x: number; y: number };
  r: number;
  /** Where this dot ends up on the ledger line (survivors only). */
  line: { x: number; y: number } | null;
  /** For a shared dot: its partner's index. */
  partner: number | null;
};

export type CardHandle = {
  root: HTMLDivElement;
  bands: HTMLDivElement[];
  creases: HTMLDivElement[];
  seam: HTMLDivElement;
  stringPaths: SVGPathElement[];
  knot: HTMLDivElement;
};

export type Camera = { x: number; y: number; k: number };

export type Metrics = {
  vw: number;
  vh: number;
  portrait: boolean;
  /** World units → CSS px at camera scale 1. */
  unit: number;
  /** The real Builder input, which the handoff morphs into. */
  input: DOMRect;
};

export type Scene = {
  root: HTMLDivElement;
  /** One ring per shared pair, struck at the moment its two halves fuse. */
  flashes: HTMLDivElement[];
  paper: HTMLDivElement;
  grain: HTMLDivElement;
  grid: HTMLDivElement;
  world: HTMLDivElement;
  ticker: HTMLDivElement;
  tickerText: HTMLDivElement;
  tickerRule: HTMLDivElement;
  cards: [CardHandle, CardHandle];
  dots: DotHandle[];
  pairs: Array<[number, number]>;
  threads: SVGSVGElement;
  threadsGroup: SVGGElement;
  counter: HTMLDivElement;
  counterDigits: HTMLDivElement;
  caption: HTMLDivElement;
  skip: HTMLButtonElement;
  ledger: HTMLDivElement;
  circleSvg: SVGSVGElement;
  circlePath: SVGPathElement;
  geometry: FieldGeometry;
  metrics: Metrics;
  project: (point: { x: number; y: number }, camera: Camera) => { x: number; y: number };
};

const CARD_BOW =
  "M0 -22 C-26 -48 -38 -14 -5 -21 M0 -22 C26 -48 38 -14 5 -21 M0 -22 C-9 -4 -3 6 0 -22";

function buildCard(className: string, parent: Element): CardHandle {
  const root = el("div", `card ${className}`, parent);
  const bands = [0, 1, 2].map(() => el("div", "card__band", root));
  const creases = [el("div", "card__crease", root), el("div", "card__crease", root)];
  creases[0]!.style.top = "33.333%";
  creases[1]!.style.top = "66.666%";
  const seam = el("div", "card__seam", root);
  seam.style.top = "50%";

  const svg = svgEl("svg", { class: "card__string", viewBox: "-80 -100 160 200" }, root);
  const stringPaths = [
    svgEl("path", { class: "string string--x", d: "M-80 -22 L80 -22" }, svg),
    svgEl("path", { class: "string string--y", d: "M0 -98 L0 98" }, svg),
    svgEl("path", { class: "string string--bow", d: CARD_BOW }, svg),
  ];
  const knot = el("div", "card__knot", root);
  return { root, bands, creases, seam, stringPaths, knot };
}

export function measure(input: HTMLInputElement): Metrics {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const portrait = vh > vw * 1.05;
  // One unit = 1000 world px. On a wide screen the world is the middle band of
  // the page; on a phone it is the width of the phone.
  const unit = portrait
    ? Math.min((vw * 0.96) / 1000, (vh * 0.52) / 1000)
    : Math.min((vw * 0.88) / 1000, (vh * 0.72) / 1000);
  return { vw, vh, portrait, unit, input: input.getBoundingClientRect() };
}

export function buildScene(
  root: HTMLDivElement,
  dotsSpec: DotSpec[],
  pairs: Array<[number, number]>,
  labelled: number[],
  funds: readonly [FundMeta, FundMeta],
  input: HTMLInputElement,
): Scene {
  root.className = "intro";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = "";

  const paper = el("div", "intro__paper", root);
  const grain = el("div", "intro__grain", root);
  const grid = el("div", "intro__grid", root);
  const world = el("div", "intro__world", root);

  const ticker = el("div", "ticker", world);
  const tickerText = el("div", "ticker__text", ticker);
  const tickerRule = el("div", "ticker__rule", ticker);

  const cards: [CardHandle, CardHandle] = [
    buildCard("card--a", world),
    buildCard("card--b", world),
  ];

  const field = el("div", "dotfield", world);
  const threads = svgEl(
    "svg",
    { class: "threads", viewBox: "-500 -500 1000 1000", "aria-hidden": "true" },
    world,
  );
  const threadsGroup = svgEl("g", {}, threads);

  const metrics = measure(input);
  const geometry = layoutField(dotsSpec, pairs, metrics.portrait);

  const partnerOf = new Map<number, number>();
  pairs.forEach(([a, b]) => {
    partnerOf.set(a, b);
    partnerOf.set(b, a);
  });
  const lineByOwner = new Map<number, { x: number; y: number }>();
  geometry.lineOwner.forEach((owner, slot) => {
    lineByOwner.set(owner, { x: geometry.line[slot]!.x, y: geometry.line[slot]!.y });
  });

  const dots: DotHandle[] = dotsSpec.map((spec, index) => {
    const packed = geometry.dots[index]!;
    const dot = el("div", "dot", field);
    dot.dataset.sector = String(spec.sector);
    dot.dataset.fund = String(spec.fund);
    // Eleven sector hues, 33° apart: the field's only colour.
    dot.style.setProperty("--dot", `var(--sector-${spec.sector % 11})`);
    dot.style.width = `${packed.r * 2}px`;
    dot.style.height = `${packed.r * 2}px`;
    dot.style.marginLeft = `${-packed.r}px`;
    dot.style.marginTop = `${-packed.r}px`;
    dot.style.left = "500px";
    dot.style.top = "500px";
    return {
      spec,
      el: dot,
      label: null,
      home: { x: packed.x, y: packed.y },
      r: packed.r,
      line: lineByOwner.get(index) ?? null,
      partner: partnerOf.get(index) ?? null,
    };
  });

  // Twelve mono labels, scrubbed in after the spill has settled.
  labelled.forEach((dotIndex) => {
    const dot = dots[dotIndex]!;
    dot.label = el("div", "dot-label", field);
    dot.label.textContent = dot.spec.key;
    // Labels live in world units, so divide the camera scale back out: a ticker
    // is the same handful of screen pixels on a phone as on a laptop.
    dot.label.style.fontSize = `${(8.6 / (metrics.unit * 1.05)).toFixed(1)}px`;
  });

  // The counter: an odometer, one column per digit.
  // One ring per fused company: the merge flash, and the only place the string
  // red is allowed onto the paper.
  const flashes = geometry.pairs.map((pair) => {
    const ring = el("div", "flash", field);
    const size = pair.r * 2;
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.left = `${500 + pair.mid.x - pair.r}px`;
    ring.style.top = `${500 + pair.mid.y - pair.r}px`;
    return ring;
  });

  const counter = el("div", "counter", root);
  el("div", "counter__label", counter).textContent = "distinct companies";
  const counterDigits = el("div", "counter__digits", counter);
  for (let i = 0; i < 3; i += 1) {
    const slot = el("div", "counter__slot", counterDigits);
    // A column of digits, one per line, so each one falls into its own window.
    const strip = el("div", "counter__strip", slot);
    for (let digit = 0; digit < 50; digit += 1) {
      el("span", "counter__digit", strip).textContent = String(digit % 10);
    }
  }

  const caption = el("div", "caption", root);
  captionLines(funds).forEach((row) => {
    const line = el("div", "caption__row", caption);
    el("span", "caption__ticker", line).textContent = row.ticker;
    el("span", "caption__name", line).textContent = row.name;
    el("span", "caption__filed", line).textContent = `N-PORT ${row.filed}`;
  });

  const skip = el("button", "skip", root);
  skip.type = "button";
  skip.innerHTML = 'Skip <span class="skip__key">esc</span>';

  const ledger = el("div", "ledger", root);
  const circleSvg = svgEl("svg", { class: "circle", "aria-hidden": "true" }, root);
  const circlePath = svgEl("path", { class: "circle__path", d: "" }, circleSvg);

  return {
    root,
    flashes,
    paper,
    grain,
    grid,
    world,
    ticker,
    tickerText,
    tickerRule,
    cards,
    dots,
    pairs,
    threads,
    threadsGroup,
    counter,
    counterDigits,
    caption,
    skip,
    ledger,
    circleSvg,
    circlePath,
    geometry,
    metrics,
    project: (point, camera) => ({
      x: metrics.vw / 2 + camera.x + point.x * camera.k,
      y: metrics.vh / 2 + camera.y + point.y * camera.k,
    }),
  };
}

/** An imperfect pencil loop around a tick: a hand, not a circle tool. */
export function pencilLoop(centre: { x: number; y: number }, rx: number, ry: number): string {
  const points: string[] = [];
  const steps = 64;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const wobble = 1 + 0.038 * Math.sin(t * 3 + 0.7) + 0.02 * Math.cos(t * 5);
    const drift = (i / steps) * 0.04;
    const x = centre.x + Math.cos(t + 0.12) * rx * wobble * (1 + drift);
    const y = centre.y + Math.sin(t) * ry * wobble * (1 + drift * 0.6);
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join(" ");
}
