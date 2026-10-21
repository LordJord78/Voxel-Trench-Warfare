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

import { CraterField } from './craters';
import { bayList, type WorldPlan } from './plan';
import { ditchAt, fieldHeight } from './terrain';
import type { BayPlan, LegPlan } from './trenches';

export const FLAG = { DITCH: 1, CRATER: 2, TRENCH: 4, PARAPET: 8, PARADOS: 16, REVET: 32 } as const;

export interface ColumnModel {
  /** First column held, including the one-column halo either side of the band. */
  x0: number;
  x1: number;
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
  const za = Math.max(z0, 0);
  const zb = Math.min(z1, m.nz);
  for (let x = xa; x < xb; x++) {
    const row = (x - m.x0) * m.nz;
    for (let z = za; z < zb; z++) fn(row + z);
  }
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

export function columnModel(plan: WorldPlan, x0: number, x1: number): ColumnModel {
  const p = plan.params;
  const T = p.trench;
  const mx0 = x0 - 1;
  const mx1 = x1 + 1;
  const nz = p.dims.z;
  const n = (mx1 - mx0) * nz;
  const m: ColumnModel = {
    x0: mx0, x1: mx1, nz,
    ground: new Int16Array(n), surface: new Int16Array(n), floor: new Int16Array(n).fill(-1),
    solidTop: new Int16Array(n).fill(-1), spoilTop: new Int16Array(n).fill(-1),
    revetTop: new Int16Array(n).fill(-1), revetFrom: new Int16Array(n).fill(-1),
    bay: new Int32Array(n).fill(-1), top: new Int16Array(n), flags: new Uint8Array(n),
  };

  // The field, then ditches (pure functions of the terrain).
  const cut = Math.floor(1.5 / p.voxel + 0.5);
  for (let x = mx0; x < mx1; x++) {
    const row = (x - mx0) * nz;
    for (let z = 0; z < nz; z++) {
      const h = Math.max(p.waterTable + 2, Math.min(p.dims.y - 80, Math.floor(fieldHeight(plan.terrain, p, x, z) + 0.5)));
      m.ground[row + z] = h;
      if (ditchAt(plan.terrain, p, x, z)) {
        m.surface[row + z] = h - cut;
        m.flags[row + z] = FLAG.DITCH;
      } else {
        m.surface[row + z] = h;
      }
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

    line.bays.forEach((bay, i) => {
      const id = bayBase + i;
      forBox(m, axis, bay.a0, bay.a1, bay.b0, bay.b1, (c) => openTrench(m, c, bay.floorY, id));
      if (bay.firingSteps) firingStep(m, p.trench, bay, axis, facing);

      // Parapet courses outward from the face: flat for crestFlat, then 45° down to the field.
      for (let k = 0; ; k++) {
        const target = bay.crestY - Math.max(0, k - T.crestFlat);
        if (target <= bay.groundY) break;
        const b = facing > 0 ? bay.b1 + k : bay.b0 - 1 - k;
        forBox(m, axis, bay.a0, bay.a1 + T.leg, b, b + 1, (c) => {
          if (parapet[c] < target) parapet[c] = target;
        });
      }
      // Parados behind, lower, the same profile.
      for (let k = 0; ; k++) {
        const target = bay.groundY + T.paradosH - Math.max(0, k - T.crestFlat);
        if (target <= bay.groundY) break;
        const b = facing > 0 ? bay.b0 - 1 - k : bay.b1 + k;
        forBox(m, axis, bay.a0, bay.a1 + T.leg, b, b + 1, (c) => {
          if (parados[c] < target) parados[c] = target;
        });
      }
      // Both faces revetted from the duckboards to their own heights.
      const duck = bay.floorY + 1;
      const faces: [number, number][] = [
        [facing > 0 ? bay.b1 : bay.b0 - 1, bay.crestY],
        [facing > 0 ? bay.b0 - 1 : bay.b1, bay.groundY + T.paradosH],
      ];
      for (const [b, height] of faces) {
        forBox(m, axis, bay.a0, bay.a1 + T.leg, b, b + 1, (c) => {
          if (m.flags[c] & FLAG.TRENCH) return;
          if (m.revetTop[c] < height) m.revetTop[c] = height;
          m.revetFrom[c] = m.revetFrom[c] < 0 ? duck : Math.min(m.revetFrom[c], duck);
          if (m.bay[c] < 0) m.bay[c] = id;
          m.flags[c] |= FLAG.REVET;
        });
      }
    });
    line.legs.forEach((leg: LegPlan, i) => {
      forBox(m, axis, leg.a0, leg.a1, leg.b0, leg.b1, (c) => openTrench(m, c, leg.floorY, bayBase + i));
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
    bayBase += line.bays.length;
  }

  // Craters last, as in Python: bowls cut field and parapet alike; rims heap only on bare field.
  const field = craterField(plan);
  for (let x = mx0; x < mx1; x++) {
    const row = (x - mx0) * nz;
    for (let z = 0; z < nz; z++) {
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
  for (let k = 0; k < flights; k++) {
    const top = bay.stepTopY - (flights - 1 - k) * T.treadRise;
    const a0 = bay.a0 + k * T.treadDepth;
    forBox(m, axis, a0, Math.min(a0 + T.treadDepth, bay.a1), lo, hi, (c) => (m.solidTop[c] = top));
  }
}

export { bayList };
