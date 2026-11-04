import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import { BLOOD_OF, K, kindOf, P, PALETTE } from '../../src/world/materials';
import type { Box } from '../../src/world/region';
import { spatter, spatterTunables } from '../../src/world/spatter';

// Spatter (the shots spec's §4): a critical hit marks what is behind the body. Up to 14 rays from
// where the round went in, along it and within 25° of it, reach up to 2.5 m; each recolours the
// first thing it meets to its kind's blood shade, if its kind takes one. Positions and directions
// are in voxels.
const tun = loadTunables();
const V = tun.f('world.voxel_size');
const T = spatterTunables(tun, V);
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const N = 64;

/** Where the round went in: in the middle, off the grid, headed +z. */
const FROM: [number, number, number] = [32.37, 32.61, 10];
const DIR: [number, number, number] = [0, 0, 1];

/** 6.4 m a side, filled across z [z0, z1) with `fill` (a shade, or one for each x and y). */
function wall(z0: number, z1: number, fill: number | ((x: number, y: number) => number)): BrickMap {
  const map = new BrickMap({ x: N, y: N, z: N });
  if (typeof fill === 'number') map.fillBox(0, 0, z0, N, N, z1, fill);
  else for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) map.fillBox(x, y, z0, x + 1, y + 1, z1, fill(x, y));
  map.takeDirty();
  return map;
}

/** Every voxel that differs between two maps, in x, y, z order: [x, y, z, was, now]. */
function changed(before: BrickMap, after: BrickMap): number[][] {
  const out: number[][] = [];
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
    const was = before.get(x, y, z);
    const now = after.get(x, y, z);
    if (was !== now) out.push([x, y, z, was, now]);
  }
  return out;
}

/** The spatter of `seed` from FROM along DIR on a fresh `make()`: what it said it marked, and what it did. */
function marked(make: () => BrickMap, seed: number, from: readonly number[] = FROM, dir: readonly number[] = DIR) {
  const before = make();
  const map = make();
  const n = spatter(map, from, dir, seed, T);
  return { n, marks: changed(before, map) };
}

/** How far `c` is from the voxel span [i, i + 1]. */
const gap = (c: number, i: number) => Math.max(0, i - c, c - (i + 1));
const tanDeg = (deg: number) => Math.tan((deg * Math.PI) / 180);

