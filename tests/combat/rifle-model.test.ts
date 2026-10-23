import { describe, expect, it } from 'vitest';
import { rifleModel, traceRifle, type RifleModel } from '../../src/combat/rifle-model';
import { Rng } from '../../src/core/rng';
import { P } from '../../src/world/materials';

// The rifle at 1.5 cm: an AK-74's silhouette in the reference mesh's proportions (the butt at
// z −0.26 m, the muzzle at 0.72 m, the receiver's rear on the bore at the origin).
const m = rifleModel();

/** The palette id at model metres (x right, y up, z forward); 0 outside the grid. */
function at(x: number, y: number, z: number): number {
  const i = Math.floor(x / m.voxelM + m.origin[0]);
  const j = Math.floor(y / m.voxelM + m.origin[1]);
  const k = Math.floor(z / m.voxelM + m.origin[2]);
  if (i < 0 || j < 0 || k < 0 || i >= m.dims[0] || j >= m.dims[1] || k >= m.dims[2]) return 0;
  return m.voxels[i + m.dims[0] * (j + m.dims[1] * k)];
}

/** The voxels of `palette` whose centres lie within a box of model metres, and their mean centre. */
function within(palette: number, lo: readonly number[], hi: readonly number[]): { n: number; mean: [number, number, number] } {
  let n = 0;
  const sum = [0, 0, 0];
  for (let k = 0; k < m.dims[2]; k++)
    for (let j = 0; j < m.dims[1]; j++)
      for (let i = 0; i < m.dims[0]; i++) {
        if (m.voxels[i + m.dims[0] * (j + m.dims[1] * k)] !== palette) continue;
        const c = [(i + 0.5 - m.origin[0]) * m.voxelM, (j + 0.5 - m.origin[1]) * m.voxelM, (k + 0.5 - m.origin[2]) * m.voxelM];
        if (c.every((v, a) => v >= lo[a] && v <= hi[a])) {
          n++;
          for (let a = 0; a < 3; a++) sum[a] += c[a];
        }
      }
  return { n, mean: [sum[0] / n, sum[1] / n, sum[2] / n] };
}

/** The first voxel a ray enters, by testing every one: the ground truth for the walk. */
function firstBySlabs(model: RifleModel, o: readonly number[], d: readonly number[]): { t: number; palette: number } | null {
  let best: { t: number; palette: number } | null = null;
  for (let k = 0; k < model.dims[2]; k++)
    for (let j = 0; j < model.dims[1]; j++)
      for (let i = 0; i < model.dims[0]; i++) {
        const palette = model.voxels[i + model.dims[0] * (j + model.dims[1] * k)];
        if (palette === 0) continue;
        const lo = [(i - model.origin[0]) * model.voxelM, (j - model.origin[1]) * model.voxelM, (k - model.origin[2]) * model.voxelM];
        let near = -Infinity;
        let far = Infinity;
        for (let a = 0; a < 3; a++) {
          if (d[a] === 0) {
            if (o[a] < lo[a] || o[a] > lo[a] + model.voxelM) near = Infinity;
            continue;
          }
          const t0 = (lo[a] - o[a]) / d[a];
          const t1 = (lo[a] + model.voxelM - o[a]) / d[a];
          near = Math.max(near, Math.min(t0, t1));
          far = Math.min(far, Math.max(t0, t1));
        }
        if (near > far || far < 0) continue;
        const t = Math.max(near, 0);
        if (!best || t < best.t) best = { t, palette };
      }
  return best;
}

