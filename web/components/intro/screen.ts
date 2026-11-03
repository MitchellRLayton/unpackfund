/**
 * screen.ts — the film's stage: the DOM the visitor sees, and the one place that turns a
 * layout into styles.
 *
 * The stage is built before any data arrives, so the dark table and the word rise can start
 * while `/intro/caption.json` and `/intro/dots.bin` are in flight. When they land, `attach`
 * sets the caption, the counter, the labels and the dots — and re-lays the stage out from the
 * bake's own metrics, because the fallback metrics it started with are only an estimate.
 *
 * Two pieces of geometry are worth knowing before reading this file:
 *
 * 1. **The letters are the bake's letters.** The word is rendered in a film-local
 *    `@font-face` for Newsreader with the full `wght` axis (200–800) declared in
 *    `intro.css`. The site's own face clamps at 600, and at 600 "VTI" is 1.799 em wide while
 *    the bake sampled it at 800 and 1.934 em — the dots would sit 7% inside the letters.
 * 2. **The renderer's `setBoxes` takes a coordinate frame, not an ink box.** `dots.ts` maps
 *    an em position into a word with `x = left + (em / advance) · width`, where `advance` is
 *    the ticker line's em advance for *both* words. Word A's box is therefore its real box;
 *    word B's box is `advanceA · fontSizeB` wide, and its dots land at `em · fontSizeB` from
 *    `left` — which is where they belong. Passing B's ink width there would stretch the
 *    second word by 21.6% (2.351 / 1.934 em). CONTRACT.md §2 fixes that interface, so the
 *    conversion lives here, in the one comment that explains it.
 *
 * The stage owns no timing. Every value the film animates is a setter on this object, and
 * `timeline.ts` decides when to call it.
 */

import { gsap } from "gsap";

import { createDotsField, PORTRAIT_DOT_CAP, type DotsField } from "./dots";
import {
  FALLBACK_METRICS,
  capField,
  edgeDot,
  labelAnchors,
  layoutFilm,
  type FilmLayout,
  type Rect,
  type WordBox,
} from "./layout";
import {
  formatCount,
  formatFiledLine,
  sharedLine,
  type Caption,
  type CaptionMetrics,
  type DotField,
} from "./types";

/** The bake's artifact pair, or what arrived of it. */
export interface FilmData {
  caption: Caption | null;
  dots: DotField | null;
}

/** The elements the timeline animates directly. Everything else is internal. */
export interface ScreenRefs {
  readonly root: HTMLDivElement;
  readonly wordA: HTMLDivElement;
  readonly openWord: HTMLDivElement;
  readonly dotsLayer: HTMLDivElement;
  readonly scanBar: HTMLDivElement;
  readonly labels: HTMLDivElement;
  readonly caption: HTMLDivElement;
  readonly counter: HTMLDivElement;
  readonly counterValue: HTMLSpanElement;
  readonly shared: HTMLParagraphElement;
  readonly bLabel: HTMLDivElement;
  readonly bTyped: HTMLSpanElement;
  /** The second ticker, as baked. The typing animation slices this rather than a literal. */
  readonly bTicker: string;
  readonly bCaret: HTMLSpanElement;
  readonly note: HTMLElement;
  readonly noteText: HTMLSpanElement;
  readonly notePath: SVGPathElement;
  readonly rule: HTMLDivElement;
  readonly headline: HTMLDivElement;
  readonly wink: HTMLDivElement;
  readonly flash: HTMLDivElement;
  readonly grain: HTMLDivElement;
  readonly edge: HTMLDivElement;
  readonly tools: HTMLDivElement;
  readonly skip: HTMLButtonElement;
  readonly sound: HTMLButtonElement;
}

