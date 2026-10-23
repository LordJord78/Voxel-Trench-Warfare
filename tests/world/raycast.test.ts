import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { isSolid, P } from '../../src/world/materials';
import { raycast } from '../../src/world/raycast';
import { SYNTHETIC, syntheticWorld } from '../support/synthetic';
import { traceRef, type Vec3 } from '../support/trace-ref';

/** The synthetic world with what a round passes through (water, wire) turned to air, so every voxel traceRef stops at is one a round stops at. */
function solidOnly(): BrickMap {
  const map = syntheticWorld(4);
  for (let z = 0; z < SYNTHETIC.z; z++) {
    for (let y = 0; y < SYNTHETIC.y; y++) {
      for (let x = 0; x < SYNTHETIC.x; x++) {
        const p = map.get(x, y, z);
        if (p !== 0 && !isSolid(p)) map.set(x, y, z, P.AIR);
      }
    }
  }
  return map;
}

function unit(v: [number, number, number]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A row along +z from (5.5, 5.5, 0.5): water at z 10–19, wire at 25, cloth at 30, clay at 40. */
function row(): BrickMap {
  const map = new BrickMap({ x: 32, y: 32, z: 64 });
  map.fillBox(0, 0, 10, 32, 32, 20, P.WATER);
  map.fillBox(0, 0, 25, 32, 32, 26, P.WIRE);
  map.fillBox(0, 0, 30, 32, 32, 31, P.CLOTH);
  map.fillBox(0, 0, 40, 32, 32, 44, P.CLAY);
  return map;
}

describe('the CPU raycast', () => {
  it('finds what traceRef finds, in a world with nothing it lets through', () => {
    const map = solidOnly();
    const rng = Rng.root(3).derive('raycast');
    const { x: X, y: Y, z: Z } = SYNTHETIC;
    const f = Math.fround;
    const sphere = (): [number, number, number] => {
      const u = rng.uniform(-1, 1);
      const phi = rng.uniform(0, 2 * Math.PI);
      const s = Math.sqrt(1 - u * u);
      return [s * Math.cos(phi), u, s * Math.sin(phi)];
    };
    const axes: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let compared = 0;
    let hits = 0;
    const wrong: string[] = [];
    while (compared < 4000) {
      const r = rng.float();
      let o: [number, number, number];
      let d: Vec3;
      if (r < 0.5) {
        o = [rng.uniform(1, X - 1), rng.uniform(42, Y - 2), rng.uniform(1, Z - 1)];
        d = unit(sphere());
      } else if (r < 0.7) {
        o = [rng.uniform(0, X), rng.uniform(42, Y - 1), rng.uniform(0, Z)];
        d = rng.choice(axes);
      } else if (r < 0.85) {
        o = [rng.uniform(-60, -1), rng.uniform(40, Y), rng.uniform(0, Z)];
        const target: [number, number, number] = [rng.uniform(0, X), rng.uniform(30, 60), rng.uniform(0, Z)];
        d = unit([target[0] - o[0], target[1] - o[1], target[2] - o[2]]);
      } else {
        const a = rng.uniform(0, 2 * Math.PI);
        o = [rng.uniform(1, X - 1), rng.uniform(45, 55), rng.uniform(1, Z - 1)];
        d = unit([Math.cos(a), rng.uniform(-0.05, 0.05), Math.sin(a)]);
      }
      const of: Vec3 = [f(o[0]), f(o[1]), f(o[2])];
      const df: Vec3 = [f(d[0]), f(d[1]), f(d[2])];
      // Rays start in air: one starting inside a voxel has its own test.
      const inside = of.every((v, k) => v >= 0 && v < [X, Y, Z][k]);
      if (inside && map.get(Math.floor(of[0]), Math.floor(of[1]), Math.floor(of[2])) !== 0) continue;
      compared++;
      const ref = traceRef(map, of, df, 1e6);
      const got = raycast(map, of, df, 1e6);
      const same =
        ref.hit === (got !== null) &&
        (!got || (got.cell.every((c, k) => c === ref.cell[k]) && got.face === ref.face && got.material === ref.mat && Math.abs(got.t - ref.t) <= 1e-9 * Math.max(1, ref.t)));
      if (got) hits++;
      if (!same && wrong.length < 8) wrong.push(`o ${of.map((v) => v.toFixed(3))} d ${df.map((v) => v.toFixed(4))}: got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
    }
    expect(wrong).toEqual([]);
    // Enough of them hit for the comparison to mean something.
    expect(hits).toBeGreaterThan(1000);
  });

  it('lets water, wire and cloth through, and stops at the first solid voxel past them', () => {
    expect(raycast(row(), [5.5, 5.5, 0.5], [0, 0, 1], 1000)).toEqual({ t: 39.5, cell: [5, 5, 40], face: 4, material: P.CLAY });
  });

  it('starting inside a solid voxel is a hit at t 0 with no face', () => {
    expect(raycast(row(), [5.5, 5.5, 40.5], [0, 0, 1], 1000)).toEqual({ t: 0, cell: [5, 5, 40], face: -1, material: P.CLAY });
  });

  it('misses past maxT, and outside the world', () => {
    expect(raycast(row(), [5.5, 5.5, 0.5], [0, 0, 1], 39)).toBeNull();
    expect(raycast(row(), [-5, 5.5, 5.5], [-1, 0, 0], 1000)).toBeNull();
    const map = new BrickMap({ x: 32, y: 32, z: 32 });
    map.fillBox(8, 0, 0, 9, 32, 32, P.TIMBER);
    expect(raycast(map, [-5, 5.5, 5.5], [1, 0, 0], 1000)).toEqual({ t: 13, cell: [8, 5, 5], face: 0, material: P.TIMBER });
  });

  it('steps across empty bricks quickly, without reading their voxels', () => {
    const map = new BrickMap({ x: 512, y: 64, z: 512 });
    map.fillBox(0, 0, 0, 512, 4, 512, P.SUBSOIL);
    const rng = Rng.root(5).derive('skim');
    const rays: [Vec3, Vec3][] = [];
    for (let k = 0; k < 2000; k++) {
      const e = (rng.uniform(0.5, 5) * Math.PI) / 180;
      const a = rng.uniform(0, 2 * Math.PI);
      rays.push([[rng.uniform(56, 456), 4 + rng.uniform(1, 10), rng.uniform(56, 456)], [Math.cos(e) * Math.cos(a), -Math.sin(e), Math.cos(e) * Math.sin(a)]]);
    }
    const t0 = performance.now();
    let hits = 0;
    for (const [o, d] of rays) if (raycast(map, o, d, 400)) hits++;
    const ms = performance.now() - t0;
    expect(hits).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });
});
