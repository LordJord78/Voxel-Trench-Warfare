import { describe, expect, it } from 'vitest';
import { ballisticsTunables, projectileSpec, Rounds, type ProjectileSpec } from '../../src/combat/ballistics';
import { loadTunables } from '../../src/core/tunables';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Ported from reference/python/tests/test_ballistics.py, at 10 cm: a world 12.8 × 6.4 × 256 m, floor
// at y < 0.4 m, ticks of 1/60 s.
const TICK = 1 / 60;
const VOXEL = 0.1;
const tun = loadTunables();
const T = ballisticsTunables(tun);
const RIFLE = projectileSpec(tun, 'assault_rifle');

function world(): BrickMap {
  const map = new BrickMap({ x: 128, y: 64, z: 2560 });
  map.fillBox(0, 0, 0, 128, 4, 2560, P.SUBSOIL);
  return map;
}

const speedOf = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

describe('rounds in flight', () => {
  it('the drag factor folds the constants', () => {
    expect(RIFLE.dragFactor).toBeCloseTo((0.5 * 0.295 * 0.0000238) / 0.00343, 12);
    expect(RIFLE.muzzleVelocity).toBe(880);
    expect(RIFLE.massKg).toBe(0.00343);
  });

  it('a heavier round of the same shape carries further', () => {
    const heavy: ProjectileSpec = { ...RIFLE, massKg: RIFLE.massKg * 3, dragFactor: RIFLE.dragFactor / 3 };
    const r = new Rounds(T, world(), VOXEL);
    const light = r.fire([6.4, 3, 0.5], [0, 0, 880], RIFLE, 0, false);
    const heavier = r.fire([3.2, 3, 0.5], [0, 0, 880], heavy, 0, false);
    expect([light, heavier]).toEqual([0, 1]);
    for (let k = 0; k < 12; k++) r.step(TICK);
    expect(speedOf(r.velocity(1))).toBeGreaterThan(speedOf(r.velocity(0)));
  });

  it('drag slows the round', () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([6.4, 3, 0.5], [0, 0, 880], RIFLE, 0, false);
    const speeds: number[] = [];
    for (let k = 0; k < 8; k++) {
      r.step(TICK);
      speeds.push(speedOf(r.velocity(0)));
    }
    expect(speeds[0]).toBeLessThan(880);
    for (let k = 1; k < speeds.length; k++) expect(speeds[k]).toBeLessThanOrEqual(speeds[k - 1]);
  });

  it('muzzle energy is in the right league', () => {
    const e = 0.5 * RIFLE.massKg * RIFLE.muzzleVelocity ** 2;
    expect(e).toBeGreaterThan(1000);
    expect(e).toBeLessThan(1700);
  });

  it('with no drag, the drop after 30 ticks is ½gt² within 2%', () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([6.4, 6, 0.5], [0, 0, 300], { ...RIFLE, dragFactor: 0 }, 0, false);
    for (let k = 0; k < 30; k++) r.step(TICK);
    const t = 30 * TICK;
    const drop = 6 - r.position(0)[1];
    expect(Math.abs(drop / (0.5 * 9.81 * t * t) - 1)).toBeLessThanOrEqual(0.02);
  });

  it('a slower round drops more over the same distance', () => {
    const dropAt60 = (v: number) => {
      const r = new Rounds(T, world(), VOXEL);
      r.fire([6.4, 5, 0.5], [0, 0, v], RIFLE, 0, false);
      while (r.position(0)[2] < 60.5) r.step(TICK);
      return 5 - r.position(0)[1];
    };
    const slow = dropAt60(300);
    const fast = dropAt60(900);
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThan(0);
  });

  it("the flight table: the reference's at 0.125 s (103 m, 773 m/s, 7.6 cm), and the flat-fire closed form at 100 m, each within 2%", () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([6.4, 3, 0.5], [0, 0, 880], RIFLE, 0, false);
    const samples: { t: number; z: number; drop: number; speed: number }[] = [{ t: 0, z: 0, drop: 0, speed: 880 }];
    for (let k = 1; k <= 10; k++) {
      r.step(TICK);
      const p = r.position(0);
      samples.push({ t: k * TICK, z: p[2] - 0.5, drop: 3 - p[1], speed: speedOf(r.velocity(0)) });
    }
    // Linear between the samples either side of `x` on `key`.
    const at = (key: 't' | 'z', x: number) => {
      const i = samples.findIndex((q) => q[key] >= x);
      const [a, b] = [samples[i - 1], samples[i]];
      const f = (x - a[key]) / (b[key] - a[key]);
      return { t: a.t + (b.t - a.t) * f, z: a.z + (b.z - a.z) * f, drop: a.drop + (b.drop - a.drop) * f, speed: a.speed + (b.speed - a.speed) * f };
    };
    const within = (got: number, want: number) => expect(Math.abs(got / want - 1)).toBeLessThanOrEqual(0.02);
    // The reference's table (its row "100 m" was sampled at the first substep past it, 0.125 s).
    const table = at('t', 0.125);
    within(table.z, 103);
    within(table.speed, 773);
    within(table.drop, 0.076);
    // At 100 m exactly: v = v0·e^(−kx), t = (e^(kx) − 1) / (k·v0), k = dragFactor·ρ.
    const k = RIFLE.dragFactor * T.airDensity;
    const hundred = at('z', 100);
    within(hundred.speed, 880 * Math.exp(-k * 100));
    within(hundred.t, (Math.exp(k * 100) - 1) / (k * 880));
  });

  it('a round stops at the first solid voxel', () => {
    const map = world();
    map.fillBox(0, 0, 600, 128, 64, 610, P.CONCRETE);
    const r = new Rounds(T, map, VOXEL);
    r.fire([6.4, 0.6, 0.5], [0, 0, 880], RIFLE, 0, false);
    const impacts = [];
    for (let k = 0; k < 10 && r.count > 0; k++) {
      r.step(TICK);
      impacts.push(...r.impacts);
    }
    expect(impacts).toHaveLength(1);
    expect(impacts[0].material).toBe(P.CONCRETE);
    expect(impacts[0].cell[2]).toBe(600);
    expect(impacts[0].normal).toEqual([0, 0, -1]);
    expect(impacts[0].energyJ).toBeGreaterThan(0);
    expect(impacts[0].distance).toBeCloseTo(59.5, 2);
    expect(r.count).toBe(0);
  });

  it('air and water do not stop a round', () => {
    const map = world();
    map.fillBox(0, 0, 300, 128, 64, 400, P.WATER);
    map.fillBox(0, 0, 500, 128, 64, 510, P.BRICK);
    const r = new Rounds(T, map, VOXEL);
    r.fire([6.4, 0.6, 0.5], [0, 0, 880], RIFLE, 0, false);
    const impacts = [];
    for (let k = 0; k < 10 && r.count > 0; k++) {
      r.step(TICK);
      impacts.push(...r.impacts);
    }
    expect(impacts.map((i) => i.material)).toEqual([P.BRICK]);
  });

  it('a round that hits nothing is retired, not leaked', () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([6.4, 3, 128], [0, 880, 0], RIFLE, 0, false);
    for (let k = 0; k < 600 && r.count > 0; k++) r.step(TICK);
    expect(r.count).toBe(0);
  });

  it("a round leaving over the map's edge is retired", () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([12.7, 3, 128], [880, 0, 0], RIFLE, 0, false);
    const impacts = [];
    for (let k = 0; k < 10; k++) {
      r.step(TICK);
      impacts.push(...r.impacts);
    }
    expect(r.count).toBe(0);
    expect(impacts).toEqual([]);
  });

  it('a round fired from inside a solid voxel hits it at once', () => {
    const map = world();
    map.fillBox(0, 0, 600, 128, 64, 610, P.CONCRETE);
    const r = new Rounds(T, map, VOXEL);
    r.fire([6.45, 0.65, 60.05], [0, 0, 880], RIFLE, 0, false);
    r.step(TICK);
    expect(r.impacts).toHaveLength(1);
    expect(r.impacts[0].cell).toEqual([64, 6, 600]);
    expect(r.impacts[0].normal).toEqual([0, 0, 0]);
    expect(r.impacts[0].distance).toBe(0);
    expect(r.count).toBe(0);
  });

  it('the pool is a ceiling and says so', () => {
    const r = new Rounds({ ...T, capacity: 4 }, world(), VOXEL);
    const slots = Array.from({ length: 7 }, () => r.fire([6.4, 3, 0.5], [0, 0, 880], RIFLE, 0, false));
    expect(slots).toEqual([0, 1, 2, 3, -1, -1, -1]);
    expect(r.dropped).toBe(3);
    expect(r.count).toBe(4);
    expect(r.fire([6.4, 3, 0.5], [0, 0, 0], RIFLE, 0, false)).toBe(-1);
  });

  it('retiring a round does not disturb the others', () => {
    const r = new Rounds(T, world(), VOXEL);
    r.fire([6.4, 0.6, 1], [0, -880, 0], RIFLE, 0, false);
    r.fire([9.0, 3, 1], [0, 0, 10], RIFLE, 0, false);
    r.step(TICK);
    expect(r.count).toBe(1);
    expect(r.position(0)[0]).toBe(9.0);
  });

  it('tracer segments trail behind the head, for tracer rounds only', () => {
    const r = new Rounds(T, world(), VOXEL);
    const empty = r.tracerSegments(7);
    expect([empty.head.length, empty.tail.length]).toEqual([0, 0]);
    r.fire([6.4, 3, 0.5], [0, 0, 880], RIFLE, 0, true);
    r.fire([3.2, 3, 0.5], [0, 0, 880], RIFLE, 0, false);
    for (let k = 0; k < 3; k++) r.step(TICK);
    const { head, tail } = r.tracerSegments(7);
    expect(head).toBeInstanceOf(Float32Array);
    expect([head.length, tail.length]).toEqual([3, 3]);
    expect(head[0]).toBeCloseTo(6.4, 5);
    expect(tail[2]).toBeLessThan(head[2]);
    expect(Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2])).toBeLessThanOrEqual(7 + 1e-5);
  });
});