describe('the rifle', () => {
  it('reads as one: receiver, dust cover, curved magazine, barrel and brake, handguard, stock, grip and sights', () => {
    expect(m.voxelM).toBe(0.015);
    expect(m.dims[0]).toBeLessThanOrEqual(8);
    expect(m.dims[1]).toBeLessThanOrEqual(20);
    expect(m.dims[2]).toBeLessThanOrEqual(70);
    expect(within(P.RIFLE_STEEL, [-0.02, -0.025, 0.02], [0.02, 0.025, 0.32]).n).toBeGreaterThan(50); // receiver
    expect(within(P.RIFLE_STEEL, [-0.016, 0.031, 0.05], [0.016, 0.046, 0.29]).n).toBeGreaterThan(10); // dust cover
    expect(within(P.RIFLE_STEEL, [-0.005, 0.046, 0.3], [0.005, 0.06, 0.34]).n).toBeGreaterThan(0); // rear sight
    expect(within(P.RIFLE_STEEL, [-0.005, -0.005, 0.53], [0.005, 0.005, 0.59]).n).toBeGreaterThan(2); // the bare barrel
    expect(within(P.RIFLE_STEEL_WORN, [-0.016, -0.016, 0.665], [0.016, 0.016, 0.72]).n).toBeGreaterThan(5); // brake
    expect(within(P.RIFLE_STEEL_WORN, [-0.005, 0.02, 0.6], [0.005, 0.06, 0.63]).n).toBeGreaterThan(1); // front post
    expect(within(P.RIFLE_FURNITURE, [-0.02, -0.025, 0.36], [0.02, 0.0, 0.5]).n).toBeGreaterThan(20); // handguard
    expect(within(P.RIFLE_FURNITURE, [-0.02, -0.08, -0.25], [0.02, 0.01, -0.01]).n).toBeGreaterThan(60); // stock
    expect(within(P.RIFLE_GRIP, [-0.02, -0.12, -0.03], [0.02, -0.035, 0.07]).n).toBeGreaterThan(10); // grip
    // The magazine hangs from the receiver and curves forward as it goes down.
    const top = within(P.RIFLE_MAG, [-1, -0.07, -1], [1, -0.03, 1]);
    const bottom = within(P.RIFLE_MAG, [-1, -0.22, -1], [1, -0.17, 1]);
    expect(top.n).toBeGreaterThan(10);
    expect(bottom.n).toBeGreaterThan(10);
    expect(bottom.mean[2]).toBeGreaterThan(top.mean[2] + 0.04);
  });

  it("the muzzle is the brake's front face and the port is on the receiver's right", () => {
    expect(m.muzzle[0]).toBe(0);
    expect(m.muzzle[1]).toBe(0);
    expect(m.muzzle[2]).toBeCloseTo(0.72, 12);
    expect(at(0, 0, m.muzzle[2] - 0.005)).toBe(P.RIFLE_STEEL_WORN);
    expect(at(0, 0, m.muzzle[2] + 0.005)).toBe(0);
    expect(m.port[0]).toBeCloseTo(0.0225, 12);
    expect(at(m.port[0] - 0.005, m.port[1], m.port[2])).toBe(P.RIFLE_STEEL);
    expect(at(m.port[0] + 0.005, m.port[1], m.port[2])).toBe(0);
    // Over the magazine.
    expect(m.port[2]).toBeGreaterThan(0.1);
    expect(m.port[2]).toBeLessThan(0.22);
  });

  it('traceRifle finds the first voxel a ray enters, and the face it comes in by', () => {
    const rng = Rng.root(3).derive('rays');
    let hits = 0;
    for (let n = 0; n < 200; n++) {
      const target = [rng.uniform(-0.03, 0.03), rng.uniform(-0.2, 0.05), rng.uniform(-0.25, 0.7)];
      const from = [target[0] + rng.uniform(-1, 1), target[1] + rng.uniform(-1, 1), target[2] + rng.uniform(-1, 1)];
      const len = Math.hypot(target[0] - from[0], target[1] - from[1], target[2] - from[2]);
      const d = [(target[0] - from[0]) / len, (target[1] - from[1]) / len, (target[2] - from[2]) / len];
      const got = traceRifle(m, from, d);
      const want = firstBySlabs(m, from, d);
      if (want === null) {
        expect(got).toBeNull();
        continue;
      }
      hits++;
      expect(got).not.toBeNull();
      expect(got!.t).toBeCloseTo(want.t, 9);
      expect(got!.palette).toBe(want.palette);
      // The face it entered faces the ray.
      expect(got!.normal[0] * d[0] + got!.normal[1] * d[1] + got!.normal[2] * d[2]).toBeLessThan(0);
      expect(Math.abs(got!.normal[0]) + Math.abs(got!.normal[1]) + Math.abs(got!.normal[2])).toBe(1);
    }
    expect(hits).toBeGreaterThan(50);
  });
});
