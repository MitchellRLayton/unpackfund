/**
 * The film's geometry: two word boxes, the rule they collapse onto, the axis the scan
 * travels, and the twelve labels' anchors — all as numbers, computed once from the viewport.
 *
 * Everything here is pure and viewport-in. The screen turns it into inline styles and the
 * renderer turns it into clip-space uniforms; both need to agree to the pixel, because the
 * dots *are* the letters after the scan passes, and a two-pixel disagreement reads as a
 * mistake rather than as a style.
 *
 * Two of the numbers carry a decision rather than a measurement:
 *
 * - The word width is 60% of the frame on a landscape viewport and 80% on a portrait one.
 *   That is the brief, and it is also the only way "VTI" survives a 390 px phone at a legible
 *   size: at 60% the caps are 8% of the height, at 80% they are 13%.
 * - The scan runs left→right on a landscape frame and top→bottom on a portrait one. The axis
 *   is one value, because the mask, the bar and the label thresholds must all agree about it.
 */

import {
  RECORD_FLOATS,
  dotRecord,
  type Caption,
  type CaptionMetrics,
  type DotField,
} from "./types";

/** A rectangle in viewport CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A word, placed: its em box, the font size that fills it, and its metrics in px. */
export interface WordBox extends Rect {
  /** The font size the box was sized for. */
  fontSize: number;
  /** Advance width in em units (measured when the font is present, else baked). */
  advance: number;
  /** Height of the em box above the baseline, in px. */
  ascent: number;
  /** Depth below the baseline, in px. */
  descent: number;
}

/** Where the twelve mono labels sit, and when the bar reaches them. */
export interface LabelAnchor {
  ticker: string;
  name: string;
  left: number;
  top: number;
  /** Scan progress (0..1) at which the bar passes this label's company. */
  threshold: number;
}

