/**
 * The time of day: one number from dusk (0) through twilight (0.5) to night
 * (1), and everything it lights the world with, from [time_of_day]. Each
 * value is linear between its three keys. The key light — the one that casts
 * shadows — is whichever of the sun and moon is brighter; they trade places
 * near twilight, where both are dim.
 */

import type { Tunables } from '../core/tunables';
import type { FrameSky } from './frame-uniforms';

export type Vec3 = [number, number, number];

export interface SkyState {
  sunDir: Vec3;
  sunColour: Vec3;
  moonDir: Vec3;
  moonColour: Vec3;
  keyDir: Vec3;
  keyColour: Vec3;
  zenith: Vec3;
  horizon: Vec3;
  ambient: number;
  /** Per metre, at the ground. */
  fogDensity: number;
  exposure: number;
  /** How brightly the static flares burn, 0 to 1. */
  flares: number;
}

const KEYS = [0, 0.5, 1];

function list<T>(tun: Tunables, key: string): T[] {
  const value = tun.get(`time_of_day.${key}`);
  if (!Array.isArray(value) || value.length !== KEYS.length) throw new TypeError(`time_of_day.${key} needs ${KEYS.length} keys`);
  return value as T[];
}

function direction(azimuth: number, elevation: number): Vec3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function skyState(tun: Tunables, t: number): SkyState {
  const at = Math.min(1, Math.max(0, t));
  const segment = at >= KEYS[1] ? 1 : 0;
  const f = (at - KEYS[segment]) / (KEYS[segment + 1] - KEYS[segment]);
  const scalar = (key: string) => {
    const v = list<number>(tun, key);
    return v[segment] + (v[segment + 1] - v[segment]) * f;
  };
  const colour = (key: string): Vec3 => {
    const v = list<number[]>(tun, key);
    return [0, 1, 2].map((c) => v[segment][c] + (v[segment + 1][c] - v[segment][c]) * f) as Vec3;
  };
  const sunDir = direction(scalar('sun_azimuth_deg'), scalar('sun_elevation_deg'));
  const moonDir = direction(scalar('moon_azimuth_deg'), scalar('moon_elevation_deg'));
  const sunColour = colour('sun_colour');
  const moonColour = colour('moon_colour');
  const sunKey = luminance(sunColour) >= luminance(moonColour);
  return {
    sunDir,
    sunColour,
    moonDir,
    moonColour,
    keyDir: sunKey ? sunDir : moonDir,
    keyColour: sunKey ? sunColour : moonColour,
    zenith: colour('sky_zenith'),
    horizon: colour('sky_horizon'),
    ambient: scalar('ambient'),
    fogDensity: scalar('fog_density'),
    exposure: scalar('exposure'),
    flares: scalar('flares'),
  };
}

/** What the frame uniform takes from the sky: render settings joined to it, distances in their shader units. */
export function frameSky(sky: SkyState, tun: Tunables): FrameSky {
  const voxel = tun.f('world.voxel_size');
  return {
    keyDir: sky.keyDir,
    keyCone: (tun.f('render.key_cone_deg') * Math.PI) / 180,
    keyColour: sky.keyColour,
    exposure: sky.exposure,
    sunDir: sky.sunDir,
    ambient: sky.ambient,
    moonDir: sky.moonDir,
    moonColour: sky.moonColour,
    zenith: sky.zenith,
    horizon: sky.horizon,
    fogDensity: sky.fogDensity,
    fogHeight: tun.f('render.fog_height_m'),
    fogBase: tun.f('world.ground_level_m'),
    skyRay: tun.f('render.sky_ray_m') / voxel,
  };
}
