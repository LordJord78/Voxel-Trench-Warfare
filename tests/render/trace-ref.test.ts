import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { syntheticWorld } from '../support/synthetic';
import { traceRef } from '../support/trace-ref';

type V3 = [number, number, number];

/** The first non-air cell along a ray, found by tiny steps: slow and obviously right, away from ties. */
function march(map: BrickMap, ro: V3, rd: V3, tMax: number): { cell: V3; t: number } | null {
  const step = 1 / 64;
  for (let t = 0; t < tMax; t += step) {
    const c: V3 = [Math.floor(ro[0] + rd[0] * t), Math.floor(ro[1] + rd[1] * t), Math.floor(ro[2] + rd[2] * t)];
    if (!map.inBounds(c[0], c[1], c[2])) continue;
    if (map.get(c[0], c[1], c[2]) !== 0) return { cell: c, t };
  }
  return null;
}

describe('the reference traversal', () => {
  it('agrees with brute-force stepping', () => {
    const map = syntheticWorld(3);
    const rng = Rng.root(3).derive('rays');
    let compared = 0;
    for (let i = 0; i < 500; i++) {
      const ro: V3 = [rng.uniform(1, 255), rng.uniform(50, 120), rng.uniform(1, 255)];
      const u = rng.uniform(-1, 1);
      const phi = rng.uniform(0, 2 * Math.PI);
      const s = Math.sqrt(1 - u * u);
      const rd: V3 = [s * Math.cos(phi), u, s * Math.sin(phi)];
      const ref = traceRef(map, ro, rd, 400);
      // A ray that only clips the corner of its hit voxel is inside it for less than a march step.
      if (ref.hit) {
        const span = Math.min(...[0, 1, 2].map((k) => (rd[k] === 0 ? Infinity : ((rd[k] > 0 ? ref.cell[k] + 1 : ref.cell[k]) - ro[k]) / rd[k])));
        if (span - ref.t < 1 / 32) continue;
      }
      const brute = march(map, ro, rd, 400);
      compared++;
      if (!brute) {
        expect(ref.hit).toBe(false);
        continue;
      }
      // Skip rays that pass within 1/32 voxel of a voxel edge on the way in: there two answers are right.
      if (Math.abs(brute.t - ref.t) > 1 / 32) {
        expect(ref.hit).toBe(true);
        expect(ref.cell).toEqual(brute.cell);
      } else if (ref.hit) {
        expect(Math.abs(ref.t - brute.t)).toBeLessThanOrEqual(1 / 32);
      }
    }
    expect(compared).toBeGreaterThan(450);
  });

  it('handles axis-parallel rays and origins on brick and sector planes', () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.set(40, 5, 5, P.BRICK);
    map.set(5, 5, 40, P.TIMBER);
    map.set(5, 2, 5, P.SOD);
    const along = traceRef(map, [32, 5.5, 5.5], [1, 0, 0], 100);
    expect(along).toMatchObject({ hit: true, cell: [40, 5, 5], face: 0, mat: P.BRICK });
    expect(along.t).toBeCloseTo(8, 12);
    const back = traceRef(map, [63.5, 5.5, 5.5], [-1, 0, 0], 100);
    expect(back).toMatchObject({ hit: true, cell: [40, 5, 5], face: 1 });
    const deep = traceRef(map, [5.5, 5.5, 8], [0, 0, 1], 100);
    expect(deep).toMatchObject({ hit: true, cell: [5, 5, 40], face: 4, mat: P.TIMBER });
    const down = traceRef(map, [5.5, 40, 5.5], [0, -1, 0], 100);
    expect(down).toMatchObject({ hit: true, cell: [5, 2, 5], face: 3 });
    expect(down.t).toBeCloseTo(37, 12);
    // From outside the volume: enters through the top face.
    const above = traceRef(map, [5.5, 80, 5.5], [0, -1, 0], 200);
    expect(above).toMatchObject({ hit: true, cell: [5, 2, 5], face: 3 });
    // Parallel to a face and outside the volume: never enters.
    expect(traceRef(map, [5.5, 70, 5.5], [1, 0, 0], 200).hit).toBe(false);
    // Leaving through the side without hitting anything.
    expect(traceRef(map, [10.5, 30.5, 10.5], [0, 0, -1], 200).hit).toBe(false);
  });
});
