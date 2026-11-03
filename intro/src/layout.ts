/**
 * Where everything sits, in world units (0,0 = the centre of the stage).
 *
 * The field is packed as *units*: a single company, or a shared company's two
 * halves tied together as one double-dot. Units are seeded by area on a
 * phyllotaxis spiral — which is already a dense disc — grouped by sector, then
 * relaxed until nothing overlaps. That is what makes it read as a packed bubble
 * field rather than a scatter, and it is deterministic: no `Math.random`, fixed
 * seed, same field on every load and every resize.
 *
 * In the real intro (phase 3) this same pass runs on the GPU as a compute
 * shader. The animatic keeps it in JS so timing review does not wait on WebGPU,
 * and so the two can be diffed against identical inputs.
 */

import type { DotSpec } from "./sample";
import { clamp } from "./util";

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

export type FieldGeometry = {
  /** Pre-merge home of every dot, indexed like `dots`. */
  dots: Packed[];
  /** Per shared pair: where each half sits, and where they fuse. */
  pairs: MergeGeometry[];
  /** The compressed ledger line: one slot per surviving dot. */
  line: Array<{ x: number; y: number; r: number }>;
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

const SECTORS = 11;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Base radius from filed weight: area-proportional, with a floor and a ceiling. */
function radiusFor(weightBp: number, maxWeight: number): number {
  return 10 + 13 * Math.sqrt(clamp(weightBp / maxWeight, 0, 1));
}

type Unit = {
  /** Dot indices this unit covers: one, or a shared pair's two halves. */
  dots: number[];
  /** Bounding radius, used for separation. */
  r: number;
  /** Area-equivalent radius, used for spacing. */
  area: number;
  sector: number;
  x: number;
  y: number;
  /** Sector centre this unit belongs to, for the cohesion term. */
  home: Vec;
};

export function layoutField(
  dots: DotSpec[],
  pairs: Array<[number, number]>,
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
        sector: dot.sector,
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
      sector: dot.sector,
      x: 0,
      y: 0,
      home: { x: 0, y: 0 },
    });
    used.add(index);
    used.add(other);
  });

  // ---- sector centres, biggest sector in the middle.
  const bySector = new Map<number, Unit[]>();
  units.forEach((unit) => {
    const list = bySector.get(unit.sector) ?? [];
    list.push(unit);
    bySector.set(unit.sector, list);
  });
  const sectorIds = [...bySector.keys()].sort((a, b) => {
    const areaOf = (id: number): number =>
      (bySector.get(id) ?? []).reduce((sum, unit) => sum + unit.area * unit.area, 0);
    return areaOf(b) - areaOf(a);
  });

  const centres: Vec[] = [];
  let sectorArea = 0;
  const totalArea = [...bySector.values()].reduce(
    (sum, list) => sum + list.reduce((inner, unit) => inner + unit.area * unit.area * Math.PI, 0),
    0,
  );
  void totalArea;
  sectorIds.forEach((id, rank) => {
    const list = bySector.get(id)!;
    const area = list.reduce((sum, unit) => sum + unit.area * unit.area * Math.PI, 0);
    const offset = sectorArea + area / 2;
    const radius = Math.sqrt(offset / Math.PI) * 1.12;
    const angle = rank * GOLDEN;
    centres.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    sectorArea += area;
    list.forEach((unit) => {
      unit.home = centres[centres.length - 1]!;
    });
  });

  // A wide frame wants a wide field: squash the seed, then let the relaxation
  // pull toward the squashed centres, so the dots stay perfectly round.
  const squash = portrait ? 0.96 : 0.66;
  centres.forEach((centre) => {
    centre.y *= squash;
  });

  // ---- seed each sector's units on their own phyllotaxis patch.
  sectorIds.forEach((id, sectorRank) => {
    const list = bySector.get(id)!;
    const centre = centres[sectorRank]!;
    list.sort((a, b) => b.area - a.area);
    let placed = 0;
    list.forEach((unit, index) => {
      const offset = placed + (unit.area * unit.area * Math.PI) / 2;
      const radius = Math.sqrt(offset / Math.PI) * 1.03;
      const angle = index * GOLDEN + sectorRank;
      unit.x = centre.x + Math.cos(angle) * radius;
      unit.y = centre.y + Math.sin(angle) * radius;
      unit.home = { x: centre.x, y: centre.y };
      placed += unit.area * unit.area * Math.PI;
    });
  });

  // ---- relax: separate, then pull home. Repeat until it settles.
  for (let pass = 0; pass < 320; pass += 1) {
    for (let i = 0; i < units.length; i += 1) {
      const p = units[i]!;
      for (let j = i + 1; j < units.length; j += 1) {
        const q = units[j]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const min = p.r + q.r + 3;
        if (distance >= min) continue;
        const push = (min - distance) * 0.5;
        const ux = dx / distance;
        const uy = dy / distance;
        p.x -= ux * push;
        p.y -= uy * push;
        q.x += ux * push;
        q.y += uy * push;
      }
    }
    for (const unit of units) {
      unit.x += (unit.home.x - unit.x) * 0.01;
      unit.y += (unit.home.y - unit.y) * 0.01;
    }
  }

  // ---- from units back to dots.
  const packed: Packed[] = new Array(dots.length);
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

  // ---- fit into the stage. One uniform scale, so a dot's area is still its
  // share of the two funds added together.
  const minX = Math.min(...packed.map((p) => p.x - p.r));
  const maxX = Math.max(...packed.map((p) => p.x + p.r));
  const minY = Math.min(...packed.map((p) => p.y - p.r));
  const maxY = Math.max(...packed.map((p) => p.y + p.r));
  // The caption owns the bottom-left of the stage, so the field sits high
  // enough to leave it the corner.
  const region = portrait
    ? { w: 820, h: 800, cx: 0, cy: -96 }
    : { w: 1180, h: 630, cx: 0, cy: -60 };
  const scale = Math.min(region.w / (maxX - minX), region.h / (maxY - minY), 3.6);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toRegion = (v: Vec): Vec => ({
    x: region.cx + (v.x - midX) * scale,
    y: region.cy + (v.y - midY) * scale,
  });
  packed.forEach((p) => {
    const next = toRegion(p);
    p.x = next.x;
    p.y = next.y;
    p.r *= scale;
  });
  mergeGeometry.forEach((merge) => {
    merge.a = toRegion(merge.a);
    merge.b = toRegion(merge.b);
    merge.mid = toRegion(merge.mid);
    merge.rA *= scale;
    merge.rB *= scale;
    merge.r *= scale;
  });

  // ---- the ledger line: every surviving company, one tick. Order is sector
  // then weight, so the line reads as a printed register, not a ranking.
  const partnerOf = new Map<number, [number, number]>();
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
    const si = dots[i]!.sector;
    const sj = dots[j]!.sector;
    if (si !== sj) return si - sj;
    return dots[j]!.weightBp - dots[i]!.weightBp;
  });
  const lineWidth = portrait ? 560 : 900;
  const step = survivors.length > 1 ? lineWidth / (survivors.length - 1) : 0;
  const line = survivors.map((_owner, index) => ({
    x: -lineWidth / 2 + index * step,
    y: 0,
    r: 4.4,
    owner: survivors[index]!,
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
    line: line.map(({ x, y, r }) => ({ x, y, r })),
    lineWidth,
    lineOwner: survivors,
    circleSlot,
    seamA: { x: cardA.x, y: cardA.y },
    seamB: { x: cardB.x, y: cardB.y },
    cardA,
    cardB,
    clusterCenters: centres,
    bounds: { minX, minY, maxX, maxY },
  };
}

/** Half the distance between a shared pair's two centres. */
function gap(ra: number, rb: number): number {
  return (ra + rb) * 0.52 + 4;
}

export const SECTOR_COUNT = SECTORS;
