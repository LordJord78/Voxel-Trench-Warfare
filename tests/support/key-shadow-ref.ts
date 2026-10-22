/**
 * The CPU reference for the key light's height map (key-shadow.wgsl). A texel's ray starts past the
 * map's farthest corner and runs along the light; its depth is where traceRef first meets the
 * voxel world, measured along the light from the plane through the map's middle. A texel whose ray
 * meets nothing is open. Rays are rounded to f32, as the GPU builds them.
 */

import { KEY_MAP_SIZE, type KeyShadowInfo } from '../../src/render/key-shadow';
import type { BrickMap } from '../../src/world/bricks';
import { traceRef, type Vec3 } from './trace-ref';

/** A texel's depth where its ray meets nothing. */
export const OPEN = Infinity;

/** Texel (i, j)'s ray: where it starts, and the way it runs (the light's). */
export function texelRay(info: KeyShadowInfo, i: number, j: number): { o: Vec3; d: Vec3 } {
  const a = (i + 0.5 - KEY_MAP_SIZE / 2) * info.texel;
  const b = (j + 0.5 - KEY_MAP_SIZE / 2) * info.texel;
  const f = Math.fround;
  const o = [0, 1, 2].map((k) => f(info.origin[k] + info.u[k] * a + info.v[k] * b - info.along[k] * info.reach));
  return { o: [o[0], o[1], o[2]], d: [f(info.along[0]), f(info.along[1]), f(info.along[2])] };
}

/** Texel (i, j)'s depth along the light from the map's middle (voxels), or OPEN. */
export function texelDepth(map: BrickMap, info: KeyShadowInfo, i: number, j: number): number {
  const { o, d } = texelRay(info, i, j);
  const hit = traceRef(map, o, d, 2 * info.reach);
  return hit.hit ? hit.t - info.reach : OPEN;
}

/** Point p's texel coordinates (continuous: texel (i, j)'s middle is at i + 0.5, j + 0.5) and its depth along the light. */
export function mapCoords(info: KeyShadowInfo, p: Vec3): { s: number; t: number; depth: number } {
  const q = [p[0] - info.origin[0], p[1] - info.origin[1], p[2] - info.origin[2]];
  const dot = (a: readonly number[]) => q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  return { s: dot(info.u) / info.texel + KEY_MAP_SIZE / 2, t: dot(info.v) / info.texel + KEY_MAP_SIZE / 2, depth: dot(info.along) };
}

/** Whether the key light reaches p: a shadow ray from p toward it meets nothing. */
export function litRef(map: BrickMap, keyDir: Vec3, p: Vec3): boolean {
  return !traceRef(map, p, keyDir, 1e6).hit;
}
