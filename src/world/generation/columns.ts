/**
 * The column model: what every column of a band holds, before any voxel.
 *
 * The Python generator wrote the field into one array, cut trenches into it,
 * then piled parapets and revetted faces from per-column target heights. This
 * keeps those targets and stops there: a band's columns are rasterised from
 * the plan into a few height arrays, and the fill turns heights into voxels.
 * Because everything here is a pure function of the plan, a band one worker
 * fills and a band another fills agree at their shared edge.
 */

import { hash32x4 } from '../../core/hash';
import { CraterField } from './craters';
import type { WorldPlan } from './plan';
import { ditchDepth, fieldHeight } from './terrain';
import { bayNoiseAt, type BayPlan, type LegPlan } from './trenches';

export const FLAG = { DITCH: 1, CRATER: 2, TRENCH: 4, PARAPET: 8, PARADOS: 16, REVET: 32 } as const;

export interface ColumnModel {
  /** First column held, including the one-column halo either side of the band. */
  x0: number;
  x1: number;
  /** First z held, and how many: a band holds every z; a single-column query holds one. */
  z0: number;
  nz: number;
  /** Undisturbed field surface: the reference strata are laid against. */
  ground: Int16Array;
  /** Ground with ditches and craters cut: the first air (or water) voxel. */
  surface: Int16Array;
  /** Duckboard layer of a trench column, or -1. */
  floor: Int16Array;
  /** Top (exclusive) of bench, tread or flight timber in a trench column, or -1. */
  solidTop: Int16Array;
  /** Top (exclusive) of parapet, parados or rim spoil, or -1. */
  spoilTop: Int16Array;
  /** Revetment span on a trench face column: [revetFrom, revetTop), or -1. */
  revetTop: Int16Array;
  revetFrom: Int16Array;
  /** Global bay id (see `bayList`) of a trench or face column, or -1. */
  bay: Int32Array;
  /** First air voxel above the column's ground mass: what the repose rule compares against. */
  top: Int16Array;
  flags: Uint8Array;
}

/** How far a rear wall is dug back past its plan, at most (voxels). */
const REAR_WAVE = 2;

/** A smooth value in [0, 1] along a bay at `a`, changing over about `span` voxels: a pure function of `a`, the bay's seed and `salt`, so every band agrees. */
function along(a: number, seed: number, salt: number, span: number): number {
  const i = Math.floor(a / span);
  const f = a / span - i;
  const h0 = (hash32x4(i, seed, salt, 0) & 1023) / 1023;
  const h1 = (hash32x4(i + 1, seed, salt, 0) & 1023) / 1023;
  return h0 + (h1 - h0) * f * f * (3 - 2 * f);
}

/** How far a bay's rear wall is dug back at `a` (0 to REAR_WAVE voxels), eased to nothing at its ends. */
function rearWave(bay: BayPlan, a: number): number {
  const ends = Math.min(a - bay.a0, bay.a1 - 1 - a);
  if (ends < 2) return 0;
  return Math.min(REAR_WAVE, Math.round(along(bayNoiseAt(bay, a), bay.seed, 61, 9) * (REAR_WAVE + 0.49)), ends - 1);
}

/** The gentlest a bank falls (voxels a voxel), and how far its flat top runs past `flat` at most. */
const SLOPE_MIN = 0.7;
const FLAT_MORE = 3;

/** How far out from its face a bank `height` high, flat for about `flat`, can reach (voxels). */
function bankReach(height: number, flat: number): number {
  return flat + FLAT_MORE + Math.ceil(height / SLOPE_MIN + 1.5) + 1;
}

/**
 * One column's bank outward from a face (`at(k)`, the k-th column out): `crest` for about `flat`
 * voxels (more or less by up to three, slowly along the bay), then a shoulder that rounds over into
 * a slope of 0.7 to 1 voxels a voxel, with a dent here and there, never falling more than a voxel
 * a voxel; down to `ground`. Raised into `into` wherever it stands higher than what is there.
 */
