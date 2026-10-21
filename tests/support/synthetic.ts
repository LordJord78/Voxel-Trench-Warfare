/**
 * Small worlds for renderer tests: 256 × 128 × 256 voxels holding one of
 * everything the traversal and the uploads must handle — uniform ground,
 * a noisy dense surface, walls with openings, a roof, single-voxel wire, a
 * pool of water, a brick of 20 materials (the 8-bit record format) and empty
 * sectors overhead. Deterministic for a seed.
 */

import { hash32 } from '../../src/core/hash';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import { bandResult, type BandResult } from '../../src/world/generation/fill';
import { P } from '../../src/world/materials';

export const SYNTHETIC = { x: 256, y: 128, z: 256 };

const SURFACE = [P.SOD, P.SOD_DRY, P.MUD, P.MUD_WET, P.CLAY];

export function syntheticWorld(seed: number): BrickMap {
  const map = new BrickMap(SYNTHETIC);
  map.fillBox(0, 0, 0, SYNTHETIC.x, 40, SYNTHETIC.z, P.SUBSOIL);
  for (let z = 0; z < SYNTHETIC.z; z++) {
    for (let x = 0; x < SYNTHETIC.x; x++) {
      const h = hash32(x >> 2, z >> 2, seed);
      const top = 40 + (h % 8) + ((hash32(x, z, seed) & 7) === 0 ? 1 : 0);
      for (let y = 40; y < top; y++) map.set(x, y, z, SURFACE[(h >>> 8) % SURFACE.length]);
    }
  }
  // A brick wall with a doorway and a window.
  map.fillBox(100, 40, 50, 103, 72, 150, P.BRICK);
  map.fillBox(100, 48, 90, 103, 64, 102, P.AIR);
  map.fillBox(100, 58, 120, 103, 64, 130, P.AIR);
  // A timber roof on four posts.
  for (const [px, pz] of [[150, 150], [196, 150], [150, 196], [196, 196]]) map.fillBox(px, 40, pz, px + 4, 70, pz + 4, P.TIMBER);
  map.fillBox(148, 70, 148, 202, 72, 202, P.TIMBER_DARK);
  // Wire: one voxel thick, sagging across the field.
  for (let x = 20; x < 120; x++) map.set(x, 56 - (((x - 70) * (x - 70)) >> 9), 30, P.WIRE);
  // A pit of water.
  map.fillBox(30, 34, 180, 60, 49, 210, P.AIR);
  map.fillBox(30, 34, 180, 60, 44, 210, P.WATER);
  // One brick of 20 materials, so the 8-bit record format is exercised.
  for (let i = 0; i < 512; i++) map.set(160 + (i & 7), 80 + ((i >> 3) & 7), 160 + (i >> 6), 1 + (i % 20));
  map.takeDirty();
  return map;
}

/** The map cut into 32-voxel bands and encoded as generation workers return them. */
export function bandsOf(map: BrickMap): BandResult[] {
  const out: BandResult[] = [];
  for (let band = 0; band < map.dims.x / 32; band++) {
    const part = new BrickMap({ x: 32, y: map.dims.y, z: map.dims.z });
    for (let bz = 0; bz < map.bricks.z; bz++) {
      for (let by = 0; by < map.bricks.y; by++) {
        for (let lx = 0; lx < 4; lx++) {
          const bi = map.brickIndex(band * 4 + lx, by, bz);
          const e = map.table[bi];
          if (e === 0) continue;
          const local = part.brickIndex(lx, by, bz);
          if (e & UNIFORM) part.loadBrick(local, e);
          else part.loadBrick(local, 0, map.denseView(bi)!);
        }
      }
    }
    out.push(bandResult(part, band));
  }
  return out;
}
