/**
 * The point lights of the scene, from the plan: a lantern in every dugout,
 * always lit, and a handful of flares hanging over no man's land that burn as
 * brightly as the time of day says. They are the lights at rest: each has a
 * phase, and light-motion.ts flickers the lanterns from it, frame by frame.
 * With the lights running, the battle's director flies the flares instead
 * (battleFlareLights). A frame takes as many as 1,024.
 */

import type { FlareState, FlareTunables } from '../battle/flares';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { lanternFacing, lanternVoxel } from '../world/generation/furniture';
import type { WorldPlan } from '../world/generation/plan';
import { P, paletteData } from '../world/materials';

export const MAX_LIGHTS = 1024;

export interface SceneLight {
  /** Metres. */
  position: [number, number, number];
  /** Metres: beyond this the light reaches nothing. */
  radius: number;
  /** Linear RGB. */
  colour: [number, number, number];
  intensity: number;
  kind: 'lantern' | 'flare';
  /** In [0, 1): where the light is in its motion's cycles (light-motion.ts), its own. */
  phase: number;
  /** A battle flare's, kept as it is fired and goes out (its shadow map follows it). */
  id?: number;
}

/** The battle's flares burning now (the director's), as flare lights at their glow. */
export function battleFlareLights(states: readonly FlareState[], ft: FlareTunables): SceneLight[] {
  return states
    .filter((s) => s.stage === 'burning' && s.glow > 0)
    .map((s) => ({ position: [s.position[0], s.position[1], s.position[2]], radius: ft.radiusM, colour: s.colour, intensity: ft.intensity * s.glow, kind: 'flare', phase: 0, id: s.id }));
}

/** Each light's phase, by its index: the golden ratio's sequence, so no two match and they spread evenly. */
const phaseOf = (i: number) => (0.5 + i * 0.6180339887498949) % 1;

/**
 * Where a lantern's light goes (metres): its flame, a voxel out from the middle of its glass the way
 * it faces, 15 cm off the wall it hangs on, so the wall round it catches the light as approved.
 * Shadow rays toward a light end short of it (lighting.wgsl), so the glass behind the flame does not
 * cast its shadow, three voxels square, round itself on the wall.
 */
export function lanternLight(glass: readonly [number, number, number], facing: readonly [number, number, number], voxel: number): [number, number, number] {
  return [(glass[0] + 0.5 + facing[0]) * voxel, (glass[1] + 0.5 + facing[1]) * voxel, (glass[2] + 0.5 + facing[2]) * voxel];
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
        position: lanternLight(lanternVoxel(d, p), lanternFacing(d), v),
        radius: tun.f('render.lantern_radius_m'),
        colour: lanternColour,
        intensity: tun.f('render.lantern_intensity'),
        kind: 'lantern',
        phase: phaseOf(lights.length),
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
      phase: phaseOf(lights.length),
    });
  }
  if (lights.length > MAX_LIGHTS) throw new RangeError(`${lights.length} lights is over the ${MAX_LIGHTS} a frame takes`);
  return lights;
}

/** Eight floats per light, as the shader reads them: position and radius in voxels, colour, intensity (flares dimmed by `flares`). */
export function lightBuffer(lights: readonly SceneLight[], flares: number, voxel: number): Float32Array {
  if (lights.length > MAX_LIGHTS) throw new RangeError(`${lights.length} lights is over the ${MAX_LIGHTS} a frame takes`);
  const out = new Float32Array(Math.max(1, lights.length) * 8);
  lights.forEach((l, i) => {
    out.set([l.position[0] / voxel, l.position[1] / voxel, l.position[2] / voxel, l.radius / voxel, ...l.colour, l.kind === 'flare' ? l.intensity * flares : l.intensity], i * 8);
  });
  return out;
}
