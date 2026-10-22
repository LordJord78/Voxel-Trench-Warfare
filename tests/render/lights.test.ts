import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { lanternVoxel } from '../../src/world/generation/furniture';
import { lightBuffer, MAX_LIGHTS, sceneLights, type SceneLight } from '../../src/render/lights';

const tun = loadTunables();
const p = genParams(tun);
const plan = planWorld(p, 7);
const v = p.voxel;

describe('the scene\'s lights', () => {
  const lights = sceneLights(plan, tun);
  const lanterns = lights.filter((l) => l.kind === 'lantern');
  const flares = lights.filter((l) => l.kind === 'flare');
  it('hang one lantern in each dugout, its flame a voxel into the chamber from its glass, 15 cm off the wall', () => {
    const dugouts = plan.lines.flatMap((l) => l.dugouts);
    expect(lanterns).toHaveLength(dugouts.length);
    const inside = (d: (typeof dugouts)[number], c: number[]) => c[0] >= d.lo[0] && c[0] < d.hi[0] && c[2] >= d.lo[2] && c[2] < d.hi[2];
    dugouts.forEach((d, i) => {
      const glass = lanternVoxel(d, p);
      // The voxel the flame stands in the middle of, and the step to it from the glass.
      const flame = lanterns[i].position.map((m) => m / v - 0.5);
      const step = flame.map((c, k) => c - glass[k]);
      expect(Math.abs(step[0]) + Math.abs(step[2])).toBeCloseTo(1, 9);
      expect(step[1]).toBeCloseTo(0, 9);
      // In the chamber's air; behind the glass, the wall it hangs on.
      expect(inside(d, flame.map(Math.round))).toBe(true);
      expect(inside(d, glass.map((c, k) => c - Math.round(step[k])))).toBe(false);
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
  it('takes as many as 1,024 lights a frame, and gives each a phase of its own', () => {
    expect(MAX_LIGHTS).toBe(1024);
    expect(lights.length).toBeLessThanOrEqual(MAX_LIGHTS);
    for (const l of lights) {
      expect(l.phase).toBeGreaterThanOrEqual(0);
      expect(l.phase).toBeLessThan(1);
    }
    expect(new Set(lights.map((l) => l.phase)).size).toBe(lights.length);
  });
  it('packs as many as 1,024 lights for the GPU, and refuses one more', () => {
    expect(lightBuffer(Array<SceneLight>(MAX_LIGHTS).fill(lights[0]), 1, v)).toHaveLength(MAX_LIGHTS * 8);
    expect(() => lightBuffer(Array<SceneLight>(MAX_LIGHTS + 1).fill(lights[0]), 1, v)).toThrow(RangeError);
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