function bankOut(m: ColumnModel, axis: 0 | 2, a: number, u: number, crest: number, ground: number, flat: number, seed: number, salt: number, at: (k: number) => number, into: Int16Array): void {
  const level = flat + Math.round((along(u, seed, 71 + salt, 13) - 0.5) * (2 * FLAT_MORE - 1));
  const slope = SLOPE_MIN + (1 - SLOPE_MIN) * along(u, seed, 73 + salt, 25);
  let prev = crest;
  for (let k = 0; ; k++) {
    const over = Math.max(0, k - level);
    const fall = over <= 3 ? (over * over * slope) / 6 : (over - 1.5) * slope;
    const dent = over > 2 && along(u * 3 + k * 11, seed, 79 + salt, 4) > 0.8 ? 1 : 0;
    const target = Math.max(prev - 1, crest - Math.floor(fall) - dent);
    prev = target;
    if (target <= ground) break;
    forBox(m, axis, a, a + 1, at(k), at(k) + 1, (c) => {
      if (into[c] < target) into[c] = target;
    });
  }
}

const fieldCache = new WeakMap<WorldPlan, CraterField>();

function craterField(plan: WorldPlan): CraterField {
  let field = fieldCache.get(plan);
  if (!field) {
    field = new CraterField(plan.craters);
    fieldCache.set(plan, field);
  }
  return field;
}

/** Visit the world columns of an along/cross box (longAxis 0: x along; 2: z along), clipped to the model. */
function forBox(m: ColumnModel, longAxis: 0 | 2, a0: number, a1: number, b0: number, b1: number, fn: (c: number) => void): void {
  const [x0, x1, z0, z1] = longAxis === 0 ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
  const xa = Math.max(x0, m.x0);
  const xb = Math.min(x1, m.x1);
  const za = Math.max(z0, m.z0);
  const zb = Math.min(z1, m.z0 + m.nz);
  for (let x = xa; x < xb; x++) {
    const row = (x - m.x0) * m.nz - m.z0;
    for (let z = za; z < zb; z++) fn(row + z);
  }
}

/** Does an along/cross box overlap the model's columns at all? */
function touches(m: ColumnModel, longAxis: 0 | 2, a0: number, a1: number, b0: number, b1: number): boolean {
  const [x0, x1, z0, z1] = longAxis === 0 ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
  return x1 > m.x0 && x0 < m.x1 && z1 > m.z0 && z0 < m.z0 + m.nz;
}

function openTrench(m: ColumnModel, c: number, floorY: number, bay: number): void {
  m.floor[c] = floorY;
  m.solidTop[c] = -1;
  m.spoilTop[c] = -1;
  m.revetTop[c] = -1;
  m.revetFrom[c] = -1;
  m.bay[c] = bay;
  m.flags[c] = (m.flags[c] & (FLAG.DITCH | FLAG.CRATER)) | FLAG.TRENCH;
}

