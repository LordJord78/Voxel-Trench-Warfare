/**
 * The uniform block every pass reads, declared once: the WGSL `Frame` struct
 * is generated from these lists (see `moduleSource`) and each frame's values
 * are written through them, so a shader and the code filling its buffer can
 * never disagree about an offset. Positions and distances in it are voxels.
 */

import { cameraBasis, tanHalf, type CameraPose } from './camera';
import type { Tunables } from '../core/tunables';
import type { StructDef, StructWriter } from './layout';
import type { PyramidLevel } from './pyramid';

/** Bits of `Frame.flags`. */
export const FLAGS = { JITTER_OFF: 1, PYRAMID_OFF: 2, HISTORY_RESET: 4, DEBUG_SHADE: 8, BEAM_OFF: 16, SPATIAL_OFF: 32, RESERVOIR_HISTORY_OFF: 64, FROXELS_OFF: 128, BLOCKS_OFF: 256 } as const;

export const PYRAMID_LEVELS_MAX = 12;

export const WORLD_INFO: StructDef = {
  name: 'WorldInfo',
  fields: [
    ['dims', 'vec3u'],
    ['levels', 'u32'],
    // Per max-height pyramid level: width, height, offset into the pyramid buffer, 0.
    ['pyramid', { element: 'vec4u', count: PYRAMID_LEVELS_MAX }],
  ],
};

/** A camera in voxels: its basis, the horizontal half-angle's tangent (1 at 90°), and this frame's sub-pixel jitter. */
export const CAMERA: StructDef = {
  name: 'Camera',
  fields: [
    ['origin', 'vec3f'],
    ['tanHalf', 'f32'],
    ['forward', 'vec3f'],
    ['pad0', 'f32'],
    ['right', 'vec3f'],
    ['pad1', 'f32'],
    ['up', 'vec3f'],
    ['pad2', 'f32'],
    ['jitter', 'vec2f'],
    ['pad3', 'vec2f'],
  ],
};

/**
 * The atmosphere (see atmosphere.ts) in kilometres: Rayleigh scattering and its scale height, ozone's
 * absorption round its peak, Mie scattering and extinction, the radii of the ground and the top,
 * and what the sky views are built for: the sun and moon (y up) and the camera's height.
 */
export const ATMOSPHERE: StructDef = {
  name: 'Atmosphere',
  fields: [
    ['rayleigh', 'vec3f'],
    ['rayleighHeight', 'f32'],
    ['ozone', 'vec3f'],
    ['ozoneCentre', 'f32'],
    ['mieScattering', 'f32'],
    ['mieExtinction', 'f32'],
    ['mieHeight', 'f32'],
    ['mieG', 'f32'],
    ['ozoneHalfWidth', 'f32'],
    ['albedo', 'f32'],
    ['bottom', 'f32'],
    ['top', 'f32'],
    ['sunDir', 'vec3f'],
    ['viewHeight', 'f32'],
    ['moonDir', 'vec3f'],
    ['pad0', 'f32'],
  ],
};

/** A shot's flash, a point light for a frame or two (flash.wgsl): position and radius in voxels, linear colour, intensity. */
export const FLASH: StructDef = {
  name: 'Flash',
  fields: [
    ['pos', 'vec3f'],
    ['radius', 'f32'],
    ['colour', 'vec3f'],
    ['intensity', 'f32'],
  ],
};

/** The most shots' flashes a frame lights by. */
export const MAX_FLASHES = 4;
/** The most shells' blasts a frame lights by. */
export const MAX_BLASTS = 4;

/** A puff of a shell's or a fire's smoke in the haze (smoke.wgsl): centre and radius in voxels, density per metre at its middle. */
export const PUFF: StructDef = {
  name: 'Puff',
  fields: [
    ['centre', 'vec3f'],
    ['radius', 'f32'],
    ['density', 'f32'],
    ['pad0', 'f32'],
    ['pad1', 'f32'],
    ['pad2', 'f32'],
  ],
};

