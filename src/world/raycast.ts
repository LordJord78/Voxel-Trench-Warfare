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
import { isSolid, K, PALETTE_KIND } from './materials';

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
const WET = Uint8Array.from({ length: 256 }, (_, p) => (PALETTE_KIND[p] === K.WATER ? 1 : 0));

/** Where a ray first entered water, if it did (`t` −1 if not): the caller resets it. */
export interface WaterEntry {
  t: number;
  cell: [number, number, number];
}

/**
 * The first solid voxel along a ray from `origin` (voxels) along unit `dir`, within `maxT` voxels;
 * null if none. With `water`, also where it first entered water from outside it, short of that
 * solid: noted in `water` (a ray that starts in water notes none).
 */
export function raycast(map: BrickMap, origin: readonly [number, number, number], dir: readonly [number, number, number], maxT: number, water?: WaterEntry): RayHit | null {
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
  // Whether the last cell was water: the first is the ray's own, so a ray from inside water notes none.
  let inWater = true;
  for (;;) {
    const bi = ((cell[2] >> 3) * by + (cell[1] >> 3)) * bx + (cell[0] >> 3);
    if (bi !== brick) {
      brick = bi;
      entryWord = map.table[bi];
    }
    let p = 0;
    if (entryWord !== 0) {
      p = entryWord & UNIFORM ? entryWord & 0xff : map.get(cell[0], cell[1], cell[2]);
      if (SOLID[p]) return { t, cell: [cell[0], cell[1], cell[2]], face, material: p };
    }
    if (water) {
      const wet = WET[p] === 1;
      if (wet && !inWater && water.t < 0) {
        water.t = t;
        water.cell = [cell[0], cell[1], cell[2]];
      }
      inWater = wet;
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

/**
 * One past the highest voxel down column (⌊x⌋, ⌊z⌋) that is not air (water counts): where a shell
 * falling straight down meets the ground. Null for an empty column, or one off the map.
 */
export function groundTop(map: BrickMap, x: number, z: number): number | null {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (!map.inBounds(cx, 0, cz)) return null;
  for (let by = map.bricks.y - 1; by >= 0; by--) {
    if (map.table[map.brickIndex(cx >> 3, by, cz >> 3)] === 0) continue;
    for (let y = by * 8 + 7; y >= by * 8; y--) if (map.get(cx, y, cz) !== 0) return y + 1;
  }
  return null;
}
