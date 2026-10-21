/**
 * The checks a generated world must pass, from the spec: nothing granular
 * hanging, nothing loose past its angle of repose, no water above the table
 * (bar one-voxel ditch puddles). Scans dense bricks voxel by voxel and skips
 * uniform ones whose neighbours make them trivially fine, so the full map
 * checks in seconds.
 */

import { BrickMap, UNIFORM } from '../bricks';
import { K, isGranular, isLoose, isSolid, kindOf } from '../materials';

export interface InvariantReport {
  hangingGranular: number;
  looseSteep: number;
  waterAboveTable: number;
  samples: string[];
}

const GRANULAR = Uint8Array.from({ length: 256 }, (_, p) => (isGranular(p) ? 1 : 0));
const LOOSE = Uint8Array.from({ length: 256 }, (_, p) => (isLoose(p) ? 1 : 0));
const SOLID = Uint8Array.from({ length: 256 }, (_, p) => (isSolid(p) ? 1 : 0));
const WATERY = Uint8Array.from({ length: 256 }, (_, p) => (kindOf(p) === K.WATER ? 1 : 0));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function checkInvariants(map: BrickMap, waterTable: number, opts: { ditchWater?: boolean } = {}): InvariantReport {
  const report: InvariantReport = { hangingGranular: 0, looseSteep: 0, waterAboveTable: 0, samples: [] };
  const note = (what: string, x: number, y: number, z: number, v: number) => {
    if (report.samples.length < 12) report.samples.push(`${what} at ${x},${y},${z} (palette ${v})`);
  };
  const raw = new Uint8Array(512);
  const { bricks } = map;

  for (let bz = 0; bz < bricks.z; bz++) {
    for (let by = 0; by < bricks.y; by++) {
      for (let bx = 0; bx < bricks.x; bx++) {
        const bi = map.brickIndex(bx, by, bz);
        const e = map.table[bi];
        if (e === 0) continue;
        let bottomOnly = false;
        if (e & UNIFORM) {
          const v = e & 0xff;
          const wet = WATERY[v] && by * 8 + 7 > waterTable;
          if (!GRANULAR[v] && !wet) continue;
          if (GRANULAR[v] && !LOOSE[v] && !wet) {
            // Interior voxels rest on the same solid material; only the bottom layer can hang.
            const under = by > 0 ? map.table[map.brickIndex(bx, by - 1, bz)] : (UNIFORM | v) >>> 0;
            if (under & UNIFORM && SOLID[under & 0xff]) continue;
            bottomOnly = true;
          }
          raw.fill(v);
        } else {
          map.readBrick(bi, raw);
        }
        const yEnd = bottomOnly ? 1 : 8;
        for (let ly = 0; ly < yEnd; ly++) {
          for (let lz = 0; lz < 8; lz++) {
            for (let lx = 0; lx < 8; lx++) {
              const v = raw[lx + ly * 8 + lz * 64];
              if (!GRANULAR[v] && !WATERY[v]) continue;
              const x = bx * 8 + lx;
              const y = by * 8 + ly;
              const z = bz * 8 + lz;
              const below = y === 0 ? -1 : ly > 0 ? raw[lx + (ly - 1) * 8 + lz * 64] : map.get(x, y - 1, z);
              if (GRANULAR[v]) {
                if (below !== -1 && !SOLID[below]) {
                  report.hangingGranular++;
                  note('hanging', x, y, z, v);
                }
                if (LOOSE[v] && y > 0) {
                  for (const [dx, dz] of DIRS) {
                    const nx = x + dx;
                    const nz = z + dz;
                    if (!map.inBounds(nx, y, nz)) continue;
                    if (map.get(nx, y, nz) !== 0 || map.get(nx, y - 1, nz) !== 0) continue;
                    report.looseSteep++;
                    note('past repose', x, y, z, v);
                    break;
                  }
                }
              } else if (y > waterTable) {
                const above = y + 1 < map.dims.y ? map.get(x, y + 1, z) : 0;
                const puddle = opts.ditchWater === true && below !== -1 && SOLID[below] === 1 && !WATERY[above];
                if (!puddle) {
                  report.waterAboveTable++;
                  note('water above table', x, y, z, v);
                }
              }
            }
          }
        }
      }
    }
  }
  return report;
}