/** The stage the film talks to. */
export interface FilmScreen {
  readonly refs: ScreenRefs;
  readonly layout: FilmLayout;
  /** True once a real dot field exists (as opposed to the dotless fallback). */
  readonly hasDots: boolean;
  /** True once the bake's caption has been attached. */
  readonly hasData: boolean;
  attach(data: FilmData): void;
  setScan(p: number): void;
  setTwice(p: number): void;
  setCollapse(p: number): void;
  setGlow(g: number): void;
  /**
   * Positive pushes the camera in, negative pulls it back. The pull-back is a DOM transform
   * on the camera wrapper (the canvas lives inside it), so dots and letters move together;
   * the renderer's own camera is optics only and stays at the establishing value.
   */
  setCamera(z: number): void;
  /** Tell the renderer how long the `twice` glide is, so its 60 ms squash stays 60 ms. */
  setTwiceBeat(ms: number): void;
  /** The room lights come on: the table colour starts easing towards the site's paper. */
  /** Start the table's colour easing to the site's paper. */
  warmSky(): void;
  /** Switch the chrome — captions, counter, rule, headline — to the site's paper palette. */
  lightUp(): void;
  /** Recompute geometry for a new viewport, and rebuild the field if the dot budget moved. */
  relayout(): void;
  setSound(on: boolean): void;
  render(): void;
  destroy(): void;
}

/** Fallback headline text, used only if the real page has no `h1.title` to copy. */
const FALLBACK_HEADLINE = "See the companies behind your funds";

/** Fallback tickers, used before the bake names the pair. */
const FALLBACK_TICKERS: readonly [string, string] = ["VTI", "VOO"];

/** The camera's push-in gain, as a DOM scale. */
const PUSH_GAIN = 0.1;
/**
 * How far the lights beat pulls the camera back, as a DOM scale, and how much of the way there
 * `setCamera(-PULL_DEPTH)` means. The pull is what fits the rule on a narrow frame.
 */
const PULL_LANDSCAPE = 0.94;
const PULL_FLOOR = 0.62;
const PULL_DEPTH = 0.86;
/** The rule is a hairline; its box height is this many px. */
const RULE_HEIGHT = 2;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

function svgEl(tag: "svg" | "path", parent: Element): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  parent.appendChild(node);
  return node;
}

