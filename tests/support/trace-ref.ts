/**
 * The CPU reference for the GPU traversal: a plain Amanatides–Woo walk over
 * every voxel, in doubles, with the same conventions as `traceWorld` — the
 * ray is clipped to the volume [0, dims), `t` is the distance along `rd`
 * (unit for real rays), and `face` (0–5: −x, +x, −y, +y, −z, +z) is the face of
 * the hit cell the ray came in through. Ties between axes go to the lowest.
 */

import type { BrickMap } from '../../src/world/bricks';

export type Vec3 = readonly [number, number, number];

export interface RefHit {
  hit: boolean;
  t: number;
  cell: [number, number, number];
  face: number;
  mat: number;
}

const MISS: RefHit = { hit: false, t: 0, cell: [0, 0, 0], face: 0, mat: 0 };

export function traceRef(map: BrickMap, ro: Vec3, rd: Vec3, tMax: number): RefHit {
  const dims = [map.dims.x, map.dims.y, map.dims.z];
  let t = 0;
  let tEnd = tMax;
  let entry = -1;
  let entryT = -Infinity;
  for (let k = 0; k < 3; k++) {
    if (rd[k] === 0) {
      if (ro[k] < 0 || ro[k] >= dims[k]) return MISS;
      continue;
    }
    const a = (0 - ro[k]) / rd[k];
    const b = (dims[k] - ro[k]) / rd[k];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo > entryT) {
      entryT = lo;
      entry = k;
    }
    tEnd = Math.min(tEnd, hi);
  }
  t = Math.max(entryT, 0);
  if (t >= tEnd) return MISS;
  const cell: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) cell[k] = Math.min(dims[k] - 1, Math.max(0, Math.floor(ro[k] + rd[k] * t)));
  let face = 0;
  if (entryT > 0) {
    cell[entry] = rd[entry] > 0 ? 0 : dims[entry] - 1;
    face = entry * 2 + (rd[entry] > 0 ? 0 : 1);
  }
  for (;;) {
    const mat = map.get(cell[0], cell[1], cell[2]);
    if (mat !== 0) return { hit: true, t, cell: [cell[0], cell[1], cell[2]], face, mat };
    let axis = -1;
    let next = Infinity;
    for (let k = 0; k < 3; k++) {
      if (rd[k] === 0) continue;
      const bound = rd[k] > 0 ? cell[k] + 1 : cell[k];
      const tk = (bound - ro[k]) / rd[k];
      if (tk < next) {
        next = tk;
        axis = k;
      }
    }
    if (axis < 0 || next >= tEnd) return MISS;
    t = next;
    cell[axis] += rd[axis] > 0 ? 1 : -1;
    if (cell[axis] < 0 || cell[axis] >= dims[axis]) return MISS;
    face = axis * 2 + (rd[axis] > 0 ? 0 : 1);
  }
}

/** A far field as the reference marches it: prepared heights at cell centres (see farfield-mips.ts). */
export interface FarRef {
  size: number;
  cell: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
}

export interface FarRefHit {
  hit: boolean;
  t: number;
  n: [number, number, number];
}

/**
 * The far field's ground, found by small steps (a twentieth of a cell) along
 * the ray and refined by bisection. A patch exists where its four corner
 * samples are all ground. Doubles throughout.
 */
export function marchRef(ff: FarRef, ro: Vec3, rd: Vec3, tMin: number, tMax: number): FarRefHit {
  const sample = (i: number, j: number) => ff.heights[Math.min(ff.size - 1, j) * ff.size + Math.min(ff.size - 1, i)];
  const ground = (t: number): { f: number; n: [number, number, number] } | null => {
    const u = (ro[0] + rd[0] * t - ff.originX) / ff.cell - 0.5;
    const v = (ro[2] + rd[2] * t - ff.originZ) / ff.cell - 0.5;
    if (u < 0 || v < 0 || u >= ff.size - 1 || v >= ff.size - 1) return null;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const a = sample(i, j);
    const b = sample(i + 1, j);
    const c = sample(i, j + 1);
    const d = sample(i + 1, j + 1);
    if (Math.min(a, b, c, d) === -Infinity) return null;
    const fu = u - i;
    const fv = v - j;
    const h = a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
    const dx = ((b - a) + (a - b - c + d) * fv) / ff.cell;
    const dz = ((c - a) + (a - b - c + d) * fu) / ff.cell;
    const l = Math.hypot(dx, 1, dz);
    return { f: ro[1] + rd[1] * t - h, n: [-dx / l, 1 / l, -dz / l] };
  };
  const step = ff.cell / 20;
  let prev = ground(tMin);
  if (prev && prev.f <= 0) return { hit: true, t: tMin, n: prev.n };
  for (let t = tMin + step; t <= tMax; t += step) {
    const here = ground(t);
    // Under the ground here and not before: either the ray came down through it, or entered it from no ground at all.
    if (here && here.f <= 0 && (!prev || prev.f > 0)) {
      let lo = t - step;
      let hi = t;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const g = ground(mid);
        if (g && g.f <= 0) hi = mid;
        else lo = mid;
      }
      return { hit: true, t: hi, n: ground(hi)!.n };
    }
    prev = here;
  }
  return { hit: false, t: 0, n: [0, 1, 0] };
}
