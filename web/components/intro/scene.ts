/**
 * The film's DOM: plain divs and circles, built once, handed to the timeline by reference.
 *
 * Ported from the approved animatic with three differences, all of them forced by the real
 * data rather than by taste:
 *
 * - The dots come from `/intro/field.json` instead of a sample: one element per *held
 *   position*, so a company both funds hold is two dots that the merge beat fuses into one.
 * - A dot has no hue. It is ink at low alpha, and the only accent in the field is the
 *   `--alert` flash a shared pair gets at the instant it fuses (`types.ts` keeps the field
 *   itself inert: `cluster` is a packing hint, not a category).
 * - The per-pair threads are gone. At the real radii a shared pair's two halves sit
 *   1.1r + 1.2 apart and already overlap, so a line between their centres is drawn entirely
 *   inside two dots — at 1,004 dots it would paint nothing. The convergence and the accent
 *   flash carry the fusion instead.
 *
 * Everything that moves is created here once; the timeline never queries the DOM.
 */

import { expandCompanies, layoutField, type FieldGeometry } from "./layout";
import { captionRows, labelByCompany, type DotSpec, type IntroField } from "./types";

export type DotHandle = {
  /** Index into the field's dot list, i.e. into `geometry.dots`. */
  index: number;
  spec: DotSpec;
  el: HTMLDivElement;
  /** The accent moment: a child that flashes once, when this dot fuses. */
  flash: HTMLDivElement | null;
  /** Packed position, world units, pre-merge. */
  home: { x: number; y: number };
  r: number;
  /** Where this dot ends up on the ledger line (survivors only). */
  line: { x: number; y: number; r: number } | null;
  /** For a shared dot: its partner's index. */
  partner: number | null;
  /** The mono ticker this dot carries, if it is one of the twelve. */
  label: HTMLDivElement | null;
  labelText: string | null;
};

export type CardHandle = {
  root: HTMLDivElement;
  bands: HTMLDivElement[];
  creases: HTMLDivElement[];
  seam: HTMLDivElement;
  stringPaths: SVGPathElement[];
  knot: HTMLDivElement;
};

/** A box in viewport pixels; `getBoundingClientRect` narrowed to what the film needs. */
export type Rect = { left: number; top: number; width: number; height: number };

export type Metrics = {
  vw: number;
  vh: number;
  portrait: boolean;
  /** World units → CSS px at camera scale 1. */
  unit: number;
  /** The real add field, which the handoff morphs into. */
  input: Rect;
  /** False when the pane is collapsed (a phone): the film morphs to the centre instead. */
  hasInput: boolean;
};

export type Scene = {
  /** The `.intro` stage inside the curtain; everything the film adds lives under it. */
  root: HTMLDivElement;
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
  counter: HTMLDivElement;
  counterDigits: HTMLDivElement;
  counterSlots: HTMLDivElement[];
  counterStrips: HTMLDivElement[];
  caption: HTMLDivElement;
  skip: HTMLButtonElement;
  ledger: HTMLDivElement;
  circleSvg: SVGSVGElement;
  circlePath: SVGPathElement;
  /** "made by hand in California": the app has no such element, so the film draws its own. */
  made: HTMLDivElement;
  field: IntroField;
  geometry: FieldGeometry;
  metrics: Metrics;
};

const CARD_BOW =
  "M0 -22 C-26 -48 -38 -14 -5 -21 M0 -22 C26 -48 38 -14 5 -21 M0 -22 C-9 -4 -3 6 0 -22";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Element,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  parent.appendChild(node);
  return node;
}

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

/**
 * Sizes and the handoff target.
 *
 * The input's box is read here, at build time, and again is not read after: the film measures
 * once, while nothing is moving, and the camera and the morph both use that number. A phone
 * with no add field (the pane is collapsed) gets a centred box of the same nominal size, so
 * the last beat still resolves somewhere sensible.
 */
export function measure(input: HTMLElement | null): Metrics {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const portrait = vh > vw * 1.05;
  // One unit = 1000 world px. On a wide screen the world is the middle band of the page; on
  // a phone it is the width of the phone.
  const unit = portrait
    ? Math.min((vw * 0.96) / 1000, (vh * 0.52) / 1000)
    : Math.min((vw * 0.88) / 1000, (vh * 0.72) / 1000);
  const box = input?.getBoundingClientRect() ?? null;
  const hasInput = box !== null && box.width > 40 && box.height > 16;
  const fallback = {
    left: vw / 2 - Math.min(220, vw * 0.4),
    top: vh / 2 - 24,
    width: Math.min(440, vw * 0.8),
    height: 48,
  };
  const rect: Rect = hasInput
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : fallback;
  return { vw, vh, portrait, unit, input: rect, hasInput };
}