/** A hand-drawn underline: a wobble, then the loop a pencil makes coming back for more. */
function pencilPath(width: number, height: number): string {
  const wave = (x: number): number => height * 0.5 + Math.sin(x * 0.1) * height * 0.22;
  const points: string[] = [];
  for (let step = 0; step <= 10; step += 1) {
    const x = 2 + (step / 10) * (width - 22);
    points.push(`${step === 0 ? "M" : "L"}${x.toFixed(1)} ${wave(x).toFixed(1)}`);
  }
  const end = width - 22;
  points.push(
    `C${(end + 10).toFixed(1)} ${(height * 0.15).toFixed(1)} ${(end - 2).toFixed(1)} ${(height * 0.05).toFixed(1)} ${(end - 4).toFixed(1)} ${(height * 0.55).toFixed(1)}`,
  );
  return points.join(" ");
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Build the stage inside the curtain. */
export function buildScreen(host: HTMLElement): FilmScreen {
  const root = el("div", "intro");

  const sky = el("div", "intro__sky", root);
  const flash = el("div", "intro__flash", root);
  const grain = el("div", "intro__grain", root);
  const edge = el("div", "intro__edge", root);

  const camera = el("div", "intro__camera", root);
  const solidLayer = el("div", "intro__layer intro__layer--solid", camera);
  const openLayer = el("div", "intro__layer intro__layer--open", camera);
  const dotsLayer = el("div", "intro__layer intro__layer--dots", camera);
  const canvas = el("canvas", "intro__canvas", dotsLayer);
  canvas.setAttribute("aria-hidden", "true");

  const solidWord = el("div", "intro__word intro__word--solid", solidLayer);
  const openWord = el("div", "intro__word intro__word--open", openLayer);
  const labels = el("div", "intro__labels", camera);
  const bLabel = el("div", "intro__bLabel", camera);
  const bTyped = el("span", "intro__bTyped", bLabel);
  // The caret's bar is the element's own background; no glyph, so it cannot be read out.
  const bCaret = el("span", "intro__bCaret", bLabel);
  const rule = el("div", "intro__rule", camera);
  const wink = el("div", "intro__wink", camera);
  const scanBar = el("div", "intro__bar", camera);

  const headline = el("div", "intro__headline", root);
  headline.textContent = copyHeadline();

  const caption = el("div", "intro__caption", root);
  const captionTicker = el("span", "intro__captionTicker", caption);
  captionTicker.textContent = FALLBACK_TICKERS[0];
  const captionFiled = el("span", "intro__captionFiled", caption);

  const counter = el("div", "intro__counter", root);
  const counterLabel = el("span", "intro__counterLabel", counter);
  counterLabel.textContent = "companies";
  const counterValue = el("span", "intro__counterValue", counter);
  counterValue.textContent = "0";
  const shared = el("p", "intro__shared", counter);

  const note = el("figure", "intro__note", root);
  const noteText = el("span", "intro__noteText", note);
  noteText.textContent = "the same companies, twice";
  const noteSvg = svgEl("svg", note) as SVGSVGElement;
  noteSvg.setAttribute("viewBox", "0 0 132 14");
  noteSvg.setAttribute("preserveAspectRatio", "none");
  noteSvg.setAttribute("class", "intro__noteLine");
  noteSvg.setAttribute("aria-hidden", "true");
  const notePath = svgEl("path", noteSvg) as SVGPathElement;
  notePath.setAttribute("d", pencilPath(132, 14));
  notePath.setAttribute("pathLength", "1");
  notePath.setAttribute("fill", "none");
  notePath.setAttribute("stroke", "currentColor");
  notePath.setAttribute("stroke-width", "1.2");
  notePath.setAttribute("stroke-linecap", "round");
  notePath.setAttribute("stroke-dasharray", "1");
  notePath.setAttribute("stroke-dashoffset", "1");

  // Everything above is a picture. The stage is not hidden from assistive technology as a
  // whole, because the Skip button lives in it and must stay reachable; instead each decorative
  // branch is hidden, so a screen reader finds the controls and nothing else.
  for (const picture of [
    sky,
    flash,
    grain,
    edge,
    camera,
    headline,
    caption,
    counter,
    note,
  ]) {
    picture.setAttribute("aria-hidden", "true");
  }

  const tools = el("div", "intro__tools", root);
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Intro film");
  const skip = el("button", "intro__skip", tools);
  skip.type = "button";
  skip.textContent = "Skip intro";
  const sound = el("button", "intro__sound", tools);
  sound.type = "button";
  sound.setAttribute("aria-pressed", "false");
  sound.setAttribute("aria-label", "Sound off");
  sound.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<path class="intro__soundCone" d="M3 8h3l4-3v10l-4-3H3z" />' +
    '<path class="intro__soundWave" d="M13 7.2c1.1 1.1 1.1 4.5 0 5.6" />' +
    '<path class="intro__soundWave intro__soundWave--far" d="M15.2 5c2.2 2.2 2.2 7.8 0 10" />' +
    "</svg>";

  host.appendChild(root);

  // ---- state ---------------------------------------------------------------
  let metrics: CaptionMetrics = FALLBACK_METRICS;
  let captionData: Caption | null = null;
  let dotsData: DotField | null = null;
  let field: DotsField | null = null;
  let layout = layoutFilm(viewportOf(), metrics);
  /** Where the lights beat leaves the camera: a pull-back, a pan, and sometimes a lift. */
  let pullScale = 1;
  let pullPan = 0;
  let pullLift = 0;
  let scan = 0;
  let twice = 0;
  let collapse = 0;
  let glow = 0;
  let destroyed = false;
  let lastCount = -1;
  let twiceBeat = 0;
  let labelItems: Array<{ el: HTMLDivElement; threshold: number }> = [];
  let tickers: readonly [string, string] = [...FALLBACK_TICKERS];
  let resizeFrame = 0;

  /** The phone's dot budget, and the index remap its labels need. */
  let cappedField: DotField | null = null;
  let cappedSource: DotField | null = null;
  let cappedIndexMap: Int32Array | null = null;

  function viewportOf(): { width: number; height: number } {
    const rect = host.getBoundingClientRect();
    const width = rect.width > 1 ? rect.width : window.innerWidth;
    const height = rect.height > 1 ? rect.height : window.innerHeight;
    return { width, height };
  }

  function copyHeadline(): string {
    const real = document.querySelector<HTMLElement>("h1.title");
    const text = real?.textContent?.trim();
    return text && text.length > 0 ? text : FALLBACK_HEADLINE;
  }

  function fillWord(element: HTMLDivElement): void {
    // Deliberately one text node, not one inline-block span per letter: splitting a word into
    // boxes drops the font's kerning between them, so "VTI" would stop being the 1.934 em the
    // bake sampled and every dot would sit a little inside its letter. The word rises as a word.
    element.textContent = tickers[0];
  }

  function applyWord(element: HTMLDivElement, box: WordBox): void {
    element.style.left = `${box.left}px`;
    element.style.top = `${box.top}px`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
    element.style.fontSize = `${box.fontSize}px`;
    element.style.lineHeight = `${(box.ascent + box.descent) / box.fontSize}`;
  }

  function applyRect(element: HTMLElement, rect: Rect): void {
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${Math.max(RULE_HEIGHT, rect.height)}px`;
  }

  /**
   * The last frame is a page-like composition: the rule, centred, with the headline under it.
   *
   * The camera is what puts the rule there. During the lights beat it pulls back and pans so
   * that the *rendered* rule lands where this function decides, which is why its numbers are
   * computed once per layout and then interpolated by `setCamera` — the rule a View Transition
   * captures is its rendered box, so the headline has to start exactly where that box will be.
   *
   * The pull is what keeps the last frame clear of the edges on a phone: the rule is exactly as
   * wide as the word (1.934 em each), so at 80% of a 390 px frame it is already 312 px of a
   * 326 px margin — panning it to the centre and pulling back a little is what gives the
   * headline underneath it room, at less cost than shrinking a word the brief asks to be 80%.
   */
  function placeFinalFrame(): void {
    const { width, height } = layout.viewport;
    const cx = width / 2;
    const cy = height / 2;
    const ruleWidth = Math.max(1, layout.rule.width);
    pullScale = Math.min(PULL_LANDSCAPE, Math.max(PULL_FLOOR, (width - 64) / ruleWidth));

    const renderedLeft = cx + (layout.rule.left - cx) * pullScale;
    const renderedTop = cy + (layout.rule.top - cy) * pullScale;
    const renderedWidth = ruleWidth * pullScale;
    // Pan so the collapsed line is centred: it is left-aligned with word A, so the line sits
    // right of the frame's centre until the camera corrects for it.
    pullPan = cx - (renderedLeft + renderedWidth / 2);

    const headlineWidth = Math.max(160, Math.min(renderedWidth, width - 24));
    headline.style.width = `${headlineWidth}px`;
    // Measured, not guessed: the headline is in the DOM from the first paint, so its height at
    // this width is already known long before the beat that reveals it.
    const block = headline.offsetHeight || 0;
    const top = renderedTop + layout.rule.height + 30;
    const overflow = top + block - (height - 28);
    // Lift only when the headline would actually run off the bottom: on a tall frame the
    // composition is already where it should be, and a camera move for its own sake is noise.
    pullLift = overflow > 0 ? Math.min(overflow, height * 0.28) : 0;

    headline.style.left = `${(renderedLeft + pullPan).toFixed(2)}px`;
    headline.style.top = `${(top - pullLift).toFixed(2)}px`;
  }

  function placeNote(): void {
    const portrait = layout.portrait;
    if (portrait) {
      note.style.left = `${layout.a.left}px`;
      note.style.top = `${Math.min(
        layout.viewport.height - 130,
        layout.b.top + layout.b.height + 28,
      )}px`;
      return;
    }
    const right = layout.a.left + layout.a.width;
    note.style.left = `${Math.min(
      layout.viewport.width - 250,
      right + Math.max(16, Math.min(36, (layout.viewport.width - right - 24) / 2)),
    )}px`;
    note.style.top = `${layout.a.top + layout.a.height * 0.5}px`;
  }

  function winkPoint(): { x: number; y: number } {
    const source = stageField();
    const dot = source !== null ? edgeDot(source, layout) : null;
    if (dot !== null) return { x: dot.x, y: dot.y };
    return {
      x: layout.a.left + layout.a.width - layout.a.fontSize * 0.12,
      y: layout.a.top + layout.a.height * 0.34,
    };
  }

  function placeBLabel(): void {
    bLabel.style.left = `${layout.b.left}px`;
    bLabel.style.top = `${layout.b.top - (layout.portrait ? 24 : 28)}px`;
  }

  function placeWink(): void {
    const point = winkPoint();
    wink.style.left = `${point.x}px`;
    wink.style.top = `${point.y}px`;
  }

  // ---- the dot field -------------------------------------------------------
  function stageField(): DotField | null {
    if (dotsData === null || dotsData.count === 0) return null;
    if (!layout.portrait || dotsData.count <= PORTRAIT_DOT_CAP) {
      cappedField = null;
      cappedSource = null;
      cappedIndexMap = null;
      return dotsData;
    }
    if (cappedField === null || cappedSource !== dotsData) {
      const capped = capField(dotsData, PORTRAIT_DOT_CAP);
      cappedField = capped.field;
      cappedSource = dotsData;
      cappedIndexMap = capped.indexMap;
    }
    return cappedField;
  }

  function stageCaption(): Caption | null {
    if (captionData === null) return null;
    const map = cappedIndexMap;
    if (map === null) return captionData;
    const labels = captionData.labels
      .map((label) => {
        if (label.index === undefined) return label;
        const mapped = map[label.index] ?? -1;
        return mapped < 0 ? null : { ...label, index: mapped };
      })
      .filter((label): label is Caption["labels"][number] => label !== null);
    return { ...captionData, labels };
  }

  function fieldBoxes(): { a: Rect; b: Rect } {
    const { a, b } = layout;
    return {
      a: { left: a.left, top: a.top, width: a.width, height: a.height },
      // See the file header: B's box is an em frame, `advanceA · fontSizeB` wide.
      b: { left: b.left, top: b.top, width: a.advance * b.fontSize, height: b.height },
    };
  }

  /** The renderer's scan is a fraction of the *word box*; ours is a fraction of the frame. */
  function rendererScan(): number {
    const along =
      layout.axis === "x"
        ? layout.scanStartPx + scan * layout.scanExtentPx - layout.a.left
        : layout.scanStartPx + scan * layout.scanExtentPx - layout.a.top;
    const extent = layout.axis === "x" ? layout.a.width : layout.a.height;
    return clamp01(along / Math.max(1, extent));
  }

  function syncField(): void {
    if (field === null) return;
    const boxes = fieldBoxes();
    field.setMetrics(layout.a.advance, metrics.a.ascender, metrics.a.descender);
    if (twiceBeat > 0) field.setTwiceBeat(twiceBeat);
    field.setBoxes(boxes.a, boxes.b);
    field.setScan(rendererScan());
    field.setTwice(twice);
    field.setCollapse(collapse);
    field.setGlow(glow);
    field.setCamera(0);
    field.resize();
  }

  function rebuildField(): void {
    if (field !== null) {
      try {
        field.destroy();
      } catch {
        /* already lost */
      }
      field = null;
    }
    const source = stageField();
    if (source === null) return;
    try {
      field = createDotsField(canvas, { count: source.count, raw: source.raw });
    } catch {
      field = null;
    }
    syncField();
  }

  // ---- labels --------------------------------------------------------------
  function clearLabels(): void {
    for (const item of labelItems) item.el.remove();
    labelItems = [];
  }

  function buildLabels(): void {
    clearLabels();
    const source = stageField();
    const caption = stageCaption();
    if (source === null || caption === null) return;
    for (const anchor of labelAnchors(source, caption, layout)) {
      const node = el("div", "intro__label", labels);
      node.textContent = anchor.ticker;
      node.style.left = `${anchor.left}px`;
      node.style.top = `${anchor.top}px`;
      labelItems.push({ el: node, threshold: anchor.threshold });
    }
    applyLabelProgress();
  }

  function applyLabelProgress(): void {
    for (const item of labelItems) {
      const k = clamp01((scan - item.threshold) / 0.035);
      item.el.style.opacity = `${k}`;
      item.el.style.transform = `translateX(${((1 - k) * -8).toFixed(2)}px)`;
    }
  }

  // ---- layout --------------------------------------------------------------
  function applyLayout(): void {
    root.classList.toggle("intro--portrait", layout.portrait);
    root.style.setProperty("--intro-scan", `${layout.scanStartPct}%`);
    applyWord(solidWord, layout.a);
    applyWord(openWord, layout.a);
    applyRect(rule, layout.rule);
    placeFinalFrame();
    placeNote();
    placeBLabel();
    placeWink();
    buildLabels();
    syncField();
    setScan(scan);
    setGlow(glow);
  }

  function relayout(): void {
    if (destroyed) return;
    layout = layoutFilm(viewportOf(), metrics);
    applyLayout();
    rebuildField();
    applyLayout();
  }

  function onResize(): void {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      relayout();
    });
  }
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", onResize);

  // ---- the render loop -----------------------------------------------------
  const tick = (): void => {
    field?.render();
  };
  gsap.ticker.add(tick);

  // ---- setters -------------------------------------------------------------
  function setScan(p: number): void {
    scan = clamp01(p);
    const pct = layout.scanStartPct + scan * (layout.scanEndPct - layout.scanStartPct);
    root.style.setProperty("--intro-scan", `${pct}%`);
    const total = captionData?.a.companies ?? null;
    if (total !== null) {
      const count = Math.round(scan * total);
      if (count !== lastCount) {
        lastCount = count;
        counterValue.textContent = formatCount(count);
      }
    }
    applyLabelProgress();
    field?.setScan(rendererScan());
  }

  function setGlow(g: number): void {
    glow = clamp01(g);
    root.style.setProperty("--intro-glow", `${glow}`);
    field?.setGlow(glow);
  }

  function setCamera(z: number): void {
    // One transform over the whole composition: a push in (z > 0) for the ticker, and a pull
    // back, a pan and a lift (z < 0) that sets the last frame.
    const pull = z < 0 ? clamp01(-z / PULL_DEPTH) : 0;
    const scale = z >= 0 ? 1 + z * PUSH_GAIN : 1 + (pullScale - 1) * pull;
    camera.style.transform =
      z < 0
        ? `translate(${(pullPan * pull).toFixed(2)}px, ${(-pullLift * pull).toFixed(2)}px) ` +
          `scale(${scale.toFixed(4)})`
        : `scale(${scale.toFixed(4)})`;
    field?.setCamera(clamp01(z));
  }

  function setSound(on: boolean): void {
    sound.setAttribute("aria-pressed", on ? "true" : "false");
    sound.setAttribute("aria-label", on ? "Sound on" : "Sound off");
    sound.classList.toggle("intro__sound--on", on);
  }

  function attach(data: FilmData): void {
    if (destroyed) return;
    if (data.caption !== null) {
      captionData = data.caption;
      metrics = data.caption.metrics;
      layout = layoutFilm(viewportOf(), metrics);
      if (data.caption.a.ticker !== tickers[0]) {
        tickers = [data.caption.a.ticker, data.caption.b.ticker];
        fillWord(solidWord);
        fillWord(openWord);
      }
      captionTicker.textContent = data.caption.a.ticker;
      captionFiled.textContent = formatFiledLine(data.caption.a.filed_at);
      shared.textContent = sharedLine(data.caption) ?? "";
      counterValue.textContent = "0";
      lastCount = -1;
    }
    if (data.dots !== null && data.dots.count > 0) {
      dotsData = data.dots;
      cappedField = null;
      cappedSource = null;
      cappedIndexMap = null;
    }
    applyLayout();
    rebuildField();
    applyLayout();
  }

  // ---- public object -------------------------------------------------------
  fillWord(solidWord);
  fillWord(openWord);
  const refs: ScreenRefs = {
    root,
    wordA: solidWord,
    openWord,
    dotsLayer,
    scanBar,
    labels,
    caption,
    counter,
    counterValue,
    shared,
    bLabel,
    bTyped,
    get bTicker(): string {
      return tickers[1];
    },
    bCaret,
    note,
    noteText,
    notePath,
    rule,
    headline,
    wink,
    flash,
    grain,
    edge,
    tools,
    skip,
    sound,
  };

  setSound(false);
  applyLayout();

  return {
    refs,
    get layout(): FilmLayout {
      return layout;
    },
    get hasDots(): boolean {
      return field !== null;
    },
    get hasData(): boolean {
      return captionData !== null;
    },
    attach,
    setScan,
    setTwice(p: number): void {
      twice = clamp01(p);
      field?.setTwice(twice);
    },
    setCollapse(p: number): void {
      collapse = clamp01(p);
      field?.setCollapse(collapse);
    },
    setGlow,
    setCamera,
    setTwiceBeat(ms: number): void {
      twiceBeat = ms;
      field?.setTwiceBeat(ms);
    },
    warmSky(): void {
      // Set on the sky itself, so the registered `@property` starts its transition now while
      // the chrome that sits on the table stays light until the paper has arrived.
      sky.style.setProperty("--intro-sky", "var(--paper)");
    },
    lightUp(): void {
      root.classList.add("intro--lit");
    },
    relayout,
    setSound,
    render(): void {
      field?.render();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      gsap.ticker.remove(tick);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      clearLabels();
      try {
        field?.destroy();
      } catch {
        /* a lost context is already dead */
      }
      field = null;
      root.remove();
    },
  };
}
