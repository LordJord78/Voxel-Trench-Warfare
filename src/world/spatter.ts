/**
 * Spatter (the shots spec's §4): a critical hit marks what is behind the body with its blood. Rays
 * from where the round went in go on along it, within a cone about it; then more fall from there,
 * within a cone about an axis tilted from straight down toward the way the round went, so a body
 * standing in the open marks the ground behind it. Both cones pack their rays toward their axis: a
 * dense splat with a thin fringe. Each ray recolours the first thing it meets within reach to its
 * kind's blood shade (materials.ts BLOOD_OF), if its kind takes one.
 *
 * A drop of blood flies through air and wire. It lands on anything opaque, and that includes cloth,
 * which a round goes through: a gas curtain catches it. Water swallows it, so the mud under a
 * flooded crater is not marked; the water's surface is all that is drawn of it. As a char does
 * (world/char.ts), it changes only a voxel's colour: each blood shade keeps every rule of the kind it
 * marks, every kind of earth's among them.
 *
 * Positions and directions are in voxels. It is pure: the rays are drawn from the seed alone.
 */

import { cos, pow, radians, sin, TAU } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { BrickMap } from './bricks';
import { BLOOD_OF, isOpaque, K, kindOf, P, PALETTE } from './materials';
import { raycast } from './raycast';
import type { Box } from './region';

/**
 * [hits]' spatter. On along the round: how many rays, their cone's half-angle (degrees) and how far
 * each reaches (voxels). Falling: how many rays, their cone's half-angle about an axis `fallTiltDeg`
 * from straight down toward the round, and how far each reaches (voxels). And how both cones pack
 * toward their axis: a ray's angle off it is the half-angle × r^core, r uniform in [0, 1), so 1
 * spreads the rays evenly over the cone's width and 2 packs a splat with a thin fringe.
 */
export interface SpatterTunables {
  rays: number;
  coneDeg: number;
  reach: number;
  fallRays: number;
  fallConeDeg: number;
  fallTiltDeg: number;
  fallReach: number;
  core: number;
}

/** [hits] spatter_*, the reaches in voxels of `voxel` metres. */
export function spatterTunables(tun: Tunables, voxel: number): SpatterTunables {
  return {
    rays: tun.i('hits.spatter_rays'),
    coneDeg: tun.f('hits.spatter_cone_deg'),
    reach: tun.f('hits.spatter_reach_m') / voxel,
    fallRays: tun.i('hits.spatter_fall_rays'),
    fallConeDeg: tun.f('hits.spatter_fall_cone_deg'),
    fallTiltDeg: tun.f('hits.spatter_fall_tilt_deg'),
    fallReach: tun.f('hits.spatter_fall_reach_m') / voxel,
    core: tun.f('hits.spatter_core'),
  };
}

/** What a drop of blood stops at: anything opaque, cloth among it, and water. Air and wire let it by. */
const STOPS = Uint8Array.from({ length: 256 }, (_, p) => (isOpaque(p) || kindOf(p) === K.WATER ? 1 : 0));

/**
 * What a spatter leaves of each shade: its kind's blood; or itself, where its kind takes none, where
 * it glows (its light is the plan's, as a round's chip leaves it), and on a firing step's bench top,
 * which the controller knows by its shade (physics/grid.ts). Blood is its own.
 */
const SHADE = Uint8Array.from({ length: 256 }, (_, p) => (p === P.BENCH || (PALETTE[p]?.emission ?? 0) > 0 ? p : (BLOOD_OF(kindOf(p)) ?? p)));

/** A round within this of straight up or down (the sine of its angle off it) has no way across the ground. */
const VERTICAL = 1e-6;

