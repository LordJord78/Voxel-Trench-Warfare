/**
 * Spatter (the shots spec's §4): a critical hit marks what is behind the body with its blood. Rays
 * from where the round went in go on along it, within a cone about it; then more fall from there,
 * within a cone about an axis tilted from straight down toward the way the round went, so a body
 * standing in the open marks the ground behind it. Both cones pack their rays toward their axis: a
 * dense splat with a thin fringe. Each ray recolours the first thing it meets within reach to its
 * kind's blood shade (materials.ts BLOOD_OF), if its kind takes one, and splats: up to [hits]
 * spatter_splat of that voxel's eight neighbours on the face it struck take it too, seeded, fewer the
 * further the ray went from its cone's axis. A neighbour keeps every rule the voxel struck keeps (its
 * kind must take blood, not inside a crater's region out, within the reach), and is marked only where
 * its own face there is open to the air, so the splat lies on the face and never round a corner. A
 * drop into water splats nothing.
 *
 * A drop of blood flies through air and wire. It lands on anything opaque, and that includes cloth,
 * which a round goes through: a gas curtain catches it. Water swallows it, so the mud under a
 * flooded crater is not marked; the water's surface is all that is drawn of it. As a char does
 * (world/char.ts), it changes only a voxel's colour: each blood shade keeps every rule of the kind it
 * marks, every kind of earth's among them.
 *
 * Positions and directions are in voxels. It is pure: the rays are drawn from the seed alone.
 */

import { cos, hypot, pow, radians, sin, TAU } from '../core/dmath';
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
 * spreads the rays evenly over the cone's width and 2 packs a splat with a thin fringe. And how many
 * of its eight neighbours on the face a ray's voxel splats onto at most (on the axis; fewer out
 * toward the cone's edge, none at it).
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
  splat: number;
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
    splat: tun.i('hits.spatter_splat'),
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

/** A face (raycast's: −x, +x, −y, +y, −z, +z) as the way out of it, and the two axes across it. */
const NORMALS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const;
const ACROSS = [[1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]] as const;
/** A voxel's eight neighbours on a face, along its two axes across. */
const RING = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;

/** The splat's own draws: how many neighbours a ray may splat onto, and the stream they are drawn from. */
interface Splat {
  most: number;
  rng: Rng;
}

/**
 * `n` rays from `origin` about unit `axis`, drawn from `rng`: each off it by `coneDeg` × r^`core`
 * (r uniform in [0, 1)) and its way round uniform, recolouring the first voxel it meets within
 * `reach` to its blood shade, if it takes one and `skip` does not name it; and of the eight round
 * that voxel on the face it struck, the first ⌈most × (1 − r^core)⌉ of `splat.most` drawn from
 * `splat.rng` (every ray draws them, meeting anything or not, so what one ray splats never changes
 * what another does), each as the voxel struck is and only where its own face there is open. How many
 * it recoloured.
 */
