/**
 * The CPU reference for the flares' shadow maps (flare-shadow.wgsl). A flare's map is the
 * hemisphere below it on a paraboloid: a direction d (d.y ≤ 0) sits at (d.x, d.z) / (1 − d.y) on
 * the unit disc, and texel (i, j) at the disc point of its middle. Each texel holds how far from the
 * flare its ray runs before traceRef meets the voxel world, within the flare's reach; open if it
 * meets nothing there, or lies off the disc. Rays are rounded to f32, as the GPU builds them.
 */

import { FLARE_MAP_SIZE, paraboloid, unparaboloid } from '../../src/render/flare-shadows';
import type { BrickMap } from '../../src/world/bricks';
import { traceRef, type Vec3 } from './trace-ref';

/** A texel's distance where its ray meets nothing (or the texel lies off the disc). */
export const OPEN = Infinity;

/** Texel (i, j)'s point on the disc. */
export function texelDisc(i: number, j: number): [number, number] {
  return [((i + 0.5) / FLARE_MAP_SIZE) * 2 - 1, ((j + 0.5) / FLARE_MAP_SIZE) * 2 - 1];
}

/** Texel (i, j)'s ray from a flare at `at` (voxels): its direction, or null off the disc. */
export function texelRay(at: Vec3, i: number, j: number): { o: Vec3; d: Vec3 } | null {
  const [s, t] = texelDisc(i, j);
  if (s * s + t * t > 1) return null;
  const d = unparaboloid(s, t);
  const f = Math.fround;
  return { o: [f(at[0]), f(at[1]), f(at[2])], d: [f(d[0]), f(d[1]), f(d[2])] };
}

/** Texel (i, j)'s distance from a flare at `at` reaching `reach` voxels, or OPEN. */
export function texelDistance(map: BrickMap, at: Vec3, reach: number, i: number, j: number): number {
  const ray = texelRay(at, i, j);
  if (!ray) return OPEN;
  const hit = traceRef(map, ray.o, ray.d, reach);
  return hit.hit ? hit.t : OPEN;
}

/** Point p's texel coordinates in a flare's map (texel (i, j)'s middle at i + 0.5, j + 0.5) and its distance; null above the flare. */
export function mapCoords(at: Vec3, p: Vec3): { s: number; t: number; dist: number } | null {
  const d: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  if (d[1] >= 0 || dist === 0) return null;
  const [s, t] = paraboloid([d[0] / dist, d[1] / dist, d[2] / dist]);
  return { s: ((s + 1) / 2) * FLARE_MAP_SIZE, t: ((t + 1) / 2) * FLARE_MAP_SIZE, dist };
}

/** Whether a flare at `at` lights p: a shadow ray from p toward it meets nothing on the way. */
export function litRef(map: BrickMap, at: Vec3, p: Vec3): boolean {
  const d: Vec3 = [at[0] - p[0], at[1] - p[1], at[2] - p[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  return !traceRef(map, p, [d[0] / dist, d[1] / dist, d[2] / dist], dist).hit;
}
