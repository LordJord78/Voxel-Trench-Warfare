import { describe, expect, it } from 'vitest';
import { ballisticsTunables, projectileSpec, Rounds } from '../../src/combat/ballistics';
import { Front, frontTunables, lineSource, planSource } from '../../src/combat/front';
import { segmentDistance } from '../../src/combat/suppression';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import { genParams } from '../../src/world/generation/params';
import { planWorld, type WorldPlan } from '../../src/world/generation/plan';

const TICK = 1 / 60;
const tun = loadTunables();
const T = frontTunables(tun);
const SPEC = projectileSpec(tun, 'assault_rifle');
const TARGET: [number, number, number] = [12.8, 2, 5];

/** A field the front's rounds cross and leave quickly. */
const field = () => new Rounds(ballisticsTunables(tun), new BrickMap({ x: 256, y: 64, z: 512 }), 0.1);

/**
 * Where a round leaving `o` at `v` (m, m/s) crosses z = `z` in flight, flown as the session flies it
 * (ticks of 1/60 s) over an empty field 32 × 32 × 256 m: its x and y there.
 */
function crossing(o: readonly number[], v: readonly number[], z: number): [number, number] {
  const r = new Rounds(ballisticsTunables(tun), new BrickMap({ x: 32, y: 32, z: 256 }), 1);
  r.fire([o[0], o[1], o[2]], [v[0], v[1], v[2]], SPEC, 1, false);
  let a = r.position(0);
  for (;;) {
    r.step(TICK);
    if (r.count === 0) throw new Error('the round was retired before it crossed');
    const b = r.position(0);
    if (b[2] <= z) {
      const u = (a[2] - z) / (a[2] - b[2]);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    a = b;
  }
}

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
    expect(T).toEqual({
      lightRpm: 40,
      lightGapS: 1.0,
      lightMissM: 2.0,
      heavyRpm: 500,
      burstRounds: 8,
      burstRpm: 600,
      tracerEvery: 1,
      spreadM: 1.6,
      spreadVertical: 0.6,
      reachM: 30,
      crestClearM: 0.3,
    });
  });

  it('light rounds are tracers as heavy ones are', () => {
    for (const intensity of ['light', 'heavy'] as const) {
      const front = new Front(T, lineSource(38, 0.4), Rng.root(3).derive('front'));
      front.intensity = intensity;
      const rounds = field();
      let fired = 0;
      for (let k = 0; k < 60 * 20 && fired < 3; k++) fired += front.tick(TICK, TARGET, rounds, SPEC);
      expect(fired, intensity).toBeGreaterThanOrEqual(3);
      // Nothing stepped: every round fired is still in the pool, each a tracer.
      expect(Array.from({ length: fired }, (_, slot) => rounds.isTracer(slot)).every(Boolean), intensity).toBe(true);
    }
  });

  it('is off unless asked for', () => {
    expect(run('off', 10)).toEqual([]);
  });

  it('light fires 40 a minute, heavy 500 in bursts of 8 at 600', () => {
    const count = (f: [number, number][]) => f.reduce((a, [, n]) => a + n, 0);
    expect(Math.abs(count(run('light', 600)) / 400 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(count(run('heavy', 600)) / 5000 - 1)).toBeLessThanOrEqual(0.05);
    const heavy = run('heavy', 60);
    // Within a burst, 6 ticks apart (600 a minute); between bursts, longer.
    const gaps = heavy.slice(1).map(([k], i) => k - heavy[i][0]);
    expect(gaps.filter((g) => g === 6).length).toBeGreaterThan(gaps.length * 0.8);
    expect(Math.min(...gaps)).toBe(6);
  });

  it('light is sporadic: never two shots within light_gap_s, the rest of each gap drawn', () => {
    const light = run('light', 600);
    const gaps = light.slice(1).map(([k], i) => (k - light[i][0]) * TICK);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(T.lightGapS - TICK);
    const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    expect(Math.abs(mean / (60 / T.lightRpm) - 1)).toBeLessThanOrEqual(0.05);
    // An exponential's spread over a 1.5 s mean less its 1.0 s floor: sd/mean 1/3.
    expect(sd / mean).toBeGreaterThan(0.25);
    expect(sd / mean).toBeLessThan(0.45);
  });

  it('heavy pauses between bursts for a drawn time, not a fixed one', () => {
    const heavy = run('heavy', 60);
    const pauses = heavy.slice(1).map(([k], i) => k - heavy[i][0]).filter((g) => g > 6);
    expect(pauses.length).toBeGreaterThan(20);
    expect(new Set(pauses).size).toBeGreaterThanOrEqual(5);
  });

  it('light passes the head no nearer than light_miss_m, nor further than spread_m past it', () => {
    const front = new Front(T, lineSource(38, 0.4), Rng.root(7).derive('front'));
    front.intensity = 'light';
    const rounds = field();
    rounds.listen(TARGET, 3.2);
    const cracks: number[] = [];
    let checked = 0;
    for (let k = 0; k < 600 / TICK; k++) {
      const n = front.tick(TICK, TARGET, rounds, SPEC);
      for (let s = rounds.count - n; s < rounds.count; s++) {
        const o = rounds.position(s);
        const v = rounds.velocity(s);
        const far = [o[0] + v[0], o[1] + v[1], o[2] + v[2]];
        const miss = segmentDistance(o, far, TARGET);
        expect(miss).toBeGreaterThanOrEqual(T.lightMissM - 0.01);
        expect(miss).toBeLessThanOrEqual(T.lightMissM + T.spreadM + 0.01);
        checked++;
      }
      rounds.step(TICK);
      cracks.push(...rounds.cracks.map((c) => c.missM));
    }
    expect(checked).toBeGreaterThan(300);
    // Flown, with the drop: still no nearer, and most of them heard.
    expect(Math.min(...cracks)).toBeGreaterThanOrEqual(T.lightMissM - 0.05);
    expect(cracks.length).toBeGreaterThan(checked / 2);
  });

  it('scatters across the line of fire, wherever along the line the bay is', () => {
    // A bay 30 m along the line at 38 m: heavy's scatter is about the head as the shooter sees it.
    const origin: [number, number, number] = [TARGET[0] + 30, 1, TARGET[2] + 38];
    for (const intensity of ['light', 'heavy'] as const) {
      const front = new Front(T, () => origin, Rng.root(5).derive('front'));
      front.intensity = intensity;
      const rounds = field();
      let widest = 0;
      for (let k = 0; k < 6000; k++) {
        const n = front.tick(TICK, TARGET, rounds, SPEC);
        for (let s = rounds.count - n; s < rounds.count; s++) {
          const v = rounds.velocity(s);
          const far = [origin[0] + v[0], origin[1] + v[1], origin[2] + v[2]];
          const miss = segmentDistance(origin, far, TARGET);
          widest = Math.max(widest, miss);
          if (intensity === 'light') expect(miss).toBeGreaterThanOrEqual(T.lightMissM - 0.01);
          else expect(miss).toBeLessThanOrEqual(Math.hypot(T.spreadM, T.spreadVertical * T.spreadM) + 0.01);
        }
        rounds.step(TICK);
      }
      // Scattered along world x instead, a third of the sideways spread would run along the line of fire.
      if (intensity === 'heavy') expect(widest).toBeGreaterThan(1.7);
    }
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

  it("fires from side 0's front line for side 0, and side 1's for side 1", () => {
    const plan = planWorld(genParams(tun), 7);
    const v = plan.params.voxel;
    const fronts = ([0, 1] as const).map((side) => plan.lines.find((l) => l.spec.side === side && l.spec.firingSteps)!);
    // Mid-field: half way along the lines, half way across no man's land.
    const target: [number, number, number] = [(plan.params.dims.x * v) / 2, plan.params.ground * v + 1.6, ((fronts[0].spec.crossBase + fronts[1].spec.crossBase) / 2) * v];
    for (const side of [0, 1] as const) {
      const bays = fronts[side].bays;
      const front = new Front(T, planSource(plan, T.reachM, side), Rng.root(9).derive('front'));
      front.intensity = 'heavy';
      const rounds = field();
      let checked = 0;
      for (let k = 0; k < 600; k++) {
        const n = front.tick(TICK, target, rounds, SPEC);
        for (let s = rounds.count - n; s < rounds.count; s++) {
          const o = rounds.position(s);
          // At the far edge of one of that line's bays (the front of its trench), over its crest.
          const from = bays.find((b) => Math.abs(o[2] - (b.facing > 0 ? b.b1 : b.b0) * v) <= 0.5 && o[1] >= b.crestY * v + 0.4 - 1e-9 && o[1] <= b.crestY * v + 1.2 + 1e-9);
          expect(from, `side ${side}: ${o.join(', ')}`).toBeDefined();
          checked++;
        }
        rounds.step(TICK);
      }
      expect(checked, `side ${side}`).toBeGreaterThan(50);
    }
    // Side 1 is the default: the enemy's line, as solo play has it.
    const rng = (seed: number) => Rng.root(seed).derive('front');
    expect(planSource(plan, T.reachM)(target, rng(4))).toEqual(planSource(plan, T.reachM, 1)(target, rng(4)));
  });

  it('at a player it cannot see, fires 0.3 m over where its sight was stopped: in flight, its fall allowed for', () => {
    // 50 m out (the Ravine's range), and 185 m (the Corridor's, its fronts at z 34 and 219.5), where a
    // round falls 0.26 m below the line it leaves on: aimed straight at the 0.3 m it would clear the
    // stop by 4 cm, through the head behind it.
    const head: [number, number, number] = [10, 1.6, 5];
    for (const z0 of [80, 215]) {
      const origin: [number, number, number] = [10, 3, z0];
      for (const intensity of ['light', 'heavy'] as const) {
        const what = `${intensity}, ${z0 - 30} m`;
        const front = new Front(T, () => [origin[0], origin[1], origin[2]], Rng.root(5).derive('front'));
        front.room = true;
        front.intensity = intensity;
        const asked: number[][][] = [];
        const sight = (from: readonly number[], to: readonly number[]): [number, number, number] => {
          asked.push([[...from], [...to]]);
          return [10, 2, 30];
        };
        const rounds = field();
        const across: number[] = [];
        for (let k = 0; k < 60 * 60; k++) {
          const n = front.tick(TICK, head, rounds, SPEC, sight);
          for (let s = rounds.count - n; s < rounds.count; s++) {
            // Where it crosses z = 30 in flight, the parapet's face: 0.3 m over the stop, within 1 cm.
            const [x, y] = crossing(rounds.position(s), rounds.velocity(s), 30);
            expect(Math.abs(y - 2.3), what).toBeLessThanOrEqual(0.01);
            expect(Math.abs(x - 10), what).toBeLessThanOrEqual(T.spreadM + 1e-6);
            across.push(x - 10);
          }
          rounds.step(TICK);
        }
        // Asked once a round, from its muzzle at the head; scattered sideways across the whole spread.
        expect(asked.length, what).toBe(across.length);
        expect(asked.every(([from, to]) => from.join() === origin.join() && to.join() === head.join()), what).toBe(true);
        expect(across.length, what).toBeGreaterThan(20);
        expect(Math.min(...across), what).toBeLessThan(-0.8);
        expect(Math.max(...across), what).toBeGreaterThan(0.8);
      }
    }
  });

  it('in a room light aims to hit, scattered as heavy is; solo it never passes nearer than light_miss_m', () => {
    const misses = (room: boolean) => {
      const front = new Front(T, lineSource(38, 0.4), Rng.root(7).derive('front'));
      front.room = room;
      front.intensity = 'light';
      const rounds = field();
      const out: number[] = [];
      while (out.length < 400) {
        const n = front.tick(TICK, TARGET, rounds, SPEC);
        for (let s = rounds.count - n; s < rounds.count; s++) {
          const o = rounds.position(s);
          const v = rounds.velocity(s);
          out.push(segmentDistance(o, [o[0] + v[0], o[1] + v[1], o[2] + v[2]], TARGET));
        }
        rounds.step(TICK);
      }
      return out;
    };
    const room = misses(true);
    expect(room.filter((m) => m < 0.3).length).toBeGreaterThan(0);
    // Within heavy's scatter of the head, as heavy's are.
    expect(Math.max(...room)).toBeLessThanOrEqual(Math.hypot(T.spreadM, T.spreadVertical * T.spreadM) + 0.01);
    expect(Math.min(...misses(false))).toBeGreaterThanOrEqual(T.lightMissM - 0.01);
  });

  it('is deterministic', () => {
    expect(run('heavy', 5, 7)).toEqual(run('heavy', 5, 7));
  });
});
