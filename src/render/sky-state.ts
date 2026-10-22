/**
 * The sky at an hour of the clock (see sky-clock.ts): the sun and moon where
 * the ephemeris puts them, their light through the atmosphere, the key light,
 * and the fog, flares and exposure keyed to the clock.
 *
 * Units. The sun's light above the air is `sky.sun_illuminance`, set so that
 * dusk's key light is the approved one; the atmosphere's sky views are per
 * unit of it. The moon's is not the physical 1/400,000 of the sun's but
 * `sky.moon_illuminance` at full moon, which is the approved night's key: so
 * an exposure keyed to the hour shows the moonlit ground beside the lanterns
 * and flares as approved. It waxes with its phase as a grey Lambertian sphere
 * lit by the sun, and is tinted as moonlight reads to the eye at night,
 * blue-violet (`sky.moon_tint`).
 *
 * The key light, the one that casts shadows, is whichever of the two is
 * brighter where its light reaches the ground, crossfaded over the 2° of the
 * sun's elevation round where the sun's falls to the moon's: its colour mixes
 * the two, and its direction turns from one to the other, so neither moves
 * with a jump.
 */

import { CLOCK_KEYS, celestial } from '../core/sky-clock';
import type { Tunables } from '../core/tunables';
import { atmosphereModel, transmittanceAt, type AtmosphereModel } from './atmosphere';
import type { FrameSky } from './frame-uniforms';

export type Vec3 = [number, number, number];

export interface SkyState {
  hours: number;
  sunDir: Vec3;
  moonDir: Vec3;
  sunElevationDeg: number;
  /** Each light above the air: the sun's, and the moon's in its phase (zero while it is far below the horizon). */
  sunLight: Vec3;
  moonLight: Vec3;
  /** The moon's light at full, which its disc's face is drawn in. */
  moonFull: Vec3;
  /** The celestial sphere's axes in the world. */
  stars: [Vec3, Vec3, Vec3];
  /** A magnitude-0 star's light: 8.4e-6 of the full moon's, as in the sky, times sky.star_gain. */
  starBrightness: number;
  /** Each light where it reaches the ground: through the air, and as much of its disc as is above the horizon. */
  sunColour: Vec3;
  moonColour: Vec3;
  keyDir: Vec3;
  keyColour: Vec3;
  /** The sun's share of the key light, 0 to 1. */
  keyWeight: number;
  /** Per metre, at the ground. */
  fogDensity: number;
  exposure: number;
  /** How brightly the static flares burn, 0 to 1. */
  flares: number;
}

/** The camera's height for the key light's path through the air, in km: a man's eye over the ground. */
const EYE_KM = 0.0016;
/** The sun's and moon's discs, in degrees of radius. */
const DISC_DEG = 0.265;
/** The moon's sky is built while it is above this: lower, its light on the air is too faint to see. */
const MOON_SKY_DEG = -10;
/** The key's crossfade, in degrees of the sun's elevation either side of the crossing. */
const CROSSFADE_DEG = 1;
/** A magnitude-0 star's light against the full moon's: 2.1e-6 lux against 0.25. */
const MAG0_PER_FULL_MOON = 8.4e-6;