export function buildScene(
  host: HTMLElement,
  field: IntroField,
  input: HTMLElement | null,
): Scene {
  const root = el("div", "intro", host);
  root.setAttribute("aria-hidden", "true");

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

  const fieldLayer = el("div", "dotfield", world);

  const metrics = measure(input);
  const labels = labelByCompany(field.companies, field.labels);
  const { dots: specs, pairs } = expandCompanies(field.companies, labels);
  const geometry = layoutField(specs, pairs, metrics.portrait);

  const partnerOf = new Map<number, number>();
  pairs.forEach(([a, b]) => {
    partnerOf.set(a, b);
    partnerOf.set(b, a);
  });
  const lineByOwner = new Map<number, { x: number; y: number; r: number }>();
  geometry.lineOwner.forEach((owner, slot) => {
    const target = geometry.line[slot]!;
    lineByOwner.set(owner, { x: target.x, y: target.y, r: target.r });
  });

  const dots: DotHandle[] = specs.map((spec, index) => {
    const packed = geometry.dots[index]!;
    const dot = el("div", "dot", fieldLayer);
    dot.dataset.fund = String(spec.fund);
    dot.style.width = `${(packed.r * 2).toFixed(2)}px`;
    dot.style.height = `${(packed.r * 2).toFixed(2)}px`;
    dot.style.marginLeft = `${(-packed.r).toFixed(2)}px`;
    dot.style.marginTop = `${(-packed.r).toFixed(2)}px`;
    const partner = partnerOf.get(index) ?? null;
    const flash = partner === null ? null : el("div", "dot__flash", dot);
    return {
      index,
      spec,
      el: dot,
      flash,
      home: { x: packed.x, y: packed.y },
      r: packed.r,
      line: lineByOwner.get(index) ?? null,
      partner,
      label: null,
      labelText: null,
    };
  });

  // The twelve mono tickers live in world units, so the camera scale is divided back out: a
  // ticker is the same handful of screen pixels on a phone as on a laptop.
  dots.forEach((dot) => {
    if (dot.spec.label === null) return;
    const label = el("div", "dot-label", fieldLayer);
    label.textContent = dot.spec.label;
    label.style.fontSize = `${(8.6 / (metrics.unit * 1.05)).toFixed(1)}px`;
    label.style.transform = `translate(${(500 + dot.home.x + dot.r + 7).toFixed(1)}px, ${(
      500 +
      dot.home.y -
      5
    ).toFixed(1)}px)`;
    dot.label = label;
    dot.labelText = dot.spec.label;
  });

  // The odometer: one column per digit of the number the field starts with.
  const counter = el("div", "counter", root);
  el("div", "counter__label", counter).textContent = "distinct companies";
  const counterDigits = el("div", "counter__digits", counter);
  const counterSlots: HTMLDivElement[] = [];
  const counterStrips: HTMLDivElement[] = [];
  const slots = String(field.totals.held).length;
  for (let i = 0; i < slots; i += 1) {
    const slot = el("div", "counter__slot", counterDigits);
    const strip = el("div", "counter__strip", slot);
    for (let digit = 0; digit < 50; digit += 1) {
      el("span", "counter__digit", strip).textContent = String(digit % 10);
    }
    counterSlots.push(slot);
    counterStrips.push(strip);
  }

  const caption = el("div", "caption", root);
  for (const row of captionRows(field)) {
    const line = el("div", "caption__row", caption);
    el("span", "caption__ticker", line).textContent = row.ticker;
    el("span", "caption__name", line).textContent = row.name;
    el("span", "caption__filed", line).textContent = row.filed;
  }

  const skip = el("button", "skip", root);
  skip.type = "button";
  skip.innerHTML = 'Skip <span class="skip__key">esc</span>';

  const ledger = el("div", "ledger", root);
  const circleSvg = svgEl("svg", { class: "circle", "aria-hidden": "true" }, root);
  const circlePath = svgEl("path", { class: "circle__path", d: "" }, circleSvg);

  const made = el("div", "made", root);
  made.textContent = "made by hand in California";

  return {
    root,
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
    counter,
    counterDigits,
    counterSlots,
    counterStrips,
    caption,
    skip,
    ledger,
    circleSvg,
    circlePath,
    made,
    field,
    geometry,
    metrics,
  };
}

/** An imperfect pencil loop around a tick: a hand, not a circle tool. */
export function pencilLoop(
  centre: { x: number; y: number },
  rx: number,
  ry: number,
): string {
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
