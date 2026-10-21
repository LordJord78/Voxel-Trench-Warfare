/**
 * The max-height pyramid: for every column of bricks (8 × 8 voxels), one more
 * than the highest non-air voxel's y in it, or 0 when the column is empty;
 * each level up holds the max of the 2 × 2 cells below, down to one cell.
 *
 * A ray whose height stays at or above a cell's value all the way across that
 * cell cannot hit anything in it, so a long, low dusk shadow ray crosses open
 * field in strides of whole cells instead of brick by brick.
 */

import { BrickMap, UNIFORM } from '../world/bricks';

export interface PyramidLevel {
  w: number;
  h: number;
  offset: number;
}

export interface Pyramid {
  levels: PyramidLevel[];
  data: Uint32Array;
}

/** 1 + the highest non-air voxel's y in brick column (bx, bz), or 0. */
export function columnTop(map: BrickMap, bx: number, bz: number): number {
  for (let by = map.bricks.y - 1; by >= 0; by--) {
    const bi = map.brickIndex(bx, by, bz);
    const e = map.table[bi];
    if (e === 0) continue;
    if (e & UNIFORM) return by * 8 + 8;
    const raw = map.denseView(bi)!;
    for (let ly = 7; ly >= 0; ly--) {
      for (let i = 0; i < 64; i++) if (raw[(i & 7) + ly * 8 + (i >> 3) * 64] !== 0) return by * 8 + ly + 1;
    }
  }
  return 0;
}

function shape(w: number, h: number): PyramidLevel[] {
  const levels: PyramidLevel[] = [];
  let offset = 0;
  for (;;) {
    levels.push({ w, h, offset });
    offset += w * h;
    if (w === 1 && h === 1) return levels;
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
  }
}

/** The max of the up-to-four cells under cell (i, j) of level k, in `data`. */
function reduce(levels: readonly PyramidLevel[], data: Uint32Array, k: number, i: number, j: number): number {
  const below = levels[k - 1];
  let m = 0;
  for (let z = 2 * j; z < Math.min(2 * j + 2, below.h); z++) {
    for (let x = 2 * i; x < Math.min(2 * i + 2, below.w); x++) m = Math.max(m, data[below.offset + z * below.w + x]);
  }
  return m;
}

/**
 * Recompute the levels above these changed level-0 cells of `data`, which is
 * laid out by `levels`. Returns the indices above level 0 that changed.
 */
export function propagate(levels: readonly PyramidLevel[], data: Uint32Array, cells: Iterable<number>): number[] {
  const changed: number[] = [];
  let current = new Set(cells);
  for (let k = 1; k < levels.length && current.size > 0; k++) {
    const below = levels[k - 1];
    const l = levels[k];
    const up = new Set<number>();
    for (const c of current) {
      const local = c - below.offset;
      const i = (local % below.w) >> 1;
      const j = Math.floor(local / below.w) >> 1;
      const at = l.offset + j * l.w + i;
      if (up.has(at)) continue;
      const v = reduce(levels, data, k, i, j);
      if (v === data[at]) continue;
      data[at] = v;
      changed.push(at);
      up.add(at);
    }
    current = up;
  }
  return changed;
}

export function buildPyramid(map: BrickMap): Pyramid {
  const levels = shape(map.bricks.x, map.bricks.z);
  const last = levels[levels.length - 1];
  const p: Pyramid = { levels, data: new Uint32Array(last.offset + 1) };
  for (let bz = 0; bz < map.bricks.z; bz++) {
    for (let bx = 0; bx < map.bricks.x; bx++) p.data[bz * map.bricks.x + bx] = columnTop(map, bx, bz);
  }
  for (let k = 1; k < levels.length; k++) {
    const l = levels[k];
    for (let j = 0; j < l.h; j++) for (let i = 0; i < l.w; i++) p.data[l.offset + j * l.w + i] = reduce(levels, p.data, k, i, j);
  }
  return p;
}

/**
 * Bring the pyramid up to date after these bricks changed. Returns the
 * indices into `data` whose values changed, at every level.
 */
export function updatePyramid(p: Pyramid, map: BrickMap, bricks: readonly number[]): number[] {
  const columns = new Set<number>();
  for (const bi of bricks) {
    const bx = bi % map.bricks.x;
    const bz = Math.floor(bi / (map.bricks.x * map.bricks.y));
    columns.add(bz * map.bricks.x + bx);
  }
  const changed: number[] = [];
  for (const c of columns) {
    const v = columnTop(map, c % map.bricks.x, Math.floor(c / map.bricks.x));
    if (v === p.data[c]) continue;
    p.data[c] = v;
    changed.push(c);
  }
  return [...changed, ...propagate(p.levels, p.data, changed)];
}
