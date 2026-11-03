/**
 * Where everything sits, in world units (0,0 = the centre of the stage).
 *
 * The field is packed as *units*: a single company, or a shared company's two halves tied
 * together as one double-dot. Units are seeded by area on a phyllotaxis spiral — which is
 * already a dense disc — grouped into eleven patches, then relaxed until nothing overlaps.
 * That is what makes it read as a packed bubble field rather than a scatter, and it is
 * deterministic: no `Math.random`, no clock, same field on every load.
 *
 * Ported from the approved animatic unchanged in structure. Four things are retuned for the
 * real field's scale (1,004 dots where the animatic drew 120), and nothing else:
 *
 * 1. A dot's radius comes from its filed weight on a square-root scale, clamped to
 *    2.2–11 world units — small enough that 1,004 of them read as a stipple rather than a
 *    pile of bubbles.
 * 2. The unit gap and the separation padding scale with the radii instead of being the
 *    animatic's fixed 4 and 3 units, which were a third of a 12-unit dot and would swallow
 *    a 3-unit one.
 * 3. The fit into the stage is capped at 2.4× (the animatic used 3.6×) because the packed
 *    field is proportionally smaller when every dot is smaller.
 * 4. The ledger line's tick radius follows the line's own step, so 504 ticks read as a
 *    ruled line rather than as 504 overlapping discs.
 *
 * The relaxation keeps the animatic's two terms — separate every overlapping pair, pull each
 * unit 1% back toward its patch centre — but runs them in sequence rather than interleaved;
 * see the comment at the loop for why. It compares squared distances before taking a square
 * root, because 504 units is a quarter of a million pair tests per pass.
 */

import { clusterOf, type DotSpec } from "./types";

export type Vec = { x: number; y: number };
export type Packed = { x: number; y: number; r: number };

export type MergeGeometry = {
  a: Vec;
  b: Vec;
  mid: Vec;
  rA: number;
  rB: number;
  /** The fused dot's radius: the two areas added, not the two radii. */
  r: number;
};

/** One slot on the compressed ledger line: a surviving company, one tick. */
export type LineSlot = { x: number; y: number; r: number };