function cast(map: BrickMap, origin: [number, number, number], axis: readonly number[], n: number, coneDeg: number, reach: number, core: number, rng: Rng, splat: Splat, skip?: (box: Box) => boolean): number {
  const [u, w] = across(axis);
  const cone = radians(coneDeg);
  let marked = 0;
  /** Voxel (x, y, z) marked with its blood, if it takes one, `skip` leaves it, and it is within `reach` of the origin. */
  const mark = (x: number, y: number, z: number, material: number): void => {
    const shade = SHADE[material];
    // Blood is its own shade, so a voxel two rays meet counts once.
    if (shade === material) return;
    const gap = hypot(Math.max(0, x - origin[0], origin[0] - x - 1), Math.max(0, y - origin[1], origin[1] - y - 1), Math.max(0, z - origin[2], origin[2] - z - 1));
    if (gap > reach) return;
    if (skip?.({ x0: x, y0: y, z0: z, x1: x + 1, y1: y + 1, z1: z + 1 })) return;
    map.set(x, y, z, shade);
    marked++;
  };
  const picks: number[] = [];
  for (let k = 0; k < n; k++) {
    const share = pow(rng.float(), core);
    const off = cone * share;
    const a = rng.uniform(0, TAU);
    const c = cos(off);
    const s = sin(off);
    const cu = cos(a) * s;
    const cw = sin(a) * s;
    const ray: [number, number, number] = [axis[0] * c + u[0] * cu + w[0] * cw, axis[1] * c + u[1] * cu + w[1] * cw, axis[2] * c + u[2] * cu + w[2] * cw];
    // Its neighbours, the first `most` of the eight shuffled.
    const order = [0, 1, 2, 3, 4, 5, 6, 7];
    picks.length = 0;
    for (let j = 0; j < splat.most; j++) {
      const i = splat.rng.randint(j, 8);
      [order[j], order[i]] = [order[i], order[j]];
      picks.push(order[j]);
    }
    const hit = raycast(map, origin, ray, reach, undefined, STOPS);
    if (!hit) continue;
    const [x, y, z] = hit.cell;
    mark(x, y, z, hit.material);
    // Water swallows the drop, and its splat with it.
    if (hit.face < 0 || kindOf(hit.material) === K.WATER) continue;
    const out = NORMALS[hit.face];
    const [p, q] = ACROSS[hit.face];
    const many = Math.ceil(splat.most * (1 - share));
    for (let j = 0; j < many; j++) {
      const cell = [x, y, z];
      cell[p] += RING[picks[j]][0];
      cell[q] += RING[picks[j]][1];
      const material = map.get(cell[0], cell[1], cell[2]);
      // On the face: a voxel a drop stops at, whose own face there is open (air or wire before it).
      if (!STOPS[material] || STOPS[map.get(cell[0] + out[0], cell[1] + out[1], cell[2] + out[2])]) continue;
      mark(cell[0], cell[1], cell[2], material);
    }
  }
  return marked;
}

/**
 * Spatter from `from` on along `dir` (voxels), drawn from `seed` (a fraction draws as its floor):
 * `t.rays` rays within `t.coneDeg` of the round, reaching `t.reach`; then, from the same stream so
 * they never change what those mark, `t.fallRays` within `t.fallConeDeg` of the axis `t.fallTiltDeg`
 * from straight down toward the round (straight down for a round within 1e-6 of vertical), reaching
 * `t.fallReach`. Each recolours the first voxel it meets to its blood shade, if it takes one, and
 * splats onto up to `t.splat` of its neighbours on the face it struck, drawn from a stream of the
 * seed's own (so the splat never changes where a ray goes). A voxel whose box `skip` names is left:
 * a crater's region out (sim/destruction.ts overlapsOut), whose bricks coming back would undo it. How
 * many voxels it recoloured; a voxel two rays meet counts once. A seed, origin or direction not
 * finite, or a zero direction, marks nothing.
 */
export function spatter(map: BrickMap, from: readonly number[], dir: readonly number[], seed: number, t: SpatterTunables, skip?: (box: Box) => boolean): number {
  const d = unit(dir);
  if (!d || !Number.isFinite(seed) || !(Number.isFinite(from[0]) && Number.isFinite(from[1]) && Number.isFinite(from[2]))) return 0;
  const root = Rng.root(Math.floor(seed));
  const rng = root.derive('spatter');
  const splat: Splat = { most: Math.max(0, Math.min(RING.length, Math.floor(t.splat))), rng: root.derive('spatter.splat') };
  const origin: [number, number, number] = [from[0], from[1], from[2]];
  const along = cast(map, origin, d, t.rays, t.coneDeg, t.reach, t.core, rng, splat, skip);
  return along + cast(map, origin, fallAxis(d, t.fallTiltDeg), t.fallRays, t.fallConeDeg, t.fallReach, t.core, rng, splat, skip);
}