/** The most puffs of smoke a frame's haze holds (the high preset's; quality.ts's HAZE_PUFFS). */
export const MAX_PUFFS = 64;

/** The most distant shells' flashes a frame's sky takes (sky.wgsl's horizonGlow loops to it). */
export const MAX_HORIZON = 16;

export const FRAME: StructDef = {
  name: 'Frame',
  fields: [
    ['world', WORLD_INFO],
    // This frame's camera, and the last frame's with the jitter that frame applied (zero if none).
    ['cam', CAMERA],
    ['prev', CAMERA],
    // The internal image this frame renders, the size its textures were allocated at, and
    // the image the last frame rendered (dynamic resolution changes it between frames).
    ['res', 'vec2u'],
    ['alloc', 'vec2u'],
    ['prevRes', 'vec2u'],
    ['lightRes', 'vec2u'],
    ['lightScale', 'u32'],
    ['frame', 'u32'],
    ['flags', 'u32'],
    ['lightCount', 'u32'],
    ['voxel', 'f32'],
    ['timeOfDay', 'f32'],
    // Rays each lighting pixel traces: always 3, read from here so shaders cannot unroll their loop over them.
    ['lightRays', 'u32'],
    // The denoiser: frames of history at most, and how sharply its filter stops at brightness and plane edges.
    ['historyMax', 'f32'],
    ['sigmaLuma', 'f32'],
    ['sigmaPlane', 'f32'],
    // Contrast-adaptive sharpening after TAA, 0 to 1 (render.cas_sharpness).
    ['casSharpness', 'f32'],
    // The key light (sun or moon, crossfaded), in linear RGB with its intensity.
    ['keyDir', 'vec3f'],
    ['keyCone', 'f32'],
    ['keyColour', 'vec3f'],
    // The hour's exposure bias: the frame is exposed by it over the light it shows (see exposure.wgsl).
    ['exposure', 'f32'],
    ['sunDir', 'vec3f'],
    ['fogDensity', 'f32'],
    ['moonDir', 'vec3f'],
    ['fogHeight', 'f32'],
    // The moon's light where it reaches the ground, for its disc.
    ['moonColour', 'vec3f'],
    ['fogBase', 'f32'],
    // The sun's light and the moon's above the air (the moon's in its phase): the sky views and the
    // faces' irradiance are per unit of them. And a magnitude-0 star's light.
    ['sunLight', 'vec3f'],
    ['skyRay', 'f32'],
    ['moonLight', 'vec3f'],
    ['starBrightness', 'f32'],
    // The moon's light at full, which its disc's face is drawn in, lit by the sun from where it stands.
    ['moonFull', 'vec3f'],
    // The light exposure 1 shows as approved (dusk's), and the least light the exposure counts.
    ['exposureLight', 'f32'],
    // The celestial sphere's axes in the world, turned by the sidereal clock (see sky-clock.ts).
    ['starX', 'vec3f'],
    ['exposureFloor', 'f32'],
    // The haze the fog and smoke are (see sky.wgsl's fogColour): the share of the key light it glows
    // with looking any way, and more toward the key by cos⁴ of the angle; the front's glow on it, and
    // the share of the sky's light from above.
    ['starY', 'vec3f'],
    ['hazeKey', 'f32'],
    ['starZ', 'vec3f'],
    ['hazeForward', 'f32'],
    ['frontGlow', 'vec3f'],
    ['hazeSky', 'f32'],
    // In the froxels: the share of the key's glow the haze keeps where the key light does not reach
    // it (what the lit haze round it scatters in), and how bright point lights glow in it.
    ['hazeShadow', 'f32'],
    ['hazeLights', 'f32'],
    // Smoke and dust over the lines, a second height fog: per metre at the ground, and the metres it thins by e over.
    ['smokeDensity', 'f32'],
    ['smokeHeight', 'f32'],
    // The sky's glow a few degrees round the key light, over the key's light (see sky.wgsl).
    ['aureole', 'f32'],
    // Shots' flashes lighting the trench this frame, outside the light buffer and the denoiser.
    ['flashCount', 'u32'],
    ['flashes', { element: FLASH, count: MAX_FLASHES }],
    // Shells' blasts lighting the world this frame: shadowed at the lighting resolution (lighting.wgsl), outside the denoiser.
    ['blastCount', 'u32'],
    ['blasts', { element: FLASH, count: MAX_BLASTS }],
    // Shells' and fires' smoke in the froxels' haze: its puffs this frame, nearest the eye first.
    ['puffCount', 'u32'],
    ['puffs', { element: PUFF, count: MAX_PUFFS }],
    // Distant shells' flashes (sky.wgsl's horizonGlow and horizonLight): the colour they glow, the
    // haze's share of their glow, the far field's light from one within horizonNear metres, from
    // horizonLift metres over where it fell (its fireball, and the dust it lights); each, where it
    // fell (voxels) and its power now, the first horizonGlowCount glowing (a barrage's), all lighting
    // the far field; and the glowing ones' glow worked out for the eye this frame (horizonGlowRecord).
    ['horizonColour', 'vec3f'],
    ['horizonHaze', 'f32'],
    ['horizonFar', 'f32'],
    ['horizonNear', 'f32'],
    ['horizonLift', 'f32'],
    ['horizonCount', 'u32'],
    ['horizonGlowCount', 'u32'],
    ['horizon', { element: 'vec4f', count: MAX_HORIZON }],
    ['glows', { element: 'vec4f', count: 2 * MAX_HORIZON }],
    // Far field: origin x and z, cell size and cell count, in voxels.
    ['far', 'vec4f'],
    // The atmosphere as this frame's sky view was built.
    ['atmosphere', ATMOSPHERE],
  ],
};

