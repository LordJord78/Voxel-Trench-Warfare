/**
 * The water as a frame gives it to the reflection pass (reflect.wgsl): the battle's rings (the
 * director's, the newest MAX_RINGS), the wind's roughness, its clock, how far a reflection is traced,
 * and the glints: the battle's burning flares and fires as they are drawn (a flare's disc, a fire's
 * flames), the brightest MAX_GLINTS, each a disc of light the reflected ray may pass through. At rest
 * the water is still and nothing glints in it (no battle).
 */

import type { FireState } from '../battle/director';
import { fireTunables, type FireTunables } from '../battle/fires';
import { flareTunables, type FlareState, type FlareTunables } from '../battle/flares';
import type { RingState, WaterTunables } from '../battle/water';
import type { Tunables } from '../core/tunables';
import { MAX_GLINTS, MAX_RINGS } from './frame-uniforms';
import type { StructWriter } from './layout';

export interface WaterFrameTunables {
  /** How far a reflected ray is traced, metres; the sky beyond. */
  reflectM: number;
}

export function waterFrameTunables(tun: Tunables): WaterFrameTunables {
  return { reflectM: tun.f('render.reflect_m') };
}

/** The battle's water now: its rings, the wind (metres a second) with the slope it gives the surface, its clock (seconds), which the wind's waves travel by, and its glints. */
export interface FrameWater {
  rings: readonly RingState[];
  wind: readonly [number, number];
  slope: number;
  seconds: number;
  glints: readonly Glint[];
}

export const STILL_WATER: FrameWater = { rings: [], wind: [0, 0], slope: 0, seconds: 0, glints: [] };

/** A glint: where its light is (metres), its disc's radius (metres), its light (linear rgb). */
export interface Glint {
  position: readonly [number, number, number];
  radiusM: number;
  radiance: [number, number, number];
}

/** How the battle's flares and fires are drawn (effects-frame.ts), which their glints are: the discs' and flames' looks, and the effects' glow over the emissive. */
export interface GlintTerms {
  flare: FlareTunables;
  fire: FireTunables;
  particleGlow: number;
}

export function glintTerms(tun: Tunables): GlintTerms {
  return { flare: flareTunables(tun), fire: fireTunables(tun), particleGlow: tun.f('effects.particle_glow') };
}

/**
 * The battle's glints, the brightest MAX_GLINTS: each burning flare's disc as it is drawn (its
 * radius, and its light dimmed by the sky's flares key as the disc is), and each fire's flames, as
 * bright as they leave it, over their cluster, a little up their rise. A climbing flare draws no
 * disc, and glints not.
 */
export function glintsFrom(flares: readonly FlareState[], fires: readonly FireState[], flaresKey: number, terms: GlintTerms): Glint[] {
  const out: Glint[] = [];
  const { flare: ft, fire: fireT, particleGlow } = terms;
  for (const f of flares) {
    if (f.stage !== 'burning' || !(f.glow > 0)) continue;
    const k = ft.discGlow * f.glow * flaresKey * particleGlow;
    if (!(k > 0)) continue;
    out.push({ position: f.position, radiusM: ft.discSizeM / 2, radiance: [f.colour[0] * k, f.colour[1] * k, f.colour[2] * k] });
  }
  for (const f of fires) {
    if (!(f.strength > 0)) continue;
    const k = fireT.flameGlow * f.strength * particleGlow;
    const c = fireT.flameColour;
    out.push({ position: [f.at[0], f.at[1] + 0.4 * fireT.flameRiseM * f.size, f.at[2]], radiusM: 0.4 * f.size, radiance: [c[0] * k, c[1] * k, c[2] * k] });
  }
  const luma = (g: Glint) => 0.2126 * g.radiance[0] + 0.7152 * g.radiance[1] + 0.0722 * g.radiance[2];
  return out.sort((a, b) => luma(b) - luma(a)).slice(0, MAX_GLINTS);
}

/** The frame's water fields (frame-uniforms.ts): the newest MAX_RINGS rings, the roughness, the reach, the glints; voxels. */
export function writeWater(w: StructWriter, water: FrameWater, voxel: number, gt: WaterFrameTunables, wt: WaterTunables): void {
  const rings = water.rings.slice(-MAX_RINGS);
  w.set('ringCount', rings.length);
  rings.forEach((r, k) => {
    w.set(`rings.${2 * k}`, [r.at[0] / voxel, r.at[1] / voxel, r.at[2] / voxel, r.radiusM / voxel]);
    w.set(`rings.${2 * k + 1}`, [r.heightM / voxel, (wt.ringWidthM + 0.1 * r.age) / voxel, wt.ringWavelengthM / voxel, 0]);
  });
  const speed = Math.hypot(water.wind[0], water.wind[1]);
  w.set('waterWind', speed > 0 ? [water.wind[0] / speed, water.wind[1] / speed] : [1, 0]);
  w.set('waterSlope', water.slope);
  w.set('waterTime', water.seconds);
  w.set('reflectReach', gt.reflectM / voxel);
  const shown = water.glints.slice(0, MAX_GLINTS);
  w.set('glintCount', shown.length);
  shown.forEach((g, k) => {
    w.set(`glints.${2 * k}`, [g.position[0] / voxel, g.position[1] / voxel, g.position[2] / voxel, g.radiusM / voxel]);
    w.set(`glints.${2 * k + 1}`, [...g.radiance, 0]);
  });
}
