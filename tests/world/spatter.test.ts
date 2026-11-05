import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import { chip, collapseRegion } from '../../src/world/destruction';
import { BLOOD_OF, hardness, isGranular, isLoose, isOpaque, isSolid, K, kindOf, P, PALETTE, spoilOf } from '../../src/world/materials';
import type { Box } from '../../src/world/region';
import { spatter, spatterTunables, type SpatterTunables } from '../../src/world/spatter';
import { fallAxis, inCone, offAxis } from '../support/spatter';

// Spatter (the shots spec's §4): a critical hit marks what is behind the body. Up to 14 rays from
// where the round went in, along it and within 25° of it, reach up to 2.5 m; 10 more fall from there,
// within 30° of an axis tilted 30° from straight down toward the round, so a body standing in the
// open marks the ground behind it. Both cones pack their rays toward their axis. Each ray recolours
// the first thing it meets to its kind's blood shade, if its kind takes one. Positions and
// directions are in voxels.
const tun = loadTunables();
const V = tun.f('world.voxel_size');
const T = spatterTunables(tun, V);
/** The cone along the round alone, for what is said of it. */
const CONE: SpatterTunables = { ...T, fallRays: 0 };
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const N = 64;

/** Where the round went in: in the middle, off the grid, headed +z. */
const FROM: [number, number, number] = [32.37, 32.61, 10];
const DIR: [number, number, number] = [0, 0, 1];
/** A head 1.65 m above sod whose top is at y 16, off the grid. */
const HEAD: [number, number, number] = [32.37, 32.5, 10.61];

/** 6.4 m a side, filled across z [z0, z1) with `fill` (a shade, or one for each x and y). */
function wall(z0: number, z1: number, fill: number | ((x: number, y: number) => number)): BrickMap {
  const map = new BrickMap({ x: N, y: N, z: N });
  if (typeof fill === 'number') map.fillBox(0, 0, z0, N, N, z1, fill);
  else for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) map.fillBox(x, y, z0, x + 1, y + 1, z1, fill(x, y));
  map.takeDirty();
  return map;
}

