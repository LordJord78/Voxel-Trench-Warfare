/**
 * Where stamps write. Generation fills one band at a time, but props, dugouts
 * and carves are placed in world coordinates and may straddle a band's edge;
 * each band draws the whole thing through a sink that keeps only its own
 * columns, so every band agrees on every voxel it shares with a neighbour.
 */

import type { BrickMap } from './bricks';

/** A band's world x range; stamps may skip work outside it. */
export interface Clip {
  x0: number;
  x1: number;
}

export interface VoxelSink {
  set(x: number, y: number, z: number, p: number): void;
  get(x: number, y: number, z: number): number;
}

/** A band map whose local x 0 is world x `x0`; writes outside it are dropped. */
export function bandSink(map: BrickMap, x0: number): VoxelSink {
  return {
    set: (x, y, z, p) => map.set(x - x0, y, z, p),
    get: (x, y, z) => map.get(x - x0, y, z),
  };
}