/** `v` at unit length; null if it is zero or not finite. Scaled by its largest part first, so a tiny one or a huge one is no matter. */
function unit(v: readonly number[]): [number, number, number] | null {
  const m = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  if (!(m > 0 && m < Infinity)) return null;
  const x = v[0] / m;
  const y = v[1] / m;
  const z = v[2] / m;
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/** Two unit directions square to unit `d` and to each other. */
function across(d: readonly number[]): [number[], number[]] {
  // From whichever of up and x the axis is further from.
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
  const l = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  for (let k = 0; k < 3; k++) u[k] /= l;
  return [u, [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]];
}

/** The falling rays' axis for a round along unit `d`: `tiltDeg` from straight down toward the way it goes across the ground; straight down for one with no way across it. */
function fallAxis(d: readonly number[], tiltDeg: number): [number, number, number] {
  const h = Math.sqrt(d[0] * d[0] + d[2] * d[2]);
  if (!(h > VERTICAL)) return [0, -1, 0];
  const s = sin(radians(tiltDeg));
  return [(d[0] / h) * s, -cos(radians(tiltDeg)), (d[2] / h) * s];
}

/**
 * `n` rays from `origin` about unit `axis`, drawn from `rng`: each off it by `coneDeg` × r^`core`
 * (r uniform in [0, 1)) and its way round uniform, recolouring the first voxel it meets within
 * `reach` to its blood shade, if it takes one and `skip` does not name it. How many it recoloured.
 */
function cast(map: BrickMap, origin: [number, number, number], axis: readonly number[], n: number, coneDeg: number, reach: number, core: number, rng: Rng, skip?: (box: Box) => boolean): number {
  const [u, w] = across(axis);
  const cone = radians(coneDeg);
  let marked = 0;
  for (let k = 0; k < n; k++) {
    const off = cone * pow(rng.float(), core);
    const a = rng.uniform(0, TAU);
    const c = cos(off);
    const s = sin(off);
    const cu = cos(a) * s;
    const cw = sin(a) * s;
    const ray: [number, number, number] = [axis[0] * c + u[0] * cu + w[0] * cw, axis[1] * c + u[1] * cu + w[1] * cw, axis[2] * c + u[2] * cu + w[2] * cw];
    const hit = raycast(map, origin, ray, reach, undefined, STOPS);
    if (!hit) continue;
    const shade = SHADE[hit.material];
    // Blood is its own shade, so a voxel two rays meet counts once.
    if (shade === hit.material) continue;
    const [x, y, z] = hit.cell;
    if (skip?.({ x0: x, y0: y, z0: z, x1: x + 1, y1: y + 1, z1: z + 1 })) continue;
    map.set(x, y, z, shade);
    marked++;
  }
  return marked;
}

/**
 * Spatter from `from` on along `dir` (voxels), drawn from `seed` (a fraction draws as its floor):
 * `t.rays` rays within `t.coneDeg` of the round, reaching `t.reach`; then, from the same stream so
 * they never change what those mark, `t.fallRays` within `t.fallConeDeg` of the axis `t.fallTiltDeg`
 * from straight down toward the round (straight down for a round within 1e-6 of vertical), reaching
 * `t.fallReach`. Each recolours the first voxel it meets to its blood shade, if it takes one. A
 * voxel whose box `skip` names is left: a crater's region out (sim/destruction.ts overlapsOut), whose
 * bricks coming back would undo it. How many voxels it recoloured; a voxel two rays meet counts once.
 * A seed, origin or direction not finite, or a zero direction, marks nothing.
 */
export function spatter(map: BrickMap, from: readonly number[], dir: readonly number[], seed: number, t: SpatterTunables, skip?: (box: Box) => boolean): number {
  const d = unit(dir);
  if (!d || !Number.isFinite(seed) || !(Number.isFinite(from[0]) && Number.isFinite(from[1]) && Number.isFinite(from[2]))) return 0;
  const rng = Rng.root(Math.floor(seed)).derive('spatter');
  const origin: [number, number, number] = [from[0], from[1], from[2]];
  const along = cast(map, origin, d, t.rays, t.coneDeg, t.reach, t.core, rng, skip);
  return along + cast(map, origin, fallAxis(d, t.fallTiltDeg), t.fallRays, t.fallConeDeg, t.fallReach, t.core, rng, skip);
}
