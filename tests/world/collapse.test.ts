import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { collapseRegion, floodRegion } from '../../src/world/destruction';
import { P, isLoose } from '../../src/world/materials';

const D = { x: 64, y: 64, z: 64 };
const count = (w: BrickMap, p: number) => {
  let n = 0;
  for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (w.get(x, y, z) === p) n++;
  return n;
};

describe('collapseRegion', () => {
  it('drops hanging soil onto the ground below, and leaves timber standing', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(20, 20, 20, 24, 24, 24, P.MUD);
    w.fillBox(40, 20, 40, 44, 24, 44, P.TIMBER);
    collapseRegion(w, { x0: 16, y0: 16, z0: 16, x1: 48, y1: 30, z1: 48 }, { repose: false });
    expect(w.get(21, 10, 21)).toBe(P.MUD);
    expect(w.get(21, 13, 21)).toBe(P.MUD);
    expect(w.get(21, 14, 21)).toBe(P.AIR);
    expect(w.get(41, 22, 41)).toBe(P.TIMBER);
  });
  it('lets dirt displace standing water upward', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(30, 10, 30, 31, 12, 31, P.WATER);
    w.set(30, 15, 30, P.MUD);
    collapseRegion(w, { x0: 28, y0: 10, z0: 28, x1: 33, y1: 16, z1: 33 }, { repose: false });
    expect([w.get(30, 10, 30), w.get(30, 11, 30), w.get(30, 12, 30)]).toEqual([P.MUD, P.WATER, P.WATER]);
  });
  it('slumps loose spoil to its angle of repose and conserves it', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(31, 10, 31, 33, 22, 33, P.SPOIL);
    const before = count(w, P.SPOIL);
    collapseRegion(w, { x0: 28, y0: 10, z0: 28, x1: 36, y1: 22, z1: 36 });
    expect(count(w, P.SPOIL)).toBe(before);
    for (let z = 1; z < 63; z++) for (let y = 11; y < 40; y++) for (let x = 1; x < 63; x++) {
      if (!isLoose(w.get(x, y, z))) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const steep = w.get(x + dx, y, z + dz) === P.AIR && w.get(x + dx, y - 1, z + dz) === P.AIR;
        expect(steep, `loose voxel at ${x},${y},${z} past repose`).toBe(false);
      }
    }
  });
  it('stays inside the world at its edges and top', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 40, 0, 4, 64, 4, P.SPOIL);
    const before = count(w, P.SPOIL);
    expect(() => collapseRegion(w, { x0: -5, y0: 30, z0: -5, x1: 6, y1: 70, z1: 6 })).not.toThrow();
    expect(count(w, P.SPOIL)).toBe(before);
    expect(w.get(0, 0, 0)).toBe(P.SPOIL);
  });
});

describe('floodRegion', () => {
  it('fills open voxels at or below the table and drains water left hanging', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(10, 5, 10, 14, 10, 14, P.AIR);
    w.set(40, 30, 40, P.WATER);
    floodRegion(w, { x0: 0, y0: 0, z0: 0, x1: 64, y1: 40, z1: 64 }, 7);
    expect(w.get(11, 5, 11)).toBe(P.WATER);
    expect(w.get(11, 7, 11)).toBe(P.WATER);
    expect(w.get(11, 8, 11)).toBe(P.AIR);
    expect(w.get(40, 30, 40)).toBe(P.AIR);
  });
});
