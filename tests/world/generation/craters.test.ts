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
  it('lets a later bowl cut an earlier rim', () => {
    const f = new CraterField([{ x: 100, z: 100, r: 20 }, { x: 125, z: 100, r: 10 }]);
    expect(craterSurface(f, 160, 125, 100)).toBe(153);
  });
});
