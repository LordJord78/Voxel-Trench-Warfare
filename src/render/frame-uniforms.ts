/**
 * The uniform block every pass reads, declared once: the WGSL `Frame` struct
 * is generated from these lists (see `moduleSource`) and each frame's values
 * are written through them, so a shader and the code filling its buffer can
 * never disagree about an offset. Positions and distances in it are voxels.
 */

import { cameraBasis, type CameraPose } from './camera';
import type { StructDef, StructWriter } from './layout';
import type { PyramidLevel } from './pyramid';

/** Bits of `Frame.flags`. */
export const FLAGS = { JITTER_OFF: 1, PYRAMID_OFF: 2, HISTORY_RESET: 4, DEBUG_SHADE: 8 } as const;

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

export const FRAME: StructDef = {
  name: 'Frame',
  fields: [
    ['world', WORLD_INFO],
    ['cam', CAMERA],
    ['prev', CAMERA],
    // The internal image this frame renders, and the size its textures were allocated at.
    ['res', 'vec2u'],
    ['alloc', 'vec2u'],
    ['lightRes', 'vec2u'],
    ['lightScale', 'u32'],
    ['frame', 'u32'],
    ['flags', 'u32'],
    ['lightCount', 'u32'],
    ['voxel', 'f32'],
    ['timeOfDay', 'f32'],
    // Rays each lighting pixel traces: always 3, read from here so shaders cannot unroll their loop over them.
    ['lightRays', 'u32'],
    // The key light (sun or moon) and the sky, in linear RGB with intensity.
    ['keyDir', 'vec3f'],
    ['keyCone', 'f32'],
    ['keyColour', 'vec3f'],
    ['exposure', 'f32'],
    ['sunDir', 'vec3f'],
    ['ambient', 'f32'],
    ['moonDir', 'vec3f'],
    ['fogDensity', 'f32'],
    ['moonColour', 'vec3f'],
    ['fogHeight', 'f32'],
    ['zenith', 'vec3f'],
    ['fogBase', 'f32'],
    ['horizon', 'vec3f'],
    ['skyRay', 'f32'],
    // Far field: origin x and z, cell size and cell count, in voxels.
    ['far', 'vec4f'],
  ],
};

/** The sky and key light a frame is lit by; Task 6 derives it from the time of day. */
export interface FrameSky {
  keyDir: readonly number[];
  keyCone: number;
  keyColour: readonly number[];
  exposure: number;
  sunDir: readonly number[];
  ambient: number;
  moonDir: readonly number[];
  moonColour: readonly number[];
  zenith: readonly number[];
  horizon: readonly number[];
  fogDensity: number;
  fogHeight: number;
  fogBase: number;
  skyRay: number;
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
  const { forward, right, up } = cameraBasis(pose.yaw, pose.pitch);
  w.set(`${path}.origin`, pose.position.map((m) => m / voxel));
  w.set(`${path}.tanHalf`, 1);
  w.set(`${path}.forward`, forward);
  w.set(`${path}.right`, right);
  w.set(`${path}.up`, up);
  w.set(`${path}.jitter`, jitter);
}

export function writeSky(w: StructWriter, sky: FrameSky): void {
  w.set('keyDir', sky.keyDir);
  w.set('keyCone', sky.keyCone);
  w.set('keyColour', sky.keyColour);
  w.set('exposure', sky.exposure);
  w.set('sunDir', sky.sunDir);
  w.set('ambient', sky.ambient);
  w.set('moonDir', sky.moonDir);
  w.set('moonColour', sky.moonColour);
  w.set('zenith', sky.zenith);
  w.set('horizon', sky.horizon);
  w.set('fogDensity', sky.fogDensity);
  w.set('fogHeight', sky.fogHeight);
  w.set('fogBase', sky.fogBase);
  w.set('skyRay', sky.skyRay);
}

const dir = (azimuth: number, elevation: number) => {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
};

/** The probe's approved dusk, in voxel units: what frames are lit by until the time of day is wired in. */
export const PROBE_DUSK: FrameSky = {
  keyDir: dir(18, 4.5),
  keyCone: (0.6 * Math.PI) / 180,
  keyColour: [3.4, 1.45, 0.6],
  exposure: 1.0,
  sunDir: dir(18, 4.5),
  ambient: 0.55,
  moonDir: dir(215, 32),
  moonColour: [0, 0, 0],
  zenith: [0.1, 0.13, 0.27],
  horizon: [0.95, 0.46, 0.24],
  fogDensity: 0.012,
  fogHeight: 14,
  fogBase: 16,
  skyRay: 40,
};