export function columnModel(plan: WorldPlan, x0: number, x1: number, z0 = 0, z1 = plan.params.dims.z): ColumnModel {
  const p = plan.params;
  const T = p.trench;
  const mx0 = x0 - 1;
  const mx1 = x1 + 1;
  const nz = z1 - z0;
  const n = (mx1 - mx0) * nz;
  const m: ColumnModel = {
    x0: mx0, x1: mx1, z0, nz,
    ground: new Int16Array(n), surface: new Int16Array(n), floor: new Int16Array(n).fill(-1),
    solidTop: new Int16Array(n).fill(-1), spoilTop: new Int16Array(n).fill(-1),
    revetTop: new Int16Array(n).fill(-1), revetFrom: new Int16Array(n).fill(-1),
    bay: new Int32Array(n).fill(-1), top: new Int16Array(n), flags: new Uint8Array(n),
  };

  // The field, then ditches (pure functions of the terrain).
  for (let x = mx0; x < mx1; x++) {
    const row = (x - mx0) * nz - z0;
    for (let z = z0; z < z1; z++) {
      const h = Math.max(p.waterTable + 2, Math.min(p.dims.y - 80, Math.floor(fieldHeight(plan.terrain, p, x, z) + 0.5)));
      m.ground[row + z] = h;
      const cut = ditchDepth(plan.terrain, p, x, z);
      m.surface[row + z] = h - cut;
      if (cut > 0) m.flags[row + z] = FLAG.DITCH;
    }
  }

  // Lines in plan order: a later line's footprint clears an earlier one's parapet.
  const parapet = new Int16Array(n);
  const parados = new Int16Array(n);
  let bayBase = 0;
  for (const line of plan.lines) {
    const axis = line.spec.longAxis;
    const facing = line.spec.facing;
    parapet.fill(0);
    parados.fill(0);
    // A crossing line floors each column from its profile; others floor a bay at its own height.
    const profile = line.profile;
    const floorOf = (c: number, flat: number) => {
      if (!profile) return flat;
      const a = axis === 0 ? Math.floor(c / nz) + mx0 : (c % nz) + z0;
      return profile.floors[a - profile.a0];
    };

    line.bays.forEach((bay, i) => {
      // Everything a bay touches lies within its footprint widened by its banks: skip it if that misses us.
      const bank = bankReach(Math.max(bay.crestY - bay.groundY, T.paradosH), T.crestFlat) + REAR_WAVE;
      if (!touches(m, axis, bay.a0, bay.a1 + T.leg, bay.b0 - bank, bay.b1 + bank)) return;
      const id = bayBase + i;
      forBox(m, axis, bay.a0, bay.a1, bay.b0, bay.b1, (c) => openTrench(m, c, floorOf(c, bay.floorY), id));
      // The rear wall dug back unevenly, never narrowing the walkway (the multiplayer spec's §5).
      const rear = (a: number) => (a >= bay.a0 && a < bay.a1 ? rearWave(bay, a) : 0);
      for (let a = bay.a0; a < bay.a1; a++) {
        const w = rear(a);
        if (w === 0) continue;
        const [r0, r1] = facing > 0 ? [bay.b0 - w, bay.b0] : [bay.b1, bay.b1 + w];
        forBox(m, axis, a, a + 1, r0, r1, (c) => openTrench(m, c, floorOf(c, bay.floorY), id));
      }
      if (bay.firingSteps) firingStep(m, p.trench, bay, axis, facing);

      // Banks outward from each face, column by column along the bay: the parapet flat at its crest
      // for about crestFlat (the sightline over it is the crest's alone), then a rounded shoulder and
      // a slope of its own, never steeper than a voxel a voxel; the parados lower, the same way.
      for (let a = bay.a0; a < bay.a1 + T.leg; a++) {
        if (!touches(m, axis, a, a + 1, bay.b0 - bank, bay.b1 + bank)) continue;
        const w = rear(a);
        const u = bayNoiseAt(bay, a);
        bankOut(m, axis, a, u, bay.crestY, bay.groundY, T.crestFlat, bay.seed, 0, (k) => (facing > 0 ? bay.b1 + k : bay.b0 - 1 - k), parapet);
        bankOut(m, axis, a, u, bay.groundY + T.paradosH, bay.groundY, T.crestFlat, bay.seed, 1, (k) => (facing > 0 ? bay.b0 - 1 - w - k : bay.b1 + w + k), parados);
      }
      // Both faces revetted from the duckboards to their own heights.
      const duck = bay.floorY + 1;
      for (let a = bay.a0; a < bay.a1 + T.leg; a++) {
        const w = rear(a);
        const faces: [number, number][] = [
          [facing > 0 ? bay.b1 : bay.b0 - 1, bay.crestY],
          [facing > 0 ? bay.b0 - 1 - w : bay.b1 + w, bay.groundY + T.paradosH],
        ];
        for (const [b, height] of faces) {
          forBox(m, axis, a, a + 1, b, b + 1, (c) => {
            if (m.flags[c] & FLAG.TRENCH) return;
            if (m.revetTop[c] < height) m.revetTop[c] = height;
            m.revetFrom[c] = m.revetFrom[c] < 0 ? duck : Math.min(m.revetFrom[c], duck);
            if (m.bay[c] < 0) m.bay[c] = id;
            m.flags[c] |= FLAG.REVET;
          });
        }
      }
    });
    line.legs.forEach((leg: LegPlan, i) => {
      if (!touches(m, axis, leg.a0, leg.a1, leg.b0, leg.b1)) return;
      forBox(m, axis, leg.a0, leg.a1, leg.b0, leg.b1, (c) => openTrench(m, c, floorOf(c, leg.floorY), bayBase + i));
    });

    // Spoil piles only on standing ground: never into a trench, parados never over parapet.
    for (let c = 0; c < n; c++) {
      if (m.flags[c] & FLAG.TRENCH) continue;
      if (parapet[c] > 0) {
        if (m.spoilTop[c] < parapet[c]) m.spoilTop[c] = parapet[c];
        m.flags[c] |= FLAG.PARAPET;
      } else if (parados[c] > 0) {
        if (m.spoilTop[c] < parados[c]) m.spoilTop[c] = parados[c];
        m.flags[c] |= FLAG.PARADOS;
      }
    }
    // Burster course: at least 1 m of spoil over a dugout's roof, falling away at 45°.
    for (const d of line.dugouts) {
      const target = d.roofY + 2 + Math.floor(1.0 / p.voxel + 0.5);
      const spread = target - p.waterTable;
      if (!touches(m, 0, d.lo[0] - spread, d.hi[0] + spread, d.lo[2] - spread, d.hi[2] + spread)) continue;
      forBox(m, 0, d.lo[0] - spread, d.hi[0] + spread, d.lo[2] - spread, d.hi[2] + spread, (c) => {
        if (m.flags[c] & FLAG.TRENCH) return;
        const x = Math.floor(c / nz) + mx0;
        const z = (c % nz) + z0;
        const dx = x < d.lo[0] ? d.lo[0] - x : x >= d.hi[0] ? x - d.hi[0] + 1 : 0;
        const dz = z < d.lo[2] ? d.lo[2] - z : z >= d.hi[2] ? z - d.hi[2] + 1 : 0;
        // A round mound, not a square pyramid.
        const t = target - Math.round(Math.sqrt(dx * dx + dz * dz));
        if (t > m.surface[c] && t > m.spoilTop[c]) m.spoilTop[c] = t;
      });
    }
    bayBase += line.bays.length;
  }

  // Craters last, as in Python: bowls cut field and parapet alike; rims heap only on bare field.
  const field = craterField(plan);
  for (let x = mx0; x < mx1; x++) {
    const row = (x - mx0) * nz - z0;
    for (let z = z0; z < z1; z++) {
      const c = row + z;
      if (m.flags[c] & FLAG.TRENCH) continue;
      const base = m.surface[c];
      const bowl = field.bowl(x, z, base);
      if (bowl !== Infinity) {
        const cutTo = Math.floor(bowl + 0.5);
        if (cutTo < m.surface[c]) m.surface[c] = cutTo;
        if (m.spoilTop[c] >= 0) m.spoilTop[c] = m.spoilTop[c] > cutTo ? cutTo : m.spoilTop[c];
        if (m.revetTop[c] >= 0 && m.revetTop[c] > cutTo) m.revetTop[c] = cutTo;
        if (m.spoilTop[c] <= m.surface[c]) m.spoilTop[c] = -1;
        if (m.revetTop[c] >= 0 && m.revetTop[c] <= m.revetFrom[c]) {
          m.revetTop[c] = -1;
          m.revetFrom[c] = -1;
        }
        m.flags[c] |= FLAG.CRATER;
        continue;
      }
      if (m.spoilTop[c] >= 0 || m.revetTop[c] >= 0) continue;
      const rim = field.rim(x, z);
      if (rim > 0) {
        const heap = Math.floor(base + rim + 0.5);
        if (heap > base) {
          m.spoilTop[c] = heap;
          m.flags[c] |= FLAG.CRATER;
        }
      }
    }
  }

  for (let c = 0; c < n; c++) {
    m.top[c] = m.flags[c] & FLAG.TRENCH
      ? Math.max(m.floor[c] + 1, m.solidTop[c])
      : Math.max(m.surface[c], m.spoilTop[c], m.revetTop[c]);
  }
  return m;
}

