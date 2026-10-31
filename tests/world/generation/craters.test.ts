import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { CraterField, craterSurface, planCraters } from '../../../src/world/generation/craters';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));
const fronts = [{ z: p.layout.front, facing: 1 as const }, { z: p.layout.enemyFront, facing: -1 as const }];

describe('craters', () => {
  it('plans the configured counts, in bounds and within radius limits', () => {
    const c = planCraters(p, t, Rng.root(7).derive('craters'), fronts);
    expect(c.open).toHaveLength(p.craters.nml + p.craters.rear);
    expect(c.direct).toHaveLength(2 * p.craters.directPerLine);
    for (const k of c.open) {
      expect(k.r).toBeGreaterThanOrEqual(p.craters.radiusMin);
      expect(k.r).toBeLessThanOrEqual(p.craters.radiusCap);
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThan(p.dims.x);
    }
    const nml = c.open.slice(0, p.craters.nml);
    expect(nml.every((k) => k.z > p.layout.front && k.z < p.layout.enemyFront)).toBe(true);
  });
  it('digs a bowl 0.75 r deep with a gentle spoil rim', () => {
    const f = new CraterField([{ x: 100, z: 100, r: 20 }]);
    expect(craterSurface(f, 160, 100, 100)).toBe(145);
    expect(craterSurface(f, 160, 120, 100)).toBe(160);
    expect(craterSurface(f, 160, 124, 100)).toBe(162);
    expect(craterSurface(f, 160, 140, 100)).toBe(160);
    for (let x = 120; x < 135; x++) {
      expect(Math.abs(craterSurface(f, 160, x + 1, 100) - craterSurface(f, 160, x, 100))).toBeLessThanOrEqual(1);
    }
  });
  it('plans ragged craters: lobed bowls, rims heaped to one side, as gentle as round ones', () => {
    const c = planCraters(p, t, Rng.root(7).derive('craters'), fronts);
    expect(c.open.every((k) => k.ragged === 1)).toBe(true);
    const f = new CraterField([{ x: 200, z: 200, r: 30, ragged: 1 }]);
    // How far the bowl reaches along each of 16 directions: not one radius.
    const reach: number[] = [];
    for (let k = 0; k < 16; k++) {
      const [ux, uz] = [Math.cos((k * Math.PI) / 8), Math.sin((k * Math.PI) / 8)];
      let d = 0;
      while (craterSurface(f, 160, Math.round(200 + ux * d), Math.round(200 + uz * d)) < 160 && d < 60) d++;
      reach.push(d);
    }
    expect(Math.max(...reach) - Math.min(...reach)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...reach)).toBeLessThanOrEqual(Math.ceil(30 * 1.16) + 1);
    // Nowhere a step of more than a voxel between neighbours, along x or z.
    for (let x = 150; x < 250; x++) {
      for (let z = 150; z < 250; z++) {
        const h = craterSurface(f, 160, x, z);
        expect(Math.abs(craterSurface(f, 160, x + 1, z) - h)).toBeLessThanOrEqual(2);
        expect(Math.abs(craterSurface(f, 160, x, z + 1) - h)).toBeLessThanOrEqual(2);
      }
    }
  });
  it('lets a later bowl cut an earlier rim', () => {
    const f = new CraterField([{ x: 100, z: 100, r: 20 }, { x: 125, z: 100, r: 10 }]);
    expect(craterSurface(f, 160, 125, 100)).toBe(153);
  });
});