/** The sky and key light a frame is lit by (see sky-state.ts). */
export interface FrameSky {
  keyDir: readonly number[];
  keyCone: number;
  keyColour: readonly number[];
  exposure: number;
  sunDir: readonly number[];
  moonDir: readonly number[];
  moonColour: readonly number[];
  sunLight: readonly number[];
  moonLight: readonly number[];
  moonFull: readonly number[];
  /** The celestial sphere's axes in the world. */
  stars: readonly (readonly number[])[];
  starBrightness: number;
  exposureLight: number;
  exposureFloor: number;
  fogDensity: number;
  fogHeight: number;
  fogBase: number;
  hazeKey: number;
  hazeForward: number;
  hazeSky: number;
  hazeShadow: number;
  hazeLights: number;
  frontGlow: readonly number[];
  /** The radiance of the haze lit over a barrage's flash at full power, keyed to the clock: it reads against dusk's bright haze as against night's (writeHorizon). */
  flashGlow: number;
  smokeDensity: number;
  smokeHeight: number;
  aureole: number;
  skyRay: number;
  /** Film grain's deviation in 8-bit steps, for the present pass (not the frame uniform). */
  grain: number;
}

export function writeWorldInfo(w: StructWriter, world: { map: { dims: { x: number; y: number; z: number } }; pyramidLevels: readonly PyramidLevel[] }): void {
  const { dims } = world.map;
  const levels = world.pyramidLevels;
  if (levels.length > PYRAMID_LEVELS_MAX) throw new RangeError(`a ${levels.length}-level pyramid is over the ${PYRAMID_LEVELS_MAX} the frame holds`);
  w.set('world.dims', [dims.x, dims.y, dims.z]);
  w.set('world.levels', levels.length);
  levels.forEach((l, k) => w.set(`world.pyramid.${k}`, [l.w, l.h, l.offset, 0]));
}

