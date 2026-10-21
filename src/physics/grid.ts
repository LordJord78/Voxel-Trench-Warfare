/**
 * The voxel grids the controller collides with: the 10 cm brick map, and
 * small dense grids for the parity fixtures and tests. Both read outside the
 * world as Python's did: its solid skirt (subsoil) to the sides and below, so
 * no one walks off the map, and air above, so its top roofs no one.
 */

import type { BrickMap } from '../world/bricks';
import { K, kindOf } from '../world/materials';

export interface VoxelGrid {
  /** Metres per voxel. */
  readonly voxel: number;
  /** The material kind at a voxel. */
  kindAt(x: number, y: number, z: number): number;
}

export function brickGrid(map: BrickMap, voxel: number): VoxelGrid {
  const { x: nx, y: ny, z: nz } = map.dims;
  return {
    voxel,
    kindAt(x, y, z) {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return y >= ny ? K.AIR : K.SUBSOIL;
      return kindOf(map.get(x, y, z));
    },
  };
}

/** A dense grid of kinds, `boxes` ([x0, y0, z0, x1, y1, z1, kind], half-open) written in order over air. */
export function boxGrid(dims: readonly [number, number, number], voxel: number, boxes: readonly (readonly number[])[]): VoxelGrid {
  const [nx, ny, nz] = dims;
  const kinds = new Uint8Array(nx * ny * nz);
  for (const [x0, y0, z0, x1, y1, z1, kind] of boxes) {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) kinds[(x * ny + y) * nz + z] = kind;
  }
  return {
    voxel,
    kindAt(x, y, z) {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return y >= ny ? K.AIR : K.SUBSOIL;
      return kinds[(x * ny + y) * nz + z];
    },
  };
}