const RAD = Math.PI / 180;
const KEYS = [CLOCK_KEYS.dawn, CLOCK_KEYS.noon, CLOCK_KEYS.dusk, CLOCK_KEYS.night];
const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const scale = (c: readonly number[], k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
const times = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

function triple(tun: Tunables, key: string): Vec3 {
  const v = tun.get(key);
  if (!Array.isArray(v) || v.length !== 3) throw new TypeError(`tunable '${key}' is not three numbers`);
  return [v[0], v[1], v[2]];
}

/** A value keyed to the clock's four hours (dawn, noon, dusk, night), linear between them by the hour, round the clock. */
function keyed(tun: Tunables, key: string, hours: number): number {
  const values = tun.get(`sky.${key}`);
  if (!Array.isArray(values) || values.length !== KEYS.length) throw new TypeError(`sky.${key} needs ${KEYS.length} keys`);
  const h = ((hours % 24) + 24) % 24;
  for (let k = 0; k < KEYS.length; k++) {
    const from = KEYS[k];
    const to = k + 1 < KEYS.length ? KEYS[k + 1] : KEYS[0] + 24;
    const at = h < from ? h + 24 : h;
    if (at >= from && at <= to) return values[k] + ((values[(k + 1) % KEYS.length] - values[k]) * (at - from)) / (to - from);
  }
  return values[0];
}

/** How much of a disc of radius `radiusDeg` whose centre stands `elevationDeg` up is above the horizon. */
function discAbove(elevationDeg: number, radiusDeg = DISC_DEG): number {
  const d = Math.max(-1, Math.min(1, elevationDeg / radiusDeg));
  return (Math.PI - Math.acos(d) + d * Math.sqrt(1 - d * d)) / Math.PI;
}

/** A light above the air, where it reaches the ground from `elevationDeg` up. */
function throughAir(m: AtmosphereModel, light: readonly number[], elevationDeg: number): Vec3 {
  const t = transmittanceAt(m, EYE_KM, Math.max(0, Math.sin(elevationDeg * RAD)));
  return scale(times(light, t), discAbove(elevationDeg));
}

/** A Lambertian sphere's brightness at phase angle alpha (radians), against full. */
function lambertPhase(alpha: number): number {
  return (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
}

function slerp(a: readonly number[], b: readonly number[], t: number): Vec3 {
  const cos = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const theta = Math.acos(cos);
  if (theta < 1e-6) return [a[0], a[1], a[2]];
  // Opposite lights (within a hair): turn over the top of the sky.
  const s = Math.sin(theta);
  if (s < 1e-6) {
    const up = t < 0.5 ? scale(a, Math.cos(Math.PI * t)) : scale(b, -Math.cos(Math.PI * t));
    const lift = Math.sin(Math.PI * t);
    const v: Vec3 = [up[0], up[1] + lift, up[2]];
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

/** The sun's elevation, in degrees, at which its light at the ground falls to `target` luminance. */
function crossing(m: AtmosphereModel, sunLight: Vec3, target: number): number {
  let lo = -DISC_DEG;
  let hi = 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(throughAir(m, sunLight, mid)) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function skyState(tun: Tunables, hours: number): SkyState {
  const m = atmosphereModel(tun);
  const c = celestial(tun, hours);
  const sunLight = scale([1, 1, 1], tun.f('sky.sun_illuminance'));
  const alpha = c.moon.phaseAngleDeg * RAD;
  const moonUp = c.moon.elevationDeg > MOON_SKY_DEG;
  const moonFull = scale(triple(tun, 'sky.moon_tint'), tun.f('sky.moon_illuminance'));
  const moonLight = moonUp ? scale(moonFull, lambertPhase(alpha)) : ([0, 0, 0] as Vec3);
  const sunColour = throughAir(m, sunLight, c.sun.elevationDeg);
  const moonColour = throughAir(m, moonLight, c.moon.elevationDeg);
  const cross = crossing(m, sunLight, luminance(moonColour));
  const w = smoothstep(cross - CROSSFADE_DEG, cross + CROSSFADE_DEG, c.sun.elevationDeg);
  const keyColour: Vec3 = [0, 1, 2].map((k) => sunColour[k] * w + moonColour[k] * (1 - w)) as Vec3;
  const keyDir = w >= 1 ? c.sun.dir : w <= 0 ? c.moon.dir : slerp(c.moon.dir, c.sun.dir, w);
  return {
    hours,
    sunDir: c.sun.dir,
    moonDir: c.moon.dir,
    sunElevationDeg: c.sun.elevationDeg,
    sunLight,
    moonLight,
    moonFull,
    stars: c.stars,
    starBrightness: tun.f('sky.moon_illuminance') * MAG0_PER_FULL_MOON * tun.f('sky.star_gain'),
    sunColour,
    moonColour,
    keyDir,
    keyColour,
    keyWeight: w,
    fogDensity: keyed(tun, 'fog_density', hours),
    exposure: keyed(tun, 'exposure', hours),
    flares: keyed(tun, 'flares', hours),
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
    moonDir: sky.moonDir,
    moonColour: sky.moonColour,
    sunLight: sky.sunLight,
    moonLight: sky.moonLight,
    moonFull: sky.moonFull,
    stars: sky.stars,
    starBrightness: sky.starBrightness,
    fogDensity: sky.fogDensity,
    fogHeight: tun.f('render.fog_height_m'),
    fogBase: tun.f('world.ground_level_m'),
    skyRay: tun.f('render.sky_ray_m') / voxel,
  };
}
