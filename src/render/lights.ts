/**
 * The point lights of the scene, from the plan: a lantern in every dugout,
 * always lit, and a handful of static flares hanging over no man's land that
 * burn as brightly as the time of day says. The lighting pass samples one of
 * them per pixel per frame, by its weighted importance, so their number costs
 * a loop rather than shadow rays; this sub-project caps them at 64.
 */

import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { lanternVoxel } from '../world/generation/furniture';
import type { WorldPlan } from '../world/generation/plan';
import { P, paletteData } from '../world/materials';

export const MAX_LIGHTS = 64;

export interface SceneLight {
  /** Metres. */
  position: [number, number, number];
  /** Metres: beyond this the light reaches nothing. */
  radius: number;
  /** Linear RGB. */
  colour: [number, number, number];
  intensity: number;
  kind: 'lantern' | 'flare';
}

/**
 * Where a lantern's light goes (metres): the middle of its glass voxel. Shadow rays toward a light
 * stop at its own voxel (lighting.wgsl), so the glass does not shadow its own light; a light in
 * front of the glass would cast the glass's shadow, three voxels square, round it on the wall.
 */
export function lanternLight(glass: readonly [number, number, number], voxel: number): [number, number, number] {
  return [(glass[0] + 0.5) * voxel, (glass[1] + 0.5) * voxel, (glass[2] + 0.5) * voxel];
}

export function sceneLights(plan: WorldPlan, tun: Tunables): SceneLight[] {
  const p = plan.params;
  const v = p.voxel;
  const glass = paletteData();
  const lanternColour: [number, number, number] = [glass[P.LANTERN_GLOW * 8], glass[P.LANTERN_GLOW * 8 + 1], glass[P.LANTERN_GLOW * 8 + 2]];
  const lights: SceneLight[] = [];
  for (const line of plan.lines) {
    for (const d of line.dugouts) {
      lights.push({
        position: lanternLight(lanternVoxel(d, p), v),
        radius: tun.f('render.lantern_radius_m'),
        colour: lanternColour,
        intensity: tun.f('render.lantern_intensity'),
        kind: 'lantern',
      });
    }
  }
  const rng = Rng.root(plan.seed).derive('render.flares');
  const ground = tun.f('world.ground_level_m');
  for (let i = 0; i < tun.i('render.flares'); i++) {
    const x = rng.uniform(20, p.dims.x * v - 20);
    const z = rng.uniform(p.layout.front * v + 4, p.layout.enemyFront * v - 4);
    const y = ground + rng.uniform(18, 34);
    const red = rng.chance(0.25);
    lights.push({
      position: [x, y, z],
      radius: tun.f('render.flare_radius_m'),
      colour: red ? [1.0, 0.25, 0.15] : [1.0, 0.88, 0.7],
      intensity: tun.f('render.flare_intensity'),
      kind: 'flare',
    });
  }
  if (lights.length > MAX_LIGHTS) throw new RangeError(`${lights.length} lights is over the ${MAX_LIGHTS} a frame samples`);
  return lights;
}

/** Eight floats per light, as the shader reads them: position and radius in voxels, colour, intensity (flares dimmed by `flares`). */
export function lightBuffer(lights: readonly SceneLight[], flares: number, voxel: number): Float32Array {
  const out = new Float32Array(Math.max(1, lights.length) * 8);
  lights.forEach((l, i) => {
    out.set([l.position[0] / voxel, l.position[1] / voxel, l.position[2] / voxel, l.radius / voxel, ...l.colour, l.kind === 'flare' ? l.intensity * flares : l.intensity], i * 8);
  });
  return out;
}
