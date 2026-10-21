/**
 * Trench lines, planned before a voxel is written.
 *
 * A port of the planning half of the Python game's `_carve_trench_line`. Each
 * bay sets its floor from the ground above it, so the trench keeps a constant
 * depth through rolling ground, stepping at most one tread between bays. Each
 * fire bay then measures the ground it has to see over and raises its firing
 * step until a standing eye clears it, building its crest a fixed rise above
 * the bench: the peek is guaranteed bay by bay, whatever the terrain does.
 * Smoothing only ever raises a bay, so none loses the clearance it asked for.
 *
 * Everything is in voxels on two axes: `a` along the trench, `b` across it.
 */

import type { Rng } from '../../core/rng';
import { vx, type GenParams, type LineSpec } from './params';

export type RevetStyle = 'planks' | 'corrugated' | 'hurdles';

export interface BayPlan {
  line: string;
  index: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  groundY: number;
  floorY: number;
  stepTopY: number;
  crestY: number;
  stepLo: number;
  stepSpan: number;
  walkX: number;
  walkZ: number;
  longAxis: 0 | 2;
  facing: 1 | -1;
  firingSteps: boolean;
  revet: RevetStyle;
  seed: number;
}

export interface LegPlan {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  floorY: number;
  longAxis: 0 | 2;
}

export interface DugoutPlan {
  line: string;
  /** Index of the bay it opens off, in its line. */
  bay: number;
  /** Chamber air: [lo, hi) in world voxels. */
  lo: [number, number, number];
  hi: [number, number, number];
  entrance: [number, number, number];
  /** The passage from the trench wall to the chamber, in world x/z. */
  passage: { x0: number; x1: number; z0: number; z1: number };
  floorY: number;
  dugFloor: number;
  roofY: number;
  longAxis: 0 | 2;
  away: 1 | -1;
  seed: number;
}

export interface LinePlan {
  spec: LineSpec;
  bays: BayPlan[];
  legs: LegPlan[];
  dugouts: DugoutPlan[];
  /**
   * The floor at every voxel along the line, from `a0`, for a line that
   * crosses others (a communication trench): pinned to the floors it crosses,
   * stepping one tread at a time between. Lines without one floor each bay
   * at its own `floorY`.
   */
  profile?: { a0: number; floors: Int16Array };
}

type Surface = (x: number, z: number) => number;

function xz(longAxis: 0 | 2, a: number, b: number): [number, number] {
  return longAxis === 0 ? [a, b] : [b, a];
}

/** Python's `int(np.median(...))`: the mean of the two middle values when even, then truncated. */
function medianInt(values: number[]): number {
  const v = [...values].sort((p, q) => p - q);
  const n = v.length;
  const m = n % 2 === 1 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return Math.trunc(m);
}

