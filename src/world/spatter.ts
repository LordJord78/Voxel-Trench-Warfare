/**
 * Spatter (the shots spec's §4): a critical hit marks what is behind the body with its blood. Rays
 * from where the round went in go on along it, drawn uniformly over a cone about it, and each
 * recolours the first thing it meets within reach to its kind's blood shade (materials.ts
 * BLOOD_OF), if its kind takes one.
 *
 * A drop of blood flies through air and wire. It lands on anything opaque, and that includes cloth,
 * which a round goes through: a gas curtain catches it. Water swallows it, so the mud under a
 * flooded crater is not marked; the water's surface is all that is drawn of it. As a char does
 * (world/char.ts), it changes only a voxel's colour: each blood shade is of the kind it marks.
 *
 * Positions and directions are in voxels. It is pure: the cone is drawn from the seed alone.
 */

import { cos, radians, sin, TAU } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { BrickMap } from './bricks';
import { BLOOD_OF, isOpaque, K, kindOf, P, PALETTE } from './materials';
import { raycast } from './raycast';
import type { Box } from './region';

/** [hits]' spatter: how many rays, their cone's half-angle (degrees), and how far each reaches (voxels). */
export interface SpatterTunables {
  rays: number;
  coneDeg: number;
  reach: number;
}

/** [hits] spatter_rays, spatter_cone_deg and spatter_reach_m, the reach in voxels of `voxel` metres. */
export function spatterTunables(tun: Tunables, voxel: number): SpatterTunables {
  return { rays: tun.i('hits.spatter_rays'), coneDeg: tun.f('hits.spatter_cone_deg'), reach: tun.f('hits.spatter_reach_m') / voxel };
}

/** What a drop of blood stops at: anything opaque, cloth among it, and water. Air and wire let it by. */
const STOPS = Uint8Array.from({ length: 256 }, (_, p) => (isOpaque(p) || kindOf(p) === K.WATER ? 1 : 0));

/**
 * What a spatter leaves of each shade: its kind's blood; or itself, where its kind takes none, where
 * it glows (its light is the plan's, as a round's chip leaves it), and on a firing step's bench top,
 * which the controller knows by its shade (physics/grid.ts). Blood is its own.
 */
const SHADE = Uint8Array.from({ length: 256 }, (_, p) => (p === P.BENCH || (PALETTE[p]?.emission ?? 0) > 0 ? p : (BLOOD_OF(kindOf(p)) ?? p)));

/** Two unit directions square to unit `d` and to each other. */
function across(d: readonly number[]): [number[], number[]] {
  // From whichever of up and x the round is further from.
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
  const l = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  for (let k = 0; k < 3; k++) u[k] /= l;
  return [u, [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]];
}

/**
 * Spatter from `from` on along `dir` (voxels), drawn from `seed` (an integer): `t.rays` rays,
 * uniform over the cone of `t.coneDeg` about it, each recolouring the first voxel it meets within
 * `t.reach` to its blood shade, if it takes one. A voxel whose box `skip` names is left: a crater's
 * region out (sim/destruction.ts overlapsOut), whose bricks coming back would undo it. How many
 * voxels it recoloured; a voxel two rays meet counts once.
 */
export function spatter(map: BrickMap, from: readonly number[], dir: readonly number[], seed: number, t: SpatterTunables, skip?: (box: Box) => boolean): number {
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  if (!(l > 0)) return 0;
  const d = [dir[0] / l, dir[1] / l, dir[2] / l];
  const [u, w] = across(d);
  const rng = Rng.root(seed).derive('spatter');
  const cosCone = cos(radians(t.coneDeg));
  const origin: [number, number, number] = [from[0], from[1], from[2]];
  let marked = 0;
  for (let k = 0; k < t.rays; k++) {
    // Uniform over the cone's cap: the cosine of its angle off the round uniform, and its way round
    // the round uniform.
    const c = 1 - rng.float() * (1 - cosCone);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const a = rng.uniform(0, TAU);
    const cu = cos(a) * s;
    const cw = sin(a) * s;
    const ray: [number, number, number] = [d[0] * c + u[0] * cu + w[0] * cw, d[1] * c + u[1] * cu + w[1] * cw, d[2] * c + u[2] * cu + w[2] * cw];
    const hit = raycast(map, origin, ray, t.reach, undefined, STOPS);
    if (!hit) continue;
    const shade = SHADE[hit.material];
    if (shade === hit.material) continue;
    const [x, y, z] = hit.cell;
    if (skip?.({ x0: x, y0: y, z0: z, x1: x + 1, y1: y + 1, z1: z + 1 })) continue;
    map.set(x, y, z, shade);
    marked++;
  }
  return marked;
}