/** Within `deg` of `dir` from `from`, for a voxel some ray went into: its middle is, give or take the half-diagonal it subtends. */
function inCone(cell: readonly number[], from: readonly number[], dir: readonly number[], deg: number): boolean {
  const d = [cell[0] + 0.5 - from[0], cell[1] + 0.5 - from[1], cell[2] + 0.5 - from[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const angle = Math.acos(Math.min(1, (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / r));
  return angle <= (deg * Math.PI) / 180 + Math.asin(Math.min(1, Math.sqrt(3) / 2 / r)) + 1e-9;
}

describe('spatter', () => {
  it('a wall of soil 1.5 m behind a hit takes up to 14 blood voxels, all BLOOD_SOIL, all within the 25° cone', () => {
    expect(T.rays).toBe(14);
    expect(T.coneDeg).toBe(25);
    expect(T.reach).toBeCloseTo(2.5 / V, 9);
    // Every soil, in stripes across it: sod, mud, clay, subsoil and spoil all take BLOOD_SOIL.
    const soils = [P.SOD, P.MUD_WET, P.CLAY, P.SUBSOIL, P.SPOIL];
    const make = () => wall(25, 40, (x) => soils[x % soils.length]);
    const kinds = new Set<number>();
    let wide = 0;
    for (const seed of SEEDS) {
      const { n, marks } = marked(make, seed);
      expect(n).toBe(marks.length);
      // Up to 14: a voxel two rays meet is marked once.
      expect(n).toBeGreaterThanOrEqual(9);
      expect(n).toBeLessThanOrEqual(14);
      for (const [x, y, z, was, now] of marks) {
        expect(now).toBe(P.BLOOD_SOIL);
        kinds.add(kindOf(was));
        // The first voxel each ray meets: on the wall's face, 15 voxels on.
        expect(z).toBe(25);
        // The ray came in through the voxel's near face: some point of it is within 25° of the round's line.
        expect(Math.hypot(gap(FROM[0], x), gap(FROM[1], y))).toBeLessThanOrEqual(15 * tanDeg(25) + 1e-9);
        if (Math.hypot(x + 0.5 - FROM[0], y + 0.5 - FROM[1]) > 15 * tanDeg(18)) wide++;
      }
    }
    expect(kinds).toEqual(new Set([K.SOD, K.MUD, K.CLAY, K.SUBSOIL, K.SPOIL]));
    // Over the whole cone, not bunched in its middle: some land more than 18° out.
    expect(wide).toBeGreaterThan(0);
  });

  it('the cone is about the round, whichever way it goes: one slanting down into the ground marks the ground ahead of it', () => {
    const ground = () => {
      const map = new BrickMap({ x: N, y: N, z: N });
      map.fillBox(0, 0, 0, N, 20, N, P.SOD);
      map.takeDirty();
      return map;
    };
    const from = [20.3, 30.2, 20.7];
    const l = Math.hypot(1, -1, 0.6);
    const dir = [1 / l, -1 / l, 0.6 / l];
    let total = 0;
    for (const seed of SEEDS) {
      const { n, marks } = marked(ground, seed, from, dir);
      expect(n).toBe(marks.length);
      for (const [x, y, z, , now] of marks) {
        expect(now).toBe(P.BLOOD_SOIL);
        expect(y).toBe(19);
        expect(inCone([x, y, z], from, dir, 25)).toBe(true);
        // Within reach of where the round went in.
        expect(Math.hypot(gap(from[0], x), gap(from[1], y), gap(from[2], z))).toBeLessThan(25);
      }
      total += n;
    }
    expect(total).toBeGreaterThan(SEEDS.length);
  });

  it('nothing past 2.5 m is marked', () => {
    // A wall 2.6 m behind: no ray reaches it.
    for (const seed of SEEDS) {
      const map = wall(36, 50, P.MUD);
      expect(spatter(map, FROM, DIR, seed, T)).toBe(0);
      expect(map.takeDirty()).toEqual([]);
    }
    // 2.4 m behind: the rays near the round's line reach it; those further out, whose way to it is
    // longer, do not.
    let reached = 0;
    for (const seed of SEEDS) {
      const { n, marks } = marked(() => wall(34, 50, P.MUD), seed);
      expect(n).toBe(marks.length);
      expect(n).toBeLessThan(14);
      for (const [x, y, z] of marks) expect(Math.hypot(gap(FROM[0], x), gap(FROM[1], y), z - FROM[2])).toBeLessThan(25);
      reached += n;
    }
    expect(reached).toBeGreaterThan(0);
  });

  it("water, wire and metal take no blood; timber takes BLOOD_TIMBER, and stays timber's kind", () => {
    // Down into a flooded crater: the water takes it, and the mud under the water is not marked.
    const pool = () => {
      const map = new BrickMap({ x: N, y: N, z: N });
      map.fillBox(0, 0, 0, N, 20, N, P.MUD);
      map.fillBox(0, 20, 0, N, 26, N, P.WATER);
      map.takeDirty();
      return map;
    };
    for (const seed of SEEDS) {
      const map = pool();
      expect(spatter(map, [32.37, 40, 32.61], [0, -1, 0], seed, T)).toBe(0);
      expect(map.takeDirty()).toEqual([]);
    }
    // Through wire, to the mud behind it: the wire is left as it was.
    const fenced = () => {
      const map = wall(25, 40, P.MUD);
      map.fillBox(0, 0, 18, N, N, 19, P.WIRE_RUST);
      map.takeDirty();
      return map;
    };
    for (const seed of SEEDS) {
      const { n, marks } = marked(fenced, seed);
      expect(n).toBeGreaterThan(0);
      for (const [, , z, was, now] of marks) expect([z, was, now]).toEqual([25, P.MUD, P.BLOOD_SOIL]);
    }
    // Metal (the range's plates among it) takes none, and keeps it off what is behind.
    for (const metal of [P.HULL, P.HULL_RUST, P.CORRUGATE, P.PICKET, P.TARGET_STEEL, P.TARGET_STEEL_HIT]) {
      const map = wall(25, 40, P.MUD);
      map.fillBox(0, 0, 20, N, N, 21, metal);
      map.takeDirty();
      for (const seed of SEEDS) expect(spatter(map, FROM, DIR, seed, T), PALETTE[metal].name).toBe(0);
      expect(map.takeDirty()).toEqual([]);
    }
    // Timber, its shades all: its own blood, of its own kind.
    const timbers = [P.TIMBER, P.TIMBER_WEATHERED, P.TIMBER_DARK];
    for (const seed of SEEDS) {
      const { n, marks } = marked(() => wall(25, 40, (x, y) => timbers[(x + y) % 3]), seed);
      expect(n).toBeGreaterThan(0);
      for (const [, , , was, now] of marks) {
        expect(timbers).toContain(was);
        expect(now).toBe(P.BLOOD_TIMBER);
      }
    }
    expect(BLOOD_OF(K.TIMBER)).toBe(P.BLOOD_TIMBER);
    expect(kindOf(P.BLOOD_TIMBER)).toBe(K.TIMBER);
  });

  it("sandbags, duckboards and cloth take their own shades, each of its kind; a curtain catches what a round goes through; brick, rubble, trunks and a firing step's bench take none", () => {
    // 0.5 m short of a wall of mud.
    const before = (shade: number) => () => {
      const map = wall(25, 40, P.MUD);
      map.fillBox(0, 0, 20, N, N, 21, shade);
      map.takeDirty();
      return map;
    };
    const own: [number, number, number][] = [
      [P.SANDBAG_SEAM, P.BLOOD_SANDBAG, K.SANDBAG],
      [P.DUCKBOARD_WORN, P.BLOOD_DUCKBOARD, K.DUCKBOARD],
      [P.CLOTH, P.BLOOD_CLOTH, K.CLOTH],
      [P.LEAF_DRY, P.BLOOD_CLOTH, K.CLOTH],
    ];
    for (const [shade, blood, kind] of own) {
      for (const seed of SEEDS) {
        const { n, marks } = marked(before(shade), seed);
        expect(n, PALETTE[shade].name).toBeGreaterThan(0);
        // On it, not the mud behind it.
        for (const [, , z, was, now] of marks) expect([z, was, now]).toEqual([20, shade, blood]);
      }
      expect(kindOf(blood)).toBe(kind);
    }
    // The bench is timber, but the controller knows a firing step by its shade (physics/grid.ts).
    for (const none of [P.BRICK, P.CONCRETE, P.RUBBLE, P.TRUNK_BARK, P.BENCH]) {
      const map = before(none)();
      for (const seed of SEEDS) expect(spatter(map, FROM, DIR, seed, T), PALETTE[none].name).toBe(0);
      expect(map.takeDirty()).toEqual([]);
    }
  });

  it('voxels inside a region out are skipped', () => {
    // The region: the wall's half left of the round's line, in x and z as sim/destruction.ts's
    // overlapsOut reads a box.
    const out: Box = { x0: 0, y0: 0, z0: 0, x1: 32, y1: N, z1: N };
    const overlaps = (b: Box) => b.x0 < out.x1 && out.x0 < b.x1 && b.z0 < out.z1 && out.z0 < b.z1;
    let inside = 0;
    for (const seed of SEEDS) {
      const all = marked(() => wall(25, 40, P.MUD), seed).marks;
      const before = wall(25, 40, P.MUD);
      const map = wall(25, 40, P.MUD);
      const n = spatter(map, FROM, DIR, seed, T, overlaps);
      const marks = changed(before, map);
      expect(n).toBe(marks.length);
      // What it marks without the region, less what lies in it.
      expect(marks).toEqual(all.filter(([x]) => x >= out.x1));
      expect(marks.length).toBeGreaterThan(0);
      inside += all.length - marks.length;
    }
    expect(inside).toBeGreaterThan(0);
  });

  it('the same seed marks the same voxels', () => {
    const make = () => wall(25, 40, P.MUD);
    const keys = SEEDS.map((seed) => {
      const a = marked(make, seed);
      const b = marked(make, seed);
      expect(b).toEqual(a);
      return JSON.stringify(a.marks);
    });
    // And another seed others: no two of the eight alike.
    expect(new Set(keys).size).toBe(SEEDS.length);
  });
});
