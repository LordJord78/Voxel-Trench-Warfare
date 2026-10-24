/**
 * The water as a frame gives it to the reflection pass (reflect.wgsl): the battle's rings (the
 * director's, the newest MAX_RINGS), the wind's roughness, how far a reflection is traced, and the
 * glints: the frame's flares and fires, the brightest MAX_GLINTS, each a disc of light the
 * reflected ray may pass through. At rest the water is still (no battle, no rings, no wind).
 */

import type { RingState, WaterTunables } from '../battle/water';
import type { Tunables } from '../core/tunables';
import { MAX_GLINTS, MAX_RINGS } from './frame-uniforms';
import type { StructWriter } from './layout';
import type { SceneLight } from './lights';

export interface WaterFrameTunables {
  /** A flare's glint's disc, and a fire's, metres across the middle; their light's gain. */
  flareM: number;
  fireM: number;
  gain: number;
  /** How far a reflected ray is traced, metres; the sky beyond. */
  reflectM: number;
}

export function waterFrameTunables(tun: Tunables): WaterFrameTunables {
  return { flareM: tun.f('render.glint_m'), fireM: tun.f('render.glint_fire_m'), gain: tun.f('render.glint_gain'), reflectM: tun.f('render.reflect_m') };
}

/** The battle's water now: its rings, and the wind (metres a second) with the slope it gives the surface. */
export interface FrameWater {
  rings: readonly RingState[];
  wind: readonly [number, number];
  slope: number;
}

export const STILL_WATER: FrameWater = { rings: [], wind: [0, 0], slope: 0 };

/** A glint: where its light is (metres), its disc's radius (metres), its light (linear rgb). */
export interface Glint {
  position: readonly [number, number, number];
  radiusM: number;
  radiance: [number, number, number];
}

/** The frame's flares (dimmed by the sky's flares key, as their light is) and fires as glints, the brightest MAX_GLINTS. */
export function glintsFrom(lights: readonly SceneLight[], flaresKey: number, gt: WaterFrameTunables): Glint[] {
  const out: Glint[] = [];
  for (const l of lights) {
    if (l.kind === 'lantern') continue;
    const k = (l.kind === 'flare' ? l.intensity * flaresKey : l.intensity) * gt.gain;
    if (!(k > 0)) continue;
    out.push({ position: l.position, radiusM: l.kind === 'flare' ? gt.flareM : gt.fireM, radiance: [l.colour[0] * k, l.colour[1] * k, l.colour[2] * k] });
  }
  const luma = (g: Glint) => 0.2126 * g.radiance[0] + 0.7152 * g.radiance[1] + 0.0722 * g.radiance[2];
  return out.sort((a, b) => luma(b) - luma(a)).slice(0, MAX_GLINTS);
}

/** The frame's water fields (frame-uniforms.ts): the newest MAX_RINGS rings, the roughness, the reach, the glints; voxels. */
export function writeWater(w: StructWriter, water: FrameWater, glints: readonly Glint[], voxel: number, gt: WaterFrameTunables, wt: WaterTunables): void {
  const rings = water.rings.slice(-MAX_RINGS);
  w.set('ringCount', rings.length);
  rings.forEach((r, k) => {
    w.set(`rings.${2 * k}`, [r.at[0] / voxel, r.at[1] / voxel, r.at[2] / voxel, r.radiusM / voxel]);
    w.set(`rings.${2 * k + 1}`, [r.heightM / voxel, (wt.ringWidthM + 0.1 * r.age) / voxel, wt.ringWavelengthM / voxel, 0]);
  });
  const speed = Math.hypot(water.wind[0], water.wind[1]);
  w.set('waterWind', speed > 0 ? [water.wind[0] / speed, water.wind[1] / speed] : [1, 0]);
  w.set('waterSlope', water.slope);
  w.set('reflectReach', gt.reflectM / voxel);
  const shown = glints.slice(0, MAX_GLINTS);
  w.set('glintCount', shown.length);
  shown.forEach((g, k) => {
    w.set(`glints.${2 * k}`, [g.position[0] / voxel, g.position[1] / voxel, g.position[2] / voxel, g.radiusM / voxel]);
    w.set(`glints.${2 * k + 1}`, [...g.radiance, 0]);
  });
}
