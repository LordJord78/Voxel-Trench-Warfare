import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { carveSphere } from '../../src/world/destruction';
import { buildPyramid, updatePyramid, type Pyramid } from '../../src/render/pyramid';
import { syntheticWorld } from '../support/synthetic';

/** 1 + the highest non-air voxel's y in each 8 × 8 brick column, voxel by voxel. */
function bruteLevel0(map: BrickMap): number[] {
  const out: number[] = [];
  for (let bz = 0; bz < map.bricks.z; bz++) {
    for (let bx = 0; bx < map.bricks.x; bx++) {
      let top = 0;
      for (let z = bz * 8; z < bz * 8 + 8; z++) {
        for (let x = bx * 8; x < bx * 8 + 8; x++) {
          for (let y = map.dims.y - 1; y >= top; y--) {
            if (map.get(x, y, z) !== 0) {
              top = y + 1;
              break;
            }
          }
        }
      }
      out.push(top);
    }
  }
  return out;
}

function checkLevels(p: Pyramid): void {
  for (let k = 1; k < p.levels.length; k++) {
    const below = p.levels[k - 1];
    const here = p.levels[k];
    expect(here.w).toBe(Math.ceil(below.w / 2));
    expect(here.h).toBe(Math.ceil(below.h / 2));
    for (let j = 0; j < here.h; j++) {
      for (let i = 0; i < here.w; i++) {
        let m = 0;
        for (let dj = 0; dj < 2; dj++) {
          for (let di = 0; di < 2; di++) {
            const x = 2 * i + di;
            const z = 2 * j + dj;
            if (x < below.w && z < below.h) m = Math.max(m, p.data[below.offset + z * below.w + x]);
          }
        }
        expect(p.data[here.offset + j * here.w + i]).toBe(m);
      }
    }
  }
  const top = p.levels[p.levels.length - 1];
  expect([top.w, top.h]).toEqual([1, 1]);
}

describe('the max-height pyramid', () => {
  it('builds level 0 voxel-exact and every level as the max below it', () => {
    const map = syntheticWorld(2);
    const p = buildPyramid(map);
    expect(Array.from(p.data.subarray(0, map.bricks.x * map.bricks.z))).toEqual(bruteLevel0(map));
    checkLevels(p);
  });
  it('updates after carving to exactly what a rebuild gives', () => {
    const map = syntheticWorld(2);
    const p = buildPyramid(map);
    const rng = Rng.root(5);
    for (let k = 0; k < 20; k++) carveSphere(map, rng.uniform(10, 246), rng.uniform(40, 80), rng.uniform(10, 246), rng.uniform(3, 14), rng.derive(`carve.${k}`));
    const changed = updatePyramid(p, map, map.takeDirty());
    expect(changed.length).toBeGreaterThan(0);
    expect(Array.from(p.data)).toEqual(Array.from(buildPyramid(map).data));
  });
});
