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
