/**
 * Axis-aligned collision against a voxel grid, Python's `physics/collision.py`.
 * Positions are metres; a body is an upright box standing on its foot centre.
 * Voxel size comes from the grid, so the same code runs the 0.5 m parity
 * fixtures and the 10 cm world.
 */

import { K, KIND_SOLID } from '../world/materials';
import type { VoxelGrid } from './grid';
import { Vec3 } from './vec';

const EPS = 1e-4;

/** Does an upright box standing on `centre` overlap any solid voxel? */
export function boxHitsSolid(g: VoxelGrid, centre: Vec3, halfX: number, height: number, halfZ = halfX): boolean {
  const s = g.voxel;
  const x0 = Math.floor((centre.x - halfX + EPS) / s);
  const x1 = Math.floor((centre.x + halfX - EPS) / s) + 1;
  const y0 = Math.floor((centre.y + EPS) / s);
  const y1 = Math.floor((centre.y + height - EPS) / s) + 1;
  const z0 = Math.floor((centre.z - halfZ + EPS) / s);
  const z1 = Math.floor((centre.z + halfZ - EPS) / s) + 1;
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        if (KIND_SOLID[g.kindAt(x, y, z)]) return true;
      }
    }
  }
  return false;
}

/** Top surface of the first solid voxel below `centre`, or null within `maxDrop`. */
export function groundHeightUnder(g: VoxelGrid, centre: Vec3, halfX: number, maxDrop: number): number | null {
  const s = g.voxel;
  const steps = Math.trunc(maxDrop / s) + 2;
  let y = Math.floor((centre.y - EPS) / s);
  for (let i = 0; i < steps; i++) {
    if (boxHitsSolid(g, new Vec3(centre.x, y * s, centre.z), halfX, s * 0.5)) return (y + 1) * s;
    y -= 1;
    if (y < -1) return null;
  }
  return null;
}

/**
 * Is any of what the body stands on of `kind`? Not the voxel under its centre:
 * one boot on a firing-step tread and one over the walkway is on the step.
 */
export function supportIs(g: VoxelGrid, centre: Vec3, halfX: number, kind: number): boolean {
  const s = g.voxel;
  const x0 = Math.floor((centre.x - halfX + EPS) / s);
  const x1 = Math.floor((centre.x + halfX - EPS) / s) + 1;
  const z0 = Math.floor((centre.z - halfX + EPS) / s);
  const z1 = Math.floor((centre.z + halfX - EPS) / s) + 1;
  const y = Math.floor((centre.y - s * 0.5) / s);
  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      if (g.kindAt(x, y, z) === kind) return true;
    }
  }
  return false;
}

/** How much of an upright body is in water, in metres: its highest wet sample, at voxel centres. */
export function submergedDepth(g: VoxelGrid, centre: Vec3, height: number): number {
  const s = g.voxel;
  const vx = Math.floor(centre.x / s);
  const vz = Math.floor(centre.z / s);
  let depth = 0;
  for (let y = centre.y + s * 0.5; y < centre.y + height; y += s) {
    if (g.kindAt(vx, Math.floor(y / s), vz) === K.WATER) depth = y - centre.y;
  }
  return depth;
}
