import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { lanternVoxel } from '../../src/world/generation/furniture';
import type { FireState } from '../../src/battle/director';
import { fireTunables } from '../../src/battle/fires';
import { flareTunables, type FlareState } from '../../src/battle/flares';
import { lightMotion, lightsAt } from '../../src/render/light-motion';
import { battleFireLights, battleFlareLights, lightBuffer, MAX_LIGHTS, sceneLights, type SceneLight } from '../../src/render/lights';

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
  it("a burning flare is a flare light at its glow, its id kept; one climbing or out is none", () => {
    const ft = flareTunables(tun);
    const states: FlareState[] = [
      { id: 4, position: [10, 40, 20], glow: 0.5, stage: 'burning', colour: [1, 0.25, 0.15] },
      { id: 5, position: [12, 20, 22], glow: 0, stage: 'climb', colour: [1, 0.88, 0.7] },
      { id: 7, position: [30, 35, 25], glow: 1, stage: 'burning', colour: [1, 0.88, 0.7] },
    ];
    const ls = battleFlareLights(states, ft);
    expect(ls.map((l) => l.id)).toEqual([4, 7]);
    expect(ls[0]).toMatchObject({ kind: 'flare', position: [10, 40, 20], radius: ft.radiusM, intensity: ft.intensity * 0.5, colour: [1, 0.25, 0.15] });
    expect(ls[1].intensity).toBe(ft.intensity);
  });
  it('a fire is a warm light flickering faster and harder than a lantern, by its strength', () => {
    const ft = fireTunables(tun);
    const fire = (strength: number, id = 3, size = ft.size[1]): FireState => ({ id, at: [40, 16, 30], strength, size, hamlet: false, dying: false });
    const [l] = battleFireLights([fire(1)], 0, ft);
    expect(l).toMatchObject({ kind: 'fire', position: [40, 16 + ft.liftM, 30], radius: ft.radiusM[1], colour: ft.colour, id: 3 });
    // Warm: more red than green, more green than blue.
    expect(l.colour[0]).toBeGreaterThan(l.colour[1]);
    expect(l.colour[1]).toBeGreaterThan(l.colour[2]);
    // Its reach by its size: the smallest fire's 12 m, the largest's 25.
    expect(battleFireLights([fire(1, 3, ft.size[0])], 0, ft)[0].radius).toBeCloseTo(ft.radiusM[0], 9);
    // Gone out, it is no light.
    expect(battleFireLights([fire(0)], 0, ft)).toEqual([]);
    // Ten seconds at 60 Hz of a fire's light and a lantern's, each as a share of its own away from its mean.
    const lantern = sceneLights(plan, tun).find((x) => x.kind === 'lantern')!;
    const motion = lightMotion(tun);
    const frames = Array.from({ length: 600 }, (_, k) => k / 60);
    const share = (id: number) => frames.map((s) => battleFireLights([fire(1, id)], s, ft)[0].intensity / ft.intensity - 1);
    const flame = share(3);
    const lamp = frames.map((s) => lightsAt([lantern], s, motion)[0].intensity / lantern.intensity - 1);
    const most = (xs: number[]) => Math.max(...xs.map(Math.abs));
    const crossings = (xs: number[]) => xs.slice(1).filter((x, k) => Math.sign(x) !== Math.sign(xs[k])).length;
    // Harder: it strays as far as its flicker either way, well past a lantern's most.
    expect(most(flame)).toBeLessThanOrEqual(ft.flicker + 1e-9);
    expect(most(flame)).toBeGreaterThan(2 * motion.lanternFlicker);
    // Faster: it crosses its mean more than twice as often.
    expect(crossings(flame)).toBeGreaterThan(2 * crossings(lamp));
    // By its strength: half as strong, half the light at every moment.
    for (const s of frames.slice(0, 60)) expect(battleFireLights([fire(0.5)], s, ft)[0].intensity).toBeCloseTo(0.5 * battleFireLights([fire(1)], s, ft)[0].intensity, 9);
    // Each its own: two fires flicker apart.
    const other = share(4);
    expect(Math.max(...flame.map((x, k) => Math.abs(x - other[k])))).toBeGreaterThan(0.05);
    // Not a flare: the sky's flares key leaves it lit.
    expect(lightBuffer([l], 0.25, v)[7]).toBeCloseTo(l.intensity, 4);
  });
});