/** A pose as the shaders take it: voxels, its basis, and a jitter in pixels. */
export function writeCamera(w: StructWriter, path: 'cam' | 'prev', pose: CameraPose, voxel: number, jitter: readonly [number, number]): void {
  const { forward, right, up } = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
  w.set(`${path}.origin`, pose.position.map((m) => m / voxel));
  w.set(`${path}.tanHalf`, tanHalf(pose));
  w.set(`${path}.forward`, forward);
  w.set(`${path}.right`, right);
  w.set(`${path}.up`, up);
  w.set(`${path}.jitter`, jitter);
}

/** How distant shells' flashes light the sky, the haze and the far field (the battle spec's §3; [battle.flashes]). */
export interface HorizonTerms {
  colour: [number, number, number];
  /** The haze's share of a flash's glow (the sky's is whole); its strength is the sky's, keyed to the clock (FrameSky.flashGlow). */
  haze: number;
  /** The far field's light from a flash at full power, within nearM, from liftM above where it fell. */
  far: number;
  nearM: number;
  liftM: number;
  /** The patch of haze a flash lights: across, and high (metres). */
  spreadM: [number, number];
  /** The least height its glow takes, in degrees. */
  minDeg: number;
  /** Metres the air dims a glow by e over. */
  reachM: number;
}

export function horizonTerms(tun: Tunables): HorizonTerms {
  const f = (k: string) => tun.f(`battle.flashes.${k}`);
  // Across and high: two numbers, not a range.
  const spread = tun.get('battle.flashes.spread_m');
  if (!Array.isArray(spread) || spread.length !== 2 || !spread.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`tunable 'battle.flashes.spread_m' is not two finite numbers: ${JSON.stringify(spread)}`);
  }
  return {
    colour: tun.triple('battle.flashes.colour'),
    haze: f('haze'),
    far: f('far'),
    nearM: f('near_m'),
    liftM: f('lift_m'),
    spreadM: [spread[0], spread[1]],
    minDeg: f('min_deg'),
    reachM: f('reach_m'),
  };
}

/**
 * A distant shell's flash as the frame takes it: where it fell (metres), its power now, and whether it
 * glows in the sky and the haze (a barrage's shell, lighting its smoke) or only lights the far field
 * near it (a single far shell, whose flash is its disc).
 */
export interface HorizonFlash {
  position: readonly [number, number, number];
  power: number;
  glow: boolean;
}

/**
 * A glowing flash's glow as seen from `eyeM` (metres) this frame, for sky.wgsl's horizonGlow: the lit
 * patch of haze over it, spreadM across and high. Its bearing from the eye (x and z of a unit
 * vector), its own elevation from it (radians), its weight (`strength` × its power, dimmed by e every
 * reachM of air); then 1 / its half-width² in azimuth, and 1 / its half-height² above its elevation
 * (the patch's height, at least minDeg) and under it (a tenth of that, so it stands on the horizon
 * and does not spill over the nearer ground).
 */
export function horizonGlowRecord(f: HorizonFlash, eyeM: readonly number[], terms: HorizonTerms, strength: number): number[] {
  const dx = f.position[0] - eyeM[0];
  const dz = f.position[2] - eyeM[2];
  const d = Math.max(Math.hypot(dx, dz), 1);
  const w = Math.atan((0.5 * terms.spreadM[0]) / d);
  const h = Math.max(Math.atan(terms.spreadM[1] / d), (terms.minDeg * Math.PI) / 180);
  return [dx / d, dz / d, Math.atan2(f.position[1] - eyeM[1], d), strength * f.power * Math.exp(-d / terms.reachM), 1 / (w * w), 1 / (h * h), 100 / (h * h), 0];
}

