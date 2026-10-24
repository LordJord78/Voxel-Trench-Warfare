/**
 * The lanterns in motion: each light as it is at a moment of the lights' clock, from its phase
 * (lights.ts). A lantern's flame wavers: its light strays a few per cent either way in three slow
 * beats, mixed differently for each lantern by its phase, never more than a couple of per cent from
 * one frame to the next. Flares are left as they are: the battle's director flies them
 * (src/battle/director.ts).
 */

import type { Tunables } from '../core/tunables';
import type { SceneLight } from './lights';

export interface LightMotion {
  /** The most a lantern's light strays from its intensity, as a fraction of it. */
  lanternFlicker: number;
}

export function lightMotion(tun: Tunables): LightMotion {
  return { lanternFlicker: tun.f('render.lantern_flicker') };
}

/**
 * A flame's beats: frequency (Hz), weight (the weights sum to 1, so the flicker never strays past
 * its bound) and how a lantern's phase offsets it (unrelated multiples, so each lantern mixes its
 * beats its own way). Their steepest, all at once, moves the light 0.17 of the flicker in a frame
 * at 60 Hz.
 */
const BEATS: readonly (readonly [number, number, number])[] = [
  [0.7, 0.5, 1],
  [1.9, 0.3, 7.31],
  [3.3, 0.2, 13.7],
];


function lantern(l: SceneLight, seconds: number, m: LightMotion): SceneLight {
  let s = 0;
  for (const [hz, weight, spread] of BEATS) s += weight * Math.sin(2 * Math.PI * (hz * seconds + l.phase * spread));
  return { ...l, intensity: l.intensity * (1 + m.lanternFlicker * s) };
}

/** The lights as they are `seconds` into the lights' clock. */
export function lightsAt(lights: readonly SceneLight[], seconds: number, motion: LightMotion): SceneLight[] {
  return lights.map((l) => (l.kind === 'lantern' ? lantern(l, seconds, motion) : l));
}
