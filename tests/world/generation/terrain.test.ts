import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { fbm, valueNoise } from '../../../src/world/generation/noise';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain, ditchAt, fieldHeight, surfaceAt, swale } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));

describe('noise', () => {
  it('is continuous across lattice cells and stays in [0, 1)', () => {
    const a = valueNoise(99.999, 50, 100, 0, 3);
    const b = valueNoise(100.001, 50, 100, 0, 3);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
    for (let i = 0; i < 1000; i++) {
      const v = fbm(i * 37.1, i * 11.3, 427, 4, 0.34, 9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('terrain', () => {
  it('is a pure function of the seed', () => {
    const again = buildTerrain(p, Rng.root(7));
    expect(again).toEqual(t);
    expect(surfaceAt(t, p, 1234, 567)).toBe(surfaceAt(again, p, 1234, 567));
  });
  it('rolls within the configured relief and sags into the swale', () => {
    let lo = Infinity, hi = -Infinity;
    for (let x = 0; x < 2560; x += 40) for (let z = 0; z < 600; z += 40) {
      const h = fieldHeight(t, p, x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    expect(lo).toBeGreaterThanOrEqual(p.ground - 21);
    expect(hi).toBeLessThanOrEqual(p.ground + 21);
    const mid = (p.layout.front + p.layout.enemyFront) / 2;
    expect(swale(p, mid)).toBe(-15);
    expect(swale(p, 300)).toBe(0);
  });
  it('continues past the map edge', () => {
    const inside = fieldHeight(t, p, 2559.5, 1500);
    const outside = fieldHeight(t, p, 2560.5, 1500);
    expect(Math.abs(inside - outside)).toBeLessThan(0.5);
    expect(Number.isFinite(fieldHeight(t, p, -15000, 30000))).toBe(true);
  });
  it('cuts ditches with a lowered floor', () => {
    const d = t.ditches[0];
    const z = Math.round(d.z + d.drift * (1000 - 1280));
    expect(ditchAt(t, p, 1000, z)).toBe(true);
    expect(surfaceAt(t, p, 1000, z)).toBeLessThan(Math.floor(fieldHeight(t, p, 1000, z) + 0.5));
  });
  it('runs ditches out to nothing at the map edge, where the far field takes over', () => {
    for (const d of t.ditches) {
      for (const x of [0, p.dims.x - 1]) {
        const z = Math.trunc(d.z + d.drift * (x - p.dims.x / 2));
        const field = Math.max(p.waterTable + 2, Math.min(p.dims.y - 80, Math.floor(fieldHeight(t, p, x, z) + 0.5)));
        expect(surfaceAt(t, p, x, z)).toBe(field);
      }
    }
  });
});