/**
 * Bench, across-bay treads and the along-bay flight, as solid-timber tops on
 * the trench's own columns. The across treads carry what rise they can; the
 * flight climbs the rest along the bench from the bay's a0 end.
 */
function firingStep(m: ColumnModel, T: WorldPlan['params']['trench'], bay: BayPlan, axis: 0 | 2, facing: 1 | -1): void {
  const duck = bay.floorY + 1;
  const stepH = bay.stepTopY - duck;
  if (stepH <= 0) return;
  const lo = bay.stepLo;
  const hi = bay.stepLo + T.bench;
  forBox(m, axis, bay.a0, bay.a1, lo, hi, (c) => (m.solidTop[c] = bay.stepTopY));
  for (let k = 0; k < T.treadsAcross; k++) {
    const top = duck + Math.min((T.treadsAcross - k) * T.treadRise, stepH);
    const [b0, b1] = facing > 0
      ? [lo - (k + 1) * T.treadDepth, lo - k * T.treadDepth]
      : [hi + k * T.treadDepth, hi + (k + 1) * T.treadDepth];
    forBox(m, axis, bay.a0, bay.a1, b0, b1, (c) => (m.solidTop[c] = top));
  }
  const climb = stepH - T.treadsAcross * T.treadRise;
  if (climb <= 0) return;
  const flights = Math.ceil(climb / T.treadRise);
  // From the a0 end; a turned bay's from its a1 end, as the bay it was turned from had it.
  for (let k = 0; k < flights; k++) {
    const top = bay.stepTopY - (flights - 1 - k) * T.treadRise;
    if (bay.turned === undefined) {
      const a0 = bay.a0 + k * T.treadDepth;
      forBox(m, axis, a0, Math.min(a0 + T.treadDepth, bay.a1), lo, hi, (c) => (m.solidTop[c] = top));
    } else {
      const a1 = bay.a1 - k * T.treadDepth;
      forBox(m, axis, Math.max(a1 - T.treadDepth, bay.a0), a1, lo, hi, (c) => (m.solidTop[c] = top));
    }
  }
}


