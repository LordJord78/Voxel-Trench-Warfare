import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { BrickMap } from '../../src/world/bricks';
import { detonate } from '../../src/world/destruction';
import { detonationRegion, runDetonation, type DetonationResult } from '../../src/world/detonation';
import { isLoose, P } from '../../src/world/materials';
import { groundTop } from '../../src/world/raycast';
import { applyPatch, copyRegion, regionMap, sectorBox, type BrickPatch } from '../../src/world/region-copy';
import { sameWorld, shellOptions, trenchArena } from '../support/worlds';

// A shell's crater is cut off the main thread, on a copy of the region it works over: the copy is
// the world's, brick for brick; the job cuts what detonate cuts in place; and a slump cut short at
// the copy's edge asks for a wider copy (the spec's §3, "a destruction worker").
const options = shellOptions;
const trench = trenchArena;

/** The job for a shell of `radius` at `centre` on `map`, asking again with each wider region it is told to; and its patches. */
function job(map: BrickMap, centre: [number, number, number], radius: number, seed: number, margin?: number): { patches: BrickPatch[]; asked: number } {
  let box = detonationRegion(map.dims, centre, radius, options().loosen, margin)!;
  for (let asked = 0; asked < 4; asked++) {
    const r: DetonationResult = runDetonation({ id: 1, centre, radius, seed, options: options(), copy: copyRegion(map, box), world: map.dims });
    if ('patches' in r) return { patches: r.patches, asked };
    box = r.wider;
  }
  throw new Error('still asking for a wider region');
}

const brickOf = (map: BrickMap, p: BrickPatch) => map.brickIndex(p.at[0], p.at[1], p.at[2]);

describe('a crater cut on a copy of its region', () => {
  it("a region copied out is the world's, brick for brick", () => {
    const map = trench();
    const box = sectorBox(map.dims, { x0: 100, y0: 60, z0: 110, x1: 150, y1: 80, z1: 160 })!;
    expect([box.x0, box.x1, box.y0, box.y1, box.z0, box.z1]).toEqual([96, 160, 0, 128, 96, 160]);
    const copy = copyRegion(map, box);
    const local = regionMap(copy);
    const a = new Uint8Array(512);
    const b = new Uint8Array(512);
    for (let bz = 0; bz < copy.size[2]; bz++) {
      for (let by = 0; by < copy.size[1]; by++) {
        for (let bx = 0; bx < copy.size[0]; bx++) {
          local.readBrick(local.brickIndex(bx, by, bz), a);
          map.readBrick(map.brickIndex(copy.origin[0] + bx, copy.origin[1] + by, copy.origin[2] + bz), b);
          expect(a).toEqual(b);
        }
      }
    }
    expect(() => copyRegion(map, { x0: 100, y0: 0, z0: 96, x1: 160, y1: 128, z1: 160 })).toThrow(RangeError);
  });

  it("the job's crater is detonate's in place, voxel for voxel, and it lists only bricks that changed", () => {
    const inPlace = trench();
    detonate(inPlace, 128, 76, 150, 30, Rng.root(11), options());
    const map = trench();
    const { patches } = job(map, [128, 76, 150], 30, 11);
    expect(patches.length).toBeGreaterThan(50);
    const before = new Uint8Array(512);
    for (const p of patches) {
      map.readBrick(brickOf(map, p), before);
      const after = p.voxels ?? new Uint8Array(512).fill(p.entry & 0xff);
      expect(Array.from(after)).not.toEqual(Array.from(before));
      applyPatch(map, p);
    }
    expect(map.takeDirty().length).toBe(patches.length);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it("the parapet's rim slumps into the trench", () => {
    const map = trench();
    for (const p of job(map, [128, 76, 150], 30, 11).patches) applyPatch(map, p);
    let slumped = 0;
    for (let z = 126; z < 136; z++) for (let x = 96; x < 160; x++) if (isLoose(map.get(x, 44, z))) slumped++;
    expect(slumped).toBeGreaterThan(50);
  });

  it('a crater below the water table floods to it', () => {
    const map = trench();
    for (const p of job(map, [64, 64, 64], 30, 5).patches) applyPatch(map, p);
    let water = 0;
    for (let z = 59; z <= 69; z++) {
      for (let x = 59; x <= 69; x++) {
        for (let y = 30; y < 64; y++) {
          const v = map.get(x, y, z);
          if (y <= 42) expect(v, `${x},${y},${z}`).not.toBe(P.AIR);
          else expect(v, `${x},${y},${z}`).not.toBe(P.WATER);
          if (v === P.WATER) water++;
        }
      }
    }
    expect(water).toBeGreaterThan(100);
  });

  it('the same request cuts the same crater twice', () => {
    const a = job(trench(), [128, 76, 150], 30, 11).patches;
    const b = job(trench(), [128, 76, 150], 30, 11).patches;
    const plain = (ps: BrickPatch[]) => ps.map((p) => ({ at: p.at, entry: p.entry, voxels: p.voxels ? Array.from(p.voxels) : null }));
    expect(plain(b)).toEqual(plain(a));
  });

  it("a slump cut short at the region's edge asks for a wider region, and that one matches in place", () => {
    const inPlace = trench();
    detonate(inPlace, 128, 76, 150, 30, Rng.root(11), options());
    const map = trench();
    const { patches, asked } = job(map, [128, 76, 150], 30, 11, 0);
    expect(asked).toBeGreaterThan(0);
    for (const p of patches) applyPatch(map, p);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it("a crater at the world's edge lands, clamped, as it does in place", () => {
    const inPlace = trench();
    detonate(inPlace, 4, 64, 4, 30, Rng.root(3), options());
    const map = trench();
    for (const p of job(map, [4, 64, 4], 30, 3).patches) applyPatch(map, p);
    expect(sameWorld(inPlace, map)).toBe(true);
  });

  it("the ground's top is the first voxel down a column that is not air", () => {
    const map = trench();
    expect(groundTop(map, 10.5, 10.5)).toBe(64);
    expect(groundTop(map, 10, 150)).toBe(76);
    expect(groundTop(map, 10, 145)).toBe(72);
    expect(groundTop(map, 10, 125)).toBe(44);
    for (let y = 44; y < 50; y++) map.set(10, y, 125, P.WATER);
    expect(groundTop(map, 10, 125)).toBe(50);
    map.fillBox(200, 0, 200, 208, 128, 208, P.AIR);
    expect(groundTop(map, 201, 201)).toBeNull();
    expect(groundTop(map, -1, 10)).toBeNull();
    expect(groundTop(map, 10, 256)).toBeNull();
  });
});