/** numpy's default (linear) percentile over sorted values. */
function percentileOf(sorted: number[], q: number): number {
  const pos = ((sorted.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Surface samples over an along/cross box, clipped to the map, every `step` voxels.
 * The corridor samples at 0.5 m, the resolution the Python game measured it at;
 * the field is smooth at that scale and it costs 25 times fewer samples at 10 cm.
 */
function patch(surface: Surface, longAxis: 0 | 2, dims: { x: number; z: number }, a0: number, a1: number, b0: number, b1: number, step: number): number[] {
  const [aMax, bMax] = longAxis === 0 ? [dims.x, dims.z] : [dims.z, dims.x];
  const out: number[] = [];
  for (let a = Math.max(0, a0); a < Math.min(aMax, a1); a += step) {
    for (let b = Math.max(0, b0); b < Math.min(bMax, b1); b += step) {
      const [x, z] = xz(longAxis, a, b);
      out.push(surface(x, z));
    }
  }
  return out;
}

const corridorDims = { x: Infinity, z: Infinity };

/**
 * How high the ground gets in the strip this bay has to see over: a high
 * percentile of the whole corridor, or the highest point of the near band if
 * that is worse, because a rise close in walls you in outright.
 */
export function corridorHeight(
  surface: Surface,
  spec: LineSpec,
  a0: number,
  a1: number,
  frontEdge: number,
  reach: number,
  near: number,
  percentile: number,
  dims: { x: number; z: number } = corridorDims,
  step = 5,
): number {
  const wide = spec.facing > 0 ? [frontEdge, frontEdge + reach] : [frontEdge - reach, frontEdge];
  const close = spec.facing > 0 ? [frontEdge, frontEdge + near] : [frontEdge - near, frontEdge];
  const far = patch(surface, spec.longAxis, dims, a0, a1, wide[0], wide[1], step).sort((p, q) => p - q);
  if (far.length === 0) return 0;
  const nearPatch = patch(surface, spec.longAxis, dims, a0, a1, close[0], close[1], step);
  const farH = percentileOf(far, percentile);
  const nearH = nearPatch.length ? Math.max(...nearPatch) : farH;
  return Math.ceil(Math.max(farH, nearH));
}

interface Draft {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  groundY: number;
  floorY: number;
  stepTopY: number;
  crestY: number;
  stepLo: number;
  walkB: number;
}

export function planLine(p: GenParams, spec: LineSpec, surface: Surface, rng: Rng, crossed: readonly LinePlan[] = []): LinePlan {
  const T = p.trench;
  const dims = { x: p.dims.x, z: p.dims.z };
  const structure = spec.firingSteps ? T.bench + T.treadsAcross * T.treadDepth : 0;
  const step = Math.max(1, vx(0.5, p.voxel));

  const drafts: Draft[] = [];
  let prevFloor: number | null = null;
  for (let a = spec.aStart, index = 0; a < spec.aEnd; index++) {
    const a1 = Math.min(a + T.bayLen, spec.aEnd);
    const b0 = spec.crossBase + (index % 2 ? T.offset : 0);
    const b1 = b0 + T.width;
    const groundY = medianInt(patch(surface, spec.longAxis, dims, a, a1, b0, b1, 1));
    let floorY = groundY - T.depth;
    if (prevFloor !== null) floorY = Math.max(prevFloor - T.treadRise, Math.min(prevFloor + T.treadRise, floorY));
    floorY = Math.max(T.floorMin, Math.min(floorY, p.dims.y - T.depth - T.floorMaxBelowTop));
    const duckY = floorY + 1;
    const stepLo = spec.facing > 0 ? b1 - T.bench : b0;
    const frontEdge = spec.facing > 0 ? b1 : b0;
    let walkB = spec.facing > 0 ? (b0 + b1 - structure) / 2 : (b0 + structure + b1) / 2;
    let stepTopY: number;
    let crestY: number;
    if (spec.firingSteps) {
      const ahead = corridorHeight(surface, spec, a, a1, frontEdge, T.reach, T.near, T.percentile, dims, step);
      const needed = Math.ceil(ahead + T.margin - p.eye.standing);
      stepTopY = Math.max(duckY + T.stepMin, groundY + T.parapetMin - T.crestRise, needed);
      stepTopY = Math.min(stepTopY, duckY + T.stepMax);
      crestY = stepTopY + T.crestRise;
    } else {
      stepTopY = duckY;
      crestY = groundY + T.parapetMin;
      walkB = (b0 + b1) / 2;
    }
    drafts.push({ a0: a, a1, b0, b1, groundY, floorY, stepTopY, crestY, stepLo, walkB });
    prevFloor = floorY;
    a = a1 + T.leg;
  }

  // Raising a bay only buys a taller parapet, so smoothing only ever lifts.
  if (spec.firingSteps && T.smooth > 0) {
    for (let i = 1; i < drafts.length; i++) drafts[i].stepTopY = Math.max(drafts[i].stepTopY, drafts[i - 1].stepTopY - T.smooth);
    for (let i = drafts.length - 2; i >= 0; i--) drafts[i].stepTopY = Math.max(drafts[i].stepTopY, drafts[i + 1].stepTopY - T.smooth);
    for (const d of drafts) {
      d.stepTopY = Math.min(d.stepTopY, d.floorY + 1 + T.stepMax);
      d.crestY = d.stepTopY + T.crestRise;
    }
  }

  const revets = rng.derive('revet');
  const bays: BayPlan[] = drafts.map((d, index) => {
    const [x0, z0] = xz(spec.longAxis, d.a0, d.b0);
    const [x1, z1] = xz(spec.longAxis, d.a1, d.b1);
    const [walkX, walkZ] = xz(spec.longAxis, (d.a0 + d.a1) / 2, d.walkB);
    const revet = revets.choice(['planks', 'planks', 'corrugated', 'hurdles'] as const);
    return {
      line: spec.name, index, a0: d.a0, a1: d.a1, b0: d.b0, b1: d.b1, x0, x1, z0, z1,
      groundY: d.groundY, floorY: d.floorY, stepTopY: d.stepTopY, crestY: d.crestY,
      stepLo: d.stepLo, stepSpan: spec.firingSteps ? T.bench : 0, walkX, walkZ,
      longAxis: spec.longAxis, facing: spec.facing, firingSteps: spec.firingSteps, revet, seed: rng.nextU32(),
    };
  });

  const legs: LegPlan[] = [];
  for (let i = 0; i + 1 < bays.length; i++) {
    const bay = bays[i];
    const next = bays[i + 1];
    legs.push({
      a0: bay.a1, a1: bay.a1 + T.leg,
      b0: Math.min(bay.b0, next.b0), b1: Math.max(bay.b1, next.b0 + T.width),
      floorY: bay.floorY, longAxis: spec.longAxis,
    });
  }

  // A line that runs across earlier ones (a communication trench) meets their floors.
  let profile: LinePlan['profile'];
  if (!spec.firingSteps && crossed.some((l) => l.spec.longAxis !== spec.longAxis)) {
    profile = floorProfile(p, spec, bays, legs, crossed);
    const lowest = (a0: number, a1: number) => {
      let low = Infinity;
      for (let a = a0; a < a1; a++) low = Math.min(low, profile!.floors[a - profile!.a0]);
      return low;
    };
    for (const bay of bays) bay.floorY = lowest(bay.a0, bay.a1);
    for (const leg of legs) leg.floorY = lowest(leg.a0, leg.a1);
  }

  const dugouts: DugoutPlan[] = [];
  if (spec.dugoutEvery > 0) {
    for (const bay of bays) {
      if (bay.index % spec.dugoutEvery !== 1) continue;
      const d = planDugout(p, spec, bay, 0);
      if (!d) continue;
      d.seed = rng.nextU32();
      dugouts.push(d);
    }
  }
  return profile ? { spec, bays, legs, dugouts, profile } : { spec, bays, legs, dugouts };
}

type Rect = { x0: number; x1: number; z0: number; z1: number };

function rectOf(longAxis: 0 | 2, a0: number, a1: number, b0: number, b1: number): Rect {
  return longAxis === 0 ? { x0: a0, x1: a1, z0: b0, z1: b1 } : { x0: b0, x1: b1, z0: a0, z1: a1 };
}

/**
 * A crossing line's floor along its length. Wherever its footprint overlaps
 * a trench already planned, it takes that trench's floor, so the two meet
 * level; between crossings it follows its own ground, but never steps more
 * than one tread per tread depth, so it climbs and descends on stairs. The
 * Python game let each line keep its own floors and cut the other's, which
 * left a 1 m wall wherever a communication trench crossed a fire trench.
 */
function floorProfile(p: GenParams, spec: LineSpec, bays: BayPlan[], legs: LegPlan[], crossed: readonly LinePlan[]): { a0: number; floors: Int16Array } {
  const T = p.trench;
  const a0 = spec.aStart;
  const n = spec.aEnd - a0;
  const lowest = T.floorMin;
  const highest = p.dims.y - T.depth - T.floorMaxBelowTop;
  const want = new Float64Array(n);
  const pin = new Int32Array(n).fill(-1);
  const across: { a0: number; a1: number; b0: number; b1: number; ground: number }[] = [];
  bays.forEach((bay, i) => {
    across.push({ a0: bay.a0, a1: bay.a1, b0: bay.b0, b1: bay.b1, ground: bay.groundY });
    if (i < legs.length) across.push({ a0: legs[i].a0, a1: legs[i].a1, b0: legs[i].b0, b1: legs[i].b1, ground: bay.groundY });
  });
  const others: { rect: Rect; floor: number }[] = [];
  for (const line of crossed) {
    for (const b of line.bays) others.push({ rect: rectOf(b.longAxis, b.a0, b.a1, b.b0, b.b1), floor: b.floorY });
    for (const l of line.legs) others.push({ rect: rectOf(l.longAxis, l.a0, l.a1, l.b0, l.b1), floor: l.floorY });
  }
  for (const seg of across) {
    for (let a = Math.max(seg.a0, a0); a < Math.min(seg.a1, spec.aEnd); a++) {
      want[a - a0] = Math.max(lowest, Math.min(highest, seg.ground - T.depth));
      const here = rectOf(spec.longAxis, a, a + 1, seg.b0, seg.b1);
      let best = 0;
      for (const o of others) {
        const r = o.rect;
        const w = Math.min(here.x1, r.x1) - Math.max(here.x0, r.x0);
        const d = Math.min(here.z1, r.z1) - Math.max(here.z0, r.z0);
        if (w > 0 && d > 0 && w * d > best) {
          best = w * d;
          pin[a - a0] = o.floor;
        }
      }
    }
  }

  // Treads of T.treadDepth voxels: pinned where any voxel of one is, else as near the ground as the stairs allow.
  const S = T.treadDepth;
  const R = T.treadRise;
  const count = Math.ceil(n / S);
  const tread = new Float64Array(count);
  const fixed = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    tread[t] = want[t * S];
    for (let a = t * S; a < Math.min(n, (t + 1) * S); a++) {
      if (pin[a] >= 0) {
        tread[t] = pin[a];
        fixed[t] = 1;
        break;
      }
    }
  }
  for (let t = 1; t < count; t++) if (!fixed[t]) tread[t] = Math.max(tread[t - 1] - R, Math.min(tread[t - 1] + R, tread[t]));
  for (let t = count - 2; t >= 0; t--) if (!fixed[t]) tread[t] = Math.max(tread[t + 1] - R, Math.min(tread[t + 1] + R, tread[t]));
  const floors = new Int16Array(n);
  for (let a = 0; a < n; a++) floors[a] = Math.round(tread[Math.floor(a / S)]);
  return { a0, floors };
}

/**
 * Python's `_carve_dugout` geometry, in metres: a 3 × 3 m chamber off the
 * sheltered side, 1 m in, centred on its bay or moved `shift` voxels along it
 * (when its own spot is taken by another trench). The passage must still open
 * onto the bay. The caller sets `seed`.
 */
export function planDugout(p: GenParams, spec: LineSpec, bay: BayPlan, shift: number, seed = 0): DugoutPlan | null {
  const m = (metres: number) => vx(metres, p.voxel);
  const deep = m(3.5);
  const near = m(1.0);
  const half = m(1.5);
  const entHalf = Math.max(1, m(0.5));
  const away: 1 | -1 = spec.facing > 0 ? -1 : 1;
  const centre = ((bay.a0 + bay.a1) >> 1) + shift;
  if (centre - entHalf < bay.a0 + 2 || centre + entHalf > bay.a1 - 2) return null;
  let c: { x0: number; x1: number; z0: number; z1: number };
  let e: { x0: number; x1: number; z0: number; z1: number };
  if (spec.longAxis === 0) {
    const cx = centre;
    const [cz0, cz1, ez0, ez1] = away < 0
      ? [bay.z0 - deep, bay.z0 - near, bay.z0 - near, bay.z0]
      : [bay.z1 + near, bay.z1 + deep, bay.z1, bay.z1 + near];
    c = { x0: cx - half, x1: cx + half, z0: cz0, z1: cz1 };
    e = { x0: cx - entHalf, x1: cx + entHalf, z0: ez0, z1: ez1 };
  } else {
    const cz = centre;
    c = { x0: bay.x0 - deep, x1: bay.x0 - near, z0: cz - half, z1: cz + half };
    e = { x0: bay.x0 - near, x1: bay.x0, z0: cz - entHalf, z1: cz + entHalf };
  }
  if (c.x0 < 1 || c.x1 >= p.dims.x - 1 || c.z0 < 1 || c.z1 >= p.dims.z - 1) return null;
  const dugFloor = Math.max(bay.floorY - m(1.0), p.waterTable + 1);
  if (bay.floorY - dugFloor < 0 || dugFloor < 2) return null;
  const airY0 = dugFloor + 1;
  const airY1 = airY0 + m(2.0);
  return {
    line: spec.name,
    bay: bay.index,
    lo: [c.x0, airY0, c.z0],
    hi: [c.x1, airY1, c.z1],
    entrance: [(e.x0 + e.x1) >> 1, airY0, (e.z0 + e.z1) >> 1],
    passage: e,
    floorY: bay.floorY,
    dugFloor,
    roofY: airY1,
    longAxis: spec.longAxis,
    away,
    seed,
  };
}
