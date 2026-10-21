/**
 * Where stamps write. Generation fills one band at a time, but props, dugouts
 * and carves are placed in world coordinates and may straddle a band's edge;
 * each band draws the whole thing through a sink that keeps only its own
 * columns, so every band agrees on every voxel it shares with a neighbour.
 */

import type { BrickMap } from './bricks';
import { P, isLoose } from './materials';

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

/**
 * Cutting a box into the ground leaves a vertical face around it. Earth holds a
 * vertical face; loose spoil does not. So the one-voxel ring outside the cut is
 * packed: loose voxels there, over [y0, y1), become packed mud and can never
 * slump into the cut.
 */
export function firmRing(sink: VoxelSink, clip: Clip, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): void {
  for (let x = Math.max(x0 - 1, clip.x0); x <= Math.min(x1, clip.x1 - 1); x++) {
    for (let z = z0 - 1; z <= z1; z++) {
      if (x >= x0 && x < x1 && z >= z0 && z < z1) continue;
      for (let y = y0; y < y1; y++) if (isLoose(sink.get(x, y, z))) sink.set(x, y, z, P.MUD_DARK);
    }
  }
}
