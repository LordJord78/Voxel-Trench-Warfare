/**
 * What a round hits: the first solid voxel along a ray through the brick map.
 * An Amanatides–Woo walk in voxels with the GPU traversal's conventions (and
 * its CPU reference's, tests/support/trace-ref.ts): the ray is clipped to the
 * world, `t` runs along the unit direction, `face` is the face of the hit cell
 * the ray came in through, and ties between axes go to the lowest.
 *
 * Water, wire, cloth and air let a ray through (`isSolid`). The walk reads the
 * brick table once for each brick it enters: an empty brick is stepped across
 * without reading its voxels, a uniform one is a hit at once if its material
 * is solid and stepped across if not, and only a dense brick's voxels are
 * read. A round's segment is a few metres a substep, so stepping is cheap; it
 * also keeps every cell and tie the reference's walk would give.
 */

import { UNIFORM, type BrickMap } from './bricks';
import { isSolid } from './materials';

export interface RayHit {
  /** Voxels along the unit direction to where the ray entered the hit cell; 0 if it started inside one. */
  t: number;
  cell: [number, number, number];
  /** The face it came in through (0–5: −x, +x, −y, +y, −z, +z), −1 if it started inside. */
  face: number;
  /** The hit voxel's palette id. */
  material: number;
}

const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));

/** The first solid voxel along a ray from `origin` (voxels) along unit `dir`, within `maxT` voxels; null if none. */
export function raycast(map: BrickMap, origin: readonly [number, number, number], dir: readonly [number, number, number], maxT: number): RayHit | null {
  const dims = [map.dims.x, map.dims.y, map.dims.z];
  let tEnd = maxT;
  let entry = -1;
  let entryT = -Infinity;
  for (let k = 0; k < 3; k++) {
    if (dir[k] === 0) {
      if (origin[k] < 0 || origin[k] >= dims[k]) return null;
      continue;
    }
    const a = (0 - origin[k]) / dir[k];
    const b = (dims[k] - origin[k]) / dir[k];
    const lo = Math.min(a, b);
    if (lo > entryT) {
      entryT = lo;
      entry = k;
    }
    tEnd = Math.min(tEnd, Math.max(a, b));
  }
  let t = Math.max(entryT, 0);
  if (t >= tEnd) return null;
  const cell: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) cell[k] = Math.min(dims[k] - 1, Math.max(0, Math.floor(origin[k] + dir[k] * t)));
  let face = -1;
  if (entryT > 0) {
    cell[entry] = dir[entry] > 0 ? 0 : dims[entry] - 1;
    face = entry * 2 + (dir[entry] > 0 ? 0 : 1);
  }
  const bx = map.bricks.x;
  const by = map.bricks.y;
  let brick = -1;
  let entryWord = 0;
  for (;;) {
    const bi = ((cell[2] >> 3) * by + (cell[1] >> 3)) * bx + (cell[0] >> 3);
    if (bi !== brick) {
      brick = bi;
      entryWord = map.table[bi];
    }
    if (entryWord !== 0) {
      const p = entryWord & UNIFORM ? entryWord & 0xff : map.get(cell[0], cell[1], cell[2]);
      if (SOLID[p]) return { t, cell: [cell[0], cell[1], cell[2]], face, material: p };
    }
    let axis = -1;
    let next = Infinity;
    for (let k = 0; k < 3; k++) {
      if (dir[k] === 0) continue;
      const bound = dir[k] > 0 ? cell[k] + 1 : cell[k];
      const tk = (bound - origin[k]) / dir[k];
      if (tk < next) {
        next = tk;
        axis = k;
      }
    }
    if (axis < 0 || next >= tEnd) return null;
    t = next;
    cell[axis] += dir[axis] > 0 ? 1 : -1;
    if (cell[axis] < 0 || cell[axis] >= dims[axis]) return null;
    face = axis * 2 + (dir[axis] > 0 ? 0 : 1);
  }
}