/** Everything the stage needs to place itself, for one viewport. */
export interface FilmLayout {
  viewport: { width: number; height: number };
  portrait: boolean;
  a: WordBox;
  b: WordBox;
  rule: Rect;
  /** The axis the scan travels: x on landscape, y on portrait. */
  axis: "x" | "y";
  /** Where the scan starts and ends, as percentages of the frame along `axis`. */
  scanStartPct: number;
  scanEndPct: number;
  /** The same start and length in px, for turning a label's position into a threshold. */
  scanStartPx: number;
  scanExtentPx: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * The bake's metrics for a bake that is not here yet.
 *
 * They are Newsreader's proportions, not a measurement of the artifact: a film that is
 * waiting for `/intro/caption.json` must still lay out at the right size, and when the
 * artifact arrives the metrics it brings replace these. `rule.y` deliberately puts the rule
 * below the baseline, which is where the collapse is asked to land.
 */
export const FALLBACK_METRICS: CaptionMetrics = {
  unitsPerEm: 1000,
  a: { advance: 1.93, ascender: 0.77, descender: 0.23 },
  b: { advance: 2.41, ascender: 0.77, descender: 0.23 },
  rule: { width: 2.6, y: 0.62 },
};

/** The word's target width, as a share of the frame. */
const WORD_WIDTH = { landscape: 0.6, portrait: 0.8 } as const;
/** B's font size relative to A's. */
const B_SCALE = { landscape: 0.54, portrait: 0.66 } as const;
/** A's em-box top, as a share of the frame height. */
const A_TOP = { landscape: 0.36, portrait: 0.18 } as const;
/** Space between A's box and B's box. */
const AB_GAP = { landscape: 0.055, portrait: 0.065 } as const;
/** The scan's bleed past the word box, on each side. */
const SCAN_BLEED = { landscape: 0.05, portrait: 0.035 } as const;
/** A label's assumed box, in px, for choosing its side of the dot. */
const LABEL_WIDTH = 56;
const LABEL_HEIGHT = 17;
/** Labels per frame: the brief's twelve, and the six a phone can hold without collisions. */
const LABELS_LANDSCAPE = 12;
const LABELS_PORTRAIT = 6;

/** A word's metrics in px at a given font size, with the descender's sign normalised. */
export function wordBoxMetrics(
  metrics: { advance: number; ascender: number; descender: number },
  fontSize: number,
): { advance: number; ascent: number; descent: number } {
  const advance =
    Number.isFinite(metrics.advance) && metrics.advance > 0.2 ? metrics.advance : 1.9;
  const ascentRaw = Number.isFinite(metrics.ascender) ? Math.abs(metrics.ascender) : 0.75;
  const descentRaw = Number.isFinite(metrics.descender)
    ? Math.abs(metrics.descender)
    : 0.25;
  const ascent = (ascentRaw > 0.1 ? ascentRaw : 0.75) * fontSize;
  const descent = (descentRaw > 0.02 ? descentRaw : 0.25) * fontSize;
  return { advance, ascent, descent };
}

/** Portrait is decided by the frame, not by a media query: the film owns its own stage. */
export function isPortrait(viewport: Viewport): boolean {
  return viewport.height > viewport.width * 1.05;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Place the two words, the rule, and the scan, for one viewport.
 *
 * `advance` is the measured advance of each word (em units). The film measures it from the
 * real font once it is loaded, because the baked number is only as good as the font stack
 * that rendered it; the baked metrics remain the fallback and the source of `ascender`,
 * `descender` and the rule.
 */
export function layoutFilm(
  viewport: Viewport,
  metrics: CaptionMetrics = FALLBACK_METRICS,
  advance: { a?: number; b?: number } = {},
): FilmLayout {
  const width = Math.max(240, viewport.width);
  const height = Math.max(320, viewport.height);
  const portrait = isPortrait({ width, height });

  const aMetrics = wordBoxMetrics(
    { ...metrics.a, advance: advance.a ?? metrics.a.advance },
    1,
  );
  const bMetrics = wordBoxMetrics(
    { ...metrics.b, advance: advance.b ?? metrics.b.advance },
    1,
  );

  // 60% of the frame, unless that would be tall enough to eat the second word.
  const targetWidth = width * WORD_WIDTH[portrait ? "portrait" : "landscape"];
  const heightCap = height * (portrait ? 0.36 : 0.5);
  const aFont = Math.max(
    16,
    Math.min(targetWidth / aMetrics.advance, heightCap / aMetrics.ascent),
  );
  const aWidth = aMetrics.advance * aFont;
  const aBoxHeight = (aMetrics.ascent + aMetrics.descent) * aFont;
  const aBoxTop = portrait
    ? height * A_TOP.portrait
    : Math.max(height * 0.06, height * A_TOP.landscape - aBoxHeight / 2);

  const a: WordBox = {
    left: (width - aWidth) / 2,
    top: aBoxTop,
    width: aWidth,
    height: aBoxHeight,
    fontSize: aFont,
    advance: aMetrics.advance,
    ascent: aMetrics.ascent * aFont,
    descent: aMetrics.descent * aFont,
  };

  const bFont = aFont * B_SCALE[portrait ? "portrait" : "landscape"];
  const bWidth = bMetrics.advance * bFont;
  const b: WordBox = {
    left: (width - bWidth) / 2,
    top: a.top + a.height + height * AB_GAP[portrait ? "portrait" : "landscape"],
    width: bWidth,
    height: (bMetrics.ascent + bMetrics.descent) * bFont,
    fontSize: bFont,
    advance: bMetrics.advance,
    ascent: bMetrics.ascent * bFont,
    descent: bMetrics.descent * bFont,
  };

  // The rule, read literally from the bake: the origin is the ticker line's baseline's left
  // edge, y down, so its y is an em value below that baseline. A value that would put the
  // rule inside the letters (or off the frame) is treated as a bake defect, and the film's
  // own line, under the second word, is used instead.
  const baselineA = a.top + a.ascent;
  const ruleWidth = metrics.rule.width * a.fontSize;
  const ruleTop = baselineA + metrics.rule.y * a.fontSize;
  const saneRule =
    Number.isFinite(ruleTop) &&
    Number.isFinite(ruleWidth) &&
    ruleWidth > a.width * 0.2 &&
    ruleWidth < a.width * 4 &&
    ruleTop > a.top + a.height * 0.6 &&
    ruleTop < height * 0.96;
  // The rule is left-aligned with word A's origin, not centred: the renderer maps a dot's `rx`
  // through `left + rx · fontSize`, so rx = 0 is word A's left edge and rx = rule.width is the
  // far end of the line. `rule.width` equals `a.advance` (1.934 em), so the line is exactly as
  // wide as the first word; centring it instead would put the DOM rule where the dots are not.
  const rule: Rect = saneRule
    ? { left: a.left, top: ruleTop, width: ruleWidth, height: 2 }
    : {
        left: a.left,
        top: Math.min(height * 0.9, b.top + b.height + height * 0.06),
        width: a.width * 1.1,
        height: 2,
      };

  const axis: "x" | "y" = portrait ? "y" : "x";
  const frameExtent = portrait ? height : width;
  const bleed = frameExtent * SCAN_BLEED[portrait ? "portrait" : "landscape"];
  const startPx = portrait ? a.top - bleed : a.left - bleed;
  const endPx = portrait ? a.top + a.height + bleed : a.left + a.width + bleed;

  return {
    viewport: { width, height },
    portrait,
    a,
    b,
    rule,
    axis,
    scanStartPct: (startPx / frameExtent) * 100,
    scanEndPct: (endPx / frameExtent) * 100,
    scanStartPx: startPx,
    scanExtentPx: Math.max(1, endPx - startPx),
  };
}

/**
 * The scan's position curve: fast at both ends, slow through the middle.
 *
 * The brief asks for a sweep that gets going, hangs over the companies long enough to read
 * them, then leaves. Position `p = t + a·sin(2πt)/(2π)` has velocity `1 + a·cos(2πt)`:
 * with `a = 0.82` it moves at 1.82× at the ends and 0.18× in the middle, and stays
 * monotonic (velocity never reaches zero), so a counter driven from it never runs backwards.
 */
export const SCAN_EASE_AMOUNT = 0.82;

export function scanEase(t: number): number {
  const time = clamp(t, 0, 1);
  const p = time + (SCAN_EASE_AMOUNT / (Math.PI * 2)) * Math.sin(Math.PI * 2 * time);
  return clamp(p, 0, 1);
}

/** The inverse of `scanEase`, used to place a cue where the bar reaches a given position. */
export function timeForScan(p: number): number {
  const target = clamp(p, 0, 1);
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (scanEase(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Keep at most `limit` companies, choosing the heaviest — a phone's field is capped at 2,000
 * dots by the brief, and dropping the smallest companies is the only cap that still draws the
 * shape of the fund.
 *
 * `indexMap` says where an original record went: `-1` for one that was dropped. The labels
 * are joined to records by their original index, so the map is what keeps them attached after
 * a cap; the top of the weight distribution is always kept, so no label is ever dropped.
 */
export function capField(
  field: DotField,
  limit: number,
): { field: DotField; indexMap: Int32Array } {
  const indexMap = new Int32Array(field.count).fill(-1);
  if (limit <= 0 || field.count <= limit) {
    for (let index = 0; index < field.count; index += 1) indexMap[index] = index;
    return { field, indexMap };
  }

  const order = Array.from({ length: field.count }, (_, index) => index);
  order.sort((x, y) => {
    const wx = field.raw[x * RECORD_FLOATS] ?? 0;
    const wy = field.raw[y * RECORD_FLOATS] ?? 0;
    return wy - wx || x - y;
  });
  const keep = order.slice(0, limit).sort((x, y) => x - y);

  const raw = new Float32Array(limit * RECORD_FLOATS);
  keep.forEach((from, into) => {
    raw.set(
      field.raw.subarray(from * RECORD_FLOATS, from * RECORD_FLOATS + RECORD_FLOATS),
      into * RECORD_FLOATS,
    );
    indexMap[from] = into;
  });
  return { field: { count: limit, raw }, indexMap };
}

/** A dot's screen position, from its record and the word box it sits in. */
export function dotPoint(
  record: { vx: number; vy: number },
  word: WordBox,
): { x: number; y: number } {
  return {
    x: word.left + record.vx * word.fontSize,
    y: word.top + word.ascent + record.vy * word.fontSize,
  };
}

/**
 * How many mono labels a frame can carry.
 *
 * Twelve is the brief's number and it works on a laptop, where the word is 864 px wide. A
 * phone gives the word 312 px, and twelve 56 px labels then overlap each other and the
 * letters; six — the six heaviest, which is the order the bake already sorts them in — stay
 * legible and still read as "the largest companies". The lead's call, 2026-11-03.
 */
export function labelBudget(portrait: boolean): number {
  return portrait ? LABELS_PORTRAIT : LABELS_LANDSCAPE;
}

/**
 * Where each label is printed, and when the bar reaches it.
 *
 * The exact join is the bake's `index` (the record's place in `dots.bin`). The rank match is
 * the guard for a bake that predates that field: both sequences are sorted by weight, so the
 * n-th heaviest label is put on the n-th heaviest record. It is an approximation, which is
 * why the exact join is used whenever it is present.
 */
export function labelAnchors(
  field: DotField,
  caption: Caption,
  layout: FilmLayout,
): LabelAnchor[] {
  if (field.count === 0 || caption.labels.length === 0) return [];

  const exact = caption.labels.every(
    (label) => label.index !== undefined && label.index >= 0 && label.index < field.count,
  );

  let recordFor: (labelIndex: number) => number;
  if (exact) {
    recordFor = (labelIndex) => caption.labels[labelIndex]?.index ?? -1;
  } else {
    const byWeight = caption.labels
      .map((label, labelIndex) => ({ labelIndex, weight: label.weight }))
      .sort((x, y) => y.weight - x.weight || x.labelIndex - y.labelIndex);
    const ranked = Array.from({ length: field.count }, (_, index) => index).sort(
      (x, y) => {
        const wx = field.raw[x * RECORD_FLOATS] ?? 0;
        const wy = field.raw[y * RECORD_FLOATS] ?? 0;
        return wy - wx || x - y;
      },
    );
    const assignment = new Map<number, number>();
    byWeight.forEach((entry, rank) => {
      const record = ranked[rank];
      if (record !== undefined && !assignment.has(entry.labelIndex)) {
        assignment.set(entry.labelIndex, record);
      }
    });
    recordFor = (labelIndex) => assignment.get(labelIndex) ?? -1;
  }

  const { width, height } = layout.viewport;
  const anchors: LabelAnchor[] = [];
  // The bake sorts labels by weight, so the budget takes the heaviest ones.
  caption.labels.slice(0, labelBudget(layout.portrait)).forEach((label, labelIndex) => {
    const recordIndex = recordFor(labelIndex);
    if (recordIndex < 0) return;
    const record = dotRecord(field.raw, recordIndex);
    if (record === null) return;
    const point = dotPoint(record, layout.a);
    const along = layout.axis === "x" ? point.x : point.y;
    const threshold = clamp((along - layout.scanStartPx) / layout.scanExtentPx, 0, 1);

    const right = point.x + 9;
    const fitsRight = right + LABEL_WIDTH <= width - 10;
    const left = clamp(
      fitsRight ? right : point.x - 9 - LABEL_WIDTH,
      10,
      width - LABEL_WIDTH - 10,
    );
    const top = clamp(point.y - LABEL_HEIGHT / 2, 10, height - LABEL_HEIGHT - 10);
    anchors.push({ ticker: label.ticker, name: label.name, left, top, threshold });
  });
  return anchors;
}

/**
 * The dot the `hold` beat winks at: the heaviest company at the right-hand edge of the word,
 * so the wink happens at the edge of the composition rather than in the middle of it.
 *
 * `null` when there is no field, which is a film without dots — the caller then places its
 * wink against the word box instead.
 */
export function edgeDot(
  field: DotField,
  layout: FilmLayout,
): { x: number; y: number; w: number } | null {
  if (field.count === 0) return null;
  const edge = layout.a.advance * 0.86;
  let best: { x: number; y: number; w: number } | null = null;
  let fallback: { x: number; y: number; w: number } | null = null;
  for (let index = 0; index < field.count; index += 1) {
    const record = dotRecord(field.raw, index);
    if (record === null) continue;
    const point = dotPoint(record, layout.a);
    const candidate = { x: point.x, y: point.y, w: record.w };
    if (fallback === null || record.w > fallback.w) fallback = candidate;
    if (record.vx >= edge && record.vx <= layout.a.advance - 0.02) {
      if (best === null || record.w > best.w) best = candidate;
    }
  }
  return best ?? fallback;
}