const modelCache = new WeakMap<WorldPlan, Map<number, ColumnModel>>();

/** Keep a band's model for `columnTopAt`, so stamping a band reuses the model its fill built. */
export function rememberColumns(plan: WorldPlan, band: number, m: ColumnModel): void {
  let cache = modelCache.get(plan);
  if (!cache) {
    cache = new Map();
    modelCache.set(plan, cache);
  }
  cache.delete(band);
  cache.set(band, m);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
}

const pointCache = new WeakMap<WorldPlan, Map<number, number>>();

/**
 * The top of any column — first air above its ground mass, after trenches,
 * parapets and craters — so a prop stands on the real ground wherever it is
 * drawn. A band whose model is cached answers at once; anywhere else gets a
 * one-column model, remembered for a while.
 */
export function columnTopAt(plan: WorldPlan, x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.max(0, Math.min(plan.params.dims.z - 1, Math.floor(z)));
  const band = modelCache.get(plan)?.get(Math.floor(xi / 32));
  if (band) return band.top[(xi - band.x0) * band.nz + zi - band.z0];
  let points = pointCache.get(plan);
  if (!points) {
    points = new Map();
    pointCache.set(plan, points);
  }
  const key = xi * plan.params.dims.z + zi;
  let top = points.get(key);
  if (top === undefined) {
    const m = columnModel(plan, xi, xi + 1, zi, zi + 1);
    top = m.top[(xi - m.x0) * m.nz];
    if (points.size > 65536) points.clear();
    points.set(key, top);
  }
  return top;
}
