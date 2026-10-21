import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { lanternVoxel } from '../../src/world/generation/furniture';
import { lightBuffer, sceneLights } from '../../src/render/lights';

const tun = loadTunables();
const p = genParams(tun);
const plan = planWorld(p, 7);
const v = p.voxel;

describe('the scene\'s lights', () => {
  const lights = sceneLights(plan, tun);
  const lanterns = lights.filter((l) => l.kind === 'lantern');
  const flares = lights.filter((l) => l.kind === 'flare');
  it('hang one lantern in each dugout, one voxel out from its glass', () => {
    const dugouts = plan.lines.flatMap((l) => l.dugouts);
    expect(lanterns).toHaveLength(dugouts.length);
    dugouts.forEach((d, i) => {
      const at = lanterns[i].position.map((m) => m / v - 0.5);
      for (let k = 0; k < 3; k++) {
        expect(at[k]).toBeGreaterThanOrEqual(d.lo[k]);
        expect(at[k]).toBeLessThan(d.hi[k]);
      }
      const glass = lanternVoxel(d, p);
      const away = at.reduce((sum, c, k) => sum + Math.abs(c - glass[k]), 0);
      expect(away).toBeCloseTo(1, 9);
    });
  });
  it('hangs the same flares over no man\'s land for the same seed', () => {
    expect(flares).toHaveLength(tun.i('render.flares'));
    expect(sceneLights(plan, tun).filter((l) => l.kind === 'flare')).toEqual(flares);
    for (const f of flares) {
      expect(f.position[2]).toBeGreaterThanOrEqual(p.layout.front * v + 4);
      expect(f.position[2]).toBeLessThanOrEqual(p.layout.enemyFront * v - 4);
      expect(f.position[1]).toBeGreaterThanOrEqual(tun.f('world.ground_level_m') + 18);
    }
  });
  it('stays within the 64 lights a frame can sample', () => {
    expect(lights.length).toBeLessThanOrEqual(64);
  });
  it('dims the flares with the time of day and leaves the lanterns lit', () => {
    const data = lightBuffer(lights, 0.25, v);
    lights.forEach((l, i) => {
      expect(data[i * 8 + 7]).toBeCloseTo(l.kind === 'flare' ? l.intensity * 0.25 : l.intensity, 5);
      expect(data[i * 8]).toBeCloseTo(l.position[0] / v, 3);
      expect(data[i * 8 + 3]).toBeCloseTo(l.radius / v, 3);
    });
  });
});
