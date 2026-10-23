import { describe, expect, it } from 'vitest';
import { ballisticsTunables, projectileSpec, Rounds } from '../../src/combat/ballistics';
import { Front, frontTunables, lineSource, planSource } from '../../src/combat/front';
import { segmentDistance } from '../../src/combat/suppression';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import type { WorldPlan } from '../../src/world/generation/plan';

const TICK = 1 / 60;
const tun = loadTunables();
const T = frontTunables(tun);
const SPEC = projectileSpec(tun, 'assault_rifle');
const TARGET: [number, number, number] = [12.8, 2, 5];

/** A field the front's rounds cross and leave quickly. */
const field = () => new Rounds(ballisticsTunables(tun), new BrickMap({ x: 256, y: 64, z: 512 }), 0.1);

/** `seconds` of the front at `intensity` from a line 38 m off: the ticks it fired on, and how many each. */
function run(intensity: 'off' | 'light' | 'heavy', seconds: number, seed = 7) {
  const front = new Front(T, lineSource(38, 0.4), Rng.root(seed).derive('front'));
  front.intensity = intensity;
  const rounds = field();
  const fired: [number, number][] = [];
  for (let k = 0; k < Math.round(seconds / TICK); k++) {
    const n = front.tick(TICK, TARGET, rounds, SPEC);
    if (n > 0) fired.push([k, n]);
    rounds.step(TICK);
  }
  return fired;
}

describe('the front', () => {
  it('reads [front]', () => {
    expect(T).toEqual({ lightRpm: 40, heavyRpm: 500, burstRounds: 8, burstRpm: 600, tracerEvery: 5, spreadM: 1.6, reachM: 30 });
  });

  it('is off unless asked for', () => {
    expect(run('off', 10)).toEqual([]);
  });

  it('light fires 40 a minute, heavy 500 in bursts of 8 at 600', () => {
    const count = (f: [number, number][]) => f.reduce((a, [, n]) => a + n, 0);
    expect(Math.abs(count(run('light', 60)) / 40 - 1)).toBeLessThanOrEqual(0.1);
    const heavy = run('heavy', 60);
    expect(Math.abs(count(heavy) / 500 - 1)).toBeLessThanOrEqual(0.1);
    // Within a burst, 6 ticks apart (600 a minute); between bursts, longer.
    const gaps = heavy.slice(1).map(([k], i) => k - heavy[i][0]);
    expect(gaps.filter((g) => g === 6).length).toBeGreaterThan(gaps.length * 0.8);
    expect(Math.min(...gaps)).toBe(6);
  });

  it('its rounds come from the line and pass by the target', () => {
    const front = new Front(T, lineSource(38, 0.4), Rng.root(7).derive('front'));
    front.intensity = 'heavy';
    const rounds = field();
    let checked = 0;
    for (let k = 0; k < 600; k++) {
      const n = front.tick(TICK, TARGET, rounds, SPEC);
      for (let s = rounds.count - n; s < rounds.count; s++) {
        const o = rounds.position(s);
        const v = rounds.velocity(s);
        expect(Math.abs(o[0] - TARGET[0])).toBeLessThanOrEqual(20);
        expect(o[1]).toBeGreaterThanOrEqual(0.8);
        expect(o[1]).toBeLessThanOrEqual(1.6);
        expect(o[2] - TARGET[2]).toBeGreaterThanOrEqual(0.7 * 38);
        expect(o[2] - TARGET[2]).toBeLessThanOrEqual(38);
        const far = [o[0] + v[0], o[1] + v[1], o[2] + v[2]];
        expect(segmentDistance(o, far, TARGET)).toBeLessThanOrEqual(1.6 * Math.SQRT2 + 0.5);
        checked++;
      }
      rounds.step(TICK);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("fires from the enemy's bay within reach, over its crest, or holds fire", () => {
    const bay = (a0: number, a1: number) => ({ a0, a1, b0: 1000, b1: 1020, crestY: 50, longAxis: 0, facing: -1 });
    const plan = {
      params: { voxel: 0.1 },
      lines: [
        { spec: { side: 0, firingSteps: true }, bays: [bay(0, 100)] },
        { spec: { side: 1, firingSteps: true }, bays: [bay(100, 200), bay(800, 900)] },
      ],
    } as unknown as WorldPlan;
    const source = planSource(plan, 30);
    const rng = Rng.root(3).derive('front');
    for (let k = 0; k < 50; k++) {
      const o = source([16, 2, 50], rng)!;
      expect(o[0]).toBeGreaterThanOrEqual(10);
      expect(o[0]).toBeLessThanOrEqual(20);
      expect(o[2]).toBeCloseTo(100, 6);
      expect(o[1]).toBeGreaterThanOrEqual(5.4);
      expect(o[1]).toBeLessThanOrEqual(6.2);
    }
    expect(source([120, 2, 50], rng)).toBeNull();
  });

  it('is deterministic', () => {
    expect(run('heavy', 5, 7)).toEqual(run('heavy', 5, 7));
  });
});
