/** Test worlds for shelling: a trench with a parapet at its angle of repose, and a voxel-for-voxel comparison. */
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import type { DetonateOptions } from '../../src/world/destruction';
import { P } from '../../src/world/materials';

const tun = loadTunables();

/** `[destruction]`'s options, with the trench arena's water table (y 42). */
export function shellOptions(): DetonateOptions {
  return {
    hardLimit: tun.f('destruction.resists_above_hardness'),
    core: tun.f('destruction.core_radius_scale'),
    loosen: tun.f('destruction.loosen_radius_scale'),
    waterTable: 42,
  };
}

/**
 * 25.6 × 12.8 × 25.6 m: clay to y 64, a trench along x floored at 44 from z 120 to 136, and a
 * parapet of spoil behind it at its angle of repose, z 138–162 at its foot, its crest at y 76; the
 * water table at 42. (Standing steeper, the whole ridge slumps when a shell disturbs it: 0.8 s.)
 */
export function trenchArena(): BrickMap {
  const map = new BrickMap({ x: 256, y: 128, z: 256 });
  map.fillBox(0, 0, 0, 256, 64, 256, P.CLAY);
  map.fillBox(0, 44, 120, 256, 64, 136, P.AIR);
  for (let y = 64; y < 76; y++) map.fillBox(0, y, 138 + (y - 64), 256, y + 1, 162 - (y - 64), P.SPOIL);
  map.takeDirty();
  return map;
}

/** Whether two maps hold the same voxels everywhere. */
export function sameWorld(a: BrickMap, b: BrickMap): boolean {
  const x = new Uint8Array(512);
  const y = new Uint8Array(512);
  for (let bi = 0; bi < a.table.length; bi++) {
    a.readBrick(bi, x);
    b.readBrick(bi, y);
    for (let i = 0; i < 512; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