/** The terms, and the first MAX_HORIZON of `flashes`, those that glow first, their glow worked out for the eye (metres) at `strength`. */
export function writeHorizon(w: StructWriter, terms: HorizonTerms, flashes: readonly HorizonFlash[], voxel: number, eyeM: readonly number[], strength: number): void {
  w.set('horizonColour', terms.colour);
  w.set('horizonHaze', terms.haze);
  w.set('horizonFar', terms.far);
  w.set('horizonNear', terms.nearM);
  w.set('horizonLift', terms.liftM);
  const shown = [...flashes.filter((f) => f.glow), ...flashes.filter((f) => !f.glow)].slice(0, MAX_HORIZON);
  w.set('horizonCount', shown.length);
  const glowing = shown.filter((f) => f.glow);
  w.set('horizonGlowCount', glowing.length);
  shown.forEach((f, k) => w.set(`horizon.${k}`, [f.position[0] / voxel, f.position[1] / voxel, f.position[2] / voxel, f.power]));
  glowing.forEach((f, k) => {
    const r = horizonGlowRecord(f, eyeM, terms, strength);
    w.set(`glows.${2 * k}`, r.slice(0, 4));
    w.set(`glows.${2 * k + 1}`, r.slice(4, 8));
  });
}

export function writeSky(w: StructWriter, sky: FrameSky): void {
  w.set('keyDir', sky.keyDir);
  w.set('keyCone', sky.keyCone);
  w.set('keyColour', sky.keyColour);
  w.set('exposure', sky.exposure);
  w.set('sunDir', sky.sunDir);
  w.set('moonDir', sky.moonDir);
  w.set('moonColour', sky.moonColour);
  w.set('sunLight', sky.sunLight);
  w.set('moonLight', sky.moonLight);
  w.set('moonFull', sky.moonFull);
  w.set('starX', sky.stars[0]);
  w.set('starY', sky.stars[1]);
  w.set('starZ', sky.stars[2]);
  w.set('starBrightness', sky.starBrightness);
  w.set('exposureLight', sky.exposureLight);
  w.set('exposureFloor', sky.exposureFloor);
  w.set('fogDensity', sky.fogDensity);
  w.set('fogHeight', sky.fogHeight);
  w.set('fogBase', sky.fogBase);
  w.set('hazeKey', sky.hazeKey);
  w.set('hazeForward', sky.hazeForward);
  w.set('hazeSky', sky.hazeSky);
  w.set('hazeShadow', sky.hazeShadow);
  w.set('hazeLights', sky.hazeLights);
  w.set('frontGlow', sky.frontGlow);
  w.set('smokeDensity', sky.smokeDensity);
  w.set('smokeHeight', sky.smokeHeight);
  w.set('aureole', sky.aureole);
  w.set('skyRay', sky.skyRay);
}

const dir = (azimuth: number, elevation: number) => {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};

/**
 * Dusk by the clock (17:35, the sun 4.5° up), as sky-state.ts lights it from the tunables, in voxel
 * units: what frames are lit by until the app sets the sky.
 */
export const PROBE_DUSK: FrameSky = {
  keyDir: dir(18, 4.5),
  keyCone: (0.6 * Math.PI) / 180,
  keyColour: [3.4, 1.47, 0.34],
  exposure: 1.0,
  sunDir: dir(18, 4.5),
  moonDir: dir(204, 2.2),
  moonColour: [0.0197, 0.0088, 0.00162],
  sunLight: [6.55, 6.55, 6.55],
  moonLight: [0.056, 0.09, 0.195],
  moonFull: [0.0565, 0.0912, 0.197],
  stars: [
    [1, 0, 0],
    [0, 0.766, 0.643],
    [0, -0.643, 0.766],
  ],
  starBrightness: 1.23e-5,
  exposureLight: 0.545,
  exposureFloor: 0.002,
  fogDensity: 0.012,
  fogHeight: 14,
  fogBase: 16,
  hazeKey: 0.215,
  hazeForward: 0.08,
  hazeSky: 1.66,
  hazeShadow: 0.7,
  hazeLights: 0.1,
  frontGlow: [0, 0, 0],
  flashGlow: 1.4,
  smokeDensity: 0.00053,
  smokeHeight: 300,
  aureole: 12,
  skyRay: 40,
  grain: 0.6,
};