export type FieldGeometry = {
  /** Pre-merge home of every dot, indexed like the dot list. */
  dots: Packed[];
  /** Per shared pair: where each half sits, and where they fuse. */
  pairs: MergeGeometry[];
  /** The compressed ledger line: one slot per surviving dot. */
  line: LineSlot[];
  lineWidth: number;
  /** Index into `dots` of the survivor each line slot belongs to. */
  lineOwner: number[];
  /** Which line slot the pencil circle loops. */
  circleSlot: number;
  /** The seam each card spills from. */
  seamA: Vec;
  seamB: Vec;
  cardA: Vec;
  cardB: Vec;
  clusterCenters: Vec[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** The eleven patches the field is seeded into. They no longer mean a sector. */
export const CLUSTER_COUNT = 11;

/** A dot's radius, in world units, before the field is fitted to the stage. */
export const DOT_MIN_R = 2.2;
export const DOT_MAX_R = 11;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Area-proportional radius from filed weight, with a floor and a ceiling. */
function radiusFor(weightBp: number, maxWeight: number): number {
  const share = Math.sqrt(clamp(weightBp / maxWeight, 0, 1));
  return DOT_MIN_R + (DOT_MAX_R - DOT_MIN_R) * share;
}

/** Half the distance between a shared pair's two centres. */
function gap(ra: number, rb: number): number {
  return (ra + rb) * 0.55 + 1.2;
}

type Unit = {
  /** Dot indices this unit covers: one, or a shared pair's two halves. */
  dots: number[];
  /** Bounding radius, used for separation. */
  r: number;
  /** Area-equivalent radius, used for spacing. */
  area: number;
  cluster: number;
  x: number;
  y: number;
  /** Patch centre this unit belongs to, for the cohesion term. */
  home: Vec;
};

export function layoutField(
  dots: readonly DotSpec[],
  pairs: ReadonlyArray<readonly [number, number]>,
  portrait: boolean,
): FieldGeometry {
  const maxWeight = Math.max(...dots.map((dot) => dot.weightBp), 1);
  const radii = dots.map((dot) => radiusFor(dot.weightBp, maxWeight));

  // ---- units: a lone company, or two halves of one shared company.
  const pairOf = new Map<number, number>();
  pairs.forEach(([a, b], index) => {
    pairOf.set(a, index);
    pairOf.set(b, index);
  });
  const used = new Set<number>();
  const units: Unit[] = [];
  dots.forEach((dot, index) => {
    if (used.has(index)) return;
    const partner = pairOf.get(index);
    if (partner === undefined) {
      units.push({
        dots: [index],
        r: radii[index]!,
        area: radii[index]!,
        cluster: dot.cluster,
        x: 0,
        y: 0,
        home: { x: 0, y: 0 },
      });
      used.add(index);
      return;
    }
    const pair = pairs[partner]!;
    const other = pair[0] === index ? pair[1] : pair[0];
    const ra = radii[index]!;
    const rb = radii[other]!;
    // Area-equivalent radius of the two together, then widened for the gap.
    const area = Math.sqrt(ra * ra + rb * rb);
    units.push({
      dots: [index, other],
      r: gap(ra, rb) + Math.max(ra, rb),
      area,
      cluster: dot.cluster,
      x: 0,
      y: 0,
      home: { x: 0, y: 0 },
    });
    used.add(index);
    used.add(other);
  });

  // ---- patch centres, biggest patch in the middle.
  const byCluster = new Map<number, Unit[]>();
  units.forEach((unit) => {
    const list = byCluster.get(unit.cluster) ?? [];
    list.push(unit);
    byCluster.set(unit.cluster, list);
  });
  const clusterIds = [...byCluster.keys()].sort((a, b) => {
    const areaOf = (id: number): number =>
      (byCluster.get(id) ?? []).reduce((sum, unit) => sum + unit.area * unit.area, 0);
    return areaOf(b) - areaOf(a);
  });

  const centres: Vec[] = [];
  let clusterArea = 0;
  clusterIds.forEach((id, rank) => {
    const list = byCluster.get(id)!;
    const area = list.reduce((sum, unit) => sum + unit.area * unit.area * Math.PI, 0);
    const offset = clusterArea + area / 2;
    const radius = Math.sqrt(offset / Math.PI) * 1.12;
    const angle = rank * GOLDEN;
    centres.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    clusterArea += area;
    list.forEach((unit) => {
      unit.home = centres[centres.length - 1]!;
    });
  });

  // A wide frame wants a wide field: squash the seed, then let the relaxation pull toward
  // the squashed centres, so the dots stay perfectly round.
  const squash = portrait ? 0.96 : 0.66;
  centres.forEach((centre) => {
    centre.y *= squash;
  });

  // ---- seed each patch's units on their own phyllotaxis spiral.
  clusterIds.forEach((_id, clusterRank) => {
    const list = byCluster.get(clusterIds[clusterRank]!)!;
    const centre = centres[clusterRank]!;
    list.sort((a, b) => b.area - a.area);
    let placed = 0;
    list.forEach((unit, index) => {
      const offset = placed + (unit.area * unit.area * Math.PI) / 2;
      const radius = Math.sqrt(offset / Math.PI) * 1.03;
      const angle = index * GOLDEN + clusterRank;
      unit.x = centre.x + Math.cos(angle) * radius;
      unit.y = centre.y + Math.sin(angle) * radius;
      unit.home = { x: centre.x, y: centre.y };
      placed += unit.area * unit.area * Math.PI;
    });
  });

  // ---- relax.
  //
  // The animatic interleaved the two terms — separate every overlapping pair, then pull each
  // unit 1% back toward its patch centre — for a fixed 320 passes. At 1,004 dots that
  // equilibrium still leaves 200 pairs interpenetrating by up to 11 world units: the pull is
  // permanent, so the field settles *into* overlap instead of out of it. Two interpenetrating
  // dots at 22% ink read as one darker dot, which would quietly lie about how many positions
  // the field holds, so the terms are run in sequence instead: settle (both terms, so the
  // patches keep their shape) and then separate until nothing overlaps. Same algorithm, same
  // shape, no interpenetration.
  const PAD = 1.2;
  const separate = (): void => {
    for (let i = 0; i < units.length; i += 1) {
      const p = units[i]!;
      for (let j = i + 1; j < units.length; j += 1) {
        const q = units[j]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const min = p.r + q.r + PAD;
        const spread = dx * dx + dy * dy;
        // Squared comparison first: 126,756 pairs a pass, and almost none of them are near.
        if (spread >= min * min) continue;
        const distance = Math.sqrt(spread) || 0.001;
        const push = (min - distance) * 0.5;
        const ux = dx / distance;
        const uy = dy / distance;
        p.x -= ux * push;
        p.y -= uy * push;
        q.x += ux * push;
        q.y += uy * push;
      }
    }
  };
  const PULL = 0.01;
  for (let pass = 0; pass < 100; pass += 1) {
    separate();
    for (const unit of units) {
      unit.x += (unit.home.x - unit.x) * PULL;
      unit.y += (unit.home.y - unit.y) * PULL;
    }
  }
  for (let pass = 0; pass < 260; pass += 1) {
    separate();
  }

  // ---- from units back to dots.
  const packed: Packed[] = new Array<Packed>(dots.length);
  const mergeGeometry: MergeGeometry[] = pairs.map(() => ({
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    mid: { x: 0, y: 0 },
    rA: 0,
    rB: 0,
    r: 0,
  }));
  units.forEach((unit) => {
    if (unit.dots.length === 1) {
      const index = unit.dots[0]!;
      packed[index] = { x: unit.x, y: unit.y, r: radii[index]! };
      return;
    }
    const [a, b] = unit.dots as [number, number];
    const pairIndex = pairOf.get(a)!;
    const ra = radii[a]!;
    const rb = radii[b]!;
    const d = gap(ra, rb);
    packed[a] = { x: unit.x - d, y: unit.y, r: ra };
    packed[b] = { x: unit.x + d, y: unit.y, r: rb };
    mergeGeometry[pairIndex] = {
      a: { x: unit.x - d, y: unit.y },
      b: { x: unit.x + d, y: unit.y },
      mid: { x: unit.x, y: unit.y },
      rA: ra,
      rB: rb,
      r: Math.sqrt(ra * ra + rb * rb),
    };
  });

  // ---- fit into the stage. One uniform scale, so a dot's area is still its share of the
  // two funds added together.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of packed) {
    if (point.x - point.r < minX) minX = point.x - point.r;
    if (point.x + point.r > maxX) maxX = point.x + point.r;
    if (point.y - point.r < minY) minY = point.y - point.r;
    if (point.y + point.r > maxY) maxY = point.y + point.r;
  }
  // The caption owns the bottom-left of the stage, so the field sits high enough to leave it
  // the corner.
  const region = portrait
    ? { w: 820, h: 800, cx: 0, cy: -96 }
    : { w: 1180, h: 630, cx: 0, cy: -60 };
  const scale = Math.min(
    region.w / Math.max(1, maxX - minX),
    region.h / Math.max(1, maxY - minY),
    2.4,
  );
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toRegion = (v: Vec): Vec => ({
    x: region.cx + (v.x - midX) * scale,
    y: region.cy + (v.y - midY) * scale,
  });
  packed.forEach((point) => {
    const next = toRegion(point);
    point.x = next.x;
    point.y = next.y;
    point.r *= scale;
  });
  mergeGeometry.forEach((merge) => {
    merge.a = toRegion(merge.a);
    merge.b = toRegion(merge.b);
    merge.mid = toRegion(merge.mid);
    merge.rA *= scale;
    merge.rB *= scale;
    merge.r *= scale;
  });

  // ---- the ledger line: every surviving company, one tick. Order is patch then weight, so
  // the line reads as a printed register, not a ranking.
  const partnerOf = new Map<number, readonly [number, number]>();
  pairs.forEach(([a, b]) => {
    partnerOf.set(a, [a, b]);
    partnerOf.set(b, [a, b]);
  });
  const survivors: number[] = [];
  const seen = new Set<number>();
  dots.forEach((_dot, index) => {
    const couple = partnerOf.get(index);
    if (!couple) {
      survivors.push(index);
      return;
    }
    const [a, b] = couple;
    if (!seen.has(a)) {
      seen.add(a);
      survivors.push(a);
    }
    seen.add(b);
  });
  survivors.sort((i, j) => {
    const si = dots[i]!.cluster;
    const sj = dots[j]!.cluster;
    if (si !== sj) return si - sj;
    return dots[j]!.weightBp - dots[i]!.weightBp;
  });
  const lineWidth = portrait ? 560 : 900;
  const step = survivors.length > 1 ? lineWidth / (survivors.length - 1) : 0;
  // A tick is a hairline lifted off the rule the ledger draws, not a disc: 504 of them land
  // on 900 world units, which is under two unit apart.
  const tickRadius = clamp(step * 0.85, 0.7, 2.6);
  const line: LineSlot[] = survivors.map((_owner, index) => ({
    x: -lineWidth / 2 + index * step,
    y: 0,
    r: tickRadius,
  }));

  // The pencil circles the heaviest company on the line.
  let circleSlot = 0;
  let biggest = -1;
  survivors.forEach((owner, slot) => {
    const weight = dots[owner]!.weightBp;
    if (weight > biggest) {
      biggest = weight;
      circleSlot = slot;
    }
  });

  const cardA: Vec = portrait ? { x: 0, y: -240 } : { x: -170, y: 46 };
  const cardB: Vec = portrait ? { x: 0, y: 30 } : { x: 316, y: 22 };

  return {
    dots: packed,
    pairs: mergeGeometry,
    line,
    lineWidth,
    lineOwner: survivors,
    circleSlot,
    seamA: { x: cardA.x, y: cardA.y },
    seamB: { x: cardB.x, y: cardB.y },
    cardA,
    cardB,
    clusterCenters: centres,
    bounds: {
      minX: toRegion({ x: minX, y: minY }).x,
      minY: toRegion({ x: minX, y: minY }).y,
      maxX: toRegion({ x: maxX, y: maxY }).x,
      maxY: toRegion({ x: maxX, y: maxY }).y,
    },
  };
}

/**
 * Expand the baked companies into the field's dots: one per held position.
 *
 * This is the film's whole argument in one function. 504 companies, but 1,004 positions —
 * because 500 of them are held by both funds — so a shared company becomes two dots that the
 * merge beat fuses back into one. `totals.held` (1,004) is what the field starts as and
 * `totals.distinct` (504) is what survives it.
 *
 * The first dot of a pair is the one the first card spills, and it is the dot that carries
 * the company's label and the fused radius; the second arrives with the second card.
 */
export function expandCompanies(
  companies: ReadonlyArray<{ k: "a" | "b" | "s"; w: number }>,
  labels: ReadonlyMap<number, string>,
): { dots: DotSpec[]; pairs: Array<[number, number]> } {
  const dots: DotSpec[] = [];
  const pairs: Array<[number, number]> = [];
  companies.forEach((company, index) => {
    const cluster = clusterOf(index);
    if (company.k === "b") {
      dots.push({ fund: 1, weightBp: company.w, shared: false, cluster, label: null });
      return;
    }
    const label = labels.get(index) ?? null;
    const first = dots.length;
    dots.push({
      fund: 0,
      weightBp: company.w,
      shared: company.k === "s",
      cluster,
      label,
    });
    if (company.k !== "s") return;
    const second = dots.length;
    dots.push({ fund: 1, weightBp: company.w, shared: true, cluster, label: null });
    pairs.push([first, second]);
  });
  return { dots, pairs };
}
