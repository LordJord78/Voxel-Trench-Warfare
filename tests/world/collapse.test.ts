import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { collapseRegion, floodRegion } from '../../src/world/destruction';
import { K, P, isGranular, isLoose, isSolid, kindOf } from '../../src/world/materials';

const D = { x: 64, y: 64, z: 64 };
const count = (w: BrickMap, p: number) => {
  let n = 0;
  for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (w.get(x, y, z) === p) n++;
  return n;
};

const hanging = (w: BrickMap) => {
  let n = 0;
  for (let z = 0; z < w.dims.z; z++) for (let y = 1; y < w.dims.y; y++) for (let x = 0; x < w.dims.x; x++) {
    if (isGranular(w.get(x, y, z)) && !isSolid(w.get(x, y - 1, z))) n++;
  }
  return n;
};

describe('collapseRegion', () => {
  it('keeps wire and cloth unless soil falls through them', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    for (let y = 10; y < 13; y++) w.set(20, y, 20, P.WIRE);
    w.set(20, 15, 20, P.MUD);
    for (let y = 10; y < 13; y++) w.set(40, y, 40, P.WIRE);
    for (let x = 30; x < 35; x++) w.set(x, 12, 30, P.WIRE);
    w.set(25, 11, 25, P.CLOTH);
    collapseRegion(w, { x0: 10, y0: 10, z0: 10, x1: 50, y1: 20, z1: 50 });
    expect(w.get(20, 10, 20)).toBe(P.MUD);
    expect([w.get(20, 11, 20), w.get(20, 12, 20)]).toEqual([P.AIR, P.AIR]);
    expect([10, 11, 12].map((y) => w.get(40, y, 40))).toEqual([P.WIRE, P.WIRE, P.WIRE]);
    for (let x = 30; x < 35; x++) expect(w.get(x, 12, 30)).toBe(P.WIRE);
    expect(w.get(25, 11, 25)).toBe(P.CLOTH);
  });
  it('settles what the box undercuts in its padded columns too', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 30, 64, P.CLAY);
    w.fillBox(0, 10, 20, 64, 30, 26, P.AIR);
    w.fillBox(0, 30, 26, 64, 38, 34, P.SPOIL);
    collapseRegion(w, { x0: 28, y0: 30, z0: 26, x1: 36, y1: 38, z1: 34 });
    expect(hanging(w)).toBe(0);
    expect(w.get(31, 10, 24)).toBe(P.SPOIL);
  });
  it('never leaves material hanging, even when it stops at the pass cap', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(30, 10, 30, 34, 50, 34, P.SPOIL);
    collapseRegion(w, { x0: 28, y0: 10, z0: 28, x1: 36, y1: 50, z1: 36 }, { maxPasses: 3 });
    expect(hanging(w)).toBe(0);
  });
  it("matches the Python game's one-voxel falls on random columns", () => {
    // Python drops each granular voxel one cell per pass: through air or wire
    // (crushing the wire), swapping with water. Ours settles a column at once;
    // grains, and the wire they spare, must end where Python's would. Water
    // placement may differ (Python leaves it hanging, then drains it).
    const r = Rng.root(11);
    const mix = [P.AIR, P.AIR, P.AIR, P.MUD, P.SPOIL, P.WATER, P.WIRE, P.CLOTH, P.TIMBER];
    for (let trial = 0; trial < 300; trial++) {
      const col: number[] = Array.from({ length: 24 }, () => mix[r.randint(0, mix.length)]);
      col[0] = P.CLAY;
      const ref = col.slice();
      for (let moved = true; moved; ) {
        moved = false;
        const before = ref.slice();
        for (let y = 1; y < ref.length; y++) {
          if (!isGranular(before[y]) || isSolid(before[y - 1])) continue;
          moved = true;
          if (kindOf(before[y - 1]) === K.WATER) { ref[y - 1] = before[y]; ref[y] = P.WATER; }
          else { ref[y - 1] = before[y]; ref[y] = P.AIR; }
        }
      }
      const w = new BrickMap({ x: 32, y: 32, z: 32 });
      col.forEach((v, y) => w.set(5, y, 5, v));
      collapseRegion(w, { x0: 5, y0: 1, z0: 5, x1: 6, y1: 24, z1: 6 }, { repose: false });
      for (let y = 0; y < 24; y++) {
        const got = w.get(5, y, 5);
        const want = ref[y];
        const grain = isGranular(want) || isGranular(got);
        if (!grain && (kindOf(want) === K.WATER || kindOf(got) === K.WATER)) continue;
        expect(got, `trial ${trial} y ${y}: ${col.join(',')}`).toBe(want);
      }
    }
  });
  it('settles a shell-sized region in well under a second', () => {
    const w = new BrickMap({ x: 160, y: 96, z: 160 });
    w.fillBox(0, 0, 0, 160, 50, 160, P.CLAY);
    w.fillBox(0, 25, 70, 160, 50, 95, P.AIR);
    w.fillBox(0, 50, 95, 160, 64, 115, P.SPOIL);
    w.fillBox(60, 40, 85, 100, 64, 125, P.AIR);
    const t0 = performance.now();
    collapseRegion(w, { x0: 50, y0: 20, z0: 75, x1: 110, y1: 70, z1: 135 });
    const ms = performance.now() - t0;
    expect(hanging(w)).toBe(0);
    expect(ms).toBeLessThan(400);
  });
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
  it('drains water pushed above the table', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(5, 10, 5, 6, 15, 6, P.WATER);
    floodRegion(w, { x0: 0, y0: 0, z0: 0, x1: 16, y1: 20, z1: 16 }, 11);
    expect([10, 11, 12, 13, 14].map((y) => w.get(5, y, 5))).toEqual([P.WATER, P.WATER, P.AIR, P.AIR, P.AIR]);
  });
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
