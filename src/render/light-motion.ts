/**
 * The lights in motion: each light as it is at a moment of the lights' clock, from its phase
 * (lights.ts).
 *
 * A lantern's flame wavers: its light strays a few per cent either way in three slow beats, mixed
 * differently for each lantern by its phase, never more than a couple of per cent from one frame to
 * the next. A flare burns for its burn, sinking slowly under its parachute; it gutters out over its
 * last seconds and is lit again where it began. Its phase sets how far through its burn it is, so the
 * flares go out one at a time rather than together. The scene's own flares are the battle's, which
 * its director flies (src/battle/director.ts); these are the flares a test gives (useLights), as
 * sub-project 2's gates measured them.
 */

import type { Tunables } from '../core/tunables';
import type { SceneLight } from './lights';

export interface LightMotion {
  /** The most a lantern's light strays from its intensity, as a fraction of it. */
  lanternFlicker: number;
  /** Seconds a flare burns, from being lit to out. */
  flareBurn: number;
  /** Metres a second a flare sinks as it burns. */
  flareSink: number;
  /** Seconds a flare takes to catch. */
  flareIgnite: number;
  /** Seconds a flare takes to gutter out, at the end of its burn. */
  flareFade: number;
}

export function lightMotion(tun: Tunables): LightMotion {
  return {
    lanternFlicker: tun.f('render.lantern_flicker'),
    flareBurn: tun.f('render.flare_burn_s'),
    flareSink: tun.f('render.flare_sink_mps'),
    flareIgnite: tun.f('render.flare_ignite_s'),
    flareFade: tun.f('render.flare_fade_s'),
  };
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

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

function lantern(l: SceneLight, seconds: number, m: LightMotion): SceneLight {
  let s = 0;
  for (const [hz, weight, spread] of BEATS) s += weight * Math.sin(2 * Math.PI * (hz * seconds + l.phase * spread));
  return { ...l, intensity: l.intensity * (1 + m.lanternFlicker * s) };
}

function flare(l: SceneLight, seconds: number, m: LightMotion): SceneLight {
  // Seconds into its burn.
  const burnt = ((((seconds / m.flareBurn + l.phase) % 1) + 1) % 1) * m.flareBurn;
  const glow = smooth(burnt / m.flareIgnite) * smooth((m.flareBurn - burnt) / m.flareFade);
  return { ...l, position: [l.position[0], l.position[1] - m.flareSink * burnt, l.position[2]], intensity: l.intensity * glow };
}

/** The lights as they are `seconds` into the lights' clock. */
export function lightsAt(lights: readonly SceneLight[], seconds: number, motion: LightMotion): SceneLight[] {
  return lights.map((l) => (l.kind === 'lantern' ? lantern(l, seconds, motion) : flare(l, seconds, motion)));
}
