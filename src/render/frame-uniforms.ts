/**
 * The uniform block every pass reads, declared once: the WGSL `Frame` struct
 * is generated from these lists (see `moduleSource`) and each frame's values
 * are written through them, so a shader and the code filling its buffer can
 * never disagree about an offset. Positions and distances in it are voxels.
 */

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

export const FRAME: StructDef = {
  name: 'Frame',
  fields: [
    ['world', WORLD_INFO],
    ['flags', 'u32'],
  ],
};

export function writeWorldInfo(w: StructWriter, world: { map: { dims: { x: number; y: number; z: number } }; pyramidLevels: readonly PyramidLevel[] }): void {
  const { dims } = world.map;
  const levels = world.pyramidLevels;
  if (levels.length > PYRAMID_LEVELS_MAX) throw new RangeError(`a ${levels.length}-level pyramid is over the ${PYRAMID_LEVELS_MAX} the frame holds`);
  w.set('world.dims', [dims.x, dims.y, dims.z]);
  w.set('world.levels', levels.length);
  levels.forEach((l, k) => w.set(`world.pyramid.${k}`, [l.w, l.h, l.offset, 0]));
}