/** Sod to y 16, 1.65 m under HEAD, and nothing on it; with a wall of mud across z [z0, 40) above it, given `z0`. */
function open(z0?: number): BrickMap {
  const map = new BrickMap({ x: N, y: N, z: N });
  map.fillBox(0, 0, 0, N, 16, N, P.SOD);
  if (z0 !== undefined) map.fillBox(0, 16, z0, N, N, 40, P.MUD);
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

/** The spatter of `seed` (with `t`) from `from` along `dir` on a fresh `make()`: what it said it marked, and what it did. */
function marked(make: () => BrickMap, seed: number, t: SpatterTunables = T, from: readonly number[] = FROM, dir: readonly number[] = DIR) {
  const before = make();
  const map = make();
  const n = spatter(map, from, dir, seed, t);
  return { n, marks: changed(before, map) };
}

/** How far `c` is from the voxel span [i, i + 1]. */
const gap = (c: number, i: number) => Math.max(0, i - c, c - (i + 1));
const tanDeg = (deg: number) => Math.tan((deg * Math.PI) / 180);

describe('spatter', () => {
  it('a wall of soil 1.5 m behind a hit takes up to 14 blood voxels, all BLOOD_SOIL, all within the 25° cone', () => {
    expect(T.rays).toBe(14);
    expect(T.coneDeg).toBe(25);
    expect(T.reach).toBeCloseTo(2.5 / V, 9);
    // The soils that take BLOOD_SOIL, in stripes across it: sod and mud, whose rules are alike.
    const soils = [P.SOD, P.MUD_WET, P.SOD_DRY, P.MUD];
    const make = () => wall(25, 40, (x) => soils[x % soils.length]);
    const kinds = new Set<number>();
    let wide = 0;
    for (const seed of SEEDS) {
      const { n, marks } = marked(make, seed, CONE);
      expect(n).toBe(marks.length);
      // Up to 14: a voxel two rays meet is marked once, and more meet in the splat's packed core.
      expect(n).toBeGreaterThanOrEqual(8);
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
    expect(kinds).toEqual(new Set([K.SOD, K.MUD]));
    // Over the whole cone, not all in its middle: some land more than 18° out.
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
      const { n, marks } = marked(ground, seed, CONE, from, dir);
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

  it('the falling rays spread within 30° of an axis tilted 30° from straight down toward where the round goes across the ground; straight down for a round within 1e-6 of straight up or down', () => {
    expect([T.fallRays, T.fallConeDeg, T.fallTiltDeg, T.core]).toEqual([10, 30, 30, 2]);
    expect(T.fallReach).toBeCloseTo(2.5 / V, 9);
    // Sod 1.5 m under the hit, and the falling rays alone.
    const ground = () => {
      const map = new BrickMap({ x: N, y: N, z: N });
      map.fillBox(0, 0, 0, N, 20, N, P.SOD);
      map.takeDirty();
      return map;
    };
    const from = [32.37, 35, 32.61];
    const FALL: SpatterTunables = { ...T, rays: 0 };
    const unit = (v: readonly number[]) => v.map((c) => c / Math.hypot(v[0], v[1], v[2]));
    // Down, level and up, each its own way across the ground; then straight down and up, and within 1e-6 of them.
    const tilted = [[1, -0.3, 0.6], [-0.2, 0.05, -1], [0.7, 0.7, -0.1]].map(unit);
    const vertical = [[0, -1, 0], [0, 1, 0], [4e-7, -1, -6e-7], [-5e-7, 1, 5e-7]].map(unit);
    const seen: string[] = [];
    for (const dir of [...tilted, ...vertical]) {
      const axis = fallAxis(dir, 30);
      if (vertical.includes(dir)) expect(axis).toEqual([0, -1, 0]);
      let n = 0;
      for (const seed of SEEDS) {
        const { marks } = marked(ground, seed, FALL, from, dir);
        for (const [x, y, z, , now] of marks) {
          expect([y, now]).toEqual([19, P.BLOOD_SOIL]);
          expect(inCone([x, y, z], from, axis, 30), `${dir}`).toBe(true);
          n++;
        }
        if (vertical.includes(dir)) seen.push(JSON.stringify(marks));
      }
      expect(n, `${dir}`).toBeGreaterThan(SEEDS.length);
    }
    // Straight down and up fall alike, and so do the rounds within 1e-6 of them.
    const per = SEEDS.length;
    for (let k = 1; k < vertical.length; k++) expect(seen.slice(k * per, (k + 1) * per)).toEqual(seen.slice(0, per));
  });

  it('nothing past 2.5 m is marked', () => {
    // A wall 2.6 m behind: no ray reaches it, on along the round or falling.
    for (const seed of SEEDS) {
      const map = wall(36, 50, P.MUD);
      expect(spatter(map, FROM, DIR, seed, T)).toBe(0);
      expect(map.takeDirty()).toEqual([]);
    }
    // 2.4 m behind: the rays near the round's line reach it; those further out, whose way to it is
    // longer, do not.
    let reached = 0;
    for (const seed of SEEDS) {
      const { n, marks } = marked(() => wall(34, 50, P.MUD), seed, CONE);
      expect(n).toBe(marks.length);
      expect(n).toBeLessThan(14);
      for (const [x, y, z] of marks) expect(Math.hypot(gap(FROM[0], x), gap(FROM[1], y), z - FROM[2])).toBeLessThan(25);
      reached += n;
    }
    expect(reached).toBeGreaterThan(0);
  });

  it('a body standing in the open: a level round through a head 1.65 m above flat sod marks at least 4 ground voxels with BLOOD_SOIL, each within 2.5 m of the hit and none more than one voxel nearer the shooter than the hit', () => {
    for (const seed of SEEDS) {
      const { n, marks } = marked(() => open(), seed, T, HEAD);
      expect(n).toBe(marks.length);
      expect(n).toBeGreaterThanOrEqual(4);
      for (const [x, y, z, was, now] of marks) {
        // On the sod's top.
        expect([y, was, now]).toEqual([15, P.SOD, P.BLOOD_SOIL]);
        expect(Math.hypot(gap(HEAD[0], x), gap(HEAD[1], y), gap(HEAD[2], z))).toBeLessThanOrEqual(25 + 1e-9);
        // Behind the body, the way the round went: the shooter is down −z.
        expect(z).toBeGreaterThanOrEqual(HEAD[2] - 1);
      }
    }
    // Only the falling rays come down to it: given a reach short of it, nothing is marked.
    for (const seed of SEEDS) expect(spatter(open(), HEAD, DIR, seed, { ...T, fallReach: 16 })).toBe(0);
  });

  it('the cone packs toward the round: over 20 seeds into a wide wall 1.5 m behind, the median angle off the round of the marks is under 12°, every mark is within 25°, and some mark is beyond 15°', () => {
    const make = () => wall(25, 40, P.MUD);
    const angles: number[] = [];
    let beyond = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const [x, y, z] of marked(make, seed, CONE).marks) {
        expect(z).toBe(25);
        // Its middle's angle off the round.
        angles.push((offAxis([x, y, z], FROM, DIR).angle * 180) / Math.PI);
        expect(inCone([x, y, z], FROM, DIR, 25)).toBe(true);
        // All of its near face beyond 15° of the round's line: a ray at least that far out marked it.
        if (Math.hypot(gap(FROM[0], x), gap(FROM[1], y)) > 15 * tanDeg(15)) beyond++;
      }
    }
    expect(angles.length).toBeGreaterThan(20 * 8);
    angles.sort((a, b) => a - b);
    expect(angles[Math.floor(angles.length / 2)]).toBeLessThan(12);
    expect(beyond).toBeGreaterThan(0);
  });

  it("the falling rays never change the cone's marks: the same seed with fallRays 0 marks a subset of what it marks with 10", () => {
    // A wall of mud 1.4 m behind a head 1.65 m above sod: the cone marks the wall, the falling rays the ground.
    const make = () => open(25);
    expect(T.fallRays).toBe(10);
    for (const seed of SEEDS) {
      const cone = marked(make, seed, CONE, HEAD).marks;
      const both = marked(make, seed, T, HEAD).marks;
      expect(cone.length).toBeGreaterThan(0);
      for (const mark of cone) expect(both).toContainEqual(mark);
      expect(both.length).toBeGreaterThan(cone.length);
    }
  });

  it('a fractional seed marks as its floor; a NaN seed, or a zero direction, marks nothing', () => {
    // A wall behind the head and the sod under it, its first brick among it: wherever a ray went, it would mark.
    const make = () => open(25);
    for (const [fraction, floor] of [[3.7, 3], [-2.5, -3], [8.000001, 8], [2 ** 40 + 0.5, 2 ** 40]]) {
      const a = marked(make, fraction, T, HEAD);
      expect(a.n, `${fraction}`).toBeGreaterThan(0);
      expect(a, `${fraction}`).toEqual(marked(make, floor, T, HEAD));
    }
    /** What a spatter does to a fresh world: how many it says it marked, and how many bricks it dirtied. */
    const done = (seed: number, dir: readonly number[], from: readonly number[] = HEAD) => {
      const map = make();
      return [spatter(map, from, dir, seed, T), map.takeDirty().length];
    };
    for (const seed of [NaN, Infinity, -Infinity]) expect(done(seed, DIR), `${seed}`).toEqual([0, 0]);
    // A zero direction, or one not finite.
    for (const dir of [[0, 0, 0], [-0, 0, -0], [NaN, 0, 1], [0, 0, Infinity], [Infinity, -Infinity, 0]]) expect(done(1, dir), `${dir}`).toEqual([0, 0]);
    // Nor from nowhere.
    expect(done(1, DIR, [NaN, 32.5, 10.61])).toEqual([0, 0]);
    // A direction's length is no matter, however small or large.
    const unitMarks = marked(make, 5, T, HEAD, DIR);
    for (const scale of [1e-200, 3, 1e300]) expect(marked(make, 5, T, HEAD, [0, 0, scale]), `${scale}`).toEqual(unitMarks);
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

  it('every earth takes a blood shade of its own rules: a spattered voxel is still what the shovel digs, a collapse slumps and a round chips, at the same hardness', () => {
    // A parados's or a crater rim's spoil, the ground 4 m down, and sandbags, in stripes. Sod and mud
    // take BLOOD_SOIL, whose rules are theirs; clay, subsoil and spoil (dry or not), their own.
    const soils = [P.SOD, P.MUD, P.CLAY, P.SUBSOIL, P.SPOIL, P.SPOIL_DRY, P.SANDBAG];
    const shade: Record<number, number> = {
      [P.SOD]: P.BLOOD_SOIL, [P.MUD]: P.BLOOD_SOIL, [P.CLAY]: P.BLOOD_CLAY, [P.SUBSOIL]: P.BLOOD_SUBSOIL,
      [P.SPOIL]: P.BLOOD_SPOIL, [P.SPOIL_DRY]: P.BLOOD_SPOIL, [P.SANDBAG]: P.BLOOD_SANDBAG,
    };
    const make = () => wall(25, 40, (x) => soils[x % soils.length]);
    const taken = new Set<number>();
    for (const seed of SEEDS) {
      const { n, marks } = marked(make, seed);
      expect(n).toBe(marks.length);
      expect(n).toBeGreaterThan(0);
      for (const [, , z, was, now] of marks) {
        const name = PALETTE[was].name;
        expect(now, name).toBe(shade[was]);
        // On the wall's face.
        expect(z, name).toBe(25);
        taken.add(was);
        // The shovel digs what is loose (combat/entrenching.ts), and a collapse slumps it (world/destruction.ts).
        expect([isSolid(now), isOpaque(now), isGranular(now), isLoose(now)], name).toEqual([isSolid(was), isOpaque(was), isGranular(was), isLoose(was)]);
        expect(spoilOf(now), name).toBe(spoilOf(was));
        expect(hardness(now), name).toBe(hardness(was));
      }
    }
    expect(taken).toEqual(new Set(soils));
  });

  it('a spoil berm 1 m behind a head takes BLOOD_SPOIL, which stays loose; clay takes BLOOD_CLAY at clay hardness', () => {
    const CHIP = tun.f('destruction.chip_energy_j');
    // A berm of spoil 2.4 m high on the sod, its face 1 m behind the head: steeper than spoil stands.
    const berm = () => {
      const map = open();
      map.fillBox(16, 16, 20, 48, 40, 32, P.SPOIL);
      map.takeDirty();
      return map;
    };
    const all: Box = { x0: 0, y0: 0, z0: 0, x1: N, y1: N, z1: N };
    let spoiled = 0;
    for (const seed of SEEDS.slice(0, 2)) {
      const clean = berm();
      const map = berm();
      spatter(map, HEAD, DIR, seed, T);
      const marks = changed(clean, map).filter(([, , , was]) => was === P.SPOIL);
      expect(marks.length).toBeGreaterThan(0);
      for (const [x, y, z, , now] of marks) {
        expect(now).toBe(P.BLOOD_SPOIL);
        expect([kindOf(now), isLoose(now), isGranular(now), hardness(now)]).toEqual([K.SPOIL, true, true, hardness(P.SPOIL)]);
        // A round leaves it as it leaves spoil.
        expect(chip(map, x, y, z, 1e6, CHIP)).toBe(false);
        expect(map.get(x, y, z)).toBe(P.BLOOD_SPOIL);
      }
      spoiled += marks.length;
      // A collapse slumps the bloodied berm as it slumps the clean one: only colour differs (sod's
      // BLOOD_SOIL is mud's, whose rules are sod's), and the blood slumps with the spoil it is on.
      expect(collapseRegion(clean, all)).toBeGreaterThan(0);
      collapseRegion(map, all);
      const rules = (p: number) => [isSolid(p), isOpaque(p), isGranular(p), isLoose(p), hardness(p), spoilOf(p)].join();
      const after = changed(clean, map);
      expect(after.filter(([, , , was, now]) => rules(was) !== rules(now))).toEqual([]);
      const bloodied = after.filter(([, , , , now]) => now === P.BLOOD_SPOIL);
      expect(bloodied.length).toBe(marks.length);
      expect(bloodied.some(([x, y, z]) => !marks.some((m) => m[0] === x && m[1] === y && m[2] === z))).toBe(true);
    }
    expect(spoiled).toBeGreaterThan(0);
    // Clay, as a trench's rear wall is below 1.5 m: its own shade, of clay's kind.
    let clayed = 0;
    for (const seed of SEEDS) {
      for (const [, , z, was, now] of marked(() => wall(20, 40, P.CLAY), seed).marks) {
        expect([z, was, now]).toEqual([20, P.CLAY, P.BLOOD_CLAY]);
        clayed++;
      }
    }
    expect(clayed).toBeGreaterThan(0);
    expect([kindOf(P.BLOOD_CLAY), hardness(P.BLOOD_CLAY)]).toEqual([K.CLAY, hardness(P.CLAY)]);
    // A round chips bloodied clay at clay's energy, as clean: one between mud's and clay's chips
    // bloodied mud to spoil but leaves either clay alone; one past clay's chips both.
    const chipped = (p: number, energyJ: number) => {
      const map = new BrickMap({ x: 32, y: 32, z: 32 });
      map.set(4, 4, 4, p);
      return chip(map, 4, 4, 4, energyJ, CHIP) ? map.get(4, 4, 4) : null;
    };
    const between = (CHIP * (hardness(P.MUD) + hardness(P.CLAY))) / 2;
    expect([P.BLOOD_SOIL, P.CLAY, P.BLOOD_CLAY].map((p) => chipped(p, between))).toEqual([P.SPOIL, null, null]);
    expect([P.CLAY, P.BLOOD_CLAY].map((p) => chipped(p, CHIP * hardness(P.CLAY) * 1.01))).toEqual([P.SPOIL, P.SPOIL]);
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
    const make = () => open(25);
    const keys = SEEDS.map((seed) => {
      const a = marked(make, seed, T, HEAD);
      const b = marked(make, seed, T, HEAD);
      expect(b).toEqual(a);
      return JSON.stringify(a.marks);
    });
    // And another seed others: no two of the eight alike.
    expect(new Set(keys).size).toBe(SEEDS.length);
  });
});
